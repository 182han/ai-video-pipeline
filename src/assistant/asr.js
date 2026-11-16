// ==========================================
// 小智 · 离线语音识别（P5）
// ------------------------------------------------------------
// 已定产品决策（handoff §7）：语音＝离线 ASR（已装）+ 失败回退打字。
// 工具与模型：tools/asr（sherpa-onnx v2.0.1 + SenseVoice int8，Apache-2.0）。
//
// 两个必须处理的坑（tools/asr/README.md 实测记录）：
//   1) sherpa CLI **不认非 ASCII 路径**（本仓库路径含「测试」）→ 用 ASCII junction
//      指向工具目录与临时目录，只把 junction 路径传给 CLI；
//   2) 本机子进程「捕获 stdout」的管道会 EPERM（AGENTS §2.3）→ 一律把 stdout/stderr
//      重定向到文件（stdio: ['ignore', fd, fd]），跑完读文件，不用 pipe。
//
// 本模块不联网、不计费；音频与识别文本都只在本地临时目录里，结束即删。
// 音频大小 / 时长有上限（默认 12MB / 60 秒），超限直接拒绝，不做静默截断。
// ==========================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const proc = require('./proc');

const ASR_VERSION = 'assistant-asr.v1';
const APP_DIR = path.join(__dirname, '..', '..');

const TOOLS_DIR = process.env.ASR_DIR
  ? path.resolve(process.env.ASR_DIR)
  : path.join(APP_DIR, 'tools', 'asr');
const BIN_DIR = path.join(TOOLS_DIR, 'sherpa-win', 'sherpa-onnx-v2.0.1-win-x64-shared-MD-Release-no-tts', 'bin');
const EXE = path.join(BIN_DIR, 'sherpa-onnx-offline.exe');
const MODEL_DIR = path.join(TOOLS_DIR, 'model-sensevoice-int8');
const MODEL = path.join(MODEL_DIR, 'model.int8.onnx');
const TOKENS = path.join(MODEL_DIR, 'tokens.txt');

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_SECONDS = 60;
const MAX_TEXT_CHARS = 800;

const DATA_TMP = proc.TMP_DIR;

const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac'
};

function status() {
  const exeOk = fs.existsSync(EXE);
  const modelOk = fs.existsSync(MODEL) && fs.existsSync(TOKENS);
  return {
    version: ASR_VERSION,
    available: exeOk && modelOk,
    engine: 'sherpa-onnx',
    model: 'sensevoice-int8',
    license: 'Apache-2.0',
    exe: exeOk ? EXE : null,
    reason: exeOk && !modelOk ? '模型文件缺失（tools/asr/model-sensevoice-int8）'
      : (!exeOk ? '未找到 sherpa-onnx（按 tools/asr/README.md 恢复）' : null),
    limits: { maxBytes: MAX_BYTES, maxSeconds: MAX_SECONDS },
    requiresNetwork: false,
    note: '完全离线；路径含非 ASCII 时用 junction 兜底'
  };
}

function ffmpegPath() {
  const config = require('../../config');
  return config.FFMPEG_PATH;
}

function ffprobePath() {
  const config = require('../../config');
  return config.FFPROBE_PATH;
}

