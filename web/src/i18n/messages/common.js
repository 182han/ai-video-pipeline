// ============================================================
// i18n · 通用词条（每个 namespace 文件内中英并排，避免两份文件漂移）
// 规范见 docs/spec/i18n-spec.md §4
// ============================================================
export default {
  zh: {
    common: {
      language: '语言',
      languageSwitch: '切换语言',
      save: '保存',
      cancel: '取消',
      confirm: '确认',
      delete: '删除',
      close: '关闭',
      back: '返回',
      next: '下一步',
      prev: '上一步',
      retry: '重试',
      refresh: '刷新',
      loading: '加载中…',
      search: '搜索',
      copy: '复制',
      copied: '已复制',
      unknownError: '未知错误',
      // 英文界面下，历史任务/图片只有中文原文、且无法离线生成英文时的统一占位（绝不回退中文）
      promptEnMissing: '（中文原文 · 暂无英文版本）',
      followUi: '跟随界面',
      notSet: '未设置',
      none: '无',
      on: '开',
      off: '关',
      yes: '是',
      no: '否',
      more: '更多',
      all: '全部',
      itemCount: '共 {n} 项',
      itemCount_one: '共 {n} 项',
      itemCount_other: '共 {n} 项'
    }
  },
  en: {
    common: {
      language: 'Language',
      languageSwitch: 'Switch language',
      save: 'Save',
      cancel: 'Cancel',
      confirm: 'Confirm',
      delete: 'Delete',
      close: 'Close',
      back: 'Back',
      next: 'Next',
      prev: 'Back',
      retry: 'Retry',
      refresh: 'Refresh',
      loading: 'Loading…',
      search: 'Search',
      copy: 'Copy',
      copied: 'Copied',
      unknownError: 'Unknown error',
      promptEnMissing: '(Chinese original · no English version)',
      followUi: 'Follow interface',
      notSet: 'Not set',
      none: 'None',
      on: 'On',
      off: 'Off',
      yes: 'Yes',
      no: 'No',
      more: 'More',
      all: 'All',
      itemCount: '{n} item(s)',
      itemCount_one: '{n} item',
      itemCount_other: '{n} items'
    }
  }
};
