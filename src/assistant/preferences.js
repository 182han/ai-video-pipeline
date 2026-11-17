// ==========================================
// 小智 V2 · 跨会话偏好（Q15=B：服务端用户级存储，可清空）
// ------------------------------------------------------------
// 设计约束（共同契约 §0.4 / 设计文档 §2 V2）：
//   · 服务端用户级（不是浏览器 localStorage）——换窗口/换浏览器仍在；
//   · 只存「默认通道 / 分辨率 / BGM 风格 / 常用时长」四类白名单字段；
//   · **Key / token / secret / password 一律拒绝**：字段名命中即丢弃，值永不落盘；
//   · 可清空（clear），清空/写入都要走审计（见 audit.js，调用方负责记录）；
//   · 不新增 npm 依赖；文件落 data/assistant/preferences.json（ASSISTANT_PREFS_FILE 可覆盖）。
//
// 本模块只做「校验 + 读写」，不判断 L3（谁点确认由 supervisor/server 决定）。
// ==========================================

'use strict';

const fs = require('fs');
const path = require('path');
const planCard = require('./planCard');

const PREFS_VERSION = 'assistant-prefs.v1';
const ALLOWED_RESOLUTIONS = ['480p', '720p', '1080p', '4k', '2160p'];
const MAX_BGM_STYLE_CHARS = 40;
const DEFAULT_GLOBAL = Object.freeze({ broadcastEnabled: true, throttleSec: 30 });

const BASE_DIR = process.env.ASSISTANT_DIR
  ? path.resolve(process.env.ASSISTANT_DIR)
  : path.join(__dirname, '..', '..', 'data', 'assistant');

function file() {
  return process.env.ASSISTANT_PREFS_FILE
    ? path.resolve(process.env.ASSISTANT_PREFS_FILE)
    : path.join(BASE_DIR, 'preferences.json');
}

function emptyStore() {
  return { version: PREFS_VERSION, users: {}, global: { ...DEFAULT_GLOBAL, updatedAt: null } };
}

function normalizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  if (raw.users && typeof raw.users === 'object') {
    for (const uid of Object.keys(raw.users)) {
      const p = raw.users[uid];
      if (!p || typeof p !== 'object') continue;
      const clean = normalizePref(p);
      if (clean) store.users[uid] = clean;
    }
  }
  if (raw.global && typeof raw.global === 'object') {
    store.global = {
      broadcastEnabled: raw.global.broadcastEnabled !== false,
      throttleSec: Number.isFinite(Number(raw.global.throttleSec))
        ? Math.max(0, Math.min(3600, Number(raw.global.throttleSec)))
        : DEFAULT_GLOBAL.throttleSec,
      updatedAt: raw.global.updatedAt || null
    };
  }
  return store;
}

function normalizePref(p) {
  const out = {};
  if (p.model && planCard.MODELS[p.model]) out.model = p.model;
  if (p.resolution && ALLOWED_RESOLUTIONS.includes(String(p.resolution).toLowerCase())) {
    out.resolution = String(p.resolution).toLowerCase();
  }
  if (Number.isFinite(Number(p.clipDurationSec))) {
    const n = Math.round(Number(p.clipDurationSec));
    if (n >= 1 && n <= 60) out.clipDurationSec = n;
  }
  if (typeof p.bgmStyle === 'string' && p.bgmStyle.trim()) {
    out.bgmStyle = p.bgmStyle.trim().slice(0, MAX_BGM_STYLE_CHARS);
  }
  out.updatedAt = p.updatedAt || null;
  return Object.keys(out).length > 1 ? out : null;
}

function load() {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch (e) {
    return emptyStore();
  }
}

function save(store) {
  const dir = path.dirname(file());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, file());
  return store;
}

function get(userId) {
  const store = load();
  return store.users[String(userId || 'local')] || null;
}

