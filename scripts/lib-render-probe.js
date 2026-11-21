// ============================================================
// 创作页步骤级渲染探针（供 verify-create-page.js 调用；不是独立门禁套件）
// ------------------------------------------------------------
// 为什么需要它：2026-11-21 用户报创作页整块崩「i2vUnsupported is not defined」。
// 该引用写在 `${step === 4 && html`...`}` 里，**只有第 4/5 步渲染时才求值**，
// 静态 grep 和「只渲染第 1 步」都抓不到（本次实测踩到）。这里把浏览器 ESM 改写成
// 普通脚本、在 vm 里用「立即求值的 htm 桩」渲染 1–5 每一步，有未声明变量就抛 ReferenceError。
// 纯内存：不联网、不写文件、不建任务、不产生费用。
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSrc(rel) {
  let src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  src = src.replace(/^\s*import\s+[^;]+;?\s*$/gm, '');              // 依赖由 sandbox 提供
  src = src.replace(/\bexport\s+function\s+([A-Za-z_$][\w$]*)/g, 'function $1');
  src = src.replace(/\bexport\s+default\s+/g, 'module.exports = ');
  return src.replace(/\bexport\s+/g, '');
}

function makeSandbox(lang) {
  const sb = {
    window: {
      React: {
        createElement: (t, p, ...c) => ({ t, p, c }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useEffect: () => {},
        useMemo: (f) => f(),
        useCallback: (f) => f,
        useRef: (v) => ({ current: v })
      },
      // 立即求值：把 ${...} 里的表达式逐个「触碰」，等价于 htm 的真正行为
      htm: { bind: (create) => function tag(strings, ...vals) { vals.forEach((v) => { void v; }); return create('frag', null, vals); } },
      confirm: () => false
    },
    document: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    module: { exports: {} }
  };
  for (const g of ['console', 'Math', 'Date', 'JSON', 'Number', 'String', 'Array', 'Object', 'parseInt', 'parseFloat',
    'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout', 'setInterval', 'Promise', 'Error',
    'Map', 'Set', 'RegExp', 'isNaN', 'URL', 'URLSearchParams']) sb[g] = global[g];
  sb.tr = (k) => 'T:' + k;
  sb.getLocale = () => (lang || 'zh');
  sb.subscribeLocale = () => () => {};
  sb.navigate = () => {};
  sb.readRuntimeConfig = () => ({});
  return sb;
}

// 把组件里 `const [step, setStep] = useState(...)` 的初值强制成指定步骤
function forceStep(code, step) {
  const marker = 'const [step, setStep] = useState(';
  const i = code.indexOf(marker);
  if (i < 0) return code;
  const end = code.indexOf(');', i);
  return code.slice(0, i) + 'const [step, setStep] = useState(' + step + ');' + code.slice(end + 2);
}

/**
 * 渲染一个浏览器页组件的第 1..steps 步（默认 5 步）。
 * @returns {{ok:boolean, results:{step:number, error:string|null}[], error?:string}}
 */
function renderWizardSteps(rel, exportName, opts = {}) {
  const lang = opts.lang || 'zh';
  const steps = opts.steps || [1, 2, 3, 4, 5];
  const base = loadSrc(rel);
  const results = [];
  for (const step of steps) {
    const sb = makeSandbox(lang);
    vm.createContext(sb);
    try {
      vm.runInContext(forceStep(base, step), sb, { filename: rel });
      const fn = sb[exportName] || (sb.module.exports && sb.module.exports[exportName]);
      if (typeof fn !== 'function') return { ok: false, results, error: '组件未导出：' + exportName };
      fn();
      results.push({ step, error: null });
    } catch (e) {
      results.push({ step, error: e.constructor.name + ': ' + e.message });
    }
  }
  return { ok: results.every((r) => !r.error), results };
}

module.exports = { renderWizardSteps, loadSrc };
