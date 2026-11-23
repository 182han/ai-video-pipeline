// ============================================================
// 出图自动调色开关（A 方案）验收（2026-11-23）
// ------------------------------------------------------------
// 零真实计费：出图用本地 stub（复制一张 ffmpeg 生成的测试 PNG），不联网。
// 覆盖：
//   A. imageGrade 模块：off/calm 归一化，非法值 → null
//   B. 批量出图 off：单条记录、grade.mode=off、无 _original、无 _graded
//   C. 批量出图 calm：调色前/后两条、调色后 grade 带 before/after/params、原图 grade.mode=off
//   D. 计划卡逐段出图 calm：只入库调色后一条，原图留在磁盘但不入库
//   E. 调色失败：保留原图、grade.status=failed、不伪造成功
//   F. 沿用规则：task.imageGrade 创建后不被 runtimeConfig / 请求体覆盖
//   G. 指纹：同提示词不同 imageGrade 不算重复；HTTP 入口有 400 拒绝（静态断言）
// 用法：node scripts/verify-image-grade.js
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- 隔离：照片库 / clips / 任务数据 / 调色临时目录全部指向临时目录 ----
// 注意：本机 ffmpeg 子进程对系统 TEMP 没有写权限（项目已知问题），
// 所以临时根目录放在 app/output/ 下（ffmpeg 与父进程同一可写区），结束后清理。
const APP_ROOT = path.join(__dirname, '..');
const OUTPUT_ROOT = path.join(APP_ROOT, 'output');
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(OUTPUT_ROOT, 'verify_image_grade_'));
process.env.PHOTOS_DIR = path.join(tmp, 'photos');
process.env.CLIPS_DIR = path.join(tmp, 'clips');
process.env.DATA_DIR = path.join(tmp, 'tasks');
process.env.OUTPUT_DIR = path.join(tmp, 'output');
process.env.RECYCLE_DIR = path.join(tmp, 'recycle');
process.env.AUTOGRADE_TMPDIR = path.join(tmp, 'output');
// 造任务必须落 JSON，不能写真实 Postgres（_test-cleanup 的既有约定）。
process.env.DATABASE_TYPE = 'json';
for (const d of [process.env.CLIPS_DIR, process.env.DATA_DIR, process.env.OUTPUT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const config = require('../config');
const videoProcessor = require('../src/videoProcessor');
const imageGrade = require('../src/imageGrade');
const photoLibrary = require('../src/photoLibrary');
const { generateBatch } = require('../src/processors/imageBatch');
const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');
const submitGuard = require('../src/submitGuard');
const imageGen = require('../src/generators/imageGen');
const budget = require('../src/budget');
const autoGradeModule = require('../src/processors/autoGrade');
const APP = path.join(__dirname, '..');

let pass = 0, fail = 0, skip = 0;
const failures = [];
const createdTaskIds = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}
function skipped(name, why) {
  skip++; console.log(`  ⚠ 跳过 ${name} — ${why}`);
}

// 测试原图：ffmpeg lavfi 生成（高饱和、16:9），不依赖真实 clips 目录
const SRC = path.join(tmp, 'stub-source.png');
function makeSource() {
  const cmd = `"${config.FFMPEG_PATH}" -y -v error -f lavfi -i testsrc2=size=640x360:rate=1 -frames:v 1 -pix_fmt rgb24 "${SRC}"`;
  const r = videoProcessor._runFFmpeg(cmd);
  const okFile = r.success && fs.existsSync(SRC) && fs.statSync(SRC).size > 8;
  return { ok: okFile, error: r.error || '' };
}

function stubGenerator() {
  return async (prompt, meta) => {
    const p = path.join(process.env.CLIPS_DIR, `stub_${meta.index}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`);
    fs.copyFileSync(SRC, p);
    return { imagePath: p, width: 640, height: 360, provider: 'stub', model: 'stub' };
  };
}

(async () => {
  console.log('================================================================');
  console.log('出图自动调色开关（A 方案）验收 · 零计费');
  console.log('================================================================');

  // ---------- A. 模块归一化 ----------
  ok(imageGrade.OPTIONS.join(',') === 'off,calm', 'A1. 只有 off / calm 两态');
  ok(imageGrade.normalize('off') === 'off' && imageGrade.normalize('CALM') === 'calm'
    && imageGrade.normalize(' calm ') === 'calm', 'A2. 合法值归一化（大小写/空白容错）');
  ok(imageGrade.normalize('auto') === null && imageGrade.normalize('') === null
    && imageGrade.normalize(undefined) === null && imageGrade.normalize(1) === null,
  'A3. 非法值 → null（不静默吞成 off）');
  ok(imageGrade.resolve(undefined) === 'off' && imageGrade.resolve('bogus') === 'off',
    'A4. 内部兜底默认 = off');

  const srcRes = makeSource();
  if (!srcRes.ok) {
    skipped('B–E 全部', 'ffmpeg 无法生成测试图: ' + srcRes.error);
    console.log(`结果: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
    process.exit(fail ? 1 : 0);
  }

  // ---------- B. 批量出图 off：单条 ----------
  {
    const taskId = 'verify_grade_off_' + Date.now().toString(36);
    const batch = await generateBatch({
      prompts: ['雪山晨雾'],
      taskId,
      outDir: process.env.CLIPS_DIR,
      imageGrade: 'off',
      generateImage: stubGenerator()
    });
    const item = batch.items[0];
    const photo = item && photoLibrary.get(item.photoId);
    ok(batch.imageGrade === 'off' && batch.items.length === 1 && batch.errors.length === 0,
      'B1. off：单条成功', `items=${batch.items.length}`);
    ok(!!photo && photo.grade && photo.grade.mode === 'off' && photo.grade.status === 'off',
      'B2. off：photo.grade = { mode:off, status:off }');
    ok(!photoLibrary.get(taskId + '_img_0_original'), 'B3. off：不生成 _original 派生条目');
    ok(!/_graded\.png$/.test(photo.filePath), 'B4. off：入库的是模型原图（不是 _graded）');
    ok(photo.filePath === item.imagePath, 'B5. off：返回的 photoId 指向原图文件');
  }

  // ---------- C. 批量出图 calm：双条 ----------
  {
    const taskId = 'verify_grade_calm_' + Date.now().toString(36);
    const batch = await generateBatch({
      prompts: ['沙漠日落'],
      taskId,
      outDir: process.env.CLIPS_DIR,
      palette: 'calm',
      imageGrade: 'calm',
      generateImage: stubGenerator()
    });
    const item = batch.items[0];
    const graded = item && photoLibrary.get(item.photoId);
    const original = photoLibrary.get(taskId + '_img_0_original');
    ok(batch.imageGrade === 'calm' && batch.items.length === 1, 'C1. calm：出图成功');
    ok(!!graded && graded.grade.mode === 'calm' && graded.grade.status === 'applied',
      'C2. calm：调色后条目 grade = calm/applied');
    ok(!!graded && graded.grade.before && graded.grade.after
      && Number.isFinite(graded.grade.before.sat) && Number.isFinite(graded.grade.after.sat),
    'C3. calm：调色后条目带 before/after 实测指标');
    ok(!!graded && graded.grade.params && Number.isFinite(graded.grade.params.gain),
      'C4. calm：带可复现的 params');
    ok(!!original && original.grade.mode === 'off' && original.grade.status === 'off',
      'C5. calm：调色前条目 grade = off/off');
    ok(!!original && original.id === item.originalPhotoId, 'C6. calm：返回 originalPhotoId');
  }

  // ---------- D/E. 计划卡逐段出图（pipeline._generateClipImages） ----------
  // 不联网：替换出图状态、生成器、预算闸门。autoGrade 走真实 ffmpeg。
  const realGetStatus = imageGen.getImageGenStatus;
  const RealGenerator = imageGen.ImageGenerator;
  const realCanAfford = budget.canAfford;
  const realEstimateImage = budget.estimateImage;
  const realReserve = budget.reserve;
  const realAutoGrade = autoGradeModule.autoGradeImage;
  imageGen.getImageGenStatus = () => ({
    usable: true,
    imageGen: { provider: 'stub', model: 'stub', size: '640x360', hasApiKey: true },
    missing: [],
    registeredProviders: ['dashscope'],
    providerImplemented: true
  });
  class StubImageGenerator {
    async generateImage(prompt, meta) {
      const p = path.join(process.env.CLIPS_DIR, `pipeline_${meta.index}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`);
      fs.copyFileSync(SRC, p);
      return { imagePath: p, width: 640, height: 360, provider: 'stub', model: 'stub' };
    }
  }
  imageGen.ImageGenerator = StubImageGenerator;
  budget.canAfford = () => true;
  budget.estimateImage = () => 0;
  budget.reserve = () => {};

  function makeTask(grade) {
    const task = taskManager.createTask('计划卡逐段出图测试', {
      model: 'mock',
      totalClips: 1,
      clipDuration: 5,
      resolution: '480p',
      imageGrade: grade,
      source: 'generation'
    });
    task.clips[0].prompt = '雪山冰川晨雾';
    pipeline.runningTasks.add(task.taskId);
    createdTaskIds.push(task.taskId);
    return task;
  }

  try {
    // D. calm 正向：只入库调色后一条
    {
      const task = makeTask('calm');
      ok(task.imageGrade === 'calm', 'F1. 创建任务写入 task.imageGrade=calm');
      const before = photoLibrary.listAll().length;
      const summary = await pipeline._generateClipImages(task.taskId, task);
      const photo = summary.photoIds.length ? photoLibrary.get(summary.photoIds[0]) : null;
      ok(!!photo && photo.grade.mode === 'calm' && photo.grade.status === 'applied',
        'D1. 计划卡 calm：入库 grade=calm/applied');
      ok(!!photo && /_graded\.png$/.test(photo.filePath), 'D2. 计划卡 calm：入库的是调色后文件');
      ok(!!photo && photo.grade.originalPath && fs.existsSync(photo.grade.originalPath)
        && photo.grade.originalPath !== photo.filePath,
      'D3. 计划卡 calm：原图留在磁盘，路径记进 grade.originalPath');
      ok(photoLibrary.listAll().length - before === 1,
        'D4. 计划卡 calm：只新增 1 条图片记录（原图不单独入库）',
        `新增 ${photoLibrary.listAll().length - before}`);
    }

    // E. 调色失败：保留原图、明确 failed
    {
      autoGradeModule.autoGradeImage = async () => { throw new Error('stub grade failure'); };
      const task = makeTask('calm');
      const summary = await pipeline._generateClipImages(task.taskId, task);
      const photo = summary.photoIds.length ? photoLibrary.get(summary.photoIds[0]) : null;
      ok(!!photo && photo.grade.mode === 'calm' && photo.grade.status === 'failed',
        'E1. 调色失败：photo.grade.status=failed（不伪造成功）');
      ok(!!photo && /stub grade failure/.test(String(photo.grade.error || '')),
        'E2. 调色失败：错误原因写入 grade.error');
      ok(!!photo && !/_graded\.png$/.test(photo.filePath) && fs.existsSync(photo.filePath),
        'E3. 调色失败：保留原图作为该段首帧');
      ok(summary.generated === 1 && summary.failed === 0,
        'E4. 调色失败不把已付费的图判成「出图失败」');
    }
  } finally {
    autoGradeModule.autoGradeImage = realAutoGrade;
    imageGen.getImageGenStatus = realGetStatus;
    imageGen.ImageGenerator = RealGenerator;
    budget.canAfford = realCanAfford;
    budget.estimateImage = realEstimateImage;
    budget.reserve = realReserve;
  }

  // ---------- F. 沿用规则：创建后不被请求体/runtimeConfig 覆盖 ----------
  {
    const task = taskManager.createTask('沿用测试', { model: 'mock', totalClips: 1, imageGrade: 'calm' });
    createdTaskIds.push(task.taskId);
    pipeline._mergeRuntimeConfig(task, { imageGrade: 'off', apiKey: 'stub-key' });
    ok(task.imageGrade === 'calm', 'F2. runtimeConfig 合并后 task.imageGrade 不变');
    ok(!(task.runtimeConfig && Object.prototype.hasOwnProperty.call(task.runtimeConfig, 'imageGrade')),
      'F3. imageGrade 不进 runtimeConfig（白名单之外）');
    const legacy = taskManager.createTask('老任务测试', { model: 'mock', totalClips: 1 });
    createdTaskIds.push(legacy.taskId);
    ok(legacy.imageGrade === config.IMAGE_GEN_AUTO_GRADE_DEFAULT
      && ['off', 'calm'].includes(config.IMAGE_GEN_AUTO_GRADE_DEFAULT),
    'F4. 老任务/缺字段 → 读成服务端默认',
    `task.imageGrade=${legacy.imageGrade} default=${config.IMAGE_GEN_AUTO_GRADE_DEFAULT}`);
  }

  // ---------- G. 指纹 + HTTP 入口静态断言 ----------
  {
    const base = { model: 'mock', clips: 1, prompts: ['同一条提示词'], preset: 'final' };
    const fpOff = submitGuard.fingerprint(submitGuard.build({ ...base, imageGrade: 'off' }));
    const fpCalm = submitGuard.fingerprint(submitGuard.build({ ...base, imageGrade: 'calm' }));
    ok(fpOff !== fpCalm, 'G1. 同提示词不同 imageGrade 指纹不同（不会被去重误拦）');
    const serverSrc = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
    ok(/IMAGE_GRADE_INVALID/.test(serverSrc)
      && /code: 'IMAGE_GRADE_INVALID'/.test(serverSrc)
      && /res\.status\(400\)\.json\(\{[\s\S]{0,200}IMAGE_GRADE_INVALID/.test(serverSrc),
    'G2. 静态：generate-batch / tasks / execute 对非法 imageGrade 返回 400 + IMAGE_GRADE_INVALID');
    ok(/imageGrade: batch\.imageGrade/.test(serverSrc)
      && /imageGrade: \{\s*\n?\s*default: config\.IMAGE_GEN_AUTO_GRADE_DEFAULT/.test(serverSrc),
    'G3. 静态：状态接口下发 imageGrade.default；批量出图响应回传 imageGrade');
    const pipelineSrc = fs.readFileSync(path.join(APP, 'src', 'pipeline.js'), 'utf8');
    const whitelistBlock = (pipelineSrc.match(/_mergeRuntimeConfig\(task, runtimeConfig\) \{[\s\S]{0,1200}/) || [''])[0];
    ok(/imagePerClip/.test(whitelistBlock) && !/['"]imageGrade['"]/.test(whitelistBlock),
      'G4. 静态：_mergeRuntimeConfig 白名单不含 imageGrade');
  }

  // ---------- 清理：本脚本造出来的 mock 任务（内存 + 隔离 JSON） ----------
  try {
    const { cleanupMany } = require('./_test-cleanup');
    const cleaned = await cleanupMany(createdTaskIds, taskManager);
    const bad = cleaned.filter((c) => !c.ok);
    ok(bad.length === 0, '测试任务已清理（内存 + JSON）',
      bad.map((c) => `${c.taskId}:${c.skipped}`).join(',') || `${createdTaskIds.length} 条`);
  } catch (e) {
    ok(false, '测试任务清理异常', e && e.message);
  }

  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
  if (fail > 0) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 资源占用时留给系统清理 */ }
})().catch((e) => {
  console.error('验收脚本异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
