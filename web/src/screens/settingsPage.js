// ============================================================
// 设置（整页）
// ------------------------------------------------------------
// 存储分两处（沿用旧版约定，两边共用一份 Key）：
//   localStorage.vs_config       Key / 地址 / 模型名（与旧版同键）
//   localStorage.vs_web_config   新版独有参数
// 接口：
//   POST /api/test-api-key            { type, apiKey, baseUrl, model, accessKey, secretKey }
//   GET  /api/users                   { users, authEnabled, selfId }
//   POST /api/users                   { username, password }
//   PUT  /api/users/:id/password      { password }
//   DELETE /api/users/:id
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const KEY_STORE = 'vs_config';
const WEB_STORE = 'vs_web_config';

function readJson(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } }
function writeJson(k, patch) {
  const next = { ...readJson(k), ...patch };
  localStorage.setItem(k, JSON.stringify(next));
  return next;
}

const GROUPS = [
  { id: 'seedance', title: 'Seedance 2.5（字节）', collapsible: true, fields: [['seedanceKey', 'API Key', 'password'], ['seedanceBaseUrl', 'Base URL', 'text'], ['seedanceModel', '模型', 'text']] },
  { id: 'kling', title: '可灵 Kling 3.0', collapsible: true, fields: [['klingAk', 'AccessKey', 'text'], ['klingSk', 'SecretKey', 'password']] },
  { id: 'dashscope', title: '万相 3.0（DashScope）', fields: [['dashScopeKey', 'API Key', 'password'], ['dashScopeRegion', '区域', 'text'], ['dashScopeWorkspaceId', 'WorkspaceId', 'text']] },
  {
    id: 'whaletv',
    title: 'OpenAI 兼容视频（WhaleTV / 中转）',
    fields: [
      ['whaletvKey', 'API Key', 'password'],
      ['whaletvBaseUrl', 'Base URL', 'text'],
      ['whaletvVideoModel', '模型', 'text']
    ]
  },
  {
    id: 'imagegen',
    title: '图片生成 · wan2.7-image',
    fields: [
      ['imageKey', 'API Key', 'password'],
      ['imageBaseUrl', 'Base URL', 'text'],
      ['imageModel', '模型', 'text'],
      ['imageSize', '尺寸', 'text']
    ]
  },
  { id: 'llm', title: 'LLM · 提示词助手', fields: [['llmKey', 'API Key', 'password'], ['llmUrl', 'Base URL', 'text'], ['llmModel', '模型', 'text']] },
  { id: 'multimodal', title: '多模态 · 视觉质检', fields: [['multimodalKey', 'API Key', 'password'], ['multimodalUrl', 'Base URL', 'text'], ['multimodalModel', '模型', 'text']] }
];

const inputCls = 'h-8 w-full rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none';

function fetchJson(url, opt) {
  return fetch(url, { credentials: 'same-origin', ...(opt || {}) })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
}

