// ==========================================================
// 生产指标统计 验收（src/stats.js + GET /api/stats）
//
// 真实任务样本太少（且多数质检不可信），无法覆盖各种口径组合。
// 因此主体用**构造数据**精确验证每个定义，最后再用真实任务跑一遍 API。
//
// 覆盖：
//   1. 端到端成功率 strict / lenient 两个口径
//   2. 一次质检通过率的精确定义（attempts === 1 且 success）
//   3. 质检不可信任务默认被排除、可显式纳入
//   4. 进行中任务不计入
//   5. 达标判断与样本量警告
//   6. 耗时异常值排除（completedAt 被重跑刷新的情况）
//   7. model 过滤
//   8. GET /api/stats 真实返回
//
// 用法：node scripts/verify-stats.js
// ==========================================================

const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

const stats = require('../src/stats');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

// 造一条任务
function mkTask(id, status, opts = {}) {
  const clips = opts.clips || [];
  return {
    taskId: id,
    status,
    model: opts.model || 'mock',
    clips,
    // 默认给可信版本；显式传 qcVersion 覆盖
    ...(opts.qcVersion !== undefined ? { qcVersion: opts.qcVersion } : { qcVersion: 2 }),
    finalQC: opts.finalQC !== undefined ? opts.finalQC : { qcVersion: 2, passed: status === 'completed' },
    startedAt: opts.startedAt,
    completedAt: opts.completedAt
  };
}

// 造一批片段：以 [success, attempts] 形式给出
function mkClips(specs) {
  return specs.map(([status, attempts], i) => ({
    index: i,
    status,
    attempts,
    qcResult: { passed: status === 'success' }
  }));
}

