// ============================================================
// verify-pause.js —— 生成中「暂停 / 继续」验收
// ------------------------------------------------------------
// 依据：docs/spec/pause-decision.md（2026-10-31 裁定）
//   §4.1 paused 重启后永久卡死 → 降级为 failed + failureCode='pause_interrupted'
//   §4.2 30 分钟静默丢弃     → 日志 + 状态 failed + failureCode='pause_timeout' + 中止流水线
//   §6   必须新增并注册本脚本；前台 verify-all 受 spawn EPERM 限制，本脚本按后台 job 运行
//
// 本脚本不花钱、不联网、不跑 ffmpeg：
//   - 把 _processSingleClip 换成可控慢速 stub，只验证「暂停控制通道」本身；
//   - HTTP 用例起临时服务（DATABASE_TYPE=json / AUTH_ENABLED=false），用种子任务验证状态码与字段。
//
// failureCode 契约（前端据此区分，见 docs/spec/pause-capability-spec.md）：
//   pause_timeout     暂停等待超过上限，任务被中止（不是生成失败）
//   pause_interrupted 暂停期间服务被重启，任务已降级为 failed，可补跑
//   无该字段           普通生成失败 / 其它失败
// ============================================================

// 必须在 require 任何 src 模块之前设置：config 只在 env 未定义时才用 .env 填充，
// 因此这里能压过 .env 里的 postgres，避免验收往用户真实数据库写测试任务。
process.env.DATABASE_TYPE = 'json';
process.env.AUTH_ENABLED = 'false';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const pipeline = require('../src/pipeline');
const taskManager = require('../src/taskManager');
const { cleanupTask } = require('./_test-cleanup');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PAUSE_TEST_PORT || 3221);
const BASE = `http://${HOST}:${PORT}`;

let pass = 0;
let fail = 0;
const findings = [];

