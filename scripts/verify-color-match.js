#!/usr/bin/env node
// ============================================================
// verify-color-match.js —— 批次 2「拼接时自动校色」验收
// ------------------------------------------------------------
// 覆盖：
//  1) 默认关 → transitionMixer 返回 state='disabled'，产物与不校色一致
//  2) 开启 → state='applied'，每段都有 LUT，接缝镜头级 ΔE76 明显下降
//  3) 限幅：maxGain=0.01 时增益必须落在 [0.99,1.01]
//  4) 不额外编码：开/关产物时长一致，耗时比记录并设上限
//  5) 接线：4 处 concatWithTransitions 都传了 colorMatch
//  6) 终检取留痕：applied / 请求了但无留痕(skipped) / 默认(disabled) 三种
//  7) taskManager：校色请求 + 转场关闭 → 写 note，不抛错
//
// 全部用 ffmpeg 合成素材，不依赖真实成片。沙箱禁止管道捕获 → stdio ignore。
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cfg = require('../config');
const qc = require('../src/qualityChecker');
const mixer = require('../src/processors/transitionMixer');
const pipeline = require('../src/pipeline');
const taskManager = require('../src/taskManager');

const FF = cfg.FFMPEG_PATH;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'colormatch-'));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
};

function ff(args) {
  const r = spawnSync(FF, args, { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg 失败: ' + args.slice(0, 12).join(' '));
}

function makeClip(color, out, vf) {
  const f = ['scale=320:180', 'format=yuv420p', vf].filter(Boolean).join(',');
  ff(['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=3`,
    '-vf', f, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', out]);
}

// 有空间方差的素材：纯色片的 sd≈0，增益恒等于 1，触发不了限幅分支
function makeVarClip(out, vf) {
  const f = ['format=yuv420p', vf].filter(Boolean).join(',');
  ff(['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3',
    '-vf', f, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', out]);
}

(async () => {
  console.log('ffmpeg :', FF);
  console.log('tmp    :', TMP);

  // ---------- 素材：蓝 / 橙 / 绿（刻意差异大，方便看校色效果） ----------
  const a = path.join(TMP, 'a.mp4');
  const b = path.join(TMP, 'b.mp4');
  const c = path.join(TMP, 'c.mp4');
  makeClip('0x336699', a);
  makeClip('0xC07030', b);
  makeClip('0x2E8B57', c);
  const clips = [a, b, c];
  const clipDurs = [3, 3, 3];
  const FADE = 0.4;

  const outOff = path.join(TMP, 'out_off.mp4');
  const outOn = path.join(TMP, 'out_on.mp4');

  // ---------- 1) 默认关 ----------
  const t0 = Date.now();
  const rOff = await mixer.concatWithTransitions(clips, outOff, { duration: FADE, type: 'fade', fps: 30 });
  const msOff = Date.now() - t0;
  ok(rOff.success === true, '不校色拼接成功', rOff.error || '');
  ok(rOff.colorMatch && rOff.colorMatch.state === 'disabled', '默认 → colorMatch.state=disabled', rOff.colorMatch && rOff.colorMatch.state);
  ok(Array.isArray(rOff.colorMatch.luts) && rOff.colorMatch.luts.length === 0, '默认不生成 LUT');

  // ---------- 2) 开启校色 ----------
  const t1 = Date.now();
  const rOn = await mixer.concatWithTransitions(clips, outOn, {
    duration: FADE, type: 'fade', fps: 30, colorMatch: { enabled: true, maxGain: 0.35 }
  });
  const msOn = Date.now() - t1;
  ok(rOn.success === true, '校色拼接成功', rOn.error || '');
  ok(rOn.colorMatch && rOn.colorMatch.state === 'applied', '开启 → state=applied', rOn.colorMatch && rOn.colorMatch.state);
  ok(Array.isArray(rOn.colorMatch.luts) && rOn.colorMatch.luts.length === clips.length - 1,
    '为「除首段外」每段生成 LUT', rOn.colorMatch.luts && rOn.colorMatch.luts.length);
  ok(rOn.colorMatch.reference === 'first', '参考段固定首段（不链式，防漂移）', rOn.colorMatch.reference);

  // 时长：校色不应改变结构
  ok(Math.abs(rOn.actualDuration - rOff.actualDuration) < 0.05,
    '开/关产物时长一致（不改变结构）', `${rOff.actualDuration}s vs ${rOn.actualDuration}s`);

  // ---------- 3) 效果：镜头级 ΔE76 必须明显下降 ----------
  const seamOff = await qc.checkColorContinuity(outOff, clipDurs, { fadeDuration: FADE, colorMatchState: 'disabled' });
  const seamOn = await qc.checkColorContinuity(outOn, clipDurs, { fadeDuration: FADE, colorMatchState: 'applied' });
  const deOff = seamOff.details.seams.map(s => s.de76);
  const deOn = seamOn.details.seams.map(s => s.de76);
  const maxOff = Math.max(...deOff);
  const maxOn = Math.max(...deOn);
  ok(maxOff > 15, '基线：不校色时镜头级 ΔE76 明显偏大', `max=${maxOff}`);
  ok(maxOn < maxOff * 0.5, '校色后最差 ΔE76 至少降一半', `${maxOff} → ${maxOn}`);
  ok(seamOn.passed === true, '校色后镜头色彩连续性通过', seamOn.reason.slice(0, 60));

  // ---------- 4) 限幅（需要空间方差，纯色片 sd≈0 触发不了） ----------
  const va = path.join(TMP, 'va.mp4');
  const vb = path.join(TMP, 'vb.mp4');
  makeVarClip(va);
  makeVarClip(vb, 'gblur=sigma=8');   // 方差显著变小 → sd 比 > 1 → 必须被限幅
  const outClamp = path.join(TMP, 'out_clamp.mp4');
  const rClamp = await mixer.concatWithTransitions([va, vb], outClamp, {
    duration: FADE, type: 'fade', fps: 30, colorMatch: { enabled: true, maxGain: 0.01 }
  });
  const gains = rClamp.colorMatch.luts[0].gain;
  ok(rClamp.colorMatch.state === 'applied', '限幅用例执行成功', rClamp.error || '');
  ok(gains.every(g => g >= 0.99 - 1e-6 && g <= 1.01 + 1e-6), '单通道增益被限幅在 ±1%', JSON.stringify(gains));
  ok(rClamp.colorMatch.luts[0].clamped.some(Boolean) === true, '发生限幅时被如实标记 clamped', JSON.stringify(rClamp.colorMatch.luts[0].clamped));

  // ---------- 5) 成本：不额外编码，只多采样 ----------
  // 用较长片段测才公平：3s 小片段上进程启动开销会盖过编码本身。
  const longA = path.join(TMP, 'la.mp4');
  const longB = path.join(TMP, 'lb.mp4');
  for (const [src, out, vf] of [['testsrc2', longA, ''], ['testsrc2', longB, 'hue=h=40']]) {
    const f = ['format=yuv420p', vf].filter(Boolean).join(',');
    ff(['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `${src}=s=640x360:r=30:d=8`,
      '-vf', f, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  }
  const tLongOff = Date.now();
  const rLongOff = await mixer.concatWithTransitions([longA, longB], path.join(TMP, 'long_off.mp4'),
    { duration: FADE, type: 'fade', fps: 30 });
  const msLongOff = Date.now() - tLongOff;
  const tLongOn = Date.now();
  const rLongOn = await mixer.concatWithTransitions([longA, longB], path.join(TMP, 'long_on.mp4'),
    { duration: FADE, type: 'fade', fps: 30, colorMatch: { enabled: true, maxGain: 0.35 } });
  const msLongOn = Date.now() - tLongOn;
  ok(rLongOff.success && rLongOn.success, '长片段两态都拼接成功');
  const longRatio = msLongOff > 0 ? msLongOn / msLongOff : 0;
  console.log(`         （3s×3 片段：${msOff}ms → ${msOn}ms；8s×2 长片段：${msLongOff}ms → ${msLongOn}ms，比 ${longRatio.toFixed(2)}×）`);
  ok(longRatio < 1.5, '长片段校色耗时比 < 1.5×（复用同一次重编码，仅多采样）', longRatio.toFixed(2) + '×');

  // ---------- 6) 接线：4 处调用都传 colorMatch ----------
  const pipeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');
  const wired = (pipeSrc.match(/colorMatch:\s*this\._colorMatchOptions\(task\)/g) || []).length;
  ok(wired === 4, '4 处 concatWithTransitions 都传了 colorMatch', wired + ' 处');

  // ---------- 7) 终检取留痕 ----------
  const mkTask = (over) => ({
    taskId: 'verify_cm', model: 'dashscope', preset: 'final',
    clips: [
      { status: 'success', index: 0, duration: 3 },
      { status: 'success', index: 1, duration: 3 }
    ],
    transition: { enabled: true },
    ...over
  });

  const tApplied = pipeline._colorContinuityQcOptions(mkTask({
    colorMatch: { enabled: true },
    steps: { concatenation: { qcDetails: { colorMatch: { state: 'applied', reason: '已按首段校色' } } } }
  }));
  ok(tApplied.colorMatchState === 'applied', '留痕 applied → 终检取 applied', tApplied.colorMatchState);

  const tNoRecord = pipeline._colorContinuityQcOptions(mkTask({ colorMatch: { enabled: true } }));
  ok(tNoRecord.colorMatchState === 'skipped', '请求了但无留痕 → skipped（未执行≠通过）', tNoRecord.colorMatchState);
  ok(String(tNoRecord.colorMatchReason).includes('未执行'), 'skipped 原因可读', tNoRecord.colorMatchReason);

  const tDefault = pipeline._colorContinuityQcOptions(mkTask({}));
  ok(tDefault.colorMatchState === 'disabled', '没请求 → disabled（合法跳过）', tDefault.colorMatchState);

  const tFailed = pipeline._colorContinuityQcOptions(mkTask({
    colorMatch: { enabled: true },
    steps: { concatenation: { qcDetails: { colorMatch: { state: 'failed', reason: '抽帧失败' } } } }
  }));
  ok(tFailed.colorMatchState === 'failed', '留痕 failed → 终检取 failed', tFailed.colorMatchState);

  // ---------- 8) taskManager：冲突组合不静默 ----------
  let created = null;
  try {
    created = taskManager.createTask('verify-color-match 临时任务', {
      model: 'mock', totalClips: 1, clipDuration: 3,
      transition: { enabled: false },
      colorMatch: { enabled: true }
    });
    const notes = (created.stagePlan && created.stagePlan.notes) || [];
    ok(notes.some(n => String(n).includes('校色已请求')), '校色请求 + 转场关闭 → 写 note，不抛错', notes.join(' / ').slice(0, 60));
    ok(created.colorMatch && created.colorMatch.enabled === true, '任务上保留了 colorMatch 请求（不静默改成没要求）');
  } finally {
    // 清理临时任务，避免污染列表
    try {
      if (created && taskManager.tasks && typeof taskManager.tasks.delete === 'function') {
        taskManager.tasks.delete(created.taskId);
      }
    } catch { /* ignore */ }
  }

  console.log('\n' + (fail ? `FAIL ${fail}` : '全部通过') + `（${pass} 通过 / ${fail} 失败）`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
