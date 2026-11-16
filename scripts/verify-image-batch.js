// ============================================================
// 批量出图 + 逐图调色 + 自动通过 验收（2026-11-12）
//
// 用 stub generateImage（复制本地 PNG），不发起任何真实出图请求。
// 验证：
//   A. N 条提示词 → N 张图
//   B. 每张图都调色，且写入图片库 status=approved
//   C. 返回的 photoId 可按顺序映射到片段
//   D. 单张失败不拖垮整批（errors 逐条返回）
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

// 回收站目录隔离：photoLibrary.remove 现在会写 data/recycle，验收不能污染真实目录
process.env.RECYCLE_DIR = path.join(os.tmpdir(), 'imgbatch-recycle-' + Date.now());

const photoLibrary = require('../src/photoLibrary');
const { generateBatch } = require('../src/processors/imageBatch');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}

(async () => {
  console.log('================================================================');
  console.log('批量出图 + 逐图调色 + 自动通过 验收');
  console.log('================================================================');

  const src = photoLibrary.listAll().find(p => p.status === 'approved' && p.filePath && fs.existsSync(p.filePath));
  if (!src) {
    console.log('  ⚠ 没有可用图片，跳过');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgbatch-'));
  const taskId = 'verify_batch_' + Date.now().toString(36);
  let batch = null;
  try {
    batch = await generateBatch({
      prompts: ['雪山冰川晨雾', '沙漠沙丘日落'],
      taskId,
      palette: 'calm',
      outDir: dir,
      size: '1696*960',
      generateImage: async (prompt, meta) => {
        const p = path.join(dir, `stub_${meta.index}.png`);
        fs.copyFileSync(src.filePath, p);
        return { imagePath: p, width: 1280, height: 720, provider: 'stub', model: 'stub' };
      }
    });

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

    // C：photoId 与片段顺序一一对应
    ok(batch.items[0].index === 0 && batch.items[1].index === 1
      && batch.items[0].photoId !== batch.items[1].photoId,
      'C. photoId 与片段顺序一一对应');

    // D：单张失败不影响其它
    const partial = await generateBatch({
      prompts: ['ok', 'boom', 'ok2'],
      taskId: taskId + '_p',
      palette: 'calm',
      outDir: dir,
      generateImage: async (prompt, meta) => {
        if (meta.index === 1) throw new Error('stub fail');
        const p = path.join(dir, `stub_p_${meta.index}.png`);
        fs.copyFileSync(src.filePath, p);
        return { imagePath: p, width: 1280, height: 720 };
      }
    });
    ok(partial.items.length === 2 && partial.errors.length === 1 && partial.errors[0].index === 1,
      'D. 单张失败逐条返回、不拖垮整批', JSON.stringify(partial.errors));
  } finally {
    // 清理本验收产生的所有照片条目（含调色前原图、partial 批次），
    // 避免再次把测试元数据留在真实图片库。
    for (const p of photoLibrary.listAll()) {
      if (/^verify_batch_/.test(p.id)) {
        try { photoLibrary.remove(p.id, { deleteFile: false }); } catch (e) {}
      }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
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
