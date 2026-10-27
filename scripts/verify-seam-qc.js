#!/usr/bin/env node
// ==========================================
// 接缝质检验收 —— scripts/verify-seam-qc.js
// ==========================================
//
// 覆盖 docs/spec/seam-quality-spec.md §8 的用例清单。
// 设计原则（沿用本项目既有验收脚本风格）：
//   - 每条用例打印 PASS/FAIL，末尾汇总；退出码 0 = 全过
//   - **必须含负向用例**：故意造一道坏缝，证明 checkSeam 能判 fail（§5.1 第 3 条）
//   - 不跑 verify-all（本机 spawn EPERM），本脚本可独立运行
//   - 只读 app/output/ 的成片；所有临时产物写系统临时目录，**不写入 output/**
//
// 用法：
//   node scripts/verify-seam-qc.js            # 全部
//   node scripts/verify-seam-qc.js --fast     # 跳过真视频用例（只跑合成+静态断言）
// ==========================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const config = require(path.join(APP_ROOT, 'config'));
const qualityChecker = require(path.join(APP_ROOT, 'src', 'qualityChecker'));
const pipeline = require(path.join(APP_ROOT, 'src', 'pipeline'));

const FFMPEG = config.FFMPEG_PATH;
const FAST = process.argv.includes('--fast');

let pass = 0, fail = 0, skipped = 0;
const failures = [];

function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); }
}
function skip(label, why) {
  skipped++;
  console.log(`  ⏭️  ${label} —— 跳过：${why}`);
}
function section(t) { console.log(`\n${t}`); }

