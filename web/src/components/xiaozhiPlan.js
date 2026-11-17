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
import { t as tr } from '../i18n/index.js';

const money = (n) => (Number(n) > 0 ? `¥${Number(n).toFixed(2)}` : '¥0');

// 出图计费提示：单价**只能**来自 GET /api/assistant/info 的 image.unitCny
// （后端 pricing.computeImageCost 的 unitPrice，元/张）。拿不到就写「单价未知」，
// **禁止硬编码单价**——换模型/换价目表时会谎报，用户按假数字点确认真实扣费。
function imageBillingText(plan, unitCny) {
  const n = Math.max(0, Math.floor(Number(plan && plan.clipCount) || 0));
  const unit = Number(unitCny);
  if (Number.isFinite(unit) && unit > 0) {
    return tr('xiaozhi.plan.billingUnit', { n, unit: money(unit), total: money(unit * n) });
  }
  return tr('xiaozhi.plan.billingUnknown', { n });
}

// 2026-11-16 契约 §0/§1：全自动链路 = 场景卡 → 逐段出图 → 图生视频；出图后整批停一次审图。
// 开关默认开启（用户口径「全自动」），状态由调用方存 localStorage（vs_image_per_clip）。
export function PlanCard({ plan, busy, onConfirm, onEdit, imagePerClip, onToggleImage, unitCny, hasImageKey, imageBackendReady, onSetResolution }) {
  if (!plan) return null;
  const est = plan.estimate || {};
  const imgOn = imagePerClip === true;
  const totalSec = Math.round(Number(plan.totalSec) || 0);
  const mins = Number(plan.totalMinutes);
  // 不到 1 分钟按秒显示（2026-11-16 支持「30 秒」这类短视频/快速验证）
  const durText = (Number.isFinite(mins) && mins >= 1)
    ? tr('xiaozhi.plan.durMinutes', { mins: mins.toFixed(2), clips: plan.clipCount, sec: plan.clipDurationSec })
    : tr('xiaozhi.plan.durSeconds', { sec: totalSec, clips: plan.clipCount, sec: plan.clipDurationSec });
  const rows = [
    [tr('xiaozhi.plan.duration'), durText],
    ...(plan.themeLabel ? [[tr('xiaozhi.plan.theme'), plan.themeLabel]] : []),
    [tr('xiaozhi.plan.model'), plan.modelLabel || plan.model],
    [tr('xiaozhi.plan.resolution'), tr('xiaozhi.plan.resolutionEditable', { res: plan.resolution })],
    plan.sceneCards
      ? [tr('xiaozhi.plan.scene'), tr('xiaozhi.plan.sceneAuto', { n: plan.clipCount })]
      : [tr('xiaozhi.plan.scene'), tr('xiaozhi.plan.sceneOff')],
    [tr('xiaozhi.plan.image'), imgOn ? tr('xiaozhi.plan.imageOn', { n: plan.clipCount }) : tr('xiaozhi.plan.imageOff')],
    [tr('xiaozhi.plan.cost'), `${money(est.totalCny)}${est.autoQcRetries
      ? tr('xiaozhi.plan.costRetry', { cap: money(est.retryCapCny), n: est.autoQcRetries })
      : tr('xiaozhi.plan.costNoRetry')}`],
    [tr('xiaozhi.plan.fill'), tr('xiaozhi.plan.fillMax', { n: plan.fillMaxClips || 0 })]
  ];
  return html`
    <div className="rounded-[8px] border border-accent/25 bg-accent/[.06] p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-accent font-medium">${tr('xiaozhi.plan.cardTitle')}</span>
        <span className="text-[10px] text-ink3">${plan.sceneCards ? tr('xiaozhi.plan.sceneMode') : tr('xiaozhi.plan.freePrompt')}</span>
        <span className="flex-1"></span>
        <button
          className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.05]"
          onClick=${() => onEdit && onEdit()}
        >${tr('xiaozhi.plan.edit')}</button>
      </div>

      <div className="mt-1.5 flex flex-col gap-1">
        ${rows.map(([k, v]) => html`
          <div key=${k} className="flex gap-2 text-[11px] leading-[1.6]">
            <span className="w-[52px] shrink-0 text-ink3">${k}</span>
            <span className="text-ink break-words">${v}</span>
          </div>
        `)}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-ink3">${tr('xiaozhi.plan.resPickLabel')}</span>
        ${['480p', '720p', '1080p'].map((r) => html`
          <button key=${'res-' + r}
            className=${'h-6 px-2 rounded-[4px] text-[10px] border ' + (plan.resolution === r ? 'border-accent text-accent bg-accent/[.08]' : 'border-white/[.08] text-ink2 hover:bg-white/[.05]')}
            onClick=${() => onSetResolution && onSetResolution(r)}
            title=${tr('xiaozhi.plan.resTitle', { res: r.replace('p', 'P') })}
          >${r.replace('p', 'P')}</button>`)}
        <span className="text-[10px] text-ink3">${tr('xiaozhi.plan.resNote')}</span>
      </div>

      ${(plan.warnings || []).length > 0 && html`
        <div className="mt-1.5 rounded-[6px] bg-white/[.03] px-2 py-1">
          ${plan.warnings.map((w, i) => html`<p key=${i} className="text-[10px] leading-[1.6] text-warn">${tr('xiaozhi.plan.warningPrefix', { w })}</p>`)}
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
            ${tr('xiaozhi.plan.imageToggle')}<span className="text-ink3">${tr('xiaozhi.plan.imageToggleSub')}</span>
          </span>
        </label>
        ${imgOn ? html`
          <p className="mt-1 text-[10px] leading-[1.6] text-ink3">${imageBillingText(plan, unitCny)}</p>
          <p className="mt-0.5 text-[10px] leading-[1.6] text-warn">
            ${tr('xiaozhi.plan.pauseNote')}
          </p>
          ${imageBackendReady === false && html`
            <p className="mt-0.5 text-[10px] leading-[1.6] text-danger">
              ${tr('xiaozhi.plan.oldServer')}
            </p>
          `}
          ${!hasImageKey && html`
            <p className="mt-0.5 text-[10px] leading-[1.6] text-warn">
              ${tr('xiaozhi.plan.noImageKey')}
            </p>
          `}
        ` : html`
          <p className="mt-1 text-[10px] leading-[1.6] text-ink3">
            ${tr('xiaozhi.plan.pureText')}
          </p>
        `}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          disabled=${!!busy}
          onClick=${onConfirm}
        >${busy ? tr('xiaozhi.plan.submitBusy') : (plan.requiresPaymentApproval ? tr('xiaozhi.plan.confirmPaid', { cost: money(est.totalCny) }) : tr('xiaozhi.plan.confirmFree'))}</button>
        <span className="text-[10px] text-ink3">
          ${plan.requiresPaymentApproval ? tr('xiaozhi.plan.paidNote') : tr('xiaozhi.plan.mockNote')}
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
  if (state.retryAllowed !== undefined) parts.push(tr('xiaozhi.state.retry', { n: state.retries || 0, max: state.retryAllowed }));
  if (state.fillAllowed !== undefined) parts.push(tr('xiaozhi.state.fill', { n: state.fills || 0, max: state.fillAllowed }));
  if (task && task.totalClips) parts.push(tr('xiaozhi.state.clips', { n: task.successClips || 0, max: task.totalClips }));
  return html`
    <div className="rounded-[8px] border border-white/[.08] bg-white/[.03] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className=${'text-[11px] font-medium ' + tone}>${awaiting ? tr('xiaozhi.state.awaiting') : (state.label || state.state)}</span>
        ${task && task.currentStep && html`<span className="text-[10px] text-ink3 truncate">${task.currentStep}</span>`}
        <span className="flex-1"></span>
        ${task && task.taskId && onOpenTask && html`
          <button
            className="h-5 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.05]"
            onClick=${() => onOpenTask(task.taskId)}
          >${tr('xiaozhi.state.detail')}</button>
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
        <span className="text-[11px] font-medium text-accent">${tr('xiaozhi.review.title')}</span>
        <span className="text-[10px] text-ink3">${tr('xiaozhi.review.paused')}</span>
        <span className="flex-1"></span>
        ${taskId && html`<span className="text-[10px] text-ink3 font-num truncate">${taskId}</span>`}
      </div>
      <p className="mt-1 text-[11px] leading-[1.6] text-ink">
        ${tr('xiaozhi.review.summary', { total, generated, failed: failed > 0 ? tr('xiaozhi.review.failedSuffix', { n: failed }) : '', pending })}
      </p>
      ${currentStep && html`<p className="mt-0.5 text-[10px] leading-[1.6] text-ink3">${currentStep}</p>`}
      <p className="mt-1 text-[10px] leading-[1.6] text-ink3">
        ${tr('xiaozhi.review.guide')}
      </p>
      ${failed > 0 && html`
        <p className="mt-1 text-[10px] leading-[1.6] text-warn">
          ${tr('xiaozhi.review.failedNote', { n: failed })}
        </p>
      `}
      <div className="mt-1.5 flex items-center gap-2">
        <button
          className="h-7 px-2.5 rounded-[5px] border border-accent/40 text-accent text-[11px] hover:bg-accent/[.08]"
          onClick=${() => onGoReview && onGoReview()}
        >${tr('xiaozhi.review.goReview')}</button>
        <button
          className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          disabled=${!!busy}
          onClick=${() => onContinue && onContinue()}
        >${busy ? tr('xiaozhi.review.continueBusy') : tr('xiaozhi.review.continue')}</button>
      </div>
    </div>
  `;
}

// 首页气泡：在创作页给一个「我是小智」的引导气泡；可关，关一次不再打扰。
export function GreetingBubble({ onPick, onClose, bottom = 136 }) {
  const chips = [tr('assistant.chips.long'), tr('assistant.chips.last'), tr('assistant.chips.progress')];
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
          <p className="text-[12px] text-ink font-medium">${tr('xiaozhi.greeting.title')}</p>
          <p className="mt-1 text-[11px] leading-[1.65] text-ink3">
            ${tr('xiaozhi.greeting.body')}
          </p>
        </div>
        <button
          aria-label=${tr('xiaozhi.greeting.closeAria')}
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

// ============================================================
// 按住说话 / 麦克风权限（2026-11-16 用户反馈：拿不到麦克风权限：Permission denied）
// ------------------------------------------------------------
// 旧实现的问题：直接 getUserMedia，失败只回一句「拿不到麦克风权限…请改用打字」，
// 用户不知道是浏览器站点权限、Windows 隐私开关，还是设备被占用；而且按住说话时
// 浏览器弹权限框，用户在弹框出现后一松手，授权通过后录音会偷偷开始且停不下来。
//
// 现在：
//   1) 先把「权限状态」查清楚（Permissions API），再决定请求、引导还是直接报原因；
//   2) 首次请求时弹出说明卡：告诉用户「Chrome 会弹允许，请点允许」；
//   3) 拒绝时给 Chrome / Windows 可照做的步骤，并提供「重新请求 / 复制排查步骤」；
//   4) 授权弹窗期间松手 → 只拿权限、不录音，提示「请再按住说话一次」；
//   5) NotFound / NotReadable / 非安全来源 / 不支持 分别给不同原因，不一律说成权限。
// ============================================================
const MIC_HELP_URL = 'chrome://settings/content/microphone';

function micSupport() {
  const secure = typeof window === 'undefined' ? false : window.isSecureContext !== false;
  const gum = !!(typeof navigator !== 'undefined' && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function');
  const rec = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
  return { secure, gum, rec, ok: secure && gum && rec };
}

async function queryMicPermission() {
  try {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return 'unknown';
    const st = await navigator.permissions.query({ name: 'microphone' });
    return st && st.state ? st.state : 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

function micErrorInfo(err, perm) {
  const name = (err && err.name) || '';
  const support = micSupport();
  if (name === 'INSECURE_CONTEXT' || !support.secure) {
    return {
      title: tr('xiaozhi.mic.err.insecure.title'),
      body: tr('xiaozhi.mic.err.insecure.body'),
      steps: [tr('xiaozhi.mic.err.insecure.s1'), tr('xiaozhi.mic.err.insecure.s2')],
      retry: false
    };
  }
  if (name === 'NO_GETUSERMEDIA' || name === 'NO_MEDIARECORDER') {
    return {
      title: tr('xiaozhi.mic.err.unsupported.title'),
      body: tr('xiaozhi.mic.err.unsupported.body'),
      steps: [tr('xiaozhi.mic.err.unsupported.s1'), tr('xiaozhi.mic.err.unsupported.s2')],
      retry: false
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      title: tr('xiaozhi.mic.err.notFound.title'),
      body: tr('xiaozhi.mic.err.notFound.body'),
      steps: [tr('xiaozhi.mic.err.notFound.s1'), tr('xiaozhi.mic.err.notFound.s2')],
      retry: true
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      title: tr('xiaozhi.mic.err.busy.title'),
      body: tr('xiaozhi.mic.err.busy.body'),
      steps: [tr('xiaozhi.mic.err.busy.s1'), tr('xiaozhi.mic.err.busy.s2')],
      retry: true
    };
  }
  if ((name === 'NotAllowedError' || name === 'PermissionDeniedError') && perm === 'granted') {
    return {
      title: tr('xiaozhi.mic.err.policy.title'),
      body: tr('xiaozhi.mic.err.policy.body'),
      steps: [tr('xiaozhi.mic.err.policy.s1'), tr('xiaozhi.mic.err.policy.s2'), tr('xiaozhi.mic.err.policy.s3')],
      retry: true
    };
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || perm === 'denied') {
    return {
      title: tr('xiaozhi.mic.err.denied.title'),
      body: tr('xiaozhi.mic.err.denied.body'),
      steps: [tr('xiaozhi.mic.err.denied.s1'), tr('xiaozhi.mic.err.denied.s2'), tr('xiaozhi.mic.err.denied.s3'), tr('xiaozhi.mic.err.denied.s4')],
      code: MIC_HELP_URL,
      retry: true
    };
  }
  return {
    title: tr('xiaozhi.mic.err.generic.title'),
    body: tr('xiaozhi.mic.err.generic.body', {
      name: (err && (err.name || err.message)) || String(err || tr('xiaozhi.mic.unknownError'))
    }),
    steps: [tr('xiaozhi.mic.err.generic.s1'), tr('xiaozhi.mic.err.generic.s2')],
    retry: true
  };
}

function MicPermissionModal({ modal, onClose, onRetry, onCopy, copied }) {
  if (!modal) return null;
  const phase = modal.phase || 'error';
  const info = modal.info || {};
  const granted = phase === 'granted';
  const requesting = phase === 'requesting';
  const title = granted ? tr('xiaozhi.mic.titleGranted') : (requesting ? tr('xiaozhi.mic.titleRequesting') : (info.title || tr('xiaozhi.mic.titleFallback')));
  const body = granted
    ? tr('xiaozhi.mic.bodyGranted')
    : (requesting ? tr('xiaozhi.mic.bodyRequesting') : (info.body || ''));
  const steps = granted || requesting ? [] : (info.steps || []);
  const canRetry = info.retry !== false;

  const overlay = html`
    <div
      className="xz-mic-overlay"
      data-mic-modal="1"
      data-mic-phase=${phase}
      onClick=${(e) => { if (e.target === e.currentTarget && !requesting) onClose(); }}
    >
      <div className="xz-mic-card" role="dialog" aria-modal="true" aria-label=${tr('xiaozhi.mic.modalAria')}>
        <p className="xz-mic-kicker">${tr('xiaozhi.mic.kicker')}</p>
        <h2 className="xz-mic-title">
          ${granted ? '✓ ' : (requesting ? '' : '🎙 ')}${title}
        </h2>
        ${requesting && html`<div className="xz-mic-spinner" aria-hidden="true"></div>`}
        <p className="xz-mic-body">${body}</p>
        ${steps.length > 0 && html`
          <ol className="xz-mic-steps">
            ${steps.map((s, i) => html`<li key=${i}>${s}</li>`)}
          </ol>
        `}
        ${info.code && html`<p className="xz-mic-code">${info.code}</p>`}
        ${modal.errorName && html`
          <p className="xz-mic-err">
             ${tr('xiaozhi.mic.errorLine', { name: modal.errorName, msg: modal.errorMessage ? tr('xiaozhi.mic.errorMsg', { msg: modal.errorMessage }) : '' })}
          </p>
        `}
        <div className="xz-mic-actions">
          ${granted && html`
            <button type="button" className="xz-mic-btn is-primary" onClick=${onClose}>${tr('xiaozhi.mic.start')}</button>
          `}
          ${!granted && canRetry && html`
            <button type="button" className="xz-mic-btn is-primary" onClick=${onRetry} disabled=${requesting}>
              ${requesting ? tr('xiaozhi.mic.waiting') : tr('xiaozhi.mic.retry')}
            </button>
          `}
          ${!granted && !requesting && (steps.length > 0 || info.code) && html`
            <button type="button" className="xz-mic-btn" onClick=${onCopy}>${copied ? tr('xiaozhi.mic.copied') : tr('xiaozhi.mic.copy')}</button>
          `}
          <button type="button" className="xz-mic-btn" onClick=${onClose}>${tr('xiaozhi.mic.typeInstead')}</button>
        </div>
        <p className="xz-mic-note">${tr('xiaozhi.mic.note')}</p>
      </div>
    </div>
  `;
  // 必须挂到 body：按钮所在的 .xz-inputbar 有 backdrop-filter，会成为 fixed 后代的包含块，
  // 直接渲染会把遮罩压进输入条里。createPortal 在页面模式与悬浮面板里都能铺满视口。
  if (typeof document !== 'undefined' && window.ReactDOM
    && typeof window.ReactDOM.createPortal === 'function') {
    return window.ReactDOM.createPortal(overlay, document.body);
  }
  return overlay;
}

// 按住说话：getUserMedia → MediaRecorder → base64 → POST /api/assistant/asr。
// 任何失败都回退打字（不阻塞输入框），但先把原因和修法放进权限卡，而不是只写一行报错。
export function VoiceButton({ onText, onHint, disabled }) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState('unknown');
  const [modal, setModal] = useState(null);
  const [copied, setCopied] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const pressedRef = useRef(false);
  const startingRef = useRef(false);
  const autoStopRef = useRef(null);
  const mountedRef = useRef(true);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const levelTimerRef = useRef(null);
  const levelMonitorRef = useRef(false);
  const maxLevelRef = useRef(0);
  const startedAtRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    let statusObj = null;
    const onChange = () => { if (mountedRef.current && statusObj) setPerm(statusObj.state); };
    (async () => {
      const p = await queryMicPermission();
      if (mountedRef.current) setPerm(p);
      try {
        if (navigator.permissions && typeof navigator.permissions.query === 'function') {
          statusObj = await navigator.permissions.query({ name: 'microphone' });
          if (statusObj && statusObj.addEventListener) statusObj.addEventListener('change', onChange);
        }
      } catch (e) { /* 个别浏览器不支持麦克风权限查询 */ }
    })();
    return () => {
      mountedRef.current = false;
      clearTimeout(autoStopRef.current);
      stopLevelMonitor();
      if (statusObj && onChange && statusObj.removeEventListener) statusObj.removeEventListener('change', onChange);
      const rec = recRef.current;
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* ignore */ } }
      const stream = streamRef.current;
      if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } }
    };
  }, []);

  function showModal(phase, err, permState) {
    const info = err ? micErrorInfo(err, permState != null ? permState : perm) : null;
    setModal({
      phase,
      info,
      errorName: err && err.name ? err.name : '',
      errorMessage: err && err.message ? err.message : ''
    });
  }

  function fail(err, permState) {
    const info = micErrorInfo(err, permState != null ? permState : perm);
    const denied = (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'))
      || permState === 'denied' || perm === 'denied';
    if (denied) setPerm('denied');
    setModal({
      phase: 'error',
      info,
      errorName: err && err.name ? err.name : '',
      errorMessage: err && err.message ? err.message : ''
    });
    onHint && onHint(tr('xiaozhi.mic.failPrefix', {
      name: (err && (err.name || err.message)) || tr('xiaozhi.mic.unknownError'),
      denied: denied ? tr('xiaozhi.mic.deniedSuffix') : ''
    }));
  }

  function startLevelMonitor(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      analyserRef.current = analyser;
      levelMonitorRef.current = true;
      maxLevelRef.current = 0;
      if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
      const buf = new Float32Array(analyser.fftSize);
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = setInterval(() => {
        try {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          if (rms > maxLevelRef.current) maxLevelRef.current = rms;
          if (mountedRef.current) {
            setRecSeconds(Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)));
          }
        } catch (e) { /* ignore */ }
      }, 100);
    } catch (e) {
      // WebAudio 不可用也不要阻塞录音；最低时长仍会兜底。
      stopLevelMonitor();
      levelMonitorRef.current = false;
    }
  }

  function stopLevelMonitor() {
    clearInterval(levelTimerRef.current);
    levelTimerRef.current = null;
    try { if (analyserRef.current) analyserRef.current.disconnect(); } catch (e) { /* ignore */ }
    analyserRef.current = null;
    try {
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') audioCtxRef.current.close();
    } catch (e) { /* ignore */ }
    audioCtxRef.current = null;
    levelMonitorRef.current = false;
    if (mountedRef.current) setRecSeconds(0);
  }

  async function start() {
    if (disabled || busy || startingRef.current) return;
    const support = micSupport();
    if (!support.ok) {
      const err = new Error(support.secure ? 'NO_GETUSERMEDIA' : 'INSECURE_CONTEXT');
      err.name = support.secure ? 'NO_GETUSERMEDIA' : 'INSECURE_CONTEXT';
      showModal('error', err, perm);
      onHint && onHint(tr('xiaozhi.mic.hint.browserUnavailable'));
      return;
    }
    startingRef.current = true;
    pressedRef.current = true;
    if (mountedRef.current) setStarting(true);

    // 查询权限状态要在 getUserMedia 之前：Chrome 已「阻止」时不会再弹授权框，
    // 直接请求只会得到 Permission denied，用户看不到任何可点的「允许」。
    const p = await queryMicPermission();
    if (mountedRef.current) setPerm(p);
    if (p === 'denied') {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
      fail({ name: 'NotAllowedError', message: 'Permission denied' }, 'denied');
      return;
    }
    if (p !== 'granted') {
      setModal({ phase: 'requesting', info: null, errorName: '', errorMessage: '' });
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
      setRecording(false);
      fail(e, p);
      return;
    }
    streamRef.current = stream;
    if (mountedRef.current) setPerm('granted');

    // 授权弹窗期间用户已经松手：只拿权限，不偷偷录。
    if (!pressedRef.current) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      streamRef.current = null;
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
      showModal('granted', null, 'granted');
      onHint && onHint(tr('xiaozhi.mic.hint.allowedAgain'));
      return;
    }

    try {
      const mime = (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
        ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
        streamRef.current = null;
        recRef.current = null;
        const durationMs = startedAtRef.current ? (Date.now() - startedAtRef.current) : 0;
        const maxLevel = maxLevelRef.current;
        const hadLevelMonitor = levelMonitorRef.current;
        stopLevelMonitor();
        if (!mountedRef.current) return;
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) {
          setBusy(false);
          onHint && onHint(tr('xiaozhi.mic.hint.noSound'));
          return;
        }
        if (durationMs > 0 && durationMs < 600) {
          setBusy(false);
          onHint && onHint(tr('xiaozhi.mic.hint.tooShort'));
          return;
        }
        if (hadLevelMonitor && maxLevel < 0.005) {
          setBusy(false);
          onHint && onHint(tr('xiaozhi.mic.hint.tooQuiet'));
          return;
        }
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
            onHint && onHint(tr('xiaozhi.mic.hint.asrFailed', { error: (j && (j.error || j.code)) || ('HTTP ' + r.status) }));
          } else {
            const text = String(j.text || '').trim();
            // 静音/噪声时 SenseVoice 会吐出 ".", "그." 这类标点/杂字；不要塞进输入框。
            const meaningful = text.replace(/[^\p{L}\p{N}]/gu, '');
            if (!meaningful) {
              onHint && onHint(tr('xiaozhi.mic.hint.unclear'));
            } else {
              onText && onText(text);
            }
          }
        } catch (e) {
          onHint && onHint(tr('xiaozhi.mic.hint.uploadFailed', { error: e && e.message ? e.message : e }));
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      };
      recRef.current = rec;
      startedAtRef.current = Date.now();
      maxLevelRef.current = 0;
      rec.start();
      setRecording(true);
      if (mountedRef.current) setStarting(false);
      startLevelMonitor(stream);
      clearTimeout(autoStopRef.current);
      autoStopRef.current = setTimeout(() => {
        if (mountedRef.current) stop();
      }, 60000);
    } catch (e) {
      stopLevelMonitor();
      if (mountedRef.current) setStarting(false);
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) { /* ignore */ }
      streamRef.current = null;
      setRecording(false);
      fail(e, 'granted');
    } finally {
      startingRef.current = false;
    }
  }

  function stop() {
    pressedRef.current = false;
    if (mountedRef.current) setStarting(false);
    clearTimeout(autoStopRef.current);
    if (!recRef.current) {
      // 还在等授权弹窗：只记下「已松手」，start() 成功后会自己停掉流，不开始录音。
      if (mountedRef.current) setRecording(false);
      return;
    }
    if (mountedRef.current) setRecording(false);
    const rec = recRef.current;
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch (e) { /* ignore */ }
  }

  async function retryPermission() {
    const support = micSupport();
    if (!support.ok) {
      const err = new Error(support.secure ? 'NO_GETUSERMEDIA' : 'INSECURE_CONTEXT');
      err.name = support.secure ? 'NO_GETUSERMEDIA' : 'INSECURE_CONTEXT';
      fail(err, perm);
      return;
    }
    setModal({ phase: 'requesting', info: null, errorName: '', errorMessage: '' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      if (!mountedRef.current) return;
      setPerm('granted');
      setModal({ phase: 'granted', info: null, errorName: '', errorMessage: '' });
      onHint && onHint(tr('xiaozhi.mic.hint.allowedNow'));
    } catch (e) {
      if (!mountedRef.current) return;
      fail(e, perm);
    }
  }

  async function copyHelp() {
    const info = modal && modal.info;
    if (!info) return;
    const text = [
      info.title || '',
      info.body || '',
      ...(info.steps || []).map((s, i) => (i + 1) + '. ' + s),
      info.code ? tr('xiaozhi.mic.copyCodePrefix') + info.code : ''
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => { if (mountedRef.current) setCopied(false); }, 1800);
    } catch (e) {
      onHint && onHint(tr('xiaozhi.mic.hint.copyFailed'));
    }
  }

  const statusToast = (starting || recording || busy) ? html`
    <div
      key="mic-status"
      className="xz-mic-status"
      data-mic-status=${busy ? 'transcribing' : (starting ? 'starting' : 'recording')}
      role="status"
      aria-live="polite"
    >
      <span className=${(busy || starting) ? 'xz-mic-status-spinner' : 'xz-mic-status-dot'} aria-hidden="true"></span>
      <span>${busy ? tr('xiaozhi.mic.statusTranscribing')
        : (starting ? tr('xiaozhi.mic.statusStarting')
          : tr('xiaozhi.mic.statusRecording', { n: recSeconds }))}</span>
    </div>
  ` : null;
  const statusPortal = statusToast && typeof document !== 'undefined' && window.ReactDOM
    && typeof window.ReactDOM.createPortal === 'function'
    ? window.ReactDOM.createPortal(statusToast, document.body)
    : statusToast;

  return [
    html`
      <button
        key="voice-btn"
        type="button"
        aria-label=${tr('xiaozhi.mic.btnAria')}
        data-mic-button="1"
        title=${disabled ? tr('xiaozhi.mic.btnDisabledTitle')
          : (recording ? tr('xiaozhi.mic.btnStopTitle')
            : (perm === 'denied' ? tr('xiaozhi.mic.btnDeniedTitle')
              : (perm === 'granted' ? tr('xiaozhi.mic.btnGrantedTitle') : tr('xiaozhi.mic.btnHoldTitle'))))}
        disabled=${disabled || busy}
        onPointerDown=${(e) => { if (e.button != null && e.button !== 0) return; e.preventDefault(); start(); }}
        onPointerUp=${(e) => { e.preventDefault(); stop(); }}
        onPointerLeave=${() => stop()}
        onPointerCancel=${() => stop()}
        onContextMenu=${(e) => e.preventDefault()}
        className=${[
          'h-7 w-7 shrink-0 rounded-[5px] border text-[13px] leading-none',
          recording ? 'border-danger/50 text-danger bg-danger/[.08]' : 'border-white/[.12] text-ink2 hover:bg-white/[.05]',
          (disabled || busy) ? 'opacity-40' : ''
        ].join(' ')}
      >${busy ? '…' : (recording ? '●' : '🎙')}</button>
    `,
    html`
      <${MicPermissionModal}
        key="mic-modal"
        modal=${modal}
        copied=${copied}
        onClose=${() => setModal(null)}
        onRetry=${retryPermission}
        onCopy=${copyHelp}
      />
    `,
    statusPortal
  ];
}
