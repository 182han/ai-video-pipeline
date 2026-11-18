// ============================================================
// 库（2026-11-15 P2：合并片段 + 照片，新增成片与回收站）
// ------------------------------------------------------------
// 页面结构：一个「库」页，三个 tab（固定顺序）成片 / 片段 / 图片。
//   成片：GET /api/library 里 kind=final 的条目（含 origin=task|library|editor|orphan）
//   片段：GET /api/library?favorite=&q=&resolution=&model=
//         PUT /api/library/:id {favorite} · DELETE /api/library/:id（进回收站）
//         POST /api/library/:id/regenerate {prompt}
//   图片：GET /api/photos（全量：最终版 + 审核中 + 调色前后各版本）· PUT/DELETE /api/photos/:id
// 回收站：GET /api/recycle · POST /api/recycle/:type/:id/restore
//         DELETE /api/recycle/:type/:id · POST /api/recycle/:type/purge
// 删除分两步：页面删除只移入回收站；彻底删除必须在回收站抽屉里再确认一次。
// 2026-11-16 P6：历史记录页下线后，失败/未完成的成片任务在「成片」tab 顶部的
//   未完成卡片里可见（数据取 /api/tasks，排除 mock 与 clips_only），点开可补跑/重试。
// 配乐：仍保留 MusicView（导航入口已移除，配乐面板搬到剪辑台），深链 /music 兼容。
// ============================================================
import { navigate } from '../router.js';
import { setSeedPhoto } from '../createDraft.js';
import { TaskDrawer } from '../components/taskDrawer.js';
import { statusMeta } from '../components/pauseControl.js';
import { t as tr, tp, fmtDateTime } from '../i18n/index.js';

// 2026-11-18：任务回收站不再露原始 taskId（与 components/taskName.js 的 taskShortId 同一规则）。
// 说明：本文件 import 行数被 verify-photo-adjust-ui / verify-p6-offline 的静态断言锁定，
// 所以这里内联同一条规则、不新增 import；任务显示名统一逻辑仍在 components/taskName.js。
function shortTaskId(id) {
  const s = String(id === undefined || id === null ? '' : id).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= 14 ? s : s.slice(0, 9) + '…' + s.slice(-4);
}

// 2026-11-18 S0（A13）：未完成列表此前只显示半句 prompt，与其它页的「统一任务名」不一致。
// 本文件 import 行被静态断言锁定（见上方注释），所以这里内联同一套规则：
// 摘要（prompt/optimizedPrompt/theme）+ 模型 + 短 ID；都没有才显示「无提示词」。
function unfinishedName(t) {
  const task = t && typeof t === 'object' ? t : {};
  const raw = String(task.prompt || task.optimizedPrompt || task.theme || '').replace(/\s+/g, ' ').trim();
  const parts = [];
  if (raw) parts.push(raw.length > 56 ? raw.slice(0, 56) + '…' : raw);
  if (task.model) parts.push(String(task.model));
  const id = shortTaskId(task.taskId);
  if (id) parts.push(id);
  return parts.length ? parts.join(' · ') : tr('library.common.noPrompt');
}

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

function useJson(url, deps) {
  const [s, setS] = useState({ loading: true, data: null, error: null, tick: 0 });
  const reload = () => setS((x) => ({ ...x, tick: x.tick + 1 }));
  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: 'same-origin' })
      .then(async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => { if (alive) setS((x) => ({ ...x, loading: false, data: d, error: null })); })
      .catch((e) => { if (alive) setS((x) => ({ ...x, loading: false, data: null, error: e.message })); });
    return () => { alive = false; };
  }, [url, s.tick]);
  return [s, reload];
}

function Head({ title, sub, children }) {
  return html`
    <div className="flex items-center gap-3 mb-3.5">
      <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0">${title}</h1>
      <span className="text-[11px] text-ink3 font-num">${sub}</span>
      <span className="flex-1"></span>
      ${children}
    </div>
  `;
}

function Empty({ children }) {
  return html`<p className="py-9 text-center text-[12px] text-ink3">${children}</p>`;
}

// ---------------- 视频片段 ----------------
function costText(cost) {
  if (!cost) return '';
  // 未知模型不能显示成 ¥0.00（会误导成免费）；如实标“未配置”。
  if (cost.computed === false) return tr('library.common.unconfigured');
  const n = Number(cost.amount);
  return Number.isFinite(n) ? '¥' + n.toFixed(2) : '';
}

// 2026-11-18 S0（B4）：后端把「调色派生 · 不重复计费」当中文 label 塞进数据，英文界面必现中文。
// 用 cost.basis 这个稳定枚举在**显示层**本地化，不去改历史数据（改数据不可逆、且会与快照口径冲突）。
function costSuffix(cost) {
  if (!cost) return '';
  if (cost.basis === 'derived') return ' · ' + tr('library.common.costDerived');
  return cost.label ? ' · ' + cost.label : '';
}

function qcText(qc) {
  if (!qc) return tr('library.qc.notChecked');
  if (qc.passed) return tr('library.qc.passed');
  return tr('library.qc.failedPrefix') + (qc.level || tr('library.qc.failed'));
}

// ---------------- 库：公共小工具 ----------------
function fmtDurSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '--:--';
  const s = Math.round(n);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    return hh + ':' + String(mm % 60).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }
  return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

const ORIGIN_KEYS = { task: 'library.origin.task', library: 'library.origin.library', editor: 'library.origin.editor', orphan: 'library.origin.orphan' };
const originText = (o) => (o && ORIGIN_KEYS[o]) ? tr(ORIGIN_KEYS[o]) : (o || tr('library.common.unknown'));

// 费用：没有快照就显示“未知”，绝不写 ¥0.00（2026-11-15 口径）。
// 2026-11-18 S0（B3/C3）：同屏混币——片段写 ¥3.00、计划卡写 ¥12.00、预算写 $2.00，用户看不出关系。
// 改成「原币 + 括号近似另一种币」，两个都给，不制造新歧义。
// 注：7.2 只是**显示用**折算，不是结算口径；真正收口到单一价目表在后续阶段做。
const CNY_PER_USD = 7.2;
function costLabel(cost) {
  if (!cost) return tr('library.common.unknown');
  if (cost.computed === false) return tr('library.common.unknown');
  const n = Number(cost.amount);
  if (!Number.isFinite(n)) return tr('library.common.unknown');
  const cur = String(cost.currency || 'CNY').toUpperCase();
  if (cur === 'USD') return '$' + n.toFixed(2) + ' (≈¥' + (n * CNY_PER_USD).toFixed(2) + ')';
  return '¥' + n.toFixed(2) + ' (≈$' + (n / CNY_PER_USD).toFixed(2) + ')';
}

function qcBadge(qc) {
  if (!qc) return html`<span className="text-[10px] text-ink3">${tr('library.qc.notChecked')}</span>`;
  if (qc.passed) return html`<span className="text-[10px] text-accent">${tr('library.qc.passed')}</span>`;
  if (qc.unverified) return html`<span className="text-[10px] text-warn">${tr('library.qc.unverified')}</span>`;
  return html`<span className="text-[10px] text-danger">${tr('library.qc.failed')}</span>`;
}

// 缩略图：走 /api/library/:id/thumb（服务端抽帧缓存）；失败就显示占位，不装样子。
function Thumb({ id }) {
  const [bad, setBad] = useState(false);
  const box = { width: '86px', height: '48px', flex: '0 0 auto' };
  if (bad || !id) {
    return html`<span className="grid place-items-center bg-black rounded-[4px] text-[9px] text-ink3"
      style=${box}>${tr('library.common.noThumb')}</span>`;
  }
  return html`<img src=${'/api/library/' + encodeURIComponent(id) + '/thumb'} alt=""
    loading="lazy" onError=${() => setBad(true)}
    className="bg-black object-cover rounded-[4px]" style=${box} />`;
}

// 下载：直接给静态地址（媒体目录与页面同源，已登录即可）；文件名用库里的真实文件名。
function DownloadLink({ url, fileName, label }) {
  if (!url) return null;
  return html`<a href=${url} download=${fileName || ''}
    className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06] inline-flex items-center"
  >${label || tr('library.common.download')}</a>`;
}

