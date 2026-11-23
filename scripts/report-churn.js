#!/usr/bin/env node
// ============================================================
// 周度「返工体检」报告（2026-11-23 新增，只读，不改任何东西）
// ------------------------------------------------------------
// 为什么需要它：
//   2026-11-16 ~ 11-23 这一周 198 个提交里有 36 个 fix，其中多组是「同一个文件
//   在几十分钟内被 fix 了 2~3 次」（剪辑台预览 42 分钟内 3 次、超时阈值 18 分钟内 3 次、
//   创作页 12 分钟内 2 次）。靠人肉回忆根本数不出来，每次复盘都要从头翻 git。
//   本脚本把这些信号一次算完，让复盘从「翻 200 个提交」变成「扫一眼报告」。
//
// 数据来源：git log 的固定格式转储（不是自己 spawn git）。
//   本沙箱里 node 拉子进程一律 EPERM，所以由调用方先跑 git，再喂给本脚本：
//
//   git -C app -c core.quotepath=false log --since="7 days ago" \
//     --pretty=format:"@@%h|%ad|%s" --date=format:"%Y-%m-%d %H:%M" --name-only \
//     > .scratch/churn.log
//   node scripts/report-churn.js --input .scratch/churn.log
//
//   或直接管道（PowerShell 7 默认 UTF-8）：
//   git -C app ... --name-only | node scripts/report-churn.js --stdin
//
// 参数：
//   --input <file>     读转储文件
//   --stdin            读标准输入
//   --md               输出 Markdown（便于贴进复盘文档）
//   --fix-threshold N  fix 占比告警阈值（默认 25%）
//
// 退出码：永远 0（这是报告，不是门禁；门禁见 verify-gate-registry.js）
// ============================================================
'use strict';

const fs = require('fs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? fallback : v;
}

const INPUT = arg('input', '');
const USE_STDIN = process.argv.includes('--stdin');
const AS_MD = process.argv.includes('--md');
const FIX_THRESHOLD = Number(arg('fix-threshold', '25'));

