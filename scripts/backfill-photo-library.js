// ============================================================
// 回填图片库：把 clips/ 里已存在的出图文件登记进 data/photos/
// ------------------------------------------------------------
// 背景：图片库 2026-11-11 才落地，之前的图只写了文件、没有档案
//       （提示词/模型/尺寸/审核状态都没存 → 无法恢复，必须如实留空，不许编）。
// 用法：
//   node scripts/backfill-photo-library.js           # 只登记，不动文件
//   node scripts/backfill-photo-library.js --dry-run # 只列出将登记什么
// ============================================================
const photoLibrary = require('../src/photoLibrary');

const dryRun = process.argv.includes('--dry-run');

const pending = photoLibrary.listUnregisteredImages();
console.log('================================================================');
console.log('回填图片库（data/photos）');
console.log('================================================================');
console.log(`发现 ${pending.length} 张尚未入库的出图文件`);

if (pending.length === 0) {
  console.log('没有需要回填的图片。');
  console.log(`结果: 0 登记 / 0 跳过`);
  process.exit(0);
}

let added = 0;
let failed = 0;
for (const f of pending) {
  if (dryRun) {
    console.log(`  [dry-run] ${f.fileName}  (${f.sizeBytes} 字节, mtime ${f.createdAt})`);
    continue;
  }
  try {
    const entry = photoLibrary.ingest({
      id: f.id,
      taskId: f.taskId,
      index: f.index,
      filePath: f.filePath,
      prompt: '', // 历史文件没有落盘提示词：如实留空，不伪造
      source: 'backfill',
      createdAt: f.createdAt
    });
    // 明确标记：这条是回填的，提示词不可得
    photoLibrary.update(entry.id, {
      promptAvailable: false,
      backfillNote: '历史文件：生成时尚未记录提示词，无法恢复'
    });
    added++;
    console.log(`  ✅ ${f.fileName} → ${entry.id}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${f.fileName}: ${e.message}`);
  }
}

console.log('----------------------------------------------------------------');
console.log(`结果: ${added} 登记 / ${failed} 失败${dryRun ? '（dry-run，未写入）' : ''}`);
process.exit(failed === 0 ? 0 : 1);
