#!/usr/bin/env node
// ==========================================
// 接缝质量量化分析 —— scripts/analyze-seams.js
// ==========================================
//
// 用途：对已有成片做「逐缝」量化分析，回答「衔接到底哪里不自然」。
//
// 为什么会存在这个脚本：
//   qualityChecker.checkConcat() 只校验「时长没被截断」，**不读画面**；
//   qualityChecker.checkLoop() 只测「成片末尾 vs 开头」的 SSIM，不测片段之间的缝。
//   即现有 11 个质检项**没有任何一项**在测「拼接是否自然」。
//   所以用户说「衔接不够自然」时，代码里查不到任何数值依据 —— 先把它测出来。
//
// 度量全部由 ffmpeg 算出，不引入任何新依赖（AGENTS.md §4.6）：
//   1) ssim 滤镜（两路同源视频错位一帧）→ 逐帧对 SSIM
//   2) signalstats + metadata=print → 逐帧 YAVG / UAVG / VAVG（亮度与色度）
//   3) 由 Y/U/V 均值换算 YUV→RGB，给出 RGB 欧氏距离与 ΔE76（见下方说明）
//
// 关于「色调差」用的是什么度量（任务要求写清）：
//   - 主度量：**ΔE76**（CIE1976 L*a*b* 欧氏距离，sRGB → XYZ(D65) → Lab 标准换算）
//     ΔE76 是「人眼可感知色差」的经典近似，>2.3 即为「一眼能看出」的临界（行业经验值）。
//   - 辅度量：RGB 空间欧氏距离（0~441.7）与逐通道差（R/G/B、Y/U/V）。
//   两者都给，因为 ΔE 更接近人眼，RGB 距离更易与阈值直接挂钩。
//
// 安全约束（AGENTS.md §4.7）：
//   本脚本**只读**视频文件，不写入、不覆盖任何成片。
//   中间文件一律落系统临时目录；报告默认写 app/data/reports/。
//
// 用法：
//   node scripts/analyze-seams.js --video output/xxx_concat.mp4 --task task_xxx
//   node scripts/analyze-seams.js --video output/a.mp4 --video output/b.mp4
//   node scripts/analyze-seams.js --video output/a.mp4 --seams 6.0,12.5,18.0
//   node scripts/analyze-seams.js --video output/a.mp4 --out data/reports
//
// 退出码：0 = 分析完成（不代表「通过」，只代表测到了数据）
//         1 = 参数错误 / 探测不到时长等「不可判定」
//         2 = 无 ffmpeg
// ==========================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const config = require(path.join(APP_ROOT, 'config'));

const FFMPEG = config.FFMPEG_PATH;
const FFPROBE = config.FFPROBE_PATH;

// ---------- 小工具 ----------

function log(...a) { console.log(...a); }
function die(msg, code = 1) { console.error('❌ ' + msg); process.exit(code); }

function parseArgs(argv) {
  const out = { videos: [], seams: null, tasks: [], outDir: null, window: null, montage: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--video' || a === '-v') out.videos.push(next());
    else if (a === '--seams') out.seams = String(next()).split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n));
    // --task 可以重复给，按出现顺序与 --video 一一对应；
    // 不给时自动从文件名推断（task_xxx_concat.mp4 → task_xxx）
    else if (a === '--task') out.tasks.push(next());
    else if (a === '--out') out.outDir = next();
    else if (a === '--window') out.window = parseFloat(next());
    else if (a === '--montage') out.montage = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else die(`未知参数: ${a}`);
  }
  return out;
}

// 从文件名推断 taskId：output/task_abc123_concat.mp4 → task_abc123
// 做法是「拿目录里真实存在的任务 id 去前缀匹配」，而不是用正则猜后缀 ——
// task id 本身含下划线（task_mvhlxnm7_1mch），正则 `task_[a-z0-9]+` 会在
// 第一个下划线处截断（实测踩过：推断出 task_mvhlxnm7，文件不存在）。
function inferTaskIdFromPath(p) {
  const base = path.basename(p);
  const dir = path.join(APP_ROOT, 'data', 'tasks');
  let ids = [];
  try {
    ids = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  } catch (e) { return null; }
  // 取最长匹配，避免歧义
  const hits = ids.filter(id => base.startsWith(id + '_')).sort((a, b) => b.length - a.length);
  return hits.length ? hits[0] : null;
}

