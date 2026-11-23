// ==========================================
// 密码策略（2026-11-23 升级）
// ==========================================
// 设计依据：
//   · NIST SP 800-63B-4（2025-07）：单因子口令至少 15 位；不允许强制字符组成规则；
//     应拒绝常见/已泄露口令；允许 Unicode 与空格；最大长度至少 64。
//   · OWASP Authentication Cheat Sheet：口令长度 + 黑名单 + 不截断；
//     修改口令必须验证当前口令。
//   · Microsoft Entra Password Protection：常见口令归一化 + 变体匹配；
//     Django：CommonPassword / NumericPassword / UserAttributeSimilarity 三类校验器。
//
// 本项目没有 MFA；2026-11-23 用户明确要求：
//   · 密码 8–15 位；
//   · 必须同时包含大写字母、小写字母、数字、符号；
//   · 仍保留常见弱口令/用户名相似/简单模式拦截。
// 注意：这是产品方明确要求，长度不再采用 NIST 单因子 15 位下限。
// 这里不引入任何 npm 依赖，内置一份常见弱口令基线（不是完整泄露库；
// 完整 HIBP 检查需要联网，按项目「零新依赖 + 离线可跑」约束不做）。
// ==========================================

'use strict';

const MIN_LENGTH_DEFAULT = 8;
const MAX_LENGTH = 15;

// 常见弱口令基线。比较前会做小写、去符号、leet 还原，所以这里放基础词即可。
// 覆盖：常见排行、厂商/产品默认口令、键盘序列、项目相关词。
const COMMON_PASSWORDS = new Set([
  'password', 'passw0rd', 'p@ssw0rd', 'passwd', 'pass', 'letmein', 'welcome',
  'admin', 'administrator', 'root', 'toor', 'guest', 'login', 'default',
  'changeme', 'changeit', 'secret', 'private', 'master', 'system', 'manager',
  'qwerty', 'qwertyuiop', 'qwerty123', 'qwe123', '1qaz2wsx', '1q2w3e4r',
  'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'qazwsx', 'zaq12wsx',
  '123456', '1234567', '12345678', '123456789', '1234567890', '123123',
  '123321', '654321', '666666', '888888', '000000', '111111', '112233',
  '121212', '131313', '147258', '159753', 'abc', 'abc123', 'abcd1234', 'a123456',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'master123', 'shadow', 'superman', 'michael', 'jennifer',
  'trustno1', 'starwars', 'whatever', 'freedom', 'computer', 'internet',
  'samsung', 'apple', 'google', 'facebook', 'twitter', 'linkedin',
  'instagram', 'github', 'gitlab', 'docker', 'kubernetes', 'linux',
  'windows', 'ubuntu', 'debian', 'server', 'database', 'mysql', 'postgres',
  'oracle', 'redis', 'mongodb', 'supabase', 'vercel', 'netlify', 'cloudflare',
  'openai', 'claude', 'gemini', 'deepseek', 'videostudio', 'video', 'studio',
  'test', 'test123', 'test1234', 'test12345', 'demo', 'demo123', 'demo1234',
  'demo12345', 'sample123', 'temp1234', 'temporary', 'welcome1', 'welcome123',
  'letmein123', 'admin123', 'admin1234', 'admin@123', 'root1234', 'toor1234',
  'adminadmin', 'password1', 'password12', 'password123', 'password1234',
  'password12345', 'password123456', 'qwerty12', 'qwerty1234'
]);

function normalizeForComparison(value) {
  // 只用于「是否命中黑名单」的比较，不改变实际口令。
  // 去符号 + 小写 + 常见 leet 替换；保留数字，便于检查末尾数字变体。
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[013457@$]/g, (ch) => ({
      '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's'
    }[ch] || ch))
    .replace(/[^a-z0-9]/g, '');
}

