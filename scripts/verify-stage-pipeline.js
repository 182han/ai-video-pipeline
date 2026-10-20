// ==========================================================
// 档位真机验证：用 Mock 生成器跑**真实流水线**，验证档位生效
//
// 为什么 Mock 也能验证：Mock 生成器用 ffmpeg 产出真实视频文件，
// 整条流水线（拼接/循环/转码/配乐/质检）都会真实执行。
// 档位控制的是「编排逻辑」，与生成器无关，所以 Mock 足以验证。
//
// 验证三件事：
//   A. quick 档：只执行 4 步，后 4 步标记为 skipped
//   B. 默认档（不传 preset）：仍执行全部 8 步 —— 证明接入没有改变原有行为
//   C. clips_only 档：只执行 3 步核心链
//
// 用法：node scripts/verify-stage-pipeline.js [--keep]
//   --keep  保留产出的视频，便于人工检查
// ==========================================================

const fs = require('fs');
const path = require('path');

const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');
const qualityChecker = require('../src/qualityChecker');

// ==========================================================
// 测试注入：让 NSFW 检测返回「通过」
//
// 原因：当前 .env 的 OPENAI_API_KEY 为空，checkNSFW 按既有设计判 passed:false
// （changelog 已记录这是预期行为）。但片段质检会因此失败 → 所有片段 status=failed
// → 流水线在「片段生成」就中止，根本走不到档位控制的那些步骤。
//
// 本脚本要验证的是**档位编排**，不是 NSFW 检测能力——后者已由
// scripts/verify-nsfw.js 独立验证 42 项（含注入 fetch 的完整覆盖）。
// 因此这里只替换 checkNSFW 的返回值，其余质检项（黑帧/模糊/重复/时长）照常真实执行。
// ==========================================================
const _origCheckNSFW = qualityChecker.checkNSFW.bind(qualityChecker);
qualityChecker.checkNSFW = async function () {
  return {
    passed: true,
    qcVersion: 2,
    reason: '【测试注入】档位验证专用，视为通过（NSFW 由 verify-nsfw.js 单独验收）',
    level: 'pass',
    injected: true
  };
};

const KEEP = process.argv.includes('--keep');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 等待任务进入终态
async function waitDone(taskId, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = taskManager.getTask(taskId);
    if (!t) throw new Error('任务丢失');
    if (['completed', 'partial', 'failed'].includes(t.status)) return t;
    await sleep(400);
  }
  throw new Error(`任务 ${taskId} 超时未完成，当前状态 ${taskManager.getTask(taskId).status}`);
}

function stepStatuses(task) {
  const out = {};
  for (const [k, v] of Object.entries(task.steps || {})) out[k] = v.status;
  return out;
}

async function runCase(label, options, expectations) {
  console.log(`\n[${label}]`);
  // Mock 生成器默认 10% 失败率，测试里关掉以排除随机干扰
  const task = taskManager.createTask('极光下的雪山与冰川', {
    model: 'mock',
    totalClips: 2,
    clipDuration: 3,
    resolution: '720p',
    failRate: 0,
    ...options
  });
  console.log(`  任务 ${task.taskId} | preset=${task.preset} | 计划步骤=${Object.keys(task.stageSet).length}`);

  pipeline.startTask(task.taskId);
  const done = await waitDone(task.taskId);
  const st = stepStatuses(done);

  console.log(`  终态: ${done.status}`);
  const executed = Object.entries(st).filter(([, v]) => v !== 'skipped' && v !== 'pending').map(([k]) => k);
  const skipped = Object.entries(st).filter(([, v]) => v === 'skipped').map(([k]) => k);
  console.log(`  实际执行: ${executed.join(',') || '(无)'}`);
  console.log(`  被跳过  : ${skipped.join(',') || '(无)'}`);

  assert(done.status === 'completed' || done.status === 'partial',
    true ? '流水线正常结束（非 failed）' : '', `status=${done.status}${done.error ? ', error=' + done.error : ''}`);

  for (const [step, want] of Object.entries(expectations)) {
    const got = st[step];
    assert(got === want, `${step} 状态应为 ${want}`, `实际 ${got}`);
  }
  return done;
}

