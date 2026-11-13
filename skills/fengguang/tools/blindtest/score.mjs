#!/usr/bin/env node
/**
 * score.mjs — 盲测回归评分（零依赖，客观项）
 *
 * 用法：
 *   node score.mjs --with with-skill.jsonl --without no-skill.jsonl
 *   node score.mjs --with ... --without ... --baseline baseline.json --json
 *
 * 评分（每条最高 4 分，h1/h2/h5 多一项极光色 → 满分 27）：
 *   highlight  高光控制要说具体（受控/不过曝/不炸/保留结构）
 *   lock       结尾锁画面（画面停/画面锁在/无新元素进入）
 *   axis       只有一条镜头运动（静机位配推拉、推+降、推+横移 记 0）
 *   aurora     仅极光题：主语为氧原子绿/氧绿，且不写紫边/紫雾
 *
 * 回归判定：with 总分低于基线 - tolerance，或 with 与 without 的差距低于基线 - tolerance → exit 1
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNED = ['4K', '8K', 'cinematic', '配乐', '音效', '分辨率'];
const STATIC = /静机位|固定机位|机位锁定|静态长镜头|绝对静止|画面极静/;
const MOVE = /缓推|推进|推近|前推|一推|横移|平移|升镜|下降|降高度|环绕/;
const PUSH = /缓推|推进|推近|前推|一推/;
const OTHERMOVE = /横移|平移|升镜|下降|降高度|环绕/;

function parseArgs(argv) {
  const out = { withFile: null, withoutFile: null, baseline: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with') out.withFile = argv[++i];
    else if (a === '--without') out.withoutFile = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function stripNegated(text) {
  // 去掉"不…/无…/避免…"的分句，避免把"不糊成紫雾"误判成违规
  return String(text).split(/[。；;，,]/).filter((c) => !/[不无]|避免|别/.test(c)).join('。');
}

function judgePrompt(p, req) {
  const r = { highlight: 0, lock: 0, axis: 1, aurora: null, banned: [], notes: [] };
  if (/高光[^。；]{0,12}(受控|控住|控死|控制|不过曝|不炸|不溢出|保留|压住)|高光受控|不炸开|不死白|不溢出/.test(p)) r.highlight = 1;
  else r.notes.push('无高光控制');

  if (/画面停|画面锁在|画面锁死|画面锁定|无新元素进入|不再进入新元素|结尾[^。；]{0,10}(停|定住|定格|锁)/.test(p)) r.lock = 1;
  else r.notes.push('结尾未锁画面');

  const staticHit = STATIC.test(p);
  const moveHit = MOVE.test(p);
  if (staticHit && moveHit) { r.axis = 0; r.notes.push('静机位配镜头运动'); }
  else if (PUSH.test(p) && OTHERMOVE.test(p)) { r.axis = 0; r.notes.push('两套镜头运动'); }

  if (req.aurora) {
    const clean = stripNegated(p);
    const green = /氧原子绿|氧绿/.test(p);
    const purple = /紫边|紫雾/.test(clean);
    r.aurora = green && !purple ? 1 : 0;
    if (!green) r.notes.push('极光主语不是氧原子绿');
    if (purple) r.notes.push('出现紫边/紫雾');
  }

  for (const w of BANNED) if (p.includes(w)) r.banned.push(w);
  return r;
}

function scoreFile(file, reqs) {
  const rows = readJsonl(file);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.prompt]));
  const items = [];
  let total = 0;
  for (const id of Object.keys(reqs)) {
    const p = byId[id];
    if (!p) { items.push({ id, missing: true }); continue; }
    const r = judgePrompt(p, reqs[id]);
    const dims = r.highlight + r.lock + r.axis + (r.aurora === null ? 0 : r.aurora);
    total += dims;
    const expectHit = (reqs[id].expect || []).filter((t) => p.includes(t));
    items.push({ id, ...r, dims, expectHit: expectHit.length + '/' + (reqs[id].expect || []).length });
  }
  return { file, total, items };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.withFile || !args.withoutFile) {
    console.error('usage: node score.mjs --with <with-skill.jsonl> --without <no-skill.jsonl> [--baseline baseline.json] [--json]');
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const reqs = JSON.parse(fs.readFileSync(path.join(here, 'requests.json'), 'utf8'));
  const A = scoreFile(args.withFile, reqs);
  const B = scoreFile(args.withoutFile, reqs);

  const gap = A.total - B.total;
  const baseline = args.baseline
    ? JSON.parse(fs.readFileSync(args.baseline, 'utf8'))
    : { withSkill: { total: 27 }, gap: 20, tolerance: 1 };

  const withMin = (baseline.withSkill.total ?? 27) - (baseline.tolerance ?? 1);
  const gapMin = (baseline.gap ?? 20) - (baseline.tolerance ?? 1);
  const bannedAny = [...A.items, ...B.items].some((x) => (x.banned || []).length);
  const fail = A.total < withMin || gap < gapMin || bannedAny;

  if (args.json) {
    console.log(JSON.stringify({ withSkill: A, noSkill: B, gap, baseline, pass: !fail }, null, 2));
  } else {
    const row = (x) => `${x.id}  高光${x.highlight} 锁${x.lock} 轴${x.axis}${x.aurora === null ? '' : ' 极光' + x.aurora}  =${x.dims}  ${x.notes.join('; ')}  [专名 ${x.expectHit}]`;
    console.log('== with skill: ' + A.file + '  total ' + A.total);
    for (const x of A.items) console.log('  ' + row(x));
    console.log('== without skill: ' + B.file + '  total ' + B.total);
    for (const x of B.items) console.log('  ' + row(x));
    console.log(`\nwith=${A.total}  without=${B.total}  gap=${gap}  (baseline with>=${withMin}, gap>=${gapMin})`);
    console.log(fail ? 'FAIL: 低于基线或出现禁用词' : 'PASS');
  }
  process.exit(fail ? 1 : 0);
}

main();
