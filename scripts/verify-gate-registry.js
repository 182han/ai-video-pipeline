#!/usr/bin/env node
// ============================================================
// 门禁注册表守卫（2026-11-23 新增）
// ------------------------------------------------------------
// 为什么需要它（真实事故背景，别删）：
//   2026-11-16 ~ 11-23 一周内，scripts/ 下的 verify-*.js 从 67 涨到 108，
//   而 verify-all.js 只注册了 98 个。剩下的 9 个里，有的确实需要运行中的服务
//   （合理的手动套件），但**没有任何机器可读的记录**说明「为什么不在门禁里」。
//   后果：写脚本的人以为加进去就守住了，实际下一次回归根本不会跑它。
//   更糟的是 verify-all 只按 `script:` 拉起脚本，**不传参数**——
//   `verify-i18n.js` 的 desc 写着「硬编码中文扫描（--strict 收口）」，
//   但运行时根本没带 `--strict`，于是那条规则长期只是注释。
//
// 本脚本检查（纯 fs 解析，不 spawn 子进程；本沙箱 spawn EPERM 也能跑）：
//   1. scripts/ 下每个 verify-*.js 要么注册进 verify-all.js 的 SUITES，
//      要么在 MANUAL 白名单里**写明理由与手动跑法**；
//   2. SUITES 每一条都指向真实存在的文件（防改名字留下死注册）；
//   3. 没有重复的 suite name / script（--only 按 name 选，重名会静默跑错）；
//   4. MANUAL 与 SUITES 不重叠（注册后要把它从 MANUAL 删掉）；
//   5. SUITES 每条都有 desc，group 只能是 fast / real。
//
// 用法：
//   node scripts/verify-gate-registry.js
//   node scripts/verify-gate-registry.js --json
//
// 退出码：0 = 没有洞；1 = 有洞（输出会逐条列出）
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const ALL_PATH = path.join(SCRIPTS_DIR, 'verify-all.js');

// 手动套件白名单：必须写清「为什么不能进自动门禁」+「怎么手动跑」。
// 只允许两类：① 需要运行中服务/登录态；② 会真实计费。
// 不属于这两类就必须注册进门禁，不许放这里。
const MANUAL = {
  'verify-agent-http.js': {
    reason: '需要已重启的 3001 + 登录态，未登录即失败',
    how: '登录后手动：node scripts/verify-agent-http.js'
  },
  'verify-agent-live.js': {
    reason: '真实模型多轮，会计费（§4.9 须先取得用户同意）',
    how: '用户同意后：node scripts/verify-agent-live.js --yes-spend'
  },
  'verify-bgm-api.js': {
    reason: '打运行中服务的接口端到端，需要登录与 BGM 测试数据',
    how: '登录后：node scripts/verify-bgm-api.js'
  },
  'verify-bgm-e2e2.js': {
    reason: '端到端配乐链路，需运行中服务与隔离的任务/输出副本',
    how: '隔离副本下：node scripts/verify-bgm-e2e2.js'
  },
  'verify-bgm-negative.js': {
    reason: '负向验证需运行中服务的真实错误码，需要登录',
    how: '登录后：node scripts/verify-bgm-negative.js'
  },
  'verify-i18n-live.js': {
    reason: '扫「运行中的英文界面」返回体，需要已重启的服务与登录态',
    how: '登录后：node scripts/verify-i18n-live.js'
  },
  'verify-port3001.js': {
    reason: '显式在 3001 上跑配乐完整链路，依赖运行中的单实例',
    how: '服务运行后：node scripts/verify-port3001.js'
  },
  'verify-scene-cards-http.js': {
    reason: 'HTTP 层验收，需要运行中的单实例 3001',
    how: '服务运行后：node scripts/verify-scene-cards-http.js'
  },
  'verify-security-hardening.js': {
    reason: '部署加固验收（外发部署前）需要运行中服务与未登录/已登录两种态',
    how: '部署前手动：node scripts/verify-security-hardening.js'
  }
};

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('✓ ' + name);
  } else {
    failed += 1;
    console.log('✗ ' + name + (detail ? ' — ' + detail : ''));
    failures.push(name + (detail ? ' — ' + detail : ''));
  }
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function parseSuites() {
  const src = readText(ALL_PATH);
  const suites = [];
  // 以 name: '...' 为锚点，把「到下一条 name 之前」当作该条的块，再读 script/group/args。
  // 不能固定截 700 字符：那样会把下一条的 args 吞进来（实测 gate-registry 被误读成带 --strict）。
  const marks = [];
  const nameRe = /name:\s*'([^']+)'/g;
  let m = nameRe.exec(src);
  while (m) {
    marks.push({ name: m[1], at: m.index });
    m = nameRe.exec(src);
  }
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    const block = src.slice(marks[i].at, end);
    const script = /script:\s*'([^']+)'/.exec(block);
    const group = /group:\s*'(fast|real)'/.exec(block);
    const args = /args:\s*(\[[^\]]*\])/.exec(block);
    if (script && group) {
      suites.push({ name: marks[i].name, script: script[1], group: group[1], args: args ? args[1] : null });
    }
  }
  return suites;
}

