/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./web/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        s0: 'var(--s0)',
        s1: 'var(--s1)',
        s2: 'var(--s2)',
        s3: 'var(--s3)',
        s4: 'var(--s4)',
        s5: 'var(--s5)',
        ink: 'var(--ink)',
        ink2: 'var(--ink2)',
        ink3: 'var(--ink3)',
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        onaccent: 'var(--onaccent)',
        danger: 'rgb(var(--danger-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', '-apple-system', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        display: ['Bodoni MT', 'Perpetua Titling MT', 'Baskerville Old Face', 'Garamond', 'Georgia', 'PingFang SC', 'Microsoft YaHei', 'serif'],
        num: ['SF Mono', 'Cascadia Mono', 'Consolas', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
};
