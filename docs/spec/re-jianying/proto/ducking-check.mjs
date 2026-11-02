#!/usr/bin/env node
// ============================================================
// ducking-check.mjs — 侧链闪避（ducking）可验证原型
// ============================================================
// 目的：证明「人声出现时自动压低 BGM」在本项目自带 ffmpeg 8.1 上可复现，
//       并给出可复述的实测数值（不是文字结论）。
//
// 背景证据：剪映的配乐规则只写「有对白时默认保守 ducking」，没有任何
// 阈值/比例/攻击释放数值（docs/spec/re-jianying/jy-protocol.md §10.2）。
// 因此本原型的参数是本项目的工程选择，不是剪映参数，不得声称等价。
//
// 用法：
//   node docs/spec/re-jianying/proto/ducking-check.mjs [--bgm <音频路径>] [--keep]
//   默认 BGM 取 app/assets/bgm/calm/morning.mp3
//
// 输出：BGM 单独 / 闪避后 在「人声段」与「无人声段」的 mean_volume / max_volume
// ============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'app');

// ---- 解析 ffmpeg（绝不硬编码绝对路径：优先用 app/config.js 的解析结果）----
const require = createRequire(import.meta.url);
const FFMPEG = (() => {
  try {
    const cfg = require(path.join(APP_DIR, 'config.js'));
    if (cfg?.FFMPEG_PATH && fs.existsSync(cfg.FFMPEG_PATH)) return cfg.FFMPEG_PATH;
  } catch { /* ignore */ }
  return 'ffmpeg';
})();

const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const KEEP = args.includes('--keep');
const BGM = path.resolve(argOf('--bgm', path.join(APP_DIR, 'assets', 'bgm', 'calm', 'morning.mp3')));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-'));
const VOICE = path.join(TMP, 'voice.wav');
const BGMS = path.join(TMP, 'bgm.wav');
const DUCKED = path.join(TMP, 'ducked.wav');
const PLAIN = path.join(TMP, 'plain.wav');

const DUR = 8;          // 测试总长（秒）
const WIN_ON = [0.5, 1.5];   // 人声在响的采样窗
const WIN_OFF = [2.5, 3.5];  // 只有音乐的采样窗
// 侧链参数：本项目工程选择（剪映未公开任何数值）
const SC = {
  threshold: Number(argOf('--threshold', '0.12')), // 侧链触发阈值（线性幅度）
  ratio: Number(argOf('--ratio', '4')),            // 压缩比
  attack: Number(argOf('--attack', '20')),         // ms
  release: Number(argOf('--release', '250')),      // ms
  makeup: 1,                                       // 不补偿增益，避免把闪避抵消掉
};

function run(exe, argv) {
  return new Promise((resolve) => {
    // 注意：本机沙箱禁止 Node 用管道捕获子进程输出（AGENTS.md §2.3，EPERM）。
    // 因此这里一律用 stdio:'ignore'，ffmpeg 只落文件，不读 stdout/stderr。
    const p = spawn(exe, argv, { stdio: 'ignore', windowsHide: true });
    p.on('error', (e) => resolve({ code: -1, err: String(e?.message || e) }));
    p.on('close', (code) => resolve({ code, err: '' }));
  });
}

// ---- 最小 WAV 解析：取 PCM 采样，避免依赖管道/第三方库 ----
function readWavPcm16(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV: ' + file);
  }
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    off = body + size + (size % 2); // RIFF 偶数字节对齐
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 结构异常: ' + file);
  if (fmt.bits !== 16) throw new Error('只支持 16-bit PCM，实际 ' + fmt.bits);
  return { fmt, buf, dataOff, dataLen };
}

// 计算 [ss, ss+t) 窗口内的 RMS，返回 dBFS（与 ffmpeg volumedetect 的 mean_volume 同量纲）
function rmsDb(wav, ss, t) {
  const { fmt, buf, dataOff, dataLen } = wav;
  const bytesPerFrame = fmt.channels * 2;
  const totalFrames = Math.floor(dataLen / bytesPerFrame);
  const startF = Math.max(0, Math.floor(ss * fmt.sampleRate));
  const endF = Math.min(totalFrames, Math.floor((ss + t) * fmt.sampleRate));
  let sum = 0, n = 0;
  for (let f = startF; f < endF; f++) {
    for (let c = 0; c < fmt.channels; c++) {
      const v = buf.readInt16LE(dataOff + f * bytesPerFrame + c * 2) / 32768;
      sum += v * v;
      n++;
    }
  }
  if (!n) return null;
  const rms = Math.sqrt(sum / n);
  return Math.round(20 * Math.log10(rms <= 1e-12 ? 1e-12 : rms) * 10) / 10;
}

