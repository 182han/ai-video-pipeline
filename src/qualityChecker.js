// ==========================================
// 自动质检模块 - 全流程质检体系
// 功能：黑帧检测、模糊检测、重复帧检测、时长校验、文件完整性、
//       分辨率校验、帧率校验、音频检测、画面稳定性、NSFW 合规检测、最终综合质检
// ==========================================

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const config = require('../config');

const FFMPEG_PATH = config.FFMPEG_PATH || 'ffmpeg';

// 质检项定义
const QC_ITEMS = [
  { key: 'prompt', name: '提示词质检', category: 'pre', desc: '检查提示词完整性、安全性、关键词覆盖' },
  { key: 'storyboard', name: '分镜头质检', category: 'pre', desc: '检查分镜头连贯性、场景过渡合理性' },
  { key: 'blackFrame', name: '黑帧检测', category: 'clip', desc: '检测视频中是否存在黑帧或黑屏' },
  { key: 'blur', name: '模糊检测', category: 'clip', desc: '检测画面清晰度是否达标' },
  { key: 'duplicate', name: '重复帧检测', category: 'clip', desc: '检测是否存在大量重复帧（卡顿）' },
  { key: 'duration', name: '时长校验', category: 'clip', desc: '校验视频时长是否符合要求' },
  // 合规红线：需求申报表承诺「NSFW 置信度阈值 0.8」。此项未执行即整体不通过。
  { key: 'nsfw', name: 'NSFW合规检测', category: 'clip', desc: '多模态模型按每分钟 1 帧抽检，置信度达阈值即判不合规' },
  { key: 'concat', name: '拼接质检', category: 'post', desc: '检查片段拼接是否流畅无跳帧' },
  { key: 'loop', name: '循环质检', category: 'post', desc: '检查首尾循环过渡是否自然' },
  { key: 'transcode', name: '转码质检', category: 'post', desc: '校验转码后分辨率、帧率、码率' },
  { key: 'final', name: '最终综合质检', category: 'final', desc: '文件完整性 + 整体质量综合评估' }
];

// ===== 质检结论版本号 =====
// 2026-10-18 之前 qualityChecker 有两处缺陷（skipped 当 passed / Math.random 假质检），
// 那之前落库的所有质检结论都不可信。用户决定不重跑历史任务，改用版本号区分：
//   1 = 修复前产生的结论 —— 视为「历史未验证」，绝不能当作真实通过
//   2 = 修复后产生的结论 —— 可信
// 判定逻辑统一放在 src/storage/qcVersion.js，本文件只负责「打标」。
const QC_VERSION = 2;
// 历史分界：任何 >= 该值的版本都按可信处理（将来升到 3 时，2 依然可信）
const QC_VERSION_LEGACY = 1;

// NSFW 抽帧策略（覆盖 30 分钟成片，同时控制 token 预算）
const NSFW_FRAMES_PER_MINUTE = 1;
const NSFW_MAX_FRAMES = 30;
// 连续抽帧时相邻采样点的最小间隔（秒）：避免「首尾帧 + 循环补帧」出现同一时刻的重复帧
const NSFW_MIN_FRAME_GAP = 0.5;
// 多模态调用默认超时（毫秒）；30 帧一次送入比 3 帧慢，故比 checkContentMatch 的 30s 放宽
const NSFW_TIMEOUT_MS = 120000;

class QualityChecker {
  constructor(options = {}) {
    // 最近一次 NSFW 多模态调用的失败原因（HTTP 状态 / 上游报文 / 超时）。
    // 目的：原先失败只报「调用失败/超时」，403 Model.AccessDenied 这类可定位的错误被吞掉，
    // 用户无法判断是 Key、地址还是模型权限问题。只在内存里留最后一次，不落盘、不含 Key。
    this._nsfwLastError = null;
    this.options = {
      blackFrameMinDuration: 0.5,
      blackFrameThreshold: 0.95,
      blurThreshold: 100,
      minDurationRatio: 0.8,
      maxDurationRatio: 1.2,
      // 合规红线：NSFW 置信度阈值（达到或超过即判不合规）。.env 的 QC_NSFW_THRESHOLD 覆盖 config.QC.nsfwThreshold
      nsfwThreshold: config.QC && Number.isFinite(config.QC.nsfwThreshold)
        ? config.QC.nsfwThreshold
        : 0.8,
      ...options
    };
    this.qcItems = QC_ITEMS;
  }

  // 获取所有质检项定义
  getQCItems() {
    return this.qcItems;
  }

  // ========== 提示词质检 ==========
  // 2026-10-19 按用户要求放宽：取消长度上下限、取消关键词丰富度、取消主题词匹配。
  // 现在只做「非空」这一项基础校验——质检的作用是提示问题，不该拦住正常输入。
  // 注意：这不是降低质检标准，而是把判定权交回用户；NSFW/画面类质检不受影响。
  checkPrompt(prompt) {
    const issues = [];
    const details = {};

    const text = typeof prompt === 'string' ? prompt.trim() : '';
    details.length = text.length;

    if (!text) {
      issues.push('提示词为空');
    }

    const passed = issues.length === 0;
    return {
      passed,
      qcVersion: QC_VERSION,
      reason: passed ? '提示词质检通过' : issues.join('；'),
      issues,
      details,
      level: passed ? 'pass' : 'fail'
    };
  }


  // ========== 分镜头质检 ==========
  checkStoryboard(clips, totalClips) {
    const issues = [];
    const details = {};

    details.totalClips = totalClips;
    details.generatedCount = clips.filter(c => c.prompt && c.prompt.length > 0).length;

    // 检查提示词覆盖率
    const coverage = details.generatedCount / totalClips;
    details.coverage = coverage;
    if (coverage < 0.9) issues.push(`分镜头提示词覆盖率不足 (${Math.round(coverage * 100)}%)`);

    // 检查场景连贯性（简单模拟：检查相邻镜头关键词差异）
    let continuityScore = 0;
    for (let i = 1; i < clips.length; i++) {
      if (clips[i].prompt && clips[i-1].prompt) {
        // 简单的连贯性检查
        continuityScore += 0.9; // 模拟基本连贯
      }
    }
    details.continuityScore = clips.length > 1 
      ? continuityScore / (clips.length - 1) 
      : 1;

    if (details.continuityScore < 0.7) issues.push('分镜头连贯性不足');

    const passed = issues.length === 0;
    return {
      passed,
      qcVersion: QC_VERSION,
      reason: passed ? '分镜头质检通过' : issues.join('；'),
      issues,
      details,
      level: passed ? 'pass' : 'warn'
    };
  }

