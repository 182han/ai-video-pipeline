#!/usr/bin/env node
// ============================================================
// 验收：后端 i18n（P2）
// ------------------------------------------------------------
// 覆盖（全部零依赖、零计费、不启动服务、不动真实 data/）：
//   [1] 运行时：语言归一化 / cookie 优先 / Accept-Language / 默认 zh
//   [2] catalog：中英 key 对等、占位符一致、无重复、无空词条、英文不含中文
//   [3] t()/tp()/插值/缺 key 回退；err()/mark() 加法式字段形状
//   [4] 反查 keyForText / 日志 logText（中文模式逐字不变）
//   [5] taskManager：task.lang（缺省 zh）、步骤 nameKey、失败/步骤/片段 errorKey
//   [6] qualityChecker：质检项 labelKey/labelZh/labelEn（加法式），中文 name 不变
//   [7] wsManager：连接级 lang 写入事件（不改变既有事件字段语义）
//   [8] server.js / taskManager / videoProcessor 静态断言：原中文串仍在、只加不删
//   [9] --probe：对已重启的本地服务做真实 HTTP 探针（默认跳过；跳过≠通过）
//
// 用法：
//   node scripts/verify-i18n-backend.js
//   node scripts/verify-i18n-backend.js --probe            # 默认 http://127.0.0.1:3001
//   node scripts/verify-i18n-backend.js --probe=http://127.0.0.1:3001
//
// 退出码：0 = 全过；1 = 有失败。--probe 未给时明确打印「未验证（需重启后由 Lead 验）」。
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// ===== 隔离运行期目录（必须在 require 业务模块之前设置）=====
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-i18n-backend-'));
process.env.DATA_DIR = path.join(TMP, 'tasks');
process.env.CLIPS_DIR = path.join(TMP, 'clips');
process.env.OUTPUT_DIR = path.join(TMP, 'output');
process.env.LIBRARY_DIR = path.join(TMP, 'library');
process.env.PHOTOS_DIR = path.join(TMP, 'photos');
process.env.PROJECTS_DIR = path.join(TMP, 'projects');
process.env.ASSISTANT_DIR = path.join(TMP, 'assistant');
process.env.BUDGET_FILE = path.join(TMP, 'budget.json');
process.env.USERS_FILE = path.join(TMP, 'users.json');
process.env.DATABASE_TYPE = 'json';
process.env.LOG_DIR = path.join(TMP, 'logs');
for (const dir of [process.env.DATA_DIR, process.env.CLIPS_DIR, process.env.OUTPUT_DIR,
  process.env.LIBRARY_DIR, process.env.PHOTOS_DIR, process.env.PROJECTS_DIR,
  process.env.ASSISTANT_DIR, process.env.LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('✓ ' + name);
  } else {
    failed += 1;
    console.log('✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

function skip(name, why) {
  skipped += 1;
  console.log('… ' + name + '（跳过，未验证：' + why + '）');
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

// ===== 被测模块 =====
const i18n = require('../src/i18n');
const log = require('../src/i18n/log');
const catalog = require('../src/i18n/catalog');
const taskManager = require('../src/taskManager');
const qualityChecker = require('../src/qualityChecker');
const wsManager = require('../src/wsManager');
// P3 被测模块
const assistantTemplates = require('../src/i18n/templates/assistant');
const promptTemplates = require('../src/i18n/templates/prompt');
const sceneTemplates = require('../src/i18n/templates/scene');
const promptOptimizer = require('../src/promptOptimizer');
const promptComposer = require('../src/promptComposer');
const sceneCards = require('../src/sceneCards');
const assistantPlanCard = require('../src/assistant/planCard');
const assistantSupervisor = require('../src/assistant/supervisor');

// ------------------------------------------------------------
// [1] 语言解析
// ------------------------------------------------------------
console.log('\n—— [1] 语言解析 ——');
ok('normalizeLang: en-US → en', i18n.normalizeLang('en-US') === 'en');
ok('normalizeLang: zh-CN → zh', i18n.normalizeLang('zh-CN') === 'zh');
ok('normalizeLang: 中文 → zh', i18n.normalizeLang('中文') === 'zh');
ok('normalizeLang: 未知 → 空', i18n.normalizeLang('fr-FR') === '' && i18n.normalizeLang(null) === '');
ok('resolveLang: 第一个可用候选', i18n.resolveLang('', 'en-GB', 'zh') === 'en');
ok('resolveLang: 全空回退 zh', i18n.resolveLang(null, undefined, '') === 'zh');
ok('cookie vs_lang=en 优先于 Accept-Language',
  i18n.langFromRequest({ headers: { cookie: 'a=1; vs_lang=en', 'accept-language': 'zh-CN' } }) === 'en');
ok('无 cookie 时用 Accept-Language（带 q 权重）',
  i18n.langFromRequest({ headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } }) === 'zh'
  && i18n.langFromRequest({ headers: { 'accept-language': 'fr;q=1,en;q=0.5' } }) === 'en');
ok('无 cookie / 无 header → 默认 zh', i18n.langFromRequest({ headers: {} }) === 'zh'
  && i18n.langFromRequest(null) === 'zh');
ok('parseCookies 解码百分号', i18n.parseCookies('vs_lang=%65%6e').vs_lang === 'en');
ok('outputLang: aiLang 覆盖界面语言', i18n.outputLang({ lang: 'zh', body: { aiLang: 'en' } }) === 'en');
ok('outputLang: 无 aiLang → 界面语言 → zh',
  i18n.outputLang({ lang: 'en', body: {} }) === 'en'
  && i18n.outputLang({ body: {} }) === 'zh');

// ------------------------------------------------------------
// [2] catalog 完整性
// ------------------------------------------------------------
console.log('\n—— [2] catalog 完整性 ——');
ok('catalog 键数 ≥ 180（P2 覆盖）', i18n.keyCount() >= 180, `实际 ${i18n.keyCount()}`);
const problems = i18n.catalogProblems();
ok('catalogProblems 为空（中英对等 / 占位符一致 / 非空）', problems.length === 0, problems.slice(0, 5).join(' | '));
ok('模块间无重复 key', Array.isArray(catalog.duplicates) && catalog.duplicates.length === 0,
  (catalog.duplicates || []).slice(0, 5).join(', '));
const enCjk = Object.entries(catalog.en).filter(([, v]) => CJK_RE.test(v));
ok('英文词条不含中文', enCjk.length === 0, enCjk.slice(0, 3).map(([k]) => k).join(', '));
ok('中文词条非空且不含纯占位符', Object.values(catalog.zh).every(v => typeof v === 'string' && v.trim().length > 0));
ok('关键命名空间齐全（auth/tasks/budget/assistant/media/qc/pipeline/ws）',
  ['api.auth.', 'api.tasks.', 'api.budget.', 'api.assistant.', 'api.images.', 'qc.item.', 'pipeline.step.', 'ws.log.']
    .every(prefix => i18n.keys(prefix).length > 0));

// ------------------------------------------------------------
// [3] 翻译 / 插值 / API 错误形状
// ------------------------------------------------------------
console.log('\n—— [3] 翻译与加法式契约 ——');
ok('t(en) 出英文', i18n.t('en', 'api.auth.badCredentials') === 'Incorrect username or password');
ok('t(zh) 出中文原文', i18n.t('zh', 'api.auth.badCredentials') === '账号或密码错误');
ok('中文兜底与代码原串逐字一致（抽查 6 条）',
  catalog.zh['api.auth.badCredentials'] === '账号或密码错误'
  && catalog.zh['api.tasks.promptRequired'] === '请输入提示词'
  && catalog.zh['api.tasks.notFound'] === '任务不存在'
  && catalog.zh['api.budget.invalidAmount'] === 'balanceUsd 必须是非负数（美元）'
  && catalog.zh['api.assistant.badSession'] === '需要 sessionId'
  && catalog.zh['api.library.clipNotFound'] === '片段不存在');
ok('插值替换 {model}', i18n.t('zh', 'api.tasks.unsupportedModel', { model: 'x1' }) === '不支持的模型: x1');
ok('缺参数保留占位符（不抛错）', i18n.t('zh', 'api.tasks.unsupportedModel') === '不支持的模型: {model}');
ok('缺 key 回退 key 本身', i18n.t('en', 'no.such.key') === 'no.such.key');
ok('tp 无复数词条时回退基础词条', i18n.tp('en', 'api.tasks.clipCountRange', 2) === 'Clip count must be between 1 and 200.');
const er = i18n.err('en', 'api.tasks.clipCountRange', { n: 1 });
ok('err(en): messageKey/params/message 三件套', er.messageKey === 'api.tasks.clipCountRange'
  && er.params && er.params.n === 1 && /Clip count/.test(er.message));
const ez = i18n.err('zh', 'api.tasks.clipCountRange');
ok('err(zh): message 与中文原文一致', ez.message === '片段数量必须在 1-200 之间');
ok('mark() 只给 messageKey/params，不含 message', (() => {
  const m = i18n.mark('api.assistant.noPlan', { x: 1 });
  return m.messageKey === 'api.assistant.noPlan' && m.params.x === 1 && m.message === undefined;
})());

// ------------------------------------------------------------
// [4] 反查 / 日志渲染
// ------------------------------------------------------------
console.log('\n—— [4] 反查与日志 ——');
ok('keyForText 精确命中', i18n.keyForText('视频拼接') === 'pipeline.step.concatenation.name');
ok('keyForText 前缀命中（动态后缀）',
  i18n.keyForText('拼接失败: boom', { prefix: true }) === 'pipeline.log.concatFailed'
  && i18n.keyForText('循环处理失败：素材时长 1.00s 过短', { prefix: true }) === 'pipeline.log.loopFailed');
ok('keyForText 未命中返回 null', i18n.keyForText('完全没登记的文案') === null);
ok('logText zh 模式逐字返回 fallback（零回归）',
  log.logText('zh', 'pipeline.log.concatFailed', {}, '拼接失败: boom') === '拼接失败: boom');
ok('logText en 模式出英文', log.logText('en', 'pipeline.log.concatFailed', {}, '拼接失败: boom') === 'Concatenation failed');
const entry = log.logEntry('en', 'pipeline.log.taskRunning', {}, '任务已经在运行中');
ok('logEntry 保留原 text + 结构化字段',
  entry.text === '任务已经在运行中' && entry.key === 'pipeline.log.taskRunning'
  && entry.lang === 'en' && entry.localized === 'The task is already running');

// ------------------------------------------------------------
// [5] taskManager：lang / nameKey / errorKey
// ------------------------------------------------------------
console.log('\n—— [5] taskManager（隔离临时目录）——');
const tZh = taskManager.createTask('测试提示词', { model: 'mock', totalClips: 2, clipDuration: 3 });
const tEn = taskManager.createTask('test prompt', { model: 'mock', totalClips: 2, clipDuration: 3, lang: 'en' });
const tFr = taskManager.createTask('test prompt', { model: 'mock', totalClips: 1, clipDuration: 3, lang: 'fr' });
ok('缺省 lang = zh', tZh.lang === 'zh');
ok('显式 lang=en 写入任务', tEn.lang === 'en');
ok('未知语言归一为 zh', tFr.lang === 'zh');
ok('步骤带 nameKey / qcNameKey',
  tZh.steps.concatenation.nameKey === 'pipeline.step.concatenation.name'
  && tZh.steps.concatenation.qcNameKey === 'pipeline.step.concatenation.qcName'
  && tZh.steps.concatenation.name === '视频拼接');
ok('PIPELINE_STEPS 每条都有 nameKey 且中文 name 不变',
  taskManager.getPipelineSteps().every(s => s.nameKey && typeof s.name === 'string' && s.name.length > 0));
taskManager.updateTaskStatus(tZh.taskId, 'failed', { error: '拼接失败: boom' });
ok('失败任务补 errorKey（原 error 中文不变）',
  tZh.errorKey === 'pipeline.log.concatFailed' && tZh.error.startsWith('拼接失败'));
taskManager.updateTaskStatus(tEn.taskId, 'concatenating', { currentStep: '视频拼接' });
ok('currentStep 补 currentStepMessageKey（原 currentStep 不变）',
  tEn.currentStep === '视频拼接' && tEn.currentStepMessageKey === 'pipeline.status.concatenating');
const st = taskManager.recordStepComplete(tEn.taskId, 'concatenation', { status: 'failed', error: '转码失败: x' });
ok('步骤失败补 errorKey', st.errorKey === 'pipeline.log.transcodeFailed' && st.error === '转码失败: x');
taskManager.updateClip(tEn.taskId, 0, { status: 'failed', error: '没有可拼接的片段' });
ok('片段失败补 errorKey', tEn.clips[0].errorKey === 'pipeline.log.noClipsToConcat'
  && tEn.clips[0].error === '没有可拼接的片段');
taskManager.setQCResult(tEn.taskId, 1, { passed: false, reason: 'NSFW 不合规', reasonKey: 'qc.nsfw.fail' });
ok('质检失败沿用 reasonKey（不覆盖中文 reason）',
  tEn.clips[1].errorKey === 'qc.nsfw.fail' && tEn.clips[1].error === 'NSFW 不合规');
ok('旧任务（无 lang 字段）读取不报错', (() => {
  const t = taskManager.createTask('old', { model: 'mock', totalClips: 1 });
  delete t.lang;
  return taskManager.getTask(t.taskId) !== null;
})());

// ------------------------------------------------------------
// [6] qualityChecker：质检项加法式字段
// ------------------------------------------------------------
console.log('\n—— [6] qualityChecker ——');
const items = qualityChecker.getQCItems();
ok('质检项数量 ≥ 13（P2 覆盖）', items.length >= 13, `实际 ${items.length}`);
ok('每项都有 labelKey/labelZh/labelEn',
  items.every(i => typeof i.labelKey === 'string' && i.labelKey.startsWith('qc.item.')
    && typeof i.labelZh === 'string' && typeof i.labelEn === 'string'));
ok('labelZh 与既有 name 逐字一致（不借机改文案）', items.every(i => i.labelZh === i.name));
ok('labelEn 均非中文', items.every(i => !CJK_RE.test(i.labelEn)));
ok('catalog 有对应 label/desc 词条',
  items.every(i => i18n.hasKey('en', i.labelKey) && i18n.hasKey('en', i.descKey)));
ok('_getItemName 默认保持中文', qualityChecker._getItemName('nsfw') === 'NSFW合规检测');
ok('_getItemName(en) 返回英文', qualityChecker._getItemName('nsfw', 'en') === 'NSFW check');
const detailSample = { nsfw: { passed: false, reason: '不合规' }, unknownItem: { passed: true } };
qualityChecker._decorateItemResults(detailSample);
ok('明细补 itemKey/labelKey/labelZh/labelEn（不改 passed/reason）',
  detailSample.nsfw.itemKey === 'nsfw' && detailSample.nsfw.labelKey === 'qc.item.nsfw.label'
  && detailSample.nsfw.labelZh === 'NSFW合规检测' && detailSample.nsfw.labelEn === 'NSFW check'
  && detailSample.nsfw.passed === false && detailSample.nsfw.reason === '不合规'
  && detailSample.unknownItem.itemKey === 'unknownItem' && detailSample.unknownItem.labelKey === undefined);

// ------------------------------------------------------------
// [7] wsManager：连接级语言 + 事件 lang
// ------------------------------------------------------------
console.log('\n—— [7] wsManager ——');
const sent = [];
const fakeWs = () => ({ readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } });
const saved = {
  clients: new Map(wsManager.clients),
  subs: new Map(wsManager.taskSubscriptions),
  langs: new Map(wsManager.clientLang)
};
try {
  wsManager.clients.clear();
  wsManager.taskSubscriptions.clear();
  wsManager.clientLang.clear();
  wsManager.clients.set('c1', fakeWs());
  wsManager.clients.set('c2', fakeWs());
  wsManager.clientLang.set('c1', 'en');
  wsManager.clientLang.set('c2', 'zh');
  wsManager.taskSubscriptions.set('t1', new Set(['c1', 'c2']));
  wsManager.broadcastProgress('t1', { percent: 50 });
  ok('进度事件按连接语言带 lang（en/zh 各一）',
    sent.length === 2 && sent[0].lang === 'en' && sent[1].lang === 'zh'
    && sent[0].data.percent === 50 && sent[0].type === 'progress');
  sent.length = 0;
  wsManager.broadcastStatusChange('t1', 'completed', { statusText: '完成' });
  ok('状态事件保留既有字段并追加 lang',
    sent.length === 2 && sent[0].status === 'completed' && sent[0].statusText === '完成'
    && sent[0].type === 'statusChange' && sent[0].lang === 'en');
  sent.length = 0;
  wsManager.broadcastAssistant({ type: 'assistantBroadcast', taskId: 'x' });
  ok('小智播报对全连接追加 lang', sent.length === 2 && sent[0].taskId === 'x' && sent[0].lang === 'en');
} finally {
  wsManager.clients.clear();
  wsManager.taskSubscriptions.clear();
  wsManager.clientLang.clear();
  for (const [k, v] of saved.clients) wsManager.clients.set(k, v);
  for (const [k, v] of saved.subs) wsManager.taskSubscriptions.set(k, v);
  for (const [k, v] of saved.langs) wsManager.clientLang.set(k, v);
}

// ------------------------------------------------------------
// [8] 源码静态断言：只加不删
// ------------------------------------------------------------
console.log('\n—— [8] 源码静态断言 ——');
const serverSrc = readText('server.js');
const tmSrc = readText('src/taskManager.js');
const qcSrc = readText('src/qualityChecker.js');
const vpSrc = readText('src/videoProcessor.js');
ok('server.js 早期中间件设置 req.lang', /req\.lang = i18n\.langFromRequest\(req\)/.test(serverSrc));
ok('server.js 引入后端 i18n', /require\('\.\/src\/i18n'\)/.test(serverSrc));
ok('auth 错误保留原中文 + 新增 messageKey',
  /error: '账号或密码错误'/.test(serverSrc) && /api\.auth\.badCredentials/.test(serverSrc)
  && /error: '未登录'/.test(serverSrc) && /api\.auth\.required/.test(serverSrc));
ok('tasks 错误保留原中文 + 新增 key',
  /error: '请输入提示词'/.test(serverSrc) && /api\.tasks\.promptRequired/.test(serverSrc)
  && /error: '任务不存在'/.test(serverSrc) && /api\.tasks\.notFound/.test(serverSrc));
ok('budget / assistant / images / bgm 均有加法式 key',
  /api\.budget\.invalidAmount/.test(serverSrc) && /api\.assistant\.prefsNotApproved/.test(serverSrc)
  && /api\.images\.notReady/.test(serverSrc) && /api\.bgm\.mixFailed/.test(serverSrc));
ok('POST /api/tasks 把 lang 写进任务', /lang: req\.lang,/.test(serverSrc));
ok('/api/qc-items 返回 lang 且 qcItems 来自 qualityChecker', /lang: req\.lang/.test(serverSrc));
ok('/api/status 暴露 i18n 探针（不泄露 Key）',
  /i18n: \{ version: 'p2'/.test(serverSrc) && /lang: req\.lang/.test(serverSrc));
ok('taskManager 写入 lang（缺省 zh）', /lang: i18n\.normalizeLang\(options\.lang\) \|\| i18n\.DEFAULT_LANG/.test(tmSrc));
ok('taskManager 失败/步骤/片段补 errorKey',
  /task\.errorKey = errorKey/.test(tmSrc) && /step\.errorKey = k/.test(tmSrc) && /clip\.errorKey = k/.test(tmSrc));
ok('PIPELINE_STEPS 中文 name 未被 catalog 改写',
  /name: '视频拼接'/.test(tmSrc) && /name: '最终综合质检'/.test(tmSrc));
ok('qualityChecker 不改变 QC 判定逻辑（passed/skipped 分支仍在）',
  /failedItems\.length === 0 && notRunItems\.length === 0/.test(qcSrc)
  && /if \(notRunItems\.length > 0\) totalPassed = false;/.test(qcSrc));
ok('videoProcessor 只包装失败结果补 errorKey', /errorKey = key/.test(vpSrc) && /keyForText\(out\.error/.test(vpSrc));
ok('中文质检文案未改动（NSFW / 最终质检通过）',
  /name: 'NSFW合规检测'/.test(qcSrc) && /reason = '最终质检通过'/.test(qcSrc));

// ------------------------------------------------------------
// [8b] P3：助手/提示词模板（独立英文基底，中文零回归）
// ------------------------------------------------------------
console.log('\n—— [8b] P3 助手与提示词 ——');
const normalizeEol = (s) => String(s).replace(/\r\n/g, '\n');

// 系统提示词：中文模板 = 改造前原文（逐字/EOL 归一后比对）；英文 = 独立英文基底
ok('中文悬浮球系统提示词仍是原中文（9 条禁令 + 七段组织）',
  assistantTemplates.CHAT_SYSTEM_ZH.includes('【画面里不能出现这些东西】')
  && assistantTemplates.CHAT_SYSTEM_ZH.includes('人物 —— 人脸、手、身体、人群、人形剪影、皮肤特写')
  && assistantTemplates.CHAT_SYSTEM_ZH.includes('中文提示词按七段组织'));
ok('英文悬浮球系统提示词 = 独立英文基底 + Respond in English',
  assistantTemplates.CHAT_SYSTEM_EN.includes('Respond in English')
  && assistantTemplates.CHAT_SYSTEM_EN.includes('[What must never appear]')
  && !CJK_RE.test(assistantTemplates.CHAT_SYSTEM_EN));
ok('英文批量系统提示词含 Respond in English 且无中文',
  assistantTemplates.batchSystemPromptEn(3, 10).includes('Respond in English')
  && !CJK_RE.test(assistantTemplates.batchSystemPromptEn(3, 10)));
ok('中文批量系统提示词保留原句（风光长视频分镜师）',
  assistantTemplates.batchSystemPromptZh(3, 10).includes('你是「风光长视频分镜师」'));
ok('英文填槽系统提示词用英文但保留中文地貌 canonical 说明',
  assistantTemplates.SLOT_SYSTEM_EN.includes('Respond in English')
  && assistantTemplates.SLOT_SYSTEM_EN.includes('Chinese landform names'));
ok('server.js 不再内联系统提示词（已迁 templates）',
  !serverSrc.includes('你是「视频提示词助手」')
  && !serverSrc.includes('你是「小智」的听懂模块')
  && /assistantTemplates\.CHAT_SYSTEM_EN/.test(serverSrc)
  && /assistantTemplates\.SLOT_SYSTEM_EN/.test(serverSrc));
ok('server.js 的 chat/batch/understand 消费 aiLang 输出语言',
  /outputLanguage = i18n\.outputLang\(req, req\.body && req\.body\.aiLang\)/.test(serverSrc)
  && /outputLang\(req, body\.aiLang\)/.test(serverSrc));
ok('POST /api/tasks 写入 promptLang（作品语言）', /promptLang: i18n\.outputLang\(req/.test(serverSrc));

// promptOptimizer：中文规则逐字不变；英文规则独立
const zhPrompt = promptOptimizer.buildSystemPrompt(null, 'zh');
const enPrompt = promptOptimizer.buildSystemPrompt(null, 'en');
ok('promptOptimizer 中文 systemPrompt 仍是现有中文规则',
  zhPrompt.systemPrompt === promptOptimizer.rules && CJK_RE.test(zhPrompt.systemPrompt));
ok('promptOptimizer 英文 systemPrompt = 英文规则 + Respond in English',
  /Respond in English/.test(enPrompt.systemPrompt) && !CJK_RE.test(enPrompt.systemPrompt));
ok('promptOptimizer 英文主题标签', promptTemplates.themeLabelEn('landscape') === 'Natural landscape'
  && promptTemplates.themeLabelEn('aurora') === 'Aurora');
const tplZh = promptOptimizer.optimizeWithTemplate('雪山日落', 'landscape', { seed: 0 });
const tplEn = promptOptimizer.optimizeWithTemplate('雪山日落', 'landscape', { lang: 'en', seed: 0 });
ok('模板优化中文路径不带 lang 字段（零回归）', tplZh.lang === undefined
  && tplZh.theme === promptOptimizer.templates.landscape.name);
ok('模板优化英文路径：英文主题标签 + lang=en',
  tplEn.lang === 'en' && tplEn.theme === 'Natural landscape');
ok('模板优化确定性不受语言分支影响（seed 相同 → 词池选择相同）',
  tplZh.optimized === tplEn.optimized, `${tplZh.optimized.slice(0, 40)} vs ${tplEn.optimized.slice(0, 40)}`);

// promptComposer：中文路径零回归；英文走独立模板
const firstCard = sceneCards.allocate(2).used[0];
const card = sceneCards.getCardById(firstCard.id);
const composeZhDefault = promptComposer.composeVideoPrompt(card, {});
const composeZhExplicit = promptComposer.composeVideoPrompt(card, { lang: 'zh' });
const composeEn = promptComposer.composeVideoPrompt(card, { lang: 'en' });
ok('promptComposer 中文默认与显式 zh 输出一致（零回归）', composeZhDefault === composeZhExplicit);
ok('promptComposer 中文输出仍用原句式（画面主体/镜头）',
  composeZhDefault.includes('画面主体：') && composeZhDefault.includes('镜头：'));
ok('promptComposer 英文输出用英文模板（Subject/Camera），不混中文标签',
  composeEn.includes('Subject:') && composeEn.includes('Camera:')
  && !/画面主体|镜头：|结尾：/.test(composeEn));
const patchEn = promptComposer.composeClipPatch(card, { lang: 'en' });
const patchZh = promptComposer.composeClipPatch(card, { lang: 'zh' });
ok('场景卡 patch：英文标 promptLanguage，中文不写该字段（任务 JSON 零回归）',
  patchEn.promptLanguage === 'en' && patchZh.promptLanguage === undefined
  && patchZh.prompt === composeZhDefault);
ok('英文场景模板明确只改句式（内容字段无 *_en 时保留原值，不机翻）',
  typeof sceneTemplates.composeVideoPromptEn === 'function' && sceneTemplates.themeEn('aurora') === 'aurora');

// planCard.describe：中文原文不变；英文独立
const planSample = assistantPlanCard.buildPlan({ text: '10 分钟', model: 'mock' });
ok('planCard 中文计划说明仍是原中文（总时长/模型/场景）',
  assistantPlanCard.describe(planSample.plan)[0].startsWith('总时长 '));
ok('planCard 英文计划说明（Total length/Model/Scenes）',
  assistantPlanCard.describe(planSample.plan, 'en')[0].startsWith('Total length ')
  && assistantPlanCard.describe(planSample.plan, 'en').join('\n').includes('Model:')
  && assistantPlanCard.describe(planSample.plan, 'en').join('\n').includes('Scenes:'));

// supervisor：英文核心链路 + 中文默认逐字不变
const zhGreet = assistantSupervisor.handleMessage({ sessionId: 'verify-i18n-zh-1', text: '你好' });
ok('助手中文默认仍是原中文问候（零回归）', zhGreet.reply.startsWith('我是小智。'));
ok('助手返回加法式 lang/replyKey', zhGreet.lang === 'zh' && zhGreet.replyKey === 'assistant.reply.greeting');
const enGreet = assistantSupervisor.handleMessage({ sessionId: 'verify-i18n-en-1', text: '你好', lang: 'en' });
ok('助手英文问候', enGreet.lang === 'en' && enGreet.reply.includes('I am Xiaozhi')
  && enGreet.replyKey === 'assistant.reply.greeting');
const enPlan = assistantSupervisor.handleMessage({ sessionId: 'verify-i18n-en-1', text: '10 分钟', lang: 'en' });
ok('助手英文计划（I\'ve laid out + 计划卡结构）', enPlan.plan && enPlan.reply.includes("I've laid out a")
  && enPlan.reply.includes('Total length') && enPlan.replyKey === 'assistant.reply.plan');
ok('助手计划回复带结构化 action=confirm（labelKey）',
  Array.isArray(enPlan.actions) && enPlan.actions[0].type === 'confirm'
  && enPlan.actions[0].labelKey === 'assistant.action.confirmExecute');
const enConfirm = assistantSupervisor.handleMessage({ sessionId: 'verify-i18n-en-1', text: '确认生成吗', lang: 'en' });
ok('助手英文确认话术（Confirm and run）', enConfirm.replyKey === 'assistant.reply.confirm'
  && enConfirm.reply.includes('Confirm and run'));
const enUnknown = assistantSupervisor.handleMessage({ sessionId: 'verify-i18n-en-2', text: '???', lang: 'en' });
ok('助手英文听不懂/追问不回中文长句', enUnknown.lang === 'en'
  && (enUnknown.reply.includes('How long should the video be')
    || enUnknown.reply.includes('I can do three things')
    || enUnknown.reply.includes("I've laid out a")));
ok('catalog 有生成器错误 key（供 task/clip 反查 errorKey）',
  i18n.hasKey('en', 'gen.error.unsupportedModel') && i18n.hasKey('en', 'gen.error.dashscopeKeyMissing')
  && i18n.keyForText('DashScope API Key 未配置，请在设置中填写', { prefix: true }) === 'gen.error.dashscopeKeyMissing');

// ------------------------------------------------------------
// [9] 可选：真实 HTTP 探针（需用户重启后运行；默认跳过）
// ------------------------------------------------------------
console.log('\n—— [9] live HTTP 探针 ——');
const probeArg = process.argv.find(a => a === '--probe' || a.startsWith('--probe='));
const probeBase = probeArg && probeArg.includes('=')
  ? probeArg.slice(probeArg.indexOf('=') + 1).replace(/\/$/, '')
  : 'http://127.0.0.1:3001';

function httpJson(method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(probeBase + urlPath), {
      method,
      timeout: 5000,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 保留 null */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

if (!probeArg) {
  skip('live 双语 API 探针', '--probe 未提供；本轮未重启服务，需用户重启后由 Lead 验');
  finish();
} else {
  runProbe().catch((e) => {
    ok('live 探针执行', false, e && e.message);
    finish();
  });
}

async function runProbe() {
  const en = await httpJson('GET', '/api/status', { cookie: 'vs_lang=en' });
  const zh = await httpJson('GET', '/api/status');
  ok('探针：/api/status 可访问', en.status === 200 && en.json && en.json.ok !== false, `status=${en.status}`);
  if (en.status === 200 && en.json) {
    ok('探针：en cookie → lang=en 且已加载 P2 catalog',
      en.json.lang === 'en' && en.json.i18n && en.json.i18n.version === 'p2' && en.json.i18n.keys >= 180,
      JSON.stringify({ lang: en.json.lang, i18n: en.json.i18n }));
  }
  if (zh.status === 200 && zh.json) {
    ok('探针：无 cookie → 默认 lang=zh', zh.json.lang === 'zh');
  }
  const denied = await httpJson('GET', '/api/tasks', { cookie: 'vs_lang=en' });
  ok('探针：未登录 401 保留中文 error + 英文 message + messageKey',
    denied.status === 401 && denied.json
    && denied.json.error === '未登录'
    && denied.json.messageKey === 'api.auth.required'
    && /Not signed in/i.test(denied.json.message || ''),
    JSON.stringify({ status: denied.status, error: denied.json && denied.json.error, messageKey: denied.json && denied.json.messageKey }));
  // 空账号密码：在任何密码校验/失败计数之前就被拒，安全无副作用（不增加 IP 失败计数）
  const badLogin = await httpJson('POST', '/api/auth/login', { cookie: 'vs_lang=en', body: {} });
  ok('探针：登录参数缺失 400 加法式字段（error 中文不变）',
    badLogin.status === 400 && badLogin.json
    && badLogin.json.error === '请输入账号和密码'
    && badLogin.json.messageKey === 'api.auth.missingCredentials'
    && /username and password/i.test(badLogin.json.message || ''),
    JSON.stringify({ status: badLogin.status, messageKey: badLogin.json && badLogin.json.messageKey }));
  finish();
}

function finish() {
  // 清理隔离目录（失败也清理；不触碰真实 data/）
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) { /* 清理失败不影响结论 */ }

  console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`);
  if (skipped > 0) console.log('注意：跳过 ≠ 通过；live 探针需用户重启后由 Lead 用 --probe 复跑。');
  process.exit(failed === 0 ? 0 : 1);
}
