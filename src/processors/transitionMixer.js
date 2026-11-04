// ==========================================================
// 片段间转场（交叉淡化）拼接
// ==========================================================
//
// 背景（2026-10-20）：
//   原拼接只有 concat（-c copy 或重编码直拼），片段与片段之间是硬切。
//   用户反馈「拼接衔接不自然」，实测一条 3 片段成片：湖景 -> 湖景 -> 星空，
//   接缝处相邻帧 SSIM 0.238、逐帧亮度差 46.5（正常帧间只有 2.4~4.5）。
//   本模块用 ffmpeg xfade 在相邻片段之间做真实的交叉淡化。
//
// 口径（与「首尾循环」区分开，两者互不替代）：
//   - 首尾循环点：videoProcessor._makeLoopFFmpeg（尾部 F 秒渐变回开头）
//   - 片段接缝  ：本模块（每两个相邻片段之间重叠 F 秒）
//
// 时长公式（N 个片段、淡化 F 秒）：
//   成片时长 = Σd_i − (N−1)·F
//   这与 concat 的 Σd_i 不同，调用方必须按本模块返回的 expectedDuration 去校验/展示，
//   不能继续用「各片段时长之和」当期望值（否则质检会误判为「拼接被截断」）。
//
// 关键实现点（都是实测踩过的坑，改之前先读）：
//   1) xfade 的 offset 是相对【第一个输入（即已累积的链）】的时间轴。
//      第 k 个接缝（k 从 1 开始）的 offset = 当前累积时长 − F；
//      每接一段，累积时长变成「累积 + d_k − F」。
//      写错 offset 的典型症状：退出码 0、时长也「差不多」，但接缝处根本没有融合。
//   2) 每个输入先 trim + setpts 归零，否则 xfade 会按源文件的原始时间戳取帧，
//      接缝位置全部错位。
//   3) 所有输入必须统一分辨率 / 帧率 / 像素格式 / SAR，否则 xfade 直接报错或产出花屏。
//      这里复用 concatenateSegments 的口径：只重编码不匹配的片段。
//   4) 音频不能只 acrossfade 而不对齐采样率/声道；统一 aresample 到 44100 立体声。
//   5) 混合音轨（部分片段有音轨、部分没有）必须给无音轨片段补等长静音，
//      否则 acrossfade 因缺流失败；这与 videoProcessor 的混合音轨处理口径一致。
//   6) 不用退出码 0 当成功（AGENTS.md §4.3）：产物时长必须 ≈ Σd_i − (N−1)·F，
//      并做一次完整解码校验。
//
// 另一条硬约束：本文件不依赖 videoProcessor 的私有方法。
// 2026-10-20 工作区里 videoProcessor.js 有别人未提交的改动（EPERM 降级），
// 依赖它的私有方法会让本模块的稳定性受对方改动影响，因此执行/探测都自带实现。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn, spawnSync } = require('child_process');
const config = require('../../config');

const FFMPEG_PATH = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = config.FFPROBE_PATH || 'ffprobe';

const SIZE_MAP = {
  '480p': [854, 480],
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '4K': [3840, 2160],
  '4k': [3840, 2160]
};

// xfade 支持的转场类型（只放可用的、语义明确的）。
// fade = 交叉淡化（默认，最接近「自然衔接」）；dissolve = 带噪点的溶解；
// 其余是给后续 UI 预留的，不改变默认行为。
const ALLOWED_TYPES = new Set([
  'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright',
  'circleopen', 'pixelize', 'fadeblack', 'fadewhite'
]);

const MIN_FADE = 0.1;

