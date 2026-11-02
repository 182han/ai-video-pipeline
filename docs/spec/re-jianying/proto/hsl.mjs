// ============================================================
// hsl.mjs —— 剪映 HSL「HSL 基础」移植
// 来源：hsl/HSL/xshader/fshader.frag
//
// 8 条色相带（中心角/带宽）：
//   红 -12.5±32.5、橙 25±35、黄 57.5±32.5、绿 120±70、
//   青 180±45、蓝 207.5±62.5、紫 275±40、品红 310±55
// 每带 3 个参数 (hue, sat, light)，滑块范围按 -100..100 处理（无对照，待验证）
//
// 权重：alpha = 1 - |currHue - center| / deltaRange
// 色相：h' = h + hue*0.3*alpha        （绿带特殊：h*0.7+10）
// 饱和：s' = s + s*(sat*2/100)*alpha  （红带正值为 sat/100，橙带为 sat*1.2/100）
// 亮度：l' = l + l*s*(light/100)*alpha（橙带 /200）
// ============================================================
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function rgb2hsl(rgb) {
  const [r, g, b] = rgb;
  const cmax = Math.max(r, g, b), cmin = Math.min(r, g, b);
  const delta = cmax - cmin;
  const l = (cmax + cmin) / 2;
  let h = 0, s = 0;
  if (delta > 1e-5) {
    s = l <= 0.5 ? delta / (cmax + cmin) : delta / (2 - (cmax + cmin));
    if (cmax === r) h = 60 * ((g - b) / delta) + (g >= b ? 0 : 360);
    else if (cmax === g) h = 60 * ((b - r) / delta) + 120;
    else h = 60 * ((r - g) / delta) + 240;
  }
  return [h, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hsl2rgb(hsl) {
  const h = ((hsl[0] % 360) + 360) % 360 / 360;
  const s = clamp(hsl[1], 0, 1);
  const l = clamp(hsl[2], 0, 1);
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

export const BANDS = [
  { center: -12.5, range: 32.5, offset: 360, type: 0, label: '红' },
  { center: 25, range: 35, offset: 0, type: 1, label: '橙' },
  { center: 57.5, range: 32.5, offset: 0, type: 2, label: '黄' },
  { center: 120, range: 70, offset: 0, type: 3, label: '绿' },
  { center: 180, range: 45, offset: 0, type: 4, label: '青' },
  { center: 207.5, range: 62.5, offset: 0, type: 5, label: '蓝' },
  { center: 275, range: 40, offset: 0, type: 6, label: '紫' },
  { center: 310, range: 55, offset: 0, type: 7, label: '品红' }
];

function hueAdjust(hsb, maskHsb, band, param) {
  const [ph, ps, pl] = param;
  if (!ph && !ps && !pl) return hsb;
  // 参数换算（照抄 shader）
  let px = band.type === 3 ? ph * 0.7 + 10 : ph * 0.3;
  let py = ps * 2 / 100;
  if (band.type === 0 && ps > 0) py = ps / 100;
  else if (band.type === 1 && ps > 0) py = ps * 1.2 / 100;
  const pz = band.type === 1 ? pl / 200 : pl / 100;

  const standHue0 = band.center + band.offset;
  const minHue = standHue0 - band.range;
  const maxHue = standHue0 + band.range;
  let currHue;
  if (band.offset > 0) currHue = maskHsb[0] > 180 ? maskHsb[0] - 360 + band.offset : maskHsb[0] + band.offset;
  else currHue = maskHsb[0];

  if (currHue < minHue || currHue > maxHue) return hsb;
  const alpha = 1 - Math.abs(currHue - standHue0) / band.range;
  let h = hsb[0] + px * alpha;
  if (h >= 360) h -= 360;
  const s = clamp(hsb[1] + hsb[1] * py * alpha, 0, 1);
  const l = clamp(hsb[2] + hsb[2] * hsb[1] * pz * alpha, 0, 1);
  return [h, s, l];
}

/**
 * @param {number[]} rgb 0..1
 * @param {number[][]} params 8×3，每带 [色相, 饱和, 亮度]，范围 -100..100
 */
export function applyHSL(rgb, params) {
  if (!params || params.every((p) => !p || (!p[0] && !p[1] && !p[2]))) return rgb;
  const hsb = rgb2hsl(rgb);
  const mask = hsb.slice();
  let cur = hsb;
  for (let i = 0; i < 8; i++) {
    const p = params[i];
    if (!p) continue;
    cur = hueAdjust(cur, mask, BANDS[i], p);
  }
  return hsl2rgb(cur).map((v) => clamp(v, 0, 1));
}
