// ============================================================
// 小智 2.0 V2 · 设置页「小智偏好（服务端）」
// ------------------------------------------------------------
// 接口：
//   GET  /api/assistant/preferences        → { ok, preferences, broadcast, clearable }
//   POST /api/assistant/preferences/clear  → 必须 { approved:true }
// 硬约束（scripts/verify-assistant-frontend.js 逐条断言）：
//   · 只读展示 model / resolution / clipDurationSec / bgmStyle（有 updatedAt 就显示）；
//   · 「清空偏好」**必须先二次确认**：按钮始终可点，点击后出**内联确认**（确认清空 / 取消）；
//     未确认绝不发请求，approved:true 只能在确认之后由 buildClearPreferencesRequest 生成；
//   · 无偏好时点击提示「当前没有可清空的偏好」（不再把按钮禁用，2026-11-18 用户反馈）；
//   · 结果三态展示：成功（removed=true/false 分开说）/ 业务失败 / 网络失败，不假装成功。
// ============================================================
import { t as tr, fmtDateTime } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

/** 确认门：confirmed !== true 时返回 null（调用方据此不发请求）。 */
export function buildClearPreferencesRequest(opts = {}) {
  if (opts.confirmed !== true) return null;
  return { approved: true };
}

/** 偏好 → 展示行（只读；locale 在调用时解析）。 */
export function describePreferences(pref) {
  if (!pref || typeof pref !== 'object') return [];
  const rows = [];
  if (pref.model) {
    rows.push({
      key: 'model',
      label: tr('settings.xiaozhi.model'),
      value: pref.modelLabel
        ? tr('settings.xiaozhi.modelValue', { label: pref.modelLabel, id: pref.model })
        : String(pref.model)
    });
  }
  if (pref.resolution) {
    rows.push({ key: 'resolution', label: tr('settings.xiaozhi.resolution'), value: String(pref.resolution) });
  }
  if (pref.clipDurationSec) {
    rows.push({
      key: 'clipDuration',
      label: tr('settings.xiaozhi.clipDuration'),
      value: tr('settings.xiaozhi.seconds', { n: pref.clipDurationSec })
    });
  }
  if (pref.bgmStyle) {
    rows.push({ key: 'bgmStyle', label: tr('settings.xiaozhi.bgmStyle'), value: String(pref.bgmStyle) });
  }
  return rows;
}

async function readPreferences() {
  const r = await fetch('/api/assistant/preferences', { credentials: 'same-origin' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok !== true) {
    throw new Error((j && (j.error || j.code)) || ('HTTP ' + r.status));
  }
  return j;
}

export function AssistantPreferencesSection() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);

  function load() {
    setLoading(true);
    setError('');
    readPreferences()
      .then((j) => { setData(j); })
      .catch((e) => {
        setData(null);
        setError(tr('settings.xiaozhi.loadFailed', { error: (e && e.message) || String(e) }));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  // 用户点「清空偏好」：无偏好就给提示（按钮始终可点），有偏好才进入内联确认。
  // 2026-11-18 用户反馈：按钮被 disabled=${!pref} 禁用，看起来像确认框点不了。
  function startClear() {
    if (busy) return;
    if (!pref) {
      setConfirming(false);
      setResult({ tone: 'muted', text: tr('settings.xiaozhi.noneToClear') });
      return;
    }
    setResult(null);
    setConfirming(true);
  }

  function cancelClear() {
    if (busy) return;
    setConfirming(false);
    setResult(null);
  }

  async function clearPreferences() {
    if (busy) return;
    // 内联确认的「确认清空」才会走到这里；未确认的直接 no-op（approved 门在 builder 再拦一次）。
    const body = buildClearPreferencesRequest({ confirmed: true });
    if (!body) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/assistant/preferences/clear', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok !== true) {
        setResult({
          tone: 'error',
          text: tr('settings.xiaozhi.clearFailed', {
            error: (j && (j.error || j.code)) || ('HTTP ' + r.status)
          })
        });
        return;
      }
      setResult({
        tone: 'ok',
        text: j.removed ? tr('settings.xiaozhi.clearDone') : tr('settings.xiaozhi.clearNothing')
      });
      setData({ ok: true, preferences: null });
    } catch (e) {
      setResult({
        tone: 'error',
        text: tr('settings.xiaozhi.clearFailed', { error: (e && e.message) || String(e) })
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const pref = data && data.preferences ? data.preferences : null;
  const rows = describePreferences(pref);

  return html`
    <div data-section="xiaozhi-preferences">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-ink3">${tr('settings.xiaozhi.serverNote')}</span>
        <span className="flex-1"></span>
        <button
          type="button"
          onClick=${load}
          disabled=${loading || busy}
          className="h-7 px-2 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                     hover:bg-white/[.05] disabled:opacity-40"
        >${loading ? tr('settings.xiaozhi.loading') : tr('settings.xiaozhi.refresh')}</button>
        <button
          type="button"
          onClick=${startClear}
          disabled=${busy}
          className="h-7 px-2 rounded-[5px] border border-danger/50 text-[11px] text-danger
                     hover:bg-danger/[.08] disabled:opacity-40"
        >${busy ? tr('settings.xiaozhi.clearing') : tr('settings.xiaozhi.clear')}</button>
      </div>
      ${confirming && pref ? html`
        <div className="mt-1.5 flex items-center gap-2 flex-wrap rounded-[6px] border border-danger/30 bg-danger/[.06] px-2.5 py-2">
          <span className="text-[11px] leading-[1.6] text-ink2">${tr('settings.xiaozhi.clearConfirm')}</span>
          <span className="flex-1"></span>
          <button
            type="button"
            onClick=${clearPreferences}
            disabled=${busy}
            className="h-7 px-2 rounded-[5px] bg-danger text-white text-[11px] disabled:opacity-40"
          >${busy ? tr('settings.xiaozhi.clearing') : tr('settings.xiaozhi.clearConfirmYes')}</button>
          <button
            type="button"
            onClick=${cancelClear}
            disabled=${busy}
            className="h-7 px-2 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                       hover:bg-white/[.05] disabled:opacity-40"
          >${tr('common.cancel')}</button>
        </div>
      ` : null}
      ${error ? html`
        <p className="mt-1.5 text-[11px] leading-[1.6] text-danger">${error}</p>
      ` : null}
      ${!error && !loading && !pref ? html`
        <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">${tr('settings.xiaozhi.empty')}</p>
      ` : null}
      ${rows.map((r) => html`
        <div key=${r.key} className="mt-1 flex items-center gap-2">
          <span className="w-[84px] shrink-0 text-[11px] text-ink3">${r.label}</span>
          <span className="flex-1 text-[12px] text-ink break-words">${r.value}</span>
        </div>
      `)}
      ${pref && pref.updatedAt ? html`
        <p className="mt-1.5 text-[10px] text-ink3">
          ${tr('settings.xiaozhi.updatedAt', { at: fmtDateTime(pref.updatedAt) })}
        </p>
      ` : null}
      ${result ? html`
        <p className=${'mt-1.5 text-[11px] leading-[1.6] '
          + (result.tone === 'error' ? 'text-danger' : (result.tone === 'ok' ? 'text-accent' : 'text-ink3'))}>
          ${result.text}
        </p>
      ` : null}
    </div>
  `;
}
