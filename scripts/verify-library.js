#!/usr/bin/env node
// ==========================================
// 片段库验收：价目表 / 费用口径 / 分组 / 跨规格拼接
// ==========================================
//
// 覆盖：
//   1) 价目表各模型单价与「单价 × 调用次数」口径
//   2) 分辨率归档标签
//   3) 库条目构建（规格/费用/耗时/历史标记）
//   4) 分组汇总与逐条相加一致
//   5) 跨分辨率/帧率拼接：必须归一化后才能出片，且产物可完整解码
//
// 不联网、不调用模型；只跑本机 ffmpeg，几秒钟。

const fs = require('fs');
const path = require('path');
const pricing = require('../src/pricing');
const library = require('../src/library');
const videoProcessor = require('../src/videoProcessor');

const APP_DIR = path.join(__dirname, '..');
const CLIPS_DIR = path.join(APP_DIR, 'clips');
const OUT_DIR = path.join(APP_DIR, 'output', 'verify_lib');
fs.mkdirSync(OUT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ❌ ' + name + (detail ? ' :: ' + detail : '')); }
}
function eq(name, actual, expected, tol = 0.001) {
  const a = Number(actual);
  const e = Number(expected);
  ok(name, Number.isFinite(a) && Math.abs(a - e) <= tol, `actual=${actual} expected=${expected}`);
}

console.log('\n[1] 价目表与费用口径');
const c1 = pricing.computeClipCost({ model: 'siliconflow', resolution: '720p', clipDurationSec: 5 }, 1);
eq('siliconflow ¥2/个', c1.amount, 2);
ok('siliconflow basis=per_clip', c1.basis === 'per_clip');
const c1b = pricing.computeClipCost({ model: 'siliconflow', resolution: '720p', clipDurationSec: 5 }, 2);
eq('重试 2 次 = ¥4', c1b.amount, 4);
const c2 = pricing.computeClipCost({ model: 'dashscope', resolution: '480p', clipDurationSec: 6 }, 1);
eq('Wan 480p 6s = ¥1.80', c2.amount, 1.8);
const c3 = pricing.computeClipCost({ model: 'kling', resolution: '1080p', clipDurationSec: 5 }, 1);
eq('可灵 1080p 5s = ¥6', c3.amount, 6);
const c4 = pricing.computeClipCost({ model: 'kling', resolution: '4K', clipDurationSec: 5 }, 1);
eq('可灵 4K 5s = ¥15', c4.amount, 15);
const c5 = pricing.computeClipCost({ model: 'seedance', resolution: '480p', clipDurationSec: 5, modelId: 'doubao-seedance-2.0-mini-250928' }, 1);
eq('Seedance mini = ¥0.58', c5.amount, 0.58);
const c6 = pricing.computeClipCost({ model: 'mock' }, 1);
eq('mock = ¥0', c6.amount, 0);
const c7 = pricing.computeClipCost({ model: 'no-such-model' }, 1);
ok('未知模型标记 computed=false', c7.computed === false);

console.log('\n[2] 分辨率归档');
ok('854×480 -> 480p', library.resolutionLabel(854, 480) === '480p');
ok('1280×720 -> 720p', library.resolutionLabel(1280, 720) === '720p');
ok('1920×1080 -> 1080p', library.resolutionLabel(1920, 1080) === '1080p');
ok('3840×2160 -> 4K', library.resolutionLabel(3840, 2160) === '4K');

