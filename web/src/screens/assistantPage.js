// ============================================================
// 小智首页（2026-11-16，用户草图）
// ------------------------------------------------------------
// 登录后的 `/` = 整页「小智」对话页：
//   · 左侧可收起气泡导航（三个点 = 收起/展开，不是退出；localStorage 记住状态）
//   · 主区顶部大球 → 介绍卡（一句开场白 + 建议 chips）→ 对话区
//   · 底部微信式输入框固定在主区下方
//   · 整页深绿/祖母绿渐变，与大球青绿色呼应；保留 P2/P3 香槟金 accent
// 六步创作向导仍在 /create（导航「创作」进入，功能不变）。
// 对话主体复用 components/assistant.js 的 page 模式（消息/计划卡/状态机/记忆/ASR 全复用）。
// 只改 web/，不重启 3001（express.static 刷新即生效）。
// ============================================================
import { navigate } from '../router.js';
import { t } from '../i18n/index.js';
import { LangSwitch } from '../components/langSwitch.js';
import { Assistant } from '../components/assistant.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const RAIL_KEY = 'vs_rail_collapsed';

// 4 项：创作（2026-11-16 起默认 /create-smart 智能向导）/ 剪辑 / 库 / 设置（底部）
// 首页 = 小智，不占导航项；用户草图里的「库存」沿用现有文案「库」。旧六步向导仍在 /create 可回退。
const NAV = [
  { route: '/create-smart', labelKey: 'nav.create', icon: '◆', titleKey: 'nav.createTitle' },
  { route: '/edit', labelKey: 'nav.edit', icon: '✂', titleKey: 'nav.editTitle' },
  { route: '/library', labelKey: 'nav.library', icon: '▤', titleKey: 'nav.libraryTitle' }
];

function RailItem({ item, collapsed, foot = false }) {
  return html`
    <button
      type="button"
      className="xz-nav-item"
      onClick=${() => navigate(item.route)}
      title=${collapsed ? item.label : (item.title || item.label)}
      aria-label=${item.label}
      data-route=${item.route}
    >
      <span className="xz-nav-ico" aria-hidden="true">${item.icon}</span>
      <span className="xz-nav-label">${item.label}</span>
    </button>
  `;
}

export function AssistantPage() {
  const [collapsed, setCollapsed] = useState(() => {
    // 默认收起（用户 2026-11-16 指定：首页要第三张截图那样，只留图标气泡）；
    // 点三个点展开后记住选择（vs_rail_collapsed=0）。
    try { return localStorage.getItem(RAIL_KEY) !== '0'; } catch (e) { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
  }, [collapsed]);

  return html`
    <div className=${'xz-root' + (collapsed ? ' is-rail-collapsed' : '')}>
      <aside className=${'xz-rail' + (collapsed ? ' is-collapsed' : '')} aria-label=${t('nav.mainAria')}>
        <div className="xz-rail-head">
          <div className="xz-brand">Video Studio</div>
          <button
            type="button"
            className="xz-dots"
            onClick=${() => setCollapsed((v) => !v)}
            aria-label=${collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded=${!collapsed}
            title=${collapsed ? t('nav.expand') : t('nav.collapse')}
          >•••</button>
        </div>

        <nav className="xz-nav">
          ${NAV.map((n) => html`<${RailItem} key=${n.route}
            item=${{ route: n.route, label: t(n.labelKey), title: t(n.titleKey), icon: n.icon }}
            collapsed=${collapsed} />`)}
        </nav>

        <div className="xz-rail-foot">
          <div style=${{ display: 'flex', justifyContent: collapsed ? 'center' : 'flex-start', padding: '0 4px 8px' }}>
            <${LangSwitch} collapsed=${collapsed} />
          </div>
          <${RailItem}
            item=${{ route: '/settings', label: t('nav.settings'), icon: '⚙', title: t('nav.settings') }}
            collapsed=${collapsed}
            foot=${true}
          />
        </div>
      </aside>

      <main className="xz-main">
        <${Assistant} page=${true} />
      </main>
    </div>
  `;
}
