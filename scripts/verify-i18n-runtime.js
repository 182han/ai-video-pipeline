#!/usr/bin/env node
// ============================================================
// i18n 运行时验收（Node + DOM 桩）
// ------------------------------------------------------------
// 为什么要有它：本机没有测试框架，且浏览器验收受环境限制。
// 这里用 DOM 桩加载**真实的** web/src/i18n 运行时，验证：
//   语言检测优先级 / t() / tp() 复数 / 占位符 / 切换持久化(cookie+localStorage)
//   / <html lang> / 标题 / 订阅通知 / Intl 格式化 / 缺 key 回退告警
// 并加载真实组件模块，验证模块图没有语法或顶层副作用错误。
// 注意：它**证明不了**布局与视觉效果，那部分仍需浏览器人工验收。
// ============================================================
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('✓ ' + name);
  } catch (err) {
    failed += 1;
    console.log('✗ ' + name + ' — ' + err.message);
  }
}

(async function main() {
  console.log('=== i18n 运行时验收 ===\n');

  const store = new Map();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  const htmlStub = () => ({});
  const doc = {
    cookie: '',
    documentElement: { lang: '' },
    title: '',
    body: { appendChild() {}, classList: { toggle() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() { return { style: {}, click() {}, remove() {} }; },
    addEventListener() {},
    dispatchEvent() {}
  };

  global.document = doc;
  global.window = {
    location: { search: '?lang=en', protocol: 'http:', href: 'http://localhost/app' },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); }
    },
    dispatchEvent() {},
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    htm: { bind: () => htmlStub },
    React: {
      createElement: () => ({}),
      Component: class Component {},
      useEffect() {},
      useState(value) { return [value, () => {}]; },
      useRef(value) { return { current: value }; },
      useMemo(fn) { return fn(); },
      useCallback(fn) { return fn; }
    },
    ReactDOM: { createRoot: () => ({ render() {} }) }
  };
  Object.defineProperty(global, 'navigator', {
    value: { language: 'en-US', languages: ['en-US'] },
    configurable: true
  });

  const i18n = await import(pathToFileURL(path.join(ROOT, 'web', 'src', 'i18n', 'index.js')).href);

  ok('?lang=en 优先于浏览器语言', () => assert.equal(i18n.getLocale(), 'en'));
  ok('英文导航词条', () => assert.equal(i18n.t('nav.create'), 'Create'));
  ok('英文设置词条', () => assert.equal(i18n.t('settings.title'), 'Settings'));
  ok('英文占位符参数', () => assert.equal(
    i18n.t('settings.members.resetPrompt', { name: 'Ada' }),
    'Set a new password for Ada (at least 8 characters):'
  ));
  ok('英文复数 one', () => assert.equal(i18n.tp('settings.members.count', 1), '1 member'));
  ok('英文复数 other', () => assert.equal(i18n.tp('settings.members.count', 3), '3 members'));
  ok('<html lang> 同步为 en-US', () => assert.equal(doc.documentElement.lang, 'en-US'));
  ok('document.title 同步英文', () => assert.equal(doc.title, 'Video Studio · AI Landscape Films'));
  ok('切换语言写 localStorage', () => assert.equal(store.get('vs_lang'), 'en'));
  ok('切换语言写 cookie（后端本地化入口）', () => assert.match(doc.cookie, /vs_lang=en/));

  let notified = 0;
  const unsubscribe = i18n.subscribe(() => { notified += 1; });
  i18n.setLocale('zh');

  ok('切换到中文', () => assert.equal(i18n.getLocale(), 'zh'));
  ok('中文导航词条', () => assert.equal(i18n.t('nav.create'), '创作'));
  ok('中文设置词条', () => assert.equal(i18n.t('settings.title'), '设置'));
  ok('中文复数', () => assert.equal(i18n.tp('settings.members.count', 2), '2 名'));
  ok('<html lang> 同步为 zh-CN', () => assert.equal(doc.documentElement.lang, 'zh-CN'));
  ok('document.title 同步中文', () => assert.equal(doc.title, 'Video Studio · AI 风景短片'));
  ok('订阅者收到一次语言变化', () => assert.equal(notified, 1));
  unsubscribe();
  i18n.setLocale('en');
  ok('取消订阅后不再收到通知', () => assert.equal(notified, 1));

  ok('缺 key 回退为 key 本身', () => assert.equal(i18n.t('missing.key.for.test'), 'missing.key.for.test'));
  ok('缺 key 会告警', () => assert.ok(warnings.some((line) => line.includes('missing.key.for.test'))));
  ok('DateTime 格式化可用', () => assert.notEqual(i18n.fmtDateTime('2026-01-02T03:04:05Z'), '—'));
  ok('数字格式化按 en-US', () => assert.equal(i18n.fmtNumber(12345.6), '12,345.6'));
  ok('百分比格式化', () => assert.equal(i18n.fmtPct(0.256, 1), '25.6%'));
  ok('非法日期返回占位符', () => assert.equal(i18n.fmtDate('not-a-date'), '—'));

  // 真实组件模块的模块图加载（捕获语法/导入错误）；不做视觉结论。
  const modules = [
    'components/langSwitch.js',
    'screens/settingsPage.js',
    'screens/assistantPage.js',
    'screens/shell.js',
    'app.js'
  ];
  for (const file of modules) {
    try {
      await import(pathToFileURL(path.join(ROOT, 'web', 'src', file)).href);
      ok('模块可加载：' + file, () => {});
    } catch (err) {
      ok('模块可加载：' + file, () => { throw err; });
    }
  }

  console.warn = realWarn;
  console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('运行时验收自身异常：', err);
  process.exit(1);
});
