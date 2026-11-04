// ============================================================
// spike · 剪辑台导出规模实验（2026-11-04）
// ------------------------------------------------------------
// 目的：在 100 / 360 段规模上验证两件事
//   A) 现有 transitionMixer（execSync + 整条 filter 字符串）多少段会失败
//   B) 「filter 写文件 + execFile 参数数组 + 相对短路径」能否成功，耗时多少
//
// 只读业务代码（不改 src/）；产物写 data/spike/。
// 非生产参数：veryfast / crf 28 / 720p 输出，仅用于证明命令与规模，
// 不代表最终画质与生产耗时。
//
// 用法：node scripts/spike-editor-export.js
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../config');
const videoProcessor = require('../src/videoProcessor');
const transitionMixer = require('../src/processors/transitionMixer');

const ROOT = path.join(__dirname, '..');
const CLIPS = path.join(ROOT, 'clips');
const OUT = path.join(ROOT, 'data', 'spike');
const FFMPEG = config.FFMPEG_PATH;
const FADE = 0.4;
const OUT_W = 1280;
const OUT_H = 720;
const OUT_FPS = 25;

fs.mkdirSync(OUT, { recursive: true });

function mockNames() {
  const all = fs.readdirSync(CLIPS)
    .filter((f) => /^mock_.*\.mp4$/i.test(f))
    .sort();
  const good = [];
  const bad = [];
  for (const f of all) {
    const p = path.join(CLIPS, f);
    let size = 0;
    try { size = fs.statSync(p).size; } catch (e) { /* ignore */ }
    if (size < 1024) { bad.push(f + '(size)'); continue; }
    const d = videoProcessor.probeDetail(p);
    if (d.success && d.duration > 0 && d.width) good.push(f);
    else bad.push(f + '(probe)');
  }
  if (bad.length) console.log(`[spike] 跳过无效 mock 片段 ${bad.length} 个：${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}`);
  return good;
}

function pickNames(names, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(names[i % names.length]);
  return out;
}

// A) 现有实现：传绝对路径，让它自己拼命令
async function oldPathTest(names, n, clipDur) {
  const segs = pickNames(names, n).map((name) => ({
    path: path.join(CLIPS, name),
    inSec: 0,
    outSec: null
  }));
  const out = path.join(OUT, `old_${n}.mp4`);
  const t0 = Date.now();
  let res;
  try {
    res = await transitionMixer.concatWithTransitions(segs, out, {
      duration: FADE,
      type: 'fade',
      width: 1920,
      height: 1080
    });
  } catch (e) {
    res = { success: false, error: e && e.message };
  }
  const ms = Date.now() - t0;
  return {
    kind: 'oldPath',
    n,
    ok: !!(res && res.success),
    ms,
    error: res && res.error ? String(res.error).slice(-400) : null,
    note: `clipDur=${clipDur}`
  };
}

// B) 修复路径：filter 写文件 + execFile 参数数组 + cwd 相对短路径
function buildGraph(n, clipDur) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]trim=start=0:end=${clipDur.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
      `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUT_FPS},format=yuv420p[v${i}]`
    );
  }
  let prev = 'v0';
  let acc = clipDur;
  for (let i = 1; i < n; i++) {
    const offset = acc - FADE;
    const out = `vx${i}`;
    parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${FADE.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`);
    prev = out;
    acc = acc + clipDur - FADE;
  }
  parts.push(`[${prev}]null[vout]`);
  return { text: parts.join(';\n') + '\n', duration: acc };
}

// 用文件描述符接 stderr，不用管道——本沙箱里 STDIO pipe 会 EPERM。
function runFfmpeg(args, cwd) {
  return new Promise((resolve) => {
    const errPath = path.join(OUT, `_err_${process.pid}_${Date.now()}.log`);
    let fd;
    try { fd = fs.openSync(errPath, 'w'); } catch (e) { fd = 'ignore'; }
    const t0 = Date.now();
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      const ms = Date.now() - t0;
      let error = null;
      if (code !== 0) {
        try { error = fs.readFileSync(errPath, 'utf8').slice(-600); } catch (e) { /* ignore */ }
      }
      try { if (typeof fd === 'number') fs.closeSync(fd); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(errPath); } catch (e) { /* ignore */ }
      resolve({ ok: code === 0, ms, error });
    };
    let proc;
    try {
      proc = spawn(FFMPEG, args, { cwd, stdio: ['ignore', 'ignore', fd] });
    } catch (e) {
      finish(-1);
      return;
    }
    proc.on('error', () => finish(-1));
    proc.on('exit', (code) => finish(code));
  });
}

async function fixedPathTest(names, n, clipDur, capSec) {
  const { text, duration } = buildGraph(n, clipDur);
  const graphPath = path.join(OUT, `filter_${n}${capSec ? '_cap' + capSec : ''}.txt`);
  fs.writeFileSync(graphPath, text, 'utf8');

  const outPath = path.join(OUT, `fixed_${n}${capSec ? '_cap' + capSec : ''}.mp4`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const name of pickNames(names, n)) args.push('-i', name); // cwd=CLIPS，短相对路径
  args.push(
    '-filter_complex_script', graphPath,
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-pix_fmt', 'yuv420p', '-an'
  );
  if (capSec) args.push('-t', String(capSec));
  args.push('-movflags', '+faststart', outPath);

  // 估算 Windows CreateProcess 命令行长度（含可执行文件与空格）
  const cmdLen = FFMPEG.length + args.reduce((s, a) => s + a.length + 3, 0);

  const r = await runFfmpeg(args, CLIPS);
  return {
    kind: 'fixedPath',
    n,
    capSec: capSec || null,
    ok: r.ok,
    ms: r.ms,
    cmdLen,
    graphBytes: Buffer.byteLength(text),
    expectedDuration: Math.round(duration * 1000) / 1000,
    outBytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0,
    error: r.error
  };
}

(async () => {
  const names = mockNames();
  if (!names.length) {
    console.error('没有 mock 片段，先跑一次 Mock 生成或把任意 mp4 放进 clips/');
    process.exit(1);
  }
  const probe = videoProcessor.probeDetail(path.join(CLIPS, names[0]));
  const clipDur = probe.success && probe.duration > 0 ? probe.duration : 3;
  console.log(`[spike] 样片 ${names[0]}  ${probe.width}x${probe.height}  ${clipDur}s  fps=${probe.fps}`);

  const results = {
    at: new Date().toISOString(),
    clip: names[0],
    clipDur,
    source: { width: probe.width, height: probe.height, fps: probe.fps },
    output: { width: OUT_W, height: OUT_H, fps: OUT_FPS, preset: 'veryfast', crf: 28 },
    oldPath: null,
    fixed100: null,
    fixed360: null
  };

  console.log('[spike] A) 现有实现 40 段 …');
  results.oldPath = await oldPathTest(names, 40, clipDur);
  console.log('[spike]    →', JSON.stringify(results.oldPath));

  console.log('[spike] B) 修复路径 100 段（全长）…');
  results.fixed100 = await fixedPathTest(names, 100, clipDur, null);
  console.log('[spike]    →', JSON.stringify(results.fixed100));

  console.log('[spike] B) 修复路径 360 段（只截前 3 秒，验证命令能起来）…');
  results.fixed360 = await fixedPathTest(names, 360, clipDur, 3);
  console.log('[spike]    →', JSON.stringify(results.fixed360));

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('[spike] 结果写入 data/spike/result.json');
})();
