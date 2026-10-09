// ==========================================
// 硅基流动 SiliconFlow (Wan) 视频生成器适配器
// ==========================================

const BaseGenerator = require('./base');

class SiliconFlowGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'siliconflow';
    this.apiKey = config.apiKey || process.env.SILICONFLOW_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.siliconflow.cn/v1';
    this.modelId = config.modelId || 'Wan-AI/Wan2.2-T2V-A14B';
    this.supportedOptions = {
      maxDuration: 5, // Wan 2.2 默认 5 秒
      resolutions: ['720p'],
      aspectRatios: ['16:9', '9:16', '1:1']
    };
    // 轮询配置
    this.pollInterval = 3000; // 3秒轮询一次
    this.maxPollTime = 600000; // 最长10分钟
  }

  // 映射分辨率到 image_size 格式
  _mapResolution(res, aspectRatio) {
    const ar = aspectRatio || '16:9';
    if (ar === '16:9') return '1280x720';
    if (ar === '9:16') return '720x1280';
    if (ar === '1:1') return '960x960';
    return '1280x720';
  }

  async generate(prompt, options = {}) {
    if (!this.apiKey) {
      throw new Error('SiliconFlow API Key 未配置，请在设置中填写');
    }

    const imageSize = this._mapResolution(options.resolution || '720p', options.aspectRatio || '16:9');

    const body = {
      model: this.modelId,
      prompt,
      image_size: imageSize
    };

    if (options.negativePrompt) {
      body.negative_prompt = options.negativePrompt;
    }
    if (options.seed) {
      body.seed = options.seed;
    }

    const response = await fetch(`${this.baseUrl}/video/submit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.message || data.error || JSON.stringify(data).substring(0, 200);
      throw new Error(`SiliconFlow API 错误 (${response.status}): ${errorMsg}`);
    }

    return {
      taskId: data.requestId,
      status: 'queued'
    };
  }

  async getStatus(taskId) {
    if (!this.apiKey) {
      return { status: 'failed', error: 'API Key 未配置' };
    }

    try {
      const response = await fetch(`${this.baseUrl}/video/status`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requestId: taskId })
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.message || `HTTP ${response.status}`;
        return { status: 'failed', error: errorMsg };
      }

      // 映射状态
      let status = 'processing';
      let videoUrl = null;
      let error = null;

      switch (data.status) {
        case 'Succeed':
          status = 'completed';
          if (data.results?.videos && data.results.videos.length > 0) {
            videoUrl = data.results.videos[0].url;
          }
          break;
        case 'InQueue':
          status = 'queued';
          break;
        case 'InProgress':
          status = 'processing';
          break;
        case 'Failed':
          status = 'failed';
          error = data.reason || '生成失败';
          break;
        default:
          status = 'processing';
      }

      return {
        status,
        videoUrl,
        error,
        progress: status === 'completed' ? 100 : undefined
      };
    } catch (e) {
      return { status: 'failed', error: e.message };
    }
  }

  // 生成单个视频（含轮询等待）
  async generateAndWait(prompt, options = {}) {
    const result = await this.generate(prompt, options);
    const taskId = result.taskId;

    const startTime = Date.now();
    while (Date.now() - startTime < this.maxPollTime) {
      await new Promise(r => setTimeout(r, this.pollInterval));

      const status = await this.getStatus(taskId);

      if (status.status === 'completed') {
        return {
          taskId,
          status: 'completed',
          videoUrl: status.videoUrl
        };
      }

      if (status.status === 'failed') {
        throw new Error(status.error || '生成失败');
      }
    }

    throw new Error('生成超时');
  }
}

module.exports = SiliconFlowGenerator;
