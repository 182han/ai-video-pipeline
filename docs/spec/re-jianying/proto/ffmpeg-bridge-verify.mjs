// 端到端验证：调节链 → .cube → ffmpeg lut3d → 与真实导出对比
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCubeText } from './adjust-ffmpeg.mjs';

const FF = 'C:\\Users\\14872\\Desktop\\测试\\app\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const R = 'C:\\Users\\14872\\Desktop\\风景照片\\对照';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
const W = 480, H = 270;

const ff = (args, cwd) => {
  const r = spawnSync(FF, args, { stdio: 'ignore', windowsHide: true, cwd });
  if (r.status !== 0) throw new Error('ffmpeg fail: ' + args.join(' ').slice(0, 100));
};
function rawFrame(src, t) {
  const out = path.join(T, 'f' + Math.random().toString(36).slice(2) + '.raw');
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(4), '-i', src,
    '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const b = fs.readFileSync(out); fs.unlinkSync(out); return b;
}
const psnr = (a, b) => {
  let se = 0;
  for (let i = 0; i < b.length; i++) { const d = a[i] - b[i]; se += d * d; }
  return 10 * Math.log10(255 * 255 / (se / b.length));
};

const CASES = [
  ['shadow50', { shadow: 50 }],
  ['sat50', { saturation: 50 }],
  ['bright50', { brightness: 50 }],
  ['temp50', { temperature: 50 }],
  ['con50', { contrast: 50 }],
  ['tone50', { tone: 50 }],
  ['light50', { lightSensation: 50 }],
  ['wheel-blue', { wheel: { gamma: { r: -0.1075, g: 0.0309, b: 0.1468 } } }]
];

for (const [name, params] of CASES) {
  const ref = path.join(R, `${name}.mp4`, `${name}.mp4.mp4`);
  if (!fs.existsSync(ref)) { console.log(`${name}: 缺对照`); continue; }
  const cube = path.join(T, `${name}.cube`);
  fs.writeFileSync(cube, buildCubeText(params, name));
  const outMp4 = path.join(T, `${name}_out.mp4`);
  // lut3d 用相对名 → cwd 设为 cube 目录
  ff(['-y', '-hide_banner', '-loglevel', 'error',
    '-i', path.join(R, 'base.mp4', 'base.mp4.mp4'),
    '-vf', `lut3d=${path.basename(cube)}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', outMp4], path.dirname(cube));
  const a = rawFrame(outMp4, 2.5);
  const b = rawFrame(ref, 2.5 - 1 / 30);
  console.log(`${name.padEnd(9)} ffmpeg 链路 PSNR=${psnr(a, b).toFixed(2)}`);
}
try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
