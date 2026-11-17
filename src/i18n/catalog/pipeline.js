// ==========================================
// 后端 catalog · 流水线步骤 / 状态 / 用户可见日志（P2）
// 中文值与 taskManager.PIPELINE_STEPS / pipeline 现有文案逐字一致；
// 只在既有字段旁边加 nameKey / messageKey，不改任何展示文案。
// ==========================================

'use strict';

const STEPS = {
  prompt_optimize: {
    zh: ['提示词优化', '提示词质检'],
    en: ['Prompt optimization', 'Prompt check']
  },
  storyboard: {
    zh: ['分镜头生成', '分镜头质检'],
    en: ['Storyboard generation', 'Storyboard check']
  },
  clip_generation: {
    zh: ['视频片段生成', '片段质检（黑帧/模糊/重复/时长）'],
    en: ['Clip generation', 'Clip check (black frames / blur / duplicates / duration)']
  },
  concatenation: {
    zh: ['视频拼接', '拼接质检'],
    en: ['Concatenation', 'Concatenation check']
  },
  loop_processing: {
    zh: ['无缝循环处理', '循环质检'],
    en: ['Seamless loop', 'Loop check']
  },
  audio_mix: {
    zh: ['配乐混音', '混音校验'],
    en: ['BGM mix', 'Mix check']
  },
  transcoding: {
    zh: ['转码导出', '转码质检'],
    en: ['Transcode & export', 'Transcode check']
  },
  final_qc: {
    zh: ['最终综合质检', '最终质检'],
    en: ['Final QC', 'Final QC']
  }
};

const zh = {};
const en = {};
for (const [key, v] of Object.entries(STEPS)) {
  zh[`pipeline.step.${key}.name`] = v.zh[0];
  zh[`pipeline.step.${key}.qcName`] = v.zh[1];
  en[`pipeline.step.${key}.name`] = v.en[0];
  en[`pipeline.step.${key}.qcName`] = v.en[1];
}

// 任务 currentStep 固定短语（动态拼接的「重新生成片段 N」等不在此列，保持中文原文）
Object.assign(zh, {
  'pipeline.status.concatenating': '视频拼接',
  'pipeline.status.looping': '无缝循环处理',
  'pipeline.status.transcoding': '转码导出',
  'pipeline.status.mixing': '配乐混音',
  'pipeline.status.remixing': '重新配乐中',
  'pipeline.status.bgmPreviewReady': '配乐预览就绪',
  'pipeline.status.bgmFailedKeptMaster': '配乐失败（已保留原成片）',
  'pipeline.status.completed': '已完成',
  'pipeline.status.continuing': '补跑中',
  'pipeline.status.generating': '视频片段生成',
  'pipeline.status.clipsDelivered': '片段包已交付',
  'pipeline.status.paused': '已暂停',
  'pipeline.status.imageReviewTimeout': '审图等待超时',
  'pipeline.status.imageGenAborted': '出图中止',
  'pipeline.log.concatFailed': '拼接失败',
  'pipeline.log.libraryConcatFailed': '片段库拼接失败',
  'pipeline.log.transcodeFailed': '转码失败',
  'pipeline.log.loopFailed': '循环处理失败',
  'pipeline.log.bgmMixFailed': '配乐混音失败',
  'pipeline.log.noClipsToConcat': '没有可拼接的片段',
  'pipeline.log.taskRunning': '任务已经在运行中',
  'pipeline.log.taskNotFound': '任务不存在',
  'pipeline.log.allClipsFailed': '所有片段生成失败（0/{total}）',
  'pipeline.log.noUsableClips': '没有可用的成功片段'
});
Object.assign(en, {
  'pipeline.status.concatenating': 'Concatenating clips',
  'pipeline.status.looping': 'Making the seamless loop',
  'pipeline.status.transcoding': 'Transcoding & exporting',
  'pipeline.status.mixing': 'Mixing BGM',
  'pipeline.status.remixing': 'Re-mixing BGM',
  'pipeline.status.bgmPreviewReady': 'BGM preview ready',
  'pipeline.status.bgmFailedKeptMaster': 'BGM failed (original final video kept)',
  'pipeline.status.completed': 'Completed',
  'pipeline.status.continuing': 'Continuing',
  'pipeline.status.generating': 'Generating clips',
  'pipeline.status.clipsDelivered': 'Clip pack delivered',
  'pipeline.status.paused': 'Paused',
  'pipeline.status.imageReviewTimeout': 'Image review timed out',
  'pipeline.status.imageGenAborted': 'Image generation stopped',
  'pipeline.log.concatFailed': 'Concatenation failed',
  'pipeline.log.libraryConcatFailed': 'Clip-library concatenation failed',
  'pipeline.log.transcodeFailed': 'Transcoding failed',
  'pipeline.log.loopFailed': 'Seamless-loop processing failed',
  'pipeline.log.bgmMixFailed': 'BGM mixing failed',
  'pipeline.log.noClipsToConcat': 'No clips to concatenate',
  'pipeline.log.taskRunning': 'The task is already running',
  'pipeline.log.taskNotFound': 'Task not found',
  'pipeline.log.allClipsFailed': 'All clips failed (0/{total})',
  'pipeline.log.noUsableClips': 'No usable successful clips'
});

module.exports = { zh, en, STEP_KEYS: Object.keys(STEPS) };
