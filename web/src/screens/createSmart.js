// ============================================================
// 创作向导 · 小智流程版（P2，2026-11-16）
// ------------------------------------------------------------
// 与旧六步向导（/create）并存：2026-11-16 用户验收后已切为**默认创作入口**（左栏「创作」与 小智首页导航都进这里）；
// 旧六步向导保留在 /create，可从本页右上角「用旧版六步向导」回退。
// 五步（对齐小智的真实链路）：
//   ① 时长 + 场景卡（预览 N 段，可排除）
//   ② 提示词（按卡片字段自动合成，逐段可改；图片词只读展示）
//   ③ 出图 + 审核（可选、真实计费 ¥0.20/张；**整批停一次**让用户抽看/通过/打回）
//   ④ 生成设置（分辨率 / 转场 / 配乐 / 费用）
//   ⑤ 确认提交 → 生成中（逐段视频→质检→拼接→配乐）
// 图生视频 = ③ 出了图就用「图+视频提示词」，跳过 ③ 就是纯文生视频。
// 手动调色：按用户口径放到图片审核页，**本轮先不做**（这里只展示卡片的调色参数）。
// ============================================================
import { navigate } from '../router.js';
import { readRuntimeConfig } from '../store.js';
import { t as tr, getLocale, subscribe as subscribeLocale } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useState, useEffect } = React;

// 2026-11-21：把界面语言显式带给服务端（?lang=en）。
// 以前只靠 cookie/Accept-Language 推断，英文界面下拿到中文提示词时无从排查；
// 现在请求带参数、响应回显 lang + 每段 promptLanguage，链路是确定的。
function uiLang() { try { return String(getLocale() || 'zh').slice(0, 2); } catch (e) { return 'zh'; } }
// 随机种子（「换一批」用）：服务端 allocate(seed) 是确定序列，同一 seed 可复现。
function makeSeed() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
// 判提示词是否含中文（CJK）。英文界面下若服务端给了中文提示词，就在这里兜底重新取。
const CJK_RE = /[\u4e00-\u9fff]/;

const RES = [
  { key: '480p', label: '480P', rate: 0.3 },
  { key: '720p', label: '720P', rate: 0.6 },
  { key: '1080p', label: '1080P', rate: 1.2 }
];
const IMAGE_UNIT = 0.2; // wan2.7-image ¥0.20/张（与 src/pricing.js 一致）

// 草稿：2026-11-16 用户要求「切页/刷新别丢进度」（此前离开向导去小智首页再回来，2 张已付费图就挂不回去了）。
// 只存本向导的内存态（不含 Key），提交成功或点「重新开始」时清空。
const DRAFT_KEY = 'vs_create_smart_draft_v1';
function loadDraft() {
  try {
    const j = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return (j && typeof j === 'object') ? j : null;
  } catch (e) { return null; }
}
function saveDraft(d) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (e) { /* 隐私模式/配额忽略 */ }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
}

function readConfig() {
  try { return JSON.parse(localStorage.getItem('vs_config') || '{}') || {}; } catch (e) { return {}; }
}
function yuan(n) { return '¥' + (Number(n) || 0).toFixed(2); }

function Btn({ children, onClick, disabled, primary, danger }) {
  return html`<button onClick=${onClick} disabled=${disabled}
    className=${'h-8 px-3 rounded-[6px] text-[12px] border ' + (primary
      ? 'bg-accent text-onaccent border-accent'
      : (danger ? 'border-danger/40 text-danger hover:bg-danger/10' : 'border-white/[.12] text-ink2 hover:bg-white/[.05]'))}
    style=${{ opacity: disabled ? .45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
  >${children}</button>`;
}

function StepBar({ step }) {
  const names = [
    tr('createSmart.steps.s1'),
    tr('createSmart.steps.s2'),
    tr('createSmart.steps.s3'),
    tr('createSmart.steps.s4'),
    tr('createSmart.steps.s5')
  ];
  return html`<div className="flex items-center gap-1 flex-wrap mb-4">
    ${names.map((n, i) => html`<span key=${i}
      className=${'h-7 px-2.5 rounded-[5px] text-[11px] ' + (step === i + 1 ? 'bg-accent/[.16] text-accent' : (step > i + 1 ? 'text-ink2' : 'text-ink3'))}
    >${n}</span>`)}
  </div>`;
}

