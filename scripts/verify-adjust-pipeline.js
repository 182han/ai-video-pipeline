#!/usr/bin/env node
// ==========================================================
// 调节真机验证：用 Mock 生成器跑**真实流水线**，验证 adjust 确实作用到成片
//
// 验证四件事：
//   A. 无 adjust 的任务：task.adjust === null，且 task.adjustApplied 不存在
//   B. 有 adjust 的任务：task.adjust 被规范化，task.adjustApplied 有 filter
//   C. 两条成片确实不同（PSNR 有限），且亮度+50 那条更亮
//   D. 关闭 ADJUST_ENABLED 时，即使传了 adjust 也不生效（双开关语义）
//
// 用法：node scripts/verify-adjust-pipeline.js [--keep]
// ==========================================================
'use strict';

process.env.ADJUST_ENABLED = 'true';
process.env.DATABASE_TYPE = process.env.DATABASE_TYPE || 'json';
process.env.AUTH_ENABLED = 'false';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const config = require('../config');
const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');
const qualityChecker = require('../src/qualityChecker');

// 注入 NSFW 通过（理由同 verify-stage-pipeline.js：本环境无 NSFW Key）
qualityChecker.checkNSFW = async function () {
  return { passed: true, qcVersion: 2, reason: '【测试注入】调节验证专用', level: 'pass', injected: true };
};

const KEEP = process.argv.includes('--keep');
let pass = 0, fail = 0;
const failures = [];
const assert = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDone(taskId, timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = taskManager.getTask(taskId);
    if (!t) throw new Error('任务丢失');
    if (['completed', 'partial', 'failed'].includes(t.status)) return t;
    await sleep(500);
  }
  throw new Error('任务超时');
}

async function runTask(extra) {
  const task = taskManager.createTask('极光下的雪山与冰川', {
    model: 'mock', totalClips: 2, clipDuration: 3, resolution: '720p', failRate: 0, ...extra
  });
  pipeline.startTask(task.taskId);
  const done = await waitDone(task.taskId);
  console.log(`  任务 ${task.taskId} 终态=${done.status} ${done.error ? 'error=' + done.error : ''}`);
  return done;
}

// 取成片中段一帧，算平均亮度
function frameMeanLuma(video, tmp) {
  const out = path.join(tmp, 'f' + Date.now() + '.raw');
  const r = spawnSync(config.FFMPEG_PATH, ['-y', '-hide_banner', '-loglevel', 'error',
    '-ss', '2', '-i', video, '-frames:v', '1', '-vf', 'scale=320:180', '-pix_fmt', 'rgb24',
    '-f', 'rawvideo', out], { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) return null;
  const b = fs.readFileSync(out);
  fs.unlinkSync(out);
  let s = 0;
  for (const v of b) s += v;
  return s / b.length;
}

(async () => {
  console.log('='.repeat(64));
  console.log('调节真机验证（Mock 生成器 + 真实流水线）');
  console.log('='.repeat(64));
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'adjpipe-'));
  const created = [];

  // ---------- A. 无调节 ----------
  console.log('\n[A. 无 adjust]');
  const tA = await runTask({});
  created.push(tA.taskId);
  assert(tA.status === 'completed' || tA.status === 'partial', '流水线正常结束', `status=${tA.status}`);
  assert(tA.adjust === null || tA.adjust === undefined, 'task.adjust 为空');

  // ---------- B. 有调节 ----------
  console.log('\n[B. adjust={brightness:50,contrast:999}]');
  const tB = await runTask({ adjust: { brightness: 50, contrast: 999 } });
  created.push(tB.taskId);
  assert(tB.status === 'completed' || tB.status === 'partial', '流水线正常结束', `status=${tB.status}`);
  assert(tB.adjust && tB.adjust.brightness === 50, 'brightness 保留', JSON.stringify(tB.adjust));
  assert(tB.adjust && tB.adjust.contrast === 50, 'contrast 被钳到 50', JSON.stringify(tB.adjust));
  assert(tB.adjustApplied && tB.adjustApplied.filter, '记录了 adjustApplied', tB.adjustApplied && tB.adjustApplied.filter);

  // ---------- C. 成片差异 ----------
  console.log('\n[C. 成片亮度对比]');
  const outA = path.join(__dirname, '..', 'output', `${tA.taskId}_final.mp4`);
  const outB = path.join(__dirname, '..', 'output', `${tB.taskId}_final.mp4`);
  if (fs.existsSync(outA) && fs.existsSync(outB)) {
    const la = frameMeanLuma(outA, tmp);
    const lb = frameMeanLuma(outB, tmp);
    console.log(`  平均亮度: 无调节=${la && la.toFixed(1)} 亮度+50=${lb && lb.toFixed(1)}`);
    assert(la !== null && lb !== null, '两条成片都能抽帧');
    assert(lb > la + 5, '调节版明显更亮', `${la && la.toFixed(1)} → ${lb && lb.toFixed(1)}`);
  } else {
    assert(false, '两条成片都存在', `${fs.existsSync(outA)}/${fs.existsSync(outB)}`);
  }

  // ---------- D. 关闭开关 ----------
  console.log('\n[D. 关闭 ADJUST_ENABLED 时传 adjust]');
  const savedEnabled = config.ADJUST.enabled;
  config.ADJUST.enabled = false;
  const tD = await runTask({ adjust: { brightness: 50 } });
  created.push(tD.taskId);
  assert(tD.adjust === null || tD.adjust === undefined, '开关关闭时不解析 adjust', JSON.stringify(tD.adjust));
  assert(!tD.adjustApplied, '开关关闭时不生成滤镜');
  config.ADJUST.enabled = savedEnabled;

  // ---------- E. 负向：滤镜生成被“弄丢”，必须判失败而非静默 ----------
  console.log('\n[E. 负向：请求了调节但滤镜生成失败]');
  const origAdjustOptions = pipeline._adjustOptionsFor;
  // 模拟「有人改流水线把参数传丢」：强制返回空选项
  pipeline._adjustOptionsFor = () => ({});
  let tE = null;
  let threw = null;
  try {
    tE = await runTask({ adjust: { brightness: 50 } });
  } catch (e) {
    threw = e.message;
  } finally {
    pipeline._adjustOptionsFor = origAdjustOptions;
  }
  if (tE) created.push(tE.taskId);
  const eFailed = (tE && (tE.status === 'failed' || tE.status === 'partial'))
    || /调节未执行/.test(threw || '');
  assert(eFailed, '任务被判失败（不静默通过）', `status=${tE && tE.status}${threw ? ', 异常=' + threw : ''}`);
  const stepError = tE && tE.steps && tE.steps.transcoding && tE.steps.transcoding.error;
  assert(/调节未执行/.test(stepError || threw || ''), '失败原因写明「调节未执行」', stepError || threw);

  // ---------- 清理 ----------
  if (!KEEP) {
    for (const id of created) {
      for (const suffix of ['_final.mp4', '_master.mp4', '_concat.mp4', '_loop.mp4']) {
        const f = path.join(__dirname, '..', 'output', `${id}${suffix}`);
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
      }
      for (const f of fs.readdirSync(path.join(__dirname, '..', 'output'))) {
        if (f.startsWith(id)) { try { fs.unlinkSync(path.join(__dirname, '..', 'output', f)); } catch (e) { /* ignore */ } }
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
