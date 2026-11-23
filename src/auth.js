// ==========================================
// 认证与会话 - 单机共享账号体系
// ==========================================
// 设计约束（与 docs/spec/changelog.md 的「登录墙」一节一致）：
//   1. 密码只存 scrypt 哈希（Node 内置 crypto，零新依赖）；日志层对引导口令做脱敏，
//      终端仍会显示一次（否则首次无法登录）；
//   2. 会话 = 内存表 + 不设 Max-Age 的 cookie。关浏览器即失效；
//      服务重启即全体失效；另用 AUTH_SESSION_HOURS（默认 8）兜底绝对过期；
//   3. 登录失败按「IP + 账号」计数，另设同 IP 跨账号的全局限流；
//      连续 AUTH_MAX_FAILS（默认 5）次锁 AUTH_LOCK_MINUTES（默认 5）；
//   4. 认证存储不可用时返回 503，绝不 fail-open —— 放行等于这堵墙白做；
//   5. 会话 cookie 是 HttpOnly + SameSite=Lax，前端 JS 读不到。
//
// 注意：默认不信任 X-Forwarded-For；只有显式 TRUST_PROXY 且来源为本机反代时才读转发头。
// ==========================================

const crypto = require('crypto');
const passwordPolicy = require('./passwordPolicy');
const usernamePolicy = require('./usernamePolicy');

const COOKIE_NAME = 'vs_session';
const SCRYPT_VERSION = 2;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const LEGACY_SCRYPT = { N: 16384, r: 8, p: 1 };
// 「用户不存在」时也跑一次同代价的哈希，抹平时序差异，避免靠响应时间枚举账号。
// 用当前参数生成，避免 N 升级后「不存在账号」比「存在账号」更快。
const DUMMY_SALT = Buffer.alloc(16);
// 失败计数：同一 IP + 同一账号、以及同一 IP 的全局限流各一份。
// 30 分钟无失败自动过期，避免旧记录永久占用内存。
const FAILURE_TTL_MS = 30 * 60 * 1000;
const MAX_FAILURE_ENTRIES = 20000;

const sessions = new Map();   // token -> { userId, username, createdAt, expiresAt }
const failures = new Map();   // key -> { fails, lockedUntil, lastFailure }

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

function scryptParams() {
  const cfg = authConfig();
  let N = Number(cfg.scryptN);
  // 只接受 2^14 ~ 2^18 的 2 的幂；配置写错时回退到 OWASP 基准 2^17。
  if (!Number.isInteger(N) || N < 16384 || N > 262144 || (N & (N - 1)) !== 0) N = 131072;
  return { N, r: SCRYPT_R, p: SCRYPT_P };
}

function scryptMaxmem(params) {
  // Node 默认 maxmem 为 32 MiB；2^17/r=8 需要约 128 MiB。
  return Math.max(64 * 1024 * 1024, 256 * params.N * params.r);
}

