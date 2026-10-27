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
      llmBaseUrl: cfg.llmBaseUrl || '',
      llmModel: cfg.llmModel || ''
    };
  } catch {
    return { llmApiKey: '', llmBaseUrl: '', llmModel: '' };
  }
}
