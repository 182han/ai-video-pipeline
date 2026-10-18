// ==========================================
// 配置文件 - 全部改为环境变量驱动
// ==========================================
// 使用方法：
// 1. 复制 `.env.example` 为 `.env`，在 `.env` 里填写你的 API Key
// 2. 不要把 `.env` 提交到 Git（已在 .gitignore 中忽略）
// 3. 云平台上把同样的键值填进平台的环境变量面板即可
// ==========================================

// 极简 .env 加载器：不引入 dotenv 依赖，保持零新增包
// 已存在的真实环境变量优先，.env 只作为兜底
(function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉成对的引号
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

// 解析项目内自带的 ffmpeg/ffprobe。
// 找不到时返回空字符串，让调用方回退到系统 PATH（保持云上 Linux 容器行为不变）。
// 注意：这里只做「文件存在」判断，不执行 -version，避免每次 require config 都拉起进程。
function resolveBundled(binName) {
  const fs = require('fs');
  const path = require('path');
  const exe = process.platform === 'win32' ? binName + '.exe' : binName;
  const candidates = [
    path.join(__dirname, 'tools', 'ffmpeg', 'bin', exe),
    path.join(__dirname, 'tools', 'ffmpeg', exe)
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) { /* 忽略权限错误，继续找下一个 */ }
  }
  return '';
}

// 读取环境变量，未设置时回退到默认值
function env(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

// NSFW 置信度阈值：必须是 [0,1] 内的有限小数。
// 非法输入（空/非数字/负数/>1/NaN）一律回退默认值，避免 ×100 比较时把红线悄悄放宽或收紧。
// 注意：这里是在 require 时求值，改了 .env 需重启进程（与其它配置项一致）。
function nsfwThreshold(fallback = 0.8) {
  const raw = env('QC_NSFW_THRESHOLD');
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.warn(`[config] QC_NSFW_THRESHOLD="${raw}" 非法（需 0~1 之间的数），已回退默认 ${fallback}`);
    return fallback;
  }
  return n;
}

