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
export function PlanCard({ plan, busy, onConfirm, onEdit, imagePerClip, onToggleImage, unitCny, hasImageKey, imageBackendReady, onSetResolution }) {
  if (!plan) return null;
  const est = plan.estimate || {};
  const imgOn = imagePerClip === true;
  const totalSec = Math.round(Number(plan.totalSec) || 0);
  const mins = Number(plan.totalMinutes);
  // 不到 1 分钟按秒显示（2026-11-16 支持「30 秒」这类短视频/快速验证）
  const durText = (Number.isFinite(mins) && mins >= 1)
    ? `${mins.toFixed(2)} 分钟 = ${plan.clipCount} 段 × ${plan.clipDurationSec} 秒`
    : `${totalSec} 秒 = ${plan.clipCount} 段 × ${plan.clipDurationSec} 秒`;
  const rows = [
    ['时长', durText],
    ...(plan.themeLabel ? [['主题', plan.themeLabel]] : []),
    ['模型', plan.modelLabel || plan.model],
    ['分辨率', `${plan.resolution}（下面可改）`],
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

      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-ink3">分辨率</span>
        ${['480p', '720p', '1080p'].map((r) => html`
          <button key=${'res-' + r}
            className=${'h-6 px-2 rounded-[4px] text-[10px] border ' + (plan.resolution === r ? 'border-accent text-accent bg-accent/[.08]' : 'border-white/[.08] text-ink2 hover:bg-white/[.05]')}
            onClick=${() => onSetResolution && onSetResolution(r)}
            title=${'改成 ' + r.replace('p', 'P') + '（重新出计划卡，不计费）'}
          >${r.replace('p', 'P')}</button>`)}
        <span className="text-[10px] text-ink3">点了重新出计划卡（不计费）</span>
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
          ${imageBackendReady === false && html`
            <p className="mt-0.5 text-[10px] leading-[1.6] text-danger">
              ⛔ 服务端还是旧进程（info 里没有 image 段）：逐段出图**不会生效**，确认会被拦下。
              请先重启 3001 再点确认，或关掉本开关走纯文生视频。
            </p>
          `}
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
      title: '当前页面不是安全来源',
      body: 'Chrome 只允许 localhost 或 https 页面使用麦克风。请用 http://localhost:3001 打开；'
        + '不要用局域网 IP 的 http 地址，也不要在别的应用的内嵌页里打开。',
      steps: ['确认地址栏是 http://localhost:3001 或 https://…；', '如果要从手机/别的机器访问，需要给站点配 HTTPS。'],
      retry: false
    };
  }
  if (name === 'NO_GETUSERMEDIA' || name === 'NO_MEDIARECORDER') {
    return {
      title: '这个浏览器不支持录音',
      body: '当前浏览器没有可用的录音接口。建议改用最新版 Chrome / Edge 打开本页。',
      steps: ['换 Chrome 或 Edge 最新版；', '如果页面嵌在别的应用里，请复制地址到系统浏览器打开。'],
      retry: false
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      title: '没有检测到麦克风',
      body: '系统里没有可用的录音设备。插上/启用麦克风后点「重新请求麦克风」。',
      steps: ['Windows 声音设置里确认输入设备已启用；', '笔记本确认没有把麦克风静音或禁用。'],
      retry: true
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      title: '麦克风被其他程序占用了',
      body: '另一个程序正在独占麦克风。关掉它，再点「重新请求麦克风」。',
      steps: ['关闭腾讯会议 / ToDesk / OBS / 录音软件等正在用麦克风的程序；', '如果设备是虚拟声卡，切到系统默认麦克风再试。'],
      retry: true
    };
  }
  if ((name === 'NotAllowedError' || name === 'PermissionDeniedError') && perm === 'granted') {
    return {
      title: '站点已允许，但页面仍被禁止',
      body: 'Chrome 站点权限已经是「允许」，但本页面的 Permissions-Policy 或系统隐私仍在拦截麦克风。',
      steps: [
        '确认服务端没有把该页面的 Permissions-Policy 设成 microphone=()；本仓库 server.js 应为 microphone=(self)。',
        'Windows：设置 → 隐私和安全性 → 麦克风 → 打开「允许桌面应用访问麦克风」。',
        '改完刷新页面，再按住麦克风。'
      ],
      retry: true
    };
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || perm === 'denied') {
    return {
      title: '麦克风被浏览器拒绝了',
      body: 'Chrome 没把麦克风权限给这个页面。按下面几步改一次，之后按住麦克风就能说话：',
      steps: [
        '点地址栏左侧的「⚙」或「🔒」图标 →「网站设置」→ 把「麦克风」改成「允许」。',
        '或者新标签页打开 chrome://settings/content/microphone，把 localhost:3001 设为「允许」。',
        'Windows：设置 → 隐私和安全性 → 麦克风 → 打开「允许应用访问麦克风」和「允许桌面应用访问麦克风」。',
        '回到本页刷新一次，再按住麦克风。'
      ],
      code: MIC_HELP_URL,
      retry: true
    };
  }
  return {
    title: '麦克风没有启动',
    body: '浏览器返回了错误：' + ((err && (err.name || err.message)) || String(err || '未知错误')) + '。',
    steps: ['确认麦克风没有被其他程序占用；', '刷新页面再试；还不行就先用键盘打字。'],
    retry: true
  };
}

