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
// ============================================================
import { navigate } from '../router.js';
import { promptBus } from '../store.js';
import {
  loadDraft, saveDraft, clearDraft,
  getImageState, onImageState, startImage,
  takeSeedPhoto, adoptPhoto
} from '../createDraft.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState, useRef } = React;

const STEPS = ['提示词', '图片生成', '图片审核', '运镜', '时长与配乐', '确认'];

// 8 个执行环节（与 src/pipelineStages.js 的 ALL_STAGES 一致；核心链 3 步锁定必选）
const STAGE_OPTS = [
  { key: 'prompt_optimize', name: '提示词优化', core: true },
  { key: 'storyboard', name: '分镜拆解', core: true },
  { key: 'clip_generation', name: '片段生成', core: true },
  { key: 'concatenation', name: '拼接' },
  { key: 'loop_processing', name: '无缝循环' },
  { key: 'audio_mix', name: '配乐混音' },
  { key: 'transcoding', name: '转码导出' },
  { key: 'final_qc', name: '最终质检' }
];

// 13 个质检项（与 src/qualityChecker.js 的 QC_ITEMS 一致；nsfw 永远要紧，不可关闭）
const QC_OPTS = [
  { key: 'prompt', name: '提示词质检' },
  { key: 'storyboard', name: '分镜头质检' },
  { key: 'blackFrame', name: '黑帧检测' },
  { key: 'blur', name: '模糊检测' },
  { key: 'duplicate', name: '重复帧检测' },
  { key: 'duration', name: '时长校验' },
  { key: 'nsfw', name: 'NSFW 合规检测' },
  { key: 'concat', name: '拼接质检' },
  { key: 'seam', name: '接缝质量检测' },
  { key: 'colorContinuity', name: '镜头色彩连续性' },
  { key: 'loop', name: '循环质检' },
  { key: 'transcode', name: '转码质检' },
  { key: 'final', name: '最终综合质检' }
];

