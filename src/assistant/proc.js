// ==========================================
// 小智 · 子进程执行工具（P5）
// ------------------------------------------------------------
// 本机限制（AGENTS §2.3、P4 交接已记录）：Node 用「pipe 捕获 stdout」启动子进程
// 会 EPERM（`execFileSync(node, ['-v'])` 都失败）；但把 stdout/stderr 重定向到
// **文件描述符**是允许的（`verify-scene-cards` 的 ffmpeg 就是这么跑的）。
//
// 因此小智调用 ffmpeg / ffprobe / sherpa 一律走这里：
//   spawnSync(exe, args, { stdio: ['ignore', fdOut, fdErr] }) → 读文件 → 删除临时文件。
// 不拼字符串命令（避免 Windows cmd.exe 引号/`%VAR%` 展开的坑）。
// ==========================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..', '..');
const TMP_DIR = process.env.ASSISTANT_DIR
  ? path.join(path.resolve(process.env.ASSISTANT_DIR), 'tmp')
  : path.join(APP_DIR, 'data', 'assistant', 'tmp');

function tmpDir() {
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) { /* 由调用方报错 */ }
  return TMP_DIR;
}

function stamp() {
  return Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

/**
 * 跑一个子进程，把 stdout/stderr 落到临时文件再读回（避免 pipe EPERM）。
 * @param {string} exe 可执行文件绝对路径
 * @param {string[]} args 参数数组（不拼 shell）
 * @param {object} options { cwd?, timeoutMs?, dir? }
 * @returns {{status:number|null, signal:string|null, error:string|null, stdout:string, stderr:string, elapsedMs:number}}
 */
function runToFiles(exe, args, options = {}) {
  const dir = options.dir || tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const tag = stamp();
  const outFile = path.join(dir, `run-${tag}.out`);
  const errFile = path.join(dir, `run-${tag}.err`);
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  const t0 = Date.now();
  let res;
  try {
    res = spawnSync(exe, Array.isArray(args) ? args : [], {
      cwd: options.cwd || path.dirname(exe),
      stdio: ['ignore', fdOut, fdErr],
      timeout: options.timeoutMs || 120000,
      windowsHide: true
    });
  } finally {
    try { fs.closeSync(fdOut); } catch (e) { /* ignore */ }
    try { fs.closeSync(fdErr); } catch (e) { /* ignore */ }
  }
  let stdout = '';
  let stderr = '';
  try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) { /* ignore */ }
  try { stderr = fs.readFileSync(errFile, 'utf8'); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(errFile); } catch (e) { /* ignore */ }
  return {
    status: res.status,
    signal: res.signal || null,
    error: res.error ? (res.error.code || res.error.message) : null,
    stdout,
    stderr,
    elapsedMs: Date.now() - t0
  };
}

function tail(text, lines = 3) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-lines).join(' ');
}

module.exports = {
  APP_DIR,
  TMP_DIR,
  tmpDir,
  runToFiles,
  stamp,
  tail
};
