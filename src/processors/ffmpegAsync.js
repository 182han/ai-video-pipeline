// ============================================================
// ffmpeg 异步执行器（主线程侧，2026-11-23）
// ------------------------------------------------------------
// 一个常驻 worker 线程串行执行 ffmpeg 命令；主线程只拿 Promise。
// 只做「执行 + 成功/失败」，不解析输出——需要输出的场景按既有做法
// 把 stderr/stdout 重定向到临时文件（worker 的 stderrFile 参数），再在主线程读。
//
// 设计取舍：
//   · 串行队列：ffmpeg 任务本来就互相依赖（归一化 → 拼接 → 校验），并发只会抢 CPU；
//   · worker 懒启动：没有视频任务时不起线程；
//   · worker 崩溃：把在飞的所有请求 reject，下次调用重新起线程（不让整条流水线悬死）。
// ============================================================

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'ffmpegWorker.js');

let worker = null;
let seq = 0;
const pending = new Map();

function rejectAll(err) {
  for (const [, p] of pending) {
    try { p.reject(err); } catch (e) { /* ignore */ }
  }
  pending.clear();
}

function dispose() {
  if (!worker) return;
  try { worker.removeAllListeners(); } catch (e) { /* ignore */ }
  try { worker.terminate(); } catch (e) { /* ignore */ }
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  const w = new Worker(WORKER_PATH);
  w.on('message', (m) => {
    if (!m || m.id === undefined || m.id === null) return;
    const slot = pending.get(m.id);
    if (!slot) return;
    pending.delete(m.id);
    slot.resolve({ ok: m.ok === true, error: m.error || null, code: m.code || null });
  });
  w.on('error', (e) => {
    const err = e instanceof Error ? e : new Error(String(e));
    if (worker === w) { worker = null; }
    rejectAll(err);
  });
  w.on('exit', (code) => {
    if (worker === w) { worker = null; }
    if (pending.size) {
      rejectAll(new Error(`ffmpeg worker 已退出（code=${code}），在飞任务被中断`));
    }
  });
  // 注意：**不要** w.unref()。实测代价：主线程 await 期间没有其它活动句柄，
  // 进程会直接退出，Promise 永远不 settle（脚本里表现为静默无输出）。
  // 服务本身由 http server 保持存活，不需要靠 unref 退出；脚本用完调 shutdown()。
  worker = w;
  return w;
}

/**
 * 异步执行一条 ffmpeg/ffprobe 命令（stdio 忽略，不占主线程）。
 * @param {string} cmd 完整命令字符串（与既有 execSync 调用拼法一致）
 * @param {{cwd?: string, stderrFile?: string}} opts
 * @returns {Promise<{ok: boolean, error: string|null, code: string|null}>}
 */
function runFFmpegAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = ensureWorker();
    } catch (e) {
      reject(e);
      return;
    }
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({
        id,
        cmd: String(cmd),
        opts: {
          cwd: opts && opts.cwd ? String(opts.cwd) : null,
          stderrFile: opts && opts.stderrFile ? String(opts.stderrFile) : null
        }
      });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

/** 关闭 worker（验收脚本/退出时可调用；服务不需要） */
function shutdown() {
  rejectAll(new Error('ffmpeg worker 已关闭'));
  dispose();
}

module.exports = { runFFmpegAsync, shutdown };
