// ==========================================
// 小智 · 调度器（P5）
// ------------------------------------------------------------
// 已定产品决策（handoff §7）：
//   · 方案 C：模型只负责「听懂 + 填计划卡」；执行/失败处理由确定性状态机做，不问模型；
//   · 记忆：会话内 + 任务检索（「上一次视频」用检索，不靠模型回忆）；
//   · 失败处理：质检最多自动重试 2 次 → 从片段库补位（≤5% 且 ≤10 段）→ 仍不行才问用户；
//     不换备用模型；单任务重试费用 ≤ 总预算 10%；
//   · 付费任务必须用户明确同意；未同意绝不发起。
//
// 本模块把「对话 → 计划卡 → 确认 → 创建任务 → 监控 → 重试 → 补位 → 终态」
// 串成一条确定性链路：
//   · 计划卡解析：planCard（纯函数）；
//   · 状态机：stateMachine（纯函数，闸门在 transition 内）；
//   · 记忆：memory（会话落盘 + 任务检索）；
//   · 补位：fillFromLibrary（ΔE76+SSIM）；
//   · 任务执行：直接调 taskManager + pipeline（不经过 HTTP，也不另起实例）。
//
// 关键实现选择（写清楚，避免下一个人以为漏了）：
//   · 小智任务用 autoRetry:false 创建：流水线「一次只试一次、有失败就停在拼接前」，
//     不会先产出一条缺段的「成片」。自动重试由本调度器按 plan 的预算闸门逐次触发
//     （再跑 startTask；流水线会复用已成功片段，只重新生成失败片段）。
//   · 真实模型必须 approved（付费同意）+ budget 余额够 + 5 分钟去重；mock 全部跳过。
//   · 补位成片是新的 library 任务（source=library），原任务保留失败记录，不覆盖任何产物。
// ==========================================

'use strict';

const taskManager = require('../taskManager');
const pipeline = require('../pipeline');
const library = require('../library');
const photoLibrary = require('../photoLibrary');
const budget = require('../budget');
const submitGuard = require('../submitGuard');
// 出图自动调色（2026-11-23 A 方案）：只在创建任务时透传一次，之后沿用 task.imageGrade。
const imageGrade = require('../imageGrade');
const memory = require('./memory');
const planCard = require('./planCard');
const stateMachine = require('./stateMachine');
const fillLib = require('./fillFromLibrary');
const sceneCardLibrary = require('../sceneCards');
const promptComposer = require('../promptComposer');
const audioMixer = require('../processors/audioMixer');
// 2026-11-17 V2（半自主任务管家）：
//   · context：只读环境 A–E（任务/预算/素材/设置/错误摘要；Key 只报有/无）；
//   · diagnose：失败诊断 + 修复建议（只读；执行必须用户确认）；
//   · preferences / audit：服务端用户级偏好 + 审计（L3 确认后才写）；
//   · broadcast：全局任务播报（由 server.js 定时 scan 并推 WS；本模块只导出/转接）。
const assistantContext = require('./context');
const diagnose = require('./diagnose');
const preferences = require('./preferences');
const audit = require('./audit');
const assistantBroadcast = require('./broadcast');
// P3：AI 输出语言 = aiLang/界面语言；英文话术与模板独立撰写（中文默认逐字不变）。
const i18n = require('../i18n');
const assistantTemplates = require('../i18n/templates/assistant');

const SUPERVISOR_VERSION = 'assistant-supervisor.v1';
const ACTIVE_STATUS = new Set([
  'pending', 'generating', 'concatenating', 'looping', 'transcoding',
  'mixing', 'processing', 'regenerating', 'paused'
]);

// planId → 计划卡（内存缓存；会话文件里也有）
const planCache = new Map();
// `${sessionId}:${planId}` → { timer, phase, taskId, finalTaskId, busy, stopped }
const monitors = new Map();

function keyOf(sessionId, planId) {
  return `${sessionId || ''}:${planId || ''}`;
}

function briefPlan(plan) {
  if (!plan) return null;
  return {
    planId: plan.planId,
    version: plan.version,
    theme: plan.theme,
    themeLabel: plan.themeLabel,
    totalMinutes: plan.totalMinutes,
    requestedTotalMinutes: plan.requestedTotalMinutes,
    clipDurationSec: plan.clipDurationSec,
    clipCount: plan.clipCount,
    totalSec: plan.totalSec,
    resolution: plan.resolution,
    model: plan.model,
    modelLabel: plan.modelLabel,
    sceneCards: plan.sceneCards,
    // P7-A：计划阶段固定的 N 张卡 / 逐段提示词覆盖 / 配乐选择（UI 只读，不影响渲染）
    sceneCardIds: Array.isArray(plan.sceneCardIds) ? plan.sceneCardIds : null,
    promptOverrides: plan.promptOverrides || null,
    bgm: plan.bgm || null,
    bgmChoices: Array.isArray(plan.bgmChoices) ? plan.bgmChoices : null,
    fillMaxClips: plan.fillMaxClips,
    estimate: plan.estimate,
    requiresPaymentApproval: plan.requiresPaymentApproval,
    warnings: plan.warnings || [],
    userPrompt: plan.userPrompt
  };
}

// 出图审图摘要（契约 2026-11-16 §2.7）：三个计数按图片库当前状态**现算**。
// 取不到条目算 pending（图可能已被删除/回收，不能当成已通过）。
function imageReviewView(task) {
  const r = task && task.imageReview;
  if (!r) return null;
  let pendingPhotos = 0;
  let approvedPhotos = 0;
  let rejectedPhotos = 0;
  for (const id of (Array.isArray(r.photoIds) ? r.photoIds : [])) {
    const photo = photoLibrary.get(id);
    const status = photo ? photo.status : 'pending';
    if (status === 'approved') approvedPhotos += 1;
    else if (status === 'rejected') rejectedPhotos += 1;
    else pendingPhotos += 1;
  }
  return {
    total: r.total,
    generated: r.generated,
    failed: r.failed,
    reviewedAt: r.reviewedAt || null,
    pendingPhotos,
    approvedPhotos,
    rejectedPhotos
  };
}

function taskView(task) {
  if (!task) return null;
  return {
    taskId: task.taskId,
    status: task.status,
    currentStep: task.currentStep || null,
    totalClips: task.totalClips,
    successClips: (task.clips || []).filter((c) => c.status === 'success').length,
    failedClips: (task.clips || []).filter((c) => c.status !== 'success').length,
    outputPath: task.outputPath || null,
    error: task.error || null,
    fragmentOnly: !!task.fragmentOnly,
    // 出图审图（契约 2026-11-16 §2.7）：暂停等审图时为 true；imageReview 为摘要
    awaitingImageReview: !!task.awaitingImageReview,
    imageReview: imageReviewView(task),
    sceneCards: task.sceneCards ? { roundId: task.sceneCards.roundId, used: task.sceneCards.used.length, bufferUsed: task.sceneCards.status ? task.sceneCards.status.bufferUsed : 0 } : null
  };
}

function failedIndices(task) {
  return (task && Array.isArray(task.clips) ? task.clips : [])
    .filter((c) => c && c.status !== 'success')
    .map((c) => c.index)
    .sort((a, b) => a - b);
}

function observedRetries(task) {
  let n = 0;
  for (const c of (task && task.clips) || []) {
    const a = Number(c && c.attempts) || 0;
    if (a > 1) n += a - 1;
  }
  return n;
}

function finalsList() {
  try {
    return library.listAll().filter((e) => e && e.kind === 'final'
      && e.filePath && require('fs').existsSync(e.filePath));
  } catch (e) {
    return [];
  }
}

function isFollowUp(text) {
  return /改|换|调整|修改|加上|去掉|变成|换成/.test(String(text || ''));
}

function isRepeat(text) {
  return /再来|再做|重来|重做|再一次|又一条/.test(String(text || ''));
}

// 续问（「改成 1080p」/「再来一条」）→ 在上次计划上改；只覆盖用户刚说的槽位。
function inputFromLast(last, parsed, text) {
  if (!last) return { text };
  const input = {
    text,
    model: parsed.model || last.model,
    resolution: parsed.resolution || last.resolution,
    theme: parsed.theme || last.theme,
    themeLabel: parsed.themeLabel || last.themeLabel,
    sceneCards: parsed.sceneCards !== null ? parsed.sceneCards : last.sceneCards,
    clipDurationSec: parsed.clipDurationSec || last.clipDurationSec
  };
  if (parsed.totalMinutes !== null && parsed.totalMinutes !== undefined) {
    input.totalMinutes = parsed.totalMinutes;
  } else if (last.requestedTotalMinutes !== null && last.requestedTotalMinutes !== undefined) {
    input.totalMinutes = last.requestedTotalMinutes;
  } else {
    input.totalMinutes = last.totalSec / 60;
  }
  // 用户没说时长、也没说段数（例如「再来一条」）→ 沿用上次段数，避免重新算错
  if ((parsed.totalMinutes === null || parsed.totalMinutes === undefined) && !parsed.clipCount) {
    input.clipCount = last.clipCount;
  }
  if (parsed.model) input.model = parsed.model;
  return input;
}

// ==========================================
// P7-A：计划摘要里的「配乐」行（选中曲名 / 自动 / 关闭）
// ------------------------------------------------------------
// 只读 audioMixer 的素材清单（进程内 require，不走 HTTP）；不混音、不产生费用。
// ==========================================
function bgmFindTrack(trackId) {
  if (!trackId) return null;
  try {
    return audioMixer.findTrack(String(trackId));
  } catch (e) {
    return null;
  }
}

// 素材库：返回 { tracks, byId }。tracks 按用户自定义顺序（listTracksInOrder），
// 并补上 category（music/ambient）与时长，供「配乐有哪些」逐条列出。
function bgmLibrary() {
  let publicTracks = [];
  try {
    publicTracks = audioMixer.toPublicTracks();
  } catch (e) {
    publicTracks = [];
  }
  const byId = new Map(publicTracks.map((t) => [t.id, t]));
  let orderIds = [];
  try {
    orderIds = audioMixer.listTracksInOrder().map((t) => t.id);
  } catch (e) {
    orderIds = [];
  }
  const ordered = orderIds.filter((id) => byId.has(id)).map((id) => byId.get(id));
  // 防御：顺序表缺项时不丢曲目（补在末尾）
  for (const t of publicTracks) {
    if (!ordered.includes(t)) ordered.push(t);
  }
  return { tracks: ordered, byId };
}

function bgmLabel(plan) {
  const b = plan && plan.bgm;
  if (!b) return '自动（随机轻音乐）';
  if (b.enabled === false || b.mode === 'off') return '关闭（不要配乐）';
  if (b.trackId) {
    const hit = bgmFindTrack(b.trackId);
    return hit ? `手动：${hit.track.title || hit.track.id}` : `手动：${b.trackId}`;
  }
  return '自动（随机轻音乐）';
}

function describeReply(plan, lang) {
  const lines = planCard.describe(plan, lang);
  // P7-A：计划摘要必须显示当前配乐（§3.3.5）
  lines.push(i18n.normalizeLang(lang) === 'en'
    ? `BGM: ${bgmLabelEn(plan)}`
    : `配乐：${bgmLabel(plan)}`);
  return lines.join('\n');
}

// P3：配乐说明的英文版（选择来自计划对象；曲名/标题原样保留，属内容不翻译）
function bgmLabelEn(plan) {
  const b = plan && plan.bgm;
  if (!b || b.enabled === false || b.mode === 'off') return 'off';
  if (b.mode === 'auto') return 'auto (random light music)';
  const hit = bgmFindTrack(b.trackId);
  return hit ? `manual: ${hit.track.title || hit.track.id}` : `manual: ${b.trackId}`;
}

function replyForPlan(plan, lang) {
  if (i18n.normalizeLang(lang) === 'en') {
    return `I've laid out a ${assistantTemplates.durationLabelEn(plan.totalSec)} plan:\n`
      + `${describeReply(plan, 'en')}\n`
      + (plan.requiresPaymentApproval
        ? 'This is a paid task: I start only after you approve, and I never charge automatically. Tell me if anything should change.'
        : 'This is a zero-cost task (Mock): I start right after you approve. Tell me if anything should change.');
  }
  // 2026-11-16 用户口径：长片按「总时长」排，场景从场景卡库自动抽取，不再说「我按某个主题排好了」。
  const mins = Number(plan.totalSec || 0) / 60;
  // 不到 1 分钟按秒说（支持「30 秒」这类短视频/快速验证）。
  const durLabel = mins >= 10 ? `${mins.toFixed(1)} 分钟`
    : (mins >= 1 ? `${mins.toFixed(2)} 分钟` : `${Math.round(Number(plan.totalSec) || 0)} 秒`);
  return `我按 ${durLabel}排好了：\n${describeReply(plan, 'zh')}\n`
    + (plan.requiresPaymentApproval
      ? '这是付费任务：你确认后我才开始，不会自动扣费。要改哪里直接说。'
      : '这是零计费任务（Mock）：你确认后我就开始。要改哪里直接说。');
}

function replyForGreeting(lang) {
  if (i18n.normalizeLang(lang) === 'en') {
    return 'I am Xiaozhi. Tell me the total length and I will lay out a plan — for example "10 minutes" or "30 minutes". '
      + 'Scenes are drawn from the scene-card library and played in chapter order (10 seconds per clip by default; '
      + '10 minutes = 60 distinct scenes; you can also say "15 seconds per clip"), so no theme is needed. '
      + 'You can also ask "last video" or "what is the progress". The microphone button is on the left of the input box.';
  }
  return '我是小智。说个总时长就能排计划，例如「10 分钟」或「30 分钟」——'
    + '场景由场景卡库随机抽取后按章节顺序播映（默认 10 秒/段，10 分钟 = 60 个不同场景；也可以说「每段 15 秒」），不需要指定主题；'
    + '也可以问「上一次的视频」或「现在进度怎样」。语音按钮在输入框左侧。';
}

function replyUnknown(lang, hasPlan) {
  const en = i18n.normalizeLang(lang) === 'en';
  // 2026-11-18 S0：听不懂时**反问一句**，不再背"我可以做三件事"的能力菜单。
  // 菜单式回答会让用户以为小智只会这些；反问才能把含糊的一句话收敛回一个动作。
  if (hasPlan) {
    return en
      ? 'I did not catch that. Do you want to change the plan we already have (say which segment, or swap a scene card), or lay out a new one (for example "2 minutes")?'
      : '这句我没接住。你是想改当前这版计划（说第几段、或换哪张场景卡），还是重新排一条（比如「2 分钟」）？';
  }
  return en
    ? 'I did not catch that. To lay out a plan, tell me a total length (for example "2 minutes"). To look something up, try "progress" or "last video".'
    : '这句我没接住。要排计划就告诉我总时长（比如「2 分钟」）；要查东西可以说「进度」或「上一次的视频」。';
}

function retrieveRefs(query, limit = 5) {
  let tasks = [];
  try { tasks = taskManager.getAllTasks(); } catch (e) { tasks = []; }
  return memory.retrieveTasks({
    query,
    tasks,
    finals: finalsList(),
    limit
  });
}

function describeRefs(refs, lang) {
  if (!refs || refs.length === 0) return '';
  const isEn = i18n.normalizeLang(lang) === 'en';
  return refs.map((r, i) => {
    if (isEn) {
      // 2026-11-19 S3：英文下不贴中文提示词标题（属内容，E10 待用户定策略），只给任务 ID + 时间 + 文件。
      const when = memory.formatWhenEn(r.completedAt || r.createdAt);
      const kind = r.kind === 'final' ? 'final cut' : (r.status === 'completed' ? 'completed' : `task ${r.status || 'unknown'}`);
      const file = r.fileName ? `, file ${r.fileName}` : '';
      return `${i === 0 ? 'Latest' : `#${i + 1} latest`}: ${r.taskId || '(no id)'} (${kind}${when ? ` · ${when}` : ''}${file})`;
    }
    const when = memory.formatWhen(r.completedAt || r.createdAt);
    const kind = r.kind === 'final' ? '成片' : (r.status === 'completed' ? '任务完成' : `任务 ${r.status || ''}`);
    const file = r.fileName ? `，文件 ${r.fileName}` : '';
    return `${i === 0 ? '上一次' : `第 ${i + 1} 近`}：${(r.prompt || '（无提示词）').slice(0, 60)}（${when}，${kind}${file}）`;
  }).join('\n');
}

function replyForLast(query, lang) {
  const res = retrieveRefs(query, 3);
  const isEn = i18n.normalizeLang(lang) === 'en';
  if (!res.refs.length) {
    return isEn
      ? 'No final cuts yet. Tell me a total length (for example "10 minutes") and I will lay out the first one.'
      : '库里还没有成片记录。说个总时长（比如「10 分钟」），我来做第一条。';
  }
  return isEn
    ? `Here are the most recent records:\n${describeRefs(res.refs, 'en')}\n`
      + 'To make a similar one, say "one more like that" and tell me the length. To watch a final cut, open Library → Finals.'
    : `我查到这些相关记录：\n${describeRefs(res.refs)}\n`
      + '要再来一条类似的，直接说「再来一条」并告诉我时长；要看成片就去「库 · 成片」。';
}

// 英文状态标签（中文 stateMachine.LABELS 逐字不变）
const STATE_LABELS_EN = Object.freeze({
  planned: 'planned', confirmed: 'confirmed', submitted: 'submitted',
  running: 'running', done: 'done', failed: 'failed', needs_user: 'needs your input'
});

// ==========================================
// 2026-11-23 修（用户实测）：重启后「上一次的任务进行到哪一步了」被答成
// 「现在没有正在执行的任务。说个时长，我来排计划。」
// ------------------------------------------------------------
// 事故链路（三处叠加，缺一不可）：
//   ① 会话 id 存在 sessionStorage（web/src/components/assistant.js:172），换窗口/重启后
//      拿到新 id，会话记忆与计划全空；
//   ② 空会话分支只查「在跑任务」（tasks.active），被重启回收成 failed 的任务不算在跑 →
//      永远走到那句「没有正在执行的任务」；
//   ③ 会话里有状态时又直接信 state.state（重启前写的 running），不看任务真实状态 →
//      答「正在『生成中』」，而任务其实早已被回收成失败。
// 现口径（确定性，不猜）：一律以**任务记录**为准。
//   · 用户问「上一次 / 刚才」时，即使在跑清单非空，也先答那条任务；
//   · 中断/失败必须给出：已成功几段、还差几段、怎么补跑、计费与 Key 的约束。
// ==========================================
const STEP_LABELS = Object.freeze({
  pending: '排队', optimizing: '提示词优化', generating: '生成片段',
  concatenating: '拼接', looping: '循环处理', transcoding: '转码',
  mixing: '配乐混音', processing: '处理中', regenerating: '重新生成片段',
  paused: '暂停', completed: '完成', failed: '失败'
});
const STEP_LABELS_EN = Object.freeze({
  pending: 'queued', optimizing: 'prompt optimization', generating: 'clip generation',
  concatenating: 'concatenation', looping: 'loop processing', transcoding: 'transcoding',
  mixing: 'soundtrack mixing', processing: 'processing', regenerating: 'clip regeneration',
  paused: 'paused', completed: 'done', failed: 'failed'
});
// 「上一次的任务」指代：用户问的是那条任务，不是「现在有什么在跑」。
const RE_LAST_TASK_HINT = /上一次|上个|上一条|上条|刚才|上一个|前一条/;

// 任务「最近一次有动静」的时间：创建 / 完成 / 最后更新三者取最大。
// 不只看创建时间——补跑过的旧任务才是「刚做过的那条」。
function taskRecency(task) {
  const times = [task && task.completedAt, task && task.updatedAt, task && task.createdAt]
    .map((v) => new Date(v || 0).getTime())
    .filter((n) => Number.isFinite(n));
  return times.length ? Math.max(...times) : 0;
}

function latestTaskAny() {
  let tasks = [];
  try { tasks = taskManager.getAllTasks() || []; } catch (e) { return null; }
  return tasks
    .filter((t) => t && t.taskId)
    .sort((a, b) => taskRecency(b) - taskRecency(a))[0] || null;
}

