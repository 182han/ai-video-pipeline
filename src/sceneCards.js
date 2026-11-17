// ==========================================
// 场景卡库：读取 / 一轮取卡（不放回）/ buffer 替换（P4）
// ------------------------------------------------------------
// 用途：30 分钟长片 = 180 张正片卡 × 10 秒/张。本模块只做「卡库 + 分配」，
// 不生成提示词、不碰任务状态（由 promptComposer / pipeline 调用）。
//
// 已定产品决策（docs/交接/2026-11-15-handoff.md §7，不要重新讨论）：
//   · v3.3 为唯一输入：assets/scene-cards/v3.3-final.json（200 张 = 180 正片 + 20 缓冲）；
//   · 按 chapter + sequence 顺序取，**同一轮内不放回**；
//   · buffer 只在「生成失败」时替换，不参与初始分配；
//   · 耗尽后**报错并提示扩卡库**，不静默复用。
//
// 「一轮（round）」= 一条生成任务的一次取卡批次。
//   原因：30 分钟不重复是**单条成片内**的约束；若做成跨任务的全局游标，
//   跑满 180 张后后续任务会全部失败，且与「不静默复用」冲突。
//   每条任务从 chapter 1 / sequence 1 开始，任务内 scene_key 唯一；
//   task.sceneCards.status 如实报告 used / remaining / exhausted。
//
// 卡文件是只读输入：本模块与 promptComposer 都不写回卡。
// ==========================================

'use strict';

const fs = require('fs');
const path = require('path');

const CARD_FILE = path.join(__dirname, '..', 'assets', 'scene-cards', 'v3.3-final.json');
const SCHEMA_VERSION = 'scene-card.v3.3';
const FEATURE_COUNT = 180;
const BUFFER_COUNT = 20;
const DURATION_SEC = 10;

// mtime + size 缓存：卡文件被替换后下一次调用自动重读，不要求重启服务。
let cache = { mtimeMs: -1, size: -1, file: null, library: null };

function sceneCardsError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details && typeof details === 'object') err.details = details;
  return err;
}

function _isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function _fmtCard(card) {
  return `${card && card.id ? card.id : '(无 id)'}`;
}

