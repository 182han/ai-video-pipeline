#!/usr/bin/env node
// ============================================================
// 验收：小智「内容查询 / 元话术」回归（2026-11-23 用户报「有雪景吗」复读场景卡）
// ------------------------------------------------------------
// 背景（真实会话，别删）：
//   用户问「里面有雪景吗」→ 小智又贴了一遍「共 30 张，这里先列前 8 张」；
//   用户说「可以」→ 小智回「好的，已按要求以 JSON 格式回复。」
// 根因：
//   ① agent 只有「列卡」工具，没有「按内容查卡」的能力；
//   ② say 只过 JSON/金额接地，不过相关性，元话术被原样显示。
//
// 本脚本锁四件事（全部进程内、stub 模型、零计费、不写真实 data/）：
//   [1] search_scene_cards 工具注册 + prompt 路由规则；
//   [2] 固定 30 张计划下：雪景 → 第 13/17 段；空结果 → 明确「没有」；英文 → 英文回复；
//   [3] 对话链路：agent 走 search；「可以」走确定性 confirm，不再调模型；
//   [4] say 质量闸：元话术/空泛确认/无理由复读被拒；审计带 args/replyDigest/matchCount。
//
// 用法：cd app && node scripts/verify-assistant-queries.js
// 退出码：0 = 全过；1 = 有失败。跳过≠通过。
// ============================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-queries-'));
process.env.ASSISTANT_DIR = path.join(TMP, 'assistant');
process.env.DATA_DIR = path.join(TMP, 'tasks');
process.env.CLIPS_DIR = path.join(TMP, 'clips');
process.env.OUTPUT_DIR = path.join(TMP, 'output');
process.env.LIBRARY_DIR = path.join(TMP, 'library');
process.env.PHOTOS_DIR = path.join(TMP, 'photos');
process.env.PROJECTS_DIR = path.join(TMP, 'projects');
process.env.BUDGET_FILE = path.join(TMP, 'budget.json');
process.env.USERS_FILE = path.join(TMP, 'users.json');
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.ASSISTANT_AGENT_AUDIT_FILE = path.join(TMP, 'agent-audit.jsonl');
process.env.DATABASE_TYPE = 'json';
process.env.BUDGET_USD = '196';
for (const d of ['assistant', 'tasks', 'clips', 'output', 'library', 'photos', 'projects', 'logs']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}

const memory = require('../src/assistant/memory');
const supervisor = require('../src/assistant/supervisor');
const agent = require('../src/assistant/agent');
const agentRuntime = require('../src/assistant/agentRuntime');
const agentAudit = require('../src/assistant/agentAudit');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}
function group(title) { console.log('\n[' + title + ']'); }
const reply = (obj) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const hasCjk = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
const CTX = { hasPlan: true, planSummary: '30 段 × 10 秒 · openai-video · 720p', budgetUsd: 196, activeTasks: 0 };

// 2026-11-23 用户那条 5 分钟 / 30 段的真实计划（前 8 张与截图一致；第 13/17 张含雪）
const PLAN_IDS = [
  'sc-087', 'sc-158', 'sc-091', 'sc-009', 'sc-037', 'sc-239', 'sc-097', 'sc-080',
  'sc-107', 'sc-049', 'sc-055', 'sc-233', 'sc-225', 'sc-014', 'sc-156', 'sc-079',
  'sc-230', 'sc-193', 'sc-074', 'sc-177', 'sc-195', 'sc-068', 'sc-071', 'sc-062',
  'sc-172', 'sc-182', 'sc-067', 'sc-208', 'sc-226', 'sc-181'
];

/** 在临时存储里排一条 5 分钟计划，并把 30 张卡固定成用户截图里的那批。 */
function makeFixedPlan(sessionId) {
  const res = supervisor.handleMessage({ sessionId, text: '五分钟', userId: 'tester', lang: 'zh' });
  if (!res || !res.plan) throw new Error('计划创建失败：' + JSON.stringify(res && res.error));
  const plan = memory.lastPlan(sessionId);
  plan.sceneCardIds = PLAN_IDS.slice();
  plan.clipCount = PLAN_IDS.length;
  plan.totalSec = plan.clipCount * (plan.clipDurationSec || 10);
  memory.addPlan(sessionId, plan);
  return plan;
}

