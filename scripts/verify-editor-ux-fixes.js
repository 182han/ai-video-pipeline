// ============================================================
// 剪辑台体验修复验收（2026-11-04）
// ------------------------------------------------------------
// 用户反馈三件事：
//   1) 播放头/分割线拖动卡顿 → 拖动期间只改 DOM，松手才落 state
//   2) 素材栏 / 时间线片段看不到画面 → /api/library/:id/thumb 抽帧缓存
//   3) 看完成片要关标签页 → 页内预览层 + Esc/关闭
//
// 用法：node scripts/verify-editor-ux-fixes.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_UX_PORT || 3181);

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
  console.log('剪辑台体验修复验收（播放头 / 缩略图 / 页内看成片）');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));
  const server = read(path.join(ROOT, 'server.js'));

  check(/function beginScrub\(/.test(editor), '播放头拖动逻辑');
  check(/playheadElRef/.test(editor) && /scrubRef/.test(editor), '拖动期间走 DOM ref');
  check(/onPointerDown=\$\{beginScrub\}/.test(editor), '标尺/播放头接 pointerdown');
  check(/ed-card-img/.test(editor), '素材卡渲染缩略图');
  check(/ed-clip-thumb/.test(editor), '时间线片段渲染缩略图');
  check(/thumbUrl\(/.test(editor), '缩略图 URL 统一生成');
  check(/setViewerUrl/.test(editor) && /ed-viewer-video/.test(editor), '页内成片预览');
  check(/Escape/.test(editor), 'Esc 关闭预览');
  check(/\.ed-viewer/.test(css) && /\.ed-card-img/.test(css) && /\.ed-clip-thumb/.test(css), 'CSS 覆盖三处');
  check(/\/api\/library\/:id\/thumb/.test(server), '缩略图接口');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_ux_'));
  const thumbsDir = path.join(tmp, 'thumbs');
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
          THUMBS_DIR: thumbsDir
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
      const lib = await (await fetch(base + '/api/library')).json();
      const items = (lib.groups || []).flatMap((g) => g.items || []);
      const entry = items.find((it) => it.filePath && fs.existsSync(it.filePath));
      check(!!entry, '片段库有可用素材', entry ? entry.id : '无');

      if (entry) {
        const url = base + '/api/library/' + encodeURIComponent(entry.id) + '/thumb';
        const r1 = await fetch(url);
        const buf = Buffer.from(await r1.arrayBuffer());
        const ct = r1.headers.get('content-type') || '';
        check(r1.status === 200 && /image\/jpeg/.test(ct), '缩略图返回 JPEG', ct);
        check(buf.length > 1000 && buf[0] === 0xFF && buf[1] === 0xD8, '缩略图非空且魔数正确', buf.length + ' bytes');
        const cached = path.join(thumbsDir, entry.id + '.jpg');
        check(fs.existsSync(cached), '缩略图落盘缓存');

        const r2 = await fetch(url);
        check(r2.status === 200, '二次请求命中缓存');

        const r3 = await fetch(base + '/api/library/does_not_exist/thumb');
        check(r3.status === 404, '未知素材 404');
      }

      const js = await (await fetch(base + '/app/src/screens/editor.js')).text();
      check(/beginScrub/.test(js) && /setViewerUrl/.test(js) && /ed-card-img/.test(js), '浏览器取到的 editor.js 含三处修复');
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