async function main() {
  console.log('='.repeat(64));
  console.log('档位真机验证（Mock 生成器 + 真实流水线）');
  console.log('='.repeat(64));

  const created = [];

  // ---------- A. quick 档 ----------
  const tQuick = await runCase('A. quick 档（核心链 + 拼接）', { preset: 'quick' }, {
    prompt_optimize: 'completed',
    storyboard: 'completed',
    clip_generation: 'completed',
    concatenation: 'completed',
    loop_processing: 'skipped',
    transcoding: 'skipped',
    audio_mix: 'skipped',
    final_qc: 'skipped'
  });
  created.push(tQuick.taskId);

  // 跳过步骤必须写明原因（不能只是个 status）
  const loopStep = tQuick.steps.loop_processing;
  assert(loopStep && loopStep.qcDetails && loopStep.qcDetails.legitimateSkip === true,
    '被跳过步骤标记 legitimateSkip（不是静默跳过）',
    JSON.stringify(loopStep && loopStep.qcDetails && loopStep.qcDetails.reason));
  assert(/未包含此环节/.test(String(loopStep && loopStep.qcDetails && loopStep.qcDetails.reason)),
    '跳过原因写明「档位未包含此环节」',
    String(loopStep && loopStep.qcDetails && loopStep.qcDetails.reason));

  // 产物必须存在
  assert(!!tQuick.outputPath && fs.existsSync(tQuick.outputPath),
    'quick 档产出了成片文件', tQuick.outputPath);
  if (tQuick.outputPath && fs.existsSync(tQuick.outputPath)) {
    const sz = fs.statSync(tQuick.outputPath).size;
    assert(sz > 10240, '成片文件大小正常（>10KB）', `${(sz / 1024).toFixed(0)} KB`);
  }

  // ---------- B. 默认档（不传 preset）----------
  const tFinal = await runCase('B. 默认档（不传 preset，应执行全部 8 步）', {}, {
    prompt_optimize: 'completed',
    storyboard: 'completed',
    clip_generation: 'completed',
    concatenation: 'completed',
    loop_processing: 'completed',
    transcoding: 'completed',
    audio_mix: 'completed',
    final_qc: 'completed'
  });
  created.push(tFinal.taskId);
  const stF = stepStatuses(tFinal);
  const skippedInFinal = Object.values(stF).filter(v => v === 'skipped').length;
  assert(skippedInFinal === 0,
    '默认档没有任何步骤被跳过（接入档位未改变原有行为）',
    `skipped=${skippedInFinal}`);

  // ---------- C. clips_only 档 ----------
  const tClips = await runCase('C. clips_only 档（仅核心链，交付片段包）', { preset: 'clips_only' }, {
    prompt_optimize: 'completed',
    storyboard: 'completed',
    clip_generation: 'completed',
    concatenation: 'skipped',
    loop_processing: 'skipped',
    transcoding: 'skipped',
    audio_mix: 'skipped',
    final_qc: 'skipped'
  });
  created.push(tClips.taskId);
  // 片段包档的交付物是片段本身，不应产出成片
  assert(tClips.fragmentOnly === true,
    'clips_only 标记 fragmentOnly（这是片段包，不是成片）', `fragmentOnly=${tClips.fragmentOnly}`);
  assert(tClips.outputPath === null || tClips.outputPath === undefined,
    'clips_only 不产出成片文件（outputPath 为空）', `outputPath=${tClips.outputPath}`);
  assert((tClips.fragmentCount || 0) > 0,
    'clips_only 报告了交付的片段数', `fragmentCount=${tClips.fragmentCount}`);

  // ---------- D. 历史任务兼容 ----------
  console.log('\n[D] 历史任务兼容（无 preset 字段）');
  const legacy = { taskId: 'legacy_x', clips: [], steps: {} };
  const { applyTaskDefaults } = require('../src/taskDefaults');
  applyTaskDefaults(legacy);
  assert(legacy.preset === 'final', '老任务补成 final（当初就是全量执行）', `preset=${legacy.preset}`);
  assert(Object.keys(legacy.stageSet).length === 8,
    '老任务 stageSet 为 8 步全 true', `${Object.keys(legacy.stageSet).length}`);

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }

  // 清理测试任务与产物（必须含数据库，见 scripts/_test-cleanup.js 的说明）
  if (!KEEP) {
    const { cleanupMany } = require('./_test-cleanup');
    const cleaned = await cleanupMany(created, taskManager);
    const badClean = cleaned.filter(c => !c.ok);
    if (badClean.length) {
      console.log('⚠️ 部分任务未清理：' + badClean.map(c => `${c.taskId}(${c.skipped})`).join(', '));
    }
    console.log('测试产物已清理（--keep 可保留）');
  } else {
    console.log(`产物保留：${created.join(', ')}`);
  }
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
