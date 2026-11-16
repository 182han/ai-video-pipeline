// ============================================================
// P3 剪辑台接成片：真浏览器端到端验收（2026-11-15）
// ------------------------------------------------------------
// 背景：P3 要求「素材栏三来源（片段/成片/图片）、成片整段载入且可裁、导出归成片」。
//       静态断言只能证明代码里有字符串，证明不了点击之后时间线/工程真的变了。
//
// 做法（沿用 web/verify/p2-library-e2e.js 先例）：
//   1) 连接**已经在跑的** 3001 单实例（绝不另起服务 / 端口）；
//   2) headless Chrome + CDP，页面内 POST /api/auth/login
//      （账号密码运行时从 app/config.js 读取，不打印、不入库、不落盘）；
//   3) 真点击：素材来源切换 → 成片整段载入 → 拖手柄裁剪（右→左、左→右、越界钳制）
//      → 片段来源再入一段 → 图片来源确认「首版后置」不入轨 → 刷新后工程仍在；
//   4) **不触发导出**（导出会写真实「库·成片」+ 真实 output/）。
//      导出归库与 ffprobe 数值由 scripts/verify-editor-final-source.js 在隔离实例里验收；
//   5) 临时工程由脚本创建/删除（只动自己建的那一个），截图落 docs/交接/p3-screenshots/。
//
// 用法：cd app && node web/verify/p3-editor-e2e.js
// 退出码 0 = 全部通过；非 0 = 有失败（未验证不算通过）。
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..');
const OUT = path.join(APP, 'docs', '交接', 'p3-screenshots');
const BASE = 'http://127.0.0.1:3001';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

let pass = 0;
let fail = 0;
let finalCode = 0;
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

