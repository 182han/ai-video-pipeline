// ==========================================
// 小智 · B 目标：工具调用型对话 agent（C1 理解 + C2 说话 + 工具选择）
// ------------------------------------------------------------
// 与 S1 的 brain.js 的关系（重要，别搞混）：
//   · brain.js 只做「15 类意图分类」，是为「全量替换规则」设计的，已被决策门否决并冻结；
//   · 本模块是**另一层**：模型直接面向「工具 + 对话」——能选工具（改计划/查状态），
//     也能自己说人话（聊天/解释/建议）。动作执行仍 100% 由确定性代码完成。
//
// 设计红线（来自 S1/E0 的教训，违反任何一条都等于重演历史事故）：
//   1) **没有 execute / 付费 / 删除 / 建任务的工具**——这些只能由用户点计划卡「确认执行」；
//   2) 输出必须可校验：单个 JSON 对象 + 工具白名单 + 参数白名单 + 一次重试；
//   3) say（模型自己说的话）必须接地：金额/动作声明/承诺只能来自上下文，否则整条拒绝；
//   4) 任何失败（无 Key / 超时 / 坏 JSON）都不抛异常，返回结构化 failure，
//      由调用方回退到今天的规则路径（降级不倒退）。
//
// 本文件**不 require supervisor / server**：它是纯契约层（prompt + 解析 + 校验 + 调用），
// 工具执行由调用方注入的 runtime 负责（下一刀：supervisor 工具门面）。
// ==========================================
'use strict';

const llmService = require('../services/llmService');

const AGENT_VERSION = 'assistant-agent.v1.0.0';

// 付费/破坏性动作：**永远不注册为工具**。
// 即使提示词被注入、或模型胡说，也不存在"模型直接花钱/删东西"的路径。
const FORBIDDEN_TOOL_NAMES = Object.freeze([
  'execute', 'run', 'start_task', 'create_task', 'delete', 'delete_task',
  'pay', 'payment', 'charge', 'generate'
]);

// 工具白名单（v1：只读 + 改计划 + 待确认设置；**没有**任何执行/付费工具）。
// params 语法：name: 'number|string|boolean' + '?' 表示可选。
// enums：可选值白名单，模型给了别的值直接判坏（宁可回退，不许瞎执行）。
const TOOLS = Object.freeze([
  {
    name: 'plan_video',
    desc: '创建一条新的视频计划（或按新参数重排一条）',
    descEn: 'Create a new video plan (or rebuild it with new parameters)',
    params: {
      totalMinutes: 'number?', clipDurationSec: 'number?', clipCount: 'number?',
      resolution: 'string?', model: 'string?', sceneCards: 'boolean?'
    }
  },
  {
    name: 'edit_plan',
    desc: '修改当前这版计划：换某段场景卡 / 改某段提示词 / 整批换卡 / 改分辨率 / 改时长',
    descEn: 'Edit the current plan: swap one clip card, set a clip prompt, swap all, set resolution or duration',
    params: {
      action: 'string', segment: 'number?', prompt: 'string?',
      resolution: 'string?', totalMinutes: 'number?', clipDurationSec: 'number?'
    },
    enums: {
      action: ['swap_scene', 'set_prompt', 'swap_all', 'set_resolution', 'set_duration', 'set_clip_duration']
    }
  },
  {
    name: 'show_plan',
    desc: '把当前计划的内容/摘要读给用户看（只读）',
    descEn: 'Show the current plan (read-only)',
    params: {}
  },
  {
    name: 'show_scene_cards',
    desc: '显示当前这版计划用了哪些场景卡（只读；不是库存）',
    descEn: 'Show which scene cards the current plan uses (read-only; not inventory)',
    params: {}
  },
  {
    name: 'status',
    desc: '查任务进度/状态（只读）',
    descEn: 'Check task progress/status (read-only)',
    params: { taskId: 'string?' }
  },
  {
    name: 'last_video',
    desc: '找上一次的视频/成片（只读）',
    descEn: 'Find the last video/final cut (read-only)',
    params: {}
  },
  {
    name: 'budget',
    desc: '查预算余额、已花费（只读）',
    descEn: 'Check budget balance and spend (read-only)',
    params: {}
  },
  {
    name: 'diagnose',
    desc: '诊断失败原因并给修复建议（只读，不自动重跑）',
    descEn: 'Diagnose a failure and give repair suggestions (read-only, never auto-retry)',
    params: { taskId: 'string?' }
  },
  {
    name: 'bgm',
    desc: '配乐：列库 / 选第 N 首 / 换一首 / 关掉（改计划，不花钱）',
    descEn: 'BGM: list / pick #N / next / turn off (edits the plan, no cost)',
    params: { action: 'string', index: 'number?' },
    enums: { action: ['list', 'pick', 'next', 'off'] }
  },
  {
    name: 'settings_change',
    desc: '改全局默认设置（只生成待确认项，用户确认前不生效）',
    descEn: 'Change global defaults (only creates a pending item; nothing changes before the user confirms)',
    params: { key: 'string', value: 'string' },
    enums: { key: ['model', 'resolution', 'broadcast', 'clear_prefs'] }
  },
  {
    name: 'prefs',
    desc: '查跨会话偏好/常用设置（只读）',
    descEn: 'Read cross-session preferences (read-only)',
    params: {}
  },
  {
    name: 'assets',
    desc: '查素材库存：图片库/片段库/成片库/场景卡余量（只读）',
    descEn: 'Check asset inventory: photos/clips/finals/scene-card stock (read-only)',
    params: {}
  },
  {
    name: 'confirm_plan',
    desc: '回传当前计划并提醒用户点「确认执行」（不执行、不付费）',
    descEn: 'Return the current plan and ask the user to press "Confirm and run" (no execution, no charge)',
    params: {}
  }
]);

