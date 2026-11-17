// ==========================================
// 小智 V2 · 只读环境上下文（设计文档 §2 V2「/api/assistant/context」）
// ------------------------------------------------------------
// 覆盖 A–E（Q12=A+B+C+D+E，全只读）：
//   A 任务：总数 / 在跑 / 最近 / 最近失败原因（B1、B2、B3 的数据源）
//   B 预算：与 /api/budget 同口径（同一 budget.status()，B4）
//   C 素材：图片库（与 /api/photos 同口径：文件缺失不计入）、成片/片段库、场景卡、BGM
//   D 设置：Key **只报有/无** + 模型/图生视频能力表 + 服务版本
//   E 最近错误摘要：读本机日志尾部，**经 redact 脱敏**，不含路径清单
//
// 三条硬约束（写死，verify-assistant 逐条断言）：
//   · 纯只读：不建任务、不写文件、不调模型、不产生费用；
//   · Key 只输出 {label, present}，任何调用方都拿不到 Key 值；
//   · 不输出绝对路径 / 环境变量原值（避免把 .env 内容带进对话或前端）。
// ==========================================

'use strict';

const fs = require('fs');
const path = require('path');

const taskManager = require('../taskManager');
const budget = require('../budget');
const photoLibrary = require('../photoLibrary');
const library = require('../library');
const sceneCardLibrary = require('../sceneCards');
const audioMixer = require('../processors/audioMixer');
const config = require('../../config');
const planCard = require('./planCard');
const { listI2VModels } = require('../generators/i2vSupport');
const preferences = require('./preferences');
const { redactText } = require('./redact');

const CONTEXT_VERSION = 'assistant-context.v2';
const MAX_RECENT = 5;
const MAX_ERROR_TEXT = 400;
const LOG_TAIL_BYTES = 128 * 1024;

const ACTIVE_STATUS = new Set([
  'pending', 'generating', 'concatenating', 'looping', 'transcoding',
  'mixing', 'processing', 'regenerating', 'paused'
]);

// 与 supervisor 的 CONTEXT_KEYS 保持同一份（Key 只报有/无）。
const CONTEXT_KEYS = [
  { label: '视频生成·WhaleTV 中转', names: ['OPENAI_VIDEO_API_KEY', 'WHALETV_API_KEY'] },
  { label: '视频生成·百炼万相', names: ['DASHSCOPE_API_KEY'] },
  { label: '视频生成·可灵', names: ['KLING_API_KEY', 'KLING_ACCESS_KEY'] },
  { label: '图片生成', names: ['IMAGE_GEN_API_KEY', 'DASHSCOPE_API_KEY'] },
  { label: '多模态质检', names: ['MULTIMODAL_API_KEY'] },
  { label: '文案 LLM', names: ['OPENAI_API_KEY'] }
];

// 只返回「有/无」。刻意不返回长度、前缀、后缀 —— 任何形式的部分回显都算泄露。
function keyPresence() {
  return CONTEXT_KEYS.map((k) => ({
    label: k.label,
    present: k.names.some((n) => String(process.env[n] || '').trim() !== '')
  }));
}

function safeTasks() {
  try { return taskManager.getAllTasks() || []; } catch (e) { return []; }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function taskBrief(task) {
  const clips = Array.isArray(task.clips) ? task.clips : [];
  const total = num(task.totalClips) || clips.length;
  const success = clips.filter((c) => c && c.status === 'success').length;
  const failed = clips.filter((c) => c && c.status !== 'success').length;
  return {
    taskId: task.taskId,
    status: task.status || null,
    currentStep: task.currentStep || null,
    model: task.model || null,
    totalClips: total,
    successClips: success,
    failedClips: failed,
    percent: total > 0 ? Math.round((success / total) * 100) : 0,
    error: task.error ? redactText(String(task.error)).slice(0, MAX_ERROR_TEXT) : null,
    createdAt: task.createdAt || null,
    completedAt: task.completedAt || null
  };
}

function activeTasks(tasks) {
  return tasks
    .filter((t) => t && ACTIVE_STATUS.has(String(t.status || '')))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, MAX_RECENT)
    .map(taskBrief);
}

function recentTasks(tasks) {
  return tasks
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, MAX_RECENT)
    .map(taskBrief);
}

function failedRecent(tasks) {
  return tasks
    .filter((t) => t && (['failed', 'partial'].includes(t.status)
      || (Array.isArray(t.clips) && t.clips.some((c) => c && c.status !== 'success' && c.status !== 'pending'))))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, MAX_RECENT)
    .map((t) => {
      const b = taskBrief(t);
      const firstBad = (Array.isArray(t.clips) ? t.clips : []).find((c) => c && c.status !== 'success' && c.status !== 'pending');
      b.reason = b.error
        || (firstBad && firstBad.qcResult && (firstBad.qcResult.reason || firstBad.qcResult.error))
        || (firstBad && firstBad.error)
        || `状态 ${t.status}`;
      b.reason = redactText(String(b.reason)).slice(0, MAX_ERROR_TEXT);
      return b;
    });
}

