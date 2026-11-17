// ============================================================
// 应用外壳：左侧导航 + 右侧视图（2026-10-31 重构；2026-11-15 P2 库 IA；2026-11-16 P6 下线记录/产出）
// ------------------------------------------------------------
// 路由（/app 前缀，见 router.js）：
//   /            创作（六步向导）
//   /edit        剪辑台（调节滑杆；2026-11-02 落地）
//   /library     库（2026-11-15 P2：成片 / 片段 / 图片 三 tab + 回收站；
//                2026-11-16 P6：成片 tab 增加「未完成」失败任务卡片，见 inventory.js UnfinishedPanel）
//   /clips       旧深链 → 库 · 片段 tab（保留兼容，导航不再单列）
//   /photos      旧深链 → 库 · 图片 tab（保留兼容，导航不再单列）
//   /music       配乐（入口已移除，面板并入剪辑台；深链保留）
//   /bgm         已并入剪辑台：落到 /edit 新建/续用工程（2026-11-04 F11）
//   /bgm/:id     同上（旧深链兼容，不再有独立配乐编辑器入口）
//   /history     已下线（P6）：旧深链 / 书签一律落到「库 · 成片」，不再有历史页视图
//   /output      已下线（P6）：同上（产出并入「库 · 成片」）
//   /templates   模板库（入口在向导第 1 步的小提示里）
//   /gen         生成中
//   /settings    设置
// ============================================================
import { navigate } from '../router.js';
import { t } from '../i18n/index.js';
import { LangSwitch } from '../components/langSwitch.js';
import { JobBar, useTasksPoll } from '../components/jobBar.js';
// 2026-11-16 用户口径（P4）：全局悬浮小助手下线 —— 小智只保留两处：
// ① 首页 `/` 的整页小智（AssistantPage）② 左栏「小智 · 对话首页」入口。
// 因此这里不再 import / 挂载 <Assistant />。
import { Boundary } from '../components/boundary.js';
import { AssistantPage } from './assistantPage.js';
import { CreateWizard } from './create.js';
// 2026-11-16 P2：小智流程版五步向导（先并存在 /create-smart，验收后再替换默认入口）
import { CreateSmartWizard } from './createSmart.js';
import { GenView } from './gen.js';
import { LibraryView, MusicView } from './inventory.js';
import { TemplatesView } from './templates.js';
import { SettingsView } from './settingsPage.js';
import { EditorView } from './editor.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect } = React;

// 气泡导航 4 项：创作 / 剪辑 / 库 / 设置（设置固定在底部）。
// 历史记录与产出已于 P6 下线（不再有视图/路由项）；失败任务改由「库 · 成片」的未完成卡片承接。
// 配乐入口并入剪辑台。
const NAV = [
  { key: 'create', route: '/create-smart', icon: '◆', labelKey: 'nav.create' },
  { key: 'edit', route: '/edit', icon: '✂', labelKey: 'nav.edit' },
  { sectionKey: 'nav.materials' },
  { key: 'library', route: '/library', icon: '▤', labelKey: 'nav.library' }
];

