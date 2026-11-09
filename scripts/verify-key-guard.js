// ============================================================
// Key 粘贴污染与「测试连接」可诊断性验收
// ------------------------------------------------------------
// 事故（2026-11-09）：把页面上的提示文案「✗ Invalid API-key…」整行粘进
// 「设置 → 图片生成 → API Key」后，Node fetch 在构造 Authorization 头时抛
//   Cannot convert argument to a ByteString because the character at index 7
//   has a value of 10007 …
// 服务端又把它包成「网络错误」，用户无从判断。本脚本锁住三条防线：
//   1) /api/test-api-key 前置校验 Key/地址里的非 ASCII 字符，返回人话错误；
//   2) imagegen 的 401 响应回显「实际请求地址 + 来源」，能区分“地址留空回落通用入口”；
//   3) 设置页的显示/隐藏按钮不依赖 emoji 与缺失的 Tailwind 类（内联样式 + 文字）。
//
// 纯静态，不联网、不起服务。用法：node scripts/verify-key-guard.js
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const SETTINGS = path.join(ROOT, 'web', 'src', 'screens', 'settingsPage.js');

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}

console.log('================================================================');
console.log('Key 粘贴污染 / 测试连接可诊断性验收');
console.log('================================================================');

const server = fs.readFileSync(SERVER, 'utf8');
const settings = fs.readFileSync(SETTINGS, 'utf8');

// ---- 1. 后端：非 ASCII 前置校验（必须在 fetch 之前）----
const guardIdx = server.indexOf('const nonAscii = ');
const testApiIdx = server.indexOf("app.post('/api/test-api-key'");
const firstFetchAfterTest = server.indexOf('await fetch(', testApiIdx);
check(testApiIdx > 0, "找到 /api/test-api-key 路由");
check(guardIdx > testApiIdx && guardIdx < firstFetchAfterTest,
  '非 ASCII 校验位于路由内、第一次 fetch 之前');
check(/\[\^\\x20-\\x7E\]/.test(server), '校验用 /[^\\x20-\\x7E]/ 判定非 ASCII');
check(/里含非 ASCII 字符/.test(server) && /'API Key'/.test(server), '错误文案点名「API Key 里含非 ASCII 字符」');
check(/nonAscii: true/.test(server), '响应带 nonAscii 标记（前端可据此提示）');
check(/U\+/.test(server), '错误里给出码点（便于对照 undici 的 index/数值）');

// ---- 2. 后端：imagegen 401 回显实际地址与来源 ----
check(/dsBaseUrlUsed/.test(server) && /baseUrlSource/.test(server), '记录实际 baseUrl 与来源');
check(/urlUsed: dsBaseUrlUsed/.test(server), '401 响应带 urlUsed');
check(/baseUrlSource\b[\s\S]{0,30}\}/.test(server), '401 响应带 baseUrlSource');
check(/default（旧通用入口/.test(server), '能标出「回落到旧通用入口」这一情形');
check(/request（页面 Base URL）/.test(server), '能标出「用的是页面填的地址」');

// ---- 3. 前端：显示/隐藏按钮不依赖 emoji 与缺失的 Tailwind 类 ----
check(/显示/.test(settings) && /隐藏/.test(settings), '按钮文案含「显示 / 隐藏」文字');
check(!/👁|🙈/.test(settings), '不再依赖 👁/🙈 emoji（字体缺失时会塌成看不见）');
check(/position: 'absolute'/.test(settings), '按钮用内联 position:absolute（不依赖缺失的 .right-1/.top-1\/2）');
check(/translateY\(-50%\)/.test(settings), '按钮用内联 translateY 垂直居中');
check(/paddingRight/.test(settings), '输入框用内联 paddingRight 给按钮留位（不依赖缺失的 .pr-9）');
check(/含中文\/符号|非 ASCII/.test(settings), '输入时即时提示「Key 里含中文/符号」');
check(/vs_config/.test(settings) || /KEY_STORE/.test(settings), 'Key 仍写 localStorage（不改存储键）');

console.log('\n================================================================');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log('================================================================');
process.exit(fail === 0 ? 0 : 1);