function replyForStatus(sessionId, lang, text) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const state = memory.getState(sessionId);
  const stateTask = (() => {
    if (!state) return null;
    const id = state.finalTaskId || state.taskId;
    return id ? taskManager.getTask(id) : null;
  })();
  const stateActive = !!(stateTask && ACTIVE_STATUS.has(String(stateTask.status || '')));
  const wantsLast = RE_LAST_TASK_HINT.test(String(text || ''));
  // 2026-11-17 V2（B1）：「现在跑到哪了？」要能回答**全局**任务，而不只是本会话自己的。
  // 只读 taskManager 快照；不建任务、不改任何状态。
  let live = [];
  if (!wantsLast && !stateActive) {
    try { live = assistantContext.contextOf(sessionId).tasks.active; } catch (e) { live = []; }
  }
  if (live.length) {
    if (isEn) {
      return `[Briefing] ${live.length} task(s) running right now (global):\n`
        + live.map((t) => `· ${t.taskId}: ${t.successClips}/${t.totalClips} clips (${t.percent}%), status ${t.status || 'running'}`).join('\n')
        + '\n(Read-only: nothing was created or re-run.)';
    }
    return `【小智简报】现在有 ${live.length} 个任务在跑（全局）：\n`
      + live.map((t) => `· ${diagnose.taskLabel(t)}（ID ${t.taskId}）：成功 ${t.successClips}/${t.totalClips} 段（${t.percent}%），当前 ${t.currentStep || '…'}`).join('\n')
      + '\n（只读播报：不会新建任务、不会重跑。）';
  }

  const task = stateTask || latestTaskAny();
  if (!task) {
    if (state) {
      return isEn
        ? `Task state: ${STATE_LABELS_EN[state.state] || state.state}.`
        : `任务状态：${stateMachine.LABELS[state.state] || state.state}。`;
    }
    return isEn
      ? 'Nothing is running right now, and there is no task record yet. Tell me a length and I will lay out a plan.'
      : '现在没有正在执行的任务，任务库里也还没有记录。说个时长（比如「5 分钟」），我来排计划。';
  }

  const clips = Array.isArray(task.clips) ? task.clips : [];
  const total = Number(task.totalClips) || clips.length || 0;
  const okClips = clips.filter((c) => c && c.status === 'success');
  const failClips = clips.filter((c) => c && c.status === 'failed');
  const runClips = clips.filter((c) => c && (c.status === 'generating' || c.status === 'processing'));
  const pendingClips = clips.filter((c) => !c || !c.status || c.status === 'pending');
  const okSec = Math.round(okClips.reduce((s, c) => s + (Number(c.duration) || 0), 0));
  const pct = total ? Math.round((okClips.length / total) * 100) : 0;
  const clipDur = Number(task.clipDuration) || 0;
  const totalSec = clipDur && total ? clipDur * total : 0;
  const durLabel = totalSec >= 60 ? `${Number((totalSec / 60).toFixed(1))} 分钟` : (totalSec ? `${totalSec} 秒` : '');
  const when = memory.formatWhen(task.createdAt);
  const whenEn = memory.formatWhenEn(task.createdAt);
  const stepOf = (s) => (isEn ? (STEP_LABELS_EN[s] || s || '') : (STEP_LABELS[s] || s || ''));
  const tagsOf = (list, max = 4) => {
    const all = (Array.isArray(list) ? list : [])
      .map((c) => (c && Number.isInteger(c.index) ? '#' + (c.index + 1) : null))
      .filter(Boolean);
    return {
      count: all.length,
      text: all.length > max
        ? (isEn ? `${all.slice(0, max).join(', ')} … (${all.length} clips)` : `${all.slice(0, max).join('、')} 等 ${all.length} 段`)
        : (isEn ? all.join(', ') : all.join('、'))
    };
  };

  if (String(task.status || '') === 'paused') {
    if (isEn) {
      return `Task ${task.taskId} is paused (${okClips.length}/${total} clips done). Press "Resume" in the task details to continue from the checkpoint.`;
    }
    return `上一次任务 ${task.taskId} 处于暂停（已成功 ${okClips.length}/${total} 段）：点任务详情里的「继续」从断点接着跑。`;
  }
  if (ACTIVE_STATUS.has(String(task.status || ''))) {
    if (isEn) {
      return `Task ${task.taskId} is running: ${stepOf(task.status)}, ${okClips.length}/${total} clips done (${pct}%).`;
    }
    return `${diagnose.taskLabel(task)}（ID ${task.taskId}）正在「${stepOf(task.status)}」：`
      + `当前 ${task.currentStep || '…'}，成功片段 ${okClips.length}/${total} 段（${pct}%）。`;
  }
  if (String(task.status || '') === 'completed') {
    const file = task.outputPath ? require('path').basename(task.outputPath) : '';
    if (isEn) {
      return `Your last task ${task.taskId} is complete${file ? `, file ${file}` : ''}. Open Library → Finals to view it.`;
    }
    return `上一次任务 ${task.taskId} 已经完成${file ? `，成片 ${file}` : ''}。可以在「库 · 成片」里看到。`;
  }

  const interrupted = !!(task.interruptedFrom
    || /服务进程中断|暂停期间服务被重启/.test(String(task.error || '')));
  const timeoutCount = failClips.filter((c) => /等待超时/.test(String((c && c.error) || ''))).length;
  const need = Math.max(0, total - okClips.length);
  const why = String(task.error || '').replace(/\s+/g, ' ').slice(0, 160);
  const lines = [];

  if (isEn) {
    lines.push(`[Briefing] Last task ${task.taskId} (${total} clips × ${clipDur}s${task.model ? `, ${task.model}` : ''}${whenEn ? `, ${whenEn}` : ''}) is ${task.status === 'partial' ? 'partially done' : 'not finished'}.`);
    lines.push(interrupted
      ? `· Cause: the service was restarted while it was in "${stepOf(task.interruptedFrom || task.status)}", so the pipeline stopped with the process (not cancelled by you, not a model error).`
      : '· Cause: the task is recorded as failed; open the task details to see the original error.');
    lines.push(`· Progress: ${okClips.length}/${total} clips succeeded (${pct}%)${okSec ? `, ~${okSec}s of footage is kept` : ''}.`);
    const bits = [];
    if (failClips.length) { const t = tagsOf(failClips); bits.push(`${t.count} failed (${t.text})`); }
    if (runClips.length) { const t = tagsOf(runClips); bits.push(`${t.count} were mid-generation at the restart (${t.text})`); }
    if (pendingClips.length) bits.push(`${pendingClips.length} not started`);
    if (bits.length) lines.push(`· Detail: ${bits.join('; ')}.`);
    if (timeoutCount) {
      lines.push(`  (${timeoutCount} of them were marked failed by a local wait timeout: the upstream job may already have completed and been billed, and a resume re-submits them.)`);
    }
    lines.push(`· Next: say "continue", or open this task in the task list and press "Continue": only the ${need} unfinished clips are regenerated, and the ${okClips.length} finished ones are reused${okClips.length ? ' without being billed again' : ''}.`);
    lines.push('· Note: continuing is billed per clip and starts only after you confirm. The API key lives in this browser only, so continue from this browser (from another machine it silently falls back to Mock footage).');
    return lines.join('\n');
  }

  // 2026-11-23：中文标题带提示词摘要（与 diagnose.taskLabel 同口径），
  // 方便用户在多条任务里认出「是哪条」；英文仍只用 taskId（prompt 是中文内容，英文界面零中文）。
  lines.push(`【小智简报】上一次任务「${diagnose.promptSummary(task)}」（ID ${task.taskId}${durLabel ? ' · ' + durLabel : ''} · ${total} 段 × ${clipDur} 秒${task.model ? ` · ${task.model}` : ''}${when ? ` · ${when}` : ''}）`);
  lines.push(interrupted
    ? `· 状态：中断 —— 服务重启时它还在「${stepOf(task.interruptedFrom || task.status)}」这一步，流水线随进程停止（不是你取消的，也不是模型报错）。`
    : `· 状态：${task.status === 'partial' ? '部分完成（没走到成片）' : '失败'}${why ? ` —— ${why}` : ''}`);
  lines.push(`· 进度：已成功 ${okClips.length}/${total} 段（${pct}%）${okSec ? `，约 ${okSec} 秒素材还在` : ''}。`);
  const detail = [];
  if (failClips.length) { const t = tagsOf(failClips); detail.push(`失败 ${t.count} 段（${t.text}）`); }
  if (runClips.length) { const t = tagsOf(runClips); detail.push(`重启时正在生成 ${t.count} 段（${t.text}）`); }
  if (pendingClips.length) detail.push(`还没开始 ${pendingClips.length} 段`);
  if (detail.length) lines.push(`· 明细：${detail.join('；')}。`);
  if (timeoutCount) {
    lines.push(`  （其中 ${timeoutCount} 段是「本地等待超时」记的失败：上游可能已生成并计费，补跑会重新提交这几段。）`);
  }
  lines.push(`· 继续：说「补跑」，或在任务列表点开这条任务 →「补跑」：只补没成功的 ${need} 段，已成功的 ${okClips.length} 段不会重跑${okClips.length ? '、也不重复计费' : ''}。`);
  lines.push('· 注意：补跑按段计费，点了确认才开始；Key 只存在浏览器本地，请在现在这个浏览器里补跑（换机器补跑会降级成 Mock 合成画面）。');
  return lines.join('\n');
}

// ==========================================
// 计划用了哪些场景卡（2026-11-16 用户问题 a）
// ------------------------------------------------------------
// 用户问「你选的是哪三个场景」时，原实现会把它当新计划再问一遍时长。
// 这里只读地回答：计划阶段用 allocate() 预览（纯函数，不占卡、不建任务），
// 已开工的任务用 task.sceneCards.used（实际分配的卡，比预览更可信）。
// 不写文件、不发请求、不产生费用。
// ==========================================
const SCENE_PREVIEW_LIMIT = 8;

// 2026-11-19 英文界面零中文：卡名/地貌/取景/调色/章节标签在英文下走 *_en 字段，
// scene_key 只给中文界面（中文输出逐字不变）。
function sceneCardLine(entry, i, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const card = (entry && entry.id ? sceneCardLibrary.getCardById(entry.id) : null) || entry || {};
  const rawName = card.scene_key || card.sceneKey || card.id;
  // 卡库读不到时 planSceneEntries 会塞中文占位 '(卡缺失)'，英文界面不能漏中文。
  const name = isEn
    ? (card.protagonist_en || (rawName === '(卡缺失)' ? '(missing card)' : rawName) || '(unknown card)')
    : (rawName || '(未知卡)');
  const bits = [`#${i + 1}`, name];
  const chapter = Number.isInteger(card.chapter) ? card.chapter : (entry && entry.chapter);
  const sequence = Number.isInteger(card.sequence) ? card.sequence : (entry && entry.sequence);
  if (Number.isInteger(chapter) && Number.isInteger(sequence)) {
    bits.push(isEn ? `ch. ${chapter}-${sequence}` : `第 ${chapter} 章-${sequence}`);
  }
  const biome = isEn
    ? [card.biome_en, card.landform_en].filter(Boolean).join('/')
    : [card.biome, card.landform].filter(Boolean).join('/');
  if (biome) bits.push(biome);
  const shot = isEn ? card.shot_en : card.shot;
  if (shot) bits.push(shot);
  const palette = isEn ? card.palette_en : card.palette;
  if (palette) bits.push(palette);
  if (entry && entry.role === 'buffer') bits.push(isEn ? 'buffer card' : '缓冲卡');
  return bits.join(' · ');
}

function formatSceneEntries(entries, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const list = Array.isArray(entries) ? entries : [];
  const shown = list.slice(0, SCENE_PREVIEW_LIMIT).map((e, i) => sceneCardLine(e, i, lang));
  if (list.length > shown.length) {
    shown.push(isEn
      ? `… ${list.length} cards in total; first ${shown.length} shown here.`
      : `…… 共 ${list.length} 张，这里先列前 ${shown.length} 张。`);
  }
  return shown.join('\n');
}

// P7-A：按计划里**固定的** sceneCardIds 取卡（换单段后这里是换过的卡），
// 而不是每次重新 allocate（否则「问选了哪些场景」会把用户换的卡说回去）。
// 计划没有 sceneCardIds（本功能上线前创建的旧计划）→ 回退 allocate 预览，仅只读。
function planSceneEntries(plan) {
  if (!plan) return [];
  const ids = Array.isArray(plan.sceneCardIds) && plan.sceneCardIds.length ? plan.sceneCardIds : null;
  if (ids) {
    return ids.map((id, i) => {
      const card = sceneCardLibrary.getCardById(id);
      if (!card) return { index: i, id, scene_key: '(卡缺失)', role: 'feature' };
      return {
        index: i,
        id: card.id,
        scene_key: card.scene_key,
        chapter: Number.isInteger(card.chapter) ? card.chapter : null,
        sequence: Number.isInteger(card.sequence) ? card.sequence : null,
        role: card.role,
        palette_id: card.palette_id || null
      };
    });
  }
  try {
    // 计划阶段固定下来的卡（换卡后这里就是新卡）；旧计划没有 ids 时回退纯函数预览。
    // 2026-11-17 V1：allocate 现在是**随机抽卡**，所以旧计划必须用 seed=planId 保证
    // 「同一计划内反复问不变」（Q25=A）；同时 noCooling/不写冷却，避免只读预览改变冷却状态。
    return sceneCardLibrary.allocate(plan.clipCount, {
      seed: `legacy-preview:${plan.planId}`,
      noCooling: true,
      recordCooling: false
    }).used;
  } catch (e) {
    return [];
  }
}

function replyForPlanScenes(sessionId, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return isEn
      ? 'No plan card yet, so no scene cards have been chosen. Tell me the total length (for example "30 seconds" or "10 minutes"); once the plan is ready I will list the cards it will use.'
      : '现在还没有计划卡，所以我还没选卡。先说总时长（比如「30 秒」「10 分钟」），'
        + '我排好计划后就把要用的场景卡列给你看。';
  }
  // 已开工：以任务里实际分配的卡为准（可能已有 buffer 替换）。
  // 只认**这条计划自己的**状态；不能用「会话里最新的状态」——用户可能在上一条计划之后
  // 又排了一条尚未执行的新计划，用最新状态会把上一条任务的卡说成这条计划的。
  const state = memory.getState(sessionId, plan.planId);
  const taskId = state && state.taskId ? state.taskId : null;
  const task = taskId ? taskManager.getTask(taskId) : null;
  if (task && task.sceneCards && Array.isArray(task.sceneCards.used) && task.sceneCards.used.length) {
    const head = isEn
      ? `${diagnose.taskLabel(task)}（ID ${task.taskId}）used ${task.sceneCards.used.length} scene cards in plan order:\n`
      : `${diagnose.taskLabel(task)}（ID ${task.taskId}）实际分配到 ${task.sceneCards.used.length} 张场景卡（按计划顺序）：\n`;
    const tail = isEn
      ? '\nThese cards are already written into each clip prompt; to change cards, start a new plan.'
      : '\n这些卡已写进各段提示词；要换卡得新开一条计划。';
    return head + formatSceneEntries(task.sceneCards.used, isEn ? 'en' : 'zh') + tail;
  }
  if (plan.sceneCards === false) {
    return isEn
      ? 'This plan turned scene cards off (free-form prompts), so no cards were chosen. To use the card library, start a new plan (do not say "no scene cards").'
      : '这条计划关掉了场景卡（自由提示词），所以没有选卡。'
        + '想要卡库选场景，就新排一条（不要说「不要场景卡」）。';
  }
  try {
    // 计划阶段固定下来的卡（换卡后这里就是新卡）；旧计划没有 ids 时回退纯函数预览。
    // allocate() 是纯函数：按 chapter+sequence 取前 N 张，不占卡、不写卡库、不建任务。
    // createTask 执行时按同一批 id 取卡，所以这份预览与真正要用的卡一致。
    const preview = planSceneEntries(plan);
    if (!preview.length) {
      return isEn
        ? 'The scene-card library cannot be read right now. The plan is intact; ask again in a moment.'
        : '场景卡库暂时读不到，计划还在，稍后再问一次就行。';
    }
    if (isEn) {
      return `This plan has ${plan.clipCount} clips; when confirmed it will draw these ${preview.length} scene cards in plan order:\n`
        + formatSceneEntries(preview, 'en')
        + '\n(Preview only — no cards are reserved until you press "Confirm and run".)';
    }
    return `这条计划 ${plan.clipCount} 段，确认后会按计划顺序取这 ${preview.length} 张场景卡：\n`
      + formatSceneEntries(preview, 'zh')
      + '\n（现在只是预览，还没占卡；真正点「确认执行」时才分配给任务。）';
  } catch (e) {
    return isEn
      ? `The scene-card library cannot be read right now: ${(e && e.message) || e}. The plan is intact; ask again in a moment.`
      : `场景卡库暂时读不到：${(e && e.message) || e}。计划还在，稍后再问一次就行。`;
  }
}

// ==========================================
// 场景卡内容检索（2026-11-23）
// ------------------------------------------------------------
// 背景：用户问「里面有雪景吗」时，旧实现只有 show_scene_cards（固定列前 8 张），
// 模型只能把列表当答案，于是复读同一段。这里补「按内容查」：
//   · 在当前计划的卡里按字段/同义词找关键词；
//   · 返回段号 + 卡名；空结果明确说「没有」；
//   · 纯函数 + 只读：不占卡、不写冷却、不建任务。
// ==========================================
const SCENE_SEARCH_LIMIT = 8;
const SCENE_SEARCH_FIELDS = Object.freeze([
  'scene_key', 'protagonist', 'biome', 'landform', 'feature', 'foreground', 'weather', 'season',
  'light', 'shot', 'palette', 'climate',
  'protagonist_en', 'biome_en', 'landform_en', 'feature_en', 'foreground_en', 'weather_en',
  'season_en', 'light_en', 'shot_en', 'palette_en'
]);
const SCENE_SEARCH_GROUPS = Object.freeze([
  { key: 'snow', aliases: ['雪', '雪景', '雪山', '雪原', '积雪', '初雪', '残雪', '融雪', '雾凇', 'snow', 'snowy'] },
  { key: 'ice', aliases: ['冰', '冰川', '冰架', '冰瀑', '冰斗', '冰湖', '蓝冰', '冰裂纹', 'ice', 'glacier'] },
  { key: 'sea', aliases: ['海', '海岸', '海边', '礁', '潮间带', '海蚀', 'sea', 'coast', 'reef', 'intertidal'] },
  { key: 'desert', aliases: ['沙漠', '沙丘', '戈壁', '荒漠', '雅丹', 'desert', 'dune', 'gobi'] },
  { key: 'night', aliases: ['夜景', '夜', '星空', '星', '银河', '极光', '天文', 'night', 'star', 'galaxy', 'aurora'] },
  { key: 'lake', aliases: ['湖', '湖泊', 'lake'] },
  { key: 'forest', aliases: ['森林', '林', 'forest'] },
  { key: 'waterfall', aliases: ['瀑布', 'waterfall'] },
  { key: 'volcano', aliases: ['火山', '地热', '温泉', 'volcano', 'geothermal'] },
  { key: 'grassland', aliases: ['草原', '草甸', 'grassland', 'meadow'] },
  { key: 'wetland', aliases: ['湿地', '沼泽', 'wetland'] },
  { key: 'canyon', aliases: ['峡谷', '丹霞', '喀斯特', 'canyon', 'danxia', 'karst'] },
  { key: 'rain', aliases: ['雨', '雨纹', 'rain'] },
  { key: 'salt', aliases: ['盐', '盐湖', '盐盘', 'salt'] },
  { key: 'polar', aliases: ['极地', 'polar'] }
]);

function normalizeSceneSearch(s) {
  return String(s === undefined || s === null ? '' : s).toLowerCase().replace(/\s+/g, '');
}

function sceneSearchAliases(query) {
  const q = normalizeSceneSearch(query);
  if (!q) return [];
  const out = new Set([q]);
  for (const group of SCENE_SEARCH_GROUPS) {
    const hit = group.aliases.some((a) => {
      const alias = normalizeSceneSearch(a);
      return alias && (q.indexOf(alias) !== -1 || alias.indexOf(q) !== -1);
    });
    if (hit) for (const a of group.aliases) out.add(normalizeSceneSearch(a));
  }
  return [...out].filter(Boolean);
}

function sceneSearchHit(card, aliases) {
  for (const field of SCENE_SEARCH_FIELDS) {
    const value = normalizeSceneSearch(card && card[field]);
    if (!value) continue;
    for (const alias of aliases) {
      if (alias && value.indexOf(alias) !== -1) return { field, value: card[field] };
    }
  }
  return null;
}

function sceneSearchLine(card, segment, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const bits = [isEn ? `Segment ${segment}` : `第 ${segment} 段`];
  if (isEn) {
    bits.push(card.protagonist_en || card.scene_key || card.id || '(unknown card)');
    if (card.feature_en && card.feature_en !== card.protagonist_en) bits.push(card.feature_en);
  } else {
    bits.push(card.scene_key || card.id || '(未知卡)');
  }
  const chapter = Number.isInteger(card.chapter) ? card.chapter : null;
  const sequence = Number.isInteger(card.sequence) ? card.sequence : null;
  if (chapter !== null && sequence !== null) {
    bits.push(isEn ? `ch. ${chapter}-${sequence}` : `第 ${chapter} 章-${sequence}`);
  }
  const biome = isEn
    ? [card.biome_en, card.landform_en].filter(Boolean).join('/')
    : [card.biome, card.landform].filter(Boolean).join('/');
  if (biome) bits.push(biome);
  const season = isEn ? card.season_en : card.season;
  if (season) bits.push(season);
  const shot = isEn ? card.shot_en : card.shot;
  if (shot) bits.push(shot);
  return bits.join(' · ');
}

/**
 * 在当前计划的场景卡里按内容检索。只读纯函数（不写卡库/冷却/任务）。
 * @returns {{ok:true, reply:string, matches:Array, total:number, query:string, replyKey:string}}
 */
function searchPlanSceneCards(plan, query, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const q = String(query === undefined || query === null ? '' : query).trim();
  const replyKey = 'assistant.reply.sceneSearch';
  if (plan && plan.sceneCards === false) {
    return {
      ok: true,
      reply: isEn
        ? 'This plan turned scene cards off (free-form prompts), so there is nothing to search. Start a new plan with scene cards to search cards by content.'
        : '这条计划关掉了场景卡（自由提示词），没有可检索的卡；要按卡查内容，请新开一条带场景卡的计划。',
      matches: [], total: 0, query: q, replyKey
    };
  }
  const entries = planSceneEntries(plan);
  const planCount = Number(plan && plan.clipCount) || entries.length;
  if (!entries.length) {
    return {
      ok: true,
      reply: isEn
        ? 'The scene-card library cannot be read right now. The plan is intact; ask again in a moment.'
        : '场景卡库暂时读不到，计划还在，稍后再问一次就行。',
      matches: [], total: 0, query: q, replyKey
    };
  }
  const aliases = sceneSearchAliases(q);
  const matches = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const card = sceneCardLibrary.getCardById(entry && entry.id);
    if (!card) continue;
    const hit = sceneSearchHit(card, aliases);
    if (!hit) continue;
    matches.push({
      segment: i + 1,
      id: card.id,
      field: hit.field,
      value: hit.value,
      card
    });
  }
  const total = matches.length;
  const shown = matches.slice(0, SCENE_SEARCH_LIMIT);
  const lines = shown.map((m) => sceneSearchLine(m.card, m.segment, isEn ? 'en' : 'zh'));
  let reply;
  if (!total) {
    reply = isEn
      ? `This plan has ${planCount} scene cards; none match "${q}".\nTry another keyword (snow / ice / sea / desert / night / forest / waterfall...) or say "show the scene cards" to list them.`
      : `这 ${planCount} 张场景卡里没有匹配「${q}」的卡。\n可以换个关键词（雪 / 冰 / 海 / 沙漠 / 夜景 / 森林 / 瀑布…），或者说「看场景卡」查看全部。`;
  } else {
    reply = isEn
      ? `This plan has ${planCount} scene cards; ${total} match "${q}":\n`
      : `这 ${planCount} 张场景卡里有 ${total} 张匹配「${q}」：\n`;
    reply += lines.join('\n');
    if (total > shown.length) {
      reply += isEn
        ? `\n... ${total} in total; first ${shown.length} shown here.`
        : `\n…… 共 ${total} 张，这里先列前 ${shown.length} 张。`;
    }
    reply += isEn ? '\n(Read-only query; the plan is unchanged.)' : '\n（只读查询，没有改动计划。）';
  }
  return {
    ok: true,
    reply,
    matches: matches.map((m) => ({ segment: m.segment, id: m.id, field: m.field, value: m.value })),
    total,
    query: q,
    replyKey
  };
}

