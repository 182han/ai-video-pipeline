// ==========================================================
// 质检可信度标注（qcVersion / qcTrusted / qcLabel）验收
//
// 背景：2026-10-18 之前质检存在「skipped 当 passed / Math.random 假质检」，
// 那之前的结论都是伪造 pass，已入库无法区分。用 qcVersion 区分：
//   >= 2 可信；null / 1 = 历史未验证。
//
// 本脚本验证三件事：
//   A. 标注语义正确（四种版本组合）
//   B. 任务级版本缺失时能回退到 finalQC 的版本（否则所有可信任务会被误标）
//   C. API 真的把标注暴露出来（taskManager.getTask 本身不带标注，需 API 层补）
//
// 用法：node scripts/verify-qc-annotation.js
// ==========================================================

const path = require('path');
const { execSync } = require('child_process');

const qcVersion = require('../src/storage/qcVersion');
const storage = require('../src/storage');
const taskManager = require('../src/taskManager');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

async function main() {
  console.log('='.repeat(64));
  console.log('质检可信度标注 验收');
  console.log('='.repeat(64));

  // ---------- A. 标注语义 ----------
  console.log('\n[A] 标注语义');
  assert(qcVersion.TRUSTED_FROM === 2, '可信分界为 2', `TRUSTED_FROM=${qcVersion.TRUSTED_FROM}`);

  const cases = [
    { name: '版本 2', task: { qcVersion: 2, finalQC: { qcVersion: 2 } }, wantTrusted: true, wantLabel: 'verified' },
    { name: '版本 3（更高）', task: { qcVersion: 3, finalQC: { qcVersion: 3 } }, wantTrusted: true, wantLabel: 'verified' },
    { name: '版本 1（历史）', task: { qcVersion: 1, finalQC: { qcVersion: 1 } }, wantTrusted: false, wantLabel: 'legacy_unverified' },
    { name: '版本 0', task: { qcVersion: 0, finalQC: { qcVersion: 0 } }, wantTrusted: false, wantLabel: 'legacy_unverified' },
    { name: '版本 null', task: { qcVersion: null, finalQC: { passed: true } }, wantTrusted: false, wantLabel: 'legacy_unverified' },
    { name: '版本 "abc"（非法）', task: { qcVersion: 'abc', finalQC: { passed: true } }, wantTrusted: false, wantLabel: 'legacy_unverified' },
    { name: '版本 -1（负数）', task: { qcVersion: -1, finalQC: { passed: true } }, wantTrusted: false, wantLabel: 'legacy_unverified' }
  ];
  for (const c of cases) {
    const r = qcVersion.annotateTask(c.task);
    assert(r.qcTrusted === c.wantTrusted, `${c.name} → qcTrusted=${c.wantTrusted}`, `实际 ${r.qcTrusted}`);
    assert(r.finalQC && r.finalQC.qcLabel === c.wantLabel,
      `${c.name} → finalQC.qcLabel=${c.wantLabel}`, `实际 ${r.finalQC && r.finalQC.qcLabel}`);
  }

  // passed 字段不得被篡改
  const keepPassed = qcVersion.annotateTask({ qcVersion: 1, finalQC: { passed: true, qcVersion: 1 } });
  assert(keepPassed.finalQC.passed === true,
    '标注不篡改历史 passed 原值（只新增字段）', `passed=${keepPassed.finalQC.passed}`);

  // ---------- B. 版本回退 ----------
  console.log('\n[B] 任务级版本缺失时的回退');
  const fallback = qcVersion.annotateTask({
    taskId: 'x',
    finalQC: { passed: true, qcVersion: 2 },
    clips: [{ qcResult: { passed: true, qcVersion: 2 } }]
  });
  assert(fallback.qcVersion === 2,
    '任务级无版本时回退到 finalQC 的版本（否则可信任务会被误标）',
    `qcVersion=${fallback.qcVersion}`);
  assert(fallback.qcTrusted === true, '回退后 qcTrusted=true', `${fallback.qcTrusted}`);
  assert(fallback.qcVersionSource === 'finalQC',
    '标注版本来源（透明可查）', `source=${fallback.qcVersionSource}`);
  assert(fallback.clips[0].qcResult.qcLabel === 'verified',
    '片段质检也得到正确标注', fallback.clips[0].qcResult.qcLabel);

  const taskPriority = qcVersion.annotateTask({ qcVersion: 2, finalQC: { qcVersion: 1 } });
  assert(taskPriority.qcVersion === 2 && taskPriority.qcVersionSource === 'task',
    '任务级版本优先于 finalQC', `v=${taskPriority.qcVersion}, source=${taskPriority.qcVersionSource}`);

  const noVersion = qcVersion.annotateTask({ finalQC: { passed: true } });
  assert(noVersion.qcVersion === null && noVersion.qcTrusted === false,
    '完全无版本 → 不可信（不猜）', `v=${noVersion.qcVersion}`);

  // ---------- C. 存储层 / API 层暴露 ----------
  console.log('\n[C] 存储层与 API 层');
  const realTasks = (taskManager.getAllTasks() || []).filter(t => t && t.taskId);
  // 挑选「有 finalQC」的任务，而不是简单取第一个。
  // 列表按创建时间降序，最新的一条可能是别的验收脚本刚建/删剩下的、尚未跑过终检的任务，
  // 那种任务本就没有 finalQC.qcLabel，断言会假失败（实测踩过：批量跑时 31/32）。
  const withFinalQC = realTasks.filter(t => t.finalQC && typeof t.finalQC === 'object');
  const chosen = withFinalQC.length ? withFinalQC[0] : realTasks[0];
  if (realTasks.length === 0) {
    assert(false, '存在可用于验证的真实任务', 'data/tasks 为空');
  } else if (!withFinalQC.length) {
    assert(false, '存在带 finalQC 的真实任务（用于验证 qcLabel 暴露）',
      `${realTasks.length} 条任务都没有 finalQC`);
  } else {
    const tid = chosen.taskId;
    const viaTm = taskManager.getTask(tid);
    // taskManager 直读内存，**不带**标注 —— 这是已知事实，API 层必须自己补
    assert(viaTm.qcTrusted === undefined,
      'taskManager.getTask 不带标注（已知事实，故 API 层需自行 annotateTaskQC）',
      `qcTrusted=${viaTm.qcTrusted}`);

    const viaStorage = await storage.getTask(tid);
    if (viaStorage) {
      assert(viaStorage.qcTrusted !== undefined,
        'storage.getTask 已带标注', `qcTrusted=${viaStorage.qcTrusted}`);
    }

    // 起一个临时服务验证 API
    // 端口动态选择：批量跑多个脚本时，上一个服务可能还没释放端口，
    // 固定端口会导致「服务启动失败」的假阴性（实测踩过：单跑 32/0，批量跑 31/1）。
    console.log('  启动临时服务验证 API ...');
    const { spawn } = require('child_process');
    const net = require('net');

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

    const port = await pickFreePort(3096);
    if (!port) {
      assert(false, '找到可用端口', '3096-3115 全被占用');
      summary();
      return;
    }
    const srv = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      // 登录墙会把 /api/* 拦成 401；验收脚本走官方逃生开关
      env: { ...process.env, PORT: String(port), AUTH_ENABLED: 'false' },
      stdio: 'ignore',
      detached: false
    });
    try {
      // 等服务就绪：直接用内置 fetch 探测，比拉起 PowerShell 子进程可靠
      let ready = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/tasks`);
          if (resp.ok) { ready = true; break; }
        } catch (e) { /* 还没起来，继续等 */ }
      }
      assert(ready, '临时服务启动成功', `port=${port}`);
      if (ready) {
        const detail = await (await fetch(`http://127.0.0.1:${port}/api/tasks/${tid}`)).json();
        assert(detail.qcTrusted !== undefined,
          'GET /api/tasks/:id 暴露 qcTrusted', `qcTrusted=${detail.qcTrusted}`);
        assert(detail.qcVersion !== undefined,
          'GET /api/tasks/:id 暴露 qcVersion', `qcVersion=${detail.qcVersion}`);
        assert(detail.qcVersionSource !== undefined,
          'GET /api/tasks/:id 暴露 qcVersionSource', `source=${detail.qcVersionSource}`);
        assert(detail.finalQC && detail.finalQC.qcLabel !== undefined,
          'GET /api/tasks/:id 暴露 finalQC.qcLabel', `label=${detail.finalQC && detail.finalQC.qcLabel}`);

        const list = await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json();
        assert(Array.isArray(list) && list.length > 0, 'GET /api/tasks 返回列表', `${list.length} 条`);
        assert(list[0].qcTrusted !== undefined,
          'GET /api/tasks 列表项暴露 qcTrusted', `qcTrusted=${list[0].qcTrusted}`);
        assert(list[0].preset !== undefined,
          '列表项暴露 preset（档位）', `preset=${list[0].preset}`);
      }
    } finally {
      try { srv.kill(); } catch (e) {}
      await new Promise(r => setTimeout(r, 800));
      // Windows 上子进程可能没被 kill 干净，按端口兜底清理
      try {
        execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
          { stdio: 'ignore' });
      } catch (e) {}
    }
  }

  // ---------- 汇总 ----------
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
  console.error('验收异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