function listVerifyScripts() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => /^verify-.*\.js$/.test(f))
    .sort();
}

function main() {
  console.log('='.repeat(60));
  console.log('门禁注册表守卫');
  console.log('='.repeat(60));

  ok('verify-all.js 存在', fs.existsSync(ALL_PATH));

  const suites = parseSuites();
  const files = listVerifyScripts();
  const registered = new Set(suites.map((s) => s.script));
  const runners = new Set(['verify-all.js']);
  const manualNames = new Set(Object.keys(MANUAL));

  ok('解析出 SUITES', suites.length > 0, `解析到 ${suites.length} 条`);
  console.log(`  scripts/verify-*.js 实有 ${files.length} 个；SUITES 注册 ${suites.length} 条；`
    + `手动白名单 ${manualNames.size} 个`);

  // 1. 每个 verify-*.js 必须有归属（注册 / 手动 / runner 本身）
  const homeless = files.filter((f) => !registered.has(f) && !manualNames.has(f) && !runners.has(f));
  ok('每个 verify-*.js 都有归属（注册或写明理由的手动白名单）', homeless.length === 0,
    homeless.length ? '未归属：' + homeless.join(', ') : '');

  // 2. 注册的都真实存在（防改名字后留下死注册）
  const missing = suites.filter((s) => !fs.existsSync(path.join(SCRIPTS_DIR, s.script)));
  ok('每条注册都指向真实存在的脚本', missing.length === 0,
    missing.map((s) => `${s.name}→${s.script}`).join(', '));

  // 3. 不重名、不重复注册同一个脚本
  const nameDup = suites.map((s) => s.name).filter((n, i, a) => a.indexOf(n) !== i);
  const scriptDup = suites.map((s) => s.script).filter((n, i, a) => a.indexOf(n) !== i);
  ok('suite name 不重复（--only 按 name 选）', nameDup.length === 0, [...new Set(nameDup)].join(', '));
  ok('同一个脚本不重复注册', scriptDup.length === 0, [...new Set(scriptDup)].join(', '));

  // 4. 手动白名单不能与注册重叠（注册后忘了删 = 两份真相）
  const both = [...manualNames].filter((f) => registered.has(f));
  ok('手动白名单与 SUITES 不重叠', both.length === 0,
    both.length ? '已注册但仍在 MANUAL：' + both.join(', ') : '');

  // 5. 手动白名单必须写理由和跑法，且文件存在
  const badManual = [];
  for (const [file, meta] of Object.entries(MANUAL)) {
    if (!fs.existsSync(path.join(SCRIPTS_DIR, file))) badManual.push(`${file}（文件已不存在）`);
    else if (!meta.reason || meta.reason.length < 8) badManual.push(`${file}（reason 太短）`);
    else if (!meta.how || meta.how.length < 8) badManual.push(`${file}（缺手动跑法）`);
  }
  ok('手动白名单每条都有理由与手动跑法', badManual.length === 0, badManual.join('; '));

  // 6. 每条注册都有 desc（--only 时能看懂在验什么）
  const src = readText(ALL_PATH);
  const descMissing = suites.filter((s) => {
    const block = src.slice(src.indexOf(`name: '${s.name}'`), src.indexOf(`name: '${s.name}'`) + 400);
    return !/desc:\s*'/.test(block);
  });
  ok('每条注册都有 desc（--only 时能看懂在验什么）', descMissing.length === 0,
    descMissing.map((s) => s.name).join(', '));

  // 7. 注册为 fast/real 的分布（不是断言，只报告，避免"全是 real 等于没 fast 门禁"）
  const fast = suites.filter((s) => s.group === 'fast').length;
  console.log(`  group 分布：fast ${fast} / real ${suites.length - fast}`
    + '（fast 是每次必跑的最小集；全是 real 会导致 --fast 什么都不验）');
  ok('fast 组非空（--fast 才有意义）', fast > 0);

  console.log('\n' + '='.repeat(60));
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log(`结果: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
} else {
  module.exports = { parseSuites, listVerifyScripts, MANUAL };
}
