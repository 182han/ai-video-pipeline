// ==========================================
// 阿里云百炼 DashScope (Wan 3.0) 视频生成器适配器
// 官方文档：
//   https://help.aliyun.com/zh/model-studio/text-to-video-guide
// 提交：POST  {baseUrl}/services/aigc/video-generation/video-synthesis
// 查询：GET   {baseUrl}/tasks/{task_id}
// baseUrl 为完整 API 根地址：https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1
// ==========================================

const BaseGenerator = require('./base');

class DashScopeGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'dashscope';
    this.apiKey = config.apiKey || process.env.DASHSCOPE_API_KEY || '';
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.modelId = config.modelId || 'wan3.0-video';
    this.supportedOptions = {
      maxDuration: 30,
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
    };
  }

  // 分辨率小写 → 大写（官方要求 480P/720P/1080P）
  _mapResolution(res) {
    const r = String(res || '1080p').toUpperCase();
    return ['480P', '720P', '1080P'].includes(r) ? r : '1080P';
  }

  async generate(prompt, options = {}) {
    if (!this.apiKey) {
      throw new Error('DashScope API Key 未配置，请在设置中填写');
    }
    if (!this.baseUrl) {
      throw new Error('DashScope Base URL 未配置（需要 WorkspaceId + Region）');
    }

    const body = {
      model: this.modelId,
      input: { prompt },
      parameters: {
        resolution: this._mapResolution(options.resolution || '1080p'),
        ratio: options.aspectRatio || '16:9',
        duration: Math.max(2, Math.min(30, parseInt(options.duration, 10) || 5)),
        // 决策点 1/2：本项目已有独立配乐与提示词优化，关掉模型自带音轨与二次改写
        audio: false,
        prompt_extend: false
      }
    };

    const response = await fetch(`${this.baseUrl}/services/aigc/video-generation/video-synthesis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = data.message || data.error?.message || data.error || JSON.stringify(data).substring(0, 200);
      throw new Error(`DashScope API 错误 (${response.status}): ${errMsg}`);
    }

    const taskId = data.output?.task_id || data.task_id;
    if (!taskId) {
      throw new Error('DashScope API 未返回 task_id: ' + JSON.stringify(data).substring(0, 200));
    }

    return { taskId, status: 'queued' };
  }

  async getStatus(taskId) {
    if (!this.apiKey) {
      return { status: 'failed', error: 'API Key 未配置' };
    }

    try {
      const response = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errMsg = data.message || data.error?.message || `HTTP ${response.status}`;
        return { status: 'failed', error: errMsg };
      }

      const output = data.output || {};
      let status = 'processing';
      let videoUrl = null;
      let error = null;

      switch (output.task_status) {
        case 'SUCCEEDED':
          status = 'completed';
          videoUrl = output.video_url || null;
          break;
        case 'FAILED':
          status = 'failed';
          error = output.message || output.code || data.message || '生成失败';
          break;
        case 'PENDING':
        case 'RUNNING':
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
}

module.exports = DashScopeGenerator;