// 校验卡库结构。**只读**，不修改传入对象。
// 为什么校验这么严：卡库是唯一输入，字段缺失会在运行到第 N 段时才炸（且已花钱），
// 所以在加载时一次性拒绝，错误信息带位置与原因。
function validateLibrary(raw, source) {
  const src = source || CARD_FILE;
  const fail = (msg, details) => {
    throw sceneCardsError('SCENE_CARDS_INVALID', `场景卡库无效（${src}）：${msg}`, details);
  };
  if (!_isPlainObject(raw)) fail('顶层不是 JSON 对象');
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion=${JSON.stringify(raw.schemaVersion)}，期望 ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.cards) || raw.cards.length === 0) fail('cards 不是非空数组');

  const cards = raw.cards;
  const features = cards.filter(c => _isPlainObject(c) && c.role === 'feature');
  const buffers = cards.filter(c => _isPlainObject(c) && c.role === 'buffer');

  if (features.length !== FEATURE_COUNT) {
    fail(`正片 ${features.length} 张，期望 ${FEATURE_COUNT} 张`, { featureCount: features.length });
  }
  if (buffers.length !== BUFFER_COUNT) {
    fail(`缓冲 ${buffers.length} 张，期望 ${BUFFER_COUNT} 张`, { bufferCount: buffers.length });
  }
  if (cards.length !== FEATURE_COUNT + BUFFER_COUNT) {
    fail(`总卡数 ${cards.length}，期望 ${FEATURE_COUNT + BUFFER_COUNT}`);
  }

  const byId = new Map();
  const roleErrors = [];
  for (const c of cards) {
    if (!_isPlainObject(c)) { roleErrors.push('存在非对象卡'); continue; }
    if (typeof c.id !== 'string' || !c.id.trim()) roleErrors.push('存在缺少 id 的卡');
    if (typeof c.scene_key !== 'string' || !c.scene_key.trim()) roleErrors.push(`${_fmtCard(c)} 缺少 scene_key`);
    if (c.role !== 'feature' && c.role !== 'buffer') roleErrors.push(`${_fmtCard(c)} role=${JSON.stringify(c.role)}`);
    if (byId.has(c.id)) roleErrors.push(`卡 id 重复：${c.id}`);
    else byId.set(c.id, c);
  }
  if (roleErrors.length) fail(roleErrors.slice(0, 5).join('；'), { errors: roleErrors.slice(0, 20) });

  // 正片：scene_key 唯一（spec 要求 180 个语义唯一键）
  const keys = features.map(c => c.scene_key);
  const uniq = new Set(keys);
  if (uniq.size !== FEATURE_COUNT) {
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i).slice(0, 5);
    fail(`正片 scene_key 唯一数 ${uniq.size}，期望 ${FEATURE_COUNT}（重复示例：${dup.join(' / ')}）`, {
      unique: uniq.size, duplicates: dup
    });
  }

  // 正片：chapter + sequence 严格递增（取卡顺序依赖文件顺序，不能悄悄乱序）
  let prev = null;
  for (const c of features) {
    if (!Number.isInteger(c.chapter) || !Number.isInteger(c.sequence)) {
      fail(`${_fmtCard(c)} 缺少整数 chapter/sequence`, { id: c.id, chapter: c.chapter, sequence: c.sequence });
    }
    if (prev && (c.chapter < prev.chapter
      || (c.chapter === prev.chapter && c.sequence <= prev.sequence))) {
      fail(`正片顺序不是 chapter+sequence 严格递增：${_fmtCard(prev)}(${prev.chapter}:${prev.sequence})`
        + ` → ${_fmtCard(c)}(${c.chapter}:${c.sequence})`, { prev: prev.id, next: c.id });
    }
    prev = c;
  }

  // buffer：不要求 chapter/sequence（当前文件里是 0/0），但必须有 scene_key/palette_id
  for (const c of buffers) {
    if (c.variant_of !== undefined && c.variant_of !== null && typeof c.variant_of !== 'string') {
      fail(`${_fmtCard(c)} variant_of 非法`);
    }
  }

  // promptComposer 需要的最小字段；缺了会在生成时才炸（已扣费），提前拒绝。
  const REQUIRED = ['feature', 'protagonist', 'shot', 'cameraAngle', 'lens', 'motion', 'palette', 'palette_id', 'style'];
  const missing = [];
  for (const c of features) {
    for (const k of REQUIRED) {
      if (c[k] === undefined || c[k] === null || String(c[k]).trim() === '') missing.push(`${c.id}.${k}`);
    }
  }
  if (missing.length) fail(`正片缺少必填字段：${missing.slice(0, 8).join(', ')}`, { missing: missing.slice(0, 50) });

  return {
    meta: {
      source: path.resolve(src),
      schemaVersion: raw.schemaVersion,
      version: raw.version || null,
      createdAt: raw.createdAt || null,
      total: cards.length,
      featureCount: features.length,
      bufferCount: buffers.length,
      durationSec: Number(raw.durationSec) > 0 ? Number(raw.durationSec) : DURATION_SEC,
      sceneKeyUnique: uniq.size,
      styleCount: raw.styleCount || null,
      shotGroups: raw.shotGroups || null
    },
    cards,
    features,
    buffers,
    byId
  };
}

