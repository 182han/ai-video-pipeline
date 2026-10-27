#!/usr/bin/env node
// ==========================================
// 接缝处理性能基准 —— scripts/bench-seam-perf.js
// ==========================================
//
// 为什么需要它：
//   「片段间转场」（xfade 交叉淡化）在项目里**默认关闭**，官方理由是
//   「开启后拼接不再 -c copy，长片会明显变慢」（AGENTS.md §6）。但这句
//   「明显变慢」从来没有实测数字。要决定「是否默认开启转场」「30 分钟成片
//   能不能接受」，必须先量出来。
//
// 本脚本对同一个任务的真实片段做三种拼接，逐项计时：
//   A) -c copy 直拼            —— TRANSITION_ENABLED=false 且规格一致时的现状
//   B) 整片重编码直拼（同参数） —— 无转场但仍需重编码时的下限成本
//   C) 生产代码真转场            —— 直接调用 src/processors/transitionMixer
//      注意：它在需要归一化时会**先逐段重编码（veryfast crf18）、再整片
//      重编码（medium crf23）**，即最多两遍编码。这是耗时的主要来源。
//
// 红线（AGENTS.md §4.7）：产物一律写系统临时目录，**不写入 app/output/**。
//
// 用法：
//   node scripts/bench-seam-perf.js --task task_mvhrynuu_ehtn
//   node scripts/bench-seam-perf.js --task task_xxx --fade 0.4 --only C
//
// 退出码：0 = 全部完成；1 = 某一步失败（失败项会写明原因）
// ==========================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const config = require(path.join(APP_ROOT, 'config'));
const transitionMixer = require(path.join(APP_ROOT, 'src', 'processors', 'transitionMixer'));

const FFMPEG = config.FFMPEG_PATH;
const FFPROBE = config.FFPROBE_PATH;

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const TASK_ID = arg('--task');
const FADE = parseFloat(arg('--fade', '0.4'));
const ONLY = arg('--only');

if (!TASK_ID) {
  console.error('用法: node scripts/bench-seam-perf.js --task <taskId> [--fade 0.4] [--only A|B|C]');
  process.exit(1);
}

const taskFile = path.join(APP_ROOT, 'data', 'tasks', `${TASK_ID}.json`);
if (!fs.existsSync(taskFile)) { console.error(`任务文件不存在: ${taskFile}`); process.exit(1); }
const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));

const clips = (task.clips || [])
  .map(c => ({ path: c.videoPath, duration: Number(c.duration) || null }))
  .filter(c => c.path && fs.existsSync(c.path));

if (clips.length < 2) { console.error(`可用片段不足 2 个（找到 ${clips.length}）`); process.exit(1); }

const totalInputSec = clips.reduce((a, c) => a + (c.duration || 0), 0);
console.log(`\n任务 ${TASK_ID}：${clips.length} 个片段，标称总时长 ${totalInputSec.toFixed(2)}s，fade=${FADE}s`);
console.log(`预计成片时长：copy/直拼 ${totalInputSec.toFixed(2)}s；转场 ${(totalInputSec - (clips.length - 1) * FADE).toFixed(2)}s\n`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchseam_'));

// 与 repo 一致：不捕获 stdout（EPERM），重定向到文件
function timeFF(cmd) {
  const t0 = Date.now();
  const log = path.join(tmpDir, 'bench.log');
  let ok = true, err = '';
  try {
    execSync(`${cmd} > "${log}" 2>&1`, { stdio: 'ignore', cwd: tmpDir, timeout: 60 * 60 * 1000 });
  } catch (e) {
    ok = false;
    try { err = fs.readFileSync(log, 'utf8').split('\n').filter(l => l.trim()).slice(-3).join(' | '); } catch (_) {}
  }
  return { ok, err, ms: Date.now() - t0 };
}

function probeDuration(file) {
  const log = path.join(tmpDir, `probe_${Date.now()}.txt`);
  try {
    execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${file}" > "${log}" 2>&1`,
      { stdio: 'ignore', cwd: tmpDir, timeout: 60000 });
    const v = parseFloat(fs.readFileSync(log, 'utf8').trim());
    return Number.isFinite(v) ? v : null;
  } catch (e) { return null; }
}

function fmt(ms) { return (ms / 1000).toFixed(2) + ' s'; }
function ratio(ms, srcSec) { return srcSec > 0 ? ((ms / 1000) / srcSec).toFixed(2) + '× 实时' : '—'; }

const results = [];

