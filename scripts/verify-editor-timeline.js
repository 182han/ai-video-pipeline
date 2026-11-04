// ============================================================
// 剪辑台时间线编辑验收（F04）
// ------------------------------------------------------------
// 1) 静态：排序/裁剪/分割/删除/撤销重做/播放头 的接线存在
// 2) 运行时：工程能存下重排、裁剪、分割后的 segments，并原样回读
//
// 用法：node scripts/verify-editor-timeline.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_TL_PORT || 3161);

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
async function put(base, id, body) {
  const r = await fetch(base + '/api/projects/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, json: j };
}

(async () => {
  console.log('================================================================');
  console.log('剪辑台时间线编辑验收（F04）');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));

  check(/function undo\(/.test(editor), '撤销');
  check(/function redo\(/.test(editor), '重做');
  check(/pastRef/.test(editor) && /futureRef/.test(editor), '撤销/重做栈');
  check(/function splitSelected\(/.test(editor), '分割');
  check(/function deleteSelected\(/.test(editor), '删除');
  check(/function beginTrim\(/.test(editor), '入出点裁剪');
  check(/function onClipDragStart\(/.test(editor), '拖拽排序');
  check(/move:'/.test(editor), '排序拖拽数据');
  check(/function commitSegments\(/.test(editor), '统一提交 segments');
  check(/scheduleSegSave/.test(editor), '编辑后自动保存');
  check(/setPlayhead/.test(editor), '播放头');
  check(/beginScrub/.test(editor), '标尺/播放头拖动定位');
  check(/ed-handle/.test(editor), '裁剪手柄');
  check(/\.ed-handle/.test(css), 'CSS 裁剪手柄');
  check(/\.ed-clip\.sel/.test(css), 'CSS 选中片段');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_tl_'));
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
      const segs = [
        { id: 's1', assetId: 'lib_a', inSec: 0, outSec: 3 },
        { id: 's2', assetId: 'lib_b', inSec: 1, outSec: 4 },
        { id: 's3', assetId: 'lib_c', inSec: 0, outSec: 2.5 }
      ];
      let r = await fetch(base + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '时间线验收', segments: segs })
      });
      const p = (await r.json()).project;
      check(r.status === 200 && p.segments.length === 3, '三段工程建立');

      // 重排：s3, s1, s2
      const reordered = [segs[2], segs[0], segs[1]];
      let out = await put(base, p.id, { revision: p.revision, segments: reordered });
      check(out.status === 200, '重排提交成功');
      check(out.json.project.segments.map((s) => s.id).join(',') === 's3,s1,s2', '顺序原样保存');
      const rev2 = out.json.project.revision;

      // 裁剪：s3 改为 0.5–2.0
      const trimmed = out.json.project.segments.map((s) =>
        s.id === 's3' ? { ...s, inSec: 0.5, outSec: 2.0 } : s);
      out = await put(base, p.id, { revision: rev2, segments: trimmed });
      check(out.status === 200, '裁剪提交成功');
      const s3 = out.json.project.segments.find((s) => s.id === 's3');
      check(s3.inSec === 0.5 && s3.outSec === 2.0, '入出点原样保存');
      const rev3 = out.json.project.revision;

      // 分割：s1 在 1.5s 处 → 两段
      const split = [];
      for (const s of out.json.project.segments) {
        if (s.id === 's1') {
          split.push({ ...s, outSec: 1.5 });
          split.push({ ...s, id: 's1b', inSec: 1.5 });
        } else split.push(s);
      }
      out = await put(base, p.id, { revision: rev3, segments: split });
      check(out.status === 200, '分割提交成功');
      check(out.json.project.segments.length === 4, '分割后 4 段');
      check(out.json.project.segments[1].outSec === 1.5 && out.json.project.segments[2].inSec === 1.5, '分割点首尾相接');
      const rev4 = out.json.project.revision;

      // 删除
      const removed = out.json.project.segments.filter((s) => s.id !== 's2');
      out = await put(base, p.id, { revision: rev4, segments: removed });
      check(out.status === 200 && out.json.project.segments.length === 3, '删除后 3 段');

      // 回读
      r = await fetch(base + '/api/projects/' + p.id);
      const back = (await r.json()).project;
      check(r.status === 200 && back.segments.length === 3, '回读一致');
      check(back.segments[0].id === 's3' && back.segments[0].inSec === 0.5, '回读保留裁剪值');

      // 负向：outSec <= inSec
      out = await put(base, p.id, {
        revision: back.revision,
        segments: [{ id: 'x', assetId: 'lib_a', inSec: 2, outSec: 1 }]
      });
      check(out.status === 400, '非法入出点被拒');
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
