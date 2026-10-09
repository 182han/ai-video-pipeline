// ==========================================
// 视频生成器基类 - 适配器模式
// 所有视频生成模型都继承这个基类
// ==========================================

class BaseGenerator {
  constructor(config = {}) {
    this.name = 'base';
    this.config = config;
    this.supportedOptions = {
      maxDuration: 30,
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9']
    };
  }

  // 生成视频 - 返回 taskId
  async generate(prompt, options = {}) {
    throw new Error('子类必须实现 generate 方法');
  }

  // 查询任务状态
  async getStatus(taskId) {
    throw new Error('子类必须实现 getStatus 方法');
  }

  // 检查错误是否可以重试
  canRetry(error) {
    const retryable = ['timeout', 'rate limit', '500', '502', '503', 'network', '429'];
    const msg = (error.message || '').toLowerCase();
    return retryable.some(k => msg.includes(k));
  }
}

module.exports = BaseGenerator;
