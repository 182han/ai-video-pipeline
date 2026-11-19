// ============================================================
// 图生视频首帧压缩（2026-11-19）
// ------------------------------------------------------------
// 背景：task_mwnosz8o_uyl4 的 3 段 i2v 全部在 ~64s 后收到中转 504，首帧是
// 1696×960 PNG（3.2MB），dataUrl 后约 4.3MB；3 段并发提交。
// 做法：超过阈值的首帧用 ffmpeg 压成 JPEG（默认最长边 1280、质量 q3），
// 把 dataUrl 从 MB 级降到百 KB 级；失败时**回退原图**（不阻塞，也不静默伪造成功）。
// 只处理本地上传/生成的首帧，不改变 URL 形态。
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../../config');

const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_MAX_WIDTH = 1280;

function maxBytes() {
  const n = Number(process.env.I2V_MAX_IMAGE_BYTES);
  return Number.isFinite(n) && n > 200 * 1024 ? n : DEFAULT_MAX_BYTES;
}
function maxWidth() {
  const n = Number(process.env.I2V_IMAGE_MAX_WIDTH);
  return Number.isFinite(n) && n >= 640 ? Math.round(n) : DEFAULT_MAX_WIDTH;
}

/**
 * 超过阈值的首帧压成 JPEG；否则原样返回。
 * @param {Buffer} buf
 * @param {string} mime
 * @returns {{buf:Buffer, mime:string, shrunk:boolean, note:string|null}}
 */
function shrinkForI2v(buf, mime) {
  const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!input.length) return { buf: input, mime: mime || 'image/png', shrunk: false, note: '空图' };
  if (input.length <= maxBytes()) return { buf: input, mime: mime || 'image/png', shrunk: false, note: null };

  const tmpIn = path.join(os.tmpdir(), `i2v-in-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const tmpOut = tmpIn.replace(/\.png$/, '.jpg');
  try {
    fs.writeFileSync(tmpIn, input);
    const w = maxWidth();
    execFileSync(config.FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', tmpIn,
      '-vf', `scale=${w}:-2:force_original_aspect_ratio=decrease`,
      '-q:v', '3',
      tmpOut
    ], { stdio: 'ignore', timeout: 30000 });
    const out = fs.readFileSync(tmpOut);
    if (out.length > 0 && out.length < input.length) {
      return {
        buf: out,
        mime: 'image/jpeg',
        shrunk: true,
        note: `${(input.length / 1048576).toFixed(2)}MB → ${(out.length / 1024).toFixed(0)}KB (${w}w JPEG)`
      };
    }
    return { buf: input, mime: mime || 'image/png', shrunk: false, note: '压缩后未变小，回退原图' };
  } catch (e) {
    return { buf: input, mime: mime || 'image/png', shrunk: false, note: '压缩失败回退原图: ' + (e && e.message ? e.message : e) };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(tmpOut); } catch (e) { /* 忽略 */ }
  }
}

module.exports = { shrinkForI2v, maxBytes, maxWidth, DEFAULT_MAX_BYTES, DEFAULT_MAX_WIDTH };
