// ============================================================
// 工作台（React 版第一块）
// ------------------------------------------------------------
// 本步目标：把「顶栏 + 三屏切换 + 创作屏骨架 + 真实任务列表」跑通。
// 刻意不做的事：不创建任务（会触发付费生成）、不改后端接口、不做审核/产出屏内容。
// 数据来源：GET /api/tasks（沿用既有契约，返回 { tasks: [...] } 或数组）
// ============================================================
import { navigate } from '../router.js';
import { promptBus } from '../store.js';
import { TaskDrawer } from '../components/taskDrawer.js';
import { Assistant } from '../components/assistant.js';
import { Boundary } from '../components/boundary.js';
import { OutputScreen } from './output.js';
import { SettingsDrawer } from '../components/settingsDrawer.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState, useCallback } = React;

const STAGES = [
  { key: 'create', label: '创作', route: '/' },
  { key: 'review', label: '审核', route: '/review' },
  { key: 'output', label: '产出', route: '/output' }
];

function stageOf(route) {
  if (route.startsWith('/review')) return 'review';
  if (route.startsWith('/output')) return 'output';
  return 'create';
}

function TopBar({ stage, onOpenSettings }) {
  return html`
    <header className="h-16 shrink-0 flex items-center gap-7 px-6 border-b border-black/[.06] bg-s3">
      <span className="font-display text-[22px] uppercase tracking-[.06em] text-accent select-none">
        Video Studio
      </span>
      <nav className="flex items-center gap-1.5">
        ${STAGES.map((s) =>
          html`<button
            key=${s.key}
            onClick=${() => navigate(s.route)}
            className=${[
              'h-9 px-4 rounded-[6px] text-[14px] transition-colors',
              s.key === stage
                ? 'bg-accent text-white'
                : 'text-ink2 hover:bg-black/[.04]'
            ].join(' ')}
          >${s.label}</button>`
        )}
      </nav>
      <span className="flex-1" />
      <span className="text-[12px] text-ink3 font-num">React ${React.version}</span>
      <button
        onClick=${onOpenSettings}
        className="h-9 px-3.5 rounded-[6px] text-[14px] text-ink2 hover:bg-black/[.04] transition-colors"
      >设置</button>
    </header>
  `;
}

