#!/usr/bin/env node
// ============================================================
// 剪辑台「保留原声」验收（2026-11-22）
// ------------------------------------------------------------
// 背景（用户反馈）：成片自带音频进剪辑台后会被静默丢弃——导出只留配乐，
// 没有配乐时甚至导出**无音轨**视频，界面上没有任何提示。
//
// 旧实现两处丢音：
//   1) src/editorExporter.js 拼接阶段写死 ignoreAudio:true → 先产出无声视频
//   2) src/processors/audioMixer.js 的 -map 只有 0:v + 配乐轨，从不接 0:a
//
// 本脚本用真 ffmpeg 证明「保留原声」确实生效：
//   A) keepSourceAudio=true  + 配乐静音 → 输出应有可闻原声
//   B) keepSourceAudio=false + 配乐静音 → 输出应接近静音
//   A 比 B 明显响，才说明源音轨真的进了混音（而不是被静音或只改了标签）
//   C) 配乐 + 原声并存 → 有音频流且非静音
//   D) mixBgmPlan 全链路：只有原声（无配乐）也能出片
//
// 用法：node scripts/verify-editor-keep-original-audio.js
// 退出码 0 = 全部通过；非 0 = 有失败。
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = require(path.join(ROOT, 'config'));
const FF = config.FFMPEG_PATH;
const audioMixer = require('../src/processors/audioMixer');
const transitionMixer = require('../src/processors/transitionMixer');

const DIR = path.join(ROOT, 'output', `_verify_origaudio_${process.pid}`);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '  —  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  —  ' + extra : '')); }
}
const run = (args) => spawnSync(FF, args, { stdio: 'ignore' }).status === 0;
const P = (n) => path.join(DIR, n);

(async () => {
  console.log('================================================================');
  console.log('剪辑台「保留原声」：真 ffmpeg 混音验收');
  console.log('================================================================');
  if (!FF || !fs.existsSync(FF)) {
    console.log('  FAIL  找不到 ffmpeg（读 config.FFMPEG_PATH）');
    process.exit(1);
  }
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  try {
    // ---- 1) 素材：两段带不同音调的视频 + 一段配乐 ----
    ok(run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=4:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=44100',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', P('c1.mp4')]),
      '素材片段1（440Hz 音轨）');
    ok(run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=4:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4:sample_rate=44100',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', P('c2.mp4')]),
      '素材片段2（660Hz 音轨）');
    ok(run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8:sample_rate=44100',
      '-c:a', 'aac', P('music.m4a')]), '素材配乐（220Hz）');

    // ---- 2) 拼接必须带上源音轨（旧实现这里是无声）----
    const concatOut = P('concat.mp4');
    const cc = await transitionMixer.concatWithTransitions(
      [{ path: P('c1.mp4'), inSec: 0, outSec: 4 }, { path: P('c2.mp4'), inSec: 0, outSec: 4 }],
      concatOut, { enabled: true, duration: 0.4, ignoreAudio: false }
    );
    ok(cc.success === true, '带原声拼接成功', cc.error || '');
    ok(await audioMixer.probeHasAudioStream(concatOut), '拼接产物含音频流');

    const dur = 7.6;
    // 配乐音量置 0：把「有没有原声」单独隔离出来
    const silentMusic = {
      music: [{ trackId: 'tmp_music', filePath: P('music.m4a'), timelineStart: 0, timelineEnd: 8, volume: 0 }],
      ambient: []
    };

    // ---- 3) A：保留原声 ----
    const A = P('out_keep.mp4');
    const bA = audioMixer.buildMixArgs(concatOut, A, silentMusic, dur, { keepSourceAudio: true, sourceVolume: 1 });
    ok(bA.ok === true, 'buildMixArgs(keepSourceAudio) 生成命令', bA.error || '');
    ok(run(bA.args), 'A 混音执行成功');
    const volA = Number(await audioMixer.probeMeanVolume(A));

    // ---- 4) B：丢弃原声（对照组）----
    const B = P('out_drop.mp4');
    const bB = audioMixer.buildMixArgs(concatOut, B, silentMusic, dur, { keepSourceAudio: false, sourceVolume: 1 });
    ok(bB.ok === true, 'buildMixArgs(丢弃原声) 生成命令', bB.error || '');
    ok(run(bB.args), 'B 混音执行成功');
    const volB = Number(await audioMixer.probeMeanVolume(B));

    console.log(`  mean volume: keep=${volA} dB / drop=${volB} dB`);
    ok(Number.isFinite(volA) && volA > -50, 'A 有可闻原声（> -50 dB）', String(volA));
    ok(!Number.isFinite(volB) || volB < -80, 'B 对照组接近静音（< -80 dB）', String(volB));
    ok(Number.isFinite(volA) && (!Number.isFinite(volB) || volA > volB + 20),
      'A 明显比 B 响（证明源音轨真的进了混音）',
      Number.isFinite(volA) && Number.isFinite(volB) ? `diff=${(volA - volB).toFixed(1)}dB` : '');

    // ---- 5) C：配乐 + 原声并存 ----
    const C = P('out_both.mp4');
    const bothPlan = {
      music: [{ trackId: 'tmp_music', filePath: P('music.m4a'), timelineStart: 0, timelineEnd: 8, volume: 0.8 }],
      ambient: []
    };
    const bC = audioMixer.buildMixArgs(concatOut, C, bothPlan, dur, { keepSourceAudio: true, sourceVolume: 0.8 });
    ok(bC.ok === true, 'buildMixArgs(配乐+原声) 生成命令', bC.error || '');
    ok(run(bC.args), 'C 混音执行成功');
    ok(await audioMixer.probeHasAudioStream(C), 'C 产物含音频流');
    const volC = Number(await audioMixer.probeMeanVolume(C));
    ok(Number.isFinite(volC) && volC > -50, 'C 不是静音', String(volC));

    // ---- 6) D：mixBgmPlan 全链路（无配乐、只保留原声）----
    const D = P('out_src_only.mp4');
    const md = await audioMixer.mixBgmPlan(concatOut, D, { music: [], ambient: [] }, { keepSourceAudio: true });
    ok(md.success === true, 'mixBgmPlan(只保留原声) 成功', md.error || '');
    ok(md.keptSourceAudio === true, '返回值标注 keptSourceAudio', String(md.keptSourceAudio));
    ok(await audioMixer.probeHasAudioStream(D), '只保留原声的产物含音频流');

    // ---- 7) 无音轨输入：不能让 [0:a] 把命令搞崩，必须是可读的失败/降级 ----
    // 说明：本仓库 assets/bgm 不带 mp3，无法登记真实音轨，所以这里只能验「无配乐」分支：
    // 输入无音轨时 keepSourceAudio 会被降级，进而明确报「配乐计划为空」，而不是畸形滤镜图。
    const silentClip = P('silent.mp4');
    run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentClip]);
    ok((await audioMixer.probeHasAudioStream(silentClip)) === false, '无音轨素材探测为 false');
    const E = P('out_no_audio_src.mp4');
    const me = await audioMixer.mixBgmPlan(silentClip, E, { music: [], ambient: [] }, { keepSourceAudio: true });
    ok(me.success === false && /配乐计划为空/.test(String(me.error || '')),
      '无音轨输入 + 无配乐：给出可读错误（不产出畸形命令）', me.error || '');
  } catch (e) {
    fail++;
    console.log('  FAIL  运行时异常: ' + (e && e.message ? e.message : e));
  } finally {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
