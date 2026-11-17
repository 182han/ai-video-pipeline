// ============================================================
// i18n · 应用外壳：标题、旧后端提示条
// ============================================================
export default {
  zh: {
    app: {
      title: 'Video Studio · AI 风景短片'
    },
    shell: {
      staleServer: '服务端代码是旧版本（缺少 imageGen 探针）。当前页面可能已更新，但后端接口还没加载；请重启：cd app && node server.js'
    }
  },
  en: {
    app: {
      title: 'Video Studio · AI Landscape Films'
    },
    shell: {
      staleServer: 'The server code is outdated (missing the imageGen probe). This page may already be new, but the backend API is not loaded. Restart with: cd app && node server.js'
    }
  }
};
