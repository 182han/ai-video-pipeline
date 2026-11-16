// ==========================================
// 小智 · 从片段库补位（P5）
// ------------------------------------------------------------
// 已定产品决策（handoff §7）：
//   「质检最多自动重试 2 次 → 从片段库补位（按 ΔE76+SSIM 选最像、必须满足时长、
//     不循环不慢放、补位率 ≤5% 且 ≤10 段）→ 仍不行才问用户；不换备用模型。」
//
// 本模块只做三件事（纯本地、零计费）：
//   1) 给候选片段打分：与失败位置左右邻居的边界帧算 SSIM / ΔE76（与接缝质检同一口径）；
//   2) 在补位上限内挑出最像的候选，并给出裁剪区间（只裁剪，不循环、不慢放）；
//   3) 把「成功片段 + 补位片段」拼成 createLibraryTask 需要的 segments（含缺口报告）。
//
// 实现说明：
//   · 帧抽取 / SSIM / ΔE76 全部走 ffmpeg，参数数组 + fd 重定向（见 proc.js）；
//   · ΔE76 公式与 qualityChecker._deltaE76FromYuv 保持一致（BT.709 + TV range → Lab）；
//   · 候选片段必须文件存在、时长足够、不是同一任务的片段；默认排除 status=failed 的片段；
//   · 没有任何左右邻居可比较时（例如整条任务只有 1 段失败且没有成功片段）不编造相似度，
//     score=null 并如实标记 boundary='none'。
// ==========================================

'use strict';

const fs = require('fs');
const path = require('path');
const proc = require('./proc');

const FILL_VERSION = 'assistant-fill.v1';
const DEFAULT_MIN_SSIM = 0.10; // 只用于标记「补得不像」，不否决（候选有限时也要有产物）
const MAX_CANDIDATE_DURATION_RATIO = 3;

function ffmpegPath() {
  return require('../../config').FFMPEG_PATH;
}
function ffprobePath() {
  return require('../../config').FFPROBE_PATH;
}

function run(exe, args, timeoutMs = 60000) {
  return proc.runToFiles(exe, args, { timeoutMs });
}

function probeDuration(filePath) {
  const r = run(ffprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath
  ], 30000);
  const v = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

function extractFrame(videoPath, tSec, outPath) {
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch (e) { /* ignore */ }
  const t = Math.max(0, Number(tSec) || 0);
  const r = run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', t.toFixed(3), '-i', videoPath, '-frames:v', '1', '-q:v', '2', outPath
  ], 45000);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 100) return null;
  return outPath;
}

// 两帧 SSIM（ffmpeg ssim 滤镜的 All 通道），失败返回 null。
function ssimOf(frameA, frameB) {
  const r = run(ffmpegPath(), [
    '-hide_banner', '-i', frameA, '-i', frameB, '-lavfi', 'ssim', '-f', 'null', '-'
  ], 45000);
  const text = String(r.stdout || '') + '\n' + String(r.stderr || '');
  const m = text.match(/All:\s*([\d.]+)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}

function parseSignalStats(text) {
  const s = String(text || '');
  const y = s.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  const u = s.match(/lavfi\.signalstats\.UAVG=([\d.]+)/);
  const v = s.match(/lavfi\.signalstats\.VAVG=([\d.]+)/);
  if (!y || !u || !v) return null;
  const Y = parseFloat(y[1]), U = parseFloat(u[1]), V = parseFloat(v[1]);
  if (![Y, U, V].every(Number.isFinite)) return null;
  return { Y, U, V };
}

function avgYuv(framePath) {
  const r = run(ffmpegPath(), [
    '-hide_banner', '-i', framePath,
    '-vf', 'signalstats,metadata=mode=print', '-f', 'null', '-'
  ], 30000);
  return parseSignalStats(String(r.stdout || '') + '\n' + String(r.stderr || ''));
}

// 与 src/qualityChecker.js 的 _deltaE76FromYuv 同一口径（BT.709 + TV range → sRGB → XYZ(D65) → Lab）。
function deltaE76(yuvA, yuvB) {
  if (!yuvA || !yuvB) return null;
  const toLab = ({ Y, U, V }) => {
    const y = (Y - 16) / 219;
    const u = (U - 128) / 224;
    const v = (V - 128) / 224;
    const clamp = (x) => Math.max(0, Math.min(1, x));
    const r = clamp(y + 1.5748 * v);
    const g = clamp(y - 0.1873 * u - 0.4681 * v);
    const bl = clamp(y + 1.8556 * u);
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const R = lin(r), G = lin(g), B = lin(bl);
    const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
    const Yl = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
    const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116);
    const fx = f(X / 0.95047), fy = f(Yl / 1.0), fz = f(Z / 1.08883);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  };
  const la = toLab(yuvA), lb = toLab(yuvB);
  const d = Math.sqrt(Math.pow(la.L - lb.L, 2) + Math.pow(la.a - lb.a, 2) + Math.pow(la.b - lb.b, 2));
  return Number.isFinite(d) ? Math.round(d * 100) / 100 : null;
}

