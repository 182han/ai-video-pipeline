// ============================================================
// 素材缩略图（剪辑台素材栏 / 时间线）
// ------------------------------------------------------------
// 2026-11-04：用户反馈「素材栏和轨道看不到画面」。
// 从片段库条目抽第 0.1s 一帧，落 data/thumbnails/<id>.jpg，按源文件 mtime 失效。
// 用 videoProcessor.extractFrame（已封装 ffmpeg 路径与错误处理），不裸 execSync。
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('../config');
const videoProcessor = require('./videoProcessor');

const DIR = config.STORAGE.thumbsDir;
const inflight = new Map();

function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

function fresh(file, source) {
  try {
    const a = fs.statSync(file);
    const b = fs.statSync(source);
    return a.size > 0 && a.mtimeMs >= b.mtimeMs;
  } catch (e) {
    return false;
  }
}

async function ensure(entry) {
  if (!entry || !entry.id || !entry.filePath) return null;
  const id = safeId(entry.id);
  const out = path.join(DIR, id + '.jpg');
  if (fresh(out, entry.filePath)) return out;
  if (inflight.has(id)) return inflight.get(id);

  const task = (async () => {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = out + '.tmp.jpg';
    const r = videoProcessor.extractFrame(entry.filePath, 0.1, tmp);
    if (!r || !r.success) throw new Error((r && r.error) || '抽帧失败');
    const size = fs.statSync(tmp).size;
    if (!size) throw new Error('抽帧为空');
    fs.renameSync(tmp, out);
    return out;
  })().finally(() => inflight.delete(id));

  inflight.set(id, task);
  return task;
}

module.exports = { ensure, _DIR: DIR };
