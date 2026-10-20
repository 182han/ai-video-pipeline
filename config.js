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

// 循环质检首尾相似度阈值：必须是 [0,1] 内的有限小数。
// 口径见 qualityChecker.checkLoop：测的是「产物末尾 vs 产物开头」的 SSIM。
// 实测参考（35s 样片）：直通 ≈0.50；真淡化 0.5s ≈0.95。
function loopSsimThreshold(fallback = 0.9) {
  const raw = env('QC_LOOP_SSIM_THRESHOLD');
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.warn(`[config] QC_LOOP_SSIM_THRESHOLD="${raw}" 非法（需 0~1 之间的数），已回退默认 ${fallback}`);
    return fallback;
  }
  return n;
}

// 无缝循环交叉淡化时长（秒）。必须 > 0 且有限；成片会比拼接产物短这个时长。
// 0.5s 是实测选定的默认值：能看出是「化过去」而非「跳过去」，
// 同时不至于让首尾两张差异大的画面出现明显双重曝光。
function loopFadeDuration(fallback = 0.5) {
  const raw = env('LOOP_FADE_DURATION');
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 10) {
    console.warn(`[config] LOOP_FADE_DURATION="${raw}" 非法（需 0~10 秒之间），已回退默认 ${fallback}`);
    return fallback;
  }
  return n;
}

// 片段间转场（交叉淡化）时长（秒）。必须 > 0 且有限。
// 成片会比「各片段时长之和」短 (N−1)×该值，这是真融合的必然代价。
// 0.5s 与循环淡化同口径：慢镜头风景里能看出「化过去」，又不至于明显双重曝光。
function transitionDuration(fallback = 0.5) {
  const raw = env('TRANSITION_DURATION');
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.1 || n > 5) {
    console.warn(`[config] TRANSITION_DURATION="${raw}" 非法（需 0.1~5 秒之间），已回退默认 ${fallback}`);
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

  // 多模态模型（§9B 视觉内容质检 / NSFW 检测用，必须支持图像输入）
  // 注意：文本模型和视觉模型常常不是同一家厂商（例如 DeepSeek 文本 + 阿里云 Qwen-VL 视觉），
  // 所以 key / baseUrl / model 三者都可以单独覆盖；留空则回退到上面的 OPENAI_*。
  MULTIMODAL_API_KEY: env('MULTIMODAL_API_KEY'),
  MULTIMODAL_BASE_URL: env('MULTIMODAL_BASE_URL'),
  OPENAI_MULTIMODAL_MODEL: env('OPENAI_MULTIMODAL_MODEL', env('OPENAI_MODEL', 'gpt-4o-mini')),

  // 也可以用国内模型（比如 DeepSeek、智谱等）
  // 在 .env 里把 OPENAI_BASE_URL 和 OPENAI_MODEL 换成对应的值即可
  // 例如 DeepSeek:
  //   OPENAI_BASE_URL=https://api.deepseek.com/v1
  //   OPENAI_MODEL=deepseek-chat
  // 再单独配视觉模型（NSFW 检测要用，DeepSeek 不支持图像输入）：
  //   MULTIMODAL_API_KEY=sk-阿里云百炼的key
  //   MULTIMODAL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
  //   OPENAI_MULTIMODAL_MODEL=qwen-vl-plus

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
    nsfwThreshold: nsfwThreshold(0.8),
    // ⚠️ 应急演示开关（默认 false）：未配置多模态 Key 时是否放行 NSFW 检测。
    // 开启后「检测未执行」会被当成通过——**生产环境必须保持关闭**，
    // 否则等于没有合规检测。仅供演示/答辩临时使用。
    nsfwAllowUnconfigured: /^(1|true|yes)$/i.test(String(process.env.QC_NSFW_ALLOW_UNCONFIGURED || '').trim()),
    // 循环质检：产物末尾 vs 开头的 SSIM 阈值，.env 用 QC_LOOP_SSIM_THRESHOLD 覆盖
    loopSsimThreshold: loopSsimThreshold(0.9),
    // 无缝循环交叉淡化时长（秒），.env 用 LOOP_FADE_DURATION 覆盖
    loopFadeDuration: loopFadeDuration(0.5)
  },

  // ===== 片段间转场（交叉淡化）=====
  // 与「首尾循环」是两件事：循环处理的是成片尾部回绕到开头，
  // 这里处理的是每两个相邻片段之间的接缝。
  //
  // 默认关闭（零回归）：开启后成片时长 = Σ片段 − (N−1)×duration，
  // 与既有「Σ片段」口径不同，所有验收/展示都要按实际返回值走。
  // 需要时在 .env 里设 TRANSITION_ENABLED=true，或按任务传 transition 配置。
  TRANSITIONS: {
    enabled: /^(1|true|yes)$/i.test(String(env('TRANSITION_ENABLED', 'false')).trim()),
    // 淡化时长（秒），.env 用 TRANSITION_DURATION 覆盖
    duration: transitionDuration(0.5),
    // xfade 转场类型，.env 用 TRANSITION_TYPE 覆盖（默认 fade = 交叉淡化）
    type: env('TRANSITION_TYPE', 'fade')
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
    // 云平台会注入 PORT；本地默认 3001。
    // 注意：默认值必须与 app/.env 的 PORT、启动.bat / 启动.ps1 里硬编码的端口、
    // 以及 AGENTS.md 的说明保持一致，否则会出现「服务起在 A 端口、脚本打开 B 端口」的空页面问题。
    port: parseInt(env('PORT', '3001'), 10),
    // 是否启用 WebSocket
    websocket: env('WEBSOCKET', 'true') === 'true',
    // 访问口令（留空=不鉴权；公网部署强烈建议设置）
    accessToken: env('ACCESS_TOKEN')
  },

  // ===== 登录墙 =====
  // 改动前请读 docs/spec/changelog.md 的「登录墙」一节：
  //   - 会话是「内存 + 无 Max-Age 的 cookie」，关浏览器/重启服务即失效；
  //   - AUTH_ENABLED=false 只应在跑验收脚本时临时使用，不要长期关闭。
  AUTH: {
    // 是否启用登录墙（默认开）。关掉时 /api/* 与页面全部放行。
    enabled: env('AUTH_ENABLED', 'true') !== 'false',
    // 会话绝对过期（小时）。cookie 本身是会话级、关浏览器即失效，这里是兜底上限。
    sessionHours: parseInt(env('AUTH_SESSION_HOURS', '8'), 10),
    // 连续失败多少次锁 IP
    maxFails: parseInt(env('AUTH_MAX_FAILS', '5'), 10),
    // 锁定分钟数
    lockMinutes: parseInt(env('AUTH_LOCK_MINUTES', '5'), 10),
    // 首次启动创建管理员用（之后以数据库/JSON 里的账号为准）
    bootstrapUser: env('AUTH_USER', ''),
    bootstrapPassword: env('AUTH_PASSWORD', ''),
    // 新建账号的密码最短长度
    minPasswordLength: parseInt(env('AUTH_MIN_PASSWORD_LENGTH', '8'), 10)
  }
};