function framesOf(videoPath, durationSec, tmpDir, tag) {
  const d = Math.max(0.2, Number(durationSec) || 0);
  const first = extractFrame(videoPath, Math.min(0.08, d / 4), path.join(tmpDir, `${tag}-first.jpg`));
  const last = extractFrame(videoPath, Math.max(0, d - 0.08), path.join(tmpDir, `${tag}-last.jpg`));
  return { first, last, yuvFirst: first ? avgYuv(first) : null, yuvLast: last ? avgYuv(last) : null };
}

function candidateList(candidates, options = {}) {
  const required = Number(options.requiredDurationSec) || 0;
  const selfTaskId = options.selfTaskId || null;
  const seen = new Set();
  const list = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || c.kind === 'final') continue;
    if (!c.filePath || !fs.existsSync(c.filePath)) continue;
    if (selfTaskId && c.taskId === selfTaskId) continue; // 同一任务的片段不拿来补自己
    if (options.allowFailed !== true && c.status === 'failed') continue;
    const key = String(c.filePath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const dur = Number(c.durationSec) || probeDuration(c.filePath);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (required > 0 && dur + 0.25 < required) continue; // 必须满足时长（只允许 0.25s 的探测误差）
    if (required > 0 && dur > required * MAX_CANDIDATE_DURATION_RATIO) continue;
    list.push({ ...c, durationSec: Math.round(dur * 1000) / 1000 });
  }
  return list;
}

/**
 * 给「失败位置」挑补位片段。
 * @param {object} opts
 *   task: { taskId, clips:[{index,status,videoPath,duration,prompt,theme}] }
 *   failedIndices?: number[]（默认从 task.clips 推断 status!=='success'）
 *   candidates: library 条目数组
 *   maxClips: 补位上限（plan.fillMaxClips）
 *   requiredDurationSec: 每段应有长度
 *   tmpDir?: 帧临时目录
 * @returns {Promise<object>}
 */