// 纯文生视频开关（2026-11-16 用户问题 b）
// 实测「逐段出图」是前端 localStorage 状态（assistant.js 的 imagePerClip），不进计划卡；
// 所以聊天里只能告诉用户去卡上点，不能假装已经改掉。
function replyForNoImage(sessionId) {
  const plan = memory.lastPlan(sessionId);
  const head = plan
    ? `当前计划：${plan.clipCount} 段 × ${plan.clipDurationSec} 秒（${plan.modelLabel}）。`
    : '现在还没有计划卡：先说总时长（比如「30 秒」「10 分钟」），我排好计划。';
  return `${head}\n「逐段出图」是计划卡上的勾选框，聊天里改不了（它存在你浏览器本地），手动点一下就行：\n`
    + '· 纯文生视频（不出图）：取消「逐段出图」的勾选，再点「确认执行」——只按场景卡提示词生成视频，不出图、也不会停下来等你审图；\n'
    + '· 出图 → 图生视频：保持勾选（默认开）。出图后我会停下来，等你去「库 · 图片」审完再点「继续生成」。\n'
    + '改这个勾选不重排计划，也不产生任何费用。';
}

// ==========================================
// 2026-11-17 小智 2.0 V1（设计定稿 §9.1-6）：最终确认时点（A7）
// ------------------------------------------------------------
// 用户问「确认生成吗？」时**只回确认语 + 回传计划**（前端据此展示计划卡），
// 绝不在这里建任务：真正建任务只走 execute()，而 execute 只由卡片上的「确认执行」按钮触发
// （web/src/components/assistant.js 的 confirmPlan）。
// 共同契约 §0.2：L3（付费/建任务）必须用户点确认；未确认 → PAYMENT_NOT_APPROVED。
// ==========================================
function replyForConfirm(sessionId, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return isEn
      ? 'There is no plan card to confirm yet. Tell me the total length (for example "30 seconds" or "10 minutes"), '
        + 'and I will lay out a plan first.'
      : '现在还没有计划卡，没有可确认的东西。先说总时长（比如「30 秒」「10 分钟」），'
        + '我排好计划再让你确认。';
  }
  const costEn = plan.requiresPaymentApproval && plan.estimate
    ? `estimated ¥${Number(plan.estimate.totalCny || 0).toFixed(2)}`
    : 'zero cost (Mock)';
  const cost = plan.requiresPaymentApproval && plan.estimate
    ? `预估 ¥${Number(plan.estimate.totalCny || 0).toFixed(2)}`
    : '零计费（Mock）';
  const state = memory.getState(sessionId, plan.planId);
  if (state && state.state && !['planned'].includes(state.state)) {
    return isEn
      ? `This plan is already moving (${stateMachine.LABELS[state.state] || state.state}), so there is no need to confirm again. `
        + 'Ask "what is the progress" to see it.'
      : `这条计划已经在走了（${stateMachine.LABELS[state.state] || state.state}），不用再确认；`
        + '要看进度就说「现在进度怎样」。';
  }
  if (isEn) {
    return `Start now? ${plan.clipCount} clips × ${plan.clipDurationSec} s (${plan.modelLabel} · ${plan.resolution}, ${costEn}).\n`
      + 'I start only when you press "Confirm and run" on the card below: nothing is created and nothing is charged before that. '
      + 'If you want changes, say them now; planId stays the same.';
  }
  return `要现在开始吗？${plan.clipCount} 段 × ${plan.clipDurationSec} 秒（${plan.modelLabel} · ${plan.resolution}，${cost}）。\n`
    + '点下面卡片上的「确认执行」我才开始：没点之前不会建任务，也不会花一分钱。'
    + '要改哪里现在直接说，planId 不变。';
}

// ==========================================
// 2026-11-17 小智 2.0 V2（设计文档 §2 V2）：只读环境感知 A–E + 管家简报口吻（Q21=B）
// ------------------------------------------------------------
// A 任务 / B 预算 / C 素材 / D 设置与能力 / E 最近错误摘要，全部只读；
// 数据源是 src/assistant/context.js（进程内模块，不经 HTTP，不新建实例）。
// 三条红线不变：不建任务、不写文件、不调模型、不产生费用；Key 只报「有/无」。
// ==========================================
const CONTEXT_KEYS = assistantContext.CONTEXT_KEYS;

function keyPresence() {
  return assistantContext.keyPresence();
}

// 只读上下文：context.js 负责环境数据，本函数补上「当前会话的计划/草稿」。
function contextOf(sessionId, opts = {}) {
  const base = assistantContext.contextOf(sessionId, {
    ...opts,
    server: {
      ...(opts && opts.server && typeof opts.server === 'object' ? opts.server : {}),
      supervisorVersion: SUPERVISOR_VERSION,
      planVersion: planCard.PLAN_VERSION
    }
  });
  const plan = (sessionId ? memory.lastPlan(sessionId) : null) || null;
  const bp = plan ? briefPlan(plan) : null;
  // 兼容 V1（§9.1-7）契约：顶层继续保留 keys（只含 label/present）。
  // V2 的完整分组在 settings.keys，两者是同一份数据，不额外查询。
  return { ...base, plan: bp, ui: { ...(base.ui || {}), draft: bp }, keys: base.settings.keys };
}

