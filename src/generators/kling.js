// ==========================================
// 可灵 (Kling) 视频生成器适配器
// ==========================================

const BaseGenerator = require('./base');

class KlingGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'kling';
    this.apiKey = config.apiKey || process.env.KLING_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.klingai.com/v1';
    this.supportedOptions = {
      maxDuration: 15.5,
      resolutions: ['720p', '1080p', '4K'],
      aspectRatios: ['16:9', '9:16', '1:1']
    };
  }

  // 转换分辨率格式
  _mapResolution(res) {
    const map = {
      '480p': '720x480',
      '720p': '1280x720',
      '1080p': '1920x1080',
      '4K': '3840x2160'
    };
    return map[res] || '1280x720';
  }

  async generate(prompt, options = {}) {
    if (!this.apiKey) {
      throw new Error('Kling API Key 未配置');
    }

    const response = await fetch(`${this.baseUrl}/videos/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'kling-v3',
        prompt,
        duration: options.duration || 15,
        resolution: this._mapResolution(options.resolution || '720p'),
        aspect_ratio: options.aspectRatio || '16:9'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `API错误: ${response.status}`);
    }

    return { taskId: data.request_id || data.task_id, status: 'submitted' };
  }

  async getStatus(taskId) {
    const response = await fetch(`${this.baseUrl}/videos/${taskId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    const data = await response.json();

    // 转换状态为统一格式
    let status = 'processing';
    if (data.status === 'succeed' || data.status === 'completed') status = 'completed';
    if (data.status === 'failed') status = 'failed';

    return {
      status,
      videoUrl: data.video_url || data.output?.video_url || null,
      error: data.error || null
    };
  }
}

module.exports = KlingGenerator;
