// ==========================================
// 认证与会话 - 单机共享账号体系
// ==========================================
// 设计约束（与 docs/spec/changelog.md 的「登录墙」一节一致）：
//   1. 密码只存 scrypt 哈希（Node 内置 crypto，零新依赖），明文不落盘、不进日志；
//   2. 会话 = 内存表 + 不设 Max-Age 的 cookie。关浏览器即失效；
//      服务重启即全体失效；另用 AUTH_SESSION_HOURS（默认 8）兜底绝对过期；
//   3. 登录失败按 IP 计数，连续 AUTH_MAX_FAILS（默认 5）次锁 AUTH_LOCK_MINUTES（默认 5）；
//   4. 认证存储不可用时返回 503，绝不 fail-open —— 放行等于这堵墙白做；
//   5. 会话 cookie 是 HttpOnly + SameSite=Lax，前端 JS 读不到。
//
// 注意：这里刻意不信任 X-Forwarded-For。本项目的部署形态是单机/内网，
// 而信任 XFF 会让攻击者伪造 IP 绕过失败锁定。
// ==========================================

const crypto = require('crypto');

const COOKIE_NAME = 'vs_session';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
// 「用户不存在」时也跑一次同代价的哈希，抹平时序差异，避免靠响应时间枚举账号
const DUMMY_HASH = 'scrypt$1$' + '0'.repeat(32) + '$' + '0'.repeat(128);

const sessions = new Map();   // token -> { userId, username, createdAt, expiresAt }
const failures = new Map();   // ip -> { fails, lockedUntil }

let storage = null;
let initPromise = null;

function getStorage() {
  if (!storage) storage = require('./storage');
  return storage;
}

function authConfig() {
  const cfg = require('../config');
  return (cfg && cfg.AUTH) || {};
}

function isEnabled() {
  return authConfig().enabled !== false;
}

// ===== 密码哈希 =====

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 生成 scrypt 哈希串：scrypt$1$<saltHex>$<hashHex> */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** 校验密码（任何格式异常一律 false，不抛错） */
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    if (!salt.length || !expected.length) return false;
    const key = await scryptAsync(password, salt);
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch (e) {
    return false;
  }
}

/** 恒时校验：用户不存在时也消耗一次 scrypt，防止「用户名枚举」 */
async function verifyPasswordConstant(password, stored) {
  const ok = await verifyPassword(password, stored || DUMMY_HASH);
  return !!stored && ok;
}

// ===== cookie =====

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch (e) { /* 保留原值 */ }
    out[k] = v;
  }
  return out;
}

