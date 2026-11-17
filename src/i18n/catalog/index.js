// ==========================================
// 后端 catalog 汇总（P2）
// ------------------------------------------------------------
// 每个模块导出 { zh: {key: string}, en: {key: string} }，键是**扁平全路径**。
// 这里只做浅合并：同一 key 在多个文件里出现视为 bug（verify-i18n-backend.js 会查）。
// 约定：中文是「现有产品原话」的逐字副本；英文是人工写的界面级英文，不走机翻。
// ==========================================

'use strict';

const MODULES = [
  require('./server'),
  require('./auth'),
  require('./tasks'),
  require('./assistant'),
  require('./media'),
  require('./qc'),
  require('./pipeline'),
  require('./generators'),
  require('./ws')
];

const zh = {};
const en = {};
const duplicates = [];

for (const mod of MODULES) {
  for (const [key, value] of Object.entries((mod && mod.zh) || {})) {
    if (Object.prototype.hasOwnProperty.call(zh, key)) duplicates.push(key);
    zh[key] = value;
  }
  for (const [key, value] of Object.entries((mod && mod.en) || {})) {
    if (Object.prototype.hasOwnProperty.call(en, key)) duplicates.push(key);
    en[key] = value;
  }
}

module.exports = { zh, en, duplicates };
