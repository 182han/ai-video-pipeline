// ==========================================================
// 补跑（continueTask）真机验证
//
// 核心场景（省钱的关键）：
//   1. 用 quick 档跑一条任务 → 只到拼接，片段已生成
//   2. 补跑到 final → 只跑 loop/transcoding/audio_mix/final_qc
//   3. 断言：**片段没有被重新生成**（clip_generation 记为 reused，片段文件 mtime 不变）
//
// 另外覆盖：
//   - 补跑链路不完整时报错（不给硬跑）
//   - 已完成档位再补跑 → alreadyDone
//   - 产物缺失时的处理
//
// 用法：node scripts/verify-continue.js [--keep]
// ==========================================================

const fs = require('fs');
const path = require('path');

const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');
const qualityChecker = require('../src/qualityChecker');

// 同 verify-stage-pipeline.js：无 OpenAI Key 时 NSFW 判 fail 会卡住片段生成，
// 而本脚本验证的是「补跑编排」，不是 NSFW 检测（后者由 verify-nsfw.js 独立验收 42 项）。
qualityChecker.checkNSFW = async function () {
  return { passed: true, qcVersion: 2, reason: '【测试注入】补跑验证专用', level: 'pass', injected: true };
};

const KEEP = process.argv.includes('--keep');
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitDone(taskId, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = taskManager.getTask(taskId);
    if (!t) throw new Error('任务丢失');
    if (['completed', 'partial', 'failed'].includes(t.status)) return t;
    await sleep(400);
  }
  throw new Error(`任务超时，当前状态 ${taskManager.getTask(taskId).status}`);
}

function statuses(task) {
  const o = {};
  for (const [k, v] of Object.entries(task.steps || {})) o[k] = v.status;
  return o;
}

