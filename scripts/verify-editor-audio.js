// ============================================================
// F07 音频验收
// ------------------------------------------------------------
// 静态：音频面板两轨、波形、音量/淡入淡出、导出混音接线
// 真机：两段视频 + 一首音乐 → 导出 → 有音轨、非静音、时长不变、源 mp3 未改
//
// 用法：node scripts/verify-editor-audio.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_AUDIO_PORT || 3201);
const tm = require('../src/processors/transitionMixer');
const audioMixer = require('../src/processors/audioMixer');
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
  console.log('F07 音频验收');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const panel = read(path.join(WEB, 'src', 'components', 'audioPanel.js'));
  const exporter = read(path.join(ROOT, 'src', 'editorExporter.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));

  check(/AudioPanel/.test(editor) && /commitAudio/.test(editor), '编辑器接入音频面板');
  check(/musicSeg/.test(editor) && /ambientSeg/.test(editor), '时间线音频两条');
  check(/KINDS/.test(panel) && /音乐/.test(panel) && /环境音/.test(panel), '面板两轨');
  check(/\/api\/bgm\/waveform\//.test(panel), '波形接口');
  check(/volume/.test(panel) && /fadeIn/.test(panel) && /fadeOut/.test(panel), '音量与淡入淡出');
  check(/buildAudioPlan/.test(exporter) && /mixBgmPlan/.test(exporter), '导出混音接线');
  check(/\.ed-wave/.test(css) && /\.ed-audio-clip/.test(css), '音频 CSS');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_audio_'));
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
    if (!child) return finish(tmp);

    const bgm = await (await fetch(base + '/api/bgm')).json();
    const track = (bgm.tracks || []).find((t) => t.category === 'music') || (bgm.tracks || [])[0];
    check(!!track, '配乐库有可用音轨', track ? track.id : '无');
    if (!track) return finish(tmp);
    const found = audioMixer.findTrack(track.id);
    const srcStat = fs.statSync(found.filePath);

    const items = lib.listAll().filter((i) => i.filePath && fs.existsSync(i.filePath)).slice(0, 2);
    check(items.length === 2, '片段库有 2 条素材');
    if (items.length < 2) return finish(tmp);

    const segs = items.map((it, i) => ({
      id: 's' + (i + 1), assetId: it.id, inSec: 0, outSec: Math.min(2, Number(it.durationSec) || 2)
    }));
    const filmDur = segs.reduce((s, x) => s + (x.outSec - x.inSec), 0) - 0.4;
    const audioSeg = {
      trackId: track.id,
      timelineStart: 0,
      timelineEnd: Math.round(filmDur * 1000) / 1000,
      sourceIn: 0,
      sourceOut: Number(track.durationSec) || 60,
      fillMode: 'loop',
      volume: 0.8,
      fadeIn: 1,
      fadeOut: 1
    };

    let r = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '音频验收', segments: segs, audio: { music: [audioSeg], ambient: [] } })
    });
    const project = (await r.json()).project;
    check(r.status === 200 && project.audio.music.length === 1, '工程保存音频计划');
    check(project.audio.music[0].fadeIn === 1, '淡入值保留');

    r = await fetch(base + `/api/projects/${project.id}/export`, { method: 'POST' });
    const started = await r.json();
    const expId = started.export && started.export.id;
    check(!!expId, '导出任务启动');

    let job = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      const jr = await fetch(base + `/api/projects/${project.id}/export/${expId}`);
      job = (await jr.json()).export;
      if (!job) break;
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') break;
      await sleep(1000);
    }
    check(!!job && job.status === 'done', '带音频导出完成', job ? job.status + (job.error ? ' ' + job.error : '') : '无');
    if (!job || job.status !== 'done') return finish(tmp);
    check(job.audio && job.audio.music === 1, '任务记录音乐轨', job.audio ? JSON.stringify(job.audio) : '无');

    const outFile = path.join(tmp, 'output', path.basename(job.outputPath));
    check(fs.existsSync(outFile), '产物文件存在');
    const detail = tm._probeMedia(outFile);
    check(detail.success && detail.hasAudio === true, '产物含音轨');
    check(Math.abs(detail.duration - filmDur) < 0.4, '音频不改变时长', `实测 ${detail.duration.toFixed(2)}s`);
    const mean = await audioMixer.probeMeanVolume(outFile);
    const db = mean === null ? NaN : (String(mean).toLowerCase() === '-inf' ? -Infinity : parseFloat(mean));
    check(Number.isFinite(db) && db > -60, '音轨非静音', mean === null ? '无法探测' : mean + ' dB');

    const after = fs.statSync(found.filePath);
    check(after.mtimeMs === srcStat.mtimeMs && after.size === srcStat.size, '源 mp3 未被改动');
  } catch (e) {
    check(false, '真机验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  finish(tmp);
})();

function finish() {
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
}
