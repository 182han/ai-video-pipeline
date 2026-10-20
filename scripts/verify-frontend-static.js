// ==========================================================
// 前端静态一致性校验（浏览器驱动不可用时的替代验证）
//
// 背景：本环境 Electron 未安装，dsh_browser_* 不可用，
// 无法用真机浏览器点一遍。但大部分低级错误可以静态查出来：
//   - JS 里 getElementById('x') 引用了 HTML 不存在的元素
//   - 新增 UI 的 id 拼写不一致
//   - 请求体字段漏传（如 preset 没进 fetch body）
//   - 事件绑定指向不存在的元素
//
// 不覆盖：视觉样式、真实交互手感。那些仍需人工过一遍。
//
// 用法：node scripts/verify-frontend-static.js
// ==========================================================

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

function main() {
  console.log('='.repeat(64));
  console.log('前端静态一致性校验');
  console.log('='.repeat(64));

  if (!fs.existsSync(HTML_PATH)) {
    assert(false, 'index.html 存在', HTML_PATH);
    summary();
    return;
  }
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  // ---------- 1. 结构完整性 ----------
  console.log('\n[1] 结构完整性');
  assert(/<\/html>\s*$/.test(html), '结尾有 </html>');
  const nScriptOpen = (html.match(/<script/g) || []).length;
  const nScriptClose = (html.match(/<\/script>/g) || []).length;
  assert(nScriptOpen === nScriptClose, 'script 标签配对', `${nScriptOpen}/${nScriptClose}`);
  const nStyleOpen = (html.match(/<style/g) || []).length;
  const nStyleClose = (html.match(/<\/style>/g) || []).length;
  assert(nStyleOpen === nStyleClose, 'style 标签配对', `${nStyleOpen}/${nStyleClose}`);
  assert(!/\uFFFD/.test(html), '无 U+FFFD 乱码');

  // ---------- 2. 内联 JS 语法 ----------
  console.log('\n[2] 内联 JS 语法');
  const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert(blocks.length > 0, '存在内联 script 块', `${blocks.length} 块`);
  let syntaxOk = true;
  const syntaxErrors = [];
  blocks.forEach((m, i) => {
    try { new Function(m[1]); } catch (e) { syntaxOk = false; syntaxErrors.push(`块${i + 1}: ${e.message}`); }
  });
  assert(syntaxOk, '所有内联 script 可解析', syntaxOk ? '' : syntaxErrors.join(' | '));

  // ---------- 3. getElementById 目标是否都存在 ----------
  console.log('\n[3] JS 引用的元素 id 是否存在于 HTML');
  const jsCode = blocks.map(m => m[1]).join('\n');
  // HTML 里定义的所有 id
  const definedIds = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) definedIds.add(m[1]);

  // JS 里动态创建的元素（el.id = 'xxx'），静态扫描不到但运行时存在
  const dynamicIds = new Set();
  for (const m of jsCode.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) dynamicIds.add(m[1]);

  // JS 里 getElementById 的字面量引用
  const referenced = new Set();
  for (const m of jsCode.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) referenced.add(m[1]);

  const missing = [...referenced].filter(id => !definedIds.has(id) && !dynamicIds.has(id));
  // 已知的既有缺口（非本次引入）：有元素引用、但 HTML 里没有定义。
  // 这些引用全部带 `if (dot)` 之类的 null 保护，不会抛错，只是对应 UI 不显示。
  const KNOWN_MISSING = ['genStatusDot'];
  const unexpected = missing.filter(id => !KNOWN_MISSING.includes(id));
  assert(unexpected.length === 0,
    '没有引用不存在的元素 id',
    unexpected.length ? `缺失: ${unexpected.join(', ')}` : `${referenced.size} 个引用全部存在或为动态创建`);
  if (KNOWN_MISSING.filter(id => missing.includes(id)).length) {
    console.log(`     ⚠️ 既有缺口（非本次引入）: ${KNOWN_MISSING.filter(id => missing.includes(id)).join(', ')}`
      + ' —— HTML 未定义该元素，对应代码有 null 保护，只是侧边栏状态点不显示');
  }

  // 既有缺口也必须"安全"：所有引用要么有 null 保护、要么变量根本没被使用（死代码），
  // 否则运行时会抛错。注意不能只看下一行——要区分「死变量」和「真无保护」。
  for (const id of KNOWN_MISSING) {
    if (!missing.includes(id)) continue;
    const all = jsCode.split('\n');
    let total = 0;
    let safe = 0;
    const problems = [];
    for (let i = 0; i < all.length; i++) {
      const line = all[i];
      const mm = line.match(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*document\\.getElementById\\(['"]${id}['"]\\)`));
      const directUse = line.includes(`getElementById('${id}')`) || line.includes(`getElementById("${id}")`);
      if (!directUse) continue;
      total++;
      if (!mm) {
        // 不是赋值形式（例如直接链式调用），保守起见看是否在同一行有判断
        if (/if\s*\(/.test(line)) safe++;
        else problems.push(`L${i + 1}: 非赋值形式且无判断`);
        continue;
      }
      const varName = mm[1];
      // 统计该变量在整个 JS 里的出现次数（含声明行）
      const uses = (jsCode.match(new RegExp(`\\b${varName}\\b`, 'g')) || []).length;
      if (uses <= 1) {
        // 只声明未使用 → 死代码，不会报错
        safe++;
        continue;
      }
      // 有使用 → 必须有 null 保护（同一行或下一行）
      const next = all[i + 1] || '';
      const guarded = /if\s*\(\s*!?\s*\w+\s*\)/.test(line) || /if\s*\(\s*!?\s*\w+\s*\)/.test(next)
        || /\w+\s*&&/.test(line) || /!==\s*null|!==\s*undefined/.test(line + next);
      if (guarded) safe++;
      else problems.push(`L${i + 1}: ${varName} 被使用但无 null 保护`);
    }
    assert(problems.length === 0,
      `#${id} 的引用都安全（有保护或是死代码）`,
      problems.length ? problems.join(' | ') : `${safe}/${total} 安全`);
  }

  // ---------- 4. 本次新增的三个 UI 是否就位 ----------
  console.log('\n[4] 本次新增 UI（档位 / 补跑 / 质检角标）');
  const newIds = [
    'presetSelect', 'presetHint', 'customStagesWrap', 'customStagesList',
    'detailPreset', 'detailQcTrust', 'continueSection', 'continueHint', 'continueBtn'
  ];
  for (const id of newIds) {
    assert(definedIds.has(id), `元素 #${id} 存在`);
  }
  // 自定义档位里的 8 个步骤勾选框
  const stageBoxes = [...html.matchAll(/data-stage="([^"]+)"/g)].map(m => m[1]);
  const expectStages = ['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation',
    'loop_processing', 'transcoding', 'audio_mix', 'final_qc'];
  const missingStages = expectStages.filter(s => !stageBoxes.includes(s));
  assert(missingStages.length === 0,
    '自定义档位含全部 8 个步骤勾选框', missingStages.length ? `缺: ${missingStages.join(',')}` : `${stageBoxes.length} 个`);

  // ---------- 5. 请求体字段是否真的传了 ----------
  console.log('\n[5] 请求体字段透传');
  // 定位 POST /api/tasks 的 body
  const createIdx = jsCode.indexOf("fetch('/api/tasks', {");
  assert(createIdx > -1, '找到创建任务的 fetch 调用');
  if (createIdx > -1) {
    // 粗略截取该调用后 2000 字符作为 body 区域
    const bodyArea = jsCode.slice(createIdx, createIdx + 2000);
    assert(/\bpreset,/.test(bodyArea) || /preset:/.test(bodyArea),
      'preset 出现在请求体中（否则前端选了也不生效）');
    assert(/customStages/.test(bodyArea) || /stages:/.test(bodyArea),
      'custom 档位会把 stages 放进请求体');
  }

  // ---------- 6. 补跑按钮真的调 continue API ----------
  console.log('\n[6] 补跑调用');
  assert(/\/continue-plan\?preset=/.test(jsCode), '调用了 continue-plan 预览接口');
  assert(/\/continue`/.test(jsCode) || /\/continue'/.test(jsCode), '调用了 continue 接口');
  assert(/method:\s*'POST'/.test(jsCode), '补跑使用 POST');

  // ---------- 7. 质检角标逻辑 ----------
  console.log('\n[7] 质检角标逻辑');
  assert(/qcTrusted/.test(jsCode), '读取 qcTrusted');
  assert(/qcVersion/.test(jsCode), '读取 qcVersion');
  assert(/qcVersionSource/.test(jsCode), '读取 qcVersionSource');
  assert(/历史未验证/.test(html), '存在「历史未验证」文案');

  // ---------- 8. 档位联动 ----------
  console.log('\n[8] 档位联动');
  assert(/presetSelect.*addEventListener|addEventListener\('change',\s*sync\)/.test(jsCode),
    '档位选择有 change 监听');
  assert(/customStagesWrap/.test(jsCode), 'custom 档会切换勾选区的显示');
  const presetValues = ['quick', 'daily', 'final', 'clips_only', 'custom'];
  const presetOptions = [...html.matchAll(/<option value="(quick|daily|final|clips_only|custom)"/g)].map(m => m[1]);
  const missingPresets = presetValues.filter(p => !presetOptions.includes(p));
  assert(missingPresets.length === 0,
    '五个档位都在下拉里', missingPresets.length ? `缺: ${missingPresets.join(',')}` : '');

  // ---------- 9. 不破坏既有功能 ----------
  console.log('\n[9] 既有功能未被破坏');
  const legacyIds = ['modelSelect', 'promptInput', 'clipCountInput', 'clipDurationInput',
    'resolutionSelect', 'startBtn', 'historyDetailModal', 'detailStatus', 'detailVideo'];
  for (const id of legacyIds) {
    assert(definedIds.has(id), `既有元素 #${id} 仍在`);
  }
  // 关键函数仍在
  for (const fn of ['syncResolutionOptions', 'showTaskDetail', 'switchPage']) {
    assert(new RegExp(`function ${fn}\\b`).test(jsCode), `既有函数 ${fn}() 仍在`);
  }

  summary();
}

function summary() {
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main();
