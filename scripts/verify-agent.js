// ==========================================
// 验收：小智 B 目标 · 工具调用 agent 契约（2026-11-19）
// ------------------------------------------------------------
// 全部 stub：**不发任何真实请求、不花钱、不连服务、不写业务数据**。
// 覆盖：
//   ① 工具注册表与白名单（没有 execute/付费/删除工具）
//   ② prompt 由注册表生成（中英各一份）
//   ③ 输出校验（单 JSON / 三选一 / 工具名 / 参数名 / 参数类型 / 枚举 / 范围）
//   ④ say 接地（假执行、承诺、无依据金额一律拒绝）
//   ⑤ runTurn：正常、坏 JSON 一次重试、两次失败、无 Key、抛异常、上下文历史
//   ⑥ 总开关默认关 + 源码不接线（本刀只落契约，不动运行链路）
// 用法：cd app && node scripts/verify-agent.js   （退出码 0 = 全过）
// ==========================================
'use strict';

const fs = require('fs');
const path = require('path');
const agent = require('../src/assistant/agent');
const llm = require('../src/services/llmService');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}
function group(title) { console.log('\n[' + title + ']'); }

/** 临时替换 llmService.chatMulti，返回 restore。 */
function stubChat(fn) {
  const real = llm.chatMulti;
  llm.chatMulti = fn;
  return () => { llm.chatMulti = real; };
}
const reply = (obj) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const CTX = { hasPlan: true, planSummary: '3 段 × 10 秒 · 720p', budgetUsd: 196, activeTasks: 0 };