async function main() {
  console.log('='.repeat(64));
  console.log('补跑（continueTask）真机验证');
  console.log('='.repeat(64));

  // ---------- 1. quick 档先跑一遍 ----------
  console.log('\n[1] 先用 quick 档跑到拼接');
  const task = taskManager.createTask('冰岛极光与黑沙滩', {
    model: 'mock', totalClips: 2, clipDuration: 3, resolution: '720p', preset: 'quick'
  });
  const taskId = task.taskId;
  pipeline.startTask(taskId);
  const afterQuick = await waitDone(taskId);

  const st1 = statuses(afterQuick);
  console.log(`  终态 ${afterQuick.status} | 已执行: ${Object.entries(st1).filter(([, v]) => v === 'completed').map(([k]) => k).join(',')}`);

  // 记录片段文件的 mtime，后面用来证明「没有被重新生成」
  const clipPaths = (afterQuick.clips || [])
    .filter(c => c.status === 'success')
    .map(c => pipeline._resolveClipPath(c.videoPath))
    .filter(Boolean);
  const clipMtimes = clipPaths.map(p => fs.statSync(p).mtimeMs);
  assert(clipPaths.length === 2, 'quick 档产出了 2 个片段', `${clipPaths.length}`);
  assert(afterQuick.preset === 'quick', '任务档位为 quick', afterQuick.preset);
  assert(st1.loop_processing === 'skipped', 'quick 档下循环被跳过', st1.loop_processing);

  // ---------- 2. 补跑到 final ----------
  console.log('\n[2] 补跑到 final（只应跑 loop/transcoding/audio_mix/final_qc）');
  const r2 = pipeline.continueTask(taskId, { preset: 'final' });
  const cr = await r2;
  assert(cr.success === true, '补跑被接受', cr.error || '');
  assert(Array.isArray(cr.pending) && cr.pending.length === 4,
    '待跑 4 步（循环/转码/配乐/终检）', `pending=${(cr.pending || []).join(',')}`);
  assert(Array.isArray(cr.reused) && cr.reused.length === 4,
    '复用 4 步（提示词/分镜/片段/拼接）', `reused=${(cr.reused || []).join(',')}`);

  const afterResume = await waitDone(taskId);
  const st2 = statuses(afterResume);
  console.log(`  终态 ${afterResume.status} | 本轮状态: ${Object.entries(st2).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  assert(afterResume.status === 'completed', '补跑后任务完成', afterResume.status);

  // 【核心断言】片段生成必须是 reused，不能是重新执行的 completed
  assert(st2.clip_generation === 'reused',
    '片段生成标记为 reused（没有重新生成、没有重复花钱）', `实际 ${st2.clip_generation}`);
  assert(st2.concatenation === 'reused',
    '拼接标记为 reused', `实际 ${st2.concatenation}`);
  // 第1、2步（提示词优化 / 分镜）在补跑时会重新执行：它们不调用视频生成、
  // 不产生生成费用，只是重算文本，所以状态如实记为 completed 而非 reused。
  assert(st2.prompt_optimize === 'completed' && st2.storyboard === 'completed',
    '提示词与分镜本轮重新执行（不涉及视频生成费用，故如实记 completed）',
    `prompt=${st2.prompt_optimize}, storyboard=${st2.storyboard}`);
  assert(st2.loop_processing === 'completed',
    '循环本轮真实执行了', `实际 ${st2.loop_processing}`);
  assert(st2.transcoding === 'completed',
    '转码本轮真实执行了', `实际 ${st2.transcoding}`);
  assert(st2.final_qc === 'completed',
    '终检本轮真实执行了', `实际 ${st2.final_qc}`);

  // 【核心断言】片段文件确实没被重写
  const clipMtimes2 = clipPaths.map(p => fs.existsSync(p) ? fs.statSync(p).mtimeMs : -1);
  const unchanged = clipMtimes.every((m, i) => m === clipMtimes2[i]);
  assert(unchanged, '片段文件 mtime 未变（证明真的没重新生成）',
    unchanged ? '全部一致' : `前=${clipMtimes.join(',')} 后=${clipMtimes2.join(',')}`);

  // 产物必须存在
  assert(!!afterResume.outputPath && fs.existsSync(afterResume.outputPath),
    '补跑后产出成片', afterResume.outputPath);
  assert(fs.existsSync(path.join(__dirname, '..', 'output', `${taskId}_master.mp4`)),
    '补跑产出了无声母版（供后续改配乐复用）', `${taskId}_master.mp4`);

  // ---------- 3. 已完成档位再补跑 ----------
  console.log('\n[3] 已到 final 后再补跑 final');
  const r3 = await pipeline.continueTask(taskId, { preset: 'final' });
  assert(r3.success === true && r3.alreadyDone === true,
    '返回 alreadyDone（无需补跑）', `success=${r3.success}, alreadyDone=${r3.alreadyDone}`);

  // ---------- 4. 链路不完整必须报错 ----------
  console.log('\n[4] 链路不完整时不硬跑');
  const t2 = taskManager.createTask('测试链路不完整', {
    model: 'mock', totalClips: 1, clipDuration: 3, preset: 'clips_only'
  });
  // clips_only 只到片段生成，没有拼接产物；直接补跑到 final 应被拒
  const r4 = await pipeline.continueTask(t2.taskId, { preset: 'final' });
  // 此时 clips_only 还没跑过，steps 全是 pending，completed 为空
  assert(r4.success === false,
    '未完成任何步骤时补跑被拒（没有输入产物）', `success=${r4.success}, error=${String(r4.error).slice(0, 60)}`);

  // ---------- 5. 非法档位 ----------
  console.log('\n[5] 非法档位');
  const r5 = await pipeline.continueTask(taskId, { preset: 'not_a_preset' });
  assert(r5.success === false, '非法档位被判失败', `error=${String(r5.error).slice(0, 50)}`);

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }

  if (!KEEP) {
    // 用共享清理工具：必须同时清内存 + JSON + **数据库**。
    // 早期只清前两者，导致测试任务积在数据库里（实测踩过：一天积了 116 条）。
    const { cleanupMany } = require('./_test-cleanup');
    const cleaned = await cleanupMany([taskId, t2.taskId], taskManager);
    const badClean = cleaned.filter(c => !c.ok);
    if (badClean.length) {
      console.log('⚠️ 部分任务未清理：' + badClean.map(c => `${c.taskId}(${c.skipped})`).join(', '));
    }
    console.log('测试产物已清理（--keep 可保留）');
  } else {
    console.log(`产物保留：${taskId}`);
  }
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
