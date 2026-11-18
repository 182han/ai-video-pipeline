// ==========================================
// 小智大脑 · C1「理解」契约（2026-11-18 S1 地基）
// ------------------------------------------------------------
// 设计边界（必须守住）：
//   · 本模块**只做理解**，输出 { intent, confidence, slots, clarify }。
//   · 不做执行、不算钱、不写状态、不改计划——真正做事仍由 supervisor 的确定性代码完成。
//   · 输出语言只用于「反问句」，不参与任何金额/参数计算。
//
// 为什么要这一层：对话主链路现在是 13 条中文正则 + if-else（memory.classify）。
// 用户说「提示词呢」「场景卡看一下」就掉进 unknown，再被当成"要排计划"（答非所问）。
// 补词只是打地鼠，所以先把「理解」独立成可测量的一层：
//   · S1 影子期：它只跑、只记日志，不改任何行为；
//   · 与 classify() 比对，得到"一致 / 分歧 / 它拿不准"三种结论；
//   · 过门（误报 ≤2%、救回 ≥70%）才谈 S2 切换。
//
// 刻意**不做**的两件事：
//   1) 不让模型直接产出 plan / 价格 / 工具调用参数——那会把钱和动作暴露在幻觉下；
//   2) 不引入新依赖：复用 src/services/llmService.js 的 OpenAI 兼容补全。
// ==========================================
'use strict';

const llmService = require('../services/llmService');

const BRAIN_VERSION = '1.2.0';

// 工具白名单 = 现有 classify() 能产出的意图集合。
// **不在这里新增能力**：模型只能在这些里面选，选不出来就必须说 clarify。
const INTENTS = Object.freeze([
  { name: 'create', desc: '排一条新的视频计划（用户说了总时长/段数/分辨率/模型等可执行参数）' },
  { name: 'plan_edit', desc: '修改当前这版计划：改某一段的提示词、换场景卡、整批换卡' },
  { name: 'plan_scenes', desc: '只读查询：当前计划用了哪些场景卡' },
  { name: 'no_image', desc: '要求关掉逐段出图 / 走纯文生视频' },
  { name: 'bgm', desc: '配乐相关：列曲目、换一首、关掉配乐、设默认' },
  { name: 'last', desc: '找用户上一次的视频/成片' },
  { name: 'status', desc: '查当前任务进度/状态' },
  { name: 'confirm', desc: '明确表示确认/开始执行（会花钱的那一步）' },
  { name: 'repair', desc: '问失败原因 / 要诊断 / 要修复或补跑' },
  { name: 'settings', desc: '改全局默认设置（通道、分辨率、播报开关、清空偏好）' },
  { name: 'prefs', desc: '查跨会话偏好/常用设置' },
  { name: 'assets', desc: '查素材库存（图片库、片段库、成片库、场景卡余量）' },
  { name: 'context', desc: '只读问环境：预算余额、任务数量、Key 有没有配' },
  { name: 'greeting', desc: '打招呼 / 寒暄' },
  { name: 'clarify', desc: '**拿不准时选这个**：向用户反问一句，绝不猜' }
]);

const INTENT_NAMES = Object.freeze(INTENTS.map((x) => x.name));
const INTENT_SET = new Set(INTENT_NAMES);

// 允许模型给出的槽位名（只是提示，不做执行；S2 才由 supervisor 校验后使用）
const SLOT_KEYS = Object.freeze([
  'segmentIndex',   // 第几段（1-based）
  'segmentCount',   // 段数
  'totalMinutes',   // 总时长（分钟）
  'clipSeconds',    // 每段秒数
  'resolution',     // 720p / 1080p ...
  'model',          // 模型 id
  'bgmIndex',       // 第几首配乐（1-based）
  'sceneCards',     // true/false：是否用场景卡
  'note'            // 其它自然语言补充（不执行）
]);

function toolBlock() {
  return INTENTS.map((t, i) => `${i + 1}. ${t.name} —— ${t.desc}`).join('\n');
}

function stateBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '当前没有可用的运行状态。';
  const bits = [];
  bits.push(ctx.hasPlan ? '用户当前有一版已排好的计划。' : '用户当前没有计划卡。');
  if (ctx.planSummary) bits.push('计划摘要：' + String(ctx.planSummary).slice(0, 300));
  if (ctx.lastTaskSummary) bits.push('最近一次任务：' + String(ctx.lastTaskSummary).slice(0, 200));
  if (ctx.budgetUsd !== undefined && ctx.budgetUsd !== null) bits.push('账户余额：$' + ctx.budgetUsd + ' USD。');
  return bits.join('\n');
}

/**
 * C1 的 system prompt。
 * @param {'zh'|'en'} lang 只影响 clarify 句子的语言
 * @param {object} ctx  运行状态（只读）
 */