// ffmpeg 执行：**不捕获 stdout**（本机 execSync 捕获 stdout 会 EPERM，见 AGENTS.md §2.3）。
// 需要读文本时一律让它写文件再读文件。
// ffmpeg / ffprobe 执行：**绝不捕获 stdout**。
// 本机 execSync 带 `encoding:'utf8'`（即捕获 stdout）会报
// `spawnSync C:\Windows\system32\cmd.exe EPERM`（AGENTS.md §2.3）。
// 因此统一走「shell 重定向到临时文件，stdio:'ignore'，再读文件」——
// 与 src/videoProcessor.js:690 `_execText()` 的既有降级路径同一套路。
function execToFile(cmd, { timeout = 10 * 60 * 1000, cwd = null } = {}) {
  const tmp = path.join(os.tmpdir(), `seam_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore', timeout, windowsHide: true, cwd: cwd || APP_ROOT });
  } catch (e) {
    // 命令非 0 退出也可能有有用输出，继续读文件
  }
  let text = '';
  try { text = fs.readFileSync(tmp, 'utf8'); } catch (e) {}
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
  return text;
}

// 拼 shell 命令时给路径加引号（Windows 路径含空格与中文）
function q(p) { return `"${p}"`; }

function runFF(args, { timeout = 10 * 60 * 1000, cwd = null } = {}) {
  const cmd = `${q(FFMPEG)} ${args.map(a => (/\s/.test(a) ? q(a) : a)).join(' ')}`;
  const out = execToFile(cmd, { timeout, cwd });
  return { ok: true, stderr: out };
}

// ffprobe 的 JSON 输出必须读 stdout —— 走 execToFile 重定向
function ffprobeJson(file, args) {
  const cmd = `${q(FFPROBE)} -v error ${args.join(' ')} -of json ${q(file)}`;
  const text = execToFile(cmd, { timeout: 60000 });
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function probeVideo(file) {
  const j = ffprobeJson(file, [
    '-show_entries',
    'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration'
  ]);
  if (!j) return null;
  const vs = (j.streams || []).find(s => s.codec_type === 'video');
  if (!vs) return null;
  const parseRate = (r) => {
    if (!r || typeof r !== 'string') return null;
    const [n, d] = r.split('/').map(Number);
    if (!d) return null;
    const v = n / d;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const fps = parseRate(vs.avg_frame_rate) || parseRate(vs.r_frame_rate);
  const dur = Number(j.format && j.format.duration);
  return {
    file,
    duration: Number.isFinite(dur) ? dur : (vs.duration ? Number(vs.duration) : null),
    width: vs.width || null,
    height: vs.height || null,
    fps,
    codec: vs.codec_name || null,
    sizeBytes: Number(j.format && j.format.size) || null,
    bitRate: Number(j.format && j.format.bit_rate) || null,
    hasAudio: (j.streams || []).some(s => s.codec_type === 'audio')
  };
}

// ---------- 色彩换算：YUV(limited/full) → RGB → XYZ → Lab ----------
//
// signalstats 给的是 Y/U/V **有限范围**数字（Y 16~235，UV 16~240，mid=128）。
// 这里按有限范围（TV range）换算，若源是 full range 会有整体偏移，
// 但**同一视频内所有帧偏移一致**，做差值时相互抵消 —— 不影响接缝判定。
function yuvToRgb(Y, U, V) {
  const y = (Y - 16) / 219;
  const u = (U - 128) / 224;
  const v = (V - 128) / 224;
  // BT.709（HD 常用；BT.601 与 709 在小差值上差异远小于阈值）
  const r = y + 1.5748 * v;
  const g = y - 0.1873 * u - 0.4681 * v;
  const b = y + 1.8556 * u;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab({ r, g, b }) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  // sRGB → XYZ (D65)
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116);
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function deltaE76(lab1, lab2) {
  return Math.sqrt(
    Math.pow(lab1.L - lab2.L, 2) +
    Math.pow(lab1.a - lab2.a, 2) +
    Math.pow(lab1.b - lab2.b, 2)
  );
}

function rgbDistance(c1, c2) {
  const d = Math.sqrt(
    Math.pow((c1.r - c2.r) * 255, 2) +
    Math.pow((c1.g - c2.g) * 255, 2) +
    Math.pow((c1.b - c2.b) * 255, 2)
  );
  return d;
}

// ---------- 单窗口测量 ----------
//
// 对 [t-window, t+window] 这一段做两件事：
//   A) 逐帧 signalstats → 每帧 Y/U/V 均值
//   B) 两路同源错位一帧做 ssim → 每相邻帧对的 SSIM
// 一次 ffmpeg 调用各干一件事，中间文件落临时目录。

function measureWindow(video, centerT, windowSec) {
  const start = Math.max(0, centerT - windowSec);
  const dur = windowSec * 2;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamwin_'));
  const statsFile = path.join(tmpDir, 'stats.txt');
  const ssimFile = path.join(tmpDir, 'ssim.txt');

  try {
    // A) 逐帧 Y/U/V 均值（signalstats 的 YAVG/UAVG/VAVG）
    //    输出文件用**相对文件名**：ffmpeg 的 filter 选项里 `:` 与 `\` 是转义字符，
    //    直接塞 Windows 绝对路径会把 `C:\` 吃掉（实测踩过）。cwd 指到临时目录即可。
    runFF([
      '-hide_banner', '-nostats', '-loglevel', 'error',
      '-ss', String(start), '-t', String(dur),
      '-i', video,
      '-an', '-vf', 'signalstats,metadata=mode=print:file=stats.txt',
      '-f', 'null', '-'
    ], { cwd: tmpDir });

    // B) 相邻帧 SSIM：同一输入开两路，同样 seek，第二路 trim 掉首帧
    //    两路逐帧对齐成「第 i 帧 vs 第 i+1 帧」，一次调用得到整窗逐帧 SSIM
    runFF([
      '-hide_banner', '-nostats', '-loglevel', 'error',
      '-ss', String(start), '-t', String(dur), '-i', video,
      '-ss', String(start), '-t', String(dur), '-i', video,
      '-filter_complex',
      '[0:v]setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[b];'
      + '[a][b]ssim=stats_file=ssim.txt:shortest=1',
      '-an', '-f', 'null', '-'
    ], { cwd: tmpDir });

    // C) 逐帧**像素级**平均绝对差（MAD）：两路对齐后做 blend=difference 再 signalstats。
    //    为什么必须要它：单看「两帧平均亮度之差」会漏掉「平均亮度相同但画面完全不同」
    //    的情况（星空 avg Y≈40 与森林 avg Y≈40 可以相等）。MAD 是逐像素差，
    //    能同时反映「景物不同」与「局部明暗不同」，也是历史记录里
    //    「逐帧亮度差 46.5」那个数字的真实来源口径。
    runFF([
      '-hide_banner', '-nostats', '-loglevel', 'error',
      '-ss', String(start), '-t', String(dur), '-i', video,
      '-ss', String(start), '-t', String(dur), '-i', video,
      '-filter_complex',
      '[0:v]setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[b];'
      + '[a][b]blend=all_mode=difference,signalstats,metadata=mode=print:file=diff.txt',
      '-an', '-f', 'null', '-'
    ], { cwd: tmpDir });

    const frames = parseSignalStats(statsFile, start);
    const ssimPairs = parseSsimStats(ssimFile);
    const diffFrames = parseSignalStats(path.join(tmpDir, 'diff.txt'), start);
    if (process.env.SEAM_DEBUG) {
      console.log(`      [dbg] frames=${frames.length} ssimpairs=${ssimPairs.length} diffframes=${diffFrames.length}`
        + ` diffY[0..4]=${diffFrames.slice(0, 5).map(f => f.Y.toFixed(2)).join(',')}`
        + ` diffYmax=${diffFrames.length ? Math.max(...diffFrames.map(f => f.Y)).toFixed(2) : 'n/a'}`);
    }
    return { ok: frames.length > 0, frames, ssimPairs, diffFrames, start, tmpDir, stderrA: '', stderrB: '' };
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, frames: [], ssimPairs: [], error: e.message };
  }
}

// metadata=mode=print 的输出形如：
//   frame:0    pts:0       pts_time:6
//   lavfi.signalstats.YAVG=120.345
//   lavfi.signalstats.UAVG=127.1
//   ...
function parseSignalStats(file, startT) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const frames = [];
  let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('frame:')) {
      if (cur) frames.push(cur);
      const m = line.match(/pts_time:([\d.\-]+)/);
      cur = { index: frames.length, ptsTime: m ? parseFloat(m[1]) : (startT + frames.length * 0.04) };
      continue;
    }
    const kv = line.match(/lavfi\.signalstats\.(YAVG|UAVG|VAVG|YDIF|SATAVG|HUEAVG)=([\d.\-]+)/);
    if (kv && cur) {
      const key = kv[1];
      const val = parseFloat(kv[2]);
      if (key === 'YAVG') cur.Y = val;
      else if (key === 'UAVG') cur.U = val;
      else if (key === 'VAVG') cur.V = val;
      else if (key === 'YDIF') cur.YDIF = val;
      else if (key === 'SATAVG') cur.sat = val;
      else if (key === 'HUEAVG') cur.hue = val;
    }
  }
  if (cur) frames.push(cur);
  return frames.filter(f => Number.isFinite(f.Y) && Number.isFinite(f.U) && Number.isFinite(f.V));
}

// ssim stats_file 每行形如：
//   n:1 Y:0.998425 U:0.999 V:0.999 All:0.998609 (12.3)
function parseSsimStats(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.startsWith('n:')) continue;
    const all = line.match(/All:([\d.]+)/);
    const y = line.match(/\bY:([\d.]+)/);
    const u = line.match(/\bU:([\d.]+)/);
    const v = line.match(/\bV:([\d.]+)/);
    if (!all) continue;
    out.push({
      n: parseInt((line.match(/n:(\d+)/) || [])[1], 10) || out.length + 1,
      all: parseFloat(all[1]),
      y: y ? parseFloat(y[1]) : null,
      u: u ? parseFloat(u[1]) : null,
      v: v ? parseFloat(v[1]) : null
    });
  }
  return out;
}

// ---------- 判定：硬切 还是 淡化 ----------
//
// 原理：
//   - 硬切 → 相邻帧对里**存在一对** SSIM 断崖（通常 0.2~0.6），其余正常；
//   - 淡化 → 跨缝的多帧 SSIM 呈**平滑下滑再回升**，没有断崖，
//     但会出现「中间帧 SSIM 低」，且中间帧的 Y/U/V 是两个片段的**混合值**。
// 因此判定看两件事：①最小 SSIM 出现在单帧对上（断崖） ②低谷宽度（持续多少帧）。
function classifySeamType(frames, ssimPairs, opts = {}) {
  const cutSsimThreshold = opts.cutSsimThreshold ?? 0.75; // 单帧对低于此值视为断崖
  if (!ssimPairs.length) return { type: 'undetermined', reason: '没有 SSIM 数据' };

  const vals = ssimPairs.map(s => s.all).filter(Number.isFinite);
  if (!vals.length) return { type: 'undetermined', reason: 'SSIM 全为空' };

  const minSsim = Math.min(...vals);
  const minIdx = vals.indexOf(minSsim);
  // 连续低于阈值的帧对数 = 「低谷宽度」
  let dipWidth = 0, curWidth = 0;
  for (const v of vals) {
    if (v < cutSsimThreshold) { curWidth++; dipWidth = Math.max(dipWidth, curWidth); }
    else curWidth = 0;
  }
  // 断崖程度：最小值的相邻两帧是否有陡变（用前后两对的平均 - 最小值的落差）
  const nbrs = [];
  if (minIdx > 0) nbrs.push(vals[minIdx - 1]);
  if (minIdx < vals.length - 1) nbrs.push(vals[minIdx + 1]);
  const nbrAvg = nbrs.length ? nbrs.reduce((a, b) => a + b, 0) / nbrs.length : minSsim;
  const cliffDrop = nbrAvg - minSsim;

  let type;
  if (minSsim < cutSsimThreshold && dipWidth <= 2 && cliffDrop > 0.15) {
    type = 'hardcut';           // 单帧断崖 → 硬切
  } else if (dipWidth >= 3) {
    type = 'dissolve';          // 多帧低谷 → 淡化/混合
  } else if (minSsim < cutSsimThreshold) {
    type = 'hardcut-likely';
  } else {
    type = 'continuous';        // 缝处几乎无变化（可能是同源连续画面，或缝不在该位置）
  }

  return {
    type, minSsim, dipWidth, cliffDrop: Number(cliffDrop.toFixed(4)),
    minAtPairIndex: minIdx,
    ssimSeries: vals.map(v => Number(v.toFixed(4)))
  };
}

// ---------- 接缝两侧对比指标 ----------
//
// 用「低谷前最后一帧」与「低谷后第一帧」作为 A 段末帧 / B 段首帧。
function crossSeamMetrics(frames, ssimPairs, seamIndex, opts = {}) {
  if (frames.length < 2) return null;
  // 找到 A 侧 / B 侧的代表帧：以 SSIM 低谷为中心的左右各取 1 帧
  const mi = Math.max(0, Math.min(frames.length - 2, seamIndex));
  const a = frames[mi];
  const b = frames[Math.min(frames.length - 1, mi + 1)];
  const rgbA = yuvToRgb(a.Y, a.U, a.V);
  const rgbB = yuvToRgb(b.Y, b.U, b.V);
  const labA = rgbToLab(rgbA), labB = rgbToLab(rgbB);

  // 窗口内的「同段内基线」：取窗口两端相邻帧对（远离缝）作为自然变化参照
  const baselinePairs = ssimPairs.length >= 4
    ? [ssimPairs[0].all, ssimPairs[ssimPairs.length - 1].all]
    : [];
  const baselineSsim = baselinePairs.length
    ? baselinePairs.reduce((x, y) => x + y, 0) / baselinePairs.length
    : null;

  return {
    tA: a.ptsTime, tB: b.ptsTime,
    Y_A: Number(a.Y.toFixed(2)), Y_B: Number(b.Y.toFixed(2)),
    dY: Number((b.Y - a.Y).toFixed(2)),
    dU: Number((b.U - a.U).toFixed(2)),
    dV: Number((b.V - a.V).toFixed(2)),
    rgbA, rgbB,
    dRGB: Number(rgbDistance(rgbA, rgbB).toFixed(2)),
    dR: Number(((rgbB.r - rgbA.r) * 255).toFixed(2)),
    dG: Number(((rgbB.g - rgbA.g) * 255).toFixed(2)),
    dB: Number(((rgbB.b - rgbA.b) * 255).toFixed(2)),
    dE76: Number(deltaE76(labA, labB).toFixed(2)),
    baselineSsim: baselineSsim ? Number(baselineSsim.toFixed(4)) : null
  };
}

// ---------- 峰值亮度差 ----------
//
// 「平均亮度差」之外还要「峰值亮度差」：用 signalstats 的 YMAX/YMIN 太粗，
// 这里用 window 内每帧 YAVG 的极差近似「整段内的亮度动态」，并给出
// 缝两侧各自窗口内的 YAVG 最大差，作为「有没有突然变亮/变暗」的指标。
function brightnessPeak(frames, seamIdx) {
  if (frames.length < 3) return null;
  const ys = frames.map(f => f.Y);
  const before = ys.slice(0, seamIdx + 1);
  const after = ys.slice(seamIdx + 1);
  const range = (arr) => arr.length ? Math.max(...arr) - Math.min(...arr) : null;
  return {
    windowYRange: range(ys) === null ? null : Number(range(ys).toFixed(2)),
    beforeYRange: range(before) === null ? null : Number(range(before).toFixed(2)),
    afterYRange: range(after) === null ? null : Number(range(after).toFixed(2)),
    beforeYMax: before.length ? Number(Math.max(...before).toFixed(2)) : null,
    afterYMax: after.length ? Number(Math.max(...after).toFixed(2)) : null
  };
}

// ---------- 像素级差（MAD）与接缝能量（SE） ----------

function median(arr) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// MAD：接缝那一帧对的逐像素平均绝对差（Y/U/V 各自）
// baseline：整窗 MAD 的中位数 = 「这段画面自己正常运动」时的逐像素变化水平
function pixelDiffMetrics(diffFrames, seamIdx) {
  if (!diffFrames || !diffFrames.length) return null;
  const ys = diffFrames.map(f => f.Y);
  const base = median(ys);
  const idx = Math.max(0, Math.min(diffFrames.length - 1, seamIdx));
  const f = diffFrames[idx];
  return {
    madY: f && Number.isFinite(f.Y) ? Number(f.Y.toFixed(2)) : null,
    madU: f && Number.isFinite(f.U) ? Number(f.U.toFixed(2)) : null,
    madV: f && Number.isFinite(f.V) ? Number(f.V.toFixed(2)) : null,
    madBaseline: base === null ? null : Number(base.toFixed(2)),
    madRatio: (f && Number.isFinite(f.Y) && base) ? Number((f.Y / base).toFixed(2)) : null,
    madMax: ys.length ? Number(Math.max(...ys).toFixed(2)) : null
  };
}

// SE（接缝视觉能量）：把「接缝本身造成的结构变化」从「自然运动」里剥出来量化。
//   dSSIM_i = 1 − SSIM_i
//   baseline = 窗口内 dSSIM 的中位数（自然运动水平）
//   SE = Σ max(0, dSSIM_i − baseline)
// 硬切：SE ≈ 单帧断崖的落差；叠化：SE ≈ 整个混合区累加。
// 两种情形数值可直接横向比较 —— 这是唯一能同时评价「硬切有多硬」和
// 「叠化有多糊」的指标，也是判「接缝是否自然」的主指标。
function seamEnergy(ssimPairs) {
  if (!ssimPairs || !ssimPairs.length) return null;
  const d = ssimPairs.map(s => 1 - s.all).filter(Number.isFinite);
  if (!d.length) return null;
  const base = median(d);
  if (!Number.isFinite(base)) return null;
  const excess = d.map(x => Math.max(0, x - base));
  const se = excess.reduce((a, b) => a + b, 0);
  const peak = Math.max(...excess);
  // 能量落在多少帧上（超过 baseline 的 20% 的帧数）
  const span = excess.filter(x => x > base * 0.2 + 0.005).length;
  return {
    se: Number(se.toFixed(4)),
    sePeak: Number(peak.toFixed(4)),
    seSpanFrames: span,
    dssimBaseline: Number(base.toFixed(4))
  };
}



// 从任务 JSON 读片段时长与转场配置，算出缝的理论时间点
function seamsFromTask(taskId) {
  const f = path.join(APP_ROOT, 'data', 'tasks', `${taskId}.json`);
  if (!fs.existsSync(f)) return { ok: false, error: `任务文件不存在: ${f}` };
  let t;
  try { t = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { ok: false, error: '任务 JSON 解析失败: ' + e.message }; }
  const clips = Array.isArray(t.clips) ? t.clips : [];
  const durs = clips.map(c => Number(c.duration)).filter(n => Number.isFinite(n) && n > 0);
  if (durs.length < 2) return { ok: false, error: `任务只有 ${clips.length} 个片段/时长缺失，无法推断缝位置` };

  const tr = (t.transition && typeof t.transition === 'object') ? t.transition : {};
  const concatQc = (t.steps && t.steps.concatenation && t.steps.concatenation.qcDetails) || {};
  const applied = concatQc.transition || null;         // 实际应用留痕（存在即说明真做了 xfade）
  const fade = applied && Number.isFinite(Number(applied.fadeDuration))
    ? Number(applied.fadeDuration)
    : (Number.isFinite(Number(tr.duration)) ? Number(tr.duration) : 0);
  const transitionsApplied = applied && Number(applied.transitions) > 0 ? Number(applied.transitions) : 0;

  const seams = [];
  let acc = 0;
  for (let i = 0; i < durs.length - 1; i++) {
    acc += durs[i];
    // 若真的做了 xfade，第 i 道缝实际位置要往前收 (i+1)*fade（每道缝吃掉 fade 时长）
    const actualFade = transitionsApplied > 0 ? fade : 0;
    seams.push(Number((acc - (i + 1) * actualFade).toFixed(4)));
  }

  return {
    ok: true,
    taskId,
    method: 'task-json',
    clipDurations: durs,
    seamCountExpected: durs.length - 1,
    transition: {
      enabledInTask: typeof tr.enabled === 'boolean' ? tr.enabled : null,
      configuredDuration: Number.isFinite(Number(tr.duration)) ? Number(tr.duration) : null,
      configuredType: tr.type || null,
      /** 拼接步骤里记录的实际应用情况；null = 该任务没有留痕（旧版本） */
      appliedInConcat: applied,
      transitionsApplied
    },
    seams
  };
}

// 无任务信息时：用 scdet（scene change detect）自动找候选缝。
// scdet 每帧输出 lavfi.scd.score（0~100，>10 视为场景切换）与 lavfi.scd.mafd
// （mean absolute frame difference，逐帧像素差），两者正好是我们要的信号。
// 早期版本用 select='gt(scene,0.2)' + metadata，实测在真实成片上选不出任何帧
// （等于静默返回 0 道缝），所以改用 scdet。
function seamsBySceneDetect(video, { scoreThreshold = 10, windowSec = 120 } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamscd_'));
  try {
    // 只扫前 windowSec 秒，避免长成片耗时过久（缝通常集中在开头几段）
    runFF([
      '-hide_banner', '-nostats', '-loglevel', 'error',
      '-t', String(windowSec), '-i', video, '-an',
      '-vf', 'scdet=t=8,metadata=mode=print:file=scd.txt',
      '-f', 'null', '-'
    ], { cwd: tmpDir });

    const file = path.join(tmpDir, 'scd.txt');
    if (!fs.existsSync(file)) return { ok: false, error: 'scdet 未产生输出（不可判定）' };
    const txt = fs.readFileSync(file, 'utf8');
    const frames = [];
    let cur = null;
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const tm = line.match(/pts_time:([\d.]+)/);
      if (tm) { if (cur) frames.push(cur); cur = { t: parseFloat(tm[1]), score: 0, mafd: 0 }; continue; }
      const sm = line.match(/lavfi\.scd\.score=([\d.]+)/);
      if (sm && cur) cur.score = parseFloat(sm[1]);
      const mm = line.match(/lavfi\.scd\.mafd=([\d.]+)/);
      if (mm && cur) cur.mafd = parseFloat(mm[1]);
    }
    if (cur) frames.push(cur);
    if (!frames.length) return { ok: false, error: 'scdet 输出无法解析（不可判定）' };

    const mafds = frames.map(f => f.mafd);
    const med = median(mafds) || 0;
    const byScore = frames.filter(f => f.score >= scoreThreshold);
    // 补充：mafd 显著高于中位数的局部峰（叠化不会产生高 score，只能靠 mafd）
    const mafdGate = Math.max(med * 4, 1.0);
    const byMafd = frames.filter(f => f.mafd >= mafdGate);
    const merged = [...byScore, ...byMafd].sort((a, b) => a.t - b.t);

    const seams = [];
    for (const f of merged) {
      if (!seams.length || f.t - seams[seams.length - 1] > 0.35) seams.push(f.t);
    }
    return {
      ok: true, seams, method: 'scene-detect(scdet)',
      transition: null,
      sceneStats: { frames: frames.length, medianMafd: Number(med.toFixed(3)), byScore: byScore.length, byMafd: byMafd.length }
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---------- 单视频分析 ----------

function analyzeVideo(videoPath, opts) {
  const info = probeVideo(videoPath);
  if (!info) return { ok: false, error: 'ffprobe 探测失败（不可判定）' };
  if (!info.duration) return { ok: false, error: '探测不到时长（不可判定）' };

  // 缝位置来源优先级：显式 > 任务记录 > 场景检测
  let seamInfo;
  if (opts.seams && opts.seams.length) {
    seamInfo = { ok: true, seams: opts.seams, method: 'explicit', transition: null };
  } else if (opts.task) {
    seamInfo = seamsFromTask(opts.task);
    if (!seamInfo.ok) {
      // 任务记录里没有可用时长（例如 Mock 任务的片段没有 duration）→
      // 不要直接失败，退回场景检测，并在报告里写明用的是哪条路
      log(`  ⚠ 任务记录不可用（${seamInfo.error}），改用场景检测找缝`);
      const scd = seamsBySceneDetect(videoPath);
      if (!scd.ok) return { ok: false, error: `任务记录与场景检测都不可用：${seamInfo.error} / ${scd.error}`, info };
      seamInfo = { ...scd, taskFallback: seamInfo.error };
    }
  } else {
    const scd = seamsBySceneDetect(videoPath);
    if (!scd.ok) return { ok: false, error: scd.error, info };
    seamInfo = scd;
  }

  const seams = (seamInfo.seams || []).filter(t => t > 0.05 && t < info.duration - 0.05);
  if (!seams.length) return { ok: false, error: '没有可分析的缝（缝位置为空或全部超出视频范围）', info };

  // 窗口：默认 ±0.6s（足够覆盖 0.5s 淡化并留出基线）；
  // 若已知 fade 时长，窗口取 max(0.6, fade*2)
  const fadeDur = seamInfo.transition && seamInfo.transition.appliedInConcat
    ? Number(seamInfo.transition.appliedInConcat.fadeDuration) || 0
    : 0;
  const win = opts.window || Math.max(0.6, fadeDur * 2);

  const results = [];
  for (let i = 0; i < seams.length; i++) {
    const t = seams[i];
    const m = measureWindow(videoPath, t, win);
    if (!m.frames.length) {
      results.push({ index: i, t, undetermined: true, reason: '抽帧/统计失败', stderr: (m.stderrA || '').slice(0, 300) });
      try { fs.rmSync(m.tmpDir, { recursive: true, force: true }); } catch (e) {}
      continue;
    }
    // 缝在窗口中的帧序号：**必须用绝对时间**。
    // ffmpeg 在 -ss 之后输出的 pts_time 是从窗口起点重新从 0 开始的，
    // 直接拿 pts_time 和接缝绝对时间比会永远挑到窗口最后一帧（实测踩过：
    // MAD 恒为 0，因为挑中的是窗口末尾那对几乎相同的帧）。
    let seamIdx = 0, best = Infinity;
    for (let k = 0; k < m.frames.length; k++) {
      const absT = (m.start || 0) + m.frames[k].ptsTime;
      const d = Math.abs(absT - t);
      if (d < best) { best = d; seamIdx = k; }
    }
    const typeInfo = classifySeamType(m.frames, m.ssimPairs);
    // 关键：所有「两侧对比」都必须用**最不相似的那一帧对**的下标，而不是「最接近缝时间点的帧」。
    // SSIM/差分流都是「第 i 帧 vs 第 i+1 帧」，pair i 对应帧 i 与 i+1。
    // 早期版本用「最接近接缝时间的帧」当下标，硬切时正好错开一帧，
    // 导致 MAD 恒等于自然运动水平（实测踩过：MAD 5.5 而窗口内峰值 35.5）。
    const pairIdx = Number.isFinite(typeInfo.minAtPairIndex)
      ? typeInfo.minAtPairIndex
      : Math.max(0, seamIdx - 1);
    const metrics = crossSeamMetrics(m.frames, m.ssimPairs, pairIdx);
    const bright = brightnessPeak(m.frames, seamIdx);
    const pix = pixelDiffMetrics(m.diffFrames, pairIdx);
    const energy = seamEnergy(m.ssimPairs);

    results.push({
      index: i,
      t,
      framesInWindow: m.frames.length,
      seamFrameIndex: seamIdx,
      seamPairIndex: pairIdx,
      seamType: typeInfo,
      metrics,
      brightness: bright,
      pixelDiff: pix,
      energy,
      undetermined: false
    });

    try { fs.rmSync(m.tmpDir, { recursive: true, force: true }); } catch (e) {}
    if (!opts.quiet) {
      const mm = metrics || {};
      const pp = pix || {};
      console.log(`    缝 #${i + 1} @ ${t.toFixed(2)}s  类型=${typeInfo.type}`
        + `  minSSIM=${typeInfo.minSsim}  ΔE76=${mm.dE76}  ΔY=${mm.dY}`
        + `  MAD=${pp.madY}(×${pp.madRatio})  SE=${energy ? energy.se : '?'}`);
    }
  }

  return { ok: true, info, seamInfo, window: win, results };
}

