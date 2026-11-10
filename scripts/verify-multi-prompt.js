// ============================================================
// E2 多提示词批量（每行一个场景 = 每段一个片段）验收
// ------------------------------------------------------------
// 旧版口径（git 历史 public/index.html）：多行模式下「每行一个场景提示词，
// 行数即片段数（覆盖段数设置）」，行尾可加【主题】标签。
// 服务端已支持 `prompts` 数组（server.js:1469-1521，字符串行自动解析【主题】）。
// 新版要补的是前端：解析多行 → 提交 prompts → 用行数覆盖片段数/预估/成片时长。
//
// 本脚本：静态接线 + 离线跑真实 create.js（htm + 极小 hooks，fetch 打桩）+ 服务端负向解析。
// 不建任务、不调真实模型。用法：node scripts/verify-multi-prompt.js
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.MULTI_PROMPT_PORT || 3915);

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ping(url, ms = 800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return (await fetch(url, { signal: ac.signal })).status; } catch (e) { return 0; } finally { clearTimeout(timer); }
}
async function waitReady(base, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await ping(base + '/api/status')) return true; await sleep(400); }
  return false;
}

// 离线跑真实 create.js（fetch 打桩记录 body）
const REAL_FETCH = global.fetch;
async function runCreate(promptText) {
  const htm = require(path.join(ROOT, 'web', 'vendor', 'htm.umd.js'));
  const store = new Map();
  store.set('vs_web_config', JSON.stringify({}));
  store.set('vs_config', '{}');
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  let hookStore = [];
  let hookIdx = 0;
  const captured = { tasks: null, estimate: null };
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
    if (u.includes('/api/tasks')) {
      captured.tasks = JSON.parse(opt.body);
      throw new Error('__ABORT_AFTER_RECORD__');
    }
    if (u.includes('/api/estimate')) {
      captured.estimate = JSON.parse(opt.body);
      return { ok: true, json: async () => ({ ok: true, estimate: 0, clips: 1, basis: 'free' }) };
    }
    if (u.includes('/api/image-gen/status')) {
      return { ok: true, json: async () => ({ providerImplemented: false, usable: false, imageGen: { provider: 'dashscope', model: 'wan2.7-image', size: '1696x960' }, hint: 'stub' }) };
    }
    if (u.includes('/api/bgm')) return { ok: true, json: async () => ({ tracks: [] }) };
    return { ok: true, json: async () => ({}) };
  };

  const mod = await import('file:///' + path.join(ROOT, 'web', 'src', 'screens', 'create.js').replace(/\\/g, '/') + '?mp=' + Date.now());
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
  ta.props.onInput({ target: { value: promptText } });
  await settle();
  for (let i = 0; i < 5; i++) await clickText('下一步');
  const confirmText = nodes().map(textOf).join('|');
  const submitBtn = nodes().find((n) => n.type === 'button' && textOf(n).includes('提交并生成'));
  if (!submitBtn) throw new Error('未到确认页');
  await submitBtn.props.onClick();
  await settle();
  global.fetch = REAL_FETCH; // 恢复真实 fetch，否则后面的临时服务 ping 会用到桩
  return { captured, confirmText };
}

(async () => {
  console.log('================================================================');
  console.log('E2 多提示词批量 验收');
  console.log('================================================================');

  const createSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'create.js'), 'utf8');

  // ---------- 1. 静态接线 ----------
  check(/split\(\/\\r\?\\n\//.test(createSrc), 'create.js 按换行拆行');
  check(/prompts:/.test(createSrc), '提交体带 prompts 数组');
  check(/isMulti|multiPrompt|行数/.test(createSrc), '有「多行模式」判断');
  check(/覆盖|行数即片段数/.test(createSrc), '界面提示「行数覆盖片段数」');

  // ---------- 2. 离线跑真实 create.js ----------
  try {
    const multi = await runCreate('雪山日出\n沙漠星空\n极光森林');
    const b = multi.captured.tasks || {};
    check(Array.isArray(b.prompts) && b.prompts.length === 3, '三行提示词 → prompts 长度 3', JSON.stringify(b.prompts && b.prompts.length));
    check(b.clipCount === 3, '三行 → clipCount 3（行数覆盖段数）', String(b.clipCount));
    check(!b.prompt, '多行模式下不发送单条 prompt', String(b.prompt));
    check(multi.captured.estimate && multi.captured.estimate.clipCount === 3, '预估也按 3 段算', JSON.stringify(multi.captured.estimate && multi.captured.estimate.clipCount));
    check(/3 个场景|3 段/.test(multi.confirmText), '确认页显示「3 个场景/段」');

    const single = await runCreate('只有一行');
    const s = single.captured.tasks || {};
    check(!Array.isArray(s.prompts) || s.prompts.length <= 1, '单行不进入多提示词模式（不带 prompts 数组）', JSON.stringify(s.prompts));
    check(typeof s.prompt === 'string' && s.prompt.includes('只有一行'), '单行仍用 prompt 字段');
    check(s.clipCount === 4, '单行沿用段数设置（默认 4）', String(s.clipCount));

    const blank = await runCreate('第一行\n\n   \n第二行');
    const bl = blank.captured.tasks || {};
    check(Array.isArray(bl.prompts) && bl.prompts.length === 2, '空行被忽略（2 个有效场景）', JSON.stringify(bl.prompts && bl.prompts.length));
  } catch (e) {
    global.fetch = REAL_FETCH;
    check(false, '离线 create.js 探针异常: ' + (e && e.message ? e.message : e));
  }

  // ---------- 3. 服务端解析（只走负向，不建任务） ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi_prompt_'));
  let child = null;
  let base = null;
  try {
    for (let i = 0; i < 6 && !child; i++) {
      const port = START_PORT + i;
      const candidate = `http://${HOST}:${port}`;
      if (await ping(candidate + '/api/status')) continue;
      const c = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
          ...process.env, PORT: String(port), AUTH_ENABLED: 'false', DATABASE_TYPE: 'json',
          DATA_DIR: path.join(tmp, 'tasks'), OUTPUT_DIR: path.join(tmp, 'output'),
          PROJECTS_DIR: path.join(tmp, 'projects'), THUMBS_DIR: path.join(tmp, 'thumbs')
        },
        stdio: 'ignore', windowsHide: true
      });
      c.on('error', () => {});
      if (await waitReady(candidate)) { child = c; base = candidate; }
      else { try { c.kill(); } catch (e) {} }
    }
    check(!!child, '临时服务启动');
    if (child) {
      const post = async (body) => {
        const r = await fetch(base + '/api/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };
      const a = await post({ prompts: [], model: 'mock' });
      check(a.status === 400 && /请输入提示词/.test(a.json.error || ''), 'prompts 全空 → 400 请输入提示词', a.json.error);

      const b = await post({ prompts: Array.from({ length: 201 }, (_, i) => 'scene ' + i), model: 'mock' });
      check(b.status === 400 && /1-200/.test(b.json.error || '') && /201 行/.test(b.json.error || ''), '201 行 → 400 片段数量（含行数提示）', b.json.error);

      const c = await post({ prompts: ['a', 'b'], model: 'no-such-model' });
      check(c.status === 400 && /不支持的模型/.test(c.json.error || ''), '2 行 + 未知模型 → 400（证明 prompts 已被解析并通过校验）', c.json.error);
    }
  } catch (e) {
    check(false, '服务端验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) {} }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
