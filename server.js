// ==========================================
// AI 长视频自动生成流水线 - 服务端入口
// ==========================================

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ===== 日志落盘（终端 + 文件双写）=====
//
// 为什么加：服务跑在用户自己的终端里，输出只在该窗口滚动，出问题时无法事后追溯，
// 也无法把日志交给排查方（实测：2026-10-20 片段文件丢失，日志已随窗口滚走）。
// 现在同时写 data/logs/server-YYYY-MM-DD.log，终端行为完全不变。
const LOG_DIR = path.join(__dirname, 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, `server-${new Date().toISOString().slice(0, 10)}.log`);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);
function _logLine(level, args) {
  const text = args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${text}\n`); } catch (e) {}
}
console.log = (...a) => { _origLog(...a); _logLine('INFO', a); };
console.error = (...a) => { _origErr(...a); _logLine('ERROR', a); };
console.warn = (...a) => { _origWarn(...a); _logLine('WARN', a); };

const config = require('./config');
const taskManager = require('./src/taskManager');
const storage = require('./src/storage');
const auth = require('./src/auth');
const pipeline = require('./src/pipeline');
const promptOptimizer = require('./src/promptOptimizer');
const promptSkill = require('./src/promptSkill');
const { resolveResume } = require('./src/pipelineStages');
const { getAvailableModels } = require('./src/generators');
const KlingGenerator = require('./src/generators/kling');
const wsManager = require('./src/wsManager');
const qualityChecker = require('./src/qualityChecker');
const llmService = require('./src/services/llmService');
const pricing = require('./src/pricing');
const library = require('./src/library');

const app = express();
const server = http.createServer(app);
const PORT = config.SERVER.port || 3000;

// 初始化 WebSocket
// 第二个参数是「握手鉴权」：没有有效会话 cookie 就直接拒绝握手。
// 不传（或 AUTH_ENABLED=false）时行为与改造前完全一致。
wsManager.init(server, auth.isEnabled() ? { authorize: (req) => auth.authorizeRequest(req) } : null);

// 中间件
app.use(express.json());

// ===== 登录墙 =====
//
// 拦截范围（有意为之，见 docs/spec/changelog.md「登录墙」一节）：
//   页面（/ 与 *.html）  → 未登录 302 到 /login.html?next=原地址
//   /api/*              → 未登录 401 JSON（code=AUTH_REQUIRED）
//   媒体静态目录          → 不拦（/output、/clips、/bgm；本机演示够用，
//                         公网部署时必须连同这三处一起拦，否则成片可被直接下载）
//
// 放行清单：登录页本身、登录/登出接口、/api/status（Docker HEALTHCHECK 用它）。
const AUTH_PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/status']);

app.use((req, res, next) => {
  if (!auth.isEnabled()) return next();

  const p = req.path || '/';

  // 登录页必须始终可达，否则会 302 到自己形成死循环
  if (p === '/login.html') return next();

  if (p.startsWith('/api/')) {
    if (AUTH_PUBLIC_API.has(p)) return next();
    const session = auth.authorizeRequest(req);
    if (!session) return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
    req.auth = session;
    return next();
  }

  // 只拦页面；图片/字体/视频等静态资源放行
  const isPage = p === '/' || p.endsWith('.html');
  if (!isPage) return next();

  const session = auth.authorizeRequest(req);
  if (!session) {
    const target = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(302, `/login.html?next=${target}`);
  }
  req.auth = session;
  next();
});

// ===== 认证接口 =====

// 登录：失败 5 次锁 IP 5 分钟；错误提示不区分「账号不存在」与「密码错误」
app.post('/api/auth/login', async (req, res) => {
  const ip = auth.getClientIp(req);
  const lock = auth.checkLock(ip);
  if (lock.locked) {
    return res.status(429).json({
      error: `尝试次数过多，请 ${lock.retryAfter} 秒后再试`,
      code: 'LOCKED',
      retryAfter: lock.retryAfter
    });
  }

  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

  let user = null;
  try {
    // 首次启动时账号是异步创建的：先等它结束，
    // 否则「服务已就绪、账号还没建完」的窗口里登录会被判成「账号或密码错误」。
    await auth.awaitBootstrap();
    user = await auth.findUserByUsername(username);
  } catch (e) {
    // 关键：存储不可用时返回 503，绝不 fail-open
    console.error('[auth] 认证存储不可用:', e.message);
    return res.status(503).json({ error: '认证服务不可用：' + e.message, code: 'AUTH_STORAGE_DOWN' });
  }

  const ok = await auth.verifyPasswordConstant(password, user ? user.passwordHash : null);
  if (!ok) {
    const r = auth.recordFailure(ip);
    if (r.locked) {
      return res.status(401).json({ error: '尝试次数过多，已锁定', code: 'LOCKED' });
    }
    return res.status(401).json({ error: '账号或密码错误', code: 'BAD_CREDENTIALS' });
  }

  auth.resetFailures(ip);
  auth.markLogin(user.id);
  auth.setSessionCookie(res, auth.createSession(user));
  console.log(`[auth] 登录成功: ${user.username} (${ip})`);
  res.json({ ok: true, username: user.username });
});

// 登出：销毁会话 + 立即过期 cookie
app.post('/api/auth/logout', (req, res) => {
  const token = auth.tokenFromRequest(req);
  if (token) auth.destroySession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// 当前登录者（中间件已保证有会话）
app.get('/api/auth/me', (req, res) => {
  res.json({ username: req.auth.username, userId: req.auth.userId, authEnabled: true });
});

// ===== 成员管理（所有账号平权，无管理员/普通角色之分）=====

app.get('/api/users', async (req, res) => {
  try {
    const users = await storage.listUsers();
    res.json({ users, authEnabled: auth.isEnabled(), selfId: req.auth.userId });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');
    const minLen = Number(config.AUTH && config.AUTH.minPasswordLength) || 8;
    if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(username)) {
      return res.status(400).json({ error: '账号需 2–32 位，仅限字母、数字、下划线、点、@、横线' });
    }
    if (password.length < minLen) return res.status(400).json({ error: `密码至少 ${minLen} 位` });
    const passwordHash = await auth.hashPassword(password);
    const user = await storage.createUser({ username, passwordHash });
    console.log(`[auth] 新建账号: ${user.username}`);
    res.status(201).json({ user });
  } catch (e) {
    const msg = String(e.message || '新建失败');
    res.status(/已存在/.test(msg) ? 409 : 400).json({ error: msg });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const users = await storage.listUsers();
    if (users.length <= 1) return res.status(400).json({ error: '至少要保留一个账号' });
    if (req.params.id === req.auth.userId) return res.status(400).json({ error: '不能删除当前登录的账号' });
    const r = await storage.deleteUser(req.params.id);
    if (!r.success) return res.status(404).json({ error: r.error || '账号不存在' });
    auth.destroySessionsOfUser(req.params.id);
    console.log(`[auth] 删除账号: ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:id/password', async (req, res) => {
  try {
    const password = String((req.body || {}).password || '');
    const minLen = Number(config.AUTH && config.AUTH.minPasswordLength) || 8;
    if (password.length < minLen) return res.status(400).json({ error: `密码至少 ${minLen} 位` });
    const passwordHash = await auth.hashPassword(password);
    const user = await storage.updateUserPassword(req.params.id, passwordHash);
    if (!user) return res.status(404).json({ error: '账号不存在' });
    auth.destroySessionsOfUser(req.params.id);
    console.log(`[auth] 重置密码: ${user.username}`);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 静态资源（登录页在 public/login.html，由这里下发）
// 本项目没有构建步骤，改完 public/ 靠刷新生效。若浏览器缓存了旧 HTML/JS，
// 会出现「服务端已是新代码、页面还是旧行为」的假象（实测踩过：按钮还是旧文案）。
// 因此 HTML/JS/CSS 一律 no-cache，每次都回源校验。
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// 输出文件静态访问（用于视频播放和下载）
app.use('/output', express.static(path.join(__dirname, 'output'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// 片段静态访问（任务详情页的"片段列表"播放/下载用）
// 只暴露 clips 目录下的 mp4，且禁止路径穿越
app.use('/clips', express.static(path.join(__dirname, 'clips'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// ==========================================
// 配乐库存 API（§6 配乐模块）
// ==========================================

const audioMixer = require('./src/processors/audioMixer');

// 音源文件静态访问（用于库存页试听）
app.use('/bgm', express.static(path.join(__dirname, 'assets', 'bgm'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp3')) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// 获取配乐库存清单（?category=music|ambient 按大标签过滤，?mood= 按风格过滤，缺省返回全部）
// 说明：mood 仅用于筛选展示，不再参与自动选曲（主题匹配已下线）。
app.get('/api/bgm', (req, res) => {
  const mood = req.query.mood || '';
  const category = req.query.category || '';
  const prefs = audioMixer.getPrefs();
  res.json({
    categories: ['music', 'ambient'],
    categoryNames: { music: '轻音乐', ambient: '环境音' },
    moods: ['calm', 'epic', 'ethereal', 'nature'],
    moodNames: { calm: '舒缓宁静', epic: '壮阔史诗', ethereal: '空灵梦幻', nature: '自然声景' },
    total: audioMixer.getManifest().length,
    // 顺序：用户自定义顺序优先（自动配乐按此顺序接续）
    order: prefs.order,
    defaultTrackId: prefs.defaultTrackId,
    tracks: audioMixer.listTracksInOrder(category)
      .filter(t => (!mood || (t.mood || []).includes(mood)))
      .map(t => ({ ...t, category: audioMixer.listTracks(null, 'ambient').some(x => x.id === t.id) ? 'ambient' : 'music' }))
  });
});

// 波形峰值：给「添加配乐」页面画波形用。
// 为什么由服务端出：浏览器 Web Audio 的 decodeAudioData 在部分环境下不可用
// （无头浏览器、缺解码组件），导致波形永远空白。这里直接用 ffmpeg 算峰值，前端只画。
app.get('/api/bgm/waveform/:id', async (req, res) => {
  try {
    const found = audioMixer.findTrack(req.params.id);
    if (!found) return res.status(404).json({ error: '音轨不存在: ' + req.params.id });
    const waveform = require('./src/processors/waveform');
    const r = await waveform.extractPeaks(found.track.id, found.filePath);
    if (!r.ok) return res.status(500).json({ error: r.error });
    // 缓存策略：波形是静态数据，允许浏览器缓存一天
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ ok: true, trackId: found.track.id, buckets: r.buckets, peaks: r.peaks, durationSec: r.durationSec });
  } catch (e) {
    res.status(500).json({ error: '生成波形失败: ' + e.message });
  }
});

// 保存音轨顺序 / 默认开场曲（全局，影响自动配乐的起点与接续顺序）
app.put('/api/bgm/prefs', (req, res) => {
  try {
    const prefs = audioMixer.savePrefs(req.body || {});
    res.json({ success: true, ...prefs });
  } catch (e) {
    res.status(500).json({ error: '保存配乐偏好失败: ' + e.message });
  }
});

// 上传配乐入库（base64）
app.post('/api/bgm', (req, res) => {
  const result = audioMixer.addTrack(req.body || {});
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 编辑音轨元信息
app.put('/api/bgm/:id', (req, res) => {
  const result = audioMixer.updateTrack(req.params.id, req.body || {});
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json(result);
});

// 删除音轨
app.delete('/api/bgm/:id', (req, res) => {
  const result = audioMixer.removeTrack(req.params.id);
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json({ success: true });
});

// 手动混音测试接口（演示用：对指定成片叠加单曲配乐）
// 注意：已不再按主题选曲，track 传 'auto' 表示在轻音乐池随机取一首。
app.post('/api/bgm/mix', async (req, res) => {
  const { videoPath, track, loudness, fadeSeconds } = req.body || {};
  if (!videoPath || !videoPath.startsWith('output')) {
    return res.status(400).json({ error: 'videoPath 必须以 output 开头（防止路径穿越）' });
  }
  const inputVideo = path.join(__dirname, videoPath);
  if (!fs.existsSync(inputVideo)) {
    return res.status(400).json({ error: '视频文件不存在: ' + videoPath });
  }
  const outName = 'mix_' + Date.now().toString(36) + '.mp4';
  const outputPath = path.join(__dirname, 'output', outName);
  try {
    const result = await audioMixer.mixBgm(inputVideo, outputPath, {
      track: track || 'auto',
      loudness: loudness || -20,
      fadeSeconds: fadeSeconds || 2
    });
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ ...result, outputUrl: '/output/' + outName });
  } catch (e) {
    res.status(500).json({ error: '混音失败: ' + e.message });
  }
});

// ==========================================
// 整片配乐接口（2026-10-19 改造：替代逐段配乐）
// ==========================================
// 设计：浏览器只负责编辑时间轴并提交 plan（JSON），音频计算全部在服务端 ffmpeg 完成，
// 因此「预览听到的」与「导出的」由同一引擎产生，天然一致。

// 已完成任务列表（「添加配乐」页面用它渲染卡片）
app.get('/api/tasks/completed', (req, res) => {
  const tasks = taskManager.getAllTasks()
    .filter(t => ['completed', 'partial'].includes(t.status) && t.outputPath)
    .map(t => ({
      taskId: t.taskId,
      prompt: t.prompt,
      status: t.status,
      model: t.model,
      totalClips: t.totalClips,
      clipDuration: t.clipDuration,
      resolution: t.resolution,
      totalDuration: t.totalDuration || null,
      outputPath: t.outputPath,
      outputUrl: '/output/' + path.basename(t.outputPath),
      hasBgm: !!(t.bgmResult && t.bgmResult.applied),
      bgm: t.bgm || null,
      completedAt: t.completedAt,
      createdAt: t.createdAt
    }));
  res.json({ total: tasks.length, tasks });
});

// 读取任务的配乐计划
app.get('/api/tasks/:id/bgm-plan', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({
    taskId: task.taskId,
    bgm: task.bgm || null,
    plan: task.bgmPlan || null,
    result: task.bgmResult || null,
    totalDuration: task.totalDuration || null,
    masterPath: task.masterPath || null,
    videoUrl: task.outputPath ? '/output/' + path.basename(task.outputPath) : null
  });
});

// 保存配乐计划（不触发出片，仅落库）
app.put('/api/tasks/:id/bgm-plan', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const normalized = pipeline._normalizePlan((req.body || {}).plan, task);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  taskManager.updateTaskStatus(task.taskId, task.status, { bgmPlan: normalized.plan });
  res.json({ success: true, plan: normalized.plan });
});

// 生成自动配乐草稿（供「添加配乐」页面的初始填充，不落库）
app.post('/api/tasks/:id/bgm-auto-plan', async (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  try {
    const prep = await pipeline._ensureBgmPlan(task.taskId, task, { force: true });
    if (!prep.ok) return res.status(400).json({ ok: false, error: prep.error });
    res.json({ ok: true, plan: prep.plan, source: prep.source, warnings: prep.warnings || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: '生成自动配乐失败: ' + e.message });
  }
});

// 预览：按 plan 渲染，输出临时文件，**不覆盖原成片**
app.post('/api/tasks/:id/bgm-preview', async (req, res) => {
  const { plan } = req.body || {};
  try {
    const result = await pipeline.reapplyBgm(req.params.id, plan, { dryRun: true });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({
      success: true,
      previewUrl: '/output/' + path.basename(result.previewPath),
      duration: result.duration,
      notice: '这是预览文件，确认后再导出覆盖原成片'
    });
  } catch (e) {
    res.status(500).json({ error: '配乐预览失败: ' + e.message });
  }
});

// 导出：按 plan 混音并覆盖原成片（内部先写临时文件，校验通过才替换）
app.post('/api/tasks/:id/audio', async (req, res) => {
  const { plan } = req.body || {};
  try {
    const result = await pipeline.reapplyBgm(req.params.id, plan, { dryRun: false });
    if (!result.success) return res.status(400).json({ error: result.error });
    const outUrl = result.outputPath ? '/output/' + path.basename(result.outputPath) : null;
    res.json({ ...result, outputUrl: outUrl });
  } catch (e) {
    res.status(500).json({ error: '配乐导出失败: ' + e.message });
  }
});

// 逐段改配乐：已下线。保留路由并明确返回，避免老前端静默失败。
app.post('/api/tasks/:id/clips/:index/audio', (req, res) => {
  res.status(410).json({
    error: '逐段配乐已下线，请使用「添加配乐」页面（POST /api/tasks/:id/audio）',
    deprecated: true
  });
});

// ==========================================
// API 路由
// ==========================================

// 获取可用模型列表
app.get('/api/models', (req, res) => {
  res.json(getAvailableModels());
});

// 测试 API Key 是否有效
app.post('/api/test-api-key', async (req, res) => {
  const { type, apiKey, baseUrl, model, accessKey, secretKey } = req.body;

  if (!apiKey && !(type === 'kling' && accessKey && secretKey)) {
    return res.json({ success: false, error: '请输入 API Key' });
  }

  try {
    // ===== 多模态（NSFW 检测 / 视觉质检）专用测试 =====
    // 需要两步验证：① /models 确认 key 有效 ② 真发一张图确认「能看图」。
    // 只测 /models 不够——纯文本模型（如 DeepSeek）也能列出模型，但发图会 400。
    if (type === 'multimodal') {
      const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

      // 步骤 1：列出可用模型
      let models = [];
      try {
        const r1 = await fetch(base + '/models', {
          headers: { Authorization: 'Bearer ' + apiKey }
        });
        if (!r1.ok) {
          const t = await r1.text().catch(() => '');
          return res.json({
            success: false,
            error: `Key 或地址有误：${base}/models 返回 HTTP ${r1.status} ${t.slice(0, 120)}`
          });
        }
        const d1 = await r1.json().catch(() => ({}));
        models = (d1.data || d1.models || []).map(m => m.id || m.name).filter(Boolean);
      } catch (e) {
        return res.json({ success: false, error: '无法连接 ' + base + '：' + e.message });
      }

      // 步骤 2：挑选视觉模型
      // 优先级：qwen-vl 系列 > 其他 vlm > 带 vision/4v 的；排除 realtime/audio/tts/asr 等非图像模型
      let target = (model || '').trim();
      if (!target) {
        const isVision = m => /(-vl-|-vl$|vl-max|vl-plus|vision|4v)/i.test(m);
        const isExcluded = m => /realtime|audio|tts|asr|speech|embedding|rerank|text-embedding|ocr/i.test(m);
        const candidates = models.filter(m => isVision(m) && !isExcluded(m));
        if (candidates.length === 0) {
          return res.json({
            success: false,
            error: '该账号下未发现可用的图像理解模型。'
              + '请在「多模态模型名称」里手动填写一个视觉模型（如 qwen-vl-plus）。'
              + '当前账号可用模型共 ' + models.length + ' 个：' + models.slice(0, 30).join(', ')
          });
        }
        // 优先选 name 里带 vl 的，其次短的（通常是主力模型）
        candidates.sort((a, b) => {
          const av = /vl/i.test(a) ? 0 : 1;
          const bv = /vl/i.test(b) ? 0 : 1;
          if (av !== bv) return av - bv;
          return a.length - b.length;
        });
        target = candidates[0];
      }

      // 步骤 3：真实发一张 1x1 图，验证图像输入能力
      // 测试图必须满足视觉模型的尺寸下限（1x1 会被拒：image length and width do not meet restrictions）
      // 用 zlib 现场生成一张 128x128 渐变 PNG，避免在代码里塞一长串 base64
      const PNG_TEST = (() => {
        const zlib = require('zlib');
        const W = 128, H = 128;
        const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(W, 0);
        ihdr.writeUInt32BE(H, 4);
        ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
        // 两色块 + 边框：内容足够「像一张图」，同时 deflate 压缩率高（base64 只几百字符）
        const raw = Buffer.alloc(H * (1 + W * 3));
        let o = 0;
        for (let y = 0; y < H; y++) {
          raw[o++] = 0;
          for (let x = 0; x < W; x++) {
            const border = x < 6 || y < 6 || x >= W - 6 || y >= H - 6;
            if (border) {
              raw[o++] = 30; raw[o++] = 60; raw[o++] = 120;
            } else if (x < W / 2) {
              raw[o++] = 210; raw[o++] = 120; raw[o++] = 60;
            } else {
              raw[o++] = 90; raw[o++] = 160; raw[o++] = 210;
            }
          }
        }
        const idat = zlib.deflateSync(raw);
        const T = (() => { const t = []; for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; t[n] = v >>> 0; } return t; })();
        const crc32 = b => { let v = 0xffffffff; for (const x of b) v = T[(v ^ x) & 0xff] ^ (v >>> 8); return (v ^ 0xffffffff) >>> 0; };
        const ch = (ty, d) => {
          const L = Buffer.alloc(4); L.writeUInt32BE(d.length, 0);
          const t = Buffer.from(ty, 'ascii');
          const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([t, d])), 0);
          return Buffer.concat([L, t, d, cr]);
        };
        return Buffer.concat([sig, ch('IHDR', ihdr), ch('IDAT', idat), ch('IEND', Buffer.alloc(0))]).toString('base64');
      })();
      try {
        const r2 = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: target,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Reply with the single word: OK' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG_TEST } }
              ]
            }],
            max_tokens: 8
          })
        });
        if (!r2.ok) {
          const t = await r2.text().catch(() => '');
          // 把常见错误码翻成可执行的中文，别把原始 JSON 直接甩给用户
          let hint = '请在「多模态模型名称」里手动指定一个图像理解模型';
          if (r2.status === 403 && /Model\.AccessDenied/i.test(t)) {
            hint = `模型「${target}」未开通，或该账号/业务空间没有它的权限。`
              + '先确认地址是「带 WorkspaceId 的专属接入点」：'
              + 'https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1'
              + '（旧的通用入口 dashscope.aliyuncs.com/compatible-mode/v1 对业务空间 Key 会报这个错）；'
              + '地址无误再去百炼控制台「模型广场」开通该模型，或改填 qwen-vl-plus / qwen-vl-max 再测。';
          } else if (r2.status === 401 || /InvalidApiKey|invalid_api_key/i.test(t)) {
            hint = 'Key 无效或已过期，请到控制台重新创建。';
          } else if (r2.status === 404 || /model[^a-z]*(not[^a-z]*found|does[^a-z]*not[^a-z]*exist)/i.test(t)) {
            hint = `模型名「${target}」在这个账号下不存在，改填下面列表里的一个。`;
          } else if (r2.status === 429 || /quota|rate[_\s-]?limit/i.test(t)) {
            hint = '额度或限流问题：检查账户余额与并发限制。';
          }

          // 只把「能看图的」模型给用户参考，OCR / 语音 / 向量模型不适合做 NSFW 质检
          const usable = models.filter((m) => /(-vl-|-vl$|vl-max|vl-plus|vision|4v)/i.test(m)
            && !/ocr|realtime|audio|tts|asr|speech|embedding|rerank/i.test(m));

          return res.json({
            success: false,
            error: `模型 ${target} 图像调用失败 HTTP ${r2.status}：${t.slice(0, 120)}。`,
            hint,
            models: usable.length ? usable : models,
            triedModel: target,
            status: r2.status,
          });
        }
        const d2 = await r2.json().catch(() => ({}));
        const reply = d2.choices && d2.choices[0] && d2.choices[0].message
          ? d2.choices[0].message.content
          : '';
        return res.json({
          success: true,
          message: `多模态可用（模型 ${target}，已通过图像调用验证）`,
          model: target,
          modelCount: models.length,
          sampleReply: String(reply || '').slice(0, 30)
        });
      } catch (e) {
        return res.json({ success: false, error: '图像调用异常：' + e.message });
      }
    }

    let url = '';
    let method = 'POST';
    let body = null;
    let headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    if (type === 'agnes') {
      url = (baseUrl || 'https://apihub.agnes-ai.com/v1') + '/videos';
      body = JSON.stringify({
        model: 'agnes-video-2.5',
        prompt: 'test',
        seconds: '5',
        mode: 'text',
        size: '720P',
        aspect_ratio: '16:9'
      });
    } else if (type === 'seedance') {
      const sdBaseUrl = baseUrl || 'https://ark.volcengine.com/api/v3';
      const isVolcengine = sdBaseUrl.includes('volcengine.com') || sdBaseUrl.includes('ark.cn');
      if (isVolcengine) {
        // 火山引擎官方 API
        url = sdBaseUrl + '/contents/generations/tasks';
        body = JSON.stringify({
          model: model || 'doubao-seedance-2.0-mini-250928',
          content: [{ type: 'text', text: 'test' }],
          parameters: { ratio: '16:9', duration: '5', resolution: '480p' }
        });
      } else {
        // 第三方中转
        url = sdBaseUrl + '/videos/generations';
        body = JSON.stringify({
          model: model || 'seedance-2.5',
          prompt: 'test',
          duration: 5,
          quality: '480p',
          aspect_ratio: '16:9'
        });
      }
    } else if (type === 'kling') {
      // 可灵官方 API 使用 JWT(ak/sk) 鉴权；用任务列表查询验证 Key，不消耗生成额度
      if (!accessKey || !secretKey) {
        return res.json({ success: false, error: '可灵需要同时填写 AccessKey 和 SecretKey' });
      }
      const klingBaseUrl = (baseUrl || 'https://api-beijing.klingai.com').replace(/\/+$/, '');
      url = klingBaseUrl + '/v1/videos/text2video?pageNum=1&pageSize=1';
      method = 'GET';
      delete headers['Content-Type'];
      try {
        headers['Authorization'] = 'Bearer ' + KlingGenerator.generateJwt(accessKey, secretKey);
      } catch (jwtErr) {
        return res.json({ success: false, error: jwtErr.message });
      }
    } else if (type === 'siliconflow') {
      // 硅基流动用 models 列表测试，不消耗额度
      url = (baseUrl || 'https://api.siliconflow.cn/v1') + '/models';
      method = 'GET';
      delete headers['Content-Type'];
    } else if (type === 'dashscope') {
      // DashScope 无列表接口；用不存在 task_id 的查询验证鉴权（不消耗生成额度）
      // 鉴权失败 → 401/403（判 Key 无效）；鉴权通过 → InvalidTask 类错误（判 Key 有效）
      const dsBaseUrl = (baseUrl || '').replace(/\/+$/, '');
      if (!dsBaseUrl) {
        return res.json({ success: false, error: '请先填写 WorkspaceId / Region（Base URL）' });
      }
      url = dsBaseUrl + '/tasks/invalid-task-check';
      method = 'GET';
      delete headers['Content-Type'];
    } else if (type === 'llm') {
      // LLM 用 models 列表测试，不消耗 token
      url = (baseUrl || 'https://api.openai.com/v1') + '/models';
      method = 'GET';
      delete headers['Content-Type'];
    } else {
      return res.json({ success: false, error: '未知的测试类型' });
    }

    const options = { method, headers };
    if (body) options.body = body;

    const response = await fetch(url, options);
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) {}

    if (response.ok) {
      res.json({ success: true, message: '连接成功，API Key 有效' });
    } else {
      // 非 401 错误说明 Key 是对的，只是参数或额度问题
      const status = response.status;
      let errorMsg = data.error?.message || data.message || data.error || `HTTP ${status}`;
      if (typeof errorMsg === 'object') errorMsg = JSON.stringify(errorMsg).substring(0, 200);
      if (errorMsg.length > 200) errorMsg = errorMsg.substring(0, 200) + '...';

      if (status === 401 || status === 403) {
        // 401/403 是鉴权失败，Key 无效
        // LLM 场景最常见的原因是「Key 与地址不匹配」：地址留空会回落到 .env 的 OpenAI，
        // 于是 DeepSeek 的 Key 被发到 api.openai.com，必然 401。把实际请求地址带出来。
        if (type === 'llm') {
          const used = url.replace(/\/models$/, '');
          return res.json({
            success: false,
            error: errorMsg
              + '｜提示：地址与 Key 必须同属一家。本次实际请求 ' + used
              + '（地址留空会回落到 OpenAI）；DeepSeek 的 Key 需配 https://api.deepseek.com/v1 + deepseek-chat。',
            urlUsed: used,
          });
        }
        res.json({ success: false, error: errorMsg });
      } else if (/workspace endpoint is invalid|invalid endpoint|接入点无效/i.test(errorMsg)) {
        // 业务空间 ID / Region 配错：请求没走到鉴权，配置本身就是错的
        res.json({ success: false, error: '接入点无效，请检查 WorkspaceId 与 Region：' + errorMsg });
      } else {
        // 其他错误说明 Key 有效（可能是额度不足、参数错误等）
        res.json({ 
          success: true, 
          message: 'Key 有效（注意：' + errorMsg + '）',
          warning: errorMsg
        });
      }
    }
  } catch (e) {
    res.json({ success: false, error: '网络错误: ' + e.message });
  }
});

