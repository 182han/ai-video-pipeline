// ==========================================
// 视频生成器工厂 - 统一入口
// ==========================================

const config = require('../../config');
const MockGenerator = require('./mock');
const SeedanceGenerator = require('./seedance');
const KlingGenerator = require('./kling');
const AgnesGenerator = require('./agnes');
const SiliconFlowGenerator = require('./siliconflow');
const DashScopeGenerator = require('./dashscope');

const generators = {
  mock: (cfg) => new MockGenerator(cfg),
  seedance: (cfg) => new SeedanceGenerator({
    apiKey: config.SEEDANCE_API_KEY,
    baseUrl: config.SEEDANCE_BASE_URL,
    ...cfg
  }),
  kling: (cfg) => new KlingGenerator({
    accessKey: config.KLING_ACCESS_KEY,
    secretKey: config.KLING_SECRET_KEY,
    baseUrl: config.KLING_BASE_URL,
    modelId: config.KLING_MODEL,
    ...cfg
  }),
  agnes: (cfg) => new AgnesGenerator({
    apiKey: config.AGNES_API_KEY,
    baseUrl: config.AGNES_BASE_URL,
    modelId: config.AGNES_MODEL_ID,
    ...cfg
  }),
  siliconflow: (cfg) => new SiliconFlowGenerator({
    apiKey: config.SILICONFLOW_API_KEY,
    baseUrl: config.SILICONFLOW_BASE_URL,
    modelId: config.SILICONFLOW_MODEL_ID,
    ...cfg
  }),
  dashscope: (cfg) => new DashScopeGenerator({
    apiKey: config.DASHSCOPE_API_KEY,
    baseUrl: config.DASHSCOPE_BASE_URL,
    modelId: config.DASHSCOPE_MODEL_ID,
    ...cfg
  })
};

// 获取可用的模型列表
function getAvailableModels() {
  return [
    { id: 'mock', name: '模拟生成器（测试用）', maxDuration: 30, resolutions: ['480p', '720p', '1080p'], available: true },
    { id: 'siliconflow', name: 'Wan 2.2 (硅基流动)', maxDuration: 5, resolutions: ['720p'], available: !!config.SILICONFLOW_API_KEY },
    { id: 'agnes', name: 'Agnes (Pavo) 2.5', maxDuration: 12, resolutions: ['720P', '1080P', '2K'], available: !!config.AGNES_API_KEY },
    { id: 'seedance', name: 'Seedance 2.5 (字节跳动)', maxDuration: 30, resolutions: ['480p', '720p'], available: !!config.SEEDANCE_API_KEY },
    { id: 'kling', name: '可灵 Kling 3.0 (快手)', maxDuration: 15, resolutions: ['720p', '1080p', '4K'], available: !!(config.KLING_ACCESS_KEY && config.KLING_SECRET_KEY) },
    { id: 'dashscope', name: 'Wan 3.0 (阿里 DashScope)', maxDuration: 30, resolutions: ['480p', '720p', '1080p'], available: !!config.DASHSCOPE_API_KEY }
  ];
}

// 创建生成器实例
function createGenerator(modelName, extraConfig = {}) {
  // 如果选了真实模型但没配 Key 也没传运行时 Key，才降级到 Mock
  const modelConfig = getAvailableModels().find(m => m.id === modelName);
  const hasRuntimeKey = (extraConfig.apiKey && extraConfig.apiKey.length > 0) ||
    (extraConfig.accessKey && extraConfig.accessKey.length > 0);
  if (modelName !== 'mock' && modelConfig && !modelConfig.available && !hasRuntimeKey) {
    console.log(`[Generator] ${modelName} 未配置 API Key，使用 Mock 模式`);
    const fallback = new MockGenerator({ failRate: 0.05, genTime: 2000 });
    // 明确标记「这不是用户选的模型」：pipeline 据此把产物按合成素材处理。
    // 历史事故：降级后任务仍标 dashscope，NSFW 把 ffmpeg 测试图案当真实内容检测，
    // 没配多模态 Key 时整条任务必失败，用户完全看不出「实际生成的是 Mock」。
    fallback.fallbackToMock = true;
    fallback.requestedModel = modelName;
    return fallback;
  }

  const factory = generators[modelName];
  if (!factory) {
    throw new Error(`不支持的模型: ${modelName}，可用模型: ${Object.keys(generators).join(', ')}`);
  }
  return factory(extraConfig);
}

module.exports = { getAvailableModels, createGenerator };
