// ============================================================
// lut-loader.mjs —— 把剪映的 LUT 图片/纹理加载成采样函数
// 支持：直接 PNG，或 Laya .texture 容器（内嵌 PNG）
// 尺寸约定：宽 17×17=289，高 17（单向）或 34（正负两半）
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const N = 17;

function ffPath() {
  return process.env.FFMPEG_PATH
    || 'C:\\Users\\14872\\Desktop\\测试\\app\\tools\\ffmpeg\\bin\\ffmpeg.exe';
}

function extractPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).equals(SIG)) return buf;
  const s = buf.indexOf(SIG);
  const e = s >= 0 ? buf.indexOf(IEND, s) : -1;
  if (s < 0 || e < 0) throw new Error('找不到内嵌 PNG: ' + file);
  return buf.subarray(s, e + 8);
}

function decodeRgb(pngBuf, tmp) {
  const png = path.join(tmp, Math.random().toString(36).slice(2) + '.png');
  const raw = png + '.raw';
  fs.writeFileSync(png, pngBuf);
  const r = spawnSync(ffPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-i', png,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw], { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error('LUT 图片解码失败');
  const bytes = fs.readFileSync(raw);
  return { w: pngBuf.readUInt32BE(16), h: pngBuf.readUInt32BE(20), bytes };
}

/**
 * @param {string} file  PNG 或 .texture
 * @param {number} half  0=上半/单向；1=下半（正负两半时用）
 * @returns {([number,number,number]) => [number,number,number]}  0..1 → 0..1
 */
export function loadLut(file, half = 0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lutl-'));
  try {
    const img = decodeRgb(extractPng(file), tmp);
    const lut = new Float32Array(N * N * N * 3);
    for (let b = 0; b < N; b++) {
      for (let g = 0; g < N; g++) {
        for (let r = 0; r < N; r++) {
          const x = b * N + r;
          const y = g + (img.h >= N * 2 ? half * N : 0);
          const i = (y * img.w + x) * 3;
          const o = ((b * N + g) * N + r) * 3;
          lut[o] = img.bytes[i] / 255;
          lut[o + 1] = img.bytes[i + 1] / 255;
          lut[o + 2] = img.bytes[i + 2] / 255;
        }
      }
    }
    return (rgb) => {
      const fr = rgb[0] * (N - 1), fg = rgb[1] * (N - 1), fb = rgb[2] * (N - 1);
      const r0 = Math.min(N - 1, Math.floor(fr)), g0 = Math.min(N - 1, Math.floor(fg)), b0 = Math.min(N - 1, Math.floor(fb));
      const r1 = Math.min(N - 1, r0 + 1), g1 = Math.min(N - 1, g0 + 1), b1 = Math.min(N - 1, b0 + 1);
      const dr = fr - r0, dg = fg - g0, db = fb - b0;
      const at = (ri, gi, bi, c) => lut[((bi * N + gi) * N + ri) * 3 + c];
      const out = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
        const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
        const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
        const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
        out[c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
      }
      return out;
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// 剪映资源路径（可被环境变量覆盖）
export const RES = process.env.JY_ADJUST_DIR
  || 'C:\\Users\\14872\\AppData\\Local\\JianyingPro\\User Data\\Resources\\DefaultAdjustBundle';

export const LUT_FILES = {
  lightMax: path.join(RES, 'contrast_v3', 'AmazingFeature', 'image', 'lightSensation_max.png'),
  lightMin: path.join(RES, 'contrast_v3', 'AmazingFeature', 'image', 'lightSensation_min.png'),
  fade: path.join(RES, 'contrast_v3', 'AmazingFeature', 'image', 'fade_max.texture')
};