function fmtUsd(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

// 2026-11-19 B 目标第二刀：给 agent 的**只读紧凑上下文**（不把整个 context 塞进 prompt）。
// 只含理解所需：有没有计划、计划摘要、最近任务、余额、在跑数、最近失败。
function agentContextOf(opts = {}) {
  const sessionId = opts && opts.sessionId ? String(opts.sessionId) : null;
  const ctx = contextOf(sessionId, opts);
  const plan = ctx.plan || null;
  const active = ctx.tasks && Array.isArray(ctx.tasks.active) ? ctx.tasks.active : [];
  const recent = ctx.tasks && Array.isArray(ctx.tasks.recent) ? ctx.tasks.recent : [];
  const last = recent.length ? recent[0] : null;
  const failed = ctx.tasks && Array.isArray(ctx.tasks.failedRecent) ? ctx.tasks.failedRecent[0] : null;
  return {
    hasPlan: !!plan,
    planSummary: plan
      ? `${plan.clipCount} 段 × ${plan.clipDurationSec} 秒 · ${plan.modelLabel || plan.model} · ${plan.resolution}（planId ${plan.planId}）`
      : null,
    lastTaskSummary: last ? `${last.taskId}（${last.status || '未知'}）` : null,
    budgetUsd: ctx.budget ? ctx.budget.balanceUsd : null,
    activeTasks: active.length,
    recentError: failed ? `${failed.taskId}（${failed.status || 'failed'}）` : null
  };
}

// 2026-11-19 S3：英文 Key 分组名（只映射 label，不扩展 keyPresence 契约「仅 label+present」）
const KEY_LABELS_EN = Object.freeze({
  '视频生成·WhaleTV 中转': 'Video · WhaleTV relay',
  '视频生成·百炼万相': 'Video · Bailian Wanxiang',
  '视频生成·可灵': 'Video · Kling',
  '图片生成': 'Image generation',
  '多模态质检': 'Multimodal QC',
  '文案 LLM': 'Text LLM'
});

// 2026-11-19 S3：英文只读汇总（不夹中文标签；任务只报 ID/状态，不贴中文提示词标题）
function replyForContextEn(ctx) {
  const lines = [];
  lines.push(`[Briefing] Read-only environment summary (${ctx.version})`);
  if (ctx.plan) {
    const m = planCard.MODELS[ctx.plan.model];
    const modelLabel = (m && m.labelEn) || ctx.plan.model;
    lines.push(`Current plan: ${ctx.plan.clipCount} clips × ${ctx.plan.clipDurationSec} s `
      + `(${modelLabel} · ${ctx.plan.resolution}) · planId ${ctx.plan.planId}`);
  } else {
    lines.push('Current plan: no plan card yet.');
  }
  lines.push(`Tasks: ${ctx.tasks.total} total`
    + (ctx.tasks.active.length ? `, ${ctx.tasks.active.length} running` : '')
    + (ctx.tasks.recent.length
      ? `; recent: ${ctx.tasks.recent.slice(0, 3).map((t) => `${t.taskId} (${t.status || 'unknown'})`).join(', ')}`
      : ''));
  if (ctx.tasks.active.length) {
    lines.push('Running:\n' + ctx.tasks.active
      .map((t) => `· ${t.taskId}: ${t.status}, ${t.successClips}/${t.totalClips} clips (${t.percent}%)`)
      .join('\n'));
  }
  if (ctx.tasks.failedRecent.length) {
    lines.push('Recent failures: ' + ctx.tasks.failedRecent.slice(0, 3)
      .map((t) => `${t.taskId} (${t.status || 'failed'})`).join(', '));
  }
  lines.push(ctx.budget
    ? `Budget: ${fmtUsd(ctx.budget.balanceUsd)} left (spent ${fmtUsd(ctx.budget.spentUsd)} of ${fmtUsd(ctx.budget.initialUsd)}).`
    : 'Budget: unavailable.');
  const p = ctx.assets.photos;
  lines.push(`Assets: photos ${p.usable} usable / ${p.all} total `
    + `(${p.pending} pending, ${p.approved} approved, ${p.rejected} rejected); `
    + `finals ${ctx.assets.library.finals}; clips ${ctx.assets.library.clips}; `
    + `scene cards ${ctx.assets.sceneCards.features}; BGM ${ctx.assets.bgm.tracks}.`);
  lines.push(`Settings: default video ${ctx.settings.models.defaults.model} · ${ctx.settings.models.defaults.resolution}; `
    + `image-to-video: ${ctx.settings.models.i2v.supported.join(' / ')}; `
    + `preferences: ${ctx.settings.preferences ? 'saved' : 'none'}; `
    + `broadcast: ${ctx.settings.broadcast.broadcastEnabled ? 'on' : 'off'} (throttle ${ctx.settings.broadcast.throttleSec} s).`);
  lines.push('Keys (server env, present/absent only): '
    + ctx.settings.keys.map((k) => `${KEY_LABELS_EN[k.label] || 'API key'} ${k.present ? 'present' : 'absent'}`).join('; ') + '.');
  lines.push('(Read-only summary: no tasks created, nothing changed; keys are shown only as present/absent.)');
  return lines.join('\n');
}

function replyForContext(sessionId, opts = {}) {
  const ctx = contextOf(sessionId, opts);
  if (i18n.normalizeLang(opts.lang) === 'en') return replyForContextEn(ctx);
  const lines = [];
  lines.push(`【小智简报】环境只读汇总（${ctx.version}）`);
  lines.push(ctx.plan
    ? `当前计划：${ctx.plan.clipCount} 段 × ${ctx.plan.clipDurationSec} 秒（${ctx.plan.modelLabel} · ${ctx.plan.resolution}）· planId ${ctx.plan.planId}`
    : '当前计划：还没有计划卡。');
  lines.push(`任务：共 ${ctx.tasks.total} 个`
    + (ctx.tasks.active.length ? `，在跑 ${ctx.tasks.active.length} 个` : '')
    + (ctx.tasks.recent.length
      ? `；最近 ${ctx.tasks.recent.slice(0, 3).map((t) => `${t.taskId}（${t.status || '未知'}）`).join('、')}`
      : ''));
  if (ctx.tasks.active.length) {
    lines.push('在跑：\n' + ctx.tasks.active
      .map((t) => `· ${t.taskId}：${t.status}，成功 ${t.successClips}/${t.totalClips} 段（${t.percent}%），当前 ${t.currentStep || '…'}`)
      .join('\n'));
  }
  if (ctx.tasks.failedRecent.length) {
    lines.push('最近失败：' + ctx.tasks.failedRecent.slice(0, 3)
      .map((t) => `${t.taskId}（${t.status}）：${t.reason || '原因未记录'}`).join('；'));
  }
  lines.push(ctx.budget
    ? `预算：剩余 ${fmtUsd(ctx.budget.balanceUsd)}（已花 ${fmtUsd(ctx.budget.spentUsd)}，初始 ${fmtUsd(ctx.budget.initialUsd)}）`
    : '预算：读不到（budget 模块不可用）。');
  const p = ctx.assets.photos;
  lines.push(`素材：图片库可用 ${p.usable} 张 / 共 ${p.all}（待审 ${p.pending}，通过 ${p.approved}，打回 ${p.rejected}）；`
    + `成片库 ${ctx.assets.library.finals} 条，片段库 ${ctx.assets.library.clips} 条；场景卡 ${ctx.assets.sceneCards.features} 张；配乐 ${ctx.assets.bgm.tracks} 首。`);
  lines.push(`设置：默认视频 ${ctx.settings.models.defaults.model} · ${ctx.settings.models.defaults.resolution}；`
    + `图生视频支持 ${ctx.settings.models.i2v.supported.join(' / ')}；跨会话偏好 ${ctx.settings.preferences ? '已保存' : '未保存'}；`
    + `任务播报 ${ctx.settings.broadcast.broadcastEnabled ? '开' : '关'}（节流 ${ctx.settings.broadcast.throttleSec} 秒）。`);
  // 2026-11-17 V1 遗留 ③：口径必须写清「服务端环境变量」。
  // 用户真实 Key 存在设置页浏览器 localStorage（vs_config），服务端 process.env 读不到；
  // 只写「Key 无」会让用户以为自己的 Key 丢了（Lead 实证 M6：重启后小智答「WhaleTV 中转 无」）。
  lines.push('Key（服务端环境变量，只报有/无）：' + ctx.settings.keys.map((k) => `${k.label} ${k.present ? '有' : '无'}`).join('；'));
  lines.push('（设置页里填的 Key 存在浏览器本地，小智看不到；只有写进 app/.env 并重启服务的那份才算「有」。）');
  if (ctx.recentErrors.length) {
    lines.push(`最近错误摘要（已脱敏）：${ctx.recentErrors[0].text.slice(0, 160)}`);
  }
  lines.push('（只读汇总：不会建任务、不会改任何东西；Key 只报有/无。）');
  return lines.join('\n');
}

// B5：素材库存（与 /api/photos 同口径：文件缺失的图片不计入；只读）。
function replyForAssets(sessionId, lang) {
  const ctx = contextOf(sessionId);
  const p = ctx.assets.photos;
  if (i18n.normalizeLang(lang) === 'en') {
    return [
      '[Briefing] Asset inventory (read-only):',
      `Photos: ${p.usable} usable / ${p.all} total (${p.pending} pending, ${p.approved} approved, ${p.rejected} rejected) — same scope as /api/photos (missing files excluded).`,
      `Finals: ${ctx.assets.library.finals}; clips: ${ctx.assets.library.clips}; scene cards: ${ctx.assets.sceneCards.features}; BGM: ${ctx.assets.bgm.tracks}.`,
      '(Nothing was deleted or changed; to clean up finals or clips, open Library.)'
    ].join('\n');
  }
  return [
    '【小智简报】素材库存（只读）：',
    `图片库：可用 ${p.usable} 张 / 共 ${p.all}（待审 ${p.pending}，通过 ${p.approved}，打回 ${p.rejected}）——与 /api/photos 同口径（文件缺失不计入）。`,
    `成片库 ${ctx.assets.library.finals} 条；片段库 ${ctx.assets.library.clips} 条；场景卡 ${ctx.assets.sceneCards.features} 张（缓冲 ${ctx.assets.sceneCards.buffers}）；配乐 ${ctx.assets.bgm.tracks} 首。`,
    '（不会删除/改动任何素材；要清理成片或片段请去「库」页手动操作。）'
  ].join('\n');
}

// ==========================================
// V2：失败诊断 + 一键修复建议（B2/B3，Q20=B：只给建议，用户点了才执行）
// ==========================================
function pickTaskForDiagnosis(sessionId) {
  const state = sessionId ? memory.getState(sessionId) : null;
  if (state) {
    const id = state.finalTaskId || state.taskId;
    const t = id ? taskManager.getTask(id) : null;
    if (t) return t;
  }
  let tasks = [];
  try { tasks = taskManager.getAllTasks(); } catch (e) { tasks = []; }
  const bad = tasks
    .filter((t) => t && (['failed', 'partial'].includes(t.status)
      || (Array.isArray(t.clips) && t.clips.some((c) => c && c.status !== 'success' && c.status !== 'pending'))))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return bad[0] || null;
}

// 2026-11-19 S3：英文诊断话术（分类/建议按 id 映射，不贴中文任务标题与原始错误）
const CATEGORY_LABELS_EN = Object.freeze({
  budget: 'Budget insufficient',
  key: 'Key / auth',
  model: 'Model capability mismatch',
  rate: 'Rate limited',
  timeout: 'Network / timeout',
  interrupted: 'Service restart interruption',
  qc: 'QC failed',
  media: 'Media processing failed',
  unknown: 'Unclassified failure'
});

const SUGGESTION_LABELS_EN = Object.freeze({
  continue: (n) => (n > 0
    ? `Retry the ${n} unfinished clip(s) — completed clips are reused, not regenerated`
    : 'Re-run this task — completed parts are reused'),
  switch_model: () => 'Switch to a channel that supports image-to-video (Bailian / Kling / Seedance / WhaleTV relay)',
  fix_key: () => 'Add the API key under Settings → Video and restart; or turn off per-clip images and use text-to-video',
  wait: () => 'Retry in a few minutes (rate limits are transient; completed clips are reused)',
  topup: () => 'Top up or reconcile the budget before retrying',
  lower_resolution: () => 'Lower the resolution (1080p → 720p) to cut the per-clip cost',
  review_photos: () => 'Open Library → Photos, approve or reject the frames, then continue',
  inspect: () => 'Open the task details, check the last failed step, and paste the error back to me'
});

const SUGGESTION_WHERE_EN = Object.freeze({
  switch_model: 'Settings → Video',
  fix_key: 'Settings → Video',
  topup: 'Settings → Budget',
  lower_resolution: 'Plan card / Settings',
  review_photos: 'Library → Photos'
});

function replyForRepair(sessionId, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const task = pickTaskForDiagnosis(sessionId);
  if (!task) {
    return {
      reply: isEn
        ? 'There is no failed task to diagnose right now. To inspect another task, send me its task id; '
          + 'to lay out a new plan, tell me the total length. This was a read-only check: no task was created.'
        : '现在没有失败的任务可诊断。要我看别的任务，把任务 id 发我；'
          + '要排新计划就说总时长。这次只做了只读检查，没有建任务。',
      diagnosis: null
    };
  }
  const d = diagnose.diagnose(task);
  if (isEn) {
    const lines = ['[Briefing] Failure diagnosis (read-only):'];
    lines.push(`Task ${d.taskId} (${d.status || 'unknown'})`
      + (Number(d.notSuccessClips) > 0 ? ` — ${d.notSuccessClips} clip(s) not finished.` : ' — no final cut was produced.'));
    lines.push(`Category: ${CATEGORY_LABELS_EN[d.category] || CATEGORY_LABELS_EN.unknown}`);
    lines.push('Suggested fixes (nothing runs until you confirm; nothing was charged):');
    d.suggestions.forEach((s, i) => {
      const label = (SUGGESTION_LABELS_EN[s.id]
        && SUGGESTION_LABELS_EN[s.id](Number(d.notSuccessClips) || d.failedClips.length)) || 'Review the task details';
      const where = SUGGESTION_WHERE_EN[s.id];
      lines.push(`${i + 1}. ${label}${s.executable ? '' : ' (manual step; not executable in chat)'}`
        + (where ? ` — ${where}` : ''));
    });
    lines.push('This was a read-only check: no task was created, nothing was re-run, no settings were changed.');
    return { reply: lines.join('\n'), diagnosis: d };
  }
  const lines = ['【小智简报】失败诊断（只读）：', d.summary, `分类：${d.categoryLabel}`
    + (d.failedClips.length
      ? `；未完成片段 ${d.failedClips.map((f) => '#' + (f.index + 1)).join('、')}`
        + (Number(d.notSuccessClips) > d.failedClips.length
          ? `（这里只列前 ${d.failedClips.length} 段，共 ${d.notSuccessClips} 段未完成）`
          : '')
      : '')];
  lines.push('修复选项（都要你点确认才执行，未确认不会重跑、不会花钱）：');
  d.suggestions.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.label}${s.executable ? '' : '（仅提示，需到设置页/库页手动处理）'}${s.where ? ` — ${s.where}` : ''}`);
  });
  lines.push('这条回复只做了诊断：没有创建任务、没有重跑、没有改设置。');
  return { reply: lines.join('\n'), diagnosis: d };
}

// ==========================================
// V2：跨会话偏好 + 设置变更的 L3 确认（Q15=B / B6 / Q18=A）
// ------------------------------------------------------------
// 契约（server / 前端 / verify 共用）：
//   1) 用户说「把默认通道改成百炼」→ 只返回 pendingChange（changeId + label + requiresConfirm），**不改任何东西**；
//   2) 确认必须显式 approved=true + 同一 changeId；未确认/不匹配/过期 → 明确错误码，持久状态不变；
//   3) 确认成功才写 preferences（服务端用户级）+ 写 audit（谁/何时/改了什么）；
//   4) 未登录墙场景 userId='local'；有登录墙时用 req.auth.userId（由 server.js 传入）。
// ==========================================
const CHANGE_TTL_MS = 10 * 60 * 1000;
let changeSeq = 0;
const pendingChanges = new Map(); // sessionId -> { changeId, key, value, label, createdAt, expiresAt }

function newChangeId() {
  changeSeq += 1;
  return 'chg_' + Date.now().toString(36) + '_' + changeSeq.toString(36);
}

// 解析「要改什么」。只认显式设置变更句式；解析不了返回 null（由调用方给可选项）。
function parsePreferenceChange(text) {
  const s = String(text || '');
  // 清空偏好
  if (/(?:清空|清除|忘记|删掉|删除)\s*(?:我的)?\s*(?:跨会话)?\s*(?:偏好|常用设置|常用偏好)/.test(s)) {
    return { key: 'clear', value: true, label: '清空跨会话偏好（服务端用户级）' };
  }
  // 任务播报开关（全局设置）
  if (/(?:任务播报|播报|广播)/.test(s)) {
    if (/(?:关掉|关闭|取消|停止|停掉|别播|关)/.test(s)) return { key: 'broadcast', value: false, label: '关闭任务播报' };
    if (/(?:打开|开启|恢复|开)/.test(s)) return { key: 'broadcast', value: true, label: '打开任务播报' };
  }
  // 默认视频通道 / 模型
  if (/(?:通道|模型|视频生成)/.test(s) && /(?:改|换|设|默认)/.test(s)) {
    let value = null;
    if (/百炼|万相|dashscope/i.test(s)) value = 'dashscope';
    else if (/whale|中转|openai-video/i.test(s)) value = 'openai-video';
    else if (/可灵|kling/i.test(s)) value = 'kling';
    else if (/即梦|seedance/i.test(s)) value = 'seedance';
    else if (/mock/i.test(s)) value = 'mock';
    if (value) {
      return { key: 'model', value, label: `默认视频通道 → ${planCard.MODELS[value].label}` };
    }
  }
  // 默认分辨率
  const rm = s.match(/(480p|720p|1080p|4k|2160p)/i);
  if (rm && /(?:分辨率|默认|设置)/.test(s)) {
    return { key: 'resolution', value: rm[1].toLowerCase(), label: `默认分辨率 → ${rm[1].toLowerCase()}` };
  }
  // 默认 BGM 风格
  const bm = s.match(/(?:默认配乐风格|BGM\s*风格|配乐风格)\s*(?:改成|换成|设为|设成|用|[:：])?\s*[:：]?\s*(.+)$/i);
  if (bm && /(?:配乐|音乐|bgm)/i.test(s) && /(?:默认|风格|记住)/.test(s)) {
    const style = String(bm[1] || '').trim().replace(/[。；;]+$/, '').slice(0, 40);
    if (style) return { key: 'bgmStyle', value: style, label: `默认 BGM 风格 → ${style}` };
  }
  return null;
}

// 2026-11-19 S3：英文设置变更（agent 的 settings_change 用；L3 语义与中文一致）
function settingsLabelEn(key, value) {
  if (key === 'model') {
    const m = planCard.MODELS[value];
    return m ? `Default video model → ${m.labelEn || value}` : null;
  }
  if (key === 'resolution') return `Default resolution → ${String(value).toLowerCase()}`;
  if (key === 'broadcast') return `Task broadcast → ${/^(true|on|1)$/i.test(String(value)) ? 'on' : 'off'}`;
  if (key === 'clear_prefs' || key === 'clear') return 'Clear cross-session preferences (server-side)';
  return null;
}

function replyForSettingsChangeEn(sessionId, key, value) {
  const label = settingsLabelEn(key, value);
  if (!label) {
    return {
      reply: 'That setting is not supported. I can change: default video model, default resolution, '
        + 'task broadcast, or clear preferences.',
      pending: null
    };
  }
  const pending = {
    changeId: newChangeId(),
    sessionId,
    key,
    value,
    label,
    requiresConfirm: true,
    approved: false,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + CHANGE_TTL_MS
  };
  pendingChanges.set(sessionId, pending);
  return {
    reply: '[Briefing] This is a settings change (L3) and needs your confirmation:\n'
      + `· ${label}\n`
      + 'Nothing changes until you confirm; after confirmation it is saved server-side and written to the audit log.\n'
      + `(changeId=${pending.changeId}; valid for 10 minutes.)`,
    pending
  };
}

function replyForSettings(sessionId, text, lang) {
  const change = parsePreferenceChange(text);
  if (!change) {
    return {
      reply: i18n.normalizeLang(lang) === 'en'
        ? 'Which setting should I change? You can say:\n'
          + '· "Set the default channel to Bailian"\n· "Set the default resolution to 1080p"\n'
          + '· "Turn task broadcast off" / "on"\n· "Clear preferences"\n'
          + 'I will ask you to confirm first (L3); nothing is written before you approve.'
        : '要改哪一项设置？可以说：\n'
          + '· 「把默认通道改成百炼」\n· 「把默认分辨率改成 1080p」\n· 「把默认 BGM 风格改成轻音乐」\n'
          + '· 「把任务播报关掉」/「把任务播报打开」\n· 「清空偏好」\n'
          + '这些都会先请你确认（L3），确认前不会写任何东西。',
      pending: null
    };
  }
  const pending = {
    changeId: newChangeId(),
    sessionId,
    key: change.key,
    value: change.value,
    label: change.label,
    requiresConfirm: true,
    approved: false,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + CHANGE_TTL_MS
  };
  pendingChanges.set(sessionId, pending);
  return {
    reply: `【小智简报】这是设置变更（L3 级），需要你确认：\n· ${change.label}\n`
      + '确认后才会写入服务端偏好并记审计；现在**没有改任何东西**。\n'
      + `（确认项 changeId=${pending.changeId}；10 分钟内有效。前端设置页在浏览器本地，本轮前端读取偏好未集成。）`,
    pending
  };
}

function confirmSettingChange(opts = {}) {
  const sessionId = String(opts.sessionId || '');
  const userId = opts.userId ? String(opts.userId) : 'local';
  const p = pendingChanges.get(sessionId);
  if (!p) {
    return { ok: false, code: 'SETTINGS_NO_PENDING', error: '没有待确认的设置变更；先说要改哪一项（例如「把默认通道改成百炼」）' };
  }
  if (opts.changeId && String(opts.changeId) !== p.changeId) {
    return { ok: false, code: 'SETTINGS_CHANGE_MISMATCH', error: 'changeId 不匹配（可能已有新的待确认项）', pending: p };
  }
  if (p.expiresAt < Date.now()) {
    pendingChanges.delete(sessionId);
    return { ok: false, code: 'SETTINGS_CHANGE_EXPIRED', error: '待确认项已过期（10 分钟），请重新说一次要改什么' };
  }
  if (opts.approved !== true) {
    return { ok: false, code: 'SETTINGS_NOT_APPROVED', error: '设置变更必须确认（approved=true）后才会写入；现在没有改任何东西', pending: p };
  }
  let before = null;
  let after = null;
  if (p.key === 'clear') {
    const r = preferences.clear(userId);
    before = r.before;
    after = null;
  } else if (p.key === 'broadcast') {
    const r = preferences.setGlobal({ broadcastEnabled: !!p.value });
    if (!r.ok) return { ok: false, code: r.code, error: r.error, rejected: r.rejected };
    before = r.before;
    after = r.after;
  } else {
    const r = preferences.set(userId, { [p.key]: p.value });
    if (!r.ok) return { ok: false, code: r.code, error: r.error, rejected: r.rejected };
    before = r.before;
    after = r.pref;
  }
  const logged = audit.record({
    actor: userId,
    kind: 'settings',
    action: 'confirm',
    target: { key: p.key, sessionId },
    before,
    after,
    note: p.label
  });
  pendingChanges.delete(sessionId);
  return {
    ok: true,
    applied: { key: p.key, value: p.value, label: p.label, changeId: p.changeId },
    before,
    after,
    preferences: preferences.describe(userId),
    broadcast: preferences.globalSettings(),
    audit: logged.ok ? logged.entry : null,
    auditError: logged.ok ? null : logged.error,
    reply: `已按你的确认写入服务端偏好：${p.label}。`
  };
}

function getPreferences(opts = {}) {
  const userId = opts.userId ? String(opts.userId) : 'local';
  return {
    ok: true,
    version: preferences.PREFS_VERSION,
    userId,
    preferences: preferences.describe(userId),
    broadcast: preferences.globalSettings(),
    clearable: true
  };
}

function clearPreferences(opts = {}) {
  const userId = opts.userId ? String(opts.userId) : 'local';
  if (opts.approved !== true) {
    return { ok: false, code: 'SETTINGS_NOT_APPROVED', error: '清空偏好是设置变更，必须确认（approved=true）后才会执行' };
  }
  const r = preferences.clear(userId);
  const logged = audit.record({
    actor: userId, kind: 'preferences', action: 'clear',
    target: { userId }, before: r.before, after: null, note: '清空跨会话偏好'
  });
  return {
    ok: true,
    removed: r.removed,
    preferences: null,
    audit: logged.ok ? logged.entry : null,
    auditError: logged.ok ? null : logged.error,
    reply: r.removed ? '已清空服务端跨会话偏好。' : '之前没有保存过偏好，无需清空。'
  };
}

// B7：读跨会话偏好（新窗口/新会话仍读服务端用户级存储）
function replyForPrefs(sessionId, opts = {}) {
  const userId = opts.userId ? String(opts.userId) : 'local';
  const p = preferences.describe(userId);
  if (i18n.normalizeLang(opts.lang) === 'en') {
    if (!p) {
      return {
        reply: 'No cross-session preferences saved yet. You can say "set the default channel to Bailian" or '
          + '"set the default resolution to 1080p" — I will show a confirmation first and save only after you approve '
          + '(server-side, per user; it survives new windows and browsers).',
        preferences: null
      };
    }
    const m = planCard.MODELS[p.model];
    const lines = ['[Briefing] Cross-session preferences (server-side, can be cleared):'];
    if (p.model) lines.push(`· Default video model: ${(m && m.labelEn) || p.model} (${p.model})`);
    if (p.resolution) lines.push(`· Default resolution: ${p.resolution}`);
    if (p.clipDurationSec) lines.push(`· Common clip length: ${p.clipDurationSec} s`);
    if (p.bgmStyle) lines.push(`· Default BGM style: ${p.bgmStyle}`);
    if (p.updatedAt) lines.push(`(Last updated: ${p.updatedAt})`);
    lines.push('To clear them, say "clear preferences" (I will ask you to confirm). '
      + 'The Settings page does not read these yet; in a new chat, say "use my usual settings".');
    return { reply: lines.join('\n'), preferences: p };
  }
  if (!p) {
    return {
      reply: '还没有保存过跨会话偏好。可以说「把默认通道改成百炼」「把默认分辨率改成 1080p」——'
        + '我会先给出确认项，你确认后才保存（服务端用户级，换窗口/换浏览器仍在）。',
      preferences: null
    };
  }
  const lines = ['【小智简报】跨会话偏好（服务端用户级，可清空）：'];
  if (p.model) lines.push(`· 默认视频通道：${p.modelLabel || p.model}（${p.model}）`);
  if (p.resolution) lines.push(`· 默认分辨率：${p.resolution}`);
  if (p.clipDurationSec) lines.push(`· 常用每段时长：${p.clipDurationSec} 秒`);
  if (p.bgmStyle) lines.push(`· 默认 BGM 风格：${p.bgmStyle}`);
  if (p.updatedAt) lines.push(`（最近更新：${p.updatedAt}）`);
  lines.push('要清空就说「清空偏好」（会先请你确认）。前端设置页本轮尚未读取这份偏好（待集成），'
    + '新的对话窗口里说「用我常用的设置」即可读到。');
  return { reply: lines.join('\n'), preferences: p };
}

// ==========================================
// V2：修复执行（Q20=B：只能用户确认后执行；未确认一律 PAYMENT_NOT_APPROVED 语义）
// ==========================================
async function repairTask(opts = {}) {
  const userId = opts.userId ? String(opts.userId) : 'local';
  const task = opts.taskId
    ? taskManager.getTask(String(opts.taskId))
    : pickTaskForDiagnosis(opts.sessionId);
  if (!task) {
    return { ok: false, code: 'REPAIR_NO_TASK', error: '没有可修复的任务（先说哪条任务失败）' };
  }
  const d = diagnose.diagnose(task);
  const wanted = opts.action ? String(opts.action) : null;
  const act = wanted
    ? d.suggestions.find((s) => s.action === wanted || s.id === wanted)
    : d.suggestions.find((s) => s.executable);
  if (!act) {
    return { ok: false, code: 'REPAIR_ACTION_UNKNOWN', error: `没有可执行的修复项（${wanted || '默认'}）`, diagnosis: d };
  }
  if (ACTIVE_STATUS.has(task.status)) {
    return { ok: false, code: 'REPAIR_TASK_ACTIVE', error: '任务还在运行中，先等它结束再修', diagnosis: d };
  }
  if (opts.approved !== true) {
    return {
      ok: false,
      code: 'PAYMENT_NOT_APPROVED',
      error: `修复会续跑任务（可能计费），必须你点确认后才会执行：${act.label}`,
      diagnosis: d,
      suggestion: act
    };
  }
  if (!act.executable) {
    return {
      ok: false,
      code: 'REPAIR_NOT_EXECUTABLE',
      error: `「${act.label}」需要到设置页/库页手动处理，聊天里不能代改`,
      diagnosis: d,
      suggestion: act
    };
  }
  const before = { status: task.status, failedClips: d.failedClips.length };
  let res = null;
  try {
    res = await pipeline.continueTask(task.taskId, {
      preset: 'final',
      ...(opts.runtimeConfig ? { runtimeConfig: opts.runtimeConfig } : {})
    });
  } catch (e) {
    res = { success: false, error: (e && e.message) || String(e) };
  }
  if (!res || res.success !== true) {
    const logged = audit.record({
      actor: userId, kind: 'repair', action: act.action, target: { taskId: task.taskId },
      before, after: { error: (res && res.error) || 'unknown' }, note: '修复执行失败'
    });
    return {
      ok: false, code: 'REPAIR_FAILED',
      error: `修复执行失败：${(res && res.error) || '未知原因'}`,
      diagnosis: d, audit: logged.ok ? logged.entry : null
    };
  }
  const afterTask = taskManager.getTask(task.taskId);
  const logged = audit.record({
    actor: userId, kind: 'repair', action: act.action, target: { taskId: task.taskId },
    before, after: { status: afterTask ? afterTask.status : 'pending', pendingSteps: (res.pending || []).length },
    note: act.label
  });
  return {
    ok: true,
    taskId: task.taskId,
    action: act.action,
    diagnosis: d,
    resume: res.resume || null,
    pending: res.pending || [],
    audit: logged.ok ? logged.entry : null,
    auditError: logged.ok ? null : logged.error,
    reply: `已按你的确认补跑 ${task.taskId}（复用已成功部分，待跑 ${(res.pending || []).length} 个环节）。`
  };
}


// ==========================================
// P7-A：计划内精准修改（换单段场景卡 / 改单段提示词）
// ------------------------------------------------------------
// 硬性约束（写死在这里，测试逐条断言）：
//   · **不建任务、不调任何模型、不改 planId**；只 memory.addPlan 覆盖同一 planId；
//   · 只允许 1 ≤ N ≤ plan.clipCount，越界明确报错；
//   · 无计划时先问总时长，不凭空排一条；
//   · 改了哪一段写在回复第一行，后面跟当前计划摘要。
// ==========================================
const RE_SEGMENT_INDEX = /第\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*(?:个)?\s*(?:段|镜头|场景|张|条|画面)/;
// 「换成别的 / 换一个」这类空指代 = 换卡，不是改提示词。
const RE_VAGUE_PAYLOAD = /^(?:别的|别的一个?|另一个|其他|其它|其他场景|别的场景|新的|新的一张|一张|一个|一个场景)[。.!！,，]?$/;

function cleanEditPayload(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  s = s.replace(/^[：:，,、\s]+/, '');
  s = s.replace(/^[「『“"']+/, '').replace(/[」』”"']+$/, '');
  s = s.replace(/[。；;，,\s]+$/, '');
  return s.trim();
}

// 从「第 2 段的提示词改成：XXX」里取 XXX（也支持「换成/改为」「画面改成」）。
// 取不到正文返回 ''，由调用方决定是「问用户要正文」还是「当换卡」。
function extractPromptEditText(text) {
  const s = String(text || '');
  let m = s.match(/(?:提示词|画面(?:内容)?)\s*(?:改成|换成|改为|写成|是|[:：])\s*([\s\S]+)$/);
  if (!m) m = s.match(/(?:改成|换成|改为|写成)\s*[：:]?\s*([\s\S]+)$/);
  return m ? cleanEditPayload(m[1]) : '';
}

function savePlanInPlace(sessionId, plan) {
  memory.addPlan(sessionId, plan);
  planCache.set(plan.planId, plan);
  return plan;
}

// ==========================================
// 2026-11-17 小智 2.0 V1（设计定稿 §9.1-2 / §9.1-3）
// 提示词工作流：查看（A4）/ 原样替换（A5）/ 简单 diff（A6）
// ------------------------------------------------------------
// 硬性约束（写死在这里，verify-assistant 逐条断言）：
//   · 不建任务、不调任何模型、不改 planId；只有「真的改了提示词」才写回计划；
//   · 「查看」是纯只读：计划数据一个字节都不变（连「当前编辑段」也不写进 plan），
//     所以调用方保证不要把 plan 回传给前端（否则会弹卡）；
//   · 替换 = 用户原文（Q9=A：不润色、不加后缀）；diff = 按出现顺序逐处应用，一条消息多处全应用；
//   · 回复只给改动点（Q10=B），不重贴整张计划。
//
// 目标段号来源（确定性，不猜；顺序固定）：
//   ① 当前这句里显式写了「第 N 段/张/场景」；
//   ② 会话里最近一条**用户消息**里写过「第 N 段/张/场景」（小智刚问过、用户接着说「用这个」）；
//   ③ 计划只有 1 段 → 就是第 1 段；
//   ④ 都没有 → 问「第几段」，不动计划。
// ==========================================
const RE_PROMPT_VIEW = /(?:提示词|画面内容|画面).{0,8}(?:给我看|看一下|看下|贴一下|贴出来|是什么|是啥|显示|念一下|读一下|发我|瞧一眼)|(?:给我看|看一下|看下|贴一下|贴出来|是什么|是啥|显示|念一下|读一下|发我|瞧一眼).{0,8}(?:提示词|画面内容)/;
// 「第 N 段的提示词改成：…」是整段替换（既有路径），不能被「查看」抢走。
const RE_PROMPT_SET_VERB = /(?:提示词|画面内容|画面)\s*(?:改成|换成|改为|写成|[:：])/;
const RE_USE_THIS = /(?:^|[\s，,。；;])(?:就)?(?:用|按)\s*(?:这个|这段|这条|这版|此)\s*[：:，,]?\s*([\s\S]+)$/;
const RE_DIFF_REPLACE = /(?:把|将)\s*[「『“"']?([^「」『』“”"',，。；;]{1,40}?)[」』”"']?\s*(?:改成|改为|换成|换为|变成)\s*[「『“"']?([^「」『』“”"',，。；;]{1,120})[」』”"']?/g;
const RE_DIFF_REMOVE = /(?:去掉|删掉|删除|拿掉|抹掉|不要)\s*[「『“"']?([^「」『』“”"',，。；;]{1,60})[」』”"']?/g;

function matchSegmentIndex(text) {
  const m = String(text || '').match(RE_SEGMENT_INDEX);
  if (!m) return null;
  const n = planCard.parseCnNumber(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// 「用这个：……」里取出用户原文（原样，不润色）。取不到返回 ''。
function extractUseThisText(text) {
  const m = String(text || '').match(RE_USE_THIS);
  if (!m) return '';
  return cleanEditPayload(m[1]);
}

function resolvePromptTarget(sessionId, plan, text) {
  const direct = matchSegmentIndex(text);
  if (direct) return direct;
  let msgs = [];
  try { msgs = memory.listMessages(sessionId, 20); } catch (e) { msgs = []; }
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    if (String(m.text || '') === String(text || '')) continue; // 跳过当前句
    const idx = matchSegmentIndex(m.text);
    if (idx) return idx;
  }
  if (Number(plan.clipCount) === 1) return 1;
  return null;
}

// 某一段“当前提示词”的原文：
//   · 用户改过 → 覆盖文本原样返回（与 pipeline 的 promptSource=scene-card-user-edit 一致）；
//   · 没改过 → 用 promptComposer 按场景卡拼出来，ctx 与 pipeline._composeSceneCardPrompts 完全一致
//     （只有 theme，没有 userPrompt ——否则显示出来的不是真正会发出去的提示词）。
function promptTextOfSegment(plan, index, lang) {
  const override = plan.promptOverrides && plan.promptOverrides[String(index)];
  if (override) return { text: String(override), source: 'user-edit', card: null };
  const ids = Array.isArray(plan.sceneCardIds) ? plan.sceneCardIds : [];
  const cardId = ids[index];
  if (!cardId) return null;
  const card = sceneCardLibrary.getCardById(cardId);
  if (!card) return null;
  try {
    const patch = promptComposer.composeClipPatch(card, {
      theme: plan.theme || null,
      promptOverride: null,
      // 2026-11-19 英文界面零中文：英文会话看/改提示词时按同一 *_en 拼出，
      // 否则「show the prompt」贴出来的仍是中文提示词。lang 缺省行为与原来一致（中文）。
      lang
    });
    return { text: patch.prompt, source: 'scene-card', card };
  } catch (e) {
    return null;
  }
}

// A4：把第 N 段提示词原样贴出来。只读，不改计划、不建任务、不回传计划。
// 2026-11-18 修复：用户说「提示词看一下 / 看一下提示词」但**没说第几段**时，
// 旧实现只在 planEditBranch 里被调用且会回「要看第几段？」，更早的 classify 还会把
// 无段号的查看判成 unknown → 反问「这条视频要做多长？」。现在：
//   · memory.classify 已把「提示词 + 查看动词」归入 plan_edit；
//   · 有当前计划、无段号 → 直接展示全部（最多 5 段），不问时长、不新建计划；
//   · 无计划 → 明确说明还没有计划卡（负向用例）。
const PROMPT_VIEW_LIMIT = 5;
// 2026-11-21 用户反馈：「我问的是提示词，它给的是场景卡的内容」。
// 根因不在「拿错数据」——提示词本来就是按场景卡拼出来的，而是**展示层误导**：
//   ① 每段前面写着「来源：场景卡 X（按卡拼出）」，读起来像在列卡；
//   ② 没有提示底部还附了一整张计划摘要（含「场景：场景卡库随机抽取 N 个不同场景」），
//      于是 12 段计划看起来像「给我看了场景卡」。
// 修法：标题写清「这是第 k 段的**提示词原文**」（与场景卡清单区分），卡名只作括注；
// 并且**不在提示词视图后追加计划摘要**（要摘要说「计划里有什么」）。
const PROMPT_COUNT_ALL_LIMIT = 20;
const RE_ALL_PROMPTS = /全部|所有|每段|每一条|每一段|都\s*(?:要|给|看|贴|发)|完整|全文|\ball\b|\bevery\b|\beach\b/i;

function tryReplyPromptView(sessionId, text, lang) {
  const s = String(text || '');
  const isEn = i18n.normalizeLang(lang) === 'en';
  // 2026-11-21：判定改用 memory.isPromptViewRequest（与 classify 同源）。
  // 旧版只认本文件里那份窄词表（提示词 + 给我看/看一下…），
  // 「我要查看完整的全部12段12个场景的提示词」「提示词呢」全被判非查看 → 落到编辑反问。
  // 两道拦截保留：改提示词（改成/换成/：）不算查看；带「用这个：」正文的走替换。
  if (RE_PROMPT_SET_VERB.test(s)) return null;
  const isView = memory.isPromptViewRequest(s) || RE_PROMPT_VIEW.test(s);
  if (!isView) return null;
  if (extractUseThisText(s)) return null;
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return isEn
      ? 'There is no plan card yet, so there is no prompt to show. Tell me the total length (for example "30 seconds" or "10 minutes"), and I will lay out the plan first.'
      : '现在还没有计划卡，没有哪一段的提示词可看。先说总时长（比如「30 秒」「10 分钟」），我排好计划再贴给你。';
  }
  const off = planSceneCardsOffReply(plan);
  if (off) {
    return isEn
      ? 'This plan has scene cards turned off (free-form prompts), so per-clip prompts cannot be shown or edited here. To control clips individually, start a new plan with scene cards.'
      : off;
  }

  // 只有显式「第 N 段」才贴单段；否则展示全部/前 N 段（用户真实原话没有段号）。
  // 2026-11-21：用户说「全部 / 每段 / 都贴」时放宽到 20 段（12 段计划能一次全看到），
  // 否则维持既有 5 段（旧行为零回归；长片仍靠段号逐段看）。
  const explicit = matchSegmentIndex(s);
  if (!explicit) {
    const total = Number(plan.clipCount) || 0;
    const wantAll = RE_ALL_PROMPTS.test(s);
    const limit = Math.min(total, wantAll ? PROMPT_COUNT_ALL_LIMIT : PROMPT_VIEW_LIMIT);
    const parts = [];
    let missing = 0;
    for (let i = 1; i <= limit; i += 1) {
      const seg = promptTextOfSegment(plan, i - 1, lang);
      if (!seg) { missing += 1; continue; }
      // 英文界面的「来源」也用英文卡名（scene_key 只给中文界面）。
      const cardName = seg.card
        ? (isEn ? (seg.card.protagonist_en || seg.card.scene_key) : seg.card.scene_key)
        : '';
      // 2026-11-21：卡名降为**括注**，主角是「提示词原文」，避免被读成「列了一堆场景卡」。
      const from = seg.source === 'user-edit'
        ? '你手动改过'
        : `按场景卡「${cardName}」拼出`;
      parts.push(isEn
        ? `Clip ${i} prompt (${seg.text.length} chars${seg.source === 'user-edit' ? '; your edited text' : `; composed from card "${cardName}"`}):\n${seg.text}`
        : `第 ${i} 段提示词（${seg.text.length} 字；${from}）：\n${seg.text}`);
    }
    if (!parts.length) {
      return isEn
        ? 'The scene cards for this plan cannot be read (the card library may have changed), so the prompts cannot be shown. Nothing was changed.'
        : '这条计划的场景卡读不到（卡库可能被替换），提示词暂时贴不出来；计划没有改动。';
    }
    // 标题必须点名「提示词原文」，并说明「这不是场景卡清单」——
    // 场景卡清单的标题是「这条计划用了哪些场景卡」（show_scene_cards），两者别混。
    const header = isEn
      ? `Prompt text of this plan (${total} clips; showing ${limit}). This is the full text sent to the video model — `
        + 'not the scene-card list (for the list of cards, ask "which scene cards"). Read-only, nothing changed:'
      : `这是这条计划（共 ${total} 段）的**提示词原文**，也就是真正发给模型的文字（本次贴 ${limit} 段）；`
        + '不是场景卡清单（要看用了哪些卡，说「场景卡」）。只读，没有改动：';
    const more = total > limit
      ? (isEn
        ? `\n…… ${total - limit} more clips. Say "show the prompt for clip N" to see one, or "all prompts".`
        : `\n…… 其余 ${total - limit} 段：说「第 N 段的提示词」单独看，或说「全部提示词」。`)
      : '';
    const missingLine = missing
      ? (isEn ? `\n(${missing} clip prompt(s) could not be read.)` : `\n（有 ${missing} 段提示词读不到。）`)
      : '';
    const hint = isEn
      ? '\nNothing changed. To edit, say "change \'A\' to \'B\'", "remove \'C\'", or "use this: ...".'
      : '\n这条计划没有改动。要改就说「把『…』改成『…』」「去掉『…』」或「用这个：……」。';
    return header + '\n' + parts.join('\n\n') + missingLine + more + hint;
  }

  const n = explicit;
  if (n < 1 || n > plan.clipCount) {
    return isEn
      ? `This plan only has ${plan.clipCount} clips; there is no clip ${n}.`
      : `这条计划只有 ${plan.clipCount} 段，没有第 ${n} 段。`;
  }
  const seg = promptTextOfSegment(plan, n - 1, lang);
  if (!seg) {
    return isEn
      ? `The scene card for clip ${n} cannot be read (the card library may have changed), so this plan needs to be rebuilt. Nothing was changed.`
      : `第 ${n} 段的场景卡读不到（卡库可能被替换），这条计划得重排；现在什么都没改。`;
  }
  // 英文界面的「来源」也用英文卡名（scene_key 只给中文界面）。
  // 2026-11-21：卡名降为括注（同 tryReplyPromptView 的多段视图），主角是提示词原文。
  const cardName = seg.card
    ? (isEn ? (seg.card.protagonist_en || seg.card.scene_key) : seg.card.scene_key)
    : '';
  if (isEn) {
    const from = seg.source === 'user-edit'
      ? 'your edited text'
      : `composed from card "${cardName}"`;
    return `Prompt text of clip ${n} (${seg.text.length} chars; ${from}):\n${seg.text}\n`
      + 'Nothing was changed. To edit, say "change \'A\' to \'B\'", "remove \'C\'", or "use this: ...".';
  }
  const from = seg.source === 'user-edit' ? '你手动改过' : `按场景卡「${cardName}」拼出`;
  return `第 ${n} 段提示词原文（${seg.text.length} 字；${from}）：\n${seg.text}\n`
    + '这条计划没有改动。要改就说「把『…』改成『…』」「去掉『…』」或「用这个：……」。';
}

function parseDiffs(text) {
  const s = String(text || '');
  // 「第 N 段的提示词改成：…」= 整段替换（既有路径），不做 diff。
  if (RE_SEGMENT_INDEX.test(s) && /提示词|画面/.test(s)) return [];
  const hits = [];
  const collect = (re, kind) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const from = cleanEditPayload(m[1]);
      const to = kind === 'replace' ? cleanEditPayload(m[2]) : '';
      if (from) {
        hits.push({ kind, at: m.index, end: m.index + m[0].length, from, to });
      }
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  };
  collect(RE_DIFF_REPLACE, 'replace');
  collect(RE_DIFF_REMOVE, 'remove');
  hits.sort((a, b) => a.at - b.at);
  // 去重叠：先出现的优先（「把 X 改成 Y」里不会再被「去掉」二次匹配）
  const out = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.at < lastEnd) continue;
    if (h.kind === 'replace' && h.from === h.to) continue;
    out.push(h);
    lastEnd = h.end;
  }
  return out;
}

function planSceneCardsOffReply(plan) {  if (!plan || plan.sceneCards !== false) return null;
  return '这条计划关了场景卡（自由提示词），不支持按段看/改提示词；'
    + '想要逐段控制，请新排一条带场景卡的（不要说「不要场景卡」）。';
}

function writePromptOverride(sessionId, plan, index, payload) {
  const merged = { ...(plan.promptOverrides || {}), [String(index)]: payload };
  const norm = promptComposer.normalizePromptOverrides(merged, plan.clipCount);
  if (!norm.ok) return { ok: false, error: norm.error };
  plan.promptOverrides = Object.keys(norm.overrides).length ? norm.overrides : null;
  savePlanInPlace(sessionId, plan);
  return { ok: true, plan, warnings: norm.warnings || [] };
}

// A5：「用这个：…」→ 原样替换目标段提示词（不润色、不追加任何后缀）。
function applyUseThis(sessionId, plan, text, payload) {
  const off = planSceneCardsOffReply(plan);
  if (off) return off;
  const n = resolvePromptTarget(sessionId, plan, text);
  if (!n) return '这套文本要用在第几段？先说「第 2 段」，再说「用这个：……」；计划现在没有改动。';
  if (n < 1 || n > plan.clipCount) return `这条计划只有 ${plan.clipCount} 段，没有第 ${n} 段。`;
  const res = writePromptOverride(sessionId, plan, n - 1, payload);
  if (!res.ok) return `改第 ${n} 段提示词失败：${res.error}`;
  const len = plan.promptOverrides[String(n - 1)].length;
  const warn = res.warnings.length ? `（${res.warnings.join('；')}）` : '';
  return `已按你的文本替换第 ${n} 段（${len} 字）${warn}\n`
    + '其余段仍按场景卡；这条计划没有改动别的地方。';
}

// A6：「把 X 改成 Y / 去掉 Z」→ 按出现顺序逐处应用到该段**当前**提示词，只回改动点。
function applyDiffs(sessionId, plan, text, diffs) {
  const off = planSceneCardsOffReply(plan);
  if (off) return off;
  const n = resolvePromptTarget(sessionId, plan, text);
  if (!n) return '要改第几段？说「第 2 段：把『缓慢横移』改成『缓慢推近』」。';
  if (n < 1 || n > plan.clipCount) return `这条计划只有 ${plan.clipCount} 段，没有第 ${n} 段。`;
  const seg = promptTextOfSegment(plan, n - 1);
  if (!seg) return `第 ${n} 段的场景卡读不到（卡库可能被替换），这条计划得重排；现在什么都没改。`;
  let out = seg.text;
  const applied = [];
  const missed = [];
  for (const d of diffs) {
    if (d.kind === 'replace') {
      if (!out.includes(d.from)) { missed.push(`「${d.from}」`); continue; }
      out = out.split(d.from).join(d.to);
      applied.push(`「${d.from}」→「${d.to}」`);
    } else {
      if (!out.includes(d.from)) { missed.push(`「${d.from}」`); continue; }
      out = out.split(d.from).join('');
      applied.push(`去掉「${d.from}」`);
    }
  }
  if (!applied.length) {
    return `没在这段的提示词里找到要改的文字：${missed.join('、')}。`
      + `第 ${n} 段当前提示词 ${seg.text.length} 字；说「把第 ${n} 段的提示词给我看一下」可以先核对原文。`;
  }
  const res = writePromptOverride(sessionId, plan, n - 1, out);
  if (!res.ok) return `改第 ${n} 段提示词失败：${res.error}`;
  const now = plan.promptOverrides[String(n - 1)];
  const warn = res.warnings.length ? `\n（${res.warnings.join('；')}）` : '';
  const missLine = missed.length ? `\n没找到、未改动：${missed.join('、')}` : '';
  return `已改第 ${n} 段（${applied.length} 处）：\n${applied.map((x) => '· ' + x).join('\n')}\n`
    + `当前提示词（${now.length} 字）：${now}${warn}${missLine}`;
}

function replyForPlanEdit(sessionId, text, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  // 2026-11-21（用户报「我说看一下提示词，它给的是场景卡的内容」）：
  // 纯查看句（「看一下提示词 / 我要查看完整的全部12段12个场景的提示词」）在 classify 里是 plan_edit，
  // 但入口原来直接进本函数 → 落到「要换第几段？」的编辑反问，提示词一句没贴。
  // 这里先走只读视图（与 handleMessage 同一入口 tryReplyPromptView，幂等只读，
  // 内含「改成/换成」拦截，不会抢编辑动作）。
  try {
    const viewed = tryReplyPromptView(sessionId, text, lang);
    if (viewed) return viewed;
  } catch (e) { /* 视图失败继续走编辑路径（行为不倒退） */ }
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return isEn
      ? 'There is no plan card yet, so there is no clip to edit. Tell me the total length (for example "30 seconds" or "10 minutes"); once the plan exists you can change a clip.'
      : '现在还没有计划卡，所以没有哪一段可改。先说总时长（比如「30 秒」「10 分钟」），'
        + '我排好计划你再改第几段。';
  }
  // 2026-11-17 V1（A5）：用户自带文本「用这个：…」→ 原样替换目标段（Q9=A，不润色、不加后缀）。
  const useThis = extractUseThisText(text);
  if (useThis) return applyUseThis(sessionId, plan, text, useThis);
  // 2026-11-17 V1（A6）：「把 X 改成 Y / 去掉 Z」→ 按出现顺序逐处应用，只回改动点（Q10=B）。
  const diffs = parseDiffs(text);
  if (diffs.length) return applyDiffs(sessionId, plan, text, diffs);
  const m = String(text || '').match(RE_SEGMENT_INDEX);
  const batch = memory.isBatchSceneEdit(text);
  if (!m) {
    // 2026-11-16 用户反馈：看完整批卡后说「三个都想换掉」→ 整批换，不要重排计划。
    if (batch) return replyForBatchSwap(sessionId, plan, lang);
    // 2026-11-16 Lead 复核：用户指代卡片（「这个地方的换一个」/「这一段不想要」）时没有段号，
    // 直接告诉他怎么补段号；不要掉回「这条视频要做多长」。
    // 2026-11-17 V1（A1/A2）：这里同时承担「场景/场景卡 + 换/改/不满意」的兜底，
    // 顺带说明「换卡 vs 改提示词」的区别（A2 的验收点）。
    return isEn
      ? 'Which clip should change? Say "swap clip 2"; to edit a prompt say "change clip 2 prompt to: ...", '
        + 'or say "show the prompt for clip 2" first and then "use this: ..." / "change A to B".'
      : '要换第几段？说「第 2 段换一个」；改提示词就说「第 2 段提示词改成：……」，'
        + '或者「把第 2 段的提示词给我看一下」再「用这个：……」/「把『A』改成『B』」。';
  }
  const n = planCard.parseCnNumber(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > plan.clipCount) {
    return isEn
      ? `This plan only has ${plan.clipCount} clips; there is no clip ${m[1]}.`
      : `这条计划只有 ${plan.clipCount} 段，没有第 ${m[1]} 段。`;
  }
  if (plan.sceneCards === false) {
    return isEn
      ? 'This plan has scene cards turned off (free-form prompts), so per-clip card swaps or prompt edits are not supported here. To control clips individually, start a new plan with scene cards.'
      : '这条计划关了场景卡（自由提示词），不支持按段换卡/改提示词；'
        + '想要逐段控制，请新排一条带场景卡的（不要说「不要场景卡」）。';
  }
  const index = n - 1;
  const payload = extractPromptEditText(text);
  const promptHint = /提示词|画面/.test(text);
  const vague = !payload || RE_VAGUE_PAYLOAD.test(payload);
  if (promptHint && vague) {
    return isEn
      ? `What should clip ${n} become? Say "change clip ${n} prompt to: ..." (up to ${promptComposer.MAX_PROMPT_OVERRIDE_CHARS} characters per clip).`
      : `第 ${n} 段要改成什么？直接说「第 ${n} 段提示词改成：……」（每段最多 `
        + `${promptComposer.MAX_PROMPT_OVERRIDE_CHARS} 字）。`;
  }
  // 判定顺序（写死，测试按这两条断言）：
  //   1) 给了具体正文（且不是「换成别的」这类空指代）→ 改提示词；
  //   2) 其余（换一个 / 换成别的 / 不想要）→ 换场景卡。
  if (!vague) {
    const merged = { ...(plan.promptOverrides || {}), [String(index)]: payload };
    const norm = promptComposer.normalizePromptOverrides(merged, plan.clipCount);
    if (!norm.ok) return `改第 ${n} 段提示词失败：${norm.error}`;
    plan.promptOverrides = Object.keys(norm.overrides).length ? norm.overrides : null;
    savePlanInPlace(sessionId, plan);
    const len = plan.promptOverrides[String(index)].length;
    const warn = (norm.warnings || []).length ? `；${norm.warnings.join('；')}` : '';
    return `已改第 ${n} 段提示词（${len} 字），其余段仍按场景卡${warn}\n${describeReply(plan)}`;
  }

  // ---- 换第 N 段场景卡：只改 sceneCardIds[N-1]，planId 不变 ----
  const currentIds = (Array.isArray(plan.sceneCardIds) && plan.sceneCardIds.length === plan.clipCount)
    ? plan.sceneCardIds.slice()
    : planSceneEntries(plan).map((e) => e.id);
  const oldId = currentIds[index];
  const oldCard = sceneCardLibrary.getCardById(oldId);
  let next;
  try {
    next = sceneCardLibrary.nextSwapCandidate(oldId, currentIds);
  } catch (e) {
    return `换第 ${n} 段失败：${(e && e.message) || e}`;
  }
  const nextCard = sceneCardLibrary.getCardById(next.id);
  plan.sceneCardIds = currentIds;
  plan.sceneCardIds[index] = next.id;
  savePlanInPlace(sessionId, plan);
  const fromKey = oldCard
    ? (isEn ? (oldCard.protagonist_en || oldCard.scene_key) : oldCard.scene_key)
    : oldId;
  const toKey = nextCard
    ? (isEn ? (nextCard.protagonist_en || nextCard.scene_key) : nextCard.scene_key)
    : next.id;
  const chapterSeq = nextCard && Number.isInteger(nextCard.chapter) && Number.isInteger(nextCard.sequence)
    ? (isEn ? ` (ch. ${nextCard.chapter}-${nextCard.sequence})` : `（第 ${nextCard.chapter} 章-${nextCard.sequence}）`)
    : '';
  if (isEn) {
    return `Swapped clip ${n}: ${fromKey} → ${toKey}${chapterSeq}\n`
      + `Current ${plan.clipCount} scene cards:\n${formatSceneEntries(planSceneEntries(plan), 'en')}\n`
      + describeReply(plan, 'en');
  }
  return `已换第 ${n} 段：${fromKey} → ${toKey}${chapterSeq}\n`
    + `当前 ${plan.clipCount} 张场景卡：\n${formatSceneEntries(planSceneEntries(plan), 'zh')}\n`
    + describeReply(plan);
}

// 2026-11-16 用户反馈（截图实证）：3 段计划看完卡后说「三个都想换掉」→ 原实现掉进 create 续问，
// 重排了一条新计划（回复「我按 30 秒排好了」）。这里改成**整批换卡**：
//   · planId 不变、不建任务、不重新 allocate；
//   · 逐段取「下一张未用过」的候选（与单段换卡同一规则），批内不重复；
//   · 任何一段取不到（卡库耗尽）就整批放弃、计划保持原样，不留下换了一半的状态。
function replyForBatchSwap(sessionId, plan, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  if (plan.sceneCards === false) {
    return isEn
      ? 'This plan has scene cards turned off (free-form prompts), so there are no cards to swap. To use the card library, start a new plan with scene cards.'
      : '这条计划关了场景卡（自由提示词），没有可换的卡；'
        + '想要逐段控制，请新排一条带场景卡的（不要说「不要场景卡」）。';
  }
  const currentIds = (Array.isArray(plan.sceneCardIds) && plan.sceneCardIds.length === plan.clipCount)
    ? plan.sceneCardIds.slice()
    : planSceneEntries(plan).map((e) => e.id);
  if (!currentIds.length) {
    return isEn
      ? 'This plan has no scene cards yet, so there is nothing to swap as a batch. Check that scene cards are on.'
      : '这条计划还没有场景卡，没法整批换；先确认场景卡是开着的。';
  }
  const used = new Set(currentIds);
  const nextIds = currentIds.slice();
  const changes = [];
  for (let i = 0; i < currentIds.length; i += 1) {
    const oldId = currentIds[i];
    const oldCard = sceneCardLibrary.getCardById(oldId);
    let next;
    try {
      next = sceneCardLibrary.nextSwapCandidate(oldId, [...used]);
    } catch (e) {
      return isEn
        ? `Batch swap failed at clip ${i + 1}: ${(e && e.message) || e}. The plan was not changed.`
        : `整批换卡失败（第 ${i + 1} 段）：${(e && e.message) || e}；计划没有改动。`;
    }
    const nextCard = sceneCardLibrary.getCardById(next.id);
    nextIds[i] = next.id;
    used.add(next.id);
    const fromKey = oldCard
      ? (isEn ? (oldCard.protagonist_en || oldCard.scene_key) : oldCard.scene_key)
      : oldId;
    const toKey = nextCard
      ? (isEn ? (nextCard.protagonist_en || nextCard.scene_key) : nextCard.scene_key)
      : next.id;
    const chapterSeq = nextCard && Number.isInteger(nextCard.chapter) && Number.isInteger(nextCard.sequence)
      ? (isEn ? ` (ch. ${nextCard.chapter}-${nextCard.sequence})` : `（第 ${nextCard.chapter} 章-${nextCard.sequence}）`)
      : '';
    changes.push(isEn
      ? `#${i + 1} ${fromKey} → ${toKey}${chapterSeq}`
      : `#${i + 1} ${fromKey} → ${toKey}${chapterSeq}`);
  }
  plan.sceneCardIds = nextIds;
  savePlanInPlace(sessionId, plan);
  const shown = changes.slice(0, SCENE_PREVIEW_LIMIT);
  if (changes.length > shown.length) {
    shown.push(isEn ? `… ${changes.length} clips in total; the rest were swapped the same way.` : `…… 共 ${changes.length} 段，其余同样换了。`);
  }
  if (isEn) {
    return `Swapped all ${nextIds.length} clips:\n${shown.join('\n')}\n`
      + `Current ${plan.clipCount} scene cards:\n${formatSceneEntries(planSceneEntries(plan), 'en')}\n`
      + describeReply(plan, 'en');
  }
  return `已换掉全部 ${nextIds.length} 段：\n${shown.join('\n')}\n`
    + `当前 ${plan.clipCount} 张场景卡：\n${formatSceneEntries(planSceneEntries(plan), 'zh')}\n`
    + describeReply(plan);
}

