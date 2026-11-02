// ============================================================
// cube-validate.mjs —— 校验 lut-extract.mjs 产出的 .cube
// ------------------------------------------------------------
// 两条硬指标：
//   1) 强度 0 的 cube 必须与原图逐像素一致（容差 ±1，来自 8bit/6位小数舍入）
//   2) 中灰 128 在 brightness ±50 下必须等于 LUT 采样值（+50→216，-50→60）
//
// 注意：ffmpeg 的 lut3d 滤镜里不能直接写 Windows 绝对路径（盘符冒号会被当滤镜分隔符），
//       必须 chdir 到 cube 目录、用相对文件名。
// 用法：node cube-validate.mjs [cubes目录]
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FF = process.env.FFMPEG_PATH
  || 'C:\\Users\\14872\\Desktop\\测试\\app\\tools\\ffmpeg\\bin\\ffmpeg.exe';
// 注意：import.meta.url 的 pathname 是百分号编码的（中文目录会变成 %E6...），
// 必须用 fileURLToPath 转回本地路径。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(process.argv[2] || path.join(HERE, 'cubes'));
process.chdir(DIR);

function ff(args) {
  const r = spawnSync(FF, args, { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg 失败: ' + args.join(' ').slice(0, 140));
}
function rawOf(img, cube) {
  const out = `.v_${Math.random().toString(36).slice(2)}.raw`;
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-i', img,
    ...(cube ? ['-vf', `lut3d=${cube}`] : []),
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  return buf;
}
const mean = (b) => +(b.reduce((a, v) => a + v, 0) / b.length).toFixed(2);
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

// 1) 恒等性：彩色测试图
ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'testsrc2=s=320x180:d=1', '-frames:v', '1', '.v_src.png']);
const base = rawOf('.v_src.png', null);
const id0 = rawOf('.v_src.png', 'brightness+0.cube');

// 2) 中灰定点：128 在 ±50 下应等于 LUT 采样
ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'color=c=0x808080:s=64x64:d=1', '-frames:v', '1', '.v_gray.png']);
const gray = {
  '原图': mean(rawOf('.v_gray.png', null)),
  '+50': mean(rawOf('.v_gray.png', 'brightness+50.cube')),
  '-50': mean(rawOf('.v_gray.png', 'brightness-50.cube')),
  '0': mean(rawOf('.v_gray.png', 'brightness+0.cube'))
};

const identityDiff = maxDiff(base, id0);
const report = {
  identity: {
    maxPixelDiff: identityDiff,
    tolerance: 1,
    pass: identityDiff <= 1,
    note: '±1 来自 8bit 输出与 .cube 6 位小数舍入；grid 点本身是精确值'
  },
  gray128: {
    actual: gray,
    expected: { '原图': 128, '+50': 216, '-50': 60, '0': 128 },
    pass: gray['+50'] === 216 && gray['-50'] === 60 && gray['0'] === 128
  }
};
report.pass = report.identity.pass && report.gray128.pass;

for (const f of fs.readdirSync(DIR)) if (f.startsWith('.v_')) fs.unlinkSync(path.join(DIR, f));
console.log(JSON.stringify(report, null, 1));
process.exit(report.pass ? 0 : 1);
