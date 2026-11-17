// ============================================================
// 创作：六步向导（2026-10-31）
// ------------------------------------------------------------
// ①提示词 → ②图片生成 → ③图片审核 → ④运镜 → ⑤时长与配乐 → ⑥确认
// 现状约束（不装样子，界面直说）：
//   · 出图后端已接入 wan2.7-image（2026-11-08）→ 第②步可做「单张测试出图」
//   · 用户 2026-11-10 拍板：**不要后端审核门状态机**（不新增待审状态、不做批次/超时/留痕），
//     只要「第②步出完图，第③步能看见这张图，不满意就打回重做这一张」。
//     因此第③步 = 纯前端人工确认（看图 → 通过 / 打回重做），不改任务状态机。
//   · 图片仍不并入任务；提交走既有 POST /api/tasks（文生视频链路，能真跑）
//     2026-11-11 起：勾选「用这张图生成视频」时任务带 sourcePhotoId，走图生视频（可灵 / Seedance / WhaleTV）
//     最终提示词 = 画面提示词（图片库）。运动描述（主提示词 + 运镜）
// ============================================================
import { navigate } from '../router.js';
import { promptBus } from '../store.js';
import {
  loadDraft, saveDraft, clearDraft,
  getImageState, onImageState, startImage,
  takeSeedPhoto, adoptPhoto
} from '../createDraft.js';
import { t as tr } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState, useRef } = React;

const STEPS = [
  'create.steps.prompt',
  'create.steps.images',
  'create.steps.review',
  'create.steps.motion',
  'create.steps.duration',
  'create.steps.confirm'
];

// 8 个执行环节（与 src/pipelineStages.js 的 ALL_STAGES 一致；核心链 3 步锁定必选）
const STAGE_OPTS = [
  { key: 'prompt_optimize', nameKey: 'create.stage.prompt_optimize', core: true },
  { key: 'storyboard', nameKey: 'create.stage.storyboard', core: true },
  { key: 'clip_generation', nameKey: 'create.stage.clip_generation', core: true },
  { key: 'concatenation', nameKey: 'create.stage.concatenation' },
  { key: 'loop_processing', nameKey: 'create.stage.loop_processing' },
  { key: 'audio_mix', nameKey: 'create.stage.audio_mix' },
  { key: 'transcoding', nameKey: 'create.stage.transcoding' },
  { key: 'final_qc', nameKey: 'create.stage.final_qc' }
];

// 13 个质检项（与 src/qualityChecker.js 的 QC_ITEMS 一致；nsfw 永远要紧，不可关闭）
const QC_OPTS = [
  { key: 'prompt', nameKey: 'create.qc.prompt' },
  { key: 'storyboard', nameKey: 'create.qc.storyboard' },
  { key: 'blackFrame', nameKey: 'create.qc.blackFrame' },
  { key: 'blur', nameKey: 'create.qc.blur' },
  { key: 'duplicate', nameKey: 'create.qc.duplicate' },
  { key: 'duration', nameKey: 'create.qc.duration' },
  { key: 'nsfw', nameKey: 'create.qc.nsfw' },
  { key: 'concat', nameKey: 'create.qc.concat' },
  { key: 'seam', nameKey: 'create.qc.seam' },
  { key: 'colorContinuity', nameKey: 'create.qc.colorContinuity' },
  { key: 'loop', nameKey: 'create.qc.loop' },
  { key: 'transcode', nameKey: 'create.qc.transcode' },
  { key: 'final', nameKey: 'create.qc.final' }
];

const ALL_STAGE_KEYS = STAGE_OPTS.map((s) => s.key);
const ALL_QC_KEYS = QC_OPTS.map((q) => q.key);
// 默认「要紧项」只留硬闸门：黑帧 / 时长 / NSFW（NSFW 永远要紧）。
// 模糊、重复帧、内容匹配对 AI 风光片容易误判，默认只警告、不触发重生成。
const HARD_QC_KEYS = ['blackFrame', 'duration', 'nsfw'];

// 从 localStorage.vs_config 取运行时配置（与旧版同键，共用一份 Key）
function collectRuntime(model) {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('vs_config') || '{}'); } catch { cfg = {}; }
  const base = {
    llmApiKey: cfg.llmKey || '', llmBaseUrl: cfg.llmUrl || '', llmModel: cfg.llmModel || '',
    multimodalApiKey: cfg.multimodalKey || '', multimodalBaseUrl: cfg.multimodalUrl || '',
    multimodalModel: cfg.multimodalModel || ''
  };
  if (model === 'seedance') {
    return { ...base, apiKey: cfg.seedanceKey || '', apiBaseUrl: cfg.seedanceBaseUrl || '', modelId: cfg.seedanceModel || '' };
  }
  if (model === 'dashscope') {
    // 官方 API 根地址 = https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1
    // 设置页只存了 WorkspaceId/区域，早前这里没拼 apiBaseUrl，导致 dashscope 永远「Base URL 未配置」。
    const dsBase = (cfg.dashScopeWorkspaceId && cfg.dashScopeRegion)
      ? `https://${cfg.dashScopeWorkspaceId}.${cfg.dashScopeRegion}.maas.aliyuncs.com/api/v1`
      : (cfg.dashScopeBaseUrl || '');
    return { ...base, apiKey: cfg.dashScopeKey || '', apiBaseUrl: dsBase, modelId: 'wan3.0-video' };
  }
  if (model === 'kling') {
    return { ...base, klingAccessKey: cfg.klingAk || '', klingSecretKey: cfg.klingSk || '' };
  }
  if (model === 'openai-video') {
    // OpenAI 兼容视频中转（WhaleTV / New API）：POST /videos → GET /videos/{id}/content
    return { ...base, apiKey: cfg.whaletvKey || '', baseUrl: cfg.whaletvBaseUrl || '', modelId: cfg.whaletvVideoModel || 'wan3.0-video' };
  }
  return base;
}

