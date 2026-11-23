// ==========================================
// 出图自动调色开关（A 方案，2026-11-23）
// ------------------------------------------------------------
// 只有两态：
//   off  = 不跑 autoGrade，只存模型原图（默认）
//   calm = 跑现有 autoGrade（目标饱和度 0.32、只降不升、压高光），算法本身不改
//
// 默认值**只**来自服务端 .env（IMAGE_GEN_AUTO_GRADE_DEFAULT），不读 localStorage；
// 每次出图可在界面临时改；创建任务后写进 task.imageGrade 并沿用（补跑/重生成不覆盖）。
//
// server / taskManager / supervisor / processors 共用这里的校验与默认值，
// 避免每个入口各写一套，出现「服务端拒绝、调度器又默默放行」这类不一致。
// ==========================================

'use strict';

const OPTIONS = ['off', 'calm'];
const DEFAULT = 'off';

/**
 * 严格归一化：只接受 'off' / 'calm'（大小写与首尾空白容错）。
 * 其它任何值（undefined / null / '' / 拼写错误 / 数字）都返回 null。
 * 调用方自行决定 null 是「用默认」还是「400 拒绝」——刻意不在这里猜。
 * @param {*} value
 * @returns {'off'|'calm'|null}
 */
function normalize(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return OPTIONS.includes(v) ? v : null;
}

/**
 * 归一化并提供兜底默认：非法/缺省 → DEFAULT。
 * 只用于「没有 HTTP 校验层、允许安全回退」的内部调用（如直接调 createTask 的脚本）。
 * HTTP 入口应当用 normalize() 判 null 后返回 400，不得用本函数吞掉非法值。
 * @param {*} value
 * @returns {'off'|'calm'}
 */
function resolve(value) {
  return normalize(value) || DEFAULT;
}

module.exports = { OPTIONS, DEFAULT, normalize, resolve };