export function CreateSmartWizard() {
  const [draft0] = useState(() => loadDraft());
  const [step, setStep] = useState(draft0 && draft0.step ? draft0.step : 1);
  const [minutes, setMinutes] = useState(draft0 && draft0.minutes ? draft0.minutes : '5');
  const [clipDur, setClipDur] = useState(draft0 && draft0.clipDur ? draft0.clipDur : 10);
  const [cards, setCards] = useState(draft0 && Array.isArray(draft0.cards) ? draft0.cards : null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [prompts, setPrompts] = useState(draft0 && Array.isArray(draft0.prompts) ? draft0.prompts : []);
  const [imagePrompts, setImagePrompts] = useState(draft0 && Array.isArray(draft0.imagePrompts) ? draft0.imagePrompts : []);
  const [photos, setPhotos] = useState(draft0 && Array.isArray(draft0.photos) ? draft0.photos : []);   // [{id,url,status,paid}]
  const [res, setRes] = useState(draft0 && draft0.res ? draft0.res : '720p');
  // 视频通道（2026-11-16 20:30 实测更新）：中转 openai-video / 百炼 dashscope **都支持图生视频**。
  //   · WhaleTV 中转：NewAPI 形态 POST /video/generations + image，data URL 已实测出片（5s → SUCCESS）；
  //   · 百炼官方：getPolicy → 临时 OSS（48h 私有）+ X-DashScope-OssResourceResolve。
  //   → 不再「有图强制走百炼」，也不再阻断「有图 + 中转」；通道完全按用户选择。
  const [model, setModel] = useState(draft0 && draft0.model ? draft0.model : 'openai-video');
  const [transition, setTransition] = useState(draft0 ? draft0.transition !== false : true);
  const [bgm, setBgm] = useState(draft0 ? draft0.bgm !== false : true);
  const [restored, setRestored] = useState(!!(draft0 && draft0.step > 1)); // 仅「开局就是从草稿恢复」时提示
  const [pickerOpen, setPickerOpen] = useState(false);
  const [libPhotos, setLibPhotos] = useState([]);
  const [libBusy, setLibBusy] = useState('');
  const [showAll, setShowAll] = useState(false);
  // 2026-11-21：「换一批」= 起一个新种子重新抽卡（只读预览，不占卡、不建任务、不花钱）。
  const [seed, setSeed] = useState(() => (draft0 && draft0.seed ? draft0.seed : ''));

  // 真的动过才落盘（避免一进来就写空草稿，害得下次永远显示「已恢复」）
  useEffect(() => {
    if (step <= 1 && prompts.length === 0 && photos.length === 0) return;
    saveDraft({ v: 1, step, minutes, clipDur, cards, prompts, imagePrompts, photos, res, transition, bgm, model, seed, at: new Date().toISOString() });
  }, [step, minutes, clipDur, cards, prompts, imagePrompts, photos, res, transition, bgm, model, seed]);

  // 2026-11-21 用户报「英文模式下提示词仍是中文」：草稿里的提示词是**上一语言**时留下的
  // （切换语言后草稿照旧恢复中文文案）。语言变了就把提示词按当前语言重新取一遍——
  // 只重算提示词，不重新抽卡（卡里已排除的被排除项会被重置，可接受：提示词跟着卡走）。
  useEffect(() => {
    return subscribeLocale(() => {
      if (!Array.isArray(cards) || !cards.length) return;
      const ids = cards.map((c) => c.id);
      fetch('/api/scene-cards/preview?count=' + ids.length + '&lang=' + encodeURIComponent(uiLang()), { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!j || j.ok !== true || !Array.isArray(j.cards)) return;
          const fresh = j.cards.filter((c) => ids.includes(c.id));
          if (!fresh.length) return;
          setCards(j.cards);
          setPrompts(j.cards.map((c) => c.prompt));
          setImagePrompts(j.cards.map((c) => c.imagePrompt));
        })
        .catch(() => { /* 失败保持原样，不打断编辑 */ });
    });
  }, [cards]);

  function restart() {
    if (!window.confirm(tr('createSmart.restartConfirm'))) return;
    clearDraft();
    setStep(1); setMinutes('5'); setClipDur(10); setCards(null);
    setPrompts([]); setImagePrompts([]); setPhotos([]); setRes('720p');
    setTransition(true); setBgm(true); setRestored(false); setErr(''); setInfo(''); setShowAll(false);
    setSeed('');
  }

  const totalSec = Math.max(1, Math.round((parseFloat(minutes) || 0) * 60));
  const clips = Math.max(1, Math.ceil(totalSec / clipDur - 1e-9));
  const tooMany = clips > 180;
  const rate = (RES.find((r) => r.key === res) || RES[0]).rate;
  const videoCost = clips * clipDur * rate;
  const imageCost = photos.filter((p) => p.paid !== false).length * IMAGE_UNIT; // 从库选的图已付过费，不重复计
  const approved = photos.filter((p) => p.status !== 'rejected');
  const pickedCount = photos.filter((p) => p.paid === false).length;
  const photoCountMismatch = photos.length > 0 && photos.length !== clips;
  const useImages = approved.length === prompts.length && prompts.length > 0;
  // 通道完全按用户选择（model），不静默换通道；两种通道均支持图生视频（2026-11-16 20:30 实测）。
  const effectiveModel = model;
  const MODEL_LABEL = { 'openai-video': 'settings.group.whaletv', dashscope: 'settings.group.dashscope' };
  const modelLabel = (k) => (MODEL_LABEL[k] ? tr(MODEL_LABEL[k]) : k);

  // i2vUnsupported：2026-11-21 用户报「创作页整块崩：i2vUnsupported is not defined」。
  // 根因：步骤④/⑤ 的按钮直接引用了一个从未声明的变量（React 渲染时抛 ReferenceError，
  // 被 ErrorBoundary 兜成「This block failed to render」），**整页创作向导都打不开**。
  // 语义（不得静默降级）：只有「要用图生视频」且当前通道**不在服务端 i2v 能力表里**时才禁用并说明原因；
  // 纯文生视频（没选图 / 选了图但不用）永远不禁用。能力表来自 /api/image-gen/status 的 i2vModels。
  const [i2vModels, setI2vModels] = useState([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/image-gen/status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j && Array.isArray(j.i2vModels)) setI2vModels(j.i2vModels.map(String)); })
      .catch(() => { /* 读不到就不禁用，提交时由服务端再校验（服务端有硬校验） */ });
    return () => { alive = false; };
  }, []);
  const i2vUnsupported = !!(useImages && i2vModels.length && !i2vModels.includes(effectiveModel));

  // 从图片库按段选图（2026-11-16 用户要求）：复用已付费的图，不重新出图、不重复计费
  async function openPicker() {
    setErr(''); setLibBusy('open');
    try {
      const r = await fetch('/api/photos?includeMissing=1', { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      const list = (Array.isArray(j.photos) ? j.photos : [])
        .filter((p) => p.status === 'approved' && p.url && !p.fileMissing);
      setLibPhotos(list);
      setPickerOpen(true);
    } catch (e) { setErr(tr('createSmart.errors.readLibrary') + e.message); }
    finally { setLibBusy(''); }
  }

  function togglePick(p) {
    if (photos.some((x) => x.id === p.id)) {
      setPhotos((ps) => ps.filter((x) => x.id !== p.id));
      return;
    }
    if (photos.length >= clips) {
      setErr(tr('createSmart.errors.maxPick', { max: clips, n: photos.length }));
      return;
    }
    setErr('');
    setPhotos((ps) => [...ps, { id: p.id, url: p.url, status: 'approved', paid: false, label: p.label || '' }]);
  }

  // 取一批场景卡（只读预览：不占卡、不建任务、不花钱）。
  // mode: 'new'     第一次进①点「看场景卡」→ 新种子（每次不同）
  //       'reshuffle' 已有一批 → 「换一批」（新种子）
  //       'refresh'   已有卡、只重算提示词（换语言）→ 沿用当前种子
  async function loadCards(mode = 'new') {
    if (tooMany) { setErr(tr('createSmart.errors.tooMany', { n: clips })); return; }
    const nextSeed = mode === 'refresh' ? (seed || '') : makeSeed();
    setErr(''); setBusy(mode === 'reshuffle' ? 'reshuffle' : 'cards');
    try {
      const qs = '/api/scene-cards/preview?count=' + clips
        + '&lang=' + encodeURIComponent(uiLang())
        + (nextSeed ? '&seed=' + encodeURIComponent(nextSeed) : '');
      const r = await fetch(qs, { credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (!j || j.ok !== true) {
        throw new Error((j && (j.error || j.code)) || ('HTTP ' + r.status)
          + tr('createSmart.errors.card404'));
      }
      let cards = j.cards || [];
      let promptList = cards.map((c) => c.prompt);
      let imageList = cards.map((c) => c.imagePrompt);
      // 2026-11-21 兜底：英文界面却拿到中文提示词（服务端旧版本 / cookie 丢）→ 用返回的 id 重新取一次。
      // 只做一次，失败就如实显示（不静默冒充英文）。
      if (uiLang() === 'en' && promptList.length && promptList.some((p) => CJK_RE.test(String(p || '')))) {
        try {
          const r2 = await fetch('/api/scene-cards/preview?count=' + cards.length
            + '&lang=en&seed=' + encodeURIComponent(nextSeed || 'en-fallback'), { credentials: 'same-origin' });
          const j2 = await r2.json().catch(() => null);
          if (j2 && j2.ok === true && Array.isArray(j2.cards)) {
            const byId = new Map(j2.cards.map((c) => [c.id, c]));
            const remapped = cards.map((c) => byId.get(c.id)).filter(Boolean);
            if (remapped.length === cards.length) {
              cards = remapped;
              promptList = cards.map((c) => c.prompt);
              imageList = cards.map((c) => c.imagePrompt);
            }
          }
        } catch (e) { /* 兜底失败：保留服务端原样 */ }
      }
      setSeed(nextSeed);
      setCards(cards);
      setPrompts(promptList);
      setImagePrompts(imageList);
      setStep(2);
    } catch (e) { setErr(tr('createSmart.errors.readCards') + e.message); }
    finally { setBusy(''); }
  }

  async function genImages() {
    const cfg = readConfig();
    if (!cfg.imageKey) { setErr(tr('createSmart.errors.noImageKey')); return; }
    if (!window.confirm(tr('createSmart.errors.genConfirm', {
      n: imagePrompts.length,
      cost: yuan(imagePrompts.length * IMAGE_UNIT)
    }))) return;
    setErr(''); setInfo(''); setBusy('images');
    try {
      const r = await fetch('/api/images/generate-batch', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompts: imagePrompts,
          apiKey: cfg.imageKey || '', baseUrl: cfg.imageBaseUrl || '',
          provider: cfg.imageProvider || 'dashscope', model: cfg.imageModel || 'wan2.7-image',
          size: cfg.imageSize || '1696*960', palette: 'calm',
          taskId: 'smart_' + Date.now().toString(36)
        })
      });
      const j = await r.json().catch(() => null);
      if (!j || j.ok !== true || !Array.isArray(j.items)) {
        throw new Error((j && (j.error || (j.errors && j.errors[0] && j.errors[0].error))) || ('HTTP ' + r.status));
      }
      const ids = j.items.map((x) => x.photoId);
      // 2026-11-16 fix（Lead 诊断，实测）：批量出图的记录 isFinal=false（设最终版要求 scienceStatus=passed，
      // 新图是 unchecked，永远进不了 final 集合），所以用 ?final=1 按 id 查不到 → 卡片显示「无预览」。
      // 改为全量查询后按 id 匹配；文件缺失由 p.url 空值兜底。
      const pr = await fetch('/api/photos?includeMissing=1', { credentials: 'same-origin' });
      const pj = await pr.json().catch(() => ({ photos: [] }));
      const all = (pj && pj.photos) || [];
      setPhotos(ids.map((id) => {
        const it = all.find((p) => p.id === id) || {};
        return { id, url: it.url || '', status: it.status || 'unchecked', paid: true };
      }).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)));
      setInfo(tr('createSmart.generated', { n: ids.length, cost: yuan(ids.length * IMAGE_UNIT) }));
    } catch (e) { setErr(tr('createSmart.errors.genFailed') + e.message); }
    finally { setBusy(''); }
  }

  async function review(id, status) {
    setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, status } : p)));
    try {
      await fetch('/api/photos/' + encodeURIComponent(id), {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
    } catch (e) { setErr(tr('createSmart.errors.reviewFailed') + e.message); }
  }

  async function submit() {
    const cfg = readConfig();
    const rejected = photos.filter((p) => p.status === 'rejected').length;
    if (rejected > 0) { setErr(tr('createSmart.errors.rejected', { n: rejected })); return; }
    if (!window.confirm(tr('createSmart.errors.submitConfirm', {
      clips,
      dur: clipDur,
      mode: useImages ? tr('createSmart.mode.i2v') : tr('createSmart.mode.t2v'),
      model: modelLabel(effectiveModel),
      video: yuan(videoCost),
      image: imageCost ? tr('createSmart.errors.imagePart', { cost: yuan(imageCost) }) : ''
    }))) return;
    setErr(''); setBusy('submit');
    try {
      // 运行时配置按通道取（百炼：Key + 由 WorkspaceId/Region 拼出的 baseUrl；中转：whaletvKey/BaseUrl）
      const rt = readRuntimeConfig(effectiveModel);
      const body = {
        ...rt,
        model: effectiveModel, prompts, resolution: res, clipDuration: clipDur,
        preset: 'final', autoRetry: false,
        transition: { enabled: transition, duration: 0.4, type: 'fade' },
        bgm: { enabled: bgm, mode: 'auto' }
      };
      if (useImages) body.photoIds = approved.map((p) => p.id);
      const r = await fetch('/api/tasks', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.taskId) throw new Error((j && j.error) || ('HTTP ' + r.status));
      clearDraft(); setRestored(false);   // 任务已建：草稿作废，避免下次进来「恢复」出个重复任务
      navigate('/gen');
    } catch (e) { setErr(tr('createSmart.errors.submitFailed') + e.message); }
    finally { setBusy(''); }
  }

  const list = showAll ? prompts : prompts.slice(0, 12);

  return html`
    <div className="xz2 px-6 py-5" style=${{ paddingBottom: '90px' }}>
      <style>${`
        .xz2 { max-width: 1180px; }
        .xz2 div, .xz2 p, .xz2 span, .xz2 label { font-size: 13px; line-height: 1.75; }
        .xz2 textarea { font-size: 13.5px; line-height: 1.8; }
        .xz2 button { font-size: 13px; }
        .xz2 h1 { font-size: 24px; }
        .xz2 .rounded-\\[8px\\] { padding: 18px 20px; }
      `}</style>
      <div className="flex items-baseline gap-3 mb-1">
        <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0">${tr('createSmart.pageTitle')}</h1>
        <span className="text-[11px] text-ink3">${tr('createSmart.pageSub')}</span>
        <span className="flex-1"></span>
        ${restored && html`<span className="text-[11px] text-accent">${tr('createSmart.restored')}</span>`}
        <${Btn} onClick=${restart}>${tr('createSmart.restart')}</${Btn}>
        <${Btn} onClick=${() => navigate('/create')}>${tr('createSmart.legacy')}</${Btn}>
      </div>
      <${StepBar} step=${step} />

      ${err && html`<p className="mb-3 text-[12px] text-danger">${err}</p>`}
      ${info && html`<p className="mb-3 text-[12px] text-accent">${info}</p>`}

      ${step === 1 && html`
        <div className="rounded-[8px] border border-white/[.08] bg-s1 p-4">
          <p className="text-[12px] text-ink2 mb-3">${tr('createSmart.step1.intro')}</p>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-[12px] text-ink3">${tr('createSmart.step1.totalDuration')}</label>
            <input value=${minutes} onInput=${(e) => setMinutes(e.target.value)} type="number" min="1" max="60"
              className="h-8 w-[90px] px-2 rounded-[5px] bg-s2 text-[12px] text-ink border border-white/[.12] outline-none" />
            <span className="text-[12px] text-ink3">${tr('createSmart.step1.minutes')}</span>
            <span className="w-4"></span>
            <label className="text-[12px] text-ink3">${tr('createSmart.step1.perClip')}</label>
            ${[10, 15].map((d) => html`<button key=${d} onClick=${() => setClipDur(d)}
              className=${'h-8 px-2.5 rounded-[5px] text-[12px] border ' + (clipDur === d ? 'border-accent text-accent bg-accent/[.10]' : 'border-white/[.12] text-ink2')}
            >${tr('createSmart.step1.seconds', { n: d })}</button>`)}
          </div>
          <div className="mt-3 text-[12px] text-ink2">
            ${tr('createSmart.step1.estimate', { clips, dur: clipDur, mins: (clips * clipDur / 60).toFixed(2) })}
            ${tooMany ? html`<span className="text-danger">${tr('createSmart.step1.overCapacity')}</span>` : ''}
          </div>
          <p className="mt-1 text-[11px] text-ink3">
            ${tr('createSmart.step1.resNote', { res })}
          </p>
          <div className="mt-4 flex gap-2">
            <${Btn} primary=${true} disabled=${busy === 'cards' || tooMany} onClick=${() => loadCards('new')}>
              ${busy === 'cards' ? tr('createSmart.step1.reading') : tr('createSmart.step1.viewCards', { n: clips })}
            </${Btn}>
          </div>
        </div>`}

      ${step === 2 && html`
        <div className="rounded-[8px] border border-white/[.08] bg-s1 p-4">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-[12px] text-ink2">${tr('createSmart.step2.promptTitle')}</span>
            <span className="text-[10px] text-ink3">${tr('createSmart.step2.totalClips', { n: prompts.length })}</span>
            <span className="flex-1"></span>
            ${cards && cards.length ? html`<span className="text-[10px] text-ink3" title=${tr('createSmart.step2.seedTitle')}>${tr('createSmart.step2.seedLabel', { seed: seed ? seed.slice(-4) : '—' })}</span>` : ''}
            <${Btn} disabled=${busy === 'reshuffle'} onClick=${() => loadCards('reshuffle')}>
              ${busy === 'reshuffle' ? tr('createSmart.step2.reshuffling') : tr('createSmart.step2.reshuffle')}
            </${Btn}>
            ${prompts.length > 12 && html`<${Btn} onClick=${() => setShowAll(!showAll)}>
              ${showAll ? tr('createSmart.step2.collapse') : tr('createSmart.step2.showAll', { n: prompts.length })}
            </${Btn}>`}
          </div>
          ${prompts.length > 12 && html`<p className="text-[10px] text-ink3 mb-2">${tr('createSmart.step2.showAllHint', { shown: 12, total: prompts.length })}</p>`}
          ${list.map((p, i) => html`
            <div key=${i} className="border-t border-white/[.05] py-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-ink3 font-num">${tr('createSmart.step2.segment', { n: i + 1 })}</span>
                <span className="text-[10px] text-ink3">${cards && cards[i] ? cards[i].sceneKey : ''}</span>
                <span className="text-[10px] text-ink3">${cards && cards[i] && cards[i].adjust ? tr('createSmart.step2.adjustParams') : ''}</span>
              </div>
              <textarea value=${p} rows="2"
                onInput=${(e) => { const v = e.target.value; setPrompts((arr) => arr.map((x, k) => (k === i ? v : x))); }}
                className="w-full resize-y rounded-[5px] bg-s2 text-[12px] text-ink border border-white/[.12] px-2 py-1.5 outline-none leading-[1.7]"></textarea>
            </div>`)}
          ${!showAll && prompts.length > 12 && html`
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-ink3">${tr('createSmart.step2.hidden', { n: prompts.length - 12 })}</span>
              <button onClick=${() => setShowAll(true)} className="h-6 px-2 rounded-[4px] text-[11px] text-accent border border-accent/40 hover:bg-accent/[.08]">${tr('createSmart.step2.showAll', { n: prompts.length })}</button>
            </div>`}
          <div className="mt-4 flex gap-2">
            <${Btn} onClick=${() => setStep(1)}>${tr('createSmart.step2.prev')}</${Btn}>
            <${Btn} primary=${true} onClick=${() => setStep(3)}>${tr('createSmart.step2.next')}</${Btn}>
          </div>
        </div>`}

      ${step === 3 && html`
        <div className="rounded-[8px] border border-white/[.08] bg-s1 p-4">
          <p className="text-[12px] text-ink2 mb-1">${tr('createSmart.step3.optionalPrefix')}<b className="text-ink">${tr('createSmart.step3.optionalBold')}</b>${tr('createSmart.step3.optionalSuffix')}</p>
          <p className="text-[11px] text-ink3 mb-3">${tr('createSmart.step3.billingPrefix', { unit: yuan(IMAGE_UNIT), n: imagePrompts.length, total: yuan(imagePrompts.length * IMAGE_UNIT) })}<b className="text-ink2">${tr('createSmart.step3.billingBold')}</b>${tr('createSmart.step3.billingSuffix')}</p>
          <div className="flex gap-2 mb-3 flex-wrap">
            <${Btn} primary=${true} disabled=${busy === 'images'} onClick=${genImages}>
              ${busy === 'images' ? tr('createSmart.step3.generating') : tr('createSmart.step3.generate', { n: imagePrompts.length })}
            </${Btn}>
            <${Btn} disabled=${libBusy === 'open'} onClick=${openPicker}>${libBusy === 'open' ? tr('createSmart.step3.readingLib') : tr('createSmart.step3.pickLib')}</${Btn}>
            <${Btn} onClick=${() => { setPhotos([]); setStep(4); }}>${tr('createSmart.step3.skip')}</${Btn}>
          </div>
          <p className="text-[11px] text-ink3 mb-3">
            ${tr('createSmart.step3.selected', { n: photos.length, max: clips })}${pickedCount ? tr('createSmart.step3.pickedSuffix', { n: pickedCount }) : ''}
          </p>
          ${photoCountMismatch && html`<p className="text-[12px] text-danger mb-2">${tr('createSmart.step3.mismatch', { n: clips })}</p>`}
          ${photos.length > 0 && html`
            <div className="grid grid-cols-4 gap-2">
              ${photos.map((p, i) => html`
                <div key=${p.id} className="rounded-[6px] border border-white/[.10] overflow-hidden bg-s2">
                  ${p.url ? html`<img src=${p.url} alt=${tr('createSmart.step3.alt')} className="w-full h-[110px] object-cover" />` : html`<div className="w-full h-[110px] grid place-items-center text-[10px] text-ink3">${tr('createSmart.step3.noPreview')}</div>`}
                  <div className="flex items-center gap-1 p-1.5">
                    <span className="text-[10px] text-ink3 font-num">${i + 1}</span>
                    <span className=${'text-[10px] ' + (p.status === 'rejected' ? 'text-danger' : 'text-ink3')}>${p.paid === false ? tr('createSmart.step3.tagPicked') : (p.status === 'rejected' ? tr('createSmart.step3.tagRejected') : (p.status === 'approved' ? tr('createSmart.step3.tagApproved') : tr('createSmart.step3.tagPending')))}</span>
                    <span className="flex-1"></span>
                    ${p.paid === false
                      ? html`<button onClick=${() => togglePick({ id: p.id })} className="h-5 px-1 rounded-[3px] text-[10px] text-ink3 hover:text-danger">${tr('createSmart.step3.remove')}</button>`
                      : html`<button onClick=${() => review(p.id, 'approved')} className="h-5 px-1 rounded-[3px] text-[10px] text-accent hover:bg-white/[.06]">${tr('createSmart.step3.approve')}</button>
                             <button onClick=${() => review(p.id, 'rejected')} className="h-5 px-1 rounded-[3px] text-[10px] text-ink3 hover:text-danger">${tr('createSmart.step3.reject')}</button>`}
                  </div>
                </div>`)}
            </div>`}
          <div className="mt-4 flex gap-2">
            <${Btn} onClick=${() => setStep(2)}>${tr('createSmart.step2.prev')}</${Btn}>
            <${Btn} primary=${true} disabled=${photoCountMismatch} onClick=${() => setStep(4)}>${tr('createSmart.step3.next')}</${Btn}>
          </div>
        </div>`}

      ${step === 4 && html`
        <div className="rounded-[8px] border border-white/[.08] bg-s1 p-4">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <label className="text-[12px] text-ink3">${tr('createSmart.step4.channel')}</label>
            ${[['openai-video', tr('createSmart.step4.whale')], ['dashscope', tr('createSmart.step4.bailian')]].map(([k, lab]) => html`
              <button key=${k} onClick=${() => setModel(k)}
                className=${'h-7 px-2.5 rounded-[5px] text-[11px] border ' + (effectiveModel === k ? 'border-accent text-accent bg-accent/[.10]' : 'border-white/[.12] text-ink2')}
                style=${{ cursor: 'pointer' }}
                title=${k === 'openai-video' ? tr('createSmart.step4.whaleTitle') : tr('createSmart.step4.bailianTitle')}
              >${lab}</button>`)}
          </div>
          ${useImages && html`<p className="text-[11px] text-ink3 mb-3">
            ${effectiveModel === 'openai-video'
              ? html`${tr('createSmart.step4.i2vWhalePrefix')}<b className="text-ink2">${tr('createSmart.step4.i2vWhaleBold')}</b>${tr('createSmart.step4.i2vWhaleSuffix')}`
              : html`${tr('createSmart.step4.i2vBailianPrefix')}<b className="text-ink2">${tr('createSmart.step4.i2vBailianBold')}</b>${tr('createSmart.step4.i2vBailianSuffix')}`}
          </p>`}
          ${useImages && i2vUnsupported && html`<p className="text-[11px] text-danger mb-3">
            ${tr('createSmart.errors.i2vUnsupported', { model: modelLabel(effectiveModel), models: i2vModels.join(' / ') || tr('createSmart.errors.noModels') })}
          </p>`}
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <label className="text-[12px] text-ink3">${tr('createSmart.step4.resolution')}</label>
            ${RES.map((r) => html`<button key=${r.key} onClick=${() => setRes(r.key)}
              className=${'h-7 px-2.5 rounded-[5px] text-[11px] border ' + (res === r.key ? 'border-accent text-accent bg-accent/[.10]' : 'border-white/[.12] text-ink2')}
            >${r.label}</button>`)}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-ink2 mb-2">
            <input type="checkbox" checked=${transition} onChange=${(e) => setTransition(e.target.checked)} />
            ${tr('createSmart.step4.crossfade')}
          </label>
          <label className="flex items-center gap-2 text-[12px] text-ink2 mb-3">
            <input type="checkbox" checked=${bgm} onChange=${(e) => setBgm(e.target.checked)} />
            ${tr('createSmart.step4.autoBgm')}
          </label>
          <div className="text-[12px] text-ink2 leading-[1.9]">
            ${tr('createSmart.step4.clipsLine', { clips, dur: clipDur })}<br/>
            ${tr('createSmart.step4.videoLine', { cost: yuan(videoCost), res, rate })}${photos.length ? html`<br/>${tr('createSmart.step4.imageLine', { cost: yuan(imageCost), n: photos.length - pickedCount, picked: pickedCount ? tr('createSmart.step4.pickedLine', { n: pickedCount }) : '' })}` : ''}<br/>
            <b className="text-ink">${tr('createSmart.step4.total', { cost: yuan(videoCost + imageCost) })}</b>
          </div>
          <div className="mt-4 flex gap-2">
            <${Btn} onClick=${() => setStep(3)}>${tr('createSmart.step4.prev')}</${Btn}>
            <${Btn} primary=${true} disabled=${i2vUnsupported} onClick=${() => setStep(5)}>${tr('createSmart.step4.next')}</${Btn}>
          </div>
        </div>`}

      ${step === 5 && html`
        <div className="rounded-[8px] border border-white/[.08] bg-s1 p-4">
          <div className="text-[12px] text-ink2 leading-[1.9]">
            ${tr('createSmart.step5.modelLine', { model: modelLabel(effectiveModel), res })}<br/>
            ${tr('createSmart.step5.durationLine', { clips, dur: clipDur, mins: (clips * clipDur / 60).toFixed(2) })}<br/>
            ${approved.length === prompts.length && prompts.length ? tr('createSmart.step5.visualI2v', { n: approved.length }) : tr('createSmart.step5.visualT2v')}<br/>
            ${tr('createSmart.step5.transitionLine', {
              transition: transition ? tr('createSmart.step5.transitionFade') : tr('createSmart.step5.transitionOff'),
              bgm: bgm ? tr('createSmart.step5.bgmAuto') : tr('createSmart.step5.bgmOff')
            })}<br/>
            ${tr('createSmart.step5.costPrefix', {
              video: yuan(videoCost),
              image: imageCost ? tr('createSmart.step5.imagePart', { cost: yuan(imageCost) }) : '',
              picked: pickedCount ? tr('createSmart.step5.pickedCost', { n: pickedCount }) : ''
            })}<b className="text-ink">${yuan(videoCost + imageCost)}</b>
          </div>
          <p className="mt-3 text-[11px] text-ink3">${tr('createSmart.step5.note')}</p>
          <div className="mt-4 flex gap-2">
            <${Btn} onClick=${() => setStep(4)}>${tr('createSmart.step5.prev')}</${Btn}>
            <${Btn} primary=${true} disabled=${busy === 'submit' || i2vUnsupported} onClick=${submit}>${busy === 'submit' ? tr('createSmart.step5.submitting') : tr('createSmart.step5.submit', { cost: yuan(videoCost + imageCost) })}</${Btn}>
          </div>
        </div>`}

      ${pickerOpen && html`
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style=${{ background: 'rgba(0,0,0,.72)' }} onClick=${() => setPickerOpen(false)}>
          <div className="w-full max-w-[920px] overflow-auto rounded-[8px] border border-white/[.12] bg-s1 p-4"
            style=${{ maxHeight: '80vh' }}
            onClick=${(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-[13px] text-ink">${tr('createSmart.picker.title')}</span>
              <span className="text-[11px] text-ink3">${tr('createSmart.picker.subtitle', { clips })}</span>
              <span className="flex-1"></span>
              <span className="text-[12px] text-accent">${tr('createSmart.picker.selected', { n: photos.length, max: clips })}</span>
              <${Btn} primary=${true} onClick=${() => setPickerOpen(false)}>${tr('createSmart.picker.done')}</${Btn}>
            </div>
            ${libPhotos.length === 0 && html`<p className="text-[12px] text-ink3 py-6">${tr('createSmart.picker.empty')}</p>`}
            <div className="grid gap-2" style=${{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
              ${libPhotos.map((p) => {
                const idx = photos.findIndex((x) => x.id === p.id);
                return html`<button key=${p.id} onClick=${() => togglePick(p)}
                  className=${'rounded-[6px] overflow-hidden border text-left ' + (idx >= 0 ? 'border-accent' : 'border-white/[.10]')}
                  style=${{ position: 'relative', background: '#0f1712' }}>
                  ${p.url ? html`<img src=${p.url} alt=${tr('createSmart.step3.alt')} className="w-full h-[86px] object-cover" />` : html`<div className="w-full h-[86px] grid place-items-center text-[10px] text-ink3">${tr('createSmart.step3.noPreview')}</div>`}
                  ${idx >= 0 && html`<span style=${{ position: 'absolute', top: '4px', left: '4px', height: '16px', minWidth: '16px', padding: '0 4px', borderRadius: '3px', background: 'var(--accent)', color: '#0b100d', fontSize: '10px', lineHeight: '16px', textAlign: 'center' }}>${idx + 1}</span>`}
                  <div className="px-1.5 py-1 text-[10px] text-ink3 truncate">${p.label || ''}${p.isFinal ? tr('createSmart.picker.finalSuffix') : ''}</div>
                </button>`;
              })}
            </div>
          </div>
        </div>`}
    </div>
  `;
}