// 获取系统状态
app.get('/api/status', (req, res) => {
  const videoProcessor = require('./src/videoProcessor');
  res.json({
    ffmpegAvailable: videoProcessor.hasFFmpeg,
    websocketEnabled: config.SERVER.websocket,
    models: getAvailableModels(),
    llmConfigured: !!config.OPENAI_API_KEY
  });
});

// 获取主题列表
app.get('/api/themes', (req, res) => {
  res.json(promptOptimizer.getThemes());
});

// 获取模板详情
app.get('/api/templates/:id', (req, res) => {
  const template = promptOptimizer.getTemplate(req.params.id);
  if (!template) {
    return res.status(404).json({ error: '模板不存在' });
  }
  res.json(template);
});

// 新增模板
app.post('/api/templates', (req, res) => {
  const { id, name, keywords, styleEnhancers, negative } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: '模板ID和名称必填' });
  }
  const result = promptOptimizer.addTemplate(id, { name, keywords, styleEnhancers, negative });
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 更新模板
app.put('/api/templates/:id', (req, res) => {
  const result = promptOptimizer.updateTemplate(req.params.id, req.body);
  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }
  res.json(result);
});

// 删除模板
app.delete('/api/templates/:id', (req, res) => {
  const result = promptOptimizer.deleteTemplate(req.params.id);
  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }
  res.json({ success: true });
});

