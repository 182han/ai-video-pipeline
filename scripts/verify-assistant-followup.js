#!/usr/bin/env node
// ============================================================
// 验收：小智「答非所问」修复（2026-11-18 用户反馈，task-3）
// ------------------------------------------------------------
// 覆盖（全部零计费、进程内、不启动服务、不动真实 data/）：
//   [1] 意图分类：无段号的「提示词看一下/看一下提示词」→ plan_edit；
//       「换一组/再换一组/重新来一组」→ plan_edit（批量换卡）；负向不误伤。
//   [2] 负向：没有计划卡时看提示词 → 明确说明没有计划，不问时长、不建任务。
//   [3] 有当前计划时：
//       · 「提示词看一下 / 看一下提示词」→ 只读展示（前 N 段），不问「这条视频要做多长」；
//       · 「看一下场景卡」→ plan_scenes 预览；
//       · 「换一组 / 再换一组」→ 整批换卡：planId 不变、任务数不变、不新建计划；
//       · 显式「第 2 段」查看仍逐段显示（既有行为不回归）。
//   [4] 语言：上述话术中英各跑；英文模式必须是英文（含「十秒 每段5秒」的 PLAN_* 错误）；
//       同一句中文模式保持原中文（零回归）。
//   [5] 人类可读任务标签：diagnose summary / status 回复不再以裸 taskId 开头，
//       但完整 taskId 仍保留（既有断言可继续用）。
//   [6] 源码接线静态断言（防回退成旧行为）。
//
// 用法：cd app && node scripts/verify-assistant-followup.js
// 退出码：0 = 全过；1 = 有失败。跳过≠通过。
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-followup-'));
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
process.env.DATABASE_TYPE = 'json';
process.env.BUDGET_USD = '196';
for (const d of ['assistant', 'tasks', 'clips', 'output', 'library', 'photos', 'projects', 'logs']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
}

const ROOT = path.resolve(__dirname, '..');
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

const memory = require('../src/assistant/memory');
const supervisor = require('../src/assistant/supervisor');
const taskManager = require('../src/taskManager');
const diagnose = require('../src/assistant/diagnose');

const taskCount = () => taskManager.getAllTasks().length;
const msg = (text, lang, sessionId) => supervisor.handleMessage({ sessionId, text, lang });
const hasAskDuration = (reply) => /这条视频要做多长|How long should the video be/.test(String(reply || ''));
const enc = (c) => /[\u4e00-\u9fff]/.test(String(c || ''));

