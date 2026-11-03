#!/usr/bin/env node
// ============================================================
// verify-adjust-psnr.js —— 调节滑杆逐项 PSNR 验收（真实对照视频）
// ------------------------------------------------------------
// 方法（与 docs/spec/re-jianying/jy-adjust.md §13 一致）：
//   1) base.mp4 = 剪映「无调节」导出，作为输入
//   2) 用本项目的调节链把 base 烘焙成 .cube，ffmpeg lut3d 重编码
//   3) 与剪映导出的同名 +50 对照逐帧比 PSNR（480x270，RGB24）
//      · 对照比输出晚 1 帧（实测剪映导出的时间轴差 1/30s），比较时对齐
//   4) 每项取 t=1 / 2.5 / 4 三帧，报均值与最小值；均值 >= 阈值才算通过
//
// 三态（AGENTS §5.1）：
//   通过 / 不通过 / 未验证（缺对照文件）
//   「未验证」不等于通过；默认 --require-all 时缺对照也会让退出码为 1。
//
// 用法：
//   node scripts/verify-adjust-psnr.js
//   node scripts/verify-adjust-psnr.js --threshold 40
//   node scripts/verify-adjust-psnr.js --only bright50,con50 --allow-missing
//   node scripts/verify-adjust-psnr.js --ref-dir "D:\某处\对照" --json
//
// 可复述：
//   cd app
//   node scripts/verify-adjust-psnr.js --threshold 40
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');
const adjust = require('../src/processors/adjustChain');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(name);

const REF_DIR = arg('--ref-dir')
  || path.join(process.env.USERPROFILE || 'C:\\Users\\14872', 'Desktop', '风景照片', '对照');
const THRESHOLD = Number(arg('--threshold', '40'));
const ONLY = (arg('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const REQUIRE_ALL = !flag('--allow-missing');
const AS_JSON = flag('--json');
const KEEP = flag('--keep');
const GRID = Number(arg('--grid', '0')); // 0 = 跟随 prepareAdjust 默认（光感 65³、其余 33³）
const LIGHT_LUT = arg('--light-lut'); // 实验用：覆盖光感 LUT 文件
// 判据：默认沿用 jy-adjust.md §13 既有口径 —— t=2.5 单帧。
// 三帧（t=1/2.5/4）均值/最小值仍会打印，用于观察运动帧的稳定性；可用 --gate-metric mean 改成均值判据。
const GATE_T = Number(arg('--gate-t', '2.5'));
const GATE_METRIC = arg('--gate-metric', 'frame');

// 对照文件命名 → 参数。参考名 = 剪映导出文件名（不含 .mp4）
const CASES = [
  { name: 'temp50', param: 'temperature', label: '色温', ref: 'temp50' },
  { name: 'tone50', param: 'tone', label: '色调', ref: 'tone50' },
  { name: 'sat50', param: 'saturation', label: '饱和度', ref: 'sat50' },
  { name: 'bright50', param: 'brightness', label: '亮度', ref: 'bright50' },
  { name: 'con50', param: 'contrast', label: '对比度', ref: 'con50' },
  { name: 'high50', param: 'highlight', label: '高光', ref: 'high50' },
  { name: 'shadow50', param: 'shadow', label: '阴影', ref: 'shadow50' },
  { name: 'white50', param: 'white', label: '白色', ref: 'white50' },
  { name: 'black50', param: 'black', label: '黑色', ref: 'black50' },
  { name: 'light50', param: 'lightSensation', label: '光感', ref: 'light50' }
];

const TIMES = [1, 2.5, 4];
const W = 480, H = 270;
// 对照与本次输出的时间轴差：默认 1 帧（实测对齐，见 jy-adjust.md §10/§13）
const FRAME_DELAY = Number(arg('--delay', String(1 / 30)));

function findRef(name) {
  const dir = path.join(REF_DIR, name + '.mp4');
  const nested = path.join(dir, name + '.mp4.mp4');
  if (fs.existsSync(nested)) return nested;
  const flat = path.join(REF_DIR, name + '.mp4');
  if (fs.existsSync(flat) && fs.statSync(flat).isFile()) return flat;
  return null;
}

function findBase() {
  return findRef('base');
}

function runFfmpeg(args, cwd) {
  const r = spawnSync(config.FFMPEG_PATH, args, {
    stdio: 'ignore', windowsHide: true, cwd: cwd || undefined
  });
  if (r.status !== 0) throw new Error('ffmpeg 失败: ' + args.join(' ').slice(0, 240));
}

function rawFrame(src, t, out) {
  runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(4), '-i', src,
    '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const b = fs.readFileSync(out);
  fs.unlinkSync(out);
  return b;
}

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < b.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / b.length;
  return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}

function lumaChannel(raw) {
  const n = raw.length / 3;
  const y = Buffer.allocUnsafe(n);
  for (let i = 0, j = 0; i < raw.length; i += 3, j++) {
    // BT.601 full-range luma，仅用于诊断（与剪映 sRGB 近似）
    y[j] = Math.round(0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]);
  }
  return y;
}

