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
import { t, tp } from '../i18n/index.js';
import { LangSwitch } from '../components/langSwitch.js';
// 小智 2.0 V2：服务端跨会话偏好（只读展示 + 二次确认后清空）。
import { AssistantPreferencesSection } from '../components/assistantPreferences.js';

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
  { id: 'seedance', titleKey: 'settings.group.seedance', collapsible: true, fields: [['seedanceKey', 'API Key', 'password'], ['seedanceBaseUrl', 'Base URL', 'text'], ['seedanceModel', '@model', 'text']] },
  { id: 'kling', titleKey: 'settings.group.kling', collapsible: true, fields: [['klingAk', 'AccessKey', 'text'], ['klingSk', 'SecretKey', 'password']] },
  { id: 'dashscope', titleKey: 'settings.group.dashscope', fields: [['dashScopeKey', 'API Key', 'password'], ['dashScopeRegion', '@region', 'text'], ['dashScopeWorkspaceId', 'WorkspaceId', 'text']] },
  {
    id: 'whaletv',
    titleKey: 'settings.group.whaletv',
    fields: [
      ['whaletvKey', 'API Key', 'password'],
      ['whaletvBaseUrl', 'Base URL', 'text'],
      ['whaletvVideoModel', '@model', 'text']
    ]
  },
  {
    id: 'imagegen',
    titleKey: 'settings.group.imagegen',
    fields: [
      ['imageKey', 'API Key', 'password'],
      ['imageBaseUrl', 'Base URL', 'text'],
      ['imageModel', '@model', 'text'],
      ['imageSize', '@size', 'text']
    ]
  },
  { id: 'llm', titleKey: 'settings.group.llm', fields: [['llmKey', 'API Key', 'password'], ['llmUrl', 'Base URL', 'text'], ['llmModel', '@model', 'text']] },
  { id: 'multimodal', titleKey: 'settings.group.multimodal', fields: [['multimodalKey', 'API Key', 'password'], ['multimodalUrl', 'Base URL', 'text'], ['multimodalModel', '@model', 'text']] }
];

