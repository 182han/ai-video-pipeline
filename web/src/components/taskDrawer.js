// ============================================================
// 任务详情抽屉（右侧滑出）
// ------------------------------------------------------------
// 数据：GET /api/tasks/:id（返回完整任务对象）
// 质检语义严格按 AGENTS.md §4.1：
//   passed === true            → 通过
//   legitimateSkip === true    → 合法跳过（带理由）
//   skipped 但不是合法跳过      → 不通过（绝不显示成通过）
//   测不到 / 无结果             → 未执行
// ============================================================
import { statusMeta, PauseButton } from './pauseControl.js';
import { t as tr, has, fmtDateTime } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const ADJ_LABELS = {
  temperature: 'tasks.adjust.temperature', tone: 'tasks.adjust.tone', saturation: 'tasks.adjust.saturation',
  brightness: 'tasks.adjust.brightness', contrast: 'tasks.adjust.contrast', highlight: 'tasks.adjust.highlight',
  shadow: 'tasks.adjust.shadow', white: 'tasks.adjust.white', black: 'tasks.adjust.black', lightSensation: 'tasks.adjust.lightSensation'
};

// 打开剪辑台（/app/edit?task=<id>）：pushState + popstate 让 shell 重新解析路由。
function openEdit(taskId) {
  window.history.pushState({}, '', '/app/edit?task=' + encodeURIComponent(taskId));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const STEP_ORDER = [
  'prompt_optimize',
  'storyboard',
  'clip_generation',
  'concatenation',
  'loop_processing',
  'audio_mix',
  'transcoding',
  'final_qc'
];

const STEP_LABEL_KEY = {
  prompt_optimize: 'tasks.step.prompt_optimize',
  storyboard: 'tasks.step.storyboard',
  clip_generation: 'tasks.step.clip_generation',
  concatenation: 'tasks.step.concatenation',
  loop_processing: 'tasks.step.loop_processing',
  audio_mix: 'tasks.step.audio_mix',
  transcoding: 'tasks.step.transcoding',
  final_qc: 'tasks.step.final_qc'
};

function qcBadge(qc) {
  if (!qc) return { text: tr('tasks.qc.notRun'), cls: 'text-ink3' };
  if (qc.passed === true) return { text: tr('tasks.qc.passed'), cls: 'text-accent' };
  if (qc.legitimateSkip === true) return { text: tr('tasks.qc.plannedSkip'), cls: 'text-ink3' };
  if (qc.skipped === true) return { text: tr('tasks.qc.skippedUnknown'), cls: 'text-danger' };
  return { text: tr('tasks.qc.failed'), cls: 'text-danger' };
}

// 校色四态（2026-10-27 契约，字段直接读，不从 reason 猜）
//   任务级意图：task.colorMatch { enabled, maxGain } / null = 没要求
//   拼接结果：  task.steps.concatenation.qcDetails.colorMatch { state, reason, applied, total, luts }
//   终检汇总：  task.finalQC.details.colorContinuity.colorMatchState / colorMatchReason
function colorMatchBadge(cm) {
  if (!cm || !cm.state) return { text: tr('tasks.qc.notRun'), cls: 'text-warn', title: tr('tasks.colorMatch.noResult') };
  switch (cm.state) {
    case 'applied':
      return {
        text: tr('tasks.colorMatch.applied'),
        cls: 'text-accent',
        title: [
          cm.reason || '',
          cm.applied != null && cm.total != null ? tr('tasks.colorMatch.appliedCount', { applied: cm.applied, total: cm.total }) : '',
          Array.isArray(cm.luts) ? tr('tasks.colorMatch.lutCount', { n: cm.luts.length }) : ''
        ].filter(Boolean).join(' · ')
      };
    case 'disabled':
      return { text: tr('tasks.colorMatch.disabled'), cls: 'text-ink3', title: cm.reason || tr('tasks.colorMatch.disabledTitle') };
    case 'skipped':
      return { text: tr('tasks.colorMatch.skipped'), cls: 'text-warn', title: cm.reason || cm.colorMatchReason || tr('tasks.colorMatch.skippedTitle') };
    case 'failed':
      return {
        text: tr('tasks.colorMatch.failed'),
        cls: 'text-danger',
        title: (cm.reason || '') + tr('tasks.colorMatch.failedTitle')
      };
    default:
      return { text: cm.state, cls: 'text-ink3', title: cm.reason || '' };
  }
}

// 从任务对象取校色信息：意图 + 实际结果（优先拼接步骤，回退终检汇总）
function pickColorMatch(task) {
  if (!task) return null;
  const intent = task.colorMatch && task.colorMatch.enabled === true;
  const maxGain = (task.colorMatch && task.colorMatch.maxGain) ?? null;

  const concatCm = task.steps && task.steps.concatenation
    && task.steps.concatenation.qcDetails
    && task.steps.concatenation.qcDetails.colorMatch;

  const finalCc = task.finalQC && task.finalQC.details && task.finalQC.details.colorContinuity;

  if (concatCm && concatCm.state) return { intent, maxGain, result: concatCm, source: 'concatenation' };
  if (finalCc && finalCc.colorMatchState) {
    return {
      intent,
      maxGain,
      result: {
        state: finalCc.colorMatchState,
        reason: finalCc.colorMatchReason || '',
        colorMatchReason: finalCc.colorMatchReason || ''
      },
      source: 'finalQC'
    };
  }
  return { intent, maxGain, result: null, source: null };
}

// 状态展示统一走 pauseControl.statusMeta：paused 单独一态，
// failed 若带 failureCode=pause_* 则显示「已中止 · 可补跑」而不是普通失败。
function statusStyle(status, task) {
  return statusMeta(status, task);
}

// outputPath 是绝对路径，转成 /output/<文件名> 才能被静态目录下发
function toOutputUrl(p) {
  if (!p) return null;
  const name = String(p).split(/[\\/]/).pop();
  return name ? '/output/' + encodeURIComponent(name) : null;
}

// 单片段重生成要带运行时 Key：旧任务落盘时 Key 被脱敏，不带就会降级 Mock。
// 与创作页 collectRuntime 同一份 localStorage；这里按任务模型映射。
function buildRuntimeConfig(task) {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('vs_config') || '{}'); } catch { cfg = {}; }
  // 出图（图生视频首帧）字段——2026-11-16 契约 §1：
  //   · 5 个图片字段与其它 Key 同一套口径：**任务内存态已有的值优先**（本轮真正生效的那份），
  //     缺失时回落 vs_config（重启后任务里的 Key 被 redact 清空，靠这里补上新填的 Key，
  //     否则补跑时出图会「出图未就绪」）。
  //   · imagePerClip 只认任务自己的值，**不从全局开关兜底**：老任务（纯文生视频）若被
  //     塞成 true，补跑会先对每段真实出图（真计费），这不是用户点这一下想要的结果。
  const rc = (task && task.runtimeConfig) || {};
  const image = {
    imageApiKey: rc.imageApiKey || cfg.imageKey || '',
    imageBaseUrl: rc.imageBaseUrl || cfg.imageBaseUrl || '',
    imageProvider: rc.imageProvider || cfg.imageProvider || '',
    imageModel: rc.imageModel || cfg.imageModel || '',
    imageSize: rc.imageSize || cfg.imageSize || '',
    imagePerClip: rc.imagePerClip === true
  };
  const base = {
    llmApiKey: cfg.llmKey || '', llmBaseUrl: cfg.llmUrl || '', llmModel: cfg.llmModel || '',
    multimodalApiKey: cfg.multimodalKey || '', multimodalBaseUrl: cfg.multimodalUrl || '',
    multimodalModel: cfg.multimodalModel || '',
    ...image,
    strictQcItems: (task && task.runtimeConfig && task.runtimeConfig.strictQcItems) || null
  };
  const model = task && task.model;
  if (model === 'dashscope') {
    const dsBase = (cfg.dashScopeWorkspaceId && cfg.dashScopeRegion)
      ? `https://${cfg.dashScopeWorkspaceId}.${cfg.dashScopeRegion}.maas.aliyuncs.com/api/v1`
      : (cfg.dashScopeBaseUrl || '');
    return { ...base, apiKey: cfg.dashScopeKey || '', apiBaseUrl: dsBase, modelId: 'wan3.0-video' };
  }
  if (model === 'seedance') return { ...base, apiKey: cfg.seedanceKey || '', apiBaseUrl: cfg.seedanceBaseUrl || '', modelId: cfg.seedanceModel || '' };
  if (model === 'kling') return { ...base, klingAccessKey: cfg.klingAk || '', klingSecretKey: cfg.klingSk || '' };
  if (model === 'openai-video') return { ...base, apiKey: cfg.whaletvKey || '', baseUrl: cfg.whaletvBaseUrl || '', modelId: cfg.whaletvVideoModel || 'wan3.0-video' };
  if (model === 'siliconflow') return { ...base, apiKey: cfg.siliconflowKey || '', apiBaseUrl: cfg.siliconflowBaseUrl || '', modelId: cfg.siliconflowModel || '' };
  return base;
}