// 获取通用提示词优化规则（全局系统提示，独立于主题模板库）
app.get('/api/rules', (req, res) => {
  res.json({ rules: promptOptimizer.getRules() });
});

// 更新通用提示词优化规则
app.put('/api/rules', (req, res) => {
  const { rules } = req.body;
  if (!rules) {
    return res.status(400).json({ error: '规则内容不能为空' });
  }
  promptOptimizer.updateRules(rules);
  res.json({ success: true });
});

// 优化提示词
app.post('/api/optimize-prompt', async (req, res) => {
  const { prompt, theme, llmApiKey, llmBaseUrl, llmModel } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: '请输入提示词' });
  }

  try {
    // 先做质检
    const validation = promptOptimizer.validatePrompt(prompt, theme);

    // 主题解析：显式传入优先，其次读行尾【主题】标签
    // （此前前端固定传 theme:null 且只走模板，模板在无主题时原样返回 → 按钮实际是空操作）
    const parsed = promptOptimizer.parseThemeTag(prompt, theme ?? null);
    const useTheme = theme || parsed.themeId;

    const apiKey = llmApiKey || config.OPENAI_API_KEY;
    let result;
    if (apiKey) {
      // AI 优化路径：会叠加 fengguang skill 规则（仅风光类主题）
      result = await promptOptimizer.optimizeWithAI(prompt, useTheme, {
        apiKey,
        baseUrl: llmBaseUrl,
        model: llmModel,
      });
    } else {
      result = promptOptimizer.optimizeWithTemplate(prompt, useTheme);
    }

    res.json({
      ...result,
      validation,
      themeResolved: useTheme || null,
      // 无主题又无 Key 时模板不改写任何内容，明确告知原因，避免误以为按钮坏了
      hint: (!useTheme && !apiKey)
        ? '未识别主题：请在行尾加【山】【沙漠】【星空】等标签，或在设置里配置 LLM Key 走 AI 优化'
        : null,
    });
  } catch (e) {
    console.error('[optimize-prompt] 失败:', e.message);
    res.status(500).json({ error: '优化失败：' + e.message });
  }
});

