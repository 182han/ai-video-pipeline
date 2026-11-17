// ==========================================
// 后端 catalog · 小智（P2 API 错误；P3 的助手话术/提示词在 src/i18n/templates/）
// ==========================================

'use strict';

module.exports = {
  zh: {
    'api.assistant.badSession': '需要 sessionId',
    'api.assistant.emptyText': '没有收到要说的话',
    'api.assistant.handleFailed': '小智处理失败',
    'api.assistant.executeFailed': '小智执行失败',
    'api.assistant.contextFailed': '读取环境失败',
    'api.assistant.prefsFailed': '读取或写入偏好失败',
    'api.assistant.prefsNotApproved': '偏好写入是设置变更（L3），需要明确确认（approved=true）；现在没有改任何东西',
    'api.assistant.prefsClearNotApproved': '清空偏好属于设置变更（L3），需要明确确认（approved=true）；现在没有清空任何东西',
    'api.assistant.settingsNotApproved': '设置变更需要明确确认（approved=true）；现在没有改任何东西',
    'api.assistant.repairNotApproved': '修复执行是可能花钱的动作（L3），需要明确确认（approved=true）；现在没有执行任何修复',
    'api.assistant.repairFailed': '修复执行失败',
    'api.assistant.auditFailed': '读取审计记录失败',
    'api.assistant.asrFailed': '语音识别异常',
    'api.assistant.asrEmpty': '没有收到可识别的音频',
    'api.assistant.understandConsent': '让模型解析计划卡会产生少量 LLM 费用；需要用户明确同意（consent=true）后才会发请求',
    'api.assistant.noLlmKey': '未配置 LLM Key',
    'api.assistant.emptyMessages': 'messages 必须是非空数组',
    'api.assistant.noHistory': '没有有效的对话内容',
    'api.assistant.llmFailed': '助手没有响应，请检查网络或 API Key 后重试',
    'api.assistant.badLlmJson': '模型没有返回预期的 JSON',
    'api.assistant.badSlotsJson': '模型没有按格式返回计划卡槽位',
    'api.assistant.imageGenNotReady': '出图未就绪',
    'api.assistant.executeNotApproved': '这是付费任务，需要你明确确认后才会开始',
    'api.assistant.noPlan': '还没有计划卡，先说时长和主题',
    'api.assistant.alreadyRunning': '这条计划已经在执行中，不会重复创建任务'
  },
  en: {
    'api.assistant.badSession': 'sessionId is required',
    'api.assistant.emptyText': 'No message to process',
    'api.assistant.handleFailed': 'Xiaozhi could not process the request',
    'api.assistant.executeFailed': 'Xiaozhi could not execute the plan',
    'api.assistant.contextFailed': 'Could not read the environment context',
    'api.assistant.prefsFailed': 'Could not read or write preferences',
    'api.assistant.prefsNotApproved': 'Writing preferences is a settings change (L3). It requires explicit approval (approved=true). Nothing was changed.',
    'api.assistant.prefsClearNotApproved': 'Clearing preferences is a settings change (L3). It requires explicit approval (approved=true). Nothing was cleared.',
    'api.assistant.settingsNotApproved': 'This settings change requires explicit approval (approved=true). Nothing was changed.',
    'api.assistant.repairNotApproved': 'Running a repair may cost money (L3). It requires explicit approval (approved=true). No repair was run.',
    'api.assistant.repairFailed': 'Repair failed',
    'api.assistant.auditFailed': 'Could not read the audit log',
    'api.assistant.asrFailed': 'Speech recognition failed',
    'api.assistant.asrEmpty': 'No recognizable audio was received',
    'api.assistant.understandConsent': 'Parsing the plan card with a model incurs a small LLM cost. The request is sent only after explicit approval (consent=true).',
    'api.assistant.noLlmKey': 'No LLM key configured',
    'api.assistant.emptyMessages': 'messages must be a non-empty array',
    'api.assistant.noHistory': 'No valid conversation content',
    'api.assistant.llmFailed': 'The assistant did not respond. Check your network or API key and try again.',
    'api.assistant.badLlmJson': 'The model did not return the expected JSON',
    'api.assistant.badSlotsJson': 'The model did not return plan slots in the expected format',
    'api.assistant.imageGenNotReady': 'Image generation is not ready',
    'api.assistant.executeNotApproved': 'This is a paid task. It starts only after you explicitly approve it.',
    'api.assistant.noPlan': 'No plan card yet. Start by telling me the duration and theme.',
    'api.assistant.alreadyRunning': 'This plan is already running, so no duplicate task will be created.'
  }
};
