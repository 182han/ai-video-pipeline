// ==========================================
// i18n 模板 · 场景卡 → 提示词（P3，英文）
// ------------------------------------------------------------
// 设计边界（必须如实告知）：
//   · 本文件只负责**英文句式/标签/收尾**，独立撰写，不是把中文模板逐句机翻；
//   · 场景卡里的画面内容字段（protagonist/feature/light/...）属于「内容数据」，按 i18n-spec §6.4
//     不做机器翻译；如果卡里提供 *_en 字段（未来英文卡库），优先使用；
//   · 中文路径完全不经过本文件（promptComposer 中文分支一字未改）。
// ==========================================

'use strict';

const MAX_PROMPT_CHARS = 2400;

const THEME_EN = Object.freeze({
  landscape: 'natural landscape',
  mountain: 'mountains',
  desert: 'desert',
  lake: 'lake',
  ocean: 'ocean',
  waterfall: 'waterfall',
  aurora: 'aurora',
  space: 'space and stars'
});

const STYLE_EN = Object.freeze({
  'cinematic-calm': 'cinematic calm tone (low saturation, fine tonal layers, stable composition)',
  dramatic: 'dramatic high-contrast lighting (strong light/shadow separation, restrained color)'
});

function clean(v, max = 400) {
  if (v === undefined || v === null) return '';
  let s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

// 优先英文内容字段（未来英文卡库），否则回退卡内原值（内容不机翻）
function pickField(card, key) {
  return clean(card && (card[`${key}_en`] || card[key]), 400);
}

function themeEn(theme) {
  const s = clean(theme, 80);
  if (!s) return '';
  return THEME_EN[s] || s;
}

function styleEn(style) {
  const s = clean(style, 80);
  if (!s) return '';
  return STYLE_EN[s] || s;
}

function sceneCoreEn(card) {
  const protagonist = pickField(card, 'protagonist');
  const feature = pickField(card, 'feature');
  if (protagonist && feature && feature !== protagonist && !feature.includes(protagonist)) {
    return `${protagonist}; ${feature}`;
  }
  return protagonist || feature;
}

function foregroundEn(card) {
  return pickField(card, 'foreground').replace(/^(?:foreground|fg)\s*[:：]\s*/i, '');
}

function cameraEn(card) {
  const parts = [
    pickField(card, 'shot'),
    pickField(card, 'cameraAngle'),
    pickField(card, 'lens'),
    pickField(card, 'motion') ? `motion: ${pickField(card, 'motion')}` : ''
  ].filter(Boolean);
  return parts.join(', ');
}

function lightWeatherEn(card) {
  const parts = [];
  if (pickField(card, 'light')) parts.push(`light: ${pickField(card, 'light')}`);
  if (pickField(card, 'light_azimuth')) parts.push(`light direction: ${pickField(card, 'light_azimuth')}`);
  if (pickField(card, 'weather')) parts.push(`weather: ${pickField(card, 'weather')}`);
  if (pickField(card, 'season')) parts.push(`season: ${pickField(card, 'season')}`);
  return parts.join('; ');
}

function colorStyleEn(card) {
  const parts = [];
  if (pickField(card, 'palette')) parts.push(`palette: ${pickField(card, 'palette')}`);
  const style = styleEn(card && card.style);
  if (style) parts.push(`look: ${style}`);
  return parts.join('; ');
}

function leadEn(card, ctx) {
  const theme = themeEn(ctx.theme);
  const userPrompt = clean(ctx.userPrompt, 160);
  const parts = [];
  if (theme) parts.push(`Theme: ${theme}`);
  if (userPrompt && userPrompt !== theme) parts.push(`Mood: ${userPrompt}`);
  return parts.length ? parts.join(' | ') + '. ' : '';
}

function clamp(text) {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return text.slice(0, MAX_PROMPT_CHARS);
}

function negativeEn(card) {
  // 卡里的负向词是内容数据；保留原词，仅归一空白/分隔符（不做机翻）
  const raw = [];
  if (card && card.negative) raw.push(card.negative);
  if (card && card.avoid) raw.push(card.avoid);
  const tokens = [];
  const seen = new Set();
  for (const chunk of raw.join(',').split(/[,，、;；。]+/)) {
    const t = chunk.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
  }
  return tokens.join(', ');
}

function composeVideoPromptEn(card, ctx = {}) {
  const sentences = [];
  const lead = leadEn(card, ctx);
  if (lead) sentences.push(lead);
  const core = sceneCoreEn(card);
  if (core) sentences.push(`Subject: ${core}. `);
  const fg = foregroundEn(card);
  if (fg) sentences.push(`Foreground: ${fg}. `);
  const cam = cameraEn(card);
  if (cam) sentences.push(`Camera: ${cam}. `);
  const lw = lightWeatherEn(card);
  if (lw) sentences.push(`${lw}. `);
  const cs = colorStyleEn(card);
  if (cs) sentences.push(`${cs}. `);
  if (pickField(card, 'highlight_control')) sentences.push(`${pickField(card, 'highlight_control')}. `);
  const endLock = pickField(card, 'end_lock');
  if (endLock) sentences.push(`Ending: ${endLock}. `);
  return clamp(sentences.join(''));
}

function composeImagePromptEn(card, ctx = {}) {
  const sentences = ['Single still frame, 16:9 landscape. '];
  const lead = leadEn(card, ctx);
  if (lead) sentences.push(lead);
  const core = sceneCoreEn(card);
  if (core) sentences.push(`Subject: ${core}. `);
  const fg = foregroundEn(card);
  if (fg) sentences.push(`Foreground: ${fg}. `);
  const cam = [pickField(card, 'shot'), pickField(card, 'cameraAngle'), pickField(card, 'lens')]
    .filter(Boolean).join(', ');
  if (cam) sentences.push(`Composition: ${cam}. `);
  const lw = lightWeatherEn(card);
  if (lw) sentences.push(`${lw}. `);
  const cs = colorStyleEn(card);
  if (cs) sentences.push(`${cs}. `);
  if (pickField(card, 'highlight_control')) sentences.push(`${pickField(card, 'highlight_control')}. `);
  const safe = Number.isFinite(Number(card && card.safeAreaPct)) ? Number(card.safeAreaPct) : 5;
  sentences.push(`Safe area: keep a ${safe}% margin on all sides; no people, no text, no watermark.`);
  return clamp(sentences.join(''));
}

module.exports = {
  MAX_PROMPT_CHARS,
  themeEn,
  styleEn,
  negativeEn,
  composeVideoPromptEn,
  composeImagePromptEn
};
