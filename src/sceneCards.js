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

// 取一轮卡：按 chapter+sequence 从第 1 张顺序取 count 张正片。
// 纯函数（除读取缓存外无副作用）：不足直接抛错，不返回半轮结果。
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
  const plan = {
    enabled: true,
    roundId: _makeRoundId(),
    schemaVersion: lib.meta.schemaVersion,
    version: lib.meta.version,
    featureTotal: lib.features.length,
    bufferTotal: lib.buffers.length,
    durationSec: lib.meta.durationSec,
    allocatedAt: new Date().toISOString(),
    used: lib.features.slice(0, n).map((card, i) => _entry(card, i)),
    buffers: [],
    replacements: [],
    status: null
  };
  plan.status = statusOf(plan);
  return plan;
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
  const card = lib.buffers.find(b => !usedIds.has(b.id));
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
  validateLibrary,
  loadLibrary,
  resetCache,
  getStats,
  getCardById,
  checkCapacity,
  allocate,
  replaceWithBuffer,
  statusOf
};