const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));
const TOOL_MAP = Object.freeze(TOOLS.reduce((acc, t) => { acc[t.name] = t; return acc; }, {}));
const TOOL_NAME_SET = new Set(TOOL_NAMES);

// ==========================================
// Prompt
// ==========================================
function toolLines(lang) {
  const en = lang === 'en';
  return TOOLS.map((t, i) => {
    const args = Object.keys(t.params).length
      ? Object.entries(t.params).map(([k, v]) => k + ':' + v).join(', ')
      : '(none)';
    const enums = t.enums
      ? '\n   allowed: ' + Object.entries(t.enums).map(([k, list]) => k + '=' + list.join('|')).join('; ')
      : '';
    return `${i + 1}. ${t.name} —— ${en ? t.descEn : t.desc}\n   args: ${args}${enums}`;
  }).join('\n');
}

function contextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '（无上下文）';
  const bits = [];
  bits.push(ctx.hasPlan ? '用户当前有一版计划。' : '用户当前没有计划卡。');
  if (ctx.planSummary) bits.push('计划摘要：' + String(ctx.planSummary).slice(0, 400));
  if (ctx.lastTaskSummary) bits.push('最近任务：' + String(ctx.lastTaskSummary).slice(0, 240));
  if (ctx.budgetUsd !== undefined && ctx.budgetUsd !== null) bits.push('账户余额：$' + ctx.budgetUsd + ' USD。');
  if (ctx.activeTasks !== undefined && ctx.activeTasks !== null) bits.push('在跑任务数：' + ctx.activeTasks + '。');
  if (ctx.recentError) bits.push('最近错误：' + String(ctx.recentError).slice(0, 200));
  return bits.join('\n');
}

/**
 * Agent 的 system prompt。工具清单由注册表**生成**（不手写，避免与代码漂移）。
 * @param {'zh'|'en'} lang
 * @param {object} ctx 只读上下文
 */
