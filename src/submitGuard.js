// ==========================================
// 提交去重（防重复计费）
// ==========================================
// 背景（2026-11-14 账单复盘）：2026-11-09 21:51 在 4 秒内创建了 4 个
// wan3.0-video 任务（1×720P + 3×1080P，同一提示词/参数），全部真实计费。
// 用户要求「坚决不重试」，但账单证明真正的漏洞是「点一次、落多个任务」。
//
// 做法：对「模型 + 分辨率 + 单段时长 + 段数 + 提示词 + 关键参数」做指纹，
// 在窗口期内（默认 5 分钟）拒绝完全相同的新任务，除非显式 force=true。
// 只拦真实计费模型（mock 免费，不拦）；进程内 Map，重启即清空——够用，
// 因为重复提交发生在秒级；跨重启的重复由前端二次确认兜底。

const crypto = require('crypto');

const WINDOW_MS = (() => {
  const n = parseInt(process.env.DUP_WINDOW_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();

const seen = new Map(); // fingerprint -> { taskId, at, model, clips }

function prune(now = Date.now()) {
  for (const [k, v] of seen) {
    if (!v || now - v.at > WINDOW_MS) seen.delete(k);
  }
}

// 只取会影响计费/内容的字段；顺序固定，保证同一输入得到同一指纹
function build(input = {}) {
  const prompts = Array.isArray(input.prompts)
    ? input.prompts.map(p => (typeof p === 'string' ? p : (p && p.text) || ''))
    : [String(input.prompt || '')];
  return {
    model: String(input.model || ''),
    resolution: String(input.resolution || '').toLowerCase(),
    clipDuration: Number(input.clipDuration) || 0,
    clips: Number(input.clips) || 0,
    prompts: prompts.map(s => String(s).replace(/\s+/g, ' ').trim()),
    preset: String(input.preset || ''),
    sourcePhotoId: input.sourcePhotoId ? String(input.sourcePhotoId) : '',
    photoIds: Array.isArray(input.photoIds) ? input.photoIds.map(String) : [],
    transition: input.transition === undefined ? null : input.transition,
    colorMatch: input.colorMatch === undefined ? null : input.colorMatch,
    // 出图自动调色（A 方案）：同提示词但调色选择不同 → 产物不同，不算重复提交。
    // 归一化大小写/空白，避免 'CALM' 与 'calm' 被当成两次不同任务。
    imageGrade: String(input.imageGrade || '').trim().toLowerCase()
  };
}

function fingerprint(input) {
  const canonical = input && typeof input === 'object' && 'prompts' in input ? input : build(input);
  return crypto.createHash('sha1').update(JSON.stringify(canonical)).digest('hex');
}

function check(fp, now = Date.now()) {
  prune(now);
  const hit = seen.get(fp);
  if (!hit) return null;
  return {
    taskId: hit.taskId,
    model: hit.model,
    clips: hit.clips,
    at: hit.at,
    retryAfterSec: Math.max(1, Math.ceil((hit.at + WINDOW_MS - now) / 1000))
  };
}

function remember(fp, info = {}) {
  seen.set(fp, {
    taskId: info.taskId || null,
    model: info.model || '',
    clips: info.clips || 0,
    at: Date.now()
  });
  prune();
}

function reset() {
  seen.clear();
}

function size() {
  return seen.size;
}

module.exports = {
  WINDOW_MS,
  build,
  fingerprint,
  check,
  remember,
  reset,
  size
};
