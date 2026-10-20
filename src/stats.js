// ==========================================
// 生产指标统计：端到端成功率 / 一次质检通过率
// ==========================================
//
// 依据《后续目标》第 8 条：
//   端到端成功率 不低于 90%
//   一次质检通过率 不低于 85%
//
// 这两个数字此前没有任何地方能算出来——只有单条任务的 passRate（片段质检通过率），
// 无法回答「整体达标了吗」。
//
// ===== 口径定义（必须明确，否则数字不可比）=====
//
// 端到端成功率（任务层面）
//   strict  = completed / 已结束任务
//   lenient = (completed + partial) / 已结束任务     partial = 出了片但有片段失败
//   两者都给，因为"部分成功算不算成功"取决于产品口径；默认用 strict 判达标。
//
// 一次质检通过率（片段层面）
//   = 首次生成即质检通过的片段数 / 全部片段数
//   「首次」= attempts === 1 且最终 success；attempts > 1 的即使成功也说明第一次没过。
//
// ===== 可信度处理（关键）=====
// 2026-10-18 之前入库的质检结论是伪造 pass（skipped 当 passed / Math.random）。
// 把它们算进通过率，得到的数字必然虚高。因此：
//   - 默认只统计「质检可信」的任务（qcVersion >= 2）
//   - 不可信任务单独计数并在 warnings 里说明被排除多少
//   - 调用方可用 includeUntrusted: true 强制全量，但结果会带 untrustedIncluded 标记
//
// 另：failed 任务里往往一个片段都没成功，会显著拉低通过率；
// 因此同时给出「仅在成功出片的任务内」的通过率，供不同视角参考。

const { normalize, TRUSTED_FROM } = require('./storage/qcVersion');

const TARGET = Object.freeze({
  endToEnd: 0.90,
  clipFirstPass: 0.85
});

// 已结束的任务状态（进行中的不算，否则成功率会被拉低且随时变化）
const FINISHED = ['completed', 'partial', 'failed'];

function isTrustedTask(task) {
  // 任务级版本优先，其次回退 finalQC 的版本（与 storage/qcVersion.annotateTask 一致）
  let v = normalize(task && (task.qcVersion !== undefined ? task.qcVersion : task.qc_version));
  if (v === null && task && task.finalQC && typeof task.finalQC === 'object') {
    v = normalize(task.finalQC.qcVersion !== undefined ? task.finalQC.qcVersion : task.finalQC.qc_version);
  }
  return v !== null && v >= TRUSTED_FROM;
}

function pct(n, d) {
  if (!d) return null;
  return Math.round((n / d) * 10000) / 10000; // 保留 4 位小数，展示时再乘 100
}

function rate(n, d) {
  const p = pct(n, d);
  return { numerator: n, denominator: d, rate: p, percent: p === null ? null : Math.round(p * 1000) / 10 };
}

/**
 * @param {object[]} tasks  任务数组（taskManager.getAllTasks() 或 storage.getAllTasks()）
 * @param {object} options
 *   includeUntrusted  boolean  是否把质检不可信的任务也算进来（默认 false）
 *   model             string   只看某个模型
 * @returns {object} 统计结果
 */
