// ============================================================
// 剪辑台导出验收（F08 / G1 前半）
// ------------------------------------------------------------
// 静态：导出路由、job 轮询、前端导出按钮
// 运行时：临时服务 + 真实片段库 → 12 段工程（约 1 分钟）→ 导出
//   校验：job done、产物文件存在、时长≈Σ−(N−1)F、原素材 mtime 不变、project.exports 记录
//
// 用法：node scripts/verify-editor-export.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_EXPORT_PORT || 3171);
const videoProcessor = require('../src/videoProcessor');

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
function probeDuration(file) {
  const d = videoProcessor.probeDetail(file);
  return d && d.success ? d.duration : NaN;
}

(async () => {
  console.log('================================================================');
  console.log('剪辑台导出验收（F08）');
  console.log('================================================================');

  const exporter = read(path.join(ROOT, 'src', 'editorExporter.js'));
  const server = read(path.join(ROOT, 'server.js'));
  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));

  check(/startExport/.test(exporter) && /getJob/.test(exporter), '导出器含 start/getJob');
  check(/ignoreAudio:\s*true/.test(exporter), '导出忽略源音轨');
  check(/appendExport/.test(exporter), '导出写入 project.exports');
  check(/\/api\/projects\/:id\/export/.test(server), '服务端导出路由');
  check(/onExport/.test(editor) && /pollExport/.test(editor), '前端导出与轮询');
  check(/outputUrl/.test(editor), '前端显示成片地址');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_exp_'));
  const outDir = path.join(tmp, 'output');
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
          OUTPUT_DIR: outDir,
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
    if (!child) return finish(tmp);

    // 找一条真实片段
    const lib = await (await fetch(base + '/api/library')).json();
    const items = (lib.groups || []).flatMap((g) => g.items || []);
    const usable = items.find((it) => it.filePath && fs.existsSync(it.filePath));
    const usableList = items.filter((it) => it.filePath && fs.existsSync(it.filePath));
    check(usableList.length > 0, '片段库有可用素材', usableList.length + ' 条');
    if (!usableList.length) return finish(tmp);

    const chosen = usableList.slice(0, 3);
    const srcStats = chosen.map((it) => ({ file: it.filePath, stat: fs.statSync(it.filePath) }));

    const segs = [];
    for (let i = 0; i < 12; i++) {
      const it = chosen[i % chosen.length];
      const d = Number(it.durationSec) || 5;
      const out = Math.min(5, Math.round(d * 1000) / 1000);
      segs.push({ id: 's' + (i + 1), assetId: it.id, inSec: 0, outSec: out });
    }
    const trimSum = segs.reduce((s, x) => s + (x.outSec - x.inSec), 0);
    const expected = trimSum - 11 * 0.4;
    // 重排（旋转 5 位），模拟“选段 → 排序 → 裁剪 → 导出”
    const reordered = segs.slice(5).concat(segs.slice(0, 5));
    let r = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '导出一分钟', segments: reordered })
    });
    const project = (await r.json()).project;
    check(r.status === 200 && project.segments.length === 12, '12 段工程建立');
    check(project.segments.map((s) => s.id).join(',') === reordered.map((s) => s.id).join(','), '工程保留排序与每段裁剪');

    // 空工程导出负向
    r = await fetch(base + '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '空工程' })
    });
    const empty = (await r.json()).project;
    r = await fetch(base + `/api/projects/${empty.id}/export`, { method: 'POST' });
    check(r.status === 400, '空工程导出被拒');

    // 启动导出
    r = await fetch(base + `/api/projects/${project.id}/export`, { method: 'POST' });
    const started = await r.json();
    check(r.status === 200 && started.export && started.export.id, '导出任务启动', started.export && started.export.id);
    const expId = started.export.id;

    // 轮询
    let job = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      const jr = await fetch(base + `/api/projects/${project.id}/export/${expId}`);
      job = (await jr.json()).export;
      if (!job) break;
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') break;
      await sleep(1000);
    }
    check(!!job && job.status === 'done', '导出完成', job ? job.status + (job.error ? ' ' + job.error : '') : '无 job');
    if (!job || job.status !== 'done') return finish(tmp);

    const expFile = path.join(outDir, path.basename(job.outputPath));
    check(fs.existsSync(expFile), '产物文件存在', path.basename(expFile));
    const actual = job.durationSec || probeDuration(expFile);
    check(Math.abs(actual - expected) <= Math.max(0.5, expected * 0.02), '时长 ≈ Σ裁剪后 − (N−1)F',
      `实测 ${Number(actual).toFixed(2)}s，期望 ${expected.toFixed(2)}s`);
    check(job.outputUrl && /^\/output\//.test(job.outputUrl), '产出 URL 正确', job.outputUrl || '');
    check(job.taskId && /^task_/.test(job.taskId), '导出登记为任务', job.taskId || '');

    const completed = await (await fetch(base + '/api/tasks/completed')).json();
    const hit = (completed.tasks || []).find((t) => t.taskId === job.taskId);
    check(!!hit, '产出/历史列表可见');
    check(hit && hit.status === 'completed' && hit.model === 'editor', '任务状态与来源正确',
      hit ? hit.status + ' / ' + hit.model : '无');
    check(hit && Math.abs((hit.totalDuration || 0) - expected) < 1, '任务记录时长正确',
      hit ? String(hit.totalDuration) : '无');

    let untouched = true;
    for (const s of srcStats) {
      const now = fs.statSync(s.file);
      if (now.mtimeMs !== s.stat.mtimeMs || now.size !== s.stat.size) untouched = false;
    }
    check(untouched, '原素材未被改动', srcStats.length + ' 个源文件');

    const fresh = await (await fetch(base + '/api/projects/' + project.id)).json();
    check(Array.isArray(fresh.project.exports) && fresh.project.exports.length === 1, '工程记录导出');
    check(fresh.project.exports[0].exportId === expId, '导出记录 id 一致');
    check(fresh.project.exports[0].taskId === job.taskId, '导出记录关联任务');

    return finish(tmp);
  } catch (e) {
    check(false, '运行时验收异常: ' + (e && e.message ? e.message : e));
    return finish(tmp);
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
  }
})();

function finish(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  setTimeout(() => {
    console.log('\n================================================================');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    console.log('================================================================');
    process.exit(fail === 0 ? 0 : 1);
  }, 300);
}
