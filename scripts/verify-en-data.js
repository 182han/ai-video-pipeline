#!/usr/bin/env node
// ==========================================================
// 英文界面「数据内容零中文」验收（E11，2026-11-20）
// ----------------------------------------------------------
// 用户反馈：英文界面下，库存里的历史记录仍是中文名称；片段库/图片库仍显示中文提示词。
//
// 验收口径（与 E10 一致）：
//   · 任务名/图片提示词优先用**离线解析的英文**（场景卡英文模板 / 人工词表 / 英文原文）；
//   · 解析不到 → 返回 null，前端显示英文占位，**绝不回退中文**；
//   · 不联网、不调用任何模型（AGENTS §4.9）。
//
// 覆盖：
//   [1] 静态接线（server 输出 promptEn；前端消费点）
//   [2] taskEn 解析顺序 + 覆盖保护 + 负向（无法解析必须 null）
//   [3] photoEn 解析顺序 + 历史中文图词表 + 负向
//   [4] 真实数据：所有中文任务/图片，解析结果要么零中文、要么 null（占位）
//   [5] 词表自身零中文（防止把中文塞进“英文”词表）
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const taskEn = require(path.join(APP, 'src', 'taskEn'));
const photoEn = require(path.join(APP, 'src', 'photoEn'));

const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } }
function readJson(file) { try { return JSON.parse(read(file)); } catch (e) { return null; } }
function taskFile(id) { return path.join(APP, 'data', 'tasks', `${id}.json`); }

console.log('=== 英文界面数据内容零中文验收（E11）===');

// ---------------------------------------------------------
section('[1] 静态接线：后端输出 / 前端消费');
// ---------------------------------------------------------
const serverSrc = read(path.join(APP, 'server.js'));
const invSrc = read(path.join(APP, 'web', 'src', 'screens', 'inventory.js'));
const nameSrc = read(path.join(APP, 'web', 'src', 'components', 'taskName.js'));
const drawerSrc = read(path.join(APP, 'web', 'src', 'components', 'taskDrawer.js'));
const jobSrc = read(path.join(APP, 'web', 'src', 'components', 'jobBar.js'));
const editorSrc = read(path.join(APP, 'web', 'src', 'screens', 'editor.js'));
const commonSrc = read(path.join(APP, 'web', 'src', 'i18n', 'messages', 'common.js'));

ok(/require\('\.\/src\/taskEn'\)/.test(serverSrc), 'server.js 引入 taskEn');
ok(/require\('\.\/src\/photoEn'\)/.test(serverSrc), 'server.js 引入 photoEn');
ok(/promptEn:\s*taskEn\.promptEnFor\(t\)/.test(serverSrc), '/api/tasks 列表输出 promptEn');
ok(/out\.promptEn\s*=\s*taskEn\.promptEnFor\(task\)/.test(serverSrc), '/api/tasks/:id 详情输出 promptEn');
ok(/photoPromptEnOf\(p\)/.test(serverSrc), '/api/photos 列表输出 promptEn');
ok(/promptEn:\s*photoPromptEnOf\(photo\)/.test(serverSrc), '/api/photos/:id 详情输出 promptEn');
ok(/promptEn:\s*it\.promptEn\s*\|\|\s*libraryEn\.promptEnFor/.test(serverSrc),
  '/api/library 对回填遗漏条目兜底解析 promptEn');
ok(/String\(i\.promptEn \|\| ''\)\.toLowerCase\(\)\.includes\(s\)/.test(serverSrc),
  '/api/library 搜索同时匹配英文标题');

