// ============================================================
// 小智 2.0 V2 · 失败诊断的「一键修复」与设置变更「确认变更」
// ------------------------------------------------------------
// 后端：
//   POST /api/assistant/repair            { taskId, action:'continue', sessionId, approved:true, runtimeConfig? }
//   POST /api/assistant/settings/confirm  { sessionId, changeId, approved:true }
// 硬约束（scripts/verify-assistant-frontend.js 逐条断言）：
//   · 只对 diagnosis.suggestions 里 executable===true 且 action==='continue' 的项给按钮；
//   · 点击先 window.confirm（文案说明「复用已成功片段，可能产生费用」）。
//     **未确认绝不发 approved:true**：builder 在 confirmed!==true 时返回 null，
//     调用方拿到 null 直接 return，不会发请求；
//   · 不自动重跑：只有按钮点击这一条路径；
//   · 结果如实展示成功/失败，失败不假装成功；成功由上层刷新状态与 context。
// ============================================================
import { t as tr } from '../i18n/index.js';
import { readRuntimeConfig } from '../store.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useState } = React;

/** 可执行的一键修复项：executable===true 且 action==='continue'（L3 由用户点击确认）。 */
export function executableRepairs(diagnosis) {
  if (!diagnosis || !Array.isArray(diagnosis.suggestions)) return [];
  return diagnosis.suggestions.filter((s) => s && s.executable === true && s.action === 'continue');
}

// 2026-11-23（同轮补）：浏览器里有没有这个通道的 Key（只看映射结果，不读值、不打印）。
// 重启后任务落盘的 Key 已被 redact 清空，这里没 Key 时续跑会「静默降级 Mock」
// （src/generators/index.js:78）——用户以为在续跑付费任务，实际生成的是合成画面。
function hasRuntimeKey(rc, model) {
  if (!model || model === 'mock') return true;
  if (!rc) return false;
  if (model === 'kling') return !!(rc.klingAccessKey && rc.klingSecretKey);
  return !!rc.apiKey;
}

/** 修复请求体：确认门。confirmed !== true → null（绝不生成 approved:true）。 */
export function buildRepairRequest(opts = {}) {
  if (opts.confirmed !== true) return null;
  if (!opts.taskId) return null;
  const body = {
    taskId: String(opts.taskId),
    action: 'continue',
    sessionId: String(opts.sessionId || ''),
    approved: true
  };
  if (opts.runtimeConfig && typeof opts.runtimeConfig === 'object') {
    body.runtimeConfig = opts.runtimeConfig;
  }
  return body;
}

/** 设置确认请求体：确认门 + 必须带同一 changeId。 */
export function buildSettingsConfirmRequest(opts = {}) {
  if (opts.confirmed !== true) return null;
  if (!opts.changeId) return null;
  return {
    sessionId: String(opts.sessionId || ''),
    changeId: String(opts.changeId),
    approved: true
  };
}

function errorText(prefixKey, j, r) {
  return tr(prefixKey, { error: (j && (j.error || j.code)) || ('HTTP ' + (r && r.status ? r.status : '?')) });
}

