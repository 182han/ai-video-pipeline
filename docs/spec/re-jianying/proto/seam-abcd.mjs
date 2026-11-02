// ============================================================
// seam-abcd.mjs —— 接缝自然度 A/B/C/D 对照实验
// ------------------------------------------------------------
// 目的：验证「换转场曲线」vs「接缝前做亮度/色度匹配」哪个更有效。
// A 硬切 / B 线性叠化 / C 缓入缓出叠化(smoothstep) / D 亮度色度匹配 + 线性叠化
//
// 度量直接复用 app/src/qualityChecker.checkSeam（与线上质检同口径）：
//   SSIM（跨缝帧对）、ΔE76、ΔY、MAD 倍数
//
// 约束：只读源片段；所有产物落在 app/output/verify_seam_abcd/；ffmpeg 用 stdio 文件重定向
//       （本机沙箱禁止管道捕获，见 AGENTS §2.3）。
// ============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');   // 工作区根
const APP = path.join(ROOT, 'app');
const require_ = createRequire(path.join(APP, 'package.json'));

const cfg = require_(path.join(APP, 'config.js'));
const FFMPEG = cfg.FFMPEG_PATH;
const QC = require_(path.join(APP, 'src', 'qualityChecker.js'));

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const SUFFIX = argOf('--tag') || 'pair1';
const OUT = path.join(APP, 'output', 'verify_seam_abcd', SUFFIX);
fs.mkdirSync(OUT, { recursive: true });

const CLIP_A = path.resolve(argOf('--a') || path.join(APP, 'clips', 'task_mv4v7qp2_m8r0_clip_1.mp4'));
const CLIP_B = path.resolve(argOf('--b') || path.join(APP, 'clips', 'task_mv4v7qp2_m8r0_clip_3.mp4'));
const SEG = 3.0;      // 每段取 3 秒
const FADE = 0.4;     // 转场时长
const W = 1280, H = 720, FPS = 30;

let logSeq = 0;
function run(args, tag) {
  const log = path.join(OUT, `_ff_${tag}_${logSeq++}.log`);
  const fd = fs.openSync(log, 'w');
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', fd], windowsHide: true });
    p.on('error', (e) => { try { fs.closeSync(fd); } catch {} reject(e); });
    p.on('close', (code) => {
      try { fs.closeSync(fd); } catch {}
      if (code !== 0) {
        let tail = '';
        try { tail = fs.readFileSync(log, 'utf8').slice(-1200); } catch {}
        reject(new Error(`ffmpeg(${tag}) exit ${code}\n${tail}`));
      } else resolve();
    });
  });
}

/** 统一规格切出一段：1280x720 / 30fps / yuv420p / 无音轨 */
async function makeSeg(src, out, tag) {
  await run(['-y', '-hide_banner', '-loglevel', 'error',
    '-i', src, '-t', String(SEG), '-an',
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out], tag);
}

