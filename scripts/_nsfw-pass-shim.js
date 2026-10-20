// ==========================================================
// 测试专用预加载 shim（**不是生产代码**）
//
// 用途：让 `verify-frontend-contract.js` 起的独立 server 进程里，
// NSFW 检测返回「通过」。
//
// 为什么需要：当前 .env 没有 OPENAI_API_KEY，checkNSFW 按既有设计判 passed:false
// （changelog 已记录这是预期行为）。但片段质检会因此失败 → 流水线在「片段生成」
// 中止 → 档位/补跑相关步骤根本走不到，契约校验无从进行。
//
// NSFW 检测本身由 scripts/verify-nsfw.js 独立验收 42 项，不受此 shim 影响。
//
// 用法：node --require ./scripts/_nsfw-pass-shim.js server.js
// ==========================================================

try {
  const qc = require('../src/qualityChecker');
  const orig = qc.checkNSFW;
  qc.checkNSFW = async function () {
    return {
      passed: true,
      qcVersion: 2,
      reason: '【测试 shim】前端契约校验专用，视为通过（NSFW 由 verify-nsfw.js 单独验收）',
      level: 'pass',
      injected: true
    };
  };
  if (process.env.DSH_TEST_SHIM_VERBOSE === '1') {
    console.log('[shim] checkNSFW 已替换为「始终通过」（测试专用）');
  }
} catch (e) {
  console.error('[shim] 注入失败:', e && e.message);
}
