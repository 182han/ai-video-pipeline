// ============================================================
// adjustChain.js —— 剪映「调节」复刻（CommonJS，可直接放入 app/src/processors/）
// ------------------------------------------------------------
// 来源：本目录上一级 proto/ 的 5 个模块合并而来，逻辑完全一致。
// 依赖：仅 fs / path / child_process，无第三方包。
// 运行时 LUT 目录由 config.ADJUST.lutDir 传入（默认 assets/adjust）。
//
// 用法：
//   const { hasAdjust, normalizeParams, buildCubeFile, buildSpatialFilters } = require('./adjustChain');
//   if (hasAdjust(raw)) { const p = normalizeParams(raw); const cube = buildCubeFile(p, dir); }
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const GRID = 17;

// ---------------- 参数白名单 ----------------
const NUM_KEYS = ['temperature', 'tone', 'saturation', 'brightness', 'contrast',
  'highlight', 'shadow', 'white', 'black', 'lightSensation', 'fade',
  'sharpen', 'clarity', 'grain', 'vignette'];
const LIMIT = { hsl: 100 };

function normalizeParams(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of NUM_KEYS) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v) || v === 0) continue;
    out[k] = clamp(v, -50, 50);
    any = true;
  }
  if (Array.isArray(raw.hsl)) {
    const hsl = raw.hsl.slice(0, 8).map((b) => {
      if (!Array.isArray(b)) return [0, 0, 0];
      return [0, 1, 2].map((i) => {
        const v = Number(b[i]);
        return Number.isFinite(v) ? clamp(v, -LIMIT.hsl, LIMIT.hsl) : 0;
      });
    });
    if (hsl.some((b) => b.some((v) => v !== 0))) { out.hsl = hsl; any = true; }
  }
  if (raw.wheel && typeof raw.wheel === 'object') {
    // 对外契约：滑块值 -1..1（0 = 不变）；内部再按引擎公式换算成 lift/gamma/gain
    const w = { lift: {}, gamma: {}, gain: {} };
    for (const zone of ['lift', 'gamma', 'gain']) {
      for (const ch of ['r', 'g', 'b', 'y']) {
        const v = Number(raw.wheel[zone] && raw.wheel[zone][ch]);
        if (Number.isFinite(v) && v !== 0) { w[zone][ch] = clamp(v, -1, 1); any = true; }
      }
    }
    if (Object.keys(w.gamma).length || Object.keys(w.lift).length || Object.keys(w.gain).length) out.wheel = w;
  }
  if (Array.isArray(raw.curve) && raw.curve.length === 3) { out.curve = raw.curve; any = true; }
  return any ? out : null;
}

const hasAdjust = (raw) => !!normalizeParams(raw);

// ---------------- 点式运算 ----------------
function brightness(c, v) {
  if (!v) return c;
  const I = v / 50;
  // 引擎映射（combine_adjust/SeekModeScript.lua 的 getBrightnessParam）
  let param = I;
  if (I > 0 && I <= 0.7) param = 0.3 * I;
  else if (I > 0.7 && I <= 1.0) param = 0.6333 * I - 0.2333;
  const p = param > 0 ? 1 + param * 5 : 1 / (1 - param * 2.5);
  return c.map((x) => clamp01(1 - Math.pow(1 - x, p)));
}

// 引擎映射：getContrastSigmoidXFactor / getContrastParam（ContrastPivot = 0.435）
const CONTRAST_PIVOT = 0.435;
function contrastXFactor(param) {
  return Math.exp(8.33 * param - 12.16) + 5.82 * param - 1.72;
}
function contrast(c, v) {
  if (!v) return c;
  const I = v / 50;
  const param = I <= 0 ? I * 0.4 + 1 : I * 0.6 + 1;
  const xf = contrastXFactor(param);
  const pivot = CONTRAST_PIVOT;
  const sig = (t) => 1 / (1 + Math.exp(-xf * (t - pivot))) + pivot - 0.5;
  const dsig = (t) => { const s = 1 / (1 + Math.exp(-xf * (t - pivot))); return xf * s * (1 - s); };
  const pivotSlope = dsig(pivot);
  const lsd = pivotSlope - dsig(0), rsd = pivotSlope - dsig(1);
  const ld = 0 - sig(0), rd = 1 - sig(1);
  return c.map((ch) => {
    let res = sig(ch);
    const k = dsig(ch);
    if (ch <= pivot) { if (lsd) { const s = (pivotSlope - k) / lsd; res += s * s * ld; } }
    else if (rsd) { const s = (pivotSlope - k) / rsd; res += s * s * rd; }
    return clamp01(res);
  });
}

