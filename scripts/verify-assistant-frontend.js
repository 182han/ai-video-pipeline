#!/usr/bin/env node
// ============================================================
// 小智 2.0 V2 · 前端集成验收（B1–B8 的前端部分）
// ------------------------------------------------------------
// 覆盖（设计文档 §2 V2 / §8.3 B1–B8）：
//   1) WS assistantBroadcast 客户端：同源 /ws、cookie 鉴权（不绕过）、
//      eventId 去重、指数退避重连、卸载关闭、不伪造历史；
//   2) GET /api/assistant/context 页面上报（sessionId + page）与只读环境卡片，
//      Key 只展示有/无（负向：注入 value 也不会被带出）；
//   3) 设置页「小智偏好」读取 + 清空二次确认门（approved 只在确认后生成）；
//   4) 失败诊断一键修复：只对 executable continue 给按钮，确认门，approved 只在确认后；
//   5) B6 pendingChange「确认变更」确认门；
//   6) 新文案全部走 i18n（词条齐全、占位符中英一致、代码引用的键都存在）；
//   7) 本套件已注册进 scripts/verify-all.js。
//
// 方法：静态断言（**先剥注释**，注释里的字样不算实现）+ 真实模块纯函数/桩 WS 断言。
// 不联网、不启动服务、不建任务、不产生费用；浏览器视觉与点击手感仍需人工验收。
// 用法：node scripts/verify-assistant-frontend.js
// 退出码：通过 = 0，失败 = 1
// ============================================================
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web', 'src');
const F = {
  assist: path.join(WEB, 'components', 'assistant.js'),
  page: path.join(WEB, 'screens', 'assistantPage.js'),
  settings: path.join(WEB, 'screens', 'settingsPage.js'),
  msgAssist: path.join(WEB, 'i18n', 'messages', 'assistant.js'),
  msgSettings: path.join(WEB, 'i18n', 'messages', 'settings.js'),
  msgTasks: path.join(WEB, 'i18n', 'messages', 'tasks.js'),
  broadcast: path.join(WEB, 'components', 'assistantBroadcast.js'),
  context: path.join(WEB, 'components', 'assistantContext.js'),
  prefs: path.join(WEB, 'components', 'assistantPreferences.js'),
  repair: path.join(WEB, 'components', 'assistantRepair.js'),
  taskName: path.join(WEB, 'components', 'taskName.js'),
  taskDrawer: path.join(WEB, 'components', 'taskDrawer.js'),
  gen: path.join(WEB, 'screens', 'gen.js'),
  history: path.join(WEB, 'screens', 'history.js'),
  inventory: path.join(WEB, 'screens', 'inventory.js'),
  verifyAll: path.join(ROOT, 'scripts', 'verify-all.js')
};

