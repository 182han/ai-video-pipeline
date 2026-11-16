// ==========================================
// 图片手动调色（亮度 / 对比度 / 饱和度 / 色温）
// ==========================================
//
// 契约：docs/交接/2026-11-16-出图审图-接口契约.md §3.5 与 §4（接口名/参数/返回结构已冻结）。
//
// 三条语义（用户口径，不要改）：
//   1. 参数是**绝对值**（-100..100 整数），不是增量：每次都从**原图**重新渲染，
//      不在上一次调色结果上叠加 —— 反复叠加会掉画质，且回退只能靠原图。
//   2. 输出 `<outDir>/<photoId>_adjust_v<N>.png`，**绝不覆盖**已有文件（N 递增）。
//   3. 一律 `execFileSync(ffmpegPath, args 数组)`，禁止字符串拼命令（AGENTS §14）。
//      ffmpegPath 由调用方传入（路由读 config.FFMPEG_PATH），本模块不 require config。
//
// 参数映射（单调、范围克制，避免过曝/全黑）：
//   亮度   eq=brightness= v/100*0.30   → ±100 时 ±0.30（ffmpeg eq 的取值域是 -1..1）
//   对比度 eq=contrast=   1+v/100*0.50 → ±100 时 0.5..1.5（默认 1.0）
//   饱和度 eq=saturation= 1+v/100*1.00 → ±100 时 0..2（-100 = 全去饱和，0 = 不调）
//   色温   colorbalance=rs=+r:bs=-r    → r=v/100*0.30，正=暖（加红减蓝）、负=冷（加蓝减红）
//
// 实测（tools/ffmpeg 8.1，128x96 灰阶梯度图 0x10→0xf0）：
//   eq=brightness=0.15  → YAVG 69.8 → 105.4；brightness=-0.15 → 34.2
//   colorbalance=rs=0.15:bs=-0.15 → 平均 R 79.5 / B 51.8（原图 62.5/62.5），R-B +27.7
// 说明：colorbalance 的 rs/bs 主要作用于暗部（阴影），纯中灰/纯色图几乎测不出变化；
//       真实照片含明暗层次，效果正常。故验收脚本用灰阶梯度图取实测值。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 契约 §4 冻结的导出之一：四参数合法区间（含端点，整数）
const PARAM_RANGES = Object.freeze({
  brightness: Object.freeze([-100, 100]),
  contrast: Object.freeze([-100, 100]),
  saturation: Object.freeze([-100, 100]),
  temperature: Object.freeze([-100, 100])
});

const PARAM_KEYS = ['brightness', 'contrast', 'saturation', 'temperature'];

// 映射系数（见文件头注释；改这里要同步改 scripts/verify-photo-adjust.js 的阈值）
const BRIGHTNESS_SCALE = 0.30;
const CONTRAST_SCALE = 0.50;
const SATURATION_SCALE = 1.00;
const TEMPERATURE_SCALE = 0.30;

// ffmpeg stderr 只回传末尾 400 字（契约 §4），避免整段日志进 API 响应
const STDERR_TAIL = 400;

function badParam(message) {
  const err = new Error(message);
  err.code = 'E_BAD_PARAM';
  return err;
}

function missingFile(message) {
  const err = new Error(message);
  err.code = 'E_MISSING_FILE';
  return err;
}

function ffmpegNotFound(message) {
  const err = new Error(message);
  err.code = 'E_FFMPEG_NOT_FOUND';
  return err;
}

function isIdentity(params) {
  return PARAM_KEYS.every((k) => params[k] === 0);
}

/**
 * 参数规范化：缺省键按 0 处理；非整数/越界/非数字一律 E_BAD_PARAM。
 * 注意：全 0 在 normalize 层是合法的（四个参数都在区间内），
 * 但 applyToPhoto 会拒绝全 0（契约 §3.5：全 0 且非 reset → 400）。
 * @param {object} [raw]
 * @returns {{brightness:number,contrast:number,saturation:number,temperature:number}}
 */
