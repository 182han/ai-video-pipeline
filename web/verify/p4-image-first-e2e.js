// ============================================================
// P4 本轮（2026-11-16）真浏览器端到端验收：小智逐段出图 + 审图暂停 + 图片审核页调色滑杆
// ------------------------------------------------------------
// 背景：本轮改了两个前端功能区，静态断言证明不了「点得动、显示得对」：
//   A. 小智计划卡：逐段出图开关（默认开）、真实计费单价来自 /api/assistant/info、
//      确认执行请求体带 imagePerClip + 5 个图片字段、「图已出好」卡片 + 继续生成
//   B. 库 · 图片：手动调色四条滑杆（亮度/对比度/饱和度/色温）、CSS 即时预览、
//      应用（POST /api/photos/:id/adjust）、恢复原图（reset:true）、错误原文显示、cache-busting
//
// 做法（沿用 web/verify/p2-library-e2e.js 的先例）：
//   1) 连接**已经在跑的** 3001 单实例（绝不另起服务/端口）；
//   2) headless Chrome + CDP 打开 /app，页面内 POST /api/auth/login
//      （账号密码运行时从 app/config.js 读取，不打印、不入库、不落盘）；
//   3) 需要「花钱/写数据」的接口在**浏览器内用 fetch stub 拦截**：
//      - /api/assistant/execute（真实计费）→ 只捕获请求体，返回假响应，不发真实请求
//      - /api/assistant/state（轮询）→ 按用例返回「审图暂停」/「生成中」
//      - /api/tasks/:id/unpause → 捕获调用，返回 {success:true, approvedPhotos:3}
//      - /api/photos/:id/adjust → 捕获请求体，返回假 photo（不写真实图片库）
//      /api/assistant/info 做「补字段」拦截：当前 3001 是旧进程（无 image 段），
//      这里按契约 §3.2 补上 image.unitCny 再返回，用来看前端是否真的用后端单价；
//      真实 info.image 由 scripts/verify-image-first-http.js 在隔离实例上验。
//   4) 截图落 app/docs/交接/p4-screenshots/ 供人工看视觉；
//   5) 不建任务、不出图、不调色真实图片、不改任何真实数据。
//
// 用法：cd app && node web/verify/p4-image-first-e2e.js
// 退出码 0 = 全部通过；非 0 = 有失败（"未验证"不会被算成通过）。
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..');
const OUT = path.join(APP, 'docs', '交接', 'p4-screenshots');
const BASE = 'http://127.0.0.1:3001';
// 固定调试端口会在「上一轮 Chrome 没退干净」时踩到：/json/list 拿到旧实例的空白 target 列表，
// 表现为「Chrome 已启动但没有 page target」。改成每次挑一个空闲端口。
let DEBUG_PORT = 0;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; failures.push({ label, extra }); console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 挑一个没人在听的本地端口（同步探测：能 listen 成功就是空闲，立刻关闭）
function pickFreePort(start = 9471, end = 9511) {
  for (let p = start; p < end; p++) {
    const srv = net.createServer();
    try {
      srv.listen(p, '127.0.0.1');
      srv.close();
      return p;
    } catch (e) {
      try { srv.close(); } catch (e2) { /* ignore */ }
    }
  }
  return start;
}

// 杀掉我们 spawn 出来的 Chrome 整棵进程树（Windows 上 kill() 只结束父进程，
// 子进程会占着调试端口 → 下一轮「没有 page target」）。只杀自己的 pid。
function killChromeTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (e) { /* 已经退出就算了 */ }
}

function wsConnect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
    }, 20000);
  });
  return { ws, send, events, opened, close: () => { try { ws.close(); } catch (e) { /* ignore */ } } };
}

