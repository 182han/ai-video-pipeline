// ============================================================
// adjust-lut-probe.mjs —— 剪映「调节」LUT 取证探针
// ------------------------------------------------------------
// 用途：从 DefaultAdjustBundle 的 .texture 容器里取出内嵌 PNG（17³ LUT），
//       解码成 raw RGB，采样验证结构。只读，不修改剪映任何文件。
//
// 用法：
//   node adjust-lut-probe.mjs            # 采样 7 个 LUT 类滑杆
//   node adjust-lut-probe.mjs --dump     # 额外把每张 PNG 写到临时目录
//
// 结论（2026-10-27 实测）：
//   brightness/contrast/saturation/temperature/tone   289x34（上下两半 = 负/正）
//   highlight/shadow                                  289x17（单向）
//   布局：x = blueSlice*17 + redIndex，y = greenIndex (+17 表示正向半)
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FF = process.env.FFMPEG_PATH
  || 'C:\\Users\\14872\\Desktop\\测试\\app\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const BASE = process.env.JY_ADJUST_DIR
  || 'C:\\Users\\14872\\AppData\\Local\\JianyingPro\\User Data\\Resources\\DefaultAdjustBundle';
const PARAMS = ['brightness', 'contrast', 'saturation', 'temperature', 'tone', 'highlight', 'shadow'];
const DUMP = process.argv.includes('--dump');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function findTexture(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase().endsWith('.texture')) return p;
    }
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-lut-'));
const rows = [];

for (const p of PARAMS) {
  const tex = findTexture(path.join(BASE, p));
  if (!tex) { rows.push({ param: p, error: 'no .texture' }); continue; }
  const buf = fs.readFileSync(tex);
  const s = buf.indexOf(SIG);
  const e = s >= 0 ? buf.indexOf(IEND, s) : -1;
  if (s < 0 || e < 0) { rows.push({ param: p, error: 'no complete PNG' }); continue; }

  const png = buf.subarray(s, e + 8);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const pngPath = path.join(tmp, `${p}.png`);
  const rawPath = path.join(tmp, `${p}.raw`);
  fs.writeFileSync(pngPath, png);

  const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', pngPath,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', rawPath], { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) { rows.push({ param: p, w, h, error: 'decode failed' }); continue; }
  const raw = fs.readFileSync(rawPath);
  const px = (x, y) => {
    const i = (y * w + x) * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  // 中灰：蓝 8 / 绿 8 / 红 8
  const sample = (half) => {
    const y = 8 + (half ? Math.floor(h / 2) : 0);
    return px(8 * 17 + 8, y);
  };
  const halfH = Math.floor(h / 2);
  rows.push({
    param: p,
    w,
    h,
    halves: h >= 2 * 17 ? 'neg/pos' : 'single',
    midNeg: sample(false),
    midPos: halfH >= 17 ? px(8 * 17 + 8, 8 + halfH) : null
  });

  if (DUMP) {
    const out = path.join(tmp, `${p}.lut.png`);
    fs.writeFileSync(out, png);
    rows[rows.length - 1].png = out;
  }
}

console.log(JSON.stringify({ tmp, rows }, null, 1));
if (!DUMP) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