function buildSystemPrompt(lang, ctx) {
  const en = String(lang || '').toLowerCase().startsWith('en');
  if (en) {
    return [
      'You are the understanding layer of Xiaozhi, a video-planning assistant. You do exactly one thing:',
      'read one user utterance (Chinese or English) and decide which single action it means.',
      '',
      'Allowed actions:',
      toolBlock(),
      '',
      'Rules you must obey:',
      '1. Reply with ONE JSON object and nothing else. No prose, no markdown fences.',
      '2. Schema: {"intent": "<one of the actions>", "confidence": 0..1, "slots": {...}, "clarify": "<question or null>", "reason": "<short>"}',
      '3. If the utterance is ambiguous, incomplete, or does not clearly match an action, set intent="clarify" and write ONE short question in `clarify` (English). Never guess.',
      '4. Never invent numbers, prices or capabilities. If the user did not say a duration, do not make one up.',
      '5. If the user only supplies a slot (e.g. "720p", "make it 1080p") while a plan exists, that still means plan_edit with slots.',
      '6. Pay special attention to word order and particles that Chinese speakers actually use:',
      '   「提示词呢」「那提示词呢」「场景卡看一下」「把提示词发我」- these are read-only lookups, NOT new plans.',
      '7. slots may only use these keys: ' + SLOT_KEYS.join(', ') + '. Omit unknown slots; do not fabricate.',
      '',
      'Distinctions that previous rounds got wrong:',
      '· "show me the prompt of segment 2" -> plan_edit (segment-level edit/lookup), NOT plan_scenes.',
      '· "scene cards" while a plan exists -> plan_scenes (which cards the plan uses); assets is only about INVENTORY (how many cards/photos/clips are left).',
      '· "swap a scene card, I am not happy" -> plan_edit (there is a change verb), NOT clarify.',
      '· Nonsense or chit-chat that maps to nothing -> clarify. Do NOT use greeting unless the user is actually greeting.',
      '· "scene card, take a look" while a plan exists -> plan_scenes (cards the CURRENT plan uses). assets only when the user asks about COUNTS (how many left / stock).',
      '· A bare noun with no verb, e.g. "the prompt?" / "prompt again" -> plan_edit (read-only display), NOT clarify.',
      '· If the sentence names a concrete object (prompt / scene card / BGM / budget) plus a verb, prefer that action over clarify. Only use clarify when you truly cannot tell.',
      '',
      'Current state:',
      stateBlock(ctx)
    ].join('\n');
  }
  return [
    '你是「小智」的**理解层**，只做一件事：把用户的一句话（中英混说都算）判成下面某一个动作。',
    '你不执行、不报价、不写计划——真正做事的是另一层确定性代码。',
    '',
    '可选动作：',
    toolBlock(),
    '',
    '必须遵守：',
    '1. 只输出**一个 JSON 对象**，不要任何解释、不要 markdown 代码围栏。',
    '2. 结构：{"intent": "<动作名>", "confidence": 0~1, "slots": {...}, "clarify": "<反问句或 null>", "reason": "<简短理由>"}',
    '3. **拿不准就选 clarify**，并在 clarify 里写一句简短反问。绝对不许猜——猜错比反问的代价高得多。',
    '4. 不许编造数字、价格、能力。用户没说时长就不许自己填一个。',
    '5. 如果用户只给了一个槽位（比如「720p」「改成 1080p」）且已经有计划，这仍然是 plan_edit，把槽位放进 slots。',
    '6. 注意中文的语序和语气词：',
    '   「提示词呢」「那提示词呢」「场景卡看一下」「把提示词发我」都是**只读查看**，不是排新计划；',
    '   「换一组」「这三个都换掉」是整批改卡（plan_edit）；',
    '   「不要场景卡」「不要出图」是开关类指令，不是排计划。',
    '7. slots 只允许这些键：' + SLOT_KEYS.join(', ') + '；不确定就省略，不许瞎填。',
    '8. intent 必须是上面动作里的**原名**（英文小写下划线），不许自创。',
    '',
    '上一轮实测判错的四类，优先看这几条：',
    '· 「把第 2 段的提示词给我看一下」→ plan_edit（带段号、针对某一段），**不是** plan_scenes；',
    '· 已经有一版计划时问「场景卡…」→ plan_scenes（这版计划用了哪些卡）；',
    '   assets 只用于**库存**（还剩多少张图/多少张卡/多少段），不是"看当前计划用了什么"；',
    '· 「换一个场景卡，我不太满意」→ plan_edit（句子里有"换/不满意"这种改动动词），**不是** clarify；',
    '· 「???」「随便说点什么」这类无意义或纯寒暄 → clarify；',
    '   greeting **只**用于用户真的在打招呼（你好/hi/在吗），不要拿它兜底。',
    '· 「场景卡看一下 / 场景卡看看 / 场景卡列一下」→ plan_scenes（看**当前计划**用了哪些卡）；',
    '   assets 只在出现「还剩 / 库存 / 有多少张 / 剩几张」这类**数量**词时才用；',
    '· 「提示词呢 / 那提示词呢」（只给名词、没有动词）→ plan_edit（只读展示已有提示词），**不要** clarify；',
    '· 只要句子里有**具体对象（提示词/场景卡/配乐/预算/进度）+ 动作**，就选对应动作，不要轻易 clarify；',
    '  只有真的分辨不出意图时才用 clarify。',
    '',
    '当前状态：',
    stateBlock(ctx)
  ].join('\n');
}

