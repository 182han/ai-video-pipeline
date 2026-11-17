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
const promptComposer = require('../promptComposer');
const audioMixer = require('../processors/audioMixer');

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

function describeReply(plan) {
  const lines = planCard.describe(plan);
  // P7-A：计划摘要必须显示当前配乐（§3.3.5）
  lines.push(`配乐：${bgmLabel(plan)}`);
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
    return `任务 ${task.taskId} 实际分配到 ${task.sceneCards.used.length} 张场景卡（按计划顺序）：\n`
      + formatSceneEntries(task.sceneCards.used)
      + '\n这些卡已写进各段提示词；要换卡得新开一条计划。';
  }
  if (plan.sceneCards === false) {
    return '这条计划关掉了场景卡（自由提示词），所以没有选卡。'
      + '想要卡库选场景，就新排一条（不要说「不要场景卡」）。';
  }
  try {
    // 计划阶段固定下来的卡（换卡后这里就是新卡）；旧计划没有 ids 时回退纯函数预览。
    // allocate() 是纯函数：按 chapter+sequence 取前 N 张，不占卡、不写卡库、不建任务。
    // createTask 执行时按同一批 id 取卡，所以这份预览与真正要用的卡一致。
    const preview = planSceneEntries(plan);
    if (!preview.length) {
      return '场景卡库暂时读不到，计划还在，稍后再问一次就行。';
    }
    return `这条计划 ${plan.clipCount} 段，确认后会按计划顺序取这 ${preview.length} 张场景卡：\n`
      + formatSceneEntries(preview)
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

// ==========================================
// 2026-11-17 小智 2.0 V1（设计定稿 §9.1-6）：最终确认时点（A7）
// ------------------------------------------------------------
// 用户问「确认生成吗？」时**只回确认语 + 回传计划**（前端据此展示计划卡），
// 绝不在这里建任务：真正建任务只走 execute()，而 execute 只由卡片上的「确认执行」按钮触发
// （web/src/components/assistant.js 的 confirmPlan）。
// 共同契约 §0.2：L3（付费/建任务）必须用户点确认；未确认 → PAYMENT_NOT_APPROVED。
// ==========================================
function replyForConfirm(sessionId) {
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return '现在还没有计划卡，没有可确认的东西。先说总时长（比如「30 秒」「10 分钟」），'
      + '我排好计划再让你确认。';
  }
  const cost = plan.requiresPaymentApproval && plan.estimate
    ? `预估 ¥${Number(plan.estimate.totalCny || 0).toFixed(2)}`
    : '零计费（Mock）';
  const state = memory.getState(sessionId, plan.planId);
  if (state && state.state && !['planned'].includes(state.state)) {
    return `这条计划已经在走了（${stateMachine.LABELS[state.state] || state.state}），不用再确认；`
      + '要看进度就说「现在进度怎样」。';
  }
  return `要现在开始吗？${plan.clipCount} 段 × ${plan.clipDurationSec} 秒（${plan.modelLabel} · ${plan.resolution}，${cost}）。\n`
    + '点下面卡片上的「确认执行」我才开始：没点之前不会建任务，也不会花一分钱。'
    + '要改哪里现在直接说，planId 不变。';
}

// ==========================================
// 2026-11-17 小智 2.0 V1（设计定稿 §9.1-7）：只读环境（最小）
// ------------------------------------------------------------
// 只读四件事：会话内的计划 / 任务数与最近任务 / 预算余额 / Key 有·无。
// 三条红线（写死）：
//   · 不写任何文件、不建任务、不发请求、不产生费用；
//   · Key **只报「有/无」**，任何调用方都拿不到 Key 值（contextOf 只输出 {label, present}）；
//   · 全部走进程内模块（taskManager / budget），不经过 HTTP —— V1 刻意不加新端点。
// V2 再扩成 A–E 全量环境感知（任务播报/失败诊断/偏好），本版不做。
// ==========================================
const CONTEXT_KEYS = [
  { label: '视频生成·WhaleTV 中转', names: ['OPENAI_VIDEO_API_KEY', 'WHALETV_API_KEY'] },
  { label: '视频生成·百炼万相', names: ['DASHSCOPE_API_KEY'] },
  { label: '视频生成·可灵', names: ['KLING_API_KEY', 'KLING_ACCESS_KEY'] },
  { label: '图片生成', names: ['IMAGE_GEN_API_KEY', 'DASHSCOPE_API_KEY'] },
  { label: '多模态质检', names: ['MULTIMODAL_API_KEY'] },
  { label: '文案 LLM', names: ['OPENAI_API_KEY'] }
];

