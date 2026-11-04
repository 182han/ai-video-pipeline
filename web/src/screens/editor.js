// ============================================================
// 剪辑台 · 工作台骨架（/app/edit）
// ------------------------------------------------------------
// 2026-11-04 F02：点「剪辑」直接进全屏工作台（不再先看成片列表）。
// 布局：顶栏 / 左素材·音频 / 中预览 / 右调节 / 下时间线。
// 工程：读 ?project=<id> → 上次工程 → 自动新建；改名自动保存（revision 乐观锁）。
//
// 仍是零构建：React 18 UMD + htm，无 JSX、无 npm。样式见 styles/editor.css。
// 后续：F03 素材面板、F04 时间线、F05 每段调节、F08 导出。
// ============================================================
import { navigate } from '../router.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useMemo, useRef, useState } = React;

const LAST_KEY = 'dsh.editor.lastProject';
const SAVE_DEBOUNCE = 700;
const PPS_MIN = 8;
const PPS_MAX = 80;

const SLIDER_GROUPS = [
  { title: '色彩', items: ['色温', '色调', '饱和度'] },
  { title: '明度', items: ['亮度', '对比度', '高光', '阴影', '白色', '黑色', '光感'] }
];

async function api(url, opt) {
  const res = await fetch(url, { credentials: 'same-origin', ...(opt || {}) });
  let json = {};
  try { json = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok || json.success === false) {
    const err = new Error(json.error || ('HTTP ' + res.status));
    err.status = res.status;
    err.code = json.code;
    err.currentRevision = json.currentRevision;
    throw err;
  }
  return json;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function segDuration(seg) {
  const inSec = Number(seg && seg.inSec) || 0;
  const outSec = seg && seg.outSec !== null && seg.outSec !== undefined ? Number(seg.outSec) : inSec;
  return Math.max(0, outSec - inSec);
}

function thumbUrl(assetId) {
  return '/api/library/' + encodeURIComponent(assetId) + '/thumb';
}

function saveStateText(state) {
  if (state === 'saving') return '保存中…';
  if (state === 'saved') return '已保存';
  if (state === 'conflict') return '已被其他窗口修改';
  if (state === 'error') return '保存失败';
  return '';
}

export function EditorView() {
  const [project, setProject] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saveState, setSaveState] = useState('');
  const [tab, setTab] = useState('media');
  const [nameDraft, setNameDraft] = useState('');
  const [openList, setOpenList] = useState(null);
  const [toast, setToast] = useState('');
  const [lib, setLib] = useState(null);
  const [libErr, setLibErr] = useState('');
  const [libQuery, setLibQuery] = useState('');
  const [pps, setPps] = useState(26);
  const [dragOver, setDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [playhead, setPlayhead] = useState(0);
  const [exportJob, setExportJob] = useState(null);
  const [viewerUrl, setViewerUrl] = useState(null);

  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const segTimerRef = useRef(null);
  const moveIndexRef = useRef(null);
  const trimRef = useRef(null);
  const segmentsRef = useRef([]);
  const rulerRef = useRef(null);
  const playheadElRef = useRef(null);
  const scrubRef = useRef(0);

  const projectRef = useRef(null);
  const revisionRef = useRef(0);
  const nameRef = useRef('');
  const timerRef = useRef(null);

  function adopt(p) {
    projectRef.current = p;
    revisionRef.current = Number(p.revision) || 1;
    nameRef.current = p.name || '';
    segmentsRef.current = Array.isArray(p.segments) ? p.segments : [];
    setProject(p);
    setNameDraft(p.name || '');
    setSelectedId(null);
    setPlayhead(0);
    pastRef.current = [];
    futureRef.current = [];
    setSaveState('saved');
    try { localStorage.setItem(LAST_KEY, p.id); } catch (e) { /* ignore */ }
    try { history.replaceState({}, '', '/app/edit?project=' + encodeURIComponent(p.id)); } catch (e) { /* ignore */ }
  }

  async function createProject() {
    const j = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '未命名工程' })
    });
    return j.project;
  }

  async function loadProjectById(id) {
    const j = await api('/api/projects/' + encodeURIComponent(id));
    return j.project;
  }

  useEffect(() => {
    (async () => {
      let want = null;
      try { want = new URLSearchParams(location.search).get('project'); } catch (e) { /* ignore */ }
      if (!want) { try { want = localStorage.getItem(LAST_KEY); } catch (e) { /* ignore */ } }
      let p = null;
      if (want) {
        try { p = await loadProjectById(want); } catch (e) { p = null; }
      }
      if (!p) p = await createProject();
      adopt(p);
      loadLibrary();
    })().catch((e) => setLoadErr(e.message || '工程加载失败'));
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  // 成片预览：Esc 关闭，留在剪辑台（2026-11-04 用户反馈）
  useEffect(() => {
    if (!viewerUrl) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setViewerUrl(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewerUrl]);

  async function loadLibrary() {
    try {
      const j = await api('/api/library');
      setLib(j);
      setLibErr('');
    } catch (e) {
      setLibErr(e.message || '素材加载失败');
    }
  }

  function savePatch(patch) {
    const cur = projectRef.current;
    if (!cur) return Promise.resolve(null);
    setSaveState('saving');
    return api('/api/projects/' + encodeURIComponent(cur.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: revisionRef.current, ...patch })
    }).then((j) => {
      revisionRef.current = j.project.revision;
      projectRef.current = j.project;
      setProject(j.project);
      setSaveState('saved');
      return j.project;
    }).catch((e) => {
      setSaveState(e.code === 'REVISION_CONFLICT' ? 'conflict' : 'error');
      setToast(e.message || '保存失败');
      throw e;
    });
  }

  function round3(v) {
    return Math.round((Number(v) || 0) * 1000) / 1000;
  }

  function assetMaxDur(assetId) {
    const hit = libItems.find((x) => x.id === assetId);
    return hit ? (Number(hit.durationSec) || 0) : 0;
  }

  function historyPush() {
    pastRef.current.push(segmentsRef.current.map((s) => ({ ...s })));
    if (pastRef.current.length > 50) pastRef.current.shift();
    futureRef.current = [];
  }

  function scheduleSegSave() {
    if (segTimerRef.current) clearTimeout(segTimerRef.current);
    setSaveState('saving');
    segTimerRef.current = setTimeout(() => {
      const cur = projectRef.current;
      if (!cur) return;
      api('/api/projects/' + encodeURIComponent(cur.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: revisionRef.current, segments: segmentsRef.current })
      }).then((j) => {
        revisionRef.current = j.project.revision;
        projectRef.current = j.project;
        setProject(j.project);
        setSaveState('saved');
      }).catch((e) => {
        setSaveState(e.code === 'REVISION_CONFLICT' ? 'conflict' : 'error');
        setToast(e.message || '保存失败');
      });
    }, 400);
  }

  function commitSegments(next, opts = {}) {
    if (opts.history !== false) historyPush();
    segmentsRef.current = next;
    const p = projectRef.current;
    if (p) {
      projectRef.current = { ...p, segments: next };
      setProject(projectRef.current);
    }
    scheduleSegSave();
  }

  function undo() {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push(segmentsRef.current.map((s) => ({ ...s })));
    segmentsRef.current = prev;
    const p = projectRef.current;
    if (p) { projectRef.current = { ...p, segments: prev }; setProject(projectRef.current); }
    setSelectedId(null);
    scheduleSegSave();
  }

  function redo() {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(segmentsRef.current.map((s) => ({ ...s })));
    segmentsRef.current = next;
    const p = projectRef.current;
    if (p) { projectRef.current = { ...p, segments: next }; setProject(projectRef.current); }
    setSelectedId(null);
    scheduleSegSave();
  }

  function addClip(item) {
    if (!item || !item.id) return;
    const dur = Number(item.durationSec) || 0;
    const seg = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      assetId: item.id,
      inSec: 0,
      outSec: dur > 0 ? round3(dur) : null,
      adjust: {}
    };
    commitSegments([...segmentsRef.current, seg]);
    setSelectedId(seg.id);
    setToast('已加入时间线：' + (item.prompt || item.id).slice(0, 24));
  }

  function splitSelected() {
    const segs = segmentsRef.current;
    if (!segs.length) return;
    let idx = selectedId ? segs.findIndex((s) => s.id === selectedId) : -1;
    if (idx < 0) idx = 0;
    const seg = segs[idx];
    const dur = segDuration(seg);
    if (dur < 0.4) { setToast('片段太短，无法分割'); return; }
    let acc = 0;
    for (let i = 0; i < idx; i++) acc += segDuration(segs[i]);
    let local = playhead - acc;
    if (!(local > 0.15 && local < dur - 0.15)) local = dur / 2;
    const cut = round3((Number(seg.inSec) || 0) + local);
    const a = { ...seg, outSec: cut };
    const b = {
      ...seg,
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      inSec: cut
    };
    const next = [...segs.slice(0, idx), a, b, ...segs.slice(idx + 1)];
    commitSegments(next);
    setSelectedId(b.id);
  }

  function deleteSelected() {
    if (!selectedId) return;
    commitSegments(segmentsRef.current.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  }

  // 播放头拖动：拖动过程只改 DOM，不触发 React 重渲染（避免卡顿），松手才落 state
  function beginScrub(e) {
    e.preventDefault();
    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    const total = segmentsRef.current.reduce((s, x) => s + segDuration(x), 0);
    const apply = (clientX) => {
      const t = Math.max(0, Math.min(total, (clientX - rect.left) / pps));
      scrubRef.current = t;
      if (playheadElRef.current) playheadElRef.current.style.left = (t * pps) + 'px';
    };
    apply(e.clientX);
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setPlayhead(Math.round(scrubRef.current * 100) / 100);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function onTrackClick(e) {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setPlayhead(Math.max(0, Math.round(((e.clientX - rect.left) / pps) * 100) / 100));
    setSelectedId(null);
  }

  function beginTrim(e, index, side) {
    e.stopPropagation();
    e.preventDefault();
    const seg = segmentsRef.current[index];
    if (!seg) return;
    setSelectedId(seg.id);
    historyPush();
    trimRef.current = {
      index,
      side,
      startX: e.clientX,
      inSec: Number(seg.inSec) || 0,
      outSec: Number(seg.outSec) || 0,
      max: assetMaxDur(seg.assetId)
    };
    const move = (ev) => {
      const t = trimRef.current;
      if (!t) return;
      const delta = (ev.clientX - t.startX) / pps;
      const list = segmentsRef.current.map((s) => ({ ...s }));
      const target = list[t.index];
      if (!target) return;
      if (t.side === 'left') {
        const out = Number(target.outSec) || 0;
        target.inSec = round3(Math.max(0, Math.min(out - 0.2, t.inSec + delta)));
      } else {
        const inn = Number(target.inSec) || 0;
        const max = t.max > 0 ? t.max : (Number(target.outSec) || 0) + 1000;
        target.outSec = round3(Math.max(inn + 0.2, Math.min(max, t.outSec + delta)));
      }
      segmentsRef.current = list;
      const p = projectRef.current;
      if (p) { projectRef.current = { ...p, segments: list }; setProject(projectRef.current); }
    };
    const up = () => {
      trimRef.current = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      scheduleSegSave();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function onClipDragStart(e, index) {    moveIndexRef.current = index;
    try {
      e.dataTransfer.setData('text/plain', 'move:' + index);
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { /* ignore */ }
  }

  function onDropClip(e) {
    e.preventDefault();
    setDragOver(false);
    const data = e.dataTransfer.getData('text/plain') || '';
    const rect = e.currentTarget.getBoundingClientRect();
    const time = Math.max(0, (e.clientX - rect.left) / pps);

    if (data.indexOf('move:') === 0) {
      const from = Number(data.slice(5));
      const segs = segmentsRef.current;
      if (!(from >= 0 && from < segs.length)) return;
      let acc = 0;
      let insertAt = segs.length;
      for (let i = 0; i < segs.length; i++) {
        const d = segDuration(segs[i]);
        if (time < acc + d / 2) { insertAt = i; break; }
        acc += d;
      }
      const moved = segs[from];
      const rest = segs.filter((_, i) => i !== from);
      let idx = from < insertAt ? insertAt - 1 : insertAt;
      idx = Math.max(0, Math.min(rest.length, idx));
      rest.splice(idx, 0, moved);
      commitSegments(rest);
      setSelectedId(moved.id);
      return;
    }

    const item = libItems.find((x) => x.id === data);
    if (item) addClip(item);
  }

  async function onExport() {
    const cur = projectRef.current;
    if (!cur || !Array.isArray(cur.segments) || cur.segments.length === 0) {
      setToast('先加素材再导出');
      return;
    }
    if (exportJob && (exportJob.status === 'queued' || exportJob.status === 'running')) return;
    setExportJob({ status: 'queued', progress: 0 });
    try {
      const j = await api('/api/projects/' + encodeURIComponent(cur.id) + '/export', { method: 'POST' });
      setExportJob(j.export);
      pollExport(j.export.id);
    } catch (e) {
      setExportJob({ status: 'failed', error: e.message });
      setToast('导出失败：' + e.message);
    }
  }

  function pollExport(exportId) {
    const pid = projectRef.current && projectRef.current.id;
    const tick = async () => {
      if (!pid) return;
      try {
        const j = await api('/api/projects/' + encodeURIComponent(pid) + '/export/' + encodeURIComponent(exportId));
        setExportJob(j.export);
        if (j.export.status === 'done') {
          setToast('导出完成：' + (j.export.outputUrl || ''));
          try {
            const fresh = await loadProjectById(pid);
            projectRef.current = fresh;
            revisionRef.current = fresh.revision;
            segmentsRef.current = Array.isArray(fresh.segments) ? fresh.segments : [];
            setProject(fresh);
          } catch (e) { /* ignore */ }
          return;
        }
        if (j.export.status === 'failed' || j.export.status === 'cancelled') {
          setToast(j.export.error || '导出失败');
          return;
        }
        setTimeout(tick, 800);
      } catch (e) {
        setToast('查询导出状态失败：' + e.message);
        setExportJob({ status: 'failed', error: e.message });
      }
    };
    setTimeout(tick, 600);
  }

  function persistName(next) {
    const cur = projectRef.current;
    if (!cur) return;
    if (!next || next === cur.name) return;
    setSaveState('saving');
    api('/api/projects/' + encodeURIComponent(cur.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: revisionRef.current, name: next })
    }).then((j) => {
      revisionRef.current = j.project.revision;
      projectRef.current = j.project;
      setProject(j.project);
      nameRef.current = j.project.name;
      setSaveState('saved');
    }).catch((e) => {
      setSaveState(e.code === 'REVISION_CONFLICT' ? 'conflict' : 'error');
      setToast(e.message || '保存失败');
    });
  }

  function onNameInput(e) {
    const v = e.target.value;
    setNameDraft(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persistName(v.trim()), SAVE_DEBOUNCE);
  }

  function onNameBlur() {
    if (timerRef.current) clearTimeout(timerRef.current);
    persistName(nameDraft.trim());
  }

  async function onNew() {
    try {
      const p = await createProject();
      adopt(p);
      setOpenList(null);
    } catch (e) { setToast('新建失败：' + e.message); }
  }

  async function onOpen() {
    try {
      const j = await api('/api/projects');
      setOpenList(Array.isArray(j.projects) ? j.projects : []);
    } catch (e) { setToast('读取工程列表失败：' + e.message); }
  }

  async function pickProject(id) {
    try {
      const p = await loadProjectById(id);
      adopt(p);
      setOpenList(null);
    } catch (e) { setToast('打开失败：' + e.message); }
  }

  const libItems = useMemo(() => {
    const groups = (lib && lib.groups) || [];
    const all = [];
    for (const g of groups) for (const it of (g.items || [])) all.push({ ...it, groupLabel: g.label });
    const q = libQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((it) =>
      String(it.prompt || '').toLowerCase().includes(q) ||
      String(it.resolution || '').toLowerCase().includes(q) ||
      String(it.model || '').toLowerCase().includes(q));
  }, [lib, libQuery]);

  if (loadErr && !project) {
    return html`
      <div className="ed-root ed-fatal">
        <div>
          <h2>剪辑台加载失败</h2>
          <p>${loadErr}</p>
          <button className="ed-btn primary" onClick=${() => location.reload()}>重试</button>
        </div>
      </div>
    `;
  }

  if (!project) {
    return html`<div className="ed-root ed-fatal"><span>正在打开剪辑台…</span></div>`;
  }

  const segments = Array.isArray(project.segments) ? project.segments : [];
  const layout = [];
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const d = segDuration(seg);
    layout.push({ seg, i, left: acc * pps, width: Math.max(24, d * pps), dur: d, start: acc, end: acc + d });
    acc += d;
  }
  const duration = acc;
  const rulerStep = duration > 120 ? 10 : (duration > 60 ? 5 : 1);
  const rulerEnd = Math.max(20, Math.ceil(duration / rulerStep) * rulerStep + rulerStep * 4);
  const rulerTicks = [];
  for (let s = 0; s <= rulerEnd; s += rulerStep) rulerTicks.push(s);
  const trackWidth = Math.max(600, Math.ceil(rulerEnd * pps));
  const exporting = !!(exportJob && (exportJob.status === 'queued' || exportJob.status === 'running'));

  return html`
    <div className="ed-root">
      <header className="ed-top">
        <button className="ed-back" onClick=${() => navigate('/')} title="返回工作台">←</button>
        <span className="ed-brand">剪辑台</span>
        <input
          className="ed-name"
          value=${nameDraft}
          onInput=${onNameInput}
          onBlur=${onNameBlur}
          spellCheck=${false}
          aria-label="工程名"
        />
        <span className=${'ed-status ' + saveState}>${saveStateText(saveState)}</span>
        <span className="ed-spacer"></span>
        <button className="ed-btn" onClick=${onOpen}>打开</button>
        <button className="ed-btn" onClick=${onNew}>新建</button>
        <button className="ed-btn primary" onClick=${onExport} disabled=${exporting || segments.length === 0} title="导出为成片">
          ${exporting ? '导出中 ' + Math.round(exportJob.progress || 0) + '%' : '导出'}
        </button>
        ${exportJob && exportJob.status === 'done' && exportJob.outputUrl && html`
          <button className="ed-btn ed-link" onClick=${() => setViewerUrl(exportJob.outputUrl)}>看成片</button>
        `}
      </header>

      <div className="ed-main">
        <section className="ed-left">
          <div className="ed-rail">
            <button className=${'ed-rail-btn' + (tab === 'media' ? ' on' : '')} onClick=${() => setTab('media')}>
              <span className="ed-rail-ico">▤</span><span>素材</span>
            </button>
            <button className=${'ed-rail-btn' + (tab === 'audio' ? ' on' : '')} onClick=${() => setTab('audio')}>
              <span className="ed-rail-ico">♪</span><span>音频</span>
            </button>
          </div>
          <div className="ed-panel">
            <div className="ed-panel-head">
              <b>${tab === 'media' ? '素材' : '音频'}</b>
              <span className="ed-sub">${tab === 'media'
                ? libItems.length + ' / ' + ((lib && lib.totals && lib.totals.count) || 0) + ' 段'
                : '音乐 / 环境音'}</span>
            </div>
            <div className="ed-panel-body">
              ${tab === 'media'
                ? html`<div className="ed-media">
                    <input
                      className="ed-search"
                      placeholder="搜索提示词 / 模型 / 分辨率"
                      value=${libQuery}
                      onInput=${(e) => setLibQuery(e.target.value)}
                    />
                    ${libErr && html`<p className="ed-sub ed-err">${libErr}</p>`}
                    ${!lib && !libErr && html`<p className="ed-sub">素材加载中…</p>`}
                    <div className="ed-grid">
                      ${libItems.slice(0, 120).map((it) => html`
                        <button
                          key=${it.id}
                          className="ed-card"
                          draggable=${true}
                          onDragStart=${(e) => { try { e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'copy'; } catch (err) { /* ignore */ } }}
                          onClick=${() => addClip(it)}
                          title=${(it.prompt || it.id) + ' · 点击加入时间线'}
                        >
                          <span className="ed-card-thumb">
                            <img
                              className="ed-card-img"
                              src=${thumbUrl(it.id)}
                              alt=""
                              loading="lazy"
                              onError=${(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                            />
                            <span className="ed-card-dur">${fmtDur(it.durationSec)}</span>
                            <span className="ed-card-plus">＋</span>
                          </span>
                          <span className="ed-card-prompt">${it.prompt || it.id}</span>
                          <span className="ed-card-meta">${it.resolution || '-'} · ${it.model || '-'}</span>
                        </button>
                      `)}
                    </div>
                    ${libItems.length > 120 && html`<p className="ed-sub">只显示前 120 条，用搜索缩小范围</p>`}
                  </div>`
                : html`<div className="ed-empty">
                    <p>音频面板将在 F07 接入</p>
                    <p className="ed-sub">音乐 / 环境音两轨，沿用现有配乐计划</p>
                  </div>`}
            </div>
          </div>
        </section>

        <section className="ed-center">
          <div className="ed-stage">
            <div className="ed-frame">
              ${segments.length === 0
                ? html`<div className="ed-frame-empty">
                    <b>时间线为空</b>
                    <span>左侧选素材 → 加入时间线 → 右侧调节 → 导出</span>
                  </div>`
                : html`<div className="ed-frame-empty"><b>${segments.length} 段</b><span>实时预览将在 F06 接入</span></div>`}
            </div>
          </div>
          <div className="ed-transport">
            <span className="ed-time">00:00:00 / ${fmtTime(duration)}</span>
            <button className="ed-play" disabled=${true} title="F06 接入">▶</button>
            <span className="ed-spacer"></span>
            <span className="ed-pill">1080p</span>
            <span className="ed-pill">16:9</span>
          </div>
        </section>

        <section className="ed-right">
          <div className="ed-tabs">
            ${['基础', 'HSL', '曲线', '色轮', '蒙版'].map((t, i) => html`
              <span key=${t} className=${'ed-tab' + (i === 0 ? ' on' : '')}>${t}</span>
            `)}
          </div>
          <div className="ed-inspector-body">
            ${SLIDER_GROUPS.map((g) => html`
              <div className="ed-group" key=${g.title}>
                <h4>${g.title}</h4>
                ${g.items.map((label) => html`
                  <div className="ed-slider-row" key=${label}>
                    <span className="ed-slider-label">${label}</span>
                    <span className="ed-slider"></span>
                    <span className="ed-slider-val">0</span>
                  </div>
                `)}
              </div>
            `)}
            <p className="ed-hint">选中时间线上的片段后可调节；每段独立参数将在 F05 接入。</p>
          </div>
        </section>
      </div>

      <section className="ed-timeline">
        <div className="ed-tl-tools">
          <button className="ed-tool ed-act" onClick=${undo} disabled=${pastRef.current.length === 0} title="撤销">撤销</button>
          <button className="ed-tool ed-act" onClick=${redo} disabled=${futureRef.current.length === 0} title="重做">重做</button>
          <button className="ed-tool ed-act" onClick=${splitSelected} disabled=${!selectedId && segments.length === 0} title="在播放头分割">分割</button>
          <button className="ed-tool ed-act" onClick=${deleteSelected} disabled=${!selectedId} title="删除选中片段">删除</button>
          <span className="ed-spacer"></span>
          <button className="ed-tool ed-zoom" onClick=${() => setPps((v) => Math.max(PPS_MIN, v - 6))}>−</button>
          <span className="ed-tool">缩放</span>
          <button className="ed-tool ed-zoom" onClick=${() => setPps((v) => Math.min(PPS_MAX, v + 6))}>＋</button>
          <span className="ed-tl-count">${segments.length} 段 · ${fmtTime(duration)}</span>
        </div>
        <div className="ed-tl-body">
          <div className="ed-tl-labels">
            <div className="ed-tl-ruler-pad"></div>
            <div className="ed-tl-label">视频</div>
            <div className="ed-tl-label">音频</div>
          </div>
          <div className="ed-tl-scroll">
            <div className="ed-ruler" ref=${rulerRef} style=${{ width: trackWidth + 'px' }} onPointerDown=${beginScrub}>
              ${rulerTicks.map((s) => html`
                <span key=${s} className=${'ed-tick' + (s % (rulerStep * 5) === 0 ? ' major' : '')} style=${{ left: (s * pps) + 'px' }}>
                  ${s % (rulerStep * 5) === 0 ? fmtTime(s) : ''}
                </span>
              `)}
            </div>
            <div
              className=${'ed-track video' + (dragOver ? ' over' : '')}
              style=${{ width: trackWidth + 'px' }}
              onDragOver=${(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave=${() => setDragOver(false)}
              onDrop=${onDropClip}
              onClick=${onTrackClick}
            >
              ${layout.length === 0
                ? html`<span className="ed-track-empty">从左侧点选或拖入素材</span>`
                : layout.map(({ seg, i, left, width, dur }) => html`
                    <span
                      key=${seg.id || i}
                      className=${'ed-clip' + (selectedId === seg.id ? ' sel' : '')}
                      style=${{ left: left + 'px', width: Math.max(24, width - 2) + 'px' }}
                      title=${seg.assetId + ' · ' + dur.toFixed(2) + 's'}
                      draggable=${true}
                      onDragStart=${(e) => onClipDragStart(e, i)}
                      onClick=${(e) => { e.stopPropagation(); setSelectedId(seg.id); }}
                    >
                      <span
                        className="ed-clip-thumb"
                        style=${{ backgroundImage: 'url(' + thumbUrl(seg.assetId) + ')' }}
                      ></span>
                      <span className="ed-handle l" title="拖动裁剪入点" onPointerDown=${(e) => beginTrim(e, i, 'left')}></span>
                      <span className="ed-clip-name">${seg.assetId}</span>
                      <span className="ed-clip-dur">${fmtDur(dur)}</span>
                      <span className="ed-handle r" title="拖动裁剪出点" onPointerDown=${(e) => beginTrim(e, i, 'right')}></span>
                    </span>
                  `)}
            </div>
            <div className="ed-track audio" style=${{ width: trackWidth + 'px' }}>
              <span className="ed-track-empty">音频轨（F07）</span>
            </div>
            <div
              className="ed-playhead"
              ref=${playheadElRef}
              style=${{ left: (playhead * pps) + 'px' }}
              onPointerDown=${beginScrub}
              title="拖动定位"
            ></div>
          </div>
        </div>
      </section>

      ${openList && html`
        <div className="ed-modal" onClick=${(e) => { if (e.target === e.currentTarget) setOpenList(null); }}>
          <div className="ed-modal-card">
            <div className="ed-modal-head">
              <b>打开工程</b>
              <button className="ed-btn" onClick=${() => setOpenList(null)}>关闭</button>
            </div>
            <div className="ed-modal-body">
              ${openList.length === 0 && html`<p className="ed-sub">还没有工程</p>`}
              ${openList.map((p) => html`
                <button key=${p.id} className=${'ed-project-row' + (p.id === project.id ? ' on' : '')} onClick=${() => pickProject(p.id)}>
                  <span>${p.name}</span>
                  <span className="ed-sub">${p.segmentCount} 段 · ${fmtTime(0)}</span>
                </button>
              `)}
            </div>
          </div>
        </div>
      `}

      ${viewerUrl && html`
        <div className="ed-viewer" onClick=${(e) => { if (e.target === e.currentTarget) setViewerUrl(null); }}>
          <div className="ed-viewer-card">
            <div className="ed-viewer-head">
              <b>成片预览</b>
              <button className="ed-btn" onClick=${() => setViewerUrl(null)}>关闭（Esc）</button>
            </div>
            <video className="ed-viewer-video" src=${viewerUrl} controls autoplay playsInline></video>
            <div className="ed-viewer-foot">
              <span className="ed-sub">成片已保存在 output/，关闭后仍在工程里</span>
              <a className="ed-sub ed-link" href=${viewerUrl} target="_blank" rel="noreferrer">新标签打开</a>
            </div>
          </div>
        </div>
      `}

      ${toast && html`
        <div className="ed-toast" onClick=${() => setToast('')}>${toast}</div>
      `}
    </div>
  `;
}