function normalizeParams(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badParam('调色参数必须是对象');
  }
  const out = {};
  for (const key of PARAM_KEYS) {
    const value = raw[key];
    // 缺省 = 不调这一项（契约示例里也允许只传一部分）
    if (value === undefined || value === null) {
      out[key] = 0;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw badParam(`调色参数 ${key} 必须是数字（收到 ${JSON.stringify(value)}）`);
    }
    if (!Number.isInteger(value)) {
      throw badParam(`调色参数 ${key} 必须是整数（收到 ${value}）`);
    }
    const [min, max] = PARAM_RANGES[key];
    if (value < min || value > max) {
      throw badParam(`调色参数 ${key} 超出范围 ${min}..${max}（收到 ${value}）`);
    }
    out[key] = value;
  }
  return out;
}

// 数字转滤镜字符串：保留 4 位小数再还原数字，去掉多余的 0（0.1500 → 0.15）
function fmtNum(n) {
  return String(Number(Number(n).toFixed(4)));
}

/**
 * 生成 ffmpeg -vf 滤镜串。参数会先归一化（非法 → E_BAD_PARAM）。
 * 色温为 0 时不附加 colorbalance（保持纯 eq，输出更可预期）。
 * @param {object} params
 * @returns {string} 例如 `eq=brightness=0.15:contrast=1.25:saturation=1.5,colorbalance=rs=0.15:bs=-0.15`
 */
function buildFilter(params) {
  const p = normalizeParams(params);
  const brightness = (p.brightness / 100) * BRIGHTNESS_SCALE;
  const contrast = 1 + (p.contrast / 100) * CONTRAST_SCALE;
  const saturation = 1 + (p.saturation / 100) * SATURATION_SCALE;
  let filter = `eq=brightness=${fmtNum(brightness)}:contrast=${fmtNum(contrast)}:saturation=${fmtNum(saturation)}`;
  if (p.temperature !== 0) {
    // 正=暖：加红（rs）、减蓝（bs）；负=冷：加蓝、减红
    const shift = (p.temperature / 100) * TEMPERATURE_SCALE;
    filter += `,colorbalance=rs=${fmtNum(shift)}:bs=${fmtNum(-shift)}`;
  }
  return filter;
}

function safePhotoId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  if (!s) throw badParam('photo.id 缺失');
  return s;
}

function rmQuiet(target) {
  try {
    if (target && fs.existsSync(target)) fs.unlinkSync(target);
  } catch (e) { /* 清理失败不覆盖原错误 */ }
}

function assertReadableFile(filePath, label) {
  let st = null;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    throw missingFile(`${label}不存在: ${filePath}`);
  }
  if (!st.isFile()) throw missingFile(`${label}不是文件: ${filePath}`);
  if (st.size < 8) throw missingFile(`${label}文件无效（${st.size} 字节）: ${filePath}`);
  return st;
}

function assertFfmpeg(ffmpegPath) {
  if (!ffmpegPath || typeof ffmpegPath !== 'string') {
    throw ffmpegNotFound('缺少 ffmpegPath（应由调用方传入 config.FFMPEG_PATH）');
  }
  const resolved = path.resolve(ffmpegPath);
  let st = null;
  try {
    st = fs.statSync(resolved);
  } catch (e) {
    throw ffmpegNotFound(`ffmpeg 不存在: ${resolved}`);
  }
  if (!st.isFile()) throw ffmpegNotFound(`ffmpeg 不是文件: ${resolved}`);
  return resolved;
}

function stderrText(e) {
  if (!e || !e.stderr) return '';
  return Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : String(e.stderr);
}

function stderrTail(e) {
  const text = stderrText(e).replace(/\s+/g, ' ').trim();
  return text.length > STDERR_TAIL ? text.slice(-STDERR_TAIL) : text;
}

