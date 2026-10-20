// ==========================================================
// 验收脚本专用：任务清理工具（**不是生产代码**）
//
// 背景（2026-10-19 实际踩到的事故）：
//   验收脚本用 taskManager.createTask() 造测试任务，
//   而 taskManager._saveTask() 会**同时写两处**：
//     1. data/tasks/<taskId>.json
//     2. 数据库（storage.saveTask；当前 .env 是 DATABASE_TYPE=postgres）
//   早期脚本只删了内存和 JSON 文件，**数据库里的记录留下了**。
//   结果一天下来给用户的数据库积了 116 条 mock 垃圾任务（pending/generating 一堆）。
//
// 因此所有会创建任务的验收脚本，清理时必须走这里：
//   await cleanupTask(taskId)  // 内存 + JSON + 数据库 + 视频产物
//
// 安全约束：本工具拒绝删除 model !== 'mock' 的任务，
// 防止误传真实任务 id 把用户的成片记录删掉。
// ==========================================================

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_DIR, 'output');
const TASKS_DIR = path.join(APP_DIR, 'data', 'tasks');

/**
 * 彻底清理一条**测试**任务。只允许删 mock 任务。
 * @param {string} taskId
 * @param {object} [taskManager] 可注入，默认 require('../src/taskManager')
 * @returns {Promise<{ok:boolean, removed:string[], skipped?:string}>}
 */
async function cleanupTask(taskId, taskManager) {
  if (!taskId || typeof taskId !== 'string') return { ok: false, removed: [], skipped: '无效 id' };

  const tm = taskManager || require('../src/taskManager');
  const removed = [];

  // 安全检查：只清理 mock 任务
  let model = null;
  try {
    const t = tm.getTask(taskId);
    if (t) model = t.model;
  } catch (e) {}
  if (model === null) {
    // 内存里没有，尝试从数据库/文件判断
    try {
      const storage = require('../src/storage');
      const t = await storage.getTask(taskId);
      if (t) model = t.model;
    } catch (e) {}
  }
  if (model !== null && model !== 'mock') {
    return { ok: false, removed, skipped: `拒绝删除非 mock 任务（model=${model}）` };
  }

  // 1. 内存
  try {
    if (tm.tasks && tm.tasks[taskId]) { delete tm.tasks[taskId]; removed.push('memory'); }
  } catch (e) {}

  // 2. 本地 JSON
  try {
    const jf = path.join(TASKS_DIR, `${taskId}.json`);
    if (fs.existsSync(jf)) { fs.unlinkSync(jf); removed.push('json'); }
  } catch (e) {}

  // 3. 数据库（关键：早期脚本漏了这一步）
  //
  // 注意竞态：taskManager._saveTask() 里是 `storage.saveTask(safe).catch(...)`——
  // **异步且不 await**。若任务刚跑完就清理，之前排队的写入可能在我们删除之后才落库，
  // 记录又被写回来。两种清理动作之间的实测现象：清理后计数 21 → 23（多出刚跑完的两条）。
  // 因此这里「删 → 等 → 再删一次」，用幂等的二次删除兜住迟到的写入。
  const storage = (() => { try { return require('../src/storage'); } catch (e) { return null; } })();
  const deleteOnce = async () => {
    if (!storage || typeof storage.deleteTask !== 'function') return;
    try { await storage.deleteTask(taskId); } catch (e) {}
  };
  if (storage) {
    await deleteOnce();
    removed.push('db');
    // 等一个事件循环 + 短延时，让迟到的 saveTask 落库后再删一次
    await new Promise(r => setTimeout(r, 150));
    await deleteOnce();
    // 本地 JSON 也可能被迟到的同步写入重建，再清一次
    try {
      const jf2 = path.join(TASKS_DIR, `${taskId}.json`);
      if (fs.existsSync(jf2)) fs.unlinkSync(jf2);
    } catch (e) {}
  }

  // 4. 视频产物
  for (const suffix of ['_concat.mp4', '_loop.mp4', '_master.mp4', '_final.mp4', '_concat.mp4.txt']) {
    try {
      const f = path.join(OUT_DIR, `${taskId}${suffix}`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(path.basename(f)); }
    } catch (e) {}
  }

  return { ok: true, removed };
}

/**
 * 批量清理，返回汇总。
 */
async function cleanupMany(taskIds, taskManager) {
  const results = [];
  for (const id of taskIds || []) {
    results.push({ taskId: id, ...(await cleanupTask(id, taskManager)) });
  }
  return results;
}

module.exports = { cleanupTask, cleanupMany };
