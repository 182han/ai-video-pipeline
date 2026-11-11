// ==========================================
// LLM 服务层（§9.1）
// 统一 LLM 接入，提供「真分镜链」与「提示词增强链」
// 配置优先级：运行时传入（前端）> config.OPENAI_*
// 无 Key 时返回 null，由调用方降级，不阻塞流水线
// ==========================================

const config = require('../../config');

// 助手/LLM 请求超时：默认 120 秒（2026-11-11 从 30 秒上调）。
// 30 秒对推理模型/中转高峰太短，实测会出现「模型 30 秒内没有回话 / This operation was aborted」。
// 可用 LLM_TIMEOUT_MS 覆盖；流式请求把它当「空闲超时」用（收到数据就重置，不是总时长）。
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.LLM_TIMEOUT_MS) || 120000);

// 所有要回传给前端或写进日志的文本都必须先过这里。
// 厂商报错里偶尔会带回请求头 / key 片段；server.js 的契约是「Key 只走请求体、绝不落日志」，
// 所以脱敏放在最靠近出口的位置，而不是指望每个调用点自觉。
function scrubSecret(text, secret) {
  let s = String(text == null ? '' : text);
  if (secret && secret.length >= 6) s = s.split(secret).join('***');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***');
  return s;
}

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
  //
  // 返回 { text, failure }（不再只返回字符串或 null）：
  //   text    —— 模型正文；失败时为 null
  //   failure —— 成功时为 null，失败时为结构化原因：
  //     { kind: 'NO_KEY'|'HTTP'|'NETWORK'|'TIMEOUT'|'EMPTY'|'BAD_JSON',
  //       status?, detail?, url, model, timeoutMs? }
  //
  // 为什么改：原先所有失败都 return null，后端只能回同一句
  // 「请检查网络或 API Key」——2026-11-10 两起事故（地址读错 → fetch failed；
  // 模型名不在中转可用列表 → HTTP 403）都是被这句话带偏的，用户无法判断该改什么。
  // detail 一律脱敏（不含 Key），可直接展示给用户。
  async chatMulti(systemPrompt, messages, options = {}) {
    const { apiKey, baseUrl, model } = this._resolve(options);
    const requestUrl = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const base = { url: requestUrl, model };

    if (!apiKey) {
      return { text: null, failure: { ...base, kind: 'NO_KEY', detail: '没有拿到 API Key（请求未发出）' } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(requestUrl, {
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
        const bodyText = await resp.text().catch(() => '');
        const detail = scrubSecret(bodyText, apiKey).replace(/\s+/g, ' ').trim().slice(0, 300);
        console.error(`[assistant] LLM 请求失败: HTTP ${resp.status} model=${model} | ${detail}`);
        return { text: null, failure: { ...base, kind: 'HTTP', status: resp.status, detail } };
      }
      const data = await resp.json().catch(() => null);
      if (!data) {
        return {
          text: null,
          failure: { ...base, kind: 'BAD_JSON', status: resp.status, detail: '响应不是合法 JSON（可能被网关 / 登录页拦截）' }
        };
      }
      const content = data.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content.trim() : '';
      if (!text) {
        return {
          text: null,
          failure: {
            ...base, kind: 'EMPTY', status: resp.status,
            detail: '模型返回空正文：' + scrubSecret(JSON.stringify(data), apiKey).slice(0, 200)
          }
        };
      }
      return { text, failure: null };
    } catch (e) {
      const timedOut = !!e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)));
      const cause = e && e.cause ? (e.cause.code || e.cause.message) : '';
      const detail = scrubSecret(`${e && e.message ? e.message : e}${cause ? ' (' + cause + ')' : ''}`, apiKey);
      console.error(`[assistant] LLM 调用异常: ${detail} url=${requestUrl}`);
      return {
        text: null,
        failure: {
          ...base,
          kind: timedOut ? 'TIMEOUT' : 'NETWORK',
          detail,
          ...(timedOut ? { timeoutMs: REQUEST_TIMEOUT_MS } : {})
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ==========================================
  // 测试连接用：判断「真正会被用到的模型名」是否在 {base}/models 的可用列表里。
  // 纯判断，不发请求（列表由调用方传），所以验收脚本可以离线断言。
  //
  // 背景：GET /models 对任何合法 Key 都回 200，它验证不了模型名。
  // 2026-11-10 事故：Key/地址都对，模型填 deepseek-chat，而该中转只挂了
  // deepseek-v4-flash-0731 → 测试显示「连接成功」，对话永远 HTTP 403。
  //
  // 返回 { ok, checked, model, models, message }
  //   ok=false 只在「能明确判定不可用」时成立；
  //   列表为空（拿不到）时 checked=false 且 ok=true —— 不可判定 ≠ 不可用。
  verifyModel({ model, models, fallbackModel } = {}) {
    const configured = String(model || '').trim();
    const fallback = String(fallbackModel || '').trim();
    const effective = configured || fallback;
    const list = (Array.isArray(models) ? models : []).filter(Boolean).map(String);

    if (!effective) {
      return {
        ok: false, checked: false, model: '', models: list,
        message: '没有填模型名，也没有可回落的默认模型；对话请求必然失败'
      };
    }
    if (list.length === 0) {
      return {
        ok: true, checked: false, model: effective, models: list,
        message: 'Key/地址可用；但该地址没有返回模型列表，无法校验模型名'
      };
    }
    const note = configured ? '' : `（用的是回落的默认模型 ${fallback}，建议在设置里显式填写）`;
    if (list.includes(effective)) {
      return {
        ok: true, checked: true, model: effective, models: list,
        message: `模型 ${effective} 在可用列表里${note}`
      };
    }
    // 相近模型名：让用户一眼看到「是不是少打了个后缀」
    const head = effective.toLowerCase().split(/[-_.:]/)[0];
    const near = list.filter((m) => m.toLowerCase().includes(head) && m !== effective).slice(0, 5);
    return {
      ok: false, checked: true, model: effective, models: list, near,
      message: `Key 和地址可用，但模型「${effective}」不在该地址的可用列表里`
        + `（共 ${list.length} 个：${list.slice(0, 10).join(', ')}${list.length > 10 ? ' …' : ''}）`
        + (near.length ? `；相近的：${near.join(', ')}` : '')
        + note
    };
  }

  // 把 chatMulti 的 failure 翻成「用户能照着做事」的中文。
  // 只陈述可观测事实（状态码 / 地址 / 模型名），不猜原因；建议必须可执行。
  // 放在这里而不是 server.js：可被验收脚本直接断言（server.js 不导出任何东西）。
  describeFailure(f) {
    const kind = f && f.kind ? f.kind : 'UNKNOWN';
    const status = f && f.status;
    const model = f && f.model ? `「${f.model}」` : '';
    const detail = f && f.detail ? f.detail : '';
    switch (kind) {
      case 'NO_KEY':
        return { hint: '没有拿到 LLM Key：去设置页 LLM 组填好 Key 再重试', detail };
      case 'HTTP':
        if (status === 401 || status === 403) {
          return {
            hint: `被服务器拒绝（HTTP ${status}）：Key 与地址必须同属一家；`
              + `地址没问题时，多半是模型${model}没开通权限（到中转后台看令牌可用模型）`,
            detail
          };
        }
        if (status === 404) {
          return {
            hint: `地址或模型不存在（HTTP 404）：检查 Base URL 是否要带 /v1，以及模型名${model}`,
            detail
          };
        }
        if (status === 429) {
          return { hint: '被限流或额度不足（HTTP 429）：稍后重试，或检查账户余额', detail };
        }
        if (typeof status === 'number' && status >= 500) {
          return { hint: `上游服务出错（HTTP ${status}）：稍后重试；持续失败请换地址`, detail };
        }
        return { hint: `请求被拒（HTTP ${status}）`, detail };
      case 'TIMEOUT': {
        const sec = Math.round((f.timeoutMs || REQUEST_TIMEOUT_MS) / 1000);
        return { hint: `模型 ${sec} 秒内没有回话：推理型模型偏慢，可换快模型或重试`, detail };
      }
      case 'NETWORK':
        return { hint: '连不上这个地址：检查 Base URL 是否写错、本机是否需要代理', detail };
      case 'EMPTY':
        return { hint: '模型返回了空正文：可能被内容审核拦截，或该模型只返回思考过程', detail };
      case 'BAD_JSON':
        return { hint: '响应不是 JSON：地址可能填成了网页地址（网站对任何路径都回 HTML 200）', detail };
      default:
        return { hint: '未知原因，详见 data/logs/ 当天日志', detail };
    }
  }

  // ==========================================
  // 测试连接：把 {base}/models 的响应判成最终结论（纯函数，不发请求）。
  // 抽出来的原因：/api/test-api-key 里那段逻辑本身没法离线验收，
  // 而它恰恰是 2026-11-10 事故里「显示连接成功、对话 403」的那一环。
  // 覆盖三种形态：正常列表 / 空列表（不可判定）/ 200 但返回 HTML（地址填成网页）。
  judgeModelsPayload({ data, text, model, url, fallbackModel } = {}) {
    const urlUsed = String(url || '').replace(/\/models$/, '');
    const baseUrlSource = 'request（页面 Base URL）';

    if (!data || Object.keys(data).length === 0) {
      const head = String(text || '').slice(0, 80).replace(/\s+/g, ' ');
      return {
        success: false,
        error: '地址返回的不是 JSON，Base URL 可能填成了网页地址。响应开头: ' + head,
        urlUsed,
        baseUrlSource
      };
    }

    const rawList = Array.isArray(data.data) ? data.data
      : (Array.isArray(data.models) ? data.models : []);
    const ids = rawList
      .map((m) => (typeof m === 'string' ? m : m && m.id))
      .filter(Boolean);

    const verdict = this.verifyModel({ model, models: ids, fallbackModel });
    if (!verdict.ok) {
      return {
        success: false,
        error: verdict.message,
        urlUsed,
        baseUrlSource,
        model: verdict.model,
        models: ids.slice(0, 50),
        checkedModel: true
      };
    }
    return {
      success: true,
      message: '连接成功，API Key 有效｜' + verdict.message,
      urlUsed,
      model: verdict.model,
      modelChecked: verdict.checked,
      models: ids.slice(0, 50)
    };
  }

  // ==========================================
  // 流式多轮对话（提示词助手气泡用）
  // chatMulti 的流式版：形状相同（{ text, failure }），额外返回
  //   elapsedMs / firstTokenMs / reasoningChars
  // handlers:
  //   onContent(fullText)      —— 累计的完整正文（不是增量），调用方自己 diff
  //   onReasoning(chars, ms)   —— 思考链已产出的字符数与首个 token 时刻
  // 为什么用累计值：调用方要的是「当前应显示的内容」，传增量反而要自己拼、易错。
  async chatMultiStream(systemPrompt, messages, options = {}, handlers = {}) {
    const { apiKey, baseUrl, model } = this._resolve(options);
    const requestUrl = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const base = { url: requestUrl, model };

    if (!apiKey) {
      return { text: null, failure: { ...base, kind: 'NO_KEY', detail: '没有拿到 API Key（请求未发出）' } };
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(5000, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS);
    // 流式用「空闲超时」：每读到一块数据就重置，避免长回答被总时长误杀
    let timer = null;
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    };
    armTimer();
    const t0 = Date.now();
    let firstTokenMs = null;
    let reasoningChars = 0;
    let text = '';
    try {
      const resp = await fetch(requestUrl, {
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
          temperature: 0.8,
          stream: true
        }),
        signal: controller.signal
      });
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        const detail = scrubSecret(bodyText, apiKey).replace(/\s+/g, ' ').trim().slice(0, 300);
        console.error(`[assistant] LLM 流式请求失败: HTTP ${resp.status} model=${model} | ${detail}`);
        return { text: null, failure: { ...base, kind: 'HTTP', status: resp.status, detail }, elapsedMs: Date.now() - t0 };
      }
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        return {
          text: null,
          failure: { ...base, kind: 'BAD_JSON', status: resp.status, detail: '响应没有可读的流（网关可能不支持 stream）' },
          elapsedMs: Date.now() - t0
        };
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armTimer();
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let evt = null;
          try { evt = JSON.parse(payload); } catch { continue; }
          const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta;
          if (!delta) continue;
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
            reasoningChars += delta.reasoning_content.length;
            if (typeof handlers.onReasoning === 'function') handlers.onReasoning(reasoningChars, firstTokenMs);
          }
          if (typeof delta.content === 'string' && delta.content) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
            text += delta.content;
            if (typeof handlers.onContent === 'function') handlers.onContent(text);
          }
        }
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return {
          text: null,
          failure: { ...base, kind: 'EMPTY', status: resp.status, detail: '流式响应结束但正文为空（可能被内容审核拦截）' },
          elapsedMs: Date.now() - t0, firstTokenMs, reasoningChars
        };
      }
      return { text: trimmed, failure: null, elapsedMs: Date.now() - t0, firstTokenMs, reasoningChars };
    } catch (e) {
      const timedOut = !!e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)));
      const cause = e && e.cause ? (e.cause.code || e.cause.message) : '';
      const detail = scrubSecret(`${e && e.message ? e.message : e}${cause ? ' (' + cause + ')' : ''}`, apiKey);
      console.error(`[assistant] LLM 流式调用异常: ${detail} url=${requestUrl}`);
      return {
        text: null,
        failure: {
          ...base,
          kind: timedOut ? 'TIMEOUT' : 'NETWORK',
          detail,
          ...(timedOut ? { timeoutMs } : {})
        },
        elapsedMs: Date.now() - t0
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // 从「还没写完的 JSON 正文」里提取 message 字段已能安全显示的前缀。
  // 模型约定输出 {"ready":..,"message":"...","prompt":..}，流式时这段 JSON 是逐字到来的；
  // 直接把原文敲进气泡会看到 `{"ready": false, "mess` 这种东西，所以要边解析边显示。
  // 遇到不完整的转义（末尾单个 \ 或 \u12）就停在那里，等下一块数据补齐。
  extractMessagePrefix(raw) {
    const m = /"message"\s*:\s*"/.exec(String(raw || ''));
    if (!m) return '';
    const s = String(raw);
    let i = m.index + m[0].length;
    let out = '';
    const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') break;                       // 字符串闭合，后面是下一个字段
      if (ch === '\\') {
        const next = s[i + 1];
        if (next === undefined) break;             // 转义不完整
        if (next === 'u') {
          const hex = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // \u12 还没到齐
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += Object.prototype.hasOwnProperty.call(simple, next) ? simple[next] : next;
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
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