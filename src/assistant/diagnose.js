// ==========================================
// 小智 V2 · 失败诊断 + 一键修复建议（Q20=B：给建议，用户点了才执行）
// ------------------------------------------------------------
// 设计约束（设计文档 §2 V2 / §8.3 B2、B3 / 共同契约 §0.2）：
//   · 本模块**只读**：读 task 记录算诊断，不调用流水线、不改任务、不花钱；
//   · 输出固定形状（server / supervisor / verify 共用）：
//       { taskId, status, category, reasons[], summary, failedClips[], suggestions[] }
//   · suggestions 里 executable=true 的才允许执行，且调用方必须再拿 approved:true（L3）；
//   · 不给「自动重跑」：重跑/补跑永远由用户点（Q20=B）。
//
// 分类只依据任务里已记录的事实（error / 片段 qcResult / 模型能力表），不做随机或猜测。
// ==========================================

'use strict';

const { getI2VInfo } = require('../generators/i2vSupport');

const CATEGORY_LABELS = Object.freeze({
  budget: '预算不足',
  key: 'Key/鉴权',
  model: '模型/能力不匹配',
  rate: '限流',
  timeout: '网络/超时',
  qc: '质检未通过',
  media: '媒体处理失败',
  unknown: '未归类失败'
});

function textOf(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function classify(reasonText) {
  const s = reasonText;
  if (/余额不足|预算|INSUFFICIENT_BUDGET|budget|额度/i.test(s)) return 'budget';
  if (/401|403|unauthor|鉴权|api[_\s-]?key|密钥|token|未配置|NO_.*KEY/i.test(s)) return 'key';
  if (/模型|model|不支持|图生视频|i2v|能力/i.test(s)) return 'model';
  if (/429|限流|rate.?limit|too many/i.test(s)) return 'rate';
  if (/timeout|超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|网络|fetch failed|socket/i.test(s)) return 'timeout';
  if (/nsfw|质检|qc|ssim|seam|接缝|黑帧|循环|画质|内容匹配/i.test(s)) return 'qc';
  if (/ffmpeg|拼接|concat|转码|transcode|编码|解码/i.test(s)) return 'media';
  return 'unknown';
}

function failedClipReasons(task) {
  const clips = Array.isArray(task && task.clips) ? task.clips : [];
  const out = [];
  for (const c of clips) {
    if (!c || c.status === 'success') continue;
    const qc = c.qcResult || {};
    const reason = textOf(qc.reason)
      || textOf(qc.error)
      || textOf(c.error)
      || (c.status === 'pending' ? '片段未生成' : `片段状态 ${c.status || '未知'}`);
    out.push({ index: Number.isInteger(c.index) ? c.index : out.length, status: c.status || null, reason });
    if (out.length >= 10) break;
  }
  return out;
}

function suggestion(id, action, label, why, opts = {}) {
  return {
    id,
    action,
    label,
    why,
    executable: opts.executable === true,
    requiresConfirm: opts.requiresConfirm !== false,
    where: opts.where || null
  };
}

/**
 * @param {object} task taskManager 任务对象（可含 clips / error / imageReview / model / resolution）
 * @returns {object} 诊断结果（只读）
 */
function diagnose(task) {
  if (!task || !task.taskId) {
    return {
      ok: false,
      code: 'DIAGNOSE_NO_TASK',
      error: '没有可诊断的任务',
      taskId: null,
      status: null,
      category: 'unknown',
      categoryLabel: CATEGORY_LABELS.unknown,
      reasons: [],
      summary: '没有可诊断的任务。',
      failedClips: [],
      suggestions: []
    };
  }
  const failedClips = failedClipReasons(task);
  const reasons = [];
  if (task.error) reasons.push(textOf(task.error));
  for (const f of failedClips) {
    if (!reasons.includes(f.reason)) reasons.push(f.reason);
  }
  if (task.awaitingImageReview) reasons.push('出图后等待人工审图（未审完不会继续生成视频）');
  if (!reasons.length) reasons.push(`任务状态 ${task.status || '未知'}（未记录失败原因）`);

  const joined = reasons.join('；');
  let category = classify(joined);
  // 模型能力：任务明明要图生视频，却选了不支持 i2v 的模型 → 归到 model（比笼统 error 更有用）
  const hasImageStage = !!(task.imageReview || task.imagePerClip || (task.steps && task.steps.image_generation));
  if (hasImageStage && task.model && !getI2VInfo(task.model)) category = 'model';

  const failed = failedClips.length;
  const suggestions = [];
  if (failed > 0 || ['failed', 'partial'].includes(task.status)) {
    suggestions.push(suggestion(
      'continue',
      'continue',
      failed > 0 ? `补跑 ${failed} 段失败片段（已成功片段复用，不重复生成）` : '重跑这条任务（已成功部分复用）',
      '只重新生成失败部分，费用低于整条重跑',
      { executable: true }
    ));
  }
  if (category === 'model') {
    suggestions.push(suggestion(
      'switch_model',
      'switch_model',
      '换一个支持图生视频的通道（百炼 / 可灵 / Seedance / WhaleTV 中转）',
      '当前模型不在图生视频能力表里，继续跑也会失败',
      { where: '设置 → 视频生成' }
    ));
  }
  if (category === 'key') {
    suggestions.push(suggestion(
      'fix_key',
      'fix_key',
      '到「设置 → 视频生成」补 Key 后重启服务；或先关掉逐段出图走纯文生视频',
      '服务端 Key 只报有/无，Key 值不会显示也不会落盘',
      { where: '设置 → 视频生成' }
    ));
  }
  if (category === 'rate') {
    suggestions.push(suggestion(
      'wait',
      'wait',
      '过几分钟再补跑（限流不是坏数据，已成功片段仍可复用）',
      '限流重试会踩同一窗口',
      { executable: false }
    ));
  }
  if (category === 'budget') {
    suggestions.push(suggestion(
      'topup',
      'topup',
      '先对账/充值预算，再决定是否补跑',
      '余额不足时补跑会被预算闸门拒绝',
      { where: '设置 → 预算' }
    ));
    suggestions.push(suggestion(
      'lower_resolution',
      'lower_resolution',
      '降分辨率（1080p → 720p）降低单段费用',
      '单价按分辨率计，降一档能显著降花费',
      { where: '计划卡 / 设置' }
    ));
  }
  if (task.awaitingImageReview) {
    suggestions.push(suggestion(
      'review_photos',
      'review_photos',
      '先到「库 · 图片」抽看/通过/打回，再点「继续生成」',
      '审图是暂停点，不审不会继续',
      { where: '库 · 图片' }
    ));
  }
  if (!suggestions.length) {
    suggestions.push(suggestion(
      'inspect',
      'inspect',
      '到任务详情看最后失败的步骤，把错误原文贴给小智再决定',
      '没有足够信息时不要盲目重跑（会重复计费）',
      { executable: false }
    ));
  }

  const first = suggestions[0];
  const summary = `任务 ${task.taskId}（${task.status || '未知'}）`
    + (failed ? `有 ${failed} 段没成功` : '未出成片')
    + `：${reasons[0]}。建议：${first.label}。`;

  return {
    ok: true,
    taskId: task.taskId,
    status: task.status || null,
    model: task.model || null,
    resolution: task.resolution || null,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    reasons: reasons.slice(0, 8),
    summary,
    failedClips: failedClips.map((f) => ({ index: f.index, status: f.status, reason: f.reason })),
    suggestions
  };
}

module.exports = { CATEGORY_LABELS, diagnose, classify };
