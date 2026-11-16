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
//   2026-11-16 用户口径：计划卡按「时长 + 场景卡库自动抽取」展示，不把长片说成单一主题；
//   themeLabel 只在调用方显式给主题时出现（正常对话为空）。
//   状态   state = { state, label, taskId, retries, retryAllowed, fills, fillAllowed, reason, events[] }
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

const money = (n) => (Number(n) > 0 ? `¥${Number(n).toFixed(2)}` : '¥0');

// 出图计费提示：单价**只能**来自 GET /api/assistant/info 的 image.unitCny
// （后端 pricing.computeImageCost 的 unitPrice，元/张）。拿不到就写「单价未知」，
// **禁止硬编码单价**——换模型/换价目表时会谎报，用户按假数字点确认真实扣费。
function imageBillingText(plan, unitCny) {
  const n = Math.max(0, Math.floor(Number(plan && plan.clipCount) || 0));
  const unit = Number(unitCny);
  if (Number.isFinite(unit) && unit > 0) {
    return `出图 ${n} 张 × ${money(unit)} ≈ ${money(unit * n)}`
      + '（图片真实计费，视频费用见「预估费用」；单价来自 /api/assistant/info）';
  }
  return `出图 ${n} 张 · 单价未知（服务端未返回 image.unitCny：先到「设置 → 图片生成」配好模型，`
    + '或写 app/.env 的 IMAGE_GEN_MODEL 后重启服务）';
}

