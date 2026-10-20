#!/usr/bin/env node
// ==========================================
// 片段库回填：把历史任务里已经成功的片段写进库
// ==========================================
//
// 只回填一次（幂等：已在库里的跳过，不覆盖用户收藏/替代关系）。
// 口径：
//   - 只收 status=success 且文件存在、model != mock 的片段；
//   - 规格用 ffprobe 实测；探测失败时退回任务分辨率档位；
//   - 费用按当前价目表回算，并在 cost.backfilled=true 上标明；
//   - 回收站里的任务也扫（用户删了任务，片段仍应留在库中）。
//
// 用法：
//   node scripts/backfill-library.js           # 真写
//   node scripts/backfill-library.js --dry     # 只统计不写

const fs = require('fs');
const path = require('path');
const pricing = require('../src/pricing');
const library = require('../src/library');
const videoProcessor = require('../src/videoProcessor');

const APP_DIR = path.join(__dirname, '..');
const TASK_DIRS = [
  path.join(APP_DIR, 'data', 'tasks'),
  path.join(APP_DIR, 'data', 'trash')
];
const CLIPS_DIR = path.join(APP_DIR, 'clips');
const DRY = process.argv.includes('--dry');

const RES_SIZE = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] };

function readTasks() {
  const out = [];
  for (const dir of TASK_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (t && t.taskId) {
          t.__fromTrash = dir.includes('trash');
          out.push(t);
        }
      } catch (e) {
        console.warn(`跳过损坏的任务文件 ${f}: ${e.message}`);
      }
    }
  }
  return out;
}

function fallbackSize(task) {
  const key = String(task.resolution || '').toLowerCase();
  return RES_SIZE[key] || null;
}

function main() {
  const tasks = readTasks();
  const stats = {
    tasks: tasks.length,
    clips: 0,
    added: 0,
    already: 0,
    mockSkipped: 0,
    notSuccess: 0,
    missingFile: 0,
    probeFailed: 0,
    totalCost: 0
  };
  const knownFiles = new Set();

  for (const task of tasks) {
    const clips = Array.isArray(task.clips) ? task.clips : [];
    for (const clip of clips) {
      stats.clips += 1;
      knownFiles.add(`${task.taskId}_clip_${clip.index + 1}.mp4`);
      if (clip.status !== 'success') { stats.notSuccess += 1; continue; }
      if (task.model === 'mock') { stats.mockSkipped += 1; continue; }

      const id = `${task.taskId}_c${clip.index + 1}`;
      if (library.get(id)) { stats.already += 1; continue; }

      let filePath = clip.videoPath && fs.existsSync(clip.videoPath)
        ? clip.videoPath
        : path.join(CLIPS_DIR, `${task.taskId}_clip_${clip.index + 1}.mp4`);
      if (!fs.existsSync(filePath)) { stats.missingFile += 1; continue; }

      let probe = null;
      try {
        probe = videoProcessor.probeDetail(filePath);
        if (probe && !probe.success) probe = null;
      } catch (e) {
        probe = null;
      }
      if (!probe) stats.probeFailed += 1;

      const size = fallbackSize(task);
      const probeForEntry = probe || {
        success: true,
        duration: clip.duration || task.clipDuration || null,
        width: size ? size[0] : null,
        height: size ? size[1] : null,
        codec: null,
        fps: null
      };

      const entry = library.buildEntry(task, clip, filePath, probeForEntry);
      const cost = pricing.computeClipCost({
        model: task.model,
        resolution: task.resolution,
        clipDurationSec: entry.durationSec || task.clipDuration,
        modelId: task.runtimeConfig && task.runtimeConfig.modelId
      }, clip.attempts || 1);
      cost.backfilled = true;
      entry.cost = cost;
      entry.source = 'backfill';
      entry.backfilled = true;
      entry.addedAt = clip.completedAt || task.completedAt || new Date().toISOString();

      stats.totalCost = pricing.round2(stats.totalCost + (cost.amount || 0));
      if (!DRY) library.upsert(entry);
      stats.added += 1;
      console.log(`+ ${id}  ${entry.width}x${entry.height} ${entry.durationSec}s  ${pricing.formatCny(cost.amount)}  ${entry.fileName}`);
    }
  }

  // 孤儿文件：clips/ 里存在、但不属于任何任务（任务 JSON 被永久删除后的残留）
  const orphans = [];
  if (fs.existsSync(CLIPS_DIR)) {
    for (const f of fs.readdirSync(CLIPS_DIR)) {
      if (!f.endsWith('.mp4')) continue;
      if (!knownFiles.has(f)) orphans.push(f);
    }
  }

  console.log('\n===== 回填结果 =====');
  console.log(JSON.stringify({ ...stats, orphans: orphans.length, dryRun: DRY }, null, 2));
  if (orphans.length) {
    console.log(`孤儿文件 ${orphans.length} 个（无任务记录，未入库）：`);
    console.log(orphans.slice(0, 30).map(f => '  ' + f).join('\n'));
  }
  console.log(`库内当前共 ${library.listAll().length} 条`);
}

main();
