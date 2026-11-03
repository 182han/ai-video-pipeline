// ============================================================
// 应用外壳：左侧导航 + 右侧视图（2026-10-31 重构）
// ------------------------------------------------------------
// 路由（/app 前缀，见 router.js）：
//   /            创作（六步向导）
//   /edit        剪辑台（调节滑杆；2026-11-02 落地）
//   /clips       库存 · 视频片段
//   /photos      库存 · 照片
//   /music       库存 · 配乐
//   /bgm         配乐编辑器（任务列表）
//   /bgm/:id     配乐编辑器（直接进入某条已完成成片，刷新可直达）
//   /history     记录 · 历史 + 垃圾箱
//   /output      记录 · 产出
//   /templates   模板库（入口在向导第 1 步的小提示里）
//   /gen         生成中
//   /settings    设置
// ============================================================
import { navigate } from '../router.js';
import { JobBar, useTasksPoll } from '../components/jobBar.js';
import { Assistant } from '../components/assistant.js';
import { Boundary } from '../components/boundary.js';
import { CreateWizard } from './create.js';
import { GenView } from './gen.js';
import { ClipsView, PhotosView, MusicView } from './inventory.js';
import { BgmEditorView } from './bgmEditor.js';
import { HistoryView } from './history.js';
import { TemplatesView } from './templates.js';
import { SettingsView } from './settingsPage.js';
import { OutputScreen } from './output.js';
import { AdjustEditorView } from './adjustEditor.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect } = React;

const NAV = [
  { key: 'create', route: '/', label: '创作', icon: '◆' },
  { key: 'edit', route: '/edit', label: '剪辑', icon: '✂' },
  { section: '库存' },
  { key: 'clips', route: '/clips', label: '视频片段', icon: '▤', sub: true },
  { key: 'photos', route: '/photos', label: '照片', icon: '◫', sub: true },
  { key: 'music', route: '/music', label: '配乐', icon: '♪', sub: true },
  { key: 'bgm', route: '/bgm', label: '配乐编辑器', icon: '✎', sub: true },
  { section: '记录' },
  { key: 'history', route: '/history', label: '历史记录', icon: '≣' },
  { key: 'output', route: '/output', label: '产出', icon: '▶' }
];

function viewOf(route) {
  if (route.startsWith('/edit')) return 'edit';
  if (route.startsWith('/clips')) return 'clips';
  if (route.startsWith('/photos')) return 'photos';
  if (route.startsWith('/music')) return 'music';
  if (route.startsWith('/bgm')) return 'bgm';
  if (route.startsWith('/history')) return 'history';
  if (route.startsWith('/output')) return 'output';
  if (route.startsWith('/templates')) return 'templates';
  if (route.startsWith('/gen')) return 'gen';
  if (route.startsWith('/settings')) return 'settings';
  return 'create';
}

function RailItem({ item, active }) {
  return html`
    <button
      onClick=${() => navigate(item.route)}
      className=${[
        'flex items-center gap-2.5 mx-2.5 my-[1px] px-2.5 rounded-[5px] text-left transition-colors',
        item.sub ? 'h-[30px] text-[12.5px] pl-7' : 'h-[33px] text-[13px]',
        active
          ? 'bg-accent/[.13] text-accent'
          : (item.sub ? 'text-ink3 hover:bg-white/[.05] hover:text-ink2' : 'text-ink2 hover:bg-white/[.05] hover:text-ink')
      ].join(' ')}
    >
      <span className="w-[13px] text-center text-[11px] font-num opacity-80">${item.icon}</span>
      <span className="truncate">${item.label}</span>
      ${item.tail && html`<span className="ml-auto text-[10px] font-num text-ink3">${item.tail}</span>`}
    </button>
  `;
}

function Rail({ view }) {
  const routeOf = {
    create: '/', edit: '/edit', clips: '/clips', photos: '/photos',
    music: '/music', bgm: '/bgm', history: '/history', output: '/output'
  };
  return html`
    <aside className="bg-s1 border-r border-white/[.08] flex flex-col py-4 min-h-0 overflow-auto">
      <div className="font-display text-[14px] uppercase tracking-[.13em] px-4 pb-3.5 text-ink select-none">
        Video Studio
      </div>

      ${NAV.map((n, i) =>
        n.section
          ? html`<div key=${'s' + i} className="px-4 pt-3.5 pb-1.5 text-[10px] tracking-[.14em] uppercase text-ink3 font-num">${n.section}</div>`
          : html`<${RailItem} key=${n.key} item=${n} active=${routeOf[view] === n.route} />`
      )}

      <span className="flex-1"></span>
      <${RailItem} item=${{ route: '/settings', label: '设置', icon: '⚙' }} active=${view === 'settings'} />
    </aside>
  `;
}

export function AppShell({ route }) {
  const view = viewOf(route);
  const [tasks, refreshTasks] = useTasksPoll();

  // 切视图时回到顶部（长列表否则会保留滚动位置）
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  return html`
    <div className="h-full grid grid-cols-[212px_minmax(0,1fr)] bg-s0 text-ink overflow-hidden">
      <${Rail} view=${view} />

      <div className="flex flex-col min-h-0 min-w-0">
        <${JobBar} tasks=${tasks} onChanged=${refreshTasks} />

        <div className="flex-1 min-h-0 overflow-auto">
          ${view === 'create' && html`<${Boundary}><${CreateWizard} tasks=${tasks} onChanged=${refreshTasks} /></${Boundary}>`}
          ${view === 'gen' && html`<${Boundary}><${GenView} tasks=${tasks} onChanged=${refreshTasks} /></${Boundary}>`}
          ${view === 'clips' && html`<${Boundary}><${ClipsView} /></${Boundary}>`}
          ${view === 'photos' && html`<${Boundary}><${PhotosView} /></${Boundary}>`}
          ${view === 'music' && html`<${Boundary}><${MusicView} /></${Boundary}>`}
          ${view === 'bgm' && html`<${Boundary}><${BgmEditorView} route=${route} /></${Boundary}>`}
          ${view === 'history' && html`<${Boundary}><${HistoryView} tasks=${tasks} onChanged=${refreshTasks} /></${Boundary}>`}
          ${view === 'output' && html`<${Boundary}><${OutputScreen} /></${Boundary}>`}
          ${view === 'templates' && html`<${Boundary}><${TemplatesView} /></${Boundary}>`}
          ${view === 'settings' && html`<${Boundary}><${SettingsView} /></${Boundary}>`}
          ${view === 'edit' && html`<${Boundary}><${AdjustEditorView} /></${Boundary}>`}
        </div>
      </div>

      <${Assistant} />
    </div>
  `;
}
