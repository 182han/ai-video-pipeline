// ============================================================
// F11 导航重组验收
// ------------------------------------------------------------
// 1) 静态：去掉「配乐编辑器」入口；/bgm 旧链接落到剪辑台；四段式导航
// 2) 运行时：/app/bgm 返回 SPA；browser 取到的 shell.js 已是新路由
//
// 用法：node scripts/verify-editor-nav.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_NAV_PORT || 3221);

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
  console.log('F11 导航重组验收');
  console.log('================================================================');

  const shell = read(path.join(WEB, 'src', 'screens', 'shell.js'));

  check(!/label: '配乐编辑器'/.test(shell), '不再出现「配乐编辑器」入口');
  check(!/key: 'bgm'/.test(shell), 'NAV 移除 bgm 项');
  check(/route\.startsWith\('\/bgm'\)\) return 'edit'/.test(shell), '/bgm 落到剪辑台');
  check(!/BgmEditorView/.test(shell), '不再加载独立配乐编辑器');
  check(!/bgm: '\/bgm'/.test(shell), 'routeOf 移除 bgm');
  check(/section: '库存'/.test(shell) && /section: '记录'/.test(shell), '库存/记录两段');
  const navItems = (shell.match(/\{ key: '/g) || []).length;
  check(navItems === 7, '导航项数量（创作/剪辑 + 库存3 + 记录2）', String(navItems));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_nav_'));
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
          PROJECTS_DIR: path.join(tmp, 'projects'),
          THUMBS_DIR: path.join(tmp, 'thumbs')
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
      let r = await fetch(base + '/app/bgm');
      const html = await r.text();
      check(r.status === 200 && /id="root"/.test(html), '/app/bgm 返回 SPA');

      r = await fetch(base + '/app/src/screens/shell.js');
      const js = await r.text();
      check(r.status === 200 && !/label: '配乐编辑器'/.test(js), '浏览器取到的 shell.js 已去掉旧入口');
      check(/startsWith\('\/bgm'\)\) return 'edit'/.test(js), '浏览器取到的 /bgm 路由正确');

      r = await fetch(base + '/app/edit');
      check(r.status === 200, '/app/edit 仍可访问');
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
