// ============================================================
// 剪辑台 · 工作台骨架（/app/edit）
// ------------------------------------------------------------
// 2026-11-04 F02：点「剪辑」直接进全屏工作台（不再先看成片列表）。
// 布局：顶栏 / 左素材·音频 / 中预览 / 右调节 / 下时间线。
// 工程：读 ?project=<id> → 上次工程 → 自动新建；改名自动保存（revision 乐观锁）。
//
// 2026-11-15 P3：素材栏三来源（片段 / 成片 / 图片）。
//   · 成片来自 /api/library 的 kind=final 条目，点击默认**整段载入**时间线，可拖手柄裁入/出点；
//   · 图片首版后置（产品已定）：只展示，不入时间线；
//   · 导出成功由后端 editorExporter 归入「库 · 成片」（origin=editor）。
//
// 仍是零构建：React 18 UMD + htm，无 JSX、无 npm。样式见 styles/editor.css。
// 后续：F03 素材面板、F04 时间线、F05 每段调节、F08 导出。
// ============================================================
import { navigate } from '../router.js';
import { t as tr, getLocale } from '../i18n/index.js';
import { PreviewEngine } from '../preview/engine.js';
import { AudioPanel } from '../components/audioPanel.js';
import { HslPanel, CurvePanel, WheelPanel } from '../components/advancedAdjust.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useMemo, useRef, useState } = React;

const LAST_KEY = 'dsh.editor.lastProject';
const SAVE_DEBOUNCE = 700;
// 2026-11-22：预览布局自检浮层。加 ?diag=1 打开，左下角显示各盒子的真实坐标。
// 目的：不需要开 DevTools、不需要粘贴代码，用户截一张图就能定位布局问题。
const DIAG = (() => {
  try { return new URLSearchParams(window.location.search).get('diag') === '1'; } catch (e) { return false; }
})();
const PPS_MIN = 8;
const PPS_MAX = 80;

const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

// E11：素材卡上显示的提示词。英文界面只用后端解析的 promptEn；没有英文就显式占位，不回退中文。
function mediaPrompt(item) {
  const it = item && typeof item === 'object' ? item : {};
  const source = String(it.prompt || it.imagePrompt || '');
  if (getLocale() !== 'en') return source;
  if (it.promptEn) return String(it.promptEn);
  if (source && !CJK_RE.test(source)) return source;
  return source ? tr('common.promptEnMissing') : '';
}

const ADJUST_GROUPS = [
  {
    titleKey: 'studio.adjust.groups.color',
    items: [
      { key: 'temperature', labelKey: 'studio.adjust.labels.temperature' },
      { key: 'tone', labelKey: 'studio.adjust.labels.tone' },
      { key: 'saturation', labelKey: 'studio.adjust.labels.saturation' }
    ]
  },
  {
    titleKey: 'studio.adjust.groups.light',
    items: [
      { key: 'brightness', labelKey: 'studio.adjust.labels.brightness' },
      { key: 'contrast', labelKey: 'studio.adjust.labels.contrast' },
      { key: 'highlight', labelKey: 'studio.adjust.labels.highlight' },
      { key: 'shadow', labelKey: 'studio.adjust.labels.shadow' },
      { key: 'white', labelKey: 'studio.adjust.labels.white' },
      { key: 'black', labelKey: 'studio.adjust.labels.black' },
      { key: 'lightSensation', labelKey: 'studio.adjust.labels.lightSensation' }
    ]
  }
];

const ADJUST_TABS = [
  { key: 'basic', labelKey: 'studio.adjust.tabs.basic', titleKey: 'studio.adjust.tabs.basicTitle' },
  { key: 'hsl', labelKey: 'studio.adjust.tabs.hsl', titleKey: 'studio.adjust.tabs.hslTitle' },
  { key: 'curve', labelKey: 'studio.adjust.tabs.curve', titleKey: 'studio.adjust.tabs.curveTitle' },
  { key: 'wheel', labelKey: 'studio.adjust.tabs.wheel', titleKey: 'studio.adjust.tabs.wheelTitle' }
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
  if (state === 'saving') return tr('studio.save.saving');
  if (state === 'saved') return tr('studio.save.saved');
  if (state === 'conflict') return tr('studio.save.conflict');
  if (state === 'error') return tr('studio.save.error');
  return '';
}

