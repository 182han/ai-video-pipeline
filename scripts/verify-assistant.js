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
const taskManager = require('../src/taskManager');
const library = require('../src/library');
const pipeline = require('../src/pipeline');
const budget = require('../src/budget');

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

  // ================= [1] 计划卡 =================
  console.log('\n[1] 计划卡：解析 / 上限 / 预算 / 补位上限');
  const p30 = planCard.buildPlan({ text: '来一条 30 分钟的极光视频，每段 10 秒' });
  ok('30 分钟极光 → 180 段 × 10 秒', p30.ok && p30.plan.clipCount === 180 && p30.plan.clipDurationSec === 10,
    p30.ok ? `${p30.plan.clipCount}×${p30.plan.clipDurationSec}` : p30.code);
  ok('场景卡默认开启且 180 张可容纳', p30.ok && p30.plan.sceneCards === true && p30.plan.totalSec === 1800);
  ok('主题识别 aurora + 中文标签', p30.ok && p30.plan.theme === 'aurora' && p30.plan.themeLabel === '极光');
  const pMulti = planCard.buildPlan({ text: '来一条 30 分钟的雪山、星空和极光视频，每段 10 秒' });
  ok('多主题长片：theme 取第一个，themeLabel 展示全部（不再显示成全是极光）',
    pMulti.ok && pMulti.plan.theme === 'mountain'
    && pMulti.plan.themeLabel === '雪山冰川、星空银河、极光'
    && pMulti.plan.clipCount === 180,
    pMulti.ok ? pMulti.plan.theme + ' / ' + pMulti.plan.themeLabel : pMulti.code);
  ok('预算：720p 30 分钟 = ¥1080，重试上限 ¥108（10%），最多 2 次',
    p30.ok && p30.plan.estimate.totalCny === 1080 && p30.plan.estimate.retryCapCny === 108
    && p30.plan.estimate.autoQcRetries === 2,
    p30.ok ? JSON.stringify({ total: p30.plan.estimate.totalCny, cap: p30.plan.estimate.retryCapCny, retries: p30.plan.estimate.autoQcRetries }) : '');
  ok('补位上限 = min(10, floor(180×5%)) = 9', p30.ok && p30.plan.fillMaxClips === 9);
  ok('付费任务标记 requiresPaymentApproval', p30.ok && p30.plan.requiresPaymentApproval === true && p30.plan.estimate.budget.usd === 180);
  ok('describe() 给出人话说明', planCard.describe(p30.plan).length >= 4,
    planCard.describe(p30.plan).slice(0, 2).join(' | '));

  const pHalf = planCard.buildPlan({ text: '半小时星空，1080p' });
  ok('「半小时」= 30 分钟，1080p 单价 ¥1.2/s → ¥2160',
    pHalf.ok && pHalf.plan.clipCount === 180 && pHalf.plan.resolution === '1080p'
    && pHalf.plan.estimate.totalCny === 2160 && pHalf.plan.theme === 'space',
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
  ok('kling 每段 20 秒（关闭场景卡）→ PLAN_BAD_CLIP_DURATION',
    planCard.buildPlan({ text: '10分钟极光，每段20秒', model: 'kling', sceneCards: false }).code === 'PLAN_BAD_CLIP_DURATION');
  ok('kling 每段 10 秒（关闭场景卡）→ 通过', planCard.buildPlan({ text: '10分钟极光，每段10秒', model: 'kling', sceneCards: false }).ok === true);
  ok('未知模型 → PLAN_UNKNOWN_MODEL', planCard.buildPlan({ text: '10分钟极光', model: 'nope' }).code === 'PLAN_UNKNOWN_MODEL');
  ok('非法分辨率 → PLAN_BAD_RESOLUTION', planCard.buildPlan({ text: '10分钟极光', resolution: '8k' }).code === 'PLAN_BAD_RESOLUTION');
  ok('确定性：同输入两次除 planId 外一致', (() => {
    const a = planCard.buildPlan({ text: '10分钟极光' }).plan;
    const b = planCard.buildPlan({ text: '10分钟极光' }).plan;
    const strip = (p) => { const q = { ...p }; delete q.planId; delete q.createdAt; return JSON.stringify(q); };
    return strip(a) === strip(b);
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
  ok('finals 参与检索并标 kind=final', (() => {
    const r = assistantMemory.retrieveTasks({ query: '上一次的视频', tasks: [], finals: [{ id: 'fin_1', kind: 'final', prompt: '成片 A', filePath: 'output/a.mp4', createdAt: new Date().toISOString() }] });
    return r.refs.length === 1 && r.refs[0].kind === 'final';
  })());

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
  } finally {
    Math.random = origRandom;
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
  ok('对话生成的是真实计费模型计划（dashscope）', !!planPay && planPay.model === 'dashscope'
    && planPay.requiresPaymentApproval === true, planPay && planPay.model);
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
  ok('面板显示名改为「小智」（旧的提示词助手标题已替换）',
    /<span className="text-\[12px\] font-medium text-ink">小智<\/span>/.test(assistantJs));
  ok('首页气泡只在创作页出现（currentRoute() === \'/\'）',
    /currentRoute\(\) === '\/'/.test(assistantJs));
  ok('shell.js 仍挂载 <Assistant />（小智是全局悬浮球）', /<\$\{Assistant\} \/>/.test(shellJs));

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
