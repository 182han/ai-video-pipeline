// ==========================================
// 小智 · 计划卡（P5）
// ------------------------------------------------------------
// 已定产品决策（docs/交接/2026-11-15-handoff.md §7，不要重新讨论）：
//   · 方案 C：模型只负责「听懂 + 填计划卡」；执行/失败处理由确定性状态机做，不问模型。
//   · 时长：用户给总时长（无默认）+ 每段时长；上限 60 分钟或 400 段取先到者；
//     每段范围按模型（dashscope 2–30、kling 3–15、seedance ≤15）。
//   · 场景卡 v3.3 为唯一输入；每段 10 或 15 秒（默认 10）→ 180 张 = 30 / 45 分钟，
//     超过必须先扩卡库；总时长上限 60 分钟、片段上限 400 段取先到者。
//   · 单任务重试费用 ≤ 总预算 10%；质检最多自动重试 2 次。
//   · 补位率 ≤ 5% 且 ≤ 10 段。
//
// 本模块只做「文本 → 计划卡」与「计划卡 → 预算/闸门」：
//   · 纯函数、不读任务、不写文件、不调用任何付费接口；
//   · 不做 LLM 调用：调用方可传入 modelSlots（LLM 填好的槽位）再走同一套校验；
//   · 「听不懂」一律返回明确 error code + 一个中文追问，由 UI 原样显示。
// ==========================================

'use strict';

const sceneCards = require('../sceneCards');
const promptComposer = require('../promptComposer');
const pricing = require('../pricing');
const budget = require('../budget');

const PLAN_VERSION = 'assistant-plan.v1';

// 模型 → 单段时长范围（§7 已定）。
// mock 只在验收/演示里用，本身不计费；范围放宽到 1–60s（与流水线允许值一致）。
const MODELS = Object.freeze({
  // 百炼官方（备用通道）：用户明确说「百炼 / 万相官方 / dashscope」时走。
  // 图生视频走官方临时 OSS（getPolicy → oss://，48h 私有），不需要用户公网存储。
  // labelEn：2026-11-18 S0 —— 英文计划卡此前直接复用中文 label，导致
  // `Model: WhaleTV 万相 3.0（中转）` 在英文界面必现。英文渲染一律走 labelEn。
  dashscope: { id: 'dashscope', label: '百炼万相 3.0（官方）', labelEn: 'Bailian Wanxiang 3.0 (official)', minSec: 2, maxSec: 30 },
  // **默认通道**（2026-11-16 20:4x 用户口径：生视频必须用 WhaleTV key）。
  // 图生视频已实测可用：NewAPI `POST /video/generations + image`，公网 URL / data URL 都出片。
  'openai-video': { id: 'openai-video', label: 'WhaleTV 万相 3.0（中转）', labelEn: 'WhaleTV Wanxiang 3.0 (relay)', minSec: 2, maxSec: 30 },
  kling: { id: 'kling', label: '可灵（Kling）', labelEn: 'Kling', minSec: 3, maxSec: 15 },
  seedance: { id: 'seedance', label: '即梦（Seedance）', labelEn: 'Seedance (Jimeng)', minSec: 2, maxSec: 15 },
  mock: { id: 'mock', label: 'Mock（零计费验收）', labelEn: 'Mock (no charge)', minSec: 1, maxSec: 60 }
});

const LIMITS = Object.freeze({
  // §7：上限 60 分钟或 400 段取先到者
  maxMinutes: 60,
  maxClips: 400,
  // §7：卡库只有 180 张正片；每段 10 或 15 秒（2026-11-16 用户批准一次跑 15 秒，默认仍是 10）
  sceneCardMaxClips: 180,
  sceneCardClipSec: 10,
  sceneCardClipSecAllowed: Object.freeze([10, 15]),
  // §7：单任务重试费用 ≤ 总预算 10%
  retryBudgetRatio: 0.10,
  // §7：质检最多自动重试 2 次
  maxQcRetries: 2,
  // §7：补位率 ≤ 5% 且 ≤ 10 段
  fillRatio: 0.05,
  fillMaxClips: 10,
  maxPlanTextChars: 4000
});

// 2026-11-18 S0：分钟数不再把浮点原样甩给用户。
// 旧文案会出现「目标 0.4166666666666667 分钟」（中英都中招）；整数就整数，否则 2 位小数。
function fmtMinutes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