// 字段标签里的 @xxx 走词条；API Key / Base URL / AccessKey 等专有名词保持原文。
const FIELD_LABELS = { '@model': 'settings.field.model', '@region': 'settings.field.region', '@size': 'settings.field.size' };
const fieldLabel = (label) => (FIELD_LABELS[label] ? t(FIELD_LABELS[label]) : label);

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
  const [nr, setNr] = useState('member');
  const [canManage, setCanManage] = useState(false);
  const [ownerUsername, setOwnerUsername] = useState('');
  const [imgStatus, setImgStatus] = useState(null);
  const [openGroups, setOpenGroups] = useState({});
  const [showKeys, setShowKeys] = useState({});
  // 2026-11-19 B 目标：小智 agent 总开关（一键关回规则路径；保存后下一条消息生效）
  const [agentSwitch, setAgentSwitch] = useState(null);

  async function loadUsers() {
    try {
      const j = await fetchJson('/api/users');
      setUsers(j.users || []);
      setAuthEnabled(!!j.authEnabled);
      setSelfId(j.selfId || '');
      setCanManage(!!j.canManage);
      setOwnerUsername(j.ownerUsername || '');
    } catch (e) { /* 保持静默，和原来一致 */ }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    fetchJson('/api/image-gen/status')
      .then(setImgStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchJson('/api/assistant/agent')
      .then((j) => setAgentSwitch(j))
      .catch((e) => setErr(t('settings.xiaozhi.agentLoadFailed', { error: e.message })));
  }, []);

  async function toggleAgent(next) {
    setErr('');
    setMsg('');
    try {
      const j = await fetchJson('/api/assistant/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!next })
      });
      setAgentSwitch(j);
      setMsg(t('settings.xiaozhi.agentSaved'));
    } catch (e) {
      setErr(t('settings.xiaozhi.agentFailed', { error: e.message }));
    }
  }

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
      let text = j.success ? (j.message || t('settings.keys.connected')) : (j.error || t('settings.keys.failed'));
      if (!j.success && /未知的测试类型/.test(text)) { // i18n-allow: backend Chinese error match
        text += t('settings.keys.oldServer');
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
        if (!cfg || typeof cfg !== 'object') throw new Error(t('settings.backup.noConfig'));
        localStorage.setItem(KEY_STORE, JSON.stringify(cfg));
        if (raw.webConfig) localStorage.setItem(WEB_STORE, JSON.stringify(raw.webConfig));
        setKeys(readJson(KEY_STORE)); setWeb(readJson(WEB_STORE));
        setMsg(t('settings.backup.restored'));
      } catch (x) { setErr(t('settings.backup.failed') + x.message); }
    };
    reader.readAsText(f);
    e.target.value = '';
  }

  async function addUser() {
    setErr(''); setMsg('');
    if (!canManage) return;
    try {
      await fetchJson('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: nu.trim(), password: np, role: nr })
      });
      setNu(''); setNp(''); setNr('member');
      await loadUsers();
      setMsg(t('settings.members.created'));
    } catch (e) { setErr(t('settings.members.createFailed') + e.message); }
  }

  async function resetPwd(u) {
    if (!canManage) return;
    const pwd = window.prompt(t('settings.members.resetPrompt', { name: u.username }));
    if (!pwd) return;
    setErr(''); setMsg('');
    try {
      await fetchJson('/api/users/' + encodeURIComponent(u.userId || u.id) + '/password', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      setMsg(t('settings.members.resetDone'));
    } catch (e) { setErr(t('settings.members.resetFailed') + e.message); }
  }

  async function delUser(u) {
    if (!canManage) return;
    if (!window.confirm(t('settings.members.deleteConfirm', { name: u.username }))) return;
    setErr(''); setMsg('');
    try {
      await fetchJson('/api/users/' + encodeURIComponent(u.userId || u.id), { method: 'DELETE' });
      await loadUsers();
    } catch (e) { setErr(t('settings.members.deleteFailed') + e.message); }
  }

  const sec = 'rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3 mb-3.5';

  return html`
    <div className="px-6 py-5 max-w-[1040px]">
      <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0 mb-3.5">${t('settings.title')}</h1>
      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}
      ${msg && html`<p className="mb-2 text-[12px] text-accent">${msg}</p>`}

      <div className=${sec}>
        <b className="block text-[12.5px] font-medium text-ink mb-2">${t('settings.language.title')}</b>
        <p className="text-[11px] leading-[1.7] text-ink3 mt-0 mb-2">${t('settings.language.desc')}</p>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[12px] text-ink2 w-[84px]">${t('settings.language.display')}</span>
          <${LangSwitch} />
        </div>
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          <span className="text-[12px] text-ink2 w-[84px]">${t('settings.language.aiTitle')}</span>
          <select value=${keys.aiLang || ''} onChange=${(e) => saveKey({ aiLang: e.target.value })}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            <option value="">${t('common.followUi')}</option>
            <option value="zh">${t('settings.language.zh')}</option>
            <option value="en">${t('settings.language.en')}</option>
          </select>
          <span className="text-[11px] text-ink3">${t('settings.language.aiDesc')}</span>
        </div>
      </div>

      <div className=${sec}>
        <b className="block text-[12.5px] font-medium text-ink mb-2">${t('settings.general.title')}</b>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[12px] text-ink2 w-[64px]">${t('settings.general.videoModel')}</span>
          <select value=${web.videoModel || 'seedance'} onChange=${(e) => saveWeb({ videoModel: e.target.value })}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            <option value="seedance">Seedance 2.5</option>
            <option value="kling">${t('settings.group.kling')}</option>
            <option value="dashscope">${t('settings.group.dashscope')}</option>
          </select>
          <span className="text-[12px] text-ink2 w-[54px]">${t('settings.general.resolution')}</span>
          <select value=${web.resolution || '1080p'} onChange=${(e) => saveWeb({ resolution: e.target.value })}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            ${['720p', '1080p', '4K'].map((r) => html`<option key=${r} value=${r}>${r}</option>`)}
          </select>
          <span className="text-[12px] text-ink2 w-[40px]">${t('settings.general.preset')}</span>
          <select value=${web.preset || 'final'} onChange=${(e) => saveWeb({ preset: e.target.value })}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            ${['final', 'daily', 'quick', 'clips_only'].map((x) => html`<option key=${x} value=${x}>${x}</option>`)}
          </select>
        </div>
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          <span className="text-[12px] text-ink2 w-[64px]">${t('settings.general.balance')}</span>
          <input type="number" step="0.01" min="0" value=${web.balance !== undefined ? web.balance : ''}
            onInput=${(e) => saveWeb({ balance: e.target.value })}
            placeholder=${t('settings.general.balancePlaceholder')}
            className="h-8 w-[140px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink font-num outline-none" />
          <span className="text-[11px] text-ink3">${t('settings.general.balanceHint')}</span>
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
            ${t('settings.general.transition')}
          </label>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked=${web.colorMatch === true}
              onChange=${(e) => {
                const on = e.target.checked;
                saveWeb(on ? { colorMatch: true, transition: true } : { colorMatch: false });
                setWeb(readJson(WEB_STORE));
              }}
              className="w-[15px] h-[15px] accent-accent" />
            ${t('settings.general.colorMatch')}
          </label>
          <span className="text-[11px] text-ink3">${t('settings.general.colorMatchHint')}</span>
        </div>
      </div>

      <div className=${sec}>
        <b className="block text-[12.5px] font-medium text-ink mb-2">${t('settings.xiaozhi.title')}</b>
        <${AssistantPreferencesSection} />
        <div className="mt-3 pt-3 border-t border-white/[.06]">
          <div className="flex items-center gap-2 flex-wrap">
            <b className="text-[12px] text-ink">${t('settings.xiaozhi.agentTitle')}</b>
            <span className="text-[10px] text-ink3">
              ${agentSwitch && agentSwitch.enabled ? t('settings.xiaozhi.agentOn') : t('settings.xiaozhi.agentOff')}
            </span>
            <span className="flex-1"></span>
            <button onClick=${() => { if (agentSwitch && agentSwitch.envForced) return; toggleAgent(!(agentSwitch && agentSwitch.enabled)); }}
              disabled=${!!(agentSwitch && agentSwitch.envForced)}
              style=${agentSwitch && agentSwitch.envForced ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              className="h-8 px-3 rounded-[5px] border border-white/[.09] bg-s2 text-[12px] text-ink hover:bg-white/[.06]">
              ${agentSwitch && agentSwitch.enabled ? t('settings.xiaozhi.agentDisable') : t('settings.xiaozhi.agentEnable')}
            </button>
          </div>
          <p className="text-[11px] leading-[1.7] text-ink3 mt-1 mb-0">${t('settings.xiaozhi.agentDesc')}</p>
          ${agentSwitch && agentSwitch.envForced && html`
            <p className="text-[11px] text-danger mt-1 mb-0">${t('settings.xiaozhi.agentEnvForced')}</p>
          `}
        </div>
      </div>

      <div className=${sec}>
        <div className="flex items-center gap-2 mb-1">
          <b className="text-[12.5px] font-medium text-ink">${t('settings.keys.title')}</b>
          <span className="flex-1"></span>
          <span className="text-[10px] text-ink3">${t('settings.keys.hint')}</span>
        </div>
        ${GROUPS.map((g) => {
          const open = !g.collapsible || !!openGroups[g.id];
          return html`
            <div key=${g.id} className="py-2 border-b border-white/[.05] last:border-0">
              <div className="flex items-center gap-2">
                <b className="text-[12px] text-ink">${t(g.titleKey)}</b>
                <span className="flex-1"></span>
                ${g.collapsible && html`
                  <button onClick=${() => setOpenGroups((s) => ({ ...s, [g.id]: !open }))}
                    className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:bg-white/[.06]">
                    ${open ? t('settings.keys.collapse') : t('settings.keys.expand')}
                  </button>
                `}
                ${open && !g.noTest && html`
                  <button onClick=${() => test(g)} disabled=${testing === g.id}
                    className="h-7 px-2.5 rounded-[5px] border border-white/[.10] text-[11px] text-ink2
                               hover:bg-white/[.05] disabled:opacity-40"
                  >${testing === g.id ? t('settings.keys.testing') : t('settings.keys.test')}</button>
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
                    <span className="w-[84px] shrink-0 text-[11px] text-ink3">${fieldLabel(f[1])}</span>
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
                            border: '1px solid rgb(var(--ink-rgb) / .10)', cursor: 'pointer'
                          }}
                          title=${showKeys[f[0]] ? t('settings.keys.hideKey') : t('settings.keys.showKey')}
                          aria-label=${showKeys[f[0]] ? t('settings.keys.hideKey') : t('settings.keys.showKey')}
                        >${showKeys[f[0]] ? t('settings.keys.hide') : t('settings.keys.show')}</button>
                      `}
                      ${f[2] === 'password' && /[^\x20-\x7E]/.test(String(keys[f[0]] || '')) && html`
                        <p style=${{ margin: '6px 0 0', fontSize: '11px', lineHeight: '1.6', color: 'var(--danger, #ff6b6b)' }}>
                          ${t('settings.keys.nonAscii')}
                        </p>
                      `}
                    </div>
                  </div>
                `)}
                ${g.id === 'imagegen' && html`
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="w-[84px] shrink-0 text-[11px] text-ink3">${t('settings.keys.imageType')}</span>
                    <select value=${keys.imageProvider || 'dashscope'}
                      onChange=${(e) => saveKey({ imageProvider: e.target.value })}
                      className="h-8 flex-1 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
                      <option value="dashscope">${t('settings.keys.imageDashscope')}</option>
                      <option value="openai-images">${t('settings.keys.imageOpenai')}</option>
                    </select>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-[1.7] text-ink3">
                    ${t('settings.keys.server')}${imgStatus
                      ? (imgStatus.usable ? t('settings.keys.ready') : (imgStatus.providerImplemented ? t('settings.keys.noKey') : t('settings.keys.noAdapter')))
                      : t('settings.keys.reading')}${t('settings.keys.local')}${String(keys.imageKey || '').trim() ? t('settings.keys.filled') : t('settings.keys.empty')}
                  </p>
                  <p className="mt-1 text-[11px] leading-[1.7] text-ink3">
                    ${t('settings.keys.imageNote')}
                  </p>
                  <p className="mt-1 text-[11px] leading-[1.7] text-ink3">
                    ${t('settings.keys.imageGradeDefault', {
                      value: (imgStatus && imgStatus.imageGrade)
                        ? (imgStatus.imageGrade.default === 'calm'
                          ? t('settings.keys.gradeOn')
                          : t('settings.keys.gradeOff'))
                        : (imgStatus ? t('settings.keys.imageGradeMissing') : t('settings.keys.reading'))
                    })}
                  </p>
                  <p className="mt-1 text-[11px] leading-[1.7] text-warn">
                    ${t('settings.keys.imageBase')}
                    <code className="font-num"> https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1</code>。
                  </p>
                `}
              ` : html`
                <p className="mt-1 text-[11px] text-ink3">${t('settings.keys.collapsed')}</p>
              `}
            </div>
          `;
        })}
      </div>

      <div className=${sec}>
        <b className="block text-[12.5px] font-medium text-ink mb-2">${t('settings.backup.title')}</b>
        <div className="flex items-center gap-2">
          <button onClick=${exportCfg}
            className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]">${t('settings.backup.export')}</button>
          <label className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2
                            hover:bg-white/[.05] inline-flex items-center cursor-pointer">
            ${t('settings.backup.import')}
            <input type="file" accept=".json,application/json" className="hidden" onChange=${importCfg} />
          </label>
          <span className="text-[10px] text-danger">${t('settings.backup.warn')}</span>
        </div>
      </div>

      <div className=${sec}>
        <div className="flex items-center gap-2 mb-2">
          <b className="text-[12.5px] font-medium text-ink">${t('settings.members.title')}</b>
          <span className="text-[10px] text-ink3 font-num">
            ${tp('settings.members.count', users.length)}${authEnabled ? '' : t('settings.members.authOff')}
          </span>
        </div>
        ${canManage && html`
        <div className="flex items-center gap-2 mb-2">
          <input value=${nu} onInput=${(e) => setNu(e.target.value)} placeholder=${t('settings.members.username')}
            className="h-8 w-[150px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
          <input value=${np} onInput=${(e) => setNp(e.target.value)} type="password" placeholder=${t('settings.members.password')}
            className="h-8 w-[170px] rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none placeholder:text-ink3" />
          <select value=${nr} onChange=${(e) => setNr(e.target.value)}
            className="h-8 rounded-[5px] border border-white/[.09] bg-s2 px-2 text-[12px] text-ink outline-none">
            <option value="member">${t('settings.members.roleMember')}</option>
            <option value="demo">${t('settings.members.roleDemo')}</option>
          </select>
          <button onClick=${addUser}
            className="h-8 px-3 rounded-[6px] bg-accent text-onaccent text-[12px]">${t('settings.members.add')}</button>
        </div>
        `}
        ${!canManage && html`<p className="text-[11px] text-ink3 mb-2">${t('settings.members.manageHint')}</p>`}
        ${users.length === 0 && html`<p className="text-[11px] text-ink3">${t('settings.members.empty')}</p>`}
        ${users.map((u) => html`
          <div key=${u.userId || u.id || u.username} className="flex items-center gap-3 py-1.5 border-t border-white/[.05]">
            <span className="text-[12px] text-ink w-[140px] truncate">${u.username}</span>
            <span className="text-[10px] text-ink3" style=${{ border: '1px solid rgba(255,255,255,.12)', borderRadius: '4px', padding: '0 4px' }}>
              ${u.username === ownerUsername ? t('settings.members.owner') : (u.role === 'demo' ? t('settings.members.roleDemo') : t('settings.members.roleMember'))}
            </span>
            <span className="text-[10px] text-ink3 font-num flex-1">
              ${(u.userId || u.id || '') === selfId ? t('settings.members.self') : ''}
            </span>
            ${canManage && html`<button onClick=${() => resetPwd(u)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:bg-white/[.06]">${t('settings.members.reset')}</button>`}
            ${canManage && html`<button onClick=${() => delUser(u)}
              className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-danger hover:bg-white/[.06]">${t('settings.members.delete')}</button>`}
          </div>
        `)}
      </div>
    </div>
  `;
}
