// ============================================================
// 从已有成片重建工程（F01 c）
// ------------------------------------------------------------
// 2026-11-04 M2 收尾。
// 输入 taskId，把任务里的成功片段映射回片段库条目（assetId），保留入出点、
// 配乐计划与转场设置，生成一个新的工程草稿——原成片/原任务都不动。
// ============================================================
const fs = require('fs');
const path = require('path');

const taskManager = require('./taskManager');
const library = require('./library');
const projectStore = require('./projectStore');

function cleanAudio(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && s.trackId)
    .map((s) => ({
      trackId: s.trackId,
      timelineStart: Number(s.timelineStart) || 0,
      timelineEnd: Number(s.timelineEnd) || 0,
      sourceIn: Number(s.sourceIn) || 0,
      sourceOut: Number(s.sourceOut) || 0,
      fillMode: s.fillMode || 'loop',
      volume: s.volume,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut
    }));
}

function build(taskId) {
  const task = taskManager.getTask(taskId);
  if (!task) {
    const err = new Error('任务不存在: ' + taskId);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const entries = library.listAll();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byFile = new Map(entries.filter((e) => e.filePath).map((e) => [path.resolve(e.filePath), e]));

  const segments = [];
  let skipped = 0;
  for (const clip of (task.clips || [])) {
    if (!clip || clip.status !== 'success') { skipped += 1; continue; }
    let entry = clip.libraryId ? byId.get(clip.libraryId) : null;
    if (!entry && clip.videoPath) entry = byFile.get(path.resolve(clip.videoPath));
    if (!entry) { skipped += 1; continue; }
    const trim = clip.trim || null;
    const inSec = trim ? Math.max(0, Number(trim.inSec) || 0) : 0;
    const outSec = trim && trim.outSec !== null && trim.outSec !== undefined
      ? Number(trim.outSec)
      : (Number(entry.durationSec) || Number(clip.duration) || 0);
    if (!(outSec > inSec + 0.1)) { skipped += 1; continue; }
    segments.push({
      id: 's' + (segments.length + 1),
      assetId: entry.id,
      inSec: Math.round(inSec * 1000) / 1000,
      outSec: Math.round(outSec * 1000) / 1000,
      adjust: {}
    });
  }

  if (segments.length === 0) {
    const err = new Error('这条成片没有可映射回片段库的片段（可能片段库条目已被删除）');
    err.code = 'NO_SEGMENTS';
    throw err;
  }

  const plan = task.bgmPlan || {};
  const audio = {
    music: cleanAudio(plan.music),
    ambient: cleanAudio(plan.ambient),
    opts: { sourceTaskId: task.taskId }
  };
  const transition = task.transition && typeof task.transition === 'object'
    ? {
      enabled: task.transition.enabled !== false,
      duration: Number(task.transition.duration) > 0 ? Number(task.transition.duration) : 0.4,
      type: task.transition.type || 'fade'
    }
    : { enabled: true, duration: 0.4, type: 'fade' };

  const prompt = String(task.prompt || task.taskId || '成片').replace(/\s+/g, ' ').slice(0, 40);
  const project = projectStore.create({
    name: '重建 · ' + prompt,
    segments,
    audio,
    transition
  });
  return { project, mapped: segments.length, skipped, sourceTaskId: task.taskId };
}

module.exports = { build, _cleanAudio: cleanAudio };