// 主题词表：把口语映射到 promptComposer 认的主题 id（未知主题原样作为 label）。
const THEMES = Object.freeze([
  { id: 'aurora', label: '极光', words: ['极光', '北极光', 'aurora'] },
  { id: 'mountain', label: '雪山冰川', words: ['雪山', '冰川', '雪峰', 'glacier', 'snow mountain'] },
  { id: 'desert', label: '沙漠沙丘', words: ['沙漠', '沙丘', '荒漠', 'desert', 'dune'] },
  { id: 'space', label: '星空银河', words: ['星空', '银河', '星云', 'stars', 'galaxy', 'milky way'] },
  { id: 'ocean', label: '海岸礁岩', words: ['海岸', '礁岩', '海边', '海岸线', 'coast', 'ocean'] },
  { id: 'forest', label: '森林', words: ['森林', '树林', '雨林', 'forest'] },
  { id: 'lake', label: '湖泊', words: ['湖泊', '盐湖', 'lake'] },
  { id: 'waterfall', label: '瀑布', words: ['瀑布', 'waterfall'] },
  { id: 'mist_valley', label: '云雾山谷', words: ['云雾', '山谷', '云海', 'mist', 'valley'] },
  { id: 'landscape', label: '自然风光', words: ['自然风光', '风光', '风景', 'landscape'] }
]);

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

// 中文数字 → number（0–999；覆盖「十分钟 / 三十分钟 / 一百八十段 / 二十五分钟」）。
function parseCnNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let section = 0;
  let number = 0;
  let hasAny = false;
  for (const ch of s) {
    if (ch === '百') {
      if (!number) number = 1;
      section += number * 100;
      number = 0;
      hasAny = true;
    } else if (ch === '十') {
      if (!number) number = 1;
      section += number * 10;
      number = 0;
      hasAny = true;
    } else if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) {
      number = CN_DIGITS[ch];
      hasAny = true;
    } else {
      return null;
    }
  }
  total = section + number;
  return hasAny ? total : null;
}

// 全角数字/单位归一，方便后续正则只写一套。
function normalizeText(text) {
  let s = String(text === undefined || text === null ? '' : text);
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[，、]/g, ',').replace(/[：]/g, ':');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > LIMITS.maxPlanTextChars) s = s.slice(0, LIMITS.maxPlanTextChars);
  return s;
}

// 数字（阿拉伯或中文）→ 数字；失败返回 null。
const NUM = '(\\d+|[零〇一二两三四五六七八九十百]+)';

function findDuration(text) {
  // 小时优先（「1小时」「半小时」）
  let m = text.match(new RegExp(NUM + '\\s*(?:个)?\\s*(?:小时|钟头|h\\b)', 'i'));
  if (m) {
    const n = parseCnNumber(m[1]);
    if (n) return { totalMinutes: n * 60, unit: 'hour' };
  }
  if (/半\s*(?:个)?\s*小时/.test(text)) return { totalMinutes: 30, unit: 'hour' };
  m = text.match(new RegExp(NUM + '\\s*(?:分钟|分|min\\b)', 'i'));
  if (m) {
    const n = parseCnNumber(m[1]);
    if (n) return { totalMinutes: n, unit: 'minute' };
  }
  if (/半\s*(?:个)?\s*分钟/.test(text)) return { totalMinutes: 0.5, unit: 'minute' };
  // 秒级总时长（2026-11-16 用户反馈：输入「30 秒」被当成听不懂、反复问时长）。
  // 必须先把「每段 10 秒」「10 秒一段」「单段 15 秒」这类**每段时长**表达从文本里剔掉，
  // 否则「30 秒，每段 15 秒」会两种含义混在一起（漏掉总时长 30 秒）。
  const masked = String(text)
    .replace(/每\s*(?:一)?\s*(?:段|个镜头|条)[^。，,；;]{0,12}\d+\s*(?:秒|s\b)/gi, ' ')
    .replace(/(?:每段|单段)\s*\d+\s*(?:秒|s\b|sec)/gi, ' ')
    .replace(/\d+\s*(?:秒|s\b)\s*(?:一|每)\s*(?:段|条|个镜头)/gi, ' ');
  m = masked.match(new RegExp(NUM + '\\s*(?:秒钟?|s\\b|sec\\b|seconds?)', 'i'));
  if (m) {
    const n = parseCnNumber(m[1]);
    if (n) return { totalMinutes: n / 60, unit: 'second', seconds: n };
  }
  return null;
}

function findClipDuration(text) {
  const patterns = [
    new RegExp('每\\s*(?:一)?\\s*(?:段|个镜头|条)\\s*(?:时长)?\\s*(?:是|为)?\\s*' + NUM + '\\s*秒', 'i'),
    new RegExp('单\\s*(?:段|个镜头|条)\\s*(?:时长)?\\s*(?:是|为)?\\s*' + NUM + '\\s*秒', 'i'),
    new RegExp(NUM + '\\s*秒\\s*(?:一|每)\\s*(?:段|条|个镜头)', 'i'),
    new RegExp('(?:每段|单段)\\s*' + NUM + '\\s*(?:s|sec|seconds?)\\b', 'i')
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseCnNumber(m[1]);
      if (n) return n;
    }
  }
  return null;
}

