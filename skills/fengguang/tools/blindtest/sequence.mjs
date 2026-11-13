#!/usr/bin/env node
/**
 * sequence.mjs — 多段连续性评分（零依赖）
 *
 * 用法：node sequence.mjs --candidate <file.jsonl> [--json]
 *
 * 检查 5 段连续镜头是否"不串味"：
 *   - 运镜种类 ≥4（按类别：静止 / 推进 / 横移 / 摇臂 / 环绕 / 俯冲）
 *   - 光线种类 ≥3
 *   - 每段都有高光控制 + 结尾锁句
 *   - 每段只有一条运动轴（静机位配摇臂/推轨/横移 记 0）
 *   - 色彩倾向统一（冷/暖至少 4 段一致）
 *   - 主体句两两不重复（4-gram Jaccard ≤0.5）
 *   - 无禁用词
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNED = ['4K', '8K', 'cinematic', '配乐', '音效', '分辨率'];
const TIME = /日出前|日出|日落|蓝调|清晨|晨光|晨|正午|午后|日落后|黄昏|傍晚|无月|有月|月升|深夜|夜晚|白天|阴天/;
const COLD = /极冷极淡|冷调|冷色|青灰|青蓝/;
const WARM = /暖浓|暖调|暖色|赭石|铁锈/;
const STATIC = /静机位|静态|固定机位|机位锁定|锁定机位/;
const CRANE = /摇臂|升降|升镜|下降/;
const PUSH = /缓推|推进|推近|前推|一推/;
const LATERAL = /横移|平移|滑轨|滑行/;
const ORBIT = /环绕|绕拍/;
const DIVE = /俯冲|俯降/;

function grams(s, n = 4) {
  const set = new Set();
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}
function jaccard(a, b) {
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
function moveKind(p) {
  if (CRANE.test(p)) return '摇臂';
  if (ORBIT.test(p)) return '环绕';
  if (DIVE.test(p)) return '俯冲';
  if (PUSH.test(p)) return '推进';
  if (LATERAL.test(p)) return '横移';
  if (STATIC.test(p)) return '静止';
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'sequence.json'), 'utf8'));
const args = { candidate: null, json: false };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--candidate') args.candidate = process.argv[++i];
  else if (process.argv[i] === '--json') args.json = true;
}
if (!args.candidate) { console.error('usage: node sequence.mjs --candidate <file.jsonl> [--json]'); process.exit(2); }

const rows = fs.readFileSync(args.candidate, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const prompts = rows.map((r) => r.prompt);
const res = { rows: rows.length, moves: [], lights: [], axis: [], cold: 0, warm: 0, maxPair: 0, highlight: 0, lock: 0, banned: [] };

for (const p of prompts) {
  const kind = moveKind(p);
  res.moves.push(kind);
  // 静机位 + 位置性运动（摇臂/推轨/横移） = 双轴
  const bad = STATIC.test(p) && (CRANE.test(p) || PUSH.test(p) || LATERAL.test(p) || ORBIT.test(p));
  res.axis.push(bad ? 0 : 1);
  const lt = String(p).match(TIME);
  res.lights.push(lt ? lt[0] : null);
  if (COLD.test(p)) res.cold++;
  if (WARM.test(p)) res.warm++;
  if (/高光[^。；]{0,12}(受控|控住|控死|控制|不过曝|不炸|不溢出|保留|压住)|高光受控|不炸开|不死白|不溢出/.test(p)) res.highlight++;
  if (/画面停|画面锁在|画面锁死|画面锁定|无新元素进入|不再进入新元素|结尾[^。；]{0,10}(停|定住|定格|锁)/.test(p)) res.lock++;
  for (const w of BANNED) if (p.includes(w)) res.banned.push(w);
}
const distinctMoves = new Set(res.moves.filter(Boolean)).size;
const distinctLights = new Set(res.lights.filter(Boolean)).size;
const fam = (p) => (COLD.test(p) ? 'cold' : WARM.test(p) ? 'warm' : 'none');
const headTail = { palette: [fam(prompts[0]), fam(prompts[prompts.length - 1])], move: [res.moves[0], res.moves[res.moves.length - 1]] };
for (let i = 0; i < prompts.length; i++)
  for (let j = i + 1; j < prompts.length; j++)
    res.maxPair = Math.max(res.maxPair, jaccard(String(prompts[i]).split('。')[0], String(prompts[j]).split('。')[0]));

const checks = {
  rows5: res.rows === cfg.segments,
  distinctMove: distinctMoves >= cfg.rules.distinctMove,
  distinctLight: distinctLights >= cfg.rules.distinctLight,
  allAxis: res.axis.every((x) => x === 1),
  allHighlight: res.highlight === res.rows,
  allLock: res.lock === res.rows,
  palette: Math.max(res.cold, res.warm) >= res.rows - 1,
  distinctSubjects: res.maxPair <= 0.5,
  noBanned: res.banned.length === 0,
  // 首尾循环：头尾同色系 + 同运镜类型，才剪得回开头
  loopPalette: headTail.palette[0] === headTail.palette[1] && headTail.palette[0] !== 'none',
  loopMove: headTail.move[0] === headTail.move[1] && headTail.move[0] !== null
};
const pass = Object.values(checks).every(Boolean);

if (args.json) console.log(JSON.stringify({ candidate: args.candidate, ...res, headTail, distinctMoves, distinctLights, checks, pass }, null, 2));
else {
  console.log('== ' + args.candidate);
  prompts.forEach((p, i) => console.log(`  ${rows[i].id}  move=${res.moves[i] || '-'}  axis=${res.axis[i]}  light=${res.lights[i] || '-'}  ${p.slice(0, 38)}…`));
  console.log(`\n  运镜种类 ${distinctMoves}（需≥${cfg.rules.distinctMove}） · 光线种类 ${distinctLights}（需≥${cfg.rules.distinctLight}） · 主体最大重复 ${res.maxPair.toFixed(2)}（需≤0.50）`);
  console.log(`  单轴 ${res.axis.filter((x) => x).length}/${res.rows} · 高光 ${res.highlight}/${res.rows} · 锁句 ${res.lock}/${res.rows} · 冷暖 ${res.cold}/${res.warm} · 禁用词 ${res.banned.length}`);
  console.log('  ' + Object.entries(checks).map(([k, v]) => `${k}=${v ? 'ok' : 'FAIL'}`).join('  '));
  console.log(pass ? '\nPASS' : '\nFAIL');
}
process.exit(pass ? 0 : 1);
