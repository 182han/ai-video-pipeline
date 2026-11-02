// ============================================================
// lut-extract.mjs —— 剪映「调节」LUT 提取器 / .cube 生成器
// ------------------------------------------------------------
// 输入：DefaultAdjustBundle/<param>/ 里的 Laya .texture（内嵌 289x34 或 289x17 PNG）
// 输出：按滑杆值烘焙好的 17^3 .cube（可直接给 ffmpeg lut3d 用）
//
// 数学：shader 里是 out = mix(原色, LUT(原色), |intensity|)，符号选上/下半张。
// 这里把 mix 提前算进 .cube：out = (1-|s|)*in + |s|*LUT_half(in)
// 所以一个 .cube 对应一个具体滑杆值，运行时一次 lut3d 即可，零额外开销。
//
// 用法：
//   node lut-extract.mjs --param brightness --value 25 --out dir/
//   node lut-extract.mjs --all --value 25 --out dir/     # 全部 LUT 项，同一值
//   node lut-extract.mjs --param brightness --value 0 --out dir/   # 恒等（用于验证）
// 值域：滑杆 -50..50 → intensity = value / 50
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FF = process.env.FFMPEG_PATH
  || 'C:\\Users\\14872\\Desktop\\测试\\app\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const BASE = process.env.JY_ADJUST_DIR
  || 'C:\\Users\\14872\\AppData\\Local\\JianyingPro\\User Data\\Resources\\DefaultAdjustBundle';
const SLIDER_MAX = 50;

// 已确认是 17^3 LUT 的项；halves: 'negpos' | 'single'
const LUT_PARAMS = {
  brightness: { halves: 'negpos' },
  contrast: { halves: 'negpos' },
  saturation: { halves: 'negpos' },
  temperature: { halves: 'negpos' },
  tone: { halves: 'negpos' },
  highlight: { halves: 'single' },
  shadow: { halves: 'single' },
  fade: { halves: 'single' }
};

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const GRID = 17;

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function findTexture(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase().endsWith('.texture')) return p;
    }
  }
  return null;
}

function extractPng(texPath) {
  const buf = fs.readFileSync(texPath);
  const s = buf.indexOf(SIG);
  const e = s >= 0 ? buf.indexOf(IEND, s) : -1;
  if (s < 0 || e < 0) throw new Error('找不到完整 PNG: ' + texPath);
  return buf.subarray(s, e + 8);
}

function decodeRgb(png, tmp) {
  const pngPath = path.join(tmp, 'in.png');
  const rawPath = path.join(tmp, 'in.raw');
  fs.writeFileSync(pngPath, png);
  const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', pngPath,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', rawPath], { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error('解码 PNG 失败');
  const raw = fs.readFileSync(rawPath);
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20), raw };
}

// 取 LUT 网格点 (r,g,b) 的值；half: 0=上半(负向) 1=下半(正向)
function lutAt(img, r, g, b, half) {
  const { w, raw } = img;
  const x = b * GRID + r;
  const y = g + (half ? GRID : 0);
  const i = (y * w + x) * 3;
  return [raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255];
}

function buildCube(param, meta, value, outDir, tmp) {
  const s = Math.max(-1, Math.min(1, Number(value) / SLIDER_MAX));
  const mag = Math.abs(s);
  const half = meta.halves === 'negpos' ? (s >= 0 ? 1 : 0) : 0;
  const tex = findTexture(path.join(BASE, param));
  if (!tex) throw new Error(`找不到 ${param} 的 .texture`);
  const img = decodeRgb(extractPng(tex), tmp);
  if (meta.halves === 'negpos' && img.h !== GRID * 2) {
    throw new Error(`${param} 期望 ${GRID * 2} 行，实际 ${img.h}`);
  }

  const lines = ['TITLE "' + param + ' s=' + s.toFixed(2) + '"', `LUT_3D_SIZE ${GRID}`,
    'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
  // .cube 顺序：红变化最快，其次绿，最后蓝
  for (let b = 0; b < GRID; b++) {
    for (let g = 0; g < GRID; g++) {
      for (let r = 0; r < GRID; r++) {
        const inR = r / (GRID - 1);
        const inG = g / (GRID - 1);
        const inB = b / (GRID - 1);
        const l = lutAt(img, r, g, b, half);
        const o = [
          (1 - mag) * inR + mag * l[0],
          (1 - mag) * inG + mag * l[1],
          (1 - mag) * inB + mag * l[2]
        ].map((v) => Math.max(0, Math.min(1, v)).toFixed(6));
        lines.push(`${o[0]} ${o[1]} ${o[2]}`);
      }
    }
  }
  const name = `${param}${value >= 0 ? '+' : ''}${value}.cube`;
  const out = path.join(outDir, name);
  fs.writeFileSync(out, lines.join('\n') + '\n');
  return { param, value, intensity: s, half, size: img.w + 'x' + img.h, file: out };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lutx-'));
try {
  const outDir = arg('--out', 'cubes');
  fs.mkdirSync(outDir, { recursive: true });
  const value = Number(arg('--value', '25'));
  const only = arg('--param');
  const all = process.argv.includes('--all');
  const params = only ? [only] : (all ? Object.keys(LUT_PARAMS) : []);
  if (!params.length) {
    console.error('用法: --param <name> | --all  ，另需 --value <滑杆值> --out <目录>');
    process.exit(2);
  }
  const results = [];
  for (const p of params) {
    const meta = LUT_PARAMS[p];
    if (!meta) { console.error(`跳过未知参数 ${p}`); continue; }
    results.push(buildCube(p, meta, value, outDir, tmp));
  }
  console.log(JSON.stringify(results, null, 1));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