function findClipCount(text) {
  // 只认「N 段 / N 个片段 / N 个镜头」；「一条视频」「来一条」是口语量词，不是片段数。
  const patterns = [
    new RegExp(NUM + '\\s*(?:个)?\\s*(?:片段|镜头)', 'i'),
    new RegExp(NUM + '\\s*段', 'i')
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const n = parseCnNumber(m[1]);
    // 「每段 10 秒」里的「段」前面是量词，NUM 不会匹配到；显式 0 段也无意义。
    if (n && n > 0) return n;
  }
  return null;
}

function findResolution(text) {
  const m = text.match(/\b(480p|720p|1080p|4k|2160p)\b/i);
  return m ? m[1].toLowerCase() : null;
}

function findModel(text) {
  const lower = text.toLowerCase();
  // 中转优先于「万相」：用户说「WhaleTV / 中转 / agglm」时是 openai-video，不是官方 dashscope。
  if (/whaletv|whale\s*tv|agglm|中转|openai-video|openai视频/.test(lower)) return 'openai-video';
  if (/dashscope|万相|wan3|wan\b|通义/.test(lower)) return 'dashscope';
  if (/kling|可灵/.test(lower)) return 'kling';
  if (/seedance|即梦|doubao|豆包/.test(lower)) return 'seedance';
  if (/\bmock\b|测试模式/.test(lower)) return 'mock';
  return null;
}

function findSceneCardsFlag(text) {
  if (/(?:不用|不要|关闭|别用|取消)\s*场景卡/.test(text)) return false;
  if (/自由提示词|不要卡库|不用卡库/.test(text)) return false;
  return null; // 默认按产品口径开启（见 buildPlan）
}

