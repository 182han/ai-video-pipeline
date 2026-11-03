#!/usr/bin/env node
// ============================================================
// cleanup-test-tasks.js —— 兜底清理：把验收脚本遗留的测试任务移入垃圾箱
// ------------------------------------------------------------
// 用途：脚本自清理（_test-cleanup）之外的安全网。识别依据是**测试专用提示词**，
// 不按 model 或状态猜，避免误删用户自己造的 Mock 任务。
//
// 只动历史页的数据源 data/tasks（移入 data/trash，可在页面上恢复），
// 不删 output/clips 里的成片，也不改数据库（历史页不读数据库）。
//
// 用法：
//   node scripts/cleanup-test-tasks.js            # 只列出，不改动
//   node scripts/cleanup-test-tasks.js --apply    # 实际移入垃圾箱
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const TASKS_DIR = path.join(__dirname, '..', 'data', 'tasks');

// 只匹配「一眼是测试」的提示词；新增测试脚本的命名请沿用 verify- 前缀
const SIGNATURES = [
  /^verify-/i,
  /^test prompt$/i,
  /^回收测试-/,
  /^接缝验收-/,
  /^冰岛极光与黑沙滩$/,
  /^测试链路不完整$/,
  /^bgm plan probe$/
];

function isTestTask(task) {
  const prompt = String((task && task.prompt) || '').trim();
  return SIGNATURES.some((re) => re.test(prompt));
}

const apply = process.argv.includes('--apply');

if (!fs.existsSync(TASKS_DIR)) {
  console.log('data/tasks 不存在，无需清理');
  process.exit(0);
}

const hits = [];
for (const file of fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'))) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
    if (isTestTask(t)) hits.push(t);
  } catch (e) {
    console.log(`  ⚠️ 解析失败，跳过：${file}（${e.message}）`);
  }
}

console.log(`发现测试任务 ${hits.length} 条${apply ? '，开始移入垃圾箱' : '（演练模式，未改动；加 --apply 执行）'}`);
for (const t of hits) {
  console.log(`  ${t.taskId}  ${t.status}  ${t.createdAt || ''}  ${String(t.prompt || '').slice(0, 30)}`);
}

if (!apply) process.exit(0);

// 复用应用自身的「移入垃圾箱」语义：写 data/trash/<id>.json + 删 data/tasks/<id>.json
const taskManager = require('../src/taskManager');
let okCount = 0, failCount = 0;
for (const t of hits) {
  const r = taskManager.moveToTrash(t.taskId);
  if (r && r.success) okCount++;
  else { failCount++; console.log(`  ❌ ${t.taskId}: ${r && (r.error || r.skipped) }`); }
}
console.log(`完成：${okCount} 条移入垃圾箱，失败 ${failCount} 条`);
console.log('剩余 data/tasks：' + fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json')).length + ' 条');
