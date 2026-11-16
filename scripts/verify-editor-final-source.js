// ============================================================
// 剪辑台接成片验收（P3，2026-11-15）
// ------------------------------------------------------------
// P3 三条要求：
//   1) 素材栏三来源：片段 / 成片 / 图片（图片首版后置，只展示）；
//   2) 成片默认**整段载入**时间线，且整段可裁（in/out 能拖、裁剪值进工程）；
//   3) 导出**归成片**：导出产物必须进「库 · 成片」（origin=editor）。
//
// 本脚本只证明 (2) 的后端链路 + (3)；素材栏 UI 的点击行为由
// `web/verify/p3-editor-e2e.js`（真浏览器、连 3001）验收。
//
// 做法：起一个**隔离的临时实例**（独立端口 + 临时 LIBRARY_DIR/OUTPUT_DIR/
// PROJECTS_DIR/DATA_DIR；真实库只被复制 JSON 进来、文件只读），因此不会往
// 用户真实库写任何东西。然后：
//   · 用真实成片做两段工程（整段 + 同一成片裁 1–3s）→ 导出；
//   · ffprobe 实测产物：时长 ≈ Σ有效 −(N−1)×转场、分辨率/帧率/流/可解码；
//   · 校验库新增 origin=editor 的成片条目，且源成片 mtime/size 未变；
//   · 负向：引用不存在的成片 → 导出失败；有效时长过短 → 导出失败。
//
// 用法：node scripts/verify-editor-final-source.js
// 退出码 0 = 全部通过；非 0 = 有失败（skipped 不算通过）。
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const REAL_LIB_DIR = path.join(ROOT, 'data', 'library');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_FINAL_SOURCE_PORT || 3181);

let pass = 0;
let fail = 0;
let child = null;
let tmp = '';
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
async function waitReady(base, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping(base + '/api/status')) return true;
    await sleep(400);
  }
  return false;
}
function realLibraryCount() {
  try { return fs.readdirSync(REAL_LIB_DIR).filter((n) => n.endsWith('.json')).length; }
  catch (e) { return 0; }
}

