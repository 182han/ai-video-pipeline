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

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

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
export function ClipsView() {
  const [fav, setFav] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState('');
  const [err, setErr] = useState('');

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
                  <div className="mt-1 flex items-center gap-2">
                    <button onClick=${() => toggleFav(it.id, it.favorite)}
                      className=${'h-6 px-1.5 rounded-[4px] text-[12px] hover:bg-white/[.06] ' +
                        (it.favorite ? 'text-accent' : 'text-ink3')}
                    >${it.favorite ? '★' : '☆'}</button>
                    <span className="text-[10px] text-ink3 font-num">${it.model || ''}</span>
                    <span className="flex-1"></span>
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
    </div>
  `;
}

// ---------------- 照片 ----------------
export function PhotosView() {
  return html`
    <div className="px-6 py-5">
      <${Head} title="照片" sub="0 张" />
      <div className="rounded-[8px] border border-warn/30 bg-warn/[.06] px-4 py-3">
        <p className="text-[12px] text-warn">照片库存依赖出图环节，目前出图厂商未接入。</p>
        <p className="mt-1.5 text-[11px] leading-[1.7] text-ink2">
          <code className="font-num">src/generators/imageGen.js</code> 只有
          <code className="font-num">registerImageProvider()</code>，还没有任何适配器；
          后端也没有照片库的存储接口。等厂商接入后，这里会显示静帧网格（画面 + 审核状态 + 花费）。
        </p>
      </div>
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

  const tracks = (s.data && s.data.tracks) || [];
  const prefs = s.data || {};
  const defaultId = prefs.defaultTrackId || '';

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
        <button onClick=${() => navigate('/bgm')}
          className="h-8 px-3 rounded-[6px] border border-accent/40 text-accent text-[12px] hover:bg-accent/[.08]"
          title="打开配乐编辑器：给已完成成片排时间轴"
        >配乐编辑器 →</button>
        <button onClick=${() => setAdding((v) => !v)}
          className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]"
        >${adding ? '收起' : '＋ 新增配乐'}</button>
      </${Head}>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
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
            注意：后端 <code className="font-num">POST /api/bgm</code> 只收元信息，
            <b className="text-warn">没有音频文件上传通道</b>——mp3 需手工放到
            <code className="font-num">app/assets/bgm/</code> 后在这里补登记。
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
            <span className="w-[26px] h-[26px] rounded-full border border-white/[.10] grid place-items-center text-[10px] text-ink2">▶</span>
            <span className="flex-1 min-w-0">
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