// ---------- 汇总判定 ----------
//
// 把每道缝归到三类病因之一，并给出总体结论。
// 三态：pass（无异常缝）/ fail（有缝不自然）/ undetermined（测不到）
function summarize(analysis) {
  const R = analysis.results.filter(r => !r.undetermined);
  if (!R.length) {
    return { verdict: 'undetermined', reason: '所有缝都测不到数值', counts: {} };
  }
  // 阈值（第一版，基于实测校准，见 docs/spec/seam-quality-spec.md）
  const TH = { dE: 10, dY: 12, ssimSeam: 0.75, madRatio: 2.5, se: 0.6 };
  const counts = { tone: 0, brightness: 0, content: 0, none: 0 };
  for (const r of R) {
    const m = r.metrics || {};
    const p = r.pixelDiff || {};
    const e = r.energy || {};
    const toneBad = Number.isFinite(m.dE76) && m.dE76 >= TH.dE;
    const brightBad = Number.isFinite(m.dY) && Math.abs(m.dY) >= TH.dY;
    const structBad = (Number.isFinite(r.seamType.minSsim) && r.seamType.minSsim < TH.ssimSeam)
      || (Number.isFinite(p.madRatio) && p.madRatio >= TH.madRatio);
    if (structBad) counts.content++;
    else if (toneBad) counts.tone++;
    else if (brightBad) counts.brightness++;
    else if (Number.isFinite(e.se) && e.se >= TH.se) counts.content++;
    else counts.none++;
  }
  const total = R.length;
  const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const verdict = counts.none === total ? 'pass' : 'fail';
  return { verdict, total, counts, dominant: worst && worst[1] > 0 ? worst[0] : 'none', thresholds: TH };
}

