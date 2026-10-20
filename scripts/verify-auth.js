#!/usr/bin/env node
// ==========================================
// 验收：登录墙（src/auth.js + server.js 鉴权中间件 + wsManager 握手鉴权）
// ==========================================
// 为什么必须存在：AGENTS.md §5.1 要求「缺陷类/安全类改动必须有负向证据」。
// 只截一张登录页的图，证明不了未登录真的进不去。这个脚本用真服务、真 cookie、
// 真 WebSocket 握手逐条断言，任何一条不成立就退出码非 0。
//
// 用法：cd app && node scripts/verify-auth.js
//
// 环境隔离：用 DATABASE_TYPE=json 起临时服务，账号写进 data/users.json；
// 测试账号统一用 verify_ 前缀，跑完把带前缀的账号从文件里删掉，不动真实账号。
// ==========================================

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const USERS_FILE = path.join(APP_DIR, 'data', 'users.json');
const PORT_A = 3199;
const PORT_B = 3198;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

const ADMIN = { username: 'verify_admin', password: 'Verify#2026' };
const USER1 = { username: 'verify_user1', password: 'User1#2026' };
const PREFIX = 'verify_';

let pass = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.error('  \u2717 ' + name + (detail ? ' — ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== 起服务 =====

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_TYPE: 'json',        // 隔离：不看 .env 的 postgres
      AUTH_ENABLED: 'true',
      AUTH_USER: ADMIN.username,
      AUTH_PASSWORD: ADMIN.password,
      AUTH_SESSION_HOURS: '8',
      AUTH_MAX_FAILS: '5',
      AUTH_LOCK_MINUTES: '5',
      ...extraEnv
    },
    // 不用管道 stdio：受限环境（含本项目所在的 DSH 沙箱）禁止管道，会 EPERM。
    // 服务端自己会把日志写进 data/logs/server-*.log，调试信息不会丢。
    stdio: 'ignore'
  });
  return child;
}

async function waitReady(base, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + '/api/status');
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

function stopServer(child, port) {
  try { child.kill(); } catch (e) { /* ignore */ }
  // Windows 上子进程可能残留，按端口兜底清理
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    );
  } catch (e) { /* ignore */ }
}

// ===== HTTP 小工具 =====

async function request(base, pathname, opts = {}) {
  const r = await fetch(base + pathname, {
    redirect: 'manual',
    ...opts
  });
  let body = null;
  const text = await r.text();
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { status: r.status, headers: r.headers, body, setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [] };
}

function jsonHeaders() {
  return { 'content-type': 'application/json', accept: 'application/json' };
}

function cookieOf(res) {
  const list = res.setCookie || [];
  const raw = list.find(c => c.startsWith('vs_session='));
  return raw ? raw.split(';')[0] : null;
}

async function login(base, username, password) {
  return request(base, '/api/auth/login', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ username, password })
  });
}

// ===== 主流程 =====

