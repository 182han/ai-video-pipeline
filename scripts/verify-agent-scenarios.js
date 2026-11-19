// ==========================================
// 验收：小智 B 目标 · 多轮剧本（agent 运行时 + 工具门面 + 会话）
// ------------------------------------------------------------
// 用**脚本化模型**（decisions 队列）替代真实 LLM：不花钱、不联网、可复现。
// 证明的是「管道是否正确」（多轮状态、工具选择→执行、失败回退、不建任务、不幻觉），
// **不证明真实模型的理解力**——那需要真机 A/B（另跑，需用户批准预算）。
//
// 剧本：
//   A 协作生成视频：排计划 → 改第二段 → 查预算 → 确认 → 查进度 → 失败诊断（全程 0 任务）
//   B 幻觉/越权：模型妄想直接 execute / 报价 / 承诺 → 校验拒绝 → 回退规则路径，0 任务
//   C 聊天/澄清：say / clarify
//   D 总开关：默认关 → 规则路径；只有显式 on 才走 agent
//   E 英文：英文输入 → 英文计划卡回复（无中文）
//
// 用法：cd app && node scripts/verify-agent-scenarios.js   （退出码 0 = 全过）
// ==========================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-agent-scenarios-'));
process.env.ASSISTANT_DIR = path.join(TMP, 'assistant');
process.env.DATA_DIR = path.join(TMP, 'tasks');
process.env.CLIPS_DIR = path.join(TMP, 'clips');
process.env.OUTPUT_DIR = path.join(TMP, 'output');
process.env.LIBRARY_DIR = path.join(TMP, 'library');
process.env.PHOTOS_DIR = path.join(TMP, 'photos');
process.env.PROJECTS_DIR = path.join(TMP, 'projects');
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.BUDGET_FILE = path.join(TMP, 'budget.json');
process.env.SCENE_CARDS_COOLING_FILE = path.join(TMP, 'scene-card-cooling.json');
process.env.ASSISTANT_PREFS_FILE = path.join(TMP, 'assistant-preferences.json');
process.env.ASSISTANT_AUDIT_FILE = path.join(TMP, 'assistant-audit.jsonl');
process.env.DATABASE_TYPE = 'json';
process.env.BUDGET_USD = '196';

const agent = require('../src/assistant/agent');
const agentRuntime = require('../src/assistant/agentRuntime');
const assistantMemory = require('../src/assistant/memory');
const supervisor = require('../src/assistant/supervisor');
const taskManager = require('../src/taskManager');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(title) { console.log('\n[' + title + ']'); }

// 与 server.js 相同的路由语义：agent 成功→用它的响应；失败→回退 handleMessage。
// decisions 是这一轮模型的「台词队列」（坏输出会在 agent 内部重试，消耗两条）。
async function turn({ text, sessionId, lang = 'zh', decisions }) {
  const queue = decisions.slice();
  const out = await agentRuntime.handleAgentTurn({
    text, sessionId, lang, userId: 'local', supervisor,
    callLLM: async () => {
      const d = queue.shift();
      if (d === undefined) throw new Error('decisions 队列耗尽');
      return { text: typeof d === 'string' ? d : JSON.stringify(d) };
    }
  });
  if (out.handled) return { source: 'agent', r: out.response, turn: out };
  const r = supervisor.handleMessage({ sessionId, text, lang, userId: 'local' });
  return { source: 'rules', r, turn: out };
}
const msgCount = (sid) => assistantMemory.listMessages(sid, 50).length;
const stamp = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

