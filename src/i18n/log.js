// ==========================================
// 后端 i18n · 用户可见日志工具（P2）
// ------------------------------------------------------------
// 契约：日志**保留原中文 text**，另加可选 { key, params, lang, localized }。
//   · 中文模式：text / localized 都是原中文（逐字不变，零回归）；
//   · 英文模式：text 仍是中文原文（旧消费者），localized 是按 catalog 渲染的英文。
// 只给「用户看得见」的日志用（任务进度/步骤/失败原因）；调试日志保持原样，避免噪音。
// ==========================================

'use strict';

const i18n = require('./index');

// 构造一条结构化日志（不打印）
function logEntry(lang, key, params, fallbackText) {
  const l = i18n.normalizeLang(lang) || i18n.DEFAULT_LANG;
  const localized = i18n.logText(l, key, params, fallbackText);
  return {
    text: fallbackText,
    key: key || null,
    params: params || null,
    lang: l,
    localized
  };
}

// 打印一条用户可见日志：中文模式输出与改造前完全一致（只输出 fallbackText）。
// 英文模式且 key 命中时输出英文；未命中回退原文。返回 logEntry 供持久化/推送复用。
function log(level, lang, key, params, fallbackText) {
  const entry = logEntry(lang, key, params, fallbackText);
  const fn = typeof console[level] === 'function' ? console[level] : console.log;
  fn(entry.localized || entry.text);
  return entry;
}

// 给已有对象补 errorKey（精确/前缀反查）；返回同一对象，便于链式使用。
function attachErrorKey(obj, message, options = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  if (!obj.errorKey && typeof message === 'string' && message) {
    const key = i18n.keyForText(message, { prefix: options.prefix !== false });
    if (key) obj.errorKey = key;
  }
  return obj;
}

module.exports = {
  logEntry,
  log,
  attachErrorKey,
  // 直接透传运行时，调用方只 require 本文件即可
  t: i18n.t,
  tp: i18n.tp,
  keyForText: i18n.keyForText,
  logText: i18n.logText
};
