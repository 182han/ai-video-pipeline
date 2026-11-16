#!/usr/bin/env node
// ==========================================================
// 验收：出图 → 图生视频 + 审图暂停（2026-11-16）
// ----------------------------------------------------------
// 契约：app/docs/交接/2026-11-16-出图审图-接口契约.md §1/§2
//
// 覆盖（全部零真实计费：出图用 registerImageProvider 注册的本地 stub，
// 视频用 model=mock，数据库用 json 驱动 + 临时目录）：
//   [1] overridesFromRuntimeConfig：5 个运行时字段 → IMAGE_GEN_*，空值回落
//   [2] 全链路：逐段出图（张数=段数）→ photoIds 写回 → 审图暂停
//       （status/currentStep/awaitingImageReview）→ supervisor.taskView + 只提醒一次
//       → unpause 自动 approved → 图生视频请求里真的带了图 → 片段成功
//   [3] 幂等：已有可用图的任务再跑出图步骤 → generated=0、不重复调用出图、不新增图库条目
//   [4] 负向：出图未就绪 → 任务失败且不降级（不建图、不发视频请求）
//   [5] 负向：余额不足 → 任务失败（不发视频请求）
//   [6] 负向：图片被打回 → 该片段失败、不走图生视频；_i2vPayload 拒绝未通过的图
//   [7] 负向：缺 approved 首帧图时 _batchGenerate 直接判片段 failed（不发视频请求）
//   [8] 负向：审图等待超时 → failureCode=image_review_timeout
//   [9] 负向：从未启动过的 pristine 任务 continueTask 仍被拒（契约 §2.6 收窄版）
//   [10] 正向：审图暂停后（模拟重启）continueTask({preset:'quick'}) 放行并跑到片段成功
//
// 用法：node scripts/verify-image-first-pipeline.js
// 隔离：CLIPS_DIR/OUTPUT_DIR/DATA_DIR/LIBRARY_DIR/PHOTOS_DIR/PROJECTS_DIR/BUDGET_FILE/
//       ASSISTANT_DIR 全指向 data/tmp-verify-image-first-* 临时目录；任务用 _test-cleanup 清理。
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
// 临时目录放 data/tmp/（已在 .gitignore，且本脚本结束时必删），避免交付时在 git status 里留残留。
const TMP_ROOT = path.join(APP_DIR, 'data', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'verify-image-first-'));
const DIRS = {
  clips: path.join(TMP, 'clips'),
  output: path.join(TMP, 'output'),
  tasks: path.join(TMP, 'tasks'),
  library: path.join(TMP, 'library'),
  photos: path.join(TMP, 'photos'),
  projects: path.join(TMP, 'projects'),
  assistant: path.join(TMP, 'assistant')
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// 必须先设 env 再 require 业务模块（config 在 require 时读取）。
process.env.CLIPS_DIR = DIRS.clips;
process.env.OUTPUT_DIR = DIRS.output;
process.env.DATA_DIR = DIRS.tasks;
process.env.LIBRARY_DIR = DIRS.library;
process.env.PHOTOS_DIR = DIRS.photos;
process.env.PROJECTS_DIR = DIRS.projects;
process.env.ASSISTANT_DIR = DIRS.assistant;
process.env.BUDGET_FILE = path.join(TMP, 'budget.json');
process.env.BUDGET_USD = '10';
// Mock 视频零随机失败（验收只关掉随机失败，不改任何判定逻辑）
process.env.MOCK_FAIL_RATE = '0';
// 出图 stub 厂商：注册在下面，配置从 env 读（task.runtimeConfig 会再覆盖一遍）
process.env.IMAGE_GEN_PROVIDER = 'verify-stub';
process.env.IMAGE_GEN_API_KEY = 'verify-fake-key-not-used';
process.env.IMAGE_GEN_BASE_URL = 'http://127.0.0.1:9/verify-stub';
process.env.IMAGE_GEN_MODEL = 'verify-stub-image';
process.env.IMAGE_GEN_SIZE = '1696*960';
// 本套件只验证出图/审图接线，不验证存储驱动
process.env.DATABASE_TYPE = 'json';

const config = require('../config');
const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');
const photoLibrary = require('../src/photoLibrary');
const budget = require('../src/budget');
const imageGen = require('../src/generators/imageGen');
const MockGenerator = require('../src/generators/mock');
const qualityChecker = require('../src/qualityChecker');
const memory = require('../src/assistant/memory');
const stateMachine = require('../src/assistant/stateMachine');
const supervisor = require('../src/assistant/supervisor');

// Mock 样片用 execSync 生成时本机 spawn cmd.exe 会 EPERM（AGENTS §2.3 已知环境限制）；
// 这里用 execFileSync（无 shell、不捕获 stdout）预生成样片，MockGenerator 检测到缓存就复制。
const REAL_CLIPS_DIR = path.join(APP_DIR, 'clips');
const clipsSnapshot = new Set(
  fs.existsSync(REAL_CLIPS_DIR) ? fs.readdirSync(REAL_CLIPS_DIR) : []
);
const preparedSamples = [];

function prepareMockSample(resolution, duration) {
  const { execFileSync } = require('child_process');
  const sampleDir = path.join(REAL_CLIPS_DIR, '_samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const out = path.join(sampleDir, `sample_${resolution}_${duration}s.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out;
  let width = 1280;
  let height = 720;
  if (resolution === '1080p') { width = 1920; height = 1080; }
  else if (resolution === '480p') { width = 854; height = 480; }
  execFileSync(config.FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', `color=c=0x4a90d9:s=${width}x${height}:d=${duration}`,
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', out
  ], { stdio: 'ignore', timeout: 60000 });
  preparedSamples.push(out);
  return out;
}

function cleanupMockArtifacts() {
  if (!fs.existsSync(REAL_CLIPS_DIR)) return;
  for (const name of fs.readdirSync(REAL_CLIPS_DIR)) {
    if (clipsSnapshot.has(name)) continue;
    if (!/^mock_.*\.mp4$/.test(name)) continue;
    try { fs.unlinkSync(path.join(REAL_CLIPS_DIR, name)); } catch (e) { /* ignore */ }
  }
  for (const f of preparedSamples) {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

// ===== 出图 stub：真实落盘一张合法 PNG（不走网络、不产生费用） =====
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==',
  'base64'
);
const imageCalls = [];
imageGen.registerImageProvider('verify-stub', async ({ prompt, options = {}, config: cfg = {} }) => {
  imageCalls.push({
    prompt,
    index: options.index,
    taskId: options.taskId,
    size: options.size,
    negativePrompt: options.negativePrompt,
    provider: cfg.IMAGE_GEN_PROVIDER,
    model: cfg.IMAGE_GEN_MODEL
  });
  const outDir = options.outDir || DIRS.clips;
  fs.mkdirSync(outDir, { recursive: true });
  const idx = Number.isInteger(options.index) ? options.index : 0;
  const filePath = path.join(outDir, `${options.taskId || 'stub'}_img_${idx}.png`);
  fs.writeFileSync(filePath, PNG_1X1);
  return {
    imagePath: filePath,
    width: 1696,
    height: 960,
    provider: 'verify-stub',
    model: cfg.IMAGE_GEN_MODEL || 'verify-stub-image'
  };
});

// ===== Mock 视频生成器埋点：证明「图生视频请求里真的带了图」 =====
const mockCalls = [];
const origMockGenerate = MockGenerator.prototype.generate;
MockGenerator.prototype.generate = async function (prompt, options = {}) {
  mockCalls.push({ prompt, options });
  return origMockGenerate.call(this, prompt, options);
};

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? `  —  ${extra}` : ''}`);
  } else {
    fail += 1;
    failures.push({ name, extra });
    console.log(`  ❌ ${name}${extra ? `  —  ${extra}` : ''}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let v = null;
    try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

async function waitDone(taskId, timeoutMs = 180000) {
  return waitFor(() => {
    const t = taskManager.getTask(taskId);
    if (!t) return null;
    return ['completed', 'partial', 'failed'].includes(t.status) ? t : null;
  }, timeoutMs, `任务 ${taskId} 结束`);
}

async function waitPausedForImageReview(taskId, timeoutMs = 60000) {
  return waitFor(() => {
    const t = taskManager.getTask(taskId);
    if (!t) return null;
    return (t.status === 'paused' && t.awaitingImageReview === true) ? t : null;
  }, timeoutMs, `任务 ${taskId} 进入审图暂停`);
}

function imageReviewBase(overrides = {}) {
  return {
    imagePerClip: true,
    imageApiKey: 'verify-fake-key-not-used',
    imageBaseUrl: 'http://127.0.0.1:9/verify-stub',
    imageProvider: 'verify-stub',
    imageModel: 'verify-stub-image',
    imageSize: '1696*960',
    ...overrides
  };
}

function makeTask(options = {}) {
  return taskManager.createTask(options.prompt || '冰岛极光与黑沙滩', {
    model: 'mock',
    totalClips: options.totalClips || 2,
    clipDuration: 3,
    resolution: '720p',
    theme: 'landscape',
    preset: options.preset || 'clips_only',
    autoRetry: options.autoRetry !== undefined ? options.autoRetry : true,
    ...(options.sceneCards === false ? {} : { sceneCards: { enabled: true } }),
    runtimeConfig: imageReviewBase(options.runtimeConfig || {})
  });
}

function stateMessages(sessionId) {
  try {
    const session = memory.getSession(sessionId);
    return (session && session.messages ? session.messages : [])
      .filter(m => m && m.kind === 'state' && /图出好了/.test(String(m.text || '')));
  } catch (e) {
    return [];
  }
}

async function main() {
  console.log('='.repeat(64));
  console.log('出图 → 图生视频 + 审图暂停 — 验收（零真实计费）');
  console.log('='.repeat(64));
  const taskIds = [];
  prepareMockSample('720p', 3);

  // ================= [1] 覆盖键映射 =================
  console.log('\n[1] overridesFromRuntimeConfig：运行时字段 → IMAGE_GEN_*');
  const ov = imageGen.overridesFromRuntimeConfig(imageReviewBase());
  ok('5 个字段全部映射到 IMAGE_GEN_*',
    ov.IMAGE_GEN_API_KEY === 'verify-fake-key-not-used'
    && ov.IMAGE_GEN_BASE_URL === 'http://127.0.0.1:9/verify-stub'
    && ov.IMAGE_GEN_PROVIDER === 'verify-stub'
    && ov.IMAGE_GEN_MODEL === 'verify-stub-image'
    && ov.IMAGE_GEN_SIZE === '1696*960',
    JSON.stringify(Object.keys(ov)));
  const ovEmpty = imageGen.overridesFromRuntimeConfig({ imageApiKey: '', imageProvider: '   ' });
  ok('空串/空白不产生覆盖（回落到 .env）', Object.keys(ovEmpty).length === 0, JSON.stringify(ovEmpty));
  ok('未知/非字符串字段被忽略', Object.keys(imageGen.overridesFromRuntimeConfig({
    imageApiKey: 123, imageProvider: { x: 1 }, otherKey: 'x'
  })).length === 0);
  const stUsable = imageGen.getImageGenStatus(ov);
  ok('stub 厂商已注册 → 就绪度 usable=true（配置齐备）',
    stUsable.usable === true, `missing=${stUsable.missing.join(',')} registered=${stUsable.registeredProviders.join(',')}`);

  // ================= [2] 全链路：出图 → 审图暂停 → 继续 → 图生视频 =================
  console.log('\n[2] 全链路：逐段出图 → 审图暂停 → 继续 → 图生视频');
  const p1 = makeTask({ prompt: '冰岛极光与黑沙滩', totalClips: 2, preset: 'clips_only' });
  const p1id = p1.taskId;
  taskIds.push(p1id);
  ok('任务创建即开启出图链路（imagePerClip=true）',
    p1.runtimeConfig && p1.runtimeConfig.imagePerClip === true);
  const imageCallsBeforeP1 = imageCalls.length;
  pipeline.startTask(p1id);
  const paused = await waitPausedForImageReview(p1id);

  ok('审图暂停：status=paused', paused.status === 'paused', paused.status);
  ok('审图暂停：awaitingImageReview=true', paused.awaitingImageReview === true);
  ok('审图暂停：currentStep 文案含「等待审图」',
    /等待审图/.test(String(paused.currentStep || '')), paused.currentStep);
  ok('任务记录 imageReview.required=true', !!(paused.imageReview && paused.imageReview.required === true));
  ok('暂停时 imageReview 结构完整（generatedAt/reviewedAt=null/autoApproved=0/settledBy=null/failedIndices/rejectedClips）',
    typeof paused.imageReview.generatedAt === 'string'
    && !Number.isNaN(Date.parse(paused.imageReview.generatedAt))
    && paused.imageReview.reviewedAt === null
    && paused.imageReview.autoApproved === 0
    && paused.imageReview.settledBy === null
    && Array.isArray(paused.imageReview.failedIndices)
    && paused.imageReview.failedIndices.length === 0
    && Array.isArray(paused.imageReview.rejectedClips)
    && paused.imageReview.rejectedClips.length === 0,
    JSON.stringify({
      generatedAt: paused.imageReview.generatedAt,
      reviewedAt: paused.imageReview.reviewedAt,
      autoApproved: paused.imageReview.autoApproved,
      settledBy: paused.imageReview.settledBy
    }));
  ok('出图张数 = 段数（generated=2 / total=2）',
    paused.imageReview.generated === 2 && paused.imageReview.total === 2,
    `generated=${paused.imageReview.generated} total=${paused.imageReview.total}`);
  ok('photoIds 与段数一致且非空',
    Array.isArray(paused.imageReview.photoIds) && paused.imageReview.photoIds.length === 2
    && paused.imageReview.photoIds.every(Boolean),
    JSON.stringify(paused.imageReview.photoIds));
  ok('每个片段都写回了 photoId',
    paused.clips.every(c => !!c.photoId && c.imageStatus === 'generated'),
    paused.clips.map(c => `${c.index}:${c.photoId || '无'}`).join(','));
  ok('photoId 命名 = <taskId>_img_<index>（首次出图）',
    paused.clips.every(c => c.photoId === photoLibrary.makeId(p1id, c.index)),
    paused.clips.map(c => c.photoId).join(','));
  ok('图库里的图是 pending（待审，不是 approved）',
    paused.imageReview.photoIds.every(id => {
      const p = photoLibrary.get(id);
      return p && p.status === 'pending' && fs.existsSync(p.filePath);
    }));
  ok('出图调用 2 次（张数=段数，逐段一张）',
    imageCalls.length - imageCallsBeforeP1 === 2,
    `calls=${imageCalls.length - imageCallsBeforeP1}`);
  ok('出图用的是片段自己的图片提示词（imagePrompt）',
    paused.clips.every((c) => {
      const call = imageCalls.slice(imageCallsBeforeP1).find(x => x.index === c.index);
      return call && call.prompt === c.imagePrompt && call.taskId === p1id;
    }),
    paused.clips.map((c) => `${c.index}:${String(c.imagePrompt || '').slice(0, 24)}`).join(' | '));
  ok('暂停期间没有发起任何视频请求（未花视频的钱）', mockCalls.length === 0,
    `mockCalls=${mockCalls.length}`);

  // supervisor.taskView + 每计划只提醒一次
  const viewPaused = supervisor.taskView(taskManager.getTask(p1id));
  ok('supervisor.taskView.awaitingImageReview=true', viewPaused.awaitingImageReview === true);
  ok('supervisor.taskView.imageReview 计数现算：pending=2 / approved=0 / rejected=0',
    viewPaused.imageReview && viewPaused.imageReview.pendingPhotos === 2
    && viewPaused.imageReview.approvedPhotos === 0
    && viewPaused.imageReview.rejectedPhotos === 0,
    JSON.stringify(viewPaused.imageReview));
  const sid = 'verify_image_first_session';
  let tickErr = null;
  try {
    memory.getOrCreate(sid);
    let st = stateMachine.create({ planId: 'plan_verify_image_first' }, { sessionId: sid });
    st = { ...st, taskId: p1id };
    memory.setState(sid, st);
    const m = {
      sessionId: sid, planId: 'plan_verify_image_first', taskId: p1id,
      finalTaskId: null, phase: 'primary', busy: false, stopped: false, ticks: 0, timer: null
    };
    await supervisor._tick(m);
    const afterFirst = stateMessages(sid).length;
    await supervisor._tick(m);
    const afterSecond = stateMessages(sid).length;
    ok('tick 在 paused+awaitingImageReview 时追加一次会话提醒', afterFirst === 1, `messages=${afterFirst}`);
    ok('tick 同一计划不重复提醒（不刷屏）', afterSecond === 1, `messages=${afterSecond}`);
  } catch (e) {
    tickErr = e;
  }
  ok('tick 运行未抛错', tickErr === null, tickErr ? tickErr.message : '');

  // unpause → 自动 approved
  const resumed = pipeline.resumeTask(p1id);
  ok('resumeTask 成功且返回自动通过张数 2',
    resumed.success === true && resumed.approvedPhotos === 2,
    `success=${resumed.success} approvedPhotos=${resumed.approvedPhotos}`);
  const afterResume = taskManager.getTask(p1id);
  ok('继续后图库状态变成 approved（_i2vPayload 只认 approved）',
    afterResume.imageReview.photoIds.every(id => {
      const p = photoLibrary.get(id);
      return p && p.status === 'approved';
    }));
  ok('继续后写入 reviewedAt / autoApproved / settledBy=unpause',
    !!afterResume.imageReview.reviewedAt
    && afterResume.imageReview.autoApproved === 2
    && afterResume.imageReview.settledBy === 'unpause'
    && afterResume.imageReview.rejectedClips.length === 0,
    JSON.stringify({
      reviewedAt: afterResume.imageReview.reviewedAt,
      autoApproved: afterResume.imageReview.autoApproved,
      settledBy: afterResume.imageReview.settledBy
    }));
  ok('继续后 awaitingImageReview 已清掉', afterResume.awaitingImageReview !== true);

  const p1done = await waitDone(p1id);
  ok('继续后任务跑到终态 completed', p1done.status === 'completed',
    `status=${p1done.status}${p1done.error ? ' error=' + p1done.error : ''}`);
  ok('clips_only 档：片段包交付（fragmentOnly）', p1done.fragmentOnly === true && !p1done.outputPath);
  ok('2 个片段全部成功且视频文件真实存在',
    p1done.clips.length === 2
    && p1done.clips.every(c => c.status === 'success' && pipeline._resolveClipPath(c.videoPath)),
    p1done.clips.map(c => `${c.index}:${c.status}`).join(','));
  ok('视频请求 2 次（每个片段一次）', mockCalls.length === 2, `mockCalls=${mockCalls.length}`);
  ok('图生视频请求里真的带了首帧图（photoId 与片段一致 + base64 非空）',
    mockCalls.length === 2
    && mockCalls.every((call, i) => {
      const img = call.options && call.options.image;
      const clip = p1done.clips[i];
      return img
        && img.photoId === clip.photoId
        && typeof img.base64 === 'string' && img.base64.length > 0
        && /^data:image\/png;base64,/.test(String(img.dataUrl || ''))
        && img.filePath && fs.existsSync(img.filePath);
    }),
    mockCalls.map(c => (c.options && c.options.image && c.options.image.photoId) || '无图').join(','));
  const viewDone = supervisor.taskView(taskManager.getTask(p1id));
  ok('终态 taskView：awaitingImageReview=false / approvedPhotos=2',
    viewDone.awaitingImageReview === false
    && viewDone.imageReview && viewDone.imageReview.approvedPhotos === 2,
    JSON.stringify(viewDone.imageReview));

  // ================= [3] 幂等：不重复出图/计费 =================
  console.log('\n[3] 幂等：已有可用图的片段不再出图');
  const photoCountBefore = photoLibrary.listAll().length;
  const imageCallCountBefore = imageCalls.length;
  const again = await pipeline._generateClipImages(p1id, taskManager.getTask(p1id));
  ok('再次执行出图步骤：generated=0 / reused=2',
    again.generated === 0 && again.reused === 2,
    `generated=${again.generated} reused=${again.reused}`);
  ok('未重复调用出图适配器（不重复计费）',
    imageCalls.length === imageCallCountBefore, `calls=${imageCalls.length - imageCallCountBefore}`);
  ok('未新增图片库条目', photoLibrary.listAll().length === photoCountBefore,
    `photos=${photoLibrary.listAll().length}`);

  // ================= [4] 负向：出图未就绪 =================
  console.log('\n[4] 负向：出图未就绪 → 任务失败且不降级');
  const n1 = makeTask({ prompt: '出图未就绪用例', totalClips: 2, runtimeConfig: { imageProvider: 'no-such-provider-xyz' } });
  const n1id = n1.taskId;
  taskIds.push(n1id);
  const videoBeforeN1 = mockCalls.length;
  const imageBeforeN1 = imageCalls.length;
  pipeline.startTask(n1id);
  const n1done = await waitDone(n1id);
  ok('出图未就绪 → 任务 failed', n1done.status === 'failed', n1done.status);
  ok('失败原因含「出图未就绪」与未注册厂商提示',
    /出图未就绪/.test(String(n1done.error || ''))
    && /未注册适配器/.test(String(n1done.error || ''))
    && /设置 → 图片生成/.test(String(n1done.error || '')),
    String(n1done.error || '').slice(0, 160));
  ok('failureCode=IMAGE_GEN_NOT_READY', n1done.failureCode === 'IMAGE_GEN_NOT_READY', n1done.failureCode);
  ok('没有生成任何图（不返回占位图）', imageCalls.length === imageBeforeN1
    && !n1done.clips.some(c => c.photoId));
  ok('没有发起任何视频请求（绝不降级为文生视频）', mockCalls.length === videoBeforeN1);

  // ================= [5] 负向：余额不足 =================
  console.log('\n[5] 负向：余额不足 → 任务失败');
  budget.setBalance(0.01);
  const n2 = makeTask({ prompt: '余额不足用例', totalClips: 2 });
  const n2id = n2.taskId;
  taskIds.push(n2id);
  const videoBeforeN2 = mockCalls.length;
  const imageBeforeN2 = imageCalls.length;
  pipeline.startTask(n2id);
  const n2done = await waitDone(n2id);
  budget.setBalance(10);
  ok('余额不足 → 任务 failed', n2done.status === 'failed', n2done.status);
  ok('失败原因含「余额不足」+ 需要的张数/剩余额度',
    /余额不足/.test(String(n2done.error || ''))
    && /2 张/.test(String(n2done.error || ''))
    && /剩余 \$/.test(String(n2done.error || '')),
    String(n2done.error || '').slice(0, 160));
  ok('failureCode=INSUFFICIENT_BUDGET', n2done.failureCode === 'INSUFFICIENT_BUDGET', n2done.failureCode);
  ok('没有出图、没有视频请求', imageCalls.length === imageBeforeN2 && mockCalls.length === videoBeforeN2);

  // ================= [6] 负向：图片被打回 =================
  console.log('\n[6] 负向：图片被打回 → 对应片段失败，不走图生视频');
  const n3 = makeTask({ prompt: '图片被打回用例', totalClips: 2, autoRetry: false });
  const n3id = n3.taskId;
  taskIds.push(n3id);
  pipeline.startTask(n3id);
  const n3paused = await waitPausedForImageReview(n3id);
  const n3rejectedId = n3paused.imageReview.photoIds[0];
  photoLibrary.markReviewed(n3rejectedId, 'rejected', '验收：故意打回第 1 段');
  const settledReject = pipeline._settleImageReview(n3id, 'continue');
  ok('结算把被打回的图记入 rejectedClips=[0]',
    settledReject.settled === true
    && settledReject.rejectedClips.length === 1
    && settledReject.rejectedClips[0] === 0,
    JSON.stringify(settledReject));
  const n3afterSettle = taskManager.getTask(n3id);
  ok('结算把该片段置 failed，文案含「图片被打回」',
    n3afterSettle.clips[0].status === 'failed'
    && /图片被打回/.test(String(n3afterSettle.clips[0].error || '')),
    n3afterSettle.clips[0].error);
  ok('被打回的图仍是 rejected（不被自动洗白）',
    photoLibrary.get(n3rejectedId).status === 'rejected');
  let i2vRejectedErr = null;
  try {
    await pipeline._i2vPayload(n3afterSettle, n3afterSettle.clips[0]);
  } catch (e) { i2vRejectedErr = e; }
  ok('_i2vPayload 拒绝未通过审核的图（不静默退回文生视频）',
    !!i2vRejectedErr && /审核/.test(i2vRejectedErr.message),
    i2vRejectedErr ? i2vRejectedErr.message : '未抛错');
  const videoBeforeN3 = mockCalls.length;
  const imageBeforeN3 = imageCalls.length;
  const n3resume = pipeline.resumeTask(n3id);
  ok('被打回后点「继续」仍被接受（其余片段继续生成）', n3resume.success === true, n3resume.error || '');
  const n3done = await waitDone(n3id);
  ok('被打回的片段最终 status=failed', n3done.clips[0].status === 'failed', n3done.clips[0].status);
  ok('该片段错误含「缺少首帧图，拒绝降级为文生视频」',
    /缺少首帧图，拒绝降级为文生视频/.test(String(n3done.clips[0].error || '')),
    String(n3done.clips[0].error || '').slice(0, 120));
  ok('另一个片段正常成功（不受牵连）', n3done.clips[1].status === 'success', n3done.clips[1].status);
  ok('只为 1 个片段发起了视频请求（被打回的那段没有发请求）',
    mockCalls.length - videoBeforeN3 === 1,
    `calls=${mockCalls.length - videoBeforeN3}`);
  ok('被打回后没有自动重出图（重出图必须用户显式发起，避免自动洗白审图）',
    imageCalls.length === imageBeforeN3, `imageCalls=${imageCalls.length - imageBeforeN3}`);
  ok('任务停在拼接前并如实失败（autoRetry=false）',
    n3done.status === 'failed' && /片段失败/.test(String(n3done.error || '')),
    String(n3done.error || '').slice(0, 120));

  // ================= [7] 负向：无图直接批生成 → 守卫拒绝降级 =================
  console.log('\n[7] 负向：缺 approved 首帧图时 _batchGenerate 守卫');
  const n4 = makeTask({ prompt: '缺首帧图守卫用例', totalClips: 2, sceneCards: false });
  const n4id = n4.taskId;
  taskIds.push(n4id);
  let guardCalls = 0;
  const neverCalledGenerator = {
    async generate() { guardCalls += 1; throw new Error('守卫失效：不应发起视频请求'); }
  };
  // _batchGenerate 的 worker 会检查 runningTasks（正常运行由 startTask 加入）；
  // 这里直接调它，必须先标记「任务在跑」，否则 worker 会当任务已结束直接返回。
  pipeline.runningTasks.add(n4id);
  try {
    await pipeline._batchGenerate(n4id, neverCalledGenerator);
  } finally {
    pipeline.runningTasks.delete(n4id);
  }
  const n4after = taskManager.getTask(n4id);
  ok('守卫把两个片段都判 failed',
    n4after.clips.every(c => c.status === 'failed'), n4after.clips.map(c => c.status).join(','));
  ok('错误文案含「缺少首帧图，拒绝降级为文生视频」',
    n4after.clips.every(c => /缺少首帧图，拒绝降级为文生视频/.test(String(c.error || ''))),
    String(n4after.clips[0].error || '').slice(0, 120));
  ok('未调用视频生成器（不发请求、不计费）', guardCalls === 0, `calls=${guardCalls}`);

  // ================= [8] 负向：审图等待超时 =================
  console.log('\n[8] 负向：审图等待超时 → failureCode=image_review_timeout');
  process.env.IMAGE_REVIEW_MAX_WAIT_MS = '700';
  const n5 = makeTask({ prompt: '审图超时用例', totalClips: 2, preset: 'clips_only' });
  const n5id = n5.taskId;
  taskIds.push(n5id);
  const videoBeforeN5 = mockCalls.length;
  pipeline.startTask(n5id);
  await waitPausedForImageReview(n5id);
  const n5done = await waitDone(n5id, 30000);
  delete process.env.IMAGE_REVIEW_MAX_WAIT_MS;
  ok('审图超时 → 任务 failed', n5done.status === 'failed', n5done.status);
  ok('failureCode=image_review_timeout', n5done.failureCode === 'image_review_timeout', n5done.failureCode);
  ok('错误文案指向「等待审图超过」+ 可补跑 + recoverable',
    /等待审图超过/.test(String(n5done.error || ''))
    && /补跑/.test(String(n5done.error || ''))
    && n5done.recoverable === true,
    String(n5done.error || '').slice(0, 160));
  ok('超时后 awaitingImageReview 被清掉', n5done.awaitingImageReview !== true);
  ok('超时期间没有发起视频请求', mockCalls.length === videoBeforeN5);
  await waitFor(() => !pipeline.runningTasks.has(n5id), 15000, '超时任务流水线退出');

  // ================= [9] 负向：pristine 任务补跑仍被拒 =================
  console.log('\n[9] 负向：从未启动过的 pristine 任务 continueTask 仍被拒（契约 §2.6 收窄版）');
  const pristine = makeTask({ prompt: 'pristine 任务', totalClips: 2, preset: 'clips_only' });
  const pristineId = pristine.taskId;
  taskIds.push(pristineId);
  const pristineResume = await pipeline.continueTask(pristineId, { preset: 'final' });
  ok('pristine 任务补跑被拒（success=false）', pristineResume.success === false,
    `success=${pristineResume.success}`);
  ok('错误文案保持原文案',
    pristineResume.error === '补跑需要拼接产物，但拼接尚未完成；请先跑完到拼接步骤',
    String(pristineResume.error || ''));
  ok('被拒后任务没有被启动（status 仍是 pending）',
    taskManager.getTask(pristineId).status === 'pending',
    taskManager.getTask(pristineId).status);

  // ================= [10] 正向：审图暂停后 continueTask 放行 =================
  console.log('\n[10] 正向：审图暂停后（模拟重启）continueTask 放行并继续到片段成功');
  // 用短超时让本进程里等待审图的流水线自然结束（等价于重启后 paused 标记丢失），
  // 避免「清 runningTasks 让旧流水线恢复」与「新补跑」两条流水线并行。
  process.env.IMAGE_REVIEW_MAX_WAIT_MS = '700';
  const p2 = makeTask({ prompt: '审图后补跑用例', totalClips: 2, preset: 'clips_only' });
  const p2id = p2.taskId;
  taskIds.push(p2id);
  pipeline.startTask(p2id);
  await waitPausedForImageReview(p2id);
  const p2timeout = await waitDone(p2id, 30000);
  delete process.env.IMAGE_REVIEW_MAX_WAIT_MS;
  await waitFor(() => !pipeline.runningTasks.has(p2id), 20000, '暂停等待退出');
  ok('审图暂停的任务因等待超时停下（流水线已退出，容器里不会有两个流水线）',
    p2timeout.status === 'failed' && p2timeout.failureCode === 'image_review_timeout',
    `${p2timeout.status}/${p2timeout.failureCode}`);
  // 等价于 reconcileInterruptedTasks 对重启残留的处理
  taskManager.updateTaskStatus(p2id, 'failed', {
    error: '暂停期间服务被重启，任务已中止（验收注入，模拟 reconcileInterruptedTasks）',
    failureCode: 'pause_interrupted',
    recoverable: true
  });
  const completedBefore = pipeline._completedSteps(taskManager.getTask(p2id));
  ok('模拟重启后已完成步骤只有提示词/分镜（片段尚未生成）',
    !completedBefore.includes('clip_generation') && !completedBefore.includes('concatenation'),
    JSON.stringify(completedBefore));
  const imageBeforeP2Resume = imageCalls.length;
  const p2continue = await pipeline.continueTask(p2id, { preset: 'quick' });
  ok('continueTask 放行（success=true）', p2continue.success === true,
    `success=${p2continue.success} error=${String(p2continue.error || '')}`);
  ok('本次 pending 含 clip_generation', Array.isArray(p2continue.pending)
    && p2continue.pending.includes('clip_generation'), (p2continue.pending || []).join(','));
  const p2done = await waitDone(p2id, 180000);
  ok('补跑后任务完成', p2done.status === 'completed',
    `status=${p2done.status}${p2done.error ? ' error=' + p2done.error : ''}`);
  ok('2 个片段均成功生成（继续到片段生成）',
    p2done.clips.length === 2 && p2done.clips.every(c => c.status === 'success'),
    p2done.clips.map(c => `${c.index}:${c.status}`).join(','));
  ok('补跑时图片自动结算为 approved（settledBy=continue）',
    p2done.imageReview.photoIds.every(id => {
      const p = photoLibrary.get(id);
      return p && p.status === 'approved';
    })
    && p2done.imageReview.settledBy === 'continue'
    && p2done.imageReview.autoApproved === 2,
    JSON.stringify({ settledBy: p2done.imageReview.settledBy, autoApproved: p2done.imageReview.autoApproved }));
  ok('补跑没有重新出图（复用已有图，不重复计费）',
    imageCalls.length === imageBeforeP2Resume, `calls=${imageCalls.length - imageBeforeP2Resume}`);
  ok('补跑后的视频请求也带了首帧图',
    mockCalls.slice(-2).every(call => call.options && call.options.image && call.options.image.photoId));

  // ================= 清理 =================
  console.log('\n清理测试任务与临时目录…');
  MockGenerator.prototype.generate = origMockGenerate;
  const { cleanupMany } = require('./_test-cleanup');
  const cleaned = await cleanupMany(taskIds, taskManager);
  const badClean = cleaned.filter(c => !c.ok);
  ok('测试任务已清理（内存 + JSON + 数据库）', badClean.length === 0,
    badClean.map(c => `${c.taskId}:${c.skipped}`).join(',') || 'ok');
  cleanupMockArtifacts();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  // ================= 汇总 =================
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.extra ? ': ' + f.extra : ''}`));
  }
  console.log('='.repeat(64));
  // 有些 mock 生成器内部 timer 会残留，这里明确退出（不留给外部进程）
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  try { MockGenerator.prototype.generate = origMockGenerate; } catch (err) { /* ignore */ }
  try {
    const { cleanupMany } = require('./_test-cleanup');
    await cleanupMany([], taskManager);
  } catch (err) { /* ignore */ }
  try { cleanupMockArtifacts(); } catch (err) { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  process.exit(1);
});
