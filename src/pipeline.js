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

const CLIPS_DIR = path.join(__dirname, '..', 'clips');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// 确保目录存在
[CLIPS_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

class Pipeline {
  constructor() {
    this.runningTasks = new Set();
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
    const successClips = task.clips
      .filter(c => c.status === 'success')
      .sort((a, b) => a.index - b.index)
      .map(c => c.videoPath)
      .filter(p => p && fs.existsSync(p));

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

      const concatQC = await qualityChecker.checkConcat(concatPath, successClips.length);
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
    taskManager.updateTaskStatus(taskId, isPartial ? 'partial' : 'completed', {
      currentStep: isPartial ? '部分完成' : '已完成',
      outputPath: finalPath,
      finalQC,
      error: null
    });

    console.log(`[${taskId}] ${isPartial ? '⚠️ 恢复流水线部分完成' : '🎉 恢复流水线完成'}！输出: ${finalPath}`);
    return { success: true, outputPath: finalPath, partial: isPartial };
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

    const optResult = promptOptimizer.optimizeWithTemplate(
      task.prompt,
      task.theme
    );
    taskManager.setOptimizedPrompt(taskId, optResult.optimized);

    // 提示词质检
    const promptQC = qualityChecker.checkPrompt(optResult.optimized, task.theme);
    await this._sleep(500);

    taskManager.recordStepComplete(taskId, 'prompt_optimize', {
      qcResult: promptQC.passed ? 'pass' : promptQC.level,
      qcDetails: promptQC
    });

    // ===== 第2步：分镜头生成 + 分镜头质检 =====
    taskManager.recordStepStart(taskId, 'storyboard');
    console.log(`[${taskId}] 步骤2: 分镜头生成 + 质检`);

    await this._sleep(800); // 模拟分镜头生成

    // 分镜头质检
    const storyboardQC = qualityChecker.checkStoryboard(task.clips, task.totalClips);

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

    const successClips = task.clips
      .filter(c => c.status === 'success')
      .sort((a, b) => a.index - b.index)
      .map(c => c.videoPath)
      .filter(p => p && fs.existsSync(p));

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
      const concatQC = await qualityChecker.checkConcat(concatPath, successClips.length);
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
    taskManager.updateTaskStatus(taskId, isPartial ? 'partial' : 'completed', {
      currentStep: isPartial ? '部分完成' : '已完成',
      outputPath: finalPath,
      finalQC,
      error: null
    });

    console.log(`[${taskId}] ${isPartial ? '⚠️ 流水线部分完成' : '🎉 流水线完成'}！输出: ${finalPath}（成功 ${finalProgress.success}/${task.totalClips} 片段）`);
    return { success: true, outputPath: finalPath, partial: isPartial };
  }

  // 批量生成（带并发控制 + 重试 + 质检）
  async _batchGenerate(taskId, generator) {
    const task = taskManager.getTask(taskId);
    let activeWorkers = 0;
    let currentIndex = 0;
    const total = task.totalClips;

    return new Promise((resolve) => {
      const startWorker = async () => {
        while (currentIndex < total) {
          const index = currentIndex++;
          await this._processSingleClip(taskId, index, generator);

          const prog = taskManager.getProgress(taskId);
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
    const clip = task.clips[index];

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        taskManager.updateClip(taskId, index, {
          status: 'generating',
          attempts: attempt
        });

        console.log(`[${taskId}] 片段 ${index + 1}/${task.totalClips} 第${attempt}次生成`);

        const { taskId: genTaskId } = await generator.generate(clip.prompt, {
          duration: task.clipDuration,
          resolution: task.resolution
        });

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
        taskManager.setQCResult(taskId, index, qcResult);

        if (qcResult.passed) {
          taskManager.updateClip(taskId, index, { status: 'success' });
          console.log(`[${taskId}] 片段 ${index + 1} ✅ 成功`);
          return;
        } else {
          console.log(`[${taskId}] 片段 ${index + 1} 质检失败: ${qcResult.reason}`);
          if (attempt < this.maxRetries) {
            await this._sleep(1000 * attempt);
          }
        }

      } catch (error) {
        console.log(`[${taskId}] 片段 ${index + 1} 生成失败 (第${attempt}次): ${error.message}`);

        if (attempt < this.maxRetries && generator.canRetry(error)) {
          await this._sleep(2000 * attempt);
        } else if (attempt === this.maxRetries) {
          taskManager.updateClip(taskId, index, {
            status: 'failed',
            error: error.message,
            attempts: attempt
          });
          return;
        }
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