// ==========================================
// 提示词助手（网页内悬浮球的多轮对话）
// 契约：docs/requirements/提示词助手悬浮球-需求.md
// 一律 HTTP 200，用 ok 字段区分成败，前端按 error 码展示。
// Key 只走请求体、绝不落日志。
// ==========================================
const ASSISTANT_SYSTEM_PROMPT = `你是「视频提示词助手」，为用户产出 AI 视频生成提示词。
用户常常不知道自己要拍什么，你的任务是用尽量少的对话，帮他把画面想清楚。

【背景】
这些画面最后会当屏保长时间循环播放，要看起来像真实拍摄出来的影像。

【画面里不能出现这些东西】
以下任何一项出现，这段提示词就作废，必须避开：
1. 人物 —— 人脸、手、身体、人群、人形剪影、皮肤特写
2. 动物 —— 任何动物（本阶段一律不做）
3. 室内 —— 房间、店铺、茶馆、咖啡馆、教室、办公室等室内空间
4. 生活物件 —— 杯子、茶具、书、餐具、家具、日用品
5. 文字 —— 招牌、字幕、logo、水印、任何可读文字
6. 城市 —— 城市夜景、建筑群、街道、车流、天际线
7. 抽象与图形 —— 抽象几何、色块、线条图案、纯色背景、渐变背景、万花筒
8. 科幻与数字特效 —— 科幻场景、赛博朋克、全息、粒子光效、能量场、CG 渲染、数字艺术
9. 微距 —— 水滴特写、露珠、叶脉、细胞、微观世界

除这 9 条之外不设别的限制。

【跑题怎么办】
用户想要的东西落在上面 9 条里时，不要照做。用一句话说明这些东西不能出现，
然后换 2-3 个能避开它们的替代方向，继续往下聊。

【对话规则】
1. 每轮只问 1 个最关键的问题，不要连环追问。
2. 要给选项时给 2-4 个，降低回答成本。
3. 需要收集：主体、时段/光线、运镜、情绪氛围。集齐就停止提问。
4. 用户已经说清楚时，不要为了走流程继续问，直接给结果。
5. 用户说"随便""不知道"时，给 2-3 个具体方向让他选。
6. 产出时先用一句中文说明为什么这么写，再给中文提示词。
7. 中文提示词按七段组织：主体（地貌专名）+ 运动 + 运镜 + 光线 + 氛围 + 质感 + 结尾留白。

【写完自检】
给出 prompt 之前检查一遍，里面有上面 9 条里的东西就重写，不要把违规内容交出去。

【输出格式】必须只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字：
{"ready": false, "message": "你这一轮要说的中文话", "prompt": null}
- ready=false：还在提问阶段，prompt 必须为 null
- ready=true：已经给出可用提示词，prompt 填中文提示词字符串
`;

