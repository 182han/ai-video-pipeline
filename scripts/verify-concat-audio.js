// ==========================================================
// 拼接音轨兼容性 验收脚本
//
// 背景（历史缺陷）：
//   videoProcessor._concatenateFFmpeg 的重编码兜底曾硬编码
//     const filterParts = clips.map((_, i) => `[${i}:v][${i}:a]`).join('');
//   —— 遇到【无音轨】片段直接 `Stream specifier ':a' matches no streams` 失败。
//   若 -c copy 也走不通（例如片段编码参数不一致），就没有任何兜底，整条拼接失败。
//
//   另发现一个更隐蔽的问题：混合音轨（部分有、部分无）时，`-c copy` 路径
//   退出码 0、时长正确，但产物只剩 video 流 —— **音频被静默丢弃**，
//   而 _validateConcatDuration 只校验时长，抓不到。
//
// 修复后的行为：
//   全有音轨 -> copy 直拼；失败则重编码 concat=v=1:a=1
//   全无音轨 -> copy 直拼；失败则重编码 concat=v=1:a=0（只 map 视频）
//   混合     -> 跳过 copy（会丢音频），重编码前给无音轨片段补等长静音，再 concat=v=1:a=1
//
// 用法：
//   node scripts/verify-concat-audio.js
//   node scripts/verify-concat-audio.js --tmpdir output/verify_concat
// ==========================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const config = require('../config');
const vp = require('../src/videoProcessor');

const FF = config.FFMPEG_PATH || 'ffmpeg';
const FP = config.FFPROBE_PATH || 'ffprobe';

const TMP_ARG = process.argv.indexOf('--tmpdir');
const TMP = (TMP_ARG > -1 && process.argv[TMP_ARG + 1])
  ? path.resolve(process.argv[TMP_ARG + 1])
  : path.join(os.tmpdir(), `verify_concat_${process.pid}_${Date.now()}`);

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) {
    // 受限环境（本项目的 DSH 沙箱）禁止管道 stdio，捕获 stdout 会 EPERM。
    // 降级为「重定向到临时文件再读」，与 videoProcessor._execText / verify-bgm-mix.js 同思路。
    const tmp = path.join(TMP, `_sh_${process.pid}_${Date.now()}.txt`);
    try {
      try { fs.mkdirSync(TMP, { recursive: true }); } catch (e1) {}
      try { execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore' }); } catch (e2) { /* 非 0 退出也要读输出 */ }
      const out = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
      try { fs.unlinkSync(tmp); } catch (e3) {}
      return out;
    } catch (e4) {
      return '';
    }
  }
}

function probeDuration(f) {
  const o = sh(`"${FP}" -v error -show_entries format=duration -of csv=p=0 "${f}"`);
  const v = parseFloat(String(o).trim());
  return isFinite(v) ? v : null;
}

function probeStreams(f) {
  const o = sh(`"${FP}" -v error -show_entries stream=codec_type -of csv=p=0 "${f}"`);
  return String(o).split(/\r?\n/).filter(Boolean);
}

// 段落音量（用于验证"补的是静音、原有音频还在"）
function segmentVolume(f, start, dur) {
  const out = sh(`"${FF}" -hide_banner -ss ${start} -t ${dur} -i "${f}" -af volumedetect -f null - 2>&1`);
  const m = String(out).match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  if (!m) return null;
  return String(m[1]).toLowerCase() === '-inf' ? -Infinity : parseFloat(m[1]);
}

