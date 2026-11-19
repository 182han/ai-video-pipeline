// ==========================================
// 小智 · B 目标：agent 运行时（路由 + 落会话 + 工具执行）
// ------------------------------------------------------------
// 分工：
//   · agent.js        —— 纯契约层：prompt / 解析 / 校验 / 一次重试 / 接地（不碰业务）
//   · agentRuntime.js —— 本文件：装配上下文 → 调 agent → 执行工具 → 落会话 → 统一响应
//   · supervisor.js   —— runAgentTool：既有的确定性执行（无 execute）
//
// 关键边界：
//   · agent 失败（无 Key / 超时 / 坏 JSON / 接地拒绝）→ handled:false，
//     **不写任何会话消息**，由 server 回退到规则路径（降级不倒退）；
//   · 工具决定成功但执行失败（缺参数等）→ handled:true + ok:false，
//     写一条错误回复（不静默、不回退成"猜一个动作"）。
// ==========================================
'use strict';

const agent = require('./agent');
const memory = require('./memory');
const agentAudit = require('./agentAudit');

const AGENT_RUNTIME_VERSION = 'assistant-agent-runtime.v1.0.0';

// 工具 → 对前端有意义的意图（前端只用 create/confirm 决定弹不弹计划卡）。
const TOOL_INTENT = Object.freeze({
  plan_video: 'create',
  edit_plan: 'plan_edit',
  show_plan: 'plan_edit',
  show_scene_cards: 'plan_scenes',
  status: 'status',
  last_video: 'last',
  budget: 'context',
  diagnose: 'repair',
  bgm: 'bgm',
  settings_change: 'settings',
  prefs: 'prefs',
  assets: 'assets',
  confirm_plan: 'confirm'
});

function normalizeLang(lang) {
  return String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

/**
 * 跑一轮 agent 对话。
 * @param {object} opts
 *   text, sessionId?, userId?, lang?, context?, supervisor,
 *   apiKey/baseUrl/model/timeoutMs, callLLM?（测试注入）
 * @returns {Promise<{handled:boolean, response?:object, failure?:object, latencyMs?:number}>}
 */
async function handleAgentTurn(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const text = String(o.text === undefined || o.text === null ? '' : o.text).trim();
  if (!text) return { handled: false, failure: { kind: 'EMPTY_INPUT' } };

  const supervisor = o.supervisor;
  if (!supervisor || typeof supervisor.runAgentTool !== 'function') {
    return { handled: false, failure: { kind: 'NO_SUPERVISOR' } };
  }

  const lang = normalizeLang(o.lang);
  const userId = o.userId ? String(o.userId) : 'local';
  const session = memory.getOrCreate(o.sessionId);
  const sessionId = session.id;
  const history = memory.listMessages(sessionId, 8);

  let ctx = o.context;
  if (!ctx && typeof supervisor.agentContextOf === 'function') {
    try { ctx = supervisor.agentContextOf({ sessionId, userId }); } catch (e) { ctx = {}; }
  }

  const decision = await agent.runTurn({
    text,
    lang,
    ctx,
    history,
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
    model: o.model,
    timeoutMs: o.timeoutMs,
    temperature: o.temperature,
    callLLM: o.callLLM
  });

  if (!decision.ok) {
    // 不写会话：交给 server 走规则路径（handleMessage 会自己写 user + assistant）。
    agentAudit.record({
      sessionId,
      lang,
      model: o.model || null,
      mode: 'fallback',
      tool: null,
      latencyMs: decision.latencyMs,
      attempts: decision.attempts,
      failureKind: (decision.failure && decision.failure.kind) || 'AGENT_FAILED',
      text
    });
    return {
      handled: false,
      fallback: true,
      failure: decision.failure || { kind: 'AGENT_FAILED' },
      latencyMs: decision.latencyMs,
      attempts: decision.attempts
    };
  }

  const agentMeta = {
    version: agent.AGENT_VERSION,
    runtime: AGENT_RUNTIME_VERSION,
    mode: decision.mode,
    tool: decision.tool || null,
    latencyMs: decision.latencyMs,
    attempts: decision.attempts,
    warnings: decision.warnings || []
  };

  memory.appendMessage(sessionId, { role: 'user', text });

  if (decision.mode === 'tool') {
    const out = supervisor.runAgentTool({
      tool: decision.tool,
      args: decision.args,
      sessionId,
      userId,
      lang
    });
    if (!out || out.ok !== true) {
      const error = (out && out.error) || '工具执行失败';
      memory.appendMessage(sessionId, { role: 'assistant', text: error, kind: 'chat' });
      agentAudit.record({
        sessionId,
        lang,
        model: o.model || null,
        mode: 'tool',
        tool: decision.tool,
        intent: 'clarify',
        ok: false,
        code: (out && out.code) || 'AGENT_TOOL_FAILED',
        latencyMs: decision.latencyMs,
        attempts: decision.attempts,
        text
      });
      return {
        handled: true,
        latencyMs: decision.latencyMs,
        response: {
          ok: false,
          version: supervisor.SUPERVISOR_VERSION,
          sessionId,
          intent: 'clarify',
          reply: error,
          replyKey: 'assistant.reply.agentToolError',
          lang,
          actions: null,
          plan: null,
          missing: null,
          refs: null,
          canExecute: false,
          code: (out && out.code) || 'AGENT_TOOL_FAILED',
          error,
          agent: agentMeta
        }
      };
    }
    const intent = TOOL_INTENT[decision.tool] || 'plan_edit';
    agentAudit.record({
      sessionId,
      lang,
      model: o.model || null,
      mode: 'tool',
      tool: decision.tool,
      intent,
      ok: true,
      latencyMs: decision.latencyMs,
      attempts: decision.attempts,
      text
    });
    return {
      handled: true,
      latencyMs: decision.latencyMs,
      response: {
        ...out,
        intent,
        lang,
        agent: agentMeta
      }
    };
  }

  const replyText = decision.mode === 'say' ? decision.say : decision.clarify;
  memory.appendMessage(sessionId, { role: 'assistant', text: replyText, kind: 'chat' });
  agentAudit.record({
    sessionId,
    lang,
    model: o.model || null,
    mode: decision.mode,
    tool: null,
    intent: decision.mode === 'say' ? 'chat' : 'clarify',
    ok: true,
    latencyMs: decision.latencyMs,
    attempts: decision.attempts,
    text
  });
  return {
    handled: true,
    latencyMs: decision.latencyMs,
    response: {
      ok: true,
      version: supervisor.SUPERVISOR_VERSION,
      sessionId,
      intent: decision.mode === 'say' ? 'chat' : 'clarify',
      reply: replyText,
      replyKey: decision.mode === 'say' ? 'assistant.reply.agentChat' : 'assistant.reply.agentClarify',
      lang,
      actions: null,
      plan: null,
      missing: null,
      refs: null,
      canExecute: false,
      agent: agentMeta
    }
  };
}

module.exports = {
  AGENT_RUNTIME_VERSION,
  TOOL_INTENT,
  handleAgentTurn
};
