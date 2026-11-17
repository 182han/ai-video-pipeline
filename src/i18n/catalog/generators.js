// ==========================================
// 后端 catalog · 生成器用户可见错误（P3）
// 只登记「厂商无关/常见」的中文原文前缀；第三方原文本身不翻译（spec §6.3）。
// 用途：taskManager 在失败边界用 keyForText(prefix) 反查，给 task/clip 补 errorKey。
// ==========================================

'use strict';

module.exports = {
  zh: {
    'gen.error.unsupportedModel': '不支持的模型',
    'gen.error.dashscopeKeyMissing': 'DashScope API Key 未配置',
    'gen.error.dashscopeBaseMissing': 'DashScope Base URL 未配置',
    'gen.error.dashscopeApiError': 'DashScope API 错误',
    'gen.error.dashscopeNoTaskId': 'DashScope API 未返回 task_id',
    'gen.error.openaiVideoKeyMissing': 'OpenAI 兼容视频的 API Key 未配置',
    'gen.error.openaiVideoBaseMissing': 'OpenAI 兼容视频的 Base URL 未配置',
    'gen.error.openaiVideoEmptyPrompt': '视频生成提示词为空',
    'gen.error.openaiVideoApiError': 'OpenAI 兼容视频 API 错误',
    'gen.error.openaiVideoNoTaskId': '视频接口未返回任务 id',
    'gen.error.klingKeysMissing': '可灵 API 需要同时配置 AccessKey 和 SecretKey',
    'gen.error.klingApiError': '可灵API错误',
    'gen.error.agnesKeyMissing': 'Agnes AI API Key 未配置',
    'gen.error.agnesApiError': 'Agnes API 错误',
    'gen.error.downloadFailed': '视频下载失败',
    'gen.error.downloadHttpFailed': '下载失败',
    'gen.error.firstFrameEmpty': '图生视频首帧为空',
    'gen.error.seedanceKeyMissing': 'Seedance API Key 未配置',
    'gen.error.imageProviderInvalid': '出图适配器',
    'gen.error.imageProviderNoPath': '出图适配器「'
  },
  en: {
    'gen.error.unsupportedModel': 'Unsupported model',
    'gen.error.dashscopeKeyMissing': 'DashScope API key is not configured',
    'gen.error.dashscopeBaseMissing': 'DashScope base URL is not configured (requires WorkspaceId + Region)',
    'gen.error.dashscopeApiError': 'DashScope API error',
    'gen.error.dashscopeNoTaskId': 'DashScope API did not return a task_id',
    'gen.error.openaiVideoKeyMissing': 'The OpenAI-compatible video API key is not configured',
    'gen.error.openaiVideoBaseMissing': 'The OpenAI-compatible video base URL is not configured',
    'gen.error.openaiVideoEmptyPrompt': 'The video prompt is empty',
    'gen.error.openaiVideoApiError': 'OpenAI-compatible video API error',
    'gen.error.openaiVideoNoTaskId': 'The video API did not return a task id',
    'gen.error.klingKeysMissing': 'Kling requires both AccessKey and SecretKey',
    'gen.error.klingApiError': 'Kling API error',
    'gen.error.agnesKeyMissing': 'Agnes AI API key is not configured',
    'gen.error.agnesApiError': 'Agnes API error',
    'gen.error.downloadFailed': 'Video download failed',
    'gen.error.downloadHttpFailed': 'Download failed',
    'gen.error.firstFrameEmpty': 'The first frame for image-to-video is empty',
    'gen.error.seedanceKeyMissing': 'Seedance API key is not configured',
    'gen.error.imageProviderInvalid': 'Image provider adapter error',
    'gen.error.imageProviderNoPath': 'Image provider adapter did not return a valid image path'
  }
};