async function main() {
  console.log('='.repeat(64));
  console.log('生产指标统计 验收');
  console.log('='.repeat(64));

  // ---------- 1. 端到端成功率 ----------
  console.log('\n[1] 端到端成功率（strict / lenient）');
  {
    const tasks = [
      mkTask('a', 'completed', { clips: mkClips([['success', 1], ['success', 1]]) }),
      mkTask('b', 'completed', { clips: mkClips([['success', 1], ['success', 1]]) }),
      mkTask('c', 'partial', { clips: mkClips([['success', 1], ['failed', 2]]) }),
      mkTask('d', 'failed', { clips: mkClips([['failed', 2], ['failed', 2]]) }),
      mkTask('e', 'completed', { clips: mkClips([['success', 1]]) })
    ];
    const s = stats.computeStats(tasks);
    // strict = 3/5 = 0.6；lenient = (3+1)/5 = 0.8
    assert(s.endToEnd.strict.numerator === 3 && s.endToEnd.strict.denominator === 5,
      'strict = completed / 已结束', `${s.endToEnd.strict.numerator}/${s.endToEnd.strict.denominator}`);
    assert(Math.abs(s.endToEnd.strict.rate - 0.6) < 1e-9, 'strict 比例 = 0.6', `${s.endToEnd.strict.rate}`);
    assert(s.endToEnd.lenient.numerator === 4 && s.endToEnd.lenient.denominator === 5,
      'lenient = (completed+partial) / 已结束', `${s.endToEnd.lenient.numerator}/${s.endToEnd.lenient.denominator}`);
    assert(Math.abs(s.endToEnd.lenient.rate - 0.8) < 1e-9, 'lenient 比例 = 0.8', `${s.endToEnd.lenient.rate}`);
    assert(s.endToEnd.partial === 1 && s.endToEnd.failed === 1,
      '分别报出 partial / failed 数量', `partial=${s.endToEnd.partial}, failed=${s.endToEnd.failed}`);
  }

  // ---------- 2. 一次质检通过率定义 ----------
  console.log('\n[2] 一次质检通过率的精确定义');
  {
    // 片段：首次通过1、首次失败后重试成功2、彻底失败1 => 总数4，首次通过1
    const clips = mkClips([
      ['success', 1],  // 首次通过 ✓
      ['success', 1],  // 首次通过 ✓
      ['success', 3],  // 重试后成功，不算首次通过
      ['failed', 2]    // 失败
    ]);
    const s = stats.computeStats([mkTask('x', 'partial', { clips })]);
    assert(s.clips.total === 4, '片段总数 4', `${s.clips.total}`);
    assert(s.clips.success === 3, '成功片段 3', `${s.clips.success}`);
    assert(s.clips.firstPass === 2, '首次通过 2（attempts===1 且 success）', `${s.clips.firstPass}`);
    assert(s.clips.retried === 1, '重试后成功 1', `${s.clips.retried}`);
    assert(Math.abs(s.clips.firstPassRate.rate - 0.5) < 1e-9,
      '一次质检通过率 = 2/4 = 0.5', `${s.clips.firstPassRate.rate}`);
    // attempts 缺失时不应算作首次通过（不能猜）
    const noAttempts = [{ index: 0, status: 'success', qcResult: { passed: true } }];
    const s2 = stats.computeStats([mkTask('y', 'completed', { clips: noAttempts })]);
    assert(s2.clips.firstPass === 0,
      'attempts 缺失时不算首次通过（不猜）', `firstPass=${s2.clips.firstPass}`);
  }

  // ---------- 3. 可信度过滤 ----------
  console.log('\n[3] 质检不可信任务的处理');
  {
    const tasks = [
      mkTask('t1', 'completed', { qcVersion: 2, clips: mkClips([['success', 1]]) }),
      mkTask('t2', 'failed', { qcVersion: 1, clips: mkClips([['passed', 1]]) }), // 伪造 pass
      mkTask('t3', 'completed', { qcVersion: null, finalQC: { passed: true }, clips: mkClips([['success', 1]]) }),
      mkTask('t4', 'failed', { qcVersion: 2, clips: mkClips([['failed', 1]]) })
    ];
    const s = stats.computeStats(tasks);
    assert(s.scope.untrustedExcluded === 2, '默认排除 2 条不可信任务', `${s.scope.untrustedExcluded}`);
    assert(s.endToEnd.strict.denominator === 2, '统计分母只含可信任务', `${s.endToEnd.strict.denominator}`);
    assert(s.warnings.some(w => /排除 2 条质检不可信/.test(w)), 'warnings 说明排除了几条');

    const s2 = stats.computeStats(tasks, { includeUntrusted: true });
    assert(s2.scope.untrustedIncluded === 2, '显式纳入后计 2 条', `${s2.scope.untrustedIncluded}`);
    assert(s2.endToEnd.strict.denominator === 4, '纳入后分母 4', `${s2.endToEnd.strict.denominator}`);
    assert(s2.warnings.some(w => /依据不明|仅供参考/.test(w)), '纳入时给出仅供参考警告');

    // 任务级无版本、但 finalQC 有可信版本 → 应判为可信（与 qcVersion.js 的回退一致）
    const fallback = mkTask('t5', 'completed', { qcVersion: undefined, finalQC: { qcVersion: 2 }, clips: mkClips([['success', 1]]) });
    const s3 = stats.computeStats([fallback]);
    assert(s3.scope.untrustedExcluded === 0,
      '任务级无版本但 finalQC 可信 → 视为可信（回退一致）', `excluded=${s3.scope.untrustedExcluded}`);
  }

  // ---------- 4. 进行中任务不计入 ----------
  console.log('\n[4] 进行中任务不计入');
  {
    const tasks = [
      mkTask('done', 'completed', { clips: mkClips([['success', 1]]) }),
      mkTask('running', 'generating', { clips: mkClips([['pending', 0]]) }),
      mkTask('queued', 'pending', { clips: [] })
    ];
    const s = stats.computeStats(tasks);
    assert(s.scope.finished === 1, '已结束 1 条', `${s.scope.finished}`);
    assert(s.scope.inProgress === 2, '进行中 2 条', `${s.scope.inProgress}`);
    assert(s.endToEnd.strict.denominator === 1, '成功率分母不含进行中', `${s.endToEnd.strict.denominator}`);
  }

  // ---------- 5. 达标判断与样本量 ----------
  console.log('\n[5] 达标判断与样本量');
  {
    // 10 条全成功 → 达标
    const many = Array.from({ length: 10 }, (_, i) =>
      mkTask('m' + i, 'completed', { clips: mkClips([['success', 1]]) }));
    const s = stats.computeStats(many);
    assert(s.target.sampleSufficient === true, '10 条样本视为充足');
    assert(s.target.endToEndMet === true, '成功率达标（100% ≥ 90%）');
    assert(s.target.clipFirstPassMet === true, '通过率达标（100% ≥ 85%）');

    // 少量样本 → 给警告
    const few = [mkTask('f1', 'completed', { clips: mkClips([['success', 1]]) })];
    const s2 = stats.computeStats(few);
    assert(s2.target.sampleSufficient === false, '1 条样本视为不足');
    assert(s2.warnings.some(w => /样本量偏小/.test(w)), '样本不足时给警告');

    // 空列表
    const s3 = stats.computeStats([]);
    assert(s3.endToEnd.strict.rate === null, '空数据时比例为 null（不是 0）', `${s3.endToEnd.strict.rate}`);
    assert(s3.warnings.some(w => /没有已结束的任务/.test(w)), '空数据时明确说明');
  }

  // ---------- 6. 耗时异常值 ----------
  console.log('\n[6] 耗时异常值排除');
  {
    const base = Date.parse('2026-10-19T00:00:00Z');
    const iso = ms => new Date(ms).toISOString();
    const tasks = [
      // 正常：5 分钟
      mkTask('n1', 'completed', {
        clips: mkClips([['success', 1]]),
        startedAt: iso(base), completedAt: iso(base + 300 * 1000)
      }),
      // 异常：3 天（completedAt 被重跑刷新）
      mkTask('n2', 'completed', {
        clips: mkClips([['success', 1]]),
        startedAt: iso(base - 3 * 24 * 3600 * 1000), completedAt: iso(base)
      }),
      // 缺少时间戳
      mkTask('n3', 'completed', { clips: mkClips([['success', 1]]) })
    ];
    const s = stats.computeStats(tasks);
    assert(s.duration.samples === 1, '只统计 1 条有效耗时', `${s.duration.samples}`);
    assert(s.duration.outliersExcluded === 1, '排除 1 条超 24h 的异常', `${s.duration.outliersExcluded}`);
    assert(s.duration.avgSec === 300, '平均耗时 300s', `${s.duration.avgSec}`);
    assert(s.duration.maxAllowedSec === 86400, '上限 24h', `${s.duration.maxAllowedSec}`);
    assert(s.warnings.some(w => /排除了 1 条异常记录/.test(w)), 'warnings 说明排除原因',
      s.warnings.find(w => /异常记录/.test(w)) || '(未找到)');
  }

  // ---------- 7. model 过滤 ----------
  console.log('\n[7] model 过滤');
  {
    const tasks = [
      mkTask('k1', 'completed', { model: 'kling', clips: mkClips([['success', 1]]) }),
      mkTask('k2', 'completed', { model: 'dashscope', clips: mkClips([['success', 1]]) }),
      mkTask('k3', 'failed', { model: 'dashscope', clips: mkClips([['failed', 1]]) })
    ];
    const s = stats.computeStats(tasks, { model: 'dashscope' });
    assert(s.endToEnd.strict.denominator === 2, '只统计 dashscope 的 2 条', `${s.endToEnd.strict.denominator}`);
    assert(Math.abs(s.endToEnd.strict.rate - 0.5) < 1e-9, 'dashscope 成功率 50%', `${s.endToEnd.strict.rate}`);
  }

  // ---------- 8. 真实 API ----------
  console.log('\n[8] GET /api/stats 真实返回');
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
  const port = await pickFreePort(3085);
  if (!port) {
    assert(false, '找到可用端口', '3085-3104 全被占用');
    summary();
    return;
  }
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { const r = await fetch(`http://127.0.0.1:${port}/api/stats`); if (r.ok) { ready = true; break; } } catch (e) {}
    }
    assert(ready, '服务启动且 /api/stats 可用', `port=${port}`);
    if (ready) {
      const j = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
      assert(j.scope && typeof j.scope.total === 'number', '返回 scope.total', `total=${j.scope && j.scope.total}`);
      assert(j.endToEnd && j.endToEnd.strict, '返回 endToEnd.strict');
      assert(j.clips && j.clips.firstPassRate, '返回 clips.firstPassRate');
      assert(j.target && typeof j.target.endToEndMet !== 'undefined', '返回 target 达标判断');
      assert(Array.isArray(j.warnings), '返回 warnings 数组', `${(j.warnings || []).length} 条`);
      console.log(`     真实数据：total=${j.scope.total}, 可信已结束=${j.endToEnd.strict.denominator}`
        + `, 端到端=${j.endToEnd.strict.percent}%, 一次通过率=${j.clips.firstPassRate.percent}%`);

      // includeUntrusted
      const j2 = await (await fetch(`http://127.0.0.1:${port}/api/stats?includeUntrusted=1`)).json();
      assert(j2.scope.untrustedIncluded >= 0, 'includeUntrusted=1 参数生效',
        `untrustedIncluded=${j2.scope.untrustedIncluded}`);
    }
  } finally {
    try { srv.kill(); } catch (e) {}
    await new Promise(r => setTimeout(r, 800));
    try {
      execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore' });
    } catch (e) {}
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
  console.error('验收异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
