// ============================================================
// verify-pages.js —— 页面与「自动配乐草稿」接口自检
// ------------------------------------------------------------
// 2026-10-27 重写。旧版两个硬伤（实测已复现）：
//   1) 打固定 http://127.0.0.1:3001，而正式服务有登录墙：
//      fetch 默认跟随 302 → 拿到登录页（10317B）并因 t.length>1000 判 PASS，
//      于是 4 个不同页面报出同一个字节数，全是假绿；
//   2) 自动配乐用例写死 task_mv4v7qp2_m8r0，换机器/换库必然 FAIL，
//      那是「没有这个任务」，不是代码坏了。
// 现在：自己起临时服务（AUTH_ENABLED=false / DATABASE_TYPE=json），
// 逐页核对「页面专属标记」并显式拒绝登录页；任务 id 从数据里动态取。
// ============================================================
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.BGM_TEST_PORT || 3099);
const MAX_TRIES = 6;

// 页面 → 该页独有的标记（用来区分「真的拿到了这个页面」和「拿到了登录页」）
const PAGES = [
  ['/', 'class="app-layout"'],
  ['/bgm-editor.html', 'id="editorView"'],
  ['/music-library.html', 'id="trackList"'],
  ['/clip-library.html', 'id="resTabs"'],
];
const LOGIN_MARKER = 'id="loginForm"';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(url, ms = 800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return r.status;
  } catch { return 0; }
  finally { clearTimeout(timer); }
}

function spawnServer(port) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), AUTH_ENABLED: 'false', DATABASE_TYPE: 'json' },
    stdio: 'ignore',       // 沙箱里 pipe 会 EPERM，必须 ignore
    windowsHide: true,
  });
}

async function waitReady(base, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping(base + '/api/status')) return true;
    await sleep(400);
  }
  return false;
}

(async () => {
  let fail = 0;
  let skip = 0;
  const check = (ok, msg) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + msg); if (!ok) fail++; };
  const skipped = (msg) => { console.log('  SKIP  ' + msg); skip++; };

  // 1) 找空闲端口起临时服务
  let child = null;
  let base = null;
  for (let i = 0; i < MAX_TRIES && !child; i++) {
    const port = START_PORT + i;
    const candidate = `http://${HOST}:${port}`;
    if (await ping(candidate + '/api/status')) continue;   // 已被占用，换下一个
    const c = spawnServer(port);
    c.on('error', () => {});
    if (await waitReady(candidate)) { child = c; base = candidate; }
    else { try { c.kill(); } catch { /* ignore */ } }
  }
  if (!child) {
    console.error(`无法启动临时服务（端口 ${START_PORT}..${START_PORT + MAX_TRIES - 1} 均不可用）`);
    process.exit(2);
  }

  const stop = () => { try { child.kill(); } catch { /* ignore */ } };
  process.on('exit', stop);
  console.log(`临时服务: ${base}  (AUTH_ENABLED=false, DATABASE_TYPE=json)\n`);

  try {
    // 2) 页面：状态码 + 页面标记 + 排除登录页
    for (const [p, marker] of PAGES) {
      const r = await fetch(base + p, { redirect: 'manual' });
      const body = await r.text();
      const isLogin = body.includes(LOGIN_MARKER);
      const hasMarker = body.includes(marker);
      check(
        r.status === 200 && hasMarker && !isLogin,
        `GET ${p} -> ${r.status} ${body.length}B` +
          (hasMarker ? '' : ` [缺页面标记 ${marker}]`) +
          (isLogin ? ' [命中登录页，不是目标页面]' : '')
      );
    }

    // 3) 自动配乐草稿：从真实数据里取一条已完成任务，不写死 id
    const completed = await (await fetch(base + '/api/tasks/completed')).json().catch(() => ({}));
    const list = (completed && completed.tasks) || [];
    const t = list[0];
    if (!t) {
      skipped('自动配乐草稿：json 存储下没有已完成任务（数据依赖，不计入通过）');
    } else {
      const r = await fetch(
        base + '/api/tasks/' + encodeURIComponent(t.taskId) + '/bgm-auto-plan',
        { method: 'POST' }
      );
      const j = await r.json().catch(() => ({}));
      const n = (j.plan && Array.isArray(j.plan.music)) ? j.plan.music.length : 0;
      check(r.ok && j.ok === true && n > 0, `自动配乐草稿(${t.taskId}) -> ${r.status} 段数=${n}`);
    }
  } finally {
    stop();
  }

  console.log('\n' + (fail ? `FAIL ${fail}` : '全部通过') + (skip ? `（跳过 ${skip} 项，跳过不等于通过）` : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