// 画面禁用项：与服务端 system prompt 对齐，作为 LLM 不听话时的硬兜底。
// 命中即不返回可用提示词——宁可让用户再聊一轮，也不让跑题的提示词进流水线烧钱。
//
// 设计原则（2026-10-20 实测修订）：宁可放宽，也不要误杀真实风光。
// 已修的误杀：
//   - silhouette：原在人物列表里，导致 "mountain silhouettes"（山影）被判有人物。
//     现改为只拦「人 + 剪影」组合。
//   - face：原在人物列表里，导致 "rock face / cliff face"（岩壁）被判有人物。
//     已移除——真有人脸时必然伴随 person/man/woman 等词，由那些词兜住。
//   - table / bowl / plate：会误伤 "table mountain"（桌山）、"bowl-shaped valley"（盆状谷）、
//     "tectonic plate"（板块）。现收窄成明确的器物组合。
const ASSISTANT_FORBIDDEN = [
  { why: '人物',
    re: /\b(people|person|persons|man|men|woman|women|child|children|girl|boy|baby|human|humans|portrait|hand|hands|finger|fingers|crowd|skin)\b/i },
  // 人物剪影单独判：只有"人+silhouette"才算，山影/树影放行
  { why: '人物',
    re: /\b(?:person|people|humans?|man|woman|child|figure|body)\s+silhouettes?\b|\bsilhouettes?\s+of\s+(?:a\s+|an\s+|the\s+)?(?:person|people|humans?|man|woman|child|figure|body)\b/i },
  { why: '动物',
    re: /\b(animal|animals|dog|dogs|cat|cats|bird|birds|horse|horses|monkey|monkeys|deer|wildlife|fish|insect|insects|wolf|bear|elephant|tiger|lion)\b/i },
  { why: '室内场景',
    re: /\b(indoor|indoors|interior|room|rooms|cafe|teahouse|tearoom|restaurant|shop|store|office|classroom|kitchen|bedroom|library)\b/i },
  { why: '生活物件',
    re: /\b(cup|cups|teapot|teacup|tea|coffee|mug|bottle|book|books|desk|chairs?|furniture|vase)\b|\b(?:dining|coffee|wooden|kitchen|side)\s+tables?\b|\bbowls?\s+of\b/i },
  { why: '文字或标识',
    re: /\b(text|texts|watermark|watermarks|logo|logos|sign|signs|signage|subtitle|subtitles|lettering|typography)\b/i },
  { why: '城市景观',
    re: /\b(city|cityscape|skyline|urban|street|streets|downtown|skyscraper|skyscrapers|traffic|car|cars|building|buildings)\b/i },
  // 第 7-9 条：抽象/科幻/微距——这三类做出来"一眼是合成的"，放进来会破坏"像真实拍摄"
  { why: '抽象与图形',
    re: /\b(abstract|geometric|geometrical|kaleidoscope|colou?r field|solid colou?r|graphic art|vector art|minimal shapes?|lines and shapes?)\b/i },
  // 注意：不拦 "gradient" 本身（"sunset gradient in the sky" 是合法风光描述），只拦"渐变背景"这类合成感说法
  { why: '纯色或渐变背景',
    re: /\b(?:gradient|solid colou?r|plain|flat|blank)\s+background\b/i },
  { why: '科幻与数字特效',
    re: /\b(sci-?fi|science fiction|cyberpunk|hologram|holographic|light particles?|glowing particles?|energy field|energy beam|digital art|cgi|3d render|futuristic)\b/i },
  // 微距：只拦明确的微距术语与"叶面水滴"这类组合，不拦瀑布里的 water droplets spraying
  { why: '微距',
    re: /\b(macro|microscopic|microscopy|micro world|cellular|dewdrops?|leaf veins?)\b|\bdroplets?\s+on\b/i }
];

// 检测前先剥掉「否定式负面词」。
// 项目模板的收尾句就是 "No people, no vehicles — just the landscape holding still"，
// 这类写法是在**要求不要出现**，不能当成违规内容误杀。
// 三层剥离，覆盖英文里所有常见的否定写法：
//   1) no/without/zero/free of/free from + 名词短语（从否定词剥到子句结束）
//   2) no-people / non-human 这类连字符否定前缀
//   3) people-free / human-free（-free 后缀）与 peopleless / textless（-less 后缀）
const NEGATION_RE = /\b(?:no|without|zero|free of|free from)\s+[^.;,—]{0,60}/gi;
const HYPHEN_NEG_RE = /\b(?:no|non|anti)[-\s](?:people|persons?|humans?|animals?|texts?|logos?|watermarks?|signs?|cars?|vehicles?|buildings?|city|urban)\b/gi;
const FREE_SUFFIX_RE = /\b(?:people|persons?|humans?|animals?|texts?|logos?|watermarks?|signs?|cars?|vehicles?|buildings?|city|urban)[-\s](?:free|less)\b/gi;
const LESS_SUFFIX_RE = /\b(?:people|person|human|animal|text|logo|watermark|sign|car|vehicle|building)less\b/gi;

function stripNegations(s) {
  return String(s)
    .replace(NEGATION_RE, ' ')
    .replace(HYPHEN_NEG_RE, ' ')
    .replace(FREE_SUFFIX_RE, ' ')
    .replace(LESS_SUFFIX_RE, ' ');
}

// 检查顺序：越具体的排越前，命中提示更贴近用户看到的画面。
// 返回所有命中的禁用项名称数组；未命中返回空数组。
function findForbidden(promptText) {
  const cleaned = stripNegations(promptText);
  return ASSISTANT_FORBIDDEN
    .filter(f => f.re.test(cleaned))
    .map(f => f.why);
}

app.post('/api/assistant/chat', async (req, res) => {
  const { messages, llmApiKey, llmBaseUrl, llmModel } = req.body || {};

  // ---- 参数校验 ----
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(200).json({ ok: false, error: 'BAD_REQUEST', message: 'messages 必须是非空数组' });
  }

  // 只允许 user / assistant，过滤其它角色
  let history = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content }));

  if (history.length === 0) {
    return res.status(200).json({ ok: false, error: 'BAD_REQUEST', message: '没有有效的对话内容' });
  }

  // 最多保留最近 20 条
  if (history.length > 20) history = history.slice(-20);

  // 总字符上限 20000，超出从头截断（整条丢弃，不切半条）
  const MAX_CHARS = 20000;
  let total = history.reduce((n, m) => n + m.content.length, 0);
  while (total > MAX_CHARS && history.length > 1) {
    total -= history[0].content.length;
    history.shift();
  }

  // ---- 前置检查：没有 Key 直接返回，不发请求 ----
  const llmCfg = { apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel };
  if (!llmApiKey && !config.OPENAI_API_KEY) {
    return res.status(200).json({ ok: false, error: 'NO_LLM_KEY' });
  }

  // ---- 调用 LLM ----
  // 2026-10-20：叠加 fengguang skill 规则（摄影级风光）
  // 助手的产出物全是自然风光（9 条禁用项里已排除城市/人物/动物），所以整段追加，不按主题过滤。
  // SKILL_PROMPT_ENABLED=false 可整体关闭，回退到原助手行为。
  const assistantSystem = promptSkill.isEnabled()
    ? `${ASSISTANT_SYSTEM_PROMPT}\n\n${promptSkill.getSkillRules()}\n`
    : ASSISTANT_SYSTEM_PROMPT;
  const raw = await llmService.chatMulti(assistantSystem, history, llmCfg);
  if (!raw) {
    return res.status(200).json({
      ok: false,
      error: 'LLM_FAILED',
      message: '助手没有响应，请检查网络或 API Key 后重试'
    });
  }

  // ---- 解析 JSON（容错 markdown 代码块 / 前后废话） ----
  let parsed = null;
  try {
    const s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) parsed = JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    parsed = null;
  }

  if (!parsed || typeof parsed.message !== 'string') {
    // 模型没按格式输出：把原文当成普通消息返回，不判定为失败
    return res.status(200).json({ ok: true, ready: false, message: raw, prompt: null });
  }

  const ready = parsed.ready === true;
  const prompt = ready && typeof parsed.prompt === 'string' && parsed.prompt.trim()
    ? parsed.prompt.trim()
    : null;

  // ---- 输出端硬校验：LLM 自检不可靠，这里再拦一道 ----
  // 命中禁用项就不把 prompt 交出去，避免跑题内容直接进流水线（生成按秒计费）。
  if (prompt) {
    const hits = findForbidden(prompt);
    if (hits.length) {
      // 留痕：出误杀时能凭日志还原「是哪个词触发的」，不要再靠猜
      console.warn(`[assistant] 拦截 ${hits.join('、')} | prompt=${prompt.slice(0, 300)}`);
      return res.status(200).json({
        ok: true,
        ready: false,
        rejected: hits,
        // 只说明命中了哪条禁令，不列举"应该做什么"——避免变相白名单。
        message: `这个方向里有「${hits.join('、')}」，这些不能出现，换个方向吧。`,
        prompt: null
      });
    }
  }

  res.status(200).json({
    ok: true,
    // ready 只在真的拿到提示词时才算数，防止模型说 ready 却没给正文
    ready: !!(ready && prompt),
    message: parsed.message,
    prompt
  });
});

