// ============================================================
// E1 创作页生成参数接线验收
// ------------------------------------------------------------
// 目标：新版创作页（web/src/screens/create.js）必须
//   1) 从 localStorage.vs_web_config 读设置页保存的 videoModel / resolution / preset
//   2) 确认页（step === 5）显示「档位」，并可在页面上改这三项
//   3) 请求体仍用 generator 名（model: 'dashscope'）+ modelId（'wan3.0-video'），
//      不得把 model 改成 modelId（/api/tasks 会 400）
//
// 全部是静态检查（不联网、不起服务），可进 fast 组。
// 用法：node scripts/verify-create-config.js
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CREATE = path.join(ROOT, 'web', 'src', 'screens', 'create.js');
const CREATE_MSGS = path.join(ROOT, 'web', 'src', 'i18n', 'messages', 'create.js');
const SETTINGS = path.join(ROOT, 'web', 'src', 'screens', 'settingsPage.js');

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}

function section(text, startMark, endMark) {
  const i = text.indexOf(startMark);
  if (i < 0) return '';
  const j = endMark ? text.indexOf(endMark, i + startMark.length) : -1;
  return j < 0 ? text.slice(i) : text.slice(i, j);
}

console.log('================================================================');
console.log('E1 创作页生成参数接线验收');
console.log('================================================================');

if (!fs.existsSync(CREATE)) {
  console.log(`  ❌ 找不到 ${CREATE}`);
  process.exit(1);
}
const src = fs.readFileSync(CREATE, 'utf8');
const createMsgs = fs.readFileSync(CREATE_MSGS, 'utf8');
const settings = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '';

// ---- 0. 契约对齐：设置页存的键名必须还是这三个（防止改设置页把 E1 打回旧样） ----
check(/web\.videoModel/.test(settings), '设置页仍用 vs_web_config.videoModel');
check(/web\.resolution/.test(settings), '设置页仍用 vs_web_config.resolution');
check(/web\.preset/.test(settings), '设置页仍用 vs_web_config.preset');

// ---- 1. 读取 vs_web_config ----
check(/localStorage\.getItem\(\s*'vs_web_config'\s*\)/.test(src), "create.js 读取 localStorage 的 'vs_web_config'");
check(/function\s+readWebConfig\s*\(/.test(src), '存在 readWebConfig() 读取函数');
check(/JSON\.parse[\s\S]{0,200}catch/.test(src), 'readWebConfig 解析失败有兜底（try/catch）');

// ---- 2. 初值来自 web.*，缺省回落到旧默认 ----
check(/model:\s*web\.videoModel\s*\|\|/.test(src), "useState 初值 model ← web.videoModel || 缺省");
check(/resolution:\s*web\.resolution\s*\|\|/.test(src), "useState 初值 resolution ← web.resolution || 缺省");
check(/preset:\s*web\.preset\s*\|\|/.test(src), "useState 初值 preset ← web.preset || 缺省");
check(!/model:\s*'seedance',\s*resolution:\s*'1080p',\s*preset:\s*'final'/.test(src),
  '已不再整行硬编码 seedance/1080p/final');

// ---- 3. 确认页（step === 5）有「生成参数」块，三个控件可改 p ----
const confirm = section(src, 'if (step === 5) {', 'return null;');
check(confirm.length > 0, '找到 step === 5（确认页）代码块');
check(/create\.p5\.genParamsTitle/.test(confirm) && /生成参数/.test(createMsgs), '确认页含「生成参数」区块（i18n 词条）');
check(/set\('model'/.test(confirm), '确认页可改模型（set(\'model\')）');
check(/set\('resolution'/.test(confirm), '确认页可改分辨率（set(\'resolution\')）');
check(/set\('preset'/.test(confirm), '确认页可改档位（set(\'preset\')）');
check(/value="seedance"/.test(confirm) && /value="kling"/.test(confirm) && /value="dashscope"/.test(confirm),
  '模型选项含 seedance / kling / dashscope');
check(/720p/.test(confirm) && /1080p/.test(confirm) && /4K/.test(confirm), '分辨率选项含 720p / 1080p / 4K');
check(/final/.test(confirm) && /daily/.test(confirm) && /quick/.test(confirm) && /clips_only/.test(confirm),
  '档位选项含 final / daily / quick / clips_only');

// ---- 4. 确认清单里补了只读「档位」行 ----
check(/create\.p5\.presetLabel/.test(confirm) && /档位/.test(createMsgs), '确认清单含只读「档位」行（i18n 词条）');
check(/p\.preset/.test(confirm), '确认清单的档位取自 p.preset');
check(/create\.p5\.modelLabel/.test(confirm) && /create\.p5\.resolutionLabel/.test(confirm)
  && /模型/.test(createMsgs) && /分辨率/.test(createMsgs),
  '确认清单原有「模型 / 分辨率」行保留（i18n 词条）');

// ---- 5. 请求体语义不变：model 仍是 generator 名，不是 modelId ----
const submitBody = section(src, 'const body = {', '...rt');
check(/model:\s*p\.model/.test(submitBody), '请求体 model: p.model（generator 名，不是 modelId）');
check(/resolution:\s*p\.resolution/.test(submitBody), '请求体 resolution: p.resolution');
check(/preset:\s*p\.preset/.test(submitBody), '请求体 preset: p.preset');
check(!/model:\s*'wan3\.0-video'/.test(src), "没有把请求体 model 改成 'wan3.0-video'（/api/tasks 会 400）");
check(/'wan3\.0-video'/.test(src), "collectRuntime 仍给 dashscope 带 modelId 'wan3.0-video'");

// ---- 6. 不该动的地方没动 ----
const step2 = section(src, 'if (step === 2) {', 'if (step === 3) {');
check(step2.length > 0 && !/生成参数/.test(step2) && !/set\('model'/.test(step2),
  'step 2（图片审核）未被塞入生成参数控件');
check(/function\s+collectRuntime\s*\(/.test(src) && /vs_config/.test(src),
  "collectRuntime 仍读 vs_config（Key 来源不变）");

console.log('\n================================================================');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log('================================================================');
process.exit(fail === 0 ? 0 : 1);