function ok(cond, name, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`);
  } else {
    fail++;
    findings.push(name + (detail ? '  —  ' + detail : ''));
    console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const createdIds = [];

function makeTask(title, options = {}) {
  const t = taskManager.createTask(title, {
    model: 'mock',
    totalClips: 1,
    clipDuration: 1,
    ...options
  });
  createdIds.push(t.taskId);
  return t;
}

// 用可控慢速 stub 替换真实片段处理（生成 + 质检 + 重试）。
// 只关心：谁被启动了、什么时候被启动、任务状态是否被正确改写。
function stubClipProcessing(ms, calls) {
  const orig = pipeline._processSingleClip;
  pipeline._processSingleClip = async (taskId, index) => {
    calls.push({ index, at: Date.now() });
    await sleep(ms);
    taskManager.updateClip(taskId, index, {
      status: 'success',
      videoPath: path.join(APP_DIR, 'clips', `${taskId}_stub_${index}.mp4`),
      duration: 1
    });
  };
  return () => { pipeline._processSingleClip = orig; };
}

// ============================================================
// [1] 基本语义：不存在 / 未运行 / 幂等
// ============================================================
async function testBasics() {
  console.log('\n[1] 基本语义（不存在 / 未运行 / 幂等）');

  const missing = pipeline.pauseTask('task_not_exists_for_pause_test');
  ok(missing.success === false && missing.error === '任务不存在',
    'pause 不存在的任务返回「任务不存在」', JSON.stringify(missing));

  const t = makeTask('暂停验收-未运行', { totalClips: 1 });
  const notRunning = pipeline.pauseTask(t.taskId);
  ok(notRunning.success === false && notRunning.error === '任务未在运行',
    'pause 未运行的任务返回「任务未在运行」', JSON.stringify(notRunning));

  const notPaused = pipeline.resumeTask(t.taskId);
  ok(notPaused.success === false && notPaused.error === '任务未处于暂停状态',
    'unpause 未暂停的任务返回「任务未处于暂停状态」', JSON.stringify(notPaused));

  ok(pipeline.isPaused(t.taskId) === false, 'isPaused 对未暂停任务返回 false');

  await cleanupTask(t.taskId, taskManager);
}

// ============================================================
// [2] 粒度 A：正在跑的片段会跑完，之后不再取新片段；恢复后继续
// ============================================================
async function testGranularityAndResume() {
  console.log('\n[2] 粒度 A（当前片段跑完才停）+ 幂等 + 恢复');

  const calls = [];
  const restore = stubClipProcessing(250, calls);
  const origConcurrency = pipeline.concurrency;
  pipeline.concurrency = 1;

  const t = makeTask('暂停验收-粒度', { totalClips: 4 });
  const id = t.taskId;
  pipeline.runningTasks.add(id);

  try {
    const batch = pipeline._batchGenerate(id, { generate: () => ({ taskId: 'stub' }) });
    await sleep(350);   // 片段0已结束；片段1正在跑（250~500ms）

    const p1 = pipeline.pauseTask(id);
    ok(p1.success === true && !p1.alreadyPaused, '运行中 pause 成功', JSON.stringify(p1));
    ok(taskManager.getTask(id).status === 'paused', 'pause 后任务状态为 paused');

    const p2 = pipeline.pauseTask(id);
    ok(p2.success === true && p2.alreadyPaused === true,
      '重复 pause 幂等（success=true + alreadyPaused）', JSON.stringify(p2));

    await sleep(650);   // 让在跑的片段1跑完，worker 停在暂停检查点
    ok(calls.length === 2, '暂停后不再取新片段（只跑了 2 个）', `实际 ${calls.length} 个`);
    ok(taskManager.getTask(id).status === 'paused', '等待期间状态保持 paused');

    const u = pipeline.resumeTask(id);
    ok(u.success === true, 'unpause 成功');
    ok(taskManager.getTask(id).status === 'generating', 'unpause 后状态回到 generating');

    await batch;
    const order = calls.map(c => c.index).join(',');
    ok(calls.length === 4, '恢复后把剩下的片段跑完（共 4 个）', `实际 ${calls.length} 个`);
    ok(order === '0,1,2,3', '片段顺序正确、没有重复生成', `实际 ${order}`);
    ok(pipeline.isPaused(id) === false, '任务结束后暂停标记已清理');
  } finally {
    restore();
    pipeline.concurrency = origConcurrency;
    pipeline.runningTasks.delete(id);
    await cleanupTask(id, taskManager);
  }
}

// ============================================================
// [3] 暂停超时：不静默、状态可区分、不再生成后续片段
// ============================================================
async function testPauseTimeout() {
  console.log('\n[3] 暂停超时（日志 + failed + failureCode=pause_timeout，不静默前进）');

  const calls = [];
  const restore = stubClipProcessing(60, calls);
  const origConcurrency = pipeline.concurrency;
  const origEnv = process.env.PAUSE_MAX_WAIT_MS;
  pipeline.concurrency = 1;
  process.env.PAUSE_MAX_WAIT_MS = '200';

  const t = makeTask('暂停验收-超时', { totalClips: 6 });
  const id = t.taskId;
  pipeline.runningTasks.add(id);

  try {
    ok(pipeline._pauseMaxWaitMs() === 200, 'PAUSE_MAX_WAIT_MS 可覆盖等待上限',
      String(pipeline._pauseMaxWaitMs()));

    const batch = pipeline._batchGenerate(id, { generate: () => ({ taskId: 'stub' }) });
    await sleep(120);            // 片段1/2 之间
    pipeline.pauseTask(id);
    await sleep(900);            // 超过 200ms 上限，_waitIfPaused 必然超时

    const task = taskManager.getTask(id);
    ok(task.status === 'failed', '超时后状态为 failed（不会被后续步骤覆盖）', task.status);
    ok(task.failureCode === 'pause_timeout', 'failureCode=pause_timeout（前端可区分）', String(task.failureCode));
    ok(!!task.pauseTimedOutAt && !isNaN(Date.parse(task.pauseTimedOutAt)),
      '记录 pauseTimedOutAt 时间戳', String(task.pauseTimedOutAt));
    ok(/暂停等待超过/.test(String(task.error || '')), '错误信息写明是暂停超时（不是生成失败）',
      String(task.error || '').slice(0, 50));
    ok(task.recoverable === true, '标记 recoverable（可补跑）');

    const info = await batch;
    ok(info && info.aborted === true, '_batchGenerate 返回 aborted=true', JSON.stringify(info));

    const frozen = calls.length;
    await sleep(400);
    ok(calls.length === frozen, '超时中止后不再生成任何新片段',
      `冻结于 ${frozen} 个，400ms 后 ${calls.length} 个`);
  } finally {
    restore();
    pipeline.concurrency = origConcurrency;
    pipeline.runningTasks.delete(id);
    if (origEnv === undefined) delete process.env.PAUSE_MAX_WAIT_MS;
    else process.env.PAUSE_MAX_WAIT_MS = origEnv;
    await cleanupTask(id, taskManager);
  }
}

// ============================================================
// [4] 暂停超时必须中止整条流水线（不再拼接/转码）
// ============================================================
async function testPipelineAborts() {
  console.log('\n[4] 暂停超时中止流水线（不进入拼接/转码）');

  const t = makeTask('暂停验收-中止流水线', {
    source: 'regenerate', totalClips: 2, preset: 'final'
  });
  const id = t.taskId;
  pipeline.runningTasks.add(id);
  taskManager.updateTaskStatus(id, 'generating', { currentStep: '视频片段生成' });

  const origBatch = pipeline._batchGenerate;
  pipeline._batchGenerate = async (taskId) => {
    taskManager.updateTaskStatus(taskId, 'failed', {
      error: '暂停等待超过 1 秒，已中止任务（未继续生成后续片段）。已完成的片段保留，可点「补跑」从断点继续。',
      failureCode: 'pause_timeout',
      pauseTimedOutAt: new Date().toISOString(),
      recoverable: true
    });
    return { aborted: true, reused: 0, generated: 1 };
  };

  try {
    const r = await pipeline._runPipeline(id, {});
    ok(r && r.aborted === true, '_runPipeline 在 aborted 时提前返回', JSON.stringify(r));
    ok(r && r.failureCode === 'pause_timeout', '返回值带 failureCode=pause_timeout');

    const task = taskManager.getTask(id);
    ok(task.status === 'failed', '任务状态保持 failed（没被改成 concatenating/completed）', task.status);
    const concatStep = task.steps && task.steps.concatenation;
    ok(!concatStep || !['completed', 'reused', 'partial'].includes(concatStep.status),
      '拼接步骤没有执行', concatStep ? String(concatStep.status) : 'undefined');
    const mixStep = task.steps && task.steps.audio_mix;
    ok(!mixStep || mixStep.status !== 'completed', '配乐步骤没有执行', mixStep ? String(mixStep.status) : 'undefined');
  } finally {
    pipeline._batchGenerate = origBatch;
    pipeline.runningTasks.delete(id);
    await cleanupTask(id, taskManager);
  }
}

// ============================================================
// [5] 重启回收：paused → failed + failureCode=pause_interrupted（可补跑）
// ============================================================
async function testRestartRecovery() {
  console.log('\n[5] 重启回收（paused 不再永久卡死，降级为可补跑）');

  const paused = makeTask('暂停验收-重启', { totalClips: 2 });
  taskManager.updateTaskStatus(paused.taskId, 'paused', { currentStep: '已暂停' });
  taskManager.recordStepComplete(paused.taskId, 'prompt_optimize', { qcResult: 'pass' });
  pipeline.pausedTasks.add(paused.taskId);  // 模拟"重启前内存里还挂着标记"

  // 负向：已完成任务不得被误回收；普通失败任务不得被套上 pause_* 标记
  const done = makeTask('暂停验收-已完成', { totalClips: 1 });
  taskManager.updateTaskStatus(done.taskId, 'completed', { currentStep: '已完成' });
  const normalFailed = makeTask('暂停验收-普通失败', { totalClips: 1 });
  taskManager.updateTaskStatus(normalFailed.taskId, 'failed', { error: '所有片段生成失败' });

  const recovered = await pipeline.reconcileInterruptedTasks();
  const mine = recovered.find(r => r.taskId === paused.taskId);
  ok(!!mine, '重启回收识别出 paused 任务', JSON.stringify(mine));

  const after = taskManager.getTask(paused.taskId);
  ok(after.status === 'failed', 'paused 回收后为 failed（不冒充 completed）', after.status);
  ok(after.status !== 'paused', '不再永久停在 paused（修复卡死）', after.status);
  ok(after.interruptedFrom === 'paused', '记录 interruptedFrom=paused', String(after.interruptedFrom));
  ok(after.failureCode === 'pause_interrupted', 'failureCode=pause_interrupted（前端可区分）',
    String(after.failureCode));
  ok(/重启/.test(String(after.error || '')), '错误信息说明是重启导致', String(after.error || '').slice(0, 40));
  ok(/补跑/.test(String(after.error || '')), '错误信息给出出口：可补跑');
  ok(after.recoverable === true, '标记 recoverable=true');
  ok(pipeline.isPaused(paused.taskId) === false, '内存暂停标记已清除');

  // 修复后的恢复路径：再 point「继续」必须给出明确错误，而不是静默失败
  const resumeAfter = pipeline.resumeTask(paused.taskId);
  ok(resumeAfter.success === false && /暂停状态/.test(resumeAfter.error),
    '重启后再 unpause 得到明确错误（不静默）', JSON.stringify(resumeAfter));

  ok(taskManager.getTask(done.taskId).status === 'completed', '负向：completed 未被误回收');
  ok(!recovered.find(r => r.taskId === done.taskId), '负向：completed 不在回收清单里');
  ok(taskManager.getTask(normalFailed.taskId).failureCode === undefined,
    '负向：普通失败任务不会被套上 pause_* 的 failureCode');

  // 前端区分三态（同一字段的三种取值）
  ok(new Set([after.failureCode, 'pause_timeout', undefined]).size === 3,
    'failureCode 三态可区分：pause_interrupted / pause_timeout / 无');

  for (const id of [paused.taskId, done.taskId, normalFailed.taskId]) {
    await cleanupTask(id, taskManager);
  }
}

// ============================================================
// [6] 源码级防回归：关键分支不能被删
// ============================================================
function testSourceGuards() {
  console.log('\n[6] 源码级防回归（关键分支/常量）');

  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'pipeline.js'), 'utf8');
  ok(/'paused', 'regenerating', 'processing', 'optimizing'/.test(src),
    'IN_PROGRESS 白名单包含 paused/regenerating/processing/optimizing');
  ok(/failureCode: 'pause_interrupted'/.test(src), '重启回收写入 failureCode=pause_interrupted');
  ok(/failureCode: 'pause_timeout'/.test(src), '暂停超时写入 failureCode=pause_timeout');
  ok(/pauseTimedOutAt/.test(src), '暂停超时记录 pauseTimedOutAt');
  ok(/PAUSE_MAX_WAIT_MS/.test(src), '等待上限可由 PAUSE_MAX_WAIT_MS 配置');
  ok(/if \(batchInfo && batchInfo\.aborted\)/.test(src), '_runPipeline 有 aborted 早退分支');
  ok(/aborted: !!\(finalTask && finalTask\.status === 'failed'\)/.test(src),
    '_batchGenerate 汇总 aborted 状态');
  ok(/finally \{\s*activeWorkers--/.test(src),
    'worker 用 try/finally 保证 activeWorkers 一定递减（避免 Promise 永挂）');
  ok((src.match(/pausedTasks\.delete\(/g) || []).length >= 3,
    '三条任务结束路径都会清掉暂停标记（start/regenerate/resumeFromClips）',
    `${(src.match(/pausedTasks\.delete\(/g) || []).length} 处`);

  const srv = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
  ok(/pauseErrorStatus/.test(srv), 'server.js 用 pauseErrorStatus 区分 404/400');
  ok(/'任务不存在' \? 404 : 400/.test(srv), '任务不存在返回 404，未运行返回 400');
}

// ============================================================
// [7] HTTP 契约：临时服务（json 存储、关登录墙）
// ============================================================
async function http(pathname, options = {}) {
  const r = await fetch(BASE + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(5000)
  });
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
}

async function waitReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

async function testHttpContract() {
  console.log('\n[7] HTTP 契约（404 / 400 / 200 / failureCode 透出）');

  // 种子任务：重启回收由服务启动时的 reconcileInterruptedTasks 真实执行
  const completed = makeTask('暂停HTTP-已完成', { totalClips: 1 });
  taskManager.updateTaskStatus(completed.taskId, 'completed', { currentStep: '已完成' });
  const paused = makeTask('暂停HTTP-暂停中', { totalClips: 2 });
  taskManager.updateTaskStatus(paused.taskId, 'paused', { currentStep: '已暂停' });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTH_ENABLED: 'false',
      DATABASE_TYPE: 'json'
    },
    // 关键：不能用 pipe。当前沙箱下「捕获子进程输出」会 EPERM，
    // 只有 stdio:'ignore' / 'inherit' 能 spawn 成功（2026-10-31 实测）。
    // 诊断信息改用 HTTP 响应，不依赖子进程日志。
    stdio: 'ignore'
  });

  try {
    const ready = await waitReady();
    ok(ready, '临时服务已就绪', `port=${PORT}`);
    if (!ready) {
      console.log(`（子进程日志因 stdio:'ignore' 不可回收；检查端口 ${PORT} 是否被占用）`);
      return;
    }

    const r404 = await http(`/api/tasks/task_nonexistent_zz/pause`, { method: 'POST' });
    ok(r404.status === 404, 'POST pause 不存在的任务 → 404', String(r404.status));

    const r404u = await http(`/api/tasks/task_nonexistent_zz/unpause`, { method: 'POST' });
    ok(r404u.status === 404, 'POST unpause 不存在的任务 → 404', String(r404u.status));

    const r404s = await http(`/api/tasks/task_nonexistent_zz/pause-state`);
    ok(r404s.status === 404, 'GET pause-state 不存在的任务 → 404', String(r404s.status));

    const r400 = await http(`/api/tasks/${completed.taskId}/pause`, { method: 'POST' });
    ok(r400.status === 400, 'POST pause 已完成任务 → 400（未在运行）', String(r400.status));
    ok(/未在运行/.test(String((r400.body || {}).error || '')), '400 的错误信息写明「未在运行」',
      String((r400.body || {}).error || ''));

    const r400u = await http(`/api/tasks/${completed.taskId}/unpause`, { method: 'POST' });
    ok(r400u.status === 400, 'POST unpause 未暂停任务 → 400', String(r400u.status));

    const st = await http(`/api/tasks/${completed.taskId}/pause-state`);
    ok(st.status === 200 && st.body && st.body.paused === false && st.body.status === 'completed',
      'GET pause-state 返回 {paused:false,status}',
      JSON.stringify(st.body));

    const st2 = await http(`/api/tasks/${paused.taskId}/pause-state`);
    ok(st2.status === 200 && st2.body && st2.body.paused === false,
      '重启后内存暂停标记为空（paused=false）', JSON.stringify(st2.body));

    // 服务启动时 reconcile 应把种子 paused 任务降级为 failed + failureCode
    const t1 = await http(`/api/tasks/${paused.taskId}`);
    const body1 = t1.body || {};
    ok(t1.status === 200, 'GET 暂停种子任务 200', String(t1.status));
    ok(body1.status === 'failed', '重启后 paused 被回收为 failed（HTTP 视角）', String(body1.status));
    ok(body1.failureCode === 'pause_interrupted', 'API 透出 failureCode=pause_interrupted（前端能区分）',
      String(body1.failureCode));
    ok(/补跑/.test(String(body1.error || '')), 'API 透出可补跑的提示', String(body1.error || '').slice(0, 40));

    const t2 = await http(`/api/tasks/${completed.taskId}`);
    ok((t2.body || {}).status === 'completed', '负向：已完成任务不受回收影响');
    ok(!(t2.body || {}).failureCode, '负向：已完成任务没有 failureCode');

    // 列表接口（任务抽屉/侧边栏用的就是它）也必须能区分，不能只在详情里透出
    const list = await http('/api/tasks');
    const rows = Array.isArray(list.body) ? list.body : [];
    const rowPaused = rows.find(x => x && x.taskId === paused.taskId);
    ok(!!rowPaused, '列表接口包含暂停种子任务');
    ok(rowPaused && rowPaused.failureCode === 'pause_interrupted',
      '列表接口透出 failureCode（抽屉可区分暂停被打断）',
      rowPaused ? String(rowPaused.failureCode) : 'missing');
    ok(rowPaused && rowPaused.recoverable === true, '列表接口透出 recoverable=true',
      rowPaused ? String(rowPaused.recoverable) : 'missing');
    const rowDone = rows.find(x => x && x.taskId === completed.taskId);
    ok(rowDone && rowDone.failureCode === null, '负向：已完成任务列表 failureCode=null',
      rowDone ? String(rowDone.failureCode) : 'missing');
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(500);
    for (const t of [completed, paused]) {
      await cleanupTask(t.taskId, taskManager);
    }
  }
}

// ============================================================
async function main() {
  console.log('='.repeat(66));
  console.log('暂停能力验收（pause / unpause / 超时 / 重启回收 / HTTP 契约）');
  console.log('='.repeat(66));

  try {
    await testBasics();
    await testGranularityAndResume();
    await testPauseTimeout();
    await testPipelineAborts();
    await testRestartRecovery();
    testSourceGuards();
    await testHttpContract();
  } catch (e) {
    fail++;
    findings.push('验收异常: ' + (e && e.message));
    console.error('\n验收异常:', e && e.stack || e);
  } finally {
    // 兜底清理：任何未清理的测试任务都不该留在库里
    for (const id of createdIds) {
      try { await cleanupTask(id, taskManager); } catch (e) {}
    }
  }

  console.log('\n' + '='.repeat(66));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (findings.length) {
    console.log('失败项：');
    findings.forEach(f => console.log('  - ' + f));
  }
  console.log('='.repeat(66));
  process.exit(fail === 0 ? 0 : 1);
}

main();
