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
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

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

function qcBadge(qc) {
  if (!qc) return { text: '未执行', cls: 'text-ink3' };
  if (qc.passed === true) return { text: '通过', cls: 'text-accent' };
  if (qc.legitimateSkip === true) return { text: '按计划跳过', cls: 'text-ink3' };
  if (qc.skipped === true) return { text: '跳过·不可判', cls: 'text-danger' };
  return { text: '不通过', cls: 'text-danger' };
}

// 校色四态（2026-10-27 契约，字段直接读，不从 reason 猜）
//   任务级意图：task.colorMatch { enabled, maxGain } / null = 没要求
//   拼接结果：  task.steps.concatenation.qcDetails.colorMatch { state, reason, applied, total, luts }
//   终检汇总：  task.finalQC.details.colorContinuity.colorMatchState / colorMatchReason
function colorMatchBadge(cm) {
  if (!cm || !cm.state) return { text: '未执行', cls: 'text-warn', title: '没有拿到校色结果字段' };
  switch (cm.state) {
    case 'applied':
      return {
        text: '已校色',
        cls: 'text-accent',
        title: [
          cm.reason || '',
          cm.applied != null && cm.total != null ? `已校色 ${cm.applied}/${cm.total} 段` : '',
          Array.isArray(cm.luts) ? `${cm.luts.length} 组 LUT` : ''
        ].filter(Boolean).join(' · ')
      };
    case 'disabled':
      return { text: '未校色', cls: 'text-ink3', title: cm.reason || '默认关闭，本次未开启' };
    case 'skipped':
      return { text: '校色未执行', cls: 'text-warn', title: cm.reason || cm.colorMatchReason || '按设计跳过' };
    case 'failed':
      return {
        text: '校色失败',
        cls: 'text-danger',
        title: (cm.reason || '') + '（成片仍按原片产出，不是出片失败）'
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

function statusStyle(status) {
  switch (status) {
    case 'completed': return { text: '已完成', dot: 'bg-accent', cls: 'text-accent' };
    case 'failed': return { text: '失败', dot: 'bg-danger', cls: 'text-danger' };
    case 'generating': return { text: '生成中', dot: 'bg-warn', cls: 'text-warn' };
    case 'partial': return { text: '部分完成', dot: 'bg-warn', cls: 'text-warn' };
    case 'pending': return { text: '等待中', dot: 'bg-ink3', cls: 'text-ink3' };
    default: return { text: status || '-', dot: 'bg-ink3', cls: 'text-ink3' };
  }
}

// outputPath 是绝对路径，转成 /output/<文件名> 才能被静态目录下发
function toOutputUrl(p) {
  if (!p) return null;
  const name = String(p).split(/[\\/]/).pop();
  return name ? '/output/' + encodeURIComponent(name) : null;
}

function Row({ label, children }) {
  return html`
    <div className="flex gap-3 py-[7px] border-b border-black/[.04] last:border-0">
      <span className="w-[68px] shrink-0 text-[12px] text-ink3">${label}</span>
      <span className="flex-1 min-w-0 text-[12px] text-ink break-words">${children}</span>
    </div>
  `;
}

export function TaskDrawer({ taskId, onClose }) {
  const [state, setState] = useState({ loading: true, task: null, error: null });

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
  }, [taskId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = state.task;
  const st = statusStyle(t && t.status);
  const videoUrl = t ? toOutputUrl(t.outputPath) : null;
  const steps = t && t.steps ? STEP_ORDER.filter((k) => t.steps[k]) : [];

  return html`
    <div className="fixed inset-0 z-40">
      <div
        className="absolute inset-0 bg-black/25"
        onClick=${onClose}
        aria-hidden="true"
      ></div>

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
        className="absolute right-0 top-0 bottom-0 w-[min(760px,94vw)] bg-s3 border-l border-black/[.08]
                   shadow-[-16px_0_48px_rgba(0,0,0,.12)] flex flex-col drawer-in"
        onClick=${(e) => e.stopPropagation()}
      >
        <header className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-black/[.06]">
          <span className=${'w-[7px] h-[7px] rounded-full ' + st.dot}></span>
          <span className=${'text-[12px] ' + st.cls}>${st.text}</span>
          <span className="text-[11px] text-ink3 font-num truncate">${taskId}</span>
          <span className="flex-1"></span>
          <button
            onClick=${onClose}
            className="h-7 w-7 grid place-items-center rounded-[5px] text-ink2 hover:bg-black/[.05]"
            aria-label="关闭"
          >✕</button>
        </header>

        <div className="flex-1 min-h-0 overflow-auto px-4 py-4">
          ${state.loading && html`<p className="text-[12px] text-ink3">加载中…</p>`}
          ${state.error && html`<p className="text-[12px] text-danger">读取失败：${state.error}</p>`}

          ${t && html`
            <div>
              <p className="text-[13px] leading-[1.75] text-ink">
                ${(t.optimizedPrompt || t.prompt || '(无提示词)')}
              </p>
              ${t.isMultiPrompt && t.prompts && t.prompts.length > 1 && html`
                <details className="mt-2">
                  <summary className="text-[11px] text-ink3 cursor-pointer">展开 ${t.prompts.length} 条分镜提示词</summary>
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
              <${Row} label="档位">${t.preset || '-'}</${Row}>
              <${Row} label="模型">${t.model || '-'}</${Row}>
              <${Row} label="分辨率">${t.resolution || '-'}</${Row}>
              <${Row} label="片段">${(t.totalClips || 0) + ' × ' + (t.clipDuration || 0) + 's'}</${Row}>
              <${Row} label="成片时长">${t.totalDuration ? t.totalDuration + 's' : '-'}</${Row}>
              <${Row} label="创建">
                ${t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-'}
              </${Row}>
              ${t.error && html`<${Row} label="错误"><span className="text-danger">${t.error}</span></${Row}>`}
            </div>

            ${(() => {
              const cm = pickColorMatch(t);
              const b = colorMatchBadge(cm.result);
              return html`
                <h4 className="mt-5 mb-1 text-[12px] font-medium text-ink">校色</h4>
                <div className="flex items-center gap-2 py-[5px] border-b border-black/[.04]">
                  <span className="w-[68px] shrink-0 text-[12px] text-ink3">用户要求</span>
                  <span className=${'text-[12px] ' + (cm.intent ? 'text-ink' : 'text-ink3')}>
                    ${cm.intent ? '开启' : '未要求（默认关）'}${cm.maxGain != null ? ' · 增益上限 ' + cm.maxGain : ''}
                  </span>
                </div>
                <div className="flex items-start gap-2 py-[5px]">
                  <span className="w-[68px] shrink-0 text-[12px] text-ink3">实际结果</span>
                  <span className="flex-1 min-w-0">
                    <span className=${'text-[12px] ' + b.cls} title=${b.title}>${b.text}</span>
                    ${b.title && html`
                      <span className="block mt-[2px] text-[10px] leading-[1.6] text-ink3 break-words">${b.title}</span>
                    `}
                  </span>
                </div>
              `;
            })()}

            <h4 className="mt-5 mb-1 text-[12px] font-medium text-ink">流水线</h4>
            <ul className="divide-y divide-black/[.04]">
              ${steps.map((k) => {
                const s = t.steps[k];
                const b = qcBadge(s.qcDetails);
                const reason = s.qcDetails && (s.qcDetails.reason || s.error);
                return html`
                  <li key=${k} className="py-[7px]">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-ink">${s.name || k}</span>
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
