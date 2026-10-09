// ==========================================
// Mock 视频生成器 - 用于演示和测试
// 用 FFmpeg 生成真实的小样片，整条流水线可完整跑通
// ==========================================

const BaseGenerator = require('./base');
const fs = require('fs');
const path = require('path');
const videoProcessor = require('../videoProcessor');

class MockGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'mock';
    this.supportedOptions = {
      maxDuration: 30,
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1']
    };
    this._tasks = {};
    this._outputDir = path.join(__dirname, '..', '..', 'clips');
    this._sampleDir = path.join(__dirname, '..', '..', 'clips', '_samples');
    this._failRate = config.failRate || 0.1; // 10% 失败率（模拟）
    this._genTime = config.genTime || 1500; // 生成耗时（毫秒）
    this._sampleCache = {}; // 缓存样片路径
  }

  async generate(prompt, options = {}) {
    const taskId = 'mock_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);

    // 模拟异步生成
    this._tasks[taskId] = {
      status: 'processing',
      prompt,
      options,
      startTime: Date.now()
    };

    // 模拟生成过程
    setTimeout(() => {
      const task = this._tasks[taskId];
      if (!task) return;

      // 模拟失败率
      if (Math.random() < this._failRate) {
        task.status = 'failed';
        task.error = '模拟失败：rate limit exceeded';
        return;
      }

      // 生成成功，产出真实视频文件
      task.status = 'completed';
      task.videoUrl = this._createMockVideo(taskId, options);
    }, this._genTime);

    return { taskId, status: 'pending' };
  }

  async getStatus(taskId) {
    const task = this._tasks[taskId];
    if (!task) {
      return { status: 'failed', error: '任务不存在' };
    }
    return {
      status: task.status,
      videoUrl: task.videoUrl || null,
      error: task.error || null
    };
  }

  // 创建模拟视频 - 如果 FFmpeg 可用就生成真实样片，否则用文本占位
  _createMockVideo(taskId, options) {
    if (!fs.existsSync(this._outputDir)) {
      fs.mkdirSync(this._outputDir, { recursive: true });
    }
    const filePath = path.join(this._outputDir, `${taskId}.mp4`);
    const duration = options.duration || 30;
    const resolution = options.resolution || '720p';

    // FFmpeg 不可用时退回文本占位
    if (!videoProcessor.hasFFmpeg) {
      const content = `Mock Video\nTask: ${taskId}\nDuration: ${duration}s\nResolution: ${resolution}\nGenerated: ${new Date().toISOString()}`;
      fs.writeFileSync(filePath, content, 'utf8');
      return filePath;
    }

    // 用样片缓存避免重复生成
    const sampleKey = `${resolution}_${duration}s`;
    const samplePath = path.join(this._sampleDir, `sample_${sampleKey}.mp4`);

    // 如果缓存样片不存在，先生成
    if (!this._sampleCache[sampleKey] && !fs.existsSync(samplePath)) {
      this._generateSampleClip(samplePath, duration, resolution);
    }
    this._sampleCache[sampleKey] = true;

    // 复制样片到目标路径
    try {
      fs.copyFileSync(samplePath, filePath);
    } catch (e) {
      // 复制失败就用文本占位
      const content = `Mock Video\nTask: ${taskId}\nDuration: ${duration}s`;
      fs.writeFileSync(filePath, content, 'utf8');
    }

    return filePath;
  }

  // 用 FFmpeg 生成一个真实的测试样片（渐变色 + 静音）
  _generateSampleClip(outputPath, duration, resolution) {
    const { execSync } = require('child_process');
    const config = require('../../config');
    const ffmpegPath = config.FFMPEG_PATH || 'ffmpeg';

    if (!fs.existsSync(this._sampleDir)) {
      fs.mkdirSync(this._sampleDir, { recursive: true });
    }

    // 解析分辨率
    let width = 1280, height = 720;
    if (resolution === '1080p') { width = 1920; height = 1080; }
    else if (resolution === '480p') { width = 854; height = 480; }

    try {
      // 生成明亮蓝色背景 + 静音的测试视频（明显看出是测试视频，不是黑屏）
      execSync(`"${ffmpegPath}" -y -f lavfi -i "color=c=0x4a90d9:s=${width}x${height}:d=${duration}" -f lavfi -i "anullsrc=r=44100:cl=stereo:d=${duration}" -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"`, {
        stdio: 'pipe',
        timeout: 30000
      });
      return true;
    } catch (e) {
      console.warn('[MockGenerator] FFmpeg 样片生成失败，使用文本占位:', e.message?.substring(0, 100));
      return false;
    }
  }
}

module.exports = MockGenerator;
