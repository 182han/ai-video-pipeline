// ============================================================
// 剪辑台导出：工程 → 成片
// ------------------------------------------------------------
// 2026-11-04 F08：
//   - 解析 project.segments 的 assetId（片段库条目）→ 文件 + 探测信息
//   - 复用 transitionMixer（短路径/filter 文件/进度/取消），ignoreAudio=true
//   - 输出到 output/<projectId>_edit_<stamp>.mp4，原片不动
//   - 异步 job：POST 立即返回 exportId，前端轮询状态
//
// 转场关闭：2026-11-10 起支持（走 transitionMixer 的 concat 直拼分支：
//   逐段裁剪/调节照常烘焙，时长 = Σ有效时长；不再抛「暂不支持」）。
// BGM 混音 F07 接入。
// 2026-11-15 P3：导出成功后调用 library.ingestFinal（origin=editor），
//   成片直接出现在「库 · 成片」；job 返回 libraryEntryId。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const library = require('./library');
const projectStore = require('./projectStore');
const taskManager = require('./taskManager');
const audioMixer = require('./processors/audioMixer');
const transitionMixer = require('./processors/transitionMixer');

const OUTPUT_DIR = config.STORAGE.outputDir;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 20;
const jobs = new Map();

function newJobId() {
  return 'exp_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}

function pruneJobs() {
  const now = Date.now();
  const list = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  for (let i = 0; i < list.length; i++) {
    if (i >= MAX_JOBS || now - list[i].createdAt > JOB_TTL_MS) {
      jobs.delete(list[i].id);
    }
  }
}

function jobView(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    progress: Math.round((job.progress || 0) * 10) / 10,
    outputPath: job.outputPath,
    outputUrl: job.outputPath ? '/output/' + encodeURIComponent(path.basename(job.outputPath)) : null,
    taskId: job.taskId || null,
    // P3：导出成功后归入「库 · 成片」的条目 id（origin=editor）；失败/未归库时为 null
    libraryEntryId: job.libraryEntryId || null,
    durationSec: job.durationSec || null,
    encoder: job.encoder || null,
    audio: job.audio || null,
    error: job.error || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null
  };
}

function resolveSegments(project) {
  const clips = [];
  const detailCache = new Map();
  for (let i = 0; i < project.segments.length; i++) {
    const seg = project.segments[i];
    const entry = library.get(seg.assetId);
    if (!entry) {
      throw new Error(`第 ${i + 1} 段素材不存在：${seg.assetId}`);
    }
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      throw new Error(`第 ${i + 1} 段素材文件丢失：${entry.fileName || entry.id}`);
    }
    let detail = detailCache.get(entry.filePath);
    if (!detail) {
      detail = transitionMixer._probeMedia(entry.filePath);
      detailCache.set(entry.filePath, detail);
    }
    if (!detail.success) {
      throw new Error(`第 ${i + 1} 段无法探测：${detail.error}`);
    }
    const inSec = Math.max(0, Number(seg.inSec) || 0);
    const outSecRaw = seg.outSec === null || seg.outSec === undefined ? detail.duration : Number(seg.outSec);
    const outSec = Math.min(outSecRaw, detail.duration);
    if (!(outSec > inSec + 0.1)) {
      throw new Error(`第 ${i + 1} 段有效时长过短（${(outSec - inSec).toFixed(2)}s）`);
    }
    clips.push({ path: entry.filePath, inSec, outSec, detail, adjust: seg.adjust || null });
  }
  return clips;
}

