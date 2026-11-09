// ==========================================
// 图片字节元信息：类型嗅探 + 宽高解析
// ==========================================
//
// 用途：出图适配器把文件交给流水线之前，必须证明「下载到的确实是一张图」。
// 这里只读文件头，不解码像素；无法识别 / 文件头不完整一律抛错，
// 避免把 HTML 错误页、空文件、半截下载当成图片（AGENTS.md §4.8：不许谎报状态）。
//
// 支持：PNG、JPEG、WebP。
// wan2.7-image 官方输出 PNG；JPEG/WebP 作为兜底（结果 URL 可能被 CDN 转码）。
// ==========================================

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function _sane(meta) {
  if (!meta) return null;
  const w = Number(meta.width);
  const h = Number(meta.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 1 || h < 1 || w > 20000 || h > 20000) return null;
  return { width: w, height: h };
}

/** 只根据文件头判断 MIME/扩展名；不认识返回 null。 */
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(PNG_SIG)) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

// PNG：8 字节签名 + 4 字节长度 + "IHDR" + width(4) + height(4)
function _pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// JPEG：从 SOI 之后逐段走，找 SOF0/1/2...（排除 DHT/JPG/DAC）读高宽
function _jpegSize(buf) {
  if (buf.length < 4) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xff) { off++; continue; }                       // 填充字节
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2; continue;                                           // 无长度段
    }
    if (marker === 0xd9 || marker === 0xda) break;                  // EOI / SOS：再往后没有 SOF
    const segLen = buf.readUInt16BE(off + 2);
    if (segLen < 2 || off + 2 + segLen > buf.length) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (segLen < 7 || off + 9 > buf.length) break;
      // 段内布局：长度(2) 精度(1) 高(2) 宽(2)
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
    }
    off += 2 + segLen;
  }
  return null;
}

// WebP：RIFF....WEBP，再按 VP8X / VP8 / VP8L 三种 chunk 解析
function _webpSize(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    // chunk data 从 20 开始：flags(1) reserved(3) canvasW-1(3) canvasH-1(3)
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3)
    };
  }
  if (fourcc === 'VP8 ') {
    // frame header 从 20 开始；23..25 是 0x9d 0x01 0x2a 起始码
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff
    };
  }
  if (fourcc === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b1 = buf[21], b2 = buf[22], b3 = buf[23], b4 = buf[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    };
  }
  return null;
}

/**
 * 解析图片宽高。不是图片 / 头部损坏 / 宽高非法 → 抛错（不要返回 null 让调用方猜）。
 * @param {Buffer} buf
 * @returns {{mime:string, ext:string, width:number, height:number}}
 */
function readImageMeta(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('图片字节为空');
  const type = sniffImageType(buf);
  if (!type) {
    const head = buf.subarray(0, 16).toString('hex');
    throw new Error(`不是可识别的图片（前 16 字节: ${head}）`);
  }
  let size = null;
  if (type.ext === 'png') size = _pngSize(buf);
  else if (type.ext === 'jpg') size = _jpegSize(buf);
  else if (type.ext === 'webp') size = _webpSize(buf);

  const sane = _sane(size);
  if (!sane) throw new Error(`图片头无法解析出合法宽高（${type.mime}，${buf.length} 字节）`);
  return { mime: type.mime, ext: type.ext, width: sane.width, height: sane.height };
}

/** 布尔版：给「只想知道是不是图片」的调用方用，不抛错。 */
function isImageBuffer(buf) {
  try { readImageMeta(buf); return true; } catch (e) { return false; }
}

module.exports = { sniffImageType, readImageMeta, isImageBuffer };
