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
    'api.users.badUsername': '账号需 2–10 位，仅限中文、英文字母',
    'api.users.passwordTooShort': '密码至少 {min} 位',
    'api.users.passwordTooLong': '密码最多 {max} 位',
    'api.users.passwordMissingClasses': '密码必须同时包含大写字母、小写字母、数字和符号',
    'api.users.passwordTooCommon': '这个密码过于常见，请换一个',
    'api.users.passwordContainsUsername': '密码不能包含账号名',
    'api.users.passwordTooWeak': '密码太简单：不能全是数字、重复字符或连续序列',
    'api.users.passwordInvalid': '密码格式不正确',
    'api.users.currentPasswordRequired': '修改自己的密码需要输入当前密码',
    'api.users.currentPasswordWrong': '当前密码不正确',
    'api.users.lastAccount': '至少要保留一个账号',
    'api.users.cannotDeleteSelf': '不能删除当前登录的账号',
    'api.users.notFound': '账号不存在',
    'api.users.badRole': '角色只能是 member 或 demo',
    'api.users.listFailed': '读取账号列表失败',
    'api.users.createFailed': '新建账号失败',
    'api.users.exists': '账号已存在，请换一个名称',
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
    'api.users.badUsername': 'Username must be 2–10 characters: Chinese or English letters only.',
    'api.users.passwordTooShort': 'Password must be at least {min} characters.',
    'api.users.passwordTooLong': 'Password must be at most {max} characters.',
    'api.users.passwordMissingClasses': 'Password must include uppercase, lowercase, digit, and symbol.',
    'api.users.passwordTooCommon': 'That password is too common. Choose another.',
    'api.users.passwordContainsUsername': 'Password must not contain the username.',
    'api.users.passwordTooWeak': 'Password is too easy to guess: avoid all digits, repeated characters, or sequences.',
    'api.users.passwordInvalid': 'Password format is invalid.',
    'api.users.currentPasswordRequired': 'Enter your current password to change it.',
    'api.users.currentPasswordWrong': 'Current password is incorrect.',
    'api.users.lastAccount': 'At least one account must remain.',
    'api.users.cannotDeleteSelf': 'You cannot delete the account you are signed in with.',
    'api.users.notFound': 'Account not found',
    'api.users.badRole': 'Role must be member or demo.',
    'api.users.listFailed': 'Could not list accounts.',
    'api.users.createFailed': 'Could not create the account.',
    'api.users.exists': 'That account name already exists. Choose another.',
    'api.users.updateFailed': 'Could not update the account.',
    'api.users.deleteFailed': 'Could not delete the account.'
  }
};