function buildSystemPrompt(lang, ctx) {
  const en = String(lang || '').toLowerCase().startsWith('en');
  if (en) {
    return [
      'You are Xiaozhi: a conversational assistant who can also help the user make videos.',
      'Read the user utterance (it may be casual, contain typos, or mix Chinese and English),',
      'then decide what to do THIS turn.',
      '',
      'You have exactly two modes, pick one:',
      'A. Chat / explain / advise (no side effects, no money, no real data) -> output only "say".',
      'B. You need real state or must change something -> call ONE tool -> output "tool" + "args".',
      '   The tool is executed by deterministic code; its result is shown to the user as the reply.',
      'You have NO tool to generate videos, charge money, delete anything, or start a task.',
      'Those only happen when the user presses "Confirm and run" on the plan card.',
      '',
      'Reply with ONE JSON object and nothing else (no markdown fences, no prose):',
      '{"say": "<text or null>", "tool": "<tool name or null>", "args": {...}, "clarify": "<question or null>", "needConfirm": false}',
      '',
      'Rules:',
      '1. Exactly ONE of say / tool / clarify is non-empty.',
      '2. Any number (duration, balance, task status, card count) must come from a tool call. Never invent numbers in "say".',
      '3. Never claim "I already generated / deleted / paid" in "say" - you cannot. The tool result is the evidence.',
      '4. If the user wants a plan but gave no total length -> clarify and ask (do not invent a duration).',
      '5. If the intent is unclear -> clarify with one short question. Do not guess.',
      '6. Always answer in the user\'s language (current lang=en).',
      '7. "args" may only use the parameter names declared by the tool. Do not invent parameters.',
      '8. The context below is for understanding only. It is not proof that anything was executed.',
      '',
      'Available tools:',
      toolLines('en'),
      '',
      'Easy-to-mistake distinctions:',
      '· "show the prompt / show the scene cards" -> show_plan / show_scene_cards (read-only), NOT a new plan.',
      '· "which cards does this plan use" -> show_scene_cards; "how many cards/photos are left" -> assets.',
      '· "make it 1080p" with a plan present -> edit_plan(set_resolution); "default / from now on" -> settings_change.',
      '· "swap them all / another batch" -> edit_plan(action=swap_all).',
      '· "confirm / start" -> confirm_plan only (ask the user to press the button); NEVER execute.',
      '· "??? / blah blah whatever" -> clarify (or a short chat line), never a plan.',
      '',
      'Current context (read-only):',
      contextBlock(ctx)
    ].join('\n');
  }
  return [
    '你是「小智」：一个能陪用户聊天、也能帮用户一起把视频做出来的助手。',
    '用户的话可能很口语、有错别字、中英混说。你要先理解它想干什么，再决定这一轮做什么。',
    '',
    '你只有两条路，二选一：',
    'A. 聊天/解释/建议（不花钱、不动计划、不查真实数据）→ 只输出 say。',
    'B. 需要真实状态或要改东西 → 调用**一个**工具 → 输出 tool + args；',
    '   工具由确定性代码执行，结果会作为回复给用户看。',
    '你**没有**"直接生成视频/直接扣费/直接删除/直接建任务"的工具；',
    '这些只能由用户在计划卡上点「确认执行」。',
    '',
    '只输出**一个 JSON 对象**，不要 markdown 围栏、不要解释：',
    '{"say": "<给用户的话或 null>", "tool": "<工具名或 null>", "args": {...}, "clarify": "<反问或 null>", "needConfirm": false}',
    '',
    '必须遵守：',
    '1. say / tool / clarify 三个字段**恰好一个**非空。',
    '2. 需要数字（时长、余额、任务状态、卡数）时，必须调用工具拿真实值；不许在 say 里编。',
    '3. 不许在 say 里声称"已经生成/已经删除/已经付款"——你做不到；工具返回结果后才能描述。',
    '4. 用户要排计划但没给总时长 → clarify 问时长，不要替用户填。',
    '5. 分不清意图 → clarify 问一句，不要猜。',
    '6. 用户说什么语言，say/clarify 就用什么语言（当前 lang=zh）。',
    '7. args 只能用工具声明的参数名，不要自创。',
    '8. 下面的上下文只用于理解，**不能**当作"已经执行"的依据。',
    '',
    '可用工具（清单由代码生成）：',
    toolLines('zh'),
    '',
    '几个容易做错的区分：',
    '· 「提示词呢 / 场景卡看一下」= 查看当前计划（show_plan / show_scene_cards），不是新计划；',
    '· 「看当前计划用了哪些卡」= show_scene_cards；「还剩多少张卡/库存」= assets；',
    '· 「改成 1080p」且已有计划 = edit_plan(set_resolution)；说「默认/以后都用」才是 settings_change；',
    '· 「换一组 / 都换掉」= edit_plan(action=swap_all)；',
    '· 「确认 / 开始吧」只回 confirm_plan（提醒用户点确认），**不要**执行；',
    '· 「??? / 随便说点什么」= clarify 或一句简短聊天，不要排计划。',
    '',
    '当前上下文（只读）：',
    contextBlock(ctx)
  ].join('\n');
}

