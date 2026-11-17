// ==========================================
// 后端 i18n 运行时（P2）
// ------------------------------------------------------------
// 契约（docs/spec/i18n-spec.md §3.2 / §3.4）：
//   · 语言来源优先级：cookie `vs_lang`（前端切换时同步写）→ `Accept-Language` → 默认 zh；
//   · 中文是默认与兜底：任何缺 key / 缺英文 / 参数缺失都回退中文或原样返回，**绝不吐 key**；
//   · 只做「加法式」契约：原中文字段/状态码不动，新增可选 code / messageKey / params / message；
//   · 本模块零依赖（不 require auth/config），避免与 server.js / auth 形成加载环。
//
// 用法：
//   const i18n = require('./i18n');
//   req.lang = i18n.langFromRequest(req);                    // 早期中间件
//   res.json({ error: '原文', ...i18n.err(req.lang, 'api.x.y', { n: 3 }) });
//   i18n.t('en', 'qc.item.nsfw.label');                      // p2 单元测试/日志
// ==========================================

'use strict';

const catalog = require('./catalog');

const DEFAULT_LANG = 'zh';
const SUPPORTED = Object.freeze(['zh', 'en']);

// ===== 语言归一化 =====
// 接受 'en' / 'en-US' / 'EN_us' / 'zh-CN' / '中文' 等常见写法；无法识别返回 ''。
function normalizeLang(value) {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim().toLowerCase();
  if (!raw) return '';
  // 语言自称：前端语言下拉可能直接把 label 传下来（中文 / English）
  if (raw === '中文' || raw === '汉语' || raw === 'chinese') return 'zh';
  if (raw === 'english' || raw === '英文') return 'en';
  if (raw === 'zh' || raw.startsWith('zh-') || raw.startsWith('zh_')) return 'zh';
  if (raw === 'en' || raw.startsWith('en-') || raw.startsWith('en_')) return 'en';
  return '';
}

// 从候选列表里取第一个可识别的语言（用于 aiLang → uiLang → 默认）
function resolveLang(...candidates) {
  for (const c of candidates) {
    const lang = normalizeLang(c);
    if (lang) return lang;
  }
  return DEFAULT_LANG;
}

// ===== cookie 解析（不依赖 cookie-parser 依赖）=====
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    try { val = decodeURIComponent(val); } catch (e) { /* 保留原值 */ }
    out[key] = val;
  }
  return out;
}

// Accept-Language: zh-CN,zh;q=0.9,en;q=0.8 → zh（按 q 权重取最高，忽略 q=0）
function langFromAcceptLanguage(header) {
  if (!header || typeof header !== 'string') return '';
  const entries = header.split(',')
    .map((chunk) => {
      const [tag, ...params] = chunk.trim().split(';');
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
        if (m) q = Number(m[1]);
      }
      return { tag: String(tag || '').trim(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((e) => e.tag && e.tag !== '*' && e.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const e of entries) {
    const lang = normalizeLang(e.tag);
    if (lang) return lang;
  }
  return '';
}

// 请求 → 语言。req 可以是 Express req，也可以是 { headers: { cookie } } 形态（WS 握手复用）。
function langFromRequest(req) {
  if (!req) return DEFAULT_LANG;
  const headers = req.headers || {};
  const cookies = req.cookies && typeof req.cookies === 'object'
    ? req.cookies
    : parseCookies(headers.cookie);
  const fromCookie = normalizeLang(cookies && cookies.vs_lang);
  if (fromCookie) return fromCookie;
  const fromHeader = langFromAcceptLanguage(headers['accept-language']);
  if (fromHeader) return fromHeader;
  return DEFAULT_LANG;
}

// 输出语言：显式 aiLang（AI 输出语言，可与界面语言分离）→ 界面语言 → 默认 zh。
// 说明：P3 只做后端接收/透传契约；`vs_config.aiLang` 的设置页字段属于前端作用域，未做。
function outputLang(req, explicit) {
  const body = (req && req.body) || {};
  return resolveLang(
    explicit,
    body.aiLang,
    body.outputLang,
    req && req.lang,
    DEFAULT_LANG
  );
}

// ===== 查表 =====
function isSupported(lang) {
  return SUPPORTED.includes(normalizeLang(lang));
}

function hasKey(lang, key) {
  const l = normalizeLang(lang) || DEFAULT_LANG;
  const table = (catalog[l] && catalog[l][key]);
  return typeof table === 'string' ? true : !!(table && typeof table.zh === 'string');
}

// 统一取原始值：返回英文（回退中文）或 null
function _lookup(lang, key) {
  const l = normalizeLang(lang) || DEFAULT_LANG;
  const primary = catalog[l] && catalog[l][key];
  const zh = catalog.zh && catalog.zh[key];
  const en = catalog.en && catalog.en[key];
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof v[l] === 'string') return v[l];
    return null;
  };
  const first = pick(primary) || pick(l === 'zh' ? zh : en);
  if (first) return first;
  return pick(zh) || pick(en) || null;
}

// 占位符插值：{name} / {count}。缺参数时保留原占位符（便于发现漏传），不抛错。
function interpolate(template, params) {
  if (!params || typeof params !== 'object') return template;
  return String(template).replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    if (v === undefined || v === null) return m;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return String(v);
  });
}

// 翻译：英文缺词条回退中文；中文缺词条回退 key 本身（与前端运行时 `t()` 一致）。
function t(lang, key, params) {
  if (!key) return '';
  const raw = _lookup(lang, key);
  if (raw === null) return String(key);
  return interpolate(raw, params);
}