// 只返回「有/无」。刻意不返回长度、前缀、后缀 —— 任何形式的部分回显都算泄露。
function keyPresence() {
  return CONTEXT_KEYS.map((k) => ({
    label: k.label,
    present: k.names.some((n) => String(process.env[n] || '').trim() !== '')
  }));
}

function contextOf(sessionId) {
  const plan = (sessionId ? memory.lastPlan(sessionId) : null) || null;
  let tasks = [];
  try { tasks = taskManager.getAllTasks() || []; } catch (e) { tasks = []; }
  const recent = tasks
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 3)
    .map((t) => ({
      taskId: t.taskId,
      status: t.status || null,
      prompt: String(t.prompt || '').slice(0, 30),
      createdAt: t.createdAt || null
    }));
  let bud = null;
  try {
    const s = budget.status();
    bud = {
      currency: s.currency,
      initialUsd: s.initialUsd,
      spentUsd: s.spentUsd,
      balanceUsd: s.balanceUsd
    };
  } catch (e) {
    bud = null;
  }
  return {
    version: 'assistant-context.v1',
    plan: plan ? briefPlan(plan) : null,
    tasks: { total: tasks.length, recent },
    budget: bud,
    keys: keyPresence()
  };
}

function replyForContext(sessionId) {
  const ctx = contextOf(sessionId);
  const lines = [];
  lines.push(ctx.plan
    ? `当前计划：${ctx.plan.clipCount} 段 × ${ctx.plan.clipDurationSec} 秒（${ctx.plan.modelLabel} · ${ctx.plan.resolution}）· planId ${ctx.plan.planId}`
    : '当前计划：还没有计划卡。');
  lines.push(`任务：共 ${ctx.tasks.total} 个`
    + (ctx.tasks.recent.length
      ? `；最近 ${ctx.tasks.recent.map((t) => `${t.taskId}（${t.status || '未知'}）`).join('、')}`
      : ''));
  lines.push(ctx.budget
    ? `预算：剩余 $${Number(ctx.budget.balanceUsd).toFixed(2)}（已花 $${Number(ctx.budget.spentUsd).toFixed(2)}，初始 $${Number(ctx.budget.initialUsd).toFixed(2)}）`
    : '预算：读不到（budget 模块不可用）。');
  lines.push('Key：' + ctx.keys.map((k) => `${k.label} ${k.present ? '有' : '无'}`).join('；'));
  lines.push('（只读汇总：不会建任务、不会改任何东西；Key 只报有/无。）');
  return lines.join('\n');
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
function promptTextOfSegment(plan, index) {
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
      promptOverride: null
    });
    return { text: patch.prompt, source: 'scene-card', card };
  } catch (e) {
    return null;
  }
}

// A4：把第 N 段提示词原样贴出来。只读，不改计划、不建任务、不回传计划。
function tryReplyPromptView(sessionId, text) {
  const s = String(text || '');
  if (!RE_PROMPT_VIEW.test(s)) return null;
  if (RE_PROMPT_SET_VERB.test(s)) return null; // 「…提示词改成：X」走既有整段替换
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return '现在还没有计划卡，没有哪一段的提示词可看。先说总时长（比如「30 秒」「10 分钟」），我排好计划再贴给你。';
  }
  const n = resolvePromptTarget(sessionId, plan, s);
  if (!n) {
    return '要看第几段？说「把第 2 段的提示词给我看一下」；要改就说「第 2 段：把『A』改成『B』」。';
  }
  if (n < 1 || n > plan.clipCount) {
    return `这条计划只有 ${plan.clipCount} 段，没有第 ${n} 段。`;
  }
  const seg = promptTextOfSegment(plan, n - 1);
  if (!seg) {
    return `第 ${n} 段的场景卡读不到（卡库可能被替换），这条计划得重排；现在什么都没改。`;
  }
  const from = seg.source === 'user-edit'
    ? '来源：你手动改过的文本'
    : `来源：场景卡 ${seg.card ? seg.card.scene_key : ''}（按卡拼出）`;
  return `第 ${n} 段提示词（${seg.text.length} 字；${from}）：\n${seg.text}\n`
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