export function EditorView() {
  const [project, setProject] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saveState, setSaveState] = useState('');
  const [tab, setTab] = useState('media');
  const [adjustTab, setAdjustTab] = useState('basic');
  const [nameDraft, setNameDraft] = useState('');
  const [openList, setOpenList] = useState(null);
  const [films, setFilms] = useState(null);
  const [rebuilding, setRebuilding] = useState(null);
  const [toast, setToast] = useState('');
  const [lib, setLib] = useState(null);
  const [libErr, setLibErr] = useState('');
  const [libQuery, setLibQuery] = useState('');
  // 素材栏来源（P3）：片段 / 成片 / 图片。图片首版后置（产品已定），只展示、不入时间线。
  const [mediaSource, setMediaSource] = useState('clip');
  const [photos, setPhotos] = useState(null);
  const [photoErr, setPhotoErr] = useState('');
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
  const [diagText, setDiagText] = useState('');
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

  // 素材索引：/api/library 同时返回片段与成片（P1 起），素材栏按来源分开取。
  // 必须在引用它的 effect 之前初始化，否则 deps 求值会撞 TDZ。
  const libAll = useMemo(() => {
    const groups = (lib && lib.groups) || [];
    const all = [];
    for (const g of groups) for (const it of (g.items || [])) all.push({ ...it, groupLabel: g.label });
    return all;
  }, [lib]);

  // 跨来源索引：时间线里的段落可能来自「成片」来源，切到「片段」来源后
  // 裁剪上限 / 预览分辨率 / 拖拽落点仍要能找到它（否则裁剪会失去上限）。
  const assetById = useMemo(() => {
    const map = new Map();
    for (const it of libAll) map.set(it.id, it);
    return map;
  }, [libAll]);

  function matchQuery(it) {
    const q = libQuery.trim().toLowerCase();
    if (!q) return true;
    return String(it.prompt || '').toLowerCase().includes(q) ||
      String(it.promptEn || '').toLowerCase().includes(q) ||
      String(it.resolution || '').toLowerCase().includes(q) ||
      String(it.model || '').toLowerCase().includes(q) ||
      String(it.origin || '').toLowerCase().includes(q) ||
      String(it.id || '').toLowerCase().includes(q);
  }

  const clipItems = useMemo(() => libAll.filter((it) => it.kind !== 'final' && matchQuery(it)), [libAll, libQuery]);
  const finalItems = useMemo(() => libAll.filter((it) => it.kind === 'final' && matchQuery(it)), [libAll, libQuery]);
  const photoItems = useMemo(() => {
    const list = Array.isArray(photos) ? photos : [];
    const q = libQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => String(p.prompt || p.imagePrompt || '').toLowerCase().includes(q) ||
      String(p.promptEn || '').toLowerCase().includes(q) ||
      String(p.id || '').toLowerCase().includes(q));
  }, [photos, libQuery]);

  // 当前来源的列表（搜索同时作用于三个来源）
  const libItems = mediaSource === 'final' ? finalItems : (mediaSource === 'clip' ? clipItems : []);
  const MEDIA_SOURCES = [
    { key: 'clip', labelKey: 'studio.sources.clip', count: clipItems.length },
    { key: 'final', labelKey: 'studio.sources.final', count: finalItems.length },
    { key: 'photo', labelKey: 'studio.sources.photo', count: photoItems.length }
  ];
  const ORIGIN_TEXT = {
    task: 'studio.sources.task', library: 'studio.sources.library',
    editor: 'studio.sources.editor', orphan: 'studio.sources.orphan'
  };
  const PHOTO_STATUS_TEXT = {
    pending: 'studio.photoStatus.pending', approved: 'studio.photoStatus.approved', rejected: 'studio.photoStatus.rejected'
  };

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
      body: JSON.stringify({ name: tr('studio.defaultProjectName') })
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
      loadPhotos();
    })().catch((e) => setLoadErr(e.message || tr('studio.errors.loadProject')));
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
      setPreviewErr(e.message || tr('studio.errors.webgl'));
      setPreviewReady(false);
    }
  }, [project]);

  useEffect(() => () => {
    if (previewRef.current) previewRef.current.destroy();
    previewRef.current = null;
    setPreviewReady(false);
  }, []);

  // 布局自检（仅 ?diag=1）：每 500ms 采一次盒子坐标。只读 DOM，不改任何状态。
  useEffect(() => {
    if (!DIAG) return undefined;
    const box = (el) => {
      if (!el) return '-';
      const b = el.getBoundingClientRect();
      return Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height);
    };
    const disp = (el) => (el ? getComputedStyle(el).display : '-');
    const tick = () => {
      const st = document.querySelector('.ed-stage');
      const fr = document.querySelector('.ed-frame');
      const c = canvasRef.current;
      setDiagText([
        'vw=' + window.innerWidth + ' vh=' + window.innerHeight + ' dpr=' + (window.devicePixelRatio || 1),
        'scrollW=' + document.documentElement.scrollWidth + ' bodyScrollW=' + document.body.scrollWidth,
        'root=' + box(document.querySelector('.ed-root')),
        'main=' + box(document.querySelector('.ed-main')) + ' disp=' + disp(document.querySelector('.ed-main')),
        'stage=' + box(st) + ' disp=' + disp(st),
        'frame=' + box(fr) + ' disp=' + disp(fr),
        'canvas=' + box(c) + ' bitmap=' + (c ? (c.width + 'x' + c.height) : '-')
      ].join('\n'));
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
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
      setLibErr(e.message || tr('studio.errors.library'));
    }
  }

  async function loadBgm() {
    try {
      const j = await api('/api/bgm');
      setBgm(j);
    } catch (e) { /* 音频库失败不影响剪辑 */ }
  }

  // 图片库（P3 素材栏第三来源）。首版只展示，不加入时间线（产品已定可后置）。
  async function loadPhotos() {
    try {
      const j = await api('/api/photos');
      setPhotos(Array.isArray(j.photos) ? j.photos : []);
      setPhotoErr('');
    } catch (e) {
      setPhotoErr(e.message || tr('studio.errors.photos'));
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
      setToast(e.message || tr('studio.errors.save'));
      throw e;
    });
  }

  function round3(v) {
    return Math.round((Number(v) || 0) * 1000) / 1000;
  }

  function assetMaxDur(assetId) {
    const hit = assetById.get(assetId);
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
        setToast(e.message || tr('studio.errors.save'));
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
    if (item.kind === 'photo') {
      setToast(tr('studio.toasts.photoDeferred'));
      return;
    }
    // 成片默认整段载入：outSec = 成片全长；入/出点随后可在时间线拖动裁剪。
    const whole = item.kind === 'final';
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
    setToast((whole ? tr('studio.toasts.loadedWhole') : tr('studio.toasts.addedTimeline')) + (mediaPrompt(item) || item.id).slice(0, 24));
  }

  function splitSelected() {
    if (selectedAudio) { setToast(tr('studio.toasts.audioSplit')); return; }
    const segs = segmentsRef.current;
    if (!segs.length) return;
    let idx = selectedId ? segs.findIndex((s) => s.id === selectedId) : -1;
    if (idx < 0) idx = 0;
    const seg = segs[idx];
    const dur = segDuration(seg);
    if (dur < 0.4) { setToast(tr('studio.toasts.tooShort')); return; }
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

  // F12：高级参数（hsl / curve / wheel）整块写入；null = 删除该项
  function setAdvanced(patch) {
    if (!selectedId || !patch || typeof patch !== 'object') return;
    const keys = ['hsl', 'curve', 'wheel'];
    const list = segmentsRef.current.map((s) => {
      if (s.id !== selectedId) return s;
      const adjust = { ...(s.adjust || {}) };
      for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
        if (patch[k] === null || patch[k] === undefined) delete adjust[k];
        else adjust[k] = patch[k];
      }
      return { ...s, adjust };
    });
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

    const item = assetById.get(data);
    if (item) addClip(item);
  }

  async function onExport() {
    const cur = projectRef.current;
    if (!cur || !Array.isArray(cur.segments) || cur.segments.length === 0) {
      setToast(tr('studio.toasts.needAsset'));
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
      setToast(tr('studio.errors.export') + ': ' + e.message);
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
          setToast(tr('studio.toasts.exportDone'));
          try { loadLibrary(); } catch (e) { /* ignore */ }
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
          setToast(j.export.error || tr('studio.errors.export'));
          return;
        }
        setTimeout(tick, 800);
      } catch (e) {
        setToast(tr('studio.errors.exportStatus') + e.message);
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
    } catch (e) { setToast(tr('studio.errors.fullscreen')); }
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
      setToast(e.message || tr('studio.errors.save'));
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
    } catch (e) { setToast(tr('studio.errors.create') + e.message); }
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
    } catch (e) { setToast(tr('studio.errors.list') + e.message); }
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
      setToast(tr('studio.toasts.rebuildDone') + (j.project.name || ''));
    } catch (e) {
      setToast(tr('studio.errors.rebuild') + e.message);
    } finally {
      setRebuilding(null);
    }
  }

  async function pickProject(id) {
    try {
      const p = await loadProjectById(id);
      adopt(p);
      setOpenList(null);
    } catch (e) { setToast(tr('studio.errors.open') + e.message); }
  }

  if (loadErr && !project) {
    return html`
      <div className="ed-root ed-fatal">
        <div>
          <h2>${tr('studio.fatal.title')}</h2>
          <p>${loadErr}</p>
          <button className="ed-btn primary" onClick=${() => location.reload()}>${tr('studio.fatal.retry')}</button>
        </div>
      </div>
    `;
  }

  if (!project) {
    return html`<div className="ed-root ed-fatal"><span>${tr('studio.fatal.opening')}</span></div>`;
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
  const sourceItems = segments
    .map((s) => assetById.get(s.assetId))
    .filter(Boolean);
  let previewRes = '—';
  let previewRatio = '—';
  if (sourceItems.length) {
    const maxH = Math.max(...sourceItems.map((it) => Number(it.height) || 0));
    previewRes = maxH >= 2100 ? '4K' : maxH >= 1000 ? '1080p' : maxH >= 700 ? '720p' : maxH >= 450 ? '480p' : (maxH ? maxH + 'p' : '—');
    const first = sourceItems[0];
    const ratio = Number(first.width) && Number(first.height) ? Number(first.width) / Number(first.height) : 0;
    previewRatio = ratio > 1.7 ? '16:9' : ratio > 1.2 ? '4:3' : ratio > 0.9 ? '1:1' : ratio > 0 ? '9:16' : '—';
  }
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
        <button className="ed-back" onClick=${() => navigate('/')} title=${tr('studio.header.backTitle')}>←</button>
        <span className="ed-brand">${tr('studio.header.brand')}</span>
        <input
          className="ed-name"
          value=${nameDraft}
          onInput=${onNameInput}
          onBlur=${onNameBlur}
          spellCheck=${false}
          aria-label=${tr('studio.header.nameAria')}
        />
        <span className=${'ed-status ' + saveState}>${saveStateText(saveState)}</span>
        <span className="ed-spacer"></span>
        <button className="ed-btn" onClick=${onOpen}>${tr('studio.header.open')}</button>
        <button className="ed-btn" onClick=${onNew}>${tr('studio.header.create')}</button>
        <button className="ed-btn primary" onClick=${onExport} disabled=${exporting || segments.length === 0} title=${tr('studio.header.exportTitle')}>
          ${exporting ? tr('studio.header.exporting', { n: Math.round(exportJob.progress || 0) }) : tr('studio.header.export')}
        </button>
        ${exportJob && exportJob.status === 'done' && exportJob.outputUrl && html`
          <button className="ed-btn ed-link" onClick=${() => setViewerUrl(exportJob.outputUrl)}>${tr('studio.header.viewFinal')}</button>
        `}
      </header>

      <div className=${'ed-main' + (theater ? ' theater' : '')}>
        <section className="ed-left">
          <div className="ed-rail">
            <button className=${'ed-rail-btn' + (tab === 'media' ? ' on' : '')} onClick=${() => setTab('media')}>
              <span className="ed-rail-ico">▤</span><span>${tr('studio.rail.media')}</span>
            </button>
            <button className=${'ed-rail-btn' + (tab === 'audio' ? ' on' : '')} onClick=${() => setTab('audio')}>
              <span className="ed-rail-ico">♪</span><span>${tr('studio.rail.audio')}</span>
            </button>
          </div>
          <div className="ed-panel">
            <div className="ed-panel-head">
              <b>${tab === 'media' ? tr('studio.panel.media') : tr('studio.panel.audio')}</b>
              <span className="ed-sub">${tab === 'media'
                ? (mediaSource === 'photo'
                  ? tr('studio.panel.photoCount', { n: photoItems.length })
                  : tr('studio.panel.clipRatio', {
                    shown: libItems.length,
                    total: mediaSource === 'final' ? finalItems.length : clipItems.length
                  }))
                : tr('studio.panel.musicAmbient')}</span>
            </div>
            <div className="ed-panel-body">
              ${tab === 'media'
                ? html`<div className="ed-media">
                    <div className="ed-sources" role="tablist" aria-label=${tr('studio.panel.sourcesAria')}>
                      ${MEDIA_SOURCES.map((s) => html`
                        <button
                          key=${s.key}
                          data-media-source=${s.key}
                          className=${'ed-source' + (mediaSource === s.key ? ' on' : '')}
                          onClick=${() => setMediaSource(s.key)}
                        >${tr(s.labelKey)}<span className="ed-source-count">${s.count}</span></button>
                      `)}
                    </div>
                    <input
                      className="ed-search"
                      placeholder=${tr('studio.panel.searchPlaceholder')}
                      value=${libQuery}
                      onInput=${(e) => setLibQuery(e.target.value)}
                    />
                    ${mediaSource !== 'photo' && libErr && html`<p className="ed-sub ed-err">${libErr}</p>`}
                    ${mediaSource === 'photo' && photoErr && html`<p className="ed-sub ed-err">${photoErr}</p>`}
                    ${mediaSource !== 'photo' && !lib && !libErr && html`<p className="ed-sub">${tr('studio.panel.mediaLoading')}</p>`}
                    ${mediaSource === 'photo' && !photos && !photoErr && html`<p className="ed-sub">${tr('studio.panel.photosLoading')}</p>`}

                    ${mediaSource === 'photo' && html`
                      <p className="ed-note">${tr('studio.panel.photoDeferredNote')}</p>
                      <div className="ed-grid">
                        ${photoItems.slice(0, 120).map((p) => html`
                          <div
                            key=${p.id}
                            data-photo-id=${p.id}
                            className="ed-card ed-card-photo"
                            title=${(mediaPrompt(p) || p.id) + tr('studio.panel.photoTitleSuffix')}
                          >
                            <span className="ed-card-thumb">
                              <img
                                className="ed-card-img"
                                src=${p.url || ''}
                                alt=""
                                loading="lazy"
                                onError=${(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                              />
                              <span className="ed-card-dur">${PHOTO_STATUS_TEXT[p.status] ? tr(PHOTO_STATUS_TEXT[p.status]) : tr('studio.photoStatus.pending')}</span>
                              <span className="ed-card-badge ghost">${tr('studio.panel.photoBadge')}</span>
                            </span>
                            <span className="ed-card-prompt">${mediaPrompt(p) || p.id}</span>
                            <span className="ed-card-meta">${tr('studio.panel.photoMeta', { model: p.model || '-' })}</span>
                          </div>
                        `)}
                      </div>
                      ${photoItems.length === 0 && !photoErr && html`<p className="ed-sub">${tr('studio.panel.photoEmpty')}</p>`}
                    `}

                    ${mediaSource !== 'photo' && html`
                      ${mediaSource === 'final' && html`<p className="ed-note">${tr('studio.panel.finalNote')}</p>`}
                      <div className="ed-grid">
                        ${libItems.slice(0, 120).map((it) => html`
                          <button
                            key=${it.id}
                            data-asset-id=${it.id}
                            data-kind=${it.kind === 'final' ? 'final' : 'clip'}
                            className=${'ed-card' + (it.kind === 'final' ? ' ed-card-final' : '')}
                            draggable=${true}
                            onDragStart=${(e) => { try { e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'copy'; } catch (err) { /* ignore */ } }}
                            onClick=${() => addClip(it)}
                            title=${(mediaPrompt(it) || it.id) + (it.kind === 'final' ? tr('studio.panel.cardTitleFinal') : tr('studio.panel.cardTitleClip'))}
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
                              ${it.kind === 'final' && html`<span className="ed-card-badge">${tr('studio.panel.finalBadge')}</span>`}
                              <span className="ed-card-plus">＋</span>
                            </span>
                            <span className="ed-card-prompt">${mediaPrompt(it) || it.id}</span>
                            <span className="ed-card-meta">${it.kind === 'final'
                              ? tr(ORIGIN_TEXT[it.origin] || 'studio.sources.orphan') + ' · ' + (it.resolution || '-')
                              : (it.resolution || '-') + ' · ' + (it.model || '-')}</span>
                          </button>
                        `)}
                      </div>
                      ${libItems.length === 0 && !libErr && html`<p className="ed-sub">${mediaSource === 'final'
                        ? tr('studio.panel.finalEmpty')
                        : tr('studio.panel.clipEmpty')}</p>`}
                      ${libItems.length > 120 && html`<p className="ed-sub">${tr('studio.panel.only120')}</p>`}
                    `}
                  </div>`
                : html`<${AudioPanel} project=${project} bgm=${bgm} duration=${duration} onCommit=${commitAudio} onReloadBgm=${loadBgm} />`}
            </div>
          </div>
        </section>

        <section className="ed-center" ref=${centerRef}>
          <div className="ed-stage">
            <div className="ed-frame" onDoubleClick=${toggleTheater} title=${tr('studio.preview.frameTitle')}>
              <canvas ref=${canvasRef} className="ed-canvas"></canvas>
              ${segments.length === 0 && html`
                <div className="ed-frame-empty">
                  <b>${tr('studio.preview.emptyTitle')}</b>
                  <span>${tr('studio.preview.emptyHint')}</span>
                </div>
              `}
              ${previewErr && html`<div className="ed-preview-err">${previewErr}</div>`}
            </div>
          </div>
          <div className="ed-transport">
            <span className="ed-time">${fmtTime(playhead)} / ${fmtTime(duration)}</span>
            <button className="ed-play" onClick=${togglePlay} disabled=${segments.length === 0 || !previewReady} title=${playing ? tr('studio.preview.pause') : tr('studio.preview.play')}>${playing ? '⏸' : '▶'}</button>
            <span className="ed-spacer"></span>
            <button className="ed-btn" onClick=${toggleTheater} title=${tr('studio.preview.theaterTitle')}>${theater ? tr('studio.preview.restore') : tr('studio.preview.enlarge')}</button>
            <button className="ed-btn" onClick=${toggleFullscreen} title=${tr('studio.preview.fullscreenTitle')}>${tr('studio.preview.fullscreen')}</button>
            <span className="ed-pill">${previewRes}</span>
            <span className="ed-pill">${previewRatio}</span>
          </div>
        </section>

        <section className="ed-right">
          <div className="ed-tabs">
            ${ADJUST_TABS.map((t) => html`
              <span
                key=${t.key}
                className=${'ed-tab' + (adjustTab === t.key ? ' on' : '')}
                title=${tr(t.titleKey)}
                onClick=${() => setAdjustTab(t.key)}
              >${tr(t.labelKey)}</span>
            `)}
          </div>
          <div className="ed-inspector-body">
            ${adjustTab === 'basic' && html`
            <div className="ed-group ed-transition">
              <h4>${tr('studio.inspector.transition')}</h4>
              <label className="ed-check">
                <input
                  type="checkbox"
                  checked=${transition.enabled !== false}
                  onChange=${(e) => commitTransition({ enabled: e.target.checked })}
                />
                <span>${tr('studio.inspector.transitionToggle')}</span>
              </label>
              <div className="ed-slider-row">
                <span className="ed-slider-label">${tr('studio.inspector.duration')}</span>
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
                <span className="ed-slider-label">${tr('studio.inspector.type')}</span>
                <select
                  className="ed-select"
                  value=${transition.type}
                  disabled=${transition.enabled === false}
                  onChange=${(e) => commitTransition({ type: e.target.value })}
                >
                  <option value="fade">${tr('studio.inspector.types.fade')}</option>
                  <option value="dissolve">${tr('studio.inspector.types.dissolve')}</option>
                  <option value="wipeleft">${tr('studio.inspector.types.wipeleft')}</option>
                  <option value="wiperight">${tr('studio.inspector.types.wiperight')}</option>
                  <option value="slideleft">${tr('studio.inspector.types.slideleft')}</option>
                  <option value="slideright">${tr('studio.inspector.types.slideright')}</option>
                  <option value="circleopen">${tr('studio.inspector.types.circleopen')}</option>
                  <option value="pixelize">${tr('studio.inspector.types.pixelize')}</option>
                </select>
              </div>
              <p className="ed-hint">${tr('studio.inspector.transitionHint')}</p>
            </div>
            `}
            ${!selectedSeg && html`
              <div className="ed-empty">
                <p>${tr('studio.inspector.selectFirst')}</p>
                <p className="ed-sub">${adjustTab === 'basic' ? tr('studio.inspector.basicEmptyHint') : tr('studio.inspector.tabEmptyHint', { tab: tr(ADJUST_TABS.find((t) => t.key === adjustTab).labelKey) })}</p>
              </div>
            `}
            ${selectedSeg && html`
              <div className="ed-sel-meta">
                <span>${selectedSeg.assetId}</span>
                <button className="ed-btn" onClick=${resetAdjust}>${tr('studio.inspector.resetSegment')}</button>
              </div>
              ${adjustTab === 'basic' && html`
                ${ADJUST_GROUPS.map((g) => html`
                  <div className="ed-group" key=${g.titleKey}>
                    <h4>${tr(g.titleKey)}</h4>
                    ${g.items.map((it) => html`
                      <div className="ed-slider-row" key=${it.key}>
                        <span className="ed-slider-label">${tr(it.labelKey)}</span>
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
                <p className="ed-hint">${tr('studio.inspector.basicHint')}</p>
              `}
              ${adjustTab === 'hsl' && html`<${HslPanel} adjust=${selectedSeg.adjust || {}} onChange=${setAdvanced} onHistory=${historyPush} />`}
              ${adjustTab === 'curve' && html`<${CurvePanel} adjust=${selectedSeg.adjust || {}} onChange=${setAdvanced} onHistory=${historyPush} />`}
              ${adjustTab === 'wheel' && html`<${WheelPanel} adjust=${selectedSeg.adjust || {}} onChange=${setAdvanced} onHistory=${historyPush} />`}
            `}
          </div>
        </section>
      </div>

      <section className="ed-timeline">
        <div className="ed-tl-tools">
          <button className="ed-tool ed-act" onClick=${undo} disabled=${pastRef.current.length === 0} title=${tr('studio.timeline.undo')}>${tr('studio.timeline.undo')}</button>
          <button className="ed-tool ed-act" onClick=${redo} disabled=${futureRef.current.length === 0} title=${tr('studio.timeline.redo')}>${tr('studio.timeline.redo')}</button>
          <button className="ed-tool ed-act" onClick=${splitSelected} disabled=${!selectedId && segments.length === 0} title=${tr('studio.timeline.splitTitle')}>${tr('studio.timeline.split')}</button>
          <button className="ed-tool ed-act" onClick=${deleteSelected} disabled=${!selectedId && !selectedAudio} title=${tr('studio.timeline.deleteTitle')}>${tr('studio.timeline.delete')}</button>
          <span className="ed-spacer"></span>
          <button className="ed-tool ed-zoom" onClick=${() => setPps((v) => Math.max(PPS_MIN, v - 6))}>−</button>
          <span className="ed-tool">${tr('studio.timeline.zoom')}</span>
          <button className="ed-tool ed-zoom" onClick=${() => setPps((v) => Math.min(PPS_MAX, v + 6))}>＋</button>
          <span className="ed-tl-count">${tr('studio.timeline.count', { n: segments.length, time: fmtTime(duration) })}</span>
        </div>
        <div className="ed-tl-body">
          <div className="ed-tl-labels">
            <div className="ed-tl-ruler-pad"></div>
            <div className="ed-tl-label">${tr('studio.timeline.video')}</div>
            <div className="ed-tl-label">${tr('studio.timeline.audio')}</div>
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
                ? html`<span className="ed-track-empty">${tr('studio.timeline.empty')}</span>`
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
                      <span className="ed-handle l" title=${tr('studio.timeline.trimIn')} onPointerDown=${(e) => beginTrim(e, i, 'left')}></span>
                      <span className="ed-clip-name">${seg.assetId}</span>
                      <span className="ed-clip-dur">${fmtDur(dur)}</span>
                      <span className="ed-handle r" title=${tr('studio.timeline.trimOut')} onPointerDown=${(e) => beginTrim(e, i, 'right')}></span>
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
                    setToast(tr('studio.toasts.selectMusic') + bgmTitle(musicSeg.trackId));
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
                    setToast(tr('studio.toasts.selectAmbient') + bgmTitle(ambientSeg.trackId));
                  }}
                >
                  ♫ ${bgmTitle(ambientSeg.trackId)}
                </span>
              `}
              ${!musicSeg && !ambientSeg && html`<span className="ed-track-empty">${tr('studio.timeline.audioEmpty')}</span>`}
            </div>
            <div
              className="ed-playhead"
              ref=${playheadElRef}
              style=${{ left: (playhead * pps) + 'px' }}
              onPointerDown=${beginScrub}
              title=${tr('studio.timeline.playhead')}
            ></div>
          </div>
        </div>
      </section>

      ${openList && html`
        <div className="ed-modal" onClick=${(e) => { if (e.target === e.currentTarget) setOpenList(null); }}>
          <div className="ed-modal-card">
            <div className="ed-modal-head">
              <b>${tr('studio.projects.openTitle')}</b>
              <button className="ed-btn" onClick=${() => setOpenList(null)}>${tr('studio.projects.close')}</button>
            </div>
            <div className="ed-modal-body">
              ${openList.length === 0 && html`<p className="ed-sub">${tr('studio.projects.noProjects')}</p>`}
              ${openList.map((p) => html`
                <button key=${p.id} className=${'ed-project-row' + (p.id === project.id ? ' on' : '')} onClick=${() => pickProject(p.id)}>
                  <span>${p.name}</span>
                  <span className="ed-sub">${tr('studio.projects.segmentCount', { n: p.segmentCount, time: fmtTime(0) })}</span>
                </button>
              `)}
              <div className="ed-modal-sub">${tr('studio.projects.rebuildSub')}</div>
              ${!films && html`<p className="ed-sub">${tr('studio.projects.loadingFilms')}</p>`}
              ${films && films.length === 0 && html`<p className="ed-sub">${tr('studio.projects.noFilms')}</p>`}
              ${(films || []).slice(0, 20).map((f) => html`
                <button
                  key=${f.taskId}
                  className="ed-project-row"
                  disabled=${rebuilding === f.taskId}
                  onClick=${() => rebuildFromTask(f.taskId)}
                >
                  <span>${(mediaPrompt(f) || f.taskId).slice(0, 40)}</span>
                  <span className="ed-sub">${tr('studio.projects.filmMeta', { n: f.totalClips || 0, time: fmtTime(f.totalDuration || 0) })}${f.status === 'partial' ? tr('studio.projects.partial') : ''}</span>
                </button>
              `)}
              ${(films || []).length > 20 && html`<p className="ed-sub">${tr('studio.projects.recent20')}</p>`}
            </div>
          </div>
        </div>
      `}

      ${viewerUrl && html`
        <div className="ed-viewer" onClick=${(e) => { if (e.target === e.currentTarget) setViewerUrl(null); }}>
          <div className="ed-viewer-card">
            <div className="ed-viewer-head">
              <b>${tr('studio.viewer.title')}</b>
              <button className="ed-btn" onClick=${() => setViewerUrl(null)}>${tr('studio.viewer.close')}</button>
            </div>
            <video className="ed-viewer-video" src=${viewerUrl} controls autoplay playsInline></video>
            <div className="ed-viewer-foot">
              <span className="ed-sub">${tr('studio.viewer.savedNote')}</span>
              <a className="ed-sub ed-link" href=${viewerUrl} target="_blank" rel="noreferrer">${tr('studio.viewer.newTab')}</a>
            </div>
          </div>
        </div>
      `}

      ${DIAG && diagText && html`
        <pre className="ed-diag">${diagText}</pre>
      `}

      ${toast && html`
        <div className="ed-toast" onClick=${() => setToast('')}>${toast}</div>
      `}
    </div>
  `;
}
