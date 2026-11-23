// ============================================================
// 主题（日间 / 夜间）
// ------------------------------------------------------------
// 约定：
//   · 只改 <html data-theme="light">，夜间是默认态（不写属性）
//   · 颜色全部走 web/styles 的 CSS 变量，切换即时生效、不刷新、不重启
//   · 选择存 localStorage.vs_theme（与 vs_config / vs_lang 分开）
//   · 首屏防闪白由 web/index.html 里的内联脚本在样式生效前先设属性
//   · 剪辑台是全屏工作台、没有左栏，所以在里面不提供切换入口（进入前切）
// ============================================================

const KEY = 'vs_theme';
const root = typeof document !== 'undefined' ? document.documentElement : null;
const listeners = new Set();
let current = null;

function normalize(value) {
  return value === 'light' ? 'light' : 'dark';
}

function apply(theme) {
  current = theme;
  if (!root || typeof root.setAttribute !== 'function') return theme;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  return theme;
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* 隐私模式 */ }
  // 内联脚本可能已经设过属性；localStorage 的显式选择优先。
  const fromAttr = root && typeof root.getAttribute === 'function'
    ? root.getAttribute('data-theme')
    : null;
  return apply(normalize(saved || fromAttr || 'dark'));
}

export function getTheme() {
  if (current === null) initTheme();
  return current;
}

export function setTheme(theme) {
  const next = normalize(theme);
  apply(next);
  try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
  listeners.forEach((fn) => { try { fn(next); } catch (e) { /* ignore */ } });
  return next;
}

export function toggleTheme() {
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 同一浏览器的其他标签页切换后跟随（不重载页面）
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== KEY) return;
      setTheme(ev.newValue === 'light' ? 'light' : 'dark');
    });
  } catch (e) { /* ignore */ }
}