// 创建任务
app.post('/api/tasks', (req, res) => {
  const { prompt, prompts, clipTracks, bgm, model, theme, clipCount, totalClips, resolution, clipDuration, apiKey, apiBaseUrl, modelId: genModelId, klingAccessKey, klingSecretKey, llmApiKey, llmBaseUrl, llmModel, multimodalApiKey, multimodalBaseUrl, multimodalModel, strictQcItems, preset, stages, transition } = req.body;

  // 多提示词模式（§10A）：支持 { text, theme } 对象数组，兼容旧格式字符串数组
  // 字符串行自动解析行尾【主题】标签（§10B）；无标签/未识别 → theme 为 null（无主题，只走通用规则）
  let multiPrompts = null;
  if (Array.isArray(prompts)) {
    multiPrompts = prompts
      .map(p => {
        if (typeof p === 'string') {
          const parsed = promptOptimizer.parseThemeTag(p.trim(), theme ?? null);
          if (!parsed.text) return null;
          return {
            text: parsed.text,
            theme: parsed.themeId,
            tag: parsed.tag,
            matched: parsed.matched
          };
        }
        if (p && typeof p === 'object') {
          const text = String(p.text || '').trim();
          if (!text) return null;
          return {
            text,
            theme: p.theme || null,
            tag: p.tag || null,
            matched: p.matched !== false
          };
        }
        return null;
      })
      .filter(Boolean);
    if (multiPrompts.length === 0) multiPrompts = null;
  }

  if ((!prompt || !prompt.trim()) && !multiPrompts) {
    return res.status(400).json({ error: '请输入提示词' });
  }

  // 校验模型是否存在
  const availableModels = getAvailableModels();
  const modelId = model || 'mock';
  // Mock 模型永远可用；真实模型即使没配 Key 也允许（前端传了 Key 就行）
  const modelExists = availableModels.some(m => m.id === modelId);
  if (!modelExists) {
    return res.status(400).json({ error: '不支持的模型: ' + modelId });
  }

  // 校验片段数量（多提示词模式下以行数为准）
  const count = multiPrompts ? multiPrompts.length : (clipCount || totalClips || 10);
  if (count < 1 || count > 200) {
    return res.status(400).json({
      error: '片段数量必须在 1-200 之间' + (multiPrompts ? `（当前输入了 ${multiPrompts.length} 行提示词）` : '')
    });
  }

  // 校验单段时长
  const duration = clipDuration || config.GENERATION.defaultClipDuration || 15;
  if (duration < 1 || duration > 60) {
    return res.status(400).json({ error: '单段时长必须在 1-60 秒之间' });
  }

  // 创建任务（多提示词模式下 prompt 取第一行文本，各片段提示词/主题由 prompts 逐一分配）
  const firstPrompt = prompt || (multiPrompts ? multiPrompts[0].text : '') || '';
  const task = taskManager.createTask(firstPrompt.trim(), {
    model: modelId,
    theme: theme ?? null,
    totalClips: count,
    resolution: resolution || config.GENERATION.defaultResolution || '720p',
    clipDuration: duration,
    prompts: multiPrompts,
    // 流水线档位：不传则 final（全量 8 步，与旧行为一致）。
    // stages 仅在 preset='custom' 时有意义。
    // 注意：早前这里没接这两个字段，前端传 preset 会被静默忽略、永远跑全量
    // ——档位功能等于没通到 API。
    preset: preset || undefined,
    stages: Array.isArray(stages) ? stages : undefined,
    // 配乐：整片级配置（取代旧的逐段 clipTracks）
    bgm,
    // 片段间转场：{ enabled, duration, type }。不传/传 null → 用 config.TRANSITIONS 全局默认。
    // 注意：漏掉这一行会让前端勾选被静默忽略（与早前 preset 字段同样的坑）。
    transition: (transition && typeof transition === 'object') ? transition : null,
    // 兼容：老前端仍传 clipTracks 时保留透传，由 createTask 收敛为整片主曲
    clipTracks: Array.isArray(clipTracks) ? clipTracks.slice(0, count) : undefined,
    // 保存前端传入的 API 配置（运行时使用）
    runtimeConfig: {
      apiKey: apiKey || '',
      apiBaseUrl: apiBaseUrl || '',
      modelId: genModelId || '',
      klingAccessKey: klingAccessKey || '',
      klingSecretKey: klingSecretKey || '',
      llmApiKey: llmApiKey || '',
      llmBaseUrl: llmBaseUrl || '',
      llmModel: llmModel || '',
      // §9B 视觉内容质检用多模态配置（缺省时回退到 llm* 再回退到 config.OPENAI_*）
      multimodalApiKey: multimodalApiKey || '',
      multimodalBaseUrl: multimodalBaseUrl || '',
      multimodalModel: multimodalModel || '',
      // 用户勾选的「要紧质检项」；null/空 = 全部要紧。NSFW 由质检内部锁定。
      strictQcItems: Array.isArray(strictQcItems) && strictQcItems.length ? strictQcItems : null
    }
  });

  // 启动流水线
  pipeline.startTask(task.taskId);

  res.json({
    taskId: task.taskId,
    status: task.status
  });
});

// 获取质检项定义
app.get('/api/qc-items', (req, res) => {
  res.json({
    qcItems: qualityChecker.getQCItems(),
    pipelineSteps: taskManager.getPipelineSteps()
  });
});

// 获取任务列表
app.get('/api/tasks', (req, res) => {
  const tasks = taskManager.getAllTasks();
  res.json(tasks.map(t => {
    // 完整多段提示词：新任务用持久化 prompts，老任务（无 prompts 字段）回退各片段 prompt
    let promptLines = null;
    if (Array.isArray(t.prompts) && t.prompts.length > 0) {
      promptLines = t.prompts.map(p => (p && p.text) || p);
    } else if (Array.isArray(t.clips) && t.clips.length > 0) {
      promptLines = t.clips.map(c => c.prompt || '').filter(Boolean);
      if (promptLines.length === 0) promptLines = null;
    }
    // 质检可信度：列表页只需两个轻量标量做「历史未验证」角标，
    // 完整 finalQC 体积大，留给详情接口（见 /api/tasks/:id）。
    const annotated = storage.annotateTaskQC(t);
    return {
      taskId: t.taskId,
      prompt: t.prompt,
      promptLines,
      isMultiPrompt: t.isMultiPrompt || false,
      status: t.status,
      model: t.model,
      totalClips: t.totalClips,
      successClips: (t.clips || []).filter(c => c.status === 'success').length,
      failedClips: (t.clips || []).filter(c => c.status === 'failed').length,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      qcVersion: annotated.qcVersion,
      qcTrusted: annotated.qcTrusted,
      preset: t.preset,
      fragmentOnly: t.fragmentOnly || false
    };
  }));
});

// 获取任务详情
app.get('/api/tasks/:id', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }
  // 补质检可信度标注：qcVersion / qcTrusted / qcLabel（verified | legacy_unverified）。
  // taskManager.getTask 直接读内存对象、不会自动标注（storage.getTask 才标），
  // 不在这里补，前端就无法区分「修复后真实执行的质检」与「修复前伪造的 pass」。
  // annotateTaskQC 返回新对象、不改原对象，安全。
  res.json(storage.annotateTaskQC(task));
});

// 获取任务进度
app.get('/api/tasks/:id/progress', (req, res) => {
  const progress = taskManager.getProgress(req.params.id);
  if (!progress) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(progress);
});

