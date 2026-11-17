// ==========================================
// 小智 V2 · 审计记录（谁在何时改了什么；只读可查）
// ------------------------------------------------------------
// 设计（Q18=A 可回看 / 设计文档 §2 V2「审计记录」）：
//   · append-only JSONL，一行一条，重放/轮转不做（本轮只需要「可查」）；
//   · 字段：at / actor / kind / action / target / before / after / note；
//   · **写前一律过 redact**（Key 值不落盘）；actor 来自登录会话 userId，无登录墙时是 'local'；
//   · 落 data/assistant/audit.jsonl（ASSISTANT_AUDIT_FILE 可覆盖；data/assistant 已 gitignore）。
//
// 本模块不判断 L3：只被「已经确认成功」的调用方写；未确认的动作不产生审计条目。
// ==========================================

'use strict';

const fs = require('fs');
const path = require('path');
const { redactText, redactDeep } = require('./redact');

const AUDIT_VERSION = 'assistant-audit.v1';
const BASE_DIR = process.env.ASSISTANT_DIR
  ? path.resolve(process.env.ASSISTANT_DIR)
  : path.join(__dirname, '..', '..', 'data', 'assistant');

function file() {
  return process.env.ASSISTANT_AUDIT_FILE
    ? path.resolve(process.env.ASSISTANT_AUDIT_FILE)
    : path.join(BASE_DIR, 'audit.jsonl');
}

function record(entry = {}) {
  const at = new Date().toISOString();
  const item = {
    version: AUDIT_VERSION,
    at,
    actor: String(entry.actor || 'local').slice(0, 80),
    kind: String(entry.kind || 'unknown').slice(0, 40),
    action: String(entry.action || '').slice(0, 120),
    target: entry.target === undefined ? null : redactText(typeof entry.target === 'string' ? entry.target : JSON.stringify(entry.target)),
    before: entry.before === undefined ? null : redactDeep(entry.before),
    after: entry.after === undefined ? null : redactDeep(entry.after),
    note: entry.note === undefined ? null : redactText(String(entry.note)).slice(0, 400)
  };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.appendFileSync(file(), JSON.stringify(item) + '\n', 'utf8');
    return { ok: true, entry: item };
  } catch (e) {
    // 审计写失败不能拖垮设置/修复主流程，但必须把失败暴露给调用方与日志。
    try { console.warn('[assistant] 审计写入失败:', e && e.message); } catch (e2) { /* ignore */ }
    return { ok: false, code: 'AUDIT_WRITE_FAILED', error: (e && e.message) || String(e), entry: item };
  }
}

function list(opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  const kind = opts.kind ? String(opts.kind) : null;
  let raw = '';
  try { raw = fs.readFileSync(file(), 'utf8'); } catch (e) { return []; }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    let item = null;
    try { item = JSON.parse(lines[i]); } catch (e) { item = null; }
    if (!item) continue;
    if (kind && item.kind !== kind) continue;
    // 读取时再脱敏一次：即使历史文件的写入方是老版本/第三方，也不回显敏感串。
    out.push({ ...item, target: item.target == null ? null : redactText(String(item.target)), note: item.note == null ? null : redactText(String(item.note)) });
  }
  return out;
}

function count() {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    return raw.split(/\r?\n/).filter((l) => l.trim()).length;
  } catch (e) {
    return 0;
  }
}

module.exports = { AUDIT_VERSION, file, record, list, count };
