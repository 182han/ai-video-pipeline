#!/usr/bin/env node
// ============================================================
// i18n 守卫（对应 i18next-cli 的 lint / extract 思路）
// ------------------------------------------------------------
// 检查：
//  1. 中文/英文词条一一对应（key 对等）
//  2. 同 key 的 {占位符} 集合一致
//  3. 代码里 t() / tp() / has() 用到的静态 key 都存在
//  4. messages 目录下的 namespace 都已注册
//  5. public/login.html 的自包含字典 zh/en 对等
//  6. 硬编码中文扫描（默认报告；--strict 时失败）
//
// 用法：
//   node scripts/verify-i18n.js            # 词条正确性必须过；硬编码只报告
//   node scripts/verify-i18n.js --strict   # 硬编码中文 > 0 也失败（P1 完成后启用）
//
// 退出码：通过 = 0，失败 = 1
// ============================================================
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const WEB_SRC = path.join(ROOT, 'web', 'src');
const MESSAGES_DIR = path.join(WEB_SRC, 'i18n', 'messages');
const LOGIN_PAGE = path.join(ROOT, 'public', 'login.html');
const STRICT = process.argv.includes('--strict');

let passed = 0;
let failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('✓ ' + name);
  } else {
    failed += 1;
    console.log('✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

// 去掉行尾 // 注释：引号内的 // 不算（URL、正则等常见场景都能过）
function stripLineComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function flatten(obj, prefix, out) {
  const result = out || {};
  for (const key of Object.keys(obj)) {
    const full = prefix ? prefix + '.' + key : key;
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, result);
    else result[full] = value;
  }
  return result;
}

function placeholders(template) {
  const set = new Set();
  String(template || '').replace(/\{(\w+)\}/g, (match, name) => { set.add(name); return match; });
  return Array.from(set).sort();
}

function collectUsedKeys() {
  const used = new Map();
  const files = walk(WEB_SRC, []).filter((file) => {
    const r = rel(file);
    return !r.startsWith('web/src/i18n/messages/') && !r.startsWith('web/src/vendor/');
  });
  for (const file of files) {
    const src = stripBlockComments(fs.readFileSync(file, 'utf8'));
    const re = /\b(?:t|tp|has)\(\s*(['"])([A-Za-z0-9_.]+)\1/g;
    let match = re.exec(src);
    while (match) {
      const key = match[2];
      if (!used.has(key)) used.set(key, new Set());
      used.get(key).add(rel(file));
      match = re.exec(src);
    }
  }
  return used;
}

function scanHardcodedCjk() {
  const files = walk(WEB_SRC, []).filter((file) => {
    const r = rel(file);
    return !r.startsWith('web/src/i18n/messages/') && !r.startsWith('web/src/vendor/');
  });
  const byFile = [];
  let total = 0;
  for (const file of files) {
    const src = stripBlockComments(fs.readFileSync(file, 'utf8'));
    const lines = src.split(/\r?\n/);
    let count = 0;
    const samples = [];
    lines.forEach((line, index) => {
      const code = stripLineComment(line);
      const cjk = code.match(/[\u4e00-\u9fff]/g);
      if (cjk) {
        count += cjk.length;
        if (samples.length < 2) samples.push({ line: index + 1, text: code.trim().slice(0, 90) });
      }
    });
    if (count > 0) {
      total += count;
      byFile.push({ file: rel(file), count, samples });
    }
  }
  byFile.sort((a, b) => b.count - a.count);
  return { total, byFile };
}

function loginDictionaryKeys() {
  if (!fs.existsSync(LOGIN_PAGE)) return null;
  const src = fs.readFileSync(LOGIN_PAGE, 'utf8');
  const start = src.indexOf('var I18N = {');
  if (start < 0) return null;
  const endMarker = src.indexOf('\n  };', start);
  if (endMarker < 0) return null;
  const block = src.slice(start, endMarker);
  const enIndex = block.indexOf('\n    en: {');
  if (enIndex < 0) return null;
  const zhPart = block.slice(0, enIndex);
  const enPart = block.slice(enIndex);
  const extract = (text) => {
    const keys = new Set();
    const re = /^\s{6}([A-Za-z_][A-Za-z0-9_]*):/gm;
    let match = re.exec(text);
    while (match) { keys.add(match[1]); match = re.exec(text); }
    return keys;
  };
  const zh = extract(zhPart);
  const en = extract(enPart);
  return { zh, en, block };
}

(async function main() {
  console.log('=== i18n 守卫 ===\n');

  const mod = await import(pathToFileURL(path.join(MESSAGES_DIR, 'index.js')).href);
  const messages = mod.messages || {};
  const registered = mod.NAMESPACE_NAMES || [];

  const zh = flatten(messages.zh || {}, '', {});
  const en = flatten(messages.en || {}, '', {});
  const zhKeys = Object.keys(zh);
  const enKeys = Object.keys(en);

  ok('中文词条非空（' + zhKeys.length + ' 条）', zhKeys.length > 0);
  ok('英文词条非空（' + enKeys.length + ' 条）', enKeys.length > 0);

  const missingEn = zhKeys.filter((key) => en[key] === undefined);
  const missingZh = enKeys.filter((key) => zh[key] === undefined);
  ok('每个中文 key 都有英文', missingEn.length === 0, missingEn.slice(0, 8).join(', '));
  ok('每个英文 key 都有中文', missingZh.length === 0, missingZh.slice(0, 8).join(', '));

  const emptyZh = zhKeys.filter((key) => !String(zh[key]).trim());
  const emptyEn = enKeys.filter((key) => !String(en[key]).trim());
  ok('没有空词条（中）', emptyZh.length === 0, emptyZh.slice(0, 8).join(', '));
  ok('没有空词条（英）', emptyEn.length === 0, emptyEn.slice(0, 8).join(', '));

  const placeholderMismatch = zhKeys.filter((key) => {
    if (en[key] === undefined) return false;
    const a = placeholders(zh[key]).join(',');
    const b = placeholders(en[key]).join(',');
    return a !== b;
  });
  ok('同 key 的 {占位符} 中英一致', placeholderMismatch.length === 0, placeholderMismatch.slice(0, 8).join(', '));

  const used = collectUsedKeys();
  const usedMissing = [];
  for (const [key, files] of used.entries()) {
    if (zh[key] === undefined && en[key] === undefined) {
      usedMissing.push(key + ' (' + Array.from(files).slice(0, 2).join(', ') + ')');
    }
  }
  ok('代码里 t()/tp()/has() 用到的 key 都存在（' + used.size + ' 个）', usedMissing.length === 0, usedMissing.slice(0, 8).join('; '));

  const namespaceFiles = fs.readdirSync(MESSAGES_DIR)
    .filter((name) => name.endsWith('.js') && name !== 'index.js')
    .map((name) => name.replace(/\.js$/, ''));
  const unregistered = namespaceFiles.filter((name) => !registered.includes(name));
  ok('messages 目录下的 namespace 都已注册', unregistered.length === 0, unregistered.join(', '));

  const login = loginDictionaryKeys();
  if (!login) {
    ok('login.html 自包含字典可解析', false, '未找到 var I18N = { ... }');
  } else {
    const missingLoginEn = Array.from(login.zh).filter((key) => !login.en.has(key));
    const missingLoginZh = Array.from(login.en).filter((key) => !login.zh.has(key));
    ok('登录页 zh/en 字典 key 对等（各 ' + login.zh.size + ' 条）',
      missingLoginEn.length === 0 && missingLoginZh.length === 0,
      missingLoginEn.concat(missingLoginZh).slice(0, 8).join(', '));

    const placeholderPairs = [
      ['zh', login.block.slice(0, login.block.indexOf('\n    en: {'))],
      ['en', login.block.slice(login.block.indexOf('\n    en: {'))]
    ].map(([name, text]) => {
      const statusKey = /errOther:\s*"([^"]*)"/.exec(text);
      return name + ':' + (statusKey ? statusKey[1] : '');
    });
    ok('登录页错误文案占位符 {status} 双语都有',
      placeholderPairs.every((pair) => pair.includes('{status}')));
  }

  const hardcoded = scanHardcodedCjk();
  console.log('\n—— 硬编码中文扫描（' + (STRICT ? 'strict' : '报告模式') + '）——');
  if (hardcoded.total === 0) {
    console.log('✓ 除词条文件外未发现硬编码中文');
  } else {
    console.log('共 ' + hardcoded.total + ' 处，涉及 ' + hardcoded.byFile.length + ' 个文件（按数量排序，前 12）：');
    hardcoded.byFile.slice(0, 12).forEach((item) => {
      console.log('  ' + String(item.count).padStart(5) + '  ' + item.file
        + (item.samples[0] ? '  e.g. L' + item.samples[0].line + ': ' + item.samples[0].text : ''));
    });
  }
  if (STRICT) {
    ok('硬编码中文为 0（strict）', hardcoded.total === 0, hardcoded.total + ' 处');
  } else if (hardcoded.total > 0) {
    console.log('（P1 迁移期间允许存在；完成后再用 --strict 收口）');
  }

  console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('i18n 守卫自身异常：', err);
  process.exit(1);
});
