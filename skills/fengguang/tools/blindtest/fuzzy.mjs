#!/usr/bin/env node
/**
 * fuzzy.mjs — 模糊需求评分（零依赖）
 *
 * 用法：node fuzzy.mjs --candidate <file.jsonl> [--baseline fuzzy-baseline.json] [--json]
 *
 * 每条 5 分：具体物（把"好看/震撼"换成专名）· 光位（时刻+方向/冷暖）· 高光控制 · 结尾锁句 · 单轴
 * 满分 30；出现禁用词只报告不扣分。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNED = ['4K', '8K', 'cinematic', '配乐', '音效', '分辨率'];
const STATIC = /静机位|固定机位|机位锁定|静态长镜头|绝对静止|画面极静/;
const MOVE = /缓推|推进|推近|前推|一推|横移|平移|升镜|下降|降高度|环绕/;
const PUSH = /缓推|推进|推近|前推|一推/;
const OTHERMOVE = /横移|平移|升镜|下降|降高度|环绕/;
const TIME = /日出前|日出|日落|蓝调|清晨|晨光|晨|正午|午后|日落后|黄昏|傍晚|无月|有月|月升|深夜|夜晚|白天|阴天/;
const DIR = /侧光|侧逆|逆光|顺光|顶光|低角度|斜侧|散射|无方向/;
const WARM = /冷|暖/;

function parseArgs(argv) {
  const out = { candidate: null, baseline: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidate') out.candidate = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

function evalOne(p, req) {
  const r = { concrete: 0, light: 0, highlight: 0, lock: 0, axis: 1, vague: [], banned: [], notes: [] };
  const hits = req.concrete.filter((t) => p.includes(t));
  if (hits.length >= 1) r.concrete = 1;
  else r.notes.push('没落到具体地貌');
  r.vague = req.vague.filter((t) => p.includes(t));
  if (TIME.test(p) && (DIR.test(p) || WARM.test(p))) r.light = 1;
  else r.notes.push('光位不完整（缺时刻或方向/冷暖）');
  if (/高光[^。；]{0,12}(受控|控住|控死|控制|不过曝|不炸|不溢出|保留|压住)|高光受控|不炸开|不死白|不溢出/.test(p)) r.highlight = 1;
  else r.notes.push('无高光控制');
  if (/画面停|画面锁在|画面锁死|画面锁定|无新元素进入|不再进入新元素|结尾[^。；]{0,10}(停|定住|定格|锁)/.test(p)) r.lock = 1;
  else r.notes.push('结尾未锁画面');
  if (STATIC.test(p) && MOVE.test(p)) { r.axis = 0; r.notes.push('静机位配镜头运动'); }
  else if (PUSH.test(p) && OTHERMOVE.test(p)) { r.axis = 0; r.notes.push('两套镜头运动'); }
  for (const w of BANNED) if (p.includes(w)) r.banned.push(w);
  r.dims = r.concrete + r.light + r.highlight + r.lock + r.axis;
  return r;
}

function main() {
  const args = parseArgs(process.argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const reqs = JSON.parse(fs.readFileSync(path.join(here, 'fuzzy.json'), 'utf8'));
  const map = reqs; // id -> req
  const rows = fs.readFileSync(args.candidate, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.prompt]));
  let total = 0;
  const items = [];
  for (const id of Object.keys(map)) {
    const p = byId[id];
    if (!p) { items.push({ id, missing: true }); continue; }
    const r = evalOne(p, map[id]);
    total += r.dims;
    items.push({ id, ...r });
  }
  const baseline = args.baseline ? JSON.parse(fs.readFileSync(args.baseline, 'utf8')) : { total: 26, tolerance: 1 };
  const fail = total < (baseline.total - (baseline.tolerance ?? 1));
  if (args.json) console.log(JSON.stringify({ candidate: args.candidate, total, max: 30, items, baseline, pass: !fail }, null, 2));
  else {
    console.log('== ' + args.candidate + '  total ' + total + '/30');
    for (const x of items) {
      if (x.missing) { console.log('  ' + x.id + '  MISSING'); continue; }
      console.log(`  ${x.id}  具体${x.concrete} 光${x.light} 高光${x.highlight} 锁${x.lock} 轴${x.axis} =${x.dims}` +
        (x.vague.length ? '  空词:' + x.vague.join('/') : '') +
        (x.notes.length ? '  ' + x.notes.join('; ') : '') +
        (x.banned.length ? '  BANNED:' + x.banned.join('/') : ''));
    }
    console.log(`\ntotal=${total}  (baseline >= ${baseline.total - (baseline.tolerance ?? 1)})  ` + (fail ? 'FAIL' : 'PASS'));
  }
  process.exit(fail ? 1 : 0);
}

main();
