// ==========================================
// 小智 · agent 总开关（2026-11-19 B 目标）
// ------------------------------------------------------------
// 目标里的「一键关回规则路径」：设置页开关 → **下一条消息立即生效**，不需要重启。
// 优先级（写死，防歧义）：
//   1) 环境变量 ASSISTANT_AGENT=on  → 强制开（部署级）
//   2) 环境变量 ASSISTANT_AGENT=off → 强制关（部署级）
//   3) 未设置 → 持久化开关（默认关）
// 持久化位置：ASSISTANT_DIR/agent-switch.json
// （测试可用 ASSISTANT_AGENT_SWITCH_FILE 覆盖；本机单实例，外部改文件需重启才生效。）
// ==========================================
'use strict';

const fs = require('fs');
const path = require('path');

const SWITCH_VERSION = 'assistant-agent-switch.v1';
const BASE_DIR = process.env.ASSISTANT_DIR
  ? path.resolve(process.env.ASSISTANT_DIR)
  : path.join(__dirname, '..', '..', 'data', 'assistant');
const SWITCH_FILE = process.env.ASSISTANT_AGENT_SWITCH_FILE
  ? path.resolve(process.env.ASSISTANT_AGENT_SWITCH_FILE)
  : path.join(BASE_DIR, 'agent-switch.json');

let state = { enabled: false, updatedAt: null, updatedBy: null };

function envOverride() {
  const v = String(process.env.ASSISTANT_AGENT || '').trim().toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  return null;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(SWITCH_FILE, 'utf8'));
    state = {
      enabled: j.enabled === true,
      updatedAt: j.updatedAt || null,
      updatedBy: j.updatedBy || null
    };
  } catch (e) {
    // 文件不存在/坏 → 保持默认关（不因读不到开关而意外打开）
  }
}
load();

function getState() {
  const env = envOverride();
  return {
    version: SWITCH_VERSION,
    enabled: env === null ? state.enabled : env,
    persisted: state.enabled,
    envForced: env !== null,
    envValue: env === null ? null : (env ? 'on' : 'off'),
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
    switchFile: SWITCH_FILE
  };
}

/**
 * 设置持久化开关。返回结构直接给 HTTP 用。
 * @param {boolean} enabled
 * @param {{by?:string}} opts
 */
function setEnabled(enabled, opts = {}) {
  const next = enabled === true;
  state = {
    enabled: next,
    updatedAt: new Date().toISOString(),
    updatedBy: opts.by ? String(opts.by) : 'local'
  };
  try {
    fs.mkdirSync(path.dirname(SWITCH_FILE), { recursive: true });
    const tmp = SWITCH_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ version: SWITCH_VERSION, ...state }, null, 2));
    fs.renameSync(tmp, SWITCH_FILE);
    return { ok: true, ...getState(), fileError: null };
  } catch (e) {
    return {
      ok: false,
      code: 'AGENT_SWITCH_WRITE_FAILED',
      error: '开关已生效但落盘失败：' + (e && e.message ? e.message : e),
      ...getState()
    };
  }
}

function reload() {
  load();
  return getState();
}

module.exports = {
  SWITCH_VERSION,
  SWITCH_FILE,
  isEnabled: () => getState().enabled,
  getState,
  setEnabled,
  reload
};
