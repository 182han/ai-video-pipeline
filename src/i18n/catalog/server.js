// ==========================================
// 后端 catalog · 通用/系统级（P2）
// 对应 i18n-spec §3.4：只加 code / messageKey / params，中文 error 原文不动。
// ==========================================

'use strict';

module.exports = {
  zh: {
    'api.system.internalError': '服务器内部错误',
    'api.system.badRequest': '请求参数不合法',
    'api.system.notFound': '接口不存在',
    'api.system.methodNotAllowed': '不支持该请求方法'
  },
  en: {
    'api.system.internalError': 'Internal server error',
    'api.system.badRequest': 'Invalid request parameters',
    'api.system.notFound': 'API endpoint not found',
    'api.system.methodNotAllowed': 'Request method not allowed'
  }
};
