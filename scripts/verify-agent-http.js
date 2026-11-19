#!/usr/bin/env node
// ==========================================
// 手动验收：小智 agent · HTTP live（需**已重启的** 3001 服务）
// ------------------------------------------------------------
// 与 verify-assistant-http.js 同类：需要真实服务 + 登录态，**不进 verify-all 门禁**。
// 覆盖（全部零计费：不传 LLM Key → agent 立即失败并回退，不发网络请求）：
//   ① 未登录 GET /api/assistant/agent → 401 AUTH_REQUIRED
//   ② 登录 → GET 开关（enabled/envForced 布尔）
//   ③ POST 非法 body → 400 AGENT_SWITCH_BAD_BODY
//   ④ 关闭开关 → 聊天走规则路径（1080p → plan_edit + 问时长）
//   ⑤ 打开开关但**不传 Key** → agent 失败 → 回退规则路径（响应无 agent 字段、<1500ms）
//   ⑥ 收尾关回开关
//
// 用法：
//   node scripts/verify-agent-http.js --cred-file C:\path\cred.json [--base http://127.0.0.1:3001]
// cred.json: {"username":"...","password":"..."}
// 退出码 0=全过；1=有失败；2=环境不满足（服务未重启/未登录/开关被 env 强制）。
// ==========================================
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = String(arg('--base', 'http://127.0.0.1:3001')).replace(/\/+$/, '');
const CRED = arg('--cred-file', '');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}

let cred = null;
if (CRED) {
  try { cred = JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch (e) {
    console.error('读不了 cred-file: ' + (e && e.message ? e.message : e));
  }
}
if (!cred || !cred.username || !cred.password) {
  console.error('需要 --cred-file（JSON {username,password}）');
  process.exit(2);
}

let cookie = '';
async function req(pathname, opt = {}) {
  const headers = { ...(opt.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(BASE + pathname, { ...opt, headers });
  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const m = /^vs_session=([^;]+)/.exec(c);
    if (m) cookie = 'vs_session=' + m[1];
  }
  let json = null;
  try { json = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json };
}
const post = (pathname, body) => req(pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

(async () => {
  console.log('小智 agent · HTTP live 验收（零计费；需已重启的 ' + BASE + '）\n');
  const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  const unauth = await req('/api/assistant/agent');
  ok('① 未登录 GET 开关 → 401 AUTH_REQUIRED',
    unauth.status === 401 && unauth.json && unauth.json.code === 'AUTH_REQUIRED',
    `HTTP ${unauth.status}`);

  const login = await post('/api/auth/login', { username: cred.username, password: cred.password });
  ok('② 登录成功', !!login.json && login.json.ok === true, `HTTP ${login.status}`);
  if (!login.json || login.json.ok !== true) {
    console.error('\n登录失败，无法继续（检查凭据/服务是否已重启）。');
    process.exit(2);
  }

  const st = await req('/api/assistant/agent');
  ok('③ GET 开关：ok + enabled/envForced 都是布尔',
    st.status === 200 && st.json && st.json.ok === true
    && typeof st.json.enabled === 'boolean' && typeof st.json.envForced === 'boolean',
    st.json ? JSON.stringify(st.json).slice(0, 120) : `HTTP ${st.status}`);
  if (st.json && st.json.envForced) {
    console.error('\n当前 ASSISTANT_AGENT 被环境变量强制（' + st.json.envValue + '），无法验证开关生效——请先去掉环境变量再重启。');
    process.exit(2);
  }

  const bad = await post('/api/assistant/agent', { enabled: 'yes' });
  ok('④ POST 非法 body → 400 AGENT_SWITCH_BAD_BODY',
    bad.status === 400 && bad.json && bad.json.code === 'AGENT_SWITCH_BAD_BODY',
    `HTTP ${bad.status}`);

  const off = await post('/api/assistant/agent', { enabled: false });
  ok('⑤ 关闭开关 → enabled=false', off.status === 200 && off.json && off.json.ok && off.json.enabled === false);

  const sid1 = 'live-http-off-' + stamp();
  const offMsg = await post('/api/assistant/message', { sessionId: sid1, text: '1080p' });
  ok('⑥ 关闭时聊天走规则路径（1080p → intent=plan_edit + 问时长）',
    offMsg.status === 200 && offMsg.json && offMsg.json.ok === true
    && offMsg.json.intent === 'plan_edit' && /要做多长|总时长/.test(offMsg.json.reply || '')
    && !offMsg.json.agent,
    offMsg.json ? `intent=${offMsg.json.intent}` : `HTTP ${offMsg.status}`);

  const on = await post('/api/assistant/agent', { enabled: true });
  ok('⑦ 打开开关 → enabled=true', on.status === 200 && on.json && on.json.ok && on.json.enabled === true);

  const sid2 = 'live-http-on-' + stamp();
  const t0 = Date.now();
  // 故意不传 llmApiKey：agent 应 NO_KEY → 回退规则路径，且不发任何网络请求（零计费）
  const onMsg = await post('/api/assistant/message', { sessionId: sid2, text: '1080p' });
  const ms = Date.now() - t0;
  ok('⑧ 打开但无 Key → agent 失败并回退规则路径（无 agent 字段、仍问时长）',
    onMsg.status === 200 && onMsg.json && onMsg.json.ok === true
    && onMsg.json.intent === 'plan_edit'
    && !onMsg.json.agent
    && /要做多长|总时长/.test(onMsg.json.reply || ''),
    onMsg.json ? `intent=${onMsg.json.intent}` : `HTTP ${onMsg.status}`);
  ok('⑨ 回退足够快（无 Key 不发网络请求，<1500ms）', ms < 1500, ms + 'ms');

  const off2 = await post('/api/assistant/agent', { enabled: false });
  ok('⑩ 收尾：关回规则路径', off2.status === 200 && off2.json && off2.json.ok && off2.json.enabled === false);

  console.log('\n================================================================');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('================================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('\n验收异常: ' + (e && e.message ? e.message : e));
  console.log('（如果端点是 404，说明服务还没重启到新代码。）');
  process.exit(1);
});
