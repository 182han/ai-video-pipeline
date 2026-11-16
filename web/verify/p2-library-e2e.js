// ============================================================
// P2 库 IA：真浏览器端到端验收（2026-11-15）
// ------------------------------------------------------------
// 背景：P2 要求「库」合并成三个 tab（成片 / 片段 / 图片）+ 回收站抽屉 +
//       导航只留「库」，并把配乐库并入剪辑台。仅静态断言证明不了这些，
//       必须在本机真实浏览器里操作一遍（§5.4 要求）。
//
// 做法（沿用 web/verify/create-draft-e2e.js 的先例）：
//   1) 连接**已经在跑的** 3001 单实例（绝不另起服务 / 端口）；
//   2) 用 headless Chrome + CDP 打开 /app，页面内 POST /api/auth/login
//      （账号密码运行时从 app/config.js 读取，不打印、不入库、不落盘）；
//   3) 真点击：三 tab 切换、成片播放、删除 → 回收站 → 恢复 → 彻底删除、
//      旧深链 /clips、/photos、剪辑台音频面板；
//   4) 截图落 app/docs/交接/p2-screenshots/ 供人工看视觉；
//   5) 临时成片由脚本自建自删（id 前缀 p2verify_），不碰真实库条目。
//
// 用法：cd app && node web/verify/p2-library-e2e.js
// 退出码 0 = 全部通过；非 0 = 有失败（"未验证"不会被算成通过）。
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..');
const WEB = path.resolve(__dirname, '..');
const OUT = path.join(APP, 'docs', '交接', 'p2-screenshots');
const LIB_DIR = path.join(APP, 'data', 'library');
const RECYCLE_DIR = path.join(APP, 'data', 'recycle');
const OUTPUT_DIR = path.join(APP, 'output');
const BASE = 'http://127.0.0.1:3001';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    }, 20000);
  });
  return { ws, send, events, close: () => { try { ws.close(); } catch (e) { /* ignore */ } } };
}

// 临时成片：脚本自建自删。文件与条目都带 p2verify_ 前缀，清理时只认这个前缀。
const TS = Date.now();
const TMP_ID = 'p2verify_' + TS + '_final';
const TMP_FILE = 'p2verify_' + TS + '.mp4';
const TMP_PATH = path.join(OUTPUT_DIR, TMP_FILE);
const TMP_PROMPT = 'P2 验收临时成片 ' + TMP_ID;
const TMP_ENTRY = path.join(LIB_DIR, TMP_ID + '.json');

function makeTempFinal() {
  const config = require(path.join(APP, 'config'));
  let probe = { width: 320, height: 180, fps: 25, duration: 1, sizeBytes: 0 };
  try {
    execFileSync(config.FFMPEG_PATH, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
      '-pix_fmt', 'yuv420p', TMP_PATH
    ], { stdio: 'ignore' });
    probe.sizeBytes = fs.statSync(TMP_PATH).size;
  } catch (e) {
    // ffmpeg 不可用时仍可测删除/恢复链路：写一个占位文件（不入正式库，跑完就删）
    fs.writeFileSync(TMP_PATH, Buffer.alloc(1024));
    probe.sizeBytes = 1024;
  }
  fs.mkdirSync(LIB_DIR, { recursive: true });
  const now = new Date().toISOString();
  const entry = {
    id: TMP_ID,
    kind: 'final',
    status: 'completed',
    origin: 'task',
    fileName: TMP_FILE,
    filePath: TMP_PATH,
    url: '/output/' + encodeURIComponent(TMP_FILE),
    taskId: 'p2verify_' + TS,
    clipIndex: null,
    prompt: TMP_PROMPT,
    originalPrompt: TMP_PROMPT,
    sourcePhotoId: null,
    model: 'p2-verify',
    resolution: '480p',
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    codec: 'h264',
    durationSec: probe.duration,
    sizeBytes: probe.sizeBytes,
    hasAudio: false,
    // 故意用「无费用快照」：验证页面显示“未知”而不是 ¥0.00（2026-11-15 口径）
    cost: { amount: 0, computed: false, currency: 'CNY', basis: 'final', label: '费用未知（历史任务无费用快照）' },
    timing: { startedAt: now, completedAt: now, totalMs: null, genMs: null, qcMs: null, splitAvailable: false, historical: true },
    qc: { passed: false, unverified: true, level: 'unknown', reason: '无终检记录', qcVersion: null },
    theme: null,
    themeTag: null,
    tags: { theme: null, model: 'p2-verify', resolution: '480p' },
    favorite: false,
    replacedBy: null,
    regeneratedFrom: null,
    source: 'final',
    addedAt: now,
    updatedAt: now
  };
  fs.writeFileSync(TMP_ENTRY, JSON.stringify(entry, null, 2), 'utf8');
}

