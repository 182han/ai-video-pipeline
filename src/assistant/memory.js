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
// 2026-11-16 Lead 收口：配乐是**编辑动作**，不能把「10 分钟，配点轻音乐」这类创建句抢走。
// 归 bgm 的条件（任一）：
//   ① 配乐名词（配乐/背景音乐/BGM/曲目/曲名/音乐）+ 明确动作（有哪些/换成/不要/设为默认…）；
//   ② 「第 N 首」且没有时长词（= 列库后的选曲上下文）；
//   ③ 换一首/换首/换一曲/再来一首（且不是创建句）。
const RE_BGM_NOUN = /配乐|背景音乐|\bbgm\b|曲目|曲名|音乐/i;
const RE_BGM_ACTION = /有哪些|有什么|哪几首|换成|改成|改为|用第|选第|要第|放第|听第|设为默认|设成默认|默认配乐|不要|关掉|关闭|取消|去掉|换掉|换个/;
const RE_BGM_INDEX = /第\s*(?:\d+|[零〇一二两三四五六七八九十百]+)\s*首/;
const RE_BGM_SWAP = /换一首|换首|换一曲|再来一首/;
const RE_TIME_WORD = /(?:分钟|小时|秒|段)/;
// 2026-11-16 Lead 收口：用户指着卡片说「不想要这个地方的换一个」时没有「第 N 段」。
// 这类指代 + 换卡动作 → plan_edit（supervisor 回「要换第几段？」），不要再掉进"问时长"。
// 2026-11-16 Lead 复核补充：同时覆盖「这一段/这一张/那一段」等常见口语（原来只认「这段」，
// 「这一段不想要」会因含「段」被 RE_CREATE 抢成 create）。
const RE_SEGMENT_VAGUE = /(?:这|那)(?:个地方|里|块|张卡|张|个场景|段|一段|一张)|那条/;
const RE_SEGMENT_SWAP_WORD = /换一个|换一张|换个|换掉|换成别的|换别的|不想要|不满意|不要这个/;
// 2026-11-16 用户反馈（截图实证）：看完整批 3 张卡后说「三个都想换掉」→ 被 create 分支
// 当成续问重排了一条新计划（回复「我按 30 秒排好了」），应该**整批换卡**、planId 不变。
// 判定：批量指代（都/全部/三个/三张/这批/整批/整个/重抽…）+ 换卡动作
// （换掉/换一个/换一批/要换（非「要换成」）/不满意/不想要…），且**不是配乐句**。
// 故意不收「改成/换成（+分辨率）」这类词，避免抢「都换成 1080p」的分辨率续问。
const RE_SEGMENT_BATCH_REF = /都|全部|全都|全换|三个|三张|3\s*[个张]|这几[个张]|这两个|这一批|这批|整批|一批|这一?组|一组|整组|整个|重抽|重新抽|重新选/;
const RE_SEGMENT_BATCH_SWAP = /换掉|换一个|换一张|换一批|换一组|再换一组|重新来一组|重来一组|再来一组|换个|全换|重抽|重新抽|重新选|换成别的|换别的|不满意|不想要|不要了|要换(?![成为])|都换(?![成为])/;

// 2026-11-18 用户报「提示词看一下 → 小智却问这条视频要做多长」：
// 「提示词 + 查看动词」在**没有段号**时原来 classify 返回 unknown，落到 supervisor 的 else
// 分支 → planCard.buildPlan → PLAN_NEED_DURATION。这里把它归入 plan_edit，让 supervisor 的
// tryReplyPromptView 接住（有当前计划就只读展示，不新建计划、不问时长）。
// 注意护栏：「提示词改成/换成/：」是修改动作，不是查看，不在此列（仍走既有 plan_edit 路径）。
const RE_PROMPT_VIEW_NOUN = /提示词|画面内容/;
const RE_PROMPT_VIEW_VERB = /给我看|看一下|看下|看看|贴一下|贴出来|是什么|是啥|显示|念一下|读一下|发我|瞧一眼/;
const RE_PROMPT_SET_VERB = /(?:提示词|画面内容)\s*(?:改成|换成|改为|写成|[:：])/;