// 2026-11-16 契约 §0/§1：全自动链路 = 场景卡 → 逐段出图 → 图生视频；出图后整批停一次审图。
// 开关默认开启（用户口径「全自动」），状态由调用方存 localStorage（vs_image_per_clip）。
export function PlanCard({ plan, busy, onConfirm, onEdit, imagePerClip, onToggleImage, unitCny, hasImageKey }) {
  if (!plan) return null;
  const est = plan.estimate || {};
  const imgOn = imagePerClip !== false;
  const rows = [
    ['时长', `${Number(plan.totalMinutes).toFixed(2)} 分钟 = ${plan.clipCount} 段 × ${plan.clipDurationSec} 秒`],
    ...(plan.themeLabel ? [['主题', plan.themeLabel]] : []),
    ['模型', `${plan.modelLabel || plan.model} · ${plan.resolution}`],
    plan.sceneCards
      ? ['场景', `场景卡库自动抽取 ${plan.clipCount} 个不同场景（按章节顺序，不重复）`]
      : ['场景', '自由提示词（已关闭场景卡）'],
    ['出图', imgOn ? `逐段 ${plan.clipCount} 张 → 图生视频` : '关（纯文生视频）'],
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

      <div className="mt-1.5 rounded-[6px] border border-white/[.08] bg-white/[.03] px-2 py-1.5">
        <label className="flex items-start gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked=${imgOn}
            disabled=${!!busy}
            onChange=${(e) => onToggleImage && onToggleImage(e.target.checked)}
            className="mt-[2px] w-[15px] h-[15px] shrink-0 accent-accent"
          />
          <span className="text-[11px] leading-[1.6] text-ink">
            逐段出图<span className="text-ink3">（场景卡 → 首帧图 → 图生视频）</span>
          </span>
        </label>
        ${imgOn ? html`
          <p className="mt-1 text-[10px] leading-[1.6] text-ink3">${imageBillingText(plan, unitCny)}</p>
          <p className="mt-0.5 text-[10px] leading-[1.6] text-warn">
            出图完成后整批暂停，等你审图后再点继续（不点就不会花视频的钱）。
          </p>
          ${!hasImageKey && html`
            <p className="mt-0.5 text-[10px] leading-[1.6] text-warn">
              设置里没有「图片生成」的 Key：现在确认会返回「出图未就绪」，不建任务、不扣费。
            </p>
          `}
        ` : html`
          <p className="mt-1 text-[10px] leading-[1.6] text-ink3">
            纯文生视频（旧链路，不出图；行为与之前完全一致）。
          </p>
        `}
      </div>

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
  // 审图暂停单独一态：task.awaitingImageReview===true 时不能说「生成中」，
  // 也不能让它跟普通暂停（failureCode=pause_*）混在一起。
  const awaiting = !!(task && task.awaitingImageReview === true);
  const tone = awaiting ? 'text-warn' : (STATE_TONE[state.state] || 'text-ink2');
  const parts = [];
  if (state.retryAllowed !== undefined) parts.push(`重试 ${state.retries || 0}/${state.retryAllowed}`);
  if (state.fillAllowed !== undefined) parts.push(`补位 ${state.fills || 0}/${state.fillAllowed}`);
  if (task && task.totalClips) parts.push(`片段 ${task.successClips || 0}/${task.totalClips}`);
  return html`
    <div className="rounded-[8px] border border-white/[.08] bg-white/[.03] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className=${'text-[11px] font-medium ' + tone}>${awaiting ? '等待审图' : (state.label || state.state)}</span>
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

// ============================================================
// 「图已出好」卡片（2026-11-16 契约 §1/§2.3/§2.4）
// ------------------------------------------------------------
// 只在 task.awaitingImageReview === true 时由调用方渲染：此时任务 paused、
// 图已逐段出好但还没开始花视频的钱。数据来自 supervisor.taskView() 的
// task.imageReview = { total, generated, reused, failed, reviewedAt,
//                       pendingPhotos, approvedPhotos, rejectedPhotos }（三个计数现算）。
// 纯展示：请求（unpause）/路由跳转都在 components/assistant.js，本文件不发请求。
// ============================================================
export function ImageReviewCard({ review, taskId, currentStep, busy, onGoReview, onContinue }) {
  const rv = review || {};
  const total = Math.max(0, Math.floor(Number(rv.total) || 0));
  const generated = Math.max(0, Math.floor(Number(rv.generated) || 0));
  const failed = Math.max(0, Math.floor(Number(rv.failed) || 0));
  // pendingPhotos 由后端按 photoLibrary 现算；字段缺失/非数字时按「已出的都还没审」展示，
  // 不能默认 0（那会谎报「全部审完」）。
  const pendingRaw = Number(rv.pendingPhotos);
  const pending = Number.isFinite(pendingRaw) ? Math.max(0, Math.floor(pendingRaw)) : generated;
  return html`
    <div className="rounded-[8px] border border-accent/40 bg-accent/[.08] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-accent">图已出好</span>
        <span className="text-[10px] text-ink3">已暂停，等你审图</span>
        <span className="flex-1"></span>
        ${taskId && html`<span className="text-[10px] text-ink3 font-num truncate">${taskId}</span>`}
      </div>
      <p className="mt-1 text-[11px] leading-[1.6] text-ink">
        共 ${total} 段 · 出图 ${generated} 张${failed > 0 ? `（失败 ${failed} 张）` : ''} · 待审 ${pending} 张
      </p>
      ${currentStep && html`<p className="mt-0.5 text-[10px] leading-[1.6] text-ink3">${currentStep}</p>`}
      <p className="mt-1 text-[10px] leading-[1.6] text-ink3">
        到「库 · 图片」抽看 / 通过 / 打回；点「继续生成」才开始花视频的钱（未单独审核的按通过处理）。
      </p>
      ${failed > 0 && html`
        <p className="mt-1 text-[10px] leading-[1.6] text-warn">
          有 ${failed} 张没出成：可以先回图片库重出，或直接继续（这些片段会判失败，不会降级成文生视频）。
        </p>
      `}
      <div className="mt-1.5 flex items-center gap-2">
        <button
          className="h-7 px-2.5 rounded-[5px] border border-accent/40 text-accent text-[11px] hover:bg-accent/[.08]"
          onClick=${() => onGoReview && onGoReview()}
        >去审图</button>
        <button
          className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          disabled=${!!busy}
          onClick=${() => onContinue && onContinue()}
        >${busy ? '继续中…' : '继续生成'}</button>
      </div>
    </div>
  `;
}

// 首页气泡：在创作页给一个「我是小智」的引导气泡；可关，关一次不再打扰。
export function GreetingBubble({ onPick, onClose, bottom = 136 }) {
  const chips = ['10 分钟的长视频', '上一次的视频', '现在进度怎样'];
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
            说个总时长，我来排计划，比如「10 分钟」。
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