/** 取一帧缩略的原始 RGB / YUV 均值（落文件读，不用管道） */
async function frameMeans(video, tag) {
  const raw = path.join(OUT, `_mean_${tag}.raw`);
  // YUV420p：先取亮度与色度
  await run(['-y', '-hide_banner', '-loglevel', 'error',
    '-i', video, '-frames:v', '1', '-vf', 'scale=64:36', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', raw], tag + '_yuv');
  const buf = fs.readFileSync(raw);
  const n = 64 * 36;
  let y = 0, u = 0, v = 0;
  for (let i = 0; i < n; i++) y += buf[i];
  const uOff = n, vOff = n + (n / 4);
  for (let i = 0; i < n / 4; i++) { u += buf[uOff + i]; v += buf[vOff + i]; }
  fs.unlinkSync(raw);
  return { Y: y / n, U: u / (n / 4), V: v / (n / 4) };
}

/** 多帧 RGB 逐通道均值/标准差（用于 Reinhard 式匹配） */
async function rgbStats(video, tag, samples = 5) {
  const dims = { w: 64, h: 36 };
  const per = [];
  for (let i = 0; i < samples; i++) {
    const t = (SEG * (i + 0.5)) / samples;
    const raw = path.join(OUT, `_rgb_${tag}_${i}.raw`);
    await run(['-y', '-hide_banner', '-loglevel', 'error',
      '-ss', t.toFixed(3), '-i', video, '-frames:v', '1',
      '-vf', `scale=${dims.w}:${dims.h}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw], `${tag}_rgb${i}`);
    const buf = fs.readFileSync(raw);
    fs.unlinkSync(raw);
    per.push(buf);
  }
  const n = dims.w * dims.h;
  const mean = [0, 0, 0];
  const sd = [0, 0, 0];
  for (const buf of per) {
    for (let p = 0; p < n; p++) {
      for (let c = 0; c < 3; c++) mean[c] += buf[p * 3 + c];
    }
  }
  for (let c = 0; c < 3; c++) mean[c] /= (n * per.length);
  for (const buf of per) {
    for (let p = 0; p < n; p++) {
      for (let c = 0; c < 3; c++) {
        const d = buf[p * 3 + c] - mean[c];
        sd[c] += d * d;
      }
    }
  }
  for (let c = 0; c < 3; c++) sd[c] = Math.sqrt(sd[c] / (n * per.length)) || 1;
  return { mean, sd };
}

async function build() {
  const segA = path.join(OUT, 'segA.mp4');
  const segB = path.join(OUT, 'segB.mp4');
  await makeSeg(CLIP_A, segA, 'segA');
  await makeSeg(CLIP_B, segB, 'segB');

  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];

  // A：硬切
  const A = path.join(OUT, 'A_hard.mp4');
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', segA, '-i', segB,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', ...enc, A], 'A');

  // B：线性叠化（xfade=fade）
  const B = path.join(OUT, 'B_linear.mp4');
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', segA, '-i', segB,
    '-filter_complex', `[0:v][1:v]xfade=transition=fade:duration=${FADE}:offset=${SEG - FADE}[v]`,
    '-map', '[v]', ...enc, B], 'B');

  // C：缓入缓出叠化（smoothstep 权重），手工拼 head + 混合段 + tail
  const C = path.join(OUT, 'C_smoothstep.mp4');
  const P = `clip((T/${FADE})*(T/${FADE})*(3-2*(T/${FADE})),0,1)`;
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', segA, '-i', segB,
    '-filter_complex',
    [
      `[0:v]trim=0:${SEG - FADE},setpts=PTS-STARTPTS[head]`,
      `[0:v]trim=${SEG - FADE}:${SEG},setpts=PTS-STARTPTS[a]`,
      `[1:v]trim=0:${FADE},setpts=PTS-STARTPTS[b]`,
      `[a][b]blend=all_expr='A*(1-${P})+B*${P}'[mix]`,
      `[1:v]trim=${FADE}:${SEG},setpts=PTS-STARTPTS[tail]`,
      `[head][mix][tail]concat=n=3:v=1:a=0[v]`,
    ].join(';'),
    '-map', '[v]', ...enc, C], 'C');

  // D：先按 segA 的画面统计校正 segB，再做线性叠化
  const mA = await frameMeans(segA, 'A');
  const mB = await frameMeans(segB, 'B');
  // eq.brightness 的量纲是 [-1,1] 的归一化偏移；Y 是 0..255
  const dBright = (mA.Y - mB.Y) / 255;
  // colorbalance 的 rs/gs/bs 作用于暗部，粗略按色度差给一个小系数
  const dU = (mA.U - mB.U) / 255;
  const dV = (mA.V - mB.V) / 255;
  const rs = Math.max(-0.5, Math.min(0.5, dV * 0.8));
  const gs = Math.max(-0.5, Math.min(0.5, -dU * 0.5));
  const bs = Math.max(-0.5, Math.min(0.5, dU * 0.8));
  const segB2 = path.join(OUT, 'segB_matched.mp4');
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', segB,
    '-vf', `eq=brightness=${dBright.toFixed(4)},colorbalance=rs=${rs.toFixed(4)}:gs=${gs.toFixed(4)}:bs=${bs.toFixed(4)}`,
    ...enc, segB2], 'B2');
  const mB2 = await frameMeans(segB2, 'B2');

  const D = path.join(OUT, 'D_matched_linear.mp4');
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', segA, '-i', segB2,
    '-filter_complex', `[0:v][1:v]xfade=transition=fade:duration=${FADE}:offset=${SEG - FADE}[v]`,
    '-map', '[v]', ...enc, D], 'D');

  // D2：逐通道均值/方差匹配（Reinhard 式）后再线性叠化 —— 比 eq/colorbalance 更接近真正的校色
  const sA = await rgbStats(segA, 'A');
  const sB = await rgbStats(segB, 'B');
  const gain = [0, 1, 2].map((c) => sA.sd[c] / sB.sd[c]);
  const off = [0, 1, 2].map((c) => sA.mean[c] - gain[c] * sB.mean[c]);
  const lut = `lutrgb=r='val*${gain[0].toFixed(4)}+${off[0].toFixed(2)}':` +
              `g='val*${gain[1].toFixed(4)}+${off[1].toFixed(2)}':` +
              `b='val*${gain[2].toFixed(4)}+${off[2].toFixed(2)}'`;
  const segB3 = path.join(OUT, 'segB_reinhard.mp4');
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', segB, '-vf', lut, ...enc, segB3], 'B3');
  const D2 = path.join(OUT, 'D2_reinhard_linear.mp4');
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-i', segA, '-i', segB3,
    '-filter_complex', `[0:v][1:v]xfade=transition=fade:duration=${FADE}:offset=${SEG - FADE}[v]`,
    '-map', '[v]', ...enc, D2], 'D2');
  const mB3 = await frameMeans(segB3, 'B3');

  return { segA, segB, variants: [
    { key: 'A', name: '硬切', file: A, fade: 0 },
    { key: 'B', name: '线性叠化', file: B, fade: FADE },
    { key: 'C', name: '缓入缓出叠化', file: C, fade: FADE },
    { key: 'D', name: 'eq校色+线性叠化', file: D, fade: FADE },
    { key: 'D2', name: '逐通道均值方差匹配+线性叠化', file: D2, fade: FADE },
  ], stats: { mA, mB, mB2, mB3, dBright, rs, gs, bs, gain, off } };
}

async function main() {
  if (!fs.existsSync(CLIP_A) || !fs.existsSync(CLIP_B)) {
    console.error('源片段不存在:', CLIP_A, CLIP_B);
    process.exit(2);
  }
  console.log('ffmpeg :', FFMPEG);
  console.log('输出   :', OUT);
  const { variants, stats } = await build();

  console.log('\n=== 镜头级失配（转场之前就先被眼睛看到的差）===');
  const f = (x) => Number(x).toFixed(2);
  const dE = (a, b) => {
    try { return QC._deltaE76FromYuv(a, b); } catch { return null; }
  };
  const shot = (label, m) => {
    const de = dE(stats.mA, m);
    console.log(`| ${label} | ${f(m.Y)} | ${f(m.U)} | ${f(m.V)} | ${f(m.Y - stats.mA.Y)} | ${de != null ? de.toFixed(2) : '-'} |`);
  };
  console.log('| 段 | 平均Y | 平均U | 平均V | ΔY(相对A) | ΔE76(相对A) |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  shot('A 段（基准）', stats.mA);
  shot('B 段（原样）', stats.mB);
  shot('B 段（eq 校色）', stats.mB2);
  shot('B 段（逐通道匹配）', stats.mB3);
  console.log(`\n校正参数  : eq.brightness=${f(stats.dBright)} colorbalance rs=${f(stats.rs)} gs=${f(stats.gs)} bs=${f(stats.bs)}`);
  console.log(`Reinhard  : gain=${stats.gain.map(f).join('/')} offset=${stats.off.map(f).join('/')}`);

  console.log('\n=== 接缝指标（qualityChecker.checkSeam 同口径）===');
  console.log('| 组 | 处理 | t | SSIM | 基线SSIM | ΔE76 | ΔY | MAD× | 通过 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const rows = [];
  for (const v of variants) {
    let r;
    try {
      r = await QC.checkSeam(v.file, [SEG, SEG], { fadeDuration: v.fade });
    } catch (e) {
      console.log(`| ${v.key} | ${v.name} | - | 测量失败: ${e.message} | | | | | |`);
      continue;
    }
    const s = (r.details && r.details.seams && r.details.seams[0]) || (r.seams && r.seams[0]) || null;
    if (!s) {
      console.log(`| ${v.key} | ${v.name} | - | 无接缝数据：${r.reason || 'unknown'} | | | | | |`);
      continue;
    }
    rows.push({ ...v, s, passed: r.passed });
    console.log(`| ${v.key} | ${v.name} | ${s.t} | ${f(s.ssim)} | ${f(s.baseSsim)} | ${s.de76 ?? '-'} | ${s.dy ?? '-'} | ${s.madRatio ?? '-'} | ${r.passed ? '✅' : '❌'} |`);
  }

  console.log('\n=== 判定（相对 A 的提升）===');
  const base = rows.find((x) => x.key === 'A');
  for (const x of rows) {
    if (x.key === 'A') continue;
    const dSsim = base ? (x.s.ssim - base.s.ssim) : null;
    const dDe = (x.s.de76 != null && base && base.s.de76 != null) ? (x.s.de76 - base.s.de76) : null;
    const dDy = (x.s.dy != null && base && base.s.dy != null) ? (Math.abs(x.s.dy) - Math.abs(base.s.dy)) : null;
    console.log(`${x.key} ${x.name}: SSIM ${dSsim >= 0 ? '+' : ''}${dSsim?.toFixed(3)}  ΔE76 ${dDe != null ? (dDe >= 0 ? '+' : '') + dDe.toFixed(2) : '-'}  |ΔY| ${dDy != null ? (dDy >= 0 ? '+' : '') + dDy.toFixed(2) : '-'}`);
  }
  console.log('\n产物目录：' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
