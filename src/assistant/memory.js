// ==========================================
// 小智 · 记忆（P5）
// ------------------------------------------------------------
// 已定产品决策（handoff §7）：
//   · 记忆 = 会话内 + 任务检索（「上一次视频」用检索，不靠模型回忆）；
//   · 跨会话偏好属于第二阶段，本阶段不做。
//
// 本模块负责三件事：
//   1) 会话记忆落盘（data/assistant/sessions/<id>.json；ASSISTANT_DIR 可覆盖）；
//   2) 对话消息 / 计划卡 / 状态机快照的读写；
//   3) 确定性的任务检索（意图分类 + 按时间/主题过滤），不调用任何模型。
//
// 只做数据读写与规则判断，不发请求、不碰任务文件（任务数据由调用方传入）。
// ==========================================

'use strict';

const fs = require('fs');
const path = require('path');

const MEMORY_VERSION = 'assistant-memory.v1';
const MAX_MESSAGES = 200;
const MAX_PLANS = 8;
const MAX_SESSIONS_SCAN = 500;

const BASE_DIR = process.env.ASSISTANT_DIR
  ? path.resolve(process.env.ASSISTANT_DIR)
  : path.join(__dirname, '..', '..', 'data', 'assistant');
const SESSION_DIR = path.join(BASE_DIR, 'sessions');

function nowIso(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

function safeId(id) {
  const s = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(s)) {
    const e = new Error('会话 id 非法（只允许字母/数字/下划线/连字符，4–80 位）');
    e.code = 'SESSION_BAD_ID';
    throw e;
  }
  return s;
}

function newSessionId() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function sessionFile(id) {
  return path.join(SESSION_DIR, safeId(id) + '.json');
}

function ensureDir() {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) { /* 已存在/不可写由 save 报 */ }
}

function emptySession(id, now) {
  return {
    version: MEMORY_VERSION,
    id,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    messages: [],
    plans: [],
    states: {},
    lastTaskId: null
  };
}

function normalize(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    version: MEMORY_VERSION,
    id: String(session.id || ''),
    createdAt: session.createdAt || nowIso(),
    updatedAt: session.updatedAt || nowIso(),
    messages: Array.isArray(session.messages) ? session.messages.slice(-MAX_MESSAGES) : [],
    plans: Array.isArray(session.plans) ? session.plans.slice(-MAX_PLANS) : [],
    states: (session.states && typeof session.states === 'object') ? session.states : {},
    lastTaskId: session.lastTaskId || null
  };
}

