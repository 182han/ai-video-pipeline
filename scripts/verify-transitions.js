// ==========================================================
// 片段间转场（交叉淡化）验收脚本
//
// 覆盖：
//   正向 —— 2 段 / 3 段拼接时长 = Σd − (N−1)F，且完整解码
//   正向 —— 接缝处逐帧差异显著下降（证明真的融合了，而不是只改时长）
//   正向 —— 音频 acrossfade：有音轨、时长与视频一致
//   正向 —— 混合音轨（有音轨 + 无音轨）补静音后仍成功
//   正向 —— 全无音轨时只出视频流
//   正向 —— 跨分辨率归一化（480p + 720p → 720p）
//   正向 —— 首尾裁剪（inSec/outSec）
//   正向 —— 片段过短时自动收窄淡化时长（clamp）
//   负向 —— 片段过短到无法做淡化时必须 fail（不静默直通）
//   负向 —— 拼接质检不传 expectedDuration 时必须抓出「时长差」（证明 override 必要）
//
// 用法：
//   node scripts/verify-transitions.js
//   node scripts/verify-transitions.js --tmpdir output/_verify_tr
//
// 所有视频类结论以 ffprobe / ffmpeg 实测数值为准（AGENTS.md §5.1）。
// ==========================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const config = require('../config');
const transitionMixer = require('../src/processors/transitionMixer');
const videoProcessor = require('../src/videoProcessor');
const qualityChecker = require('../src/qualityChecker');

const FFMPEG = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = config.FFPROBE_PATH || 'ffprobe';

const TMP_ARG_IDX = process.argv.indexOf('--tmpdir');
const TMP = (TMP_ARG_IDX > -1 && process.argv[TMP_ARG_IDX + 1])
  ? path.resolve(process.argv[TMP_ARG_IDX + 1])
  : path.join(os.tmpdir(), `verify_tr_${process.pid}_${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail) {
  pass++;
  console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push({ name, detail });
  console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`);
}
function assert(cond, name, detail) {
  if (cond) ok(name, detail); else bad(name, detail);
}

// 执行命令并读输出：本环境捕获 stdout 会 EPERM，统一重定向到临时文件
function sh(cmd) {
  const tmp = path.join(TMP, `out_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore' });
  } catch (e) { /* 探测类命令常非 0 退出，产物仍可能在文件里 */ }
  const text = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
  try { fs.unlinkSync(tmp); } catch (e) {}
  return text;
}

function probeDuration(file) {
  const out = sh(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${file}"`);
  const v = parseFloat(out.trim());
  return Number.isFinite(v) ? v : null;
}

function probeStreams(file) {
  const out = sh(`"${FFPROBE}" -v error -show_entries stream=codec_type,width,height,duration -of csv=p=0 "${file}"`);
  return out.split(/\r?\n/).filter(Boolean).map(l => {
    const [codecType, width, height, duration] = l.split(',');
    return { codecType, width: Number(width), height: Number(height), duration: parseFloat(duration) };
  });
}

function makeClip(file, { color, dur, size = '1280x720', fps = 30, freq = null }) {
  const input = `-f lavfi -i "color=c=${color}:s=${size}:d=${dur}:r=${fps}"`
    + (freq ? ` -f lavfi -i "sine=frequency=${freq}:duration=${dur}"` : '');
  const maps = freq ? '-map 0:v -map 1:a' : '';
  const audio = freq ? '-c:a aac -ar 44100 -ac 2' : '-an';
  const cmd = `"${FFMPEG}" -y -v error ${input} ${maps} `
    + `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p ${audio} -shortest "${file}"`;
  sh(cmd);
  return file;
}