function decode(buf) {
  // Windows PowerShell 的 `>` 会写成 UTF-16LE（带 BOM），PowerShell 7 默认 UTF-8。
  // 这里两种都认，避免「转储明明生成了却解析不到」这种纯环境坑。
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

function readAll() {
  if (INPUT) return decode(fs.readFileSync(INPUT));
  if (USE_STDIN) return decode(fs.readFileSync(0));
  console.error('需要 --input <file> 或 --stdin。生成转储的命令见文件头注释。');
  process.exit(2);
}

function parse(raw) {
  const commits = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    const head = /^@@([^|]+)\|(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\|(.*)$/.exec(line);
    if (head) {
      cur = { hash: head[1], day: head[2], time: head[3], at: `${head[2]} ${head[3]}`, subject: head[4], files: [] };
      commits.push(cur);
    } else if (cur && line.trim() !== '') {
      cur.files.push(line.trim().replace(/^"|"$/g, ''));
    }
  }
  return commits;
}

function typeOf(subject) {
  const m = /^([a-z]+)(?:\(|:)/.exec(subject);
  return m ? m[1] : 'other';
}

function fmtPct(n, total) {
  return total ? `${((n / total) * 100).toFixed(0)}%` : '0%';
}

function hoursBetween(a, b) {
  const pa = new Date(a.at.replace(' ', 'T') + ':00');
  const pb = new Date(b.at.replace(' ', 'T') + ':00');
  return Math.abs(pb - pa) / 36e5;
}

function main() {
  const commits = parse(readAll());
  if (!commits.length) {
    console.error('没有解析到提交。检查转储格式是否以 @@<hash>|<YYYY-MM-DD HH:MM>|<subject> 开头。');
    process.exit(2);
  }

  const total = commits.length;
  const byType = {};
  for (const c of commits) {
    const t = typeOf(c.subject);
    byType[t] = (byType[t] || 0) + 1;
  }
  const fixes = commits.filter((c) => typeOf(c.subject) === 'fix');
  const docs = commits.filter((c) => typeOf(c.subject) === 'docs');
  const dates = commits.map((c) => c.day).sort();

  // 文件总热度
  const fileCount = new Map();
  for (const c of commits) {
    for (const f of new Set(c.files)) fileCount.set(f, (fileCount.get(f) || 0) + 1);
  }
  const hotFiles = [...fileCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  // 同日反复改（≥3 次）
  const sameDay = new Map();
  for (const c of commits) {
    for (const f of new Set(c.files)) {
      const k = `${c.day}|${f}`;
      sameDay.set(k, (sameDay.get(k) || 0) + 1);
    }
  }
  const thrash = [...sameDay.entries()]
    .filter(([, n]) => n >= 3)
    .map(([k, n]) => {
      const [day, file] = k.split('|');
      return { day, file, n };
    })
    .sort((a, b) => b.n - a.n || a.day.localeCompare(b.day))
    .slice(0, 20);

  // 修了又修：把「同一文件的 fix 提交」按 24h 内的连续间隔聚成链。
  // 为什么不是笛卡尔积：3 个 fix 会产出 3 对，5 个 → 10 对，报告会被噪声淹没。
  // 链能直接回答「这个文件这周被修了几次、跨了多久」。
  const DOC_LIKE = /^(docs\/|AGENTS\.md$|PROGRESS\.md$|.*\/marketing\/)/;
  const byFileFixes = new Map();
  for (const c of fixes) {
    for (const f of new Set(c.files)) {
      if (DOC_LIKE.test(f)) continue;
      if (!byFileFixes.has(f)) byFileFixes.set(f, []);
      byFileFixes.get(f).push(c);
    }
  }
  const refix = [];
  for (const [file, list] of byFileFixes) {
    const sorted = list.slice().sort((a, b) => a.at.localeCompare(b.at));
    let cur = [sorted[0]];
    const flush = () => {
      if (cur.length >= 2) {
        refix.push({
          file,
          count: cur.length,
          span: hoursBetween(cur[0], cur[cur.length - 1]),
          commits: cur.slice()
        });
      }
    };
    for (let i = 1; i < sorted.length; i += 1) {
      if (hoursBetween(sorted[i - 1], sorted[i]) <= 24) cur.push(sorted[i]);
      else { flush(); cur = [sorted[i]]; }
    }
    flush();
  }
  refix.sort((a, b) => b.count - a.count || b.span - a.span);

  // 门禁覆盖（复用注册表检查，纯 fs）
  let gate = null;
  try {
    const reg = require('./verify-gate-registry.js');
    const suites = reg.parseSuites();
    const scripts = reg.listVerifyScripts();
    const registered = new Set(suites.map((s) => s.script));
    const manual = new Set(Object.keys(reg.MANUAL));
    gate = {
      scripts: scripts.length,
      registered: suites.length,
      manual: manual.size,
      homeless: scripts.filter((f) => !registered.has(f) && !manual.has(f) && f !== 'verify-all.js')
    };
  } catch (e) {
    gate = { error: e.message };
  }

  // 文档量
  const handoffDir = require('path').join(__dirname, '..', 'docs', '交接');
  let handoffDocs = 0;
  try { handoffDocs = fs.readdirSync(handoffDir).filter((f) => f.endsWith('.md')).length; } catch (e) { /* 无目录 */ }

  const fixRatio = total ? (fixes.length / total) * 100 : 0;
  const thrash3 = refix.filter((r) => r.count >= 3);
  const flags = [];
  if (fixRatio > FIX_THRESHOLD) flags.push(`fix 占比 ${fixRatio.toFixed(0)}% > ${FIX_THRESHOLD}%：本周在还债，不是在交付`);
  if (thrash3.length) {
    flags.push(`${thrash3.length} 个文件被 fix ≥3 次（另有 ${refix.length - thrash3.length} 个文件 2 次）：`
      + '同一症状反复出现，说明上一轮修的是症状不是根因');
  }
  if (gate && !gate.error && gate.homeless.length) flags.push(`${gate.homeless.length} 个 verify 脚本没有门禁归属`);
  if (docs.length / total > 0.35) flags.push(`docs 占比 ${fmtPct(docs.length, total)}：交接/文档成本偏高，注意上下文与单一事实源`);

  const out = [];
  const p = (s) => out.push(s);
  const H = (s) => p(AS_MD ? `\n## ${s}\n` : `\n=== ${s} ===`);

  p(AS_MD ? `# 返工体检（${dates[0]} → ${dates[dates.length - 1]}）` : `返工体检（${dates[0]} → ${dates[dates.length - 1]}）`);
  p('');
  p(`提交 ${total} 个｜fix ${fixes.length}（${fmtPct(fixes.length, total)}）｜feat ${byType.feat || 0}｜`
    + `docs ${docs.length}（${fmtPct(docs.length, total)}）｜test ${byType.test || 0}｜other ${byType.other || 0}`);

  H('提交类型分布');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    p(`- ${t.padEnd(8)} ${String(n).padStart(4)}  ${fmtPct(n, total)}`);
  }

  H('改得最多的文件（Top 15）');
  for (const [f, n] of hotFiles) p(`- ${String(n).padStart(3)}  ${f}`);

  H('同日反复改（同一文件一天 ≥3 次）');
  if (!thrash.length) p('- 无');
  for (const t of thrash) p(`- ${t.day}  ${String(t.n).padStart(2)} 次  ${t.file}`);

  H('修了又修（同文件、24h 内连续 fix 聚成链）');
  if (!refix.length) p('- 无');
  for (const r of refix.slice(0, 12)) {
    p(`- ${r.count} 次 / 跨度 ${r.span.toFixed(1)}h / ${r.file}`);
    for (const c of r.commits) p(`    ${c.at}  ${c.hash}  ${c.subject}`);
  }
  if (refix.length > 12) p(`- ……另有 ${refix.length - 12} 条链未展开`);

  H('门禁覆盖');
  if (!gate || gate.error) {
    p(`- 注册表检查失败：${gate ? gate.error : 'unknown'}`);
  } else {
    p(`- scripts/verify-*.js ${gate.scripts} 个｜注册 ${gate.registered}｜手动白名单 ${gate.manual}｜未归属 ${gate.homeless.length}`);
    if (gate.homeless.length) p(`- 未归属：${gate.homeless.join(', ')}`);
  }
  p(`- 交接文档 ${handoffDocs} 份（每份都意味着一次上下文切换）`);

  H('体检结论');
  if (!flags.length) p('- 未触发告警阈值');
  else for (const f of flags) p(`- ⚠ ${f}`);

  p('');
  p('下一步（照做即可，不必重新推理）：');
  p('1) 对每组「修了又修」写出**根因**，而不是再写一个补丁；同一症状第 3 次出现必须停手复盘。');
  p('2) 每个新断言先在旧代码上跑红（负向证据），再改代码到绿。');
  p('3) 新增 verify-*.js 必须注册进 verify-all，或在 verify-gate-registry.js 的 MANUAL 里写明理由。');
  p('4) 交付前跑 `pwsh -File scripts/preflight.ps1`，确认运行中的服务就是磁盘代码。');

  console.log(out.join('\n'));
  process.exit(0);
}

main();