function load(id) {
  try {
    const raw = fs.readFileSync(sessionFile(id), 'utf8');
    return normalize(JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

function save(session) {
  if (!session || !session.id) {
    const e = new Error('保存会话需要 id');
    e.code = 'SESSION_BAD_ID';
    throw e;
  }
  ensureDir();
  const file = sessionFile(session.id);
  const tmp = file + '.tmp';
  const data = normalize({ ...session, updatedAt: nowIso() });
  if (data.messages.length > MAX_MESSAGES) data.messages = data.messages.slice(-MAX_MESSAGES);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return data;
}

function getOrCreate(id, options = {}) {
  const sid = id ? safeId(id) : newSessionId();
  const existing = id ? load(sid) : null;
  if (existing) return existing;
  const session = emptySession(sid, options.now);
  save(session);
  return session;
}

function appendMessage(idOrSession, msg, options = {}) {
  const session = typeof idOrSession === 'string'
    ? getOrCreate(idOrSession, options)
    : normalize(idOrSession) || null;
  if (!session) throw new Error('appendMessage 需要会话 id 或会话对象');
  const entry = {
    role: msg && msg.role === 'assistant' ? 'assistant' : 'user',
    text: String((msg && msg.text) || '').slice(0, 4000),
    kind: (msg && msg.kind) || 'chat',
    at: msg && msg.at ? msg.at : nowIso(options.now)
  };
  if (!entry.text) return session;
  session.messages.push(entry);
  if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = nowIso();
  save(session);
  return session;
}

function appendMessages(id, list, options = {}) {
  for (const m of Array.isArray(list) ? list : []) appendMessage(id, m, options);
  return load(id) || getOrCreate(id, options);
}

function addPlan(id, plan) {
  const session = getOrCreate(id);
  if (!plan || !plan.planId) throw new Error('addPlan 需要计划卡');
  // 同 id 覆盖（重算计划时不留重复）
  session.plans = session.plans.filter((p) => p && p.planId !== plan.planId);
  session.plans.push(plan);
  if (session.plans.length > MAX_PLANS) session.plans = session.plans.slice(-MAX_PLANS);
  session.updatedAt = nowIso();
  save(session);
  return plan;
}

function lastPlan(id) {
  const session = load(id);
  if (!session || session.plans.length === 0) return null;
  return session.plans[session.plans.length - 1];
}

function getPlan(id, planId) {
  const session = load(id);
  if (!session) return null;
  return session.plans.find((p) => p && p.planId === planId) || null;
}

function setState(id, state) {
  const session = getOrCreate(id);
  if (!state || !state.planId) throw new Error('setState 需要带 planId 的状态机快照');
  session.states[state.planId] = state;
  session.lastTaskId = state.taskId || session.lastTaskId;
  session.updatedAt = nowIso();
  save(session);
  return state;
}

function getState(id, planId) {
  const session = load(id);
  if (!session) return null;
  if (planId) return session.states[planId] || null;
  const keys = Object.keys(session.states);
  if (!keys.length) return null;
  return session.states[keys[keys.length - 1]];
}

function getSession(id) {
  return load(id);
}

function listMessages(id, limit = 50) {
  const session = load(id);
  if (!session) return [];
  return session.messages.slice(-Math.max(1, Math.min(MAX_MESSAGES, Number(limit) || 50)));
}

// 会话扫描（给「跨会话」预留；本阶段只用于调试/清理，不做偏好）。
function listSessions(limit = 20) {
  try {
    if (!fs.existsSync(SESSION_DIR)) return [];
    const names = fs.readdirSync(SESSION_DIR).filter((n) => /\.json$/i.test(n)).slice(0, MAX_SESSIONS_SCAN);
    const list = [];
    for (const name of names) {
      const s = load(name.replace(/\.json$/i, ''));
      if (s) list.push({ id: s.id, updatedAt: s.updatedAt, messages: s.messages.length, plans: s.plans.length });
    }
    return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, limit);
  } catch (e) {
    return [];
  }
}

// ==========================================
// 意图分类（确定性，仅用于「小智」对话规则）
// ==========================================
const RE_GREETING = /^(?:你好|您好|hi|hello|嗨|哈喽|小智|在吗|在不在)[!！。,.，\s]*$/i;
const RE_LAST = /上一次|上一次的|上个|上一条|上条|最近.{0,6}(?:视频|成片|任务)|刚才.{0,4}(?:那个|视频|任务)|最后.{0,4}(?:一个|一条)?\s*(?:视频|成片)/;
const RE_STATUS = /进度|到哪|跑到|状态|完成了吗|好了没|还要多久/;
// 2026-11-16 Lead：用户新意图「看计划用了哪些场景卡」。
// 触发例：「你可以给我看一下你选择的是哪三个场景吗」「选了哪些场景卡」「场景是哪几个」。
// 注意必须要求疑问词，避免把「10 分钟，场景从卡库选」这类排计划的话误判成查场景。
const RE_PLAN_SCENES = /(?:哪|几|哪些|什么)[^。，,；;？?!！]{0,6}?场景|场景卡?\s*(?:是|有|抽|选|用)\s*(?:哪|几|什么|哪些)|(?:看看|看一下|给我看|展示|预览|列一下|瞧一眼).{0,8}场景|场景.{0,6}(?:预览|列表|看看|给我看|列一下|有哪)/;
// 2026-11-16 Lead：用户新意图「切纯文生视频（不要出图）」。
// 只认明确的「不出图」表达，不抢「文生图 → 图生视频」这类正常排计划描述。
const RE_NO_IMAGE = /(?:不要|不用|别|取消|关闭|关掉|去掉|免了?)\s*(?:再)?\s*(?:逐段出图|出图|图片|配图|生成图|插图)|(?:纯|只|直接)\s*(?:用|走|要|做|跑|出)?\s*文生视频|文生视频\s*(?:模式|就行|即可|好了|可以吗|能用吗|能选吗|能切吗)|不出图|无图模式|(?:选择|选|切|换|改成?|用)\s*(?:纯)?\s*文生图(?:的)?模式|文生图\s*模式/;
const RE_CREATE = /(?:做|拍|生成|来|搞|安排|剪).{0,6}(?:一条|一个|一部)?|(?:分钟|小时|秒|段)/;
// 2026-11-16 P7-A：计划内精准修改（换单段场景卡 / 改单段提示词）。
// 必须**同时**出现「第 N 段/个/张」与编辑动词才进本意图，避免抢走
// 「改成 1080p」「每段 15 秒」「再来一条」「不要场景卡」这些既有续问路径。
const RE_SEGMENT_REF = /第\s*(?:\d+|[零〇一二两三四五六七八九十百]+)\s*(?:个)?\s*(?:段|镜头|场景|张|条|画面)/;
const RE_SEGMENT_EDIT = /提示词|画面|改成|换成|改为|写成|换掉|换一|换张|换一个|换一张|重换|替换|不想要|不满意|不要按卡|调整/;
// 2026-11-16 P7-A：配乐（列库 / 用第 N 首 / 换一首 / 不要配乐 / 设为默认）。
// 「用第 3 首」这类说法不含「配乐」二字，但含「第 N 首」，一并归到配乐意图。
const RE_BGM = /配乐|背景音乐|\bbgm\b|曲目|曲名|换一首|换首|换一曲|音乐|(?:用|选|要|放|听|换)?\s*第\s*(?:\d+|[零〇一二两三四五六七八九十百]+)\s*首/;

function classify(text) {
  const s = String(text || '').trim();
  if (!s) return { intent: 'unknown', reason: 'empty' };
  if (RE_GREETING.test(s)) return { intent: 'greeting' };
  if (RE_STATUS.test(s)) return { intent: 'status' };
  if (RE_LAST.test(s)) return { intent: 'last' };
  // 2026-11-16：查「选了哪些场景卡」不排新计划（只读预览）；「不要出图」只回开关位置。
  if (RE_PLAN_SCENES.test(s)) return { intent: 'plan_scenes' };
  if (RE_NO_IMAGE.test(s)) return { intent: 'no_image' };
  // 2026-11-16 P7-A：计划内修改必须排在 create 之前（否则「第 2 个场景换一个」会被当成新计划重排）；
  // 但只能匹配带「第 N 段/个」的句子，不能抢「改成 1080p」「每段 15 秒」「再来一条」。
  if (RE_SEGMENT_REF.test(s) && RE_SEGMENT_EDIT.test(s)) return { intent: 'plan_edit' };
  if (RE_BGM.test(s)) return { intent: 'bgm' };
  if (RE_CREATE.test(s)) return { intent: 'create' };
  return { intent: 'unknown' };
}

// ==========================================
// 任务检索
// ==========================================
function taskRef(task, kind = 'task') {
  if (!task) return null;
  const prompt = String(task.prompt || '').replace(/\s+/g, ' ').trim();
  return {
    kind,
    id: task.taskId || task.id || null,
    taskId: task.taskId || null,
    prompt,
    status: task.status || null,
    theme: task.theme || null,
    model: task.model || null,
    createdAt: task.createdAt || null,
    completedAt: task.completedAt || null,
    durationSec: Number(task.totalDuration) || (Number(task.clipDuration) || 0) * (Number(task.totalClips) || 0) || null,
    hasOutput: !!(task.outputPath || task.finalPath || task.filePath),
    fileName: task.outputPath || task.finalPath || task.filePath
      ? path.basename(String(task.outputPath || task.finalPath || task.filePath))
      : null
  };
}

const THEME_WORDS = {
  aurora: ['极光'],
  mountain: ['雪山', '冰川', '雪峰'],
  desert: ['沙漠', '沙丘', '荒漠'],
  space: ['星空', '银河', '星云'],
  ocean: ['海岸', '礁岩', '海边'],
  forest: ['森林', '树林'],
  lake: ['湖泊', '盐湖'],
  waterfall: ['瀑布'],
  landscape: ['风光', '风景']
};

function themeHit(query, ref) {
  const text = String(query || '').toLowerCase();
  const hay = ((ref.prompt || '') + ' ' + (ref.theme || '')).toLowerCase();
  for (const words of Object.values(THEME_WORDS)) {
    for (const w of words) {
      if (text.includes(w.toLowerCase())) return hay.includes(w.toLowerCase());
    }
  }
  return null; // 没有主题词 → 不按主题过滤
}

function normalizeTime(task) {
  const t = new Date(task.completedAt || task.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

// 有序号词（上一次 / 上上次 / 前几次）时取第 N 近。
function ordinalIndex(query) {
  if (/上上次|上上条|上上一条/.test(query)) return 1;
  if (/上上上次/.test(query)) return 2;
  return 0;
}

/**
 * 检索任务（不调用模型）。
 * @param {object} opts { query, tasks:[], finals:[], limit? }
 * @returns {{intent, refs, total, reason?}}
 */
function retrieveTasks(opts = {}) {
  const query = String(opts.query || '');
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 5));
  const tasks = (Array.isArray(opts.tasks) ? opts.tasks : [])
    .filter((t) => t && t.taskId)
    .map((t) => taskRef(t));
  const finals = (Array.isArray(opts.finals) ? opts.finals : [])
    .filter((f) => f && f.kind === 'final')
    .map((f) => taskRef(f, 'final'));
  const all = tasks.concat(finals);
  const cls = classify(query);
  const intent = cls.intent === 'unknown' ? (opts.intent || 'unknown') : cls.intent;

  if (intent === 'status') {
    const live = tasks.filter((r) => r.status && !['completed', 'partial', 'failed'].includes(r.status));
    const pool = live.length ? live : tasks;
    pool.sort((a, b) => normalizeTime(b) - normalizeTime(a));
    return { intent, refs: pool.slice(0, limit), total: pool.length, live: live.length };
  }

  // last / create / unknown 都用同一套「按时间倒序 + 可选主题过滤」
  let pool = all;
  const hit = themeHit(query, { prompt: query, theme: '' }); // 查询里出现主题词？
  if (hit !== null) {
    pool = pool.filter((r) => themeHit(query, r) === true);
  }
  pool = pool.filter((r) => !!r.id);
  pool.sort((a, b) => normalizeTime(b) - normalizeTime(a));

  if (intent === 'last') {
    // 「上一次的视频」优先指**有产物/已完成**的记录：正在生成的任务不该抢答。
    const finished = pool.filter((r) => r.hasOutput || ['completed', 'partial'].includes(r.status));
    const use = finished.length ? finished : pool;
    const idx = Math.min(ordinalIndex(query), Math.max(0, use.length - 1));
    const slice = use.slice(idx, idx + limit);
    return { intent, refs: slice, total: use.length, ordinal: idx };
  }
  return { intent, refs: pool.slice(0, limit), total: pool.length };
}

function formatWhen(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

module.exports = {
  MEMORY_VERSION,
  BASE_DIR,
  SESSION_DIR,
  MAX_MESSAGES,
  newSessionId,
  safeId,
  sessionFile,
  getOrCreate,
  load,
  save,
  appendMessage,
  appendMessages,
  addPlan,
  lastPlan,
  getPlan,
  setState,
  getState,
  getSession,
  listMessages,
  listSessions,
  classify,
  retrieveTasks,
  taskRef,
  formatWhen
};
