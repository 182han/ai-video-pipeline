// ==========================================
// 配乐混音模块 - 音轨库管理 + FFmpeg 混音
// ==========================================
// 链路（2026-10-19 配乐改造后）：整片多轨时间轴 → 每段 atrim/atempo/volume/afade →
//   adelay 对齐 → amix 多轨 → loudnorm(I=-20) 整体归一 → 单次 AAC 编码
// 已移除：逐片段混音、aloop 2 秒循环、按主题自动选曲（主题匹配无法表达「一段视频多个主题」）
// 音源授权：incompetech（CC BY 4.0，需署名 Kevin MacLeod）+ Pixabay（Content License 免署名）

const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const config = require('../../config');

const BGM_DIR = path.join(__dirname, '..', '..', 'assets', 'bgm');
const MANIFEST_PATH = path.join(BGM_DIR, 'manifest.json');

// mood 标签仍然保留（用于库存筛选展示），但**不再作为自动选曲依据**。
// 原因：一段成片通常包含多个主题，用单个主题反推 mood 会导致选曲与画面不符。

let _manifestCache = null;

// 大标签（介质分类）：music 轻音乐 / ambient 环境音
// 目录 nature/ 自动归为 ambient，新增音轨必须显式传 category
function _inferCategory(track) {
  if (track.category) return track.category;
  return String(track.file || '').startsWith('nature/') ? 'ambient' : 'music';
}

function _saveManifest(tracks) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(tracks, null, 2), 'utf8');
  _manifestCache = tracks;
  return tracks;
}

function getTrackById(id) {
  return getManifest().find(t => t.id === id) || null;
}

function getManifest() {
  if (_manifestCache) return _manifestCache;
  try {
    _manifestCache = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    _manifestCache = [];
    console.error('读取配乐清单失败:', e.message);
  }
  return _manifestCache;
}

// 按 mood / category 过滤音轨（参数可为空，返回全部）
function listTracks(mood, category) {
  let tracks = getManifest();
  if (mood) tracks = tracks.filter(t => (t.mood || []).some(m => m === mood));
  if (category) tracks = tracks.filter(t => _inferCategory(t) === category);
  return tracks;
}

// 公开展示用：补上 category 大标签（music/ambient）
function toPublicTracks(mood, category) {
  return listTracks(mood, category).map(t => ({ ...t, category: _inferCategory(t) }));
}

// 按 id 找音轨，返回 { track, filePath }
function findTrack(trackId) {
  const track = getManifest().find(t => t.id === trackId);
  if (!track) return null;
  return { track, filePath: path.join(BGM_DIR, track.file) };
}

// 「auto」的含义已变更：不再按主题匹配，改为在轻音乐池里随机取一首
// （用户若设置了默认开场曲，由 buildAutoPlan 优先使用它）
function pickRandomMusicTrack() {
  const pool = listTracks(null, 'music');
  if (pool.length === 0) return null;
  const track = pool[Math.floor(Math.random() * pool.length)];
  return { track, filePath: path.join(BGM_DIR, track.file) };
}

// 解析音轨参数：trackId | 'auto' | 空 → 返回 { track, filePath }
// 注意：theme 参数仅为兼容旧调用保留，不再参与选曲。
function resolveTrack(trackArg) {
  if (!trackArg || trackArg === 'auto') {
    return pickRandomMusicTrack();
  }
  return findTrack(trackArg);
}

