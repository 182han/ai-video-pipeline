// ============================================================
// 创作：六步向导（2026-10-31）
// ------------------------------------------------------------
// ①提示词 → ②图片生成 → ③图片审核 → ④运镜 → ⑤时长与配乐 → ⑥确认
// 现状约束（不装样子，界面直说）：
//   · 出图后端已接入 wan2.7-image（2026-11-08）→ 第②步可做「单张测试出图」
//   · 但图片还没有接进任务/审核门（全仓库 awaiting_review 0 命中）→ 第③步只给说明
//   · 因此审核门可跳过；提交走既有 POST /api/tasks（文生视频链路，能真跑）
// ============================================================
import { navigate } from '../router.js';
import { promptBus } from '../store.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const STEPS = ['提示词', '图片生成', '图片审核', '运镜', '时长与配乐', '确认'];

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

export function CreateWizard({ onChanged }) {
  const web = readWebConfig();
  const [step, setStep] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [vprompt, setVprompt] = useState('');
  const [p, setP] = useState({
    model: web.videoModel || 'seedance', resolution: web.resolution || '1080p', preset: web.preset || 'final',
    clipCount: 4, clipDuration: 5,
    transition: true, transitionDuration: 0.4, transitionType: 'fade', colorMatch: false,
    bgm: true, bgmMode: 'auto', wantMusic: true, wantAmb: false, startTrack: '', ambTrack: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [big, setBig] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optErr, setOptErr] = useState('');
  const [tracks, setTracks] = useState([]);
  const [imgStatus, setImgStatus] = useState(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgResult, setImgResult] = useState(null);
  const [imgErr, setImgErr] = useState('');
  const [est, setEst] = useState(null); // 费用预估（/api/estimate，与 /api/pricing 同源）

  // 多行模式：行数即片段数（覆盖段数设置）
  const promptLines = splitPromptLines(prompt);
  const isMultiPrompt = promptLines.length > 1;
  const effectiveClips = isMultiPrompt ? promptLines.length : p.clipCount;

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

  async function genTestImage() {
    setImgErr('');
    setImgResult(null);
    if (!prompt.trim()) { setImgErr('先在第一步写提示词'); return; }
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem('vs_config') || '{}'); } catch { cfg = {}; }
    setImgBusy(true);
    try {
      const r = await fetch('/api/images/generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          apiKey: cfg.imageKey || '',
          baseUrl: cfg.imageBaseUrl || '',
          model: cfg.imageModel || '',
          size: cfg.imageSize || (imgStatus && imgStatus.imageGen ? imgStatus.imageGen.size : undefined),
          provider: cfg.imageProvider || '',
          taskId: 'ui_img_' + Date.now(),
          index: 0
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setImgResult(j);
    } catch (e) {
      setImgErr(e.message || '出图失败');
    } finally {
      setImgBusy(false);
    }
  }

  const totalSec = (effectiveClips * p.clipDuration -
    (p.transition ? p.transitionDuration * (effectiveClips - 1) : 0));

  function set(k, v) { setP((s) => ({ ...s, [k]: v })); }

  async function submit() {
    setErr('');
    if (!prompt.trim()) { setErr('提示词不能为空'); setStep(0); return; }

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
        clipCount: effectiveClips,
        totalClips: effectiveClips,
        clipDuration: p.clipDuration,
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
            </div>
          `}
          <div className="mt-3">
            <${Info}>审核门（通过后才继续生成视频）仍未实现；现在可以跳过这一步，直接走文生视频链路。</${Info}>
          </div>
        </${Section}>
      `;
    }

    if (step === 2) {
      return html`
        <${Section} title="图片审核（后端未实现）">
          <div className="rounded-[6px] border border-white/[.09] bg-s2 px-3 py-2.5">
            <p className="text-[12px] text-ink2">「审核通过才继续生成视频」需要后端提供一个待审状态。</p>
            <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
              全仓库搜索 <code className="font-num">awaiting_review</code> 命中 0 次，
              说明这条状态机还没落地。等后端补上后，这里会显示静帧网格与「通过 / 重新生成」。
            </p>
          </div>
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
              </select>
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