function replyForPlanEdit(sessionId, text) {
  const plan = memory.lastPlan(sessionId);
  if (!plan) {
    return '现在还没有计划卡，所以没有哪一段可改。先说总时长（比如「30 秒」「10 分钟」），'
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
    if (batch) return replyForBatchSwap(sessionId, plan);
    // 2026-11-16 Lead 复核：用户指代卡片（「这个地方的换一个」/「这一段不想要」）时没有段号，
    // 直接告诉他怎么补段号；不要掉回「这条视频要做多长」。
    // 2026-11-17 V1（A1/A2）：这里同时承担「场景/场景卡 + 换/改/不满意」的兜底，
    // 顺带说明「换卡 vs 改提示词」的区别（A2 的验收点）。
    return '要换第几段？说「第 2 段换一个」；改提示词就说「第 2 段提示词改成：……」，'
      + '或者「把第 2 段的提示词给我看一下」再「用这个：……」/「把『A』改成『B』」。';
  }
  const n = planCard.parseCnNumber(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > plan.clipCount) {
    return `这条计划只有 ${plan.clipCount} 段，没有第 ${m[1]} 段。`;
  }
  if (plan.sceneCards === false) {
    return '这条计划关了场景卡（自由提示词），不支持按段换卡/改提示词；'
      + '想要逐段控制，请新排一条带场景卡的（不要说「不要场景卡」）。';
  }
  const index = n - 1;
  const payload = extractPromptEditText(text);
  const promptHint = /提示词|画面/.test(text);
  const vague = !payload || RE_VAGUE_PAYLOAD.test(payload);
  if (promptHint && vague) {
    return `第 ${n} 段要改成什么？直接说「第 ${n} 段提示词改成：……」（每段最多 `
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
  const fromKey = oldCard ? oldCard.scene_key : oldId;
  const toKey = nextCard ? nextCard.scene_key : next.id;
  const chapterSeq = nextCard && Number.isInteger(nextCard.chapter) && Number.isInteger(nextCard.sequence)
    ? `（第 ${nextCard.chapter} 章-${nextCard.sequence}）` : '';
  return `已换第 ${n} 段：${fromKey} → ${toKey}${chapterSeq}\n`
    + `当前 ${plan.clipCount} 张场景卡：\n${formatSceneEntries(planSceneEntries(plan))}\n`
    + describeReply(plan);
}

// 2026-11-16 用户反馈（截图实证）：3 段计划看完卡后说「三个都想换掉」→ 原实现掉进 create 续问，
// 重排了一条新计划（回复「我按 30 秒排好了」）。这里改成**整批换卡**：
//   · planId 不变、不建任务、不重新 allocate；
//   · 逐段取「下一张未用过」的候选（与单段换卡同一规则），批内不重复；
//   · 任何一段取不到（卡库耗尽）就整批放弃、计划保持原样，不留下换了一半的状态。
function replyForBatchSwap(sessionId, plan) {
  if (plan.sceneCards === false) {
    return '这条计划关了场景卡（自由提示词），没有可换的卡；'
      + '想要逐段控制，请新排一条带场景卡的（不要说「不要场景卡」）。';
  }
  const currentIds = (Array.isArray(plan.sceneCardIds) && plan.sceneCardIds.length === plan.clipCount)
    ? plan.sceneCardIds.slice()
    : planSceneEntries(plan).map((e) => e.id);
  if (!currentIds.length) {
    return '这条计划还没有场景卡，没法整批换；先确认场景卡是开着的。';
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
      return `整批换卡失败（第 ${i + 1} 段）：${(e && e.message) || e}；计划没有改动。`;
    }
    const nextCard = sceneCardLibrary.getCardById(next.id);
    nextIds[i] = next.id;
    used.add(next.id);
    const fromKey = oldCard ? oldCard.scene_key : oldId;
    const toKey = nextCard ? nextCard.scene_key : next.id;
    const chapterSeq = nextCard && Number.isInteger(nextCard.chapter) && Number.isInteger(nextCard.sequence)
      ? `（第 ${nextCard.chapter} 章-${nextCard.sequence}）` : '';
    changes.push(`#${i + 1} ${fromKey} → ${toKey}${chapterSeq}`);
  }
  plan.sceneCardIds = nextIds;
  savePlanInPlace(sessionId, plan);
  const shown = changes.slice(0, SCENE_PREVIEW_LIMIT);
  if (changes.length > shown.length) shown.push(`…… 共 ${changes.length} 段，其余同样换了。`);
  return `已换掉全部 ${nextIds.length} 段：\n${shown.join('\n')}\n`
    + `当前 ${plan.clipCount} 张场景卡：\n${formatSceneEntries(planSceneEntries(plan))}\n`
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
  if (/(?:不用|不要|关闭|别用|取消)\s*(?:场景卡|配乐|音乐|出图|图片)/.test(s)) return false;
  if (/通道|设置|分辨率|\b1080p\b|\b720p\b|\b4k\b/i.test(s)) return false;
  return !!extractUseThisText(s) || parseDiffs(s).length > 0;
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
  // 2026-11-17 V1（A5/A6）：口语形态兜底（见 isPlanPromptEditForm 的注释）。
  const promptEditForm = isPlanPromptEditForm(text);
  const planEditBranch = intent.intent === 'plan_edit'
    || (promptEditForm && (intent.intent === 'unknown' || intent.intent === 'create'));
  const reportedIntent = planEditBranch ? 'plan_edit' : intent.intent;
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
  } else if (intent.intent === 'confirm') {
    // 2026-11-17 V1（§9.1-6 / A7）：最终确认时点 —— 只回确认语 + 回传计划（前端给卡片）。
    // 这里**不建任务**：建任务只能走 execute()，而 execute 只由卡片「确认执行」触发。
    reply = replyForConfirm(sessionId);
    plan = memory.lastPlan(sessionId);
  } else if (intent.intent === 'context') {
    // 2026-11-17 V1（§9.1-7）：只读环境问答（预算/任务数/Key 有·无）；不改计划、不回传计划。
    reply = replyForContext(sessionId);
  } else if (planEditBranch) {
    // 2026-11-16 P7-A：换单段场景卡 / 改单段提示词 —— 只改计划，不建任务。
    // 2026-11-17 V1（A4）：先看是不是「把第 N 段的提示词给我看」这种**纯只读**请求；
    // 是的话只贴原文、计划一个字节都不动，也不回传计划（前端据此不弹卡）。
    const viewed = tryReplyPromptView(sessionId, text);
    if (viewed) {
      reply = viewed;
    } else {
      reply = replyForPlanEdit(sessionId, text);
      // 2026-11-16 Lead 复核：把更新后的计划一并回传（planId 不变）。
      // 前端 sendXiaozhi 里的 `if (j.plan) setPlan(j.plan)` 依赖它刷新手上的计划卡；
      // 只回 null 时卡片仍是旧对象，用户会觉得「换了但没反应」。
      plan = memory.lastPlan(sessionId);
    }
  } else if (intent.intent === 'bgm') {
    // 2026-11-16 P7-A：配乐 —— 列库 / 选曲 / 关掉 / 设默认。
    reply = replyForBgm(sessionId, text);
    // 同上：选曲/关掉配乐后回传更新后的计划（planId 不变；无计划时仍是 null）。
    plan = memory.lastPlan(sessionId);
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
    intent: reportedIntent,
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
  // 2026-11-17 V1（§9.1-7）：只读环境的进程内入口（V2 扩成 HTTP 端点时直接复用）
  contextOf,
  keyPresence,
  _tick: tick,
  _attemptFill: attemptFill,
  _retryRun: retryRun,
  _startMonitor: startMonitor,
  _stopMonitor: stopMonitor
};