// ffprobe 探测媒体时长（秒）
// 说明：某些受限执行环境（沙箱/CI）禁止 child_process 管道捕获，会抛 spawn EPERM。
// 这里保留 execFile 主路径，EPERM 时降级为「用 shell 重定向到临时文件再读」，
// 与 src/qualityChecker.js 的 _exec() 同一套路，保证换环境也能跑通。
function probeDuration(mediaPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = config.FFPROBE_PATH || 'ffprobe';
    const fallback = () => {
      try {
        resolve(_probeDurationFallback(ffprobe, mediaPath));
      } catch (e2) {
        reject(new Error('无法读取时长（环境禁止子进程管道捕获）: ' + mediaPath));
      }
    };
    // 注意：受限环境里 execFile 可能「同步抛 EPERM」而不是走回调，
    // 所以必须把它包在 try 里，否则 Promise 直接 reject，降级路径永远执行不到。
    let child;
    try {
      child = execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath], (err, stdout) => {
        if (!err) {
          const dur = parseFloat(String(stdout).trim());
          if (isNaN(dur)) return reject(new Error('无法解析时长: ' + mediaPath));
          return resolve(dur);
        }
        // 仅对「环境限制」类错误做降级；文件不存在等真实错误直接抛
        const code = err && (err.code || '');
        if (code !== 'EPERM' && code !== 'EACCES') return reject(err);
        fallback();
      });
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return fallback();
      return reject(e);
    }
    if (child && child.on) child.on('error', () => {});
  });
}

// 降级探测：把 stdout 重定向到临时文件再读（出片目录内，避免系统临时目录受限）
function _probeDurationFallback(ffprobe, mediaPath) {
  const os = require('os');
  const outDir = path.join(__dirname, '..', '..', 'output');
  const tmp = path.join(outDir, `_probe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    execSync(`${q(ffprobe)} -v error -show_entries format=duration -of csv=p=0 ${q(mediaPath)} > ${q(tmp)} 2>&1`, { stdio: 'ignore' });
  } catch (e) {
    // ffprobe 无输出参数时可能非 0 退出，产物仍可能已写入，继续读
  }
  try {
    if (!fs.existsSync(tmp)) throw new Error('探测临时文件未生成');
    const dur = parseFloat(String(fs.readFileSync(tmp, 'utf8')).trim());
    if (isNaN(dur)) throw new Error('无法解析时长: ' + mediaPath);
    return dur;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

// ===== 混音产物校验（P0-1）=====
// 背景：ffmpeg 混音即使产出静音文件，退出码仍为 0（"静默成功"），
// 因此必须对产物做实测校验，不能只看退出码。
// loudnorm 目标 -20 LUFS，正常配乐 mean_volume 远高于 -85 dB；低于该值即视为静音。
const SILENCE_DB = -85;

// 统一的探测执行器：优先 execFile 捕获管道输出；
// 遇到环境限制（EPERM/EACCES）时降级为「shell 重定向到临时文件再读」，保证换环境可跑。
// 返回 { ok, out }：out 为 stdout+stderr 合并文本。
function _runProbe(bin, args) {
  return new Promise((resolve) => {
    const fallback = () => {
      try {
        const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
        const outDir = path.join(__dirname, '..', '..', 'output');
        const tmp = path.join(outDir, `_probe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
        const cmd = [q(bin)].concat(args.map(q)).join(' ') + ` > ${q(tmp)} 2>&1`;
        try { execSync(cmd, { stdio: 'ignore' }); } catch (e2) { /* 探测类命令常非 0 退出 */ }
        const text = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
        try { fs.unlinkSync(tmp); } catch (e3) {}
        resolve({ ok: text.length > 0, out: text });
      } catch (e4) {
        resolve({ ok: false, out: '' });
      }
    };
    try {
      execFile(bin, args, (err, stdout, stderr) => {
        const out = String(stdout || '') + '\n' + String(stderr || '');
        if (!err) return resolve({ ok: true, out });
        const code = err && (err.code || '');
        if (code !== 'EPERM' && code !== 'EACCES') return resolve({ ok: false, out });
        fallback();
      });
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return fallback();
      resolve({ ok: false, out: '' });
    }
  });
}

// 探测媒体是否含音频流
async function probeHasAudioStream(mediaPath) {
  const ffprobe = config.FFPROBE_PATH || 'ffprobe';
  const r = await _runProbe(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mediaPath]);
  if (!r.ok) return false;
  return String(r.out || '').trim().length > 0;
}