// 读取设置页写入的生成参数（localStorage.vs_web_config）
// 键名与 settingsPage.js 的「生成参数」组一致：videoModel / resolution / preset
function readWebConfig() {
  try { return JSON.parse(localStorage.getItem('vs_web_config') || '{}') || {}; }
  catch { return {}; }
}

// 多提示词批量（旧版口径）：非空行 = 一个场景 = 一个片段；行尾【主题】由服务端解析
function splitPromptLines(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// 图生视频：画面基准（图片提示词）与运动描述明显冲突时，提交前让用户确认。
// 只做保守的天气/昼夜对立词；其它交给用户判断，不擅自改写提示词。
function findPromptConflict(base, motion) {
  const b = String(base || '');
  const m = String(motion || '');
  if (!b || !m) return '';
  const pairs = [
    [['晴天', '晴朗', '阳光'], ['暴雨', '下雨', '雷雨', '暴风雪', '下雪', '大雪', '大雾', '阴天']], // i18n-allow: Chinese weather synonyms for input matching
    [['白天', '正午', '清晨', '日出'], ['夜晚', '深夜', '夜景', '星空', '银河', '月夜']] // i18n-allow: Chinese time-of-day synonyms
  ];
  const hit = (text, words) => words.filter((w) => text.includes(w));
  for (const [a, bWords] of pairs) {
    const inBaseA = hit(b, a);
    const inMotionB = hit(m, bWords);
    if (inBaseA.length && inMotionB.length) return tr('create.conflict.text', { base: inBaseA[0], motion: inMotionB[0] });
    const inBaseB = hit(b, bWords);
    const inMotionA = hit(m, a);
    if (inBaseB.length && inMotionA.length) return tr('create.conflict.text', { base: inBaseB[0], motion: inMotionA[0] });
  }
  return '';
}

// 账户余额（元）：留空/非法 = 不拦截（旧版口径）
function readBalance() {
  try {
    const v = parseFloat(readWebConfig().balance);
    return Number.isFinite(v) ? v : NaN;
  } catch { return NaN; }
}

function Section({ title, extra, children }) {
  return html`
    <div className="border-t border-white/[.08] pt-4">
      <div className="flex items-baseline gap-2 mb-2">
        <b className="text-[13px] font-medium text-ink">${title}</b>
        ${extra || null}
      </div>
      ${children}
    </div>
  `;
}

function Info({ children }) {
  return html`<span className="text-[11px] leading-[1.7] text-ink3">${children}</span>`;
}

// 生成参数默认值：设置页的 vs_web_config 优先，其余取旧默认
function defaultParams(web) {
  return {
    model: web.videoModel || 'seedance', resolution: web.resolution || '1080p', preset: web.preset || 'final',
    clipCount: 4, clipDuration: 5,
    transition: true, transitionDuration: 0.4, transitionType: 'fade', colorMatch: false,
    bgm: true, bgmMode: 'auto', wantMusic: true, wantAmb: false, startTrack: '', ambTrack: ''
  };
}

export function CreateWizard({ onChanged }) {
  const web = readWebConfig();
  // 草稿：上次没做完的向导状态（切页 / 刷新后恢复；见 ../createDraft.js）
  const [restored, setRestored] = useState(() => loadDraft());
  // 从照片库带进来的图（照片页点「用它生成视频」后写入，进入这里取走一次）
  const [seedPhoto] = useState(() => takeSeedPhoto());
  const [seedNotice, setSeedNotice] = useState('');
  const [step, setStep] = useState(() => {
    const n = Number(restored && restored.step);
    return Number.isFinite(n) ? Math.max(0, Math.min(STEPS.length - 1, n)) : 0;
  });
  const [prompt, setPrompt] = useState(() => (restored && typeof restored.prompt === 'string' ? restored.prompt : ''));
  const [vprompt, setVprompt] = useState(() => (restored && typeof restored.vprompt === 'string' ? restored.vprompt : ''));
  const [p, setP] = useState(() => ({
    ...defaultParams(web),
    ...(restored && restored.params && typeof restored.params === 'object' ? restored.params : {})
  }));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [big, setBig] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optErr, setOptErr] = useState('');
  const [tracks, setTracks] = useState([]);
  const [imgStatus, setImgStatus] = useState(null);
  // 出图状态放在模块里（见 ../createDraft.js）：生成中切走再回来，结果不丢
  const [imgState, setImgState] = useState(() => getImageState());
  const [imgErrLocal, setImgErrLocal] = useState(''); // local validation error only (no API call)
  const imgResult = imgState.result;
  const imgBusy = imgState.busy;
  const imgErr = imgErrLocal || imgState.error;
  const [est, setEst] = useState(null); // cost estimate (/api/estimate, same source as /api/pricing)
  const [customStages, setCustomStages] = useState(() => (restored && Array.isArray(restored.customStages)
    ? restored.customStages : ALL_STAGE_KEYS.slice()));
  const [strictQc, setStrictQc] = useState(() => (restored && Array.isArray(restored.strictQc)
    ? restored.strictQc : HARD_QC_KEYS.slice()));
  // 图生视频（2026-11-11 用户口径）：第③步通过的图默认拿去生成视频
  const [useImage, setUseImage] = useState(() => (restored && typeof restored.useImage === 'boolean'
    ? restored.useImage : true));

  // 有实质内容才提示「已恢复」：只改过参数不算（参数本来就来自设置页）
  const restoredHint = !!(restored && (restored.prompt || restored.vprompt || (restored.image && restored.image.url)));

  // 任何改动都落草稿：切到别的页面 / F5 回来还在（Key 不进草稿）
  useEffect(() => {
    saveDraft({ step, prompt, vprompt, params: p, customStages, strictQc, useImage });
  }, [step, prompt, vprompt, p, customStages, strictQc, useImage]);

  useEffect(() => onImageState(setImgState), []);

  // 照片库带入的图：放进当前图、跳到第③步确认；画面提示词只存在图里，提交时才拼
  const seedApplied = useRef(false);
  useEffect(() => {
    if (!seedPhoto || seedApplied.current) return;
    seedApplied.current = true;
    try {
      adoptPhoto(seedPhoto);
      setImgState(getImageState());
      // 画面基准只在提交时自动拼到视频提示词前面，不写进主提示词（避免和运动描述打架）
      setStep(2);
      setSeedNotice(seedPhoto.id || '');
    } catch (e) {
      setImgErrLocal(tr('create.errors.seedFailed') + e.message);
    }
  }, []);

  // 多行模式：行数即片段数（覆盖段数设置）
  const promptLines = splitPromptLines(prompt);
  const isMultiPrompt = promptLines.length > 1;
  const effectiveClips = isMultiPrompt ? promptLines.length : p.clipCount;

  // 图生视频：服务端 /api/image-gen/status 返回已实现的视频模型清单
  const i2vModels = (imgStatus && Array.isArray(imgStatus.i2vModels)) ? imgStatus.i2vModels : [];
  const i2vSupported = !!(imgResult && imgResult.photoId && i2vModels.includes(p.model));

  // 自定义环节 / 质检严格度（nsfw 永远要紧，取消不生效）
  const toggleStage = (key, on) => setCustomStages((list) => (on
    ? Array.from(new Set([...list, key]))
    : list.filter((k) => k !== key)));
  const toggleQc = (key, on) => setStrictQc((list) => {
    if (key === 'nsfw') return list.includes('nsfw') ? list : [...list, 'nsfw'];
    return on ? Array.from(new Set([...list, key])) : list.filter((k) => k !== key);
  });

  useEffect(() => promptBus.on((text) => setPrompt(text)), []);

  useEffect(() => {
    fetch('/api/image-gen/status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setImgStatus(j); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/bgm', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && Array.isArray(j.tracks)) setTracks(j.tracks); })
      .catch(() => {});
  }, []);

  // 费用预估：进入确认页或参数变化时重算（服务端同一份价目表）
  useEffect(() => {
    if (step !== 5) return;
    let alive = true;
    let modelId = '';
    try { modelId = JSON.parse(localStorage.getItem('vs_config') || '{}').seedanceModel || ''; } catch (e) {}
    fetch('/api/estimate', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model, resolution: p.resolution,
        clipDuration: p.clipDuration, clipCount: effectiveClips, modelId
      })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setEst(j); })
      .catch(() => {});
    return () => { alive = false; };
  }, [step, p.model, p.resolution, p.clipDuration, effectiveClips]);

  async function optimize() {
    setOptErr('');
    if (!prompt.trim()) { setOptErr(tr('create.errors.optimizeEmpty')); return; }
    setOptimizing(true);
    try {
      let cfg = {};
      try { cfg = JSON.parse(localStorage.getItem('vs_config') || '{}'); } catch { cfg = {}; }
      const r = await fetch('/api/optimize-prompt', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          llmApiKey: cfg.llmKey || '',
          llmBaseUrl: cfg.llmUrl || '',
          llmModel: cfg.llmModel || ''
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      const out = j.optimizedPrompt || j.prompt || j.optimized || j.result || '';
      if (out && typeof out === 'string') setPrompt(out);
      else setOptErr(tr('create.errors.optimizeNoResult'));
    } catch (e) {
      setOptErr(tr('create.errors.optimizeFailed', { msg: e.message }));
    } finally {
      setOptimizing(false);
    }
  }

  const restoredAt = restored && restored.savedAt ? new Date(restored.savedAt) : null;
  const restoredAtText = restoredAt && !Number.isNaN(restoredAt.getTime())
    ? String(restoredAt.getHours()).padStart(2, '0') + ':' + String(restoredAt.getMinutes()).padStart(2, '0')
    : '';

  // 清空草稿：回到全新的向导（不删已生成的图片文件，只清界面状态）
  function resetAll() {
    clearDraft();
    setRestored(null);
    setStep(0);
    setPrompt('');
    setVprompt('');
    setP(defaultParams(web));
    setCustomStages(ALL_STAGE_KEYS.slice());
    setStrictQc(HARD_QC_KEYS.slice());
    setImgErrLocal('');
    setOptErr('');
    setErr('');
  }

  async function genTestImage() {
    setImgErrLocal('');
    if (!prompt.trim()) { setImgErrLocal(tr('create.errors.imagePromptRequired')); return; }
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem('vs_config') || '{}'); } catch { cfg = {}; }
    const st = imgStatus;
    // 出图任务跑在模块里：这里 await 只是为了按钮状态，切页也不影响结果落草稿
    await startImage({
      prompt: prompt.trim(),
      size: cfg.imageSize || (st && st.imageGen ? st.imageGen.size : undefined),
      cfg: {
        apiKey: cfg.imageKey || '',
        baseUrl: cfg.imageBaseUrl || '',
        model: cfg.imageModel || '',
        provider: cfg.imageProvider || ''
      }
    });
  }

  // 审核状态写回图片库：第③步的「通过 / 打回」必须落库，
  // 否则图生视频时后端会以「尚未通过审核」拒绝（状态是唯一依据）。
  async function reviewPhoto(status) {
    if (!imgResult || !imgResult.photoId) return;
    try {
      const r = await fetch('/api/photos/' + encodeURIComponent(imgResult.photoId), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
    } catch (e) {
      setImgErrLocal(tr('create.errors.reviewFailed') + e.message);
    }
  }

  const totalSec = (effectiveClips * p.clipDuration -
    (p.transition ? p.transitionDuration * (effectiveClips - 1) : 0));

  function set(k, v) { setP((s) => ({ ...s, [k]: v })); }

  async function submit() {
    setErr('');
    if (!prompt.trim()) { setErr(tr('create.errors.emptyPrompt')); setStep(0); return; }

    // 图生视频（2026-11-11 用户口径）：第③步通过 + 勾选「用这张图」→ 把图片库 id 交给后端。
    // 没有已实现的通道就明确拦下，绝不静默退回文字生成。
    const wantImage = !!(imgResult && imgResult.photoId && useImage);
    if (wantImage && !i2vSupported) {
      setErr(tr('create.errors.i2vUnsupported', { model: p.model, models: i2vModels.join(' / ') || tr('create.errors.noModels') }));
      return;
    }
    if (wantImage && isMultiPrompt) {
      setErr(tr('create.errors.i2vMultiPrompt'));
      return;
    }

    // 余额守门（旧版口径）：预计花费 > 余额 → 直接拦截，不发请求；余额留空 = 不拦截
    const balance = readBalance();
    if (est && est.estimate > 0 && Number.isFinite(balance) && balance > 0 && est.estimate > balance) {
      setErr(tr('create.errors.balanceBlocked', { estimate: est.estimate.toFixed(2), balance: balance.toFixed(2) }));
      return;
    }

    setSubmitting(true);
    try {
      const rt = collectRuntime(p.model);
      // 提示词组装（2026-11-11 用户口径）：
      //   图生视频 = 画面基准（图片提示词）。运动描述（主提示词 + 运镜）
      //   文生视频 = 运动描述（主提示词 + 运镜）
      const motionText = [prompt.trim(), vprompt.trim()].filter(Boolean).join('，');
      const imageBase = (imgResult && imgResult.imagePrompt ? String(imgResult.imagePrompt) : '').trim();
      const composedPrompt = wantImage
        ? [imageBase, motionText].filter(Boolean).join('。')
        : motionText;
      if (!composedPrompt) { setErr(tr('create.errors.emptyPrompt')); setSubmitting(false); return; }
      if (wantImage && imageBase) {
        const conflict = findPromptConflict(imageBase, motionText);
        if (conflict && !window.confirm(tr('create.conflict.confirm', { conflict }))) {
          setSubmitting(false);
          return;
        }
      }
      const body = {
        // 多行模式：prompts 数组（每行一个场景）；单行/图生视频用拼好的 composedPrompt
        ...(isMultiPrompt
          ? { prompts: promptLines.map((l) => (vprompt.trim() ? l + '，' + vprompt.trim() : l)) }
          : { prompt: composedPrompt }),
        // 图生视频额外带上「纯运动描述」，图片库分开存，不覆盖画面提示词
        ...(wantImage ? { sourcePhotoMotionPrompt: motionText } : {}),
        model: p.model,
        resolution: p.resolution,
        preset: p.preset,
        // 自定义档才发送 stages；其它档位沿用预设（后端 resolveStages 负责补依赖/强制核心）
        ...(p.preset === 'custom' ? { stages: customStages.filter((k) => ALL_STAGE_KEYS.includes(k)) } : {}),
        strictQcItems: strictQc.filter((k) => ALL_QC_KEYS.includes(k)),
        // 用户口径（2026-11-12）：不许质检逼模型自动重生成；失败只报清单，由用户决定。
        autoRetry: false,
        clipCount: effectiveClips,
        totalClips: effectiveClips,
        clipDuration: p.clipDuration,
        // 图生视频：带图片库条目 id（后端会校验存在 + 已通过审核 + 模型有已实现通道）
        ...(wantImage ? { sourcePhotoId: imgResult.photoId } : {}),
        transition: p.transition
          ? { enabled: true, duration: p.transitionDuration, type: p.transitionType }
          : { enabled: false },
        colorMatch: { enabled: p.colorMatch },
        bgm: {
          enabled: p.bgmMode !== 'none',
          mode: p.bgmMode,
          wantMusic: p.wantMusic,
          wantAmbient: p.wantAmb,
          startTrackId: p.startTrack || null,
          ambientTrackId: p.ambTrack || null
        },
        ...rt
      };
      let r = await fetch('/api/tasks', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let j = await r.json().catch(() => ({}));
      // 重复提交拦截（服务端 409）：给一次显式确认，确认后带 force 再发一次。
      // 默认不自动重发——账单事故就是「点一次落多个任务」，这里必须由人确认。
      if (!r.ok && j.code === 'DUPLICATE_TASK'
        && window.confirm(j.error + tr('create.errors.duplicateConfirm'))) {
        body.force = true;
        r = await fetch('/api/tasks', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        j = await r.json().catch(() => ({}));
      }
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      if (onChanged) onChanged();
      // 提交成功后草稿回到第①步：回「创作」不会停在第⑥步被误当新任务再提交一次
      saveDraft({ step: 0 });
      navigate('/gen');
    } catch (e) {
      setErr(e.message || tr('create.errors.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  const body = (() => {
    if (step === 0) {
      return html`
        <${Section} title=${tr('create.p0.title')}
          extra=${html`<button onClick=${() => navigate('/templates')}
            className="text-[11px] text-accent underline">${tr('create.p0.template')}</button>`}>
          <textarea
            value=${prompt}
            onInput=${(e) => setPrompt(e.target.value)}
            rows=${big ? 18 : 8}
            placeholder=${tr('create.p0.placeholder')}
            className="w-full resize-y rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5
                       text-[14px] leading-[1.75] text-ink outline-none placeholder:text-ink3
                       focus:border-accent/40"
          ></textarea>
          <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
            ${tr('create.p0.hint')}
            ${isMultiPrompt ? html`<span className="text-accent">${tr('create.p0.multiStatus', { lines: promptLines.length, clips: promptLines.length })}</span>` : null}
          </p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button onClick=${optimize} disabled=${optimizing}
              className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                         hover:bg-white/[.06] disabled:opacity-40"
            >${optimizing ? tr('create.p0.optimizing') : tr('create.p0.smartOptimize')}</button>
            <button onClick=${() => setBig((v) => !v)}
              className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                         hover:bg-white/[.06]"
            >${big ? tr('create.p0.collapse') : tr('create.p0.expand')}</button>
            <span className="text-[11px] text-ink3">${tr('create.p0.charCount', { n: prompt.length })}</span>
            <span className="flex-1"></span>
            <button onClick=${() => navigate('/templates')}
              className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-accent
                         hover:bg-white/[.06]">${tr('create.p0.templateLink')}</button>
          </div>
          ${optErr && html`<p className="mt-1.5 text-[11px] text-danger">${optErr}</p>`}
        </${Section}>
      `;
    }

    if (step === 1) {
      const st = imgStatus;
      let localImg = {};
      try { localImg = JSON.parse(localStorage.getItem('vs_config') || '{}'); } catch { localImg = {}; }
      const hasLocalImgKey = !!String(localImg.imageKey || '').trim();
      const providerOk = !!(st && st.providerImplemented);
      const ready = providerOk && ((st && st.usable) || hasLocalImgKey);
      const keyLabel = st && st.usable
        ? tr('create.p1.keyServer')
        : (hasLocalImgKey ? tr('create.p1.keyLocal') : tr('create.p1.keyNone'));
      return html`
        <${Section} title=${tr('create.p1.title')}>
          ${!st && html`
            <div className="rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5">
              <p className="text-[12px] text-ink2">${tr('create.p1.reading')}</p>
            </div>
          `}
          ${st && html`
            <div className=${'rounded-[6px] border px-3 py-2.5 ' +
              (ready ? 'border-accent/30 bg-accent/[.05]' : 'border-warn/30 bg-warn/[.06]')}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-num text-[12px] text-ink">${st.imageGen.provider} / ${st.imageGen.model}</span>
                <span className=${'text-[11px] ' + (ready ? 'text-accent' : 'text-warn')}>
                  ${ready ? tr('create.p1.ready') : tr('create.p1.notReady')}
                </span>
                <span className="text-[11px] text-ink3">${tr('create.p1.size', { size: st.imageGen.size })}</span>
                <span className="text-[11px] text-ink3">${keyLabel}</span>
              </div>
              ${!ready && html`<p className="mt-1.5 text-[11px] leading-[1.7] text-warn">
                ${providerOk
                  ? (hasLocalImgKey ? tr('create.p1.serverDisabled') : (st.hint || tr('create.p1.serverDisabled')))
                  : tr('create.p1.adapterMissing')}
              </p>`}
              ${ready && html`<p className="mt-1.5 text-[11px] leading-[1.7] text-ink2">
                ${tr('create.p1.readyNote')}
              </p>`}
              ${ready && html`<p className="mt-1 text-[11px] leading-[1.7] text-ink3">
                ${tr('create.p1.historyNote')}
              </p>`}
            </div>
          `}
          ${ready && html`
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button onClick=${genTestImage} disabled=${imgBusy}
                className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px] disabled:opacity-40"
              >${imgBusy ? tr('create.p1.generateBusy') : tr('create.p1.generateOne')}</button>
              <span className="text-[11px] text-ink3">${tr('create.p1.billing')}</span>
            </div>
          `}
          ${imgErr && html`<p className="mt-2 text-[11px] text-danger">${imgErr}</p>`}
          ${imgResult && html`
            <div className="mt-3 rounded-[6px] border border-white/[.09] bg-s2 p-2.5">
              <img src=${imgResult.url} alt=${tr('create.p1.alt')}
                className="max-h-[260px] rounded-[4px] border border-white/[.08]" />
              <p className="mt-1.5 text-[11px] text-ink3 font-num">
                ${imgResult.width} × ${imgResult.height} · ${imgResult.model} · ${imgResult.url}
              </p>
              ${imgResult.prompt && imgResult.prompt !== prompt.trim() && html`
                <p className="mt-1.5 text-[11px] leading-[1.7] text-warn">
                  ${tr('create.p1.stalePrompt')}
                </p>
              `}
            </div>
          `}
          <div className="mt-3">
            <${Info}>${tr('create.p1.info')}</${Info}>
          </div>
        </${Section}>
      `;
    }

    if (step === 2) {
      return html`
        <${Section} title=${tr('create.p2.title')}>
          ${!imgResult && !imgBusy && html`
            <div className="rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5">
              <p className="text-[12px] text-ink2">${tr('create.p2.noImage')}</p>
              <button onClick=${genTestImage}
                className="mt-2 h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]"
              >${tr('create.p2.generateOne')}</button>
            </div>
          `}
          ${imgBusy && html`<p className="text-[12px] text-ink2">${tr('create.p2.generating')}</p>`}
          ${imgErr && html`<p className="mt-2 text-[11px] text-danger">${imgErr}</p>`}
          ${!imgBusy && imgResult && imgResult.url && html`
            <div className="rounded-[6px] border border-white/[.09] bg-s2 p-2.5">
              <img src=${imgResult.url} alt=${tr('create.p2.alt')}
                className="max-h-[380px] rounded-[4px] border border-white/[.08]" />
              <p className="mt-1.5 text-[11px] text-ink3 font-num">
                ${imgResult.width} × ${imgResult.height} · ${imgResult.model}${imgResult.size ? ' · ' + imgResult.size : ''}
              </p>
              ${imgResult.prompt && imgResult.prompt !== prompt.trim() && html`
                <p className="mt-1.5 text-[11px] leading-[1.7] text-warn">
                  ${tr('create.p1.stalePrompt')}
                </p>
              `}
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button onClick=${async () => { await reviewPhoto('approved'); setStep(3); }}
                className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]"
              >${tr('create.p2.approve')}</button>
              <button onClick=${async () => { await reviewPhoto('rejected'); await genTestImage(); }}
                className="h-8 px-3 rounded-[6px] border border-white/[.12] text-ink text-[12px]"
              >${tr('create.p2.reject')}</button>
              <span className="text-[11px] text-ink3">${tr('create.p2.note')}</span>
            </div>
          `}
        </${Section}>
      `;
    }

    if (step === 3) {
      return html`
        <${Section} title=${tr('create.p3.title')} extra=${html`<${Info}>${tr('create.p3.info')}</${Info}>`}>
          <textarea
            value=${vprompt}
            onInput=${(e) => setVprompt(e.target.value)}
            rows="4"
            placeholder=${tr('create.p3.placeholder')}
            className="w-full resize-y rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5
                       text-[13.5px] leading-[1.7] text-ink outline-none placeholder:text-ink3
                       focus:border-accent/40"
          ></textarea>
          <p className="mt-2 text-[11px] text-ink3">
            ${tr('create.p3.note')}
          </p>
        </${Section}>
      `;
    }

    if (step === 4) {
      return html`
        <${Section} title=${tr('create.p4.durationTitle')}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[12px] text-ink2 w-[70px]">${tr('create.p4.clipDuration')}</span>
            <input type="number" min="2" max="30" value=${p.clipDuration}
              onChange=${(e) => set('clipDuration', Number(e.target.value) || 5)}
              className="h-8 w-[86px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink font-num outline-none" />
            <span className="text-[11px] text-ink3">${tr('create.p4.seconds')}</span>
            ${[5, 10, 15].map((d) => html`
              <button key=${d} onClick=${() => set('clipDuration', d)}
                className=${'h-7 px-2 rounded-[5px] text-[11px] border ' +
                  (p.clipDuration === d ? 'border-accent/50 text-accent' : 'border-white/[.09] text-ink2 hover:bg-white/[.05]')}
              >${d}s</button>`)}
          </div>
          <div className="mt-2.5 flex items-center gap-3 flex-wrap">
            <span className="text-[12px] text-ink2 w-[70px]">${tr('create.p4.clipCount')}</span>
            <input type="number" min="1" max="100" value=${p.clipCount}
              onChange=${(e) => set('clipCount', Number(e.target.value) || 4)}
              className="h-8 w-[86px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink font-num outline-none" />
            ${[4, 10, 20].map((n) => html`
              <button key=${n} onClick=${() => set('clipCount', n)}
                className=${'h-7 px-2 rounded-[5px] text-[11px] border ' +
                  (p.clipCount === n ? 'border-accent/50 text-accent' : 'border-white/[.09] text-ink2 hover:bg-white/[.05]')}
              >${tr('create.p4.clipsUnit', { n })}</button>`)}
          </div>
          ${isMultiPrompt && html`
            <p className="mt-2 text-[11px] leading-[1.7] text-warn">
              ${tr('create.p4.multiOverride', { n: promptLines.length })}
            </p>
          `}
          <p className="mt-2 text-[12px] text-ink2 font-num">${tr('create.p4.totalSec', { sec: totalSec.toFixed(1) })}</p>
        </${Section}>

        <div className="mt-4">
          <${Section} title=${tr('create.p4.bgmTitle')}>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[12px] text-ink2 w-[70px]">${tr('create.p4.bgmMode')}</span>
              <select value=${p.bgmMode} onChange=${(e) => set('bgmMode', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                <option value="auto">${tr('create.p4.auto')}</option>
                <option value="manual">${tr('create.p4.manual')}</option>
                <option value="none">${tr('create.p4.none')}</option>
              </select>
            </div>
            ${p.bgmMode !== 'none' && html`
              <div className="mt-2 flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-2 text-[12px] text-ink">
                  <input type="checkbox" checked=${p.wantMusic}
                    onChange=${(e) => set('wantMusic', e.target.checked)}
                    className="w-[15px] h-[15px] accent-accent" />
                  ${tr('create.p4.wantMusic')}
                </label>
                <label className="flex items-center gap-2 text-[12px] text-ink">
                  <input type="checkbox" checked=${p.wantAmb}
                    onChange=${(e) => set('wantAmb', e.target.checked)}
                    className="w-[15px] h-[15px] accent-accent" />
                  ${tr('create.p4.wantAmbient')}
                </label>
              </div>
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                <span className="text-[12px] text-ink2 w-[70px]">${tr('create.p4.startTrack')}</span>
                <select value=${p.startTrack} onChange=${(e) => set('startTrack', e.target.value)}
                  className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                  <option value="">${tr('create.p4.defaultTrack')}</option>
                  ${tracks.map((t) => html`<option key=${t.id} value=${t.id}>${t.title || t.id}</option>`)}
                </select>
                <span className="text-[12px] text-ink2 w-[70px]">${tr('create.p4.ambTrack')}</span>
                <select value=${p.ambTrack} onChange=${(e) => set('ambTrack', e.target.value)}
                  className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                  <option value="">${tr('create.p4.noTrack')}</option>
                  ${tracks.map((t) => html`<option key=${t.id} value=${t.id}>${t.title || t.id}</option>`)}
                </select>
              </div>
            `}
            <p className="mt-2 text-[11px] text-ink3">
              ${tr('create.p4.bgmNote')}
            </p>
          </${Section}>
        </div>
      `;
    }

    if (step === 5) {
      return html`
        <${Section} title=${tr('create.p5.transitionTitle')}>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked=${p.transition} onChange=${(e) => set('transition', e.target.checked)}
              className="w-[15px] h-[15px] accent-accent" />
            ${tr('create.p5.crossfade')}
          </label>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-ink2">${tr('create.p5.each')}</span>
            <input type="number" step="0.1" min="0.1" max="2" value=${p.transitionDuration}
              onChange=${(e) => set('transitionDuration', Number(e.target.value) || 0.4)}
              className="h-8 w-[76px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink font-num outline-none" />
            <span className="text-[11px] text-ink3">${tr('create.p5.seconds')}</span>
            <span className="text-[12px] text-ink2 ml-2">${tr('create.p5.transitionType')}</span>
            <select value=${p.transitionType} onChange=${(e) => set('transitionType', e.target.value)}
              className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
              <option value="fade">${tr('create.p5.fade')}</option>
              <option value="black">${tr('create.p5.black')}</option>
              <option value="cut">${tr('create.p5.cut')}</option>
            </select>
          </div>
          <label className="mt-2.5 flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked=${p.colorMatch}
              onChange=${(e) => {
                const on = e.target.checked;
                setP((s) => ({ ...s, colorMatch: on, transition: on ? true : s.transition }));
              }}
              className="w-[15px] h-[15px] accent-accent" />
            ${tr('create.p5.colorMatch')}
          </label>
          <p className="mt-1.5 text-[11px] text-ink3">${tr('create.p5.colorMatchHint')}</p>
        </${Section}>

        <div className="mt-4">
          <${Section} title=${tr('create.p5.i2vTitle')}
            extra=${html`<${Info}>${tr('create.p5.i2vInfo')}${imgResult && imgResult.photoId ? '' : tr('create.p5.noPhotoSuffix')}</${Info}>`}>
            ${imgResult && imgResult.photoId ? html`
              <label className="flex items-center gap-2 text-[12px] text-ink">
                <input type="checkbox" checked=${useImage}
                  onChange=${(e) => setUseImage(e.target.checked)}
                  className="w-[15px] h-[15px] accent-accent" />
                ${tr('create.p5.useImage', { id: imgResult.photoId })}
              </label>
              <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
                ${i2vSupported
                  ? tr('create.p5.modelHasChannel', { model: p.model })
                  : tr('create.p5.modelNoChannel', { model: p.model, models: i2vModels.join(' / ') || tr('create.errors.noModels') })}
              </p>
              ${i2vSupported && p.model === 'openai-video' && html`
                <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
                  ${tr('create.p5.whaleNote')}
                </p>
              `}
              ${useImage && !i2vSupported && html`
                <p className="mt-1.5 text-[12px] text-warn">${tr('create.p5.switchModel')}</p>
              `}
            ` : html`
              <p className="text-[11px] leading-[1.7] text-ink3">
                ${tr('create.p5.noPhotoRecord')}
              </p>
            `}
          </${Section}>
        </div>

        <div className="mt-4">
          <${Section} title=${tr('create.p5.genParamsTitle')}
            extra=${html`<${Info}>${tr('create.p5.genParamsInfo')}</${Info}>`}>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[12px] text-ink2 w-[70px]">${tr('create.p5.model')}</span>
              <select value=${p.model} onChange=${(e) => set('model', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                <option value="seedance">Seedance 2.5</option>
                <option value="kling">${tr('settings.group.kling')}</option>
                <option value="dashscope">${tr('settings.group.dashscope')}</option>
                <option value="openai-video">${tr('settings.group.whaletv')}</option>
              </select>
              <span className="text-[12px] text-ink2 w-[54px]">${tr('create.p5.resolution')}</span>
              <select value=${p.resolution} onChange=${(e) => set('resolution', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                ${['720p', '1080p', '4K'].map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
              </select>
              <span className="text-[12px] text-ink2 w-[40px]">${tr('create.p5.preset')}</span>
              <select value=${p.preset} onChange=${(e) => set('preset', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                ${['final', 'daily', 'quick', 'clips_only'].map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
                <option value="custom">${tr('create.p5.customOption')}</option>
              </select>
            </div>
            ${p.preset === 'custom' && html`
              <div className="mt-2">
                <div className="text-[11px] text-ink3 mb-1">${tr('create.p5.customStagesHint')}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  ${STAGE_OPTS.map((s) => html`
                    <label key=${s.key} className="flex items-center gap-1.5 text-[11px] text-ink2">
                      <input type="checkbox"
                        checked=${s.core || customStages.includes(s.key)}
                        disabled=${s.core}
                        onChange=${(e) => toggleStage(s.key, e.target.checked)}
                        className="w-[13px] h-[13px] accent-accent" />
                      ${tr(s.nameKey)}
                    </label>
                  `)}
                </div>
              </div>
            `}
            <div className="mt-2">
              <div className="text-[11px] text-ink3 mb-1">${tr('create.p5.qcHint')}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                ${QC_OPTS.map((q) => html`
                  <label key=${q.key} className="flex items-center gap-1.5 text-[11px] text-ink2">
                    <input type="checkbox"
                      checked=${q.key === 'nsfw' || strictQc.includes(q.key)}
                      disabled=${q.key === 'nsfw'}
                      onChange=${(e) => toggleQc(q.key, e.target.checked)}
                      className="w-[13px] h-[13px] accent-accent" />
                    ${tr(q.nameKey)}
                  </label>
                `)}
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-[1.7] text-ink3">
              ${tr('create.p5.modelNote')}
            </p>
          </${Section}>
        </div>

        <div className="mt-4">
          <${Section} title=${tr('create.p5.confirmTitle')}>
            <dl className="grid grid-cols-[92px_1fr] gap-y-1.5 text-[12px]">
              <dt className="text-ink3">${tr('create.p5.promptLabel')}</dt><dd className="text-ink break-words">${prompt || tr('create.p5.unfilled')}</dd>
              <dt className="text-ink3">${tr('create.p5.motionLabel')}</dt><dd className="text-ink break-words">${vprompt || tr('create.p5.unfilled')}</dd>
              <dt className="text-ink3">${tr('create.p5.modelLabel')}</dt><dd className="text-ink">${p.model}</dd>
              <dt className="text-ink3">${tr('create.p5.resolutionLabel')}</dt><dd className="text-ink">${p.resolution}</dd>
              <dt className="text-ink3">${tr('create.p5.presetLabel')}</dt><dd className="text-ink">${p.preset}</dd>
              <dt className="text-ink3">${tr('create.p5.clipsLabel')}</dt><dd className="text-ink">${tr('create.p5.clipsSummary', { n: effectiveClips, dur: p.clipDuration })}${isMultiPrompt ? tr('create.p5.multiScenesSuffix', { n: promptLines.length }) : ''}</dd>
              <dt className="text-ink3">${tr('create.p5.finalLabel')}</dt><dd className="text-ink">${tr('create.p5.finalDuration', { sec: totalSec.toFixed(1) })}</dd>
              <dt className="text-ink3">${tr('create.p5.costLabel')}</dt>
              <dd className="text-ink font-num">
                ${est
                  ? (est.estimate > 0 ? tr('create.p5.approx', { amount: Number(est.estimate).toFixed(2) }) : tr('create.p5.freeMock'))
                  : tr('create.p5.calculating')}
                ${est && est.usd > 0 ? tr('create.p5.usdSuffix', { amount: Number(est.usd).toFixed(2) }) : ''}
                ${Number.isFinite(readBalance()) && readBalance() > 0
                  ? tr('create.p5.balanceSuffix', { amount: readBalance().toFixed(2) })
                  : ''}
                ${est && est.budget ? tr('create.p5.serverBalanceSuffix', { amount: Number(est.budget.balanceUsd).toFixed(2) }) : ''}
              </dd>
              <dt className="text-ink3">${tr('create.p5.bgmLabel')}</dt>
              <dd className="text-ink">
                ${p.bgmMode === 'none' ? tr('create.p5.bgmNone')
                  : p.bgmMode + (p.wantMusic ? tr('create.p5.bgmMusic') : '') + (p.wantAmb ? tr('create.p5.bgmAmbient') : '')}
              </dd>
              <dt className="text-ink3">${tr('create.p5.transitionLabel')}</dt>
              <dd className="text-ink">
                ${p.transition
                  ? (p.transitionType === 'fade' ? tr('create.p5.fade') : (p.transitionType === 'black' ? tr('create.p5.black') : tr('create.p5.cut'))) +
                    ' ' + p.transitionDuration + 's'
                  : tr('create.p5.cut')}
                ${p.colorMatch ? tr('create.p5.colorMatchOn') : ''}
              </dd>
            </dl>
            ${Number.isFinite(readBalance()) && readBalance() > 0 && est && est.estimate > readBalance() && html`
              <p className="mt-2 text-[12px] text-danger">
                ${tr('create.p5.overBalance', { estimate: Number(est.estimate).toFixed(2), balance: readBalance().toFixed(2) })}
              </p>
            `}
            ${est && est.budget && est.budget.affordable === false && html`
              <p className="mt-2 text-[12px] text-danger">
                ${tr('create.p5.budgetShort', { usd: Number(est.usd).toFixed(2), balance: Number(est.budget.balanceUsd).toFixed(2) })}
              </p>
            `}
            ${err && html`<p className="mt-2 text-[12px] text-danger">${err}</p>`}
          </${Section}>
        </div>
      `;
    }

    return null;
  })();

  return html`
    <div className="mx-auto w-full max-w-[1040px] px-7 py-6">
      <div className="flex items-center gap-0 overflow-x-auto pb-3">
        ${STEPS.map((s, i) => html`
          <div key=${s} className="flex items-center gap-1.5 pr-3 whitespace-nowrap">
            <span className=${'w-[19px] h-[19px] rounded-full grid place-items-center text-[10px] font-num ' +
              (i < step ? 'bg-accent text-onaccent' : (i === step ? 'bg-accent text-onaccent' : 'bg-s2 text-ink3 border border-white/[.09]'))}>
              ${i < step ? '✓' : (i + 1)}
            </span>
            <span className=${'text-[12px] ' + (i === step ? 'text-ink' : 'text-ink3')}>${tr(s)}</span>
            ${i < STEPS.length - 1 && html`<span className="w-4 h-px bg-white/[.10] ml-1.5"></span>`}
          </div>
        `)}
      </div>

      ${seedNotice && html`
        <div className="mb-2 flex items-center gap-2 flex-wrap rounded-[6px] border border-accent/25 bg-accent/[.06] px-3 py-2">
          <span className="text-[11px] text-accent">
            ${tr('create.seedNotice', { id: seedNotice })}
          </span>
        </div>
      `}

      ${restoredHint && html`
        <div className="mb-2 flex items-center gap-2 flex-wrap rounded-[6px] border border-accent/25 bg-accent/[.06] px-3 py-2">
          <span className="text-[11px] text-accent">
            ${tr('create.draft.restored')}${restoredAtText ? tr('create.draft.savedAt', { time: restoredAtText }) : ''}
          </span>
          <span className="flex-1"></span>
          <button onClick=${resetAll}
            className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2 hover:bg-white/[.06]"
          >${tr('create.draft.clear')}</button>
        </div>
      `}

      ${body}

      <div className="mt-6 flex items-center gap-3 border-t border-white/[.08] pt-4">
        <button
          disabled=${step === 0}
          onClick=${() => setStep((s) => Math.max(0, s - 1))}
          className="h-9 px-4 rounded-[6px] border border-white/[.10] text-[13px] text-ink2
                     hover:bg-white/[.05] disabled:opacity-40"
        >${tr('create.nav.prev')}</button>
        <span className="flex-1"></span>
        ${step === STEPS.length - 1
          ? html`<button
              disabled=${submitting}
              onClick=${submit}
              className="h-9 px-4 rounded-[6px] bg-accent text-onaccent text-[13px] disabled:opacity-40"
            >${submitting ? tr('create.nav.submitting') : tr('create.nav.submit')}</button>`
          : html`<button
              onClick=${() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              className="h-9 px-4 rounded-[6px] bg-accent text-onaccent text-[13px]"
            >${tr('create.nav.next')}</button>`}
      </div>
    </div>
  `;
}