// ==========================================
// P7-A：配乐（列素材库 / 用第 N 首 / 换一首 / 不要配乐 / 设为默认）
// ------------------------------------------------------------
// · 读库走进程内 audioMixer（不走 HTTP、不混音、不产生费用）；
// · 「用第 N 首」的编号上下文存进 plan.bgmChoices（持久化在会话里，重启不丢），
//   不用进程内存 Map；
// · 写全局默认只走 audioMixer.savePrefs，写前用 findTrack 校验存在；
// · 不做已提交任务的重新混音（P7-C 范围）。
// ==========================================
const RE_BGM_INDEX = /第\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*首/;

// 2026-11-19 S3：英文配乐工具（list/pick/next/off 行为与中文路径一致，只是话术全英文）
function replyForBgmEn(sessionId, action, index) {
  const plan = memory.lastPlan(sessionId);
  const lib = bgmLibrary();
  const tracks = lib.tracks;
  if (!tracks.length) return 'The BGM library is empty. Add a track in Settings / Editor first.';
  let orderIds = (plan && Array.isArray(plan.bgmChoices) && plan.bgmChoices.length)
    ? plan.bgmChoices.filter((id) => lib.byId.has(id))
    : [];
  if (!orderIds.length) orderIds = tracks.map((t) => t.id);
  const ordered = orderIds.map((id) => lib.byId.get(id)).filter(Boolean);
  if (action === 'list') {
    if (plan) { plan.bgmChoices = orderIds; savePlanInPlace(sessionId, plan); }
    const head = plan
      ? `Library has ${ordered.length} tracks (numbers are saved on this plan — say "use track 3"):`
      : `Library has ${ordered.length} tracks (no plan yet; tell me a total length first, then say "use track 3"):`;
    const body = ordered.map((t, i) => {
      const dur = Number(t.durationSec) > 0 ? `${Math.round(Number(t.durationSec))} s` : 'unknown length';
      return `${i + 1}. ${t.title || t.id} (${t.id}, ${t.category || 'music'}, ${dur})`;
    }).join('\n');
    return `${head}\n${body}` + (plan ? `\nCurrent BGM: ${bgmLabelEn(plan)}` : '');
  }
  if (action === 'off') {
    if (!plan) return 'No plan card yet: tell me the total length first, then say "no background music".';
    plan.bgm = { enabled: false, mode: 'off' };
    plan.bgmChoices = orderIds;
    savePlanInPlace(sessionId, plan);
    return `Background music is off for this plan.\n${describeReply(plan, 'en')}`;
  }
  if (!plan) return 'No plan card yet: tell me the total length first, then pick a track.';
  let track = null;
  if (action === 'pick') {
    const n = Number(index);
    if (!Number.isInteger(n) || n < 1 || n > ordered.length) {
      return `The library has ${ordered.length} track(s); there is no track ${index}. Say "list BGM" to see the numbers.`;
    }
    track = ordered[n - 1];
  } else {
    const curId = plan.bgm && plan.bgm.trackId ? plan.bgm.trackId : null;
    const curIdx = curId ? ordered.findIndex((t) => t.id === curId) : -1;
    track = ordered[(curIdx + 1) % ordered.length] || null;
  }
  if (!track) return 'Could not work out which track you meant. Say "list BGM" to see the numbers.';
  plan.bgm = { enabled: true, mode: 'manual', trackId: track.id };
  plan.bgmChoices = orderIds;
  savePlanInPlace(sessionId, plan);
  const pos = ordered.indexOf(track) + 1;
  return `BGM set: #${pos} "${track.title || track.id}" (${track.id}). `
    + `It will be used when you confirm.\n${describeReply(plan, 'en')}`;
}