let passed = 0;
let failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('✓ ' + name);
  } else {
    failed += 1;
    console.log('✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function url(file) {
  return pathToFileURL(file).href;
}

// ---------- 静态检查前先剥注释：注释里的字样不算实现 ----------
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripLineComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function code(file) {
  const src = stripBlockComments(fs.readFileSync(file, 'utf8'));
  return src.split(/\r?\n/).map(stripLineComment).join('\n');
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

function flatten(obj, prefix, out) {
  const result = out || {};
  for (const key of Object.keys(obj)) {
    const full = prefix ? prefix + '.' + key : key;
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, result);
    else result[full] = value;
  }
  return result;
}

function placeholders(template) {
  const set = new Set();
  String(template || '').replace(/\{(\w+)\}/g, (match, name) => { set.add(name); return match; });
  return Array.from(set).sort();
}

function literalKeys(src) {
  const keys = new Set();
  const re = /\b(?:t|tr|tp|has)\(\s*'([A-Za-z0-9_.]+)'/g;
  let m = re.exec(src);
  while (m) { keys.add(m[1]); m = re.exec(src); }
  return Array.from(keys);
}

(async function main() {
  console.log('=== 小智 2.0 V2 前端集成验收（静态 + 纯函数；零计费） ===\n');

  const missingFiles = Object.keys(F).filter((k) => !fs.existsSync(F[k]));
  if (missingFiles.length) {
    console.error('缺少被测文件：' + missingFiles.map((k) => rel(F[k])).join('、'));
    process.exit(1);
  }

  // ---------- DOM / window 桩：用于加载真实组件模块（不执行 React 渲染） ----------
  const store = new Map();
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
  const htmlStub = () => ({});
  global.document = doc;
  global.window = {
    location: {
      pathname: '/app', search: '', protocol: 'http:', host: 'localhost:3001',
      href: 'http://localhost:3001/app'
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }
    },
    dispatchEvent() {},
    addEventListener() {},
    removeEventListener() {},
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
    value: { language: 'zh-CN', languages: ['zh-CN'] },
    configurable: true
  });

  const broadcast = await import(url(F.broadcast));
  const context = await import(url(F.context));
  const prefs = await import(url(F.prefs));
  const repair = await import(url(F.repair));
  const taskName = await import(url(F.taskName));

  // ================= [1] 文件与模块图 =================
  console.log('[1] 文件与模块图');
  ok('V2 前端模块 + 任务显示名模块 + 被接入的页面/组件（文件都存在）',
    Object.keys(F).every((k) => fs.existsSync(F[k])),
    missingFiles.join(','));
  const pageCode = code(F.page);
  ok('小智首页仍以 page 模式挂载 Assistant（/ 的对话页）',
    pageCode.includes('<${Assistant} page=${true} />'));
  const broadcastCode = code(F.broadcast);
  const contextCode = code(F.context);
  const prefsCode = code(F.prefs);
  const repairCode = code(F.repair);
  const assistCode = code(F.assist);
  const settingsCode = code(F.settings);
  const taskNameCode = code(F.taskName);
  const taskDrawerCode = code(F.taskDrawer);
  const genCode = code(F.gen);
  const historyCode = code(F.history);
  const inventoryCode = code(F.inventory);
  ok('静态判据先在剥注释后的代码上执行（注释里的字样不算实现）',
    broadcastCode.length > 500
    && fs.readFileSync(F.broadcast, 'utf8').includes('断线指数退避重连')
    && !broadcastCode.includes('断线指数退避重连'));

  // ================= [2] WS assistantBroadcast 客户端 =================
  console.log('\n[2] WS assistantBroadcast：协议 / 去重 / 重连 / 卸载');
  ok('只连同源 /ws：ws/wss 由 location.protocol 决定，主机取 location.host',
    /BROADCAST_WS_PATH = '\/ws'/.test(broadcastCode)
    && /l\.protocol === 'https:' \? 'wss:' : 'ws:'/.test(broadcastCode)
    && /l\.host/.test(broadcastCode));
  ok('握手只用同源 cookie：不读 cookie 值、不带 token 参数（不绕过登录墙）',
    !/document\.cookie/.test(broadcastCode) && !/token/i.test(broadcastCode)
    && /window\.WebSocket/.test(broadcastCode) && /new WS\(url\)/.test(broadcastCode));
  ok('只接受 type=assistantBroadcast / kind=task_brief（progress 等消息被忽略）',
    /msg\.type !== 'assistantBroadcast'/.test(broadcastCode)
    && /msg\.kind !== 'task_brief'/.test(broadcastCode));
  ok('按 eventId 去重（有界 seen 集合 + 消息级 acceptBrief）',
    /createEventDeduper/.test(broadcastCode) && /seen\.has\(key\)/.test(broadcastCode)
    && /export function acceptBrief/.test(broadcastCode));
  ok('断线指数退避重连（backoffDelay + setTimeout + clearTimeout）',
    /export function backoffDelay/.test(broadcastCode) && /setTimeout/.test(broadcastCode)
    && /clearTimeout/.test(broadcastCode) && /state: 'reconnecting'/.test(broadcastCode));
  ok('close() 清定时器并摘掉回调（组件卸载可彻底断开）',
    /clearTimeout\(timer\)/.test(broadcastCode)
    && /ws\.onopen = ws\.onmessage = ws\.onerror = ws\.onclose = null/.test(broadcastCode));
  ok('客户端不发送任何 WS 消息、不发 HTTP 请求（不伪造历史 / 不补播）',
    !/\.send\(/.test(broadcastCode) && !/fetch\(/.test(broadcastCode));
  ok('assistant.js 接入播报客户端，并把简报作为系统消息追加',
    /from '\.\/assistantBroadcast\.js'/.test(assistCode)
    && /connectAssistantBroadcast\(/.test(assistCode)
    && /setMsgs\(\(m\) => \[\.\.\.m, \{ role: 'system', content: text \}\]\)/.test(assistCode));
  ok('播报 effect 在卸载时 client.close()',
    /return \(\) => \{ client\.close\(\); \}/.test(assistCode));

  // ---- 纯函数：URL / 解析 / 去重 / 退避 / 桩 WS 端到端 ----
  ok('webSocketUrl：http → ws://host/ws',
    broadcast.webSocketUrl({ protocol: 'http:', host: 'localhost:3001' }) === 'ws://localhost:3001/ws',
    broadcast.webSocketUrl({ protocol: 'http:', host: 'localhost:3001' }));
  ok('webSocketUrl：https → wss://host/ws（公网/反代）',
    broadcast.webSocketUrl({ protocol: 'https:', host: 'example.test' }) === 'wss://example.test/ws');
  ok('webSocketUrl：没有 location 时返回空（不连接）',
    broadcast.webSocketUrl(null) === '' || broadcast.webSocketUrl({}) === '');

  const goodMsg = {
    type: 'assistantBroadcast', kind: 'task_brief', merged: false, count: 1, seq: 7,
    items: [{ eventId: 'evt_1', node: 'task_completed', taskId: 'task_a', status: 'completed', text: 'x' }],
    text: 'BRIEF-1'
  };
  ok('parseBroadcast 接受 task_brief 播报',
    !!broadcast.parseBroadcast(JSON.stringify(goodMsg)));
  ok('parseBroadcast 拒绝 progress 等非播报消息（负向）',
    broadcast.parseBroadcast(JSON.stringify({ type: 'progress', taskId: 't', data: {} })) === null);
  ok('parseBroadcast 拒绝坏 JSON（负向）',
    broadcast.parseBroadcast('{not json') === null);
  ok('briefText 优先用服务端 text，缺失时拼 items[].text',
    broadcast.briefText(goodMsg) === 'BRIEF-1'
    && broadcast.briefText({ items: [{ text: 'a' }, { text: 'b' }] }) === 'a\nb');

  const deduper = broadcast.createEventDeduper(10);
  ok('dedupe：首次接受、重复拒绝（同一 eventId 只显示一次）',
    deduper.accept('evt_1') === true && deduper.accept('evt_1') === false && deduper.has('evt_1') === true);
  const capped = broadcast.createEventDeduper(2);
  capped.accept('a'); capped.accept('b'); capped.accept('c');
  ok('dedupe：有界淘汰最旧（cap=2 时 a 被淘汰）',
    capped.size() === 2 && capped.has('a') === false && capped.has('c') === true);

  const msgDeduper = broadcast.createEventDeduper(10);
  const msgA = { items: [{ eventId: 'e1' }] };
  const msgMerged = { items: [{ eventId: 'e1' }, { eventId: 'e2' }] };
  ok('acceptBrief：同一条消息第二次被拒（负向）',
    broadcast.acceptBrief(msgA, msgDeduper) === true && broadcast.acceptBrief(msgA, msgDeduper) === false);
  ok('acceptBrief：合并消息里含新 eventId 才接受',
    broadcast.acceptBrief(msgMerged, msgDeduper) === true
    && broadcast.acceptBrief(msgMerged, msgDeduper) === false);

  const delays = [0, 1, 2, 3, 8].map((n) => broadcast.backoffDelay(n, 1000, 30000));
  ok('backoffDelay：指数递增且起步 >= base（1s / 2s / 4s）',
    delays[0] === 1000 && delays[1] === 2000 && delays[2] === 4000
    && delays.every((v, i) => i === 0 || v >= delays[i - 1]));
  ok('backoffDelay：封顶 30s（不会无限增长）',
    broadcast.backoffDelay(20, 1000, 30000) === 30000);

  class FakeWS {
    constructor(wsUrl) { this.url = wsUrl; this.closed = false; FakeWS.instances.push(this); }
    close() { this.closed = true; }
    emit(payload) { if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) }); }
  }
  FakeWS.instances = [];
  const briefs = [];
  const states = [];
  const client = broadcast.connectAssistantBroadcast({
    location: { protocol: 'http:', host: 'localhost:3001' },
    WebSocketImpl: FakeWS,
    onBrief: (m) => briefs.push(m),
    onStatus: (s) => states.push(s.state)
  });
  ok('桩 WS：连接到 ws://location.host/ws',
    FakeWS.instances.length === 1 && FakeWS.instances[0].url === 'ws://localhost:3001/ws',
    FakeWS.instances[0] && FakeWS.instances[0].url);
  FakeWS.instances[0].emit(goodMsg);
  ok('桩 WS：收到播报回调一次（正文为服务端 text）',
    briefs.length === 1 && briefs[0].text === 'BRIEF-1');
  FakeWS.instances[0].emit(goodMsg);
  ok('桩 WS：同一 eventId 重发不重复回调（去重生效）', briefs.length === 1);
  FakeWS.instances[0].emit({
    type: 'assistantBroadcast', kind: 'task_brief', seq: 8,
    items: [{ eventId: 'evt_2', node: 'task_created', taskId: 'task_b', text: 'y' }], text: 'BRIEF-2'
  });
  ok('桩 WS：新 eventId 正常回调', briefs.length === 2 && briefs[1].text === 'BRIEF-2');
  FakeWS.instances[0].emit({ type: 'progress', taskId: 'task_b', data: { percent: 10 } });
  ok('桩 WS：progress 消息被忽略（不混进播报）', briefs.length === 2);
  client.close();
  ok('桩 WS：close() 关闭连接并摘掉回调（卸载清理）',
    FakeWS.instances[0].closed === true
    && FakeWS.instances[0].onmessage === null
    && states.includes('disposed'));

  // ================= [3] context 页面上报 + 只读卡片 =================
  console.log('\n[3] context 页面上报（只读 A–E；Key 只报有/无）');
  ok('请求形状：/api/assistant/context?sessionId=&page=（两个参数都 encodeURIComponent）',
    /\/api\/assistant\/context\?sessionId=/.test(contextCode)
    && /'&page=' \+ encodeURIComponent/.test(contextCode)
    && /encodeURIComponent\(String\(sessionId \|\| ''\)\)/.test(contextCode));
  ok('上报页面 = location.pathname + location.search（含 /app 前缀）',
    /String\(l\.pathname \|\| '\/'\) \+ String\(l\.search \|\| ''\)/.test(contextCode)
    && context.contextPageParam({ pathname: '/app', search: '' }) === '/app'
    && context.contextPageParam({ pathname: '/app/create', search: '?x=1&y=2' }) === '/app/create?x=1&y=2');
  ok('contextUrl 对 page 做百分号编码（/app/create?x=1 → %2Fapp%2Fcreate%3Fx%3D1）',
    context.contextUrl('s_1', '/app/create?x=1')
      === '/api/assistant/context?sessionId=s_1&page=%2Fapp%2Fcreate%3Fx%3D1',
    context.contextUrl('s_1', '/app/create?x=1'));
  ok('contextUrl 对 sessionId 做百分号编码（空格 → %20）',
    context.contextUrl('s 1', '/').includes('sessionId=s%201'));

  const ctxFixture = {
    ui: { page: '/app' },
    tasks: {
      total: 42,
      active: [{ taskId: 'a' }],
      recent: [{ taskId: 'a' }],
      failedRecent: [{ taskId: 'b' }, { taskId: 'c' }]
    },
    budget: { currency: 'USD', spentUsd: 0.06, balanceUsd: 196.28 },
    assets: {
      photos: { all: 15, usable: 12, pending: 2, approved: 12, rejected: 1 },
      library: { finals: 3, clips: 40 },
      sceneCards: { features: 100, buffers: 20 },
      bgm: { tracks: 6 }
    },
    settings: {
      keys: [
        { label: '视频生成·WhaleTV 中转', present: true, value: 'sk-secret-should-not-leak' },
        { label: '文案 LLM', present: false }
      ],
      preferences: {
        model: 'dashscope', modelLabel: '百炼', resolution: '1080p',
        clipDurationSec: 10, bgmStyle: '轻音乐', updatedAt: '2026-11-17T00:00:00.000Z'
      }
    },
    server: { pid: 43840, uptimeSec: 3600, ffmpegAvailable: true }
  };
  const summary = context.summarizeContext(ctxFixture);
  ok('summarizeContext：任务/预算/素材/服务/页面 数字齐全',
    summary.tasks.total === 42 && summary.tasks.active === 1 && summary.tasks.failed === 2
    && summary.budget.spentUsd === 0.06 && summary.budget.balanceUsd === 196.28
    && summary.assets.photosUsable === 12 && summary.assets.photosAll === 15
    && summary.assets.finals === 3 && summary.assets.clips === 40
    && summary.assets.sceneCards === 120 && summary.assets.bgm === 6
    && summary.server.pid === '43840' && summary.server.ffmpeg === true
    && summary.page === '/app');
  ok('summarizeContext：Key 只保留 {label, present}（没有 value 字段）',
    summary.keys.length === 2 && !('value' in summary.keys[0])
    && summary.keys[0].present === true && summary.keys[1].present === false);
  ok('summarizeContext：上游误传的 Key 值不会被带出（负向）',
    !JSON.stringify(summary).includes('sk-secret-should-not-leak'));
  ok('summarizeContext：偏好摘要（model/resolution/clipDurationSec/bgmStyle/updatedAt）',
    summary.preferences.model === 'dashscope' && summary.preferences.resolution === '1080p'
    && summary.preferences.clipDurationSec === 10 && summary.preferences.bgmStyle === '轻音乐'
    && summary.preferences.updatedAt === '2026-11-17T00:00:00.000Z');
  ok('Key 卡只列已配置项（present 过滤，不再逐项列「无」）',
    /keys\.filter\(\(k\) => k\.present === true\)/.test(contextCode)
    && /presentKeys/.test(contextCode)
    && !/keyAbsent/.test(contextCode)
    && /export function AssistantContextCard\(/.test(contextCode));
  ok('一个 present 都没有 → 一行说明（服务端环境变量 vs 浏览器设置）',
    /presentKeys\.length > 0 \?/.test(contextCode)
    && /assistant\.context\.keysNone/.test(contextCode));
  ok('有 present → 只列已配置项并保留说明',
    /assistant\.context\.keysHint/.test(contextCode)
    && /presentKeys\.map\(/.test(contextCode));
  ok('assistant.js 打开/对话时拉 context，并支持手动刷新',
    /fetchAssistantContext\(sessionId, \{ page: contextPageParam\(\) \}\)/.test(assistCode)
    && /refreshContextRef\.current = load/.test(assistCode)
    && countOf(assistCode, 'if (refreshContextRef.current) refreshContextRef.current();') >= 2);
  ok('assistant.js 渲染只读环境卡片',
    assistCode.includes('<${AssistantContextCard}') && /assistant\.context\.title/.test(contextCode));
  ok('路由变化（popstate）会重新上报页面',
    /window\.addEventListener\('popstate', onRoute\)/.test(assistCode));
  ok('context 只读：模块里没有任何写操作（POST/PUT/DELETE）',
    !/method:\s*'(POST|PUT|DELETE)'/.test(contextCode));

  // ================= [4] 偏好读取 + 清空确认门 =================
  console.log('\n[4] 设置页「小智偏好」：读取 + 清空二次确认');
  ok('设置页挂载「小智偏好」区（title 词条 + 组件）',
    /from '\.\.\/components\/assistantPreferences\.js'/.test(settingsCode)
    && settingsCode.includes('<${AssistantPreferencesSection}')
    && /settings\.xiaozhi\.title/.test(settingsCode));
  ok('偏好读取：GET /api/assistant/preferences（只读）',
    /fetch\('\/api\/assistant\/preferences'/.test(prefsCode));
  ok('清空偏好：POST /api/assistant/preferences/clear',
    /\/api\/assistant\/preferences\/clear/.test(prefsCode));
  const prefsConfirmBlockAt = prefsCode.indexOf('confirming && pref');
  const prefsConfirmBtnAt = prefsCode.indexOf('onClick=${clearPreferences}');
  ok('清空按钮不再被「无偏好」禁用（disabled 只看 busy，始终可点）',
    !/disabled=\$\{busy \|\| !pref\}/.test(prefsCode)
    && /onClick=\$\{startClear\}/.test(prefsCode)
    && /disabled=\$\{busy\}/.test(prefsCode));
  ok('无偏好时点击给提示（noneToClear，不发请求）',
    /if \(!pref\)/.test(prefsCode)
    && /settings\.xiaozhi\.noneToClear/.test(prefsCode)
    && /tone: 'muted'/.test(prefsCode));
  ok('清空改用内联确认（不再用 window.confirm）',
    !/window\.confirm/.test(prefsCode));
  ok('内联确认：确认清空 / 取消 两个按钮，确认按钮只在 confirming 块里',
    /settings\.xiaozhi\.clearConfirmYes/.test(prefsCode)
    && /tr\('common\.cancel'\)/.test(prefsCode)
    && prefsConfirmBlockAt >= 0 && prefsConfirmBtnAt > prefsConfirmBlockAt
    && countOf(prefsCode, 'onClick=${clearPreferences}') === 1,
    `confirmBlock@${prefsConfirmBlockAt} btn@${prefsConfirmBtnAt}`);
  ok('清空端点只出现一次，且 POST 只有一条（approved 只在确认后构造）',
    countOf(prefsCode, '/api/assistant/preferences/clear') === 1
    && /buildClearPreferencesRequest\(\{ confirmed: true \}\)/.test(prefsCode)
    && countOf(prefsCode, "method: 'POST'") === 1);
  ok('buildClearPreferencesRequest：未确认返回 null（负向）',
    prefs.buildClearPreferencesRequest({}) === null
    && prefs.buildClearPreferencesRequest({ confirmed: false }) === null);
  ok('buildClearPreferencesRequest：确认后 = {approved:true}',
    JSON.stringify(prefs.buildClearPreferencesRequest({ confirmed: true })) === '{"approved":true}');
  const prefRows = prefs.describePreferences({
    model: 'dashscope', modelLabel: '百炼', resolution: '1080p',
    clipDurationSec: 10, bgmStyle: '轻音乐', updatedAt: '2026-11-17T00:00:00.000Z'
  });
  ok('偏好展示四类字段（model/resolution/clipDurationSec/bgmStyle）',
    prefRows.length === 4
    && prefRows.map((r) => r.key).join(',') === 'model,resolution,clipDuration,bgmStyle');
  ok('清空结果三态：成功 / 无偏好 / 失败 都有独立文案',
    /settings\.xiaozhi\.clearDone/.test(prefsCode)
    && /settings\.xiaozhi\.clearNothing/.test(prefsCode)
    && /settings\.xiaozhi\.clearFailed/.test(prefsCode));
  ok('读取失败与 updatedAt 也如实展示',
    /settings\.xiaozhi\.loadFailed/.test(prefsCode)
    && /settings\.xiaozhi\.updatedAt/.test(prefsCode));

  // ================= [5] 一键修复 =================
  console.log('\n[5] 一键修复：确认门 + 只对 executable continue');
  ok('assistant.js 保存 diagnosis 并渲染修复卡（有可执行项才出）',
    /setDiagnosis\(j\.diagnosis \|\| null\)/.test(assistCode)
    && /diagnosis && executableRepairs\(diagnosis\)\.length > 0/.test(assistCode)
    && assistCode.includes('<${RepairCard}'));
  ok('executableRepairs：只取 executable===true 且 action==="continue"（负向混合）',
    repair.executableRepairs({
      suggestions: [
        { id: 'a', action: 'continue', executable: true },
        { id: 'b', action: 'switch_model', executable: true },
        { id: 'c', action: 'continue', executable: false },
        { id: 'd', action: 'continue' }
      ]
    }).map((s) => s.id).join(',') === 'a');
  ok('修复未确认不生成请求体（负向）',
    repair.buildRepairRequest({ taskId: 't1', sessionId: 's1' }) === null
    && repair.buildRepairRequest({ taskId: 't1', sessionId: 's1', confirmed: false }) === null);
  const repairBody = repair.buildRepairRequest({
    taskId: 't1', sessionId: 's1', runtimeConfig: { apiKey: 'k' }, confirmed: true
  });
  ok('修复确认后：approved:true + action:"continue" + taskId + sessionId',
    !!repairBody && repairBody.approved === true && repairBody.action === 'continue'
    && repairBody.taskId === 't1' && repairBody.sessionId === 's1');
  ok('修复确认后带 runtimeConfig（重启后真实模型续跑所需；Key 只在内存随请求）',
    !!repairBody && repairBody.runtimeConfig && repairBody.runtimeConfig.apiKey === 'k');
  ok('修复缺 taskId 不生成请求体（负向）',
    repair.buildRepairRequest({ sessionId: 's1', confirmed: true }) === null);
  const repairConfirmAt = repairCode.indexOf('window.confirm');
  const repairPostAt = repairCode.indexOf('/api/assistant/repair');
  ok('修复确认门：window.confirm 出现在 repair 请求之前',
    repairConfirmAt >= 0 && repairPostAt > repairConfirmAt,
    `confirm@${repairConfirmAt} repair@${repairPostAt}`);
  ok('repair 端点只出现一次（不存在绕过确认的第二条路径）',
    countOf(repairCode, '/api/assistant/repair') === 1);
  ok('修复卡先确认（文案含「可能产生费用」）再发 approved',
    /assistant\.repair\.confirm/.test(repairCode)
    && /window\.confirm\(tr\('assistant\.repair\.confirm'/.test(repairCode));
  ok('修复失败如实展示（不假装成功）',
    /assistant\.repair\.failed/.test(repairCode)
    && /assistant\.repair\.ok/.test(repairCode)
    && /if \(!r\.ok \|\| !j \|\| j\.ok !== true\)/.test(repairCode));

  // ================= [6] B6 pendingChange 确认门 =================
  console.log('\n[6] B6 pendingChange：「确认变更」确认门');
  ok('assistant.js 保存 pendingChange（requiresConfirm 才会出卡）',
    /setPendingChange\(j\.pendingChange && j\.pendingChange\.requiresConfirm === true \? j\.pendingChange : null\)/.test(assistCode)
    && assistCode.includes('<${PendingChangeCard}'));
  ok('buildSettingsConfirmRequest：未确认返回 null（负向）',
    repair.buildSettingsConfirmRequest({ sessionId: 's1', changeId: 'chg_1' }) === null
    && repair.buildSettingsConfirmRequest({ sessionId: 's1', changeId: 'chg_1', confirmed: false }) === null);
  const changeBody = repair.buildSettingsConfirmRequest({
    sessionId: 's1', changeId: 'chg_1', confirmed: true
  });
  ok('设置确认：approved:true + changeId + sessionId',
    !!changeBody && changeBody.approved === true && changeBody.changeId === 'chg_1'
    && changeBody.sessionId === 's1');
  ok('设置确认缺 changeId 不生成请求体（防张冠李戴 / 跳过校验）',
    repair.buildSettingsConfirmRequest({ sessionId: 's1', confirmed: true }) === null);
  const settingsPostAt = repairCode.indexOf('/api/assistant/settings/confirm');
  ok('设置确认门：window.confirm 出现在 settings/confirm 请求之前',
    settingsPostAt > repairConfirmAt, `confirm@${repairConfirmAt} settings@${settingsPostAt}`);
  ok('settings/confirm 端点只出现一次 + 两个 POST 都过确认门',
    countOf(repairCode, '/api/assistant/settings/confirm') === 1
    && countOf(repairCode, "method: 'POST'") === 2);
  ok('确认/修复结果回执：成功才刷新状态与 context，失败只追加失败文案',
    /function afterAction\(ok, text\)/.test(assistCode)
    && /if \(!ok\) return;/.test(assistCode)
    && /refreshState\(\);\n\s*if \(refreshContextRef\.current\) refreshContextRef\.current\(\);/.test(assistCode));

  // ================= [7] i18n =================
  console.log('\n[7] i18n：新文案走词条（zh/en 对等）');
  const msgAssist = (await import(url(F.msgAssist))).default;
  const msgSettings = (await import(url(F.msgSettings))).default;
  const msgTasks = (await import(url(F.msgTasks))).default;
  const zh = {
    ...flatten(msgAssist.zh, '', {}),
    ...flatten(msgSettings.zh, '', {}),
    ...flatten(msgTasks.zh, '', {})
  };
  const en = {
    ...flatten(msgAssist.en, '', {}),
    ...flatten(msgSettings.en, '', {}),
    ...flatten(msgTasks.en, '', {})
  };
  const required = [
    'assistant.context.title', 'assistant.context.refresh', 'assistant.context.loading',
    'assistant.context.error', 'assistant.context.page', 'assistant.context.tasks',
    'assistant.context.tasksValue', 'assistant.context.budget', 'assistant.context.budgetValue',
    'assistant.context.budgetUnknown', 'assistant.context.assets', 'assistant.context.assetsValue',
    'assistant.context.service', 'assistant.context.serviceValue', 'assistant.context.ffmpegOn',
    'assistant.context.ffmpegOff', 'assistant.context.prefs', 'assistant.context.prefsValue',
    'assistant.context.keys', 'assistant.context.keysNone', 'assistant.context.keysHint',
    'assistant.context.keyWhaletv', 'assistant.context.keyDashscope', 'assistant.context.keyKling',
    'assistant.context.keyImage', 'assistant.context.keyMultimodal', 'assistant.context.keyLlm',
    'assistant.context.note',
    'assistant.repair.title', 'assistant.repair.hint', 'assistant.repair.action',
    'assistant.repair.confirm', 'assistant.repair.busy', 'assistant.repair.ok', 'assistant.repair.failed',
    'assistant.pending.title', 'assistant.pending.change', 'assistant.pending.confirm',
    'assistant.pending.confirmDialog', 'assistant.pending.busy', 'assistant.pending.ok',
    'assistant.pending.failed', 'assistant.pending.ttl',
    'settings.xiaozhi.title', 'settings.xiaozhi.serverNote', 'settings.xiaozhi.loading',
    'settings.xiaozhi.refresh', 'settings.xiaozhi.empty', 'settings.xiaozhi.model',
    'settings.xiaozhi.modelValue', 'settings.xiaozhi.resolution', 'settings.xiaozhi.clipDuration',
    'settings.xiaozhi.seconds', 'settings.xiaozhi.bgmStyle', 'settings.xiaozhi.updatedAt',
    'settings.xiaozhi.clear', 'settings.xiaozhi.clearing', 'settings.xiaozhi.clearConfirm',
    'settings.xiaozhi.clearConfirmYes', 'settings.xiaozhi.noneToClear',
    'settings.xiaozhi.clearDone', 'settings.xiaozhi.clearNothing', 'settings.xiaozhi.clearFailed',
    'settings.xiaozhi.loadFailed',
    'tasks.displayName', 'tasks.displayNameNoPrompt', 'tasks.displayNameUnnamed',
    'tasks.shortId', 'tasks.taskIdTooltip', 'tasks.drawer.taskId'
  ];
  const missingZh = required.filter((k) => zh[k] === undefined);
  const missingEn = required.filter((k) => en[k] === undefined);
  ok('新词条中英齐全（' + required.length + ' 条）',
    missingZh.length === 0 && missingEn.length === 0,
    missingZh.concat(missingEn).slice(0, 8).join(', '));
  const phMismatch = required.filter((k) => placeholders(zh[k]).join(',') !== placeholders(en[k]).join(','));
  ok('新词条 {占位符} 中英一致', phMismatch.length === 0, phMismatch.slice(0, 8).join(', '));
  const scanFiles = [F.assist, F.context, F.prefs, F.repair, F.settings, F.page];
  const usedMissing = [];
  for (const file of scanFiles) {
    for (const key of literalKeys(code(file))) {
      if (!/^(assistant|settings)\./.test(key)) continue;
      if (zh[key] === undefined || en[key] === undefined) usedMissing.push(rel(file) + ':' + key);
    }
  }
  ok('代码里 tr/t(assistant./settings.) 用到的键都有中英词条',
    usedMissing.length === 0, usedMissing.slice(0, 8).join(', '));
  const taskUsedMissing = literalKeys(taskNameCode)
    .filter((k) => /^tasks\./.test(k) && (zh[k] === undefined || en[k] === undefined));
  ok('taskName.js 里 tr(tasks.*) 用到的键都有中英词条',
    taskUsedMissing.length === 0, taskUsedMissing.slice(0, 8).join(', '));
  // settingsPage.js 有一行 i18n-allow（后端中文错误前缀匹配，属功能性中文），
  // 由 verify-i18n --strict 逐行豁免；这里只检查本次新增的模块与 assistant.js。
  ok('新模块与 assistant.js 没有硬编码中文界面文案（词条文件除外；注释已被剥离）',
    [F.broadcast, F.context, F.prefs, F.repair, F.assist, F.taskName]
      .every((file) => !/[\u4e00-\u9fff]/.test(code(file))));

  // ================= [8] 任务显示名（用户 UX：不再露原始 taskId） =================
  console.log('\n[8] 任务显示名：prompt 摘要 + 模型 + 时间（原始 ID 只留详情/tooltip）');
  ok('taskName.js 导出统一显示名 / 短 ID / 摘要三个函数',
    /export function taskDisplayName\(/.test(taskNameCode)
    && /export function taskShortId\(/.test(taskNameCode)
    && /export function taskPromptSummary\(/.test(taskNameCode));
  ok('taskShortId：长 ID 压缩成 task_mwiu…z01l（保留前缀与尾 4 位）',
    taskName.taskShortId('task_mwiugoxq_z01l') === 'task_mwiu…z01l',
    taskName.taskShortId('task_mwiugoxq_z01l'));
  ok('taskShortId：短 ID 原样返回；空值返回空串',
    taskName.taskShortId('short_id') === 'short_id'
    && taskName.taskShortId('') === '' && taskName.taskShortId(null) === '');
  ok('taskPromptSummary：多行压成一行并去首尾空白',
    taskName.taskPromptSummary({ prompt: '  雪山\n\n日出  ' }) === '雪山 日出',
    JSON.stringify(taskName.taskPromptSummary({ prompt: '  雪山\n\n日出  ' })));
  const truncated = taskName.taskPromptSummary({ prompt: 'x'.repeat(40) }, 10);
  ok('taskPromptSummary：超长截断并加省略号（20–30 字可配）',
    truncated.length === 11 && truncated.endsWith('…'), truncated);
  ok('taskPromptSummary：无 prompt 时回退 prompts[0].text',
    taskName.taskPromptSummary({ prompts: [{ text: '多提示词第一条' }, { text: '第二条' }] }) === '多提示词第一条');
  const dn = taskName.taskDisplayName({ prompt: '雪山日出', model: 'dashscope', createdAt: '2026-11-18T07:00:00Z' });
  ok('taskDisplayName：含 prompt 摘要 + 模型（时间同处）',
    dn.includes('雪山日出') && dn.includes('dashscope') && dn.includes('2026'));
  ok('taskDisplayName：不把完整 taskId 拼进显示名（负向）',
    !dn.includes('task_'));
  const dnNoPrompt = taskName.taskDisplayName({ taskId: 'task_abcdefgh_1234', model: 'mock', createdAt: '2026-11-18T07:00:00Z' });
  ok('taskDisplayName：无 prompt → 模型 + 时间，不露完整 ID（负向）',
    dnNoPrompt.includes('mock') && !dnNoPrompt.includes('task_abcdefgh'), dnNoPrompt);
  const dnUnnamed = taskName.taskDisplayName({ taskId: 'task_abcdefgh_1234' });
  ok('taskDisplayName：无 prompt/模型/时间 → 「未命名任务 + 短 ID」',
    dnUnnamed.includes('task_abcd…1234') && !dnUnnamed.includes('task_abcdefgh'), dnUnnamed);
  ok('TaskDrawer 标题用 taskDisplayName（不再直接渲染 taskId），完整 ID 放进详情行',
    /import \{ taskDisplayName, taskShortId \} from '\.\/taskName\.js'/.test(taskDrawerCode)
    && /taskDisplayName\(t\)/.test(taskDrawerCode)
    && /tasks\.drawer\.taskId/.test(taskDrawerCode)
    && /\$\{t\.taskId \|\| taskId\}/.test(taskDrawerCode)
    && !/font-num truncate">\$\{taskId\}/.test(taskDrawerCode)
    && /tasks\.taskIdTooltip/.test(taskDrawerCode));
  ok('生成中页用任务显示名 + 短 ID（不再把 taskId 当标题）',
    /taskDisplayName\(task\)/.test(genCode)
    && /tasks\.shortId/.test(genCode)
    && /taskShortId\(task\.taskId\)/.test(genCode)
    && !/text-ink3 font-num">\s*\$\{task\.taskId\}/.test(genCode));
  ok('历史回收站用时间 + 短 ID（tooltip 给完整 ID）',
    /taskShortId\(/.test(historyCode) && /tasks\.shortId/.test(historyCode)
    && /tasks\.taskIdTooltip/.test(historyCode)
    && !/\$\{t\.taskId \|\| id\}/.test(historyCode));
  ok('任务回收站抽屉用短 ID（tooltip 完整 ID；import 行数保持不变以免打翻既有套件）',
    /function shortTaskId\(/.test(inventoryCode)
    && /tasks\.shortId/.test(inventoryCode) && /tasks\.taskIdTooltip/.test(inventoryCode)
    && !/\$\{it\.taskId\} · /.test(inventoryCode)
    && (inventoryCode.match(/^import /gm) || []).length === 5);

  // ================= [9] 注册进 verify-all.js =================
  console.log('\n[9] 门禁注册');
  const verifyAllCode = code(F.verifyAll);
  ok('已注册进 scripts/verify-all.js（name/script/group=fast）',
    /name: 'assistant-frontend'/.test(verifyAllCode)
    && /script: 'verify-assistant-frontend\.js'/.test(verifyAllCode)
    && /group: 'fast'/.test(verifyAllCode));

  // ================= [10] 防永真自检 =================
  console.log('\n[10] 判据自检（防止断言永真）');
  const predWs = (s) => /new WS\(url\)/.test(s);
  const predSystemMsg = (s) => /role: 'system'/.test(s);
  const predDisplayName = (s) => /taskDisplayName\(t\)/.test(s);
  const predInlineConfirm = (s) => {
    const a = s.indexOf('confirming && pref');
    const b = s.indexOf('onClick=${clearPreferences}');
    return a >= 0 && b > a;
  };
  ok('判据在空源码上不通过（WS 客户端判据）', predWs('') === false && predWs(broadcastCode) === true);
  ok('判据在空源码上不通过（系统消息判据）', predSystemMsg('') === false && predSystemMsg(assistCode) === true);
  ok('判据在空源码上不通过（任务显示名判据）',
    predDisplayName('') === false && predDisplayName(taskDrawerCode) === true);
  ok('判据在空源码/乱序上不通过（内联确认顺序判据）',
    predInlineConfirm('') === false
    && predInlineConfirm('onClick=${clearPreferences} confirming && pref') === false
    && predInlineConfirm(prefsCode) === true);
  ok('断言数量足够（>= 60 条，且失败会体现在退出码）', passed + failed >= 60);

  console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('前端集成验收自身异常：', err);
  process.exit(1);
});
