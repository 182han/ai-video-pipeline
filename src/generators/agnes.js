// ==========================================
// Agnes AI (Pavo) 视频生成器适配器
// 官方文档: https://wiki.agnes-ai.com/
// 免费视频模型: agnes-video-2.5, agnes-video-2.5-flash
// ==========================================

const BaseGenerator = require('./base');
const fs = require('fs');
const path = require('path');

class AgnesGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'agnes';
    this.apiKey = config.apiKey || process.env.AGNES_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://apihub.agnes-ai.com/v1';
    this.modelId = config.modelId || 'agnes-video-2.5';
    // 根据 baseUrl 推导查询地址（把 /v1 换成 /agnesapi）
    this.queryUrl = this.baseUrl.replace(/\/v1\/?$/, '/agnesapi');
    this.supportedOptions = {
      maxDuration: 12,
      resolutions: ['720P', '1080P', '1K', '2K'],
      aspectRatios: ['16:9', '9:16', '1:1', '21:9']
    };
    // 轮询配置
    this.pollInterval = 2000; // 2秒轮询一次
    this.maxPollTime = 300000; // 最长5分钟
  }

  async generate(prompt, options = {}) {
    if (!this.apiKey) {
      throw new Error('Agnes AI API Key 未配置，请在设置中填写');
    }

    const duration = options.duration || 5;
    const size = this._mapResolution(options.resolution || '720p');
    const aspectRatio = options.aspectRatio || '16:9';

    const body = {
      model: this.modelId,
      prompt,
      seconds: String(duration),
      mode: 'text',
      size,
      aspect_ratio: aspectRatio
    };

    if (options.seed) {
      body.seed = options.seed;
    }

    const response = await fetch(`${this.baseUrl}/videos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.error?.message || data.error || JSON.stringify(data);
      throw new Error(`Agnes API 错误 (${response.status}): ${errorMsg}`);
    }

    return {
      taskId: data.video_id || data.id,
      status: this._mapStatus(data.status),
      video_id: data.video_id
    };
  }

  async getStatus(taskId) {
    if (!this.apiKey) {
      return { status: 'failed', error: 'API Key 未配置' };
    }

    try {
      const url = `${this.queryUrl}?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(this.modelId)}`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.error?.message || data.error || `HTTP ${response.status}`;
        return { status: 'failed', error: errorMsg };
      }

      const status = this._mapStatus(data.status);
      const result = {
        status,
        progress: data.progress || 0,
        error: null
      };

      if (status === 'completed' && data.metadata?.url) {
        result.videoUrl = data.metadata.url;
      }

      if (status === 'failed' && data.error) {
        result.error = typeof data.error === 'string' ? data.error : data.error.message || '生成失败';
      }

      return result;
    } catch (e) {
      return { status: 'failed', error: e.message };
    }
  }

  // 下载视频到本地
  async downloadVideo(videoUrl, outputPath) {
    try {
      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`下载失败: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(outputPath, buffer);
      return outputPath;
    } catch (e) {
      throw new Error(`下载视频失败: ${e.message}`);
    }
  }

  // 内部方法：映射分辨率
  _mapResolution(res) {
    const map = {
      '480p': '720P', // 没有480p，降级到720P
      '720p': '720P',
      '1080p': '1080P'
    };
    return map[res.toLowerCase()] || '720P';
  }

  // 内部方法：映射状态
  _mapStatus(status) {
    const map = {
      'queued': 'processing',
      'in_progress': 'processing',
      'completed': 'completed',
      'failed': 'failed',
      'cancelled': 'failed'
    };
    return map[status] || 'processing';
  }
}

module.exports = AgnesGenerator;
