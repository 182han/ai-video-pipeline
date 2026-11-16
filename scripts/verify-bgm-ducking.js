#!/usr/bin/env node
// 验收：配乐闪避（ducking）——环境声作为 sidechain 压低音乐
// 1) 纯逻辑：开/关/单轨/非法参数下的滤镜图
// 2) 真机：用 8s 测试视频 + 两条真实音轨跑一遍 mixBgmPlan，证明 sidechaincompress 真能执行
// 默认配置下闪避是关闭的（BGM_DUCKING_ENABLED=false），所以本脚本显式传 ducking 选项。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config');
const fixture = require('./_bgm-fixture');
const guard = require('./_bgm-guard');
fixture.ensureIsolatedBgm('bgm_ducking');  // 必须在 require audioMixer 之前
const realBefore = guard.snapshotRealBgm();
const planner = require('../src/processors/bgmPlan');
const mixer = require('../src/processors/audioMixer');

const FFMPEG = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = config.FFPROBE_PATH || 'ffprobe';

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  —  ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  —  ' + detail : '')); }
}
const q = p => '"' + String(p).replace(/"/g, '\\"') + '"';

function probeDuration(p) {
  // 不用 execSync 读 stdout：本机受限环境会 spawn EPERM；走 audioMixer 自带的降级探测
  return mixer.probeDuration(p).catch(() => 0);
}
async function meanVolume(p) {
  try { return await mixer.probeMeanVolume(p); } catch (e) { return null; }
}

const musicTrack = mixer.findTrack('calm_01');
const ambientTrack = mixer.findTrack('nature_02');

function seg(trackId, dur) {
  return {
    id: 's', trackId, timelineStart: 0, timelineEnd: dur,
    sourceIn: 0, sourceOut: dur, volume: 1, fadeIn: 0.2, fadeOut: 0.2, speed: 1, fillMode: 'none'
  };
}

(async () => {
  console.log('=== 1. 纯逻辑：滤镜图 ===');
  ok(!!(musicTrack && ambientTrack && fs.existsSync(musicTrack.filePath) && fs.existsSync(ambientTrack.filePath)),
    '测试音轨存在', musicTrack && musicTrack.trackId);

  const plan = {
    music: [{ ...seg('calm_01', 8), filePath: musicTrack.filePath }],
    ambient: [{ ...seg('nature_02', 8), filePath: ambientTrack.filePath }]
  };

  const off = planner.buildMixCommand(plan, 8, { ducking: { enabled: false } });
  ok(off.ok && !/sidechaincompress/.test(off.filterComplex), '关闭时不出 sidechaincompress');

  const on = planner.buildMixCommand(plan, 8, { ducking: { enabled: true } });
  ok(on.ok && /sidechaincompress=/.test(on.filterComplex), '开启时出 sidechaincompress');
  ok(on.ok && /asplit=2\[ambfork\]\[ambside\]/.test(on.filterComplex), '环境声被 asplit 成混合+sidechain 两路');
  ok(on.ok && /threshold=0\.050:ratio=4\.000:attack=20:release=500:makeup=1\.000/.test(on.filterComplex),
    '默认参数进入滤镜图', (on.filterComplex || '').match(/sidechaincompress=[^\[]+/)?.[0]);

  const musicOnly = planner.buildMixCommand({ music: plan.music }, 8, { ducking: { enabled: true } });
  ok(musicOnly.ok && !/sidechaincompress/.test(musicOnly.filterComplex), '只有音乐轨时不启用闪避（没有 key）');

  const clamped = planner.buildMixCommand(plan, 8, {
    ducking: { enabled: true, threshold: 9, ratio: 999, attackMs: -5, releaseMs: 1e9, makeup: 0 }
  });
  ok(clamped.ok && /threshold=1\.000:ratio=20\.000:attack=1:release=5000:makeup=1\.000/.test(clamped.filterComplex),
    '非法参数被 clamp 到安全范围', (clamped.filterComplex || '').match(/sidechaincompress=[^\[]+/)?.[0]);

  console.log('\n=== 2. 真机：8s 视频 + 两轨 + 闪避 ===');
  const outDir = path.join(__dirname, '..', 'output', 'verify_bgm_duck_' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const video = path.join(outDir, 'base.mp4');
  const out = path.join(outDir, 'ducked.mp4');
  try {
    execSync(q(FFMPEG) + ' -y -hide_banner -loglevel error -f lavfi -i color=c=black:s=320x240:r=10:d=8 '
      + '-c:v libx264 -pix_fmt yuv420p ' + q(video), { stdio: 'ignore' });
    ok(fs.existsSync(video), '生成 8s 测试视频');

    const vd = await probeDuration(video);
    const mixPlan = {
      music: [{ ...seg('calm_01', vd), filePath: musicTrack.filePath }],
      ambient: [{ ...seg('nature_02', vd), filePath: ambientTrack.filePath }]
    };
    const r = await mixer.mixBgmPlan(video, out, mixPlan, {
      ducking: { enabled: true }, loudness: -20
    });
    ok(r.success, '带闪避的混音成功', r.success ? '' : r.error);
    if (r.success) {
      const d = await probeDuration(out);
      const mv = await meanVolume(out);
      ok(Math.abs(d - vd) <= 0.2, '产物时长与成片一致', `dur=${d.toFixed(3)} expected=${vd.toFixed(3)}`);
      ok(mv !== null && parseFloat(mv) > -85, '产物有声音（非静音）', `mean=${mv}dB`);
    }
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  }

  const realCheck = guard.diffRealBgm(realBefore);
  console.log('  '+(realCheck.ok?'PASS':'FAIL')+'  真实 assets/bgm 隔离: '+realCheck.message);
  if (!realCheck.ok) fail++;

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
