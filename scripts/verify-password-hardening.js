// ==========================================
// 密码体系纯逻辑验收（2026-11-23）
// 不启动服务、不连数据库、不需要端口；只测策略/哈希/锁定/日志脱敏。
// 用法：node scripts/verify-password-hardening.js
// ==========================================
'use strict';

const crypto = require('crypto');
const path = require('path');
const policy = require(path.join(__dirname, '..', 'src', 'passwordPolicy'));
const usernamePolicy = require(path.join(__dirname, '..', 'src', 'usernamePolicy'));
const auth = require(path.join(__dirname, '..', 'src', 'auth'));
const { redactLogLine } = require(path.join(__dirname, '..', 'src', 'utils', 'logRedact'));

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function codeOf(password, options) {
  const r = policy.validate(password, options);
  return r.ok ? 'OK' : r.code;
}

(async () => {
  console.log('\n[1] 账号名规则：2–10 位，仅中文/英文字母');
  eq('admin → 合法', usernamePolicy.isValidUsername('admin'), true);
  eq('张三 → 合法', usernamePolicy.isValidUsername('张三'), true);
  eq('ZhanSan → 合法', usernamePolicy.isValidUsername('ZhanSan'), true);
  eq(' 张三 → trim 后合法', usernamePolicy.isValidUsername(' 张三 '), true);
  eq('abcdefghij（10 位）→ 合法', usernamePolicy.isValidUsername('abcdefghij'), true);
  eq('a（1 位）→ 拒绝', usernamePolicy.isValidUsername('a'), false);
  eq('abcdefghijk（11 位）→ 拒绝', usernamePolicy.isValidUsername('abcdefghijk'), false);
  eq('user_1 → 含下划线/数字，拒绝', usernamePolicy.isValidUsername('user_1'), false);
  eq('12345 → 拒绝', usernamePolicy.isValidUsername('12345'), false);
  eq('张三123 → 含数字，拒绝', usernamePolicy.isValidUsername('张三123'), false);
  eq('a b → 含空格，拒绝', usernamePolicy.isValidUsername('a b'), false);

  console.log('\n[2] 密码策略：8–15 位/四类字符/黑名单/用户名/简单模式');
  eq('7 位 → TOO_SHORT', codeOf('Aa1!Bb2', { minLength: 8, username: 'alice' }), 'TOO_SHORT');
  eq('16 位 → TOO_LONG', codeOf('Aa1!Bb2@Cc3#Dd4$', { minLength: 8, username: 'alice' }), 'TOO_LONG');
  eq('8 位合规 → OK', codeOf('Aa1!Bb2@', { minLength: 8, username: 'alice' }), 'OK');
  eq('15 位合规 → OK', codeOf('AllClassesAa12!', { minLength: 8, username: 'alice' }), 'OK');
  eq('缺大写 → MISSING_CLASSES', codeOf('lowercase1!', { minLength: 8, username: 'alice' }), 'MISSING_CLASSES');
  eq('缺小写 → MISSING_CLASSES', codeOf('UPPERCASE1!', { minLength: 8, username: 'alice' }), 'MISSING_CLASSES');
  eq('缺数字 → MISSING_CLASSES', codeOf('NoDigitsAa!', { minLength: 8, username: 'alice' }), 'MISSING_CLASSES');
  eq('缺符号 → MISSING_CLASSES', codeOf('NoSymbolsAa1', { minLength: 8, username: 'alice' }), 'MISSING_CLASSES');
  eq('15 位常见口令 → COMMON', codeOf('Password1234567', { minLength: 8, username: 'alice' }), 'COMMON');
  eq('leet 变体 → COMMON', codeOf('P@ssw0rd1234567', { minLength: 8, username: 'alice' }), 'COMMON');
  eq('包含账号名 → CONTAINS_USERNAME', codeOf('zhangsanAa1!', { minLength: 8, username: 'zhangsan' }), 'CONTAINS_USERNAME');
  eq('全数字 → ALL_NUMERIC', codeOf('13579246', { minLength: 8, username: 'alice' }), 'ALL_NUMERIC');
  eq('全同字符 → TOO_SIMPLE', codeOf('aaaaaaaa', { minLength: 8, username: 'alice' }), 'TOO_SIMPLE');
  eq('重复模式 → TOO_SIMPLE', codeOf('Ab1!Ab1!Ab1!', { minLength: 8, username: 'alice' }), 'TOO_SIMPLE');
  eq('连续序列 → TOO_SIMPLE', codeOf('Abcd9!Xy', { minLength: 8, username: 'alice' }), 'TOO_SIMPLE');
  eq('非字符串 → INVALID', codeOf(null, { minLength: 8 }), 'INVALID');
  eq('纯空白 → EMPTY', codeOf('   ', { minLength: 8 }), 'EMPTY');
  eq('isCommonPassword(P@ssw0rd) = true', policy.isCommonPassword('P@ssw0rd'), true);
  eq('isCommonPassword(unique) = false', policy.isCommonPassword('Xk7#mQ2!vN8@pL4'), false);

  console.log('\n[3] scrypt 哈希：新格式/旧格式兼容/参数升级');
  const sample = 'Aa1!Bb2@';
  const hash = await auth.hashPassword(sample);
  ok('新哈希是 scrypt$2$N$r$p$salt$hash', /^scrypt\$2\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(hash), hash.slice(0, 32));
  eq('正确口令校验通过', await auth.verifyPassword(sample, hash), true);
  eq('错误口令校验失败', await auth.verifyPassword('Wrong1!x', hash), false);
  eq('明文不是哈希本身', hash.includes(sample), false);
  eq('当前哈希不需要升级', auth.needsRehash(hash), false);
  eq('畸形哈希不抛错', await auth.verifyPassword('x', 'plaintext'), false);
  eq('缺失账号恒时校验返回 false', await auth.verifyPasswordConstant('x', null), false);

  const legacySalt = crypto.randomBytes(16);
  const legacyKey = await new Promise((resolve, reject) => {
    crypto.scrypt('Legacy1!Pass', legacySalt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k)));
  });
  const legacyHash = `scrypt$1$${legacySalt.toString('hex')}$${legacyKey.toString('hex')}`;
  eq('v1 旧哈希仍可登录', await auth.verifyPassword('Legacy1!Pass', legacyHash), true);
  eq('v1 旧哈希需要升级', auth.needsRehash(legacyHash), true);

  console.log('\n[4] 防爆破：按 IP+账号计数、成功只清自己');
  const ip1 = '203.0.113.71';
  for (let i = 0; i < 4; i += 1) auth.recordFailure(ip1, 'alice');
  eq('4 次失败未锁定', auth.checkLock(ip1, 'alice').locked, false);
  auth.recordFailure(ip1, 'bob');
  auth.resetFailures(ip1, 'alice');
  eq('alice 成功不消除 bob 的失败', auth.lockState(ip1, 'bob').fails >= 1, true);
  eq('alice 自己的计数已清', auth.lockState(ip1, 'alice').fails, 0);

  const ip2 = '203.0.113.72';
  for (let i = 0; i < 5; i += 1) auth.recordFailure(ip2, 'carol');
  eq('5 次失败后锁定', auth.checkLock(ip2, 'carol').locked, true);
  auth.resetFailures(ip2, 'carol');
  eq('成功后该账号解锁', auth.checkLock(ip2, 'carol').locked, false);

  const ip3 = '203.0.113.73';
  for (let i = 0; i < 4; i += 1) auth.recordFailure(ip3, 'dave');
  auth.resetFailures(ip3, 'erin');
  eq('另一个账号登录成功不清 dave', auth.lockState(ip3, 'dave').fails, 4);

  const rp = auth.randomPassword();
  eq('randomPassword 默认 15 位', rp.length, 15);
  const rpClasses = policy.requiredClasses(rp);
  ok('randomPassword 同时含大写/小写/数字/符号',
    rpClasses.upper && rpClasses.lower && rpClasses.digit && rpClasses.symbol,
    JSON.stringify(rpClasses));

  console.log('\n[5] 日志脱敏：生成口令不落盘');
  const redacted = redactLogLine('    密码: Secret123');
  ok('密码行被替换', redacted.includes('密码: ***') && !redacted.includes('Secret123'), redacted);
  const envLine = '    密码: 来自 app/.env 的 AUTH_PASSWORD';
  eq('“来自 .env”提示保持原样', redactLogLine(envLine), envLine);
  ok('AUTH_PASSWORD= 被脱敏', redactLogLine('AUTH_PASSWORD=abc123').includes('AUTH_PASSWORD=***'));
  ok('password= 被脱敏', redactLogLine('password=abc123').includes('password=***'));
  eq('重置密码审计行不变', redactLogLine('[auth] 重置密码: alice (by admin, 127.0.0.1)'), '[auth] 重置密码: alice (by admin, 127.0.0.1)');
  eq('普通日志不变', redactLogLine('[auth] 登录成功: alice (127.0.0.1)'), '[auth] 登录成功: alice (127.0.0.1)');

  console.log('\n' + '='.repeat(60));
  console.log(`结果: ${pass} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('验收异常：', e && e.stack || e);
  process.exit(1);
});
