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
    // 创建 concat 列表文件
    const listPath = outputPath + '.txt';
    const listContent = clips.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');

    try {
      const cmd = `"${FFMPEG_PATH}" -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
      execSync(cmd, { stdio: 'pipe' });
      fs.unlinkSync(listPath);
      return { success: true, outputPath };
    } catch (e) {
      // 如果 copy 失败，用滤镜重新编码
      try {
        const inputs = clips.map((c, i) => `-i "${c}"`).join(' ');
        const filterParts = clips.map((_, i) => `[${i}:v][${i}:a]`).join('');
        const cmd = `"${FFMPEG_PATH}" -y ${inputs} -filter_complex "${filterParts}concat=n=${clips.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" "${outputPath}"`;
        execSync(cmd, { stdio: 'pipe' });
        return { success: true, outputPath };
      } catch (e2) {
        return { success: false, error: e2.message };
      }
    }
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

  _makeLoopFFmpeg(inputPath, outputPath, fadeDuration) {
    // 原理：截取开头 fadeDuration 秒，和结尾做交叉淡出
    const cmd = `"${FFMPEG_PATH}" -y -i "${inputPath}" -filter_complex "[0]trim=end=${fadeDuration},setpts=PTS-STARTPTS[begin];[0]trim=start=${fadeDuration},setpts=PTS-STARTPTS[end];[end][begin]xfade=fade:duration=${fadeDuration}:offset=total_duration-${fadeDuration}" "${outputPath}"`;

    try {
      execSync(cmd, { stdio: 'pipe' });
      return { success: true, outputPath, fadeDuration };
    } catch (e) {
      // 失败的话直接复制原文件
      fs.copyFileSync(inputPath, outputPath);
      return { success: true, outputPath, note: '无缝循环处理失败，使用原文件', error: e.message };
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
