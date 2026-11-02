// 冒烟测试：用 adjust-chain 跑单滑杆，确认与之前的拟合结果一致
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adjustChain } from './adjust-chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FF = 'C:\\Users\\14872\\Desktop\\测试\\app\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const R = 'C:\\Users\\14872\\Desktop\\风景照片\\对照';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-'));
const W = 320, H = 180;

const ff = (a) => { const r = spawnSync(FF, a, { stdio: 'ignore', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg fail'); };
const frameAt = (src, t) => {
  const out = path.join(T, 'f' + Math.random().toString(36).slice(2) + '.raw');
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(4), '-i', src, '-frames:v', '1',
    '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const b = fs.readFileSync(out); fs.unlinkSync(out); return b;
};
const psnr = (a, b) => { let se = 0; for (let i = 0; i < b.length; i++) { const d = a[i] - b[i]; se += d * d; } return 10 * Math.log10(255 * 255 / (se / b.length)); };
const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));

const base = frameAt(path.join(R, 'base.mp4', 'base.mp4.mp4'), 2.5);
const CASES = [
  ['shadow50', { shadow: 50 }],
  ['sat50', { saturation: 50 }],
  ['con50', { contrast: 50 }],
  ['bright50', { brightness: 50 }],
  ['temp50', { temperature: 50 }],
  ['tone50', { tone: 50 }]
];

for (const [name, params] of CASES) {
  const f = path.join(R, `${name}.mp4`, `${name}.mp4.mp4`);
  if (!fs.existsSync(f)) { console.log(`${name}: 缺对照`); continue; }
  const tgt = frameAt(f, 2.5 - 1 / 30);
  const pred = new Uint8Array(base.length);
  let bad = 0;
  for (let i = 0; i < base.length; i += 3) {
    const o = adjustChain([base[i] / 255, base[i + 1] / 255, base[i + 2] / 255], params);
    for (let c = 0; c < 3; c++) {
      const v = o[c];
      if (!Number.isFinite(v) || v < 0 || v > 1) bad++;
      pred[i + c] = cl(v * 255);
    }
  }
  console.log(`${name.padEnd(10)} chain PSNR=${psnr(pred, tgt).toFixed(2)}   越界像素=${bad}`);
}
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
