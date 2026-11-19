// ==========================================
// 小智 · agent 回合审计（2026-11-19 B 目标）
// ------------------------------------------------------------
// 为什么：真实模型接入后，出问题要能回答「哪一轮、什么模式、选了哪个工具、多慢、
// 为什么回退」。交接三阶推演要求「每次回复落审计（意图/工具/模型/延迟/prompt 版本），可回放」。
// 本模块只做追加写，不影响主链路：任何失败都返回 {ok:false}，绝不抛异常。
//
// 隐私/体积：
//   · **不写 Key / baseUrl 凭据**，只写模型名；
//   · 用户话只存 120 字预览（会话文件里本来就有全文）；
//   · 文件超过上限自动轮转为 <file>.1（只保留上一份）。
// ==========================================
'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_VERSION = 'assistant-agent-audit.v1';
const BASE_DIR = process.env.ASSISTANT_DIR
  ? path.resolve(process.env.ASSISTANT_DIR)
  : path.join(__dirname, '..', '..', 'data', 'assistant');
const AUDIT_FILE = process.env.ASSISTANT_AGENT_AUDIT_FILE
  ? path.resolve(process.env.ASSISTANT_AGENT_AUDIT_FILE)
  : path.join(BASE_DIR, 'agent-audit.jsonl');
const MAX_BYTES = Math.max(64 * 1024, Number(process.env.ASSISTANT_AGENT_AUDIT_MAX_BYTES) || 4 * 1024 * 1024);

function textPreview(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 追加一条审计。绝不抛异常。 */
function record(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    try {
      const st = fs.statSync(AUDIT_FILE);
      if (st.size > MAX_BYTES) {
        const rotated = AUDIT_FILE + '.1';
        try { fs.rmSync(rotated, { force: true }); } catch (e) { /* 忽略 */ }
        fs.renameSync(AUDIT_FILE, rotated);
      }
    } catch (e) { /* 文件不存在 = 首次写 */ }
    const row = {
      version: AUDIT_VERSION,
      at: new Date().toISOString(),
      ...entry,
      textPreview: entry && entry.text !== undefined ? textPreview(entry.text) : undefined
    };
    delete row.text;
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + '\n');
    return { ok: true, file: AUDIT_FILE };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 读最近 limit 条（文件顺序，旧→新；坏行跳过）。 */
function list(limit = 20) {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch (e) { /* 坏行跳过 */ }
    }
    return out.slice(-Math.max(1, Number(limit) || 20));
  } catch (e) {
    return [];
  }
}

module.exports = {
  AUDIT_VERSION,
  AUDIT_FILE,
  MAX_BYTES,
  textPreview,
  record,
  list
};