// 获取片段状态（含视频文件信息，供详情页"片段列表"使用）
app.get('/api/tasks/:id/clips', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  const clipsDir = path.join(__dirname, 'clips');

  res.json(task.clips.map(c => {
    // 费用/耗时优先取任务里的快照；历史任务没有，就回退到片段库档案
    // （回填脚本会把历史片段的规格/费用/耗时写进库）。
    const libEntry = library.get(`${task.taskId}_c${c.index + 1}`);
    // 片段文件名约定：<taskId>_clip_<index+1>.mp4
    // 优先用任务里记录的 videoPath，找不到再按约定拼
    let filePath = '';
    if (c.videoPath && fs.existsSync(c.videoPath)) {
      filePath = c.videoPath;
    } else {
      const guess = path.join(clipsDir, `${task.taskId}_clip_${c.index + 1}.mp4`);
      if (fs.existsSync(guess)) filePath = guess;
    }

    let sizeBytes = 0;
    let available = false;
    if (filePath) {
      try {
        const st = fs.statSync(filePath);
        sizeBytes = st.size;
        available = st.size > 1024; // 过滤空文件
      } catch (e) { /* 忽略 */ }
    }

    return {
      index: c.index,
      status: c.status,
      attempts: c.attempts,
      error: c.error,
      prompt: c.prompt || '',
      theme: c.theme || null,
      themeTag: c.themeTag || null,
      trackId: c.trackId || null,
      duration: c.duration || (libEntry && libEntry.durationSec) || 0,
      qcPassed: c.qcResult ? !!c.qcResult.passed : null,
      qcUnverified: !!c.qcUnverified,
      // 单片段费用/耗时（任务详情卡片展示）
      cost: c.cost || (libEntry && libEntry.cost) || null,
      timing: c.timing || (libEntry && libEntry.timing) || null,
      // 规格与库来源（片段库成片任务用）
      libraryId: c.libraryId || null,
      trim: c.trim || null,
      width: (c.spec && c.spec.width) || (libEntry && libEntry.width) || null,
      height: (c.spec && c.spec.height) || (libEntry && libEntry.height) || null,
      fps: (c.spec && c.spec.fps) || (libEntry && libEntry.fps) || null,
      model: task.model,
      fileName: filePath ? path.basename(filePath) : null,
      // 浏览器可直接访问的地址
      url: filePath && available ? '/clips/' + encodeURIComponent(path.basename(filePath)) : null,
      sizeBytes,
      available
    };
  }));
});

// ===== 片段库 =====

// 价目表：前端费用展示、重新生成预估共用同一份（服务端唯一来源）
app.get('/api/pricing', (req, res) => {
  res.json({ ...pricing.PRICE_TABLE, version: pricing.PRICE_VERSION });
});

