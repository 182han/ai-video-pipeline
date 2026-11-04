// ============================================================
// 剪辑台素材面板验收（F03）
// ------------------------------------------------------------
// 1) 静态：素材面板接 /api/library、网格/搜索/拖拽/点击入轨、按真实时长排版、保存到工程
// 2) 运行时：临时服务上读片段库，把片段写进工程并回读
//
// 用法：node scripts/verify-editor-media.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_MEDIA_PORT || 3151);

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
  console.log('剪辑台素材面板验收（F03）');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));

  check(/\/api\/library/.test(editor), '素材面板读取 /api/library');
  check(/ed-grid/.test(editor) && /ed-card/.test(editor), '素材网格与卡片存在');
  check(/draggable=\$\{true\}/.test(editor), '素材卡可拖拽');
  check(/onDragStart/.test(editor) && /onDropClip/.test(editor), '拖拽入轨接线');
  check(/onDrop=\$\{onDropClip\}/.test(editor), '时间线接住 drop');
  check(/function addClip\(/.test(editor), '点击加入时间线');
  check(/commitSegments\(\[\.\.\.segmentsRef\.current, seg\]\)/.test(editor), '入轨写回工程 segments');
  check(/segDuration\(/.test(editor), '按真实入出点计算时长');
  check(/left: acc \* pps/.test(editor), '时间线按秒×缩放排版');
  check(/setPps/.test(editor), '时间线缩放可调');
  check(/fmtDur\(it\.durationSec\)/.test(editor), '卡片显示素材时长');
  check(/ed-clip/.test(editor), '时间线片段渲染');
  check(/\.ed-grid/.test(css) && /\.ed-card/.test(css), 'CSS 含素材网格样式');
  check(/\.ed-track\.over/.test(css), 'CSS 含拖入高亮');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_media_'));
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
      let r = await fetch(base + '/api/library');
      const lib = await r.json();
      check(r.status === 200 && Array.isArray(lib.groups), '片段库接口返回 groups');
      const first = (lib.groups || []).flatMap((g) => g.items || [])[0];

      const seg = first
        ? { assetId: first.id, inSec: 0, outSec: Number(first.durationSec) || 3 }
        : { assetId: 'lib_fake', inSec: 0, outSec: 3 };

      r = await fetch(base + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '素材验收', segments: [seg] })
      });
      const pj = await r.json();
      check(r.status === 200 && pj.project.segments.length === 1, '工程接受素材片段');
      check(pj.project.segments[0].assetId === seg.assetId, '片段 assetId 保留');

      r = await fetch(base + '/api/projects/' + pj.project.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: pj.project.revision, segments: [seg, seg] })
      });
      const pj2 = await r.json();
      check(r.status === 200 && pj2.project.segments.length === 2, '再次入轨后 segments=2');

      r = await fetch(base + '/api/projects/' + pj.project.id);
      const pj3 = await r.json();
      check(r.status === 200 && pj3.project.segments.length === 2, '回读工程一致');

      const js = await (await fetch(base + '/app/src/screens/editor.js')).text();
      check(/addClip/.test(js) && /api\/library/.test(js), '浏览器取到的 editor.js 含素材接线');
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
