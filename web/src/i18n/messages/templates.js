// ============================================================
// i18n · 模板库 + 提示词规则
// 键分组：templates.*
// 注意：套用模板时拼出的「提示词内容」属于 AI 输出语言（P3 处理），
//       本轮只翻译界面文案。
// ============================================================
export default {
  zh: {
    templates: {
      title: '模板库',
      count: '{n} 个',
      count_one: '{n} 个',
      count_other: '{n} 个',
      back: '返回创作',
      new: '＋ 新增模板',
      newTitle: '新增模板',
      editing: '编辑「{name}」',
      id: '模板 ID（英文）',
      name: '名称',
      keywords: '关键词（逗号分隔）',
      enhancers: '增强词（逗号分隔）',
      negative: '负向词',
      save: '保存',
      cancel: '取消',
      apply: '套用',
      edit: '编辑',
      delete: '删除',
      rulesTitle: '提示词优化规则',
      rulesStore: '存 data/optimization_rules.txt',
      saveRules: '保存规则',
      rulesSaved: '规则已保存',
      rulesSaveFailed: '保存规则失败：',
      nameRequired: '名称必填',
      idRequired: '模板 ID 必填',
      saved: '已保存',
      saveFailed: '保存模板失败：',
      deleteConfirm: '删除模板「{name}」？',
      deleteFailed: '删除失败：',
      sep: '、',
      applySuffix: '的画面',
      period: '。'
    }
  },
  en: {
    templates: {
      title: 'Templates',
      count: '{n} template(s)',
      count_one: '{n} template',
      count_other: '{n} templates',
      back: 'Back to create',
      new: '+ New template',
      newTitle: 'New template',
      editing: 'Edit "{name}"',
      id: 'Template ID (ASCII)',
      name: 'Name',
      keywords: 'Keywords (comma separated)',
      enhancers: 'Enhancers (comma separated)',
      negative: 'Negative prompt',
      save: 'Save',
      cancel: 'Cancel',
      apply: 'Apply',
      edit: 'Edit',
      delete: 'Delete',
      rulesTitle: 'Prompt optimization rules',
      rulesStore: 'Stored in data/optimization_rules.txt',
      saveRules: 'Save rules',
      rulesSaved: 'Rules saved',
      rulesSaveFailed: 'Failed to save rules: ',
      nameRequired: 'Name is required',
      idRequired: 'Template ID is required',
      saved: 'Saved',
      saveFailed: 'Failed to save template: ',
      deleteConfirm: 'Delete template "{name}"?',
      deleteFailed: 'Delete failed: ',
      sep: ', ',
      applySuffix: ' imagery',
      period: '.'
    }
  }
};
