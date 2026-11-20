#!/usr/bin/env node
// ==========================================================
// 片段库英文标题回填（E10，2026-11-20）
// ----------------------------------------------------------
// 背景：Library 里的历史条目只有中文 prompt，英文界面会整屏中文（E10）。
// 做法：为每条库条目解析一个英文标题 promptEn，写回 data/library/<id>.json。
//
// 英文来源（全部离线，见 src/libraryEn.js）：
//   1) 场景卡任务 → composeVideoPromptEn(card)（与英文生成提示词同源）
//   2) 词表 assets/library/prompts-en.json（byId / byPrompt）
//   3) 原提示词本身是英文 → 原样
//   4) 都没有 → 不写（前端显示英文占位，绝不回退中文）
//
// 用法（在 app/ 下执行）：
//   node scripts/backfill-library-en.js            # 回填缺失项
//   node scripts/backfill-library-en.js --dry      # 只报告，不写盘
//   node scripts/backfill-library-en.js --strict   # 有无法解析的条目时退出码 1
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const library = require(path.join(APP_DIR, 'src', 'library'));
const libraryEn = require(path.join(APP_DIR, 'src', 'libraryEn'));

const DRY = process.argv.includes('--dry');
const STRICT = process.argv.includes('--strict');

function readTask(taskId) {
  if (!taskId) return null;
  const p = path.join(APP_DIR, 'data', 'tasks', `${taskId}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function main() {
  const entries = library.listAll();
  const report = { total: entries.length, filled: 0, already: 0, missing: [] };

  for (const entry of entries) {
    const task = readTask(entry.taskId);
    const en = libraryEn.promptEnFor(entry, task);
    if (!en) {
      report.missing.push(entry.id);
      continue;
    }
    if (entry.promptEn === en) {
      report.already += 1;
      continue;
    }
    if (!DRY) library.update(entry.id, { promptEn: en });
    report.filled += 1;
    console.log(`  ${DRY ? '[dry] ' : ''}${entry.id}  →  ${en.slice(0, 90)}${en.length > 90 ? '…' : ''}`);
  }

  console.log('');
  console.log(`条目总数 ${report.total}｜本次回填 ${report.filled}｜已有 ${report.already}｜无法解析 ${report.missing.length}`);
  if (report.missing.length) {
    console.log('无法离线生成英文标题（前端会显示英文占位）：');
    for (const id of report.missing) console.log('  - ' + id);
  }
  if (STRICT && report.missing.length) process.exit(1);
}

main();
