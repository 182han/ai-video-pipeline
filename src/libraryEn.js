// ============================================================
// 片段库 · 英文提示词 / 英文标题（E10，2026-11-20）
// ------------------------------------------------------------
// 目标：英文界面下 Library 的标题/提示词**不再出现中文**。
// 全部离线完成，不调用任何模型/网络接口（零付费、零延迟）。
//
// 解析顺序（先具体、后兜底）：
//   1) 条目已有 promptEn（入库时算好，或 backfill 脚本写入）
//   2) 场景卡任务：task.sceneCards.used[clipIndex] 找到卡 →
//      用 i18n 模板 composeVideoPromptEn(card) 生成英文提示词
//      （与英文模式生成提示词同一份模板，不是机翻）
//   3) 词表 assets/library/prompts-en.json：先按条目 id，再按规范化后的提示词
//   4) 原提示词本身没有 CJK（历史英文提示词）→ 原样使用
//   5) 仍然没有 → null（前端显示英文占位，**绝不回退中文**）
//
// 为什么不在前端翻译：词表必须可审计、可回归；前端拿不到场景卡数据。
// 为什么不用模型翻译：AGENTS.md §4.9 —— 任何真实计费调用必须先经用户同意。
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

// 场景卡与英文模板：只在能解析到卡时使用，失败一律回退（不影响入库/出图）
const sceneCards = require('./sceneCards');
const { composeVideoPromptEn } = require('./i18n/templates/scene');

const DICT_FILE = path.join(__dirname, '..', 'assets', 'library', 'prompts-en.json');
const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

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
    // 词表缺失/损坏不能拖垮入库：只是英文标题解析不到，前端显示占位
    dictCache = { byId: {}, byPrompt: {} };
  }
  return dictCache;
}

/** 仅供测试/回填脚本：清掉词表缓存（词表改动后重新读） */
function resetDictionary() {
  dictCache = null;
}

function normalize(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

function hasCJK(text) {
  return CJK_RE.test(String(text === undefined || text === null ? '' : text));
}

function safeCard(id) {
  if (!id) return null;
  try {
    return sceneCards.getCardById(id) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 从任务的场景卡生成英文提示词。
 * @param {object} task 任务对象（含 sceneCards）
 * @param {number|null} clipIndex 片段序号（0 起）；成片传 null → 返回场景清单
 */
function scenePromptFromTask(task, clipIndex) {
  const sc = task && task.sceneCards;
  if (!sc || sc.enabled !== true || !Array.isArray(sc.used) || !sc.used.length) return null;

  if (Number.isInteger(clipIndex)) {
    // 该片段被 promptOverrides 改写过 → 画面已不是这张卡描述的内容，不能拿卡的英文顶替。
    // 实测：task_mwnosz8o_uyl4 第 3 段卡是 sc-068（钙华池），override 改成了「冰川湖」。
    const ov = task && task.promptOverrides;
    if (ov && (Array.isArray(ov) ? ov[clipIndex] : ov[String(clipIndex)])) return null;
    const used = sc.used[clipIndex];
    const card = safeCard(used && used.id);
    if (!card) return null;
    try {
      return composeVideoPromptEn(card, {});
    } catch (e) {
      return null;
    }
  }

  // 成片：把用到的场景按英文主角名汇总（“Scenes: a · b · c”）
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

/**
 * 解析一条库条目的英文提示词/标题。
 * @param {object} entry 库条目
 * @param {object|null} task 对应任务（可为 null：条目所属任务已删除）
 * @returns {string|null} 英文文本；null = 无法离线生成（前端显示占位）
 */
function promptEnFor(entry, task) {
  if (!entry || typeof entry !== 'object') return null;

  if (entry.promptEn && !hasCJK(entry.promptEn)) return normalize(entry.promptEn);

  const clipIndex = entry.kind === 'clip' && Number.isInteger(Number(entry.clipIndex))
    ? Number(entry.clipIndex)
    : null;
  const fromScene = scenePromptFromTask(task || null, clipIndex);
  if (fromScene && !hasCJK(fromScene)) return normalize(fromScene);

  const dict = loadDict();
  if (entry.id && dict.byId[entry.id]) {
    const hit = normalize(dict.byId[entry.id]);
    if (hit && !hasCJK(hit)) return hit;
  }
  const key = normalize(entry.prompt || entry.originalPrompt);
  if (key && dict.byPrompt[key]) {
    const hit = normalize(dict.byPrompt[key]);
    if (hit && !hasCJK(hit)) return hit;
  }

  // 历史英文提示词：本身没有中文就直接用
  if (entry.prompt && !hasCJK(entry.prompt)) return normalize(entry.prompt);
  return null;
}

/** 入库时用：片段的英文提示词（场景卡 / 词表 / 英文原文） */
function fromTask(task, clipIndex) {
  const pseudo = {
    id: task && task.taskId && Number.isInteger(clipIndex) ? `${task.taskId}_c${clipIndex + 1}` : null,
    kind: Number.isInteger(clipIndex) ? 'clip' : 'final',
    clipIndex: Number.isInteger(clipIndex) ? clipIndex : null,
    prompt: task && task.prompt,
    originalPrompt: task && task.prompt
  };
  return promptEnFor(pseudo, task);
}

/** 入库时用：成片的英文标题（场景清单 / 词表 / 英文原文） */
function fromFinal(task) {
  return fromTask(task, null);
}

module.exports = {
  promptEnFor,
  fromTask,
  fromFinal,
  scenePromptFromTask,
  hasCJK,
  normalize,
  resetDictionary,
  DICT_FILE
};
