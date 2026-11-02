// ============================================================
// color-wheel.mjs —— 剪映「一级色轮」移植
// 来源：merge_all_adjust_color/AmazingFeature_primaryWheel/xshader/fshader.frag
//       + lua/SeekModeScript.lua（参数映射）
//
// 公式（每通道）：processWheel(x, lift, gamma, gain, offset)
//   liftX = lift/(lift-0.5)；gainX = 1/gain
//   y = (x - offset - liftX)/(gainX - liftX) + offset
//   y = sign(y)·|y|^gamma
// 之后按 LumaMix(=1) 把亮度差补回：rgb += (Y_ori - Y_out)·LumaMix
//
// 参数映射（Lua 原文）：
//   adjustLift(v)  = v>0 ? v*0.5 : v
//   adjustGamma(v) = v<0 ? 1 - v*4 : 1/(1 + v*4)
//   adjustGain(v)  = v<0 ? 1 + v*0.999 : 1 + v*v*4
//
// 实测：wheel-blue（中灰往蓝推）→ γR=1.43 γG=0.89 γB=0.63，PSNR 38.26 dB
// ============================================================
export const adjustLift = (v) => (v > 0 ? v * 0.5 : v);
export const adjustGamma = (v) => (v < 0 ? 1 - v * 4 : 1 / (1 + v * 4));
export const adjustGain = (v) => (v < 0 ? 1 + v * 0.999 : 1 + v * v * 4);
export const gray = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function processWheel(src, lift, gamma, gain, offset = 0) {
  lift = Math.min(lift, 0.4995);
  const liftX = lift / (lift - 0.5);
  gain = Math.max(gain, 0.001);
  const gainX = 1 / gain;
  const lx = Math.min(liftX, gainX - 0.0005);
  let res = (src - offset - lx) / (gainX - lx) + offset;
  res = res >= 0 ? Math.pow(res, gamma) : -Math.pow(-res, gamma);
  return res;
}

/**
 * 应用一级色轮
 * @param {number[]} rgb  0..1
 * @param {object} p  { lift:{r,g,b,y}, gamma:{...}, gain:{...}, offset:{r,g,b}, lumaMix }
 */
export function applyColorWheel(rgb, p) {
  const o = { r: p.offset?.r || 0, g: p.offset?.g || 0, b: p.offset?.b || 0 };
  let r = rgb[0] + o.r, g = rgb[1] + o.g, b = rgb[2] + o.b;
  const y0 = gray(r, g, b);
  const yRef = processWheel(y0, p.lift?.y || 0, p.gamma?.y ?? 1, p.gain?.y ?? 1, gray(o.r, o.g, o.b));
  r = processWheel(r, p.lift?.r || 0, p.gamma?.r ?? 1, p.gain?.r ?? 1, o.r);
  g = processWheel(g, p.lift?.g || 0, p.gamma?.g ?? 1, p.gain?.g ?? 1, o.g);
  b = processWheel(b, p.lift?.b || 0, p.gamma?.b ?? 1, p.gain?.b ?? 1, o.b);
  const dy = (yRef - gray(r, g, b)) * (p.lumaMix ?? 1);
  return [r + dy, g + dy, b + dy].map((v) => Math.min(1, Math.max(0, v)));
}