// ---------- Markdown 报告 ----------

function mdReport(analyses, opts) {
  const lines = [];
  const now = new Date().toISOString();
  lines.push('# 接缝质量实测报告');
  lines.push('');
  lines.push(`- 生成时间：${now}`);
  lines.push(`- 脚本：\`scripts/analyze-seams.js\`（度量：SSIM + signalstats YUV + ΔE76）`);
  lines.push(`- 说明：本报告只读视频文件，未写入 / 未覆盖任何成片（AGENTS.md §4.7）。`);
  lines.push('');

  for (const a of analyses) {
    lines.push(`## ${path.basename(a.video)}`);
    lines.push('');
    if (!a.ok) {
      lines.push(`> ❌ **不可判定**：${a.error}`);
      lines.push('');
      continue;
    }
    const i = a.info;
    const tr = (a.seamInfo && a.seamInfo.transition) || null;
    lines.push('| 项 | 值 |');
    lines.push('|---|---|');
    lines.push(`| 时长 | ${i.duration != null ? i.duration.toFixed(3) + ' s' : '未测到'} |`);
    lines.push(`| 分辨率 / 帧率 | ${i.width}×${i.height} @ ${i.fps ? i.fps.toFixed(2) : '?'} fps |`);
    lines.push(`| 编码 / 大小 | ${i.codec || '?'} / ${(i.sizeBytes / 1048576).toFixed(2)} MB |`);
    lines.push(`| 音轨 | ${i.hasAudio ? '有' : '无'} |`);
    if (a.seamInfo) {
      lines.push(`| 缝位置来源 | ${a.seamInfo.method}（${a.seamInfo.seams.length} 道） |`);
    }
    if (tr) {
      lines.push(`| 任务记录 transition.enabled | ${tr.enabledInTask === null ? '未记录' : tr.enabledInTask} |`);
      lines.push(`| 任务记录 配置时长/类型 | ${tr.configuredDuration ?? '未记录'} s / ${tr.configuredType ?? '未记录'} |`);
      lines.push(`| 拼接步骤实际留痕 | ${tr.appliedInConcat ? `已应用 ${tr.transitionsApplied} 道 ${tr.appliedInConcat.type}，fade=${tr.appliedInConcat.fadeDuration}s` : '**无留痕（旧版本或硬切）**'} |`);
    }
    lines.push(`| 分析窗口 | ±${a.window.toFixed(2)} s |`);
    lines.push('');

    const R = a.results;
    const okR = R.filter(r => !r.undetermined);
    if (!okR.length) {
      lines.push('> ❌ 全部缝均未测到数值（不可判定）');
      lines.push('');
      continue;
    }

    lines.push('### 逐缝数值表');
    lines.push('');
    lines.push('| # | 缝位置(s) | 帧判型 | min SSIM | 同段基线 | ΔE76(均色差) | ΔY(均亮度) | 峰值Y极差 | MAD(像素级) | MAD基线 | MAD倍数 | SE(接缝能量) | 低谷宽度 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of R) {
      if (r.undetermined) {
        lines.push(`| ${r.index + 1} | ${r.t.toFixed(2)} | — | — | — | — | — | — | — | — | — | — | 不可判定 |`);
        continue;
      }
      const m = r.metrics || {};
      const b = r.brightness || {};
      const p = r.pixelDiff || {};
      const e = r.energy || {};
      lines.push([
        `| ${r.index + 1}`,
        ` ${r.t.toFixed(3)}`,
        ` ${r.seamType.type}`,
        ` ${r.seamType.minSsim}`,
        ` ${m.baselineSsim ?? '—'}`,
        ` ${m.dE76 ?? '—'}`,
        ` ${m.dY ?? '—'}`,
        ` ${b.windowYRange ?? '—'}`,
        ` ${p.madY ?? '—'}`,
        ` ${p.madBaseline ?? '—'}`,
        ` ×${p.madRatio ?? '—'}`,
        ` ${e.se ?? '—'}`,
        ` ${r.seamType.dipWidth} |`
      ].join(' |'));
    }
    lines.push('');

    // 判定一览
    const types = okR.reduce((acc, r) => { acc[r.seamType.type] = (acc[r.seamType.type] || 0) + 1; return acc; }, {});
    lines.push('**接缝类型分布**：' + Object.entries(types).map(([k, v]) => `${k}×${v}`).join('、'));
    lines.push('');
    const s = a.summary;
    lines.push(`**分类计数**：色调 ${s.counts.tone || 0} / 亮度 ${s.counts.brightness || 0} / 内容 ${s.counts.content || 0} / 正常 ${s.counts.none || 0}`);
    lines.push('');
    lines.push(`**三态结论：${{ pass: '通过', fail: '不通过', undetermined: '未验证' }[s.verdict]}**`
      + (s.verdict === 'fail' ? `（主导病因：${{ tone: '色调跳变', brightness: '亮度跳变', content: '内容跳变' }[s.dominant]}）` : ''));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 度量口径说明');
  lines.push('');
  lines.push('- **min SSIM**：窗口内相邻帧对 SSIM 的最小值。硬切会在单帧对上出现 0.2~0.6 的断崖。');
  lines.push('- **同段基线 SSIM**：窗口首尾两帧对（远离缝）的 SSIM 均值，代表「这段画面自己自然变化时」的水平。');
  lines.push('- **ΔY**：缝两侧代表帧的平均亮度差（signalstats YAVG，TV range 16~235）。');
  lines.push('- **峰值Y极差**：窗口内逐帧 YAVG 的极差，衡量亮度是否突变。');
  lines.push('- **ΔE76**：sRGB→XYZ(D65)→CIELAB 后的欧氏距离。行业经验：>2.3 肉眼可辨，>10 明显偏色。');
  lines.push('- **ΔRGB**：RGB 三通道差的欧氏距离（0~441.7）。');
  lines.push('- **低谷宽度**：连续低于 0.75 的帧对数。≤2 → 断崖（硬切）；≥3 → 多帧混合（淡化/叠化）。');
  return lines.join('\n');
}

// ---------- main ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.videos.length)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(18, 40).join('\n'));
    process.exit(opts.videos.length ? 0 : 1);
  }
  if (!FFMPEG || !fs.existsSync(FFMPEG)) die('找不到 ffmpeg（config.FFMPEG_PATH 无效），无法分析', 2);
  if (!FFPROBE || !fs.existsSync(FFPROBE)) die('找不到 ffprobe（config.FFPROBE_PATH 无效），无法分析', 2);

  const analyses = [];
  for (let vi = 0; vi < opts.videos.length; vi++) {
    const v = opts.videos[vi];
    const abs = path.isAbsolute(v) ? v : path.resolve(APP_ROOT, v);
    if (!fs.existsSync(abs)) { analyses.push({ video: abs, ok: false, error: '文件不存在' }); continue; }
    // 每个视频用自己的任务：--task 按序对应；否则从文件名推断
    const taskId = opts.tasks[vi] || inferTaskIdFromPath(abs);
    log(`\n▶ 分析 ${path.basename(abs)}${taskId ? `  (task=${taskId})` : '  (无任务信息，将用场景检测找缝)'}`);
    const a = analyzeVideo(abs, { ...opts, task: taskId });
    a.video = abs;
    if (a.ok) {
      a.summary = summarize(a);
      log(`  结论：${a.summary.verdict}  计数=${JSON.stringify(a.summary.counts)}`);
    } else {
      log(`  ❌ ${a.error}`);
    }
    analyses.push(a);
  }

  const md = mdReport(analyses, opts);
  const outDir = opts.outDir
    ? (path.isAbsolute(opts.outDir) ? opts.outDir : path.resolve(APP_ROOT, opts.outDir))
    : path.join(APP_ROOT, 'data', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const mdPath = path.join(outDir, `seam-report-${stamp}.md`);
  const jsonPath = path.join(outDir, `seam-report-${stamp}.json`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), analyses }, null, 2), 'utf8');
  log(`\n📄 报告已写入：${mdPath}`);
  log(`📄 原始数据：${jsonPath}`);

  const anyFail = analyses.some(a => a.ok && a.summary.verdict === 'fail');
  const anyUndet = analyses.some(a => !a.ok || a.summary.verdict === 'undetermined');
  process.exit(anyUndet && !anyFail ? 1 : 0);
}

main();