function replyForBgm(sessionId, text) {
  const plan = memory.lastPlan(sessionId);
  const lib = bgmLibrary();
  const tracks = lib.tracks;
  if (!tracks.length) return '配乐素材库是空的，先去设置页/剪辑台传一首再让我配乐。';
  // 编号上下文：优先用这条计划上次列出的顺序（1-based 编号与它对齐）。
  let orderIds = (plan && Array.isArray(plan.bgmChoices) && plan.bgmChoices.length)
    ? plan.bgmChoices.filter((id) => lib.byId.has(id))
    : [];
  if (!orderIds.length) orderIds = tracks.map((t) => t.id);
  const orderedTracks = orderIds.map((id) => lib.byId.get(id)).filter(Boolean);
  const nMatch = String(text || '').match(RE_BGM_INDEX);
  const n = nMatch ? planCard.parseCnNumber(nMatch[1]) : null;
  if (nMatch && (!Number.isInteger(n) || n < 1 || n > orderedTracks.length)) {
    return `素材库只有 ${orderedTracks.length} 首，没有第 ${nMatch[1]} 首。说「配乐有哪些」看编号。`;
  }
  const pick = (Number.isInteger(n) && n >= 1) ? orderedTracks[n - 1] : null;
  // 按曲名/曲目 id 匹配（例：「配乐换成 Morning」）
  const named = orderedTracks.find((t) => t && (
    (t.title && String(t.title).length >= 2 && String(text).includes(String(t.title)))
    || (t.id && String(text).includes(String(t.id)))
  )) || null;

  // 1) 设为默认（全局默认；不是只改这一条计划）
  if (/默认/.test(text)) {
    const target = pick || named
      || (plan && plan.bgm && plan.bgm.trackId ? (bgmFindTrack(plan.bgm.trackId) || {}).track : null);
    if (!target) {
      return '没认出要设为默认的是哪一首：先说「配乐有哪些」看编号，或说「把第 3 首设为默认配乐」。';
    }
    if (!bgmFindTrack(target.id)) {
      return `设为默认失败：素材库里没有 ${target.id}。`;
    }
    try {
      audioMixer.savePrefs({ defaultTrackId: target.id });
    } catch (e) {
      return `设为默认失败：${(e && e.message) || e}`;
    }
    const saved = audioMixer.getPrefs().defaultTrackId;
    if (saved !== target.id) {
      return `设为默认失败：写入后读回不一致（当前 ${saved || '(空)'}）。`;
    }
    return `已改默认配乐：《${target.title || target.id}》（${target.id}）——`
      + '之后新计划用「自动」配乐时都会以它作为开场曲。';
  }

  // 2) 不要配乐（写进计划，执行时整片不混音）
  if (/不要配乐|不配乐|关掉配乐|关闭配乐|取消配乐|去掉配乐|静音|不要音乐/.test(text)) {
    if (!plan) {
      return '现在还没有计划卡：先说总时长（比如「10 分钟」）排好计划，再说「不要配乐」。';
    }
    plan.bgm = { enabled: false, mode: 'off' };
    plan.bgmChoices = orderIds;
    savePlanInPlace(sessionId, plan);
    return `已关掉配乐：这条计划不混配乐。\n${describeReply(plan)}`;
  }

  // 3) 选曲 / 换一首
  const wantsNext = /换一首|换首|换一曲|再来一首|换掉|换个/.test(text);
  const selectionVerb = /换成|改用|选用|用|选|要|放|听/.test(text);
  if (nMatch || named || wantsNext || (selectionVerb && /配乐|音乐|曲/.test(text))) {
    if (!plan) {
      return '现在还没有计划卡：先说总时长（比如「10 分钟」）排好计划，再说「用第 3 首」。';
    }
    let track = pick || named || null;
    if (!track && wantsNext) {
      const curId = plan.bgm && plan.bgm.trackId ? plan.bgm.trackId : null;
      const curIdx = curId ? orderedTracks.findIndex((t) => t.id === curId) : -1;
      track = orderedTracks[(curIdx + 1) % orderedTracks.length] || null;
    }
    if (!track) {
      return '没认出要哪一首：说「配乐有哪些」看编号，或说「用第 3 首」；'
        + '也可以直接说曲名（例如「配乐换成 Morning」）。';
    }
    plan.bgm = { enabled: true, mode: 'manual', trackId: track.id };
    plan.bgmChoices = orderIds;
    savePlanInPlace(sessionId, plan);
    const pos = orderedTracks.indexOf(track) + 1;
    return `已选配乐：第 ${pos} 首《${track.title || track.id}》（${track.id}）。`
      + `确认执行时会用它。\n${describeReply(plan)}`;
  }

  // 4) 列出素材库（编号、曲名、类别 music/ambient、时长）
  if (plan) {
    plan.bgmChoices = orderIds;
    savePlanInPlace(sessionId, plan);
  }
  const lines = orderedTracks.map((t, i) => {
    const dur = Number(t.durationSec) > 0 ? `${Math.round(Number(t.durationSec))} 秒` : '时长未知';
    return `${i + 1}. ${t.title || t.id}（${t.id}，${t.category || 'music'}，${dur}）`;
  });
  const head = plan
    ? `素材库 ${orderedTracks.length} 首（编号记在这条计划里，直接说「用第 3 首」）：`
    : `素材库 ${orderedTracks.length} 首（还没有计划卡；先说总时长，再说「用第 3 首」）：`;
  return `${head}\n${lines.join('\n')}` + (plan ? `\n当前配乐：${bgmLabel(plan)}` : '');
}

// 「用这个：……」/「把 X 改成 Y / 去掉 Z」是**计划内**提示词编辑形态。
// 刻意不在 memory.classify 里提升成全局意图：memory 是上下文无关的，
// 把这两类口语加成全局 plan_edit 会抢走「把默认通道改成百炼」这类设置句（V2 才做）。
// 这里由会话层兜底：只有 classify 给出 unknown/create（不是 bgm/查场景/确认等更明确的意图）时才改判。
// 两类必须挡在外面（否则会把更明确的意图抢成 plan_edit）：
//   ① 关开关句：不要场景卡 / 不要配乐 / 取消出图（「不要配乐」里的「不要」会被 diff 正则当删除）；
//   ② 设置类：通道 / 设置 / 分辨率（V2 的 B6，V1 不处理）。
function isPlanPromptEditForm(text) {
  const s = String(text || '');
  // 2026-11-17 V1 遗留 ⑤：关开关句（含「去掉场景卡 / 场景卡不要了」两种语序）不能进 diff。
  if (memory.isSceneCardsOff(s)) return false;
  if (/(?:不用|不要|关闭|别用|取消|去掉|删掉)\s*(?:了)?\s*(?:配乐|音乐|出图|图片)/.test(s)) return false;
  if (/(?:配乐|音乐|出图|图片)\s*(?:不要了?|不用了?|关闭|关掉|取消|去掉|删掉)/.test(s)) return false;
  if (/通道|设置|分辨率|\b1080p\b|\b720p\b|\b4k\b/i.test(s)) return false;
  return !!extractUseThisText(s) || parseDiffs(s).length > 0;
}

/**
 * 对话入口：听懂 → 排计划 / 检索记录 / 报进度。不创建任务、不发付费请求。
 * @param {object} opts { sessionId?, text, options? }
 */
// 2026-11-18：英文界面下常见 PLAN_* 错误也要英文（用户报「十秒 每段5秒」仍回中文）。
// 中文路径逐字返回 planCard 原文（零回归）；未覆盖的 code 保留中文原文（如实，不机翻）。
function planFailureReply(built, lang, input, parsed) {
  if (i18n.normalizeLang(lang) !== 'en') return built.error;
  const en = planCard.describeErrorEn(built.code, { input, parsed });
  return en || built.error;
}

// ==========================================
// 2026-11-19 B 目标第二刀：把「排计划 / 上次计划续问」抽成可复用的一步。
// handleMessage 的 create/unknown 分支与 agent 工具门面都走这里，行为逐字不变。
// opts:
//   intentUnknown  —— 规则层判成 unknown 时才有「听不懂先反问」的护栏
//   sceneCardsOff  —— 关场景卡句不当作续问
//   forceFollow    —— 强制按上次计划续问（agent 的 edit_plan 用）
//   input          —— 显式槽位（agent 的 plan_video 用；给了就不再解析 text 的槽位）
// ==========================================
function planTurn(sessionId, text, lang, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const last = memory.lastPlan(sessionId);
  const parsed = planCard.parseUtterance(text);
  const slotOnly = parsed.totalMinutes === null && parsed.clipCount === null
    && (parsed.resolution !== null || parsed.clipDurationSec !== null || parsed.model !== null);
  const follow = o.forceFollow !== undefined
    ? !!o.forceFollow
    : (!o.sceneCardsOff && last && (isFollowUp(text) || isRepeat(text) || slotOnly));
  const hasSlot = slotOnly
    || parsed.totalMinutes !== null || parsed.clipCount !== null
    || parsed.resolution !== null || parsed.clipDurationSec !== null
    || parsed.model !== null || parsed.sceneCards !== null;
  if (o.intentUnknown && !hasSlot && !follow) {
    return {
      reply: replyUnknown(lang, !!last),
      replyKey: 'assistant.reply.unknown',
      plan: null, missing: null, actions: null
    };
  }
  let input = o.input ? { ...o.input, text, sessionId } : { text, sessionId };
  if (!o.input) {
    if (follow) {
      input = { ...inputFromLast(last, parsed, text), sessionId };
    } else {
      input.totalMinutes = parsed.totalMinutes !== null ? parsed.totalMinutes : undefined;
      input.clipDurationSec = parsed.clipDurationSec !== null ? parsed.clipDurationSec : undefined;
      input.clipCount = parsed.clipCount !== null ? parsed.clipCount : undefined;
      input.resolution = parsed.resolution || undefined;
      input.model = parsed.model || undefined;
      // 主题词不进入计划：长片按场景卡库自动抽取不同场景（2026-11-16 用户口径）。
      input.sceneCards = parsed.sceneCards !== null ? parsed.sceneCards : undefined;
    }
  }
  input.sessionId = sessionId;
  const built = planCard.buildPlan(input);
  const isEn = lang === 'en';
  if (!built.ok) {
    if (built.missing || built.code === 'PLAN_NEED_DURATION') {
      return {
        reply: planFailureReply(built, lang, input, parsed),
        replyKey: 'assistant.question.duration',
        plan: null,
        missing: built.missing || ['totalMinutes'],
        actions: [{ type: 'answer', labelKey: 'assistant.action.giveDuration' }]
      };
    }
    if (o.intentUnknown) {
      return {
        reply: replyUnknown(lang, !!last) + (isEn ? '' : '\n（' + built.error + '）'),
        replyKey: 'assistant.reply.unknown',
        plan: null, missing: null, actions: null
      };
    }
    return {
      reply: planFailureReply(built, lang, input, parsed),
      replyKey: 'assistant.reply.planError',
      plan: null, missing: null, actions: null
    };
  }
  const plan = built.plan;
  planCache.set(plan.planId, plan);
  memory.addPlan(sessionId, plan);
  return {
    reply: replyForPlan(plan, lang),
    replyKey: 'assistant.reply.plan',
    plan,
    missing: null,
    actions: [{ type: 'confirm', labelKey: 'assistant.action.confirmExecute', requiresApproval: true }]
  };
}

function handleMessage(opts = {}) {
  const text = String(opts.text || '').trim();
  // P3：助手话术语言（默认 zh → 现有中文回复逐字不变；en → 核心链路走英文模板）
  const lang = i18n.resolveLang(opts.lang);
  if (!text) return { ok: false, code: 'ASSISTANT_EMPTY_TEXT', error: '说点什么吧', lang };
  const session = memory.getOrCreate(opts.sessionId);
  const sessionId = session.id;
  memory.appendMessage(sessionId, { role: 'user', text });

  const intent = memory.classify(text);
  // 2026-11-19 D1：纯分辨率槽位句（「1080p」「改成 1080p」）的意图是 plan_edit，
  // 但执行语义是**按上次计划续问**（与既有 buildPlan 续问路径一致），不能进「按段编辑」——
  // 否则会回「要换第几段？」。这里只把它排除出 planEditBranch，让它落到下面的
  // 续问/问时长分支（行为与 D1 之前完全一致，只把意图标签从 unknown 纠正为 plan_edit）。
  const slotOnlyEdit = intent.intent === 'plan_edit' && intent.reason === 'slot_only';
  // 2026-11-17 V1（A5/A6）：口语形态兜底（见 isPlanPromptEditForm 的注释）。
  const promptEditForm = isPlanPromptEditForm(text);
  // 2026-11-17 V1 遗留 ⑤：关场景卡句（「去掉场景卡 / 场景卡不要了」）不是续问，
  // 不能被 isFollowUp 的「去掉」带进「按上次参数重排一条新计划」；与「不要场景卡」同一路径。
  const sceneCardsOff = memory.isSceneCardsOff(text);
  const planEditBranch = (intent.intent === 'plan_edit' && !slotOnlyEdit)
    || (promptEditForm && (intent.intent === 'unknown' || intent.intent === 'create'));
  const reportedIntent = planEditBranch ? 'plan_edit' : intent.intent;
  const userId = opts.userId ? String(opts.userId) : 'local';
  let reply;
  let plan = null;
  let missing = null;
  let refs = null;
  let pendingChange = null;
  let diagnosis = null;
  let preferencesView = null;
  // P3：结构化话术 key（加法式）——前端可据此本地化/追踪；中文 reply 原文不依赖它。
  let replyKey = null;
  let actions = null;

  if (intent.intent === 'greeting') {
    reply = replyForGreeting(lang);
    replyKey = 'assistant.reply.greeting';
  } else if (intent.intent === 'status') {
    // 2026-11-23：把原话传进去——「上一次的任务…」要优先答那条任务，而不是「现在有什么在跑」。
    reply = replyForStatus(sessionId, lang, text);
    replyKey = 'assistant.reply.status';
  } else if (intent.intent === 'plan_scenes') {
    // 2026-11-16 用户问题 a：问「选了哪几个场景」→ 只读预览，不重排计划、不占卡。
    reply = replyForPlanScenes(sessionId, lang);
    replyKey = 'assistant.reply.planScenes';
  } else if (intent.intent === 'no_image') {
    // 2026-11-16 用户问题 b：要纯文生视频 → 告诉用户卡上的开关位置，不新建计划。
    reply = replyForNoImage(sessionId);
    replyKey = 'assistant.reply.noImage';
  } else if (intent.intent === 'confirm') {
    // 2026-11-17 V1（§9.1-6 / A7）：最终确认时点 —— 只回确认语 + 回传计划（前端给卡片）。
    // 这里**不建任务**：建任务只能走 execute()，而 execute 只由卡片「确认执行」触发。
    reply = replyForConfirm(sessionId, lang);
    replyKey = 'assistant.reply.confirm';
    plan = memory.lastPlan(sessionId);
    actions = [{ type: 'confirm', labelKey: 'assistant.action.confirmExecute', requiresApproval: true }];
  } else if (intent.intent === 'repair') {
    // 2026-11-17 V2（B2/B3）：失败诊断 + 修复建议。只读，不自动重跑。
    const r = replyForRepair(sessionId, lang);
    reply = r.reply;
    replyKey = 'assistant.reply.repair';
    diagnosis = r.diagnosis;
  } else if (intent.intent === 'settings') {
    // 2026-11-17 V2（B6）：设置变更（L3）→ 只返回 pendingChange，确认前什么都不改。
    const r = replyForSettings(sessionId, text, lang);
    reply = r.reply;
    replyKey = 'assistant.reply.settings';
    pendingChange = r.pending;
  } else if (intent.intent === 'prefs') {
    // 2026-11-17 V2（B7）：读跨会话偏好（服务端用户级，换会话仍在）。
    const r = replyForPrefs(sessionId, { userId, lang });
    reply = r.reply;
    replyKey = 'assistant.reply.prefs';
    preferencesView = r.preferences;
  } else if (intent.intent === 'assets') {
    // 2026-11-17 V2（B5）：素材库存（与 /api/photos 同口径）。
    reply = replyForAssets(sessionId, lang);
    replyKey = 'assistant.reply.assets';
  } else if (intent.intent === 'context') {
    // 2026-11-17 V1（§9.1-7）/ V2（B4）：只读环境问答；不改计划、不回传计划。
    reply = replyForContext(sessionId, { userId, lang });
    replyKey = 'assistant.reply.context';
  } else if (planEditBranch) {
    // 2026-11-16 P7-A：换单段场景卡 / 改单段提示词 —— 只改计划，不建任务。
    // 2026-11-17 V1（A4）：先看是不是「把第 N 段的提示词给我看」这种**纯只读**请求；
    // 是的话只贴原文、计划一个字节都不动，也不回传计划（前端据此不弹卡）。
    const viewed = tryReplyPromptView(sessionId, text, lang);
    if (viewed) {
      reply = viewed;
      replyKey = 'assistant.reply.promptView';
    } else {
      reply = replyForPlanEdit(sessionId, text, lang);
      replyKey = 'assistant.reply.planEdit';
      // 2026-11-16 Lead 复核：把更新后的计划一并回传（planId 不变）。
      // 前端 sendXiaozhi 里的 `if (j.plan) setPlan(j.plan)` 依赖它刷新手上的计划卡；
      // 只回 null 时卡片仍是旧对象，用户会觉得「换了但没反应」。
      plan = memory.lastPlan(sessionId);
    }
  } else if (intent.intent === 'bgm') {
    // 2026-11-16 P7-A：配乐 —— 列库 / 选曲 / 关掉 / 设默认。
    reply = replyForBgm(sessionId, text);
    replyKey = 'assistant.reply.bgm';
    // 同上：选曲/关掉配乐后回传更新后的计划（planId 不变；无计划时仍是 null）。
    plan = memory.lastPlan(sessionId);
  } else if (intent.intent === 'last') {
    const res = retrieveRefs(text, 3);
    refs = res.refs;
    reply = replyForLast(text, lang);
    replyKey = 'assistant.reply.last';
  } else {
    // create / unknown 都尝试排计划；听不懂时 buildPlan 会返回明确的追问。
    // 2026-11-19：这段抽进 planTurn（与 agent 工具门面共用），行为逐字不变。
    const res = planTurn(sessionId, text, lang, {
      intentUnknown: intent.intent === 'unknown',
      sceneCardsOff
    });
    reply = res.reply;
    replyKey = res.replyKey;
    plan = res.plan;
    missing = res.missing;
    actions = res.actions;
  }

  memory.appendMessage(sessionId, { role: 'assistant', text: reply, kind: plan ? 'plan' : 'chat' });
  return {
    ok: true,
    version: SUPERVISOR_VERSION,
    sessionId,
    intent: reportedIntent,
    reply,
    // P3 加法式：话术语言 + 结构化 key/actions（中文 reply 原文不依赖这些字段）
    lang,
    replyKey,
    actions,
    plan: plan ? briefPlan(plan) : null,
    missing,
    refs,
    canExecute: !!plan,
    // 2026-11-17 V2：以下字段只在前端要用时才有值（不影响 V1 既有调用方）。
    pendingChange,          // B6：设置变更待确认项（changeId + label + requiresConfirm）
    diagnosis,              // B2：失败诊断（reasons + suggestions）
    preferences: preferencesView // B7：跨会话偏好摘要
  };
}

