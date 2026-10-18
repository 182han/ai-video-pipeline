// ==========================================
// 敏感信息脱敏工具
// ==========================================
// 背景：前端会把 API Key 随请求传进来，任务对象里带着 runtimeConfig。
// 这些 Key 一旦落盘（JSON 文件 / 数据库），就会随备份、上传、日志泄露。
//
// 策略：Key 只在**内存里**用于当次生成，落盘前一律清空。
// 生成过程中需要 Key 时，从内存态读取即可（本进程内有效）。
// ==========================================

// 需要脱敏的字段名
const SENSITIVE_FIELDS = [
  'apiKey',
  'llmApiKey',
  'multimodalApiKey',
  'klingAccessKey',
  'klingSecretKey',
  'accessKey',
  'secretKey',
  'serviceKey',
  'token',
  'password'
];

/**
 * 返回脱敏后的任务副本（不修改原对象）。
 * 用于落盘 / 写数据库 / 输出到日志前的最后一道防线。
 */
function redactTask(task) {
  if (!task || typeof task !== 'object') return task;

  const copy = { ...task };

  if (copy.runtimeConfig && typeof copy.runtimeConfig === 'object') {
    const rc = { ...copy.runtimeConfig };
    for (const k of SENSITIVE_FIELDS) {
      if (rc[k]) rc[k] = '';
    }
    copy.runtimeConfig = rc;
  }

  // 顶层也可能出现（例如某些接口直接塞 apiKey）
  for (const k of SENSITIVE_FIELDS) {
    if (copy[k]) copy[k] = '';
  }

  return copy;
}

/**
 * 只保留 Key 是否存在的标记，用于前端展示"已配置/未配置"。
 */
function summarizeRuntimeConfig(task) {
  if (!task || !task.runtimeConfig) return {};
  const rc = task.runtimeConfig;
  return {
    hasVideoKey: !!rc.apiKey,
    hasLlmKey: !!rc.llmApiKey,
    hasMultimodalKey: !!rc.multimodalApiKey,
    modelId: rc.modelId || '',
    apiBaseUrl: rc.apiBaseUrl || ''
  };
}

module.exports = { redactTask, summarizeRuntimeConfig, SENSITIVE_FIELDS };
