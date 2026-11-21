// ==========================================
// 小智 · 确定性状态机（P5）
// ------------------------------------------------------------
// 已定产品决策（handoff §7）：执行 / 失败处理由确定性状态机做，**不问模型**。
//   · 质检最多自动重试 2 次（plan.estimate.autoQcRetries 已按 10% 预算上限收紧）；
//   · 仍失败 → 从片段库补位（≤5% 且 ≤10 段）；
//   · 还不行 → 交给用户（needs_user），不换备用模型。
//
// 本模块是纯函数：不读任务、不写文件、不发请求。supervisor 负责按真实事件
// 调用 transition()，并把返回的 state 存进会话记忆。非法转移抛错（带 code），
// 不做「静默兜底」——静默兜底会让 UI 显示一个与真实情况不同的阶段。
// ==========================================

'use strict';

const MACHINE_VERSION = 'assistant-state.v1';

const STATES = Object.freeze({
  DRAFT: 'draft',
  PLANNED: 'planned',
  CONFIRMED: 'confirmed',
  SUBMITTED: 'submitted',
  RUNNING: 'running',
  RETRYING: 'retrying',
  FILLING: 'filling',
  DONE: 'done',
  FAILED: 'failed',
  NEEDS_USER: 'needs_user'
});

const TERMINAL = new Set([STATES.DONE, STATES.FAILED, STATES.NEEDS_USER]);

const LABELS = Object.freeze({
  draft: '草稿',
  planned: '计划已生成',
  confirmed: '已确认',
  submitted: '已提交',
  running: '生成中',
  retrying: '质检重试中',
  filling: '片段补位中',
  done: '已完成',
  failed: '失败',
  needs_user: '需要你决定'
});

// 2026-11-21：状态条标签的英文（中文逐字不变；未覆盖的状态原样回退中文）。
const LABELS_EN = Object.freeze({
  draft: 'Draft',
  planned: 'Plan ready',
  confirmed: 'Confirmed',
  submitted: 'Submitted',
  running: 'Generating',
  retrying: 'Retrying (QC)',
  filling: 'Filling failed clips',
  done: 'Completed',
  failed: 'Failed',
  needs_user: 'Needs your decision'
});

function labelFor(stateName, lang) {
  const zh = LABELS[stateName] || stateName;
  if (String(lang || '').toLowerCase().startsWith('en')) return LABELS_EN[stateName] || zh;
  return zh;
}

// 允许的转移表：from → { event: to }
const TRANSITIONS = Object.freeze({
  draft: { PLAN: 'planned' },
  planned: { CONFIRM: 'confirmed', PLAN: 'planned', RESET: 'planned' },
  confirmed: { SUBMIT: 'submitted', NEED_USER: 'needs_user', RESET: 'planned' },
  submitted: { RUNNING: 'running', NEED_USER: 'needs_user', FAIL: 'failed', RESET: 'planned' },
  running: {
    RETRY: 'retrying',
    FILL: 'filling',
    COMPLETE: 'done',
    FAIL: 'failed',
    NEED_USER: 'needs_user',
    RESET: 'planned'
  },
  retrying: {
    RUNNING: 'running',
    FILL: 'filling',
    COMPLETE: 'done',
    FAIL: 'failed',
    NEED_USER: 'needs_user',
    RESET: 'planned'
  },
  filling: {
    COMPLETE: 'done',
    FAIL: 'failed',
    NEED_USER: 'needs_user',
    RESET: 'planned'
  },
  done: { RESET: 'planned' },
  failed: { RESET: 'planned', NEED_USER: 'needs_user' },
  needs_user: { RESET: 'planned' }
});

function nowIso(now) {
  const d = now ? new Date(now) : new Date();
  return d.toISOString();
}

function illegal(from, type, reason) {
  const e = new Error(`状态机不允许：${from} --${type}-->${reason || '?'}`);
  e.code = 'STATE_ILLEGAL_TRANSITION';
  e.from = from;
  e.event = type;
  return e;
}