/** 从模型正文里抠出第一个 JSON 对象（容忍 ```json 围栏与前后废话）。 */
function extractJson(text) {
  let s = String(text === undefined || text === null ? '' : text).trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  const body = s.slice(a, b + 1);
  try { return JSON.parse(body); } catch (e) { return null; }
}

/** 校验并规范化模型输出。任何不合规都判失败，绝不"尽量理解"。 */
function validateOutput(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'NOT_OBJECT' };
  }
  const intent = String(obj.intent || '').trim().toLowerCase();
  if (!INTENT_SET.has(intent)) return { ok: false, error: 'INTENT_NOT_ALLOWED', intent };

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = null;
  if (confidence !== null) confidence = Math.max(0, Math.min(1, confidence));

  let clarify = obj.clarify === undefined || obj.clarify === null ? null : String(obj.clarify).trim();
  if (clarify === '') clarify = null;
  // clarify 意图必须带问题；其它意图带了问题也接受（S2 会用它做"确认/提醒"）。
  if (intent === 'clarify' && !clarify) return { ok: false, error: 'CLARIFY_EMPTY' };

  const slots = {};
  if (obj.slots && typeof obj.slots === 'object' && !Array.isArray(obj.slots)) {
    for (const k of Object.keys(obj.slots)) {
      if (SLOT_KEYS.indexOf(k) === -1) continue; // 未知槽位直接丢弃，不写进结果
      const v = obj.slots[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') continue;
      slots[k] = v;
    }
  }
  return {
    ok: true,
    intent,
    confidence,
    clarify,
    slots,
    reason: obj.reason ? String(obj.reason).slice(0, 200) : null
  };
}

/**
 * 调用模型做一次"理解"。**任何失败都不抛异常**，返回结构化 failure，由调用方决定回退。
 * @returns {Promise<{ok:boolean, intent?:string, confidence?:number|null, clarify?:string|null, slots?:object, reason?:string|null, raw?:string, failure?:object}>}
 */
async function understand(text, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const input = String(text === undefined || text === null ? '' : text).trim();
  if (!input) return { ok: false, failure: { kind: 'EMPTY_INPUT' } };

  const lang = String(o.lang || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
  const system = buildSystemPrompt(lang, o.ctx);
  const llmOpts = {
    apiKey: o.apiKey, baseUrl: o.baseUrl, model: o.model,
    // 分类任务要稳定：默认 0.8 太随机，这里传低温度（llmService 支持则生效）。
    temperature: o.temperature !== undefined ? o.temperature : 0.1
  };
  if (o.responseFormat) llmOpts.responseFormat = o.responseFormat;

  let res;
  try {
    res = await llmService.chatMulti(system, [{ role: 'user', content: input }], llmOpts);
  } catch (e) {
    return { ok: false, failure: { kind: 'THROWN', detail: String(e && e.message ? e.message : e) } };
  }
  if (!res || !res.text) {
    return { ok: false, failure: (res && res.failure) || { kind: 'EMPTY' } };
  }

  const parsed = extractJson(res.text);
  if (!parsed) {
    return { ok: false, raw: res.text, failure: { kind: 'BAD_JSON', detail: String(res.text).slice(0, 200) } };
  }
  const checked = validateOutput(parsed);
  if (!checked.ok) {
    return { ok: false, raw: res.text, failure: { kind: checked.error, intent: checked.intent } };
  }
  return { ok: true, raw: res.text, ...checked };
}

/**
 * 把大脑结果与现有规则结果比对（影子期的核心指标）。
 * @returns {{mode:'same'|'diff'|'brain_unsure'|'brain_unavailable', rule:string, brain:string|null}}
 */
function compare(ruleIntent, brain) {
  const rule = String(ruleIntent || 'unknown');
  if (!brain || brain.ok !== true) return { mode: 'brain_unavailable', rule, brain: null };
  const bi = String(brain.intent || '');
  if (bi === rule) return { mode: 'same', rule, brain: bi };
  if (bi === 'clarify') return { mode: 'brain_unsure', rule, brain: bi };
  return { mode: 'diff', rule, brain: bi };
}

module.exports = {
  BRAIN_VERSION,
  INTENTS,
  INTENT_NAMES,
  SLOT_KEYS,
  buildSystemPrompt,
  extractJson,
  validateOutput,
  understand,
  compare
};