export function ClipsPanel({ onChanged }) {
  const [fav, setFav] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState('');
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState(null);
  const [sourceVersions, setSourceVersions] = useState([]);

  useEffect(() => {
    const pid = detail && detail.sourcePhotoId;
    if (!pid) { setSourceVersions([]); return; }
    let alive = true;
    fetch('/api/photos/' + encodeURIComponent(pid), { credentials: 'same-origin' })
      .then((r) => r.json().catch(() => ({})))
      .then((j) => { if (alive) setSourceVersions(Array.isArray(j.versions) ? j.versions : []); })
      .catch(() => { if (alive) setSourceVersions([]); });
    return () => { alive = false; };
  }, [detail && detail.id]);

  const qs = new URLSearchParams();
  if (fav) qs.set('favorite', '1');
  if (q.trim()) qs.set('q', q.trim());
  if (res) qs.set('resolution', res);

  const [s, reload] = useJson('/api/library' + (qs.toString() ? '?' + qs : ''));

  const groups = (s.data && s.data.groups) || [];
  const facets = (s.data && s.data.facets) || {};
  const totals = (s.data && s.data.totals) || {};
  // /api/library 同时返回片段与成片；这个 tab 只显示片段（成片在「成片」tab）。
  const clipGroups = groups
    .map((g) => ({ ...g, items: (g.items || []).filter((it) => it.kind !== 'final') }))
    .filter((g) => g.items.length > 0);
  const clipCount = clipGroups.reduce((n, g) => n + g.items.length, 0);

  async function toggleFav(id, cur) {
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(id), {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: !cur })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      reload();
    } catch (e) { setErr(tr('library.clips.favFailed') + e.message); }
  }

  async function remove(id) {
    if (!window.confirm(tr('library.clips.deleteConfirm'))) return;
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      reload();
      if (onChanged) onChanged();
    } catch (e) { setErr(tr('library.clips.deleteFailed') + e.message); }
  }

  async function regen(it) {
    if (!window.confirm(tr('library.clips.regenConfirm'))) return;
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(it.id) + '/regenerate', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: it.prompt })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      window.alert(tr('library.clips.regenSubmitted'));
    } catch (e) { setErr(tr('library.clips.regenFailed') + e.message); }
  }

  return html`
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button onClick=${() => setFav((v) => !v)}
          className=${'h-8 px-3 rounded-[6px] text-[12px] border ' +
            (fav ? 'border-accent/50 text-accent' : 'border-white/[.10] text-ink2 hover:bg-white/[.05]')}
        >${tr('library.clips.onlyFav')}</button>
        <select value=${res} onChange=${(e) => setRes(e.target.value)}
          className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
          <option value="">${tr('library.clips.allResolutions')}</option>
          ${(facets.resolutions || []).map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
        </select>
        <input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder=${tr('library.clips.searchPlaceholder')}
          className="h-8 w-[190px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
        <span className="flex-1"></span>
        <span className="text-[11px] text-ink3">${tp('library.clips.count', clipCount)}${s.loading ? ' · ' + tr('library.common.loading') : (s.error ? ' · ' + tr('library.common.loadFailed') : '')}</span>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${clipGroups.length === 0 && !s.loading && html`<${Empty}>${tr('library.clips.empty')}</${Empty}>`}

      ${clipGroups.map((g) => html`
        <div key=${g.label} className="mb-4">
          <div className="flex items-baseline gap-2 border-b border-white/[.08] pb-1 mb-2">
            <span className="text-[12px] font-medium text-ink">${g.label}</span>
            <span className="text-[10px] text-ink3 font-num">${tp('library.clips.count', (g.items || []).length)}</span>
          </div>
          <div className="grid grid-cols-4 gap-3">
            ${(g.items || []).map((it) => html`
              <div key=${it.id} className="rounded-[6px] border border-white/[.08] bg-s1 overflow-hidden">
                <video src=${it.url} className="w-full aspect-video bg-black object-cover"
                  preload="metadata" muted playsInline controls></video>
                <div className="px-2 py-1.5">
                  <p className="text-[11px] leading-[1.5] text-ink2 line-clamp-2 min-h-[32px]">
                    ${(it.prompt || '').slice(0, 80)}
                  </p>
                  <p className="text-[10px] text-ink3 font-num flex items-center gap-1.5 flex-wrap">
                    <span>${fmtDurSec(it.durationSec)}</span>
                    <span className="opacity-40">·</span>
                    ${qcBadge(it.qc)}
                    ${it.status === 'failed' ? html`<span className="text-[10px] text-danger">${tr('library.clips.failed')}</span>` : null}
                    <span className="opacity-40">·</span>
                    <span>${tr('library.clips.cost', { cost: costLabel(it.cost) })}</span>
                  </p>
                  <div className="mt-1 flex items-center gap-2" style=${{ flexWrap: 'wrap', rowGap: '4px' }}>
                    <button onClick=${() => toggleFav(it.id, it.favorite)}
                      className=${'h-6 px-1.5 rounded-[4px] text-[12px] hover:bg-white/[.06] ' +
                        (it.favorite ? 'text-accent' : 'text-ink3')}
                    >${it.favorite ? '★' : '☆'}</button>
                    <span className="text-[10px] text-ink3 font-num truncate" style=${{ maxWidth: '96px' }}>${it.model || ''}</span>
                    <span className="flex-1"></span>
                    <button onClick=${() => setDetail(it)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06]">${tr('library.clips.detail')}</button>
                    <button onClick=${() => regen(it)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06]">${tr('library.clips.regenerate')}</button>
                    <${DownloadLink} url=${it.url} fileName=${it.fileName} />
                    <button onClick=${() => remove(it.id)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:text-danger hover:bg-white/[.06]">${tr('library.clips.delete')}</button>
                  </div>
                </div>
              </div>
            `)}
          </div>
        </div>
      `)}
      ${detail && html`
        <div
          style=${{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,7,5,.72)', display: 'grid', placeItems: 'center' }}
          onClick=${(e) => { if (e.target === e.currentTarget) setDetail(null); }}
        >
          <div style=${{ width: 'min(760px, 92vw)', maxHeight: '86vh', overflow: 'auto', background: 'var(--s1)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '10px', padding: '14px' }}>
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
              <b style=${{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>${tr('library.clips.detailTitle')}</b>
              <button onClick=${() => setDetail(null)} style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.clips.close')}</button>
            </div>
            <video src=${detail.url} controls playsInline style=${{ width: '100%', maxHeight: '340px', background: '#000', borderRadius: '6px' }}></video>
            <div style=${{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '6px 10px', marginTop: '12px', fontSize: '11.5px', lineHeight: 1.7 }}>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.clips.prompt')}</span>
              <span style=${{ color: 'var(--ink2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>${detail.prompt || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.clips.model')}</span>
              <span style=${{ color: 'var(--ink2)' }}>${detail.model || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.clips.spec')}</span>
              <span style=${{ color: 'var(--ink2)' }}>${[
                detail.resolution,
                detail.width && detail.height ? detail.width + '×' + detail.height : '',
                detail.fps ? detail.fps + 'fps' : '',
                detail.durationSec ? Number(detail.durationSec).toFixed(2) + 's' : '',
                detail.sizeBytes ? (Number(detail.sizeBytes) / 1048576).toFixed(2) + ' MB' : ''
              ].filter(Boolean).join(' · ')}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.clips.costLabel')}</span>
              <span style=${{ color: 'var(--ink2)' }}>${costText(detail.cost) || '-'}${costSuffix(detail.cost)}${detail.cost && detail.cost.attempts ? tr('library.common.attempts', { n: detail.cost.attempts }) : ''}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.clips.qcLabel')}</span>
              <span style=${{ color: 'var(--ink2)' }}>${qcText(detail.qc)}${detail.qc && detail.qc.reason ? ' · ' + detail.qc.reason : ''}${detail.qc && detail.qc.qcVersion ? ' · v' + detail.qc.qcVersion : ''}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.clips.sourceTask')}</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.taskId || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.clips.sourcePhoto')}</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.sourcePhotoId || '-'}</span>
              ${sourceVersions.length > 1 && html`
                <div style=${{ gridColumn: '1 / -1', marginTop: '4px' }}>
                  <div style=${{ fontSize: '11px', color: 'var(--ink3)', marginBottom: '6px' }}>${tr('library.clips.versionChain')}</div>
                  ${sourceVersions.slice(1).map((v, i) => {
                    const prev = sourceVersions[i];
                    return html`
                      <div key=${v.id} style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' }}>
                        <div><img src=${prev.url} style=${{ width: '100%', maxHeight: '150px', objectFit: 'contain', background: '#000', borderRadius: '4px' }} /><div style=${{ fontSize: '10px', color: 'var(--ink3)', textAlign: 'center' }}>V${prev.version}</div></div>
                        <div><img src=${v.url} style=${{ width: '100%', maxHeight: '150px', objectFit: 'contain', background: '#000', borderRadius: '4px' }} /><div style=${{ fontSize: '10px', color: 'var(--ink3)', textAlign: 'center' }}>V${v.version}${v.isFinal ? ' · ' + tr('library.common.finalVersion') : ''}</div></div>
                      </div>`;
                  })}
                </div>`}
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.common.file')}</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.fileName || '-'}</span>
            </div>
            <div style=${{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button
                onClick=${() => { toggleFav(detail.id, detail.favorite); setDetail(null); }}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}
              >${detail.favorite ? tr('library.clips.unfavorite') : tr('library.clips.favorite')}</button>
              <button
                onClick=${() => { regen(detail); setDetail(null); }}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}
              >${tr('library.clips.regenSamePrompt')}</button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

// ---------------- 照片 ----------------
// 2026-11-11：图片库落地。生成时自动入库（含提示词），这里做列表 / 人工审核 / 删除。
// 审核通过 = 这张图可以用作下一步「图生视频」的输入（厂商通道按确认后接入）。
const PHOTO_STATUS_KEYS = { pending: 'library.photos.status.pending', approved: 'library.photos.status.approved', rejected: 'library.photos.status.rejected' };

// ---------------- 照片手动调色（2026-11-16 契约 §3.5） ----------------
// 接口：POST /api/photos/:id/adjust
//   调色 { brightness, contrast, saturation, temperature }（各 -100..100 整数，绝对值，每次从原图重渲）
//   回退 { reset: true }
// 响应：{ ok, adjusted, reverted, filter, url, photo }；photo.adjust = { params, versions, current, ... }
// 调色是本地派生、不计费；调色前后是同一 photo 条目的版本链，不拆成新条目。
const ADJUST_KEYS = [
  { key: 'brightness', labelKey: 'tasks.adjust.brightness' },
  { key: 'contrast', labelKey: 'tasks.adjust.contrast' },
  { key: 'saturation', labelKey: 'tasks.adjust.saturation' },
  { key: 'temperature', labelKey: 'tasks.adjust.temperature' }
];
const ADJUST_ZERO = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };

// 取当前生效参数：photo.adjust.params（服务端当前渲染用的那组），没有就全 0。
function adjustParamsOf(photo) {
  const src = (photo && photo.adjust && photo.adjust.params) || null;
  const out = { ...ADJUST_ZERO };
  for (const key of Object.keys(out)) {
    const n = Number(src && src[key]);
    if (Number.isFinite(n)) out[key] = Math.max(-100, Math.min(100, Math.round(n)));
  }
  return out;
}

// 当前调色版本号 N（显示「已调色 vN」）：优先 adjust.current.version，回退版本链长度；未调色 = 0。
function adjustVersion(photo) {
  const a = photo && photo.adjust;
  if (!a || !a.params) return 0;
  const v = Number(a.current && a.current.version);
  if (Number.isFinite(v) && v > 0) return v;
  return Array.isArray(a.versions) && a.versions.length ? a.versions.length : 1;
}

// 参数摘要：亮度+20 · 对比度-5 · 饱和度 0 · 色温+10
function adjustSummary(params) {
  const p = params || ADJUST_ZERO;
  return ADJUST_KEYS.map(({ key, labelKey }) => {
    const n = Number(p[key]);
    const v = Number.isFinite(n) ? Math.round(n) : 0;
    return tr(labelKey) + (v > 0 ? '+' : '') + v;
  }).join(' · ');
}

// 即时预览的 CSS filter：brightness/contrast/saturate 近似 ffmpeg eq，
// 色温用 sepia + hue-rotate 近似（暖 → 偏黄、冷 → 偏蓝）。只喂给详情大图，不发请求。
// 入参是「滑杆值 - 服务端已生效值」的增量：这样预览是在当前图基础上叠加，不会把已调色重复算两遍。
function adjustPreviewFilter(delta) {
  const clamp = (n) => Math.max(-100, Math.min(100, Number(n) || 0));
  const parts = [
    'brightness(' + (1 + clamp(delta.brightness) / 100).toFixed(3) + ')',
    'contrast(' + (1 + clamp(delta.contrast) / 100).toFixed(3) + ')',
    'saturate(' + (1 + clamp(delta.saturation) / 100).toFixed(3) + ')'
  ];
  const t = clamp(delta.temperature);
  if (t > 0) parts.push('sepia(' + (t / 100 * 0.45).toFixed(3) + ')', 'hue-rotate(-8deg)');
  else if (t < 0) parts.push('sepia(' + (-t / 100 * 0.35).toFixed(3) + ')', 'hue-rotate(160deg)');
  return parts.join(' ');
}

// cache-busting：服务端调色后文件名可能不变，必须让浏览器重取。
// 原 url 可能已经带 query（如 /clips/a.png?x=1），必须用 & 续接，不能拼出两个 ?。
function withCacheBust(url, tag) {
  if (!url || !tag) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(String(tag));
}

export function PhotosPanel({ onChanged }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState(null);
  const [versions, setVersions] = useState([]);
  const [zoomImg, setZoomImg] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editVideoPrompt, setEditVideoPrompt] = useState('');
  // 手动调色：滑杆值（绝对值，-100..100）、请求中标记、错误/提示、图片版本号
  const [adjParams, setAdjParams] = useState({ ...ADJUST_ZERO });
  const [adjBusy, setAdjBusy] = useState('');
  const [adjErr, setAdjErr] = useState('');
  const [adjNote, setAdjNote] = useState('');
  const [adjBust, setAdjBust] = useState({});

  async function openDetail(p) {
    setDetail(p);
    setVersions([]);
    setEditPrompt(p.imagePrompt || p.prompt || '');
    setEditVideoPrompt(p.videoPrompt || '');
    setAdjParams(adjustParamsOf(p));
    setAdjErr('');
    setAdjNote('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(p.id), { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.id) {
        setDetail(j);
        setVersions(Array.isArray(j.versions) ? j.versions : []);
        setEditPrompt(j.imagePrompt || j.prompt || '');
        setEditVideoPrompt(j.videoPrompt || '');
        setAdjParams(adjustParamsOf(j));
      }
    } catch (e) { /* detail failure does not roll back the list */ }
  }

  const qs = new URLSearchParams();
  // 2026-11-16 用户口径放宽：图片 tab 不再只显示「最终版」，审核中/调色前后/多版本全显示。
  // （原 qs.set('final','1') 导致新出图 isFinal=false 永远看不见）
  if (status) qs.set('status', status);
  if (q.trim()) qs.set('q', q.trim());
  const [s, reload] = useJson('/api/photos' + (qs.toString() ? '?' + qs : ''));

  const photos = (s.data && s.data.photos) || [];
  const totals = (s.data && s.data.totals) || {};

  async function review(id, next) {
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail((d) => (d && d.id === id ? j.photo : d));
      reload();
    } catch (e) { setErr(tr('library.photos.reviewFailed') + e.message); }
  }

  async function makeFinal(id) {
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFinal: true })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail(j.photo);
      setVersions(Array.isArray(j.versions) ? j.versions : []);
      reload();
    } catch (e) { setErr(tr('library.photos.makeFinalFailed') + e.message); }
  }

  async function reviewScience(id, next) {
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scienceStatus: next })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail(j.photo);
      setVersions(Array.isArray(j.versions) ? j.versions : []);
      reload();
    } catch (e) { setErr(tr('library.photos.scienceFailed') + e.message); }
  }

  async function remove(id) {
    if (!window.confirm(tr('library.photos.removeConfirm'))) return;
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail(null);
      reload();
      if (onChanged) onChanged();
    } catch (e) { setErr(tr('library.photos.deleteFailed') + e.message); }
  }

  // 画面提示词 / 视频提示词分开保存：互不覆盖
  async function savePrompt(id) {
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagePrompt: editPrompt, videoPrompt: editVideoPrompt })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail(j.photo);
      setEditPrompt(j.photo.imagePrompt || '');
      setEditVideoPrompt(j.photo.videoPrompt || '');
      reload();
    } catch (e) { setErr(tr('library.photos.savePromptFailed') + e.message); }
  }

  // ---- 手动调色：POST /api/photos/:id/adjust ----
  // 成功后一律用服务端返回的 photo 覆盖详情（不用本地参数拼结果），并给图片 URL 换版本号让浏览器重取。
  function adoptAdjustedPhoto(photo, url) {
    const next = Object.assign({}, photo || {});
    if (url && !next.url) next.url = url;
    // 服务端每次写库都会更新 updatedAt；没有就用当前时间兜底
    const tag = next.updatedAt || Date.now();
    if (next.id) setAdjBust((m) => Object.assign({}, m, { [next.id]: tag }));
    setDetail(next);
    setAdjParams(adjustParamsOf(next));
    reload();
  }

  async function postAdjust(body, kind) {
    if (!detail) return null;
    setAdjBusy(kind);
    setAdjErr('');
    setAdjNote('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(detail.id) + '/adjust', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => ({}));
      // 后端错误原文（400 参数非法 / 404 不存在 / 409 原图缺失 / 502 ffmpeg 失败）直接透出：
      // 不吞、不改写、不把失败当成功。
      if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + r.status));
      adoptAdjustedPhoto(j.photo, j.url);
      if (onChanged) onChanged();
      return j;
    } catch (e) {
      // 后端 error 已经带「调色失败：/回退原图失败：」前缀时不要再叠一层
      // （实测会出现「调色失败：调色失败：ffmpeg…」，用户以为是两次错误）。
      const msg = String((e && e.message) || '');
      setAdjErr(/^(调色失败|回退原图失败|恢复原图失败)[:：]/.test(msg) // i18n-allow: backend Chinese error prefixes
        ? msg
        : ((kind === 'revert' ? tr('library.photos.revertFailed') : tr('library.photos.adjustFailed')) + msg));
      return null;
    } finally {
      setAdjBusy('');
    }
  }

  async function applyAdjust() {
    const body = {};
    for (const { key } of ADJUST_KEYS) body[key] = Math.round(Number(adjParams[key]) || 0);
    const j = await postAdjust(body, 'apply');
    if (j) {
      const v = adjustVersion(j.photo);
      setAdjNote(tr('library.photos.appliedNote', { version: v ? tr('library.photos.appliedVersion', { n: v }) : '' }));
    }
  }

  async function revertAdjust() {
    const j = await postAdjust({ reset: true }, 'revert');
    if (j) {
      setAdjParams({ ...ADJUST_ZERO });
      setAdjNote(tr('library.photos.revertedNote'));
    }
  }

  // 「重置为 0」只清本地滑杆（不提交）：归 0 不是合法调色，真回退原图必须走「恢复原图」。
  function resetAdjustSliders() {
    setAdjParams({ ...ADJUST_ZERO });
    setAdjErr('');
    setAdjNote(tr('library.photos.resetNote'));
  }

  // 「载入上次参数」把滑杆设回 photo.adjust.params（服务端当前版本），只是回填，不提交。
  function loadLastAdjust() {
    setAdjParams(adjustParamsOf(detail));
    setAdjErr('');
    setAdjNote(tr('library.photos.loadedNote'));
  }

  // 把这张图带回创作流程：未审核的先标记通过，再写 seed 并跳回 /（向导会取走并跳到第③步）
  async function useInCreation(p) {
    setErr('');
    try {
      let photo = p;
      if (p.status !== 'approved') {
        const r = await fetch('/api/photos/' + encodeURIComponent(p.id), {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'approved' })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        photo = j.photo || { ...p, status: 'approved' };
      }
      setSeedPhoto(photo);
      navigate('/create');
    } catch (e) { setErr(tr('library.photos.useFailed') + e.message); }
  }

  const promptText = (p) => ((p.imagePrompt || p.prompt) || (p.promptAvailable === false ? tr('library.photos.promptMissingHistory') : tr('library.photos.promptMissing')));

  // 2026-11-14 用户要求：调色前/后是同一张图的两个版本，列表里并列成一张卡，
  // 不再拆成两个独立卡片；同时显示生成费与使用状态。
  const pairKey = (p) => String(p.id || '').endsWith('_original')
    ? String(p.id).slice(0, -'_original'.length)
    : String(p.id || '');
  const photoGroups = [];
  const groupMap = new Map();
  for (const p of photos) {
    const key = pairKey(p);
    let g = groupMap.get(key);
    if (!g) {
      g = { key, before: null, after: null, singles: [] };
      groupMap.set(key, g);
      photoGroups.push(g);
    }
    if (String(p.id).endsWith('_original') || p.label === '调色前') g.before = p; // i18n-allow: backend photo label
    else if (p.label === '调色后') g.after = p; // i18n-allow: backend photo label
    else g.singles.push(p);
  }
  // 用户要求：列表页不再并排展示调色前/后；只在详情页看版本链。
  for (const g of photoGroups) {
    if (g.before || g.after) {
      g.singles = [g.after, g.before].filter(Boolean);
      g.before = null;
      g.after = null;
    }
  }
  const usedText = (p) => (Array.isArray(p.usedIn) && p.usedIn.length ? tr('library.photos.used') : tr('library.photos.unused'));
  const cleanPrompt = (p) => promptText(p).replace(/^【(调色前|调色后)】/, ''); // i18n-allow: backend photo label prefix
  const detailPair = detail
    ? photoGroups.find((g) => g.key === pairKey(detail) && g.before && g.after)
    : null;

  // 手动调色的渲染派生值：滑杆值 - 服务端当前已生效值 = 预览增量（避免把已调色重复叠加两遍）。
  // 有增量才加 CSS filter；应用成功 / 恢复原图后参数与服务端一致，增量归 0，预览自动清掉。
  const serverAdjParams = adjustParamsOf(detail);
  const adjustDelta = {};
  let adjustChanged = false;
  for (const { key } of ADJUST_KEYS) {
    const d = (Number(adjParams[key]) || 0) - (Number(serverAdjParams[key]) || 0);
    adjustDelta[key] = d;
    if (Math.abs(d) > 0.0001) adjustChanged = true;
  }
  const adjustIsZero = ADJUST_KEYS.every(({ key }) => Math.round(Number(adjParams[key]) || 0) === 0);
  const adjustVer = detail ? adjustVersion(detail) : 0;
  const previewFilterText = adjustChanged ? adjustPreviewFilter(adjustDelta) : '';

  return html`
    <div>
      <p className="mb-3 text-[11px] leading-[1.7] text-ink3">
        ${tr('library.photos.intro')}
      </p>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <select value=${status} onChange=${(e) => setStatus(e.target.value)}
          className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
          <option value="">${tr('library.photos.allStatus')}</option>
          <option value="pending">${tr('library.photos.status.pending')}</option>
          <option value="approved">${tr('library.photos.status.approved')}</option>
          <option value="rejected">${tr('library.photos.status.rejected')}</option>
        </select>
        <input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder=${tr('library.photos.searchPlaceholder')}
          className="h-8 w-[190px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
        <span className="flex-1"></span>
        <span className="text-[11px] text-ink3 font-num">
          ${tr('library.photos.totals', { all: totals.all || 0, pending: totals.pending || 0, approved: totals.approved || 0, rejected: totals.rejected || 0 })}
        </span>
        <span className="text-[11px] text-ink3">${s.loading ? tr('library.photos.loading') : (s.error ? tr('library.photos.loadFailed') : '')}</span>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${photos.length === 0 && !s.loading && html`<${Empty}>
        ${status || q.trim() ? tr('library.photos.emptyFiltered') : tr('library.photos.empty')}
      </${Empty}>`}

      <div className="grid grid-cols-4 gap-3">
        ${photoGroups.map((g) => {
          if (g.before && g.after) {
            const p = g.after;
            return html`
              <div key=${g.key} style=${{ gridColumn: 'span 2' }} className="rounded-[6px] border border-white/[.08] bg-s1 overflow-hidden">
                <div className="grid grid-cols-2 gap-px bg-black">
                  <div style=${{ position: 'relative' }}>
                    <img src=${withCacheBust(g.before.url, adjBust[g.before.id])} alt=${tr('library.photos.before')}
                      onClick=${() => openDetail(g.before)}
                      className="w-full aspect-video bg-black object-cover cursor-pointer" />
                    <span style=${{ position: 'absolute', left: '6px', top: '6px', padding: '2px 6px', borderRadius: '3px', background: 'rgba(0,0,0,.65)', color: '#fff', fontSize: '10px' }}>${tr('library.photos.before')}</span>
                  </div>
                  <div style=${{ position: 'relative' }}>
                    <img src=${withCacheBust(g.after.url, adjBust[g.after.id])} alt=${tr('library.photos.after')}
                      onClick=${() => openDetail(g.after)}
                      className="w-full aspect-video bg-black object-cover cursor-pointer" />
                    <span style=${{ position: 'absolute', left: '6px', top: '6px', padding: '2px 6px', borderRadius: '3px', background: 'rgba(0,0,0,.65)', color: '#fff', fontSize: '10px' }}>${tr('library.photos.after')}</span>
                  </div>
                </div>
                <div className="px-2 py-1.5">
                  <p className="text-[11px] leading-[1.5] text-ink2 line-clamp-2 min-h-[32px]">${cleanPrompt(p)}</p>
                  <p className="text-[10px] text-ink3 font-num">
                    ${PHOTO_STATUS_KEYS[p.status] ? tr(PHOTO_STATUS_KEYS[p.status]) : p.status}
                    ${p.width && p.height ? ' · ' + p.width + '×' + p.height : ''}
                    ${' · ' + tr('library.photos.generatedCost', { cost: costText(g.before.cost) || '-' })}
                    ${' · ' + tr('library.photos.adjustedCost', { cost: costText(g.after.cost) || '-' })}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink3">${usedText(g.after)}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-ink3 font-num">${p.model || ''}</span>
                    <span className="flex-1"></span>
                    <button onClick=${() => openDetail(g.after)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">${tr('library.photos.viewCompare')}</button>
                    <${DownloadLink} url=${g.after.url} fileName=${g.after.fileName} />
                    <button onClick=${() => useInCreation(g.after)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">${tr('library.photos.useInVideo')}</button>
                  </div>
                </div>
              </div>`;
          }
          const p = g.after || g.before || g.singles[0];
          return html`
            <div key=${p.id} className="rounded-[6px] border border-white/[.08] bg-s1 overflow-hidden">
              <img src=${withCacheBust(p.url, adjBust[p.id])} alt=${tr('library.photos.imageAlt')}
                onClick=${() => openDetail(p)}
                className="w-full aspect-video bg-black object-cover cursor-pointer" />
              <div className="px-2 py-1.5">
                <p className="text-[11px] leading-[1.5] text-ink2 line-clamp-2 min-h-[32px]">${promptText(p)}</p>
                <p className="text-[10px] text-ink3 font-num">
                  ${PHOTO_STATUS_KEYS[p.status] ? tr(PHOTO_STATUS_KEYS[p.status]) : p.status}
                  ${p.width && p.height ? ' · ' + p.width + '×' + p.height : ''}
                  ${costText(p.cost) ? ' · ' + costText(p.cost) : ''}
                </p>
                <p className="mt-0.5 text-[10px] text-ink3">${usedText(p)}</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[10px] text-ink3 font-num">${p.model || ''}</span>
                  <span className="flex-1"></span>
                  <button onClick=${() => useInCreation(p)}
                    className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">${tr('library.photos.useInVideo')}</button>
                  ${p.status !== 'approved' && html`
                    <button onClick=${() => review(p.id, 'approved')}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">${tr('library.photos.approve')}</button>`}
                  ${p.status !== 'rejected' && html`
                    <button onClick=${() => review(p.id, 'rejected')}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06]">${tr('library.photos.reject')}</button>`}
                  <${DownloadLink} url=${p.url} fileName=${p.fileName} />
                  <button onClick=${() => remove(p.id)}
                    className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:text-danger hover:bg-white/[.06]">${tr('library.photos.delete')}</button>
                </div>
              </div>
            </div>`;
        })}
      </div>

      ${detail && html`
        <div
          style=${{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,7,5,.72)', display: 'grid', placeItems: 'center' }}
          onClick=${(e) => { if (e.target === e.currentTarget) setDetail(null); }}
        >
          <div style=${{ width: 'min(820px, 92vw)', maxHeight: '88vh', overflow: 'auto', background: 'var(--s1)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '10px', padding: '14px' }}>
            <div style=${{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <b style=${{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>${tr('library.photos.detailTitle')}</b>
              <span style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${PHOTO_STATUS_KEYS[detail.status] ? tr(PHOTO_STATUS_KEYS[detail.status]) : detail.status}</span>
              <span style=${{ flex: 1 }}></span>
              <button onClick=${() => setDetail(null)} style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.photos.close')}</button>
            </div>
            <img src=${withCacheBust(detail.url, adjBust[detail.id])} alt=${tr('library.photos.imageAlt')} onClick=${() => setZoomImg(detail.url)}
              style=${{ width: '100%', maxHeight: '420px', objectFit: 'contain', background: '#000', borderRadius: '6px', cursor: 'zoom-in', ...(previewFilterText ? { filter: previewFilterText } : {}) }} />
            <div style=${{ marginTop: '12px', padding: '10px 12px', border: '1px solid rgba(244,247,245,.12)', borderRadius: '8px', background: 'rgba(255,255,255,.02)' }}>
              <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '2px' }}>
                <b style=${{ fontSize: '12px', fontWeight: 500, color: 'var(--ink)' }}>${tr('library.photos.manualAdjust')}</b>
                ${adjustVer
                  ? html`
                    <span style=${{ padding: '1px 6px', borderRadius: '3px', border: '1px solid rgba(214,179,106,.45)', color: 'var(--accent)', fontSize: '10px' }}>${tr('library.photos.adjustedVersion', { n: adjustVer })}</span>
                    <span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>${adjustSummary(detail.adjust.params)}</span>
                    <button onClick=${loadLastAdjust}
                      style=${{ height: '22px', padding: '0 8px', borderRadius: '4px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '10.5px', cursor: 'pointer' }}>${tr('library.photos.loadLast')}</button>`
                  : html`<span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>${tr('library.photos.notAdjusted')}</span>`}
                <span style=${{ flex: 1 }}></span>
                ${previewFilterText ? html`<span style=${{ color: 'var(--accent)', fontSize: '10.5px' }}>${tr('library.photos.previewing')}</span>` : ''}
                ${adjBusy ? html`<span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>${adjBusy === 'revert' ? tr('library.photos.reverting') : tr('library.photos.applying')}</span>` : ''}
              </div>
              ${ADJUST_KEYS.map(({ key, labelKey }) => html`
                <div key=${'adjust-' + key} style=${{ display: 'grid', gridTemplateColumns: '52px 1fr 44px', alignItems: 'center', gap: '8px', margin: '3px 0' }}>
                  <span style=${{ color: 'var(--ink2)', fontSize: '11px' }}>${tr(labelKey)}</span>
                  <input type="range" min="-100" max="100" step="1" value=${adjParams[key]} aria-label=${tr(labelKey)}
                    onChange=${(e) => {
                      const n = Number(e.target.value);
                      setAdjParams((p) => Object.assign({}, p, { [key]: Number.isFinite(n) ? n : 0 }));
                      setAdjErr('');
                    }}
                    style=${{ width: '100%', accentColor: 'var(--accent)' }} />
                  <span className="text-[11px] text-ink2 font-num" style=${{ textAlign: 'right' }}>${adjParams[key]}</span>
                </div>`)}
              <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                <button onClick=${applyAdjust}
                  disabled=${adjBusy !== '' || adjustIsZero}
                  title=${adjustIsZero ? tr('library.photos.zeroTitle') : tr('library.photos.applyTitle')}
                  style=${{ height: '26px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: adjustIsZero ? 'var(--ink3)' : 'var(--accent)', fontSize: '11px', cursor: adjBusy !== '' || adjustIsZero ? 'not-allowed' : 'pointer', opacity: adjBusy !== '' || adjustIsZero ? 0.5 : 1 }}>${tr('library.photos.apply')}</button>
                <button onClick=${resetAdjustSliders}
                  disabled=${adjBusy !== ''}
                  style=${{ height: '26px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: adjBusy !== '' ? 'not-allowed' : 'pointer', opacity: adjBusy !== '' ? 0.5 : 1 }}>${tr('library.photos.resetZero')}</button>
                <button onClick=${revertAdjust}
                  disabled=${adjBusy !== '' || !adjustVer}
                  style=${{ height: '26px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: adjustVer ? 'var(--ink2)' : 'var(--ink3)', fontSize: '11px', cursor: adjBusy !== '' || !adjustVer ? 'not-allowed' : 'pointer', opacity: adjBusy !== '' || !adjustVer ? 0.5 : 1 }}>${tr('library.photos.revert')}</button>
                <span style=${{ flex: 1 }}></span>
                ${adjustIsZero && html`
                  <span style=${{ color: 'var(--ink3)', fontSize: '10px' }}>${tr('library.photos.zeroHint')}</span>`}
              </div>
              ${adjErr && html`<p style=${{ margin: '6px 0 0', fontSize: '11px', color: 'var(--danger)' }}>${adjErr}</p>`}
              ${adjNote && html`<p style=${{ margin: '6px 0 0', fontSize: '10.5px', color: 'var(--ink3)' }}>${adjNote}</p>`}
              <p style=${{ margin: '6px 0 0', fontSize: '10px', color: 'var(--ink3)', lineHeight: 1.6 }}>
                ${tr('library.photos.adjustNote')}
              </p>
            </div>
            ${versions.length > 1 && html`
              <div style=${{ marginTop: '14px' }}>
                <div style=${{ fontSize: '12px', color: 'var(--ink2)', marginBottom: '8px' }}>
                  ${tr('library.photos.versions', { n: versions.length })}
                  ${detail.isFinal ? html`<span style=${{ marginLeft: '8px', color: 'var(--accent)', fontSize: '10.5px' }}>${tr('library.photos.currentFinal')}</span>` : ''}
                </div>
                ${versions.slice(1).map((v, i) => {
                  const prev = versions[i];
                  return html`
                    <div key=${v.id} style=${{ marginBottom: '10px' }}>
                      <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                        <div>
                          <img src=${prev.url} alt=${'V' + prev.version} onClick=${() => setZoomImg(prev.url)}
                            style=${{ width: '100%', maxHeight: '260px', objectFit: 'contain', background: '#000', borderRadius: '6px', cursor: 'zoom-in' }} />
                          <div style=${{ marginTop: '3px', fontSize: '10.5px', color: 'var(--ink3)', textAlign: 'center' }}>V${prev.version}${prev.isFinal ? tr('library.photos.finalBadge') : ''}${prev.status === 'rejected' ? tr('library.photos.dropped') : ''}</div>
                        </div>
                        <div>
                          <img src=${v.url} alt=${'V' + v.version} onClick=${() => setZoomImg(v.url)}
                            style=${{ width: '100%', maxHeight: '260px', objectFit: 'contain', background: '#000', borderRadius: '6px', cursor: 'zoom-in' }} />
                          <div style=${{ marginTop: '3px', fontSize: '10.5px', color: 'var(--ink3)', textAlign: 'center' }}>V${v.version}${v.isFinal ? tr('library.photos.finalBadge') : ''}${v.status === 'rejected' ? tr('library.photos.dropped') : ''}</div>
                        </div>
                      </div>
                      ${v.revisionNote ? html`<div style=${{ marginTop: '3px', fontSize: '10.5px', color: 'var(--ink3)' }}>${v.revisionNote}</div>` : ''}
                    </div>`;
                })}
              </div>`}
            ${versions.some((v) => v.failureSummary) && html`
              <div style=${{ marginTop: '10px', padding: '8px 10px', border: '1px solid rgba(217,139,106,.25)', borderRadius: '6px', background: 'rgba(217,139,106,.06)' }}>
                <div style=${{ fontSize: '11px', color: 'var(--ink2)', marginBottom: '4px' }}>${tr('library.photos.failures')}</div>
                ${versions.filter((v) => v.failureSummary).map((v) => html`
                  <div key=${'fail-' + v.id} style=${{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.6 }}>V${v.version}：${v.failureSummary}</div>`)}
              </div>`}
            <div style=${{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '6px 10px', marginTop: '12px', fontSize: '11.5px', lineHeight: 1.7 }}>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.imagePrompt')}</span>
              <div>
                <textarea value=${editPrompt} onInput=${(e) => setEditPrompt(e.target.value)}
                  rows="3" placeholder=${tr('library.photos.imagePromptPh')}
                  style=${{ width: '100%', resize: 'vertical', background: 'var(--s2)', color: 'var(--ink)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '6px', padding: '6px 8px', fontSize: '11.5px', lineHeight: 1.7, outline: 'none', fontFamily: 'inherit' }}></textarea>
                <span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>
                  ${tr('library.photos.generationPrompt', { value: detail.generationPrompt || tr('library.photos.notRecorded') })}
                </span>
              </div>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.videoPrompt')}</span>
              <div>
                <textarea value=${editVideoPrompt} onInput=${(e) => setEditVideoPrompt(e.target.value)}
                  rows="2" placeholder=${tr('library.photos.videoPromptPh')}
                  style=${{ width: '100%', resize: 'vertical', background: 'var(--s2)', color: 'var(--ink)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '6px', padding: '6px 8px', fontSize: '11.5px', lineHeight: 1.7, outline: 'none', fontFamily: 'inherit' }}></textarea>
                <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
                  <button onClick=${() => savePrompt(detail.id)}
                    style=${{ height: '26px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.photos.savePrompt')}</button>
                  <span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>
                    ${detail.videoPromptUpdatedAt ? tr('library.photos.videoPromptUpdated', { time: String(detail.videoPromptUpdatedAt).slice(0, 19).replace('T', ' ') }) : tr('library.photos.videoNeverUsed')}
                  </span>
                </div>
              </div>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.model')}</span>
              <span style=${{ color: 'var(--ink2)' }}>${detail.model || '-'}${detail.provider ? ' · ' + detail.provider : ''}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.spec')}</span>
              <span style=${{ color: 'var(--ink2)' }}>${[
                detail.width && detail.height ? detail.width + '×' + detail.height : '',
                detail.size || '',
                detail.sizeBytes ? (Number(detail.sizeBytes) / 1048576).toFixed(2) + ' MB' : ''
              ].filter(Boolean).join(' · ') || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.genCost')}</span>
              <span style=${{ color: 'var(--ink2)' }}>${costText(detail.cost) || '-'}${costSuffix(detail.cost)}</span>
              ${detail.failureSummary && html`
                <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.failure')}</span>
                <span style=${{ color: 'var(--ink2)' }}>${detail.failureSummary}</span>`}
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.createdAt')}</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace' }}>${detail.createdAt || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.common.file')}</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.fileName || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>${tr('library.photos.usedIn')}</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>
                ${Array.isArray(detail.usedIn) && detail.usedIn.length ? detail.usedIn.map((u) => u.taskId).join(', ') : tr('library.photos.neverUsed')}
              </span>
            </div>
            <div style=${{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              ${!detail.isFinal && html`
                <button onClick=${() => makeFinal(detail.id)}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.photos.setFinal')}</button>`}
              <button onClick=${() => useInCreation(detail)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.photos.useInVideo')}</button>
              ${detail.status !== 'approved' && html`
                <button onClick=${() => review(detail.id, 'approved')}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.photos.approve')}</button>`}
              ${detail.status !== 'rejected' && html`
                <button onClick=${() => review(detail.id, 'rejected')}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.photos.reject')}</button>`}
              <${DownloadLink} url=${detail.url} fileName=${detail.fileName} />
              <button onClick=${() => remove(detail.id)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.photos.delete')}</button>
            </div>
          </div>
        </div>
      `}
      ${zoomImg && html`
        <div onClick=${() => setZoomImg('')}
          style=${{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.92)', display: 'grid', placeItems: 'center', cursor: 'zoom-out', padding: '18px' }}>
          <img src=${zoomImg} alt=${tr('library.photos.zoomAlt')}
            style=${{ maxWidth: '96vw', maxHeight: '94vh', objectFit: 'contain', borderRadius: '4px' }} />
        </div>`}
    </div>
  `;
}


// ---------------- 成片 · 未完成（P6） ----------------
// 历史记录页下线后（P6），失败/未完成的成片任务在这里可见并可补跑（产品口径 §7）：
//   「失败任务靠『库里失败可见 + 成片未完成卡片』，不再靠历史页。」
// 数据来自 AppShell 的 /api/tasks 轮询（5s），不新建接口、不改后端。
// 排除项（避免把本来就不产成片的任务报成失败）：
//   · mock：开发/验收用的合成任务，正式库口径不入库；
//   · fragmentOnly：clips_only 档只产片段，本来就没有成片；
//   · 已在该任务下产出成片（Library 里已有 kind=final 且 taskId 相同）。
function UnfinishedPanel({ tasks, finals, onChanged }) {
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [fileCounts, setFileCounts] = useState({});
  const finalTaskIds = new Set((finals || []).map((it) => it.taskId).filter(Boolean));
  const rows = (tasks || [])
    .filter((t) => t
      && (t.status === 'failed' || t.status === 'partial')
      && t.model !== 'mock'
      && !t.fragmentOnly
      && !finalTaskIds.has(t.taskId))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const rowsKey = rows.map((t) => t.taskId).join(',');

  // 2026-11-16 P3：未完成卡片加删除入口。
  // 后端 DELETE /api/tasks/:id → taskManager.moveToTrash **只移走任务 JSON**，
  // 片段文件留在 clips/ 不动（见 src/taskManager.js moveToTrash）。
  // /api/tasks 列表不带 clips（只有 totalClips），所以这里按任务逐个读详情，
  // 拿到「真实存在文件的片段数」——有文件的任务必须单独再确认一次。
  useEffect(() => {
    if (!rowsKey) { setFileCounts({}); return undefined; }
    let alive = true;
    (async () => {
      const next = {};
      for (const id of rowsKey.split(',')) {
        try {
          const r = await fetch('/api/tasks/' + encodeURIComponent(id), { credentials: 'same-origin' });
          const j = await r.json().catch(() => null);
          const task = (j && (j.task || j)) || {};
          const clips = Array.isArray(task.clips) ? task.clips : [];
          next[id] = clips.filter((c) => c && c.videoPath).length;
        } catch (e) { next[id] = null; } // unreadable → null (conservatively treat as possibly present)
      }
      if (alive) setFileCounts(next);
    })();
    return () => { alive = false; };
  }, [rowsKey]);

  async function removeTask(t) {
    let files = fileCounts[t.taskId];
    if (files === undefined) {
      // 详情还没读回来：现场读一次，别猜。
      try {
        const r = await fetch('/api/tasks/' + encodeURIComponent(t.taskId), { credentials: 'same-origin' });
        const j = await r.json().catch(() => null);
        const task = (j && (j.task || j)) || {};
        files = (Array.isArray(task.clips) ? task.clips : []).filter((c) => c && c.videoPath).length;
      } catch (e) { files = null; }
    }
    const label = String(t.prompt || tr('library.common.noPrompt')).slice(0, 42);
    const first = (files === null)
      ? tr('library.unfinished.confirmUnknown', { label })
      : (files > 0
        ? tr('library.unfinished.confirmHasFiles', { n: files, label })
        : tr('library.unfinished.confirmNoFiles', { label }));
    if (!window.confirm(first)) return;
    if (files !== 0 && !window.confirm(
      files > 0
        ? tr('library.unfinished.confirmAgainFiles', { n: files })
        : tr('library.unfinished.confirmAgainUnknown'))) return;
    setErr(''); setBusy(t.taskId);
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(t.taskId), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      // 该路由总是 HTTP 200，错误在 body.error 里（taskManager.moveToTrash 的返回）
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      if (onChanged) onChanged();
    } catch (e) { setErr(tr('library.unfinished.deleteFailed') + e.message); }
    finally { setBusy(''); }
  }
  if (!rows.length) return null;

  return html`
    <div className="mb-4 rounded-[8px] border border-warn/30 bg-warn/[.05] px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-warn">${tr('library.unfinished.heading', { n: rows.length })}</span>
        <span className="text-[10px] text-ink3">${tr('library.unfinished.hint')}</span>
        <span className="flex-1"></span>
        <span className="text-[10px] text-ink3">${tr('library.unfinished.deleteHint')}</span>
      </div>
      ${err && html`<p className="mt-1 text-[11px] text-danger">${err}</p>`}
      <div className="mt-1">
        ${rows.map((t) => {
          const st = statusMeta(t.status, t);
          return html`
            <div key=${t.taskId} className="flex items-center gap-2.5 py-1.5 border-t border-white/[.05]">
              <span className=${'w-[6px] h-[6px] rounded-full shrink-0 ' + st.dot}></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-ink truncate">${unfinishedName(t)}</span>
                <span className="block text-[10px] text-ink3 font-num">
                  ${t.createdAt ? fmtDateTime(t.createdAt) : '-'}
                  ${' · ' + st.text}
                  ${t.failedClips ? ' · ' + tr('library.unfinished.failedClips', { n: t.failedClips }) : ''}
                  ${t.recoverable ? ' · ' + tr('library.unfinished.resumable') : ''}
                </span>
              </span>
              <button onClick=${() => setOpenId(t.taskId)}
                className="h-6 px-2 rounded-[4px] text-[10px] text-ink2 hover:bg-white/[.06] shrink-0"
              >${tr('library.unfinished.detail')}</button>
              <button onClick=${() => removeTask(t)} disabled=${busy === t.taskId}
                className="h-6 px-2 rounded-[4px] text-[10px] text-ink3 hover:text-danger hover:bg-white/[.06] shrink-0"
                style=${{ opacity: busy === t.taskId ? .5 : 1 }}
              >${fileCounts[t.taskId] > 0 ? tr('library.unfinished.deleteWithClips', { n: fileCounts[t.taskId] }) : tr('library.unfinished.delete')}</button>
            </div>
          `;
        })}
      </div>
      ${openId && html`<${TaskDrawer} taskId=${openId}
        onClose=${() => { setOpenId(null); if (onChanged) onChanged(); }} />`}
    </div>
  `;
}


// ---------------- 任务回收站抽屉（2026-11-16 P3） ----------------
// DELETE /api/tasks/:id 只是把任务 JSON 移进 data/trash（片段文件不动）。
// 没有这个入口，「软删除」就等于不可恢复 —— 这是 P3 要求的另一半。
// 数据来自 GET /api/trash（数组），恢复 POST /api/trash/:id/restore，彻底删除 DELETE /api/trash/:id。
function TaskTrashDrawer({ open, items, loading, error, onClose, onChanged }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const list = items || [];
  const btn = (primary) => ({
    height: '26px', padding: '0 10px', borderRadius: '6px', background: 'transparent',
    fontSize: '11px', cursor: 'pointer',
    border: primary ? '1px solid rgba(214,179,106,.45)' : '1px solid rgba(240,138,132,.35)',
    color: primary ? 'var(--accent)' : 'var(--danger)'
  });

  async function restore(it) {
    setMsg(''); setBusy(it.taskId);
    try {
      const r = await fetch('/api/trash/' + encodeURIComponent(it.taskId) + '/restore',
        { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setMsg(tr('library.taskTrash.restored', { id: it.taskId }));
      if (onChanged) onChanged();
    } catch (e) { setMsg(tr('library.taskTrash.restoreFailed') + e.message); }
    finally { setBusy(''); }
  }

  async function purge(it) {
    if (!window.confirm(tr('library.taskTrash.purgeConfirm', { id: it.taskId }))) return;
    setMsg(''); setBusy(it.taskId);
    try {
      const r = await fetch('/api/trash/' + encodeURIComponent(it.taskId), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setMsg(tr('library.taskTrash.purged'));
      if (onChanged) onChanged();
    } catch (e) { setMsg(tr('library.taskTrash.purgeFailed') + e.message); }
    finally { setBusy(''); }
  }

  if (!open) return null;
  return html`
    <div style=${{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(4,7,5,.55)' }}
      onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside style=${{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(520px, 94vw)', background: 'var(--s1)', borderLeft: '1px solid rgba(244,247,245,.12)', display: 'flex', flexDirection: 'column' }}>
        <div style=${{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 14px 10px' }}>
          <b style=${{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>${tr('library.taskTrash.title')}</b>
          <span style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${tr('library.taskTrash.count', { n: list.length })}</span>
          <span style=${{ flex: 1 }}></span>
          <button onClick=${onClose}
            style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.taskTrash.close')}</button>
        </div>
        <p style=${{ margin: '0 14px 8px', fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.6 }}>
          ${tr('library.taskTrash.note')}
        </p>
        ${msg && html`<p style=${{ margin: '0 14px 8px', fontSize: '11px', color: 'var(--ink2)' }}>${msg}</p>`}
        ${error && html`<p style=${{ margin: '0 14px 8px', fontSize: '11px', color: 'var(--danger)' }}>${error}</p>`}
        <div style=${{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 14px 14px' }}>
          ${loading && html`<p style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${tr('library.taskTrash.loading')}</p>`}
          ${!loading && list.length === 0 && html`<p style=${{ fontSize: '11px', color: 'var(--ink3)', padding: '10px 0' }}>${tr('library.taskTrash.empty')}</p>`}
          ${list.map((it) => html`
            <div key=${it.taskId} style=${{ border: '1px solid rgba(244,247,245,.08)', borderRadius: '8px', padding: '10px', marginBottom: '8px', background: 'var(--s2)' }}>
              <div style=${{ fontSize: '11.5px', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${it.prompt || tr('library.common.noPrompt')}</div>
              <div style=${{ fontSize: '10px', color: 'var(--ink3)', marginTop: '4px', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>
                <span title=${tr('tasks.taskIdTooltip', { id: it.taskId || '' })}>${tr('tasks.shortId', { id: shortTaskId(it.taskId) })}</span>
                · ${it.model || '-'}${tr('library.taskTrash.clipsUnit', { n: it.totalClips || 0 })}${tr('library.taskTrash.deletedAt', { time: String(it.deletedAt || '').slice(0, 19).replace('T', ' ') })}
              </div>
              <div style=${{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <button onClick=${() => restore(it)} disabled=${busy === it.taskId} style=${btn(true)}>${tr('library.taskTrash.restore')}</button>
                <button onClick=${() => purge(it)} disabled=${busy === it.taskId} style=${btn(false)}>${tr('library.taskTrash.purge')}</button>
              </div>
            </div>
          `)}
        </div>
      </aside>
    </div>
  `;
}


// ---------------- 成片 ----------------
// 列表行：缩略图 / 时长 / 来源 / 质检 / 提示词 / 真实费用 / 播放 / 下载 / 删除。
// 成片 = 长视频（整条任务产物），不再单独「产出」入口。
function FinalsPanel({ items, tasks, loading, error, onChanged }) {
  const [err, setErr] = useState('');
  const [play, setPlay] = useState(null);
  const [busy, setBusy] = useState('');

  async function remove(it) {
    if (!window.confirm(tr('library.finals.deleteConfirm'))) return;
    setErr('');
    setBusy(it.id);
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(it.id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      if (onChanged) onChanged();
    } catch (e) { setErr(tr('library.finals.deleteFailed') + e.message); }
    finally { setBusy(''); }
  }

  return html`
    <div>
      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${error && html`<p className="mb-2 text-[12px] text-danger">${error}</p>`}
      <${UnfinishedPanel} tasks=${tasks} finals=${items} onChanged=${onChanged} />
      ${(items || []).length === 0 && !loading && html`<${Empty}>${tr('library.finals.empty')}</${Empty}>`}
      <div className="rounded-[8px] border border-white/[.08] overflow-hidden bg-s1">
        ${(items || []).map((it) => html`
          <div key=${it.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/[.05] last:border-0">
            <${Thumb} id=${it.id} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12.5px] text-ink truncate">${it.prompt || it.fileName || it.id}</span>
                ${it.suspectedDamage ? html`<span className="text-[10px] text-warn">${tr('library.finals.suspect')}</span>` : null}
              </div>
              <p className="text-[10px] text-ink3 font-num flex items-center gap-1.5 flex-wrap mt-0.5">
                <span>${fmtDurSec(it.durationSec)}</span>
                <span className="opacity-40">·</span>
                <span>${it.resolution || '-'}</span>
                <span className="opacity-40">·</span>
                <span>${tr('library.finals.origin', { origin: originText(it.origin) })}</span>
                <span className="opacity-40">·</span>
                <span>${tr('library.finals.cost', { cost: costLabel(it.cost) })}</span>
                <span className="opacity-40">·</span>
                ${qcBadge(it.qc)}
              </p>
            </div>
            <button onClick=${() => setPlay(it)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-accent hover:bg-white/[.06]">${tr('library.finals.play')}</button>
            <${DownloadLink} url=${it.url} fileName=${it.fileName} label=${tr('library.common.download')} />
            <button onClick=${() => remove(it)} disabled=${busy === it.id}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-danger hover:bg-white/[.06]">${tr('library.finals.delete')}</button>
          </div>
        `)}
      </div>

      ${play && html`
        <div style=${{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,7,5,.78)', display: 'grid', placeItems: 'center' }}
          onClick=${(e) => { if (e.target === e.currentTarget) setPlay(null); }}>
          <div style=${{ width: 'min(880px, 94vw)', background: 'var(--s1)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '10px', padding: '12px' }}>
            <div style=${{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <b style=${{ fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>${play.fileName || play.id}</b>
              <span style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${fmtDurSec(play.durationSec)} · ${play.resolution || '-'} · ${tr('library.finals.origin', { origin: originText(play.origin) })}</span>
              <span style=${{ flex: 1 }}></span>
              <button onClick=${() => setPlay(null)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.clips.close')}</button>
            </div>
            <video src=${play.url} controls autoPlay playsInline
              style=${{ width: '100%', maxHeight: '68vh', background: '#000', borderRadius: '6px' }}></video>
            <p style=${{ marginTop: '8px', fontSize: '11px', lineHeight: 1.7, color: 'var(--ink3)', whiteSpace: 'pre-wrap' }}>${play.prompt || tr('library.finals.noPrompt')}</p>
          </div>
        </div>`}
    </div>
  `;
}

// ---------------- 回收站抽屉 ----------------
// 删除只进这里；彻底删除必须在这里再确认一次（两次确认的口径见交接 §7）。
const RECYCLE_TYPE_KEYS = { clip: 'library.recycle.types.clip', final: 'library.recycle.types.final', photo: 'library.recycle.types.photo', bgm: 'library.recycle.types.bgm' };
const RECYCLE_TABS = [
  { key: 'all', labelKey: 'library.recycle.tabs.all' },
  { key: 'clip', labelKey: 'library.recycle.tabs.clip' },
  { key: 'final', labelKey: 'library.recycle.tabs.final' },
  { key: 'photo', labelKey: 'library.recycle.tabs.photo' },
  { key: 'bgm', labelKey: 'library.recycle.tabs.bgm' }
];

function RecycleDrawer({ open, items, loading, error, onClose, onChanged }) {
  const [openType, setOpenType] = useState('all');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const list = (items || []).filter((it) => openType === 'all' || it.type === openType);
  const btn = (primary) => ({
    height: '26px', padding: '0 10px', borderRadius: '6px', background: 'transparent',
    fontSize: '11px', cursor: 'pointer',
    border: primary ? '1px solid rgba(214,179,106,.45)' : '1px solid rgba(240,138,132,.35)',
    color: primary ? 'var(--accent)' : 'var(--danger)'
  });

  async function restore(it) {
    setMsg(''); setBusy(it.type + '/' + it.id);
    try {
      const r = await fetch('/api/recycle/' + encodeURIComponent(it.type) + '/' + encodeURIComponent(it.id) + '/restore',
        { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setMsg(tr('library.recycle.restored', { label: (it.entry && it.entry.fileName) || it.id })
        + (j.conflicts && j.conflicts.length ? tr('library.recycle.restoredConflict') : ''));
      if (onChanged) onChanged();
    } catch (e) { setMsg(tr('library.recycle.restoreFailed') + e.message); }
    finally { setBusy(''); }
  }

  async function purge(it) {
    if (!window.confirm(tr('library.recycle.purgeConfirm', { label: (it.entry && it.entry.fileName) || it.id }))) return;
    setMsg(''); setBusy(it.type + '/' + it.id);
    try {
      const r = await fetch('/api/recycle/' + encodeURIComponent(it.type) + '/' + encodeURIComponent(it.id),
        { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setMsg(tr('library.recycle.purged'));
      if (onChanged) onChanged();
    } catch (e) { setMsg(tr('library.recycle.purgeFailed') + e.message); }
    finally { setBusy(''); }
  }

  async function purgeAll() {
    if (!window.confirm(tr('library.recycle.purgeAllConfirm'))) return;
    setMsg(''); setBusy('all');
    try {
      const r = await fetch('/api/recycle/all/purge', { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setMsg(tr('library.recycle.purgedAll', { n: j.removed || 0 }));
      if (onChanged) onChanged();
    } catch (e) { setMsg(tr('library.recycle.purgeAllFailed') + e.message); }
    finally { setBusy(''); }
  }

  if (!open) return null;
  return html`
    <div style=${{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(4,7,5,.55)' }}
      onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside style=${{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(560px, 94vw)', background: 'var(--s1)', borderLeft: '1px solid rgba(244,247,245,.12)', display: 'flex', flexDirection: 'column' }}>
        <div style=${{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 14px 10px' }}>
          <b style=${{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>${tr('library.recycle.title')}</b>
          <span style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${tr('library.recycle.count', { n: (items || []).length })}</span>
          <span style=${{ flex: 1 }}></span>
          <button onClick=${purgeAll} disabled=${busy === 'all' || (items || []).length === 0}
            style=${{ ...btn(false), opacity: (items || []).length ? 1 : .4 }}>${tr('library.recycle.clear')}</button>
          <button onClick=${onClose}
            style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>${tr('library.recycle.close')}</button>
        </div>
        <div style=${{ display: 'flex', gap: '6px', padding: '0 14px 10px', flexWrap: 'wrap' }}>
          ${RECYCLE_TABS.map((t) => html`
            <button key=${t.key} onClick=${() => setOpenType(t.key)}
              style=${{
                height: '26px', padding: '0 9px', borderRadius: '13px', fontSize: '11px', cursor: 'pointer',
                border: '1px solid ' + (openType === t.key ? 'rgba(214,179,106,.5)' : 'rgba(244,247,245,.10)'),
                background: openType === t.key ? 'rgba(214,179,106,.13)' : 'transparent',
                color: openType === t.key ? 'var(--accent)' : 'var(--ink3)'
              }}
            >${tr(t.labelKey)}</button>
          `)}
        </div>
        ${msg && html`<p style=${{ margin: '0 14px 8px', fontSize: '11px', color: 'var(--ink2)' }}>${msg}</p>`}
        ${error && html`<p style=${{ margin: '0 14px 8px', fontSize: '11px', color: 'var(--danger)' }}>${error}</p>`}
        <div style=${{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 14px 14px' }}>
          ${loading && html`<p style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${tr('library.recycle.loading')}</p>`}
          ${!loading && list.length === 0 && html`<p style=${{ fontSize: '11px', color: 'var(--ink3)', padding: '10px 0' }}>${openType === 'all' ? tr('library.recycle.emptyAll') : tr('library.recycle.emptyType')}</p>`}
          ${list.map((it) => html`
            <div key=${it.type + '/' + it.id} style=${{ border: '1px solid rgba(244,247,245,.08)', borderRadius: '8px', padding: '10px', marginBottom: '8px', background: 'var(--s2)' }}>
              <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style=${{ fontSize: '10px', color: 'var(--onaccent)', background: 'var(--accent)', borderRadius: '3px', padding: '1px 6px', flex: '0 0 auto' }}>${RECYCLE_TYPE_KEYS[it.type] ? tr(RECYCLE_TYPE_KEYS[it.type]) : it.type}</span>
                <span style=${{ fontSize: '11.5px', color: 'var(--ink)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${(it.entry && (it.entry.fileName || it.entry.prompt)) || it.id}</span>
              </div>
              <div style=${{ fontSize: '10px', color: 'var(--ink3)', marginTop: '4px', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>
                ${it.id} · ${String(it.trashedAt || '').slice(0, 19).replace('T', ' ')} · ${tr('library.recycle.fileCount', { n: it.fileCount || 0 })} · ${((it.sizeBytes || 0) / 1048576).toFixed(2)} MB
              </div>
              <div style=${{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <button onClick=${() => restore(it)} disabled=${busy === it.type + '/' + it.id} style=${btn(true)}>${tr('library.recycle.restore')}</button>
                <button onClick=${() => purge(it)} disabled=${busy === it.type + '/' + it.id} style=${btn(false)}>${tr('library.recycle.purge')}</button>
              </div>
            </div>
          `)}
        </div>
      </aside>
    </div>
  `;
}

// ---------------- 库（三 tab + 回收站入口） ----------------
// tasks：AppShell 的 /api/tasks 轮询结果，只给「成片」tab 的未完成卡片用（P6）。
export function LibraryView({ initialTab = 'finals', tasks = [] }) {
  const [tab, setTab] = useState(initialTab);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [taskTrashOpen, setTaskTrashOpen] = useState(false);
  const [libS, reloadLib] = useJson('/api/library');
  const [photoS, reloadPhotos] = useJson('/api/photos');  // 2026-11-16: counts share the full photo list
  const [recS, reloadRec] = useJson('/api/recycle');
  const [trashS, reloadTrash] = useJson('/api/trash');

  // 旧深链 /clips、/photos 进同一页，路由变化时切到对应 tab。
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  const allItems = [];
  for (const g of ((libS.data && libS.data.groups) || [])) {
    for (const it of (g.items || [])) allItems.push(it);
  }
  const finals = allItems.filter((it) => it.kind === 'final');
  const clipCount = allItems.filter((it) => it.kind !== 'final').length;
  const photos = (photoS.data && photoS.data.photos) || [];
  const recycleItems = (recS.data && recS.data.items) || [];
  const trashItems = Array.isArray(trashS.data) ? trashS.data : ((trashS.data && trashS.data.items) || []);

  const refreshAll = () => { reloadLib(); reloadPhotos(); reloadRec(); reloadTrash(); };
  const TABS = [
    { key: 'finals', labelKey: 'library.shell.tabs.finals', count: finals.length },
    { key: 'clips', labelKey: 'library.shell.tabs.clips', count: clipCount },
    { key: 'photos', labelKey: 'library.shell.tabs.photos', count: photos.length }
  ];

  return html`
    <div className="px-6 py-5" style=${{ paddingBottom: '84px' }}>
      <div className="flex items-center gap-3 mb-3.5">
        <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0">${tr('library.shell.title')}</h1>
        <span className="text-[11px] text-ink3 font-num">${tr('library.shell.summary', { finals: finals.length, clips: clipCount, photos: photos.length })}</span>
        <span className="flex-1"></span>
        <button onClick=${() => setTaskTrashOpen(true)}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]"
        >${tr('library.shell.taskTrash')}${trashItems.length ? ' · ' + trashItems.length : ''}</button>
        <button onClick=${() => setRecycleOpen(true)}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]"
        >${tr('library.shell.recycle')}${recycleItems.length ? ' · ' + recycleItems.length : ''}</button>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[.08] mb-3">
        ${TABS.map((t) => html`
          <button key=${t.key} onClick=${() => setTab(t.key)}
            className=${'h-8 px-3 text-[12px] ' + (tab === t.key ? 'text-accent' : 'text-ink3 hover:text-ink2')}
            style=${{ borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent' }}
          >${tr(t.labelKey)}<span className="ml-1.5 text-[10px] font-num" style=${{ opacity: .7 }}>${t.count}</span></button>
        `)}
      </div>

      ${tab === 'finals' && html`<${FinalsPanel} items=${finals} tasks=${tasks} loading=${libS.loading}
        error=${libS.error ? tr('library.shell.loadFailed') + libS.error : ''} onChanged=${refreshAll} />`}
      ${tab === 'clips' && html`<${ClipsPanel} onChanged=${refreshAll} />`}
      ${tab === 'photos' && html`<${PhotosPanel} onChanged=${refreshAll} />`}

      <${RecycleDrawer} open=${recycleOpen} items=${recycleItems} loading=${recS.loading}
        error=${recS.error ? tr('library.shell.recycleLoadFailed') + recS.error : ''}
        onClose=${() => setRecycleOpen(false)} onChanged=${refreshAll} />

      <${TaskTrashDrawer} open=${taskTrashOpen} items=${trashItems} loading=${trashS.loading}
        error=${trashS.error ? tr('library.shell.taskTrashLoadFailed') + trashS.error : ''}
        onClose=${() => setTaskTrashOpen(false)} onChanged=${refreshAll} />
    </div>
  `;
}

// 旧导出兼容（shell 旧版本或深链还在引用时不会崩）：清单一律落到新库页。
export function ClipsView() {
  return html`<${LibraryView} initialTab="clips" />`;
}
export function PhotosView() {
  return html`<${LibraryView} initialTab="photos" />`;
}

// ---------------- 配乐 ----------------
const MUSIC_FIELDS = [
  ['title', 'library.music.field.title', 'text'],
  ['cat', 'library.music.field.cat', 'text'],
  ['mood', 'library.music.field.mood', 'text'],
  ['bpm', 'library.music.field.bpm', 'number'],
  ['inst', 'library.music.field.inst', 'text'],
  ['author', 'library.music.field.author', 'text'],
  ['source', 'library.music.field.source', 'text'],
  ['license', 'library.music.field.license', 'text'],
  ['url', 'library.music.field.url', 'text']
];

export function MusicView() {
  const [s, reload] = useJson('/api/bgm');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({});
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState('');
  const [playErr, setPlayErr] = useState('');
  const audioRef = useRef(null);
  const MAX_AUDIO_MB = 20;

  // 离开配乐页时停掉试听，避免声音还在后台响
  useEffect(() => () => {
    try { if (audioRef.current) audioRef.current.pause(); } catch (e) { /* ignore */ }
  }, []);

  const tracks = (s.data && s.data.tracks) || [];
  const prefs = s.data || {};
  const defaultId = prefs.defaultTrackId || '';

  // 试听：/bgm 是不拦登录的静态目录，直接把音频文件地址交给 <audio>
  function bgmUrl(track) {
    return '/bgm/' + String(track.file || '').split('/').map(encodeURIComponent).join('/');
  }

  function togglePlay(t) {
    setPlayErr('');
    try {
      let a = audioRef.current;
      if (!a) { a = new window.Audio(); audioRef.current = a; }
      if (playingId === t.id) { a.pause(); setPlayingId(''); return; }
      a.onended = () => setPlayingId('');
      a.onerror = () => { setPlayErr(tr('library.music.listenFailedFile', { name: t.title || t.id })); setPlayingId(''); };
      a.src = bgmUrl(t);
      const p = a.play();
      if (p && p.catch) {
        p.catch((e) => {
          setPlayErr(tr('library.music.listenFailed') + (e && e.message ? e.message : tr('library.music.browserBlocked')));
          setPlayingId('');
        });
      }
      setPlayingId(t.id);
    } catch (e) { setPlayErr(tr('library.music.listenFailed') + e.message); }
  }

  async function setDefault(id) {
    setErr('');
    try {
      const r = await fetch('/api/bgm/prefs', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultTrackId: id })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      reload();
    } catch (e) { setErr(tr('library.music.setDefaultFailed') + e.message); }
  }

  async function remove(id) {
    if (!window.confirm(tr('library.music.removeConfirm'))) return;
    setErr('');
    try {
      const r = await fetch('/api/bgm/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      reload();
    } catch (e) { setErr(tr('library.music.deleteFailed') + e.message); }
  }

  // 上传音频：FileReader 读成 dataURL（后端只收 base64，零新依赖），
  // 顺便用 <audio> 读时长（拿不到就 0，不阻塞上传；后端不跑 ffprobe 读 stdout，避开本机 EPERM）。
  async function uploadFile(file) {
    setErr('');
    if (!file) return;
    if (file.size > MAX_AUDIO_MB * 1024 * 1024) {
      setErr(tr('library.music.fileTooLarge', { size: (file.size / 1048576).toFixed(1), max: MAX_AUDIO_MB }));
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ''));
        fr.onerror = () => rej(new Error(tr('library.music.readFailed')));
        fr.readAsDataURL(file);
      });
      const durationSec = await new Promise((res) => {
        try {
          const a = new window.Audio();
          a.preload = 'metadata';
          a.onloadedmetadata = () => {
            const d = a.duration;
            res(Number.isFinite(d) ? Math.round(d * 10) / 10 : 0);
          };
          a.onerror = () => res(0);
          a.src = dataUrl;
        } catch (e) { res(0); }
      });
      const r = await fetch('/api/bgm', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          fileData: dataUrl,
          title: file.name.replace(/\.[^.]+$/, ''),
          category: 'music',
          durationSec
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      reload();
    } catch (e) {
      setErr(tr('library.music.uploadFailed') + e.message);
    } finally {
      setUploading(false);
    }
  }

  async function submitAdd() {
    setErr('');
    if (!(form.title || '').trim()) { setErr(tr('library.music.titleRequired')); return; }
    try {
      const r = await fetch('/api/bgm', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setAdding(false); setForm({}); reload();
    } catch (e) { setErr(tr('library.music.addFailed') + e.message); }
  }

  return html`
    <div className="px-6 py-5">
      <${Head} title=${tr('library.music.title')} sub=${tp('library.music.count', tracks.length)}>
        <label className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px] inline-flex items-center cursor-pointer">
          ${uploading ? tr('library.music.uploading') : tr('library.music.upload')}
          <input type="file" accept=".mp3,.wav,.m4a,.ogg,audio/*" className="hidden"
            disabled=${uploading}
            onChange=${(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) uploadFile(f); }} />
        </label>
        <button onClick=${() => navigate('/bgm')}
          className="h-8 px-3 rounded-[6px] border border-accent/40 text-accent text-[12px] hover:bg-accent/[.08]"
          title=${tr('library.music.editorTitle')}
        >${tr('library.music.editor')}</button>
        <button onClick=${() => setAdding((v) => !v)}
          className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]"
        >${adding ? tr('library.music.collapse') : tr('library.music.add')}</button>
      </${Head}>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${playErr && html`<p className="mb-2 text-[12px] text-danger">${playErr}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${adding && html`
        <div className="mb-4 rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3">
          <p className="text-[12px] text-ink mb-2">${tr('library.music.addTitle')}</p>
          <div className="grid grid-cols-3 gap-x-3 gap-y-2">
            ${MUSIC_FIELDS.map((f) => html`
              <label key=${f[0]} className="flex flex-col gap-1">
                <span className="text-[11px] text-ink3">${tr(f[1])}</span>
                <input type=${f[2]} value=${form[f[0]] || ''}
                  onInput=${(e) => setForm((x) => ({ ...x, [f[0]]: e.target.value }))}
                  className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none" />
              </label>
            `)}
          </div>
          <p className="mt-2 text-[11px] leading-[1.7] text-ink3">
            ${tr('library.music.uploadNote', { max: MAX_AUDIO_MB })}
          </p>
          <div className="mt-2 flex gap-2">
            <button onClick=${submitAdd} className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]">${tr('library.music.save')}</button>
            <button onClick=${() => setAdding(false)}
              className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2">${tr('library.music.cancel')}</button>
          </div>
        </div>
      `}

      ${tracks.length === 0 && !s.loading && html`<${Empty}>${tr('library.music.empty')}</${Empty}>`}

      <div className="rounded-[8px] border border-white/[.08] overflow-hidden bg-s1">
        ${tracks.map((t) => html`
          <div key=${t.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/[.05] last:border-0">
            <button onClick=${() => togglePlay(t)}
              title=${playingId === t.id ? tr('library.music.stop') : tr('library.music.play')}
              className="w-[26px] h-[26px] rounded-full border border-white/[.10] grid place-items-center text-[10px] text-ink2 hover:bg-white/[.08] cursor-pointer"
            >${playingId === t.id ? '⏸' : '▶'}</button>
            <span className="flex-1 min-w-0 cursor-pointer" onClick=${() => togglePlay(t)}>
              <b className="block text-[12.5px] font-medium text-ink truncate">${t.title || t.id}</b>
              <span className="block text-[10px] text-ink3 font-num">
                ${[t.cat, t.mood, t.author, t.license].filter(Boolean).join(' · ')}
              </span>
            </span>
            ${defaultId === t.id
              ? html`<span className="text-[10px] px-1.5 py-[3px] rounded-[3px] bg-accent text-onaccent">${tr('library.music.defaultBadge')}</span>`
              : html`<button onClick=${() => setDefault(t.id)}
                  className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:bg-white/[.06]">${tr('library.music.setDefault')}</button>`}
            <button onClick=${() => remove(t.id)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-danger hover:bg-white/[.06]">${tr('library.music.delete')}</button>
          </div>
        `)}
      </div>
    </div>
  `;
}
