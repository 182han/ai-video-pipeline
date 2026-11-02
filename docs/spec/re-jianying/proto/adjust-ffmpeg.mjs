// ============================================================
// adjust-ffmpeg.mjs —— 把「调节链」烘焙成 ffmpeg 能吃的产物
// ------------------------------------------------------------
// 点式运算（色温/亮度/对比度/饱和度/高光/阴影/黑白场/光感/褪色/曲线/色轮/HSL）
//   → 烘焙成 17³ .cube → ffmpeg `lut3d`
// 空间/随机运算（锐化/清晰/颗粒/暗角）
//   → ffmpeg 原生滤镜（unsharp / noise / vignette）
//
// 用法：
//   node adjust-ffmpeg.mjs --params '{"shadow":50}' --out ./out
//   → 生成 ./out/adjust.cube，并打印可直接用的 -vf 字符串
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adjustChain } from './adjust-chain.mjs';
import { loadLut, LUT_FILES } from './lut-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRID = 17;

/** 生成 3D LUT 的 .cube 文本（点式运算集合） */
export function buildCubeText(params, title = 'jianying-adjust') {
  // 光感/褪色在剪映里是 LUT 混合，这里自动注入对应 LUT
  if (params.lightSensation && !params.lightLut) {
    params = { ...params, lightLut: loadLut(params.lightSensation > 0 ? LUT_FILES.lightMax : LUT_FILES.lightMin) };
  }
  if (params.fade && !params.fadeLut) {
    params = { ...params, fadeLut: loadLut(LUT_FILES.fade) };
  }
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${GRID}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
  // .cube 顺序：红变化最快 → 绿 → 蓝
  for (let b = 0; b < GRID; b++) {
    for (let g = 0; g < GRID; g++) {
      for (let r = 0; r < GRID; r++) {
        const rgb = [r / (GRID - 1), g / (GRID - 1), b / (GRID - 1)];
        const out = adjustChain(rgb, params);
        lines.push(out.map((v) => Math.max(0, Math.min(1, v)).toFixed(6)).join(' '));
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** 空间类滤镜（锐化/颗粒/暗角），返回 ffmpeg 滤镜片段数组 */
export function spatialFilters(params = {}) {
  const f = [];
  if (params.sharpen) {
    const amt = Math.abs(params.sharpen) / 50 * 1.5;
    f.push(`unsharp=5:5:${amt.toFixed(2)}:5:5:0`);
  }
  if (params.clarity) {
    const amt = Math.abs(params.clarity) / 50 * 1.2;
    f.push(`unsharp=7:7:${amt.toFixed(2)}:7:7:0`);
  }
  if (params.grain) {
    const s = Math.round(Math.abs(params.grain) / 50 * 30);
    if (s > 0) f.push(`noise=alls=${s}:allf=t+u`);
  }
  if (params.vignette) {
    const a = (Math.abs(params.vignette) / 50) * (Math.PI / 5);
    f.push(`vignette=angle=${a.toFixed(3)}`);
  }
  return f;
}

/** 组装完整 -vf 字符串 */
export function buildFilter({ cubePath, params = {}, scale }) {
  const parts = [];
  if (cubePath) {
    // lut3d 不接受 Windows 绝对路径（盘符冒号会被当滤镜分隔符），调用方需 chdir 后用相对名
    parts.push(`lut3d=${path.basename(cubePath)}`);
  }
  parts.push(...spatialFilters(params));
  if (scale) parts.push(`scale=${scale}`);
  return parts.join(',');
}

// ---- CLI ----
if (process.argv[1] && process.argv[1].endsWith('adjust-ffmpeg.mjs')) {
  const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
  const paramsRaw = arg('--params', '{}');
  const outDir = arg('--out', HERE);
  let params;
  try { params = JSON.parse(paramsRaw); } catch (e) { console.error('参数不是合法 JSON:', e.message); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });
  const cubePath = path.join(outDir, 'adjust.cube');
  fs.writeFileSync(cubePath, buildCubeText(params, 'jianying-adjust'));
  console.log('已生成:', cubePath);
  console.log('点式参数:', JSON.stringify(params));
  console.log('-vf 片段:', buildFilter({ cubePath, params }) || '(无)');
  const sp = spatialFilters(params);
  console.log('空间滤镜:', sp.length ? sp.join(',') : '(无)');
}
