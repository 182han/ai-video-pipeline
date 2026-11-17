// ============================================================
// 剪辑台 · 调节（/app/edit）
// ------------------------------------------------------------
// 入口：
//   /app/edit              已完成成片列表
//   /app/edit?task=<id>    直接打开某条成片的调节面板（刷新可直达）
//
// 后端契约（只调用，不改后端）：
//   GET  /api/tasks/completed     已完成成片（含 outputUrl / adjust）
//   GET  /api/tasks/:id           完整任务（含 adjust / outputPath / steps）
//   POST /api/tasks/:id/adjust    { adjust:{...} } → 异步重新导出
//
// 零构建：React 18 UMD + htm，无 JSX、无 npm。样式见 styles/adjust-editor.css。
// ============================================================
import { navigate } from '../router.js';
import { t as tr } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

const SLIDER_GROUPS = [
  {
    titleKey: 'editor.adjust.groups.color',
    items: [
      { key: 'temperature', labelKey: 'editor.adjust.sliders.temperature', psnr: 41.95 },
      { key: 'tone', labelKey: 'editor.adjust.sliders.tone', psnr: 41.19 },
      { key: 'saturation', labelKey: 'editor.adjust.sliders.saturation', psnr: 40.50 }
    ]
  },
  {
    titleKey: 'editor.adjust.groups.light',
    items: [
      { key: 'brightness', labelKey: 'editor.adjust.sliders.brightness', psnr: 41.67 },
      { key: 'contrast', labelKey: 'editor.adjust.sliders.contrast', psnr: 40.32, noteKey: 'editor.adjust.contrastNote' },
      { key: 'highlight', labelKey: 'editor.adjust.sliders.highlight', psnr: 40.88 },
      { key: 'shadow', labelKey: 'editor.adjust.sliders.shadow', psnr: 42.27 },
      { key: 'white', labelKey: 'editor.adjust.sliders.white', psnr: 41.24 },
      { key: 'black', labelKey: 'editor.adjust.sliders.black', psnr: 45.04 },
      { key: 'lightSensation', labelKey: 'editor.adjust.sliders.lightSensation', psnr: 40.49, noteKey: 'editor.adjust.lightNote' }
    ]
  }
];

const ALL_KEYS = SLIDER_GROUPS.flatMap((g) => g.items.map((i) => i.key));

function emptyParams() {
  const p = {};
  for (const k of ALL_KEYS) p[k] = 0;
  return p;
}

function clampVal(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-50, Math.min(50, Math.round(n)));
}

function paramsFromTask(task) {
  const p = emptyParams();
  const a = task && task.adjust;
  if (a && typeof a === 'object') {
    for (const k of ALL_KEYS) if (a[k] !== undefined) p[k] = clampVal(a[k]);
  }
  return p;
}

function toAdjustObject(p) {
  const out = {};
  for (const k of ALL_KEYS) {
    const v = clampVal(p[k]);
    if (v !== 0) out[k] = v;
  }
  return out;
}

function sameParams(a, b) {
  return ALL_KEYS.every((k) => clampVal(a[k]) === clampVal(b[k]));
}

function fmtVal(v) {
  const n = clampVal(v);
  return n > 0 ? '+' + n : String(n);
}

function toOutputUrl(p, bust) {
  if (!p) return null;
  const name = String(p).split(/[\\/]/).pop();
  if (!name) return null;
  return '/output/' + encodeURIComponent(name) + (bust ? '?v=' + bust : '');
}

