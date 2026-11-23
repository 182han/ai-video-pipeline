// ==========================================
// 后端 catalog · 图片 / 照片 / 配乐 / 上传（P2）
// 只覆盖「参数校验/前置条件」这类用户可纠正的错误；第三方原文与 ffmpeg 输出不翻译（spec §6.3）。
// ==========================================

'use strict';

module.exports = {
  zh: {
    'api.images.promptRequired': 'prompt 不能为空',
    'api.images.promptTooLong': 'prompt 过长（{length} 字，上限 8000）',
    'api.images.promptsRequired': 'prompts 不能为空',
    'api.images.batchLimit': '单次最多 200 条（当前 {count}）',
    'api.images.gradeInvalid': '出图自动调色只能是 off（保留原图）或 calm（自动调色）',
    'api.images.insufficientBudget': '余额不足：生成 {count} 张图需 ${estimate}，剩余 ${balance}',
    'api.images.notReady': '图片生成尚未就绪',
    'api.images.missingKey': '缺少 DashScope API Key',
    'api.images.generateFailed': '图片生成失败',
    'api.images.batchFailed': '批量出图失败',
    'api.photos.notFound': '图片不存在',
    'api.photos.badStatus': 'status 只能是 pending / approved / rejected',
    'api.photos.needField': '需要提供 status / imagePrompt / videoPrompt / isFinal / scienceStatus',
    'api.photos.scienceNotPassed': '科学/物理审查未通过，不能设为最终版',
    'api.photos.sourceMissing': '原图文件不存在，无法调色',
    'api.photos.nothingToAdjust': '四个参数都为 0，没有可应用的调色（要恢复原图请传 reset:true）',
    'api.photos.adjustFailed': '调色失败',
    'api.photos.revertFailed': '回退原图失败',
    'api.bgm.trackNotFound': '音轨不存在: {id}',
    'api.bgm.waveformFailed': '生成波形失败',
    'api.bgm.prefsSaveFailed': '保存配乐偏好失败',
    'api.bgm.invalidPath': 'videoPath 必须是 output 目录内的合法路径（防路径穿越）',
    'api.bgm.videoMissing': '视频文件不存在',
    'api.bgm.mixFailed': '混音失败',
    'api.bgm.uploadUnsupported': '该接口只接收 JSON 元信息；音频文件请放入 assets/bgm/ 后再登记',
    'api.bgm.autoPlanFailed': '生成自动配乐失败',
    'api.bgm.previewFailed': '配乐预览失败',
    'api.bgm.exportFailed': '配乐导出失败',
    'api.bgm.perClipRemoved': '逐段配乐已下线，请使用「添加配乐」页面（POST /api/tasks/:id/audio）',
    'api.media.notFound': '素材不存在'
  },
  en: {
    'api.images.promptRequired': 'prompt cannot be empty',
    'api.images.promptTooLong': 'prompt is too long ({length} characters; limit is 8000).',
    'api.images.promptsRequired': 'prompts cannot be empty',
    'api.images.batchLimit': 'At most 200 prompts per request (received {count}).',
    'api.images.gradeInvalid': 'Auto grade must be off (keep the original) or calm (auto-adjust).',
    'api.images.insufficientBudget': 'Insufficient budget: generating {count} images costs ${estimate}, with ${balance} left.',
    'api.images.notReady': 'Image generation is not ready',
    'api.images.missingKey': 'DashScope API key is missing',
    'api.images.generateFailed': 'Image generation failed',
    'api.images.batchFailed': 'Batch image generation failed',
    'api.photos.notFound': 'Photo not found',
    'api.photos.badStatus': 'status must be one of pending / approved / rejected',
    'api.photos.needField': 'Provide at least one of status / imagePrompt / videoPrompt / isFinal / scienceStatus',
    'api.photos.scienceNotPassed': 'The science/physics review has not passed, so this photo cannot be marked final.',
    'api.photos.sourceMissing': 'The original image file is missing, so it cannot be adjusted.',
    'api.photos.nothingToAdjust': 'All four adjustment values are zero, so there is nothing to apply. Pass reset:true to restore the original.',
    'api.photos.adjustFailed': 'Color adjustment failed',
    'api.photos.revertFailed': 'Could not restore the original image',
    'api.bgm.trackNotFound': 'Track not found: {id}',
    'api.bgm.waveformFailed': 'Could not generate the waveform',
    'api.bgm.prefsSaveFailed': 'Could not save BGM preferences',
    'api.bgm.invalidPath': 'videoPath must resolve inside the output directory.',
    'api.bgm.videoMissing': 'Video file not found',
    'api.bgm.mixFailed': 'Audio mixing failed',
    'api.bgm.uploadUnsupported': 'This endpoint accepts JSON metadata only. Put audio files into assets/bgm/ and then register them.',
    'api.bgm.autoPlanFailed': 'Could not generate the automatic BGM plan',
    'api.bgm.previewFailed': 'BGM preview failed',
    'api.bgm.exportFailed': 'BGM export failed',
    'api.bgm.perClipRemoved': 'Per-clip music has been removed. Use the Add Music page (POST /api/tasks/:id/audio).',
    'api.media.notFound': 'Asset not found'
  }
};
