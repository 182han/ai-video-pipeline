// ==========================================
// promptComposer：运行时把「场景卡 + 用户主题」拼成 image / video 提示词（P4）
// ------------------------------------------------------------
// 已定产品决策（docs/交接/2026-11-15-handoff.md §7，不要重新讨论）：
//   · 场景卡 v3.3 是唯一输入；本模块运行时拼提示词，**不写回卡**（卡只读）；
//   · palette_id 用**参数化调色**（adjustChain 的参数对象），不引入 LUT 资源；
//   · 同一张卡 + 同一主题必须得到确定性结果（便于复现/审计）。
//
// 为什么单独成模块：卡内容 → 提示词是一套可单测的纯函数；pipeline/taskManager
// 只负责在正确时机调用。模块不读任务状态、不写任务文件、不调用付费接口。
// ==========================================

'use strict';

const SCENE_PROMPT_VERSION = 'scene-prompt.v1';

// 主题 id → 中文标签（create 页现有主题 id；未知主题原样使用）
const THEME_LABELS = Object.freeze({
  landscape: '自然风景',
  mountain: '高山',
  desert: '荒漠',
  lake: '湖泊',
  ocean: '海洋',
  waterfall: '瀑布',
  aurora: '极光',
  space: '宇宙'
});

// 画面风格（卡里的 style 字段）
const STYLE_LABELS = Object.freeze({
  'cinematic-calm': '电影感平缓调性（低饱和、细腻层次、稳定构图）',
  dramatic: '戏剧化高对比光线（强明暗分层、克制的色彩）'
});

// palette_id → adjustChain 参数（-50..50，adjustChain.normalizeParams 的合法范围）。
// 只描述「整体色彩倾向」，不生成/加载任何 .cube / .lut 文件；真正烘焙由
// transitionMixer 在转场重编码时用 adjustChain 的参数化数学完成。
const PALETTE_ADJUST = Object.freeze({
  'cold-minimal': Object.freeze({
    temperature: -6, contrast: 4, saturation: -4, highlight: -8, shadow: 3, clarity: 3
  }),
  'warm-dense': Object.freeze({
    temperature: 8, contrast: 2, saturation: 6, highlight: -4, shadow: 2
  }),
  'dark-cosmos': Object.freeze({
    temperature: -2, contrast: 8, saturation: 4, brightness: -3, highlight: -6, vignette: 8
  })
});

const MAX_PROMPT_CHARS = 2400;
const MAX_USER_PROMPT_CHARS = 160;

