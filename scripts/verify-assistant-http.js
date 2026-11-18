#!/usr/bin/env node
// ==========================================================
// 验收：小智（P5）HTTP 层 —— 临时隔离实例（不是 3001，不碰用户服务）
// ----------------------------------------------------------
// 背景：本机 3001 由用户持有，另一个窗口可能改不动（Access denied）；
//       但新接口必须在真实 HTTP 栈上验证，不能只靠 in-process 模块测试。
// 做法（沿用 verify-frontend-contract / verify-scene-cards-http 的模式）：
//   1) 挑一个空闲端口（3093 起），spawn 一个**临时实例**：PORT=xxxx、
//      AUTH_ENABLED=false、所有数据目录指向 data/tmp-verify-assistant-http_*；
//   2) 逐条打 /api/assistant/*：info / message / execute / state / memory / asr / understand；
//   3) 跑 1 段 Mock 任务（零计费）直到状态机 done，验成片文件存在；
//   4) finally：kill 临时进程 + 删临时目录 + 清理本次新增的 mock 样片。
//
// 明确不做：不杀死 3001、不复制 app/、不写真实库/真实输出、不调用任何计费模型。
//
// 用法：cd app && node scripts/verify-assistant-http.js
// 退出码 0 = 全部通过；非 0 = 有失败。
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(APP_DIR, 'data', 'tmp-verify-assistant-http_'));
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

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? `  —  ${extra}` : ''}`); }
  else { fail++; failures.push({ name, extra }); console.log(`  ❌ ${name}${extra ? `  —  ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickFreePort(start) {
  for (let p = start; p < start + 40; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(300) });
      if (!r) continue; // 有响应 = 被占用
    } catch (e) {
      if (e && (e.code === 'ECONNREFUSED' || String(e.message || '').includes('fetch failed') || e.name === 'TimeoutError')) {
        return p;
      }
    }
  }
  return null;
}

// Mock 样片（MockGenerator 读 app/clips/_samples；本机 execSync pipe EPERM）
const REAL_CLIPS_DIR = path.join(APP_DIR, 'clips');
const clipsSnapshot = new Set(fs.existsSync(REAL_CLIPS_DIR) ? fs.readdirSync(REAL_CLIPS_DIR) : []);
function ensureSample() {
  const sampleDir = path.join(REAL_CLIPS_DIR, '_samples');
  fs.mkdirSync(sampleDir, { recursive: true });
  const out = path.join(sampleDir, 'sample_720p_10s.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return { path: out, created: false };
  execFileSync(require('../config').FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x4a90d9:s=1280x720:d=10',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', out
  ], { stdio: 'ignore', timeout: 60000 });
  return { path: out, created: true };
}
const SAMPLE = ensureSample();

let srv = null;
let PORT = null;
let BASE = null;

async function postJson(url, body) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
async function getJson(url) {
  const r = await fetch(BASE + url);
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}

async function main() {
  console.log('='.repeat(64));
  console.log('P5 小智 · HTTP 验收（临时隔离实例）');
  console.log('='.repeat(64));

  const picked = await pickFreePort(3093);
  if (!picked) { console.log('❌ 3093–3132 没有空闲端口'); process.exit(1); }
  PORT = picked;
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`  临时实例端口 ${PORT}；数据目录 ${TMP}`);

  srv = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTH_ENABLED: 'false',
      ASSISTANT_DIR: DIRS.assistant,
      DATA_DIR: DIRS.tasks,
      CLIPS_DIR: DIRS.clips,
      OUTPUT_DIR: DIRS.output,
      LIBRARY_DIR: DIRS.library,
      PHOTOS_DIR: DIRS.photos,
      PROJECTS_DIR: DIRS.projects,
      LOG_DIR: DIRS.logs,
      BUDGET_FILE: DIRS.budget,
      DATABASE_TYPE: 'json',
      // Mock 生成器默认 10% 随机失败；验收要确定性，临时实例强制 0（默认行为不受影响）
      MOCK_FAIL_RATE: '0'
    },
    stdio: 'ignore'
  });

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const r = await fetch(BASE + '/api/status');
        if (r.ok) { ready = true; break; }
      } catch (e) { /* not yet */ }
    }
    ok('临时实例启动成功（/api/status 200）', ready, `port=${PORT}`);
    if (!ready) return;

    // ---------- [1] 能力探针 ----------
    console.log('\n[1] GET /api/assistant/info');
    const info = await getJson('/api/assistant/info');
    ok('info 200 且 ok=true', info.status === 200 && info.json && info.json.ok === true);
    ok('名称 = 小智', info.json && info.json.name === '小智');
    ok('返回计划卡限制（60 分钟 / 400 段 / 180 场景卡 / 5% 补位）', (() => {
      const lim = info.json && info.json.plan && info.json.plan.limits;
      return lim && lim.maxMinutes === 60 && lim.maxClips === 400
        && lim.sceneCardMaxClips === 180 && lim.fillRatio === 0.05 && lim.fillMaxClips === 10;
    })());
    ok('ASR 探针可用（离线 sherpa-onnx）', info.json && info.json.asr && info.json.asr.available === true
      && info.json.asr.engine === 'sherpa-onnx');
    // 2026-11-18 Lead：V2（d1b4847）按「加法式」追加了 6 个只读/approved 端点，
    // 旧断言写死 length === 7 因此假红。契约是「原有端点仍在、清单只增不减」。
    const eps = (info.json && info.json.endpoints) || [];
    ok('新端点清单包含 execute/message/asr', eps.length >= 7
      && ['/api/assistant/info', '/api/assistant/message', '/api/assistant/execute', '/api/assistant/asr']
        .every((p) => eps.includes(p)),
      `共 ${eps.length} 个`);

    // ---------- [2] 对话 / 记忆 ----------
    console.log('\n[2] POST /api/assistant/message（对话，不建任务/不计费）');
    const greet = await postJson('/api/assistant/message', { text: '你好' });
    ok('问候 → greeting 且返回 sessionId', greet.json && greet.json.ok && greet.json.intent === 'greeting' && greet.json.sessionId,
      greet.json && greet.json.intent);
    const sid = greet.json && greet.json.sessionId;

    const need = await postJson('/api/assistant/message', { sessionId: sid, text: '来条极光' });
    ok('缺总时长 → 追问（missing=totalMinutes）', need.json && need.json.ok && need.json.missing
      && need.json.missing.includes('totalMinutes') && /多长/.test(need.json.reply || ''),
      need.json && need.json.reply);

    const planned = await postJson('/api/assistant/message', { sessionId: sid, text: 'mock 1段极光，每段10秒' });
    const plan = planned.json && planned.json.plan;
    ok('生成计划卡（mock 1 段 × 10 秒，零计费）', planned.json && planned.json.ok && plan
      && plan.clipCount === 1 && plan.clipDurationSec === 10 && plan.model === 'mock'
      && plan.estimate.totalCny === 0 && plan.requiresPaymentApproval === false,
      plan ? `${plan.clipCount}×${plan.clipDurationSec} ${plan.model}` : planned.json && planned.json.reply);
    ok('计划卡默认场景卡模式', plan && plan.sceneCards === true);

    const lastMsg = await postJson('/api/assistant/message', { sessionId: sid, text: '上一次的视频' });
    ok('检索「上一次的视频」→ intent=last（当前无成片时明确说没有）',
      lastMsg.json && lastMsg.json.ok && lastMsg.json.intent === 'last'
      && /还没有成片|上一次/.test(lastMsg.json.reply || ''), lastMsg.json && lastMsg.json.intent);

    const mem = await getJson('/api/assistant/memory?sessionId=' + encodeURIComponent(sid) + '&limit=20');
    ok('GET memory 返回消息 + 上次计划', mem.json && mem.json.ok && Array.isArray(mem.json.messages)
      && mem.json.messages.length >= 4 && mem.json.lastPlan && mem.json.lastPlan.planId === plan.planId,
      mem.json && `${mem.json.messages && mem.json.messages.length} 条`);

    // ---------- [3] 付费闸门（不发请求） ----------
    console.log('\n[3] 付费闸门');
    const realPlanMsg = await postJson('/api/assistant/message', { sessionId: sid, text: '1段极光，每段10秒' });
    const realPlan = realPlanMsg.json && realPlanMsg.json.plan;
    // 2026-11-18 Lead：默认模型自 2026-11-16 起是 openai-video（用户要求走 WhaleTV key），
    // 旧断言写死 dashscope 因此假红。契约是「未指定模型 → 非 mock 的真实计费模型 + 需付费确认」。
    ok('真实计费模型计划（默认非 mock / 需付费确认）', realPlan && realPlan.model && realPlan.model !== 'mock'
      && realPlan.requiresPaymentApproval === true, realPlan && realPlan.model);
    const tasksBefore = await getJson('/api/tasks');
    const payDenied = await postJson('/api/assistant/execute', {
      sessionId: sid, planId: realPlan.planId, approved: false
    });
    ok('未 approved → PAYMENT_NOT_APPROVED', payDenied.json && payDenied.json.ok === false
      && payDenied.json.code === 'PAYMENT_NOT_APPROVED', payDenied.json && payDenied.json.code);
    const tasksAfter = await getJson('/api/tasks');
    ok('未确认时不创建任务', Array.isArray(tasksBefore.json) && Array.isArray(tasksAfter.json)
      && tasksBefore.json.length === tasksAfter.json.length,
      `${(tasksBefore.json || []).length} → ${(tasksAfter.json || []).length}`);
    const understand = await postJson('/api/assistant/understand', { text: '10 分钟极光' });
    ok('模型填槽未同意 → LLM_CONSENT_REQUIRED（不发请求）',
      understand.json && understand.json.ok === false && understand.json.code === 'LLM_CONSENT_REQUIRED',
      understand.json && understand.json.code);

    // ---------- [4] 确认执行 Mock 全流程 ----------
    console.log('\n[4] 确认执行 → 状态机 → 成片（Mock，零计费）');
    const exec = await postJson('/api/assistant/execute', {
      sessionId: sid, planId: plan.planId, approved: true
    });
    ok('execute 返回任务 id', exec.json && exec.json.ok === true && !!exec.json.taskId,
      exec.json && (exec.json.taskId || exec.json.error));
    const taskId = exec.json && exec.json.taskId;
    ok('execute 返回初始状态机快照', exec.json && exec.json.state && exec.json.state.state === 'running');
    const execAgain = await postJson('/api/assistant/execute', {
      sessionId: sid, planId: plan.planId, approved: true
    });
    ok('重复确认执行 → ASSISTANT_ALREADY_RUNNING（不重复建任务）',
      execAgain.json && execAgain.json.ok === false && execAgain.json.code === 'ASSISTANT_ALREADY_RUNNING',
      execAgain.json && execAgain.json.code);

    let finalState = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      await sleep(1000);
      const st = await getJson('/api/assistant/state?sessionId=' + encodeURIComponent(sid)
        + '&planId=' + encodeURIComponent(plan.planId));
      if (st.json && st.json.ok && st.json.state) {
        if (['done', 'failed', 'needs_user'].includes(st.json.state.state)) { finalState = st.json; break; }
      }
    }
    ok('状态机在 180s 内到终态', !!finalState, finalState && finalState.state && finalState.state.state);
    ok('终态 = done', finalState && finalState.state && finalState.state.state === 'done',
      finalState && finalState.state && (finalState.state.reason || finalState.state.state));
    ok('状态机事件含 PLAN/CONFIRM/SUBMIT/RUNNING/COMPLETE', (() => {
      const ev = (finalState && finalState.state && finalState.state.events || []).map((e) => e.type);
      return ['PLAN', 'CONFIRM', 'SUBMIT', 'RUNNING', 'COMPLETE'].every((x) => ev.includes(x));
    })());

    const detail = await getJson('/api/tasks/' + encodeURIComponent(taskId));
    const t = detail.json;
    ok('任务 completed 且 1/1 片段成功', detail.status === 200 && t && t.status === 'completed'
      && (t.clips || []).filter((c) => c.status === 'success').length === 1,
      t && `${t.status} ${(t.clips || []).filter((c) => c.status === 'success').length}/${t.totalClips}`);
    ok('任务记录场景卡 1 张、bufferUsed=0', t && t.sceneCards && t.sceneCards.used.length === 1
      && t.sceneCards.status.bufferUsed === 0);
    ok('片段提示词记录 sceneKey / promptSource', t && t.clips[0] && t.clips[0].promptSource === 'scene-card'
      && !!t.clips[0].sceneKey, t && t.clips[0] && t.clips[0].sceneKey);
    ok('成片文件存在', !!(t && t.outputPath && fs.existsSync(t.outputPath)), t && t.outputPath);
    const budgetState = await getJson('/api/budget');
    ok('预算未扣（Mock 零计费）', budgetState.json && Number(budgetState.json.spentUsd) === 0,
      budgetState.json && `spent=$${budgetState.json.spentUsd}`);

    const mem2 = await getJson('/api/assistant/memory?sessionId=' + encodeURIComponent(sid));
    ok('记忆里保存终态与助手消息', mem2.json && mem2.json.ok && mem2.json.state
      && mem2.json.state.state === 'done'
      && mem2.json.messages.some((m) => m.role === 'assistant' && /开始做了|做好|补位/.test(m.text || '')),
      mem2.json && mem2.json.state && mem2.json.state.state);

    // ---------- [5] 语音（HTTP base64） ----------
    console.log('\n[5] POST /api/assistant/asr（离线，base64）');
    const wav = path.join(APP_DIR, 'tools', 'asr', 'model-sensevoice-int8', 'test_wavs', 'zh.wav');
    const b64 = fs.readFileSync(wav).toString('base64');
    const asrRes = await postJson('/api/assistant/asr', { audioBase64: b64, mime: 'audio/wav' });
    ok('中文样例 → 「开饭时间早上9点至下午5点。」', asrRes.json && asrRes.json.ok === true
      && /开饭时间/.test(asrRes.json.text || '') && asrRes.json.offline === true,
      asrRes.json && asrRes.json.text);
    const asrBad = await postJson('/api/assistant/asr', {
      audioBase64: Buffer.alloc(4096, 9).toString('base64'), mime: 'audio/webm'
    });
    ok('坏音频 → 明确失败码（不把空文本当成功）', asrBad.json && asrBad.json.ok === false
      && ['ASR_BAD_AUDIO', 'ASR_TOO_SHORT'].includes(asrBad.json.code), asrBad.json && asrBad.json.code);

    // ---------- [6] 状态接口负向 ----------
    console.log('\n[6] 负向：参数/会话校验');
    const noSid = await getJson('/api/assistant/state');
    ok('GET state 缺 sessionId → 明确错误', noSid.json && noSid.json.ok === false
      && noSid.json.code === 'ASSISTANT_BAD_SESSION');
    const badExec = await postJson('/api/assistant/execute', { sessionId: 's_nope_nope', approved: true });
    ok('execute 无会话 → ASSISTANT_BAD_SESSION', badExec.json && badExec.json.ok === false
      && badExec.json.code === 'ASSISTANT_BAD_SESSION', badExec.json && badExec.json.code);
    const emptyMsg = await postJson('/api/assistant/message', { text: '' });
    ok('空消息 → ASSISTANT_EMPTY_TEXT', emptyMsg.json && emptyMsg.json.ok === false
      && emptyMsg.json.code === 'ASSISTANT_EMPTY_TEXT');
  } finally {
    try { if (srv) srv.kill(); } catch (e) { /* ignore */ }
    await sleep(500);
    // 清理本次新增的 mock 片段与样片
    try {
      for (const name of fs.readdirSync(REAL_CLIPS_DIR)) {
        if (clipsSnapshot.has(name)) continue;
        if (/^mock_.*\.mp4$/.test(name)) fs.unlinkSync(path.join(REAL_CLIPS_DIR, name));
      }
    } catch (e) { /* ignore */ }
    if (SAMPLE.created) { try { fs.unlinkSync(SAMPLE.path); } catch (e) { /* ignore */ } }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    console.log('\n' + '='.repeat(64));
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    if (fail > 0) {
      console.log('失败项：');
      failures.forEach((f) => console.log(`  - ${f.name}${f.extra ? ': ' + f.extra : ''}`));
    }
    console.log('='.repeat(64));
    process.exit(fail === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  try { if (srv) srv.kill(); } catch (err) { /* ignore */ }
  process.exit(1);
});
