// ============================================================
// 批量出图 + 逐图调色 + 自动通过 验收（2026-11-12，2026-11-23 增补 A 方案）
//
// 用 stub generateImage（复制本地测试 PNG），不发起任何真实出图请求。
// 验证：
//   A. N 条提示词 → N 张图，calm 时调色前后各一条
//   B. 每张图都调色，且写入图片库 status=approved
//   C. 返回的 photoId 可按顺序映射到片段
//   D. 单张失败不拖垮整批（errors 逐条返回）
//   E. off = 只存原图（单条、无 _original、不跑 autoGrade）
//   F. 非法 imageGrade：模块层归一化为 null；HTTP 层 400（静态断言）
// ============================================================

const fs = require('fs');
const path = require('path');

// 本机 ffmpeg 子进程对系统 TEMP 无写权限：临时根目录放 app/output（与 ffmpeg 同区）。
const APP = path.join(__dirname, '..');
const OUTPUT_ROOT = path.join(APP, 'output');
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
const dir = fs.mkdtempSync(path.join(OUTPUT_ROOT, 'verify_image_batch_'));

// 隔离真实图片库 / 回收站 / clips（验收结束不留元数据）
process.env.PHOTOS_DIR = path.join(dir, 'photos');
process.env.CLIPS_DIR = path.join(dir, 'clips');
process.env.RECYCLE_DIR = path.join(dir, 'recycle');
process.env.OUTPUT_DIR = dir;
fs.mkdirSync(process.env.CLIPS_DIR, { recursive: true });

const config = require('../config');
const videoProcessor = require('../src/videoProcessor');
const photoLibrary = require('../src/photoLibrary');
const imageGrade = require('../src/imageGrade');
const { generateBatch } = require('../src/processors/imageBatch');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}

function makeSource() {
  const p = path.join(dir, 'source.png');
  const cmd = `"${config.FFMPEG_PATH}" -y -v error -f lavfi -i testsrc2=size=640x360:rate=1 -frames:v 1 -pix_fmt rgb24 "${p}"`;
  const r = videoProcessor._runFFmpeg(cmd);
  if (!r.success || !fs.existsSync(p)) throw new Error('生成测试图失败: ' + (r.error || ''));
  return p;
}

(async () => {
  console.log('================================================================');
  console.log('批量出图 + 逐图调色 + 自动通过 验收（stub，零计费）');
  console.log('================================================================');

  try {
    const srcPath = makeSource();
    const stub = async (prompt, meta) => {
      const p = path.join(dir, `stub_${meta.index}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
      fs.copyFileSync(srcPath, p);
      return { imagePath: p, width: 640, height: 360, provider: 'stub', model: 'stub' };
    };

    // ---------- A/B/C：calm（既有口径：调色前 + 调色后两条）----------
    const taskId = 'verify_batch_' + Date.now().toString(36);
    const batch = await generateBatch({
      prompts: ['雪山冰川晨雾', '沙漠沙丘日落'],
      taskId,
      palette: 'calm',
      imageGrade: 'calm',
      outDir: dir,
      size: '1696*960',
      generateImage: stub
    });

    ok(batch.imageGrade === 'calm', 'A0. 响应回传 imageGrade=calm');
    ok(batch.items.length === 2 && batch.errors.length === 0, 'A. 2 条提示词出 2 张图',
      `items=${batch.items.length} errors=${batch.errors.length}`);
    ok(batch.items.every(x => x.photoId), 'B1. 每张图都有 photoId');
    ok(batch.items.every(x => x.before && x.after), 'B2. 每张图都有调色前后指标');
    ok(batch.items.every(x => x.after.sat <= x.before.sat), 'B3. 调色后饱和度未上升',
      batch.items.map(x => `${x.before.sat}->${x.after.sat}`).join(', '));
    const photos = batch.items.map(x => photoLibrary.get(x.photoId));
    ok(photos.every(p => p && p.status === 'approved'), 'B4. 全部自动通过（approved）');
    ok(photos.every(p => p.filePath && fs.existsSync(p.filePath) && /_graded\.png$/.test(p.filePath)),
      'B5. 图片库指向调色后的文件');
    ok(photos.every(p => p.grade && p.grade.mode === 'calm' && p.grade.status === 'applied'),
      'B6. 调色后条目 grade=calm/applied（带 before/after/params）');
    const originals = batch.items.map(x => photoLibrary.get(x.originalPhotoId));
    ok(originals.every(p => p && p.grade && p.grade.mode === 'off' && p.grade.status === 'off'),
      'B7. 调色前条目 grade=off/off（两条口径未被统一）');

    // C：photoId 与片段顺序一一对应
    ok(batch.items[0].index === 0 && batch.items[1].index === 1
      && batch.items[0].photoId !== batch.items[1].photoId,
      'C. photoId 与片段顺序一一对应');

    // ---------- E：off 只存原图（单条）----------
    const offTask = 'verify_batch_off_' + Date.now().toString(36);
    const offBatch = await generateBatch({
      prompts: ['极光'],
      taskId: offTask,
      outDir: dir,
      imageGrade: 'off',
      generateImage: stub
    });
    const offPhoto = offBatch.items[0] && photoLibrary.get(offBatch.items[0].photoId);
    ok(offBatch.imageGrade === 'off' && offBatch.items.length === 1, 'E1. off：单条成功');
    ok(!!offPhoto && offPhoto.grade.mode === 'off' && offPhoto.grade.status === 'off',
      'E2. off：photo.grade=off/off');
    ok(!photoLibrary.get(offTask + '_img_0_original'), 'E3. off：不生成 _original');
    ok(!!offPhoto && !/_graded\.png$/.test(offPhoto.filePath), 'E4. off：入库模型原图');

    // ---------- F：非法值 ----------
    ok(imageGrade.normalize('auto') === null, 'F1. 非法 imageGrade → null（不静默吞成 off）');
    ok(imageGrade.resolve('auto') === 'off', 'F2. 模块层直接调用时兜底 off（HTTP 层必须 400）');
    const serverSrc = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
    ok(/IMAGE_GRADE_INVALID/.test(serverSrc) && /res\.status\(400\)/.test(serverSrc),
      'F3. 静态：HTTP 层对非法 imageGrade 有 400（IMAGE_GRADE_INVALID）');

    // ---------- D：单张失败不影响其它（calm）----------
    const partial = await generateBatch({
      prompts: ['ok', 'boom', 'ok2'],
      taskId: taskId + '_p',
      palette: 'calm',
      imageGrade: 'calm',
      outDir: dir,
      generateImage: async (prompt, meta) => {
        if (meta.index === 1) throw new Error('stub fail');
        return stub(prompt, meta);
      }
    });
    ok(partial.items.length === 2 && partial.errors.length === 1 && partial.errors[0].index === 1,
      'D. 单张失败逐条返回、不拖垮整批', JSON.stringify(partial.errors));
  } finally {
    // 本脚本用隔离目录，直接删临时目录即可（不触碰真实图片库/回收站）。
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 占用时留给系统清理 */ }
  }

  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
