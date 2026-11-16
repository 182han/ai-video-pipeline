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
const memory = require('./memory');
const planCard = require('./planCard');
const stateMachine = require('./stateMachine');
const fillLib = require('./fillFromLibrary');
const sceneCardLibrary = require('../sceneCards');

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

function describeReply(plan) {
  const lines = planCard.describe(plan);
  return lines.join('\n');
}

function replyForPlan(plan) {
  // 2026-11-16 用户口径：长片按「总时长」排，场景从场景卡库自动抽取，不再说「我按某个主题排好了」。
  const mins = Number(plan.totalSec || 0) / 60;
  // 不到 1 分钟按秒说（支持「30 秒」这类短视频/快速验证）。
  const durLabel = mins >= 10 ? `${mins.toFixed(1)} 分钟`
    : (mins >= 1 ? `${mins.toFixed(2)} 分钟` : `${Math.round(Number(plan.totalSec) || 0)} 秒`);
  return `我按 ${durLabel}排好了：\n${describeReply(plan)}\n`
    + (plan.requiresPaymentApproval
      ? '这是付费任务：你确认后我才开始，不会自动扣费。要改哪里直接说。'
      : '这是零计费任务（Mock）：你确认后我就开始。要改哪里直接说。');
}

function replyForGreeting() {
  return '我是小智。说个总时长就能排计划，例如「10 分钟」或「30 分钟」——'
    + '场景由场景卡库按章节顺序自动抽取（默认 10 秒/段，10 分钟 = 60 个不同场景；也可以说「每段 15 秒」），不需要指定主题；'
    + '也可以问「上一次的视频」或「现在进度怎样」。语音按钮在输入框左侧。';
}