// ==========================================
// 解析 / 校验
// ==========================================
/** 从模型正文里抠出第一个 JSON 对象（容忍 ```json 围栏与前后废话）。 */
function extractJson(text) {
  let s = String(text === undefined || text === null ? '' : text).trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function readArg(spec, value) {
  const optional = String(spec).endsWith('?');
  const base = optional ? String(spec).slice(0, -1) : String(spec);
  if (value === undefined || value === null || value === '') {
    return optional ? { ok: true, skip: true } : { ok: false, reason: 'MISSING' };
  }
  if (base === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) return { ok: false, reason: 'NOT_NUMBER' };
    return { ok: true, value: n };
  }
  if (base === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true') return { ok: true, value: true };
    if (value === 'false') return { ok: true, value: false };
    return { ok: false, reason: 'NOT_BOOLEAN' };
  }
  const s = String(value).trim();
  if (!s) return optional ? { ok: true, skip: true } : { ok: false, reason: 'EMPTY_STRING' };
  return s.length > 2000
    ? { ok: true, value: s.slice(0, 2000), truncated: true }
    : { ok: true, value: s };
}

function validateArgs(tool, rawArgs) {
  const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const args = {};
  const warnings = [];
  for (const k of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(tool.params, k)) warnings.push('UNKNOWN_ARG:' + k);
  }
  for (const k of Object.keys(tool.params)) {
    const r = readArg(tool.params[k], input[k]);
    if (!r.ok) return { ok: false, error: 'BAD_ARG', arg: k, reason: r.reason };
    if (r.skip) continue;
    let v = r.value;
    if (tool.enums && tool.enums[k] && tool.enums[k].indexOf(v) === -1) {
      return { ok: false, error: 'BAD_ARG', arg: k, reason: 'NOT_ALLOWED_VALUE' };
    }
    if (typeof v === 'number') {
      if (k === 'segment' && (!Number.isInteger(v) || v < 1)) {
        return { ok: false, error: 'BAD_ARG', arg: k, reason: 'BAD_SEGMENT' };
      }
      if ((k === 'segment' || k === 'clipCount' || k === 'index') && (!Number.isInteger(v) || v < 1)) {
        return { ok: false, error: 'BAD_ARG', arg: k, reason: 'NOT_POSITIVE_INT' };
      }
      if (k === 'clipCount' && v > 400) {
        return { ok: false, error: 'BAD_ARG', arg: k, reason: 'TOO_MANY_CLIPS' };
      }
      if (k === 'totalMinutes' && (v <= 0 || v > 60)) {
        return { ok: false, error: 'BAD_ARG', arg: k, reason: 'DURATION_RANGE' };
      }
      if (k === 'clipDurationSec' && (v <= 0 || v > 60)) {
        return { ok: false, error: 'BAD_ARG', arg: k, reason: 'CLIP_SEC_RANGE' };
      }
    }
    args[k] = v;
    if (r.truncated) warnings.push('TRUNCATED:' + k);
  }
  return { ok: true, args, warnings };
}

/**
 * 校验模型输出。任何不合规都判失败——**绝不"尽量理解"**（S1 的教训）。
 * @returns {{ok:boolean, mode?:'tool'|'say'|'clarify', ...}}
 */
