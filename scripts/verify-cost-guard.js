// ============================================================
// E3 余额 + 生成前费用预估/超额拦截 验收
// ------------------------------------------------------------
// 旧版口径（从 git 历史 public/index.html 取，7db210e~1）：
//   - 设置里填「账户余额（元）」，留空 = 不拦截；
//   - 非 mock 模型在提交前弹「费用预估确认」，显示模型/片段数/单价/预计花费；
//   - 预计花费 > 余额 → 直接拦截，不发请求；
//   - dashscope 按秒计价：720P ¥0.6/s · 1080P ¥1.2/s · 480P ¥0.3/s。
// 新版实现：服务端 `/api/estimate` 用同一份 src/pricing.js 算，
// 前端确认页显示「预计花费」，提交前比对余额并拦截。
//
// 本脚本：静态接线 + 起临时服务实测 /api/estimate（不花钱、不出图）。
// 用法：node scripts/verify-cost-guard.js
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.COST_GUARD_PORT || 3914);

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
  try { return (await fetch(url, { signal: ac.signal })).status; }
  catch (e) { return 0; }
  finally { clearTimeout(timer); }
}
async function waitReady(base, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping(base + '/api/status')) return true;
    await sleep(400);
  }
  return false;
}

(async () => {
  console.log('================================================================');
  console.log('E3 余额 + 费用预估/超额拦截 验收');
  console.log('================================================================');

  const settingsSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'settingsPage.js'), 'utf8');
  const createSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'create.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const settingsMsgs = fs.readFileSync(path.join(ROOT, 'web', 'src', 'i18n', 'messages', 'settings.js'), 'utf8');
  const createMsgs = fs.readFileSync(path.join(ROOT, 'web', 'src', 'i18n', 'messages', 'create.js'), 'utf8');

  // ---------- 1. 静态接线 ----------
  check(/settings\.general\.balance/.test(settingsSrc) && /账户余额/.test(settingsMsgs), '设置页有「账户余额」输入（i18n 词条）');
  check(/balance/.test(settingsSrc), '设置页把余额写进配置（balance）');
  check(/\/api\/estimate/.test(createSrc), '创作页调用 /api/estimate');
  check(/create\.p5\.costLabel/.test(createSrc) && /预计花费/.test(createMsgs), '确认页显示预计花费（i18n 词条）');
  check(/create\.errors\.balanceBlocked/.test(createSrc) && /已拦截/.test(createMsgs), '超额时提示「已拦截」（i18n 词条）');
  check(/parseFloat\([^)]*balance/.test(createSrc) || /balance\)/.test(createSrc), '提交前读取余额做比对');
  check(/est(imate)?\s*>\s*balance|estimatedCost\s*>\s*balance/.test(createSrc), '预估 > 余额 时拦截（不发请求）');
  check(/app\.post\('\/api\/estimate'/.test(serverSrc), '服务端新增 POST /api/estimate');
  check(/pricing\.computeUnitPrice|computeUnitPrice\(/.test(serverSrc), '服务端用 pricing.computeUnitPrice 计费');

  // ---------- 2. 起临时服务实测 ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost_guard_'));
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
      const est = async (body) => {
        const r = await fetch(base + '/api/estimate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };

      const a = await est({ model: 'mock', clipCount: 10, clipDuration: 5, resolution: '1080p' });
      check(a.status === 200 && a.json.estimate === 0 && a.json.basis === 'free', 'mock → 0 元（free）', JSON.stringify(a.json.estimate));

      const b = await est({ model: 'dashscope', resolution: '1080p', clipDuration: 5, clipCount: 10 });
      check(b.json.estimate === 60, 'dashscope 1080p 5s × 10 段 = ¥60', String(b.json.estimate));

      const c = await est({ model: 'dashscope', resolution: '720p', clipDuration: 5, clipCount: 4 });
      check(c.json.estimate === 12, 'dashscope 720p 5s × 4 段 = ¥12', String(c.json.estimate));

      const d = await est({ model: 'siliconflow', clipCount: 3, clipDuration: 5 });
      check(d.json.estimate === 6, 'siliconflow 按个 ¥2 × 3 = ¥6', String(d.json.estimate));

      const e = await est({ model: 'seedance', modelId: 'seedance-2.5', clipCount: 2, clipDuration: 5 });
      check(e.json.estimate === 6, 'seedance-2.5 一口价 ¥3 × 2 = ¥6', String(e.json.estimate));

      const f = await est({ model: 'no-such-model', clipCount: 2 });
      check(f.json.estimate === 0 && f.json.basis === 'unknown', '未知模型 → 0 + basis=unknown');

      const g = await est({ model: 'dashscope', resolution: '1080p', clipDuration: 5, clipCount: 0 });
      check(g.json.clips === 1, 'clipCount 0 → 夹到 1', String(g.json.clips));

      const h = await est({ model: 'dashscope', resolution: '1080p', clipDuration: 5, clipCount: 9999 });
      check(h.json.clips === 500, 'clipCount 9999 → 夹到 500', String(h.json.clips));

      const p1 = await (await fetch(base + '/api/pricing')).json();
      const i = await est({ model: 'dashscope', resolution: '1080p', clipDuration: 5, clipCount: 1 });
      check(i.json.priceVersion === p1.version, '/api/estimate 的 priceVersion 与 /api/pricing 一致', String(i.json.priceVersion));

      // 空体：不 500，返回 0
      const j = await est({});
      check(j.status === 200 && j.json.estimate === 0, '空请求体 → 200 + 0（不崩）');
    }
  } catch (e) {
    check(false, '运行时验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) {} }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  // ---------- 3. 离线跑真实 create.js：验证「拦截 = 不发请求」 ----------
  // 用仓库自带 htm + 一个极小 hooks 运行时加载真实 create.js（与 E1 探针同一手法），
  // fetch 只做桩：/api/estimate 返回固定值，/api/tasks 只记录「是否被调用」。
  try {
    const htm = require(path.join(ROOT, 'web', 'vendor', 'htm.umd.js'));
    let runSeq = 0;
    const runCreate = async ({ balance, estimate }) => {
      const tag = ++runSeq;
      const store = new Map();
      store.set('vs_web_config', JSON.stringify({ balance }));
      store.set('vs_config', '{}');
      global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
      };
      let hookStore = [];
      let hookIdx = 0;
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
      let tasksCalled = false;
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/tasks')) { tasksCalled = true; throw new Error('__ABORT_AFTER_RECORD__'); }
        if (u.includes('/api/estimate')) {
          return { ok: true, json: async () => ({ ok: true, estimate, clips: 2, basis: 'per_second' }) };
        }
        if (u.includes('/api/image-gen/status')) {
          return { ok: true, json: async () => ({ providerImplemented: false, usable: false, imageGen: { provider: 'dashscope', model: 'wan2.7-image', size: '1696x960' }, hint: 'stub' }) };
        }
        if (u.includes('/api/bgm')) {
          return { ok: true, json: async () => ({ tracks: [] }) };
        }
        return { ok: true, json: async () => ({}) };
      };

      const mod = await import('file:///' + path.join(ROOT, 'web', 'src', 'screens', 'create.js').replace(/\\/g, '/') + '?run=' + tag);
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
      const render = () => { hookIdx = 0; effects.length = 0; tree = mod.CreateWizard({ onChanged() {} }); return tree; };
      const nodes = () => walk(tree);
      const runEffects = async () => {
        const list = effects.slice();
        effects.length = 0;
        list.forEach((fn) => { try { fn(); } catch (e) {} });
        await new Promise((r) => setTimeout(r, 10));
      };
      const settle = async () => { for (let i = 0; i < 5; i++) { render(); await runEffects(); } };
      const clickText = async (label) => {
        const btn = nodes().find((n) => n.type === 'button' && textOf(n).includes(label));
        if (!btn || typeof btn.props.onClick !== 'function') throw new Error('找不到按钮：' + label);
        btn.props.onClick();
        await settle();
      };

      await settle();
      const ta = nodes().find((n) => n.type === 'textarea' && String(n.props.placeholder || '').includes('喀斯特'));
      if (!ta) throw new Error('找不到提示词 textarea');
      ta.props.onInput({ target: { value: '雪山日出' } });
      await settle();
      for (let i = 0; i < 5; i++) await clickText('下一步');
      const submitBtn = nodes().find((n) => n.type === 'button' && textOf(n).includes('提交并生成'));
      if (!submitBtn) {
        const labels = nodes().filter((n) => n.type === 'button').map((n) => textOf(n).trim()).join('/');
        throw new Error('未到确认页；按钮=' + labels);
      }
      await submitBtn.props.onClick();
      await settle();
      const errNode = nodes().map(textOf).join('|');
      return { tasksCalled, text: errNode };
    };

    const blocked = await runCreate({ balance: '1', estimate: 3 });
    check(blocked.tasksCalled === false, '余额 ¥1 < 预计 ¥3 → 拦截且**没有**发 /api/tasks');
    check(/已拦截/.test(blocked.text), '界面给出「已拦截」提示');

    const allowed = await runCreate({ balance: '', estimate: 3 });
    check(allowed.tasksCalled === true, '余额留空 → 不拦截，照常提交（/api/tasks 被调用）');

    const enough = await runCreate({ balance: '100', estimate: 3 });
    check(enough.tasksCalled === true, '余额 ¥100 > 预计 ¥3 → 放行');
  } catch (e) {
    check(false, '离线 create.js 探针异常: ' + (e && e.message ? e.message : e));
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
