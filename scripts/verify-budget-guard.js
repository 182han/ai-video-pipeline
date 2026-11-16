// ==========================================================
// 预算闸门 + 提交去重 验收（2026-11-14）
// ----------------------------------------------------------
// 只用单元/静态断言，不启动服务、不发任何真实请求、不花钱。
// 口径依据：WhaleTV usage-logs-20261108-20261114.csv 的真实扣费
//   720P $0.10/s · 1080P $0.20/s · 图片 $0.03/张
// ==========================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function group(title) { console.log('\n[' + title + ']'); }

const ROOT = path.join(__dirname, '..');
const tmpBudget = path.join(os.tmpdir(), 'dsh-budget-verify-' + process.pid + '-' + Date.now() + '.json');
process.env.BUDGET_FILE = tmpBudget;
process.env.BUDGET_USD = '196';
process.env.DUP_WINDOW_MS = '60000';

const budget = require('../src/budget');
const guard = require('../src/submitGuard');

group('1. 初始状态');
{
  const st = budget.status();
  ok(st.currency === 'USD', '币种是 USD');
  ok(Math.abs(st.balanceUsd - 196) < 1e-9, '初始余额 196', String(st.balanceUsd));
  ok(Math.abs(st.spentUsd) < 1e-9, '初始已花 0');
  ok(budget.videoRate('720p') === 0.10, '720P 单价 $0.10/s');
  ok(budget.videoRate('1080P') === 0.20, '1080P 单价 $0.20/s（大小写不敏感）');
  ok(budget.videoRate('4k') === 0.40, '4K 单价 $0.40/s');
}

group('2. 预估公式');
{
  const one = budget.estimateTask({ clips: 1, seconds: 5, resolution: '1080p' });
  ok(Math.abs(one.usd - 1.00) < 1e-9, '1 段 5s 1080P = $1.00', String(one.usd));
  const m30 = budget.estimateTask({ clips: 124, seconds: 15, resolution: '1080p' });
  ok(Math.abs(m30.usd - 372) < 1e-9, '30 分钟（124×15s）1080P = $372', String(m30.usd));
  const m30_720 = budget.estimateTask({ clips: 124, seconds: 15, resolution: '720p' });
  ok(Math.abs(m30_720.usd - 186) < 1e-9, '30 分钟 720P = $186', String(m30_720.usd));
  ok(Math.abs(budget.estimateImage(4) - 0.12) < 1e-9, '4 张图 = $0.12');
  ok(Math.abs(budget.estimateLlm(13) - 0.039) < 1e-9, '13 次 LLM = $0.039');
}

group('3. 扣款 / 余额边界');
{
  const st = budget.reserve({ usd: 1.0, kind: 'video', taskId: 't1', meta: { clips: 1 } });
  ok(Math.abs(st.balanceUsd - 195) < 1e-9, '扣 $1 后余额 195', String(st.balanceUsd));
  ok(Math.abs(st.spentUsd - 1) < 1e-9, '累计已花 1');
  ok(st.entries[st.entries.length - 1].taskId === 't1', '账本记录 taskId');
  ok(budget.canAfford(195) === true, '余额正好够 = true');
  ok(budget.canAfford(195.01) === false, '超出 0.01 = false');

  let err = null;
  try { budget.reserve({ usd: 200, kind: 'video', taskId: 't2' }); } catch (e) { err = e; }
  ok(err && err.code === 'INSUFFICIENT_BUDGET', '超额扣款抛 INSUFFICIENT_BUDGET');
  ok(Math.abs(budget.status().balanceUsd - 195) < 1e-9, '失败扣款不改变余额');
}

group('4. 手动对账 + 持久化');
{
  const st = budget.setBalance(100);
  ok(Math.abs(st.balanceUsd - 100) < 1e-9, '对账后余额 100');
  ok(Math.abs(st.initialUsd - 101) < 1e-9, 'initial = 余额 + 已花（可审计）', String(st.initialUsd));
  ok(fs.existsSync(tmpBudget), '预算文件已落盘');

  delete require.cache[require.resolve('../src/budget')];
  const budget2 = require('../src/budget');
  ok(Math.abs(budget2.status().balanceUsd - 100) < 1e-9, '重新加载后余额仍是 100');
}