module.exports = {
  // ===== 视频生成模型 API Key =====
  // 留空的模型在页面上还是可以选，但会用 Mock 模式模拟

  // Agnes AI (Pavo)
  // 官网: https://pavo.agnes-ai.com
  // API 控制台: https://platform.agnes-ai.com
  AGNES_API_KEY: env('AGNES_API_KEY'),
  AGNES_BASE_URL: env('AGNES_BASE_URL', 'https://apihub.agnes-ai.com/v1'),
  AGNES_MODEL_ID: env('AGNES_MODEL_ID', 'agnes-video-2.5'),

  // 硅基流动 SiliconFlow (Wan 2.2)
  // 官网: https://siliconflow.cn
  // 新用户有免费额度，Wan 视频模型便宜好用
  SILICONFLOW_API_KEY: env('SILICONFLOW_API_KEY'),
  SILICONFLOW_BASE_URL: env('SILICONFLOW_BASE_URL', 'https://api.siliconflow.cn/v1'),
  SILICONFLOW_MODEL_ID: env('SILICONFLOW_MODEL_ID', 'Wan-AI/Wan2.2-T2V-A14B'),

  // Seedance (字节跳动)
  // 官网: https://www.seeddance.io
  SEEDANCE_API_KEY: env('SEEDANCE_API_KEY'),
  SEEDANCE_BASE_URL: env('SEEDANCE_BASE_URL', 'https://www.seeddance.io/v1'),
  SEEDANCE_MODEL: env('SEEDANCE_MODEL', 'seedance-2.5'),

  // 可灵 Kling (快手)
  // 官网: https://app.klingai.com
  // 官方 API 使用 JWT 鉴权，需要 AccessKey + SecretKey（在可灵开放平台 API Key 管理页创建）
  KLING_API_KEY: env('KLING_API_KEY'),
  KLING_ACCESS_KEY: env('KLING_ACCESS_KEY'),
  KLING_SECRET_KEY: env('KLING_SECRET_KEY'),
  KLING_BASE_URL: env('KLING_BASE_URL', 'https://api-beijing.klingai.com'),
  KLING_MODEL: env('KLING_MODEL', 'kling-v3'),

  // 阿里云百炼 / DashScope (Wan 3.0)
  // 控制台: https://bailian.console.aliyun.com
  // baseUrl 为完整 API 根地址（含 WorkspaceId 与 region）：
  //   https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1
  // 例如: https://xxxxx.cn-beijing.maas.aliyuncs.com/api/v1
  DASHSCOPE_API_KEY: env('DASHSCOPE_API_KEY'),
  DASHSCOPE_BASE_URL: env('DASHSCOPE_BASE_URL'),
  DASHSCOPE_MODEL_ID: env('DASHSCOPE_MODEL_ID', 'wan3.0-video'),

  // ===== 大语言模型（提示词优化用）=====

  // OpenAI / GPT
  OPENAI_API_KEY: env('OPENAI_API_KEY'),
  OPENAI_BASE_URL: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  OPENAI_MODEL: env('OPENAI_MODEL', 'gpt-4o-mini'),

  // 多模态模型（§9B 视觉内容质检用，需支持图像输入）
  OPENAI_MULTIMODAL_MODEL: env('OPENAI_MULTIMODAL_MODEL', env('OPENAI_MODEL', 'gpt-4o-mini')),

  // 也可以用国内模型（比如 DeepSeek、智谱等）
  // 在 .env 里把 OPENAI_BASE_URL 和 OPENAI_MODEL 换成对应的值即可
  // 例如 DeepSeek:
  //   OPENAI_BASE_URL=https://api.deepseek.com/v1
  //   OPENAI_MODEL=deepseek-chat

  // ===== 数据库 =====
  // 留空则继续使用本地 JSON 文件存储（向后兼容）
  // 填入连接串后自动切换到数据库存储
  DATABASE_URL: env('DATABASE_URL'),
  // 数据库类型: postgres | mysql | sqlite | '' (空=本地文件)
  DATABASE_TYPE: env('DATABASE_TYPE', ''),

  // ===== 对象存储（视频等大文件）=====
  // 支持 supabase | s3 | r2 | '' (空=本地磁盘)
  STORAGE_DRIVER: env('STORAGE_DRIVER', ''),
  SUPABASE_URL: env('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: env('SUPABASE_SERVICE_KEY'),
  SUPABASE_BUCKET: env('SUPABASE_BUCKET', 'videos'),
  // 自定义公开访问域名（R2 绑了自定义域，或用了 CDN 时填）
  // 留空则自动按 Supabase / S3 规则拼 URL
  STORAGE_PUBLIC_BASE_URL: env('STORAGE_PUBLIC_BASE_URL'),

  // ===== FFmpeg 路径 =====
  // 优先级：.env 显式配置 > 项目内自带 tools/ffmpeg/bin > 系统 PATH
  // 项目内自带的那份是 Windows 静态构建，随仓库一起分发（见 app/tools/ffmpeg/），
  // 好处是不依赖开发者机器上装没装 ffmpeg，也不用往系统 PATH 里塞东西。
  // 云上 Linux 容器建议留空 PATH 里 apt install ffmpeg。
  FFMPEG_PATH: env('FFMPEG_PATH') || resolveBundled('ffmpeg'),
  FFPROBE_PATH: env('FFPROBE_PATH') || resolveBundled('ffprobe'),

  // ===== 生成参数 =====
  GENERATION: {
    // 同时生成的片段数（并发数）
    concurrency: parseInt(env('GEN_CONCURRENCY', '3'), 10),
    // 最大重试次数
    maxRetries: parseInt(env('GEN_MAX_RETRIES', '1'), 10),
    // 每段视频默认时长（秒）—— 对齐 Kling 15s 档位（决策 D2）
    defaultClipDuration: parseInt(env('GEN_CLIP_DURATION', '15'), 10),
    // 默认分辨率（决策 D4）
    defaultResolution: env('GEN_RESOLUTION', '1080p')
  },

  // ===== 质检参数 =====
  QUALITY_CHECK: {
    // 黑帧检测：最小黑帧持续时间（秒）
    blackFrameMinDuration: 0.5,
    // 黑帧检测：黑像素比例阈值
    blackFrameThreshold: 0.95,
    // 模糊检测阈值（值越大越模糊）
    blurThreshold: 100,
    // NSFW 检测置信度阈值。[0,1] 内的有限小数，非法值回退 0.8（见下方 QUALITY_CHECK_NSFW_THRESHOLD）
    nsfwThreshold: nsfwThreshold(0.8)
  },

  // 质检子配置：保留 QUALITY_CHECK.nsfwThreshold 兼容既有读法，
  // 同时给 NSFW 检测一项独立的、可被 .env 覆盖的参数容器。
  QC: {
    // 合规红线：NSFW 置信度阈值，.env 里用 QC_NSFW_THRESHOLD 覆盖
    nsfwThreshold: nsfwThreshold(0.8)
  },

  // ===== 存储配置 =====
  STORAGE: {
    // 本地存储路径
    clipsDir: env('CLIPS_DIR', './clips'),
    outputDir: env('OUTPUT_DIR', './output'),
    dataDir: env('DATA_DIR', './data/tasks'),
    // S3 兼容存储配置（可选）
    s3: {
      enabled: env('S3_ENABLED', 'false') === 'true',
      accessKeyId: env('S3_ACCESS_KEY_ID'),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
      region: env('S3_REGION'),
      bucket: env('S3_BUCKET'),
      endpoint: env('S3_ENDPOINT')
    }
  },

  // ===== 服务器配置 =====
  SERVER: {
    // 云平台会注入 PORT，本地默认 3000
    port: parseInt(env('PORT', '3000'), 10),
    // 是否启用 WebSocket
    websocket: env('WEBSOCKET', 'true') === 'true',
    // 访问口令（留空=不鉴权；公网部署强烈建议设置）
    accessToken: env('ACCESS_TOKEN')
  }
};