async function planFill(opts = {}) {
  const task = opts.task || {};
  const clips = Array.isArray(task.clips) ? task.clips : [];
  const required = Number(opts.requiredDurationSec) || 0;
  const maxClips = Math.max(0, Number(opts.maxClips) || 0);
  const tmpDir = opts.tmpDir || path.join(proc.tmpDir(), 'fill-' + proc.stamp());
  fs.mkdirSync(tmpDir, { recursive: true });

  const failedIndices = Array.isArray(opts.failedIndices) && opts.failedIndices.length
    ? opts.failedIndices.slice().sort((a, b) => a - b)
    : clips.filter((c) => c && c.status !== 'success').map((c) => c.index).sort((a, b) => a - b);

  if (failedIndices.length === 0) {
    return { ok: true, version: FILL_VERSION, fills: [], reason: '没有失败片段', maxClips, failedIndices: [] };
  }
  if (maxClips <= 0) {
    return {
      ok: false, version: FILL_VERSION, code: 'FILL_NOT_ALLOWED',
      error: `补位上限为 0 段（补位率 ≤5% 且 ≤10 段；本任务 ${clips.length} 段）`,
      fills: [], failedIndices, maxClips
    };
  }

  const all = candidateList(opts.candidates, {
    requiredDurationSec: required,
    selfTaskId: task.taskId,
    allowFailed: opts.allowFailed === true
  });
  if (all.length === 0) {
    return {
      ok: false, version: FILL_VERSION, code: 'FILL_NO_CANDIDATE',
      error: '片段库里没有满足时长要求的可用片段',
      fills: [], failedIndices, maxClips, candidateCount: 0
    };
  }

  // 成功片段的边界帧（邻居）：只算一次
  const successIndex = clips.filter((c) => c && c.status === 'success').map((c) => c.index).sort((a, b) => a - b);
  const frameCache = new Map();
  function successFrames(index) {
    if (frameCache.has(index)) return frameCache.get(index);
    const clip = clips.find((c) => c && c.index === index);
    if (!clip || !clip.videoPath || !fs.existsSync(clip.videoPath)) {
      frameCache.set(index, null);
      return null;
    }
    const dur = Number(clip.duration) || probeDuration(clip.videoPath) || 1;
    const f = framesOf(clip.videoPath, dur, tmpDir, `s${index}`);
    frameCache.set(index, f);
    return f;
  }

  function neighborFrames(index) {
    const prev = successIndex.filter((i) => i < index).pop();
    const next = successIndex.filter((i) => i > index)[0];
    return {
      prev: prev === undefined ? null : successFrames(prev),
      next: next === undefined ? null : successFrames(next),
      prevIndex: prev === undefined ? null : prev,
      nextIndex: next === undefined ? null : next
    };
  }

  const candFrames = new Map();
  function candidateFrames(c) {
    const key = c.filePath;
    if (candFrames.has(key)) return candFrames.get(key);
    const f = framesOf(c.filePath, c.durationSec, tmpDir, 'c' + proc.stamp());
    candFrames.set(key, f);
    return f;
  }

  const used = new Set();
  const fills = [];
  const rejected = [];

  for (const index of failedIndices) {
    if (fills.length >= maxClips) {
      rejected.push({ index, reason: `超过补位上限 ${maxClips} 段` });
      continue;
    }
    const nb = neighborFrames(index);
    let best = null;
    for (const c of all) {
      if (used.has(c.id)) continue;
      const cf = candidateFrames(c);
      const pairs = [];
      if (nb.prev && nb.prev.last && cf.first) {
        const ssim = ssimOf(nb.prev.last, cf.first);
        const de76 = deltaE76(nb.prev.yuvLast, cf.yuvFirst);
        if (ssim !== null) pairs.push({ side: 'prev', ssim, de76 });
      }
      if (nb.next && nb.next.first && cf.last) {
        const ssim = ssimOf(cf.last, nb.next.first);
        const de76 = deltaE76(cf.yuvLast, nb.next.yuvFirst);
        if (ssim !== null) pairs.push({ side: 'next', ssim, de76 });
      }
      const ssim = pairs.length ? pairs.reduce((a, p) => a + p.ssim, 0) / pairs.length : null;
      const de76s = pairs.map((p) => p.de76).filter((x) => Number.isFinite(x));
      const de76 = de76s.length ? de76s.reduce((a, b) => a + b, 0) / de76s.length : null;
      // 先按 SSIM 高者优先，再按 ΔE76 低者优先（ΔE76 归一到 100 的量级参与打分）
      const score = ssim === null ? null : Math.round((ssim - (de76 === null ? 0 : de76 / 100)) * 10000) / 10000;
      const entry = { clip: c, score, ssim, de76, sides: pairs.map((p) => p.side), boundary: pairs.length ? 'neighbors' : 'none' };
      if (!best || (entry.score !== null && (best.score === null || entry.score > best.score))) best = entry;
      // 一个邻居帧都取不到时没有可比较的相似度：按候选顺序取第一个满足时长的即可，
      // 不假装「算过相似度」（boundary='none' 会如实记进结果）。
      if (best === entry && entry.score === null) break;
    }
    if (!best) {
      rejected.push({ index, reason: '没有可用候选' });
      continue;
    }
    const cand = best.clip;
    used.add(cand.id);
    const dur = Number(cand.durationSec) || required;
    const trim = trimWindow(dur, required);
    fills.push({
      index,
      libraryId: cand.id,
      filePath: cand.filePath,
      sourceTaskId: cand.taskId || null,
      sourceDurationSec: dur,
      inSec: trim.inSec,
      outSec: trim.outSec,
      durationSec: trim.durationSec,
      score: best.score,
      ssim: best.ssim,
      de76: best.de76,
      sides: best.sides,
      boundary: best.boundary,
      lookedLike: best.ssim !== null && best.ssim < DEFAULT_MIN_SSIM ? 'low-similarity' : 'ok'
    });
  }

  const ok = fills.length > 0 && fills.length === failedIndices.length;
  return {
    ok,
    version: FILL_VERSION,
    code: ok ? null : (fills.length ? 'FILL_PARTIAL' : 'FILL_NO_MATCH'),
    error: ok ? null : (fills.length ? `只补上 ${fills.length}/${failedIndices.length} 段` : '没有匹配到可用补位片段'),
    fills,
    rejected,
    failedIndices,
    maxClips,
    candidateCount: all.length,
    fillRate: clips.length ? Math.round((fills.length / clips.length) * 10000) / 10000 : 0,
    tmpDir
  };
}