// 编码器候选：探测通过才使用。auto 顺序 = 硬件优先，最后回退 libx264。
const ENCODERS = {
  libx264: { args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23'] },
  nvenc: { args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', '0', '-cq', '23'] },
  qsv: { args: ['-c:v', 'h264_qsv', '-global_quality', '23'] },
  amf: { args: ['-c:v', 'h264_amf', '-quality', 'balanced', '-qp_i', '23', '-qp_p', '23'] }
};

let _encoderCache = null;

// 用 0.2s 黑帧试编一次，确认编码器在当前机器真的可用（-encoders 列出不等于能跑）
function probeEncoder(name) {
  const spec = ENCODERS[name];
  if (!spec) return false;
  try {
    const r = spawnSync(FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=black:s=256x144:d=0.2',
      ...spec.args, '-frames:v', '1', '-an', '-f', 'null', '-'
    ], { stdio: 'ignore', timeout: 8000 });
    return r && r.status === 0;
  } catch (e) {
    return false;
  }
}

function pickEncoder() {
  if (_encoderCache) return _encoderCache;
  const want = String((config.TRANSITIONS && config.TRANSITIONS.encoder) || 'auto').toLowerCase();
  const order = want === 'auto' ? ['nvenc', 'qsv', 'amf', 'libx264'] : [want];
  for (const name of order) {
    if (ENCODERS[name] && probeEncoder(name)) {
      _encoderCache = name;
      return _encoderCache;
    }
  }
  _encoderCache = 'libx264';
  return _encoderCache;
}

// ffmpeg -progress 输出是 key=value 文本；只取最后一份即可
function readProgress(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const map = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return map;
}

// 执行只关心成功/失败的 ffmpeg 命令。
// 直接用 stdio:'ignore'：本环境里「捕获 stdout」才会踩 EPERM（AGENTS.md §2.3），
// ignore 不需要管道，沙箱与普通环境行为一致。
// stderr 重定向到临时文件，失败时把最后几行带回去——否则只剩
// "Command failed" 这种没有诊断价值的报错。
function runFFmpeg(cmd) {
  const tmp = path.join(os.tmpdir(), `tr_run_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    execSync(`${cmd} 2> "${tmp}"`, { stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    const text = readTmp(tmp);
    const lines = String(text || '')
      .split(/\r?\n/)
      .filter(l => l.trim() && !/^ffmpeg version|^  built with|^  configuration|^  lib/.test(l))
      .slice(-4);
    return { ok: false, error: lines.join(' | ') || ((e && e.message) || 'ffmpeg 执行失败') };
  } finally {
    cleanupTmp(tmp);
  }
}

function readTmp(tmp) {
  try { return fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : ''; } catch (e) { return ''; }
}

function cleanupTmp(tmp) {
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
}

// ------------------------------------------------------------
// 大规模拼接执行（2026-11-04）
// 段数一多，整条命令会超过 Windows 上限（cmd.exe 8191 / CreateProcess 32767），
// 且 filter 字符串本身就有几万字符。这里改成：
//   输入硬链接成短名（s0001.mp4）→ filter 写文件 → spawn 参数数组（不经 shell）
// 启动实测：360 段命令行 11.9k 字符，成功；旧实现 40 段就失败。
// ------------------------------------------------------------
function runFFmpegArgs(args, cwd, opts = {}) {
  const { onProgress, expectedDuration, signal, encoder } = opts;
  return new Promise((resolve) => {
    const errFile = path.join(cwd, `_ff_${Date.now()}.log`);
    const progressFile = path.join(cwd, 'progress.txt');
    let fd;
    try { fd = fs.openSync(errFile, 'w'); } catch (e) { fd = 'ignore'; }
    const t0 = Date.now();
    let done = false;
    let cancelled = false;
    let timer = null;
    let proc = null;

    const cleanup = () => {
      if (timer) { clearInterval(timer); timer = null; }
      try { if (typeof fd === 'number') fs.closeSync(fd); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(errFile); } catch (e) { /* ignore */ }
    };

    const finish = (code) => {
      if (done) return;
      done = true;
      let text = '';
      try { text = fs.readFileSync(errFile, 'utf8'); } catch (e) { /* ignore */ }
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ } }
      cleanup();
      const lines = String(text || '')
        .split(/\r?\n/)
        .filter(l => l.trim() && !/^ffmpeg version|^  built with|^  configuration|^  lib/.test(l))
        .slice(-4);
      resolve({
        ok: code === 0 && !cancelled,
        cancelled,
        encoder: encoder || null,
        ms: Date.now() - t0,
        error: cancelled ? '已取消' : (lines.join(' | ') || (code === 0 ? null : 'ffmpeg 执行失败'))
      });
    };

    const onAbort = () => {
      cancelled = true;
      try { if (proc) proc.kill(); } catch (e) { /* ignore */ }
      if (!proc) finish(-2);
    };

    if (signal) {
      if (signal.aborted) { cancelled = true; finish(-2); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (onProgress) {
      timer = setInterval(() => {
        const p = readProgress(progressFile);
        if (!p) return;
        const us = Number(p.out_time_us) || (Number(p.out_time_ms) * 1000) || 0;
        const outTimeSec = us / 1e6;
        const percent = expectedDuration > 0
          ? Math.max(0, Math.min(100, (outTimeSec / expectedDuration) * 100))
          : null;
        try {
          onProgress({
            phase: 'encode',
            outTimeSec: Math.round(outTimeSec * 100) / 100,
            percent: percent === null ? null : Math.round(percent * 10) / 10,
            speed: p.speed || null,
            fps: p.fps || null,
            frame: p.frame ? Number(p.frame) : null,
            encoder: encoder || null
          });
        } catch (e) { /* 回调异常不影响编码 */ }
      }, 500);
    }

    try {
      proc = spawn(FFMPEG_PATH, args, { cwd, stdio: ['ignore', 'ignore', fd] });
    } catch (e) {
      finish(-1);
      return;
    }
    proc.on('error', () => finish(-1));
    proc.on('exit', (code) => {
      if (code === 0 && onProgress) {
        try { onProgress({ phase: 'done', percent: 100, encoder: encoder || null }); } catch (e) { /* ignore */ }
      }
      finish(code);
    });
  });
}

// 把输入硬链接（跨盘退化为复制）到 staging，用短文件名压命令行长度
function stageInputs(prepared, stagingDir) {
  const staged = [];
  for (let i = 0; i < prepared.length; i++) {
    const src = path.resolve(prepared[i]);
    let ext = path.extname(src).toLowerCase();
    if (!ext || ext.length > 5) ext = '.mp4';
    const name = 's' + String(i).padStart(4, '0') + ext;
    const dst = path.join(stagingDir, name);
    try {
      fs.linkSync(src, dst);
    } catch (e) {
      fs.copyFileSync(src, dst);
    }
    staged.push(name);
  }
  return staged;
}

async function runTransitionFfmpeg(prepared, parts, outputPath, wantAudio, stagingDir, opts = {}) {
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(path.join(stagingDir, 'graph.txt'), parts.join(';\n') + '\n', 'utf8');
  const staged = stageInputs(prepared, stagingDir);
  const encoder = pickEncoder();
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-stats_period', '0.5', '-progress', 'progress.txt'
  ];
  for (const name of staged) args.push('-i', name);
  args.push('-filter_complex_script', 'graph.txt', '-map', '[vout]');
  if (wantAudio) args.push('-map', '[aout]');
  args.push(...ENCODERS[encoder].args);
  args.push('-pix_fmt', 'yuv420p');
  if (wantAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-movflags', '+faststart', path.resolve(outputPath));
  return runFFmpegArgs(args, stagingDir, {
    onProgress: opts.onProgress,
    expectedDuration: opts.expectedDuration,
    signal: opts.signal,
    encoder
  });
}

// 需要读 stdout 的命令：重定向到临时文件再读（不依赖管道捕获）
function captureStdout(cmd) {
  const tmp = path.join(os.tmpdir(), `tr_out_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    try {
      execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore' });
    } catch (e) {
      // ffprobe 出错时退出码非 0，但错误信息已在文件里；由调用方判断
    }
    return readTmp(tmp);
  } finally {
    cleanupTmp(tmp);
  }
}

// 需要读 stderr 的命令（解码校验）
function captureStderr(cmd) {
  const tmp = path.join(os.tmpdir(), `tr_err_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    let ok = true;
    try {
      execSync(`${cmd} 2> "${tmp}"`, { stdio: 'ignore' });
    } catch (e) {
      ok = false;
    }
    return { ok, text: readTmp(tmp) };
  } finally {
    cleanupTmp(tmp);
  }
}

function parseFps(fps) {
  const s = String(fps || '');
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (b) return a / b;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function probeMedia(file) {
  const cmd = `"${FFPROBE_PATH}" -v error -show_format -show_streams -of json "${file}"`;
  const out = captureStdout(cmd);
  let info;
  try {
    info = JSON.parse(out);
  } catch (e) {
    return { success: false, error: '无法解析 ffprobe 输出（文件可能损坏）' };
  }
  const v = (info.streams || []).find(s => s.codec_type === 'video');
  const a = (info.streams || []).find(s => s.codec_type === 'audio');
  const duration = parseFloat(info.format && info.format.duration);
  if (!v) return { success: false, error: '没有视频流' };
  if (!(duration > 0)) return { success: false, error: '无法探测时长' };
  return {
    success: true,
    duration,
    width: v.width,
    height: v.height,
    codec: v.codec_name,
    pixFmt: v.pix_fmt,
    sar: v.sample_aspect_ratio || '1:1',
    fpsNum: parseFps(v.r_frame_rate),
    fps: v.r_frame_rate,
    hasAudio: !!a
  };
}

function normalizeInputs(clips) {
  return (Array.isArray(clips) ? clips : [])
    .map(c => {
      if (typeof c === 'string') return { path: c, inSec: 0, outSec: null };
      if (c && typeof c === 'object' && c.path) {
        return {
          path: c.path,
          inSec: Number(c.inSec) > 0 ? Number(c.inSec) : 0,
          outSec: c.outSec !== undefined && c.outSec !== null ? Number(c.outSec) : null,
          // 调用方已探测过时直接复用，避免逐段 ffprobe（360 段时能省几分钟）
          detail: c.detail && c.detail.success ? c.detail : null
        };
      }
      return null;
    })
    .filter(Boolean);
}

function resolveTarget(options, details) {
  const key = String(options.resolution || '').trim();
  if (SIZE_MAP[key]) return { width: SIZE_MAP[key][0], height: SIZE_MAP[key][1], label: key };
  if (Number(options.width) > 0 && Number(options.height) > 0) {
    return { width: Number(options.width), height: Number(options.height), label: 'custom' };
  }
  // 没指定目标：取像素面积最大的片段，避免把高分辨率往低压
  let best = { width: 1280, height: 720, label: '720p' };
  let bestArea = 0;
  for (const d of details) {
    if (d.success && d.width && d.height) {
      const area = d.width * d.height;
      if (area > bestArea) {
        bestArea = area;
        best = { width: d.width, height: d.height, label: 'auto' };
      }
    }
  }
  return best;
}

function makeTempPath(outputPath, i) {
  return path.join(path.dirname(outputPath), `.tr_${process.pid}_${Date.now()}_${i}.mp4`);
}

// ============================================================
// 校色（colorMatch，2026-10-27 批次 2）
// ------------------------------------------------------------
// 为什么放在这里：转场拼接本来就要整段重编码，把 lutrgb 塞进同一条滤镜链
// 是**零额外编码成本**的；而 -c copy 直拼路径要校色就得多编一遍，不值。
//
// 算法：抽若干帧 → 逐通道均值/方差 → 与「首段」对齐（Reinhard 式线性变换）
//      → 生成 lutrgb 表达式。参考段固定首段（链式会随段数累积偏色）。
// 限幅：单通道增益限制在 [1-maxGain, 1+maxGain]，防止把画面拉坏。
// ============================================================
const CM_SAMPLE_FRAMES = 5;
const CM_SAMPLE_W = 64;
const CM_SAMPLE_H = 36;

// 采样一个片段的 RGB 均值/标准差（3 个通道）。
// 一次 ffmpeg 调用取 N 帧（fps 滤镜重采样到 N/dur），落文件再读——
// 逐帧起进程在短片段上开销会超过编码本身（实测 5 次/段 ≈ 2.4s）。
// 捕获 stdout 会踩 EPERM（AGENTS.md §2.3），所以走文件。
function sampleRgbStats(file, duration) {
  const dur = Number(duration);
  if (!(dur > 0.05)) throw new Error('采样失败：片段时长不可用');
  const target = Math.max(1, Math.min(CM_SAMPLE_FRAMES, Math.max(1, Math.floor(dur * 2))));
  const rate = target / dur;
  const frameBytes = CM_SAMPLE_W * CM_SAMPLE_H * 3;
  const tmp = path.join(os.tmpdir(), `tr_rgb_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.raw`);

  try {
    const cmd = `"${FFMPEG_PATH}" -y -hide_banner -loglevel error -i "${file}" `
      + `-vf "fps=${rate.toFixed(6)},scale=${CM_SAMPLE_W}:${CM_SAMPLE_H}" `
      + `-frames:v ${target} -pix_fmt rgb24 -f rawvideo "${tmp}"`;
    const r = runFFmpeg(cmd);
    if (!r.ok) throw new Error('抽帧失败: ' + r.error);
    const buf = fs.readFileSync(tmp);
    const frames = Math.floor(buf.length / frameBytes);
    if (!frames) throw new Error('抽帧不完整（0 帧）');

    const sum = [0, 0, 0];
    const sumSq = [0, 0, 0];
    for (let f = 0; f < frames; f++) {
      const base = f * frameBytes;
      for (let p = 0; p < CM_SAMPLE_W * CM_SAMPLE_H; p++) {
        for (let c = 0; c < 3; c++) {
          const v = buf[base + p * 3 + c];
          sum[c] += v;
          sumSq[c] += v * v;
        }
      }
    }
    const count = CM_SAMPLE_W * CM_SAMPLE_H * frames;
    const mean = [0, 0, 0];
    const sd = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      mean[c] = sum[c] / count;
      const variance = Math.max(0, sumSq[c] / count - mean[c] * mean[c]);
      sd[c] = Math.sqrt(variance) || 1;
    }
    return { mean, sd, frames };
  } finally {
    cleanupTmp(tmp);
  }
}

// 生成把 cur 拉到 ref 的 lutrgb 表达式；返回 { expr, gain, offset, clamped }
function buildColorLut(ref, cur, maxGain) {
  const lo = 1 - maxGain;
  const hi = 1 + maxGain;
  const gain = [];
  const offset = [];
  const clamped = [];
  for (let c = 0; c < 3; c++) {
    const rawGain = cur.sd[c] > 1 ? ref.sd[c] / cur.sd[c] : 1;
    const g = Math.max(lo, Math.min(hi, rawGain));
    gain.push(Number(g.toFixed(4)));
    offset.push(Number((ref.mean[c] - g * cur.mean[c]).toFixed(2)));
    clamped.push(Math.abs(rawGain - g) > 1e-6);
  }
  const expr = `lutrgb=r='val*${gain[0]}+${offset[0]}':`
    + `g='val*${gain[1]}+${offset[1]}':`
    + `b='val*${gain[2]}+${offset[2]}'`;
  return { expr, gain, offset, clamped };
}


// 主入口：把 clips 用交叉淡化拼成 outputPath
// clips: ['a.mp4', 'b.mp4'] 或 [{ path, inSec, outSec }]
// options: { duration=0.5, type='fade', resolution|width/height, fps }
async function concatWithTransitions(clips, outputPath, options = {}) {
  const list = normalizeInputs(clips);
  if (list.length < 2) {
    return { success: false, error: '转场拼接至少需要 2 个片段' };
  }

  // 1) 探测源（调用方传了 detail 就复用，省掉逐段 ffprobe）
  const details = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i].detail || probeMedia(list[i].path);
    if (!d.success) {
      return { success: false, error: `第 ${i + 1} 段无法探测: ${d.error}` };
    }
    details.push(d);
  }

  // 2) 计算每段有效时长（支持首尾裁剪）
  const durs = [];
  for (let i = 0; i < list.length; i++) {
    const d = details[i];
    const outSec = list[i].outSec !== null ? list[i].outSec : d.duration;
    const dur = outSec - list[i].inSec;
    if (!(dur > 0.05)) {
      return { success: false, error: `第 ${i + 1} 段有效时长 ${dur.toFixed(3)}s 过短，无法参与转场拼接` };
    }
    durs.push(dur);
  }

  // 3) 目标规格
  const target = resolveTarget(options, details);
  const fps = Number(options.fps) > 0
    ? Number(options.fps)
    : (details[0].fpsNum || 30);

  // 4) 淡化时长：不能超过最短片段的一半（否则 xfade 没有足够内容可融合）
  const requestedF = Number(options.duration) > 0 ? Number(options.duration) : 0.5;
  const minDur = Math.min(...durs);
  const maxF = minDur / 2 - 0.05;
  if (maxF < MIN_FADE) {
    return {
      success: false,
      error: `片段过短：最短片段 ${minDur.toFixed(2)}s，无法做 ${MIN_FADE}s 以上的交叉淡化`
        + `（至少需要 ${(2 * MIN_FADE + 0.1).toFixed(1)}s）`
    };
  }
  const F = Math.min(requestedF, maxF);
  const type = ALLOWED_TYPES.has(String(options.type || '')) ? String(options.type) : 'fade';

  // 5) 音轨策略（ignoreAudio：剪辑台导出时源片段音轨一律丢弃，BGM 由 audioMixer 单独混）
  const ignoreAudio = options.ignoreAudio === true;
  const audioFlags = details.map(d => d.hasAudio);
  const allAudio = audioFlags.every(Boolean);
  const noneAudio = audioFlags.every(f => f === false);
  const mixedAudio = !allAudio && !noneAudio;
  const wantAudio = !ignoreAudio && (allAudio || mixedAudio);

  const temps = [];
  const cleanupTemps = () => {
    for (const t of temps) cleanupTmp(t);
  };

  try {
    // 6) 逐段归一化（只重编码不匹配的片段；裁剪与补静音也在这里做）
    const prepared = [];
    let normalized = 0;
    for (let i = 0; i < list.length; i++) {
      const d = details[i];
      const seg = list[i];
      const dur = durs[i];
      const inSec = seg.inSec;
      const needsTrim = inSec > 0.02 || (d.duration - (seg.outSec !== null ? seg.outSec : d.duration)) > 0.02;
      const fpsMismatch = d.fpsNum !== null && Math.abs(d.fpsNum - fps) > 0.01;
      const sarBad = d.sar && d.sar !== '1:1' && d.sar !== '0:1';
      const needSilence = mixedAudio && !audioFlags[i];
      const needsNorm = needsTrim
        || needSilence
        || d.width !== target.width
        || d.height !== target.height
        || fpsMismatch
        || d.codec !== 'h264'
        || (d.pixFmt && d.pixFmt !== 'yuv420p')
        || sarBad;

      if (!needsNorm) {
        prepared.push(seg.path);
        continue;
      }

      const tmp = makeTempPath(outputPath, i);
      temps.push(tmp);
      const vf = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,`
        + `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,`
        + `setsar=1,fps=${fps},format=yuv420p`;
      const ss = inSec > 0.02 ? `-ss ${inSec.toFixed(3)}` : '';
      const tt = `-t ${dur.toFixed(3)}`;
      let cmd;
      if (needSilence) {
        // 补一条与视频等长的静音轨
        cmd = `"${FFMPEG_PATH}" -y ${ss} -i "${seg.path}" ${tt} `
          + `-f lavfi -i "anullsrc=r=44100:cl=stereo" -map 0:v -map 1:a -shortest `
          + `-vf "${vf}" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p `
          + `-c:a aac -ar 44100 -ac 2 "${tmp}"`;
      } else {
        const audioArg = audioFlags[i] ? '-c:a aac -ar 44100 -ac 2' : '-an';
        cmd = `"${FFMPEG_PATH}" -y ${ss} -i "${seg.path}" ${tt} -vf "${vf}" `
          + `-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p ${audioArg} "${tmp}"`;
      }
      const run = runFFmpeg(cmd);
      if (!run.ok) {
        cleanupTemps();
        return { success: false, error: `第 ${i + 1} 段归一化失败: ${run.error}` };
      }
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
        cleanupTemps();
        return { success: false, error: `第 ${i + 1} 段归一化失败（产物为空）` };
      }
      prepared.push(tmp);
      normalized += 1;
    }

    // 归一化后的实际时长才是权威值（-t 可能与预期差一帧）
    const actualDurs = [];
    for (let i = 0; i < prepared.length; i++) {
      const d = probeMedia(prepared[i]);
      if (!d.success) {
        cleanupTemps();
        return { success: false, error: `第 ${i + 1} 段归一化后无法探测时长: ${d.error}` };
      }
      actualDurs.push(d.duration);
    }

    const expectedDuration = actualDurs.reduce((a, b) => a + b, 0) - (list.length - 1) * F;
    if (!(expectedDuration > 0)) {
      cleanupTemps();
      return { success: false, error: '片段总时长不足以覆盖转场重叠时长' };
    }

    // 6.6) 校色（默认关）：只在本次重编码里顺带做，不额外多编一次。
    // 失败绝不阻断拼接，但状态必须如实回传（pipeline 会写进 qcDetails，
    // 终检据此判「校色未执行」，见 AGENTS §4.1）。
    const cmOpt = (options.colorMatch && typeof options.colorMatch === 'object') ? options.colorMatch : null;
    const cmEnabled = !!(cmOpt && cmOpt.enabled === true);
    const cmMaxGain = Number(cmOpt && cmOpt.maxGain) > 0 ? Number(cmOpt.maxGain) : 0.15;
    let colorMatch = {
      state: 'disabled',
      reason: '校色未开启（默认关，需任务显式开启 colorMatch）',
      reference: 'first',
      maxGain: cmMaxGain,
      applied: 0,
      total: Math.max(0, list.length - 1),
      luts: []
    };
    const luts = new Array(prepared.length).fill(null);
    if (cmEnabled) {
      try {
        const stats = prepared.map((p, i) => sampleRgbStats(p, actualDurs[i]));
        const detailsLuts = [];
        for (let i = 1; i < prepared.length; i++) {
          const lut = buildColorLut(stats[0], stats[i], cmMaxGain);
          luts[i] = lut;
          detailsLuts.push({
            index: i,
            gain: lut.gain,
            offset: lut.offset,
            clamped: lut.clamped
          });
        }
        colorMatch = {
          state: 'applied',
          reason: `已按首段校色：${prepared.length - 1} 段，单通道增益限幅 ±${(cmMaxGain * 100).toFixed(0)}%`,
          reference: 'first',
          maxGain: cmMaxGain,
          applied: prepared.length - 1,
          total: prepared.length - 1,
          luts: detailsLuts
        };
      } catch (e) {
        colorMatch = {
          state: 'failed',
          reason: '校色执行失败：' + (e && e.message ? e.message : String(e)) + '（已按原片拼接，不阻断出片）',
          reference: 'first',
          maxGain: cmMaxGain,
          applied: 0,
          total: Math.max(0, list.length - 1),
          luts: []
        };
      }
    }

    // 7) 滤镜链
    const parts = [];
    for (let i = 0; i < prepared.length; i++) {
      // 校色放在 trim/setpts 之后：只对有效区间取帧，避免把裁剪掉的部分统计进来。
      // 显式走 rgb24 → lutrgb → yuv420p，不依赖滤镜自动协商，路径可预测。
      const lutPart = luts[i] ? `,format=rgb24,${luts[i].expr},format=yuv420p` : '';
      parts.push(`[${i}:v]trim=start=0:end=${actualDurs[i].toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p${lutPart}[v${i}]`);
    }
    let vPrev = 'v0';
    let acc = actualDurs[0];
    for (let i = 1; i < prepared.length; i++) {
      const offset = acc - F;
      if (!(offset > 0)) {
        cleanupTemps();
        return { success: false, error: `第 ${i} 个接缝的融合起点 ${offset.toFixed(3)}s 非法（片段过短）` };
      }
      const out = `vx${i}`;
      parts.push(`[${vPrev}][v${i}]xfade=transition=${type}:duration=${F.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`);
      vPrev = out;
      acc = acc + actualDurs[i] - F;
    }
    // 统一收口到 vout：滤镜链最后一个标签是按序号生成的，-map 不能写死，
    // 否则会出现「滤镜图能跑、-map 找不到标签」这种看不出原因的失败。
    parts.push(`[${vPrev}]null[vout]`);

    let aPrev = null;
    if (wantAudio) {
      for (let i = 0; i < prepared.length; i++) {
        parts.push(`[${i}:a]atrim=start=0:end=${actualDurs[i].toFixed(3)},asetpts=PTS-STARTPTS,`
          + `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      }
      aPrev = 'a0';
      for (let i = 1; i < prepared.length; i++) {
        const out = `ax${i}`;
        parts.push(`[${aPrev}][a${i}]acrossfade=d=${F.toFixed(3)}:c1=tri:c2=tri[${out}]`);
        aPrev = out;
      }
      parts.push(`[${aPrev}]anull[aout]`);
    }

    // 8) 执行：短路径 + filter 文件 + spawn 参数数组，避开命令行长度上限
    // staging 放在输出同目录：与源片段同盘，硬链接才生效（跨盘会退化成复制大文件）
    const stagingDir = path.join(
      path.dirname(path.resolve(outputPath)),
      `.tr_stage_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    let run = { ok: false, error: '未执行' };
    try {
      run = await runTransitionFfmpeg(prepared, parts, outputPath, wantAudio, stagingDir, {
        onProgress: options.onProgress,
        expectedDuration,
        signal: options.signal
      });
    } catch (e) {
      run = { ok: false, error: (e && e.message) || String(e) };
    } finally {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    if (!run.ok) {
      cleanupTemps();
      if (run.cancelled) {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
        return { success: false, cancelled: true, error: '转场拼接已取消' };
      }
      return { success: false, error: '转场拼接 ffmpeg 执行失败: ' + run.error };
    }

    // 8) 不用退出码 0 当成功：时长必须 ≈ Σd − (N−1)·F
    const outInfo = probeMedia(outputPath);
    if (!outInfo.success) {
      cleanupTemps();
      return { success: false, error: '转场拼接产物无法探测（不可判定，不视为成功）', undetermined: true };
    }
    const tol = Math.max(0.25, 3 / fps);
    const durationOk = Math.abs(outInfo.duration - expectedDuration) <= tol;
    if (!durationOk) {
      cleanupTemps();
      return {
        success: false,
        error: `转场拼接时长异常：实测 ${outInfo.duration.toFixed(2)}s，期望 ${expectedDuration.toFixed(2)}s`
          + `（Σ${actualDurs.map(d => d.toFixed(2)).join('+')} − ${(list.length - 1)}×${F.toFixed(2)}，容差 ±${tol.toFixed(2)}s）`,
        expectedDuration,
        actualDuration: outInfo.duration
      };
    }

    // 9) 完整解码校验（时长对但解码报错的坏片必须抓到）
    const decode = captureStderr(`"${FFMPEG_PATH}" -v error -i "${outputPath}" -f null -`);
    const errorLines = String(decode.text || '')
      .split(/\r?\n/)
      .filter(l => l.trim() && !/^ffmpeg version|^  built with|^  configuration|^  lib/.test(l));
    if (!decode.ok || errorLines.length > 0) {
      cleanupTemps();
      return {
        success: false,
        error: '转场拼接产物无法完整解码：' + (errorLines.slice(0, 3).join(' / ') || 'ffmpeg 解码失败'),
        decodeErrors: errorLines.length
      };
    }

    cleanupTemps();
    return {
      success: true,
      outputPath,
      transitionType: type,
      fadeDuration: F,
      requestedFadeDuration: requestedF,
      fadeClamped: F < requestedF,
      transitions: list.length - 1,
      expectedDuration: Math.round(expectedDuration * 1000) / 1000,
      actualDuration: Math.round(outInfo.duration * 1000) / 1000,
      durationCheck: { ok: true, actual: outInfo.duration, expected: expectedDuration, tolerance: tol },
      decodeCheck: { ok: true, errors: 0 },
      normalized,
      target,
      fps,
      encoder: run.encoder || null,
      audioMode: wantAudio ? (allAudio ? 'all' : 'mixed-padded') : (ignoreAudio ? 'ignored' : 'none'),
      hasAudio: wantAudio,
      // 校色实际状态：disabled / applied / failed（skipped 由上层在「转场关闭」时给出）
      colorMatch
    };
  } catch (e) {
    cleanupTemps();
    return { success: false, error: '转场拼接异常: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = {
  concatWithTransitions,
  // 供验收脚本/上层复用
  _probeMedia: probeMedia,
  _pickEncoder: pickEncoder,
  _ENCODERS: ENCODERS,
  ALLOWED_TYPES
};
