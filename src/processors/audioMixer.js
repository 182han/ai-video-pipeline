// ==========================================
// 配乐混音模块 - 音轨库管理 + FFmpeg 混音
// ==========================================
// 链路：loudnorm(I=-20) 响度归一 → aloop 无缝循环 → afade 2s 淡入淡出
// 音源授权：incompetech（CC BY 4.0，需署名 Kevin MacLeod）+ Pixabay（Content License 免署名）

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../../config');

const BGM_DIR = path.join(__dirname, '..', '..', 'assets', 'bgm');
const MANIFEST_PATH = path.join(BGM_DIR, 'manifest.json');

// 主题 → mood 自动匹配映射（track: "auto" 时按任务主题选曲）
const THEME_MOOD_MAP = {
  mountain: 'epic', ice: 'epic', glacier: 'epic', snow: 'epic',
  aurora: 'ethereal', space: 'ethereal', starry: 'ethereal', night: 'ethereal', galaxy: 'ethereal',
  ocean: 'nature', waterfall: 'nature', rain: 'nature', coast: 'nature', sea: 'nature', wave: 'nature',
  lake: 'calm', forest: 'calm', desert: 'calm', landscape: 'calm', meadow: 'calm', mist: 'calm'
};

let _manifestCache = null;

// 大标签（介质分类）：music 轻音乐 / ambient 环境音
// 目录 nature/ 自动归为 ambient，新增音轨必须显式传 category
function _inferCategory(track) {
  if (track.category) return track.category;
  return String(track.file || '').startsWith('nature/') ? 'ambient' : 'music';
}

function _saveManifest(tracks) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(tracks, null, 2), 'utf8');
  _manifestCache = tracks;
  return tracks;
}

function getTrackById(id) {
  return getManifest().find(t => t.id === id) || null;
}

function getManifest() {
  if (_manifestCache) return _manifestCache;
  try {
    _manifestCache = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    _manifestCache = [];
    console.error('读取配乐清单失败:', e.message);
  }
  return _manifestCache;
}

// 按 mood / category 过滤音轨（参数可为空，返回全部）
function listTracks(mood, category) {
  let tracks = getManifest();
  if (mood) tracks = tracks.filter(t => (t.mood || []).some(m => m === mood));
  if (category) tracks = tracks.filter(t => _inferCategory(t) === category);
  return tracks;
}

// 公开展示用：补上 category 大标签（music/ambient）
function toPublicTracks(mood, category) {
  return listTracks(mood, category).map(t => ({ ...t, category: _inferCategory(t) }));
}

// 按 id 找音轨，返回 { track, filePath }
function findTrack(trackId) {
  const track = getManifest().find(t => t.id === trackId);
  if (!track) return null;
  return { track, filePath: path.join(BGM_DIR, track.file) };
}

// 按主题关键词自动匹配 mood → 随机取一首（track: "auto"）
function matchTrackByTheme(theme) {
  const key = String(theme || '').toLowerCase();
  let mood = null;
  for (const [kw, m] of Object.entries(THEME_MOOD_MAP)) {
    if (key.includes(kw)) { mood = m; break; }
  }
  const pool = listTracks(mood || 'calm');
  if (pool.length === 0) return null;
  const track = pool[Math.floor(Math.random() * pool.length)];
  return { track, filePath: path.join(BGM_DIR, track.file) };
}

// 解析音轨参数：trackId | 'auto' | 空 → 返回 { track, filePath }
function resolveTrack(trackArg, theme) {
  if (!trackArg || trackArg === 'auto') {
    return matchTrackByTheme(theme || 'landscape');
  }
  return findTrack(trackArg);
}

// ffprobe 探测媒体时长（秒）
function probeDuration(mediaPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = config.FFPROBE_PATH || 'ffprobe';
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath], (err, stdout) => {
      if (err) return reject(err);
      const dur = parseFloat(String(stdout).trim());
      if (isNaN(dur)) return reject(new Error('无法解析时长: ' + mediaPath));
      resolve(dur);
    });
  });
}

// ===== 混音产物校验（P0-1）=====
// 背景：ffmpeg 混音即使产出静音文件，退出码仍为 0（"静默成功"），
// 因此必须对产物做实测校验，不能只看退出码。
// loudnorm 目标 -20 LUFS，正常配乐 mean_volume 远高于 -85 dB；低于该值即视为静音。
const SILENCE_DB = -85;

// 探测媒体是否含音频流
function probeHasAudioStream(mediaPath) {
  return new Promise((resolve) => {
    const ffprobe = config.FFPROBE_PATH || 'ffprobe';
    execFile(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mediaPath], (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout || '').trim().length > 0);
    });
  });
}

