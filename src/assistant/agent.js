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
    desc: '创建一条新的视频计划（或按新参数重排一条）。totalMinutes=整条总时长（分钟）；clipDurationSec=每段秒数，仅场景卡模式 10/15',
    descEn: 'Create a new video plan (or rebuild it with new parameters). totalMinutes=total length in minutes; clipDurationSec=seconds per clip (scene-card mode: 10/15 only)',
    params: {
      totalMinutes: 'number?', clipDurationSec: 'number?', clipCount: 'number?',
      resolution: 'string?', model: 'string?', sceneCards: 'boolean?'
    },
    // 2026-11-19 live 抓到：模型自创型号 "whaletv-wanx3" → plan_video 执行失败、回复变成报错。
    // 型号/分辨率限定为真实枚举，让校验层在第一次就拒绝并触发一次重试。
    enums: {
      model: ['dashscope', 'openai-video', 'kling', 'seedance', 'mock'],
      resolution: ['480p', '720p', '1080p', '4k', '2160p']
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
    desc: '把当前计划的摘要读给用户看（只读；不含各段提示词）',
    descEn: 'Show the current plan summary (read-only; not the per-clip prompts)',
    params: {}
  },
  {
    name: 'show_prompt',
    desc: '把当前计划各段的提示词原文贴给用户看（只读；可指定第几段）',
    descEn: 'Show the actual per-clip prompt text of the current plan (read-only; optional segment)',
    params: { segment: 'number?' }
  },
  {
    name: 'show_scene_cards',
    desc: '显示当前这版计划用了哪些场景卡（只读；不是库存）',
    descEn: 'Show which scene cards the current plan uses (read-only; not inventory)',
    params: {}
  },
  {
    name: 'search_scene_cards',
    desc: '在当前计划的场景卡里按内容搜索（雪/冰/海/沙漠/夜景/森林/瀑布…），返回命中的段号与卡名；空结果会明确说没有（只读）',
    descEn: 'Search the current plan\'s scene cards by content (snow/ice/sea/desert/night/forest/waterfall...); returns matched clip numbers and card names; states explicitly when nothing matches (read-only)',
    params: { query: 'string' }
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
      '· "show me the prompt" -> show_prompt (actual prompt text); "show the scene cards" -> show_scene_cards; "show the plan" -> show_plan. None of them creates a new plan.',
      '· SLOT DISTINCTION (users confuse these two, do not): the PROMPT is the text sent to the video model; the SCENE CARD is the library entry (name, chapter, landform, shot).',
      '  The prompt is composed FROM the card, so showing one is not showing the other. Wording alone decides: "prompt / prompt text / what you will send / wording" -> show_prompt;',
      '  "card / cards / which scenes / which locations" -> show_scene_cards. When the utterance names BOTH (e.g. "the prompts of all 12 scenes"), the user wants the PROMPT text -> show_prompt.',
      '· If the user asks you to explain what you just said ("what did you write?", "what was that?") -> use say to explain the previous message; do NOT call show_plan and repeat the card.',
      '· "which cards does this plan use" -> show_scene_cards; "how many cards/photos are left" -> assets.',
      '· "does the plan have snow/sea/desert/night clips?" or "which clips are snow/sea...?" -> search_scene_cards(query=keyword);',
      '  "list all the cards" -> show_scene_cards. A content question is NOT a list request; never answer it with a card list.',
      '· "make it 1080p" with a plan present -> edit_plan(set_resolution); "default / from now on" -> settings_change.',
      '· "swap them all / another batch" -> edit_plan(action=swap_all).',
      '· "confirm / start" -> confirm_plan only (ask the user to press the button); NEVER execute.',
      '· "yes / ok / sure" with a plan and your previous message was not a question -> confirm_plan only; never answer with a bare acknowledgement or meta-commentary about JSON.',
      '· "??? / blah blah whatever" -> clarify (or a short chat line), never a plan.',
      '· "30 seconds / 2 minutes" = TOTAL length -> plan_video(totalMinutes=0.5/2); "15 seconds per clip" -> clipDurationSec (10 or 15 only).',
      '· "swap clip 2 / change clip 2" with a plan -> edit_plan(action=swap_scene, segment=2); "15s per clip" with a plan -> edit_plan(action=set_clip_duration, clipDurationSec=15).',
      '· "set the prompt to: X" with a plan -> edit_plan(action=set_prompt, segment=1, prompt=X); default to clip 1, do not ask back.',
      '· "change the default channel to Bailian" -> settings_change(key=model, value=dashscope); WhaleTV=openai-video, Kling=kling, Seedance=seedance.',
      '· Photo colour/saturation question: yes, the user can adjust it in Library -> Photos -> pick a photo -> Adjust (local, free). The video plan itself has no separate saturation parameter; only prompts or the adjusted first frame can influence it.',
      '· If the user asks to rerun the last failed task -> call diagnose for taskId/reason, then tell them: Library -> Finals -> that task -> "Continue/Rerun". You have NO tool to rerun it yourself; do not claim you can.',
      '· If your previous message was a question and the user answers briefly ("same scene", "a bit warmer"), that IS the answer -> continue the task; do not ask the same question again.',
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
    '· 「提示词呢 / 我看看提示词」= show_prompt（贴出各段提示词原文）；「场景卡看一下」= show_scene_cards；「计划里有什么」= show_plan；都不是新计划；',
    '· **槽位区分（用户自己也常混，你不许混）**：提示词 = 发给视频模型的文字；场景卡 = 卡库里的条目（卡名、章节、地貌、取景）。',
    '  提示词是**按场景卡拼出来的**，所以贴提示词 ≠ 列场景卡。只看用户点名的对象：',
    '  「提示词 / 提示词原文 / 你会发给模型的是什么 / 文字」→ show_prompt；',
    '  「场景卡 / 卡 / 哪几个场景 / 哪几个地方」→ show_scene_cards。',
    '  一句话里两者都出现（例如「全部12段12个场景的提示词」）→ 用户要的是**提示词原文** → show_prompt。',
    '· 「我要把这几张都给我看一下」这类只带数量/指代、不带对象的查看句 → 用 say 反问一句（要提示词原文还是场景卡清单），不要猜；',
    '· 用户让你解释你刚说过的话（「你写的什么」「刚才那段是什么」）→ 用 say 解释上一句，**不要**再调 show_plan 重复计划卡；',
    '· 「看当前计划用了哪些卡」= show_scene_cards；「还剩多少张卡/库存」= assets；',
    '· 用户问卡里**有没有某类内容 / 哪几段是某类内容**（雪/冰/海/沙漠/夜景/森林/瀑布…）→ search_scene_cards(query=关键词)；',
    '  只是要看全部卡/列卡 → show_scene_cards。前者是内容查询，后者是列表，不要拿列表糊弄内容问题。',
    '· 「改成 1080p」且已有计划 = edit_plan(set_resolution)；说「默认/以后都用」才是 settings_change；',
    '· 「换一组 / 都换掉」= edit_plan(action=swap_all)；',
    '· 「确认 / 开始吧」只回 confirm_plan（提醒用户点确认），**不要**执行；',
    '· 「可以 / 行 / 好 / OK」且已有计划、你上一条不是在提问 → confirm_plan（提醒点「确认执行」）；不要只回一句空话，也不要用「已按要求/已按格式」这类话作答；',
    '· 「??? / 随便说点什么」= clarify 或一句简短聊天，不要排计划。',
    '· 「30 秒 / 2 分钟」= **整条视频总时长** → plan_video(totalMinutes=0.5/2)；只有「每段 15 秒」才用 clipDurationSec（场景卡模式只支持 10 或 15）。',
    '· 「第二段换个场景 / 把第二段换成 X」且已有计划 → edit_plan(action=swap_scene, segment=2)；「每段 15 秒」且已有计划 → edit_plan(action=set_clip_duration, clipDurationSec=15)。',
    '· 「提示词改成：X」且已有计划 → edit_plan(action=set_prompt, segment=1, prompt=X)；用户没指定第几段时默认第 1 段，不要反问。',
    '· 「把默认通道改成百炼」→ settings_change(key=model, value=dashscope)；WhaleTV 中转=openai-video、可灵=kling、即梦=seedance。',
    '· 用户问照片能不能调色/调饱和度 → 能：库 → 图片 → 选中照片 → 调色（本地、不计费）；视频计划本身没有单独的饱和度参数，只能靠提示词或调色后的首帧间接影响。',
    '· 用户要补跑上一次失败的任务 → 先用 diagnose 找到 taskId 和失败原因，再告诉他：库 → 成片 → 该任务 → 「补跑 / 继续」；你**没有**直接补跑工具，不要声称能代跑。',
    '· 如果上一条是你在提问（例如「第三段想换什么感觉」），用户短回答（「还是这个场景」「更暖一点」）就是在回答你的问题 → 直接接着办，不要重复问一遍。',
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
const RE_ACTION_CLAIM_EN = /\b(?:i(?:'ve|\s+have)?\s+(?:already\s+)?(?:generated|created|deleted|submitted|executed|paid|charged|downloaded)|it(?:'s|\s+is)\s+(?:done|generated|created|deleted|submitted|executed|paid))\b/i;
const RE_PROMISE = /(?:一定|保证|绝对)(?:能|可以|会|成功)/;
const RE_PROMISE_EN = /\b(?:i\s+(?:can\s+)?guarantee|guarantee(?:d)?\s+(?:to\s+)?(?:work|succeed|deliver)|definitely\s+(?:will|works?|succeed)|100%\s+(?:will\s+)?(?:work|succeed))\b/i;
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
  if (RE_ACTION_CLAIM.test(text) || RE_ACTION_CLAIM_EN.test(text)) return { ok: false, reason: 'ACTION_CLAIM' };
  if (RE_PROMISE.test(text) || RE_PROMISE_EN.test(text)) return { ok: false, reason: 'PROMISE' };
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
// say 质量闸（2026-11-23）
// ------------------------------------------------------------
// 背景：用户说「可以」，模型重试后把「遵守 JSON 格式」本身当成回答，
// 回了一句「好的，已按要求以 JSON 格式回复。」，旧校验只查金额/动作/承诺，
// 于是这句空话被原样落库并显示给用户。
// 这里只拦三类**明确无信息量**的 say；不拦正常短回答：
//   ① 元话术：谈论 JSON/格式/结构本身，而不是回答用户；
//   ② 空泛确认：「好的。」「可以。」单独一句，没有内容；
//   ③ 无理由复读：与上一条 assistant 文本相同，且用户没要求「再说一遍」。
// ==========================================
const RE_META_TALK = /(?:已按.*(?:要求|格式|结构)|(?:JSON|json)\s*(?:格式|对象|结构)|(?:只|仅)输出.*(?:JSON|json|对象)|按照?.*(?:JSON|json)|遵守.*(?:格式|结构)|格式要求)/;
const RE_BARE_ACK = /^(?:好的|好|可以|行|收到|明白|了解|OK|ok|嗯|嗯嗯)[。！!，,.\s]*$/;
const RE_REPEAT_REQUEST = /(?:再说一遍|重复一遍|再说一次|重复一下|repeat|again)/i;

function normalizeSayForCompare(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\s。！!，,、；;：:？?…—\-]/g, '')
    .toLowerCase();
}

