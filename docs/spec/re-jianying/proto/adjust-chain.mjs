// ============================================================
// adjust-chain.mjs —— proto 层 ESM 入口（唯一实现：../app-module/adjustChain.js）
// ------------------------------------------------------------
// 早期这里有一份独立实现，参数映射是拟合/推断的（高光 1.4、黑白线性、对比度拟合）。
// 现在统一到 app-module/adjustChain.js（CommonJS，映射取自引擎 Lua 原文）。
// 本文件只做 ESM 包装，避免两份实现分叉。
//
// 顺序取自 contrast_v3/AmazingFeature/xshader/colorAdjust.frag 的 main()：
//   色温/色调 → 亮度 → 对比度 → 饱和度 → 高光 → 阴影 → 黑白场 → 光感 → 褪色
//   之后是可选的 曲线 → 色轮 → HSL
// ============================================================
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const impl = require(path.join(HERE, 'app-module', 'adjustChain.js'));

export const {
  GRID,
  hasAdjust,
  normalizeParams,
  adjustChain,
  buildCubeText,
  buildSpatialFilters,
  escapeFilterPath,
  loadLut,
  brightness,
  contrast,
  saturation,
  shadow,
  highlight,
  saturationFactor
} = impl;

// ---- 兼容旧调用名（proto 脚本里按单项函数名使用）----
export const temperatureTone = (c, temp, tone) => adjustChain(c, { temperature: temp, tone });
export const blackWhite = (c, white, black) => adjustChain(c, { white, black });
export const lightSensation = (c, v, lut) => adjustChain(c, { lightSensation: v, lightLut: lut });
export const fade = (c, v, lut) => adjustChain(c, { fade: v, fadeLut: lut });
export const wheel = (c, params) => adjustChain(c, { wheel: params });

// 旧接口是「每通道一个函数」；转成 3×17 控制点后交给统一实现
export const curves = (c, luts) => {
  if (!luts) return c;
  const pts = luts.map((fn) => (typeof fn === 'function'
    ? Array.from({ length: 17 }, (_, i) => [i / 16, fn(i / 16)])
    : null));
  if (!pts.some(Boolean)) return c;
  return adjustChain(c, { curve: pts });
};
