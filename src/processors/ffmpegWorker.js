// ============================================================
// ffmpeg 执行 worker（2026-11-23）
// ------------------------------------------------------------
// 为什么要有这个文件：主线程用 execSync 跑 ffmpeg 会把 Node 事件循环整个占住，
// 拼接/循环/转码那几分钟里所有 HTTP（库、剪辑台）与 WebSocket 进度全部排队。
// worker_threads 里同样用 execSync，但阻塞发生在 worker 线程，主线程照常响应。
//
// 为什么不用 spawn：本机/部分沙箱把 CreateProcess 级 spawn 拦成 EPERM，
// 而 execSync（经 cmd.exe、stdio:'ignore'）可用。实测：
//   worker 里 execSync(stdio:'pipe') → spawnSync cmd.exe EPERM
//   worker 里 execSync(stdio:'ignore') → 成功
// 所以这里默认 ignore；需要 stderr 时按仓库既有做法重定向到临时文件再读。
// ============================================================

const { parentPort } = require('worker_threads');
const { execSync } = require('child_process');

function runOne(cmd, opts) {
  const exeOpts = { stdio: 'ignore', windowsHide: true };
  if (opts && opts.cwd) exeOpts.cwd = String(opts.cwd);
  try {
    if (opts && opts.stderrFile) {
      execSync(`${cmd} 2> "${opts.stderrFile}"`, exeOpts);
    } else {
      execSync(cmd, exeOpts);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || null };
  }
}

parentPort.on('message', (msg) => {
  if (!msg || msg.id === undefined || msg.id === null) return;
  const out = runOne(String(msg.cmd || ''), msg.opts || {});
  parentPort.postMessage({
    id: msg.id,
    ok: out.ok,
    error: out.error || null,
    code: out.code || null
  });
});