// 识别一段话里提到的地貌词，按原文出现顺序去重。
// 2026-11-16 用户口径：长片只说时长，场景由场景卡库按 chapter+sequence 自动抽取（10 分钟 = 60 个不同场景），
// 不围绕单一主题。因此这里识别到的主题词**不参与选卡、不写进计划卡、不注入提示词**，
// 只用于在计划卡上给一句「不按单一主题选卡」的提示。
function findThemes(text) {
  const lower = String(text || '').toLowerCase();
  const hits = [];
  for (const t of THEMES) {
    for (const w of t.words) {
      const idx = lower.indexOf(String(w).toLowerCase());
      if (idx >= 0) { hits.push({ id: t.id, label: t.label, index: idx }); break; }
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out;
}

function findTheme(text) {
  const list = findThemes(text);
  return list.length ? list[0] : null;
}

/**
 * 从一句口语里抽槽位。只做确定性解析，不调用模型。
 * @param {string} text
 * @returns {object} 槽位（可能缺字段）
 */
function parseUtterance(text) {
  const raw = normalizeText(text);
  const duration = findDuration(raw);
  const clipDurationSec = findClipDuration(raw);
  const clipCount = findClipCount(raw);
  const resolution = findResolution(raw);
  const model = findModel(raw);
  const sceneCardsFlag = findSceneCardsFlag(raw);
  const themes = findThemes(raw);
  const theme = themes.length ? themes[0] : null;
  // 用户原句（去掉明显的时间/参数短语后剩余部分）作为氛围提示词；保留原句更稳妥，
  // promptComposer 只把它当「氛围」，不覆盖卡里的场景内容。
  return {
    raw,
    totalMinutes: duration ? duration.totalMinutes : null,
    clipDurationSec,
    clipCount,
    resolution,
    model,
    sceneCards: sceneCardsFlag,
    theme: theme ? theme.id : null,
    // 多主题时全部展示，避免「30 分钟雪山+星空+极光」被显示成「全是极光」
    themeLabel: themes.length ? themes.map((t) => t.label).join('、') : null,
    userPrompt: raw
  };
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

// 2026-11-18：英文界面下常见 PLAN_* 错误 → 英文话术（用户报「十秒 每段5秒」仍回中文）。
// 中文路径不经过这里：supervisor 只在 lang==='en' 时调用；未覆盖的 code 返回 null，
// 调用方回退中文原文（如实，不机器翻译动态细节）。
function describeErrorEn(code, ctx = {}) {
  const input = ctx.input || {};
  const parsed = ctx.parsed || {};
  const modelId = String(input.model || parsed.model || 'openai-video');
  const model = MODELS[modelId];
  const clipSec = input.clipDurationSec !== undefined && input.clipDurationSec !== null
    ? input.clipDurationSec
    : parsed.clipDurationSec;
  const resolution = String(input.resolution || parsed.resolution || '').toLowerCase();
  const allowedSec = LIMITS.sceneCardClipSecAllowed.join(' or ');
  switch (code) {
    case 'PLAN_NEED_DURATION':
      return 'How long should the video be? For example "30 seconds", "10 minutes", or "half an hour".';
    case 'PLAN_SCENE_CARD_DURATION':
      return `Scene cards support only ${allowedSec} seconds per clip (default ${LIMITS.sceneCardClipSec} s). `
        + `You gave ${clipSec === null || clipSec === undefined ? '(nothing)' : `${clipSec} s`}. `
        + `Use ${allowedSec} s, or say "no scene cards".`;
    case 'PLAN_BAD_CLIP_DURATION':
      return `Each clip must be ${model ? `${model.minSec}–${model.maxSec}` : 'within the model limit'} s for `
        + `${model ? model.label : modelId} (you gave ${clipSec === null || clipSec === undefined ? '(nothing)' : `${clipSec} s`}).`;
    case 'PLAN_UNKNOWN_MODEL':
      return `Unknown video model: ${modelId}. Available: ${Object.keys(MODELS).join(' / ')}.`;
    case 'PLAN_BAD_RESOLUTION':
      return `Unsupported resolution: ${resolution || '(empty)'}. Use 480p, 720p, 1080p, or 4k.`;
    case 'PLAN_BAD_COUNT':
      return 'A plan needs at least 1 clip.';
    case 'PLAN_TOO_LONG':
      return `A single task is limited to ${LIMITS.maxMinutes} minutes. Shorten it, or split it into multiple tasks.`;
    case 'PLAN_TOO_MANY_CLIPS':
      return `A single task is limited to ${LIMITS.maxClips} clips. Reduce the clip count or make each clip longer.`;
    case 'PLAN_SCENE_CARDS_EXHAUSTED':
      return `The scene-card library has only ${LIMITS.sceneCardMaxClips} feature cards `
        + `(${(LIMITS.sceneCardMaxClips * LIMITS.sceneCardClipSec / 60).toFixed(0)} minutes at ${LIMITS.sceneCardClipSec} s per clip). `
        + 'Expand the library first, or say "no scene cards".';
    case 'PLAN_SCENE_CARDS_ERROR':
      return 'Could not draw scene cards. Ask again in a moment, or say "no scene cards".';
    case 'PLAN_PROMPT_OVERRIDE_NEEDS_SCENE_CARDS':
      return 'Per-clip prompt overrides require scene cards.';
    case 'PLAN_BAD_PROMPT_OVERRIDES':
      return 'The per-clip prompt overrides are invalid.';
    default:
      return null;
  }
}

function estimate(plan) {
  let unit = { amountPerAttempt: 0, currency: 'CNY', detail: '测试模式，不产生费用' };
  try {
    unit = pricing.computeUnitPrice({
      model: plan.model,
      resolution: plan.resolution,
      clipDurationSec: plan.clipDurationSec,
      modelId: plan.modelId || ''
    });
  } catch (e) {
    unit = { amountPerAttempt: 0, currency: 'CNY', detail: '价目表缺该组合：' + (e && e.message) };
  }
  const unitCny = Number(unit.amountPerAttempt) || 0;
  const totalCny = pricing.round2(unitCny * plan.clipCount);
  const retryCapCny = pricing.round2(totalCny * LIMITS.retryBudgetRatio);
  // mock 单价 0 → 不设上限（仍然受 maxQcRetries=2 限制）
  const retryAffordable = unitCny > 0 ? Math.floor((retryCapCny + 1e-9) / unitCny) : Infinity;
  const autoQcRetries = Math.max(0, Math.min(LIMITS.maxQcRetries, retryAffordable));
  const usd = plan.model === 'mock'
    ? { usd: 0, breakdown: { video: 0, image: 0, llm: 0, clips: plan.clipCount, seconds: plan.clipDurationSec, resolution: plan.resolution, videoRate: 0 } }
    : budget.estimateTask({
      clips: plan.clipCount,
      seconds: plan.clipDurationSec,
      resolution: plan.resolution,
      images: 0,
      llmCalls: 0
    });
  return {
    unitCny,
    totalCny,
    retryCapCny,
    retryAffordable: retryAffordable === Infinity ? null : retryAffordable,
    autoQcRetries,
    priceDetail: plan.model === 'mock' ? 'Mock 测试模式，不产生费用' : unit.detail,
    currency: 'CNY',
    budget: {
      usd: usd.usd,
      breakdown: usd.breakdown,
      // 余额闸门只对真实计费模型有意义；mock 永远 0。
      requiresPaymentApproval: plan.model !== 'mock' && totalCny > 0
    }
  };
}

/**
 * 组装并校验计划卡。
 * @param {object} input { text?, theme?, totalMinutes?, clipDurationSec?, clipCount?, resolution?, model?, sceneCards?, sessionId?, modelId?, now? }
 * @returns {{ok:true, plan:object}|{ok:false, code:string, error:string, missing?:string[], question?:string}}
 */
function buildPlan(input = {}) {
  const parsed = parseUtterance(input.text || '');
  const pick = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v);

  // 默认模型 = WhaleTV 中转（openai-video）：2026-11-16 20:4x 用户明确要求「生视频必须用 WhaleTV key」。
  // 图生视频已实测可用（/video/generations + 公网 URL / data URL 两种形态都出片）。
  const modelId = String(pick(input.model, pick(parsed.model, 'openai-video')));
  const model = MODELS[modelId];
  if (!model) {
    return fail('PLAN_UNKNOWN_MODEL', `不认识的视频模型：${modelId}（可用：${Object.keys(MODELS).join(' / ')}）`);
  }

  const sceneCardEnabled = input.sceneCards !== undefined && input.sceneCards !== null
    ? input.sceneCards !== false
    : (pick(parsed.sceneCards, true));

  const resolution = String(pick(input.resolution, pick(parsed.resolution, '720p'))).toLowerCase();
  if (!['480p', '720p', '1080p', '4k', '2160p'].includes(resolution)) {
    return fail('PLAN_BAD_RESOLUTION', `不支持的分辨率：${resolution}`, { missing: ['resolution'] });
  }

  // ---- 段数 / 时长 ----
  let clipDurationSec = pick(input.clipDurationSec, parsed.clipDurationSec);
  if (sceneCardEnabled) {
    // 场景卡支持 10 或 15 秒/段（2026-11-16 用户批准 15 秒；默认仍 10 秒）。
    // 用户显式给了别的值 → 明确拒绝，不静默改。
    if (clipDurationSec !== null && clipDurationSec !== undefined
      && !LIMITS.sceneCardClipSecAllowed.includes(Number(clipDurationSec))) {
      return fail('PLAN_SCENE_CARD_DURATION',
        `场景卡只支持 ${LIMITS.sceneCardClipSecAllowed.join(' 或 ')} 秒/段（默认 ${LIMITS.sceneCardClipSec} 秒）；`
        + `本次给的是 ${clipDurationSec} 秒。`
        + `请改成 ${LIMITS.sceneCardClipSec} 秒或 ${LIMITS.sceneCardClipSecAllowed[LIMITS.sceneCardClipSecAllowed.length - 1]} 秒，`
        + '或说「不用场景卡」。');
    }
    if (clipDurationSec === null || clipDurationSec === undefined) clipDurationSec = LIMITS.sceneCardClipSec;
  }
  if (clipDurationSec === null || clipDurationSec === undefined) clipDurationSec = 10;
  clipDurationSec = Number(clipDurationSec);
  if (!Number.isFinite(clipDurationSec) || clipDurationSec < model.minSec || clipDurationSec > model.maxSec) {
    return fail('PLAN_BAD_CLIP_DURATION',
      `${model.label} 每段时长必须在 ${model.minSec}–${model.maxSec} 秒之间（本次 ${clipDurationSec} 秒）。`,
      { missing: ['clipDurationSec'] });
  }

  const totalMinutes = pick(input.totalMinutes, parsed.totalMinutes);
  let clipCount = input.clipCount !== undefined && input.clipCount !== null && input.clipCount !== ''
    ? input.clipCount
    : null;

  if (totalMinutes === null || totalMinutes === undefined || !(Number(totalMinutes) > 0)) {
    // 没给总时长时，用户口述的段数就是唯一依据；也没有段数 → 必须问（§7：总时长无默认）。
    if (clipCount === null) clipCount = parsed.clipCount;
    if (!clipCount) {
      const needDurText = '这条视频要做多长？比如「30 秒」「10 分钟」或「半小时」。';
      return fail('PLAN_NEED_DURATION', needDurText,
        { missing: ['totalMinutes'], question: needDurText });
    }
  } else if (clipCount === null) {
    // 给了总时长：段数由「总时长 ÷ 每段时长」向上取整决定（§7：用户给总时长 + 每段时长）。
    const totalSec = Number(totalMinutes) * 60;
    clipCount = Math.ceil(totalSec / clipDurationSec - 1e-9);
  }
  clipCount = Number(clipCount);
  if (!Number.isFinite(clipCount) || clipCount < 1) {
    return fail('PLAN_BAD_COUNT', '片段数至少 1 段。', { missing: ['clipCount'] });
  }
  clipCount = Math.round(clipCount);

  // 如果只给了总时长：实际时长按段数 × 每段向上取整（可能比目标略长，如实写进计划卡）
  const requestedTotalSec = totalMinutes !== null && totalMinutes !== undefined
    ? Math.round(Number(totalMinutes) * 60)
    : null;
  const actualTotalSec = clipCount * clipDurationSec;

  // ---- 上限 ----
  if (actualTotalSec > LIMITS.maxMinutes * 60 + 1e-6) {
    return fail('PLAN_TOO_LONG',
      `单任务总时长上限 ${LIMITS.maxMinutes} 分钟（本次 ${(actualTotalSec / 60).toFixed(1)} 分钟）。`
      + '请缩短时长，或拆成多条任务。');
  }
  if (clipCount > LIMITS.maxClips) {
    return fail('PLAN_TOO_MANY_CLIPS',
      `单任务片段上限 ${LIMITS.maxClips} 段（本次 ${clipCount} 段）。请减少段数或延长每段时长。`);
  }

  // ---- 场景卡容量（P4 已有卡库校验，这里提前给出可读错误）----
  if (sceneCardEnabled) {
    if (clipCount > LIMITS.sceneCardMaxClips) {
      return fail('PLAN_SCENE_CARDS_EXHAUSTED',
        `场景卡正片只有 ${LIMITS.sceneCardMaxClips} 张（按 ${clipDurationSec} 秒/段 = `
        + `${(LIMITS.sceneCardMaxClips * clipDurationSec / 60).toFixed(0)} 分钟）。`
        + `本次要 ${clipCount} 段，需要先扩卡库；或说「不用场景卡」。`);
    }
    const cap = sceneCards.checkCapacity(clipCount);
    if (!cap.ok) {
      return fail(cap.code || 'PLAN_SCENE_CARDS_ERROR',
        `场景卡容量不足：${cap.error || '未知原因'}（可用 ${cap.available || 0} 张）。`);
    }
  }

  // ---- 场景卡 id（P7-A）----
  // 计划阶段就把 N 张卡固定下来（allocate 是纯函数、不占卡），执行时按 id 传给
  // taskManager.createTask —— 「换单段场景卡」只需改这个数组里的一项，planId 不变。
  // 卡库文件被换掉、id 不存在时，execute 会拿到明确错误（提示重新排计划），
  // 而不是在 createTask 里静默 allocate 出一批新卡。
  let sceneCardIds = null;
  if (sceneCardEnabled) {
    try {
      sceneCardIds = sceneCards.allocate(clipCount).used.map((entry) => entry.id);
    } catch (e) {
      return fail(e.code || 'PLAN_SCENE_CARDS_ERROR', `场景卡取卡失败：${e && e.message ? e.message : e}`);
    }
  }

  // ---- 每段提示词覆盖（P7-A）----
  // plan.promptOverrides 的键 = **0-based 段序号**（"0" = 第 1 段，写死在本注释里，
  // 并由 promptComposer.normalizePromptOverrides 断言/校验；1-based 的「第 N 段」
  // 只在 supervisor 解析用户话术时出现，进入计划前一律 -1）。
  // 只在场景卡计划下有意义：覆盖文本直接替换该段的 prompt/imagePrompt，
  // 场景卡仍保留做审计（见 promptComposer.composeClipPatch）。
  const overrideWarnings = [];
  let promptOverrides = {};
  if (input.promptOverrides !== undefined && input.promptOverrides !== null) {
    if (!sceneCardEnabled) {
      return fail('PLAN_PROMPT_OVERRIDE_NEEDS_SCENE_CARDS',
        '按段改提示词需要场景卡计划（这条计划关了场景卡）；请说「用场景卡」新排一条。',
        { missing: ['promptOverrides'] });
    }
    const norm = promptComposer.normalizePromptOverrides(input.promptOverrides, clipCount);
    if (!norm.ok) {
      return fail(norm.code || 'PLAN_BAD_PROMPT_OVERRIDES', norm.error || '提示词覆盖不合法',
        { missing: ['promptOverrides'] });
    }
    promptOverrides = norm.overrides;
    overrideWarnings.push(...(norm.warnings || []));
  }

  // ---- 主题（不作为长片选卡依据）----
  // 只接受调用方显式传入的 theme；用户口语里的地貌词不升级成「计划主题」。
  // 场景卡模式 = 卡库按 chapter+sequence 抽取不同场景，单一主题会把 60–180 段拉成同一类画面。
  let theme = input.theme ? String(input.theme).slice(0, 80) : null;
  let themeLabel = input.themeLabel || null;
  if (theme && !themeLabel) {
    const t = THEMES.find((x) => x.id === theme) || THEMES.find((x) => x.label === theme);
    themeLabel = t ? t.label : theme;
  }
  const mentionedThemeLabel = parsed.themeLabel || null;

  const planId = 'plan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const base = {
    version: PLAN_VERSION,
    planId,
    sessionId: input.sessionId || null,
    createdAt: new Date().toISOString(),
    text: parsed.raw,
    theme: theme || null,
    themeLabel: themeLabel || null,
    userPrompt: String(input.userPrompt || parsed.userPrompt || '').slice(0, 400),
    totalMinutes: actualTotalSec / 60,
    requestedTotalMinutes: requestedTotalSec === null ? null : requestedTotalSec / 60,
    clipDurationSec,
    clipCount,
    totalSec: actualTotalSec,
    resolution,
    model: modelId,
    modelLabel: model.label,
    // 2026-11-18 S0：英文渲染用 labelEn（缺省回退中文，保证老计划卡不炸）。
    modelLabelEn: model.labelEn || model.label,
    modelId: input.modelId ? String(input.modelId) : null,
    sceneCards: sceneCardEnabled,
    sceneCardsRequired: true, // 小智计划默认走卡库（§7）
    // P7-A：这一轮要用的卡 id（与 clipCount 等长；换单段只改一项）。
    sceneCardIds,
    // P7-A：逐段提示词覆盖（键 = 0-based 段序号）；null = 全部按场景卡。
    promptOverrides: Object.keys(promptOverrides).length ? promptOverrides : null,
    // P7-A：配乐选择（由 supervisor 的「配乐」意图写入）。
    //   null = 未指定（执行时用默认「自动」）；{enabled:true,mode:'manual',trackId} = 指定曲目；
    //   {enabled:false,mode:'off'} = 不要配乐。
    bgm: null,
    // P7-A：最近一次列出的配乐曲目 id 顺序（持久化在计划里，「用第 N 首」靠它，
    // 不用进程内存 Map —— 服务重启后上下文不丢）。
    bgmChoices: null,
    limits: {
      maxMinutes: LIMITS.maxMinutes,
      maxClips: LIMITS.maxClips,
      sceneCardMaxClips: LIMITS.sceneCardMaxClips,
      retryBudgetRatio: LIMITS.retryBudgetRatio,
      maxQcRetries: LIMITS.maxQcRetries,
      fillRatio: LIMITS.fillRatio,
      fillMaxClips: LIMITS.fillMaxClips
    },
    fillMaxClips: Math.min(LIMITS.fillMaxClips, Math.floor(clipCount * LIMITS.fillRatio)),
    warnings: [],
    // 2026-11-18 S0（加法式，不动 warnings 的既有形状）：
    // 每条 warnings 配一个结构化 key/params，英文渲染走它，不再依赖中文串拼句。
    // 与 warnings 等长、按下标对齐；null 表示「这条没有结构化版本」（回退原文）。
    warningKeys: []
  };

  if (base.requestedTotalMinutes !== null && base.totalSec > requestedTotalSec + 1e-6) {
    // 2026-11-18 S0：浮点格式化（旧文案 0.4166666666666667）+ 结构化 key。
    base.warnings.push(
      `目标 ${fmtMinutes(base.requestedTotalMinutes)} 分钟，按 ${clipDurationSec} 秒/段向上取整 → ${clipCount} 段 = `
      + `${(actualTotalSec / 60).toFixed(2)} 分钟。`);
    base.warningKeys.push({
      key: 'plan.roundUp',
      params: {
        requestedMinutes: fmtMinutes(base.requestedTotalMinutes),
        clipSec: clipDurationSec,
        clipCount,
        totalMinutes: (actualTotalSec / 60).toFixed(2)
      }
    });
  }
  // 用户随口提主题词时只提示「不按主题选卡」，不静默忽略、也不写成计划主题。
  if (mentionedThemeLabel && sceneCardEnabled && !input.theme) {
    base.warnings.push(
      `你提到了「${mentionedThemeLabel}」：长片按场景卡库自动抽取不同场景，不按单一主题选卡；`
      + '这个主题词不会影响出片，只作提示。');
    base.warningKeys.push({ key: 'plan.themeIgnored', params: { theme: mentionedThemeLabel } });
  }
  // P7-A：提示词被截断等必须告知用户，不静默。
  // （这些是用户内容相关提示，没有结构化版本 → 推 null 保持下标对齐，英文侧回退原文。）
  overrideWarnings.forEach((w) => { base.warnings.push(w); base.warningKeys.push(null); });

  const est = estimate(base);
  base.estimate = est;
  base.requiresPaymentApproval = !!est.budget.requiresPaymentApproval;
  base.currency = est.currency;

  return { ok: true, plan: base };
}

// 用 LLM 返回的 JSON 槽位合并用户原句（模型只填槽，不执行）。
// 只接受白名单字段，非法值交给 buildPlan 统一校验。
function mergeModelSlots(text, slots) {
  const s = (slots && typeof slots === 'object') ? slots : {};
  const num = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = parseCnNumber(String(v));
    return n === null ? undefined : n;
  };
  return {
    text,
    totalMinutes: num(s.totalMinutes),
    clipDurationSec: num(s.clipDurationSec),
    clipCount: num(s.clipCount),
    resolution: typeof s.resolution === 'string' ? s.resolution : undefined,
    model: typeof s.model === 'string' ? s.model : undefined,
    theme: typeof s.theme === 'string' ? s.theme : undefined,
    sceneCards: typeof s.sceneCards === 'boolean' ? s.sceneCards : undefined
  };
}

