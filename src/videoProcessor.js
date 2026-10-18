// ==========================================
// 视频处理模块 - 基于 FFmpeg
// 功能：拼接、转码、无缝循环、提取帧
// ==========================================

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const config = require('../config');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// FFmpeg 路径（优先用配置的，其次系统 PATH）
const FFMPEG_PATH = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = config.FFPROBE_PATH || 'ffprobe';

class VideoProcessor {
  constructor() {
    this.hasFFmpeg = this._checkFFmpeg();
    console.log(`FFmpeg 可用: ${this.hasFFmpeg}`);
    if (this.hasFFmpeg && FFMPEG_PATH !== 'ffmpeg') {
      console.log(`FFmpeg 路径: ${FFMPEG_PATH}`);
    }
  }

  _checkFFmpeg() {
    try {
      execSync(`"${FFMPEG_PATH}" -version`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }

  // ===== 1. 拼接视频 =====
  async concatenate(clips, outputPath) {
    if (this.hasFFmpeg) {
      return this._concatenateFFmpeg(clips, outputPath);
    }
    return this._mockConcatenate(clips, outputPath);
  }

  _concatenateFFmpeg(clips, outputPath) {
    const listPath = outputPath + '.txt';
    const cleanup = () => {
      try { if (fs.existsSync(listPath)) fs.unlinkSync(listPath); } catch (e) {}
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
    };

    // 路径 1：-c copy 直拼（快）
    try {
      const listContent = clips.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(listPath, listContent, 'utf8');
      const cmd = `"${FFMPEG_PATH}" -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
      execSync(cmd, { stdio: 'pipe' });

      // 改动点 2：退出码为 0 不代表拼全了（输入损坏时会静默只拼出前几段），必须实测时长
      const v = this._validateConcatDuration(outputPath, clips);
      if (v.ok) {
        try { fs.unlinkSync(listPath); } catch (e) {}
        return { success: true, outputPath, durationCheck: v };
      }
      // 不可判定（探测不到时长）时不做重编码兜底：
      // 重编码同样无法校验结果，只会白白多花一次编码时间并可能覆盖可用产物。
      // 此时保留 copy 产物，但把 unverified 标记透传给上层，让质检如实记录「未验证」。
      if (v.undetermined) {
        console.warn('[concat] 时长不可判定，保留 copy 产物但标记未验证：' + v.reason);
        try { fs.unlinkSync(listPath); } catch (e) {}
        return { success: true, outputPath, durationCheck: v, unverified: true };
      }
      console.warn('[concat] copy 产物时长校验失败，改用重编码兜底：' + v.reason);
      cleanup();
    } catch (e) {
      cleanup();
    }

    // 路径 2：重编码直拼兜底
    try {
      const inputs = clips.map(c => `-i "${c}"`).join(' ');
      const filterParts = clips.map((_, i) => `[${i}:v][${i}:a]`).join('');
      const cmd = `"${FFMPEG_PATH}" -y ${inputs} -filter_complex "${filterParts}concat=n=${clips.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" "${outputPath}"`;
      execSync(cmd, { stdio: 'pipe' });

      const v = this._validateConcatDuration(outputPath, clips);
      if (v.ok) {
        return { success: true, outputPath, durationCheck: v, reencoded: true };
      }
      if (v.undetermined) {
        // 同上：重编码已完成但无法校验，保留产物并标记未验证，不谎报成功也不丢弃结果
        console.warn('[concat] 重编码后时长仍不可判定，保留产物但标记未验证：' + v.reason);
        return { success: true, outputPath, durationCheck: v, reencoded: true, unverified: true };
      }
      cleanup();
      return { success: false, error: '拼接产物时长校验失败: ' + v.reason };
    } catch (e2) {
      cleanup();
      return { success: false, error: '拼接失败: ' + e2.message };
    }
  }

  // 探测单个媒体时长（秒）；失败返回 0
  _probeDurationSec(mediaPath) {
    try {
      const cmd = `"${FFPROBE_PATH}" -v error -show_entries format=duration -of csv=p=0 "${mediaPath}"`;
      const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const d = parseFloat(String(out).trim());
      return isFinite(d) && d > 0 ? d : 0;
    } catch (e) {
      return 0;
    }
  }

  // 校验拼接产物时长 ≈ 各输入时长之和（容差 ±max(0.5s, 2%)）
  // 注意：探测失败不等于校验通过。输入时长全部探测失败时，本函数无法判断产物
  // 是否被截断，此时必须返回不可判定（ok:false + undetermined:true），由调用方
  // 决定回退重编码还是判失败 —— 绝不能悄悄当成「校验通过」放行。
  _validateConcatDuration(outputPath, clips) {
    let expected = 0;
    let probed = 0;
    for (const c of clips) {
      const d = this._probeDurationSec(c);
      if (d > 0) { expected += d; probed++; }
    }
    if (probed === 0 || expected <= 0) {
      return {
        ok: false,
        undetermined: true,
        reason: '无法探测任何输入片段时长，拼接完整性不可判定'
      };
    }
    const actual = this._probeDurationSec(outputPath);
    if (actual <= 0) {
      return { ok: false, reason: '无法探测拼接产物时长（产物可能损坏）' };
    }
    const tolerance = Math.max(0.5, expected * 0.02);
    const ok = Math.abs(actual - expected) <= tolerance;
    return {
      ok,
      actual: Math.round(actual * 100) / 100,
      expected: Math.round(expected * 100) / 100,
      tolerance: Math.round(tolerance * 100) / 100,
      reason: ok
        ? `时长校验通过 (${actual.toFixed(2)}s ≈ 期望 ${expected.toFixed(2)}s)`
        : `拼接被截断 (${actual.toFixed(2)}s，期望 ${expected.toFixed(2)}s，容差 ±${tolerance.toFixed(2)}s)`
    };
  }

  _mockConcatenate(clips, outputPath) {
    // Mock 模式：创建一个文本文件假装是拼接后的视频
    const content = `Mock Concatenated Video\nClips: ${clips.length}\nGenerated: ${new Date().toISOString()}\nClip list:\n${clips.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`;
    fs.writeFileSync(outputPath, content, 'utf8');
    return { success: true, outputPath, mock: true };
  }

  // ===== 2. 转码 =====
  async transcode(inputPath, outputPath, options = {}) {
    const resolution = options.resolution || '720p';
    const fps = options.fps || 30;
    const codec = options.codec || 'libx264';

    if (this.hasFFmpeg) {
      return this._transcodeFFmpeg(inputPath, outputPath, resolution, fps, codec);
    }
    return this._mockTranscode(inputPath, outputPath, resolution, fps);
  }

  _transcodeFFmpeg(inputPath, outputPath, resolution, fps, codec) {
    const sizeMap = {
      '480p': '854x480',
      '720p': '1280x720',
      '1080p': '1920x1080',
      '4K': '3840x2160'
    };
    const size = sizeMap[resolution] || '1280x720';
    const [width, height] = size.split('x');

    const cmd = `"${FFMPEG_PATH}" -y -i "${inputPath}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" -c:v ${codec} -crf 23 -preset medium -r ${fps} -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}"`;

    try {
      execSync(cmd, { stdio: 'pipe' });
      return { success: true, outputPath, resolution, fps };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _mockTranscode(inputPath, outputPath, resolution, fps) {
    const content = `Mock Transcoded Video\nResolution: ${resolution}\nFPS: ${fps}\nSource: ${inputPath}\nGenerated: ${new Date().toISOString()}`;
    fs.writeFileSync(outputPath, content, 'utf8');
    return { success: true, outputPath, resolution, fps, mock: true };
  }

  // ===== 3. 无缝循环（首尾帧交叉淡入淡出）=====
  async makeSeamlessLoop(inputPath, outputPath, fadeDuration = 1) {
    if (this.hasFFmpeg) {
      return this._makeLoopFFmpeg(inputPath, outputPath, fadeDuration);
    }
    return this._mockLoop(inputPath, outputPath, fadeDuration);
  }

  // 说明（清理无效语法）：
  // 原实现用 filter_complex 做首尾交叉淡化，但 xfade 的 offset 写成了
  // `offset=total_duration-${fadeDuration}`——total_duration 不是 ffmpeg 的合法表达式记号，
  // 所以 ffmpeg 每次都直接报错、落入 catch 的「复制原文件」兜底，实际等同于直通。
  //
  // 撤掉滤镜后没有再采用交叉淡化，原因有二：
  // 1) 真正的无缝循环必须把首尾重叠 fadeDuration 秒，成片会比拼接产物短 fadeDuration
  //    （35s → 34s），与产品「5 段 × 7s = 35s」的预期不符；
  // 2) 改配乐重建路径（pipeline._rebuildAfterBgmChange）不经过本步骤，
  //    若此处缩短时长，会造成「新建任务 34s / 重建任务 35s」的不一致。
  // 因此这里明确按直通处理，保证与重建路径产出一致。
  // 如后续确实需要无缝循环，请先确认接受「成片缩短 fadeDuration」，并同步给重建路径加上同一步骤。
  _makeLoopFFmpeg(inputPath, outputPath, fadeDuration) {
    try {
      fs.copyFileSync(inputPath, outputPath);
      return {
        success: true,
        outputPath,
        fadeDuration,
        passthrough: true,
        note: '无缝循环未实现，按直通处理（与重建路径保持一致的时长）'
      };
    } catch (e) {
      return { success: false, error: '循环处理失败: ' + e.message };
    }
  }

  _mockLoop(inputPath, outputPath, fadeDuration) {
    const content = `Mock Seamless Loop Video\nFade duration: ${fadeDuration}s\nSource: ${inputPath}\nGenerated: ${new Date().toISOString()}`;
    fs.writeFileSync(outputPath, content, 'utf8');
    return { success: true, outputPath, fadeDuration, mock: true };
  }

  // ===== 4. 提取帧 =====
  extractFrame(videoPath, frameTime, outputPath) {
    if (this.hasFFmpeg) {
      try {
        const cmd = `"${FFMPEG_PATH}" -y -ss ${frameTime} -i "${videoPath}" -vframes 1 "${outputPath}"`;
        execSync(cmd, { stdio: 'pipe' });
        return { success: true, outputPath };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    // Mock
    fs.writeFileSync(outputPath, 'Mock frame image', 'utf8');
    return { success: true, outputPath, mock: true };
  }

  // ===== 5. 获取视频信息（ffprobe）=====
  getVideoInfo(videoPath) {
    if (this.hasFFmpeg) {
      try {
        const cmd = `"${FFPROBE_PATH}" -v error -show_format -show_streams -of json "${videoPath}"`;
        const output = execSync(cmd, { encoding: 'utf8' });
        const info = JSON.parse(output);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        return {
          success: true,
          duration: parseFloat(info.format.duration),
          width: videoStream?.width,
          height: videoStream?.height,
          codec: videoStream?.codec_name,
          fps: videoStream?.r_frame_rate,
          bitrate: parseInt(info.format.bit_rate)
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    // Mock
    return {
      success: true,
      duration: 30,
      width: 1280,
      height: 720,
      codec: 'h264',
      fps: '30/1',
      bitrate: 5000000,
      mock: true
    };
  }
}

module.exports = new VideoProcessor();
