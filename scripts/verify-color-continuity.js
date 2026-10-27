#!/usr/bin/env node
// ============================================================
// verify-color-continuity.js —— 镜头级色彩连续性（colorContinuity）验收
// ------------------------------------------------------------
// 覆盖：三档判定（通过/提示/失败）、单片段合法跳过、参数非法、
//       以及最关键的 §4.1 语义：校色「要了没做成」必须进 notRun，不能当通过。
//
// 全部用 ffmpeg 合成素材（lavfi color），不依赖真实成片、不花钱、可重复。
// 本机沙箱禁止 Node 管道捕获子进程，故一律 stdio:'ignore'。
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cfg = require('../config');
const qc = require('../src/qualityChecker');

const FF = cfg.FFMPEG_PATH;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'colorcont-'));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
};

function ff(args) {
  const r = spawnSync(FF, args, { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg 失败: ' + args.join(' ').slice(0, 160));
}

function makeClip(color, out, extraVf) {
  const vf = ['scale=320:180', 'format=yuv420p', extraVf].filter(Boolean).join(',');
  ff(['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=3`,
    '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', out]);
}

function concat2(a, b, out) {
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-i', a, '-i', b,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
}

(async () => {
  console.log('ffmpeg :', FF);
  console.log('tmp    :', TMP);

  // ---------- 0) 静态契约 ----------
  ok(typeof qc.checkColorContinuity === 'function', 'checkColorContinuity 已导出');
  ok(qc.QC_VERSION === 3, 'QC_VERSION 已升到 3', '实际 ' + qc.QC_VERSION);
  const items = (qc.constructor && qc.options && Array.isArray(qc.options.items)) ? qc.options.items : null;
  // QC_ITEMS 未直接导出，改从 config 阈值 + 行为验证；此处只断言阈值来源存在
  ok(cfg.QC && cfg.QC.colorDe76Warn === 15, 'config.QC.colorDe76Warn = 15', String(cfg.QC && cfg.QC.colorDe76Warn));
  ok(cfg.QC && cfg.QC.colorDe76Max === 40, 'config.QC.colorDe76Max = 40', String(cfg.QC && cfg.QC.colorDe76Max));

  // ---------- 1) 素材 ----------
  const base = path.join(TMP, 'base.mp4');
  const same = path.join(TMP, 'same.mp4');
  const mild = path.join(TMP, 'mild.mp4');
  const warnClip = path.join(TMP, 'warn.mp4');
  const strong = path.join(TMP, 'strong.mp4');
  makeClip('0x336699', base);
  makeClip('0x336699', same);
  makeClip('0x336699', mild, 'eq=brightness=0.08:saturation=1.15');
  // 实测 ΔE76 ≈ 22.5，正好落进提示档（15~40），用来验证三档的中间档不是摆设
  makeClip('0x336699', warnClip, 'eq=brightness=0.14:saturation=1.4');
  makeClip('0xC07030', strong, 'eq=saturation=1.4');

  const vSame = path.join(TMP, 'v_same.mp4');
  const vMild = path.join(TMP, 'v_mild.mp4');
  const vWarn = path.join(TMP, 'v_warn.mp4');
  const vStrong = path.join(TMP, 'v_strong.mp4');
  concat2(base, same, vSame);
  concat2(base, mild, vMild);
  concat2(base, warnClip, vWarn);
  concat2(base, strong, vStrong);
  const vSingle = base;

  // ---------- 2) 三档判定 ----------
  const rSame = await qc.checkColorContinuity(vSame, [3, 3]);
  const dSame = rSame.details && rSame.details.seams && rSame.details.seams[0];
  ok(rSame.passed === true, '同色接缝 → 通过');
  ok(dSame && typeof dSame.de76 === 'number' && dSame.de76 < 15, '同色接缝 ΔE76 < 15', dSame && String(dSame.de76));
  ok(rSame.level === 'pass', '同色接缝 level=pass', rSame.level);
  ok(rSame.details && rSame.details.colorMatchState === 'disabled', '默认记录 colorMatchState=disabled');
  ok(String(rSame.reason).includes('未校色'), '结论里写明本次未校色（不静默）');

  const rMild = await qc.checkColorContinuity(vMild, [3, 3]);
  const dMild = rMild.details.seams[0];
  ok(rMild.passed === true, '轻度偏色 → 不判失败（提示档可接受）', 'ΔE76=' + dMild.de76);
  ok(rMild.level === 'pass', '轻度偏色（ΔE76<15）→ level=pass', 'ΔE76=' + dMild.de76 + ' level=' + rMild.level);

  // 提示档（三档的中间档，必须真的能命中，否则那条分支等于没测）
  const rWarn = await qc.checkColorContinuity(vWarn, [3, 3]);
  const dWarn = rWarn.details.seams[0];
  ok(dWarn.de76 > 15 && dWarn.de76 <= 40, '提示档用例 ΔE76 落在 (15,40]', 'ΔE76=' + dWarn.de76);
  ok(rWarn.passed === true, '提示档 → 不判失败（不拉低通过率）', 'ΔE76=' + dWarn.de76);
  ok(rWarn.level === 'warn', '提示档 → level=warn', rWarn.level);
  ok(Array.isArray(dWarn.reasons) && String(dWarn.reasons.join('')).includes('提示阈值'), '提示档给出「超过提示阈值」的原因');
  ok(String(rWarn.reason).includes('不判失败'), '提示档在总结里说明「不判失败」');

  const rStrong = await qc.checkColorContinuity(vStrong, [3, 3]);
  const dStrong = rStrong.details.seams[0];
  ok(rStrong.passed === false, '严重偏色 → 判失败');
  ok(rStrong.level === 'fail', '严重偏色 level=fail', rStrong.level);
  ok(dStrong.de76 > 40, '严重偏色 ΔE76 > 40', String(dStrong.de76));
  ok(String(rStrong.reason).includes('ΔE76'), '失败原因带具体数值');

  // ---------- 3) 跳过 / 非法输入 ----------
  const rOne = await qc.checkColorContinuity(vSingle, [3]);
  ok(rOne.skipped === true && rOne.legitimateSkip === true, '单片段 → 合法跳过');
  const rBad = await qc.checkColorContinuity(vSame, [3, 'x']);
  ok(rBad.passed === false && rBad.undetermined === true, '片段时长非法 → 不可判定（判 fail）');

  // ---------- 4) §4.1：校色「要了没做成」不能当通过 ----------
  const rSkip = await qc.checkColorContinuity(vSame, [3, 3], { colorMatchState: 'skipped', colorMatchReason: '转场关闭' });
  ok(rSkip.passed === false && rSkip.skipped === true && rSkip.legitimateSkip === false,
    'colorMatchState=skipped → notRun（passed=false, skipped=true, legitimateSkip=false）');
  ok(String(rSkip.reason).includes('校色未执行'), 'skipped 的 reason 写明「校色未执行」');

  const rFailed = await qc.checkColorContinuity(vSame, [3, 3], { colorMatchState: 'failed', colorMatchReason: 'lutrgb 报错' });
  ok(rFailed.passed === false && rFailed.skipped === true && rFailed.legitimateSkip === false,
    'colorMatchState=failed → notRun');

  // ---------- 5) checkFinal 集成 ----------
  const baseOpt = { nsfw: { syntheticSource: true }, seam: { legitimateSkip: true, skipReason: 'verify 跳过' } };

  const fDisabled = await qc.checkFinal(vSame, {
    ...baseOpt,
    colorContinuity: { clipDurations: [3, 3], colorMatchState: 'disabled', colorMatchReason: '默认关' }
  });
  ok(fDisabled.details && fDisabled.details.colorContinuity, 'checkFinal 结果里出现 colorContinuity');
  ok(fDisabled.details.colorContinuity.passed === true, 'disabled 且同色 → 本项通过');
  ok(!String(fDisabled.reason).includes('镜头色彩连续性'), '通过时不应把该项写进失败原因');

  // 提示档不许把整体拉成不通过
  const fWarn = await qc.checkFinal(vWarn, {
    ...baseOpt,
    colorContinuity: { clipDurations: [3, 3], colorMatchState: 'disabled', colorMatchReason: '默认关' }
  });
  ok(fWarn.details.colorContinuity.level === 'warn', 'checkFinal 里提示档 level=warn', String(fWarn.details.colorContinuity.level));
  ok(fWarn.details.colorContinuity.passed === true, 'checkFinal 里提示档不判失败');

  const fSkipped = await qc.checkFinal(vSame, {
    ...baseOpt,
    colorContinuity: { clipDurations: [3, 3], colorMatchState: 'skipped', colorMatchReason: '转场关闭' }
  });
  ok(fSkipped.passed === false, '校色 skipped → 整体不通过');
  ok(String(fSkipped.reason).includes('校色未执行'), '整体原因里能看到「校色未执行」', fSkipped.reason.slice(0, 80));

  const fMissing = await qc.checkFinal(vSame, { ...baseOpt });
  ok(fMissing.details.colorContinuity.passed === false, '未提供 clipDurations → 判未执行（fail）');
  ok(String(fMissing.details.colorContinuity.reason).includes('未执行'), '未执行原因可读');

  console.log('\n' + (fail ? `FAIL ${fail}` : '全部通过') + `（${pass} 通过 / ${fail} 失败）`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
