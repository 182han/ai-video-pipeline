#!/usr/bin/env node
// ==========================================
// 回填成片到片段库（kind=final）
// ==========================================
// 背景（2026-11-15）：
//   库里现在 0 条成片，而 output/ 里有 21 个终片 + 2 个剪辑导出。
//   剪辑台要能“把成片选进时间线”，前提是成片先入库；否则素材栏永远看不到。
//
// 规则：
//   · 同一任务有 final 和 final.bgm 时，取“最新导出”的那个（通常 .bgm 是最后一步）；
//   · 任务 JSON 已丢失的终片，照样入库，origin=orphan、suspectedDamage=true；
//   · 剪辑导出（proj_*_edit_*.mp4）以文件名作为任务 id，origin=editor；
//   · 默认 dry-run，只打印清单；--apply 才写库（幂等：同 id 覆盖）。
//
// 用法：
//   node scripts/backfill-finals.js            # 演练
//   node scripts/backfill-finals.js --apply    # 真正写入库

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(APP_DIR, 'output');
const TASKS_DIR = process.env.TASKS_DIR ? path.resolve(process.env.TASKS_DIR) : path.join(APP_DIR, 'data', 'tasks');
const LIBRARY_DIR = process.env.LIBRARY_DIR ? path.resolve(process.env.LIBRARY_DIR) : path.join(APP_DIR, 'data', 'library');

const APPLY = process.argv.includes('--apply');

function readTasks() {
  const map = new Map();
  if (!fs.existsSync(TASKS_DIR)) return map;
  for (const f of fs.readdirSync(TASKS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      if (j && j.taskId) map.set(j.taskId, j);
    } catch (e) { /* 坏 JSON 跳过，下面会原文报告 */ }
  }
  return map;
}

function readLibraryIds() {
  const set = new Set();
  if (!fs.existsSync(LIBRARY_DIR)) return set;
  for (const f of fs.readdirSync(LIBRARY_DIR)) {
    if (f.endsWith('.json')) set.add(f.replace(/\.json$/, ''));
  }
  return set;
}

function pickFinalPerTask(files) {  const groups = new Map();
  for (const f of files) {
    const base = f.name.replace(/_final(\.bgm)?\.mp4$/i, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(f);
  }
  const picked = [];
  for (const [taskId, list] of groups) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    picked.push({ taskId, file: list[0], alternatives: list.length - 1 });
  }
  return picked;
}

// 历史任务 JSON 没有 task.cost 字段，真实费用只能由片段费用相加
function clipCostSum(task) {
  if (!task || !Array.isArray(task.clips)) return 0;
  const sum = task.clips.reduce((n, c) => n + Number((c && c.cost && c.cost.amount) || 0), 0);
  return Math.round(sum * 100) / 100;
}

