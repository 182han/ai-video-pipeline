// ==========================================
// 波形峰值生成（服务端 ffmpeg）
// ==========================================
// 背景：浏览器 Web Audio 的 decodeAudioData 在部分环境下不可用
// （无头浏览器、缺音频解码组件、企业策略限制等），会导致编辑器波形永远空白。
// 这里用服务端已有的 ffmpeg 把音频降采样成峰值数组，前端只负责画。
//
// 返回 { ok, buckets, peaks: number[0..255], durationSec }，并做两级缓存：
//   memCache（进程内） -> data/waveforms/<trackId>.json（跨重启）

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../../config');

const BUCKETS = 1600;        // 采样桶数：足够画满屏，体积小
const SAMPLE_RATE = 8000;    // 解码采样率：画包络足够
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'waveforms');
const memCache = new Map();

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 用 spawn 收集 stdout 的原始字节。
// 注意不能用 execFile：它默认按 utf8 解码 stdout，会把 s16le 二进制弄坏。
function decodeToPcm(filePath) {
  return new Promise((resolve) => {
    const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
    const args = ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
    let proc;
    try {
      proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: '无法启动 ffmpeg: ' + e.message });
    }
    const chunks = [];
    let errText = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { errText += c.toString(); if (errText.length > 8192) errText = errText.slice(-8192); });
    proc.on('error', (e) => finish({ ok: false, error: 'ffmpeg 进程错误: ' + e.message }));
    proc.on('close', () => {
      if (chunks.length === 0) return finish({ ok: false, error: 'ffmpeg 未输出音频数据: ' + (errText.slice(0, 200) || '未知原因') });
      finish({ ok: true, buf: Buffer.concat(chunks) });
    });
  });
}

// 从 s16le PCM 计算每桶最大值（0..255）
function pcmToPeaks(buf, buckets) {
  const totalSamples = Math.floor(buf.length / 2);
  if (totalSamples === 0) return [];
  const per = Math.max(1, Math.floor(totalSamples / buckets));
  const peaks = new Array(buckets);
  for (let i = 0; i < buckets; i++) {
    const start = i * per;
    const end = Math.min(start + per, totalSamples);
    let mx = 0;
    // 每桶内抽样，避免长音频遍历全部样本
    const step = Math.max(1, Math.floor((end - start) / 256));
    for (let j = start; j < end; j += step) {
      const v = buf.readInt16LE(j * 2);
      const a = v < 0 ? -v : v;
      if (a > mx) mx = a;
    }
    peaks[i] = Math.round((mx / 32768) * 255);
  }
  return peaks;
}

async function extractPeaks(trackId, filePath, buckets = BUCKETS) {
  // 一级缓存：内存
  const hit = memCache.get(trackId);
  if (hit && hit.buckets === buckets) return { ok: true, ...hit, cached: 'mem' };

  // 二级缓存：磁盘
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, trackId + '.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (saved && Array.isArray(saved.peaks) && saved.peaks.length === buckets) {
        memCache.set(trackId, saved);
        return { ok: true, ...saved, cached: 'disk' };
      }
    }
  } catch (e) { /* 缓存损坏就当没有 */ }

  if (!fs.existsSync(filePath)) return { ok: false, error: '音频文件不存在: ' + path.basename(filePath) };

  const dec = await decodeToPcm(filePath);
  if (!dec.ok) return { ok: false, error: dec.error };

  const peaks = pcmToPeaks(dec.buf, buckets);
  if (!peaks.length) return { ok: false, error: '音频为空' };

  const durationSec = Math.round((dec.buf.length / 2 / SAMPLE_RATE) * 100) / 100;
  const record = { buckets, peaks, durationSec };

  memCache.set(trackId, record);
  try { fs.writeFileSync(cacheFile, JSON.stringify(record), 'utf8'); } catch (e) { /* 写不进缓存不影响返回 */ }

  return { ok: true, ...record, cached: 'none' };
}

module.exports = { extractPeaks, BUCKETS, CACHE_DIR, memCache, ensureCacheDir };
