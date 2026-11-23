// ==========================================
// 后端 catalog · 登录 / 成员（P2）
// ==========================================

'use strict';

module.exports = {
  zh: {
    'api.auth.required': '未登录',
    'api.auth.locked': '尝试次数过多，请 {retryAfter} 秒后再试',
    'api.auth.lockedNow': '尝试次数过多，已锁定',
    'api.auth.missingCredentials': '请输入账号和密码',
    'api.auth.storageDown': '认证服务不可用',
    'api.auth.badCredentials': '账号或密码错误',
    'api.auth.forbidden': '没有权限执行该操作',
    'api.users.badUsername': '账号需 2–32 位，仅限字母、数字、下划线、点、@、横线',
    'api.users.passwordTooShort': '密码至少 {min} 位',
    'api.users.lastAccount': '至少要保留一个账号',
    'api.users.cannotDeleteSelf': '不能删除当前登录的账号',
    'api.users.notFound': '账号不存在',
    'api.users.badRole': '角色只能是 member 或 demo',
    'api.users.listFailed': '读取账号列表失败',
    'api.users.createFailed': '新建账号失败',
    'api.users.updateFailed': '更新账号失败',
    'api.users.deleteFailed': '删除账号失败'
  },
  en: {
    'api.auth.required': 'Not signed in',
    'api.auth.locked': 'Too many attempts. Try again in {retryAfter} seconds.',
    'api.auth.lockedNow': 'Too many attempts. Sign-in is locked for now.',
    'api.auth.missingCredentials': 'Enter your username and password.',
    'api.auth.storageDown': 'Authentication service is unavailable.',
    'api.auth.badCredentials': 'Incorrect username or password',
    'api.auth.forbidden': 'You do not have permission to perform this action.',
    'api.users.badUsername': 'Username must be 2–32 characters: letters, digits, underscore, dot, @, or hyphen.',
    'api.users.passwordTooShort': 'Password must be at least {min} characters.',
    'api.users.lastAccount': 'At least one account must remain.',
    'api.users.cannotDeleteSelf': 'You cannot delete the account you are signed in with.',
    'api.users.notFound': 'Account not found',
    'api.users.badRole': 'Role must be member or demo.',
    'api.users.listFailed': 'Could not list accounts.',
    'api.users.createFailed': 'Could not create the account.',
    'api.users.updateFailed': 'Could not update the account.',
    'api.users.deleteFailed': 'Could not delete the account.'
  }
};
