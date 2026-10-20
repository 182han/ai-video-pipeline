// ==========================================================
// 2026-10-20 三个缺陷修复的验收
//
// 缺陷来源（用户实测：2 片段任务只出 1 个片段、成片点不开）：
//   1. 拼接时片段缺失只记 passed:true → 用户毫无察觉
//   2. 任务卡在 mixing 无人回收 → 永远拿不到成片
//   3. checkFinal 不传配置 → 终检的 NSFW 用的是 .env 默认模型，不是用户填的
//
// 每项都要有「正向 + 负向」证据（§5.1）。
// ==========================================================

const fs = require('fs');
const path = require('path');
const pipeline = require('../src/pipeline');
const taskManager = require('../src/taskManager');

let pass = 0, fail = 0;
const findings = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; findings.push(name); console.log(`  ❌ ${name}${detail ? `  — ${detail}` : ''}`); }
}

// ============================================================
// 1. _finalQcOptions：终检必须拿到用户的运行时配置
// ============================================================
function testFinalQcOptions() {
  console.log('\n[1] 终检配置透传（checkFinal 不再用 .env 默认值）');

  const withCfg = pipeline._finalQcOptions({
    model: 'dashscope',
    runtimeConfig: {
      multimodalApiKey: 'sk-user-key',
      multimodalBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      multimodalModel: 'qwen3-vl-plus'
    }
  });
  ok(withCfg.nsfw.apiKey === 'sk-user-key', '透传多模态 Key', withCfg.nsfw.apiKey);
  ok(withCfg.nsfw.baseUrl.includes('dashscope'), '透传 BaseUrl');
  ok(withCfg.nsfw.model === 'qwen3-vl-plus', '透传模型名（用户填的 qwen3-vl-plus）', withCfg.nsfw.model);
  ok(withCfg.nsfw.syntheticSource === false, '非 mock → syntheticSource=false');

  // 负向：只填了 LLM Key 时也要能回退拿到（否则终检仍然没 Key）
  const llmOnly = pipeline._finalQcOptions({
    model: 'dashscope',
    runtimeConfig: { llmApiKey: 'sk-llm-only' }
  });
  ok(llmOnly.nsfw.apiKey === 'sk-llm-only', '只配 LLM Key 时回退使用（负向场景）', llmOnly.nsfw.apiKey);

  // Mock 任务：终检也要走合成素材判定
  const mockTask = pipeline._finalQcOptions({ model: 'mock', runtimeConfig: {} });
  ok(mockTask.nsfw.syntheticSource === true, 'mock 任务 → syntheticSource=true');

  // 防御：空任务不能抛
  ok(typeof pipeline._finalQcOptions(null) === 'object', '传 null 不抛异常（防御）');

  // 关键：源码里三处 checkFinal 都必须传第二个参数。
  // 注意要排除注释——说明文字里也会出现 checkFinal(finalPath) 这种写法，
  // 直接匹配会假报（实测踩过：把注释当成了裸调用）。
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');
  const codeOnly = src2
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))   // 去掉整行注释
    .map(line => line.replace(/\/\/.*$/, ''))            // 去掉行尾注释
    .join('\n');
  const bareCalls = (codeOnly.match(/checkFinal\(\s*finalPath\s*\)/g) || []).length;
  const withOpts = (codeOnly.match(/checkFinal\(\s*finalPath\s*,\s*this\._finalQcOptions/g) || []).length;
  ok(bareCalls === 0, '没有裸调用 checkFinal(finalPath)（不带配置）', `裸调用 ${bareCalls} 处`);
  ok(withOpts >= 3, '三处 checkFinal 都传了运行时配置', `实际 ${withOpts} 处`);
}