// 探测平均音量（dB；纯静音为 -inf）；失败返回 null
function probeMeanVolume(mediaPath) {
  return new Promise((resolve) => {
    const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
    execFile(ffmpeg, ['-hide_banner', '-i', mediaPath, '-af', 'volumedetect', '-f', 'null', '-'], (err, stdout, stderr) => {
      const out = String(stderr || '') + '\n' + String(stdout || '');
      const m = out.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
      resolve(m ? m[1] : null);
    });
  });
}

// 清理残缺产物（失败时不留坏文件）
function cleanupFile(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
}

// 校验混音产物：存在 + 体积正常 + 有音频流 + 非静音
async function validateMixedOutput(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: '产物不存在' };
  const size = fs.statSync(filePath).size;
  if (size < 10240) return { ok: false, reason: `产物过小(${size}B)` };

  const hasAudio = await probeHasAudioStream(filePath);
  if (!hasAudio) return { ok: false, reason: '产物无音频流' };

  const mean = await probeMeanVolume(filePath);
  if (mean === null) return { ok: false, reason: '无法探测音量' };
  const db = String(mean).toLowerCase() === '-inf' ? -Infinity : parseFloat(mean);
  if (!isFinite(db) || db <= SILENCE_DB) {
    return { ok: false, reason: `产物静音 (mean_volume=${mean} dB)` };
  }
  return { ok: true, meanVolume: mean };
}

