#!/usr/bin/env node
// ==========================================
// 对「已生成但质检失败」的片段重新跑一次质检（不重新生成视频）
//
// 为什么需要：片段生成成功后落盘，但质检（尤其 NSFW）因多模态端点不可用判 fail，
// 片段就被标成 failed、任务失败、片段库也不收（library.js 只收 status==='success'），
// 结果「钱花了、视频在磁盘上、却哪都用不了」。本脚本只重跑质检，不碰视频文件。
//
// 走存储层（storage），因此 DATABASE_TYPE=json / postgres 都支持，**不需要重启服务**。
//
// 用法：
//   node scripts/recheck-task-clips.js <taskId> --key sk-xxx [--base URL] [--model NAME]
//   node scripts/recheck-task-clips.js <taskId> --key ... --dry-run
//
// 说明：
//   - Key 只用于本次进程内调用；落盘前一律走 redact.redactTask() 脱敏，不会写进任务。
//   - 不重新生成、不覆盖任何视频文件。
//   - 已成功但片段库缺档案的片段会顺手补库（不需要 Key，见 library.ingestMissing）。
//   - 改完后需重启服务（或等它重载）再点「补跑」，才能用上新的片段状态。
// ==========================================

const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, '..');
const config = require(path.join(APP_DIR, 'config'));
const storage = require(path.join(APP_DIR, 'src', 'storage'));
const redact = require(path.join(APP_DIR, 'src', 'utils', 'redact'));
const qualityChecker = require(path.join(APP_DIR, 'src', 'qualityChecker'));
const library = require(path.join(APP_DIR, 'src', 'library'));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else { out[key] = true; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const taskId = args._[0];

if (!taskId) {
  console.error('用法: node scripts/recheck-task-clips.js <taskId> --key sk-xxx [--base URL] [--model NAME] [--dry-run]');
  process.exit(2);
}

(async () => {
  await storage.init();
  console.log(`存储驱动: ${storage.name}`);

  const task = await storage.getTask(taskId);
  if (!task) {
    console.error(`找不到任务: ${taskId}`);
    process.exit(2);
  }

  const rc = task.runtimeConfig || {};
  const apiKey = String(args.key || rc.multimodalApiKey || config.MULTIMODAL_API_KEY || config.OPENAI_API_KEY || '');
  const baseUrl = String(args.base || rc.multimodalBaseUrl || config.MULTIMODAL_BASE_URL || config.OPENAI_BASE_URL || '');
  const model = String(args.model || rc.multimodalModel || config.OPENAI_MULTIMODAL_MODEL || '');

  const clips = Array.isArray(task.clips) ? task.clips : [];
  const todo = [];
  // 已成功但片段库里没有档案的片段：可顺手补库（不需要 Key，也不重新质检）。
  // 典型来源：手工恢复的付费片段、补跑复用的老片段 —— 它们不经过生成/重检入库。
  const libTodo = [];
  clips.forEach((c, i) => {
    if (c.status === 'success') {
      if (!library.get(`${task.taskId}_c${c.index + 1}`)) libTodo.push({ clip: c, index: i });
      return;
    }
    if (!c.videoPath || !fs.existsSync(c.videoPath)) {
      console.log(`  跳过 clip#${i}：文件不存在`);
      return;
    }
    todo.push({ clip: c, index: i });
  });

  console.log(`任务 ${taskId}：共 ${clips.length} 段，待重检 ${todo.length} 段，待补库 ${libTodo.length} 段`);

  if (libTodo.length) {
    libTodo.forEach(({ clip, index }) => console.log(`  + clip#${index} 已成功但未入库（${path.basename(clip.videoPath || '')}）`));
    if (args['dry-run']) {
      console.log('  [dry-run] 会补入片段库，未写盘。');
    } else {
      const added = library.ingestMissing(task);
      console.log(`  已补入片段库 ${added.length} 条: ${added.join(', ') || '（无）'}`);
    }
  }
  console.log(`  地址: ${baseUrl || '<空>'}`);
  console.log(`  模型: ${model || '<回退默认>'}`);

  if (todo.length === 0) { console.log('没有需要重检的片段。'); await storage.close?.(); return; }
  if (!apiKey) {
    console.error('缺少多模态 API Key：请用 --key 传入（不会写入任务文件/数据库）。');
    await storage.close?.();
    process.exit(2);
  }

  if (args['dry-run']) {
    todo.forEach(({ clip, index }) => {
      const mb = (fs.statSync(clip.videoPath).size / 1048576).toFixed(1);
      console.log(`  [dry-run] 会重检 clip#${index}（${mb} MB，${path.basename(clip.videoPath)}）`);
    });
    console.log('dry-run 结束，未写盘。');
    await storage.close?.();
    return;
  }

  let passed = 0;
  for (const { clip, index } of todo) {
    console.log(`\n--- clip#${index} 质检中 ---`);
    let qc;
    try {
      qc = await qualityChecker.checkClip(clip.videoPath, task.clipDuration, {
        nsfw: {
          apiKey,
          baseUrl,
          model,
          syntheticSource: task.model === 'mock',
        },
        strictItems: Array.isArray(rc.strictQcItems) && rc.strictQcItems.length ? rc.strictQcItems : undefined,
      });
    } catch (e) {
      console.log(`  ❌ 质检异常: ${e.message}`);
      clip.error = `质检异常: ${e.message}`;
      continue;
    }

    clip.qcResult = qc;
    if (qc && qc.passed) {
      passed++;
      clip.status = 'success';
      clip.error = null;
      clip.completedAt = clip.completedAt || new Date().toISOString();
      let lib = null;
      try { lib = library.ingestClip(task, clip); } catch (e) { console.log('  入库异常: ' + e.message); }
      console.log(`  ✅ 通过${lib ? `，已入片段库: ${lib.id}` : ''}`);
    } else {
      const why = (qc && qc.reason) || '未通过';
      clip.error = `质检未通过: ${why}`;
      console.log(`  ❌ 未通过: ${why}`);
    }
  }

  task.recheckedAt = new Date().toISOString();
  const allOk = clips.length > 0 && clips.every((c) => c.status === 'success');
  if (allOk) task.error = '片段已全部通过重新质检，请重启服务后点「补跑」继续拼接成片';

  await storage.saveTask(redact.redactTask(task));
  console.log(`\n=== 结果：${passed}/${todo.length} 段通过 ===`);
  console.log('任务已写回存储（Key 已脱敏）。');
  if (passed > 0) {
    console.log('下一步：重启服务 → 该任务 → 点「补跑」，会复用这些片段，不再重新生成。');
  }
  await storage.close?.();
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
