// ============================================================
// 语言切换器（P0）
// ------------------------------------------------------------
// 用在：左栏底部、小智首页左栏、设置页、登录页（登录页是自包含实现）。
// 不依赖 Tailwind 新类：样式全用内联 + 现有 CSS 变量，避免离线 CSS 没重生成导致不可见。
// ============================================================
import { getLocale, setLocale, t } from '../i18n/index.js';

const { React } = window;
const html = window.htm.bind(React.createElement);

const OPTIONS = [
  { code: 'zh', label: '中文', title: '中文' }, // i18n-allow: language self-name
  { code: 'en', label: 'EN', title: 'English' }
];

export function LangSwitch({ compact = false, collapsed = false, style = null } = {}) {
  const current = getLocale();
  // 收起态左栏只有 46px 可用：只显示一个「中 / EN」按钮，点击即互换。
  if (collapsed) {
    return html`
      <button
        type="button"
        onClick=${() => setLocale(current === 'zh' ? 'en' : 'zh')}
        aria-label=${t('common.languageSwitch')}
        title=${t('common.languageSwitch')}
        style=${{
          width: '30px',
          height: '24px',
          border: '1px solid rgb(var(--ink-rgb) / .12)',
          borderRadius: '6px',
          background: 'rgb(var(--ink-rgb) / .03)',
          color: 'var(--ink2)',
          fontSize: '10px',
          lineHeight: '1',
          cursor: 'pointer',
          ...(style || {})
        }}
      >${/* i18n-allow: language badge glyph */ current === 'zh' ? '中' : 'EN'}</button>
    `;
  }
  return html`
    <div
      role="group"
      aria-label=${t('common.languageSwitch')}
      style=${{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        padding: '2px',
        border: '1px solid rgb(var(--ink-rgb) / .10)',
        borderRadius: '6px',
        background: 'rgb(var(--ink-rgb) / .02)',
        ...(style || {})
      }}
    >
      ${OPTIONS.map((opt) => html`
        <button
          key=${opt.code}
          type="button"
          onClick=${() => setLocale(opt.code)}
          aria-pressed=${current === opt.code}
          title=${opt.title}
          style=${{
            minWidth: compact ? '26px' : '38px',
            height: compact ? '20px' : '22px',
            padding: '0 6px',
            border: 0,
            borderRadius: '4px',
            fontSize: compact ? '10px' : '11px',
            lineHeight: '1',
            fontWeight: current === opt.code ? 600 : 400,
            color: current === opt.code ? 'var(--onaccent)' : 'var(--ink3)',
            background: current === opt.code ? 'var(--accent)' : 'transparent',
            cursor: 'pointer'
          }}
        >${opt.label}</button>
      `)}
    </div>
  `;
}