(async () => {
  console.log('================================================================');
  console.log('剪辑台接成片验收（P3）');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const exporter = read(path.join(ROOT, 'src', 'editorExporter.js'));
  const libSrc = read(path.join(ROOT, 'src', 'library.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));

  // ---------------- 静态接线 ----------------
  check(/data-media-source/.test(editor) && /片段/.test(editor) && /成片/.test(editor) && /图片/.test(editor),
    '素材栏三来源（片段 / 成片 / 图片）');
  check(/it\.kind !== 'final'/.test(editor) && /it\.kind === 'final'/.test(editor),
    '片段/成片按 kind 分开取（不再混在一列）');
  check(/整段载入/.test(editor) && /outSec: dur > 0 \? round3\(dur\) : null/.test(editor),
    '成片默认整段载入（outSec=全长）');
  check(/assetById/.test(editor) && /assetMaxDur/.test(editor),
    '跨来源素材索引（裁剪上限/预览不受当前来源影响）');
  check(/图片素材首版后置/.test(editor) && /item\.kind === 'photo'/.test(editor),
    '图片首版后置有显式说明且不可入轨');
  check(/libraryEntryId/.test(exporter) && /ingestFinal/.test(exporter),
    '导出成功后 library.ingestFinal 归库');
  check(/model === 'editor'/.test(libSrc) && /origin/.test(libSrc),
    'ingestFinal 把剪辑导出标 origin=editor');
  check(/\.ed-sources/.test(css) && /\.ed-source\b/.test(css) && /\.ed-card-final/.test(css),
    'CSS 含来源切换/成片卡样式');

  // ---------------- 隔离临时实例 ----------------
  const tmpParent = path.join(ROOT, 'data', 'tmp-verify');
  fs.mkdirSync(tmpParent, { recursive: true });
  tmp = fs.mkdtempSync(path.join(tmpParent, 'finalsrc-'));
  const tmpLib = path.join(tmp, 'library');
  const tmpOut = path.join(tmp, 'output');
  const tmpProjects = path.join(tmp, 'projects');
  const tmpTasks = path.join(tmp, 'tasks');
  const tmpTemp = path.join(tmp, 'temp');
  for (const d of [tmpLib, tmpOut, tmpProjects, tmpTasks, tmpTemp]) fs.mkdirSync(d, { recursive: true });
  process.env.TEMP = tmpTemp;
  process.env.TMP = tmpTemp;

  // 真实库只读复制：JSON 进来，filePath 仍指向真实文件（只读、不改）
  let copied = 0;
  for (const n of fs.readdirSync(REAL_LIB_DIR)) {
    if (!n.endsWith('.json')) continue;
    const src = path.join(REAL_LIB_DIR, n);
    try {
      const entry = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) continue;
      fs.copyFileSync(src, path.join(tmpLib, n));
      copied++;
    } catch (e) { /* 坏 JSON 跳过 */ }
  }
  const realCountBefore = realLibraryCount();

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
          DATA_DIR: tmpTasks,
          OUTPUT_DIR: tmpOut,
          PROJECTS_DIR: tmpProjects,
          LIBRARY_DIR: tmpLib,
          TEMP: tmpTemp,
          TMP: tmpTemp
        },
        stdio: 'ignore',
        windowsHide: true
      });
      c.on('error', () => {});
      if (await waitReady(candidate)) { child = c; base = candidate; }
      else { try { c.kill(); } catch (e) { /* ignore */ } }
    }
    check(!!child, '隔离临时实例启动');
    check(copied > 0, '真实库条目复制到临时库（只读，文件不复制）', copied + ' 条');
    if (!child) return finish();

    const lib0 = await (await fetch(base + '/api/library')).json();
    const all0 = (lib0.groups || []).flatMap((g) => g.items || []);
    const finals = all0.filter((it) => it.kind === 'final' && it.filePath && fs.existsSync(it.filePath));
    // 选体积最小的健康成片：导出最快，且能覆盖“整段 + 裁剪”两段
    const fin = finals
      .filter((it) => (Number(it.sizeBytes) || 0) > 200 * 1024 && (Number(it.durationSec) || 0) >= 3)
      .sort((a, b) => (Number(a.sizeBytes) || 0) - (Number(b.sizeBytes) || 0))[0] || finals[0];
    check(!!fin, '临时库里有可用成片', fin ? `${fin.id} · ${fin.durationSec}s · ${Math.round((fin.sizeBytes || 0) / 1048576 * 100) / 100}MB` : '无');
    if (!fin) return finish();

    const videoProcessor = require('../src/videoProcessor');
    const finProbe = videoProcessor.probeDetail(fin.filePath);
    check(finProbe && finProbe.success, '成片可探测（ffprobe）',
      finProbe && finProbe.success ? `${finProbe.width}x${finProbe.height}@${finProbe.fps} ${finProbe.duration.toFixed(3)}s` : (finProbe && finProbe.error));
    if (!finProbe || !finProbe.success) return finish();
    const D = finProbe.duration;

    const clip = all0.find((it) => it.kind !== 'final' && it.filePath && fs.existsSync(it.filePath));
    check(!!clip, '临时库里有可用片段', clip ? clip.id : '无');

    // 工程：1 段整片 + 1 段同一成片裁 1–3s +（可选）1 段普通片段
    const segA = { id: 's1', assetId: fin.id, inSec: 0, outSec: Math.round(D * 1000) / 1000 };
    const outB = Math.min(3, Math.max(1.5, D - 0.5));
    const segB = { id: 's2', assetId: fin.id, inSec: 1, outSec: Math.round(outB * 1000) / 1000 };
    const segs = [segA, segB];
    let trimSum = (segA.outSec - segA.inSec) + (segB.outSec - segB.inSec);
    const inputProbes = [finProbe];
    if (clip) {
      const cp = videoProcessor.probeDetail(clip.filePath);
      if (cp && cp.success) inputProbes.push(cp);
      if (cp && cp.success && cp.duration > 0.6) {
        const cd = Math.min(2, Math.round((cp.duration - 0.2) * 1000) / 1000);
        segs.push({ id: 's3', assetId: clip.id, inSec: 0, outSec: cd });
        trimSum += cd;
      }
    }
    const expected = trimSum - (segs.length - 1) * 0.4; // 默认开转场，每缝 −0.4s

    const srcStats = [fin, ...(clip ? [clip] : [])].map((it) => ({ file: it.filePath, st: fs.statSync(it.filePath) }));

    let r = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P3 接成片验收', segments: segs })
    });
    const pj = await r.json();
    check(r.status === 200 && pj.project && pj.project.segments.length === segs.length,
      '工程接受成片/裁剪段', r.status + ' / ' + ((pj.project && pj.project.segments.length) || 0) + ' 段');
    if (r.status !== 200) return finish();
    const project = pj.project;
    check(project.segments[0].assetId === fin.id && Math.abs(project.segments[0].outSec - segA.outSec) < 0.01,
      '整段成片 in/out 落进工程', `${project.segments[0].inSec}–${project.segments[0].outSec}s`);
    check(project.segments[1].assetId === fin.id && project.segments[1].inSec === 1,
      '同一成片可再裁一段（整段可裁）', `${project.segments[1].inSec}–${project.segments[1].outSec}s`);

    // ---- 负向 1：引用不存在的成片 ----
    r = await fetch(base + '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P3 缺素材', segments: [{ id: 'x1', assetId: 'lib_not_exist_final', inSec: 0, outSec: 2 }] })
    });
    const badPj = await r.json();
    if (r.status === 200) {
      r = await fetch(base + `/api/projects/${badPj.project.id}/export`, { method: 'POST' });
      const started = await r.json();
      let badJob = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const jr = await fetch(base + `/api/projects/${badPj.project.id}/export/${started.export.id}`);
        badJob = (await jr.json()).export;
        if (!badJob || ['done', 'failed', 'cancelled'].includes(badJob.status)) break;
        await sleep(400);
      }
      check(!!badJob && badJob.status === 'failed' && /素材不存在/.test(badJob.error || ''),
        '负向：引用不存在的成片 → 导出失败且指出段号', badJob ? badJob.status + ' · ' + (badJob.error || '') : '无 job');
    } else {
      check(false, '负向：引用不存在的成片 → 导出失败且指出段号', '工程创建被拒 ' + r.status);
    }

    // ---- 负向 2：有效时长过短（0.05s；editorExporter 要求 >0.1s） ----
    r = await fetch(base + '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P3 太短', segments: [{ id: 'y1', assetId: fin.id, inSec: 0, outSec: 0.05 }] })
    });
    const shortPj = await r.json();
    if (r.status === 200) {
      r = await fetch(base + `/api/projects/${shortPj.project.id}/export`, { method: 'POST' });
      const started = await r.json();
      let shortJob = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const jr = await fetch(base + `/api/projects/${shortPj.project.id}/export/${started.export.id}`);
        shortJob = (await jr.json()).export;
        if (!shortJob || ['done', 'failed', 'cancelled'].includes(shortJob.status)) break;
        await sleep(400);
      }
      check(!!shortJob && shortJob.status === 'failed' && /有效时长过短/.test(shortJob.error || ''),
        '负向：0.05s 裁剪段 → 导出失败（不产出坏片）', shortJob ? shortJob.status + ' · ' + (shortJob.error || '') : '无 job');
    } else {
      check(false, '负向：0.05s 裁剪段 → 导出失败（不产出坏片）', '工程创建被拒 ' + r.status);
    }

    // ---- 正向导出 ----
    const libBefore = await (await fetch(base + '/api/library')).json();
    const countBefore = ((libBefore.totals && libBefore.totals.count) || 0);
    r = await fetch(base + `/api/projects/${project.id}/export`, { method: 'POST' });
    const started = await r.json();
    check(r.status === 200 && started.export && started.export.id, '导出启动', started.export && started.export.id);
    if (r.status !== 200) return finish();
    let job = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      const jr = await fetch(base + `/api/projects/${project.id}/export/${started.export.id}`);
      job = (await jr.json()).export;
      if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) break;
      await sleep(1000);
    }
    check(!!job && job.status === 'done', '导出完成', job ? job.status + (job.error ? ' · ' + job.error : '') : '无 job');
    if (!job || job.status !== 'done') return finish();

    const outFile = job.outputPath;
    check(!!outFile && fs.existsSync(outFile), '产物文件存在', outFile ? path.basename(outFile) : '无');
    if (!outFile || !fs.existsSync(outFile)) return finish();

    // ---- ffprobe 实测 ----
    const probe = videoProcessor.probeDetail(outFile);
    check(probe && probe.success, 'ffprobe 可探测产物');
    if (probe && probe.success) {
      console.log(`  [ffprobe] ${path.basename(outFile)}  ${probe.width}x${probe.height} @ ${probe.fps}fps` +
        `  ${probe.codec || '?'}  ${probe.duration.toFixed(3)}s  ${(fs.statSync(outFile).size / 1048576).toFixed(2)}MB` +
        `  hasAudio=${probe.hasAudio}`);
      const tol = Math.max(0.5, expected * 0.02);
      check(Math.abs(probe.duration - expected) <= tol, '产物时长 ≈ Σ有效裁剪 −(N−1)×0.4s',
        `实测 ${probe.duration.toFixed(3)}s，期望 ${expected.toFixed(3)}s`);
      // transitionMixer 默认 auto：目标规格取面积最大的输入，帧率取首段
      const parseFps = (s) => {
        const str = String(s || '');
        if (str.includes('/')) { const p = str.split('/').map(Number); return p[1] ? p[0] / p[1] : NaN; }
        return Number(str);
      };
      const target = inputProbes.reduce((best, p) => (!best || p.width * p.height > best.width * best.height) ? p : best, null);
      check(probe.width === target.width && probe.height === target.height,
        '产物分辨率 = 最大输入规格（auto）', `${probe.width}x${probe.height} / 最大输入 ${target.width}x${target.height}`);
      check(parseFps(probe.fps) > 0 && Math.abs(parseFps(probe.fps) - parseFps(finProbe.fps)) < 1.5,
        '产物帧率 = 首段帧率', `${probe.fps} vs 首段 ${finProbe.fps}`);
      // 完整解码（截断/坏包会在这里露馅）
      let decodeOk = false;
      let decodeMsg = '';
      try {
        const config = require('../config');
        execFileSync(config.FFMPEG_PATH, ['-v', 'error', '-i', outFile, '-f', 'null', '-'],
          { stdio: 'ignore', timeout: 120000 });
        decodeOk = true;
      } catch (e) {
        decodeMsg = (e && e.message) ? e.message.slice(0, 160) : String(e);
      }
      check(decodeOk, '容器可完整解码（ffmpeg -f null）', decodeOk ? '' : decodeMsg);
    } else {
      check(false, 'ffprobe 可探测产物', probe && probe.error);
    }

    // ---- 归成片（库） ----
    const libAfter = await (await fetch(base + '/api/library')).json();
    const allAfter = (libAfter.groups || []).flatMap((g) => g.items || []);
    const countAfter = (libAfter.totals && libAfter.totals.count) || 0;
    check(countAfter === countBefore + 1, '库条目数 +1', `${countBefore} → ${countAfter}`);
    const entry = allAfter.find((it) => it.id === `${job.taskId}_final`);
    check(!!entry, '成片条目已入库（id=taskId_final）', `${job.taskId}_final`);
    if (entry) {
      check(entry.kind === 'final', '入库 kind=final', entry.kind);
      check(entry.origin === 'editor', '入库 origin=editor', entry.origin);
      check(entry.status === 'completed', '入库 status=completed', entry.status);
      check(entry.taskId === job.taskId, '入库 taskId 与导出任务一致', entry.taskId);
      check(entry.filePath === outFile && fs.existsSync(entry.filePath), '条目 filePath 指向真实产物');
      check(Math.abs((Number(entry.durationSec) || 0) - (job.durationSec || 0)) < 0.05,
        '条目时长 = 导出时长', `${entry.durationSec}s`);
      check(/^\/output\//.test(entry.url || ''), '条目 url 指向 /output', entry.url || '');
      check(entry.cost && Number(entry.cost.amount) === 0 && entry.cost.computed === true,
        '剪辑导出费用口径 ¥0 / computed（不冒充未知）',
        entry.cost ? `¥${entry.cost.amount} · ${entry.cost.label}` : '无');
      check(job.libraryEntryId === entry.id, '导出 job 返回 libraryEntryId', job.libraryEntryId || '');
    }

    // ---- 单片段工程导出（P3 最自然路径：选一条成片 → 裁一段 → 导出） ----
    // 说明：transitionMixer 此前对 1 个片段直接报「至少需要 2 个片段」，
    // 导致「只选一条成片导出」永远失败；P3 已按直拼（F=0）支持。
    const oneDur = Math.max(1, Math.min(2, Math.round((D - 1) * 1000) / 1000));
    r = await fetch(base + '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P3 单片段成片', segments: [{ id: 'one1', assetId: fin.id, inSec: 0, outSec: oneDur }] })
    });
    const onePj = await r.json();
    check(r.status === 200 && onePj.project && onePj.project.segments.length === 1, '单片段工程建立', oneDur + 's');
    if (r.status === 200) {
      r = await fetch(base + `/api/projects/${onePj.project.id}/export`, { method: 'POST' });
      const oneStarted = await r.json();
      let oneJob = null;
      const tOne = Date.now();
      while (Date.now() - tOne < 180000) {
        const jr = await fetch(base + `/api/projects/${onePj.project.id}/export/${oneStarted.export.id}`);
        oneJob = (await jr.json()).export;
        if (!oneJob || ['done', 'failed', 'cancelled'].includes(oneJob.status)) break;
        await sleep(800);
      }
      check(!!oneJob && oneJob.status === 'done',
        '单片段工程可导出（修复前报「转场拼接至少需要 2 个片段」）',
        oneJob ? oneJob.status + (oneJob.error ? ' · ' + oneJob.error : '') : '无 job');
      if (oneJob && oneJob.status === 'done') {
        const oneProbe = videoProcessor.probeDetail(oneJob.outputPath);
        check(oneProbe && oneProbe.success && Math.abs(oneProbe.duration - oneDur) <= Math.max(0.4, oneDur * 0.05),
          '单片段产物时长 = 裁剪时长', oneProbe && oneProbe.success ? `${oneProbe.duration.toFixed(3)}s / 期望 ${oneDur}s` : '探测失败');
        check(!!oneJob.libraryEntryId, '单片段导出同样归入成片库', oneJob.libraryEntryId || '');
      }
    }

    // 源素材只读：mtime/size 未变
    let untouched = true;
    for (const s of srcStats) {
      const now = fs.statSync(s.file);
      if (now.mtimeMs !== s.st.mtimeMs || now.size !== s.st.size) untouched = false;
    }
    check(untouched, '源成片/片段未被改动（mtime+size）', srcStats.length + ' 个文件');

    // 真实库未被写入（隔离有效性 + 红线）
    check(realLibraryCount() === realCountBefore,
      '真实库条目数未变（临时实例隔离生效）', `${realCountBefore} → ${realLibraryCount()}`);
    return finish();
  } catch (e) {
    check(false, '运行时验收异常: ' + (e && e.message ? e.message : e));
    return finish();
  }
})();

function finish() {
  if (child) { try { child.kill(); } catch (e) { /* ignore */ } child = null; }
  setTimeout(() => {
    try { if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n================================================================');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    console.log('================================================================');
    process.exit(fail === 0 ? 0 : 1);
  }, 500);
}
