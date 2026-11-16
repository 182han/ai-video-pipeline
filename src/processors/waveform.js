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
// 跟随 DATA_DIR：测试/部署换数据目录时波形缓存也隔离，不再写死 app/data/waveforms
const CACHE_DIR = path.join(path.dirname(config.STORAGE.dataDir), 'waveforms');
const memCache = new Map();

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 解出 s16le PCM。
// 不用管道读 stdout：本环境 pipe 会 spawn EPERM（AGENTS §4.6：读输出的 ffmpeg 必须走
// 「落临时文件再读」降级），因此统一让 ffmpeg 直接写临时 pcm 文件，再读文件。
const os = require('os');
function decodeToPcm(filePath) {
  return new Promise((resolve) => {
    const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
    const base = path.join(os.tmpdir(), `wf_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const pcmPath = base + '.pcm';
    const errPath = base + '.err';
    let outFd = null;
    let errFd = null;
    const cleanup = () => {
      try { if (outFd !== null) fs.closeSync(outFd); } catch (e) { /* ignore */ }
      try { if (errFd !== null) fs.closeSync(errFd); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(pcmPath); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(errPath); } catch (e) { /* ignore */ }
    };
    try {
      outFd = fs.openSync(pcmPath, 'w');
      errFd = fs.openSync(errPath, 'w');
    } catch (e) {
      cleanup();
      return resolve({ ok: false, error: '无法创建临时文件: ' + e.message });
    }
    const args = ['-y', '-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', pcmPath];
    let proc;
    try {
      proc = spawn(ffmpeg, args, { stdio: ['ignore', outFd, errFd] });
    } catch (e) {
      cleanup();
      return resolve({ ok: false, error: '无法启动 ffmpeg: ' + e.message });
    }
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } };
    proc.on('error', (e) => finish({ ok: false, error: 'ffmpeg 进程错误: ' + e.message }));
    proc.on('close', (code) => {
      let buf = null;
      let errText = '';
      try { buf = fs.readFileSync(pcmPath); } catch (e) { /* ignore */ }
      try { errText = fs.readFileSync(errPath, 'utf8').slice(0, 400); } catch (e) { /* ignore */ }
      if (!buf || buf.length === 0) {
        return finish({ ok: false, error: 'ffmpeg 未输出音频数据: ' + (errText.slice(0, 200) || ('exit=' + code)) });
      }
      finish({ ok: true, buf });
    });
  });
}

// 音频文件的指纹：文件改了（替换/重下）就作废旧缓存
function sourceSig(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { mtimeMs: Math.round(st.mtimeMs), size: st.size };
  } catch (e) { return null; }
}
function cacheValid(saved, buckets, sig) {
  return !!saved && Array.isArray(saved.peaks) && saved.peaks.length === buckets
    && !!sig && !!saved.source && saved.source.mtimeMs === sig.mtimeMs && saved.source.size === sig.size;
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
  if (!fs.existsSync(filePath)) return { ok: false, error: '音频文件不存在: ' + path.basename(filePath) };
  const sig = sourceSig(filePath);

  // 一级缓存：内存（文件指纹变了就作废）
  const hit = memCache.get(trackId);
  if (cacheValid(hit, buckets, sig)) return { ok: true, ...hit, cached: 'mem' };

  // 二级缓存：磁盘
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, trackId + '.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cacheValid(saved, buckets, sig)) {
        memCache.set(trackId, saved);
        return { ok: true, ...saved, cached: 'disk' };
      }
    }
  } catch (e) { /* 缓存损坏就当没有 */ }

  const dec = await decodeToPcm(filePath);
  if (!dec.ok) return { ok: false, error: dec.error };

  const peaks = pcmToPeaks(dec.buf, buckets);
  if (!peaks.length) return { ok: false, error: '音频为空' };

  const durationSec = Math.round((dec.buf.length / 2 / SAMPLE_RATE) * 100) / 100;
  const record = { buckets, peaks, durationSec, source: sig };

  memCache.set(trackId, record);
  try { fs.writeFileSync(cacheFile, JSON.stringify(record), 'utf8'); } catch (e) { /* 写不进缓存不影响返回 */ }

  return { ok: true, ...record, cached: 'none' };
}

module.exports = { extractPeaks, BUCKETS, CACHE_DIR, memCache, ensureCacheDir };