// 探测平均音量（dB；纯静音为 -inf）；失败返回 null
async function probeMeanVolume(mediaPath) {
  const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
  const r = await _runProbe(ffmpeg, ['-hide_banner', '-i', mediaPath, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = String(r.out || '').match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  return m ? m[1] : null;
}

// 清理残缺产物（失败时不留坏文件）
function cleanupFile(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
}

// 校验混音产物：存在 + 体积正常 + 有音频流 + 非静音
async function validateMixedOutput(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: '产物不存在' };
  const size = fs.statSync(filePath).size;
  if (size < 10240) return { ok: false, reason: `产物过小(${size}B)` };

  const hasAudio = await probeHasAudioStream(filePath);
  if (!hasAudio) return { ok: false, reason: '产物无音频流' };

  const mean = await probeMeanVolume(filePath);
  if (mean === null) return { ok: false, reason: '无法探测音量' };
  const db = String(mean).toLowerCase() === '-inf' ? -Infinity : parseFloat(mean);
  if (!isFinite(db) || db <= SILENCE_DB) {
    return { ok: false, reason: `产物静音 (mean_volume=${mean} dB)` };
  }
  return { ok: true, meanVolume: mean };
}

// ===== 整片多轨配乐混音 =====
// 设计原则：预览与导出走同一个引擎（本函数），保证「听到的 = 导出的」。
// 浏览器只负责把时间轴编辑结果变成 plan（JSON），不做任何音频计算。
//
// plan 结构见 processors/bgmPlan.js 顶部注释。
// opts: { loudness, ambientVolume, onProgress, keepOriginalAudio }

// 校验混音产物：在既有校验之外，增加「时长必须与成片一致」这一项。
// 历史事故：ffmpeg 退出码为 0 但产物被截断/静音，必须实测拦截。
async function validateMixDuration(filePath, expectedDuration, toleranceSec = 0.15) {
  const actual = await probeDuration(filePath).catch(() => 0);
  if (!(actual > 0)) return { ok: false, reason: '无法探测混音产物时长' };
  if (expectedDuration > 0 && Math.abs(actual - expectedDuration) > toleranceSec) {
    return {
      ok: false,
      reason: `混音产物时长异常 (${actual.toFixed(2)}s，期望 ${expectedDuration.toFixed(2)}s，容差 ±${toleranceSec}s)`
    };
  }
  return { ok: true, actual };
}

// 生成完整 ffmpeg 参数（供混音与「仅预演」共用，不产生副作用）
function buildMixArgs(inputVideo, outputPath, plan, videoDuration, opts = {}) {
  const planner = require('./bgmPlan');
  const built = planner.buildMixCommand(plan, videoDuration, {
    loudness: opts.loudness === undefined ? -20 : Number(opts.loudness),
    ambientVolume: opts.ambientVolume === undefined ? 0.125 : Number(opts.ambientVolume)
  });
  if (!built.ok) return { ok: false, error: built.error, warnings: built.warnings || [] };

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-stats_period', '1', '-i', inputVideo];
  for (const t of built.inputTracks) args.push('-i', t);
  args.push(
    '-filter_complex', built.filterComplex,
    '-map', '0:v', '-map', built.audioMap,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', String(videoDuration),
    '-movflags', '+faststart',
    outputPath
  );
  return { ok: true, args, warnings: built.warnings, inputTracks: built.inputTracks };
}

// 把 plan 里各片段的 trackId 解析成真实文件路径（未解析的会被标出）
function resolvePlanPaths(plan) {
  const out = { music: [], ambient: [], missing: [] };
  const fill = (list, target) => {
    for (const seg of (Array.isArray(list) ? list : [])) {
      const found = findTrack(seg.trackId);
      if (!found || !fs.existsSync(found.filePath)) {
        out.missing.push(seg.trackId);
        continue;
      }
      target.push({ ...seg, filePath: found.filePath });
    }
  };
  fill(plan && plan.music, out.music);
  fill(plan && plan.ambient, out.ambient);
  return out;
}

// 执行整片混音：视频 copy、音频单次编码
async function mixBgmPlan(inputVideo, outputPath, plan, opts = {}) {
  const videoDuration = await probeDuration(inputVideo).catch(() => 0);
  if (!(videoDuration > 0)) return { success: false, error: '无法读取成片时长' };

  const resolvedPlan = resolvePlanPaths(plan || {});
  if (resolvedPlan.missing.length > 0) {
    return { success: false, error: '音轨不存在: ' + resolvedPlan.missing.join(', ') };
  }
  if (resolvedPlan.music.length === 0 && resolvedPlan.ambient.length === 0) {
    return { success: false, error: '配乐计划为空（没有任何音频片段）' };
  }

  const built = buildMixArgs(inputVideo, outputPath, resolvedPlan, videoDuration, opts);
  if (!built.ok) return { success: false, error: built.error, warnings: built.warnings };

  const runResult = await runFfmpeg(built.args, videoDuration, opts.onProgress);
  if (!runResult.ok) {
    cleanupFile(outputPath);
    return { success: false, error: '混音失败: ' + runResult.error };
  }

  // 双重校验：退出码为 0 不等于结果正确
  const check = await validateMixedOutput(outputPath);
  if (!check.ok) {
    cleanupFile(outputPath);
    return { success: false, error: '混音产物校验未通过: ' + check.reason };
  }
  const durCheck = await validateMixDuration(outputPath, videoDuration);
  if (!durCheck.ok) {
    cleanupFile(outputPath);
    return { success: false, error: durCheck.reason };
  }

  return {
    success: true,
    outputPath,
    videoDurationSec: videoDuration,
    outputDurationSec: durCheck.actual,
    meanVolumeDb: check.meanVolume,
    warnings: built.warnings || [],
    segments: resolvedPlan.music.length + resolvedPlan.ambient.length
  };
}

// 统一 ffmpeg 执行 + 进度回调
function runFfmpeg(args, totalDuration, onProgress) {
  return new Promise((resolve) => {
    const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
    // 受限环境里 execFile 可能同步抛 EPERM（而不是回调），降级为同步执行。
    // 代价是拿不到进度回调，但混音本身能完成。
    const fallback = () => {
      try {
        const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
        execSync([q(ffmpeg)].concat(args.map(q)).join(' '), { stdio: 'ignore' });
        resolve({ ok: true, fallback: true });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    };
    let proc;
    try {
      proc = execFile(ffmpeg, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: (stderr && String(stderr).slice(-800)) || err.message });
        resolve({ ok: true });
      });
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return fallback();
      return resolve({ ok: false, error: e.message });
    }
    if (!proc || !proc.stderr) return;
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      if (typeof onProgress === 'function' && totalDuration > 0) {
        const m = stderrBuf.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
        if (m && m.length > 0) {
          const last = m[m.length - 1];
          const parts = last.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (parts) {
            const sec = parseInt(parts[1], 10) * 3600 + parseInt(parts[2], 10) * 60 + parseFloat(parts[3]);
            onProgress(Math.min(100, Math.round((sec / totalDuration) * 100)));
          }
        }
      }
      if (stderrBuf.length > 10240) stderrBuf = stderrBuf.slice(-10240);
    });
  });
}

