// ==========================================
// LLM 服务层（§9.1）
// 统一 LLM 接入，提供「真分镜链」与「提示词增强链」
// 配置优先级：运行时传入（前端）> config.OPENAI_*
// 无 Key 时返回 null，由调用方降级，不阻塞流水线
// ==========================================

const config = require('../../config');

const REQUEST_TIMEOUT_MS = 30000;

class LLMService {
  // 解析 LLM 配置：运行时（前端传入）优先，config.OPENAI_* 兜底
  _resolve(options = {}) {
    return {
      apiKey: options.apiKey || config.OPENAI_API_KEY || '',
      baseUrl: options.baseUrl || config.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: options.model || config.OPENAI_MODEL || 'gpt-4o-mini'
    };
  }

  isConfigured(options = {}) {
    return !!this._resolve(options).apiKey;
  }

  // 统一 chat 调用；失败/无 Key 返回 null（不抛异常）
  async _chat(systemPrompt, userPrompt, options = {}, temperature = 0.7) {
    const { apiKey, baseUrl, model } = this._resolve(options);
    if (!apiKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature
        }),
        signal: controller.signal
      });
      if (!resp.ok) {
        console.error(`LLM 请求失败: HTTP ${resp.status}`);
        return null;
      }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      console.error('LLM 调用异常:', e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 真分镜链：主题/地区名 → N 段差异化场景 [{index, scene, prompt}]
  async storyboard(themeOrPrompt, count, options = {}) {
    if (!this.isConfigured(options)) return null;
    const system = `你是专业的风光长视频分镜师。用户会给你一个主题或地区名，请拆分为 ${count} 个差异化的镜头场景。
要求：
1. 每个场景独立、有画面感，相邻场景不得重复或雷同
2. 覆盖不同景观主体/运镜/光影，形成递进节奏
3. 每个场景一句话描述（含主体 + 运镜 + 光影 + 氛围）
只输出 JSON 数组，不要任何解释、不要 markdown 代码块，格式：
[{"index":1,"scene":"简短场景名","prompt":"完整画面描述"}]`;
    const content = await this._chat(system, `主题/地区：${themeOrPrompt}`, options, 0.85);
    if (!content) return null;
    return this._parseStoryboard(content, count);
  }

  // 提示词增强链已移除（§4.5 采用方案 A：LLM 分镜 + 模板结构化，无需独立增强链）

  // ==========================================
  // 多轮对话（提示词助手悬浮球用）
  // 与 _chat 的区别：接收完整 messages 历史而非单条 user 消息。
  // 失败返回 null（与 _chat 约定一致），不抛异常。
  // ==========================================
  async chatMulti(systemPrompt, messages, options = {}) {
    const { apiKey, baseUrl, model } = this._resolve(options);
    if (!apiKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ],
          temperature: 0.8
        }),
        signal: controller.signal
      });
      if (!resp.ok) {
        console.error(`[assistant] LLM 请求失败: HTTP ${resp.status}`);
        return null;
      }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      console.error('[assistant] LLM 调用异常:', e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 解析并规范化分镜 JSON：容错 markdown 代码块、字段缺失、数量不符
  _parseStoryboard(content, count) {
    let text = String(content).trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;

    let arr;
    try {
      arr = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      console.error('分镜 JSON 解析失败:', e.message);
      return null;
    }
    if (!Array.isArray(arr) || arr.length === 0) return null;

    const scenes = arr.map((item, i) => {
      if (typeof item === 'string') return { scene: '', prompt: item.trim() };
      return {
        scene: item.scene || '',
        prompt: (item.prompt || item.description || item.scene || '').trim()
      };
    }).filter(s => s.prompt);
    if (scenes.length === 0) return null;

    // 对齐到 count：不足用最后一段补齐，超出截断（不报错）
    const result = [];
    for (let i = 0; i < count; i++) {
      const s = scenes[i] || scenes[scenes.length - 1];
      result.push({ index: i, scene: s.scene, prompt: s.prompt });
    }
    return result;
  }
}

module.exports = new LLMService();