function stamp() {
  return Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// 用 ASCII junction 把含中文的真实目录暴露成纯 ASCII 路径（Windows junction 不需要管理员权限）。
// 每次调用一个唯一链接，用完删除；并发安全。
function makeAsciiJunction(target, tag) {
  const link = path.join(os.tmpdir(), `xza-${tag}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.symlinkSync(target, link, 'junction');
  return link;
}

function safeRemove(link) {
  try { fs.unlinkSync(link); } catch (e) {
    try { fs.rmdirSync(link); } catch (e2) { /* 目录非空/已删都忽略 */ }
  }
}

// 用文件描述符接 stdout/stderr（proc.runToFiles：避开本机 pipe EPERM）。
const runToFiles = proc.runToFiles;

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

function decodeAudio(payload = {}) {
  if (payload && Buffer.isBuffer(payload.buffer)) return payload.buffer;
  if (payload && typeof payload.base64 === 'string' && payload.base64.trim()) {
    // 允许带 data:audio/...;base64, 前缀
    const b64 = payload.base64.replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(b64, 'base64');
  }
  return null;
}

function extOf(payload = {}) {
  const mime = String(payload.mime || payload.mimeType || '').toLowerCase();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const name = String(payload.fileName || payload.filePath || '');
  const m = name.match(/\.(webm|ogg|wav|mp3|m4a|flac)$/i);
  return m ? m[1].toLowerCase() : 'webm';
}

/**
 * 把音频转写成文字。
 * @param {object} payload { base64?, buffer?, filePath?, mime?, timeoutMs? }
 * @returns {Promise<{ok:true,text:string,lang:string|null,ms:number}|{ok:false,code:string,error:string}>}
 */
async function transcribe(payload = {}) {
  const st = status();
  if (!st.available) return fail('ASR_UNAVAILABLE', st.reason || '离线语音不可用');

  let inputBuffer = decodeAudio(payload);
  let willCopyFile = null;
  if (!inputBuffer) {
    if (payload.filePath && fs.existsSync(payload.filePath)) willCopyFile = payload.filePath;
    else return fail('ASR_NO_AUDIO', '没有收到音频数据（需要 base64 / buffer / filePath 之一）');
  }
  if (inputBuffer && inputBuffer.length > MAX_BYTES) {
    return fail('ASR_TOO_LARGE', `音频超过 ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB 上限`);
  }
  if (inputBuffer && inputBuffer.length < 512) {
    return fail('ASR_TOO_SHORT', '音频太短（少于 0.1 秒），再按一次试试');
  }

  const t0 = Date.now();
  const workTag = stamp();
  let asrLink = null;
  let dataLink = null;
  let workReal = null;
  try {
    fs.mkdirSync(DATA_TMP, { recursive: true });
    // 数据目录也走 ASCII junction，避免 ffmpeg/sherpa 遇到中文路径
    dataLink = makeAsciiJunction(DATA_TMP, 'data');
    const workAscii = path.join(dataLink, `job-${workTag}`);
    fs.mkdirSync(workAscii, { recursive: true });
    workReal = path.join(DATA_TMP, `job-${workTag}`);
    fs.mkdirSync(workReal, { recursive: true });

    const ext = willCopyFile ? path.extname(willCopyFile).replace(/^\./, '') || extOf(payload) : extOf(payload);
    const inAscii = path.join(workAscii, `in.${ext}`);
    if (willCopyFile) {
      fs.copyFileSync(willCopyFile, inAscii);
    } else {
      fs.writeFileSync(inAscii, inputBuffer);
    }
    const bytes = fs.statSync(inAscii).size;
    if (bytes > MAX_BYTES) return fail('ASR_TOO_LARGE', `音频超过 ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB 上限`);

    // 1) 探时长（上限 60 秒；超限明确拒绝，不截断后假装识别完整）
    const probe = runToFiles(ffprobePath(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inAscii
    ], { timeoutMs: 30000 });
    const dur = parseFloat((probe.stdout || '').trim());
    if (!Number.isFinite(dur) || dur <= 0) {
      return fail('ASR_BAD_AUDIO', '读不出音频时长（文件可能损坏或不是音频）',
        { detail: (probe.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' ') });
    }
    if (dur > MAX_SECONDS + 0.5) {
      return fail('ASR_TOO_LONG', `语音时长为 ${dur.toFixed(1)} 秒，超过 ${MAX_SECONDS} 秒上限；请分段说。`);
    }

    // 2) 统一转成 16kHz 单声道 wav
    const wavAscii = path.join(workAscii, 'audio.wav');
    const conv = runToFiles(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', inAscii,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavAscii
    ], { timeoutMs: 60000 });
    if (conv.status !== 0 || !fs.existsSync(wavAscii) || fs.statSync(wavAscii).size < 1024) {
      return fail('ASR_BAD_AUDIO', '音频转码失败（格式不支持或文件损坏）',
        { detail: (conv.stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' ') });
    }

    // 3) sherpa 识别（工具目录也走 junction；CLI 不认中文路径）
    asrLink = makeAsciiJunction(TOOLS_DIR, 'tool');
    const exeAscii = path.join(asrLink, 'sherpa-win', 'sherpa-onnx-v2.0.1-win-x64-shared-MD-Release-no-tts', 'bin', 'sherpa-onnx-offline.exe');
    const modelAscii = path.join(asrLink, 'model-sensevoice-int8', 'model.int8.onnx');
    const tokensAscii = path.join(asrLink, 'model-sensevoice-int8', 'tokens.txt');
    const r = runToFiles(exeAscii, [
      '--tokens=' + tokensAscii,
      '--sense-voice-model=' + modelAscii,
      '--sense-voice-use-itn=1',
      '--num-threads=1',
      wavAscii
    ], { cwd: path.dirname(exeAscii), timeoutMs: Number(payload.timeoutMs) || 120000 });

    if (r.error === 'EPERM') return fail('ASR_SPAWN_DENIED', '本机不允许启动子进程（EPERM），请改用打字输入');
    if (r.status !== 0) {
      return fail('ASR_FAILED', '离线识别进程失败',
        { detail: (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' ') });
    }

    // 输出是一行 JSON（SenseVoice）；取最后一行能解析的对象。
    let parsed = null;
    for (const line of String(r.stdout || '').split(/\r?\n/).reverse()) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try { parsed = JSON.parse(s); break; } catch (e) { /* 下一行 */ }
    }
    if (!parsed || typeof parsed.text !== 'string') {
      return fail('ASR_BAD_OUTPUT', '识别结果不是预期格式',
        { detail: String(r.stdout || '').slice(0, 200) });
    }
    const text = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
    return {
      ok: true,
      text,
      empty: text.length === 0,
      lang: typeof parsed.lang === 'string' ? parsed.lang.replace(/[<>|]/g, '') : null,
      emotion: typeof parsed.emotion === 'string' ? parsed.emotion.replace(/[<>|]/g, '') : null,
      durationSec: Math.round(dur * 1000) / 1000,
      ms: Date.now() - t0,
      version: ASR_VERSION,
      offline: true
    };
  } catch (e) {
    return fail('ASR_ERROR', '语音识别异常：' + (e && e.message ? e.message : String(e)));
  } finally {
    try { if (workReal) fs.rmSync(workReal, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (asrLink) safeRemove(asrLink);
    if (dataLink) safeRemove(dataLink);
  }
}

module.exports = {
  ASR_VERSION,
  MAX_BYTES,
  MAX_SECONDS,
  TOOLS_DIR,
  EXE,
  MODEL,
  status,
  transcribe,
  _runToFiles: runToFiles
};
