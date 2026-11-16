// ============================================================
// 逐图自适应调色验收（2026-11-12）
//
// 验证：
//   A. 高饱和图被压到目标区间附近（不是全片一套固定参数）
//   B. 低饱和图不被反向调艳（gain=1）
//   C. 高光死白比例下降
//   D. 产物可被 ffprobe 正常读取
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const videoProcessor = require('../src/videoProcessor');
const autoGrade = require('../src/processors/autoGrade');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}

function extractFrame(clip, out) {
  const cmd = `"${config.FFMPEG_PATH}" -y -v error -ss 1 -i "${clip}" -frames:v 1 "${out}"`;
  const r = videoProcessor._runFFmpeg(cmd);
  if (!r.success) throw new Error('抽帧失败: ' + r.error);
  return out;
}

(async () => {
  console.log('================================================================');
  console.log('逐图自适应调色验收');
  console.log('================================================================');

  const clipHigh = path.join(__dirname, '..', 'clips', 'task_mv4v7qp2_m8r0_clip_1.mp4');
  const clipLow = path.join(__dirname, '..', 'clips', 'task_mvgw4hbo_ajuc_clip_2.mp4');
  if (!fs.existsSync(clipHigh) || !fs.existsSync(clipLow)) {
    console.log('  ⚠ 缺少样本片段，跳过');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autograde-'));
  try {
    const highFrame = extractFrame(clipHigh, path.join(dir, 'high.png'));
    const lowFrame = extractFrame(clipLow, path.join(dir, 'low.png'));

    const highOut = path.join(dir, 'high_grade.png');
    const high = await autoGrade.autoGradeImage(highFrame, highOut, { palette: 'cold' });
    console.log('  高饱和 before:', JSON.stringify(high.before), 'after:', JSON.stringify(high.after),
      'gain=' + high.params.gain, 'target=' + high.targetSaturation);
    ok(fs.existsSync(highOut), 'A1. 高饱和图产出调色文件');
    ok(high.before.sat > high.targetSaturation, 'A2. 输入确实高于目标', `before=${high.before.sat}`);
    ok(high.after.sat < high.before.sat, 'A3. 输出饱和度下降', `${high.before.sat} -> ${high.after.sat}`);
    // 单张图的 eq 响应非线性；限幅 min gain=0.3 时可能停在目标上方 ~1.5×。
    // 验收看「显著下降且不越过自然上限」，不追求绝对等于目标值。
    ok(high.after.sat <= high.targetSaturation * 1.5
      && high.after.sat <= high.before.sat * 0.7,
      'A4. 输出显著下降且不越过自然上限', `after=${high.after.sat} target=${high.targetSaturation}`);
    ok(high.after.high <= high.before.high, 'C. 高光死白比例未上升',
      `${high.before.high}% -> ${high.after.high}%`);
    const probe = videoProcessor.probeDetail(highOut);
    ok(probe.success && probe.width > 0, 'D. 调色产物可读取', `${probe.width}x${probe.height}`);

    const lowOut = path.join(dir, 'low_grade.png');
    const low = await autoGrade.autoGradeImage(lowFrame, lowOut, { palette: 'calm' });
    console.log('  低饱和 before:', JSON.stringify(low.before), 'after:', JSON.stringify(low.after),
      'gain=' + low.params.gain);
    ok(low.params.gain === 1, 'B1. 低饱和图不反向调艳（gain=1）', `gain=${low.params.gain}`);
    ok(low.after.sat >= low.before.sat * 0.85, 'B2. 低饱和图饱和未被大幅压掉',
      `${low.before.sat} -> ${low.after.sat}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本异常:', e && e.message);
  process.exit(1);
});
