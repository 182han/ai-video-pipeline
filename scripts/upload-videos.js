#!/usr/bin/env node
// ==========================================
// 视频上云脚本：把本地 clips/ 和 output/ 的视频传到对象存储
// ==========================================
// 用法：
//   node scripts/upload-videos.js              # 上传所有
//   node scripts/upload-videos.js --dry-run    # 只看会传什么，不真传
//   node scripts/upload-videos.js --kind clip  # 只传片段
//   node scripts/upload-videos.js --kind final # 只传成片
//   node scripts/upload-videos.js --task task_xxx  # 只传某个任务
//
// 特性：
//   - 自动跳过已上传的文件（对比 video_assets 表）
//   - 上传成功后写入 video_assets 表（URL、大小、时长）
//   - 单个文件失败不影响其他文件
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const storage = require('../src/storage');
const objectStore = require('../src/storage/objectStore');

// 解析命令行参数
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const KIND = (() => {
  const i = argv.indexOf('--kind');
  return i >= 0 ? argv[i + 1] : null;
})();
const ONLY_TASK = (() => {
  const i = argv.indexOf('--task');
  return i >= 0 ? argv[i + 1] : null;
})();

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(2) + 'MB';
}

async function main() {
  console.log('========================================');
  console.log('  视频上传到对象存储');
  console.log('========================================');
  console.log('');

  if (!config.STORAGE_DRIVER) {
    console.error('❌ 未配置对象存储。请在 .env 里设置：');
    console.error('   STORAGE_DRIVER=supabase');
    console.error('   SUPABASE_URL=https://xxxx.supabase.co');
    console.error('   SUPABASE_SERVICE_KEY=你的 service_role key');
    console.error('   SUPABASE_BUCKET=videos');
    process.exit(1);
  }

  console.log('驱动    :', config.STORAGE_DRIVER);
  console.log('Bucket  :', config.SUPABASE_BUCKET || config.STORAGE.s3.bucket);
  console.log('模式    :', DRY_RUN ? '预演（不实际上传）' : '实际执行');
  if (KIND) console.log('范围    :', KIND);
  if (ONLY_TASK) console.log('任务    :', ONLY_TASK);
  console.log('');

  // 1. 连接数据库
  await storage.init();

  // 2. 探测存储（预演且加 --skip-check 时跳过，便于在无网络环境下确认待传清单）
  const SKIP_CHECK = argv.includes('--skip-check');
  if (SKIP_CHECK) {
    console.log('跳过存储探测（--skip-check）');
  } else {
    console.log('探测存储...');
    const health = await objectStore.healthCheck();
    if (!health.ok) {
      console.error('❌ 存储不可用:', health.reason);
      console.error('');
      console.error('请检查：');
      console.error('  1. Supabase 里是否已创建 bucket: ' + (config.SUPABASE_BUCKET || 'videos'));
      console.error('  2. SUPABASE_SERVICE_KEY 是否是 service_role key（不是 anon key）');
      console.error('  3. SUPABASE_URL 是否正确');
      await storage.close();
      process.exit(1);
    }
    console.log('✅ 存储可用 (bucket: ' + health.bucket + ', 方式: ' + (health.method || 's3') + ')');
  }
  console.log('');

  // 3. 收集待上传文件
  const candidates = [];
  const clipsDir = path.join(__dirname, '..', 'clips');
  const outputDir = path.join(__dirname, '..', 'output');

  const collect = (dir, kind) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.mp4')) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.size < 1024) continue; // 跳过空文件

      // 从文件名推断 taskId：task_xxx_clip_N.mp4 / task_xxx_final.mp4
      const m = name.match(/^(task_[a-z0-9]+_[a-z0-9]+)/);
      const taskId = m ? m[1] : null;
      if (ONLY_TASK && taskId !== ONLY_TASK) continue;

      // 细分 kind
      let subKind = kind;
      if (kind === 'output') {
        if (name.includes('_final')) subKind = 'final';
        else if (name.includes('_bgm_')) subKind = 'bgm';
        else subKind = 'other';
      }
      candidates.push({ full, name, taskId, kind: subKind, size: st.size });
    }
  };

  collect(clipsDir, 'clip');
  collect(outputDir, 'output');

  // 按 kind 过滤
  const wanted = KIND
    ? candidates.filter(c => c.kind === KIND)
    : candidates.filter(c => c.kind === 'clip' || c.kind === 'final');

  if (wanted.length === 0) {
    console.log('没有找到需要上传的文件。');
    await storage.close();
    return;
  }

  const totalBytes = wanted.reduce((s, c) => s + c.size, 0);
  console.log('待处理文件: ' + wanted.length + ' 个, 共 ' + fmtMB(totalBytes));
  console.log('');

  // 4. 逐个上传
  let uploaded = 0, skipped = 0, failed = 0;
  let uploadedBytes = 0;

  for (const item of wanted) {
    const key = objectStore.buildKey(item.full, { taskId: item.taskId });

    // 已存在则跳过（按 video_assets 里记录判断）
    const existing = await storage.listVideoAssets({ taskId: item.taskId, limit: 500 });
    const already = existing.find(a => a.local_path && path.basename(a.local_path) === item.name && a.remote_url);
    if (already) {
      console.log('  跳过(已上传) ' + item.name);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log('  将上传 ' + item.name + '  ' + fmtMB(item.size) + '  ->  ' + key);
      uploaded++;
      uploadedBytes += item.size;
      continue;
    }

    process.stdout.write('  上传 ' + item.name + ' (' + fmtMB(item.size) + ')... ');
    const r = await objectStore.uploadFile(item.full, {
      taskId: item.taskId,
      key,
      contentType: 'video/mp4'
    });

    if (!r.success) {
      console.log('失败: ' + r.error);
      failed++;
      continue;
    }

    console.log('OK');

    // 记录到数据库
    try {
      await storage.saveVideoAsset({
        taskId: item.taskId,
        clipIndex: (() => {
          const cm = item.name.match(/_clip_(\d+)\.mp4$/);
          return cm ? parseInt(cm[1], 10) - 1 : null;
        })(),
        kind: item.kind,
        localPath: item.full,
        remoteUrl: r.url,
        storageDriver: config.STORAGE_DRIVER,
        sizeBytes: r.sizeBytes,
        mimeType: 'video/mp4'
      });
    } catch (e) {
      console.log('  ⚠️ 数据库记录失败: ' + e.message);
    }

    uploaded++;
    uploadedBytes += r.sizeBytes || item.size;
  }

  console.log('');
  console.log('========================================');
  console.log('  ' + (DRY_RUN ? '预演' : '完成'));
  console.log('========================================');
  console.log('  上传成功 : ' + uploaded);
  console.log('  已存在跳过: ' + skipped);
  console.log('  失败     : ' + failed);
  console.log('  数据量   : ' + fmtMB(uploadedBytes));
  console.log('');

  if (uploaded > 0 && !DRY_RUN) {
    console.log('查看云端视频：打开 Supabase -> Storage -> ' + (config.SUPABASE_BUCKET || 'videos'));
  }

  await storage.close();
}

main().catch(async (e) => {
  console.error('❌ 执行失败:', e.message);
  try { await storage.close(); } catch (x) {}
  process.exit(1);
});
