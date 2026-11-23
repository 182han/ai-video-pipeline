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
const crypto = require('crypto');

const AGENT_RUNTIME_VERSION = 'assistant-agent-runtime.v1.0.0';

// 工具 → 对前端有意义的意图（前端只用 create/confirm 决定弹不弹计划卡）。
const TOOL_INTENT = Object.freeze({
  plan_video: 'create',
  edit_plan: 'plan_edit',
  show_plan: 'plan_edit',
  show_prompt: 'plan_edit',
  show_scene_cards: 'plan_scenes',
  search_scene_cards: 'plan_scenes',
  status: 'status',
  last_video: 'last',
  budget: 'context',
  diagnose: 'repair',
  // 2026-11-23：补跑确认卡。intent 用 repair，前端据此不弹计划卡（不是新建任务）。
  resume_task: 'repair',
  bgm: 'bgm',
  settings_change: 'settings',
  prefs: 'prefs',
  assets: 'assets',
  confirm_plan: 'confirm'
});

// 2026-11-19 S3：英文下工具/参数错误话术由 supervisor.TOOL_ERROR_EN 统一提供

function normalizeLang(lang) {
  return String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

// ==========================================
// 2026-11-23：可观测性 + 确认词闸
// ------------------------------------------------------------
// 事故：用户说「可以」，模型重试后回「好的，已按要求以 JSON 格式回复。」；
// 而 agent 审计只记了 tool/延迟，看不出「同一段回复连续出现」。
// 这里补：① 回复/参数摘要进审计；② 裸确认在计划卡语境下走确定性 confirm，
// 不再让模型用 say 自由发挥（也不会误把「可以」当成 JSON 格式问题）。
// ==========================================
function digestText(text) {
  return crypto.createHash('sha256').update(String(text === undefined || text === null ? '' : text)).digest('hex').slice(0, 16);
}

function previewArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const k of Object.keys(args).slice(0, 20)) {
    const v = args[k];
    out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}

const RE_BARE_CONFIRM = /^(?:可以|行|好|好的|确认|开始|开始吧|执行|确认执行|OK|ok|嗯|嗯嗯)[。！!，,.\s]*$/;
// 2026-11-23 live 抽检：「确认生成吗」模型会同时输出 say + tool（AMBIGUOUS_OUTPUT），
// 虽然回退规则路径也能答对，但没必要为此浪费一次模型调用；确认问句同样走确定性 confirm。
const RE_CONFIRM_QUESTION = /^(?:那|那么|现在|就)?\s*(?:确认|确定|开始|执行)(?:生成|执行|开始)?(?:吗|嘛|么|吧)?[？?。！!\s]*$/;

function isBareConfirm(text) {
  const s = String(text || '').trim();
  return RE_BARE_CONFIRM.test(s) || RE_CONFIRM_QUESTION.test(s);
}

/** 上一条 assistant 是不是在提问（决定「可以」是回答还是确认）。 */
function lastAssistantIsQuestion(history) {
  const last = (Array.isArray(history) ? history : [])
    .slice().reverse().find((m) => m && m.role === 'assistant' && m.text);
  if (!last) return false;
  const t = String(last.text).trim();
  return /[?？]\s*$/.test(t)
    || /(?:吗|呢|要不要|你想|你要|请告诉我)[。！!…\s]*$/.test(t);
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

  // 2026-11-23：裸确认（可以/行/好/OK）+ 有计划 + 上一条不是提问 → 确定性 confirm。
  // 不走模型：避免「可以」被模型翻译成空话，也避免一次无意义的 LLM 调用。
  const planForConfirm = memory.lastPlan(sessionId);
  if (planForConfirm && isBareConfirm(text) && !lastAssistantIsQuestion(history)) {
    memory.appendMessage(sessionId, { role: 'user', text });
    const out = supervisor.runAgentTool({
      tool: 'confirm_plan', args: {}, sessionId, userId, lang
    });
    const replyText = (out && out.reply)
      ? out.reply
      : (lang === 'en'
        ? 'The plan is ready; press "Confirm and run" on the plan card when you want to start.'
        : '计划还在，点计划卡上的「确认执行」我才开始。');
    const agentMeta = {
      version: agent.AGENT_VERSION,
      runtime: AGENT_RUNTIME_VERSION,
      mode: 'tool',
      tool: 'confirm_plan',
      latencyMs: 0,
      attempts: 0,
      warnings: [],
      deterministic: true
    };
    agentAudit.record({
      sessionId,
      lang,
      model: o.model || null,
      mode: 'tool',
      tool: 'confirm_plan',
      intent: 'confirm',
      ok: !!(out && out.ok === true),
      latencyMs: 0,
      attempts: 0,
      deterministic: true,
      replyDigest: digestText(replyText),
      replyChars: String(replyText).length,
      text
    });
    return {
      handled: true,
      latencyMs: 0,
      response: {
        ...(out || {}),
        ok: !!(out && out.ok === true),
        reply: replyText,
        intent: 'confirm',
        lang,
        agent: agentMeta
      }
    };
  }

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
      agentUnanswered: true,
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
      const code = (out && out.code) || 'AGENT_TOOL_FAILED';
      const error = lang === 'en'
        ? (supervisor.TOOL_ERROR_EN[code] || 'The tool could not be executed.')
        : ((out && out.error) || '工具执行失败');
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
        args: previewArgs(decision.args),
        replyDigest: digestText(error),
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
      args: previewArgs(decision.args),
      replyDigest: digestText(out.reply),
      replyChars: String(out.reply || '').length,
      matchCount: Array.isArray(out.matches) ? out.matches.length : undefined,
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
    replyDigest: digestText(replyText),
    replyChars: String(replyText || '').length,
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
