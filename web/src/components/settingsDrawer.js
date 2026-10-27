// ============================================================
// 设置抽屉（任务 / 资产 / 设置 三页签）
// ------------------------------------------------------------
// 存储分两处，刻意分开：
//   vs_config      —— 与旧版共用的 Key / 地址 / 模型名，字段名完全沿用旧版
//                     （旧版 saveSettings() 是整对象覆盖写，所以这里也只能写它认得的键）
//   vs_web_config  —— 新版独有参数（模型选择/分辨率/档位/转场/校色…）
//                     独立键，避免被旧版整对象覆盖抹掉
// 接口：
//   GET  /api/models        视频模型清单
//   GET  /api/library       片段库
//   GET  /api/bgm           配乐库
//   POST /api/test-api-key  { type, apiKey, baseUrl, model, accessKey, secretKey }
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState, useRef } = React;

const KEY_STORE = 'vs_config';
const WEB_STORE = 'vs_web_config';

// 用户已明确不会使用的模型，设置里不露出（后端仍保留）
const HIDDEN_MODELS = new Set(['siliconflow', 'agnes']);

function readJson(k) {
  try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
function writeJson(k, patch) {
  const next = { ...readJson(k), ...patch };
  localStorage.setItem(k, JSON.stringify(next));
  return next;
}

function useJson(url) {
  const [s, setS] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: 'same-origin' })
      .then(async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => { if (alive) setS({ loading: false, data: d, error: null }); })
      .catch((e) => { if (alive) setS({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
  }, [url]);
  return s;
}

function Section(props) {
  return html`
    <div className="border-b border-black/[.07] py-3">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[12.5px] font-medium text-ink">${props.title}</h4>
        ${props.hint && html`<span className="text-[10px] text-ink3">${props.hint}</span>`}
      </div>
      <div className="mt-2">${props.children}</div>
    </div>
  `;
}

const inputCls = 'h-8 w-full rounded-[5px] border border-black/[.09] bg-s3 px-2 text-[12px] text-ink placeholder:text-ink3';
const numCls = 'h-8 w-[92px] rounded-[5px] border border-black/[.09] bg-s3 px-2 text-[12px] text-ink font-num';

function Row(props) {
  return html`
    <div className="flex items-center gap-3 py-[4px]">
      <span className="w-[104px] shrink-0 text-[12px] text-ink2">${props.label}</span>
      <span className="flex-1 min-w-0">${props.children}</span>
      ${props.tail || null}
    </div>
  `;
}

function Toggle(props) {
  return html`
    <button
      onClick=${() => props.onChange(!props.on)}
      className="h-7 px-2.5 rounded-[5px] border border-black/[.10] text-[12px] flex items-center gap-2 hover:bg-black/[.03]"
    >
      <span className=${'w-[7px] h-[7px] rounded-full ' + (props.on ? 'bg-accent' : 'bg-ink3')}></span>
      <span className=${props.on ? 'text-ink' : 'text-ink3'}>${props.on ? '开' : '关'}</span>
    </button>
  `;
}

// ===== Key 分组定义（字段名严格沿用旧版 vs_config）=====
// 2026-10-27：用户确认不再使用 硅基流动 Wan 2.2 与 Agnes(Pavo)，入口已移除。
// 后端 generator 仍然保留（旧版页面还在用），只是设置里不再露出，
// 避免「永远配不出 Key 的模型」占位。
const KEY_GROUPS = [
  {
    id: 'seedance', title: 'Seedance 2.5（字节）', testType: 'seedance',
    fields: [
      { key: 'seedanceKey', label: 'API Key', secret: true },
      { key: 'seedanceBaseUrl', label: 'Base URL', placeholder: '留空用默认' },
      { key: 'seedanceModel', label: '模型', placeholder: '留空用默认' }
    ]
  },
  {
    id: 'kling', title: '可灵 Kling 3.0（快手）', testType: 'kling',
    fields: [
      { key: 'klingAk', label: 'AccessKey' },
      { key: 'klingSk', label: 'SecretKey', secret: true }
    ]
  },
  {
    id: 'dashscope', title: '万相 3.0（DashScope）', testType: 'dashscope',
    fields: [
      { key: 'dashScopeKey', label: 'API Key', secret: true },
      { key: 'dashScopeRegion', label: '区域', placeholder: 'cn-beijing / ap-southeast-1' },
      { key: 'dashScopeWorkspaceId', label: 'WorkspaceId', placeholder: '留空用默认' }
    ]
  },
  {
    id: 'llm', title: 'LLM · 提示词助手', testType: 'llm',
    fields: [
      { key: 'llmKey', label: 'API Key', secret: true },
      { key: 'llmUrl', label: 'Base URL', placeholder: 'https://api.xxx.com/v1' },
      { key: 'llmModel', label: '模型', placeholder: 'gpt-4o-mini / qwen-plus' }
    ]
  },
  {
    id: 'multimodal', title: '多模态 · 视觉质检 / NSFW', testType: 'multimodal',
    fields: [
      { key: 'multimodalKey', label: 'API Key', secret: true },
      { key: 'multimodalUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
      { key: 'multimodalModel', label: '模型', placeholder: 'gpt-4o-mini / qwen-vl-plus' }
    ]
  }
];

function KeyGroup(props) {
  const { group, cfg, onSave } = props;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [shown, setShown] = useState({});   // 每个密钥框独立的「显示明文」开关

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const body = {
        type: group.testType,
        apiKey: cfg[group.fields[0].key] || '',
        baseUrl: cfg.seedanceBaseUrl || cfg.llmUrl || cfg.multimodalUrl || ''
      };
      if (group.id === 'kling') { body.accessKey = cfg.klingAk || ''; body.secretKey = cfg.klingSk || ''; }
      if (group.id === 'llm') { body.baseUrl = cfg.llmUrl || ''; body.model = cfg.llmModel || ''; }
      if (group.id === 'multimodal') { body.baseUrl = cfg.multimodalUrl || ''; body.model = cfg.multimodalModel || ''; }
      if (group.id === 'seedance') { body.baseUrl = cfg.seedanceBaseUrl || ''; body.model = cfg.seedanceModel || ''; }

      const r = await fetch('/api/test-api-key', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => null);
      setResult(j && j.success
        ? { ok: true, text: j.message || '连接正常' }
        : { ok: false, text: (j && j.error) || '测试失败' });
    } catch (e) {
      setResult({ ok: false, text: '请求失败：' + e.message });
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div className="py-2 border-b border-black/[.05] last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink">${group.title}</span>
        <span className="flex-1"></span>
        <button
          onClick=${test}
          disabled=${busy}
          className="h-7 px-2.5 rounded-[5px] border border-black/[.10] text-[11px] text-ink2
                     hover:bg-black/[.04] disabled:opacity-40"
        >${busy ? '测试中…' : '测试连接'}</button>
      </div>

      ${group.fields.map((f) => html`
        <${Row} key=${f.key} label=${f.label}
          tail=${f.secret ? html`
            <button
              type="button"
              onClick=${() => setShown((s) => ({ ...s, [f.key]: !s[f.key] }))}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-ink hover:bg-black/[.04] shrink-0"
              title=${shown[f.key] ? '隐藏' : '显示明文'}
            >${shown[f.key] ? '隐藏' : '显示'}</button>
          ` : null}>
          <input
            type=${f.secret && !shown[f.key] ? 'password' : 'text'}
            className=${inputCls}
            value=${cfg[f.key] || ''}
            placeholder=${f.placeholder || ''}
            autoComplete="off"
            spellCheck="false"
            onChange=${(e) => onSave({ [f.key]: e.target.value.trim() })}
          />
        </${Row}>
      `)}

      ${result && html`
        <p className=${'mt-1 text-[11px] leading-[1.6] ' + (result.ok ? 'text-accent' : 'text-danger')}>
          ${result.ok ? '✓ ' : '✗ '}${result.text}
        </p>
      `}
    </div>
  `;
}

function SettingsTab() {
  const models = useJson('/api/models');
  const [keys, setKeys] = useState(() => readJson(KEY_STORE));
  const [web, setWeb] = useState(() => readJson(WEB_STORE));
  const [advanced, setAdvanced] = useState(false);
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);

  const saveKey = (patch) => setKeys(writeJson(KEY_STORE, patch));
  const saveWeb = (patch) => setWeb(writeJson(WEB_STORE, patch));

  const modelList = (Array.isArray(models.data) ? models.data : [])
    .filter((m) => !HIDDEN_MODELS.has(m.id));
  const curModel = modelList.find((m) => m.id === web.videoModel) || modelList[0];
  const resolutions = (curModel && curModel.resolutions) || ['1080p'];
  const transitionOn = web.transition !== false;
  const colorMatchOn = web.colorMatch === true;

  function exportBackup() {
    const payload = {
      _type: 'vs_config_backup',
      _savedAt: new Date().toISOString(),
      config: readJson(KEY_STORE),
      webConfig: readJson(WEB_STORE)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = 'vs-config-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
      + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function importBackup(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        const cfg = raw.config || raw;
        if (!cfg || typeof cfg !== 'object') throw new Error('文件里没有 config');
        localStorage.setItem(KEY_STORE, JSON.stringify(cfg));
        if (raw.webConfig && typeof raw.webConfig === 'object') {
          localStorage.setItem(WEB_STORE, JSON.stringify(raw.webConfig));
        }
        setKeys(readJson(KEY_STORE));
        setWeb(readJson(WEB_STORE));
        setNotice('已恢复备份');
      } catch (err) {
        setNotice('恢复失败：' + err.message);
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  }

  return html`
    <${Section} title="生成参数" hint="存 vs_web_config">
      <${Row} label="视频模型">
        <select className=${inputCls} value=${web.videoModel || (curModel && curModel.id) || ''}
          onChange=${(e) => saveWeb({ videoModel: e.target.value })}>
          ${modelList.map((m) => html`
            <option key=${m.id} value=${m.id}>${m.name}${m.available === false ? '（后端无 Key）' : ''}</option>
          `)}
        </select>
      </${Row}>
      <${Row} label="分辨率">
        <select className=${inputCls} value=${web.resolution || resolutions[0]}
          onChange=${(e) => saveWeb({ resolution: e.target.value })}>
          ${resolutions.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
        </select>
      </${Row}>
      <${Row} label="片段时长">
        <input type="number" min="2" max=${(curModel && curModel.maxDuration) || 30}
          className=${numCls} value=${web.clipDuration || 5}
          onChange=${(e) => saveWeb({ clipDuration: Number(e.target.value) || 5 })} />
      </${Row}>
      <${Row} label="片段数量">
        <input type="number" min="1" max="40" className=${numCls} value=${web.totalClips || 4}
          onChange=${(e) => saveWeb({ totalClips: Number(e.target.value) || 4 })} />
      </${Row}>
      <${Row} label="档位">
        <select className=${inputCls} value=${web.preset || 'final'}
          onChange=${(e) => saveWeb({ preset: e.target.value })}>
          ${[
            ['final', 'final · 8 步全量'],
            ['daily', 'daily · 日常'],
            ['quick', 'quick · 快速（强制直拼）'],
            ['clips_only', 'clips_only · 只出片段'],
            ['custom', 'custom · 自定义']
          ].map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
        </select>
      </${Row}>
      <${Row} label="片段转场">
        <${Toggle} on=${transitionOn} onChange=${(v) => {
          if (!v && colorMatchOn) {
            saveWeb({ transition: false, colorMatch: false });
            setNotice('已同时关闭「接缝校色」：校色必须开启转场');
            return;
          }
          saveWeb({ transition: v });
        }} />
      </${Row}>
      <${Row} label="接缝校色">
        <${Toggle} on=${colorMatchOn} onChange=${(v) => {
          const next = { colorMatch: v };
          if (v) next.transition = true;
          saveWeb(next);
          if (v && !transitionOn) setNotice('已自动开启转场：校色需要它');
        }} />
      </${Row}>
      ${notice && html`<p className="mt-1 text-[11px] text-warn">${notice}</p>`}
    </${Section}>

    <${Section} title="API Key" hint="存 vs_config，与旧版共用">
      ${KEY_GROUPS.map((g) => html`
        <${KeyGroup} key=${g.id} group=${g} cfg=${keys} onSave=${saveKey} />
      `)}
      <p className="mt-2 text-[10px] leading-[1.7] text-ink3">
        Key 只保存在本机浏览器 localStorage，不上传服务器。换地址 / 换浏览器会看不到，用下面的备份恢复。
      </p>
    </${Section}>

    <button
      onClick=${() => setAdvanced((v) => !v)}
      className="mt-2 h-7 px-2 rounded-[5px] text-[11px] text-ink2 hover:bg-black/[.04]"
    >${advanced ? '收起高级' : '展开高级（4 项）'}</button>

    ${advanced && html`
      <${Section} title="高级" hint="改前先确认影响">
        <${Row} label="提示词优化">
          <${Toggle} on=${web.promptOptimize !== false}
            onChange=${(v) => saveWeb({ promptOptimize: v })} />
        </${Row}>
        <${Row} label="自动配乐">
          <${Toggle} on=${web.autoBgm !== false} onChange=${(v) => saveWeb({ autoBgm: v })} />
        </${Row}>
        <${Row} label="循环淡化" tail=${html`<span className="text-[10px] text-ink3">秒</span>`}>
          <input type="number" step="0.1" min="0.2" max="2" className=${numCls}
            value=${web.loopFadeDuration || 0.5}
            onChange=${(e) => saveWeb({ loopFadeDuration: Number(e.target.value) || 0.5 })} />
        </${Row}>
        <${Row} label="转场时长" tail=${html`<span className="text-[10px] text-ink3">秒</span>`}>
          <input type="number" step="0.1" min="0.1" max="2" className=${numCls}
            value=${web.transitionDuration || 0.4}
            onChange=${(e) => saveWeb({ transitionDuration: Number(e.target.value) || 0.4 })} />
        </${Row}>
      </${Section}>
    `}

    <${Section} title="备份 / 恢复" hint="换设备时用">
      <div className="flex items-center gap-2">
        <button onClick=${exportBackup}
          className="h-7 px-2.5 rounded-[5px] border border-black/[.10] text-[11px] text-ink2 hover:bg-black/[.04]">
          导出配置
        </button>
        <button onClick=${() => fileRef.current && fileRef.current.click()}
          className="h-7 px-2.5 rounded-[5px] border border-black/[.10] text-[11px] text-ink2 hover:bg-black/[.04]">
          导入配置
        </button>
        <input ref=${fileRef} type="file" accept=".json,application/json"
          className="hidden" onChange=${importBackup} />
        <span className="text-[10px] text-danger">备份文件含 API Key，注意保管</span>
      </div>
    </${Section}>
  `;
}

function TasksTab() {
  const { data, loading, error } = useJson('/api/tasks');
  const list = Array.isArray(data) ? data : (data && data.tasks) || [];
  if (loading) return html`<p className="text-[12px] text-ink3 py-3">加载中…</p>`;
  if (error) return html`<p className="text-[12px] text-danger py-3">读取失败：${error}</p>`;
  if (list.length === 0) return html`<p className="text-[12px] text-ink3 py-3">还没有任务。</p>`;
  return html`
    <ul className="divide-y divide-black/[.05]">
      ${list.slice(0, 30).map((t) => html`
        <li key=${t.taskId} className="py-2 flex items-center gap-2">
          <span className="text-[11px] text-ink3 font-num shrink-0">${(t.status || '-').slice(0, 9)}</span>
          <span className="text-[12px] text-ink truncate flex-1">${(t.prompt || '(无提示词)').slice(0, 48)}</span>
        </li>
      `)}
    </ul>
  `;
}

function AssetsTab() {
  const [q, setQ] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [res, setRes] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);   // 变更后靠它触发重取

  const qs = new URLSearchParams();
  if (q.trim()) qs.set('q', q.trim());
  if (favOnly) qs.set('favorite', '1');
  if (res) qs.set('resolution', res);
  const url = '/api/library' + (qs.toString() ? '?' + qs.toString() : '');

  const { data, loading, error } = useJson(url + (url.includes('?') ? '&' : '?') + '_=' + tick);
  const bgm = useJson('/api/bgm');

  const groups = (data && data.groups) || [];
  const facets = (data && data.facets) || {};
  const totals = (data && data.totals) || {};
  const tracks = (bgm.data && bgm.data.tracks) || [];

  async function toggleFav(it) {
    setBusyId(it.id);
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(it.id), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: !it.favorite })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setTick((t) => t + 1);
    } catch (e) {
      setErr('收藏失败：' + e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(it) {
    // 删除会同时删掉 clips/ 下的源文件，必须二次确认并写明后果
    const ok = window.confirm(
      '确定删除这条片段吗？\n\n提示词：' + (it.prompt || '').slice(0, 60) + '\n\n'
      + '会同时删除磁盘上的片段文件（' + (it.fileName || it.id) + '），不可恢复。'
    );
    if (!ok) return;
    setBusyId(it.id);
    setErr('');
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(it.id), {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.success) throw new Error((j && j.error) || ('HTTP ' + r.status));
      setTick((t) => t + 1);
    } catch (e) {
      setErr('删除失败：' + e.message);
    } finally {
      setBusyId(null);
    }
  }

  return html`
    <div className="py-2">
      <div className="flex items-center gap-2">
        <input
          className="h-8 flex-1 max-w-[260px] rounded-[5px] border border-black/[.09] bg-s3 px-2 text-[12px] text-ink"
          placeholder="搜索提示词…"
          value=${q}
          onChange=${(e) => setQ(e.target.value)}
        />
        <select
          className="h-8 rounded-[5px] border border-black/[.09] bg-s3 px-2 text-[12px] text-ink"
          value=${res}
          onChange=${(e) => setRes(e.target.value)}
        >
          <option value="">全部分辨率</option>
          ${(facets.resolutions || []).map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
        </select>
        <button
          onClick=${() => setFavOnly((v) => !v)}
          className=${'h-8 px-2.5 rounded-[5px] border text-[12px] ' +
            (favOnly ? 'border-accent/40 bg-accent/[.08] text-accent' : 'border-black/[.09] text-ink2')}
        >只看收藏</button>
        <span className="flex-1"></span>
        <span className="text-[11px] text-ink3 font-num">
          ${loading ? '加载中…' : (error ? '读取失败'
            : (totals.count || 0) + ' 条' + (totals.favorites ? ' · 收藏 ' + totals.favorites : ''))}
        </span>
      </div>

      ${err && html`<p className="mt-1 text-[11px] text-danger">${err}</p>`}
      ${error && html`<p className="mt-1 text-[11px] text-danger">${error}</p>`}

      ${groups.length === 0 && !loading && html`
        <p className="mt-4 text-[12px] text-ink3">没有匹配的片段。</p>
      `}

      ${groups.map((g) => html`
        <div key=${g.label} className="mt-3">
          <div className="flex items-baseline gap-2 border-b border-black/[.07] pb-1">
            <span className="text-[12px] font-medium text-ink">${g.label}</span>
            <span className="text-[10px] text-ink3 font-num">${g.count} 条</span>
            ${g.totalCost > 0 && html`<span className="text-[10px] text-ink3 font-num">¥${g.totalCost}</span>`}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-3">
            ${(g.items || []).map((it) => html`
              <div key=${it.id} className="rounded-[6px] border border-black/[.07] overflow-hidden bg-s2">
                <video
                  src=${it.url}
                  className="w-full aspect-video bg-black object-cover"
                  preload="metadata"
                  muted
                  playsInline
                  controls
                ></video>
                <div className="px-2 py-1.5">
                  <p className="text-[11px] leading-[1.5] text-ink line-clamp-2 min-h-[32px]">
                    ${(it.prompt || '').slice(0, 80)}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-ink3">${it.model || '-'}</span>
                    <span className="text-[10px] text-ink3 font-num">${(() => {
                      const d = it.duration || it.durationSec || it.durationSeconds;
                      return d ? Math.round(d) + 's' : '';
                    })()}</span>
                    <span className="flex-1"></span>
                    <button
                      onClick=${() => toggleFav(it)}
                      disabled=${busyId === it.id}
                      title=${it.favorite ? '取消收藏' : '收藏'}
                      className=${'h-6 px-1.5 rounded-[4px] text-[12px] hover:bg-black/[.05] ' +
                        (it.favorite ? 'text-warn' : 'text-ink3')}
                    >${it.favorite ? '★' : '☆'}</button>
                    <button
                      onClick=${() => remove(it)}
                      disabled=${busyId === it.id}
                      title="删除（含文件）"
                      className="h-6 px-1.5 rounded-[4px] text-[11px] text-ink3 hover:text-danger hover:bg-black/[.05]"
                    >删除</button>
                  </div>
                </div>
              </div>
            `)}
          </div>
        </div>
      `)}

      <${Section} title="配乐库" hint=${bgm.loading ? '加载中…' : (bgm.error ? '读取失败' : 'GET /api/bgm')}>
        ${bgm.error
          ? html`<p className="text-[12px] text-danger">${bgm.error}</p>`
          : html`
            <p className="text-[12px] text-ink2 font-num">共 ${(bgm.data && bgm.data.total) || 0} 首</p>
            <ul className="mt-1 divide-y divide-black/[.04]">
              ${tracks.slice(0, 12).map((t) => html`
                <li key=${t.id} className="py-[5px] flex items-center gap-2">
                  <span className="text-[12px] text-ink truncate flex-1">${t.title || t.id}</span>
                  <span className="text-[10px] text-ink3">${(t.mood || []).join('/')}</span>
                </li>
              `)}
            </ul>
          `}
      </${Section}>
    </div>
  `;
}

const TABS = [
  { key: 'tasks', label: '任务' },
  { key: 'assets', label: '资产' },
  { key: 'settings', label: '设置' }
];

export function SettingsDrawer({ onClose }) {
  const [tab, setTab] = useState('settings');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return html`
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/25" onClick=${onClose} aria-hidden="true"></div>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="absolute right-0 top-0 bottom-0 w-[min(620px,94vw)] bg-s3 border-l border-black/[.08]
                   shadow-[-16px_0_48px_rgba(0,0,0,.12)] flex flex-col drawer-in"
        onClick=${(e) => e.stopPropagation()}
      >
        <header className="shrink-0 h-12 flex items-center gap-1 px-4 border-b border-black/[.06]">
          ${TABS.map((t) => html`
            <button
              key=${t.key}
              onClick=${() => setTab(t.key)}
              className=${[
                'h-8 px-3 rounded-[5px] text-[13px] transition-colors',
                tab === t.key ? 'bg-accent text-white' : 'text-ink2 hover:bg-black/[.04]'
              ].join(' ')}
            >${t.label}</button>
          `)}
          <span className="flex-1"></span>
          <button
            onClick=${onClose}
            className="h-7 w-7 grid place-items-center rounded-[5px] text-ink2 hover:bg-black/[.05]"
            aria-label="关闭"
          >✕</button>
        </header>

        <div className="flex-1 min-h-0 overflow-auto px-4 py-2">
          ${tab === 'tasks' && html`<${TasksTab} />`}
          ${tab === 'assets' && html`<${AssetsTab} />`}
          ${tab === 'settings' && html`<${SettingsTab} />`}
        </div>
      </aside>
    </div>
  `;
}
