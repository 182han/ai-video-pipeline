// ============================================================
// 创作向导「切页 / 刷新不丢」真浏览器端到端验收（2026-11-11）
// ------------------------------------------------------------
// 背景：2026-11-10 修复后只做了离线探针（verify-create-draft.js，38/0），
// 但 §5.4 要求「在浏览器里实际操作一遍」。本机 dsh_browser_* 不可用（无 Electron），
// 但装了 Chrome/Edge，于是改走 CDP：
//   1) 本脚本自建一个只读静态服务（只发 app/web，接口一律 404），不碰真实后端/数据库；
//   2) 用 Chrome headless + CDP（Node 24 自带 WebSocket）驱动真实页面；
//   3) 用真实点击复现事故路径：输入提示词 → 下一步 → 点左侧「视频片段」→ 点回「创作」；
//   4) 断言提示词/步骤/「已恢复草稿」提示都回来；再按 F5 断言仍然在；
//   5) 负向对照：清空 sessionStorage 后同样操作 → 必须什么都没有（证明断言不是永真）；
//   6) 截图落盘，供人工看视觉。
//
// 不联网、不计费、不写仓库数据。用法：
//   node web/verify/create-draft-e2e.js
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const WEB = path.resolve(__dirname, '..');
const OUT = __dirname;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startStatic() {
  const server = http.createServer((req, res) => {
    const url = String(req.url || '/').split('?')[0];
    // 只补一个只读探针，避免页面底部出现「后端是旧版本」横幅干扰截图；
    // 其余接口一律 404 —— 本验收只测纯前端的草稿行为，不依赖真实后端。
    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, imageGen: { configured: false }, staticProbe: true }));
    }
    if (/^\/api\//.test(url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"静态验收：接口不可用"}');
    }
    if (!url.startsWith('/app')) {
      res.writeHead(302, { Location: '/app' });
      return res.end();
    }
    let rel = decodeURIComponent(url.slice(4)) || '/';
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.join(WEB, rel);
    // SPA 路由（无扩展名）回调 index.html；静态文件按扩展名取
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function wsConnect(url) {
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
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
    }, 15000);
  });
  return { ws, send, events, close: () => { try { ws.close(); } catch (e) { /* ignore */ } } };
}

