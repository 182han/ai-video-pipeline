#!/usr/bin/env node
// 一键跑 3 个配乐验收脚本（隔离环境）
// 目的：verify-bgm-api / verify-bgm-negative / verify-bgm-e2e2 不再需要手动起服务，
//       也不会覆盖 app/output 里的正式成片。
// 做法：
//   1) 在系统临时目录建 DATA_DIR / OUTPUT_DIR / CLIPS_DIR
//   2) 从 task_mv4v7qp2_m8r0 复制一条 completed 任务副本（成片/母版都复制）
//   3) 用 AUTH_ENABLED=false + DATABASE_TYPE=json 起独立 server
//   4) 依次跑 3 个脚本，最后清理
// 用法：node scripts/verify-bgm-suite.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execSync } = require('child_process');

const APP = path.join(__dirname, '..');
const SCRIPTS = __dirname;
const SRC_ID = 'task_mv4v7qp2_m8r0';
const config = require('../config');
const FFMPEG = config.FFMPEG_PATH || 'ffmpeg';
const guard = require('./_bgm-guard');

// 配乐目录隔离：不再让临时服务使用真实 assets/bgm。
// 生成 2 条正弦 fixture + 自己的 manifest（id 沿用子套件引用的 calm_01 / nature_02）。
function makeBgmFixture(root) {
  const dir = path.join(root, 'bgm');
  fs.mkdirSync(path.join(dir, 'calm'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'nature'), { recursive: true });
  const tone = (rel, freq, dur) => {
    const p = path.join(dir, rel);
    execSync(
      `"${FFMPEG}" -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=${freq}:duration=${dur}" `
      + `-c:a libmp3lame -q:a 5 "${p}"`,
      { stdio: 'ignore' }
    );
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) throw new Error('BGM fixture 生成失败: ' + p);
  };
  tone(path.join('calm', 'fixture_music.mp3'), 440, 40);
  tone(path.join('nature', 'fixture_ambient.mp3'), 523, 40);
  const manifest = [
    { id: 'calm_01', file: 'calm/fixture_music.mp3', title: 'fixture music', author: 'fixture', license: 'test-only', durationSec: 40, mood: ['calm'], bpm: null, instruments: 'sine' },
    { id: 'nature_02', file: 'nature/fixture_ambient.mp3', title: 'fixture ambient', author: 'fixture', license: 'test-only', durationSec: 40, mood: ['nature'], bpm: null, instruments: 'sine' }
  ];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { dir };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function writeJsonNoBom(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function makeFixture(root, taskId) {
  const srcJson = path.join(APP, 'data', 'tasks', SRC_ID + '.json');
  const srcFinal = path.join(APP, 'output', SRC_ID + '_final.mp4');
  const srcMaster = path.join(APP, 'output', SRC_ID + '_master.mp4');
  for (const p of [srcJson, srcFinal, srcMaster]) {
    if (!fs.existsSync(p)) throw new Error('缺少 fixture 源文件: ' + p);
  }
  const dataDir = path.join(root, 'data');
  const outDir = path.join(root, 'output');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const j = JSON.parse(fs.readFileSync(srcJson, 'utf8'));
  j.taskId = taskId;
  j.status = 'completed';
  j.outputPath = path.join(outDir, taskId + '_final.mp4');
  j.masterPath = path.join(outDir, taskId + '_master.mp4');
  j.bgmPlan = null;
  j.bgmResult = null;
  j.bgm = {
    enabled: true, mode: 'auto', trackId: 'calm_01',
    wantMusic: true, wantAmbient: true, ambientTrackId: 'nature_02',
    fadeInSec: 2, fadeOutSec: 2, crossfadeSec: 1.5,
    volume: -20, ambientVolume: 0.125
  };
  writeJsonNoBom(path.join(dataDir, taskId + '.json'), j);
  fs.copyFileSync(srcFinal, j.outputPath);
  fs.copyFileSync(srcMaster, j.masterPath);
  return { dataDir, outDir };
}

function runNode(args, env, cwd, logFile) {
  return new Promise(resolve => {
    // 本机受限环境：stdio 用 pipe 会 spawn EPERM，改成写文件描述符
    const fd = fs.openSync(logFile, 'w');
    const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', fd, fd] });
    let done = false;
    const finish = code => {
      if (done) return;
      done = true;
      try { fs.closeSync(fd); } catch (e) {}
      let out = '';
      try { out = fs.readFileSync(logFile, 'utf8'); } catch (e) {}
      resolve({ code, out });
    };
    p.on('exit', code => finish(code));
    p.on('error', e => {
      try { fs.appendFileSync(logFile, '\nspawn error: ' + e.message); } catch (e2) {}
      finish(-1);
    });
  });
}

async function waitReady(base, getLog, server) {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('服务提前退出:\n' + getLog());
    try {
      const r = await fetch(base + '/api/status', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch (e) { /* not ready yet */ }
    await sleep(300);
  }
  throw new Error('服务 20s 内未就绪:\n' + getLog());
}

(async () => {
  const taskId = 'task_bgmtest_' + process.pid;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bgm-suite-'));
  let server = null;
  let failures = 0;
  let guardFailed = false;
  const realBefore = guard.snapshotRealBgm();
  try {
    const { dataDir, outDir } = makeFixture(root, taskId);
    const bgm = makeBgmFixture(root);
    const clipsDir = path.join(root, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });

    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    let serverLogFile = path.join(root, 'server.log');
    const serverFd = fs.openSync(serverLogFile, 'w');
    server = spawn(process.execPath, ['server.js'], {
      cwd: APP,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_ENABLED: 'false',
        DATABASE_TYPE: 'json',
        DATA_DIR: dataDir,
        OUTPUT_DIR: outDir,
        CLIPS_DIR: clipsDir,
        BGM_DIR: bgm.dir,
        STORAGE_DRIVER: ''
      },
      stdio: ['ignore', serverFd, serverFd]
    });
    const getServerLog = () => { try { return fs.readFileSync(serverLogFile, 'utf8'); } catch (e) { return ''; } };
    server.on('exit', () => { try { fs.closeSync(serverFd); } catch (e) {} });

    await waitReady(base, getServerLog, server);
    console.log('隔离服务已就绪: ' + base + '  任务: ' + taskId);

    const env = {
      ...process.env,
      BGM_TEST_BASE: base,
      BGM_TEST_TASK_ID: taskId,
      BGM_TEST_OUTPUT_DIR: outDir,
      BGM_DIR: bgm.dir
    };
    const suites = ['verify-bgm-e2e2.js', 'verify-bgm-api.js', 'verify-bgm-negative.js'];
    for (const s of suites) {
      const logFile = path.join(root, s + '.log');
      const r = await runNode([path.join(SCRIPTS, s)], env, APP, logFile);
      const lines = String(r.out || '').trim().split(/\r?\n/);
      console.log('\n===== ' + s + ' EXIT=' + r.code + ' =====');
      console.log(lines.slice(-10).join('\n'));
      if (r.code !== 0) {
        failures++;
        console.log('----- 完整输出 -----');
        console.log(r.out);
      }
    }
    const realCheck = guard.diffRealBgm(realBefore);
    guardFailed = !realCheck.ok;
    console.log('\n' + (realCheck.ok ? 'PASS  ' : 'FAIL  ') + realCheck.message);
  } catch (e) {
    failures++;
    console.error('RUNNER ERROR:', e.message);
  } finally {
    if (server) {
      try { server.kill(); } catch (e) {}
      await sleep(600);
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('\n结果: ' + (3 - Math.min(failures, 3)) + '/3 套件通过；真实 assets/bgm 隔离: ' + (guardFailed ? 'FAIL' : 'PASS'));
  process.exit(failures || guardFailed ? 1 : 0);
})();