// 粗略示意：不是导出算法，只用于让用户感知方向与强弱。
function previewFilter(p) {
  const f = [];
  const b = clampVal(p.brightness);
  const c = clampVal(p.contrast);
  const s = clampVal(p.saturation);
  if (b) f.push('brightness(' + (1 + b / 100).toFixed(3) + ')');
  if (c) f.push('contrast(' + (1 + c / 100).toFixed(3) + ')');
  if (s) f.push('saturate(' + Math.max(0, 1 + s / 100).toFixed(3) + ')');
  const t = clampVal(p.temperature);
  if (t > 0) f.push('sepia(' + (t / 150).toFixed(3) + ')');
  else if (t < 0) f.push('hue-rotate(' + (t * 0.4).toFixed(1) + 'deg)');
  const tone = clampVal(p.tone);
  if (tone) f.push('hue-rotate(' + (tone * 0.6).toFixed(1) + 'deg)');
  const hi = clampVal(p.highlight);
  if (hi) f.push('contrast(' + (1 + hi / 500).toFixed(3) + ')');
  const sh = clampVal(p.shadow);
  if (sh) f.push('brightness(' + (1 + sh / 400).toFixed(3) + ')');
  const wh = clampVal(p.white);
  if (wh) f.push('brightness(' + (1 + wh / 500).toFixed(3) + ')');
  const bl = clampVal(p.black);
  if (bl) f.push('brightness(' + (1 + bl / 600).toFixed(3) + ')');
  const li = clampVal(p.lightSensation);
  if (li) f.push('brightness(' + (1 + li / 250).toFixed(3) + ')');
  return f.length ? f.join(' ') : 'none';
}

