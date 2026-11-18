#!/usr/bin/env node
// ============================================================
// 验收：预算「计费不确定」（2026-11-18 用户报本地退款但真实余额没退）
// ------------------------------------------------------------
// 事故：task_mwiugoxq_z01l 失败原因是 `fetch failed`（网络失败，外部可能已扣费），
// 旧逻辑 failed 时按成功片段数结算（0 段 → 全额退 2.003），账本显示 196.28，
// 而用户真实余额 194.27 —— 正好一笔没退。
//
// 新口径（任务书 task-3 §5）：
//   · 网络/超时/连接中断 → **不自动退款**，标记 task.billingUncertain + 账目 billingUncertain，
//     余额保持预扣，留人工对账；
//   · 显式 4xx（如 Alibaba 400）→ 仍可全额退；
//   · 任务之后真的完成 → 按实际成功片段结算，并结清 uncertain 标记。
//
// 全部用临时 BUDGET_FILE / BUDGET_USD，**不碰真实 data/budget.json**，不启动服务、零计费。
// 用法：cd app && node scripts/verify-budget-uncertain.js
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-budget-uncertain-'));
const TMP_BUDGET = path.join(TMP, 'budget.json');
process.env.BUDGET_FILE = TMP_BUDGET;
process.env.BUDGET_USD = '196';
process.env.DATA_DIR = path.join(TMP, 'tasks');
process.env.CLIPS_DIR = path.join(TMP, 'clips');
process.env.OUTPUT_DIR = path.join(TMP, 'output');
process.env.LIBRARY_DIR = path.join(TMP, 'library');
process.env.PHOTOS_DIR = path.join(TMP, 'photos');
process.env.PROJECTS_DIR = path.join(TMP, 'projects');
process.env.ASSISTANT_DIR = path.join(TMP, 'assistant');
process.env.USERS_FILE = path.join(TMP, 'users.json');
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.DATABASE_TYPE = 'json';
for (const d of ['tasks', 'clips', 'output', 'library', 'photos', 'projects', 'assistant', 'logs']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function group(title) { console.log('\n[' + title + ']'); }
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

const budget = require('../src/budget');
const taskManager = require('../src/taskManager');

try {
  // ================= [1] 失败原因 → 计费口径 =================
  group('1. classifyFailure：网络不确定 vs 显式 4xx vs 未知');
  const uncertainCases = [
    'fetch failed',
    'network error: ECONNRESET',
    'ETIMEDOUT while contacting upstream',
    'socket hang up',
    '请求超时（timeout）',
    '连接被重置',
    'AbortError: aborted'
  ];
  for (const text of uncertainCases) {
    ok(`uncertain: ${text}`, budget.classifyFailure(text) === 'uncertain', budget.classifyFailure(text));
  }
  const definiteCases = [
    'OpenAI 兼容视频 API 错误 (400): invalid request',
    'DashScope API 错误 (401): unauthorized',
    'HTTP 403 Forbidden',
    '可灵API错误(429): too many requests',
    '状态码 402'
  ];
  for (const text of definiteCases) {
    ok(`definite: ${text}`, budget.classifyFailure(text) === 'definite', budget.classifyFailure(text));
  }
  ok('unknown: 普通中文失败（沿用旧逻辑，不扩大更动）',
    budget.classifyFailure('所有片段生成失败（0/2）') === 'unknown');
  ok('unknown: 空原因', budget.classifyFailure('') === 'unknown');

  // ================= [2] 预留 + 标记不确定（余额保持预扣） =================
  group('2. reserve → markUncertain：余额不自动退回');
  ok('临时 BUDGET_FILE 生效（绝不写真实 data/budget.json）',
    path.resolve(budget.FILE) === path.resolve(TMP_BUDGET), budget.FILE);
  ok('初始余额 196', near(budget.status().balanceUsd, 196), String(budget.status().balanceUsd));
  budget.reserve({ usd: 2.003, kind: 'video', taskId: 'task_unc_1', meta: { model: 'openai-video', clips: 2 } });
  ok('预扣 $2.003 后余额 193.997', near(budget.status().balanceUsd, 193.997), String(budget.status().balanceUsd));
  const mark1 = budget.markUncertain('task_unc_1', { reason: 'fetch failed', meta: { model: 'openai-video' } });
  ok('markUncertain 返回预扣额且余额不变（不退款）',
    !!mark1 && near(mark1.reservedUsd, 2.003) && near(budget.status().balanceUsd, 193.997),
    JSON.stringify({ mark1, balance: budget.status().balanceUsd }));
  const st = budget.status();
  ok('账目暴露 uncertainCount/uncertainUsd（人工对账入口）',
    st.uncertainCount === 1 && near(st.uncertainUsd, 2.003)
    && Array.isArray(st.uncertainEntries) && st.uncertainEntries[0].taskId === 'task_unc_1',
    JSON.stringify({ count: st.uncertainCount, usd: st.uncertainUsd }));
  const markAgain = budget.markUncertain('task_unc_1', { reason: 'fetch failed (again)' });
  ok('markUncertain 幂等：重复标记仍只有 1 条、不重复累计',
    !!markAgain && budget.status().uncertainCount === 1 && near(budget.status().balanceUsd, 193.997));
  ok('listUncertain() 只读列表包含该任务',
    budget.listUncertain().some((e) => e.taskId === 'task_unc_1' && near(e.reservedUsd, 2.003)));

  // ================= [3] taskManager：网络失败不自动退款 =================
  group('3. taskManager：failed(network) → task.billingUncertain + 预扣保留');
  const tNet = taskManager.createTask('网络失败任务', { model: 'openai-video', totalClips: 2, clipDuration: 10, resolution: '720p' });
  budget.reserve({ usd: 2.0, kind: 'video', taskId: tNet.taskId, meta: { model: 'openai-video' } });
  const balBefore = budget.status().balanceUsd;
  taskManager.updateClip(tNet.taskId, 0, { status: 'failed', error: 'fetch failed' });
  taskManager.updateTaskStatus(tNet.taskId, 'failed', { error: 'fetch failed' });
  const tNetAfter = taskManager.getTask(tNet.taskId);
  ok('failed(network)：task.billingUncertain=true 且记录原因',
    tNetAfter.billingUncertain === true && /fetch failed/i.test(String(tNetAfter.billingUncertainReason || '')),
    JSON.stringify({ u: tNetAfter.billingUncertain, r: tNetAfter.billingUncertainReason }));
  ok('failed(network)：余额保持预扣（不自动退款）', near(budget.status().balanceUsd, balBefore),
    `${balBefore} → ${budget.status().balanceUsd}`);
  ok('failed(network)：账目进入 uncertain 列表',
    budget.listUncertain().some((e) => e.taskId === tNet.taskId));

  // ================= [4] 显式 4xx 仍全额退 =================
  group('4. 显式 4xx 失败：仍按旧逻辑退款');
  const t4xx = taskManager.createTask('4xx 失败任务', { model: 'openai-video', totalClips: 2, clipDuration: 10, resolution: '720p' });
  budget.reserve({ usd: 1.0, kind: 'video', taskId: t4xx.taskId, meta: { model: 'openai-video' } });
  const bal4 = budget.status().balanceUsd;
  taskManager.updateTaskStatus(t4xx.taskId, 'failed', { error: 'OpenAI 兼容视频 API 错误 (400): invalid request' });
  ok('failed(400)：全额退回预扣（definite）', near(budget.status().balanceUsd, bal4 + 1.0),
    `${bal4} → ${budget.status().balanceUsd}`);
  ok('failed(400)：不标记 billingUncertain',
    taskManager.getTask(t4xx.taskId).billingUncertain !== true);

  // ================= [5] 部分成功 + 网络失败：不自动结算 =================
  group('5. 部分成功 + 网络失败：预扣保持（不按成功数私自贸结算）');
  const tPart = taskManager.createTask('部分成功网络失败', { model: 'openai-video', totalClips: 2, clipDuration: 10, resolution: '720p' });
  budget.reserve({ usd: 2.0, kind: 'video', taskId: tPart.taskId, meta: { model: 'openai-video' } });
  taskManager.updateClip(tPart.taskId, 0, { status: 'success', videoPath: path.join(TMP, 'clips', 'x.mp4') });
  const balPart = budget.status().balanceUsd;
  taskManager.updateTaskStatus(tPart.taskId, 'failed', { error: 'socket hang up' });
  ok('部分成功 + network 失败：余额不变（等人工对账）', near(budget.status().balanceUsd, balPart));
  ok('部分成功 + network 失败：task 标记 uncertain',
    taskManager.getTask(tPart.taskId).billingUncertain === true);

  // ================= [6] 人工对账 =================
  group('6. 人工对账 resolveUncertain');
  const balBeforeResolve = budget.status().balanceUsd;
  const resolved = budget.resolveUncertain(tNet.taskId, { actualUsd: 0.5, note: '按网关账单实际扣 $0.5', actor: 'lead' });
  ok('resolveUncertain(actual=0.5)：退回差额',
    !!resolved && near(resolved.refundUsd, 1.5) && near(budget.status().balanceUsd, balBeforeResolve + 1.5),
    JSON.stringify({ resolved, balance: budget.status().balanceUsd }));
  ok('resolveUncertain 后 uncertain 列表移除该任务',
    !budget.listUncertain().some((e) => e.taskId === tNet.taskId));
  ok('resolveUncertain 幂等：第二次返回 null（不重复退款）',
    budget.resolveUncertain(tNet.taskId, { actualUsd: 0 }) === null);

  // ================= [7] 任务之后完成 → 结清 =================
  group('7. 不确定之后任务真的完成 → 按实际结算并结清标记');
  const tDone = taskManager.createTask('先网络失败后补跑完成', { model: 'openai-video', totalClips: 2, clipDuration: 10, resolution: '720p' });
  budget.reserve({ usd: 2.0, kind: 'video', taskId: tDone.taskId, meta: { model: 'openai-video' } });
  taskManager.updateTaskStatus(tDone.taskId, 'failed', { error: 'request timeout' });
  ok('先失败：task uncertain', taskManager.getTask(tDone.taskId).billingUncertain === true);
  taskManager.updateClip(tDone.taskId, 0, { status: 'success' });
  taskManager.updateClip(tDone.taskId, 1, { status: 'success' });
  const balDone = budget.status().balanceUsd;
  taskManager.updateTaskStatus(tDone.taskId, 'completed', {});
  const done = taskManager.getTask(tDone.taskId);
  // 2 段 × 10s × 0.10 = $2.00，预扣 $2.00 → 退 0
  ok('完成后按成功片段结算：余额不变（实际=预扣）', near(budget.status().balanceUsd, balDone),
    `${balDone} → ${budget.status().balanceUsd}`);
  ok('完成后 task.billingUncertain 被结清（保留解析记录）',
    done.billingUncertain === false && done.billingUncertainResolution === 'completed',
    JSON.stringify({ u: done.billingUncertain, r: done.billingUncertainResolution }));

  // ================= [8] 源码接线静态断言 =================
  group('8. 源码接线静态断言');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const tmSrc = read('src/taskManager.js');
  const budgetSrc = read('src/budget.js');
  ok('taskManager：failed 分支有 billingUncertain 路径', /billingUncertain/.test(tmSrc)
    && /budget\.classifyFailure/.test(tmSrc) && /budget\.markUncertain/.test(tmSrc));
  ok('taskManager：completed 分支会结清 billingUncertain', /billingUncertainResolution = 'completed'/.test(tmSrc));
  ok('taskManager：仍保留 budget.settle 结算（既有套件断言）', /budget\.settle\(/.test(tmSrc));
  ok('budget：导出 classifyFailure/markUncertain/resolveUncertain/listUncertain',
    ['classifyFailure', 'markUncertain', 'resolveUncertain', 'listUncertain']
      .every((k) => new RegExp(k + ',').test(budgetSrc)));
  ok('budget：status 暴露 uncertainCount/uncertainUsd/uncertainEntries',
    /uncertainCount/.test(budgetSrc) && /uncertainUsd/.test(budgetSrc) && /uncertainEntries/.test(budgetSrc));
  ok('budget：settle 会清理曾被标记的 uncertain 条目（wasBillingUncertain 留痕）',
    /wasBillingUncertain/.test(budgetSrc) && /settled-by-task/.test(budgetSrc));
  ok('没有改动真实 data/：临时预算文件在系统临时目录',
    path.resolve(budget.FILE) === path.resolve(TMP_BUDGET));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
}

console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