(async () => {
  console.log('小智内容查询/元话术闸验收（stub 模型，零计费）\n');

  // ================= [1] 工具注册与 prompt =================
  group('1. search_scene_cards 工具注册与 prompt 路由');
  const searchTool = agent.TOOL_MAP && agent.TOOL_MAP.search_scene_cards;
  ok('search_scene_cards 已注册，query 为必填 string',
    !!searchTool && searchTool.params && searchTool.params.query === 'string',
    searchTool ? JSON.stringify(searchTool.params) : '未注册');
  const zhPrompt = agent.buildSystemPrompt('zh', CTX);
  const enPrompt = agent.buildSystemPrompt('en', CTX);
  ok('zh prompt 含 search_scene_cards 与内容查询规则',
    zhPrompt.indexOf('search_scene_cards') !== -1
    && /内容查询|雪|海|沙漠|夜景/.test(zhPrompt));
  ok('en prompt 含 search_scene_cards 与 content-query 规则',
    enPrompt.indexOf('search_scene_cards') !== -1
    && /content|snow|sea|desert|night/i.test(enPrompt));
  const missingQuery = agent.validateOutput({ tool: 'search_scene_cards', args: {} });
  ok('search 缺 query → BAD_ARG / query',
    missingQuery.ok === false && missingQuery.error === 'BAD_ARG' && missingQuery.arg === 'query',
    JSON.stringify(missingQuery));

  // ================= [2] 固定 30 张计划：检索 =================
  group('2. 固定 30 张计划：雪景 / 空结果 / 英文');
  const sid1 = 's_query_tool_' + Date.now().toString(36);
  makeFixedPlan(sid1);
  const fixed = memory.lastPlan(sid1);
  ok('计划固定为 30 张，第 13 张=融雪溪、第 17 张=冰裂纹与雪',
    fixed && fixed.sceneCardIds.length === 30
    && fixed.sceneCardIds[12] === 'sc-225' && fixed.sceneCardIds[16] === 'sc-230',
    fixed && fixed.sceneCardIds.slice(11, 18).join(','));

  const snow = supervisor.runAgentTool({
    tool: 'search_scene_cards', args: { query: '雪景' }, sessionId: sid1, userId: 'tester', lang: 'zh'
  });
  ok('「雪景」→ ok + 2 张命中', snow.ok === true && Array.isArray(snow.matches) && snow.matches.length === 2,
    snow.ok ? String(snow.matches && snow.matches.length) : snow.code);
  ok('回复点名第 13/17 段，且不再是「先列前 8 张」模板',
    snow.ok === true && /第\s*13\s*段/.test(snow.reply) && /第\s*17\s*段/.test(snow.reply)
    && !/这里先列前\s*8\s*张/.test(snow.reply),
    snow.reply);

  const none = supervisor.runAgentTool({
    tool: 'search_scene_cards', args: { query: '瀑布' }, sessionId: sid1, userId: 'tester', lang: 'zh'
  });
  ok('无匹配（瀑布）→ 明确说「没有匹配」，不重复列表',
    none.ok === true && none.matches.length === 0
    && /没有匹配/.test(none.reply) && !/这里先列前\s*8\s*张/.test(none.reply),
    none.reply);

  const sea = supervisor.runAgentTool({
    tool: 'search_scene_cards', args: { query: '海' }, sessionId: sid1, userId: 'tester', lang: 'zh'
  });
  ok('「海」→ 命中多张（不是只对「雪」硬编码的一条特例）',
    sea.ok === true && sea.matches.length >= 2 && /匹配/.test(sea.reply),
    sea.ok ? String(sea.matches.length) : sea.code);

  const snowEn = supervisor.runAgentTool({
    tool: 'search_scene_cards', args: { query: 'snow' }, sessionId: sid1, userId: 'tester', lang: 'en'
  });
  ok('英文 snow → 英文回复、含 Segment 13/17、无中文',
    snowEn.ok === true && !hasCjk(snowEn.reply)
    && /Segment\s*13/.test(snowEn.reply) && /Segment\s*17/.test(snowEn.reply),
    snowEn.reply);

  const list = supervisor.runAgentTool({
    tool: 'show_scene_cards', args: {}, sessionId: sid1, userId: 'tester', lang: 'zh'
  });
  ok('列表工具保持原样（共 30 张，先列前 8 张）',
    list.ok === true && /共\s*30\s*张，这里先列前\s*8\s*张/.test(list.reply));

  // ================= [3] 对话链路 =================
  group('3. 对话链路：agent 选 search；「可以」走确定性 confirm');
  const sid2 = 's_query_turn_' + Date.now().toString(36);
  makeFixedPlan(sid2);
  let turnCalls = 0;
  const turn = await agentRuntime.handleAgentTurn({
    text: '里面有雪景吗',
    sessionId: sid2,
    userId: 'tester',
    lang: 'zh',
    supervisor,
    callLLM: async () => { turnCalls += 1; return reply({ tool: 'search_scene_cards', args: { query: '雪景' } }); }
  });
  ok('agent 路径：handled=true + 回复点名第 13/17 段',
    turn.handled === true && turn.response && turnCalls === 1
    && /第\s*13\s*段/.test(turn.response.reply) && /第\s*17\s*段/.test(turn.response.reply),
    turn.handled ? String(turn.response && turn.response.reply).slice(0, 80) : JSON.stringify(turn.failure));
  ok('intent=plan_scenes（前端不弹计划卡）',
    turn.response && turn.response.intent === 'plan_scenes' && turn.response.plan === null);

  const sid3 = 's_query_confirm_' + Date.now().toString(36);
  makeFixedPlan(sid3);
  let confirmLlmCalls = 0;
  const confirmTurn = await agentRuntime.handleAgentTurn({
    text: '可以',
    sessionId: sid3,
    userId: 'tester',
    lang: 'zh',
    supervisor,
    callLLM: async () => { confirmLlmCalls += 1; throw new Error('should not call LLM for bare confirm'); }
  });
  ok('「可以」→ 确定性 confirm，不调模型',
    confirmTurn.handled === true && confirmLlmCalls === 0,
    confirmTurn.handled ? 'handled' : JSON.stringify(confirmTurn.failure));
  ok('确认回复含「确认执行/计划卡」，不再出现 JSON 元话术',
    confirmTurn.response && /确认执行|计划卡/.test(confirmTurn.response.reply)
    && !/JSON|格式/.test(confirmTurn.response.reply),
    confirmTurn.response && confirmTurn.response.reply);

  // 上一条 assistant 是提问时，不得抢成 confirm —— 它可能是在回答问题
  const sid4 = 's_query_question_' + Date.now().toString(36);
  makeFixedPlan(sid4);
  memory.appendMessage(sid4, { role: 'assistant', text: '你想换成什么感觉？', kind: 'chat' });
  let questionLlmCalls = 0;
  const questionTurn = await agentRuntime.handleAgentTurn({
    text: '可以',
    sessionId: sid4,
    userId: 'tester',
    lang: 'zh',
    supervisor,
    callLLM: async () => { questionLlmCalls += 1; return reply({ clarify: '你想换成什么感觉？' }); }
  });
  ok('上一条是提问 → 不抢确认，仍走模型',
    questionTurn.handled === true && questionLlmCalls === 1
    && /什么感觉/.test(questionTurn.response.reply),
    questionTurn.handled ? questionTurn.response.reply : JSON.stringify(questionTurn.failure));

  // 「确认生成吗」是问句，但语义就是确认；真实模型会同时给 say + tool（AMBIGUOUS_OUTPUT），
  // 这里用确定性闸兜住，避免一次无意义的模型调用和空回复。
  const sid5 = 's_query_confirm_q_' + Date.now().toString(36);
  makeFixedPlan(sid5);
  let confirmQuestionCalls = 0;
  const confirmQuestionTurn = await agentRuntime.handleAgentTurn({
    text: '确认生成吗',
    sessionId: sid5,
    userId: 'tester',
    lang: 'zh',
    supervisor,
    callLLM: async () => { confirmQuestionCalls += 1; throw new Error('should not call LLM for confirm question'); }
  });
  ok('「确认生成吗」→ 确定性 confirm，不调模型',
    confirmQuestionTurn.handled === true && confirmQuestionCalls === 0
    && confirmQuestionTurn.response && confirmQuestionTurn.response.agent
    && confirmQuestionTurn.response.agent.deterministic === true
    && /确认执行|计划卡/.test(confirmQuestionTurn.response.reply),
    confirmQuestionTurn.handled ? JSON.stringify(confirmQuestionTurn.response.agent) : JSON.stringify(confirmQuestionTurn.failure));

  // ================= [4] say 质量闸 =================
  group('4. say 质量闸：元话术 / 空泛确认 / 无理由复读');
  if (typeof agent.checkSayQuality === 'function') {
    const meta = agent.checkSayQuality('好的，已按要求以 JSON 格式回复。', { userText: '可以' });
    ok('元话术 → META_TALK', meta.ok === false && meta.reason === 'META_TALK', JSON.stringify(meta));
    const bare = agent.checkSayQuality('好的。', { userText: '可以' });
    ok('空泛确认 → BARE_ACK', bare.ok === false && bare.reason === 'BARE_ACK', JSON.stringify(bare));
    const repeat = agent.checkSayQuality(
      '这条计划 30 段，确认后会按计划顺序取这 30 张场景卡：',
      { userText: '那这些卡呢', lastAssistantText: '这条计划 30 段，确认后会按计划顺序取这 30 张场景卡：' }
    );
    ok('无理由复读 → REPEAT', repeat.ok === false && repeat.reason === 'REPEAT', JSON.stringify(repeat));
    const repeatAsked = agent.checkSayQuality(
      '这条计划 30 段，确认后会按计划顺序取这 30 张场景卡：',
      { userText: '再说一遍', lastAssistantText: '这条计划 30 段，确认后会按计划顺序取这 30 张场景卡：' }
    );
    ok('用户明确要求「再说一遍」→ 允许复读', repeatAsked.ok === true, JSON.stringify(repeatAsked));
  } else {
    ok('checkSayQuality 已导出', false, '函数不存在');
  }

  const metaTurn = await agent.runTurn({
    text: '可以',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => reply({ say: '好的，已按要求以 JSON 格式回复。' })
  });
  ok('runTurn 元话术 → SAY_QUALITY / META_TALK',
    metaTurn.ok === false && metaTurn.failure
    && metaTurn.failure.kind === 'SAY_QUALITY' && metaTurn.failure.reason === 'META_TALK',
    JSON.stringify({ ok: metaTurn.ok, failure: metaTurn.failure }));

  const repeatText = '这条计划 30 段，确认后会按计划顺序取这 30 张场景卡：';
  const repeatTurn = await agent.runTurn({
    text: '那这些卡呢',
    lang: 'zh',
    ctx: CTX,
    history: [{ role: 'user', text: '看一下场景卡' }, { role: 'assistant', text: repeatText }],
    callLLM: async () => reply({ say: repeatText })
  });
  ok('runTurn 无理由复读 → SAY_QUALITY / REPEAT',
    repeatTurn.ok === false && repeatTurn.failure
    && repeatTurn.failure.kind === 'SAY_QUALITY' && repeatTurn.failure.reason === 'REPEAT',
    JSON.stringify({ ok: repeatTurn.ok, failure: repeatTurn.failure }));

  // ================= [5] 审计 =================
  group('5. 审计：args / replyDigest / matchCount');
  const rows = agentAudit.list(50);
  const row = rows.slice().reverse().find((r) => r && r.tool === 'search_scene_cards');
  ok('审计行含 args.query=雪景、replyDigest、matchCount=2',
    !!row && row.args && row.args.query === '雪景'
    && typeof row.replyDigest === 'string' && row.replyDigest.length >= 8
    && row.matchCount === 2,
    row ? JSON.stringify({ args: row.args, replyDigest: row.replyDigest, matchCount: row.matchCount }) : '无审计行');

  console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\n验收脚本异常：', e && e.stack ? e.stack : e);
  console.log('\n结果: ' + passed + ' 通过 / ' + (failed + 1) + ' 失败');
  process.exit(1);
});