function validateOutput(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'NOT_OBJECT' };
  }
  const toolRaw = obj.tool === undefined || obj.tool === null ? null : String(obj.tool).trim().toLowerCase();
  const sayRaw = obj.say === undefined || obj.say === null ? null : String(obj.say).trim();
  const clarifyRaw = obj.clarify === undefined || obj.clarify === null ? null : String(obj.clarify).trim();
  const filled = [toolRaw, sayRaw, clarifyRaw].filter((x) => !!x).length;
  if (filled === 0) return { ok: false, error: 'EMPTY_OUTPUT' };
  if (filled > 1) return { ok: false, error: 'AMBIGUOUS_OUTPUT' };

  const needConfirm = obj.needConfirm === true;
  if (toolRaw) {
    if (FORBIDDEN_TOOL_NAMES.indexOf(toolRaw) !== -1) {
      return { ok: false, error: 'FORBIDDEN_TOOL', tool: toolRaw };
    }
    const tool = TOOL_MAP[toolRaw];
    if (!tool) return { ok: false, error: 'TOOL_NOT_ALLOWED', tool: toolRaw };
    const checked = validateArgs(tool, obj.args);
    if (!checked.ok) {
      return { ok: false, error: checked.error, tool: toolRaw, arg: checked.arg, reason: checked.reason };
    }
    return {
      ok: true, mode: 'tool', tool: toolRaw, args: checked.args,
      warnings: checked.warnings, needConfirm, say: null, clarify: null
    };
  }
  if (clarifyRaw) {
    return { ok: true, mode: 'clarify', clarify: clarifyRaw.slice(0, 300), needConfirm, say: null, tool: null, args: {} };
  }
  return { ok: true, mode: 'say', say: sayRaw.slice(0, 2000), needConfirm, tool: null, clarify: null, args: {} };
}

// ==========================================
// say 接地校验（防幻觉：报价 / 假执行 / 承诺）
// ==========================================
const RE_ACTION_CLAIM = /(?:已|已经)(?:经)?(?:帮你|为你|替你)?(?:生成|创建|删掉|删除|提交|执行|下单|付款|扣费|修改|换掉|下载)/;
const RE_PROMISE = /(?:一定|保证|绝对)(?:能|可以|会|成功)/;
const RE_MONEY = /(?:[¥￥$]\s?\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?\s*(?:元|美元|块|USD|CNY))/gi;

/**
 * 收集上下文里的数字（只认数字值 / 纯数字字符串），用于金额接地比对。
 * 注意：不能拿 JSON 全文做子串匹配——"$3" 会撞上计划摘要里的 "3 段"（假通过）。
 */
function collectNumbers(node, out) {
  if (node === undefined || node === null) return;
  if (typeof node === 'number' && Number.isFinite(node)) { out.push(node); return; }
  if (typeof node === 'string') {
    const s = node.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(s)) out.push(Number(s));
    return;
  }
  if (Array.isArray(node)) { node.forEach((x) => collectNumbers(x, out)); return; }
  if (typeof node === 'object') { Object.keys(node).forEach((k) => collectNumbers(node[k], out)); }
}

/**
 * say 里的金额/动作/承诺必须能在上下文里找到依据，否则整条拒绝。
 * @returns {{ok:boolean, reason?:string, value?:string}}
 */
function checkSayGrounding(say, ctx) {
  const text = String(say === undefined || say === null ? '' : say);
  if (!text.trim()) return { ok: false, reason: 'EMPTY' };
  if (RE_ACTION_CLAIM.test(text)) return { ok: false, reason: 'ACTION_CLAIM' };
  if (RE_PROMISE.test(text)) return { ok: false, reason: 'PROMISE' };
  const ctxText = JSON.stringify(ctx || {}).replace(/\s+/g, '');
  const ctxNumbers = [];
  collectNumbers(ctx || {}, ctxNumbers);
  const money = text.match(RE_MONEY) || [];
  for (const raw of money) {
    // ① 原文里就有这个金额写法（例如上下文带 ¥3.00）→ 算接地
    if (ctxText.indexOf(String(raw).replace(/\s+/g, '')) !== -1) continue;
    // ② 否则数值必须能对上上下文里的某个数字（例如 budgetUsd: 196 支持 "$196"）
    const m = String(raw).match(/\d+(?:\.\d+)?/);
    const value = m ? Number(m[0]) : NaN;
    if (!Number.isFinite(value) || ctxNumbers.indexOf(value) === -1) {
      return { ok: false, reason: 'UNGROUNDED_MONEY', value: raw };
    }
  }
  return { ok: true };
}

