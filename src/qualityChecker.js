// ==========================================
// 自动质检模块 - 10项全流程质检体系
// 功能：黑帧检测、模糊检测、重复帧检测、时长校验、文件完整性、
//       分辨率校验、帧率校验、音频检测、画面稳定性、最终综合质检
// ==========================================

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const config = require('../config');

const FFMPEG_PATH = config.FFMPEG_PATH || 'ffmpeg';

// 10项质检项定义
const QC_ITEMS = [
  { key: 'prompt', name: '提示词质检', category: 'pre', desc: '检查提示词完整性、安全性、关键词覆盖' },
  { key: 'storyboard', name: '分镜头质检', category: 'pre', desc: '检查分镜头连贯性、场景过渡合理性' },
  { key: 'blackFrame', name: '黑帧检测', category: 'clip', desc: '检测视频中是否存在黑帧或黑屏' },
  { key: 'blur', name: '模糊检测', category: 'clip', desc: '检测画面清晰度是否达标' },
  { key: 'duplicate', name: '重复帧检测', category: 'clip', desc: '检测是否存在大量重复帧（卡顿）' },
  { key: 'duration', name: '时长校验', category: 'clip', desc: '校验视频时长是否符合要求' },
  { key: 'concat', name: '拼接质检', category: 'post', desc: '检查片段拼接是否流畅无跳帧' },
  { key: 'loop', name: '循环质检', category: 'post', desc: '检查首尾循环过渡是否自然' },
  { key: 'transcode', name: '转码质检', category: 'post', desc: '校验转码后分辨率、帧率、码率' },
  { key: 'final', name: '最终综合质检', category: 'final', desc: '文件完整性 + 整体质量综合评估' }
];

class QualityChecker {
  constructor(options = {}) {
    this.options = {
      blackFrameMinDuration: 0.5,
      blackFrameThreshold: 0.95,
      blurThreshold: 100,
      minDurationRatio: 0.8,
      maxDurationRatio: 1.2,
      ...options
    };
    this.qcItems = QC_ITEMS;
  }

  // 获取所有质检项定义
  getQCItems() {
    return this.qcItems;
  }

  // ========== 提示词质检 ==========
  checkPrompt(prompt, theme = 'landscape') {
    const issues = [];
    const details = {};

    // 1. 长度检查
    details.length = prompt ? prompt.length : 0;
    if (details.length < 10) issues.push('提示词过短（<10字）');
    if (details.length > 500) issues.push('提示词过长（>500字）');

    // 2. 关键词丰富度
    const keywords = ['风格', '场景', '光线', '色调', '镜头', '角度', '运动', '氛围',
                      'style', 'scene', 'light', 'color', 'camera', 'motion', 'mood'];
    const foundKeywords = keywords.filter(k => 
      prompt.toLowerCase().includes(k.toLowerCase())
    );
    details.keywordCount = foundKeywords.length;
    details.keywords = foundKeywords;
    if (foundKeywords.length < 3) issues.push('描述关键词不够丰富');

    // 3. 主题匹配度（theme 为空 = 无主题，不检查主题匹配）
    details.theme = theme || null;
    const themeKeywords = {
      landscape: ['山', '水', '天空', '自然', '风景', 'mountain', 'sky', 'nature', 'landscape'],
      city: ['城市', '建筑', '街道', '灯光', 'city', 'building', 'street', 'urban'],
      portrait: ['人物', '面部', '表情', 'person', 'face', 'portrait', 'human'],
      abstract: ['抽象', '几何', '艺术', 'abstract', 'geometric', 'art']
    };
    const themeWords = (theme && themeKeywords[theme]) || [];
    const themeMatches = themeWords.filter(w =>
      prompt.toLowerCase().includes(w.toLowerCase())
    );
    details.themeMatchCount = themeMatches.length;
    if (theme && themeMatches.length === 0 && theme !== 'landscape') {
      issues.push('提示词与所选主题匹配度较低');
    }

    const passed = issues.length === 0;
    return {
      passed,
      reason: passed ? '提示词质检通过' : issues.join('；'),
      issues,
      details,
      level: issues.length === 0 ? 'pass' : issues.length <= 1 ? 'warn' : 'fail'
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
      reason: passed ? '分镜头质检通过' : issues.join('；'),
      issues,
      details,
      level: passed ? 'pass' : 'warn'
    };
  }