function useTasks() {
  const [state, setState] = useState({ loading: true, tasks: [], error: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch('/api/tasks', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.tasks || []);
      setState({ loading: false, tasks: list, error: null });
    } catch (e) {
      setState({ loading: false, tasks: [], error: e.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return [state, load];
}

function StatusDot({ status }) {
  const map = {
    completed: 'bg-accent',
    failed: 'bg-danger',
    pending: 'bg-ink3'
  };
  const cls = map[status] || 'bg-warn';
  return html`<span className=${'inline-block w-[6px] h-[6px] rounded-full ' + cls} />`;
}

function CreateScreen() {
  const [prompt, setPrompt] = useState('');
  const [{ loading, tasks, error }, reload] = useTasks();
  const [openTaskId, setOpenTaskId] = useState(null);

  // 提示词助手生成后，通过总线把文本送进来（不跨组件直接摸 DOM）
  useEffect(() => promptBus.on((text) => setPrompt(text)), []);

  return html`
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="mx-auto w-full max-w-[1180px] px-7 py-8">
        <h2 className="font-display text-[26px] tracking-[.02em] text-ink">一句话，生成整条风景长片</h2>
        <p className="mt-2 text-[13px] text-ink2">输入你要的画面，系统自动分镜、生成、质检、拼接、配乐。</p>

        <div className="mt-6 rounded-[8px] border border-black/[.07] bg-s3 p-4">
          <textarea
            value=${prompt}
            onInput=${(e) => setPrompt(e.target.value)}
            rows="4"
            placeholder="例如：清晨的喀斯特峰林，低雾在谷间流动，侧逆光，缓慢推近……"
            className="w-full resize-none bg-transparent outline-none text-[14px] leading-[1.7] text-ink placeholder:text-ink3"
          />
          <div className="mt-3 flex items-center gap-3 border-t border-black/[.06] pt-3">
            <span className="text-[11px] text-ink3 font-num">${prompt.length} 字</span>
            <span className="flex-1" />
            <button
              disabled
              title="下一步接入 POST /api/tasks（会触发付费生成，需你确认后才启用）"
              className="h-9 px-4 rounded-[6px] bg-accent text-white text-[13px] opacity-40 cursor-not-allowed"
            >生成</button>
          </div>
        </div>

        <div className="mt-8 flex items-center gap-3">
          <h3 className="text-[13px] font-medium text-ink">最近任务</h3>
          <span className="text-[11px] text-ink3 font-num">
            ${loading ? '加载中…' : error ? '读取失败' : tasks.length + ' 条'}
          </span>
          <span className="flex-1" />
          <button
            onClick=${reload}
            className="h-7 px-2.5 rounded-[5px] text-[12px] text-ink2 hover:bg-black/[.04] transition-colors"
          >刷新</button>
        </div>

        ${error
          ? html`<p className="mt-3 text-[12px] text-danger">接口返回：${error}</p>`
          : tasks.length === 0 && !loading
            ? html`<p className="mt-3 text-[12px] text-ink3">还没有任务。</p>`
            : html`
              <ul className="mt-2 divide-y divide-black/[.05]">
                ${tasks.slice(0, 12).map((t) =>
                  html`<li key=${t.taskId}>
                    <button
                      onClick=${() => setOpenTaskId(t.taskId)}
                      className="w-full flex items-center gap-3 py-2.5 px-1 text-left rounded-[4px]
                                 hover:bg-black/[.03] transition-colors"
                    >
                      <${StatusDot} status=${t.status} />
                      <span className="text-[12px] text-ink truncate max-w-[520px]">
                        ${(t.prompt || '(无提示词)').slice(0, 60)}
                      </span>
                      <span className="flex-1" />
                      <span className="text-[11px] text-ink3 font-num">${t.status || '-'}</span>
                      <span className="text-[11px] text-ink3">›</span>
                    </button>
                  </li>`
                )}
              </ul>`
        }
      </div>
      ${openTaskId && html`
        <${Boundary} fallback=${(e) => html`
          <div className="fixed inset-x-0 bottom-4 mx-auto w-[min(520px,92vw)] rounded-[8px]
                          border border-danger/30 bg-s3 px-3 py-2 text-[12px] text-danger shadow-lg z-50">
            详情抽屉渲染失败：${String(e && e.message)}
            <button className="ml-2 underline" onClick=${() => setOpenTaskId(null)}>关闭</button>
          </div>
        `}>
          <${TaskDrawer} taskId=${openTaskId} onClose=${() => setOpenTaskId(null)} />
        </${Boundary}>
      `}
    </div>
  `;
}

function Placeholder({ title, note }) {
  return html`
    <div className="flex-1 grid place-items-center">
      <div className="text-center">
        <p className="font-display text-[20px] text-ink3">${title}</p>
        <p className="mt-2 text-[12px] text-ink3">${note}</p>
      </div>
    </div>
  `;
}

export function Workbench({ route }) {
  const stage = stageOf(route);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return html`
    <div className="h-full flex flex-col bg-s0 text-ink">
      <${TopBar} stage=${stage} onOpenSettings=${() => setSettingsOpen(true)} />
      ${stage === 'create' && html`<${CreateScreen} />`}
      ${stage === 'review' && html`<${Placeholder} title="审核" note="静帧接缝审核 · 下一步实现" />`}
      ${stage === 'output' && html`<${Boundary}><${OutputScreen} /></${Boundary}>`}
      <${Assistant} />
      ${settingsOpen && html`
        <${Boundary} fallback=${(e) => html`
          <div className="fixed inset-x-0 bottom-4 mx-auto w-[min(520px,92vw)] rounded-[8px] z-50
                          border border-danger/30 bg-s3 px-3 py-2 text-[12px] text-danger shadow-lg">
            设置抽屉渲染失败：${String(e && e.message)}
            <button className="ml-2 underline" onClick=${() => setSettingsOpen(false)}>关闭</button>
          </div>
        `}>
          <${SettingsDrawer} onClose=${() => setSettingsOpen(false)} />
        </${Boundary}>
      `}
    </div>
  `;
}
