#!/usr/bin/env node
// ==========================================================
// 验收：图片手动调色（src/processors/photoAdjust.js）
// 契约：docs/交接/2026-11-16-出图审图-接口契约.md §3.5 / §4
//
// 零计费、零网络：只用本地 tools/ffmpeg 生成测试图 + 真实渲染，
// 所有调色数值都是 ffmpeg 实测（signalstats 的 YAVG/UAVG/VAVG + rgb24 解码直算 R/G/B 均值）。
//
// 覆盖：
//   [0] 模块导出齐全 + 滤镜串构造（色温正=暖/负=冷；全 0 时无 colorbalance）
//   [1] 四个参数各按正方向应用：文件存在、尺寸不变、字节数 > 0、版本递增
//   [2] 亮度 +50 的 YAVG 明显高于原图、-50 明显低于原图（打印实测值）
//   [3] 色温 +50 的 R 均值相对 B 均值上升、-50 相反（打印实测值）
//   [4] 原图 sha256 / mtime / 字节数全程未变
//   [5] 版本递增且绝不覆盖：连续两次 → _adjust_v1、_adjust_v2 都在，v1 内容不变
//   [6] revertToOriginal 回到原图 hash 与真实尺寸
//   [7] 负向：参数越界/非整数/非数字/全 0 → E_BAD_PARAM；ffmpegPath 不存在 → 抛错；
//       原图不存在 → E_MISSING_FILE；失败不产生正式文件、不留 .tmp 临时文件
//
// 运行：node scripts/verify-photo-adjust.js
// 临时目录：app/data/tmp/verify-photo-adjust-<pid>-<ts>（工作区内、已 gitignore，跑完删除）
// ==========================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const config = require(path.join(APP_DIR, 'config'));
const photoAdjust = require(path.join(APP_DIR, 'src', 'processors', 'photoAdjust'));

const FF = config.FFMPEG_PATH;
const TMP_ROOT = path.join(APP_DIR, 'data', 'tmp', `verify-photo-adjust-${process.pid}-${Date.now()}`);
const BASE_W = 128;
const BASE_H = 96;
// 确定性灰阶梯度（seed 固定，避免 gradients 默认随机导致断言抖动）
const TEST_GRADIENT = `gradients=s=${BASE_W}x${BASE_H}:c0=0x101010:c1=0xf0f0f0:seed=42`;
// 亮度/色温断言的阈值：实测（seed=42）亮度 ±50 → YAVG 137.46→166.08/102.02；
// 色温 ±50 → R-B 0→+11.47/-11.47。阈值取远小于实测幅度，只排除测量噪声。
const MIN_Y_DELTA = 10;
const MIN_RB_DELTA = 5;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

