// ============================================================
// 硬编码中文扫描（共享库）— 2026-11-23 抽出
// ------------------------------------------------------------
// 为什么抽出来：同一份扫描逻辑要同时服务
//   ① scripts/verify-i18n.js --strict（门禁）
//   ② scripts/preflight.js（交付前一键自检）
// 如果各写一份，迟早出现「门禁过了、自检没过」这种两份真相。
//
// 语义（不要放宽）：
//   - 只扫 web/src 下应用代码，跳过 i18n/messages 与 vendor；
//   - 行内注释里的中文不算（stripLineComment）；
//   - 块注释里的中文不算，但**换行保留**，否则行号会错位；
//   - `i18n-allow` 标记要认**原始行**（行注释或块注释两种写法都认），
//     否则块注释形式的标记会被「先删块注释」这一步自己删掉（2026-11-23 实测踩到）。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

function walk(dir, out) {
  const result = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) result.push(full);
  }
  return result;
}

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

// 去掉块注释但保留换行（行号不错位）
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
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

function scanHardcodedCjk(root) {
  const webSrc = path.join(root, 'web', 'src');
  const files = walk(webSrc, []).filter((file) => {
    const r = rel(root, file);
    return !r.startsWith('web/src/i18n/messages/') && !r.startsWith('web/src/vendor/');
  });
  const byFile = [];
  let total = 0;
  let allowed = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = stripBlockComments(raw);
    const rawLines = raw.split(/\r?\n/);
    const lines = src.split(/\r?\n/);
    let count = 0;
    const samples = [];
    lines.forEach((line, index) => {
      const code = stripLineComment(line);
      const cjk = code.match(/[\u4e00-\u9fff]/g);
      if (cjk) {
        // 显式标记 i18n-allow（行注释或块注释均可）：语言自称、后端中文匹配、中文输入同义词等。
        const marked = /\bi18n-allow\b/.test(line) || /\bi18n-allow\b/.test(rawLines[index] || '');
        if (marked) { allowed += cjk.length; return; }
        count += cjk.length;
        if (samples.length < 2) samples.push({ line: index + 1, text: code.trim().slice(0, 90) });
      }
    });
    if (count > 0) {
      total += count;
      byFile.push({ file: rel(root, file), count, samples });
    }
  }
  byFile.sort((a, b) => b.count - a.count);
  return { total, allowed, byFile };
}

module.exports = { walk, rel, stripBlockComments, stripLineComment, scanHardcodedCjk };