// ---------- 图片尺寸读取（输出固定 PNG；原图可能是 png/jpg/webp） ----------

function readPngSize(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(33);
    const n = fs.readSync(fd, head, 0, 33, 0);
    if (n < 33) throw new Error('PNG 头不足 33 字节');
    if (head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a) {
      throw new Error('输出不是 PNG（签名不符）');
    }
    if (head.toString('ascii', 12, 16) !== 'IHDR') throw new Error('输出 PNG 缺少 IHDR');
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    if (!width || !height) throw new Error('输出 PNG 尺寸为 0');
    return { width, height };
  } finally {
    fs.closeSync(fd);
  }
}

function readJpegSize(buf) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // 无长度的独立标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // 到 EOI/SOS 仍未遇到 SOF
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15（排除 DHT/JPG/DAC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

function readWebpSize(buf) {
  const fmt = buf.toString('ascii', 12, 16);
  if (fmt === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (fmt === 'VP8 ') {
    if (buf.length < 30) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fmt === 'VP8L') {
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const bits = (buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * 读图片宽高（png/jpeg/webp 头部解析，不依赖 ffprobe）。
 * @param {string} filePath
 * @returns {{width:number,height:number}|null}
 */
function readImageSize(filePath) {
  let buf = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const b = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      buf = b.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return readJpegSize(buf);
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return readWebpSize(buf);
  }
  return null;
}

// ---------- 版本号：扫描目录 + photo.adjust 记录，取最大值 + 1 ----------

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextVersion(outDir, photoId, photo) {
  const re = new RegExp(`^${escapeRegExp(photoId)}_adjust_v(\\d+)\\.png$`);
  let max = 0;
  try {
    for (const name of fs.readdirSync(outDir)) {
      const m = name.match(re);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch (e) { /* 目录还不存在：从 1 开始 */ }
  const adjust = photo && photo.adjust && typeof photo.adjust === 'object' ? photo.adjust : null;
  if (adjust && adjust.current && Number.isInteger(Number(adjust.current.version))) {
    max = Math.max(max, Number(adjust.current.version));
  }
  if (adjust && Array.isArray(adjust.versions)) {
    for (const v of adjust.versions) {
      const n = Number(v && v.version);
      if (Number.isInteger(n)) max = Math.max(max, n);
    }
  }
  return max + 1;
}

/**
 * 按参数从**原图**重新渲染一张调色图（绝对值语义，不叠加）。
 * @param {{photo:object, params:object, outDir:string, ffmpegPath:string, originalPath:string}} opts
 * @returns {{ok:true, filePath:string, width:number, height:number, sizeBytes:number, filter:string, version:number}}
 * 失败：参数非法 → err.code='E_BAD_PARAM'；原图不存在 → 'E_MISSING_FILE'；
 *       ffmpeg 不存在 → 'E_FFMPEG_NOT_FOUND'；ffmpeg 非 0 退出 → 'E_FFMPEG'（stderr 尾部 ≤400 字）。
 */
function applyToPhoto({ photo, params, outDir, ffmpegPath, originalPath } = {}) {
  const normalized = normalizeParams(params);
  if (isIdentity(normalized)) {
    // 契约 §3.5：全 0 且非 reset → 400；在模块层落成 E_BAD_PARAM，路由不用重复判断
    throw badParam('四个调色参数全为 0，没有可渲染的变化；回退原图请用 reset');
  }
  const photoId = safePhotoId(photo && photo.id);
  if (!outDir || typeof outDir !== 'string') throw badParam('缺少输出目录 outDir');
  if (!originalPath) throw missingFile('缺少原图路径 originalPath（调色必须从原图重渲染）');

  const sourcePath = path.resolve(String(originalPath));
  assertReadableFile(sourcePath, '原图');
  const ffmpegBin = assertFfmpeg(ffmpegPath);

  const absOutDir = path.resolve(outDir);
  fs.mkdirSync(absOutDir, { recursive: true });

  const filter = buildFilter(normalized);
  let version = nextVersion(absOutDir, photoId, photo);
  let finalPath = path.join(absOutDir, `${photoId}_adjust_v${version}.png`);
  // 并发/历史兜底：绝不覆盖任何已有文件
  while (fs.existsSync(finalPath)) {
    version += 1;
    finalPath = path.join(absOutDir, `${photoId}_adjust_v${version}.png`);
  }

  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  // 参数全用数组传，禁止字符串拼命令（AGENTS §14）
  const args = [
    '-nostdin', '-y', '-hide_banner', '-v', 'error',
    '-i', sourcePath,
    '-vf', filter,
    '-frames:v', '1',
    tmpPath
  ];

  try {
    rmQuiet(tmpPath);
    execFileSync(ffmpegBin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    let tmpStat = null;
    try {
      tmpStat = fs.statSync(tmpPath);
    } catch (e) {
      throw new Error('ffmpeg 未产出文件（退出码 0 但没有输出）');
    }
    if (!tmpStat.isFile() || tmpStat.size === 0) {
      throw new Error(`ffmpeg 产物无效（${tmpStat.size} 字节）`);
    }
    // 先校验产物尺寸，再原子改名：改名后不再有「坏文件占着正式名」的窗口
    const size = readPngSize(tmpPath);
    fs.renameSync(tmpPath, finalPath);
    const finalStat = fs.statSync(finalPath);
    return {
      ok: true,
      filePath: finalPath,
      width: size.width,
      height: size.height,
      sizeBytes: finalStat.size,
      filter,
      version
    };
  } catch (e) {
    rmQuiet(tmpPath);
    if (e && (e.code === 'E_BAD_PARAM' || e.code === 'E_MISSING_FILE' || e.code === 'E_FFMPEG_NOT_FOUND')) throw e;
    const tail = stderrTail(e);
    const err = new Error(`ffmpeg 调色失败${e && e.status !== undefined && e.status !== null ? `（exit ${e.status}）` : ''}: ${tail || (e && e.message) || '未知错误'}`);
    err.code = 'E_FFMPEG';
    err.exitCode = e && e.status;
    err.stderrTail = tail;
    throw err;
  }
}

/**
 * 回退到原图：只校验原图仍在并返回其路径/真实尺寸（不动文件、不复制）。
 * 返回额外带 sizeBytes（契约 §4 必需字段之外的上限增补）：server.js 的 reset 分支用它
 * 把 photo.sizeBytes 还原成原图真实大小，否则会残留上一次调色产物的字节数。
 * @param {{photo:object, originalPath:string}} opts
 * @returns {{ok:true, filePath:string, width:number|null, height:number|null, sizeBytes:number}}
 */
function revertToOriginal({ photo, originalPath } = {}) {
  if (!originalPath) throw missingFile('缺少原图路径 originalPath');
  const sourcePath = path.resolve(String(originalPath));
  const stat = assertReadableFile(sourcePath, '原图');
  const dim = readImageSize(sourcePath) || {};
  const adjust = photo && photo.adjust && typeof photo.adjust === 'object' ? photo.adjust : {};
  const fallbackWidth = Number.isFinite(Number(adjust.originalWidth)) ? Number(adjust.originalWidth)
    : (Number.isFinite(Number(photo && photo.width)) ? Number(photo.width) : null);
  const fallbackHeight = Number.isFinite(Number(adjust.originalHeight)) ? Number(adjust.originalHeight)
    : (Number.isFinite(Number(photo && photo.height)) ? Number(photo.height) : null);
  return {
    ok: true,
    filePath: sourcePath,
    width: dim.width || fallbackWidth,
    height: dim.height || fallbackHeight,
    sizeBytes: stat.size
  };
}

module.exports = {
  PARAM_RANGES,
  normalizeParams,
  buildFilter,
  applyToPhoto,
  revertToOriginal
};
