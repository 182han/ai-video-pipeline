// ==========================================
// 配置文件 - 在这里填写你的 API Key 和其他配置
// ==========================================
// 使用方法：
// 1. 填写你需要的 API Key（不需要的可以留空）
// 2. 保存文件，重启服务即可生效
// ==========================================

module.exports = {
  // ===== 视频生成模型 API Key =====
  // 留空的模型在页面上还是可以选，但会用 Mock 模式模拟

  // Agnes AI (Pavo)
  // 官网: https://pavo.agnes-ai.com
  // API 控制台: https://platform.agnes-ai.com
  AGNES_API_KEY: '',
  AGNES_BASE_URL: 'https://apihub.agnes-ai.com/v1',
  AGNES_MODEL_ID: 'agnes-video-2.5',

  // 硅基流动 SiliconFlow (Wan 2.2)
  // 官网: https://siliconflow.cn
  // 新用户有免费额度，Wan 视频模型便宜好用
  SILICONFLOW_API_KEY: '',
  SILICONFLOW_BASE_URL: 'https://api.siliconflow.cn/v1',
  SILICONFLOW_MODEL_ID: 'Wan-AI/Wan2.2-T2V-A14B',

  // Seedance (字节跳动)
  // 官网: https://www.seeddance.io
  SEEDANCE_API_KEY: '',
  SEEDANCE_BASE_URL: 'https://www.seeddance.io/v1',
  SEEDANCE_MODEL: 'seedance-2.5',

  // 可灵 Kling (快手)
  // 官网: https://klingai.com
  KLING_API_KEY: '',
  KLING_BASE_URL: 'https://api.klingai.com/v1',
  KLING_MODEL: 'kling-v3',

  // ===== 大语言模型（提示词优化用）=====

  // OpenAI / GPT
  OPENAI_API_KEY: '',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_MODEL: 'gpt-4o-mini',

  // 也可以用国内模型（比如 DeepSeek、智谱等）
  // 把上面的 BASE_URL 和 MODEL 换成对应的值就行
  // 例如 DeepSeek:
  // OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
  // OPENAI_MODEL: 'deepseek-chat',

  // ===== FFmpeg 路径 =====
  // 如果系统 PATH 里没有 ffmpeg，可以在这里指定完整路径
  FFMPEG_PATH: 'C:\\Users\\14872\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\vm\\tools\\app\\ffmpeg\\ffmpeg.exe',
  FFPROBE_PATH: 'C:\\Users\\14872\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\vm\\tools\\app\\ffmpeg\\ffprobe.exe',

  // ===== 生成参数 =====
  GENERATION: {
    // 同时生成的片段数（并发数）
    concurrency: 3,
    // 最大重试次数
    maxRetries: 1,
    // 每段视频默认时长（秒）
    defaultClipDuration: 30,
    // 默认分辨率
    defaultResolution: '720p'
  },

  // ===== 质检参数 =====
  QUALITY_CHECK: {
    // 黑帧检测：最小黑帧持续时间（秒）
    blackFrameMinDuration: 0.5,
    // 黑帧检测：黑像素比例阈值
    blackFrameThreshold: 0.95,
    // 模糊检测阈值（值越大越模糊）
    blurThreshold: 100,
    // NSFW 检测置信度阈值
    nsfwThreshold: 0.8
  },

  // ===== 存储配置 =====
  STORAGE: {
    // 本地存储路径
    clipsDir: './clips',
    outputDir: './output',
    dataDir: './data/tasks',
    // S3 配置（可选）
    s3: {
      enabled: false,
      accessKeyId: '',
      secretAccessKey: '',
      region: '',
      bucket: ''
    }
  },

  // ===== 服务器配置 =====
  SERVER: {
    port: 3000,
    // 是否启用 WebSocket
    websocket: true
  }
};
