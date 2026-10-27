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
        ink: 'var(--ink)',
        ink2: 'var(--ink2)',
        ink3: 'var(--ink3)',
        accent: 'var(--accent)',
        danger: 'var(--danger)'
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', '-apple-system', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        display: ['Bodoni MT', 'Perpetua Titling MT', 'Baskerville Old Face', 'Garamond', 'Georgia', 'serif'],
        num: ['SF Mono', 'Cascadia Mono', 'Consolas', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
};
