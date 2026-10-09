// ==========================================
// 视频生成器工厂 - 统一入口
// ==========================================

const config = require('../../config');
const MockGenerator = require('./mock');
const SeedanceGenerator = require('./seedance');
const KlingGenerator = require('./kling');
const AgnesGenerator = require('./agnes');
const SiliconFlowGenerator = require('./siliconflow');

const generators = {
  mock: (cfg) => new MockGenerator(cfg),
  seedance: (cfg) => new SeedanceGenerator({
    apiKey: config.SEEDANCE_API_KEY,
    baseUrl: config.SEEDANCE_BASE_URL,
    ...cfg
  }),
  kling: (cfg) => new KlingGenerator({
    apiKey: config.KLING_API_KEY,
    baseUrl: config.KLING_BASE_URL,
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
  })
};

// 获取可用的模型列表
function getAvailableModels() {
  return [
    { id: 'mock', name: '模拟生成器（测试用）', maxDuration: 30, resolutions: ['480p', '720p', '1080p'], available: true },
    { id: 'siliconflow', name: 'Wan 2.2 (硅基流动)', maxDuration: 5, resolutions: ['720p'], available: !!config.SILICONFLOW_API_KEY },
    { id: 'agnes', name: 'Agnes (Pavo) 2.5', maxDuration: 12, resolutions: ['720P', '1080P', '2K'], available: !!config.AGNES_API_KEY },
    { id: 'seedance', name: 'Seedance 2.5 (字节跳动)', maxDuration: 30, resolutions: ['480p', '720p'], available: !!config.SEEDANCE_API_KEY },
    { id: 'kling', name: '可灵 Kling 3.0 (快手)', maxDuration: 15.5, resolutions: ['720p', '1080p', '4K'], available: !!config.KLING_API_KEY }
  ];
}

// 创建生成器实例
function createGenerator(modelName, extraConfig = {}) {
  // 如果选了真实模型但没配 Key 也没传运行时 Key，才降级到 Mock
  const modelConfig = getAvailableModels().find(m => m.id === modelName);
  const hasRuntimeKey = extraConfig.apiKey && extraConfig.apiKey.length > 0;
  if (modelName !== 'mock' && modelConfig && !modelConfig.available && !hasRuntimeKey) {
    console.log(`[Generator] ${modelName} 未配置 API Key，使用 Mock 模式`);
    return new MockGenerator({ failRate: 0.05, genTime: 2000 });
  }

  const factory = generators[modelName];
  if (!factory) {
    throw new Error(`不支持的模型: ${modelName}，可用模型: ${Object.keys(generators).join(', ')}`);
  }
  return factory(extraConfig);
}

module.exports = { getAvailableModels, createGenerator };
