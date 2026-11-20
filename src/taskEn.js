// ============================================================
// 任务 · 英文显示名/提示词（E11，2026-11-20）
// ------------------------------------------------------------
// 目标：英文界面下，库存「历史 / 未完成 / 任务回收站」等处的**任务名**不再出现中文。
// 与 E10（src/libraryEn.js）同一口径：全部离线解析，不调用任何模型/网络接口。
//
// 解析顺序（先具体、后兜底）：
//   1) 任务已有 promptEn（调用方算好 / 未来入库写入）
//   2) 任务 prompt 本身就是英文（无 CJK）
//   3) 场景卡任务：composeVideoPromptEn(card)（与英文生成提示词同一模板）
//      整条任务 → "Scenes: a · b · c"；单段 → 该段的英文视频提示词
//      被 promptOverrides 改写的段不套用原卡（与 libraryEn 同一判定）
//   4) 词表 assets/library/tasks-en.json：先按 taskId，再按规范化后的提示词
//   5) 都没有 → null（前端显示英文占位，**绝不回退中文**）
//
// 为什么不在前端翻译：词表必须可审计、可回归；前端拿不到完整任务/场景卡。
// 为什么不用模型翻译：AGENTS.md §4.9 —— 任何真实计费调用必须先经用户同意。
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const sceneCards = require('./sceneCards');
const { composeVideoPromptEn } = require('./i18n/templates/scene');

const DICT_FILE = path.join(__dirname, '..', 'assets', 'library', 'tasks-en.json');
const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

let dictCache = null;

function loadDict() {
  if (dictCache) return dictCache;
  try {
    const raw = fs.readFileSync(DICT_FILE, 'utf8');
    const j = JSON.parse(raw);
    dictCache = {
      byTaskId: j && typeof j.byTaskId === 'object' && j.byTaskId ? j.byTaskId : {},
      byPrompt: j && typeof j.byPrompt === 'object' && j.byPrompt ? j.byPrompt : {}
    };
  } catch (e) {
    // 词表缺失/损坏不能拖垮接口：只是解析不到英文，前端显示占位
    dictCache = { byTaskId: {}, byPrompt: {} };
  }
  return dictCache;
}

/** 仅供测试/回填脚本：清掉词表缓存 */
function resetDictionary() {
  dictCache = null;
}

function normalize(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

function hasCJK(text) {
  return CJK_RE.test(String(text === undefined || text === null ? '' : text));
}

// 是否像一段正常英文：无 CJK、至少有一个字母、问号占比不过高。
// 目的：历史任务里存在「????????????」这类损坏/占位文本，不能当成英文原文显示。
function looksEnglish(text) {
  const s = normalize(text);
  if (!s || hasCJK(s)) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (!letters) return false;
  const marks = (s.match(/\?/g) || []).length;
  return marks / s.length <= 0.2;
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

/**
 * 从任务的场景卡生成英文提示词。
 * @param {object} task 任务对象（含 sceneCards）
 * @param {number|null} clipIndex 片段序号（0 起）；整条任务传 null → 返回场景清单
 */
function scenePromptFromTask(task, clipIndex) {
  const sc = task && task.sceneCards;
  if (!sc || sc.enabled !== true || !Array.isArray(sc.used) || !sc.used.length) return null;

  if (Number.isInteger(clipIndex)) {
    if (hasOverride(task, clipIndex)) return null;
    const used = sc.used[clipIndex];
    const card = safeCard(used && used.id);
    if (!card) return null;
    try {
      return composeVideoPromptEn(card, {});
    } catch (e) {
      return null;
    }
  }

  const names = [];
  for (const u of sc.used) {
    const card = safeCard(u && u.id);
    if (!card) continue;
    const name = normalize(card.protagonist_en || card.feature_en || card.landform_en || card.biome_en);
    if (name) names.push(name);
  }
  const uniq = [...new Set(names)];
  if (!uniq.length) return null;
  const head = uniq.slice(0, 6).join(' · ');
  return uniq.length > 6 ? `Scenes: ${head} +${uniq.length - 6}` : `Scenes: ${head}`;
}

// 多段任务里已经存在的英文行（历史英文任务 / 混合语言任务）
function englishFromList(list) {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const text = normalize(typeof item === 'string' ? item : (item && (item.text || item.prompt)));
    if (text && looksEnglish(text)) return text;
  }
  return null;
}

// 单段：只用「这一段自己」的英文来源，不能拿整条任务的标题/预设占位（会张冠李戴）。
function clipPromptEn(task, idx) {
  const clip = Array.isArray(task.clips) ? task.clips[idx] : null;
  if (clip) {
    if (clip.promptEn && !hasCJK(clip.promptEn)) return normalize(clip.promptEn);
    if (looksEnglish(clip.prompt)) return normalize(clip.prompt);
  }
  const fromScene = scenePromptFromTask(task, idx);
  if (fromScene && !hasCJK(fromScene)) return normalize(fromScene);
  const list = Array.isArray(task.prompts) ? task.prompts : null;
  if (list && list[idx] && looksEnglish(list[idx])) {
    return normalize(typeof list[idx] === 'string' ? list[idx] : list[idx].text);
  }
  return null;
}

/**
 * 解析一条任务的英文显示提示词/标题。
 * @param {object} task 任务对象
 * @param {number|null} clipIndex 片段序号（0 起）；整条任务传 null
 * @returns {string|null} 英文文本；null = 无法离线生成（前端显示占位）
 */
function promptEnFor(task, clipIndex) {
  if (!task || typeof task !== 'object') return null;
  if (Number.isInteger(clipIndex)) return clipPromptEn(task, clipIndex);

  if (task.promptEn && !hasCJK(task.promptEn)) return normalize(task.promptEn);

  if (looksEnglish(task.prompt)) return normalize(task.prompt);

  const fromScene = scenePromptFromTask(task, null);
  if (fromScene && !hasCJK(fromScene)) return normalize(fromScene);

  // 人工词表优先于「任务内某一段恰好是英文」：整条任务的标题不能拿某一段的英文顶替。
  const dict = loadDict();
  if (task.taskId && dict.byTaskId[task.taskId]) {
    const hit = normalize(dict.byTaskId[task.taskId]);
    if (hit && !hasCJK(hit)) return hit;
  }
  const key = normalize(task.prompt || task.optimizedPrompt);
  if (key && dict.byPrompt[key]) {
    const hit = normalize(dict.byPrompt[key]);
    if (hit && !hasCJK(hit)) return hit;
  }

  const fromList = englishFromList(task.prompts)
    || englishFromList(task.clips)
    || (looksEnglish(task.optimizedPrompt) ? normalize(task.optimizedPrompt) : null);
  if (fromList) return fromList;

  return null;
}

module.exports = {
  promptEnFor,
  scenePromptFromTask,
  hasCJK,
  looksEnglish,
  normalize,
  resetDictionary,
  DICT_FILE
};
