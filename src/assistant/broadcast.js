// ==========================================
// 小智 V2 · 任务播报（Q23=B：全局可见 + 合并节流 + 设置可关 + 关键节点只播一次）
// ------------------------------------------------------------
// 设计（设计文档 §2 V2 / §8.3 B3、B8）：
//   · 全局可见：扫描 taskManager 的全部任务（不只小智自己建的），另一个窗口新建/完成/失败都能看到；
//   · 关键节点：新建 / 开始 / 失败（含 partial）/ 完成；
//   · 去重：每个 `taskId:节点` 只播一次（announced 映射，含 eventId；上限 SEEN_CAP，超出淘汰最旧）；
//   · 合并节流：同一窗口内的多个节点合并成 1 条简报；两次真正推送之间至少隔 throttleSec 秒；
//   · 开关：preferences.globalSettings().broadcastEnabled（默认 true；关掉后只记状态不推送，不补播历史）；
//   · **只读**：不建任务、不改任务、不调模型；诊断/建议只读 diagnose()，执行必须用户点确认（L3）。
//
// 默认策略（交付文档同步写）：
//   - 播报开启；节流 30 秒；同一节点只播一次；
//   - 服务启动时 `reset({ primeExisting: true })`：历史任务只登记不补播（避免重启刷屏）；
//   - 关闭播报期间的新事件会被登记但不补播（重新打开后不会一次性回放旧事件）。
//
// 有界缓冲：
//   - ring 保留最近 200 条已推送简报（只读查询/验收用）；
//   - buffer（等待节流的未推送事件）最多 50 条，超出丢最旧并记 dropped；
//   - seen（taskId → 状态签名）最多 2000 条。
// ==========================================

'use strict';

const taskManager = require('../taskManager');
const preferences = require('./preferences');
const diagnose = require('./diagnose');
const { redactText } = require('./redact');
const i18n = require('../i18n');

const BROADCAST_VERSION = 'assistant-broadcast.v1';
const BRIEF_PREFIX = '【小智简报】';
// 2026-11-21 用户反馈：英文界面下简报仍是中文（「【小智简报】新建：task_…」）。
// 根因：简报以前在**服务端生成一份中文 text**再广播给所有人，只有一个版本。
// 修法：事件照旧只收集一次（去重/节流不变），**按连接语言渲染**（render(payload, lang)），
// 英文连接拿英文 textEn，中文连接拿原中文 text（中文逐字不变）。
const BRIEF_PREFIX_EN = '[Briefing]';
const MAX_ITEMS = 8;
const RING_CAP = 200;
const BUFFER_CAP = 50;
const SEEN_CAP = 2000;

// 下一步（失败简报的「建议」）英文：只翻译系统建议，不翻用户内容与错误原文。
const ADVICE_EN = Object.freeze({
  continue: 'Continue from the failed clips (done clips are reused, not regenerated)',
  switch_model: 'Switch to a channel that supports image-to-video',
  fix_key: 'Fill in the API key under Settings -> Video generation',
  wait: 'Retry in a few minutes (the rate limit is not bad data)',
  topup: 'Top up / reconcile the budget first',
  lower_resolution: 'Lower the resolution (1080p -> 720p)',
  review_photos: 'Review the photos in Library -> Photos, then press "Continue"',
  inspect: 'Open the task details and check the last failed step'
});

const ACTIVE_STATUS = new Set([
  'pending', 'generating', 'concatenating', 'looping', 'transcoding',
  'mixing', 'processing', 'regenerating', 'paused'
]);
const TERMINAL_NODE = { completed: 'task_completed', partial: 'task_failed', failed: 'task_failed' };

const state = {
  seen: new Map(),        // taskId -> { sig, status }
  announced: new Map(),   // `${taskId}:${node}` -> eventId（只播一次）
  ring: [],               // 已推送简报（有界）
  subscribers: new Set(),
  buffer: [],             // 等待节流的事件
  dropped: 0,
  lastDeliverAt: 0,
  seq: 0
};

function signature(task) {
  const clips = Array.isArray(task.clips) ? task.clips : [];
  const success = clips.filter((c) => c && c.status === 'success').length;
  const failed = clips.filter((c) => c && c.status !== 'success').length;
  return [task.status || '', task.currentStep || '', success, failed, task.outputPath ? 1 : 0].join('|');
}