// ==========================================
// 调用
// ==========================================
/**
 * 跑一轮：模型 → 校验后的决定（tool / say / clarify）。
 * 失败绝不抛异常；调用方据此回退规则路径。
 *
 * @param {object} opts
 *   text, lang, ctx, history, callLLM?, apiKey/baseUrl/model/temperature/timeoutMs
 * @returns {Promise<{ok:boolean, mode?:string, tool?:string, args?:object, say?:string,
 *   clarify?:string, warnings?:string[], raw?:string, latencyMs?:number, attempts?:number,
 *   failure?:object}>}
 */
async function runTurn(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const text = String(o.text === undefined || o.text === null ? '' : o.text).trim();
  if (!text) return { ok: false, failure: { kind: 'EMPTY_INPUT' } };

  const lang = String(o.lang || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
  const ctx = o.ctx && typeof o.ctx === 'object' ? o.ctx : {};
  const history = Array.isArray(o.history) ? o.history.slice(-8) : [];
  const messages = history
    .filter((m) => m && m.text)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text).slice(0, 2000) }));
  messages.push({ role: 'user', content: text });

  const call = typeof o.callLLM === 'function' ? o.callLLM : llmService.chatMulti;
  const llmOpts = {
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
    model: o.model,
    temperature: o.temperature !== undefined ? o.temperature : 0.3
  };
  if (o.timeoutMs) llmOpts.timeoutMs = o.timeoutMs;
  const system = buildSystemPrompt(lang, ctx);
  const started = Date.now();
  let raw = null;
  let lastFailure = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let res;
    try {
      res = await call(system, messages, llmOpts);
    } catch (e) {
      return {
        ok: false,
        failure: { kind: 'THROWN', detail: String(e && e.message ? e.message : e) },
        latencyMs: Date.now() - started,
        attempts: attempt
      };
    }
    if (!res || !res.text) {
      // NO_KEY / HTTP / TIMEOUT / EMPTY：重试也一样，直接交给调用方回退规则路径。
      return {
        ok: false,
        failure: (res && res.failure) || { kind: 'EMPTY' },
        latencyMs: Date.now() - started,
        attempts: attempt
      };
    }
    raw = String(res.text);
    const parsed = extractJson(raw);
    const checked = parsed ? validateOutput(parsed) : { ok: false, error: 'BAD_JSON' };
    if (checked.ok) {
      if (checked.mode === 'say') {
        const grounded = checkSayGrounding(checked.say, ctx);
        if (!grounded.ok) {
          return {
            ok: false,
            raw,
            failure: { kind: 'SAY_UNGROUNDED', reason: grounded.reason, value: grounded.value || null },
            latencyMs: Date.now() - started,
            attempts: attempt
          };
        }
      }
      return { ok: true, ...checked, raw, latencyMs: Date.now() - started, attempts: attempt };
    }
    lastFailure = {
      kind: checked.error || 'BAD_OUTPUT',
      detail: [checked.tool, checked.arg, checked.reason].filter(Boolean).join('/') || null
    };
    if (attempt === 1) {
      // 一次重试：把坏输出塞回去，明确要求只输出合法 JSON。
      messages.push({ role: 'assistant', content: raw.slice(0, 800) });
      messages.push({
        role: 'user',
        content: lang === 'en'
          ? 'Your previous answer was not a valid decision. Reply with ONE JSON object only, following the schema. No markdown, no prose.'
          : '你上一条输出不合法。只输出一个 JSON 对象，严格遵守上面的结构；不要 markdown、不要解释。'
      });
    }
  }
  return {
    ok: false, raw, failure: lastFailure,
    latencyMs: Date.now() - started, attempts: 2
  };
}

/** 总开关（默认关；server 接线时用 ASSISTANT_AGENT=on 打开）。 */
function isEnabled(env) {
  const e = env && typeof env === 'object' ? env : process.env;
  return String(e.ASSISTANT_AGENT || '').trim().toLowerCase() === 'on';
}

module.exports = {
  AGENT_VERSION,
  TOOLS,
  TOOL_NAMES,
  TOOL_MAP,
  FORBIDDEN_TOOL_NAMES,
  buildSystemPrompt,
  contextBlock,
  extractJson,
  validateArgs,
  validateOutput,
  checkSayGrounding,
  runTurn,
  isEnabled
};