function _clean(v, max = 400) {
  if (v === undefined || v === null) return '';
  let s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function themeLabel(theme) {
  const s = _clean(theme, 80);
  if (!s) return '';
  return THEME_LABELS[s] || s;
}

function styleLabel(style) {
  const s = _clean(style, 80);
  if (!s) return '';
  return STYLE_LABELS[s] || s;
}

function paletteAdjust(paletteId) {
  const key = _clean(paletteId, 80);
  const p = PALETTE_ADJUST[key];
  return p ? { ...p } : null;
}

function listPalettes() {
  return Object.keys(PALETTE_ADJUST);
}

// 去重负向词：卡里 negative / avoid / science.forbidden 有大量重叠。
// 归一化「无人物 / 不含人物」→「人物」：负向提示词里应写要排除的对象，
// 把否定句整句塞进去反而会让模型把「无人物」当成画面元素。
function _negative(card) {
  const raw = [];
  if (card.negative) raw.push(card.negative);
  if (card.avoid) raw.push(card.avoid);
  if (card.science && card.science.forbidden) raw.push(card.science.forbidden);
  const tokens = [];
  const seen = new Set();
  for (const chunk of raw.join(',').split(/[,，、;；。]+/)) {
    let t = chunk.trim();
    if (!t) continue;
    t = t.replace(/^(?:无|没有|不含|禁止出现)\s*/, '');
    if (!t || seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
  }
  return tokens.join(', ');
}

function _sceneCore(card) {
  const protagonist = _clean(card.protagonist, 120);
  const feature = _clean(card.feature, 240);
  if (protagonist && feature && feature !== protagonist && !feature.includes(protagonist)) {
    return `${protagonist}；${feature}`;
  }
  return protagonist || feature;
}

// 卡的 foreground 常写成「前景：暗部剪影」；拼句时去掉重复前缀，避免「前景：前景：…」。
function _foreground(card) {
  return _clean(card.foreground, 120).replace(/^(?:前景|前部)\s*[:：]\s*/, '');
}

function _camera(card) {
  const parts = [
    _clean(card.shot, 40),
    _clean(card.cameraAngle, 60),
    _clean(card.lens, 30) ? `${_clean(card.lens, 30)}镜头` : '',
    _clean(card.motion, 40) ? `运动：${_clean(card.motion, 40)}` : ''
  ].filter(Boolean);
  return parts.join('，');
}

function _lightWeather(card) {
  const parts = [];
  if (_clean(card.light)) parts.push(`光线：${_clean(card.light, 60)}`);
  if (_clean(card.light_azimuth)) parts.push(`光位：${_clean(card.light_azimuth, 60)}`);
  if (_clean(card.weather)) parts.push(`天气：${_clean(card.weather, 60)}`);
  if (_clean(card.season)) parts.push(`季节：${_clean(card.season, 30)}`);
  return parts.join('；');
}

function _colorStyle(card) {
  const parts = [];
  if (_clean(card.palette)) parts.push(`色彩：${_clean(card.palette, 80)}`);
  const style = styleLabel(card.style);
  if (style) parts.push(`影调：${style}`);
  return parts.join('；');
}

function _lead(card, ctx) {
  const theme = themeLabel(ctx.theme);
  const userPrompt = _clean(ctx.userPrompt, MAX_USER_PROMPT_CHARS);
  const parts = [];
  if (theme) parts.push(`主题：${theme}`);
  // 用户原句提供氛围方向，但不覆盖卡里的场景内容（卡是唯一场景输入）。
  if (userPrompt && userPrompt !== theme) parts.push(`氛围：${userPrompt}`);
  return parts.length ? parts.join('｜') + '。' : '';
}

function _clamp(text) {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return text.slice(0, MAX_PROMPT_CHARS);
}

function _assertCard(card) {
  if (!card || typeof card !== 'object') throw new Error('promptComposer 需要场景卡对象');
  if (!card.id || !card.scene_key) throw new Error('场景卡缺少 id / scene_key，无法拼提示词');
  if (!_sceneCore(card)) throw new Error(`场景卡 ${card.id} 缺少 protagonist/feature，无法拼提示词`);
}

// 视频提示词：卡 + 主题/氛围；语义顺序与 fengguang 的「主体→运镜→光影→色调→收尾」一致。
function composeVideoPrompt(card, ctx = {}) {
  _assertCard(card);
  const sentences = [];
  const lead = _lead(card, ctx);
  if (lead) sentences.push(lead);
  sentences.push(`画面主体：${_sceneCore(card)}。`);
  const fg = _foreground(card);
  if (fg) sentences.push(`前景：${fg}。`);
  const cam = _camera(card);
  if (cam) sentences.push(`镜头：${cam}。`);
  const lw = _lightWeather(card);
  if (lw) sentences.push(`${lw}。`);
  const cs = _colorStyle(card);
  if (cs) sentences.push(`${cs}。`);
  if (_clean(card.highlight_control)) sentences.push(`${_clean(card.highlight_control, 200)}。`);
  if (card.science && _clean(card.science.scale)) {
    sentences.push(`科学约束：${_clean(card.science.scale, 120)}。`);
  }
  if (_clean(card.end_lock)) sentences.push(`结尾：${_clean(card.end_lock, 120)}。`);
  return _clamp(sentences.join(''));
}

// 图片提示词（首帧/静帧）：不含运动描述，补安全区与横屏要求。
function composeImagePrompt(card, ctx = {}) {
  _assertCard(card);
  const sentences = ['单帧静态画面，16:9 横屏。'];
  const lead = _lead(card, ctx);
  if (lead) sentences.push(lead);
  sentences.push(`主体：${_sceneCore(card)}。`);
  const fg = _foreground(card);
  if (fg) sentences.push(`前景：${fg}。`);
  const cam = [_clean(card.shot, 40), _clean(card.cameraAngle, 60), _clean(card.lens, 30) ? `${_clean(card.lens, 30)}镜头` : '']
    .filter(Boolean).join('，');
  if (cam) sentences.push(`构图：${cam}。`);
  const lw = _lightWeather(card);
  if (lw) sentences.push(`${lw}。`);
  const cs = _colorStyle(card);
  if (cs) sentences.push(`${cs}。`);
  if (_clean(card.highlight_control)) sentences.push(`${_clean(card.highlight_control, 200)}。`);
  const safe = Number.isFinite(Number(card.safeAreaPct)) ? Number(card.safeAreaPct) : 5;
  sentences.push(`安全区：四周留 ${safe}% 安全边距；无人物、无文字、无水印。`);
  return _clamp(sentences.join(''));
}

// 一次产出 clip 需要的全部字段。调用方只负责写回 clip（不修改 card）。
function composeClipPatch(card, ctx = {}) {
  _assertCard(card);
  const videoPrompt = composeVideoPrompt(card, ctx);
  const imagePrompt = composeImagePrompt(card, ctx);
  const negativePrompt = _negative(card);
  return {
    prompt: videoPrompt,
    imagePrompt,
    negativePrompt,
    promptSource: 'scene-card',
    promptComposerVersion: SCENE_PROMPT_VERSION,
    sceneKey: card.scene_key,
    sceneCardId: card.id,
    sceneCardRole: card.role,
    // 只存复现/审计需要的最小字段，避免任务 JSON 膨胀（完整卡仍从卡库按 id 读）
    sceneCard: {
      id: card.id,
      scene_key: card.scene_key,
      chapter: Number.isInteger(card.chapter) ? card.chapter : null,
      sequence: Number.isInteger(card.sequence) ? card.sequence : null,
      role: card.role,
      palette_id: card.palette_id || null,
      shot: card.shot || null,
      motion: card.motion || null,
      durationSec: Number.isFinite(Number(card.durationSec)) ? Number(card.durationSec) : 10
    },
    // 参数化调色（null = 未知 palette_id，不臆造参数）
    adjust: paletteAdjust(card.palette_id)
  };
}

function compose(card, ctx = {}) {
  const patch = composeClipPatch(card, ctx);
  return {
    cardId: patch.sceneCardId,
    sceneKey: patch.sceneKey,
    role: patch.sceneCardRole,
    paletteId: patch.sceneCard.palette_id,
    videoPrompt: patch.prompt,
    imagePrompt: patch.imagePrompt,
    negativePrompt: patch.negativePrompt,
    adjust: patch.adjust,
    composerVersion: SCENE_PROMPT_VERSION
  };
}

module.exports = {
  SCENE_PROMPT_VERSION,
  MAX_PROMPT_CHARS,
  THEME_LABELS,
  STYLE_LABELS,
  PALETTE_ADJUST,
  themeLabel,
  styleLabel,
  paletteAdjust,
  listPalettes,
  composeVideoPrompt,
  composeImagePrompt,
  composeClipPatch,
  compose
};
