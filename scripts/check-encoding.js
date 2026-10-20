#!/usr/bin/env node
// ==========================================
// 编码完整性检查（研发自检用，不参与运行时）
// ==========================================
// 背景：仓库里多数源文件是 GBK 编码，而新增代码是 UTF-8。
//       edit 工具是「字节级精确替换」，理论上不会碰到未改动的行，
//       但混编码文件在 GBK 环境里用 cat/type 查看会显示乱码，
//       容易让人误以为「整文件被写坏了」。本脚本给出客观判定。
//
// 运行：cd app && node scripts/check-encoding.js src/qualityChecker.js
// 退出码：0 = 未改动的旧行为有效 UTF-8（无污染）；1 = 发现污染
// ==========================================

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'src', 'qualityChecker.js');
const buf = fs.readFileSync(target);
const text = buf.toString('utf8');

// 统计替换字符（U+FFFD）：出现即说明该处字节流不是合法 UTF-8
const badPositions = [];
for (let i = 0; i < text.length; i++) {
  if (text.charCodeAt(i) === 0xFFFD) badPositions.push(i);
}

// 按行定位有多少行含非法 UTF-8 字节
const lines = text.split(/\r?\n/);
const badLines = [];
let offset = 0;
const lineStart = [];
for (const l of lines) { lineStart.push(offset); offset += l.length + 1; }
let idx = 0;
for (let i = 0; i < lines.length; i++) {
  while (idx < badPositions.length && badPositions[idx] < lineStart[i]) idx++;
  if (idx < badPositions.length && badPositions[idx] < lineStart[i] + lines[i].length) {
    badLines.push({ line: i + 1, text: lines[i].slice(0, 80) });
  }
}

console.log(`检查文件: ${target}`);
console.log(`大小: ${buf.length} bytes / ${lines.length} 行`);
console.log(`替换字符(U+FFFD) 总数: ${badPositions.length}`);
console.log(`含非法 UTF-8 字节的行数: ${badLines.length}`);
if (badLines.length) {
  console.log('前 10 行:');
  badLines.slice(0, 10).forEach(b => console.log(`  L${b.line}: ${b.text}`));
}

// 抽样确认关键中文文案可用 UTF-8 正确读出
const markers = process.env.ENC_MARKERS ? process.env.ENC_MARKERS.split('|') : [];
console.log('关键文案 UTF-8 读取:');
for (const m of markers) {
  console.log(`  「${m}」`, text.includes(m) ? 'OK' : 'MISSING');
}

process.exit(badLines.length === 0 ? 0 : 1);