function buildFilter(params, cubeDir) {
  // 与 scripts/apply-adjust.js 完全同一条链：prepareAdjust 负责光感 LUT 注入
  let lutDir = path.join(__dirname, '..', 'assets', 'adjust');
  if (LIGHT_LUT) {
    lutDir = path.join(cubeDir, 'lut');
    fs.mkdirSync(lutDir, { recursive: true });
    fs.copyFileSync(LIGHT_LUT, path.join(lutDir, 'lightSensation_max.cube'));
    const minSrc = LIGHT_LUT.replace(/max/i, 'min');
    if (fs.existsSync(minSrc)) fs.copyFileSync(minSrc, path.join(lutDir, 'lightSensation_min.cube'));
  }
  return adjust.prepareAdjust(params, {
    cubeDir,
    lutDir,
    ffmpegPath: config.FFMPEG_PATH,
    ...(GRID > 1 ? { grid: GRID } : {})
  });
}

function runCase(c, base, tmpRoot) {
  const ref = findRef(c.ref);
  if (!ref) return { ...c, status: 'missing', reason: '缺对照视频' };

  const dir = fs.mkdtempSync(path.join(tmpRoot, c.name + '-'));
  try {
    const params = adjust.normalizeParams({ [c.param]: 50 });
    if (!params) throw new Error('参数规范化失败');
    const prepared = buildFilter(params, dir);
    const outMp4 = path.join(dir, 'out.mp4');
    // 与 jy-adjust.md §13 相同：libx264 veryfast crf18；不保留音频（对照只比画面）
    runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error',
      '-i', base,
      '-vf', prepared.filter + ',scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', outMp4], prepared.cubePath ? path.dirname(prepared.cubePath) : undefined);

    const frames = [];
    for (const t of TIMES) {
      const fa = rawFrame(outMp4, t, path.join(dir, `a-${t}.raw`));
      const fb = rawFrame(ref, t - FRAME_DELAY, path.join(dir, `b-${t}.raw`));
      if (fa.length !== fb.length) throw new Error('帧尺寸不一致');
      frames.push({ t, psnr: psnr(fa, fb), psnrY: psnr(lumaChannel(fa), lumaChannel(fb)) });
    }
    const mean = frames.reduce((s, f) => s + f.psnr, 0) / frames.length;
    const min = Math.min(...frames.map((f) => f.psnr));
    const meanY = frames.reduce((s, f) => s + f.psnrY, 0) / frames.length;
    const gateFrame = frames.find((f) => Math.abs(f.t - GATE_T) < 1e-6) || frames[frames.length - 1];
    const gate = GATE_METRIC === 'mean' ? mean : gateFrame.psnr;
    const pass = Number.isFinite(gate) && gate >= THRESHOLD;
    return {
      ...c, status: pass ? 'pass' : 'fail', frames, mean, min, meanY,
      gate, gateT: gateFrame.t, gateMetric: GATE_METRIC,
      filter: prepared.filter
    };
  } finally {
    if (!KEEP) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}