function budgetView() {
  try {
    const s = budget.status();
    return {
      currency: s.currency || 'USD',
      initialUsd: num(s.initialUsd),
      spentUsd: num(s.spentUsd),
      balanceUsd: num(s.balanceUsd)
    };
  } catch (e) {
    return null;
  }
}

// 与 GET /api/photos 的默认口径一致：fileMissing 的条目不显示，但数据不删。
function photoView() {
  try {
    const all = photoLibrary.listAll();
    const visible = all.filter((p) => p && p.filePath && fs.existsSync(p.filePath));
    const totals = photoLibrary.totals(visible);
    return {
      all: totals.all,
      pending: totals.pending,
      approved: totals.approved,
      rejected: totals.rejected,
      // 「能用的」= 已通过审核且文件在（B5 的口径）
      usable: totals.approved
    };
  } catch (e) {
    return { all: 0, pending: 0, approved: 0, rejected: 0, usable: 0, error: '图片库不可读' };
  }
}

function libraryView() {
  try {
    const items = library.listAll();
    return {
      finals: items.filter((p) => p && p.kind === 'final').length,
      clips: items.filter((p) => p && p.kind === 'clip').length
    };
  } catch (e) {
    return { finals: 0, clips: 0, error: '片段库不可读' };
  }
}

function sceneCardsView() {
  try {
    const lib = sceneCardLibrary.loadLibrary();
    return { features: (lib.features || []).length, buffers: (lib.buffers || []).length };
  } catch (e) {
    return { features: 0, buffers: 0, error: '场景卡库不可读' };
  }
}

function bgmView() {
  try {
    const tracks = audioMixer.toPublicTracks();
    return { tracks: Array.isArray(tracks) ? tracks.length : 0 };
  } catch (e) {
    return { tracks: 0, error: '配乐库不可读' };
  }
}

function logDir() {
  // 与 server.js 的 LOG_DIR 解析同源：不读 server.js（避免依赖入口文件）。
  return process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.join(__dirname, '..', '..', 'data', 'logs');
}

// 最近错误摘要（只读日志尾部；返回文本经脱敏，不返回路径）。
function recentErrors(limit = MAX_RECENT) {
  const dir = logDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^server-.*\.log$/.test(n)).sort();
  } catch (e) {
    return [];
  }
  if (!names.length) return [];
  const newest = names[names.length - 1];
  let text = '';
  try {
    const full = path.join(dir, newest);
    const fd = fs.openSync(full, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => /\[ERROR\]/.test(l));
  return lines.slice(-Math.max(1, Math.min(20, Number(limit) || MAX_RECENT))).map((l) => ({
    text: redactText(l.trim()).slice(0, MAX_ERROR_TEXT)
  }));
}

function modelView() {
  const models = Object.keys(planCard.MODELS).map((id) => ({ id, label: planCard.MODELS[id].label }));
  return {
    models,
    i2v: { supported: listI2VModels() },
    defaults: { model: 'openai-video', resolution: '720p', clipDurationSec: 10, sceneCards: true }
  };
}

/**
 * 只读环境上下文。
 * @param {string|null} sessionId 仅用于回填 sessionId 字段（计划由 supervisor 层补充）
 * @param {object} [opts] { page, userId, server }
 */
function contextOf(sessionId, opts = {}) {
  const tasks = safeTasks();
  const userId = String(opts.userId || 'local');
  let prefs = null;
  try { prefs = preferences.describe(userId); } catch (e) { prefs = null; }
  let global = { broadcastEnabled: true, throttleSec: 30 };
  try { global = preferences.globalSettings(); } catch (e) { /* ignore */ }

  return {
    version: CONTEXT_VERSION,
    at: new Date().toISOString(),
    sessionId: sessionId ? String(sessionId) : null,
    userId,
    ui: {
      // 当前页面由前端上报（?page=）；V2 前端未集成时是 null，不能假装知道。
      page: opts.page ? String(opts.page).slice(0, 60) : null,
      draft: null // supervisor 层用会话里的最后一条计划回填
    },
    tasks: {
      total: tasks.length,
      active: activeTasks(tasks),
      recent: recentTasks(tasks),
      failedRecent: failedRecent(tasks)
    },
    budget: budgetView(),
    assets: {
      photos: photoView(),
      library: libraryView(),
      sceneCards: sceneCardsView(),
      bgm: bgmView()
    },
    settings: {
      keys: keyPresence(),
      preferences: prefs,
      models: modelView(),
      broadcast: global
    },
    server: {
      pid: process.pid,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      ffmpegAvailable: (() => {
        try { return !!config.FFMPEG_PATH && fs.existsSync(config.FFMPEG_PATH); } catch (e) { return false; }
      })(),
      ...(opts.server && typeof opts.server === 'object' ? opts.server : {})
    },
    recentErrors: recentErrors()
  };
}

module.exports = {
  CONTEXT_VERSION,
  CONTEXT_KEYS,
  ACTIVE_STATUS,
  keyPresence,
  contextOf,
  recentErrors,
  taskBrief,
  _logDir: logDir
};
