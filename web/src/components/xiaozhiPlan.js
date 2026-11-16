// ============================================================
// 小智 · 计划卡 / 状态条 / 首页气泡 / 按住说话（P5）
// ------------------------------------------------------------
// 与 components/assistant.js 分开的原因：
//   · assistant.js 已有 600+ 行（悬浮球 + 提示词助手 + 批量/出图），继续堆会难维护；
//   · 这里只放纯展示组件与语音录制，不直接发请求，逻辑仍在 assistant.js。
//
// 数据契约（见 server.js /api/assistant/*）：
//   计划卡 plan = { planId, themeLabel, totalMinutes, clipCount, clipDurationSec,
//                   resolution, modelLabel, sceneCards, estimate:{totalCny,retryCapCny,autoQcRetries},
//                   fillMaxClips, requiresPaymentApproval, warnings[] }
//   状态   state = { state, label, taskId, retries, retryAllowed, fills, fillAllowed, reason, events[] }
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

const money = (n) => (Number(n) > 0 ? `¥${Number(n).toFixed(2)}` : '¥0');

export function PlanCard({ plan, busy, onConfirm, onEdit }) {
  if (!plan) return null;
  const est = plan.estimate || {};
  const rows = [
    ['时长', `${Number(plan.totalMinutes).toFixed(2)} 分钟 = ${plan.clipCount} 段 × ${plan.clipDurationSec} 秒`],
    ['主题', plan.themeLabel || '（未指定，按卡库内容出片）'],
    ['模型', `${plan.modelLabel || plan.model} · ${plan.resolution}`],
    ['场景卡', plan.sceneCards ? `${plan.clipCount} 张（chapter+sequence，顺序不重复）` : '关闭（自由提示词）'],
    ['预估费用', `${money(est.totalCny)}${est.autoQcRetries ? `（重试上限 ${money(est.retryCapCny)}，最多 ${est.autoQcRetries} 次）` : '（无重试预算）'}`],
    ['失败补位', `最多 ${plan.fillMaxClips || 0} 段（≤5% 且 ≤10 段）`]
  ];
  return html`
    <div className="rounded-[8px] border border-accent/25 bg-accent/[.06] p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-accent font-medium">小智 · 计划卡</span>
        <span className="text-[10px] text-ink3">${plan.sceneCards ? '场景卡模式' : '自由提示词'}</span>
        <span className="flex-1"></span>
        <button
          className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.05]"
          onClick=${() => onEdit && onEdit()}
        >改一下</button>
      </div>

      <div className="mt-1.5 flex flex-col gap-1">
        ${rows.map(([k, v]) => html`
          <div key=${k} className="flex gap-2 text-[11px] leading-[1.6]">
            <span className="w-[52px] shrink-0 text-ink3">${k}</span>
            <span className="text-ink break-words">${v}</span>
          </div>
        `)}
      </div>

      ${(plan.warnings || []).length > 0 && html`
        <div className="mt-1.5 rounded-[6px] bg-white/[.03] px-2 py-1">
          ${plan.warnings.map((w, i) => html`<p key=${i} className="text-[10px] leading-[1.6] text-warn">注意：${w}</p>`)}
        </div>
      `}

      <div className="mt-2 flex items-center gap-2">
        <button
          className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          disabled=${!!busy}
          onClick=${onConfirm}
        >${busy ? '提交中…' : (plan.requiresPaymentApproval ? `确认执行（${money(est.totalCny)}）` : '确认执行（零计费）')}</button>
        <span className="text-[10px] text-ink3">
          ${plan.requiresPaymentApproval ? '付费任务：确认后才会调用模型' : 'Mock：不产生费用'}
        </span>
      </div>
    </div>
  `;
}

const STATE_TONE = {
  planned: 'text-ink2',
  confirmed: 'text-ink2',
  submitted: 'text-ink2',
  running: 'text-accent',
  retrying: 'text-warn',
  filling: 'text-warn',
  done: 'text-ok',
  failed: 'text-danger',
  needs_user: 'text-warn'
};

