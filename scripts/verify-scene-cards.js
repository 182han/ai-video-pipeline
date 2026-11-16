#!/usr/bin/env node
// ==========================================================
// 验收：场景卡接入运行时（P4）
// ----------------------------------------------------------
// 覆盖三块：
//   1) 卡库读取与校验：v3.3 = 200 张（180 feature + 20 buffer）、scene_key 唯一 180、
//      chapter+sequence 严格递增；坏卡库（schema/重复 key/乱序）必须被拒。
//   2) 取卡规则：连续取满 180 张 —— scene_key 唯一、顺序符合 chapter+sequence、
//      buffer 未被误用；超过 180 抛 SCENE_CARDS_EXHAUSTED（不静默复用）；
//      buffer 只在替换时使用、同一任务不复用、用尽返回 null。
//   3) promptComposer：卡 + 主题拼 image/video 提示词、确定性、不写回卡、
//      palette_id 参数化调色（adjustChain 可接受、不出现 .cube/.lut 资源）。
//   4) Mock 任务端到端（真实流水线，in-process，不起第二实例）：
//      task.sceneCards 记录 scene_key、clips[i].prompt 由 promptComposer 产出、
//      storyboard 合法跳过、clip_generation 完成、产物文件真实存在。
//
// 隔离：CLIPS_DIR / OUTPUT_DIR / DATA_DIR / LIBRARY_DIR / PHOTOS_DIR / PROJECTS_DIR
// 全部指向 data/tmp-verify-scene-* 临时目录（本机 ffmpeg 不能写系统临时目录），
// 测试任务结束后用 scripts/_test-cleanup.js 清理（内存 + JSON + 数据库）。
// 不使用任何真实计费接口：model=mock。
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(APP_DIR, 'data', 'tmp-verify-scene-'));
const DIRS = {
  clips: path.join(TMP, 'clips'),
  output: path.join(TMP, 'output'),
  tasks: path.join(TMP, 'tasks'),
  library: path.join(TMP, 'library'),
  photos: path.join(TMP, 'photos'),
  projects: path.join(TMP, 'projects')
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// 必须先设 env 再 require 业务模块（config 在 require 时读取）
process.env.CLIPS_DIR = DIRS.clips;
process.env.OUTPUT_DIR = DIRS.output;
process.env.DATA_DIR = DIRS.tasks;
process.env.LIBRARY_DIR = DIRS.library;
process.env.PHOTOS_DIR = DIRS.photos;
process.env.PROJECTS_DIR = DIRS.projects;
// 本套件只验证场景卡取卡/提示词接线，不验证存储驱动：用 json 驱动隔离到临时目录，
// 避免把 mock 任务写进真实数据库（也避开本机数据库间歇超时的噪声）。
process.env.DATABASE_TYPE = 'json';

// Mock 生成器用 execSync 生成样片，本机 spawn cmd.exe 会 EPERM（AGENTS §2.3 已知环境限制）。
// MockGenerator 的样片目录固定在 app/clips/_samples（不读 CLIPS_DIR），所以这里用
// execFileSync（无 shell、不捕获 stdout）预生成 720p/10s 样片；生成器检测到缓存就复制，
// 不会退回文本占位。样片与 mock_*.mp4 都是本次验收的一次性产物，结束后清理。
const REAL_CLIPS_DIR = path.join(APP_DIR, 'clips');
const clipsSnapshot = new Set(
  fs.existsSync(REAL_CLIPS_DIR) ? fs.readdirSync(REAL_CLIPS_DIR) : []
);
function prepareMockSample() {
  const { execFileSync } = require('child_process');
  const config = require('../config');
  const sampleDir = path.join(REAL_CLIPS_DIR, '_samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const out = path.join(sampleDir, 'sample_720p_10s.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return { path: out, created: false };
  execFileSync(config.FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x4a90d9:s=1280x720:d=10',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', out
  ], { stdio: 'ignore', timeout: 60000 });
  return { path: out, created: true };
}
const MOCK_SAMPLE = prepareMockSample();
function cleanupMockArtifacts() {
  if (!fs.existsSync(REAL_CLIPS_DIR)) return;
  for (const name of fs.readdirSync(REAL_CLIPS_DIR)) {
    if (clipsSnapshot.has(name)) continue;
    if (!/^mock_.*\.mp4$/.test(name)) continue;
    try { fs.unlinkSync(path.join(REAL_CLIPS_DIR, name)); } catch (e) { /* ignore */ }
  }
  if (MOCK_SAMPLE.created) {
    try { fs.unlinkSync(MOCK_SAMPLE.path); } catch (e) { /* ignore */ }
  }
}

const sceneCards = require('../src/sceneCards');
const promptComposer = require('../src/promptComposer');
const adjustChain = require('../src/processors/adjustChain');
const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? `  —  ${extra}` : ''}`);
  } else {
    fail++;
    failures.push({ name, extra });
    console.log(`  ❌ ${name}${extra ? `  —  ${extra}` : ''}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitDone(taskId, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = taskManager.getTask(taskId);
    if (!t) throw new Error('任务丢失');
    if (['completed', 'partial', 'failed'].includes(t.status)) return t;
    await sleep(400);
  }
  throw new Error(`任务 ${taskId} 超时未完成，当前状态 ${taskManager.getTask(taskId).status}`);
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(obj);
}