// 页面内：装 / 换 stub。单独成常量，便于失败时排查。
const INSTALL_STUB = `(() => {
  if (window.__e2e && window.__e2e.installed) return true;
  const e2e = {
    installed: true,
    calls: [],
    lastExecute: null,
    lastAdjust: null,
    stateMode: 'running',   // running | review
    adjustMode: 'ok',       // ok | fail
    curUrl: '',
    infoStubCount: 0
  };
  window.__e2e = e2e;
  const orig = window.fetch.bind(window);
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
  window.fetch = async function (input, init) {
    const url = (typeof input === 'string') ? input : ((input && input.url) || '');
    const opts = init || {};
    try {
      if (url.includes('/api/assistant/info')) {
        const r = await orig(input, init);
        const j = await r.json();
        // 当前 3001 是旧进程：按契约 §3.2 补 image 段（真实字段由隔离实例验收）
        if (!j.image) {
          j.image = {
            usable: false, provider: 'dashscope', model: 'wan2.7-image',
            size: '1696*960', unitCny: 0.2, unitLabel: 'wan2.7-image ¥0.20/张', hasServerKey: false
          };
        }
        e2e.infoStubCount++;
        return json(j, r.status);
      }
      if (url.includes('/api/assistant/execute')) {
        let body = {};
        try { body = JSON.parse(opts.body || '{}'); } catch (e) { body = {}; }
        e2e.lastExecute = body;
        e2e.calls.push({ kind: 'execute', body });
        return json({
          ok: true,
          reply: '【E2E 拦截】已开始（未发真实请求）',
          taskId: 'task_e2e_image_first',
          state: { state: 'running', label: '生成中', retries: 0, retryAllowed: 2, fills: 0, fillAllowed: 3 }
        });
      }
      if (url.includes('/api/assistant/state')) {
        e2e.calls.push({ kind: 'state' });
        const base = {
          ok: true,
          state: { state: 'running', label: '生成中', retries: 0, retryAllowed: 2, fills: 0, fillAllowed: 3 },
          plan: null
        };
        if (e2e.stateMode === 'review') {
          base.task = {
            taskId: 'task_e2e_image_first',
            status: 'paused',
            currentStep: '等待审图：已出 3 张（待审 3 / 失败 0）',
            totalClips: 3, successClips: 0, failedClips: 0,
            awaitingImageReview: true,
            imageReview: {
              total: 3, generated: 3, reused: 0, failed: 0,
              pendingPhotos: 3, approvedPhotos: 0, rejectedPhotos: 0, reviewedAt: null
            }
          };
        } else {
          base.task = {
            taskId: 'task_e2e_image_first',
            status: 'generating',
            currentStep: '视频片段生成',
            totalClips: 3, successClips: 0, failedClips: 0,
            awaitingImageReview: false,
            imageReview: { total: 3, generated: 3, failed: 0, pendingPhotos: 3, approvedPhotos: 0, rejectedPhotos: 0 }
          };
        }
        return json(base);
      }
      if (/\\/api\\/tasks\\/[^/]+\\/unpause/.test(url)) {
        e2e.calls.push({ kind: 'unpause', url, method: opts.method || 'GET' });
        return json({ success: true, approvedPhotos: 3, rejectedClips: [] });
      }
      if (/\\/api\\/photos\\/[^/]+\\/adjust/.test(url)) {
        let body = {};
        try { body = JSON.parse(opts.body || '{}'); } catch (e) { body = {}; }
        e2e.lastAdjust = body;
        e2e.calls.push({ kind: 'adjust', body });
        if (e2e.adjustMode === 'fail') {
          return json({ error: '调色失败：ffmpeg 模拟失败（E2E 注入）' }, 502);
        }
        const id = url.split('/api/photos/')[1].split('/')[0];
        const params = body.reset === true ? null : {
          brightness: Number(body.brightness) || 0,
          contrast: Number(body.contrast) || 0,
          saturation: Number(body.saturation) || 0,
          temperature: Number(body.temperature) || 0
        };
        return json({
          ok: true,
          adjusted: body.reset !== true,
          reverted: body.reset === true,
          filter: body.reset === true ? null : 'eq=brightness=0.1:contrast=1.05:saturation=1.1,colorbalance=rs=0.05:bs=-0.05',
          url: e2e.curUrl,
          photo: {
            id: id,
            url: e2e.curUrl,
            status: 'approved',
            width: 1696,
            height: 960,
            updatedAt: new Date().toISOString(),
            adjust: body.reset === true
              ? { params: null, revertedAt: new Date().toISOString(), current: { reverted: true, version: 1 }, versions: [{ version: 1 }] }
              : { params: params, appliedAt: new Date().toISOString(), current: { version: 1 }, versions: [{ version: 1, params: params, url: e2e.curUrl }] }
          }
        });
      }
    } catch (e) {
      // stub 内部异常不要吞成"请求成功"：把错误抛回页面，让断言能看见
      return json({ error: 'E2E stub 异常: ' + (e && e.message) }, 500);
    }
    return orig(input, init);
  };
  return true;
})()`;

