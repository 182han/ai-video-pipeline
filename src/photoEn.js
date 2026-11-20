// ============================================================
// 图片库 · 英文提示词（E11，2026-11-20）
// ------------------------------------------------------------
// 目标：英文界面下，图片库卡片/详情不再显示中文版提示词。
// 与 E10/E11（libraryEn / taskEn）同一口径：全部离线解析，不调用模型/网络。
//
// 解析顺序：
//   1) 条目已有 promptEn
//   2) 去掉「【调色前】/【调色后】」前缀后本身是英文 → 原样
//   3) 场景卡：由任务 sceneCards.used[entry.index] 用 composeImagePromptEn(card)
//      （与英文模式出图提示词同一模板；用户覆盖过该段的条目不走卡）
//   4) 词表 assets/library/photos-en.json：byId（含去掉 _original/_vN 的基 id）→ byPrompt
//   5) 都没有 → null（前端显示英文占位，**绝不回退中文**）
//
// 只解决「显示」；用户在图片库编辑的 imagePrompt/videoPrompt 仍是原始数据，不在这里改。
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const sceneCards = require('./sceneCards');
const { composeImagePromptEn } = require('./i18n/templates/scene');

const DICT_FILE = path.join(__dirname, '..', 'assets', 'library', 'photos-en.json');
const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const LABEL_PREFIX_RE = /^\s*【(?:调色前|调色后)】\s*/;

let dictCache = null;

function loadDict() {
  if (dictCache) return dictCache;
  try {
    const raw = fs.readFileSync(DICT_FILE, 'utf8');
    const j = JSON.parse(raw);
    dictCache = {
      byId: j && typeof j.byId === 'object' && j.byId ? j.byId : {},
      byPrompt: j && typeof j.byPrompt === 'object' && j.byPrompt ? j.byPrompt : {}
    };
  } catch (e) {
    dictCache = { byId: {}, byPrompt: {} };
  }
  return dictCache;
}

function resetDictionary() {
  dictCache = null;
}

function normalize(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

function hasCJK(text) {
  return CJK_RE.test(String(text === undefined || text === null ? '' : text));
}

// 与 taskEn 同一判定：无 CJK、至少一个字母、问号占比不过高（排除「????」占位文本）。
function looksEnglish(text) {
  const s = normalize(text);
  if (!s || hasCJK(s)) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (!letters) return false;
  const marks = (s.match(/\?/g) || []).length;
  return marks / s.length <= 0.2;
}

function stripLabelPrefix(text) {
  return normalize(String(text || '').replace(LABEL_PREFIX_RE, ''));
}

function baseId(id) {
  return String(id || '').replace(/_original$/, '').replace(/_v\d+$/, '');
}

function safeCard(id) {
  if (!id) return null;
  try {
    return sceneCards.getCardById(id) || null;
  } catch (e) {
    return null;
  }
}

function hasOverride(task, clipIndex) {
  const ov = task && task.promptOverrides;
  if (!ov) return false;
  return !!(Array.isArray(ov) ? ov[clipIndex] : ov[String(clipIndex)]);
}

function scenePromptFromTask(task, clipIndex) {
  const sc = task && task.sceneCards;
  if (!sc || sc.enabled !== true || !Array.isArray(sc.used) || !sc.used.length) return null;
  if (!Number.isInteger(clipIndex)) return null;
  if (hasOverride(task, clipIndex)) return null;
  const used = sc.used[clipIndex];
  const card = safeCard(used && used.id);
  if (!card) return null;
  try {
    return composeImagePromptEn(card, {});
  } catch (e) {
    return null;
  }
}

/**
 * 解析一条图片条目的英文提示词。
 * @param {object} entry 图片库条目
 * @param {object|null} task 对应任务（可为 null：任务记录已删/历史图）
 * @returns {string|null} 英文文本；null = 无法离线生成（前端显示占位）
 */
function promptEnFor(entry, task) {
  if (!entry || typeof entry !== 'object') return null;

  if (entry.promptEn && !hasCJK(entry.promptEn)) return normalize(entry.promptEn);

  const source = stripLabelPrefix(entry.imagePrompt || entry.prompt || entry.generationPrompt);
  if (looksEnglish(source)) return source;

  const idx = Number.isInteger(Number(entry.index)) ? Number(entry.index) : null;
  const fromScene = scenePromptFromTask(task || null, idx);
  if (fromScene && !hasCJK(fromScene)) return normalize(fromScene);

  const dict = loadDict();
  const ids = [entry.id, baseId(entry.id)].filter(Boolean);
  for (const id of ids) {
    if (dict.byId[id]) {
      const hit = normalize(dict.byId[id]);
      if (hit && !hasCJK(hit)) return hit;
    }
  }
  for (const key of [source, normalize(entry.imagePrompt || entry.prompt || ''), normalize(entry.generationPrompt)]) {
    if (key && dict.byPrompt[key]) {
      const hit = normalize(dict.byPrompt[key]);
      if (hit && !hasCJK(hit)) return hit;
    }
  }

  return null;
}

module.exports = {
  promptEnFor,
  scenePromptFromTask,
  hasCJK,
  looksEnglish,
  normalize,
  stripLabelPrefix,
  resetDictionary,
  DICT_FILE
};
