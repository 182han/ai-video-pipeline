// ============================================================
// temperature-tone.mjs —— 剪映「色温/色调」CIE 适配链移植
// 来源：temperature_tone_v3/AmazingFeature/lua/Lscript.lua
// 逻辑：intensity → 色温 Kelvin / 色调 100x → Planckian 色度 → Bradford 矩阵
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FF = process.env.FFMPEG_PATH || 'C:\\Users\\14872\\Desktop\\测试\\app\\tools\\ffmpeg\\bin\\ffmpeg.exe';

// 表：每行 [T, x, y, m]（m 是等温线斜率）
const TABLE = [
  0, 0.18006, 0.26352, -0.24341,
  10, 0.18066, 0.26589, -0.25479,
  20, 0.18133, 0.26846, -0.26876,
  30, 0.18208, 0.27119, -0.28539,
  40, 0.18293, 0.27407, -0.30470,
  50, 0.18388, 0.27709, -0.32675,
  60, 0.18494, 0.28021, -0.35156,
  70, 0.18611, 0.28342, -0.37915,
  80, 0.18740, 0.28668, -0.40955,
  90, 0.18880, 0.28997, -0.44278,
  100, 0.19032, 0.29326, -0.47888,
  125, 0.19462, 0.30141, -0.58204,
  150, 0.19962, 0.30921, -0.70471,
  175, 0.20525, 0.31647, -0.84901,
  200, 0.21142, 0.32312, -1.0182,
  225, 0.21807, 0.32909, -1.2168,
  250, 0.22511, 0.33439, -1.4512,
  275, 0.23247, 0.33904, -1.7298,
  300, 0.24010, 0.34308, -2.0637,
  325, 0.24792, 0.34655, -2.4681,
  350, 0.25591, 0.34951, -2.9641,
  375, 0.26400, 0.35200, -3.5814,
  400, 0.27218, 0.35407, -4.3633,
  425, 0.28039, 0.35577, -5.3762,
  450, 0.28863, 0.35714, -6.7262,
  475, 0.29685, 0.35823, -8.5955,
  500, 0.30505, 0.35907, -11.324,
  525, 0.31320, 0.35968, -15.628,
  550, 0.32129, 0.36011, -23.325,
  575, 0.32931, 0.36038, -40.770,
  600, 0.33724, 0.36051, -116.45
];

const A = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const B = [[0.987, -0.1471, 0.16], [0.4323, 0.5184, 0.0493], [-0.0085, 0.04, 0.9685]];
const P = [[0.4123907992659595, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151036, 0.715168678767756, 0.07219231536073371],
  [0.019330818715591832, 0.11919477979462598, 0.9505321522496607]];
const Q = [[3.2409699419045213, -1.5373831775700935, -0.4986107602930033],
  [-0.9692436362808796, 1.8759675015077208, 0.04155505740717562],
  [0.05563007969699364, -0.20397695888897655, 1.0569715142428784]];

const mix = (a, b, x) => a * (1 - x) + b * x;
const clamp = (a, b, x) => Math.min(Math.max(x, a), b);
const matVec = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const matMat = (m1, m2) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => m1[i][0] * m2[0][j] + m1[i][1] * m2[1][j] + m1[i][2] * m2[2][j]));
const diag = (v) => [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]];

// 1-based 访问，模拟 Lua 的 extraData
const E = (i) => TABLE[i - 1];

