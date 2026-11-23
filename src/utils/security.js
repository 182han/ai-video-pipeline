// ==========================================
// 部署加固用的纯函数（无依赖、可单测）
// ==========================================
//
// 为什么单独抽出来：这些判断要能被 verify 脚本直接 require 测试，
// 不能只写在 server.js 的闭包里（那样只能靠起服务打接口验证）。
//
// 背景（2026-11-12 外发部署前加固）：
//   1. /output、/clips、/bgm 三个媒体目录原先不跟随登录墙 —— 知道 URL 就能下载成片。
//   2. /api/bgm/mix 用 `videoPath.startsWith('output')` 做「防穿越」，但
//      `output/../../server.js` 同样满足该判断，属于可绕过的弱校验。
//   3. 渲染 ffmpeg 命令用的是字符串拼接 + 双引号包裹。Windows cmd.exe 里 `\"`
//      并不是合法转义，所以文件名里一旦出现 `"` 或 `%`，就可能跳出引号或触发变量展开。
//      因此策略改为「拒绝危险字符」而不是「尝试转义」。

const path = require('path');

// Windows 文件名非法字符 + 控制字符。这些出现在路径里一律视为攻击输入。
const UNSAFE_PATH_CHARS = /[<>"|?*\x00-\x1f]/;

// cmd.exe 里会被解释的字符（引号、变量展开、管道、重定向、转义）。
// 本项目所有真实产物路径都是 `task_xxx_clip_1_v2.mp4` 这类，正常不会命中。
const UNSAFE_SHELL_CHARS = /["%&|<>^\r\n]/;

/**
 * 把用户给的相对路径解析到 rootDir 内部；越界、含危险字符、空值都返回 null。
 * 注意：必须是「解析后判断」，不能用字符串 startsWith 判断（`a/../b` 会骗过前者）。
 */
function resolveInside(rootDir, userPath) {
  if (typeof userPath !== 'string') return null;
  const raw = userPath.trim();
  if (!raw) return null;
  if (UNSAFE_PATH_CHARS.test(raw)) return null;

  const root = path.resolve(rootDir);
  const abs = path.resolve(root, raw);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(withSep)) return null;
  if (!isSafeShellPath(abs)) return null;
  return abs;
}

/**
 * 专用于「媒体产物」的解析：只允许落在 <baseDir>/output 里。
 * 同时接受 `output/xxx.mp4` 与 `xxx.mp4` 两种写法（老调用方两种都出现过）。
 */
function resolveUnderOutput(baseDir, userPath) {
  if (typeof userPath !== 'string' || !userPath.trim()) return null;
  const root = path.resolve(baseDir, 'output');
  const abs = path.resolve(baseDir, userPath.trim());
  const withSep = root + path.sep;
  if (!abs.startsWith(withSep)) return null;
  if (!isSafeShellPath(abs)) return null;
  return abs;
}

/** 路径能否安全拼进 cmd.exe 命令行（拒绝引号/百分号/管道等解释字符）。 */
function isSafeShellPath(p) {
  if (typeof p !== 'string' || !p) return false;
  return !UNSAFE_SHELL_CHARS.test(p);
}

// 存储 id（任务 / 回收站条目）只允许字母、数字、下划线、横线，禁止点与路径分隔符。
// 2026-11-23 审计：/api/trash/:id 曾直接 path.join('data/trash', id + '.json')，
// 传 `../../data/users` 会解析到 data/users.json（任意 JSON 读取）。
const SAFE_STORAGE_ID = /^[A-Za-z0-9_-]{1,120}$/;
function isSafeStorageId(id) {
  return typeof id === 'string' && SAFE_STORAGE_ID.test(id);
}

/** 是否是三个媒体静态目录下的请求（用于跟随登录墙）。 */
const MEDIA_PREFIXES = ['/output', '/clips', '/bgm'];
function isMediaRequestPath(p) {
  if (typeof p !== 'string') return false;
  for (const prefix of MEDIA_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/')) return true;
  }
  return false;
}

// ==========================================
// 任务数值字段校验（2026-11-23 审计新增）
// ==========================================
//
// 事故：POST /api/tasks 的 clipDuration 只做 `duration < 1 || duration > 60`。
// JS 里 `"10\" & echo X" < 1` 和 `> 60` 都是 false（NaN 比较），于是**原始字符串**
// 通过校验 → 存进 task.clipDuration → MockGenerator 拼进 execSync 命令串，
// 在 Windows cmd.exe 下可跳出引号执行任意命令（已用「截获最终命令串」复现）。
//
// 因此：所有进入任务、后续可能被拼进命令/路径的数值字段，必须在入口转成
// **有限数字**并做范围校验；校验失败返回 null，由调用方返回 400，绝不静默放行。
const TASK_COUNT_MIN = 1;
const TASK_COUNT_MAX = 200;
const TASK_CLIP_DURATION_MIN = 1;
const TASK_CLIP_DURATION_MAX = 60;

function toFiniteNumber(value) {
  // 只接受 number / 非空 string；对象、数组、布尔都可能被 Number() 意外转成数字。
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** 片段数：必须是 1–200 的整数；缺省返回 10。非法返回 null。 */
function normalizeTaskCount(value, fallback = 10) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = toFiniteNumber(value);
  if (n === null || !Number.isInteger(n)) return null;
  if (n < TASK_COUNT_MIN || n > TASK_COUNT_MAX) return null;
  return n;
}

/** 单段时长：必须是 1–60 的有限数字；缺省返回 fallback。非法返回 null。 */
function normalizeClipDuration(value, fallback = 15) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = toFiniteNumber(value);
  if (n === null) return null;
  if (n < TASK_CLIP_DURATION_MIN || n > TASK_CLIP_DURATION_MAX) return null;
  return n;
}

module.exports = {
  UNSAFE_PATH_CHARS,
  UNSAFE_SHELL_CHARS,
  resolveInside,
  resolveUnderOutput,
  isSafeShellPath,
  isSafeStorageId,
  isMediaRequestPath,
  MEDIA_PREFIXES,
  TASK_COUNT_MIN,
  TASK_COUNT_MAX,
  TASK_CLIP_DURATION_MIN,
  TASK_CLIP_DURATION_MAX,
  toFiniteNumber,
  normalizeTaskCount,
  normalizeClipDuration
};
