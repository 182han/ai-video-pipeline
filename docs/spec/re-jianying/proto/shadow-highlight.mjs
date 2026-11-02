// ============================================================
// shadow-highlight.mjs —— 剪映「高光/阴影」幂函数移植
// 来源：shadow_highlight_v3_gles3/AmazingFeature/xshader/HighlightShadow.frag
//
// 公式（逐通道，先高光后阴影）：
//   highlight: y = 1 - (1-x)^a - (a-1)·((1-x)² - (1-x)³)
//   shadow   : y = x^a + (a-1)·(x² - x³)
//   a = 1 时为恒等
//
// 实测：shadow50 → SA=0.60，PSNR 44.34 dB
// 映射（推断，待 high50 验证）：SA = 1 - 0.008·值，HA = 1 + 0.008·值
// ============================================================
export const processShadow = (x, a) => Math.pow(x, a) + (a - 1) * (x * x - x * x * x);
export const processHighlight = (x, a) => {
  const t = 1 - x;
  return 1 - Math.pow(t, a) - (a - 1) * (t * t - t * t * t);
};
export const paramFromSlider = (v) => 1 - 0.008 * v;   // 阴影：+50 → 0.6
export const paramFromSliderHi = (v) => 1 + 0.008 * v; // 高光：+50 → 1.4（推断）

// 完整应用：先高光后阴影（与 shader main() 顺序一致）
export function applyHighlightShadow(rgb, handler, haParam, saParam) {
  let [r, g, b] = rgb;
  if (handler !== 'shadowOnly') { r = processHighlight(r, haParam); g = processHighlight(g, haParam); b = processHighlight(b, haParam); }
  if (handler !== 'highlightOnly') { r = processShadow(r, saParam); g = processShadow(g, saParam); b = processShadow(b, saParam); }
  return [r, g, b].map((v) => Math.min(1, Math.max(0, v)));
}