/**
 * 检查模型「自己说的话」是否值得显示给用户。
 * @param {string} say
 * @param {{userText?:string,lastAssistantText?:string}} [opts]
 * @returns {{ok:boolean, reason?:string}}
 */
function checkSayQuality(say, opts) {
  const text = String(say === undefined || say === null ? '' : say).trim();
  if (!text) return { ok: false, reason: 'EMPTY' };
  if (RE_META_TALK.test(text)) return { ok: false, reason: 'META_TALK' };
  if (RE_BARE_ACK.test(text)) return { ok: false, reason: 'BARE_ACK' };
  const o = opts && typeof opts === 'object' ? opts : {};
  const userText = String(o.userText || '');
  const lastAssistantText = String(o.lastAssistantText || '');
  if (lastAssistantText && !RE_REPEAT_REQUEST.test(userText)) {
    const a = normalizeSayForCompare(text);
    const b = normalizeSayForCompare(lastAssistantText);
    if (a && a === b && a.length >= 8) return { ok: false, reason: 'REPEAT' };
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
  const lastAssistant = history.slice().reverse().find((m) => m && m.role === 'assistant' && m.text);
  const lastAssistantText = lastAssistant ? String(lastAssistant.text) : '';
  const messages = history
    .filter((m) => m && m.text)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text).slice(0, 2000) }));
  messages.push({ role: 'user', content: text });

  // 2026-11-19：不能把 llmService.chatMulti 直接赋给变量再调用——会丢 this
  // （chatMulti 内部用 this._resolve），表现为 0ms THROWN、全部回退。
  // 真机 A/B 第一次跑就是这么全挂的；stub 注入独立函数所以单测没抓到。
  const injected = typeof o.callLLM === 'function' ? o.callLLM : null;
  const call = injected || ((system, messages, llmOpts) => llmService.chatMulti(system, messages, llmOpts));
  const llmOpts = {
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
    model: o.model,
    temperature: o.temperature !== undefined ? o.temperature : 0.3
  };
  if (o.timeoutMs) llmOpts.timeoutMs = o.timeoutMs;
  // 2026-11-19 延迟优化：真实模型默认在「思考」，实测简单回合 8–15s。
  // 小智只需要选工具/说一句，默认关掉思考；需要更强推理时传 thinking:{type:'enabled'}，
  // 或设环境变量 ASSISTANT_AGENT_THINKING=on。
  const thinkingDefault = String(process.env.ASSISTANT_AGENT_THINKING || '').toLowerCase() === 'on'
    ? null : { type: 'disabled' };
  if (o.thinking !== undefined) llmOpts.thinking = o.thinking;
  else if (thinkingDefault) llmOpts.thinking = thinkingDefault;
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
        const quality = checkSayQuality(checked.say, { userText: text, lastAssistantText });
        if (!quality.ok) {
          lastFailure = { kind: 'SAY_QUALITY', reason: quality.reason };
        } else {
          return { ok: true, ...checked, raw, latencyMs: Date.now() - started, attempts: attempt };
        }
      } else {
        return { ok: true, ...checked, raw, latencyMs: Date.now() - started, attempts: attempt };
      }
    } else {
      lastFailure = {
        kind: checked.error || 'BAD_OUTPUT',
        detail: [checked.tool, checked.arg, checked.reason].filter(Boolean).join('/') || null
      };
    }
    if (attempt === 1) {
      // 一次重试：把坏输出塞回去，明确要求只输出合法 JSON。
      // 2026-11-19：第一次默认关思考（快）；失败重试时自动开思考（质量兜底），
      // 只在真正需要时多花时间。调用方显式传 thinking 时不覆盖。
      if (o.thinking === undefined) llmOpts.thinking = { type: 'enabled' };
      messages.push({ role: 'assistant', content: raw.slice(0, 800) });
      messages.push({
        role: 'user',
        content: lang === 'en'
          ? `Your previous answer was not usable. The user's message was: "${text.slice(0, 300)}". Answer THAT message. Reply with ONE JSON object only, following the schema. No markdown, no prose, no apology, and no meta-commentary about JSON or format.`
          : `你上一条输出不可用（格式不合法，或没有回答用户的问题）。用户的问题是：「${text.slice(0, 300)}」。仍然回答这个问题；只输出一个 JSON 对象，严格遵守上面的结构；不要 markdown、不要解释、不要道歉，也不要用「已按要求/已按格式」这类空话作答。`
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
  checkSayQuality,
  runTurn,
  isEnabled
};
