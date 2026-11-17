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
// 2026-11-12：允许用 LOG_DIR 环境变量覆盖日志目录。
// 为什么：验收脚本会自起临时服务，它们也往 data/logs 写，真实运行日志里会混进
// "AUTH_ENABLED=false"、"服务已启动: http://localhost:3198" 这类测试噪声（排查时误导过我一次）。
// 默认行为完全不变：不设 LOG_DIR 时仍然是 data/logs。
const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(__dirname, 'data', 'logs');
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
// 场景卡（P4）：库状态查询 + 任务创建入口取卡校验
// 场景卡（P4）：库状态查询 + 任务创建入口取卡校验。
// 注意命名：POST /api/tasks 的解构里有同名请求体字段 `sceneCards`（开关），
// 模块必须用 `sceneCardLibrary`，否则校验分支会在请求体上调用 `.checkCapacity` → 500。
const sceneCardLibrary = require('./src/sceneCards');
const { resolveResume } = require('./src/pipelineStages');
const { getAvailableModels } = require('./src/generators');
// 注册出图厂商适配器（当前：dashscope / wan2.7-image）。
// 必须在任何 getImageGenStatus()/generateImage 之前执行一次。
require('./src/generators/imageProviders');
const { getImageGenStatus, listImageProviders, ImageGenerator, overridesFromRuntimeConfig } = require('./src/generators/imageGen');
const { generateBatch: generateImageBatch } = require('./src/processors/imageBatch');
const dashscopeUpload = require('./src/generators/dashscopeUpload');
const KlingGenerator = require('./src/generators/kling');
const wsManager = require('./src/wsManager');
const qualityChecker = require('./src/qualityChecker');
const projectStore = require('./src/projectStore');
const projectFromTask = require('./src/projectFromTask');
const editorExporter = require('./src/editorExporter');
const thumbnails = require('./src/thumbnails');
const adjustLut = require('./src/adjustLut');
const llmService = require('./src/services/llmService');
const pricing = require('./src/pricing');
const budget = require('./src/budget');
const submitGuard = require('./src/submitGuard');
const library = require('./src/library');
const photoLibrary = require('./src/photoLibrary');
const recycle = require('./src/recycle');
const security = require('./src/utils/security');
// 后端 i18n（P2）：请求语言解析 + 加法式文案契约。不引入依赖、不改变中文默认行为。
// 契约见 docs/spec/i18n-spec.md §3.4；入口在下方 `req.lang` 中间件。
const i18n = require('./src/i18n');
const { getI2VInfo, listI2VModels } = require('./src/generators/i2vSupport');
// 小智（P5）：计划卡 / 状态机 / 记忆 / 语音 / 调度。
// 说明：这些模块不自己起服务、不直连厂商；付费闸门在 supervisor.execute 内（未确认不发请求）。
const assistantSupervisor = require('./src/assistant/supervisor');
const assistantPlanCard = require('./src/assistant/planCard');
const assistantAsr = require('./src/assistant/asr');
const assistantMemory = require('./src/assistant/memory');
// 2026-11-17 V2（半自主任务管家）：只读环境上下文 / 偏好 / 审计 / 全局任务播报。
// 这些模块都只做进程内读写；新端点一律只读或要求 approved:true（L3）。
const assistantBroadcast = require('./src/assistant/broadcast');
const assistantPreferences = require('./src/assistant/preferences');
const assistantAudit = require('./src/assistant/audit');

const app = express();
const server = http.createServer(app);
const PORT = config.SERVER.port || 3000;

// ===== 安全响应头（零依赖，2026-11-12 外发部署前加固）=====
// 不引入 helmet（依赖极简是刻意设计）。只加「不会破坏现有页面」的几项：
//   nosniff   → 防止浏览器把上传的 .mp3 当脚本执行
//   SAMEORIGIN→ 防止被别的站点 iframe 套壳点击
//   no-referrer→ 跨站跳转时不泄漏内部路径
// 刻意不加 CSP：web/ 里有内联样式与 UMD vendor，CSP 需要逐个放行，贸然加会把界面打坏。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  // 2026-11-16 实测：小智「按住说话」报 NotAllowedError，根因是这里的 microphone 空允许列表。
  // 浏览器文档的 Permissions-Policy 优先级高于站点权限：Chrome 站点设成「允许」也压不过它。
  // 小智语音需要同源页面访问麦克风，所以只放行 microphone(self)；camera / geolocation 继续禁用。
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=()');
  next();
});

// ===== i18n：请求语言（P2）=====
// 位置刻意在登录墙之前：401、登录失败这类「还没认证」的响应也要能按英文返回。
// 语言来源：cookie vs_lang（前端切换语言时同步写）→ Accept-Language → 默认 zh。
// 只设置 req.lang，不改变任何既有响应字段；后续路由用 `...i18n.err(req.lang, key)` 加法式补字段。
app.use((req, res, next) => {
  req.lang = i18n.langFromRequest(req);
  res.locals.lang = req.lang;
  next();
});

// 版本探针：记录本进程启动时 server.js 的 mtime 与启动时间。
// 前端静态文件是「每次请求读磁盘」，后端模块是「启动时加载」——
// 改完后端不重启就会出现「界面是新的、接口是旧的」。这两个值用于检测这种错位。
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_FILE_MTIME = (() => {
  try { return fs.statSync(__filename).mtimeMs; } catch (e) { return null; }
})();

// 初始化 WebSocket
// 第二个参数是「握手鉴权」：没有有效会话 cookie 就直接拒绝握手。
// 不传（或 AUTH_ENABLED=false）时行为与改造前完全一致。
wsManager.init(server, auth.isEnabled() ? { authorize: (req) => auth.authorizeRequest(req) } : null);

// ===== 小智 2.0 V2：全局任务播报（Q23=B）=====
// 只读扫描 taskManager 的关键节点（新建/开始/失败/完成），合并节流后推给所有登录客户端。
// 三条约束：
//   · 不建任务、不改任务、不调模型；诊断只读 diagnose；
//   · 服务启动后第一拍只登记已有任务、不补播历史（避免重启刷屏）；
//   · 前端 WS 客户端在 i18n 提交后再接（本轮未集成 → 交付标「未验证/待集成」）。
assistantBroadcast.subscribe((payload) => {
  try { wsManager.broadcastAssistant(payload); } catch (e) { /* 推送失败不影响服务 */ }
});
let assistantBroadcastPrimed = false;
const assistantBroadcastTimer = setInterval(() => {
  try {
    if (!assistantBroadcastPrimed) {
      assistantBroadcast.reset({ primeExisting: true });
      assistantBroadcastPrimed = true;
      return;
    }
    assistantBroadcast.scan();
  } catch (e) {
    console.error('[assistant] 任务播报扫描失败:', e && e.message);
  }
}, 5000);
if (assistantBroadcastTimer && typeof assistantBroadcastTimer.unref === 'function') assistantBroadcastTimer.unref();

// ===== 登录墙 =====
//
// 拦截范围（有意为之，见 docs/spec/changelog.md「登录墙」一节）：
//   页面（/ 与 *.html）  → 未登录 302 到 /login.html?next=原地址
//   /api/*              → 未登录 401 JSON（code=AUTH_REQUIRED）
//   媒体静态目录          → 不拦（/output、/clips、/bgm；本机演示够用，
//                         公网部署时必须连同这三处一起拦，否则成片可被直接下载）
//
// 放行清单：登录页本身、登录/登出接口、/api/status（Docker HEALTHCHECK 用它）。
const AUTH_PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/status', '/healthz']);

app.use((req, res, next) => {
  if (!auth.isEnabled()) return next();

  const p = req.path || '/';

  // 登录页必须始终可达，否则会 302 到自己形成死循环
  if (p === '/login.html') return next();

  if (p.startsWith('/api/')) {
    if (AUTH_PUBLIC_API.has(p)) return next();
    const session = auth.authorizeRequest(req);
    if (!session) {
      return res.status(401).json({
        error: '未登录',
        code: 'AUTH_REQUIRED',
        ...i18n.err(req.lang, 'api.auth.required')
      });
    }
    req.auth = session;
    return next();
  }

  // 只拦页面；图片/字体/视频等静态资源放行
  //
  // 2026-10-27 修正：React 版挂在 /app 下，SPA 路由（/app/create 之类）不带 .html 后缀。
  // 按旧判据会被当成「静态资源」直接放行 —— 等于绕过登录墙（既有安全缺陷）。
  // 这里把 SPA 路由显式算作页面；但 /app 下的静态资源前缀不算，否则 JS/CSS 也要登录才能取。
  const SPA_ASSET = /^\/app\/(vendor|src|styles|assets)\//;
  const isSpaRoute = (p === '/app' || p === '/app/') ||
    (p.startsWith('/app/') && !SPA_ASSET.test(p));
  const isPage = p === '/' || p.endsWith('.html') || isSpaRoute;
  if (!isPage) return next();

  const session = auth.authorizeRequest(req);
  if (!session) {
    const target = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(302, `/login.html?next=${target}`);
  }
  req.auth = session;
  next();
});