// 读取卡库（带 mtime/size 缓存）。options.file 仅用于验收脚本注入坏文件/临时副本。
function loadLibrary(options = {}) {
  const file = options.file ? path.resolve(String(options.file)) : CARD_FILE;
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    throw sceneCardsError('SCENE_CARDS_UNAVAILABLE',
      `场景卡库不可读：${file}（${e.code || e.message}）。请恢复受控副本后再试。`, { file });
  }
  if (!options.file && cache.library && cache.file === file
    && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.library;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw sceneCardsError('SCENE_CARDS_INVALID', `场景卡库 JSON 解析失败（${file}）：${e.message}`, { file });
  }
  const library = validateLibrary(raw, file);
  if (!options.file) cache = { mtimeMs: st.mtimeMs, size: st.size, file, library };
  return library;
}

function resetCache() {
  cache = { mtimeMs: -1, size: -1, file: null, library: null };
}

function getStats(options = {}) {
  const lib = loadLibrary(options);
  return {
    ok: true,
    ...lib.meta,
    featureKeysUnique: lib.meta.sceneKeyUnique,
    durationSec: lib.meta.durationSec,
    // 单任务取卡上限 = 正片数量；超过必须扩卡库（产品已定）
    maxClipsPerTask: lib.features.length
  };
}

function getCardById(id) {
  if (id === undefined || id === null) return null;
  const lib = loadLibrary();
  return lib.byId.get(String(id)) || null;
}

function _entry(card, index, extra = {}) {
  return {
    index,
    id: card.id,
    scene_key: card.scene_key,
    chapter: Number.isInteger(card.chapter) ? card.chapter : null,
    sequence: Number.isInteger(card.sequence) ? card.sequence : null,
    role: card.role,
    palette_id: card.palette_id || null,
    ...extra
  };
}

