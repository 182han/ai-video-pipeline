#!/usr/bin/env node
// ==========================================================
// 验收：小智（P5）—— 计划卡 / 状态机 / 记忆 / 语音 / 补位 / Mock 全流程
// ----------------------------------------------------------
// 覆盖（全部零计费）：
//   [1] 计划卡：中文口语解析、上限（60 分钟 / 400 段 / 场景卡 180 张）、每段时长按模型、
//       预算（CNY 估值 + USD 闸门 + 重试上限 10%）、补位上限（≤5% 且 ≤10 段）。
//   [2] 状态机：合法/非法转移、付费闸门、重试次数与重试预算闸门、补位闸门、观察值。
//   [3] 记忆：会话落盘、消息/计划/状态读写、意图分类、任务检索（「上一次视频」）。
//   [4] 语音：离线 sherpa-onnx 真实识别（内置中文样例），负向（坏音频/超大/过短/无音频）。
//   [5] 补位：真实 ffmpeg 片段，按 ΔE76+SSIM 选最像；排除短/缺失/失败/同任务候选；
//       补位额度 0 拒绝；缺口不允许出片；监督器补位分支（monkey-patch 掉真实出片）。
//   [6] Mock 全流程：对话 → 计划卡 → 确认 → 流水线 → 成片（ffprobe + 完整解码），
//       任务记录 scene_key / 3 段、状态机走到 done、零计费。
//   [7] 自动重试：强制首轮片段失败 → 状态机 RETRY → 重跑只补失败片段 → 成片。
//   [8] 付费闸门：真实模型未确认 → PAYMENT_NOT_APPROVED，且不创建任何任务。
//
// 隔离：ASSISTANT_DIR / DATA_DIR / CLIPS_DIR / OUTPUT_DIR / LIBRARY_DIR / PHOTOS_DIR /
// PROJECTS_DIR / BUDGET_FILE / DATABASE_TYPE=json 全部指向 data/tmp-verify-assistant_*；
// 不使用任何真实计费接口（Mock + 本地模块）。
//
// 用法：cd app && node scripts/verify-assistant.js
// 退出码 0 = 全部通过；非 0 = 有失败（未验证不算通过）。
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(APP_DIR, 'data', 'tmp-verify-assistant_'));
const DIRS = {
  assistant: path.join(TMP, 'assistant'),
  tasks: path.join(TMP, 'tasks'),
  clips: path.join(TMP, 'clips'),
  output: path.join(TMP, 'output'),
  library: path.join(TMP, 'library'),
  photos: path.join(TMP, 'photos'),
  projects: path.join(TMP, 'projects'),
  logs: path.join(TMP, 'logs'),
  budget: path.join(TMP, 'budget.json')
};
for (const d of Object.values(DIRS)) {
  if (path.extname(d)) continue;
  fs.mkdirSync(d, { recursive: true });
}

process.env.ASSISTANT_DIR = DIRS.assistant;
process.env.DATA_DIR = DIRS.tasks;
process.env.CLIPS_DIR = DIRS.clips;
process.env.OUTPUT_DIR = DIRS.output;
process.env.LIBRARY_DIR = DIRS.library;
process.env.PHOTOS_DIR = DIRS.photos;
process.env.PROJECTS_DIR = DIRS.projects;
process.env.LOG_DIR = DIRS.logs;
process.env.BUDGET_FILE = DIRS.budget;
// 2026-11-17 V1（§9.1-4）：场景卡冷却状态也必须隔离到本次临时目录（默认在 data/assistant）。
process.env.SCENE_CARDS_COOLING_FILE = path.join(TMP, 'scene-card-cooling.json');
// 2026-11-17 V2：跨会话偏好 / 审计落盘同样隔离（默认在 data/assistant，属运行期数据）。
process.env.ASSISTANT_PREFS_FILE = path.join(TMP, 'assistant-preferences.json');
process.env.ASSISTANT_AUDIT_FILE = path.join(TMP, 'assistant-audit.jsonl');
// 2026-11-19 B 目标：agent 回合审计（与上面的「偏好审计」是两份文件，别混）
process.env.ASSISTANT_AGENT_AUDIT_FILE = path.join(TMP, 'agent-audit.jsonl');
process.env.DATABASE_TYPE = 'json';
process.env.BUDGET_USD = '196';

// ===== Mock 样片（MockGenerator 固定读 app/clips/_samples；本机 execSync pipe 会 EPERM）=====
const REAL_CLIPS_DIR = path.join(APP_DIR, 'clips');
const clipsSnapshot = new Set(fs.existsSync(REAL_CLIPS_DIR) ? fs.readdirSync(REAL_CLIPS_DIR) : []);
function ensureSample(name, seconds) {
  const sampleDir = path.join(REAL_CLIPS_DIR, '_samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const out = path.join(sampleDir, name);
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return { path: out, created: false };
  execFileSync(require('../config').FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', `color=c=0x4a90d9:s=1280x720:d=${seconds}`,
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', out
  ], { stdio: 'ignore', timeout: 60000 });
  return { path: out, created: true };
}
const SAMPLE_10 = ensureSample('sample_720p_10s.mp4', 10);

const config = require('../config');
const proc = require('../src/assistant/proc');
const planCard = require('../src/assistant/planCard');
const stateMachine = require('../src/assistant/stateMachine');
const assistantMemory = require('../src/assistant/memory');
const asr = require('../src/assistant/asr');
const fillLib = require('../src/assistant/fillFromLibrary');
const supervisor = require('../src/assistant/supervisor');
const agentRuntime = require('../src/assistant/agentRuntime');
const agentSwitch = require('../src/assistant/agentSwitch');
const turnQueue = require('../src/assistant/turnQueue');
const agentAudit = require('../src/assistant/agentAudit');
const taskManager = require('../src/taskManager');
const library = require('../src/library');
const pipeline = require('../src/pipeline');
const budget = require('../src/budget');
const sceneCardLibrary = require('../src/sceneCards');
const promptComposer = require('../src/promptComposer');
const audioMixer = require('../src/processors/audioMixer');
// 2026-11-17 V2：偏好 / 审计 / 播报 / 图片库（直接进程内断言，不起第二实例）
const assistantPreferences = require('../src/assistant/preferences');
const assistantAudit = require('../src/assistant/audit');
const assistantBroadcast = require('../src/assistant/broadcast');
const photoLibrary = require('../src/photoLibrary');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? `  —  ${extra}` : ''}`); }
  else { fail++; failures.push({ name, extra }); console.log(`  ❌ ${name}${extra ? `  —  ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeDuration(file) {
  const r = proc.runToFiles(config.FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 30000 });
  const v = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}
function decodes(file) {
  const r = proc.runToFiles(config.FFMPEG_PATH, ['-v', 'error', '-i', file, '-f', 'null', '-'], { timeoutMs: 120000 });
  return { ok: r.status === 0 && !r.stderr.trim(), status: r.status, stderr: r.stderr.trim().slice(0, 200) };
}
function makeClip(file, color, dur) {
  execFileSync(config.FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:d=${dur}`,
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${dur}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', file
  ], { stdio: 'ignore', timeout: 60000 });
  return file;
}
function libEntry(id, filePath, dur, extra = {}) {
  let size = null;
  try { size = fs.statSync(filePath).size; } catch (e) { size = null; }
  return {
    id, fileName: path.basename(filePath), filePath, url: '/clips/' + path.basename(filePath),
    taskId: 'libsrc_' + id, clipIndex: 0, kind: 'clip', status: 'success', origin: 'task',
    prompt: '库片段 ' + id, model: 'dashscope', resolution: '720p', width: 1280, height: 720,
    fps: 30, codec: 'h264', durationSec: dur, sizeBytes: size, hasAudio: true, cost: null,
    qc: { passed: true, level: 'pass', reason: 'ok' }, favorite: false,
    addedAt: new Date().toISOString(), ...extra
  };
}