console.log('\n[3] 库条目构建');
const sampleClip = path.join(CLIPS_DIR, 'task_mv4v7qp2_m8r0_clip_1.mp4');
if (!fs.existsSync(sampleClip)) {
  console.log('  ⚠️ 样例片段不存在，跳过条目构建用例: ' + sampleClip);
} else {
  const probe = videoProcessor.probeDetail(sampleClip);
  ok('ffprobe 可读样例片段', probe.success === true, probe.error || '');
  const task = {
    taskId: 'verify_tmp',
    model: 'dashscope',
    resolution: '720p',
    clipDuration: 7,
    prompt: '原始提示词',
    prompts: null,
    runtimeConfig: {}
  };
  const clip = {
    index: 0,
    prompt: '优化后提示词',
    attempts: 1,
    videoPath: sampleClip,
    qcResult: { passed: true, reason: '通过', qcVersion: 2 },
    timing: { genStartedAt: '2026-10-20T00:00:00.000Z', genCompletedAt: '2026-10-20T00:01:00.000Z', qcStartedAt: '2026-10-20T00:01:00.000Z', qcCompletedAt: '2026-10-20T00:01:30.000Z' }
  };
  const entry = library.buildEntry(task, clip, sampleClip, probe);
  ok('条目 id 规则', entry.id === 'verify_tmp_c1', entry.id);
  ok('分辨率 1280×720', entry.width === 1280 && entry.height === 720, `${entry.width}x${entry.height}`);
  ok('归档 720p', entry.tags.resolution === '720p', entry.tags.resolution);
  eq('费用 = 0.6×7 = 4.20', entry.cost.amount, 4.2);
  ok('耗时两段可用', entry.timing.splitAvailable === true, JSON.stringify(entry.timing));
  eq('生成耗时 60s', Math.round(entry.timing.genMs / 1000), 60);
  eq('质检耗时 30s', Math.round(entry.timing.qcMs / 1000), 30);
  ok('提示词取优化版', entry.prompt === '优化后提示词');
  ok('原始提示词保留', entry.originalPrompt === '原始提示词');

  const oldClip = { index: 1, prompt: 'x', attempts: 1, videoPath: sampleClip, qcResult: { passed: true }, createdAt: '2026-10-12T00:00:00.000Z', completedAt: '2026-10-12T00:05:00.000Z' };
  const oldEntry = library.buildEntry(task, oldClip, sampleClip, probe);
  ok('历史条目标记 historical', oldEntry.timing.historical === true);
  ok('历史条目没有分段耗时', oldEntry.timing.splitAvailable === false);
}

console.log('\n[4] 分组汇总');
const grouped = library.grouped();
const all = library.listAll();
ok('分组总数 = 条目总数', grouped.totals.count === all.length, `${grouped.totals.count} vs ${all.length}`);
const groupSum = grouped.groups.reduce((s, g) => s + g.count, 0);
ok('各组数量相加 = 总数', groupSum === all.length, `${groupSum} vs ${all.length}`);
const costSum = pricing.round2(grouped.groups.reduce((s, g) => s + g.totalCost, 0));
eq('各组费用相加 = 总费用', costSum, grouped.totals.totalCost, 0.011);
if (all.length) {
  ok('库内条目都不是 mock', all.every(it => it.model !== 'mock'));
}

console.log('\n[5] 跨分辨率/帧率拼接');
function pickClip(name) {
  const p = path.join(CLIPS_DIR, name);
  return fs.existsSync(p) ? p : null;
}
const c480 = pickClip('task_mv4r94lq_3cy7_clip_1.mp4');
const c720_16 = pickClip('task_mukptvrj_xbjn_clip_1.mp4');
const c720_30a = pickClip('task_mv4v7qp2_m8r0_clip_1.mp4');
const c720_30b = pickClip('task_mv4v7qp2_m8r0_clip_2.mp4');

(async () => {
  if (c480 && c720_16 && c720_30a) {
    const outMixed = path.join(OUT_DIR, 'verify_mixed.mp4');
    const r = await videoProcessor.concatenateSegments([
      { path: c480 }, { path: c720_16 }, { path: c720_30a }
    ], outMixed, { resolution: '720p', fps: 30 });
    ok('混合规格拼接成功', r.success === true, r.error || '');
    if (r.success) {
      ok('至少归一化 1 段', (r.normalized || 0) >= 1, 'normalized=' + r.normalized);
      ok('产物可完整解码', !!(r.decodeCheck && r.decodeCheck.ok), JSON.stringify(r.decodeCheck));
      eq('产物时长 ≈ 17.06s', r.durationCheck.actual, 17.06, 0.5);
      const probe = videoProcessor.probeDetail(outMixed);
      ok('产物统一 1280×720@30', probe.width === 1280 && probe.height === 720 && Math.abs(probe.fpsNum - 30) < 0.01,
        `${probe.width}x${probe.height}@${probe.fpsNum}`);
    }
  } else {
    console.log('  ⚠️ 样例片段不全，跳过混合规格拼接');
  }

  if (c720_30a && c720_30b) {
    const outSame = path.join(OUT_DIR, 'verify_same.mp4');
    const r = await videoProcessor.concatenateSegments([
      { path: c720_30a }, { path: c720_30b }
    ], outSame, { resolution: '720p', fps: 30 });
    ok('同规格拼接成功', r.success === true, r.error || '');
    if (r.success) {
      ok('同规格走 copy 不再重编码', (r.normalized || 0) === 0, 'normalized=' + r.normalized);
      ok('同规格产物可解码', !!(r.decodeCheck && r.decodeCheck.ok));
      eq('同规格时长 ≈ 14s', r.durationCheck.actual, 14, 0.5);
    }
  }

  // 清理本轮产物，避免 output/ 越跑越大
  for (const f of ['verify_mixed.mp4', 'verify_same.mp4']) {
    try { const p = path.join(OUT_DIR, f); if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
  }

  console.log('\n========================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
  }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