function _makeRoundId() {
  return 'scr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ==========================================
// 随机抽卡 + 跨计划冷却（2026-11-17 小智 2.0 V1 §9.1-4；Q24=B / Q25=A / Q30=C）
// ------------------------------------------------------------
// 决策（已定，不要重新讨论）：
//   · 每个**新计划**随机抽 N 张正片（不再按 chapter+sequence 顺序取前 N 张）；
//   · 同一计划内稳定：抽到就固定在 plan.sceneCardIds 里；allocate/planFromIds 的**结构不变**；
//   · **跨计划冷却**：最近 3 个计划用过的卡尽量不再给；卡不够时回退（不报错、不静默复用）；
//   · 换单段卡（nextSwapCandidate）用同一套规则：随机 + 未用 + 避开冷却。
//
// 展示顺序：随机只决定「选哪些卡」，选完仍按 chapter+sequence 排序（长片画面推进不乱）。
// 取满 180 张时结果与旧的顺序取卡**完全一致**（全部选中 → 排序后就是原顺序），零回归。
//
// 冷却状态是**运行期数据**，落在 data/assistant/scene-card-cooling.json
// （.gitignore 已忽略 data/assistant/，不进版本库）；不新增任何 npm 依赖。
// 写盘失败一律静默：冷却只影响观感，绝不能把「排计划」拖垮。
// ==========================================
const COOLING_PLANS = 3;
const COOLING_VERSION = 'scene-card-cooling.v1';

function coolingFile() {
  if (process.env.SCENE_CARDS_COOLING_FILE) return path.resolve(String(process.env.SCENE_CARDS_COOLING_FILE));
  const base = process.env.ASSISTANT_DIR
    ? path.resolve(String(process.env.ASSISTANT_DIR))
    : path.join(__dirname, '..', 'data', 'assistant');
  return path.join(base, 'scene-card-cooling.json');
}

function readCooling() {
  try {
    const raw = JSON.parse(fs.readFileSync(coolingFile(), 'utf8'));
    const plans = Array.isArray(raw && raw.plans) ? raw.plans : [];
    return {
      version: COOLING_VERSION,
      plans: plans
        .filter((p) => p && Array.isArray(p.ids) && p.ids.length)
        .slice(-COOLING_PLANS)
        .map((p) => ({ roundId: p.roundId || null, ids: p.ids.map(String), at: p.at || null }))
    };
  } catch (e) {
    return { version: COOLING_VERSION, plans: [] };
  }
}

function writeCooling(state) {
  try {
    const file = coolingFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const data = {
      version: COOLING_VERSION,
      plans: (state && Array.isArray(state.plans) ? state.plans : []).slice(-COOLING_PLANS)
    };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

// 最近 3 个计划用过的卡 id 合集（当前这次取卡还没写盘，所以不会冷却到自己）。
function recentUsedIds() {
  const set = new Set();
  for (const p of readCooling().plans) for (const id of p.ids) set.add(String(id));
  return set;
}

function recordCooling(roundId, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) return false;
  const state = readCooling();
  const plans = state.plans.filter((p) => !roundId || p.roundId !== roundId);
  plans.push({ roundId: roundId || null, ids: list, at: new Date().toISOString() });
  return writeCooling({ version: COOLING_VERSION, plans });
}

// 清空冷却（验收脚本用；不影响卡库文件）。
function resetCooling() {
  try { fs.unlinkSync(coolingFile()); } catch (e) { /* 不存在就算了 */ }
}

function _hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _mulberry32(a) {
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// options.seed 给了 → 确定性序列（验收脚本复现用）；没给 → Math.random。
function _rng(options) {
  const seed = options && options.seed;
  if (seed !== undefined && seed !== null && String(seed) !== '') return _mulberry32(_hashSeed(String(seed)));
  return Math.random;
}

function _shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// 冷却优先：先把「不在冷却里」的卡洗好放在前面，再用冷却里的卡补足（卡不够回退）。
function _splitByCooldown(cards, options) {
  const cooldown = options && options.noCooling ? new Set() : recentUsedIds();
  const cool = [];
  const warm = [];
  for (const c of cards) (cooldown.has(c.id) ? warm : cool).push(c);
  return { cool, warm };
}

function _byChapter(a, b) {
  return ((Number(a.chapter) || 0) - (Number(b.chapter) || 0))
    || ((Number(a.sequence) || 0) - (Number(b.sequence) || 0));
}

function statusOf(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const used = Array.isArray(plan.used) ? plan.used.length : 0;
  const featureTotal = Number.isInteger(plan.featureTotal) ? plan.featureTotal : FEATURE_COUNT;
  const bufferTotal = Number.isInteger(plan.bufferTotal) ? plan.bufferTotal : BUFFER_COUNT;
  const bufferUsed = Array.isArray(plan.buffers) ? plan.buffers.length : 0;
  return {
    used,
    remaining: Math.max(0, featureTotal - used),
    exhausted: used >= featureTotal,
    featureTotal,
    bufferTotal,
    bufferUsed,
    bufferRemaining: Math.max(0, bufferTotal - bufferUsed),
    featureRoleCount: (plan.used || []).filter(e => e && e.role === 'feature').length,
    bufferRoleCount: (plan.used || []).filter(e => e && e.role === 'buffer').length
  };
}

// 预检（不占卡）：服务端在创建任务前用它给出 400，而不是等 createTask 抛错。
function checkCapacity(count) {
  let lib;
  try {
    lib = loadLibrary();
  } catch (e) {
    return { ok: false, code: e.code || 'SCENE_CARDS_INVALID', error: e.message, available: 0 };
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, code: 'SCENE_CARDS_BAD_COUNT', error: `取卡数量必须是正整数（收到 ${count}）`, available: lib.features.length };
  }
  if (n > lib.features.length) {
    return {
      ok: false,
      code: 'SCENE_CARDS_EXHAUSTED',
      error: `场景卡不足：本次需要 ${n} 张正片，卡库只有 ${lib.features.length} 张。`
        + `30 分钟上限 = ${lib.features.length} 张 × ${lib.meta.durationSec}s；超过必须先扩卡库。`,
      requested: n,
      available: lib.features.length,
      durationSec: lib.meta.durationSec
    };
  }
  return { ok: true, available: lib.features.length, requested: n, durationSec: lib.meta.durationSec };
}

// 取一轮卡：**随机**抽 count 张正片（2026-11-17 V1 §9.1-4；旧行为是按 chapter+sequence 顺序取）。
// 纯函数（除读取卡库缓存 + 写冷却文件外无副作用）：不足直接抛错，不返回半轮结果。
// options:
//   · seed          固定随机序列（验收用；不传 = 随机）
//   · noCooling     跳过跨计划冷却（验收用）
//   · recordCooling 默认 true；预览类调用（只看不排）传 false，不污染冷却
function allocate(count, options = {}) {
  const lib = loadLibrary(options);
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) {
    throw sceneCardsError('SCENE_CARDS_BAD_COUNT', `取卡数量必须是正整数（收到 ${count}）`, { requested: count });
  }
  if (n > lib.features.length) {
    throw sceneCardsError('SCENE_CARDS_EXHAUSTED',
      `场景卡不足：本次需要 ${n} 张正片，卡库只有 ${lib.features.length} 张。`
        + `30 分钟上限 = ${lib.features.length} 张 × ${lib.meta.durationSec}s；超过必须先扩卡库。`,
      { requested: n, available: lib.features.length, durationSec: lib.meta.durationSec });
  }
  // 随机决定「选哪些」：冷却优先 → 不够再用冷却里的补（回退，不报错）。
  const { cool, warm } = _splitByCooldown(lib.features, options);
  const rng = _rng(options);
  const picked = _shuffle(cool, rng).concat(_shuffle(warm, rng)).slice(0, n);
  // 选完仍按 chapter+sequence 排序：随机只决定选哪些，不改变画面推进顺序。
  picked.sort(_byChapter);
  const plan = {
    enabled: true,
    roundId: _makeRoundId(),
    schemaVersion: lib.meta.schemaVersion,
    version: lib.meta.version,
    featureTotal: lib.features.length,
    bufferTotal: lib.buffers.length,
    durationSec: lib.meta.durationSec,
    allocatedAt: new Date().toISOString(),
    used: picked.map((card, i) => _entry(card, i)),
    buffers: [],
    replacements: [],
    status: null,
    // 审计用：这一轮是随机抽的（换卡池/回退时也如实反映，见 used 的 id）
    source: 'random'
  };
  plan.status = statusOf(plan);
  if (options.recordCooling !== false) recordCooling(plan.roundId, plan.used.map((e) => e.id));
  return plan;
}

// 按显式 id 列表组装一轮取卡计划（P7-A：计划内换单段场景卡）。
// ------------------------------------------------------------
// 与 allocate() 产出的结构完全一致，唯一区别：used 的顺序/内容由调用方给定，
// **不再 allocate**（supervisor.execute 把计划卡上的 sceneCardIds 原样传进来）。
// 为什么需要它：计划卡在创建计划时就把 N 张卡固定下来（plan.sceneCardIds），
// 用户换单段后只改数组里的一个 id；执行时若还走 allocate，用户换的卡会被静默冲掉。
// 校验（任何一条不满足都抛明确错误，不静默兜底）：
//   · ids 必须是非空数组（数量由调用方对 totalClips 校验，这里可用 options.totalClips 再兜底）；
//   · 每个 id 必须存在（否则 SCENE_CARDS_MISSING_CARD，提示重新排计划）；
//   · 不允许重复（同一任务内 scene_key 唯一）；
//   · 只允许正片（buffer 只在生成失败时由 replaceWithBuffer 使用，不参与初始分配）。
function planFromIds(ids, options = {}) {
  const lib = loadLibrary(options);
  if (!Array.isArray(ids) || ids.length === 0) {
    throw sceneCardsError('SCENE_CARDS_BAD_IDS', '按 id 取卡需要一个非空 id 数组');
  }
  if (options.totalClips !== undefined && options.totalClips !== null
    && Number(options.totalClips) !== ids.length) {
    throw sceneCardsError('SCENE_CARDS_IDS_LENGTH',
      `场景卡 id 数量（${ids.length}）与片段数（${options.totalClips}）不一致`, {
        ids: ids.length,
        totalClips: Number(options.totalClips)
      });
  }
  const seen = new Set();
  const used = [];
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] === undefined || ids[i] === null ? '' : ids[i]).trim();
    if (!id) {
      throw sceneCardsError('SCENE_CARDS_BAD_IDS', `第 ${i + 1} 段的场景卡 id 为空`);
    }
    if (seen.has(id)) {
      throw sceneCardsError('SCENE_CARDS_IDS_DUPLICATE',
        `场景卡 id 重复：${id}（同一任务内 scene_key 必须唯一）`, { id, index: i });
    }
    const card = lib.byId.get(id);
    if (!card) {
      throw sceneCardsError('SCENE_CARDS_MISSING_CARD',
        `场景卡缺失：${id}（卡库文件可能被替换，请重新排计划）`, { id, index: i });
    }
    if (card.role !== 'feature') {
      throw sceneCardsError('SCENE_CARDS_BUFFER_NOT_ALLOCATABLE',
        `缓冲卡不能作为初始选卡：${id}（缓冲卡只在生成失败时替换）`, { id, index: i });
    }
    seen.add(id);
    used.push(_entry(card, i));
  }
  const plan = {
    enabled: true,
    roundId: _makeRoundId(),
    schemaVersion: lib.meta.schemaVersion,
    version: lib.meta.version,
    featureTotal: lib.features.length,
    bufferTotal: lib.buffers.length,
    durationSec: lib.meta.durationSec,
    allocatedAt: new Date().toISOString(),
    used,
    buffers: [],
    replacements: [],
    status: null,
    // 审计用：这一轮是按用户选定的 id 组的，不是按 chapter+sequence 顺序分配。
    source: 'explicit-ids'
  };
  plan.status = statusOf(plan);
  return plan;
}