function cardHash(card) {
  return JSON.stringify(card);
}

async function main() {
  console.log('='.repeat(64));
  console.log('P4 场景卡接入运行时 — 验收');
  console.log('='.repeat(64));

  // ================= 1. 卡库结构 =================
  console.log('\n[1] 卡库读取与校验');
  const stats = sceneCards.getStats();
  ok('统计：200 张（180 正片 + 20 缓冲）',
    stats.total === 200 && stats.featureCount === 180 && stats.bufferCount === 20,
    `total=${stats.total} feature=${stats.featureCount} buffer=${stats.bufferCount}`);
  ok('schema = scene-card.v3.3', stats.schemaVersion === 'scene-card.v3.3', stats.schemaVersion);
  ok('每段 10 秒（30 分钟 = 180 张）', stats.durationSec === 10 && stats.maxClipsPerTask === 180,
    `duration=${stats.durationSec} max=${stats.maxClipsPerTask}`);
  ok('正片 scene_key 唯一 180', stats.sceneKeyUnique === 180, String(stats.sceneKeyUnique));

  const lib = sceneCards.loadLibrary();
  ok('正片按 chapter+sequence 严格递增', (() => {
    let prev = null;
    for (const c of lib.features) {
      if (prev && (c.chapter < prev.chapter
        || (c.chapter === prev.chapter && c.sequence <= prev.sequence))) return false;
      prev = c;
    }
    return true;
  })(), `首张 ${lib.features[0].chapter}:${lib.features[0].sequence} 末张 ${lib.features[179].chapter}:${lib.features[179].sequence}`);

  // 坏卡库负向：用临时副本注入，验证错误码而不是崩溃
  const rawGood = JSON.parse(fs.readFileSync(sceneCards.CARD_FILE, 'utf8'));
  const badCases = [];
  {
    const raw = JSON.parse(JSON.stringify(rawGood));
    raw.schemaVersion = 'scene-card.v9.9';
    badCases.push({ name: 'schema 不符 → SCENE_CARDS_INVALID', raw });
  }
  {
    const raw = JSON.parse(JSON.stringify(rawGood));
    const feats = raw.cards.filter(c => c.role === 'feature');
    feats[1].scene_key = feats[0].scene_key;
    badCases.push({ name: '正片 scene_key 重复 → SCENE_CARDS_INVALID', raw });
  }
  {
    const raw = JSON.parse(JSON.stringify(rawGood));
    const feats = raw.cards.filter(c => c.role === 'feature');
    // 把第一张的 chapter 提到很后面，构造明确乱序（后续修复顺序断言真正被执行）
    feats[0].chapter = feats[1].chapter + 10;
    badCases.push({ name: '正片 chapter/sequence 乱序 → SCENE_CARDS_INVALID', raw });
  }
  for (let i = 0; i < badCases.length; i++) {
    const c = badCases[i];
    const file = path.join(TMP, `bad-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(c.raw), 'utf8');
    let err = null;
    try { sceneCards.loadLibrary({ file }); } catch (e) { err = e; }
    ok(c.name, !!err && err.code === 'SCENE_CARDS_INVALID', err ? err.code : '未抛错');
  }

  // ================= 2. 取满 180 张 =================
  console.log('\n[2] 连续取满 180 张：顺序 / 唯一 / buffer 未误用');
  const plan180 = sceneCards.allocate(180);
  const entries = plan180.used;
  ok('取满 180 张', entries.length === 180, String(entries.length));
  const keySet = new Set(entries.map(e => e.scene_key));
  ok('scene_key 唯一 180（不放回）', keySet.size === 180, `unique=${keySet.size}`);
  ok('全部来自正片（buffer 未被误用）',
    entries.every(e => e.role === 'feature'), `roles=${[...new Set(entries.map(e => e.role))].join(',')}`);
  ok('顺序符合 chapter+sequence 且与卡库一致', (() => {
    let prev = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const card = lib.features[i];
      if (e.id !== card.id || e.scene_key !== card.scene_key) return false;
      if (prev && (e.chapter < prev.chapter
        || (e.chapter === prev.chapter && e.sequence <= prev.sequence))) return false;
      prev = e;
    }
    return true;
  })(), `第1张 ${entries[0].chapter}:${entries[0].sequence} 第180张 ${entries[179].chapter}:${entries[179].sequence}`);
  ok('首张 = chapter 1 / sequence 1', entries[0].chapter === 1 && entries[0].sequence === 1,
    `${entries[0].id} ${entries[0].scene_key}`);
  ok('末张 = chapter 6 / sequence 30', entries[179].chapter === 6 && entries[179].sequence === 30,
    `${entries[179].id} ${entries[179].scene_key}`);
  ok('状态：used=180 / remaining=0 / exhausted=true',
    plan180.status.used === 180 && plan180.status.remaining === 0 && plan180.status.exhausted === true,
    JSON.stringify(plan180.status));
  ok('初始分配不消耗缓冲区（bufferUsed=0）', plan180.status.bufferUsed === 0);

  // 超过 180：必须报错，不静默复用/截断
  let over = null;
  try { sceneCards.allocate(181); } catch (e) { over = e; }
  ok('取 181 张 → SCENE_CARDS_EXHAUSTED（提示扩卡库）',
    !!over && over.code === 'SCENE_CARDS_EXHAUSTED' && /扩卡库/.test(over.message),
    over ? over.message : '未抛错');
  let zero = null;
  try { sceneCards.allocate(0); } catch (e) { zero = e; }
  ok('取 0 张 → SCENE_CARDS_BAD_COUNT', !!zero && zero.code === 'SCENE_CARDS_BAD_COUNT',
    zero ? zero.code : '未抛错');
  ok('容量预检 checkCapacity(181) 同样拒绝',
    sceneCards.checkCapacity(181).ok === false && sceneCards.checkCapacity(181).code === 'SCENE_CARDS_EXHAUSTED');
  ok('两次取卡互不影响（每条任务一轮，均从第 1 张开始）', (() => {
    const a = sceneCards.allocate(3);
    const b = sceneCards.allocate(3);
    return a.roundId !== b.roundId
      && a.used[0].id === b.used[0].id
      && a.buffers.length === 0 && b.buffers.length === 0;
  })());

  // ================= 3. buffer 替换 =================
  console.log('\n[3] buffer 替换：只在失败时、同一任务不复用、用尽返回 null');
  const plan3 = sceneCards.allocate(3);
  const original = plan3.used[1];
  const rep1 = sceneCards.replaceWithBuffer(plan3, 1, '生成失败：模拟 timeout');
  ok('替换成功并返回 buffer 卡', !!rep1 && !!rep1.card && rep1.card.role === 'buffer',
    rep1 ? `${rep1.card.id} ${rep1.card.scene_key}` : '返回 null');
  ok('替换后该段 role=buffer，且保留原始正片审计', !!rep1
    && plan3.used[1].role === 'buffer'
    && plan3.used[1].replacedFrom
    && plan3.used[1].replacedFrom.id === original.id
    && plan3.used[1].replacedFrom.scene_key === original.scene_key,
    JSON.stringify(plan3.used[1].replacedFrom || null));
  ok('buffer 列表只记 1 条 + replacements 留痕 1 条',
    plan3.buffers.length === 1 && plan3.replacements.length === 1
    && plan3.status.bufferUsed === 1 && plan3.status.bufferRemaining === 19);
  ok('同一段已经替换过 → 再替换返回 null（不二次替换）',
    sceneCards.replaceWithBuffer(plan3, 1, 'again') === null);
  const rep2 = sceneCards.replaceWithBuffer(plan3, 0, '另一段失败');
  ok('另一段替换到不同的 buffer（同一任务不复用）',
    !!rep2 && rep2.card.id !== rep1.card.id && plan3.buffers.length === 2,
    rep2 ? `${rep1.card.id} vs ${rep2.card.id}` : '返回 null');
  ok('替换后 scene_key 仍唯一（buffer 替换不制造重复键）', (() => {
    const p = sceneCards.allocate(20);
    for (let i = 0; i < 2; i++) sceneCards.replaceWithBuffer(p, i, '失败');
    return new Set(p.used.map(e => e.scene_key)).size === p.used.length;
  })());

  const plan21 = sceneCards.allocate(21);
  let bufferOk = true;
  for (let i = 0; i < 20; i++) {
    if (!sceneCards.replaceWithBuffer(plan21, i, '失败')) { bufferOk = false; break; }
  }
  const exhausted = plan21.status;
  const extra = sceneCards.replaceWithBuffer(plan21, 20, '第 21 段失败');
  ok('20 张 buffer 可全部用于替换', bufferOk && exhausted.bufferUsed === 20 && exhausted.bufferRemaining === 0,
    JSON.stringify(exhausted));
  ok('buffer 用尽后返回 null（不静默复用）', extra === null);

  // ================= 4. promptComposer =================
  console.log('\n[4] promptComposer：拼提示词 / 确定性 / 不写回卡 / 参数化调色');
  const sample = sceneCards.getCardById(plan180.used[5].id);
  const frozen = deepFreeze(JSON.parse(JSON.stringify(sample)));
  const before = cardHash(frozen);
  let patch = null;
  let frozenErr = null;
  try {
    patch = promptComposer.composeClipPatch(frozen, { theme: 'landscape', userPrompt: '极光下的海岸' });
  } catch (e) { frozenErr = e; }
  ok('对冻结的卡拼提示词不抛错', !frozenErr, frozenErr ? frozenErr.message : '');
  ok('卡内容未被修改（只读输入）', cardHash(frozen) === before);
  ok('video 提示词包含卡的主体与镜头信息', !!patch
    && patch.prompt.includes(sample.protagonist)
    && patch.prompt.includes('镜头：'), patch ? patch.prompt.slice(0, 80) + '…' : '无');
  ok('image 提示词含 16:9 / 安全区', !!patch
    && patch.imagePrompt.includes('16:9')
    && /安全区/.test(patch.imagePrompt));
  ok('提示词带主题标签（landscape → 自然风景）', !!patch && patch.prompt.includes('自然风景'));
  ok('提示词带卡库收尾约束', !!patch && patch.prompt.includes(sample.end_lock));
  ok('前景前缀不重复（无「前景：前景：」）', !!patch
    && !patch.prompt.includes('前景：前景')
    && !patch.imagePrompt.includes('前景：前景'));
  ok('负向词已归一化（无「无人物」整句）', !!patch
    && !patch.negativePrompt.includes('无人物')
    && patch.negativePrompt.includes('人物'), patch ? patch.negativePrompt.slice(0, 80) : '无');
  ok('clipPatch 记录审计字段', !!patch
    && patch.promptSource === 'scene-card'
    && patch.sceneKey === sample.scene_key
    && patch.sceneCardId === sample.id
    && patch.sceneCard
    && patch.sceneCard.scene_key === sample.scene_key);
  ok('确定性：同卡同主题两次拼出同一提示词', (() => {
    const a = promptComposer.compose(frozen, { theme: 'landscape', userPrompt: '极光下的海岸' });
    const b = promptComposer.compose(frozen, { theme: 'landscape', userPrompt: '极光下的海岸' });
    return a.videoPrompt === b.videoPrompt && a.imagePrompt === b.imagePrompt;
  })());
  ok('提示词不超过 2400 字符',
    patch.prompt.length <= promptComposer.MAX_PROMPT_CHARS
    && patch.imagePrompt.length <= promptComposer.MAX_PROMPT_CHARS,
    `video=${patch.prompt.length} image=${patch.imagePrompt.length}`);
  ok('palette_id 用参数化调色（不引入 LUT 资源）', (() => {
    const palettes = promptComposer.listPalettes();
    if (palettes.length !== 3) return false;
    for (const pid of palettes) {
      const params = promptComposer.paletteAdjust(pid);
      if (!params || !adjustChain.hasAdjust(params)) return false;
      let normalized = null;
      try { normalized = adjustChain.normalizeParams(params); } catch (e) { return false; }
      if (!normalized) return false;
      for (const v of Object.values(params)) {
        if (typeof v !== 'number' || v < -50 || v > 50) return false;
      }
    }
    // 提示词里不得出现 .cube / lut3d 之类的 LUT 资源引用
    return !/\.cube|\.lut\b|lut3d/i.test(patch.prompt)
      && !/\.cube|\.lut\b|lut3d/i.test(patch.imagePrompt);
  })(), `palettes=${promptComposer.listPalettes().join(',')}`);
  ok('未知 palette_id 返回 null（不臆造参数）', promptComposer.paletteAdjust('not-a-palette') === null);

  // ================= 5. Mock 任务端到端 =================
  console.log('\n[5] Mock 任务端到端（真实流水线，零计费）');
  ok('Mock 样片已就绪（绕过本机 execSync EPERM）',
    fs.existsSync(MOCK_SAMPLE.path) && fs.statSync(MOCK_SAMPLE.path).size > 1024,
    MOCK_SAMPLE.path);
  const userPrompt = '极光下的海岸与雪山';
  const task = taskManager.createTask(userPrompt, {
    model: 'mock',
    totalClips: 3,
    clipDuration: 10,
    resolution: '720p',
    theme: 'landscape',
    preset: 'clips_only',
    autoRetry: true,
    sceneCards: { enabled: true }
  });
  let taskId = task.taskId;
  ok('创建任务即写入 sceneCards 计划',
    !!task.sceneCards && task.sceneCards.enabled === true && task.sceneCards.used.length === 3,
    task.sceneCards ? `round=${task.sceneCards.roundId}` : '无计划');
  ok('任务 scene_key 顺序与卡库一致', (() => {
    if (!task.sceneCards) return false;
    return task.sceneCards.used.every((e, i) => e.id === plan180.used[i].id
      && e.scene_key === plan180.used[i].scene_key);
  })());
  ok('初始分配未用 buffer', task.sceneCards && task.sceneCards.status.bufferUsed === 0);
  const expectedPatches = task.sceneCards.used.map((e, i) => promptComposer.composeClipPatch(
    sceneCards.getCardById(e.id),
    { theme: 'landscape' }
  ));
  ok('每个 clip 的 prompt 由 promptComposer 产出（卡 + 显式主题，不含用户整句）',
    task.clips.every((c, i) => c.prompt === expectedPatches[i].prompt
      && c.promptSource === 'scene-card'
      && c.sceneKey === expectedPatches[i].sceneKey),
    task.clips.map(c => c.promptSource).join(','));

  // Mock 生成器有 10% 随机失败率：验收只关掉随机失败，不改任何判定逻辑。
  const origRandom = Math.random;
  let rseed = 0;
  Math.random = () => { rseed = (rseed + 1) % 100; return 0.9 + rseed / 1000; };
  let done = null;
  try {
    pipeline.startTask(taskId);
    done = await waitDone(taskId);
  } finally {
    Math.random = origRandom;
  }
  ok('流水线正常结束（非 failed）', done.status === 'completed' || done.status === 'partial',
    `status=${done.status}${done.error ? ', error=' + done.error : ''}`);
  ok('prompt_optimize 步骤 completed 且标注 promptSource=scene-card',
    done.steps.prompt_optimize.status === 'completed'
    && done.steps.prompt_optimize.qcDetails
    && done.steps.prompt_optimize.qcDetails.promptSource === 'scene-card',
    `status=${done.steps.prompt_optimize.status}`);
  ok('prompt_optimize 记录了本轮 3 个 scene_key', (() => {
    const keys = done.steps.prompt_optimize.qcDetails
      && done.steps.prompt_optimize.qcDetails.sceneKeys;
    return Array.isArray(keys) && keys.length === 3
      && keys.every((k, i) => k === done.sceneCards.used[i].scene_key);
  })());
  ok('storyboard 按场景卡合法跳过（not passed）',
    done.steps.storyboard.status === 'skipped'
    && done.steps.storyboard.qcDetails
    && done.steps.storyboard.qcDetails.legitimateSkip === true
    && /场景卡/.test(done.steps.storyboard.qcDetails.reason || ''),
    done.steps.storyboard.status);
  ok('clip_generation 步骤完成', done.steps.clip_generation.status === 'completed',
    done.steps.clip_generation.status);
  ok('3 个片段全部成功且文件存在', done.clips.length === 3
    && done.clips.every(c => c.status === 'success' && c.videoPath && fs.existsSync(c.videoPath)),
    done.clips.map(c => c.status).join(','));
  ok('每个片段的 prompt 仍是 promptComposer 产出',
    done.clips.every((c, i) => c.prompt === expectedPatches[i].prompt && c.promptSource === 'scene-card'));
  ok('任务 scene_key 完整记录且唯一', (() => {
    const keys = done.sceneCards.used.map(e => e.scene_key);
    return keys.length === 3 && new Set(keys).size === 3;
  })());
  ok('本次任务未触发 buffer 替换', done.sceneCards.status.bufferUsed === 0
    && done.clips.every(c => !c.sceneCardReplacement));
  ok('clips_only 不产出成片（fragmentOnly）', done.fragmentOnly === true && !done.outputPath);

  // ================= 清理 =================
  const { cleanupMany } = require('./_test-cleanup');
  const cleaned = await cleanupMany([taskId], taskManager);
  const badClean = cleaned.filter(c => !c.ok);
  ok('测试任务已清理（内存 + JSON + 数据库）', badClean.length === 0,
    badClean.map(c => `${c.taskId}:${c.skipped}`).join(',') || 'ok');
  cleanupMockArtifacts();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  // ================= 汇总 =================
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.extra ? ': ' + f.extra : ''}`));
  }
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  try { cleanupMockArtifacts(); } catch (err) { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  process.exit(1);
});