function isEnabled() {
  try { return preferences.globalSettings().broadcastEnabled !== false; } catch (e) { return true; }
}

function throttleMs() {
  try { return Math.max(0, Number(preferences.globalSettings().throttleSec) || 0) * 1000; } catch (e) { return 30000; }
}

function trimMap(map, cap) {
  while (map.size > cap) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function nodeOfNewTask(task) {
  if (task.status === 'completed') return 'task_completed';
  if (TERMINAL_NODE[task.status]) return TERMINAL_NODE[task.status];
  if (ACTIVE_STATUS.has(task.status)) return 'task_created';
  return null;
}

function collect() {
  const tasks = taskManager.getAllTasks();
  const events = [];
  for (const t of tasks) {
    if (!t || !t.taskId) continue;
    const prev = state.seen.get(t.taskId);
    const sig = signature(t);
    if (!prev) {
      state.seen.set(t.taskId, { sig, status: t.status || null });
      const node = nodeOfNewTask(t);
      if (node) pushEvent(events, node, t);
      continue;
    }
    if (prev.sig === sig) continue;
    state.seen.set(t.taskId, { sig, status: t.status || null });
    if (t.status === 'completed') pushEvent(events, 'task_completed', t);
    else if (TERMINAL_NODE[t.status]) pushEvent(events, 'task_failed', t);
    else if (prev.status === 'pending' && ACTIVE_STATUS.has(t.status)) pushEvent(events, 'task_started', t);
  }
  trimMap(state.seen, SEEN_CAP);
  return events;
}

function pushEvent(events, node, task) {
  const key = `${task.taskId}:${node}`;
  if (state.announced.has(key)) return;
  const eventId = 'evt_' + (++state.seq).toString(36).padStart(6, '0');
  state.announced.set(key, eventId);
  trimMap(state.announced, SEEN_CAP * 4);
  events.push({ eventId, node, taskId: task.taskId, status: task.status || null, task, at: new Date().toISOString() });
}

// 节点 → 中文标签 / 英文标签（中文词表逐字不变）。
const NODE_LABELS = Object.freeze({
  task_created: '新建',
  task_started: '开始',
  task_failed: '失败',
  task_completed: '完成'
});
const NODE_LABELS_EN = Object.freeze({
  task_created: 'created',
  task_started: 'started',
  task_failed: 'failed',
  task_completed: 'completed'
});

function nodeLabel(node) {
  return NODE_LABELS[node] || node;
}

// 中文条目（逐字保持 2026-11-17 起的原样）。
function itemLine(evt) {
  const t = evt.task || {};
  if (evt.node === 'task_failed') {
    let d = null;
    try { d = diagnose.diagnose(t); } catch (e) { d = null; }
    const reason = d && d.reasons && d.reasons.length ? d.reasons[0] : (t.error || '原因未记录');
    const advice = d && d.suggestions && d.suggestions.length ? d.suggestions[0].label : '到任务详情看失败步骤';
    return `· 失败：${t.taskId} — ${redactText(String(reason))}。建议：${advice}（未点「修复」不会执行）`;
  }
  if (evt.node === 'task_completed') {
    const file = t.outputPath ? String(t.outputPath).split(/[\\/]/).pop() : '';
    return `· 完成：${t.taskId}${file ? `（成片 ${redactText(file)}）` : ''}`;
  }
  if (evt.node === 'task_started') {
    return `· 开始：${t.taskId}（${t.currentStep || t.status || '运行中'}）`;
  }
  return `· 新建：${t.taskId}（${t.model || '未知模型'} · ${t.totalClips || 0} 段）`;
}

// 英文条目：taskId / 模型 id / 文件名 / 错误原文属「内容」，原样保留；
// 只翻译包裹文字、状态步骤名（有 i18n key 时）与系统建议。
function itemLineEn(evt, seen) {
  const t = evt.task || {};
  const step = (s) => {
    const key = s ? i18n.keyForText(String(s)) : null;
    return key ? i18n.t('en', key) : (s || 'running');
  };
  if (evt.node === 'task_failed') {
    let d = null;
    try { d = diagnose.diagnose(t); } catch (e) { d = null; }
    const reason = d && d.reasons && d.reasons.length ? d.reasons[0] : (t.error || 'reason not recorded');
    const sug = d && d.suggestions && d.suggestions.length ? d.suggestions[0] : null;
    // 用 diagnoses 的类别（同一条消息里第二次出现就省略，避免重复贴整段分类）
    const catEn = d && d.category && !seen.cat.has(d.category) ? ` [${categoryLabelEn(d.category)}]` : '';
    if (d && d.category) seen.cat.add(d.category);
    const advice = sug ? (ADVICE_EN[sug.id] || 'Open the task details for the failed step') : 'Open the task details for the failed step';
    return `· Failed: ${t.taskId}${catEn} — ${redactText(String(reason))}. Suggested: ${advice}. `
      + '(Nothing is executed until you say yes.)';
  }
  if (evt.node === 'task_completed') {
    const file = t.outputPath ? String(t.outputPath).split(/[\\/]/).pop() : '';
    return `· Completed: ${t.taskId}${file ? ` (final ${redactText(file)})` : ''}`;
  }
  if (evt.node === 'task_started') {
    return `· Started: ${t.taskId} (${step(t.currentStep || t.status)})`;
  }
  return `· Created: ${t.taskId} (${t.model || 'unknown model'} · ${t.totalClips || 0} clips)`;
}

function fallbackLineEn(it) {
  const node = it && it.node;
  const taskId = (it && it.taskId) || '…';
  const label = NODE_LABELS_EN[node] || (node ? String(node) : 'update');
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  return `· ${cap}: ${taskId}`;
}

function categoryLabelEn(category) {  return ({
    budget: 'budget',
    key: 'API key / auth',
    model: 'model capability',
    rate: 'rate limit',
    timeout: 'network / timeout',
    qc: 'QC not passed',
    media: 'media processing',
    unknown: 'unclassified failure'
  })[category] || String(category || 'failure');
}

function isEnLang(lang) {
  return i18n.normalizeLang(lang) === 'en';
}

// items 只存结构化数据 + 中文文案；英文文案在 render 时按 lang 生成。
function buildItems(events) {
  return events.slice(0, MAX_ITEMS).map((e) => ({
    eventId: e.eventId,
    node: e.node,
    taskId: e.taskId,
    status: e.status,
    at: e.at,
    text: itemLine(e),
    // 2026-11-21：供英文渲染用（英文失败原因走 diagnose 的类别 + 英文建议）；
    // 与事件里的同一份内存对象，不额外序列化、不写入任何持久层。
    task: e.task || null
  }));
}

function buildPayload(events) {
  // events 顺序 = taskManager.getAllTasks() 顺序（新的在前）；简报先列最新节点。
  const items = buildItems(events);
  const omitted = Math.max(0, events.length - items.length);
  const head = `${BRIEF_PREFIX}${events.length > 1 ? ` ${events.length} 个任务节点（合并播报）` : ' 任务更新'}：`;
  const note = `（任务播报可在设置里关闭；同一节点只播一次${omitted ? `；本次另有 ${omitted} 条未列出` : ''}。）`;
  return {
    type: 'assistantBroadcast',
    version: BROADCAST_VERSION,
    seq: state.seq,
    at: new Date().toISOString(),
    kind: 'task_brief',
    merged: events.length > 1,
    count: events.length,
    items,
    omitted,
    text: [head, ...items.map((i) => i.text), note].join('\n')
  };
}

/**
 * 按语言渲染一份简报（纯函数，不改状态）。
 * zh：返回原中文 text（逐字不变）；en：textEn / items[].textEn。
 * 任何缺字段都回退中文原文，绝不返回空串。
 */
function render(payload, lang) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!isEnLang(lang)) return payload;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const seen = { cat: new Set() };
  const itemsEn = items.map((it) => {
    if (it && typeof it.textEn === 'string' && it.textEn) return it;
    const evt = { node: it && it.node, task: it && it.task };
    let text = String((it && it.text) || '');
    if (it && it.task) {
      try { text = itemLineEn(evt, seen); } catch (e) { text = String(it.text || ''); }
    } else {
      // 无 task 对象（例如 ring 里已保存的条目）：用条目自带的 node/taskId 拼英文，
      // 不用中文 text 兜底，避免英文界面漏中文。
      text = fallbackLineEn(it);
    }
    return { ...it, textEn: text };
  });
  const count = Number(payload.count) || items.length;
  const head = count > 1
    ? `${BRIEF_PREFIX_EN} ${count} task updates (merged):`
    : `${BRIEF_PREFIX_EN} Task update:`;
  const omitted = Number(payload.omitted) || 0;
  const note = `(Task briefs can be turned off in Settings; each event is announced only once`
    + `${omitted ? `; ${omitted} more were not listed here` : ''}.)`;
  const text = [head, ...itemsEn.map((i) => i.textEn || i.text), note].join('\n');
  return { ...payload, lang: 'en', items: itemsEn, textEn: text, text };
}