const SAT_W = [0.208540, 0.702086, 0.089374];
function saturation(c, v) {
  if (!v) return c;
  const s = 1 + v / 50;
  const y = SAT_W[0] * c[0] + SAT_W[1] * c[1] + SAT_W[2] * c[2];
  return c.map((ch) => clamp01(y + s * (ch - y)));
}

const pShadow = (x, a) => Math.pow(x, a) + (a - 1) * (x * x - x * x * x);
const pHigh = (x, a) => { const t = 1 - x; return 1 - Math.pow(t, a) - (a - 1) * (t * t - t * t * t); };
// 引擎映射：getShadowParam / getHighlightParam（四次多项式）
const shadowParamOf = (v) => {
  const p = v / 50, p2 = p * p, p3 = p2 * p, p4 = p3 * p;
  return 1 - 0.503 * p + 0.183 * p2 - 0.147 * p3 + 0.067 * p4;
};
const highlightParamOf = (v) => {
  const p = v / 50, p2 = p * p, p3 = p2 * p, p4 = p3 * p;
  return 1 + 0.503 * p + 0.183 * p2 + 0.147 * p3 + 0.067 * p4;
};
const shadow = (c, v) => (v ? c.map((ch) => clamp01(pShadow(ch, shadowParamOf(v)))) : c);
const highlight = (c, v) => (v ? c.map((ch) => clamp01(pHigh(ch, highlightParamOf(v)))) : c);

// 引擎映射：getBlackWhiteParam（黑白控制点 → slope/bias，MAX_RANGE=0.5）
function blackWhiteParams(blackV, whiteV) {
  const MAX_RANGE = 0.5, EPS = 0.005;
  const bi = (blackV || 0) / 50, wi = (whiteV || 0) / 50;
  let xw, yw, xb, yb;
  if (wi >= 0) { xw = 1 - wi * MAX_RANGE; yw = 1; } else { xw = 1; yw = 1 + wi * MAX_RANGE; }
  if (bi >= 0) { xb = 0; yb = bi * MAX_RANGE; } else { xb = -bi * MAX_RANGE; yb = 0; }
  xw = Math.max(xw, EPS); yw = Math.max(yw, EPS);
  xb = Math.min(xb, xw - EPS); yb = Math.min(yb, yw - EPS);
  const slope = (yw - yb) / (xw - xb);
  return { slope, bias: yb - slope * xb };
}
function blackWhite(c, white, black) {
  if (!white && !black) return c;
  const { slope, bias } = blackWhiteParams(black, white);
  return c.map((ch) => clamp01(slope * ch + bias));
}

function lutMix(c, v, lut) {
  if (!v || !lut) return c;
  const a = Math.abs(v / 50);
  const l = lut(c);
  return c.map((ch, i) => clamp01(ch + a * (l[i] - ch)));
}

