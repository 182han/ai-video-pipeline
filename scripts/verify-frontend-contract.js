// ==========================================================
// 前端集成契约 一致性校验
//
// 目的：docs/spec/frontend-integration-spec.md 里写的每一条接口行为，
// 都必须与真实 API 一致。文档与实现不符比没有文档更糟——
// 所以这个脚本把文档里承诺的东西逐条跑一遍。
//
// 覆盖：
//   1. POST /api/tasks 的 preset 透传（quick/daily/final/clips_only/custom/不传）
//   2. GET /api/tasks/:id/continue-plan 的字段与 404/400
//   3. POST /api/tasks/:id/continue 的成功/幂等/错误
//   4. GET /api/tasks/:id 与 GET /api/tasks 的 qc* 字段
//   5. clips_only 的 fragmentOnly / outputPath=null
//   6. 步骤状态里 skipped 与 reused 可区分
//
// 用法：node scripts/verify-frontend-contract.js
// ==========================================================

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

let PORT = 3093;
let BASE = `http://127.0.0.1:${PORT}`;

// 端口动态选择：批量跑多个脚本时上一个服务可能还没释放端口，
// 固定端口会造成「服务启动失败」的假阴性。
async function pickFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    const free = await new Promise(resolve => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  return null;
}

let pass = 0;
let fail = 0;
const failures = [];
const createdTaskIds = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${BASE}${p}`, opts);
  let json = null;
  try { json = await resp.json(); } catch (e) {}
  return { status: resp.status, body: json };
}

async function waitStatus(taskId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api('GET', `/api/tasks/${taskId}`);
    if (body && ['completed', 'partial', 'failed'].includes(body.status)) return body;
    await sleep(500);
  }
  return null;
}

async function main() {
  console.log('='.repeat(64));
  console.log('前端集成契约 一致性校验');
  console.log('='.repeat(64));

  const picked = await pickFreePort(3093);
  if (!picked) {
    assert(false, '找到可用端口', '3093-3112 全被占用');
    summary();
    return;
  }
  PORT = picked;
  BASE = `http://127.0.0.1:${PORT}`;

  // 用 --require 预加载 shim：无 OPENAI_API_KEY 时 NSFW 判 fail 会让片段质检失败、
  // 流水线在片段生成就中止，档位/补跑相关步骤根本走不到。
  // NSFW 本身由 verify-nsfw.js 独立验收 42 项。
  const shimPath = path.join(__dirname, '_nsfw-pass-shim.js');
  const srv = spawn(process.execPath, ['--require', shimPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    // 登录墙会把 /api/* 拦成 401；验收脚本走官方逃生开关
    env: { ...process.env, PORT: String(PORT), AUTH_ENABLED: 'false' },
    stdio: 'ignore'
  });

  try {
    // 等服务就绪
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try { const r = await fetch(`${BASE}/api/tasks`); if (r.ok) { ready = true; break; } } catch (e) {}
    }
    assert(ready, '服务启动成功', `port=${PORT}`);
    if (!ready) { summary(); return; }

    // ---------- 1. preset 透传 ----------
    console.log('\n[1] POST /api/tasks 的 preset 透传');
    const presetCases = [
      ['quick', 'quick', 4],
      ['clips_only', 'clips_only', 3],
      ['final', 'final', 8],
      [undefined, 'final', 8]
    ];
    for (const [sent, wantPreset, wantSteps] of presetCases) {
      const body = { prompt: `契约校验-${sent || 'default'}`, model: 'mock', totalClips: 1, clipDuration: 3 };
      if (sent) body.preset = sent;
      const r = await api('POST', '/api/tasks', body);
      const tid = r.body && (r.body.taskId || (r.body.task && r.body.task.taskId));
      assert(!!tid, `创建任务（preset=${sent || '不传'}）`, `status=${r.status}`);
      if (!tid) continue;
      createdTaskIds.push(tid);
      const d = await api('GET', `/api/tasks/${tid}`);
      const steps = d.body && d.body.stageSet ? Object.keys(d.body.stageSet).length : -1;
      assert(d.body && d.body.preset === wantPreset,
        `preset=${sent || '不传'} → 任务 preset=${wantPreset}`, `实际 ${d.body && d.body.preset}`);
      assert(steps === wantSteps,
        `preset=${sent || '不传'} → stageSet ${wantSteps} 步`, `实际 ${steps}`);
    }

    // 非法档位：应回退 final 而不是创建失败（文档承诺「不传=final」，非法值写日志回退）
    console.log('\n[1b] 非法 preset 的处理');
    const badDb = await api('POST', '/api/tasks', {
      prompt: '契约校验-badpreset', model: 'mock', totalClips: 1, clipDuration: 3, preset: 'bogus'
    });
    const badId = badDb.body && (badDb.body.taskId || (badDb.body.task && badDb.body.task.taskId));
    if (badId) {
      createdTaskIds.push(badId);
      const d = await api('GET', `/api/tasks/${badId}`);
      assert(d.body && d.body.preset === 'final',
        '非法档位回退 final（不让用户丢掉整个任务）', `实际 ${d.body && d.body.preset}`);
      assert(d.body && d.body.stagePlan && Array.isArray(d.body.stagePlan.notes)
        && d.body.stagePlan.notes.some(n => /回退 final/.test(n)),
        '回退原因写入 stagePlan.notes', JSON.stringify(d.body && d.body.stagePlan && d.body.stagePlan.notes));
    } else {
      assert(false, '非法档位时仍能创建任务', `status=${badDb.status}`);
    }

    // 关键：POST /api/tasks 会**自动启动**任务（server.js 内 pipeline.startTask）。
    // 所以下面所有针对任务的测试都必须先等它跑完，否则 continue 会返回「任务正在运行中」。
    console.log('\n[1c] 等待测试任务跑完（创建即自动启动）');
    const planTaskId = createdTaskIds[0]; // quick 任务
    const quickDone = await waitStatus(planTaskId);
    assert(quickDone !== null, 'quick 任务跑到终态', quickDone ? quickDone.status : 'timeout');
    // 其余任务也等一等，避免并发干扰
    for (const id of createdTaskIds.slice(1)) {
      await waitStatus(id);
    }

    // ---------- 2. continue-plan ----------
    console.log('\n[2] GET /api/tasks/:id/continue-plan');
    const plan = await api('GET', `/api/tasks/${planTaskId}/continue-plan?preset=final`);
    assert(plan.status === 200, '预览返回 200', `${plan.status}`);
    assert(plan.body && Array.isArray(plan.body.pending), '返回 pending 数组', JSON.stringify(plan.body && plan.body.pending));
    assert(plan.body && Array.isArray(plan.body.reused), '返回 reused 数组', JSON.stringify(plan.body && plan.body.reused));
    assert(plan.body && Array.isArray(plan.body.notes), '返回 notes 数组');
    assert(plan.body && Array.isArray(plan.body.completed), '返回 completed 数组');
    assert(plan.body && plan.body.currentPreset === 'quick', '返回 currentPreset', plan.body && plan.body.currentPreset);

    const notFound = await api('GET', '/api/tasks/no_such_task/continue-plan');
    assert(notFound.status === 404, '任务不存在返回 404', `${notFound.status}`);

    // ---------- 3. continue 的错误分支 ----------
    console.log('\n[3] POST /api/tasks/:id/continue 的错误分支');
    const badPreset = await api('POST', `/api/tasks/${planTaskId}/continue`, { preset: 'bogus' });
    assert(badPreset.status === 400, '非法档位返回 400', `${badPreset.status}`);
    assert(badPreset.body && /未知档位/.test(String(badPreset.body.error)),
      '错误信息说明未知档位', String(badPreset.body && badPreset.body.error).slice(0, 50));

    const notExist = await api('POST', '/api/tasks/no_such_task/continue', { preset: 'final' });
    assert(notExist.status === 400, '任务不存在返回 400', `${notExist.status}`);

    // ---------- 4. qc 字段 ----------
    console.log('\n[4] qc* 字段');
    const realTasks = await api('GET', '/api/tasks');
    assert(Array.isArray(realTasks.body) && realTasks.body.length > 0, '列表非空', `${realTasks.body && realTasks.body.length} 条`);
    const first = realTasks.body && realTasks.body[0];
    assert(first && first.qcTrusted !== undefined, '列表项含 qcTrusted', `qcTrusted=${first && first.qcTrusted}`);
    assert(first && first.qcVersion !== undefined, '列表项含 qcVersion', `qcVersion=${first && first.qcVersion}`);
    assert(first && first.preset !== undefined, '列表项含 preset');
    assert(first && first.fragmentOnly !== undefined, '列表项含 fragmentOnly');

    const detail = await api('GET', `/api/tasks/${first.taskId}`);
    assert(detail.body && detail.body.qcVersionSource !== undefined,
      '详情含 qcVersionSource', `source=${detail.body && detail.body.qcVersionSource}`);
    if (detail.body && detail.body.finalQC) {
      assert(detail.body.finalQC.qcLabel !== undefined,
        'finalQC 含 qcLabel', `label=${detail.body.finalQC.qcLabel}`);
    }

    // ---------- 5. 跑一条 clips_only，验证 fragmentOnly ----------
    console.log('\n[5] clips_only 产物语义（fragmentOnly / outputPath=null）');
    const clipsTaskId = createdTaskIds[1]; // clips_only（创建即自动启动，[1c] 已等待完成）
    if (clipsTaskId) {
      const done = await api('GET', `/api/tasks/${clipsTaskId}`);
      assert(done.body && done.body.status === 'completed',
        'clips_only 任务已完成', done.body ? done.body.status : '?');
      if (done.body) {
        assert(done.body.fragmentOnly === true, 'fragmentOnly=true（片段包不是成片）', `实际 ${done.body.fragmentOnly}`);
        assert(done.body.outputPath === null || done.body.outputPath === undefined,
          'outputPath 为空（不产出成片）', `实际 ${done.body.outputPath}`);
        assert((done.body.fragmentCount || 0) > 0, '报告片段数', `fragmentCount=${done.body.fragmentCount}`);
        // 步骤状态：拼接应为 skipped 而非 completed
        assert(done.body.steps && done.body.steps.concatenation
          && done.body.steps.concatenation.status === 'skipped',
          '拼接步骤标记为 skipped（与 completed 区分）',
          `实际 ${done.body.steps && done.body.steps.concatenation && done.body.steps.concatenation.status}`);
        const reason = done.body.steps && done.body.steps.concatenation
          && done.body.steps.concatenation.qcDetails && done.body.steps.concatenation.qcDetails.reason;
        assert(/未包含此环节/.test(String(reason)), 'skipped 写明原因', String(reason).slice(0, 40));
      }
    } else {
      assert(false, '找到 clips_only 测试任务', '未找到');
    }

    // ---------- 6. 补跑真机：quick → final ----------
    console.log('\n[6] 补跑真机：quick → final（片段不重生成）');
    const qid = createdTaskIds[0];
    if (qid) {
      const qDone = await api('GET', `/api/tasks/${qid}`);
      assert(qDone.body && qDone.body.status === 'completed',
        'quick 任务已完成（[1c] 已跑完，无需 retry）', qDone.body ? qDone.body.status : '?');
      const clipPathsBefore = (qDone.body && qDone.body.clips || [])
        .filter(c => c.status === 'success')
        .map(c => c.videoPath);
      const mtimesBefore = clipPathsBefore.map(p => {
        try { return fs.existsSync(p) ? fs.statSync(p).mtimeMs : -1; } catch (e) { return -1; }
      });

      const cont = await api('POST', `/api/tasks/${qid}/continue`, { preset: 'final' });
      assert(cont.status === 200 && cont.body.success, '补跑请求被接受', `status=${cont.status}`);
      assert(cont.body && Array.isArray(cont.body.pending) && cont.body.pending.length > 0,
        '返回待跑清单', JSON.stringify(cont.body && cont.body.pending));
      assert(cont.body && Array.isArray(cont.body.reused)
        && cont.body.reused.includes('clip_generation'),
        '复用清单含 clip_generation（片段不重跑）', JSON.stringify(cont.body && cont.body.reused));

      const after = await waitStatus(qid);
      assert(after && after.status === 'completed', '补跑后任务完成', after ? after.status : 'timeout');
      if (after) {
        assert(after.steps.clip_generation.status === 'reused',
          '片段生成标记 reused（不是重新 completed）', `实际 ${after.steps.clip_generation.status}`);
        assert(after.steps.concatenation.status === 'reused',
          '拼接标记 reused', `实际 ${after.steps.concatenation.status}`);
        assert(after.steps.loop_processing.status === 'completed',
          '循环真实执行', `实际 ${after.steps.loop_processing.status}`);
        // 文件 mtime 未变 = 真的没重生成
        const mtimesAfter = clipPathsBefore.map(p => {
          try { return fs.existsSync(p) ? fs.statSync(p).mtimeMs : -1; } catch (e) { return -1; }
        });
        const unchanged = mtimesBefore.every((m, i) => m === mtimesAfter[i]);
        assert(unchanged, '片段文件 mtime 未变（没重新生成）',
          unchanged ? '全部一致' : `前=${mtimesBefore.join(',')} 后=${mtimesAfter.join(',')}`);
      }

      // 幂等
      const again = await api('POST', `/api/tasks/${qid}/continue`, { preset: 'final' });
      assert(again.body && again.body.alreadyDone === true,
        '已完成档位再补跑返回 alreadyDone', JSON.stringify(again.body && again.body.alreadyDone));
    }

  } finally {
    try { srv.kill(); } catch (e) {}
    await sleep(800);
    try {
      execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore' });
    } catch (e) {}
    // 清理测试任务与产物（必须含数据库，见 scripts/_test-cleanup.js 的说明）
    const { cleanupMany } = require('./_test-cleanup');
    const cleaned = await cleanupMany(createdTaskIds);
    const badClean = cleaned.filter(c => !c.ok);
    if (badClean.length) {
      console.log('⚠️ 部分任务未清理：' + badClean.map(c => `${c.taskId}(${c.skipped})`).join(', '));
    }
  }

  summary();
}

function summary() {
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('校验异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});