// ===== 自动配乐：按用户勾选生成整片计划 =====
// 规则（产品已确认）：
//  - 用户可勾选「轻音乐」「环境音」，可只勾其一，也可两个都勾
//  - 轻音乐：一首放完按库存顺序接下一首（不循环），跨曲重叠 crossfadeSec 实现自然衔接
//  - 环境音：选一首，**整片循环**（环境音是持续声场，循环比换曲合适）
//  - 两者同时存在时，环境音在混音阶段被压到 ambientVolume（默认 0.125 ≈ -18dB）垫底
//  - 有「默认开场曲」就从它开始，否则随机
// options: { wantMusic, wantAmbient, order, defaultTrackId, ambientTrackId, fadeInSec, fadeOutSec, crossfadeSec }
function buildAutoPlan(videoDuration, options = {}) {
  const crossfadeSec = Number.isFinite(Number(options.crossfadeSec)) ? Number(options.crossfadeSec) : 1.5;
  const fadeInSec = Number.isFinite(Number(options.fadeInSec)) ? Number(options.fadeInSec) : 2;
  const fadeOutSec = Number.isFinite(Number(options.fadeOutSec)) ? Number(options.fadeOutSec) : 2;

  // 默认都勾轻音乐（保持旧调用方的行为），显式传 false 才关闭
  const wantMusic = options.wantMusic === undefined ? true : !!options.wantMusic;
  const wantAmbient = options.wantAmbient === undefined ? false : !!options.wantAmbient;
  if (!wantMusic && !wantAmbient) {
    return { ok: false, error: '自动配乐需要至少勾选「轻音乐」或「环境音」' };
  }

  const warnings = [];
  const musicSegments = [];
  const ambientSegments = [];

  // ---------- 轻音乐：整片按顺序铺满 ----------
  if (wantMusic) {
    const musicPool = listTracks(null, 'music').filter(t => t && t.file);
    if (musicPool.length === 0) {
      warnings.push('库存中没有轻音乐，已跳过轻音乐轨');
    } else {
      // 顺序：优先用调用方给的顺序（用户自定义），否则 manifest 顺序
      let ordered = musicPool;
      if (Array.isArray(options.order) && options.order.length > 0) {
        const byId = new Map(musicPool.map(t => [t.id, t]));
        const picked = options.order.map(id => byId.get(id)).filter(Boolean);
        const rest = musicPool.filter(t => !options.order.includes(t.id));
        ordered = picked.concat(rest);
      }

      // 起点：默认开场曲优先，否则随机
      let startIdx = 0;
      if (options.defaultTrackId) {
        const i = ordered.findIndex(t => t.id === options.defaultTrackId);
        if (i >= 0) startIdx = i;
      } else {
        startIdx = Math.floor(Math.random() * ordered.length);
      }

      let cursor = 0;
      let guard = 0;
      const maxSegments = 500; // 防御：避免异常输入导致无限循环
      while (cursor < videoDuration - 0.05 && guard < maxSegments) {
        guard++;
        const track = ordered[(startIdx + musicSegments.length) % ordered.length];
        const trackDur = Number(track.durationSec) || 0;
        const available = trackDur > 0 ? trackDur : Math.min(videoDuration - cursor, 60);
        const isFirst = musicSegments.length === 0;
        // 非首段开头留出交叉时间（跨曲衔接在时间轴上靠重叠实现）
        const start = isFirst ? 0 : Math.max(0, cursor - crossfadeSec);
        const end = Math.min(videoDuration, start + available);
        if (end - start <= 0.05) break;

        musicSegments.push({
          id: 'auto_m' + musicSegments.length,
          trackId: track.id,
          timelineStart: Math.round(start * 1000) / 1000,
          timelineEnd: Math.round(end * 1000) / 1000,
          sourceIn: 0,
          sourceOut: Math.round((end - start) * 1000) / 1000,
          volume: 1,
          fadeIn: isFirst ? fadeInSec : crossfadeSec,
          fadeOut: crossfadeSec,
          speed: 1,
          fillMode: 'none'
        });
        cursor = end;
      }

      // 末段收尾：如果正好铺满，用完整淡出
      const last = musicSegments[musicSegments.length - 1];
      if (last && last.timelineEnd >= videoDuration - 0.05) last.fadeOut = fadeOutSec;

      const covered = Math.min(cursor, videoDuration);
      if (covered + 0.05 < videoDuration) {
        warnings.push(`轻音乐素材总长 ${covered.toFixed(1)}s 短于成片 ${videoDuration.toFixed(1)}s，末尾 ${(videoDuration - covered).toFixed(1)}s 无轻音乐`);
      }
    }
  }

  // ---------- 环境音：选一首，整片循环 ----------
  if (wantAmbient) {
    const ambientPool = listTracks(null, 'ambient').filter(t => t && t.file);
    if (ambientPool.length === 0) {
      warnings.push('库存中没有环境音，已跳过环境音轨');
    } else {
      // 指定优先，否则随机选一首
      let track = null;
      if (options.ambientTrackId) {
        track = ambientPool.find(t => t.id === options.ambientTrackId) || null;
      }
      if (!track) track = ambientPool[Math.floor(Math.random() * ambientPool.length)];

      const trackDur = Number(track.durationSec) || 0;
      // 整片循环：片段铺满成片，fillMode=loop 让 ffmpeg 循环源音频填满片段时长。
      // 若源音频本身比成片长，则不循环（loop 分支在源足够长时不会触发）。
      ambientSegments.push({
        id: 'auto_a0',
        trackId: track.id,
        timelineStart: 0,
        timelineEnd: Math.round(videoDuration * 1000) / 1000,
        sourceIn: 0,
        sourceOut: Math.round((trackDur > 0 ? Math.min(trackDur, videoDuration) : videoDuration) * 1000) / 1000,
        volume: 1,
        fadeIn: fadeInSec,
        fadeOut: fadeOutSec,
        speed: 1,
        fillMode: 'loop'
      });
    }
  }

  if (musicSegments.length === 0 && ambientSegments.length === 0) {
    return { ok: false, error: warnings.length ? warnings.join('；') : '无法生成自动配乐计划', warnings };
  }

  const musicCovered = musicSegments.length
    ? Math.min(musicSegments[musicSegments.length - 1].timelineEnd, videoDuration)
    : 0;

  return {
    ok: true,
    plan: { music: musicSegments, ambient: ambientSegments },
    coveredSec: Math.round(Math.max(musicCovered, ambientSegments.length ? videoDuration : 0) * 100) / 100,
    shortfallSec: Math.max(0, Math.round((videoDuration - musicCovered) * 100) / 100),
    trackIds: musicSegments.map(s => s.trackId),
    ambientTrackId: ambientSegments.length ? ambientSegments[0].trackId : null,
    warnings
  };
}
// ===== 旧接口兼容：单曲整片混音（供 /api/bgm/mix 演示接口使用）=====
// 注意：这里已不使用 aloop 循环，改为「整曲 + 淡入淡出」。
async function mixBgm(inputVideo, outputPath, opts = {}) {
  const { track: trackArg = 'auto', theme = '', loudness = -20, fadeSeconds = 2 } = opts;
  const resolved = resolveTrack(trackArg, theme);
  if (!resolved) {
    return { success: false, error: '配乐库存为空，请先入库音源' };
  }
  if (!fs.existsSync(resolved.filePath)) {
    return { success: false, error: `音轨文件不存在: ${resolved.track.file}` };
  }

  const videoDuration = await probeDuration(inputVideo);
  const fade = Math.min(fadeSeconds, videoDuration / 4);
  const plan = {
    music: [{
      id: 'legacy',
      trackId: resolved.track.id,
      timelineStart: 0,
      timelineEnd: videoDuration,
      sourceIn: 0,
      sourceOut: Math.min(videoDuration, Number(resolved.track.durationSec) || videoDuration),
      volume: 1,
      fadeIn: fade,
      fadeOut: fade,
      speed: 1,
      fillMode: 'none'
    }],
    ambient: []
  };
  const r = await mixBgmPlan(inputVideo, outputPath, plan, { loudness, onProgress: opts.onProgress });
  if (!r.success) return { success: false, error: r.error };
  return {
    success: true,
    outputPath,
    trackId: resolved.track.id,
    trackTitle: resolved.track.title,
    mood: resolved.track.mood,
    videoDurationSec: videoDuration,
    meanVolumeDb: r.meanVolumeDb
  };
}

