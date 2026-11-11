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