// 换单段场景卡的候选（§9.1-4 / Q30=C：**随机 + 未用 + 避开最近 3 个计划**）。
// ------------------------------------------------------------
// 旧行为：从 currentId 之后按 chapter+sequence 找下一张没用过的卡（环形）。
// 新行为：在「所有没用过的正片」里随机挑一张；冷却里的卡只在没有别的选择时才用（回退）。
// 语义（保持不变，测试逐条断言）：
//   · currentId 必须存在于卡库，否则 SCENE_CARDS_MISSING_CARD（提示重排计划）；
//   · 全部正片都已在本计划用过 → SCENE_CARDS_SWAP_EXHAUSTED 明确报错，不静默复用；
//   · 返回 _entry，不改任何卡文件。
function nextSwapCandidate(currentId, usedIds, options = {}) {
  const lib = loadLibrary(options);
  const features = lib.features;
  const currentIdx = features.findIndex(c => c.id === String(currentId));
  if (currentIdx < 0) {
    throw sceneCardsError('SCENE_CARDS_MISSING_CARD',
      `场景卡缺失：${currentId}（卡库文件可能被替换，请重新排计划）`, { id: currentId });
  }
  const used = new Set((Array.isArray(usedIds) ? usedIds : []).map(id => String(id)));
  const remaining = features.filter(c => !used.has(c.id));
  if (!remaining.length) {
    throw sceneCardsError('SCENE_CARDS_SWAP_EXHAUSTED',
      `场景卡库 ${features.length} 张正片已经全部用在这条计划里，没有可换的卡；请先扩卡库。`, {
        featureTotal: features.length,
        used: used.size
      });
  }
  const { cool } = _splitByCooldown(remaining, options);
  // 冷却区里有卡就只用冷却区外的（真回退）；冷却区外的用完了才动冷却区。
  const pool = cool.length ? cool : remaining;
  const rng = _rng(options);
  const card = pool[Math.floor(rng() * pool.length)] || pool[0];
  return _entry(card, features.findIndex(c => c.id === card.id) >= 0
    ? features.findIndex(c => c.id === card.id) : currentIdx);
}