(async () => {
  console.log('小智 B 目标 · 工具调用 agent 契约验收\n');

  // ================= [1] 注册表与白名单 =================
  group('1. 工具注册表与白名单');
  ok('版本号存在且带前缀', typeof agent.AGENT_VERSION === 'string' && agent.AGENT_VERSION.startsWith('assistant-agent.'));
  ok('工具数 ≥ 12，且每项都有 name/desc/descEn/params',
    agent.TOOLS.length >= 12
    && agent.TOOLS.every((t) => t.name && t.desc && t.descEn && t.params && typeof t.params === 'object'));
  ok('白名单里**没有** execute/delete/create_task/pay/charge/generate',
    agent.FORBIDDEN_TOOL_NAMES.every((n) => agent.TOOL_NAMES.indexOf(n) === -1),
    agent.TOOL_NAMES.join(','));
  ok('工具名唯一', new Set(agent.TOOL_NAMES).size === agent.TOOL_NAMES.length);
  ok('v1 必备工具齐全（计划/编辑/看卡/状态/预算/诊断/配乐/库存/确认）',
    ['plan_video', 'edit_plan', 'show_plan', 'show_scene_cards', 'status',
      'last_video', 'budget', 'diagnose', 'bgm', 'assets', 'confirm_plan', 'prefs', 'settings_change']
      .every((n) => agent.TOOL_NAMES.indexOf(n) !== -1));

  // ================= [2] prompt =================
  group('2. prompt 由注册表生成（中英各一份）');
  const zhPrompt = agent.buildSystemPrompt('zh', CTX);
  const enPrompt = agent.buildSystemPrompt('en', CTX);
  ok('zh prompt 含全部工具名', agent.TOOL_NAMES.every((n) => zhPrompt.indexOf(n) !== -1));
  ok('en prompt 含全部工具名', agent.TOOL_NAMES.every((n) => enPrompt.indexOf(n) !== -1));
  ok('zh prompt 写死「恰好一个非空」与「确认执行」',
    zhPrompt.indexOf('恰好一个') !== -1 && zhPrompt.indexOf('确认执行') !== -1);
  ok('en prompt 写死 JSON object 与 Confirm and run',
    /JSON object/i.test(enPrompt) && /Confirm and run/i.test(enPrompt));
  ok('prompt 带上只读上下文（计划摘要/余额）',
    zhPrompt.indexOf('3 段 × 10 秒') !== -1 && zhPrompt.indexOf('$196') !== -1);
  ok('prompt 不声称有执行工具（无 "execute" 工具条目）', !/^\s*\d+\.\s*execute\b/m.test(zhPrompt + '\n' + enPrompt));

  // ================= [3] 输出校验 =================
  group('3. 输出校验（不合规一律判失败）');
  const vPlan = agent.validateOutput({ tool: 'plan_video', args: { totalMinutes: 2, resolution: '1080p' } });
  ok('plan_video 合法输出通过', vPlan.ok && vPlan.mode === 'tool' && vPlan.args.totalMinutes === 2);
  ok('edit_plan swap_all 合法', agent.validateOutput({ tool: 'edit_plan', args: { action: 'swap_all' } }).ok);
  ok('say-only 合法', agent.validateOutput({ say: '你好，我是小智。' }).ok);
  ok('clarify 合法', agent.validateOutput({ clarify: '你要做多长？' }).ok);
  ok('未知工具被拒', agent.validateOutput({ tool: 'delete_everything' }).error === 'TOOL_NOT_ALLOWED');
  ok('禁用工具 execute 被拒', agent.validateOutput({ tool: 'execute', args: {} }).error === 'FORBIDDEN_TOOL');
  ok('同时给 say 和 tool → AMBIGUOUS_OUTPUT',
    agent.validateOutput({ tool: 'status', say: '好的' }).error === 'AMBIGUOUS_OUTPUT');
  ok('空输出被拒', agent.validateOutput({}).error === 'EMPTY_OUTPUT');
  ok('clarify 空串 → EMPTY_OUTPUT', agent.validateOutput({ clarify: '   ' }).error === 'EMPTY_OUTPUT');
  ok('segment 非数字 → BAD_ARG',
    (() => { const r = agent.validateOutput({ tool: 'edit_plan', args: { action: 'swap_scene', segment: 'abc' } }); return r.error === 'BAD_ARG' && r.arg === 'segment'; })());
  ok('未知参数被丢弃并记 warning',
    (() => {
      const r = agent.validateOutput({ tool: 'status', args: { nonsense: 1 } });
      return r.ok && r.warnings.indexOf('UNKNOWN_ARG:nonsense') !== -1;
    })());
  ok('数字字符串被规范化（"2" → 2）',
    agent.validateOutput({ tool: 'plan_video', args: { totalMinutes: '2' } }).args.totalMinutes === 2);
  ok('clipCount=0 被拒', agent.validateOutput({ tool: 'plan_video', args: { clipCount: 0 } }).error === 'BAD_ARG');
  ok('枚举外 action 被拒',
    agent.validateOutput({ tool: 'edit_plan', args: { action: 'nuke_everything' } }).error === 'BAD_ARG');
  ok('edit_plan 缺 action → BAD_ARG',
    (() => { const r = agent.validateOutput({ tool: 'edit_plan', args: [] }); return r.error === 'BAD_ARG' && r.reason === 'MISSING'; })());
  ok('say 超长截断到 2000',
    agent.validateOutput({ say: '啊'.repeat(2500) }).say.length === 2000);

  // ================= [4] say 接地 =================
  group('4. say 接地（假执行 / 承诺 / 无依据金额）');
  ok('「已帮你生成」被拒', agent.checkSayGrounding('已经帮你生成了 3 段视频。', CTX).reason === 'ACTION_CLAIM');
  ok('「保证能出片」被拒', agent.checkSayGrounding('放心，保证能出片。', CTX).reason === 'PROMISE');
  ok('无依据金额被拒', agent.checkSayGrounding('大概要 $3。', CTX).reason === 'UNGROUNDED_MONEY');
  ok('有依据金额通过（上下文里是 $196）', agent.checkSayGrounding('你现在余额是 $196。', CTX).ok);
  ok('普通聊天通过', agent.checkSayGrounding('你可以先告诉我总时长，我再帮你排。', CTX).ok);
  ok('英文假执行被拒（I already generated）',
    agent.checkSayGrounding('I already generated 3 clips for you.', CTX).reason === 'ACTION_CLAIM');
  ok('英文假完成被拒（it is done）',
    agent.checkSayGrounding('It is done, you can check the output.', CTX).reason === 'ACTION_CLAIM');
  ok('英文承诺被拒（I can guarantee / definitely will）',
    agent.checkSayGrounding('I can guarantee it will work.', CTX).reason === 'PROMISE'
    && agent.checkSayGrounding('It will definitely work.', CTX).reason === 'PROMISE');
  ok('英文否定承诺不误伤（I cannot guarantee）',
    agent.checkSayGrounding('I cannot guarantee the result, but I can try.', CTX).ok);
  ok('英文普通聊天不误伤（I can help you plan / the pipeline generated）',
    agent.checkSayGrounding('I can help you plan a video.', CTX).ok
    && agent.checkSayGrounding('The pipeline only generates clips after you confirm.', CTX).ok);

  // ================= [5] runTurn =================
  group('5. runTurn（stub，不花钱）');
  const toolTurn = await agent.runTurn({
    text: '来个两分钟的 1080p',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => reply({ tool: 'plan_video', args: { totalMinutes: 2, resolution: '1080p' } })
  });
  ok('工具路径：ok + tool + args',
    toolTurn.ok && toolTurn.mode === 'tool' && toolTurn.tool === 'plan_video'
    && toolTurn.args.totalMinutes === 2 && toolTurn.attempts === 1);

  const sayTurn = await agent.runTurn({
    text: '你能做什么？',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => reply({ say: '我能陪你排计划、改计划、看进度和预算。' })
  });
  ok('说话路径：ok + say', sayTurn.ok && sayTurn.mode === 'say' && sayTurn.say.indexOf('排计划') !== -1);

  const clarifyTurn = await agent.runTurn({
    text: '搞一下',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => reply({ clarify: '你想做多长？' })
  });
  ok('反问路径：ok + clarify', clarifyTurn.ok && clarifyTurn.mode === 'clarify');

  let calls = 0;
  const retryTurn = await agent.runTurn({
    text: '来个 30 秒',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => {
      calls += 1;
      return calls === 1 ? reply('好的我马上安排') : reply({ tool: 'plan_video', args: { totalMinutes: 0.5 } });
    }
  });
  ok('坏 JSON → 一次重试后成功（attempts=2）', retryTurn.ok && retryTurn.attempts === 2 && calls === 2);

  calls = 0;
  const badTwice = await agent.runTurn({
    text: '来个 30 秒',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => { calls += 1; return reply('还是不对'); }
  });
  ok('两次坏 JSON → ok:false / BAD_JSON / attempts=2',
    badTwice.ok === false && badTwice.failure.kind === 'BAD_JSON' && badTwice.attempts === 2 && calls === 2);

  const noKey = await agent.runTurn({
    text: '进度',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => ({ text: '', failure: { kind: 'NO_KEY' } })
  });
  ok('无 Key → ok:false / NO_KEY（不抛异常、不重试）',
    noKey.ok === false && noKey.failure.kind === 'NO_KEY' && noKey.attempts === 1);

  const thrown = await agent.runTurn({
    text: '进度',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => { throw new Error('network down'); }
  });
  ok('调用抛异常 → ok:false / THROWN', thrown.ok === false && thrown.failure.kind === 'THROWN');

  const empty = await agent.runTurn({ text: '   ', lang: 'zh', ctx: CTX, callLLM: async () => reply({ say: 'x' }) });
  ok('空输入 → EMPTY_INPUT', empty.ok === false && empty.failure.kind === 'EMPTY_INPUT');

  let captured = null;
  let capturedOpts = null;
  const histTurn = await agent.runTurn({
    text: '那再改改',
    lang: 'zh',
    ctx: CTX,
    history: [{ role: 'user', text: '做个 30 秒' }, { role: 'assistant', text: '好的' }],
    timeoutMs: 4000,
    callLLM: async (system, messages, opts2) => {
      captured = messages;
      capturedOpts = opts2;
      return reply({ say: '你想改哪一段？' });
    }
  });
  ok('history 按顺序进 messages（3 条：user/assistant/user）',
    histTurn.ok && captured.length === 3 && captured[0].role === 'user'
    && captured[1].role === 'assistant' && captured[2].content === '那再改改');
  ok('temperature 默认 0.3、timeoutMs 透传',
    capturedOpts.temperature === 0.3 && capturedOpts.timeoutMs === 4000);

  const ungrounded = await agent.runTurn({
    text: '要多少钱',
    lang: 'zh',
    ctx: CTX,
    callLLM: async () => reply({ say: '大概要 $9.99。' })
  });
  ok('say 无依据金额 → 整条拒绝（SAY_UNGROUNDED）',
    ungrounded.ok === false && ungrounded.failure.kind === 'SAY_UNGROUNDED'
    && ungrounded.failure.reason === 'UNGROUNDED_MONEY');

  // 默认调用链走 llmService.chatMulti（接线前的最后一道保险）
  const restore = stubChat(async () => reply({ tool: 'status', args: {} }));
  const defaultTurn = await agent.runTurn({ text: '进度', lang: 'zh', ctx: CTX });
  restore();
  ok('默认调用走 llmService.chatMulti', defaultTurn.ok && defaultTurn.tool === 'status');

  // ================= [6] 开关与接线状态 =================
  group('6. 总开关与接线状态');
  ok('isEnabled 默认关', agent.isEnabled({}) === false && agent.isEnabled({ ASSISTANT_AGENT: 'off' }) === false);
  ok('isEnabled 只有显式 on 才开', agent.isEnabled({ ASSISTANT_AGENT: 'on' }) === true
    && agent.isEnabled({ ASSISTANT_AGENT: 'true' }) === false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'assistant', 'agent.js'), 'utf8');
  ok('契约层不 require supervisor/server（本刀不接线）',
    !/require\(['"][^'"]*supervisor['"]\)/.test(src) && !/require\(['"][^'"]*server['"]\)/.test(src));
  ok('契约层不写文件/不建任务（无 fs.write / createTask）',
    !/fs\.write/.test(src) && !/createTask/.test(src));

  console.log('\n================================================================');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('================================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('\n验收异常: ' + (e && e.message ? e.message : e));
  console.log(e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : '');
  process.exit(1);
});
