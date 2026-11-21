// ==========================================
// verify-broadcast-i18n.js —— 小智简报按连接语言渲染 + 提示词/场景卡槽位区分（2026-11-21）
// ------------------------------------------------------------
// 用户反馈（截图为证）：
//   ① 英文界面下【小智简报】仍是中文（「新建：task_…」）；
//   ② 「我说看一下提示词，它给的是场景卡的内容」——实测根因：
//      「我要查看完整的全部12段12个场景的提示词」被 classify 判成 create（「12 段」），
//      回了一张新计划卡（卡上「场景：场景卡库随机抽取 12 个不同场景」读起来就像在讲卡）。
//
// 本套件只做**纯逻辑**断言（不建任务、不产生费用）；每个用例都有负向护栏。
// 通过判定：退出码 0 且末行「结果: N 通过 / 0 失败」。
// ==========================================
'use strict';

const broadcast = require('../src/assistant/broadcast');
const memory = require('../src/assistant/memory');
const supervisor = require('../src/assistant/supervisor');
const wsManager = require('../src/wsManager');

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); } else {
    failed += 1;
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + String(extra).replace(/\n/g, ' | ').slice(0, 300)));
  }
}
function group(t) { console.log('\n[' + t + ']'); }

// CJK 检测：英文简报里只允许出现「用户内容」（错误原文等），模板句必须无中文。
const CJK = /[\u4e00-\u9fff]/;

function basePayload(items, extra) {
  return {
    type: 'assistantBroadcast', kind: 'task_brief', merged: items.length > 1, count: items.length,
    omitted: 0, items, text: '【小智简报】 任务更新：\n· 新建：task_x', ...(extra || {})
  };
}

