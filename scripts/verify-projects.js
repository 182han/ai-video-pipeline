// ============================================================
// 剪辑台工程（草稿）API 验收
// ------------------------------------------------------------
// 自起临时服务（AUTH_ENABLED=false / DATABASE_TYPE=json / 独立 PROJECTS_DIR），
// 覆盖：CRUD、revision 乐观锁、schema 归一化、负向输入、删除、路径安全。
//
// 用法：node scripts/verify-projects.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.PROJECT_TEST_PORT || 3131);
const MAX_TRIES = 6;

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  —  ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(url, ms = 800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return r.status;
  } catch (e) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function waitReady(base, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping(base + '/api/status')) return true;
    await sleep(400);
  }
  return false;
}

async function req(base, method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(base + url, opt);
  let json = null;
  try { json = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, json };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_proj_'));
  const projectsDir = path.join(tmp, 'projects');
  let child = null;
  let base = null;

  try {
    for (let i = 0; i < MAX_TRIES && !child; i++) {
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
          PROJECTS_DIR: projectsDir
        },
        stdio: 'ignore',
        windowsHide: true
      });
      c.on('error', () => {});
      if (await waitReady(candidate)) { child = c; base = candidate; }
      else { try { c.kill(); } catch (e) { /* ignore */ } }
    }
    check(!!child, '临时服务启动');
    if (!child) return finish(tmp);

    // 1) 空列表
    let r = await req(base, 'GET', '/api/projects');
    check(r.status === 200 && Array.isArray(r.json.projects) && r.json.projects.length === 0, '空工程列表');

    // 2) 新建空工程
    r = await req(base, 'POST', '/api/projects', { name: '测试工程' });
    const p1 = r.json && r.json.project;
    check(r.status === 200 && r.json.success === true, '新建空工程成功');
    check(p1 && /^proj_/.test(p1.id), '工程 id 前缀正确', p1 && p1.id);
    check(p1 && p1.revision === 1 && p1.schemaVersion === 1, '初始 revision/schemaVersion = 1');
    check(p1 && Array.isArray(p1.segments) && p1.segments.length === 0, '空工程 segments = []');
    check(p1 && p1.transition && p1.transition.enabled === true && p1.transition.duration === 0.4, '转场默认 0.4s fade');

    // 3) 带片段的工程
    r = await req(base, 'POST', '/api/projects', {
      name: '两段工程',
      segments: [
        { assetId: 'lib_a', inSec: 0, outSec: 5.2, adjust: { brightness: 10 } },
        { assetId: 'lib_b', inSec: 1, outSec: 6 }
      ]
    });
    const p2 = r.json && r.json.project;
    check(r.status === 200 && p2.segments.length === 2, '带片段工程建立');
    check(p2.segments[0].adjust.brightness === 10, '每段参数保留');
    check(p2.segments[0].outSec === 5.2 && p2.segments[1].inSec === 1, '入出点保留');

    // 4) 列表摘要
    r = await req(base, 'GET', '/api/projects');
    check(r.json.projects.length === 2, '列表返回 2 条');
    check(r.json.projects.every((p) => typeof p.segmentCount === 'number'), '列表含 segmentCount');

    // 5) 读取
    r = await req(base, 'GET', '/api/projects/' + p2.id);
    check(r.status === 200 && r.json.project.name === '两段工程', '按 id 读取');

    // 6) 正常更新
    r = await req(base, 'PUT', '/api/projects/' + p2.id, { revision: 1, name: '改名工程' });
    check(r.status === 200 && r.json.project.revision === 2, '正常更新 revision +1');
    check(r.json.project.name === '改名工程', '名称已更新');

    // 7) 陈旧 revision → 409
    r = await req(base, 'PUT', '/api/projects/' + p2.id, { revision: 1, name: '旧版本写入' });
    check(r.status === 409 && r.json.code === 'REVISION_CONFLICT', '陈旧 revision 返回 409');
    check(r.json.currentRevision === 2, '409 返回当前 revision');
    r = await req(base, 'GET', '/api/projects/' + p2.id);
    check(r.json.project.name === '改名工程', '冲突写入未生效');

    // 8) 缺 revision → 400
    r = await req(base, 'PUT', '/api/projects/' + p2.id, { name: '无版本' });
    check(r.status === 400 && r.json.code === 'REVISION_REQUIRED', '缺 revision 返回 400');

    // 9) 负向：片段缺 assetId
    r = await req(base, 'POST', '/api/projects', { segments: [{ inSec: 0 }] });
    check(r.status === 400 && r.json.code === 'BAD_SEGMENT', '片段缺 assetId 被拒');

    // 10) 钳制：转场时长/类型
    r = await req(base, 'POST', '/api/projects', { transition: { duration: 99, type: 'nope' } });
    const p3 = r.json.project;
    check(p3.transition.duration === 5 && p3.transition.type === 'fade', '转场时长钳制、类型回退');

    // 11) 路径安全
    r = await req(base, 'GET', '/api/projects/..%2F..%2Fpackage');
    check(r.status === 404, '非法 id 返回 404');

    // 12) 删除
    r = await req(base, 'DELETE', '/api/projects/' + p3.id);
    check(r.status === 200 && r.json.success === true, '删除工程成功');
    r = await req(base, 'GET', '/api/projects/' + p3.id);
    check(r.status === 404, '删除后读取 404');
    check(fs.existsSync(path.join(projectsDir, p2.id + '.json')), '工程以文件形式落盘');
  } catch (e) {
    check(false, '验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
    await sleep(300);
    finish(tmp);
  }
})().catch((e) => {
  console.error('验收异常:', e && e.message ? e.message : e);
  process.exit(1);
});

function finish(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
}