function compactLower(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isCommonPassword(password) {
  const raw = compactLower(password);
  const leet = normalizeForComparison(password);
  // 去掉尾部符号/数字后再比对：Password123456 / P@ssw0rd1234567 / qwerty1!
  // 这类「常见词 + 数字/符号尾巴」不应因为尾巴就漏掉。
  const rawText = String(password == null ? '' : password).normalize('NFKC').toLowerCase();
  const trimmed = rawText.replace(/[^a-z0-9]+$/g, '').replace(/\d+$/g, '');
  const candidates = [
    raw,
    leet,
    raw.replace(/\d+$/, ''),
    leet.replace(/\d+$/, ''),
    compactLower(trimmed),
    normalizeForComparison(trimmed)
  ];
  return candidates.some((x) => x && COMMON_PASSWORDS.has(x));
}

function hasSequentialRun(password) {
  const lower = String(password || '').toLowerCase();
  const sequences = [
    '0123456789', '9876543210',
    'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
    'qwertyuiop', 'poiuytrewq',
    'asdfghjkl', 'lkjhgfdsa',
    'zxcvbnm', 'mnbvcxz'
  ];
  for (const seq of sequences) {
    for (let i = 0; i + 4 <= seq.length; i += 1) {
      if (lower.includes(seq.slice(i, i + 4))) return true;
    }
  }
  return false;
}

function isRepeatedPattern(password) {
  const chars = Array.from(String(password || ''));
  if (chars.length < 8) return false;
  for (let period = 1; period <= Math.floor(chars.length / 2); period += 1) {
    if (chars.length % period !== 0) continue;
    const unit = chars.slice(0, period).join('');
    if (unit.repeat(chars.length / period) === chars.join('')) return true;
  }
  return false;
}

/**
 * 用户要求：密码必须同时包含大写 / 小写 / 数字 / 符号。
 * 大写/小写/数字按 ASCII 判断；符号按 Unicode 标点/符号类判断，
 * 空格不算符号（避免“空格充符号”）。
 */
function requiredClasses(password) {
  const s = String(password || '');
  return {
    upper: /[A-Z]/.test(s),
    lower: /[a-z]/.test(s),
    digit: /[0-9]/.test(s),
    symbol: /[\p{P}\p{S}]/u.test(s)
  };
}

function containsUsername(password, username) {
  const user = String(username || '').trim().toLowerCase();
  if (user.length < 3) return false;
  const rawLower = String(password || '').toLowerCase();
  if (rawLower.includes(user)) return true;
  const userCompact = compactLower(user);
  if (!userCompact) return false;
  return compactLower(password).includes(userCompact) || normalizeForComparison(password).includes(userCompact);
}

const REASONS = {
  EMPTY: '为空',
  INVALID: '格式不正确',
  TOO_SHORT: '长度不足',
  TOO_LONG: '长度过长',
  COMMON: '常见弱口令',
  CONTAINS_USERNAME: '包含账号名',
  ALL_NUMERIC: '全为数字',
  TOO_SIMPLE: '重复/连续等简单模式',
  MISSING_CLASSES: '缺少大写/小写/数字/符号'
};

function describe(result) {
  return REASONS[result && result.code] || '不符合密码策略';
}

/**
 * 校验一个新口令。
 * @param {string} password
 * @param {{username?:string, minLength?:number}} options
 * @returns {{ok:true}|{ok:false, code:string, params?:object}}
 */
function validate(password, options = {}) {
  if (typeof password !== 'string') return { ok: false, code: 'INVALID' };
  const requestedMin = Number.isInteger(options.minLength) && options.minLength >= 8
    ? options.minLength
    : MIN_LENGTH_DEFAULT;
  const min = Math.min(MAX_LENGTH, requestedMin);
  if (!password || !password.trim()) return { ok: false, code: 'EMPTY' };

  const chars = Array.from(password);
  if (chars.length < min) return { ok: false, code: 'TOO_SHORT', params: { min } };
  if (chars.length > MAX_LENGTH) return { ok: false, code: 'TOO_LONG', params: { max: MAX_LENGTH } };
  if (isCommonPassword(password)) return { ok: false, code: 'COMMON' };
  if (containsUsername(password, options.username)) return { ok: false, code: 'CONTAINS_USERNAME' };
  if (/^\d+$/.test(password)) return { ok: false, code: 'ALL_NUMERIC' };
  if (new Set(chars).size === 1) return { ok: false, code: 'TOO_SIMPLE' };
  if (isRepeatedPattern(password)) return { ok: false, code: 'TOO_SIMPLE' };
  if (hasSequentialRun(password)) return { ok: false, code: 'TOO_SIMPLE' };
  const classes = requiredClasses(password);
  if (!classes.upper || !classes.lower || !classes.digit || !classes.symbol) {
    return { ok: false, code: 'MISSING_CLASSES' };
  }
  return { ok: true };
}

module.exports = {
  MIN_LENGTH_DEFAULT,
  MAX_LENGTH,
  COMMON_PASSWORDS,
  normalizeForComparison,
  isCommonPassword,
  containsUsername,
  requiredClasses,
  describe,
  validate
};