// 生成「类人声」测试信号：0–2s 有声、2–4s 静音、4–6s 有声、6–8s 静音
const VOICE_EXPR =
  "if(lt(mod(t\\,4)\\,2)\\,0.5*sin(2*PI*300*t)\\,0)";

function measure(file, [ss, ee]) {
  const wav = readWavPcm16(file);
  // 窗口是 [起, 止]（秒），rmsDb 需要的是时长
  return { mean: rmsDb(wav, ss, ee - ss), max: null };
}

function dbDiff(a, b) {
  if (a == null || b == null) return null;
  return Math.round((a - b) * 10) / 10;
}

async function main() {
  console.log('ffmpeg   :', FFMPEG);
  console.log('bgm      :', BGM);
  console.log('tmp      :', TMP);
  if (!fs.existsSync(BGM)) {
    console.error('BGM 不存在:', BGM);
    process.exit(2);
  }

  // 1) 生成测试人声轨
  let r = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc=${VOICE_EXPR}:s=44100:d=${DUR}`,
    '-c:a', 'pcm_s16le', VOICE]);
  if (r.code !== 0) { console.error('生成测试人声失败\n' + r.err); process.exit(3); }

  // 2) 取 BGM 前 8 秒（统一采样率/声道，避免测量偏差）
  r = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', BGM, '-t', String(DUR), '-ac', '2', '-ar', '44100',
    '-c:a', 'pcm_s16le', BGMS]);
  if (r.code !== 0) { console.error('提取 BGM 失败\n' + r.err); process.exit(3); }

  // 3) 基准：BGM 单独（不闪避）
  fs.copyFileSync(BGMS, PLAIN);

  // 4) 闪避：BGM 为主输入，测试人声为侧链
  //    apad + -t：sidechaincompress 的输出会比主输入略短（实测 8.000s → 7.895s），
  //    对齐时长后才好逐窗比较；真实流水线里同样需要补齐，否则成片会短一截。
  r = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', BGMS, '-i', VOICE,
    '-filter_complex',
    `[0:a][1:a]sidechaincompress=threshold=${SC.threshold}:ratio=${SC.ratio}:` +
    `attack=${SC.attack}:release=${SC.release}:makeup=${SC.makeup}[sc];[sc]apad[out]`,
    '-map', '[out]', '-t', String(DUR), '-c:a', 'pcm_s16le', DUCKED]);
  if (r.code !== 0) { console.error('闪避渲染失败（sidechaincompress 可能不可用）\n' + r.err); process.exit(4); }

  // 5) 测量
  const rows = [];
  for (const [label, file] of [['BGM 单独', PLAIN], ['闪避后', DUCKED]]) {
    const on = await measure(file, WIN_ON);
    const off = await measure(file, WIN_OFF);
    rows.push({ label, on, off, drop: dbDiff(on.mean, off.mean) });
  }

  console.log('\n窗口定义：人声段 %s–%ss，静音段 %s–%ss', WIN_ON[0], WIN_ON[1], WIN_OFF[0], WIN_OFF[1]);
  console.log('侧链参数：threshold=%s ratio=%s attack=%sms release=%sms makeup=%s',
    SC.threshold, SC.ratio, SC.attack, SC.release, SC.makeup);
  console.log('\n| 处理 | 人声段 mean | 静音段 mean | 人声段相对静音段 |');
  console.log('| --- | --- | --- | --- |');
  for (const x of rows) {
    console.log(`| ${x.label} | ${fmt(x.on.mean)} | ${fmt(x.off.mean)} | ${fmt(x.drop, ' dB')} |`);
  }

  const plain = rows[0], duck = rows[1];
  const extra = dbDiff(duck.on.mean, plain.on.mean);
  console.log('\n闪避带来的额外衰减（人声段）：%s', fmt(extra, ' dB'));

  // 判据（三态）：人声段相对静音段应当变低，且比不闪避时更低
  let verdict;
  if (extra == null) verdict = '未验证（测量失败）';
  else if (extra <= -1.5) verdict = '通过：闪避生效（人声段额外衰减 ≥1.5 dB）';
  else if (extra <= -0.5) verdict = '弱通过：有衰减但幅度小，需调阈值/比例';
  else verdict = '不通过：未见有效闪避';
  console.log('结论：%s', verdict);

  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } }
  else console.log('\n保留临时文件：' + TMP);

  // 退出码：不通过时非 0，便于脚本化验收
  process.exit(extra != null && extra <= -0.5 ? 0 : 1);
}

function fmt(v, suffix = ' dB') {
  return v == null ? '—' : `${v}${suffix}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
