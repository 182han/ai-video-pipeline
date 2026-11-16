// ==========================================
// 逐图自适应调色（2026-11-12 用户口径）
// ------------------------------------------------------------
// 不是「全片一套参数」，也不是「每张图自由发挥」：
//   · 每张图先量自己的饱和度/亮度/高光死白；
//   · 按题材预设的目标区间算修正量；
//   · 修正量限幅，最多重渲染 2 次逼近目标；
//   · 参数随图片记录，可复现。
//
// 目标区间来自 fengguang 的实测色板（80 静帧 + 2210 帧长片）：
//   极冷极淡 0.22–0.26 / 暖浓 0.36–0.40 / 暗底暖星云 0.28–0.31 / 长片耐看 0.24–0.34
// 这里取区间中值作为 targetSaturation。
// ==========================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../config');
const videoProcessor = require('../videoProcessor');

const PALETTES = {
  cold: { targetSat: 0.30, label: '极冷极淡', colorbalance: 'bs=0.012:rs=-0.008' },
  warm: { targetSat: 0.38, label: '暖浓', colorbalance: 'rm=0.012' },
  night: { targetSat: 0.30, label: '暗底暖星云', colorbalance: '' },
  calm: { targetSat: 0.32, label: '长片耐看', colorbalance: 'bs=0.006:rs=-0.004' }
};

function tmpPath(prefix) {
  // 某些会话里 ffmpeg 子进程对系统 TEMP 没有写权限（Permission denied）；
  // 优先用项目 output 目录，保证子进程与父进程同一可写区。
  const root = process.env.AUTOGRADE_TMPDIR || config.STORAGE.outputDir || os.tmpdir();
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
  return path.join(root, `autograde_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${prefix}`);
}

function decodeRaw(imagePath, width, height) {
  const raw = tmpPath('raw.rgb');
  const cmd = `"${config.FFMPEG_PATH}" -y -v error -i "${imagePath}" -frames:v 1 -f rawvideo -pix_fmt rgb24 "${raw}"`;
  const run = videoProcessor._runFFmpeg(cmd);
  try {
    if (!run.success) throw new Error(run.error || 'ffmpeg 解码失败');
    const buf = fs.readFileSync(raw);
    if (buf.length < width * height * 3) {
      throw new Error(`raw 字节不足: ${buf.length} < ${width * height * 3}`);
    }
    return buf;
  } finally {
    try { if (fs.existsSync(raw)) fs.unlinkSync(raw); } catch (e) {}
  }
}

function measurePixels(buf, width, height) {
  const n = width * height;
  let satSum = 0, ySum = 0, rSum = 0, gSum = 0, bSum = 0, high = 0, shadow = 0;
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    satSum += mx > 0 ? (mx - mn) / mx : 0;
    ySum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    rSum += r; gSum += g; bSum += b;
    if (mx >= 250) high++;
    if (mx <= 5) shadow++;
  }
  return {
    sat: Math.round((satSum / n) * 1000) / 1000,
    luma: Math.round((ySum / n) * 10) / 10,
    high: Math.round((high / n) * 10000) / 100,
    shadow: Math.round((shadow / n) * 10000) / 100,
    rgb: [Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)]
  };
}

function measureImage(imagePath) {
  const d = videoProcessor.probeDetail(imagePath);
  if (!d.success || !d.width || !d.height) {
    throw new Error('无法读取图片尺寸: ' + (d.error || ''));
  }
  const buf = decodeRaw(imagePath, d.width, d.height);
  return { ...measurePixels(buf, d.width, d.height), width: d.width, height: d.height };
}

function curvesFor(high) {
  if (high > 5) return "0/0 0.18/0.17 0.5/0.49 0.82/0.79 1/0.93";
  if (high > 1) return "0/0 0.19/0.184 0.5/0.5 0.82/0.805 1/0.96";
  return "0/0 0.2/0.196 0.5/0.5 0.82/0.812 1/0.97";
}

function buildFilter(gain, brightness, high, palette) {
  const p = PALETTES[palette] || PALETTES.calm;
  const cb = p.colorbalance ? `,colorbalance=${p.colorbalance}` : '';
  return `eq=saturation=${gain.toFixed(3)}:brightness=${brightness.toFixed(3)}:contrast=1.01,`
    + `curves=master='${curvesFor(high)}'${cb}`;
}

function render(inputPath, outputPath, filter) {
  const cmd = `"${config.FFMPEG_PATH}" -y -v error -i "${inputPath}" -vf "${filter}" -frames:v 1 "${outputPath}"`;
  const run = videoProcessor._runFFmpeg(cmd);
  if (!run.success) throw new Error(run.error || 'ffmpeg 调色失败');
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('调色产物为空');
  }
}

/**
 * 逐图自适应调色：按目标饱和度搜索 1–3 次，限幅，返回实际参数与前后指标。
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{palette?: 'cold'|'warm'|'night'|'calm', targetSaturation?: number, maxGain?: number}} [options]
 */
async function autoGradeImage(inputPath, outputPath, options = {}) {
  const palette = PALETTES[options.palette] ? options.palette : 'calm';
  const p = PALETTES[palette];
  const target = Number.isFinite(options.targetSaturation) ? options.targetSaturation : p.targetSat;
  const before = measureImage(inputPath);

  // 初值：低饱和图几乎不动；高饱和图按比例压，但限幅 [0.35, 1]。
  const ratio = target / Math.max(before.sat, 0.05);
  let gain = Math.max(0.35, Math.min(1, ratio));
  const brightness = before.high > 5 ? -0.03 : (before.high > 1 ? -0.015 : 0);

  let finalFilter = buildFilter(gain, brightness, before.high, palette);
  render(inputPath, outputPath, finalFilter);
  let after = measureImage(outputPath);

  // 最多再修 2 次：只往目标靠，不允许把低饱和图越调越艳。
  for (let i = 0; i < 2; i++) {
    // 已经偏自然的图，曲线/对比可能把测得饱和度抬上去；必须反向压低，
    // 否则“调色后”会比原图更艳（实测 0.361 -> 0.368）。
    if (before.sat > target && after.sat > before.sat * 1.005) {
      gain = Math.max(0.25, gain * 0.82);
    } else if (after.sat > target * 1.25) {
      gain = Math.max(0.3, gain * 0.8);
    } else if (after.sat < target * 0.75 && before.sat > target) {
      gain = Math.min(1, gain * 1.12);
    } else {
      break;
    }
    finalFilter = buildFilter(gain, brightness, before.high, palette);
    render(inputPath, outputPath, finalFilter);
    after = measureImage(outputPath);
  }

  // 最后一次安全兜底：仍比原图艳，就再降一次，绝不让“调色后更艳”。
  if (before.sat > target && after.sat > before.sat * 1.005) {
    gain = Math.max(0.2, gain * 0.8);
    finalFilter = buildFilter(gain, brightness, before.high, palette);
    render(inputPath, outputPath, finalFilter);
    after = measureImage(outputPath);
  }

  return {
    ok: true,
    outputPath,
    palette,
    paletteLabel: p.label,
    targetSaturation: target,
    params: {
      gain: Math.round(gain * 1000) / 1000,
      brightness,
      contrast: 1.01,
      curves: curvesFor(before.high),
      colorbalance: p.colorbalance || null,
      filter: finalFilter
    },
    before,
    after
  };
}

module.exports = { PALETTES, measureImage, autoGradeImage, buildFilter };