function notify(payload) {
  for (const fn of state.subscribers) {
    try { fn(payload); } catch (e) { try { console.warn('[assistant] 播报订阅者异常:', e && e.message); } catch (e2) { /* ignore */ } }
  }
}

function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  state.subscribers.add(fn);
  return () => state.subscribers.delete(fn);
}

/**
 * 扫描一次任务状态并（在节流允许时）推送合并简报。
 * @param {number} [nowMs] 测试可注入的时钟（确定性验证节流）
 */
function scan(nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const events = collect();
  if (events.length) {
    state.buffer.push(...events);
    if (state.buffer.length > BUFFER_CAP) {
      const over = state.buffer.length - BUFFER_CAP;
      state.buffer.splice(0, over);
      state.dropped += over;
    }
  }
  const enabled = isEnabled();
  if (!events.length && !state.buffer.length) {
    return { ok: true, delivered: 0, disabled: !enabled, collected: 0, buffered: 0, throttleSec: throttleMs() / 1000 };
  }
  if (!enabled) {
    // 关闭期间：事件只登记（collect 已写 seen/announced），不推送、不积压 —— 打开后不补播历史。
    state.buffer = [];
    return { ok: true, delivered: 0, disabled: true, collected: events.length, buffered: 0, throttleSec: throttleMs() / 1000 };
  }
  const throttle = throttleMs();
  if (throttle > 0 && state.lastDeliverAt && (now - state.lastDeliverAt) < throttle) {
    return {
      ok: true, delivered: 0, disabled: false, collected: events.length,
      buffered: state.buffer.length, throttleSec: throttle / 1000,
      nextAllowedInMs: throttle - (now - state.lastDeliverAt)
    };
  }
  const payload = buildPayload(state.buffer);
  state.buffer = [];
  state.lastDeliverAt = now;
  state.ring.push(payload);
  if (state.ring.length > RING_CAP) state.ring.splice(0, state.ring.length - RING_CAP);
  notify(payload);
  return { ok: true, delivered: 1, disabled: false, collected: events.length, buffered: 0, payload };
}

