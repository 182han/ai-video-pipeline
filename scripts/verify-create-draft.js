// ============================================================
// 创作向导「切页不丢」验收（2026-11-10 用户报告）
// ------------------------------------------------------------
// 事故现象：第②步出完图后，点了页面上的其它按钮（左侧导航 / 模板库 / 设置），
// 回到「创作」整页空白：提示词、参数、刚出的图全没了。
// 根因：向导状态只在组件内（useState），切路由即卸载 → 归零；图文件其实还在 clips/。
//
// 本脚本验证修复（web/src/createDraft.js + screens/create.js）：
//   1) 静态接线：向导读/写草稿、出图任务在模块里、UI 有「已恢复」提示与「清空草稿」；
//   2) 离线跑真实 create.js（htm + 极小 hooks，fetch 打桩，不联网不计费）：
//      · 输入提示词 / 切步骤 → 立刻落 sessionStorage；
//      · 切页（重新挂载）→ 步骤、提示词、已出的图都回来；
//      · F5 级别（模块内存清空，只留存储）→ 仍能恢复；
//      · 生成中切走 → 结果回来仍落到界面；
//      · 出图失败 → 上一张（已付费的）图不被清掉；
//      · 连点两次 → 只发 1 次请求（不重复计费）；
//      · 清空草稿 → 草稿与图一起清干净，且清空后旧请求回来不复活；
//      · 草稿里不含任何 API Key。
//
// 用法：node scripts/verify-create-draft.js
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CREATE = path.join(ROOT, 'web', 'src', 'screens', 'create.js');
const DRAFT = path.join(ROOT, 'web', 'src', 'createDraft.js');
const KEY = 'vs_create_draft_v1';

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStorage(store) {
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

async function runWizard() {
  const htm = require(path.join(ROOT, 'web', 'vendor', 'htm.umd.js'));
  const local = new Map();
  const session = new Map();
  local.set('vs_web_config', '{}');
  local.set('vs_config', JSON.stringify({ imageKey: 'SECRET-KEY-XYZ' }));
  global.localStorage = makeStorage(local);
  global.sessionStorage = makeStorage(session);

  const effectList = [];
  const cleanups = [];
  let hookStore = [];
  let hookIdx = 0;
  const stats = { imageCalls: 0, okCalls: 0, lastBody: null, failNext: false, deferred: null };

  const createElement = (type, props, ...children) => {
    const p = props ? { ...props } : {};
    const flat = [];
    const push = (x) => { if (Array.isArray(x)) x.forEach(push); else if (x !== null && x !== undefined && x !== false) flat.push(x); };
    children.forEach(push);
    if (flat.length) p.children = flat.length === 1 ? flat[0] : flat;
    return { type, props: p };
  };
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
    useEffect(fn) { effectList.push(fn); },
    useMemo(fn) { return fn(); },
    useRef(v) { const i = hookIdx++; if (i >= hookStore.length) hookStore[i] = { v: { current: v } }; return hookStore[i].v; },
    useCallback(fn) { return fn; },
    useLayoutEffect() {}
  };
  global.window = { React, htm };
  global.location = { pathname: '/app/create' };
  global.history = { pushState() {} };
  global.PopStateEvent = class { constructor(t) { this.type = t; } };
  global.window.dispatchEvent = () => {};

  let fetchImpl = async (url, opt) => {
    const u = String(url);
    if (u.includes('/api/images/generate')) {
      stats.imageCalls++;
      try { stats.lastBody = JSON.parse(opt.body); } catch (e) { /* ignore */ }
      if (stats.deferred) {
        return new Promise((resolve) => {
          stats.deferred = () => resolve({
            ok: true,
            json: async () => ({ url: '/clips/ui_img_deferred.png', width: 1696, height: 960, model: 'wan2.7-image', size: '1696x960' })
          });
        });
      }
      if (stats.failNext) {
        return { ok: false, status: 503, json: async () => ({ error: '厂商 503' }) };
      }
      stats.okCalls++;
      const n = stats.okCalls;
      return {
        ok: true,
        json: async () => ({
          url: '/clips/ui_img_' + n + '.png', width: 1696, height: 960,
          model: 'wan2.7-image', provider: 'dashscope', size: '1696x960'
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
  global.fetch = (u, o) => fetchImpl(u, o);

  const mod = await import('file:///' + CREATE.replace(/\\/g, '/') + '?cd=' + Date.now());
  const draftMod = await import('file:///' + DRAFT.replace(/\\/g, '/'));

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
  const render = () => { hookIdx = 0; effectList.length = 0; tree = mod.CreateWizard({ onChanged() {} }); };
  const nodes = () => walk(tree);
  const settle = async (rounds) => {
    const n = rounds || 6;
    for (let i = 0; i < n; i++) {
      // 上一轮的 effect 清理先跑（模拟 React 卸载 / 依赖变化）
      cleanups.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
      render();
      const list = effectList.slice(); effectList.length = 0;
      list.forEach((fn) => { try { const c = fn(); if (typeof c === 'function') cleanups.push(c); } catch (e) { /* ignore */ } });
      await sleep(8);
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
  const remount = async () => { hookStore = []; await settle(); }; // 模拟切走再回来：组件重新挂载
  const draft = () => {
    const raw = session.get(KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };

  await settle();
  return {
    stats, session, local, draft, click, pageText, images, settle, nodes, textOf, remount,
    mod, draftMod, setFetch: (fn) => { fetchImpl = fn; },
    rawDraftJson: () => session.get(KEY) || ''
  };
}

(async () => {
  console.log('================================================================');
  console.log('创作向导：切页 / 刷新不丢（草稿持久化 + 出图任务不随组件卸载）');
  console.log('================================================================');

  const createSrc = fs.readFileSync(CREATE, 'utf8');
  const draftSrc = fs.readFileSync(DRAFT, 'utf8');

  // ---------- 1. 静态接线 ----------
  check(/createDraft\.js/.test(createSrc), 'create.js 引入 createDraft.js（草稿模块）');
  check(/loadDraft/.test(createSrc) && /saveDraft/.test(createSrc), 'create.js 读/写草稿（loadDraft / saveDraft）');
  check(/useState\(\(\)\s*=>\s*loadDraft\(\)\)/.test(createSrc), '向导挂载时用 loadDraft() 恢复；不是每次都从零');
  check(/saveDraft\(\{\s*step,\s*prompt,\s*vprompt,\s*params:\s*p/.test(createSrc), '步骤/提示词/参数变化时落草稿');
  check(/startImage\s*\(/.test(createSrc) && !/fetch\('\/api\/images\/generate'/.test(createSrc),
    '出图请求在草稿模块里（切页不中断、结果不丢）');
  check(!/setImgResult\(null\)/.test(createSrc), '不再「先清空上一张图再请求」（失败会连已付费的图一起丢）');
  check(/已恢复上次未做完的草稿/.test(createSrc), '界面有「已恢复上次未做完的草稿」提示');
  check(/清空草稿/.test(createSrc), '界面有「清空草稿」按钮（可主动从头开始）');
  check(/这张图是按旧提示词出的/.test(createSrc), '提示词改过后会标注「这是旧图」');
  check(/sessionStorage/.test(draftSrc), '草稿走 sessionStorage（同标签页 F5 也在）');
  check(/apiKey/.test(draftSrc) && !/saveDraft\(\{[^}]*apiKey/.test(draftSrc), '出图 Key 只进请求体，不写进草稿');

  // ---------- 2. 离线跑真实 create.js ----------
  try {
    const w = await runWizard();
    await w.settle();

    // 输入提示词 → 立刻落草稿
    const ta = w.nodes().find((n) => n.type === 'textarea' && String(n.props.placeholder || '').includes('喀斯特'));
    check(!!ta, '第①步能找到提示词输入框');
    ta.props.onInput({ target: { value: '雪山日出' } });
    await w.settle();
    check(w.draft() && w.draft().prompt === '雪山日出', '输入提示词后立即写入草稿', JSON.stringify(w.draft() && w.draft().prompt));

    // 切到第②步
    await w.click((t) => t.includes('下一步'), '下一步×1');
    check(w.draft() && w.draft().step === 1, '步骤已落草稿（step=1）', String(w.draft() && w.draft().step));

    // 出 1 张图
    await w.click((t) => t.includes('生成 1 张'), '生成 1 张');
    check(w.stats.imageCalls === 1, '点 1 次只调 1 次出图', String(w.stats.imageCalls));
    check(w.images().includes('/clips/ui_img_1.png'), '界面显示刚出的图');
    check(w.rawDraftJson().includes('/clips/ui_img_1.png'), '图片地址已写入草稿（切页后可恢复）');
    check(w.stats.lastBody && w.stats.lastBody.apiKey === 'SECRET-KEY-XYZ', '请求体仍带上本机 Key');
    check(!w.rawDraftJson().includes('SECRET-KEY-XYZ'), '草稿里没有 Key（只有图片地址与参数）');

    // 切页再回来（组件重新挂载，草稿模块仍在）
    await w.remount();
    check(w.nodes().some((n) => n.type === 'button' && /生成 1 张测试图/.test(w.textOf(n))),
      '切回来仍在第②步（页面是「生成 1 张测试图」而不是回到第①步）');
    check(w.images().includes('/clips/ui_img_1.png'), '切回来刚出的图还在（本次事故的核心）');
    check(/已恢复上次未做完的草稿/.test(w.pageText()), '界面提示「已恢复上次未做完的草稿」');
    await w.click((t) => t.includes('上一步'), '上一步');
    const ta2 = w.nodes().find((n) => n.type === 'textarea');
    check(!!ta2 && ta2.props.value === '雪山日出', '提示词也恢复了', ta2 ? JSON.stringify(ta2.props.value) : '无 textarea');

    // F5 级别：模块内存清空，只剩 sessionStorage
    const fresh = await import('file:///' + DRAFT.replace(/\\/g, '/') + '?fresh=' + Date.now());
    const d2 = fresh.loadDraft();
    check(!!d2 && d2.prompt === '雪山日出', '模块内存清空后仍能从 sessionStorage 恢复提示词');
    check(!!d2 && d2.image && d2.image.url === '/clips/ui_img_1.png', '模块内存清空后仍能恢复刚出的图');
    check(!!d2 && d2.step === 0, '恢复的步骤是当前步骤（刚点了上一步 → 0）', String(d2 && d2.step));

    // 回到第③步（图片审核），失败重试：上一张图必须留着
    await w.click((t) => t.includes('下一步'), '下一步×1（回第②步）');
    await w.click((t) => t.includes('下一步'), '下一步×2（到第③步）');
    w.stats.failNext = true;
    await w.click((t) => t.includes('打回重做'), '打回重做（会失败）');
    check(w.images().includes('/clips/ui_img_1.png'), '出图失败时上一张图没有被清掉（已付费的成果保住）');
    check(/厂商 503/.test(w.pageText()), '失败原因显示在界面上');
    check(w.rawDraftJson().includes('/clips/ui_img_1.png'), '失败后草稿里仍是上一张图');

    // 再试一次成功 → 换新图
    w.stats.failNext = false;
    await w.click((t) => t.includes('打回重做'), '打回重做（成功）');
    check(w.images().includes('/clips/ui_img_2.png'), '重做成功后显示新图');
    check(w.rawDraftJson().includes('/clips/ui_img_2.png'), '草稿里的图也更新为新图');

    // 生成中切走：结果回来仍要落到界面
    w.stats.deferred = () => {};
    await w.click((t) => t.includes('打回重做'), '打回重做（慢请求）');
    await w.remount(); // 请求还没回来就切走
    check(/出图中|生成中/.test(w.pageText()), '切回来能看到「出图中…」而不是空白');
    w.stats.deferred();
    w.stats.deferred = null;
    await w.settle(10);
    check(w.images().includes('/clips/ui_img_deferred.png'), '生成中切走再回来，结果仍然落到界面（不白花钱）');
    check(w.rawDraftJson().includes('/clips/ui_img_deferred.png'), '慢请求结果也写进了草稿');

    // 连点两次 → 只发 1 次（单飞）
    const before = w.stats.imageCalls;
    w.stats.deferred = () => {};
    const p1 = w.draftMod.startImage({ prompt: '雪山日出', size: '1696x960', cfg: {} });
    const p2 = w.draftMod.startImage({ prompt: '雪山日出', size: '1696x960', cfg: {} });
    check(w.stats.imageCalls === before + 1, '出图进行中再点一次 → 不重复发请求（不重复计费）',
      'before=' + before + ' after=' + w.stats.imageCalls);
    w.stats.deferred();
    w.stats.deferred = null;
    await p1; await p2;
    await w.settle();

    // 清空草稿：在途请求回来也不复活
    w.stats.deferred = () => {};
    const p3 = w.draftMod.startImage({ prompt: '雪山日出', size: '1696x960', cfg: {} });
    w.draftMod.clearDraft();
    w.stats.deferred();
    w.stats.deferred = null;
    await p3;
    await w.settle();
    check(!w.draftMod.getImageState().result, '清空草稿后，在途出图结果不会复活到界面');

    // 重新挂载后点「清空草稿」按钮
    await w.remount();
    if (/清空草稿/.test(w.pageText())) {
      await w.click((t) => t.includes('清空草稿'), '清空草稿');
    }
    const cleared = w.draft();
    check(!cleared || (!cleared.prompt && !(cleared.image && cleared.image.url)),
      '点「清空草稿」后提示词与图片都清空', JSON.stringify(cleared && { p: cleared.prompt, img: cleared.image }));
    check(!/已恢复上次未做完的草稿/.test(w.pageText()), '清空后不再显示「已恢复」提示');
  } catch (e) {
    check(false, '离线 create.js 探针异常: ' + (e && e.message ? e.message : e));
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
