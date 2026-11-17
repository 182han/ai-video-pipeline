// ============================================================
// 模板库 + 提示词规则
// ------------------------------------------------------------
// 接口（已核实）：
//   GET  /api/templates        → { templates: {id: {name, emoji, keywords[], styleEnhancers[], negative}} }
//                                （2026-10-31 新增；此前只有 :id 详情）
//   POST /api/templates        → { id, name, keywords, styleEnhancers, negative }
//   PUT  /api/templates/:id
//   DELETE /api/templates/:id
//   GET/PUT /api/rules         → { rules } / { rules }
// ============================================================
import { navigate } from '../router.js';
import { t as tr, tp } from '../i18n/index.js';
import { promptBus } from '../store.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

function fetchJson(url, opt) {
  return fetch(url, { credentials: 'same-origin', ...(opt || {}) })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
}

function toList(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  return Object.keys(obj).map((k) => ({ id: k, ...(obj[k] || {}) }));
}

export function TemplatesView() {
  const [list, setList] = useState([]);
  const [rules, setRules] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(null); // {id,name,keywords,styleEnhancers,negative}
  const [newId, setNewId] = useState('');

  async function load() {
    setErr('');
    try {
      const [t, r] = await Promise.all([fetchJson('/api/templates'), fetchJson('/api/rules')]);
      setList(toList(t.templates));
      setRules(r.rules || '');
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  function apply(t) {
    const kw = Array.isArray(t.keywords) ? t.keywords.slice(0, 4).join('、') : (t.keywords || '');
    const en = Array.isArray(t.styleEnhancers) ? t.styleEnhancers.slice(0, 3).join('，') : '';
    const sep = tr('templates.sep');
    const text = [kw ? kw + tr('templates.applySuffix') : t.name, en].filter(Boolean).join(sep);
    promptBus.setPrompt(text + tr('templates.period'));
    navigate('/create');
  }

  async function saveRules() {
    setMsg(''); setErr('');
    try {
      await fetchJson('/api/rules', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules })
      });
      setMsg(tr('templates.rulesSaved'));
    } catch (e) { setErr(tr('templates.rulesSaveFailed') + e.message); }
  }

  async function saveTpl() {
    setMsg(''); setErr('');
    const f = editing;
    if (!f || !f.name.trim()) { setErr(tr('templates.nameRequired')); return; }
    try {
      if (f.__isNew) {
        const id = (newId || '').trim();
        if (!id) { setErr(tr('templates.idRequired')); return; }
        await fetchJson('/api/templates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            name: f.name,
            keywords: String(f.keywords || '').split(/[,，、\s]+/).filter(Boolean),
            styleEnhancers: String(f.styleEnhancers || '').split(/[,，、]+/).filter(Boolean),
            negative: f.negative || ''
          })
        });
        setNewId('');
      } else {
        await fetchJson('/api/templates/' + encodeURIComponent(f.id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: f.name,
            keywords: String(f.keywords || '').split(/[,，、\s]+/).filter(Boolean),
            styleEnhancers: String(f.styleEnhancers || '').split(/[,，、]+/).filter(Boolean),
            negative: f.negative || ''
          })
        });
      }
      setEditing(null);
      await load();
      setMsg(tr('templates.saved'));
    } catch (e) { setErr(tr('templates.saveFailed') + e.message); }
  }

  async function remove(t) {
    if (!window.confirm(tr('templates.deleteConfirm', { name: t.name }))) return;
    setErr(''); setMsg('');
    try {
      await fetchJson('/api/templates/' + encodeURIComponent(t.id), { method: 'DELETE' });
      await load();
    } catch (e) { setErr(tr('templates.deleteFailed') + e.message); }
  }

  const inputCls = 'h-8 w-full rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none';

  return html`
    <div className="px-6 py-5 max-w-[1040px]">
      <div className="flex items-center gap-3 mb-3.5">
        <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0">${tr('templates.title')}</h1>
        <span className="text-[11px] text-ink3 font-num">${tp('templates.count', list.length)}</span>
        <span className="flex-1"></span>
        <button onClick=${() => navigate('/create')}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]">${tr('templates.back')}</button>
        <button onClick=${() => setEditing({ __isNew: true, name: '', keywords: '', styleEnhancers: '', negative: '' })}
          className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]">${tr('templates.new')}</button>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${msg && html`<p className="mb-2 text-[12px] text-accent">${msg}</p>`}

      ${editing && html`
        <div className="mb-4 rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3">
          <p className="text-[12px] text-ink mb-2">${editing.__isNew ? tr('templates.newTitle') : tr('templates.editing', { name: editing.name })}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            ${editing.__isNew && html`
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-ink3">${tr('templates.id')}</span>
                <input value=${newId} onInput=${(e) => setNewId(e.target.value)} className=${inputCls} />
              </label>
            `}
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-ink3">${tr('templates.name')}</span>
              <input value=${editing.name} onInput=${(e) => setEditing({ ...editing, name: e.target.value })} className=${inputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-ink3">${tr('templates.keywords')}</span>
              <input value=${Array.isArray(editing.keywords) ? editing.keywords.join(tr('templates.sep')) : (editing.keywords || '')}
                onInput=${(e) => setEditing({ ...editing, keywords: e.target.value })} className=${inputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-ink3">${tr('templates.enhancers')}</span>
              <input value=${Array.isArray(editing.styleEnhancers) ? editing.styleEnhancers.join(tr('templates.sep')) : (editing.styleEnhancers || '')}
                onInput=${(e) => setEditing({ ...editing, styleEnhancers: e.target.value })} className=${inputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-ink3">${tr('templates.negative')}</span>
              <input value=${editing.negative || ''} onInput=${(e) => setEditing({ ...editing, negative: e.target.value })} className=${inputCls} />
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <button onClick=${saveTpl} className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]">${tr('templates.save')}</button>
            <button onClick=${() => setEditing(null)}
              className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2">${tr('templates.cancel')}</button>
          </div>
        </div>
      `}

      <div className="grid grid-cols-4 gap-3">
        ${list.map((t) => html`
          <div key=${t.id} className="rounded-[6px] border border-white/[.08] bg-s1 overflow-hidden">
            <div className="aspect-video grid place-items-center text-[22px]" style=${{ color: 'var(--ink2)' }}>
              ${t.emoji || '◇'}
            </div>
            <div className="px-2 py-1.5">
              <b className="block text-[12px] font-medium text-ink truncate">${t.name || t.id}</b>
              <span className="block text-[10px] text-ink3 font-num truncate">
                ${Array.isArray(t.keywords) ? t.keywords.slice(0, 4).join(tr('templates.sep')) : (t.keywords || '')}
              </span>
              <div className="mt-1 flex items-center gap-1.5">
                <button onClick=${() => apply(t)}
                  className="h-6 px-1.5 rounded-[4px] text-[10px] text-accent hover:bg-white/[.06]">${tr('templates.apply')}</button>
                <button onClick=${() => setEditing({ ...t })}
                  className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.06]">${tr('templates.edit')}</button>
                <span className="flex-1"></span>
                <button onClick=${() => remove(t)}
                  className="h-6 px-1.5 rounded-[4px] text-[10px] text-ink3 hover:text-danger hover:bg-white/[.06]">${tr('templates.delete')}</button>
              </div>
            </div>
          </div>
        `)}
      </div>

      <div className="mt-5 rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <b className="text-[12.5px] font-medium text-ink">${tr('templates.rulesTitle')}</b>
          <span className="text-[10px] text-ink3 font-num">${tr('templates.rulesStore')}</span>
          <span className="flex-1"></span>
          <button onClick=${saveRules}
            className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2 hover:bg-white/[.05]">${tr('templates.saveRules')}</button>
        </div>
        <textarea value=${rules} onInput=${(e) => setRules(e.target.value)} rows="10"
          className="w-full resize-y rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5
                     text-[12.5px] leading-[1.75] text-ink outline-none font-num"></textarea>
      </div>
    </div>
  `;
}