async function main() {
  console.log('='.repeat(70));
  console.log('P4 出图/审图 + 图片调色 · 真浏览器端到端验收（零计费、零数据写入）');
  console.log('='.repeat(70));

  // ---------- 0. 前置：3001 在线（单实例，本脚本不另起） ----------
  let status = null;
  try {
    const r = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(3000) });
    if (r.ok) status = await r.json();
  } catch (e) { /* 未启动 */ }
  if (!status) {
    console.log('  ❌ 3001 未运行：请先启动 app（node server.js），本脚本不会另起实例');
    process.exit(1);
  }
  check(true, '3001 服务在线（单实例）', 'serverPid=' + ((status.serverInfo && status.serverInfo.pid) || '?'));
  if (!CHROME) { console.log('  ❌ 找不到 Chrome/Edge'); process.exit(1); }

  fs.mkdirSync(OUT, { recursive: true });
  const config = require(path.join(APP, 'config'));
  const USER = (config.AUTH && config.AUTH.bootstrapUser) || 'admin';
  // 只在这里取一次密码（运行内存），不打印、不写入任何文件
  const PASS = (config.AUTH && config.AUTH.bootstrapPassword) || '';
  if (!PASS) { console.log('  ❌ 无法从 config 读取登录密码'); process.exit(1); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-e2e-'));
  DEBUG_PORT = pickFreePort(9471, 9511);
  console.log(`  调试端口 ${DEBUG_PORT}；临时 profile ${profile}`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter', '--mute-audio', '--hide-scrollbars',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  let chromeExit = false;
  let thrown = null;
  chrome.on('exit', () => { chromeExit = true; });
  try {
    let page = null;
    for (let i = 0; i < 120 && !page; i++) {
      if (chromeExit) break;
      await sleep(150);
      try {
        const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
        if (r.ok) {
          const list = await r.json();
          page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          // 没有 page target 时多次尝试主动开一个（启动早期 PUT 可能瞬时失败）
          if (!page && i >= 6 && i % 6 === 0) {
            try {
              const nr = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/new?about:blank', { method: 'PUT' });
              if (nr.ok) { const t = await nr.json(); if (t && t.webSocketDebuggerUrl) page = t; }
            } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* 还没起来 */ }
    }
    if (!page) throw new Error('Chrome 已启动但没有 page target（debugPort=' + DEBUG_PORT + '）');
    if (chromeExit) throw new Error('Chrome 启动后退出（沙箱/权限问题）');

    cdp = wsConnect(page.webSocketDebuggerUrl);
    await cdp.opened;
    const { send, events } = cdp;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    // 必须在**页面脚本之前**装好 stub：/api/assistant/info 是组件挂载时立刻发的，
    // 页面加载后再覆盖 fetch 就晚了（计划卡会拿不到 image.unitCny → 显示「单价未知」）。
    // addScriptToEvaluateOnNewDocument 会在每个新 document 的最早时机执行。
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_STUB });

    const js = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + (r.exceptionDetails.text || '') + ' @ ' + expr.slice(0, 80));
      return r.result ? r.result.value : undefined;
    };
    const waitFor = async (expr, label, timeoutMs) => {
      const t0 = Date.now();
      let lastErr = null;
      while (Date.now() - t0 < (timeoutMs || 15000)) {
        try { if (await js(expr)) return true; } catch (e) { lastErr = e; }
        await sleep(150);
      }
      throw new Error('等待超时：' + label + (lastErr ? '（' + lastErr.message + '）' : ''));
    };
    const shot = async (name) => {
      try {
        const s = await send('Page.captureScreenshot', { format: 'png' });
        const p = path.join(OUT, name + '.png');
        fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
        console.log('  📷 ' + p);
        return p;
      } catch (e) {
        console.log('  ⚠️ 截图失败: ' + name + ' — ' + e.message);
        return null;
      }
    };
    const bodyText = () => js('document.body.innerText');
    const clickByText = (text, selector) => js(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector || 'button, a, label, div')})];
      const el = list.find((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    const clickExact = (text, selector) => js(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector || 'button')})];
      const el = list.find((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

    // ---------- 1. 登录 ----------
    console.log('\n[1] 登录（页面内 POST /api/auth/login，凭据运行时从 config 读，不打印）');
    await send('Page.navigate', { url: BASE + '/login.html' });
    await waitFor('document.readyState === "complete"', '登录页加载', 15000);
    const loginStatus = await js(`fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })
    }).then((r) => r.status)`);
    check(loginStatus === 200, '登录成功', 'HTTP ' + loginStatus);

    // ---------- 2. 种子配置（假 Key，只在本 headless profile 内） ----------
    console.log('\n[2] 种入假的 vs_config（只存在本临时 profile，不碰用户浏览器数据）');
    const SEED = {
      whaletvKey: 'e2e-video-key-1234',
      whaletvBaseUrl: 'https://e2e.example.test/v1',
      whaletvVideoModel: 'wan3.0-video',
      // 出图链路必须走百炼官方（2026-11-16 实测：WhaleTV 中转不收首帧图 → 400）。
      // 百炼计划卡的 runtime = dashScopeKey + 由 WorkspaceId/Region 拼出的 baseUrl + modelId=wan3.0-video，
      // 所以这三个键必须一起种，否则计划卡会显示「没填 Key」。
      dashScopeKey: 'e2e-dashscope-key-9012',
      dashScopeRegion: 'cn-beijing',
      dashScopeWorkspaceId: 'e2e-ws-1234',
      imageKey: 'e2e-image-key-5678',
      imageBaseUrl: 'https://e2e.example.test/img',
      imageProvider: 'dashscope',
      imageModel: 'wan2.7-image',
      imageSize: '1696*960',
      llmKey: 'e2e-llm-key',
      llmUrl: 'https://e2e.example.test/llm',
      llmModel: 'e2e-llm'
    };
    await js(`localStorage.setItem('vs_config', ${JSON.stringify(JSON.stringify(SEED))}); true`);

    // ---------- 3. 小智首页：计划卡 + 出图开关 + 确认执行请求体 ----------
    // 用「万相官方」明确走百炼：旧进程 planCard 默认是中转（openai-video），而中转不收首帧图；
    // 重启后的新计划卡默认就是百炼。两种进程下这句话都能得到 dashscope。
    const MSG_DASHSCOPE = '10 分钟的长视频，用万相官方';
    console.log('\n[3] 首页小智：发一句「' + MSG_DASHSCOPE + '」→ 计划卡');
    await send('Page.navigate', { url: BASE + '/app' });
    await waitFor('!!document.querySelector("textarea.xz-input")', '首页输入框', 20000);
    check(true, '首页（/）渲染出小智对话页与输入框');

    check(await js('!!(window.__e2e && window.__e2e.installed)'), 'fetch stub 已在页面脚本之前装好（execute/state/unpause/adjust 全部拦截）');
    // info 是挂载后异步发的：不能只查一次（会偶发 0），等它计数 > 0
    const infoStubOk = await waitFor('window.__e2e.infoStubCount > 0', 'info 拦截计数', 8000).catch(() => false);
    check(infoStubOk === true, 'info 补字段拦截已生效（组件挂载时就能拿到 image.unitCny）');

    await js(`(() => {
      const ta = document.querySelector('textarea.xz-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(MSG_DASHSCOPE)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    await js(`(() => {
      const ta = document.querySelector('textarea.xz-input');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor('document.body.innerText.includes("确认执行")', '计划卡出现（确认执行按钮）', 25000);
    const t3 = await bodyText();
    check(/10\.00\s*分钟|10 分钟/.test(t3), '计划卡显示 10 分钟', (t3.match(/10[^\n]{0,20}分钟/) || [''])[0]);
    check(/百炼|万相 3\.0（官方）/.test(t3), '计划卡走百炼官方通道（出图必须走这条）',
      (t3.match(/模型\s*\n?[^\n]{0,30}/) || [''])[0] || (t3.match(/百炼[^\n]{0,20}/) || [''])[0]);
    check(t3.includes('逐段出图'), '计划卡出现「逐段出图」开关');
    check(t3.includes('图生视频'), '计划卡写明「→ 图生视频」');
    check(/出图\s*60\s*张/.test(t3), '出图张数 = 60（10 分钟 / 10 秒）', (t3.match(/出图\s*\d+\s*张[^\n]{0,40}/) || [''])[0]);
    check(/¥\s*0\.20/.test(t3) && /≈\s*¥\s*12\.00/.test(t3),
      '计费行用后端单价 ¥0.20/张 算出合计 ¥12.00（未硬编码）',
      (t3.match(/出图\s*60\s*张[^\n]{0,80}/) || [''])[0]);
    check(t3.includes('整批暂停') || t3.includes('等你审图'), '写明出图后整批暂停等审图');
    const toggleState = await js(`(() => {
      const box = document.querySelector('input[type=checkbox]');
      return box ? { checked: box.checked, disabled: box.disabled } : null;
    })()`);
    check(toggleState && toggleState.checked === true, '出图开关默认开启（用户口径全自动）', JSON.stringify(toggleState));
    await shot('p4-01-plan-card-image-toggle');

    console.log('\n[4] 确认执行 → 拦截请求体');
    await clickByText('确认执行', 'button');
    await waitFor('!!(window.__e2e && window.__e2e.lastExecute)', 'execute 请求被拦截', 15000);
    const exec = await js('window.__e2e.lastExecute');
    check(exec.imagePerClip === true, 'body.imagePerClip === true', String(exec.imagePerClip));
    check(exec.imageApiKey === SEED.imageKey, 'body.imageApiKey 透传设置里的图片 Key（不打印值）',
      exec.imageApiKey ? 'len=' + String(exec.imageApiKey).length : '(空)');
    check(exec.imageModel === SEED.imageModel && exec.imageProvider === SEED.imageProvider,
      'body.imageModel / imageProvider 透传', exec.imageModel + ' / ' + exec.imageProvider);
    check(exec.imageSize === SEED.imageSize && exec.imageBaseUrl === SEED.imageBaseUrl,
      'body.imageSize / imageBaseUrl 透传', exec.imageSize);
    check(exec.apiKey === SEED.dashScopeKey && exec.approved === true,
      '原有视频 Key（百炼 dashScopeKey） / approved 未被破坏',
      'approved=' + exec.approved + ' / keyLen=' + String(exec.apiKey || '').length);
    check(exec.modelId === 'wan3.0-video' && /e2e-ws-1234\.cn-beijing/.test(String(exec.apiBaseUrl)),
      '百炼 baseUrl 由 WorkspaceId + Region 拼出（出图→图生视频走这条通道）', String(exec.apiBaseUrl));
    check(!!exec.sessionId && !!exec.planId, 'sessionId / planId 都在请求体里');

    console.log('\n[5] 关掉出图开关后再确认 → imagePerClip=false（纯文生视频链路保留）');
    await js(`(() => { const b = document.querySelector('input[type=checkbox]'); b.click(); return true; })()`);
    await sleep(250);
    const offText = await bodyText();
    check(offText.includes('关（纯文生视频）') || offText.includes('纯文生视频'), '开关关闭后计划卡显示「纯文生视频」');
    await clickByText('确认执行', 'button');
    await waitFor('window.__e2e.lastExecute.imagePerClip === false', '第二次 execute（关出图）', 15000);
    check(true, '关开关后 body.imagePerClip === false');
    // 恢复开关（后面的审图用例要用默认开的语义）
    await js(`(() => {
      const b = document.querySelector('input[type=checkbox]');
      if (b && !b.checked) b.click();
      return true;
    })()`);
    await sleep(200);

    // ---------- 5b. 中转通道 + 出图 → 前端必须拦下（中转不收首帧图，实测 400） ----------
    console.log('\n[5b] 中转通道（openai-video）+ 逐段出图 → 确认被拦（不误花图片钱）');
    const sendMsg = async (text) => {
      const literal = JSON.stringify(text);
      await js(`(() => {
        const ta = document.querySelector('textarea.xz-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${literal});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(250);
      await js(`(() => {
        const ta = document.querySelector('textarea.xz-input');
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return true;
      })()`);
      await sleep(1500);
    };
    const execCallsBefore5b = await js('window.__e2e.calls.filter(c=>c.kind==="execute").length');
    await sendMsg('10 分钟的长视频，走中转');
    await waitFor('document.body.innerText.includes("中转")', '中转计划卡', 25000);
    const t5b = await bodyText();
    check(/WhaleTV|中转/.test(t5b), '计划卡切到 WhaleTV 中转（openai-video）', (t5b.match(/WhaleTV[^\n]{0,20}/) || [''])[0]);
    check(/不收首帧图|400/.test(t5b), '计划卡给出「中转不收首帧图」的红色提示');
    await clickByText('确认执行', 'button');
    await sleep(800);
    const t5b2 = await bodyText();
    const execCallsAfter5b = await js('window.__e2e.calls.filter(c=>c.kind==="execute").length');
    check(execCallsAfter5b === execCallsBefore5b, '确认被前端拦下：没有发 execute 请求（不会真扣费）',
      `${execCallsBefore5b} → ${execCallsAfter5b}`);
    check(/不收首帧图/.test(t5b2) && /百炼|万相官方/.test(t5b2), '对话里给出可执行的替换方案（改用百炼 / 关掉出图）',
      (t5b2.match(/(⛔|当前计划走的是)[^\n]{0,80}/) || [''])[0]);
    await shot('p4-08-relay-image-blocked');
    // 再切回百炼计划，后面的审图卡片/图片库用例不依赖 plan.model
    await sendMsg(MSG_DASHSCOPE);
    await waitFor('document.body.innerText.includes("百炼")', '切回百炼计划卡', 25000).catch(() => {});

    // ---------- 6. 审图暂停卡片 + 继续生成 ----------
    console.log('\n[6] 审图暂停：「图已出好」卡片 + 继续生成（POST unpause）');
    // [5b] 连续发了两句对话 → assistant.send() 会 setXstate(null)，状态机轮询随之停止。
    // 先用一次（被 stub 拦截的）确认把运行态挂回去，再切到「审图暂停」的 state 响应。
    await clickByText('确认执行', 'button');
    await waitFor('document.body.innerText.includes("重试 0/2")', '运行态状态条（state 轮询已启动）', 12000);
    await js(`window.__e2e.stateMode = 'review'; true`);
    await waitFor('document.body.innerText.includes("图已出好")', '图已出好卡片', 12000);
    const t6 = await bodyText();
    check(t6.includes('图已出好'), '出现「图已出好」卡片');
    check(/共\s*3\s*段/.test(t6) && /出图\s*3\s*张/.test(t6), '卡片显示 3 段 / 出图 3 张', (t6.match(/共\s*\d+\s*段[^\n]{0,40}/) || [''])[0]);
    check(/待审\s*3\s*张/.test(t6), '卡片显示待审张数', (t6.match(/待审\s*\d+\s*张/) || [''])[0]);
    check(t6.includes('去审图') && t6.includes('继续生成'), '卡片有「去审图」「继续生成」两个按钮');
    check(t6.includes('等待审图'), '状态条显示「等待审图」而不是普通「生成中」');
    await shot('p4-02-image-review-card');

    const unpauseCallsBefore = await js('window.__e2e.calls.filter(c=>c.kind==="unpause").length');
    await clickExact('继续生成', 'button');
    await waitFor('window.__e2e.calls.some(c=>c.kind==="unpause")', 'unpause 请求被拦截', 12000);
    const unp = await js('window.__e2e.calls.find(c=>c.kind==="unpause")');
    check(!!unp && /task_e2e_image_first\/unpause$/.test(unp.url), '点「继续生成」→ POST /api/tasks/<id>/unpause', unp && unp.url);
    check(unp && String(unp.method).toUpperCase() === 'POST', '方法是 POST', unp && unp.method);
    check((await js('window.__e2e.calls.filter(c=>c.kind==="unpause").length')) === unpauseCallsBefore + 1,
      '只发了一次 unpause（没有重复请求）');
    await waitFor('document.body.innerText.includes("已继续")', '继续后的反馈文案', 12000);
    const t6b = await bodyText();
    check(/已继续[^\n]*生成视频/.test(t6b), '对话里出现「已继续，开始生成视频」', (t6b.match(/已继续[^\n]{0,40}/) || [''])[0]);
    check(/3\s*张未单独审核的图按通过处理/.test(t6b) || t6b.includes('按通过处理'),
      '继续时如实说明未审核图按通过处理', (t6b.match(/[^\n]*按通过处理[^\n]*/) || [''])[0]);
    await shot('p4-03-after-continue');

    // ---------- 7. 库 · 图片：调色滑杆 ----------
    console.log('\n[7] 库 · 图片：手动调色四条滑杆');
    await send('Page.navigate', { url: BASE + '/app/library' });
    await waitFor('document.body.innerText.includes("图片")', '库页加载', 20000);
    // navigate 会重建页面 → 重新装 stub（stub 只在本页生命周期内有效）
    await js(INSTALL_STUB);
    await js(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').replace(/\\s+/g, '').startsWith('图片'));
      if (b) b.click();
      return !!b;
    })()`);
    await waitFor('!!document.querySelector("img[alt=\\"生成的图片\\"]") || !!document.querySelector("img[alt=\\"调色后\\"]")',
      '图片卡片出现', 20000);
    check(true, '库 · 图片 tab 渲染出图片卡片');
    const opened = await js(`(() => {
      const img = document.querySelector('img[alt="生成的图片"]') || document.querySelector('img[alt="调色后"]');
      if (!img) return false;
      window.__e2e.curUrl = (img.currentSrc || img.src || '').split('?')[0];
      img.click();
      return true;
    })()`);
    check(opened, '点击图片卡片打开详情');
    await waitFor('document.body.innerText.includes("手动调色")', '调色区出现', 15000);
    const sliders = await js(`(() => {
      const list = [...document.querySelectorAll('input[type=range]')];
      return list.map((el) => ({ label: el.getAttribute('aria-label'), min: el.min, max: el.max, step: el.step, value: el.value }));
    })()`);
    check(sliders.length === 4, '详情里有 4 条滑杆', JSON.stringify(sliders.map((s) => s.label)));
    check(['亮度', '对比度', '饱和度', '色温'].every((l) => sliders.some((s) => s.label === l)),
      '滑杆标签是 亮度/对比度/饱和度/色温', sliderLabelText(sliders));
    check(sliders.every((s) => s.min === '-100' && s.max === '100' && s.step === '1'),
      '滑杆范围 -100..100、步长 1');
    check(sliders.every((s) => s.value === '0'), '默认值全为 0（未调色）');
    const buttons7 = await js(`[...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim())`);
    check(buttons7.includes('应用') && buttons7.includes('重置为 0') && buttons7.includes('恢复原图'),
      '有 应用 / 重置为 0 / 恢复原图 三个按钮');
    await shot('p4-04-photo-adjust-sliders');

    console.log('\n[8] 拖滑杆 → CSS 即时预览（不发请求）');
    const callsBeforePreview = await js('window.__e2e.calls.filter(c=>c.kind==="adjust").length');
    const filterAfter = await js(`(() => {
      const setRange = (label, val) => {
        const el = [...document.querySelectorAll('input[type=range]')].find((x) => x.getAttribute('aria-label') === label);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, String(val));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      setRange('亮度', 30); setRange('对比度', 20); setRange('饱和度', 15); setRange('色温', 25);
      const img = [...document.querySelectorAll('img')].find((i) => i.style && i.style.maxHeight === '420px');
      return img ? (img.style.filter || '') : '__NO_IMG__';
    })()`);
    check(!!filterAfter && filterAfter !== '__NO_IMG__', '详情大图存在（有即时预览载体）', filterAfter);
    check(/brightness\(/.test(String(filterAfter)) && /contrast\(/.test(String(filterAfter))
      && /saturate\(/.test(String(filterAfter)) && /sepia|hue-rotate/.test(String(filterAfter)),
      '拖动后大图应用了 CSS 近似预览（brightness/contrast/saturate + 色温近似）');
    check(/未提交/.test(await bodyText()), '页面提示「即时预览 · 未提交」');
    check((await js('window.__e2e.calls.filter(c=>c.kind==="adjust").length')) === callsBeforePreview,
      '拖动滑杆没有发任何 adjust 请求（不打后端）');
    await shot('p4-05-css-preview');

    console.log('\n[9] 应用 → POST adjust（绝对值四参数）+ cache-busting');
    // React 状态更新到 DOM 有 1 帧延迟：滑杆刚 setValue 完就点，按钮可能还是 disabled → 偶发不触发请求。
    // 统一先等「按钮可点」，再用调色请求计数（而不是 lastAdjust）判断本次确实发了请求。
    const waitEnabled = (label) => waitFor(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
      return !!(b && !b.disabled);
    })()`, label + ' 可点击', 8000);
    const adjustCalls = () => js('window.__e2e.calls.filter(c=>c.kind==="adjust").length');
    await waitEnabled('应用');
    const calls9 = await adjustCalls();
    await clickExact('应用', 'button');
    await waitFor(`window.__e2e.calls.filter(c=>c.kind==="adjust").length > ${calls9}`, 'adjust 请求被拦截', 12000);
    const adj = await js('window.__e2e.lastAdjust');
    check(adj.brightness === 30 && adj.contrast === 20 && adj.saturation === 15 && adj.temperature === 25,
      '请求体是四条滑杆的绝对值', JSON.stringify(adj));
    check(!('reset' in adj), '应用请求不带 reset');
    await waitFor('document.body.innerText.includes("已应用调色")', '应用成功提示', 12000);
    check(true, '应用成功后显示服务端返回的版本提示');
    const bustedSrc = await js(`(() => {
      const img = [...document.querySelectorAll('img')].find((i) => i.style && i.style.maxHeight === '420px');
      return img ? (img.currentSrc || img.src) : '';
    })()`);
    check(/[?&]v=/.test(String(bustedSrc)), '详情图 URL 加 cache-busting（?v=…）', bustedSrc);
    await shot('p4-06-applied');

    console.log('\n[10] 失败路径：后端错误原文必须显示（不吞）');
    await js(`window.__e2e.adjustMode = 'fail'; true`);
    await waitEnabled('应用');
    const calls10 = await adjustCalls();
    await clickExact('应用', 'button');
    await waitFor(`window.__e2e.calls.filter(c=>c.kind==="adjust").length > ${calls10}`, '第二次 adjust 请求被拦截', 12000);
    await waitFor('document.body.innerText.includes("调色失败")', '失败文案', 12000);
    const t10 = await bodyText();
    check(/调色失败：ffmpeg 模拟失败/.test(t10), '把后端 error 原文显示出来', (t10.match(/调色失败[^\n]{0,60}/) || [''])[0]);
    await js(`window.__e2e.adjustMode = 'ok'; true`);

    console.log('\n[11] 恢复原图 → POST adjust {reset:true}');
    // 「恢复原图」在未调色时是 disabled；刚应用成功要等它变可点
    await waitEnabled('恢复原图');
    await clickExact('恢复原图', 'button');
    await waitFor('window.__e2e.lastAdjust && window.__e2e.lastAdjust.reset === true', 'reset 请求被拦截', 12000);
    check(true, '「恢复原图」提交 {reset:true}');
    await waitFor('document.body.innerText.includes("已恢复原图")', '恢复成功提示', 12000);
    check(true, '恢复后提示「已恢复原图，滑杆归 0」');
    await shot('p4-07-reverted');

    // ---------- 12. 控制台错误 ----------
    console.log('\n[12] 控制台错误（本轮页面不应有未捕获异常）');
    const errEvents = events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check(errEvents.length === 0, '没有未捕获的 JS 异常', errEvents.slice(0, 3).map((e) => e.params && e.params.exceptionDetails && e.params.exceptionDetails.text).join(' | '));
    const logErrors = events.filter((e) => e.method === 'Log.entryAdded' && e.params && e.params.entry
      && e.params.entry.level === 'error' && !/404|Failed to load resource/i.test(e.params.entry.text || ''));
    check(logErrors.length === 0, '没有 JS console.error', logErrors.slice(0, 3).map((e) => e.params.entry.text).join(' | '));
    // 注意：这里已经是 /app/library 文档，window.__e2e 是新的；info 单价拦截在首页断言过（[3]）。
    // 这里只确认 stub 在换页后仍自动装好（addScriptToEvaluateOnNewDocument 生效）。
    check(await js('!!(window.__e2e && window.__e2e.installed)'), '换页后 stub 仍自动装好（新 document 生效）');
  } catch (err) {
    // 不能把异常吞掉：脚本体抛错时也要在结果里看见真实原因（否则只剩"失败 1"无从排查）
    thrown = err;
    fail++;
    failures.push({ label: '脚本执行异常（后续断言未执行）', extra: err && err.message });
    console.log('\n  ❌ 脚本执行异常: ' + (err && err.stack ? err.stack : err));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { killChromeTree(chrome.pid); } catch (e) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    console.log('\n' + '='.repeat(70));
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    if (fail > 0) {
      console.log('失败项：');
      failures.forEach((f) => console.log(`  - ${f.label}${f.extra ? ': ' + f.extra : ''}`));
    }
    if (thrown) console.log('⚠ 存在异常中断：' + (thrown.message || thrown));
    console.log('='.repeat(70));
    process.exit(fail === 0 ? 0 : 1);
  }
}

function sliderLabelText(sliders) {
  return (sliders || []).map((s) => s.label).join('/');
}

main().catch((e) => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