function makeFingerprint(plan, gradeMode) {
  return submitGuard.fingerprint(submitGuard.build({
    model: plan.model,
    resolution: plan.resolution,
    clipDuration: plan.clipDurationSec,
    clips: plan.clipCount,
    prompts: [plan.userPrompt || plan.text || plan.themeLabel || '小智计划'],
    preset: 'final',
    sourcePhotoId: '',
    photoIds: [],
    transition: { enabled: true, duration: 0.4, type: 'fade' },
    colorMatch: null,
    imageGrade: gradeMode || ''
  }));
}

/**
 * 确认并执行计划卡。
 * @param {object} opts { sessionId, planId?, approved?, force?, options? }
 */
function execute(opts = {}) {
  // P3：话术/任务语言。outputLang 优先（AI 输出语言 aiLang），否则用界面语言。
  const lang = i18n.resolveLang(opts.outputLang || opts.lang);
  const isEn = lang === 'en';
  const taskLang = i18n.resolveLang(opts.lang || opts.outputLang);
  const sessionId = opts.sessionId;
  if (!sessionId || !memory.getSession(sessionId)) {
    return { ok: false, code: 'ASSISTANT_BAD_SESSION', error: '没有这个会话，请先聊一句', ...i18n.mark('api.assistant.badSession'), lang };
  }
  const plan = (opts.planId && memory.getPlan(sessionId, opts.planId))
    || planCache.get(opts.planId)
    || memory.lastPlan(sessionId);
  if (!plan) {
    return { ok: false, code: 'ASSISTANT_NO_PLAN', error: '还没有计划卡，先说时长和主题', ...i18n.mark('api.assistant.noPlan'), lang };
  }

  let state = memory.getState(sessionId, plan.planId) || stateMachine.create(plan, { sessionId });
  if (state.state === stateMachine.STATES.DONE) {
    return {
      ok: true,
      alreadyDone: true,
      state: stateMachine.summary(state, lang),
      reply: isEn ? 'This plan is already done.' : '这条计划已经完成了。',
      replyKey: 'assistant.reply.alreadyDone',
      lang
    };
  }
  // 正在执行/已提交/补位中的计划不允许再点一次「确认执行」，否则会重复建任务（防重复计费）。
  if (['confirmed', 'submitted', 'running', 'retrying', 'filling'].includes(state.state)) {
    return {
      ok: false,
      code: 'ASSISTANT_ALREADY_RUNNING',
      error: `这条计划已经在执行中（${stateMachine.LABELS[state.state] || state.state}），不会重复创建任务`,
      ...i18n.mark('api.assistant.alreadyRunning'),
      state: stateMachine.summary(state, lang),
      lang
    };
  }

  // ---- 付费闸门：真实模型必须显式同意；mock 不需要 ----
  if (plan.requiresPaymentApproval && opts.approved !== true) {
    return {
      ok: false,
      code: 'PAYMENT_NOT_APPROVED',
      error: `这是付费任务（预估 ¥${plan.estimate.totalCny.toFixed(2)}），需要你明确确认后才会开始`,
      ...i18n.mark('api.assistant.executeNotApproved'),
      state: stateMachine.summary(state, lang),
      lang
    };
  }

  // ---- 余额 / 去重（与 POST /api/tasks 同口径）----
  const realModel = plan.model !== 'mock';
  const estimateUsd = plan.estimate && plan.estimate.budget ? plan.estimate.budget.usd : 0;
  // 出图自动调色（A 方案）：HTTP 入口已按 .env 默认解析；这里只做一次严格归一化。
  // 未提供（直接调用 supervisor 的脚本）→ undefined，由 createTask 套用服务端默认。
  const requestedGrade = imageGrade.normalize(opts.options && opts.options.imageGrade);
  if (realModel) {
    if (!budget.canAfford(estimateUsd)) {
      const st = budget.status();
      return {
        ok: false,
        code: 'INSUFFICIENT_BUDGET',
        error: `余额不足：本次预计 $${estimateUsd.toFixed(2)}，剩余 $${st.balanceUsd.toFixed(2)}`,
        ...i18n.mark('api.tasks.insufficientBudget'),
        state: stateMachine.summary(state, lang),
        lang
      };
    }
    const fp = makeFingerprint(plan, requestedGrade);
    if (opts.force !== true) {
      const dup = submitGuard.check(fp);
      if (dup) {
        return {
          ok: false, code: 'DUPLICATE_TASK',
          error: `重复提交已拦截：${Math.ceil(submitGuard.WINDOW_MS / 60000)} 分钟内已创建过相同任务（${dup.taskId || '未知'}）`,
          ...i18n.mark('api.tasks.duplicate'),
          state: stateMachine.summary(state, lang),
          lang
        };
      }
    }
    state = stateMachine.transition(state, 'CONFIRM', { approved: true, reason: '用户确认付费' });
  } else {
    state = stateMachine.transition(state, 'CONFIRM', { approved: true, reason: 'Mock 零计费' });
  }
  memory.setState(sessionId, state);

  let task;
  try {
    task = taskManager.createTask(plan.userPrompt || plan.text || (plan.themeLabel || '小智视频'), {
      model: plan.model,
      totalClips: plan.clipCount,
      clipDuration: plan.clipDurationSec,
      resolution: plan.resolution,
      theme: plan.theme || undefined,
      preset: 'final',
      // P3：任务语言（日志/历史按界面语言；AI 输出语言可单独由 aiLang 指定）
      lang: taskLang,
      promptLang: lang,
      // 关键：小智自己按预算重试，不让流水线先产出「缺段成片」。
      autoRetry: false,
      // P7-A：场景卡按计划里固定的 id 传给 createTask（用户换过的卡必须原样生效；
      // 没有 ids 的旧计划才让 createTask 走 allocate，零回归）。
      sceneCards: plan.sceneCards
        ? {
          enabled: true,
          ...(Array.isArray(plan.sceneCardIds) && plan.sceneCardIds.length
            ? { ids: plan.sceneCardIds }
            : {})
        }
        : undefined,
      // P7-A：逐段提示词覆盖（键 = 0-based 段序号）；pipeline 每次启动重拼时应用。
      promptOverrides: plan.promptOverrides || undefined,
      // P7-A：计划里的配乐选择优先于默认 auto；HTTP body 显式传的 bgm 优先级最高（不变）。
      bgm: (opts.options && opts.options.bgm)
        || plan.bgm
        || { enabled: true, mode: 'auto', wantMusic: true },
      transition: opts.options && opts.options.transition ? opts.options.transition : { enabled: true, duration: 0.4, type: 'fade' },
      // 出图自动调色：创建时写入 task.imageGrade；未提供则由 createTask 用 .env 默认。
      imageGrade: requestedGrade || undefined,
      runtimeConfig: (opts.options && opts.options.runtimeConfig) || {},
      source: 'assistant'
    });
  } catch (e) {
    const code = (e && e.code) || 'ASSISTANT_TASK_CREATE_FAILED';
    // 场景卡耗尽等错误回滚到 planned，并把原因记清楚
    state = stateMachine.transition(stateMachine.transition(state, 'RESET'), 'PLAN', { reason: code });
    memory.setState(sessionId, state);
    return { ok: false, code, error: '创建任务失败：' + (e && e.message ? e.message : String(e)), state: stateMachine.summary(state, lang) };
  }

  if (realModel && estimateUsd > 0) {
    try {
      budget.reserve({
        usd: estimateUsd, kind: 'video', taskId: task.taskId,
        meta: { model: plan.model, resolution: plan.resolution, clips: plan.clipCount, seconds: plan.clipDurationSec, source: 'assistant' }
      });
      submitGuard.remember(makeFingerprint(plan, requestedGrade), { taskId: task.taskId, model: plan.model, clips: plan.clipCount });
    } catch (e) {
      taskManager.updateTaskStatus(task.taskId, 'failed', { error: '预算预留失败：' + e.message });
      return { ok: false, code: 'INSUFFICIENT_BUDGET', error: '预算预留失败：' + e.message, taskId: task.taskId };
    }
  }

  state = stateMachine.transition(state, 'SUBMIT', { taskId: task.taskId, reason: '任务已创建' });
  state = stateMachine.transition(state, 'RUNNING', { reason: '流水线启动' });
  memory.setState(sessionId, state);

  // 启动流水线（与 POST /api/tasks 同口径：先建任务，再 startTask，不阻塞请求）
  const started = pipeline.startTask(task.taskId);
  if (started && started.error) {
    finish({ sessionId, planId: state.planId }, state, 'NEED_USER', {
      reason: '流水线启动失败：' + started.error
    }, '任务已创建但流水线启动失败：' + started.error);
    return { ok: false, code: 'ASSISTANT_START_FAILED', error: '流水线启动失败：' + started.error, taskId: task.taskId };
  }
  startMonitor(state, lang);

  return {
    ok: true,
    version: SUPERVISOR_VERSION,
    sessionId,
    taskId: task.taskId,
    state: stateMachine.summary(state, lang),
    replyKey: 'assistant.reply.started',
    lang,
    reply: isEn
      ? `Started: ${task.totalClips} clips × ${task.clipDuration} s (${plan.modelLabel}). `
        + 'I will watch the QC: up to 2 automatic retries on failure, then fill-ins from the clip library, and I call you only if that still fails.'
      : `开始做了：${task.totalClips} 段 × ${task.clipDuration} 秒（${plan.modelLabel}）。`
        + '我会盯着质检；失败最多自动重试 2 次，再从片段库补位，仍不行才叫你。'
  };
}

// ==========================================
// 监控：单定时器 / 每计划一个，幂等，可停止
// ==========================================
function startMonitor(state, lang) {
  const sessionId = state.sessionId;
  const planId = state.planId;
  const k = keyOf(sessionId, planId);
  const old = monitors.get(k);
  if (old && old.timer) clearInterval(old.timer);
  const m = {
    sessionId,
    planId,
    taskId: state.taskId,
    finalTaskId: state.finalTaskId || null,
    phase: 'primary',
    busy: false,
    stopped: false,
    ticks: 0,
    timer: null,
    // 2026-11-21：监控消息（「还有 N 段没成功…要不要我再跑一次？」）以前写死中文，
    // 英文界面下用户在失败环节看到的却是中文。记下令牌用户的输出语言，消息按它渲染。
    lang: i18n.resolveLang(lang, state.lang, 'zh')
  };
  m.timer = setInterval(() => { tick(m).catch((e) => console.error('[assistant] 监控异常:', e && e.message)); }, 1000);
  if (m.timer && typeof m.timer.unref === 'function') m.timer.unref();
  monitors.set(k, m);
  return m;
}

function stopMonitor(sessionId, planId) {
  const k = keyOf(sessionId, planId);
  const m = monitors.get(k);
  if (m) {
    m.stopped = true;
    if (m.timer) clearInterval(m.timer);
    monitors.delete(k);
  }
}

function loadState(m) {
  return memory.getState(m.sessionId, m.planId);
}

function saveState(state) {
  try { memory.setState(state.sessionId, state); } catch (e) { console.error('[assistant] 保存状态失败:', e.message); }
  return state;
}

function finish(m, state, type, payload, reply, replyEn) {
  let next;
  try {
    next = stateMachine.transition(state, type, payload);
  } catch (e) {
    next = stateMachine.transition({ ...state, state: stateMachine.STATES.RUNNING }, 'NEED_USER', {
      reason: `状态机拒绝 ${type}：${e.message}`,
      error: e.message
    });
  }
  saveState(next);
  stopMonitor(m.sessionId, m.planId);
  // 2026-11-21：英文会话用 replyEn（未提供时如实回退中文，不静默机翻）。
  const isEn = i18n.normalizeLang(m && m.lang) === 'en';
  const text = isEn && replyEn ? replyEn : reply;
  memory.appendMessage(m.sessionId, { role: 'assistant', text, kind: 'state' });
  return next;
}

/**
 * 用「再跑一次流水线」实现自动重试：流水线会复用已成功片段，只重新生成失败片段
 * （见 pipeline._batchGenerate 的 reusable 集合），不会重复计费已成功的片段。
 */
async function retryRun(m, state, task) {
  const cost = state.plan && state.plan.estimate ? Number(state.plan.estimate.unitCny) || 0 : 0;
  let next;
  try {
    next = stateMachine.transition(state, 'RETRY', {
      costCny: cost,
      reason: `第 ${state.retries + 1} 次自动重试：${failedIndices(task).length} 个片段失败`
    });
  } catch (e) {
    return { ok: false, code: e.code || 'RETRY_REJECTED', error: e.message, state };
  }
  saveState(next);
  const started = pipeline.startTask(m.taskId);
  if (started && started.error) {
    return { ok: false, code: 'RETRY_START_FAILED', error: started.error, state: next };
  }
  return { ok: true, state: next };
}

async function attemptFill(m, state, task) {
  const failed = failedIndices(task);
  const allowedLeft = Math.max(0, (Number(state.plan.fillMaxClips) || 0) - state.fills);
  if (allowedLeft <= 0) {
    return { ok: false, code: 'FILL_NOT_ALLOWED', error: `补位上限为 0 段（≤5% 且 ≤10 段）`, state };
  }
  const fill = await fillLib.planFill({
    task: taskManager.getTask(m.taskId),
    failedIndices: failed,
    candidates: library.listAll(),
    maxClips: Math.min(allowedLeft, failed.length || allowedLeft),
    requiredDurationSec: state.plan.clipDurationSec
  });
  if (!fill.ok) {
    return { ok: false, code: fill.code, error: fill.error, fill, state };
  }
  let next;
  try {
    next = stateMachine.transition(state, 'FILL', {
      fillCount: fill.fills.length,
      reason: `从片段库补位 ${fill.fills.length} 段（SSIM/ΔE76 选最像）`
    });
  } catch (e) {
    return { ok: false, code: e.code || 'FILL_REJECTED', error: e.message, fill, state };
  }
  saveState(next);

  const assembled = fillLib.assembleSegments(taskManager.getTask(m.taskId), fill.fills);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, error: assembled.error, fill, assembled, state: next };
  }
  let libTask;
  try {
    libTask = taskManager.createLibraryTask({
      segments: assembled.segments,
      resolution: next.plan.resolution,
      preset: 'custom',
      stages: ['concatenation', 'loop_processing', 'transcoding', 'audio_mix', 'final_qc'],
      transition: { enabled: true, duration: 0.4, type: 'fade' }
    });
  } catch (e) {
    return { ok: false, code: 'FILL_TASK_FAILED', error: e.message, fill, state: next };
  }
  next = { ...next, finalTaskId: libTask.taskId };
  saveState(next);
  m.phase = 'fill';
  m.finalTaskId = libTask.taskId;
  const started = pipeline.startTask(libTask.taskId);
  if (started && started.error) {
    return { ok: false, code: 'FILL_START_FAILED', error: started.error, fill, state: next };
  }
  memory.appendMessage(m.sessionId, {
    role: 'assistant',
    kind: 'state',
    text: `有 ${fill.fills.length} 段生成失败，已从片段库补位（${fill.fills.map((f) => `#${f.index + 1}`).join('、')}），正在拼接成片。`
  });
  return { ok: true, state: next, fill, task: libTask };
}

async function tick(m) {
  if (m.stopped || m.busy) return;
  m.busy = true;
  try {
    const state = loadState(m);
    if (!state || stateMachine.TERMINAL.has(state.state)) { stopMonitor(m.sessionId, m.planId); return; }
    m.ticks++;

    if (m.phase === 'fill') {
      const ft = taskManager.getTask(m.finalTaskId || state.finalTaskId);
      if (!ft) return;
      if (ACTIVE_STATUS.has(ft.status)) return;
      if (ft.status === 'completed') {
        const done = stateMachine.observe(state, { finalStatus: ft.status });
        saveState(done);
        finish(m, { ...done, state: stateMachine.STATES.FILLING }, 'COMPLETE', {
          finalTaskId: ft.taskId, reason: '补位成片完成'
        }, `成片做好了（补位版）：${require('path').basename(String(ft.outputPath || '')) || ft.taskId}。已归入「库 · 成片」。`,
        `Final cut ready (with fill-in clips): ${require('path').basename(String(ft.outputPath || '')) || ft.taskId}. It is now in Library -> Finals.`);
        return;
      }
      // 补位成片 partial/failed
      finish(m, state, 'NEED_USER', {
        reason: `补位后出片${ft.status === 'completed' ? '' : '未完全成功'}（${ft.status}）：${ft.error || '见任务详情'}`,
        error: ft.error || null
      }, `补位后还是没出成片（${ft.status}）：${ft.error || '原因见任务详情'}。需要你决定：重跑/删掉这条计划。`,
      `The fill-in run still produced no final cut (${ft.status}): ${ft.error || 'see the task details'}. Your call: rerun or delete this plan.`);
      return;
    }

    const task = taskManager.getTask(m.taskId);
    if (!task) {
      finish(m, state, 'NEED_USER', { reason: '任务不存在（可能被删除）' }, '任务不见了（可能被删除），我停下来了。',
        'The task is gone (possibly deleted); I stopped watching it.');
      return;
    }

    // 状态机显示：submitted/retrying → running（任务已实际在跑）
    let cur = state;
    if ((cur.state === stateMachine.STATES.SUBMITTED || cur.state === stateMachine.STATES.RETRYING)
      && ACTIVE_STATUS.has(task.status)) {
      cur = saveState(stateMachine.transition(cur, 'RUNNING', { reason: '任务运行中' }));
    }
    if (ACTIVE_STATUS.has(task.status)) {
      // 出图审图暂停（契约 2026-11-16 §2.7）：每个计划只追加一次会话消息，不刷屏。
      // 用户点「继续生成」由 unpause/continue 处理，这里只做提醒。
      if (task.status === 'paused' && task.awaitingImageReview && !m.imageReviewNotified) {
        m.imageReviewNotified = true;
        const n = Number(task.imageReview && task.imageReview.generated) || 0;
        try {
          memory.appendMessage(m.sessionId, {
            role: 'assistant',
            kind: 'state',
            text: i18n.normalizeLang(m.lang) === 'en'
              ? `${n} images are ready. Open Library -> Photos to sample / approve / reject, then click "Continue" and I will start generating the videos.`
              : `图出好了（${n} 张）。到「库 · 图片」抽看/通过/打回，然后点「继续生成」我再开始生成视频。`
          });
        } catch (e) {
          console.error('[assistant] 审图提醒写入失败:', e && e.message ? e.message : e);
        }
      }
      cur = stateMachine.observe(cur, { pipelineStatus: task.status, currentStep: task.currentStep || null, retries: observedRetries(task) });
      saveState(cur);
      return;
    }

    const failed = failedIndices(task);
    const observed = observedRetries(task);
    cur = stateMachine.observe(cur, { pipelineStatus: task.status, retries: observed });

    if (failed.length === 0 && ['completed', 'partial'].includes(task.status)) {
      saveState(cur);
      const file = task.outputPath ? require('path').basename(String(task.outputPath)) : '';
      finish(m, cur, 'COMPLETE', { reason: '全部片段成功，成片完成' },
        `做好了！${task.totalClips} 段全部通过，成片 ${file || `（${task.taskId}）`}。已归入「库 · 成片」。`,
        `Done! All ${task.totalClips} clips passed; final cut ${file || `(${task.taskId})`}. It is now in Library -> Finals.`);
      return;
    }

    if (failed.length > 0) {
      // 1) 还有重试预算 → 重跑（只重新生成失败片段）
      const retryTarget = cur.plan && cur.plan.estimate ? cur.plan.estimate.autoQcRetries : 0;
      if (cur.retries < retryTarget) {
        const r = await retryRun(m, cur, task);
        if (r.ok) return;
        // 重试被状态机拒绝（例如预算不够）→ 落到补位/问用户
      }
      // 2) 补位
      const f = await attemptFill(m, cur, task);
      if (f.ok) return;
      finish(m, cur, 'NEED_USER', {
        reason: `${failed.length} 段失败：重试与补位都不可用（${f.error || '未知原因'}）`,
        error: f.error || null
      }, `还有 ${failed.length} 段没成功（#${failed.map((i) => i + 1).join('、')}）。`
        + `重试机会用完，补位也用不了：${f.error || '没有可用素材'}。要不要我再跑一次？`,
      `${failed.length} clip(s) still failed (#${failed.map((i) => i + 1).join(', ')}). `
        + `The retries are used up and fill-ins are not available: ${f.error || 'no reusable material'}. Run it again?`);
      return;
    }

    if (task.status === 'failed') {
      // 没有失败片段但任务失败：上游步骤（提示词/拼接）出错
      finish(m, cur, 'FAIL', {
        reason: `任务失败：${task.error || '上游步骤失败'}`,
        error: task.error || null
      }, `任务失败了：${task.error || '原因见任务详情'}。`,
      `The task failed: ${task.error || 'see the task details'}.`);
      return;
    }
  } finally {
    m.busy = false;
  }
}

