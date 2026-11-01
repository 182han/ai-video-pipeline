// 用真实 htm + 最小 React 桩，把各视图组件真的执行一遍，抓运行时崩溃。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const APP = 'C:/Users/14872/Desktop/测试/app';
const ROOT = path.join(APP, 'web/src');
const require2 = createRequire(import.meta.url);
const htm = require2(path.join(APP, 'web/vendor/htm.umd.js'));

const noop = () => {};
class FakeComponent {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState() {}
  render() { return null; }
}
const fakeReact = {
  version: '18.3.1',
  Fragment: Symbol.for('Fragment'),
  Component: FakeComponent,
  PureComponent: FakeComponent,
  createRef: () => ({ current: null }),
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  useEffect: noop,
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useLayoutEffect: noop
};

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  let code = fs.readFileSync(file, 'utf8');
  const exportsObj = {};
  cache.set(file, exportsObj);

  code = code.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,
    (m, names, spec) => `const {${names}} = __req('${spec}');`);
  code = code.replace(/import\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"];?/g,
    (m, name, spec) => `const ${name} = __req('${spec}');`);

  const names = [];
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    m[1].split(',').forEach((x) => names.push(x.trim().split(/\s+as\s+/).pop()));
  }
  code = code.replace(/^export\s*\{[^}]*\};?/gm, '');
  code = code.replace(/^export\s+/gm, '');

  const footer = names.filter(Boolean).map((n) => `try{exports.${n}=${n}}catch(e){}`).join('\n');
  const sandbox = {
    __req: (spec) => load(spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : spec),
    exports: exportsObj,
    window: { React: fakeReact, htm, location: { pathname: '/app' }, addEventListener: noop, removeEventListener: noop, scrollTo: noop, innerWidth: 1440, innerHeight: 900 },
    document: {
      getElementById: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop }),
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, click: noop, remove: noop, appendChild: noop }),
      addEventListener: noop, body: { appendChild: noop }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { pathname: '/app', search: '' },
    history: { pushState: noop },
    PopStateEvent: function () {},
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
    URLSearchParams: URLSearchParams, encodeURIComponent, decodeURIComponent,
    Date, Math, JSON, Number, String, Array, Object, Set, Map, Promise, RegExp, Error,
    React: fakeReact, htm
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n' + footer, sandbox, { filename: file });
  cache.set(file, exportsObj);
  return exportsObj;
}

const errors = [];
const seen = new Set();
let rendered = 0;
let textBuf = '';
const classBag = new Set();

function walk(node, depth, trail) {
  if (node == null || depth > 26) return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1, trail)); return; }
  if (typeof node === 'string' || typeof node === 'number') { textBuf += ' ' + String(node); return; }
  if (typeof node !== 'object') return;
  const { type, props, children } = node;
  if (props && typeof props.className === 'string') { props.className.split(/\s+/).forEach((c) => { if (c && c.indexOf('$') < 0) classBag.add(c); }); }
  if (typeof type === 'function') {
    const name = type.name || 'Anonymous';
    try {
      const out = type({ ...props, children });
      rendered++;
      walk(out, depth + 1, trail.concat(name));
    } catch (e) {
      const tk = trail.concat(name).join(' > ');
      if (!seen.has(tk)) { seen.add(tk); errors.push(tk + '  ->  ' + e.name + ': ' + e.message); }
    }
    return;
  }
  walk(children, depth + 1, trail);
}

const EXPECT = {
  '/': ['创作', '库存', '历史记录', '提示词', '下一步'],
  '/clips': ['视频片段'],
  '/photos': ['照片', '出图'],
  '/music': ['配乐'],
  '/history': ['历史记录', '垃圾箱'],
  '/templates': ['模板库', '提示词优化规则'],
  '/gen': ['没有进行中的任务', '去创作'],
  '/settings': ['API Key', '成员管理', '备份'],
  '/edit': ['剪辑'],
  '/output': ['产出']
};

for (const r of ['/', '/clips', '/photos', '/music', '/history', '/templates', '/gen', '/settings', '/edit', '/output']) {
  textBuf = '';
  try {
    const shell = load(path.join(ROOT, 'screens/shell.js'));
    if (typeof shell.AppShell !== 'function') { errors.push(r + ' -> AppShell 未导出'); continue; }
    walk(shell.AppShell({ route: r }), 0, ['AppShell(' + r + ')']);
    const missing = (EXPECT[r] || []).filter((w) => textBuf.indexOf(w) < 0);
    if (missing.length) errors.push(r + ' -> 渲染文本缺少: ' + missing.join('、'));
  } catch (e) {
    errors.push(r + ' -> 加载失败 ' + e.name + ': ' + e.message);
  }
}

console.log('已执行组件次数: ' + rendered);
if (!errors.length) console.log('全部路由：组件执行通过 + 关键文案渲染正确');
else { console.log('发现 ' + errors.length + ' 处问题：'); errors.forEach((e) => console.log('  - ' + e)); }
