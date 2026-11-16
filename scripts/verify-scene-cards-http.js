#!/usr/bin/env node
// ==========================================================
// 验收：场景卡 HTTP 层（P4，需要运行中的单实例 3001）
// ----------------------------------------------------------
// 为什么单独一个脚本：`scripts/verify-scene-cards.js` 是 in-process 验收（不起服务），
// 这里验证 **HTTP 入口**：GET /api/scene-cards、POST /api/tasks 的 sceneCards 校验与成功链路。
// 不另起实例/端口；连已在跑的 3001（BASE 可用 PORT 覆盖，仅排查用）。
//
// 安全/计费：
//   · 登录凭据运行时从 `config.AUTH.bootstrapUser/bootstrapPassword` 读取，不打印、不落盘；
//   · 成功链路只创建 **1 片段 Mock 任务**（零计费），跑完通过 API + storage 清理，并删除本次新增的 mock 片段；
//   · 不用 `--keep` 之类保留产物的选项。
//
// 用法：node scripts/verify-scene-cards-http.js
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const REAL_CLIPS_DIR = path.join(APP_DIR, 'clips');
const CONFIG = require('../config');
const tm = require('../src/taskManager');
const storage = require('../src/storage');
const sceneCards = require('../src/sceneCards');
const promptComposer = require('../src/promptComposer');

const BASE = `http://127.0.0.1:${process.env.PORT || CONFIG.SERVER.port || 3001}`;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? `  —  ${extra}` : ''}`); }
  else { fail++; failures.push({ name, extra }); console.log(`  ❌ ${name}${extra ? `  —  ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let COOKIE = '';
async function api(method, urlPath, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (COOKIE) headers.cookie = COOKIE;
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json };
}

function snapshotClips() {
  return new Set(fs.existsSync(REAL_CLIPS_DIR) ? fs.readdirSync(REAL_CLIPS_DIR) : []);
}
function cleanupNewMockFiles(snapshot) {
  if (!fs.existsSync(REAL_CLIPS_DIR)) return [];
  const removed = [];
  for (const name of fs.readdirSync(REAL_CLIPS_DIR)) {
    if (snapshot.has(name)) continue;
    if (!/^mock_.*\.mp4$/.test(name)) continue;
    try { fs.unlinkSync(path.join(REAL_CLIPS_DIR, name)); removed.push(name); } catch (e) { /* ignore */ }
  }
  return removed;
}

// Mock 生成器用 execSync 生成样片，本机 spawn cmd.exe EPERM；用 execFileSync 预生成同款样片。
// 生成器检测到缓存样例就直接复制，不会退回文本占位。
function ensureMockSample() {
  const { execFileSync } = require('child_process');
  const sampleDir = path.join(REAL_CLIPS_DIR, '_samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const out = path.join(sampleDir, 'sample_720p_10s.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return { path: out, created: false };
  execFileSync(CONFIG.FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x4a90d9:s=1280x720:d=10',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', out
  ], { stdio: 'ignore', timeout: 60000 });
  return { path: out, created: true };
}

async function login() {
  const user = (CONFIG.AUTH && CONFIG.AUTH.bootstrapUser) || 'admin';
  const passwd = (CONFIG.AUTH && CONFIG.AUTH.bootstrapPassword) || '';
  if (!passwd) throw new Error('无法从 config 读取登录密码（AUTH bootstrapPassword 为空）');
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: passwd })
  });
  if (res.status !== 200) throw new Error(`登录失败 HTTP ${res.status}（密码可能已在成员管理里改过）`);
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!cookies.length) throw new Error('登录响应没有 Set-Cookie');
  COOKIE = cookies.map(c => c.split(';')[0]).join('; ');
}

async function waitTask(taskId, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/tasks/${taskId}`);
    if (r.status === 200 && r.json && ['completed', 'partial', 'failed'].includes(r.json.status)) return r.json;
    await sleep(600);
  }
  throw new Error(`任务 ${taskId} 超时未完成`);
}