// ===== JSON body 解析（放在登录墙之后）=====
// 未认证请求不会先被解析大体积 body；配乐上传是 base64 JSON，单独放宽到 64MB，
// 其余接口保持 express 默认 100KB（登录接口也走这里）。
const jsonDefault = express.json();
const jsonBgmUpload = express.json({ limit: '64mb' });
// 小智语音：浏览器 MediaRecorder 的音频以 base64 JSON 上传（12MB 音频 → 约 16MB JSON）。
// 只对这一个已登录接口放宽，其余接口仍是默认 100KB。
const jsonAssistantAsr = express.json({ limit: '24mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/bgm') return jsonBgmUpload(req, res, next);
  if (req.method === 'POST' && req.path === '/api/assistant/asr') return jsonAssistantAsr(req, res, next);
  return jsonDefault(req, res, next);
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
      retryAfter: lock.retryAfter,
      ...i18n.err(req.lang, 'api.auth.locked', { retryAfter: lock.retryAfter })
    });
  }

  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!username || !password) {
    return res.status(400).json({
      error: '请输入账号和密码',
      code: 'AUTH_MISSING_CREDENTIALS',
      ...i18n.err(req.lang, 'api.auth.missingCredentials')
    });
  }

  let user = null;
  try {
    // 首次启动时账号是异步创建的：先等它结束，
    // 否则「服务已就绪、账号还没建完」的窗口里登录会被判成「账号或密码错误」。
    await auth.awaitBootstrap();
    user = await auth.findUserByUsername(username);
  } catch (e) {
    // 关键：存储不可用时返回 503，绝不 fail-open
    console.error('[auth] 认证存储不可用:', e.message);
    return res.status(503).json({
      error: '认证服务不可用：' + e.message,
      code: 'AUTH_STORAGE_DOWN',
      ...i18n.err(req.lang, 'api.auth.storageDown')
    });
  }

  const ok = await auth.verifyPasswordConstant(password, user ? user.passwordHash : null);
  if (!ok) {
    const r = auth.recordFailure(ip);
    if (r.locked) {
      return res.status(401).json({
        error: '尝试次数过多，已锁定',
        code: 'LOCKED',
        ...i18n.err(req.lang, 'api.auth.lockedNow')
      });
    }
    return res.status(401).json({
      error: '账号或密码错误',
      code: 'BAD_CREDENTIALS',
      ...i18n.err(req.lang, 'api.auth.badCredentials')
    });
  }

  auth.resetFailures(ip);
  auth.markLogin(user.id);
  auth.setSessionCookie(res, auth.createSession(user));
  console.log(`[auth] 登录成功: ${user.username} (${ip})`);
  res.json({ ok: true, username: user.username, lang: req.lang });
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
    res.json({ users, authEnabled: auth.isEnabled(), selfId: req.auth.userId, lang: req.lang });
  } catch (e) {
    res.status(503).json({
      error: e.message,
      code: 'USERS_LIST_FAILED',
      ...i18n.err(req.lang, 'api.users.listFailed')
    });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');
    const minLen = Number(config.AUTH && config.AUTH.minPasswordLength) || 8;
    if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(username)) {
      return res.status(400).json({
        error: '账号需 2–32 位，仅限字母、数字、下划线、点、@、横线',
        code: 'USERNAME_INVALID',
        ...i18n.err(req.lang, 'api.users.badUsername')
      });
    }
    if (password.length < minLen) {
      return res.status(400).json({
        error: `密码至少 ${minLen} 位`,
        code: 'PASSWORD_TOO_SHORT',
        ...i18n.err(req.lang, 'api.users.passwordTooShort', { min: minLen })
      });
    }
    const passwordHash = await auth.hashPassword(password);
    const user = await storage.createUser({ username, passwordHash });
    console.log(`[auth] 新建账号: ${user.username}`);
    res.status(201).json({ user });
  } catch (e) {
    const msg = String(e.message || '新建失败');
    res.status(/已存在/.test(msg) ? 409 : 400).json({
      error: msg,
      code: /已存在/.test(msg) ? 'USER_EXISTS' : 'USER_CREATE_FAILED',
      ...i18n.err(req.lang, 'api.users.createFailed')
    });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const users = await storage.listUsers();
    if (users.length <= 1) {
      return res.status(400).json({
        error: '至少要保留一个账号',
        code: 'LAST_ACCOUNT',
        ...i18n.err(req.lang, 'api.users.lastAccount')
      });
    }
    if (req.params.id === req.auth.userId) {
      return res.status(400).json({
        error: '不能删除当前登录的账号',
        code: 'CANNOT_DELETE_SELF',
        ...i18n.err(req.lang, 'api.users.cannotDeleteSelf')
      });
    }
    const r = await storage.deleteUser(req.params.id);
    if (!r.success) {
      return res.status(404).json({
        error: r.error || '账号不存在',
        code: 'USER_NOT_FOUND',
        ...i18n.err(req.lang, 'api.users.notFound')
      });
    }
    auth.destroySessionsOfUser(req.params.id);
    console.log(`[auth] 删除账号: ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({
      error: e.message,
      code: 'USER_DELETE_FAILED',
      ...i18n.err(req.lang, 'api.users.deleteFailed')
    });
  }
});

app.put('/api/users/:id/password', async (req, res) => {
  try {
    const password = String((req.body || {}).password || '');
    const minLen = Number(config.AUTH && config.AUTH.minPasswordLength) || 8;
    if (password.length < minLen) {
      return res.status(400).json({
        error: `密码至少 ${minLen} 位`,
        code: 'PASSWORD_TOO_SHORT',
        ...i18n.err(req.lang, 'api.users.passwordTooShort', { min: minLen })
      });
    }
    const passwordHash = await auth.hashPassword(password);
    const user = await storage.updateUserPassword(req.params.id, passwordHash);
    if (!user) {
      return res.status(404).json({
        error: '账号不存在',
        code: 'USER_NOT_FOUND',
        ...i18n.err(req.lang, 'api.users.notFound')
      });
    }
    auth.destroySessionsOfUser(req.params.id);
    console.log(`[auth] 重置密码: ${user.username}`);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({
      error: e.message,
      code: 'USER_PASSWORD_UPDATE_FAILED',
      ...i18n.err(req.lang, 'api.users.updateFailed')
    });
  }
});

// ===== 旧版前端：已删除（2026-11-09，E5），/ 与所有旧页面地址统一回新版 /app =====
// 旧页面（public/index.html、bgm-editor、members、clip-library、music-library 等）连同
// 只读它们的 5 个静态验收脚本一起删除了；新版唯一入口是 /app。
// 保留这组 302：书签/历史/别人给的旧链接不至于 404，也不会再打开一个「看着像能用」的旧界面。
const LEGACY_PAGES = [
  'index.html', 'preview-app.html', 'preview-login.html', 'bgm-editor.html',
  'members.html', 'clip-library.html', 'music-library.html', 'showcase.html',
  'design-system-notion-apple.html', 'icon-comparison.html', '_ptest.html', '_selftest.html'
];
app.get(new RegExp('^/(' + LEGACY_PAGES.map((p) => p.replace(/\./g, '\\.')).join('|') + ')$'),
  (req, res) => res.redirect(302, '/app'));
app.get('/', (req, res) => res.redirect(302, '/app'));

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

// ===== React 版（app/web），挂在 /app 下 =====
// 唯一在维护的前端；旧版 public/index.html 仅归档（/ 已 302 到 /app，不在 / 提供）。
// 没有构建步骤：vendor/ 是预先下载好的 React UMD 与 htm；样式由 tools/tailwind 的独立 CLI 生成。
// 注意：/app 的 SPA 路由已在登录墙里按「页面」处理（不靠 .html 后缀判断）。
app.use('/app', express.static(path.join(__dirname, 'web'), {
  // 关掉目录索引重定向：/app 直接由下面的 SPA 兜底返回 index.html，
  // 否则 /app 会先 301 到 /app/，多一跳且在重定向下容易暴露路径细节。
  index: false,
  redirect: false,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css|mp4|jpg|png)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// SPA 兜底：/app 下任何非静态资源路径都回 index.html（刷新不 404）
app.get(/^\/app(\/.*)?$/, (req, res, next) => {
  if (/^\/app\/(vendor|src|styles|assets)\//.test(req.path)) return next();
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// ===== 媒体目录跟随登录墙（2026-11-12 外发部署前加固）=====
//
// 历史行为：/output、/clips、/bgm 三个目录刻意不拦（见 docs/spec/changelog.md「登录墙」），
// 理由是本机演示够用。但对外部署时这等于「知道 URL 就能下载成片/素材」，所以改成跟随登录墙：
//   AUTH_ENABLED=true（默认） → 三个目录都要求有效会话
//   AUTH_ENABLED=false        → 与验收脚本行为一致，放行（只用于跑测试）
//
// 注意：<video>/<audio> 标签是同源请求，会自带 cookie，所以登录后播放/试听不受影响。
app.use((req, res, next) => {
  if (!auth.isEnabled()) return next();
  if (!security.isMediaRequestPath(req.path)) return next();
  if (auth.authorizeRequest(req)) return next();
  console.log(`[auth] 拦截未登录的媒体请求: ${req.method} ${req.path}`);
  return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
});

// 输出文件静态访问（用于视频播放和下载）
app.use('/output', express.static(config.STORAGE.outputDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// 片段静态访问（任务详情页的"片段列表"播放/下载用）
// 只暴露 clips 目录下的 mp4，且禁止路径穿越
app.use('/clips', express.static(config.STORAGE.clipsDir, {
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
    if (!found) {
    return res.status(404).json({
      error: '音轨不存在: ' + req.params.id,
      code: 'BGM_TRACK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.bgm.trackNotFound', { id: req.params.id })
    });
  }
    const waveform = require('./src/processors/waveform');
    const r = await waveform.extractPeaks(found.track.id, found.filePath);
    if (!r.ok) return res.status(500).json({ error: r.error });
    // 缓存策略：波形是静态数据，允许浏览器缓存一天
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ ok: true, trackId: found.track.id, buckets: r.buckets, peaks: r.peaks, durationSec: r.durationSec });
  } catch (e) {
    res.status(500).json({ error: '生成波形失败: ' + e.message, code: 'BGM_WAVEFORM_FAILED', ...i18n.err(req.lang, 'api.bgm.waveformFailed') });
  }
});

// 保存音轨顺序 / 默认开场曲（全局，影响自动配乐的起点与接续顺序）
app.put('/api/bgm/prefs', (req, res) => {
  try {
    const prefs = audioMixer.savePrefs(req.body || {});
    res.json({ success: true, ...prefs });
  } catch (e) {
    res.status(500).json({ error: '保存配乐偏好失败: ' + e.message, code: 'BGM_PREFS_FAILED', ...i18n.err(req.lang, 'api.bgm.prefsSaveFailed') });
  }
});

// 上传配乐入库（base64）
app.post('/api/bgm', (req, res) => {
  const result = audioMixer.addTrack(req.body || {});
  if (!result.success) {
    // 超大文件用 413，其余参数问题 400（前端据此提示「换小一点的文件」）
    const status = result.code === 'TOO_LARGE' ? 413 : 400;
    return res.status(status).json({ error: result.error, code: result.code });
  }
  res.json(result);
});

// 编辑音轨元信息
app.put('/api/bgm/:id', (req, res) => {
  const result = audioMixer.updateTrack(req.params.id, req.body || {});
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json(result);
});

// 删除音轨：2026-11-15 起移入回收站（内置音轨只移清单）
app.delete('/api/bgm/:id', (req, res) => {
  const result = audioMixer.removeTrack(req.params.id);
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json({ success: true, trashed: !!result.trashed, recycleDir: result.recycleDir || null });
});

// 手动混音测试接口（演示用：对指定成片叠加单曲配乐）
// 注意：已不再按主题选曲，track 传 'auto' 表示在轻音乐池随机取一首。
app.post('/api/bgm/mix', async (req, res) => {
  const { videoPath, track, loudness, fadeSeconds } = req.body || {};
  // 2026-11-12 加固：原先用 `startsWith('output')` 防穿越，但 `output/../../server.js`
  // 同样满足该判断（弱校验）。改为「解析后必须仍在 output/ 内」，且拒绝会被 cmd.exe
  // 解释的字符（引号/百分号等），因为路径最终会拼进 ffmpeg 命令行。
  const inputVideo = security.resolveUnderOutput(__dirname, videoPath);
  if (!inputVideo) {
    return res.status(400).json({
      error: 'videoPath 必须是 output 目录内的合法路径（防路径穿越）',
      code: 'BGM_INVALID_PATH',
      ...i18n.err(req.lang, 'api.bgm.invalidPath')
    });
  }
  if (!fs.existsSync(inputVideo)) {
    return res.status(400).json({
      error: '视频文件不存在: ' + videoPath,
      code: 'BGM_VIDEO_MISSING',
      ...i18n.err(req.lang, 'api.bgm.videoMissing')
    });
  }
  const outName = 'mix_' + Date.now().toString(36) + '.mp4';
  const outputPath = path.join(config.STORAGE.outputDir, outName);
  try {
    const result = await audioMixer.mixBgm(inputVideo, outputPath, {
      track: track || 'auto',
      loudness: loudness || config.BGM.loudness,
      fadeSeconds: fadeSeconds || 2
    });
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ ...result, outputUrl: '/output/' + outName });
  } catch (e) {
    res.status(500).json({ error: '混音失败: ' + e.message, code: 'BGM_MIX_FAILED', ...i18n.err(req.lang, 'api.bgm.mixFailed') });
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
      // 调节：前端剪辑台用它回填滑杆；null = 未调节
      adjust: t.adjust || null,
      adjustApplied: t.adjustApplied && t.adjustApplied.filter ? { filter: t.adjustApplied.filter } : null,
      completedAt: t.completedAt,
      createdAt: t.createdAt
    }));
  res.json({ total: tasks.length, tasks });
});

// 读取任务的配乐计划
app.get('/api/tasks/:id/bgm-plan', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
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
  if (!task) return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
  const normalized = pipeline._normalizePlan((req.body || {}).plan, task);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  taskManager.updateTaskStatus(task.taskId, task.status, { bgmPlan: normalized.plan });
  res.json({ success: true, plan: normalized.plan });
});

// 生成自动配乐草稿（供「添加配乐」页面的初始填充，不落库）
app.post('/api/tasks/:id/bgm-auto-plan', async (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
  try {
    const prep = await pipeline._ensureBgmPlan(task.taskId, task, { force: true });
    if (!prep.ok) return res.status(400).json({ ok: false, error: prep.error });
    res.json({ ok: true, plan: prep.plan, source: prep.source, warnings: prep.warnings || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: '生成自动配乐失败: ' + e.message, code: 'BGM_AUTO_PLAN_FAILED', ...i18n.err(req.lang, 'api.bgm.autoPlanFailed') });
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
    res.status(500).json({ error: '配乐预览失败: ' + e.message, code: 'BGM_PREVIEW_FAILED', ...i18n.err(req.lang, 'api.bgm.previewFailed') });
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
    res.status(500).json({ error: '配乐导出失败: ' + e.message, code: 'BGM_EXPORT_FAILED', ...i18n.err(req.lang, 'api.bgm.exportFailed') });
  }
});

// 逐段改配乐：已下线。保留路由并明确返回，避免老前端静默失败。
app.post('/api/tasks/:id/clips/:index/audio', (req, res) => {
  res.status(410).json({
    error: '逐段配乐已下线，请使用「添加配乐」页面（POST /api/tasks/:id/audio）',
    deprecated: true,
    code: 'BGM_PER_CLIP_REMOVED',
    ...i18n.err(req.lang, 'api.bgm.perClipRemoved')
  });
});

// ==========================================
// API 路由
// ==========================================

// 获取可用模型列表
app.get('/api/models', (req, res) => {
  res.json(getAvailableModels());
});

// ==========================================
// 百炼临时上传自检（免费，不上传文件）
// ------------------------------------------------------------
// 图片优先链路在 wan3.0 图生视频阶段要把调色图传到百炼临时 OSS。
// 出图前先拿一次上传凭证，确认 Key/BaseURL/model 可用，避免先花 N 张图的费用。
// ==========================================
app.post('/api/dashscope/upload-check', async (req, res) => {
  const body = req.body || {};
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) return res.status(400).json({ ok: false, error: '缺少 DashScope API Key' });
  try {
    const policy = await dashscopeUpload.getUploadPolicy({
      apiKey,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '',
      model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'wan3.0-video'
    });
    res.json({
      ok: true,
      uploadDir: policy.upload_dir,
      expireInSeconds: Number(policy.expire_in_seconds) || null
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// ==========================================
// 图片生成（文生图，wan2.7-image）
// ==========================================

// 配置就绪度：只回传「有没有配 Key / 厂商是否已注册」，绝不回传 Key 本身。
// 前端可在用户点「生成」之前用它提示，而不是等失败才告知。
app.get('/api/image-gen/status', (req, res) => {
  const status = getImageGenStatus();
  res.json({
    ...status,
    providers: listImageProviders(),
    // 图生视频：只有本清单里的视频模型才会被 /api/tasks 接受 sourcePhotoId
    i2vModels: listI2VModels(),
    i2v: { models: listI2VModels(), support: Object.fromEntries(listI2VModels().map((m) => [m, getI2VInfo(m)])) },
    hint: status.usable
      ? `图片生成已就绪：${status.imageGen.provider} / ${status.imageGen.model}`
      : (!status.imageGen.hasApiKey
        ? '还没有图片生成 Key：在 app/.env 填 IMAGE_GEN_API_KEY（或复用 DASHSCOPE_API_KEY），重启服务后生效。'
        : `图片生成配置不完整：${status.missing.join(', ') || '所选厂商的适配器未注册'}`)
  });
});

// 生成一张静帧（分镜图）。一次一张，由调用方按片段循环。
// 注意：这是真实计费接口，只有带 Key 且被显式调用时才会花钱。
app.post('/api/images/generate', async (req, res) => {
  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({
      error: 'prompt 不能为空',
      code: 'IMAGE_PROMPT_REQUIRED',
      ...i18n.err(req.lang, 'api.images.promptRequired')
    });
  }
  if (prompt.length > 8000) {
    return res.status(400).json({
      error: `prompt 过长（${prompt.length} 字，上限 8000）`,
      code: 'IMAGE_PROMPT_TOO_LONG',
      ...i18n.err(req.lang, 'api.images.promptTooLong', { length: prompt.length })
    });
  }

  // 运行时配置：页面「设置」里填的 Key/地址/模型只用于本次请求，不落盘。
  const runtime = {};
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) runtime.IMAGE_GEN_API_KEY = body.apiKey.trim();
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) runtime.IMAGE_GEN_BASE_URL = body.baseUrl.trim();
  if (typeof body.model === 'string' && body.model.trim()) runtime.IMAGE_GEN_MODEL = body.model.trim();
  if (typeof body.size === 'string' && body.size.trim()) runtime.IMAGE_GEN_SIZE = body.size.trim();
  // 接口类型（dashscope=百炼原生异步 / openai-images=OpenAI 兼容同步）。页面切换用谁的 Key。
  if (typeof body.provider === 'string' && body.provider.trim()) runtime.IMAGE_GEN_PROVIDER = body.provider.trim();

  const status = getImageGenStatus(runtime);
  if (!status.usable) {
    return res.status(503).json({
      error: '图片生成尚未就绪',
      missing: status.missing,
      providerImplemented: status.providerImplemented,
      code: 'IMAGE_GEN_NOT_READY',
      hint: status.imageGen.hasApiKey
        ? `缺少: ${status.missing.join(', ') || '所选厂商的适配器未注册'}`
        : '在「设置 → 图片生成」填 API Key（只存本机浏览器），或写 app/.env 的 IMAGE_GEN_API_KEY，然后重启服务。',
      ...i18n.err(req.lang, 'api.images.notReady')
    });
  }

  // 预算闸门（2026-11-14）：图片 $0.03/张，余额不足直接 402，不发真实请求
  const imageUsd = budget.estimateImage(1);
  if (!budget.canAfford(imageUsd)) {
    const st = budget.status();
    return res.status(402).json({
      error: `余额不足：生成 1 张图需 $${imageUsd.toFixed(2)}，剩余 $${st.balanceUsd.toFixed(2)}`,
      code: 'INSUFFICIENT_BUDGET',
      budget: { balanceUsd: st.balanceUsd, spentUsd: st.spentUsd },
      ...i18n.err(req.lang, 'api.images.insufficientBudget', {
        count: 1,
        estimate: imageUsd.toFixed(2),
        balance: st.balanceUsd.toFixed(2)
      })
    });
  }

  try {
    const generator = new ImageGenerator({
      provider: status.imageGen.provider,
      model: status.imageGen.model,
      ...runtime
    });
    const out = await generator.generateImage(prompt, {
      taskId: body.taskId,
      index: body.index,
      size: body.size || status.imageGen.size,
      negativePrompt: body.negativePrompt,
      promptExtend: body.promptExtend,
      watermark: body.watermark,
      outDir: config.STORAGE.clipsDir
    });
    // 用户 2026-11-11 要求：所有生成的图片都要入库，并保留对应提示词。
    // 入库失败不推翻已生成的图（钱已经花了），但要显式告诉调用方，不能静默。
    let photo = null;
    let photoError = null;
    try {
      photo = photoLibrary.ingest({
        id: photoLibrary.makeId(body.taskId, body.index),
        taskId: body.taskId,
        index: Number.isInteger(body.index) ? body.index : 0,
        filePath: out.imagePath,
        url: '/clips/' + encodeURIComponent(path.basename(out.imagePath)),
        prompt,
        negativePrompt: typeof body.negativePrompt === 'string' ? body.negativePrompt : '',
        provider: out.provider,
        model: out.model,
        size: body.size || status.imageGen.size,
        width: out.width,
        height: out.height,
        source: 'generation'
      });
    } catch (e) {
      photoError = e && e.message ? e.message : String(e);
      console.warn('[image-gen] 图片入库失败:', photoError);
    }
    // 成功后记账（失败不扣预算；与「按成功生成量计费」口径一致）
    try {
      budget.reserve({ usd: imageUsd, kind: 'image', taskId: body.taskId || out.model, meta: { model: out.model, size: body.size || status.imageGen.size } });
    } catch (e) {
      console.warn('[budget] 图片记账失败:', e.message);
    }
    res.json({
      ok: true,
      ...out,
      url: '/clips/' + encodeURIComponent(path.basename(out.imagePath)),
      photoId: photo ? photo.id : null,
      ...(photoError ? { photoLibraryError: photoError } : {})
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 参数类错误返回 400；厂商/网络类错误返回 502（让调用方能区分「重试可能有用」）
    const isValidation = /提示词|尺寸|n=1|taskId|index|为空/i.test(msg);
    console.error('[image-gen] 生成失败:', msg);
    res.status(isValidation ? 400 : 502).json({
      error: '图片生成失败: ' + msg,
      code: isValidation ? 'IMAGE_GEN_INVALID' : 'IMAGE_GEN_FAILED',
      ...i18n.err(req.lang, 'api.images.generateFailed')
    });
  }
});

// ==========================================
// 批量出图 + 逐图自适应调色 + 自动通过（2026-11-12 用户口径）
// ------------------------------------------------------------
// 输入 N 条图片提示词；逐条生成 → 逐图调色 → 写图片库（status=approved，跳过人工审核）。
// 返回的 photoId 可直接按顺序传给 POST /api/tasks 的 photoIds，走逐片段图生视频。
//
// 注意：这是真实计费接口（每张图一次调用）。调用方必须先确认数量与预算。
// ==========================================
app.post('/api/images/generate-batch', async (req, res) => {
  const body = req.body || {};
  const prompts = Array.isArray(body.prompts)
    ? body.prompts.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)
    : [];
  if (prompts.length === 0) {
    return res.status(400).json({
      error: 'prompts 不能为空',
      code: 'IMAGE_PROMPTS_REQUIRED',
      ...i18n.err(req.lang, 'api.images.promptsRequired')
    });
  }
  if (prompts.length > 200) {
    return res.status(400).json({
      error: '单次最多 200 条（当前 ' + prompts.length + '）',
      code: 'IMAGE_BATCH_LIMIT',
      ...i18n.err(req.lang, 'api.images.batchLimit', { count: prompts.length })
    });
  }

  const runtime = {};
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) runtime.IMAGE_GEN_API_KEY = body.apiKey.trim();
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) runtime.IMAGE_GEN_BASE_URL = body.baseUrl.trim();
  if (typeof body.model === 'string' && body.model.trim()) runtime.IMAGE_GEN_MODEL = body.model.trim();
  if (typeof body.size === 'string' && body.size.trim()) runtime.IMAGE_GEN_SIZE = body.size.trim();
  if (typeof body.provider === 'string' && body.provider.trim()) runtime.IMAGE_GEN_PROVIDER = body.provider.trim();

  const status = getImageGenStatus(runtime);
  if (!status.usable) {
    return res.status(503).json({
      error: '图片生成尚未就绪',
      missing: status.missing,
      code: 'IMAGE_GEN_NOT_READY',
      hint: status.imageGen.hasApiKey
        ? `缺少: ${status.missing.join(', ') || '所选厂商的适配器未注册'}`
        : '在「设置 → 图片生成」填 API Key',
      ...i18n.err(req.lang, 'api.images.notReady')
    });
  }

  const palette = ['cold', 'warm', 'night', 'calm'].includes(body.palette) ? body.palette : 'calm';
  const taskId = String(body.taskId || ('imgbatch_' + Date.now().toString(36)));
  const outDir = config.STORAGE.clipsDir;
  const generator = new ImageGenerator({
    provider: status.imageGen.provider,
    model: status.imageGen.model,
    ...runtime
  });

  // 预算闸门（2026-11-14）：按条数预检，避免生成到一半余额不足
  const batchUsd = budget.estimateImage(prompts.length);
  if (!budget.canAfford(batchUsd)) {
    const st = budget.status();
    return res.status(402).json({
      error: `余额不足：生成 ${prompts.length} 张图需 $${batchUsd.toFixed(2)}，剩余 $${st.balanceUsd.toFixed(2)}`,
      code: 'INSUFFICIENT_BUDGET',
      budget: { balanceUsd: st.balanceUsd, spentUsd: st.spentUsd },
      ...i18n.err(req.lang, 'api.images.insufficientBudget', {
        count: prompts.length,
        estimate: batchUsd.toFixed(2),
        balance: st.balanceUsd.toFixed(2)
      })
    });
  }

  try {
    const batch = await generateImageBatch({
      prompts,
      taskId,
      palette,
      outDir,
      size: body.size || status.imageGen.size,
      negativePrompt: typeof body.negativePrompt === 'string' ? body.negativePrompt : '',
      generateImage: (prompt, meta) => generator.generateImage(prompt, {
        taskId,
        index: meta.index,
        size: body.size || status.imageGen.size,
        negativePrompt: body.negativePrompt,
        promptExtend: body.promptExtend,
        watermark: body.watermark,
        outDir
      })
    });
    // 只按成功张数扣（失败张不计费）
    try {
      budget.reserve({ usd: budget.estimateImage(batch.items.length), kind: 'image', taskId: batch.taskId, meta: { count: batch.items.length, palette } });
    } catch (e) {
      console.warn('[budget] 批量出图记账失败:', e.message);
    }
    return res.json({
      ok: batch.items.length > 0,
      taskId: batch.taskId,
      palette: batch.palette,
      count: batch.count,
      succeeded: batch.items.length,
      failed: batch.errors.length,
      items: batch.items,
      errors: batch.errors
    });
  } catch (e) {
    return res.status(502).json({
      error: '批量出图失败: ' + (e && e.message ? e.message : e),
      code: 'IMAGE_BATCH_FAILED',
      ...i18n.err(req.lang, 'api.images.batchFailed')
    });
  }
});

// ===== 图片库（照片）=====
// 用户 2026-11-11 口径：所有生成的图片都要入库，并且保留对应提示词。
// 审核三态：pending（待审）/ approved（通过，可拿去图生视频）/ rejected（打回）。
app.get('/api/photos', (req, res) => {
  const status = String(req.query.status || '').trim();
  const finalOnly = String(req.query.final || '') === '1';
  if (status && !photoLibrary.STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'status 只能是 pending / approved / rejected',
      code: 'PHOTO_BAD_STATUS',
      ...i18n.err(req.lang, 'api.photos.badStatus')
    });
  }
  // 2026-11-15 用户口径：**文件缺失的条目不显示**（图片库曾 17/17 文件全缺，界面全是破图）。
  // 默认隐藏、数据一条不删；文件找回后自动重新出现。排查/对账用 ?includeMissing=1 取全量。
  const includeMissing = String(req.query.includeMissing || '') === '1';
  const withFileState = (p) => ({ ...p, fileMissing: !(p.filePath && fs.existsSync(p.filePath)) });
  const queried = photoLibrary.query({ status, q: req.query.q, finalOnly }).map(withFileState);
  const photos = includeMissing ? queried : queried.filter((p) => !p.fileMissing);
  // totals 是跨状态的汇总，与列表用同一可见性口径，避免“顶部 17 张、列表 0 张”
  const allVisible = photoLibrary.listAll()
    .filter((p) => includeMissing || (p.filePath && fs.existsSync(p.filePath)));
  res.json({
    photos,
    finalOnly,
    includeMissing,
    hiddenMissing: queried.length - photos.length,
    totals: photoLibrary.totals(allVisible)
  });
});

app.get('/api/photos/:id', (req, res) => {
  const photo = photoLibrary.get(req.params.id);
  if (!photo) {
    return res.status(404).json({
      error: '图片不存在',
      code: 'PHOTO_NOT_FOUND',
      ...i18n.err(req.lang, 'api.photos.notFound')
    });
  }
  res.json({
    ...photo,
    fileMissing: !(photo.filePath && fs.existsSync(photo.filePath)),
    versions: photoLibrary.versions(photo.versionGroupId)
  });
});

app.put('/api/photos/:id', (req, res) => {
  const body = req.body || {};
  const status = String(body.status || '').trim();
  const hasImage = typeof body.imagePrompt === 'string';
  const hasVideo = typeof body.videoPrompt === 'string';
  const hasLegacy = typeof body.prompt === 'string';
  const hasFinal = typeof body.isFinal === 'boolean';
  const hasScience = ['unchecked', 'passed', 'failed'].includes(body.scienceStatus) || typeof body.scienceNotes === 'string';
  if (!status && !hasImage && !hasVideo && !hasLegacy && !hasFinal && !hasScience) {
    return res.status(400).json({
      error: '需要提供 status / imagePrompt / videoPrompt / isFinal / scienceStatus',
      code: 'PHOTO_NEED_FIELD',
      ...i18n.err(req.lang, 'api.photos.needField')
    });
  }
  if (status && !photoLibrary.STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'status 只能是 pending / approved / rejected',
      code: 'PHOTO_BAD_STATUS',
      ...i18n.err(req.lang, 'api.photos.badStatus')
    });
  }
  let photo = null;
  if (hasFinal && body.isFinal) {
    const current = photoLibrary.get(req.params.id);
    if (!current) {
    return res.status(404).json({
      error: '图片不存在',
      code: 'PHOTO_NOT_FOUND',
      ...i18n.err(req.lang, 'api.photos.notFound')
    });
  }
    if (current.scienceStatus !== 'passed') {
      return res.status(400).json({
      error: '科学/物理审查未通过，不能设为最终版',
      code: 'PHOTO_SCIENCE_NOT_PASSED',
      ...i18n.err(req.lang, 'api.photos.scienceNotPassed')
    });
    }
  }
  if (hasFinal) photo = photoLibrary.setFinal(req.params.id, body.isFinal);
  if (status) photo = photoLibrary.markReviewed(req.params.id, status, body.note);
  const patch = {};
  if (hasImage || hasLegacy) {
    // 画面提示词（旧字段 prompt 视为 imagePrompt）
    const ip = String(hasImage ? body.imagePrompt : body.prompt).trim().slice(0, 8000);
    patch.imagePrompt = ip;
    patch.prompt = ip; // 兼容旧卡片/搜索字段
    patch.promptAvailable = ip.length > 0;
    patch.imagePromptUpdatedAt = new Date().toISOString();
    patch.promptUpdatedAt = patch.imagePromptUpdatedAt;
    patch.promptSource = 'manual';
  }
  if (hasVideo) {
    patch.videoPrompt = String(body.videoPrompt).trim().slice(0, 8000);
    patch.videoPromptUpdatedAt = new Date().toISOString();
  }
  if (hasScience) {
    if (['unchecked', 'passed', 'failed'].includes(body.scienceStatus)) patch.scienceStatus = body.scienceStatus;
    if (typeof body.scienceNotes === 'string') patch.scienceNotes = body.scienceNotes.trim().slice(0, 2000);
    patch.scienceReviewedAt = new Date().toISOString();
  }
  if (Object.keys(patch).length) photo = photoLibrary.update(req.params.id, patch);
  if (!photo) {
    return res.status(404).json({
      error: '图片不存在',
      code: 'PHOTO_NOT_FOUND',
      ...i18n.err(req.lang, 'api.photos.notFound')
    });
  }
  res.json({ ok: true, photo, versions: photoLibrary.versions(photo.versionGroupId) });
});

// ===== 图片手动调色（2026-11-16 用户口径）=====
// 图片审核页每张图给「亮度 / 对比度 / 饱和度 / 色温」四条滑杆，应用后把参数烘进 PNG。
// 语义（契约 docs/交接/2026-11-16-出图审图-接口契约.md §3.5）：
//   · 参数是**绝对值**（-100..100），每次都从原图重渲染，不在上一次结果上叠加（避免反复掉画质）；
//   · 保留原图：首次调色时记下 originalPath/url，之后 versions 只追加、绝不覆盖旧文件；
//   · reset=true 回退到原图（版本历史保留，不删文件）；
//   · 本地派生不产生费用：photo.cost / source 不改写（不是「又生成了一张新图」）。
// 状态码：400 参数非法 / 404 图片不存在 / 409 原图文件缺失 / 502 渲染失败。
app.post('/api/photos/:id/adjust', async (req, res) => {
  const body = req.body || {};
  const photo = photoLibrary.get(req.params.id);
  if (!photo) {
    return res.status(404).json({
      error: '图片不存在',
      code: 'PHOTO_NOT_FOUND',
      ...i18n.err(req.lang, 'api.photos.notFound')
    });
  }
  // 延迟 require：模块缺失时只让这个接口报错，不影响整个服务的其它路由。
  const photoAdjust = require('./src/processors/photoAdjust');
  const prev = (photo.adjust && typeof photo.adjust === 'object') ? photo.adjust : null;
  const originalPath = (prev && prev.originalPath) || photo.filePath;
  const originalUrl = (prev && prev.originalUrl) || photo.url;
  if (!originalPath || !fs.existsSync(originalPath)) {
    return res.status(409).json({
      error: '原图文件不存在，无法调色（' + (originalPath || '(空路径)') + '）',
      code: 'PHOTO_SOURCE_MISSING',
      ...i18n.err(req.lang, 'api.photos.sourceMissing')
    });
  }
  const outDir = config.STORAGE.clipsDir;
  try {
    if (body.reset === true) {
      const r = await photoAdjust.revertToOriginal({
        photo, originalPath, outDir, ffmpegPath: config.FFMPEG_PATH
      });
      if (!r || r.ok !== true) {
        return res.status(502).json({
      error: '回退原图失败：' + ((r && r.error) || '未知原因'),
      code: 'PHOTO_REVERT_FAILED',
      ...i18n.err(req.lang, 'api.photos.revertFailed')
    });
      }
      const versions = Array.isArray(prev && prev.versions) ? prev.versions.slice(-20) : [];
      const originalWidth = (prev && prev.originalWidth) || photo.width;
      const originalHeight = (prev && prev.originalHeight) || photo.height;
      const originalSizeBytes = (prev && prev.originalSizeBytes) || photo.sizeBytes;
      const updated = photoLibrary.update(photo.id, {
        filePath: r.filePath,
        url: originalUrl || ('/clips/' + encodeURIComponent(path.basename(r.filePath))),
        width: originalWidth,
        height: originalHeight,
        sizeBytes: originalSizeBytes,
        adjust: {
          params: null,
          revertedAt: new Date().toISOString(),
          originalPath,
          originalUrl,
          originalWidth,
          originalHeight,
          originalSizeBytes,
          // current 始终指向「当前显示的文件」：回退后就是原图；version 用最后一次调色的版本号
          // （不递增：它不是一次新的渲染，UI 据此显示「已回退到原图（曾调色 vN）」）。
          current: {
            filePath: r.filePath,
            url: originalUrl || ('/clips/' + encodeURIComponent(path.basename(r.filePath))),
            width: originalWidth,
            height: originalHeight,
            sizeBytes: originalSizeBytes,
            version: (prev && prev.current && Number(prev.current.version)) || versions.length || 0,
            reverted: true
          },
          versions
        }
      });
      if (!updated) return res.status(404).json({ error: '图片不存在' });
      return res.json({ ok: true, adjusted: false, reverted: true, filter: null, url: updated.url, photo: updated });
    }

    const params = photoAdjust.normalizeParams(body);   // 非法 → throw code=E_BAD_PARAM
    const noop = !params.brightness && !params.contrast && !params.saturation && !params.temperature;
    if (noop) {
      return res.status(400).json({
      error: '四个参数都为 0，没有可应用的调色（要恢复原图请传 reset:true）',
      code: 'PHOTO_NOTHING_TO_ADJUST',
      ...i18n.err(req.lang, 'api.photos.nothingToAdjust')
    });
    }
    const r = await photoAdjust.applyToPhoto({
      photo, params, outDir, ffmpegPath: config.FFMPEG_PATH, originalPath
    });
    if (!r || r.ok !== true) {
      return res.status(502).json({
      error: '调色失败：' + ((r && r.error) || '未知原因'),
      code: 'PHOTO_ADJUST_FAILED',
      ...i18n.err(req.lang, 'api.photos.adjustFailed')
    });
    }
    const url = r.url || ('/clips/' + encodeURIComponent(path.basename(r.filePath)));
    const versions = (Array.isArray(prev && prev.versions) ? prev.versions.slice() : [])
      .concat([{ version: r.version, params, filePath: r.filePath, url, appliedAt: new Date().toISOString() }])
      .slice(-20);
    const updated = photoLibrary.update(photo.id, {
      filePath: r.filePath,
      url,
      width: r.width || photo.width,
      height: r.height || photo.height,
      sizeBytes: r.sizeBytes || 0,
      adjust: {
        params,
        appliedAt: new Date().toISOString(),
        originalPath,
        originalUrl,
        originalWidth: (prev && prev.originalWidth) || photo.width,
        originalHeight: (prev && prev.originalHeight) || photo.height,
        originalSizeBytes: (prev && prev.originalSizeBytes) || photo.sizeBytes,
        current: { filePath: r.filePath, url, width: r.width, height: r.height, sizeBytes: r.sizeBytes, version: r.version },
        versions
      }
    });
    if (!updated) return res.status(404).json({ error: '图片不存在' });
    return res.json({ ok: true, adjusted: true, reverted: false, filter: r.filter || null, url, photo: updated });
  } catch (e) {
    const code = e && e.code;
    if (code === 'E_BAD_PARAM') return res.status(400).json({ error: e.message });
    if (code === 'E_MISSING_FILE') return res.status(409).json({ error: e.message });
    console.error('[photo-adjust] 调色失败:', e && e.message ? e.message : e);
    return res.status(502).json({
      error: '调色失败：' + (e && e.message ? e.message : String(e)),
      code: 'PHOTO_ADJUST_FAILED',
      ...i18n.err(req.lang, 'api.photos.adjustFailed')
    });
  }
});

app.delete('/api/photos/:id', (req, res) => {
  const keepFile = String(req.query.keepFile || '') === '1';
  const r = photoLibrary.remove(req.params.id, { deleteFile: !keepFile });
  if (!r.success) return res.status(r.error === '图片不存在' ? 404 : 500).json({ error: r.error });
  res.json({ ok: true, trashed: !!r.trashed, recycleDir: r.recycleDir || null, photo: r.entry });
});

// 测试 API Key 是否有效
app.post('/api/test-api-key', async (req, res) => {
  const { type, apiKey, baseUrl, model, accessKey, secretKey, provider } = req.body;

  if (!apiKey && !(type === 'kling' && accessKey && secretKey)) {
    return res.json({ success: false, error: '请输入 API Key' });
  }

  // HTTP 头只能是 ASCII：把页面上的提示文案（如「✗ Invalid API-key…」）粘进 Key 时，
  // Node 的 fetch 会抛「Cannot convert argument to a ByteString … index 7 … 10007」，
  // 原来又被包成「网络错误」，用户完全看不懂。这里提前给出人话原因。
  const nonAscii = (v) => typeof v === 'string' && /[^\x20-\x7E]/.test(v);
  for (const [label, value] of [['API Key', apiKey], ['Base URL', baseUrl], ['模型名', model]]) {
    if (nonAscii(value)) {
      const bad = [...value].find((ch) => /[^\x20-\x7E]/.test(ch));
      const cp = bad.codePointAt(0).toString(16).toUpperCase();
      return res.json({
        success: false,
        error: `${label} 里含非 ASCII 字符「${bad}」（U+${cp}），`
          + '多半是粘贴了页面上的提示文案或报错信息。请只填纯英文数字（Key 一般以 sk- 开头），'
          + '不要把「✗ …」「网络错误…」这类文字粘进来。',
        nonAscii: true
      });
    }
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
    let dsBaseUrlUsed = '';
    let baseUrlSource = '';
    let probeProvider = '';
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
    } else if (type === 'imagegen') {
      // 图片生成两套协议，探针不同：
      //   openai-images（WhaleTV / New API 等中转、OpenAI 官方）→ GET {base}/models（免费、有 JSON）
      //   dashscope（百炼原生）→ GET {base}/tasks/{不存在的id}（鉴权通过会报任务不存在，不消耗额度）
      const fromRequest = String(baseUrl || '').trim();
      dsBaseUrlUsed = (fromRequest || config.IMAGE_GEN_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '');
      baseUrlSource = fromRequest
        ? 'request（页面 Base URL）'
        : (/dashscope\.aliyuncs\.com\/api\/v1\/?$/.test(dsBaseUrlUsed)
          ? 'default（旧通用入口，业务空间 Key 在这里必 401）'
          : 'env（IMAGE_GEN_BASE_URL / DASHSCOPE_BASE_URL）');
      probeProvider = String(provider || config.IMAGE_GEN_PROVIDER || 'dashscope').trim();
      url = dsBaseUrlUsed + (probeProvider === 'openai-images' ? '/models' : '/tasks/invalid-task-check');
      method = 'GET';
      delete headers['Content-Type'];
    } else if (type === 'openai-video') {
      // OpenAI 兼容视频中转（WhaleTV / New API）：用 GET {base}/models 验鉴权（免费、不生成视频）
      const fromRequest = String(baseUrl || '').trim();
      dsBaseUrlUsed = (fromRequest || config.OPENAI_VIDEO_BASE_URL || '').replace(/\/+$/, '');
      if (!dsBaseUrlUsed) {
        return res.json({ success: false, error: '请先填写 Base URL（例如 https://agglm.whaletv.com/v1）' });
      }
      baseUrlSource = fromRequest ? 'request（页面 Base URL）' : 'env（OPENAI_VIDEO_BASE_URL）';
      probeProvider = 'openai-video';
      url = dsBaseUrlUsed + '/models';
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

    // 200 但不是 JSON：多半把「网页地址」填成了 Base URL（单页应用对任何路径都回 HTML 200）。
    // 以前这里会直接判 success，等于告诉用户「地址可用」——必须显式失败。
    if (response.ok && (type === 'imagegen' || type === 'openai-video') && (!data || Object.keys(data).length === 0)) {
      const head = String(text || '').slice(0, 80).replace(/\s+/g, ' ');
      return res.json({
        success: false,
        error: `地址返回的不是 JSON（content-type: ${response.headers.get('content-type') || '未知'}），`
          + 'Base URL 可能填成了网页地址。响应开头: ' + head,
        urlUsed: dsBaseUrlUsed,
        baseUrlSource
      });
    }

    if (response.ok) {
      if (type === 'imagegen' || type === 'openai-video') {
        const models = Array.isArray(data && data.data) ? data.data.map((m) => m && m.id).filter(Boolean) : [];
        return res.json({
          success: true,
          message: 'Key / 地址可用（只验证鉴权，不消耗生成额度）'
            + (models.length ? `｜可用模型: ${models.join(', ')}` : ''),
          urlUsed: dsBaseUrlUsed,
          baseUrlSource,
          provider: probeProvider,
          models
        });
      }
      if (type === 'llm') {
        // /models 对任何合法 Key 都回 200 —— 它验证不了「你要用的模型名是否被允许」。
        // 2026-11-10 事故：Key/地址都对，模型填 deepseek-chat，该中转只挂了
        // deepseek-v4-flash-0731 → 测试显示「连接成功」，对话永远 HTTP 403。
        // 判定逻辑抽到 llmService.judgeModelsPayload（纯函数，可离线验收）。
        return res.json(llmService.judgeModelsPayload({
          data,
          text,
          model,
          url,
          fallbackModel: config.OPENAI_MODEL || 'gpt-4o-mini',
        }));
      }
      res.json({ success: true, message: '连接成功，API Key 有效' });
    } else {
      // 非 401 错误说明 Key 是对的，只是参数或额度问题
      const status = response.status;
      let errorMsg = data.error?.message || data.message || data.error || `HTTP ${status}`;
      if (typeof errorMsg === 'object') errorMsg = JSON.stringify(errorMsg).substring(0, 200);
      if (errorMsg.length > 200) errorMsg = errorMsg.substring(0, 200) + '...';

      if (status === 401 || status === 403) {
        if (type === 'imagegen') {
          return res.json({
            success: false,
            error: errorMsg
              + '｜提示：Key 与地址必须同属一个地域 / 业务空间。'
              + '业务空间专属 Key 的 Base URL 应填 https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1'
              + '（华北2 北京与新加坡的 Key/地址不通用）。'
              + '本次实际请求：' + dsBaseUrlUsed + '（来源：' + baseUrlSource + '）',
            urlUsed: dsBaseUrlUsed,
            baseUrlSource
          });
        }
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
        if (type === 'imagegen') {
          return res.json({
            success: true,
            message: 'Key / 地址可用（只验证鉴权；是否已开通 wan2.7-image 以实际出图为准）',
            warning: errorMsg
          });
        }
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
    llmConfigured: !!config.OPENAI_API_KEY,
    // 版本探针：用来区分「运行中的旧进程」与「磁盘上的新代码」。
    serverInfo: {
      startedAt: SERVER_STARTED_AT,
      serverMtime: SERVER_FILE_MTIME,
      pid: process.pid
    },
    // 版本/配置探针：用来确认「运行中的服务是否已加载图片生成新代码」。
    // 只暴露布尔与模型名，不含 Key。
    imageGen: {
      provider: config.IMAGE_GEN_PROVIDER,
      model: config.IMAGE_GEN_MODEL,
      configured: !!config.IMAGE_GEN_API_KEY
    },
    // i18n 探针（P2）：/api/status 是公开接口，用它就能验证「cookie 切换语言」已生效，
    // 不需要登录、不产生任何副作用，也不会触发登录失败的 IP 计数。
    lang: req.lang,
    i18n: { version: 'p2', langs: i18n.SUPPORTED.slice(), keys: i18n.keyCount() }
  });
});

// 最小健康检查（Docker HEALTHCHECK 用）：只回 ok，不暴露 pid/路径/配置。
// 对外部署时把它给反代探活，比让 /api/status 公开更合适。
app.get('/healthz', (req, res) => res.json({ ok: true }));

// 获取主题列表
app.get('/api/themes', (req, res) => {
  res.json(promptOptimizer.getThemes());
});

// ===== 剪辑台工程（草稿，2026-11-04）=====
// 与任务分开：工程是编辑态，导出时才创建任务。
const projectErrorStatus = (e) => {
  if (!e || !e.code) return 500;
  if (e.code === 'NOT_FOUND') return 404;
  if (e.code === 'REVISION_CONFLICT') return 409;
  if (['REVISION_REQUIRED', 'BAD_INPUT', 'BAD_SEGMENT', 'LIMIT'].includes(e.code)) return 400;
  return 500;
};
const projectErrorBody = (e) => ({
  success: false,
  code: (e && e.code) || 'ERROR',
  error: (e && e.message) || '工程操作失败',
  ...(e && e.currentRevision !== undefined ? { currentRevision: e.currentRevision } : {})
});

app.get('/api/projects', (req, res) => {
  try {
    res.json({ success: true, projects: projectStore.list() });
  } catch (e) {
    res.status(projectErrorStatus(e)).json(projectErrorBody(e));
  }
});

app.post('/api/projects', (req, res) => {
  try {
    res.json({ success: true, project: projectStore.create(req.body || {}) });
  } catch (e) {
    res.status(projectErrorStatus(e)).json(projectErrorBody(e));
  }
});

// 从已有成片重建工程（F01 c）：任务片段 → 片段库 assetId + 入出点 + 配乐 + 转场
app.post('/api/projects/from-task', (req, res) => {
  try {
    const taskId = req.body && req.body.taskId;
    const r = projectFromTask.build(taskId);
    res.json({ success: true, ...r });
  } catch (e) {
    const status = e && e.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({
      success: false,
      code: (e && e.code) || 'ERROR',
      error: (e && e.message) || '重建失败'
    });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    res.json({ success: true, project: projectStore.get(req.params.id) });
  } catch (e) {
    res.status(projectErrorStatus(e)).json(projectErrorBody(e));
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const body = req.body || {};
    const expected = body.revision !== undefined
      ? Number(body.revision)
      : (req.get('If-Match') !== undefined ? Number(req.get('If-Match')) : null);
    res.json({ success: true, project: projectStore.update(req.params.id, body, expected) });
  } catch (e) {
    res.status(projectErrorStatus(e)).json(projectErrorBody(e));
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    res.json({ success: true, ...projectStore.remove(req.params.id) });
  } catch (e) {
    res.status(projectErrorStatus(e)).json(projectErrorBody(e));
  }
});

// 剪辑台导出：异步 job，前端轮询（2026-11-04 F08）
app.post('/api/projects/:id/export', (req, res) => {
  try {
    const job = editorExporter.startExport(req.params.id);
    res.json({ success: true, export: job });
  } catch (e) {
    const status = e && e.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ success: false, error: e && e.message ? e.message : '导出启动失败' });
  }
});

app.get('/api/projects/:id/export/:exportId', (req, res) => {
  const job = editorExporter.getJob(req.params.id, req.params.exportId);
  if (!job) return res.status(404).json({ success: false, error: '导出任务不存在' });
  res.json({ success: true, export: job });
});

app.post('/api/projects/:id/export/:exportId/cancel', (req, res) => {
  const job = editorExporter.cancelExport(req.params.id, req.params.exportId);
  if (!job) return res.status(404).json({ success: false, error: '导出任务不存在' });
  res.json({ success: true, export: job });
});

// 模板列表（2026-10-31 补：此前只有 GET /api/templates/:id，
// 旧版 loadTemplates() 一直在打 /api/templates 却永远 404 —— 只读接口，无副作用）
app.get('/api/templates', (req, res) => {
  try {
    const file = path.join(__dirname, 'data', 'templates.json');
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    res.json({ templates: data });
  } catch (e) {
    res.status(500).json({ error: '读取模板失败: ' + e.message });
  }
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
  const { prompt, theme, llmApiKey, llmBaseUrl, llmModel, aiLang } = req.body;

  if (!prompt) {
    return res.status(400).json({
      error: '请输入提示词',
      code: 'PROMPT_REQUIRED',
      ...i18n.err(req.lang, 'api.optimize.promptRequired')
    });
  }

  // P3：AI 输出语言 = aiLang（请求体）→ 界面语言 → 默认 zh。
  // 中文路径行为完全不变；en 走 promptOptimizer 的英文基底 prompt + 独立英文模板。
  const outputLanguage = i18n.outputLang(req, aiLang);

  try {
    // 先做质检
    const validation = promptOptimizer.validatePrompt(prompt, theme);

    // 主题解析：显式传入优先，其次读行尾【主题】标签
    // （此前前端固定传 theme:null 且只走模板，模板在无主题时原样返回 → 按钮实际是空操作）
    const parsed = promptOptimizer.parseThemeTag(prompt, theme ?? null);
    const useTheme = theme || parsed.themeId;

    const apiKey = llmApiKey || config.OPENAI_API_KEY;
    if (apiKey && !budget.canAfford(budget.estimateLlm(1))) {
      const st = budget.status();
      return res.status(402).json({
        error: `余额不足：本次 LLM 优化预计 $${budget.estimateLlm(1).toFixed(3)}，剩余 $${st.balanceUsd.toFixed(2)}`,
        code: 'INSUFFICIENT_BUDGET',
        budget: { balanceUsd: st.balanceUsd },
        ...i18n.err(req.lang, 'api.optimize.insufficientBudget', {
          estimate: budget.estimateLlm(1).toFixed(3),
          balance: st.balanceUsd.toFixed(2)
        })
      });
    }
    let result;
    if (apiKey) {
      // AI 优化路径：会叠加 fengguang skill 规则（仅风光类主题）
      result = await promptOptimizer.optimizeWithAI(prompt, useTheme, {
        apiKey,
        baseUrl: llmBaseUrl,
        model: llmModel,
        lang: outputLanguage,
      });
    } else {
      result = promptOptimizer.optimizeWithTemplate(prompt, useTheme, outputLanguage);
    }

    if (apiKey) {
      try {
        budget.reserve({ usd: budget.estimateLlm(1), kind: 'llm', taskId: null, meta: { model: llmModel || config.OPENAI_MODEL, endpoint: '/api/optimize-prompt' } });
      } catch (e) {
        console.warn('[budget] LLM 记账失败:', e.message);
      }
    }

    res.json({
      ...result,
      validation,
      themeResolved: useTheme || null,
      // P3：输出语言回显（加法式；旧前端不读也不受影响）
      lang: outputLanguage,
      // 无主题又无 Key 时模板不改写任何内容，明确告知原因，避免误以为按钮坏了
      hint: (!useTheme && !apiKey)
        ? (outputLanguage === 'en'
          ? 'No theme detected: append a tag such as 【山】【沙漠】【星空】 at the end, or configure an LLM key in Settings for AI optimization.'
          : '未识别主题：请在行尾加【山】【沙漠】【星空】等标签，或在设置里配置 LLM Key 走 AI 优化')
        : null,
    });
  } catch (e) {
    console.error('[optimize-prompt] 失败:', e.message);
    res.status(500).json({
      error: '优化失败：' + e.message,
      code: 'OPTIMIZE_FAILED',
      ...i18n.err(req.lang, 'api.optimize.failed')
    });
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

// 模型原文 → 最终响应体（JSON 解析 + ready 判定 + 禁用词硬校验）。
// 整段返回与流式返回共用同一份判定，保证两条路径结果完全一致。
function buildAssistantReply(raw) {
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
    return { ok: true, ready: false, message: raw, prompt: null };
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
      return {
        ok: true,
        ready: false,
        rejected: hits,
        // 只说明命中了哪条禁令，不列举"应该做什么"——避免变相白名单。
        message: `这个方向里有「${hits.join('、')}」，这些不能出现，换个方向吧。`,
        prompt: null
      };
    }
  }

  return {
    ok: true,
    // ready 只在真的拿到提示词时才算数，防止模型说 ready 却没给正文
    ready: !!(ready && prompt),
    message: parsed.message,
    prompt
  };
}

// 失败响应体：整段返回与流式共用，保证前端只需要认一套字段。
function llmFailurePayload(failure) {
  const info = llmService.describeFailure(failure);
  console.error('[assistant] LLM_FAILED ' + JSON.stringify({
    kind: failure && failure.kind,
    status: failure && failure.status,
    url: failure && failure.url,
    model: failure && failure.model
  }));
  return {
    ok: false,
    error: 'LLM_FAILED',
    // 首行保持原句不变（后端契约与旧前端都可能依赖它），原因放结构化字段
    message: '助手没有响应，请检查网络或 API Key 后重试',
    reason: failure && failure.kind ? failure.kind : 'UNKNOWN',
    status: failure && failure.status ? failure.status : null,
    url: failure && failure.url ? failure.url : null,
    model: failure && failure.model ? failure.model : null,
    hint: info.hint,
    detail: info.detail
  };
}

// 流式响应：逐行 NDJSON（不用 SSE，因为这是 POST，EventSource 用不了）。
//   {type:'start'}                              握手
//   {type:'reasoning', chars, firstTokenMs}     思考链进度（只给数字，不给内容）
//   {type:'message', text}                      当前应显示的 message 前缀（累计值，不是增量）
//   {type:'final', ...buildAssistantReply}      最终结果，结构与非流式一致
//   {type:'error', ...llmFailurePayload}        失败，字段与非流式一致
// 前端断线时 write 会抛，吞掉并停止写；LLM 请求本身仍会跑完（避免留下半截连接）。
async function streamAssistant(res, assistantSystem, history, llmCfg) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const write = (obj) => {
    if (closed) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { closed = true; }
  };
  write({ type: 'start' });

  let shown = '';
  let result;
  try {
    result = await llmService.chatMultiStream(assistantSystem, history, llmCfg, {
      onReasoning: (chars, ms) => write({ type: 'reasoning', chars, firstTokenMs: ms }),
      onContent: (buf) => {
        // 流式时正文是「未写完的 JSON」，只显示其中 message 已生成的部分
        const prefix = llmService.extractMessagePrefix(buf);
        if (prefix && prefix !== shown) {
          shown = prefix;
          write({ type: 'message', text: prefix });
        }
      }
    });
  } catch (e) {
    console.error('[assistant] 流式异常:', e && e.message);
    write({ ...llmFailurePayload({ kind: 'UNKNOWN', detail: e && e.message }), type: 'error' });
    return res.end();
  }

  if (!result || !result.text) {
    write({ ...llmFailurePayload(result && result.failure), type: 'error' });
    return res.end();
  }
  write({
    ...buildAssistantReply(result.text),
    type: 'final',
    elapsedMs: result.elapsedMs,
    firstTokenMs: result.firstTokenMs
  });
  res.end();
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
  // 流式模式：前端带 stream:true 时边走边吐，解决「正在想…」那 4–18 秒空白。
  // 老前端（不带该字段）仍走下面的整段返回，契约不变。
  if (req.body && req.body.stream === true) {
    return streamAssistant(res, assistantSystem, history, llmCfg);
  }

  const { text: raw, failure } = await llmService.chatMulti(assistantSystem, history, llmCfg);
  if (!raw) {
    // 失败原因必须能到达用户眼前：原先所有失败都回同一句话，用户只能照着
    // 「检查网络或 API Key」乱试（2026-11-10 两起事故：地址读错 / 模型名不在中转列表）。
    return res.status(200).json(llmFailurePayload(failure));
  }

  return res.status(200).json(buildAssistantReply(raw));
});

// ==========================================
// 提示词助手：批量生成（数量由用户指定）
// 与单条 /api/assistant/chat 分开：
//   单条 = 一次一条、边聊边改；批量 = 一次 N 条、不同地貌、直接填进创作页。
// 输出是一个纯文本块（每行一条），创作页会把多行解析成多个场景。
// ==========================================
const BATCH_LANDFORMS = ['雪山冰川', '沙漠沙丘', '海岸礁岩', '云雾山谷', '森林', '湖泊', '瀑布', '极光'];

function parseBatchJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const arr = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function batchSystemPrompt(n, seconds) {
  return `你是「风光长视频分镜师」。用户要 ${n} 条互不重复的镜头提示词，每条 ${seconds} 秒。
必须遵守：
1. 输出恰好 ${n} 条，不要多也不要少；不要问问题、不要解释、不要 markdown 代码块。
2. 地貌按顺序轮转：${BATCH_LANDFORMS.join('、')}；每条一个独立镜头，相邻不重复。
3. 同一批固定一个色板（极冷极淡 / 暖浓 / 暗底暖星云，按地貌选最贴的一套）和一个焦段族；同一批内不许换。
4. 画面里绝不能出现：人物、动物、室内、生活物件、文字/招牌/水印、城市/街道/建筑、抽象图形、科幻特效、微距特写。
5. 每条按七段写：主体（地貌专名）+ 运动 + 运镜 + 光线 + 氛围 + 质感 + 结尾留白；只允许一条运动主轴；结尾锁死画面（不引入新元素）。
6. 只输出 JSON 数组，元素格式：{"index":1,"landform":"雪山冰川","palette":"极冷极淡","prompt":"完整中文提示词"}。数组以外不要输出任何字符。`;
}

app.post('/api/assistant/batch', async (req, res) => {
  const body = req.body || {};
  const count = Math.max(1, Math.min(200, parseInt(body.count, 10) || 20));
  const seconds = Math.max(3, Math.min(30, parseInt(body.seconds, 10) || 10));
  const theme = String(body.theme || '自然风光').slice(0, 200);
  const llmCfg = { apiKey: body.llmApiKey, baseUrl: body.llmBaseUrl, model: body.llmModel };

  if (!llmCfg.apiKey && !config.OPENAI_API_KEY) {
    return res.status(200).json({ ok: false, error: 'NO_LLM_KEY' });
  }

  // 每批最多 20 条：一条提示词约 60–100 字，20 条约 2k 字，避免输出被截断。
  const BATCH = 20;
  const items = [];
  const warnings = [];
  for (let start = 0; start < count; start += BATCH) {
    const need = Math.min(BATCH, count - start);
    const sys = batchSystemPrompt(need, seconds);
    const user = `主题：${theme}。本批第 ${start + 1}–${start + need} 条，共 ${need} 条；每条 ${seconds} 秒。地貌从「${BATCH_LANDFORMS[start % BATCH_LANDFORMS.length]}」开始轮转。`;
    let arr = null;
    for (let attempt = 0; attempt < 2 && !arr; attempt++) {
      const { text, failure } = await llmService.chatMulti(sys, [{ role: 'user', content: user }], llmCfg);
      if (!text) return res.status(200).json(llmFailurePayload(failure));
      arr = parseBatchJson(text);
      if (!arr) warnings.push(`第 ${start + 1} 批返回不是 JSON，已重试`);
    }
    if (!arr) {
      return res.status(200).json({ ok: false, error: 'BAD_LLM_JSON', message: warnings.join('；') || '模型没有返回 JSON 数组' });
    }
    const clean = arr
      .filter(x => x && typeof x.prompt === 'string' && x.prompt.trim())
      .slice(0, need);
    for (let i = 0; i < clean.length; i++) {
      items.push({
        index: start + i + 1,
        landform: String(clean[i].landform || BATCH_LANDFORMS[(start + i) % BATCH_LANDFORMS.length]),
        palette: String(clean[i].palette || ''),
        // 一行一条：把模型可能带回来的换行压平，否则创作页会多算场景。
        prompt: String(clean[i].prompt).replace(/\s*\r?\n+\s*/g, ' ').trim()
      });
    }
    if (clean.length < need) warnings.push(`第 ${start + 1} 批少 ${need - clean.length} 条`);
  }

  return res.status(200).json({
    ok: true,
    items,
    text: items.map(x => x.prompt).join('\n'),
    meta: { count, seconds, theme, landforms: BATCH_LANDFORMS, warnings }
  });
});

// ==========================================
// 小智（P5）：计划卡 / 状态机 / 记忆 / 语音
// ------------------------------------------------------------
// 已定产品决策（docs/交接/2026-11-15-handoff.md §7）：
//   · 方案 C：模型只负责「听懂 + 填计划卡」；执行/失败处理由确定性状态机做，不问模型；
//   · 记忆：会话内 + 任务检索（「上一次视频」用检索，不靠模型回忆）；
//   · 语音：离线 ASR + 失败回退打字；
//   · 付费任务必须先经用户明确同意（approved=true），未同意绝不发起。
//
// 设计约束：
//   · 一律 HTTP 200，用 ok 字段区分成败（与 /api/assistant/chat 同一风格）；
//   · 不在这里创建第二实例/第二端口，直接复用当前进程的 taskManager + pipeline；
//   · ASR 不接受客户端传文件路径（防任意读盘），只收 base64 音频。
// ==========================================
app.get('/api/assistant/info', (req, res) => {
  res.json({
    ok: true,
    name: '小智',
    version: assistantSupervisor.SUPERVISOR_VERSION,
    plan: {
      version: assistantPlanCard.PLAN_VERSION,
      limits: assistantPlanCard.LIMITS,
      models: assistantPlanCard.MODELS,
      themes: assistantPlanCard.THEMES.map(t => ({ id: t.id, label: t.label }))
    },
    asr: assistantAsr.status(),
    memory: { maxMessages: assistantMemory.MAX_MESSAGES },
    // 出图（图生视频首帧）就绪度与单价（2026-11-16）：
    // 计划卡的「逐段出图」开关要用真实单价显示预估费用，**不许前端硬编码 ¥0.20**
    // （换模型/换价目表时会谎报）。这里只报服务端 .env 口径；浏览器 Key 由前端自己判断。
    image: (() => {
      const st = getImageGenStatus({});
      const unit = pricing.computeImageCost({ model: st.imageGen.model || '' });
      return {
        usable: st.usable,
        provider: st.imageGen.provider,
        model: st.imageGen.model,
        size: st.imageGen.size,
        unitCny: unit.computed ? unit.unitPrice : null,
        unitLabel: unit.computed ? unit.label : '未配置图片单价',
        hasServerKey: st.imageGen.hasApiKey
      };
    })(),
    endpoints: [
      '/api/assistant/info', '/api/assistant/message', '/api/assistant/execute',
      '/api/assistant/state', '/api/assistant/memory', '/api/assistant/understand',
      '/api/assistant/asr',
      // 2026-11-17 V2（只读或显式 approved:true）
      '/api/assistant/context', '/api/assistant/preferences', '/api/assistant/preferences/clear',
      '/api/assistant/audit', '/api/assistant/settings/confirm', '/api/assistant/repair'
    ]
  });
});

// 对话：听懂 → 计划卡 / 上次记录 / 进度。不创建任务、不发付费请求。
app.post('/api/assistant/message', (req, res) => {
  const body = req.body || {};
  const text = String(body.text === undefined || body.text === null ? '' : body.text);
  try {
    const out = assistantSupervisor.handleMessage({
      sessionId: body.sessionId ? String(body.sessionId) : undefined,
      text,
      // 2026-11-17 V2：跨会话偏好按登录用户隔离；无登录墙/验收环境为 'local'。
      userId: (req.auth && req.auth.userId) ? String(req.auth.userId) : 'local',
      // P3：助手话术语言（默认 zh → 逐字保持现有中文回复；en 走 templates.en.js）。
      lang: req.lang
    });
    res.json(out);
  } catch (e) {
    console.error('[assistant] message 失败:', e && e.message);
    res.json({
      ok: false,
      code: (e && e.code) || 'ASSISTANT_ERROR',
      error: '小智处理失败：' + (e && e.message ? e.message : String(e)),
      ...i18n.err(req.lang, 'api.assistant.handleFailed')
    });
  }
});

// 确认执行计划卡。approved=true 才允许真实计费模型；mock 不需要。
// runtimeConfig 只透传白名单字段（Key 不落任务文件，与 /api/tasks 同口径）。
app.post('/api/assistant/execute', (req, res) => {
  const body = req.body || {};
  // 逐段出图就绪度前置校验（2026-11-16 用户口径：场景卡 → 逐段出图 → 图生视频）。
  // 出图是真实计费调用；配置不全时**先拒绝**，而不是先建任务、跑到出图那一步再失败
  // （建了任务还得让用户去删，且会误导成「生成失败」）。
  // 只要 imagePerClip 不是 true，这段完全不生效 —— 纯文生视频链路行为零变化。
  if (body.imagePerClip === true) {
    const overrides = (typeof overridesFromRuntimeConfig === 'function')
      ? overridesFromRuntimeConfig({
        imageApiKey: body.imageApiKey,
        imageBaseUrl: body.imageBaseUrl,
        imageProvider: body.imageProvider,
        imageModel: body.imageModel,
        imageSize: body.imageSize
      })
      : {};
    const st = getImageGenStatus(overrides);
    if (!st.usable) {
      const why = st.missing.length
        ? '缺少 ' + st.missing.join(', ')
        : `所选出图厂商「${st.imageGen.provider || '(空)'}」未注册适配器`;
      return res.json({
        ok: false,
        code: 'IMAGE_GEN_NOT_READY',
        error: '出图未就绪：' + why
          + '。请在「设置 → 图片生成」填 Key/地址/模型，或写 app/.env 的 IMAGE_GEN_API_KEY 后重启服务；'
          + '也可以关掉「逐段出图」改用纯文生视频。',
        ...i18n.err(req.lang, 'api.assistant.imageGenNotReady')
      });
    }
  }
  try {
    const out = assistantSupervisor.execute({
      sessionId: body.sessionId ? String(body.sessionId) : '',
      planId: body.planId ? String(body.planId) : null,
      approved: body.approved === true,
      force: body.force === true,
      // P3：AI 输出语言（aiLang 可覆盖界面语言）；任务语言仍按 req.lang 记录。
      lang: i18n.outputLang(req, body.aiLang),
      options: {
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
          // 出图（图生视频首帧）：只在内存态；落盘时由 src/utils/redact 清空 *_key 字段。
          // pipeline._mergeRuntimeConfig 的白名单与此处保持同一套键（补跑/重生成会带上）。
          imageApiKey: body.imageApiKey || '',
          imageBaseUrl: body.imageBaseUrl || '',
          imageProvider: body.imageProvider || '',
          imageModel: body.imageModel || '',
          imageSize: body.imageSize || '',
          imagePerClip: body.imagePerClip === true
        },
        bgm: (body.bgm && typeof body.bgm === 'object') ? body.bgm : undefined,
        transition: (body.transition && typeof body.transition === 'object') ? body.transition : undefined
      }
    });
    res.json(withAssistantCodeKeys(out, {
      PAYMENT_NOT_APPROVED: 'api.assistant.executeNotApproved',
      ASSISTANT_BAD_SESSION: 'api.assistant.badSession',
      ASSISTANT_NO_PLAN: 'api.assistant.noPlan',
      ASSISTANT_ALREADY_RUNNING: 'api.assistant.alreadyRunning'
    }));
  } catch (e) {
    console.error('[assistant] execute 失败:', e && e.message);
    res.json({
      ok: false,
      code: (e && e.code) || 'ASSISTANT_ERROR',
      error: '小智执行失败：' + (e && e.message ? e.message : String(e)),
      ...i18n.err(req.lang, 'api.assistant.executeFailed')
    });
  }
});

// 状态机快照 + 关联任务视图（前端轮询用）
app.get('/api/assistant/state', (req, res) => {
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : '';
  if (!sessionId) {
    return res.json({
      ok: false,
      code: 'ASSISTANT_BAD_SESSION',
      error: '需要 sessionId',
      ...i18n.err(req.lang, 'api.assistant.badSession')
    });
  }
  try {
    res.json(assistantSupervisor.stateOf(sessionId, req.query.planId ? String(req.query.planId) : null));
  } catch (e) {
    res.json({ ok: false, code: 'ASSISTANT_ERROR', error: e.message });
  }
});

// 会话记忆 + 任务检索（q 触发「上一次视频」式检索）
app.get('/api/assistant/memory', (req, res) => {
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : '';
  if (!sessionId) {
    return res.json({
      ok: false,
      code: 'ASSISTANT_BAD_SESSION',
      error: '需要 sessionId',
      ...i18n.err(req.lang, 'api.assistant.badSession')
    });
  }
  try {
    const session = assistantMemory.getSession(sessionId);
    const messages = assistantMemory.listMessages(sessionId, Number(req.query.limit) || 50);
    const state = assistantMemory.getState(sessionId);
    let refs = [];
    if (req.query.q) {
      try { refs = assistantSupervisor.retrieveRefs(String(req.query.q), 5).refs; } catch (e) { refs = []; }
    }
    res.json({
      ok: true,
      sessionId,
      messages,
      lastPlan: assistantSupervisor.briefPlan(assistantMemory.lastPlan(sessionId)),
      state: state
        ? { planId: state.planId, state: state.state, taskId: state.taskId, finalTaskId: state.finalTaskId, reason: state.reason }
        : null,
      refs
    });
  } catch (e) {
    res.json({ ok: false, code: 'ASSISTANT_ERROR', error: e.message });
  }
});

// ==========================================
// 2026-11-17 小智 2.0 V2：只读环境上下文 / 跨会话偏好 / 审计 / 修复 / 设置确认
// ------------------------------------------------------------
// 共同契约（与 supervisor / verify-assistant 一致）：
//   · GET 一律只读：不建任务、不写文件、不调模型；
//   · 任何会改状态或可能花钱的动作（偏好写入、修复执行、设置变更确认）**必须显式 approved:true**，
//     否则返回 SETTINGS_NOT_APPROVED / PAYMENT_NOT_APPROVED，且不产生任何副作用；
//   · Key 只报有/无；审计经 redact 脱敏，Key 值不落盘、不回显；
//   · 登录中间件已在这些路由之前（AUTH_PUBLIC_API 未放行它们）。
// ==========================================
function assistantRequestUserId(req) {
  return (req.auth && req.auth.userId) ? String(req.auth.userId) : 'local';
}

// 助手旧契约（ok:false + code + error 中文原文）的加法式补丁：
// 只给已知 code 补 messageKey，绝不改 error/message 原文，也不改 ok 语义。
function withAssistantCodeKeys(out, codeKeyMap) {
  if (!out || typeof out !== 'object' || out.ok !== false) return out;
  const key = out.code && codeKeyMap ? codeKeyMap[out.code] : null;
  if (!key) return out;
  return { ...out, ...i18n.mark(key) };
}

// 只读环境上下文 A–E（B1/B2/B4/B5 的数据源；前端页面由 ?page= 上报）
app.get('/api/assistant/context', (req, res) => {
  try {
    const ctx = assistantSupervisor.contextOf(
      req.query.sessionId ? String(req.query.sessionId) : null,
      {
        page: req.query.page ? String(req.query.page) : null,
        userId: assistantRequestUserId(req),
        // 版本探针只读，不含 Key/路径清单
        server: { startedAt: SERVER_STARTED_AT, serverMtime: SERVER_FILE_MTIME, pid: process.pid }
      }
    );
    res.json({ ok: true, ...ctx });
  } catch (e) {
    res.json({ ok: false, code: 'ASSISTANT_CONTEXT_ERROR', error: '读取环境失败：' + (e && e.message ? e.message : String(e)), ...i18n.err(req.lang, 'api.assistant.contextFailed') });
  }
});

// 读跨会话偏好（只读）
app.get('/api/assistant/preferences', (req, res) => {
  try {
    res.json(assistantSupervisor.getPreferences({ userId: assistantRequestUserId(req) }));
  } catch (e) {
    res.json({ ok: false, code: 'ASSISTANT_PREFS_ERROR', error: (e && e.message) || String(e), ...i18n.err(req.lang, 'api.assistant.prefsFailed') });
  }
});

// 写跨会话偏好（L3：必须 approved:true）
app.post('/api/assistant/preferences', (req, res) => {
  const body = req.body || {};
  if (body.approved !== true) {
    return res.json({
      ok: false,
      code: 'SETTINGS_NOT_APPROVED',
      error: '偏好写入是设置变更（L3），需要明确确认（approved=true）；现在没有改任何东西',
      ...i18n.err(req.lang, 'api.assistant.prefsNotApproved')
    });
  }
  const userId = assistantRequestUserId(req);
  const patch = (body.patch && typeof body.patch === 'object')
    ? body.patch
    : {
      model: body.model,
      resolution: body.resolution,
      clipDurationSec: body.clipDurationSec,
      bgmStyle: body.bgmStyle
    };
  const r = assistantPreferences.set(userId, patch);
  if (!r.ok) {
    return res.json({ ok: false, code: r.code || 'PREFS_WRITE_FAILED', error: r.error, rejected: r.rejected || [] });
  }
  const logged = assistantAudit.record({
    actor: userId,
    kind: 'preferences',
    action: 'set',
    target: { userId },
    before: r.before,
    after: r.pref,
    note: 'HTTP 写入跨会话偏好'
  });
  res.json({
    ok: true,
    preferences: assistantPreferences.describe(userId),
    broadcast: assistantPreferences.globalSettings(),
    accepted: r.accepted,
    rejected: r.rejected,
    audit: logged.ok ? logged.entry : null,
    auditError: logged.ok ? null : logged.error
  });
});

// 清空跨会话偏好（L3：必须 approved:true）
app.post('/api/assistant/preferences/clear', (req, res) => {
  const body = req.body || {};
  try {
    res.json(withAssistantCodeKeys(assistantSupervisor.clearPreferences({
      userId: assistantRequestUserId(req),
      approved: body.approved === true
    }), {
      SETTINGS_NOT_APPROVED: 'api.assistant.prefsClearNotApproved'
    }));
  } catch (e) {
    res.json({ ok: false, code: 'ASSISTANT_PREFS_ERROR', error: (e && e.message) || String(e), ...i18n.err(req.lang, 'api.assistant.prefsFailed') });
  }
});

// 审计记录（只读；append-only JSONL，已脱敏）
app.get('/api/assistant/audit', (req, res) => {
  try {
    res.json({
      ok: true,
      entries: assistantAudit.list({ limit: Number(req.query.limit) || 50, kind: req.query.kind ? String(req.query.kind) : null }),
      total: assistantAudit.count()
    });
  } catch (e) {
    res.json({ ok: false, code: 'ASSISTANT_AUDIT_ERROR', error: (e && e.message) || String(e), ...i18n.err(req.lang, 'api.assistant.auditFailed') });
  }
});

// 确认对话里给出的设置变更（B6：pendingChange → confirmed；未确认不改）
app.post('/api/assistant/settings/confirm', (req, res) => {
  const body = req.body || {};
  try {
    res.json(withAssistantCodeKeys(assistantSupervisor.confirmSettingChange({
      sessionId: body.sessionId ? String(body.sessionId) : '',
      changeId: body.changeId ? String(body.changeId) : null,
      approved: body.approved === true,
      userId: assistantRequestUserId(req)
    }), {
      SETTINGS_NOT_APPROVED: 'api.assistant.settingsNotApproved'
    }));
  } catch (e) {
    res.json({ ok: false, code: 'ASSISTANT_SETTINGS_ERROR', error: (e && e.message) || String(e) });
  }
});

// 执行失败修复（Q20=B：必须 approved:true；未确认 → PAYMENT_NOT_APPROVED，不重跑）
app.post('/api/assistant/repair', async (req, res) => {
  const body = req.body || {};
  try {
    const out = await assistantSupervisor.repairTask({
      taskId: body.taskId ? String(body.taskId) : null,
      action: body.action ? String(body.action) : null,
      sessionId: body.sessionId ? String(body.sessionId) : null,
      approved: body.approved === true,
      userId: assistantRequestUserId(req),
      runtimeConfig: (body.runtimeConfig && typeof body.runtimeConfig === 'object') ? body.runtimeConfig : null
    });
    res.json(withAssistantCodeKeys(out, {
      PAYMENT_NOT_APPROVED: 'api.assistant.repairNotApproved',
      REPAIR_FAILED: 'api.assistant.repairFailed'
    }));
  } catch (e) {
    console.error('[assistant] repair 失败:', e && e.message);
    res.json({
      ok: false,
      code: 'ASSISTANT_REPAIR_ERROR',
      error: '修复执行失败：' + (e && e.message ? e.message : String(e)),
      ...i18n.err(req.lang, 'api.assistant.repairFailed')
    });
  }
});

// 离线语音识别（12MB / 60s 上限；不接受客户端文件路径）
app.post('/api/assistant/asr', async (req, res) => {
  const body = req.body || {};
  try {
    const out = await assistantAsr.transcribe({
      base64: body.audioBase64 || body.base64 || '',
      mime: body.mime || body.mimeType || ''
    });
    res.json(out);
  } catch (e) {
    console.error('[assistant] ASR 失败:', e && e.message);
    res.json({ ok: false, code: 'ASR_ERROR', error: '语音识别异常：' + (e && e.message ? e.message : String(e)), ...i18n.err(req.lang, 'api.assistant.asrFailed') });
  }
});

// 可选的「模型填槽」：只填计划卡，不执行任何生成。
// 这是唯一会产生 LLM 费用的入口，因此必须显式传 consent=true；没有 Key 不发请求。
const ASSISTANT_SLOT_SYSTEM_PROMPT = `你是「小智」的听懂模块，只做一件事：把用户的话填进计划卡槽位。
只输出一个 JSON 对象，不要 markdown、不要解释：
{"totalMinutes": number|null, "clipDurationSec": number|null, "clipCount": number|null,
 "resolution": "480p"|"720p"|"1080p"|"4k"|null, "model": "dashscope"|"kling"|"seedance"|null,
 "theme": string|null, "sceneCards": boolean|null}
规则：
- 用户没说的字段填 null，绝不猜总时长；「半小时」= 30，「两分钟」= 2。
- 主题只用中文地貌名（极光/雪山/沙漠/星空/海岸/森林/湖泊/瀑布/云雾山谷等），没提就 null。
- sceneCards 默认 null（由系统按产品口径开启）；用户说「不用场景卡」才填 false。
- 只填槽位，不执行、不生成视频、不报价。`;

app.post('/api/assistant/understand', async (req, res) => {
  const body = req.body || {};
  const text = String(body.text || '').trim();
  if (!text) {
    return res.json({
      ok: false,
      code: 'ASSISTANT_EMPTY_TEXT',
      error: '没有收到要说的话',
      ...i18n.err(req.lang, 'api.assistant.emptyText')
    });
  }
  if (body.consent !== true) {
    return res.json({
      ok: false,
      code: 'LLM_CONSENT_REQUIRED',
      error: '让模型解析计划卡会产生少量 LLM 费用；需要用户明确同意（consent=true）后才会发请求',
      ...i18n.err(req.lang, 'api.assistant.understandConsent')
    });
  }
  const llmCfg = { apiKey: body.llmApiKey, baseUrl: body.llmBaseUrl, model: body.llmModel };
  if (!llmCfg.apiKey && !config.OPENAI_API_KEY) {
    return res.json({ ok: false, code: 'NO_LLM_KEY' });
  }
  const { text: raw, failure } = await llmService.chatMulti(
    ASSISTANT_SLOT_SYSTEM_PROMPT,
    [{ role: 'user', content: text }],
    llmCfg
  );
  if (!raw) return res.json(llmFailurePayload(failure));
  let slots = null;
  try {
    const s = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) slots = JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    slots = null;
  }
  if (!slots || typeof slots !== 'object') {
    return res.json({
      ok: false,
      code: 'BAD_LLM_JSON',
      message: '模型没有按格式返回计划卡槽位',
      raw: String(raw).slice(0, 500),
      ...i18n.mark('api.assistant.badSlotsJson')
    });
  }
  const built = assistantPlanCard.buildPlan(assistantPlanCard.mergeModelSlots(text, slots));
  if (!built.ok) {
    return res.json({
      ok: false,
      code: built.code,
      error: built.error,
      missing: built.missing || null,
      question: built.question || null,
      slots
    });
  }
  res.json({ ok: true, plan: assistantSupervisor.briefPlan(built.plan), slots, source: 'llm' });
});


// 创建任务
app.post('/api/tasks', (req, res) => {
  const { prompt, prompts, clipTracks, bgm, model, theme, clipCount, totalClips, resolution, clipDuration, apiKey, apiBaseUrl, modelId: genModelId, klingAccessKey, klingSecretKey, llmApiKey, llmBaseUrl, llmModel, multimodalApiKey, multimodalBaseUrl, multimodalModel, strictQcItems, autoRetry, preset, stages, transition, colorMatch, adjust, sourcePhotoId, photoIds, sourcePhotoMotionPrompt, sceneCards } = req.body;

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
    return res.status(400).json({
      error: '请输入提示词',
      code: 'PROMPT_REQUIRED',
      ...i18n.err(req.lang, 'api.tasks.promptRequired')
    });
  }

  // 校验模型是否存在
  const availableModels = getAvailableModels();
  const modelId = model || 'mock';
  // Mock 模型永远可用；真实模型即使没配 Key 也允许（前端传了 Key 就行）
  const modelExists = availableModels.some(m => m.id === modelId);
  if (!modelExists) {
    return res.status(400).json({
      error: '不支持的模型: ' + modelId,
      code: 'UNSUPPORTED_MODEL',
      ...i18n.err(req.lang, 'api.tasks.unsupportedModel', { model: modelId })
    });
  }

  // 图生视频（2026-11-11 用户口径）：sourcePhotoId 必须是图片库里「已通过」的图，
  // 且所选模型必须已有实现过的图生视频通道。否则直接 400，绝不静默按文字生成。
  let sourcePhoto = null;
  if (sourcePhotoId) {
    sourcePhoto = photoLibrary.get(String(sourcePhotoId));
    if (!sourcePhoto) {
      return res.status(400).json({
        error: '图生视频的源图片不存在: ' + sourcePhotoId,
        code: 'SOURCE_PHOTO_MISSING',
        ...i18n.err(req.lang, 'api.tasks.sourcePhotoMissing', { id: String(sourcePhotoId) })
      });
    }
    if (sourcePhoto.status !== 'approved') {
      return res.status(400).json({
        error: '图生视频的源图片还没通过审核（请到「照片」页点通过）',
        code: 'SOURCE_PHOTO_NOT_APPROVED',
        ...i18n.err(req.lang, 'api.tasks.sourcePhotoNotApproved')
      });
    }
    // 2026-11-16 用户口径（明确指令）：**人工点「通过」即可用于图生视频**，
    // 科学/物理审查与「最终版」不再是硬闸门（原实现要求 scienceStatus=passed + isFinal=true，
    // 而新出图两者都不满足、且设为最终版又要求 scienceStatus=passed → 结构性死锁，永远无法生成）。
    // 审查与版本选择仍在 UI 保留，作为建议/管理用途，不再 400 拦截。
    if (!getI2VInfo(modelId)) {
      return res.status(400).json({
        error: `模型「${modelId}」没有已实现的图生视频通道（已实现：${listI2VModels().join(' / ')}）。`
          + '请切换视频模型，或取消勾选「用这张图生成视频」。',
        code: 'I2V_UNSUPPORTED_MODEL',
        ...i18n.err(req.lang, 'api.tasks.i2vUnsupported', { model: modelId })
      });
    }
  }

  // 校验片段数量（多提示词模式下以行数为准）
  const count = multiPrompts ? multiPrompts.length : (clipCount || totalClips || 10);
  if (count < 1 || count > 200) {
    return res.status(400).json({
      error: '片段数量必须在 1-200 之间' + (multiPrompts ? `（当前输入了 ${multiPrompts.length} 行提示词）` : ''),
      code: 'CLIP_COUNT_RANGE',
      ...i18n.err(req.lang, 'api.tasks.clipCountRange')
    });
  }

  // 图片优先链路（2026-11-12）：按顺序给每个片段一张已通过的图。
  // 与 sourcePhotoId 的区别：sourcePhotoId = 全任务同一张首帧；photoIds = 每片段各自首帧。
  let photoIdList = null;
  if (Array.isArray(photoIds) && photoIds.length > 0) {
    if (!getI2VInfo(modelId)) {
      return res.status(400).json({
        error: `模型「${modelId}」没有已实现的图生视频通道（已实现：${listI2VModels().join(' / ')}）。`,
        code: 'I2V_UNSUPPORTED_MODEL',
        ...i18n.err(req.lang, 'api.tasks.i2vUnsupported', { model: modelId })
      });
    }
    if (photoIds.length !== count) {
      return res.status(400).json({
        error: `photoIds 数量（${photoIds.length}）必须与片段数（${count}）一致`,
        code: 'PHOTO_COUNT_MISMATCH',
        ...i18n.err(req.lang, 'api.tasks.photoCountMismatch', { got: photoIds.length, expected: count })
      });
    }
    photoIdList = [];
    for (let i = 0; i < photoIds.length; i++) {
      const p = photoLibrary.get(String(photoIds[i]));
      if (!p) {
        return res.status(400).json({
          error: `第 ${i + 1} 个片段的图片不存在: ${photoIds[i]}`,
          code: 'PHOTO_MISSING',
          ...i18n.err(req.lang, 'api.tasks.photoMissing', { index: i + 1, id: String(photoIds[i]) })
        });
      }
      if (p.status !== 'approved') {
        return res.status(400).json({
          error: `第 ${i + 1} 个片段的图片未通过审核（批量链路请用 status=approved 的图）`,
          code: 'PHOTO_NOT_APPROVED',
          ...i18n.err(req.lang, 'api.tasks.photoNotApproved', { index: i + 1 })
        });
      }
      // 2026-11-16 用户口径：批量出图的「已通过」即放行（不再要求科学审查/最终版，原因同上方注释）。
      photoIdList.push(p.id);
    }
  }

  // 校验单段时长
  const duration = clipDuration || config.GENERATION.defaultClipDuration || 15;
  if (duration < 1 || duration > 60) {
    return res.status(400).json({
      error: '单段时长必须在 1-60 秒之间',
      code: 'CLIP_DURATION_RANGE',
      ...i18n.err(req.lang, 'api.tasks.durationRange')
    });
  }

  // ===== 场景卡模式（P4）=====
  // 只做后端开关：P4 不改 UI，P5 小智创建任务时显式传 { sceneCards: true }。
  // 约束（产品已定）：v3.3 为唯一输入；每段 10s；单任务上限 180 张（30 分钟），
  // 超出必须先扩卡库 → 明确 400，不允许静默复用或悄悄降级成普通提示词任务。
  const sceneCardRequested = sceneCards === true
    || (sceneCards && typeof sceneCards === 'object' && sceneCards.enabled === true);
  if (sceneCardRequested) {
    if (multiPrompts) {
      return res.status(400).json({
        error: '场景卡模式不接受逐行提示词（prompts）：场景内容由卡库提供，请只传主题/提示词。',
        code: 'SCENE_CARDS_WITH_PROMPTS',
        ...i18n.err(req.lang, 'api.tasks.sceneCardsWithPrompts')
      });
    }
    if (sourcePhoto) {
      return res.status(400).json({
        error: '场景卡模式暂不支持图生视频（sourcePhotoId）：卡库已是完整画面指令。',
        code: 'SCENE_CARDS_WITH_I2V',
        ...i18n.err(req.lang, 'api.tasks.sceneCardsWithI2v')
      });
    }
    if (Array.isArray(photoIds) && photoIds.length > 0) {
      return res.status(400).json({
        error: '场景卡模式暂不支持逐片段首帧（photoIds）：卡库已是完整画面指令。',
        code: 'SCENE_CARDS_WITH_I2V',
        ...i18n.err(req.lang, 'api.tasks.sceneCardsWithI2v')
      });
    }
    const cap = sceneCardLibrary.checkCapacity(count);
    if (!cap.ok) {
      const status = cap.code === 'SCENE_CARDS_EXHAUSTED' ? 400 : 503;
      return res.status(status).json({
        error: cap.error,
        code: cap.code,
        available: cap.available,
        requested: count,
        ...i18n.err(req.lang, 'api.tasks.sceneCardsCapacity', { available: cap.available, requested: count })
      });
    }
    if (Number(duration) !== Number(cap.durationSec)) {
      return res.status(400).json({
        error: `场景卡按 ${cap.durationSec} 秒/段设计（30 分钟 = ${cap.available} 张 × ${cap.durationSec}s）；`
          + `本次 clipDuration=${duration}。请改为 ${cap.durationSec} 秒或关闭场景卡。`,
        code: 'SCENE_CARDS_DURATION',
        ...i18n.err(req.lang, 'api.tasks.sceneCardsDuration', { duration: cap.durationSec, got: duration })
      });
    }
  }

  // 创建任务（多提示词模式下 prompt 取第一行文本，各片段提示词/主题由 prompts 逐一分配）
  const firstPrompt = prompt || (multiPrompts ? multiPrompts[0].text : '') || '';

  // ===== 防重复计费 + 余额闸门（2026-11-14）=====
  // 顺序：先算美元预估 → 查 5 分钟内同指纹 → 查余额；全部通过才允许创建任务/写图片记录。
  // 依据：2026-11-09 账单里 4 秒内创建了 4 个真实计费任务（1×720P + 3×1080P）。
  const resolutionValue = resolution || config.GENERATION.defaultResolution || '720p';
  const realModel = modelId !== 'mock';
  const forceCreate = req.body && req.body.force === true;
  const estimateUsd = budget.estimateTask({
    clips: count,
    seconds: duration,
    resolution: resolutionValue,
    images: 0,
    llmCalls: realModel ? 1 : 0
  });
  let dupFingerprint = null;
  if (realModel) {
    dupFingerprint = submitGuard.fingerprint(submitGuard.build({
      model: modelId,
      resolution: resolutionValue,
      clipDuration: duration,
      clips: count,
      prompts: multiPrompts ? multiPrompts.map(p => p.text) : [firstPrompt],
      preset: preset || '',
      sourcePhotoId: sourcePhoto ? sourcePhoto.id : '',
      photoIds: photoIdList || [],
      transition: transition || null,
      colorMatch: colorMatch || null
    }));
    if (!forceCreate) {
      const dup = submitGuard.check(dupFingerprint);
      if (dup) {
        return res.status(409).json({
          error: `重复提交已拦截：${Math.ceil(submitGuard.WINDOW_MS / 60000)} 分钟内已创建过完全相同的任务`
            + `（${dup.taskId || '未知 id'}）。为避免重复计费，本次不再创建；确需再跑一次请显式传 force=true。`,
          code: 'DUPLICATE_TASK',
          existingTaskId: dup.taskId,
          retryAfterSec: dup.retryAfterSec,
          estimateUsd: estimateUsd.usd,
          ...i18n.err(req.lang, 'api.tasks.duplicate', { window: Math.ceil(submitGuard.WINDOW_MS / 60000) })
        });
      }
    }
    if (estimateUsd.usd > 0 && !budget.canAfford(estimateUsd.usd)) {
      const st = budget.status();
      return res.status(402).json({
        error: `余额不足：本次预计 $${estimateUsd.usd.toFixed(2)}，剩余 $${st.balanceUsd.toFixed(2)}。`
          + '请减少片段数/单段时长，或降分辨率；充值后用 POST /api/budget/set 对账。',
        code: 'INSUFFICIENT_BUDGET',
        estimateUsd: estimateUsd.usd,
        breakdown: estimateUsd.breakdown,
        budget: { balanceUsd: st.balanceUsd, spentUsd: st.spentUsd },
        ...i18n.err(req.lang, 'api.tasks.insufficientBudget', {
          estimate: estimateUsd.usd.toFixed(2),
          balance: st.balanceUsd.toFixed(2)
        })
      });
    }
  }

  // 用户口径（2026-11-11）：「改过提示词再用这张图生成视频」→ 分开存：
  // imagePrompt（画面）保持不动，videoPrompt 记录这次视频用的运动提示词，互不覆盖。
  if (sourcePhoto) {
    const motion = String(sourcePhotoMotionPrompt || firstPrompt || '').trim();
    if (motion) {
      photoLibrary.update(sourcePhoto.id, {
        videoPrompt: motion.slice(0, 8000),
        videoPromptUpdatedAt: new Date().toISOString(),
        promptSource: 'video-task'
      });
    }
  }

  let task;
  try {
    task = taskManager.createTask(firstPrompt.trim(), {
    model: modelId,
    // 语言：长任务/日志按创建时的界面语言记录（缺字段/旧任务由 taskManager 归一为 zh）。
    // 只做持久化留痕，不改变中文默认输出；P3 里 AI 输出语言另有 aiLang（可与界面语言分离）。
    lang: req.lang,
    // 自动重试：缺省 true（API/旧前端兼容）；新版创作页传 false → 只试一次，失败交用户决定
    autoRetry: autoRetry !== false,
    theme: theme ?? null,
    // 图生视频：存图片库条目 id；流水线运行时会重新校验文件与审核状态
    sourcePhotoId: sourcePhoto ? sourcePhoto.id : undefined,
    totalClips: count,
    resolution: resolutionValue,
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
    // 拼接时自动校色：{ enabled }。不传 = 关闭（默认关，会改变画面观感，必须用户知情）。
    // 与 transition 互斥：enabled 时必须开启转场，校验在 taskManager.createTask（2026-10-27）。
    colorMatch: (colorMatch && typeof colorMatch === 'object') ? colorMatch : null,
    // 剪映「调节」：{ brightness, contrast, ... }。不传/全 0 = 不调节。
    // 2026-11-02 补：此前 API 入口漏了透传，taskManager/pipeline 的接线等于没通到 HTTP。
    adjust: (adjust && typeof adjust === 'object') ? adjust : null,
    // 兼容：老前端仍传 clipTracks 时保留透传，由 createTask 收敛为整片主曲
    clipTracks: Array.isArray(clipTracks) ? clipTracks.slice(0, count) : undefined,
    // 场景卡模式（P4）：取卡 + 拼提示词在 taskManager.createTask 内完成；
    // 这里只传开关。失败由外层 try/catch 转成明确的 4xx/5xx，不静默降级成普通任务。
    sceneCards: sceneCardRequested ? { enabled: true } : undefined,
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
  } catch (e) {
    // 场景卡取卡失败（卡库缺失/结构异常/数量超限）→ 明确报错；
    // 非场景卡任务的异常保持原有行为（不吞错）。
    if (sceneCardRequested) {
      const status = e && e.code === 'SCENE_CARDS_EXHAUSTED' ? 400 : 503;
      return res.status(status).json({
        error: '场景卡取卡失败: ' + (e && e.message ? e.message : String(e)),
        code: (e && e.code) || 'SCENE_CARDS_ERROR',
        ...i18n.err(req.lang, 'api.tasks.sceneCardsFailed')
      });
    }
    throw e;
  }

  // 记账：任务创建成功才扣款并登记指纹；创建失败不会走到这里。
  if (realModel && estimateUsd.usd > 0) {
    try {
      budget.reserve({
        usd: estimateUsd.usd,
        kind: 'video',
        taskId: task.taskId,
        meta: { model: modelId, resolution: resolutionValue, clips: count, seconds: duration }
      });
    } catch (e) {
      // 理论上不会发生（前面已 canAfford）；真发生就明确告警，不静默超额。
      console.error('[budget] 预留失败:', e.message);
    }
  }
  if (dupFingerprint) {
    submitGuard.remember(dupFingerprint, { taskId: task.taskId, model: modelId, clips: count });
  }

  // 图片优先：把每张已通过的图按顺序挂到对应片段，流水线逐片段取首帧。
  if (photoIdList) {
    for (let i = 0; i < photoIdList.length; i++) {
      taskManager.updateClip(task.taskId, i, { photoId: photoIdList[i] });
    }
  }

  // 启动流水线
  pipeline.startTask(task.taskId);

  // 追溯：这张图被哪个视频任务用过（失败不影响任务）
  if (sourcePhoto) {
    try { photoLibrary.attachUsage(sourcePhoto.id, task.taskId); } catch (e) { console.warn('[tasks] 记录图片来源失败:', e.message); }
  }

  res.json({
    taskId: task.taskId,
    status: task.status,
    // 加法式：让前端知道本任务创建时的界面语言（旧任务/缺字段 = zh）
    lang: task.lang || i18n.DEFAULT_LANG
  });
});

// 场景卡库状态（P4）：只读探针。单任务的取卡/耗尽状态见 GET /api/tasks/:id 的 sceneCards 字段。
app.get('/api/scene-cards', (req, res) => {
  try {
    const stats = sceneCardLibrary.getStats();
    res.json({
      ok: true,
      ...stats,
      rules: {
        role: 'feature 用于正片；buffer 仅生成失败时替换',
        order: 'chapter+sequence（不放回；同一轮内不重复）',
        replacement: 'buffer 同一任务不复用，用尽则保留失败结果',
        durationSec: stats.durationSec,
        maxClipsPerTask: stats.maxClipsPerTask,
        exhausted: '超过正片数量时 400 并提示扩卡库（不静默复用）'
      }
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: e && e.message ? e.message : String(e),
      code: (e && e.code) || 'SCENE_CARDS_ERROR'
    });
  }
});

// 场景卡预览（P2 创作向导 ①）：只读，不建任务、不持久化。
// allocate() 只产出内存计划（不写卡库、不占卡），因此可安全用于「先看看抽到哪些场景」。
// 返回每段的视频提示词 / 图片提示词 / 参数化调色，供「① 时长+场景卡 ② 提示词 ③ 出图」使用。
app.get('/api/scene-cards/preview', (req, res) => {
  const count = Math.max(1, Math.min(180, parseInt(req.query.count, 10) || 10));
  try {
    const promptComposer = require('./src/promptComposer');
    // 2026-11-17 V1 遗留 ②：本接口注释写着「只读、不持久化」，但 allocate() 默认
    // recordCooling=true，点一次「看场景卡」就消耗一次最近 3 个计划的冷却窗口。
    // 预览不是真实排计划，必须显式关闭冷却写入。
    const plan = sceneCardLibrary.allocate(count, { recordCooling: false });
    const cards = plan.used.map((entry, i) => {
      const card = sceneCardLibrary.getCardById(entry.id);
      if (!card) {
        const e = new Error(`场景卡缺失：${entry.id}（卡库可能被替换）`);
        e.code = 'SCENE_CARDS_MISSING_CARD';
        throw e;
      }
      const patch = promptComposer.composeClipPatch(card, {});
      return {
        index: i,
        id: card.id,
        sceneKey: card.scene_key,
        chapter: card.chapter,
        sequence: card.sequence,
        role: entry.role || card.role || 'feature',
        durationSec: Number(card.durationSec) || 10,
        paletteId: card.palette_id || null,
        prompt: patch.prompt,
        imagePrompt: patch.imagePrompt,
        adjust: patch.adjust || null
      };
    });
    res.json({ ok: true, count: cards.length, cards });
  } catch (e) {
    res.status(e && e.code === 'SCENE_CARDS_EXHAUSTED' ? 400 : 503).json({
      ok: false,
      code: (e && e.code) || 'SCENE_CARDS_ERROR',
      error: e && e.message ? e.message : String(e)
    });
  }
});

// 获取质检项定义
app.get('/api/qc-items', (req, res) => {
  res.json({
    qcItems: qualityChecker.getQCItems(),
    pipelineSteps: taskManager.getPipelineSteps(),
    // 加法式（P2）：本次请求语言；qcItems 的 labelKey/labelZh/labelEn 是新增字段，
    // 原有 name/desc/category 与判定语义完全不变。
    lang: req.lang
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
      fragmentOnly: t.fragmentOnly || false,
      // 失败原因分类：前端据此把「暂停超时 / 暂停被重启打断」与普通失败分开显示。
      // 取值见 docs/spec/pause-capability-spec.md §4：
      //   pause_timeout / pause_interrupted / null（普通失败或无失败）
      failureCode: t.failureCode || null,
      recoverable: !!t.recoverable,
      // 加法式 i18n 字段（P2）：任务创建时语言 + 失败原因的 messageKey（能精确反查到才给）
      lang: t.lang || i18n.DEFAULT_LANG,
      errorKey: t.errorKey || null
    };
  }));
});

// 获取任务详情
app.get('/api/tasks/:id', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
  }
  // 补质检可信度标注：qcVersion / qcTrusted / qcLabel（verified | legacy_unverified）。
  // taskManager.getTask 直接读内存对象、不会自动标注（storage.getTask 才标），
  // 不在这里补，前端就无法区分「修复后真实执行的质检」与「修复前伪造的 pass」。
  // annotateTaskQC 返回新对象、不改原对象，安全。
  const out = storage.annotateTaskQC(task);
  // 加法式 i18n 字段（P2）：旧任务没有 lang 字段 → 视为 zh；errorKey 由 taskManager 在失败时反查得到。
  if (!out.lang) out.lang = i18n.DEFAULT_LANG;
  res.json(out);
});

// 获取任务进度
app.get('/api/tasks/:id/progress', (req, res) => {
  const progress = taskManager.getProgress(req.params.id);
  if (!progress) {
    return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
  }
  res.json(progress);
});

// 获取片段状态（含视频文件信息，供详情页"片段列表"使用）
app.get('/api/tasks/:id/clips', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
  }

  const clipsDir = config.STORAGE.clipsDir;

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
      // 场景卡审计字段（P4）：第几号卡、正片还是缓冲、有没有被 buffer 替换过
      sceneKey: c.sceneKey || null,
      sceneCardId: c.sceneCardId || null,
      sceneCardRole: c.sceneCardRole || null,
      sceneCardReplacement: c.sceneCardReplacement || null,
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

// ==========================================
// 预算闸门（2026-11-14）
// ==========================================
// 真实账单口径是美元（WhaleTV）：720P $0.10/s、1080P $0.20/s、图片 $0.03/张。
// 人民币价目表（pricing.js）继续保留给旧页面/片段库展示，但「能不能再花钱」
// 以这里的美元余额为准。状态落 data/budget.json，重启不丢。
app.get('/api/budget', (req, res) => {
  res.json({ ok: true, ...budget.status() });
});

// 手动对账：从网关控制台看到实际余额后，把剩余金额写回（会留一条 set 记录）
app.post('/api/budget/set', (req, res) => {
  const usd = Number(req.body && req.body.balanceUsd);
  if (!Number.isFinite(usd) || usd < 0) {
    return res.status(400).json({
      ok: false,
      error: 'balanceUsd 必须是非负数（美元）',
      code: 'BUDGET_INVALID_AMOUNT',
      ...i18n.err(req.lang, 'api.budget.invalidAmount')
    });
  }
  try {
    res.json({ ok: true, ...budget.setBalance(usd) });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message,
      code: 'BUDGET_SET_FAILED',
      ...i18n.err(req.lang, 'api.budget.setFailed')
    });
  }
});

// 生成前费用预估：与 /api/pricing 用同一份 src/pricing.js，前端不再自己抄价目表。
// 旧版口径（public/index.html，已删）：非 mock 才提示；余额留空 = 不拦截；预计 > 余额 → 拦截。
// 2026-11-14 起同时返回美元预估与预算闸门状态：前端展示、后端 /api/tasks 强制拦截共用同一口径。
app.post('/api/estimate', (req, res) => {
  const b = req.body || {};
  const clipCount = Math.max(1, Math.min(500, parseInt(b.clipCount, 10) || 1));
  const unit = pricing.computeUnitPrice({
    model: typeof b.model === 'string' ? b.model : '',
    resolution: typeof b.resolution === 'string' ? b.resolution : '',
    clipDurationSec: Number(b.clipDuration) || 0,
    modelId: typeof b.modelId === 'string' ? b.modelId : ''
  });
  const seconds = Math.max(0, Number(b.clipDuration) || 0);
  const isMock = String(b.model || '').toLowerCase() === 'mock';
  const usd = isMock
    ? { usd: 0, breakdown: { video: 0, image: 0, llm: 0, clips: clipCount, seconds, resolution: String(b.resolution || '').toLowerCase(), videoRate: 0 } }
    : budget.estimateTask({
      clips: clipCount,
      seconds,
      resolution: b.resolution,
      images: Math.max(0, parseInt(b.images, 10) || 0),
      llmCalls: Math.max(0, parseInt(b.llmCalls, 10) || 0)
    });
  const st = budget.status();
  res.json({
    ok: true,
    clips: clipCount,
    basis: unit.basis,
    unit,
    perClip: unit.amountPerAttempt || 0,
    estimate: pricing.round2((unit.amountPerAttempt || 0) * clipCount),
    currency: 'CNY',
    priceVersion: pricing.PRICE_VERSION,
    // 美元侧（真实账单口径）
    usd: usd.usd,
    usdBreakdown: usd.breakdown,
    budget: {
      currency: 'USD',
      balanceUsd: st.balanceUsd,
      spentUsd: st.spentUsd,
      affordable: isMock || usd.usd <= st.balanceUsd + 1e-9
    }
  });
});

// 库列表：按分辨率分组，支持主题/模型/收藏/关键字筛选
// 调节 LUT（预览用；与 ffmpeg lut3d 同一套 adjustChain）
app.post('/api/adjust/lut', (req, res) => {
  try {
    const r = adjustLut.get(req.body && req.body.adjust);
    res.json({ success: true, size: r.size, data: r.data });
  } catch (e) {
    res.status(500).json({ success: false, error: e && e.message ? e.message : 'LUT 生成失败' });
  }
});

// 素材缩略图（剪辑台素材栏/时间线用；首次请求抽帧后缓存）
app.get('/api/library/:id/thumb', async (req, res) => {
  try {
    const entry = library.get(req.params.id);
    if (!entry || !entry.filePath) {
      return res.status(404).json({
      success: false,
      error: '素材不存在',
      code: 'MEDIA_NOT_FOUND',
      ...i18n.err(req.lang, 'api.media.notFound')
    });
    }
    const file = await thumbnails.ensure(entry);
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  } catch (e) {
    res.status(500).json({ success: false, error: e && e.message ? e.message : '缩略图生成失败' });
  }
});

app.get('/api/library', (req, res) => {
  try {
    const { resolution, theme, model, favorite, q } = req.query;
    // 2026-11-15 用户口径：**文件缺失的条目不显示**（数据不删，文件找回后自动出现）。
    // 排查/对账用 ?includeMissing=1 取全量；hiddenMissing 报告被隐藏的条数。
    const includeMissing = String(req.query.includeMissing || '') === '1';
    const withFileState = (it) => ({ ...it, fileMissing: !(it.filePath && fs.existsSync(it.filePath)) });
    const everything = library.listAll().map(withFileState);
    const all = includeMissing ? everything : everything.filter((it) => !it.fileMissing);
    const hiddenMissing = everything.length - all.length;
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
      hiddenMissing,
      includeMissing,
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

// 删除库条目：2026-11-15 起移入回收站（可恢复），不再直接删文件
app.delete('/api/library/:id', (req, res) => {
  const result = library.remove(req.params.id);
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json({ success: true, trashed: !!result.trashed, recycleDir: result.recycleDir || null });
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
      // P2：任务语言（日志/历史按创建时界面语言）
      lang: req.lang,
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
    const task = taskManager.createLibraryTask({ segments, resolution: target, transition, lang: req.lang });
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
// 状态码口径（docs/spec/pause-decision.md §3）：
//   404 = 任务不存在；400 = 任务存在但未在运行 / 未处于暂停状态；重复 pause 幂等返回 200。
// 暂停超时/重启回收的失败用 task.failureCode 区分（pause_timeout / pause_interrupted），
// 不占用 HTTP 状态码。
const pauseErrorStatus = (result) => (result.error === '任务不存在' ? 404 : 400);

app.post('/api/tasks/:id/pause', (req, res) => {
  const result = pipeline.pauseTask(req.params.id);
  if (!result.success) return res.status(pauseErrorStatus(result)).json(result);
  res.json(result);
});

app.post('/api/tasks/:id/unpause', (req, res) => {
  const result = pipeline.resumeTask(req.params.id);
  if (!result.success) return res.status(pauseErrorStatus(result)).json(result);
  res.json(result);
});

// 查询暂停状态
app.get('/api/tasks/:id/pause-state', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
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
  // 旧任务落盘时 Key 被脱敏，必须接受前端带上来的当前设置，否则重启后重生成会降级 Mock
  const runtimeConfig = (req.body && req.body.runtimeConfig) || null;
  const result = await pipeline.regenerateClip(req.params.id, clipIndex, prompt, runtimeConfig);
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
    completed: Array.isArray(body.completed) ? body.completed : undefined,
    runtimeConfig: body.runtimeConfig || null
  });
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// ===== 调节：保存参数 + 重新导出（2026-11-02）=====
//
// 语义：
//   1) adjustChain.normalizeParams 做白名单 + 钳制（非法值丢弃）；null = 清空调节
//   2) 只重跑 transcoding / audio_mix / final_qc，复用拼接/循环产物，不重新生成片段
//   3) 旧成片先改名备份为 <taskId>_final_v<时间戳>.mp4，再写新成片；失败时 outputPath
//      仍指向旧成片，前端不会看到「成片消失」
//   4) 失败必须把 error 返回给前端（AGENTS §4.8：不许静默成功）
app.post('/api/tasks/:id/adjust', async (req, res) => {
  try {
    if (!config.ADJUST || !config.ADJUST.enabled) {
      return res.status(400).json({ success: false, error: '调节功能未启用（ADJUST_ENABLED=false）' });
    }
    const taskId = req.params.id;
    const task = taskManager.getTask(taskId);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
    if (pipeline.runningTasks.has(taskId)) {
      return res.status(409).json({ success: false, error: '任务正在运行中，请稍后再试' });
    }

    const body = req.body || {};
    const raw = body.adjust !== undefined ? body.adjust : body;
    const normalized = require('./src/processors/adjustChain').normalizeParams(raw);

    const oldFinal = task.outputPath && fs.existsSync(task.outputPath) ? task.outputPath : null;
    if (!oldFinal) {
      return res.status(400).json({ success: false, error: '该任务还没有可重新导出的成片' });
    }

    const DROP = ['transcoding', 'audio_mix', 'final_qc'];
    const completed = pipeline._completedSteps(task).filter((s) => !DROP.includes(s));
    if (!completed.includes('concatenation')) {
      return res.status(400).json({ success: false, error: '缺少拼接产物，无法重新导出' });
    }

    // 旧成片改名备份（同盘 rename，不复制大文件）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = oldFinal.replace(/\.mp4$/i, '') + '_v' + stamp + '.mp4';
    try {
      fs.renameSync(oldFinal, backup);
    } catch (e) {
      return res.status(500).json({ success: false, error: '旧成片备份失败：' + e.message });
    }

    // outputPath 先指向备份：重导出运行中/失败时，前端仍能播放旧成片
    taskManager.updateTaskStatus(taskId, task.status, {
      adjust: normalized || null,
      adjustApplied: null,
      outputPath: backup
    });

    const result = await pipeline.continueTask(taskId, { preset: 'final', completed });
    if (!result.success) {
      // 未起跑：把旧成片改回原名，避免留下一个悬空 outputPath
      try { if (!fs.existsSync(oldFinal)) fs.renameSync(backup, oldFinal); } catch (e) { /* ignore */ }
      return res.status(400).json(result);
    }
    res.json({
      success: true,
      taskId,
      adjust: normalized || null,
      backup: path.basename(backup),
      pending: result.pending,
      message: result.message || '已开始重新导出'
    });
  } catch (e) {
    console.error('[adjust] 失败:', e.message);
    res.status(500).json({ success: false, error: '调节重新导出失败：' + e.message });
  }
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
  if (!task) return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
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

// ===== 统一回收站 API（片段 / 成片 / 图片 / 配乐，2026-11-15）=====
// 与上面的任务垃圾箱分开：/api/trash 只收任务 JSON；这里收库条目 + 源文件。
const RECYCLE_RESTORE = {
  clip: (e) => library.restoreFromRecycle(e),
  final: (e) => library.restoreFromRecycle(e),
  photo: (e) => photoLibrary.restoreFromRecycle(e),
  bgm: (e) => audioMixer.restoreTrack(e)
};

app.get('/api/recycle', (req, res) => {
  try {
    res.json({ items: recycle.list(req.query.type || null) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/recycle/:type/:id/restore', (req, res) => {
  const type = String(req.params.type || '');
  const fn = RECYCLE_RESTORE[type];
  if (!fn) return res.status(400).json({ error: '未知回收类型: ' + type });
  const r = recycle.restore(type, req.params.id);
  if (!r.ok) return res.status(404).json({ error: r.error });
  let restoredEntry = null;
  try {
    if (r.entry) restoredEntry = fn(r.entry);
  } catch (e) {
    // 文件已经放回，条目没写回：明确报告，不要谎报成功
    return res.status(500).json({ error: '文件已恢复，但条目写回失败：' + e.message, restored: r.restored });
  }
  res.json({ success: true, restored: r.restored, conflicts: r.conflicts, entry: restoredEntry || r.entry });
});

app.delete('/api/recycle/:type/:id', (req, res) => {
  const r = recycle.purge(req.params.type, req.params.id);
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ success: true });
});

// 彻底清空：type=all 或具体类型
app.post('/api/recycle/:type/purge', (req, res) => {
  const type = req.params.type === 'all' ? null : req.params.type;
  res.json(recycle.purgeAll(type));
});

// 获取垃圾箱任务详情
app.get('/api/trash/:id', (req, res) => {
  const trashPath = path.join(__dirname, 'data', 'trash', `${req.params.id}.json`);
  if (!fs.existsSync(trashPath)) {
    return res.status(404).json({
      error: '任务不存在',
      code: 'TASK_NOT_FOUND',
      ...i18n.err(req.lang, 'api.tasks.notFound')
    });
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
  console.log(`  代码版本: server.js mtime=${SERVER_FILE_MTIME ? new Date(SERVER_FILE_MTIME).toISOString() : 'unknown'}`
    + `，启动=${SERVER_STARTED_AT}，pid=${process.pid}`);
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
