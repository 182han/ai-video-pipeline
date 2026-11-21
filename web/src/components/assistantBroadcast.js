// ============================================================
// 小智 2.0 V2 · 任务播报 WebSocket 客户端（assistantBroadcast）
// ------------------------------------------------------------
// 服务端：src/assistant/broadcast.js（5s 扫描 + 合并节流）
//         + server.js（订阅后 wsManager.broadcastAssistant）
//         + src/wsManager.js（全局推给所有已登录连接）
// 消息形状：
//   { type:'assistantBroadcast', kind:'task_brief', merged, count,
//     items:[{ eventId, node, taskId, status, at, text }], text, seq, at }
//
// 硬性约束（scripts/verify-assistant-frontend.js 逐条断言）：
//   · 只连同源 `ws(s)://location.host/ws`；鉴权靠同源 cookie（未登录握手 401，
//     不绕过、不加 token 参数、不读 cookie 值）；
//   · 按 eventId 去重（同一 taskId:node 只显示一次）；服务端首拍 primeExisting
//     只登记历史、不补播 → 客户端也不伪造历史消息；
//   · 断线指数退避重连（1s 起、30s 封顶）；卸载/关闭时清定时器并 close()；
//   · 本模块只做「连接 + 解析 + 去重」，不建任务、不发送消息、不触发付费。
// ============================================================

export const BROADCAST_WS_PATH = '/ws';
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
export const DEDUPE_CAP = 500;

/** 同源 WS 地址：http → ws，https → wss。 */
export function webSocketUrl(loc) {
  const l = loc || (typeof window !== 'undefined' ? window.location : null);
  if (!l || !l.host) return '';
  const proto = l.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + l.host + BROADCAST_WS_PATH;
}

/** 指数退避：base, 2×base, 4×base … 封顶 maxMs。 */
export function backoffDelay(attempt, baseMs, maxMs) {
  const base = Number(baseMs) > 0 ? Number(baseMs) : RECONNECT_BASE_MS;
  const max = Number(maxMs) > 0 ? Number(maxMs) : RECONNECT_MAX_MS;
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(max, base * Math.pow(2, n));
}

/** 解析并校验服务端消息；非播报消息（如 progress）返回 null。 */
export function parseBroadcast(raw) {
  let msg = raw;
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type !== 'assistantBroadcast') return null;
  if (msg.kind !== 'task_brief') return null;
  return msg;
}

/** 简报正文：优先服务端 text（含失败原因/建议），缺失时拼 items[].text。
 *  lang='en' 时优先 textEn（服务端按连接语言已给出；中文连接没有 textEn 时回退 text）。
 *  2026-11-21：英文界面下方小智简报此前仍是中文——服务端以前只生成一份中文 text。 */
export function briefText(msg, lang) {
  const isEn = String(lang || '').toLowerCase().startsWith('en');
  const en = msg && typeof msg.textEn === 'string' ? msg.textEn.trim() : '';
  if (isEn && en) return en;
  const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text) return text;
  const items = msg && Array.isArray(msg.items) ? msg.items : [];
  return items
    .map((item) => {
      if (!item) return '';
      if (isEn && typeof item.textEn === 'string' && item.textEn.trim()) return item.textEn.trim();
      return typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function eventIdsOf(msg) {
  const items = msg && Array.isArray(msg.items) ? msg.items : [];
  const ids = [];
  for (const item of items) {
    if (item && item.eventId) ids.push(String(item.eventId));
  }
  return ids;
}

/** 有界 eventId 去重器（Map/Set 上限淘汰最旧，避免长跑页面无限增长）。 */
export function createEventDeduper(cap) {
  const limit = Number(cap) > 0 ? Math.floor(Number(cap)) : DEDUPE_CAP;
  const seen = new Set();
  return {
    has(id) { return seen.has(String(id || '')); },
    accept(id) {
      const key = String(id || '');
      if (!key) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      while (seen.size > limit) {
        const first = seen.values().next().value;
        seen.delete(first);
      }
      return true;
    },
    size() { return seen.size; }
  };
}

/**
 * 消息级去重：至少有一个新 eventId 才接受（并把全部 id 登记）。
 * 服务端已保证同一节点只推一次；这里是客户端防线（重连/多标签页/服务端退化时）。
 */
export function acceptBrief(msg, deduper) {
  const ids = eventIdsOf(msg);
  if (!deduper) return true;
  if (!ids.length) return true;
  const fresh = ids.filter((id) => !deduper.has(id));
  if (fresh.length === 0) return false;
  ids.forEach((id) => deduper.accept(id));
  return true;
}

/**
 * 连接任务播报。
 * @param {object} [opts]
 *   onBrief(payload)   收到新简报（已去重）时回调
 *   onStatus(info)     连接状态（open/reconnecting/closed/disposed/unavailable）
 *   WebSocketImpl      测试注入的 WebSocket 实现
 *   location / url     测试注入的地址（默认取 window.location）
 * 返回 { url, close() }；close() 幂等，用于组件卸载清理。
 */
export function connectAssistantBroadcast(opts = {}) {
  const loc = opts.location || (typeof window !== 'undefined' ? window.location : null);
  const WS = opts.WebSocketImpl || (typeof window !== 'undefined' ? window.WebSocket : null);
  const url = opts.url || webSocketUrl(loc);
  const onBrief = typeof opts.onBrief === 'function' ? opts.onBrief : () => {};
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  const deduper = opts.deduper || createEventDeduper(opts.dedupeCap);
  const baseMs = opts.baseMs || RECONNECT_BASE_MS;
  const maxMs = opts.maxMs || RECONNECT_MAX_MS;
  let socket = null;
  let timer = null;
  let closed = false;
  let attempts = 0;

  if (!WS || !url) {
    onStatus({ state: 'unavailable' });
    return { url: '', close() {} };
  }

  function schedule() {
    if (closed) return;
    const delay = backoffDelay(attempts, baseMs, maxMs);
    attempts += 1;
    onStatus({ state: 'reconnecting', attempt: attempts, delayMs: delay });
    timer = setTimeout(() => { timer = null; open(); }, delay);
  }

  function open() {
    if (closed) return;
    let ws;
    try { ws = new WS(url); } catch (e) { schedule(); return; }
    socket = ws;
    try {
      ws.onopen = () => {
        if (closed) return;
        attempts = 0;
        onStatus({ state: 'open' });
      };
      ws.onmessage = (event) => {
        if (closed) return;
        const msg = parseBroadcast(event && event.data);
        if (!msg) return;
        if (!acceptBrief(msg, deduper)) return;
        const text = briefText(msg);
        if (!text) return;
        try { onBrief({ ...msg, text }); } catch (e) { /* 回调异常不影响连接 */ }
      };
      ws.onerror = () => { onStatus({ state: 'error' }); };
      ws.onclose = (event) => {
        socket = null;
        if (closed) return;
        const code = event && event.code ? event.code : 0;
        onStatus({ state: 'closed', code });
        // 1000 = 正常关闭（页面卸载/服务端主动结束），不重连；其余指数退避重连。
        if (code === 1000) return;
        schedule();
      };
    } catch (e) {
      schedule();
    }
  }

  open();

  return {
    url,
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const ws = socket;
      socket = null;
      if (ws) {
        try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch (e) { /* ignore */ }
        try { ws.close(); } catch (e) { /* ignore */ }
      }
      onStatus({ state: 'disposed' });
    }
  };
}
