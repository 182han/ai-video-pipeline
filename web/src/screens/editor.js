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
import { PreviewEngine } from '../preview/engine.js';
import { AudioPanel } from '../components/audioPanel.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useMemo, useRef, useState } = React;

const LAST_KEY = 'dsh.editor.lastProject';
const SAVE_DEBOUNCE = 700;
const PPS_MIN = 8;
const PPS_MAX = 80;

const ADJUST_GROUPS = [
  {
    title: '色彩',
    items: [
      { key: 'temperature', label: '色温' },
      { key: 'tone', label: '色调' },
      { key: 'saturation', label: '饱和度' }
    ]
  },
  {
    title: '明度',
    items: [
      { key: 'brightness', label: '亮度' },
      { key: 'contrast', label: '对比度' },
      { key: 'highlight', label: '高光' },
      { key: 'shadow', label: '阴影' },
      { key: 'white', label: '白色' },
      { key: 'black', label: '黑色' },
      { key: 'lightSensation', label: '光感' }
    ]
  }
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
  const [films, setFilms] = useState(null);
  const [rebuilding, setRebuilding] = useState(null);
  const [toast, setToast] = useState('');
  const [lib, setLib] = useState(null);
  const [libErr, setLibErr] = useState('');
  const [libQuery, setLibQuery] = useState('');
  const [bgm, setBgm] = useState(null);
  const [pps, setPps] = useState(26);
  const [dragOver, setDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedAudio, setSelectedAudio] = useState(null);
  const [playhead, setPlayhead] = useState(0);
  const [exportJob, setExportJob] = useState(null);
  const [viewerUrl, setViewerUrl] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const [previewReady, setPreviewReady] = useState(false);
  const [theater, setTheater] = useState(false);

  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const segTimerRef = useRef(null);
  const moveIndexRef = useRef(null);
  const trimRef = useRef(null);
  const segmentsRef = useRef([]);
  const audioRef = useRef({ music: [], ambient: [], opts: {} });
  const rulerRef = useRef(null);
  const playheadElRef = useRef(null);
  const scrubRef = useRef(0);
  const canvasRef = useRef(null);
  const centerRef = useRef(null);
  const previewRef = useRef(null);
  const playheadRef = useRef(0);

  const projectRef = useRef(null);
  const revisionRef = useRef(0);
  const nameRef = useRef('');
  const timerRef = useRef(null);

  // 素材列表（搜索过滤）：必须在引用它的 effect 之前初始化，否则 deps 求值会撞 TDZ
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

  function adopt(p) {
    projectRef.current = p;
    revisionRef.current = Number(p.revision) || 1;
    nameRef.current = p.name || '';
    segmentsRef.current = Array.isArray(p.segments) ? p.segments : [];
    audioRef.current = p.audio || { music: [], ambient: [], opts: {} };
    setProject(p);
    setNameDraft(p.name || '');
    setSelectedId(null);
    setSelectedAudio(null);
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
      loadBgm();
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

  // 实时预览引擎：等工程加载出画布后创建一次；卸载时销毁
  useEffect(() => {
    if (!project || !canvasRef.current || previewRef.current) return;
    try {
      previewRef.current = new PreviewEngine(canvasRef.current, {
        onTime: (t) => {
          playheadRef.current = t;
          setPlayhead(t);
        },
        onEnd: () => setPlaying(false),
        onError: (m) => setPreviewErr(m)
      });
      setPreviewErr('');
      setPreviewReady(true);
    } catch (e) {
      setPreviewErr(e.message || 'WebGL 初始化失败');
      setPreviewReady(false);
    }
  }, [project]);

  useEffect(() => () => {
    if (previewRef.current) previewRef.current.destroy();
    previewRef.current = null;
    setPreviewReady(false);
  }, []);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  useEffect(() => {
    const e = previewRef.current;
    if (!e) return;
    if (!project) { e.setSegments([]); return; }
    const urls = {};
    for (const g of ((lib && lib.groups) || [])) {
      for (const it of (g.items || [])) urls[it.id] = it.url;
    }
    const segs = (project.segments || [])
      .filter(Boolean)
      .map((s) => ({
        url: urls[s.assetId] || '',
        inSec: s.inSec,
        outSec: s.outSec,
        adjust: s.adjust || null
      }))
      .filter((s) => s.url && Number(s.outSec) > Number(s.inSec));
    const F = project.transition && project.transition.enabled !== false
      ? (Number(project.transition.duration) > 0 ? Number(project.transition.duration) : 0.4)
      : 0;
    e.setSegments(segs, { transition: F });
  }, [project, lib]);

  // 预览声音：音乐/环境音两轨，与画面同一时间轴（音量为 0 时等同静音）
  useEffect(() => {
    const e = previewRef.current;
    if (!e) return;
    const byId = {};
    for (const t of ((bgm && bgm.tracks) || [])) byId[t.id] = t;
    const toPlan = (seg) => {
      if (!seg) return null;
      const t = byId[seg.trackId];
      if (!t) return null;
      const url = t.url || (t.file ? '/bgm/' + t.file : '');
      if (!url) return null;
      return {
        url,
        inSec: Number(seg.sourceIn) || 0,
        outSec: Number(seg.sourceOut) || 0,
        volume: seg.volume === undefined ? 1 : Number(seg.volume),
        fadeIn: Number(seg.fadeIn) || 0,
        fadeOut: Number(seg.fadeOut) || 0
      };
    };
    e.setAudio({
      music: toPlan(((project.audio && project.audio.music) || [])[0]),
      ambient: toPlan(((project.audio && project.audio.ambient) || [])[0])
    }, 0);
  }, [project && project.audio, bgm]);

  useEffect(() => {
    const e = previewRef.current;
    if (!e || playing) return;
    e.seek(playhead);
  }, [playhead, playing]);

  async function loadLibrary() {
    try {
      const j = await api('/api/library');
      setLib(j);
      setLibErr('');
    } catch (e) {
      setLibErr(e.message || '素材加载失败');
    }
  }

  async function loadBgm() {
    try {
      const j = await api('/api/bgm');
      setBgm(j);
    } catch (e) { /* 音频库失败不影响剪辑 */ }
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

  function scheduleSave() {
    if (segTimerRef.current) clearTimeout(segTimerRef.current);
    setSaveState('saving');
    segTimerRef.current = setTimeout(() => {
      const cur = projectRef.current;
      if (!cur) return;
      api('/api/projects/' + encodeURIComponent(cur.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: revisionRef.current,
          segments: segmentsRef.current,
          audio: audioRef.current,
          transition: projectRef.current ? projectRef.current.transition : null
        })
      }).then((j) => {
        revisionRef.current = j.project.revision;
        projectRef.current = j.project;
        audioRef.current = j.project.audio || audioRef.current;
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
    scheduleSave();
  }

  function commitAudio(next) {
    audioRef.current = next;
    const p = projectRef.current;
    if (p) {
      projectRef.current = { ...p, audio: next };
      setProject(projectRef.current);
    }
    scheduleSave();
  }

  function commitTransition(patch) {
    const p = projectRef.current;
    if (!p) return;
    const cur = p.transition || { enabled: true, duration: 0.4, type: 'fade' };
    const next = { ...cur, ...patch };
    projectRef.current = { ...p, transition: next };
    setProject(projectRef.current);
    scheduleSave();
  }

  function undo() {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push(segmentsRef.current.map((s) => ({ ...s })));
    segmentsRef.current = prev;
    const p = projectRef.current;
    if (p) { projectRef.current = { ...p, segments: prev }; setProject(projectRef.current); }
    setSelectedId(null);
    scheduleSave();
  }

  function redo() {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(segmentsRef.current.map((s) => ({ ...s })));
    segmentsRef.current = next;
    const p = projectRef.current;
    if (p) { projectRef.current = { ...p, segments: next }; setProject(projectRef.current); }
    setSelectedId(null);
    scheduleSave();
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
    if (selectedAudio) { setToast('音频轨暂不支持分割（请用左侧入点/出点）'); return; }
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
    if (selectedAudio) {
      const cur = audioRef.current || { music: [], ambient: [] };
      commitAudio({ ...cur, [selectedAudio]: [] });
      setSelectedAudio(null);
      return;
    }
    if (!selectedId) return;
    commitSegments(segmentsRef.current.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  }

  function adjustValue(seg, key) {
    const v = seg && seg.adjust ? Number(seg.adjust[key]) : 0;
    return Number.isFinite(v) ? v : 0;
  }

  function setAdjust(key, value) {
    if (!selectedId) return;
    const v = Math.max(-50, Math.min(50, Math.round(Number(value) || 0)));
    const list = segmentsRef.current.map((s) => (s.id === selectedId
      ? { ...s, adjust: { ...(s.adjust || {}), [key]: v } }
      : s));
    segmentsRef.current = list;
    const p = projectRef.current;
    if (p) { projectRef.current = { ...p, segments: list }; setProject(projectRef.current); }
    scheduleSave();
  }

  function resetAdjust() {
    if (!selectedId) return;
    commitSegments(segmentsRef.current.map((s) => (s.id === selectedId ? { ...s, adjust: {} } : s)));
  }

  // 播放头拖动：拖动过程只改 DOM，不触发 React 重渲染（避免卡顿），松手才落 state
  function beginScrub(e) {
    e.preventDefault();
    setPlaying(false);
    if (previewRef.current) previewRef.current.pause();
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
      const t = Math.round(scrubRef.current * 100) / 100;
      setPlayhead(t);
      setPlaying(false);
      if (previewRef.current) {
        previewRef.current.pause();
        previewRef.current.seek(t);
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function onTrackClick(e) {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setPlayhead(Math.max(0, Math.round(((e.clientX - rect.left) / pps) * 100) / 100));
    setSelectedId(null);
    setSelectedAudio(null);
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
      scheduleSave();
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

  function togglePlay() {
    const e = previewRef.current;
    if (!e || !previewReady || !e.segments || e.segments.length === 0) return;
    if (playing) {
      e.pause();
      setPlaying(false);
      return;
    }
    if (e.global >= e.duration - 0.05) {
      e.seek(0);
      setPlayhead(0);
    } else {
      e.seek(playheadRef.current);
    }
    e.play();
    setPlaying(true);
  }

  function toggleTheater() {
    setTheater((v) => !v);
  }

  function toggleFullscreen() {
    const el = centerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen();
    } catch (e) { setToast('当前浏览器不支持全屏'); }
  }

  function persistName(next) {    const cur = projectRef.current;
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
      try {
        const f = await api('/api/tasks/completed');
        setFilms(Array.isArray(f.tasks) ? f.tasks : []);
      } catch (e) {
        setFilms([]);
      }
    } catch (e) { setToast('读取工程列表失败：' + e.message); }
  }

  async function rebuildFromTask(taskId) {
    setRebuilding(taskId);
    try {
      const j = await api('/api/projects/from-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
      adopt(j.project);
      setOpenList(null);
      setFilms(null);
      setToast('已从成片重建工程：' + (j.project.name || ''));
    } catch (e) {
      setToast('重建失败：' + e.message);
    } finally {
      setRebuilding(null);
    }
  }

  async function pickProject(id) {
    try {
      const p = await loadProjectById(id);
      adopt(p);
      setOpenList(null);
    } catch (e) { setToast('打开失败：' + e.message); }
  }

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

  const segments = (Array.isArray(project.segments) ? project.segments : []).filter(Boolean);
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
  const selectedSeg = segments.find((s) => s.id === selectedId) || null;
  const transition = project.transition || { enabled: true, duration: 0.4, type: 'fade' };
  const musicSeg = (project.audio && project.audio.music && project.audio.music[0]) || null;
  const ambientSeg = (project.audio && project.audio.ambient && project.audio.ambient[0]) || null;
  const bgmTitle = (id) => {
    const list = (bgm && bgm.tracks) || [];
    const hit = list.find((t) => t.id === id);
    return hit ? hit.title : id;
  };

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

      <div className=${'ed-main' + (theater ? ' theater' : '')}>
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
                : html`<${AudioPanel} project=${project} bgm=${bgm} duration=${duration} onCommit=${commitAudio} />`}
            </div>
          </div>
        </section>

        <section className="ed-center" ref=${centerRef}>
          <div className="ed-stage">
            <div className="ed-frame" onDoubleClick=${toggleTheater} title="双击放大/还原">
              <canvas ref=${canvasRef} className="ed-canvas"></canvas>
              ${segments.length === 0 && html`
                <div className="ed-frame-empty">
                  <b>时间线为空</b>
                  <span>左侧选素材 → 加入时间线 → 右侧调节 → 导出</span>
                </div>
              `}
              ${previewErr && html`<div className="ed-preview-err">${previewErr}</div>`}
            </div>
          </div>
          <div className="ed-transport">
            <span className="ed-time">${fmtTime(playhead)} / ${fmtTime(duration)}</span>
            <button className="ed-play" onClick=${togglePlay} disabled=${segments.length === 0 || !previewReady} title=${playing ? '暂停' : '播放'}>${playing ? '⏸' : '▶'}</button>
            <span className="ed-spacer"></span>
            <button className="ed-btn" onClick=${toggleTheater} title="隐藏两侧面板，放大预览">${theater ? '还原' : '放大'}</button>
            <button className="ed-btn" onClick=${toggleFullscreen} title="全屏预览（Esc 退出）">全屏</button>
            <span className="ed-pill">1080p</span>
            <span className="ed-pill">16:9</span>
          </div>
        </section>

        <section className="ed-right">
          <div className="ed-tabs">
            ${['基础', 'HSL', '曲线', '色轮', '蒙版'].map((t, i) => html`
              <span
                key=${t}
                className=${'ed-tab' + (i === 0 ? ' on' : '')}
                title=${i === 0 ? '基础调节' : '后续版本接入'}
                onClick=${() => { if (i > 0) setToast('「' + t + '」面板将在后续版本接入'); }}
              >${t}</span>
            `)}
          </div>
          <div className="ed-inspector-body">
            <div className="ed-group ed-transition">
              <h4>转场</h4>
              <label className="ed-check">
                <input
                  type="checkbox"
                  checked=${transition.enabled !== false}
                  onChange=${(e) => commitTransition({ enabled: e.target.checked })}
                />
                <span>片段之间淡入淡出</span>
              </label>
              <div className="ed-slider-row">
                <span className="ed-slider-label">时长</span>
                <select
                  className="ed-select"
                  value=${String(transition.duration)}
                  disabled=${transition.enabled === false}
                  onChange=${(e) => commitTransition({ duration: Number(e.target.value) })}
                >
                  ${['0.2', '0.4', '0.6', '0.8', '1.0'].map((v) => html`<option key=${v} value=${v}>${v}s</option>`)}
                </select>
              </div>
              <div className="ed-slider-row">
                <span className="ed-slider-label">类型</span>
                <select
                  className="ed-select"
                  value=${transition.type}
                  disabled=${transition.enabled === false}
                  onChange=${(e) => commitTransition({ type: e.target.value })}
                >
                  <option value="fade">淡化</option>
                  <option value="dissolve">溶解</option>
                  <option value="wipeleft">左擦除</option>
                  <option value="wiperight">右擦除</option>
                  <option value="slideleft">左滑动</option>
                  <option value="slideright">右滑动</option>
                  <option value="circleopen">圆形展开</option>
                  <option value="pixelize">像素化</option>
                </select>
              </div>
              <p className="ed-hint">关闭后走直拼（不叠化，不缩短时长）；预览与导出同时生效。</p>
            </div>
            ${!selectedSeg && html`
              <div className="ed-empty">
                <p>先在时间线选中一个片段</p>
                <p className="ed-sub">选中谁，调谁；每段参数独立保存</p>
              </div>
            `}
            ${selectedSeg && html`
              <div className="ed-sel-meta">
                <span>${selectedSeg.assetId}</span>
                <button className="ed-btn" onClick=${resetAdjust}>重置本段</button>
              </div>
              ${ADJUST_GROUPS.map((g) => html`
                <div className="ed-group" key=${g.title}>
                  <h4>${g.title}</h4>
                  ${g.items.map((it) => html`
                    <div className="ed-slider-row" key=${it.key}>
                      <span className="ed-slider-label">${it.label}</span>
                      <input
                        className="ed-slider-input"
                        type="range"
                        min="-50"
                        max="50"
                        step="1"
                        value=${adjustValue(selectedSeg, it.key)}
                        onPointerDown=${historyPush}
                        onInput=${(e) => setAdjust(it.key, e.target.value)}
                      />
                      <span className="ed-slider-val">${adjustValue(selectedSeg, it.key)}</span>
                    </div>
                  `)}
                </div>
              `)}
              <p className="ed-hint">参数保存到工程草稿；导出时按段烘成 LUT（与预览同一套颜色数学）。</p>
            `}
          </div>
        </section>
      </div>

      <section className="ed-timeline">
        <div className="ed-tl-tools">
          <button className="ed-tool ed-act" onClick=${undo} disabled=${pastRef.current.length === 0} title="撤销">撤销</button>
          <button className="ed-tool ed-act" onClick=${redo} disabled=${futureRef.current.length === 0} title="重做">重做</button>
          <button className="ed-tool ed-act" onClick=${splitSelected} disabled=${!selectedId && segments.length === 0} title="在播放头分割">分割</button>
          <button className="ed-tool ed-act" onClick=${deleteSelected} disabled=${!selectedId && !selectedAudio} title="删除选中片段/音轨">删除</button>
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
                : layout.map(({ seg, i, left, width, dur, start }) => html`
                    <span
                      key=${seg.id || i}
                      className=${'ed-clip' + (selectedId === seg.id ? ' sel' : '')}
                      style=${{ left: left + 'px', width: Math.max(24, width - 2) + 'px' }}
                      title=${seg.assetId + ' · ' + dur.toFixed(2) + 's'}
                      draggable=${true}
                      onDragStart=${(e) => onClipDragStart(e, i)}
                      onClick=${(e) => {
                        e.stopPropagation();
                        setSelectedId(seg.id);
                        setSelectedAudio(null);
                        setPlaying(false);
                        setPlayhead(start);
                        if (previewRef.current) {
                          previewRef.current.pause();
                          previewRef.current.seek(start);
                        }
                      }}
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
              ${musicSeg && html`
                <span
                  className=${'ed-audio-clip music' + (selectedAudio === 'music' ? ' sel' : '')}
                  style=${{ width: Math.min(trackWidth, duration * pps) + 'px' }}
                  onClick=${(e) => {
                    e.stopPropagation();
                    setSelectedAudio('music');
                    setSelectedId(null);
                    setTab('audio');
                    setToast('已选中音乐轨：' + bgmTitle(musicSeg.trackId));
                  }}
                >
                  ♪ ${bgmTitle(musicSeg.trackId)}
                </span>
              `}
              ${ambientSeg && html`
                <span
                  className=${'ed-audio-clip ambient' + (selectedAudio === 'ambient' ? ' sel' : '')}
                  style=${{ width: Math.min(trackWidth, duration * pps) + 'px' }}
                  onClick=${(e) => {
                    e.stopPropagation();
                    setSelectedAudio('ambient');
                    setSelectedId(null);
                    setTab('audio');
                    setToast('已选中环境音轨：' + bgmTitle(ambientSeg.trackId));
                  }}
                >
                  ♫ ${bgmTitle(ambientSeg.trackId)}
                </span>
              `}
              ${!musicSeg && !ambientSeg && html`<span className="ed-track-empty">音乐 / 环境音（左侧音频面板）</span>`}
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
              <div className="ed-modal-sub">已完成成片 · 重建为工程</div>
              ${!films && html`<p className="ed-sub">读取成片…</p>`}
              ${films && films.length === 0 && html`<p className="ed-sub">还没有已完成成片</p>`}
              ${(films || []).slice(0, 20).map((f) => html`
                <button
                  key=${f.taskId}
                  className="ed-project-row"
                  disabled=${rebuilding === f.taskId}
                  onClick=${() => rebuildFromTask(f.taskId)}
                >
                  <span>${(f.prompt || f.taskId).slice(0, 40)}</span>
                  <span className="ed-sub">${f.totalClips || 0} 段 · ${fmtTime(f.totalDuration || 0)}${f.status === 'partial' ? ' · 部分' : ''}</span>
                </button>
              `)}
              ${(films || []).length > 20 && html`<p className="ed-sub">只显示最近 20 条</p>`}
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