// 不捕获 stdout（EPERM），重定向到文件再读
function sh(cmd, cwd) {
  const tmp = path.join(os.tmpdir(), `vseam_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  let code = 0;
  try {
    execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore', cwd: cwd || APP_ROOT, timeout: 5 * 60 * 1000 });
  } catch (e) {
    code = 1;
  }
  let out = '';
  try { out = fs.readFileSync(tmp, 'utf8'); } catch (e) {}
  try { fs.unlinkSync(tmp); } catch (e) {}
  return { code, out };
}

const q = (p) => `"${p}"`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vseam_'));

// 造两段「画面内容明显不同」但都带纹理的片段：
// testsrc 提供结构（避免纯色让 SSIM 退化成 1），hue 提供明显色差。
function makeClip(name, hue, dur = 3) {
  const out = path.join(TMP, name);
  sh(`${q(FFMPEG)} -hide_banner -loglevel error -y `
    + `-f lavfi -i "testsrc=size=320x180:rate=30:duration=${dur}" `
    + `-vf "hue=h=${hue}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an ${q(out)}`);
  return out;
}

function concatCopy(files, outName) {
  const list = path.join(TMP, `list_${Date.now()}.txt`);
  fs.writeFileSync(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const out = path.join(TMP, outName);
  sh(`${q(FFMPEG)} -hide_banner -loglevel error -y -f concat -safe 0 -i ${q(list)} -c copy ${q(out)}`);
  return out;
}

(async () => {
  console.log('=== 接缝质检验收（checkSeam）===');
  console.log(`FFmpeg: ${FFMPEG}`);

  // ---------------------------------------------------------
  section('[1] 静态断言：检测项已登记 / 语义红线');
  // ---------------------------------------------------------
  const items = qualityChecker.getQCItems();
  ok(items.some(i => i.key === 'seam'), 'QC_ITEMS 里登记了 seam 项');
  ok(items.find(i => i.key === 'seam').category === 'post', 'seam 归类为 post（拼接后置质检）');
  ok(typeof qualityChecker.checkSeam === 'function', 'checkSeam 方法存在');

  const qcSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'qualityChecker.js'), 'utf8');
  const seamBlock = (() => {
    const i = qcSrc.indexOf('async checkSeam(');
    if (i < 0) return '';
    const j = qcSrc.indexOf('// 单帧的平均 Y/U/V', i);
    return qcSrc.slice(i, j > i ? j : i + 12000);
  })();
  ok(seamBlock.length > 500, '取到 checkSeam 实现片段用于静态检查', `${seamBlock.length} 字符`);
  ok(!/Math\.random\(/.test(seamBlock), 'checkSeam 内无 Math.random（§4.2 禁止随机数冒充结论）');
  // §4.1 的核心不是「不许出现 skipped」，而是「skipped 必须同时有 legitimateSkip」。
  // 所以按「出现次数 + 与 legitimateSkip 同块」检查，而不是简单禁止 skipped 字样。
  const skippedHits = [...seamBlock.matchAll(/skipped:\s*true/g)];
  ok(skippedHits.length === 1, 'checkSeam 只有一处 skipped:true（单片段分支）', `${skippedHits.length} 处`);
  const skipIdx = skippedHits.length ? skippedHits[0].index : -1;
  const skipWindow = skipIdx >= 0 ? seamBlock.slice(skipIdx, skipIdx + 400) : '';
  ok(skipIdx >= 0 && /legitimateSkip:\s*true/.test(skipWindow),
    '该 skipped 与 legitimateSkip:true 同时返回（§4.1 唯一合法跳过）');
  ok(/legitimateSkip/.test(seamBlock), '唯一的跳过路径带 legitimateSkip 标记');
  ok(!/OUTPUT_DIR|output\//.test(seamBlock), 'checkSeam 不写 output/（§4.7）');

  // ---------------------------------------------------------
  section('[2] 配置与档位策略');
  // ---------------------------------------------------------
  ok(config.TRANSITIONS && config.TRANSITIONS.enabled === true, 'TRANSITION_ENABLED 默认已改为 true');
  ok(Math.abs(Number(config.TRANSITIONS.duration) - 0.4) < 1e-9, 'TRANSITION_DURATION 默认 0.4s');
  const tQuick = pipeline._transitionOptions({ preset: 'quick' });
  ok(tQuick.enabled === false, 'quick 档强制关闭转场（仍是 -c copy）', JSON.stringify(tQuick));
  ok(tQuick.disabledByPreset === 'quick', 'quick 关闭原因可追溯（disabledByPreset）');
  const tFinal = pipeline._transitionOptions({ preset: 'final' });
  ok(tFinal.enabled === true, 'final 档默认开启转场');
  const tOff = pipeline._transitionOptions({ preset: 'final', transition: { enabled: false } });
  ok(tOff.enabled === false, '任务级 transition.enabled=false 仍可显式关闭（可回归）');
  const tTaskOff = pipeline._transitionOptions({ preset: 'quick', transition: { enabled: true } });
  ok(tTaskOff.enabled === false, 'quick 档即使显式传 true 也不开转场（策略优先）');

  const pipeSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'pipeline.js'), 'utf8');
  ok(/expectedDuration:\s*concatResult\.expectedDuration/.test(pipeSrc),
    'checkConcat 收到了 expectedDuration（否则转场产物会被误判成「拼接被截断」）');
  ok(/_seamQcOptions\s*\(/.test(pipeSrc) && /seam:\s*this\._seamQcOptions\(task\)/.test(pipeSrc),
    '终检 options 里带上了 seam 输入（三处 checkFinal 共用 _finalQcOptions）');

  // ---------------------------------------------------------
  section('[3] 负向用例：故意造一道坏缝（硬切）必须判 fail');
  // ---------------------------------------------------------
  const clipA = makeClip('clipA.mp4', 0);      // testsrc 原色
  const clipB = makeClip('clipB.mp4', 120);    // 色相旋转 120°，颜色/亮度都与 A 明显不同
  ok(fs.existsSync(clipA) && fs.existsSync(clipB), '合成两段内容差异明显的片段');

  const hardcut = concatCopy([clipA, clipB], 'hardcut.mp4');
  ok(fs.existsSync(hardcut) && fs.statSync(hardcut).size > 1000, '硬切样本已生成（-c copy 直拼）');

  const rHard = await qualityChecker.checkSeam(hardcut, [3, 3], {});
  ok(rHard.passed === false, '硬切缝被判 **不通过**（负向核心用例）', `passed=${rHard.passed}`);
  ok(rHard.level === 'fail', '硬切缝 level=fail');
  ok(Array.isArray(rHard.details && rHard.details.seams) && rHard.details.seams.length === 1,
    '逐缝明细存在且数量正确（2 段 → 1 道缝）');
  const s0 = rHard.details.seams[0];
  ok(Number.isFinite(s0.ssim) && s0.ssim < 0.75, '硬切缝 SSIM 低于阈值', `ssim=${s0.ssim}`);
  ok(Number.isFinite(s0.de76), '硬切缝给出了 ΔE76 数值', `ΔE76=${s0.de76}`);
  ok(Number.isFinite(s0.dy), '硬切缝给出了 ΔY 数值', `ΔY=${s0.dy}`);
  ok(Number.isFinite(s0.madRatio), '硬切缝给出了 MAD 倍数', `×${s0.madRatio}`);
  ok(Array.isArray(s0.reasons) && s0.reasons.length > 0, '不通过时给出可读原因列表', (s0.reasons || []).join(' / '));
  ok(/接缝质量不通过/.test(String(rHard.reason)), '汇总理由写明不通过');

  // ---------------------------------------------------------
  section('[4] 正向用例：真转场（xfade）必须判 pass');
  // ---------------------------------------------------------
  const transitionMixer = require(path.join(APP_ROOT, 'src', 'processors', 'transitionMixer'));
  const xfadeOut = path.join(TMP, 'xfade.mp4');
  let xfadeRes = null;
  try {
    xfadeRes = await transitionMixer.concatWithTransitions([clipA, clipB], xfadeOut, {
      duration: 0.4, fadeDuration: 0.4, type: 'fade'
    });
  } catch (e) {
    xfadeRes = { success: false, error: e.message };
  }
  if (xfadeRes && xfadeRes.success) {
    const rFade = await qualityChecker.checkSeam(xfadeOut, [3, 3], { fadeDuration: 0.4 });
    const anySeam = rFade.details && rFade.details.seams ? rFade.details.seams[0] : null;
    ok(anySeam && anySeam.ssim > s0.ssim, '转场后接缝 SSIM 明显高于硬切',
      `xfade=${anySeam && anySeam.ssim} vs hardcut=${s0.ssim}`);
    ok(rFade.passed === true, '真转场接缝判 **通过**（不误判）', rFade.reason);
  } else {
    // 不能算通过：造样本失败说明用例没测到
    ok(false, '真转场样本生成失败（用例不可判定，按失败计）', (xfadeRes && xfadeRes.error) || 'unknown');
  }

  // ---------------------------------------------------------
  section('[5] 三态语义：跳过 / 不可判定');
  // ---------------------------------------------------------
  const rSingle = await qualityChecker.checkSeam(hardcut, [6], {});
  ok(rSingle.passed === true && rSingle.skipped === true && rSingle.legitimateSkip === true,
    '单片段 → legitimateSkip（唯一合法跳过）', rSingle.reason);
  ok(/仅 1 个片段/.test(String(rSingle.reason)), '单片段跳过理由写明原因');

  const rNoDur = await qualityChecker.checkSeam(hardcut, [], {});
  ok(rNoDur.passed === false && rNoDur.undetermined === true,
    '缺片段时长 → 不通过 + undetermined（测不到不许当通过）', rNoDur.reason);

  const rNullDur = await qualityChecker.checkSeam(hardcut, [null, null], {});
  ok(rNullDur.passed === false, '片段时长全为 null → 不通过');

  const rMissing = await qualityChecker.checkSeam(path.join(TMP, 'no_such_file.mp4'), [3, 3], {});
  ok(rMissing.passed === false, '视频不存在 → 不通过（不抛错、不放行）', rMissing.reason);

  // ---------------------------------------------------------
  section('[6] 阈值可配 + 抽样');
  // ---------------------------------------------------------
  const rStrict = await qualityChecker.checkSeam(xfadeOut, [3, 3], { fadeDuration: 0.4, ssimMin: 0.9999 });
  ok(rStrict.passed === false, '把 SSIM 阈值调到 0.9999 → 原本通过的样本转不通过（阈值真的生效）');

  // 3 段 → 2 道缝；把 maxSeams 设成 1 应触发抽样
  const clipC = makeClip('clipC.mp4', 240);
  const three = concatCopy([clipA, clipB, clipC], 'three.mp4');
  const rSampled = await qualityChecker.checkSeam(three, [3, 3, 3], { maxSeams: 1 });
  ok(rSampled.details && rSampled.details.summary.totalSeamsInVideo === 2,
    '3 段视频算出 2 道缝', JSON.stringify(rSampled.details.summary));
  ok(rSampled.details.summary.sampled === true && rSampled.details.seams.length === 1,
    'maxSeams=1 时触发抽样，且只测 1 道（抽样状态如实标注）');

  // ---------------------------------------------------------
  section('[7] 真实成片（只读 output/；--fast 跳过）');
  // ---------------------------------------------------------
  const realHard = path.join(APP_ROOT, 'output', 'task_mvglaff4_y3lw_concat.mp4');
  const realFade = path.join(APP_ROOT, 'output', 'task_mvhlxnm7_1mch_concat.mp4');
  if (FAST) {
    skip('真实硬切成片判 fail', '--fast');
    skip('真实转场成片判 pass', '--fast');
  } else if (!fs.existsSync(realHard) || !fs.existsSync(realFade)) {
    skip('真实成片用例', 'output/ 下没有对应成片（可能是新环境）');
  } else {
    const beforeMtime = fs.statSync(realHard).mtimeMs;
    const rRealHard = await qualityChecker.checkSeam(realHard, [7, 7], {});
    ok(rRealHard.passed === false, '真实硬切成片（task_mvglaff4_y3lw）判不通过', rRealHard.reason);
    const afterMtime = fs.statSync(realHard).mtimeMs;
    ok(beforeMtime === afterMtime, '检测过程未修改源成片（§4.7 只读）');

    const rRealFade = await qualityChecker.checkSeam(realFade, [7, 7, 7, 7, 7, 5.063, 5.063], { fadeDuration: 0.4 });
    ok(rRealFade.passed === true, '真实转场成片（task_mvhlxnm7_1mch）判通过', rRealFade.reason);
    ok(rRealFade.details.summary.scanned === 6, '真实转场成片测了 6 道缝');
  }

  // ---------------------------------------------------------
  section('[8] 转场「可关闭」的端到端证明：任务级 transition:false 必须真走 -c copy');
  // ---------------------------------------------------------
  // 为什么单独测这条：用户可以在页面上取消勾选。取消后必须回到 -c copy 直拼
  // （不重编码、不缩短时长），否则「默认开启」就等于「强制开启」，推翻用户的取消操作。
  // 判据用**时长语义**而不是耗时：copy 直拼成片时长 = Σ片段；做了 xfade 则 = Σ片段 −(N−1)×fade。
  const taskManager = require(path.join(APP_ROOT, 'src', 'taskManager'));
  const { cleanupTask } = require(path.join(APP_ROOT, 'scripts', '_test-cleanup'));

  async function runMiniTask(extra, label) {
    const task = taskManager.createTask('接缝验收-转场开关', {
      model: 'mock', totalClips: 2, clipDuration: 3, resolution: '720p', failRate: 0,
      preset: 'custom',
      stages: ['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation'],
      ...extra
    });
    pipeline.startTask(task.taskId);
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      const t = taskManager.getTask(task.taskId);
      if (t && ['completed', 'partial', 'failed'].includes(t.status)) {
        console.log(`  ${label}: 终态 ${t.status}`);
        return t;
      }
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error(`${label} 超时未完成`);
  }

  if (FAST) {
    skip('转场可关闭端到端（copy vs xfade 时长语义）', '--fast');
  } else {
    let offTask = null, onTask = null;
    try {
      offTask = await runMiniTask({ transition: { enabled: false } }, 'transition:false');
      onTask = await runMiniTask({ transition: { enabled: true, duration: 0.4 } }, 'transition:true');

      // 关掉 → 拼接步骤不应有转场留痕（说明走的是 concatenate 而非 transitionMixer）
      const offConc = offTask.steps && offTask.steps.concatenation;
      const offTr = offConc && offConc.qcDetails && offConc.qcDetails.transition;
      ok(!offTr, 'transition:false → 拼接步骤无转场留痕（走 -c copy 直拼）', JSON.stringify(offTr || null));

      // 打开 → 必须真的有转场留痕
      const onConc = onTask.steps && onTask.steps.concatenation;
      const onTr = onConc && onConc.qcDetails && onConc.qcDetails.transition;
      ok(!!onTr && Number(onTr.transitions) > 0, 'transition:true → 拼接步骤记录了实际转场', JSON.stringify(onTr || null));

      // 时长语义：copy = Σ(2×3)=6s；xfade = 6 − 1×0.4 = 5.6s
      const offPath = path.join(APP_ROOT, 'output', `${offTask.taskId}_concat.mp4`);
      const onPath = path.join(APP_ROOT, 'output', `${onTask.taskId}_concat.mp4`);
      const durOf = (p) => {
        const r = sh(`"${config.FFPROBE_PATH}" -v error -show_entries format=duration -of csv=p=0 ${q(p)}`);
        const v = parseFloat(String(r.out).trim());
        return Number.isFinite(v) ? v : null;
      };
      const offDur = fs.existsSync(offPath) ? durOf(offPath) : null;
      const onDur = fs.existsSync(onPath) ? durOf(onPath) : null;
      ok(offDur !== null && Math.abs(offDur - 6) <= 0.3,
        '取消勾选后成片时长 = Σ片段（证明没做淡化、没重编码时长）', `实测 ${offDur}s，期望 6.0s`);
      ok(onDur !== null && Math.abs(onDur - 5.6) <= 0.3,
        '勾选后成片时长 = Σ片段 − 1×0.4（证明真做了淡化）', `实测 ${onDur}s，期望 5.6s`);
      ok(offDur !== null && onDur !== null && offDur > onDur,
        '关闭组比开启组更长（可关闭 = 真的回到直拼语义）', `off=${offDur}s vs on=${onDur}s`);
    } catch (e) {
      ok(false, '转场可关闭端到端用例执行失败（按失败计，不算通过）', e.message);
    } finally {
      for (const t of [offTask, onTask]) {
        if (t && t.taskId) { try { await cleanupTask(t.taskId, taskManager); } catch (e) {} }
      }
    }
  }

  // ---------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + '='.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail} / 跳过 ${skipped}`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
  }
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('验收脚本异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
