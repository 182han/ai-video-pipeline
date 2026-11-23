// ============================================================
// 提示词助手（悬浮球 + 对话面板）
// ------------------------------------------------------------
// 悬浮球形态：Liquid Orb（WebGL2 粒子缎带 + 玻璃外壳，见 assistantOrb.js；
//   不支持 WebGL2 时退回 CSS 径向渐变球）。
// 规格来源：docs/requirements/提示词助手悬浮球-需求.md
// 接口：POST /api/assistant/chat
//   请求 { messages, llmApiKey, llmBaseUrl, llmModel }
//   响应 ok:true → { ready, message, prompt }；ok:false → { error, message }
// ready 只在「模型说完成」且「真的给了非空 prompt」时为真（后端保证）。
// 生成的提示词通过 promptBus 送回创作屏，不直接操作 DOM。
// ============================================================
import { promptBus, readLLMConfig, readRuntimeConfig } from '../store.js';
import { navigate, currentRoute } from '../router.js';
import { createOrb } from './assistantOrb.js';
import { PlanCard, StateStrip, GreetingBubble, VoiceButton, ImageReviewCard } from './xiaozhiPlan.js';
import { t as tr, getLocale } from '../i18n/index.js';
// 小智 2.0 V2 前端集成（2026-11-17）：
//   · assistantBroadcast：任务播报 WS 客户端（eventId 去重 / 退避重连 / 卸载关闭）；
//   · assistantContext：GET /api/assistant/context 只读环境小卡片（页面上报 + Key 只报有/无）；
//   · assistantRepair：失败诊断「一键修复」与 B6「设置变更确认」（确认门都在组件内）。
import { connectAssistantBroadcast, briefText } from './assistantBroadcast.js';
import { AssistantContextCard, fetchAssistantContext, contextPageParam } from './assistantContext.js';
import { RepairCard, PendingChangeCard, executableRepairs } from './assistantRepair.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

const POS_KEY = 'vs_assistant_pos';

// V2 任务播报是「系统消息」：与普通回复区分（香槟金描边），沿用既有 xz-bubble，
// 只加内联样式——web/styles 的 CSS 是离线生成的，本次不动样式表。
const SYSTEM_BUBBLE_STYLE = {
  border: '1px solid rgba(214,179,106,.30)',
  background: 'rgba(214,179,106,.07)'
};

// 逐段出图开关（2026-11-16 20:4x 用户决定）：**默认关闭**，用户可在计划卡手动打开。
// localStorage：'1' = 开；'0' 或缺失 = 关（缺失=关，避免一提交就先把图片钱花掉）。
const IMAGE_PER_CLIP_KEY = 'vs_image_per_clip';
function readImagePerClip() {
  try { return localStorage.getItem(IMAGE_PER_CLIP_KEY) === '1'; } catch (e) { return false; }
}
function writeImagePerClip(on) {
  try { localStorage.setItem(IMAGE_PER_CLIP_KEY, on ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
}

// 液态球：WebGL2 可用时渲染粒子缎带 + 玻璃外壳；
// 取不到上下文/着色器失败时退回 CSS 径向渐变球，功能不受影响。
function Orb({ state }) {
  const canvasRef = useRef(null);
  const orbRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const orb = createOrb(canvasRef.current);
    if (!orb) { setFailed(true); return; }
    orbRef.current = orb;
    orb.setState(state);
    orb.start();
    return () => {
      orbRef.current = null;
      orb.dispose();
    };
  }, []);

  useEffect(() => {
    if (orbRef.current) orbRef.current.setState(state);
  }, [state]);

  if (failed) {
    return html`
      <div
        aria-hidden="true"
        style=${{
          position: 'absolute', inset: '0', borderRadius: '50%',
          background: 'radial-gradient(circle at 34% 28%, #f2ffe9 0%, #c8f8a8 16%, #6fdc7f 38%, #1c9a5a 62%, #075a3a 82%, #03170f 100%)',
          boxShadow: 'inset -10px -14px 26px rgba(0,0,0,.55), inset 7px 9px 20px rgba(255,255,255,.38), 0 10px 24px rgba(0,0,0,.35)'
        }}
      ></div>
    `;
  }
  return html`
    <canvas
      ref=${canvasRef}
      aria-hidden="true"
      style=${{ width: '100%', height: '100%', display: 'block' }}
    ></canvas>
  `;
}

function Msg({ role, text }) {
  const mine = role === 'user';
  return html`
    <div className=${'flex ' + (mine ? 'justify-end' : 'justify-start')}>
      <div
        className=${[
          'max-w-[86%] rounded-[10px] px-2.5 py-1.5 text-[12px] leading-[1.65] whitespace-pre-wrap break-words',
          mine ? 'bg-accent text-onaccent' : 'bg-white/[.05] text-ink'
        ].join(' ')}
      >${text}</div>
    </div>
  `;
}

