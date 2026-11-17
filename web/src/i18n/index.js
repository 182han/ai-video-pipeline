// ============================================================
// i18n 运行时（零依赖、零构建）
// ------------------------------------------------------------
// 职责：
//   · 语言检测：?lang= > localStorage.vs_lang > Cookie.vs_lang > navigator.language > zh
//   · 切换：写 localStorage + cookie（后端/WS 靠 cookie 本地化）、更新 <html lang> 与标题
//   · t(key, params) / tp(key, count, params) / has(key)
//   · Intl 格式化：fmtDateTime / fmtDate / fmtTime / fmtNumber / fmtPct
//   · subscribe(fn)：语言变化时通知（React 顶层用它触发全树重渲染，不 remount）
// 规范见 docs/spec/i18n-spec.md
// ============================================================
import { messages } from './messages/index.js';

const SUPPORTED = ['zh', 'en'];
const DEFAULT_LOCALE = 'zh';
const STORAGE_KEY = 'vs_lang';
const COOKIE_KEY = 'vs_lang';
const TAGS = { zh: 'zh-CN', en: 'en-US' };
const LABELS = { zh: '中文', en: 'English' };

const missingKeys = new Set();
const listeners = new Set();

function hasDom() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readCookie() {
  if (!hasDom()) return '';
  try {
    const parts = String(document.cookie || '').split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const name = part.slice(0, idx).trim();
      if (name === COOKIE_KEY) return decodeURIComponent(part.slice(idx + 1).trim());
    }
  } catch (e) { /* ignore */ }
  return '';
}

export function normalizeLocale(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (s === 'zh' || s.startsWith('zh-') || s.startsWith('zh_')) return 'zh';
  if (s === 'en' || s.startsWith('en-') || s.startsWith('en_')) return 'en';
  return null;
}

function detectLocale() {
  if (hasDom()) {
    try {
      const fromQuery = normalizeLocale(new URLSearchParams(window.location.search).get('lang'));
      if (fromQuery) return fromQuery;
    } catch (e) { /* ignore */ }
    try {
      const fromStore = normalizeLocale(window.localStorage.getItem(STORAGE_KEY));
      if (fromStore) return fromStore;
    } catch (e) { /* ignore */ }
  }
  const fromCookie = normalizeLocale(readCookie());
  if (fromCookie) return fromCookie;
  // 只把「浏览器 window.navigator」当作用户语言来源；Node 测试桩里的全局 navigator
  // （Node 24 自带 en-US）不应影响渲染结果，否则无头验收会被判成英文。
  const nav = hasDom()
    ? (window.navigator || null)
    : (typeof navigator !== 'undefined' ? navigator : null);
  if (nav) {
    const list = (nav.languages && nav.languages.length)
      ? nav.languages
      : [nav.language];
    for (const raw of list) {
      const code = normalizeLocale(raw);
      if (code) return code;
    }
  }
  return DEFAULT_LOCALE;
}

let locale = detectLocale();

function persist(code) {
  if (!hasDom()) return;
  try { window.localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* ignore */ }
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = COOKIE_KEY + '=' + encodeURIComponent(code)
      + '; path=/; max-age=31536000; SameSite=Lax' + secure;
  } catch (e) { /* ignore */ }
}

function resolve(dict, key) {
  let cur = dict;
  for (const part of String(key).split('.')) {
    if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (params[name] === undefined || params[name] === null) return match;
    return String(params[name]);
  });
}

function warnMissing(key) {
  if (missingKeys.has(key)) return;
  missingKeys.add(key);
  console.warn('[i18n] missing key:', key);
}

/** 取文案；缺失时回退中文，再缺失返回 key 本身。 */
export function t(key, params) {
  const current = resolve(messages[locale], key);
  const value = current !== undefined ? current : resolve(messages[DEFAULT_LOCALE], key);
  if (value === undefined) {
    warnMissing(key);
    return key;
  }
  return interpolate(value, params);
}

/** 是否存在该 key（当前语言或兜底语言）。 */
export function has(key) {
  return resolve(messages[locale], key) !== undefined
    || resolve(messages[DEFAULT_LOCALE], key) !== undefined;
}

/** 复数：tp('clip.count', n, { n }) → clip.count_one / clip.count_other。 */
export function tp(key, count, params) {
  let category = 'other';
  try { category = new Intl.PluralRules(TAGS[locale]).select(count); } catch (e) { /* ignore */ }
  const merged = { ...(params || {}), n: count };
  const candidates = [key + '_' + category, key + '_other', key];
  for (const candidate of candidates) {
    const value = resolve(messages[locale], candidate);
    if (value !== undefined) return interpolate(value, merged);
  }
  for (const candidate of candidates) {
    const value = resolve(messages[DEFAULT_LOCALE], candidate);
    if (value !== undefined) return interpolate(value, merged);
  }
  warnMissing(key);
  return key;
}

export function getLocale() {
  return locale;
}

export function getLocaleTag() {
  return TAGS[locale];
}

export function supportedLocales() {
  return SUPPORTED.map((code) => ({ code, label: LABELS[code], htmlLang: TAGS[code] }));
}

function applyDocument() {
  if (!hasDom()) return;
  try { document.documentElement.lang = TAGS[locale]; } catch (e) { /* ignore */ }
  try {
    const title = t('app.title');
    if (title && title !== 'app.title') document.title = title;
  } catch (e) { /* ignore */ }
}

/** 切换语言；非法/相同语言直接返回当前值。 */
export function setLocale(next) {
  const code = normalizeLocale(next);
  if (!code || code === locale) return locale;
  locale = code;
  persist(code);
  applyDocument();
  listeners.forEach((fn) => {
    try { fn(code); } catch (err) { console.error('[i18n] listener failed', err); }
  });
  if (hasDom()) {
    try {
      window.dispatchEvent(new CustomEvent('vs-langchange', { detail: { locale: code } }));
    } catch (e) { /* ignore */ }
  }
  return locale;
}

/** 订阅语言变化；返回取消订阅函数。 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- Intl 格式化 ----------
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' || typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function fmtDateTime(value, options) {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(TAGS[locale], options || {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(d);
}

export function fmtDate(value, options) {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(TAGS[locale], options || {
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

export function fmtTime(value, options) {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(TAGS[locale], options || {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(d);
}

export function fmtNumber(value, options) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(TAGS[locale], options || {}).format(n);
}

export function fmtPct(value, digits) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(TAGS[locale], {
    style: 'percent', minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0
  }).format(n);
}

// 初始化：把检测结果持久化（含 cookie），并同步 <html lang> / 标题。
if (hasDom()) {
  persist(locale);
  applyDocument();
  try {
    window.__VS_I18N__ = { getLocale, setLocale, t, tp, has, supportedLocales };
  } catch (e) { /* ignore */ }
}
