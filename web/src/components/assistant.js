// ============================================================
// 提示词助手（悬浮球 + 对话面板）
// ------------------------------------------------------------
// 规格来源：docs/requirements/提示词助手悬浮球-需求.md
// 接口：POST /api/assistant/chat
//   请求 { messages, llmApiKey, llmBaseUrl, llmModel }
//   响应 ok:true → { ready, message, prompt }；ok:false → { error, message }
// ready 只在「模型说完成」且「真的给了非空 prompt」时为真（后端保证）。
// 生成的提示词通过 promptBus 送回创作屏，不直接操作 DOM。
// ============================================================
import { promptBus, readLLMConfig } from '../store.js';
import { navigate } from '../router.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

const POS_KEY = 'vs_assistant_pos';

function Ghost({ state }) {
  // state: idle | hover | think | talk
  const eyes = {
    idle: { rx: 6.2, ry: 7.4, rightRx: 7.0, rightRy: 8.2, dy: 0 },
    hover: { rx: 7.4, ry: 9.0, rightRx: 8.4, rightRy: 10.0, dy: -1 },
    think: { rx: 6.6, ry: 7.0, rightRx: 7.2, rightRy: 5.6, dy: -3.4 },
    talk: { rx: 6.4, ry: 7.6, rightRx: 7.2, rightRy: 8.4, dy: 0 }
  }[state] || { rx: 6.2, ry: 7.4, rightRx: 7.0, rightRy: 8.2, dy: 0 };

  const talking = state === 'talk';

  return html`
    <svg viewBox="0 0 96 96" className="w-full h-full block pointer-events-none" aria-hidden="true">
      <defs>
        <linearGradient id="ghostBody" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor="#FCFDFC" />
          <stop offset="58%" stopColor="#E8EFEA" />
          <stop offset="100%" stopColor="#C9D8CF" />
        </linearGradient>
        <radialGradient id="ghostSheen" cx="0.32" cy="0.24" r="0.55">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>

      <path
        d="M48 9c-19.4 0-32.5 13.6-32.5 32.2v33.4c0 3.4 3.6 5.5 6.6 3.6l8.2-5.3 8.2 5.3 8.2-5.3 8.2 5.3 8.2-5.3 8.2 5.3c3 1.9 6.6-.2 6.6-3.6V41.2C80.5 22.6 67.4 9 48 9z"
        fill="url(#ghostBody)"
        stroke="rgba(12,26,20,.10)"
        strokeWidth="1"
      />
      <path
        d="M48 9c-19.4 0-32.5 13.6-32.5 32.2v33.4c0 3.4 3.6 5.5 6.6 3.6l8.2-5.3 8.2 5.3 8.2-5.3 8.2 5.3 8.2-5.3 8.2 5.3c3 1.9 6.6-.2 6.6-3.6V41.2C80.5 22.6 67.4 9 48 9z"
        fill="url(#ghostSheen)"
      />

      <g transform=${'translate(0 ' + eyes.dy + ')'}>
        <ellipse cx="37" cy="42" rx=${eyes.rx} ry=${eyes.ry} fill="#16241D" />
        <ellipse cx="59" cy="42" rx=${eyes.rightRx} ry=${eyes.rightRy} fill="#16241D" />
        <circle cx="34.8" cy="38.6" r="2.1" fill="#FFFFFF" opacity="0.92" />
        <circle cx="56.6" cy="38.2" r="2.5" fill="#FFFFFF" opacity="0.92" />
      </g>

      ${talking
        ? html`<ellipse cx="48" cy="60" rx="5.4" ry="4.2" fill="#16241D" opacity="0.88" />`
        : html`<path d="M43 60q5 4.6 10 0" stroke="#16241D" strokeWidth="2.2" fill="none" strokeLinecap="round" opacity="0.72" />`}
    </svg>
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

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [thinking, setThinking] = useState(false);
  // 流式：已收到的 message 前缀（气泡里逐字显示）+ 已等待毫秒数（思考期给进度）
  const [streamText, setStreamText] = useState('');
  const [waitMs, setWaitMs] = useState(0);
  const [msgs, setMsgs] = useState([]);
  const [draft, setDraft] = useState('');
  const [suggested, setSuggested] = useState('');
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

  const cfg = readLLMConfig();
  const hasKey = !!cfg.llmApiKey;

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

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

  async function send() {
    const text = draft.trim();
    if (!text || thinking) return;
    const next = [...msgs, { role: 'user', content: text }];
    setMsgs(next);
    setDraft('');
    setSuggested('');

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

  function usePrompt() {
    promptBus.setPrompt(suggested);
    navigate('/');
    setOpen(false);
  }

  const ballStyle = pos
    ? { left: pos.left + 'px', top: pos.top + 'px' }
    : { right: '24px', bottom: '24px' };

  const ghostState = thinking ? 'think' : open ? 'talk' : hover ? 'hover' : 'idle';

  return html`
    <div
      role="button"
      tabIndex="0"
      aria-label="打开提示词助手"
      title="提示词助手"
      onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove}
      onPointerUp=${onPointerUp}
      onMouseEnter=${() => setHover(true)}
      onMouseLeave=${() => setHover(false)}
      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
      style=${{ position: 'fixed', width: '96px', height: '96px', zIndex: 60, cursor: 'grab', touchAction: 'none', ...ballStyle }}
    >
      <${Ghost} state=${ghostState} />
    </div>

    ${open && html`
      <div
        role="dialog"
        aria-label="提示词助手面板"
        style=${{
          position: 'fixed',
          zIndex: 61,
          width: '336px',
          maxHeight: 'min(460px, 72vh)',
          ...(pos
            ? { left: Math.min(pos.left, Math.max(8, window.innerWidth - 344)) + 'px', top: Math.max(8, pos.top - 476) + 'px' }
            : { right: '24px', bottom: '132px' })
        }}
        className="flex flex-col rounded-[10px] border border-white/[.08] bg-s3 shadow-[0_18px_48px_rgba(0,0,0,.16)] overflow-hidden"
      >
        <div className="shrink-0 flex items-center gap-2 px-3 h-10 border-b border-white/[.06]">
          <span className="text-[12px] font-medium text-ink">提示词助手</span>
          <span className="text-[10px] text-ink3">不知道写什么？问我</span>
          <span className="flex-1"></span>
          <button
            className="h-6 px-1.5 rounded-[4px] text-[11px] text-ink2 hover:bg-white/[.05]"
            onClick=${() => setOpen(false)}
          >收起</button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-2">
          ${!hasKey && html`
            <div className="rounded-[8px] border border-white/[.08] bg-s2 p-2.5">
              <p className="text-[12px] text-ink">还没配置 LLM Key</p>
              <p className="mt-1 text-[11px] leading-[1.6] text-ink3">
                先去旧版设置页填好 Key，再回来这里就能对话了。
              </p>
              <a href="/" className="mt-2 inline-block text-[11px] text-accent underline">去旧版设置</a>
            </div>
          `}
          ${msgs.length === 0 && hasKey && html`
            <${Msg} role="assistant" text="说说你想拍什么？比如「极光」「喀斯特晨雾」。我会一次问一个问题，帮你收敛成一条可直接生成的提示词。" />
          `}
          ${msgs.map((m, i) => html`<${Msg} key=${i} role=${m.role} text=${m.content} />`)}
          ${thinking && html`
            <${Msg}
              role="assistant"
              text=${streamText || ('正在想…' + (waitMs >= 800 ? '（已 ' + (waitMs / 1000).toFixed(1) + 's）' : ''))}
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
        </div>

        <div className="shrink-0 flex items-end gap-2 border-t border-white/[.06] p-2">
          <textarea
            ref=${inputRef}
            rows="1"
            value=${draft}
            onInput=${(e) => setDraft(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder=${hasKey ? '说说你想拍什么…' : '先配置 LLM Key'}
            disabled=${!hasKey}
            className="flex-1 resize-none bg-transparent outline-none text-[12px] leading-[1.6] text-ink placeholder:text-ink3 px-1 py-1 disabled:opacity-50"
          ></textarea>
          <button
            onClick=${send}
            disabled=${!hasKey || thinking || !draft.trim()}
            className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          >发送</button>
        </div>
      </div>
    `}
  `;
}
