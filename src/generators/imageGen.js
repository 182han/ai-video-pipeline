// ==========================================
// 图片生成：配置就绪度 + 厂商适配器注册表
// ==========================================
//
// 背景：工作流要从「提示词 → 视频」升级为
//       提示词 → 分镜 → 图片（人工确认）→ 视频
// 本文件只负责三件事：
//   1. 声明配置是否齐备（getImageGenStatus）
//   2. 给出能力声明（capabilities），供前端/接口展示哪个视频模型支持图生视频
//   3. 维护出图厂商适配器注册表；generateImage 调用选定厂商
//
// 当前内置厂商：阿里云百炼 wan2.7-image（2026-11-08 接入）
//   → src/generators/imageProviders/dashscope.js
//   → 启动时由 src/generators/imageProviders/index.js 注册（server.js 已 require）
//
// 仍然保持的硬约束：
//   - 未选厂商 / 厂商未注册 / 配置不全 → 显式抛错，绝不返回占位图（AGENTS §4.8）
//   - 失败必须 throw，不要返回 { ok:false } 这种会被上游误判的形态
//   - 不要把 base64 塞进 imagePath；先落盘再返回路径
//
// 尚未接入的部分（不要假装已实现）：
//   - pipeline 里还没有 image_generation 阶段（见 docs/spec/review-gate-design.md §15）
//   - 图生视频（I2V_*）仍是配置预留，厂商能力未核实