function MicPermissionModal({ modal, onClose, onRetry, onCopy, copied }) {
  if (!modal) return null;
  const phase = modal.phase || 'error';
  const info = modal.info || {};
  const granted = phase === 'granted';
  const requesting = phase === 'requesting';
  const title = granted ? '麦克风已允许' : (requesting ? '正在请求麦克风' : (info.title || '麦克风权限'));
  const body = granted
    ? '现在按住麦克风说话，松开后会自动转成文字。'
    : (requesting ? '请在弹出的浏览器授权提示里点「允许」。' : (info.body || ''));
  const steps = granted || requesting ? [] : (info.steps || []);
  const canRetry = info.retry !== false;

  const overlay = html`
    <div
      className="xz-mic-overlay"
      data-mic-modal="1"
      data-mic-phase=${phase}
      onClick=${(e) => { if (e.target === e.currentTarget && !requesting) onClose(); }}
    >
      <div className="xz-mic-card" role="dialog" aria-modal="true" aria-label="麦克风权限">
        <p className="xz-mic-kicker">MICROPHONE · 语音输入</p>
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
            浏览器错误：${modal.errorName}${modal.errorMessage ? ' · ' + modal.errorMessage : ''}
          </p>
        `}
        <div className="xz-mic-actions">
          ${granted && html`
            <button type="button" className="xz-mic-btn is-primary" onClick=${onClose}>开始说话</button>
          `}
          ${!granted && canRetry && html`
            <button type="button" className="xz-mic-btn is-primary" onClick=${onRetry} disabled=${requesting}>
              ${requesting ? '等待允许…' : '重新请求麦克风'}
            </button>
          `}
          ${!granted && !requesting && (steps.length > 0 || info.code) && html`
            <button type="button" className="xz-mic-btn" onClick=${onCopy}>${copied ? '已复制' : '复制排查步骤'}</button>
          `}
          <button type="button" className="xz-mic-btn" onClick=${onClose}>先打字</button>
        </div>
        <p className="xz-mic-note">只授权一次，浏览器会记住；语音识别在本机离线完成。</p>
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
    onHint && onHint('麦克风没有启动：'
      + ((err && (err.name || err.message)) || '未知错误')
      + (denied ? '（授权被拒绝/未允许）' : '')
      + '。已打开排查卡；也可以先打字。');
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
      onHint && onHint('这台浏览器/这个页面暂时用不了麦克风；请改用打字。');
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
      onHint && onHint('麦克风已允许，请再按住麦克风说一次。');
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
          onHint && onHint('没录到声音，再按住说一次试试。');
          return;
        }
        if (durationMs > 0 && durationMs < 600) {
          setBusy(false);
          onHint && onHint('录音太短：按住后对着麦克风说，说完再松开。');
          return;
        }
        if (hadLevelMonitor && maxLevel < 0.005) {
          setBusy(false);
          onHint && onHint('没听到声音：按住后对着麦克风说话（离麦克风近一点），说完再松开。');
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
            onHint && onHint('语音识别失败：' + ((j && (j.error || j.code)) || ('HTTP ' + r.status)) + '，请改用打字。');
          } else {
            const text = String(j.text || '').trim();
            // 静音/噪声时 SenseVoice 会吐出 ".", "그." 这类标点/杂字；不要塞进输入框。
            const meaningful = text.replace(/[^\p{L}\p{N}]/gu, '');
            if (!meaningful) {
              onHint && onHint('没听清：只识别到标点/杂音。按住后对着麦克风说清楚，说完再松开。');
            } else {
              onText && onText(text);
            }
          }
        } catch (e) {
          onHint && onHint('语音上传异常：' + (e && e.message ? e.message : e) + '，请改用打字。');
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
      onHint && onHint('麦克风已允许，现在按住麦克风说话就行。');
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
      info.code ? '设置地址：' + info.code : ''
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => { if (mountedRef.current) setCopied(false); }, 1800);
    } catch (e) {
      onHint && onHint('复制失败，请按弹窗里的步骤手动设置。');
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
      <span>${busy ? '正在识别语音…'
        : (starting ? '正在打开麦克风… 请继续按住'
          : ('正在录音 ' + recSeconds + ' 秒 · 请说话，松开结束'))}</span>
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
        aria-label="按住说话"
        data-mic-button="1"
        title=${disabled ? '服务端未重启，语音暂不可用'
          : (recording ? '松开结束'
            : (perm === 'denied' ? '麦克风被拒绝，点这里看怎么开'
              : (perm === 'granted' ? '按住说话' : '按住说话（首次需要允许麦克风）')))}
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