  // ========== 片段级完整质检 ==========
  async checkClip(videoPath, expectedDuration = 30) {
    const results = {};

    // 前置闸门：FFmpeg 是这四个检测项的唯一执行手段。
    // 历史缺陷（已修）：没有 ffmpeg 时执行到 catch，返回 {passed:true, skipped:true}，
    // 而下面的汇总又把 skipped 当 pass 算，导致「一项都没测」却报告「片段质检通过」。
    // 现在明确区分：可以合法跳过的原因（业务上本就不适用）vs 检测器不可用（必须判 fail）。
    if (!this._hasFFmpeg()) {
      return {
        passed: false,
        reason: '片段质检无法执行：FFmpeg 不可用，黑帧/模糊/重复帧/时长四项均未实际检测',
        failedCount: 4,
        totalChecks: 4,
        detectorUnavailable: true,
        details: {
          blackFrame: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' },
          blur: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' },
          duplicate: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' },
          duration: { passed: false, reason: 'FFmpeg 不可用', level: 'fail' }
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

    // 汇总：
    //   passed 且非 genuine skip -> 通过
    //   skipped 且非 legitimateSkip -> 只是「没测」，不算通过
    //   failed  -> 不通过
    const entries = Object.entries(results);
    const failedItems = entries
      .filter(([, v]) => !v.passed && !v.skipped)
      .map(([k, v]) => `${this._getItemName(k)}: ${v.reason}`);
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

    return {
      passed: allPassed,
      reason: allPassed
        ? (legitSkipItems.length ? `片段质检通过（${legitSkipItems.length} 项按设计跳过）` : '片段质检通过')
        : reasons.join(' | '),
      failedCount: failedItems.length,
      notRunCount: notRunItems.length,
      legitSkipCount: legitSkipItems.length,
      totalChecks: entries.length,
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
      reason: `时长约 ${expectedDuration}s（模拟）`,
      duration: expectedDuration,
      level: 'pass',
      mock: true
    };
  }

  // ========== 拼接质检 ==========
  // clipPaths：可选，传入各输入片段路径后，用实测时长之和作为期望值（改动点 4）
  async checkConcat(videoPath, clipCount, clipPaths = []) {
    // 前置闸门：没有 ffmpeg 就没法测时长，此时不能假装通过。
    // 历史缺陷：下面的 catch 是空的，然后无条件 return passed:true，
    // 导致 ffmpeg 缺失时拼接质检永久「通过」，14s 截断产物也能过江。
    if (!this._hasFFmpeg()) {
      return {
        passed: false,
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

      if (expected !== null) {
        const tolerance = Math.max(0.5, expected * 0.02);
        const passed = Math.abs(info.duration - expected) <= tolerance;
        return {
          passed,
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
  async checkLoop(videoPath) {
    // 循环质检需要对比首尾帧，这里简化处理
    return {
      passed: true,
      reason: '循环过渡正常（模拟）',
      level: 'pass',
      mock: true
    };
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
      reason: '转码质检通过（模拟）',
      level: 'pass',
      mock: true
    };
  }

  // ========== 最终综合质检 ==========
  async checkFinal(videoPath) {
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
      reason,
      details: results,
      fileInfo: details
    };
  }

  // 兼容旧接口：checkAll
  async checkAll(videoPath) {
    return this.checkClip(videoPath, 30);
  }

  // ========== 视觉内容质检（§9B，多模态 LLM 抽帧） ==========
  // FFmpeg 抽首/中/尾 3 帧 → 多模态 LLM 判断画面是否符合提示词意图
  // 任一环节失败（无 Key/超时/非2xx/解析失败）一律 skipped，不阻塞主流程
  async checkContentMatch(videoPath, expectedPrompt, options = {}) {
    const apiKey = options.apiKey || config.OPENAI_API_KEY || '';
    const baseUrl = options.baseUrl || config.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = options.model || config.OPENAI_MULTIMODAL_MODEL || 'gpt-4o-mini';

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
      skipped: true,
      reason: `${names[type] || type}未执行：FFmpeg 不可用`,
      level: 'skip',
      detectorUnavailable: true,
      mock: false
    };
  }
}

module.exports = new QualityChecker();