// 白名单校验：返回 { accepted, rejected }。任何 key/token/secret/password 字段直接 rejected。
function validatePatch(patch) {
  const accepted = {};
  const rejected = [];
  const src = patch && typeof patch === 'object' ? patch : {};
  for (const k of Object.keys(src)) {
    if (/(?:api[_-]?key|access[_-]?key|secret|token|password|credential)/i.test(k)) {
      rejected.push({ key: k, reason: '敏感字段一律不落盘（Key 只报有/无）' });
      continue;
    }
    const v = src[k];
    if (k === 'model') {
      if (planCard.MODELS[v]) accepted.model = v;
      else rejected.push({ key: k, reason: `不认识的视频模型：${v}` });
    } else if (k === 'resolution') {
      const r = String(v || '').toLowerCase();
      if (ALLOWED_RESOLUTIONS.includes(r)) accepted.resolution = r;
      else rejected.push({ key: k, reason: `不支持的分辨率：${v}` });
    } else if (k === 'clipDurationSec') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1 && n <= 60) accepted.clipDurationSec = Math.round(n);
      else rejected.push({ key: k, reason: '常用时长必须是 1–60 秒' });
    } else if (k === 'bgmStyle') {
      const s = String(v == null ? '' : v).trim();
      if (s && s.length <= MAX_BGM_STYLE_CHARS) accepted.bgmStyle = s;
      else rejected.push({ key: k, reason: `BGM 风格必须 1–${MAX_BGM_STYLE_CHARS} 字` });
    } else {
      rejected.push({ key: k, reason: '不在白名单（只允许 model/resolution/clipDurationSec/bgmStyle）' });
    }
  }
  return { accepted, rejected };
}

function set(userId, patch) {
  const uid = String(userId || 'local');
  const v = validatePatch(patch);
  const store = load();
  const before = store.users[uid] || null;
  const merged = normalizePref({ ...(before || {}), ...v.accepted, updatedAt: new Date().toISOString() });
  if (!merged) {
    return { ok: false, code: 'PREFS_NOTHING_ACCEPTED', error: '没有可保存的偏好字段', accepted: v.accepted, rejected: v.rejected };
  }
  store.users[uid] = merged;
  save(store);
  return { ok: true, pref: merged, before, accepted: v.accepted, rejected: v.rejected };
}

function clear(userId) {
  const uid = String(userId || 'local');
  const store = load();
  const before = store.users[uid] || null;
  if (!before) return { ok: true, removed: false, before: null };
  delete store.users[uid];
  save(store);
  return { ok: true, removed: true, before };
}

function globalSettings() {
  const g = load().global;
  return {
    broadcastEnabled: g.broadcastEnabled !== false,
    throttleSec: Number.isFinite(Number(g.throttleSec)) ? Number(g.throttleSec) : DEFAULT_GLOBAL.throttleSec
  };
}

function setGlobal(patch, { actor } = {}) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const store = load();
  const before = globalSettings();
  const next = { ...store.global };
  const rejected = [];
  if (src.broadcastEnabled !== undefined) {
    if (typeof src.broadcastEnabled === 'boolean') next.broadcastEnabled = src.broadcastEnabled;
    else rejected.push({ key: 'broadcastEnabled', reason: '必须是布尔值' });
  }
  if (src.throttleSec !== undefined) {
    const n = Number(src.throttleSec);
    if (Number.isFinite(n) && n >= 0 && n <= 3600) next.throttleSec = Math.round(n);
    else rejected.push({ key: 'throttleSec', reason: '节流秒数必须是 0–3600' });
  }
  if (rejected.length) {
    return { ok: false, code: 'BROADCAST_BAD_SETTING', error: rejected.map((r) => r.reason).join('；'), rejected, before };
  }
  next.updatedAt = new Date().toISOString();
  store.global = next;
  save(store);
  const after = globalSettings();
  return { ok: true, before, after, actor: actor || null };
}

function describe(userId) {
  const p = get(userId);
  if (!p) return null;
  const model = p.model ? planCard.MODELS[p.model] : null;
  return {
    model: p.model || null,
    modelLabel: model ? model.label : null,
    resolution: p.resolution || null,
    clipDurationSec: p.clipDurationSec || null,
    bgmStyle: p.bgmStyle || null,
    updatedAt: p.updatedAt || null
  };
}

module.exports = {
  PREFS_VERSION,
  ALLOWED_RESOLUTIONS,
  DEFAULT_GLOBAL,
  file,
  get,
  set,
  clear,
  globalSettings,
  setGlobal,
  describe,
  validatePatch,
  _load: load,
  _save: save
};
