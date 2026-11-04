// ============================================================
// 转场拼接 · 运行时验收（真 ffmpeg）
// ------------------------------------------------------------
// 覆盖 2026-11-04 新增的三件事：
//   1) 进度回调（-progress 文件解析）
//   2) 取消（AbortSignal）
//   3) 编码器探测与回退（auto → nvenc/qsv/amf → libx264）
//
// 用法：node scripts/verify-transition-runtime.js
// ============================================================
const fs = require('fs');
const path = require('path');

const transitionMixer = require('../src/processors/transitionMixer');

const ROOT = path.join(__dirname, '..');
const CLIPS = path.join(ROOT, 'clips');
const OUT = path.join(ROOT, 'data', 'spike');
const FADE = 0.4;

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}

function validNames() {
  return fs.readdirSync(CLIPS)
    .filter((f) => /^mock_.*\.mp4$/i.test(f))
    .filter((f) => {
      try { if (fs.statSync(path.join(CLIPS, f)).size < 1024) return false; } catch (e) { return false; }
      return transitionMixer._probeMedia(path.join(CLIPS, f)).success;
    })
    .sort();
}

(async () => {
  console.log('================================================================');
  console.log('转场拼接运行时验收：进度 / 取消 / 编码器');
  console.log('================================================================');
  fs.mkdirSync(OUT, { recursive: true });

  const names = validNames();
  ok(names.length > 0, '存在可用 mock 片段', `${names.length} 个`);
  if (!names.length) return finish();

  const seg = (i) => ({ path: path.join(CLIPS, names[i % names.length]), inSec: 0, outSec: null });

  // ---- 1) 编码器探测 ----
  const enc = transitionMixer._pickEncoder();
  ok(Object.prototype.hasOwnProperty.call(transitionMixer._ENCODERS, enc), '编码器探测返回合法值', enc);
  const forced = String((require('../config').TRANSITIONS || {}).encoder || 'auto');
  ok(['auto', 'libx264', 'nvenc', 'qsv', 'amf'].includes(forced.toLowerCase()), 'TRANSITIONS.encoder 配置值合法', forced);

  // ---- 2) 进度回调 ----
  const progress = [];
  const out2 = path.join(OUT, 'runtime_progress.mp4');
  const r2 = await transitionMixer.concatWithTransitions([seg(0), seg(1)], out2, {
    duration: FADE, type: 'fade', resolution: '720p',
    onProgress: (p) => progress.push(p)
  });
  ok(!!r2.success, '带进度回调的拼接成功');
  ok(progress.length >= 1, '进度回调至少触发一次', `${progress.length} 次`);
  const withPercent = progress.filter((p) => typeof p.percent === 'number');
  ok(withPercent.length >= 1, '回调含数值型 percent', withPercent.length ? `最后 ${withPercent[withPercent.length - 1].percent}%` : '-');
  ok(progress.some((p) => p.phase === 'done' && p.percent === 100), '完成时回报 100%');
  ok(r2.encoder === enc, '返回值带实际编码器', r2.encoder);

  // ---- 3) 取消 ----
  const out3 = path.join(OUT, 'runtime_cancel.mp4');
  try { if (fs.existsSync(out3)) fs.unlinkSync(out3); } catch (e) { /* ignore */ }
  const ctrl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 1200);
  const segs30 = [];
  for (let i = 0; i < 30; i++) segs30.push(seg(i));
  const r3 = await transitionMixer.concatWithTransitions(segs30, out3, {
    duration: FADE, type: 'fade', resolution: '720p', signal: ctrl.signal
  });
  const elapsed = Date.now() - t0;
  ok(r3.cancelled === true && r3.success === false, '取消后返回 cancelled=true');
  ok(elapsed < 15000, '取消在 15s 内生效', `${(elapsed / 1000).toFixed(1)}s`);
  ok(!fs.existsSync(out3), '取消后不留下半成品文件');

  // ---- 4) 预取消 ----
  const pre = new AbortController();
  pre.abort();
  const r4 = await transitionMixer.concatWithTransitions([seg(0), seg(1)], path.join(OUT, 'runtime_precancel.mp4'), {
    duration: FADE, type: 'fade', resolution: '720p', signal: pre.signal
  });
  ok(r4.cancelled === true, '已中止的 signal 立即返回 cancelled');

  finish();
})().catch((e) => {
  console.error('验收异常:', e && e.message ? e.message : e);
  process.exit(1);
});

function finish() {
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
}