// 旧实现（保留以便回溯对照，已不再调用；2026-10-19 配乐改造移除 aloop 循环）
async function _legacyMixBgmWithAloop(inputVideo, outputPath, opts = {}) {
  const { track: trackArg = 'auto', theme = '', loudness = -20, fadeSeconds = 2 } = opts;
  const resolved = resolveTrack(trackArg, theme);
  if (!resolved) {
    return { success: false, error: '配乐库存为空，请先入库音源' };
  }
  if (!fs.existsSync(resolved.filePath)) {
    return { success: false, error: `音轨文件不存在: ${resolved.track.file}` };
  }

  const videoDuration = await probeDuration(inputVideo);
  const fade = Math.min(fadeSeconds, videoDuration / 4);
  const fadeOutStart = Math.max(0, videoDuration - fade);
  const TARGET_SAMPLE_RATE = 44100;
  const loopSize = Math.round(2 * TARGET_SAMPLE_RATE);

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats_period', '1',
    '-i', inputVideo, '-i', resolved.filePath,
    '-filter_complex',
    `[1:a]loudnorm=I=${loudness}:TP=-1.5:LRA=11,aformat=sample_rates=${TARGET_SAMPLE_RATE},` +
    `aloop=loop=-1:size=${loopSize},` +
    `afade=t=in:st=0:d=${fade},afade=t=out:st=${fadeOutStart}:d=${fade}[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac',
    '-t', String(videoDuration),
    '-movflags', '+faststart',
    outputPath
  ];

  return new Promise((resolve) => {
    const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
    const proc = execFile(ffmpeg, args, { maxBuffer: 10 * 1024 * 1024 }, async (err) => {
      if (err) {
        cleanupFile(outputPath);
        resolve({ success: false, error: '混音失败: ' + err.message });
      } else {
        // P0-1：退出码为 0 也可能产出静音，必须实测校验后才算成功
        const check = await validateMixedOutput(outputPath);
        if (!check.ok) {
          cleanupFile(outputPath);
          resolve({ success: false, error: '混音产物校验未通过: ' + check.reason });
        } else {
          resolve({
            success: true,
            outputPath,
            trackId: resolved.track.id,
            trackTitle: resolved.track.title,
            mood: resolved.track.mood,
            videoDurationSec: videoDuration,
            meanVolumeDb: check.meanVolume
          });
        }
      }
    });

    // 解析 stderr 中的 time= 进度
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const m = stderrBuf.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
      if (m && m.length > 0 && typeof opts.onProgress === 'function') {
        const last = m[m.length - 1];
        const parts = last.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (parts) {
          const sec = parseInt(parts[1], 10) * 3600 + parseInt(parts[2], 10) * 60 + parseFloat(parts[3]);
          opts.onProgress(Math.min(100, Math.round((sec / videoDuration) * 100)));
        }
      }
      if (stderrBuf.length > 10240) stderrBuf = stderrBuf.slice(-10240);
    });
  });
}

// ===== 配乐库存管理（上传/编辑/删除） =====
const CUSTOM_DIR = path.join(BGM_DIR, 'custom');
const ALLOWED_EXT = ['.mp3', '.wav', '.m4a', '.ogg'];

function _genId() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 3);
}

// 上传入库：fileData 为 base64 dataUrl 或裸 base64，写入 custom/ 目录 + append manifest
function addTrack(data = {}) {
  if (!data.fileData || !String(data.fileData).trim()) return { success: false, error: '缺少音频文件' };
  const raw = String(data.fileData);
  const m = /^data:audio\/[a-zA-Z0-9+.]+;base64,(.*)$/.exec(raw);
  const body = m ? m[1] : raw;
  const name = String(data.fileName || '');
  const nameExt = name ? path.extname(name).toLowerCase() : '';
  const ext = (nameExt && ALLOWED_EXT.includes(nameExt)) ? nameExt : '.mp3';
  if (!ALLOWED_EXT.includes(ext)) return { success: false, error: '仅支持 mp3/wav/m4a/ogg 格式' };

  if (!fs.existsSync(CUSTOM_DIR)) fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  const id = _genId();
  const rel = 'custom/' + id + ext;
  fs.writeFileSync(path.join(BGM_DIR, rel), Buffer.from(body, 'base64'));

  const track = {
    id,
    file: rel,
    title: data.title ? String(data.title).trim() : '未命名音轨',
    author: data.author ? String(data.author).trim() : '',
    source: data.source ? String(data.source).trim() : '自定义',
    sourceUrl: data.sourceUrl ? String(data.sourceUrl).trim() : '',
    license: data.license ? String(data.license).trim() : '',
    licenseUrl: data.licenseUrl ? String(data.licenseUrl).trim() : '',
    category: data.category === 'ambient' ? 'ambient' : 'music',
    mood: Array.isArray(data.mood) ? data.mood.filter(Boolean) : [],
    durationSec: Number(data.durationSec) || 0,
    bpm: data.bpm ? Number(data.bpm) : null,
    instruments: data.instruments ? String(data.instruments).trim() : '',
    note: data.note ? String(data.note).trim() : ''
  };
  const tracks = getManifest();
  tracks.push(track);
  _saveManifest(tracks);
  return { success: true, track };
}

function updateTrack(id, fields = {}) {
  const tracks = getManifest();
  const t = tracks.find(x => x.id === id);
  if (!t) return { success: false, error: '音轨不存在' };
  ['title', 'author', 'source', 'sourceUrl', 'license', 'licenseUrl', 'instruments', 'note'].forEach(k => {
    if (fields[k] !== undefined) t[k] = String(fields[k]).trim();
  });
  if (fields.category !== undefined) t.category = fields.category === 'ambient' ? 'ambient' : 'music';
  if (fields.mood !== undefined) t.mood = Array.isArray(fields.mood) ? fields.mood.filter(Boolean) : t.mood;
  if (fields.bpm !== undefined) t.bpm = fields.bpm ? Number(fields.bpm) : null;
  if (fields.durationSec !== undefined) t.durationSec = Number(fields.durationSec) || t.durationSec;
  _saveManifest(tracks);
  return { success: true, track: t };
}

function removeTrack(id) {
  const tracks = getManifest();
  const t = tracks.find(x => x.id === id);
  if (!t) return { success: false, error: '音轨不存在' };
  // 仅删除自定义上传文件，内置音轨保留磁盘文件
  if (String(t.file).startsWith('custom/')) {
    const abs = path.join(BGM_DIR, t.file);
    if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (e) {} }
  }
  _saveManifest(tracks.filter(x => x.id !== id));
  return { success: true };
}

// ===== 音轨顺序与默认开场曲（用户自定义，存本地配置文件）=====
// 说明：顺序影响自动配乐的接续顺序；默认开场曲是自动配乐的起点。
const PREFS_PATH = path.join(BGM_DIR, 'prefs.json');

function getPrefs() {
  try {
    if (!fs.existsSync(PREFS_PATH)) return { order: [], defaultTrackId: null };
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
    return {
      order: Array.isArray(raw.order) ? raw.order.filter(Boolean) : [],
      defaultTrackId: raw.defaultTrackId || null
    };
  } catch (e) {
    console.error('读取配乐偏好失败:', e.message);
    return { order: [], defaultTrackId: null };
  }
}

function savePrefs(fields = {}) {
  const cur = getPrefs();
  const next = {
    order: Array.isArray(fields.order) ? fields.order.filter(Boolean) : cur.order,
    defaultTrackId: fields.defaultTrackId !== undefined ? (fields.defaultTrackId || null) : cur.defaultTrackId
  };
  // 只保留清单里真实存在的音轨 id，避免脏数据
  const ids = new Set(getManifest().map(t => t.id));
  next.order = next.order.filter(id => ids.has(id));
  if (next.defaultTrackId && !ids.has(next.defaultTrackId)) next.defaultTrackId = null;
  fs.writeFileSync(PREFS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// 按用户自定义顺序重排音轨列表（未出现在 order 里的排在后面）
function listTracksInOrder(category) {
  const list = listTracks(null, category);
  const { order } = getPrefs();
  if (!order.length) return list;
  const pos = new Map(order.map((id, i) => [id, i]));
  return list.slice().sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return list.indexOf(a) - list.indexOf(b);
  });
}

module.exports = {
  getManifest, listTracks, listTracksInOrder, toPublicTracks, findTrack, resolveTrack, pickRandomMusicTrack,
  getTrackById, addTrack, updateTrack, removeTrack,
  probeDuration, probeMeanVolume, validateMixedOutput, validateMixDuration,
  mixBgm, mixBgmPlan, buildMixArgs, resolvePlanPaths, buildAutoPlan, runFfmpeg,
  getPrefs, savePrefs,
  BGM_DIR, PREFS_PATH
};