// buffer 替换：只在某个片段「生成失败」时调用（pipeline 在重试预算内调用）。
// 同一任务内 buffer 不复用；18 张用尽后返回 null（调用方保留原失败，不静默复用）。
// 返回 { card, plan, entry, buffer }，plan 已被就地更新（调用方负责持久化）。
function replaceWithBuffer(plan, index, reason) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.used)) {
    throw sceneCardsError('SCENE_CARDS_BAD_PLAN', 'replaceWithBuffer 需要一有效的取卡计划');
  }
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= plan.used.length) {
    throw sceneCardsError('SCENE_CARDS_BAD_INDEX', `片段索引越界：${index}（本轮 ${plan.used.length} 张）`);
  }
  const current = plan.used[i];
  if (!current) throw sceneCardsError('SCENE_CARDS_BAD_PLAN', `第 ${i + 1} 段没有已分配的场景卡`);
  if (current.role === 'buffer') return null; // 已经是缓冲卡，不再二次替换
  const lib = loadLibrary();
  const usedIds = new Set((plan.buffers || []).map(b => b && b.id));
  const existingKeys = new Set(plan.used
    .map((e, idx) => (idx === i ? null : e && e.scene_key))
    .filter(Boolean));
  // 2026-11-17（§9.1-4 随机抽卡的连带修复）：buffer 的 scene_key 与它 variant_of 的原卡**相同**
  // （实测 20 张 buffer 全部如此）。顺序取卡时前 N 张几乎不会撞上这些原卡；改成随机抽卡后，
  // 计划里出现某张原卡的概率变高，直接拿「第一张未用 buffer」会让任务里出现两个相同 scene_key。
  // 所以优先挑「不会与本计划其它段撞 key」的 buffer；实在没有（卡不够）才回退到第一张未用 buffer，
  // 保证 buffer 耗尽语义（用尽返回 null）不变。
  const unusedBuffers = lib.buffers.filter(b => !usedIds.has(b.id));
  const card = unusedBuffers.find(b => !existingKeys.has(b.scene_key)) || unusedBuffers[0];
  if (!card) return null; // 缓冲卡用尽
  const entry = _entry(card, i, {
    role: 'buffer',
    replacedFrom: {
      id: current.id,
      scene_key: current.scene_key,
      chapter: current.chapter,
      sequence: current.sequence
    }
  });
  plan.used[i] = entry;
  if (!Array.isArray(plan.buffers)) plan.buffers = [];
  if (!Array.isArray(plan.replacements)) plan.replacements = [];
  const at = new Date().toISOString();
  plan.buffers.push({
    index: i,
    id: card.id,
    scene_key: card.scene_key,
    role: 'buffer',
    palette_id: card.palette_id || null,
    replacedFrom: { ...entry.replacedFrom },
    reason: reason ? String(reason).slice(0, 500) : '',
    at
  });
  plan.replacements.push({
    index: i,
    from: { ...entry.replacedFrom },
    to: { id: card.id, scene_key: card.scene_key, role: 'buffer' },
    reason: reason ? String(reason).slice(0, 500) : '',
    at
  });
  plan.status = statusOf(plan);
  return { card, plan, entry, buffer: plan.buffers[plan.buffers.length - 1] };
}

module.exports = {
  CARD_FILE,
  SCHEMA_VERSION,
  FEATURE_COUNT,
  BUFFER_COUNT,
  DURATION_SEC,
  // 随机抽卡 + 冷却（2026-11-17 V1 §9.1-4）
  COOLING_PLANS,
  COOLING_VERSION,
  coolingFile,
  readCooling,
  writeCooling,
  recentUsedIds,
  recordCooling,
  resetCooling,
  validateLibrary,
  loadLibrary,
  resetCache,
  getStats,
  getCardById,
  checkCapacity,
  allocate,
  planFromIds,
  nextSwapCandidate,
  replaceWithBuffer,
  statusOf
};
