// ============================================================
// 主题开关（左栏底部，语言切换右侧）
// ------------------------------------------------------------
// 只有一个入口：外壳左栏 + 小智首页自己的左栏（两套 rail 共用这一枚）。
// 图标表示「点下去会切到哪」：日间显示月亮，夜间显示太阳。
// 不依赖新 Tailwind 类，样式在 styles/src.css 的 .theme-toggle。
// ============================================================
import { getTheme, toggleTheme, subscribeTheme } from '../theme.js';
import { t } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const MOON = html`
  <svg className="ico-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </svg>
`;

const SUN = html`
  <svg className="ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </svg>
`;

export function ThemeToggle({ compact = false, style = null } = {}) {
  const [theme, setThemeState] = useState(() => getTheme());

  useEffect(() => subscribeTheme(setThemeState), []);

  const dark = theme === 'dark';
  const label = dark ? t('nav.themeToLight') : t('nav.themeToDark');

  return html`
    <button
      type="button"
      className=${'theme-toggle' + (compact ? ' is-compact' : '')}
      onClick=${() => toggleTheme()}
      title=${label}
      aria-label=${label}
      style=${style || undefined}
    >
      ${MOON}
      ${SUN}
    </button>
  `;
}
