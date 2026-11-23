// ==========================================
// 日志脱敏：避免引导口令被 console 双写进 data/logs
// ==========================================
// 背景：server.js 把 console.log 双写到 data/logs/server-*.log；
// auth.doBootstrap 首次建号时会打印「密码: <生成值>」，于是明文口令落盘。
// 这里只处理「日志文本」，不影响终端显示；终端仍会让操作者看到一次。
// ==========================================

'use strict';

const REDACTIONS = [
  // 中文引导口令行：密码: xxx；但「密码: 来自 app/.env 的 AUTH_PASSWORD」不脱敏。
  // 排除「重置密码: 用户名」「修改密码: 用户名」这类审计行（只脱敏真正的口令值）。
  [/(?<!置)(?<!改)密码[:：]\s*(?!来自)([^\s]+)/g, '密码: ***'],
  // AUTH_PASSWORD=xxx / AUTH_PASSWORD: xxx
  [/(AUTH_PASSWORD\s*[=:]\s*)([^\s,;]+)/gi, '$1***'],
  // 通用 password=xxx（仅用于日志；不会触碰请求体或数据库）
  [/((?:password|passwd)\s*[=:]\s*)([^\s,;]+)/gi, '$1***']
];

function redactLogLine(input) {
  let text = String(input == null ? '' : input);
  for (const [re, replacement] of REDACTIONS) {
    text = text.replace(re, replacement);
  }
  return text;
}

module.exports = { redactLogLine };
