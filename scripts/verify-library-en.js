#!/usr/bin/env node
// ==========================================================
// 片段库英文标题验收（E10，2026-11-20）
// ----------------------------------------------------------
// 验收口径：英文界面下 Library 的标题/提示词只用英文（零中文）。
//   · 场景卡任务：英文提示词由卡的 *_en 字段 + 英文模板拼出（不是机翻）
//   · 历史中文条目：词表 assets/library/prompts-en.json（byId / byPrompt）
//   · 解析不到：返回 null，前端显示英文占位，**绝不回退中文**
//
// 覆盖：静态接线 / 解析顺序 / 覆盖(override)保护 / 真实库全量零中文 / 回填脚本可重复。
// 不联网、不调用模型、不改 output/。
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const library = require(path.join(APP, 'src', 'library'));
const libraryEn = require(path.join(APP, 'src', 'libraryEn'));
const sceneCards = require(path.join(APP, 'src', 'sceneCards'));

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); }
}
function skip(label, why) { skipped++; console.log(`  ⏭️  ${label} —— 跳过：${why}`); }
function section(t) { console.log(`\n${t}`); }
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } }

function readTask(taskId) {
  if (!taskId) return null;
  try { return JSON.parse(fs.readFileSync(path.join(APP, 'data', 'tasks', `${taskId}.json`), 'utf8')); }
  catch (e) { return null; }
}

console.log('=== 片段库英文标题验收（E10）===');

// ---------------------------------------------------------
section('[1] 静态接线');
// ---------------------------------------------------------
const libSrc = read(path.join(APP, 'src', 'library.js'));
const invSrc = read(path.join(APP, 'web', 'src', 'screens', 'inventory.js'));
const msgSrc = read(path.join(APP, 'web', 'src', 'i18n', 'messages', 'inventory.js'));

ok(typeof sceneCards.getCardById === 'function', '场景卡库暴露 getCardById（英文提示词按卡解析）');
ok(typeof libraryEn.promptEnFor === 'function' && typeof libraryEn.fromTask === 'function'
  && typeof libraryEn.fromFinal === 'function', 'libraryEn 暴露 promptEnFor / fromTask / fromFinal');
ok(/libraryEn\.fromTask\(task, clip\.index\)/.test(libSrc), '片段入库时写入 promptEn（library.buildEntry）');
ok(/libraryEn\.fromFinal\(task\)/.test(libSrc), '成片入库时写入 promptEn（library.ingestFinal）');
ok(/existing\.promptEn/.test(libSrc), '重新入库会保留已解析的 promptEn（不被 null 覆盖）');

