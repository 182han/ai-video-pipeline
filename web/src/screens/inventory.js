// ============================================================
// 库存：视频片段 / 照片 / 配乐
// ------------------------------------------------------------
// 视频片段：GET /api/library?favorite=&q=&resolution=&model=
//           PUT /api/library/:id {favorite} · DELETE /api/library/:id
//           POST /api/library/:id/regenerate {prompt}
// 配乐：    GET /api/bgm · PUT /api/bgm/prefs {defaultTrackId}
//           POST /api/bgm · DELETE /api/bgm/:id
// 照片：    依赖出图厂商（未接入）→ 只给说明，不装样子
// ============================================================
import { navigate } from '../router.js';
import { setSeedPhoto } from '../createDraft.js';

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
  const n = Number(cost.amount);
  return Number.isFinite(n) ? '¥' + n.toFixed(2) : '';
}

function qcText(qc) {
  if (!qc) return '未质检';
  if (qc.passed) return 'QC 通过';
  return 'QC ' + (qc.level || '未通过');
}

export function ClipsView() {
  const [fav, setFav] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState('');
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState(null);

  const qs = new URLSearchParams();
  if (fav) qs.set('favorite', '1');
  if (q.trim()) qs.set('q', q.trim());
  if (res) qs.set('resolution', res);

  const [s, reload] = useJson('/api/library' + (qs.toString() ? '?' + qs : ''));

  const groups = (s.data && s.data.groups) || [];
  const facets = (s.data && s.data.facets) || {};
  const totals = (s.data && s.data.totals) || {};

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
    if (!window.confirm('删除这条片段？会同时删除磁盘文件，不可恢复。')) return;
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      reload();
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
    <div className="px-6 py-5">
      <${Head} title="视频片段" sub=${(totals.count || 0) + ' 条'}>
        <button onClick=${() => setFav((v) => !v)}
          className=${'h-8 px-3 rounded-[6px] text-[12px] border ' +
            (fav ? 'border-accent/50 text-accent' : 'border-white/[.10] text-ink2 hover:bg-white/[.05]')}
        >只看收藏</button>
      </${Head}>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <select value=${res} onChange=${(e) => setRes(e.target.value)}
          className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
          <option value="">全部分辨率</option>
          ${(facets.resolutions || []).map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
        </select>
        <input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="搜索提示词…"
          className="h-8 w-[190px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
        <span className="flex-1"></span>
        <span className="text-[11px] text-ink3">${s.loading ? '加载中…' : (s.error ? '读取失败' : '')}</span>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${groups.length === 0 && !s.loading && html`<${Empty}>没有匹配的片段</${Empty}>`}

      ${groups.map((g) => html`
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
                  <p className="text-[10px] text-ink3 font-num">
                    ${qcText(it.qc)}${costText(it.cost) ? ' · ' + costText(it.cost) : ''}
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

export function PhotosView() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [detail, setDetail] = useState(null);
  const [editPrompt, setEditPrompt] = useState('');

  function openDetail(p) {
    setDetail(p);
    setEditPrompt(p.prompt || '');
  }

  const qs = new URLSearchParams();
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

  async function remove(id) {
    if (!window.confirm('删除这张图片？（同时删除 clips/ 里的文件，不可恢复）')) return;
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail(null);
      reload();
    } catch (e) { setErr('删除失败：' + e.message); }
  }

  // 手动修改/补录提示词：历史图（生成时没记录）也能补一条，之后带入创作会自动回填
  async function savePrompt(id) {
    setErr('');
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(id), {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: editPrompt })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setDetail(j.photo);
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
      navigate('/');
    } catch (e) { setErr('带入创作失败：' + e.message); }
  }

  const promptText = (p) => (p.prompt || (p.promptAvailable === false ? '（历史文件：提示词未记录）' : '（无提示词）'));

  return html`
    <div className="px-6 py-5">
      <${Head} title="照片" sub=${(totals.all || 0) + ' 张'}>
        <span className="text-[11px] text-ink3 font-num">
          待审 ${totals.pending || 0} · 通过 ${totals.approved || 0} · 打回 ${totals.rejected || 0}
        </span>
      </${Head}>

      <p className="mb-3 text-[11px] leading-[1.7] text-ink3">
        生成的图片会自动入库并保留提示词（不再只留一个 clips 文件）。点「通过」表示这张图可以作为下一步图生视频的输入。
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
        <span className="text-[11px] text-ink3">${s.loading ? '加载中…' : (s.error ? '读取失败' : '')}</span>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${s.error && html`<p className="mb-2 text-[12px] text-danger">${s.error}</p>`}

      ${photos.length === 0 && !s.loading && html`<${Empty}>
        ${status || q.trim() ? '没有匹配的照片' : '还没有照片。到「创作」第②步生成一张，就会自动入库。'}
      </${Empty}>`}

      <div className="grid grid-cols-4 gap-3">
        ${photos.map((p) => html`
          <div key=${p.id} className="rounded-[6px] border border-white/[.08] bg-s1 overflow-hidden">
            <img src=${p.url} alt="生成的图片"
              onClick=${() => openDetail(p)}
              className="w-full aspect-video bg-black object-cover cursor-pointer" />
            <div className="px-2 py-1.5">
              <p className="text-[11px] leading-[1.5] text-ink2 line-clamp-2 min-h-[32px]">${promptText(p)}</p>
              <p className="text-[10px] text-ink3 font-num">
                ${PHOTO_STATUS_TEXT[p.status] || p.status}
                ${p.width && p.height ? ' · ' + p.width + '×' + p.height : ''}
              </p>
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
                <button onClick=${() => remove(p.id)}
                  className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:text-danger hover:bg-white/[.06]">删除</button>
              </div>
            </div>
          </div>
        `)}
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
            <img src=${detail.url} alt="生成的图片" style=${{ width: '100%', maxHeight: '420px', objectFit: 'contain', background: '#000', borderRadius: '6px' }} />
            <div style=${{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '6px 10px', marginTop: '12px', fontSize: '11.5px', lineHeight: 1.7 }}>
              <span style=${{ color: 'var(--ink3)' }}>提示词</span>
              <div>
                <textarea value=${editPrompt} onInput=${(e) => setEditPrompt(e.target.value)}
                  rows="3" placeholder="这张图的提示词（历史图可以手动补录）"
                  style=${{ width: '100%', resize: 'vertical', background: 'var(--s2)', color: 'var(--ink)', border: '1px solid rgba(244,247,245,.12)', borderRadius: '6px', padding: '6px 8px', fontSize: '11.5px', lineHeight: 1.7, outline: 'none', fontFamily: 'inherit' }}></textarea>
                <div style=${{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
                  <button onClick=${() => savePrompt(detail.id)}
                    style=${{ height: '26px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>保存提示词</button>
                  <span style=${{ color: 'var(--ink3)', fontSize: '10.5px' }}>
                    出图时原提示词：${detail.generationPrompt || '未记录'}${detail.promptUpdatedAt ? ' · 已更新 ' + String(detail.promptUpdatedAt).slice(0, 19).replace('T', ' ') : ''}
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
              <button onClick=${() => useInCreation(detail)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>用它生成视频</button>
              ${detail.status !== 'approved' && html`
                <button onClick=${() => review(detail.id, 'approved')}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(214,179,106,.45)', background: 'transparent', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer' }}>通过</button>`}
              ${detail.status !== 'rejected' && html`
                <button onClick=${() => review(detail.id, 'rejected')}
                  style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>打回</button>`}
              <button onClick=${() => remove(detail.id)}
                style=${{ height: '28px', padding: '0 10px', borderRadius: '6px', border: '1px solid rgba(244,247,245,.12)', background: 'transparent', color: 'var(--ink2)', fontSize: '11px', cursor: 'pointer' }}>删除</button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
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