export function vec3Compute(tempK, tones) {
  const x = 1000000.0 / tempK;
  const y = tones * 0.0001;
  let index = 5;
  let data = E(index);
  index += 4;
  while (data <= x && index < TABLE.length + 1) {
    data = E(index);
    index += 4;
  }
  let factor = (data - x) / (data - E(index - 8));
  let t1 = [
    mix(E(index - 3), E(index - 7), factor),
    mix(E(index - 2), E(index - 6), factor)
  ];
  const a = E(index - 5);
  const b = E(index - 1);
  const sqA = Math.sqrt(a * a + 1);
  const sqB = Math.sqrt(b * b + 1);
  let t2 = [mix(1 / sqB, 1 / sqA, factor), mix(b / sqB, a / sqA, factor)];
  factor = Math.sqrt(t2[0] * t2[0] + t2[1] * t2[1]);
  t1 = [y * t2[0] / factor + t1[0], y * t2[1] / factor + t1[1]];
  const den = -4.0 * t1[1] + t1[0] + 2.0;
  let aa = clamp(0.000001, 0.999999, t1[0] * 1.5 / den);
  let bb = clamp(0.000001, 0.999999, t1[1] / den);
  if (aa + bb > 0.999999) {
    const t = 0.999999 / (aa + bb);
    aa = aa / t;
    bb = bb / t;
  }
  return [aa / bb, 1.0, (1.0 - aa - bb) / bb];
}

// 滑块值 → intensity → 色温/色调
export const tempFromSlider = (v) => {
  const x = v / 50;
  return 6500 - 1970 * x + 876 * x * x - 2630 * x * x * x;
};

export function matrixFor(tempK, tones) {
  if (tempK === 6500 && tones === 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const v1 = vec3Compute(tempK, tones);
  const v0 = vec3Compute(6500, 0);
  const x1 = matVec(A, v1);
  const x0 = matVec(A, v0);
  const d = diag([x1[0] / x0[0], x1[1] / x0[1], x1[2] / x0[2]]);
  let m = matMat(d, A);
  m = matMat(B, m);
  m = matMat(m, P);
  m = matMat(Q, m);
  return m;
}

export function applyMatrix(rgb, m) {
  return [0, 1, 2].map((i) => m[i][0] * rgb[0] + m[i][1] * rgb[1] + m[i][2] * rgb[2]);
}

// ---------------- 自测 / 对照验证 ----------------
if (process.argv[1] && process.argv[1].endsWith('temperature-tone.mjs')) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  const R = 'C:\\Users\\14872\\Desktop\\风景照片\\对照';
  const W = 480, H = 270;
  const ff = (a) => { const r = spawnSync(FF, a, { stdio: 'ignore', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg fail'); };
  const frameAt = (src, t) => {
    const out = path.join(T, 'f' + Math.random().toString(36).slice(2) + '.raw');
    ff(['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(4), '-i', src, '-frames:v', '1',
      '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
    const b = fs.readFileSync(out); fs.unlinkSync(out); return b;
  };
  const psnr = (a, b) => { let se = 0; for (let i = 0; i < b.length; i++) { const d = a[i] - b[i]; se += d * d; } return 10 * Math.log10(255 * 255 / (se / b.length)); };
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));

  const base = frameAt(path.join(R, 'base.mp4', 'base.mp4.mp4'), 2.5);
  for (const [name, kind] of [['temp50', 'temp'], ['tone50', 'tone']]) {
    const tgt = frameAt(path.join(R, `${name}.mp4`, `${name}.mp4.mp4`), 2.5 - 1 / 30);
    let best = { v: 0, ps: -1 };
    for (let v = -50; v <= 50; v += 1) {
      const m = kind === 'temp' ? matrixFor(tempFromSlider(v), 0) : matrixFor(6500, v * 2);
      const pred = new Uint8Array(base.length);
      for (let i = 0; i < base.length; i += 3) {
        const o = applyMatrix([base[i] / 255, base[i + 1] / 255, base[i + 2] / 255], m);
        pred[i] = cl(o[0] * 255); pred[i + 1] = cl(o[1] * 255); pred[i + 2] = cl(o[2] * 255);
      }
      const ps = psnr(pred, tgt);
      if (ps > best.ps) best = { v, ps };
    }
    console.log(`${name}: 最佳滑块值 ${best.v}  PSNR=${best.ps.toFixed(2)}   （期望 50）`);
  }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
}
