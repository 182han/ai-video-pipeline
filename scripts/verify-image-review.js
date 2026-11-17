// ============================================================
// 向导「图能看见 + 可打回重做」验收（用户 2026-11-10 明确要求）
// ------------------------------------------------------------
// 用户口径：
//   · 不要后端审核门状态机（不新增 awaiting_review、不做批次/超时/留痕）；
//   · 只要「第②步出完图，第③步要能看到这张图，不满意就打回重做这一张」；
//   · 成本敏感：一次 1 张（最多 2 张），打回也只重做这一张。
// 因此第③步 = 纯前端人工确认：看图 → 通过（进第④步运镜）/ 打回重做（只调 1 次出图）。
//
// 本脚本：静态接线 + 离线跑真实 create.js（htm + 极小 hooks，fetch 打桩计数）。
// 不调真实厂商、不计费。用法：node scripts/verify-image-review.js
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

async function runWizard() {
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
  const stats = { imageCalls: 0, lastImageBody: null };
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
    if (u.includes('/api/images/generate')) {
      stats.imageCalls++;
      try { stats.lastImageBody = JSON.parse(opt.body); } catch (e) {}
      const n = stats.imageCalls;
      return {
        ok: true,
        json: async () => ({
          url: '/output/ui_img_' + n + '.png',
          width: 1696, height: 960, model: 'wan2.7-image',
          provider: 'dashscope', size: '1696x960'
        })
      };
    }
    if (u.includes('/api/image-gen/status')) {
      return {
        ok: true,
        json: async () => ({
          providerImplemented: true, usable: true,
          imageGen: { provider: 'dashscope', model: 'wan2.7-image', size: '1696x960' },
          hint: ''
        })
      };
    }
    if (u.includes('/api/tasks')) throw new Error('__ABORT__');
    if (u.includes('/api/estimate')) return { ok: true, json: async () => ({ ok: true, estimate: 0, clips: 4, basis: 'free' }) };
    if (u.includes('/api/bgm')) return { ok: true, json: async () => ({ tracks: [] }) };
    return { ok: true, json: async () => ({}) };
  };

  const mod = await import('file:///' + path.join(ROOT, 'web', 'src', 'screens', 'create.js').replace(/\\/g, '/') + '?ir=' + Date.now());
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
  const click = async (pred, label) => {
    const btn = nodes().find((n) => n.type === 'button' && pred(textOf(n)));
    if (!btn) throw new Error('找不到按钮：' + label);
    btn.props.onClick();
    await settle();
  };
  const pageText = () => nodes().map(textOf).join('|');
  const images = () => nodes().filter((n) => n.type === 'img').map((n) => n.props.src);

  await settle();
  const ta = nodes().find((n) => n.type === 'textarea' && String(n.props.placeholder || '').includes('喀斯特'));
  if (!ta) throw new Error('找不到提示词 textarea');
  ta.props.onInput({ target: { value: '雪山日出' } });
  await settle();
  return { stats, click, pageText, images, settle, nodes, textOf };
}

(async () => {
  console.log('================================================================');
  console.log('向导：出图 → 第③步看图 → 打回重做（不引入后端审核门）');
  console.log('================================================================');

  const createSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'create.js'), 'utf8');
const createMsgs = fs.readFileSync(path.join(ROOT, 'web', 'src', 'i18n', 'messages', 'create.js'), 'utf8');

  // ---------- 1. 静态 ----------
  check(!/awaiting_review/.test(createSrc), '前端不引入 awaiting_review 状态机');
  check(/create\.p2\.title/.test(createSrc) && /图片审核/.test(createMsgs), '第③步标题是「图片审核」（i18n 词条）');
  check(/create\.p2\.approve/.test(createSrc) && /通过，继续下一步/.test(createMsgs), '第③步有「通过」按钮（i18n 词条）');
  check(/create\.p2\.reject/.test(createSrc) && /打回重做/.test(createMsgs), '第③步有「打回重做」按钮（i18n 词条）');
  check(/imgResult && imgResult\.url/.test(createSrc) || /imgResult\.url/.test(createSrc), '第③步渲染上一张图（imgResult.url）');
  check(!/审核门（后端未实现）/.test(createSrc), '第③步不再显示「后端未实现」占位');

  // ---------- 2. 离线跑真实 create.js ----------
  try {
    const w = await runWizard();

    // 走到第②步（图片生成）
    await w.click((t) => t.includes('下一步'), '下一步×1');
    check(/图片生成/.test(w.pageText()), '第②步是「图片生成」');

    // 生成 1 张
    await w.click((t) => t.includes('生成 1 张'), '生成 1 张');
    check(w.stats.imageCalls === 1, '点了 1 次 → 只调用 1 次出图（成本可控）', String(w.stats.imageCalls));
    check(w.images().includes('/output/ui_img_1.png'), '第②步能看见刚出的图');
    check(w.stats.lastImageBody && w.stats.lastImageBody.prompt === '雪山日出', '出图带上提示词', JSON.stringify(w.stats.lastImageBody && w.stats.lastImageBody.prompt));

    // 进入第③步：必须能看见同一张图
    await w.click((t) => t.includes('下一步'), '下一步×2');
    check(/图片审核/.test(w.pageText()), '进入第③步「图片审核」');
    check(w.images().includes('/output/ui_img_1.png'), '第③步能看到第②步生成的那张图（关键诉求）');
    check(/1696/.test(w.pageText()) && /960/.test(w.pageText()), '第③步显示图片尺寸');

    // 打回重做：只重做这一张（再调 1 次）
    await w.click((t) => t.includes('打回重做') || t.includes('重做这一张') || t.includes('重新生成这一张'), '打回重做');
    check(w.stats.imageCalls === 2, '打回重做 → 只再调 1 次出图（不是整批）', String(w.stats.imageCalls));
    check(w.images().includes('/output/ui_img_2.png'), '重做后第③步显示新图');
    check(!w.images().includes('/output/ui_img_1.png'), '旧图被新图替换（只保留当前这一张）');

    // 通过 → 进入第④步运镜
    await w.click((t) => t.includes('通过'), '通过');
    check(/运镜/.test(w.pageText()), '点「通过」→ 进入第④步「运镜」');
  } catch (e) {
    global.fetch = REAL_FETCH;
    check(false, '离线 create.js 探针异常: ' + (e && e.message ? e.message : e));
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