// 计划卡 → 给人看的几行说明（UI 计划卡、日志共用）。
// P3：可选 lang —— 英文模式返回独立英文说明；默认/zh 逐字返回改造前的中文（零回归）。
// 2026-11-18 S0：计划卡警告的英文渲染。输入是 buildPlan 产出的 {key, params}，
// 不认识/为空时返回 ''（调用方回退原文，避免把中文硬翻成英文）。
function warningTextEn(wk) {
  const p = (wk && wk.params) || {};
  switch (wk && wk.key) {
    case 'plan.roundUp':
      return `you asked for ${p.requestedMinutes} min; at ${p.clipSec}s per clip that rounds up to `
        + `${p.clipCount} clips = ${p.totalMinutes} min.`;
    case 'plan.themeIgnored':
      return `you mentioned "${p.theme}": this pipeline draws different scenes from the scene-card library `
        + 'in chapter order instead of following one theme, so the word does not change the output — noted for reference only.';
    default:
      return '';
  }
}

function describe(plan, lang) {
  if (!plan || typeof plan !== 'object') return [];
  if (String(lang || '').toLowerCase().startsWith('en')) {
    // 独立英文模板（不逐句翻译中文）：数字/品牌/主题名保持原值，不翻译用户内容。
    const linesEn = [];
    const secTotalEn = Math.round(Number(plan.totalSec) || 0);
    const minsEn = secTotalEn / 60;
    const durLabelEn = minsEn >= 10 ? `${minsEn.toFixed(1)} minutes`
      : (minsEn >= 1 ? `${minsEn.toFixed(2)} minutes` : `${secTotalEn} seconds`);
    linesEn.push(`Total length ${durLabelEn} (${plan.clipCount} clips × ${plan.clipDurationSec} s)`);
    if (plan.themeLabel) linesEn.push(`Theme: ${plan.themeLabel}`);
    linesEn.push(`Model: ${plan.modelLabelEn || plan.modelLabel} · ${plan.resolution}`);
    linesEn.push(plan.sceneCards
      ? `Scenes: ${plan.clipCount} distinct cards drawn from the scene-card library, played in chapter order without repeats`
      : 'Scenes: free-form prompts (scene cards off)');
    if (plan.estimate) {
      if (plan.estimate.totalCny > 0) {
        linesEn.push(`Estimated cost: ¥${plan.estimate.totalCny.toFixed(2)} `
          + `(retry cap ¥${plan.estimate.retryCapCny.toFixed(2)}, up to ${plan.estimate.autoQcRetries} automatic retries)`);
      } else {
        linesEn.push('Estimated cost: ¥0 (Mock mode, no charge)');
      }
      if (plan.estimate.budget && plan.estimate.budget.usd > 0) {
        linesEn.push(`Budget gate: $${plan.estimate.budget.usd.toFixed(2)} USD (submission is refused if the balance is too low)`);
      }
    }
    if (plan.fillMaxClips !== undefined) {
      linesEn.push(`Failure fill-in: up to ${plan.fillMaxClips} clips (≤5% and ≤10 clips)`);
    }
    // 2026-11-18 S0：英文警告走结构化 key；只有「用户内容类」提示（没有 key）才回退中文原文。
    (plan.warnings || []).forEach((w, i) => {
      const wk = (plan.warningKeys || [])[i];
      linesEn.push('Note: ' + (warningTextEn(wk) || w));
    });
    return linesEn;
  }
  const lines = [];
  const mins = plan.totalSec / 60;
  // 不到 1 分钟时按秒显示（「30 秒」比「0.50 分钟」更好读；2026-11-16 支持秒级时长）。
  const secTotal = Math.round(Number(plan.totalSec) || 0);
  const durLabel = mins >= 10 ? `${mins.toFixed(1)} 分钟`
    : (mins >= 1 ? `${mins.toFixed(2)} 分钟` : `${secTotal} 秒`);
  lines.push(`总时长 ${durLabel}（${plan.clipCount} 段 × ${plan.clipDurationSec} 秒）`);
  if (plan.themeLabel) lines.push(`主题：${plan.themeLabel}`);
  lines.push(`模型：${plan.modelLabel} · ${plan.resolution}`);
  lines.push(plan.sceneCards
    ? `场景：场景卡库随机抽取 ${plan.clipCount} 个不同场景（按章节顺序播映，不重复）`
    : '场景：自由提示词（已关闭场景卡）');
  if (plan.estimate) {
    if (plan.estimate.totalCny > 0) {
      lines.push(`预估费用：¥${plan.estimate.totalCny.toFixed(2)}（重试上限 ¥${plan.estimate.retryCapCny.toFixed(2)}，最多 ${plan.estimate.autoQcRetries} 次）`);
    } else {
      lines.push('预估费用：¥0（Mock 测试模式，不产生费用）');
    }
    if (plan.estimate.budget && plan.estimate.budget.usd > 0) {
      lines.push(`预算闸门：$${plan.estimate.budget.usd.toFixed(2)} USD（余额不足会拒绝提交）`);
    }
  }
  if (plan.fillMaxClips !== undefined) lines.push(`失败补位：最多 ${plan.fillMaxClips} 段（≤5% 且 ≤10 段）`);
  (plan.warnings || []).forEach((w) => lines.push('注意：' + w));
  return lines;
}

module.exports = {
  PLAN_VERSION,
  MODELS,
  LIMITS,
  THEMES,
  parseCnNumber,
  normalizeText,
  parseUtterance,
  buildPlan,
  mergeModelSlots,
  estimate,
  describe,
  describeErrorEn
};
