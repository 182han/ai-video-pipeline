#!/usr/bin/env node
// ==========================================
// 把任务里「已成功、但片段库没有档案」的片段补进片段库（幂等）
//
// 为什么需要：入库只发生在「生成成功」和「重检转成功」两条路径上。
// 手工恢复的付费片段、补跑复用的老片段都不经过这两条路径，
// 结果是 clips/ 里有文件、成片也拼出来了，片段库却一条都没有
// （事故：task_mvgw4hbo_ajuc 两个已付费片段）。
//
// 本脚本不生成、不质检、不碰任何视频文件，只补库档案。
// 没有片段级质检记录的条目在库里显示「质检未验证」，不冒充通过。
//
// 走存储层（storage），DATABASE_TYPE=json / postgres 都支持，不需要重启服务。
//
// 用法：
//   node scripts/ingest-task-clips.js <taskId>          # 真写
//   node scripts/ingest-task-clips.js <taskId> --dry    # 只列出会补哪些
// ==========================================

const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const storage = require(path.join(APP_DIR, 'src', 'storage'));
const library = require(path.join(APP_DIR, 'src', 'library'));

const taskId = process.argv[2];
const DRY = process.argv.includes('--dry');

if (!taskId || taskId.startsWith('--')) {
  console.error('用法: node scripts/ingest-task-clips.js <taskId> [--dry]');
  process.exit(2);
}

(async () => {
  await storage.init();
  console.log(`存储驱动: ${storage.name}`);

  const task = await storage.getTask(taskId);
  if (!task) {
    console.error(`找不到任务: ${taskId}`);
    process.exit(2);
  }

  const clips = Array.isArray(task.clips) ? task.clips : [];
  const missing = clips.filter(c => c && c.status === 'success'
    && !library.get(`${task.taskId}_c${c.index + 1}`));

  console.log(`任务 ${taskId}：共 ${clips.length} 段，待补库 ${missing.length} 段`);
  if (!missing.length) {
    console.log('没有需要补库的片段。');
    await storage.close?.();
    return;
  }

  missing.forEach(c => {
    const name = c.videoPath ? path.basename(c.videoPath) : '<未记录路径>';
    console.log(`  ${DRY ? '[dry] ' : ''}clip#${c.index + 1}  ${name}  片段级质检=${c.qcResult ? '有' : '无（将标未验证）'}`);
  });

  if (DRY) {
    console.log('dry 结束，未写盘。');
    await storage.close?.();
    return;
  }

  const added = library.ingestMissing(task);
  console.log(`已补入片段库 ${added.length} 条: ${added.join(', ') || '（无）'}`);
  if (added.length !== missing.length) {
    console.log('注意：有片段未能入库（文件缺失或 ffprobe 读取失败），见上方日志。');
  }
  console.log(`库内当前共 ${library.listAll().length} 条`);
  await storage.close?.();
})().catch(e => {
  console.error('脚本异常:', e);
  process.exit(1);
});