group('4b. 任务结束结算（失败退未用秒数）');
{
  // 当前：余额 100，已花 1
  const afterReserve = budget.reserve({ usd: 2.0, kind: 'video', taskId: 't_settle' });
  ok(Math.abs(afterReserve.balanceUsd - 98) < 1e-9, '预扣 $2 后余额 98', String(afterReserve.balanceUsd));
  const r = budget.settle('t_settle', 0.5);
  ok(r && Math.abs(r.refundUsd - 1.5) < 1e-9, '只成功 0.5 秒 → 退回 $1.5', JSON.stringify(r));
  ok(Math.abs(budget.status().balanceUsd - 99.5) < 1e-9, '结算后余额 99.5');
  const again = budget.settle('t_settle', 0);
  ok(again === null, '同一任务重复结算不重复退款');
}

group('5. 提交指纹 / 去重窗口');
{
  const base = {
    model: 'dashscope', resolution: '1080p', clipDuration: 15, clips: 2,
    prompts: ['雪山 日出', '湖面 晨雾'], preset: 'final', transition: { enabled: true }
  };
  const fp1 = guard.fingerprint(guard.build(base));
  const fp2 = guard.fingerprint(guard.build({ ...base, prompts: ['雪山  日出', '湖面 晨雾'] }));
  ok(fp1 === fp2, '空白差异归一到同一指纹');
  const fp3 = guard.fingerprint(guard.build({ ...base, prompts: ['雪山 日落', '湖面 晨雾'] }));
  ok(fp1 !== fp3, '提示词不同 → 指纹不同');
  const fp4 = guard.fingerprint(guard.build({ ...base, resolution: '720p' }));
  ok(fp1 !== fp4, '分辨率不同 → 指纹不同');

  guard.remember(fp1, { taskId: 'task_a', model: 'dashscope', clips: 2 });
  const hit = guard.check(fp1);
  ok(hit && hit.taskId === 'task_a', '同名任务命中并返回原 taskId');
  ok(guard.check(fp3) === null, '不同提示词不命中');

  // 窗口过期：把窗口改成 0 不可行（模块内已固化），这里直接验证 retryAfterSec 是正数
  ok(hit.retryAfterSec > 0 && hit.retryAfterSec <= 60, 'retryAfterSec 在窗口内', String(hit.retryAfterSec));
  guard.reset();
  ok(guard.check(fp1) === null, 'reset 后不再命中');
}

group('6. 接线静态断言');
{
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/app\.get\('\/api\/budget'/.test(serverSrc), 'GET /api/budget 已接线');
  ok(/app\.post\('\/api\/budget\/set'/.test(serverSrc), 'POST /api/budget/set 已接线');
  ok(/DUPLICATE_TASK/.test(serverSrc), '409 重复提交码已接线');
  ok(/INSUFFICIENT_BUDGET/.test(serverSrc), '402 余额不足码已接线');
  ok(/submitGuard\.check\(/.test(serverSrc), '创建任务前查重复指纹');
  ok(/submitGuard\.remember\(/.test(serverSrc), '创建成功后登记指纹');
  ok(/budget\.reserve\(/.test(serverSrc), '真实调用后扣预算');
  ok(/resolutionValue/.test(serverSrc), '预估与实际任务使用同一分辨率变量');
  ok(/budget\.estimateImage\(prompts\.length\)/.test(serverSrc), '批量出图按条数预检');
  ok(/budget\.estimateLlm\(1\)/.test(serverSrc), 'LLM 优化计预算');

  const createSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'create.js'), 'utf8');
  ok(/est\.usd/.test(createSrc), '创作页展示美元预估');
  ok(/est\.budget/.test(createSrc), '创作页展示服务端余额');
  ok(/服务端预算不足/.test(createSrc), '创作页有预算不足提示');
  ok(/DUPLICATE_TASK/.test(createSrc), '创作页对重复提交给二次确认');

  const tmSrc = fs.readFileSync(path.join(ROOT, 'src', 'taskManager.js'), 'utf8');
  ok(/budget\.settle\(/.test(tmSrc), '任务结束/失败时结算预算');
}

// 清理临时预算文件（不动真实 data/budget.json）
try { fs.unlinkSync(tmpBudget); } catch (e) { /* 忽略 */ }

console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
