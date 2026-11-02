#!/usr/bin/env node
// ============================================================
// apply-adjust.js —— 给任意视频套上「剪映调节」效果（独立命令，不接 pipeline）
// ------------------------------------------------------------
// 用法：
//   node scripts/apply-adjust.js --input a.mp4 --output b.mp4 \
//        --params '{"brightness":50,"saturation":20}' [--crf 18]
//
// 说明：
//   - 点式参数烘焙成 17³ .cube → ffmpeg lut3d
//   - 空间参数（锐化/清晰/颗粒/暗角）→ unsharp/noise/vignette
//   - LUT 资源优先取 assets/adjust/，找不到再回退到本机剪映安装目录
//   - 尚未接入 pipeline，只用于手动验证与离线处理
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('../config');
const adjust = require('../src/processors/adjustChain');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const input = arg('--input');
const output = arg('--output');
const paramsRaw = arg('--params', '{}');
const paramsFile = arg('--params-file');
const crf = arg('--crf', '18');

if (!input || !output) {
  console.error('用法: node scripts/apply-adjust.js --input <in.mp4> --output <out.mp4> --params \'{"brightness":50}\'');
  process.exit(2);
}
if (!fs.existsSync(input)) { console.error('输入不存在:', input); process.exit(2); }

let raw;
try {
  // 容忍 Windows 记事本/PowerShell 写入的 UTF-8 BOM
  const text = paramsFile ? fs.readFileSync(paramsFile, 'utf8') : paramsRaw;
  raw = JSON.parse(text.replace(/^\uFEFF/, ''));
} catch (e) { console.error('参数不是合法 JSON:', e.message); process.exit(2); }

const params = adjust.normalizeParams(raw);
if (!params) { console.error('没有可用的调节参数（全部为 0 或非法）'); process.exit(2); }

// LUT 资源解析：优先 app/assets/adjust，其次本机剪映安装目录
const ASSET_DIR = path.join(__dirname, '..', 'assets', 'adjust');
const JY_DIR = process.env.JY_ADJUST_DIR
  || 'C:\\Users\\14872\\AppData\\Local\\JianyingPro\\User Data\\Resources\\DefaultAdjustBundle';
function findLut(name, jyRel) {
  const local = path.join(ASSET_DIR, name);
  if (fs.existsSync(local)) return local;
  const jy = path.join(JY_DIR, jyRel);
  if (fs.existsSync(jy)) return jy;
  return null;
}
// 光感：优先自研 .cube（不依赖剪映安装）；没有则回退剪映 PNG
const lightMax = findLut('lightSensation_max.cube', 'contrast_v3\\AmazingFeature\\image\\lightSensation_max.png');
const lightMin = findLut('lightSensation_min.cube', 'contrast_v3\\AmazingFeature\\image\\lightSensation_min.png');

const warnings = [];
if (params.lightSensation) {
  const f = params.lightSensation > 0 ? lightMax : lightMin;
  if (f && f.endsWith('.cube')) params.lightLut = adjust.loadCube(f);
  else if (f) params.lightLut = adjust.loadLut(f, cfg.FFMPEG_PATH, 0);
  else warnings.push('光感资源缺失，已跳过该项');
}
// 褪色：自研公式（不需要资源文件），由 adjustChain 内部处理

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adjust-'));
try {
  const cube = path.join(tmp, 'adjust.cube');
  fs.writeFileSync(cube, adjust.buildCubeText(params, path.basename(output)));

  const vf = ['lut3d=' + path.basename(cube), ...adjust.buildSpatialFilters(params)]
    .concat(['scale=trunc(iw/2)*2:trunc(ih/2)*2'])
    .join(',');

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', path.resolve(input),
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
    '-c:a', 'copy', '-pix_fmt', 'yuv420p',
    path.resolve(output)
  ];
  const r = spawnSync(cfg.FFMPEG_PATH, args, { cwd: tmp, stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) {
    // 没有音轨时 -c:a copy 会失败，去掉音轨参数重试一次
    const idx = args.indexOf('-c:a');
    if (idx >= 0) args.splice(idx, 2);
    const r2 = spawnSync(cfg.FFMPEG_PATH, args, { cwd: tmp, stdio: 'ignore', windowsHide: true });
    if (r2.status !== 0) { console.error('ffmpeg 失败'); process.exit(1); }
  }
  const size = fs.statSync(output).size;
  console.log('完成:', output, `(${(size / 1024 / 1024).toFixed(2)} MB)`);
  console.log('参数:', JSON.stringify(params, (k, v) => (typeof v === 'function' ? '[lut]' : v)));
  console.log('滤镜:', vf);
  if (warnings.length) console.log('警告:', warnings.join('；'));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
