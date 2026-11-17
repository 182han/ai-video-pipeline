// ============================================================
// 小智 2.0 V2 · 只读环境上下文（GET /api/assistant/context）
// ------------------------------------------------------------
// 后端：src/assistant/context.js（A–E 全只读：任务/预算/素材/设置/最近错误）
//      server.js 的 GET /api/assistant/context（登录墙内；?sessionId=&page=）
//
// 前端只做三件事（硬约束，verify-assistant-frontend.js 断言）：
//   · 上报当前页面：page = encodeURIComponent(location.pathname + location.search)；
//   · 把 A–E 的关键数字渲染成只读小卡片（不建任务、不触发付费）；
//   · Key **只显示有/无**：summarizeContext 只保留 { label, present }，
//     即使上游误传 value/secret 也不会被渲染或带出去。
// ============================================================
import { t as tr, has } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);

// 与 src/assistant/context.js 的 CONTEXT_KEYS 顺序一致；词条缺失时回退后端 label。
const KEY_LABEL_KEYS = [
  'assistant.context.keyWhaletv',
  'assistant.context.keyDashscope',
  'assistant.context.keyKling',
  'assistant.context.keyImage',
  'assistant.context.keyMultimodal',
  'assistant.context.keyLlm'
];

function locationOf(loc) {
  return loc || (typeof window !== 'undefined' ? window.location : null);
}

/** 上报的页面标识：pathname + search（含 /app 前缀，由后端截断到 60 字符）。 */
export function contextPageParam(loc) {
  const l = locationOf(loc);
  if (!l) return '/';
  return String(l.pathname || '/') + String(l.search || '');
}

/** GET 地址：sessionId 与 page 都必须 encodeURIComponent。 */
export function contextUrl(sessionId, page, loc) {
  const sid = encodeURIComponent(String(sessionId || ''));
  const raw = (page === undefined || page === null) ? contextPageParam(loc) : page;
  return '/api/assistant/context?sessionId=' + sid + '&page=' + encodeURIComponent(String(raw));
}