(async () => {
  console.log('================================================================');
  console.log('创作向导：真浏览器（Chrome + CDP）切页 / F5 不丢');
  console.log('================================================================');
  if (!CHROME) { console.log('  ❌ 找不到 Chrome/Edge，无法做浏览器验收'); process.exit(1); }
  console.log('  浏览器: ' + CHROME);

  const { server, port } = await startStatic();
  const base = 'http://127.0.0.1:' + port + '/app';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-e2e-'));
  const debugPort = 9333;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter', '--mute-audio',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    // 等调试端口 + 至少一个 page target（空数组也是真值，不能只判 list）
    let page = null;
    for (let i = 0; i < 100 && !page; i++) {
      await sleep(150);
      try {
        const r = await fetch('http://127.0.0.1:' + debugPort + '/json/list');
        if (r.ok) {
          const list = await r.json();
          page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (!page && i === 20) {
            // 有些 Chrome 版本不自动开初始标签，主动建一个
            try {
              const nr = await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' });
              if (nr.ok) {
                const t = await nr.json();
                if (t && t.webSocketDebuggerUrl) page = t;
              }
            } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* 还没起来 */ }
    }
    if (!page) throw new Error('Chrome 已启动但没有 page target');

    cdp = await wsConnect(page.webSocketDebuggerUrl);
    const { send, events } = cdp;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    const js = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + (r.exceptionDetails.text || ''));
      return r.result ? r.result.value : undefined;
    };
    const waitFor = async (expr, label, timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeoutMs || 12000)) {
        try { if (await js(expr)) return true; } catch (e) { /* ignore */ }
        await sleep(120);
      }
      throw new Error('等待超时：' + label);
    };
    const clickText = async (text, scope) => js(`(() => {
      const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'};
      if (!root) return false;
      const el = [...root.querySelectorAll('button, a')].find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    const draft = () => js(`(() => { try { return JSON.parse(sessionStorage.getItem('vs_create_draft_v1') || 'null'); } catch (e) { return null; } })()`);
    const bodyText = () => js('document.body.innerText');
    const taValue = () => js(`(() => { const t = document.querySelector('textarea'); return t ? t.value : null; })()`);

    // ---- 打开页面 ----
    await send('Page.navigate', { url: base });
    await waitFor(`!!document.querySelector('textarea')`, '第①步提示词输入框');
    await js(`sessionStorage.removeItem('vs_create_draft_v1')`);
    await send('Page.reload');
    await waitFor(`!!document.querySelector('textarea')`, '清空草稿后重新加载');
    check(true, '页面加载成功（无登录墙的静态实例），第①步可见');

    // ---- 负向对照：什么都不输入，切页再回来必须还是空 ----
    await clickText('下一步');
    await sleep(200);
    await clickText('上一步');
    await sleep(150);
    await clickText('视频片段', 'aside');
    await sleep(200);
    await clickText('创作', 'aside');
    await waitFor(`!!document.querySelector('textarea')`, '回到创作第①步');
    await sleep(200);
    check((await taValue()) === '', '负向对照：没输入内容时切页回来仍是空（断言不是永真）');
    check(!(await bodyText()).includes('已恢复上次未做完的草稿'), '负向对照：没有残留「已恢复」提示');

    // ---- 正戏：输入提示词 → 下一步 → 切到「视频片段」→ 回「创作」 ----
    const PROMPT = '雪山日出，低雾，侧逆光，缓慢推近（E2E 验收）';
    await js(`(() => {
      const t = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(t, ${JSON.stringify(PROMPT)});
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const d1 = await draft();
    check(!!d1 && d1.prompt === PROMPT, '输入提示词后草稿已写入 sessionStorage（真浏览器）', d1 ? JSON.stringify(d1.prompt) : '无草稿');

    await clickText('下一步');
    await sleep(300);
    const d2 = await draft();
    check(!!d2 && d2.step === 1, '点「下一步」后步骤已落草稿（step=1）', d2 ? String(d2.step) : '无草稿');

    await clickText('视频片段', 'aside');
    await waitFor(`location.pathname === '/app/clips'`, '切到 /app/clips');
    await sleep(300);
    check(!(await js(`!!document.querySelector('textarea')`)), '切走后向导已卸载（真实复现事故前提）');

    await clickText('创作', 'aside');
    await waitFor(`location.pathname === '/app' || location.pathname === '/app/'`, '回到 /app');
    await sleep(400);
    const textAfter = await bodyText();
    check(textAfter.includes('已恢复上次未做完的草稿'), '回「创作」出现「已恢复上次未做完的草稿」提示');
    const d3 = await draft();
    check(!!d3 && d3.step === 1, '回到的是第②步（步骤没被重置成第①步）', d3 ? String(d3.step) : '无草稿');

    await clickText('上一步');
    await sleep(250);
    check((await taValue()) === PROMPT, '提示词原样恢复（事故核心）', await taValue());

    // ---- 截图（视觉证据）----
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const shotPath = path.join(OUT, 'create-draft-restored.png');
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      console.log('  📷 截图: ' + shotPath);
    } catch (e) {
      console.log('  ⚠️ 截图失败（不影响断言）: ' + e.message);
    }

    // ---- F5：刷新后仍在 ----
    await send('Page.reload');
    await waitFor(`!!document.querySelector('textarea')`, 'F5 后第①步');
    await sleep(300);
    check((await taValue()) === PROMPT, 'F5 刷新后提示词仍在（sessionStorage 同一标签页生效）');
    check((await bodyText()).includes('已恢复上次未做完的草稿'), 'F5 刷新后仍显示「已恢复」提示');

    // ---- 清空草稿按钮 ----
    await clickText('清空草稿');
    await sleep(250);
    check((await taValue()) === '', '点「清空草稿」后输入框清空');
    check(!(await bodyText()).includes('已恢复上次未做完的草稿'), '清空后「已恢复」提示消失');

    // ---- 控制台异常 ----
    const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown');
    const consoleErrors = events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .filter((e) => !/Failed to load resource|404|net::ERR/.test(JSON.stringify(e.params.args)));
    check(exceptions.length === 0, '页面没有未捕获的 JS 异常', exceptions.length ? JSON.stringify(exceptions[0].params).slice(0, 300) : '0');
    check(consoleErrors.length === 0, '控制台没有非资源类报错', consoleErrors.length ? JSON.stringify(consoleErrors[0].params).slice(0, 300) : '0');
  } catch (e) {
    check(false, '浏览器 E2E 异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (cdp) cdp.close();
    try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
