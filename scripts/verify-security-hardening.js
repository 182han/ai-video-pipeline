// ==========================================
// 部署加固验收（2026-11-12，外发部署前）
// ==========================================
//
// 只验证「纯逻辑 + 接线」，不需要起服务、不需要登录、不改任何真实数据。
// 覆盖：
//   [1] 媒体目录是否跟随登录墙（静态接线断言）
//   [2] /api/bgm/mix 的路径穿越是否真的被挡住（弱校验 vs 解析后判断）
//   [3] 路径里的命令行危险字符是否被拒绝（Windows cmd.exe 下 `\"` 不是合法转义）
//   [4] 安全响应头、/healthz、TRUST_PROXY、Secure cookie
//
// 用法：node scripts/verify-security-hardening.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const security = require(path.join(ROOT, 'src', 'utils', 'security.js'));

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

console.log('\n[1] 媒体目录跟随登录墙：接线顺序');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const gateIdx = serverSrc.indexOf('isMediaRequestPath');
const gateStart = serverSrc.indexOf('// ===== 媒体目录跟随登录墙');
const outputMountIdx = serverSrc.indexOf("app.use('/output'");
const clipsMountIdx = serverSrc.indexOf("app.use('/clips'");
const bgmMountIdx = serverSrc.indexOf("app.use('/bgm'");
ok('存在媒体鉴权中间件', gateIdx > 0);
ok('鉴权在 /output 挂载之前', gateIdx > 0 && gateIdx < outputMountIdx, `gate=${gateIdx} mount=${outputMountIdx}`);
ok('鉴权在 /clips 挂载之前', gateIdx > 0 && gateIdx < clipsMountIdx);
ok('鉴权在 /bgm 挂载之前', gateIdx > 0 && gateIdx < bgmMountIdx);
ok('AUTH_ENABLED=false 时放行（验收脚本依赖此行为）',
  gateStart > 0 && /if \(!auth\.isEnabled\(\)\) return next\(\);/.test(serverSrc.slice(gateStart, gateIdx + 400)));

console.log('\n[2] 路径穿越：弱校验已移除，改为解析后判断');
eq('弱校验 startsWith 已不存在', serverSrc.includes("videoPath.startsWith('output')"), false);
ok('改用 security.resolveUnderOutput', /resolveUnderOutput\(__dirname, videoPath\)/.test(serverSrc));

const outRoot = path.join(ROOT, 'output');
const cases = [
  ['output/ok.mp4', true],
  ['output/sub/dir/ok.mp4', true],
  ['output/../server.js', false],
  ['output/../../Windows/win.ini', false],
  ['output/..\\..\\server.js', false],
  ['C:/Windows/win.ini', false],
  ['/etc/passwd', false],
  ['output/a"b.mp4', false],
  ['output/%PATH%.mp4', false],
  ['output/a&b.mp4', false],
  ['output/a|b.mp4', false],
  ['', false],
  [null, false],
  ['output/', false]
];
for (const [input, expectOk] of cases) {
  const abs = security.resolveUnderOutput(ROOT, input);
  const passed = expectOk ? (!!abs && abs.startsWith(outRoot + path.sep)) : abs === null;
  ok(`resolveUnderOutput(${JSON.stringify(input)}) → ${expectOk ? '允许' : '拒绝'}`, passed, `实际=${abs}`);
}

console.log('\n[3] 命令行危险字符：q() 已改为「拒绝」而非「转义」');
const mixerSrc = fs.readFileSync(path.join(ROOT, 'src', 'processors', 'audioMixer.js'), 'utf8');
eq('旧的 \\" 转义写法已全部移除', /replace\(\/"\/g, '\\\\"'\)/.test(mixerSrc), false);
eq('q() 的危险字符判断出现 3 次（三个调用点）',
  (mixerSrc.match(/if \(\/\["%&\|<>\^\\r\\n\]\/\.test\(v\)\)/g) || []).length, 3);

let threwOnQuote = false;
let threwOnPercent = false;
try { security.isSafeShellPath('C:\\a"b.mp4'); } catch (e) { threwOnQuote = true; }
ok('isSafeShellPath 判定含引号路径为不安全', security.isSafeShellPath('C:\\a"b.mp4') === false);
ok('isSafeShellPath 判定含百分号为不安全', security.isSafeShellPath('C:\\a%b.mp4') === false);
ok('isSafeShellPath 正常中文+空格路径为安全', security.isSafeShellPath('C:\\测试 目录\\片段_1_v2.mp4') === true);

console.log('\n[4] 安全响应头 / 健康检查 / 反代与 cookie');
ok('X-Content-Type-Options: nosniff', /res\.setHeader\('X-Content-Type-Options', 'nosniff'\)/.test(serverSrc));
ok('X-Frame-Options: SAMEORIGIN', /res\.setHeader\('X-Frame-Options', 'SAMEORIGIN'\)/.test(serverSrc));
ok('Referrer-Policy', /res\.setHeader\('Referrer-Policy'/.test(serverSrc));
ok('/healthz 路由存在', /app\.get\('\/healthz'/.test(serverSrc));
ok('/healthz 在公开清单内（否则 Docker 探活被登录墙 401）',
  /AUTH_PUBLIC_API = new Set\(\[[^\]]*'\/healthz'[^\]]*\]\)/.test(serverSrc));
ok('/healthz 只回 ok（不暴露 pid/路径）', /res\.json\(\{ ok: true \}\)/.test(serverSrc));

// auth.js：TRUST_PROXY 与 Secure cookie
const authPath = path.join(ROOT, 'src', 'auth.js');
const origXff = '1.2.3.4';
function ipWith(envValue, xff) {
  if (envValue === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = envValue;
  delete require.cache[require.resolve(authPath)];
  const auth = require(authPath);
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  if (xff) req.headers['x-forwarded-for'] = xff;
  return auth.getClientIp(req);
}
delete process.env.TRUST_PROXY;
eq('默认不信任 X-Forwarded-For（防伪造）', ipWith(undefined, origXff), '127.0.0.1');
eq('TRUST_PROXY=1 时取 XFF 第一段', ipWith('1', `${origXff}, 10.0.0.1`), origXff);
delete process.env.TRUST_PROXY;

const authSrc = fs.readFileSync(authPath, 'utf8');
ok('cookie 支持 Secure（COOKIE_SECURE 或反代 https）', /_secureSuffix/.test(authSrc) && /COOKIE_SECURE/.test(authSrc));
ok('cookie 仍保持 HttpOnly + SameSite=Lax', /HttpOnly; SameSite=Lax/.test(authSrc));

console.log('\n[5] 模块可加载（语法与依赖完整性）');
for (const m of ['src/utils/security.js', 'src/auth.js', 'src/processors/audioMixer.js']) {
  let loaded = true; let err = '';
  try { require(path.join(ROOT, m)); } catch (e) { loaded = false; err = e.message; }
  ok(`require(${m})`, loaded, err);
}

console.log(`\n结果: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