// 逐帧差异（YAVG）：硬切会在接缝处出现单帧尖峰，交叉淡化则把变化摊到 F 秒
// 注意：metadata=print 的输出走日志（INFO 级），不能用 -v error 静音；
// 也不要用 file= 选项——Windows 绝对路径里的冒号会被 ffmpeg 滤镜参数解析截断。
function frameDiffs(file) {
  const out = sh(`"${FFMPEG}" -hide_banner -nostats -i "${file}" `
    + `-vf "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG" `
    + `-an -f null -`);
  return [...out.matchAll(/YAVG=([0-9.]+)/g)].map(m => Number(m[1]));
}

function volumedetect(file) {
  const out = sh(`"${FFMPEG}" -hide_banner -i "${file}" -af volumedetect -f null -`);
  const mean = out.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  return mean ? mean[1] : null;
}

async function main() {
  console.log('='.repeat(64));
  console.log('片段间转场（交叉淡化）验收');
  console.log('='.repeat(64));
  console.log(`FFmpeg : ${FFMPEG}`);
  console.log(`临时目录: ${TMP}\n`);

  // ---------- 素材 ----------
  const a = makeClip(path.join(TMP, 'a_red_3s.mp4'), { color: 'red', dur: 3, freq: 440 });
  const b = makeClip(path.join(TMP, 'b_blue_3s.mp4'), { color: 'blue', dur: 3, freq: 880 });
  const c = makeClip(path.join(TMP, 'c_green_4s.mp4'), { color: 'green', dur: 4, freq: 660 });
  const d = makeClip(path.join(TMP, 'd_yellow_3s.mp4'), { color: 'yellow', dur: 3, freq: 550 });
  const noAudio = makeClip(path.join(TMP, 'e_gray_3s.mp4'), { color: 'gray', dur: 3 });
  const noAudio2 = makeClip(path.join(TMP, 'f_white_3s.mp4'), { color: 'white', dur: 3 });
  const small = makeClip(path.join(TMP, 'g_small_2s.mp4'), { color: 'purple', dur: 2, size: '854x480', freq: 330 });
  const short = makeClip(path.join(TMP, 'h_short_06s.mp4'), { color: 'orange', dur: 0.6, freq: 300 });
  const short2 = makeClip(path.join(TMP, 'i_short_06s.mp4'), { color: 'cyan', dur: 0.6 });
  const tiny = makeClip(path.join(TMP, 'j_tiny_02s.mp4'), { color: 'black', dur: 0.2 });

  // ---------- [1] 两段：时长 + 解码 + 接缝 ----------
  console.log('[1] 两段 3s + 3s，淡化 0.5s');
  const out1 = path.join(TMP, 'out_2clip.mp4');
  const r1 = await transitionMixer.concatWithTransitions([a, b], out1, { duration: 0.5 });
  assert(r1.success === true, '转场拼接成功', r1.error || '');
  if (r1.success) {
    const dur = probeDuration(out1);
    assert(dur !== null && Math.abs(dur - 5.5) <= 0.25, '时长 = Σd − (N−1)F', `实测 ${dur}s，期望 5.50s`);
    assert(r1.transitions === 1 && r1.fadeDuration === 0.5, '返回结构正确', `transitions=${r1.transitions} F=${r1.fadeDuration}`);
    const streams = probeStreams(out1);
    assert(streams.some(s => s.codecType === 'video'), '含视频流');
    assert(streams.some(s => s.codecType === 'audio'), '含音频流（acrossfade）');
    const v = streams.find(s => s.codecType === 'video');
    assert(v.width === 1280 && v.height === 720, '分辨率 1280x720', `${v.width}x${v.height}`);
  }

  // 硬切对照：同一对片段用原 concatenate
  const hard = path.join(TMP, 'hard_cut.mp4');
  const hardRes = await videoProcessor.concatenate([a, b], hard);
  assert(hardRes.success === true, '硬切对照组生成成功', hardRes.error || '');
  if (hardRes.success && r1.success) {
    const hardDiffs = frameDiffs(hard);
    const trDiffs = frameDiffs(out1);
    const hardMax = hardDiffs.length ? Math.max(...hardDiffs) : 0;
    const trMax = trDiffs.length ? Math.max(...trDiffs) : 0;
    assert(hardMax > 20, '硬切对照组接缝确有尖峰（证明指标有效）', `max YAVG diff=${hardMax.toFixed(2)}`);
    assert(trMax < hardMax * 0.5, '转场后接缝尖峰显著下降（证明真的在融合）',
      `转场 max=${trMax.toFixed(2)} vs 硬切 max=${hardMax.toFixed(2)}（比值 ${(trMax / hardMax).toFixed(2)}）`);
  }

  // ---------- [2] 三段链：offset 累积 ----------
  console.log('\n[2] 三段 3s + 4s + 3s，淡化 0.5s');
  const out2 = path.join(TMP, 'out_3clip.mp4');
  const r2 = await transitionMixer.concatWithTransitions([a, c, d], out2, { duration: 0.5 });
  assert(r2.success === true, '三段转场拼接成功', r2.error || '');
  if (r2.success) {
    const dur = probeDuration(out2);
    assert(dur !== null && Math.abs(dur - 9.0) <= 0.25, '时长 = 10 − 2×0.5', `实测 ${dur}s，期望 9.00s`);
    assert(r2.transitions === 2, '接缝数 = 2', String(r2.transitions));
  }

  // ---------- [3] 混合音轨 ----------
  console.log('\n[3] 混合音轨：有音轨 + 无音轨');
  const out3 = path.join(TMP, 'out_mixed.mp4');
  const r3 = await transitionMixer.concatWithTransitions([a, noAudio], out3, { duration: 0.5 });
  assert(r3.success === true, '混合音轨拼接成功（无音轨段补静音）', r3.error || '');
  if (r3.success) {
    const streams = probeStreams(out3);
    assert(streams.some(s => s.codecType === 'audio'), '产物含音频流');
    const mean = volumedetect(out3);
    assert(mean !== null && Number(mean) > -60, '音频不是全静音（原音轨保留）', `mean_volume=${mean}dB`);
    assert(r3.audioMode === 'mixed-padded', 'audioMode 标记正确', r3.audioMode);
  }

  // ---------- [4] 全无音轨 ----------
  console.log('\n[4] 全无音轨');
  const out4 = path.join(TMP, 'out_noaudio.mp4');
  const r4 = await transitionMixer.concatWithTransitions([noAudio, noAudio2], out4, { duration: 0.5 });
  assert(r4.success === true, '无音轨拼接成功', r4.error || '');
  if (r4.success) {
    const streams = probeStreams(out4);
    assert(!streams.some(s => s.codecType === 'audio'), '产物无音频流（不伪造音轨）');
    const dur = probeDuration(out4);
    assert(dur !== null && Math.abs(dur - 5.5) <= 0.25, '无音轨产物时长正确', `实测 ${dur}s`);
  }

  // ---------- [5] 跨分辨率归一化 ----------
  console.log('\n[5] 跨分辨率：480p + 720p → 720p');
  const out5 = path.join(TMP, 'out_norm.mp4');
  const r5 = await transitionMixer.concatWithTransitions([small, b], out5, { duration: 0.5, resolution: '720p' });
  assert(r5.success === true, '跨分辨率拼接成功', r5.error || '');
  if (r5.success) {
    const streams = probeStreams(out5);
    const v = streams.find(s => s.codecType === 'video');
    assert(v.width === 1280 && v.height === 720, '输出已归一化到 1280x720', `${v.width}x${v.height}`);
    const dur = probeDuration(out5);
    assert(dur !== null && Math.abs(dur - 4.5) <= 0.25, '时长 = 2+3−0.5', `实测 ${dur}s，期望 4.50s`);
    assert(r5.normalized >= 1, '至少归一化 1 段', String(r5.normalized));
  }

  // ---------- [6] 首尾裁剪 ----------
  console.log('\n[6] 首尾裁剪：a[0.5,2.5] + b');
  const out6 = path.join(TMP, 'out_trim.mp4');
  const r6 = await transitionMixer.concatWithTransitions(
    [{ path: a, inSec: 0.5, outSec: 2.5 }, { path: b }],
    out6,
    { duration: 0.5 }
  );
  assert(r6.success === true, '裁剪片段拼接成功', r6.error || '');
  if (r6.success) {
    const dur = probeDuration(out6);
    assert(dur !== null && Math.abs(dur - 4.5) <= 0.25, '时长 = 2+3−0.5', `实测 ${dur}s，期望 4.50s`);
  }

  // ---------- [7] 过短片段：自动收窄 F ----------
  console.log('\n[7] 过短片段：0.6s + 0.6s，请求 F=0.5');
  const out7 = path.join(TMP, 'out_clamp.mp4');
  const r7 = await transitionMixer.concatWithTransitions([short, short2], out7, { duration: 0.5 });
  assert(r7.success === true, '自动收窄淡化时长后成功', r7.error || '');
  if (r7.success) {
    assert(r7.fadeClamped === true && r7.fadeDuration < 0.5, 'F 已收窄', `F=${r7.fadeDuration}，请求 0.5`);
    const dur = probeDuration(out7);
    const expected = 1.2 - r7.fadeDuration;
    assert(dur !== null && Math.abs(dur - expected) <= 0.25, '时长按收窄后的 F 计算', `实测 ${dur}s，期望 ${expected.toFixed(2)}s`);
  }

  // ---------- [8] 负向：短到无法淡化 ----------
  console.log('\n[8] 负向：0.2s 片段无法做 0.1s 以上淡化');
  const out8 = path.join(TMP, 'out_tooshort.mp4');
  const r8 = await transitionMixer.concatWithTransitions([tiny, a], out8, { duration: 0.5 });
  assert(r8.success === false, '过短片段必须 fail（不静默直通）', r8.error || '');
  assert(/过短/.test(String(r8.error || '')), '失败原因写明「过短」', r8.error || '');

  // ---------- [9] 负向：质检不传 expectedDuration ----------
  console.log('\n[9] 负向：拼接质检的 expectedDuration 不能被忽略');
  const out9 = path.join(TMP, 'out_qc.mp4');
  const r9 = await transitionMixer.concatWithTransitions([a, b], out9, { duration: 1.0 });
  assert(r9.success === true, 'F=1.0 的产物生成成功', r9.error || '');
  if (r9.success) {
    const actual = probeDuration(out9);
    const qcWrong = await qualityChecker.checkConcat(out9, 2, [a, b]);
    assert(qcWrong.passed === false, '不传 expectedDuration 时旧口径会误判（差 1.0s > 容差 0.5s）',
      `actual=${actual}s, sum=6s, reason=${qcWrong.reason}`);
    const qcRight = await qualityChecker.checkConcat(out9, 2, [a, b], { expectedDuration: r9.expectedDuration });
    assert(qcRight.passed === true, '传入 expectedDuration 后质检通过',
      `expected=${r9.expectedDuration}s, actual=${actual}s`);
  }

  // ---------- [10] 与循环串联 ----------
  console.log('\n[10] 转场产物再做无缝循环');
  if (r1.success) {
    const looped = path.join(TMP, 'out_loop.mp4');
    const lr = await videoProcessor.makeSeamlessLoop(out1, looped, 0.5);
    assert(lr.success === true, '循环处理成功', lr.error || '');
    if (lr.success) {
      const dur = probeDuration(looped);
      assert(dur !== null && Math.abs(dur - 5.0) <= 0.25, '循环后时长 = 5.5 − 0.5', `实测 ${dur}s`);
      const qc = await qualityChecker.checkLoop(looped, {
        sourcePath: out1,
        sourceDuration: probeDuration(out1),
        fadeDuration: 0.5
      });
      assert(qc.passed === true, '循环质检通过', `wrapSsim=${qc.wrapSsim}, baseSsim=${qc.baseSsim}`);
    }
  }

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项:');
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  console.log(`临时产物: ${TMP}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('验收脚本异常:', e);
  process.exit(1);
});