function replyUnknown() {
  return '我可以做三件事：① 按总时长排计划（场景从场景卡库自动抽取，不需要说主题）；'
    + '② 帮你找「上一次的视频」；③ 报当前任务进度。比如：10 分钟 / 上一次的视频 / 进度。';
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

function describeRefs(refs) {
  if (!refs || refs.length === 0) return '';
  return refs.map((r, i) => {
    const when = memory.formatWhen(r.completedAt || r.createdAt);
    const kind = r.kind === 'final' ? '成片' : (r.status === 'completed' ? '任务完成' : `任务 ${r.status || ''}`);
    const file = r.fileName ? `，文件 ${r.fileName}` : '';
    return `${i === 0 ? '上一次' : `第 ${i + 1} 近`}：${(r.prompt || '（无提示词）').slice(0, 60)}（${when}，${kind}${file}）`;
  }).join('\n');
}

function replyForLast(query) {
  const res = retrieveRefs(query, 3);
  if (!res.refs.length) {
    return '库里还没有成片记录。说个总时长（比如「10 分钟」），我来做第一条。';
  }
  return `我查到这些相关记录：\n${describeRefs(res.refs)}\n`
    + '要再来一条类似的，直接说「再来一条」并告诉我时长；要看成片就去「库 · 成片」。';
}

function replyForStatus(sessionId) {
  const state = memory.getState(sessionId);
  if (!state) return '现在没有正在执行的任务。说个时长，我来排计划。';
  const task = state.finalTaskId ? taskManager.getTask(state.finalTaskId) : (state.taskId ? taskManager.getTask(state.taskId) : null);
  if (state.state === stateMachine.STATES.DONE) {
    const file = task && task.outputPath ? `，成片 ${require('path').basename(task.outputPath)}` : '';
    return `上一次任务已经完成${file}。可以在「库 · 成片」里看到。`;
  }
  if (state.state === stateMachine.STATES.NEEDS_USER || state.state === stateMachine.STATES.FAILED) {
    return `任务停在「${stateMachine.LABELS[state.state]}」：${state.reason || state.lastError || '原因未记录'}。`;
  }
  if (!task) return `任务状态：${stateMachine.LABELS[state.state] || state.state}。`;
  return `任务${task.taskId} 正在「${stateMachine.LABELS[state.state] || state.state}」：`
    + `当前 ${task.currentStep || task.status}，成功片段 ${(task.clips || []).filter((c) => c.status === 'success').length}/${task.totalClips}。`;
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

function sceneCardLine(entry, i) {
  const card = (entry && entry.id ? sceneCardLibrary.getCardById(entry.id) : null) || entry || {};
  const bits = [`#${i + 1}`, card.scene_key || card.sceneKey || card.id || '(未知卡)'];
  const chapter = Number.isInteger(card.chapter) ? card.chapter : (entry && entry.chapter);
  const sequence = Number.isInteger(card.sequence) ? card.sequence : (entry && entry.sequence);
  if (Number.isInteger(chapter) && Number.isInteger(sequence)) bits.push(`第 ${chapter} 章-${sequence}`);
  const biome = [card.biome, card.landform].filter(Boolean).join('/');
  if (biome) bits.push(biome);
  if (card.shot) bits.push(card.shot);
  if (card.palette) bits.push(card.palette);
  if (entry && entry.role === 'buffer') bits.push('缓冲卡');
  return bits.join(' · ');
}

function formatSceneEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const shown = list.slice(0, SCENE_PREVIEW_LIMIT).map(sceneCardLine);
  if (list.length > shown.length) {
    shown.push(`…… 共 ${list.length} 张，这里先列前 ${shown.length} 张。`);
  }
  return shown.join('\n');
}

function replyForPlanScenes(sessionId) {
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return '现在还没有计划卡，所以我还没选卡。先说总时长（比如「30 秒」「10 分钟」），'
      + '我排好计划后就把要用的场景卡列给你看。';
  }
  // 已开工：以任务里实际分配的卡为准（可能已有 buffer 替换）。
  // 只认**这条计划自己的**状态；不能用「会话里最新的状态」——用户可能在上一条计划之后
  // 又排了一条尚未执行的新计划，用最新状态会把上一条任务的卡说成这条计划的。
  const state = memory.getState(sessionId, plan.planId);
  const taskId = state && state.taskId ? state.taskId : null;
  const task = taskId ? taskManager.getTask(taskId) : null;
  if (task && task.sceneCards && Array.isArray(task.sceneCards.used) && task.sceneCards.used.length) {
    return `任务 ${task.taskId} 实际分配到 ${task.sceneCards.used.length} 张场景卡（按章节顺序）：\n`
      + formatSceneEntries(task.sceneCards.used)
      + '\n这些卡已写进各段提示词；要换卡得新开一条计划。';
  }
  if (plan.sceneCards === false) {
    return '这条计划关掉了场景卡（自由提示词），所以没有选卡。'
      + '想要卡库选场景，就新排一条（不要说「不要场景卡」）。';
  }
  try {
    // allocate() 是纯函数：按 chapter+sequence 取前 N 张，不占卡、不写卡库、不建任务。
    // createTask 执行时也按同一顺序取卡，所以这份预览与真正要用的卡一致。
    const preview = sceneCardLibrary.allocate(plan.clipCount);
    return `这条计划 ${plan.clipCount} 段，确认后会按章节顺序取这 ${preview.used.length} 张场景卡：\n`
      + formatSceneEntries(preview.used)
      + '\n（现在只是预览，还没占卡；真正点「确认执行」时才分配给任务。）';
  } catch (e) {
    return `场景卡库暂时读不到：${(e && e.message) || e}。计划还在，稍后再问一次就行。`;
  }
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

/**
 * 对话入口：听懂 → 排计划 / 检索记录 / 报进度。不创建任务、不发付费请求。
 * @param {object} opts { sessionId?, text, options? }
 */
function handleMessage(opts = {}) {
  const text = String(opts.text || '').trim();
  if (!text) return { ok: false, code: 'ASSISTANT_EMPTY_TEXT', error: '说点什么吧' };
  const session = memory.getOrCreate(opts.sessionId);
  const sessionId = session.id;
  memory.appendMessage(sessionId, { role: 'user', text });

  const intent = memory.classify(text);
  let reply;
  let plan = null;
  let missing = null;
  let refs = null;

  if (intent.intent === 'greeting') {
    reply = replyForGreeting();
  } else if (intent.intent === 'status') {
    reply = replyForStatus(sessionId);
  } else if (intent.intent === 'plan_scenes') {
    // 2026-11-16 用户问题 a：问「选了哪几个场景」→ 只读预览，不重排计划、不占卡。
    reply = replyForPlanScenes(sessionId);
  } else if (intent.intent === 'no_image') {
    // 2026-11-16 用户问题 b：要纯文生视频 → 告诉用户卡上的开关位置，不新建计划。
    reply = replyForNoImage(sessionId);
  } else if (intent.intent === 'last') {
    const res = retrieveRefs(text, 3);
    refs = res.refs;
    reply = replyForLast(text);
  } else {
    // create / unknown 都尝试排计划；听不懂时 buildPlan 会返回明确的追问。
    const last = memory.lastPlan(sessionId);
    const parsed = planCard.parseUtterance(text);
    let input = { text, sessionId };
    // 只给了「槽位词」也算续问：例如单独说「1080p」「720p」「15 秒/段」——
    // 用户直觉是「改上次那个」，不该被当成"没说时长"再问一遍（2026-11-16 用户反馈）。
    const slotOnly = parsed.totalMinutes === null && parsed.clipCount === null
      && (parsed.resolution !== null || parsed.clipDurationSec !== null || parsed.model !== null);
    const follow = last && (isFollowUp(text) || isRepeat(text) || slotOnly);
    if (follow) input = { ...inputFromLast(last, parsed, text), sessionId };
    else {
      input.totalMinutes = parsed.totalMinutes !== null ? parsed.totalMinutes : undefined;
      input.clipDurationSec = parsed.clipDurationSec !== null ? parsed.clipDurationSec : undefined;
      input.clipCount = parsed.clipCount !== null ? parsed.clipCount : undefined;
      input.resolution = parsed.resolution || undefined;
      input.model = parsed.model || undefined;
      // 主题词不进入计划：长片按场景卡库自动抽取不同场景（2026-11-16 用户口径）。
      input.sceneCards = parsed.sceneCards !== null ? parsed.sceneCards : undefined;
    }
    const built = planCard.buildPlan(input);
    if (!built.ok) {
      if (built.missing || built.code === 'PLAN_NEED_DURATION') {
        missing = built.missing || ['totalMinutes'];
        reply = built.question || built.error;
      } else if (intent.intent === 'unknown') {
        reply = replyUnknown() + '\n（' + built.error + '）';
      } else {
        reply = built.error;
      }
    } else {
      plan = built.plan;
      planCache.set(plan.planId, plan);
      memory.addPlan(sessionId, plan);
      reply = replyForPlan(plan);
    }
  }

  memory.appendMessage(sessionId, { role: 'assistant', text: reply, kind: plan ? 'plan' : 'chat' });
  return {
    ok: true,
    version: SUPERVISOR_VERSION,
    sessionId,
    intent: intent.intent,
    reply,
    plan: plan ? briefPlan(plan) : null,
    missing,
    refs,
    canExecute: !!plan
  };
}

function makeFingerprint(plan) {
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
    colorMatch: null
  }));
}

