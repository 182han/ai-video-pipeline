// ==========================================
// 质检结论版本判定 —— 「这条结论到底能不能信」
// ==========================================
// 背景：2026-10-18 之前 qualityChecker 有两处缺陷（skipped 当 passed / Math.random 假质检），
//       那之前落库的所有质检结论都是从没真正执行过的「伪造 pass」。
//       用户决定不重跑历史任务，改用版本号区分，本文件是唯一的判定入口。
//
//   qcVersion >= 2  → 可信（真实执行过检测）
//   qcVersion 为 null / 未定义 / < 2 → 历史未验证，绝不能当作真实通过
//
// 为什么单独一个文件：判定逻辑散落在 postgres.js / sqlite.js / jsonfile.js / API 层，
// 迟早会有人漏改一处，造成「某条路径把历史结论当通过」。
// 放到这里，三处驱动和 API 共用同一份规则。
// ==========================================

// 与 qualityChecker.js 的 QC_VERSION 保持一致（那边是权威来源，这里读它）
let QC_VERSION = 2;
try {
  const qc = require('../qualityChecker');
  if (Number.isInteger(qc.QC_VERSION)) QC_VERSION = qc.QC_VERSION;
} catch (e) {
  // qualityChecker 加载失败不影响存储层可用，回退到 2
}

// 历史分界：任何 >= 该值的结论都可信
const TRUSTED_FROM = 2;

/**
 * 把任意来源的 qcVersion 规整成整数或 null。
 * 数据库 BIGINT 在 pg 里可能回来是字符串，JSON 里可能是 "1"，都要能吃下。
 * 非法值（NaN / 非数字 / 负数）一律当作「未知」→ null，走「历史未验证」分支。
 */
function normalize(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** 从一条质检结论里取出 qcVersion（没有就是 null） */
function qcVersionOf(qc) {
  if (!qc || typeof qc !== 'object') return null;
  const own = normalize(qc.qcVersion !== undefined ? qc.qcVersion : qc.qc_version);
  if (own !== null) return own;
  // 结论里没写版本，但外层给了（例如任务行上的 qc_version 列）——交给调用方判断更好，
  // 这里不猜，直接返回 null，由 isTrustedQC 的第二个参数补齐。
  return null;
}

/**
 * 这条质检结论是否可被当作「真实通过/真实失败」采信。
 * @param {object|number|string|null} qc  质检结论对象，或直接给 qcVersion 数值
 * @param {number|string|null} fallbackVersion 结论对象里没有版本时，用外层的版本（如任务行）
 */
function isTrustedQC(qc, fallbackVersion) {
  let v = null;
  if (qc !== null && typeof qc === 'object') {
    v = qcVersionOf(qc);
  } else {
    v = normalize(qc);
  }
  if (v === null) v = normalize(fallbackVersion);
  return v !== null && v >= TRUSTED_FROM;
}

/**
 * 给一条质检结论补上「可信度」标注，供 API / UI 直接展示。
 * 不改变原有 passed 字段（避免破坏既有调用方），只新增字段。
 *
 * @returns {object|null} 原对象 + { qcVersion, qcTrusted, qcLabel }
 *   qcLabel: 'verified' = 可信；'legacy_unverified' = 历史未验证
 */
function annotateQC(qc, fallbackVersion) {
  if (!qc || typeof qc !== 'object') return qc;
  const version = qcVersionOf(qc) !== null ? qcVersionOf(qc) : normalize(fallbackVersion);
  const trusted = isTrustedQC(qc, fallbackVersion);
  return {
    ...qc,
    qcVersion: version,
    qcTrusted: trusted,
    qcLabel: trusted ? 'verified' : 'legacy_unverified'
  };
}

/**
 * 给整个任务对象补标注（就地返回新对象，不改入参）。
 * 会同时标注：
 *   - task.finalQC
 *   - task.clips[i].qcResult
 *   - task.steps[k].qcDetails（步骤里存的质检详情）
 */
function annotateTask(task) {
  if (!task || typeof task !== 'object') return task;

  let taskVersion = normalize(task.qcVersion !== undefined ? task.qcVersion : task.qc_version);
  let versionSource = taskVersion !== null ? 'task' : null;

  // 任务行没有版本时，回退到 finalQC 自己的版本。
  //
  // 现实数据里「任务级 qc_version」经常是空的：驱动建表时把版本写在 finalQC /
  // qcResult 内部，任务行并没有独立列（JSON 驱动的历史任务更是如此）。
  // 不回退的话，所有【终检真实执行过】的任务都会被标成 legacy_unverified —— 这是误报，
  // 会让前端的「历史未验证」角标失去意义（什么都标）。
  //
  // 用 finalQC 的版本代表任务级可信度是粗粒度的近似：它说明「终检这条结论可信」，
  // 不保证每条片段质检都可信。因此额外给出 qcVersionSource，调用方需要更细粒度时，
  // 应自行看 clips[i].qcResult.qcLabel。
  if (taskVersion === null) {
    const finalVersion = qcVersionOf(task.finalQC);
    if (finalVersion !== null) {
      taskVersion = finalVersion;
      versionSource = 'finalQC';
    }
  }

  const out = {
    ...task,
    qcVersion: taskVersion,
    qcTrusted: taskVersion !== null && taskVersion >= TRUSTED_FROM,
    qcVersionSource: versionSource
  };

  if (out.finalQC) {
    out.finalQC = annotateQC(out.finalQC, taskVersion);
  }

  if (Array.isArray(out.clips)) {
    out.clips = out.clips.map(c => {
      if (!c || typeof c !== 'object' || !c.qcResult) return c;
      return { ...c, qcResult: annotateQC(c.qcResult, taskVersion) };
    });
  }

  return out;
}

module.exports = {
  QC_VERSION,
  TRUSTED_FROM,
  normalize,
  qcVersionOf,
  isTrustedQC,
  annotateQC,
  annotateTask
};