// 造测试片段
function makeClip(file, color, seconds, withAudio, freq) {
  const limit = withAudio ? '' : '';
  const cmd = withAudio
    ? `"${FF}" -y -v error -f lavfi -i "color=c=${color}:s=640x360:d=${seconds}:r=30" `
      + `-f lavfi -i "sine=frequency=${freq}:duration=${seconds}" `
      + `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -c:a aac -shortest "${file}"`
    : `"${FF}" -y -v error -f lavfi -i "color=c=${color}:s=640x360:d=${seconds}:r=30" `
      + `-c:v libx264 -pix_fmt yuv420p -preset ultrafast "${file}"`;
  sh(cmd);
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  console.log('='.repeat(64));
  console.log('拼接音轨兼容性 验收');
  console.log('='.repeat(64));
  console.log(`临时目录: ${TMP}`);

  // ---------- 准备素材 ----------
  console.log('\n[0] 准备测试素材（3s/段）');
  const na1 = path.join(TMP, 'na1.mp4');
  const na2 = path.join(TMP, 'na2.mp4');
  const wa1 = path.join(TMP, 'wa1.mp4');
  const wa2 = path.join(TMP, 'wa2.mp4');
  const ok0 = makeClip(na1, 'red', 3, false, 0)
    && makeClip(na2, 'blue', 3, false, 0)
    && makeClip(wa1, 'green', 3, true, 500)
    && makeClip(wa2, 'yellow', 3, true, 800);
  assert(ok0, '四段素材创建成功（2 无音轨 + 2 有音轨）',
    ok0 ? '' : '创建失败');
  if (!ok0) { summary(); return; }

  // ---------- 1. 全有音轨 ----------
  console.log('\n[1] 全有音轨');
  const o1 = path.join(TMP, 'out_all_audio.mp4');
  const r1 = await vp.concatenate([wa1, wa2], o1);
  assert(r1.success === true, '拼接成功', r1.success ? '' : r1.error);
  if (r1.success) {
    const ss = probeStreams(o1);
    assert(ss.includes('video'), '产物含视频流', ss.join('|'));
    assert(ss.includes('audio'), '产物保留音频流', ss.join('|'));
    const d = probeDuration(o1);
    assert(d !== null && Math.abs(d - 6) <= 0.5, '时长 ≈ 各段之和 6s', `实测 ${d}s`);
  }

  // ---------- 2. 全无音轨（历史会失败的场景） ----------
  console.log('\n[2] 全无音轨（历史缺陷：硬编码 [i:a] 会直接失败）');
  const o2 = path.join(TMP, 'out_no_audio.mp4');
  const r2 = await vp.concatenate([na1, na2], o2);
  assert(r2.success === true, '无音轨片段拼接成功（不再报 matches no streams）',
    r2.success ? '' : r2.error);
  if (r2.success) {
    const ss = probeStreams(o2);
    assert(ss.includes('video'), '产物含视频流', ss.join('|'));
    assert(!ss.includes('audio'), '产物无音频流（输入本来就没有，属正确）', ss.join('|'));
    const d = probeDuration(o2);
    assert(d !== null && Math.abs(d - 6) <= 0.5, '时长 ≈ 6s', `实测 ${d}s`);
  }

  // ---------- 3. 混合音轨（历史会静默丢音频） ----------
  console.log('\n[3] 混合音轨（历史缺陷：-c copy 静默丢音频）');
  const o3 = path.join(TMP, 'out_mixed.mp4');
  const r3 = await vp.concatenate([na1, wa1], o3);
  assert(r3.success === true, '混合音轨拼接成功', r3.success ? '' : r3.error);
  if (r3.success) {
    const ss = probeStreams(o3);
    assert(ss.includes('audio'),
      '产物保留音频流（素材有一半带音轨，不能丢）', ss.join('|'));
    assert(r3.reencoded === true,
      '混合场景走了重编码（跳过会丢音频的 copy 路径）', `reencoded=${r3.reencoded}`);
    assert(r3.silencePadded === 1,
      '为 1 个无音轨片段补了静音', `silencePadded=${r3.silencePadded}`);
    const d = probeDuration(o3);
    assert(d !== null && Math.abs(d - 6) <= 0.5, '时长 ≈ 6s', `实测 ${d}s`);

    // 分段音量：前段（无音轨补静音）应接近静音；后段（原有音轨）应有声
    const v1 = segmentVolume(o3, 0, 3);
    const v2 = segmentVolume(o3, 3, 3);
    assert(v1 !== null && v1 <= -80,
      '前 3s（原无音轨段）确为静音', `mean=${v1} dB`);
    assert(v2 !== null && v2 > -60,
      '后 3s（原有音轨段）音频仍在，未被静音吞掉', `mean=${v2} dB`);
  }

  // ---------- 4. 无残留临时文件 ----------
  console.log('\n[4] 临时文件清理');
  const leftovers = fs.readdirSync(TMP).filter(f => /\.pad\d+\./.test(f) || f.endsWith('.txt'));
  assert(leftovers.length === 0,
    '补静音与 concat 列表临时文件均已清理',
    leftovers.length ? leftovers.join(',') : '无残留');

  summary();
}

function summary() {
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }
  console.log('='.repeat(64));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('验收脚本异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