export function StateStrip({ state, task, onOpenTask }) {
  if (!state) return null;
  const tone = STATE_TONE[state.state] || 'text-ink2';
  const parts = [];
  if (state.retryAllowed !== undefined) parts.push(`重试 ${state.retries || 0}/${state.retryAllowed}`);
  if (state.fillAllowed !== undefined) parts.push(`补位 ${state.fills || 0}/${state.fillAllowed}`);
  if (task && task.totalClips) parts.push(`片段 ${task.successClips || 0}/${task.totalClips}`);
  return html`
    <div className="rounded-[8px] border border-white/[.08] bg-white/[.03] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className=${'text-[11px] font-medium ' + tone}>${state.label || state.state}</span>
        ${task && task.currentStep && html`<span className="text-[10px] text-ink3 truncate">${task.currentStep}</span>`}
        <span className="flex-1"></span>
        ${task && task.taskId && onOpenTask && html`
          <button
            className="h-5 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.05]"
            onClick=${() => onOpenTask(task.taskId)}
          >详情</button>
        `}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-ink3">
        ${parts.map((p, i) => html`<span key=${i}>${p}</span>`)}
      </div>
      ${state.reason && html`<p className="mt-1 text-[10px] leading-[1.6] text-ink2">${state.reason}</p>`}
    </div>
  `;
}

// 首页气泡：在创作页给一个「我是小智」的引导气泡；可关，关一次不再打扰。
export function GreetingBubble({ onPick, onClose, bottom = 136 }) {
  const chips = ['10 分钟的极光', '上一次的视频', '现在进度怎样'];
  return html`
    <div
      role="status"
      style=${{
        position: 'fixed', right: '118px', bottom: bottom + 'px', zIndex: 59,
        width: '268px'
      }}
      className="rounded-[12px] border border-white/[.10] bg-s3 shadow-[0_16px_40px_rgba(0,0,0,.32)] p-3"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <p className="text-[12px] text-ink font-medium">我是小智</p>
          <p className="mt-1 text-[11px] leading-[1.65] text-ink3">
            说个总时长和想拍的主题，我来排计划；也可以问我「上一次的视频」。
          </p>
        </div>
        <button
          aria-label="关闭小智提示"
          className="h-5 w-5 shrink-0 rounded-[4px] text-[12px] leading-none text-ink3 hover:bg-white/[.06]"
          onClick=${onClose}
        >×</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        ${chips.map((c) => html`
          <button
            key=${c}
            className="h-6 px-2 rounded-[5px] border border-white/[.12] text-[10px] text-ink2 hover:bg-white/[.05]"
            onClick=${() => onPick(c)}
          >${c}</button>
        `)}
      </div>
    </div>
  `;
}

// 按住说话：MediaRecorder → base64 → POST /api/assistant/asr。
// 失败一律回退打字（不阻塞输入框），并把原因写进气泡。
export function VoiceButton({ onText, onHint, disabled }) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recRef = useRef(null);
  const chunksRef = useRef([]);

  function supported() {
    return typeof window.MediaRecorder !== 'undefined'
      && navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  async function start() {
    if (disabled || busy) return;
    if (!supported()) { onHint && onHint('这台浏览器不支持录音，或页面不是 localhost；请改用打字。'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
        ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (!blob.size) { setBusy(false); onHint && onHint('没录到声音，再按一次试试。'); return; }
        setBusy(true);
        try {
          const buf = await blob.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(buf);
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          const r = await fetch('/api/assistant/asr', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: btoa(binary), mime: blob.type || 'audio/webm' })
          });
          const j = await r.json().catch(() => null);
          if (!j || j.ok !== true) {
            onHint && onHint('语音识别失败：' + ((j && (j.error || j.code)) || ('HTTP ' + r.status)) + '，请改用打字。');
          } else if (!j.text) {
            onHint && onHint('没听清，再按一次试试。');
          } else {
            onText && onText(j.text);
          }
        } catch (e) {
          onHint && onHint('语音上传异常：' + (e && e.message ? e.message : e) + '，请改用打字。');
        } finally {
          setBusy(false);
        }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setRecording(false);
      onHint && onHint('拿不到麦克风权限：' + (e && e.message ? e.message : e) + '；请改用打字。');
    }
  }

  function stop() {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch (e) { /* ignore */ }
    }
  }

  return html`
    <button
      type="button"
      aria-label="按住说话"
      title=${disabled ? '服务端未重启，语音暂不可用' : (recording ? '松开结束' : '按住说话')}
      disabled=${disabled || busy}
      onPointerDown=${(e) => { e.preventDefault(); start(); }}
      onPointerUp=${(e) => { e.preventDefault(); stop(); }}
      onPointerLeave=${() => { if (recording) stop(); }}
      onContextMenu=${(e) => e.preventDefault()}
      className=${[
        'h-7 w-7 shrink-0 rounded-[5px] border text-[13px] leading-none',
        recording ? 'border-danger/50 text-danger bg-danger/[.08]' : 'border-white/[.12] text-ink2 hover:bg-white/[.05]',
        (disabled || busy) ? 'opacity-40' : ''
      ].join(' ')}
    >${busy ? '…' : (recording ? '●' : '🎙')}</button>
  `;
}