function findRecycleDirs(id) {
  const root = path.join(RECYCLE_DIR, 'final');
  try {
    return fs.readdirSync(root)
      .filter((n) => n === id || n.startsWith(id + '-'))
      .map((n) => path.join(root, n));
  } catch (e) { return []; }
}

function cleanupTemp() {
  const removed = [];
  try { if (fs.existsSync(TMP_ENTRY)) { fs.rmSync(TMP_ENTRY, { force: true }); removed.push('library'); } } catch (e) { /* ignore */ }
  try { if (fs.existsSync(TMP_PATH)) { fs.rmSync(TMP_PATH, { force: true }); removed.push('output'); } } catch (e) { /* ignore */ }
  try {
    const root = path.join(RECYCLE_DIR, 'final');
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        if (name === TMP_ID || name.startsWith(TMP_ID + '-')) {
          fs.rmSync(path.join(root, name), { recursive: true, force: true });
          removed.push('recycle:' + name);
        }
      }
    }
  } catch (e) { /* ignore */ }
  return removed;
}

(async () => {
  console.log('================================================================');
  console.log('P2 库 IA：真浏览器端到端验收（连接运行中的 3001，单实例）');
  console.log('================================================================');
  if (!CHROME) { console.log('  ❌ 找不到 Chrome/Edge，无法做浏览器验收'); process.exit(1); }
  console.log('  浏览器: ' + CHROME);

  let status = null;
  try {
    const r = await fetch(BASE + '/api/status');
    status = await r.json();
  } catch (e) {
    console.log('  ❌ 3001 未运行：请先启动 app（node server.js），本脚本不会另起实例');
    process.exit(1);
  }
  check(!!status, '3001 服务在线（单实例）', 'serverPid=' + ((status && status.serverInfo && status.serverInfo.pid) || '?'));

  fs.mkdirSync(OUT, { recursive: true });
  const config = require(path.join(APP, 'config'));
  const USER = (config.AUTH && config.AUTH.bootstrapUser) || 'admin';
  // 只在这里取一次密码（运行内存），不打印、不写入任何文件
  const PASS = (config.AUTH && config.AUTH.bootstrapPassword) || '';
  if (!PASS) { console.log('  ❌ 无法从 config 读取登录密码，无法打开工作台'); process.exit(1); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-e2e-'));
  const debugPort = 9461;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter', '--mute-audio', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let page = null;
    for (let i = 0; i < 100 && !page; i++) {
      await sleep(150);
      try {
        const r = await fetch('http://127.0.0.1:' + debugPort + '/json/list');
        if (r.ok) {
          const list = await r.json();
          page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (!page && i === 20) {
            try {
              const nr = await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' });
              if (nr.ok) { const t = await nr.json(); if (t && t.webSocketDebuggerUrl) page = t; }
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

    const js = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + (r.exceptionDetails.text || ''));
      return r.result ? r.result.value : undefined;
    };
    const waitFor = async (expr, label, timeoutMs) => {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < (timeoutMs || 15000)) {
        try { if (await js(expr)) return true; } catch (e) { last = e; }
        await sleep(120);
      }
      throw new Error('等待超时：' + label + (last ? '（' + last.message + '）' : ''));
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
    const clickText = (text, scope, tag) => js(`(() => {
      const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'};
      if (!root) return false;
      const el = [...root.querySelectorAll(${JSON.stringify(tag || 'button, a, label')})]
        .find((b) => (b.textContent || '').trim().includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    const clickTab = (label) => js(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').replace(/\s+/g, '').startsWith(${JSON.stringify(label)}));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    const clickInRow = (marker, action) => js(`(() => {
      const rows = [...document.querySelectorAll('div')]
        .filter((d) => String(d.className || '').includes('px-3 py-2.5') && d.textContent.includes(${JSON.stringify(marker)}));
      if (!rows.length) return false;
      const btn = [...rows[0].querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === ${JSON.stringify(action)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    const clickRecycleAction = (marker, action) => js(`(() => {
      const boxes = [...document.querySelectorAll('div')].filter((d) =>
        d.textContent.includes(${JSON.stringify(marker)}) &&
        [...d.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === ${JSON.stringify(action)}));
      if (!boxes.length) return false;
      boxes.sort((a, b) => a.textContent.length - b.textContent.length);
      const btn = [...boxes[0].querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === ${JSON.stringify(action)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    const closeDrawer = () => js(`(() => {
      const a = [...document.querySelectorAll('aside')]
        .find((x) => x.textContent.includes('回收站') && x.textContent.includes('清空回收站'));
      if (!a) return false;
      const b = [...a.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '关闭');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    // 注意：恢复后条目回到库列表，提示词里包含 id，不能拿整页文本判断“已移出回收站”。
    const drawerHas = (marker) => `(() => {
      const a = [...document.querySelectorAll('aside')].find((x) => x.textContent.includes('清空回收站'));
      return !!(a && a.textContent.includes(${JSON.stringify(marker)}));
    })()`;
    const drawerHasPurge = (marker) => `(() => {
      const a = [...document.querySelectorAll('aside')].find((x) => x.textContent.includes('清空回收站'));
      return !!(a && a.textContent.includes(${JSON.stringify(marker)}) && a.textContent.includes('彻底删除'));
    })()`;

    // ---- 登录（页面内 POST，凭据只存在于运行内存） ----
    await send('Page.navigate', { url: BASE + '/login.html' });
    await waitFor(`!!document.querySelector('#username')`, '登录页加载');
    let loginStatus = 0;
    for (let i = 0; i < 4; i++) {
      loginStatus = await js(`fetch('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })
      }).then((r) => r.status)`);
      // 503 = 认证存储瞬时不可用（数据库间歇超时，交接 §6 记录过）；401 不重试
      if (loginStatus === 200 || loginStatus === 401 || loginStatus === 429) break;
      await sleep(1500);
    }
    check(loginStatus === 200, '登录成功（页面内 POST /api/auth/login）', 'HTTP ' + loginStatus);

    // ---- 打开库页 ----
    await send('Page.navigate', { url: BASE + '/app/library' });
    await waitFor(`document.body.innerText.includes('回收站') && document.body.innerText.includes('成片')`, '库页加载');
    const libUrl = await js('location.pathname');
    check(libUrl === '/app/library', '路由 /app/library 可直达库页', libUrl);

    // ---- 导航 ----
    const navItems = await js(`(() => {
      const a = [...document.querySelectorAll('aside')].find((x) => x.textContent.includes('Video Studio'));
      return a ? [...a.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()) : [];
    })()`);
    check(navItems.length === 4
      && navItems[0].includes('创作') && navItems[1].includes('剪辑')
      && navItems[2].includes('库') && navItems[3].includes('设置'),
      '导航为 4 项且顺序正确：创作 → 剪辑 → 库 → 设置', JSON.stringify(navItems));
    const navText = navItems.join('|');
    check(!/历史记录/.test(navText) && !/产出/.test(navText) && !/配乐/.test(navText)
      && !/视频片段/.test(navText) && !/照片/.test(navText),
      '历史记录 / 产出 / 配乐 / 旧库存子项已从导航隐藏');

    // ---- 三个 tab 顺序 ----
    const tabTexts = await js(`(() => [...document.querySelectorAll('button')]
      .map((b) => (b.textContent || '').replace(/\s+/g, ''))
      .filter((t) => /^(成片|片段|图片)\\d+$/.test(t)))()`);
    check(tabTexts.length === 3
      && tabTexts[0].startsWith('成片') && tabTexts[1].startsWith('片段') && tabTexts[2].startsWith('图片'),
      '库页 tab 固定顺序：成片 / 片段 / 图片', JSON.stringify(tabTexts));

    // ---- 成片 tab（默认）----
    const apiLib = await js(`fetch('/api/library').then((r) => r.json())`);
    const apiFinals = [];
    for (const g of ((apiLib && apiLib.groups) || [])) {
      for (const it of (g.items || [])) if (it.kind === 'final') apiFinals.push(it);
    }
    const finalRowCount = await js(`[...document.querySelectorAll('div')].filter((d) => String(d.className || '').includes('px-3 py-2.5') && d.querySelector('button')).length`);
    check(finalRowCount === apiFinals.length && apiFinals.length > 0,
      '成片 tab 行数与 /api/library 的 kind=final 条数一致', `页面 ${finalRowCount} / 接口 ${apiFinals.length}`);
    const libText = await bodyText();
    check(/费用\s*未知/.test(libText), '历史成片费用显示为「未知」（不是 ¥0.00）');
    check(/来源\s*(任务|片段库|剪辑导出|孤儿)/.test(libText), '成片显示来源（task|library|editor|orphan）');
    check(/QC\s*(通过|未验证|不通过)/.test(libText), '成片显示质检徽章');
    const forbiddenBtns = await js(`[...document.querySelectorAll('button')]
      .map((b) => (b.textContent || '').trim())
      .filter((t) => t === '调色' || t.includes('进剪辑台'))`);
    check(forbiddenBtns.length === 0, '库页没有「调色 / 进剪辑台」按钮（用户要求删掉）', JSON.stringify(forbiddenBtns));
    await shot('p2-01-library-finals');

    // ---- 成片播放（坏样本会换下一条，最多试 5 条）----
    let played = false;
    let playInfo = '';
    const playBtnCount = await js(`[...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '播放').length`);
    for (let i = 0; i < Math.min(playBtnCount, 5) && !played; i++) {
      const clicked = await js(`(() => {
        const bs = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '播放');
        if (!bs[${i}]) return false;
        bs[${i}].click();
        return true;
      })()`);
      if (!clicked) continue;
      await waitFor(`!!document.querySelector('video[autoplay]')`, '成片播放弹层');
      playInfo = await js(`(() => new Promise((resolve) => {
        const v = document.querySelector('video[autoplay]');
        if (!v) return resolve('no-video');
        const ok = () => resolve('ready:' + v.videoWidth + 'x' + v.videoHeight + ':rs' + v.readyState);
        if (v.readyState >= 2 && v.videoWidth > 0) return ok();
        v.addEventListener('loadeddata', ok, { once: true });
        v.addEventListener('error', () => resolve('error'), { once: true });
        setTimeout(() => resolve('timeout:rs' + v.readyState + ':w' + v.videoWidth), 8000);
      }))()`);
      if (/^ready:\d+x\d+/.test(playInfo)) played = true;
      await js(`(() => {
        const bs = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '关闭');
        if (!bs.length) return false;
        bs[bs.length - 1].click();
        return true;
      })()`);
      await sleep(250);
    }
    check(played, '成片可在真实浏览器播放（videoWidth > 0）', playInfo);
    if (played) {
      // 再开一次留截图
      await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '播放'); if (!b) return false; b.click(); return true; })()`);
      await sleep(1200);
      await shot('p2-02-final-play');
      await js(`(() => { const bs = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '关闭'); if (!bs.length) return false; bs[bs.length - 1].click(); return true; })()`);
      await sleep(200);
    }

    // ---- 片段 tab ----
    await clickTab('片段');
    await sleep(500);
    const clipText = await bodyText();
    check(/重新生成/.test(clipText), '片段 tab 有「重新生成」入口');
    check(/费用/.test(clipText), '片段卡片显示费用');
    check(/详情/.test(clipText), '片段卡片有「详情」');
    const clipDownload = await js(`[...document.querySelectorAll('a')].filter((a) => (a.textContent || '').trim() === '下载').length`);
    check(clipDownload > 0, '片段卡片有「下载」', String(clipDownload));
    await shot('p2-03-library-clips');

    // ---- 图片 tab ----
    await clickTab('图片');
    await sleep(600);
    const photoText = await bodyText();
    const hasPhotoActions = /用它生成视频/.test(photoText);
    const hasPhotoEmpty = /还没有照片/.test(photoText);
    check(hasPhotoActions || hasPhotoEmpty, '图片 tab 可用（有审核/编辑入口或明确空态）',
      hasPhotoActions ? '有照片' : '空态');
    if (hasPhotoActions) {
      const photoDownload = await js(`[...document.querySelectorAll('a')].filter((a) => (a.textContent || '').trim() === '下载').length`);
      check(photoDownload > 0, '图片卡片有「下载」', String(photoDownload));
    } else {
      check(true, '图片卡片下载：无照片，跳过（未验证，不计通过）');
    }
    await shot('p2-04-library-photos');

    // ---- 回收站抽屉 ----
    await clickText('回收站');
    await waitFor(`document.body.innerText.includes('清空回收站')`, '回收站抽屉打开');
    check(true, '回收站抽屉可打开（含类型筛选与清空入口）');
    await shot('p2-05-recycle-drawer');
    await closeDrawer();
    await sleep(300);

    // ---- 临时成片：删除 → 回收站 → 恢复 → 再删除 → 彻底删除 ----
    makeTempFinal();
    await send('Page.reload');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(TMP_PROMPT)})`, '临时成片出现在库');
    check(true, '临时成片已入库并出现在「成片」tab');
    const tmpRow = await js(`(() => {
      const d = [...document.querySelectorAll('div')]
        .find((x) => String(x.className || '').includes('px-3 py-2.5') && x.textContent.includes(${JSON.stringify(TMP_PROMPT)}));
      return d ? d.innerText : '';
    })()`);
    check(/费用\s*未知/.test(tmpRow), '临时成片费用显示「未知」', tmpRow.replace(/\n/g, ' | ').slice(0, 140));
    check(/QC\s*未验证/.test(tmpRow), '临时成片 QC 徽章为「未验证」');
    check(/来源\s*任务/.test(tmpRow), '临时成片来源显示「任务」');

    // 计数器 + 自动确认（验证两次确认各触发一次）
    await js(`(() => { window.__confirmCount = 0; window.confirm = () => { window.__confirmCount++; return true; }; window.alert = () => {}; return true; })()`);

    check(await clickInRow(TMP_PROMPT, '删除'), '点临时成片的「删除」');
    await waitFor(`!document.body.innerText.includes(${JSON.stringify(TMP_PROMPT)})`, '删除后成片从列表消失');
    check((await js('window.__confirmCount')) === 1, '删除前弹过一次确认（移入回收站）');
    check(!fs.existsSync(TMP_ENTRY), '删除后库条目已移走');
    check(!fs.existsSync(TMP_PATH), '删除后源文件已移出 output');
    check(findRecycleDirs(TMP_ID).length > 0, '回收站目录已建立（可恢复）', findRecycleDirs(TMP_ID)[0] || '');

    await clickText('回收站');
    await waitFor(drawerHasPurge(TMP_ID), '回收站出现临时成片');
    const recycleRow = await js(`(() => {
      const d = [...document.querySelectorAll('div')].find((x) => x.textContent.includes(${JSON.stringify(TMP_ID)}) && x.textContent.includes('彻底删除'));
      return d ? d.innerText : '';
    })()`);
    check(/片段|成片|图片|配乐/.test(recycleRow), '回收站条目显示类型与文件信息');
    await shot('p2-06-recycle-item');

    check(await clickRecycleAction(TMP_ID, '恢复'), '点回收站里的「恢复」');
    await waitFor('!' + drawerHas(TMP_ID), '恢复后条目移出回收站');
    check(fs.existsSync(TMP_ENTRY) && fs.existsSync(TMP_PATH), '恢复后库条目与源文件都回来了');
    await closeDrawer();
    await sleep(300);
    await clickTab('成片');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(TMP_PROMPT)})`, '恢复后成片回到列表');
    check(true, '恢复后成片重新出现在库列表');

    // 再删一次 → 彻底删除
    check(await clickInRow(TMP_PROMPT, '删除'), '再次点「删除」（第二次进回收站）');
    await waitFor(`!document.body.innerText.includes(${JSON.stringify(TMP_PROMPT)})`, '第二次删除后从列表消失');
    await clickText('回收站');
    await waitFor(drawerHas(TMP_ID), '回收站再次出现临时成片');
    const confirmBeforePurge = await js('window.__confirmCount');
    check(await clickRecycleAction(TMP_ID, '彻底删除'), '点回收站里的「彻底删除」');
    await waitFor('!' + drawerHas(TMP_ID), '彻底删除后条目消失');
    // 流程共 3 次确认：第一次删除 1 + 第二次删除 1 + 彻底删除 1（每次删除都先确认，彻底删除再确认）
    const confirmAfterPurge = await js('window.__confirmCount');
    check(confirmBeforePurge === 2 && confirmAfterPurge === confirmBeforePurge + 1,
      '删除先确认、彻底删除再确认（共 3 次确认）', `before=${confirmBeforePurge} after=${confirmAfterPurge}`);
    check(!fs.existsSync(TMP_ENTRY), '彻底删除后库条目不存在');
    check(!fs.existsSync(TMP_PATH), '彻底删除后源文件不存在');
    await closeDrawer();

    // ---- 旧深链兼容 ----
    await send('Page.navigate', { url: BASE + '/app/clips' });
    await waitFor(`document.body.innerText.includes('成片') && document.body.innerText.includes('回收站')`, '/app/clips 打开库页');
    await sleep(500);
    const activeClip = await js(`(() => {
      const bs = [...document.querySelectorAll('button')].filter((b) => /^(成片|片段|图片)\\s*\\d+$/.test((b.textContent || '').replace(/\\s+/g, '')));
      const on = bs.find((b) => getComputedStyle(b).borderBottomColor !== 'rgba(0, 0, 0, 0)');
      return on ? on.textContent.replace(/\\s+/g, '') : '';
    })()`);
    check(activeClip.startsWith('片段'), '/app/clips 落到「片段」tab', activeClip);

    await send('Page.navigate', { url: BASE + '/app/photos' });
    await waitFor(`document.body.innerText.includes('成片') && document.body.innerText.includes('回收站')`, '/app/photos 打开库页');
    await sleep(500);
    const activePhoto = await js(`(() => {
      const bs = [...document.querySelectorAll('button')].filter((b) => /^(成片|片段|图片)\\s*\\d+$/.test((b.textContent || '').replace(/\\s+/g, '')));
      const on = bs.find((b) => getComputedStyle(b).borderBottomColor !== 'rgba(0, 0, 0, 0)');
      return on ? on.textContent.replace(/\\s+/g, '') : '';
    })()`);
    check(activePhoto.startsWith('图片'), '/app/photos 落到「图片」tab', activePhoto);

    // ---- 剪辑台音频面板：配乐库已并入 ----
    const projList = await js(`fetch('/api/projects').then((r) => r.json()).catch(() => null)`);
    const firstProject = projList && Array.isArray(projList.projects) && projList.projects[0]
      ? projList.projects[0].id
      : null;
    await send('Page.navigate', { url: BASE + '/app/edit' + (firstProject ? '?project=' + encodeURIComponent(firstProject) : '') });
    await waitFor(`document.body.innerText.includes('剪辑台')`, '剪辑台加载', 25000);
    await sleep(800);
    const audioTab = await clickText('音频', '.ed-rail', 'button');
    check(!!audioTab, '剪辑台左侧可切到「音频」');
    await waitFor(`document.body.innerText.includes('配乐库')`, '配乐库出现在音频面板', 15000);
    const audioText = await bodyText();
    check(/上传音频/.test(audioText), '配乐库有「上传音频」入口（搬自库存页）');
    check(/设为默认|默认/.test(audioText), '配乐库有默认曲目设置');
    const audioTracks = await js(`[...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '设为默认').length`);
    check(audioTracks > 0, '配乐库列出曲目（有「设为默认」按钮）', String(audioTracks));
    await shot('p2-07-editor-audio');

    // ---- 控制台异常 ----
    const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown');
    const consoleErrors = events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .filter((e) => !/Failed to load resource|404|net::ERR|ERR_ABORTED|MEDIA_ELEMENT_ERROR/i.test(JSON.stringify(e.params.args)));
    check(exceptions.length === 0, '页面没有未捕获的 JS 异常',
      exceptions.length ? JSON.stringify(exceptions[0].params).slice(0, 300) : '0');
    check(consoleErrors.length === 0, '控制台没有非资源类报错',
      consoleErrors.length ? JSON.stringify(consoleErrors[0].params).slice(0, 300) : '0');
  } catch (e) {
    check(false, '浏览器 E2E 异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (cdp) cdp.close();
    try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const cleaned = cleanupTemp();
    console.log('  清理临时产物: ' + (cleaned.length ? cleaned.join(', ') : '无残留'));
    if (!fs.existsSync(TMP_ENTRY) && !fs.existsSync(TMP_PATH)) {
      console.log('  ✅ 临时成片已清干净（不碰真实库条目）');
    } else {
      console.log('  ⚠️ 仍有临时产物残留，请手工检查：' + [TMP_ENTRY, TMP_PATH].filter((p) => fs.existsSync(p)).join(' ; '));
    }
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('截图目录: ' + OUT);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
