// ============================================================
// E4 自定义执行环节 + 质检严格度 验收（前端接线；后端已有 resolveStages/strictItems）
// ------------------------------------------------------------
// 旧版口径（git 历史 public/index.html）：8 个环节可勾选（核心链锁定必选，依赖自动补齐），
// 「质检严格度」勾选质检项；勾选项失败会阻塞任务，NSFW 永远阻塞。
// 后端已支持（无需改动）：
//   - POST /api/tasks 的 preset='custom' + stages[] → src/pipelineStages.resolveStages（核心强制、依赖补齐、未知拒绝）
//   - strictQcItems[] → qualityChecker 的 strictItems（不传=全部要紧；nsfw 永远要紧）
// 本脚本：静态接线 + 离线跑真实 create.js 断言提交体。不建任务、不调模型。
// 用法：node scripts/verify-custom-stages.js
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REAL_FETCH = global.fetch;

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCreate({ preset, uncheckStages = [], uncheckQc = [] }) {
  const htm = require(path.join(ROOT, 'web', 'vendor', 'htm.umd.js'));
  const store = new Map();
  store.set('vs_web_config', '{}');
  store.set('vs_config', '{}');
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  let hookStore = [];
  let hookIdx = 0;
  const captured = { tasks: null };
  const createElement = (type, props, ...children) => {
    const p = props ? { ...props } : {};
    const flat = [];
    const push = (x) => { if (Array.isArray(x)) x.forEach(push); else if (x !== null && x !== undefined && x !== false) flat.push(x); };
    children.forEach(push);
    if (flat.length) p.children = flat.length === 1 ? flat[0] : flat;
    return { type, props: p };
  };
  const effects = [];
  const React = {
    createElement,
    useState(init) {
      const i = hookIdx++;
      if (i >= hookStore.length) hookStore[i] = { v: typeof init === 'function' ? init() : init };
      const set = (u) => {
        const cur = hookStore[i].v;
        const next = typeof u === 'function' ? u(cur) : u;
        if (!Object.is(cur, next)) hookStore[i].v = next;
      };
      return [hookStore[i].v, set];
    },
    useEffect(fn) { effects.push(fn); },
    useMemo(fn) { return fn(); },
    useRef(v) { const i = hookIdx++; if (i >= hookStore.length) hookStore[i] = { v: { current: v } }; return hookStore[i].v; },
    useCallback(fn) { return fn; },
    useLayoutEffect() {}
  };
  global.window = { React, htm };
  global.location = { pathname: '/app/create' };
  global.history = { pushState() {} };
  global.PopStateEvent = class { constructor(t) { this.type = t; } };
  if (!global.window.dispatchEvent) global.window.dispatchEvent = () => {};
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (u.includes('/api/tasks')) { captured.tasks = JSON.parse(opt.body); throw new Error('__ABORT__'); }
    if (u.includes('/api/estimate')) return { ok: true, json: async () => ({ ok: true, estimate: 0, clips: 4, basis: 'free' }) };
    if (u.includes('/api/image-gen/status')) return { ok: true, json: async () => ({ providerImplemented: false, usable: false, imageGen: { provider: 'dashscope', model: 'wan2.7-image', size: '1696x960' } }) };
    if (u.includes('/api/bgm')) return { ok: true, json: async () => ({ tracks: [] }) };
    return { ok: true, json: async () => ({}) };
  };

  const mod = await import('file:///' + path.join(ROOT, 'web', 'src', 'screens', 'create.js').replace(/\\/g, '/') + '?cs=' + Date.now());
  const walk = (node, out = []) => {
    if (!node) return out;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
    if (typeof node !== 'object' || !node.type) return out;
    out.push(node);
    walk(node.props && node.props.children, out);
    return out;
  };
  const textOf = (n) => {
    if (n === null || n === undefined || n === false) return '';
    if (typeof n === 'string' || typeof n === 'number') return String(n);
    if (Array.isArray(n)) return n.map(textOf).join('');
    if (n.props) return textOf(n.props.children);
    return '';
  };
  let tree = null;
  const render = () => { hookIdx = 0; effects.length = 0; tree = mod.CreateWizard({ onChanged() {} }); };
  const nodes = () => walk(tree);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      render();
      const list = effects.slice(); effects.length = 0;
      list.forEach((fn) => { try { fn(); } catch (e) {} });
      await sleep(10);
    }
  };
  const clickText = async (label) => {
    const btn = nodes().find((n) => n.type === 'button' && textOf(n).includes(label));
    if (!btn) throw new Error('找不到按钮：' + label);
    btn.props.onClick();
    await settle();
  };

  await settle();
  const ta = nodes().find((n) => n.type === 'textarea' && String(n.props.placeholder || '').includes('喀斯特'));
  ta.props.onInput({ target: { value: '雪山日出' } });
  await settle();
  for (let i = 0; i < 5; i++) await clickText('下一步');

  // 切到 custom 档（仅当用例要求 custom）
  if (preset === 'custom') {
    const presetSel = nodes().find((n) => n.type === 'select' && textOf(n).includes('custom'));
    if (!presetSel) throw new Error('找不到档位 select（未提供 custom 选项）');
    presetSel.props.onChange({ target: { value: 'custom' } });
    await settle();
  }

  // 取消勾选指定环节（label 文本匹配）
  for (const name of uncheckStages) {
    const label = nodes().find((n) => n.type === 'label' && textOf(n).includes(name));
    if (!label) throw new Error('找不到环节勾选框：' + name);
    const input = walk(label).find((n) => n.type === 'input');
    if (!input) throw new Error('环节行没有 input：' + name);
    input.props.onChange({ target: { checked: false } });
    await settle();
  }
  for (const name of uncheckQc) {
    const label = nodes().find((n) => n.type === 'label' && textOf(n).includes(name));
    if (!label) throw new Error('找不到质检勾选框：' + name);
    const input = walk(label).find((n) => n.type === 'input');
    input.props.onChange({ target: { checked: false } });
    await settle();
  }

  const submitBtn = nodes().find((n) => n.type === 'button' && textOf(n).includes('提交并生成'));
  if (!submitBtn) throw new Error('未到确认页');
  await submitBtn.props.onClick();
  await settle();
  global.fetch = REAL_FETCH;
  return captured.tasks || {};
}