function stateOf(sessionId, planId, lang) {
  const state = memory.getState(sessionId, planId);
  if (!state) return { ok: false, code: 'ASSISTANT_NO_STATE', error: '没有这个会话的任务状态' };
  const task = state.finalTaskId ? taskManager.getTask(state.finalTaskId) : (state.taskId ? taskManager.getTask(state.taskId) : null);
  return {
    ok: true,
    version: SUPERVISOR_VERSION,
    sessionId,
    planId: state.planId,
    state: stateMachine.summary(state, lang),
    plan: briefPlan(state.plan),
    task: taskView(task),
    finalTask: state.finalTaskId ? taskView(taskManager.getTask(state.finalTaskId)) : null
  };
}

// 给 HTTP/测试用的清理（不删用户产物，只停定时器/清内存缓存）
function resetRuntime() {
  for (const m of monitors.values()) {
    m.stopped = true;
    if (m.timer) clearInterval(m.timer);
  }
  monitors.clear();
  planCache.clear();
}

function monitorCount() {
  return monitors.size;
}

// ==========================================
// 2026-11-19 B 目标第二刀：agent 工具门面（runAgentTool）
// ------------------------------------------------------------
// 输入来自 src/assistant/agent.js 校验后的 { tool, args }；执行仍走本文件既有确定性函数。
// **不提供 execute**：确认执行只能由前端计划卡按钮走 /api/assistant/execute。
// 返回结构与 handleMessage 对齐（ok/reply/replyKey/plan/actions/...），server 可直接透传。
// 参数在这里再查一遍：agent.js 已校验一次，这里防"绕过 agent 直接调用"的调用方。
// ==========================================
const AGENT_BGM_TEXT = Object.freeze({
  list: '配乐有哪些',
  next: '换一首',
  off: '不要配乐'
});
const AGENT_SETTINGS_TEXT = Object.freeze({
  model: Object.freeze({
    dashscope: '把默认通道改成百炼',
    'openai-video': '把默认通道改成 WhaleTV 中转',
    kling: '把默认通道改成可灵',
    seedance: '把默认通道改成即梦',
    mock: '把默认通道改成 mock'
  }),
  resolution: Object.freeze({
    '480p': '把默认分辨率改成 480p',
    '720p': '把默认分辨率改成 720p',
    '1080p': '把默认分辨率改成 1080p',
    '4k': '把默认分辨率改成 4k',
    '2160p': '把默认分辨率改成 2160p'
  })
});

function agentToolFail(code, error) {
  return {
    ok: false, code, error, reply: error,
    replyKey: 'assistant.reply.agentToolError',
    plan: null, actions: null
  };
}

// 2026-11-19 S3：英文错误话术（错误码 → 英文；未知码给通用英文，不回中文原文）
const TOOL_ERROR_EN = Object.freeze({
  AGENT_NO_PLAN: 'There is no plan card yet. Tell me the total length first (for example "30 seconds").',
  AGENT_BAD_ARGS: 'That tool call was missing a required argument or had an invalid value. Tell me again in plain words.',
  AGENT_BAD_ACTION: 'That action is not supported for this tool.',
  AGENT_TOOL_UNKNOWN: 'That tool is not available.',
  AGENT_TOOL_MISSING: 'Internal error: the tool name was missing.',
  AGENT_TOOL_ERROR: 'The tool failed to run. Please try again.',
  AGENT_PROMPT_VIEW_FAILED: 'I could not read the prompt (there may be no plan card yet).',
  AGENT_TOOL_FAILED: 'The tool could not be executed.'
});

function agentToolFailLang(code, zh, lang) {
  return agentToolFail(code, i18n.normalizeLang(lang) === 'en' ? (TOOL_ERROR_EN[code] || TOOL_ERROR_EN.AGENT_TOOL_FAILED) : zh);
}

function agentNoPlan(lang) {
  return agentToolFail('AGENT_NO_PLAN', i18n.normalizeLang(lang) === 'en'
    ? 'There is no plan card yet. Tell me the total length (for example "30 seconds" or "10 minutes") first.'
    : '现在还没有计划卡：先说总时长（比如「30 秒」「10 分钟」），我排好计划。');
}

function agentPlanTurn(sessionId, text, lang, opts) {
  const res = planTurn(sessionId, text, lang, opts);
  return {
    ok: true, reply: res.reply, replyKey: res.replyKey,
    plan: res.plan, missing: res.missing, actions: res.actions
  };
}

const AGENT_TOOL_HANDLERS = {
  plan_video(sessionId, args, ctx) {
    const slots = {};
    for (const k of ['totalMinutes', 'clipDurationSec', 'clipCount', 'resolution', 'model', 'sceneCards']) {
      if (args[k] !== undefined) slots[k] = args[k];
    }
    return agentPlanTurn(sessionId, '', ctx.lang, { input: slots });
  },
  edit_plan(sessionId, args, ctx) {
    const action = String(args.action || '');
    if (action === 'swap_scene' || action === 'set_prompt' || action === 'swap_all') {
      if (!memory.lastPlan(sessionId)) return agentNoPlan(ctx.lang);
      let text;
      if (action === 'swap_all') {
        text = '换一组';
      } else {
        const n = Number(args.segment);
        if (!Number.isInteger(n) || n < 1) {
          return agentToolFail('AGENT_BAD_ARGS', 'edit_plan 需要 segment（第几段，从 1 开始）');
        }
        if (action === 'set_prompt' && !args.prompt) {
          return agentToolFail('AGENT_BAD_ARGS', 'edit_plan set_prompt 需要 prompt');
        }
        text = action === 'swap_scene' ? `第 ${n} 段换一个` : `第 ${n} 段提示词改成：${args.prompt}`;
      }
      const reply = replyForPlanEdit(sessionId, text, ctx.lang);
      return {
        ok: true, reply, replyKey: 'assistant.reply.planEdit',
        plan: memory.lastPlan(sessionId), actions: null
      };
    }
    if (action === 'set_resolution') {
      if (!args.resolution) return agentToolFail('AGENT_BAD_ARGS', 'edit_plan set_resolution 需要 resolution');
      return agentPlanTurn(sessionId, `改成 ${args.resolution}`, ctx.lang, { forceFollow: true });
    }
    if (action === 'set_duration') {
      if (!(Number(args.totalMinutes) > 0)) return agentToolFail('AGENT_BAD_ARGS', 'edit_plan set_duration 需要 totalMinutes');
      return agentPlanTurn(sessionId, `改成 ${Number(args.totalMinutes)} 分钟`, ctx.lang, { forceFollow: true });
    }
    if (action === 'set_clip_duration') {
      if (!(Number(args.clipDurationSec) > 0)) return agentToolFail('AGENT_BAD_ARGS', 'edit_plan set_clip_duration 需要 clipDurationSec');
      return agentPlanTurn(sessionId, `每段 ${Number(args.clipDurationSec)} 秒`, ctx.lang, { forceFollow: true });
    }
    return agentToolFail('AGENT_BAD_ACTION', 'edit_plan 的 action 不在允许集合里：' + action);
  },
  show_plan(sessionId, args, ctx) {
    const plan = memory.lastPlan(sessionId);
    if (!plan) return agentNoPlan(ctx.lang);
    return { ok: true, reply: describeReply(plan, ctx.lang), replyKey: 'assistant.reply.plan', plan, actions: null };
  },
  show_prompt(sessionId, args, ctx) {
    const lang = (ctx && ctx.lang) || 'zh';
    const seg = Number(args && args.segment);
    // 复用规则路径的提示词视图：显式段号只贴单段，否则贴全部/前 N 段。
    const text = Number.isInteger(seg) && seg >= 1 ? `第 ${seg} 段提示词给我看` : '提示词给我看';
    const reply = tryReplyPromptView(sessionId, text, lang);
    if (!reply) return agentToolFail('AGENT_PROMPT_VIEW_FAILED', '提示词读取失败（可能没有计划卡）');
    return { ok: true, reply, replyKey: 'assistant.reply.promptView', plan: null, actions: null };
  },
  show_scene_cards(sessionId, args, ctx) {
    return {
      ok: true, reply: replyForPlanScenes(sessionId, ctx.lang),
      replyKey: 'assistant.reply.planScenes', plan: null, actions: null
    };
  },
  search_scene_cards(sessionId, args, ctx) {
    const plan = memory.lastPlan(sessionId);
    if (!plan) return agentNoPlan(ctx.lang);
    const query = String((args && args.query) || '').trim();
    if (!query) {
      return agentToolFail('AGENT_BAD_ARGS', 'search_scene_cards 需要 query（例如「雪」「海」「夜景」）');
    }
    try {
      return { ...searchPlanSceneCards(plan, query, ctx.lang), plan: null, actions: null };
    } catch (e) {
      return agentToolFail('AGENT_TOOL_ERROR', '场景卡检索失败：' + (e && e.message ? e.message : e));
    }
  },
  status(sessionId, args, ctx) {
    return { ok: true, reply: replyForStatus(sessionId, ctx && ctx.lang), replyKey: 'assistant.reply.status', plan: null, actions: null };
  },
  last_video(sessionId, args, ctx) {
    const lang = (ctx && ctx.lang) || 'zh';
    const res = retrieveRefs('上一次的视频', 3);
    return {
      ok: true, reply: replyForLast('上一次的视频', lang),
      replyKey: 'assistant.reply.last', plan: null, refs: res.refs, actions: null
    };
  },
  budget(sessionId, args, ctx) {
    return {
      ok: true, reply: replyForContext(sessionId, { userId: ctx.userId, lang: ctx.lang }),
      replyKey: 'assistant.reply.context', plan: null, actions: null
    };
  },
  diagnose(sessionId, args, ctx) {
    const r = replyForRepair(sessionId, ctx && ctx.lang);
    return { ok: true, reply: r.reply, replyKey: 'assistant.reply.repair', plan: null, diagnosis: r.diagnosis, actions: null };
  },
  // 2026-11-23（用户实测）：用户说「继续/接着/补跑上一个任务」时，agent 原先只有只读的 diagnose，
  // prompt 还写着「你没有直接补跑工具」——于是它只能说「你去库→成片→补跑」，用户拿不到确认卡。
  // 本工具把「补跑确认项」直接生成出来：不执行、不计费，前端 RepairCard 渲染「确认执行」按钮，
  // 用户点它才走 POST /api/assistant/repair → repairTask({approved:true}) → pipeline.continueTask。
  // 已完成的任务不生成卡（没有可补的），改为明确回答「已完成 + 成片名」，避免又去排 ¥180 的新计划。
  resume_task(sessionId, args, ctx) {
    const lang = (ctx && ctx.lang) || 'zh';
    const isEn = i18n.normalizeLang(lang) === 'en';
    const wanted = String((args && args.taskId) || '').trim();
    const task = wanted ? taskManager.getTask(wanted) : pickTaskForDiagnosis(sessionId);
    if (!task) {
      return {
        ok: true,
        reply: isEn
          ? 'Nothing to resume right now: there is no interrupted or failed task. A completed task does not need a resume.'
          : '现在没有需要补跑的任务：没有中断/失败的条目（已完成的任务不需要补跑）。',
        replyKey: 'assistant.reply.resumeNone',
        plan: null, actions: null
      };
    }
    if (String(task.status || '') === 'completed') {
      const base = task.outputPath ? require('path').basename(task.outputPath) : '';
      return {
        ok: true,
        reply: isEn
          ? `Task ${task.taskId} is already complete${base ? ` (${base})` : ''} — there is nothing to resume. Tell me if you want a NEW plan or a re-mix of this one.`
          : `任务 ${task.taskId} 已经完成了${base ? `（成片 ${base}）` : ''}，没有可补跑的步骤。要新做一条或重新配乐导出，再说一声。`,
        replyKey: 'assistant.reply.resumeDone',
        plan: null, actions: null
      };
    }
    const d = diagnose.diagnose(task);
    const hasContinue = Array.isArray(d.suggestions)
      && d.suggestions.some((s) => s && s.executable === true && s.action === 'continue');
    if (!hasContinue) {
      d.suggestions.unshift({
        id: 'continue',
        action: 'continue',
        label: isEn
          ? 'Resume: regenerate only the unfinished parts; finished clips are reused'
          : '补跑：只补未完成的部分，已成功的片段直接复用、不重复生成',
        why: isEn
          ? 'Finished clips are reused; only missing clips are billed'
          : '已成功的片段复用，只有缺失的片段才会真实计费',
        executable: true,
        requiresConfirm: true,
        where: null
      });
    }
    const lines = isEn
      ? [
        '[Resume] A confirmable resume card is ready below — nothing runs until you press it.',
        `Task ${task.taskId} · ${d.status || 'unknown'} · ${Number(d.notSuccessClips) || 0} clip(s) unfinished.`
      ]
      : [
        '【补跑】下面已经生成补跑确认卡：你点「确认执行」它才会真正开始，没点之前不会跑、也不会花钱。',
        `任务 ${task.taskId} · 状态 ${d.status || '未知'} · 未完成 ${Number(d.notSuccessClips) || 0} 段。`
      ];
    return {
      ok: true,
      reply: lines.join('\n'),
      replyKey: 'assistant.reply.resumeTask',
      plan: null,
      diagnosis: d,
      actions: null
    };
  },
  bgm(sessionId, args, ctx) {
    const lang = (ctx && ctx.lang) || 'zh';
    const action = String(args.action || 'list');
    const isEn = i18n.normalizeLang(lang) === 'en';
    if (action === 'pick') {
      const n = Number(args.index);
      if (!Number.isInteger(n) || n < 1) {
        return agentToolFail('AGENT_BAD_ARGS', 'bgm pick 需要 index（第几首，从 1 开始）');
      }
      return {
        ok: true,
        reply: isEn ? replyForBgmEn(sessionId, 'pick', n) : replyForBgm(sessionId, `用第 ${n} 首`),
        replyKey: 'assistant.reply.bgm', plan: memory.lastPlan(sessionId), actions: null
      };
    }
    if (action !== 'list' && action !== 'next' && action !== 'off') {
      return agentToolFail('AGENT_BAD_ACTION', 'bgm 的 action 只能是 list/pick/next/off');
    }
    return {
      ok: true,
      reply: isEn ? replyForBgmEn(sessionId, action, null) : replyForBgm(sessionId, AGENT_BGM_TEXT[action]),
      replyKey: 'assistant.reply.bgm', plan: memory.lastPlan(sessionId), actions: null
    };
  },
  settings_change(sessionId, args, ctx) {
    const key = String(args.key || '');
    const value = args.value === undefined || args.value === null ? '' : String(args.value);
    if (i18n.normalizeLang(ctx && ctx.lang) === 'en') {
      const rEn = replyForSettingsChangeEn(sessionId, key, value);
      if (!rEn.pending) return agentToolFail('AGENT_BAD_ARGS', 'settings_change 的 key/value 组合不受支持：' + key + '=' + value);
      return {
        ok: true, reply: rEn.reply, replyKey: 'assistant.reply.settings',
        plan: null, pendingChange: rEn.pending, actions: null
      };
    }
    let text = null;
    if (key === 'model') text = AGENT_SETTINGS_TEXT.model[value] || null;
    else if (key === 'resolution') text = AGENT_SETTINGS_TEXT.resolution[String(value).toLowerCase()] || null;
    else if (key === 'broadcast') text = /^(true|on|1|开|打开)$/i.test(value) ? '把任务播报打开' : '把任务播报关掉';
    else if (key === 'clear_prefs') text = '清空偏好';
    if (!text) return agentToolFail('AGENT_BAD_ARGS', 'settings_change 的 key/value 组合不受支持：' + key + '=' + value);
    const r = replyForSettings(sessionId, text);
    return {
      ok: true, reply: r.reply, replyKey: 'assistant.reply.settings',
      plan: null, pendingChange: r.pending, actions: null
    };
  },
  prefs(sessionId, args, ctx) {
    const r = replyForPrefs(sessionId, { userId: ctx.userId, lang: ctx.lang });
    return {
      ok: true, reply: r.reply, replyKey: 'assistant.reply.prefs',
      plan: null, preferences: r.preferences, actions: null
    };
  },
  assets(sessionId, args, ctx) {
    return { ok: true, reply: replyForAssets(sessionId, ctx && ctx.lang), replyKey: 'assistant.reply.assets', plan: null, actions: null };
  },
  confirm_plan(sessionId, args, ctx) {
    const plan = memory.lastPlan(sessionId);
    if (!plan) return agentNoPlan(ctx.lang);
    return {
      ok: true,
      reply: replyForConfirm(sessionId, ctx.lang),
      replyKey: 'assistant.reply.confirm',
      plan,
      actions: [{ type: 'confirm', labelKey: 'assistant.action.confirmExecute', requiresApproval: true }]
    };
  }
};
const AGENT_TOOL_NAMES = Object.freeze(Object.keys(AGENT_TOOL_HANDLERS));

/**
 * 执行 agent 选中的一个工具。**绝不抛异常**；不提供 execute（付费只能走计划卡按钮）。
 * @param {object} opts { tool, args, sessionId?, userId?, lang? }
 */
function runAgentTool(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const tool = String(o.tool || '').trim();
  const args = o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? o.args : {};
  const lang = i18n.resolveLang(o.lang);
  if (!tool) return agentToolFailLang('AGENT_TOOL_MISSING', 'runAgentTool 需要 tool', lang);
  if (AGENT_TOOL_NAMES.indexOf(tool) === -1) {
    return agentToolFailLang('AGENT_TOOL_UNKNOWN', '未知/不允许的工具：' + tool, lang);
  }
  const session = memory.getOrCreate(o.sessionId);
  const sessionId = session.id;
  const userId = o.userId ? String(o.userId) : 'local';
  try {
    let out = AGENT_TOOL_HANDLERS[tool](sessionId, args, { lang, userId });
    // 英文下把「工具/参数错误」的中文原文替换为英文（reply 与 error 同步，前端只显示一个）
    if (out && out.ok === false && lang === 'en') {
      const en = TOOL_ERROR_EN[out.code] || TOOL_ERROR_EN.AGENT_TOOL_FAILED;
      out = { ...out, reply: en, error: en };
    }
    // 2026-11-19：失败（如 AGENT_NO_PLAN / AGENT_BAD_ARGS）不在门面写会话，
    // 由运行时写一条错误回复——否则会「门面写一条 + 运行时再写一条」重复两条。
    if (out.ok !== false) {
      memory.appendMessage(sessionId, {
        role: 'assistant', text: out.reply || '', kind: out.plan ? 'plan' : 'chat'
      });
    }
    return {
      ...out,
      sessionId,
      tool,
      lang,
      plan: out.plan ? briefPlan(out.plan) : null,
      canExecute: !!out.plan
    };
  } catch (e) {
    return {
      ...agentToolFailLang('AGENT_TOOL_ERROR', '工具执行失败：' + (e && e.message ? e.message : e), lang),
      sessionId, tool, lang
    };
  }
}

module.exports = {
  SUPERVISOR_VERSION,
  ACTIVE_STATUS,
  handleMessage,
  execute,
  stateOf,
  briefPlan,
  // 2026-11-19 B 目标第二刀：agent 工具门面（无 execute；动作走既有确定性函数）
  runAgentTool,
  AGENT_TOOL_NAMES,
  TOOL_ERROR_EN,
  agentContextOf,
  taskView,
  failedIndices,
  observedRetries,
  retrieveRefs,
  resetRuntime,
  monitorCount,
  // 2026-11-17 V1（§9.1-7）：只读环境的进程内入口（V2 扩成 HTTP 端点时直接复用）
  contextOf,
  keyPresence,
  CONTEXT_KEYS,
  // 2026-11-17 V2：环境感知 / 诊断 / 偏好 / 审计 / 播报的进程内入口。
  // server.js 的 HTTP 端点只做参数校验后调用这些函数；verify-assistant 直接进程内断言。
  assistantContext,
  assistantBroadcast,
  assistantDiagnose: diagnose,
  assistantPreferences: preferences,
  assistantAudit: audit,
  replyForContext,
  replyForStatus,
  replyForAssets,
  replyForPrefs,
  replyForSettings,
  replyForRepair,
  parsePreferenceChange,
  confirmSettingChange,
  getPreferences,
  clearPreferences,
  repairTask,
  pickTaskForDiagnosis,
  _clearPendingChanges: () => pendingChanges.clear(),
  _pendingChangeCount: () => pendingChanges.size,
  _tick: tick,
  _attemptFill: attemptFill,
  _retryRun: retryRun,
  _startMonitor: startMonitor,
  _stopMonitor: stopMonitor
};