function main() {
  const library = require('../src/library');
  const tasks = readTasks();
  const existing = readLibraryIds();

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.error('output 目录不存在: ' + OUTPUT_DIR);
    process.exit(2);
  }

  const all = fs.readdirSync(OUTPUT_DIR)
    .filter(n => /\.mp4$/i.test(n))
    .map(n => {
      const p = path.join(OUTPUT_DIR, n);
      const st = fs.statSync(p);
      return { name: n, path: p, size: st.size, mtimeMs: st.mtimeMs };
    });

  const finals = all.filter(f => /_final(\.bgm)?\.mp4$/i.test(f.name));
  const edits = all.filter(f => /^proj_.*_edit_.*\.mp4$/i.test(f.name));
  const picked = pickFinalPerTask(finals);

  const rows = [];

  for (const p of picked) {
    const t = tasks.get(p.taskId) || null;
    const fileSizeMB = Math.round(p.file.size / 1048576 * 100) / 100;
    const orphan = !t;
    const id = `${p.taskId}_final`;
    rows.push({
      id,
      kind: 'final',
      taskId: p.taskId,
      file: p.file.name,
      sizeMB: fileSizeMB,
      origin: orphan ? 'orphan' : (t.model === 'editor' ? 'editor' : (t.source === 'library' ? 'library' : 'task')),
      hasTask: !!t,
      prompt: t ? String(t.prompt || '').slice(0, 40) : '(任务记录已丢失)',
      cost: t ? clipCostSum(t) : null,
      qc: t && t.finalQC ? (t.finalQC.passed ? '通过' : '不通过') : '未执行',
      suspectedDamage: p.file.size < 100 * 1024,
      dupes: p.alternatives,
      exists: existing.has(id)
    });
  }

  for (const e of edits) {
    const id = `${e.name.replace(/\.mp4$/i, '')}_final`;
    rows.push({
      id,
      kind: 'final',
      taskId: e.name.replace(/\.mp4$/i, ''),
      file: e.name,
      sizeMB: Math.round(e.size / 1048576 * 100) / 100,
      origin: 'editor',
      hasTask: false,
      prompt: '(剪辑台导出)',
      cost: null,
      qc: '未执行',
      suspectedDamage: e.size < 100 * 1024,
      dupes: 0,
      exists: existing.has(id)
    });
  }

  console.log(`模式: ${APPLY ? 'APPLY（写库）' : 'DRY-RUN（只打印）'}`);
  console.log(`output 终片文件 ${finals.length} 个（去重后 ${picked.length} 条）+ 剪辑导出 ${edits.length} 个`);
  console.log('');
  console.log('| 入库 id | 文件 | MB | 来源 | 任务 | 费用 | 终检 | 损伤? |');
  console.log('|---|---|---:|---|---|---:|---|---|');
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.file} | ${r.sizeMB} | ${r.origin} | ${r.hasTask ? '有' : '无'} | ${r.cost === null ? '-' : '¥' + r.cost} | ${r.qc} | ${r.suspectedDamage ? '疑似' : ''} |`);
  }
  console.log('');
  console.log(`合计 ${rows.length} 条；已存在 ${rows.filter(r => r.exists).length} 条；疑似损坏 ${rows.filter(r => r.suspectedDamage).length} 条`);

  if (!APPLY) {
    console.log('\n这是演练。确认无误后加 --apply 真正写库。');
    return;
  }

  let ok = 0, fail = 0, skippedMock = 0;
  const skippedIds = [];
  for (const r of rows) {
    try {
      let task;
      if (r.origin === 'orphan' || r.origin === 'editor') {
        task = {
          taskId: r.taskId,
          prompt: r.origin === 'editor' ? '剪辑台导出' : '(任务记录已丢失)',
          status: 'completed',
          model: r.origin === 'editor' ? 'editor' : 'unknown',
          totalDuration: null,
          finalQC: null,
          __origin: r.origin,
          cost: r.origin === 'editor'
            ? { amount: 0, computed: false, label: '剪辑导出（无生成费用）' }
            : undefined
        };
      } else {
        task = tasks.get(r.taskId);
      }
      // mock 成片不入库（与片段库既有口径一致：测试产物不混进正式库）
      if (task && task.model === 'mock') {
        skippedMock++;
        skippedIds.push(r.id);
        continue;
      }
      // 成片费用 = 片段费用合计（历史任务没有 task.cost）
      if (task && r.origin !== 'orphan' && r.origin !== 'editor') {
        const sum = clipCostSum(task);
        task.cost = task.cost || { amount: sum, currency: 'CNY', computed: sum > 0, label: '成片（片段费用合计）' };
      }
      const entry = library.ingestFinal(task, path.join(OUTPUT_DIR, r.file));
      if (!entry) throw new Error('ingestFinal 返回空');
      const patch = {};
      if (r.suspectedDamage) patch.suspectedDamage = true;
      if (!entry.cost || entry.cost.amount === undefined) patch.cost = { amount: 0, computed: false, label: '费用未知' };
      if (Object.keys(patch).length) library.update(entry.id, patch);
      ok++;
    } catch (e) {
      fail++;
      console.error(`写入失败 ${r.id}: ${e.message}`);
    }
  }
  console.log(`\n写库完成：成功 ${ok} 条，跳过 mock ${skippedMock} 条，失败 ${fail} 条。`);
  if (skippedMock) console.log('跳过的 mock 成片（测试产物不入正式库）：' + skippedIds.join(', '));
  if (fail) process.exit(1);
}

main();