try {
  // ================= [1] 意图分类 =================
  group('1. 意图分类（用户真实原话）');
  const viewPhrases = ['提示词看一下', '看一下提示词', '把提示词给我看一下', '提示词是什么'];
  for (const text of viewPhrases) {
    ok(`「${text}」→ plan_edit（不再落 unknown→问时长）`,
      memory.classify(text).intent === 'plan_edit', memory.classify(text).intent);
  }
  ok('负向：「看一下场景卡」仍是 plan_scenes（不被提示词查看抢走）',
    memory.classify('看一下场景卡').intent === 'plan_scenes');
  ok('负向：「提示词改成：雪山」不算查看（无段号也可进 plan_edit 修改路径）',
    memory.isPromptViewRequest('提示词改成：雪山') === false
    && memory.classify('提示词改成：雪山').intent === 'plan_edit');
  ok('负向：「再来一条」仍是 create（不误判成换一组）',
    memory.classify('再来一条').intent === 'create' && memory.isBatchSceneEdit('再来一条') === false);
  const batchPhrases = ['换一组', '再换一组', '重新来一组', '换一批', '三个都想换掉'];
  for (const text of batchPhrases) {
    ok(`「${text}」→ plan_edit + isBatchSceneEdit=true`,
      memory.classify(text).intent === 'plan_edit' && memory.isBatchSceneEdit(text) === true);
  }
  ok('负向：「来一组 10 分钟」是排计划（create），不是换卡',
    memory.classify('来一组 10 分钟').intent === 'create'
    && memory.isBatchSceneEdit('来一组 10 分钟') === false);

  // ================= [2] 无计划负向 =================
  group('2. 负向：没有计划卡时看提示词');
  for (const lang of ['zh', 'en']) {
    const before = taskCount();
    const out = msg('提示词看一下', lang, 'no-plan-' + lang);
    ok(`[${lang}] 明确说明还没有计划卡（不问时长、不建任务）`,
      out.ok === true && out.intent === 'plan_edit'
      && (lang === 'zh' ? /没有计划卡/.test(out.reply) : /no plan card/i.test(out.reply))
      && !hasAskDuration(out.reply)
      && taskCount() === before,
      out.reply && out.reply.split('\n')[0]);
  }

  // ================= [3] 有当前计划 =================
  group('3. 有当前计划：查看 / 场景卡 / 换一组');
  const sid = 'followup-main';
  const planOut = msg('30 秒', 'zh', sid);
  ok('先排一条 3 段计划（30 秒 / 默认 10 秒每段）',
    planOut.ok === true && !!planOut.plan && planOut.plan.clipCount === 3,
    JSON.stringify(planOut.plan && { clips: planOut.plan.clipCount }));
  const planId = planOut.plan && planOut.plan.planId;
  const cardsBefore = (memory.lastPlan(sid).sceneCardIds || []).slice();
  const planSame = () => (memory.lastPlan(sid) || {}).planId === planId;
  const tasksBefore = taskCount();

  // 3a 中文：查看提示词（无段号）→ 展示前 N 段
  // 2026-11-21：标题改成「提示词原文 + 本次贴 N 段」（旧文案「先贴前 3 段提示词」）。
  // 断言同时钉住新的「这不是场景卡清单」措辞——用户报过「要提示词却给了场景卡」。
  let out = msg('提示词看一下', 'zh', sid);
  ok('「提示词看一下」（zh）→ 只读展示前几段，不问时长、不建任务、planId 不变',
    out.ok === true && out.intent === 'plan_edit'
    && /提示词原文/.test(out.reply) && /本次贴 3 段/.test(out.reply)
    && /不是场景卡清单/.test(out.reply)
    && /第 1 段提示词/.test(out.reply) && /第 3 段提示词/.test(out.reply)
    && !hasAskDuration(out.reply) && planSame() && taskCount() === tasksBefore,
    out.reply && out.reply.split('\n')[0]);
  ok('查看提示词返回 replyKey=assistant.reply.promptView', out.replyKey === 'assistant.reply.promptView');

  // 3b 英文：看一下提示词 → 英文展示
  out = msg('看一下提示词', 'en', sid);
  ok('「看一下提示词」（en）→ 英文展示（无中文模板句），planId 不变',
    /showing 3/i.test(out.reply) && /Prompt text of this plan/i.test(out.reply)
    && /Clip 1 prompt/.test(out.reply)
    && !/这条视频要做多长|这条计划共/.test(out.reply)
    && !hasAskDuration(out.reply) && planSame() && taskCount() === tasksBefore,
    out.reply && out.reply.split('\n')[0]);

  // 3c 场景卡预览
  out = msg('看一下场景卡', 'zh', sid);
  ok('「看一下场景卡」（zh）→ plan_scenes 预览，planId 不变、不建任务',
    out.intent === 'plan_scenes' && /场景卡/.test(out.reply)
    && !hasAskDuration(out.reply) && planSame() && taskCount() === tasksBefore,
    out.intent);
  out = msg('看一下场景卡', 'en', sid);
  ok('「看一下场景卡」（en）→ 英文预览',
    out.intent === 'plan_scenes' && /scene cards/i.test(out.reply)
    && !/这条计划|场景卡库/.test(out.reply)
    && !hasAskDuration(out.reply) && planSame() && taskCount() === tasksBefore,
    out.reply && out.reply.split('\n')[0]);

  // 3d 整批换卡
  out = msg('换一组', 'zh', sid);
  const cardsAfter = (memory.lastPlan(sid).sceneCardIds || []).slice();
  ok('「换一组」（zh）→ 整批换卡：planId 不变、任务数不变、不重排计划',
    out.ok === true && out.intent === 'plan_edit'
    && /已换掉全部 3 段/.test(out.reply)
    && !hasAskDuration(out.reply) && planSame() && taskCount() === tasksBefore
    && JSON.stringify(cardsAfter) !== JSON.stringify(cardsBefore),
    JSON.stringify({ before: cardsBefore, after: cardsAfter }));
  out = msg('再换一组', 'en', sid);
  ok('「再换一组」（en）→ 英文整批换卡，planId 不变',
    out.ok === true && out.intent === 'plan_edit'
    && /Swapped all 3 clips/.test(out.reply)
    && !/已换掉|这条计划共/.test(out.reply)
    && !hasAskDuration(out.reply) && planSame() && taskCount() === tasksBefore,
    out.reply && out.reply.split('\n')[0]);

  // 3e 显式段号查看保持既有行为
  out = msg('把第 2 段的提示词给我看一下', 'zh', sid);
  ok('显式「第 2 段」查看仍逐段贴原文（既有行为不回归）',
    /第 2 段提示词原文（\d+ 字；/.test(out.reply)
    && !/本次贴 \d+ 段/.test(out.reply)
    && planSame() && taskCount() === tasksBefore,
    out.reply && out.reply.split('\n')[0]);
  out = msg('把第 2 段的提示词给我看一下', 'en', sid);
  ok('英文交互下显式第 2 段查看：Clip 2 英文标签', /Prompt text of clip 2/.test(out.reply), out.reply && out.reply.split('\n')[0]);

  // 3f 改了提示词后，查看能看到用户文本
  const editOut = msg('第 2 段的提示词改成：雪山湖面，缓慢推近，冷色调。', 'zh', sid);
  const viewAfterEdit = msg('提示词看一下', 'zh', sid);
  ok('改过第 2 段后再「提示词看一下」→ 能看到用户文本、planId 不变',
    /已改第 2 段提示词/.test(editOut.reply)
    && /雪山湖面，缓慢推近，冷色调/.test(viewAfterEdit.reply)
    && planSame() && taskCount() === tasksBefore,
    viewAfterEdit.reply && viewAfterEdit.reply.split('\n')[0]);

  // 3g 2026-11-21 用户原话回归（截图为证）：
  //   「我要查看完整的全部12段12个场景的提示词」——旧版被 create 抢走（「12 段」）→ 回了一张新计划卡。
  //   现在必须：plan_scenes ≠ 提示词；含「提示词」→ 贴原文；只含「场景卡」→ 列卡。
  // 独立会话：以上 3a–3f 会换卡/改提示词（同一会话里卡池会变），这里用干净会话 + 12 段计划。
  const realSid = 'followup-real-12';
  const realPlanOut = msg('2 分钟', 'zh', realSid);
  ok('用户原话回归前置：独立会话排出一条 12 段计划',
    realPlanOut.plan && realPlanOut.plan.clipCount === 12, realPlanOut.reply && realPlanOut.reply.split('\n')[0]);
  const realPlan = msg('我要查看完整的全部12段12个场景的提示词', 'zh', realSid);
  ok('用户原话「全部12段12个场景的提示词」→ 贴提示词原文（不重排计划、不列卡）',
    realPlan.intent === 'plan_edit'
    && realPlan.replyKey === 'assistant.reply.promptView'
    && /提示词原文/.test(realPlan.reply) && /第 1 段提示词/.test(realPlan.reply)
    && !/确认后会按计划顺序取/.test(realPlan.reply) && !realPlan.plan,
    realPlan.reply && realPlan.reply.split('\n')[0]);
  const realCards = msg('我要查看完整的全部12段12个场景的场景卡。', 'zh', realSid);
  ok('用户原话「…12个场景的场景卡」→ 列卡（plan_scenes），不是新计划',
    realCards.intent === 'plan_scenes' && realCards.replyKey === 'assistant.reply.planScenes'
    && /#1/.test(realCards.reply) && !realCards.plan,
    realCards.reply && realCards.reply.split('\n')[0]);
  ok('「全部」放宽到 12 段：12 段计划一次全看到',
    /本次贴 12 段/.test(realPlan.reply), realPlan.reply && realPlan.reply.split('\n')[0].slice(0, 80));

  // ================= [4] 语言：PLAN_* 错误 =================
  group('4. 语言：场景卡时长错误中英各跑');
  const zhBad = msg('十秒 每段5秒', 'zh', 'followup-bad-zh');
  ok('中文模式：仍是原中文「场景卡只支持 10 或 15 秒/段」（零回归）',
    /场景卡只支持 10 或 15 秒\/段/.test(zhBad.reply), zhBad.reply);
  const enBad = msg('十秒 每段5秒', 'en', 'followup-bad-en');
  ok('英文模式：PLAN_SCENE_CARD_DURATION → 英文说明（不再回中文）',
    /Scene cards support only 10 or 15 seconds per clip/i.test(enBad.reply)
    && !/场景卡只支持|请改成/.test(enBad.reply),
    enBad.reply);
  ok('英文 PLAN_* 错误仍不建任务', taskCount() === 0);

  // ================= [5] 人类可读任务标签 =================
  group('5. 任务标签：人类可读 + 保留完整 taskId');
  const t = taskManager.createTask('极光海岸日出', { model: 'mock', totalClips: 2, clipDuration: 10 });
  taskManager.updateClip(t.taskId, 0, { status: 'failed', error: 'fetch failed' });
  taskManager.updateTaskStatus(t.taskId, 'failed', { error: 'fetch failed' });
  const d = diagnose.diagnose(taskManager.getTask(t.taskId));
  ok('diagnose.summary 以提示词摘要开头，不用裸 taskId 开头',
    /^「极光海岸日出」/.test(d.summary) && !/^任务 task_/.test(d.summary), d.summary.slice(0, 80));
  ok('diagnose.summary 仍保留完整 taskId（既有断言/排查可用）',
    d.summary.includes(t.taskId) && d.taskId === t.taskId);
  ok('diagnose 返回人类标签字段：taskLabel/compactTaskLabel',
    typeof diagnose.taskLabel === 'function'
    && /「极光海岸日出」/.test(diagnose.taskLabel(taskManager.getTask(t.taskId)))
    && /…/.test(diagnose.shortTaskId(t.taskId)));
  // status 回复：注入状态后应带人类标签 + 完整 taskId
  memory.setState('followup-status', {
    planId: 'plan-status', state: 'running', taskId: t.taskId, finalTaskId: null,
    reason: null, lastError: null
  });
  const st = msg('进度怎样', 'zh', 'followup-status');
  ok('status 回复：人类标签在前（提示词/模型/状态），完整 taskId 仍可见',
    /极光海岸日出/.test(st.reply) && st.reply.includes(t.taskId)
    && !/^任务task_/.test(st.reply.replace(/^【[^\n]*】\n?/, '')),
    st.reply.slice(0, 120));

  // ================= [6] 源码接线静态断言 =================
  group('6. 源码接线静态断言（防回退）');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const memSrc = read('src/assistant/memory.js');
  const supSrc = read('src/assistant/supervisor.js');
  const planSrc = read('src/assistant/planCard.js');
  const diagSrc = read('src/assistant/diagnose.js');
  ok('memory：isPromptViewRequest 已接线进 classify',
    /function isPromptViewRequest/.test(memSrc) && /isPromptViewRequest\(s\)\) return \{ intent: 'plan_edit' \}/.test(memSrc));
  ok('memory：批量换卡词表含「一组/换一组/重新来一组」',
    /一组/.test(memSrc) && /换一组/.test(memSrc) && /重新来一组/.test(memSrc));
  ok('supervisor：无段号查看走「展示前 N 段」（PROMPT_VIEW_LIMIT）',
    /PROMPT_VIEW_LIMIT/.test(supSrc) && /本次贴 \$\{limit\} 段/.test(supSrc));
  // 2026-11-21 用户报「我说看提示词，它给的是场景卡的内容」：钉住两条接线
  //   ①「全部/每段」放宽到 PROMPT_COUNT_ALL_LIMIT；
  //   ② replyForPlanEdit（plan_edit 分支的直接入口）也必须先走只读视图。
  ok('supervisor：全部/每段查看放宽到 PROMPT_COUNT_ALL_LIMIT',
    /PROMPT_COUNT_ALL_LIMIT/.test(supSrc) && /wantAll \? PROMPT_COUNT_ALL_LIMIT : PROMPT_VIEW_LIMIT/.test(supSrc));
  ok('supervisor：replyForPlanEdit 先调 tryReplyPromptView（查看不被当成编辑）',
    /function replyForPlanEdit[\s\S]{0,900}?tryReplyPromptView\(sessionId, text, lang\)/.test(supSrc));
  ok('supervisor：planEditBranch 调用 tryReplyPromptView(sessionId, text, lang)',
    /tryReplyPromptView\(sessionId, text, lang\)/.test(supSrc));
  ok('supervisor：PLAN_* 英文映射走 planCard.describeErrorEn',
    /function planFailureReply/.test(supSrc) && /planCard\.describeErrorEn/.test(supSrc));
  ok('planCard：导出 describeErrorEn 且含场景卡时长英文',
    /function describeErrorEn/.test(planSrc) && /Scene cards support only/.test(planSrc)
    && /describeErrorEn/.test(planSrc.split('module.exports')[1] || ''));
  ok('diagnose：导出人类标签函数', /function taskLabel/.test(diagSrc) && /taskLabel,/.test(diagSrc));
  ok('diagnose：summary 含完整任务 ID（保留排查能力）', /任务 ID \$\{task\.taskId\}/.test(diagSrc));
  ok('supervisor：status/场景卡回复用 diagnose.taskLabel（不再裸 taskId 开头）',
    /diagnose\.taskLabel\(task\)/.test(supSrc) && /diagnose\.taskLabel\(t\)/.test(supSrc));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
}

console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
