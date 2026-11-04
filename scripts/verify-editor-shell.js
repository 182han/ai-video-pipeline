// ============================================================
// 剪辑台工作台骨架验收（F02）
// ------------------------------------------------------------
// 1) 静态：/app/edit 走全屏 EditorView；四区标记与工程 API 接线存在；editor.css 被引入
// 2) 运行时：自起临时服务，确认 /app 页面、editor.js、shell.js 可达，
//    /api/projects 可建可读，/app/edit 返回 SPA 而不是登录页。
//
// 用法：node scripts/verify-editor-shell.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_TEST_PORT || 3141);

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  —  ' + extra : ''}`); }
}
const read = (p) => fs.readFileSync(p, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(url, ms = 800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return (await fetch(url, { signal: ac.signal })).status; }
  catch (e) { return 0; }
  finally { clearTimeout(timer); }
}
async function waitReady(base, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping(base + '/api/status')) return true;
    await sleep(400);
  }
  return false;
}

(async () => {
  console.log('================================================================');
  console.log('剪辑台工作台骨架验收（F02）');
  console.log('================================================================');

  // ---------- 静态 ----------
  const idx = read(path.join(WEB, 'index.html'));
  const shell = read(path.join(WEB, 'src', 'screens', 'shell.js'));
  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));

  check(/styles\/editor\.css/.test(idx), 'index.html 引入 editor.css');
  check(/from '\.\/editor\.js'/.test(shell), 'shell.js 引入 EditorView');
  check(/if \(view === 'edit'\)/.test(shell), 'shell.js 对 edit 走全屏分支');
  check(/<\$\{EditorView\} \/>/.test(shell), 'edit 分支直接渲染 EditorView（不套 Rail）');

  for (const m of ['ed-top', 'ed-left', 'ed-center', 'ed-right', 'ed-timeline']) {
    check(editor.includes(m), `工作台包含区域 ${m}`);
  }
  check(/\/api\/projects/.test(editor), '接入工程 API');
  check(/revision: revisionRef\.current/.test(editor), '保存带 revision');
  check(/SAVE_DEBOUNCE/.test(editor), '工程名自动保存防抖');
  check(/localStorage\.getItem\(LAST_KEY\)/.test(editor), '支持恢复上次工程');
  check(/ed-frame/.test(editor) && /ed-tracks|ed-ruler/.test(editor), '预览与时间线骨架存在');

  check(/grid-template-rows:\s*46px/.test(css), 'CSS 顶栏 + 主体 + 时间线三行');
  check(/grid-template-columns:\s*300px minmax\(0, 1fr\) 300px/.test(css), 'CSS 左中右三栏');

  // ---------- 运行时 ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_ed_'));
  let child = null;
  let base = null;
  try {
    for (let i = 0; i < 6 && !child; i++) {
      const port = START_PORT + i;
      const candidate = `http://${HOST}:${port}`;
      if (await ping(candidate + '/api/status')) continue;
      const c = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          AUTH_ENABLED: 'false',
          DATABASE_TYPE: 'json',
          DATA_DIR: path.join(tmp, 'tasks'),
          OUTPUT_DIR: path.join(tmp, 'output'),
          PROJECTS_DIR: path.join(tmp, 'projects')
        },
        stdio: 'ignore',
        windowsHide: true
      });
      c.on('error', () => {});
      if (await waitReady(candidate)) { child = c; base = candidate; }
      else { try { c.kill(); } catch (e) { /* ignore */ } }
    }
    check(!!child, '临时服务启动');
    if (child) {
      let r = await fetch(base + '/app');
      const html = await r.text();
      check(r.status === 200 && /styles\/editor\.css/.test(html), '/app 页面可访问且带 editor.css');

      r = await fetch(base + '/app/src/screens/editor.js');
      const js = await r.text();
      check(r.status === 200 && /EditorView/.test(js), 'editor.js 可被浏览器取到');

      r = await fetch(base + '/app/src/screens/shell.js');
      const sj = await r.text();
      check(r.status === 200 && /EditorView/.test(sj), 'shell.js 已更新为 EditorView');

      r = await fetch(base + '/app/edit?project=proj_test');
      const editHtml = await r.text();
      check(r.status === 200 && /id="root"/.test(editHtml), '/app/edit 返回 SPA 页面');

      r = await fetch(base + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '骨架验收' })
      });
      const j = await r.json();
      check(r.status === 200 && j.project && j.project.id, '工程可创建（骨架接线）');
    }
  } catch (e) {
    check(false, '运行时验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
