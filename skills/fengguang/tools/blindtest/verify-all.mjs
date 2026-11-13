#!/usr/bin/env node
/**
 * verify-all.mjs — 盲测门禁（一条命令跑三套）
 *
 * 默认严格模式：三套输入缺一套就 exit 2，不会静默跳过（CI 当硬门禁用）。
 * 本地只想跑一部分时，显式写 --skip ab,fuzzy（汇总会标 PARTIAL，exit 0）。
 *
 * 用法：
 *   node verify-all.mjs \
 *     --ab-with <with-skill.jsonl> --ab-without <no-skill.jsonl> \
 *     --fuzzy <fuzzy.jsonl> \
 *     --sequence <sequence.jsonl> \
 *     [--skip ab|fuzzy|sequence] [--json]
 *
 * 退出码：0 = 跑的全过；1 = 有套失败；2 = 参数/文件缺失（含静默跳过防护）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') raw.json = true;
  else if (a.startsWith('--')) raw[a.slice(2)] = process.argv[++i];
}
const skipped = new Set(String(raw.skip || '').split(',').map((s) => s.trim()).filter(Boolean));
const known = ['ab', 'fuzzy', 'sequence'];
for (const s of skipped) {
  if (!known.includes(s)) { console.error(`unknown --skip value: ${s}（可选 ab,fuzzy,sequence）`); process.exit(2); }
}

const inputs = {
  ab: { with: raw['ab-with'], without: raw['ab-without'] },
  fuzzy: { file: raw.fuzzy },
  sequence: { file: raw.sequence }
};
const errors = [];

for (const suite of known) {
  if (skipped.has(suite)) continue;
  if (suite === 'ab') {
    if (!inputs.ab.with || !inputs.ab.without) errors.push('缺少 --ab-with / --ab-without（要跳过请显式 --skip ab）');
    for (const p of [inputs.ab.with, inputs.ab.without]) if (p && !fs.existsSync(p)) errors.push(`文件不存在: ${p}`);
  } else {
    const p = inputs[suite].file;
    if (!p) errors.push(`缺少 --${suite}（要跳过请显式 --skip ${suite}）`);
    else if (!fs.existsSync(p)) errors.push(`文件不存在: ${p}`);
  }
}
if (errors.length) {
  console.error('verify-all: 输入不完整，拒绝静默跳过：');
  for (const e of errors) console.error('  - ' + e);
  console.error('\n用法: node verify-all.mjs --ab-with <with.jsonl> --ab-without <without.jsonl> --fuzzy <fuzzy.jsonl> --sequence <sequence.jsonl>');
  process.exit(2);
}

function run(name, script, argv) {
  const r = spawnSync(process.execPath, [path.join(here, script), ...argv], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  const tail = out.split('\n').slice(-4).join('\n');
  if (!raw.json) {
    console.log(`\n—— ${name} ——`);
    console.log(tail);
  }
  return { name, status: r.status ?? 1, tail, ok: r.status === 0 };
}

const results = [];
if (!skipped.has('ab')) {
  results.push(run('A/B（8 条口语，有/无 skill）', 'score.mjs', ['--with', inputs.ab.with, '--without', inputs.ab.without, '--baseline', path.join(here, 'baseline.json')]));
}
if (!skipped.has('fuzzy')) {
  results.push(run('模糊需求（6 条空词）', 'fuzzy.mjs', ['--candidate', inputs.fuzzy.file, '--baseline', path.join(here, 'fuzzy-baseline.json')]));
}
if (!skipped.has('sequence')) {
  results.push(run('多段连续性（5 段 + 首尾循环）', 'sequence.mjs', ['--candidate', inputs.sequence.file]));
}

const pass = results.every((r) => r.ok);
const mode = results.length === 3 ? 'ALL PASS' : `PARTIAL（跳过 ${[...skipped].join(',')}）`;
const summary = results.map((r) => `${r.name}=${r.ok ? 'ok' : 'FAIL'}`).join(' · ');
if (raw.json) console.log(JSON.stringify({ pass, partial: results.length < 3, skipped: [...skipped], results }, null, 2));
else console.log(`\n=== ${pass ? mode : 'FAILED'}：${summary} ===`);
process.exit(pass ? 0 : 1);