// ---------------- 色温/色调（CIE 链） ----------------
const TT = (() => {
  const TABLE = [
    0, 0.18006, 0.26352, -0.24341, 10, 0.18066, 0.26589, -0.25479, 20, 0.18133, 0.26846, -0.26876,
    30, 0.18208, 0.27119, -0.28539, 40, 0.18293, 0.27407, -0.30470, 50, 0.18388, 0.27709, -0.32675,
    60, 0.18494, 0.28021, -0.35156, 70, 0.18611, 0.28342, -0.37915, 80, 0.18740, 0.28668, -0.40955,
    90, 0.18880, 0.28997, -0.44278, 100, 0.19032, 0.29326, -0.47888, 125, 0.19462, 0.30141, -0.58204,
    150, 0.19962, 0.30921, -0.70471, 175, 0.20525, 0.31647, -0.84901, 200, 0.21142, 0.32312, -1.0182,
    225, 0.21807, 0.32909, -1.2168, 250, 0.22511, 0.33439, -1.4512, 275, 0.23247, 0.33904, -1.7298,
    300, 0.24010, 0.34308, -2.0637, 325, 0.24792, 0.34655, -2.4681, 350, 0.25591, 0.34951, -2.9641,
    375, 0.26400, 0.35200, -3.5814, 400, 0.27218, 0.35407, -4.3633, 425, 0.28039, 0.35577, -5.3762,
    450, 0.28863, 0.35714, -6.7262, 475, 0.29685, 0.35823, -8.5955, 500, 0.30505, 0.35907, -11.324,
    525, 0.31320, 0.35968, -15.628, 550, 0.32129, 0.36011, -23.325, 575, 0.32931, 0.36038, -40.770,
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
  const mv = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
  const mm = (m1, m2) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => m1[i][0] * m2[0][j] + m1[i][1] * m2[1][j] + m1[i][2] * m2[2][j]));
  const diag = (v) => [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]];
  const E = (i) => TABLE[i - 1];
  function vec3(T, tones) {
    const x = 1e6 / T, y = tones * 1e-4;
    let index = 5, data = E(index); index += 4;
    while (data <= x && index < TABLE.length + 1) { data = E(index); index += 4; }
    let factor = (data - x) / (data - E(index - 8));
    let t1 = [mix(E(index - 3), E(index - 7), factor), mix(E(index - 2), E(index - 6), factor)];
    const a = E(index - 5), b = E(index - 1);
    const sqA = Math.sqrt(a * a + 1), sqB = Math.sqrt(b * b + 1);
    let t2 = [mix(1 / sqB, 1 / sqA, factor), mix(b / sqB, a / sqA, factor)];
    factor = Math.sqrt(t2[0] * t2[0] + t2[1] * t2[1]);
    t1 = [y * t2[0] / factor + t1[0], y * t2[1] / factor + t1[1]];
    const den = -4 * t1[1] + t1[0] + 2;
    let aa = clamp(t1[0] * 1.5 / den, 0.000001, 0.999999);
    let bb = clamp(t1[1] / den, 0.000001, 0.999999);
    if (aa + bb > 0.999999) { const t = 0.999999 / (aa + bb); aa /= t; bb /= t; }
    return [aa / bb, 1, (1 - aa - bb) / bb];
  }
  function matrix(T, tones) {
    if (T === 6500 && tones === 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const v1 = vec3(T, tones), v0 = vec3(6500, 0);
    const x1 = mv(A, v1), x0 = mv(A, v0);
    let m = mm(diag([x1[0] / x0[0], x1[1] / x0[1], x1[2] / x0[2]]), A);
    m = mm(B, m); m = mm(m, P); m = mm(Q, m);
    return m;
  }
  const tempFrom = (v) => { const x = v / 50; return 6500 - 1970 * x + 876 * x * x - 2630 * x * x * x; };
  return { matrix, tempFrom };
})();

function temperatureTone(c, temp, tone) {
  if (!temp && !tone) return c;
  const m = TT.matrix(TT.tempFrom(temp || 0), (tone || 0) * 2);
  return [0, 1, 2].map((i) => clamp01(m[i][0] * c[0] + m[i][1] * c[1] + m[i][2] * c[2]));
}

// ---------------- 色轮 ----------------
const GRAY = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function processWheel(src, lift, gamma, gain, offset) {
  const l = Math.min(lift || 0, 0.4995);
  const liftX = l / (l - 0.5);
  const gn = Math.max(gain || 1, 0.001);
  const gainX = 1 / gn;
  const lx = Math.min(liftX, gainX - 0.0005);
  let res = (src - (offset || 0) - lx) / (gainX - lx) + (offset || 0);
  res = res >= 0 ? Math.pow(res, gamma || 1) : -Math.pow(-res, gamma || 1);
  return res;
}
// 滑块 → 内部参数（引擎 SeekModeScript.lua 的 adjustLift / adjustGamma / adjustGain）
const adjustLift = (v) => (v > 0 ? v * 0.5 : v);
const adjustGamma = (v) => (v < 0 ? 1 - v * 4 : 1 / (1 + v * 4));
const adjustGain = (v) => (v < 0 ? 1 + v * 0.999 : 1 + v * v * 4);
function applyWheel(c, w) {
  if (!w) return c;
  const pick = (zone, ch, fn, dflt) => {
    const v = w[zone] && w[zone][ch];
    return Number.isFinite(v) ? fn(v) : dflt;
  };
  const g = {
    r: pick('gamma', 'r', adjustGamma, 1), g: pick('gamma', 'g', adjustGamma, 1),
    b: pick('gamma', 'b', adjustGamma, 1), y: pick('gamma', 'y', adjustGamma, 1)
  };
  const l = {
    r: pick('lift', 'r', adjustLift, 0), g: pick('lift', 'g', adjustLift, 0),
    b: pick('lift', 'b', adjustLift, 0), y: pick('lift', 'y', adjustLift, 0)
  };
  const gn = {
    r: pick('gain', 'r', adjustGain, 1), g: pick('gain', 'g', adjustGain, 1),
    b: pick('gain', 'b', adjustGain, 1), y: pick('gain', 'y', adjustGain, 1)
  };
  let r = processWheel(c[0], l.r, g.r, gn.r, 0);
  let gg = processWheel(c[1], l.g, g.g, gn.g, 0);
  let b = processWheel(c[2], l.b, g.b, gn.b, 0);
  const y0 = GRAY(c[0], c[1], c[2]);
  const y1 = processWheel(y0, l.y, g.y, gn.y, 0);
  const dy = y1 - GRAY(r, gg, b);
  return [r + dy, gg + dy, b + dy].map(clamp01);
}

