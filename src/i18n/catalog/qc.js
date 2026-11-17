// ==========================================
// 后端 catalog · 质检项（P2）
// 只加 labelKey / labelZh / labelEn / descKey 等加法字段；
// 既有 passed/skipped 语义与中文 reason 文案一律不动（AGENTS §4.1）。
// ==========================================

'use strict';

const ITEMS = {
  prompt: {
    zh: ['提示词质检', '检查提示词完整性、安全性、关键词覆盖'],
    en: ['Prompt check', 'Checks prompt completeness, safety, and keyword coverage']
  },
  storyboard: {
    zh: ['分镜头质检', '检查分镜头连贯性、场景过渡合理性'],
    en: ['Storyboard check', 'Checks shot continuity and scene-transition plausibility']
  },
  blackFrame: {
    zh: ['黑帧检测', '检测视频中是否存在黑帧或黑屏'],
    en: ['Black-frame check', 'Detects black frames or blank screens in the clip']
  },
  blur: {
    zh: ['模糊检测', '检测画面清晰度是否达标'],
    en: ['Blur check', 'Checks whether the image is sharp enough']
  },
  duplicate: {
    zh: ['重复帧检测', '检测是否存在大量重复帧（卡顿）'],
    en: ['Duplicate-frame check', 'Detects long runs of repeated frames (stutter)']
  },
  duration: {
    zh: ['时长校验', '校验视频时长是否符合要求'],
    en: ['Duration check', 'Verifies the video duration against the expected length']
  },
  nsfw: {
    zh: ['NSFW合规检测', '多模态模型按每分钟 1 帧抽检，置信度达阈值即判不合规'],
    en: ['NSFW check', 'Multimodal model samples one frame per minute; any score at or above the threshold fails']
  },
  concat: {
    zh: ['拼接质检', '检查片段拼接是否流畅无跳帧'],
    en: ['Concatenation check', 'Checks that clips join smoothly without dropped frames']
  },
  seam: {
    zh: ['接缝质量检测', '逐缝测结构相似度/色差/亮度差/像素级变化，判硬切或淡化是否自然'],
    en: ['Seam quality check', 'Measures SSIM, color difference, luminance difference, and pixel change at each seam']
  },
  colorContinuity: {
    zh: ['镜头色彩连续性', '测相邻镜头整体色调差（缝前/缝后各抽一帧算 ΔE76），三档：通过/提示/失败'],
    en: ['Shot color continuity', 'Measures overall color difference between adjacent shots (ΔE76 from one frame each side of the seam)']
  },
  loop: {
    zh: ['循环质检', '检查首尾循环过渡是否自然'],
    en: ['Loop check', 'Checks that the head-to-tail loop transition looks natural']
  },
  transcode: {
    zh: ['转码质检', '校验转码后分辨率、帧率、码率'],
    en: ['Transcode check', 'Verifies resolution, frame rate, and bitrate after transcoding']
  },
  final: {
    zh: ['最终综合质检', '文件完整性 + 整体质量综合评估'],
    en: ['Final QC', 'Combines file-integrity and overall-quality checks']
  }
};

const zh = {};
const en = {};
for (const [key, v] of Object.entries(ITEMS)) {
  zh[`qc.item.${key}.label`] = v.zh[0];
  zh[`qc.item.${key}.desc`] = v.zh[1];
  en[`qc.item.${key}.label`] = v.en[0];
  en[`qc.item.${key}.desc`] = v.en[1];
}

// 质检结论的固定短语（动态明细仍保留中文，不在此翻译）
Object.assign(zh, {
  'qc.result.clipPass': '片段质检通过',
  'qc.result.clipPassSkipped': '片段质检通过（{count} 项按设计跳过）',
  'qc.result.finalPass': '最终质检通过',
  'qc.result.finalPassSkipped': '最终质检通过（{count} 项按设计跳过）',
  'qc.result.finalFail': '最终质检未通过',
  'qc.label.verified': '可信',
  'qc.label.legacyUnverified': '历史未验证'
});
Object.assign(en, {
  'qc.result.clipPass': 'Clip QC passed',
  'qc.result.clipPassSkipped': 'Clip QC passed ({count} items skipped by design)',
  'qc.result.finalPass': 'Final QC passed',
  'qc.result.finalPassSkipped': 'Final QC passed ({count} items skipped by design)',
  'qc.result.finalFail': 'Final QC failed',
  'qc.label.verified': 'Verified',
  'qc.label.legacyUnverified': 'Legacy, unverified'
});

module.exports = { zh, en, ITEM_KEYS: Object.keys(ITEMS) };
