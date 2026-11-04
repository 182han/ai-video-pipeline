// ============================================================
// 剪辑台导出：工程 → 成片
// ------------------------------------------------------------
// 2026-11-04 F08：
//   - 解析 project.segments 的 assetId（片段库条目）→ 文件 + 探测信息
//   - 复用 transitionMixer（短路径/filter 文件/进度/取消），ignoreAudio=true
//   - 输出到 output/<projectId>_edit_<stamp>.mp4，原片不动
//   - 异步 job：POST 立即返回 exportId，前端轮询状态
//
// 限制（M1）：转场关闭暂不支持（F09 再做）；BGM 混音 F07 接入。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const library = require('./library');
const projectStore = require('./projectStore');
const taskManager = require('./taskManager');
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
    durationSec: job.durationSec || null,
    encoder: job.encoder || null,
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

async function runJob(job, project) {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const clips = resolveSegments(project);
    if (project.transition && project.transition.enabled === false) {
      throw new Error('转场关闭暂不支持（F09 接入后再导出）');
    }
    const name = `${project.id}_edit_${Date.now().toString(36)}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, name);

    job.status = 'running';
    job.progress = 0;
    const res = await transitionMixer.concatWithTransitions(clips, outputPath, {
      duration: project.transition ? project.transition.duration : 0.4,
      type: project.transition ? project.transition.type : 'fade',
      ignoreAudio: true,
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

    job.status = 'done';
    job.progress = 100;
    job.outputPath = outputPath;
    job.durationSec = res.actualDuration;
    job.encoder = res.encoder || null;
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
    } catch (e) {
      console.warn('[editor] 登记导出任务失败: ' + (e && e.message));
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
