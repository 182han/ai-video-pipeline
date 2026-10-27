// ==========================================
// 图片生成 / 图生视频 —— **配置预留层（未接入厂商）**
// ==========================================
//
// 背景：工作流要从「提示词 → 视频」升级为
//       提示词 → 分镜 → 图片（人工确认）→ 视频
// 本文件当前只做三件事：
//   1. 声明配置是否齐备（getImageGenStatus）
//   2. 给出能力声明（capabilities），供前端/接口展示哪个视频模型支持图生视频
//   3. generateImage 被调用时抛出**明确**的错误，而不是返回假图
//
// 为什么现在不实现：
//   - 各厂商的 image-to-video 入参、图片格式、URL 时效都不同，未核实前写代码必返工
//   - AGENTS.md §4.8：不许谎报状态；未实现的路径必须显式失败
//
// 接入时要改的地方（留给后端改造阶段）：
//   - 实现 _callImageApi()（OpenAI 兼容 /images/generations 或厂商自定义）
//   - 在 pipelineStages 增加 image_generation 阶段
//   - 在 pipeline 里加入人工确认门（暂停/恢复）

const config = require('../../config');

const IMAGE_GEN_KEYS = [
  'IMAGE_GEN_API_KEY',
  'IMAGE_GEN_BASE_URL',
  'IMAGE_GEN_MODEL'
];

// 图生视频配置：I2V_* 留空时回退到 IMAGE_GEN_*（同一厂商同一 Key 的常见情形）
function resolveI2VConfig() {
  const pick = (key, fallback) => (config[key] ? config[key] : fallback);
  return {
    provider: config.I2V_PROVIDER || config.IMAGE_GEN_PROVIDER || null,
    apiKey: pick('I2V_API_KEY', config.IMAGE_GEN_API_KEY) || null,
    baseUrl: pick('I2V_BASE_URL', config.IMAGE_GEN_BASE_URL) || null,
    model: config.I2V_MODEL || null,
    // 显式区分：用的是独立 I2V 配置，还是回退到了 IMAGE_GEN
    inheritedFromImageGen: !config.I2V_API_KEY && !!config.IMAGE_GEN_API_KEY
  };
}

/**
 * 配置齐备度。用于页面展示与启动自检。
 * @returns {{ready:boolean, missing:string[], imageGen:object, i2v:object}}
 */
function getImageGenStatus() {
  const missing = IMAGE_GEN_KEYS.filter(k => !config[k]);
  const i2v = resolveI2VConfig();
  return {
    ready: missing.length === 0,
    missing,
    imageGen: {
      provider: config.IMAGE_GEN_PROVIDER || null,
      baseUrl: config.IMAGE_GEN_BASE_URL || null,
      model: config.IMAGE_GEN_MODEL || null,
      size: config.IMAGE_GEN_SIZE || null,
      timeoutMs: config.IMAGE_GEN_TIMEOUT_MS || null,
      // 只暴露「是否已配置」，绝不回传 Key 本身
      hasApiKey: !!config.IMAGE_GEN_API_KEY
    },
    i2v: {
      provider: i2v.provider,
      baseUrl: i2v.baseUrl,
      model: i2v.model,
      hasApiKey: !!i2v.apiKey,
      inheritedFromImageGen: i2v.inheritedFromImageGen,
      // 「配了」≠「能用」：厂商是否真的支持图生视频必须另行核实
      supportedByProvider: null // null = 未核实，禁止当成 true
    }
  };
}

/**
 * 能力声明：哪些视频模型支持用首帧图片生成。
 * 取值语义（三态，不要合并）：
 *   true  = 已核实接口支持
 *   false = 已核实不支持
 *   null  = **尚未核实**（默认全部为 null，不得当成支持）
 */
const IMAGE_INPUT_CAPABILITY = Object.freeze({
  mock: true,
  siliconflow: null,
  agnes: null,
  seedance: null,
  kling: null,
  dashscope: null
});

class ImageGenerator {
  constructor(cfg = {}) {
    this.name = 'imageGen';
    this.config = cfg;
    this.capabilities = {
      supportsImageOutput: true,
      // 还没接任何厂商，能力必须声明为 false
      implemented: false
    };
  }

  /**
   * 生成一张静帧（分镜图）。
   * 当前**未实现**，调用即抛错。接入后返回 { imagePath, width, height, provider, model }。
   */
  async generateImage(prompt, options = {}) {
    const status = getImageGenStatus();
    if (!status.ready) {
      throw new Error(
        `图片生成配置不完整，缺少: ${status.missing.join(', ')}。`
        + '请在 .env 中补齐 IMAGE_GEN_API_KEY / IMAGE_GEN_BASE_URL / IMAGE_GEN_MODEL。'
      );
    }
    // 配置齐了也还没写调用逻辑 —— 显式失败，绝不返回占位图冒充结果
    throw new Error(
      '图片生成尚未接入厂商（src/generators/imageGen.js 目前只是配置预留层）。'
      + '这是预期的「未实现」错误，不是配置问题，也不会产出任何假图。'
    );
  }
}

module.exports = {
  ImageGenerator,
  getImageGenStatus,
  resolveI2VConfig,
  IMAGE_INPUT_CAPABILITY
};