// 复数码位：优先 `key.one` / `key.other`，再回退 `key`。
function tp(lang, key, n, params) {
  const count = Number(n);
  let category = 'other';
  try {
    const locale = (normalizeLang(lang) || DEFAULT_LANG) === 'en' ? 'en-US' : 'zh-CN';
    category = new Intl.PluralRules(locale).select(Number.isFinite(count) ? count : 0);
  } catch (e) { category = Number(count) === 1 ? 'one' : 'other'; }
  const candidates = [`${key}.${category}`, `${key}.other`, key];
  for (const k of candidates) {
    if (hasKey(lang, k)) return t(lang, k, { ...(params || {}), n: count });
  }
  return t(lang, key, { ...(params || {}), n: count });
}

// ===== API 错误/提示（加法式）=====
// 返回的可选字段：
//   messageKey — 前端优先用它查本地 catalog；
//   params     — 插值参数（不含 Key/密码/路径等敏感值）；
//   message    — 后端按 req.lang 渲染的本地化文本（英文请求时是英文，供 curl/非前端消费者）。
// 注意：调用方必须保留原有中文字段（error / message）与状态码 —— 本函数不覆盖它们。
function err(lang, key, params) {
  const out = { messageKey: key };
  if (params && typeof params === 'object') out.params = params;
  const text = t(lang, key, params);
  if (text && text !== key) out.message = text;
  return out;
}

// 只给 messageKey / params（不覆盖调用方已有的 message）。用于「保留原文 message」的旧契约响应。
function mark(key, params) {
  const out = { messageKey: key };
  if (params && typeof params === 'object') out.params = params;
  return out;
}

// catalog 自检：中英 key 对等 + 占位符一致（供 verify-i18n-backend.js 与 doctor 复用）
function catalogProblems() {
  const problems = [];
  const keys = new Set([...Object.keys(catalog.zh || {}), ...Object.keys(catalog.en || {})]);
  for (const key of keys) {
    const zh = catalog.zh && catalog.zh[key];
    const en = catalog.en && catalog.en[key];
    if (typeof zh !== 'string' || !zh.trim()) problems.push(`缺少中文词条: ${key}`);
    if (typeof en !== 'string' || !en.trim()) problems.push(`缺少英文词条: ${key}`);
    if (typeof zh === 'string' && typeof en === 'string') {
      const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
      if (ph(zh) !== ph(en)) problems.push(`占位符不一致: ${key} (${ph(zh)} vs ${ph(en)})`);
    }
  }
  return problems;
}

// ===== 反查：中文原文 → key =====
// 用途：历史/第三方来源的中文文案（pipeline/qualityChecker/旧任务）在**不改原文**的前提下，
// 于边界处补一个 messageKey，前端即可按 key 本地化。只做精确匹配，不做模糊/机翻。
let _reverseZh = null;
function _reverseIndex() {
  if (_reverseZh) return _reverseZh;
  _reverseZh = new Map();
  for (const [key, value] of Object.entries(catalog.zh || {})) {
    if (typeof value !== 'string') continue;
    // 含占位符的模板不参与精确反查（动态串无法逐字匹配）
    if (/\{\w+\}/.test(value)) continue;
    if (!_reverseZh.has(value)) _reverseZh.set(value, key);
  }
  return _reverseZh;
}

// 精确反查；prefix=true 时允许「模板前缀 + 动态后缀」（例如「拼接失败: xxx」→ pipeline.log.concatFailed）
// prefer：优先返回以该前缀开头的 key（例如「视频拼接」既是步骤名又是状态名时，currentStep 优先状态 key）。
function keyForText(text, options = {}) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return null;
  const map = _reverseIndex();
  if (options.prefer) {
    // 直接遍历 catalog：反向索引对「同值不同 key」只保留第一个，prefer 需要看到全部候选
    for (const [key, value] of Object.entries(catalog.zh || {})) {
      if (value === s && key.startsWith(options.prefer)) return key;
    }
  }
  if (map.has(s)) return map.get(s);
  if (options.prefix) {
    for (const [value, key] of map) {
      if (value.length >= 4 && s.startsWith(value)) return key;
    }
  }
  return null;
}

// 日志渲染：有 key 且英文模式时返回英文；任何缺失/异常都回退到原 text（中文零回归）。
function logText(lang, key, params, fallback) {
  const l = normalizeLang(lang) || DEFAULT_LANG;
  if (!key) return fallback;
  if (l === 'zh') return fallback; // 中文模式：原文本逐字不动（含动态后缀）
  const rendered = t(l, key, params);
  if (!rendered || rendered === key) return fallback;
  return rendered;
}

function keyCount() {
  return Object.keys(catalog.zh || {}).length;
}

// 列出某前缀下的所有 key（验收/文档用）
function keys(prefix) {
  return Object.keys(catalog.zh || {}).filter((k) => !prefix || k.startsWith(prefix)).sort();
}

module.exports = {
  DEFAULT_LANG,
  SUPPORTED,
  normalizeLang,
  resolveLang,
  parseCookies,
  langFromAcceptLanguage,
  langFromRequest,
  outputLang,
  isSupported,
  hasKey,
  t,
  tp,
  err,
  mark,
  interpolate,
  keyForText,
  logText,
  catalogProblems,
  keyCount,
  keys
};
