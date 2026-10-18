// ==========================================
// 流水线总编排 - 把所有模块串起来
// ==========================================

const path = require('path');
const fs = require('fs');
const config = require('../config');
const taskManager = require('./taskManager');
const { createGenerator } = require('./generators');
const qualityChecker = require('./qualityChecker');
const videoProcessor = require('./videoProcessor');
const promptOptimizer = require('./promptOptimizer');
const llmService = require('./services/llmService');

const CLIPS_DIR = path.join(__dirname, '..', 'clips');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// 确保目录存在
[CLIPS_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

class Pipeline {
  constructor() {
    this.runningTasks = new Set();
    // 改动点 6：重建互斥（同一任务的改配乐/重建期间不允许并发）
    this.rebuildingTasks = new Set();
    this.concurrency = config.GENERATION.concurrency;
    this.maxRetries = config.GENERATION.maxRetries;
  }

  // 从拼接步骤继续（用于失败任务恢复）
  async resumeFromClips(taskId) {
    if (this.runningTasks.has(taskId)) {
      return { error: '任务正在运行中' };
    }

    const task = taskManager.getTask(taskId);
    if (!task) {
      return { error: '任务不存在' };
    }

    // 检查是否有成功的片段
    const successClipObjs = task.clips
      .filter(c => c.status === 'success')
      .sort((a, b) => a.index - b.index);
    // §6 片段级配乐：分配了音轨的片段先生成配乐版本再拼接，未分配保持原片段
    const successClips = [];
    for (const c of successClipObjs) {
      const p = await this._getBgmSegmentPath(taskId, c);
      if (p && fs.existsSync(p)) successClips.push(p);
    }

    if (successClips.length === 0) {
      return { error: '没有可用的成功片段，无法继续生成' };
    }

    this.runningTasks.add(taskId);

    // 异步运行从拼接开始的流水线
    this._resumePipeline(taskId, successClips).catch(err => {
      console.error(`恢复流水线错误 ${taskId}:`, err);
      taskManager.updateTaskStatus(taskId, 'failed', { error: err.message });
    }).finally(() => {
      this.runningTasks.delete(taskId);
    });

    return { success: true, taskId, message: `正在使用 ${successClips.length} 个成功片段继续生成` };
  }

  // 重新生成单个失败片段（可带新提示词），成功后自动重拼成片
  async regenerateClip(taskId, index, prompt) {
    if (this.runningTasks.has(taskId)) {
      return { error: '任务正在运行中，请稍后再试' };
    }

    const task = taskManager.getTask(taskId);
    if (!task) {
      return { error: '任务不存在' };
    }

    const clip = task.clips[index];
    if (!clip) {
      return { error: `片段 ${index + 1} 不存在` };
    }
    if (clip.status !== 'failed') {
      return { error: '仅支持重新生成已失败的片段' };
    }

    // 应用用户修改后的提示词（未传则用原提示词重跑）
    taskManager.updateClip(taskId, index, {
      prompt: (prompt && String(prompt).trim()) ? String(prompt).trim() : clip.prompt,
      status: 'pending',
      error: null,
      qcResult: null,
      attempts: 0,
      videoPath: null,
      completedAt: null
    });

    this.runningTasks.add(taskId);

    this._regenerateFlow(taskId, index).catch(err => {
      console.error(`重新生成片段错误 ${taskId}[${index}]:`, err);
      taskManager.updateTaskStatus(taskId, 'failed', { error: err.message });
    }).finally(() => {
      this.runningTasks.delete(taskId);
    });

    return { success: true, taskId, index, message: `正在重新生成片段 ${index + 1}` };
  }

  // 重新生成流程：单片段生成 + 质检 → 全部成功片段重拼成片
  async _regenerateFlow(taskId, index) {
    const task = taskManager.getTask(taskId);
    if (!task) return;

    // 构建生成器（与 startTask 第3步一致）
    const runtimeConfig = task.runtimeConfig || {};
    const genConfig = { failRate: 0.1, genTime: 2000 };
    if (runtimeConfig.apiKey) genConfig.apiKey = runtimeConfig.apiKey;
    if (runtimeConfig.apiBaseUrl) genConfig.baseUrl = runtimeConfig.apiBaseUrl;
    if (runtimeConfig.modelId) genConfig.modelId = runtimeConfig.modelId;
    if (runtimeConfig.klingAccessKey) genConfig.accessKey = runtimeConfig.klingAccessKey;
    if (runtimeConfig.klingSecretKey) genConfig.secretKey = runtimeConfig.klingSecretKey;
    const generator = createGenerator(task.model, genConfig);

    taskManager.recordStepStart(taskId, 'clip_generation');
    taskManager.updateTaskStatus(taskId, 'regenerating', { currentStep: `重新生成片段 ${index + 1}` });
    console.log(`[${taskId}] 重新生成片段 ${index + 1}`);

    await this._processSingleClip(taskId, index, generator);

    // 收集全部成功片段（含刚重生成的），重新拼接成片
    const successClips = [];
    const objs = task.clips.filter(c => c.status === 'success').sort((a, b) => a.index - b.index);
    for (const c of objs) {
      const p = await this._getBgmSegmentPath(taskId, c);
      if (p && fs.existsSync(p)) successClips.push(p);
    }
    if (successClips.length === 0) {
      taskManager.updateTaskStatus(taskId, 'failed', { error: '没有可用的成功片段，无法拼接' });
      return;
    }

    console.log(`[${taskId}] 重新生成完成，使用 ${successClips.length}/${task.totalClips} 个片段重拼成片`);
    await this._resumePipeline(taskId, successClips);
  }

  // 恢复流水线（从第4步拼接开始）
  async _resumePipeline(taskId, successClips) {
    const task = taskManager.getTask(taskId);

    // 标记第3步为 partial（如果之前是 failed）
    if (task.steps && task.steps.clip_generation && task.steps.clip_generation.status === 'failed') {
      taskManager.recordStepComplete(taskId, 'clip_generation', {
        status: 'partial',
        qcResult: 'warn',
        qcDetails: {
          passed: true,
          reason: `部分失败，已跳过失败片段继续生成（成功 ${successClips.length}/${task.totalClips}）`,
          successClips: successClips.length,
          totalClips: task.totalClips
        }
      });
    }

    // ===== 第4步：拼接视频 =====
    taskManager.recordStepStart(taskId, 'concatenation');
    taskManager.updateTaskStatus(taskId, 'concatenating', { currentStep: '视频拼接' });
    console.log(`[${taskId}] 恢复执行 - 步骤4: 视频拼接 + 质检`);

    let concatPath;
    if (successClips.length === 1) {
      concatPath = successClips[0];
      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: 'warn',
        qcDetails: { passed: true, reason: '仅有1个成功片段，跳过拼接' }
      });
    } else {
      concatPath = path.join(OUTPUT_DIR, `${taskId}_concat.mp4`);
      const concatResult = await videoProcessor.concatenate(successClips, concatPath);

      if (!concatResult.success) {
        taskManager.recordStepComplete(taskId, 'concatenation', {
          status: 'failed',
          qcResult: 'fail',
          error: '拼接失败: ' + concatResult.error
        });
        throw new Error('拼接失败: ' + concatResult.error);
      }

      const concatQC = await qualityChecker.checkConcat(concatPath, successClips.length, successClips);
      await this._sleep(300);

      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: concatQC.passed ? 'pass' : concatQC.level,
        qcDetails: concatQC
      });
    }

    // ===== 第5步：无缝循环 =====
    taskManager.recordStepStart(taskId, 'loop_processing');
    taskManager.updateTaskStatus(taskId, 'looping', { currentStep: '无缝循环处理' });
    console.log(`[${taskId}] 恢复执行 - 步骤5: 无缝循环处理`);

    await this._sleep(500);
    const loopPath = path.join(OUTPUT_DIR, `${taskId}_loop.mp4`);
    const loopResult = await videoProcessor.makeSeamlessLoop(concatPath, loopPath, 1);

    const loopQC = await qualityChecker.checkLoop(loopResult.success ? loopPath : concatPath);
    taskManager.recordStepComplete(taskId, 'loop_processing', {
      qcResult: loopQC.passed ? 'pass' : loopQC.level,
      qcDetails: loopQC
    });

    // ===== 第6步：转码 =====
    taskManager.recordStepStart(taskId, 'transcoding');
    taskManager.updateTaskStatus(taskId, 'transcoding', { currentStep: '转码导出' });
    console.log(`[${taskId}] 恢复执行 - 步骤6: 转码导出`);

    await this._sleep(500);
    const finalPath = path.join(OUTPUT_DIR, `${taskId}_final.mp4`);
    const transcodeResult = await videoProcessor.transcode(
      loopResult.success ? loopPath : concatPath,
      finalPath,
      { resolution: task.resolution, fps: 30 }
    );

    if (!transcodeResult.success) {
      taskManager.recordStepComplete(taskId, 'transcoding', {
        status: 'failed',
        qcResult: 'fail',
        error: '转码失败: ' + transcodeResult.error
      });
      throw new Error('转码失败: ' + transcodeResult.error);
    }

    const transcodeQC = await qualityChecker.checkTranscode(finalPath, task.resolution, 30);
    taskManager.recordStepComplete(taskId, 'transcoding', {
      qcResult: transcodeQC.passed ? 'pass' : transcodeQC.level,
      qcDetails: transcodeQC
    });

    // ===== 第7步：最终综合质检 =====
    taskManager.recordStepStart(taskId, 'final_qc');
    console.log(`[${taskId}] 恢复执行 - 步骤7: 最终综合质检`);

    const finalQC = await qualityChecker.checkFinal(finalPath);
    await this._sleep(300);

    taskManager.recordStepComplete(taskId, 'final_qc', {
      qcResult: finalQC.passed ? 'pass' : 'fail',
      qcDetails: finalQC
    });

    // ===== 完成 =====
    const isPartial = successClips.length < task.totalClips;
    // 回写真实时长：避免任务记录与实际文件不一致（同 §四 改动点 5 的缺陷类别）
    const qcDuration = finalQC && finalQC.details && finalQC.details.videoInfo
      ? finalQC.details.videoInfo.duration : null;
    taskManager.updateTaskStatus(taskId, isPartial ? 'partial' : 'completed', {
      currentStep: isPartial ? '部分完成' : '已完成',
      outputPath: finalPath,
      finalQC,
      ...(qcDuration > 0 ? { totalDuration: Math.round(qcDuration * 100) / 100 } : {}),
      error: null
    });

    console.log(`[${taskId}] ${isPartial ? '⚠️ 恢复流水线部分完成' : '🎉 恢复流水线完成'}！输出: ${finalPath}`);
    return { success: true, outputPath: finalPath, partial: isPartial };
  }

  // §6 片段级配乐：为单个片段生成"配乐版视频"（有 trackId 才混，否则返回原片段）
  async _getBgmSegmentPath(taskId, clip) {
    if (!clip.trackId) return clip.videoPath;
    const seg = path.join(OUTPUT_DIR, `${taskId}_bgm_${clip.index + 1}.mp4`);
    const audioMixer = require('./processors/audioMixer');
    // 复用缓存前先校验：历史版本（静音缺陷）可能留下静音缓存，直接复用会把缺陷带进新成片
    if (fs.existsSync(seg)) {
      const v = await audioMixer.validateMixedOutput(seg);
      if (v.ok) return seg;
      console.warn(`[${taskId}] 片段 ${clip.index + 1} 配乐缓存校验未通过(${v.reason})，重新混音`);
      try { fs.unlinkSync(seg); } catch (e) {}
    }
    try {
      const r = await audioMixer.mixBgm(clip.videoPath, seg, { track: clip.trackId });
      return r.success ? seg : clip.videoPath;
    } catch (e) {
      console.error(`[${taskId}] 片段 ${clip.index + 1} 配乐失败，回退原始片段:`, e.message);
      return clip.videoPath;
    }
  }

  // §6 制作后逐段改配乐：更新片段 trackId + 整体重建（只重混改动片段并重拼接，不重新生成视频）
  async reapplyClipAudio(taskId, index, trackId) {
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };

    // 改动点 6：同一任务重建互斥，避免并发重建交叉写同一批 _bgm_N / _concat / _final
    if (this.rebuildingTasks.has(taskId) || this.runningTasks.has(taskId)) {
      return { success: false, error: '该任务正在处理中，请稍后再试' };
    }

    const clip = task.clips.find(c => c.index === index);
    if (!clip) return { success: false, error: '片段不存在' };
    if (clip.status !== 'success') return { success: false, error: '片段未成功生成(videoPath 不存在)，暂不可配乐' };
    if (trackId) {
      const audioMixer = require('./processors/audioMixer');
      if (task.runningClips && task.runningClips[index]) return { success: false, error: '片段正在生成中，请稍后再改' };
      if (!audioMixer.getTrackById(trackId)) return { success: false, error: '音轨不存在: ' + trackId };
    }

    this.rebuildingTasks.add(taskId);
    try {
      taskManager.updateClip(taskId, index, { trackId: trackId || null });
      const seg = path.join(OUTPUT_DIR, `${taskId}_bgm_${index + 1}.mp4`);
      if (fs.existsSync(seg)) { try { fs.unlinkSync(seg); } catch (e) {} }
      return await this._rebuildAfterBgmChange(taskId);
    } finally {
      this.rebuildingTasks.delete(taskId);
    }
  }

  // 重建：按当前各片段 trackId 重新混音并拼接转码出片，不动视频片段本身
  // 改动点 3/5：拼接连检 + 失败不覆盖原成片（先写临时文件、全部通过再原子替换）+ 回写真实时长
  async _rebuildAfterBgmChange(taskId) {
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };
    const success = task.clips.filter(c => c.status === 'success').sort((a, b) => a.index - b.index);
    if (success.length === 0) return { success: false, error: '无成功片段可重建' };
    const paths = [];
    for (const c of success) {
      const p = await this._getBgmSegmentPath(taskId, c);
      if (p && fs.existsSync(p)) paths.push(p);
    }
    if (paths.length === 0) return { success: false, error: '无可用片段' };

    const finalPath = path.join(OUTPUT_DIR, `${taskId}_final.mp4`);
    const tmpPath = path.join(OUTPUT_DIR, `${taskId}_final.rebuild.mp4`);
    const prevStatus = task.status;
    taskManager.updateTaskStatus(taskId, 'processing', { currentStep: '重新拼接配乐版本' });
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}

    try {
      let concatPath;
      if (paths.length === 1) {
        concatPath = paths[0];
      } else {
        concatPath = path.join(OUTPUT_DIR, `${taskId}_concat.mp4`);
        const r = await videoProcessor.concatenate(paths, concatPath);
        if (!r.success) throw new Error('重新拼接失败: ' + r.error);
        // 与主流程一致的拼接质检，不通过即中止（此时尚未触碰 final）
        const concatQC = await qualityChecker.checkConcat(concatPath, paths.length, paths);
        if (!concatQC.passed) throw new Error('拼接质检未通过: ' + concatQC.reason);
      }

      // 先写临时文件，全部校验通过后再替换 final，避免失败时破坏用户成片
      const tr = await videoProcessor.transcode(concatPath, tmpPath, { resolution: task.resolution, fps: 30 });
      if (!tr.success) throw new Error('重新转码失败: ' + tr.error);

      if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 10240) {
        throw new Error('重建产物异常（文件缺失或过小）');
      }
      const info = videoProcessor.getVideoInfo(tmpPath);
      if (!info.success || !(info.duration > 0)) {
        throw new Error('无法读取重建产物时长');
      }

      // 全部校验通过 → 原子替换原成片
      fs.renameSync(tmpPath, finalPath);

      // 改动点 5：回写真实时长（此前只写 outputPath，导致记录 35s 而文件 14s）
      taskManager.updateTaskStatus(taskId, 'completed', {
        outputPath: finalPath,
        totalDuration: Math.round(info.duration * 100) / 100,
        currentStep: '已完成',
        error: null
      });

      // 最终质检（含 P1 音量检测）
      try {
        const finalQC = await qualityChecker.checkFinal(finalPath);
        taskManager.updateTaskStatus(taskId, 'completed', { finalQC });
      } catch (qe) {
        console.error(`[${taskId}] 重建后最终质检异常:`, qe.message);
      }

      return { success: true, outputPath: finalPath, duration: info.duration };
    } catch (e) {
      // 失败：清理临时文件，保留原成片，回退任务状态
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      taskManager.updateTaskStatus(taskId, prevStatus || 'completed', {
        currentStep: '重建失败（已保留原成片）',
        error: '重建失败: ' + e.message
      });
      return { success: false, error: e.message };
    }
  }

  // 启动整个流水线
  async startTask(taskId, options = {}) {
    if (this.runningTasks.has(taskId)) {
      return { error: '任务已经在运行中' };
    }

    const task = taskManager.getTask(taskId);
    if (!task) {
      return { error: '任务不存在' };
    }

    this.runningTasks.add(taskId);

    // 异步运行，不阻塞
    this._runPipeline(taskId, options).catch(err => {
      console.error(`流水线错误 ${taskId}:`, err);
      // 标记当前步骤失败
      const currentStepKey = task.currentStepKey;
      if (currentStepKey) {
        taskManager.recordStepComplete(taskId, currentStepKey, {
          status: 'failed',
          error: err.message
        });
      }
      taskManager.updateTaskStatus(taskId, 'failed', { error: err.message });
    }).finally(() => {
      this.runningTasks.delete(taskId);
    });

    return { success: true, taskId, message: '任务已启动' };
  }

  // 主流水线
  async _runPipeline(taskId, options) {
    const task = taskManager.getTask(taskId);

    // ===== 第1步：提示词优化 + 提示词质检 =====
    taskManager.recordStepStart(taskId, 'prompt_optimize');
    console.log(`[${taskId}] 步骤1: 提示词优化 + 质检`);

    // 多提示词模式（§10B）：遍历 clips 按各自主题逐行优化，结果写回 clips[i].prompt
    if (task.isMultiPrompt && task.clips.length > 0) {
      const llmCfg = task.runtimeConfig || {};
      let worstQC = { passed: true };
      for (const clip of task.clips) {
        const theme = clip.theme ?? task.theme;
        const optResult = (llmCfg.llmApiKey)
          ? await promptOptimizer.optimizeWithAI(clip.prompt, theme, {
              apiKey: llmCfg.llmApiKey,
              baseUrl: llmCfg.llmBaseUrl,
              model: llmCfg.llmModel
            })
          : promptOptimizer.optimizeWithTemplate(clip.prompt, theme, { seed: clip.index });

        taskManager.updateClip(taskId, clip.index, { prompt: optResult.optimized });
        const qc = qualityChecker.checkPrompt(optResult.optimized, theme);
        if (!qc.passed) worstQC = qc;
        console.log(`[${taskId}] 片段 ${clip.index + 1} 按主题「${optResult.theme}」优化完成`);
      }
      // 逐行优化模式下不设置单条 optimizedPrompt，QC 取所有行中最差结果
      const promptQC = worstQC.passed ? { passed: true, level: 'pass' } : worstQC;
      await this._sleep(500);
      taskManager.recordStepComplete(taskId, 'prompt_optimize', {
        qcResult: promptQC.passed ? 'pass' : promptQC.level,
        qcDetails: promptQC
      });
    } else {
      // 单提示词模式（第三批 §4.2）：逐片段按 seed 差异化结构化，保证同主题多片段提示词各异
      let worstQC = { passed: true };
      for (let i = 0; i < task.clips.length; i++) {
        const optResult = promptOptimizer.optimizeWithTemplate(task.prompt, task.theme, { seed: i });
        taskManager.updateClip(taskId, i, { prompt: optResult.optimized });
        const qc = qualityChecker.checkPrompt(optResult.optimized, task.theme);
        if (!qc.passed) worstQC = qc;
      }
      // 摘要字段取第 1 段结果（详情展示用），不覆盖已写回的各片段
      taskManager.setOptimizedPrompt(taskId, task.clips[0] ? task.clips[0].prompt : '', { skipClipOverwrite: true });

      const promptQC = worstQC.passed ? { passed: true, level: 'pass' } : worstQC;
      await this._sleep(500);

      taskManager.recordStepComplete(taskId, 'prompt_optimize', {
        qcResult: promptQC.passed ? 'pass' : promptQC.level,
        qcDetails: promptQC
      });
    }

    // ===== 第2步：分镜头生成 + 分镜头质检 =====
    taskManager.recordStepStart(taskId, 'storyboard');
    console.log(`[${taskId}] 步骤2: 分镜头生成 + 质检`);

    let storyboardDegraded = false;
    if (task.isMultiPrompt) {
      // 多提示词模式（§10B）：用户已逐行给出场景，真分镜不得覆盖，仅做质检
      await this._sleep(300);
      console.log(`[${taskId}] 多提示词模式：保留用户逐行场景，跳过 LLM 分镜`);
    } else {
      // 单提示词模式：LLM 真分镜把主题拆成 N 段差异化场景，写回 clips[i].prompt
      const llmCfg = task.runtimeConfig || {};
      const scenes = await llmService.storyboard(task.prompt, task.totalClips, {
        apiKey: llmCfg.llmApiKey,
        baseUrl: llmCfg.llmBaseUrl,
        model: llmCfg.llmModel
      });
      if (scenes && scenes.length > 0) {
        // §4.5 方案 A：LLM 负责差异化场景内容，模板负责结构化（运镜/光影/氛围/结尾）
        for (const s of scenes) {
          const structured = promptOptimizer.optimizeWithTemplate(s.prompt, task.theme, { seed: s.index });
          taskManager.updateClip(taskId, s.index, { prompt: structured.optimized });
        }
        console.log(`[${taskId}] LLM 真分镜生成 ${scenes.length} 段差异化场景，已套模板结构化`);
      } else {
        // 无 Key 或分镜失败：沿用步骤1的模板分镜结果，不报错、不阻塞
        storyboardDegraded = true;
        console.log(`[${taskId}] LLM 未配置或分镜失败，沿用模板分镜（步骤1结果）`);
      }
      await this._sleep(500);
    }

    // 分镜头质检
    const storyboardQC = qualityChecker.checkStoryboard(task.clips, task.totalClips);
    if (storyboardDegraded) {
      // 降级仅作为信息标记，不改变质检结论，避免污染状态机
      storyboardQC.degraded = true;
      storyboardQC.degradeReason = 'LLM 未配置或分镜失败，已降级模板分镜';
    }

    taskManager.recordStepComplete(taskId, 'storyboard', {
      qcResult: storyboardQC.passed ? 'pass' : storyboardQC.level,
      qcDetails: storyboardQC
    });

    // ===== 第3步：批量生成片段 + 片段质检 =====
    taskManager.recordStepStart(taskId, 'clip_generation');
    taskManager.updateTaskStatus(taskId, 'generating', { currentStep: '视频片段生成' });
    console.log(`[${taskId}] 步骤3: 批量生成 ${task.totalClips} 个片段 + 片段质检`);

    const runtimeConfig = task.runtimeConfig || {};
    const genConfig = { failRate: 0.1, genTime: 2000 };
    if (runtimeConfig.apiKey) genConfig.apiKey = runtimeConfig.apiKey;
    if (runtimeConfig.apiBaseUrl) genConfig.baseUrl = runtimeConfig.apiBaseUrl;
    if (runtimeConfig.modelId) genConfig.modelId = runtimeConfig.modelId;
    // 可灵官方 API 使用 JWT 鉴权，需要 AccessKey + SecretKey 双字段
    if (runtimeConfig.klingAccessKey) genConfig.accessKey = runtimeConfig.klingAccessKey;
    if (runtimeConfig.klingSecretKey) genConfig.secretKey = runtimeConfig.klingSecretKey;
    
    const generator = createGenerator(task.model, genConfig);

    await this._batchGenerate(taskId, generator);

    // 检查片段生成结果
    const progress = taskManager.getProgress(taskId);
    const qcPassed = task.clips.filter(c => c.status === 'success').length;
    const clipQCRate = qcPassed / task.totalClips;
    const hasPartialSuccess = qcPassed > 0 && qcPassed < task.totalClips;

    if (qcPassed === 0) {
      // 全部失败，无法继续
      taskManager.recordStepComplete(taskId, 'clip_generation', {
        status: 'failed',
        qcResult: 'fail',
        error: `所有片段生成失败（0/${task.totalClips}）`
      });
      throw new Error(`所有片段生成失败（0/${task.totalClips}）`);
    }

    // 部分成功也继续执行，标记为 partial
    taskManager.recordStepComplete(taskId, 'clip_generation', {
      status: hasPartialSuccess ? 'partial' : 'completed',
      qcResult: clipQCRate >= 0.9 ? 'pass' : 'warn',
      qcDetails: {
        passed: clipQCRate >= 0.8,
        reason: `片段质检通过率: ${Math.round(clipQCRate * 100)}%${hasPartialSuccess ? '（部分失败，已跳过失败片段继续生成）' : ''}`,
        totalClips: task.totalClips,
        successClips: qcPassed,
        failedClips: progress.failed,
        passRate: clipQCRate
      }
    });

    // ===== 第4步：拼接视频 + 拼接质检 =====
    taskManager.recordStepStart(taskId, 'concatenation');
    taskManager.updateTaskStatus(taskId, 'concatenating', { currentStep: '视频拼接' });
    console.log(`[${taskId}] 步骤4: 视频拼接 + 质检`);

    const successClipObjs = task.clips
      .filter(c => c.status === 'success')
      .sort((a, b) => a.index - b.index);
    // §6 片段级配乐：分配了音轨的片段先生成配乐版本再拼接，未分配保持原片段
    const successClips = [];
    for (const c of successClipObjs) {
      const p = await this._getBgmSegmentPath(taskId, c);
      if (p && fs.existsSync(p)) successClips.push(p);
    }

    if (successClips.length === 0) {
      taskManager.recordStepComplete(taskId, 'concatenation', {
        status: 'failed',
        qcResult: 'fail',
        error: '没有可用的成功片段'
      });
      throw new Error('没有可用的成功片段');
    }

    let concatPath;
    if (successClips.length === 1) {
      // 只有一个成功片段，跳过拼接直接使用
      concatPath = successClips[0];
      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: 'warn',
        qcDetails: { passed: true, reason: '仅有1个成功片段，跳过拼接' }
      });
    } else {
      concatPath = path.join(OUTPUT_DIR, `${taskId}_concat.mp4`);
      const concatResult = await videoProcessor.concatenate(successClips, concatPath);

      if (!concatResult.success) {
        taskManager.recordStepComplete(taskId, 'concatenation', {
          status: 'failed',
          qcResult: 'fail',
          error: '拼接失败: ' + concatResult.error
        });
        throw new Error('拼接失败: ' + concatResult.error);
      }

      // 拼接质检
      const concatQC = await qualityChecker.checkConcat(concatPath, successClips.length, successClips);
      await this._sleep(300);

      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: concatQC.passed ? 'pass' : concatQC.level,
        qcDetails: concatQC
      });
    }

    // ===== 第5步：无缝循环 + 循环质检 =====
    taskManager.recordStepStart(taskId, 'loop_processing');
    taskManager.updateTaskStatus(taskId, 'looping', { currentStep: '无缝循环处理' });
    console.log(`[${taskId}] 步骤5: 无缝循环处理 + 质检`);

    await this._sleep(500);
    const loopPath = path.join(OUTPUT_DIR, `${taskId}_loop.mp4`);
    const loopResult = await videoProcessor.makeSeamlessLoop(concatPath, loopPath, 1);

    // 循环质检
    const loopQC = await qualityChecker.checkLoop(loopResult.success ? loopPath : concatPath);

    taskManager.recordStepComplete(taskId, 'loop_processing', {
      qcResult: loopQC.passed ? 'pass' : loopQC.level,
      qcDetails: loopQC
    });

    // ===== 第6步：转码 + 转码质检 =====
    taskManager.recordStepStart(taskId, 'transcoding');
    taskManager.updateTaskStatus(taskId, 'transcoding', { currentStep: '转码导出' });
    console.log(`[${taskId}] 步骤6: 转码导出 + 质检`);

    await this._sleep(500);
    const finalPath = path.join(OUTPUT_DIR, `${taskId}_final.mp4`);
    const transcodeResult = await videoProcessor.transcode(
      loopResult.success ? loopPath : concatPath,
      finalPath,
      { resolution: task.resolution, fps: 30 }
    );

    if (!transcodeResult.success) {
      taskManager.recordStepComplete(taskId, 'transcoding', {
        status: 'failed',
        qcResult: 'fail',
        error: '转码失败: ' + transcodeResult.error
      });
      throw new Error('转码失败: ' + transcodeResult.error);
    }

    // 转码质检
    const transcodeQC = await qualityChecker.checkTranscode(finalPath, task.resolution, 30);

    taskManager.recordStepComplete(taskId, 'transcoding', {
      qcResult: transcodeQC.passed ? 'pass' : transcodeQC.level,
      qcDetails: transcodeQC
    });

    // ===== 第7步：最终综合质检 =====
    taskManager.recordStepStart(taskId, 'final_qc');
    console.log(`[${taskId}] 步骤7: 最终综合质检`);

    const finalQC = await qualityChecker.checkFinal(finalPath);
    await this._sleep(300);

    taskManager.recordStepComplete(taskId, 'final_qc', {
      qcResult: finalQC.passed ? 'pass' : 'fail',
      qcDetails: finalQC
    });

    // ===== 完成 =====
    // 如果有部分片段失败，标记为 partial（但仍然是完成状态，可以查看成片）
    const finalProgress = taskManager.getProgress(taskId);
    const isPartial = finalProgress.success < task.totalClips && finalProgress.success > 0;
    // 回写真实时长：避免任务记录与实际文件不一致（同 §四 改动点 5 的缺陷类别）
    const qcDuration = finalQC && finalQC.details && finalQC.details.videoInfo
      ? finalQC.details.videoInfo.duration : null;
    taskManager.updateTaskStatus(taskId, isPartial ? 'partial' : 'completed', {
      currentStep: isPartial ? '部分完成' : '已完成',
      outputPath: finalPath,
      finalQC,
      ...(qcDuration > 0 ? { totalDuration: Math.round(qcDuration * 100) / 100 } : {}),
      error: null
    });

    console.log(`[${taskId}] ${isPartial ? '⚠️ 流水线部分完成' : '🎉 流水线完成'}！输出: ${finalPath}（成功 ${finalProgress.success}/${task.totalClips} 片段）`);
    return { success: true, outputPath: finalPath, partial: isPartial };
  }

  // 批量生成（带并发控制 + 重试 + 质检）
  async _batchGenerate(taskId, generator) {
    const task = taskManager.getTask(taskId);
    if (!task) return; // 任务已删除，直接结束批量生成
    let activeWorkers = 0;
    let currentIndex = 0;
    const total = task.totalClips;

    return new Promise((resolve) => {
      const startWorker = async () => {
        while (currentIndex < total) {
          const index = currentIndex++;
          await this._processSingleClip(taskId, index, generator);

          const prog = taskManager.getProgress(taskId);
          if (!prog) return; // 任务已删除，退出当前 worker
          if (prog.success + prog.failed >= total) {
            break;
          }
        }

        activeWorkers--;
        if (activeWorkers === 0) {
          resolve();
        }
      };

      for (let i = 0; i < Math.min(this.concurrency, total); i++) {
        activeWorkers++;
        startWorker();
      }
    });
  }

  // 处理单个片段（生成 + 质检 + 重试）
  async _processSingleClip(taskId, index, generator) {
    const task = taskManager.getTask(taskId);
    if (!task) return; // 任务已删除，直接退出
    const clip = task.clips[index];

    // 总尝试次数 = 1 + maxRetries（maxRetries=1 表示首次失败后还可重试 1 次）
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        taskManager.updateClip(taskId, index, {
          status: 'generating',
          attempts: attempt
        });

        console.log(`[${taskId}] 片段 ${index + 1}/${task.totalClips} 第${attempt}次生成`);

        // 取片段主题模板的负面词（第三批 §5），随生成请求传给适配器
        const clipTheme = clip.theme || task.theme;
        const clipTemplate = promptOptimizer.getTemplate(clipTheme);
        const genResp = await generator.generate(clip.prompt, {
          duration: task.clipDuration,
          resolution: task.resolution,
          ...(clipTemplate && clipTemplate.negative ? { negative: clipTemplate.negative } : {})
        });
        const genTaskId = genResp.taskId;

        // 可灵 4K 失败自动降档 1080p 时，在片段记录中标注
        if (genResp.downgraded) {
          taskManager.updateClip(taskId, index, {
            downgraded: true,
            downgradeReason: genResp.downgradeReason || '4K 生成失败，已降档 1080p'
          });
          console.log(`[${taskId}] 片段 ${index + 1} ⚠️ 已降档 1080p（4K 失败）`);
        }

        const result = await this._waitForCompletion(generator, genTaskId);

        if (result.status !== 'completed') {
          throw new Error(result.error || '生成失败');
        }

        let videoPath = result.videoUrl;

        if (videoPath && (videoPath.startsWith('http://') || videoPath.startsWith('https://'))) {
          const localPath = path.join(CLIPS_DIR, `${taskId}_clip_${index + 1}.mp4`);
          console.log(`[${taskId}] 片段 ${index + 1} 下载中...`);
          try {
            const downloadResult = await this._downloadVideo(videoPath, localPath);
            if (downloadResult) {
              videoPath = localPath;
            } else {
              throw new Error('视频下载失败');
            }
          } catch (e) {
            throw new Error('下载失败: ' + e.message);
          }
        }

        taskManager.updateClip(taskId, index, { videoPath });

        // 片段质检（黑帧/模糊/重复/时长）
        console.log(`[${taskId}] 片段 ${index + 1} 质检中...`);
        const qcResult = await qualityChecker.checkClip(videoPath, task.clipDuration);

        // §9B 视觉内容质检（并联：与技术质检任一失败即触发重试；无 Key 时 skipped 不影响）
        // Mock 产出的是合成测试画面（纯色/渐变色），按提示词比对必然不通过，
        // 会让演示模式次次失败，因此 Mock 直接跳过视觉质检。
        const rc = task.runtimeConfig || {};
        const skipVisualQC = task.model === 'mock' || rc.visualQC === false;
        const contentResult = skipVisualQC
          ? { passed: true, skipped: true, reason: '视觉质检跳过: 演示模式（合成画面）', level: 'skip' }
          : await qualityChecker.checkContentMatch(videoPath, clip.prompt, {
              apiKey: rc.multimodalApiKey || rc.llmApiKey,
              baseUrl: rc.multimodalBaseUrl || rc.llmBaseUrl,
              model: rc.multimodalModel || rc.llmModel
            });
        qcResult.details = qcResult.details || {};
        qcResult.details.contentMatch = contentResult;
        if (!contentResult.passed && qcResult.passed) {
          qcResult.passed = false;
          qcResult.reason = `视觉质检失败: ${contentResult.reason}`;
          qcResult.failedCount = (qcResult.failedCount || 0) + 1;
        }
        taskManager.setQCResult(taskId, index, qcResult);

        if (qcResult.passed) {
          taskManager.updateClip(taskId, index, { status: 'success' });
          console.log(`[${taskId}] 片段 ${index + 1} ✅ 成功`);
          return;
        } else {
          console.log(`[${taskId}] 片段 ${index + 1} 质检失败: ${qcResult.reason}`);
          if (attempt > this.maxRetries) {
            taskManager.updateClip(taskId, index, {
              status: 'failed',
              error: '质检未通过: ' + (qcResult.reason || ''),
              attempts: attempt
            });
            return;
          }
          await this._sleep(1000 * attempt);
        }

      } catch (error) {
        console.log(`[${taskId}] 片段 ${index + 1} 生成失败 (第${attempt}次): ${error.message}`);

        // 无剩余重试次数，或错误不可重试（402 余额不足/401 鉴权失败）→ 直接判失败
        if (attempt > this.maxRetries || !generator.canRetry(error)) {
          taskManager.updateClip(taskId, index, {
            status: 'failed',
            error: error.message,
            attempts: attempt
          });
          return;
        }
        await this._sleep(2000 * attempt);
      }
    }

    taskManager.updateClip(taskId, index, {
      status: 'failed',
      error: '重试次数超限'
    });
  }

  // 轮询等待生成完成
  async _waitForCompletion(generator, genTaskId, maxWait = 300000) {
    const startTime = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startTime < maxWait) {
      const status = await generator.getStatus(genTaskId);

      if (status.status === 'completed' || status.status === 'failed') {
        return status;
      }

      await this._sleep(pollInterval);
    }

    return { status: 'failed', error: '超时' };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 下载远程视频到本地
  async _downloadVideo(url, outputPath) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`下载失败: HTTP ${response.status}`);
        return false;
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fs = require('fs');
      const path = require('path');
      
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(outputPath, buffer);
      const stats = fs.statSync(outputPath);
      if (stats.size < 1024) {
        console.error(`下载文件太小: ${stats.size} bytes`);
        return false;
      }
      return true;
    } catch (e) {
      console.error('下载视频异常:', e.message);
      return false;
    }
  }
}

module.exports = new Pipeline();