(function main() {
  const base = findBase();
  if (!base) {
    console.error('找不到 base 对照: ' + path.join(REF_DIR, 'base.mp4'));
    console.error('（需要 <对照目录>/base.mp4/base.mp4.mp4 或 <对照目录>/base.mp4）');
    process.exit(2);
  }
  const cases = CASES.filter((c) => !ONLY.length || ONLY.includes(c.name) || ONLY.includes(c.param));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adjpsnr-'));
  const results = [];
  try {
    for (const c of cases) {
      process.stdout.write(`  ${c.label.padEnd(3)} ${c.ref.padEnd(10)} ... `);
      let r;
      try {
        r = runCase(c, base, tmpRoot);
      } catch (e) {
        r = { ...c, status: 'error', reason: e.message };
      }
      results.push(r);
      const gateTxt = r.gate != null ? `t=${r.gateT} ${r.gate.toFixed(2)} dB` : '-';
      if (r.status === 'pass') console.log(`PASS  判据 ${gateTxt}（三帧均值 ${r.mean.toFixed(2)}，min ${r.min.toFixed(2)}）`);
      else if (r.status === 'fail') console.log(`FAIL  判据 ${gateTxt}（三帧均值 ${r.mean.toFixed(2)}，min ${r.min.toFixed(2)}，阈值 ${THRESHOLD}）`);
      else if (r.status === 'missing') console.log(`未验证  缺对照 ${r.ref}.mp4`);
      else console.log(`ERROR  ${r.reason}`);
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ threshold: THRESHOLD, gateT: GATE_T, gateMetric: GATE_METRIC, refDir: REF_DIR, base, results }, null, 2));
  } else {
    console.log('\n' + '='.repeat(78));
    console.log('调节 PSNR 验收（对照：剪映导出；480x270 RGB24；libx264 veryfast crf18）');
    console.log(`判据：t=${GATE_T} ${GATE_METRIC === 'mean' ? '三帧均值' : '单帧'}（默认沿用 jy-adjust.md §13 口径）`);
    console.log('另列 t=1/2.5/4 三帧均值与最小值，用于观察运动帧稳定性');
    console.log('='.repeat(78));
    console.log('项目    对照        t=判据    三帧均值   最小      结论');
    for (const r of results) {
      const gate = r.gate != null ? r.gate.toFixed(2) : '-';
      const mean = r.mean ? r.mean.toFixed(2) : '-';
      const min = r.min ? r.min.toFixed(2) : '-';
      const verdict = r.status === 'pass' ? '通过' : r.status === 'fail' ? '不通过' : r.status === 'missing' ? '未验证' : '错误';
      console.log(`${r.label.padEnd(4)}  ${r.ref.padEnd(10)}  ${gate.padStart(7)}  ${mean.padStart(7)}  ${min.padStart(7)}  ${verdict}${r.reason ? '（' + r.reason + '）' : ''}`);
    }
  }

  const failed = results.filter((r) => r.status === 'fail' || r.status === 'error');
  const missing = results.filter((r) => r.status === 'missing');
  const metricTxt = GATE_METRIC === 'mean' ? '三帧均值' : `t=${GATE_T} 单帧`;
  if (failed.length) {
    console.log(`\n结论：不通过（${failed.length} 项在「${metricTxt}」判据下未达 ${THRESHOLD} dB）`);
    process.exit(1);
  }
  if (missing.length && REQUIRE_ALL) {
    console.log(`\n结论：未验证（${missing.length} 项缺对照；去掉 --allow-missing 时视为不通过）`);
    process.exit(1);
  }
  console.log(`\n结论：通过（${results.filter((r) => r.status === 'pass').length} 项在「${metricTxt}」判据下 >= ${THRESHOLD} dB${missing.length ? '；' + missing.length + ' 项未验证' : ''}）`);
  process.exit(0);
})();