ok(/getLocale/.test(invSrc), 'inventory.js 取当前语言（getLocale）');
ok(/function entryPromptText\(/.test(invSrc), 'inventory.js 有统一的英文标题取值函数');
ok((invSrc.match(/entryPromptText\(/g) || []).length >= 5, '片段卡片/详情/成片列表/播放浮层都走英文取值',
  `调用 ${(invSrc.match(/entryPromptText\(/g) || []).length} 处`);
ok(/library\.common\.promptEnMissing/.test(invSrc), '解析不到时用英文占位（不回退中文）');
const msgHits = (msgSrc.match(/promptEnMissing:/g) || []).length;
ok(msgHits === 2, 'i18n 中英两份都有 promptEnMissing', `${msgHits} 处`);

const dict = JSON.parse(read(libraryEn.DICT_FILE) || '{}');
ok(dict && dict.byId && Object.keys(dict.byId).length >= 10, '词表存在且含历史条目英文',
  `${dict && dict.byId ? Object.keys(dict.byId).length : 0} 条`);

// ---------------------------------------------------------
section('[2] 解析顺序：场景卡 → 覆盖保护 → 词表 → 英文原文 → 占位');
// ---------------------------------------------------------
const card = sceneCards.getCardById('sc-103');
ok(!!card && !!card.protagonist_en, '测试卡 sc-103 带英文内容字段', card && card.protagonist_en);

const task2 = {
  taskId: 'task_verify_en',
  theme: null,
  sceneCards: {
    enabled: true,
    used: [
      { id: 'sc-103', scene_key: '土丘群' },
      { id: 'sc-037', scene_key: '孤山' }
    ]
  }
};
const clipEntry = { id: 'task_verify_en_c1', kind: 'clip', clipIndex: 0, prompt: '中文提示词', originalPrompt: '中文提示词' };
const enClip = libraryEn.promptEnFor(clipEntry, task2);
ok(!!enClip && !libraryEn.hasCJK(enClip), '场景卡片段 → 英文提示词（零中文）', String(enClip).slice(0, 60));
ok(/mound|yardang/i.test(String(enClip)), '英文内容来自卡的 *_en 字段（不是机翻占位）');

const finalEntry = { id: 'task_verify_en_final', kind: 'final', clipIndex: null, prompt: '中文', originalPrompt: '中文' };
const enFinal = libraryEn.promptEnFor(finalEntry, task2);
ok(/^Scenes: /.test(String(enFinal)) && !libraryEn.hasCJK(String(enFinal)), '成片 → "Scenes: …" 英文场景清单',
  String(enFinal));

// promptOverrides：该段画面已不是卡描述的内容 → 不能拿卡的英文顶替
const taskOv = { ...task2, promptOverrides: { 0: '改成冰川湖' } };
ok(libraryEn.promptEnFor(clipEntry, taskOv) === null,
  '片段被 promptOverrides 改写 → 不套用原卡的英文（回退词表/占位）');

// 词表 byId / byPrompt
ok(libraryEn.promptEnFor({ id: 'task_mwnosz8o_uyl4_final', kind: 'final', clipIndex: null, prompt: '30 秒（快速试）' }, null)
  === 'Scenes: cluster of mounds · isolated peak · glacier lake', '词表 byId 命中成片标题');
ok(libraryEn.promptEnFor({ id: 'no_such_id', kind: 'final', clipIndex: null, prompt: '剪辑台导出' }, null)
  === 'Editor export', '词表 byPrompt 命中内置标签');

// 英文原文直通 / 中文无翻译 → null
ok(libraryEn.promptEnFor({ id: 'x1', kind: 'clip', prompt: 'A serene lake at blue hour' }, null)
  === 'A serene lake at blue hour', '历史英文提示词原样使用');
ok(libraryEn.promptEnFor({ id: 'x2', kind: 'clip', prompt: '完全没有翻译的中文标题' }, null) === null,
  '无法解析的中文 → null（前端显示英文占位，不冒充翻译）');

// ---------------------------------------------------------
section('[3] 真实库全量：英文界面零中文');
// ---------------------------------------------------------
const entries = library.listAll();
if (!entries.length) {
  skip('真实库全量零中文', 'data/library 为空（新环境）');
} else {
  const missing = entries.filter(e => !e.promptEn);
  ok(missing.length === 0, `全部 ${entries.length} 条都有 promptEn（回填已跑过）`,
    missing.length ? '缺失：' + missing.slice(0, 5).map(e => e.id).join(', ') : '');

  const withCJK = entries.filter(e => e.promptEn && libraryEn.hasCJK(e.promptEn));
  ok(withCJK.length === 0, '所有 promptEn 零中文',
    withCJK.length ? withCJK.slice(0, 3).map(e => e.id).join(', ') : '');

  const empty = entries.filter(e => !String(e.promptEn || '').trim());
  ok(empty.length === 0, '没有空的 promptEn');

  // 不依赖回填值：从任务重新解析也必须是英文（防止词表/卡变化后静默退化）
  const sample = entries.filter(e => e.taskId).slice(0, 8);
  const re = sample.map(e => {
    const t = readTask(e.taskId);
    const v = libraryEn.promptEnFor({ ...e, promptEn: null }, t);
    return { id: e.id, v };
  });
  ok(re.every(x => !!x.v && !libraryEn.hasCJK(x.v)), '抽样从任务重解析仍是英文（不只靠回填值）',
    re.filter(x => !x.v).map(x => x.id).join(', '));
}

// ---------------------------------------------------------
section('[4] 回填脚本可重复执行');
// ---------------------------------------------------------
const script = path.join(APP, 'scripts', 'backfill-library-en.js');
ok(fs.existsSync(script), 'backfill-library-en.js 存在');
const { execSync } = require('child_process');
function run(cmd) {
  const tmp = path.join(require('os').tmpdir(), `vliben_${process.pid}_${Date.now()}.txt`);
  let code = 0;
  try { execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore', cwd: APP, timeout: 120000 }); } catch (e) { code = 1; }
  let out = '';
  try { out = fs.readFileSync(tmp, 'utf8'); } catch (e) {}
  try { fs.unlinkSync(tmp); } catch (e) {}
  return { code, out };
}
const dry = run('node scripts/backfill-library-en.js --dry --strict');
ok(dry.code === 0, '--dry --strict 全绿（无无法解析条目）', String(dry.out).trim().split('\n').pop());
ok(/无法解析 0/.test(dry.out), '报告里无法解析条目为 0');

// ---------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log(`通过 ${pass} / 失败 ${fail} / 跳过 ${skipped}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