function guardCode(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function create(plan, options = {}) {
  if (!plan || typeof plan !== 'object' || !plan.planId) {
    throw guardCode('STATE_BAD_PLAN', '状态机需要带 planId 的计划卡');
  }
  return {
    version: MACHINE_VERSION,
    planId: plan.planId,
    sessionId: plan.sessionId || options.sessionId || null,
    taskId: null,
    finalTaskId: null,
    state: STATES.PLANNED,
    createdAt: nowIso(options.now),
    updatedAt: nowIso(options.now),
    retries: 0,
    retrySpendCny: 0,
    fills: 0,
    fillRate: 0,
    reason: null,
    lastError: null,
    events: [{
      at: nowIso(options.now),
      type: 'PLAN',
      from: STATES.DRAFT,
      to: STATES.PLANNED,
      note: '计划卡生成'
    }],
    plan
  };
}

/**
 * 执行一次状态转移（纯函数，返回新对象，不修改入参）。
 * @param {object} state
 * @param {string} type 事件名
 * @param {object} payload { taskId?, approved?, reason?, costCny?, fillCount?, now? }
 * @returns {{state:object, event:object}}
 */
function transition(state, type, payload = {}) {
  if (!state || typeof state !== 'object') throw guardCode('STATE_BAD_STATE', '没有状态机实例');
  const from = state.state;
  const row = TRANSITIONS[from];
  const to = row && row[type];
  if (!to) throw illegal(from, type);

  const plan = state.plan || {};
  const est = plan.estimate || {};
  const now = nowIso(payload.now);

  // ---- 业务闸门（确定性，不看模型/用户情绪）----
  if (type === 'CONFIRM' && plan.requiresPaymentApproval && payload.approved !== true) {
    throw guardCode('STATE_PAYMENT_NOT_APPROVED', '这是付费任务，必须先确认费用才能执行');
  }
  if (type === 'RETRY') {
    const allowed = Number.isFinite(est.autoQcRetries) ? est.autoQcRetries : 0;
    if (state.retries + 1 > allowed) {
      throw guardCode('STATE_RETRY_LIMIT',
        `自动重试已达上限（计划允许 ${allowed} 次：≤2 次且重试费用 ≤总预算 10%）`);
    }
    const cost = Number(payload.costCny) || 0;
    const cap = Number(est.retryCapCny) || 0;
    if (state.retrySpendCny + cost > cap + 1e-9) {
      throw guardCode('STATE_RETRY_BUDGET',
        `重试费用会超过总预算 10%（上限 ¥${cap.toFixed(2)}，已用 ¥${state.retrySpendCny.toFixed(2)}，本次 ¥${cost.toFixed(2)}）`);
    }
  }
  if (type === 'FILL') {
    const allowed = Number.isFinite(plan.fillMaxClips) ? plan.fillMaxClips : 0;
    const asked = Number(payload.fillCount) || 1;
    if (state.fills + asked > allowed) {
      throw guardCode('STATE_FILL_LIMIT',
        `补位超过上限（计划允许 ${allowed} 段：≤5% 且 ≤10 段；已补 ${state.fills} 段）`);
    }
  }

  const next = {
    ...state,
    state: to,
    updatedAt: now,
    plan: state.plan,
    events: state.events.concat([{
      at: now,
      type,
      from,
      to,
      note: payload.reason || null
    }])
  };

  if (payload.taskId) next.taskId = payload.taskId;
  if (payload.finalTaskId) next.finalTaskId = payload.finalTaskId;
  if (type === 'RETRY') {
    next.retries = state.retries + 1;
    next.retrySpendCny = Math.round((state.retrySpendCny + (Number(payload.costCny) || 0)) * 100) / 100;
  }
  if (type === 'FILL') {
    const n = Number(payload.fillCount) || 1;
    next.fills = state.fills + n;
    next.fillRate = plan.clipCount > 0 ? Math.round((next.fills / plan.clipCount) * 10000) / 10000 : 0;
  }
  if (type === 'COMPLETE') {
    next.reason = null;
  }
  if (type === 'FAIL' || type === 'NEED_USER') {
    next.reason = payload.reason || null;
    next.lastError = payload.error || null;
  }
  if (type === 'RESET') {
    next.state = STATES.PLANNED;
    next.taskId = null;
    next.finalTaskId = null;
    next.retries = 0;
    next.retrySpendCny = 0;
    next.fills = 0;
    next.fillRate = 0;
    next.reason = null;
    next.lastError = null;
  }
  return next;
}

// 记录「观察到的」流水线内部重试次数（pipeline 自己的重试，不是状态机触发的）。
// 只用于如实展示，不改状态、不参与闸门；闸门只看 transition('RETRY')。
function observe(state, snapshot = {}) {
  if (!state) return null;
  return {
    ...state,
    observed: {
      ...(state.observed || {}),
      ...snapshot
    },
    updatedAt: nowIso(snapshot.now)
  };
}

// 给 UI 的简要快照（不含计划卡全文，避免响应体膨胀）。
// 2026-11-21 用户报「英文界面下状态条还是中文『需要你决定』」：
// label 是中文，前端以前直接显示它。现在额外给 labelKey（xiaozhi.state.<state>），
// 前端优先用它本地化；label 保留原中文（旧调用方/日志零回归）。
function labelKeyOf(stateName) {
  return stateName ? `xiaozhi.state.${stateName}` : null;
}

function summary(state, lang) {
  if (!state) return null;
  return {
    version: state.version,
    planId: state.planId,
    state: state.state,
    label: labelFor(state.state, lang),
    labelZh: LABELS[state.state] || state.state,
    labelKey: labelKeyOf(state.state),
    terminal: TERMINAL.has(state.state),
    taskId: state.taskId,
    finalTaskId: state.finalTaskId,
    retries: state.retries,
    retrySpendCny: state.retrySpendCny,
    retryAllowed: state.plan && state.plan.estimate ? state.plan.estimate.autoQcRetries : 0,
    retryCapCny: state.plan && state.plan.estimate ? state.plan.estimate.retryCapCny : 0,
    fills: state.fills,
    fillAllowed: state.plan ? state.plan.fillMaxClips : 0,
    fillRate: state.fillRate,
    reason: state.reason,
    lastError: state.lastError,
    observed: state.observed || null,
    updatedAt: state.updatedAt,
    events: state.events.slice(-12)
  };
}

module.exports = {
  MACHINE_VERSION,
  STATES,
  TERMINAL,
  LABELS,
  LABELS_EN,
  labelFor,
  labelKeyOf,
  TRANSITIONS,
  create,
  transition,
  observe,
  summary
};