function scryptAsync(password, salt, params, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, {
      N: params.N, r: params.r, p: params.p, maxmem: scryptMaxmem(params)
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * 解析哈希串，兼容两代格式：
 *   v1（旧）：scrypt$1$<saltHex>$<hashHex>       参数固定 16384/8/1
 *   v2（新）：scrypt$2$<N>$<r>$<p>$<saltHex>$<hashHex>
 * 参数随哈希一起存，升级 N 不会让旧密码失效。
 */
function parseHash(stored) {
  const raw = String(stored || '');
  const parts = raw.split('$');
  if (parts[0] !== 'scrypt') return null;
  let params;
  let saltHex;
  let hashHex;
  let version;
  if (parts[1] === '1' && parts.length === 4) {
    version = 1;
    params = { ...LEGACY_SCRYPT };
    saltHex = parts[2];
    hashHex = parts[3];
  } else if (parts[1] === '2' && parts.length === 7) {
    version = 2;
    const N = Number(parts[2]);
    const r = Number(parts[3]);
    const p = Number(parts[4]);
    if (!Number.isInteger(N) || N < 16384 || N > 262144 || (N & (N - 1)) !== 0) return null;
    if (!Number.isInteger(r) || r < 1 || r > 32) return null;
    if (!Number.isInteger(p) || p < 1 || p > 16) return null;
    params = { N, r, p };
    saltHex = parts[5];
    hashHex = parts[6];
  } else {
    return null;
  }
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length < 8 || expected.length < 32 || expected.length > 64) return null;
  return { version, params, salt, expected };
}

/** 生成 scrypt 哈希串（v2：参数随哈希存储） */
async function hashPassword(password) {
  const params = scryptParams();
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, params, SCRYPT_KEYLEN);
  return `scrypt$${SCRYPT_VERSION}$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** 校验密码（任何格式异常一律 false，不抛错） */
async function verifyPassword(password, stored) {
  try {
    const parsed = parseHash(stored);
    if (!parsed) return false;
    const key = await scryptAsync(password, parsed.salt, parsed.params, parsed.expected.length);
    return key.length === parsed.expected.length && crypto.timingSafeEqual(key, parsed.expected);
  } catch (e) {
    return false;
  }
}

/** 登录成功后是否需要把旧哈希升级到当前参数（由调用方决定是否写库） */
function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const current = scryptParams();
  return parsed.version !== SCRYPT_VERSION
    || parsed.params.N < current.N
    || parsed.params.r !== current.r
    || parsed.params.p !== current.p
    || parsed.expected.length !== SCRYPT_KEYLEN;
}

/** 恒时校验：用户不存在时也消耗一次同代价 scrypt，防止「用户名枚举」 */
async function verifyPasswordConstant(password, stored) {
  if (!stored) {
    try {
      await scryptAsync(password, DUMMY_SALT, scryptParams(), SCRYPT_KEYLEN);
    } catch (e) { /* 参数异常时仍然返回 false，不泄露内部错误 */ }
    return false;
  }
  return verifyPassword(password, stored);
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
    role: user.role || 'member',
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
  for (const [key, rec] of failures) {
    if (rec.lockedUntil && rec.lockedUntil <= now) {
      // 保留 lockLevel，等 TTL 到期再删；这样连续触发会递增锁定时长。
      rec.lockedUntil = 0;
      failures.set(key, rec);
      continue;
    }
    if (!rec.lockedUntil && rec.lastFailure && now - rec.lastFailure > FAILURE_TTL_MS) {
      failures.delete(key);
    }
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

function failureUserKey(ip, username) {
  const name = String(username || '').trim().toLowerCase() || '(unknown)';
  return `u:${ip}\u0000${name}`;
}

function failureIpKey(ip) {
  return `ip:${ip}`;
}

function failureThresholds() {
  const maxFails = Math.max(1, parseInt(authConfig().maxFails, 10) || 5);
  const lockMinutes = Math.max(1, parseInt(authConfig().lockMinutes, 10) || 5);
  return {
    maxFails,
    // 同一 IP 跨账号的「撒网」上限。比单账号阈值宽，避免共享 NAT 一两下就锁死。
    ipMaxFails: Math.max(maxFails, maxFails * 5),
    lockMs: lockMinutes * 60 * 1000
  };
}

function activeLock(key, now) {
  const rec = failures.get(key);
  if (!rec) return 0;
  if (rec.lockedUntil) {
    if (rec.lockedUntil > now) return rec.lockedUntil;
    // 锁到期后不要删除记录：保留 lockLevel，下一次再触发时按递增时长锁定。
    rec.lockedUntil = 0;
    failures.set(key, rec);
    return 0;
  }
  if (rec.lastFailure && now - rec.lastFailure > FAILURE_TTL_MS) {
    failures.delete(key);
    return 0;
  }
  return 0;
}

/** 检查「IP + 账号」与「IP 全局」两层锁定 */
function checkLock(ip, username) {
  const now = Date.now();
  const until = Math.max(
    activeLock(failureUserKey(ip, username), now),
    activeLock(failureIpKey(ip), now)
  );
  if (!until) return { locked: false };
  return { locked: true, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
}

function bumpFailure(key, threshold, lockMs, now) {
  const rec = failures.get(key) || { fails: 0, lockedUntil: 0, lastFailure: 0, lockLevel: 0 };
  rec.fails += 1;
  rec.lastFailure = now;
  let locked = false;
  if (rec.fails >= threshold) {
    rec.fails = 0;
    // 递增退避（参考 Microsoft Entra smart lockout）：5 → 10 → 15 → 20 分钟封顶。
    const level = Math.min(4, (Number(rec.lockLevel) || 0) + 1);
    rec.lockLevel = level;
    rec.lockedUntil = now + lockMs * level;
    locked = true;
  }
  failures.set(key, rec);
  return { locked, remaining: Math.max(0, threshold - rec.fails) };
}

function pruneFailures() {
  if (failures.size <= MAX_FAILURE_ENTRIES) return;
  const entries = [...failures.entries()]
    .sort((a, b) => (a[1].lastFailure || 0) - (b[1].lastFailure || 0));
  const remove = Math.max(1, entries.length - Math.floor(MAX_FAILURE_ENTRIES * 0.9));
  for (let i = 0; i < remove; i += 1) failures.delete(entries[i][0]);
}

function recordFailure(ip, username) {
  const { maxFails, ipMaxFails, lockMs } = failureThresholds();
  const now = Date.now();
  const user = bumpFailure(failureUserKey(ip, username), maxFails, lockMs, now);
  const global = bumpFailure(failureIpKey(ip), ipMaxFails, lockMs, now);
  pruneFailures();
  return { locked: user.locked || global.locked, remaining: user.remaining };
}

function resetFailures(ip, username) {
  // 只清「这个 IP + 这个账号」；别的账号与全局 IP 计数不动。
  // 旧实现是 failures.delete(ip)，导致任意一个有效账号登录成功就能清空 admin 的失败计数。
  failures.delete(failureUserKey(ip, username));
}

function lockState(ip, username) {
  const now = Date.now();
  const userKey = failureUserKey(ip, username);
  const ipKey = failureIpKey(ip);
  const userRec = failures.get(userKey);
  const ipRec = failures.get(ipKey);
  let fails = 0;
  if (userRec && !userRec.lockedUntil) {
    if (userRec.lastFailure && now - userRec.lastFailure <= FAILURE_TTL_MS) fails = userRec.fails || 0;
    else failures.delete(userKey);
  }
  const lockedUntilRaw = Math.max(
    (userRec && userRec.lockedUntil) || 0,
    (ipRec && ipRec.lockedUntil) || 0
  );
  const lockedUntil = lockedUntilRaw > now ? lockedUntilRaw : 0;
  return { fails, lockedUntil };
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

function randomPassword(len = 15) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*()-_=+';
  const all = upper + lower + digits + symbols;
  const pick = (alphabet) => alphabet[crypto.randomInt(alphabet.length)];
  const n = Math.max(4, Number(len) || 20);
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < n) chars.push(pick(all));
  // Fisher-Yates；保证必选的四类字符不总在开头。
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
}

/**
 * 启动时调用：没有任何账号时创建第一个。
 * 优先用 .env 的 AUTH_USER / AUTH_PASSWORD；缺密码则随机生成并打印一次。
 * AUTH_PASSWORD 不符合策略时直接失败（不降级建弱口令账号）。
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
  const username = usernamePolicy.normalizeUsername(cfg.bootstrapUser) || 'admin';
  const usernameCheck = usernamePolicy.validateUsername(username);
  if (!usernameCheck.ok) {
    throw new Error(
      `[auth] AUTH_USER 不符合账号名规则（${usernamePolicy.describe(usernameCheck)}）。`
      + '账号名需 2–10 位，只能包含中文或英文字母。'
    );
  }
  const minLen = Math.min(
    passwordPolicy.MAX_LENGTH,
    Math.max(8, parseInt(cfg.minPasswordLength, 10) || passwordPolicy.MIN_LENGTH_DEFAULT)
  );
  let password = String(cfg.bootstrapPassword || '');
  let generated = false;

  if (!password) {
    // 随机生成到符合策略为止（用户名相似 / 常见词命中概率极低，但保留重试）。
    for (let i = 0; i < 5; i += 1) {
      const candidate = randomPassword(15);
      if (passwordPolicy.validate(candidate, { username, minLength: minLen }).ok) {
        password = candidate;
        generated = true;
        break;
      }
    }
    if (!generated) throw new Error('[auth] 无法生成符合密码策略的随机口令');
  }

  const check = passwordPolicy.validate(password, { username, minLength: minLen });
  if (!check.ok) {
    throw new Error(
      `[auth] AUTH_PASSWORD 不符合密码策略（${passwordPolicy.describe(check)}，至少 ${minLen} 位）。`
      + '请改成更强口令后重启，或把 AUTH_PASSWORD 留空由系统生成。'
    );
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
  needsRehash,
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