// 库列表：按分辨率分组，支持主题/模型/收藏/关键字筛选
app.get('/api/library', (req, res) => {
  try {
    const { resolution, theme, model, favorite, q } = req.query;
    const all = library.listAll();
    let items = all;
    if (resolution) items = items.filter(i => (i.tags && i.tags.resolution) === resolution);
    if (theme) items = items.filter(i => (i.tags && i.tags.theme) === theme);
    if (model) items = items.filter(i => (i.tags && i.tags.model) === model);
    if (favorite === '1') items = items.filter(i => i.favorite);
    if (q) {
      const s = String(q).toLowerCase();
      items = items.filter(i => String(i.prompt || '').toLowerCase().includes(s));
    }
    const grouped = library.grouped(items);
    const uniq = arr => Array.from(new Set(arr.filter(Boolean)));
    res.json({
      groups: grouped.groups,
      totals: grouped.totals,
      overall: library.stats(),
      facets: {
        resolutions: uniq(all.map(i => i.tags && i.tags.resolution)),
        themes: uniq(all.map(i => i.tags && i.tags.theme)),
        models: uniq(all.map(i => i.tags && i.tags.model))
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 收藏/取消收藏
app.put('/api/library/:id', (req, res) => {
  const { favorite } = req.body || {};
  if (favorite === undefined) return res.status(400).json({ error: '缺少 favorite' });
  const entry = library.setFavorite(req.params.id, !!favorite);
  if (!entry) return res.status(404).json({ error: '片段不存在' });
  res.json({ success: true, entry });
});

// 删除库条目：同时删除 clips/ 下的源文件（用户明确要求，二次确认在前端）
app.delete('/api/library/:id', (req, res) => {
  const result = library.remove(req.params.id);
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json({ success: true, fileDeleted: result.fileDeleted });
});

// 重新生成：改提示词/模型/分辨率，生成一条新片段（旧片段保留并标「已被替代」）
// 用一条隐藏的单片段任务跑现有生成链路（重试/质检/费用统计全部复用），
// 任务不进主历史，只在片段库看进度。
app.post('/api/library/:id/regenerate', (req, res) => {
  try {
    const entry = library.get(req.params.id);
    if (!entry) return res.status(404).json({ error: '片段不存在' });
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      return res.status(400).json({ error: '源片段文件已丢失，无法作为重新生成的基础' });
    }
    const body = req.body || {};
    const prompt = String(body.prompt || entry.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: '提示词不能为空' });

    const model = String(body.model || entry.model || '').trim();
    const modelInfo = getAvailableModels().find(m => m.id === model);
    if (!modelInfo) return res.status(400).json({ error: '不支持的模型: ' + model });

    const resolution = String(body.resolution || entry.resolution || '').trim();
    const allowed = (modelInfo.resolutions || []).map(r => String(r).toLowerCase());
    if (!allowed.includes(resolution.toLowerCase())) {
      return res.status(400).json({ error: `模型「${modelInfo.name}」不支持分辨率 ${resolution}` });
    }

    // 时长沿用原片段（用户没有要求改时长）；夹到模型上限内
    const clipDuration = Math.min(
      Math.max(1, Math.round(Number(entry.durationSec) || 5)),
      Math.max(1, Number(modelInfo.maxDuration) || 30)
    );

    const estimatedCost = pricing.computeClipCost({
      model,
      resolution,
      clipDurationSec: clipDuration,
      modelId: body.modelId || ''
    }, 1);

    const task = taskManager.createTask(prompt, {
      model,
      resolution,
      totalClips: 1,
      clipDuration,
      preset: 'clips_only',
      source: 'regenerate',
      hidden: true,
      regeneratedFrom: entry.id,
      runtimeConfig: {
        apiKey: body.apiKey || '',
        apiBaseUrl: body.apiBaseUrl || '',
        modelId: body.modelId || '',
        klingAccessKey: body.klingAccessKey || '',
        klingSecretKey: body.klingSecretKey || '',
        llmApiKey: body.llmApiKey || '',
        llmBaseUrl: body.llmBaseUrl || '',
        llmModel: body.llmModel || '',
        multimodalApiKey: body.multimodalApiKey || '',
        multimodalBaseUrl: body.multimodalBaseUrl || '',
        multimodalModel: body.multimodalModel || '',
        strictQcItems: Array.isArray(body.strictQcItems) && body.strictQcItems.length
          ? body.strictQcItems
          : null
      }
    });

    library.markRegenerateStarted(entry.id, task.taskId);
    pipeline.startTask(task.taskId);
    res.json({
      success: true,
      taskId: task.taskId,
      model,
      resolution,
      clipDuration,
      estimatedCost
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 片段库成片：用现成片段创建一条新任务（拼接/循环/转码），配乐与终检留给剪辑页导出
app.post('/api/assemble', (req, res) => {
  try {
    const body = req.body || {};
    const raw = Array.isArray(body.segments) ? body.segments : [];
    if (raw.length === 0) return res.status(400).json({ error: '至少选择一个片段' });
    if (raw.length > 200) return res.status(400).json({ error: '一次最多拼接 200 段' });

    const segments = [];
    for (const s of raw) {
      const entry = library.get(s.libraryId);
      if (!entry) return res.status(400).json({ error: '片段不存在: ' + s.libraryId });
      if (!entry.filePath || !fs.existsSync(entry.filePath)) {
        return res.status(400).json({ error: `片段文件已丢失: ${entry.fileName || entry.id}` });
      }
      const dur = Number(entry.durationSec) || 0;
      const inSec = Math.max(0, Math.min(Number(s.inSec) || 0, Math.max(0, dur - 0.05)));
      let outSec = (s.outSec === undefined || s.outSec === null) ? null : Number(s.outSec);
      if (outSec !== null) outSec = Math.min(Math.max(outSec, inSec + 0.05), dur || outSec);
      segments.push({
        libraryId: entry.id,
        filePath: entry.filePath,
        prompt: entry.prompt,
        theme: entry.theme,
        durationSec: dur,
        width: entry.width,
        height: entry.height,
        fps: entry.fps,
        codec: entry.codec,
        cost: entry.cost,
        inSec,
        outSec
      });
    }

    // 目标分辨率：前端没指定时取所选片段里像素面积最大的，避免把高分辨率压扁
    let target = String(body.resolution || '').trim();
    if (!target) {
      const area = e => (Number(e.width) || 0) * (Number(e.height) || 0);
      const best = segments.slice().sort((a, b) => area(b) - area(a))[0];
      target = library.resolutionLabel(best.width, best.height);
    }
    if (!['480p', '720p', '1080p', '4K'].includes(target)) {
      return res.status(400).json({ error: '不支持的目标分辨率: ' + target });
    }

    const transition = (body.transition && typeof body.transition === 'object') ? body.transition : null;
    const task = taskManager.createLibraryTask({ segments, resolution: target, transition });
    pipeline.startTask(task.taskId);
    res.json({
      success: true,
      taskId: task.taskId,
      resolution: target,
      segmentCount: segments.length,
      totalDuration: task.totalDuration
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 暂停 / 继续（仅片段生成阶段有效）=====
// 注意：已有 /api/tasks/:id/resume 的语义是「用已成功片段继续」，与暂停无关，故此处用 pause/unpause
app.post('/api/tasks/:id/pause', (req, res) => {
  const result = pipeline.pauseTask(req.params.id);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/tasks/:id/unpause', (req, res) => {
  const result = pipeline.resumeTask(req.params.id);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// 查询暂停状态
app.get('/api/tasks/:id/pause-state', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({ paused: pipeline.isPaused(req.params.id), status: task.status });
});

// 重新运行任务
app.post('/api/tasks/:id/retry', (req, res) => {
  const result = pipeline.startTask(req.params.id, { retry: true });
  res.json(result);
});

// 重新生成单个失败片段（可传新提示词），成功后自动重拼成片
app.post('/api/tasks/:id/clips/:index/regenerate', async (req, res) => {
  const clipIndex = parseInt(req.params.index, 10);
  const prompt = (req.body && req.body.prompt) || '';
  const result = await pipeline.regenerateClip(req.params.id, clipIndex, prompt);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 使用已成功片段继续生成（从拼接步骤开始）
app.post('/api/tasks/:id/resume', async (req, res) => {
  const result = await pipeline.resumeFromClips(req.params.id);
  res.json(result);
});

// ===== 补跑（按档位补齐剩余环节，不重新生成已有片段）=====
//
// 与上面的 /resume 语义不同：
//   /resume   —— 固定「从拼接开始」，跑完全部后段步骤（旧接口，保留兼容）
//   /continue —— 按目标档位 + 任务已完成步骤，精确补齐 pending 部分
//
// 例：body { "preset": "final" } 把只跑到拼接的 quick 任务补成完整成片，
//     已成功且有文件的片段直接复用，不重新生成（不重复花生成费）。
app.post('/api/tasks/:id/continue', async (req, res) => {
  const body = req.body || {};
  const result = await pipeline.continueTask(req.params.id, {
    preset: body.preset,
    completed: Array.isArray(body.completed) ? body.completed : undefined
  });
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// 重新质检：对「已生成但质检失败」的片段只重跑质检，不重新生成视频。
// 通过后片段转 success + 入片段库，随后可用 /continue 补跑复用（省钱）。
// Key 只走请求体、不落日志、不写任务文件（与其他任务接口一致）。
app.post('/api/tasks/:id/recheck-clips', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await pipeline.recheckClips(req.params.id, {
      multimodalApiKey: body.multimodalApiKey,
      multimodalBaseUrl: body.multimodalBaseUrl,
      multimodalModel: body.multimodalModel,
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[recheck-clips] 失败:', e.message);
    res.status(500).json({ success: false, error: '重新质检失败：' + e.message });
  }
});

// 预览：补跑到目标档位还需要跑哪些步骤（只读，不改任务状态）
app.get('/api/tasks/:id/continue-plan', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const preset = req.query.preset || task.preset || 'final';
  const completed = pipeline._completedSteps(task);
  const plan = resolveResume({ preset, completed });
  res.json({ ...plan, completed, currentPreset: task.preset });
});

// ===== 生产指标统计 =====
// 依据《后续目标》：端到端成功率 ≥ 90%、一次质检通过率 ≥ 85%。
// 默认排除质检不可信的历史任务（qcVersion < 2），否则通过率会因伪造 pass 虚高。
// 参数：?model=<模型id> 只看某模型；?includeUntrusted=1 纳入不可信任务（结果仅供参考）。
app.get('/api/stats', async (req, res) => {
  try {
    const stats = require('./src/stats');
    let tasks;
    try {
      tasks = await storage.getAllTasks();
    } catch (e) {
      tasks = taskManager.getAllTasks();
    }
    const result = stats.computeStats(tasks || [], {
      model: req.query.model || undefined,
      includeUntrusted: req.query.includeUntrusted === '1' || req.query.includeUntrusted === 'true'
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: '统计失败: ' + e.message });
  }
});

// ===== 垃圾箱 API =====

// 移到垃圾箱
app.delete('/api/tasks/:id', (req, res) => {
  const result = taskManager.moveToTrash(req.params.id);
  res.json(result);
});

// 从垃圾箱恢复
app.post('/api/trash/:id/restore', (req, res) => {
  const result = taskManager.restoreFromTrash(req.params.id);
  res.json(result);
});

// 永久删除
app.delete('/api/trash/:id', (req, res) => {
  const result = taskManager.permanentDelete(req.params.id);
  res.json(result);
});

// 获取垃圾箱列表
app.get('/api/trash', (req, res) => {
  res.json(taskManager.getTrashList());
});

// 获取垃圾箱任务详情
app.get('/api/trash/:id', (req, res) => {
  const trashPath = path.join(__dirname, 'data', 'trash', `${req.params.id}.json`);
  if (!fs.existsSync(trashPath)) {
    return res.status(404).json({ error: '任务不存在' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(trashPath, 'utf8'));
    const clips = data.clips || [];
    const success = clips.filter(c => c.status === 'success').length;
    const failed = clips.filter(c => c.status === 'failed' || c.status === 'qc_failed').length;
    res.json({
      taskId: data.taskId,
      status: data.status,
      prompt: data.prompt,
      optimizedPrompt: data.optimizedPrompt,
      prompts: data.prompts || null,
      isMultiPrompt: data.isMultiPrompt || false,
      model: data.model,
      resolution: data.resolution,
      total: clips.length,
      success,
      failed,
      processing: clips.filter(c => c.status === 'generating').length,
      pending: clips.filter(c => c.status === 'pending').length,
      percent: (data.status === 'completed' || data.status === 'partial') ? 100 : 0,
      currentStep: data.currentStep,
      steps: data.steps || {},
      stepKeys: taskManager.getPipelineSteps().map(s => s.key),
      clips: clips.map(c => ({ index: c.index, status: c.status, attempts: c.attempts || 0, prompt: c.prompt || '', qcResult: c.qcResult, error: c.error })),
      outputPath: data.outputPath,
      s3Url: data.s3Url,
      error: data.error,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      createdAt: data.createdAt,
      deletedAt: data.deletedAt
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 启动服务
// ==========================================

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  🎬 AI 长视频自动生成流水线');
  console.log('========================================');
  console.log('');
  console.log(`  服务已启动: http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  登录墙:   ${config.AUTH.enabled ? '已启用（会话级 cookie，关浏览器需重登）' : '已关闭（AUTH_ENABLED=false）'}`);
  console.log('');

  // ===== 登录墙：首次启动创建第一个账号 =====
  // 有账号时什么都不做；没有账号时用 AUTH_USER / AUTH_PASSWORD 建，
  // 缺密码则随机生成并打印一次（见 src/auth.js bootstrap）。
  auth.bootstrap()
    .then(r => {
      if (r && r.created === false && r.count > 0) {
        console.log(`  🔐 登录墙：${r.count} 个账号，未登录无法访问`);
      }
    })
    .catch(e => console.error('  ⚠️  登录墙初始化失败（登录接口会返回 503）:', e.message));

  // ===== 启动自检：回收上次进程中断留下的僵尸任务 =====
  // 进程刚启动，不可能有任务在跑；凡处于「进行中」状态的都是僵尸。
  // 不回收的话任务会永远停在 generating/mixing，前端既看不到失败也拿不到成片。
  pipeline.reconcileInterruptedTasks()
    .then(list => {
      if (list && list.length) {
        console.log(`  ⚠️  回收了 ${list.length} 个中断的任务（可直接点「补跑」继续）：`);
        list.forEach(r => console.log(`      ${r.taskId}  原状态 ${r.from}  已完成 ${r.completedSteps} 步`));
        console.log('');
      }
    })
    .catch(e => console.error('  启动自检失败:', e.message));

  console.log('  功能模块:');
  console.log('    ✅ 可插拔视频生成器 (Mock/Seedance/Kling)');
  console.log('    ✅ 全流程模块化质检');
  console.log('    ✅ 智能提示词优化');
  console.log('    ✅ 批量生成 + 并发控制 + 自动重试');
  console.log('    ✅ 任务状态管理 + 断点续跑');
  console.log('    ✅ WebSocket 实时进度推送');
  console.log('    ✅ FFmpeg 视频处理 (拼接/转码/无缝循环)');
  console.log('');
  console.log('  提示: 默认使用 Mock 模式，无需 API Key 即可演示');
  console.log('');
});