export function RepairCard({ diagnosis, sessionId, onResult } = {}) {
  const items = executableRepairs(diagnosis);
  const [busyId, setBusyId] = useState('');
  const [result, setResult] = useState(null);

  if (!items.length) return null;

  function report(ok, text) {
    setResult({ ok, text });
    if (typeof onResult === 'function') onResult(ok, text);
  }

  async function run(suggestion) {
    if (busyId) return;
    // 确认门（L3）：未点「确定」不发请求、不带 approved。
    if (!window.confirm(tr('assistant.repair.confirm', { label: suggestion.label }))) return;
    const runtime = readRuntimeConfig(diagnosis && diagnosis.model ? diagnosis.model : undefined);
    // 没 Key 又不接受 Mock：一个请求都不发（与任务详情「补跑」同一道保护）。
    if (!hasRuntimeKey(runtime, diagnosis && diagnosis.model)
      && !window.confirm(tr('assistant.repair.noKeyConfirm'))) return;
    const body = buildRepairRequest({
      taskId: diagnosis.taskId,
      sessionId,
      runtimeConfig: runtime,
      confirmed: true
    });
    if (!body) return;
    setBusyId(suggestion.id || suggestion.action || 'continue');
    setResult(null);
    try {
      const r = await fetch('/api/assistant/repair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok !== true) {
        report(false, errorText('assistant.repair.failed', j, r));
        return;
      }
      report(true, tr('assistant.repair.ok', {
        taskId: j.taskId || (diagnosis && diagnosis.taskId) || '',
        pending: Array.isArray(j.pending) ? j.pending.length : 0
      }));
    } catch (e) {
      report(false, tr('assistant.repair.failed', { error: (e && e.message) || String(e) }));
    } finally {
      setBusyId('');
    }
  }

  return html`
    <div className="rounded-[8px] border border-accent/25 bg-accent/[.06] p-3" data-card="assistant-repair">
      <p className="text-[11px] font-medium text-ink">${tr('assistant.repair.title')}</p>
      <p className="mt-1 text-[11px] leading-[1.6] text-ink3">${tr('assistant.repair.hint')}</p>
      ${items.map((s) => html`
        <div key=${s.id || s.action} className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="flex-1 text-[12px] leading-[1.6] text-ink">${s.label}</span>
          <button
            type="button"
            disabled=${!!busyId}
            onClick=${() => run(s)}
            className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
          >${busyId ? tr('assistant.repair.busy') : tr('assistant.repair.action')}</button>
        </div>
      `)}
      ${result ? html`
        <p className=${'mt-2 text-[11px] leading-[1.6] ' + (result.ok ? 'text-accent' : 'text-danger')}>
          ${result.text}
        </p>
      ` : null}
    </div>
  `;
}

export function PendingChangeCard({ pendingChange, sessionId, onResult } = {}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  if (!pendingChange || pendingChange.requiresConfirm !== true) return null;
  const label = pendingChange.label || pendingChange.key || '';

  function report(ok, text) {
    setResult({ ok, text });
    if (typeof onResult === 'function') onResult(ok, text);
  }

  async function confirmChange() {
    if (busy) return;
    // 确认门（L3）：未点「确定」不发请求、不带 approved。
    if (!window.confirm(tr('assistant.pending.confirmDialog', { label }))) return;
    const body = buildSettingsConfirmRequest({
      sessionId,
      changeId: pendingChange.changeId,
      confirmed: true
    });
    if (!body) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/assistant/settings/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok !== true) {
        report(false, errorText('assistant.pending.failed', j, r));
        return;
      }
      report(true, tr('assistant.pending.ok', {
        label: (j.applied && j.applied.label) || label
      }));
    } catch (e) {
      report(false, tr('assistant.pending.failed', { error: (e && e.message) || String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div className="rounded-[8px] border border-warn/30 bg-warn/[.06] p-3" data-card="assistant-pending">
      <p className="text-[11px] font-medium text-ink">${tr('assistant.pending.title')}</p>
      <p className="mt-1 text-[12px] leading-[1.7] text-ink">${tr('assistant.pending.change', { label })}</p>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled=${busy}
          onClick=${confirmChange}
          className="h-7 px-2.5 rounded-[5px] bg-accent text-onaccent text-[11px] disabled:opacity-40"
        >${busy ? tr('assistant.pending.busy') : tr('assistant.pending.confirm')}</button>
        <span className="text-[10px] text-ink3">${tr('assistant.pending.ttl')}</span>
      </div>
      ${result ? html`
        <p className=${'mt-2 text-[11px] leading-[1.6] ' + (result.ok ? 'text-accent' : 'text-danger')}>
          ${result.text}
        </p>
      ` : null}
    </div>
  `;
}
