#!/usr/bin/env node
// ============================================================
// verify-test-hygiene.js —— 验收脚本「任务自清理」卫生检查
// ------------------------------------------------------------
// 背景（2026-11-03 实测）：
//   verify-adjust-pipeline.js 造任务但只删 output 产物，任务记录留在 data/tasks，
//   每跑一次堆 3 条「极光下的雪山与冰川」Mock 任务（累计 46 条）；
//   verify-color-match.js 的清理写成 taskManager.tasks.delete()（tasks 是对象不是 Map），
//   等于没清，又堆 3 条。
//   于是历史页被测试任务淹没，用户只能手工清。
//
// 本脚本是**静态门禁**：任何会造任务的 verify 脚本，必须引用 _test-cleanup
// （或显式写 `// test-hygiene: no-cleanup` 说明为什么不需要清）。
// 只读文件、不造任务、不联网，秒级完成。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPTS = path.join(__dirname);
let pass = 0, fail = 0;
const failures = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
};

// 造任务的特征：直接调 createTask / startTask（走 HTTP API 的脚本自己会用 createdTaskIds 记）
const CREATE_RE = /(?:taskManager\.)?createTask\s*\(|\.startTask\s*\(/;
const CLEANUP_RE = /_test-cleanup/;
const OPTOUT_RE = /test-hygiene:\s*no-cleanup/;

// 判定函数单独抽出，便于用合成样本做负向自检
function needsCleanup(src) { return CREATE_RE.test(src); }
function hasCleanup(src) { return CLEANUP_RE.test(src) || OPTOUT_RE.test(src); }

const selfFile = path.basename(__filename);
const files = fs.readdirSync(SCRIPTS)
  .filter((f) => /^verify-.*\.js$/.test(f) && f !== selfFile && f !== 'verify-all.js')
  .sort();

const creators = [];
const violations = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
  if (!needsCleanup(src)) continue;
  creators.push(f);
  if (!hasCleanup(src)) violations.push(f);
}

console.log('='.repeat(64));
console.log('验收脚本自清理卫生检查（静态，不执行被测脚本）');
console.log('='.repeat(64));
console.log(`扫描 ${files.length} 个 verify-*.js，其中会造任务的有 ${creators.length} 个：`);
for (const f of creators) {
  const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
  const how = OPTOUT_RE.test(src) ? '显式声明无需清理' : (CLEANUP_RE.test(src) ? '_test-cleanup' : '**缺失**');
  console.log(`  - ${f}: ${how}`);
}
console.log('');

// 1) 每个造任务的脚本都要有清理
ok(violations.length === 0,
  '所有造任务的验收脚本都接入了清理',
  violations.length ? '缺失：' + violations.join(', ') : `${creators.length} 个脚本全部合规`);

// 2) 清理工具本身要真的清四件事（内存/本地 JSON/数据库/产物）
const helperPath = path.join(SCRIPTS, '_test-cleanup.js');
ok(fs.existsSync(helperPath), '_test-cleanup.js 存在');
const helper = fs.existsSync(helperPath) ? fs.readFileSync(helperPath, 'utf8') : '';
ok(/module\.exports\s*=\s*\{[^}]*cleanupTask/.test(helper), '导出 cleanupTask');
ok(/module\.exports\s*=\s*\{[^}]*cleanupMany/.test(helper), '导出 cleanupMany');
ok(/storage\.deleteTask/.test(helper), '清理包含数据库（storage.deleteTask），不只删文件');
ok(/TASKS_DIR/.test(helper) && /OUT_DIR/.test(helper), '清理覆盖本地 JSON 与产物目录');

// 3) 负向自检：检测器必须能抓到「造任务但没清理」的样本
const badSample = "const t = taskManager.createTask('x', {}); await pipeline.startTask(t.taskId);";
const goodSample = "const { cleanupMany } = require('./_test-cleanup');\nconst t = taskManager.createTask('x', {});\nawait cleanupMany([t.taskId]);";
ok(needsCleanup(badSample) && !hasCleanup(badSample), '负向样本（造任务无清理）会被判为违规');
ok(needsCleanup(goodSample) && hasCleanup(goodSample), '正向样本（接入 _test-cleanup）不会误报');

// 4) 历史页的数据源是 data/tasks：当前目录不应留下已知测试前缀的任务
const TASKS_DIR = path.join(__dirname, '..', 'data', 'tasks');
if (fs.existsSync(TASKS_DIR)) {
  const leftovers = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json')).filter((f) => {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      return /^(verify-|test prompt$|回收测试-|接缝验收-|冰岛极光与黑沙滩$|测试链路不完整$|bgm plan probe$)/.test(String(t.prompt || ''));
    } catch (e) { return false; }
  });
  ok(leftovers.length === 0, 'data/tasks 无已知测试任务残留',
    leftovers.length ? leftovers.length + ' 条：' + leftovers.slice(0, 5).join(', ') + '（可跑 node scripts/cleanup-test-tasks.js）' : '干净');
} else {
  console.log('  ⚠️  data/tasks 不存在，跳过残留检查');
}

console.log('\n' + (fail ? `FAIL ${fail}` : '全部通过') + `（${pass} 通过 / ${fail} 失败）`);
if (fail) { console.log('失败项：'); failures.forEach((f) => console.log(`  - ${f.name}: ${f.detail || ''}`)); }
process.exit(fail ? 1 : 0);
