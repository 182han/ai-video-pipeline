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
import { promptBus, readLLMConfig } from '../store.js';
import { navigate, currentRoute } from '../router.js';
import { createOrb } from './assistantOrb.js';
import { PlanCard, StateStrip, GreetingBubble, VoiceButton } from './xiaozhiPlan.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

const POS_KEY = 'vs_assistant_pos';

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
  // 建议 chips：长视频通常是多主题混合，不能演示成「10 分钟全是极光」（用户 2026-11-16 指正）
  const PAGE_CHIPS = ['30 分钟的雪山、星空和极光', '上一次的视频', '现在进度怎样'];
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
  const [xstate, setXstate] = useState(null);
  const [xbusy, setXbusy] = useState(false);
  const [greet, setGreet] = useState(() => {
    try { return localStorage.getItem('vs_xiaozhi_greet_dismissed') !== '1'; } catch (e) { return true; }
  });

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
        if (j.lastPlan) setPlan(j.lastPlan);
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

  // 页面模式：新消息 / 思考中 / 计划卡出现时自动滚到底部（像微信）
  useEffect(() => {
    if (!page || !pageScrollRef.current) return;
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
      ? '还没配置 LLM Key，请先去设置页填好'
      : (j.message || ('助手没有响应（' + j.error + '）'));
    // 失败原因一并带进气泡：只说「检查网络或 API Key」会把用户带偏
    // （2026-11-10：真因是地址读错 / 模型名不在中转可用列表，照着这句话白查两轮）
    const lines = ['⚠ ' + hint];
    if (j.hint) lines.push('· ' + j.hint);
    if (j.url) lines.push('· 实际请求 ' + j.url + (j.model ? '（模型 ' + j.model + '）' : ''));
    if (j.status) lines.push('· HTTP ' + j.status + (j.detail ? '：' + j.detail : ''));
    else if (j.detail) lines.push('· ' + j.detail);
    return lines.join('\n');
  }

  async function send(override) {
    const text = String(override === undefined || override === null ? draft : override).trim();
    if (!text || thinking) return;
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
          setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 流式回复中断了，请重试' }]);
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
          setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 返回不是 JSON，请重试' }]);
        } else if (j.ok === false) {
          setMsgs((m) => [...m, { role: 'assistant', content: failureText(j) }]);
        } else {
          setMsgs((m) => [...m, { role: 'assistant', content: j.message || '' }]);
          if (j.ready && j.prompt) setSuggested(j.prompt);
        }
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 网络异常：' + e.message }]);
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
        body: JSON.stringify({ sessionId, text })
      });
      const j = await r.json().catch(() => null);
      if (!j || j.ok !== true) {
        setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 小智没响应：' + ((j && (j.error || j.code)) || ('HTTP ' + r.status)) }]);
        return;
      }
      setMsgs((m) => [...m, { role: 'assistant', content: j.reply || '（没有回复）' }]);
      if (j.plan) {
        setPlan(j.plan);
        setXstate(null);
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 网络异常：' + e.message }]);
    } finally {
      setThinking(false);
      setStreamText('');
    }
  }

  // 确认执行计划卡：真实模型必须这里点确认（approved=true）；
  // Mock 计划同样走这里，但后端不扣费。
  async function confirmPlan() {
    if (!plan || xbusy) return;
    setXbusy(true);
    try {
      const r = await fetch('/api/assistant/execute', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, planId: plan.planId, approved: true })
      });
      const j = await r.json().catch(() => null);
      if (!j || j.ok !== true) {
        setMsgs((m) => [...m, { role: 'assistant', content: '⚠ ' + ((j && (j.error || j.code)) || ('HTTP ' + r.status)) }]);
        return;
      }
      setMsgs((m) => [...m, { role: 'assistant', content: j.reply || '已开始。' }]);
      setXstate({ ok: true, state: j.state, task: j.taskId ? { taskId: j.taskId, totalClips: 0 } : null });
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 网络异常：' + e.message }]);
    } finally {
      setXbusy(false);
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
        const why = (j && (j.message || j.error)) || '返回不是 JSON';
        setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 批量生成失败：' + why }]);
        return;
      }
      const got = (j.items || []).length;
      setBatchItems(j.items || []);
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: `已生成 ${got}/${batchCount} 条不同地貌的提示词（${batchSeconds} 秒/条）`
          + (got < batchCount ? '，有缺条（已标警告），可以再点一次补' : '')
          + '。点下面的「填入创作页」。'
      }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 网络异常：' + e.message }]);
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
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 还没填图片生成 Key（设置 → 图片生成）。' }]);
      return;
    }
    if (!all.dashScopeKey) {
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 还没填 DashScope Key（图生视频要用它）。' }]);
      return;
    }
    const dsBase = (all.dashScopeWorkspaceId && all.dashScopeRegion)
      ? `https://${all.dashScopeWorkspaceId}.${all.dashScopeRegion}.maas.aliyuncs.com/api/v1`
      : (all.dashScopeBaseUrl || '');
    const n = list.length;

    // 免费自检：先确认百炼临时上传可用，避免出完图才发现 Key/BaseURL/model 不对。
    setMsgs((m) => [...m, { role: 'assistant', content: '正在检查百炼临时上传（免费，不上传文件）…' }]);
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
          content: '⚠ 百炼临时上传自检失败：' + ((pj && pj.error) || ('HTTP ' + pr.status))
            + '\n（没有生成任何图片，不产生费用）'
        }]);
        return;
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 百炼临时上传自检网络异常：' + (e.message || e) }]);
      return;
    }
    if (!window.confirm(`将生成 ${n} 张图（逐图调色）+ ${n} 段视频。这会真实计费，继续？`)) return;

    setImageFirstBusy(true);
    try {
      setMsgs((m) => [...m, { role: 'assistant', content: `正在批量出图 ${n} 张（逐图调色）…` }]);
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
          taskId: 'imgfirst_' + Date.now().toString(36)
        })
      });
      const ij = await ir.json().catch(() => null);
      if (!ij || ij.ok !== true || !Array.isArray(ij.items) || ij.items.length !== n) {
        const why = (ij && (ij.error || (ij.errors && ij.errors[0] && ij.errors[0].error))) || '返回不完整';
        const storageWhy = (ij && ij.storage && ij.storage.reason) ? `（${ij.storage.reason}）` : '';
        throw new Error('批量出图失败：' + why + storageWhy + (ij && ij.failed ? `（失败 ${ij.failed} 张）` : ''));
      }
      const photoIds = ij.items.map((x) => x.photoId);
      setMsgs((m) => [...m, { role: 'assistant', content: `出图完成 ${n} 张，正在提交视频任务…` }]);

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
      if (!tr.ok || !tj || !tj.taskId) throw new Error((tj && tj.error) || '任务提交失败');
      setMsgs((m) => [...m, {
        role: 'assistant',
        content: `任务已提交：${tj.taskId}（${n} 段，逐片段图生视频）。可在「库 · 成片」查看进度。`
      }]);
      setBatchItems(null);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: '⚠ 图片优先失败：' + (e.message || e) }]);
    } finally {
      setImageFirstBusy(false);
    }
  }

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
        <div className="xz-scroll" ref=${pageScrollRef}>
          <div className=${'xz-stage' + (chatting ? '' : ' is-empty')}>
            <div className=${'xz-top' + (chatting ? ' is-compact' : '')}>
              <div className="xz-orb-wrap" aria-hidden="true">
                <${Orb} state=${thinking ? 'thinking' : 'idle'} />
              </div>
              <div className="xz-title-block">
                <p className="xz-kicker">${chatting ? '管家 · 你说我做' : 'XIAOZHI · VIDEO STUDIO'}</p>
                <h1 className="xz-title">小智</h1>
              </div>
            </div>

            ${!chatting && html`
              <section className="xz-intro" aria-label="小智介绍">
                <p className="xz-intro-kicker">你的视频管家</p>
                <h2 className="xz-intro-title">我是小智，告诉我视频多长、想拍哪些景色，我来排计划并自动完成。</h2>
                <p className="xz-intro-sub">
                  比如「30 分钟的雪山、星空和极光」。我会先给你一张计划卡，确认后才开始执行；涉及付费的调用一定先问你。
                </p>
                <div className="xz-chips">
                  ${PAGE_CHIPS.map((c) => html`
                    <button key=${c} type="button" className="xz-chip" onClick=${() => pickGreeting(c)}>${c}</button>
                  `)}
                </div>
              </section>
            `}

            ${backend.checked && !backend.ok && html`
              <div className="xz-warning">
                服务端还是旧进程：计划卡 / 语音暂不可用。确认代码：<code>node scripts/check-server-version.js</code>；
                重启：<code>node app/server.js</code>（单实例 3001）。
              </div>
            `}

            ${msgs.length > 0 && html`
              <div className="xz-thread">
                ${msgs.map((m, i) => html`
                  <div
                    key=${i}
                    className=${'xz-msg-row ' + (m.role === 'user' ? 'is-user' : 'is-bot')}
                  >
                    <div className=${'xz-bubble ' + (m.role === 'user' ? 'is-user' : 'is-bot')}>${m.content}</div>
                  </div>
                `)}
                ${thinking && html`
                  <div className="xz-msg-row is-bot">
                    <div className="xz-bubble is-bot">${streamText || ('正在想…' + (waitMs >= 800 ? '（已 ' + (waitMs / 1000).toFixed(1) + 's）' : ''))}</div>
                  </div>
                `}
              </div>
            `}

            ${plan && backend.ok && html`
              <div className="xz-block">
                <${PlanCard}
                  plan=${plan}
                  busy=${xbusy}
                  onConfirm=${confirmPlan}
                  onEdit=${() => { if (inputRef.current) inputRef.current.focus(); }}
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

            ${suggested && html`
              <div className="xz-block rounded-[8px] border border-accent/25 bg-accent/[.06] p-3">
                <p className="text-[11px] text-ink3">建议提示词</p>
                <p className="mt-1 text-[12px] leading-[1.7] text-ink whitespace-pre-wrap break-words">${suggested}</p>
                <button
                  className="mt-2 h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px]"
                  onClick=${usePrompt}
                >使用这段提示词</button>
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
                placeholder=${backend.ok ? '说总时长和想拍的景色，比如「30 分钟的雪山和星空」…' : (hasKey ? '说说你想拍什么…' : '先配置 LLM Key')}
                disabled=${!canType}
                aria-label="给小智发消息"
                className="xz-input"
              ></textarea>
              <button
                type="button"
                className="xz-send"
                aria-label="发送"
                title="发送"
                onClick=${() => send()}
                disabled=${!canType || thinking || !draft.trim()}
              >↑</button>
            </div>
            <p className="xz-footnote">小智会先给计划卡，确认后才开始执行 · 付费调用需你确认</p>
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
      aria-label="打开小智"
      title="小智"
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
        aria-label="小智面板"
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
          <span className="text-[12px] font-medium text-ink">小智</span>
          <span className="text-[10px] text-ink3">管家 · 你说我做</span>
          <span className="flex-1"></span>
          <button
            className="h-6 px-1.5 rounded-[4px] text-[11px] text-ink2 hover:bg-white/[.05]"
            onClick=${() => setOpen(false)}
          >收起</button>
        </div>

        ${backend.checked && !backend.ok && html`
          <div className="shrink-0 px-3 py-2 border-b border-warn/25 bg-warn/[.08]">
            <p className="text-[11px] text-warn">服务端还是旧进程：计划卡 / 语音暂不可用。</p>
            <p className="mt-0.5 text-[10px] leading-[1.5] text-ink3">
              确认代码：<code className="font-num">node scripts/check-server-version.js</code>；重启：<code className="font-num">node server.js</code>（单实例 3001）。
            </p>
          </div>
        `}

        <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-white/[.06]">
          <span className="text-[11px] text-ink3">批量</span>
          <select
            value=${batchMinutes}
            onChange=${(e) => setBatchMinutes(Number(e.target.value) === 30 ? 30 : 10)}
            className="h-6 rounded-[4px] bg-white/[.04] border border-white/[.08] px-1 text-[11px] text-ink outline-none"
          >
            <option value="10">10 分钟</option>
            <option value="30">30 分钟</option>
          </select>
          <span className="text-[11px] text-ink3">= ${batchCount} 条 × ${batchSeconds}s</span>
          <span className="flex-1"></span>
          <button
            onClick=${runBatch}
            disabled=${!hasKey || batchBusy}
            className="h-6 px-2 rounded-[4px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          >${batchBusy ? '生成中…' : '生成'}</button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-2">
          ${!hasKey && !backend.ok && html`
            <div className="rounded-[8px] border border-white/[.08] bg-s2 p-2.5">
              <p className="text-[12px] text-ink">还没配置 LLM Key</p>
              <p className="mt-1 text-[11px] leading-[1.6] text-ink3">
                先去旧版设置页填好 Key，再回来这里就能对话了。
              </p>
              <a href="/" className="mt-2 inline-block text-[11px] text-accent underline">去旧版设置</a>
            </div>
          `}
          ${msgs.length === 0 && backend.ok && html`
            <${Msg} role="assistant" text=${'我是小智。说个总时长 + 想拍的景色就能排计划，例如「30 分钟的雪山、星空和极光」；也可以问「上一次的视频」或「现在进度怎样」。'} />
          `}
          ${msgs.length === 0 && !backend.ok && hasKey && html`
            <${Msg} role="assistant" text="说说你想拍什么？比如「极光」「喀斯特晨雾」。单条就一次问一个问题；也可以在上面直接批量生成 N 条不同地貌。" />
          `}
          ${msgs.map((m, i) => html`<${Msg} key=${i} role=${m.role} text=${m.content} />`)}
          ${thinking && html`
            <${Msg}
              role="assistant"
              text=${streamText || ('正在想…' + (waitMs >= 800 ? '（已 ' + (waitMs / 1000).toFixed(1) + 's）' : ''))}
            />
          `}

          ${plan && backend.ok && html`
            <${PlanCard}
              plan=${plan}
              busy=${xbusy}
              onConfirm=${confirmPlan}
              onEdit=${() => { if (inputRef.current) inputRef.current.focus(); }}
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
              <p className="text-[11px] text-ink3">建议提示词</p>
              <p className="mt-1 text-[12px] leading-[1.7] text-ink whitespace-pre-wrap break-words">${suggested}</p>
              <button
                className="mt-2 h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px]"
                onClick=${usePrompt}
              >使用这段提示词</button>
            </div>
          `}

          ${batchItems && batchItems.length > 0 && html`
            <div className="rounded-[8px] border border-accent/25 bg-accent/[.06] p-2.5">
              <p className="text-[11px] text-ink3">已生成 ${batchItems.length} 条（${batchSeconds} 秒/条）</p>
              <button
                className="mt-2 h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px]"
                onClick=${fillBatch}
              >填入创作页</button>
              <button
                className="mt-2 ml-2 h-7 px-2.5 rounded-[5px] border border-accent/40 text-accent text-[11px] disabled:opacity-40"
                onClick=${() => runImageFirst()}
                disabled=${imageFirstBusy}
              >${imageFirstBusy ? '执行中…' : '图片优先：出图+调色+图生视频'}</button>
              <button
                className="mt-2 ml-2 h-7 px-2.5 rounded-[5px] border border-white/[.10] text-ink2 text-[11px] disabled:opacity-40"
                onClick=${() => runImageFirst(batchItems.slice(0, 2))}
                disabled=${imageFirstBusy}
              >先试 2 条</button>
              <p className="mt-1.5 text-[10px] leading-[1.6] text-ink3">
                会真实计费：${batchItems.length} 张图 + ${batchItems.length} 段视频；出图后自动通过、逐图调色。
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
            placeholder=${backend.ok ? '说总时长和主题，或问上一次的视频…' : (hasKey ? '说说你想拍什么…' : '先配置 LLM Key')}
            disabled=${backend.ok ? false : !hasKey}
            className="flex-1 resize-none bg-transparent outline-none text-[12px] leading-[1.6] text-ink placeholder:text-ink3 px-1 py-1 disabled:opacity-50"
          ></textarea>
          <button
            onClick=${() => send()}
            disabled=${(backend.ok ? false : !hasKey) || thinking || !draft.trim()}
            className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          >发送</button>
        </div>
      </div>
    `}
  `;
}
