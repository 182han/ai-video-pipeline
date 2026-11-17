// ==========================================
// 小智 V2 · 敏感文本脱敏（共享工具）
// ------------------------------------------------------------
// 用途（共同契约 §0.4）：Key **只报有/无**，不落盘、不回显、不进审计、不进播报。
// 这里只做「文本级」兜底：任务 error、最近错误日志、审计字段在写出/返回前都过一遍。
//
// 注意：这不是加密，也不是访问控制；真正的保证是「上层从不把 Key 值传进来」。
// 本文件只是最后一道防线，防止上游异常把 Bearer/环境变量原值塞进文本里。
// ==========================================

'use strict';

const RULES = [
  // OpenAI 风格 sk-xxx / sk-proj-xxx
  [/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***'],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // KEY=xxx / apiKey: xxx / token=xxx
  [/((?:[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password))[A-Za-z0-9_]*\s*[=:]\s*)[^\s,;'"]+/gi, '$1***']
];

function redactText(input) {
  let s = String(input === undefined || input === null ? '' : input);
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

// 深拷贝 + 递归脱敏（审计的 before/after 用；只处理 JSON 可表达的类型）
function redactDeep(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => redactDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 30)) {
      if (/(?:api[_-]?key|access[_-]?key|secret|token|password)/i.test(k)) {
        out[k] = '***';
        continue;
      }
      out[k] = redactDeep(value[k], depth + 1);
    }
    return out;
  }
  return redactText(String(value));
}

module.exports = { redactText, redactDeep };
