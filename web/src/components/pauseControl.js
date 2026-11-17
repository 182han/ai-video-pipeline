// ============================================================
// 暂停 / 继续（2026-10-31 新增）
// ------------------------------------------------------------
// 契约来源：docs/spec/pause-capability-spec.md §4（以实现为准）
//   POST /api/tasks/:id/pause    → 200 {success} | 200 {alreadyPaused} | 400 | 404
//   POST /api/tasks/:id/unpause  → 200 {success} | 400 | 404
//   GET  /api/tasks/:id/pause-state → { paused, status }
// WebSocket 没有专用 paused 事件，前端读 task.status === 'paused'。
// failureCode 用来区分「暂停导致的中止」与「普通生成失败」，不占用 HTTP 状态码。
// ============================================================
import { t } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useState } = React;

export const RUNNING_STATUSES = ['generating', 'paused'];

export function isRunningTask(t) {
  return !!t && RUNNING_STATUSES.indexOf(t.status) !== -1;
}

// 状态展示：paused 单独一态；failed 若带 pause_* 则不套普通失败的红色文案
export function statusMeta(status, task) {
  const fc = task && task.failureCode;
  switch (status) {
    case 'completed':
      return { text: t('tasks.status.completed'), dot: 'bg-accent', cls: 'text-accent' };
    case 'generating':
      return { text: t('tasks.status.generating'), dot: 'bg-warn', cls: 'text-warn' };
    case 'paused':
      return { text: t('tasks.status.paused'), dot: 'bg-warn', cls: 'text-warn' };
    case 'partial':
      return { text: t('tasks.status.partial'), dot: 'bg-warn', cls: 'text-warn' };
    case 'pending':
      return { text: t('tasks.status.pending'), dot: 'bg-ink3', cls: 'text-ink3' };
    case 'failed':
      if (fc === 'pause_timeout') {
        return {
          text: t('tasks.status.abortedResumable'), dot: 'bg-warn', cls: 'text-warn',
          note: t('tasks.note.pauseTimeout')
        };
      }
      if (fc === 'pause_interrupted') {
        return {
          text: t('tasks.status.abortedResumable'), dot: 'bg-warn', cls: 'text-warn',
          note: t('tasks.note.pauseInterrupted')
        };
      }
      return { text: t('tasks.status.failed'), dot: 'bg-danger', cls: 'text-danger' };
    default:
      return { text: status || '-', dot: 'bg-ink3', cls: 'text-ink3' };
  }
}

export async function callPause(taskId, action) {
  const r = await fetch(
    '/api/tasks/' + encodeURIComponent(taskId) + '/' + action,
    { method: 'POST', credentials: 'same-origin' }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// 只在 generating / paused 时出现；其他状态返回 null（不显示假按钮）
export function PauseButton({ taskId, status, onChanged, compact }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!taskId || RUNNING_STATUSES.indexOf(status) === -1) return null;
  const action = status === 'paused' ? 'unpause' : 'pause';
  const label = action === 'pause' ? t('tasks.pause.pause') : t('tasks.pause.resume');

  async function onClick(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await callPause(taskId, action);
    } catch (e2) {
      setErr(e2.message || t('tasks.pause.failed'));
    } finally {
      setBusy(false);
      if (onChanged) onChanged();
    }
  }

  return html`
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick=${onClick}
        disabled=${busy}
        title=${err || (action === 'pause' ? t('tasks.pause.pauseTitle') : t('tasks.pause.resumeTitle'))}
        className=${[
          'rounded-[5px] border transition-colors disabled:opacity-40',
          compact ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-[12px]',
          action === 'pause'
            ? 'border-white/[.10] text-ink2 hover:bg-white/[.04]'
            : 'border-accent/40 text-accent hover:bg-accent/[.08]'
        ].join(' ')}
      >${busy ? '…' : label}</button>
      ${err && html`<span className="text-[10px] text-danger">${err}</span>`}
    </span>
  `;
}