export function Assistant({ page = false } = {}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [thinking, setThinking] = useState(false);
  // 流式：已收到的 message 前缀（气泡里逐字显示）+ 已等待毫秒数（思考期给进度）
  const [streamText, setStreamText] = useState('');
  const [waitMs, setWaitMs] = useState(0);
  const [msgs, setMsgs] = useState([]);
  const [draft, setDraft] = useState('');
  const [suggested, setSuggested] = useState('');
  // 页面模式（2026-11-16）：整页对话页 / 面板共用同一套状态与接口。
  const visible = page || open;
  const pageScrollRef = useRef(null);
  // 2026-11-19 用户反馈：任务跑着时往上翻聊天记录会被强行弹回底部。
  // 只有「本来就在底部附近」才自动跟随；用户上翻后不再抢滚动。
  const stickToBottomRef = useRef(true);
  // 建议 chips：用户只说时长，场景由场景卡库自动抽取（2026-11-16 用户指正：
  // 长片不围绕某个主题，60–180 段是不同场景，不能演示成主题式长片示例）。
  const PAGE_CHIPS = [
    tr('assistant.chips.quick'),
    tr('assistant.chips.long'),
    tr('assistant.chips.last'),
    tr('assistant.chips.progress')
  ];
  // 批量模式（2026-11-12 用户口径）：不填条数，按「目标时长 ÷ 每段秒数」自动算。
  // 默认 10 分钟 / 10 秒 = 60 条；可切 30 分钟 = 180 条。
  const [batchMinutes, setBatchMinutes] = useState(10);
  const [batchSeconds] = useState(10);
  const batchCount = Math.max(1, Math.round((batchMinutes * 60) / batchSeconds));
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchItems, setBatchItems] = useState(null);
  const [imageFirstBusy, setImageFirstBusy] = useState(false);
  const [pos, setPos] = useState(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.left === 'number' && typeof p.top === 'number') return p;
      }
    } catch { /* 忽略损坏值 */ }
    return null; // 首次：右下角
  });
  const dragRef = useRef(null);
  const inputRef = useRef(null);
  const ballRef = useRef(null);
  const panelRef = useRef(null);
  const [panelPos, setPanelPos] = useState(null);

  const cfg = readLLMConfig();
  const hasKey = !!cfg.llmApiKey;

  // 逐段出图开关 + 「继续生成」提交中标记（2026-11-16 契约 §1/§2.3）。
  // 开关状态跨会话记住；默认开（用户口径是全自动：场景卡 → 首帧图 → 图生视频）。
  const [imagePerClip, setImagePerClip] = useState(readImagePerClip);
  const [reviewBusy, setReviewBusy] = useState(false);
  // 出图后自动调色（2026-11-23 A 方案）：默认值**只**来自服务端 .env（GET /api/image-gen/status），
  // 不写 localStorage；计划卡逐段出图与「图片优先」两个入口共用这一个状态。
  const [imageGrade, setImageGrade] = useState(null);

  // ===== 小智（P5）：计划卡 / 状态机 / 记忆 / 语音 =====
  // 后端是旧进程时（没有 /api/assistant/info），退回原来的「提示词助手」对话，
  // 并在面板里提示「服务端还没重启」，不让新 UI 假装能用。
  const [backend, setBackend] = useState({ checked: false, ok: false, info: null });
  const [sessionId] = useState(() => {
    try {
      let s = sessionStorage.getItem('vs_xiaozhi_session');
      if (!s) {
        const rnd = (window.crypto && typeof window.crypto.randomUUID === 'function')
          ? window.crypto.randomUUID().replace(/-/g, '')
          : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        s = 's_' + rnd;
        sessionStorage.setItem('vs_xiaozhi_session', s);
      }
      return s;
    } catch (e) {
      return 's_' + Date.now().toString(36);
    }
  });
  const [plan, setPlan] = useState(null);
  // ===== 卡片两时点（2026-11-17 小智 2.0 V1 §9.1-5 / Q14=A）=====
  // 共同契约 §0.1：卡片是**确认凭证**，不是聊天伴侣；只在两个时点显示：
  //   ① 首次计划成型（intent=create 且换了新 planId）；
  //   ② 最终确认（intent=confirm，用户问「确认生成吗」）。
  // 中间讨论（换卡 / 看提示词 / 改提示词 / 选配乐）只更新 plan 数据，**不显示卡片**。
  // 刻意不用「plan 存在就渲染」：那样每说一句都会弹一次卡（2026-11-17 用户投诉的原始现象）。
  const [planCardVisible, setPlanCardVisible] = useState(false);
  // 记住上一次「成型」的 planId，用来区分「新计划成型」与「同一计划的数据更新」。
  const lastFormedPlanIdRef = useRef(null);
  const [xstate, setXstate] = useState(null);
  const [xbusy, setXbusy] = useState(false);
  const [greet, setGreet] = useState(() => {
    try { return localStorage.getItem('vs_xiaozhi_greet_dismissed') !== '1'; } catch (e) { return true; }
  });

  // ===== 小智 2.0 V2：播报 / 环境上下文 / 修复与设置确认 =====
  //   · ctx：GET /api/assistant/context 的只读环境（A–E），页面路径由 location 上报；
  //   · diagnosis：/api/assistant/message 返回的失败诊断（B2），有 executable continue 才出按钮；
  //   · pendingChange：B6 设置变更待确认项（changeId + label，10 分钟 TTL）；
  //   · refreshContextRef：对话后/播报后刷新环境卡片（不建任务、不触发付费）。
  const [ctx, setCtx] = useState(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [ctxError, setCtxError] = useState('');
  const [diagnosis, setDiagnosis] = useState(null);
  const [pendingChange, setPendingChange] = useState(null);
  const refreshContextRef = useRef(null);

  // 出图运行态（2026-11-16 契约 §3.1/§3.2）：
  //   · 5 个图片字段与 Key 走 store.readRuntimeConfig()（只读 localStorage，不打印、不上报）；
  //   · 单价**只信** GET /api/assistant/info 的 image.unitCny，拿不到就是 null → 计划卡写「单价未知」，
  //     绝不硬编码（换模型/换价目表会谎报，用户按假数字点确认就是真实扣费）。
  const imageRuntime = readRuntimeConfig('image');
  const imageKeyPresent = !!imageRuntime.imageApiKey;
  const imageUnitCny = (backend.info && backend.info.image) ? backend.info.image.unitCny : null;
  // 服务端是否已有「出图」能力（GET /api/assistant/info 的 image 段，2026-11-16 起）。
  // 旧进程没有这段 → 逐段出图**不会生效**：不暂停、不出图，确认后会按纯文生视频一路跑完
  // （用户以为只是出图费 ¥12，实际直接花掉整条视频的钱）。所以要拦住，不能只警告。
  const imageBackendReady = !!(backend.info && backend.info.image);

  // 能力探测（只读 GET，不产生费用）
  useEffect(() => {
    let alive = true;
    fetch('/api/assistant/info', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        setBackend({ checked: true, ok: !!(j && j.ok), info: j || null });
      })
      .catch(() => { if (alive) setBackend({ checked: true, ok: false, info: null }); });
    return () => { alive = false; };
  }, []);

  // 出图自动调色默认值：只读 GET，不落 localStorage（否则又变成「每人一套」）。
  // 读不到就保持 null，创建任务时由服务端按 .env 默认。
  useEffect(() => {
    let alive = true;
    fetch('/api/image-gen/status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        const def = j && j.imageGrade && j.imageGrade.default;
        if (def === 'off' || def === 'calm') {
          setImageGrade((cur) => (cur === 'off' || cur === 'calm') ? cur : def);
        }
      })
      .catch(() => { /* 旧进程没有该字段：创建时由服务端默认 */ });
    return () => { alive = false; };
  }, []);

  // ===== V2：只读环境上下文（A–E）=====
  // 打开页面 / 路由变化（popstate）/ 对话后 / 播报后各刷一次；只读，不建任务、不触发付费。
  // 上报页面 = location.pathname + location.search（含 /app 前缀），由 contextPageParam 组装。
  useEffect(() => {
    if (!visible || !backend.ok) return undefined;
    let alive = true;
    const load = () => {
      setCtxLoading(true);
      fetchAssistantContext(sessionId, { page: contextPageParam() })
        .then((j) => {
          if (!alive) return;
          if (j && j.ok === true) { setCtx(j); setCtxError(''); }
          else {
            setCtxError(tr('assistant.context.error', {
              error: (j && (j.error || j.code)) || 'HTTP'
            }));
          }
        })
        .catch((e) => {
          if (alive) {
            setCtxError(tr('assistant.context.error', { error: (e && e.message) || String(e) }));
          }
        })
        .finally(() => { if (alive) setCtxLoading(false); });
    };
    refreshContextRef.current = load;
    load();
    const onRoute = () => load();
    window.addEventListener('popstate', onRoute);
    return () => {
      alive = false;
      refreshContextRef.current = null;
      window.removeEventListener('popstate', onRoute);
    };
  }, [visible, backend.ok, sessionId]);

  // ===== V2：任务播报（WS assistantBroadcast）=====
  // 只在此页（page 模式）连；鉴权靠同源 cookie（未登录握手 401，不绕过）。
  // 收到简报 → 追加一条系统消息（正文用服务端 text；客户端不伪造历史），
  // 同时刷新环境卡片；组件卸载时 close()（清定时器 + 断开连接）。
  useEffect(() => {
    if (!page || !backend.ok) return undefined;
    // 2026-11-21：英文界面用小智简报的英文版（服务端按连接语言给 textEn；
    // 这里再按前端当前语言兜一次，切换语言后无需重连也能出英文）。
    const client = connectAssistantBroadcast({
      onBrief: (brief) => {
        let text = '';
        try { text = briefText(brief, getLocale()) || ''; } catch (e) { text = ''; }
        text = String(text || '').trim();
        if (!text) return;
        setMsgs((m) => [...m, { role: 'system', content: text }]);
        if (refreshContextRef.current) refreshContextRef.current();
      }
    });
    return () => { client.close(); };
  }, [page, backend.ok]);

  // 打开面板 / 进入首页时恢复本会话记忆（消息 + 上次计划 + 状态机快照）
  useEffect(() => {
    if (!visible || !backend.ok) return;
    fetch('/api/assistant/memory?sessionId=' + encodeURIComponent(sessionId) + '&limit=30', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || j.ok !== true) return;
        if (Array.isArray(j.messages) && j.messages.length) {
          setMsgs(j.messages.map((m) => ({ role: m.role, content: m.text })));
        }
        // 恢复上次计划只更新数据、不弹卡（卡片只属于「成型」与「最终确认」两个时点）；
        // 刷新后想再看到卡片就说「确认生成吗」。
        if (j.lastPlan) { setPlan(j.lastPlan); setPlanCardVisible(false); }
        if (j.state) {
          fetch('/api/assistant/state?sessionId=' + encodeURIComponent(sessionId)
            + '&planId=' + encodeURIComponent(j.state.planId), { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .then((s) => { if (s && s.ok) setXstate(s); })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [visible, backend.ok]);

  // 页面模式：新消息 / 思考中 / 计划卡出现时自动滚到底部（像微信）；
  // 但用户主动上翻后不再抢滚动（2026-11-19 反馈）。
  useEffect(() => {
    if (!page || !pageScrollRef.current) return;
    if (!stickToBottomRef.current) return;
    const el = pageScrollRef.current;
    el.scrollTop = el.scrollHeight;
  }, [page, msgs.length, thinking, plan, xstate]);

  // 状态机轮询：非终态时每 2 秒刷一次（只读，不触发计费）
  useEffect(() => {
    if (!xstate || !xstate.state) return undefined;
    const terminal = ['done', 'failed', 'needs_user'].includes(xstate.state.state);
    if (terminal) return undefined;
    let alive = true;
    const tick = () => {
      fetch('/api/assistant/state?sessionId=' + encodeURIComponent(sessionId)
        + (plan && plan.planId ? '&planId=' + encodeURIComponent(plan.planId) : ''), { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (alive && j && j.ok) setXstate(j); })
        .catch(() => {});
    };
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [xstate, plan, sessionId]);

  // Esc 关闭（页面模式不需要）
  useEffect(() => {
    if (page || !open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, page]);

  useEffect(() => {
    if (visible && inputRef.current) inputRef.current.focus();
  }, [visible]);

  // 面板贴住球：优先放在球的上方，上方不够就放下方，四周都放不下再贴侧面。
  // 间距固定 6px（原实现为 12~16px，用户反馈「离得太远」）。
  // 位置计算放在 ref 里：拖动球时只重算位置，不反复重建 ResizeObserver。
  const placePanelRef = useRef(null);
  useEffect(() => {
    if (page || !open) { setPanelPos(null); return; }
    let cancelled = false;
    const place = () => {
      if (cancelled) return;
      const ball = ballRef.current;
      const panel = panelRef.current;
      if (!ball || !panel) return;
      const gap = 6;
      const edge = 8;
      // 96px 画布里的液态球只有中间约 63px 是可见的（radius 0.66），
      // 四周是透明留白；按可见球边缘而不是 96px 盒子算间距，
      // 否则看上去会多出 ~16px 的空隙。
      const orbInset = 16;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const b = ball.getBoundingClientRect();
      const pw = panel.offsetWidth || 336;
      const ph = panel.offsetHeight || 460;

      let left = b.right - pw;
      let top = b.top + orbInset - ph - gap;
      if (top < edge) {
        if (b.bottom - orbInset + gap + ph <= vh - edge) {
          top = b.bottom - orbInset + gap;
        } else {
          left = b.right - orbInset + gap;
          if (left + pw > vw - edge) left = b.left + orbInset - pw - gap;
          top = Math.min(Math.max(edge, b.top), Math.max(edge, vh - ph - edge));
        }
      }
      left = Math.min(Math.max(edge, left), Math.max(edge, vw - pw - edge));
      top = Math.min(Math.max(edge, top), Math.max(edge, vh - ph - edge));
      setPanelPos({ left, top });
    };

    placePanelRef.current = place;
    place();
    const raf = requestAnimationFrame(place);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (ro && panelRef.current) ro.observe(panelRef.current);
    window.addEventListener('resize', place);
    return () => {
      cancelled = true;
      placePanelRef.current = null;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, page]);

  // 球被拖动后同步面板位置（仅重算，不重建观察器）。
  useEffect(() => {
    if (open && placePanelRef.current) placePanelRef.current();
  }, [open, pos]);

  // 拖动：pointer 事件，松手后记住位置
  function onPointerDown(e) {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    el.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    d.moved = true;
    const size = 96;
    const left = Math.min(Math.max(8, e.clientX - d.dx), window.innerWidth - size - 8);
    const top = Math.min(Math.max(8, e.clientY - d.dy), window.innerHeight - size - 8);
    setPos({ left, top });
  }
  function onPointerUp(e) {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) {
      setOpen((v) => !v);
      return;
    }
    if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
  }

  // 失败气泡：原因 + 实际请求 + 状态码，一行一条。
  // 抽成函数是因为流式 / 整段返回两条路径都要用同一套格式。
  function failureText(j) {
    const hint = j.error === 'NO_LLM_KEY'
      ? tr('assistant.failure.noLlmKey')
      : (j.message || tr('assistant.failure.noResponse', { error: j.error }));
    // 失败原因一并带进气泡：只说「检查网络或 API Key」会把用户带偏
    // （2026-11-10：真因是地址读错 / 模型名不在中转可用列表，照着这句话白查两轮）
    const lines = ['⚠ ' + hint];
    if (j.hint) lines.push('· ' + j.hint);
    if (j.url) lines.push(tr('assistant.failure.request', { url: j.url }) + (j.model ? tr('assistant.failure.model', { model: j.model }) : ''));
    if (j.status) {
      lines.push(j.detail
        ? tr('assistant.failure.httpDetail', { status: j.status, detail: j.detail })
        : tr('assistant.failure.http', { status: j.status }));
    } else if (j.detail) lines.push(tr('assistant.failure.detail', { detail: j.detail }));
    return lines.join('\n');
  }

  async function send(override) {
    const text = String(override === undefined || override === null ? draft : override).trim();
    if (!text || thinking) return;
    // 用户主动发消息 → 允许重新跟随到底部（否则上翻后永远不跳）。
    stickToBottomRef.current = true;
    const next = [...msgs, { role: 'user', content: text }];
    setMsgs(next);
    setDraft('');
    setSuggested('');
    // 输入框清空后恢复一行高度（页面模式的自适应 textarea）
    if (inputRef.current) inputRef.current.style.height = 'auto';

    // 小智模式：走后端计划卡/记忆（不依赖 LLM Key）
    if (backend.ok) {
      return sendXiaozhi(text);
    }

    if (!hasKey) return;

    setThinking(true);
    setStreamText('');
    setWaitMs(0);
    const startedAt = Date.now();
    const tick = setInterval(() => setWaitMs(Date.now() - startedAt), 200);
    const payload = {
      messages: next.slice(-20),
      llmApiKey: cfg.llmApiKey,
      llmBaseUrl: cfg.llmBaseUrl,
      llmModel: cfg.llmModel
    };

    try {
      // 先请求流式；老后端不认 stream 字段，会照常回整段 JSON，下面自动回退。
      const r = await fetch('/api/assistant/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, stream: true })
      });
      const ctype = r.headers.get('content-type') || '';

      if (r.ok && r.body && ctype.includes('ndjson')) {
        // ---- 流式：思考进度 + 正文逐字出现 ----
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let finalEvt = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let evt = null;
            try { evt = JSON.parse(line); } catch { continue; }
            if (evt.type === 'message' && typeof evt.text === 'string') setStreamText(evt.text);
            else if (evt.type === 'final' || evt.type === 'error') finalEvt = evt;
          }
        }
        setStreamText('');
        if (!finalEvt) {
          setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.streamInterrupted') }]);
        } else if (finalEvt.ok === false) {
          setMsgs((m) => [...m, { role: 'assistant', content: failureText(finalEvt) }]);
        } else {
          setMsgs((m) => [...m, { role: 'assistant', content: finalEvt.message || '' }]);
          if (finalEvt.ready && finalEvt.prompt) setSuggested(finalEvt.prompt);
        }
      } else {
        // ---- 回退：整段返回（旧后端 / 网关不转发流） ----
        const j = await r.json().catch(() => null);
        if (!j) {
          setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.notJson') }]);
        } else if (j.ok === false) {
          setMsgs((m) => [...m, { role: 'assistant', content: failureText(j) }]);
        } else {
          setMsgs((m) => [...m, { role: 'assistant', content: j.message || '' }]);
          if (j.ready && j.prompt) setSuggested(j.prompt);
        }
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.network', { msg: e.message }) }]);
    } finally {
      clearInterval(tick);
      setThinking(false);
      setStreamText('');
    }
  }

  // ===== 小智：对话 / 确认执行 / 首页气泡 =====
  // 对话只调 /api/assistant/message：确定性解析 + 记忆检索，不产生任何费用。
  async function sendXiaozhi(text) {
    setThinking(true);
    setStreamText('');
    try {
      const r = await fetch('/api/assistant/message', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        // 2026-11-19 B 目标：agent 链路需要模型 Key（服务端不持久化 Key，
        // 与 /api/assistant/chat、建任务同口径，每次请求由浏览器带）。
        // 规则路径会忽略这三个字段，零回归。
        body: JSON.stringify({
          sessionId,
          text,
          llmApiKey: cfg.llmApiKey,
          llmBaseUrl: cfg.llmBaseUrl,
          llmModel: cfg.llmModel
        })
      });
      const j = await r.json().catch(() => null);
      if (!j || j.ok !== true) {
        setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.xiaozhiNoResponse', { error: (j && (j.error || j.code)) || ('HTTP ' + r.status) }) }]);
        return;
      }
      setMsgs((m) => [...m, { role: 'assistant', content: j.reply || tr('assistant.noReply') }]);
      // 卡片两时点（2026-11-17 V1 §9.1-5 / Q14=A）：
      //   ① intent=create 且 planId 是新的 → 首次计划成型，弹卡；
      //   ② intent=confirm（用户问「确认生成吗」）→ 最终确认，弹卡；
      //   其余（换卡 / 看提示词 / 改提示词 / 选配乐 / 查进度…）只更新 plan 数据，**不弹卡**。
      const isNewPlan = !!(j.plan && j.plan.planId !== lastFormedPlanIdRef.current);
      const showCard = (j.intent === 'create' && isNewPlan) || j.intent === 'confirm';
      if (j.plan) {
        setPlan(j.plan);
        setXstate(null);
        if (isNewPlan) lastFormedPlanIdRef.current = j.plan.planId;
      }
      setPlanCardVisible(showCard);
      // V2：B6 设置变更待确认 / B2 失败诊断（本次没有就清空，避免残留上一轮的卡片）
      setDiagnosis(j.diagnosis || null);
      setPendingChange(j.pendingChange && j.pendingChange.requiresConfirm === true ? j.pendingChange : null);
      // 对话后刷新只读环境（任务/预算数字跟着变；不建任务、不触发付费）
      if (refreshContextRef.current) refreshContextRef.current();
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.network', { msg: e.message }) }]);
    } finally {
      setThinking(false);
      setStreamText('');
    }
  }

  // V2：只读刷新状态机（继续/修复后立刻拉一次，别等 2 秒轮询）。
  function refreshState() {
    fetch('/api/assistant/state?sessionId=' + encodeURIComponent(sessionId)
      + (plan && plan.planId ? '&planId=' + encodeURIComponent(plan.planId) : ''), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && j.ok) setXstate(j); })
      .catch(() => {});
  }

  // V2：修复 / 设置确认的回执。成功才清掉待确认项并刷新状态与上下文；
  // 失败只追加失败文案（不假装成功）。
  function afterAction(ok, text) {
    if (text) setMsgs((m) => [...m, { role: 'assistant', content: text }]);
    if (!ok) return;
    setPendingChange(null);
    setDiagnosis(null);
    refreshState();
    if (refreshContextRef.current) refreshContextRef.current();
  }

  // 确认执行计划卡：真实模型必须这里点确认（approved=true）；
  // Mock 计划同样走这里，但后端不扣费。
  //
  // 2026-11-16 修 P0：这里必须把「设置」里的运行时 Key 一起发。
  // 服务端 .env 没有 DASHSCOPE_API_KEY 时 src/generators/index.js:79 会**静默降级 Mock**，
  // 用户点了确认却拿到合成画面；补上 runtimeConfig 才会真的走所选模型。
  // 只从 localStorage 读、随请求发送，不打印、不写日志。
  async function confirmPlan() {
    if (!plan || xbusy) return;
    const runtime = readRuntimeConfig(plan.model);
    const hasGenKey = !!(runtime.apiKey || (runtime.klingAccessKey && runtime.klingSecretKey));
    if (plan.model !== 'mock' && !hasGenKey) {
      // 不拦（服务端 .env 也可能配了 Key），但绝不能让「降级 Mock」再无声发生。
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: tr('assistant.warn.noModelKey', { model: plan.modelLabel || plan.model })
      }]);
    }
    // 逐段出图（契约 §1）：开了开关但图片 Key 为空 → 先警告，不拦截。
    // 是否真的能用由后端 IMAGE_GEN_NOT_READY 判定（.env 的 IMAGE_GEN_API_KEY 也可能配了）。
    if (imagePerClip && !runtime.imageApiKey) {
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: tr('assistant.warn.noImageKey')
      }]);
    }
    // 服务端还是旧进程（/api/assistant/info 没有 image 段）：出图开关不会生效。
    // 这里**必须拦住**：不拦的话确认后不会出图、不会暂停审图，会直接按纯文生视频跑完整条任务
    // （用户按「出图 ¥12」的预期点了确认，实际花掉整条视频的钱）。要么重启服务，要么关开关。
    if (imagePerClip && !imageBackendReady) {
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: tr('assistant.warn.oldServerImage')
      }]);
      return;
    }
    setXbusy(true);
    try {
      const r = await fetch('/api/assistant/execute', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        // 服务端白名单：apiKey/apiBaseUrl/modelId/kling*/llm*/multimodal*/image*（server.js:2162）。
        // imagePerClip 显式传（后端判 body.imagePerClip === true）；5 个图片字段随 ...runtime
        // 一起过去 —— readRuntimeConfig 对所有 model 都带这 5 个键（契约 §1）。
        // 注意：`...runtime` 必须紧跟 `approved: true,`（scripts/verify-assistant.js 的静态断言
        // 就认这个形状，也保证运行 Key 一定在请求体里）；imagePerClip 放在 spread 之后，
        // 避免被 runtime 里的同名键覆盖。
        body: JSON.stringify({ sessionId, planId: plan.planId, approved: true, ...runtime, imagePerClip: imagePerClip === true, imageGrade: imageGrade || undefined })
      });
      const j = await r.json().catch(() => null);
      if (!j || j.ok !== true) {
        // 出图未就绪（契约 §3.1 code=IMAGE_GEN_NOT_READY）：把后端 error 原文显示出来，
        // 别压成「HTTP 400」——用户要知道到底是缺 Key、缺地址还是厂商未注册。
        if (j && j.code === 'IMAGE_GEN_NOT_READY') {
          setMsgs((m) => [...m, {
            role: 'assistant',
            content: tr('assistant.warn.imageNotReady', {
              error: j.error || tr('assistant.warn.imageNotReadyFallback')
            })
          }]);
          return;
        }
        setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.generic', { error: (j && (j.error || j.code)) || ('HTTP ' + r.status) }) }]);
        return;
      }
      setMsgs((m) => [...m, { role: 'assistant', content: j.reply || tr('assistant.started') }]);
      setXstate({ ok: true, state: j.state, task: j.taskId ? { taskId: j.taskId, totalClips: 0 } : null });
      // 确认这一刻用过了：收起卡片，避免重复点「确认执行」再建一条任务（防重复计费）。
      setPlanCardVisible(false);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.network', { msg: e.message }) }]);
    } finally {
      setXbusy(false);
    }
  }

  // 计划卡「逐段出图」开关：状态存 localStorage（vs_image_per_clip），即时生效。
  function toggleImagePerClip(on) {
    const next = on !== false;
    setImagePerClip(next);
    writeImagePerClip(next);
  }

  // 计划卡「出图后自动调色」：只影响本次任务（写进 task.imageGrade），**不存默认**、不写 localStorage。
  function toggleImageGrade(on) {
    setImageGrade(on === true ? 'calm' : 'off');
  }

  // 审图暂停的三个动作（契约 §2.3/§2.4：用户点「继续」才结算并开始花视频的钱）。
  function goReview() {
    navigate('/photos');
    if (!page) setOpen(false);
  }

  async function continueAfterReview() {
    const tid = xstate && xstate.task && xstate.task.taskId;
    if (!tid || reviewBusy) return;
    setReviewBusy(true);
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(tid) + '/unpause', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || (j && j.success === false)) {
        setMsgs((m) => [...m, {
          role: 'assistant',
          content: tr('assistant.continue.failed', { error: (j && j.error) || ('HTTP ' + r.status) })
        }]);
        return;
      }
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: tr('assistant.continue.started')
          + (j && j.approvedPhotos ? tr('assistant.continue.approvedPhotos', { n: j.approvedPhotos }) : '')
          + '.'
      }]);
      // 保持轮询：paused → running 仍在非终态集合里，原来的 2s 定时器自己会接着跑；
      // 这里再立刻拉一次，免得状态条最多 2 秒后才更新。
      fetch('/api/assistant/state?sessionId=' + encodeURIComponent(sessionId)
        + (plan && plan.planId ? '&planId=' + encodeURIComponent(plan.planId) : ''), { credentials: 'same-origin' })
        .then((rr) => (rr.ok ? rr.json() : null))
        .then((sj) => { if (sj && sj.ok) setXstate(sj); })
        .catch(() => {});
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.continue.failed', { error: e && e.message ? e.message : e }) }]);
    } finally {
      setReviewBusy(false);
    }
  }

  function dismissGreet() {
    setGreet(false);
    try { localStorage.setItem('vs_xiaozhi_greet_dismissed', '1'); } catch (e) { /* ignore */ }
  }

  function pickGreeting(text) {
    if (!page) setOpen(true);
    send(text);
  }

  function usePrompt() {
    promptBus.setPrompt(suggested);
    navigate('/create');
    if (!page) setOpen(false);
  }

  async function runBatch() {
    if (!hasKey || batchBusy) return;
    setBatchBusy(true);
    setBatchItems(null);
    try {
      const r = await fetch('/api/assistant/batch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: batchCount,
          seconds: batchSeconds,
          llmApiKey: cfg.llmApiKey,
          llmBaseUrl: cfg.llmBaseUrl,
          llmModel: cfg.llmModel
        })
      });
      const j = await r.json().catch(() => null);
      if (!j || j.ok !== true) {
        const why = (j && (j.message || j.error)) || tr('assistant.batch.noJson');
        setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.batch.failed', { why }) }]);
        return;
      }
      const got = (j.items || []).length;
      setBatchItems(j.items || []);
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: tr('assistant.batch.result', { got, total: batchCount, sec: batchSeconds })
          + (got < batchCount ? tr('assistant.batch.missing') : '')
          + tr('assistant.batch.fill')
      }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.failure.network', { msg: e.message }) }]);
    } finally {
      setBatchBusy(false);
    }
  }

  function fillBatch() {
    if (!batchItems || batchItems.length === 0) return;
    promptBus.setPrompt(batchItems.map((x) => x.prompt).join('\n'));
    navigate('/create');
    if (!page) setOpen(false);
  }

  // 一键图片优先：批量出图（逐图调色）→ 提交逐片段图生视频任务。
  // 真实计费，调用前用 confirm 明确数量；失败只报原因，不自动重试。
  async function runImageFirst(items = null) {
    const list = Array.isArray(items) && items.length ? items : batchItems;
    if (!list || list.length === 0 || imageFirstBusy) return;
    let all = {};
    try { all = JSON.parse(localStorage.getItem('vs_config') || '{}'); } catch { all = {}; }
    if (!all.imageKey) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.imageFirst.noImageKey') }]);
      return;
    }
    if (!all.dashScopeKey) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.imageFirst.noDashscopeKey') }]);
      return;
    }
    const dsBase = (all.dashScopeWorkspaceId && all.dashScopeRegion)
      ? `https://${all.dashScopeWorkspaceId}.${all.dashScopeRegion}.maas.aliyuncs.com/api/v1`
      : (all.dashScopeBaseUrl || '');
    const n = list.length;

    // 免费自检：先确认百炼临时上传可用，避免出完图才发现 Key/BaseURL/model 不对。
    setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.imageFirst.uploadCheck') }]);
    try {
      const pr = await fetch('/api/dashscope/upload-check', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: all.dashScopeKey || '', baseUrl: dsBase, model: 'wan3.0-video' })
      });
      const pj = await pr.json().catch(() => null);
      if (!pr.ok || !pj || pj.ok !== true) {
        setMsgs((m) => [...m, {
          role: 'assistant',
          content: tr('assistant.imageFirst.uploadFailed', { error: (pj && pj.error) || ('HTTP ' + pr.status) })
        }]);
        return;
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.imageFirst.uploadNetwork', { msg: e.message || e }) }]);
      return;
    }
    if (!window.confirm(tr('assistant.imageFirst.confirm', { n }))) return;

    setImageFirstBusy(true);
    try {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.imageFirst.generating', { n }) }]);
      const ir = await fetch('/api/images/generate-batch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompts: list.map((x) => x.prompt),
          apiKey: all.imageKey || '',
          baseUrl: all.imageBaseUrl || '',
          provider: all.imageProvider || 'dashscope',
          model: all.imageModel || 'wan2.7-image',
          size: all.imageSize || '1696*960',
          palette: 'calm',
          // 出图后自动调色（A 方案）：与计划卡共用同一状态；未取到默认时由服务端决定。
          imageGrade: imageGrade || undefined,
          taskId: 'imgfirst_' + Date.now().toString(36)
        })
      });
      const ij = await ir.json().catch(() => null);
      if (!ij || ij.ok !== true || !Array.isArray(ij.items) || ij.items.length !== n) {
        const why = (ij && (ij.error || (ij.errors && ij.errors[0] && ij.errors[0].error))) || tr('assistant.imageFirst.incomplete');
        const storageWhy = (ij && ij.storage && ij.storage.reason) ? tr('assistant.imageFirst.storage', { reason: ij.storage.reason }) : '';
        throw new Error(tr('assistant.imageFirst.batchFailed', {
          why,
          storage: storageWhy,
          failed: ij && ij.failed ? tr('assistant.imageFirst.failedCount', { n: ij.failed }) : ''
        }));
      }
      const photoIds = ij.items.map((x) => x.photoId);
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.imageFirst.imagesDone', { n }) }]);

      const tr = await fetch('/api/tasks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompts: list.map((x) => x.prompt),
          photoIds,
          model: 'dashscope',
          resolution: '720p',
          clipDuration: 10,
          preset: 'final',
          autoRetry: false,
          // 同上：写进 task.imageGrade（本次任务内沿用；图片已出，不影响已生成的图）。
          imageGrade: imageGrade || undefined,
          strictQcItems: ['blackFrame', 'duration', 'nsfw'],
          transition: { enabled: true, duration: 0.4, type: 'fade' },
          colorMatch: { enabled: false },
          bgm: { enabled: true, mode: 'auto' },
          apiKey: all.dashScopeKey || '',
          apiBaseUrl: dsBase,
          modelId: 'wan3.0-video',
          llmApiKey: all.llmKey || '',
          llmBaseUrl: all.llmUrl || '',
          llmModel: all.llmModel || '',
          multimodalApiKey: all.multimodalKey || '',
          multimodalBaseUrl: all.multimodalUrl || '',
          multimodalModel: all.multimodalModel || ''
        })
      });
      const tj = await tr.json().catch(() => null);
      if (!tr.ok || !tj || !tj.taskId) throw new Error((tj && tj.error) || tr('assistant.imageFirst.taskFailed'));
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: tr('assistant.imageFirst.submitted', { id: tj.taskId, n })
      }]);
      setBatchItems(null);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: tr('assistant.imageFirst.failed', { msg: e.message || e }) }]);
    } finally {
      setImageFirstBusy(false);
    }
  }

  // 审图暂停（契约 §2.3）：**只有** awaitingImageReview === true 才显示「图已出好」卡片。
  // paused 但 awaitingImageReview 为 false（普通暂停 / 暂停超时）继续走 StateStrip 的既有提示，不抢。
  const reviewTask = (xstate && xstate.task && xstate.task.awaitingImageReview === true) ? xstate.task : null;

  const ballStyle = pos
    ? { left: pos.left + 'px', top: pos.top + 'px' }
    : { right: '24px', bottom: '24px' };

  // 页面模式的自适应输入框：随内容长高，最高 140px
  function growComposer(e) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  // ===== 整页模式（登录后的 `/`，2026-11-16 用户草图）=====
  // 大球 + 介绍卡 + 对话区 + 底部微信式输入框；左侧可收起导航在 screens/assistantPage.js。
  // 有消息后大球缩小、介绍卡收起（CSS .is-compact），消息区滚动，输入框固定底部。
  if (page) {
    const chatting = msgs.length > 0 || !!plan || !!xstate || thinking;
    const canType = backend.ok || hasKey;
    return html`
      <div className="xz-page" data-page="xiaozhi">
        <div className="xz-scroll" ref=${pageScrollRef}
          onScroll=${(e) => {
            const el = e.currentTarget;
            stickToBottomRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
          }}>
          <div className=${'xz-stage' + (chatting ? '' : ' is-empty')}>
            <div className=${'xz-top' + (chatting ? ' is-compact' : '')}>
              <div className="xz-orb-wrap" aria-hidden="true">
                <${Orb} state=${thinking ? 'thinking' : 'idle'} />
              </div>
              <div className="xz-title-block">
                <p className="xz-kicker">${chatting ? tr('assistant.page.kickerChatting') : tr('assistant.page.kickerIdle')}</p>
                <h1 className="xz-title">${tr('assistant.page.title')}</h1>
              </div>
            </div>

            ${!chatting && html`
              <section className="xz-intro" aria-label=${tr('assistant.page.introAria')}>
                <p className="xz-intro-kicker">${tr('assistant.page.introKicker')}</p>
                <h2 className="xz-intro-title">${tr('assistant.page.introTitle')}</h2>
                <div className="xz-chips">
                  ${PAGE_CHIPS.map((c) => html`
                    <button key=${c} type="button" className="xz-chip" onClick=${() => pickGreeting(c)}>${c}</button>
                  `)}
                </div>
              </section>
            `}

            ${backend.checked && !backend.ok && html`
              <div className="xz-warning">
                ${tr('assistant.page.oldServerPrefix')}<code>node scripts/check-server-version.js</code>${tr('assistant.page.oldServerMid')}<code>node app/server.js</code>${tr('assistant.page.oldServerSuffix')}
              </div>
            `}

            ${backend.ok && (ctx || ctxError) && html`
              <div className="xz-block">
                <${AssistantContextCard}
                  ctx=${ctx}
                  loading=${ctxLoading}
                  error=${ctxError}
                  onRefresh=${() => { if (refreshContextRef.current) refreshContextRef.current(); }}
                />
              </div>
            `}

            ${msgs.length > 0 && html`
              <div className="xz-thread">
                ${msgs.map((m, i) => html`
                  <div
                    key=${i}
                    className=${'xz-msg-row ' + (m.role === 'user' ? 'is-user' : 'is-bot')}
                  >
                    <div
                      className=${'xz-bubble ' + (m.role === 'user' ? 'is-user' : 'is-bot')}
                      style=${m.role === 'system' ? SYSTEM_BUBBLE_STYLE : undefined}
                    >${m.content}</div>
                  </div>
                `)}
                ${thinking && html`
                  <div className="xz-msg-row is-bot">
                    <div className="xz-bubble is-bot">${streamText || (tr('assistant.thinking') + (waitMs >= 800 ? tr('assistant.elapsed', { sec: (waitMs / 1000).toFixed(1) }) : ''))}</div>
                  </div>
                `}
              </div>
            `}

            ${reviewTask && html`
              <div className="xz-block">
                <${ImageReviewCard}
                  review=${reviewTask.imageReview}
                  taskId=${reviewTask.taskId}
                  currentStep=${reviewTask.currentStep}
                  busy=${reviewBusy}
                  onGoReview=${goReview}
                  onContinue=${continueAfterReview}
                />
              </div>
            `}

            ${planCardVisible && plan && backend.ok && html`
              <div className="xz-block">
                <${PlanCard}
                  plan=${plan}
                  busy=${xbusy}
                  onConfirm=${confirmPlan}
                  onEdit=${() => { if (inputRef.current) inputRef.current.focus(); }}
                  imagePerClip=${imagePerClip}
                  onToggleImage=${toggleImagePerClip}
                  imageGrade=${imageGrade}
                  onToggleImageGrade=${toggleImageGrade}
                  unitCny=${imageUnitCny}
                  hasImageKey=${imageKeyPresent}
                  imageBackendReady=${imageBackendReady}
                  onSetResolution=${(r) => send(tr('assistant.panel.changeTo', { res: r }))}
                />
              </div>
            `}
            ${xstate && xstate.state && html`
              <div className="xz-block">
                <${StateStrip}
                  state=${xstate.state}
                  task=${xstate.task}
                  onOpenTask=${() => { try { navigate('/gen'); } catch (e) { /* ignore */ } }}
                />
              </div>
            `}

            ${diagnosis && executableRepairs(diagnosis).length > 0 && html`
              <div className="xz-block">
                <${RepairCard}
                  diagnosis=${diagnosis}
                  sessionId=${sessionId}
                  onResult=${afterAction}
                />
              </div>
            `}

            ${pendingChange && html`
              <div className="xz-block">
                <${PendingChangeCard}
                  pendingChange=${pendingChange}
                  sessionId=${sessionId}
                  onResult=${afterAction}
                />
              </div>
            `}

            ${suggested && html`
              <div className="xz-block rounded-[8px] border border-accent/25 bg-accent/[.06] p-3">
                <p className="text-[11px] text-ink3">${tr('assistant.page.suggested')}</p>
                <p className="mt-1 text-[12px] leading-[1.7] text-ink whitespace-pre-wrap break-words">${suggested}</p>
                <button
                  className="mt-2 h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px]"
                  onClick=${usePrompt}
                >${tr('assistant.page.usePrompt')}</button>
              </div>
            `}
          </div>
        </div>

        <div className="xz-composer-wrap">
          <div className="xz-composer">
            <div className="xz-inputbar">
              <${VoiceButton}
                disabled=${!backend.ok}
                onText=${(t) => { setDraft(t); if (inputRef.current) { inputRef.current.focus(); } }}
                onHint=${(msg) => setMsgs((m) => [...m, { role: 'assistant', content: msg }])}
              />
              <textarea
                ref=${inputRef}
                rows="1"
                value=${draft}
                onInput=${(e) => { setDraft(e.target.value); growComposer(e); }}
                onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder=${backend.ok ? tr('assistant.page.placeholderXiaozhi') : (hasKey ? tr('assistant.page.placeholderChat') : tr('assistant.page.placeholderNoKey'))}
                disabled=${!canType}
                aria-label=${tr('assistant.page.inputAria')}
                className="xz-input"
              ></textarea>
              <button
                type="button"
                className="xz-send"
                aria-label=${tr('assistant.page.sendAria')}
                title=${tr('assistant.page.sendAria')}
                onClick=${() => send()}
                disabled=${!canType || thinking || !draft.trim()}
              >↑</button>
            </div>
            <p className="xz-footnote">${tr('assistant.page.footnote')}</p>
          </div>
        </div>
      </div>
    `;
  }

  return html`
    <div
      ref=${ballRef}
      role="button"
      tabIndex="0"
      aria-label=${tr('assistant.float.openAria')}
      title=${tr('assistant.float.title')}
      onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove}
      onPointerUp=${onPointerUp}
      onMouseEnter=${() => setHover(true)}
      onMouseLeave=${() => setHover(false)}
      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
      style=${{
        position: 'fixed',
        width: '96px',
        height: '96px',
        zIndex: 60,
        cursor: 'grab',
        touchAction: 'none',
        transform: (open || hover) ? 'scale(1.06)' : 'scale(1)',
        transition: 'transform .28s cubic-bezier(.34,1.56,.64,1)',
        ...ballStyle
      }}
    >
      <${Orb} state=${thinking ? 'thinking' : 'idle'} />
    </div>

    ${greet && backend.ok && !open && currentRoute() === '/' && msgs.length === 0 && html`
      <${GreetingBubble} onPick=${pickGreeting} onClose=${dismissGreet} />
    `}

    ${open && html`
      <div
        ref=${panelRef}
        role="dialog"
        aria-label=${tr('assistant.panel.aria')}
        style=${{
          position: 'fixed',
          zIndex: 61,
          width: '336px',
          maxHeight: 'min(460px, 72vh)',
          visibility: panelPos ? 'visible' : 'hidden',
          ...(panelPos || { left: '0px', top: '0px' })
        }}
        className="flex flex-col rounded-[10px] border border-white/[.08] bg-s3 shadow-[0_18px_48px_rgba(0,0,0,.16)] overflow-hidden"
      >
        <div className="shrink-0 flex items-center gap-2 px-3 h-10 border-b border-white/[.06]">
          <span className="text-[12px] font-medium text-ink">${tr('assistant.panel.title')}</span>
          <span className="text-[10px] text-ink3">${tr('assistant.panel.sub')}</span>
          <span className="flex-1"></span>
          <button
            className="h-6 px-1.5 rounded-[4px] text-[11px] text-ink2 hover:bg-white/[.05]"
            onClick=${() => setOpen(false)}
          >${tr('assistant.panel.collapse')}</button>
        </div>

        ${backend.checked && !backend.ok && html`
          <div className="shrink-0 px-3 py-2 border-b border-warn/25 bg-warn/[.08]">
            <p className="text-[11px] text-warn">${tr('assistant.page.oldServerWarning')}</p>
            <p className="mt-0.5 text-[10px] leading-[1.5] text-ink3">
              <code className="font-num">node scripts/check-server-version.js</code>${tr('assistant.page.oldServerMid')}<code className="font-num">node server.js</code>${tr('assistant.page.oldServerSuffix')}
            </p>
          </div>
        `}

        <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-white/[.06]">
          <span className="text-[11px] text-ink3">${tr('assistant.panel.batch')}</span>
          <select
            value=${batchMinutes}
            onChange=${(e) => setBatchMinutes(Number(e.target.value) === 30 ? 30 : 10)}
            className="h-6 rounded-[4px] bg-white/[.04] border border-white/[.08] px-1 text-[11px] text-ink outline-none"
          >
            <option value="10">${tr('assistant.panel.minutes10')}</option>
            <option value="30">${tr('assistant.panel.minutes30')}</option>
          </select>
          <span className="text-[11px] text-ink3">${tr('assistant.panel.batchSummary', { n: batchCount, sec: batchSeconds })}</span>
          <span className="flex-1"></span>
          <button
            onClick=${runBatch}
            disabled=${!hasKey || batchBusy}
            className="h-6 px-2 rounded-[4px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          >${batchBusy ? tr('assistant.panel.generating') : tr('assistant.panel.generate')}</button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-2">
          ${!hasKey && !backend.ok && html`
            <div className="rounded-[8px] border border-white/[.08] bg-s2 p-2.5">
              <p className="text-[12px] text-ink">${tr('assistant.panel.noKeyTitle')}</p>
              <p className="mt-1 text-[11px] leading-[1.6] text-ink3">
                ${tr('assistant.panel.noKeyBody')}
              </p>
              <a href="/" className="mt-2 inline-block text-[11px] text-accent underline">${tr('assistant.panel.noKeyLink')}</a>
            </div>
          `}
          ${msgs.length === 0 && backend.ok && html`
            <${Msg} role="assistant" text=${tr('assistant.panel.emptyAssistant')} />
          `}
          ${msgs.length === 0 && !backend.ok && hasKey && html`
            <${Msg} role="assistant" text=${tr('assistant.panel.emptyNoBackend')} />
          `}
          ${msgs.map((m, i) => html`<${Msg} key=${i} role=${m.role} text=${m.content} />`)}
          ${thinking && html`
            <${Msg}
              role="assistant"
              text=${streamText || (tr('assistant.thinking') + (waitMs >= 800 ? tr('assistant.elapsed', { sec: (waitMs / 1000).toFixed(1) }) : ''))}
            />
          `}

          ${reviewTask && html`
            <${ImageReviewCard}
              review=${reviewTask.imageReview}
              taskId=${reviewTask.taskId}
              currentStep=${reviewTask.currentStep}
              busy=${reviewBusy}
              onGoReview=${goReview}
              onContinue=${continueAfterReview}
            />
          `}

          ${planCardVisible && plan && backend.ok && html`
            <${PlanCard}
              plan=${plan}
              busy=${xbusy}
              onConfirm=${confirmPlan}
              onEdit=${() => { if (inputRef.current) inputRef.current.focus(); }}
              imagePerClip=${imagePerClip}
              onToggleImage=${toggleImagePerClip}
              imageGrade=${imageGrade}
              onToggleImageGrade=${toggleImageGrade}
              unitCny=${imageUnitCny}
              hasImageKey=${imageKeyPresent}
              imageBackendReady=${imageBackendReady}
              onSetResolution=${(r) => send(tr('assistant.panel.changeTo', { res: r }))}
            />
          `}
          ${xstate && xstate.state && html`
            <${StateStrip}
              state=${xstate.state}
              task=${xstate.task}
              onOpenTask=${(taskId) => { try { navigate('/gen'); } catch (e) { /* ignore */ } }}
            />
          `}

          ${suggested && html`
            <div className="rounded-[8px] border border-accent/25 bg-accent/[.06] p-2.5">
              <p className="text-[11px] text-ink3">${tr('assistant.page.suggested')}</p>
              <p className="mt-1 text-[12px] leading-[1.7] text-ink whitespace-pre-wrap break-words">${suggested}</p>
              <button
                className="mt-2 h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px]"
                onClick=${usePrompt}
              >${tr('assistant.page.usePrompt')}</button>
            </div>
          `}

          ${batchItems && batchItems.length > 0 && html`
            <div className="rounded-[8px] border border-accent/25 bg-accent/[.06] p-2.5">
              <p className="text-[11px] text-ink3">${tr('assistant.panel.batchGenerated', { n: batchItems.length, sec: batchSeconds })}</p>
              <button
                className="mt-2 h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px]"
                onClick=${fillBatch}
              >${tr('assistant.panel.fillCreate')}</button>
              <button
                className="mt-2 ml-2 h-7 px-2.5 rounded-[5px] border border-accent/40 text-accent text-[11px] disabled:opacity-40"
                onClick=${() => runImageFirst()}
                disabled=${imageFirstBusy}
              >${imageFirstBusy ? tr('assistant.panel.imageFirstBusy') : (imageGrade === 'calm' ? tr('assistant.panel.imageFirstGraded') : tr('assistant.panel.imageFirst'))}</button>
              <button
                className="mt-2 ml-2 h-7 px-2.5 rounded-[5px] border border-white/[.10] text-ink2 text-[11px] disabled:opacity-40"
                onClick=${() => runImageFirst(batchItems.slice(0, 2))}
                disabled=${imageFirstBusy}
              >${tr('assistant.panel.tryTwo')}</button>
              <p className="mt-1.5 text-[10px] leading-[1.6] text-ink3">
                ${tr('assistant.panel.billingNote', { n: batchItems.length })}
              </p>
            </div>
          `}
        </div>

        <div className="shrink-0 flex items-end gap-2 border-t border-white/[.06] p-2">
          <${VoiceButton}
            disabled=${!backend.ok}
            onText=${(t) => { setDraft(t); if (inputRef.current) inputRef.current.focus(); }}
            onHint=${(msg) => setMsgs((m) => [...m, { role: 'assistant', content: msg }])}
          />
          <textarea
            ref=${inputRef}
            rows="1"
            value=${draft}
            onInput=${(e) => setDraft(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder=${backend.ok ? tr('assistant.panel.placeholderXiaozhi') : (hasKey ? tr('assistant.page.placeholderChat') : tr('assistant.page.placeholderNoKey'))}
            disabled=${backend.ok ? false : !hasKey}
            className="flex-1 resize-none bg-transparent outline-none text-[12px] leading-[1.6] text-ink placeholder:text-ink3 px-1 py-1 disabled:opacity-50"
          ></textarea>
          <button
            onClick=${() => send()}
            disabled=${(backend.ok ? false : !hasKey) || thinking || !draft.trim()}
            className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          >${tr('assistant.panel.send')}</button>
        </div>
      </div>
    `}
  `;
}