function ffmpeg(args) {
  return spawnSync(FF, ['-nostdin', '-hide_banner', ...args], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------- 测试图（ffmpeg lavfi 真实生成） ----------
function genPng(file, lavfi) {
  const r = ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', file]);
  if (r.status !== 0) throw new Error(`生成测试图失败: ${String(r.stderr || '').slice(0, 300)}`);
  return file;
}

// ---------- 实测 1：YAVG / UAVG / VAVG（signalstats, metadata=print → stderr） ----------
// 说明：ffmpeg 的 metadata=print 输出走 stderr，这里用 spawnSync 捕获（-f null 不落盘）。
function stats(file) {
  const r = ffmpeg(['-i', file, '-vf', 'signalstats,metadata=print', '-f', 'null', '-']);
  if (r.status !== 0) return { error: String(r.stderr || '').slice(0, 300) };
  const text = String(r.stderr || '');
  const pick = (key) => {
    const m = text.match(new RegExp(`${key}=([\\d.]+)`));
    return m ? Number(m[1]) : null;
  };
  return { Y: pick('YAVG'), U: pick('UAVG'), V: pick('VAVG') };
}

// ---------- 实测 2：R/G/B 均值（ffmpeg 解成 rgb24 原始像素后直算） ----------
let rawSeq = 0;
function rgbMean(file) {
  const raw = path.join(TMP_ROOT, `_rgb_${process.pid}_${rawSeq++}.raw`);
  const r = ffmpeg(['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  if (r.status !== 0) return { error: String(r.stderr || '').slice(0, 300) };
  try {
    const buf = fs.readFileSync(raw);
    const n = Math.floor(buf.length / 3);
    if (!n) return { error: `raw 为空: ${buf.length} 字节` };
    let R = 0, G = 0, B = 0;
    for (let i = 0; i < n; i++) {
      R += buf[i * 3]; G += buf[i * 3 + 1]; B += buf[i * 3 + 2];
    }
    const mean = (v) => Math.round((v / n) * 100) / 100;
    return { R: mean(R), G: mean(G), B: mean(B), n };
  } finally {
    try { fs.unlinkSync(raw); } catch (e) { /* ignore */ }
  }
}

// ---------- 独立读 PNG 尺寸（不看模块返回值，自己解析 IHDR） ----------
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24) return null;
    if (head.readUInt32BE(0) !== 0x89504e47) return null;
    if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function expectThrow(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

function tmpDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (e) {
    return [];
  }
}

// ==========================================================
function main() {
  console.log('='.repeat(64));
  console.log('图片手动调色验收（真实 ffmpeg，零计费）');
  console.log(`ffmpeg: ${FF}`);
  console.log(`临时目录: ${TMP_ROOT}`);
  console.log('='.repeat(64));

  if (!FF || !fs.existsSync(FF)) {
    console.error(`找不到 ffmpeg（config.FFMPEG_PATH=${FF || '(空)'}），无法验收`);
    process.exit(1);
  }
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  const original = path.join(TMP_ROOT, 'original.png');
  // 灰阶梯度图（黑→白）：既能让亮度/对比度有层次，又能让 colorbalance 的 rs/bs 生效
  // （纯中灰/纯色图 rs/bs 几乎测不出变化，见模块头注释）。
  // 必须带 seed：gradients 默认每次随机生成，会让断言值不稳定（实测同一命令两次 R-B 17.25 vs 4.57）。
  // seed=42 实测稳定：sha256 三次一致（0c426ece7834…）。
  genPng(original, TEST_GRADIENT);
  const originalHash = sha256(original);
  const originalStat = fs.statSync(original);
  const originalMtime = originalStat.mtimeMs;
  const originalSize = originalStat.size;
  const baseStats = stats(original);
  const baseRgb = rgbMean(original);
  console.log(`原图: ${BASE_W}x${BASE_H}, ${originalSize} 字节, sha256=${originalHash.slice(0, 16)}…`);
  console.log(`原图实测: YAVG=${baseStats.Y} UAVG=${baseStats.U} VAVG=${baseStats.V} | `
    + `R=${baseRgb.R} G=${baseRgb.G} B=${baseRgb.B} R-B=${(baseRgb.R - baseRgb.B).toFixed(2)}`);
  ok('原图可解码且指标可测', Number.isFinite(baseStats.Y) && Number.isFinite(baseRgb.R),
    `YAVG=${baseStats.Y}, R=${baseRgb.R}`);

  // ---------- [0] 导出与滤镜构造 ----------
  section('[0] 模块导出与滤镜串');
  ok('导出 PARAM_RANGES', photoAdjust.PARAM_RANGES
    && photoAdjust.PARAM_RANGES.brightness[0] === -100 && photoAdjust.PARAM_RANGES.brightness[1] === 100);
  ok('导出 4 个函数', ['normalizeParams', 'buildFilter', 'applyToPhoto', 'revertToOriginal']
    .every((k) => typeof photoAdjust[k] === 'function'));

  const fZero = photoAdjust.buildFilter({});
  ok('全 0 滤镜只含 eq（无 colorbalance）',
    fZero.startsWith('eq=') && !fZero.includes('colorbalance'), fZero);
  const fWarm = photoAdjust.buildFilter({ temperature: 50 });
  ok('色温 +50 = 加红减蓝（rs>0, bs<0）',
    /colorbalance=rs=0\.15:bs=-0\.15$/.test(fWarm), fWarm);
  const fCool = photoAdjust.buildFilter({ temperature: -50 });
  ok('色温 -50 = 加蓝减红（rs<0, bs>0）',
    /colorbalance=rs=-0\.15:bs=0\.15$/.test(fCool), fCool);
  const bRight = photoAdjust.buildFilter({ brightness: 100 });
  const bLeft = photoAdjust.buildFilter({ brightness: -100 });
  ok('亮度映射单调（-100 < 0 < +100）',
    /brightness=-0\.3:/.test(bLeft) && /brightness=0:/.test(fZero) && /brightness=0\.3:/.test(bRight),
    `${bLeft} | ${bRight}`);

  // ---------- [1] 四参数正向应用 ----------
  section('[1] 四个参数各按 +50 应用：文件/尺寸/字节数/版本');
  const dirApply = tmpDir('apply');
  const positive = ['brightness', 'contrast', 'saturation', 'temperature'];
  positive.forEach((key, idx) => {
    const params = { [key]: 50 };
    let r = null;
    let err = null;
    try {
      r = photoAdjust.applyToPhoto({
        photo: { id: 'p1' }, params, outDir: dirApply, ffmpegPath: FF, originalPath: original
      });
    } catch (e) {
      err = e;
    }
    ok(`${key}=+50 渲染成功`, !!r && r.ok === true, err ? `异常: ${err.message}` : (r && r.filePath));
    if (!r) return;
    ok(`${key}=+50 文件存在`, fs.existsSync(r.filePath), path.basename(r.filePath));
    const sz = fs.existsSync(r.filePath) ? pngSize(r.filePath) : null;
    ok(`${key}=+50 尺寸不变 ${BASE_W}x${BASE_H}`, !!sz && sz.width === BASE_W && sz.height === BASE_H,
      sz ? `${sz.width}x${sz.height}` : '无法解析');
    const st = fs.existsSync(r.filePath) ? fs.statSync(r.filePath) : null;
    ok(`${key}=+50 字节数 > 0 且与返回一致`,
      !!st && st.size > 0 && r.sizeBytes === st.size, st ? `${st.size} 字节` : '无文件');
    ok(`${key}=+50 版本号递增`, r.version === idx + 1, `v${r.version}（期望 v${idx + 1}）`);
  });

  // ---------- [2] 亮度实测（YAVG） ----------
  section('[2] 亮度 ±50 的 YAVG 实测（signalstats）');
  const dirBright = tmpDir('bright');
  const bUp = photoAdjust.applyToPhoto({
    photo: { id: 'p2' }, params: { brightness: 50 }, outDir: dirBright, ffmpegPath: FF, originalPath: original
  });
  const bDown = photoAdjust.applyToPhoto({
    photo: { id: 'p2' }, params: { brightness: -50 }, outDir: dirBright, ffmpegPath: FF, originalPath: original
  });
  const yUp = stats(bUp.filePath);
  const yDown = stats(bDown.filePath);
  console.log(`  YAVG: 原图=${baseStats.Y} 亮度+50=${yUp.Y} 亮度-50=${yDown.Y}`
    + `（变化 ${(yUp.Y - baseStats.Y).toFixed(2)} / ${(yDown.Y - baseStats.Y).toFixed(2)}）`);
  ok('亮度 +50 的 YAVG 明显高于原图', Number.isFinite(yUp.Y) && yUp.Y > baseStats.Y + MIN_Y_DELTA,
    `${baseStats.Y} → ${yUp.Y}`);
  ok('亮度 -50 的 YAVG 明显低于原图', Number.isFinite(yDown.Y) && yDown.Y < baseStats.Y - MIN_Y_DELTA,
    `${baseStats.Y} → ${yDown.Y}`);

  // ---------- [3] 色温实测（R/B 均值） ----------
  section('[3] 色温 ±50 的 R/B 均值实测（rgb24 解码直算 + signalstats UAVG/VAVG）');
  const dirTemp = tmpDir('temp');
  const tUp = photoAdjust.applyToPhoto({
    photo: { id: 'p3' }, params: { temperature: 50 }, outDir: dirTemp, ffmpegPath: FF, originalPath: original
  });
  const tDown = photoAdjust.applyToPhoto({
    photo: { id: 'p3' }, params: { temperature: -50 }, outDir: dirTemp, ffmpegPath: FF, originalPath: original
  });
  const rgbUp = rgbMean(tUp.filePath);
  const rgbDown = rgbMean(tDown.filePath);
  const stUp = stats(tUp.filePath);
  const stDown = stats(tDown.filePath);
  const rb = (m) => Math.round((m.R - m.B) * 100) / 100;
  console.log(`  原图      : R=${baseRgb.R} B=${baseRgb.B} R-B=${rb(baseRgb).toFixed(2)} | U=${baseStats.U} V=${baseStats.V}`);
  console.log(`  色温 +50  : R=${rgbUp.R} B=${rgbUp.B} R-B=${rb(rgbUp).toFixed(2)} | U=${stUp.U} V=${stUp.V}`);
  console.log(`  色温 -50  : R=${rgbDown.R} B=${rgbDown.B} R-B=${rb(rgbDown).toFixed(2)} | U=${stDown.U} V=${stDown.V}`);
  ok('色温 +50 的 R 均值相对 B 均值上升（更暖）', rb(rgbUp) > rb(baseRgb) + MIN_RB_DELTA,
    `R-B ${rb(baseRgb).toFixed(2)} → ${rb(rgbUp).toFixed(2)}`);
  ok('色温 -50 的 R 均值相对 B 均值下降（更冷）', rb(rgbDown) < rb(baseRgb) - MIN_RB_DELTA,
    `R-B ${rb(baseRgb).toFixed(2)} → ${rb(rgbDown).toFixed(2)}`);
  ok('色温方向在 YUV 侧同向（+50 V>U；-50 V<U）',
    Number.isFinite(stUp.V) && Number.isFinite(stDown.V) && stUp.V > stUp.U && stDown.V < stDown.U,
    `+50 U=${stUp.U}/V=${stUp.V}，-50 U=${stDown.U}/V=${stDown.V}`);

  // ---------- [4] 原图未被修改 ----------
  section('[4] 原图 sha256 / mtime / 字节数未变');
  const afterHash = sha256(original);
  const afterStat = fs.statSync(original);
  ok('原图 sha256 未变', afterHash === originalHash, `${afterHash.slice(0, 16)}…`);
  ok('原图 mtime 未变', afterStat.mtimeMs === originalMtime, `mtimeMs=${afterStat.mtimeMs}`);
  ok('原图字节数未变', afterStat.size === originalSize, `${afterStat.size} 字节`);

  // ---------- [5] 版本递增 + 不覆盖 ----------
  section('[5] 版本递增：连续两次 → _adjust_v1 / _adjust_v2，旧文件不被覆盖');
  const dirVer = tmpDir('version');
  const v1 = photoAdjust.applyToPhoto({
    photo: { id: 'p5' }, params: { brightness: 20 }, outDir: dirVer, ffmpegPath: FF, originalPath: original
  });
  const v1Hash = sha256(v1.filePath);
  const v2 = photoAdjust.applyToPhoto({
    photo: { id: 'p5' }, params: { brightness: 30 }, outDir: dirVer, ffmpegPath: FF, originalPath: original
  });
  const v1Name = path.basename(v1.filePath);
  const v2Name = path.basename(v2.filePath);
  ok('第一次输出 _adjust_v1', v1Name === 'p5_adjust_v1.png', v1Name);
  ok('第二次输出 _adjust_v2', v2Name === 'p5_adjust_v2.png', v2Name);
  ok('v1、v2 两个文件都在', fs.existsSync(v1.filePath) && fs.existsSync(v2.filePath),
    listFiles(dirVer).join(', '));
  ok('v1 内容未被覆盖（sha256 不变）', fs.existsSync(v1.filePath) && sha256(v1.filePath) === v1Hash,
    `sha256 仍为 ${v1Hash.slice(0, 16)}…`);
  ok('v2 内容与 v1 不同', sha256(v2.filePath) !== v1Hash);

  // ---------- [6] revertToOriginal ----------
  section('[6] revertToOriginal 回到原图');
  const photoAfterAdjust = {
    id: 'p5',
    width: BASE_W,
    height: BASE_H,
    adjust: {
      originalPath: original,
      originalWidth: BASE_W,
      originalHeight: BASE_H,
      current: { filePath: v2.filePath, version: 2 }
    }
  };
  let reverted = null;
  let revertErr = null;
  try {
    reverted = photoAdjust.revertToOriginal({ photo: photoAfterAdjust, originalPath: original });
  } catch (e) {
    revertErr = e;
  }
  ok('revertToOriginal 成功', !!reverted && reverted.ok === true, revertErr ? revertErr.message : '');
  if (reverted) {
    ok('回到原图路径', path.resolve(reverted.filePath) === path.resolve(original), reverted.filePath);
    ok('回到原图真实尺寸', reverted.width === BASE_W && reverted.height === BASE_H,
      `${reverted.width}x${reverted.height}`);
    ok('回退后文件 hash = 原图 hash', sha256(reverted.filePath) === originalHash);
    ok('回退返回原图真实字节数（reset 用它还原 photo.sizeBytes）',
      reverted.sizeBytes === originalSize, `${reverted.sizeBytes} 字节（原图 ${originalSize}）`);
  }

  // 原图是 jpg/webp 时也要能读到真实尺寸（reset 走 revertToOriginal，不能只看 PNG）
  for (const ext of ['jpg', 'webp']) {
    const altOriginal = path.join(TMP_ROOT, `original.${ext}`);
    genPng(altOriginal, TEST_GRADIENT);
    let altRevert = null;
    let altErr = null;
    try {
      altRevert = photoAdjust.revertToOriginal({ photo: { id: 'p6' }, originalPath: altOriginal });
    } catch (e) {
      altErr = e;
    }
    ok(`原图为 ${ext} 时 revert 尺寸正确`,
      !!altRevert && altRevert.width === BASE_W && altRevert.height === BASE_H,
      altErr ? altErr.message : `${altRevert && altRevert.width}x${altRevert && altRevert.height}`);
  }

  // ---------- [7] 负向 ----------
  section('[7] 负向：非法参数 / 缺 ffmpeg / 缺原图');
  const badCases = [
    ['亮度 101 越界', () => photoAdjust.normalizeParams({ brightness: 101 })],
    ['色温 -101 越界', () => photoAdjust.normalizeParams({ temperature: -101 })],
    ['对比度 2.5 非整数', () => photoAdjust.normalizeParams({ contrast: 2.5 })],
    ['饱和度 "abc" 非数字', () => photoAdjust.normalizeParams({ saturation: 'abc' })],
    ['参数不是对象', () => photoAdjust.normalizeParams([1, 2, 3])]
  ];
  for (const [name, fn] of badCases) {
    const err = expectThrow(fn);
    ok(`${name} → E_BAD_PARAM`, !!err && err.code === 'E_BAD_PARAM', err ? err.code : '未抛错');
  }

  const dirNeg = tmpDir('negative');
  const zeroErr = expectThrow(() => photoAdjust.applyToPhoto({
    photo: { id: 'p7' }, params: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 },
    outDir: dirNeg, ffmpegPath: FF, originalPath: original
  }));
  ok('四参数全 0 → E_BAD_PARAM（契约 §3.5：全 0 且非 reset → 400）',
    !!zeroErr && zeroErr.code === 'E_BAD_PARAM', zeroErr ? zeroErr.code : '未抛错');
  ok('全 0 失败后没有产生正式文件', listFiles(dirNeg).length === 0, listFiles(dirNeg).join(', ') || '(空)');

  const fakeFfmpeg = path.join(TMP_ROOT, 'no-such-ffmpeg.exe');
  const ffErr = expectThrow(() => photoAdjust.applyToPhoto({
    photo: { id: 'p7' }, params: { brightness: 50 }, outDir: dirNeg,
    ffmpegPath: fakeFfmpeg, originalPath: original
  }));
  ok('ffmpegPath 不存在 → 抛错', !!ffErr, ffErr ? `${ffErr.code}: ${ffErr.message.slice(0, 80)}` : '未抛错');
  ok('缺 ffmpeg 的错误码可识别（E_FFMPEG_NOT_FOUND）',
    !!ffErr && ffErr.code === 'E_FFMPEG_NOT_FOUND', ffErr ? ffErr.code : '未抛错');

  const missingOriginal = path.join(TMP_ROOT, 'missing.png');
  const missErr = expectThrow(() => photoAdjust.applyToPhoto({
    photo: { id: 'p7' }, params: { brightness: 50 }, outDir: dirNeg,
    ffmpegPath: FF, originalPath: missingOriginal
  }));
  ok('原图文件不存在 → E_MISSING_FILE', !!missErr && missErr.code === 'E_MISSING_FILE',
    missErr ? missErr.code : '未抛错');

  const revertMiss = expectThrow(() => photoAdjust.revertToOriginal({
    photo: { id: 'p7' }, originalPath: missingOriginal
  }));
  ok('revert 原图不存在 → E_MISSING_FILE', !!revertMiss && revertMiss.code === 'E_MISSING_FILE',
    revertMiss ? revertMiss.code : '未抛错');

  // ffmpeg 非 0 退出：文件存在但不是可解码图片 → E_FFMPEG + stderr 尾部 ≤400 字，且不留正式文件
  const dirFfFail = tmpDir('ffmpeg-fail');
  const bogus = path.join(TMP_ROOT, 'bogus.png');
  fs.writeFileSync(bogus, Buffer.from('this is definitely not a real png file\n'.repeat(40)));
  const ffFailErr = expectThrow(() => photoAdjust.applyToPhoto({
    photo: { id: 'p7' }, params: { brightness: 50 }, outDir: dirFfFail,
    ffmpegPath: FF, originalPath: bogus
  }));
  ok('坏图（ffmpeg 非 0 退出）→ E_FFMPEG', !!ffFailErr && ffFailErr.code === 'E_FFMPEG',
    ffFailErr ? ffFailErr.code : '未抛错');
  const ffTail = ffFailErr && typeof ffFailErr.stderrTail === 'string' ? ffFailErr.stderrTail : '';
  ok('ffmpeg 失败带 stderr 尾部（1..400 字）', ffTail.length > 0 && ffTail.length <= 400,
    `${ffTail.length} 字: ${ffTail.slice(0, 60)}…`);
  ok('ffmpeg 失败不产生正式 PNG', listFiles(dirFfFail).filter((n) => n.endsWith('.png')).length === 0,
    listFiles(dirFfFail).join(', ') || '(空)');

  // 负向路径不得留下 .tmp 临时文件
  const leaked = listFiles(dirNeg).filter((n) => n.includes('.tmp-'));
  ok('负向失败不留 .tmp 临时文件', leaked.length === 0, leaked.join(', ') || '(无)');
  const allTmpFiles = [];
  for (const dir of listFiles(TMP_ROOT)) {
    const full = path.join(TMP_ROOT, dir);
    try {
      if (fs.statSync(full).isDirectory()) {
        for (const n of fs.readdirSync(full)) if (n.includes('.tmp-')) allTmpFiles.push(path.join(dir, n));
      }
    } catch (e) { /* ignore */ }
  }
  ok('所有输出目录无 .tmp 残留', allTmpFiles.length === 0, allTmpFiles.join(', ') || '(无)');

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('='.repeat(64));
  return fail ? 1 : 0;
}

let code = 1;
try {
  code = main();
} catch (e) {
  console.error('\n异常中断:', e && e.stack || e);
  code = 1;
} finally {
  // 自清理：临时目录（含测试图、调色产物、raw 中间文件）全部删掉
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {
    console.error(`清理临时目录失败: ${TMP_ROOT}（可手工删除）`);
  }
}
process.exit(code);