// 配乐混音：给成片叠加 BGM
// opts: { track: trackId|'auto', theme, loudness, fadeSeconds, onProgress }
// 返回: { success, outputPath, trackId, trackTitle, mood, videoDurationSec }
async function mixBgm(inputVideo, outputPath, opts = {}) {
  const { track: trackArg = 'auto', theme = '', loudness = -20, fadeSeconds = 2 } = opts;
  const resolved = resolveTrack(trackArg, theme);
  if (!resolved) {
    return { success: false, error: '配乐库存为空，请先入库音源' };
  }
  if (!fs.existsSync(resolved.filePath)) {
    return { success: false, error: `音轨文件不存在: ${resolved.track.file}` };
  }

  const videoDuration = await probeDuration(inputVideo);
  const fade = Math.min(fadeSeconds, videoDuration / 4);
  const fadeOutStart = Math.max(0, videoDuration - fade);
  // P0-1 修复：aloop 的 size 以「样本数」计，必须与 aloop 实际输入采样率一致。
  // loudnorm 会把流重采样（实测输出 192000 Hz），若 aloop 仍按 44100 Hz 硬编码 size=88200，
  // 窗口会缩到 0.46 秒并整段落在 loudnorm 的开头静音里 → 产物静音。
  // 因此在 loudnorm 之后显式把采样率拨回 44100，再按 2 秒样本循环，使 size 与采样率解耦失效。
  const TARGET_SAMPLE_RATE = 44100;
  const loopSize = Math.round(2 * TARGET_SAMPLE_RATE);

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats_period', '1',
    '-i', inputVideo, '-i', resolved.filePath,
    '-filter_complex',
    `[1:a]loudnorm=I=${loudness}:TP=-1.5:LRA=11,aformat=sample_rates=${TARGET_SAMPLE_RATE},` +
    `aloop=loop=-1:size=${loopSize},` +
    `afade=t=in:st=0:d=${fade},afade=t=out:st=${fadeOutStart}:d=${fade}[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac',
    '-t', String(videoDuration),
    '-movflags', '+faststart',
    outputPath
  ];

  return new Promise((resolve) => {
    const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
    const proc = execFile(ffmpeg, args, { maxBuffer: 10 * 1024 * 1024 }, async (err) => {
      if (err) {
        cleanupFile(outputPath);
        resolve({ success: false, error: '混音失败: ' + err.message });
      } else {
        // P0-1：退出码为 0 也可能产出静音，必须实测校验后才算成功
        const check = await validateMixedOutput(outputPath);
        if (!check.ok) {
          cleanupFile(outputPath);
          resolve({ success: false, error: '混音产物校验未通过: ' + check.reason });
        } else {
          resolve({
            success: true,
            outputPath,
            trackId: resolved.track.id,
            trackTitle: resolved.track.title,
            mood: resolved.track.mood,
            videoDurationSec: videoDuration,
            meanVolumeDb: check.meanVolume
          });
        }
      }
    });

    // 解析 stderr 中的 time= 进度
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const m = stderrBuf.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
      if (m && m.length > 0 && typeof opts.onProgress === 'function') {
        const last = m[m.length - 1];
        const parts = last.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (parts) {
          const sec = parseInt(parts[1], 10) * 3600 + parseInt(parts[2], 10) * 60 + parseFloat(parts[3]);
          opts.onProgress(Math.min(100, Math.round((sec / videoDuration) * 100)));
        }
      }
      if (stderrBuf.length > 10240) stderrBuf = stderrBuf.slice(-10240);
    });
  });
}

// ===== 配乐库存管理（上传/编辑/删除） =====
const CUSTOM_DIR = path.join(BGM_DIR, 'custom');
const ALLOWED_EXT = ['.mp3', '.wav', '.m4a', '.ogg'];

function _genId() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 3);
}

// 上传入库：fileData 为 base64 dataUrl 或裸 base64，写入 custom/ 目录 + append manifest
function addTrack(data = {}) {
  if (!data.fileData || !String(data.fileData).trim()) return { success: false, error: '缺少音频文件' };
  const raw = String(data.fileData);
  const m = /^data:audio\/[a-zA-Z0-9+.]+;base64,(.*)$/.exec(raw);
  const body = m ? m[1] : raw;
  const name = String(data.fileName || '');
  const nameExt = name ? path.extname(name).toLowerCase() : '';
  const ext = (nameExt && ALLOWED_EXT.includes(nameExt)) ? nameExt : '.mp3';
  if (!ALLOWED_EXT.includes(ext)) return { success: false, error: '仅支持 mp3/wav/m4a/ogg 格式' };

  if (!fs.existsSync(CUSTOM_DIR)) fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  const id = _genId();
  const rel = 'custom/' + id + ext;
  fs.writeFileSync(path.join(BGM_DIR, rel), Buffer.from(body, 'base64'));

  const track = {
    id,
    file: rel,
    title: data.title ? String(data.title).trim() : '未命名音轨',
    author: data.author ? String(data.author).trim() : '',
    source: data.source ? String(data.source).trim() : '自定义',
    sourceUrl: data.sourceUrl ? String(data.sourceUrl).trim() : '',
    license: data.license ? String(data.license).trim() : '',
    licenseUrl: data.licenseUrl ? String(data.licenseUrl).trim() : '',
    category: data.category === 'ambient' ? 'ambient' : 'music',
    mood: Array.isArray(data.mood) ? data.mood.filter(Boolean) : [],
    durationSec: Number(data.durationSec) || 0,
    bpm: data.bpm ? Number(data.bpm) : null,
    instruments: data.instruments ? String(data.instruments).trim() : '',
    note: data.note ? String(data.note).trim() : ''
  };
  const tracks = getManifest();
  tracks.push(track);
  _saveManifest(tracks);
  return { success: true, track };
}

function updateTrack(id, fields = {}) {
  const tracks = getManifest();
  const t = tracks.find(x => x.id === id);
  if (!t) return { success: false, error: '音轨不存在' };
  ['title', 'author', 'source', 'sourceUrl', 'license', 'licenseUrl', 'instruments', 'note'].forEach(k => {
    if (fields[k] !== undefined) t[k] = String(fields[k]).trim();
  });
  if (fields.category !== undefined) t.category = fields.category === 'ambient' ? 'ambient' : 'music';
  if (fields.mood !== undefined) t.mood = Array.isArray(fields.mood) ? fields.mood.filter(Boolean) : t.mood;
  if (fields.bpm !== undefined) t.bpm = fields.bpm ? Number(fields.bpm) : null;
  if (fields.durationSec !== undefined) t.durationSec = Number(fields.durationSec) || t.durationSec;
  _saveManifest(tracks);
  return { success: true, track: t };
}

function removeTrack(id) {
  const tracks = getManifest();
  const t = tracks.find(x => x.id === id);
  if (!t) return { success: false, error: '音轨不存在' };
  // 仅删除自定义上传文件，内置音轨保留磁盘文件
  if (String(t.file).startsWith('custom/')) {
    const abs = path.join(BGM_DIR, t.file);
    if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (e) {} }
  }
  _saveManifest(tracks.filter(x => x.id !== id));
  return { success: true };
}

module.exports = { getManifest, listTracks, toPublicTracks, findTrack, matchTrackByTheme, resolveTrack, getTrackById, addTrack, updateTrack, removeTrack, probeDuration, probeMeanVolume, validateMixedOutput, mixBgm, BGM_DIR, THEME_MOOD_MAP };
