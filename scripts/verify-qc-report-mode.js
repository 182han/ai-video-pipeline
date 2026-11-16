// ============================================================
// 质检分级 / 零自动重试 验收（2026-11-12 用户口径）
//
// 验证三件事：
//   A. 软项（模糊）只警告：strictItems 只含硬闸门时，模糊片段仍 passed=true
//   B. 把模糊列为要紧项时才会失败（证明分级真的生效）
//   C. autoRetry=false：生成失败只尝试 1 次，不自动重跑
//
// 用法：node scripts/verify-qc-report-mode.js
// ============================================================

const fs = require('fs');
const path = require('path');

const config = require('../config');
const qualityChecker = require('../src/qualityChecker');
const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}

(async () => {
  console.log('================================================================');
  console.log('质检分级 / 零自动重试 验收');
  console.log('================================================================');

  // ---------- A/B：软项只警告 ----------
  const src = path.join(__dirname, '..', 'clips', 'task_mvgw4hbo_ajuc_clip_1.mp4');
  if (!fs.existsSync(src)) {
    console.log('  ⚠ 缺少样本片段，跳过 A/B（' + src + '）');
  } else {
    // 不额外生成模糊片（本沙箱 execFileSync 会 EPERM）；
    // 直接把 blurThreshold 调到 0，让现有片段的模糊项判 fail，测的是「分级」而不是「造坏片」。
    const origThreshold = qualityChecker.options.blurThreshold;
    qualityChecker.options.blurThreshold = 0;
    // 隔离 NSFW（本机无多模态 Key，否则硬项必失败，测不出模糊分级）
    const origNSFW = qualityChecker.checkNSFW.bind(qualityChecker);
    qualityChecker.checkNSFW = async () => ({ passed: true, qcVersion: 3, reason: '【测试注入】', level: 'pass' });

    try {
      const hardOnly = await qualityChecker.checkClip(src, 6, {
        strictItems: ['blackFrame', 'duration', 'nsfw']
      });
      ok(hardOnly.passed === true, 'A. 模糊只警告：硬闸门模式下 passed=true', `warningCount=${hardOnly.warningCount}`);
      ok(hardOnly.details && hardOnly.details.blur && hardOnly.details.blur.passed === false,
        'A2. 模糊检测确实抓到了（只是不阻塞）', `maxBlur=${hardOnly.details && hardOnly.details.blur && hardOnly.details.blur.maxBlur}`);

      const allStrict = await qualityChecker.checkClip(src, 6, {
        strictItems: ['blackFrame', 'blur', 'duplicate', 'duration', 'nsfw']
      });
      ok(allStrict.passed === false, 'B. 把模糊列为要紧项时才失败', `reason=${String(allStrict.reason).slice(0, 80)}`);
    } finally {
      qualityChecker.options.blurThreshold = origThreshold;
      qualityChecker.checkNSFW = origNSFW;
    }
  }

  // ---------- C：autoRetry=false 只尝试一次 ----------
  const task = taskManager.createTask('test-report-mode', {
    model: 'mock',
    totalClips: 1,
    clipDuration: 5,
    resolution: '720p',
    autoRetry: false
  });
  ok(task.autoRetry === false, 'C0. 任务记录 autoRetry=false');

  let calls = 0;
  const fakeGen = {
    name: 'fake-failing',
    async generate() { calls++; throw new Error('boom'); },
    canRetry() { return true; }
  };
  await pipeline._processSingleClip(task.taskId, 0, fakeGen, null);
  const after = taskManager.getTask(task.taskId);
  ok(calls === 1, 'C1. 生成失败只调用 1 次（不自动重跑）', `calls=${calls}`);
  ok(after.clips[0].status === 'failed', 'C2. 片段标记 failed', `status=${after.clips[0].status}`);
  ok(after.clips[0].attempts === 1, 'C3. attempts=1', `attempts=${after.clips[0].attempts}`);
  const summary = pipeline._failedClipSummaries(after);
  ok(summary.length === 1 && summary[0].index === 1, 'C4. 失败清单含 #1', JSON.stringify(summary));
  ok(pipeline._shouldStopBeforeAssembly(after) === true, 'C5. autoRetry=false 且有失败 → 停在拼接前');

  // ---------- D：完整流水线在拼接前停下 ----------
  const gateTask = taskManager.createTask('gate-test', {
    model: 'mock', totalClips: 2, clipDuration: 5, resolution: '720p',
    preset: 'quick', autoRetry: false
  });
  const origBatch = pipeline._batchGenerate;
  pipeline._batchGenerate = async (taskId) => {
    taskManager.updateClip(taskId, 0, { status: 'failed', error: 'fake generation failure' });
    taskManager.updateClip(taskId, 1, { status: 'success', videoPath: 'fake' });
    return { reused: 0, generated: 1, aborted: false };
  };
  try {
    const r = await pipeline._runPipeline(gateTask.taskId, {});
    const gt = taskManager.getTask(gateTask.taskId);
    ok(gt.status === 'failed', 'D1. 有失败片段 → 任务 failed', `status=${gt.status}`);
    ok(Array.isArray(gt.failedClips) && gt.failedClips.length === 1, 'D2. 写入 failedClips 清单', JSON.stringify(gt.failedClips));
    ok(!gt.outputPath, 'D3. 没有产出成片（未拼接）', `outputPath=${gt.outputPath}`);
    ok(!gt.steps.concatenation || gt.steps.concatenation.status !== 'completed',
      'D4. 拼接步骤未执行', JSON.stringify(gt.steps.concatenation || null));
    ok(r && r.needsRetry === true, 'D5. 返回值标记 needsRetry');
  } finally {
    pipeline._batchGenerate = origBatch;
  }

  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本异常:', e && e.message);
  process.exit(1);
});