// 工程音频计划 → audioMixer 的 bgmPlan 形状（音乐/环境音两轨）
function buildAudioPlan(project, duration) {
  const src = project.audio || {};
  const toSeg = (seg, kind) => {
    if (!seg || !seg.trackId) return null;
    const found = audioMixer.findTrack(seg.trackId);
    if (!found || !found.filePath) return null;
    let start = Math.max(0, Math.min(duration, Number(seg.timelineStart) || 0));
    if (start >= duration - 0.1) return null;
    // v1：音乐/环境音两轨都铺满全片；时间线变长时自动跟着延到片尾
    let end = duration;
    const trackDur = Number(found.track && found.track.durationSec) || 0;
    const sourceIn = Math.max(0, Number(seg.sourceIn) || 0);
    const sourceOut = Number(seg.sourceOut) > sourceIn
      ? Number(seg.sourceOut)
      : sourceIn + (trackDur > 0 ? trackDur : (end - start));
    return {
      trackId: seg.trackId,
      timelineStart: start,
      timelineEnd: end,
      sourceIn,
      sourceOut,
      fillMode: 'loop',
      volume: Math.max(0, Math.min(1.5, seg.volume === undefined
        ? (kind === 'ambient' ? 0.35 : 0.8)
        : Number(seg.volume))),
      fadeIn: Math.max(0, Math.min(10, Number(seg.fadeIn) || 0)),
      fadeOut: Math.max(0, Math.min(10, Number(seg.fadeOut) || 0))
    };
  };
  return {
    music: (Array.isArray(src.music) ? src.music : []).map((s) => toSeg(s, 'music')).filter(Boolean),
    ambient: (Array.isArray(src.ambient) ? src.ambient : []).map((s) => toSeg(s, 'ambient')).filter(Boolean),
    opts: src.opts || {}
  };
}

