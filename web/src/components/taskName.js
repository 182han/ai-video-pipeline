// ============================================================
// 任务显示名（2026-11-18，用户反馈：任务名露原始 task_mwiugoxq_z01l）
// ------------------------------------------------------------
// 统一规则（所有面向用户的任务名）：
//   有 prompt → 「prompt 摘要 · 模型 · 时间」
//   无 prompt → 「模型 · 时间」
//   连模型/时间都没有 → 「未命名任务 task_abcd…1234」
// 完整 taskId **只**出现在详情（tasks.drawer.taskId 行）、API 与日志里，不删任何数据；
// 面向用户的次要位置只显示短 ID（task_mwiu…z01l），完整 ID 放在 title tooltip。
// 预算/花费/状态等语义不变，本模块只改展示。
// ============================================================
import { t as tr, fmtDateTime } from '../i18n/index.js';

const SUMMARY_MAX = 26;
const SHORT_HEAD = 9;
const SHORT_TAIL = 4;
const SHORT_MAX = SHORT_HEAD + SHORT_TAIL + 1; // 超过才压缩（task_ 前缀尽量保留）

function cleanText(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
}

/** 短 ID：task_mwiugoxq_z01l → task_mwiu…z01l；短于 14 字符原样返回。 */
export function taskShortId(taskId) {
  const id = cleanText(taskId);
  if (!id) return '';
  if (id.length <= SHORT_MAX) return id;
  return id.slice(0, SHORT_HEAD) + '…' + id.slice(-SHORT_TAIL);
}

/** prompt 摘要：多行压成一行；优先 prompt，再 optimizedPrompt / prompts[] / theme。 */
export function taskPromptSummary(task, maxChars) {
  if (!task || typeof task !== 'object') return '';
  const limit = Number(maxChars) > 0 ? Math.max(4, Math.floor(Number(maxChars))) : SUMMARY_MAX;
  const candidates = [task.prompt, task.optimizedPrompt, task.theme, task.themeLabel];
  if (Array.isArray(task.prompts)) {
    for (const p of task.prompts) candidates.push(typeof p === 'string' ? p : (p && p.text));
  }
  for (const raw of candidates) {
    const text = cleanText(raw);
    if (!text) continue;
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }
  return '';
}

/** 统一显示名：prompt 摘要 + 模型 + 时间；无 prompt 用模型+时间；都没有才用短 ID。 */
export function taskDisplayName(task, opts = {}) {
  const t = task && typeof task === 'object' ? task : {};
  const summary = taskPromptSummary(t, opts.maxChars);
  const model = cleanText(t.model);
  const time = fmtDateTime(t.createdAt || t.updatedAt || t.completedAt || null);
  const hasTime = !!time && time !== '—';
  if (summary) {
    return tr('tasks.displayName', { prompt: summary, model: model || '-', time: hasTime ? time : '-' });
  }
  if (model || hasTime) {
    return tr('tasks.displayNameNoPrompt', { model: model || '-', time: hasTime ? time : '-' });
  }
  return tr('tasks.displayNameUnnamed', { id: taskShortId(t.taskId) || '-' });
}