function isPromptViewRequest(text) {
  const s = String(text || '');
  if (!RE_PROMPT_VIEW_NOUN.test(s)) return false;
  if (!RE_PROMPT_VIEW_VERB.test(s)) return false;
  if (RE_PROMPT_SET_VERB.test(s)) return false;
  return true;
}
// 2026-11-17 小智 2.0 V1（设计定稿 §9.1-1）：plan_edit 的**第 4 个入口**。
// 用户真实原话（截图实证）：「换一个场景卡，我不太满意。」「场景不太满意，场景卡就是提示词的内容。」
// 两句都没有「第 N 段」，所以进不了既有三个分支，会掉进 create 被重排成新计划（错）。
// 判定 = 场景宾语 && 换卡/改动词，且**同时**满足三个护栏（这就是 A8/A9/A10 不误伤的全部逻辑）：
//   · 带时长/段数词（秒/分钟/小时/段）→ 是排计划，不是改卡（A8「换一个场景，30 秒」→ create）；
//   · 带配乐名词 → 交给 bgm（A10「配乐换一首」→ bgm，不许被这里抢）；
//   · 带分辨率词（1080p/720p…）→ 是画质续问，不按段编辑；
//   · 「不要场景卡/不用场景卡」→ 是关开关（保持既有 unknown/no_image 路径），不是换卡。
const RE_SCENE_NOUN = /场景/;
// 「不太满意 / 不满意 / 满意吗」都算，但单独一个「满意」不算（那是夸，不是要改）。
const RE_SCENE_ACTION = /不太?满意|满意吗|满意不|不想要|换|改|重抽|重新抽/;
const RE_RESOLUTION_WORD = /\d{3,4}\s*p\b|1080p|720p|480p|4k|2160p|分辨率/i;
// 2026-11-17 V1 遗留 ⑤：关场景卡的语序补全。
// 原来只认动词在前（不要/不用/关闭/别用/取消 + 场景卡），用户真实语序还有两种：
//   · 「去掉场景卡」（去掉/删掉 + 场景卡）——旧实现漏掉，会被 supervisor 的 diff 正则
//     当成「删除提示词内容」，回一句「已改第 N 段」；
//   · 「场景卡不要了」（场景卡 + 不要了/不用了/关掉/去掉）——宾语前置。
const RE_SCENE_CARDS_OFF = /(?:(?:不用|不要|关闭|别用|取消|去掉|删掉)\s*(?:了)?\s*场景卡|场景卡\s*(?:不要了?|不用了?|关闭|关掉|取消|去掉|删掉))/;

function isSceneCardsOff(text) {
  return RE_SCENE_CARDS_OFF.test(String(text || ''));
}

function isSceneCardEdit(text) {
  const s = String(text || '');
  if (!RE_SCENE_NOUN.test(s)) return false;
  if (!RE_SCENE_ACTION.test(s)) return false;
  if (RE_TIME_WORD.test(s)) return false;
  if (RE_BGM_NOUN.test(s)) return false;
  if (RE_RESOLUTION_WORD.test(s)) return false;
  if (isSceneCardsOff(s)) return false;
  return true;
}

function isBatchSceneEdit(text) {
  const s = String(text || '');
  return RE_SEGMENT_BATCH_REF.test(s) && RE_SEGMENT_BATCH_SWAP.test(s) && !RE_BGM_NOUN.test(s);
}

