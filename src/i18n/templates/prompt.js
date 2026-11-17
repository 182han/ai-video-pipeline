// ==========================================
// i18n 模板 · 提示词优化（P3）
// ------------------------------------------------------------
// 分工（i18n-spec §3.5）：
//   · 中文路径：完全保持现状 —— LLM 用 promptOptimizer.rules（用户可编辑的中文规则），
//     模板路径沿用 DEFAULT_TEMPLATES（其词池本来就是英文视频提示词词汇）。
//   · 英文路径：LLM 用本文件的 EN_RULES（独立英文基底 + Respond in English），
//     模板路径用英文主题标签；**不是**把中文规则逐句机翻。
// ==========================================

'use strict';

// 英文 LLM 系统规则（人工撰写；与中文 DEFAULT_RULES 语义对齐但不逐句翻译）
const EN_RULES = `You are a professional prompt optimizer for AI video generation.
Your job is to expand the user's short description into a high-quality prompt for a text-to-video model.

Rules:
1. Add environment and scene detail (time of day, weather, viewpoint).
2. Add lighting (golden hour, moonlight, volumetric rays, etc.).
3. Add camera movement (slow push-in, orbit, lateral tracking, etc.).
4. Add image quality (4K, cinematic, high detail).
5. Add mood (serene, epic, dreamlike, etc.).
6. Write the final prompt in English, about 60-120 words.
7. Never include people.
8. Output only the optimized prompt — no explanations, no quotes, no markdown.`;

// 内置主题 id → 英文标签（场景卡/创作页的 theme id 与 promptOptimizer 模板 id 一致）
const THEME_LABELS_EN = Object.freeze({
  landscape: 'Natural landscape',
  mountain: 'Mountains and glaciers',
  desert: 'Desert dunes',
  lake: 'Lakes',
  ocean: 'Ocean and coast',
  waterfall: 'Waterfalls',
  aurora: 'Aurora',
  space: 'Space and stars',
  city: 'City nightscape'
});

function themeLabelEn(themeId, fallbackName) {
  const id = String(themeId || '').trim();
  if (THEME_LABELS_EN[id]) return THEME_LABELS_EN[id];
  return fallbackName || id || 'No theme';
}

// 英文 fill system prompt（no theme：只给通用规则；有主题：补结构化词池）
function buildEnglishSystemPrompt(theme, template, structureRefLines) {
  if (!theme || !template) return `${EN_RULES}\n\nRespond in English.`;
  const ref = structureRefLines && structureRefLines.length
    ? `\n\nStructured reference (pick what fits, rewrite freely):\n- ${structureRefLines.join('\n- ')}`
    : '';
  return `${EN_RULES}\n\nCurrent theme: ${themeLabelEn(theme, template.name)}\n`
    + `Reference keywords: ${(template.keywords || []).join(', ')}\n`
    + `Style reference: ${(template.styleEnhancers || []).join(', ')}\n`
    + `Negative prompt: ${template.negative || 'people, text, watermark'}`
    + ref
    + '\n\nRespond in English.';
}

// 英文模板路径的收尾/组织提示（模板词池本身已是英文，无需再翻译）
function templateThemeLabelEn(themeId, fallbackName) {
  return themeLabelEn(themeId, fallbackName);
}

module.exports = {
  EN_RULES,
  THEME_LABELS_EN,
  themeLabelEn,
  templateThemeLabelEn,
  buildEnglishSystemPrompt
};
