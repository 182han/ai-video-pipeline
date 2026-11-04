// ============================================================
// 转场拼接 · 规模验收（真实 ffmpeg）
// ------------------------------------------------------------
// 背景：旧实现用 execSync + 整条 filter 字符串，40 段就超 Windows 命令行上限。
// 本脚本用重构后的 transitionMixer 跑 N 段，校验：
//   1) 拼接成功
//   2) 时长 = Σd − (N−1)·F
//   3) transitions 数量正确、产物可播放
//
// 用法：
//   node scripts/verify-transition-scale.js              # 默认 60 段
//   node scripts/verify-transition-scale.js --n=40       # 回归旧失败点
//   node scripts/verify-transition-scale.js --n=360      # G0 规模（慢）
//   node scripts/verify-transition-scale.js --resolution=1080p
// ============================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const config = require('../config');
const transitionMixer = require('../src/processors/transitionMixer');

const FFMPEG_PATH = config.FFMPEG_PATH || 'ffmpeg';
const ROOT = path.join(__dirname, '..');
const CLIPS = path.join(ROOT, 'clips');
const OUT = path.join(ROOT, 'data', 'spike');
const FADE = 0.4;

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const N = Math.max(2, parseInt(arg('n', '60'), 10) || 60);
const RESOLUTION = arg('resolution', '720p');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}

function validMockNames() {
  const all = fs.readdirSync(CLIPS).filter((f) => /^mock_.*\.mp4$/i.test(f)).sort();
  const good = [];
  for (const f of all) {
    const p = path.join(CLIPS, f);
    try { if (fs.statSync(p).size < 1024) continue; } catch (e) { continue; }
    const d = transitionMixer._probeMedia(p);
    if (d.success && d.duration > 0) good.push(f);
  }
  return good;
}

async function main() {
  console.log('================================================================');
  console.log(`转场拼接规模验收：N=${N}  resolution=${RESOLUTION}  fade=${FADE}s`);
  console.log('================================================================');

  fs.mkdirSync(OUT, { recursive: true });
  const names = validMockNames();
  ok(names.length > 0, '存在可用 mock 片段', `${names.length} 个`);
  if (!names.length) return finish();

  const names40 = [];
  const durs = [];
  for (let i = 0; i < N; i++) {
    const name = names[i % names.length];
    const d = transitionMixer._probeMedia(path.join(CLIPS, name));
    names40.push(name);
    durs.push(d.duration);
  }
  const clipDur = durs[0];
  const sumDur = durs.reduce((s, d) => s + d, 0);
  const segs = names40.map((name) => ({ path: path.join(CLIPS, name), inSec: 0, outSec: null }));

  const out = path.join(OUT, `scale_${N}.mp4`);
  const expected = Math.round((sumDur - (N - 1) * FADE) * 1000) / 1000;
  const t0 = Date.now();
  const res = await transitionMixer.concatWithTransitions(segs, out, {
    duration: FADE,
    type: 'fade',
    resolution: RESOLUTION
  });
  const ms = Date.now() - t0;

  ok(!!res.success, '拼接成功', res.success ? `${(ms / 1000).toFixed(1)}s` : res.error);
  if (!res.success) return finish();

  ok(fs.existsSync(out) && fs.statSync(out).size > 1024, '产物存在且非空', `${fs.statSync(out).size} bytes`);
  ok(res.transitions === N - 1, '接缝数正确', `${res.transitions}`);
  ok(Math.abs(res.expectedDuration - expected) < 0.01, 'expectedDuration 口径正确', `回报 ${res.expectedDuration}，期望 ${expected}`);
  const tol = Math.max(0.25, 3 / (res.fps || 25));
  ok(Math.abs(res.actualDuration - expected) <= tol, '实测时长 = Σd − (N−1)F',
    `实测 ${res.actualDuration}s，期望 ${expected}s，容差 ±${tol.toFixed(2)}s`);

  const probe = transitionMixer._probeMedia(out);
  ok(probe.success, '产物可被 ffprobe 读取');
  // 完整解码：截断的 copy 拼接会在这里露馅
  let decodeOk = true;
  try {
    execSync(`"${FFMPEG_PATH}" -v error -i "${out}" -f null -`, { stdio: 'ignore' });
  } catch (e) { decodeOk = false; }
  ok(decodeOk, '产物可完整解码');

  console.log(`\n产物: ${out}`);
  console.log(`耗时: ${(ms / 1000).toFixed(1)}s，输出 ${res.actualDuration}s（${(res.actualDuration / (ms / 1000)).toFixed(2)}× 实时）`);
  finish();
}

function finish() {
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验收异常:', e && e.message ? e.message : e);
  process.exit(1);
});
