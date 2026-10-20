// ==========================================
// fengguang skill 规则层
// 功能：把「摄影级自然风光提示词」skill 蒸馏成可注入 AI 优化的规则段
// 数据：data/skill-fengguang.rules.md（可编辑，改完无需重启逻辑，下次调用自动读到）
// 开关：环境变量 SKILL_PROMPT_ENABLED=false 可整体关闭（默认开启）
// 作用域：只对风光类主题追加；city（城市夜景）与无主题不追加
// ==========================================

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', 'data', 'skill-fengguang.rules.md');

// 风光类主题：这些主题才叠加摄影级规则
const LANDSCAPE_THEMES = new Set([
  'landscape', 'mountain', 'desert', 'lake',
  'ocean', 'waterfall', 'aurora', 'space',
]);

// 文件缓存（按 mtime 失效），避免每次生成都读盘
let cache = { text: '', mtime: 0 };

function isEnabled() {
  const v = process.env.SKILL_PROMPT_ENABLED;
  if (v === undefined || v === null || String(v).trim() === '') return true;
  return String(v).trim().toLowerCase() !== 'false';
}

function getSkillRules() {
  try {
    const st = fs.statSync(RULES_FILE);
    if (st.mtimeMs === cache.mtime && cache.text) return cache.text;
    const text = fs.readFileSync(RULES_FILE, 'utf-8').trim();
    cache = { text, mtime: st.mtimeMs };
    return text;
  } catch (e) {
    // 文件缺失或不可读：静默降级为不叠加，不影响原有优化流程
    return '';
  }
}

function appliesTo(theme) {
  return Boolean(theme) && LANDSCAPE_THEMES.has(theme);
}

// 把 skill 规则追加到 system prompt 末尾；不适用时原样返回
function appendTo(systemPrompt, theme) {
  if (!isEnabled()) return systemPrompt;
  if (!appliesTo(theme)) return systemPrompt;
  const rules = getSkillRules();
  if (!rules) return systemPrompt;
  return `${systemPrompt}\n\n${rules}\n`;
}

module.exports = {
  RULES_FILE,
  LANDSCAPE_THEMES,
  isEnabled,
  appliesTo,
  getSkillRules,
  appendTo,
};
