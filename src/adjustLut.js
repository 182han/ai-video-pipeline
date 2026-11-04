// ============================================================
// 调节参数 → 3D LUT 二进制（预览用）
// ------------------------------------------------------------
// 2026-11-04 F06：预览与导出必须同一套颜色数学。
// 导出走 ffmpeg lut3d（float cube）；预览走 WebGL 3D 纹理（8-bit）。
// 这里直接用 adjustChain 逐点采样，保证不是第二套公式。
// 返回 RGBA8：17³，r 变化最快（与 WebGL 3D 纹理 x 轴一致）。
// ============================================================
const { normalizeParams, adjustChain } = require('./processors/adjustChain');

const N = 17;
const MAX_CACHE = 64;
const cache = new Map();

function build(adjust) {
  const params = normalizeParams(adjust);
  if (!params) return null;
  const buf = Buffer.alloc(N * N * N * 4);
  let o = 0;
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const c = adjustChain([r / (N - 1), g / (N - 1), b / (N - 1)], params);
        for (let k = 0; k < 3; k++) {
          const v = Math.max(0, Math.min(1, c[k]));
          buf[o++] = Math.round(v * 255);
        }
        buf[o++] = 255;
      }
    }
  }
  return buf;
}

function get(adjust) {
  const params = normalizeParams(adjust);
  if (!params) return { size: N, data: null };
  const key = JSON.stringify(params);
  let b64 = cache.get(key);
  if (!b64) {
    b64 = build(adjust).toString('base64');
    cache.set(key, b64);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  return { size: N, data: b64 };
}

module.exports = { N, get, _build: build };