async function main() {
  console.log('='.repeat(60));
  console.log('验收：登录墙');
  console.log('='.repeat(60));

  // 记录运行前的 users.json，跑完按前缀清理
  const usersExistedBefore = fs.existsSync(USERS_FILE);

  const serverA = startServer(PORT_A, {});
  let serverB = null;

  try {
    const ready = await waitReady(BASE_A);
    if (!ready) {
      console.error('\n服务未能启动（' + BASE_A + '），本次验收无效');
      stopServer(serverA, PORT_A);
      process.exit(1);
    }

    // ---------- 1. 未登录拦截 ----------
    section('[1] 未登录时的拦截');

    const pageRes = await request(BASE_A, '/');
    ok('访问 / → 302 重定向到登录页',
      pageRes.status === 302 && String(pageRes.headers.get('location') || '').includes('/login.html'),
      `status=${pageRes.status} location=${pageRes.headers.get('location')}`);

    const apiRes = await request(BASE_A, '/api/tasks');
    ok('访问 /api/tasks → 401',
      apiRes.status === 401,
      `status=${apiRes.status}`);
    ok('401 响应带 AUTH_REQUIRED 标记',
      apiRes.body && apiRes.body.code === 'AUTH_REQUIRED',
      JSON.stringify(apiRes.body));

    const loginPage = await request(BASE_A, '/login.html');
    ok('登录页本身可访问（不能 302 成死循环）', loginPage.status === 200, `status=${loginPage.status}`);

    const statusRes = await request(BASE_A, '/api/status');
    ok('/api/status 放行（Docker HEALTHCHECK 依赖它）', statusRes.status === 200, `status=${statusRes.status}`);

    // ---------- 2. 密码错误 ----------
    section('[2] 密码错误');

    const bad = await login(BASE_A, ADMIN.username, 'definitely-wrong');
    ok('错误密码 → 401', bad.status === 401, `status=${bad.status}`);
    const badText = JSON.stringify(bad.body || '');
    ok('错误提示不泄露账号是否存在',
      badText.includes('账号或密码错误') && !badText.includes('不存在'),
      badText);

    // ---------- 3. 登录成功 ----------
    section('[3] 登录成功与会话');

    const good = await login(BASE_A, ADMIN.username, ADMIN.password);
    ok('正确密码 → 200', good.status === 200, `status=${good.status}`);
    const cookie = cookieOf(good);
    ok('返回 vs_session cookie', !!cookie, String(cookie));
    const rawCookie = (good.setCookie || []).find(c => c.startsWith('vs_session=')) || '';
    ok('cookie 是 HttpOnly', /HttpOnly/i.test(rawCookie), rawCookie);
    ok('cookie 是 SameSite=Lax', /SameSite=Lax/i.test(rawCookie), rawCookie);
    ok('cookie 没有 Max-Age/Expires（关浏览器即失效）',
      !/Max-Age/i.test(rawCookie) && !/Expires/i.test(rawCookie), rawCookie);

    const me = await request(BASE_A, '/api/auth/me', { headers: { cookie } });
    ok('带 cookie 访问 /api/auth/me → 200 且账号正确',
      me.status === 200 && me.body && me.body.username === ADMIN.username,
      `status=${me.status} body=${JSON.stringify(me.body)}`);

    const tasks = await request(BASE_A, '/api/tasks', { headers: { cookie } });
    ok('带 cookie 访问 /api/tasks → 200', tasks.status === 200, `status=${tasks.status}`);

    const tampered = cookie ? cookie.slice(0, -4) + 'dead' : 'vs_session=deadbeef';
    const tamperedRes = await request(BASE_A, '/api/tasks', { headers: { cookie: tampered } });
    ok('篡改后的 cookie → 401', tamperedRes.status === 401, `status=${tamperedRes.status}`);

    // ---------- 4. WebSocket 握手 ----------
    section('[4] WebSocket 握手鉴权');

    const WebSocket = require('ws');
    const wsNoCookie = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT_A}/ws`);
      let done = false;
      const finish = (r) => { if (!done) { done = true; try { ws.terminate(); } catch (e) {} resolve(r); } };
      ws.on('open', () => finish('open'));
      ws.on('error', (e) => finish('error:' + String(e && e.message || e)));
      ws.on('unexpected-response', () => finish('error:401'));
      setTimeout(() => finish('timeout'), 6000);
    });
    ok('未登录连 /ws → 握手被拒', wsNoCookie !== 'open', wsNoCookie);

    const wsWithCookie = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT_A}/ws`, { headers: { cookie: cookie || '' } });
      let done = false;
      const finish = (r) => { if (!done) { done = true; try { ws.terminate(); } catch (e) {} resolve(r); } };
      ws.on('open', () => finish('open'));
      ws.on('error', (e) => finish('error:' + String(e && e.message || e)));
      setTimeout(() => finish('timeout'), 6000);
    });
    ok('登录后连 /ws → 握手成功', wsWithCookie === 'open', wsWithCookie);

    // ---------- 5. 成员管理 ----------
    section('[5] 成员管理（多账号、平权）');

    const usersList = await request(BASE_A, '/api/users', { headers: { cookie } });
    ok('GET /api/users → 200', usersList.status === 200, `status=${usersList.status}`);
    ok('账号列表不含 passwordHash（哈希绝不出后端）',
      !JSON.stringify(usersList.body || {}).includes('passwordHash'),
      JSON.stringify(usersList.body).slice(0, 200));
    ok('列表里有引导创建的管理员',
      (usersList.body.users || []).some(u => u.username === ADMIN.username),
      JSON.stringify((usersList.body.users || []).map(u => u.username)));

    const weak = await request(BASE_A, '/api/users', {
      method: 'POST', headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ username: 'verify_weak', password: '123' })
    });
    ok('密码太短 → 400', weak.status === 400, `status=${weak.status}`);

    const created = await request(BASE_A, '/api/users', {
      method: 'POST', headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ username: USER1.username, password: USER1.password })
    });
    ok('新建账号 → 201', created.status === 201, `status=${created.status}`);

    const dup = await request(BASE_A, '/api/users', {
      method: 'POST', headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ username: USER1.username, password: USER1.password })
    });
    ok('重复账号 → 409', dup.status === 409, `status=${dup.status}`);

    const login1 = await login(BASE_A, USER1.username, USER1.password);
    ok('新账号能登录 → 200', login1.status === 200, `status=${login1.status}`);
    const cookie1 = cookieOf(login1);
    ok('新账号拿到独立会话', !!cookie1 && cookie1 !== cookie, String(cookie1));

    // ---------- 6. 改密码 ----------
    section('[6] 重置密码');

    const reset = await request(BASE_A, `/api/users/${created.body.user.id}/password`, {
      method: 'PUT', headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ password: 'User1#2026new' })
    });
    ok('重置密码 → 200', reset.status === 200, `status=${reset.status}`);

    const oldPwd = await login(BASE_A, USER1.username, USER1.password);
    ok('旧密码失效 → 401', oldPwd.status === 401, `status=${oldPwd.status}`);

    const kicked = await request(BASE_A, '/api/auth/me', { headers: { cookie: cookie1 } });
    ok('改密后该账号的旧会话被踢下线 → 401', kicked.status === 401, `status=${kicked.status}`);

    const newPwd = await login(BASE_A, USER1.username, 'User1#2026new');
    ok('新密码可登录 → 200', newPwd.status === 200, `status=${newPwd.status}`);
    const cookie1b = cookieOf(newPwd) || '';

    // ---------- 7. 删除保护 ----------
    section('[7] 删除账号的边界');

    const meId = me.body && me.body.userId;
    const delSelf = await request(BASE_A, `/api/users/${meId}`, {
      method: 'DELETE', headers: { cookie }
    });
    ok('不能删除自己 → 400', delSelf.status === 400, `status=${delSelf.status}`);

    const delOther = await request(BASE_A, `/api/users/${created.body.user.id}`, {
      method: 'DELETE', headers: { cookie }
    });
    ok('删除其他账号 → 200', delOther.status === 200, `status=${delOther.status}`);

    const gone = await login(BASE_A, USER1.username, 'User1#2026new');
    ok('被删账号无法再登录 → 401', gone.status === 401, `status=${gone.status}`);

    const afterCookie = await request(BASE_A, '/api/tasks', { headers: { cookie: cookie1b } });
    ok('被删账号的会话立即失效 → 401', afterCookie.status === 401, `status=${afterCookie.status}`);

    // ---------- 8. 登出 ----------
    section('[8] 登出');

    const logout = await request(BASE_A, '/api/auth/logout', { method: 'POST', headers: { cookie } });
    ok('登出 → 200', logout.status === 200, `status=${logout.status}`);
    const logoutCookieRaw = (logout.setCookie || []).find(c => c.startsWith('vs_session=')) || '';
    ok('登出时清空 cookie（Max-Age=0）', /Max-Age=0/i.test(logoutCookieRaw), logoutCookieRaw);

    const afterLogout = await request(BASE_A, '/api/tasks', { headers: { cookie } });
    ok('登出后旧 cookie 失效 → 401', afterLogout.status === 401, `status=${afterLogout.status}`);

    // ---------- 9. 失败锁定 ----------
    section('[9] 失败锁定（防爆破）');

    let lockedStatus = 0;
    let lockedBody = null;
    for (let i = 0; i < 6; i++) {
      const r = await login(BASE_A, ADMIN.username, 'wrong-' + i);
      if (r.status === 429) { lockedStatus = r.status; lockedBody = r.body; break; }
      lockedStatus = r.status;
    }
    ok('连续输错后返回 429 锁定', lockedStatus === 429, `last status=${lockedStatus} body=${JSON.stringify(lockedBody)}`);

    // 锁定期间即便密码正确也应被挡住（锁的是来源 IP，不是账号）
    const lockedButCorrect = await login(BASE_A, ADMIN.username, ADMIN.password);
    ok('锁定期间正确密码也进不来 → 429', lockedButCorrect.status === 429, `status=${lockedButCorrect.status}`);

    // ---------- 10. AUTH_ENABLED=false 逃生开关 ----------
    section('[10] AUTH_ENABLED=false（验收脚本兼容开关）');

    serverB = startServer(PORT_B, { AUTH_ENABLED: 'false' });
    const readyB = await waitReady(BASE_B, 25000);
    if (!readyB) {
      ok('第二个服务（AUTH_ENABLED=false）启动', false, '服务未起来');
    } else {
      const openApi = await request(BASE_B, '/api/tasks');
      ok('关掉登录墙后 /api/tasks 无需 cookie → 200', openApi.status === 200, `status=${openApi.status}`);
      const openPage = await request(BASE_B, '/');
      ok('关掉登录墙后 / 直接返回页面 → 200', openPage.status === 200, `status=${openPage.status}`);
    }
  } catch (e) {
    console.error('\n验收过程抛错：', e && e.stack || e);
    failures.push('脚本异常：' + (e && e.message));
  } finally {
    stopServer(serverA, PORT_A);
    if (serverB) stopServer(serverB, PORT_B);
    cleanupTestUsers(usersExistedBefore);
  }

  // ===== 汇总 =====
  console.log('\n' + '='.repeat(60));
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('='.repeat(60));
    process.exit(1);
  }
  console.log('登录墙验收全部通过');
  console.log('='.repeat(60));
  process.exit(0);
}

/** 只删除本脚本创建的 verify_ 前缀账号，绝不碰真实账号 */
function cleanupTestUsers(usersExistedBefore) {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const all = JSON.parse(raw);
    const kept = all.filter(u => !String(u.username || '').startsWith(PREFIX));
    if (kept.length === all.length) return;
    if (kept.length === 0) {
      fs.unlinkSync(USERS_FILE);
      console.log(`\n[cleanup] 已删除测试账号并移除 ${path.relative(APP_DIR, USERS_FILE)}`);
    } else {
      fs.writeFileSync(USERS_FILE, JSON.stringify(kept, null, 2), 'utf8');
      console.log(`\n[cleanup] 已删除 ${all.length - kept.length} 个测试账号，保留 ${kept.length} 个真实账号`);
    }
  } catch (e) {
    console.error('[cleanup] 清理测试账号失败（可手动删除 data/users.json 里的 verify_* 账号）:', e.message);
  }
}

main();