// ---------------- HSL ----------------
function rgb2hsl(rgb) {
  const [r, g, b] = rgb;
  const cmax = Math.max(r, g, b), cmin = Math.min(r, g, b), d = cmax - cmin;
  const l = (cmax + cmin) / 2;
  let h = 0, s = 0;
  if (d > 1e-5) {
    s = l <= 0.5 ? d / (cmax + cmin) : d / (2 - (cmax + cmin));
    if (cmax === r) h = 60 * ((g - b) / d) + (g >= b ? 0 : 360);
    else if (cmax === g) h = 60 * ((b - r) / d) + 120;
    else h = 60 * ((r - g) / d) + 240;
  }
  return [h, s, l];
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hsl2rgb(hsl) {
  const h = (((hsl[0] % 360) + 360) % 360) / 360, s = clamp(hsl[1], 0, 1), l = clamp(hsl[2], 0, 1);
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}
const BANDS = [
  { center: -12.5, range: 32.5, offset: 360, type: 0 },
  { center: 25, range: 35, offset: 0, type: 1 },
  { center: 57.5, range: 32.5, offset: 0, type: 2 },
  { center: 120, range: 70, offset: 0, type: 3 },
  { center: 180, range: 45, offset: 0, type: 4 },
  { center: 207.5, range: 62.5, offset: 0, type: 5 },
  { center: 275, range: 40, offset: 0, type: 6 },
  { center: 310, range: 55, offset: 0, type: 7 }
];
function hueAdjust(hsb, mask, band, param) {
  const [ph, ps, pl] = param;
  if (!ph && !ps && !pl) return hsb;
  let px = band.type === 3 ? ph * 0.7 + 10 : ph * 0.3;
  let py = ps * 2 / 100;
  if (band.type === 0 && ps > 0) py = ps / 100;
  else if (band.type === 1 && ps > 0) py = ps * 1.2 / 100;
  const pz = band.type === 1 ? pl / 200 : pl / 100;
  const stand = band.center + band.offset;
  const minH = stand - band.range, maxH = stand + band.range;
  const curr = band.offset > 0 ? (mask[0] > 180 ? mask[0] - 360 + band.offset : mask[0] + band.offset) : mask[0];
  if (curr < minH || curr > maxH) return hsb;
  const alpha = 1 - Math.abs(curr - stand) / band.range;
  let h = hsb[0] + px * alpha;
  if (h >= 360) h -= 360;
  return [h, clamp(hsb[1] + hsb[1] * py * alpha, 0, 1), clamp(hsb[2] + hsb[2] * hsb[1] * pz * alpha, 0, 1)];
}
function applyHSL(c, params) {
  if (!params) return c;
  const hsb = rgb2hsl(c);
  const mask = hsb.slice();
  let cur = hsb;
  for (let i = 0; i < 8; i++) if (params[i]) cur = hueAdjust(cur, mask, BANDS[i], params[i]);
  return hsl2rgb(cur).map(clamp01);
}

// ---------------- 曲线（控制点 → 分段线性）----------------
function applyCurve(c, curve) {
  if (!Array.isArray(curve) || curve.length !== 3) return c;
  return c.map((ch, i) => {
    const pts = curve[i];
    if (!Array.isArray(pts) || pts.length < 2) return ch;
    const arr = pts.slice().sort((a, b) => a[0] - b[0]);
    if (ch <= arr[0][0]) return clamp01(arr[0][1]);
    if (ch >= arr[arr.length - 1][0]) return clamp01(arr[arr.length - 1][1]);
    for (let k = 1; k < arr.length; k++) {
      if (ch <= arr[k][0]) {
        const t = (ch - arr[k - 1][0]) / (arr[k][0] - arr[k - 1][0] || 1);
        return clamp01(arr[k - 1][1] + t * (arr[k][1] - arr[k - 1][1]));
      }
    }
    return ch;
  });
}

// ---------------- LUT 加载 ----------------
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
function extractPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).equals(SIG)) return buf;
  const s = buf.indexOf(SIG), e = s >= 0 ? buf.indexOf(IEND, s) : -1;
  if (s < 0 || e < 0) throw new Error('找不到内嵌 PNG: ' + file);
  return buf.subarray(s, e + 8);
}
function loadLut(file, ffmpegPath, half) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adjlut-'));
  try {
    const png = path.join(tmp, 'lut.png'), raw = path.join(tmp, 'lut.raw');
    const pngBuf = extractPng(file);
    fs.writeFileSync(png, pngBuf);
    const r = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', png,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0) throw new Error('LUT 解码失败: ' + file);
    const bytes = fs.readFileSync(raw);
    const w = pngBuf.readUInt32BE(16), h = pngBuf.readUInt32BE(20);
    const N = GRID;
    const lut = new Float32Array(N * N * N * 3);
    for (let bb = 0; bb < N; bb++) for (let gg = 0; gg < N; gg++) for (let rr = 0; rr < N; rr++) {
      const x = bb * N + rr;
      const y = gg + (h >= N * 2 ? (half || 0) * N : 0);
      const i = (y * w + x) * 3;
      const o = ((bb * N + gg) * N + rr) * 3;
      lut[o] = bytes[i] / 255; lut[o + 1] = bytes[i + 1] / 255; lut[o + 2] = bytes[i + 2] / 255;
    }
    return (rgb) => {
      const fr = rgb[0] * (N - 1), fg = rgb[1] * (N - 1), fb = rgb[2] * (N - 1);
      const r0 = Math.min(N - 1, Math.floor(fr)), g0 = Math.min(N - 1, Math.floor(fg)), b0 = Math.min(N - 1, Math.floor(fb));
      const r1 = Math.min(N - 1, r0 + 1), g1 = Math.min(N - 1, g0 + 1), b1 = Math.min(N - 1, b0 + 1);
      const dr = fr - r0, dg = fg - g0, db = fb - b0;
      const at = (ri, gi, bi, cc) => lut[((bi * N + gi) * N + ri) * 3 + cc];
      const out = [0, 0, 0];
      for (let cc = 0; cc < 3; cc++) {
        const c00 = at(r0, g0, b0, cc) * (1 - dr) + at(r1, g0, b0, cc) * dr;
        const c10 = at(r0, g1, b0, cc) * (1 - dr) + at(r1, g1, b0, cc) * dr;
        const c01 = at(r0, g0, b1, cc) * (1 - dr) + at(r1, g0, b1, cc) * dr;
        const c11 = at(r0, g1, b1, cc) * (1 - dr) + at(r1, g1, b1, cc) * dr;
        out[cc] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
      }
      return out;
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

// ---------------- 完整链 ----------------
function adjustChain(rgb, p) {
  if (!p) return rgb;
  let c = rgb.slice();
  c = temperatureTone(c, p.temperature, p.tone);
  c = brightness(c, p.brightness);
  c = contrast(c, p.contrast);
  c = saturation(c, p.saturation);
  c = highlight(c, p.highlight);
  c = shadow(c, p.shadow);
  c = blackWhite(c, p.white, p.black);
  if (p.lightLut) c = lutMix(c, p.lightSensation, p.lightLut);
  if (p.fadeLut) c = lutMix(c, p.fade, p.fadeLut);
  if (p.curve) c = applyCurve(c, p.curve);
  if (p.wheel) c = applyWheel(c, p.wheel);
  if (p.hsl) c = applyHSL(c, p.hsl);
  return c;
}

// ---------------- 产物 ----------------
function buildCubeText(params, title) {
  const lines = ['TITLE "' + (title || 'jianying-adjust') + '"', 'LUT_3D_SIZE ' + GRID,
    'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
  for (let b = 0; b < GRID; b++) for (let g = 0; g < GRID; g++) for (let r = 0; r < GRID; r++) {
    const out = adjustChain([r / (GRID - 1), g / (GRID - 1), b / (GRID - 1)], params);
    lines.push(out.map((v) => clamp01(v).toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}

function buildSpatialFilters(p) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const f = [];
  const sharp = num(p.sharpen);
  if (sharp) f.push('unsharp=5:5:' + (Math.abs(sharp) / 50 * 1.5).toFixed(2) + ':5:5:0');
  const clarity = num(p.clarity);
  if (clarity) f.push('unsharp=7:7:' + (Math.abs(clarity) / 50 * 1.2).toFixed(2) + ':7:7:0');
  const grain = num(p.grain);
  if (grain) { const s = Math.round(Math.abs(grain) / 50 * 30); if (s > 0) f.push('noise=alls=' + s + ':allf=t+u'); }
  const vig = num(p.vignette);
  if (vig) f.push('vignette=angle=' + (Math.abs(vig) / 50 * Math.PI / 5).toFixed(3));
  return f;
}

// Windows 路径 → 滤镜安全（盘符冒号必须转义，否则被当滤镜分隔符）
const escapeFilterPath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:');

/**
 * 生成可直接塞进 ffmpeg -vf 的调节滤镜串（带 cube 缓存）
 * @param {object} params 已 normalize 的参数
 * @param {object} opts { cubeDir, lutDir, ffmpegPath, spatial }
 * @returns {{filter: string, cubePath: string|null, spatial: string[]}}
 */
function prepareAdjust(params, opts = {}) {
  const crypto = require('crypto');
  const cubeDir = opts.cubeDir || path.join(os.tmpdir(), 'adjust-cubes');
  const spatial = opts.spatial === false ? [] : buildSpatialFilters(params);
  const parts = [];

  // 只有点式参数（含 hsl/curve/wheel）才需要 cube；纯空间类不生成
  const pointwise = Object.keys(params).some((k) => ['sharpen', 'clarity', 'grain', 'vignette'].indexOf(k) < 0);
  let cubePath = null;
  if (pointwise) {
    fs.mkdirSync(cubeDir, { recursive: true });
    // 光感/褪色需要 LUT：优先 opts.lutDir，其次不注入（明确降级）
    const p = { ...params };
    if (p.lightSensation && !p.lightLut && opts.lutDir && opts.ffmpegPath) {
      const f = path.join(opts.lutDir, p.lightSensation > 0 ? 'lightSensation_max.png' : 'lightSensation_min.png');
      if (fs.existsSync(f)) p.lightLut = loadLut(f, opts.ffmpegPath, 0);
    }
    if (p.fade && !p.fadeLut && opts.lutDir && opts.ffmpegPath) {
      const f = path.join(opts.lutDir, 'fade_max.texture');
      if (fs.existsSync(f)) p.fadeLut = loadLut(f, opts.ffmpegPath, 0);
    }
    const keySrc = JSON.stringify(params) + '|' + (p.lightLut ? 'L' : '-') + (p.fadeLut ? 'F' : '-');
    const hash = crypto.createHash('sha1').update(keySrc).digest('hex').slice(0, 16);
    cubePath = path.join(cubeDir, `${hash}.cube`);
    if (!fs.existsSync(cubePath)) fs.writeFileSync(cubePath, buildCubeText(p, hash));
    // ffmpeg 在 Windows 上无法接受 lut3d 的绝对路径（盘符冒号会被当分隔符），
    // 必须 cwd 到 cube 所在目录 + 只用文件名。调用方据此设置 ffmpeg 的 cwd。
    parts.push('lut3d=' + path.basename(cubePath));
  }
  parts.push(...spatial);
  return { filter: parts.join(','), cubePath, spatial };
}

module.exports = {
  GRID,
  hasAdjust,
  normalizeParams,
  adjustChain,
  buildCubeText,
  buildSpatialFilters,
  escapeFilterPath,
  loadLut,
  prepareAdjust,
  // 单项（供验收脚本用）
  brightness, contrast, saturation, shadow, highlight, saturationFactor: SAT_W
};
