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

function replyUnknown(lang) {
  if (i18n.normalizeLang(lang) === 'en') {
    return 'I can do three things: ① lay out a plan from the total length (scenes are drawn from the scene-card library; no theme needed); '
      + '② find your "last video"; ③ report current task progress. For example: 10 minutes / last video / progress.';
  }
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
  if (!state) {
    // 2026-11-17 V2（B1）：「现在跑到哪了？」要能回答**全局**任务，而不只是本会话自己的。
    // 只读 taskManager 快照；不建任务、不改任何状态。
    let live = [];
    try { live = assistantContext.contextOf(sessionId).tasks.active; } catch (e) { live = []; }
    if (live.length) {
      return `【小智简报】现在有 ${live.length} 个任务在跑（全局）：\n`
        + live.map((t) => `· ${t.taskId}：${t.status}，成功 ${t.successClips}/${t.totalClips} 段（${t.percent}%），当前 ${t.currentStep || '…'}`).join('\n')
        + '\n（只读播报：不会新建任务、不会重跑。）';
    }
    return '现在没有正在执行的任务。说个时长，我来排计划。';
  }
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

function replyForContext(sessionId, opts = {}) {
  const ctx = contextOf(sessionId, opts);
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
function replyForAssets(sessionId) {
  const ctx = contextOf(sessionId);
  const p = ctx.assets.photos;
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

function replyForRepair(sessionId) {
  const task = pickTaskForDiagnosis(sessionId);
  if (!task) {
    return {
      reply: '现在没有失败的任务可诊断。要我看别的任务，把任务 id 发我；'
        + '要排新计划就说总时长。这次只做了只读检查，没有建任务。',
      diagnosis: null
    };
  }
  const d = diagnose.diagnose(task);
  const lines = ['【小智简报】失败诊断（只读）：', d.summary, `分类：${d.categoryLabel}`
    + (d.failedClips.length ? `；失败片段 ${d.failedClips.map((f) => '#' + (f.index + 1)).join('、')}` : '')];
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

function replyForSettings(sessionId, text) {
  const change = parsePreferenceChange(text);
  if (!change) {
    return {
      reply: '要改哪一项设置？可以说：\n'
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
function handleMessage(opts = {}) {
  const text = String(opts.text || '').trim();
  // P3：助手话术语言（默认 zh → 现有中文回复逐字不变；en → 核心链路走英文模板）
  const lang = i18n.resolveLang(opts.lang);
  if (!text) return { ok: false, code: 'ASSISTANT_EMPTY_TEXT', error: '说点什么吧', lang };
  const session = memory.getOrCreate(opts.sessionId);
  const sessionId = session.id;
  memory.appendMessage(sessionId, { role: 'user', text });

  const intent = memory.classify(text);
  // 2026-11-17 V1（A5/A6）：口语形态兜底（见 isPlanPromptEditForm 的注释）。
  const promptEditForm = isPlanPromptEditForm(text);
  // 2026-11-17 V1 遗留 ⑤：关场景卡句（「去掉场景卡 / 场景卡不要了」）不是续问，
  // 不能被 isFollowUp 的「去掉」带进「按上次参数重排一条新计划」；与「不要场景卡」同一路径。
  const sceneCardsOff = memory.isSceneCardsOff(text);
  const planEditBranch = intent.intent === 'plan_edit'
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
    reply = replyForStatus(sessionId);
    replyKey = 'assistant.reply.status';
  } else if (intent.intent === 'plan_scenes') {
    // 2026-11-16 用户问题 a：问「选了哪几个场景」→ 只读预览，不重排计划、不占卡。
    reply = replyForPlanScenes(sessionId);
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
    const r = replyForRepair(sessionId);
    reply = r.reply;
    replyKey = 'assistant.reply.repair';
    diagnosis = r.diagnosis;
  } else if (intent.intent === 'settings') {
    // 2026-11-17 V2（B6）：设置变更（L3）→ 只返回 pendingChange，确认前什么都不改。
    const r = replyForSettings(sessionId, text);
    reply = r.reply;
    replyKey = 'assistant.reply.settings';
    pendingChange = r.pending;
  } else if (intent.intent === 'prefs') {
    // 2026-11-17 V2（B7）：读跨会话偏好（服务端用户级，换会话仍在）。
    const r = replyForPrefs(sessionId, { userId });
    reply = r.reply;
    replyKey = 'assistant.reply.prefs';
    preferencesView = r.preferences;
  } else if (intent.intent === 'assets') {
    // 2026-11-17 V2（B5）：素材库存（与 /api/photos 同口径）。
    reply = replyForAssets(sessionId);
    replyKey = 'assistant.reply.assets';
  } else if (intent.intent === 'context') {
    // 2026-11-17 V1（§9.1-7）/ V2（B4）：只读环境问答；不改计划、不回传计划。
    reply = replyForContext(sessionId, { userId });
    replyKey = 'assistant.reply.context';
  } else if (planEditBranch) {
    // 2026-11-16 P7-A：换单段场景卡 / 改单段提示词 —— 只改计划，不建任务。
    // 2026-11-17 V1（A4）：先看是不是「把第 N 段的提示词给我看」这种**纯只读**请求；
    // 是的话只贴原文、计划一个字节都不动，也不回传计划（前端据此不弹卡）。
    const viewed = tryReplyPromptView(sessionId, text);
    if (viewed) {
      reply = viewed;
      replyKey = 'assistant.reply.promptView';
    } else {
      reply = replyForPlanEdit(sessionId, text);
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
    reply = replyForLast(text);
    replyKey = 'assistant.reply.last';
  } else {
    // create / unknown 都尝试排计划；听不懂时 buildPlan 会返回明确的追问。
    const last = memory.lastPlan(sessionId);
    const parsed = planCard.parseUtterance(text);
    let input = { text, sessionId };
    // 只给了「槽位词」也算续问：例如单独说「1080p」「720p」「15 秒/段」——
    // 用户直觉是「改上次那个」，不该被当成"没说时长"再问一遍（2026-11-16 用户反馈）。
    const slotOnly = parsed.totalMinutes === null && parsed.clipCount === null
      && (parsed.resolution !== null || parsed.clipDurationSec !== null || parsed.model !== null);
    const follow = !sceneCardsOff && last && (isFollowUp(text) || isRepeat(text) || slotOnly);
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
    const isEn = lang === 'en';
    if (!built.ok) {
      if (built.missing || built.code === 'PLAN_NEED_DURATION') {
        missing = built.missing || ['totalMinutes'];
        // P3：英文模式给英文追问；中文模式沿用 planCard 原文（零回归）。
        reply = (isEn && built.code === 'PLAN_NEED_DURATION')
          ? 'How long should the video be? For example "30 seconds", "10 minutes", or "half an hour".'
          : (built.question || built.error);
        replyKey = 'assistant.question.duration';
        actions = [{ type: 'answer', labelKey: 'assistant.action.giveDuration' }];
      } else if (intent.intent === 'unknown') {
        reply = replyUnknown(lang) + (isEn ? '' : '\n（' + built.error + '）');
        replyKey = 'assistant.reply.unknown';
      } else {
        reply = built.error;
        replyKey = 'assistant.reply.planError';
      }
    } else {
      plan = built.plan;
      planCache.set(plan.planId, plan);
      memory.addPlan(sessionId, plan);
      reply = replyForPlan(plan, lang);
      replyKey = 'assistant.reply.plan';
      actions = [{ type: 'confirm', labelKey: 'assistant.action.confirmExecute', requiresApproval: true }];
    }
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
      state: stateMachine.summary(state),
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
      state: stateMachine.summary(state),
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
      state: stateMachine.summary(state),
      lang
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
        ...i18n.mark('api.tasks.insufficientBudget'),
        state: stateMachine.summary(state),
        lang
      };
    }
    const fp = makeFingerprint(plan);
    if (opts.force !== true) {
      const dup = submitGuard.check(fp);
      if (dup) {
        return {
          ok: false, code: 'DUPLICATE_TASK',
          error: `重复提交已拦截：${Math.ceil(submitGuard.WINDOW_MS / 60000)} 分钟内已创建过相同任务（${dup.taskId || '未知'}）`,
          ...i18n.mark('api.tasks.duplicate'),
          state: stateMachine.summary(state),
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
