// ==========================================
// Seedance 视频生成器适配器
// 支持火山引擎官方 API 和第三方中转
// ==========================================

const BaseGenerator = require('./base');

class SeedanceGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'seedance';
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || 'https://ark.volcengine.com/api/v3';
    this.model = config.model || 'doubao-seedance-2.0-mini-250928';
    this.supportedOptions = {
      maxDuration: 15,
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9', '9:16', '1:1']
    };
  }

  async generate(prompt, options = {}) {
    if (!this.apiKey) {
      throw new Error('Seedance API Key 未配置');
    }

    const model = options.model || this.model;
    const isVolcengine = this.baseUrl.includes('volcengine.com') || this.baseUrl.includes('ark.cn');

    if (isVolcengine) {
      return await this._generateVolcengine(prompt, options, model);
    } else {
      return await this._generateThirdParty(prompt, options, model);
    }
  }

  // 火山引擎官方 API
  async _generateVolcengine(prompt, options = {}) {
    const duration = Math.min(options.duration || 5, 15);
    const resolution = options.resolution || '480p';

    const body = {
      model: options.model || this.model,
      content: [
        { type: 'text', text: prompt }
      ],
      parameters: {
        ratio: options.aspectRatio || '16:9',
        duration: String(duration),
        resolution
      }
    };

    const response = await fetch(`${this.baseUrl}/contents/generations/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || data.error || `火山引擎 API 错误 (${response.status})`;
      throw new Error(errMsg);
    }

    return {
      taskId: data.id,
      status: 'queued'
    };
  }

  // 第三方中转 API（兼容 OpenAI 格式）
  async _generateThirdParty(prompt, options = {}) {
    const response = await fetch(`${this.baseUrl}/videos/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || this.model,
        prompt,
        duration: options.duration || 5,
        quality: options.resolution || '480p',
        aspect_ratio: options.aspectRatio || '16:9',
        generate_audio: options.generateAudio || false
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `API错误: ${response.status}`);
    }

    return { taskId: data.task_id, status: data.status };
  }

  async getStatus(taskId) {
    const isVolcengine = this.baseUrl.includes('volcengine.com') || this.baseUrl.includes('ark.cn');

    if (isVolcengine) {
      return await this._getStatusVolcengine(taskId);
    } else {
      return await this._getStatusThirdParty(taskId);
    }
  }

  // 火山引擎官方：查询任务状态
  async _getStatusVolcengine(taskId) {
    const response = await fetch(`${this.baseUrl}/contents/generations/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `查询任务状态失败: ${response.status}`);
    }

    const status = data.status; // queued / succeeded / failed
    let videoUrl = null;
    let error = null;

    if (status === 'succeeded') {
      const outputs = data.content?.video_urls || data.output?.video_urls || [];
      if (outputs.length > 0) {
        videoUrl = outputs[0];
      }
    } else if (status === 'failed') {
      error = data.error?.message || '生成失败';
    }

    return {
      status: status === 'succeeded' ? 'success' : (status === 'failed' ? 'failed' : 'processing'),
      videoUrl,
      error
    };
  }

  // 第三方中转：查询任务状态
  async _getStatusThirdParty(taskId) {
    const response = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    const data = await response.json();

    return {
      status: data.status,
      videoUrl: data.output?.video_url || null,
      error: data.error || null
    };
  }
}

module.exports = SeedanceGenerator;