// ---- A) -c copy 直拼 ----
if (!ONLY || ONLY.toUpperCase() === 'A') {
  const listFile = path.join(tmpDir, 'list_copy.txt');
  fs.writeFileSync(listFile, clips.map(c => `file '${c.path.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const out = path.join(tmpDir, 'A_copy.mp4');
  const r = timeFF(`"${FFMPEG}" -y -f concat -safe 0 -i "${listFile}" -c copy "${out}"`);
  const dur = r.ok ? probeDuration(out) : null;
  results.push({ mode: 'A -c copy 直拼', ok: r.ok, ms: r.ms, outSec: dur, err: r.err });
  console.log(`A) -c copy 直拼          ${r.ok ? fmt(r.ms) : '失败'}  ${r.ok ? `(${ratio(r.ms, totalInputSec)})` : r.err}`);
}

// ---- B) 整片重编码直拼（与转场最终编码同参数，作为「无转场也要重编码」的下限）----
if (!ONLY || ONLY.toUpperCase() === 'B') {
  const listFile = path.join(tmpDir, 'list_reenc.txt');
  fs.writeFileSync(listFile, clips.map(c => `file '${c.path.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const out = path.join(tmpDir, 'B_reencode.mp4');
  const r = timeFF(`"${FFMPEG}" -y -f concat -safe 0 -i "${listFile}" `
    + `-c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -an -movflags +faststart "${out}"`);
  const dur = r.ok ? probeDuration(out) : null;
  results.push({ mode: 'B 整片重编码直拼', ok: r.ok, ms: r.ms, outSec: dur, err: r.err });
  console.log(`B) 整片重编码直拼(medium) ${r.ok ? fmt(r.ms) : '失败'}  ${r.ok ? `(${ratio(r.ms, totalInputSec)})` : r.err}`);
}

// ---- C) 生产代码真转场（transitionMixer 是 async，统一放到下面的异步块里跑）----

// 汇总与 C 一起放在异步块内（顶层 await 在 CommonJS 里不可用）
(async () => {
  if (!ONLY || ONLY.toUpperCase() === 'C') {
    const out = path.join(tmpDir, 'C_xfade.mp4');
    const t0 = Date.now();
    let res;
    try {
      res = await transitionMixer.concatWithTransitions(
        clips.map(c => c.path),
        out,
        { fadeDuration: FADE, duration: FADE, transitionType: 'fade' }
      );
    } catch (e) {
      res = { success: false, error: e.message };
    }
    const ms = Date.now() - t0;
    const ok = !!(res && res.success);
    const dur = ok ? (res.actualDuration || probeDuration(out)) : null;
    results.push({ mode: 'C 生产转场(xfade)', ok, ms, outSec: dur, err: res && res.error, extra: res });
    console.log(`C) 生产转场 xfade        ${ok ? fmt(ms) : '失败'}  ${ok ? `(${ratio(ms, totalInputSec)})` : (res && res.error)}`);
    if (ok && res) {
      console.log(`   期望时长 ${res.expectedDuration ?? '—'} / 实测 ${res.actualDuration ?? '—'}`
        + `  归一化片段数 ${res.normalized ?? '未返回'}`);
    }

    // ---- 汇总 ----
    console.log('\n=== 汇总 ===');
    const byMode = Object.fromEntries(results.map(r => [r.mode, r]));
    for (const r of results) {
      console.log(`${r.ok ? '✅' : '❌'} ${r.mode.padEnd(22)} ${fmt(r.ms).padStart(10)}`
        + `  ${r.outSec != null ? r.outSec.toFixed(2) + 's 成片' : ''}`);
    }
    const A = results.find(r => r.mode.startsWith('A'));
    const B = results.find(r => r.mode.startsWith('B'));
    const C = results.find(r => r.mode.startsWith('C'));
    if (A && B && A.ok && B.ok && B.ms > 0) {
      console.log(`\n转场总成本 / 重编码直拼 = ${(C && C.ok) ? (C.ms / B.ms).toFixed(2) + '×' : '—'}`);
      console.log(`重编码直拼 / copy直拼   = ${A.ms > 0 ? (B.ms / A.ms).toFixed(1) + '×' : '—'}`);
    }
    // 吞吐量（供 30 分钟成片推算用）
    if (B && B.ok && totalInputSec > 0) {
      const secPerSec = totalInputSec / (B.ms / 1000);
      console.log(`\n重编码吞吐（medium crf23）：${secPerSec.toFixed(2)} 秒成片/秒墙钟`);
      console.log(`  → 30 分钟成片纯重编码预计 ${(1800 / secPerSec / 60).toFixed(1)} 分钟（推算，基于上面实测吞吐）`);
    }
    if (C && C.ok && totalInputSec > 0) {
      const secPerSec = totalInputSec / (C.ms / 1000);
      console.log(`转场吞吐（含归一化+整片编码）：${secPerSec.toFixed(2)} 秒成片/秒墙钟`);
      console.log(`  → 30 分钟成片开转场预计 ${(1800 / secPerSec / 60).toFixed(1)} 分钟（推算，基于上面实测吞吐）`);
    }
    if (A && A.ok && totalInputSec > 0) {
      const secPerSec = totalInputSec / (A.ms / 1000);
      console.log(`copy 直拼吞吐：${secPerSec.toFixed(1)} 秒成片/秒墙钟`);
    }

    fs.writeFileSync(path.join(tmpDir, 'bench-result.json'), JSON.stringify({
      taskId: TASK_ID, fade: FADE, totalInputSec, clips: clips.length, results
    }, null, 2), 'utf8');
    console.log(`\n临时产物目录（可删）：${tmpDir}`);
    process.exit(results.every(r => r.ok) ? 0 : 1);
  }
})();