const ALL_STAGE_KEYS = STAGE_OPTS.map((s) => s.key);
const ALL_QC_KEYS = QC_OPTS.map((q) => q.key);

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
    return { ...base, apiKey: cfg.dashScopeKey || '', modelId: 'wan3.0-video' };
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
  const [imgErrLocal, setImgErrLocal] = useState(''); // 只是本地校验错误（没调接口）
  const imgResult = imgState.result;
  const imgBusy = imgState.busy;
  const imgErr = imgErrLocal || imgState.error;
  const [est, setEst] = useState(null); // 费用预估（/api/estimate，与 /api/pricing 同源）
  const [customStages, setCustomStages] = useState(() => (restored && Array.isArray(restored.customStages)
    ? restored.customStages : ALL_STAGE_KEYS.slice()));
  const [strictQc, setStrictQc] = useState(() => (restored && Array.isArray(restored.strictQc)
    ? restored.strictQc : ALL_QC_KEYS.slice()));
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

  // 照片库带入的图：放进当前图、跳到第③步确认；提示词为空时用图片自己的提示词填上
  const seedApplied = useRef(false);
  useEffect(() => {
    if (!seedPhoto || seedApplied.current) return;
    seedApplied.current = true;
    try {
      const adopted = adoptPhoto(seedPhoto);
      setImgState(getImageState());
      if (!prompt.trim() && seedPhoto.prompt) setPrompt(seedPhoto.prompt);
      setStep(2);
      setSeedNotice(adopted.photoId || seedPhoto.id || '');
    } catch (e) {
      setImgErrLocal('从照片库带入失败：' + e.message);
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
    if (!prompt.trim()) { setOptErr('先写点内容再优化'); return; }
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
      else setOptErr('接口没有返回优化后的提示词');
    } catch (e) {
      setOptErr('优化失败：' + e.message + '（需在设置里配 LLM Key）');
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
    setStrictQc(ALL_QC_KEYS.slice());
    setImgErrLocal('');
    setOptErr('');
    setErr('');
  }

  async function genTestImage() {
    setImgErrLocal('');
    if (!prompt.trim()) { setImgErrLocal('先在第一步写提示词'); return; }
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
      setImgErrLocal('审核状态保存失败：' + e.message);
    }
  }

  const totalSec = (effectiveClips * p.clipDuration -
    (p.transition ? p.transitionDuration * (effectiveClips - 1) : 0));

  function set(k, v) { setP((s) => ({ ...s, [k]: v })); }

  async function submit() {
    setErr('');
    if (!prompt.trim()) { setErr('提示词不能为空'); setStep(0); return; }

    // 图生视频（2026-11-11 用户口径）：第③步通过 + 勾选「用这张图」→ 把图片库 id 交给后端。
    // 没有已实现的通道就明确拦下，绝不静默退回文字生成。
    const wantImage = !!(imgResult && imgResult.photoId && useImage);
    if (wantImage && !i2vSupported) {
      setErr(`当前视频模型「${p.model}」没有已实现的图生视频通道（已实现：${i2vModels.join(' / ') || '暂无'}）。`
        + '请切换模型，或取消勾选「用这张图生成视频」。');
      return;
    }

    // 余额守门（旧版口径）：预计花费 > 余额 → 直接拦截，不发请求；余额留空 = 不拦截
    const balance = readBalance();
    if (est && est.estimate > 0 && Number.isFinite(balance) && balance > 0 && est.estimate > balance) {
      setErr(`已拦截：预计花费 ¥${est.estimate.toFixed(2)} 超过账户余额 ¥${balance.toFixed(2)}。`
        + '请减少片段数或单段时长、降低分辨率，或先到「设置」更新余额。');
      return;
    }

    setSubmitting(true);
    try {
      const rt = collectRuntime(p.model);
      const body = {
        // 多行模式：prompts 数组（每行一个场景，行数即片段数）；单行保持 prompt
        ...(isMultiPrompt ? { prompts: promptLines } : { prompt: prompt.trim() }),
        model: p.model,
        resolution: p.resolution,
        preset: p.preset,
        // 自定义档才发送 stages；其它档位沿用预设（后端 resolveStages 负责补依赖/强制核心）
        ...(p.preset === 'custom' ? { stages: customStages.filter((k) => ALL_STAGE_KEYS.includes(k)) } : {}),
        strictQcItems: strictQc.filter((k) => ALL_QC_KEYS.includes(k)),
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
      const r = await fetch('/api/tasks', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      if (onChanged) onChanged();
      // 提交成功后草稿回到第①步：回「创作」不会停在第⑥步被误当新任务再提交一次
      saveDraft({ step: 0 });
      navigate('/gen');
    } catch (e) {
      setErr(e.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  const body = (() => {
    if (step === 0) {
      return html`
        <${Section} title="提示词"
          extra=${html`<button onClick=${() => navigate('/templates')}
            className="text-[11px] text-accent underline">模板库 →</button>`}>
          <textarea
            value=${prompt}
            onInput=${(e) => setPrompt(e.target.value)}
            rows=${big ? 18 : 8}
            placeholder="例如：清晨的喀斯特峰林，低雾在谷间缓慢流动，侧逆光，长焦压缩，缓慢推近……"
            className="w-full resize-y rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5
                       text-[14px] leading-[1.75] text-ink outline-none placeholder:text-ink3
                       focus:border-accent/40"
          ></textarea>
          <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
            单行 = 单场景 × 段数；<b className="text-ink2">多行 = 每行一个场景（行数覆盖段数设置）</b>；
            行尾可加【主题】标签（如「雪山日出【雪山】」）。
            ${isMultiPrompt ? html`<span className="text-accent"> / 当前 ${promptLines.length} 行 → 将生成 ${promptLines.length} 段</span>` : null}
          </p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button onClick=${optimize} disabled=${optimizing}
              className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                         hover:bg-white/[.06] disabled:opacity-40"
            >${optimizing ? '优化中…' : '✨ 智能优化'}</button>
            <button onClick=${() => setBig((v) => !v)}
              className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                         hover:bg-white/[.06]"
            >${big ? '收起编辑区' : '⤢ 放大编辑'}</button>
            <span className="text-[11px] text-ink3">${prompt.length} 字</span>
            <span className="flex-1"></span>
            <button onClick=${() => navigate('/templates')}
              className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-accent
                         hover:bg-white/[.06]">模板库 →</button>
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
        ? '服务端 Key 已配置'
        : (hasLocalImgKey ? '本机 Key 已填写' : 'Key 未配置');
      return html`
        <${Section} title="图片生成（wan2.7-image）">
          ${!st && html`
            <div className="rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5">
              <p className="text-[12px] text-ink2">正在读取出图配置…</p>
            </div>
          `}
          ${st && html`
            <div className=${'rounded-[6px] border px-3 py-2.5 ' +
              (ready ? 'border-accent/30 bg-accent/[.05]' : 'border-warn/30 bg-warn/[.06]')}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-num text-[12px] text-ink">${st.imageGen.provider} / ${st.imageGen.model}</span>
                <span className=${'text-[11px] ' + (ready ? 'text-accent' : 'text-warn')}>
                  ${ready ? '已就绪' : '未就绪'}
                </span>
                <span className="text-[11px] text-ink3">尺寸 ${st.imageGen.size}</span>
                <span className="text-[11px] text-ink3">${keyLabel}</span>
              </div>
              ${!ready && html`<p className="mt-1.5 text-[11px] leading-[1.7] text-warn">
                ${providerOk
                  ? (hasLocalImgKey ? '服务端未启用图片生成；请检查服务端适配器。' : (st.hint || '出图配置未就绪。'))
                  : '服务端出图适配器未注册。'}
              </p>`}
              ${ready && html`<p className="mt-1.5 text-[11px] leading-[1.7] text-ink2">
                后端已接入。这里只做「单张测试出图」，用来确认 Key 与画质；图片不会自动并入任务。
              </p>`}
              ${ready && html`<p className="mt-1 text-[11px] leading-[1.7] text-ink3">
                已经生成过图？去左侧「照片」页，对那张图点「用它生成视频」，会自动把它带回这里并跳到第③步。
              </p>`}
            </div>
          `}
          ${ready && html`
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button onClick=${genTestImage} disabled=${imgBusy}
                className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px] disabled:opacity-40"
              >${imgBusy ? '生成中…' : '生成 1 张测试图'}</button>
              <span className="text-[11px] text-ink3">会真实调用厂商并计费（1 张）</span>
            </div>
          `}
          ${imgErr && html`<p className="mt-2 text-[11px] text-danger">${imgErr}</p>`}
          ${imgResult && html`
            <div className="mt-3 rounded-[6px] border border-white/[.09] bg-s2 p-2.5">
              <img src=${imgResult.url} alt="生成结果"
                className="max-h-[260px] rounded-[4px] border border-white/[.08]" />
              <p className="mt-1.5 text-[11px] text-ink3 font-num">
                ${imgResult.width} × ${imgResult.height} · ${imgResult.model} · ${imgResult.url}
              </p>
              ${imgResult.prompt && imgResult.prompt !== prompt.trim() && html`
                <p className="mt-1.5 text-[11px] leading-[1.7] text-warn">
                  这张图是按旧提示词出的（当前提示词已改），建议点「打回重做」重新出。
                </p>
              `}
            </div>
          `}
          <div className="mt-3">
            <${Info}>生成后点「下一步」，第③步可以放大看这张图，决定通过（进入运镜）或打回重做。</${Info}>
          </div>
        </${Section}>
      `;
    }

    if (step === 2) {
      return html`
        <${Section} title="图片审核">
          ${!imgResult && !imgBusy && html`
            <div className="rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5">
              <p className="text-[12px] text-ink2">还没有图。可以回上一步生成，或直接在这里生成一张。</p>
              <button onClick=${genTestImage}
                className="mt-2 h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]"
              >生成 1 张</button>
            </div>
          `}
          ${imgBusy && html`<p className="text-[12px] text-ink2">出图中…（会真实调用厂商，计费 1 张）</p>`}
          ${imgErr && html`<p className="mt-2 text-[11px] text-danger">${imgErr}</p>`}
          ${!imgBusy && imgResult && imgResult.url && html`
            <div className="rounded-[6px] border border-white/[.09] bg-s2 p-2.5">
              <img src=${imgResult.url} alt="待审核图片"
                className="max-h-[380px] rounded-[4px] border border-white/[.08]" />
              <p className="mt-1.5 text-[11px] text-ink3 font-num">
                ${imgResult.width} × ${imgResult.height} · ${imgResult.model}${imgResult.size ? ' · ' + imgResult.size : ''}
              </p>
              ${imgResult.prompt && imgResult.prompt !== prompt.trim() && html`
                <p className="mt-1.5 text-[11px] leading-[1.7] text-warn">
                  这张图是按旧提示词出的（当前提示词已改），建议点「打回重做」重新出。
                </p>
              `}
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button onClick=${async () => { await reviewPhoto('approved'); setStep(3); }}
                className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]"
              >通过，继续下一步</button>
              <button onClick=${async () => { await reviewPhoto('rejected'); await genTestImage(); }}
                className="h-8 px-3 rounded-[6px] border border-white/[.12] text-ink text-[12px]"
              >打回重做（只重做这一张）</button>
              <span className="text-[11px] text-ink3">「通过」= 这张图可用于下一步图生视频；打回会再调用 1 次出图（计费 1 张）</span>
            </div>
          `}
        </${Section}>
      `;
    }

    if (step === 3) {
      return html`
        <${Section} title="运镜与动作" extra=${html`<${Info}>只写「怎么动」，画面内容由提示词决定</${Info}>`}>
          <textarea
            value=${vprompt}
            onInput=${(e) => setVprompt(e.target.value)}
            rows="4"
            placeholder="缓慢推近，轻微手持感，雾在流动……"
            className="w-full resize-y rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5
                       text-[13.5px] leading-[1.7] text-ink outline-none placeholder:text-ink3
                       focus:border-accent/40"
          ></textarea>
          <p className="mt-2 text-[11px] text-ink3">
            当前流水线按单条提示词生成，此处的运镜描述会附加到主提示词末尾。
          </p>
        </${Section}>
      `;
    }

    if (step === 4) {
      return html`
        <${Section} title="时长与片段">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[12px] text-ink2 w-[70px]">每段时长</span>
            <input type="number" min="2" max="30" value=${p.clipDuration}
              onChange=${(e) => set('clipDuration', Number(e.target.value) || 5)}
              className="h-8 w-[86px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink font-num outline-none" />
            <span className="text-[11px] text-ink3">秒</span>
            ${[5, 10, 15].map((d) => html`
              <button key=${d} onClick=${() => set('clipDuration', d)}
                className=${'h-7 px-2 rounded-[5px] text-[11px] border ' +
                  (p.clipDuration === d ? 'border-accent/50 text-accent' : 'border-white/[.09] text-ink2 hover:bg-white/[.05]')}
              >${d}s</button>`)}
          </div>
          <div className="mt-2.5 flex items-center gap-3 flex-wrap">
            <span className="text-[12px] text-ink2 w-[70px]">片段数量</span>
            <input type="number" min="1" max="100" value=${p.clipCount}
              onChange=${(e) => set('clipCount', Number(e.target.value) || 4)}
              className="h-8 w-[86px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink font-num outline-none" />
            ${[4, 10, 20].map((n) => html`
              <button key=${n} onClick=${() => set('clipCount', n)}
                className=${'h-7 px-2 rounded-[5px] text-[11px] border ' +
                  (p.clipCount === n ? 'border-accent/50 text-accent' : 'border-white/[.09] text-ink2 hover:bg-white/[.05]')}
              >${n} 段</button>`)}
          </div>
          ${isMultiPrompt && html`
            <p className="mt-2 text-[11px] leading-[1.7] text-warn">
              已输入 ${promptLines.length} 行提示词 → 片段数量按行数生成（${promptLines.length} 段），上面的「片段数量」被覆盖。
            </p>
          `}
          <p className="mt-2 text-[12px] text-ink2 font-num">成片预计 ${totalSec.toFixed(1)} 秒</p>
        </${Section}>

        <div className="mt-4">
          <${Section} title="配乐">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[12px] text-ink2 w-[70px]">配乐模式</span>
              <select value=${p.bgmMode} onChange=${(e) => set('bgmMode', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                <option value="auto">自动（按情绪接续）</option>
                <option value="manual">手动指定</option>
                <option value="none">不加配乐</option>
              </select>
            </div>
            ${p.bgmMode !== 'none' && html`
              <div className="mt-2 flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-2 text-[12px] text-ink">
                  <input type="checkbox" checked=${p.wantMusic}
                    onChange=${(e) => set('wantMusic', e.target.checked)}
                    className="w-[15px] h-[15px] accent-accent" />
                  要音乐
                </label>
                <label className="flex items-center gap-2 text-[12px] text-ink">
                  <input type="checkbox" checked=${p.wantAmb}
                    onChange=${(e) => set('wantAmb', e.target.checked)}
                    className="w-[15px] h-[15px] accent-accent" />
                  要环境音
                </label>
              </div>
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                <span className="text-[12px] text-ink2 w-[70px]">起始曲</span>
                <select value=${p.startTrack} onChange=${(e) => set('startTrack', e.target.value)}
                  className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                  <option value="">（默认）</option>
                  ${tracks.map((t) => html`<option key=${t.id} value=${t.id}>${t.title || t.id}</option>`)}
                </select>
                <span className="text-[12px] text-ink2 w-[70px]">环境音曲</span>
                <select value=${p.ambTrack} onChange=${(e) => set('ambTrack', e.target.value)}
                  className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                  <option value="">（无）</option>
                  ${tracks.map((t) => html`<option key=${t.id} value=${t.id}>${t.title || t.id}</option>`)}
                </select>
              </div>
            `}
            <p className="mt-2 text-[11px] text-ink3">
              曲目与顺序在「库存 → 配乐」里管理；选「不加配乐」则为无声成片。
            </p>
          </${Section}>
        </div>
      `;
    }

    if (step === 5) {
      return html`
        <${Section} title="衔接">
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked=${p.transition} onChange=${(e) => set('transition', e.target.checked)}
              className="w-[15px] h-[15px] accent-accent" />
            片段之间交叉淡化
          </label>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-ink2">每处</span>
            <input type="number" step="0.1" min="0.1" max="2" value=${p.transitionDuration}
              onChange=${(e) => set('transitionDuration', Number(e.target.value) || 0.4)}
              className="h-8 w-[76px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink font-num outline-none" />
            <span className="text-[11px] text-ink3">秒</span>
            <span className="text-[12px] text-ink2 ml-2">转场类型</span>
            <select value=${p.transitionType} onChange=${(e) => set('transitionType', e.target.value)}
              className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
              <option value="fade">交叉淡化</option>
              <option value="black">经黑场过渡</option>
              <option value="cut">直切（不重编码）</option>
            </select>
          </div>
          <label className="mt-2.5 flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked=${p.colorMatch}
              onChange=${(e) => {
                const on = e.target.checked;
                setP((s) => ({ ...s, colorMatch: on, transition: on ? true : s.transition }));
              }}
              className="w-[15px] h-[15px] accent-accent" />
            接缝校色
          </label>
          <p className="mt-1.5 text-[11px] text-ink3">校色依赖转场：打开校色会自动打开转场。</p>
        </${Section}>

        <div className="mt-4">
          <${Section} title="图生视频"
            extra=${html`<${Info}>用第③步通过的那张图作首帧${imgResult && imgResult.photoId ? '' : '（当前没有可用的图片）'}</${Info}>`}>
            ${imgResult && imgResult.photoId ? html`
              <label className="flex items-center gap-2 text-[12px] text-ink">
                <input type="checkbox" checked=${useImage}
                  onChange=${(e) => setUseImage(e.target.checked)}
                  className="w-[15px] h-[15px] accent-accent" />
                用这张图生成视频（图片库：${imgResult.photoId}）
              </label>
              <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
                ${i2vSupported
                  ? `当前模型 ${p.model} 有已实现的图生视频通道。`
                  : `当前模型 ${p.model} 没有已实现的图生视频通道（已实现：${i2vModels.join(' / ') || '暂无'}）。`}
              </p>
              ${i2vSupported && p.model === 'openai-video' && html`
                <p className="mt-1.5 text-[11px] leading-[1.7] text-warn">
                  WhaleTV 走 new-api 的 Sora 格式（multipart <code className="font-num">input_reference</code>）。
                  该中转是否已实现这个字段**未实测**：失败时任务里会显示厂商原文，且这次请求可能已经计费。
                  建议先按 5 秒试一段。
                </p>
              `}
              ${useImage && !i2vSupported && html`
                <p className="mt-1.5 text-[12px] text-warn">请切换视频模型，或取消勾选（取消后按文字提示词生成，图片不参与）。</p>
              `}
            ` : html`
              <p className="text-[11px] leading-[1.7] text-ink3">
                还没有图片库记录。请先在第②步生成、第③步点「通过」；历史草稿里的旧图没有库记录，不能用于图生视频。
              </p>
            `}
          </${Section}>
        </div>

        <div className="mt-4">
          <${Section} title="生成参数"
            extra=${html`<${Info}>默认取自「设置 → 生成参数」；这里改只影响本次任务</${Info}>`}>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[12px] text-ink2 w-[70px]">模型</span>
              <select value=${p.model} onChange=${(e) => set('model', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                <option value="seedance">Seedance 2.5</option>
                <option value="kling">可灵 Kling 3.0</option>
                <option value="dashscope">万相 3.0（DashScope）</option>
                <option value="openai-video">OpenAI 兼容视频（WhaleTV / 中转）</option>
              </select>
              <span className="text-[12px] text-ink2 w-[54px]">分辨率</span>
              <select value=${p.resolution} onChange=${(e) => set('resolution', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                ${['720p', '1080p', '4K'].map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
              </select>
              <span className="text-[12px] text-ink2 w-[40px]">档位</span>
              <select value=${p.preset} onChange=${(e) => set('preset', e.target.value)}
                className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                ${['final', 'daily', 'quick', 'clips_only'].map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
                <option value="custom">custom（自定义环节）</option>
              </select>
            </div>
            ${p.preset === 'custom' && html`
              <div className="mt-2">
                <div className="text-[11px] text-ink3 mb-1">自定义环节（核心链 3 步始终执行；依赖由后端自动补齐）</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  ${STAGE_OPTS.map((s) => html`
                    <label key=${s.key} className="flex items-center gap-1.5 text-[11px] text-ink2">
                      <input type="checkbox"
                        checked=${s.core || customStages.includes(s.key)}
                        disabled=${s.core}
                        onChange=${(e) => toggleStage(s.key, e.target.checked)}
                        className="w-[13px] h-[13px] accent-accent" />
                      ${s.name}
                    </label>
                  `)}
                </div>
              </div>
            `}
            <div className="mt-2">
              <div className="text-[11px] text-ink3 mb-1">质检严格度（勾选项失败会阻塞任务；NSFW 永远阻塞，不可关闭）</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                ${QC_OPTS.map((q) => html`
                  <label key=${q.key} className="flex items-center gap-1.5 text-[11px] text-ink2">
                    <input type="checkbox"
                      checked=${q.key === 'nsfw' || strictQc.includes(q.key)}
                      disabled=${q.key === 'nsfw'}
                      onChange=${(e) => toggleQc(q.key, e.target.checked)}
                      className="w-[13px] h-[13px] accent-accent" />
                    ${q.name}
                  </label>
                `)}
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-[1.7] text-ink3">
              模型决定生成器与 Key 来源；请求体里的 model 仍是 generator 名（如 dashscope），modelId 由后端按厂商补全。
            </p>
          </${Section}>
        </div>

        <div className="mt-4">
          <${Section} title="确认">
            <dl className="grid grid-cols-[92px_1fr] gap-y-1.5 text-[12px]">
              <dt className="text-ink3">提示词</dt><dd className="text-ink break-words">${prompt || '（未填写）'}</dd>
              <dt className="text-ink3">运镜</dt><dd className="text-ink break-words">${vprompt || '（未填写）'}</dd>
              <dt className="text-ink3">模型</dt><dd className="text-ink">${p.model}</dd>
              <dt className="text-ink3">分辨率</dt><dd className="text-ink">${p.resolution}</dd>
              <dt className="text-ink3">档位</dt><dd className="text-ink">${p.preset}</dd>
              <dt className="text-ink3">片段</dt><dd className="text-ink">${effectiveClips} 段 × ${p.clipDuration}s${isMultiPrompt ? `（${promptLines.length} 个场景，按行生成）` : ''}</dd>
              <dt className="text-ink3">成片</dt><dd className="text-ink">${totalSec.toFixed(1)} 秒</dd>
              <dt className="text-ink3">预计花费</dt>
              <dd className="text-ink font-num">
                ${est
                  ? (est.estimate > 0 ? '约 ¥' + Number(est.estimate).toFixed(2) : '免费（mock，不产生费用）')
                  : '计算中…'}
                ${Number.isFinite(readBalance()) && readBalance() > 0
                  ? '｜余额 ¥' + readBalance().toFixed(2)
                  : ''}
              </dd>
              <dt className="text-ink3">配乐</dt>
              <dd className="text-ink">
                ${p.bgmMode === 'none' ? '不添加（无声）'
                  : p.bgmMode + (p.wantMusic ? ' · 音乐' : '') + (p.wantAmb ? ' · 环境音' : '')}
              </dd>
              <dt className="text-ink3">衔接</dt>
              <dd className="text-ink">
                ${p.transition
                  ? (p.transitionType === 'fade' ? '交叉淡化' : (p.transitionType === 'black' ? '经黑场' : '直切')) +
                    ' ' + p.transitionDuration + 's'
                  : '直切'}
                ${p.colorMatch ? ' · 校色开' : ''}
              </dd>
            </dl>
            ${Number.isFinite(readBalance()) && readBalance() > 0 && est && est.estimate > readBalance() && html`
              <p className="mt-2 text-[12px] text-danger">
                预计花费 ¥${Number(est.estimate).toFixed(2)} 超过余额 ¥${readBalance().toFixed(2)}，提交会被拦截。
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
            <span className=${'text-[12px] ' + (i === step ? 'text-ink' : 'text-ink3')}>${s}</span>
            ${i < STEPS.length - 1 && html`<span className="w-4 h-px bg-white/[.10] ml-1.5"></span>`}
          </div>
        `)}
      </div>

      ${seedNotice && html`
        <div className="mb-2 flex items-center gap-2 flex-wrap rounded-[6px] border border-accent/25 bg-accent/[.06] px-3 py-2">
          <span className="text-[11px] text-accent">
            🖼 已从照片库带入这张图（${seedNotice}）——先在第③步确认，再继续下一步
          </span>
        </div>
      `}

      ${restoredHint && html`
        <div className="mb-2 flex items-center gap-2 flex-wrap rounded-[6px] border border-accent/25 bg-accent/[.06] px-3 py-2">
          <span className="text-[11px] text-accent">
            ↺ 已恢复上次未做完的草稿${restoredAtText ? '（保存于 ' + restoredAtText + '）' : ''}
          </span>
          <span className="flex-1"></span>
          <button onClick=${resetAll}
            className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2 hover:bg-white/[.06]"
          >清空草稿</button>
        </div>
      `}

      ${body}

      <div className="mt-6 flex items-center gap-3 border-t border-white/[.08] pt-4">
        <button
          disabled=${step === 0}
          onClick=${() => setStep((s) => Math.max(0, s - 1))}
          className="h-9 px-4 rounded-[6px] border border-white/[.10] text-[13px] text-ink2
                     hover:bg-white/[.05] disabled:opacity-40"
        >上一步</button>
        <span className="flex-1"></span>
        ${step === STEPS.length - 1
          ? html`<button
              disabled=${submitting}
              onClick=${submit}
              className="h-9 px-4 rounded-[6px] bg-accent text-onaccent text-[13px] disabled:opacity-40"
            >${submitting ? '提交中…' : '提交并生成'}</button>`
          : html`<button
              onClick=${() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              className="h-9 px-4 rounded-[6px] bg-accent text-onaccent text-[13px]"
            >下一步</button>`}
      </div>
    </div>
  `;
}
