// ==========================================
// 可灵 (Kling) 视频生成器适配器
// 按可灵开放平台官方 API 文档实现：
// - 鉴权：JWT (HS256, iss=AccessKey, sk 签名)，非静态 Bearer
// - 文生视频：POST /v1/videos/text2video（model_name: kling-v3, mode: std/pro/4k, duration: 3-15）
// - 任务查询：GET /v1/videos/text2video/{task_id}
// ==========================================

const crypto = require('crypto');
const BaseGenerator = require('./base');

class KlingGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'kling';
    // 可灵官方鉴权需要 AccessKey + SecretKey 双字段
    this.accessKey = config.accessKey || process.env.KLING_ACCESS_KEY || '';
    this.secretKey = config.secretKey || process.env.KLING_SECRET_KEY || '';
    this.baseUrl = (config.baseUrl || 'https://api-beijing.klingai.com').replace(/\/+$/, '');
    this.modelName = config.modelId || 'kling-v3';
    this.supportedOptions = {
      maxDuration: 15,
      resolutions: ['720p', '1080p', '4K'],
      aspectRatios: ['16:9', '9:16', '1:1']
    };
  }

  // 生成 JWT token（官方规范：HS256，exp 最长 30 分钟）
  _generateToken() {
    return this.constructor.generateJwt(this.accessKey, this.secretKey);
  }

  // 分辨率 → 可灵 mode（std=720P / pro=1080P / 4k=4K）
  _mapMode(resolution) {
    const map = { '4K': '4k', '1080p': 'pro', '720p': 'std', '480p': 'std' };
    return map[resolution] || 'std';
  }

  // 时长钳制到官方支持的 3-15 秒
  _mapDuration(duration) {
    return Math.max(3, Math.min(15, parseInt(duration, 10) || 15));
  }

  async generate(prompt, options = {}) {
    const resolution = options.resolution || '1080p';

    try {
      return await this._createTask(prompt, { ...options, resolution });
    } catch (e) {
      // 4K 失败自动降档 1080p 重试一次（控制 ¥45/段的意外成本）
      // 鉴权失败 / 余额不足 / 参数错误不降档
      if (resolution === '4K' && this._isDowngradable(e)) {
        console.warn('[Kling] 4K 生成失败，降档 1080p 重试:', e.message);
        const result = await this._createTask(prompt, { ...options, resolution: '1080p' });
        return { ...result, downgraded: true, downgradeReason: e.message };
      }
      throw e;
    }
  }

  _isDowngradable(error) {
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('401') || msg.includes('402') || msg.includes('403')) return false;
    if (msg.includes('鉴权') || msg.includes('余额') || msg.includes('accesskey')) return false;
    return true;
  }

  async _createTask(prompt, options = {}) {
    const token = this._generateToken();
    const duration = this._mapDuration(options.duration);

    const response = await fetch(`${this.baseUrl}/v1/videos/text2video`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model_name: this.modelName,
        prompt: (prompt || '').substring(0, 2500),
        duration,
        mode: this._mapMode(options.resolution),
        aspect_ratio: options.aspectRatio || '16:9',
        // 负面词（官方字段 negative_prompt，≤2500 字符；无则省略）
        ...(options.negative ? { negative_prompt: String(options.negative).substring(0, 2500) } : {})
      })
    });

    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) {
      throw new Error(`可灵API响应异常 (HTTP ${response.status})`);
    }

    if (!response.ok || (data.code && data.code !== 1000)) {
      const errMsg = data.message || data.error || `HTTP ${response.status}`;
      const err = new Error(`可灵API错误(${response.status}): ${errMsg}`);
      err.statusCode = response.status;
      throw err;
    }

    const taskId = data.data?.task_id;
    if (!taskId) {
      throw new Error('可灵API未返回任务ID');
    }
    return { taskId, status: 'submitted', duration };
  }

  async getStatus(taskId) {
    const token = this._generateToken();
    const response = await fetch(`${this.baseUrl}/v1/videos/text2video/${encodeURIComponent(taskId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) {
      throw new Error(`可灵查询响应异常 (HTTP ${response.status})`);
    }

    if (!response.ok || (data.code && data.code !== 1000)) {
      const errMsg = data.message || data.error || `HTTP ${response.status}`;
      throw new Error(`可灵查询失败(${response.status}): ${errMsg}`);
    }

    const d = data.data || {};
    let status = 'processing';
    if (d.task_status === 'succeed') status = 'completed';
    else if (d.task_status === 'failed') status = 'failed';

    // 官方返回结构兼容 movies（旧字段）/ videos（新字段）
    const videos = (d.task_result && (d.task_result.movies || d.task_result.videos)) || [];

    return {
      status,
      videoUrl: videos[0] && videos[0].url || null,
      error: status === 'failed' ? (d.task_status_msg || '可灵生成失败') : null
    };
  }

  // 402 余额不足不可重试；429 限流 / 超时 / 5xx 可重试
  canRetry(error) {
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('402') || msg.includes('余额')) return false;
    if (msg.includes('401') || msg.includes('403') || msg.includes('鉴权')) return false;
    if (msg.includes('429') || msg.includes('rate')) return true;
    return msg.includes('timeout') || msg.includes('超时') ||
      msg.includes('500') || msg.includes('502') || msg.includes('503') ||
      msg.includes('network') || msg.includes('econnreset');
  }
}

// 生成可灵官方 JWT token（HS256，iss=AccessKey，sk 签名，exp 最长 30 分钟）
// 静态方法，导出供 server.js 测试连接复用
KlingGenerator.generateJwt = function (accessKey, secretKey) {
  if (!accessKey || !secretKey) {
    throw new Error('可灵 API 需要同时配置 AccessKey 和 SecretKey（在可灵开放平台创建）');
  }
  const b64url = (input) => Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: accessKey,
    exp: now + 1800, // 30 分钟有效
    nbf: now - 5
  }));
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${b64url(signature)}`;
};

module.exports = KlingGenerator;
