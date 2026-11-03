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

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

const SLIDER_GROUPS = [
  {
    title: '色彩',
    items: [
      { key: 'temperature', label: '色温', psnr: 41.95 },
      { key: 'tone', label: '色调', psnr: 41.19 },
      { key: 'saturation', label: '饱和度', psnr: 40.50 }
    ]
  },
  {
    title: '明度',
    items: [
      { key: 'brightness', label: '亮度', psnr: 41.67 },
      { key: 'contrast', label: '对比度', psnr: 40.32, note: '三帧均值 39.46；t=4 运动帧 37.80' },
      { key: 'highlight', label: '高光', psnr: 40.88 },
      { key: 'shadow', label: '阴影', psnr: 42.27 },
      { key: 'white', label: '白色', psnr: 41.24 },
      { key: 'black', label: '黑色', psnr: 45.04 },
      { key: 'lightSensation', label: '光感', psnr: 40.49, note: '三帧均值 39.97；t=4 运动帧 39.36' }
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
  const title = item.psnr ? '对照 PSNR ' + item.psnr + ' dB（t=2.5 单帧）' + (item.note ? '；' + item.note : '') : '';
  return html`
    <div className="adj-row" title=${title}>
      <span className="adj-label" onDoubleClick=${onReset} title="双击归零">${item.label}</span>
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
      <button className="adj-reset" onClick=${onReset} title="归零" aria-label=${item.label + '归零'}>↺</button>
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
      setErr('加载成片列表失败：' + e.message);
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
      setErr('加载任务失败：' + e.message);
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
    setStatus({ text: '正在提交重新导出…', kind: 'busy' });
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
        setStatus({ text: '重新导出中：' + (t.currentStep || t.status || '…'), kind: 'busy' });
      }
      if (!t || !['completed', 'partial', 'failed'].includes(t.status)) {
        throw new Error('导出超时：15 分钟内未完成，请到任务详情查看');
      }
      setTask(t);
      if (t.status === 'failed') {
        const stepErr = t.steps && Object.values(t.steps).map((s) => s && s.error).filter(Boolean)[0];
        throw new Error(t.error || stepErr || '导出失败（后端未给出原因）');
      }
      setSaved(wanted);
      setParams(wanted);
      setBust(Date.now());
      setStatus({ text: '已重新导出' + (j.backup ? '；旧成片已备份' : ''), kind: 'ok' });
    } catch (e) {
      setStatus({ text: '导出失败', kind: 'err' });
      setErr(e.message || '导出失败');
    } finally {
      setBusy(false);
    }
  }

  const dirty = !sameParams(params, saved);
  const activeTask = task && task.taskId === selectedId ? task : null;

  const head = html`
    <div className="adj-head">
      <h1 className="adj-title">剪辑 · 调节</h1>
      <span className="adj-sub">${tasks.length} 条已完成成片</span>
      <span className="adj-spacer"></span>
      ${selectedId && html`
        <select className="adj-select" value=${selectedId}
          onChange=${(e) => { if (e.target.value) selectTask(e.target.value); }}>
          ${tasks.map((t) => html`
            <option key=${t.taskId} value=${t.taskId}>
              ${(t.prompt || '(无提示词)').slice(0, 36)}${t.adjust ? ' · 已调节' : ''}
            </option>
          `)}
        </select>
      `}
      ${selectedId && html`<button className="adj-btn" onClick=${backToList}>返回列表</button>`}
      <button className="adj-btn" onClick=${loadList} disabled=${busy}>刷新</button>
    </div>
  `;

  if (!selectedId) {
    return html`
      <div className="adj-page">
        ${head}
        ${err && html`<p className="adj-status err" style=${{ margin: '0 0 10px' }}>${err}</p>`}
        ${loading
          ? html`<p className="adj-empty">加载中…</p>`
          : tasks.length === 0
            ? html`<p className="adj-empty">还没有已完成成片。先在「创作」页生成一条，完成后回到这里调节。</p>`
            : html`
              <div className="adj-list">
                ${tasks.map((t) => html`
                  <button key=${t.taskId} className="adj-card" onClick=${() => selectTask(t.taskId)}>
                    <span className="adj-card-title">${(t.prompt || '(无提示词)').slice(0, 80)}</span>
                    <span className="adj-card-meta">
                      <span>${t.resolution || '-'}</span>
                      <span>${t.totalDuration ? t.totalDuration + 's' : '-'}</span>
                      <span>${t.totalClips || 0} 段</span>
                      <span>${t.hasBgm ? '有配乐' : '无配乐'}</span>
                      <span className=${t.adjust ? 'adj-tag' : ''}>${t.adjust ? '已调节' : '未调节'}</span>
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
              : html`<div className="adj-video-empty">${activeTask ? '没有可播放的成片文件' : '加载中…'}</div>`}
          </div>
          <div className="adj-preview-meta">
            <span>${activeTask ? (activeTask.resolution || '-') : '-'}</span>
            <span>·</span>
            <span>${activeTask && activeTask.totalDuration ? activeTask.totalDuration + 's' : '-'}</span>
            <span>·</span>
            <span>${selectedId || ''}</span>
            ${activeTask && activeTask.adjust ? html`<span className="adj-tag">已调节</span>` : null}
            <span className="adj-spacer"></span>
            ${status.text && html`<span className=${'adj-status ' + status.kind}>${status.text}</span>`}
          </div>
          <p className="adj-preview-note">
            预览为 CSS 滤镜近似，仅供示意；颜色、强弱以「应用并重新导出」后的成片为准。
          </p>
        </div>

        <div className="adj-panel">
          <div className="adj-panel-head">
            <span className="adj-panel-title">调节</span>
            <span className="adj-sub" style=${{ marginLeft: 'auto' }}>
              ${dirty ? '有未应用的修改' : '参数已保存'}
            </span>
          </div>
          <div className="adj-panel-body">
            ${SLIDER_GROUPS.map((g) => html`
              <div className="adj-group" key=${g.title}>
                <h4 className="adj-group-title">${g.title}</h4>
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
              10 项均已用剪映真实导出对照验证（t=2.5 单帧 PSNR ≥ 40 dB）；对比度/光感的三帧均值见
              docs/spec/re-jianying/jy-adjust.md §16（运动帧会低 1~2 dB）。
            </p>
          </div>
          <div className="adj-panel-foot">
            <button className="adj-btn" onClick=${resetAll} disabled=${busy}>全部归零</button>
            <span className="adj-spacer"></span>
            <button className="adj-btn primary" onClick=${apply} disabled=${busy || !dirty}>
              ${busy ? '导出中…' : '应用并重新导出'}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}
