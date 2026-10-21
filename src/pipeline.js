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
const transitionMixer = require('./processors/transitionMixer');
const promptOptimizer = require('./promptOptimizer');
const { resolveResume } = require('./pipelineStages');
const llmService = require('./services/llmService');
const pricing = require('./pricing');
const library = require('./library');

const CLIPS_DIR = path.join(__dirname, '..', 'clips');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// 确保目录存在
[CLIPS_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

class Pipeline {
  constructor() {
    this.runningTasks = new Set();
    // 暂停中的任务：worker 在「取下一个片段之前」检查此集合，命中则原地等待
    this.pausedTasks = new Set();
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
    // 片段级配乐已下线：这里直接使用原始片段拼接，配乐在整片阶段统一混入
    const successClips = successClipObjs
      .map(c => this._resolveClipPath(c.videoPath))
      .filter(Boolean);

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
      this.pausedTasks.delete(taskId);  // 任务结束，清掉暂停标记
    });

    return { success: true, taskId, message: `正在使用 ${successClips.length} 个成功片段继续生成` };
  }

  // 重新生成单个失败片段（可带新提示词），成功后自动重拼成片
  async regenerateClip(taskId, index, prompt, runtimeConfig) {
    if (this.runningTasks.has(taskId)) {
      return { error: '任务正在运行中，请稍后再试' };
    }

    const task = taskManager.getTask(taskId);
    if (!task) {
      return { error: '任务不存在' };
    }

    // 旧任务的 runtimeConfig 在落盘时被脱敏（Key 清空），服务重启后拿不到 Key。
    // 前端把当前设置随请求带上，这里合并回内存态，避免静默降级 Mock / NSFW 必失败。
    if (runtimeConfig) {
      this._mergeRuntimeConfig(task, runtimeConfig);
      taskManager.updateTaskStatus(taskId, task.status, { runtimeConfig: task.runtimeConfig });
    }

    const clip = task.clips[index];
    if (!clip) {
      return { error: `片段 ${index + 1} 不存在` };
    }
    if (clip.status !== 'failed') {
      return { error: '仅支持重新生成已失败的片段' };
    }

    // 旧文件可能是有价值的上一次产物（例如付费片段只是质检没过）：
    // 不能只把 videoPath 清空就丢引用，记下路径便于事后找回。
    const previousVideoPath = clip.videoPath || null;

    // 应用用户修改后的提示词（未传则用原提示词重跑）
    taskManager.updateClip(taskId, index, {
      prompt: (prompt && String(prompt).trim()) ? String(prompt).trim() : clip.prompt,
      status: 'pending',
      error: null,
      qcResult: null,
      attempts: 0,
      videoPath: null,
      previousVideoPath,
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
    this._markMockFallback(taskId, task, generator);

    taskManager.recordStepStart(taskId, 'clip_generation');
    taskManager.updateTaskStatus(taskId, 'regenerating', { currentStep: `重新生成片段 ${index + 1}` });
    console.log(`[${taskId}] 重新生成片段 ${index + 1}`);

    await this._processSingleClip(taskId, index, generator);

    // 收集全部成功片段（含刚重生成的），重新拼接成片（配乐在整片阶段统一混入）
    const successClips = task.clips
      .filter(c => c.status === 'success')
      .sort((a, b) => a.index - b.index)
      .map(c => this._resolveClipPath(c.videoPath))
      .filter(Boolean);
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
      // ⚠️ 区分两种情况，不能都写成「跳过拼接、passed:true」：
      //   A) 任务本来就只要 1 个片段 → 正常，warn
      //   B) 任务要 2 个片段但只剩 1 个成功 → **片段丢失**，必须判 fail 并写明
      // 实测事故（2026-10-20）：2 片段任务丢了一个，这里静默记 passed:true，
      // 于是用户毫无察觉，直到看到成片只有一半、或前端某一路径黑屏。
      const expectedClips = task.totalClips || (task.clips || []).length;
      const lostClips = Math.max(0, expectedClips - successClips.length);
      const clipLost = lostClips > 0;
      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: clipLost ? 'fail' : 'warn',
        qcDetails: {
          passed: !clipLost,
          level: clipLost ? 'fail' : 'warn',
          reason: clipLost
            ? `片段缺失：应有 ${expectedClips} 个，实际成功 ${successClips.length} 个（丢失 ${lostClips} 个），`
              + '成片只由剩余片段组成，请检查生成与下载是否异常'
            : '任务只有 1 个片段，无需拼接',
          expectedClips,
          successClips: successClips.length,
          lostClips
        }
      });
      if (clipLost) {
        console.error(`[${taskId}] ⚠️ 片段缺失：应有 ${expectedClips} 个，实际 ${successClips.length} 个`);
      }
    } else {
      concatPath = path.join(OUTPUT_DIR, `${taskId}_concat.mp4`);
      const trans = this._transitionOptions(task);
      const concatResult = trans.enabled
        ? await transitionMixer.concatWithTransitions(successClips, concatPath, {
          duration: trans.duration,
          type: trans.type,
          resolution: task.resolution,
          fps: 30
        })
        : await videoProcessor.concatenate(successClips, concatPath);

      if (!concatResult.success) {
        taskManager.recordStepComplete(taskId, 'concatenation', {
          status: 'failed',
          qcResult: 'fail',
          error: '拼接失败: ' + concatResult.error
        });
        throw new Error('拼接失败: ' + concatResult.error);
      }

      const concatQC = await qualityChecker.checkConcat(concatPath, successClips.length, successClips, {
        expectedDuration: concatResult.expectedDuration
      });
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
    // 淡化时长取自配置（默认 0.5s）。新建路径与改配乐重建路径必须用同一个值，
    // 否则会出现「新建 34.5s / 重建 35s」的时长不一致。
    const loopFade = config.QC && Number.isFinite(Number(config.QC.loopFadeDuration))
      ? Number(config.QC.loopFadeDuration)
      : 0.5;
    const loopResult = await videoProcessor.makeSeamlessLoop(concatPath, loopPath, loopFade);

    // 循环质检需要源时长与淡化时长，才能核验「成片 = 源 - 淡化」这一结构性证据
    const concatInfo = videoProcessor.getVideoInfo(concatPath);
    const loopQC = await qualityChecker.checkLoop(
      loopResult.success ? loopPath : concatPath,
      {
        sourcePath: concatPath,
        sourceDuration: concatInfo.success ? concatInfo.duration : null,
        fadeDuration: loopResult.fadeDuration !== undefined ? loopResult.fadeDuration : loopFade,
        threshold: config.QC ? config.QC.loopSsimThreshold : undefined
      }
    );
    taskManager.recordStepComplete(taskId, 'loop_processing', {
      qcResult: loopQC.passed ? 'pass' : loopQC.level,
      qcDetails: {
        ...loopQC,
        loopProcess: {
          success: loopResult.success,
          reencoded: !!loopResult.reencoded,
          fadeDuration: loopResult.fadeDuration,
          sourceDuration: loopResult.sourceDuration,
          outputDuration: loopResult.outputDuration,
          error: loopResult.error
        }
      }
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

    const finalQC = await qualityChecker.checkFinal(finalPath, this._finalQcOptions(taskManager.getTask(taskId)));
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

  // ===== 整片配乐（2026-10-19 改造）=====
  // 背景：旧实现是「每个片段各混一段 2 秒循环」，导致同一段材料在每段里重复播放。
  // 现改为「整片只混一次」：先在时间轴上把轻音乐/环境音排好（plan），再一次性混合。
  // 预览与导出共用 mixBgmPlan，因此听到的与导出的是同一引擎产生，天然一致。

  // 为任务准备配乐计划：已有 plan 直接用；没有则按自动配乐规则生成
  async _ensureBgmPlan(taskId, task, opts = {}) {
    const audioMixer = require('./processors/audioMixer');
    const videoDuration = Number(task.totalDuration) > 0 ? Number(task.totalDuration) : null;

    if (task.bgmPlan && Array.isArray(task.bgmPlan.music) && task.bgmPlan.music.length > 0) {
      return { ok: true, plan: task.bgmPlan, source: 'manual' };
    }
    const bgm = task.bgm || {};
    if (!bgm.enabled) {
      // scope=edit 表示这是用户在「添加配乐」页面主动要配乐，
      // 此时"未启用"不应该是静默空计划，而应给出可执行的计划（默认按自动配乐生成）。
      if (opts && opts.force) {
        // 继续往下走自动配乐分支
      } else {
        return { ok: true, plan: null, source: 'disabled' };
      }
    }

    // 自动配乐：需要成片时长；未知时先用片段数×单段时长估算
    const dur = videoDuration || (task.totalClips || 0) * (task.clipDuration || 15);
    if (!(dur > 0)) return { ok: false, error: '无法确定成片时长，无法自动配乐' };

    const prefs = audioMixer.getPrefs();
    const auto = audioMixer.buildAutoPlan(dur, {
      // 勾选组合来源于创建任务时的选择；历史任务没有这些字段时默认只开轻音乐
      wantMusic: bgm.wantMusic === undefined ? true : !!bgm.wantMusic,
      wantAmbient: !!bgm.wantAmbient,
      ambientTrackId: bgm.ambientTrackId || null,
      order: prefs.order,
      defaultTrackId: bgm.trackId || prefs.defaultTrackId,
      fadeInSec: bgm.fadeInSec,
      fadeOutSec: bgm.fadeOutSec,
      crossfadeSec: bgm.crossfadeSec
    });
    if (!auto.ok) return { ok: false, error: auto.error };
    // 草稿模式（编辑页初始填充）不落库，避免用户没保存却改动了计划
    if (!(opts && opts.force && !(task.bgm && task.bgm.enabled))) {
      taskManager.updateTaskStatus(taskId, task.status, { bgmPlan: auto.plan });
    }
    return { ok: true, plan: auto.plan, source: 'auto', warnings: auto.warnings };
  }

  // 执行整片混音：输入无声母版，输出带配乐成片
  // 失败不阻塞出片（保持无配乐版本），并把原因写进 bgmResult 供前端展示
  async _applyBgmPlan(taskId, inputVideo, outputPath, task) {
    const audioMixer = require('./processors/audioMixer');
    try {
      const prep = await this._ensureBgmPlan(taskId, task);
      if (!prep.ok) {
        taskManager.updateTaskStatus(taskId, task.status, {
          bgmResult: { applied: false, error: prep.error, at: new Date().toISOString() }
        });
        return { success: false, error: prep.error, skipped: true };
      }
      if (!prep.plan) {
        return { success: false, skipped: true, reason: '未启用配乐' };
      }
      const r = await audioMixer.mixBgmPlan(inputVideo, outputPath, prep.plan, {
        loudness: (task.bgm && task.bgm.volume) || -20,
        ambientVolume: (task.bgm && task.bgm.ambientVolume) || 0.125
      });
      taskManager.updateTaskStatus(taskId, task.status, {
        bgmResult: {
          applied: !!r.success,
          source: prep.source,
          error: r.success ? null : r.error,
          warnings: (prep.warnings || []).concat(r.warnings || []),
          segments: r.segments || 0,
          meanVolumeDb: r.meanVolumeDb || null,
          at: new Date().toISOString()
        }
      });
      return r;
    } catch (e) {
      taskManager.updateTaskStatus(taskId, task.status, {
        bgmResult: { applied: false, error: e.message, at: new Date().toISOString() }
      });
      return { success: false, error: e.message };
    }
  }

  // 制作后改配乐：保存新 plan → 从无声母版重新混音 → 原子替换成片
  // 关键约束：先写临时文件，全部校验通过才替换；失败保留原成片。
  async reapplyBgm(taskId, plan, options = {}) {
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (this.rebuildingTasks.has(taskId) || this.runningTasks.has(taskId)) {
      return { success: false, error: '该任务正在处理中，请稍后再试' };
    }
    const master = path.join(OUTPUT_DIR, `${taskId}_master.mp4`);
    const finalPath = path.join(OUTPUT_DIR, `${taskId}_final.mp4`);
    if (!fs.existsSync(master) && !fs.existsSync(finalPath)) {
      return { success: false, error: '找不到可用的成片母版' };
    }
    // 母版是无声基准；历史任务没有母版时，先把它自己的无声片段重新拼一份
    if (!fs.existsSync(master)) {
      const built = await this._buildMasterFromClips(taskId, task);
      if (!built.success) return { success: false, error: built.error };
    }

    this.rebuildingTasks.add(taskId);
    const prevStatus = task.status;
    const tmpPath = path.join(OUTPUT_DIR, `${taskId}_final.bgm.mp4`);
    try {
      taskManager.updateTaskStatus(taskId, 'processing', { currentStep: '重新配乐中' });

      // 只保留合法字段，避免把前端多余数据写进库
      const clean = this._normalizePlan(plan, task);
      if (!clean.ok) throw new Error(clean.error);

      taskManager.updateTaskStatus(taskId, 'processing', { bgmPlan: clean.plan });
      const t = taskManager.getTask(taskId);
      const r = await this._applyBgmPlan(taskId, master, tmpPath, t);
      if (!r.success) throw new Error(r.error || '配乐混音失败');

      if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 10240) {
        throw new Error('配乐产物异常（文件缺失或过小）');
      }
      const info = videoProcessor.getVideoInfo(tmpPath);
      if (!info.success || !(info.duration > 0)) throw new Error('无法读取配乐产物时长');

      if (options.dryRun) {
        // 预览模式：不替换成片，保留临时文件供试听
        taskManager.updateTaskStatus(taskId, prevStatus || 'completed', { currentStep: '配乐预览就绪' });
        return { success: true, previewPath: tmpPath, duration: info.duration, dryRun: true };
      }

      fs.renameSync(tmpPath, finalPath);
      taskManager.updateTaskStatus(taskId, 'completed', {
        outputPath: finalPath,
        totalDuration: Math.round(info.duration * 100) / 100,
        currentStep: '已完成',
        error: null
      });
      try {
        const finalQC = await qualityChecker.checkFinal(finalPath, this._finalQcOptions(taskManager.getTask(taskId)));
        taskManager.updateTaskStatus(taskId, 'completed', { finalQC });
      } catch (qe) {
        console.error(`[${taskId}] 配乐后最终质检异常:`, qe.message);
      }
      return { success: true, outputPath: finalPath, duration: info.duration };
    } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      taskManager.updateTaskStatus(taskId, prevStatus || 'completed', {
        currentStep: '配乐失败（已保留原成片）',
        error: '配乐失败: ' + e.message
      });
      return { success: false, error: e.message };
    } finally {
      this.rebuildingTasks.delete(taskId);
    }
  }

  // 配乐 plan 规范化：只接受已知字段，数值做范围校验
  _normalizePlan(plan, task) {
    if (!plan || typeof plan !== 'object') return { ok: false, error: '配乐计划为空' };
    const clampNum = (v, lo, hi, dflt) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dflt;
      return Math.min(hi, Math.max(lo, n));
    };
    const clean = (list) => (Array.isArray(list) ? list : []).map((s, i) => ({
      id: String(s.id || ('seg' + i)),
      trackId: String(s.trackId || ''),
      timelineStart: clampNum(s.timelineStart, 0, 1e6, 0),
      timelineEnd: clampNum(s.timelineEnd, 0, 1e6, 0),
      sourceIn: clampNum(s.sourceIn, 0, 1e6, 0),
      sourceOut: clampNum(s.sourceOut, 0, 1e6, 0),
      volume: clampNum(s.volume, 0, 8, 1),
      fadeIn: clampNum(s.fadeIn, 0, 60, 0),
      fadeOut: clampNum(s.fadeOut, 0, 60, 0),
      speed: clampNum(s.speed, 0.5, 2, 1),
      fillMode: ['none', 'loop', 'stretch'].includes(s.fillMode) ? s.fillMode : 'none',
      keyframes: Array.isArray(s.keyframes)
        ? s.keyframes.filter(k => Number.isFinite(Number(k.t))).map(k => ({ t: Number(k.t), v: clampNum(k.v, 0, 8, 1) }))
        : []
    })).filter(s => s.trackId && s.timelineEnd > s.timelineStart);

    const music = clean(plan.music);
    const ambient = clean(plan.ambient);
    if (music.length === 0 && ambient.length === 0) return { ok: false, error: '配乐计划里没有任何有效片段' };

    const audioMixer = require('./processors/audioMixer');
    const missing = [...music, ...ambient].filter(s => !audioMixer.getTrackById(s.trackId)).map(s => s.trackId);
    if (missing.length) return { ok: false, error: '音轨不存在: ' + [...new Set(missing)].join(', ') };

    return { ok: true, plan: { music, ambient } };
  }

  // 解析片段视频的真实路径。
  // 历史任务里 videoPath 可能指向旧工作目录（如 …\ai-video-pipeline\clips\x.mp4），
  // 文件实际已迁移到当前 app/clips。这里按文件名在 CLIPS_DIR 里兜底查找，避免历史任务无法重出片。
  _resolveClipPath(videoPath) {
    if (!videoPath) return null;
    if (fs.existsSync(videoPath)) return videoPath;
    const base = path.basename(String(videoPath));
    const candidate = path.join(CLIPS_DIR, base);
    if (fs.existsSync(candidate)) return candidate;
    return null;
  }

  // 本次实际渲染是否为合成素材：用户显式选 mock，或选了真实模型但没 Key 被降级 Mock。
  // 降级必须被识别，否则 NSFW 会把 ffmpeg 测试图案当真实内容检测（没 Key 时必失败）。
  _isSynthetic(task) {
    return !!task && (task.model === 'mock' || !!task.mockFallback);
  }

  // 为每次生成/重新生成分配不覆盖的片段文件名。
  // 历史事故：固定名 task_x_clip_1.mp4 让第 2 次尝试直接覆盖第 1 次的付费产物，
  // 后续「重新生成」再覆盖一次，导致已付费片段无法找回。
  _nextClipPath(taskId, index) {
    const base = `${taskId}_clip_${index + 1}`;
    const first = path.join(CLIPS_DIR, `${base}.mp4`);
    if (!fs.existsSync(first)) return first;
    for (let v = 2; v < 1000; v++) {
      const candidate = path.join(CLIPS_DIR, `${base}_v${v}.mp4`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return path.join(CLIPS_DIR, `${base}_${Date.now()}.mp4`);
  }

  // 把「重新生成 / 补跑」请求里带上的当前设置合并进任务内存态。
  // Key 落盘会被 redact 清空，服务重启后旧任务拿不到 Key；不合并就会静默降级 Mock。
  _mergeRuntimeConfig(task, runtimeConfig) {
    if (!task || !runtimeConfig || typeof runtimeConfig !== 'object') return task;
    const ALLOWED = [
      'apiKey', 'apiBaseUrl', 'modelId', 'klingAccessKey', 'klingSecretKey',
      'llmApiKey', 'llmBaseUrl', 'llmModel',
      'multimodalApiKey', 'multimodalBaseUrl', 'multimodalModel',
      'strictQcItems', 'visualQC'
    ];
    const next = { ...(task.runtimeConfig || {}) };
    for (const k of ALLOWED) {
      if (runtimeConfig[k] !== undefined) next[k] = runtimeConfig[k];
    }
    task.runtimeConfig = next;
    return task;
  }

  // 记录 Mock 降级：任务仍显示用户选的模型，但 mockFallback 标明实际是合成画面。
  _markMockFallback(taskId, task, generator) {
    if (!task || !generator || !generator.fallbackToMock) return;
    const requested = generator.requestedModel || task.model;
    task.mockFallback = requested;
    taskManager.updateTaskStatus(taskId, task.status || 'generating', { mockFallback: requested });
    console.warn(`[${taskId}] ⚠️ 所选模型 ${requested} 未配置 API Key，本次实际为 Mock 合成画面`);
  }

  // ===== 片段间转场：解析任务级覆盖 + 全局默认 =====
  //
  // 只决定「接缝要不要做交叉淡化」，不影响档位/片段数量。
  // enabled=false 时调用方必须走原来的 concatenate（硬切），保证默认行为零变化。
  _transitionOptions(task) {
    const global = (config.TRANSITIONS && typeof config.TRANSITIONS === 'object') ? config.TRANSITIONS : {};
    const t = (task && task.transition && typeof task.transition === 'object') ? task.transition : {};
    const enabled = typeof t.enabled === 'boolean' ? t.enabled : !!global.enabled;
    const duration = Number.isFinite(Number(t.duration)) && Number(t.duration) > 0
      ? Number(t.duration)
      : (Number.isFinite(Number(global.duration)) && Number(global.duration) > 0 ? Number(global.duration) : 0.5);
    const type = (typeof t.type === 'string' && t.type) || global.type || 'fade';
    return { enabled, duration, type };
  }

  // ===== 流水线档位：某一步是否应当执行 =====
  //
  // stageSet 的形状是「只列出要执行的步骤」（{loop_processing:true, ...}），
  // **未列入的步骤就是 undefined**。
  // 所以必须用 `=== true` 判断；写成 `!== false` 会把 undefined 当成要执行
  // ——实测踩过：quick 档（stageSet 只有 4 步）下 8 步全跑了，档位形同虚设。
  //
  // 兜底原则：stageSet 整体缺失或非法时**一律当作要跑**（返回 true）。
  // 理由：跳过是「少做事」，误判会导致产物缺失且不报错；多跑一步最多多花时间。
  // 老任务由 taskDefaults 补成 8 步全 true，同样是全量执行。
  _stageEnabled(task, stepKey) {
    if (!task || !task.stageSet || typeof task.stageSet !== 'object') return true;
    return task.stageSet[stepKey] === true;
  }

  // 把某一步标记为「不执行」。
  // 两种情况必须区分开，否则任务详情会误导人：
  //   reused —— 之前已完成，本次直接复用产物（补跑场景）
  //   skipped —— 档位本来就不包含这一步（首次跑 quick 档时后 4 步）
  _markStageSkipped(taskId, stepKey, preset, reason) {
    const task = taskManager.getTask(taskId);
    const isReused = task && Array.isArray(task.resumeReused) && task.resumeReused.includes(stepKey);
    taskManager.recordStepStart(taskId, stepKey);
    taskManager.recordStepComplete(taskId, stepKey, {
      status: isReused ? 'reused' : 'skipped',
      qcResult: isReused ? 'pass' : 'skip',
      qcDetails: isReused
        ? {
          passed: true,
          reused: true,
          reason: '该环节在之前的运行中已完成，本次补跑直接复用已有产物',
          level: 'pass'
        }
        : {
          passed: false,
          skipped: true,
          legitimateSkip: true,
          reason: reason || `档位「${preset || 'custom'}」未包含此环节，按计划跳过`,
          level: 'skip'
        }
    });
    console.log(`[${taskId}] 步骤 ${stepKey} ${isReused ? '复用已有产物' : `按档位「${preset}」跳过`}`);
  }

  // ===== 补跑：从已完成步骤继续，不重跑已有的产物 =====
  //
  // 这是「流水线模式化」真正省钱的地方：
  //   今天跑 quick（只到拼接），明天补成 final —— 片段不会被重新生成，生成费不重复花。
  //
  // 已完成步骤来自 task.steps 的 status：
  //   completed        —— 跑过并通过
  //   reused           —— 之前已完成，本次复用
  //   skipped          —— 档位外跳过，**不算完成**
  //   failed / pending —— 不算完成
  // 注意 skipped 必须排除：否则「上次因档位跳过」会被误当成「已完成」，
  // 导致本次补跑也不跑它，最后没有任何产物。
  _completedSteps(task) {
    const out = [];
    const steps = (task && task.steps) || {};
    for (const key of Object.keys(steps)) {
      const st = steps[key] && steps[key].status;
      if (st === 'completed' || st === 'reused') out.push(key);
    }
    return out;
  }

  // 定位某一步已产出的视频文件。
  // 返回 null 表示「没有可复用的产物」，调用方必须据此回退到重新执行，
  // 不能假设文件一定在——任务产物可能被手动清理或磁盘清理过。
  _resolveArtifact(taskId, stepKey) {
    const map = {
      concatenation: `${taskId}_concat.mp4`,
      loop_processing: `${taskId}_loop.mp4`,
      transcoding: `${taskId}_master.mp4`,
      audio_mix: `${taskId}_final.mp4`
    };
    const name = map[stepKey];
    if (!name) return null;
    const p = path.join(OUTPUT_DIR, name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 10240) return p;
    } catch (e) {}
    return null;
  }

  // 从成功片段重建无声母版（历史任务没有 master 时使用）
  //
  // 必须与新建任务路径产出【等长】的母版：新建路径是 拼接 -> 无缝循环 -> 转码，
  // 这里若只做 拼接 -> 转码（旧实现），会得到「重建比新建长一个淡化时长」的母版，
  // 进而导致「改配乐后成片变长」。实测（3 段 × 7s，淡化 0.5s）：
  //   旧实现 21.037s / 新流程 20.567s，差 0.470s。
  // 因此这里补上同一步循环处理，淡化工时同样读配置，保证两条路径一致。
  async _buildMasterFromClips(taskId, task) {
    const success = (task.clips || [])
      .filter(c => c.status === 'success' && this._resolveClipPath(c.videoPath))
      .sort((a, b) => a.index - b.index);
    if (success.length === 0) return { success: false, error: '没有可用的成功片段' };
    const master = path.join(OUTPUT_DIR, `${taskId}_master.mp4`);
    const tmp = path.join(OUTPUT_DIR, `${taskId}_master.tmp.mp4`);
    const loopTmp = path.join(OUTPUT_DIR, `${taskId}_master.loop.mp4`);
    const paths = success.map(c => this._resolveClipPath(c.videoPath));
    const cleanup = () => {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
      try { if (fs.existsSync(loopTmp)) fs.unlinkSync(loopTmp); } catch (e) {}
    };
    if (paths.length === 1) {
      fs.copyFileSync(paths[0], tmp);
    } else {
      // 与新建路径同口径：转场开启时必须用同一个模块，否则重建母版比新建母版长
      // (N−1)×F 秒——这正是 2026-10-19「重建母版漏了循环」同类缺陷的翻版。
      const trans = this._transitionOptions(task);
      const r = trans.enabled
        ? await transitionMixer.concatWithTransitions(paths, tmp, {
          duration: trans.duration,
          type: trans.type,
          resolution: task.resolution,
          fps: 30
        })
        : await videoProcessor.concatenate(paths, tmp);
      if (!r.success) { cleanup(); return { success: false, error: '拼接母版失败: ' + r.error }; }
    }

    // 与新建路径一致的循环处理（淡化时长同源配置）
    const loopFade = config.QC && Number.isFinite(Number(config.QC.loopFadeDuration))
      ? Number(config.QC.loopFadeDuration)
      : 0.5;
    const loopResult = await videoProcessor.makeSeamlessLoop(tmp, loopTmp, loopFade);
    if (!loopResult.success) {
      // 不静默退回直通：退回会让母版比新建路径长一个淡化时长，正是要消除的不一致
      cleanup();
      return { success: false, error: '母版循环处理失败: ' + (loopResult.error || '未知原因') };
    }

    const tr = await videoProcessor.transcode(loopTmp, master, { resolution: task.resolution, fps: 30 });
    cleanup();
    if (!tr.success) return { success: false, error: '母版转码失败: ' + tr.error };
    const info = videoProcessor.getVideoInfo(master);
    if (!info.success || !(info.duration > 0)) return { success: false, error: '母版时长读取失败' };
    taskManager.updateTaskStatus(taskId, task.status, { masterPath: master, totalDuration: Math.round(info.duration*100)/100 });
    return { success: true, masterPath: master, duration: info.duration, fadeDuration: loopFade };
  }

  // ===== 补跑入口 =====
  //
  // 用法（省钱的核心场景）：
  //   今天用 quick 档跑到拼接（片段已生成、已付费），明天想补成 final：
  //     await pipeline.continueTask(taskId, { preset: 'final' })
  //   → 只补跑 loop/transcoding/audio_mix/final_qc，**片段不会重新生成**。
  //
  // 已完成步骤自动从 task.steps 推断（completed / reused），也可用 completed 显式覆盖。
  // 依赖校验交给 resolveResume：链路不完整（例如声称转码完成却从没生成片段）直接判失败，
  // 不硬跑——那会在没有输入的情况下产出坏片。
  // 对「已生成但质检失败」的片段只重跑质检，不重新生成视频。
  //
  // 场景（2026-10-21 实测）：片段生成成功并落盘，但 NSFW 多模态端点不可用 → checkClip 判 fail
  // → 片段 status=failed → 任务 failed、片段库不收（library 只收 success）
  // → 钱花了、视频在磁盘上，却哪都用不了，只能重新生成再花钱。
  //
  // 合规不放松：真的重新执行 checkClip（含 NSFW），不是"跳过质检"。
  // 通过后：片段转 success + 入片段库，随后 continueTask 可复用这些片段拼成片。
  async recheckClips(taskId, options = {}) {
    if (this.runningTasks.has(taskId)) {
      return { success: false, error: '任务正在运行中，请稍后再试' };
    }
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };

    const rc = task.runtimeConfig || {};
    // 已成功但库里缺档案的片段先补齐：手工恢复 / 补跑复用的片段都不经过生成入库，
    // 不补的话会出现「片段文件在、成片也有、片段库却没有」。
    try {
      const added = library.ingestMissing(task);
      if (added.length) console.log(`[${taskId}] 补入片段库 ${added.length} 条: ${added.join(', ')}`);
    } catch (e) {
      console.warn(`[${taskId}] 补入库失败: ${e.message}`);
    }

    const nsfw = {
      apiKey: options.multimodalApiKey || rc.multimodalApiKey || '',
      baseUrl: options.multimodalBaseUrl || rc.multimodalBaseUrl || '',
      model: options.multimodalModel || rc.multimodalModel || '',
    };
    if (!nsfw.apiKey) {
      return { success: false, error: '未配置多模态 API Key：请先在设置里填写并保存（NSFW 检测要用）' };
    }

    const clips = Array.isArray(task.clips) ? task.clips : [];
    const results = [];
    let checked = 0;
    let passed = 0;

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (clip.status === 'success') {
        results.push({ index: i, skipped: 'already-success' });
        continue;
      }
      if (!clip.videoPath || !fs.existsSync(clip.videoPath)) {
        results.push({ index: i, error: '片段文件不存在' });
        continue;
      }
      checked++;
      let qc;
      try {
        qc = await qualityChecker.checkClip(clip.videoPath, task.clipDuration, {
          nsfw: { ...nsfw, syntheticSource: this._isSynthetic(task) },
          strictItems: Array.isArray(rc.strictQcItems) && rc.strictQcItems.length
            ? rc.strictQcItems
            : undefined,
        });
      } catch (e) {
        results.push({ index: i, error: '质检异常: ' + e.message });
        continue;
      }

      if (qc && qc.passed) {
        passed++;
        taskManager.updateClip(taskId, i, { status: 'success', qcResult: qc, error: null });
        try {
          library.ingestClip(task, { ...clip, status: 'success' });
        } catch (e) {
          console.warn(`[${taskId}] 片段 ${i + 1} 入库失败: ${e.message}`);
        }
        results.push({ index: i, passed: true });
      } else {
        const why = (qc && qc.reason) || '未通过';
        taskManager.updateClip(taskId, i, { qcResult: qc, error: `质检未通过: ${why}` });
        results.push({ index: i, passed: false, reason: why });
      }
    }

    const updated = taskManager.getTask(taskId);
    const clipsNow = (updated && updated.clips) || [];
    const allPassed = clipsNow.length > 0 && clipsNow.every((c) => c.status === 'success');
    if (allPassed) {
      taskManager.updateTaskStatus(taskId, updated.status, {
        error: '片段已全部通过重新质检，请点「补跑」继续拼接成片',
      });
    }

    console.log(`[${taskId}] 重新质检完成：${passed}/${checked} 通过`);
    return { success: true, checked, passed, allPassed, results };
  }

  async continueTask(taskId, options = {}) {
    if (this.runningTasks.has(taskId)) {
      return { success: false, error: '任务正在运行中，请稍后再试' };
    }
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };

    // 与「重新生成」一致：旧任务落盘时 Key 被脱敏，补跑必须接受前端带上来的当前设置，
    // 否则重启后补跑会静默降级 Mock / NSFW 必失败。
    if (options.runtimeConfig) {
      this._mergeRuntimeConfig(task, options.runtimeConfig);
      taskManager.updateTaskStatus(taskId, task.status, { runtimeConfig: task.runtimeConfig });
    }

    const targetPreset = options.preset || task.preset || 'final';
    const completed = Array.isArray(options.completed) && options.completed.length
      ? options.completed
      : this._completedSteps(task);

    const resume = resolveResume({ preset: targetPreset, completed });
    if (!resume.ok) {
      return { success: false, error: resume.error, resume };
    }
    if (resume.pending.length === 0) {
      return {
        success: true,
        alreadyDone: true,
        message: `档位「${targetPreset}」的步骤均已完成，无需补跑`,
        resume
      };
    }

    // 检查待跑步骤是否都能拿到输入产物：不能只看「已完成」，还要看文件是否真在。
    // 产物可能被手动删除或磁盘清理，此时应明确报错，而不是跑到一半才失败。
    const needsConcat = resume.pending.some(s => ['concatenation', 'loop_processing', 'transcoding', 'audio_mix', 'final_qc'].includes(s));
    if (needsConcat && !completed.includes('concatenation')) {
      return {
        success: false,
        error: '补跑需要拼接产物，但拼接尚未完成；请先跑完到拼接步骤',
        resume
      };
    }

    // 把 stageSet 设为「本次待跑」
    const newStageSet = {};
    for (const s of resume.pending) newStageSet[s] = true;
    // 复用清单：目标档位内但本次不跑的步骤 = 复用（_markStageSkipped 据此标 reused 而非 skipped）
    const proposedReused = resume.stages.filter(s => !resume.pending.includes(s));

    // 状态必须从「已完成」切回「运行中」，否则外部（前端轮询、测试等待、
    // 甚至 startTask 的运行中判断）都会以为任务已经结束：
    // 实测踩过——补跑后任务状态仍是 completed，等待逻辑立即返回，看起来像补跑没生效。
    taskManager.updateTaskStatus(taskId, 'pending', {
      preset: resume.preset,
      stageSet: newStageSet,
      resumeReused: proposedReused,
      stagePlan: { stages: resume.stages, notes: resume.notes },
      currentStep: '补跑中'
    });

    console.log(`[${taskId}] 补跑到「${targetPreset}」：复用 ${proposedReused.length} 步，待跑 ${resume.pending.join(',')}`);
    const started = this.startTask(taskId, { resumeInfo: resume });
    if (started && started.error) return { success: false, error: started.error, resume };
    return {
      success: true,
      taskId,
      resume,
      reused: proposedReused,
      pending: resume.pending,
      message: `正在补跑 ${resume.pending.length} 个环节`
    };
  }

  // 兼容旧调用名（旧的逐段改配乐接口已下线，这里保留一个明确的错误提示）
  async reapplyClipAudio(taskId, index, trackId) {
    return {
      success: false,
      deprecated: true,
      error: '逐段配乐已下线，请使用「添加配乐」页面的整片配乐接口（POST /api/tasks/:id/audio）'
    };
  }

  // 旧的重建流程保留名字但不再被调用，见 reapplyBgm
  async _rebuildAfterBgmChange(taskId) {
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };
    return this.reapplyBgm(taskId, task.bgmPlan || { music: [], ambient: [] });
  }

  // 说明：旧的 _rebuildInternal 已删除。
  // 它按「各片段 trackId」逐段混音再拼接，正是本次要淘汰的链路；
  // 现在统一走 reapplyBgm（整片 plan 混音）。


  // 启动整个流水线
  // 组装成片终检（checkFinal）所需的运行时配置。
  //
  // 实测事故（2026-10-20）：三处 checkFinal(finalPath) 都**没传任何 options**，
  // 于是终检的 NSFW 永远走 .env 默认值（gpt-4o-mini + 空 Key），
  // 用户在设置里填的多模态 Key / 阿里云地址 / qwen3-vl-plus 完全没被用上。
  // 表现：final_qc 里记录的 model 是 gpt-4o-mini，与片段级质检用的模型不一致。
  _finalQcOptions(task) {
    if (!task) return {};
    const rc = task.runtimeConfig || {};
    return {
      nsfw: {
        // 与片段级保持同一解析顺序：多模态专用 Key 优先，其次回退 LLM Key
        apiKey: rc.multimodalApiKey || rc.llmApiKey,
        baseUrl: rc.multimodalBaseUrl,
        model: rc.multimodalModel,
        // Mock 片段是合成图案，NSFW 对它不适用（与片段级判定一致）
        syntheticSource: this._isSynthetic(task)
      }
    };
  }

  // ===== 启动自检：回收「僵尸任务」 =====
  //
  // 实测事故（2026-10-20）：任务在「配乐混音」步骤把状态置为 mixing 后进程被中断，
  // 于是任务永远停在 mixing、outputPath 为 null，前端既看不到完成也看不到失败，
  // 成片也拿不到——而 8 个步骤其实全都标记成 completed 了。
  //
  // 原理：服务进程刚启动时，**不可能有任何任务正在执行**（执行只发生在本进程内）。
  // 所以凡是处于「进行中」状态的任务，必然是上次进程中断留下的僵尸，必须回收。
  //
  // 标记为 failed 而不是 completed：产物可能不完整，不能冒充成功（§4.1 同理）。
  // 但保留已完成步骤信息 + 明确提示可「补跑」，用户不用从头再来。
  async reconcileInterruptedTasks() {
    const IN_PROGRESS = ['pending', 'generating', 'concatenating', 'looping', 'transcoding', 'mixing'];
    // 合并两个来源：内存（一定有最新状态）+ 数据库（历史全量）。
    // 只读数据库会漏掉「刚创建、异步写库还没落盘」的任务（实测出现竞态）；
    // 只读内存则会漏掉「服务重启后尚未载入」的任务。两者合并才完整。
    const byId = new Map();
    try {
      const mem = taskManager.getAllTasks() || [];
      for (const t of mem) if (t && t.taskId) byId.set(t.taskId, t);
    } catch (e) {}
    try {
      const stored = (await require('./storage').getAllTasks()) || [];
      for (const t of stored) if (t && t.taskId && !byId.has(t.taskId)) byId.set(t.taskId, t);
    } catch (e) {}
    const tasks = [...byId.values()];
    const recovered = [];
    for (const t of tasks) {
      if (!t || !t.taskId) continue;
      if (!IN_PROGRESS.includes(t.status)) continue;
      if (this.runningTasks.has(t.taskId)) continue; // 理论上不可能，防御
      const done = Object.entries(t.steps || {})
        .filter(([, v]) => v && v.status === 'completed')
        .map(([k]) => k);
      const prev = t.status;
      taskManager.updateTaskStatus(t.taskId, 'failed', {
        error: `服务进程中断导致流水线停止（中断时状态：${prev}）。`
          + `已完成步骤：${done.length ? done.join('、') : '无'}。`
          + '可直接点「补跑」从断点继续，已生成的片段不会重新生成。',
        interruptedFrom: prev,
        interruptedAt: new Date().toISOString(),
        recoverable: done.length > 0
      });
      recovered.push({ taskId: t.taskId, from: prev, completedSteps: done.length });
    }
    return recovered;
  }

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

    // 片段库成片：片段是现成素材；重新生成：用户已给最终提示词。
    // 这两类任务都不能再跑「提示词优化/分镜」，否则会覆盖用户选的提示词、白调一次 LLM。
    const isLibraryTask = task.source === 'library';
    const isRegenerateTask = task.source === 'regenerate';
    const skipPromptStages = isLibraryTask || isRegenerateTask;

    if (skipPromptStages) {
      this._markStageSkipped(taskId, 'prompt_optimize', task.preset,
        isLibraryTask ? '片段库成片：片段为已有素材，无需提示词优化' : '片段库重新生成：使用用户指定的提示词，不再自动优化');
      this._markStageSkipped(taskId, 'storyboard', task.preset,
        isLibraryTask ? '片段库成片：片段为已有素材，无需分镜' : '片段库重新生成：单片段任务，无需分镜');
    } else {
    // ===== 第1步：提示词优化 + 提示词质检 =====
    taskManager.recordStepStart(taskId, 'prompt_optimize');
    console.log(`[${taskId}] 步骤1: 提示词优化 + 质检`);

    // 多提示词模式（§10B）：遍历 clips 按各自主题逐行优化，结果写回 clips[i].prompt
    if (task.isMultiPrompt && task.clips.length > 0) {
      const llmCfg = task.runtimeConfig || {};
      // 服务端兜底：任务里没带 LLM 配置时用 .env（OPENAI_API_KEY/BASE_URL/MODEL）。
      // 为什么加：Key 只存在浏览器 localStorage，换 origin（localhost↔127.0.0.1）、
      // 换端口、清站点数据都会丢，用户被迫反复重填。写进 .env 一次即可长期生效；
      // 页面里填的仍然优先。
      const llmKey = llmCfg.llmApiKey || config.OPENAI_API_KEY || '';
      const llmBase = llmCfg.llmBaseUrl || config.OPENAI_BASE_URL || '';
      const llmModel = llmCfg.llmModel || config.OPENAI_MODEL || '';
      let worstQC = { passed: true };
      for (const clip of task.clips) {
        const theme = clip.theme ?? task.theme;
        const optResult = (llmKey)
          ? await promptOptimizer.optimizeWithAI(clip.prompt, theme, {
              apiKey: llmKey,
              baseUrl: llmBase,
              model: llmModel
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
      // 同上游：任务没带就用 .env 兜底，避免 Key 只活在浏览器里
      const scenes = await llmService.storyboard(task.prompt, task.totalClips, {
        apiKey: llmCfg.llmApiKey || config.OPENAI_API_KEY || '',
        baseUrl: llmCfg.llmBaseUrl || config.OPENAI_BASE_URL || '',
        model: llmCfg.llmModel || config.OPENAI_MODEL || ''
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

    } // ===== 结束「跳过提示词阶段」分支 =====

    // ===== 第3步：批量生成片段 + 片段质检 =====
    if (isLibraryTask) {
      this._markStageSkipped(taskId, 'clip_generation', task.preset, '片段库成片：直接使用库中已有片段，不重新生成');
    } else {
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
    this._markMockFallback(taskId, task, generator);

    const batchInfo = await this._batchGenerate(taskId, generator);

    // 补跑复用的片段（以及任何已成功但库里没档案的片段）补入库。
    // 入库原先只挂在「生成成功」和「重检转成功」两条路径上，复用路径从不入库。
    try {
      const added = library.ingestMissing(taskManager.getTask(taskId) || task);
      if (added.length) console.log(`[${taskId}] 补入片段库 ${added.length} 条: ${added.join(', ')}`);
    } catch (e) {
      console.warn(`[${taskId}] 补入库失败: ${e.message}`);
    }

    // 检查片段生成结果
    const progress = taskManager.getProgress(taskId);
    const qcPassed = task.clips.filter(c => c.status === 'success').length;
    const clipQCRate = qcPassed / task.totalClips;
    const hasPartialSuccess = qcPassed > 0 && qcPassed < task.totalClips;
    // 全部片段都是复用来的（补跑场景）：如实标为 reused，不谎称本轮重新生成过
    const allReused = batchInfo && batchInfo.reused > 0 && batchInfo.generated === 0;

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
    // 全部复用（补跑）时标 reused：本轮没有生成任何一个片段，不该记成 completed
    taskManager.recordStepComplete(taskId, 'clip_generation', {
      status: allReused ? 'reused' : (hasPartialSuccess ? 'partial' : 'completed'),
      qcResult: allReused ? 'pass' : (clipQCRate >= 0.9 ? 'pass' : 'warn'),
      qcDetails: {
        passed: clipQCRate >= 0.8,
        reason: allReused
          ? `复用已有 ${batchInfo.reused} 个片段，本轮未重新生成`
          : `片段质检通过率: ${Math.round(clipQCRate * 100)}%${hasPartialSuccess ? '（部分失败，已跳过失败片段继续生成）' : ''}`,
        totalClips: task.totalClips,
        successClips: qcPassed,
        failedClips: progress.failed,
        passRate: clipQCRate,
        ...(batchInfo ? { reusedClips: batchInfo.reused, generatedClips: batchInfo.generated } : {})
      }
    });
    } // ===== 结束第3步（非片段库任务） =====

    // ===== 第4步：拼接视频 + 拼接质检 =====
    //
    // clips_only（片段包）档会跳过拼接：该档的交付物就是「片段」，不出成片。
    // 跳过时不能只标记 skipped 就往下走——下游所有步骤都依赖拼接产物，
    // 继续执行会在没有输入的情况下产出坏片。因此这里直接结束流水线，
    // 产物记为 null 并明确标注 fragmentOnly，让调用方知道「这是片段包，不是成片」。
    //
    // 判定「是否片段包」不能只看有没有 _concat.mp4：
    //   单片段任务的拼接步骤是「跳过拼接、直接用该片段」，**不会产出 _concat.mp4**。
    //   若只看文件，单片段任务补跑时会被误判为片段包、下游全部标 skipped。
    //   实测踩过：1 片段 + quick 跑完后补 final，循环/转码/配乐/终检全成 skipped。
    // 因此：拼接步骤本身已完成（completed/reused/partial）时，没有 _concat.mp4 就用该片段顶上。
    const concatStepStatus = task.steps && task.steps.concatenation
      ? task.steps.concatenation.status : null;
    const concatDone = ['completed', 'reused', 'partial'].includes(concatStepStatus);
    let reusedConcat = this._resolveArtifact(taskId, 'concatenation');
    if (!reusedConcat && concatDone) {
      const soleSuccess = (task.clips || [])
        .filter(c => c.status === 'success')
        .map(c => this._resolveClipPath(c.videoPath))
        .filter(Boolean);
      if (soleSuccess.length === 1) reusedConcat = soleSuccess[0];
    }
    if (!this._stageEnabled(task, 'concatenation') && !reusedConcat) {
      this._markStageSkipped(taskId, 'concatenation', task.preset);
      for (const downstream of ['loop_processing', 'transcoding', 'audio_mix', 'final_qc']) {
        this._markStageSkipped(taskId, downstream, task.preset);
      }
      const clipList = (task.clips || [])
        .filter(c => c.status === 'success')
        .map(c => this._resolveClipPath(c.videoPath))
        .filter(Boolean);
      taskManager.updateTaskStatus(taskId, 'completed', {
        currentStep: '片段包已交付',
        outputPath: null,
        fragmentOnly: true,
        fragmentCount: clipList.length,
        error: null
      });
      console.log(`[${taskId}] 档位「${task.preset}」为片段包：已交付 ${clipList.length} 个片段，不产出成片`);
      return { success: true, outputPath: null, fragmentOnly: true, fragmentCount: clipList.length };
    }

    // 补跑复用：拼接在之前的运行中已完成 → 直接取已有产物，不重新拼接
    if (reusedConcat && !this._stageEnabled(task, 'concatenation')) {
      this._markStageSkipped(taskId, 'concatenation', task.preset);
      console.log(`[${taskId}] 复用已有拼接产物: ${path.basename(reusedConcat)}`);
    } else {
      taskManager.recordStepStart(taskId, 'concatenation');
      taskManager.updateTaskStatus(taskId, 'concatenating', { currentStep: '视频拼接' });
      console.log(`[${taskId}] 步骤4: 视频拼接 + 质检`);
    }

    const successClipObjs = task.clips
      .filter(c => c.status === 'success')
      .sort((a, b) => a.index - b.index);
    // 片段级配乐已下线：直接拼接原始片段，配乐在「配乐混音」步骤整片统一处理
    const successClips = successClipObjs
      .map(c => this._resolveClipPath(c.videoPath))
      .filter(Boolean);

    if (successClips.length === 0) {
      taskManager.recordStepComplete(taskId, 'concatenation', {
        status: 'failed',
        qcResult: 'fail',
        error: '没有可用的成功片段'
      });
      throw new Error('没有可用的成功片段');
    }

    let concatPath;
    if (reusedConcat && !this._stageEnabled(task, 'concatenation')) {
      // 补跑：直接复用上次的拼接产物
      concatPath = reusedConcat;
    } else if (isLibraryTask && (successClips.length > 1 || successClipObjs.some(c => c.trim))) {
      // 片段库成片：可能有裁剪/不同帧率/不同分辨率，交给 concatenateSegments 先归一化再拼。
      // 它内部会做时长校验 + 完整解码校验，不能只看 ffmpeg 退出码。
      concatPath = path.join(OUTPUT_DIR, `${taskId}_concat.mp4`);
      const segs = successClipObjs.map(c => ({
        path: this._resolveClipPath(c.videoPath),
        inSec: c.trim && c.trim.inSec ? c.trim.inSec : 0,
        outSec: c.trim && c.trim.outSec !== undefined ? c.trim.outSec : null
      })).filter(s => s.path);
      console.log(`[${taskId}] 片段库拼接：${segs.length} 段，目标 ${task.resolution}`);
      const trans = this._transitionOptions(task);
      let concatResult;
      if (trans.enabled && segs.length > 1) {
        // 转场模式：归一化 + 交叉淡化在本模块内一次做完。
        concatResult = await transitionMixer.concatWithTransitions(segs, concatPath, {
          duration: trans.duration,
          type: trans.type,
          resolution: task.resolution,
          fps: 30
        });
        if (concatResult.success) concatResult.reencoded = true;
      } else {
        concatResult = await videoProcessor.concatenateSegments(segs, concatPath, {
          resolution: task.resolution,
          fps: 30
        });
      }
      if (!concatResult.success) {
        taskManager.recordStepComplete(taskId, 'concatenation', {
          status: 'failed',
          qcResult: 'fail',
          error: '片段库拼接失败: ' + concatResult.error
        });
        throw new Error('片段库拼接失败: ' + concatResult.error);
      }
      const durationOk = !!(concatResult.durationCheck && concatResult.durationCheck.ok);
      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: durationOk ? 'pass' : 'warn',
        qcDetails: {
          passed: true,
          level: durationOk ? 'pass' : 'warn',
          reason: `片段库拼接完成：${segs.length} 段，归一化 ${concatResult.normalized || 0} 段，`
            + `目标 ${concatResult.target.width}x${concatResult.target.height}@${concatResult.fps}fps`,
          normalized: concatResult.normalized || 0,
          target: concatResult.target,
          durationCheck: concatResult.durationCheck,
          decodeCheck: concatResult.decodeCheck,
          reencoded: !!concatResult.reencoded,
          transition: concatResult.transitionType
            ? {
              type: concatResult.transitionType,
              fadeDuration: concatResult.fadeDuration,
              transitions: concatResult.transitions
            }
            : null
        }
      });
    } else if (successClips.length === 1) {
      // 只有一个成功片段，跳过拼接直接使用。
      // 但要区分「本来就只有 1 个」和「丢了一个」——后者必须显式判 fail（见上方说明）。
      concatPath = successClips[0];
      const expectedClips = task.totalClips || (task.clips || []).length;
      const lostClips = Math.max(0, expectedClips - successClips.length);
      const clipLost = lostClips > 0;
      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: clipLost ? 'fail' : 'warn',
        qcDetails: {
          passed: !clipLost,
          level: clipLost ? 'fail' : 'warn',
          reason: clipLost
            ? `片段缺失：应有 ${expectedClips} 个，实际成功 ${successClips.length} 个（丢失 ${lostClips} 个），`
              + '成片只由剩余片段组成，请检查生成与下载是否异常'
            : '任务只有 1 个片段，无需拼接',
          expectedClips,
          successClips: successClips.length,
          lostClips
        }
      });
      if (clipLost) {
        console.error(`[${taskId}] ⚠️ 片段缺失：应有 ${expectedClips} 个，实际 ${successClips.length} 个`);
      }
    } else {
      concatPath = path.join(OUTPUT_DIR, `${taskId}_concat.mp4`);
      const trans = this._transitionOptions(task);
      const concatResult = trans.enabled
        ? await transitionMixer.concatWithTransitions(successClips, concatPath, {
          duration: trans.duration,
          type: trans.type,
          resolution: task.resolution,
          fps: 30
        })
        : await videoProcessor.concatenate(successClips, concatPath);

      if (!concatResult.success) {
        taskManager.recordStepComplete(taskId, 'concatenation', {
          status: 'failed',
          qcResult: 'fail',
          error: '拼接失败: ' + concatResult.error
        });
        throw new Error('拼接失败: ' + concatResult.error);
      }

      // 拼接质检
      const concatQC = await qualityChecker.checkConcat(concatPath, successClips.length, successClips, {
        expectedDuration: concatResult.expectedDuration
      });
      await this._sleep(300);

      taskManager.recordStepComplete(taskId, 'concatenation', {
        qcResult: concatQC.passed ? 'pass' : concatQC.level,
        qcDetails: concatResult.transitionType
          ? {
            ...concatQC,
            transition: {
              type: concatResult.transitionType,
              fadeDuration: concatResult.fadeDuration,
              transitions: concatResult.transitions,
              durationCheck: concatResult.durationCheck,
              decodeCheck: concatResult.decodeCheck
            }
          }
          : concatQC
      });
    }

    // ===== 第5步：无缝循环 + 循环质检 =====
    // 三种情况：
    //   a) 补跑且上次已做循环 → 复用 _loop.mp4
    //   b) 档位包含循环 → 正常执行
    //   c) 档位不含循环 → 标记跳过，下游直接用拼接产物
    const loopPath = path.join(OUTPUT_DIR, `${taskId}_loop.mp4`);
    const reusedLoop = this._resolveArtifact(taskId, 'loop_processing');
    let loopResult = { success: false, skippedByPreset: true };
    let videoForNext = concatPath;
    if (reusedLoop && !this._stageEnabled(task, 'loop_processing')) {
      this._markStageSkipped(taskId, 'loop_processing', task.preset);
      videoForNext = reusedLoop;
      console.log(`[${taskId}] 复用已有循环产物: ${path.basename(reusedLoop)}`);
    } else if (this._stageEnabled(task, 'loop_processing')) {
      taskManager.recordStepStart(taskId, 'loop_processing');
      taskManager.updateTaskStatus(taskId, 'looping', { currentStep: '无缝循环处理' });
      console.log(`[${taskId}] 步骤5: 无缝循环处理 + 质检`);

      await this._sleep(500);
      // 与新建路径使用同一个淡化时长（配置项），保证两条路径产出的成片时长一致
      const loopFade = config.QC && Number.isFinite(Number(config.QC.loopFadeDuration))
        ? Number(config.QC.loopFadeDuration)
        : 0.5;
      loopResult = await videoProcessor.makeSeamlessLoop(concatPath, loopPath, loopFade);

      // 循环质检（传源时长与淡化时长，以便核验「成片 = 源 - 淡化」）
      const concatInfo = videoProcessor.getVideoInfo(concatPath);
      const loopQC = await qualityChecker.checkLoop(
        loopResult.success ? loopPath : concatPath,
        {
          sourcePath: concatPath,
          sourceDuration: concatInfo.success ? concatInfo.duration : null,
          fadeDuration: loopResult.fadeDuration !== undefined ? loopResult.fadeDuration : loopFade,
          threshold: config.QC ? config.QC.loopSsimThreshold : undefined
        }
      );

      taskManager.recordStepComplete(taskId, 'loop_processing', {
        qcResult: loopQC.passed ? 'pass' : loopQC.level,
        qcDetails: {
          ...loopQC,
          loopProcess: {
            success: loopResult.success,
            reencoded: !!loopResult.reencoded,
            fadeDuration: loopResult.fadeDuration,
            sourceDuration: loopResult.sourceDuration,
            outputDuration: loopResult.outputDuration,
            error: loopResult.error
          }
        }
      });

      if (loopResult.success) videoForNext = loopPath;
    } else {
      this._markStageSkipped(taskId, 'loop_processing', task.preset);
    }

    // ===== 第6步：转码 =====
    // 产物同时作为「无声母版」（_master.mp4）保留：
    // 后续改配乐只需要在母版上重新混音，不必再拼接/重编码视频。
    //
    // 档位可能跳过转码。跳过时没有母版，下游配乐会改用 videoForNext 作为音源基准；
    // 若配乐也被跳过，则直接把当前视频作为成片（见后续成片确定逻辑）。
    const masterPath = path.join(OUTPUT_DIR, `${taskId}_master.mp4`);
    const reusedMaster = this._resolveArtifact(taskId, 'transcoding');
    let masterDuration = null;
    if (reusedMaster && !this._stageEnabled(task, 'transcoding')) {
      this._markStageSkipped(taskId, 'transcoding', task.preset);
      const mi = videoProcessor.getVideoInfo(reusedMaster);
      masterDuration = mi.success ? mi.duration : null;
      videoForNext = reusedMaster;
      console.log(`[${taskId}] 复用已有转码产物: ${path.basename(reusedMaster)}`);
    } else if (this._stageEnabled(task, 'transcoding')) {
      taskManager.recordStepStart(taskId, 'transcoding');
      taskManager.updateTaskStatus(taskId, 'transcoding', { currentStep: '转码导出' });
      console.log(`[${taskId}] 步骤6: 转码导出 + 质检`);

      await this._sleep(500);
      const transcodeResult = await videoProcessor.transcode(
        videoForNext,
        masterPath,
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

      taskManager.updateTaskStatus(taskId, 'transcoding', { masterPath });
      const masterInfo = videoProcessor.getVideoInfo(masterPath);
      masterDuration = masterInfo.success ? masterInfo.duration : null;
      videoForNext = masterPath;
    } else {
      this._markStageSkipped(taskId, 'transcoding', task.preset);
    }

    // ===== 第6.5步：整片配乐混音 =====
    // 配乐在成片阶段一次性混入（而不是逐片段），见 _applyBgmPlan。
    //
    // 音源基准：有母版用母版（转码产物），跳过转码时退化为 videoForNext。
    // 档位跳过配乐时，成片直接取 videoForNext（可能是母版，也可能只有拼接产物）。
    const finalPath = path.join(OUTPUT_DIR, `${taskId}_final.mp4`);
    const reusedFinal = this._resolveArtifact(taskId, 'audio_mix');
    let audioMixed = false;
    if (reusedFinal && !this._stageEnabled(task, 'audio_mix')) {
      this._markStageSkipped(taskId, 'audio_mix', task.preset);
      audioMixed = true;
      console.log(`[${taskId}] 复用已有配乐成片: ${path.basename(reusedFinal)}`);
    } else if (this._stageEnabled(task, 'audio_mix')) {
      taskManager.recordStepStart(taskId, 'audio_mix');
      taskManager.updateTaskStatus(taskId, 'mixing', { currentStep: '配乐混音' });
      console.log(`[${taskId}] 步骤6.5: 整片配乐混音`);

      const currentTask = taskManager.getTask(taskId);
      const bgmSource = (masterDuration !== null && fs.existsSync(masterPath)) ? masterPath : videoForNext;
      try {
        const mixRes = await this._applyBgmPlan(taskId, bgmSource, finalPath, currentTask);
        audioMixed = !!(mixRes && mixRes.success);
        // 未启用配乐 / 混音失败 → 成片直接使用音源（保证仍能出片）
        if (!audioMixed) {
          fs.copyFileSync(bgmSource, finalPath);
          console.log(`[${taskId}] 配乐未应用（${mixRes && (mixRes.reason || mixRes.error) || '未启用'}），使用无配乐成片`);
        }
      } catch (e) {
        console.error(`[${taskId}] 配乐混音异常，回退无配乐成片:`, e.message);
        try { fs.copyFileSync(bgmSource, finalPath); } catch (_) {}
      }
      taskManager.recordStepComplete(taskId, 'audio_mix', {
        qcResult: audioMixed ? 'pass' : 'warn',
        qcDetails: {
          passed: true,
          applied: audioMixed,
          reason: audioMixed ? '整片配乐已混入' : '未配乐或配乐失败，成片保持无声',
          bgmResult: (taskManager.getTask(taskId) || {}).bgmResult || null
        }
      });
    } else {
      this._markStageSkipped(taskId, 'audio_mix', task.preset);
      // 跳过配乐也要产出成片文件，否则「完成」状态指向一个不存在的文件
      try {
        if (videoForNext !== finalPath) fs.copyFileSync(videoForNext, finalPath);
      } catch (e) {
        console.error(`[${taskId}] 跳配乐后生成成片失败:`, e.message);
      }
    }

    // 转码质检（针对最终成片）——只在真的跑了转码时记录，跳过时不重复写 transcoding 结论
    if (this._stageEnabled(task, 'transcoding')) {
      const transcodeQC = await qualityChecker.checkTranscode(finalPath, task.resolution, 30);
      taskManager.recordStepComplete(taskId, 'transcoding', {
        qcResult: transcodeQC.passed ? 'pass' : transcodeQC.level,
        qcDetails: { ...transcodeQC, masterDuration, audioMixed }
      });
    }

    // ===== 第7步：最终综合质检 =====
    let finalQC = null;
    if (this._stageEnabled(task, 'final_qc')) {
      taskManager.recordStepStart(taskId, 'final_qc');
      console.log(`[${taskId}] 步骤7: 最终综合质检`);

      finalQC = await qualityChecker.checkFinal(finalPath, this._finalQcOptions(task));
      await this._sleep(300);

      taskManager.recordStepComplete(taskId, 'final_qc', {
        qcResult: finalQC.passed ? 'pass' : 'fail',
        qcDetails: finalQC
      });
    } else {
      this._markStageSkipped(taskId, 'final_qc', task.preset);
    }

    // ===== 完成 =====
    // 如果有部分片段失败，标记为 partial（但仍然是完成状态，可以查看成片）
    const finalProgress = taskManager.getProgress(taskId);
    const isPartial = finalProgress.success < task.totalClips && finalProgress.success > 0;
    // 回写真实时长：避免任务记录与实际文件不一致（同 §四 改动点 5 的缺陷类别）
    const qcDuration = finalQC && finalQC.details && finalQC.details.videoInfo
      ? finalQC.details.videoInfo.duration : null;
    // 跳过终检时 finalQC 为 null：不能用 null 覆盖掉历史结论，
    // 所以只在真的跑了终检时才写入 finalQC 字段，并显式记下「终检被档位跳过」。
    taskManager.updateTaskStatus(taskId, isPartial ? 'partial' : 'completed', {
      currentStep: isPartial ? '部分完成' : '已完成',
      outputPath: finalPath,
      ...(finalQC ? { finalQC } : {}),
      ...(qcDuration > 0 ? { totalDuration: Math.round(qcDuration * 100) / 100 } : {}),
      finalQCSkipped: !finalQC,
      error: null
    });

    console.log(`[${taskId}] ${isPartial ? '⚠️ 流水线部分完成' : '🎉 流水线完成'}！输出: ${finalPath}（成功 ${finalProgress.success}/${task.totalClips} 片段）`);
    return { success: true, outputPath: finalPath, partial: isPartial };
  }

  // 批量生成（带并发控制 + 重试 + 质检）
  // ===== 暂停 / 继续 =====
  // 粒度：只在「取下一个片段之前」检查，正在生成中的片段会正常跑完再停。
  // 这样不会中断已经发出去的生成请求（那会白花一次调用）。
  pauseTask(taskId) {
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (!this.runningTasks.has(taskId)) return { success: false, error: '任务未在运行' };
    if (this.pausedTasks.has(taskId)) return { success: true, alreadyPaused: true };
    this.pausedTasks.add(taskId);
    taskManager.updateTaskStatus(taskId, 'paused', { currentStep: '已暂停' });
    console.log(`[${taskId}] 已暂停（当前在跑的片段会跑完）`);
    return { success: true };
  }

  resumeTask(taskId) {
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (!this.pausedTasks.has(taskId)) return { success: false, error: '任务未处于暂停状态' };
    this.pausedTasks.delete(taskId);
    taskManager.updateTaskStatus(taskId, 'generating', { currentStep: '视频片段生成' });
    console.log(`[${taskId}] 已继续`);
    return { success: true };
  }

  isPaused(taskId) {
    return this.pausedTasks.has(taskId);
  }

  // 等待恢复；超时或任务已从运行集合移除（被取消/结束）时返回 false
  async _waitIfPaused(taskId, maxWaitMs = 30 * 60 * 1000) {
    if (!this.pausedTasks.has(taskId)) return true;
    const start = Date.now();
    while (this.pausedTasks.has(taskId)) {
      if (!this.runningTasks.has(taskId)) return false;  // 任务已结束/取消
      if (Date.now() - start > maxWaitMs) return false;
      await this._sleep(500);
    }
    return true;
  }

  async _batchGenerate(taskId, generator) {
    const task = taskManager.getTask(taskId);
    if (!task) return; // 任务已删除，直接结束批量生成

    // 补跑复用：已经成功的片段不再重新生成。
    //
    // 这是「补跑省钱」的关键落点。若不复用，补跑会把整批片段重新生成一遍，
    // 既重复花钱，又可能覆盖掉之前满意的成片素材（实测踩过：补跑到 final 时片段全被重生成）。
    //
    // 判定条件同时看状态与文件：status==='success' 但文件已被删除的片段，必须重新生成，
    // 否则后续拼接会在缺少输入的情况下失败。
    const reusable = new Set();
    for (const clip of (task.clips || [])) {
      if (clip.status !== 'success') continue;
      const resolved = this._resolveClipPath(clip.videoPath);
      if (resolved) reusable.add(clip.index);
    }
    if (reusable.size > 0) {
      console.log(`[${taskId}] 复用 ${reusable.size}/${task.totalClips} 个已成功片段，不重新生成`);
    }

    let activeWorkers = 0;
    let currentIndex = 0;
    const total = task.totalClips;
    // 统计：本次复用了多少片段、真正生成了多少（返回给上层判断是否标记 reused）
    let skippedReused = 0;
    let generated = 0;

    return new Promise((resolve) => {
      const startWorker = async () => {
        while (currentIndex < total) {
          // 暂停检查点：在取下一个片段之前拦住。
          // 放在 currentIndex++ 之前，保证暂停不会跳号丢弃片段。
          if (this.pausedTasks.has(taskId)) {
            const stillRunning = await this._waitIfPaused(taskId);
            if (!stillRunning) return;  // 任务已结束/取消
          }
          if (!this.runningTasks.has(taskId)) return;  // 已被取消
          const index = currentIndex++;
          if (reusable.has(index)) {
            // 该片段已成功且文件在，跳过生成（补跑场景）
            skippedReused++;
            continue;
          }
          await this._processSingleClip(taskId, index, generator);
          generated++;

          const prog = taskManager.getProgress(taskId);
          if (!prog) return; // 任务已删除，退出当前 worker
          if (prog.success + prog.failed >= total) {
            break;
          }
        }

        activeWorkers--;
        if (activeWorkers === 0) {
          resolve({ reused: skippedReused, generated });
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
        // 计时：生成/下载 与 质检 分段记录。历史片段没有这两个字段，
        // 片段库会如实标成「只有总时长」，不拿总时长冒充生成耗时。
        const genStartedMs = Date.now();
        const timing = { genStartedAt: new Date(genStartedMs).toISOString() };

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
          // 每次下载用不覆盖的新文件名：旧名会让第 2 次尝试覆盖第 1 次的付费产物。
          const localPath = this._nextClipPath(taskId, index);
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
        timing.genCompletedAt = new Date().toISOString();
        timing.genMs = Date.now() - genStartedMs;

        // 片段质检（黑帧/模糊/重复/时长/NSFW）
        // 第三个参数必须传：checkClip 会把它透传给 NSFW 检测。
        // 之前漏传，导致 NSFW 只认 .env 全局 key，前端填的多模态配置完全无效。
        console.log(`[${taskId}] 片段 ${index + 1} 质检中...`);
        timing.qcStartedAt = new Date().toISOString();
        const qcRuntime = task.runtimeConfig || {};
        const qcResult = await qualityChecker.checkClip(videoPath, task.clipDuration, {
          nsfw: {
            apiKey: qcRuntime.multimodalApiKey,
            baseUrl: qcRuntime.multimodalBaseUrl,
            model: qcRuntime.multimodalModel,
            // Mock 片段是 ffmpeg 合成的测试图案，不来自任何外部素材，内容可证明安全。
            // 对它做 NSFW 检测既无意义，又会在没配多模态 Key 时让整条演示链路全盘失败
            // （实测：10 片段任务全部 failed，错误「多模态调用失败/超时」）。
            // 传下去让 checkNSFW 走「合法跳过」（legitimateSkip）而不是「未执行→判 fail」。
            syntheticSource: this._isSynthetic(task)
          },
          // 用户勾选的「要紧项」；不传=全部要紧。NSFW 由 qualityChecker 内部锁定。
          strictItems: Array.isArray(qcRuntime.strictQcItems) && qcRuntime.strictQcItems.length
            ? qcRuntime.strictQcItems
            : undefined
        });

        // §9B 视觉内容质检（并联：与技术质检任一失败即触发重试）
        //
        // 历史缺陷：这里曾对 Mock 模式直接返回 { passed:true, skipped:true }，
        // 下方判定又按「passed 为真」放行，等于用 skipped 冒充通过（违反 §4.1）。
        // 现在按两项分开处理：
        //
        // 1) NSFW 合规检测 —— **Mock 模式也必须执行**。合成画面天然安全，真实调用不会误杀；
        //    但若 API Key 缺失，「未执行」一律判 fail（由 checkNSFW 内部保证），
        //    不允许因为「是演示模式」就跳过合规项。该项已由上面的 checkClip 内部执行，
        //    这里只做存在性断言，防止将来有人从 checkClip 里摘掉它。
        //
        // 2) 内容匹配（画面是否符合提示词）—— 对合成纯色/渐变画面**业务上不适用**，
        //    这是唯一合法的跳过类型，返回 legitimateSkip:true 并写明理由。
        //    用户主动关闭（rc.visualQC === false）同样按合法跳过记录。
        const rc = task.runtimeConfig || {};

        const nsfwDetail = (qcResult.details && qcResult.details.nsfw) || null;
        if (!nsfwDetail) {
          // 合规项缺失即不通过：不能因为 Mock 就当作没这项
          qcResult.passed = false;
          qcResult.reason = '合规质检缺失：片段质检结果中未包含 NSFW 检测';
          qcResult.failedCount = (qcResult.failedCount || 0) + 1;
        }

        const isMockRender = this._isSynthetic(task);
        const userDisabled = rc.visualQC === false;
        let contentResult;
        if (isMockRender) {
          contentResult = {
            passed: false,
            skipped: true,
            legitimateSkip: true,
            reason: '视觉内容匹配不适用于合成画面（演示模式）；NSFW 合规检测仍已执行',
            level: 'skip'
          };
        } else if (userDisabled) {
          contentResult = {
            passed: false,
            skipped: true,
            legitimateSkip: true,
            reason: '用户已关闭视觉内容匹配；NSFW 合规检测不受影响',
            level: 'skip'
          };
        } else {
          contentResult = await qualityChecker.checkContentMatch(videoPath, clip.prompt, {
            apiKey: rc.multimodalApiKey || rc.llmApiKey,
            baseUrl: rc.multimodalBaseUrl || rc.llmBaseUrl,
            model: rc.multimodalModel || rc.llmModel
          });
        }
        qcResult.details = qcResult.details || {};
        qcResult.details.contentMatch = contentResult;
        // 只有「真正执行过且失败」才拉低结论。
        //
        // 注意不要在这里把 skipped 一律判 fail：checkContentMatch 在无多模态 Key 时
        // 返回的是 { passed:true, skipped:true }（既有语义：内容匹配属业务参考项，
        // 未配置不影响主流程）。若这里把 skipped 当未通过，会让「没配多模态 Key」
        // 的真实任务全部失败——那是本次修复范围之外的回归。
        // 真正兜底合规的是 NSFW（上面已做存在性断言），不是内容匹配。
        const legitSkip = contentResult.legitimateSkip === true;
        if (!contentResult.passed && !legitSkip) {
          if (qcResult.passed) {
            qcResult.passed = false;
            qcResult.reason = `视觉质检失败: ${contentResult.reason}`;
            qcResult.failedCount = (qcResult.failedCount || 0) + 1;
          }
        }
        taskManager.setQCResult(taskId, index, qcResult);

        if (qcResult.passed) {
          this._finishClipSuccess(taskId, index, attempt, timing, {});
          console.log(`[${taskId}] 片段 ${index + 1} ✅ 成功`);
          return;
        } else {
          console.log(`[${taskId}] 片段 ${index + 1} 质检失败: ${qcResult.reason}`);

          // ===== 关键：区分「内容不合格」与「检测器根本没跑起来」=====
          //
          // 实测事故（2026-10-19）：一个 10 片段 720p 任务，前 4 个片段各生成 2 次，
          // 8 次调用全部因为「NSFW 检测未执行：多模态调用失败/超时」被判失败，
          // 每次 ¥3，合计白烧 ¥24，最终 0 个成功片段、产物全丢弃。
          //
          // 问题在于：视频**已经生成出来了**，只是没检测成。
          // 把「检测器不可用」当成「内容不合格」去重新生成，既浪费钱又拿不到片。
          // 正确语义（§4.1 三态）：内容**未验证**，不是**不通过**。
          //
          // 因此：检测器不可用时 —— 保留产物、不重试、明确标记 unverified。
          // 片段仍可参与拼接出片，但质检结论如实记为「未验证」，不冒充通过。
          const isDetectorDown =
            qcResult.detectorUnavailable === true ||
            qcResult.detectorError === true ||
            qcResult.legitimateSkip === true;

          if (isDetectorDown) {
            this._finishClipSuccess(taskId, index, attempt, timing, { qcUnverified: true });
            console.log(
              `[${taskId}] 片段 ${index + 1} ⚠️ 保留（质检未执行，标记未验证；不重试以免重复扣费）`
            );
            return;
          }

          if (attempt > this.maxRetries) {
            this._finishClipFailure(taskId, index, attempt, '质检未通过: ' + (qcResult.reason || ''), timing);
            return;
          }
          await this._sleep(1000 * attempt);
        }

      } catch (error) {
        console.log(`[${taskId}] 片段 ${index + 1} 生成失败 (第${attempt}次): ${error.message}`);

        // 无剩余重试次数，或错误不可重试（402 余额不足/401 鉴权失败）→ 直接判失败
        if (attempt > this.maxRetries || !generator.canRetry(error)) {
          this._finishClipFailure(taskId, index, attempt, error.message, timing);
          return;
        }
        await this._sleep(2000 * attempt);
      }
    }

    this._finishClipFailure(taskId, index, this.maxRetries + 1, '重试次数超限', null);
  }

  // 片段成功的统一收口：写状态 + 计时 + 费用 + 片段库入库。
  // 所有成功分支都必须走这里，否则会出现「片段成功但库里没有/费用缺失」的漏记。
  _finishClipSuccess(taskId, index, attempt, timing, extra = {}) {
    const task = taskManager.getTask(taskId);
    const t = timing || {};
    if (t.qcStartedAt) {
      t.qcCompletedAt = t.qcCompletedAt || new Date().toISOString();
      t.qcMs = Math.max(0, new Date(t.qcCompletedAt).getTime() - new Date(t.qcStartedAt).getTime());
    }
    if (t.genStartedAt) {
      t.totalMs = Math.max(0, Date.now() - new Date(t.genStartedAt).getTime());
    }
    const cost = pricing.computeClipCost({
      model: task.model,
      resolution: task.resolution,
      clipDurationSec: task.clipDuration,
      modelId: task.runtimeConfig && task.runtimeConfig.modelId
    }, attempt);
    const clip = taskManager.updateClip(taskId, index, {
      status: 'success',
      attempts: attempt,
      timing: t,
      cost,
      ...extra
    });
    // 入库：mock 模式在 library.ingestClip 内部直接跳过
    try {
      library.ingestClip(taskManager.getTask(taskId), clip);
    } catch (e) {
      console.warn(`[library] 片段入库异常 ${taskId}#${index + 1}: ${e.message}`);
    }
    return clip;
  }

  // 片段最终失败：写状态 + 计时 + 费用；重新生成任务额外把失败记到旧库条目上
  _finishClipFailure(taskId, index, attempt, error, timing) {
    const task = taskManager.getTask(taskId);
    if (!task) return null;
    const t = timing || {};
    if (t.genStartedAt) {
      t.totalMs = Math.max(0, Date.now() - new Date(t.genStartedAt).getTime());
    }
    const cost = pricing.computeClipCost({
      model: task.model,
      resolution: task.resolution,
      clipDurationSec: task.clipDuration,
      modelId: task.runtimeConfig && task.runtimeConfig.modelId
    }, attempt);
    const clip = taskManager.updateClip(taskId, index, {
      status: 'failed',
      error,
      attempts: attempt,
      timing: t,
      cost
    });
    if (task.source === 'regenerate' && task.regeneratedFrom) {
      try {
        library.markRegenerateFailed(task.regeneratedFrom, taskId, error, attempt);
      } catch (e) {
        console.warn(`[library] 记录重新生成失败异常: ${e.message}`);
      }
    }
    return clip;
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