function computeStats(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks.filter(t => t && t.taskId) : [];
  const includeUntrusted = options.includeUntrusted === true;

  const warnings = [];
  const scope = {
    total: list.length,
    finished: 0,
    inProgress: 0,
    untrustedExcluded: 0,
    untrustedIncluded: 0,
    byStatus: {}
  };

  const considered = [];
  for (const t of list) {
    if (options.model && t.model !== options.model) continue;
    if (!FINISHED.includes(t.status)) { scope.inProgress++; continue; }
    scope.finished++;
    scope.byStatus[t.status] = (scope.byStatus[t.status] || 0) + 1;
    const trusted = isTrustedTask(t);
    if (!trusted) {
      if (includeUntrusted) { scope.untrustedIncluded++; considered.push(t); }
      else { scope.untrustedExcluded++; }
    } else {
      considered.push(t);
    }
  }

  if (scope.untrustedExcluded > 0) {
    warnings.push(
      `已排除 ${scope.untrustedExcluded} 条质检不可信的历史任务（qcVersion < ${TRUSTED_FROM}）：`
      + '这些任务的质检结论产生于修复之前，纳入统计会让通过率虚高'
    );
  }
  if (scope.untrustedIncluded > 0) {
    warnings.push(`已按要求纳入 ${scope.untrustedIncluded} 条质检不可信任务，结果仅供参考`);
  }
  if (scope.finished === 0) {
    warnings.push('没有已结束的任务，无法统计');
  }

  // ---------- 端到端成功率 ----------
  const nCompleted = considered.filter(t => t.status === 'completed').length;
  const nPartial = considered.filter(t => t.status === 'partial').length;
  const nFailed = considered.filter(t => t.status === 'failed').length;
  const finishedConsidered = considered.length;

  const endToEndStrict = rate(nCompleted, finishedConsidered);
  const endToEndLenient = rate(nCompleted + nPartial, finishedConsidered);

  // ---------- 片段层面 ----------
  let clipsTotal = 0;
  let clipsSuccess = 0;
  let clipsFirstPass = 0;
  let clipsRetried = 0;
  // 只在「出了片」的任务里看通过率（排除整体失败的任务，避免被 0 拉平）
  let clipsTotalInDelivered = 0;
  let clipsFirstPassInDelivered = 0;

  for (const t of considered) {
    const clips = Array.isArray(t.clips) ? t.clips : [];
    const delivered = t.status === 'completed' || t.status === 'partial';
    for (const c of clips) {
      if (!c) continue;
      clipsTotal++;
      const ok = c.status === 'success';
      const attempts = Number(c.attempts);
      const firstTry = Number.isFinite(attempts) ? attempts === 1 : false;
      if (ok) {
        clipsSuccess++;
        if (firstTry) clipsFirstPass++;
        else if (Number.isFinite(attempts) && attempts > 1) clipsRetried++;
      }
      if (delivered) {
        clipsTotalInDelivered++;
        if (ok && firstTry) clipsFirstPassInDelivered++;
      }
    }
  }

  const clipFirstPass = rate(clipsFirstPass, clipsTotal);
  const clipFirstPassDelivered = rate(clipsFirstPassInDelivered, clipsTotalInDelivered);
  const clipSuccessRate = rate(clipsSuccess, clipsTotal);

  // ---------- 耗时 ----------
  //
  // 注意：历史任务的 startedAt / completedAt 可能「跨阶段不一致」——
  // 任务被重新处理（补跑、改配乐、修 bug 后重跑）时 completedAt 会被刷新，
  // 但 startedAt 保留最初的值，算出 13 天这种荒谬时长。
  // 实测：task_mv4v7qp2_m8r0 startedAt=10-12、completedAt=10-19，时长 589044s。
  // 因此设上限 MAX_DURATION_SEC，超出的视为数据异常并排除，同时在 warnings 说明。
  const MAX_DURATION_SEC = 24 * 3600; // 单条任务的合理上限：一天
  const durations = [];
  let durationOutliers = 0;
  for (const t of considered) {
    if (!t.startedAt || !t.completedAt) continue;
    const ms = new Date(t.completedAt) - new Date(t.startedAt);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const sec = ms / 1000;
    if (sec > MAX_DURATION_SEC) { durationOutliers++; continue; }
    durations.push(sec);
  }
  if (durationOutliers > 0) {
    warnings.push(
      `耗时统计排除了 ${durationOutliers} 条异常记录（时长 > 24h）：`
      + '这些任务的 completedAt 被后续重跑刷新、而 startedAt 仍是旧值，算出的时长无意义'
    );
  }
  let avgDurationSec = null;
  let medianDurationSec = null;
  if (durations.length) {
    avgDurationSec = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    const sorted = durations.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianDurationSec = Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  }

  // ---------- 达标判断 ----------
  const target = {
    endToEnd: TARGET.endToEnd,
    clipFirstPass: TARGET.clipFirstPass,
    endToEndMet: endToEndStrict.rate !== null ? endToEndStrict.rate >= TARGET.endToEnd : null,
    clipFirstPassMet: clipFirstPass.rate !== null ? clipFirstPass.rate >= TARGET.clipFirstPass : null,
    // 样本量提示：少于 10 条已结束任务时，比例没有统计意义
    sampleSufficient: finishedConsidered >= 10
  };
  if (finishedConsidered > 0 && finishedConsidered < 10) {
    warnings.push(`样本量偏小（已结束任务 ${finishedConsidered} 条），比例仅供参考，不构成达标结论`);
  }

  return {
    generatedAt: new Date().toISOString(),
    scope,
    endToEnd: {
      strict: endToEndStrict,
      lenient: endToEndLenient,
      completed: nCompleted,
      partial: nPartial,
      failed: nFailed
    },
    clips: {
      total: clipsTotal,
      success: clipsSuccess,
      firstPass: clipsFirstPass,
      retried: clipsRetried,
      successRate: clipSuccessRate,
      firstPassRate: clipFirstPass,
      firstPassRateInDelivered: clipFirstPassDelivered
    },
    duration: {
      avgSec: avgDurationSec,
      medianSec: medianDurationSec,
      samples: durations.length,
      outliersExcluded: durationOutliers,
      maxAllowedSec: MAX_DURATION_SEC
    },
    target,
    warnings
  };
}

module.exports = { computeStats, TARGET, isTrustedTask, FINISHED };
