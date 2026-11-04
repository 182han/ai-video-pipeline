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
const { useEffect, useRef, useState } = React;

const LAST_KEY = 'dsh.editor.lastProject';
const SAVE_DEBOUNCE = 700;

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

  const projectRef = useRef(null);
  const revisionRef = useRef(0);
  const nameRef = useRef('');
  const timerRef = useRef(null);

  function adopt(p) {
    projectRef.current = p;
    revisionRef.current = Number(p.revision) || 1;
    nameRef.current = p.name || '';
    setProject(p);
    setNameDraft(p.name || '');
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
    })().catch((e) => setLoadErr(e.message || '工程加载失败'));
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

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
  const duration = segments.reduce((s, x) => s + Math.max(0, (x.outSec || 0) - (x.inSec || 0)), 0);

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
        <button className="ed-btn primary" disabled=${true} title="F08 接入">导出</button>
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
              <span className="ed-sub">${tab === 'media' ? '本地生成物' : '音乐 / 环境音'}</span>
            </div>
            <div className="ed-panel-body">
              ${tab === 'media'
                ? html`<div className="ed-empty">
                    <p>素材面板将在 F03 接入</p>
                    <p className="ed-sub">来源：片段库（只读库存）+ 已完成成片</p>
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
          <span className="ed-tool">撤销</span>
          <span className="ed-tool">重做</span>
          <span className="ed-tool">分割</span>
          <span className="ed-tool">删除</span>
          <span className="ed-spacer"></span>
          <span className="ed-tool">缩放 − ＋</span>
          <span className="ed-tl-count">${segments.length} 段 · ${fmtTime(duration)}</span>
        </div>
        <div className="ed-tl-body">
          <div className="ed-tl-labels">
            <div className="ed-tl-ruler-pad"></div>
            <div className="ed-tl-label">视频</div>
            <div className="ed-tl-label">音频</div>
          </div>
          <div className="ed-tl-scroll">
            <div className="ed-ruler">
              ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => html`
                <span key=${s} className=${'ed-tick' + (s % 5 === 0 ? ' major' : '')} style=${{ left: (s * 56) + 'px' }}>
                  ${s % 5 === 0 ? fmtTime(s) : ''}
                </span>
              `)}
            </div>
            <div className="ed-track video">
              ${segments.length === 0
                ? html`<span className="ed-track-empty">把素材拖到这里</span>`
                : segments.map((seg, i) => html`
                    <span key=${seg.id || i} className="ed-clip" style=${{ left: (i * 120) + 'px', width: '112px' }}>
                      ${seg.assetId}
                    </span>
                  `)}
            </div>
            <div className="ed-track audio">
              <span className="ed-track-empty">音频轨</span>
            </div>
            <div className="ed-playhead" style=${{ left: '0px' }}></div>
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

      ${toast && html`
        <div className="ed-toast" onClick=${() => setToast('')}>${toast}</div>
      `}
    </div>
  `;
}
