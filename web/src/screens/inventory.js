// ============================================================
// 库（2026-11-15 P2：合并片段 + 照片，新增成片与回收站）
// ------------------------------------------------------------
// 页面结构：一个「库」页，三个 tab（固定顺序）成片 / 片段 / 图片。
//   成片：GET /api/library 里 kind=final 的条目（含 origin=task|library|editor|orphan）
//   片段：GET /api/library?favorite=&q=&resolution=&model=
//         PUT /api/library/:id {favorite} · DELETE /api/library/:id（进回收站）
//         POST /api/library/:id/regenerate {prompt}
//   图片：GET /api/photos?final=1 · PUT/DELETE /api/photos/:id
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
  if (cost.computed === false) return '未配置';
  const n = Number(cost.amount);
  return Number.isFinite(n) ? '¥' + n.toFixed(2) : '';
}

function qcText(qc) {
  if (!qc) return '未质检';
  if (qc.passed) return 'QC 通过';
  return 'QC ' + (qc.level || '未通过');
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

const ORIGIN_TEXT = { task: '任务', library: '片段库', editor: '剪辑导出', orphan: '孤儿' };

// 费用：没有快照就显示“未知”，绝不写 ¥0.00（2026-11-15 口径）。
function costLabel(cost) {
  if (!cost) return '未知';
  if (cost.computed === false) return '未知';
  const n = Number(cost.amount);
  return Number.isFinite(n) ? '¥' + n.toFixed(2) : '未知';
}

function qcBadge(qc) {
  if (!qc) return html`<span className="text-[10px] text-ink3">未质检</span>`;
  if (qc.passed) return html`<span className="text-[10px] text-accent">QC 通过</span>`;
  if (qc.unverified) return html`<span className="text-[10px] text-warn">QC 未验证</span>`;
  return html`<span className="text-[10px] text-danger">QC 不通过</span>`;
}

// 缩略图：走 /api/library/:id/thumb（服务端抽帧缓存）；失败就显示占位，不装样子。
function Thumb({ id }) {
  const [bad, setBad] = useState(false);
  const box = { width: '86px', height: '48px', flex: '0 0 auto' };
  if (bad || !id) {
    return html`<span className="grid place-items-center bg-black rounded-[4px] text-[9px] text-ink3"
      style=${box}>无图</span>`;
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
  >${label || '下载'}</a>`;
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
    } catch (e) { setErr('收藏失败：' + e.message); }
  }

  async function remove(id) {
    if (!window.confirm('删除这条片段？会先移入回收站，可在回收站恢复。')) return;
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      reload();
      if (onChanged) onChanged();
    } catch (e) { setErr('删除失败：' + e.message); }
  }

  async function regen(it) {
    if (!window.confirm('按原提示词重新生成一条？旧的会保留。')) return;
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(it.id) + '/regenerate', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: it.prompt })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      window.alert('已提交重新生成（在后台跑，完成后会进片段库）。');
    } catch (e) { setErr('重新生成失败：' + e.message); }
  }

  return html`
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button onClick=${() => setFav((v) => !v)}
          className=${'h-8 px-3 rounded-[6px] text-[12px] border ' +
            (fav ? 'border-accent/50 text-accent' : 'border-white/[.10] text-ink2 hover:bg-white/[.05]')}
        >只看收藏</button>
        <select value=${res} onChange=${(e) => setRes(e.target.value)}
          className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
          <option value="">全部分辨率</option>
          ${(facets.resolutions || []).map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
        </select>
        <input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="搜索提示词…"
          className="h-8 w-[190px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
        <span className="flex-1"></span>
        <span className="text-[11px] text-ink3">${clipCount} 条 · ${s.loading ? '加载中…' : (s.error ? '读取失败' : '')}</span>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${clipGroups.length === 0 && !s.loading && html`<${Empty}>没有匹配的片段</${Empty}>`}

      ${clipGroups.map((g) => html`
        <div key=${g.label} className="mb-4">
          <div className="flex items-baseline gap-2 border-b border-white/[.08] pb-1 mb-2">
            <span className="text-[12px] font-medium text-ink">${g.label}</span>
            <span className="text-[10px] text-ink3 font-num">${g.count} 条</span>
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
                    ${it.status === 'failed' ? html`<span className="text-[10px] text-danger">生成失败</span>` : null}
                    <span className="opacity-40">·</span>
                    <span>费用 ${costLabel(it.cost)}</span>
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <button onClick=${() => toggleFav(it.id, it.favorite)}
                      className=${'h-6 px-1.5 rounded-[4px] text-[12px] hover:bg-white/[.06] ' +
                        (it.favorite ? 'text-accent' : 'text-ink3')}
                    >${it.favorite ? '★' : '☆'}</button>
                    <span className="text-[10px] text-ink3 font-num">${it.model || ''}</span>
                    <span className="flex-1"></span>
                    <button onClick=${() => setDetail(it)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06]">详情</button>
                    <button onClick=${() => regen(it)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06]">重新生成</button>
                    <${DownloadLink} url=${it.url} fileName=${it.fileName} />
                    <button onClick=${() => remove(it.id)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:text-danger hover:bg-white/[.06]">删除</button>
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
              <b style=${{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>片段详情</b>
              <button onClick=${() => setDetail(null)} style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>关闭</button>
            </div>
            <video src=${detail.url} controls playsInline style=${{ width: '100%', maxHeight: '340px', background: '#000', borderRadius: '6px' }}></video>
            <div style=${{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '6px 10px', marginTop: '12px', fontSize: '11.5px', lineHeight: 1.7 }}>
              <span style=${{ color: 'var(--ink3)' }}>提示词</span>
              <span style=${{ color: 'var(--ink2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>${detail.prompt || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>型号</span>
              <span style=${{ color: 'var(--ink2)' }}>${detail.model || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>规格</span>
              <span style=${{ color: 'var(--ink2)' }}>${[
                detail.resolution,
                detail.width && detail.height ? detail.width + '×' + detail.height : '',
                detail.fps ? detail.fps + 'fps' : '',
                detail.durationSec ? Number(detail.durationSec).toFixed(2) + 's' : '',
                detail.sizeBytes ? (Number(detail.sizeBytes) / 1048576).toFixed(2) + ' MB' : ''
              ].filter(Boolean).join(' · ')}</span>
              <span style=${{ color: 'var(--ink3)' }}>成本</span>
              <span style=${{ color: 'var(--ink2)' }}>${costText(detail.cost) || '-'}${detail.cost && detail.cost.label ? ' · ' + detail.cost.label : ''}${detail.cost && detail.cost.attempts ? ' · ' + detail.cost.attempts + ' 次' : ''}</span>
              <span style=${{ color: 'var(--ink3)' }}>质检</span>
              <span style=${{ color: 'var(--ink2)' }}>${qcText(detail.qc)}${detail.qc && detail.qc.reason ? ' · ' + detail.qc.reason : ''}${detail.qc && detail.qc.qcVersion ? ' · v' + detail.qc.qcVersion : ''}</span>
              <span style=${{ color: 'var(--ink3)' }}>来源任务</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.taskId || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>源图</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.sourcePhotoId || '-'}</span>
              ${sourceVersions.length > 1 && html`
                <div style=${{ gridColumn: '1 / -1', marginTop: '4px' }}>
                  <div style=${{ fontSize: '11px', color: 'var(--ink3)', marginBottom: '6px' }}>源图版本链（相邻版本并排）</div>
                  ${sourceVersions.slice(1).map((v, i) => {
                    const prev = sourceVersions[i];
                    return html`
                      <div key=${v.id} style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' }}>
                        <div><img src=${prev.url} style=${{ width: '100%', maxHeight: '150px', objectFit: 'contain', background: '#000', borderRadius: '4px' }} /><div style=${{ fontSize: '10px', color: 'var(--ink3)', textAlign: 'center' }}>V${prev.version}</div></div>
                        <div><img src=${v.url} style=${{ width: '100%', maxHeight: '150px', objectFit: 'contain', background: '#000', borderRadius: '4px' }} /><div style=${{ fontSize: '10px', color: 'var(--ink3)', textAlign: 'center' }}>V${v.version}${v.isFinal ? ' · 最终' : ''}</div></div>
                      </div>`;
                  })}
                </div>`}
              <span style=${{ color: 'var(--ink3)' }}>文件</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.fileName || '-'}</span>
            </div>
            <div style=${{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button
                onClick=${() => { toggleFav(detail.id, detail.favorite); setDetail(null); }}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}
              >${detail.favorite ? '取消收藏' : '收藏'}</button>
              <button
                onClick=${() => { regen(detail); setDetail(null); }}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}
              >按原提示词重新生成</button>
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
const PHOTO_STATUS_TEXT = { pending: '待审', approved: '已通过', rejected: '已打回' };

export function PhotosPanel({ onChanged }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState(null);
  const [versions, setVersions] = useState([]);
  const [zoomImg, setZoomImg] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editVideoPrompt, setEditVideoPrompt] = useState('');

  async function openDetail(p) {
    setDetail(p);
    setVersions([]);
    setEditPrompt(p.imagePrompt || p.prompt || '');
    setEditVideoPrompt(p.videoPrompt || '');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(p.id), { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.id) {
        setDetail(j);
        setVersions(Array.isArray(j.versions) ? j.versions : []);
        setEditPrompt(j.imagePrompt || j.prompt || '');
        setEditVideoPrompt(j.videoPrompt || '');
      }
    } catch (e) { /* 详情失败不回滚列表 */ }
  }

  const qs = new URLSearchParams();
  qs.set('final', '1');
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
    } catch (e) { setErr('审核失败：' + e.message); }
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
    } catch (e) { setErr('设为最终版失败：' + e.message); }
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
    } catch (e) { setErr('科学审查失败：' + e.message); }
  }

  async function remove(id) {
    if (!window.confirm('删除这张图片？会先移入回收站，可在回收站恢复。')) return;
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail(null);
      reload();
      if (onChanged) onChanged();
    } catch (e) { setErr('删除失败：' + e.message); }
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
    } catch (e) { setErr('保存提示词失败：' + e.message); }
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
    } catch (e) { setErr('带入创作失败：' + e.message); }
  }

  const promptText = (p) => ((p.imagePrompt || p.prompt) || (p.promptAvailable === false ? '（历史文件：提示词未记录）' : '（无提示词）'));

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
    if (String(p.id).endsWith('_original') || p.label === '调色前') g.before = p;
    else if (p.label === '调色后') g.after = p;
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
  const usedText = (p) => (Array.isArray(p.usedIn) && p.usedIn.length ? '已用于生成视频' : '尚未用于视频');
  const cleanPrompt = (p) => promptText(p).replace(/^【(调色前|调色后)】/, '');
  const detailPair = detail
    ? photoGroups.find((g) => g.key === pairKey(detail) && g.before && g.after)
    : null;

  return html`
    <div>
      <p className="mb-3 text-[11px] leading-[1.7] text-ink3">
        生成的图片会自动入库并保留提示词（不再只留一个 clips 文件）。点「通过」表示这张图可以作为下一步图生视频的输入。调色前/后并列展示；生成费用按价目表估算，调色是本地派生、不重复计费。
      </p>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <select value=${status} onChange=${(e) => setStatus(e.target.value)}
          className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
          <option value="">全部状态</option>
          <option value="pending">待审</option>
          <option value="approved">已通过</option>
          <option value="rejected">已打回</option>
        </select>
        <input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="搜索提示词…"
          className="h-8 w-[190px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
        <span className="flex-1"></span>
        <span className="text-[11px] text-ink3 font-num">
          ${totals.all || 0} 张 · 待审 ${totals.pending || 0} · 通过 ${totals.approved || 0} · 打回 ${totals.rejected || 0}
        </span>
        <span className="text-[11px] text-ink3">${s.loading ? '加载中…' : (s.error ? '读取失败' : '')}</span>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${photos.length === 0 && !s.loading && html`<${Empty}>
        ${status || q.trim() ? '没有匹配的照片' : '还没有照片。到「创作」第②步生成一张，就会自动入库。'}
      </${Empty}>`}

      <div className="grid grid-cols-4 gap-3">
        ${photoGroups.map((g) => {
          if (g.before && g.after) {
            const p = g.after;
            return html`
              <div key=${g.key} style=${{ gridColumn: 'span 2' }} className="rounded-[6px] border border-white/[.08] bg-s1 overflow-hidden">
                <div className="grid grid-cols-2 gap-px bg-black">
                  <div style=${{ position: 'relative' }}>
                    <img src=${g.before.url} alt="调色前"
                      onClick=${() => openDetail(g.before)}
                      className="w-full aspect-video bg-black object-cover cursor-pointer" />
                    <span style=${{ position: 'absolute', left: '6px', top: '6px', padding: '2px 6px', borderRadius: '3px', background: 'rgba(0,0,0,.65)', color: '#fff', fontSize: '10px' }}>调色前</span>
                  </div>
                  <div style=${{ position: 'relative' }}>
                    <img src=${g.after.url} alt="调色后"
                      onClick=${() => openDetail(g.after)}
                      className="w-full aspect-video bg-black object-cover cursor-pointer" />
                    <span style=${{ position: 'absolute', left: '6px', top: '6px', padding: '2px 6px', borderRadius: '3px', background: 'rgba(0,0,0,.65)', color: '#fff', fontSize: '10px' }}>调色后</span>
                  </div>
                </div>
                <div className="px-2 py-1.5">
                  <p className="text-[11px] leading-[1.5] text-ink2 line-clamp-2 min-h-[32px]">${cleanPrompt(p)}</p>
                  <p className="text-[10px] text-ink3 font-num">
                    ${PHOTO_STATUS_TEXT[p.status] || p.status}
                    ${p.width && p.height ? ' · ' + p.width + '×' + p.height : ''}
                    ${' · 生成 ' + (costText(g.before.cost) || '-')}
                    ${' · 调色 ' + (costText(g.after.cost) || '-')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink3">${usedText(g.after)}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-ink3 font-num">${p.model || ''}</span>
                    <span className="flex-1"></span>
                    <button onClick=${() => openDetail(g.after)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">查看对比</button>
                    <${DownloadLink} url=${g.after.url} fileName=${g.after.fileName} />
                    <button onClick=${() => useInCreation(g.after)}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">用它生成视频</button>
                  </div>
                </div>
              </div>`;
          }
          const p = g.after || g.before || g.singles[0];
          return html`
            <div key=${p.id} className="rounded-[6px] border border-white/[.08] bg-s1 overflow-hidden">
              <img src=${p.url} alt="生成的图片"
                onClick=${() => openDetail(p)}
                className="w-full aspect-video bg-black object-cover cursor-pointer" />
              <div className="px-2 py-1.5">
                <p className="text-[11px] leading-[1.5] text-ink2 line-clamp-2 min-h-[32px]">${promptText(p)}</p>
                <p className="text-[10px] text-ink3 font-num">
                  ${PHOTO_STATUS_TEXT[p.status] || p.status}
                  ${p.width && p.height ? ' · ' + p.width + '×' + p.height : ''}
                  ${costText(p.cost) ? ' · ' + costText(p.cost) : ''}
                </p>
                <p className="mt-0.5 text-[10px] text-ink3">${usedText(p)}</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[10px] text-ink3 font-num">${p.model || ''}</span>
                  <span className="flex-1"></span>
                  <button onClick=${() => useInCreation(p)}
                    className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">用它生成视频</button>
                  ${p.status !== 'approved' && html`
                    <button onClick=${() => review(p.id, 'approved')}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">通过</button>`}
                  ${p.status !== 'rejected' && html`
                    <button onClick=${() => review(p.id, 'rejected')}
                      className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06]">打回</button>`}
                  <${DownloadLink} url=${p.url} fileName=${p.fileName} />
                  <button onClick=${() => remove(p.id)}
                    className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:text-danger hover:bg-white/[.06]">删除</button>
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
              <b style=${{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>图片详情</b>
              <span style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${PHOTO_STATUS_TEXT[detail.status] || detail.status}</span>
              <span style=${{ flex: 1 }}></span>
              <button onClick=${() => setDetail(null)} style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>关闭</button>
            </div>
            <img src=${detail.url} alt="生成的图片" onClick=${() => setZoomImg(detail.url)}
              style=${{ width: '100%', maxHeight: '420px', objectFit: 'contain', background: '#000', borderRadius: '6px', cursor: 'zoom-in' }} />
            ${versions.length > 1 && html`
              <div style=${{ marginTop: '14px' }}>
                <div style=${{ fontSize: '12px', color: 'var(--ink2)', marginBottom: '8px' }}>
                  版本过程（相邻版本并排，共 ${versions.length} 版）
                  ${detail.isFinal ? html`<span style=${{ marginLeft: '8px', color: 'var(--accent)', fontSize: '10.5px' }}>当前最终版</span>` : ''}
                </div>
                ${versions.slice(1).map((v, i) => {
                  const prev = versions[i];
                  return html`
                    <div key=${v.id} style=${{ marginBottom: '10px' }}>
                      <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                        <div>
                          <img src=${prev.url} alt=${'V' + prev.version} onClick=${() => setZoomImg(prev.url)}
                            style=${{ width: '100%', maxHeight: '260px', objectFit: 'contain', background: '#000', borderRadius: '6px', cursor: 'zoom-in' }} />
                          <div style=${{ marginTop: '3px', fontSize: '10.5px', color: 'var(--ink3)', textAlign: 'center' }}>V${prev.version}${prev.isFinal ? ' · 最终' : ''}${prev.status === 'rejected' ? ' · 已淘汰' : ''}</div>
                        </div>
                        <div>
                          <img src=${v.url} alt=${'V' + v.version} onClick=${() => setZoomImg(v.url)}
                            style=${{ width: '100%', maxHeight: '260px', objectFit: 'contain', background: '#000', borderRadius: '6px', cursor: 'zoom-in' }} />
                          <div style=${{ marginTop: '3px', fontSize: '10.5px', color: 'var(--ink3)', textAlign: 'center' }}>V${v.version}${v.isFinal ? ' · 最终' : ''}${v.status === 'rejected' ? ' · 已淘汰' : ''}</div>
                        </div>
                      </div>
                      ${v.revisionNote ? html`<div style=${{ marginTop: '3px', fontSize: '10.5px', color: 'var(--ink3)' }}>${v.revisionNote}</div>` : ''}
                    </div>`;
                })}
              </div>`}
            ${versions.some((v) => v.failureSummary) && html`
              <div style=${{ marginTop: '10px', padding: '8px 10px', border: '1px solid rgba(217,139,106,.25)', borderRadius: '6px', background: 'rgba(217,139,106,.06)' }}>
                <div style=${{ fontSize: '11px', color: 'var(--ink2)', marginBottom: '4px' }}>失败 / 淘汰记录（不展示失败图）</div>
                ${versions.filter((v) => v.failureSummary).map((v) => html`
                  <div key=${'fail-' + v.id} style=${{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.6 }}>V${v.version}：${v.failureSummary}</div>`)}
              </div>`}
            <div style=${{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '6px 10px', marginTop: '12px', fontSize: '11.5px', lineHeight: 1.7 }}>
              <span style=${{ color: 'var(--ink3)' }}>画面提示词</span>
              <div>
                <textarea value=${editPrompt} onInput=${(e) => setEditPrompt(e.target.value)}
                  rows="3" placeholder="画面内容（历史图可以手动补录）"
                  style=${{ width: '100%', resize: 'vertical', background: 'var(--s2)', color: 'var(--ink)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '6px', padding: '6px 8px', fontSize: '11.5px', lineHeight: 1.7, outline: 'none', fontFamily: 'inherit' }}></textarea>
                <span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>
                  出图时原值：${detail.generationPrompt || '未记录'}
                </span>
              </div>
              <span style=${{ color: 'var(--ink3)' }}>视频提示词</span>
              <div>
                <textarea value=${editVideoPrompt} onInput=${(e) => setEditVideoPrompt(e.target.value)}
                  rows="2" placeholder="最近一次用它生成视频的运动描述（可空）"
                  style=${{ width: '100%', resize: 'vertical', background: 'var(--s2)', color: 'var(--ink)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '6px', padding: '6px 8px', fontSize: '11.5px', lineHeight: 1.7, outline: 'none', fontFamily: 'inherit' }}></textarea>
                <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
                  <button onClick=${() => savePrompt(detail.id)}
                    style=${{ height: '26px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>保存提示词</button>
                  <span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>
                    ${detail.videoPromptUpdatedAt ? '最近视频提示词更新于 ' + String(detail.videoPromptUpdatedAt).slice(0, 19).replace('T', ' ') : '还没有用它生成过视频'}
                  </span>
                </div>
              </div>
              <span style=${{ color: 'var(--ink3)' }}>模型</span>
              <span style=${{ color: 'var(--ink2)' }}>${detail.model || '-'}${detail.provider ? ' · ' + detail.provider : ''}</span>
              <span style=${{ color: 'var(--ink3)' }}>规格</span>
              <span style=${{ color: 'var(--ink2)' }}>${[
                detail.width && detail.height ? detail.width + '×' + detail.height : '',
                detail.size || '',
                detail.sizeBytes ? (Number(detail.sizeBytes) / 1048576).toFixed(2) + ' MB' : ''
              ].filter(Boolean).join(' · ') || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>生成费用</span>
              <span style=${{ color: 'var(--ink2)' }}>${costText(detail.cost) || '-'}${detail.cost && detail.cost.label ? ' · ' + detail.cost.label : ''}</span>
              ${detail.failureSummary && html`
                <span style=${{ color: 'var(--ink3)' }}>失败记录</span>
                <span style=${{ color: 'var(--ink2)' }}>${detail.failureSummary}</span>`}
              <span style=${{ color: 'var(--ink3)' }}>生成时间</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace' }}>${detail.createdAt || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>文件</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>${detail.fileName || '-'}</span>
              <span style=${{ color: 'var(--ink3)' }}>用于视频</span>
              <span style=${{ color: 'var(--ink2)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>
                ${Array.isArray(detail.usedIn) && detail.usedIn.length ? detail.usedIn.map((u) => u.taskId).join(', ') : '（还没用过）'}
              </span>
            </div>
            <div style=${{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              ${!detail.isFinal && html`
                <button onClick=${() => makeFinal(detail.id)}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>设为最终版</button>`}
              <button onClick=${() => useInCreation(detail)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>用它生成视频</button>
              ${detail.status !== 'approved' && html`
                <button onClick=${() => review(detail.id, 'approved')}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>通过</button>`}
              ${detail.status !== 'rejected' && html`
                <button onClick=${() => review(detail.id, 'rejected')}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>打回</button>`}
              <${DownloadLink} url=${detail.url} fileName=${detail.fileName} />
              <button onClick=${() => remove(detail.id)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>删除</button>
            </div>
          </div>
        </div>
      `}
      ${zoomImg && html`
        <div onClick=${() => setZoomImg('')}
          style=${{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.92)', display: 'grid', placeItems: 'center', cursor: 'zoom-out', padding: '18px' }}>
          <img src=${zoomImg} alt="放大查看"
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
  const finalTaskIds = new Set((finals || []).map((it) => it.taskId).filter(Boolean));
  const rows = (tasks || [])
    .filter((t) => t
      && (t.status === 'failed' || t.status === 'partial')
      && t.model !== 'mock'
      && !t.fragmentOnly
      && !finalTaskIds.has(t.taskId))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (!rows.length) return null;

  return html`
    <div className="mb-4 rounded-[8px] border border-warn/30 bg-warn/[.05] px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-warn">未完成 ${rows.length} 条</span>
        <span className="text-[10px] text-ink3">失败任务仍可补跑；成片齐全后会自动从这里消失。</span>
      </div>
      <div className="mt-1">
        ${rows.map((t) => {
          const st = statusMeta(t.status, t);
          return html`
            <div key=${t.taskId} className="flex items-center gap-2.5 py-1.5 border-t border-white/[.05]">
              <span className=${'w-[6px] h-[6px] rounded-full shrink-0 ' + st.dot}></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-ink truncate">${(t.prompt || '(无提示词)').slice(0, 80)}</span>
                <span className="block text-[10px] text-ink3 font-num">
                  ${t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-'}
                  ${' · ' + st.text}
                  ${t.failedClips ? ' · 失败片段 ' + t.failedClips : ''}
                  ${t.recoverable ? ' · 可补跑' : ''}
                </span>
              </span>
              <button onClick=${() => setOpenId(t.taskId)}
                className="h-6 px-2 rounded-[4px] text-[10px] text-ink2 hover:bg-white/[.06] shrink-0"
              >详情 / 补跑</button>
            </div>
          `;
        })}
      </div>
      ${openId && html`<${TaskDrawer} taskId=${openId}
        onClose=${() => { setOpenId(null); if (onChanged) onChanged(); }} />`}
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
    if (!window.confirm('删除这条成片？会先移入回收站，可在回收站恢复。')) return;
    setErr('');
    setBusy(it.id);
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(it.id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      if (onChanged) onChanged();
    } catch (e) { setErr('删除失败：' + e.message); }
    finally { setBusy(''); }
  }

  return html`
    <div>
      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${error && html`<p className="mb-2 text-[12px] text-danger">${error}</p>`}
      <${UnfinishedPanel} tasks=${tasks} finals=${items} onChanged=${onChanged} />
      ${(items || []).length === 0 && !loading && html`<${Empty}>还没有成片。创作完成或剪辑台导出后会出现在这里。</${Empty}>`}
      <div className="rounded-[8px] border border-white/[.08] overflow-hidden bg-s1">
        ${(items || []).map((it) => html`
          <div key=${it.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/[.05] last:border-0">
            <${Thumb} id=${it.id} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12.5px] text-ink truncate">${it.prompt || it.fileName || it.id}</span>
                ${it.suspectedDamage ? html`<span className="text-[10px] text-warn">疑似损坏</span>` : null}
              </div>
              <p className="text-[10px] text-ink3 font-num flex items-center gap-1.5 flex-wrap mt-0.5">
                <span>${fmtDurSec(it.durationSec)}</span>
                <span className="opacity-40">·</span>
                <span>${it.resolution || '-'}</span>
                <span className="opacity-40">·</span>
                <span>来源 ${ORIGIN_TEXT[it.origin] || it.origin || '未知'}</span>
                <span className="opacity-40">·</span>
                <span>费用 ${costLabel(it.cost)}</span>
                <span className="opacity-40">·</span>
                ${qcBadge(it.qc)}
              </p>
            </div>
            <button onClick=${() => setPlay(it)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-accent hover:bg-white/[.06]">播放</button>
            <${DownloadLink} url=${it.url} fileName=${it.fileName} label="下载" />
            <button onClick=${() => remove(it)} disabled=${busy === it.id}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-danger hover:bg-white/[.06]">删除</button>
          </div>
        `)}
      </div>

      ${play && html`
        <div style=${{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,7,5,.78)', display: 'grid', placeItems: 'center' }}
          onClick=${(e) => { if (e.target === e.currentTarget) setPlay(null); }}>
          <div style=${{ width: 'min(880px, 94vw)', background: 'var(--s1)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '10px', padding: '12px' }}>
            <div style=${{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <b style=${{ fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>${play.fileName || play.id}</b>
              <span style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${fmtDurSec(play.durationSec)} · ${play.resolution || '-'} · 来源 ${ORIGIN_TEXT[play.origin] || play.origin || '未知'}</span>
              <span style=${{ flex: 1 }}></span>
              <button onClick=${() => setPlay(null)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>关闭</button>
            </div>
            <video src=${play.url} controls autoPlay playsInline
              style=${{ width: '100%', maxHeight: '68vh', background: '#000', borderRadius: '6px' }}></video>
            <p style=${{ marginTop: '8px', fontSize: '11px', lineHeight: 1.7, color: 'var(--ink3)', whiteSpace: 'pre-wrap' }}>${play.prompt || '（无提示词）'}</p>
          </div>
        </div>`}
    </div>
  `;
}

// ---------------- 回收站抽屉 ----------------
// 删除只进这里；彻底删除必须在这里再确认一次（两次确认的口径见交接 §7）。
const RECYCLE_TYPE_TEXT = { clip: '片段', final: '成片', photo: '图片', bgm: '配乐' };
const RECYCLE_TABS = [
  { key: 'all', label: '全部' },
  { key: 'clip', label: '片段' },
  { key: 'final', label: '成片' },
  { key: 'photo', label: '图片' },
  { key: 'bgm', label: '配乐' }
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
      setMsg('已恢复：' + ((it.entry && it.entry.fileName) || it.id)
        + (j.conflicts && j.conflicts.length ? '（目标位置已有同名文件，恢复为 .restored-*）' : ''));
      if (onChanged) onChanged();
    } catch (e) { setMsg('恢复失败：' + e.message); }
    finally { setBusy(''); }
  }

  async function purge(it) {
    if (!window.confirm('彻底删除「' + ((it.entry && it.entry.fileName) || it.id) + '」？\n删除后无法恢复。')) return;
    setMsg(''); setBusy(it.type + '/' + it.id);
    try {
      const r = await fetch('/api/recycle/' + encodeURIComponent(it.type) + '/' + encodeURIComponent(it.id),
        { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setMsg('已彻底删除');
      if (onChanged) onChanged();
    } catch (e) { setMsg('彻底删除失败：' + e.message); }
    finally { setBusy(''); }
  }

  async function purgeAll() {
    if (!window.confirm('清空全部回收站条目？\n删除后无法恢复。')) return;
    setMsg(''); setBusy('all');
    try {
      const r = await fetch('/api/recycle/all/purge', { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setMsg('已清空回收站（' + (j.removed || 0) + ' 项）');
      if (onChanged) onChanged();
    } catch (e) { setMsg('清空失败：' + e.message); }
    finally { setBusy(''); }
  }

  if (!open) return null;
  return html`
    <div style=${{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(4,7,5,.55)' }}
      onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside style=${{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(560px, 94vw)', background: 'var(--s1)', borderLeft: '1px solid rgba(244,247,245,.12)', display: 'flex', flexDirection: 'column' }}>
        <div style=${{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 14px 10px' }}>
          <b style=${{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>回收站</b>
          <span style=${{ fontSize: '11px', color: 'var(--ink3)' }}>${(items || []).length} 项 · 不自动过期</span>
          <span style=${{ flex: 1 }}></span>
          <button onClick=${purgeAll} disabled=${busy === 'all' || (items || []).length === 0}
            style=${{ ...btn(false), opacity: (items || []).length ? 1 : .4 }}>清空回收站</button>
          <button onClick=${onClose}
            style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>关闭</button>
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
            >${t.label}</button>
          `)}
        </div>
        ${msg && html`<p style=${{ margin: '0 14px 8px', fontSize: '11px', color: 'var(--ink2)' }}>${msg}</p>`}
        ${error && html`<p style=${{ margin: '0 14px 8px', fontSize: '11px', color: 'var(--danger)' }}>${error}</p>`}
        <div style=${{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 14px 14px' }}>
          ${loading && html`<p style=${{ fontSize: '11px', color: 'var(--ink3)' }}>加载中…</p>`}
          ${!loading && list.length === 0 && html`<p style=${{ fontSize: '11px', color: 'var(--ink3)', padding: '10px 0' }}>${openType === 'all' ? '回收站是空的' : '这个类型下没有条目'}</p>`}
          ${list.map((it) => html`
            <div key=${it.type + '/' + it.id} style=${{ border: '1px solid rgba(244,247,245,.08)', borderRadius: '8px', padding: '10px', marginBottom: '8px', background: 'var(--s2)' }}>
              <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style=${{ fontSize: '10px', color: 'var(--onaccent)', background: 'var(--accent)', borderRadius: '3px', padding: '1px 6px', flex: '0 0 auto' }}>${RECYCLE_TYPE_TEXT[it.type] || it.type}</span>
                <span style=${{ fontSize: '11.5px', color: 'var(--ink)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${(it.entry && (it.entry.fileName || it.entry.prompt)) || it.id}</span>
              </div>
              <div style=${{ fontSize: '10px', color: 'var(--ink3)', marginTop: '4px', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>
                ${it.id} · ${String(it.trashedAt || '').slice(0, 19).replace('T', ' ')} · ${it.fileCount || 0} 个文件 · ${((it.sizeBytes || 0) / 1048576).toFixed(2)} MB
              </div>
              <div style=${{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <button onClick=${() => restore(it)} disabled=${busy === it.type + '/' + it.id} style=${btn(true)}>恢复</button>
                <button onClick=${() => purge(it)} disabled=${busy === it.type + '/' + it.id} style=${btn(false)}>彻底删除</button>
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
  const [libS, reloadLib] = useJson('/api/library');
  const [photoS, reloadPhotos] = useJson('/api/photos?final=1');
  const [recS, reloadRec] = useJson('/api/recycle');

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

  const refreshAll = () => { reloadLib(); reloadPhotos(); reloadRec(); };
  const TABS = [
    { key: 'finals', label: '成片', count: finals.length },
    { key: 'clips', label: '片段', count: clipCount },
    { key: 'photos', label: '图片', count: photos.length }
  ];

  return html`
    <div className="px-6 py-5" style=${{ paddingBottom: '84px' }}>
      <div className="flex items-center gap-3 mb-3.5">
        <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0">库</h1>
        <span className="text-[11px] text-ink3 font-num">成片 ${finals.length} · 片段 ${clipCount} · 图片 ${photos.length}</span>
        <span className="flex-1"></span>
        <button onClick=${() => setRecycleOpen(true)}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]"
        >回收站${recycleItems.length ? ' · ' + recycleItems.length : ''}</button>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[.08] mb-3">
        ${TABS.map((t) => html`
          <button key=${t.key} onClick=${() => setTab(t.key)}
            className=${'h-8 px-3 text-[12px] ' + (tab === t.key ? 'text-accent' : 'text-ink3 hover:text-ink2')}
            style=${{ borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent' }}
          >${t.label}<span className="ml-1.5 text-[10px] font-num" style=${{ opacity: .7 }}>${t.count}</span></button>
        `)}
      </div>

      ${tab === 'finals' && html`<${FinalsPanel} items=${finals} tasks=${tasks} loading=${libS.loading}
        error=${libS.error ? '读取失败：' + libS.error : ''} onChanged=${refreshAll} />`}
      ${tab === 'clips' && html`<${ClipsPanel} onChanged=${refreshAll} />`}
      ${tab === 'photos' && html`<${PhotosPanel} onChanged=${refreshAll} />`}

      <${RecycleDrawer} open=${recycleOpen} items=${recycleItems} loading=${recS.loading}
        error=${recS.error ? '读取回收站失败：' + recS.error : ''}
        onClose=${() => setRecycleOpen(false)} onChanged=${refreshAll} />
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
  ['title', '曲名', 'text'],
  ['cat', '分类', 'text'],
  ['mood', '情绪', 'text'],
  ['bpm', 'BPM', 'number'],
  ['inst', '乐器', 'text'],
  ['author', '作者', 'text'],
  ['source', '来源', 'text'],
  ['license', '授权', 'text'],
  ['url', '来源 URL', 'text']
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
      a.onerror = () => { setPlayErr('试听失败：' + (t.title || t.id) + '（文件可能不存在）'); setPlayingId(''); };
      a.src = bgmUrl(t);
      const p = a.play();
      if (p && p.catch) {
        p.catch((e) => {
          setPlayErr('试听失败：' + (e && e.message ? e.message : '浏览器拒绝播放'));
          setPlayingId('');
        });
      }
      setPlayingId(t.id);
    } catch (e) { setPlayErr('试听失败：' + e.message); }
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
    } catch (e) { setErr('设为默认失败：' + e.message); }
  }

  async function remove(id) {
    if (!window.confirm('删除这首配乐？')) return;
    setErr('');
    try {
      const r = await fetch('/api/bgm/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      reload();
    } catch (e) { setErr('删除失败：' + e.message); }
  }

  // 上传音频：FileReader 读成 dataURL（后端只收 base64，零新依赖），
  // 顺便用 <audio> 读时长（拿不到就 0，不阻塞上传；后端不跑 ffprobe 读 stdout，避开本机 EPERM）。
  async function uploadFile(file) {
    setErr('');
    if (!file) return;
    if (file.size > MAX_AUDIO_MB * 1024 * 1024) {
      setErr(`文件 ${(file.size / 1048576).toFixed(1)}MB，超过 ${MAX_AUDIO_MB}MB 上限`);
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ''));
        fr.onerror = () => rej(new Error('读取文件失败'));
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
      setErr('上传失败：' + e.message);
    } finally {
      setUploading(false);
    }
  }

  async function submitAdd() {
    setErr('');
    if (!(form.title || '').trim()) { setErr('曲名必填'); return; }
    try {
      const r = await fetch('/api/bgm', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setAdding(false); setForm({}); reload();
    } catch (e) { setErr('新增失败：' + e.message); }
  }

  return html`
    <div className="px-6 py-5">
      <${Head} title="配乐" sub=${tracks.length + ' 首'}>
        <label className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px] inline-flex items-center cursor-pointer">
          ${uploading ? '上传中…' : '＋ 上传音频'}
          <input type="file" accept=".mp3,.wav,.m4a,.ogg,audio/*" className="hidden"
            disabled=${uploading}
            onChange=${(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) uploadFile(f); }} />
        </label>
        <button onClick=${() => navigate('/bgm')}
          className="h-8 px-3 rounded-[6px] border border-accent/40 text-accent text-[12px] hover:bg-accent/[.08]"
          title="打开配乐编辑器：给已完成成片排时间轴"
        >配乐编辑器 →</button>
        <button onClick=${() => setAdding((v) => !v)}
          className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]"
        >${adding ? '收起' : '＋ 新增配乐'}</button>
      </${Head}>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${playErr && html`<p className="mb-2 text-[12px] text-danger">${playErr}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${adding && html`
        <div className="mb-4 rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3">
          <p className="text-[12px] text-ink mb-2">新增配乐（元信息）</p>
          <div className="grid grid-cols-3 gap-x-3 gap-y-2">
            ${MUSIC_FIELDS.map((f) => html`
              <label key=${f[0]} className="flex flex-col gap-1">
                <span className="text-[11px] text-ink3">${f[1]}</span>
                <input type=${f[2]} value=${form[f[0]] || ''}
                  onInput=${(e) => setForm((x) => ({ ...x, [f[0]]: e.target.value }))}
                  className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none" />
              </label>
            `)}
          </div>
          <p className="mt-2 text-[11px] leading-[1.7] text-ink3">
            可以直接「＋ 上传音频」（mp3/wav/m4a/ogg，单文件 ≤${MAX_AUDIO_MB}MB，会自动登记）；
            也可以手工放到 <code className="font-num">app/assets/bgm/</code> 后在这里补元信息。
          </p>
          <div className="mt-2 flex gap-2">
            <button onClick=${submitAdd} className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]">保存</button>
            <button onClick=${() => setAdding(false)}
              className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2">取消</button>
          </div>
        </div>
      `}

      ${tracks.length === 0 && !s.loading && html`<${Empty}>还没有配乐</${Empty}>`}

      <div className="rounded-[8px] border border-white/[.08] overflow-hidden bg-s1">
        ${tracks.map((t) => html`
          <div key=${t.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/[.05] last:border-0">
            <button onClick=${() => togglePlay(t)}
              title=${playingId === t.id ? '停止试听' : '试听'}
              className="w-[26px] h-[26px] rounded-full border border-white/[.10] grid place-items-center text-[10px] text-ink2 hover:bg-white/[.08] cursor-pointer"
            >${playingId === t.id ? '⏸' : '▶'}</button>
            <span className="flex-1 min-w-0 cursor-pointer" onClick=${() => togglePlay(t)}>
              <b className="block text-[12.5px] font-medium text-ink truncate">${t.title || t.id}</b>
              <span className="block text-[10px] text-ink3 font-num">
                ${[t.cat, t.mood, t.author, t.license].filter(Boolean).join(' · ')}
              </span>
            </span>
            ${defaultId === t.id
              ? html`<span className="text-[10px] px-1.5 py-[3px] rounded-[3px] bg-accent text-onaccent">默认</span>`
              : html`<button onClick=${() => setDefault(t.id)}
                  className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:bg-white/[.06]">设为默认</button>`}
            <button onClick=${() => remove(t.id)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-danger hover:bg-white/[.06]">删除</button>
          </div>
        `)}
      </div>
    </div>
  `;
}
