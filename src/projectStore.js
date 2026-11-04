// ============================================================
// 剪辑台工程（草稿）存储
// ------------------------------------------------------------
// 与任务存储分开：任务是一次渲染作业，工程是编辑态（时间线 / 每段参数 / 音频计划）。
// 文件：<PROJECTS_DIR>/<id>.json；写入走 tmp + rename，避免半截文件。
// 并发：revision 乐观锁——update 必须带 expectedRevision，不匹配返回 409。
//
// 2026-11-04 落地（F01）。schema 见 FEATURES.md D 节。
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DIR = config.STORAGE.projectsDir;
const TRASH_DIR = path.join(path.dirname(DIR), 'trash', 'projects');
const SCHEMA_VERSION = 1;
const MAX_NAME = 120;
const MAX_SEGMENTS = 500;
const MAX_AUDIO_SEGMENTS = 200;
const ID_RE = /^proj_[a-z0-9]+$/i;

const ALLOWED_TRANSITIONS = new Set([
  'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright',
  'circleopen', 'pixelize', 'fadeblack', 'fadewhite'
]);

class ProjectError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function newId() {
  return 'proj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fileOf(id) {
  return path.join(DIR, id + '.json');
}

function assertId(id) {
  if (!ID_RE.test(String(id || ''))) {
    throw new ProjectError('NOT_FOUND', '工程不存在');
  }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function normName(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return (s || '未命名工程').slice(0, MAX_NAME);
}

function normSegment(seg, i) {
  if (!seg || typeof seg !== 'object') {
    throw new ProjectError('BAD_SEGMENT', `第 ${i + 1} 段格式非法`);
  }
  const assetId = String(seg.assetId || '').trim();
  if (!assetId) {
    throw new ProjectError('BAD_SEGMENT', `第 ${i + 1} 段缺少 assetId`);
  }
  const inSec = Math.max(0, num(seg.inSec, 0));
  const outSecRaw = seg.outSec === undefined || seg.outSec === null ? null : num(seg.outSec, null);
  const outSec = outSecRaw === null ? null : Math.max(0, outSecRaw);
  if (outSec !== null && outSec <= inSec) {
    throw new ProjectError('BAD_SEGMENT', `第 ${i + 1} 段 outSec 必须大于 inSec`);
  }
  const adjust = seg.adjust && typeof seg.adjust === 'object' && !Array.isArray(seg.adjust)
    ? { ...seg.adjust }
    : {};
  return {
    id: String(seg.id || `s${i + 1}`).slice(0, 64),
    assetId: assetId.slice(0, 200),
    inSec: Math.round(inSec * 1000) / 1000,
    outSec: outSec === null ? null : Math.round(outSec * 1000) / 1000,
    adjust
  };
}

function normSegments(list) {
  if (!Array.isArray(list)) {
    throw new ProjectError('BAD_INPUT', 'segments 必须是数组');
  }
  if (list.length > MAX_SEGMENTS) {
    throw new ProjectError('LIMIT', `工程最多 ${MAX_SEGMENTS} 段`);
  }
  return list.map(normSegment);
}

function normAudio(audio) {
  const a = audio && typeof audio === 'object' ? audio : {};
  const take = (list) => (Array.isArray(list) ? list.slice(0, MAX_AUDIO_SEGMENTS).map((s) => ({ ...s })) : []);
  return {
    music: take(a.music),
    ambient: take(a.ambient),
    opts: a.opts && typeof a.opts === 'object' ? { ...a.opts } : {}
  };
}

function normTransition(t) {
  const src = t && typeof t === 'object' ? t : {};
  const type = ALLOWED_TRANSITIONS.has(String(src.type || '')) ? String(src.type) : 'fade';
  return {
    enabled: src.enabled === undefined ? true : !!src.enabled,
    duration: Math.round(clamp(num(src.duration, 0.4), 0.1, 5) * 1000) / 1000,
    type
  };
}

function normalizeProject(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id || newId(),
    name: normName(src.name),
    revision: opts.revision || 1,
    segments: normSegments(src.segments === undefined ? [] : src.segments),
    audio: normAudio(src.audio),
    transition: normTransition(src.transition),
    exports: Array.isArray(src.exports) ? src.exports.slice(0, 100) : [],
    createdAt: opts.createdAt || now,
    updatedAt: now
  };
}

function writeProject(project, opts = {}) {
  ensureDir();
  const file = fileOf(project.id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf8');
  if (opts.noReplace && fs.existsSync(file)) {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    throw new ProjectError('NOT_FOUND', '工程已存在');
  }
  fs.renameSync(tmp, file);
  return project;
}

function readProject(id) {
  assertId(id);
  const file = fileOf(id);
  if (!fs.existsSync(file)) throw new ProjectError('NOT_FOUND', '工程不存在');
  let project;
  try {
    project = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ProjectError('BAD_DATA', '工程文件损坏: ' + e.message);
  }
  if (!project || typeof project !== 'object' || project.id !== id) {
    throw new ProjectError('BAD_DATA', '工程文件内容非法');
  }
  return project;
}

function summary(p) {
  return {
    id: p.id,
    name: p.name,
    revision: p.revision,
    segmentCount: Array.isArray(p.segments) ? p.segments.length : 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  };
}

function list() {
  ensureDir();
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const f of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (p && p.id) out.push(summary(p));
    } catch (e) {
      console.warn('[projects] 跳过损坏工程文件 ' + f + ': ' + e.message);
    }
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function get(id) {
  return readProject(id);
}

function create(input) {
  const project = normalizeProject(input);
  return writeProject(project);
}

function update(id, patch, expectedRevision) {
  const current = readProject(id);
  if (expectedRevision === undefined || expectedRevision === null || !Number.isFinite(Number(expectedRevision))) {
    throw new ProjectError('REVISION_REQUIRED', '更新工程必须带 revision');
  }
  if (Number(expectedRevision) !== Number(current.revision)) {
    throw new ProjectError('REVISION_CONFLICT', '工程已被其他人修改，请刷新后重试', {
      currentRevision: current.revision
    });
  }
  const src = patch && typeof patch === 'object' ? patch : {};
  const next = {
    ...current,
    name: src.name !== undefined ? normName(src.name) : current.name,
    segments: src.segments !== undefined ? normSegments(src.segments) : current.segments,
    audio: src.audio !== undefined ? normAudio(src.audio) : current.audio,
    transition: src.transition !== undefined ? normTransition(src.transition) : current.transition,
    revision: Number(current.revision) + 1,
    updatedAt: new Date().toISOString()
  };
  return writeProject(next);
}

function remove(id) {
  const current = readProject(id);
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, `${current.id}.${Date.now()}.json`);
    fs.renameSync(fileOf(id), dest);
    return { id, trashed: dest };
  } catch (e) {
    try { fs.unlinkSync(fileOf(id)); } catch (e2) { /* ignore */ }
    return { id, trashed: null };
  }
}

// 追加导出记录：只改 exports，不动 revision（避免正在编辑的窗口被 409）
function appendExport(id, record) {
  const current = readProject(id);
  const list = Array.isArray(current.exports) ? current.exports.slice(-49) : [];
  list.push(record);
  const next = { ...current, exports: list };
  const file = fileOf(current.id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

module.exports = {
  ProjectError,
  list,
  get,
  create,
  update,
  remove,
  appendExport,
  // 测试用
  _DIR: DIR,
  _normalizeProject: normalizeProject,
  _normSegments: normSegments,
  _normTransition: normTransition
};