// 2026-11-17 小智 2.0 V1（§9.1-6）：最终确认时点（A7）。
// 「确认生成吗？」现在会被 RE_CREATE 的「生成」抢走 → 回「这条视频要做多长？」（用户看到的答非所问）。
// 这里只认**明确的确认/开工问句**，不动「生成一条 10 分钟的视频」这类排计划句。
const RE_CONFIRM = /(?:确认|确定)\s*(?:生成|执行|开始|开工|做吧)|(?:可以|能|要不要|需不需要)\s*(?:开始|生成|执行|开工)\s*(?:了|吗|嘛|吧)?|现在(?:就)?(?:开始|开工|生成)|(?:开始|开工|执行)吧/;

function isConfirmRequest(text) {
  return RE_CONFIRM.test(String(text || ''));
}

// 2026-11-17 小智 2.0 V1（§9.1-7）：只读环境问答（预算 / 任务数 / Key 有·无）。
// 只认显式名词，避免把「10 分钟，预算 100」这类排计划句抢成环境问答（见 classify 的优先级注释）。
const RE_CTX_BUDGET = /预算|余额|花了多少|花了多少钱|花费|还剩多少(?:钱|美元|额度|预算)/;
const RE_CTX_TASKS = /(?:几个|多少个|多少条|哪些|几条)\s*任务|任务(?:数量|列表|几个)|最近.{0,4}任务|在跑的任务|正在跑的任务/;
const RE_CTX_KEY = /(?:api\s*key|key|密钥|秘钥)/i;
const RE_CTX_KEY_ASK = /有没有|有吗|有没|配了|配置|填了|可用|能用|能不能用|是否/;

function isContextQuery(text) {
  const s = String(text || '');
  if (RE_CTX_BUDGET.test(s) || RE_CTX_TASKS.test(s)) return true;
  return RE_CTX_KEY.test(s) && RE_CTX_KEY_ASK.test(s);
}

// ==========================================
// 2026-11-17 小智 2.0 V2（设计文档 §8.3 B1–B8）：
//   ④ repair   —— 失败诊断（B2）：「这条为什么失败？」「怎么修」「补跑」
//   ⑤ settings —— 设置变更（B6）：「把默认通道改成百炼」「把任务播报关掉」「清空偏好」
//   ⑥ prefs    —— 读跨会话偏好（B7）：「用我常用的设置」
//   ⑦ assets   —— 素材库存（B5）：「图片库还有多少能用的？」
// 放在 V1 的 plan_edit / bgm 之后、context / create 之前：只认显式词，
// 不能抢「改成 1080p」（V1 断言仍是 unknown）、「配乐有哪些」（bgm）、「你选了哪些场景卡」（plan_scenes）。
// ==========================================
const RE_REPAIR = /(?:为什么|为何|怎么|咋)\s*(?:会)?\s*(?:失败|没成|没成功|没出片|挂了)|失败\s*(?:原因|了|怎么办)|诊断|(?:怎么|如何|帮我)\s*(?:修|修复|解决)|修复建议|一键修复|补跑|重跑/;
const RE_SETTINGS_CHANGE = /(?:默认|全局)\s*(?:通道|模型|分辨率|配乐风格)|(?:通道|模型|分辨率|设置)\s*(?:改成|改为|换成|设成|设为)|任务播报|播报\s*(?:关掉|关闭|打开|开启|恢复|开|停)|清空\s*(?:我的)?\s*(?:跨会话)?\s*(?:偏好|常用设置|常用偏好)|清除\s*(?:偏好|常用设置)/i;
const RE_PREFS = /用我常用的设置|用我常用的|我常用的设置|常用设置是什么|我的(?:跨会话)?偏好|偏好是什么|跨会话偏好|上次的设置/;
const RE_ASSETS = /图片库|图片库存|素材(?:库)?\s*(?:还有|剩|有多少)|能用的图片|多少张(?:能用的)?图|成片库|片段库|场景卡\s*(?:还有|剩|库存)/;

function isRepairQuery(text) {
  return RE_REPAIR.test(String(text || ''));
}

function isSettingsChange(text) {
  return RE_SETTINGS_CHANGE.test(String(text || ''));
}