(async () => {
  console.log('小智 B 目标 · 多轮剧本验收（脚本化模型，0 花费）\n');

  // ================= A =================
  group('A. 协作生成视频（排计划 → 改段 → 预算 → 确认 → 进度 → 诊断）');
  {
    const sid = 'scn-a-' + stamp();
    const tasks0 = taskManager.getAllTasks().length;
    const r1 = await turn({
      text: '做个 30 秒的极光片',
      sessionId: sid,
      decisions: [{ tool: 'plan_video', args: { totalMinutes: 0.5, resolution: '720p' } }]
    });
    ok('A1 排计划：agent → intent=create、3 段、有 plan',
      r1.source === 'agent' && r1.r.ok === true && r1.r.intent === 'create'
      && r1.r.plan && r1.r.plan.clipCount === 3,
      r1.r && `${r1.source}/${r1.r.intent}`);
    const planId = r1.r.plan && r1.r.plan.planId;
    const cards1 = r1.r.plan && r1.r.plan.sceneCardIds ? r1.r.plan.sceneCardIds.slice() : [];

    const r2 = await turn({
      text: '第二段换个场景',
      sessionId: sid,
      decisions: [{ tool: 'edit_plan', args: { action: 'swap_scene', segment: 2 } }]
    });
    const cards2 = r2.r.plan && r2.r.plan.sceneCardIds ? r2.r.plan.sceneCardIds.slice() : [];
    ok('A2 改第 2 段：intent=plan_edit、planId 不变、第 2 张卡确实换了',
      r2.source === 'agent' && r2.r.intent === 'plan_edit' && r2.r.plan
      && r2.r.plan.planId === planId && cards2[1] !== cards1[1] && cards2[0] === cards1[0],
      `${cards1[1]} → ${cards2[1]}`);

    const r3 = await turn({
      text: '预算够吗',
      sessionId: sid,
      decisions: [{ tool: 'budget', args: {} }]
    });
    ok('A3 查预算：intent=context、回复含余额/已花（真实 budget 口径）',
      r3.source === 'agent' && r3.r.intent === 'context'
      && /余额|剩余/.test(r3.r.reply) && /已花|花费/.test(r3.r.reply));

    const r4 = await turn({
      text: '确认生成吗',
      sessionId: sid,
      decisions: [{ tool: 'confirm_plan', args: {} }]
    });
    ok('A4 确认：intent=confirm、回传同一计划、带 requiresApproval、**仍不建任务**',
      r4.source === 'agent' && r4.r.intent === 'confirm'
      && r4.r.plan && r4.r.plan.planId === planId
      && r4.r.actions && r4.r.actions[0] && r4.r.actions[0].requiresApproval === true
      && taskManager.getAllTasks().length === tasks0);

    const r5 = await turn({
      text: '进度怎样',
      sessionId: sid,
      decisions: [{ tool: 'status', args: {} }]
    });
    ok('A5 查进度：intent=status、有回复',
      r5.source === 'agent' && r5.r.intent === 'status' && !!r5.r.reply);

    const r6 = await turn({
      text: '上次那条为什么失败',
      sessionId: sid,
      decisions: [{ tool: 'diagnose', args: {} }]
    });
    ok('A6 失败诊断：intent=repair、只读（0 任务、不自动重跑）',
      r6.source === 'agent' && r6.r.intent === 'repair'
      && taskManager.getAllTasks().length === tasks0);

    ok('A7 全程：会话 6 轮 = 12 条消息（6 user + 6 assistant，不重不丢）',
      msgCount(sid) === 12,
      String(msgCount(sid)));
    ok('A8 全程：计划仍是同一张（改段不改 planId）+ 0 任务',
      assistantMemory.lastPlan(sid).planId === planId
      && taskManager.getAllTasks().length === tasks0);
  }

  // ================= B =================
  group('B. 幻觉 / 越权：校验拒绝 → 回退规则路径（0 任务）');
  {
    const sid = 'scn-b-' + stamp();
    const tasks0 = taskManager.getAllTasks().length;
    const b1 = await turn({
      text: '帮我直接生成',
      sessionId: sid,
      // 模型妄想调 execute：agent 校验两次都拒绝 → handled:false → 规则路径
      decisions: [{ tool: 'execute', args: {} }, { tool: 'execute', args: {} }]
    });
    ok('B1 模型妄想直接 execute → 不执行；回退规则路径问时长（0 任务）',
      b1.source === 'rules' && taskManager.getAllTasks().length === tasks0
      && /要做多长|总时长/.test(b1.r.reply),
      `${b1.source}/${b1.r.intent}`);

    const b2 = await turn({
      text: '要花多少钱',
      sessionId: sid,
      decisions: [{ say: '大概要 $9.99。' }]
    });
    ok('B2 模型编造价钱 → 接地拒绝 → 回退规则路径（不出现 $9.99 这个假数字）',
      b2.source === 'rules' && !/\$9\.99/.test(b2.r.reply),
      b2.r && String(b2.r.reply).slice(0, 40));

    const b3 = await turn({
      text: '你能保证出片吗',
      sessionId: sid,
      decisions: [{ say: '放心，保证能出片。' }]
    });
    ok('B3 模型乱承诺 → 拒绝 → 回退规则路径（不冒充保证）',
      b3.source === 'rules' && !/保证能出片/.test(b3.r.reply));

    ok('B 全程：3 次回退各只落 2 条消息（runtime 失败不写会话，规则路径写一对）',
      msgCount(sid) === 6, String(msgCount(sid)));
    ok('B 全程：0 任务（没有任何付费动作）', taskManager.getAllTasks().length === tasks0);
  }

  // ================= C =================
  group('C. 聊天 / 澄清');
  {
    const sid = 'scn-c-' + stamp();
    const c1 = await turn({
      text: '你能做什么？',
      sessionId: sid,
      decisions: [{ say: '我能陪你排计划、改计划、查进度和预算，确认后才会真正生成。' }]
    });
    ok('C1 闲聊：intent=chat、回复原文、plan=null',
      c1.source === 'agent' && c1.r.intent === 'chat'
      && /排计划/.test(c1.r.reply) && c1.r.plan === null);

    const c2 = await turn({
      text: '搞一下',
      sessionId: sid,
      decisions: [{ clarify: '你想做多长？比如「30 秒」或「2 分钟」。' }]
    });
    ok('C2 拿不准：intent=clarify、只反问、不排计划',
      c2.source === 'agent' && c2.r.intent === 'clarify'
      && /多长/.test(c2.r.reply) && c2.r.plan === null);
    ok('C3 会话落 4 条消息（2 轮 × user+assistant）', msgCount(sid) === 4, String(msgCount(sid)));
  }

  // ================= D =================
  group('D. 总开关：默认关 → 规则路径；显式 on 才走 agent');
  {
    ok('D1 isEnabled 默认关 / 显式 on 才开',
      agent.isEnabled({}) === false
      && agent.isEnabled({ ASSISTANT_AGENT: 'off' }) === false
      && agent.isEnabled({ ASSISTANT_AGENT: 'on' }) === true);
    const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    ok('D2 .env.example 记录 ASSISTANT_AGENT（默认 off）',
      /ASSISTANT_AGENT/.test(envExample) && /ASSISTANT_AGENT=off/.test(envExample));
    // 模拟 server 在开关关闭时的行为：直接走规则路径（agent 完全不被调用）
    const sid = 'scn-d-' + stamp();
    const r = supervisor.handleMessage({ sessionId: sid, text: '1080p', lang: 'zh' });
    ok('D3 关闭时：规则路径照常工作（1080p → plan_edit + 问时长）',
      r.intent === 'plan_edit' && r.plan === null && /要做多长/.test(r.reply));
  }

  // ================= E =================
  group('E. 英文：英文输入 → 英文计划卡（不夹中文）');
  {
    const sid = 'scn-e-' + stamp();
    const e1 = await turn({
      text: 'make a 30 second video',
      sessionId: sid,
      lang: 'en',
      decisions: [{ tool: 'plan_video', args: { totalMinutes: 0.5 } }]
    });
    const reply = String((e1.r && e1.r.reply) || '');
    ok('E1 英文计划：intent=create、lang=en、有 plan',
      e1.source === 'agent' && e1.r.intent === 'create' && e1.r.lang === 'en' && !!e1.r.plan);
    ok('E2 英文计划卡回复不含中文',
      reply.length > 0 && !/[\u4e00-\u9fff]/.test(reply),
      reply.split('\n')[0]);
  }

  // ================= F =================
  group('F. 看提示词（show_prompt，不是重复计划卡）');
  {
    const sid = 'scn-f-' + stamp();
    const tasks0 = taskManager.getAllTasks().length;
    const f1 = await turn({
      text: '做个 30 秒的极光片',
      sessionId: sid,
      decisions: [{ tool: 'plan_video', args: { totalMinutes: 0.5 } }]
    });
    ok('F1 先排计划（3 段）', f1.source === 'agent' && f1.r.plan && f1.r.plan.clipCount === 3);
    const f2 = await turn({
      text: '我看看提示词',
      sessionId: sid,
      decisions: [{ tool: 'show_prompt', args: {} }]
    });
    ok('F2 「我看看提示词」→ show_prompt + 贴出第 1 段原文（不是计划摘要）',
      f2.source === 'agent' && f2.r.agent && f2.r.agent.tool === 'show_prompt'
      && /第 1 段/.test(f2.r.reply) && f2.r.reply.length > 40,
      String(f2.r.reply).slice(0, 30));
    const f3 = await turn({
      text: '第二段提示词呢',
      sessionId: sid,
      decisions: [{ tool: 'show_prompt', args: { segment: 2 } }]
    });
    ok('F3 指定第 2 段 → 只贴第 2 段',
      f3.r.agent && f3.r.agent.tool === 'show_prompt'
      && /第 2 段/.test(f3.r.reply) && !/第 1 段/.test(f3.r.reply));
    ok('F4 只读：计划不变、0 任务',
      assistantMemory.lastPlan(sid).planId === f1.r.plan.planId
      && taskManager.getAllTasks().length === tasks0);
  }

  console.log('\n================================================================');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('================================================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('\n验收异常: ' + (e && e.message ? e.message : e));
  console.log(e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : '');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { /* 忽略 */ }
  process.exit(1);
});
