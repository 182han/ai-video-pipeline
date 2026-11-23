// ==========================================
// 账号名规则（2026-11-23 调整）
// ==========================================
// 规则：2–10 个字符，只能包含「中文（Han）」或「英文字母 A-Z / a-z」。
// 不允许数字、下划线、点、@、横线、空格、其他符号。
// 按 Unicode 码点计数（Array.from），中文与英文都算 1 个字符。
// 已有旧账号不受影响：本规则只约束新建账号与首次引导建号；
// 登录仍按数据库里的原账号名精确匹配，避免历史账号被锁在门外。
// ==========================================

'use strict';

const USERNAME_MIN = 2;
const USERNAME_MAX = 10;
// Script=Han 覆盖汉字；不包含日文假名、数字、标点。
const USERNAME_RE = /^[\p{Script=Han}A-Za-z]+$/u;

function normalizeUsername(value) {
  return String(value == null ? '' : value).trim();
}

function usernameLength(value) {
  return Array.from(String(value == null ? '' : value)).length;
}

/**
 * @param {string} value
 * @returns {{ok:true, username:string}|{ok:false, code:string, params?:object}}
 */
function validateUsername(value) {
  const username = normalizeUsername(value);
  const len = usernameLength(username);
  if (len < USERNAME_MIN) return { ok: false, code: 'TOO_SHORT', params: { min: USERNAME_MIN } };
  if (len > USERNAME_MAX) return { ok: false, code: 'TOO_LONG', params: { max: USERNAME_MAX } };
  if (!USERNAME_RE.test(username)) return { ok: false, code: 'INVALID_CHARS' };
  return { ok: true, username };
}

function isValidUsername(value) {
  return validateUsername(value).ok;
}

const REASONS = {
  TOO_SHORT: `不足 ${USERNAME_MIN} 位`,
  TOO_LONG: `超过 ${USERNAME_MAX} 位`,
  INVALID_CHARS: '只能包含中文或英文字母'
};

function describe(result) {
  return REASONS[result && result.code] || '不符合账号名规则';
}

module.exports = {
  USERNAME_MIN,
  USERNAME_MAX,
  USERNAME_RE,
  normalizeUsername,
  usernameLength,
  validateUsername,
  isValidUsername,
  describe
};