function isPrefsQuery(text) {
  return RE_PREFS.test(String(text || ''));
}

function isAssetsQuery(text) {
  return RE_ASSETS.test(String(text || ''));
}

function classify(text) {
  const s = String(text || '').trim();
  if (!s) return { intent: 'unknown', reason: 'empty' };
  if (RE_GREETING.test(s)) return { intent: 'greeting' };
  if (RE_STATUS.test(s)) return { intent: 'status' };
  if (RE_LAST.test(s)) return { intent: 'last' };
  // 2026-11-16：查「选了哪些场景卡」不排新计划（只读预览）；「不要出图」只回开关位置。
  if (RE_PLAN_SCENES.test(s)) return { intent: 'plan_scenes' };
  if (RE_NO_IMAGE.test(s)) return { intent: 'no_image' };
  // 2026-11-17 V1（§9.1-6）：确认问句必须排在最前（RE_CREATE 的「生成」会把它抢成排计划）。
  // 注意顺序：放在 plan_edit/bgm/create 之前，但仍在「查场景 / 不要出图」之后。
  if (isConfirmRequest(s)) return { intent: 'confirm' };
  // 2026-11-18：「提示词看一下 / 看一下提示词」（无段号）先归 plan_edit → 只读展示，
  // 不再落到 else 被当成排计划、反问总时长（用户报的答非所问）。
  if (isPromptViewRequest(s)) return { intent: 'plan_edit' };
  // 「提示词改成：X」即使没段号也应按段编辑处理（supervisor 会问第几段），不要落到排计划。
  if (RE_PROMPT_SET_VERB.test(s)) return { intent: 'plan_edit' };
  // 2026-11-16 P7-A：计划内修改必须排在 create 之前（否则「第 2 个场景换一个」会被当成新计划重排）；
  // 但只能匹配带「第 N 段/个」、「这个地方/这里 + 换一个」或「三个/都 + 换掉」的句子，
  // 不能抢「改成 1080p」「每段 15 秒」「再来一条」。
  // 2026-11-17 V1：第 4 个 OR =「场景/场景卡 + 换/改/不满意」（护栏见 isSceneCardEdit）。
  if ((RE_SEGMENT_REF.test(s) && RE_SEGMENT_EDIT.test(s))
    || (RE_SEGMENT_VAGUE.test(s) && RE_SEGMENT_SWAP_WORD.test(s))
    || isBatchSceneEdit(s)
    || isSceneCardEdit(s)) return { intent: 'plan_edit' };
  if ((RE_BGM_NOUN.test(s) && RE_BGM_ACTION.test(s))
    || (RE_BGM_INDEX.test(s) && !RE_TIME_WORD.test(s))
    || (RE_BGM_SWAP.test(s) && !RE_CREATE.test(s))) return { intent: 'bgm' };
  // 2026-11-17 V2（B2/B6/B7/B5）：新增四个显式意图，排在 context/create 之前。
  // 判定都要求显式词，不能抢 V1 既有分类（见上方注释与 verify-assistant 的负向断言）。
  if (isRepairQuery(s)) return { intent: 'repair' };
  if (isSettingsChange(s)) return { intent: 'settings' };
  if (isPrefsQuery(s)) return { intent: 'prefs' };
  if (isAssetsQuery(s)) return { intent: 'assets' };
  // 2026-11-17 V1（§9.1-7）：只读环境问答。放在 bgm 之后、create 之前——
  // 「配乐有哪些」这类句子里没有预算/任务/Key 名词，不会被抢。
  if (isContextQuery(s)) return { intent: 'context' };
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
  isBatchSceneEdit,
  isPromptViewRequest,
  isSceneCardEdit,
  isSceneCardsOff,
  isConfirmRequest,
  isContextQuery,
  isRepairQuery,
  isSettingsChange,
  isPrefsQuery,
  isAssetsQuery,
  retrieveTasks,
  taskRef,
  formatWhen
};