/**
 * 确认并执行计划卡。
 * @param {object} opts { sessionId, planId?, approved?, force?, options? }
 */
function execute(opts = {}) {
  const sessionId = opts.sessionId;
  if (!sessionId || !memory.getSession(sessionId)) {
    return { ok: false, code: 'ASSISTANT_BAD_SESSION', error: '没有这个会话，请先聊一句' };
  }
  const plan = (opts.planId && memory.getPlan(sessionId, opts.planId))
    || planCache.get(opts.planId)
    || memory.lastPlan(sessionId);
  if (!plan) return { ok: false, code: 'ASSISTANT_NO_PLAN', error: '还没有计划卡，先说时长和主题' };

  let state = memory.getState(sessionId, plan.planId) || stateMachine.create(plan, { sessionId });
  if (state.state === stateMachine.STATES.DONE) {
    return { ok: true, alreadyDone: true, state: stateMachine.summary(state), reply: '这条计划已经完成了。' };
  }
  // 正在执行/已提交/补位中的计划不允许再点一次「确认执行」，否则会重复建任务（防重复计费）。
  if (['confirmed', 'submitted', 'running', 'retrying', 'filling'].includes(state.state)) {
    return {
      ok: false,
      code: 'ASSISTANT_ALREADY_RUNNING',
      error: `这条计划已经在执行中（${stateMachine.LABELS[state.state] || state.state}），不会重复创建任务`,
      state: stateMachine.summary(state)
    };
  }

  // ---- 付费闸门：真实模型必须显式同意；mock 不需要 ----
  if (plan.requiresPaymentApproval && opts.approved !== true) {
    return {
      ok: false,
      code: 'PAYMENT_NOT_APPROVED',
      error: `这是付费任务（预估 ¥${plan.estimate.totalCny.toFixed(2)}），需要你明确确认后才会开始`,
      state: stateMachine.summary(state)
    };
  }

  // ---- 余额 / 去重（与 POST /api/tasks 同口径）----
  const realModel = plan.model !== 'mock';
  const estimateUsd = plan.estimate && plan.estimate.budget ? plan.estimate.budget.usd : 0;
  if (realModel) {
    if (!budget.canAfford(estimateUsd)) {
      const st = budget.status();
      return {
        ok: false,
        code: 'INSUFFICIENT_BUDGET',
        error: `余额不足：本次预计 $${estimateUsd.toFixed(2)}，剩余 $${st.balanceUsd.toFixed(2)}`,
        state: stateMachine.summary(state)
      };
    }
    const fp = makeFingerprint(plan);
    if (opts.force !== true) {
      const dup = submitGuard.check(fp);
      if (dup) {
        return {
          ok: false, code: 'DUPLICATE_TASK',
          error: `重复提交已拦截：${Math.ceil(submitGuard.WINDOW_MS / 60000)} 分钟内已创建过相同任务（${dup.taskId || '未知'}）`,
          state: stateMachine.summary(state)
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
      // 关键：小智自己按预算重试，不让流水线先产出「缺段成片」。
      autoRetry: false,
      sceneCards: plan.sceneCards ? { enabled: true } : undefined,
      bgm: opts.options && opts.options.bgm ? opts.options.bgm : { enabled: true, mode: 'auto', wantMusic: true },
      transition: opts.options && opts.options.transition ? opts.options.transition : { enabled: true, duration: 0.4, type: 'fade' },
      runtimeConfig: (opts.options && opts.options.runtimeConfig) || {},
      source: 'assistant'
    });
  } catch (e) {
    const code = (e && e.code) || 'ASSISTANT_TASK_CREATE_FAILED';
    // 场景卡耗尽等错误回滚到 planned，并把原因记清楚
    state = stateMachine.transition(stateMachine.transition(state, 'RESET'), 'PLAN', { reason: code });
    memory.setState(sessionId, state);
    return { ok: false, code, error: '创建任务失败：' + (e && e.message ? e.message : String(e)), state: stateMachine.summary(state) };
  }

  if (realModel && estimateUsd > 0) {
    try {
      budget.reserve({
        usd: estimateUsd, kind: 'video', taskId: task.taskId,
        meta: { model: plan.model, resolution: plan.resolution, clips: plan.clipCount, seconds: plan.clipDurationSec, source: 'assistant' }
      });
      submitGuard.remember(makeFingerprint(plan), { taskId: task.taskId, model: plan.model, clips: plan.clipCount });
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
  startMonitor(state);

  return {
    ok: true,
    version: SUPERVISOR_VERSION,
    sessionId,
    taskId: task.taskId,
    state: stateMachine.summary(state),
    reply: `开始做了：${task.totalClips} 段 × ${task.clipDuration} 秒（${plan.modelLabel}）。`
      + '我会盯着质检；失败最多自动重试 2 次，再从片段库补位，仍不行才叫你。'
  };
}

// ==========================================
// 监控：单定时器 / 每计划一个，幂等，可停止
// ==========================================
function startMonitor(state) {
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
    timer: null
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

function finish(m, state, type, payload, reply) {
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
  memory.appendMessage(m.sessionId, { role: 'assistant', text: reply, kind: 'state' });
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
        }, `成片做好了（补位版）：${require('path').basename(String(ft.outputPath || '')) || ft.taskId}。已归入「库 · 成片」。`);
        return;
      }
      // 补位成片 partial/failed
      finish(m, state, 'NEED_USER', {
        reason: `补位后出片${ft.status === 'completed' ? '' : '未完全成功'}（${ft.status}）：${ft.error || '见任务详情'}`,
        error: ft.error || null
      }, `补位后还是没出成片（${ft.status}）：${ft.error || '原因见任务详情'}。需要你决定：重跑/删掉这条计划。`);
      return;
    }

    const task = taskManager.getTask(m.taskId);
    if (!task) {
      finish(m, state, 'NEED_USER', { reason: '任务不存在（可能被删除）' }, '任务不见了（可能被删除），我停下来了。');
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
            text: `图出好了（${n} 张）。到「库 · 图片」抽看/通过/打回，然后点「继续生成」我再开始生成视频。`
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
        `做好了！${task.totalClips} 段全部通过，成片 ${file || `（${task.taskId}）`}。已归入「库 · 成片」。`);
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
        + `重试机会用完，补位也用不了：${f.error || '没有可用素材'}。要不要我再跑一次？`);
      return;
    }

    if (task.status === 'failed') {
      // 没有失败片段但任务失败：上游步骤（提示词/拼接）出错
      finish(m, cur, 'FAIL', {
        reason: `任务失败：${task.error || '上游步骤失败'}`,
        error: task.error || null
      }, `任务失败了：${task.error || '原因见任务详情'}。`);
      return;
    }
  } finally {
    m.busy = false;
  }
}

function stateOf(sessionId, planId) {
  const state = memory.getState(sessionId, planId);
  if (!state) return { ok: false, code: 'ASSISTANT_NO_STATE', error: '没有这个会话的任务状态' };
  const task = state.finalTaskId ? taskManager.getTask(state.finalTaskId) : (state.taskId ? taskManager.getTask(state.taskId) : null);
  return {
    ok: true,
    version: SUPERVISOR_VERSION,
    sessionId,
    planId: state.planId,
    state: stateMachine.summary(state),
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

module.exports = {
  SUPERVISOR_VERSION,
  ACTIVE_STATUS,
  handleMessage,
  execute,
  stateOf,
  briefPlan,
  taskView,
  failedIndices,
  observedRetries,
  retrieveRefs,
  resetRuntime,
  monitorCount,
  _tick: tick,
  _attemptFill: attemptFill,
  _retryRun: retryRun,
  _startMonitor: startMonitor,
  _stopMonitor: stopMonitor
};