async function runJob(job, project) {
  let silentPath = null;
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const clips = resolveSegments(project);
    // 关闭转场：交给 transitionMixer 的 concat 直拼分支（F09 已接入）。
    // 时长 = Σ有效时长（不叠化、不缩短），逐段调节/裁剪照常生效。
    const name = `${project.id}_edit_${Date.now().toString(36)}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, name);
    silentPath = outputPath.replace(/\.mp4$/i, '.silent.mp4');

    job.status = 'running';
    job.progress = 0;
    const t = project.transition || {};
    // 2026-11-22：保留原声（默认开）。
    // 旧实现无条件 ignoreAudio:true —— 拼接阶段就产出无声视频，等于把成片自带的音频整条丢掉，
    // 而且界面上没有任何提示（用户反馈「自带的音频被取消了？」）。
    // 现在：工程里 audio.keepOriginal !== false 时，让 transitionMixer 保留源音轨，
    // 再把配乐叠上去（音量见 audio.originalVolume）。
    const keepOriginal = !(project.audio && project.audio.keepOriginal === false);
    const rawVol = Number(project.audio && project.audio.originalVolume);
    const originalVolume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1.5, rawVol)) : 1;
    const res = await transitionMixer.concatWithTransitions(clips, silentPath, {
      enabled: t.enabled !== false,
      duration: t.duration,
      type: t.type,
      ignoreAudio: !keepOriginal,
      signal: job.controller.signal,
      onProgress: (p) => { job.progress = typeof p.percent === 'number' ? p.percent : job.progress; }
    });

    if (job.cancelled) {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      return;
    }
    if (!res.success) {
      job.status = 'failed';
      job.error = res.error || '导出失败';
      job.finishedAt = new Date().toISOString();
      return;
    }

    // 音频：音乐/环境音两轨 + （可选）输入自带音轨
    const plan = buildAudioPlan(project, res.actualDuration);
    let audioInfo = { music: 0, ambient: 0, meanVolumeDb: null, keepOriginal, originalVolume };
    if (plan.music.length || plan.ambient.length) {
      job.progress = 92;
      const mixed = await audioMixer.mixBgmPlan(silentPath, outputPath, plan, {
        keepSourceAudio: keepOriginal,
        sourceVolume: originalVolume,
        onProgress: (p) => {
          const pct = p && typeof p.percent === 'number' ? p.percent : 0;
          job.progress = Math.min(99, 92 + pct * 0.07);
        }
      });
      if (!mixed.success) throw new Error('配乐混音失败: ' + mixed.error);
      try { fs.unlinkSync(silentPath); } catch (e) { /* ignore */ }
      silentPath = null;
      audioInfo = {
        music: plan.music.length,
        ambient: plan.ambient.length,
        meanVolumeDb: mixed.meanVolumeDb,
        keepOriginal,
        originalVolume,
        keptSourceAudio: mixed.keptSourceAudio === true,
        warnings: mixed.warnings || []
      };
    } else {
      // 没有配乐：保留原声时这里已经带着源音轨，直接改名即可（旧实现会得到无声视频）。
      fs.renameSync(silentPath, outputPath);
      silentPath = null;
    }

    job.status = 'done';
    job.progress = 100;
    job.outputPath = outputPath;
    job.durationSec = res.actualDuration;
    job.encoder = res.encoder || null;
    job.audio = audioInfo;
    job.finishedAt = new Date().toISOString();

    // 登记成一条「剪辑台导出」任务，让产出/历史页可见（2026-11-04 F08 收尾）
    try {
      const editorTask = taskManager.createEditorTask({
        projectId: project.id,
        name: '剪辑台 · ' + (project.name || '未命名工程'),
        outputPath,
        durationSec: res.actualDuration,
        segmentCount: project.segments.length,
        resolution: res.target && res.target.label ? String(res.target.label).toUpperCase() : undefined
      });
      job.taskId = editorTask.taskId;

      // P3：剪辑导出的成片必须出现在「库 · 成片」（origin=editor），
      // 否则导出后只能靠回填脚本才看得到（旧行为）。
      // 费用口径：导出本身是本地 ffmpeg，不产生生成费用；源片段费用已记在各片段条目上。
      editorTask.cost = {
        amount: 0,
        currency: 'CNY',
        basis: 'final',
        computed: true,
        label: '剪辑导出（无生成费用）'
      };
      const entry = library.ingestFinal(editorTask, outputPath);
      if (entry) job.libraryEntryId = entry.id;
    } catch (e) {
      console.warn('[editor] 登记导出任务/成片入库失败: ' + (e && e.message));
    }

    projectStore.appendExport(project.id, {
      exportId: job.id,
      taskId: job.taskId || null,
      at: job.finishedAt,
      outputName: name,
      durationSec: res.actualDuration,
      encoder: res.encoder || null
    });
  } catch (e) {
    try { if (silentPath && fs.existsSync(silentPath)) fs.unlinkSync(silentPath); } catch (e2) { /* ignore */ }
    if (job.cancelled) {
      job.status = 'cancelled';
    } else {
      job.status = 'failed';
      job.error = e && e.message ? e.message : String(e);
    }
    job.finishedAt = new Date().toISOString();
  }
}

function startExport(projectId) {
  const project = projectStore.get(projectId);
  if (!project || !Array.isArray(project.segments) || project.segments.length === 0) {
    throw new Error('工程还没有片段，无法导出');
  }
  pruneJobs();
  const job = {
    id: newJobId(),
    projectId,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outputPath: null,
    durationSec: null,
    encoder: null,
    taskId: null,
    libraryEntryId: null,
    error: null,
    cancelled: false,
    controller: new AbortController()
  };
  jobs.set(job.id, job);
  runJob(job, project);
  return jobView(job);
}

function getJob(projectId, exportId) {
  const job = jobs.get(exportId);
  if (!job || job.projectId !== projectId) return null;
  return jobView(job);
}

function cancelExport(projectId, exportId) {
  const job = jobs.get(exportId);
  if (!job || job.projectId !== projectId) return null;
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return jobView(job);
  job.cancelled = true;
  try { job.controller.abort(); } catch (e) { /* ignore */ }
  return jobView(job);
}

module.exports = {
  startExport,
  getJob,
  cancelExport,
  _jobs: jobs
};