function viewOf(route) {
  // 2026-11-16：登录后的 `/` = 整页「小智」对话页；默认创作 = /create-smart（旧六步向导 /create 仍可按 URL 打开）。
  if (route === '/' || route === '') return 'home';
  if (route.startsWith('/create-smart')) return 'createSmart';
  if (route.startsWith('/create')) return 'create';
  if (route.startsWith('/edit')) return 'edit';
  if (route.startsWith('/clips')) return 'library';
  if (route.startsWith('/photos')) return 'library';
  if (route.startsWith('/library')) return 'library';
  if (route.startsWith('/music')) return 'music';
  if (route.startsWith('/bgm')) return 'edit'; // F11：旧配乐入口落剪辑台
  // P6：历史 / 产出已下线，旧深链与书签落「库 · 成片」（失败任务在成片 tab 的未完成卡片里可见）
  if (route.startsWith('/history')) return 'library';
  if (route.startsWith('/output')) return 'library';
  if (route.startsWith('/templates')) return 'templates';
  if (route.startsWith('/gen')) return 'gen';
  if (route.startsWith('/settings')) return 'settings';
  return 'createSmart';
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
    create: '/create-smart', createSmart: '/create-smart', edit: '/edit', library: '/library', music: '/music'
  };
  // 2026-11-16 用户问「进入板块后怎么退出」：左栏顶部固定「小智 · 对话首页」入口，点击回 /。
  return html`
    <aside aria-label=${t('nav.mainAria')} className="bg-s1 border-r border-white/[.08] flex flex-col py-4 min-h-0 overflow-auto">
      <div className="font-display text-[14px] uppercase tracking-[.13em] px-4 pb-3.5 text-ink select-none">
        Video Studio
      </div>

      <button
        type="button"
        onClick=${() => navigate('/')}
        title=${t('nav.homeAria')}
        aria-label=${t('nav.homeAria')}
        className="rail-home"
      >
        <span className="rail-home-orb" aria-hidden="true"></span>
        <span className="min-w-0">
          <span className="rail-home-title">${t('nav.home')}</span>
          <span className="rail-home-sub">${t('nav.homeSub')}</span>
        </span>
      </button>

      ${NAV.map((n, i) =>
        n.sectionKey
          ? html`<div key=${'s' + i} className="px-4 pt-3.5 pb-1.5 text-[10px] tracking-[.14em] uppercase text-ink3 font-num">${t(n.sectionKey)}</div>`
          : html`<${RailItem} key=${n.key} item=${{ route: n.route, icon: n.icon, label: t(n.labelKey) }} active=${routeOf[view] === n.route} />`
      )}

      <span className="flex-1"></span>
      <div className="px-2.5 pb-2">
        <${LangSwitch} />
      </div>
      <${RailItem} item=${{ route: '/settings', label: t('nav.settings'), icon: '⚙' }} active=${view === 'settings'} />
    </aside>
  `;
}

export function AppShell({ route }) {
  const view = viewOf(route);
  const [tasks, refreshTasks] = useTasksPoll();

  // 切视图时回到顶部（长列表否则会保留滚动位置）
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  // 首页是整页小智对话（含自己的可收起导航），不套全局左栏、任务条与悬浮球。
  if (view === 'home') {
    return html`<${Boundary}><${AssistantPage} /></${Boundary}>`;
  }

  // 剪辑台是整屏工作台：不套全局左栏与任务条（2026-11-04）
  if (view === 'edit') {
    return html`<${EditorView} />`;
  }

  return html`
    <div className="h-full grid grid-cols-[212px_minmax(0,1fr)] bg-s0 text-ink overflow-hidden">
      <${Rail} view=${view} />

      <div className="flex flex-col min-h-0 min-w-0">
        <${JobBar} tasks=${tasks} onChanged=${refreshTasks} />

        <div className="flex-1 min-h-0 overflow-auto">
          ${view === 'createSmart' && html`<${Boundary}><${CreateSmartWizard} /></${Boundary}>`}
          ${view === 'create' && html`<${Boundary}><${CreateWizard} tasks=${tasks} onChanged=${refreshTasks} /></${Boundary}>`}
          ${view === 'gen' && html`<${Boundary}><${GenView} tasks=${tasks} onChanged=${refreshTasks} /></${Boundary}>`}
          ${view === 'library' && html`<${Boundary}><${LibraryView}
            tasks=${tasks}
            initialTab=${route.startsWith('/photos') ? 'photos' : (route.startsWith('/clips') ? 'clips' : 'finals')}
          /></${Boundary}>`}
          ${view === 'music' && html`<${Boundary}><${MusicView} /></${Boundary}>`}
          ${view === 'templates' && html`<${Boundary}><${TemplatesView} /></${Boundary}>`}
          ${view === 'settings' && html`<${Boundary}><${SettingsView} /></${Boundary}>`}
        </div>
      </div>
    </div>
  `;
}
