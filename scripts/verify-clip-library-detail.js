// ============================================================
// F10 片段库详情验收
// ------------------------------------------------------------
// 静态：详情弹层、型号/成本/QC/来源任务、重新生成入口
// 运行时：/api/library 条目确实带回这些字段（详情页不需要第二个接口）
//
// 用法：node scripts/verify-clip-library-detail.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.LIB_DETAIL_PORT || 3211);

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
  console.log('F10 片段库详情验收');
  console.log('================================================================');

  const inv = read(path.join(WEB, 'src', 'screens', 'inventory.js'));
  const server = read(path.join(ROOT, 'server.js'));

  check(/片段详情/.test(inv), '详情弹层');
  check(/setDetail/.test(inv) && /detail && html/.test(inv), '详情状态与渲染');
  check(/来源任务/.test(inv) && /detail\.taskId/.test(inv), '显示来源任务');
  check(/成本/.test(inv) && /costText\(detail\.cost\)/.test(inv), '显示成本');
  check(/质检/.test(inv) && /qcText\(detail\.qc\)/.test(inv), '显示 QC 结论');
  check(/型号/.test(inv) && /detail\.model/.test(inv), '显示型号');
  check(/sizeBytes/.test(inv), '显示文件大小');
  check(/按原提示词重新生成/.test(inv), '详情内重新生成');
  check(/\/api\/library\/:id\/regenerate/.test(server), '重新生成接口存在');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_lib_'));
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
      const lib = await (await fetch(base + '/api/library')).json();
      const items = (lib.groups || []).flatMap((g) => g.items || []);
      check(items.length > 0, '片段库有条目', items.length + ' 条');
      const it = items[0];
      if (it) {
        check(!!it.taskId, '条目含来源任务', it.taskId || '无');
        check(!!it.model, '条目含型号', it.model || '无');
        check(!!it.qc, '条目含 QC 结论', it.qc ? String(it.qc.passed) : '无');
        check(!!it.cost, '条目含成本', it.cost ? String(it.cost.amount) : '无');
        check(Number(it.durationSec) > 0, '条目含时长', String(it.durationSec));
        check(Number(it.sizeBytes) > 0, '条目含文件大小', String(it.sizeBytes));
      }
      const js = await (await fetch(base + '/app/src/screens/inventory.js')).text();
      check(/片段详情/.test(js) && /taskId/.test(js), '浏览器取到的 inventory.js 含详情');
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
