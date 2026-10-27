// ============================================================
// 设置抽屉（任务 / 资产 / 设置 三页签）
// ------------------------------------------------------------
// 口径：
//  - 任务：GET /api/tasks
//  - 资产：GET /api/library（groups/totals/overall/facets）+ GET /api/bgm（tracks）
//  - 设置：GET /api/models（数组 {id,name,maxDuration,resolutions,available}）
//  - 设置值存 localStorage.vs_config（与旧版同键，迁移期共用一份）
// 版式遵守四层区隔：标题 + 通栏分割线平铺，不套圆角卡片。
// 参数分三级：常用直接可见，其余收进「高级」折叠。
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const CFG_KEY = 'vs_config';

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCfg(patch) {
  const cur = loadCfg();
  const next = { ...cur, ...patch };
  localStorage.setItem(CFG_KEY, JSON.stringify(next));
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
        <h4 className="text-[12px] font-medium text-ink">${props.title}</h4>
        ${props.hint && html`<span className="text-[10px] text-ink3">${props.hint}</span>`}
      </div>
      <div className="mt-2">${props.children}</div>
    </div>
  `;
}

function Field(props) {
  return html`
    <div className="flex items-center gap-3 py-[5px]">
      <span className="w-[92px] shrink-0 text-[12px] text-ink2">${props.label}</span>
      <span className="flex-1 min-w-0">${props.children}</span>
      ${props.hint && html`<span className="text-[10px] text-ink3 shrink-0">${props.hint}</span>`}
    </div>
  `;
}

function Toggle(props) {
  return html`
    <button
      onClick=${() => props.onChange(!props.on)}
      className="h-7 px-2.5 rounded-[5px] border border-black/[.10] text-[12px] flex items-center gap-2
                 hover:bg-black/[.03] transition-colors"
    >
      <span className=${'w-[7px] h-[7px] rounded-full ' + (props.on ? 'bg-accent' : 'bg-ink3')}></span>
      <span className=${props.on ? 'text-ink' : 'text-ink3'}>${props.on ? '开' : '关'}</span>
    </button>
  `;
}

const selCls = 'h-8 w-full max-w-[300px] rounded-[5px] border border-black/[.09] bg-s3 px-2 text-[12px] text-ink';
const numCls = 'h-8 w-[96px] rounded-[5px] border border-black/[.09] bg-s3 px-2 text-[12px] text-ink font-num';

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
  const lib = useJson('/api/library');
  const bgm = useJson('/api/bgm');
  const totals = (lib.data && lib.data.totals) || {};
  const tracks = (bgm.data && bgm.data.tracks) || [];

  return html`
    <${Section} title="片段库" hint=${lib.loading ? '加载中…' : (lib.error ? '读取失败' : 'GET /api/library')}>
      ${lib.error
        ? html`<p className="text-[12px] text-danger">${lib.error}</p>`
        : (Object.keys(totals).length === 0
          ? html`<span className="text-[12px] text-ink3">库里还没有片段</span>`
          : html`<div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink2 font-num">
              ${Object.entries(totals).map(([k, v]) => html`<span key=${k}>${k} ${v}</span>`)}
            </div>`)}
    </${Section}>

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
  `;
}

function SettingsTab() {
  const models = useJson('/api/models');
  const [cfg, setCfg] = useState(loadCfg);
  const [advanced, setAdvanced] = useState(false);
  const [notice, setNotice] = useState('');

  function set(k, v) { setCfg(saveCfg({ [k]: v })); }

  const modelList = Array.isArray(models.data) ? models.data : [];
  const curModel = modelList.find((m) => m.id === cfg.videoModel) || modelList[0];
  const resolutions = (curModel && curModel.resolutions) || ['1080p'];
  const preset = cfg.preset || 'final';
  const transitionOn = cfg.transition !== false;
  const colorMatchOn = cfg.colorMatch === true;

  return html`
    <${Section} title="常用" hint="直接决定一次生成">
      <${Field} label="视频模型">
        <select
          className=${selCls}
          value=${cfg.videoModel || (curModel && curModel.id) || ''}
          onChange=${(e) => set('videoModel', e.target.value)}
        >
          ${modelList.map((m) => html`
            <option key=${m.id} value=${m.id} disabled=${m.available === false}>
              ${m.name}${m.available === false ? '（未配置 Key）' : ''}
            </option>
          `)}
        </select>
      </${Field}>

      <${Field} label="分辨率">
        <select className=${selCls} value=${cfg.resolution || resolutions[0]} onChange=${(e) => set('resolution', e.target.value)}>
          ${resolutions.map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
        </select>
      </${Field}>

      <${Field} label="片段时长" hint="秒">
        <input type="number" min="2" max=${(curModel && curModel.maxDuration) || 30}
          className=${numCls} value=${cfg.clipDuration || 5}
          onChange=${(e) => set('clipDuration', Number(e.target.value) || 5)} />
      </${Field}>

      <${Field} label="片段数量">
        <input type="number" min="1" max="40" className=${numCls}
          value=${cfg.totalClips || 4}
          onChange=${(e) => set('totalClips', Number(e.target.value) || 4)} />
      </${Field}>

      <${Field} label="档位">
        <select className=${selCls} value=${preset} onChange=${(e) => set('preset', e.target.value)}>
          ${[
            ['final', 'final · 8 步全量'],
            ['daily', 'daily · 日常'],
            ['quick', 'quick · 快速（强制直拼）'],
            ['clips_only', 'clips_only · 只出片段'],
            ['custom', 'custom · 自定义']
          ].map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
        </select>
      </${Field}>

      <${Field} label="片段转场" hint="关则直拼">
        <${Toggle} on=${transitionOn}
          onChange=${(v) => {
            if (!v && colorMatchOn) {
              // 校色依赖转场：不能只关转场留下校色，明确降级并告知
              setCfg(saveCfg({ transition: false, colorMatch: false }));
              setNotice('已同时关闭「接缝校色」：校色必须开启转场');
              return;
            }
            set('transition', v);
          }} />
      </${Field}>

      <${Field} label="接缝校色" hint="需开转场">
        <${Toggle} on=${colorMatchOn}
          onChange=${(v) => {
            const next = { ...cfg, colorMatch: v };
            if (v) next.transition = true;
            setCfg(saveCfg(next));
            if (v && !transitionOn) setNotice('已自动开启转场：校色需要它');
          }} />
      </${Field}>

      ${notice && html`
        <p className="mt-1 text-[11px] text-warn">${notice}</p>
      `}
    </${Section}>

    <button
      onClick=${() => setAdvanced((v) => !v)}
      className="mt-2 mb-1 h-7 px-2 rounded-[5px] text-[11px] text-ink2 hover:bg-black/[.04]"
    >${advanced ? '收起高级' : '展开高级（还有 6 项）'}</button>

    ${advanced && html`
      <${Section} title="高级" hint="改前先确认影响">
        <${Field} label="提示词优化">
          <${Toggle} on=${cfg.promptOptimize !== false} onChange=${(v) => set('promptOptimize', v)} />
        </${Field}>
        <${Field} label="自动配乐">
          <${Toggle} on=${cfg.autoBgm !== false} onChange=${(v) => set('autoBgm', v)} />
        </${Field}>
        <${Field} label="循环淡化" hint="秒">
          <input type="number" step="0.1" min="0.2" max="2" className=${numCls}
            value=${cfg.loopFadeDuration || 0.5}
            onChange=${(e) => set('loopFadeDuration', Number(e.target.value) || 0.5)} />
        </${Field}>
        <${Field} label="转场时长" hint="秒">
          <input type="number" step="0.1" min="0.1" max="2" className=${numCls}
            value=${cfg.transitionDuration || 0.4}
            onChange=${(e) => set('transitionDuration', Number(e.target.value) || 0.4)} />
        </${Field}>
        <p className="mt-2 text-[10px] leading-[1.7] text-ink3">
          设置存在浏览器 localStorage.vs_config，与旧版共用同一份；下次创建任务时带上。
        </p>
      </${Section}>
    `}
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
        className="absolute right-0 top-0 bottom-0 w-[min(560px,94vw)] bg-s3 border-l border-black/[.08]
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