(async () => {
  console.log('================================================================');
  console.log('P3 剪辑台接成片：真浏览器端到端验收（连接运行中的 3001，单实例）');
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
  if (!PASS) { console.log('  ❌ 无法从 config 读取登录密码，无法打开剪辑台'); process.exit(1); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-e2e-'));
  const debugPort = 9462;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter', '--mute-audio', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  let projectId = null;
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
    const apiGet = (p) => js(`fetch(${JSON.stringify(p)}).then((r) => r.json())`);
    const project = () => apiGet('/api/projects/' + projectId);
    const projSegs = async () => ((await project()) || {}).project || { segments: [] };

    // ---- 登录（页面内 POST，凭据只存在于运行内存） ----
    await send('Page.navigate', { url: BASE + '/login.html' });
    await waitFor(`!!document.querySelector('#username')`, '登录页加载');
    let loginStatus = 0;
    for (let i = 0; i < 4; i++) {
      loginStatus = await js(`fetch('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })
      }).then((r) => r.status)`);
      if (loginStatus === 200 || loginStatus === 401 || loginStatus === 429) break;
      await sleep(1500);
    }
    check(loginStatus === 200, '登录成功（页面内 POST /api/auth/login）', 'HTTP ' + loginStatus);

    // ---- 打开剪辑台 ----
    await send('Page.navigate', { url: BASE + '/app/edit' });
    await waitFor(`!!document.querySelector('.ed-root') && !!document.querySelector('[data-media-source="clip"]')`, '剪辑台加载', 25000);
    await waitFor(`!document.body.innerText.includes('正在打开剪辑台')`, '工程就绪', 20000);
    projectId = await js(`new URLSearchParams(location.search).get('project')`);
    check(!!projectId && /^proj_/.test(projectId), '剪辑台已绑定工程', projectId || '无');
    if (!projectId) return finish();

    // ---- 素材来源：三个 tab 顺序与计数 ----
    const srcInfo = await js(`(() => [...document.querySelectorAll('[data-media-source]')]
      .map((b) => ({ key: b.getAttribute('data-media-source'), text: (b.textContent || '').replace(/\\s+/g, '') })))()`);
    check(srcInfo.length === 3 && srcInfo[0].key === 'clip' && srcInfo[1].key === 'final' && srcInfo[2].key === 'photo',
      '素材栏三个来源：片段 / 成片 / 图片（顺序固定）', JSON.stringify(srcInfo));
    const srcLabels = srcInfo.map((s) => s.text);
    check(srcLabels[0].startsWith('片段') && srcLabels[1].startsWith('成片') && srcLabels[2].startsWith('图片'),
      '来源标签文案正确', JSON.stringify(srcLabels));

    // ---- 接口数据（用于核对页面） ----
    const libApi = await apiGet('/api/library');
    const allItems = [];
    for (const g of ((libApi && libApi.groups) || [])) for (const it of (g.items || [])) allItems.push(it);
    const apiFinals = allItems.filter((it) => it.kind === 'final');
    const apiClips = allItems.filter((it) => it.kind !== 'final');
    const photoApi = await apiGet('/api/photos');
    const apiPhotos = (photoApi && photoApi.photos) || [];
    check(apiFinals.length > 0 && apiClips.length > 0, '库里有成片与片段可测',
      `成片 ${apiFinals.length} / 片段 ${apiClips.length} / 图片 ${apiPhotos.length}`);

    // 选中一条短成片（导出不在本脚本做，选短的是为了让预览/裁剪更快）
    const pickFinal = apiFinals
      .filter((it) => (Number(it.durationSec) || 0) >= 4)
      .sort((a, b) => (Number(a.durationSec) || 0) - (Number(b.durationSec) || 0))[0] || apiFinals[0];
    const pickClip = apiClips
      .filter((it) => (Number(it.durationSec) || 0) >= 1)
      .sort((a, b) => (Number(a.durationSec) || 0) - (Number(b.durationSec) || 0))[0] || apiClips[0];
    check(!!pickFinal && !!pickClip, '选定测试素材', `${pickFinal.id} ${pickFinal.durationSec}s / ${pickClip.id} ${pickClip.durationSec}s`);
    const finalDur = Number(pickFinal.durationSec) || 0;

    // ---- 片段 tab（默认）：只显示片段 ----
    const clipCardCount = await js(`document.querySelectorAll('.ed-card[data-kind="clip"]').length`);
    check(clipCardCount === Math.min(120, apiClips.length), '片段 tab 卡片数 = 接口片段数（不含成片）',
      `页面 ${clipCardCount} / 接口 ${apiClips.length}`);
    const clipIds = await js(`[...document.querySelectorAll('.ed-card[data-kind="clip"]')].map((b) => b.getAttribute('data-asset-id'))`);
    check(!clipIds.some((id) => id.endsWith('_final')), '片段 tab 里没有混入成片条目');

    // ---- 成片 tab ----
    await js(`document.querySelector('[data-media-source="final"]').click()`);
    await waitFor(`document.querySelectorAll('.ed-card[data-kind="final"]').length > 0`, '成片 tab 卡片');
    const finalCardCount = await js(`document.querySelectorAll('.ed-card[data-kind="final"]').length`);
    check(finalCardCount === Math.min(120, apiFinals.length), '成片 tab 卡片数 = 接口 kind=final 数',
      `页面 ${finalCardCount} / 接口 ${apiFinals.length}`);
    const finalMeta = await js(`(() => {
      const c = document.querySelector('[data-asset-id=${JSON.stringify(pickFinal.id)}]');
      return c ? { text: (c.textContent || '').replace(/\\s+/g, ' ').trim(), title: c.getAttribute('title') || '' } : null;
    })()`);
    check(!!finalMeta && /成片/.test(finalMeta.text), '成片卡显示「成片」标识与时长', finalMeta ? finalMeta.text.slice(0, 80) : '未找到卡');
    check(!!finalMeta && /整段载入/.test(finalMeta.title), '成片卡提示「点击整段载入」', finalMeta ? finalMeta.title.slice(0, 80) : '');
    const noteText = await js(`(() => { const n = document.querySelector('.ed-note'); return n ? n.textContent : ''; })()`);
    check(/整段载入/.test(noteText) && /裁/.test(noteText), '成片来源有「整段载入 + 可裁」提示', noteText || '无');
    await shot('p3-01-sources-finals');

    // ---- 点击成片 → 整段载入 ----
    await js(`document.querySelector('[data-asset-id=${JSON.stringify(pickFinal.id)}]').click()`);
    await waitFor(`!!document.querySelector('.ed-toast')`, '载入提示');
    const toast1 = await js(`(() => { const t = document.querySelector('.ed-toast'); return t ? t.textContent : ''; })()`);
    check(/整段载入成片/.test(toast1), '点击成片给出「整段载入」提示', toast1 || '无');
    await waitFor(`fetch('/api/projects/${projectId}').then((r) => r.json()).then((j) => (j.project.segments || []).length === 1)`, '工程写入 1 段', 8000);
    let segs = await projSegs();
    check(segs.segments.length === 1 && segs.segments[0].assetId === pickFinal.id,
      '成片进入时间线且 assetId 正确', JSON.stringify(segs.segments[0] || {}));
    check(segs.segments[0] && segs.segments[0].inSec === 0 && Math.abs(Number(segs.segments[0].outSec) - finalDur) < 0.01,
      '成片默认整段载入（in=0，out=全长）', `${segs.segments[0] && segs.segments[0].inSec}–${segs.segments[0] && segs.segments[0].outSec}s / 全长 ${finalDur}s`);
    const uiClipCount = await js(`document.querySelectorAll('.ed-clip').length`);
    check(uiClipCount === 1, '时间线渲染 1 段', String(uiClipCount));
    check(await js(`document.querySelectorAll('.ed-clip .ed-handle.l, .ed-clip .ed-handle.r').length >= 2`),
      '时间线片段有左右裁剪手柄');
    await shot('p3-02-final-loaded');

    // ---- 整段可裁：右把手 → 左（裁掉 ~1/3 长度） ----
    const PPS = 26; // 编辑器默认 pps=26（px/秒）
    const trimDeltaSec = Math.min(2, Math.max(1, Math.round(finalDur / 3 * 10) / 10));
    const inDeltaSec = Math.min(1, Math.round(finalDur / 4 * 10) / 10);
    const trim = (side, delta) => js(`(() => {
      const h = document.querySelectorAll('.ed-clip .ed-handle.${side}')[0];
      if (!h) return 'no-handle';
      const r = h.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, buttons: 1 };
      h.dispatchEvent(new PointerEvent('pointerdown', opts));
      document.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, opts, { clientX: x + ${delta} })));
      document.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { clientX: x + ${delta}, buttons: 0 })));
      return 'ok';
    })()`);
    const t1 = await trim('r', -trimDeltaSec * PPS);
    check(t1 === 'ok', '右把手可拖动', String(t1));
    await sleep(1200);
    segs = await projSegs();
    const outAfter = Number(segs.segments[0] && segs.segments[0].outSec);
    check(t1 === 'ok' && Math.abs(outAfter - (finalDur - trimDeltaSec)) <= 0.35,
      `拖右把手 −${trimDeltaSec}s → 成片被裁短（入出点进工程）`, `out ${outAfter}s（原 ${finalDur}s）`);

    // ---- 左把手 → 右（入点后移） ----
    const t2 = await trim('l', inDeltaSec * PPS);
    await sleep(1200);
    segs = await projSegs();
    const inAfter = Number(segs.segments[0] && segs.segments[0].inSec);
    check(t2 === 'ok' && Math.abs(inAfter - inDeltaSec) <= 0.35, `拖左把手 +${inDeltaSec}s → 入点后移`, `in ${inAfter}s`);

    // ---- 越界：右把手向右拖很远 → outSec 不得超素材全长 ----
    await trim('r', 10000);
    await sleep(1200);
    segs = await projSegs();
    const outClamp = Number(segs.segments[0] && segs.segments[0].outSec);
    check(outClamp <= finalDur + 0.01 && outClamp > finalDur - 0.2,
      '出点越界被钳制在成片全长（不会裁到素材之外）', `out ${outClamp}s / 全长 ${finalDur}s`);
    const clipDurText = await js(`(() => { const d = document.querySelector('.ed-clip-dur'); return d ? d.textContent.trim() : ''; })()`);
    check(!!clipDurText, '时间线显示裁剪后时长', clipDurText || '');
    await shot('p3-03-final-trimmed');

    // ---- 切回片段来源，再入一段 ----
    await js(`document.querySelector('[data-media-source="clip"]').click()`);
    await waitFor(`document.querySelectorAll('.ed-card[data-kind="clip"]').length > 0`, '片段卡');
    await js(`document.querySelector('[data-asset-id=${JSON.stringify(pickClip.id)}]').click()`);
    await waitFor(`fetch('/api/projects/${projectId}').then((r) => r.json()).then((j) => (j.project.segments || []).length === 2)`, '第二段写入', 8000);
    segs = await projSegs();
    check(segs.segments.length === 2 && segs.segments[1].assetId === pickClip.id,
      '片段来源可再入一段（成片与片段同轨混排）', JSON.stringify(segs.segments.map((s) => s.assetId)));
    check(Math.abs(Number(segs.segments[1].outSec) - (Number(pickClip.durationSec) || 0)) < 0.01,
      '片段默认整段载入', `${segs.segments[1].outSec}s / ${pickClip.durationSec}s`);

    // ---- 图片来源：首版后置；文件缺失的条目按用户口径不显示 ----
    await js(`document.querySelector('[data-media-source="photo"]').click()`);
    await sleep(600);
    const photoNote = await js(`(() => { const n = document.querySelector('.ed-note'); return n ? n.textContent : ''; })()`);
    check(/首版后置/.test(photoNote), '图片来源明确写「首版后置」', photoNote || '无');
    check(apiPhotos.every((p) => !p.fileMissing), '接口默认不返回文件缺失的图片',
      `返回 ${apiPhotos.length} 张，已隐藏 ${photoApi.hiddenMissing || 0} 张`);
    // includeMissing=1 必须还能拿到全量（数据没删，只影响展示）
    const fullPhotoApi = await apiGet('/api/photos?includeMissing=1');
    const fullPhotos = (fullPhotoApi && fullPhotoApi.photos) || [];
    check(fullPhotos.length === apiPhotos.length + (photoApi.hiddenMissing || 0),
      '?includeMissing=1 可取回被隐藏的图片（数据未删）',
      `默认 ${apiPhotos.length} + 隐藏 ${photoApi.hiddenMissing || 0} = 全量 ${fullPhotos.length}`);
    const photoCardCount = await js(`document.querySelectorAll('[data-photo-id]').length`);
    check(photoCardCount === Math.min(120, apiPhotos.length), '图片 tab 卡片数 = 接口可见图片数',
      `页面 ${photoCardCount} / 接口 ${apiPhotos.length}`);
    if (apiPhotos.length === 0) {
      const emptyText = await js(`document.body.innerText`);
      check(/图片库为空/.test(emptyText), '无可见图片时显示空态（不出现破图/缺失卡）');
      const imgs = await js(`[...document.querySelectorAll('.ed-grid img')].filter((i) => i.src && !i.style.visibility).length`);
      check(imgs === 0, '图片 tab 没有渲染不可用图片', String(imgs));
    }
    const firstPhotoId = await js(`(() => { const p = document.querySelector('[data-photo-id]'); return p ? p.getAttribute('data-photo-id') : ''; })()`);
    if (firstPhotoId) await js(`document.querySelector('[data-photo-id=${JSON.stringify(firstPhotoId)}]').click()`);
    await sleep(900);
    segs = await projSegs();
    check(segs.segments.length === 2, '点击图片不会加入时间线（首版后置，不无声失败）', `${segs.segments.length} 段`);
    await shot('p3-04-photo-source');

    // ---- 导出按钮存在（不点击：导出会写真实库与 output） ----
    const exportBtn = await js(`(() => {
      const b = [...document.querySelectorAll('.ed-top button')].find((x) => (x.textContent || '').trim() === '导出');
      return b ? { disabled: !!b.disabled, title: b.getAttribute('title') || '' } : null;
    })()`);
    check(!!exportBtn && !exportBtn.disabled && /成片/.test(exportBtn.title), '有片段时「导出」按钮可点（本脚本不点击）',
      exportBtn ? JSON.stringify(exportBtn) : '无');

    // ---- 刷新后工程仍在（保存链路） ----
    await send('Page.reload');
    await waitFor(`!!document.querySelector('.ed-root') && !!document.querySelector('[data-media-source="clip"]')`, '刷新后剪辑台', 25000);
    await waitFor(`!document.body.innerText.includes('正在打开剪辑台')`, '刷新后工程就绪', 20000);
    await sleep(500);
    segs = await projSegs();
    check(segs.segments.length === 2 && segs.segments[0].assetId === pickFinal.id,
      '刷新后工程仍是 2 段（裁剪与排序已保存）',
      JSON.stringify(segs.segments.map((s) => `${s.assetId}@${s.inSec}-${s.outSec}`)));
    const uiCount2 = await js(`document.querySelectorAll('.ed-clip').length`);
    check(uiCount2 === 2, '刷新后时间线仍渲染 2 段', String(uiCount2));
    await shot('p3-05-reloaded');

    // ---- 库页图片 tab 同样不显示文件缺失的条目 ----
    await send('Page.navigate', { url: BASE + '/app/library' });
    await waitFor(`document.body.innerText.includes('回收站') && document.body.innerText.includes('图片')`, '库页加载', 20000);
    await js(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^图片\\s*\\d+$/.test((x.textContent || '').replace(/\\s+/g, '')));
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(900);
    const libPhotoText = await js(`document.body.innerText`);
    check(/还没有照片/.test(libPhotoText), '库页图片 tab 因文件缺失全部隐藏 → 显示空态');
    const libPhotoCount = await js(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^图片\\s*\\d+$/.test((x.textContent || '').replace(/\\s+/g, '')));
      return b ? (b.textContent || '').replace(/\\s+/g, '') : '';
    })()`);
    check(/^图片0$/.test(libPhotoCount), '库页图片计数为 0（不显示缺失条目）', libPhotoCount);
    const libApi2 = await apiGet('/api/library');
    check((libApi2.hiddenMissing || 0) === 0, '成片/片段没有因文件缺失被隐藏',
      `隐藏 ${(libApi2.hiddenMissing || 0)} 条`);
    await shot('p3-06-library-photo-empty');

    // ---- 页面无未捕获异常 ----
    const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check(exceptions.length === 0, '页面无未捕获 JS 异常',
      exceptions.length ? JSON.stringify(exceptions[0].params).slice(0, 300) : '0 条');

    return finish();
  } catch (e) {
    check(false, '浏览器验收异常: ' + (e && e.message ? e.message : e));
    return finish();
  } finally {
    // 只删自己建的临时工程（不碰用户已有工程）；DELETE 走页面内登录态
    if (cdp) {
      try {
        if (projectId) {
          const s = await cdp.send('Runtime.evaluate', {
            expression: `fetch('/api/projects/${projectId}', { method: 'DELETE' }).then((r) => r.status)`,
            returnByValue: true, awaitPromise: true
          });
          console.log('  🧹 临时工程已删除: ' + projectId + '（HTTP ' + (s.result && s.result.value) + '）');
        }
      } catch (e) { /* ignore */ }
      cdp.close();
    }
    try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    // 清理完成后再退出（finish 只负责汇总与置退出码）
    process.exit(finalCode);
  }
})();

function finish() {
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  finalCode = fail === 0 ? 0 : 1;
}