function Row({ label, children }) {
  return html`
    <div className="flex gap-3 py-[7px] border-b border-white/[.04] last:border-0">
      <span className="w-[68px] shrink-0 text-[12px] text-ink3">${label}</span>
      <span className="flex-1 min-w-0 text-[12px] text-ink break-words">${children}</span>
    </div>
  `;
}

export function TaskDrawer({ taskId, onClose }) {
  const [state, setState] = useState({ loading: true, task: null, error: null });
  const [tick, setTick] = useState(0);
  const [actErr, setActErr] = useState('');
  const [busyAct, setBusyAct] = useState('');

  // 失败任务的补救动作（接口已核实：retry / resume / continue / recheck-clips）
  async function postAction(path) {
    setActErr('');
    setBusyAct(path);
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/' + path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error(j.error || ('HTTP ' + r.status));
      setTick((v) => v + 1);
    } catch (e) {
      setActErr(e.message || tr('tasks.drawer.actionFailed'));
    } finally {
      setBusyAct('');
    }
  }

  // 只重生成用户点的那一条失败片段；不会自动重跑其它片段。
  async function regenerateOne(index) {
    setActErr('');
    setBusyAct('clip-' + index);
    try {
      const r = await fetch(
        '/api/tasks/' + encodeURIComponent(taskId) + '/clips/' + index + '/regenerate',
        {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtimeConfig: buildRuntimeConfig(state.task) })
        }
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      setTick((v) => v + 1);
    } catch (e) {
      setActErr(e.message || tr('tasks.drawer.regenerateFailed'));
    } finally {
      setBusyAct('');
    }
  }

  useEffect(() => {
    let alive = true;
    setState({ loading: true, task: null, error: null });
    fetch('/api/tasks/' + encodeURIComponent(taskId), { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((t) => { if (alive) setState({ loading: false, task: t, error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, task: null, error: e.message }); });
    return () => { alive = false; };
  }, [taskId, tick]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = state.task;
  const st = statusStyle(t && t.status, t);
  const videoUrl = t ? toOutputUrl(t.outputPath) : null;
  const steps = t && t.steps ? STEP_ORDER.filter((k) => t.steps[k]) : [];

  return html`
    <div className="fixed inset-0 z-40">
      <div
        className="absolute inset-0 bg-black/60"
        onClick=${onClose}
        aria-hidden="true"
      ></div>

      <aside
        role="dialog"
        aria-modal="true"
        aria-label=${tr('tasks.drawer.title')}
        className="absolute right-0 top-0 bottom-0 w-[min(760px,94vw)] bg-s3 border-l border-white/[.08]
                   shadow-[-16px_0_48px_rgba(0,0,0,.12)] flex flex-col drawer-in"
        onClick=${(e) => e.stopPropagation()}
      >
        <header className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-white/[.06]">
          <span className=${'w-[7px] h-[7px] rounded-full ' + st.dot}></span>
          <span className=${'text-[12px] ' + st.cls}>${st.text}</span>
          <span className="text-[11px] text-ink3 font-num truncate">${taskId}</span>
          <span className="flex-1"></span>
          ${t && html`
            <${PauseButton}
              taskId=${taskId}
              status=${t.status}
              compact=${false}
              onChanged=${() => setTick((v) => v + 1)}
            />
          `}
          <button
            onClick=${onClose}
            className="h-7 w-7 grid place-items-center rounded-[5px] text-ink2 hover:bg-white/[.05]"
            aria-label=${tr('tasks.drawer.close')}
          >✕</button>
        </header>

        <div className="flex-1 min-h-0 overflow-auto px-4 py-4">
          ${state.loading && html`<p className="text-[12px] text-ink3">${tr('tasks.drawer.loading')}</p>`}
          ${state.error && html`<p className="text-[12px] text-danger">${tr('tasks.drawer.loadFailed')}${state.error}</p>`}

          ${t && html`
            <div>
              <p className="text-[13px] leading-[1.75] text-ink">
                ${(t.optimizedPrompt || t.prompt || tr('tasks.drawer.noPrompt'))}
              </p>
              ${t.isMultiPrompt && t.prompts && t.prompts.length > 1 && html`
                <details className="mt-2">
                  <summary className="text-[11px] text-ink3 cursor-pointer">${tr('tasks.drawer.expandPrompts', { n: t.prompts.length })}</summary>
                  <ol className="mt-1 pl-4 list-decimal text-[11px] text-ink2 leading-[1.7]">
                    ${t.prompts.map((p, i) =>
                      html`<li key=${i}>${typeof p === 'string' ? p : (p && p.text) || JSON.stringify(p)}</li>`
                    )}
                  </ol>
                </details>
              `}
            </div>

            ${videoUrl && html`
              <video
                className="mt-4 w-full rounded-[6px] bg-black"
                src=${videoUrl}
                controls
                preload="metadata"
                playsInline
              ></video>
            `}

            <div className="mt-4">
              <${Row} label=${tr('tasks.drawer.preset')}>${t.preset || '-'}</${Row}>
              <${Row} label=${tr('tasks.drawer.model')}>${t.model || '-'}</${Row}>
              <${Row} label=${tr('tasks.drawer.resolution')}>${t.resolution || '-'}</${Row}>
              <${Row} label=${tr('tasks.drawer.clips')}>${(t.totalClips || 0) + ' × ' + (t.clipDuration || 0) + 's'}</${Row}>
              <${Row} label=${tr('tasks.drawer.finalDuration')}>${t.totalDuration ? t.totalDuration + 's' : '-'}</${Row}>
              <${Row} label=${tr('tasks.drawer.created')}>
                ${t.createdAt ? fmtDateTime(t.createdAt) : '-'}
              </${Row}>
              ${t.error && html`<${Row} label=${tr('tasks.drawer.error')}><span className="text-danger">${t.error}</span></${Row}>`}
              ${t.failureCode && html`<${Row} label=${tr('tasks.drawer.aborted')}>
                <span className="text-warn">${st.note || t.failureCode}</span>
                ${t.recoverable ? html`<span className="text-[11px] text-ink3"> · ${tr('tasks.drawer.resumable')}</span>` : null}
                ${t.pauseTimedOutAt && html`
                  <span className="text-[10px] text-ink3">
                    （${fmtDateTime(t.pauseTimedOutAt)}）
                  </span>
                `}
              </${Row}>`}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              ${(t.status === 'failed' || t.status === 'partial') && html`
                <button onClick=${() => postAction('retry')} disabled=${!!busyAct}
                  className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                             hover:bg-white/[.06] disabled:opacity-40">${tr('tasks.drawer.retry')}</button>
                <button onClick=${() => postAction('resume')} disabled=${!!busyAct}
                  className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                             hover:bg-white/[.06] disabled:opacity-40">${tr('tasks.drawer.continueWithClips')}</button>
                <button onClick=${() => postAction('continue')} disabled=${!!busyAct}
                  className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                             hover:bg-white/[.06] disabled:opacity-40">${tr('tasks.drawer.continueTask')}</button>
              `}
              ${videoUrl && html`
                <a href=${videoUrl} download
                  className="h-7 px-2.5 inline-flex items-center rounded-[5px] border border-white/[.10]
                             text-[11px] text-ink2 hover:bg-white/[.06]">${tr('tasks.drawer.downloadFinal')}</a>
              `}
              ${videoUrl && html`
                <button onClick=${() => openEdit(t.taskId)}
                  className="h-7 px-2.5 rounded-[5px] border border-accent/40 text-[11px] text-accent
                             hover:bg-accent/[.08]">${tr('tasks.drawer.openInEditor')}</button>
              `}
              ${actErr && html`<span className="text-[11px] text-danger">${actErr}</span>`}
            </div>

            ${(() => {
              const failed = (t.clips || []).filter((c) => c && c.status === 'failed');
              if (!failed.length) return null;
              return html`
                <div className="mt-4">
                  <h4 className="mb-1 text-[12px] font-medium text-ink">${tr('tasks.drawer.failedClips', { n: failed.length })}</h4>
                  <p className="mb-2 text-[10px] leading-[1.6] text-ink3">
                    ${tr('tasks.drawer.failedClipsHint')}
                  </p>
                  <ul className="divide-y divide-white/[.05] rounded-[8px] border border-white/[.07] bg-s3 px-2.5">
                    ${failed.map((c) => html`
                      <li key=${c.index} className="flex items-center gap-2 py-2">
                        <span className="shrink-0 text-[11px] font-num text-ink2">#${c.index + 1}</span>
                        <span className="min-w-0 flex-1 text-[11px] leading-[1.6] text-ink3 break-words">
                          ${c.error || (c.qcResult && c.qcResult.reason) || tr('tasks.drawer.failedBadge')}
                        </span>
                        <button
                          onClick=${() => regenerateOne(c.index)}
                          disabled=${!!busyAct}
                          className="h-6 px-2 rounded-[4px] border border-white/[.10] text-[11px] text-ink2
                                     hover:bg-white/[.06] disabled:opacity-40"
                        >${busyAct === 'clip-' + c.index ? tr('tasks.drawer.regenerating') : tr('tasks.drawer.regenerate')}</button>
                      </li>
                    `)}
                  </ul>
                </div>
              `;
            })()}

            ${(() => {
              const cm = pickColorMatch(t);
              const b = colorMatchBadge(cm.result);
              return html`
                <h4 className="mt-5 mb-1 text-[12px] font-medium text-ink">${tr('tasks.drawer.colorMatch')}</h4>
                <div className="flex items-center gap-2 py-[5px] border-b border-white/[.04]">
                  <span className="w-[68px] shrink-0 text-[12px] text-ink3">${tr('tasks.drawer.userRequest')}</span>
                  <span className=${'text-[12px] ' + (cm.intent ? 'text-ink' : 'text-ink3')}>
                    ${cm.intent ? tr('tasks.drawer.enabled') : tr('tasks.drawer.notRequested')}${cm.maxGain != null ? tr('tasks.drawer.maxGain', { value: cm.maxGain }) : ''}
                  </span>
                </div>
                <div className="flex items-start gap-2 py-[5px]">
                  <span className="w-[68px] shrink-0 text-[12px] text-ink3">${tr('tasks.drawer.actualResult')}</span>
                  <span className="flex-1 min-w-0">
                    <span className=${'text-[12px] ' + b.cls} title=${b.title}>${b.text}</span>
                    ${b.title && html`
                      <span className="block mt-[2px] text-[10px] leading-[1.6] text-ink3 break-words">${b.title}</span>
                    `}
                  </span>
                </div>
              `;
            })()}

            <h4 className="mt-5 mb-1 text-[12px] font-medium text-ink">${tr('tasks.drawer.adjustments')}</h4>
            ${(() => {
              const adj = t.adjust && typeof t.adjust === 'object' ? t.adjust : null;
              const items = adj
                ? Object.keys(ADJ_LABELS).filter((k) => adj[k] !== undefined && adj[k] !== 0)
                : [];
              if (!items.length) {
                return html`<p className="text-[12px] text-ink3 py-[5px]">${tr('tasks.drawer.noAdjustments')}</p>`;
              }
              return html`
                <div className="flex flex-wrap gap-x-4 gap-y-1 py-[5px] text-[12px] text-ink2">
                  ${items.map((k) => html`
                    <span key=${k}>
                      ${tr(ADJ_LABELS[k])}
                      <b className="font-num text-ink font-normal">${adj[k] > 0 ? '+' + adj[k] : adj[k]}</b>
                    </span>
                  `)}
                </div>
                <p className="text-[10px] leading-[1.6] text-ink3">
                  ${t.adjustApplied && t.adjustApplied.filter
                    ? tr('tasks.drawer.appliedOnExport', { list: t.adjustApplied.filter })
                    : tr('tasks.drawer.adjustmentsSaved')}
                </p>
              `;
            })()}

            <h4 className="mt-5 mb-1 text-[12px] font-medium text-ink">${tr('tasks.drawer.pipeline')}</h4>
            <ul className="divide-y divide-white/[.04]">
              ${steps.map((k) => {
                const s = t.steps[k];
                const b = qcBadge(s.qcDetails);
                const reason = s.qcDetails && (s.qcDetails.reason || s.error);
                const stepLabel = has(STEP_LABEL_KEY[k] || '') ? tr(STEP_LABEL_KEY[k]) : (s.name || k);
                return html`
                  <li key=${k} className="py-[7px]">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-ink">${stepLabel}</span>
                      <span className="flex-1"></span>
                      <span className=${'text-[11px] ' + b.cls}>${b.text}</span>
                      ${s.duration > 0 && html`<span className="text-[10px] text-ink3 font-num">${s.duration}ms</span>`}
                    </div>
                    ${reason && html`<p className="mt-1 text-[10px] leading-[1.6] text-ink3">${reason}</p>`}
                  </li>
                `;
              })}
            </ul>
          `}
        </div>
      </aside>
    </div>
  `;
}
