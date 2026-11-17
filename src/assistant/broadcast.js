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

const BROADCAST_VERSION = 'assistant-broadcast.v1';
const BRIEF_PREFIX = '【小智简报】';
const MAX_ITEMS = 8;
const RING_CAP = 200;
const BUFFER_CAP = 50;
const SEEN_CAP = 2000;

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

function nodeLabel(node) {
  return ({
    task_created: '新建',
    task_started: '开始',
    task_failed: '失败',
    task_completed: '完成'
  })[node] || node;
}

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

function buildPayload(events) {
  // events 顺序 = taskManager.getAllTasks() 顺序（新的在前）；简报先列最新节点。
  const items = events.slice(0, MAX_ITEMS).map((e) => ({
    eventId: e.eventId,
    node: e.node,
    taskId: e.taskId,
    status: e.status,
    at: e.at,
    text: itemLine(e)
  }));
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
    text: [head, ...items.map((i) => i.text), note].join('\n')
  };
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
  reset,
  status,
  ring,
  isEnabled,
  _state: state
};