(async () => {
  console.log('================================================================');
  console.log('E4 自定义环节 + 质检严格度 验收');
  console.log('================================================================');

  const createSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'create.js'), 'utf8');

  // ---------- 1. 静态 ----------
  for (const k of ['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation', 'loop_processing', 'audio_mix', 'transcoding', 'final_qc']) {
    check(createSrc.includes(k), `环节键存在：${k}`);
  }
  for (const k of ['blackFrame', 'blur', 'duplicate', 'duration', 'nsfw', 'concat', 'seam', 'colorContinuity', 'loop', 'transcode', 'final']) {
    check(createSrc.includes("'" + k + "'"), `质检项键存在：${k}`);
  }
  check(/custom/.test(createSrc), '档位含 custom');
  check(/stages:/.test(createSrc), '提交体带 stages');
  check(/strictQcItems:/.test(createSrc), '提交体带 strictQcItems');

  // ---------- 2. 离线行为 ----------
  try {
    const a = await runCreate({ preset: 'custom', uncheckStages: ['无缝循环', '配乐混音'], uncheckQc: ['循环质检'] });
    check(Array.isArray(a.stages), 'custom 档发送 stages 数组');
    check(a.stages && !a.stages.includes('loop_processing'), '取消「无缝循环」→ stages 不含 loop_processing', JSON.stringify(a.stages));
    check(a.stages && !a.stages.includes('audio_mix'), '取消「配乐混音」→ stages 不含 audio_mix');
    check(a.stages && ['prompt_optimize', 'storyboard', 'clip_generation'].every((s) => a.stages.includes(s)), '核心链 3 步始终在 stages 里');
    check(a.stages && a.stages.includes('concatenation') && a.stages.includes('transcoding') && a.stages.includes('final_qc'), '未取消的环节仍保留');
    check(Array.isArray(a.strictQcItems) && !a.strictQcItems.includes('loop'), '取消「循环质检」→ strictQcItems 不含 loop', JSON.stringify(a.strictQcItems));
    check(Array.isArray(a.strictQcItems) && a.strictQcItems.includes('nsfw'), 'nsfw 永远在 strictQcItems 里（不可关闭）');
    check(a.preset === 'custom', 'preset=custom 随提交体发送', a.preset);

    const b = await runCreate({ preset: 'final' });
    check(b.stages === undefined || b.stages === null, '非 custom 档不发送 stages（沿用预设）', JSON.stringify(b.stages));
    check(b.preset === 'final', 'preset=final 正常发送');
  } catch (e) {
    global.fetch = REAL_FETCH;
    check(false, '离线 create.js 探针异常: ' + (e && e.message ? e.message : e));
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