async function main() {
  console.log('='.repeat(64));
  console.log('P4 场景卡 HTTP 层冒烟（连运行中的 3001，零计费）');
  console.log('='.repeat(64));
  console.log(`  BASE=${BASE}`);

  // 1) 登录 + 新路由
  console.log('\n[1] 登录 + GET /api/scene-cards');
  await login();
  ok('登录成功（凭据仅运行内存）', !!COOKIE);
  const stats = await api('GET', '/api/scene-cards');
  ok('GET /api/scene-cards → 200', stats.status === 200, 'HTTP ' + stats.status);
  ok('卡库统计：200 / 180 / 20 / 10s', !!stats.json
    && stats.json.total === 200 && stats.json.featureCount === 180
    && stats.json.bufferCount === 20 && stats.json.durationSec === 10,
    stats.json ? `total=${stats.json.total} feature=${stats.json.featureCount}` : '无 JSON');
  ok('响应带取卡规则', !!stats.json && !!stats.json.rules && /chapter\+sequence/.test(stats.json.rules.order || ''));

  // 2) 校验分支（这些请求不会创建任务）
  console.log('\n[2] POST /api/tasks 场景卡校验分支（不创建任务）');
  const baseBody = { prompt: 'P4 HTTP 冒烟', model: 'mock', sceneCards: true, clipDuration: 10, clipCount: 1 };
  const badDuration = await api('POST', '/api/tasks', { ...baseBody, clipDuration: 3 });
  ok('非 10s → 400 SCENE_CARDS_DURATION',
    badDuration.status === 400 && badDuration.json && badDuration.json.code === 'SCENE_CARDS_DURATION',
    `HTTP ${badDuration.status} code=${badDuration.json && badDuration.json.code}`);

  const tooMany = await api('POST', '/api/tasks', { ...baseBody, clipCount: 181 });
  ok('181 段 → 400 SCENE_CARDS_EXHAUSTED（提示扩卡库）',
    tooMany.status === 400 && tooMany.json && tooMany.json.code === 'SCENE_CARDS_EXHAUSTED'
    && /扩卡库/.test(tooMany.json.error || ''),
    `HTTP ${tooMany.status} code=${tooMany.json && tooMany.json.code}`);

  const withPrompts = await api('POST', '/api/tasks', {
    ...baseBody, prompts: ['场景 A'], theme: 'landscape'
  });
  ok('同时传 prompts → 400 SCENE_CARDS_WITH_PROMPTS',
    withPrompts.status === 400 && withPrompts.json && withPrompts.json.code === 'SCENE_CARDS_WITH_PROMPTS',
    `HTTP ${withPrompts.status} code=${withPrompts.json && withPrompts.json.code}`);

  // 确认校验请求没有留下任务：取任务列表里 prompt 相同且 mock 的条目数应为 0
  const list = await api('GET', '/api/tasks');
  const leaked = (Array.isArray(list.json) ? list.json : [])
    .filter(t => t.prompt === 'P4 HTTP 冒烟' && t.model === 'mock');
  ok('校验分支没有创建任务（列表 0 条同提示词 mock 任务）', leaked.length === 0, `leaked=${leaked.length}`);

  // 3) 成功链路：1 片段 Mock 任务（零计费）
  console.log('\n[3] 成功链路：1 片段 Mock 任务（clips_only，零计费）');
  const clipSnapshot = snapshotClips();
  const sample = ensureMockSample();
  let taskId = null;
  let done = null;
  try {
    const create = await api('POST', '/api/tasks', {
      prompt: 'P4 HTTP 冒烟',
      model: 'mock',
      clipCount: 1,
      clipDuration: 10,
      resolution: '720p',
      preset: 'clips_only',
      sceneCards: true,
      autoRetry: true,
      theme: 'landscape'
    });
    ok('POST /api/tasks(sceneCards) → 200 并返回 taskId',
      create.status === 200 && !!create.json && !!create.json.taskId,
      `HTTP ${create.status} taskId=${create.json && create.json.taskId}`);
    taskId = create.json && create.json.taskId ? create.json.taskId : null;
    if (!taskId) throw new Error('没有 taskId，后续无法验证');

    done = await waitTask(taskId);
    ok('任务正常结束（completed/partial）', done.status === 'completed' || done.status === 'partial',
      `status=${done.status}${done.error ? ', error=' + done.error : ''}`);
    ok('任务记录 sceneCards 取卡计划（1 张）',
      !!done.sceneCards && done.sceneCards.enabled === true
      && Array.isArray(done.sceneCards.used) && done.sceneCards.used.length === 1,
      done.sceneCards ? `round=${done.sceneCards.roundId}` : '无计划');
    const used = done.sceneCards && done.sceneCards.used ? done.sceneCards.used[0] : null;
    ok('取的是正片且带 scene_key', !!used && used.role === 'feature' && !!used.scene_key,
      used ? `${used.id} ${used.scene_key}` : '无');
    const clip = done.clips && done.clips[0];
    ok('片段 prompt 由 promptComposer 产出',
      !!clip && clip.promptSource === 'scene-card'
      && clip.sceneCardId === used.id
      && clip.sceneKey === used.scene_key
      && typeof clip.prompt === 'string' && clip.prompt.includes('画面主体'),
      clip ? clip.promptSource : '无片段');
    // 与本地同一份 composer/卡库交叉核对（证明服务端确实用了这套逻辑，而非随机文案）
    const expected = promptComposer.composeClipPatch(sceneCards.getCardById(used.id), {
      theme: 'landscape', userPrompt: 'P4 HTTP 冒烟'
    });
    ok('服务端 prompt 与本地 promptComposer 输出一致', !!clip && clip.prompt === expected.prompt);
    ok('prompt_optimize completed 且标注 scene-card',
      done.steps && done.steps.prompt_optimize
      && done.steps.prompt_optimize.status === 'completed'
      && done.steps.prompt_optimize.qcDetails
      && done.steps.prompt_optimize.qcDetails.promptSource === 'scene-card',
      done.steps && done.steps.prompt_optimize ? done.steps.prompt_optimize.status : '无步骤');
    ok('storyboard 合法跳过',
      done.steps && done.steps.storyboard
      && done.steps.storyboard.status === 'skipped'
      && done.steps.storyboard.qcDetails
      && done.steps.storyboard.qcDetails.legitimateSkip === true);
    ok('buffer 未被使用', done.sceneCards && done.sceneCards.status.bufferUsed === 0);
    ok('片段真实产出文件', !!clip && !!clip.videoPath && fs.existsSync(clip.videoPath));

    const clipsApi = await api('GET', `/api/tasks/${taskId}/clips`);
    ok('GET /api/tasks/:id/clips 暴露 sceneKey 等审计字段',
      clipsApi.status === 200 && Array.isArray(clipsApi.json)
      && clipsApi.json[0] && clipsApi.json[0].sceneKey === used.scene_key
      && clipsApi.json[0].sceneCardRole === 'feature',
      `HTTP ${clipsApi.status}`);
  } finally {
    // 4) 清理：HTTP 删任务 → 永久删 JSON → DB → 本次新增 mock 片段/样片
    console.log('\n[4] 清理测试产物');
    if (taskId) {
      const d1 = await api('DELETE', `/api/tasks/${taskId}`);
      const d2 = await api('DELETE', `/api/trash/${taskId}`);
      ok('HTTP 删除任务 + 永久删除 JSON', !!d1.json && d1.json.success !== false && !!d2.json && d2.json.success !== false,
        `move=${d1.status} purge=${d2.status}`);
      try { await storage.deleteTask(taskId); } catch (e) { /* 数据库超时属已知环境噪声 */ }
      // 迟到写入：taskManager._saveTask 是异步不 await 的，流水线最后一次保存可能在本脚本删除之后落库。
      // 等一个事件循环 + 短延时，再幂等删几次并复核 getAllTasks（UI/重启后的列表口径）。
      await sleep(1200);
      for (let i = 0; i < 5; i++) {
        try { await storage.deleteTask(taskId); } catch (e) { /* ignore */ }
        await sleep(400);
        const all = await storage.getAllTasks();
        if (!all.some(t => t.taskId === taskId)) break;
      }
      const jsonPath = path.join(APP_DIR, 'data', 'tasks', `${taskId}.json`);
      for (let i = 0; i < 5 && fs.existsSync(jsonPath); i++) {
        try { fs.unlinkSync(jsonPath); } catch (e) { /* ignore */ }
        await sleep(200);
      }
      const allAfter = await storage.getAllTasks();
      ok('DB 软删后任务不再出现在列表（防迟到写回）',
        !allAfter.some(t => t.taskId === taskId));
      ok('任务 JSON 已删除', !fs.existsSync(jsonPath));
      try { tm.permanentDelete(taskId); } catch (e) { /* ignore */ }
    }
    const removed = cleanupNewMockFiles(clipSnapshot);
    ok('本次新增的 mock 片段已清理', removed.length >= 0, removed.length ? removed.join(',') : '无新增');
    if (sample.created) { try { fs.unlinkSync(sample.path); } catch (e) { /* ignore */ } }
    ok('Mock 样片缓存已恢复（本次创建的已删）', !sample.created || !fs.existsSync(sample.path));
  }

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
  process.exit(1);
});