// ============================================================
// 2. 片段缺失告警：丢片段必须判 fail，不能静默 passed
// ============================================================
function testClipLossDetection() {
  console.log('\n[2] 片段缺失告警（丢片段必须 fail）');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');

  // 旧的静默写法必须彻底消失
  ok(!/仅有1个成功片段，跳过拼接/.test(src),
    '旧的静默写法已移除（曾写死 passed:true）');

  // 必须能区分「本来 1 个」和「丢了一个」
  ok(/expectedClips\s*=\s*task\.totalClips/.test(src), '计算应有片段数 task.totalClips');
  ok(/lostClips\s*=\s*Math\.max\(0,\s*expectedClips - successClips\.length\)/.test(src),
    '计算丢失片段数 lostClips');
  ok(/passed:\s*!clipLost/.test(src), 'passed 绑定 clipLost（丢片段即 false）');
  ok(/片段缺失：应有/.test(src), '写明「片段缺失：应有 N 个」的可读原因');

  // 必须有 ERROR 级日志（便于从日志里查到）
  ok(/console\.error\(`\[\$\{taskId\}\] ⚠️ 片段缺失/.test(src), '同时打 ERROR 级日志');
}

// ============================================================
// 3. 僵尸任务回收
// ============================================================
async function testReconcile() {
  console.log('\n[3] 僵尸任务回收（进程中断的残留）');

  ok(typeof pipeline.reconcileInterruptedTasks === 'function', '存在 reconcileInterruptedTasks 方法');

  // 造一个卡在 mixing 的任务
  const t = taskManager.createTask('回收测试-僵尸任务', { model: 'mock', totalClips: 1, clipDuration: 3 });
  const id = t.taskId;
  taskManager.updateTaskStatus(id, 'mixing', { currentStep: '配乐混音' });
  taskManager.recordStepComplete(id, 'prompt_optimize', { qcResult: 'pass' });

  const before = taskManager.getTask(id).status;
  ok(before === 'mixing', '构造出 mixing 状态的任务', before);

  // 执行回收
  const recovered = await pipeline.reconcileInterruptedTasks();
  const mine = recovered.find(r => r.taskId === id);
  ok(!!mine, '该任务被识别为僵尸并回收', JSON.stringify(mine));

  const after = taskManager.getTask(id);
  ok(after.status === 'failed', '回收后状态为 failed（不冒充 completed）', after.status);
  ok(/服务进程中断/.test(String(after.error || '')), '写明中断原因', String(after.error || '').slice(0, 40));
  ok(/已完成步骤/.test(String(after.error || '')), '记录已完成步骤（便于判断能否补跑）');

  // 负向：已完成的任务不能被误回收
  const okTask = taskManager.createTask('回收测试-已完成', { model: 'mock', totalClips: 1, clipDuration: 3 });
  taskManager.updateTaskStatus(okTask.taskId, 'completed', { currentStep: '已完成' });
  const recovered2 = await pipeline.reconcileInterruptedTasks();
  const wrongly = recovered2.find(r => r.taskId === okTask.taskId);
  ok(!wrongly, '已完成的任务不会被误回收（负向验证）');
  ok(taskManager.getTask(okTask.taskId).status === 'completed', '已完成任务状态不变');

  // 清理
  const { cleanupTask } = require('./_test-cleanup');
  await cleanupTask(id, taskManager);
  await cleanupTask(okTask.taskId, taskManager);
}

// ============================================================
// 4. 日志落盘
// ============================================================
function testLogFile() {
  console.log('\n[4] 日志落盘（事后可追溯）');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/data.*logs|'logs'/.test(src), 'server.js 配置了日志目录');
  ok(/appendFileSync\(LOG_FILE/.test(src), '使用 appendFileSync 写入日志文件');
  ok(/console\.log = .*=>.*_logLine/.test(src.replace(/\n/g, ' ')), 'console.log 被劫持为双写');
  ok(/console\.error = .*=>.*_logLine/.test(src.replace(/\n/g, ' ')), 'console.error 也被双写');

  const dir = path.join(__dirname, '..', 'data', 'logs');
  const exists = fs.existsSync(dir) && fs.readdirSync(dir).filter(f => f.startsWith('server-')).length > 0;
  ok(exists, '日志目录已有实际文件（启动过一次即产生）');
}

async function main() {
  console.log('='.repeat(66));
  console.log('三个缺陷修复验收');
  console.log('='.repeat(66));
  testFinalQcOptions();
  testClipLossDetection();
  await testReconcile();
  testLogFile();

  console.log('\n' + '='.repeat(66));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (findings.length) { console.log('失败项：'); findings.forEach(f => console.log('  - ' + f)); }
  console.log('='.repeat(66));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('验收异常:', e && e.stack || e); process.exit(1); });