function tokenFromRequest(req) {
  if (!req || !req.headers) return null;
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

// 2026-11-12 加固：HTTPS 部署时给会话 cookie 补 Secure，防止明文链路被嗅探。
// 判定顺序：COOKIE_SECURE=true 强制；否则看反代是否透传 X-Forwarded-Proto=https。
// 默认不加 —— 本机 http://localhost 加了 Secure 会导致浏览器直接不保存 cookie（登录失效）。
function _secureSuffix(res) {
  const forced = String(process.env.COOKIE_SECURE || '').toLowerCase();
  if (forced === '1' || forced === 'true') return '; Secure';
  const proto = res && res.req && res.req.headers && res.req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') return '; Secure';
  return '';
}

function setSessionCookie(res, token) {
  // 刻意不写 Max-Age / Expires：这是会话 cookie，关浏览器即失效。
  res.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${_secureSuffix(res)}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${_secureSuffix(res)}`);
}

// ===== 会话 =====

function sessionTtlMs() {
  const hours = Number(authConfig().sessionHours) || 8;
  return hours * 3600 * 1000;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    createdAt: now,
    expiresAt: now + sessionTtlMs()
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function destroySessionsOfUser(userId) {
  for (const [token, s] of sessions) {
    if (s.userId === userId) sessions.delete(token);
  }
}

function sessionCount() {
  return sessions.size;
}

// 定期清理过期会话，避免长期运行内存只增不减
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(token);
  }
  for (const [ip, rec] of failures) {
    if (rec.lockedUntil && rec.lockedUntil <= now) failures.delete(ip);
  }
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

/** 给中间件/WS 用：返回会话对象或 null */
function authorizeRequest(req) {
  if (!isEnabled()) return { userId: null, username: null, disabled: true };
  return getSession(tokenFromRequest(req));
}

// ===== 失败锁定 =====

function getClientIp(req) {
  // 2026-11-12 加固：前面挂 nginx/云反代时，remoteAddress 恒为 127.0.0.1，
  // 会让「连续失败锁 IP」退化成「锁所有人」，也让登录日志失去意义。
  // 但默认仍然不信任 X-Forwarded-For（客户端可伪造），必须显式开 TRUST_PROXY=1。
  //
  // 2026-11-23 公网隧道加固：只有「本机反代」才可信转发头。
  // cloudflared / 同机 nginx 的 peer 是回环；局域网直连可以伪造头，一律不认，
  // 否则同一个网段的人就能靠伪造 IP 绕过登录失败锁定。
  // 隧道场景优先用 CF-Connecting-IP（Cloudflare 边缘覆写，客户端改不了），
  // 它比 X-Forwarded-For 可靠——XFF 可能是客户端自带值被边缘追加。
  const trustProxy = String(process.env.TRUST_PROXY || '').toLowerCase();
  const trust = trustProxy === '1' || trustProxy === 'true' || trustProxy === 'yes';
  // 逃生口：反代不在本机（Docker 跨容器、另一台机器）时设 any。
  // 此时无法区分「反代」与「直连」，必须自行保证 3001 不对外暴露，否则可伪造转发头。
  const trustAny = trustProxy === 'any' || trustProxy === '2';
  const addr = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  // ::ffff:127.0.0.1 与 127.0.0.1 视为同一个来源
  const peer = String(addr).replace(/^::ffff:/, '');
  const isLoopback = peer === '::1' || /^127(?:\.\d{1,3}){3}$/.test(peer);
  if (trustAny || (trust && isLoopback)) {
    const cf = req && req.headers && req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim().replace(/^::ffff:/, '');
    const xff = req && req.headers && req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const first = xff.split(',')[0].trim();
      if (first) return first.replace(/^::ffff:/, '');
    }
  }
  return peer;
}

function checkLock(ip) {
  const rec = failures.get(ip);
  if (!rec || !rec.lockedUntil) return { locked: false };
  if (rec.lockedUntil <= Date.now()) {
    failures.delete(ip);
    return { locked: false };
  }
  return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
}

function recordFailure(ip) {
  const maxFails = Number(authConfig().maxFails) || 5;
  const lockMs = (Number(authConfig().lockMinutes) || 5) * 60 * 1000;
  const rec = failures.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  let locked = false;
  if (rec.fails >= maxFails) {
    rec.lockedUntil = Date.now() + lockMs;
    rec.fails = 0;
    locked = true;
  }
  failures.set(ip, rec);
  return { locked, remaining: Math.max(0, maxFails - rec.fails) };
}

function resetFailures(ip) {
  failures.delete(ip);
}

function lockState(ip) {
  const rec = failures.get(ip);
  return rec ? { fails: rec.fails, lockedUntil: rec.lockedUntil || 0 } : { fails: 0, lockedUntil: 0 };
}

// ===== 存储 =====

/** 懒初始化：服务启动时不阻塞，第一次登录时才连数据库 */
async function ensureAuthStorage() {
  if (!initPromise) {
    initPromise = getStorage().init().catch(e => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

async function findUserByUsername(username) {
  await ensureAuthStorage();
  return getStorage().getUserByUsername(username);
}

async function markLogin(userId) {
  try {
    await getStorage().touchUserLogin(userId);
  } catch (e) {
    console.error('[auth] 记录登录时间失败:', e.message);
  }
}

// ===== 首次启动引导 =====

function randomPassword(len = 12) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * 启动时调用：没有任何账号时创建第一个。
 * 优先用 .env 的 AUTH_USER / AUTH_PASSWORD；缺密码则随机生成并打印一次。
 * @returns {Promise<{created:boolean, username?:string, password?:string, count:number}>}
 */
async function doBootstrap() {
  if (!isEnabled()) {
    console.log('[auth] AUTH_ENABLED=false，登录墙未启用（任何人都能直接访问）');
    return { created: false, count: 0, skipped: true };
  }

  await ensureAuthStorage();
  const count = await getStorage().countUsers();
  if (count > 0) return { created: false, count };

  const cfg = authConfig();
  const username = String(cfg.bootstrapUser || '').trim() || 'admin';
  let password = String(cfg.bootstrapPassword || '');
  let generated = false;
  if (!password) {
    password = randomPassword(12);
    generated = true;
  }

  const minLen = Number(cfg.minPasswordLength) || 8;
  if (password.length < minLen) {
    console.warn(`[auth] 警告：AUTH_PASSWORD 只有 ${password.length} 位，小于建议的 ${minLen} 位`);
  }

  const passwordHash = await hashPassword(password);
  const user = await getStorage().createUser({ username, passwordHash });

  console.log('');
  console.log('  ========================================');
  console.log('  已创建第一个登录账号');
  console.log(`    账号: ${user.username}`);
  if (generated) {
    console.log(`    密码: ${password}`);
    console.log('    （随机生成，只在这里显示一次。写入 app/.env 的 AUTH_PASSWORD 后重启即可固定）');
  } else {
    console.log('    密码: 来自 app/.env 的 AUTH_PASSWORD');
  }
  console.log('  ========================================');
  console.log('');

  return { created: true, username: user.username, password: generated ? password : undefined, count: 1 };
}

let bootstrapPromise = null;

/**
 * 启动时调用：没有任何账号时创建第一个。
 * 幂等并要求被登录路由 await —— 否则存在「服务已启动、账号还没建完」的窗口，
 * 用户在这个窗口里打开浏览器会看到「账号或密码错误」（实测踩到过）。
 * 失败时清空缓存，允许下次重试（例如数据库临时不可用）。
 */
function bootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = doBootstrap().catch(e => {
      bootstrapPromise = null;
      throw e;
    });
  }
  return bootstrapPromise;
}

/** 登录路由用：等首次建号结束；失败不抛，交给后续存储错误处理 */
async function awaitBootstrap() {
  if (!bootstrapPromise) return null;
  try {
    return await bootstrapPromise;
  } catch (e) {
    return null;
  }
}

module.exports = {
  COOKIE_NAME,
  isEnabled,
  hashPassword,
  verifyPassword,
  verifyPasswordConstant,
  parseCookies,
  tokenFromRequest,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  getSession,
  destroySession,
  destroySessionsOfUser,
  sessionCount,
  authorizeRequest,
  getClientIp,
  checkLock,
  recordFailure,
  resetFailures,
  lockState,
  ensureAuthStorage,
  findUserByUsername,
  markLogin,
  bootstrap,
  awaitBootstrap,
  randomPassword
};
