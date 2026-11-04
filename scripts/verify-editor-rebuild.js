// ============================================================
// F01c 从已有成片重建工程验收
// ------------------------------------------------------------
// 构造一条已完成任务（片段指向真实片段库），POST /api/projects/from-task：
//   - 片段映射回 assetId，保留入出点
//   - 配乐计划与转场设置带回工程
//   - 原任务/成片不动（不调用流水线）
//
// 用法：node scripts/verify-editor-rebuild.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_REBUILD_PORT || 3231);
const lib = require('../src/library');

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
  console.log('F01c 从已有成片重建工程验收');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const server = read(path.join(ROOT, 'server.js'));
  const builder = read(path.join(ROOT, 'src', 'projectFromTask.js'));

  check(/\/api\/projects\/from-task/.test(server), '重建接口');
  check(/build\(taskId\)/.test(builder) && /library\.listAll\(\)/.test(builder), '任务片段映射片段库');
  check(/bgmPlan/.test(builder) && /cleanAudio/.test(builder), '带回配乐计划');
  check(/transition/.test(builder), '带回转场设置');
  check(/films/.test(editor) && /rebuildFromTask/.test(editor), '编辑器「打开」里可重建');
  check(/已完成成片/.test(editor), '成片列表分组');

  const items = lib.listAll().filter((i) => i.filePath && fs.existsSync(i.filePath)).slice(0, 2);
  check(items.length === 2, '片段库有 2 条素材');
  if (items.length < 2) return finish();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_rebuild_'));
  const dataDir = path.join(tmp, 'tasks');
  fs.mkdirSync(dataDir, { recursive: true });
  const taskId = 'task_rebuild_test';
  const now = new Date().toISOString();
  const task = {
    taskId,
    status: 'completed',
    prompt: '重建验收 · 雪山湖面',
    model: 'dashscope',
    totalClips: 2,
    clipDuration: 2,
    resolution: '720p',
    totalDuration: 4,
    source: 'generation',
    createdAt: now,
    completedAt: now,
    outputPath: path.join(tmp, 'output', 'fake.mp4'),
    clips: items.map((e, i) => ({
      index: i,
      status: 'success',
      prompt: '片段 ' + (i + 1),
      videoPath: e.filePath,
      duration: Math.min(2, Number(e.durationSec) || 2),
      libraryId: e.id,
      trim: null,
      qcResult: null
    })),
    bgmPlan: {
      music: [{
        trackId: 'calm_01', timelineStart: 0, timelineEnd: 3.6,
        sourceIn: 0, sourceOut: 53.9, fillMode: 'loop',
        volume: 0.8, fadeIn: 1, fadeOut: 1
      }],
      ambient: []
    },
    transition: { enabled: true, duration: 0.4, type: 'fade' }
  };
  fs.writeFileSync(path.join(dataDir, taskId + '.json'), JSON.stringify(task, null, 2), 'utf8');

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
          DATA_DIR: dataDir,
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
    if (!child) return finish(tmp);

    let r = await fetch(base + '/api/projects/from-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
    const j = await r.json();
    const project = j.project;
    check(r.status === 200 && project && project.id, '重建成功', project ? project.id : j.error);
    if (project) {
      check(project.segments.length === 2, '片段数一致', String(project.segments.length));
      check(project.segments[0].assetId === items[0].id, 'assetId 映射正确');
      check(project.segments[0].inSec === 0 && project.segments[0].outSec > 0, '入出点保留');
      check(project.audio && project.audio.music.length === 1, '配乐计划带回');
      check(project.audio.music[0].trackId === 'calm_01', '音轨 id 正确');
      check(project.audio.music[0].fadeIn === 1, '淡入值带回');
      check(project.transition && project.transition.duration === 0.4, '转场设置带回');
      check(/^重建 ·/.test(project.name), '工程命名', project.name);
    }

    r = await fetch(base + '/api/projects/from-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task_not_exist' })
    });
    check(r.status === 404, '未知任务返回 404');

    const js = await (await fetch(base + '/app/src/screens/editor.js')).text();
    check(/rebuildFromTask/.test(js), '浏览器取到的 editor.js 含重建入口');
  } catch (e) {
    check(false, '运行时验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  finish();
})();

function finish(tmp) {
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
}
