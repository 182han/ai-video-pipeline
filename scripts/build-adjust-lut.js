// ============================================================
// build-adjust-lut.js —— 用「素材对」自建调节 LUT（不依赖剪映资源）
// ------------------------------------------------------------
// 原理：
//   1) 输入视频 = 未调节，目标视频 = 剪映某滑杆 +50 的成片
//   2) 抽多帧，逐像素收集 (输入 RGB → 输出 RGB) 样本
//   3) 以 17³ 网格为未知量：先按逐通道 1D 曲线初始化，再把样本残差
//      按三线性权重「分摊」到 8 个邻近格点（两轮迭代）
//   4) 输出标准 .cube（ffmpeg lut3d 可直接用）
//
// 用法：
//   node scripts/build-adjust-lut.js --base base.mp4 --target light50.mp4 \
//        --out assets/adjust/lightSensation_max.cube
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('--base');
const TARGET = arg('--target');
const OUT = arg('--out');
const N = Number(arg('--size', '17'));
const W = arg('--width', '960');
const H = arg('--height', '540');
const TIMES = (arg('--times', '1,2,2.5,3,4')).split(',').map(Number);

const MIRROR = arg('--mirror-from');
if (MIRROR) {
  const txt = fs.readFileSync(MIRROR, 'utf8').split(/\r?\n/);
  const sizeLine = txt.find((l) => l.startsWith('LUT_3D_SIZE'));
  const n = Number(sizeLine.split(/\s+/)[1]);
  const data = txt.filter((l) => /^\d/.test(l)).map((l) => l.trim().split(/\s+/).map(Number));
  const at = (r, g, b) => data[((b * n + g) * n + r)];
  const out = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const v = at(n - 1 - r, n - 1 - g, n - 1 - b);
    out.push([1 - v[0], 1 - v[1], 1 - v[2]].map((x) => Math.max(0, Math.min(1, x)).toFixed(6)).join(' '));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, ['TITLE "self-made light min (mirror approximation)"', `LUT_3D_SIZE ${n}`,
    'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''].concat(out).join('\n') + '\n');
  console.log('镜像生成完成:', OUT, `(${n}³)`);
  process.exit(0);
}
if (!BASE || !TARGET || !OUT) {
  console.error('用法: node scripts/build-adjust-lut.js --base a.mp4 --target b.mp4 --out out.cube');
  process.exit(2);
}

// 镜像模式：node scripts/build-adjust-lut.js --mirror-from max.cube --out min.cube
// 用途：光感的负向没有对照素材，用「对称近似」生成 min(x) = 1 - max(1-x)。
// 这是**近似**，不是剪映真实负向曲线；代码注释与文档都要标明。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buildlut-'));
const ff = (args) => {
  const r = spawnSync(config.FFMPEG_PATH, args, { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg 失败');
};
function frame(src, t) {
  const o = path.join(tmp, 'f' + Math.random().toString(36).slice(2) + '.raw');
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(4), '-i', src,
    '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', o]);
  const b = fs.readFileSync(o); fs.unlinkSync(o); return b;
}

// ---------- 1) 收集样本（目标晚 1 帧，与实测对齐一致）----------
const samples = [];
for (const t of TIMES) {
  const a = frame(BASE, t);
  const b = frame(TARGET, t - 1 / 30);
  if (a.length !== b.length) continue;
  for (let i = 0; i < a.length; i += 3 * 5) {
    samples.push([a[i] / 255, a[i + 1] / 255, a[i + 2] / 255, b[i] / 255, b[i + 1] / 255, b[i + 2] / 255]);
  }
}
if (!samples.length) throw new Error('没有采到样本');
console.log(`样本数: ${samples.length}（${TIMES.length} 帧）`);

// ---------- 2) 1D 曲线初始化 ----------
const sum = [0, 1, 2].map(() => new Float64Array(256));
const cnt = [0, 1, 2].map(() => new Float64Array(256));
for (const s of samples) {
  for (let c = 0; c < 3; c++) {
    const v = Math.round(s[c] * 255);
    sum[c][v] += s[3 + c]; cnt[c][v]++;
  }
}
const curve = [0, 1, 2].map((c) => {
  const cv = new Float64Array(256);
  let prev = -1;
  for (let v = 0; v < 256; v++) cv[v] = cnt[c][v] ? sum[c][v] / cnt[c][v] : NaN;
  for (let v = 0; v < 256; v++) {
    if (!Number.isNaN(cv[v])) { prev = v; continue; }
    let next = v + 1;
    while (next < 256 && Number.isNaN(cv[next])) next++;
    if (prev < 0) cv[v] = next < 256 ? cv[next] : v / 255;
    else if (next >= 256) cv[v] = cv[prev];
    else cv[v] = cv[prev] + (cv[next] - cv[prev]) * (v - prev) / (next - prev);
  }
  for (let v = 1; v < 256; v++) if (cv[v] < cv[v - 1]) cv[v] = cv[v - 1];
  return cv;
});

// 三线性权重（返回 8 个索引 + 权重）
function tri(r, g, b) {
  const fr = r * (N - 1), fg = g * (N - 1), fb = b * (N - 1);
  const r0 = Math.min(N - 1, Math.floor(fr)), g0 = Math.min(N - 1, Math.floor(fg)), b0 = Math.min(N - 1, Math.floor(fb));
  const r1 = Math.min(N - 1, r0 + 1), g1 = Math.min(N - 1, g0 + 1), b1 = Math.min(N - 1, b0 + 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const idx = [];
  const wts = [];
  for (const [ri, wi] of [[r0, 1 - dr], [r1, dr]]) {
    for (const [gi, wj] of [[g0, 1 - dg], [g1, dg]]) {
      for (const [bi, wk] of [[b0, 1 - db], [b1, db]]) {
        idx.push(((bi * N + gi) * N + ri) * 3);
        wts.push(wi * wj * wk);
      }
    }
  }
  return { idx, wts };
}

// ---------- 3) 网格：1D 初始化 + 残差分摊 ----------
const lut = new Float32Array(N * N * N * 3);
for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
  const o = ((b * N + g) * N + r) * 3;
  lut[o] = curve[0][Math.round(r / (N - 1) * 255)] / 255;
  lut[o + 1] = curve[1][Math.round(g / (N - 1) * 255)] / 255;
  lut[o + 2] = curve[2][Math.round(b / (N - 1) * 255)] / 255;
}

// 备份 1D 初始化，用于残差场插值
const init = lut.slice();

// 一次性加权平均：每个格点取其邻域样本的加权均值（比迭代更稳）
const acc = new Float32Array(N * N * N * 3);
const wsum = new Float32Array(N * N * N);
for (const s of samples) {
  const { idx, wts } = tri(s[0], s[1], s[2]);
  for (let k = 0; k < 8; k++) {
    if (wts[k] < 0.02) continue;
    const o = idx[k], w = wts[k];
    acc[o] += w * s[3]; acc[o + 1] += w * s[4]; acc[o + 2] += w * s[5];
    wsum[o / 3] += w;
  }
}
let filled = 0;
for (let n = 0; n < N * N * N; n++) {
  if (wsum[n] > 0.5) {
    const o = n * 3;
    lut[o] = acc[o] / wsum[n];
    lut[o + 1] = acc[o + 1] / wsum[n];
    lut[o + 2] = acc[o + 2] / wsum[n];
    filled++;
  }
}
console.log(`有样本覆盖的格点: ${filled} / ${N * N * N}`);

// 训练集误差
let se = 0, k2 = 0;
for (const s of samples) {
  const { idx, wts } = tri(s[0], s[1], s[2]);
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v += wts[k] * lut[idx[k] + c];
    const d = v * 255 - s[3 + c] * 255;
    se += d * d; k2++;
  }
}
console.log(`训练集 PSNR ≈ ${(10 * Math.log10(255 * 255 / (se / k2))).toFixed(2)} dB`);
// 未覆盖格点：用「残差场」插值补全
// 思路：LUT = 1D 初始化 + 残差；残差在颜色空间里是平滑的，用邻域加权插值比直接外推可靠
const covered = new Uint8Array(N * N * N);
for (let n = 0; n < N * N * N; n++) covered[n] = wsum[n] > 0.5 ? 1 : 0;
const res = new Float32Array(N * N * N * 3);
for (let n = 0; n < N * N * N; n++) {
  if (!covered[n]) continue;
  const o = n * 3;
  res[o] = lut[o] - init[o];
  res[o + 1] = lut[o + 1] - init[o + 1];
  res[o + 2] = lut[o + 2] - init[o + 2];
}
const RAD = 4;
let filledRes = 0;
for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
  const n = (b * N + g) * N + r;
  if (covered[n]) continue;
  let ar = 0, ag = 0, ab = 0, aw = 0;
  for (let db = -RAD; db <= RAD; db++) {
    const bb = b + db; if (bb < 0 || bb >= N) continue;
    for (let dg = -RAD; dg <= RAD; dg++) {
      const gg = g + dg; if (gg < 0 || gg >= N) continue;
      for (let dr = -RAD; dr <= RAD; dr++) {
        const rr = r + dr; if (rr < 0 || rr >= N) continue;
        const m = (bb * N + gg) * N + rr;
        if (!covered[m]) continue;
        const w = 1 / (1 + dr * dr + dg * dg + db * db);
        const o = m * 3;
        ar += w * res[o]; ag += w * res[o + 1]; ab += w * res[o + 2]; aw += w;
      }
    }
  }
  if (aw > 0) {
    const o = n * 3;
    lut[o] = init[o] + ar / aw;
    lut[o + 1] = init[o + 1] + ag / aw;
    lut[o + 2] = init[o + 2] + ab / aw;
    filledRes++;
  }
}
console.log(`未覆盖格点补全: ${filledRes} 个（半径 ${RAD}）`);
// ---------- 4) 写 .cube ----------
const lines = [`TITLE "self-made adjust LUT"`, `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
  const o = ((b * N + g) * N + r) * 3;
  lines.push([lut[o], lut[o + 1], lut[o + 2]]
    .map((v) => Math.max(0, Math.min(1, v)).toFixed(6)).join(' '));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log('已生成:', OUT);
fs.rmSync(tmp, { recursive: true, force: true });