// 清空状态。primeExisting=true 时把当前任务只登记、不播报（服务启动用，避免补播历史）。
function reset(opts = {}) {
  state.seen.clear();
  state.announced.clear();
  state.ring = [];
  state.buffer = [];
  state.dropped = 0;
  state.lastDeliverAt = 0;
  state.seq = 0;
  if (opts.primeExisting === true) {
    let tasks = [];
    try { tasks = taskManager.getAllTasks(); } catch (e) { tasks = []; }
    for (const t of tasks) {
      if (!t || !t.taskId) continue;
      state.seen.set(t.taskId, { sig: signature(t), status: t.status || null });
      const node = nodeOfNewTask(t);
      if (node) state.announced.set(`${t.taskId}:${node}`, 'primed');
    }
  }
  return status();
}

function status() {
  return {
    version: BROADCAST_VERSION,
    enabled: isEnabled(),
    throttleSec: throttleMs() / 1000,
    seen: state.seen.size,
    announced: state.announced.size,
    ring: state.ring.length,
    buffered: state.buffer.length,
    dropped: state.dropped,
    seq: state.seq,
    subscriberCount: state.subscribers.size,
    lastDeliverAt: state.lastDeliverAt ? new Date(state.lastDeliverAt).toISOString() : null
  };
}

function ring() {
  return state.ring.slice();
}

module.exports = {
  BROADCAST_VERSION,
  BRIEF_PREFIX,
  RING_CAP,
  BUFFER_CAP,
  subscribe,
  scan,
  render,
  reset,
  status,
  ring,
  isEnabled,
  _state: state
};
