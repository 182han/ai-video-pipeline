// 极小的跨组件通知总线：提示词助手把生成的提示词送回创作屏。
// 不引状态库——只有一个事件，用 Set 监听足够。
const handlers = new Set();

export const promptBus = {
  setPrompt(text) {
    handlers.forEach((fn) => fn(text));
  },
  on(fn) {
    handlers.add(fn);
    return () => handlers.delete(fn);
  }
};

// 生成/质检用的「运行时配置」：与 screens/create.js 的 collectRuntime()、
// components/taskDrawer.js 的 buildRuntimeConfig() 同一套 localStorage 键（vs_config）。
// 2026-11-16 修 P0：小智计划卡「确认执行」原先只发 {sessionId, planId, approved}，
// 服务端 .env 没有对应 Key 时 src/generators/index.js:79 会**静默降级 Mock**，
// 用户点了确认却看到合成画面。这里把设置里的 Key 与地址一并返回，由调用方随请求发出。
// 注意：只读 localStorage，不打印、不落盘、不上报；Key 为空就是空串。
export function readRuntimeConfig(model) {
  let cfg = {};
  try {
    cfg = JSON.parse(localStorage.getItem('vs_config') || '{}') || {};
  } catch {
    cfg = {};
  }
  const base = {
    llmApiKey: cfg.llmKey || '',
    llmBaseUrl: cfg.llmUrl || '',
    llmModel: cfg.llmModel || '',
    multimodalApiKey: cfg.multimodalKey || '',
    multimodalBaseUrl: cfg.multimodalUrl || '',
    multimodalModel: cfg.multimodalModel || ''
  };
  if (model === 'dashscope') {
    // 官方 API 根地址 = https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1
    // 设置页只存 WorkspaceId/区域，没拼的话 dashscope 永远「Base URL 未配置」。
    const dsBase = (cfg.dashScopeWorkspaceId && cfg.dashScopeRegion)
      ? `https://${cfg.dashScopeWorkspaceId}.${cfg.dashScopeRegion}.maas.aliyuncs.com/api/v1`
      : (cfg.dashScopeBaseUrl || '');
    return { ...base, apiKey: cfg.dashScopeKey || '', apiBaseUrl: dsBase, modelId: 'wan3.0-video' };
  }
  if (model === 'seedance') {
    return { ...base, apiKey: cfg.seedanceKey || '', apiBaseUrl: cfg.seedanceBaseUrl || '', modelId: cfg.seedanceModel || '' };
  }
  if (model === 'kling') {
    return { ...base, klingAccessKey: cfg.klingAk || '', klingSecretKey: cfg.klingSk || '' };
  }
  if (model === 'openai-video') {
    return {
      ...base,
      apiKey: cfg.whaletvKey || '',
      apiBaseUrl: cfg.whaletvBaseUrl || '',
      baseUrl: cfg.whaletvBaseUrl || '',
      modelId: cfg.whaletvVideoModel || 'wan3.0-video'
    };
  }
  return base;
}

// 读取旧版设置（同源 localStorage，新旧页面共用）。
// 未迁移设置面板之前，助手需要的 LLM 配置就沿用这里。
export function readLLMConfig() {
  try {
    const raw = localStorage.getItem('vs_config');
    const cfg = raw ? JSON.parse(raw) : {};
    return {
      llmApiKey: cfg.llmKey || '',
      // 设置页（screens/settingsPage.js:51）把 Base URL 存在 llmUrl 这个键上，
      // 这里早先读的是 llmBaseUrl（从未被任何页面写入）→ 永远是空串，
      // 于是后端 llmService 回落到 .env 的 OPENAI_BASE_URL（api.openai.com），
      // 用户的中转/DeepSeek Key 被发到 OpenAI，国内必 fetch failed，
      // 表现为「设置里测试连接成功，助手却报没有响应」。保留 llmBaseUrl 兜底兼容旧备份。
      llmBaseUrl: cfg.llmUrl || cfg.llmBaseUrl || '',
      llmModel: cfg.llmModel || ''
    };
  } catch {
    return { llmApiKey: '', llmBaseUrl: '', llmModel: '' };
  }
}