ok(/function taskLabelText\(/.test(invSrc), 'inventory.js 有任务英文显示函数 taskLabelText');
ok(/taskLabelText\(it\)/.test(invSrc), '任务回收站使用 taskLabelText（不再直接贴 it.prompt）');
ok(/taskLabelText\(t\)/.test(invSrc), '未完成卡片使用 taskLabelText');
ok(/photo\.promptEn/.test(invSrc), '图片库卡片/详情使用 promptEn');
ok(/getLocale\(\) === 'en'/.test(invSrc), '图片库按当前语言分支（英文只显示英文）');

ok(/task\.promptEn/.test(nameSrc), '统一任务名优先使用 promptEn');
ok(/common\.promptEnMissing/.test(nameSrc), '任务名解析不到时使用英文占位');
ok(/function promptDisplay\(/.test(drawerSrc) && /task\.promptEn/.test(drawerSrc),
  '任务详情抽屉使用英文提示词');
ok(/function jobPromptText\(/.test(jobSrc), '顶栏任务条使用英文任务名');
ok(/function mediaPrompt\(/.test(editorSrc), '剪辑台素材卡使用英文提示词');
const keyHits = (commonSrc.match(/promptEnMissing:/g) || []).length;
ok(keyHits === 2, 'common.promptEnMissing 中英两份都有', `${keyHits} 处`);

// ---------------------------------------------------------
section('[2] taskEn：场景卡 / 覆盖保护 / 词表 / 英文原文 / 负向');
// ---------------------------------------------------------
ok(typeof taskEn.promptEnFor === 'function', 'taskEn 暴露 promptEnFor');

const sceneTask = readJson(taskFile('task_mwnosz8o_uyl4'));
ok(!!sceneTask, '读取真实场景卡任务 task_mwnosz8o_uyl4');
const sceneSummary = taskEn.promptEnFor(sceneTask, null);
ok(!!sceneSummary && !CJK_RE.test(sceneSummary), '整条场景卡任务 → 英文场景清单',
  String(sceneSummary || '').slice(0, 60));
ok(/^Scenes:/.test(String(sceneSummary || '')), '整条任务使用 "Scenes: …" 英文清单');

const clip0 = taskEn.promptEnFor(sceneTask, 0);
ok(!!clip0 && !CJK_RE.test(clip0) && /Subject:/.test(clip0), '单个片段 → 英文视频提示词',
  String(clip0 || '').slice(0, 50));
const clipOverridden = taskEn.promptEnFor(sceneTask, 2);
ok(clipOverridden === null, '被 promptOverrides 改写的片段不套用原卡（返回 null → 占位）');

const dictTask = readJson(taskFile('task_mwityi47_zhr9'));
const dictText = taskEn.promptEnFor(dictTask, null);
ok(!!dictText && !CJK_RE.test(dictText), '词表 byTaskId 命中历史中文任务',
  String(dictText || '').slice(0, 50));

const presetTask = { taskId: 'task_verify_preset', prompt: '极光下的雪山与冰川' };
const presetText = taskEn.promptEnFor(presetTask, null);
ok(presetText === 'Snow mountains and glaciers under the aurora', '词表 byPrompt 命中内置标签', presetText);

const englishTask = { taskId: 'task_verify_en', prompt: 'A serene lake at blue hour' };
ok(taskEn.promptEnFor(englishTask, null) === 'A serene lake at blue hour', '英文原文原样使用');

const unknownTask = { taskId: 'task_verify_unknown', prompt: '完全没有英文版本的中文任务名' };
const unknownText = taskEn.promptEnFor(unknownTask, null);
ok(unknownText === null, '无法离线解析 → null（前端英文占位，不冒充翻译）');

// 负向：历史任务里有「????????????」这类损坏/占位文本，不能被当成英文原文显示。
ok(taskEn.looksEnglish('????????????????,??????') === false, '损坏的 "????" 文本不算英文');
ok(taskEn.promptEnFor({ taskId: 'task_broken', prompt: '????????????' }, null) === null,
  '纯问号提示词 → null（显示占位，不显示乱码）');
const brokenTask = readJson(taskFile('task_mvglb06f_aubj'));
const brokenText = taskEn.promptEnFor(brokenTask, null);
ok(!!brokenText && !/\?{5,}/.test(brokenText), '真实损坏任务回退词表英文（不显示问号乱码）',
  String(brokenText || '').slice(0, 50));

// 词表优先于「任务里某一段恰好是英文」：整条任务标题不能被某段英文顶替。
const glacierTask = readJson(taskFile('task_mvhlusmo_hs2w'));
const glacierText = taskEn.promptEnFor(glacierTask, null);
ok(/glacier/i.test(String(glacierText || '')), '整条任务优先用 byTaskId 词表，不被个别英文片段顶替',
  String(glacierText || '').slice(0, 50));

// ---------------------------------------------------------
section('[3] photoEn：场景卡 / 历史中文图词表 / 英文原文 / 负向');
// ---------------------------------------------------------
ok(typeof photoEn.promptEnFor === 'function', 'photoEn 暴露 promptEnFor');

const scenePhoto = { id: 'verify_photo_scene', index: 0, imagePrompt: '中文出图提示词' };
const scenePhotoText = photoEn.promptEnFor(scenePhoto, sceneTask);
ok(!!scenePhotoText && !CJK_RE.test(scenePhotoText) && /Single still frame/.test(scenePhotoText),
  '场景卡图片 → 英文图片提示词', String(scenePhotoText || '').slice(0, 50));

const overriddenPhoto = { id: 'verify_photo_override', index: 2, imagePrompt: '中文覆盖提示词' };
ok(photoEn.promptEnFor(overriddenPhoto, sceneTask) === null, '覆盖段图片不套用原卡（返回 null）');

const historicalPhoto = { id: 'smart_mwit3r22_img_0', index: 0, imagePrompt: '【调色后】中文历史提示词' };
const historicalText = photoEn.promptEnFor(historicalPhoto, null);
ok(!!historicalText && !CJK_RE.test(historicalText), '词表 byId 命中历史中文图',
  String(historicalText || '').slice(0, 50));

const englishPhoto = { id: 'verify_photo_en', index: 0, imagePrompt: '【调色前】A blue lake at dusk' };
ok(photoEn.promptEnFor(englishPhoto, null) === 'A blue lake at dusk',
  '去掉「调色前/后」前缀后英文原样使用');

const unknownPhoto = { id: 'verify_photo_unknown', index: 0, imagePrompt: '完全没有英文版本的中文图片提示词' };
ok(photoEn.promptEnFor(unknownPhoto, null) === null, '无法离线解析 → null（前端英文占位）');
ok(photoEn.looksEnglish('????????????') === false, '图片库损坏的 "????" 文本不算英文');
ok(photoEn.promptEnFor({ id: 'verify_photo_broken', index: 0, imagePrompt: '????????????' }, null) === null,
  '图片库纯问号提示词 → null（不显示乱码）');

// ---------------------------------------------------------
section('[4] 真实数据：中文内容解析结果要么零中文、要么 null');
// ---------------------------------------------------------
const tasksDir = path.join(APP, 'data', 'tasks');
const taskFiles = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')) : [];
let cjkTasks = 0;
let leakedTasks = 0;
for (const file of taskFiles) {
  const task = readJson(path.join(tasksDir, file));
  if (!task) continue;
  const source = String(task.prompt || '');
  if (!CJK_RE.test(source)) continue;
  cjkTasks++;
  const resolved = taskEn.promptEnFor(task, null);
  if (resolved !== null && CJK_RE.test(resolved)) {
    leakedTasks++;
    console.log(`    · 中文泄漏 ${task.taskId}: ${String(resolved).slice(0, 60)}`);
  }
}
ok(cjkTasks > 0, '真实任务里存在中文提示词（样本有效）', `${cjkTasks} 条`);
ok(leakedTasks === 0, '所有中文任务：英文结果零中文或 null（绝不回退中文）', `泄漏 ${leakedTasks} 条`);

const photosDir = path.join(APP, 'data', 'photos');
const photoFiles = fs.existsSync(photosDir) ? fs.readdirSync(photosDir).filter((f) => f.endsWith('.json')) : [];
let cjkPhotos = 0;
let unresolvedPhotos = 0;
let leakedPhotos = 0;
for (const file of photoFiles) {
  const photo = readJson(path.join(photosDir, file));
  if (!photo) continue;
  if (!CJK_RE.test(String(photo.imagePrompt || photo.prompt || ''))) continue;
  cjkPhotos++;
  const task = photo.taskId ? readJson(taskFile(photo.taskId)) : null;
  const resolved = photoEn.promptEnFor(photo, task);
  if (resolved === null) {
    unresolvedPhotos++;
    console.log(`    · 未解析（前端占位） ${photo.id}`);
    continue;
  }
  if (CJK_RE.test(resolved)) {
    leakedPhotos++;
    console.log(`    · 中文泄漏 ${photo.id}: ${String(resolved).slice(0, 60)}`);
  }
}
ok(cjkPhotos > 0, '真实图片库里存在中文提示词（样本有效）', `${cjkPhotos} 条`);
ok(leakedPhotos === 0, '所有中文图片：英文结果零中文或 null', `泄漏 ${leakedPhotos} 条`);
ok(unresolvedPhotos === 0, '当前历史中文图全部有英文版本（词表已覆盖）', `${unresolvedPhotos} 条未解析`);

// ---------------------------------------------------------
section('[5] 词表自身零中文');
// ---------------------------------------------------------
function checkDict(file, label) {
  const dict = readJson(file);
  ok(!!dict, `${label} 可解析`);
  const values = [];
  for (const group of ['byId', 'byTaskId', 'byPrompt']) {
    for (const v of Object.values((dict && dict[group]) || {})) values.push(String(v));
  }
  const cjk = values.filter((v) => CJK_RE.test(v));
  ok(cjk.length === 0, `${label} 英文值零中文`, `${values.length} 条，中文 ${cjk.length} 条`);
}
checkDict(taskEn.DICT_FILE, 'tasks-en.json');
checkDict(photoEn.DICT_FILE, 'photos-en.json');

console.log('\n============================================================');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