try {
  // ================= [1] 简报：中文逐字不变 =================
  group('1. 简报中文路径零回归');
  const itemZh = {
    eventId: 'evt_1', node: 'task_created', taskId: 'task_x', status: 'generating',
    text: '· 新建：task_x（openai-video · 9 段）'
  };
  const p = basePayload([itemZh]);
  ok('render(payload, "zh") 原样返回同一对象（不重建、不改文案）', broadcast.render(p, 'zh') === p);
  ok('render(payload, undefined) 也走中文（默认语言）', broadcast.render(p, undefined) === p);
  ok('render(payload, "zh-CN") 归一化后走中文', broadcast.render(p, 'zh-CN') === p);

  // ================= [2] 简报：英文渲染 =================
  group('2. 简报英文路径（用户问题 ②）');
  const task = {
    taskId: 'task_i18n_0001', status: 'failed', model: 'openai-video', totalClips: 4,
    error: '余额不足', clips: []
  };
  const pEn = basePayload([
    {
      eventId: 'evt_2', node: 'task_failed', taskId: 'task_i18n_0001', status: 'failed',
      text: '· 失败：task_i18n_0001 — 余额不足。建议：补跑（未点「修复」不会执行）', task
    },
    {
      eventId: 'evt_3', node: 'task_created', taskId: 'task_i18n_0002', status: 'generating',
      text: '· 新建：task_i18n_0002（openai-video · 9 段）',
      task: { taskId: 'task_i18n_0002', model: 'openai-video', totalClips: 9, status: 'generating' }
    }
  ], { omitted: 1 });
  const en = broadcast.render(pEn, 'en');
  ok('英文简报前缀是 [Briefing]，不再出现【小智简报】',
    en.textEn.startsWith('[Briefing]') && !en.textEn.includes('【小智简报】'), en.textEn);
  ok('英文条目用 Created / Failed 标签', /· Created: task_i18n_0002/.test(en.textEn) && /· Failed: task_i18n_0001/.test(en.textEn), en.textEn);
  ok('英文「建议」走英文（不再出现「建议：」）', !en.textEn.includes('建议：') && /Suggested: /.test(en.textEn), en.textEn);
  ok('模板句无中文（taskId / 错误原文属内容，允许保留）',
    !/新建|失败：|任务更新|任务播报/.test(en.textEn), en.textEn);
  ok('英文里保留未列出的条数（omitted=1）', /1 more were not listed/.test(en.textEn), en.textEn);
  ok('items[].textEn 逐条给出（前端可单独渲染）',
    Array.isArray(en.items) && en.items.every((i) => typeof i.textEn === 'string' && i.textEn.length > 0));
  ok('英文渲染不改原 payload（纯函数）',
    pEn.items[0].text.includes('失败：') && !pEn.items[0].textEn, pEn.items[0]);
  ok('同一份 payload 中文渲染仍原样（英中添加不影响中文）', broadcast.render(pEn, 'zh') === pEn);

  // 无 task 对象的条目（例如只带了中文 text 的旧形状）→ 英文也不能直接漏中文
  const pNoTask = basePayload([{ eventId: 'evt_9', node: 'task_started', taskId: 'task_z', status: 'generating', text: '· 开始：task_z（运行中）' }]);
  const enNoTask = broadcast.render(pNoTask, 'en');
  ok('无 task 对象时英文条目不回退中文模板', !/开始：/.test(enNoTask.textEn) && /Started: task_z/.test(enNoTask.textEn), enNoTask.textEn);

  // ================= [3] WebSocket：按连接语言分发 =================
  group('3. WebSocket 按连接语言分发（英文连接拿英文）');
  const sent = { zh: null, en: null };
  const fakeWs = { readyState: 1, send(s) { this.got.push(s); }, got: [] };
  const wm = Object.create(Object.getPrototypeOf(wsManager));
  wm.clients = new Map();
  wm.clientLang = new Map();
  wm.clients.set('c_zh', { readyState: 1, send: (s) => { sent.zh = s; } });
  wm.clients.set('c_en', { readyState: 1, send: (s) => { sent.en = s; } });
  wm.clientLang.set('c_zh', 'zh');
  wm.clientLang.set('c_en', 'en');
  const n = wm.broadcastAssistant(pEn);
  const msgZh = JSON.parse(sent.zh || '{}');
  const msgEn = JSON.parse(sent.en || '{}');
  ok('broadcastAssistant 推给全部 OPEN 连接', n === 2);
  ok('中文连接收到中文 text，且不带 textEn 变化', /【小智简报】|新建：|失败：/.test(msgZh.text) && msgZh.lang === 'zh', msgZh.text);
  ok('英文连接收到英文 textEn（textEn 在顶层，可直接显示）',
    typeof msgEn.textEn === 'string' && msgEn.textEn.startsWith('[Briefing]') && msgEn.lang === 'en', msgEn.textEn);
  ok('英文连接的 item 条目也是英文', Array.isArray(msgEn.items) && msgEn.items.every((i) => !CJK.test(String(i.textEn).replace(/task_|余额不足/g, ''))), JSON.stringify(msgEn.items && msgEn.items[0]));
  void fakeWs;

  // ================= [4] 提示词 vs 场景卡（用户问题 ①） =================
  group('4. 提示词 / 场景卡槽位区分');
  const sid = 'verify-broadcast-i18n-' + Date.now();
  const built = supervisor.handleMessage({ sessionId: sid, text: '2 分钟', lang: 'zh' });
  ok('前置：2 分钟 → 12 段计划（纯本地计算，不建任务）',
    built.plan && built.plan.clipCount === 12 && built.intent === 'create', built.reply && built.reply.split('\n')[0]);

  const promptCases = [
    '我要查看完整的全部12段12个场景的提示词',
    '提示词呢',
    '看一下提示词',
    '全部提示词',
    '第 2 段的提示词'
  ];
  for (const t of promptCases) {
    const r = supervisor.handleMessage({ sessionId: sid, text: t, lang: 'zh' });
    ok('提示词句「' + t + '」→ replyKey=promptView（贴原文，不是列卡、不是新计划）',
      r.replyKey === 'assistant.reply.promptView' && /提示词原文/.test(r.reply) && !r.plan,
      r.replyKey + ' :: ' + String(r.reply).split('\n')[0]);
  }
  const big = supervisor.handleMessage({ sessionId: sid, text: '我要查看完整的全部12段12个场景的提示词', lang: 'zh' });
  ok('「全部」放宽到 20 段：12 段一次全看到', /本次贴 12 段/.test(big.reply), String(big.reply).split('\n')[0]);
  ok('提示词视图标题明确写出「不是场景卡清单」（避免用户以为在列卡）', /不是场景卡清单/.test(big.reply));

  const cardCases = ['场景卡', '场景卡呢', '我要查看完整的全部12段12个场景的场景卡。', '看一下场景卡'];
  for (const t of cardCases) {
    const r = supervisor.handleMessage({ sessionId: sid, text: t, lang: 'zh' });
    ok('场景卡句「' + t + '」→ plan_scenes（列卡，不贴提示词）',
      r.intent === 'plan_scenes' && r.replyKey === 'assistant.reply.planScenes' && /#1/.test(r.reply) && !r.plan,
      r.intent + ' :: ' + String(r.reply).split('\n')[0]);
  }

  // 负向：改动句不能被「查看」抢走
  const e1 = supervisor.handleMessage({ sessionId: sid, text: '把第 2 段提示词改成：雪山日落，广角镜头。', lang: 'zh' });
  ok('负向：「第 2 段提示词改成：X」仍是编辑，不是查看',
    e1.replyKey === 'assistant.reply.planEdit' && /已改第 2 段提示词/.test(e1.reply), e1.reply);
  const e2 = supervisor.handleMessage({ sessionId: sid, text: '第 2 段换一个', lang: 'zh' });
  ok('负向：「第 2 段换一个」仍是换卡，不是查看',
    /已换第 2 段/.test(e2.reply), e2.reply);
  const e3 = memory.classify('10 分钟');
  ok('负向：「10 分钟」仍是 create（不能被查看分支抢走）', e3.intent === 'create', JSON.stringify(e3));
  const e4 = memory.classify('把场景改成极光，3 分钟');
  ok('负向：「把场景改成极光，3 分钟」仍是 create（带总时长）', e4.intent === 'create', JSON.stringify(e4));
  const e5 = memory.classify('换一个场景卡，我不太满意');
  ok('负向：「换一个场景卡，我不太满意」仍是 plan_edit', e5.intent === 'plan_edit', JSON.stringify(e5));
  const e6 = memory.classify('都换成 1080p');
  ok('负向：「都换成 1080p」不因新分支变成查看', e6.intent !== 'plan_edit' || e6.reason === 'slot_only', JSON.stringify(e6));

  // 英文槽位
  const enView = supervisor.handleMessage({ sessionId: sid, text: 'show me all prompts', lang: 'en' });
  ok('英文「show me all prompts」→ 英文提示词原文', enView.replyKey === 'assistant.reply.promptView' && /Prompt text of this plan/.test(enView.reply), enView.replyKey);
  const enCard = supervisor.handleMessage({ sessionId: sid, text: 'show the scene cards', lang: 'en' });
  ok('英文「show the scene cards」→ 场景卡预览，不混提示词',
    enCard.intent === 'plan_scenes' && /scene cards/i.test(enCard.reply) && !/Prompt text/.test(enCard.reply), enCard.reply && enCard.reply.split('\n')[0]);

  // ================= [5] 静态接线（防「改回单份中文」） =================
  group('5. 静态接线');
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const wsSrc = read('src/wsManager.js');
  const bSrc = read('src/assistant/broadcast.js');
  const memSrc = read('src/assistant/memory.js');
  ok('wsManager：broadcast 延迟 require（避免 taskManager↔wsManager 环）',
    /function assistantBroadcastModule\(\)/.test(wsSrc) && /require\('\.\/assistant\/broadcast'\)/.test(wsSrc)
    && !/^const assistantBroadcast = require/m.test(wsSrc));
  ok('wsManager：广播时按连接语言渲染', /assistantBroadcastModule\(\)\.render\(payload, lang\)/.test(wsSrc));
  ok('broadcast：导出 render 且按 normalizeLang 判英文', /render,/.test(bSrc) && /i18n\.normalizeLang\(lang\) === 'en'/.test(bSrc));
  ok('memory：提示词查看先于 create（plan_edit 分支在 plan_scenes/create 之前）',
    /isPromptViewRequest\(s\) && !RE_PROMPT_SET_VERB/.test(memSrc));
  ok('agent 提示词含「槽位区分」（提示词 ≠ 场景卡）',
    /SLOT DISTINCTION/.test(read('src/assistant/agent.js')) && /提示词 ≠ 场景卡|槽位区分/.test(read('src/assistant/agent.js')));
  ok('brain 提示词含「提示词 ≠ 场景卡」', /提示词 ≠ 场景卡/.test(read('src/assistant/brain.js')));
} finally {
  try { memory.getOrCreate('verify-broadcast-i18n-cleanup'); } catch (e) { /* ignore */ }
}

console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
