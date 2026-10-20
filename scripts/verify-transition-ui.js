// ==========================================================
// 片段间转场：接线验收（静态）
//
// 为什么需要它：
//   2026-10-19 曾出现「前端传了 preset、后端解构里没有 → 静默忽略」的缺陷，
//   档位功能等于没通。转场同样是一条「前端控件 → 请求体 → 路由 → 任务 → 流水线」
//   的长链路，任何一环漏接都不会报错，只会「勾了没效果」。
//   本脚本逐环断言，避免同类问题复发。
//
// 覆盖：
//   index.html     控件 / collectTransitionConfig / POST body
//   bgm-editor.html 控件 / /api/assemble body
//   server.js      /api/tasks 解构 + createTask 透传 + /api/assemble 透传
//   taskManager.js createLibraryTask 透传
//   pipeline.js    _transitionOptions + 转场模块调用
//   config.js      默认关闭 + 三个环境变量
//   .env.example   三个环境变量都有示例
//
// 用法：node scripts/verify-transition-ui.js
// 说明：这是静态检查；真实 ffmpeg 行为由 verify-transitions.js 覆盖。
// ==========================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function check(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

console.log('='.repeat(60));
console.log('片段间转场：接线验收（静态）');
console.log('='.repeat(60));

// ---------- 生成页 ----------
console.log('\n[1] public/index.html（生成页）');
const idx = read('public/index.html');
check(/id="transitionEnabled"/.test(idx), '存在转场开关 #transitionEnabled');
check(/id="transitionDuration"/.test(idx), '存在淡化时长 #transitionDuration');
check(/id="transitionType"/.test(idx), '存在转场类型 #transitionType');
check(/function collectTransitionConfig\s*\(/.test(idx), '存在 collectTransitionConfig()');
check(/transition:\s*collectTransitionConfig\(\)/.test(idx), 'POST /api/tasks 的 body 已带 transition');

// ---------- 剪辑页 ----------
console.log('\n[2] public/bgm-editor.html（剪辑页）');
const ed = read('public/bgm-editor.html');
check(/id="transitionEnabled"/.test(ed), '存在转场开关 #transitionEnabled');
check(/id="transitionDuration"/.test(ed), '存在淡化时长 #transitionDuration');
check(/body:\s*JSON\.stringify\(\{\s*segments,\s*resolution,\s*transition\s*\}\)/.test(ed), '/api/assemble 请求体已带 transition');

// ---------- 路由 ----------
console.log('\n[3] server.js（两个入口）');
const server = read('server.js');
check(/const \{[^}]*\btransition\b[^}]*\} = req\.body/.test(server), 'POST /api/tasks 解构含 transition');
check(/transition:\s*\(transition && typeof transition === 'object'\)/.test(server), 'createTask options 透传 transition');
check(/createLibraryTask\(\{ segments, resolution: target, transition \}\)/.test(server), '/api/assemble 透传 transition');

// ---------- 任务 / 流水线 ----------
console.log('\n[4] taskManager.js / pipeline.js');
const tm = read('src/taskManager.js');
check(/transition:\s*\(options\.transition && typeof options\.transition === 'object'\)/.test(tm), 'createLibraryTask 透传 transition');
const pl = read('src/pipeline.js');
check(/_transitionOptions\(task\)\s*\{/.test(pl), 'pipeline 有 _transitionOptions()');
check(/require\('\.\/processors\/transitionMixer'\)/.test(pl), 'pipeline 已引入 transitionMixer');
const calls = (pl.match(/transitionMixer\.concatWithTransitions\(/g) || []).length;
check(calls >= 4, '四条拼接路径都接入了转场（实测调用点）', `调用点 ${calls} 个`);

// ---------- 配置 ----------
console.log('\n[5] config.js / .env.example');
const cfg = read('config.js');
check(/TRANSITIONS:\s*\{/.test(cfg), 'config 有 TRANSITIONS 配置块');
check(/TRANSITION_ENABLED',\s*'false'/.test(cfg), '默认关闭（TRANSITION_ENABLED 回退 false）');
check(/TRANSITION_DURATION/.test(cfg) && /TRANSITION_TYPE/.test(cfg), 'duration / type 可配置');
const env = read('.env.example');
check(/TRANSITION_ENABLED=/.test(env) && /TRANSITION_DURATION=/.test(env) && /TRANSITION_TYPE=/.test(env), '.env.example 已列出三个变量');

console.log('\n' + '='.repeat(60));
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail > 0 ? 1 : 0);