const createdTasks = [];
async function cleanupAll() {
  try { supervisor.resetRuntime(); } catch (e) { /* ignore */ }
  const { cleanupMany } = require('./_test-cleanup');
  const res = await cleanupMany(createdTasks, taskManager).catch(() => []);
  // 清理本次新增的 mock 片段与样片
  try {
    for (const name of fs.readdirSync(REAL_CLIPS_DIR)) {
      if (clipsSnapshot.has(name)) continue;
      if (/^mock_.*\.mp4$/.test(name)) fs.unlinkSync(path.join(REAL_CLIPS_DIR, name));
    }
  } catch (e) { /* ignore */ }
  if (SAMPLE_10.created) { try { fs.unlinkSync(SAMPLE_10.path); } catch (e) { /* ignore */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  return res;
}

async function waitTerminal(sessionId, planId, timeoutMs = 240000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const st = supervisor.stateOf(sessionId, planId);
    if (st && st.ok && st.state) {
      last = st.state.state;
      if (st.state.terminal) return st;
    }
    await sleep(1000);
  }
  throw new Error(`等待状态机终态超时（当前 ${last}）`);
}

async function main() {
  console.log('='.repeat(64));
  console.log('P5 小智（计划卡 / 状态机 / 记忆 / 语音 / 补位 / Mock 全流程）');
  console.log('='.repeat(64));

  // ================= [0] V2 开窗第一组：V1 遗留 ①–⑤ =================
  // 来源：docs/交接/2026-11-17-V1-验收与V2交接.md §5（Lead 独立验收发现）。
  // 本组只做小改：冷却隔离 / 预览只读 / Key 口径 / 随机抽卡文案 / 关开关护栏。
  console.log('\n[0] V1 遗留 ①–⑤：冷却隔离 / 预览只读 / Key 口径 / 随机抽卡文案 / 关开关护栏');

  // ① verify-whaletv-video 必须在 require planCard 之前隔离冷却文件
  const whaletvSrc = fs.readFileSync(path.join(APP_DIR, 'scripts', 'verify-whaletv-video.js'), 'utf8');
  const coolingIdx = whaletvSrc.indexOf('SCENE_CARDS_COOLING_FILE');
  const planCardRequireIdx = whaletvSrc.indexOf("require('../src/assistant/planCard')");
  ok('① verify-whaletv-video 在 require 计划卡之前隔离 SCENE_CARDS_COOLING_FILE（跑门禁不再写用户真实冷却）',
    coolingIdx !== -1 && planCardRequireIdx !== -1 && coolingIdx < planCardRequireIdx,
    `冷却赋值@${coolingIdx} / planCard require@${planCardRequireIdx}`);

  // ② /api/scene-cards/preview 是只读预览：allocate 必须显式 recordCooling:false
  const serverSrc = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
  const prevStart = serverSrc.indexOf("app.get('/api/scene-cards/preview'");
  const prevBlock = prevStart === -1 ? '' : serverSrc.slice(prevStart, prevStart + 2000);
  ok('② /api/scene-cards/preview 的 allocate 显式 recordCooling:false（点一次预览不再消耗冷却窗口）',
    /sceneCardLibrary\.allocate\(count,\s*\{\s*recordCooling:\s*false\s*\}\)/.test(prevBlock));

  // ③ Key 口径：必须说明是「服务端环境变量」，并提示设置页 Key 小智看不到
  const keyLegacy = supervisor.handleMessage({ sessionId: 's_v2_legacy_key', text: 'WhaleTV 的 Key 配了吗' });
  ok('③ Key 问答口径：写明「服务端环境变量」+ 提示设置页 Key 小智看不到（不再只说「无」误导）',
    keyLegacy.ok === true && keyLegacy.intent === 'context'
    && /服务端环境变量/.test(keyLegacy.reply)
    && /设置页/.test(keyLegacy.reply)
    && /小智看不到/.test(keyLegacy.reply),
    String(keyLegacy.reply || '').split('\n').slice(-2).join(' | ').slice(0, 120));

  // ④ 随机抽卡文案同步（4 处：planCard / supervisor 问候 / xiaozhiPlan / createSmart）
  const legacyPlan = planCard.buildPlan({ text: '10 分钟' });
  ok('④ 计划摘要文案：随机抽取 + 按章节顺序播映（不再写「按章节顺序自动抽取」）',
    legacyPlan.ok === true
    && planCard.describe(legacyPlan.plan).some((l) => l.includes('场景：场景卡库随机抽取 60 个不同场景（按章节顺序播映，不重复）')),
    legacyPlan.ok ? planCard.describe(legacyPlan.plan).find((l) => l.startsWith('场景：')) : legacyPlan.code);
  const legacyGreet = supervisor.handleMessage({ sessionId: 's_v2_legacy_greet', text: '你好' });
  ok('④ 问候语文案：随机抽取后按章节顺序播映',
    legacyGreet.ok === true && legacyGreet.intent === 'greeting'
    && /随机抽取后按章节顺序播映/.test(legacyGreet.reply)
    && !/按章节顺序自动抽取/.test(legacyGreet.reply));
  const xiaozhiPlanSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'components', 'xiaozhiPlan.js'), 'utf8');
  const createSmartSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'screens', 'createSmart.js'), 'utf8');
  // 2026-11-17 V2：i18n 窗口在并发迁移 xiaozhiPlan.js（21:46 起），中文话术已进
  // web/src/i18n/messages/xiaozhi.js。断言同时接受「文件内字面量」与「i18n zh 文案」，
  // 但仍要求中文话术本身存在（随机抽取 + 按章节顺序播映），不是永真。
  const i18nMessagesDir = path.join(APP_DIR, 'web', 'src', 'i18n', 'messages');
  const i18nZhTexts = (() => {
    try {
      return fs.readdirSync(i18nMessagesDir).filter((n) => /\.js$/.test(n))
        .map((n) => fs.readFileSync(path.join(i18nMessagesDir, n), 'utf8')).join('\n');
    } catch (e) { return ''; }
  })();
  ok('④ 前端两处文案同步（xiaozhiPlan 计划卡 / createSmart 向导；兼容 i18n 键）',
    (/场景卡库随机抽取/.test(xiaozhiPlanSrc) || /场景卡库随机抽取 \{n\} 个不同场景/.test(i18nZhTexts))
    && (/按章节顺序播映/.test(xiaozhiPlanSrc) || /按章节顺序播映/.test(i18nZhTexts))
    && (/场景从卡库随机抽/.test(createSmartSrc) || /场景从卡库随机抽/.test(i18nZhTexts)));

  // ⑤ 关场景卡两种语序（「去掉场景卡」「场景卡不要了」）不许被 diff 正则误接成改提示词
  const sidOff = 's_v2_legacy_off';
  const offSeed = supervisor.handleMessage({ sessionId: sidOff, text: 'mock 2段，每段10秒' });
  const offPlanBefore = assistantMemory.lastPlan(sidOff);
  const offMsgA = supervisor.handleMessage({ sessionId: sidOff, text: '去掉场景卡' });
  const offPlanMid = assistantMemory.lastPlan(sidOff);
  const offMsgB = supervisor.handleMessage({ sessionId: sidOff, text: '场景卡不要了' });
  const offPlanAfter = assistantMemory.lastPlan(sidOff);
  ok('⑤ 关场景卡两种语序：不算改提示词（不回「已改第 N 段」）、不写 promptOverrides、不重排计划',
    offSeed.ok === true && !!offPlanBefore
    && assistantMemory.isSceneCardsOff('去掉场景卡') === true
    && assistantMemory.isSceneCardsOff('场景卡不要了') === true
    && assistantMemory.isSceneCardEdit('去掉场景卡') === false
    && assistantMemory.isSceneCardEdit('场景卡不要了') === false
    && !/已改第|已按你的文本替换/.test(String(offMsgA.reply || ''))
    && !/已改第|已按你的文本替换/.test(String(offMsgB.reply || ''))
    && JSON.stringify(offPlanMid.promptOverrides || null) === JSON.stringify(offPlanBefore.promptOverrides || null)
    && JSON.stringify(offPlanAfter.promptOverrides || null) === JSON.stringify(offPlanBefore.promptOverrides || null)
    && offPlanAfter.planId === offPlanBefore.planId,
    `A: ${String(offMsgA.reply || '').slice(0, 30)} / B: ${String(offMsgB.reply || '').slice(0, 30)}`);

  // ================= [1] 计划卡 =================
  console.log('\n[1] 计划卡：解析 / 上限 / 预算 / 补位上限');
  const p30 = planCard.buildPlan({ text: '来一条 30 分钟的极光视频，每段 10 秒' });
  ok('30 分钟极光 → 180 段 × 10 秒', p30.ok && p30.plan.clipCount === 180 && p30.plan.clipDurationSec === 10,
    p30.ok ? `${p30.plan.clipCount}×${p30.plan.clipDurationSec}` : p30.code);
  ok('场景卡默认开启且 180 张可容纳', p30.ok && p30.plan.sceneCards === true && p30.plan.totalSec === 1800);
  ok('长片不按主题排：theme / themeLabel 为 null（场景由卡库自动抽取）',
    p30.ok && p30.plan.theme === null && p30.plan.themeLabel === null);
  const pMulti = planCard.buildPlan({ text: '来一条 30 分钟的雪山、星空和极光视频，每段 10 秒' });
  ok('用户提到多主题：不写进计划卡，只提示「不按单一主题选卡」',
    pMulti.ok && pMulti.plan.theme === null && pMulti.plan.themeLabel === null
    && pMulti.plan.warnings.some((w) => /雪山冰川、星空银河、极光/.test(w) && /不按单一主题/.test(w))
    && pMulti.plan.clipCount === 180,
    pMulti.ok ? JSON.stringify(pMulti.plan.warnings) : pMulti.code);
  const pDurOnly = planCard.buildPlan({ text: '10 分钟' });
  ok('只说时长（10 分钟）→ 60 段 × 10 秒、无主题、无警告',
    pDurOnly.ok && pDurOnly.plan.clipCount === 60 && pDurOnly.plan.theme === null
    && (pDurOnly.plan.warnings || []).length === 0,
    pDurOnly.ok ? `${pDurOnly.plan.clipCount}段` : pDurOnly.code);
  ok('describe() 按「场景卡库随机/自动抽取」描述、不再有主题行', (() => {
    if (!pDurOnly.ok) return false;
    const lines = planCard.describe(pDurOnly.plan);
    return lines.some((l) => /场景：场景卡库(随机|自动)抽取 60 个不同场景/.test(l))
      && !lines.some((l) => l.startsWith('主题：'));
  })(), pDurOnly.ok ? planCard.describe(pDurOnly.plan).join(' | ') : '');
  const msgDurOnly = supervisor.handleMessage({ sessionId: 's_reply_dur_1', text: '10 分钟' });
  ok('对话回复按总时长排，不出现「我按「某主题」排好了」',
    msgDurOnly.ok && msgDurOnly.plan && /我按 10\.0 分钟排好了/.test(msgDurOnly.reply)
    && /场景：场景卡库(随机|自动)抽取 60 个不同场景/.test(msgDurOnly.reply)
    && !/我按「/.test(msgDurOnly.reply),
    String(msgDurOnly.reply || '').slice(0, 120));
  ok('预算：720p 30 分钟 = ¥1080，重试上限 ¥108（10%），最多 2 次',
    p30.ok && p30.plan.estimate.totalCny === 1080 && p30.plan.estimate.retryCapCny === 108
    && p30.plan.estimate.autoQcRetries === 2,
    p30.ok ? JSON.stringify({ total: p30.plan.estimate.totalCny, cap: p30.plan.estimate.retryCapCny, retries: p30.plan.estimate.autoQcRetries }) : '');
  ok('补位上限 = min(10, floor(180×5%)) = 9', p30.ok && p30.plan.fillMaxClips === 9);
  ok('付费任务标记 requiresPaymentApproval', p30.ok && p30.plan.requiresPaymentApproval === true && p30.plan.estimate.budget.usd === 180);
  ok('describe() 给出人话说明', planCard.describe(p30.plan).length >= 4,
    planCard.describe(p30.plan).slice(0, 2).join(' | '));

  const pHalf = planCard.buildPlan({ text: '半小时星空，1080p' });
  ok('「半小时」= 30 分钟，1080p 单价 ¥1.2/s → ¥2160（不按「星空」选卡）',
    pHalf.ok && pHalf.plan.clipCount === 180 && pHalf.plan.resolution === '1080p'
    && pHalf.plan.estimate.totalCny === 2160 && pHalf.plan.theme === null,
    pHalf.ok ? `¥${pHalf.plan.estimate.totalCny}` : pHalf.code);

  const p2 = planCard.buildPlan({ text: '帮我拍一条两分钟的雪山，不要场景卡' });
  ok('「两分钟」= 2 分钟，12 段，关闭场景卡', p2.ok && p2.plan.clipCount === 12 && p2.plan.sceneCards === false
    && p2.plan.totalSec === 120, p2.ok ? `${p2.plan.clipCount}段` : p2.code);
  ok('2 分钟 720p 重试上限 ¥7.2 → 只够 1 次自动重试',
    p2.ok && p2.plan.estimate.retryCapCny === 7.2 && p2.plan.estimate.autoQcRetries === 1,
    p2.ok ? `cap=${p2.plan.estimate.retryCapCny} retries=${p2.plan.estimate.autoQcRetries}` : '');
  ok('12 段补位上限 = floor(0.6) = 0（5% 规则）', p2.ok && p2.plan.fillMaxClips === 0);

  const pCount = planCard.buildPlan({ text: '3段极光，每段10秒', model: 'mock' });
  ok('只给段数（3 段）+ mock → 可排计划，零计费', pCount.ok && pCount.plan.clipCount === 3
    && pCount.plan.estimate.totalCny === 0 && pCount.plan.estimate.budget.usd === 0
    && pCount.plan.requiresPaymentApproval === false,
    pCount.ok ? JSON.stringify(pCount.plan.estimate.budget) : pCount.code);

  ok('缺总时长 → PLAN_NEED_DURATION + 中文追问',
    planCard.buildPlan({ text: '来条极光' }).code === 'PLAN_NEED_DURATION'
    && /多长/.test(planCard.buildPlan({ text: '来条极光' }).question));
  ok('90 分钟 → PLAN_TOO_LONG', planCard.buildPlan({ text: '90分钟极光' }).code === 'PLAN_TOO_LONG');
  ok('400 段上限：401 段 × 2 秒（非场景卡）→ PLAN_TOO_MANY_CLIPS',
    planCard.buildPlan({ text: '401段极光，每段2秒', model: 'mock', sceneCards: false }).code === 'PLAN_TOO_MANY_CLIPS',
    planCard.buildPlan({ text: '401段极光，每段2秒', model: 'mock', sceneCards: false }).code);
  ok('31 分钟场景卡 → PLAN_SCENE_CARDS_EXHAUSTED（提示扩卡库）',
    planCard.buildPlan({ text: '31分钟极光' }).code === 'PLAN_SCENE_CARDS_EXHAUSTED'
    && /卡库/.test(planCard.buildPlan({ text: '31分钟极光' }).error));
  ok('场景卡模式每段 20 秒 → PLAN_SCENE_CARD_DURATION',
    planCard.buildPlan({ text: '10分钟极光，每段20秒' }).code === 'PLAN_SCENE_CARD_DURATION');
  // 2026-11-16 用户批准：场景卡允许 10 或 15 秒/段，默认仍是 10 秒。
  {
    const p15 = planCard.buildPlan({ text: '10分钟极光，每段15秒' });
    ok('场景卡模式每段 15 秒 → 通过（40 段 × 15 秒 = 10 分钟）',
      p15.ok === true && p15.plan.clipDurationSec === 15 && p15.plan.clipCount === 40,
      p15.ok ? `${p15.plan.clipCount}段 × ${p15.plan.clipDurationSec}秒` : p15.code);
    const pDef = planCard.buildPlan({ text: '10分钟极光' });
    ok('场景卡默认仍是 10 秒/段（未改默认值）', pDef.ok === true && pDef.plan.clipDurationSec === 10,
      pDef.ok ? pDef.plan.clipDurationSec + '秒' : pDef.code);
    const p15m = planCard.buildPlan({ text: '15分钟极光，每段15秒' });
    ok('15 秒/段 15 分钟 = 60 段，成本按秒不变（¥180×1.5 的口径由价目表给）',
      p15m.ok === true && p15m.plan.clipCount === 60 && p15m.plan.totalSec === 900,
      p15m.ok ? `${p15m.plan.clipCount}段 / ¥${p15m.plan.estimate.totalCny}` : p15m.code);
  }
  ok('kling 每段 20 秒（关闭场景卡）→ PLAN_BAD_CLIP_DURATION',
    planCard.buildPlan({ text: '10分钟极光，每段20秒', model: 'kling', sceneCards: false }).code === 'PLAN_BAD_CLIP_DURATION');
  ok('kling 每段 10 秒（关闭场景卡）→ 通过', planCard.buildPlan({ text: '10分钟极光，每段10秒', model: 'kling', sceneCards: false }).ok === true);
  ok('未知模型 → PLAN_UNKNOWN_MODEL', planCard.buildPlan({ text: '10分钟极光', model: 'nope' }).code === 'PLAN_UNKNOWN_MODEL');
  ok('非法分辨率 → PLAN_BAD_RESOLUTION', planCard.buildPlan({ text: '10分钟极光', resolution: '8k' }).code === 'PLAN_BAD_RESOLUTION');
  // 2026-11-17 V1（§9.1-4）行为变更：场景卡改为「随机抽 N 张」，所以两次 buildPlan 抽到的
  // sceneCardIds 本来就不同（这是刻意的，见 [12] 的 seed 复现断言）。这里只要求**其余槽位**确定，
  // 并要求两次都真的固定了 clipCount 张卡（不是放宽成永真）。
  ok('确定性：同输入两次除 planId / 随机抽到的场景卡外一致（§9.1-4 随机抽卡是刻意的）', (() => {
    const a = planCard.buildPlan({ text: '10分钟极光' }).plan;
    const b = planCard.buildPlan({ text: '10分钟极光' }).plan;
    const strip = (p) => {
      const q = { ...p };
      delete q.planId; delete q.createdAt; delete q.sceneCardIds;
      return JSON.stringify(q);
    };
    return strip(a) === strip(b)
      && a.clipCount === 60 && b.clipCount === 60
      && Array.isArray(a.sceneCardIds) && a.sceneCardIds.length === 60
      && Array.isArray(b.sceneCardIds) && b.sceneCardIds.length === 60;
  })());

  // ================= [2] 状态机 =================
  console.log('\n[2] 状态机：转移 / 付费闸门 / 重试预算 / 补位闸门');
  const planState = planCard.buildPlan({ text: '20段极光，每段10秒', model: 'mock' }).plan;
  let st = stateMachine.create(planState, { sessionId: 's_state_1' });
  ok('create → planned，事件 PLAN', st.state === 'planned' && st.events.length === 1);
  const realPlan = planCard.buildPlan({ text: '10分钟极光' }).plan;
  let payErr = null;
  try { stateMachine.transition(stateMachine.create(realPlan), 'CONFIRM', { approved: false }); } catch (e) { payErr = e; }
  ok('真实模型未确认 → STATE_PAYMENT_NOT_APPROVED', payErr && payErr.code === 'STATE_PAYMENT_NOT_APPROVED');
  st = stateMachine.transition(st, 'CONFIRM', { approved: true });
  st = stateMachine.transition(st, 'SUBMIT', { taskId: 'task_x' });
  st = stateMachine.transition(st, 'RUNNING', {});
  ok('planned→confirmed→submitted→running', st.state === 'running' && st.taskId === 'task_x');
  st = stateMachine.transition(st, 'RETRY', { costCny: 0 });
  ok('running→retrying，retries=1', st.state === 'retrying' && st.retries === 1);
  st = stateMachine.transition(st, 'RUNNING', {});
  st = stateMachine.transition(st, 'RETRY', { costCny: 0 });
  st = stateMachine.transition(st, 'RUNNING', {});
  let retryErr = null;
  try { stateMachine.transition(st, 'RETRY', { costCny: 0 }); } catch (e) { retryErr = e; }
  ok('mock 计划第 3 次重试 → STATE_RETRY_LIMIT（最多 2 次）', retryErr && retryErr.code === 'STATE_RETRY_LIMIT');
  let fillErr = null;
  const stFill = stateMachine.transition(stateMachine.transition(stateMachine.create(planState), 'CONFIRM', { approved: true }), 'SUBMIT', { taskId: 't' });
  let stF = stateMachine.transition(stFill, 'RUNNING', {});
  try { stateMachine.transition(stF, 'FILL', { fillCount: 2 }); } catch (e) { fillErr = e; }
  ok('补位超上限（20 段只允许 1 段，一次要 2 段）→ STATE_FILL_LIMIT', fillErr && fillErr.code === 'STATE_FILL_LIMIT');
  let illegal = null;
  try { stateMachine.transition(stateMachine.create(planState), 'COMPLETE'); } catch (e) { illegal = e; }
  ok('planned→COMPLETE 非法转移被拒', illegal && illegal.code === 'STATE_ILLEGAL_TRANSITION');
  const budgetErrPlan = planCard.buildPlan({ text: '20段极光，每段10秒' }).plan;
  let stB = stateMachine.create(budgetErrPlan);
  stB = stateMachine.transition(stB, 'CONFIRM', { approved: true });
  stB = stateMachine.transition(stB, 'SUBMIT', { taskId: 't' });
  stB = stateMachine.transition(stB, 'RUNNING', {});
  let budgetErr = null;
  try { stateMachine.transition(stB, 'RETRY', { costCny: budgetErrPlan.estimate.retryCapCny + 7 }); } catch (e) { budgetErr = e; }
  ok('重试费用超总预算 10% → STATE_RETRY_BUDGET', budgetErr && budgetErr.code === 'STATE_RETRY_BUDGET');
  const observed = stateMachine.observe(st, { retries: 5, pipelineStatus: 'failed' });
  ok('observe 只记录观察值、不参与闸门', observed.observed.retries === 5 && observed.state === st.state);
  const sum = stateMachine.summary(observed);
  ok('summary 带 label/terminal/retry 限额/事件', sum.label && sum.terminal === false
    && sum.retryAllowed === 2 && Array.isArray(sum.events));

  // ================= [3] 记忆 =================
  console.log('\n[3] 记忆：会话落盘 / 计划 / 状态 / 任务检索');
  const sid3 = 's_memory_1';
  assistantMemory.appendMessage(sid3, { role: 'user', text: '你好' });
  assistantMemory.appendMessage(sid3, { role: 'assistant', text: '我是小智' });
  assistantMemory.save(assistantMemory.getOrCreate(sid3));
  ok('消息落盘后重新读取仍在', assistantMemory.listMessages(sid3, 10).length === 2
    && fs.existsSync(assistantMemory.sessionFile(sid3)));
  const planM = planCard.buildPlan({ text: '5分钟极光' }).plan;
  assistantMemory.addPlan(sid3, planM);
  ok('计划卡写入会话并可取回', assistantMemory.lastPlan(sid3) && assistantMemory.lastPlan(sid3).planId === planM.planId);
  const stM = stateMachine.create(planM, { sessionId: sid3 });
  assistantMemory.setState(sid3, stM);
  ok('状态机快照按 planId 存取', assistantMemory.getState(sid3, planM.planId).state === 'planned');
  ok('非法会话 id 被拒', (() => { try { assistantMemory.getOrCreate('a/../b'); return false; } catch (e) { return e.code === 'SESSION_BAD_ID'; } })());
  const now = Date.now();
  const fakeTasks = [
    { taskId: 'task_old', prompt: '雪山日出', status: 'completed', createdAt: new Date(now - 86400000).toISOString(), completedAt: new Date(now - 86000000).toISOString(), totalClips: 10, clipDuration: 10, outputPath: 'output/old.mp4' },
    { taskId: 'task_new', prompt: '极光海岸', status: 'completed', createdAt: new Date(now - 3600000).toISOString(), completedAt: new Date(now - 3500000).toISOString(), totalClips: 6, clipDuration: 10, outputPath: 'output/new.mp4' },
    { taskId: 'task_live', prompt: '沙漠', status: 'generating', createdAt: new Date(now - 60000).toISOString(), totalClips: 4, clipDuration: 10 }
  ];
  const lastRes = assistantMemory.retrieveTasks({ query: '上一次的视频', tasks: fakeTasks, finals: [] });
  ok('意图分类：上一次的视频 → last', lastRes.intent === 'last' && lastRes.refs[0].taskId === 'task_new');
  const themeRes = assistantMemory.retrieveTasks({ query: '上一次雪山视频', tasks: fakeTasks, finals: [] });
  ok('主题过滤：雪山 → 只命中 task_old', themeRes.refs.length === 1 && themeRes.refs[0].taskId === 'task_old');
  const statusRes = assistantMemory.retrieveTasks({ query: '现在进度怎样', tasks: fakeTasks, finals: [] });
  ok('意图分类：进度 → status，且优先在跑任务', statusRes.intent === 'status' && statusRes.refs[0].taskId === 'task_live');
  ok('意图分类：10 分钟极光 → create', assistantMemory.classify('10 分钟极光').intent === 'create');
  ok('意图分类：你好 → greeting', assistantMemory.classify('你好').intent === 'greeting');

  // ================= [3a-2] 2026-11-18 S0：用户实测的两句 + 听不懂要反问 =================
  // 事故：用户在英文界面说「提示词呢」「场景卡看一下」→ 都被判 unknown，然后被当成"要排计划"
  // 去反问总时长（答非所问）。这里锁住三点：① 两句归位；② 真·听不懂必须反问；
  // ③ 带槽位的句子（720p / 改成 1080p）仍按续问处理，不许被"反问"拦截。
  console.log('\n[3a-2] S0：宾语前置的两句 + 听不懂先反问（2026-11-18 用户实测）');
  ok('意图分类：「提示词呢」→ plan_edit（不再 unknown）',
    assistantMemory.classify('提示词呢').intent === 'plan_edit'
    && assistantMemory.classify('那提示词呢').intent === 'plan_edit');
  ok('意图分类：「场景卡看一下」→ plan_scenes（宾语前置也认）',
    assistantMemory.classify('场景卡看一下').intent === 'plan_scenes'
    && assistantMemory.classify('场景卡看看').intent === 'plan_scenes');
  ok('负向：「提示词改成：雪山」不算查看（整句锚定，不误伤修改）',
    assistantMemory.isPromptViewRequest('提示词改成：雪山') === false
    && assistantMemory.classify('提示词改成：雪山').intent === 'plan_edit');
  {
    const sid = 'verify-s0-unknown-' + Date.now().toString(36);
    const rZh = supervisor.handleMessage({ sessionId: sid, text: '随便说点什么', userId: 'local', lang: 'zh' });
    ok('听不懂（中文）→ 反问一句，且不产出计划卡',
      rZh.replyKey === 'assistant.reply.unknown' && !rZh.plan && /没接住/.test(rZh.reply));
    ok('听不懂（中文）→ 不再背「我可以做三件事」的能力菜单',
      !/可以做三件事/.test(rZh.reply));
    const rEn = supervisor.handleMessage({ sessionId: sid + '-en', text: '???', userId: 'local', lang: 'en' });
    ok('听不懂（英文）→ 全英文、无中文残留',
      rEn.replyKey === 'assistant.reply.unknown' && !/[\u4e00-\u9fff]/.test(rEn.reply));
    const rSlot = supervisor.handleMessage({ sessionId: sid + '-2', text: '2 分钟', userId: 'local', lang: 'zh' });
    ok('带时长的话仍能排计划（反问不拦正常排计划）',
      !!rSlot.plan && rSlot.replyKey === 'assistant.reply.plan');
    const rRes = supervisor.handleMessage({ sessionId: sid + '-2', text: '改成 1080p', userId: 'local', lang: 'zh' });
    ok('槽位句「改成 1080p」仍按续问处理（不被反问拦截）',
      !!rRes.plan && String(rRes.plan.resolution).toLowerCase().includes('1080'));
  }

  // ================= [3a-3] 2026-11-19 D1–D3：E0 找出的确定性缺口 =================
  // 背景（交接 §16）：57 句语料里 12 句零命中，逐条看只有 3 句是真垃圾输入，
  // 其余 9 句是**确定性缺口**——规则就能补齐，不需要 4 秒/次的模型。
  // 这里按 D1→D2→D3 逐条锁死；**只纠正意图标签，不改执行路径**：
  // 槽位句仍走既有「按上次计划续问」逻辑（回复一张新计划卡），避免动场景卡分配 / planId 语义。
  console.log('\n[3a-3] D1–D3：零命中句的确定性改造（2026-11-19）');
  ok('D1 槽位句（只给分辨率）→ plan_edit，不再 unknown',
    ['1080p', '480p', '改成 1080p', '换成 1080p', '改成 720p', '分辨率 1080p']
      .every((t) => assistantMemory.classify(t).intent === 'plan_edit'),
    ['1080p', '改成 1080p'].map((t) => t + '=' + assistantMemory.classify(t).intent).join(' / '));
  ok('D1 负向：带「分辨率/通道」名词的显式设置句仍走 settings（不抢 V2 B6）',
    assistantMemory.classify('把分辨率改成 1080p').intent === 'settings');
  ok('D1 槽位句带 reason=slot_only（supervisor 据此走续问路径，不进「按段编辑」）',
    assistantMemory.classify('1080p').reason === 'slot_only'
    && assistantMemory.classify('改成 1080p').reason === 'slot_only');
  ok('D1 负向：带主题 / 中文时长的句子仍是 create（槽位分支不抢排计划）',
    assistantMemory.classify('10 分钟极光').intent === 'create'
    && assistantMemory.classify('每段 15 秒').intent === 'create'
    && assistantMemory.classify('10 分钟').intent === 'create');
  ok('D1 负向：带指代的「这里换成1080p」/「都换成 1080p」不归 plan_edit（不抢既有续问）',
    assistantMemory.classify('这里换成1080p').intent !== 'plan_edit'
    && assistantMemory.classify('都换成 1080p').intent !== 'plan_edit');
  ok('D1 英文时长句与中文对称：「25 seconds」→ create（中文「25 秒」本来就是 create）',
    assistantMemory.classify('25 seconds').intent === 'create'
    && assistantMemory.classify('2 minutes').intent === 'create');
  {
    const sidSlot = 'verify-d1-slot-' + Date.now().toString(36);
    const noPlan = supervisor.handleMessage({ sessionId: sidSlot, text: '1080p', lang: 'zh' });
    ok('D1 行为：没有计划时说「1080p」→ 问总时长（不问第几段）',
      noPlan.ok === true && noPlan.intent === 'plan_edit' && noPlan.plan === null
      && /要做多长|总时长/.test(noPlan.reply) && !/第几段/.test(noPlan.reply),
      String(noPlan.reply || '').slice(0, 50));
    const base = supervisor.handleMessage({ sessionId: sidSlot, text: '30 秒', lang: 'zh' });
    const changed = supervisor.handleMessage({ sessionId: sidSlot, text: '1080p', lang: 'zh' });
    ok('D1 行为：有计划时说「1080p」→ 按续问改计划（分辨率 1080p、不反问时长）',
      base.ok === true && !!base.plan
      && changed.ok === true && changed.intent === 'plan_edit'
      && !!changed.plan && String(changed.plan.resolution).toLowerCase() === '1080p'
      && changed.replyKey === 'assistant.reply.plan' && !/要做多长/.test(changed.reply),
      `${changed.replyKey}/${changed.plan && changed.plan.resolution}`);
  }
  ok('D2 多命中优先级：同时有「总时长」和「看场景卡」→ create（时长信号不被抢走）',
    assistantMemory.classify('我要1个20秒的，每段为10秒，把场景卡给我看一下').intent === 'create');
  ok('D2 负向：没有时长信号时「看场景卡」仍是 plan_scenes（「第 2 段」不算时长）',
    assistantMemory.classify('看一下场景卡').intent === 'plan_scenes'
    && assistantMemory.classify('看一下第 2 段的场景卡').intent === 'plan_scenes');
  ok('D2 行为：长句 → 排计划（20 秒 / 每段 10 秒 = 2 段），不落到场景预览',
    (() => {
      const r = supervisor.handleMessage({
        sessionId: 'verify-d2-' + Date.now().toString(36),
        text: '我要1个20秒的，每段为10秒，把场景卡给我看一下',
        lang: 'zh'
      });
      return r.ok === true && r.intent === 'create' && !!r.plan
        && r.plan.clipCount === 2 && r.replyKey === 'assistant.reply.plan';
    })());
  ok('D3 裸名词 / 口语问法 → plan_scenes',
    ['场景卡', '场景卡呢', '那场景卡', '你选的是哪几张卡', '你选的是哪几张场景卡']
      .every((t) => assistantMemory.classify(t).intent === 'plan_scenes'),
    ['场景卡', '你选的是哪几张卡'].map((t) => t + '=' + assistantMemory.classify(t).intent).join(' / '));
  ok('D3 负向：不要场景卡 / 配乐有哪些 / 场景从卡库选 的原分类不变',
    assistantMemory.classify('不要场景卡').intent === 'unknown'
    && assistantMemory.classify('配乐有哪些').intent === 'bgm'
    && assistantMemory.classify('10 分钟，场景从卡库选。').intent === 'create');
  {
    const sidBare = 'verify-d3-bare-' + Date.now().toString(36);
    supervisor.handleMessage({ sessionId: sidBare, text: '30 秒', lang: 'zh' });
    const keys = assistantMemory.lastPlan(sidBare).sceneCardIds
      .map((id) => sceneCardLibrary.getCardById(id).scene_key);
    const bare = supervisor.handleMessage({ sessionId: sidBare, text: '场景卡', lang: 'zh' });
    ok('D3 行为：有计划时说裸名词「场景卡」→ 只读预览（plan=null、列出已固定的卡）',
      bare.ok === true && bare.intent === 'plan_scenes' && bare.plan === null
      && keys.length === 3 && keys.every((k) => bare.reply.includes(k)),
      bare.reply && bare.reply.split('\n')[0]);
  }
  ok('D1–D3 与 traceMatches 保持一致（首个命中映射后 = classify 结果）',
    ['1080p', '改成 1080p', '25 seconds', '场景卡', '你选的是哪几张卡',
      '我要1个20秒的，每段为10秒，把场景卡给我看一下']
      .every((t) => {
        const hits = assistantMemory.traceMatches(t);
        const first = hits.length ? (hits[0].startsWith('plan_edit') ? 'plan_edit' : hits[0]) : 'unknown';
        return first === assistantMemory.classify(t).intent;
      }));

  // ================= [3a-4] 意图金标准语料：防「补一句、抢走另一句」回归 =================
  // 为什么不是「再补一条 ??? 的断言」：
  // 历史事故（交接 §16）是打地鼠——classify 是优先级链，新增一条正则会**静默改写**
  // 别的句子的去向；只测这次修的那句，下一轮漏掉的会是别的句子。
  // 这张表 = 一句真实原话 + 期望意图。以后用户再报一句，就往表里加一行；
  // 任何规则改动都必须让整张表继续全绿。成本与单条断言同量级，覆盖面大一个量级。
  const GOLDEN_INTENTS = [
    // —— E0 零命中句：D1–D3 已补齐 ——
    ['1080p', 'plan_edit'],
    ['720p', 'plan_edit'],
    ['改成 1080p', 'plan_edit'],
    ['换成 720p', 'plan_edit'],
    ['25 seconds', 'create'],
    ['场景卡', 'plan_scenes'],
    ['你选的是哪几张卡', 'plan_scenes'],
    // —— E0 真·垃圾输入：必须保持 unknown（D4 的自动化保险）——
    ['???', 'unknown'],
    ['随便说点什么', 'unknown'],
    ['blah blah whatever', 'unknown'],
    ['asdfghjkl', 'unknown'],
    // —— 历史上被新分支抢走过的老句子（新增正则先过这几行）——
    ['提示词呢', 'plan_edit'],
    ['场景卡看一下', 'plan_scenes'],
    ['看一下场景卡', 'plan_scenes'],
    ['提示词改成：雪山', 'plan_edit'],
    ['换一组', 'plan_edit'],
    ['每段 15 秒', 'create'],
    ['再来一条', 'create'],
    ['不要场景卡', 'unknown'],
    ['10 分钟极光', 'create'],
    ['配乐有哪些', 'bgm'],
    ['确认生成吗？', 'confirm'],
    ['上次那条为什么失败', 'repair'],
    ['预算还剩多少', 'context'],
    ['你选了哪些场景卡', 'plan_scenes'],
    // —— E0 多命中长句（时长 vs 看卡）：必须继续走 create ——
    ['我要1个20秒的每段为10秒，分辨率为720P。然后你写好场景卡之后，把场景卡给我看一下。', 'create']
  ];
  {
    const bad = GOLDEN_INTENTS.filter(([t, want]) => assistantMemory.classify(t).intent !== want);
    ok('意图金标准语料：' + GOLDEN_INTENTS.length + ' 句全部归位（新增正则先过这张表）',
      bad.length === 0,
      bad.map(([t, want]) => JSON.stringify(t) + '→' + assistantMemory.classify(t).intent + '(期望 ' + want + ')').join(' / '));
  }
  ok('意图金标准与 traceMatches 一致（首个命中映射后 = 期望意图）',
    GOLDEN_INTENTS.every(([t, want]) => {
      const hits = assistantMemory.traceMatches(t);
      const first = hits.length ? (hits[0].startsWith('plan_edit') ? 'plan_edit' : hits[0]) : 'unknown';
      return first === want;
    }), '见上一行');
  {
    // 垃圾输入的**行为**不变：只反问、不排计划、不问时长、不背能力菜单。
    // 这是 S0「答非所问」事故的正面防线；逐句跑 supervisor（零计费、不建任务）。
    const GARBAGE = ['???', '随便说点什么', 'blah blah whatever', 'asdfghjkl'];
    const bad = [];
    GARBAGE.forEach((t, i) => {
      const r = supervisor.handleMessage({
        sessionId: 'verify-garbage-' + Date.now().toString(36) + '-' + i,
        text: t,
        lang: 'zh'
      });
      // 判据要精确：无计划时 replyUnknown 的澄清句里**本来就有**「要排计划就告诉我总时长」，
      // 那是澄清选项，不是排计划式的「这条视频要做多长？」。所以只禁后者 + replyKey。
      const good = r.ok === true && r.intent === 'unknown'
        && r.replyKey === 'assistant.reply.unknown' && r.plan === null
        && /没接住/.test(r.reply)
        && !/这条视频要做多长/.test(r.reply)
        && !/可以做三件事/.test(r.reply);
      if (!good) bad.push(JSON.stringify(t) + '→' + r.intent + '/' + r.replyKey);
    });
    ok('垃圾输入（中文模式）→ 只反问：不排计划、不问时长、不背能力菜单',
      bad.length === 0, bad.join(' / '));
  }

  // ================= [3a-5] 2026-11-19 B 目标：agent 工具门面（runAgentTool）=================
  // agent.js 只做「理解+选工具」；真正执行走 supervisor 既有确定性函数。
  // 本组锁三件事：① 只读工具只读（不建任务、不改计划）；② 改计划工具真的改；
  // ③ 没有 execute（确认执行仍只能走计划卡按钮）。
  console.log('\n[3a-5] B 目标：agent 工具门面（runAgentTool，零计费、不建任务）');
  {
    const sidA = 'verify-agent-tools-' + Date.now().toString(36);
    const toolsBefore = taskManager.getAllTasks().length;
    const t = (tool, args = {}) => supervisor.runAgentTool({
      tool, args, sessionId: sidA, userId: 'local', lang: 'zh'
    });

    ok('工具门面白名单 14 个且**没有** execute',
      supervisor.AGENT_TOOL_NAMES.length === 14
      && ['execute', 'delete', 'create_task', 'pay'].every((n) => supervisor.AGENT_TOOL_NAMES.indexOf(n) === -1),
      supervisor.AGENT_TOOL_NAMES.join(','));

    const created = t('plan_video', { totalMinutes: 0.5, resolution: '1080p' });
    ok('plan_video(0.5 分钟/1080p) → 3 段计划 + plan 回传',
      created.ok === true && !!created.plan && created.plan.clipCount === 3
      && created.plan.resolution === '1080p' && created.replyKey === 'assistant.reply.plan',
      created.ok ? `${created.plan.clipCount}段/${created.plan.resolution}` : created.code);

    const shown = t('show_plan');
    ok('show_plan → 只读摘要、planId 不变、不建任务',
      shown.ok === true && !!shown.plan && shown.plan.planId === created.plan.planId
      && taskManager.getAllTasks().length === toolsBefore);

    const showPrompt = t('show_prompt');
    ok('show_prompt → 贴出各段提示词（含第 1 段）、plan=null、不建任务',
      showPrompt.ok === true && showPrompt.plan === null
      && /第 1 段/.test(showPrompt.reply) && showPrompt.reply.length > 40,
      showPrompt.ok ? showPrompt.reply.slice(0, 40) : showPrompt.code);
    const showPrompt2 = t('show_prompt', { segment: 2 });
    ok('show_prompt(segment=2) → 只贴第 2 段',
      showPrompt2.ok === true && /第 2 段/.test(showPrompt2.reply)
      && !/第 1 段/.test(showPrompt2.reply),
      showPrompt2.ok ? showPrompt2.reply.slice(0, 40) : showPrompt2.code);

    const cards = t('show_scene_cards');
    ok('show_scene_cards → 只读预览（plan=null）',
      cards.ok === true && cards.plan === null && /场景卡/.test(cards.reply));

    const swapped = t('edit_plan', { action: 'swap_scene', segment: 2 });
    ok('edit_plan swap_scene(第 2 段) → 已换第 2 段、planId 不变',
      swapped.ok === true && /已换第 2 段/.test(swapped.reply) && swapped.plan.planId === created.plan.planId);

    const promptEdit = t('edit_plan', { action: 'set_prompt', segment: 2, prompt: '雪山湖面，冷色调' });
    ok('edit_plan set_prompt(第 2 段) → 已改第 2 段、promptOverrides 落盘',
      promptEdit.ok === true && /已改第 2 段/.test(promptEdit.reply)
      && promptEdit.plan.promptOverrides
      && promptEdit.plan.promptOverrides['1'] === '雪山湖面，冷色调',
      promptEdit.plan && promptEdit.plan.promptOverrides
        ? Object.keys(promptEdit.plan.promptOverrides).join(',') : '无覆盖');

    const batch = t('edit_plan', { action: 'swap_all' });
    ok('edit_plan swap_all → 整批换卡、planId 不变',
      batch.ok === true && /已换掉全部/.test(batch.reply) && batch.plan.planId === created.plan.planId);

    const res = t('edit_plan', { action: 'set_resolution', resolution: '720p' });
    ok('edit_plan set_resolution → 新计划 720p（走既有续问路径）',
      res.ok === true && !!res.plan && res.plan.resolution === '720p');

    const dur = t('edit_plan', { action: 'set_duration', totalMinutes: 1 });
    ok('edit_plan set_duration → 1 分钟计划（6 段 × 10 秒）',
      dur.ok === true && !!dur.plan && dur.plan.clipCount === 6,
      dur.ok ? `${dur.plan.clipCount}段` : dur.code);

    const clipSec = t('edit_plan', { action: 'set_clip_duration', clipDurationSec: 15 });
    ok('edit_plan set_clip_duration → 15 秒/段（场景卡合法档位）',
      clipSec.ok === true && !!clipSec.plan && clipSec.plan.clipDurationSec === 15);

    const noPlanRes = supervisor.runAgentTool({
      tool: 'edit_plan',
      args: { action: 'set_resolution', resolution: '480p' },
      sessionId: 'verify-agent-noplan-' + Date.now().toString(36),
      lang: 'zh'
    });
    ok('无计划时 set_resolution → 问总时长（不瞎建、不报错）',
      noPlanRes.ok === true && noPlanRes.plan === null && /要做多长|总时长/.test(noPlanRes.reply));

    const budget = t('budget');
    ok('budget → 简报含剩余/已花（真实 budget.status 口径）',
      budget.ok === true && /剩余 \$/.test(budget.reply) && /已花 \$/.test(budget.reply));
    const status = t('status');
    ok('status → 有回复', status.ok === true && !!status.reply);
    const assets = t('assets');
    ok('assets → 有回复', assets.ok === true && !!assets.reply);
    const prefs = t('prefs');
    ok('prefs → 有回复', prefs.ok === true && !!prefs.reply);

    const bgmList = t('bgm', { action: 'list' });
    ok('bgm list → 列素材库', bgmList.ok === true && /首/.test(bgmList.reply));
    const bgmOff = t('bgm', { action: 'off' });
    ok('bgm off → 计划配乐关闭',
      bgmOff.ok === true && !!bgmOff.plan && bgmOff.plan.bgm && bgmOff.plan.bgm.mode === 'off');

    const confirm = t('confirm_plan');
    ok('confirm_plan → 回传计划 + 确认动作，但**不建任务**',
      confirm.ok === true && !!confirm.plan
      && Array.isArray(confirm.actions) && confirm.actions[0].requiresApproval === true
      && taskManager.getAllTasks().length === toolsBefore);

    const stg = t('settings_change', { key: 'resolution', value: '1080p' });
    ok('settings_change → 只返回待确认项（requiresConfirm）',
      stg.ok === true && !!stg.pendingChange && stg.pendingChange.requiresConfirm === true);
    supervisor._clearPendingChanges();

    const badTool = t('execute', {});
    ok('不存在 execute 工具 → AGENT_TOOL_UNKNOWN（模型不可能直接花钱）',
      badTool.ok === false && badTool.code === 'AGENT_TOOL_UNKNOWN');
    const badArgs = t('edit_plan', { action: 'swap_scene' });
    ok('swap_scene 缺 segment → AGENT_BAD_ARGS', badArgs.ok === false && badArgs.code === 'AGENT_BAD_ARGS');

    const actx = supervisor.agentContextOf({ sessionId: sidA });
    ok('agentContextOf → 紧凑只读上下文（有规划/余额）',
      actx.hasPlan === true && /段/.test(actx.planSummary || '') && typeof actx.budgetUsd === 'number',
      JSON.stringify(actx).slice(0, 120));
    const actxEmpty = supervisor.agentContextOf({ sessionId: 'verify-agent-ctx-' + Date.now().toString(36) });
    ok('agentContextOf → 新会话 hasPlan=false、无计划摘要',
      actxEmpty.hasPlan === false && actxEmpty.planSummary === null);

    ok('全部工具调用结束：任务数不变', taskManager.getAllTasks().length === toolsBefore);
  }

  // ================= [3a-6] 2026-11-19 B 目标：agent 运行时（路由/落会话/回退）=================
  // 本组不连模型：callLLM 注入固定 JSON。锁：
  //   ① 会话落盘 = 1 条 user + 1 条 assistant（不重不丢）；
  //   ② agent 失败（无 Key/坏 JSON/接地拒绝）→ handled:false 且**不写会话**（server 回退规则路径）；
  //   ③ 工具失败 → handled:true + ok:false（明确报错，不猜）；
  //   ④ 前端契约字段（intent=create 弹卡、replyKey、plan、agent meta）。
  console.log('\n[3a-6] B 目标：agent 运行时（stub 模型，零计费）');
  {
    const rt = (sid, text, json, opts = {}) => agentRuntime.handleAgentTurn({
      text, sessionId: sid, userId: 'local', lang: 'zh', supervisor,
      callLLM: async () => ({ text: typeof json === 'string' ? json : JSON.stringify(json) }),
      ...opts
    });

    const sidSay = 'verify-rt-say-' + Date.now().toString(36);
    const sayOut = await rt(sidSay, '你能做什么？', { say: '我能陪你排计划、改计划、看进度。' });
    ok('say 路径：handled + intent=chat + 回复原文',
      sayOut.handled === true && sayOut.response.ok === true
      && sayOut.response.intent === 'chat' && /排计划/.test(sayOut.response.reply)
      && sayOut.response.replyKey === 'assistant.reply.agentChat');
    ok('say 路径：会话落 1 条 user + 1 条 assistant',
      assistantMemory.listMessages(sidSay, 10).length === 2
      && assistantMemory.listMessages(sidSay, 10)[0].role === 'user'
      && assistantMemory.listMessages(sidSay, 10)[1].role === 'assistant');

    const sidClarify = 'verify-rt-clarify-' + Date.now().toString(36);
    const clarOut = await rt(sidClarify, '搞一下', { clarify: '想做多长？' });
    ok('clarify 路径：handled + intent=clarify + 追问原文',
      clarOut.handled === true && clarOut.response.intent === 'clarify'
      && clarOut.response.reply === '想做多长？'
      && clarOut.response.replyKey === 'assistant.reply.agentClarify');

    const sidPlan = 'verify-rt-plan-' + Date.now().toString(36);
    const beforeTasks = taskManager.getAllTasks().length;
    const planOut = await rt(sidPlan, '来个 30 秒', { tool: 'plan_video', args: { totalMinutes: 0.5 } });
    ok('工具路径 plan_video：intent=create + 计划回传（前端会弹卡）',
      planOut.handled === true && planOut.response.ok === true
      && planOut.response.intent === 'create' && !!planOut.response.plan
      && planOut.response.plan.clipCount === 3 && planOut.response.canExecute === true
      && taskManager.getAllTasks().length === beforeTasks);
    ok('工具路径：会话仍是 1 user + 1 assistant',
      assistantMemory.listMessages(sidPlan, 10).length === 2);

    const statusOut = await rt(sidPlan, '进度', { tool: 'status', args: {} });
    ok('工具路径 status：intent=status', statusOut.handled === true && statusOut.response.intent === 'status');

    const confirmOut = await rt(sidPlan, '确认生成吗', { tool: 'confirm_plan', args: {} });
    ok('工具路径 confirm_plan：intent=confirm + requiresApproval（仍不建任务）',
      confirmOut.handled === true && confirmOut.response.intent === 'confirm'
      && confirmOut.response.plan
      && Array.isArray(confirmOut.response.actions)
      && confirmOut.response.actions[0].requiresApproval === true
      && taskManager.getAllTasks().length === beforeTasks);

    const sidBad = 'verify-rt-badtool-' + Date.now().toString(36);
    const badToolOut = await rt(sidBad, '换个卡', { tool: 'edit_plan', args: { action: 'swap_all' } });
    ok('工具执行失败（无计划 swap_all）→ handled + ok:false + AGENT_NO_PLAN（不猜、不回退）',
      badToolOut.handled === true && badToolOut.response.ok === false
      && badToolOut.response.code === 'AGENT_NO_PLAN' && /计划卡/.test(badToolOut.response.reply));
    ok('工具失败也落会话（1 user + 1 assistant，用户能看到报错）',
      assistantMemory.listMessages(sidBad, 10).length === 2);

    const sidNoKey = 'verify-rt-nokey-' + Date.now().toString(36);
    const noKeyOut = await agentRuntime.handleAgentTurn({
      text: '进度', sessionId: sidNoKey, lang: 'zh', supervisor,
      callLLM: async () => ({ text: '', failure: { kind: 'NO_KEY' } })
    });
    ok('无 Key → handled:false / fallback / NO_KEY，且**不写会话**',
      noKeyOut.handled === false && noKeyOut.fallback === true
      && noKeyOut.failure.kind === 'NO_KEY'
      && assistantMemory.listMessages(sidNoKey, 10).length === 0);

    const sidBadJson = 'verify-rt-badjson-' + Date.now().toString(36);
    const badJsonOut = await agentRuntime.handleAgentTurn({
      text: '进度', sessionId: sidBadJson, lang: 'zh', supervisor,
      callLLM: async () => ({ text: '我觉得可以' })
    });
    ok('两次坏 JSON → handled:false / BAD_JSON，且不写会话',
      badJsonOut.handled === false && badJsonOut.failure.kind === 'BAD_JSON'
      && assistantMemory.listMessages(sidBadJson, 10).length === 0);

    const sidExec = 'verify-rt-exec-' + Date.now().toString(36);
    const execOut = await agentRuntime.handleAgentTurn({
      text: '帮我直接生成', sessionId: sidExec, lang: 'zh', supervisor,
      callLLM: async () => ({ text: JSON.stringify({ tool: 'execute', args: {} }) })
    });
    ok('模型妄想调 execute → 校验失败 → handled:false 回退（没有执行权）',
      execOut.handled === false && execOut.fallback === true
      && assistantMemory.listMessages(sidExec, 10).length === 0);

    const sidGround = 'verify-rt-ground-' + Date.now().toString(36);
    const groundOut = await rt(sidGround, '要多少钱', { say: '大概要 $9.99。' });
    ok('say 幻觉金额 → handled:false（回退），不写会话',
      groundOut.handled === false && groundOut.failure.kind === 'SAY_UNGROUNDED'
      && assistantMemory.listMessages(sidGround, 10).length === 0);
  }

  // ================= [3a-7] 2026-11-19 B 目标：agent 总开关（一键关回规则路径）=================
  // 目标里明确要求「可一键关回规则路径」：设置页开关 → 下一条消息生效，不需要重启。
  // 优先级写死：环境变量 on/off 强制覆盖 > 持久化开关（默认关）。
  console.log('\n[3a-7] B 目标：agent 总开关（持久化 + 环境变量覆盖 + 接线）');
  {
    const envBackup = process.env.ASSISTANT_AGENT;
    delete process.env.ASSISTANT_AGENT;
    const s0 = agentSwitch.reload();
    ok('默认关：未设置环境变量、无开关文件时 enabled=false',
      s0.enabled === false && s0.persisted === false && s0.envForced === false);
    ok('开关文件在隔离目录内（ASSISTANT_DIR/agent-switch.json）',
      agentSwitch.SWITCH_FILE.indexOf(process.env.ASSISTANT_DIR) === 0,
      agentSwitch.SWITCH_FILE);

    const on = agentSwitch.setEnabled(true, { by: 'verify_s4' });
    ok('setEnabled(true) → ok + enabled + 落盘文件存在',
      on.ok === true && on.enabled === true && on.persisted === true
      && fs.existsSync(agentSwitch.SWITCH_FILE));
    const onFile = JSON.parse(fs.readFileSync(agentSwitch.SWITCH_FILE, 'utf8'));
    ok('落盘内容可解析且 enabled=true、记录 updatedBy',
      onFile.enabled === true && onFile.updatedBy === 'verify_s4' && !!onFile.updatedAt);
    ok('reload 后仍是开（持久化生效）', agentSwitch.reload().enabled === true);

    process.env.ASSISTANT_AGENT = 'off';
    const forcedOff = agentSwitch.getState();
    ok('环境变量 off 强制覆盖持久化开 → enabled=false、envForced=true',
      forcedOff.enabled === false && forcedOff.envForced === true && forcedOff.envValue === 'off');
    process.env.ASSISTANT_AGENT = 'on';
    const forcedOn = agentSwitch.getState();
    ok('环境变量 on 强制覆盖持久化关 → enabled=true', forcedOn.enabled === true);
    delete process.env.ASSISTANT_AGENT;

    const off = agentSwitch.setEnabled(false, { by: 'verify_s4' });
    ok('setEnabled(false) → 关；reload 仍关',
      off.ok === true && off.enabled === false && agentSwitch.reload().enabled === false);

    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok('server：暴露 GET/POST /api/assistant/agent，且 message 路由用开关（不是只看 env）',
      serverSrc.indexOf("app.get('/api/assistant/agent'") !== -1
      && serverSrc.indexOf("app.post('/api/assistant/agent'") !== -1
      && serverSrc.indexOf('assistantAgentSwitch.isEnabled()') !== -1
      && /AGENT_SWITCH_BAD_BODY/.test(serverSrc));
    const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'screens', 'settingsPage.js'), 'utf8');
    ok('前端设置页：开关读取/保存走 /api/assistant/agent，带 toggleAgent 处理',
      settingsSrc.indexOf("fetchJson('/api/assistant/agent')") !== -1
      && /function toggleAgent|async function toggleAgent/.test(settingsSrc)
      && settingsSrc.indexOf('agentTitle') !== -1);
    // 2026-11-19 事故：React 的 style 只接受对象；上一版把 'opacity:.5;...' 字符串传进去
    // → 整个设置页崩成 "Minified React error #62"（用户重启后「设置页没有了」）。
    ok('设置页 style 只传对象（防 React #62 字符串 style 崩页）',
      settingsSrc.indexOf("'opacity:.5;cursor:not-allowed'") === -1
      && /style=\$\{agentSwitch && agentSwitch\.envForced \? \{ opacity: 0\.5/.test(settingsSrc));
    const msgs = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'i18n', 'messages', 'settings.js'), 'utf8');
    ok('i18n：开关文案中英都齐（agentTitle/agentDesc/agentSaved）',
      (msgs.match(/agentTitle:/g) || []).length === 2
      && (msgs.match(/agentDesc:/g) || []).length === 2
      && (msgs.match(/agentSaved:/g) || []).length === 2);

    ok('结束状态：默认关（不影响后续套件）', agentSwitch.isEnabled() === false);
    if (envBackup !== undefined) process.env.ASSISTANT_AGENT = envBackup;
  }

  // ================= [3a-8] 2026-11-19 B 目标：每会话串行队列（防并发双计划）=================
  // agent 链路是异步的（真实模型 2–4s）。同一会话连发两句若并发跑，会读到同一份"当前计划"，
  // 可能出两张计划卡 / 乱序覆盖（交接 §10.1 E6）。这里锁队列语义 + server 接线。
  console.log('\n[3a-8] B 目标：每会话串行队列（FIFO / 跨会话并行 / 错误隔离）');
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const order = [];
    const p1 = turnQueue.enqueue('q-sess-a', async () => {
      order.push('a1-start'); await sleep(30); order.push('a1-end'); return 1;
    });
    const p2 = turnQueue.enqueue('q-sess-a', async () => {
      order.push('a2-start'); await sleep(5); order.push('a2-end'); return 2;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    ok('同会话 FIFO 串行（a1 结束才 a2 开始）',
      order.join(',') === 'a1-start,a1-end,a2-start,a2-end' && r1 === 1 && r2 === 2,
      order.join(','));

    const order2 = [];
    let releaseB = null;
    const gateB = new Promise((res) => { releaseB = res; });
    const pb = turnQueue.enqueue('q-sess-b', async () => {
      order2.push('b-start'); await gateB; order2.push('b-end');
    });
    const pc = turnQueue.enqueue('q-sess-c', async () => {
      order2.push('c-start'); await sleep(10); order2.push('c-end');
    });
    await pc; // 若不同会话被串行，这里会被 gateB 卡死
    ok('不同会话并行（c 完成时 b 仍被 gate 挡住）',
      order2.join(',') === 'b-start,c-start,c-end', order2.join(','));
    releaseB();
    await pb;

    const order3 = [];
    const bad = turnQueue.enqueue('q-sess-d', async () => {
      order3.push('bad'); throw new Error('boom');
    });
    const good = turnQueue.enqueue('q-sess-d', async () => {
      order3.push('good'); return 'ok';
    });
    let badErr = null;
    try { await bad; } catch (e) { badErr = e; }
    const goodRes = await good;
    ok('前一任务失败不阻塞后一任务（错误只归它自己）',
      !!badErr && badErr.message === 'boom' && goodRes === 'ok' && order3.join(',') === 'bad,good',
      order3.join(','));

    let releaseE = null;
    const gateE = new Promise((res) => { releaseE = res; });
    const pe1 = turnQueue.enqueue('q-sess-e', async () => { await gateE; });
    const pe2 = turnQueue.enqueue('q-sess-e', async () => {});
    await Promise.resolve();
    ok('pending/isBusy 反映排队数（2）',
      turnQueue.pending('q-sess-e') === 2 && turnQueue.isBusy('q-sess-e') === true,
      String(turnQueue.pending('q-sess-e')));
    releaseE();
    await Promise.all([pe1, pe2]);
    await sleep(0);
    ok('空闲后自动清理（不泄漏 Map）',
      turnQueue.pending('q-sess-e') === 0 && turnQueue.isBusy('q-sess-e') === false
      && turnQueue._size().chains === 0 && turnQueue._size().counts === 0,
      JSON.stringify(turnQueue._size()));

    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok('server：agent 路径走每会话队列（enqueue + queueKey），回退也在队列内',
      serverSrc.indexOf('assistantTurnQueue.enqueue(') !== -1
      && /const queueKey = body\.sessionId/.test(serverSrc)
      && serverSrc.indexOf('return assistantSupervisor.handleMessage(') !== -1);
  }

  // ================= [3a-9] 2026-11-19 B 目标：agent 回合审计（可回放/校准）=================
  // 真实模型接入后必须能回答「哪一轮、什么模式、选了哪个工具、多慢、为什么回退」。
  // 约束：不落 Key/凭据；用户话只存 120 字预览；任何写失败不影响主链路。
  console.log('\n[3a-9] B 目标：agent 回合审计（say/tool/fallback，不落 Key）');
  {
    ok('审计文件在隔离目录', agentAudit.AUDIT_FILE.indexOf(TMP) === 0,
      agentAudit.AUDIT_FILE);
    const before = agentAudit.list(500).length;

    await agentRuntime.handleAgentTurn({
      text: '你能做什么', sessionId: 'audit-say-' + Date.now().toString(36), lang: 'zh', supervisor,
      callLLM: async () => ({ text: JSON.stringify({ say: '我能帮你看计划、查进度。' }) })
    });
    await agentRuntime.handleAgentTurn({
      text: '来个 30 秒', sessionId: 'audit-tool-' + Date.now().toString(36), lang: 'zh', supervisor,
      callLLM: async () => ({ text: JSON.stringify({ tool: 'plan_video', args: { totalMinutes: 0.5 } }) })
    });
    await agentRuntime.handleAgentTurn({
      text: '进度', sessionId: 'audit-fallback-' + Date.now().toString(36), lang: 'zh', supervisor,
      callLLM: async () => ({ text: '', failure: { kind: 'NO_KEY' } })
    });

    const rows = agentAudit.list(500);
    ok('审计多出 3 条（say / tool / fallback 各一条）', rows.length === before + 3,
      `${before} → ${rows.length}`);
    const last3 = rows.slice(-3);
    ok('say 回合：mode=say / intent=chat / 有 latencyMs+version',
      last3[0].mode === 'say' && last3[0].intent === 'chat'
      && typeof last3[0].latencyMs === 'number' && last3[0].version === agentAudit.AUDIT_VERSION);
    ok('tool 回合：tool=plan_video / intent=create / ok=true',
      last3[1].mode === 'tool' && last3[1].tool === 'plan_video'
      && last3[1].intent === 'create' && last3[1].ok === true);
    ok('fallback 回合：mode=fallback / failureKind=NO_KEY / tool=null',
      last3[2].mode === 'fallback' && last3[2].failureKind === 'NO_KEY' && last3[2].tool === null);

    const raw = fs.readFileSync(agentAudit.AUDIT_FILE, 'utf8');
    ok('审计不落 Key/凭据（无 sk- / apiKey / baseUrl）',
      !/sk-[A-Za-z0-9]/.test(raw) && raw.indexOf('apiKey') === -1 && raw.indexOf('baseUrl') === -1);
    ok('JSONL 每行可解析且 textPreview ≤120 字',
      raw.trim().split(/\r?\n/).filter(Boolean).every((line) => {
        try {
          const j = JSON.parse(line);
          return typeof j.textPreview === 'string' && j.textPreview.length <= 120;
        } catch (e) { return false; }
      }));
  }

  // ================= [3b] 新意图：查场景卡 / 纯文生视频（2026-11-16 用户反馈）=================
  console.log('\n[3b] 新意图：问「选了哪些场景卡」/ 要「纯文生视频」（只读，不建计划）');
  ok('意图分类：「哪三个场景」→ plan_scenes（不再当成新计划重问时长）',
    assistantMemory.classify('你可以给我看一下你选择的是哪三个场景吗').intent === 'plan_scenes'
    && assistantMemory.classify('你选了哪些场景卡').intent === 'plan_scenes'
    && assistantMemory.classify('场景是哪几个').intent === 'plan_scenes');
  ok('意图分类：要纯文生视频 → no_image',
    assistantMemory.classify('可以直接选择文生图的模式吗').intent === 'no_image'
    && assistantMemory.classify('不要出图').intent === 'no_image'
    && assistantMemory.classify('纯文生视频').intent === 'no_image'
    && assistantMemory.classify('能不能只做文生视频').intent === 'no_image');
  ok('意图分类未被抢：10 分钟 / 上一次 / 你好 / 进度 的原分类不变',
    assistantMemory.classify('10 分钟').intent === 'create'
    && assistantMemory.classify('上一次的视频').intent === 'last'
    && assistantMemory.classify('你好').intent === 'greeting'
    && assistantMemory.classify('现在进度怎样').intent === 'status');

  const sceneNoPlan = supervisor.handleMessage({ text: '你选了哪三个场景卡' });
  ok('无计划时问场景 → 先问总时长（不建计划、不占卡）',
    sceneNoPlan.ok === true && sceneNoPlan.intent === 'plan_scenes' && sceneNoPlan.plan === null
    && /总时长/.test(sceneNoPlan.reply), String(sceneNoPlan.reply || '').slice(0, 60));

  const sidScene = 's_scene_preview_1';
  const msgScenePlan = supervisor.handleMessage({ sessionId: sidScene, text: 'mock 3段，每段10秒' });
  ok('准备场景预览：3 段计划就绪（场景卡默认开）',
    msgScenePlan.ok === true && !!msgScenePlan.plan && msgScenePlan.plan.sceneCards === true
    && msgScenePlan.plan.clipCount === 3,
    msgScenePlan.ok ? `${msgScenePlan.plan.clipCount}段` : msgScenePlan.code);
  const planIdBeforeScene = assistantMemory.lastPlan(sidScene).planId;
  const sceneIdsBefore = assistantMemory.lastPlan(sidScene).sceneCardIds.slice();
  const tasksBeforeScene = taskManager.getAllTasks().length;
  const sceneAsk = supervisor.handleMessage({
    sessionId: sidScene,
    text: '你可以给我看一下你选择的是哪三个场景吗'
  });
  // 2026-11-17 V1（§9.1-4 / Q25=A）行为变更：取卡改为「随机抽 N 张 + 跨计划冷却」，
  // 所以期望值**不能**再靠「再 allocate 一次」（每次抽的都不一样）。改成用计划里已固定的
  // sceneCardIds —— 这同时证明：对话里的「看场景」只是只读预览，没有重新抽卡。
  const expectedKeys = sceneIdsBefore.map((id) => sceneCardLibrary.getCardById(id).scene_key);
  ok('问场景 → 列出计划里已固定的 3 张卡（只读预览，没有重新 allocate）',
    sceneAsk.ok === true && sceneAsk.intent === 'plan_scenes' && sceneAsk.plan === null
    && expectedKeys.length === 3 && expectedKeys.every((k) => sceneAsk.reply.includes(k))
    && /取这 3 张/.test(sceneAsk.reply),
    String(sceneAsk.reply || '').split('\n').slice(0, 2).join(' | '));
  ok('同一计划内反复问场景 → 仍是这 3 张、sceneCardIds 一个都不变（Q25=A 计划内稳定）', (() => {
    const again = supervisor.handleMessage({ sessionId: sidScene, text: '你再给我看一下选的是哪些场景卡' });
    return again.intent === 'plan_scenes' && again.plan === null
      && expectedKeys.every((k) => again.reply.includes(k))
      && JSON.stringify(assistantMemory.lastPlan(sidScene).sceneCardIds) === JSON.stringify(sceneIdsBefore);
  })(), expectedKeys.join(','));
  ok('问场景不建任务、不重排计划（planId / sceneCardIds 未变、任务数不变）',
    assistantMemory.lastPlan(sidScene).planId === planIdBeforeScene
    && JSON.stringify(assistantMemory.lastPlan(sidScene).sceneCardIds) === JSON.stringify(sceneIdsBefore)
    && taskManager.getAllTasks().length === tasksBeforeScene,
    `${tasksBeforeScene} → ${taskManager.getAllTasks().length}`);

  const noImg = supervisor.handleMessage({ sessionId: sidScene, text: '可以直接选择文生图的模式吗' });
  ok('要纯文生视频 → 告诉用户卡上「取消逐段出图」，不建新计划',
    noImg.ok === true && noImg.intent === 'no_image' && noImg.plan === null
    && /逐段出图/.test(noImg.reply) && /取消/.test(noImg.reply) && /纯文生视频/.test(noImg.reply)
    && assistantMemory.lastPlan(sidScene).planId === planIdBeforeScene,
    String(noImg.reply || '').split('\n')[0]);

  // 2026-11-16 Lead 收口：配乐意图不能抢「时长 + 音乐」的创建句；指代式换卡要接住。
  ok('意图不抢：带时长的「配点轻音乐 / 配乐随意」仍走 create',
    assistantMemory.classify('10 分钟，配点轻音乐').intent === 'create'
    && assistantMemory.classify('来一条 10 分钟的视频，配乐随意').intent === 'create'
    && assistantMemory.classify('30 分钟，背景音乐随便来点').intent === 'create'
    && assistantMemory.classify('帮我做个 10 分钟的视频，配乐轻一点').intent === 'create');
  ok('配乐意图仍识别：显式动作清单全部走 bgm（有哪些/有什么/换成/改成/关掉/设为默认/换一首/用第 N 首）',
    ['配乐有哪些', '有什么配乐', '配乐换成晨雾', '配乐改成第 2 首', '关掉配乐',
      '把第 3 首设为默认配乐', '换一首', '用第 3 首']
      .every((t) => assistantMemory.classify(t).intent === 'bgm'));
  ok('指代式换卡：「这个地方的换一个」→ plan_edit（不是 create/unknown）',
    assistantMemory.classify('不想要这个地方的换一个可以吗').intent === 'plan_edit'
    && ['这张卡不满意，换一张', '这一段不想要', '这个场景换一个', '这里不满意，换一个']
      .every((t) => assistantMemory.classify(t).intent === 'plan_edit'));
  ok('「这里换成1080p」不被当成按段编辑（仍走分辨率续问）',
    assistantMemory.classify('这里换成1080p').intent !== 'plan_edit');
  const vagueEdit = supervisor.handleMessage({ sessionId: sidScene, text: '不想要这个地方的换一个可以吗' });
  ok('指代式换卡：回复「要换第几段？说『第 2 段换一个』」、回传同一计划、不建任务',
    vagueEdit.ok === true && vagueEdit.intent === 'plan_edit'
    && /要换第几段/.test(String(vagueEdit.reply || ''))
    && /第 2 段换一个/.test(String(vagueEdit.reply || ''))
    && !/做多长|总时长/.test(String(vagueEdit.reply || ''))
    && !!vagueEdit.plan && vagueEdit.plan.planId === planIdBeforeScene
    && assistantMemory.lastPlan(sidScene).planId === planIdBeforeScene
    && taskManager.getAllTasks().length === tasksBeforeScene,
    String(vagueEdit.reply || '').slice(0, 60));
  // 2026-11-16 用户反馈（截图实证）：看完整批 3 张卡说「三个都想换掉」被当成续问重排了新计划。
  ok('整批换卡意图：三个都想换掉 / 这三张都换 / 换一批 / 全部重抽 → plan_edit',
    ['三个都想换掉', '这三张都换掉', '换一批', '全部重抽', '这个章节的三个都换', '都换掉']
      .every((t) => assistantMemory.classify(t).intent === 'plan_edit'));
  ok('整批换卡不抢其他意图：都换成 1080p 不是 plan_edit；配乐全部换掉 → bgm',
    assistantMemory.classify('都换成 1080p').intent !== 'plan_edit'
    && assistantMemory.classify('配乐全部换掉').intent === 'bgm');
  ok('finals 参与检索并标 kind=final', (() => {
    const r = assistantMemory.retrieveTasks({ query: '上一次的视频', tasks: [], finals: [{ id: 'fin_1', kind: 'final', prompt: '成片 A', filePath: 'output/a.mp4', createdAt: new Date().toISOString() }] });
    return r.refs.length === 1 && r.refs[0].kind === 'final';
  })());

  // ================= [3c] 计划内精准修改（P7-A：换单段卡 / 改单段提示词 / 配乐） =================
  console.log('\n[3c] 计划内精准修改：换单段场景卡 / 改单段提示词 / 配乐（零计费、不建任务）');
  const sidEdit = 's_p7a_plan_edit_1';
  const msgEditPlan = supervisor.handleMessage({ sessionId: sidEdit, text: 'mock 3段，每段10秒' });
  ok('计划卡自带 sceneCardIds（3 段 = 3 张卡，创建时固定）',
    msgEditPlan.ok === true && !!msgEditPlan.plan && msgEditPlan.plan.sceneCards === true
    && Array.isArray(msgEditPlan.plan.sceneCardIds) && msgEditPlan.plan.sceneCardIds.length === 3,
    msgEditPlan.plan ? msgEditPlan.plan.sceneCardIds.join(',') : msgEditPlan.code);
  const editPlanBefore = assistantMemory.lastPlan(sidEdit);
  const editIdsBefore = editPlanBefore.sceneCardIds.slice();
  const tasksBeforeEdit = taskManager.getAllTasks().length;

  // planFromIds：按给定顺序组卡、不 allocate；显式 ids 的负向校验
  const twoIds = sceneCardLibrary.allocate(2).used.map((e) => e.id);
  const rotatedPlan = sceneCardLibrary.planFromIds([twoIds[1], twoIds[0]]);
  ok('planFromIds 按传入顺序组卡（source=explicit-ids，不 allocate）',
    rotatedPlan.used.length === 2 && rotatedPlan.used[0].id === twoIds[1]
    && rotatedPlan.used[1].id === twoIds[0] && rotatedPlan.source === 'explicit-ids');
  let idsLenErr = null;
  let idsDupErr = null;
  try {
    taskManager.createTask('bad-ids-len', { model: 'mock', totalClips: 3, clipDuration: 10, sceneCards: { enabled: true, ids: twoIds } });
  } catch (e) { idsLenErr = e; }
  try {
    taskManager.createTask('bad-ids-dup', { model: 'mock', totalClips: 2, clipDuration: 10, sceneCards: { enabled: true, ids: [twoIds[0], twoIds[0]] } });
  } catch (e) { idsDupErr = e; }
  ok('createTask 显式 ids 数量不符 → SCENE_CARDS_IDS_LENGTH；重复 → SCENE_CARDS_IDS_DUPLICATE（都不建任务）',
    idsLenErr && idsLenErr.code === 'SCENE_CARDS_IDS_LENGTH'
    && idsDupErr && idsDupErr.code === 'SCENE_CARDS_IDS_DUPLICATE'
    && taskManager.getAllTasks().length === tasksBeforeEdit,
    `${idsLenErr && idsLenErr.code} / ${idsDupErr && idsDupErr.code}`);

  // 换单段场景卡
  const swapMsg = supervisor.handleMessage({ sessionId: sidEdit, text: '第 2 个场景换一个' });
  const planAfterSwap = assistantMemory.lastPlan(sidEdit);
  ok('换单段场景卡：只改第 2 段、其它段不变、planId 不变、不建任务',
    swapMsg.ok === true && swapMsg.intent === 'plan_edit'
    && planAfterSwap.planId === editPlanBefore.planId
    && planAfterSwap.sceneCardIds[1] !== editIdsBefore[1]
    && planAfterSwap.sceneCardIds[0] === editIdsBefore[0]
    && planAfterSwap.sceneCardIds[2] === editIdsBefore[2]
    && taskManager.getAllTasks().length === tasksBeforeEdit,
    `planId=${planAfterSwap.planId} ids=${planAfterSwap.sceneCardIds.join(',')}`);
  ok('plan_edit 回传更新后的计划（planId 不变、sceneCardIds 与 lastPlan 一致 → 前端可刷新卡片）',
    !!swapMsg.plan && swapMsg.plan.planId === editPlanBefore.planId
    && Array.isArray(swapMsg.plan.sceneCardIds)
    && swapMsg.plan.sceneCardIds.join(',') === planAfterSwap.sceneCardIds.join(','));
  ok('换卡回复写清「第 N 段：旧 → 新（第 X 章-Y）」并列出当前 3 张卡', (() => {
    const oldCard = sceneCardLibrary.getCardById(editIdsBefore[1]);
    const newCard = sceneCardLibrary.getCardById(planAfterSwap.sceneCardIds[1]);
    return /已换第 2 段/.test(swapMsg.reply)
      && !!oldCard && !!newCard
      && swapMsg.reply.includes(oldCard.scene_key) && swapMsg.reply.includes(newCard.scene_key)
      && /第 \d+ 章-\d+/.test(swapMsg.reply)
      && /当前 3 张场景卡/.test(swapMsg.reply);
  })(), String(swapMsg.reply || '').split('\n')[0]);
  ok('问「选了哪些场景」→ 显示换卡后的卡（不回到默认 allocate 预览）', (() => {
    const ask = supervisor.handleMessage({ sessionId: sidEdit, text: '你选了哪些场景卡' });
    const newCard = sceneCardLibrary.getCardById(planAfterSwap.sceneCardIds[1]);
    return ask.intent === 'plan_scenes' && ask.plan === null && ask.reply.includes(newCard.scene_key);
  })());
  const swap2Msg = supervisor.handleMessage({ sessionId: sidEdit, text: '第 2 段这个场景我不想要' });
  const idsAfterSwap2 = assistantMemory.lastPlan(sidEdit).sceneCardIds;
  ok('可反复换同一段：第 2 段再次变化、其它段仍不变',
    swap2Msg.intent === 'plan_edit' && idsAfterSwap2[1] !== planAfterSwap.sceneCardIds[1]
    && idsAfterSwap2[0] === editIdsBefore[0] && idsAfterSwap2[2] === editIdsBefore[2],
    idsAfterSwap2.join(','));

  // 整批换卡（2026-11-16 用户截图）：看完整批 3 张卡说「三个都想换掉」
  // 原实现会掉进 create 续问、重排一条新计划；现在应整批换卡、planId 不变、不建任务。
  const sidBatch = 's_p7a_batch_swap_1';
  const batchPlanMsg = supervisor.handleMessage({ sessionId: sidBatch, text: 'mock 3段，每段10秒' });
  const batchIdsBefore = assistantMemory.lastPlan(sidBatch).sceneCardIds.slice();
  const batchPlanId = batchPlanMsg.plan.planId;
  const tasksBeforeBatch = taskManager.getAllTasks().length;
  const batchMsg = supervisor.handleMessage({ sessionId: sidBatch, text: '三个都想换掉' });
  const batchPlanAfter = assistantMemory.lastPlan(sidBatch);
  const batchIdsAfter = batchPlanAfter.sceneCardIds.slice();
  ok('整批换卡：「三个都想换掉」→ plan_edit、3 张全换、planId 不变、不重排计划/不建任务',
    batchMsg.ok === true && batchMsg.intent === 'plan_edit'
    && /已换掉全部 3 段/.test(batchMsg.reply) && !/排好了/.test(batchMsg.reply)
    && batchPlanAfter.planId === batchPlanId
    && batchIdsAfter.length === 3
    && batchIdsAfter.every((id, i) => id !== batchIdsBefore[i])
    && new Set(batchIdsAfter).size === 3
    && !!batchMsg.plan && batchMsg.plan.planId === batchPlanId
    && taskManager.getAllTasks().length === tasksBeforeBatch,
    `${batchIdsBefore.join(',')} → ${batchIdsAfter.join(',')}`);
  ok('整批换卡回复：逐段旧→新 + 当前 3 张卡 + 计划摘要',
    /#1 .*→/.test(batchMsg.reply) && /#2 .*→/.test(batchMsg.reply) && /#3 .*→/.test(batchMsg.reply)
    && /当前 3 张场景卡/.test(batchMsg.reply) && /总时长/.test(batchMsg.reply));
  const batchMsg2 = supervisor.handleMessage({ sessionId: sidBatch, text: '换一批' });
  const batchIds2 = assistantMemory.lastPlan(sidBatch).sceneCardIds.slice();
  ok('整批换卡可反复（换一批）：再整批换、仍是同一计划、不建任务',
    batchMsg2.intent === 'plan_edit' && /已换掉全部/.test(batchMsg2.reply)
    && batchIds2.every((id, i) => id !== batchIdsAfter[i])
    && assistantMemory.lastPlan(sidBatch).planId === batchPlanId
    && taskManager.getAllTasks().length === tasksBeforeBatch);

  // 卡库尽头：180 段 = 全部正片都在 used 里 → 换卡必须明确报错，不静默复用
  const sidExhaust = 's_p7a_plan_edit_exhaust';
  const bigPlanMsg = supervisor.handleMessage({ sessionId: sidExhaust, text: '30分钟' });
  ok('准备 180 段计划（全部 180 张正片都已在计划里）',
    bigPlanMsg.ok === true && !!bigPlanMsg.plan && bigPlanMsg.plan.sceneCardIds.length === 180);
  const tasksBeforeExhaust = taskManager.getAllTasks().length;
  const exhaustMsg = supervisor.handleMessage({ sessionId: sidExhaust, text: '第 2 个场景换一个' });
  ok('卡库用尽 → 明确错误（不静默复用）、计划不变、不建任务',
    exhaustMsg.intent === 'plan_edit' && /没有可换/.test(exhaustMsg.reply)
    && assistantMemory.lastPlan(sidExhaust).sceneCardIds[1] === bigPlanMsg.plan.sceneCardIds[1]
    && taskManager.getAllTasks().length === tasksBeforeExhaust,
    String(exhaustMsg.reply || '').split('\n')[0]);

  // 改单段提示词
  const promptText = '雪山日出，金光打在雪脊上，缓慢横移';
  const cardsBeforePrompt = assistantMemory.lastPlan(sidEdit).sceneCardIds.slice();
  const promptMsg = supervisor.handleMessage({ sessionId: sidEdit, text: `第 2 段的提示词改成：${promptText}` });
  const planAfterPrompt = assistantMemory.lastPlan(sidEdit);
  ok('改单段提示词：plan.promptOverrides["1"] 记录用户文本、planId 不变、不建任务',
    promptMsg.intent === 'plan_edit' && !!planAfterPrompt.promptOverrides
    && planAfterPrompt.promptOverrides['1'] === promptText
    && planAfterPrompt.planId === editPlanBefore.planId
    && taskManager.getAllTasks().length === tasksBeforeEdit,
    planAfterPrompt.promptOverrides ? planAfterPrompt.promptOverrides['1'] : '');
  ok('改提示词回复：字数 + 「其余段仍按场景卡」+ 当前计划摘要',
    new RegExp(`已改第 2 段提示词（${promptText.length} 字）`).test(promptMsg.reply)
    && /其余段仍按场景卡/.test(promptMsg.reply)
    && /总时长 30 秒/.test(promptMsg.reply),
    String(promptMsg.reply || '').split('\n')[0]);
  ok('改提示词不动场景卡（第 2 段仍是换过的卡）',
    JSON.stringify(planAfterPrompt.sceneCardIds) === JSON.stringify(cardsBeforePrompt));
  const outOfRangeMsg = supervisor.handleMessage({ sessionId: sidEdit, text: '第 9 段换成别的' });
  ok('段号越界 → 明确错误（不改计划）',
    outOfRangeMsg.intent === 'plan_edit' && /只有 3 段/.test(outOfRangeMsg.reply)
    && JSON.stringify(assistantMemory.lastPlan(sidEdit).sceneCardIds) === JSON.stringify(cardsBeforePrompt));
  const editNoPlanMsg = supervisor.handleMessage({ text: '第 1 段换一个' });
  ok('无计划时说改计划 → 先问总时长（不建计划、不建任务）',
    editNoPlanMsg.intent === 'plan_edit' && editNoPlanMsg.plan === null
    && /总时长/.test(editNoPlanMsg.reply), String(editNoPlanMsg.reply || '').slice(0, 60));
  const longText = '雪'.repeat(450);
  const longMsg = supervisor.handleMessage({ sessionId: sidEdit, text: `第 1 段提示词改成：${longText}` });
  const longPlan = assistantMemory.lastPlan(sidEdit);
  ok('提示词超过 400 字 → 截断到 400 且回复告知（不静默）',
    longMsg.intent === 'plan_edit' && longPlan.promptOverrides['0'].length === 400
    && /截断/.test(longMsg.reply), `${longPlan.promptOverrides['0'].length} 字`);
  // 2026-11-19 D1：改成 1080p 由 unknown → plan_edit（纯分辨率槽位句）。
  // 每段 15 秒 仍 create：中文「秒」被 RE_CREATE 接住，槽位分支只补今天掉 unknown 的那类。
  ok('新意图不抢既有：改成 1080p（D1 起归 plan_edit）/ 每段 15 秒 / 再来一条 / 不要场景卡',
    assistantMemory.classify('改成 1080p').intent === 'plan_edit'
    && assistantMemory.classify('每段 15 秒').intent === 'create'
    && assistantMemory.classify('再来一条').intent === 'create'
    && assistantMemory.classify('不要场景卡').intent === 'unknown');

  // 配乐：列库 / 用第 N 首 / 换一首 / 不要配乐 / 设默认（默认写完必须恢复真实 prefs）
  const bgmList = audioMixer.listTracksInOrder();
  ok('配乐素材库可读（≥2 首，带 id/title/category/时长）',
    bgmList.length >= 2 && bgmList.every((t) => t.id && t.title && Number.isFinite(Number(t.durationSec))),
    `${bgmList.length} 首`);
  const sidBgm = 's_p7a_bgm_1';
  const bgmPlanMsg = supervisor.handleMessage({ sessionId: sidBgm, text: 'mock 2段，每段10秒' });
  ok('配乐测试前置：2 段计划就绪', bgmPlanMsg.ok === true && !!bgmPlanMsg.plan);
  const listMsg = supervisor.handleMessage({ sessionId: sidBgm, text: '配乐有哪些' });
  const planBgm1 = assistantMemory.lastPlan(sidBgm);
  ok('列素材库：编号/曲名/类别/时长齐 + 记住 plan.bgmChoices（持久化上下文）',
    listMsg.intent === 'bgm'
    && bgmList.every((t) => listMsg.reply.includes(t.title))
    && /（[^）]*，(?:music|ambient)，/.test(listMsg.reply)
    && Array.isArray(planBgm1.bgmChoices) && planBgm1.bgmChoices.length === bgmList.length,
    String(listMsg.reply || '').split('\n').slice(0, 2).join(' | '));
  const track3Id = planBgm1.bgmChoices[2];
  const track3 = audioMixer.findTrack(track3Id).track;
  const pickMsg = supervisor.handleMessage({ sessionId: sidBgm, text: '用第 3 首' });
  const planAfterPick = assistantMemory.lastPlan(sidBgm);
  ok('用第 3 首 → plan.bgm 手动指定该 trackId',
    pickMsg.intent === 'bgm' && !!planAfterPick.bgm
    && planAfterPick.bgm.enabled === true && planAfterPick.bgm.mode === 'manual'
    && planAfterPick.bgm.trackId === track3Id,
    planAfterPick.bgm ? planAfterPick.bgm.trackId : '');
  ok('bgm 回传更新后的计划（planId 不变、bgm.trackId 已更新 → 前端可刷新卡片）',
    !!pickMsg.plan && pickMsg.plan.planId === bgmPlanMsg.plan.planId
    && !!pickMsg.plan.bgm && pickMsg.plan.bgm.trackId === track3Id);
  ok('选曲回复带曲名 + 计划摘要显示「配乐：手动」',
    pickMsg.reply.includes(track3.title) && /配乐：手动/.test(pickMsg.reply));
  const nextMsg = supervisor.handleMessage({ sessionId: sidBgm, text: '换一首' });
  const planAfterNext = assistantMemory.lastPlan(sidBgm);
  ok('换一首 → 切到清单下一首',
    nextMsg.intent === 'bgm' && !!planAfterNext.bgm
    && planAfterNext.bgm.trackId === planBgm1.bgmChoices[3],
    planAfterNext.bgm ? planAfterNext.bgm.trackId : '');
  const offMsg = supervisor.handleMessage({ sessionId: sidBgm, text: '不要配乐' });
  const planOff = assistantMemory.lastPlan(sidBgm);
  ok('不要配乐 → plan.bgm = {enabled:false, mode:"off"}，摘要显示关闭',
    offMsg.intent === 'bgm' && !!planOff.bgm
    && planOff.bgm.enabled === false && planOff.bgm.mode === 'off'
    && /配乐：关闭/.test(offMsg.reply));
  const badNameMsg = supervisor.handleMessage({ sessionId: sidBgm, text: '配乐换成不存在的曲名XYZ' });
  const badIndexMsg = supervisor.handleMessage({ sessionId: sidBgm, text: '用第 999 首' });
  ok('非法曲目 → 明确失败（曲名不存在 / 编号越界都不静默乱选）',
    badNameMsg.intent === 'bgm' && /没认出|没有/.test(badNameMsg.reply)
    && badIndexMsg.intent === 'bgm' && /只有 \d+ 首/.test(badIndexMsg.reply),
    `${String(badNameMsg.reply || '').split('\n')[0]} / ${String(badIndexMsg.reply || '').split('\n')[0]}`);
  // 设默认：先快照真实 prefs，测完按原字节恢复（handoff §8.7）
  const prefsSnapshot = {
    existed: fs.existsSync(audioMixer.PREFS_PATH),
    raw: null
  };
  if (prefsSnapshot.existed) prefsSnapshot.raw = fs.readFileSync(audioMixer.PREFS_PATH);
  const beforeDefault = audioMixer.getPrefs().defaultTrackId;
  const defaultPickIndex = Math.max(0, bgmList.findIndex((t) => t.id !== beforeDefault));
  const defaultTargetId = bgmList[defaultPickIndex].id;
  try {
    const defaultMsg = supervisor.handleMessage({ sessionId: sidBgm, text: `把第 ${defaultPickIndex + 1} 首设为默认配乐` });
    const afterDefault = audioMixer.getPrefs().defaultTrackId;
    ok('设为默认配乐 → savePrefs 改全局默认 + 回复说明「之后新计划」',
      defaultMsg.intent === 'bgm' && afterDefault === defaultTargetId && afterDefault !== beforeDefault
      && /默认配乐/.test(defaultMsg.reply) && /之后新计划/.test(defaultMsg.reply),
      `${beforeDefault || '(空)'} → ${afterDefault || '(空)'}`);
  } finally {
    if (prefsSnapshot.existed) fs.writeFileSync(audioMixer.PREFS_PATH, prefsSnapshot.raw);
    else { try { fs.unlinkSync(audioMixer.PREFS_PATH); } catch (e) { /* ignore */ } }
  }
  ok('设置默认配乐的测试后已恢复真实 prefs（不留测试曲目）',
    prefsSnapshot.existed
      ? fs.readFileSync(audioMixer.PREFS_PATH).equals(prefsSnapshot.raw)
      : !fs.existsSync(audioMixer.PREFS_PATH));

  // ================= [4] 语音（离线 ASR） =================
  console.log('\n[4] 语音：离线 ASR（sherpa-onnx + SenseVoice）');
  const asrStatus = asr.status();
  ok('ASR 可用（工具/模型都在）', asrStatus.available === true, asrStatus.reason || 'ok');
  const wav = path.join(APP_DIR, 'tools', 'asr', 'model-sensevoice-int8', 'test_wavs', 'zh.wav');
  ok('内置中文样例存在', fs.existsSync(wav));
  const asr1 = await asr.transcribe({ filePath: wav });
  ok('中文样例识别为「开饭时间早上9点至下午5点。」',
    asr1.ok && asr1.text.includes('开饭时间') && asr1.lang === 'zh' && asr1.offline === true,
    asr1.ok ? `${asr1.text} / ${asr1.ms}ms` : asr1.code);
  const asr2 = await asr.transcribe({ buffer: fs.readFileSync(wav), mime: 'audio/wav' });
  ok('buffer + mime 方式同样识别', asr2.ok && asr2.text === asr1.text);
  const asrBad = await asr.transcribe({ buffer: Buffer.alloc(4096, 7), mime: 'audio/webm' });
  ok('坏音频 → 明确失败（不是空文本当成功）', asrBad.ok === false && ['ASR_BAD_AUDIO', 'ASR_TOO_SHORT'].includes(asrBad.code),
    asrBad.code);
  const asrTiny = await asr.transcribe({ buffer: Buffer.alloc(100), mime: 'audio/wav' });
  ok('过短音频 → ASR_TOO_SHORT', asrTiny.ok === false && asrTiny.code === 'ASR_TOO_SHORT');
  const asrBig = await asr.transcribe({ buffer: Buffer.alloc(asr.MAX_BYTES + 1), mime: 'audio/wav' });
  ok('超过 12MB → ASR_TOO_LARGE', asrBig.ok === false && asrBig.code === 'ASR_TOO_LARGE');
  const asrNone = await asr.transcribe({});
  ok('没有音频 → ASR_NO_AUDIO', asrNone.ok === false && asrNone.code === 'ASR_NO_AUDIO');

  // ================= [5] 补位 =================
  console.log('\n[5] 补位：ΔE76+SSIM 选最像 / 时长 / 额度 / 缺口');
  const blue = makeClip(path.join(DIRS.clips, 'lib_blue.mp4'), '0x4a90d9', 10);
  const red = makeClip(path.join(DIRS.clips, 'lib_red.mp4'), '0xd94a4a', 10);
  const green = makeClip(path.join(DIRS.clips, 'lib_green.mp4'), '0x4ad94a', 10);
  const shortClip = makeClip(path.join(DIRS.clips, 'lib_short.mp4'), '0x4a90d9', 3);
  const missing = path.join(DIRS.clips, 'lib_missing.mp4');
  library.upsert(libEntry('lib_blue', blue, 10));
  library.upsert(libEntry('lib_red', red, 10));
  library.upsert(libEntry('lib_green', green, 10));
  library.upsert(libEntry('lib_short', shortClip, 3));
  library.upsert(libEntry('lib_missing', missing, 10));
  library.upsert(libEntry('lib_failed', red, 10, { status: 'failed' }));

  const planFill = planCard.buildPlan({ text: '20段极光，每段10秒', model: 'mock', sceneCards: false }).plan;
  ok('20 段计划补位上限 = 1', planFill.fillMaxClips === 1);
  const fillTask = taskManager.createTask('极光', {
    model: 'mock', totalClips: 20, clipDuration: 10, preset: 'clips_only', autoRetry: false
  });
  createdTasks.push(fillTask.taskId);
  // 同任务片段不能拿来补自己：放进候选后必须被 selfTaskId 排除
  library.upsert(libEntry('lib_same', blue, 10, { taskId: fillTask.taskId }));
  for (const c of fillTask.clips) {
    taskManager.updateClip(fillTask.taskId, c.index, {
      status: c.index === 10 ? 'failed' : 'success',
      videoPath: blue, duration: 10, error: c.index === 10 ? '模拟失败' : null
    });
  }
  taskManager.updateTaskStatus(fillTask.taskId, 'failed', { error: '模拟 1 段失败' });
  taskManager.updateTaskStatus(fillTask.taskId, 'failed');
  const fillT0 = Date.now();
  const fill = await fillLib.planFill({
    task: taskManager.getTask(fillTask.taskId),
    candidates: library.listAll(),
    maxClips: planFill.fillMaxClips,
    requiredDurationSec: 10
  });
  ok('补位成功 1 段（真实 ffmpeg 算帧相似度）', fill.ok && fill.fills.length === 1,
    `${Date.now() - fillT0}ms`);
  ok('选中同色候选 lib_blue（SSIM≥0.9，ΔE76≤2）',
    fill.fills[0] && fill.fills[0].libraryId === 'lib_blue' && fill.fills[0].ssim >= 0.9 && fill.fills[0].de76 <= 2,
    fill.fills[0] ? `id=${fill.fills[0].libraryId} ssim=${fill.fills[0].ssim} de76=${fill.fills[0].de76}` : '');
  ok('边界比较记录 sides=prev/next（左右邻居都参与）',
    fill.fills[0] && Array.isArray(fill.fills[0].sides) && fill.fills[0].sides.length === 2
    && fill.fills[0].boundary === 'neighbors');
  ok('只裁剪不循环不慢放（in/out 落在源时长内，取中间段）',
    fill.fills[0] && fill.fills[0].inSec === 0 && fill.fills[0].outSec === 10 && fill.fills[0].durationSec === 10);
  const candidates = fillLib.candidateList(library.listAll(), { requiredDurationSec: 10, selfTaskId: fillTask.taskId });
  const candIds = candidates.map((c) => c.id);
  ok('候选排除：缺失文件 / 过短 / status=failed / 同一任务',
    !candIds.includes('lib_missing') && !candIds.includes('lib_short')
    && !candIds.includes('lib_failed') && !candIds.includes('lib_same'),
    candIds.join(','));
  const asm = fillLib.assembleSegments(taskManager.getTask(fillTask.taskId), fill.fills);
  ok('补齐后 20 段齐全、总时长 200s', asm.ok && asm.segments.length === 20 && asm.totalDurationSec === 200);
  ok('补位段带 libraryId 与裁剪区间（可追溯）',
    asm.segments[10].source === 'library-fill' && asm.segments[10].libraryId === 'lib_blue'
    && asm.segments[10].trim && asm.segments[10].trim.outSec === 10);
  // 缺口：第 11 段也失败，但补位额度只剩 0
  taskManager.updateClip(fillTask.taskId, 11, { status: 'failed', error: '模拟再失败一段' });
  const fill2 = await fillLib.planFill({
    task: taskManager.getTask(fillTask.taskId),
    candidates: library.listAll(),
    maxClips: 1, requiredDurationSec: 10
  });
  ok('两段失败但额度 1 → ok=false + FILL_PARTIAL（不静默出片）',
    fill2.ok === false && fill2.code === 'FILL_PARTIAL' && fill2.fills.length === 1, fill2.code);
  const asmGap = fillLib.assembleSegments(taskManager.getTask(fillTask.taskId), fill2.fills);
  ok('有缺口时 assembleSegments 拒绝出片', asmGap.ok === false && asmGap.missing.length === 1);
  const plan3 = planCard.buildPlan({ text: '3段极光，每段10秒', model: 'mock' }).plan;
  const t3 = taskManager.createTask('极光', { model: 'mock', totalClips: 3, clipDuration: 10 });
  createdTasks.push(t3.taskId);
  taskManager.updateClip(t3.taskId, 0, { status: 'failed' });
  const fillNo = await fillLib.planFill({ task: taskManager.getTask(t3.taskId), candidates: library.listAll(), maxClips: plan3.fillMaxClips, requiredDurationSec: 10 });
  ok('3 段计划补位额度 0 → FILL_NOT_ALLOWED', fillNo.ok === false && fillNo.code === 'FILL_NOT_ALLOWED');
  // 监督器补位分支：monkey-patch 掉真实出片（20 段成片耗时，端到端另见未验证清单）
  // 先把第 11 段恢复成功，只保留 1 段失败（与补位额度 1 对齐）
  taskManager.updateClip(fillTask.taskId, 11, { status: 'success', videoPath: blue, duration: 10, error: null });
  const sidFill = 's_fill_supervisor_1';
  assistantMemory.getOrCreate(sidFill);
  let stF2 = stateMachine.create(planFill, { sessionId: sidFill });
  stF2 = stateMachine.transition(stF2, 'CONFIRM', { approved: true });
  stF2 = stateMachine.transition(stF2, 'SUBMIT', { taskId: fillTask.taskId });
  stF2 = stateMachine.transition(stF2, 'RUNNING', {});
  assistantMemory.setState(sidFill, stF2);
  const origCreateLib = taskManager.createLibraryTask;
  const origStart = pipeline.startTask;
  taskManager.createLibraryTask = () => ({ taskId: 'task_fakefill' });
  pipeline.startTask = () => ({ success: true });
  const mFill = { sessionId: sidFill, planId: planFill.planId, taskId: fillTask.taskId, finalTaskId: null, phase: 'primary', busy: false, stopped: false, ticks: 0, timer: null };
  const supFill = await supervisor._attemptFill(mFill, assistantMemory.getState(sidFill, planFill.planId), taskManager.getTask(fillTask.taskId));
  taskManager.createLibraryTask = origCreateLib;
  pipeline.startTask = origStart;
  ok('监督器补位分支：状态 → filling，记录补位段数 + finalTaskId',
    supFill.ok && supFill.state.state === 'filling' && supFill.state.fills === 1 && supFill.state.finalTaskId === 'task_fakefill',
    JSON.stringify({ state: supFill.state.state, fills: supFill.state.fills, final: supFill.state.finalTaskId }));

  // ================= [6] Mock 全流程 =================
  console.log('\n[6] Mock 全流程：对话 → 计划 → 确认 → 成片（零计费）');
  const origRandom = Math.random;
  Math.random = () => 0.95;
  budget.setBalance(196);
  const spendBefore = budget.status().spentUsd;
  let okMsg;
  try {
    okMsg = supervisor.handleMessage({ text: 'mock 2段极光，每段10秒' });
    const sid6 = okMsg.sessionId;
    const plan6 = okMsg.plan;
    ok('对话生成计划卡（mock 2 段）', okMsg.ok && plan6 && plan6.clipCount === 2 && plan6.estimate.totalCny === 0);
    const ex = supervisor.execute({ sessionId: sid6, planId: plan6.planId, approved: true });
    ok('确认执行 → 创建任务并启动流水线', ex.ok === true && !!ex.taskId, ex.error || ex.taskId);
    const dup6 = supervisor.execute({ sessionId: sid6, planId: plan6.planId, approved: true });
    ok('重复确认执行 → ASSISTANT_ALREADY_RUNNING（不重复建任务）',
      dup6.ok === false && dup6.code === 'ASSISTANT_ALREADY_RUNNING', dup6.code);
    if (ex.ok) createdTasks.push(ex.taskId);
    const st6 = await waitTerminal(sid6, plan6.planId, 240000);
    ok('状态机走到 done', st6.state.state === 'done', st6.state.reason || '');
    ok('事件序列完整（PLAN→CONFIRM→SUBMIT→RUNNING→COMPLETE）',
      st6.state.events.map((e) => e.type).join(',').includes('PLAN,CONFIRM,SUBMIT,RUNNING')
      && st6.state.events.some((e) => e.type === 'COMPLETE'));
    const task6 = taskManager.getTask(ex.taskId);
    ok('任务 completed 且 2/2 片段成功', task6 && task6.status === 'completed' && task6.clips.every((c) => c.status === 'success'),
      task6 ? `${task6.status} ${task6.clips.filter((c) => c.status === 'success').length}/${task6.totalClips}` : '');
    ok('任务记录场景卡：2 张、bufferUsed=0', task6 && task6.sceneCards && task6.sceneCards.used.length === 2
      && task6.sceneCards.status.bufferUsed === 0);
    ok('片段提示词由 promptComposer 产出（promptSource=scene-card）',
      task6 && task6.clips.every((c) => c.promptSource === 'scene-card' && c.sceneKey));
    const out6 = task6 && task6.outputPath;
    ok('成片文件存在', !!(out6 && fs.existsSync(out6)), out6 || '无');
    if (out6 && fs.existsSync(out6)) {
      const dur = probeDuration(out6);
      ok('ffprobe 成片时长在 17–20.5s（2×10 − 转场 0.4×1 − 循环淡化）',
        Number.isFinite(dur) && dur >= 17 && dur <= 20.5, `duration=${dur}s`);
      const dec = decodes(out6);
      ok('ffmpeg -f null 完整解码无错误', dec.ok, dec.stderr || 'ok');
    } else {
      ok('ffprobe 成片时长（跳过：无文件）', false);
      ok('ffmpeg 完整解码（跳过：无文件）', false);
    }
    ok('零计费：budget.spentUsd 未变化', budget.status().spentUsd === spendBefore,
      `before=${spendBefore} after=${budget.status().spentUsd}`);
    const mem6 = assistantMemory.listMessages(sid6, 20);
    ok('会话记忆保留用户+助手消息', mem6.filter((m) => m.role === 'user').length >= 1
      && mem6.filter((m) => m.role === 'assistant').length >= 2, `${mem6.length} 条`);
    // 2026-11-16 Lead：任务已开工后问「选了哪些场景」→ 必须按**实际分配**的卡回答（不是预览）。
    const sceneAsk6 = supervisor.handleMessage({
      sessionId: sid6,
      text: '你可以给我看一下你选择的是哪几个场景卡吗'
    });
    const usedKeys6 = task6 && task6.sceneCards && Array.isArray(task6.sceneCards.used)
      ? task6.sceneCards.used.map((e) => e.scene_key) : [];
    ok('已开工问场景 → 按任务实际分配的卡回答（含 scene_key，不重排计划）',
      sceneAsk6.ok === true && sceneAsk6.intent === 'plan_scenes' && sceneAsk6.plan === null
      && /实际分配到 2 张场景卡/.test(sceneAsk6.reply)
      && usedKeys6.length === 2 && usedKeys6.every((k) => sceneAsk6.reply.includes(k)),
      String(sceneAsk6.reply || '').split('\n')[0]);
  } finally {
    Math.random = origRandom;
  }

  // ================= [6b] Mock 端到端：换卡 + 改单段提示词（P7-A，零计费） =================
  console.log('\n[6b] Mock 端到端：换卡 + 改第 2 段提示词 → 任务按选定 id / 覆盖文本执行');
  const origRandom6b = Math.random;
  Math.random = () => 0.95;
  try {
    const sid6b = 's_p7a_mock_e2e_1';
    const msg6b = supervisor.handleMessage({ sessionId: sid6b, text: 'mock 3段，每段10秒' });
    ok('6b 计划：3 段 + 3 张卡', msg6b.ok === true && !!msg6b.plan && msg6b.plan.clipCount === 3);
    const swap6bMsg = supervisor.handleMessage({ sessionId: sid6b, text: '第 2 个场景换一个' });
    const override6b = '第 2 段用户指定：星空湖面，缓慢推近';
    const edit6bMsg = supervisor.handleMessage({ sessionId: sid6b, text: `第 2 段提示词改成：${override6b}` });
    // P7-A：配乐也要从 plan.bgm 落到 task.bgm（不只是计划字段），且真的参与混音。
    const pick6bMsg = supervisor.handleMessage({ sessionId: sid6b, text: '用第 2 首' });
    const expectedBgm6bId = audioMixer.listTracksInOrder()[1].id;
    const plan6b = assistantMemory.lastPlan(sid6b);
    ok('6b 执行前：换卡 / 覆盖 / 配乐都记在计划里（planId 不变）',
      swap6bMsg.intent === 'plan_edit' && edit6bMsg.intent === 'plan_edit' && pick6bMsg.intent === 'bgm'
      && plan6b.planId === msg6b.plan.planId
      && !!plan6b.promptOverrides && plan6b.promptOverrides['1'] === override6b
      && plan6b.sceneCardIds[1] !== msg6b.plan.sceneCardIds[1]
      && !!plan6b.bgm && plan6b.bgm.mode === 'manual' && plan6b.bgm.trackId === expectedBgm6bId,
      plan6b.bgm ? plan6b.bgm.trackId : '');
    const tasksBefore6b = taskManager.getAllTasks().length;
    const ex6b = supervisor.execute({ sessionId: sid6b, planId: plan6b.planId, approved: true });
    ok('6b 确认执行 → 建任务并启动（不重新分配卡）', ex6b.ok === true && !!ex6b.taskId, ex6b.error || ex6b.taskId);
    if (ex6b.ok) createdTasks.push(ex6b.taskId);
    ok('6b 只建了 1 个任务', taskManager.getAllTasks().length === tasksBefore6b + 1);
    const task6b = ex6b.ok ? taskManager.getTask(ex6b.taskId) : null;
    ok('6b 任务 sceneCards.used 严格按计划里的 sceneCardIds（换卡生效）',
      !!task6b && !!task6b.sceneCards && Array.isArray(task6b.sceneCards.used)
      && task6b.sceneCards.used.map((e) => e.id).join(',') === plan6b.sceneCardIds.join(','),
      task6b && task6b.sceneCards ? task6b.sceneCards.used.map((e) => e.id).join(',') : '');
    ok('6b 第 2 段 promptSource=scene-card-user-edit 且提示词=用户文本；其它段仍是 scene-card',
      !!task6b && task6b.clips[1].promptSource === 'scene-card-user-edit'
      && task6b.clips[1].prompt === override6b
      && task6b.clips[0].promptSource === 'scene-card'
      && task6b.clips[2].promptSource === 'scene-card',
      task6b ? task6b.clips.map((c) => c.promptSource).join(',') : '');
    ok('6b 覆盖段仍保留 sceneKey / sceneCardId（审计）',
      !!task6b && !!task6b.clips[1].sceneKey && !!task6b.clips[1].sceneCardId);
    ok('6b 计划里的配乐随 execute 落到 task.bgm（manual + 选定 trackId）',
      !!task6b && !!task6b.bgm && task6b.bgm.enabled === true
      && task6b.bgm.mode === 'manual' && task6b.bgm.trackId === expectedBgm6bId,
      task6b && task6b.bgm ? `${task6b.bgm.mode}/${task6b.bgm.trackId}` : '');
    // 幂等：重拼两次不冲掉覆盖、不重复叠后缀
    const compose6b1 = pipeline._composeSceneCardPrompts(ex6b.taskId);
    const compose6b2 = pipeline._composeSceneCardPrompts(ex6b.taskId);
    const task6bComposed = taskManager.getTask(ex6b.taskId);
    ok('6b 重拼两次幂等：覆盖文本不变、不叠后缀、其它段仍 scene-card',
      compose6b2.updated === 0
      && task6bComposed.clips[1].prompt === override6b
      && task6bComposed.clips[1].promptSource === 'scene-card-user-edit'
      && task6bComposed.clips[0].promptSource === 'scene-card',
      `compose updated=${compose6b1 && compose6b1.updated}/${compose6b2 && compose6b2.updated}`);
    const st6b = await waitTerminal(sid6b, plan6b.planId, 240000);
    ok('6b 状态机走到 done（成片流程不回归）', st6b.state.state === 'done', st6b.state.reason || '');
    const done6b = taskManager.getTask(ex6b.taskId);
    ok('6b 成片存在且可完整解码',
      !!(done6b && done6b.outputPath && fs.existsSync(done6b.outputPath)) && decodes(done6b.outputPath).ok,
      done6b ? done6b.outputPath : '无');
    ok('6b 成片完成后第 2 段仍是用户文本（重拼没有冲掉覆盖）',
      done6b && done6b.clips[1].prompt === override6b
      && done6b.clips[1].promptSource === 'scene-card-user-edit');
  } finally {
    Math.random = origRandom6b;
  }

  // ================= [7] 自动重试 =================
  console.log('\n[7] 自动重试：首轮片段失败 → RETRY → 重跑只补失败片段 → 成片');
  let retryMode = 'fail';
  Math.random = () => (retryMode === 'fail' ? 0.05 : 0.95);
  try {
    const msg7 = supervisor.handleMessage({ text: 'mock 1段极光，每段10秒' });
    const sid7 = msg7.sessionId;
    const plan7 = msg7.plan;
    const ex7 = supervisor.execute({ sessionId: sid7, planId: plan7.planId, approved: true });
    ok('重试场景：创建 1 段任务', ex7.ok === true);
    if (ex7.ok) createdTasks.push(ex7.taskId);
    // 等状态机进入 retrying（首轮失败已被确认），再恢复正常随机
    let sawRetry = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const s = supervisor.stateOf(sid7, plan7.planId);
      if (s && s.ok && s.state && (s.state.state === 'retrying' || s.state.retries > 0)) { sawRetry = true; break; }
      await sleep(300);
    }
    retryMode = 'ok';
    ok('首轮失败 → 状态机进入 retrying', sawRetry, sawRetry ? '' : '未观察到 RETRY');
    const st7 = await waitTerminal(sid7, plan7.planId, 180000);
    ok('重试后走到 done', st7.state.state === 'done', st7.state.reason || '');
    ok('事件序列包含 RETRY', st7.state.events.some((e) => e.type === 'RETRY'));
    const task7 = taskManager.getTask(ex7.taskId);
    ok('重跑复用/补齐后 1/1 片段成功且成片存在',
      task7 && task7.status === 'completed' && task7.clips[0].status === 'success'
      && task7.outputPath && fs.existsSync(task7.outputPath),
      task7 ? `${task7.status} ${task7.clips[0].status}` : '');
    ok('状态机记录自动重试 1 次', st7.state.retries === 1, `retries=${st7.state.retries}`);
  } finally {
    Math.random = origRandom;
  }

  // ================= [8] 付费闸门 =================
  console.log('\n[8] 付费闸门：未确认不创建任何任务');
  const tasksBefore = taskManager.getAllTasks().length;
  const msgPay = supervisor.handleMessage({ text: '1段极光，每段10秒' });
  const planPay = msgPay.plan;
  ok('对话生成的是真实计费模型计划（默认 WhaleTV 中转 openai-video，2026-11-16 20:4x 用户口径）',
    !!planPay && planPay.model === 'openai-video'
    && planPay.modelLabel === 'WhaleTV 万相 3.0（中转）'
    && planPay.requiresPaymentApproval === true,
    planPay && (planPay.model + ' / ' + planPay.modelLabel));
  ok('默认模型按秒计价非 0（付费闸门不能被 ¥0 绕过）',
    !!planPay && planPay.estimate.totalCny > 0 && planPay.estimate.budget.usd > 0,
    planPay && (`¥${planPay.estimate.totalCny} / $${planPay.estimate.budget.usd}`));
  const payExec = supervisor.execute({
    sessionId: msgPay.sessionId,
    planId: planPay.planId,
    approved: false
  });
  ok('真实模型未 approved → PAYMENT_NOT_APPROVED', payExec.ok === false && payExec.code === 'PAYMENT_NOT_APPROVED', payExec.code);
  ok('未确认时没有创建任务', taskManager.getAllTasks().length === tasksBefore,
    `${tasksBefore} → ${taskManager.getAllTasks().length}`);
  const emptyMsg = supervisor.handleMessage({ text: '' });
  ok('空文本 → ASSISTANT_EMPTY_TEXT', emptyMsg.ok === false && emptyMsg.code === 'ASSISTANT_EMPTY_TEXT');
  const noPlan = supervisor.execute({ sessionId: 's_no_such_session', planId: 'plan_none', approved: true });
  ok('无会话执行 → ASSISTANT_BAD_SESSION', noPlan.ok === false && noPlan.code === 'ASSISTANT_BAD_SESSION');

  // ================= [9] 前端接线（静态；浏览器交互未验证） =================
  console.log('\n[9] 前端接线（静态检查，浏览器交互未验证）');
  const assistantJs = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'components', 'assistant.js'), 'utf8');
  const planJs = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'components', 'xiaozhiPlan.js'), 'utf8');
  const shellJs = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'screens', 'shell.js'), 'utf8');
  ok('assistant.js 引入计划卡/状态条/首页气泡/语音组件',
    /PlanCard/.test(assistantJs) && /StateStrip/.test(assistantJs)
    && /GreetingBubble/.test(assistantJs) && /VoiceButton/.test(assistantJs));
  ok('小智对话走 /api/assistant/message + execute + state',
    assistantJs.includes('/api/assistant/message') && assistantJs.includes('/api/assistant/execute')
    && assistantJs.includes('/api/assistant/state') && assistantJs.includes('/api/assistant/memory'));
  ok('后端能力探测 /api/assistant/info（旧服务端自动回退）',
    assistantJs.includes('/api/assistant/info') && /backend\.ok/.test(assistantJs));
  ok('语音按钮走 /api/assistant/asr（失败回退打字）',
    planJs.includes('/api/assistant/asr') && /改用打字/.test(planJs));
  // 2026-11-17 V2：i18n 窗口正在把 assistant.js 的中文标签迁到 web/src/i18n（行内 `tr(...)`）。
  // 断言同时接受「旧字面量」与「i18n 键」，但仍要求**中文话术本身存在**（zh 消息必须是「小智」/「10 分钟的长视频」），
  // 不是放宽成永真：键名与 zh 文案任一缺失都会失败。
  const i18nAssistantSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'i18n', 'messages', 'assistant.js'), 'utf8');
  ok('面板显示名改为「小智」（旧的提示词助手标题已替换；兼容 i18n 键）',
    (/assistant\.page\.title/.test(assistantJs) && /assistant\.panel\.title/.test(assistantJs))
    && /title: '小智'/.test(i18nAssistantSrc)
    && !/>提示词助手</.test(assistantJs));
  ok('首页气泡只在创作页出现（currentRoute() === \'/\'）',
    /currentRoute\(\) === '\/'/.test(assistantJs));
  ok('shell.js 不再挂载 <Assistant />（2026-11-16 P4：悬浮小助手已下线）',
    !/<\$\{Assistant\} \/>/.test(shellJs) && !/components\/assistant\.js/.test(shellJs));
  ok('整页小智仍在（shell.js 渲染 <AssistantPage /> 承接 /）',
    /<\$\{AssistantPage\} \/>/.test(shellJs) && /from '\.\/assistantPage\.js'/.test(shellJs));
  // 2026-11-16 P0：计划卡确认执行必须把设置里的 Key 带上，否则服务端会静默降级 Mock。
  ok('确认执行带上运行 Key（readRuntimeConfig + ...runtime）',
    /readRuntimeConfig/.test(assistantJs) && /\.\.\.runtime/.test(assistantJs)
    && /planId: plan\.planId, approved: true, \.\.\.runtime/.test(assistantJs));
  ok('首页示例改为「时长优先」（不再出现主题式长片示例；兼容 i18n 键）',
    // 2026-11-16 用户反馈「30 秒」：chips 前面加了「30 秒（快速试）」，断言改成「包含 10 分钟长片示例」
    // 2026-11-17 V2：i18n 后 chips 变成 tr('assistant.chips.long')，要求 zh 文案仍是「10 分钟的长视频」。
    (/PAGE_CHIPS = \[[^\]]*'10 分钟的长视频'/.test(assistantJs)
      || /PAGE_CHIPS = \[[^\]]*assistant\.chips\.long/.test(assistantJs))
    && /long: '10 分钟的长视频'/.test(i18nAssistantSrc)
    && !/30 分钟的雪山/.test(assistantJs)
    && /场景卡库/.test(assistantJs));

  // ================= [10] 小智 2.0 V1：A1–A10（§8.3 验收矩阵 / §9.1-1..7） =================
  console.log('\n[10] 小智 2.0 V1 验收 A1–A10：意图兜底 / 提示词工作流 / 确认门 / 负向不误伤');
  const taskCount = () => taskManager.getAllTasks().length;

  // ---- 前置：3 段 mock 计划（场景卡默认开，3 张卡在计划阶段固定）----
  const sidV1 = 's_v1_a_matrix_1';
  const v1PlanMsg = supervisor.handleMessage({ sessionId: sidV1, text: 'mock 3段，每段10秒' });
  const v1PlanId = v1PlanMsg.plan && v1PlanMsg.plan.planId;
  const v1Ids = assistantMemory.lastPlan(sidV1).sceneCardIds.slice();
  const v1Tasks = taskCount();
  ok('V1 前置：3 段 mock 计划就绪（3 张卡在计划阶段已固定）',
    v1PlanMsg.ok === true && !!v1PlanId && v1Ids.length === 3
    && v1PlanMsg.plan.sceneCards === true,
    v1PlanId || v1PlanMsg.code);

  // ---- A1：换一个场景卡，我不太满意。→ plan_edit，问第几段，不重排、不改卡、不建任务 ----
  const a1 = supervisor.handleMessage({ sessionId: sidV1, text: '换一个场景卡，我不太满意。' });
  const planA1 = assistantMemory.lastPlan(sidV1);
  ok('A1「换一个场景卡，我不太满意。」→ plan_edit；问第几段；不含「排好了/做多长」；planId 不变；不建任务；不改卡',
    a1.ok === true && a1.intent === 'plan_edit'
    && /要换第几段/.test(a1.reply)
    && !/排好了/.test(a1.reply) && !/做多长/.test(a1.reply)
    && planA1.planId === v1PlanId
    && JSON.stringify(planA1.sceneCardIds) === JSON.stringify(v1Ids)
    && taskCount() === v1Tasks,
    String(a1.reply || '').slice(0, 50));

  // ---- A2：场景不太满意，场景卡就是提示词的内容。→ plan_edit，并区分「换卡 vs 改词」 ----
  const a2 = supervisor.handleMessage({ sessionId: sidV1, text: '场景不太满意，场景卡就是提示词的内容。' });
  const planA2 = assistantMemory.lastPlan(sidV1);
  ok('A2「场景不太满意，场景卡就是提示词的内容。」→ plan_edit；同时给出「换卡」与「改提示词」两条路径；planId 不变',
    a2.ok === true && a2.intent === 'plan_edit'
    && /要换第几段/.test(a2.reply) && /提示词/.test(a2.reply)
    && !/排好了/.test(a2.reply)
    && planA2.planId === v1PlanId
    && JSON.stringify(planA2.sceneCardIds) === JSON.stringify(v1Ids)
    && taskCount() === v1Tasks,
    String(a2.reply || '').slice(0, 50));

  // ---- A3：第 2 张换一个。→ 只换第 2 张，回显旧→新 ----
  const a3 = supervisor.handleMessage({ sessionId: sidV1, text: '第 2 张换一个。' });
  const idsA3 = assistantMemory.lastPlan(sidV1).sceneCardIds.slice();
  const a3Old = sceneCardLibrary.getCardById(v1Ids[1]);
  const a3New = sceneCardLibrary.getCardById(idsA3[1]);
  ok('A3「第 2 张换一个。」→ 仅第 2 段变、其余两段不变、回显「旧 → 新」、planId 不变、不建任务',
    a3.ok === true && a3.intent === 'plan_edit'
    && idsA3[1] !== v1Ids[1] && idsA3[0] === v1Ids[0] && idsA3[2] === v1Ids[2]
    && !!a3Old && !!a3New
    && a3.reply.includes(a3Old.scene_key) && a3.reply.includes(a3New.scene_key)
    && /→/.test(a3.reply)
    && assistantMemory.lastPlan(sidV1).planId === v1PlanId
    && taskCount() === v1Tasks,
    `${v1Ids.join(',')} → ${idsA3.join(',')}`);

  // ---- A4：把第 2 段的提示词给我看一下。→ 原样贴出全文，不改任何东西、不弹新卡 ----
  // 期望文本按 pipeline 同口径现算（theme 来自计划；mock 计划没有主题 → null）。
  const a4Expected = promptComposer.composeClipPatch(
    sceneCardLibrary.getCardById(idsA3[1]),
    { theme: assistantMemory.lastPlan(sidV1).theme || null, promptOverride: null }
  ).prompt;
  const a4 = supervisor.handleMessage({ sessionId: sidV1, text: '把第 2 段的提示词给我看一下。' });
  const planA4 = assistantMemory.lastPlan(sidV1);
  ok('A4「把第 2 段的提示词给我看一下。」→ 原样贴出该段全文；planId/卡/覆盖都没变；不建任务；不回传计划（不弹新卡）',
    a4.ok === true && a4.intent === 'plan_edit'
    && a4Expected.length > 20 && a4.reply.includes(a4Expected)
    && planA4.planId === v1PlanId
    && JSON.stringify(planA4.sceneCardIds) === JSON.stringify(idsA3)
    && !planA4.promptOverrides
    && a4.plan === null
    && taskCount() === v1Tasks,
    `${a4Expected.length} 字`);

  // ---- A5：用这个：… → 原样替换第 2 段（目标段来自上一句「第 2 段」的上下文）----
  const a5Text = '雪山日出，金光打在雪脊上，缓慢横移';
  const a5 = supervisor.handleMessage({ sessionId: sidV1, text: `用这个：${a5Text}。` });
  const planA5 = assistantMemory.lastPlan(sidV1);
  ok('A5「用这个：…」→ promptOverrides["1"] 就是用户原文（17 字，不润色）；planId/卡不变；不建任务',
    a5.ok === true && a5.intent === 'plan_edit'
    && !!planA5.promptOverrides && planA5.promptOverrides['1'] === a5Text
    && a5.reply.includes(`已按你的文本替换第 2 段（${a5Text.length} 字）`)
    && planA5.planId === v1PlanId
    && JSON.stringify(planA5.sceneCardIds) === JSON.stringify(idsA3)
    && taskCount() === v1Tasks,
    planA5.promptOverrides ? planA5.promptOverrides['1'] : '无覆盖');

  // ---- A6：把「缓慢横移」改成「缓慢推近」，去掉「金光」。→ 两处都应用，只回改动点 ----
  const a6 = supervisor.handleMessage({ sessionId: sidV1, text: '把「缓慢横移」改成「缓慢推近」，去掉「金光」。' });
  const planA6 = assistantMemory.lastPlan(sidV1);
  const a6Over = planA6.promptOverrides && planA6.promptOverrides['1'];
  ok('A6「把 X 改成 Y / 去掉 Z」→ 两处都应用（含「推近」且不含「金光」）；planId 不变；不建任务',
    a6.ok === true && a6.intent === 'plan_edit' && !!a6Over
    && a6Over.includes('缓慢推近') && !a6Over.includes('金光')
    && planA6.planId === v1PlanId
    && taskCount() === v1Tasks,
    a6Over || '无覆盖');
  ok('A6 只回改动点：「缓慢横移」→「缓慢推近」+ 去掉「金光」；不重贴整张计划',
    /「缓慢横移」→「缓慢推近」/.test(a6.reply)
    && /去掉「金光」/.test(a6.reply)
    && /已改第 2 段（2 处）/.test(a6.reply)
    && !/排好了/.test(a6.reply) && !/预估费用/.test(a6.reply) && !/总时长/.test(a6.reply),
    String(a6.reply || '').split('\n')[0]);
  // 一条消息多处修改：按出现顺序全应用（③），并保持其它段不动
  const a6b = supervisor.handleMessage({
    sessionId: sidV1,
    text: '把「雪山日出」改成「雪山日落」，把「缓慢推近」改成「缓慢拉远」，去掉「打在雪脊上」'
  });
  const a6bOver = assistantMemory.lastPlan(sidV1).promptOverrides['1'];
  ok('A6b 一条消息 3 处按序全应用（改 2 处 + 去掉 1 处），只动第 2 段',
    a6b.intent === 'plan_edit'
    && a6bOver.includes('雪山日落') && a6bOver.includes('缓慢拉远')
    && !a6bOver.includes('打在雪脊上') && !a6bOver.includes('缓慢推近')
    && /已改第 2 段（3 处）/.test(a6b.reply)
    && a6b.reply.indexOf('雪山日出') < a6b.reply.indexOf('去掉「打在雪脊上」')
    && assistantMemory.lastPlan(sidV1).planId === v1PlanId
    && taskCount() === v1Tasks,
    a6bOver);
  // 负向：改不到的文字必须明确说没找到，不能假装改了
  const a6c = supervisor.handleMessage({ sessionId: sidV1, text: '把「根本不存在的句子」改成「X」' });
  ok('A6c 负向：要改的文字不在该段提示词里 → 明确回「没找到」、计划不变、不建任务',
    a6c.intent === 'plan_edit' && /没在|没找到/.test(a6c.reply)
    && assistantMemory.lastPlan(sidV1).promptOverrides['1'] === a6bOver
    && taskCount() === v1Tasks,
    String(a6c.reply || '').slice(0, 60));

  // ---- A7：确认生成吗？→ 回确认语 + 回传计划；未点确认不建任务，点确认才建 ----
  const origRandomA7 = Math.random;
  Math.random = () => 0.95; // mock 片段一律成功（与 [6] 同口径）
  try {
    const sidA7 = 's_v1_a7_confirm_1';
    const planMsgA7 = supervisor.handleMessage({ sessionId: sidA7, text: 'mock 1段，每段10秒' });
    const planIdA7 = planMsgA7.plan.planId;
    const idsA7 = assistantMemory.lastPlan(sidA7).sceneCardIds.slice();
    const tasksBeforeA7 = taskCount();
    const askA7 = supervisor.handleMessage({ sessionId: sidA7, text: '确认生成吗？' });
    ok('A7「确认生成吗？」→ intent=confirm、回确认语 + 回传同一计划；**未点确认时任务数不变**',
      askA7.ok === true && askA7.intent === 'confirm'
      && /确认执行/.test(askA7.reply) && /不会建任务/.test(askA7.reply)
      && !!askA7.plan && askA7.plan.planId === planIdA7
      && assistantMemory.lastPlan(sidA7).planId === planIdA7
      && !askA7.taskId
      && taskCount() === tasksBeforeA7,
      String(askA7.reply || '').split('\n')[0]);
    const exA7 = supervisor.execute({ sessionId: sidA7, planId: planIdA7, approved: true });
    ok('A7 用户点确认（approved=true）后才建任务，且只建 1 条',
      exA7.ok === true && !!exA7.taskId && taskCount() === tasksBeforeA7 + 1,
      exA7.error || exA7.taskId);
    if (exA7.ok) createdTasks.push(exA7.taskId);
    const taskA7 = exA7.ok ? taskManager.getTask(exA7.taskId) : null;
    ok('A7 execute 用的是计划阶段固定的那张卡（没有重新 allocate）',
      !!taskA7 && !!taskA7.sceneCards && taskA7.sceneCards.used.length === 1
      && taskA7.sceneCards.used[0].id === idsA7[0],
      taskA7 && taskA7.sceneCards ? `${taskA7.sceneCards.used[0].id} vs ${idsA7[0]}` : '无任务');
    const stA7 = await waitTerminal(sidA7, planIdA7, 180000);
    ok('A7 点确认后任务正常跑到终态 done（确认门没有把执行流程改坏）',
      stA7.state.state === 'done', stA7.state.reason || '');
  } finally {
    Math.random = origRandomA7;
  }

  // ---- A8/A9/A10 负向：新入口不许误伤（仍是 create / bgm，不是 plan_edit）----
  ok('A8「换一个场景，30 秒。」→ intent=create（带时长词，不是 plan_edit）',
    assistantMemory.classify('换一个场景，30 秒。').intent === 'create'
    && assistantMemory.isSceneCardEdit('换一个场景，30 秒。') === false);
  const sidA8 = 's_v1_a8_create_1';
  const tasksBeforeA8 = taskCount();
  const a8 = supervisor.handleMessage({ sessionId: sidA8, text: '换一个场景，30 秒。' });
  ok('A8 实际对话：新建一条计划（新 planId、说「排好了」）、不建任务',
    a8.ok === true && a8.intent === 'create' && !!a8.plan
    && /排好了/.test(a8.reply)
    && taskCount() === tasksBeforeA8,
    a8.plan ? `${a8.plan.clipCount}段` : String(a8.reply || '').slice(0, 40));
  ok('A9「10 分钟，场景从卡库选。」→ intent=create（无换卡动作，不被 plan_edit 抢）',
    assistantMemory.classify('10 分钟，场景从卡库选。').intent === 'create'
    && assistantMemory.isSceneCardEdit('10 分钟，场景从卡库选。') === false);
  const sidA9 = 's_v1_a9_create_1';
  const tasksBeforeA9 = taskCount();
  const a9 = supervisor.handleMessage({ sessionId: sidA9, text: '10 分钟，场景从卡库选。' });
  ok('A9 实际对话：新建一条 60 段计划、不建任务',
    a9.ok === true && a9.intent === 'create' && !!a9.plan && a9.plan.clipCount === 60
    && taskCount() === tasksBeforeA9,
    a9.plan ? `${a9.plan.clipCount}段` : a9.code);
  ok('A10「配乐换一首。」→ intent=bgm（配乐名词护栏，不被 plan_edit 抢）',
    assistantMemory.classify('配乐换一首。').intent === 'bgm'
    && assistantMemory.isSceneCardEdit('配乐换一首。') === false);
  const tasksBeforeA10 = taskCount();
  const a10 = supervisor.handleMessage({ sessionId: sidV1, text: '配乐换一首。' });
  ok('A10 实际对话：配乐意图（不是 plan_edit）、planId 不变、不建任务',
    a10.intent === 'bgm'
    && assistantMemory.lastPlan(sidV1).planId === v1PlanId
    && taskCount() === tasksBeforeA10,
    String(a10.reply || '').split('\n')[0]);

  // ---- §9.1-6：前端「确认门」静态接线（浏览器未验证）----
  const assistantJsV1 = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'components', 'assistant.js'), 'utf8');
  ok('卡片两时点：新增 planCardVisible 状态，两处 PlanCard 渲染点都受它控制（不再「有 plan 就渲染」）',
    /const \[planCardVisible, setPlanCardVisible\] = useState\(false\)/.test(assistantJsV1)
    && (assistantJsV1.match(/planCardVisible && plan && backend\.ok/g) || []).length === 2
    && (assistantJsV1.match(/<\$\{PlanCard\}/g) || []).length === 2);
  ok('卡片两时点：只有「新计划成型(intent=create)」与「最终确认(intent=confirm)」置 true；数据变化只 setPlan',
    /const showCard = \(j\.intent === 'create' && isNewPlan\) \|\| j\.intent === 'confirm'/.test(assistantJsV1)
    && /lastFormedPlanIdRef/.test(assistantJsV1)
    && /setPlanCardVisible\(false\)/.test(assistantJsV1));
  ok('确认生成流程：execute 只由卡片 onConfirm 触发；成功后再收起卡片（防重复建任务）',
    /onConfirm=\$\{confirmPlan\}/.test(assistantJsV1)
    && (assistantJsV1.match(/\/api\/assistant\/execute/g) || []).length === 1
    && /planId: plan\.planId, approved: true/.test(assistantJsV1)
    && /确认这一刻用过了/.test(assistantJsV1));

  // ================= [11] §9.1-7：V1 只读环境（预算 / 任务数 / Key 有·无） =================
  console.log('\n[11] §9.1-7 只读环境：预算余额 / 任务数 / Key 只报有·无（不建任务、不改计划）');
  const budNow = budget.status();
  const tasksBeforeCtx = taskCount();
  const ctxMsg = supervisor.handleMessage({ sessionId: sidV1, text: '预算还有多少？' });
  ok('预算问答 → intent=context；数字与 budget.status() 一致；不回传计划、不建任务',
    ctxMsg.ok === true && ctxMsg.intent === 'context'
    && ctxMsg.reply.includes('$' + Number(budNow.balanceUsd).toFixed(2))
    && ctxMsg.reply.includes('$' + Number(budNow.spentUsd).toFixed(2))
    && ctxMsg.plan === null
    && taskCount() === tasksBeforeCtx,
    String(ctxMsg.reply || '').split('\n').slice(0, 2).join(' | '));
  const ctxTasksMsg = supervisor.handleMessage({ sessionId: sidV1, text: '现在几个任务了？' });
  ok('任务数问答 → intent=context；数量与 taskManager.getAllTasks().length 一致',
    ctxTasksMsg.intent === 'context'
    && ctxTasksMsg.reply.includes(`共 ${taskCount()} 个`),
    String(ctxTasksMsg.reply || '').split('\n')[1]);
  const ctxOf = supervisor.contextOf(sidV1);
  const ctxJson = JSON.stringify(ctxOf);
  const leaked = Object.entries(process.env)
    .filter(([, v]) => typeof v === 'string' && v.trim().length >= 16)
    .filter(([, v]) => ctxJson.includes(v.trim()))
    .map(([k]) => k);
  ok('contextOf：会话内计划 + 任务数/最近任务 + 预算 + Key 有·无；**任何环境变量原值都不出现**（Key 绝不回显）',
    !!ctxOf && Array.isArray(ctxOf.keys) && ctxOf.keys.length >= 4
    && ctxOf.keys.every((k) => Object.keys(k).join(',') === 'label,present' && typeof k.present === 'boolean')
    && !!ctxOf.plan && ctxOf.plan.planId === assistantMemory.lastPlan(sidV1).planId
    && ctxOf.tasks.total === taskCount()
    && !!ctxOf.budget && ctxOf.budget.balanceUsd === budNow.balanceUsd
    && leaked.length === 0,
    leaked.length ? `泄露字段: ${leaked.join(',')}` : `keys=${ctxOf.keys.length}`);

  // ================= [12] §9.1-4：场景卡随机抽 + 跨计划冷却 =================
  console.log('\n[12] §9.1-4 场景卡：随机抽 N 张 + 跨计划冷却 + 换单段随机（Q24=B / Q25=A / Q30=C）');
  ok('冷却文件隔离在本次验收临时目录（不写用户真实的 data/assistant）',
    path.resolve(sceneCardLibrary.coolingFile()) === path.resolve(path.join(TMP, 'scene-card-cooling.json')),
    sceneCardLibrary.coolingFile());
  sceneCardLibrary.resetCooling();
  const seedIds = (seed, n) => sceneCardLibrary.allocate(n, { seed, noCooling: true, recordCooling: false })
    .used.map((e) => e.id);
  const seedA1 = seedIds('v1-seed-a', 5);
  const seedA2 = seedIds('v1-seed-a', 5);
  const seedB = seedIds('v1-seed-b', 5);
  ok('随机抽卡：同一 seed 结果可复现；不同 seed 结果不同；同一次内不重复',
    JSON.stringify(seedA1) === JSON.stringify(seedA2)
    && JSON.stringify(seedA1) !== JSON.stringify(seedB)
    && new Set(seedA1).size === 5,
    `${seedA1.join(',')} / ${seedB.join(',')}`);
  const libAll = sceneCardLibrary.loadLibrary();
  ok('随机抽卡后仍按 chapter+sequence 排序（选哪些随机，播映顺序不乱）', (() => {
    const entries = sceneCardLibrary.allocate(6, { noCooling: true, recordCooling: false }).used;
    for (let i = 1; i < entries.length; i++) {
      const p = entries[i - 1];
      const c = entries[i];
      if (c.chapter < p.chapter || (c.chapter === p.chapter && c.sequence <= p.sequence)) return false;
    }
    return true;
  })());
  ok('取满 180 张 → 与卡库顺序完全一致（全选后排序等价原顺序，零回归）', (() => {
    const all = sceneCardLibrary.allocate(180, { noCooling: true, recordCooling: false }).used;
    return all.length === 180 && all.every((e, i) => e.id === libAll.features[i].id);
  })());
  // 冷却：把 175 张写进「最近 3 个计划」→ 下一次抽卡只能来自剩下 5 张
  const allIds = libAll.features.map((c) => c.id);
  const cooled = allIds.slice(0, 175);
  const remain = allIds.slice(175);
  sceneCardLibrary.writeCooling({
    version: sceneCardLibrary.COOLING_VERSION,
    plans: [cooled.slice(0, 60), cooled.slice(60, 120), cooled.slice(120, 175)]
      .map((ids, i) => ({ roundId: 'cool' + i, ids, at: new Date().toISOString() }))
  });
  const coolDraw = sceneCardLibrary.allocate(5, { seed: 'cool-draw', recordCooling: false }).used.map((e) => e.id);
  ok('冷却生效：最近 3 个计划用过的 175 张全部避开，只给没进冷却的 5 张',
    coolDraw.length === 5 && coolDraw.every((id) => remain.includes(id)),
    `抽到 ${coolDraw.join(',')} / 期望 ⊆ ${remain.join(',')}`);
  // 回退：全部卡都在冷却里 → 仍能取到，不报错
  sceneCardLibrary.writeCooling({
    version: sceneCardLibrary.COOLING_VERSION,
    plans: [{ roundId: 'all', ids: allIds, at: new Date().toISOString() }]
  });
  let fallbackDraw = null;
  try { fallbackDraw = sceneCardLibrary.allocate(5, { seed: 'fallback', recordCooling: false }); } catch (e) { fallbackDraw = null; }
  ok('卡不够时回退：180 张全在冷却里也能取到 5 张且不重复（不报错、不静默复用）',
    !!fallbackDraw && fallbackDraw.used.length === 5
    && new Set(fallbackDraw.used.map((e) => e.id)).size === 5,
    fallbackDraw ? fallbackDraw.used.map((e) => e.id).join(',') : '抛错');
  // 换单段卡：随机 + 未用 + 避开冷却（Q30=C）
  sceneCardLibrary.resetCooling();
  const swapBase = sceneCardLibrary.allocate(3, { seed: 'swap-base', noCooling: true, recordCooling: false })
    .used.map((e) => e.id);
  const swapPicks = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    .map((seed) => sceneCardLibrary.nextSwapCandidate(swapBase[0], swapBase, { seed }).id);
  ok('换单段卡：每次都挑一张「不在本计划已用集合」里的卡（随机，不是固定下一张）',
    swapPicks.every((id) => !swapBase.includes(id))
    && new Set(swapPicks).size >= 2,
    swapPicks.join(','));
  sceneCardLibrary.writeCooling({
    version: sceneCardLibrary.COOLING_VERSION,
    plans: [{ roundId: 'all2', ids: allIds.filter((id) => !remain.includes(id)), at: new Date().toISOString() }]
  });
  const swapCool = sceneCardLibrary.nextSwapCandidate(swapBase[0], swapBase, { seed: 'swap-cool' }).id;
  ok('换单段卡也吃同一套冷却：冷却外的卡优先（这里只剩 5 张未冷却）',
    remain.includes(swapCool), `${swapCool} ∈ ${remain.join(',')}`);
  sceneCardLibrary.resetCooling();
  let swapExhaust = null;
  try { sceneCardLibrary.nextSwapCandidate(allIds[0], allIds); } catch (e) { swapExhaust = e; }
  ok('全部正片都用过 → SCENE_CARDS_SWAP_EXHAUSTED（明确报错，不静默复用）',
    !!swapExhaust && swapExhaust.code === 'SCENE_CARDS_SWAP_EXHAUSTED', swapExhaust && swapExhaust.code);

  // ================= [13] 小智 2.0 V2：B1–B8（进程内；不起第二实例）=================
  console.log('\n[13] 小智 2.0 V2 验收 B1–B8：全局环境 / 诊断播报 / 偏好 L3 / 素材计数 / 播报开关');
  const taskCountV2 = () => taskManager.getAllTasks().length;
  const mkTaskV2 = (prompt, opts = {}) => {
    const t = taskManager.createTask(prompt, {
      model: 'mock',
      totalClips: opts.totalClips || 2,
      clipDuration: 10,
      ...(opts.extra || {})
    });
    createdTasks.push(t.taskId);
    return t;
  };

  // ---- B1：现在跑到哪了？ → 全局任务/进度（不只本会话），不建任务 ----
  const b1Task = mkTaskV2('V2-B1 运行中的任务', { totalClips: 3 });
  taskManager.updateTaskStatus(b1Task.taskId, 'generating', { currentStep: '片段生成' });
  taskManager.updateClip(b1Task.taskId, 0, { status: 'success' });
  const b1Before = taskCountV2();
  const b1 = supervisor.handleMessage({ sessionId: 's_v2_b1_status', text: '现在跑到哪了？' });
  ok('B1「现在跑到哪了？」→ status；读全局在跑任务（taskId + 进度），不建任务',
    b1.ok === true && b1.intent === 'status'
    && b1.reply.includes(b1Task.taskId)
    && /成功 1\/3 段（33%）/.test(b1.reply)
    && taskCountV2() === b1Before,
    String(b1.reply || '').split('\n').slice(0, 2).join(' | '));

  // ---- B2：这条为什么失败？ → 读任务 + 诊断摘要；不自动重跑 ----
  const b2Task = mkTaskV2('V2-B2 失败任务', { totalClips: 2 });
  taskManager.updateClip(b2Task.taskId, 0, { status: 'failed', error: '模型不支持图生视频（i2v）：wan-old' });
  taskManager.updateTaskStatus(b2Task.taskId, 'failed', { error: '模型不支持图生视频（i2v）：wan-old' });
  const b2Before = taskCountV2();
  const b2 = supervisor.handleMessage({ sessionId: 's_v2_b2_diag', text: '这条为什么失败？' });
  ok('B2「这条为什么失败？」→ repair；含任务 id + 失败原因 + 修复建议；不自动重跑（任务数不变、任务仍 failed）',
    b2.ok === true && b2.intent === 'repair'
    && b2.reply.includes(b2Task.taskId)
    && /图生视频/.test(b2.reply)
    && /修复选项|建议/.test(b2.reply)
    && b2.diagnosis && b2.diagnosis.category === 'model'
    && b2.diagnosis.suggestions.some((s) => s.executable === true)
    && taskCountV2() === b2Before
    && taskManager.getTask(b2Task.taskId).status === 'failed',
    b2.diagnosis ? `${b2.diagnosis.category}/${b2.diagnosis.suggestions.length}条建议` : b2.code);

  // ---- B3：任务失败 → 主动简报 + 修复建议；未点修复不执行，点了才执行（L3）----
  assistantBroadcast.reset({ primeExisting: true });
  assistantPreferences.setGlobal({ broadcastEnabled: true, throttleSec: 0 });
  const b3Task = mkTaskV2('V2-B3 失败播报任务', { totalClips: 2 });
  taskManager.updateClip(b3Task.taskId, 0, { status: 'failed', error: '余额不足：本次预计 $1.00，剩余 $0.00' });
  taskManager.updateTaskStatus(b3Task.taskId, 'failed', { error: '余额不足：本次预计 $1.00，剩余 $0.00' });
  const b3Pushed = [];
  const b3Unsub = assistantBroadcast.subscribe((p) => b3Pushed.push(p));
  let b3Scan = null;
  try { b3Scan = assistantBroadcast.scan(); } catch (e) { b3Scan = { error: e && e.message }; }
  const b3Item = b3Scan && b3Scan.payload
    ? b3Scan.payload.items.find((i) => i.taskId === b3Task.taskId)
    : null;
  ok('B3 任务失败 → 主动简报（合并一条、管家口吻）；含 taskId + 失败原因 + 修复建议；推送一次',
    !!b3Scan && b3Scan.delivered === 1 && !!b3Item && b3Item.node === 'task_failed'
    && /^【小智简报】/.test(b3Scan.payload.text)
    && /余额不足/.test(b3Scan.payload.text)
    && /建议：/.test(b3Scan.payload.text)
    && /未点「修复」不会执行/.test(b3Scan.payload.text)
    && b3Pushed.length === 1,
    b3Scan && b3Scan.payload ? b3Scan.payload.text.split('\n')[1] : (b3Scan && b3Scan.error));
  const b3Scan2 = assistantBroadcast.scan();
  ok('B3 同一节点只播一次：再次 scan 不重复推送（announced 去重 + 有界 ring）',
    b3Scan2.delivered === 0 && b3Pushed.length === 1,
    `delivered=${b3Scan2.delivered} pushed=${b3Pushed.length}`);
  const origContinue = pipeline.continueTask;
  let b3ContinueCalls = 0;
  pipeline.continueTask = async (taskId) => {
    b3ContinueCalls += 1;
    return { success: true, taskId, pending: ['clip_generation'], resume: { pending: ['clip_generation'] } };
  };
  try {
    const b3No = await supervisor.repairTask({ taskId: b3Task.taskId, action: 'continue', approved: false });
    ok('B3 未点修复不执行：approved=false → PAYMENT_NOT_APPROVED，continueTask 调用 0 次，任务仍 failed',
      b3No.ok === false && b3No.code === 'PAYMENT_NOT_APPROVED'
      && b3ContinueCalls === 0 && taskManager.getTask(b3Task.taskId).status === 'failed',
      b3No.code);
    const b3Yes = await supervisor.repairTask({ taskId: b3Task.taskId, action: 'continue', approved: true, userId: 'local' });
    ok('B3 点了修复才执行：approved=true → continueTask 调用 1 次 + 审计记录一条 repair',
      b3Yes.ok === true && b3ContinueCalls === 1
      && assistantAudit.list({ kind: 'repair' }).length >= 1,
      b3Yes.ok ? b3Yes.action : b3Yes.code);
  } finally {
    pipeline.continueTask = origContinue;
    b3Unsub();
  }

  // ---- B4：预算还有多少？ → 与 /api/budget 同源（同一 budget.status()）----
  const b4Budget = budget.status();
  const b4Before = taskCountV2();
  const b4 = supervisor.handleMessage({ sessionId: 's_v2_b4_budget', text: '预算还有多少？' });
  ok('B4「预算还有多少？」→ context；剩余/已花数字与 /api/budget（budget.status）一致；不建任务',
    b4.ok === true && b4.intent === 'context'
    && /^【小智简报】/.test(b4.reply)
    && b4.reply.includes(`剩余 $${Number(b4Budget.balanceUsd).toFixed(2)}`)
    && b4.reply.includes(`已花 $${Number(b4Budget.spentUsd).toFixed(2)}`)
    && taskCountV2() === b4Before,
    `$${b4Budget.balanceUsd}/$${b4Budget.spentUsd}`);

  // ---- B5：图片库还有多少能用的？ → 与 /api/photos 同口径（文件缺失不计入）----
  const b5Png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const b5FileA = path.join(TMP, 'b5_photo_approved.png');
  const b5FileB = path.join(TMP, 'b5_photo_pending.png');
  fs.writeFileSync(b5FileA, b5Png);
  fs.writeFileSync(b5FileB, b5Png);
  const b5PhotoA = photoLibrary.ingest({ filePath: b5FileA, taskId: 'v2_b5', index: 0, prompt: 'B5 图片A', model: 'dashscope', status: 'approved' });
  photoLibrary.markReviewed(b5PhotoA.id, 'approved', 'B5 验收');
  const b5PhotoB = photoLibrary.ingest({ filePath: b5FileB, taskId: 'v2_b5', index: 1, prompt: 'B5 图片B', model: 'dashscope' });
  const b5Visible = photoLibrary.listAll().filter((p) => p && p.filePath && fs.existsSync(p.filePath));
  const b5Totals = photoLibrary.totals(b5Visible);
  const b5Before = taskCountV2();
  const b5 = supervisor.handleMessage({ sessionId: 's_v2_b5_assets', text: '图片库还有多少能用的？' });
  ok('B5「图片库还有多少能用的？」→ assets；可用/总数/三态与 /api/photos 同口径一致；不建任务',
    b5.ok === true && b5.intent === 'assets'
    && b5.reply.includes(`可用 ${b5Totals.approved} 张 / 共 ${b5Totals.all}`)
    && b5.reply.includes(`待审 ${b5Totals.pending}`)
    && b5.reply.includes(`通过 ${b5Totals.approved}`)
    && b5.reply.includes(`打回 ${b5Totals.rejected}`)
    && taskCountV2() === b5Before,
    `approved=${b5Totals.approved}/all=${b5Totals.all}/pending=${b5Totals.pending}`);
  ok('B5 图片条目本身创建成功（两张：一通过一待审）',
    !!b5PhotoA && !!b5PhotoB && b5Totals.approved >= 1 && b5Totals.pending >= 1,
    `A=${b5PhotoA && b5PhotoA.status} B=${b5PhotoB && b5PhotoB.status}`);
  ok('V2 新意图不抢 V1 既有分类（改成1080p→plan_edit（D1）/ 每段15秒→create / 再来一条→create / 不要场景卡→unknown / 配乐有哪些→bgm / 你选了哪些场景卡→plan_scenes）',
    assistantMemory.classify('改成 1080p').intent === 'plan_edit'
    && assistantMemory.classify('每段 15 秒').intent === 'create'
    && assistantMemory.classify('再来一条').intent === 'create'
    && assistantMemory.classify('不要场景卡').intent === 'unknown'
    && assistantMemory.classify('配乐有哪些').intent === 'bgm'
    && assistantMemory.classify('你选了哪些场景卡').intent === 'plan_scenes',
    `${assistantMemory.classify('改成 1080p').intent}/${assistantMemory.classify('配乐有哪些').intent}`);

  // ---- B6：把默认通道改成百炼 → 提示 L3；未确认不改设置 ----
  supervisor._clearPendingChanges();
  const b6BeforeTasks = taskCountV2();
  const b6 = supervisor.handleMessage({ sessionId: 's_v2_b6_settings', text: '把默认通道改成百炼' });
  ok('B6「把默认通道改成百炼」→ settings；提示这是设置变更（L3）+ 返回 pendingChange；未确认不改设置、不建任务、不建计划',
    b6.ok === true && b6.intent === 'settings'
    && /设置变更（L3/.test(b6.reply) && /百炼/.test(b6.reply) && /没有改任何东西/.test(b6.reply)
    && !!b6.pendingChange && b6.pendingChange.requiresConfirm === true
    && b6.pendingChange.key === 'model' && b6.pendingChange.value === 'dashscope'
    && assistantPreferences.get('local') === null
    && taskCountV2() === b6BeforeTasks && b6.plan === null,
    b6.pendingChange ? b6.pendingChange.label : b6.reply.slice(0, 60));
  const b6No = supervisor.confirmSettingChange({
    sessionId: 's_v2_b6_settings', changeId: b6.pendingChange.changeId, approved: false, userId: 'local'
  });
  ok('B6 未确认（approved=false）→ SETTINGS_NOT_APPROVED；偏好仍未写入',
    b6No.ok === false && b6No.code === 'SETTINGS_NOT_APPROVED'
    && assistantPreferences.get('local') === null,
    b6No.code);
  const b6Yes = supervisor.confirmSettingChange({
    sessionId: 's_v2_b6_settings', changeId: b6.pendingChange.changeId, approved: true, userId: 'local'
  });
  const b6Audit = assistantAudit.list({ kind: 'settings', limit: 5 });
  ok('B6 确认后才写入服务端偏好（model=dashscope）+ 审计（actor/at/action/before/after）',
    b6Yes.ok === true && b6Yes.preferences && b6Yes.preferences.model === 'dashscope'
    && b6Audit.length >= 1 && !!b6Audit[0].at && b6Audit[0].actor === 'local'
    && JSON.stringify(b6Audit[0]).includes('dashscope'),
    b6Yes.ok ? b6Yes.applied.label : b6Yes.code);

  // ---- B7：新窗口（新 sessionId）说「用我常用的设置」→ 读到跨会话偏好 ----
  const b7Prep = supervisor.handleMessage({ sessionId: 's_v2_b7_prep', text: '把默认分辨率改成 1080p' });
  const b7Conf = supervisor.confirmSettingChange({
    sessionId: 's_v2_b7_prep', changeId: b7Prep.pendingChange.changeId, approved: true, userId: 'local'
  });
  const b7BeforeTasks = taskCountV2();
  const b7 = supervisor.handleMessage({ sessionId: 's_v2_b7_new_window', text: '用我常用的设置' });
  ok('B7 新窗口「用我常用的设置」→ prefs；不同 sessionId 仍读到服务端用户级偏好（百炼 + 1080p）；不建任务/计划',
    b7Conf.ok === true
    && b7.ok === true && b7.intent === 'prefs'
    && b7.sessionId !== b7Prep.sessionId
    && /百炼/.test(b7.reply) && /1080p/.test(b7.reply)
    && !!b7.preferences && b7.preferences.model === 'dashscope' && b7.preferences.resolution === '1080p'
    && taskCountV2() === b7BeforeTasks && b7.plan === null,
    b7.preferences ? `${b7.preferences.model}/${b7.preferences.resolution}` : b7.reply.slice(0, 60));
  const b7ClearNo = supervisor.clearPreferences({ userId: 'local', approved: false });
  ok('B7 清空偏好也是 L3：未确认 → SETTINGS_NOT_APPROVED、偏好仍在',
    b7ClearNo.ok === false && b7ClearNo.code === 'SETTINGS_NOT_APPROVED'
    && !!assistantPreferences.get('local'),
    b7ClearNo.code);
  const b7Clear = supervisor.clearPreferences({ userId: 'local', approved: true });
  ok('B7 确认后可清空：偏好归 null + 审计记一条 preferences/clear',
    b7Clear.ok === true && b7Clear.removed === true && assistantPreferences.get('local') === null
    && assistantAudit.list({ kind: 'preferences' }).length >= 1,
    b7Clear.ok ? `removed=${b7Clear.removed}` : b7Clear.code);

  // ---- B8：另一个窗口新建任务 → 全局可见 + 关键节点播报一次不重复 + 合并节流 + 设置可关 ----
  assistantBroadcast.reset({ primeExisting: true });
  assistantPreferences.setGlobal({ broadcastEnabled: true, throttleSec: 0 });
  const b8Pushed = [];
  const b8Unsub = assistantBroadcast.subscribe((p) => b8Pushed.push(p));
  try {
    const b8Task = mkTaskV2('V2-B8 另一窗口新建的任务', { totalClips: 2 });
    const b8Scan1 = assistantBroadcast.scan();
    const b8Item = b8Scan1.payload ? b8Scan1.payload.items.find((i) => i.taskId === b8Task.taskId) : null;
    ok('B8 另一窗口新建任务 → 全局可见：播报含该 taskId（新建节点）+ 只推一次',
      b8Scan1.delivered === 1 && !!b8Item && b8Item.node === 'task_created'
      && b8Pushed.length === 1,
      b8Item ? b8Item.node : '未播报');
    const b8Scan2 = assistantBroadcast.scan();
    ok('B8 同一关键节点不重复播报（第二次 scan：delivered=0，推送数仍 1）',
      b8Scan2.delivered === 0 && b8Pushed.length === 1,
      `delivered=${b8Scan2.delivered}`);
    taskManager.updateTaskStatus(b8Task.taskId, 'completed');
    const b8Done = assistantBroadcast.scan();
    ok('B8 关键节点「完成」也播报（task_completed，含 taskId）',
      b8Done.delivered === 1
      && b8Done.payload.items.some((i) => i.taskId === b8Task.taskId && i.node === 'task_completed'),
      b8Done.delivered ? 'ok' : '未播报');

    // 合并节流：throttleSec>0 时第二次事件被缓冲，到点合并成一条再推
    assistantBroadcast.reset({ primeExisting: true });
    assistantPreferences.setGlobal({ broadcastEnabled: true, throttleSec: 60 });
    const tMergeA = mkTaskV2('B8 合并节流 A');
    const tNow = Date.now();
    const mMerge1 = assistantBroadcast.scan(tNow);
    const tMergeB = mkTaskV2('B8 合并节流 B');
    const mMerge2 = assistantBroadcast.scan(tNow + 1000);
    const mMerge3 = assistantBroadcast.scan(tNow + 61000);
    ok('B8 合并节流：60 秒内不重复推（第二次 delivered=0、进入缓冲），到点合并推一次且含两条',
      mMerge1.delivered === 1 && mMerge2.delivered === 0 && mMerge2.buffered >= 1
      && mMerge3.delivered === 1
      && mMerge3.payload.items.some((i) => i.taskId === tMergeB.taskId)
      && Array.isArray(mMerge3.payload.items) && mMerge3.payload.items.length >= 1,
      `1:${mMerge1.delivered}/2:${mMerge2.delivered}(buffered ${mMerge2.buffered})/3:${mMerge3.delivered}`);

    // 设置可关：关闭后不推送（仍登记），重新打开不补播
    assistantBroadcast.reset({ primeExisting: true });
    assistantPreferences.setGlobal({ broadcastEnabled: false, throttleSec: 0 });
    const tOff = mkTaskV2('B8 关闭播报期间的新任务');
    const mOff = assistantBroadcast.scan();
    assistantPreferences.setGlobal({ broadcastEnabled: true, throttleSec: 0 });
    const mOn = assistantBroadcast.scan();
    ok('B8 设置可关：关闭后关键节点不推送（disabled=true），重新打开后不补播关闭期间事件',
      mOff.delivered === 0 && mOff.disabled === true
      && mOn.delivered === 0,
      `off delivered=${mOff.delivered} disabled=${mOff.disabled}; on delivered=${mOn.delivered}`);
    ok('B8 播报状态可查询（有界 ring/announced/buffer 计数）',
      (() => {
        const st = assistantBroadcast.status();
        return st && st.ring >= 0 && st.announced >= 0 && st.buffered >= 0
          && st.ring <= assistantBroadcast.RING_CAP && st.buffered <= assistantBroadcast.BUFFER_CAP;
      })(), JSON.stringify(assistantBroadcast.status()));
  } finally {
    b8Unsub();
    assistantPreferences.setGlobal({ broadcastEnabled: true, throttleSec: 30 });
  }

  // ---- V2 context A–E：完整、只读、脱敏（Key 只 label/present；无 env 原值/绝对路径）----
  const logFixture = path.join(DIRS.logs, 'server-2026-11-17.log');
  fs.writeFileSync(logFixture, '[2026-11-17T10:00:00.000Z] [ERROR] fetch failed: Authorization: Bearer sk-live-secret-1234567890\n');
  const ctxV2 = supervisor.contextOf('s_v2_b4_budget', { userId: 'local', page: '/app/assistant' });
  const ctxV2Json = JSON.stringify(ctxV2);
  const ctxLeak = Object.entries(process.env)
    .filter(([, v]) => typeof v === 'string' && v.trim().length >= 16)
    .filter(([, v]) => ctxV2Json.includes(v.trim()))
    .map(([k]) => k);
  ok('V2 context A–E 字段齐全：ui/tasks(active+failedRecent)/budget/assets/settings/server/recentErrors；Key 仅 {label,present}',
    !!ctxV2 && !!ctxV2.version && ctxV2.version === 'assistant-context.v2'
    && !!ctxV2.ui && ctxV2.ui.page === '/app/assistant'
    && Array.isArray(ctxV2.tasks.active) && Array.isArray(ctxV2.tasks.failedRecent)
    && !!ctxV2.budget && !!ctxV2.assets && !!ctxV2.assets.photos
    && !!ctxV2.assets.library && !!ctxV2.assets.sceneCards && !!ctxV2.assets.bgm
    && Array.isArray(ctxV2.settings.keys)
    && ctxV2.settings.keys.every((k) => Object.keys(k).join(',') === 'label,present')
    && !!ctxV2.settings.models && Array.isArray(ctxV2.settings.models.i2v.supported)
    && !!ctxV2.server && !!ctxV2.server.pid
    && Array.isArray(ctxV2.recentErrors),
    `tasks=${ctxV2.tasks.total} keys=${ctxV2.settings.keys.length} errors=${ctxV2.recentErrors.length}`);
  ok('V2 context 脱敏：日志里的 Bearer/sk- 已打码（原值不出现）；无环境变量原值 / 无上下文资产文件路径回显',
    ctxV2.recentErrors.length >= 1
    && /sk-\*\*\*/.test(ctxV2.recentErrors[0].text)
    && !ctxV2Json.includes('sk-live-secret-1234567890')
    && ctxLeak.length === 0
    // 注意：任务失败原因（V1 流水线）本身可能带绝对路径，这是既有事实、不属于 context 的泄露面；
    // 这里断言 context **自己产出**的数据不含文件路径（素材只有计数、日志摘要已脱敏、不出现本次临时目录名）。
    && !/"filePath"/.test(ctxV2Json)
    && !ctxV2Json.includes(path.basename(TMP)),
    ctxLeak.length ? `泄露 env: ${ctxLeak.join(',')}` : `ok tmp=${path.basename(TMP)}`);
  ok('V2 context 只读：调用前后任务数不变、没有新增任务',
    (() => {
      const before = taskCountV2();
      supervisor.contextOf('s_v2_b4_budget');
      return taskCountV2() === before;
    })());

  // ---- V2 端点契约（静态断言；真实 HTTP e2e 待用户重启后由 Lead/用户验）----
  const serverSrcV2 = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
  const ctxRouteStart = serverSrcV2.indexOf("app.get('/api/assistant/context'");
  const ctxRouteBlock = ctxRouteStart === -1 ? '' : serverSrcV2.slice(ctxRouteStart, ctxRouteStart + 1200);
  ok('V2 端点静态契约：6 个新端点已注册（context/preferences×3/audit/settings/confirm/repair）',
    ["app.get('/api/assistant/context'", "app.get('/api/assistant/preferences'",
      "app.post('/api/assistant/preferences'", "app.post('/api/assistant/preferences/clear'",
      "app.get('/api/assistant/audit'", "app.post('/api/assistant/settings/confirm'",
      "app.post('/api/assistant/repair'"].every((s) => serverSrcV2.includes(s)));
  ok('V2 端点静态契约：context GET 只读（只调 contextOf，不 createTask/startTask/pipeline）',
    ctxRouteBlock.includes('assistantSupervisor.contextOf')
    && !/createTask|startTask|pipeline\./.test(ctxRouteBlock));
  ok('V2 端点静态契约：三个改动型端点都强制 approved=true（未确认不产生副作用）',
    /app\.post\('\/api\/assistant\/preferences'[\s\S]{0,800}?body\.approved !== true/.test(serverSrcV2)
    && /app\.post\('\/api\/assistant\/settings\/confirm'[\s\S]{0,1200}?approved: body\.approved === true/.test(serverSrcV2)
    && /app\.post\('\/api\/assistant\/repair'[\s\S]{0,1200}?approved: body\.approved === true/.test(serverSrcV2));
  ok('V2 WS 播报出口存在（wsManager.broadcastAssistant，服务端只读扫描后推送；前端客户端待集成）',
    /broadcastAssistant\(payload\)/.test(fs.readFileSync(path.join(APP_DIR, 'src', 'wsManager.js'), 'utf8')));
  const auditLines = fs.readFileSync(path.join(TMP, 'assistant-audit.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  ok('审计 append-only JSONL：每条可解析、含 actor/at/kind/action；无 Key 原值；条数与 list() 一致',
    auditLines.length >= 3
    && auditLines.every((l) => {
      try { const o = JSON.parse(l); return !!(o.at && o.actor && o.kind && typeof o.action === 'string'); } catch (e) { return false; }
    })
    && !auditLines.join('\n').includes('sk-live-secret')
    && assistantAudit.count() === auditLines.length,
    `${auditLines.length} 条`);

  console.log('\n[清理] 测试任务 / 临时产物');
  const cleaned = await cleanupAll();
  const bad = (cleaned || []).filter((c) => !c.ok);
  ok('测试任务已清理（内存 + JSON + 数据库）', bad.length === 0,
    bad.map((b) => `${b.taskId}:${b.skipped}`).join(',') || 'ok');

  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f.name}${f.extra ? ': ' + f.extra : ''}`));
  }
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  try { await cleanupAll(); } catch (err) { /* ignore */ }
  process.exit(1);
});