export function fetchAssistantContext(sessionId, opts = {}) {
  const url = contextUrl(sessionId, opts.page, opts.loc);
  const doFetch = opts.fetchImpl || fetch;
  return doFetch(url, { credentials: 'same-origin' }).then(async (r) => {
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      return { ok: false, error: (j && (j.error || j.code)) || ('HTTP ' + r.status) };
    }
    return j || { ok: false, error: 'HTTP ' + r.status };
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把 context 响应压成卡片用的紧凑结构。
 * 关键约束：keys 只保留 { label, present, index } —— 不带任何值。
 */
export function summarizeContext(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const tasks = c.tasks && typeof c.tasks === 'object' ? c.tasks : {};
  const budget = c.budget && typeof c.budget === 'object' ? c.budget : null;
  const assets = c.assets && typeof c.assets === 'object' ? c.assets : {};
  const photos = assets.photos || {};
  const library = assets.library || {};
  const cards = assets.sceneCards || {};
  const bgm = assets.bgm || {};
  const server = c.server || {};
  const settings = c.settings && typeof c.settings === 'object' ? c.settings : {};
  const keys = Array.isArray(settings.keys) ? settings.keys : [];
  const prefs = settings.preferences && typeof settings.preferences === 'object' ? settings.preferences : null;

  return {
    page: c.ui && c.ui.page ? String(c.ui.page) : '',
    tasks: {
      total: num(tasks.total),
      active: Array.isArray(tasks.active) ? tasks.active.length : 0,
      failed: Array.isArray(tasks.failedRecent) ? tasks.failedRecent.length : 0
    },
    budget: budget
      ? {
        currency: String(budget.currency || 'USD'),
        spentUsd: num(budget.spentUsd),
        balanceUsd: num(budget.balanceUsd)
      }
      : null,
    assets: {
      photosUsable: num(photos.usable),
      photosAll: num(photos.all),
      finals: num(library.finals),
      clips: num(library.clips),
      sceneCards: num(cards.features) + num(cards.buffers),
      bgm: num(bgm.tracks)
    },
    server: {
      pid: server.pid ? String(server.pid) : '',
      uptimeSec: num(server.uptimeSec),
      ffmpeg: server.ffmpegAvailable === true
    },
    // 只保留 label + present：这是「Key 只报有/无」的最后一道前端防线。
    keys: keys.map((k, i) => ({
      label: String((k && k.label) || ''),
      present: !!(k && k.present === true),
      index: i
    })),
    preferences: prefs
      ? {
        model: String(prefs.model || ''),
        modelLabel: String(prefs.modelLabel || ''),
        resolution: String(prefs.resolution || ''),
        clipDurationSec: num(prefs.clipDurationSec),
        bgmStyle: String(prefs.bgmStyle || ''),
        updatedAt: prefs.updatedAt ? String(prefs.updatedAt) : ''
      }
      : null
  };
}

// 运行时长：纯 ASCII（h/m），不依赖词条。
function uptimeText(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return (h > 0 ? h + 'h ' : '') + m + 'm';
}

function row(label, value) {
  return html`
    <div className="mt-1 flex items-start gap-2">
      <span className="w-[64px] shrink-0 text-[11px] text-ink3">${label}</span>
      <span className="flex-1 text-[11px] leading-[1.6] text-ink2 break-words">${value}</span>
    </div>
  `;
}

function keyLabelOf(k, index) {
  const key = KEY_LABEL_KEYS[index];
  if (key && has(key)) return tr(key);
  return k.label || '—';
}

export function AssistantContextCard({ ctx, loading, error, onRefresh } = {}) {
  const summary = ctx ? summarizeContext(ctx) : null;
  return html`
    <div className="rounded-[8px] border border-white/[.08] bg-s1 px-3 py-2.5" data-card="assistant-context">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-ink">${tr('assistant.context.title')}</span>
        ${loading ? html`<span className="text-[10px] text-ink3">${tr('assistant.context.loading')}</span>` : null}
        <span className="flex-1"></span>
        <button
          type="button"
          onClick=${() => { if (onRefresh) onRefresh(); }}
          className="h-6 px-2 rounded-[4px] text-[10px] text-ink3 hover:bg-white/[.05]"
        >${tr('assistant.context.refresh')}</button>
      </div>
      ${error ? html`
        <p className="mt-1.5 text-[11px] leading-[1.6] text-danger">${error}</p>
      ` : null}
      ${summary ? html`
        ${summary.page ? row(tr('assistant.context.page'), summary.page) : null}
        ${row(tr('assistant.context.tasks'), tr('assistant.context.tasksValue', {
          total: summary.tasks.total,
          active: summary.tasks.active,
          failed: summary.tasks.failed
        }))}
        ${row(tr('assistant.context.budget'), summary.budget
          ? tr('assistant.context.budgetValue', {
            currency: summary.budget.currency,
            spent: summary.budget.spentUsd.toFixed(2),
            balance: summary.budget.balanceUsd.toFixed(2)
          })
          : tr('assistant.context.budgetUnknown'))}
        ${row(tr('assistant.context.assets'), tr('assistant.context.assetsValue', {
          photos: summary.assets.photosUsable,
          all: summary.assets.photosAll,
          finals: summary.assets.finals,
          clips: summary.assets.clips,
          scenes: summary.assets.sceneCards,
          bgm: summary.assets.bgm
        }))}
        ${row(tr('assistant.context.service'), tr('assistant.context.serviceValue', {
          pid: summary.server.pid || '—',
          uptime: uptimeText(summary.server.uptimeSec),
          ffmpeg: summary.server.ffmpeg ? tr('assistant.context.ffmpegOn') : tr('assistant.context.ffmpegOff')
        }))}
        ${summary.preferences ? row(tr('assistant.context.prefs'), tr('assistant.context.prefsValue', {
          model: summary.preferences.modelLabel || summary.preferences.model || '—',
          resolution: summary.preferences.resolution || '—',
          sec: summary.preferences.clipDurationSec || 0
        })) : null}
        <div className="mt-1 flex items-start gap-2">
          <span className="w-[64px] shrink-0 text-[11px] text-ink3">${tr('assistant.context.keys')}</span>
          <span className="flex-1 flex flex-wrap gap-x-3 gap-y-1">
            ${summary.keys.map((k, i) => html`
              <span key=${i} className="text-[11px] text-ink2">
                ${keyLabelOf(k, i)}
                <b className=${k.present ? 'text-accent' : 'text-ink3'}>
                  ${k.present ? tr('assistant.context.keyPresent') : tr('assistant.context.keyAbsent')}
                </b>
              </span>
            `)}
          </span>
        </div>
      ` : null}
      <p className="mt-1.5 text-[10px] leading-[1.6] text-ink3">${tr('assistant.context.note')}</p>
    </div>
  `;
}