function fetchJson(url, opt) {
  return fetch(url, { credentials: 'same-origin', ...(opt || {}) }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function SliderRow({ item, value, onChange, onReset }) {
  const pct = ((clampVal(value) + 50) / 100) * 100;
  const from = Math.min(50, pct);
  const to = Math.max(50, pct);
  const track = 'linear-gradient(to right, rgba(244,247,245,.14) 0%, rgba(244,247,245,.14) ' + from +
    '%, var(--accent) ' + from + '%, var(--accent) ' + to + '%, rgba(244,247,245,.14) ' + to +
    '%, rgba(244,247,245,.14) 100%)';
  const title = item.psnr
    ? tr('editor.adjust.psnrTitle', { psnr: item.psnr })
      + (item.noteKey ? tr('editor.adjust.psnrNote', { note: tr(item.noteKey) }) : '')
    : '';
  return html`
    <div className="adj-row" title=${title}>
      <span className="adj-label" onDoubleClick=${onReset} title=${tr('editor.adjust.dblReset')}>${tr(item.labelKey)}</span>
      <input
        className="adj-range"
        type="range"
        min="-50"
        max="50"
        step="1"
        value=${clampVal(value)}
        style=${{ '--track': track }}
        onInput=${(e) => onChange(Number(e.target.value))}
      />
      <span className=${'adj-val' + (clampVal(value) === 0 ? ' zero' : '')}>${fmtVal(value)}</span>
      <button className="adj-reset" onClick=${onReset} title=${tr('editor.adjust.reset')} aria-label=${tr('editor.adjust.resetAria', { label: tr(item.labelKey) })}>↺</button>
    </div>
  `;
}

export function AdjustEditorView() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [task, setTask] = useState(null);
  const [params, setParams] = useState(emptyParams);
  const [saved, setSaved] = useState(emptyParams);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [bust, setBust] = useState(() => Date.now());
  const selectRef = useRef(null);

  async function loadList() {
    setLoading(true);
    setErr('');
    try {
      const j = await fetchJson('/api/tasks/completed');
      setTasks(Array.isArray(j.tasks) ? j.tasks : []);
    } catch (e) {
      setErr(tr('editor.adjust.loadListFailed') + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function selectTask(id) {
    if (!id) return;
    setSelectedId(id);
    setErr('');
    setStatus({ text: '', kind: '' });
    try {
      const t = await fetchJson('/api/tasks/' + encodeURIComponent(id));
      const p = paramsFromTask(t);
      setTask(t);
      setParams(p);
      setSaved(p);
      setBust(Date.now());
      const want = '/app/edit?task=' + encodeURIComponent(id);
      if (window.location.pathname + window.location.search !== want) {
        try { history.pushState({}, '', want); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      setErr(tr('editor.adjust.loadTaskFailed') + e.message);
    }
  }

  async function backToList() {
    setSelectedId(null);
    setTask(null);
    setParams(emptyParams());
    setSaved(emptyParams());
    setStatus({ text: '', kind: '' });
    setErr('');
    if (window.location.search) {
      try { history.pushState({}, '', '/app/edit'); } catch (e) { /* ignore */ }
    }
    await loadList();
  }

  useEffect(() => {
    loadList().then(() => {
      const id = new URLSearchParams(window.location.search).get('task');
      if (id) selectTask(id);
    });
  }, []);

  // 浏览器前进/后退：/app/edit 与 /app/edit?task=... 之间切换
  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get('task');
      if (id) selectRef.current(id);
      else backToList();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  selectRef.current = selectTask;

  function setParam(key, v) {
    setParams((s) => ({ ...s, [key]: clampVal(v) }));
  }
  function resetParam(key) {
    setParams((s) => ({ ...s, [key]: 0 }));
  }
  function resetAll() {
    setParams(emptyParams());
  }

  async function apply() {
    if (!selectedId || !task) return;
    if (busy) return;
    setBusy(true);
    setErr('');
    setStatus({ text: tr('editor.adjust.submitExport'), kind: 'busy' });
    const wanted = paramsFromTask({ adjust: toAdjustObject(params) });
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(selectedId) + '/adjust', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjust: toAdjustObject(params) })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error(j.error || ('HTTP ' + r.status));

      let t = null;
      for (let i = 0; i < 600; i++) {
        await sleep(1500);
        t = await fetchJson('/api/tasks/' + encodeURIComponent(selectedId));
        if (['completed', 'partial', 'failed'].includes(t.status)) break;
        setStatus({ text: tr('editor.adjust.reexporting', { step: t.currentStep || t.status || '…' }), kind: 'busy' });
      }
      if (!t || !['completed', 'partial', 'failed'].includes(t.status)) {
        throw new Error(tr('editor.adjust.timeout'));
      }
      setTask(t);
      if (t.status === 'failed') {
        const stepErr = t.steps && Object.values(t.steps).map((s) => s && s.error).filter(Boolean)[0];
        throw new Error(t.error || stepErr || tr('editor.adjust.failedNoReason'));
      }
      setSaved(wanted);
      setParams(wanted);
      setBust(Date.now());
      setStatus({ text: tr('editor.adjust.reexported') + (j.backup ? tr('editor.adjust.backupSuffix') : ''), kind: 'ok' });
    } catch (e) {
      setStatus({ text: tr('editor.adjust.exportFailedStatus'), kind: 'err' });
      setErr(e.message || tr('editor.adjust.exportFailed'));
    } finally {
      setBusy(false);
    }
  }

  const dirty = !sameParams(params, saved);
  const activeTask = task && task.taskId === selectedId ? task : null;

  const head = html`
    <div className="adj-head">
      <h1 className="adj-title">${tr('editor.adjust.pageTitle')}</h1>
      <span className="adj-sub">${tr('editor.adjust.completed', { n: tasks.length })}</span>
      <span className="adj-spacer"></span>
      ${selectedId && html`
        <select className="adj-select" value=${selectedId}
          onChange=${(e) => { if (e.target.value) selectTask(e.target.value); }}>
          ${tasks.map((t) => html`
            <option key=${t.taskId} value=${t.taskId}>
              ${(t.prompt || tr('editor.adjust.noPrompt')).slice(0, 36)}${t.adjust ? tr('editor.adjust.adjustedSuffix') : ''}
            </option>
          `)}
        </select>
      `}
      ${selectedId && html`<button className="adj-btn" onClick=${backToList}>${tr('editor.adjust.backToList')}</button>`}
      <button className="adj-btn" onClick=${loadList} disabled=${busy}>${tr('editor.adjust.refresh')}</button>
    </div>
  `;

  if (!selectedId) {
    return html`
      <div className="adj-page">
        ${head}
        ${err && html`<p className="adj-status err" style=${{ margin: '0 0 10px' }}>${err}</p>`}
        ${loading
          ? html`<p className="adj-empty">${tr('editor.adjust.loading')}</p>`
          : tasks.length === 0
            ? html`<p className="adj-empty">${tr('editor.adjust.empty')}</p>`
            : html`
              <div className="adj-list">
                ${tasks.map((t) => html`
                  <button key=${t.taskId} className="adj-card" onClick=${() => selectTask(t.taskId)}>
                    <span className="adj-card-title">${(t.prompt || tr('editor.adjust.noPrompt')).slice(0, 80)}</span>
                    <span className="adj-card-meta">
                      <span>${t.resolution || '-'}</span>
                      <span>${t.totalDuration ? t.totalDuration + 's' : '-'}</span>
                      <span>${tr('editor.adjust.clips', { n: t.totalClips || 0 })}</span>
                      <span>${t.hasBgm ? tr('editor.adjust.hasBgm') : tr('editor.adjust.noBgm')}</span>
                      <span className=${t.adjust ? 'adj-tag' : ''}>${t.adjust ? tr('editor.adjust.adjusted') : tr('editor.adjust.unadjusted')}</span>
                    </span>
                  </button>
                `)}
              </div>
            `}
      </div>
    `;
  }

  return html`
    <div className="adj-page">
      ${head}
      ${err && html`<p className="adj-status err" style=${{ margin: '0 0 10px' }}>${err}</p>`}
      <div className="adj-layout">
        <div className="adj-preview">
          <div className="adj-video-wrap">
            ${activeTask && activeTask.outputPath
              ? html`<video
                  key=${bust}
                  src=${toOutputUrl(activeTask.outputPath, bust)}
                  controls
                  preload="metadata"
                  playsInline
                ></video>`
              : html`<div className="adj-video-empty">${activeTask ? tr('editor.adjust.noPlayable') : tr('editor.adjust.loading')}</div>`}
          </div>
          <div className="adj-preview-meta">
            <span>${activeTask ? (activeTask.resolution || '-') : '-'}</span>
            <span>·</span>
            <span>${activeTask && activeTask.totalDuration ? activeTask.totalDuration + 's' : '-'}</span>
            <span>·</span>
            <span>${selectedId || ''}</span>
            ${activeTask && activeTask.adjust ? html`<span className="adj-tag">${tr('editor.adjust.adjusted')}</span>` : null}
            <span className="adj-spacer"></span>
            ${status.text && html`<span className=${'adj-status ' + status.kind}>${status.text}</span>`}
          </div>
          <p className="adj-preview-note">
            ${tr('editor.adjust.previewNote')}
          </p>
        </div>

        <div className="adj-panel">
          <div className="adj-panel-head">
            <span className="adj-panel-title">${tr('editor.adjust.panelTitle')}</span>
            <span className="adj-sub" style=${{ marginLeft: 'auto' }}>
              ${dirty ? tr('editor.adjust.dirty') : tr('editor.adjust.saved')}
            </span>
          </div>
          <div className="adj-panel-body">
            ${SLIDER_GROUPS.map((g) => html`
              <div className="adj-group" key=${g.titleKey}>
                <h4 className="adj-group-title">${tr(g.titleKey)}</h4>
                ${g.items.map((item) => html`
                  <${SliderRow}
                    key=${item.key}
                    item=${item}
                    value=${params[item.key]}
                    onChange=${(v) => setParam(item.key, v)}
                    onReset=${() => resetParam(item.key)}
                  />
                `)}
              </div>
            `)}
            <p className="adj-foot-note" style=${{ marginTop: '10px' }}>
              ${tr('editor.adjust.footNote')}
            </p>
          </div>
          <div className="adj-panel-foot">
            <button className="adj-btn" onClick=${resetAll} disabled=${busy}>${tr('editor.adjust.resetAll')}</button>
            <span className="adj-spacer"></span>
            <button className="adj-btn primary" onClick=${apply} disabled=${busy || !dirty}>
              ${busy ? tr('editor.adjust.exporting') : tr('editor.adjust.apply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}