const config = require('../../config');
const fs = require('fs');

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
function getImageGenStatus(overrides = {}) {
  // 允许调用方传入运行时配置（例如页面「设置」里填的 Key/地址/模型）。
  // 只用于本次请求，不落盘；没有 overrides 时行为与原来完全一致。
  const cfg = Object.assign({}, config, overrides || {});
  const missing = IMAGE_GEN_KEYS.filter(k => !cfg[k]);
  const provider = cfg.IMAGE_GEN_PROVIDER || null;
  const providerImplemented = Boolean(provider) && PROVIDERS.has(String(provider));
  const i2v = resolveI2VConfig();
  return {
    // ready 只看「配置是否齐备」；能不能真的出图还要看适配器是否注册（usable）
    ready: missing.length === 0,
    usable: missing.length === 0 && providerImplemented,
    missing,
    providerImplemented,
    registeredProviders: listImageProviders(),
    imageGen: {
      provider,
      baseUrl: cfg.IMAGE_GEN_BASE_URL || null,
      model: cfg.IMAGE_GEN_MODEL || null,
      size: cfg.IMAGE_GEN_SIZE || null,
      timeoutMs: cfg.IMAGE_GEN_TIMEOUT_MS || null,
      pollMs: cfg.IMAGE_GEN_POLL_MS || null,
      watermark: cfg.IMAGE_GEN_WATERMARK || null,
      // 只暴露「是否已配置」，绝不回传 Key 本身
      hasApiKey: !!cfg.IMAGE_GEN_API_KEY
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

// ===== 出图厂商适配器注册表（2026-10-27）=====
//
// 目的：把「用哪家出图」这个决定推迟到配置层，代码里不锁死厂商。
// 加一家的工作量 = 新增一个适配器函数 + 在启动时 registerImageProvider() 一次；
// 流水线与前端都不需要改。
//
// 适配器契约（必须遵守，否则视为未接入）：
//   async ({ prompt, options, config }) => ({
//     imagePath,   // string，本地文件绝对路径，必须真实存在
//     width,       // number
//     height,      // number
//     provider,    // string，厂商标识
//     model        // string，实际使用的模型 id
//   })
// 硬性要求：
//   - 不许返回占位图 / 假图 / 纯色图冒充结果（AGENTS §4.8）
//   - 失败必须 throw，不要返回 { ok:false } 这种会被上游误判的形态
//   - 不要把 base64 塞进 imagePath；先落盘再返回路径
//
// 示例（写到 src/generators/providers/<vendor>.js，然后在启动时注册）：
//   registerImageProvider('somevendor', async ({ prompt, options, config }) => {
//     const buf = await callVendor(prompt, options, config);   // 自己实现
//     const imagePath = path.join(config.outputDir || 'output', `img_${Date.now()}.png`);
//     fs.writeFileSync(imagePath, buf);
//     return { imagePath, width, height, provider: 'somevendor', model: config.model };
//   });
const PROVIDERS = new Map();

function registerImageProvider(name, adapter) {
  if (!name || typeof name !== 'string') throw new Error('registerImageProvider: name 必须是非空字符串');
  if (typeof adapter !== 'function') throw new Error('registerImageProvider: adapter 必须是函数');
  PROVIDERS.set(name, adapter);
  return adapter;
}

function listImageProviders() {
  return Array.from(PROVIDERS.keys());
}

class ImageGenerator {
  constructor(cfg = {}) {
    this.name = 'imageGen';
    this.config = cfg;
    this.provider = String(cfg.provider || cfg.IMAGE_GEN_PROVIDER || config.IMAGE_GEN_PROVIDER || '').trim();
    this.capabilities = {
      supportsImageOutput: true,
      // 只有「选定的厂商有适配器」才算已实现；配置齐不齐由 getImageGenStatus 判断
      implemented: Boolean(this.provider) && PROVIDERS.has(this.provider)
    };
  }

  /**
   * 生成一张静帧（分镜图）。
   * 未选厂商 / 厂商未接入 / 配置不全 → 显式抛错，绝不返回占位图。
   * 成功时返回 { imagePath, width, height, provider, model }。
   */
  async generateImage(prompt, options = {}) {
    const provider = String(this.config.provider || this.config.IMAGE_GEN_PROVIDER || config.IMAGE_GEN_PROVIDER || '').trim();

    if (!provider) {
      throw new Error(
        '未选择出图厂商：IMAGE_GEN_PROVIDER 为空。'
        + `当前已注册适配器：${listImageProviders().join(', ') || '（无）'}。`
        + '选定厂商后，实现对应适配器并 registerImageProvider() 即可，无需改流水线。'
      );
    }

    const adapter = PROVIDERS.get(provider);
    if (!adapter) {
      throw new Error(
        `出图厂商「${provider}」尚未接入适配器。`
        + `当前已注册：${listImageProviders().join(', ') || '（无）'}。`
        + '接入方式见 src/generators/imageGen.js 顶部「适配器契约」。这是预期的「未实现」错误，不会产出任何假图。'
      );
    }

    const status = getImageGenStatus(this.config);
    if (!status.ready) {
      throw new Error(
        `图片生成配置不完整，缺少: ${status.missing.join(', ')}。`
        + '请在 app/.env 中补齐（通常只需要 IMAGE_GEN_API_KEY，'
        + '或复用 DASHSCOPE_API_KEY），然后重启服务。'
      );
    }

    const out = await adapter({ prompt, options, config: this.config });

    // 校验契约，防止适配器把半成品当结果返回
    if (!out || typeof out.imagePath !== 'string' || !out.imagePath) {
      throw new Error(`出图适配器「${provider}」没有返回合法的 imagePath（返回类型: ${typeof out}）`);
    }
    if (typeof out.width !== 'number' || typeof out.height !== 'number') {
      throw new Error(`出图适配器「${provider}」没有返回合法的 width/height`);
    }
    // 文件必须真实存在且不是空壳 —— 光看返回值容易放过「返回了路径但没写文件」
    if (!fs.existsSync(out.imagePath)) {
      throw new Error(`出图适配器「${provider}」返回的 imagePath 不存在: ${out.imagePath}`);
    }
    const stat = fs.statSync(out.imagePath);
    if (!stat.isFile() || stat.size < 8) {
      throw new Error(`出图适配器「${provider}」返回的图片文件无效（${stat.size} 字节）`);
    }
    return {
      imagePath: out.imagePath,
      width: out.width,
      height: out.height,
      provider: out.provider || provider,
      model: out.model || this.config.model || config.IMAGE_GEN_MODEL || ''
    };
  }
}

// 运行时配置 → 出图覆盖键（契约 2026-11-16 §1，追加导出，不改既有逻辑）。
//
// rc 形状（task.runtimeConfig 里的 5 个图片字段）：
//   { imageApiKey, imageBaseUrl, imageProvider, imageModel, imageSize }
// 映射到 getImageGenStatus / ImageGenerator 认识的 IMAGE_GEN_* 覆盖键。
// 未传 / 空串 / 非字符串 → 不放进 overrides，由 getImageGenStatus 回落到 .env 的 IMAGE_GEN_*
// （与 /api/images/* 的既有口径一致）。Key 只在内存里用，绝不写日志/落盘。
function overridesFromRuntimeConfig(rc) {
  const src = (rc && typeof rc === 'object') ? rc : {};
  const map = {
    IMAGE_GEN_API_KEY: 'imageApiKey',
    IMAGE_GEN_BASE_URL: 'imageBaseUrl',
    IMAGE_GEN_PROVIDER: 'imageProvider',
    IMAGE_GEN_MODEL: 'imageModel',
    IMAGE_GEN_SIZE: 'imageSize'
  };
  const out = {};
  for (const [target, from] of Object.entries(map)) {
    const raw = src[from];
    // 契约 §1：这 5 个字段全部是字符串；非字符串一律不产生覆盖（回落到 .env）。
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (v) out[target] = v;
  }
  return out;
}

module.exports = {
  ImageGenerator,
  getImageGenStatus,
  resolveI2VConfig,
  IMAGE_INPUT_CAPABILITY,
  registerImageProvider,
  listImageProviders,
  overridesFromRuntimeConfig
};