export function SettingsView() {
  const [keys, setKeys] = useState(() => readJson(KEY_STORE));
  const [web, setWeb] = useState(() => readJson(WEB_STORE));
  const [testRes, setTestRes] = useState({});
  const [testing, setTesting] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const [users, setUsers] = useState([]);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [selfId, setSelfId] = useState('');
  const [nu, setNu] = useState('');
  const [np, setNp] = useState('');
  const [imgStatus, setImgStatus] = useState(null);
  const [openGroups, setOpenGroups] = useState({});
  const [showKeys, setShowKeys] = useState({});

  useEffect(() => {
    fetchJson('/api/users')
      .then((j) => { setUsers(j.users || []); setAuthEnabled(!!j.authEnabled); setSelfId(j.selfId || ''); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchJson('/api/image-gen/status')
      .then(setImgStatus)
      .catch(() => {});
  }, []);

  const saveKey = (patch) => setKeys(writeJson(KEY_STORE, patch));
  const saveWeb = (patch) => setWeb(writeJson(WEB_STORE, patch));

  async function test(g) {
    if (g.noTest) return;
    setTesting(g.id);
    setTestRes((r) => ({ ...r, [g.id]: null }));
    const body = { type: g.id };
    if (g.id === 'seedance') { body.apiKey = keys.seedanceKey || ''; body.baseUrl = keys.seedanceBaseUrl || ''; body.model = keys.seedanceModel || ''; }
    if (g.id === 'kling') { body.accessKey = keys.klingAk || ''; body.secretKey = keys.klingSk || ''; }
    if (g.id === 'dashscope') { body.apiKey = keys.dashScopeKey || ''; }
    if (g.id === 'whaletv') { body.type = 'openai-video'; body.apiKey = keys.whaletvKey || ''; body.baseUrl = keys.whaletvBaseUrl || ''; }
    if (g.id === 'imagegen') { body.apiKey = keys.imageKey || ''; body.baseUrl = keys.imageBaseUrl || ''; body.provider = keys.imageProvider || 'dashscope'; }
    if (g.id === 'llm') { body.apiKey = keys.llmKey || ''; body.baseUrl = keys.llmUrl || ''; body.model = keys.llmModel || ''; }
    if (g.id === 'multimodal') { body.apiKey = keys.multimodalKey || ''; body.baseUrl = keys.multimodalUrl || ''; body.model = keys.multimodalModel || ''; }
    try {
      const j = await fetchJson('/api/test-api-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      let text = j.success ? (j.message || '连接正常') : (j.error || '测试失败');
      if (!j.success && /未知的测试类型/.test(text)) {
        text += '（服务端仍是旧进程，请重启 node server.js）';
      }
      setTestRes((r) => ({ ...r, [g.id]: { ok: !!j.success, text } }));
    } catch (e) {
      setTestRes((r) => ({ ...r, [g.id]: { ok: false, text: e.message } }));
    } finally { setTesting(''); }
  }

  function exportCfg() {
    const payload = {
      _type: 'vs_config_backup', _savedAt: new Date().toISOString(),
      config: readJson(KEY_STORE), webConfig: readJson(WEB_STORE)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = 'vs-config-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function importCfg(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        const cfg = raw.config || raw;
        if (!cfg || typeof cfg !== 'object') throw new Error('文件里没有 config');
        localStorage.setItem(KEY_STORE, JSON.stringify(cfg));
        if (raw.webConfig) localStorage.setItem(WEB_STORE, JSON.stringify(raw.webConfig));
        setKeys(readJson(KEY_STORE)); setWeb(readJson(WEB_STORE));
        setMsg('已恢复备份');
      } catch (x) { setErr('恢复失败：' + x.message); }
    };
    reader.readAsText(f);
    e.target.value = '';
  }

  async function addUser() {
    setErr(''); setMsg('');
    try {
      await fetchJson('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: nu.trim(), password: np })
      });
      setNu(''); setNp('');
      const j = await fetchJson('/api/users');
      setUsers(j.users || []);
      setMsg('成员已创建');
    } catch (e) { setErr('创建成员失败：' + e.message); }
  }

  async function resetPwd(u) {
    const pwd = window.prompt('给 ' + u.username + ' 设置新密码（至少 8 位）：');
    if (!pwd) return;
    setErr(''); setMsg('');
    try {
      await fetchJson('/api/users/' + encodeURIComponent(u.userId || u.id) + '/password', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      setMsg('密码已重置');
    } catch (e) { setErr('重置失败：' + e.message); }
  }

  async function delUser(u) {
    if (!window.confirm('删除成员 ' + u.username + '？')) return;
    setErr(''); setMsg('');
    try {
      await fetchJson('/api/users/' + encodeURIComponent(u.userId || u.id), { method: 'DELETE' });
      const j = await fetchJson('/api/users');
      setUsers(j.users || []);
    } catch (e) { setErr('删除失败：' + e.message); }
  }

  const sec = 'rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3 mb-3.5';

  return html`
    <div className="px-6 py-5 max-w-[1040px]">
      <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0 mb-3.5">设置</h1>
      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${msg && html`<p className="mb-2 text-[12px] text-accent">${msg}</p>`}

      <div className=${sec}>
        <b className="block text-[12.5px] font-medium text-ink mb-2">生成参数</b>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[12px] text-ink2 w-[64px]">视频模型</span>
          <select value=${web.videoModel || 'seedance'} onChange=${(e) => saveWeb({ videoModel: e.target.value })}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            <option value="seedance">Seedance 2.5</option>
            <option value="kling">可灵 Kling 3.0</option>
            <option value="dashscope">万相 3.0</option>
          </select>
          <span className="text-[12px] text-ink2 w-[54px]">分辨率</span>
          <select value=${web.resolution || '1080p'} onChange=${(e) => saveWeb({ resolution: e.target.value })}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            ${['720p', '1080p', '4K'].map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
          </select>
          <span className="text-[12px] text-ink2 w-[40px]">档位</span>
          <select value=${web.preset || 'final'} onChange=${(e) => saveWeb({ preset: e.target.value })}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            ${['final', 'daily', 'quick', 'clips_only'].map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
          </select>
        </div>
        <div className="mt-2 flex items-center gap-4">
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked=${web.transition !== false}
              onChange=${(e) => {
                const on = e.target.checked;
                saveWeb(on ? { transition: true } : { transition: false, colorMatch: false });
                setWeb(readJson(WEB_STORE));
              }}
              className="w-[15px] h-[15px] accent-accent" />
            片段转场
          </label>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked=${web.colorMatch === true}
              onChange=${(e) => {
                const on = e.target.checked;
                saveWeb(on ? { colorMatch: true, transition: true } : { colorMatch: false });
                setWeb(readJson(WEB_STORE));
              }}
              className="w-[15px] h-[15px] accent-accent" />
            接缝校色
          </label>
          <span className="text-[11px] text-ink3">校色依赖转场</span>
        </div>
      </div>

      <div className=${sec}>
        <div className="flex items-center gap-2 mb-1">
          <b className="text-[12.5px] font-medium text-ink">API Key</b>
          <span className="flex-1"></span>
          <span className="text-[10px] text-ink3">只存本机浏览器；生成时随请求发送，不落服务端</span>
        </div>
        ${GROUPS.map((g) => {
          const open = !g.collapsible || !!openGroups[g.id];
          return html`
            <div key=${g.id} className="py-2 border-b border-white/[.05] last:border-0">
              <div className="flex items-center gap-2">
                <b className="text-[12px] text-ink">${g.title}</b>
                <span className="flex-1"></span>
                ${g.collapsible && html`
                  <button onClick=${() => setOpenGroups((s) => ({ ...s, [g.id]: !open }))}
                    className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:bg-white/[.06]">
                    ${open ? '收起' : '展开'}
                  </button>
                `}
                ${open && !g.noTest && html`
                  <button onClick=${() => test(g)} disabled=${testing === g.id}
                    className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                               hover:bg-white/[.05] disabled:opacity-40"
                  >${testing === g.id ? '测试中…' : '测试连接'}</button>
                `}
              </div>
              ${open ? html`
                ${testRes[g.id] && html`
                  <p className=${'mt-1 text-[11px] ' + (testRes[g.id].ok ? 'text-accent' : 'text-danger')}>
                    ${testRes[g.id].ok ? '✓ ' : '✗ '}${testRes[g.id].text}
                  </p>
                `}
                ${g.fields.map((f) => html`
                  <div key=${f[0]} className="mt-1.5 flex items-center gap-2">
                    <span className="w-[84px] shrink-0 text-[11px] text-ink3">${f[1]}</span>
                    <div className="relative flex-1">
                      <input type=${f[2] === 'password' && !showKeys[f[0]] ? 'password' : 'text'}
                        value=${keys[f[0]] || ''}
                        onInput=${(e) => saveKey({ [f[0]]: e.target.value.trim() })}
                        autoComplete="off" spellCheck="false"
                        style=${{ paddingRight: f[2] === 'password' ? '56px' : undefined }}
                        className=${inputCls} />
                      ${f[2] === 'password' && html`
                        <button type="button"
                          onClick=${() => setShowKeys((s) => ({ ...s, [f[0]]: !s[f[0]] }))}
                          style=${{
                            position: 'absolute', right: '4px', top: '50%',
                            transform: 'translateY(-50%)',
                            width: '48px', height: '22px', padding: 0,
                            display: 'grid', placeItems: 'center',
                            borderRadius: '4px', fontSize: '11px', lineHeight: '1',
                            color: 'var(--ink3)', background: 'transparent',
                            border: '1px solid rgba(255,255,255,.10)', cursor: 'pointer'
                          }}
                          title=${showKeys[f[0]] ? '隐藏密钥' : '显示密钥'}
                          aria-label=${showKeys[f[0]] ? '隐藏密钥' : '显示密钥'}
                        >${showKeys[f[0]] ? '隐藏' : '显示'}</button>
                      `}
                      ${f[2] === 'password' && /[^\x20-\x7E]/.test(String(keys[f[0]] || '')) && html`
                        <p style=${{ margin: '6px 0 0', fontSize: '11px', lineHeight: '1.6', color: 'var(--danger, #ff6b6b)' }}>
                          这个字段里有中文/符号（含非 ASCII 字符）——多半是粘贴了页面上的提示文案。
                          请只填纯英文数字的 Key（一般以 sk- 开头）或纯英文地址。
                        </p>
                      `}
                    </div>
                  </div>
                `)}
                ${g.id === 'imagegen' && html`
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="w-[84px] shrink-0 text-[11px] text-ink3">接口类型</span>
                    <select value=${keys.imageProvider || 'dashscope'}
                      onChange=${(e) => saveKey({ imageProvider: e.target.value })}
                      className="h-8 flex-1 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                      <option value="dashscope">百炼原生（异步任务轮询）</option>
                      <option value="openai-images">OpenAI 兼容（WhaleTV / 中转 / OpenAI）</option>
                    </select>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
                    服务端：${imgStatus
                      ? (imgStatus.usable ? '已就绪' : (imgStatus.providerImplemented ? '未配置 Key' : '适配器未注册'))
                      : '读取中…'}
                    · 本机：${String(keys.imageKey || '').trim() ? '已填写' : '未填写'}
                  </p>
                  <p className="mt-1 text-[11px] leading-[1.7] text-ink3">
                    模型 / 尺寸留空即用默认 wan2.7-image / 1696x960（16:9）。填在这里的 Key 会随出图请求发送，不落服务端；
                    也可写 app/.env 的 IMAGE_GEN_API_KEY 作为服务端全局配置。
                  </p>
                  <p className="mt-1 text-[11px] leading-[1.7] text-warn">
                    第三方 / 中转 Key 必须填它给的 Base URL；官方百炼 Key 填
                    <code className="font-num"> https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1</code>。
                  </p>
                `}
              ` : html`
                <p className="mt-1 text-[11px] text-ink3">已折叠（点「展开」填写）</p>
              `}
            </div>
          `;
        })}
      </div>

      <div className=${sec}>
        <b className="block text-[12.5px] font-medium text-ink mb-2">备份 / 恢复</b>
        <div className="flex items-center gap-2">
          <button onClick=${exportCfg}
            className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]">导出配置</button>
          <label className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2
                            hover:bg-white/[.05] inline-flex items-center cursor-pointer">
            导入配置
            <input type="file" accept=".json,application/json" className="hidden" onChange=${importCfg} />
          </label>
          <span className="text-[10px] text-danger">备份文件含 API Key，注意保管</span>
        </div>
      </div>

      <div className=${sec}>
        <div className="flex items-center gap-2 mb-2">
          <b className="text-[12.5px] font-medium text-ink">成员管理</b>
          <span className="text-[10px] text-ink3 font-num">
            ${users.length} 名${authEnabled ? '' : ' · 登录墙未启用'}
          </span>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <input value=${nu} onInput=${(e) => setNu(e.target.value)} placeholder="用户名"
            className="h-8 w-[150px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
          <input value=${np} onInput=${(e) => setNp(e.target.value)} type="password" placeholder="密码（≥8 位）"
            className="h-8 w-[170px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
          <button onClick=${addUser}
            className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]">新建成员</button>
        </div>
        ${users.length === 0 && html`<p className="text-[11px] text-ink3">没有成员（或登录墙未启用）。</p>`}
        ${users.map((u) => html`
          <div key=${u.userId || u.id || u.username} className="flex items-center gap-3 py-1.5 border-t border-white/[.05]">
            <span className="text-[12px] text-ink w-[150px] truncate">${u.username}</span>
            <span className="text-[10px] text-ink3 font-num flex-1">
              ${(u.userId || u.id || '') === selfId ? '当前登录' : ''}
            </span>
            <button onClick=${() => resetPwd(u)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:bg-white/[.06]">重置密码</button>
            <button onClick=${() => delUser(u)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-danger hover:bg-white/[.06]">删除</button>
          </div>
        `)}
      </div>
    </div>
  `;
}