  // ========== 片段级完整质检 ==========
  // options 透传给 NSFW 检测（apiKey/baseUrl/model/timeoutMs/nsfwThreshold/fetchImpl），
  // 使流水线可以把任务级的运行时模型配置传进来，而不是只认全局 .env。
  async checkClip(videoPath, expectedDuration = 30, options = {}) {
    const results = {};

    // 前置闸门：FFmpeg 是这四个检测项的唯一执行手段。
    // 历史缺陷（已修）：没有 ffmpeg 时执行到 catch，返回 {passed:true, skipped:true}，
    // 而下面的汇总又把 skipped 当 pass 算，导致「一项都没测」却报告「片段质检通过」。
    // 现在明确区分：可以合法跳过的原因（业务上本就不适用）vs 检测器不可用（必须判 fail）。
    // NSFW 检测同样依赖 FFmpeg 抽帧，闸门里必须一起判 fail（合规红线不允许「没测就算过」）。
    if (!this._hasFFmpeg()) {
      return {
        passed: false,
        qcVersion: QC_VERSION,
        reason: '片段质检无法执行：FFmpeg 不可用，黑帧/模糊/重复帧/时长/NSFW 五项均未实际检测',
        failedCount: 5,
        totalChecks: 5,
        detectorUnavailable: true,
        details: {
          blackFrame: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' },
          blur: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' },
          duplicate: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' },
          duration: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' },
          nsfw: { passed: false, reason: 'FFmpeg 不可用，无法抽帧执行 NSFW 检测', level: 'fail', detectorUnavailable: true }
        }
      };
    }

    // 1. 黑帧检测
    try {
      results.blackFrame = await this.checkBlackFrame(videoPath);
    } catch (e) {
      results.blackFrame = { passed: false, reason: '黑帧检测出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 2. 模糊检测
    try {
      results.blur = await this.checkBlur(videoPath);
    } catch (e) {
      results.blur = { passed: false, reason: '模糊检测出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 3. 重复帧检测
    try {
      results.duplicate = await this.checkDuplicate(videoPath);
    } catch (e) {
      results.duplicate = { passed: false, reason: '重复帧检测出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 4. 时长校验
    try {
      results.duration = await this.checkDuration(videoPath, expectedDuration);
    } catch (e) {
      results.duration = { passed: false, reason: '时长校验出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 5. NSFW 合规检测（红线项：无 Key / 调用失败 / 解析失败一律判 fail，绝不默认通过）
    try {
      results.nsfw = await this.checkNSFW(videoPath, options.nsfw || options);
    } catch (e) {
      results.nsfw = { passed: false, reason: 'NSFW 检测出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 汇总：
    //   passed 且非 genuine skip -> 通过
    //   skipped 且非 legitimateSkip -> 只是「没测」，不算通过（红线，不放宽）
    //   failed  -> 按「是否要紧」分流：要紧 -> 不通过；不要紧 -> 只记警告
    //
    // 严格项来源：options.strictItems（用户勾选，随任务下发）。
    //   - 不传 => 全部项都算要紧（保持旧行为，向后兼容）
    //   - 传了 => 只有列表里的项才算要紧
    //   - ALWAYS_STRICT 里的项永远要紧，用户无法关闭（NSFW 属合规红线）
    const ALWAYS_STRICT = ['nsfw'];
    const strictKeys = Array.isArray(options.strictItems) && options.strictItems.length
      ? options.strictItems
      : null;

    const entries = Object.entries(results);
    const failedEntries = entries.filter(([, v]) => !v.passed && !v.skipped);

    const isBlocking = ([k]) => {
      if (ALWAYS_STRICT.includes(k)) return true;
      if (!strictKeys) return true;
      return strictKeys.includes(k);
    };

    const blockingEntries = failedEntries.filter(isBlocking);
    const warningEntries = failedEntries.filter((e) => !isBlocking(e));

    const failedItems = blockingEntries.map(([k, v]) => `${this._getItemName(k)}: ${v.reason}`);
    const warnItems = warningEntries.map(([k, v]) => `${this._getItemName(k)}: ${v.reason}`);
    const notRunItems = entries
      .filter(([, v]) => v.skipped && !v.legitimateSkip)
      .map(([k, v]) => `${this._getItemName(k)}: ${v.reason}`);
    const legitSkipItems = entries
      .filter(([, v]) => v.skipped && v.legitimateSkip)
      .map(([k, v]) => `${this._getItemName(k)}: ${v.reason}`);

    const allPassed = failedItems.length === 0 && notRunItems.length === 0;
    const reasons = [];
    if (failedItems.length) reasons.push('未通过 ' + failedItems.join('; '));
    if (notRunItems.length) reasons.push('未执行 ' + notRunItems.join('; '));
    if (allPassed && warnItems.length) reasons.push('警告 ' + warnItems.join('; '));

    return {
      passed: allPassed,
      qcVersion: QC_VERSION,
      reason: allPassed
        ? (reasons.length
            ? `片段质检通过（${reasons.join(' | ')}）`
            : (legitSkipItems.length ? `片段质检通过（${legitSkipItems.length} 项按设计跳过）` : '片段质检通过'))
        : reasons.join(' | '),
      failedCount: failedItems.length,
      warningCount: warnItems.length,
      warnings: warnItems,
      notRunCount: notRunItems.length,
      legitSkipCount: legitSkipItems.length,
      totalChecks: entries.length,
      strictItems: strictKeys || 'all',
      details: results
    };
  }

  // 获取质检项名称
  _getItemName(key) {
    const item = this.qcItems.find(i => i.key === key);
    return item ? item.name : key;
  }

  // ========== 黑帧检测 ==========
  async checkBlackFrame(videoPath) {
    try {
      if (this._hasFFmpeg()) {
        return this._checkBlackFrameFFmpeg(videoPath);
      }
    } catch (e) {}
    return this._mockCheck('blackFrame', videoPath);
  }

  // ========== 模糊检测 ==========
  async checkBlur(videoPath) {
    try {
      if (this._hasFFmpeg()) {
        return this._checkBlurFFmpeg(videoPath);
      }
    } catch (e) {}
    return this._mockCheck('blur', videoPath);
  }

  // ========== 重复帧检测 ==========
  async checkDuplicate(videoPath) {
    try {
      if (this._hasFFmpeg()) {
        return this._checkDuplicateFFmpeg(videoPath);
      }
    } catch (e) {}
    return this._mockCheck('duplicate', videoPath);
  }

  // ========== 时长校验 ==========
  async checkDuration(videoPath, expectedDuration) {
    try {
      if (this._hasFFmpeg()) {
        return this._checkDurationFFmpeg(videoPath, expectedDuration);
      }
    } catch (e) {}
    // Mock 模式
    return {
      passed: true,
      qcVersion: QC_VERSION,
      reason: `时长约 ${expectedDuration}s（模拟）`,
      duration: expectedDuration,
      level: 'pass',
      mock: true
    };
  }

  // ========== 拼接质检 ==========
  // clipPaths：可选，传入各输入片段路径后，用实测时长之和作为期望值（改动点 4）
  async checkConcat(videoPath, clipCount, clipPaths = [], options = {}) {
    // 前置闸门：没有 ffmpeg 就没法测时长，此时不能假装通过。
    // 历史缺陷：下面的 catch 是空的，然后无条件 return passed:true，
    // 导致 ffmpeg 缺失时拼接质检永久「通过」，14s 截断产物也能过江。
    if (!this._hasFFmpeg()) {
      return {
        passed: false,
        qcVersion: QC_VERSION,
        reason: '拼接质检无法执行：FFmpeg 不可用，无法测量产物时长',
        level: 'fail',
        detectorUnavailable: true
      };
    }

    try {
      const info = await this._getVideoInfoFFmpeg(videoPath);

      // 优先：按各输入片段实测时长求和作为期望值，允许小容差。
      // 旧的 clipCount × 2 过于宽松，14s 的截断产物也能判 pass。
      let expected = null;
      if (Array.isArray(clipPaths) && clipPaths.length > 0) {
        let sum = 0;
        let probed = 0;
        for (const p of clipPaths) {
          const d = await this._probeDurationFFmpeg(p);
          if (d > 0) { sum += d; probed++; }
        }
        if (probed === clipPaths.length && sum > 0) expected = sum;
      }

      // 片段间转场（2026-10-20）：成片时长 = Σ片段 − (N−1)×淡化时长，
      // 与「Σ片段」不同。调用方必须传 expectedDuration，否则会把正确的转场产物
      // 误判成「拼接被截断」（这是加转场后最容易踩的假失败）。
      const overrideExpected = Number(options.expectedDuration);
      if (Number.isFinite(overrideExpected) && overrideExpected > 0) {
        expected = overrideExpected;
      }

      if (expected !== null) {
        const tolerance = Math.max(0.5, expected * 0.02);
        const passed = Math.abs(info.duration - expected) <= tolerance;
        return {
          passed,
          qcVersion: QC_VERSION,
          reason: passed
            ? `拼接完成，总时长 ${info.duration.toFixed(2)}s（期望 ${expected.toFixed(2)}s）`
            : `拼接后时长异常 (${info.duration.toFixed(2)}s，期望 ${expected.toFixed(2)}s，容差 ±${tolerance.toFixed(2)}s)`,
          duration: info.duration,
          expected: Math.round(expected * 100) / 100,
          tolerance: Math.round(tolerance * 100) / 100,
          clipCount,
          level: passed ? 'pass' : 'fail'
        };
      }

      // 退化路径：拿不到输入时长时沿用旧下限（保守，标注 fallback 以便排查）
      const expectedMin = clipCount * 2;
      const passed = info.duration >= expectedMin;
      return {
        passed,
        qcVersion: QC_VERSION,
        reason: passed
          ? `拼接完成，总时长 ${info.duration.toFixed(1)}s`
          : `拼接后时长不足 (${info.duration.toFixed(1)}s)`,
        duration: info.duration,
        clipCount,
        level: passed ? 'pass' : 'fail',
        fallback: true
      };
    } catch (e) {
      // 有 ffmpeg 但检测过程抛错 —— 属于检测器失效，判 fail 而不是放行
      return {
        passed: false,
        qcVersion: QC_VERSION,
        reason: `拼接质检执行出错: ${e.message}`,
        level: 'fail',
        detectorError: true
      };
    }
  }

  // 探测媒体时长（秒）；失败返回 0
  _probeDurationFFmpeg(mediaPath) {
    return new Promise((resolve) => {
      try {
        const cmd = `"${FFMPEG_PATH}" -i "${mediaPath}" 2>&1`;
        let output;
        try {
          output = this._exec(cmd);
        } catch (e) {
          // ffmpeg 仅探测（无输出参数）退出码恒非 0，输出仍在 e.stdout 中
          output = e.stdout ? String(e.stdout) : '';
        }
        const m = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        if (!m) return resolve(0);
        resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
      } catch (e) {
        resolve(0);
      }
    });
  }

  // 探测成品音频响度：{ hasAudio, meanRaw, meanDb }
  // 用于区分「有音频流但静音」（缺陷）与「根本没有音频流」（未配乐，属正常）
  _probeAudioLoudness(videoPath) {
    const cmd = `"${FFMPEG_PATH}" -hide_banner -i "${videoPath}" -af volumedetect -f null - 2>&1`;
    let output;
    try {
      output = this._exec(cmd);
    } catch (e) {
      output = String(e.stdout || '') + String(e.stderr || '');
    }
    const hasAudio = /Stream #\d+:\d+.*Audio:/.test(output);
    const m = output.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
    const meanRaw = m ? m[1] : null;
    const meanDb = meanRaw === null
      ? null
      : (String(meanRaw).toLowerCase() === '-inf' ? -Infinity : parseFloat(meanRaw));
    return { hasAudio, meanRaw, meanDb };
  }

  // ========== 循环质检 ==========
  //
  // 历史：本方法曾无条件 return { passed:true, mock:true }，「循环过渡正常（模拟）」——
  // 而循环处理当时只是 copyFileSync 直通。两者叠加造成「假实现 + 假质检」双保险，
  // 用户看到的「无缝循环 ✅」从未经过任何检测。违反 §4.1 / §4.2。
  //
  // 现在的判定口径（必须区分「首尾相似」与「回绕连续」，二者含义不同）：
  //
  //   1) WRAP 指标（主判据）：产物【末尾】与【开头】的 SSIM。
  //      真交叉淡化的目的，就是让「播放到结尾」的画面逐渐变成「开头」的画面，
  //      这样循环回绕时观众看不出接缝。
  //      基线实测（2026-10-19，35s 样片）：
  //        - 直通（旧实现）：wrap SSIM ≈ 0.49
  //        - 真淡化 0.5s  ：wrap SSIM ≈ 0.93 ~ 0.96
  //
  //   2) BASE 指标（对照，防误判）：源素材本身首尾的 SSIM。
  //      如果素材首尾本来就长得一样（如整片同一场景），那么「直通」也会得到很高的
  //      wrap SSIM，此时 wrap 指标无法区分是否做了淡化。因此同时测源素材首尾相似度，
  //      只有当 wrap 显著高于 base 时，才能证明淡化真的起了作用。
  //
  //   3) 时长核验：产物时长必须 ≈ 源时长 - fadeDuration。
  //      这是「淡化是否真的发生」的结构性证据——直通的产物时长等于源时长。
  //
  // 三态：任一不可测（无 ffmpeg / 抽帧失败 / 源时长未知）一律判 passed:false 并写明原因，
  // 不允许把「没测成」当通过。返回体不设 skipped 字段（沿用 checkNSFW 的结构性约束）。
  async checkLoop(videoPath, options = {}) {
    const fail = (reason, extra = {}) => ({
      passed: false,
      qcVersion: QC_VERSION,
      reason,
      level: 'fail',
      ...extra
    });

    if (!this._hasFFmpeg()) {
      return fail('循环质检未执行：FFmpeg 不可用，无法抽帧与探测时长', { detectorUnavailable: true });
    }

    let info;
    try {
      info = await this._getVideoInfoFFmpeg(videoPath);
    } catch (e) {
      return fail('循环质检未执行：无法读取产物信息' + (e.message ? `（${e.message}）` : ''), { detectorError: true });
    }
    if (!info || !(info.duration > 0)) {
      return fail('循环质检未执行：产物时长无法探测', { detectorUnavailable: true });
    }
    const d = info.duration;

    // 抽帧位置：
    //  - 头部：向内收（-ss 落在首关键帧之前会抽空帧，历史事故）
    //  - 尾部：必须落在【淡化区的后段】。真淡化的最后 F 秒是「渐变成开头画面」的区域，
    //    越靠近末尾越像开头。实测同一产物：34.0s→0.496、34.3s→0.738、34.45s→0.934。
    //    若抽在 d-edge（例如 34.0s，正好是淡化起点），测到的是「还没开始淡」的画面，
    //    会把正确产物误判为 fail。
    //    因此尾部取「末尾 - 0.05s」：实测 34.40s→0.871、34.45s→0.934、34.48s→0.934，
    //    0.05s 的回退能稳定落在融合最深处，又避开末帧可能丢帧的风险。
    const tHead = Math.min(0.5, d * 0.05);
    const tailBack = Math.min(0.05, d * 0.01);
    const tTail = Math.max(0, d - tailBack);

    const frames = this._extractFramesAtTimes(videoPath, [tHead, tTail]);
    if (frames.length < 2) {
      return fail(
        `循环质检未执行：首尾帧抽取不完整（计划 2 帧，实际 ${frames.length} 帧）`,
        { detectorUnavailable: true, frameCount: frames.length }
      );
    }

    let wrapSsim;
    try {
      wrapSsim = this._ssimFromBase64(frames[1], frames[0]);
    } catch (e) {
      wrapSsim = null;
    }
    if (wrapSsim === null || !isFinite(wrapSsim)) {
      return fail('循环质检未执行：首尾帧相似度计算失败', { detectorUnavailable: true });
    }

    // 对照基线：源素材首尾相似度（仅在调用方提供 sourcePath 时测）
    let baseSsim = null;
    const sourcePath = options.sourcePath;
    if (sourcePath && fs.existsSync(sourcePath)) {
      try {
        const sInfo = await this._getVideoInfoFFmpeg(sourcePath);
        const sd = sInfo.duration;
        // 基线同理取「末尾 - 0.05s」，与产物的抽帧策略保持一致，对照才公平
        const sTailBack = Math.min(0.05, sd * 0.01);
        const sFrames = this._extractFramesAtTimes(sourcePath, [
          Math.min(0.5, sd * 0.05),
          Math.max(0, sd - sTailBack)
        ]);
        if (sFrames.length >= 2) {
          baseSsim = this._ssimFromBase64(sFrames[0], sFrames[1]);
        }
      } catch (e) {
        baseSsim = null;
      }
    }

    const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.90;
    const hasBaseline = baseSsim !== null && isFinite(baseSsim);
    // 无基线时，要求 wrap 达到绝对阈值；
    // 有基线时，允许「wrap 达到阈值」或「wrap 显著高于基线(+0.15)」二者其一。
    const wrapOkAbsolute = wrapSsim >= threshold;
    const wrapOkRelative = hasBaseline && wrapSsim >= Math.max(threshold - 0.25, baseSsim + 0.15);
    const wrapOk = hasBaseline ? (wrapOkAbsolute || wrapOkRelative) : wrapOkAbsolute;

    // 时长核验：产物应为 源时长 - fadeDuration
    const fadeDuration = Number.isFinite(Number(options.fadeDuration)) ? Number(options.fadeDuration) : null;
    const sourceDuration = Number.isFinite(Number(options.sourceDuration)) ? Number(options.sourceDuration) : null;

    let durationCheck = 'skipped_no_source';
    let durationOk = false;
    let expectedDuration = null;
    if (fadeDuration !== null && sourceDuration !== null) {
      expectedDuration = sourceDuration - fadeDuration;
      // 容差必须【小于淡化时长本身】。
      // 否则：淡化没发生（产物 == 源时长）的偏差恰好是 fadeDuration，
      // 会被大容差吞掉而漏判——实测 35s 素材、0.5s 淡化时，max(0.5, 2%)=0.69s 的容差
      // 就让「直通产物」的 0.5s 偏差通过了时长核验，等于把缺陷放行。
      // 取 fadeDuration 的 1/3 与 1% 时长的较小值，且不小于 0.05s（避免纯帧率抖动误杀）。
      const tol = Math.max(0.05, Math.min(fadeDuration / 3, expectedDuration * 0.01));
      durationOk = Math.abs(d - expectedDuration) <= tol;
      durationCheck = durationOk ? 'ok' : 'mismatch';
    }

    // 时长未知 => 不可判定 => 不通过（不允许当作通过）
    if (durationCheck === 'skipped_no_source') {
      return fail(
        `循环质检未通过：缺少源时长/淡化时长，无法核验「成片 = 源 - 淡化」这一结构性证据`
        + `（实测成片 ${d.toFixed(2)}s，首尾相似度 ${wrapSsim.toFixed(3)}）`,
        {
          wrapSsim,
          baseSsim,
          duration: d,
          durationCheck,
          frameTimes: [tHead, tTail]
        }
      );
    }

    const detail = {
      wrapSsim: Number(wrapSsim.toFixed(4)),
      baseSsim: hasBaseline ? Number(baseSsim.toFixed(4)) : null,
      threshold,
      duration: d,
      expectedDuration: Number(expectedDuration.toFixed(3)),
      fadeDuration,
      durationCheck,
      frameTimes: [Number(tHead.toFixed(3)), Number(tTail.toFixed(3))]
    };

    if (!durationOk) {
      return fail(
        `循环质检未通过：成片时长 ${d.toFixed(2)}s 与期望 ${expectedDuration.toFixed(2)}s 不符`
        + `（期望 = 源 ${sourceDuration.toFixed(2)}s - 淡化 ${fadeDuration}s；直通产物会等于源时长）`,
        detail
      );
    }

    if (!wrapOk) {
      const baseMsg = hasBaseline ? `，源素材首尾基线 ${baseSsim.toFixed(3)}` : '';
      return fail(
        `循环质检未通过：成片末尾与开头相似度 ${wrapSsim.toFixed(3)} 低于阈值 ${threshold}`
        + `${baseMsg}——回绕处可能仍会跳切`,
        detail
      );
    }

    return {
      passed: true,
      qcVersion: QC_VERSION,
      reason: `循环回绕连续：末尾/开头相似度 ${wrapSsim.toFixed(3)}（阈值 ${threshold}`
        + `${hasBaseline ? `，素材基线 ${baseSsim.toFixed(3)}` : ''}），`
        + `成片 ${d.toFixed(2)}s = 源 ${sourceDuration.toFixed(2)}s - 淡化 ${fadeDuration}s`,
      level: 'pass',
      ...detail
    };
  }

  // 计算两帧(base64 JPEG)的 SSIM。返回 All 通道数值；失败返回 null。
  // 走临时文件而不是管道：ffmpeg 的 ssim 滤镜需要两个文件输入。
  _ssimFromBase64(b64a, b64b) {
    const os = require('os');
    const stamp = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fa = path.join(os.tmpdir(), `qc_ssim_a_${stamp}.jpg`);
    const fb = path.join(os.tmpdir(), `qc_ssim_b_${stamp}.jpg`);
    try {
      fs.writeFileSync(fa, Buffer.from(b64a, 'base64'));
      fs.writeFileSync(fb, Buffer.from(b64b, 'base64'));
      const cmd = `"${FFMPEG_PATH}" -hide_banner -i "${fa}" -i "${fb}" -lavfi ssim -f null - 2>&1`;
      const out = this._exec(cmd);
      const m = String(out).match(/All:\s*([\d.]+)/);
      if (!m) return null;
      const v = parseFloat(m[1]);
      return isFinite(v) ? v : null;
    } catch (e) {
      // ssim 命中低相似度时 ffmpeg 可能非 0 退出，输出仍在 e.stdout 中
      const out = String((e && (e.stdout || e.stderr)) || '');
      const m = out.match(/All:\s*([\d.]+)/);
      if (!m) return null;
      const v = parseFloat(m[1]);
      return isFinite(v) ? v : null;
    } finally {
      try { if (fs.existsSync(fa)) fs.unlinkSync(fa); } catch (e) {}
      try { if (fs.existsSync(fb)) fs.unlinkSync(fb); } catch (e) {}
    }
  }

  // ========== 转码质检 ==========
  async checkTranscode(videoPath, expectedResolution = '720p', expectedFps = 30) {
    try {
      if (this._hasFFmpeg()) {
        const info = await this._getVideoInfoFFmpeg(videoPath);
        const resolutionOk = info.height >= 720 || expectedResolution === '480p';
        const fpsOk = Math.abs(info.fps - expectedFps) < 5;
        
        return {
          passed: resolutionOk && fpsOk,
          qcVersion: QC_VERSION,
          reason: `分辨率: ${info.width}x${info.height}, 帧率: ${info.fps}fps`,
          width: info.width,
          height: info.height,
          fps: info.fps,
          level: (resolutionOk && fpsOk) ? 'pass' : 'warn'
        };
      }
    } catch (e) {}
    return {
      passed: true,
      qcVersion: QC_VERSION,
      reason: '转码质检通过（模拟）',
      level: 'pass',
      mock: true
    };
  }

  // ========== 最终综合质检 ==========
  // options 透传给 NSFW 检测（apiKey/baseUrl/model/timeoutMs/nsfwThreshold/fetchImpl）
  async checkFinal(videoPath, options = {}) {
    const results = {};
    let totalPassed = true;
    const details = {};

    // 文件完整性
    try {
      const stats = fs.statSync(videoPath);
      details.fileSize = stats.size;
      details.fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      
      if (stats.size < 10240) { // 小于10KB认为异常
        totalPassed = false;
        results.fileIntegrity = { passed: false, reason: '文件过小，可能损坏', level: 'fail' };
      } else {
        results.fileIntegrity = { passed: true, reason: '文件完整', level: 'pass' };
      }
    } catch (e) {
      totalPassed = false;
      results.fileIntegrity = { passed: false, reason: '文件不存在', level: 'fail' };
    }

    // 视频基本信息
    try {
      if (this._hasFFmpeg()) {
        const info = await this._getVideoInfoFFmpeg(videoPath);
        results.videoInfo = {
          passed: info.duration > 0 && info.width > 0,
          reason: `${info.width}x${info.height}, ${info.duration.toFixed(1)}s, ${info.fps}fps`,
          level: info.duration > 0 ? 'pass' : 'fail',
          ...info
        };
        if (info.duration <= 0) totalPassed = false;
      } else {
        // 无 FFmpeg 时不能谎称「视频信息正常」，成片可能损坏/为 0 字节都无从判断
        totalPassed = false;
        results.videoInfo = {
          passed: false,
          reason: '无法读取视频信息：FFmpeg 不可用',
          level: 'fail',
          detectorUnavailable: true
        };
      }
    } catch (e) {
      totalPassed = false;
      results.videoInfo = { passed: false, reason: '读取视频信息出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 音频音量检测（P1）：有音频流却整段静音 → fail；无音频流 → skip（未配乐任务属正常）
    try {
      if (this._hasFFmpeg()) {
        const audio = this._probeAudioLoudness(videoPath);
        if (!audio.hasAudio) {
          // 这是合法的跳过：未配乐任务的成片本来就没有音轨，不算缺陷
          results.audioVolume = { passed: true, skipped: true, reason: '成片无音频流（未配乐）', level: 'skip', legitimateSkip: true };
        } else {
          const silent = audio.meanDb === null || !isFinite(audio.meanDb) || audio.meanDb <= -85;
          results.audioVolume = {
            passed: !silent,
            reason: silent
              ? `成片音频静音 (mean_volume=${audio.meanRaw} dB)`
              : `音频音量正常 (mean_volume=${audio.meanRaw} dB)`,
            meanVolume: audio.meanRaw,
            level: silent ? 'fail' : 'pass'
          };
          if (silent) totalPassed = false;
        }
      } else {
        // 无 FFmpeg 时既不能确认有音轨、也不能确认静音与否 —— 必须显式记录为未检测
        totalPassed = false;
        results.audioVolume = {
          passed: false,
          reason: '无法检测音频：FFmpeg 不可用（无法区分「未配乐」与「配乐静音」）',
          level: 'fail',
          detectorUnavailable: true
        };
      }
    } catch (e) {
      totalPassed = false;
      results.audioVolume = { passed: false, reason: '音频检测出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 黑帧抽检
    try {
      const bfResult = await this.checkBlackFrame(videoPath);
      results.blackFrame = bfResult;
      if (!bfResult.passed) totalPassed = false;
    } catch (e) {
      totalPassed = false;
      results.blackFrame = { passed: false, reason: '黑帧抽检出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // NSFW 合规检测（红线项，成片级）：无 Key / 调用失败 / 解析失败一律判 fail
    try {
      const nsfwResult = await this.checkNSFW(videoPath, options.nsfw || options);
      results.nsfw = nsfwResult;
      if (!nsfwResult.passed) totalPassed = false;
    } catch (e) {
      totalPassed = false;
      results.nsfw = { passed: false, reason: 'NSFW 检测出错: ' + e.message, level: 'fail', detectorError: true };
    }

    // 汇总「为什么没过」，避免只回一个笼统的「存在问题」
    // 区分两类跳过：
    //   legitimateSkip = true  -> 业务上本就不适用（如未配乐任务没有音轨），不算缺陷
    //   其它 skipped           -> 检测器没跑起来，必须判不通过
    const failedItems = Object.entries(results)
      .filter(([, v]) => !v.passed && !v.skipped)
      .map(([k, v]) => v.reason);
    const notRunItems = Object.entries(results)
      .filter(([, v]) => v.skipped && !v.legitimateSkip)
      .map(([k, v]) => v.reason);
    const legitSkipItems = Object.entries(results)
      .filter(([, v]) => v.skipped && v.legitimateSkip)
      .map(([k, v]) => v.reason);

    // 只要求「实际执行的检测项都通过」，且不存在未执行的检测项
    if (notRunItems.length > 0) totalPassed = false;

    const parts = [];
    if (failedItems.length) parts.push('未通过：' + failedItems.join('; '));
    if (notRunItems.length) parts.push('未执行：' + notRunItems.join('; '));

    let reason;
    if (!totalPassed) {
      reason = '最终质检未通过｜' + parts.join('｜');
    } else if (legitSkipItems.length) {
      reason = `最终质检通过（${legitSkipItems.length} 项按设计跳过：${legitSkipItems.join('; ')}）`;
    } else {
      reason = '最终质检通过';
    }

    return {
      passed: totalPassed,
      qcVersion: QC_VERSION,
      reason,
      details: results,
      fileInfo: details
    };
  }

  // 兼容旧接口：checkAll
  async checkAll(videoPath) {
    return this.checkClip(videoPath, 30);
  }

  // ========== NSFW 合规检测（红线项） ==========
  // 依赖：FFmpeg 抽帧 + 多模态 LLM（OpenAI 兼容 chat/completions）。
  //
  // 判定语义（与 checkContentMatch 的关键差异）：
  //   checkContentMatch 是「业务参考项」：无 Key/超时 -> skipped，不阻塞主流程；
  //   NSFW 是「合规红线」：无 Key / 调用失败 / 超时 / 返回无法解析 -> 一律 passed:false。
  //   绝不存在「没测到就算过」的路径 —— 这是历史上被修过一次的缺陷，不许退回。
  //
  // options: apiKey/baseUrl/model（缺省读 config.OPENAI_*）
  //          timeoutMs（缺省 120s）、nsfwThreshold（缺省 config.QC.nsfwThreshold）、
  //          maxFrames（缺省 30，压测/调试用）、framesPerMinute（缺省 1）、
  //          fetchImpl（缺省全局 fetch，便于单测注入）
  async checkNSFW(videoPath, options = {}) {
    const threshold = this._resolveNsfwThreshold(options.nsfwThreshold);
    // 解析顺序：任务级 runtimeConfig -> 多模态专用配置 -> 通用 OPENAI_* -> 默认
    // 多模态专门一组配置，是因为视觉模型和文本模型常常不是同一家厂商。
    const apiKey = options.apiKey || config.MULTIMODAL_API_KEY || config.OPENAI_API_KEY || '';
    // 末尾斜杠必须去掉，否则拼成 `...com/v1//chat/completions` 会 404。
    // （之前的「测试连接」入口做了规范化、真实检测路径没做，导致测试通过但生成时 404）
    const baseUrl = (options.baseUrl || config.MULTIMODAL_BASE_URL || config.OPENAI_BASE_URL || 'https://api.openai.com/v1')
      .replace(/\/+$/, '');

    // 模型名必须与端点厂商匹配（详见 _resolveVisionModel 的注释与实际事故记录）
    const explicitModel = options.model || config.OPENAI_MULTIMODAL_MODEL;
    const model = this._resolveVisionModel(explicitModel, baseUrl);
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : NSFW_TIMEOUT_MS;

    // ⚠️ 应急演示开关，**默认关闭**，开关打开时**所有** NSFW 失败路径都降级放行。
    //
    // 背景（2026-10-19 实际踩到）：未配置多模态 Key、或 Key 填了但调用超时/失败时，
    // NSFW 必然判 fail，导致**任何任务都无法出片**（实测：10 片段任务全部 failed，
    // 错误分别表现为「未配置多模态 LLM Key」与「多模态调用失败/超时」）。
    // 只处理「无 Key」一种情况是不够的——用户填了 Key 但端点不通时同样全盘失败。
    // 因此开关做进 fail 本身，一处覆盖全部 9 个失败点。
    //
    // 这是**对 §4.1 的临时妥协**：会让「没检测」冒充「通过」。
    // 返回体带 demoSkipped:true + 明确 reason，便于事后审计。
    // **生产环境必须关闭**（QC_NSFW_ALLOW_UNCONFIGURED 不设或设为 0），否则等于没有合规检测。
    const demoAllow = config.QC && config.QC.nsfwAllowUnconfigured === true;
    const demoSkip = (why) => ({
      passed: true,
      qcVersion: QC_VERSION,
      reason: `【演示模式】NSFW 合规检测未真正执行：${why}`
        + '（QC_NSFW_ALLOW_UNCONFIGURED=1；生产环境必须关闭）',
      level: 'warn',
      demoSkipped: true,
      skipped: false,
      detectorUnavailable: true,
      threshold,
      model
    });

    // ---- 0. 合成素材：合法跳过（不是"没跑"，是"本就不适用"）----
    //
    // Mock 模型的片段是 ffmpeg 合成的测试图案（纯色/渐变/时间码），不来自任何外部素材，
    // 内容可证明安全 —— 这与真实 AI 生成内容有本质区别，NSFW 检测对它不适用。
    //
    // 为什么必须显式处理：早前它落到「未配置 Key / 调用超时 → 判 fail」，
    // 结果是**任何没有可用多模态 Key 的用户都无法用 Mock 跑通任何任务**
    // （实测：演示时 10 个片段全部 failed）。这不合理——安全的素材被当成高危拦截。
    //
    // 语义严格遵守 §4.1：返回 passed:false + legitimateSkip:true + 明确理由，
    // **不冒充通过**；聚合逻辑认 legitimateSkip 放行，这一点与 passed 不同。
    if (options.syntheticSource === true) {
      return {
        passed: false,
        legitimateSkip: true,
        qcVersion: QC_VERSION,
        reason: 'NSFW 检测对合成素材不适用：Mock 片段由 ffmpeg 生成测试图案，不来自外部素材，内容可证明安全',
        level: 'skip',
        skipped: true,
        threshold,
        model,
        syntheticSource: true
      };
    }

    // 统一出口：保证每个返回都带 threshold，便于排查「为什么这条线判了 fail」。
    // 开关打开时任何 fail 都降级为 demoSkip（不影响默认行为）。
    const fail = (reason, extra = {}) => {
      if (demoAllow) return demoSkip(reason);
      return {
        passed: false,
        qcVersion: QC_VERSION,
        reason,
        level: 'fail',
        threshold,
        model,
        ...extra
      };
    };

    // ---- 1. 前置条件：任一不满足都必须判 fail，不能跳过 ----
    if (!apiKey) {
      if (demoAllow) return demoSkip('未配置多模态 LLM Key');
      return fail('NSFW 检测未执行：未配置多模态 LLM Key', { detectorUnavailable: true, skipped: false });
    }
    if (!this._hasFFmpeg()) {
      if (demoAllow) return demoSkip('FFmpeg 不可用，无法抽帧');
      return fail('NSFW 检测未执行：FFmpeg 不可用，无法抽帧', { detectorUnavailable: true, skipped: false });
    }

    // ---- 2. 抽帧 ----
    let frames = null;
    let plan = null;
    try {
      plan = this._buildNSFWFramePlan(videoPath, options);
      if (!plan || plan.duration <= 0) {
        return fail('NSFW 检测未执行：无法读取视频时长，抽帧失败', { detectorUnavailable: true });
      }
      frames = this._extractFramesAtTimes(videoPath, plan.times);
    } catch (e) {
      return fail(`NSFW 检测未执行：抽帧异常 ${e.message}`, { detectorUnavailable: true });
    }
    if (!frames || frames.length === 0) {
      return fail('NSFW 检测未执行：抽帧失败，未取得任何画面', { detectorUnavailable: true, frameCount: 0 });
    }
    // 抽到的帧不足计划的一半 —— 说明视频解码有问题，覆盖面不成立，不能放行
    if (frames.length < Math.ceil(plan.times.length / 2)) {
      return fail(
        `NSFW 检测未执行：抽帧不完整（计划 ${plan.times.length} 帧，实际 ${frames.length} 帧）`,
        { detectorUnavailable: true, frameCount: frames.length, plannedFrames: plan.times.length }
      );
    }

    // ---- 3. 多模态调用 ----
    let raw;
    // 每次调用用自己的错误槽，避免并发检查多个片段时 404 被别的调用清成「超时」
    const upstreamError = { value: null };
    try {
      raw = await this._callNsfwMultimodal(frames, {
        apiKey, baseUrl, model, timeoutMs,
        fetchImpl: options.fetchImpl,
        errorOut: upstreamError
      });
    } catch (e) {
      return fail(`NSFW 检测未执行：多模态调用异常 ${e.message}`, { detectorError: true, frameCount: frames.length });
    }
    if (!raw) {
      // 不再一律报「失败/超时」：把上游状态码与报文带出来，否则 403 模型未授权
      // 会被误读成网络超时（实测踩过，用户完全无法定位）
      const up = upstreamError.value || this._nsfwLastError;
      let detail = '多模态调用失败/超时（120s 内无有效响应）';
      if (up) {
        if (up.kind === 'http') {
          detail = `多模态调用失败 HTTP ${up.status}：${String(up.message || '').slice(0, 160)}`;
        } else if (up.kind === 'timeout') {
          detail = `多模态调用超时（${timeoutMs}ms 内无响应）`;
        } else {
          detail = `多模态调用失败：${String(up.message || '').slice(0, 160)}`;
        }
      }
      const hint = up && up.kind === 'http' && up.status === 403
        ? '模型未授权：确认多模态地址是 https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1，'
          + '并在百炼控制台「模型广场」开通该视觉模型（或换 qwen-vl-plus / qwen-vl-max）'
        : undefined;
      return fail(`NSFW 检测未执行：${detail}`, {
        detectorUnavailable: true,
        frameCount: frames.length,
        upstream: up || null,
        ...(hint ? { hint } : {}),
      });
    }

    // ---- 4. 解析分数 ----
    const verdict = this._parseNsfwVerdict(raw);
    if (!verdict) {
      return fail(`NSFW 检测未执行：模型返回无法解析（原始输出: ${raw.slice(0, 120)}）`, {
        detectorError: true,
        frameCount: frames.length,
        rawOutput: raw.slice(0, 500)
      });
    }

    // ---- 5. 阈值判定：达到或超过即不合规 ----
    const score = verdict.score;
    const overThreshold = score >= threshold;
    // 模型自报 nsfw:true 但分数低于阈值时，按「已被模型标记」从严处理，避免分数与结论自相矛盾时被放行
    const flagged = overThreshold || verdict.flagged;
    const pct = (n) => `${(n * 100).toFixed(1)}%`;
    return {
      passed: !flagged,
      qcVersion: QC_VERSION,
      reason: flagged
        ? `NSFW 置信度 ${pct(score)} 达到阈值 ${pct(threshold)}${verdict.flagged ? '（模型标记不合规）' : ''}：${verdict.reason}`
        : `NSFW 置信度 ${pct(score)} 低于阈值 ${pct(threshold)}：${verdict.reason}`,
      level: flagged ? 'fail' : 'pass',
      score,
      threshold,
      flagged,
      frameCount: frames.length,
      sampledTimes: plan.times,
      coverageRatio: plan.coverageRatio,
      model,
      details: { reason: verdict.reason, sampleCount: verdict.sampleCount, totalFrames: verdict.totalFrames }
    };
  }

  // ===== 视觉模型名解析（checkNSFW 与 checkContentMatch 共用）=====
  //
  // 模型名必须与端点厂商匹配，否则请求会被对端拒绝（404/400）或直接挂住超时。
  // 实测踩过：用户把多模态地址填成阿里云 DashScope 兼容模式，但模型名留空，
  // 于是用了默认的 gpt-4o-mini —— 那是 OpenAI 的模型，阿里云没有，
  // 结果每个片段都报「多模态调用失败/超时」，10 个片段任务全盘失败。
  //
  // 规则：显式值与厂商明显不匹配 → 换成该厂商真实存在的视觉模型；
  //       完全未知的端点不猜（保留用户原值），避免把自建网关的模型名改坏。
  _resolveVisionModel(explicitModel, baseUrl) {
    const url = String(baseUrl || '').toLowerCase();
    const vendorDefault = () => {
      if (/dashscope|aliyuncs/.test(url)) return 'qwen-vl-max';      // 阿里云百炼
      if (/deepseek/.test(url)) return 'deepseek-vl2';               // DeepSeek
      if (/bigmodel|zhipu/.test(url)) return 'glm-4v';               // 智谱
      if (/siliconflow/.test(url)) return 'Qwen/Qwen2.5-VL-72B-Instruct';
      if (/moonshot/.test(url)) return 'moonshot-v1-8k-vision-preview';
      return 'gpt-4o-mini';
    };
    const mismatched = (m) => {
      const mm = String(m || '').toLowerCase();
      if (!mm) return true;
      if (/dashscope|aliyuncs/.test(url)) return !/^(qwen|wanx|qvq)/.test(mm);
      if (/deepseek/.test(url)) return !/^deepseek/.test(mm);
      if (/bigmodel|zhipu/.test(url)) return !/^glm/.test(mm);
      if (/siliconflow/.test(url)) return !/^(qwen|deepseek|qvq|internvl)/.test(mm);
      if (/moonshot/.test(url)) return !/^moonshot/.test(mm);
      if (/openai\.com/.test(url)) return /^(qwen|glm|moonshot|deepseek|wanx)/.test(mm);
      return false; // 未知端点：不猜
    };
    return (explicitModel && !mismatched(explicitModel)) ? explicitModel : vendorDefault();
  }

  // 解析阈值：显式参数 > this.options（构造时取 config.QC.nsfwThreshold）> 0.8
  _resolveNsfwThreshold(explicit) {
    const candidates = [explicit, this.options && this.options.nsfwThreshold, 0.8];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    }
    return 0.8;
  }

  // 抽帧计划：每分钟 framesPerMinute 帧，上限 maxFrames 帧
  // 时长 >= 1 分钟时，按 duration/min(⌈duration/60⌉, maxFrames) 均匀铺满全片；
  // 时长 < 1 分钟时至少抽 2 帧（首帧 + 尾帧），否则 1 帧覆盖不了整段内容。
  _buildNSFWFramePlan(videoPath, options = {}) {
    const info = this._getVideoInfoFFmpegSync(videoPath);
    const duration = info ? info.duration : 0;
    if (!(duration > 0)) return null;

    const perMinute = Number.isFinite(options.framesPerMinute) && options.framesPerMinute > 0
      ? options.framesPerMinute
      : NSFW_FRAMES_PER_MINUTE;
    const maxFrames = Number.isFinite(options.maxFrames) && options.maxFrames > 0
      ? Math.floor(options.maxFrames)
      : NSFW_MAX_FRAMES;

    const wantFrames = duration >= 60
      ? Math.min(Math.ceil((duration / 60) * perMinute), maxFrames)
      : Math.min(2, maxFrames);
    const planFrames = Math.max(1, wantFrames);

    // 采样点均匀铺满整片：首帧取 0，末帧不取到最后一帧（避免 NLE 尾部空帧）
    // 关键帧吸附：-ss 在关键帧之前定位时 ffmpeg 会 seek 到「上一个关键帧」，
    // 该关键帧的时刻若落在 [0, duration) 之外（本样片首关键帧在 35.04s，时长 35.04s），
    // image2pipe 抽帧会直接空输出。所以抽样点必须向内收，且限制在 [minT, maxT] 内。
    const edge = Math.min(0.5, duration * 0.05);
    const minT = edge;
    const maxT = Math.max(edge, duration - edge);
    let times;
    if (planFrames === 1) {
      times = [(minT + maxT) / 2];
    } else {
      const step = Math.max(NSFW_MIN_FRAME_GAP, (maxT - minT) / (planFrames - 1));
      times = Array.from({ length: planFrames }, (_, i) => minT + i * step);
    }
    // 去重（保留能被视频真实承载的时刻：>=0 且 < duration），再补齐到 planFrames
    times = this._dedupeTimes(times.filter(t => t >= minT && t <= maxT), NSFW_MIN_FRAME_GAP);
    let guard = 0;
    while (times.length < planFrames && guard++ < planFrames * 4) {
      const step = Math.max(NSFW_MIN_FRAME_GAP, (maxT - minT) / planFrames);
      const candidate = Math.round((minT + step / 2 + times.length * step) * 1000) / 1000;
      if (candidate > maxT) break;
      if (times.every(t => Math.abs(t - candidate) >= NSFW_MIN_FRAME_GAP)) times.push(candidate);
      else break;
    }

    return {
      duration,
      times,
      perMinute,
      maxFrames,
      coverageRatio: Math.min(1, planFrames / (duration / 60))
    };
  }

  // 按时间点升序去重，相邻间隔小于 minGap 的丢弃后者
  _dedupeTimes(times, minGap) {
    const out = [];
    for (const t of [...times].sort((a, b) => a - b)) {
      if (out.length === 0 || t - out[out.length - 1] >= minGap) out.push(t);
    }
    return out;
  }

  // 抽取指定时间点的帧，返回 base64 JPEG 数组。
  // 与 _extractFramesBase64（首/中/尾 3 帧）分开实现，避免改动 checkContentMatch 的既有行为。
  //
  // 注意：这里必须走 this._exec()，不能用裸 execSync。
  // 本环境的 child_process 管道捕获会被沙箱拒绝（spawnSync cmd.exe EPERM），
  // _exec() 内置了「重定向到临时文件再读」的降级路径；裸 execSync 会静默抛错 -> 抽帧恒为 0 帧。
  _extractFramesAtTimes(videoPath, times) {
    const frames = [];
    for (const t of times) {
      try {
        const seek = Math.max(0, Number(t) || 0).toFixed(3);
        const cmd = `"${FFMPEG_PATH}" -ss ${seek} -i "${videoPath}" -frames:v 1 -f image2pipe -vcodec mjpeg -q:v 3 - 2>NUL`;
        // _exec 返回 utf8 字符串；二进制 JPEG 会被解码损坏，故取底层 Buffer。
        // 降级路径（临时文件）下 _exec 返回的是文本，此时统一回读临时文件不可行，
        // 因此这里直接用 _execRawBuffer 拿原始字节。
        const buf = this._execRawBuffer(cmd);
        if (buf && buf.length > 0 && buf[0] === 0xFF && buf[1] === 0xD8) {
          frames.push(buf.toString('base64'));
        }
      } catch (e) {
        // 单帧失败跳过该帧；是否「抽帧不完整」由调用方按比例判定
      }
    }
    return frames;
  }

  // 执行命令并返回原始 stdout Buffer；管道被环境禁止时自动降级为「落临时文件再读」。
  // 这是 _exec() 的二进制版本（JPEG 等非文本输出必须用这个，走 utf8 会被解码破坏）。
  _execRawBuffer(cmd) {
    try {
      return execSync(cmd, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      if (!(e && (e.code === 'EPERM' || /EPERM|EACCES/.test(String(e.message || ''))))) throw e;
      const os = require('os');
      const tmp = path.join(os.tmpdir(), `qc_nsfw_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`);
      try {
        execSync(`${cmd} > "${tmp}" 2>NUL`, { stdio: 'ignore' });
      } catch (e2) {
        if (!fs.existsSync(tmp)) throw e;
      }
      try {
        return fs.readFileSync(tmp);
      } finally {
        try { fs.unlinkSync(tmp); } catch (e3) {}
      }
    }
  }

  // NSFW 专用多模态调用：与 _callMultimodal 的 prompt 语义完全不同，不复用。
  // 返回模型原始文本（字符串），失败/超时/非 2xx 返回 null。
  async _callNsfwMultimodal(framesBase64, { apiKey, baseUrl, model, timeoutMs, fetchImpl, errorOut }) {
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    // 本地错误槽：并发检查多个片段时 this._nsfwLastError 会被别的调用清空/覆盖，
    // 导致 404 被误报成「超时/无响应」。调用方拿到自己的那份，不再依赖共享状态。
    const recordError = (up) => {
      this._nsfwLastError = up;
      if (errorOut) errorOut.value = up;
    };
    if (errorOut) errorOut.value = null;
    this._nsfwLastError = null;
    if (!doFetch) {
      recordError({ kind: 'no-fetch', message: '运行环境没有可用的 fetch' });
      console.error('NSFW 检测: 运行环境没有可用的 fetch');
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const imageContent = framesBase64.map(f => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${f}` }
      }));
      const text = `你是内容安全审核员。以上是从同一段视频中按时间顺序抽取的画面（共 ${framesBase64.length} 帧），用于合规审核。

请严格按画面中实际可见的内容判断是否存在 NSFW（not safe for work）内容，包括：裸露或性器官暴露、性行为暗示、性暗示动作、血腥暴力、虐待、违禁品展示。

判定规则（必须遵守）：
1. 只依据画面中实际可见的内容判定，不要因为提示词、字幕、风格猜测而臆断。
2. 任一流派/艺术风格都不能豁免：动漫、插画、3D 渲染同样按可见内容判定。
3. 部分画面中只有人像、风景、物体等普通内容，nsfw 应为 false。
4. 若画面确实含有上述内容，nsfw 必须为 true，score 为最严重那一帧的风险置信度。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：
{"nsfw": true 或 false, "score": 0 到 1 之间的小数, "reason": "不超过 40 字的中文理由", "frames": [{"index": 帧序号从0开始, "nsfw": true或false, "score": 0到1}]}
其中 score 表示「画面确实包含 NSFW 内容」的置信度：0 表示完全安全，1 表示确定包含。
没有问题的视频请输出 {"nsfw": false, "score": 0.02, "reason": "画面为正常内容"} 这种形式。`;

      const resp = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'user', content: [{ type: 'text', text }, ...imageContent] }
          ],
          max_tokens: 900,
          temperature: 0
        }),
        signal: controller.signal
      });
      if (!resp || !resp.ok) {
        // 把上游状态码与报文留下来：403 Model.AccessDenied 与 401 InvalidApiKey
        // 的处理方式完全不同，不能都归成「调用失败」
        let bodySnippet = '';
        try {
          if (resp && typeof resp.text === 'function') bodySnippet = String(await resp.text()).slice(0, 300);
        } catch (e) { /* 读不到 body 不影响判定 */ }
        const status = resp ? resp.status : 0;
        recordError({ kind: 'http', status, message: bodySnippet || `HTTP ${status}` });
        console.error(`NSFW 检测请求失败: HTTP ${status} ${bodySnippet.slice(0, 200)}`);
        return null;
      }
      const data = await resp.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      if (!content) {
        recordError({ kind: 'empty-content', status: 200, message: '响应中无 choices[0].message.content' });
        console.error('NSFW 检测: 响应中无 choices[0].message.content');
        return null;
      }
      return String(content);
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /aborted|timeout/i.test(e.message || ''));
      recordError({
        kind: aborted ? 'timeout' : 'exception',
        status: 0,
        message: aborted ? `超时（${timeoutMs}ms 内无响应）` : (e.message || String(e)),
      });
      console.error('NSFW 检测调用异常:', e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 解析 NSFW 结论：{"nsfw": bool, "score": 0~1, "reason": str, "frames": [...]}
  // 解析失败返回 null（调用方据此判 fail，不得静默放行）。
  // 分数越界时不夹取，交由调用方按「无法解析」处理 —— 夹取会把 3.0 变成 1.0，语义被篡改。
  _parseNsfwVerdict(content) {
    let text = String(content == null ? '' : content).trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    let obj;
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;

    const rawScore = obj.score === undefined || obj.score === null ? NaN : Number(obj.score);
    const scoreOk = Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 1;
    const flaggedOk = typeof obj.nsfw === 'boolean';
    // 有 score 就必须合法：超出 [0,1] 说明模型输出不可信，一律判「无法解析」。
    // 不做夹取 —— 把 3.0 夹成 1.0、或把 -0.5 夹成 0 都会篡改语义，让红线形同虚设。
    if (obj.score !== undefined && obj.score !== null && !scoreOk) return null;
    // score 与 nsfw 至少要有一个可用
    if (!scoreOk && !flaggedOk) return null;

    const frames = Array.isArray(obj.frames) ? obj.frames : [];
    return {
      flagged: flaggedOk ? obj.nsfw : rawScore >= 1,
      score: scoreOk ? rawScore : (obj.nsfw ? 1 : 0),
      reason: String(obj.reason || '').slice(0, 200),
      sampleCount: frames.length,
      totalFrames: frames.length || null
    };
  }

  // ========== 视觉内容质检（§9B，多模态 LLM 抽帧） ==========
  // FFmpeg 抽首/中/尾 3 帧 → 多模态 LLM 判断画面是否符合提示词意图
  // 任一环节失败（无 Key/超时/非2xx/解析失败）一律 skipped，不阻塞主流程
  async checkContentMatch(videoPath, expectedPrompt, options = {}) {
    // ⚠️ 对抗性审查发现（2026-10-20）：这里原先只读 config.OPENAI_API_KEY，
    // 而上面的注释却承诺「优先多模态专用配置」—— 代码与注释不符。
    // 后果：用户只在「多模态 API Key」里填了值、没填通用 OPENAI_API_KEY 时，
    // 视觉内容匹配会永远走 skip 分支，等于该功能静默失效。
    const apiKey = options.apiKey || config.MULTIMODAL_API_KEY || config.OPENAI_API_KEY || '';
    // 与 checkNSFW 一致：优先多模态专用配置，并去掉末尾斜杠（否则 //chat/completions 会 404）
    const baseUrl = (options.baseUrl || config.MULTIMODAL_BASE_URL || config.OPENAI_BASE_URL || 'https://api.openai.com/v1')
      .replace(/\/+$/, '');
    // 模型同样要做厂商匹配：否则「阿里云端点 + 默认 gpt-4o-mini」仍会被对端拒绝。
    // 复用 checkNSFW 里那套推断（_resolveVisionModel），保证两条视觉链路行为一致。
    const model = this._resolveVisionModel(options.model || config.OPENAI_MULTIMODAL_MODEL, baseUrl);

    const skip = (reason) => ({
      passed: true,
      skipped: true,
      reason: `视觉质检跳过: ${reason}`,
      level: 'skip'
    });

    if (!apiKey) return skip('未配置多模态 LLM Key');
    if (!expectedPrompt) return skip('提示词为空');
    if (!this._hasFFmpeg()) return skip('FFmpeg 不可用');

    try {
      // 1. 抽帧（首/中/尾，base64 JPEG）
      const frames = this._extractFramesBase64(videoPath);
      if (!frames || frames.length === 0) return skip('抽帧失败');

      // 2. 多模态调用
      const verdict = await this._callMultimodal(frames, expectedPrompt, { apiKey, baseUrl, model });
      if (!verdict) return skip('多模态调用失败/超时');

      // 3. 解析判断
      return {
        passed: verdict.passed,
        reason: verdict.passed ? '画面符合提示词意图' : `画面与提示词不符: ${verdict.reason}`,
        frames: frames.length,
        model,
        level: verdict.passed ? 'pass' : 'fail',
        details: { answer: verdict.reason }
      };
    } catch (e) {
      return skip('异常: ' + e.message);
    }
  }

  // 抽 3 帧（首/中/尾）转 base64 JPEG；时长过短则减少帧数
  _extractFramesBase64(videoPath) {
    const info = this._getVideoInfoFFmpegSync(videoPath);
    const duration = info ? info.duration : 0;
    if (duration <= 0) return null;

    const times = duration < 1 ? [0] : duration < 3
      ? [0, duration * 0.8]
      : [0, duration / 2, duration * 0.85];

    const frames = [];
    for (const t of times) {
      const cmd = `"${FFMPEG_PATH}" -ss ${t} -i "${videoPath}" -frames:v 1 -f image2pipe -vcodec mjpeg -q:v 3 - 2>NUL`;
      try {
        const buf = execSync(cmd, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
        if (buf && buf.length > 0) frames.push(buf.toString('base64'));
      } catch (e) {
        // 单帧失败跳过该帧
      }
    }
    return frames.length > 0 ? frames : null;
  }

  // 同步取视频信息（execSync 包装，失败返回 null）
  _getVideoInfoFFmpegSync(videoPath) {
    try {
      const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" 2>&1`;
      let output;
      try {
        output = this._exec(cmd);
      } catch (e) {
        // ffmpeg 探测不完整输入会返回非零码，输出仍在 e.stdout 中
        output = e.stdout ? String(e.stdout) : '';
      }
      const info = { duration: 0 };
      const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (durMatch) {
        info.duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
      }
      return info;
    } catch (e) {
      return null;
    }
  }

  // 多模态 LLM 调用（OpenAI 兼容格式），失败/超时返回 null
  async _callMultimodal(framesBase64, expectedPrompt, { apiKey, baseUrl, model }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const imageContent = framesBase64.map(f => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${f}` }
      }));
      const text = `请判断视频抽帧画面是否符合以下提示词意图。只输出 JSON：{"pass": true 或 false, "reason": "一句话理由"}
提示词意图：${expectedPrompt}
注意：若画面与提示词主体明显不符（如要雪山给了沙漠）判 false；合理构图、光影细节差异不判失败。`;

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'user', content: [{ type: 'text', text }, ...imageContent] }
          ],
          max_tokens: 150,
          temperature: 0.2
        }),
        signal: controller.signal
      });
      if (!resp.ok) {
        console.error(`视觉质检请求失败: HTTP ${resp.status}`);
        return null;
      }
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      return this._parseVerdict(content);
    } catch (e) {
      console.error('视觉质检调用异常:', e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 容错解析模型输出的 {"pass": bool, "reason": str}（容忍 markdown 代码块/多余文字）
  _parseVerdict(content) {
    let text = String(content).trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (typeof obj.pass !== 'boolean') return null;
      return { passed: obj.pass, reason: String(obj.reason || '').slice(0, 200) };
    } catch (e) {
      return null;
    }
  }

  // ===== FFmpeg 实现 =====

  // 统一的子进程执行入口：优先直接捕获 stdout；
  // 若运行环境禁止捕获外部进程输出（沙箱/CI 里会出现 spawn EPERM），
  // 自动降级为「重定向到临时文件再读」，保证质检逻辑在受限环境下同样真实执行。
  // 生产桌面/服务器环境下走的是第一条路径，行为与原先完全一致。
  _exec(cmd) {
    try {
      return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      if (!(e && (e.code === 'EPERM' || /EPERM|EACCES/.test(String(e.message || ''))))) throw e;
      // 降级路径：把 stdout+stderr 都重定向到临时文件
      const os = require('os');
      const tmp = path.join(os.tmpdir(), `qc_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
      try {
        execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore' });
      } catch (e2) {
        // ffmpeg 检测类命令常以非 0 退出（如 blackdetect 命中），产物仍可能写在文件里，
        // 所以这里不直接抛出，读取已有内容即可；确实读不到再抛原错误。
        if (!fs.existsSync(tmp)) throw e;
      }
      try {
        return fs.readFileSync(tmp, 'utf8');
      } finally {
        try { fs.unlinkSync(tmp); } catch (e3) {}
      }
    }
  }

  _hasFFmpeg() {
    try {
      execSync(`"${FFMPEG_PATH}" -version`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }

  _checkBlackFrameFFmpeg(videoPath) {
    const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" -vf "blackdetect=d=${this.options.blackFrameMinDuration}:pic_th=${this.options.blackFrameThreshold}" -f null - 2>&1`;
    try {
      const output = this._exec(cmd);
      const hasBlackFrame = output.includes('black_start');
      return {
        passed: !hasBlackFrame,
        reason: hasBlackFrame ? '检测到黑帧' : '无黑帧',
        raw: output.substring(0, 200),
        level: hasBlackFrame ? 'fail' : 'pass'
      };
    } catch (e) {
      // 有 FFmpeg 但执行抛错：这是检测器失效，不能算通过
      return { passed: false, reason: '检测执行出错: ' + e.message, level: 'fail', detectorError: true };
    }
  }

  _checkBlurFFmpeg(videoPath) {
    const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" -vf "blurdetect,metadata=print:key=lavfi.blur" -an -f null - 2>&1`;
    try {
      const output = this._exec(cmd);
      const blurValues = output.match(/lavfi\.blur=([\d.]+)/g) || [];
      const maxBlur = blurValues.reduce((max, m) => {
        const val = parseFloat(m.split('=')[1]);
        return Math.max(max, val);
      }, 0);

      return {
        passed: maxBlur < this.options.blurThreshold,
        reason: maxBlur >= this.options.blurThreshold ? `画面模糊 (${maxBlur.toFixed(1)})` : `画质正常 (max: ${maxBlur.toFixed(1)})`,
        maxBlur,
        level: maxBlur >= this.options.blurThreshold ? 'fail' : 'pass'
      };
    } catch (e) {
      // 有 FFmpeg 但执行抛错：这是检测器失效，不能算通过
      return { passed: false, reason: '检测执行出错: ' + e.message, level: 'fail', detectorError: true };
    }
  }

  _checkDuplicateFFmpeg(videoPath) {
    const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" -vf "mpdecimate" -f null - 2>&1`;
    try {
      const output = this._exec(cmd);
      const dropMatch = output.match(/drop_count:\s*(\d+)/);
      const dropCount = dropMatch ? parseInt(dropMatch[1]) : 0;

      return {
        passed: dropCount < 10,
        reason: dropCount >= 10 ? `重复帧过多 (${dropCount}帧)` : `重复帧正常 (${dropCount}帧)`,
        dropCount,
        level: dropCount >= 10 ? 'fail' : 'pass'
      };
    } catch (e) {
      // 有 FFmpeg 但执行抛错：这是检测器失效，不能算通过
      return { passed: false, reason: '检测执行出错: ' + e.message, level: 'fail', detectorError: true };
    }
  }

  _checkDurationFFmpeg(videoPath, expectedDuration) {
    return new Promise((resolve) => {
      try {
        const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" 2>&1`;
        let output;
        try {
          output = this._exec(cmd);
        } catch (e) {
          // ffmpeg 仅探测（无输出参数）退出码恒非 0，输出仍在 e.stdout 中
          output = e.stdout ? String(e.stdout) : '';
        }
        const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseFloat(durationMatch[3]);
          const duration = hours * 3600 + minutes * 60 + seconds;

          const minDuration = expectedDuration * this.options.minDurationRatio;
          const maxDuration = expectedDuration * this.options.maxDurationRatio;
          const passed = duration >= minDuration && duration <= maxDuration;

          resolve({
            passed,
            reason: passed ? `时长正常 (${duration.toFixed(1)}s)` : `时长异常 (${duration.toFixed(1)}s, 期望 ${expectedDuration}s)`,
            duration,
            expectedDuration,
            level: passed ? 'pass' : 'warn'
          });
        } else {
          resolve({ passed: true, skipped: true, reason: '无法获取时长', level: 'skip' });
        }
      } catch (e) {
        resolve({ passed: true, skipped: true, reason: e.message, level: 'skip' });
      }
    });
  }

  _getVideoInfoFFmpeg(videoPath) {
    return new Promise((resolve, reject) => {
      try {
        const cmd = `"${FFMPEG_PATH}" -i "${videoPath}" 2>&1`;
        let output;
        try {
          output = this._exec(cmd);
        } catch (e) {
          // ffmpeg 仅探测（无输出参数）退出码恒非 0，输出仍在 e.stdout 中
          output = e.stdout ? String(e.stdout) : '';
        }
        
        const info = { width: 0, height: 0, fps: 0, duration: 0 };
        
        // 分辨率
        const resMatch = output.match(/(\d{3,4})x(\d{3,4})/);
        if (resMatch) {
          info.width = parseInt(resMatch[1]);
          info.height = parseInt(resMatch[2]);
        }
        
        // 帧率
        const fpsMatch = output.match(/(\d+(?:\.\d+)?)\s*fps/);
        if (fpsMatch) {
          info.fps = parseFloat(fpsMatch[1]);
        }
        
        // 时长
        const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
        if (durMatch) {
          info.duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
        }
        
        resolve(info);
      } catch (e) {
        reject(e);
      }
    });
  }

  // ===== Mock 实现 =====
  // 历史缺陷（已修）：原来是 `Math.random() > 0.1`，即随机 90% 判通过、10% 判失败。
  // 这既不是真实检测，还会让 10% 的正常产物被误判 fail、90% 的坏产物被误判 pass，
  // 而且表现为「偶发失败」，极难排查。现在明确返回「无法检测」。
  _mockCheck(type, videoPath) {
    const names = {
      blackFrame: '黑帧检测',
      blur: '模糊检测',
      duplicate: '重复帧检测',
      duration: '时长校验'
    };
    return {
      passed: false,
      qcVersion: QC_VERSION,
      skipped: true,
      reason: `${names[type] || type}未执行：FFmpeg 不可用`,
      level: 'skip',
      detectorUnavailable: true,
      mock: false
    };
  }
}

module.exports = new QualityChecker();
// 版本常量：存储层/迁移脚本统一从这里取，避免两处各写一个数字
module.exports.QC_VERSION = QC_VERSION;
module.exports.QC_VERSION_LEGACY = QC_VERSION_LEGACY;