// 只裁剪、不循环、不慢放：从候选中间取一段（避免片头/片尾的黑场与淡入淡出）。
function trimWindow(sourceDurationSec, requiredSec) {
  const d = Number(sourceDurationSec) || 0;
  const need = Math.max(0.2, Math.min(Number(requiredSec) || d, d));
  const inSec = Math.max(0, Math.round(((d - need) / 2) * 1000) / 1000);
  return {
    inSec,
    outSec: Math.round((inSec + need) * 1000) / 1000,
    durationSec: Math.round(need * 1000) / 1000
  };
}

/**
 * 把成功片段 + 补位片段拼成 createLibraryTask 需要的 segments。
 * 有缺口 → ok:false，绝不拿少一段的列表去出片（那会变成「成片丢一段」的静默事故）。
 */
function assembleSegments(task, fills, options = {}) {
  const clips = Array.isArray(task && task.clips) ? task.clips.slice() : [];
  const fillByIndex = new Map((Array.isArray(fills) ? fills : []).map((f) => [f.index, f]));
  const segments = [];
  const missing = [];
  for (const clip of clips.sort((a, b) => a.index - b.index)) {
    if (clip.status === 'success' && clip.videoPath && fs.existsSync(clip.videoPath)) {
      const dur = Number(clip.duration) || probeDuration(clip.videoPath);
      segments.push({
        filePath: clip.videoPath,
        durationSec: dur,
        inSec: 0,
        outSec: null,
        prompt: clip.prompt || '',
        theme: clip.theme || null,
        libraryId: null,
        trim: null,
        cost: clip.cost || null,
        source: 'task-success'
      });
      continue;
    }
    const f = fillByIndex.get(clip.index);
    if (f) {
      segments.push({
        filePath: f.filePath,
        durationSec: f.durationSec,
        inSec: f.inSec,
        outSec: f.outSec,
        prompt: clip.prompt || '',
        theme: clip.theme || null,
        libraryId: f.libraryId,
        trim: { inSec: f.inSec, outSec: f.outSec },
        cost: null,
        source: 'library-fill'
      });
      continue;
    }
    missing.push({ index: clip.index, status: clip.status || null, error: clip.error || null });
  }
  const ok = missing.length === 0 && segments.length === clips.length;
  return {
    ok,
    code: ok ? null : 'FILL_SEGMENTS_GAP',
    error: ok ? null : `还有 ${missing.length} 段没有可用素材，不能出片`,
    segments,
    missing,
    totalDurationSec: Math.round(segments.reduce((s, x) => s + (Number(x.durationSec) || 0), 0) * 100) / 100,
    version: FILL_VERSION
  };
}

function summary(fillPlan) {
  if (!fillPlan) return null;
  return {
    ok: !!fillPlan.ok,
    code: fillPlan.code || null,
    coverage: `${(fillPlan.fills || []).length}/${(fillPlan.failedIndices || []).length}`,
    maxClips: fillPlan.maxClips,
    fills: (fillPlan.fills || []).map((f) => ({
      index: f.index,
      libraryId: f.libraryId,
      ssim: f.ssim,
      de76: f.de76,
      score: f.score,
      boundary: f.boundary,
      durationSec: f.durationSec
    })),
    rejected: fillPlan.rejected || []
  };
}

module.exports = {
  FILL_VERSION,
  FILL_RATIO_LIMIT: 0.05,
  probeDuration,
  extractFrame,
  ssimOf,
  avgYuv,
  deltaE76,
  candidateList,
  planFill,
  assembleSegments,
  trimWindow,
  summary
};
