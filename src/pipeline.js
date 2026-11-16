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
// 场景卡（P4）：运行时拼提示词 / 不放回取卡 / buffer 替换
const sceneCards = require('./sceneCards');
const promptComposer = require('./promptComposer');
const { resolveResume } = require('./pipelineStages');
const llmService = require('./services/llmService');
const pricing = require('./pricing');
const budget = require('./budget');
const library = require('./library');
const photoLibrary = require('./photoLibrary');
// 出图（2026-11-16）：逐段出首帧图 → 图生视频 + 审图暂停（契约 §1/§2）
const imageGen = require('./generators/imageGen');
const objectStore = require('./storage/objectStore');
const dashscopeUpload = require('./generators/dashscopeUpload');
const { getI2VInfo } = require('./generators/i2vSupport');

const CLIPS_DIR = config.STORAGE.clipsDir;
const OUTPUT_DIR = config.STORAGE.outputDir;

// 片段级「硬闸门」：只有这些项失败才拦片段。
// 模糊/重复帧/内容匹配对 AI 风光片容易误判（慢镜头、浅景深），只警告、不触发重生成。
// NSFW 在 qualityChecker 内部永远是硬项，这里列出只是让语义完整。
const HARD_QC_ITEMS = ['blackFrame', 'duration', 'nsfw'];

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
      this.pausedTasks.delete(taskId);  // 任务结束，清掉暂停标记
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

    // 图生视频：重生成单片段也要带首帧图，否则片段级 i2v 任务会退化成纯文生视频。
    // 出图 → 图生视频任务同样受「缺首帧图禁止降级」约束（契约 §2.5 的同一原则；
    // 单片段重生成是另一条视频生成入口，绕过 _batchGenerate 的守卫会静默退化成文生视频）。
    if (this._imageFirstEnabled(task)) {
      const frame = this._approvedClipPhoto(task.clips[index]);
      if (!frame.ok) {
        this._finishClipFailure(taskId, index, 0, frame.reason, { genStartedAt: new Date().toISOString() });
        taskManager.updateTaskStatus(taskId, 'failed', {
          error: frame.reason,
          failureCode: 'missing_first_frame'
        });
        console.error(`[${taskId}] ⛔ 片段 ${index + 1} ${frame.reason}（未发起视频请求）`);
        return;
      }
    }
    const i2vImage = await this._i2vPayload(task, task.clips[index]);
    await this._processSingleClip(taskId, index, generator, i2vImage);

    // autoRetry=false：单条重生成后如果还有别的失败片段，仍然不重拼，
    // 避免「只修好一条就把缺片的成片拼出来」。
    const afterRegen = taskManager.getTask(taskId) || task;
    const stillFailed = this._failedClipSummaries(afterRegen);
    if (afterRegen.autoRetry === false && stillFailed.length > 0) {
      const list = stillFailed.map(f => `#${f.index} ${f.reason}`).join('；');
      taskManager.updateTaskStatus(taskId, 'failed', {
        error: `仍有 ${stillFailed.length} 个片段失败：${list}。未重拼；请继续重生成失败片段。`,
        failedClips: stillFailed
      });
      return;
    }

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
        ? await transitionMixer.concatWithTransitions(this._sceneCardConcatInputs(task, successClips), concatPath, {
          duration: trans.duration,
          type: trans.type,
          resolution: task.resolution,
          fps: 30,
          // 校色：默认关；转场关闭时不会走到这里（走 -c copy），由终检报「未执行」
          colorMatch: this._colorMatchOptions(task)
        })
        // 转场关闭时不再对原始模型输出直接 -c copy：
        // 分辨率/帧率/像素格式不一致会静默产出黑帧、重复帧、DTS 错乱。
        // concatenateSegments 会先探测，只重编码不匹配的片段，再做完整解码校验。
        : await videoProcessor.concatenateSegments(
          this._sceneCardConcatInputs(task, successClips),
          concatPath,
          { resolution: task.resolution, fps: 30 }
        );

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
        // 补跑路径同样要留痕，否则终检拿不到「转场/校色实际执行了什么」
        qcDetails: concatResult.colorMatch
          ? {
            ...concatQC,
            colorMatch: concatResult.colorMatch,
            ...(this._isSceneCardTask(task) ? { sceneCardGrading: concatResult.adjust || null } : {})
          }
          : concatQC
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
      { resolution: task.resolution, fps: 30, ...this._adjustOptionsFor(task) }
    );

    if (!transcodeResult.success) {
      taskManager.recordStepComplete(taskId, 'transcoding', {
        status: 'failed',
        qcResult: 'fail',
        error: '转码失败: ' + transcodeResult.error
      });
      throw new Error('转码失败: ' + transcodeResult.error);
    }

    // 调节自检（2026-11-02）：请求了 adjust 却没生成滤镜 → 判失败，不让它静默变成「没调色」。
    // 与「校色未执行」同一套语义（AGENTS §4.1：没执行 = 没通过，不是跳过）。
    this._assertAdjustApplied(taskId, task);

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
    try { library.ingestFinal(taskManager.getTask(taskId) || task, finalPath); }
    catch (e) { console.warn(`[${taskId}] 恢复成片入库失败: ${e.message}`); }
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
        loudness: (task.bgm && task.bgm.volume) || config.BGM.loudness,
        ambientVolume: (task.bgm && task.bgm.ambientVolume) || 0.125,
        // 闪避：全局配置默认关（BGM_DUCKING_ENABLED=false），不影响既有成片听感
        ducking: config.BGM.ducking
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
      try { library.ingestFinal(taskManager.getTask(taskId) || task, finalPath); }
      catch (e) { console.warn(`[${taskId}] 重建母版入库失败: ${e.message}`); }
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
      // 出图运行时配置（2026-11-16 契约 §1）：补跑/重生成要带 Key，否则重启后出图必失败。
      'imageApiKey', 'imageBaseUrl', 'imageProvider', 'imageModel', 'imageSize',
      'imagePerClip',
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

  // ===== 剪映「调节」复刻（2026-10-31）=====
  // 运行时自检（2026-11-02）：请求了调节就必须真的执行。
  // 若任务带 adjust、但转码时没有生成滤镜（例如有人改流水线把参数传丢、或滤镜生成异常），
  // 这里判「调节未执行」并让任务失败 —— 绝不让成片静默变成「没调色」。
  // 与既有「校色未执行」同一套三态语义（AGENTS §4.1）。
  _assertAdjustApplied(taskId, task) {
    if (!config.ADJUST || !config.ADJUST.enabled) return;
    if (!task || !task.adjust) return;
    if (task.adjustApplied && task.adjustApplied.filter) return;
    const msg = '调节未执行：任务请求了 adjust，但转码时没有生成调节滤镜';
    try {
      taskManager.recordStepComplete(taskId, 'transcoding', {
        status: 'failed',
        qcResult: 'fail',
        error: msg
      });
    } catch (e) {
      console.warn(`[${taskId}] 记录调节自检失败时出错: ${e.message}`);
    }
    console.error(`[${taskId}] ❌ ${msg}`);
    throw new Error(msg);
  }

  // 返回可直接塞进 ffmpeg -vf 的滤镜串；没有调节 / 全局关闭 / 参数非法 → 返回 ''。
  // 调用方把它作为 transcode 的 options.adjustFilter 传下去，**只作用一次**（在产出
  // master/final 的那一步转码里），不会在后续 -c:v copy 的步骤里重复叠加。
  // 失败时**降级为不调节并打日志**，绝不静默把失败当成成功（AGENTS §4.1 的语义精神）。
  _adjustOptionsFor(task) {
    if (!config.ADJUST || !config.ADJUST.enabled) return {};
    const params = task && task.adjust;
    if (!params || typeof params !== 'object') return {};
    try {
      const adjust = require('./processors/adjustChain');
      if (!adjust.hasAdjust(params)) return {};
      const r = adjust.prepareAdjust(params, {
        cubeDir: config.ADJUST.cubeDir,
        lutDir: config.ADJUST.lutDir,
        ffmpegPath: config.FFMPEG_PATH
      });
      if (!r || !r.filter) return {};
      task.adjustApplied = { filter: r.filter, cubePath: r.cubePath || null };
      console.log(`[${task.taskId}] 调节滤镜: ${r.filter}`);
      return { adjustFilter: r.filter, adjustCwd: require('path').dirname(r.cubePath) };
    } catch (e) {
      console.warn(`[${task && task.taskId}] 调节滤镜生成失败，已降级为不调节: ${e.message}`);
      return {};
    }
  }

  // ===== 片段间转场：解析任务级覆盖 + 全局默认 =====
  //
  // 只决定「接缝要不要做交叉淡化」，不影响档位/片段数量。
  // enabled=false 时调用方必须走原来的 concatenate（硬切），保证默认行为零变化。
  _transitionOptions(task) {    const global = (config.TRANSITIONS && typeof config.TRANSITIONS === 'object') ? config.TRANSITIONS : {};
    const t = (task && task.transition && typeof task.transition === 'object') ? task.transition : {};
    const enabled = typeof t.enabled === 'boolean' ? t.enabled : !!global.enabled;
    const duration = Number.isFinite(Number(t.duration)) && Number(t.duration) > 0
      ? Number(t.duration)
      : (Number.isFinite(Number(global.duration)) && Number(global.duration) > 0 ? Number(global.duration) : 0.5);
    const type = (typeof t.type === 'string' && t.type) || global.type || 'fade';

    // 档位策略（2026-10-27）：`quick` 档求快，**强制** -c copy 直拼，不做转场。
    // 依据 docs/spec/seam-quality-spec.md §9 实测：copy 0.46s / 重编码 8.13s / 转场 11.36s，
    // 放弃 -c copy 会慢 17.6×。快速验证档的产物本来就不用于交付，没必要付出这个代价。
    // 这里是**唯一**的转场判定入口（4 处拼接路径都走它），所以只需改这一处。
    if (task && String(task.preset) === 'quick') {
      return { enabled: false, duration, type, disabledByPreset: 'quick' };
    }

    return { enabled, duration, type };
  }

  // 校色（colorMatch）开关：默认关，必须由任务显式开启（或 .env 的 COLOR_MATCH_ENABLED）。
  // 与转场互斥：转场关闭时走 -c copy，不重编码也就无从校色 —— 那种情况由
  // _colorContinuityQcOptions 报 skipped，绝不当作「校过色」。
  _colorMatchOptions(task) {
    const qc = (config.QC && typeof config.QC === 'object') ? config.QC : {};
    const t = (task && task.colorMatch && typeof task.colorMatch === 'object') ? task.colorMatch : {};
    const enabled = typeof t.enabled === 'boolean'
      ? t.enabled
      : qc.colorMatchEnabled === true;
    const maxGain = Number.isFinite(Number(t.maxGain)) && Number(t.maxGain) > 0
      ? Number(t.maxGain)
      : (Number.isFinite(Number(qc.colorMatchMaxGain)) && Number(qc.colorMatchMaxGain) > 0
        ? Number(qc.colorMatchMaxGain)
        : 0.15);
    return { enabled, maxGain };
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

  // ===== 场景卡模式（P4）=====
  // 场景卡是唯一场景输入：运行时按「卡」拼提示词；卡只读、不回写。
  // 主题仅在调用方显式配置时作为氛围参数，不把用户整句注入每段（2026-11-16 用户口径）。
  // 取卡计划在任务创建时写入；这里再做一次幂等兜底，覆盖两种路径：
  //   1) 老代码/脚本直接 createTask 未带 sceneCards，但任务标记了场景卡模式；
  //   2) 任务在保存/恢复过程中丢了 sceneCards 字段。
  _isSceneCardTask(task) {
    return !!(task && task.sceneCards && task.sceneCards.enabled);
  }

  // 确保任务有一轮完整取卡计划（缺则重新取一轮：按 chapter+sequence、不放回）。
  _ensureSceneCardPlan(taskId) {
    let task = taskManager.getTask(taskId);
    if (!this._isSceneCardTask(task)) return task;
    const used = Array.isArray(task.sceneCards.used) ? task.sceneCards.used.length : 0;
    if (used === task.totalClips) return task;
    const plan = sceneCards.allocate(task.totalClips); // 不足会抛 SCENE_CARDS_EXHAUSTED，不静默复用
    task = taskManager.setSceneCards(taskId, plan) || taskManager.getTask(taskId);
    console.log(`[${taskId}] 场景卡补取一轮：${task.totalClips} 张（round ${plan.roundId}）`);
    return task;
  }

  // 逐片段拼提示词（只在内容不一致时写回，避免 180 次无意义的存盘/推送）。
  _composeSceneCardPrompts(taskId) {
    let task = this._ensureSceneCardPlan(taskId);
    if (!this._isSceneCardTask(task)) return null;
    let updated = 0;
    for (const clip of task.clips) {
      const entry = task.sceneCards.used[clip.index];
      if (!entry) {
        const e = new Error(`场景卡计划缺少第 ${clip.index + 1} 段（sceneCards.used 长度不足）`);
        e.code = 'SCENE_CARDS_MISSING_ENTRY';
        throw e;
      }
      const card = sceneCards.getCardById(entry.id);
      if (!card) {
        const e = new Error(`场景卡缺失：${entry.id}（卡库文件可能被替换，请核对 assets/scene-cards/v3.3-final.json）`);
        e.code = 'SCENE_CARDS_MISSING_CARD';
        throw e;
      }
      const patch = promptComposer.composeClipPatch(card, {
        theme: clip.theme ?? task.theme
      });
      const changed = clip.prompt !== patch.prompt
        || clip.promptSource !== 'scene-card'
        || clip.sceneCardId !== patch.sceneCardId
        || JSON.stringify(clip.adjust || null) !== JSON.stringify(patch.adjust || null);
      if (changed) {
        taskManager.updateClip(taskId, clip.index, patch);
        updated += 1;
      }
    }
    task = taskManager.getTask(taskId);
    return { task, updated, plan: task.sceneCards };
  }

  // 生成失败 → 用缓冲区卡替换该片段（同一轮内 buffer 不复用）。
  // 只在「还有重试机会」时调用：不额外增加付费调用次数，仍受任务/档位原有的重试预算约束。
  _replaceSceneCardOnFailure(taskId, index, reason) {
    const task = taskManager.getTask(taskId);
    if (!this._isSceneCardTask(task)) return null;
    const replaced = sceneCards.replaceWithBuffer(task.sceneCards, index, reason);
    if (!replaced) {
      console.warn(`[${taskId}] 片段 ${index + 1} 生成失败，但缓冲区卡已用尽/已替换过，保留失败结果`);
      return null;
    }
    const clip = task.clips[index] || {};
    const patch = promptComposer.composeClipPatch(replaced.card, {
      theme: clip.theme ?? task.theme
    });
    taskManager.updateClip(taskId, index, {
      ...patch,
      sceneCardReplacement: {
        fromSceneKey: replaced.entry.replacedFrom ? replaced.entry.replacedFrom.scene_key : null,
        fromCardId: replaced.entry.replacedFrom ? replaced.entry.replacedFrom.id : null,
        reason: reason ? String(reason).slice(0, 500) : '',
        at: replaced.buffer.at
      }
    });
    taskManager.setSceneCards(taskId, replaced.plan);
    return replaced;
  }

  // 场景卡（P4）：把成功片段路径映射成拼接输入对象（逐段带 palette adjust）。
  // 参数化调色只在「转场重编码」路径生效；不是场景卡任务时只返回 { path }（行为不变，
  // 但必须是对象：videoProcessor.concatenateSegments 只认 s.path）。
  _sceneCardConcatInputs(task, successClips) {
    const byPath = new Map();
    if (this._isSceneCardTask(task)) {
      for (const c of (task.clips || [])) {
        if (!c || !c.adjust || typeof c.adjust !== 'object') continue;
        const p = this._resolveClipPath(c.videoPath);
        if (p) byPath.set(p, c.adjust);
      }
    }
    return successClips.map(p => ({
      path: p,
      ...(byPath.has(p) ? { adjust: byPath.get(p) } : {})
    }));
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

  // 任务是否「确实已经开始过」（契约 §2.6 收窄版的 startedAlready）。
  // 用于区分「补跑一个跑过一半的任务」与「对从未启动的 pristine 任务点补跑」：
  // 后者应保持原报错（请先跑完到拼接步骤），不能被当成补跑直接启动。
  _taskStartedAlready(task, completed) {
    if (!task) return false;
    if (Array.isArray(completed) && completed.length > 0) return true;
    if (task.imageReview) return true;
    const steps = task.steps || {};
    if (Object.values(steps).some(v => v && ['completed', 'reused', 'failed', 'partial'].includes(v.status))) {
      return true;
    }
    if (Array.isArray(task.clips) && task.clips.some(c => (Number(c && c.attempts) || 0) > 0)) return true;
    return false;
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
          fps: 30,
          // 校色：默认关；转场关闭时不会走到这里（走 -c copy），由终检报「未执行」
          colorMatch: this._colorMatchOptions(task)
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

    const tr = await videoProcessor.transcode(loopTmp, master, { resolution: task.resolution, fps: 30, ...this._adjustOptionsFor(task) });
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
        const usedPhotoId = clip.photoId || task.sourcePhotoId;
        if (usedPhotoId) {
          try { photoLibrary.attachUsage(usedPhotoId, taskId); } catch (e) { /* 追溯失败不影响质检 */ }
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
      // 契约 §2.6（2026-11-16 14:20 收窄版）：本次会跑 clip_generation 的任务不该被这道
      // 「需要拼接产物」的闸门拦住（片还没生成时永远补跑不了）。
      // 但**从未启动过的 pristine 任务**仍保持原报错——那不是补跑，是直接启动。
      const startedAlready = this._taskStartedAlready(task, completed);
      const willGenerateClips = resume.pending.includes('clip_generation');
      if (!(willGenerateClips && startedAlready)) {
        return {
          success: false,
          error: '补跑需要拼接产物，但拼接尚未完成；请先跑完到拼接步骤',
          resume
        };
      }
      console.log(
        `[${taskId}] 补跑闸门放行：本次 pending 含 clip_generation 且任务已启动过`
        + '（不再要求已有拼接产物）'
      );
    }

    // 审图结算（契约 §2.4）：用户点「补跑」= 视为通过未单独审核的图；
    // 被打回的图 → 对应片段直接 failed。幂等（reviewedAt 已存在则直接返回）。
    const settled = this._settleImageReview(taskId, 'continue');
    if (settled.settled && settled.rejectedClips.length) {
      console.warn(`[${taskId}] 补跑前审图结算：${settled.rejectedClips.length} 段图片被打回，这些片段不会生成视频`);
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
    const fresh = taskManager.getTask(taskId);
    return {
      success: true,
      taskId,
      resume,
      reused: proposedReused,
      pending: resume.pending,
      // 契约 §3.4：成功响应可带 imageReview 摘要（出图链路任务）
      imageReview: (fresh && fresh.imageReview) || null,
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
      },
      // 片段接缝质检（2026-10-27 新增）：终检要知道「缝在哪」。
      // 三处 checkFinal 都走本方法，所以只改这一处即可全覆盖。
      seam: this._seamQcOptions(task),
      // 镜头级色彩连续性（2026-10-27 新增）：与 seam 共用缝位置，额外带「校色到底执行没有」
      colorContinuity: this._colorContinuityQcOptions(task)
    };
  }

  // 组装接缝质检所需输入：各成功片段的时长（缝位置）+ 实际使用的淡化时长。
  //
  // 两个容易搞错的地方：
  //  1) 只有 success 的片段会参与拼接，失败片段不能算进缝位置；
  //  2) 淡化时长以「拼接步骤的实际留痕」为准 —— 补跑/复用历史产物时，
  //     当前配置（TRANSITION_ENABLED 默认已改为 true）可能与当初实际执行的不一致，
  //     用当前配置算缝位置会整体偏移，把好片判成坏片。
  _seamQcOptions(task) {
    if (!task) {
      return { legitimateSkip: true, skipReason: '接缝质量按设计跳过：无任务上下文，无法定义接缝' };
    }
    // 合成素材（Mock）画面是 ffmpeg 测试图案，「接缝是否自然」对它没有业务意义，
    // 与 NSFW/内容匹配对 Mock 的既有口径一致（见 _isSynthetic 的用法）。
    if (this._isSynthetic(task)) {
      return { legitimateSkip: true, skipReason: '接缝质量按设计跳过：Mock 合成素材，接缝无业务意义' };
    }
    const clips = (Array.isArray(task.clips) ? task.clips : [])
      .filter(c => c && c.status === 'success')
      .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    const clipDurations = clips
      .map(c => Number(c.duration))
      .filter(n => Number.isFinite(n) && n > 0);

    let fadeDuration = 0;
    const applied = task.steps
      && task.steps.concatenation
      && task.steps.concatenation.qcDetails
      && task.steps.concatenation.qcDetails.transition;
    if (applied && Number(applied.transitions) > 0 && Number.isFinite(Number(applied.fadeDuration))) {
      fadeDuration = Number(applied.fadeDuration);   // 以实际留痕为准
    } else {
      const t = this._transitionOptions(task);
      fadeDuration = t.enabled ? t.duration : 0;
    }
    return { clipDurations, fadeDuration };
  }

  // 镜头级色彩连续性（checkColorContinuity）的输入：与接缝共用「缝在哪」，
  // 额外带上「校色是否真的执行了」——这条是本项的关键可观测字段（§4.1）：
  //   disabled：校色默认关，没要求 → 合法跳过「校色」这件事，但仍照常测色差，不判失败；
  //   skipped ：任务要了 colorMatch 但没做成（转场关闭 / 版本未接入）→ QC 必须看到「未执行」；
  //   failed  ：执行报错（批次 2 接入后由 transitionMixer 回传）。
  // 只有 applied 才代表真的校过色。
  _colorContinuityQcOptions(task) {
    if (!task) {
      return {
        legitimateSkip: true,
        skipReason: '镜头色彩连续性按设计跳过：无任务上下文，无法定义镜头间断点',
        colorMatchState: 'disabled',
        colorMatchReason: ''
      };
    }
    if (this._isSynthetic(task)) {
      return {
        legitimateSkip: true,
        skipReason: '镜头色彩连续性按设计跳过：Mock 合成素材，色调连续性无业务意义',
        colorMatchState: 'disabled',
        colorMatchReason: ''
      };
    }

    const seamOpt = this._seamQcOptions(task);
    const clipDurations = Array.isArray(seamOpt.clipDurations) ? seamOpt.clipDurations : [];
    const fadeDuration = Number(seamOpt.fadeDuration) || 0;

    // 是否要求校色：与 _colorMatchOptions 同一判定（任务级优先，其次 .env 全局）
    const cmOpt = this._colorMatchOptions(task);
    const requested = cmOpt.enabled === true;

    // 优先看「拼接步骤的实际留痕」：这才是真的发生了什么。
    const recorded = task.steps
      && task.steps.concatenation
      && task.steps.concatenation.qcDetails
      && task.steps.concatenation.qcDetails.colorMatch;

    let colorMatchState = 'disabled';
    let colorMatchReason = '校色未开启（默认关，需任务显式开启 colorMatch）';

    if (recorded && typeof recorded.state === 'string') {
      // 有留痕就以留痕为准（applied / disabled / failed 由 transitionMixer 回传）
      colorMatchState = recorded.state;
      colorMatchReason = recorded.reason || ('校色状态：' + recorded.state);
      // 留痕说 applied 但当时转场其实没开？不可能，但保持一致性检查：
      if (colorMatchState === 'applied' && !requested) {
        colorMatchReason = '校色已执行（本次任务按 .env 全局开关开启）';
      }
    } else if (requested) {
      const trans = this._transitionOptions(task);
      colorMatchState = 'skipped';
      colorMatchReason = !trans.enabled
        ? '校色已请求但未执行：转场关闭（-c copy 直拼路径不校色）'
        : '校色已请求但未执行：拼接步骤没有留下校色记录（可能复用了旧产物）';
    }

    return { clipDurations, fadeDuration, colorMatchState, colorMatchReason };
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
    // 2026-10-31：补入 paused / regenerating / processing / optimizing。
    // 这 4 个状态以前不在白名单里，于是「暂停中重启」的任务会永远停在 paused：
    // pausedTasks 是内存 Set（重启即空），点「继续」必然得到「任务未处于暂停状态」，
    // 用户没有任何出口（见 docs/spec/pause-decision.md §4.1 的降级方案）。
    // paused 会被专门标注 failureCode='pause_interrupted'，前端据此区分
    // 「暂停被重启打断」与普通生成失败；其余三个是同类的历史中间态，一并回收。
    const IN_PROGRESS = ['pending', 'generating', 'concatenating', 'looping', 'transcoding', 'mixing',
      'paused', 'regenerating', 'processing', 'optimizing'];
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
      const wasPaused = prev === 'paused';
      if (wasPaused) this.pausedTasks.delete(t.taskId);  // 清掉可能残留的内存标记
      taskManager.updateTaskStatus(t.taskId, 'failed', {
        // 暂停中的任务不能"恢复"（内存 worker 已随进程消失），但必须给出明确出口：
        // 标 failed + failureCode='pause_interrupted'，文案指向「补跑」。
        error: wasPaused
          ? '暂停期间服务被重启，任务已中止（不会自动继续）。'
            + `已完成步骤：${done.length ? done.join('、') : '无'}。`
            + '已生成的片段保留，可点「补跑」从断点继续（不会重新生成已完成的片段）。'
          : `服务进程中断导致流水线停止（中断时状态：${prev}）。`
            + `已完成步骤：${done.length ? done.join('、') : '无'}。`
            + '可直接点「补跑」从断点继续，已生成的片段不会重新生成。',
        interruptedFrom: prev,
        interruptedAt: new Date().toISOString(),
        recoverable: wasPaused || done.length > 0,
        ...(wasPaused ? { failureCode: 'pause_interrupted' } : {})
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
      // 任务结束必须清掉暂停标记：
      // 否则「在拼接/转码阶段按了暂停（无检查点）」的任务跑完后会残留 isPaused=true，
      // 下一次同 id 任务或状态查询会读到错误的暂停态。
      this.pausedTasks.delete(taskId);
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
    const isSceneCardTask = this._isSceneCardTask(task);

    if (isSceneCardTask && !skipPromptStages) {
      // ===== 第1步（场景卡模式）：运行时拼提示词 + 提示词质检 =====
      // 卡是只读输入：这里只把「卡」拼成 clips[i].prompt，不写回卡库，也不把用户整句当氛围。
      // 分镜步骤随后标记为合法跳过（场景顺序已由 chapter+sequence 定死）。
      taskManager.recordStepStart(taskId, 'prompt_optimize');
      console.log(`[${taskId}] 步骤1: 场景卡提示词生成 + 质检`);
      const composed = this._composeSceneCardPrompts(taskId);
      let worstQC = { passed: true, level: 'pass', reason: '场景卡提示词质检通过' };
      for (const clip of composed.task.clips) {
        const qc = qualityChecker.checkPrompt(clip.prompt, clip.theme ?? task.theme);
        if (!qc.passed) worstQC = qc;
      }
      const promptQC = worstQC.passed
        ? { passed: true, level: 'pass', reason: '场景卡提示词质检通过' }
        : worstQC;
      await this._sleep(300);
      taskManager.recordStepComplete(taskId, 'prompt_optimize', {
        qcResult: promptQC.passed ? 'pass' : promptQC.level,
        qcDetails: {
          ...promptQC,
          promptSource: 'scene-card',
          composerVersion: promptComposer.SCENE_PROMPT_VERSION,
          roundId: composed.plan.roundId,
          sceneKeys: composed.plan.used.map(e => e.scene_key),
          updatedClips: composed.updated,
          note: '提示词由场景卡运行时拼出；卡只读，不写回'
        }
      });
      // 场景顺序 = 卡库 chapter+sequence；LLM 分镜会打乱卡序，属于业务上不适用。
      this._markStageSkipped(taskId, 'storyboard', task.preset,
        '场景卡模式：场景顺序由卡库 chapter+sequence 决定，无需 LLM 分镜');
    } else if (skipPromptStages) {
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
    // ===== 出图 → 图生视频前置步骤（2026-11-16 契约 §2.1/§2.3）=====
    // 位置：必须在 recordStepStart('clip_generation') 之前 —— 出图失败/审图没过时
    // 不能进入片段生成（那会真的花视频的钱）。出图本身不写 task.steps（契约要求），
    // 只记 task.imageReview + 日志；pipelineStages.ALL_STAGES 不动。
    if (this._imageFirstEnabled(task)) {
      const preStep = await this._runImageFirstPreStep(taskId, task);
      if (preStep) return preStep;
    }
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
    if (batchInfo && batchInfo.aborted) {
      // 硬中止（暂停超时）：状态已由 _waitIfPaused 写成 failed + failureCode='pause_timeout'。
      // 这里必须立刻结束流水线，否则下游步骤会把 paused/failed 覆盖成 concatenating，
      // 用户看到「暂停后自己跑完了，而且还少了几段」（pause-decision §4.2）。
      console.warn(`[${taskId}] ⏸ 暂停超时已中止流水线：不再继续拼接/循环/配乐（failureCode=pause_timeout）`);
      return { success: false, aborted: true, failureCode: 'pause_timeout' };
    }

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

    // 用户口径（2026-11-12）：autoRetry=false 时不许自动重生成。
    // 只要有片段没成功，就停在拼接前，把失败清单交给用户；不带着缺失片段出片。
    const failedSummaries = this._failedClipSummaries(taskManager.getTask(taskId) || task);
    if (task.autoRetry === false && failedSummaries.length > 0) {
      const list = failedSummaries.map(f => `#${f.index} ${f.reason}`).join('；');
      taskManager.recordStepComplete(taskId, 'clip_generation', {
        status: 'failed',
        qcResult: 'fail',
        error: `片段失败 ${failedSummaries.length}/${task.totalClips}，未进入拼接`
      });
      taskManager.updateTaskStatus(taskId, 'failed', {
        error: `片段失败：${list}。未拼接；请逐条重新生成失败片段后再补跑。`,
        failedClips: failedSummaries
      });
      console.log(`[${taskId}] ⛔ ${failedSummaries.length} 个片段失败；autoRetry=false，不重试、不拼接`);
      return { success: false, failedClips: failedSummaries, needsRetry: true };
    }

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
        outSec: c.trim && c.trim.outSec !== undefined ? c.trim.outSec : null,
        // 场景卡逐段参数化调色（仅转场重编码路径生效；其余路径忽略该字段）
        adjust: c.adjust && typeof c.adjust === 'object' ? c.adjust : null
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
          fps: 30,
          // 校色：默认关；转场关闭时不会走到这里（走 -c copy），由终检报「未执行」
          colorMatch: this._colorMatchOptions(task)
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
          // 校色实际状态（disabled/applied/failed）：终检据此判「校色未执行」
          colorMatch: concatResult.colorMatch,
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
        ? await transitionMixer.concatWithTransitions(this._sceneCardConcatInputs(task, successClips), concatPath, {
          duration: trans.duration,
          type: trans.type,
          resolution: task.resolution,
          fps: 30,
          // 校色：默认关；转场关闭时不会走到这里（走 -c copy），由终检报「未执行」
          colorMatch: this._colorMatchOptions(task)
        })
        // 转场关闭时不再对原始模型输出直接 -c copy：
        // 分辨率/帧率/像素格式不一致会静默产出黑帧、重复帧、DTS 错乱。
        // concatenateSegments 会先探测，只重编码不匹配的片段，再做完整解码校验。
        : await videoProcessor.concatenateSegments(
          this._sceneCardConcatInputs(task, successClips),
          concatPath,
          { resolution: task.resolution, fps: 30 }
        );

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
            },
            // 校色实际状态（disabled/applied/failed）：终检据此判「校色未执行」
            colorMatch: concatResult.colorMatch,
            // 场景卡 palette_id 参数化调色的实际执行数（null = 非场景卡任务）
            ...(this._isSceneCardTask(task) ? { sceneCardGrading: concatResult.adjust || null } : {})
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
        { resolution: task.resolution, fps: 30, ...this._adjustOptionsFor(task) }
      );

      if (!transcodeResult.success) {
        taskManager.recordStepComplete(taskId, 'transcoding', {
          status: 'failed',
          qcResult: 'fail',
          error: '转码失败: ' + transcodeResult.error
        });
        throw new Error('转码失败: ' + transcodeResult.error);
      }

      // 调节自检（2026-11-02）：请求了 adjust 却没生成滤镜 → 判失败，不静默变成「没调色」
      this._assertAdjustApplied(taskId, task);

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
    try {
      const finalTask = taskManager.getTask(taskId) || task;
      library.ingestFinal(finalTask, finalPath);
    } catch (e) {
      console.warn(`[${taskId}] 成片入库失败: ${e.message}`);
    }

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
  //
  // 已知限制（不实现，见 pause-decision §4.3）：拼接/循环/转码/配乐阶段没有检查点，
  // 这些阶段按暂停只会改状态字符串，不会真的停住 ffmpeg。
  //
  // 暂停上限：PAUSE_MAX_WAIT_MS（默认 30 分钟）。超时不再静默 `return false`，
  // 而是「日志 + 状态显式转 failed + failureCode='pause_timeout' + 中止流水线」，
  // 让前端能把「暂停超时」和普通生成失败区分开（pause-decision §4.2）。
  _pauseMaxWaitMs() {
    const raw = Number(process.env.PAUSE_MAX_WAIT_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 30 * 60 * 1000;
  }

  pauseTask(taskId) {
    const task = taskManager.getTask(taskId);
    if (!task) return { success: false, error: '任务不存在' };
    if (!this.runningTasks.has(taskId)) return { success: false, error: '任务未在运行' };
    // 幂等：重复 pause 返回 200 + 当前状态，不报错
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
    // 审图暂停后点「继续」：pending 图视为通过，被打回的图让对应片段失败（契约 §2.4）。
    // 幂等：不是出图暂停（无 imageReview）或被重复调用时自动跳过，不影响普通暂停。
    const settled = this._settleImageReview(taskId, 'unpause');
    taskManager.updateTaskStatus(taskId, 'generating', { currentStep: '视频片段生成' });
    console.log(`[${taskId}] 已继续`);
    return {
      success: true,
      approvedPhotos: settled.approvedPhotos,
      rejectedClips: settled.rejectedClips
    };
  }

  isPaused(taskId) {
    return this.pausedTasks.has(taskId);
  }

  // 等待恢复；返回 true=继续执行，false=不要继续（任务已结束 / 暂停超时被中止）
  async _waitIfPaused(taskId, maxWaitMs = this._pauseMaxWaitMs()) {
    if (!this.pausedTasks.has(taskId)) return true;
    const start = Date.now();
    while (this.pausedTasks.has(taskId)) {
      if (!this.runningTasks.has(taskId)) return false;  // 任务已结束/取消
      if (Date.now() - start > maxWaitMs) {
        // 不允许静默吞掉：日志 + 状态变更 + 可区分的 failureCode
        const limitText = maxWaitMs >= 60000
          ? `${Math.round(maxWaitMs / 60000)} 分钟`
          : `${Math.max(1, Math.round(maxWaitMs / 1000))} 秒`;
        console.error(`[${taskId}] ⏸ 暂停等待超过 ${limitText}（PAUSE_MAX_WAIT_MS=${maxWaitMs}），中止任务：不再生成后续片段。`);
        this.pausedTasks.delete(taskId);
        taskManager.updateTaskStatus(taskId, 'failed', {
          error: `暂停等待超过 ${limitText}，已中止任务（未继续生成后续片段）。`
            + '已完成的片段保留，可点「补跑」从断点继续。'
            + '（这是暂停超时，不是生成失败。）',
          failureCode: 'pause_timeout',
          pauseTimedOutAt: new Date().toISOString(),
          recoverable: true
        });
        return false;
      }
      await this._sleep(500);
    }
    return true;
  }

  // 图生视频（2026-11-11 用户口径）：任务带 sourcePhotoId 时，把图片库里「已通过」的图
  // 读成 base64 交给适配器。这里是唯一读图点：失败就让任务明确失败，不许静默退回文生视频。
  async _i2vPayload(task, clip = null) {
    // 每片段自己的图优先（图片优先链路）；没有则回退任务级 sourcePhotoId（旧口径）。
    const photoId = (clip && clip.photoId) || (task && task.sourcePhotoId);
    if (!task || !photoId) return null;
    const photo = photoLibrary.get(photoId);
    if (!photo) throw new Error(`图生视频的源图片不存在（${photoId}）`);
    if (photo.status !== 'approved') throw new Error('图生视频的源图片还没通过审核（请在「照片」页点通过）');
    let buf;
    try {
      buf = fs.readFileSync(photo.filePath);
    } catch (e) {
      throw new Error('读取图生视频的源图片失败: ' + e.message);
    }
    if (!buf || buf.length < 8) throw new Error('图生视频的源图片文件无效（空文件）');
    // 可灵官方上限 10MB，提前拦，别等厂商报错（其余厂商也普遍 ≤10MB）
    if (buf.length > 10 * 1024 * 1024) throw new Error('图生视频的源图片超过 10MB');
    const ext = path.extname(photo.filePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : (ext === '.webp' ? 'image/webp' : 'image/png');
    const base64 = buf.toString('base64');

    // 注意：这里只构建输入，不标记“已使用”。只有片段真正生成成功后才 attachUsage，
    // 否则上传/生成失败也会把图片标成已用（用户 2026-11-14 反馈的显示错误）。
    // wan3.0 图生视频需要 first_frame url。用户不想用自己的公网存储时，
    // 走百炼官方临时上传：getPolicy → OSS → oss://（48h，私有），
    // 视频请求加 X-DashScope-OssResourceResolve: enable。
    // 其它模型（可灵/Seedance/WhaleTV）仍用 base64/dataUrl，不额外上传。
    let url = null;
    let urlProtocol = null;
    if (task.model === 'dashscope') {
      const rc = task.runtimeConfig || {};
      const uploaded = await dashscopeUpload.uploadFile(photo.filePath, {
        apiKey: rc.apiKey || '',
        baseUrl: rc.apiBaseUrl || '',
        model: rc.modelId || 'wan3.0-video'
      });
      url = uploaded.url;
      urlProtocol = 'oss';
    } else {
      const i2vInfo = getI2VInfo(task.model);
      if (i2vInfo && i2vInfo.input === 'public-url') {
        const upload = await objectStore.uploadFile(photo.filePath, {
          key: `photos/${photo.id}${ext || '.png'}`,
          contentType: mime
        });
        if (!upload.success || !upload.url) {
          throw new Error('图生视频：图片上传对象存储失败（该模型需要公网可读 URL）: ' + (upload.error || '无 url'));
        }
        url = upload.url;
        urlProtocol = 'https';
      }
    }

    return {
      photoId: photo.id,
      filePath: photo.filePath,
      base64,
      dataUrl: `data:${mime};base64,${base64}`,
      url,
      urlProtocol,
      mime,
      sizeBytes: buf.length,
      width: photo.width || null,
      height: photo.height || null,
      prompt: photo.prompt || ''
    };
  }

  // ===== 出图 → 图生视频 + 审图暂停（2026-11-16 契约 §1/§2）=====
  // 契约：docs/交接/2026-11-16-出图审图-接口契约.md
  //
  // 触发（全部满足才走新链路；未开启时旧链路行为零变化）：
  //   1) task.runtimeConfig.imagePerClip === true；
  //   2) 不是 source==='library' / 'regenerate'（那两条链路片段已存在，不出图）；
  //   3) 该次运行确实还有「没有可用首帧图」的片段（由 _generateClipImages 自己判断，
  //      全部已有可用图 → generated=0 → 立刻返回，不重复计费、不要求出图配置可用）。
  //
  // 硬约束：出图不可用/余额不足 → 任务失败并写清原因；**绝不降级成文生视频**、绝不返回占位图。
  _imageFirstEnabled(task) {
    if (!task) return false;
    const rc = task.runtimeConfig || {};
    if (rc.imagePerClip !== true) return false;
    if (task.source === 'library' || task.source === 'regenerate') return false;
    return true;
  }

  // 审图等待上限：默认 24 小时（真实 API 不能自动确认，必须给用户这个停点）。
  _imageReviewMaxWaitMs() {
    const raw = Number(process.env.IMAGE_REVIEW_MAX_WAIT_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 24 * 60 * 60 * 1000;
  }

  // 并发出图：默认 3，IMAGE_GEN_CONCURRENCY 可覆盖，上限 6（契约 §2.2）。
  _imageGenConcurrency() {
    const raw = Number(process.env.IMAGE_GEN_CONCURRENCY);
    const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
    return Math.min(6, Math.max(1, n));
  }

  // runtimeConfig 的 5 个图片字段 → IMAGE_GEN_* 覆盖键（未传的键回落到 .env）。
  _imageOverrides(task) {
    return imageGen.overridesFromRuntimeConfig((task && task.runtimeConfig) || {});
  }

  // 「可用首帧图」：照片条目存在 + 文件存在 + 未被真正打回（pending/approved 都算已有图）。
  // 任意一条不满足 → 需要（重新）出图。
  _usableClipPhoto(clip) {
    if (!clip || !clip.photoId) return null;
    const photo = photoLibrary.get(clip.photoId);
    if (!photo) return null;
    if (photo.status === 'rejected') return null;
    try {
      if (!photo.filePath || !fs.existsSync(photo.filePath)) return null;
    } catch (e) {
      return null;
    }
    return photo;
  }

  // 图生视频前置校验：缺首帧图一律判失败，绝不降级成文生视频（契约 §2.5）。
  _approvedClipPhoto(clip) {
    const photo = this._usableClipPhoto(clip);
    if (!photo) {
      // 把出图失败原因一并带出来，否则排障只能看到「缺图」看不出为什么。
      const detail = clip && clip.imageError ? `（出图失败原因：${String(clip.imageError).slice(0, 200)}）` : '';
      return {
        ok: false,
        reason: `缺少首帧图，拒绝降级为文生视频：该片段没有可用的首帧图片${detail}（请先出图并通过审核）`
      };
    }
    if (photo.status !== 'approved') {
      return {
        ok: false,
        reason: `缺少首帧图，拒绝降级为文生视频：首帧图 ${photo.id} 当前状态为 ${photo.status}（需 approved）`
      };
    }
    return { ok: true, photo };
  }

  // 出图 id：首次出图用契约约定的 <taskId>_img_<index>；
  // 该 id 已有记录（例如被打回后重出图）时改用 _vN 后缀新建条目，
  // 否则 photoLibrary.ingest 的幂等规则会保留旧条目（旧文件/旧审核状态），新图等于白出。
  // _vN 后缀会被 photoLibrary.inferGroupId 归到同一 versionGroupId，图片库仍按同一次创作归组。
  _nextImageId(taskId, index) {
    const base = photoLibrary.makeId(taskId, index);
    if (!photoLibrary.get(base)) return base;
    for (let v = 2; v < 100; v++) {
      const id = `${base}_v${v}`;
      if (!photoLibrary.get(id)) return id;
    }
    return `${base}_v${Date.now()}`;
  }

  // 用户明确打回（rejected）的片段：本次**不自动重出图**。
  // 理由（契约 §2.2 与 §2.4 的交界）：重出图 = 新的真实计费，必须由用户显式发起。
  // 若这里自动重出，接着 resumeTask 的「pending 视为通过」结算会把新图自动 approve，
  // 用户刚打回的画面就绕过了审图门 —— 与 §2.4「被打回 → 对应片段 failed」相反。
  // 判定用 _settleImageReview 写入的标记（不会被后续缺图守卫的 error 覆盖）。
  _isUserRejectedClip(clip) {
    return !!(clip && clip.imageStatus === 'failed'
      && /^图片被打回/.test(String(clip.imageError || '')));
  }

  /**
   * 逐段出首帧图（幂等）。
   * 返回 { total, generated, reused, failed, failedIndices, photoIds, pendingCount, rejectedSkipped }；
   * 就绪度不足 / 余额不足等**抛错**（调用方让任务失败，不降级）。
   */
  async _generateClipImages(taskId, task) {
    const clips = Array.isArray(task && task.clips) ? task.clips : [];
    const total = clips.length;

    // 幂等：已有可用图的片段计入 reused，不重复计费。
    // 被用户打回的片段单独计数（不自动重出，交给缺图守卫判失败）。
    // 片段已成功且视频还在的（补跑从拼接开始）本次不会重新生成视频，不需要为它出图。
    const need = [];
    const rejectedExisting = [];
    let videoDone = 0;
    for (const clip of clips) {
      if (this._usableClipPhoto(clip)) continue;
      if (this._isUserRejectedClip(clip)) {
        rejectedExisting.push(clip);
        continue;
      }
      if (clip && clip.status === 'success' && this._resolveClipPath(clip.videoPath)) {
        videoDone += 1;
        continue;
      }
      need.push(clip);
    }
    if (need.length === 0) {
      const reusedClips = clips.filter(c => this._usableClipPhoto(c));
      const photoIds = clips.map(c => c.photoId).filter(Boolean);
      let pendingCount = 0;
      for (const id of photoIds) {
        const p = photoLibrary.get(id);
        if (p && p.status === 'pending') pendingCount += 1;
      }
      console.log(
        `[${taskId}] 出图前置：${reusedClips.length} 段已有可用首帧图`
        + (rejectedExisting.length ? `、${rejectedExisting.length} 段图片被用户打回（不自动重出图）` : '')
        + (videoDone ? `、${videoDone} 段视频已成功（无需出图）` : '')
        + '；跳过出图（不重复计费）'
      );
      return {
        total, generated: 0, reused: reusedClips.length, failed: rejectedExisting.length,
        failedIndices: rejectedExisting.map(c => (Number.isInteger(c.index) ? c.index : clips.indexOf(c))),
        photoIds, pendingCount, rejectedSkipped: rejectedExisting.length, videoDone
      };
    }

    // 1) 就绪度校验：不可用 → 抛错让任务失败，绝不静默降级成文生视频 / 返回占位图。
    const overrides = this._imageOverrides(task);
    const status = imageGen.getImageGenStatus(overrides);
    if (status.usable !== true) {
      const provider = (status.imageGen && status.imageGen.provider) || '（空）';
      const registered = (status.registeredProviders || []).join(', ') || '（无）';
      const missing = (status.missing || []).join(', ');
      const err = new Error(
        '出图未就绪：'
        + (missing ? `缺少 ${missing}` : '出图配置不完整')
        + (status.providerImplemented ? '' : `；厂商标识「${provider}」未注册适配器（已注册：${registered}）`)
        + '。请在「设置 → 图片生成」填写出图 Key / 地址 / 模型（或 .env 的 IMAGE_GEN_*）后重试；'
        + '本任务不会降级为文生视频，也不会用占位图。'
      );
      err.code = 'IMAGE_GEN_NOT_READY';
      throw err;
    }

    // 2) 预算闸门：按「要出的张数」整体预估，避免出一半卡住。
    const needCount = need.length;
    const estUsd = budget.estimateImage(needCount);
    if (!budget.canAfford(estUsd)) {
      const st = budget.status();
      const err = new Error(
        `余额不足：本次出图 ${needCount} 张需 $${Number(estUsd).toFixed(2)}，`
        + `剩余 $${Number(st.balanceUsd).toFixed(2)}。请先充值或减少段数后重试。`
      );
      err.code = 'INSUFFICIENT_BUDGET';
      throw err;
    }

    // 3) 并发出图（默认 3，上限 6）。单张失败只记该片段失败，**不自动重试**（重试 = 额外真实计费）。
    let generator;
    try {
      generator = new imageGen.ImageGenerator(overrides);
    } catch (e) {
      const err = new Error('出图未就绪：无法创建出图生成器（' + (e && e.message ? e.message : e) + '）');
      err.code = 'IMAGE_GEN_NOT_READY';
      throw err;
    }
    const size = overrides.IMAGE_GEN_SIZE || config.IMAGE_GEN_SIZE || null;
    const outDir = config.STORAGE.clipsDir;
    const results = [];
    let cursor = 0;
    const workerCount = Math.min(this._imageGenConcurrency(), needCount);

    const worker = async () => {
      for (;;) {
        const slot = cursor++;
        if (slot >= need.length) return;
        // 任务被取消/结束：不再继续出图（出图也是真实计费）。
        if (!this.runningTasks.has(taskId)) return;
        const clip = need[slot];
        const index = Number.isInteger(clip.index) ? clip.index : slot;
        const prompt = (clip.imagePrompt || clip.prompt || '').trim();
        if (!prompt) {
          taskManager.updateClip(taskId, index, {
            imageStatus: 'failed',
            imageError: '缺少出图提示词（imagePrompt / prompt 均为空）'
          });
          results.push({ index, ok: false, error: '缺少出图提示词' });
          continue;
        }
        try {
          const out = await generator.generateImage(prompt, {
            taskId,
            index,
            size,
            negativePrompt: clip.negativePrompt,
            outDir
          });
          const photoId = this._nextImageId(taskId, index);
          const photo = photoLibrary.ingest({
            id: photoId,
            taskId,
            index,
            filePath: out.imagePath,
            url: '/clips/' + encodeURIComponent(path.basename(out.imagePath)),
            prompt,
            negativePrompt: typeof clip.negativePrompt === 'string' ? clip.negativePrompt : '',
            provider: out.provider || null,
            model: out.model || null,
            size,
            width: out.width,
            height: out.height,
            // 待审（不是 approved）：_i2vPayload 只认 approved，必须由审图结算改成 approved。
            status: 'pending',
            source: 'generation'
          });
          taskManager.updateClip(taskId, index, {
            photoId: photo.id,
            imageStatus: 'generated',
            imageError: null
          });
          // 每张成功后再计费（失败不扣费）；计费异常不丢已出的图，只记错误。
          try {
            budget.reserve({
              usd: budget.estimateImage(1),
              kind: 'image',
              taskId,
              meta: { source: 'pipeline-image-first', index }
            });
          } catch (e) {
            console.error(`[${taskId}] 图片计费预留失败（图已保留）: ${e.message}`);
          }
          console.log(`[${taskId}] 首帧图 ${index + 1}/${total} 出图成功: ${path.basename(out.imagePath)}`);
          results.push({ index, ok: true, photoId: photo.id });
        } catch (e) {
          const msg = String((e && e.message) || e).slice(0, 500);
          taskManager.updateClip(taskId, index, { imageStatus: 'failed', imageError: msg });
          console.error(`[${taskId}] 首帧图 ${index + 1}/${total} 出图失败: ${msg}`);
          results.push({ index, ok: false, error: msg });
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // 4) 汇总 + 写 task.imageReview（§1 结构）。
    const resultByIndex = new Map(results.map(r => [r.index, r]));
    const photoIds = [];
    const failedIndices = [];
    let generated = 0;
    let failed = 0;
    let reused = 0;
    for (const clip of clips) {
      const index = Number.isInteger(clip.index) ? clip.index : clips.indexOf(clip);
      const r = resultByIndex.get(index);
      if (r && r.ok) { generated += 1; photoIds.push(r.photoId); continue; }
      if (r && !r.ok) { failed += 1; failedIndices.push(index); continue; }
      // 没有本轮结果：要么是复用（已有可用图），要么是用户打回（不自动重出），
      // 要么是视频已成功的片段（本次不需要图）。
      if (this._usableClipPhoto(clip)) {
        reused += 1;
        if (clip.photoId) photoIds.push(clip.photoId);
      } else if (clip && clip.status === 'success' && this._resolveClipPath(clip.videoPath)) {
        // 视频已成功，本次不生成视频，也不出图
      } else {
        failed += 1;
        failedIndices.push(index);
        if (clip.photoId) photoIds.push(clip.photoId);
      }
    }
    let pendingCount = 0;
    for (const id of photoIds) {
      const p = photoLibrary.get(id);
      if (p && p.status === 'pending') pendingCount += 1;
    }
    const imageReview = {
      required: true,
      total,
      generated,
      reused,
      failed,
      failedIndices,
      photoIds,
      generatedAt: new Date().toISOString(),
      reviewedAt: null,
      autoApproved: 0,
      rejectedClips: [],
      settledBy: null
    };
    const cur = taskManager.getTask(taskId) || task;
    taskManager.updateTaskStatus(taskId, cur.status || 'pending', {
      imageReview,
      awaitingImageReview: false
    });
    console.log(
      `[${taskId}] 出图完成：${generated} 张新出 / ${reused} 张复用 / ${failed} 张失败`
      + (failedIndices.length ? `（失败段：${failedIndices.map(i => i + 1).join(',')}）` : '')
    );
    return { total, generated, reused, failed, failedIndices, photoIds, pendingCount };
  }

  // 审图暂停（一次性）：置 paused + awaitingImageReview，等用户点「继续/补跑」。
  // 返回 'resumed' | 'timeout' | 'interrupted'。
  async _pauseForImageReview(taskId, summary) {
    this.pausedTasks.add(taskId);
    taskManager.updateTaskStatus(taskId, 'paused', {
      currentStep: `等待审图：已出 ${summary.generated} 张（待审 ${summary.pendingCount} / 失败 ${summary.failed}）`,
      awaitingImageReview: true
    });
    console.log(
      `[${taskId}] ⏸ 等待审图：已出 ${summary.generated} 张（待审 ${summary.pendingCount} / 失败 ${summary.failed}）`
      + '；暂停期间不启动片段生成、不花视频的钱'
    );
    const maxWaitMs = this._imageReviewMaxWaitMs();
    const ok = await this._waitIfPaused(taskId, maxWaitMs);
    if (ok) return 'resumed';

    const cur = taskManager.getTask(taskId);
    // _waitIfPaused 返回 false 有两种：暂停超时（已写 failureCode=pause_timeout）或任务被结束/取消。
    // 只有超时才改写成本步骤专属的 failureCode；其它情况保持原状态，不伪造失败。
    if (!cur || cur.failureCode !== 'pause_timeout') {
      if (cur) console.warn(`[${taskId}] 审图等待被中断（状态 ${cur.status}），不改写任务状态`);
      return 'interrupted';
    }
    const limitText = maxWaitMs >= 3600000
      ? `${Math.round(maxWaitMs / 3600000)} 小时`
      : (maxWaitMs >= 60000
        ? `${Math.round(maxWaitMs / 60000)} 分钟`
        : `${Math.max(1, Math.round(maxWaitMs / 1000))} 秒`);
    taskManager.updateTaskStatus(taskId, 'failed', {
      error: `等待审图超过 ${limitText}，已中止任务（已出的图和任务都保留，可点「补跑」继续；`
        + '已出的图不会重复出图，也不会重复计费）。（这是审图等待超时，不是生成失败。）',
      failureCode: 'image_review_timeout',
      awaitingImageReview: false,
      currentStep: '审图等待超时',
      reviewTimedOutAt: new Date().toISOString(),
      recoverable: true
    });
    console.error(`[${taskId}] ⏸ 审图等待超过 ${limitText}，中止流水线（failureCode=image_review_timeout）`);
    return 'timeout';
  }

  /**
   * 审图结算（幂等）：pending → approved（用户点「继续/补跑」即视为通过未单独审核的图）；
   * rejected → 该片段直接 failed（不会用被打回的图生成视频）。
   * 不做任何真实计费调用。
   */
  _settleImageReview(taskId, settledBy = 'unpause') {
    const task = taskManager.getTask(taskId);
    if (!task) return { settled: false, approvedPhotos: 0, rejectedClips: [] };
    const review = task.imageReview;
    if (!review || review.reviewedAt) {
      return { settled: false, approvedPhotos: 0, rejectedClips: [] };
    }
    let approvedPhotos = 0;
    const rejectedClips = [];
    const clips = Array.isArray(task.clips) ? task.clips : [];
    for (const clip of clips) {
      const photoId = clip && clip.photoId;
      if (!photoId) continue;
      const photo = photoLibrary.get(photoId);
      if (!photo) continue;
      if (photo.status === 'pending') {
        try {
          photoLibrary.markReviewed(photoId, 'approved', '审图暂停后继续，未单独审核视为通过');
          approvedPhotos += 1;
        } catch (e) {
          console.warn(`[${taskId}] 审图结算：图片 ${photoId} 置为通过失败: ${e.message}`);
        }
      } else if (photo.status === 'rejected') {
        const index = Number.isInteger(clip.index) ? clip.index : clips.indexOf(clip);
        taskManager.updateClip(taskId, index, {
          status: 'failed',
          error: `图片被打回（第 ${index + 1} 段），不会用这张图生成视频；请重出图或改选图后再补跑`,
          imageStatus: 'failed',
          imageError: '图片被打回（rejected）'
        });
        rejectedClips.push(index);
      }
    }
    // 状态不在这里强行改成 generating：resumeTask 已经改过；被 continueTask 调用时由它接管。
    const nextStatus = task.status === 'paused' ? 'generating' : task.status;
    taskManager.updateTaskStatus(taskId, nextStatus, {
      imageReview: {
        ...review,
        reviewedAt: new Date().toISOString(),
        autoApproved: approvedPhotos,
        rejectedClips,
        settledBy
      },
      awaitingImageReview: false,
      currentStep: '视频片段生成'
    });
    console.log(
      `[${taskId}] 审图结算（${settledBy}）：自动通过 ${approvedPhotos} 张`
      + (rejectedClips.length ? `，被打回 ${rejectedClips.length} 段（第 ${rejectedClips.map(i => i + 1).join(',')} 段）` : '')
    );
    return { settled: true, approvedPhotos, rejectedClips };
  }

  // _runPipeline 的出图前置步骤：出图 → 必要时暂停审图 → 兜底结算。
  // 返回 null = 继续主流程；返回对象 = 已中止（由 _runPipeline 直接 return）。
  async _runImageFirstPreStep(taskId, task) {
    let summary;
    try {
      summary = await this._generateClipImages(taskId, task);
    } catch (e) {
      // 就绪度 / 余额 / 出图异常：任务失败并写清原因，绝不降级成文生视频。
      const code = (e && e.code) || 'image_gen_failed';
      const message = (e && e.message) ? e.message : String(e);
      taskManager.updateTaskStatus(taskId, 'failed', {
        error: message,
        failureCode: code,
        recoverable: true,
        awaitingImageReview: false,
        currentStep: '出图中止'
      });
      console.error(`[${taskId}] ❌ 出图前置失败（${code}）：${message}`);
      return { success: false, failureCode: code, error: message };
    }

    const review = (taskManager.getTask(taskId) || task).imageReview;
    const needsReview = summary.generated > 0 && (!review || review.reviewedAt == null);
    if (needsReview) {
      const wait = await this._pauseForImageReview(taskId, summary);
      if (wait === 'timeout') {
        return { success: false, aborted: true, failureCode: 'image_review_timeout' };
      }
      if (wait === 'interrupted') {
        return { success: false, aborted: true, cancelled: true };
      }
    }
    // 兜底结算（幂等）：正常路径由 resumeTask/continueTask 触发，这里覆盖「暂停标记被清掉」的情形。
    this._settleImageReview(taskId, 'unpause');
    return null;
  }

  async _batchGenerate(taskId, generator) {
    const task = taskManager.getTask(taskId);
    if (!task) return; // 任务已删除，直接结束批量生成

    // 场景卡（P4）：批生成前确保「本轮取卡 + 提示词」齐全。
    // 正常任务在创建时已写入；这里兜底恢复/旧任务，不足会抛错而不是静默复用。
    if (this._isSceneCardTask(task)) {
      this._composeSceneCardPrompts(taskId);
    }

    // 图生视频：按片段取图（图片优先链路用 clip.photoId；旧任务回退 sourcePhotoId）。
    // 同一张图只解析/上传一次，避免 60 个片段重复上传 60 次。
    const i2vCache = new Map();

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
      // 说明：旧实现在 worker 里提前 `return` 时不会执行 `activeWorkers--`，
      // 若所有 worker 都因暂停/取消提前返回，Promise 永远不会 resolve，流水线会永久挂住。
      // 现在用 try/finally 保证「每个 worker 只减一次、最后一个负责 resolve」。
      const startWorker = async () => {
        try {
          while (currentIndex < total) {
            // 暂停检查点：在取下一个片段之前拦住。
            // 放在 currentIndex++ 之前，保证暂停不会跳号丢弃片段。
            if (this.pausedTasks.has(taskId)) {
              const stillRunning = await this._waitIfPaused(taskId);
              if (!stillRunning) return;  // 任务已结束/取消，或暂停超时被中止
            }
            // 暂停超时会把任务标 failed 并清掉 pausedTasks；
            // 必须按任务状态再拦一次，否则其它 worker 会以为"已恢复"继续生成。
            const cur = taskManager.getTask(taskId);
            if (!cur || cur.status === 'failed' || cur.status === 'cancelled') return;
            if (!this.runningTasks.has(taskId)) return;  // 已被取消
            const index = currentIndex++;
            if (reusable.has(index)) {
              // 该片段已成功且文件在，跳过生成（补跑场景）
              skippedReused++;
              continue;
            }
            const clip = task.clips[index];
            // 出图 → 图生视频任务的硬守卫（2026-11-16 契约 §2.5）：
            // 缺 approved 首帧图 → 该片段直接失败，不发视频请求、不计费。
            // 出图失败、图片被打回、审核未通过都走这里，绝不悄悄退化成文生视频。
            const liveTask = taskManager.getTask(taskId);
            if (liveTask && this._imageFirstEnabled(liveTask)) {
              const liveClip = (liveTask.clips || [])[index] || clip;
              const frame = this._approvedClipPhoto(liveClip);
              if (!frame.ok) {
                this._finishClipFailure(taskId, index, 0, frame.reason, {
                  genStartedAt: new Date().toISOString()
                });
                console.error(`[${taskId}] ⛔ 片段 ${index + 1} ${frame.reason}`);
                // 与 _processSingleClip 失败同口径计入 generated（本轮确实处理过该片段）：
                // 不计数会让上层把「部分失败」误判成 allReused，从而给 clip_generation 标 pass。
                generated += 1;
                continue;
              }
            }
            const photoId = (clip && clip.photoId) || task.sourcePhotoId;
            let clipImage = null;
            if (photoId) {
              try {
                // 缓存 Promise，而不是缓存 await 后的结果：
                // 并发 worker 会同时到达这里，缓存结果会让同一张图重复上传。
                if (!i2vCache.has(photoId)) {
                  i2vCache.set(photoId, this._i2vPayload(task, clip));
                }
                clipImage = await i2vCache.get(photoId);
              } catch (e) {
                // 读图/上传失败是配置或文件问题，不是模型生成失败；不重试，直接报清单。
                this._finishClipFailure(taskId, index, 0, e.message, {
                  genStartedAt: new Date().toISOString()
                });
                continue;
              }
            }
            await this._processSingleClip(taskId, index, generator, clipImage);
            generated++;

            const prog = taskManager.getProgress(taskId);
            if (!prog) return; // 任务已删除，退出当前 worker
            if (prog.success + prog.failed >= total) {
              break;
            }
          }
        } finally {
          activeWorkers--;
          if (activeWorkers === 0) {
            const finalTask = taskManager.getTask(taskId);
            resolve({
              reused: skippedReused,
              generated,
              // aborted=true：任务已被硬中止（目前只有暂停超时），上层必须停止流水线
              aborted: !!(finalTask && finalTask.status === 'failed')
            });
          }
        }
      };

      for (let i = 0; i < Math.min(this.concurrency, total); i++) {
        activeWorkers++;
        startWorker();
      }
    });
  }

  // 处理单个片段（生成 + 质检 + 重试）
  async _processSingleClip(taskId, index, generator, i2vImage = null) {
    const task = taskManager.getTask(taskId);
    if (!task) return; // 任务已删除，直接退出
    const clip = task.clips[index];

    // 总尝试次数：autoRetry=false（新版创作页默认）只试 1 次；
    // 旧任务/API 缺省 true 时仍按 1 + maxRetries，保持兼容。
    const maxAttempts = task.autoRetry === false ? 1 : this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // timing 必须在 try 外声明：catch 里的 _finishClipFailure 要用它记录耗时。
      // 历史 bug：声明在 try 内 → 片段最终失败时 catch 抛 ReferenceError: timing is not defined，
      // 整个进程崩掉，任务永远停在 generating（verify-adjust-pipeline 抓到的）。
      const genStartedMs = Date.now();
      const timing = { genStartedAt: new Date(genStartedMs).toISOString() };
      try {
        taskManager.updateClip(taskId, index, {
          status: 'generating',
          attempts: attempt
        });

        console.log(`[${taskId}] 片段 ${index + 1}/${task.totalClips} 第${attempt}次生成`);

        // 每轮重读实时片段：buffer 替换会改写提示词，不能沿用本轮开始前的旧 prompt。
        const liveTask = taskManager.getTask(taskId) || task;
        const liveClip = (Array.isArray(liveTask.clips) && liveTask.clips[index]) || clip;
        const clipTheme = liveClip.theme || liveTask.theme;
        const clipTemplate = promptOptimizer.getTemplate(clipTheme);
        const genResp = await generator.generate(liveClip.prompt, {
          duration: liveTask.clipDuration,
          resolution: liveTask.resolution,
          ...(clipTemplate && clipTemplate.negative ? { negative: clipTemplate.negative } : {}),
          ...(i2vImage ? { image: i2vImage } : {})
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

        // 两种取片方式：
        //   1) 适配器给了可直接下载的 URL（百炼/可灵等）→ 裸 fetch 下载
        //   2) 适配器自带 downloadVideo（WhaleTV 等中转：completed 不给 URL，内容要带 Bearer 拉 /videos/{id}/content）
        const hasUrlFn = videoPath && (videoPath.startsWith('http://') || videoPath.startsWith('https://'));
        const hasOwnDownload = typeof generator.downloadVideo === 'function';
        if (hasUrlFn || hasOwnDownload) {
          // 每次下载用不覆盖的新文件名：旧名会让第 2 次尝试覆盖第 1 次的付费产物。
          const localPath = this._nextClipPath(taskId, index);
          console.log(`[${taskId}] 片段 ${index + 1} 下载中...`);
          try {
            const downloadResult = hasOwnDownload
              ? await generator.downloadVideo(genTaskId, localPath)
              : await this._downloadVideo(videoPath, localPath);
            if (downloadResult) {
              videoPath = localPath;
            } else {
              throw new Error('视频下载失败');
            }
          } catch (e) {
            throw new Error('下载失败: ' + e.message);
          }
        }
        if (!videoPath) {
          throw new Error('生成完成但既没有视频地址，也没有可用的下载方法');
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
          // 未显式指定时只把硬闸门当阻塞项；软项降级为警告，避免误判逼模型重生成。
          strictItems: Array.isArray(qcRuntime.strictQcItems) && qcRuntime.strictQcItems.length
            ? qcRuntime.strictQcItems
            : HARD_QC_ITEMS
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
          // 内容匹配对 AI 风光片是主观项：只记警告，不阻塞、不触发重生成。
          // 硬闸门仍是黑帧/时长/NSFW；这样不会因为「画面和文字不完全一致」白烧一次生成。
          qcResult.warnings = qcResult.warnings || [];
          qcResult.warnings.push('视觉内容匹配: ' + (contentResult.reason || '未通过（不阻塞）'));
          qcResult.warningCount = (qcResult.warningCount || 0) + 1;
          qcResult.reason = (qcResult.reason ? qcResult.reason + ' | ' : '')
            + '内容匹配警告（不阻塞）: ' + (contentResult.reason || '');
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

          if (attempt >= maxAttempts) {
            this._finishClipFailure(taskId, index, attempt, '质检未通过: ' + (qcResult.reason || ''), timing);
            return;
          }
          await this._sleep(1000 * attempt);
        }

      } catch (error) {
        console.log(`[${taskId}] 片段 ${index + 1} 生成失败 (第${attempt}次): ${error.message}`);

        // 无剩余尝试次数，或错误不可重试（402 余额不足/401 鉴权失败）→ 直接判失败
        if (attempt >= maxAttempts || !generator.canRetry(error)) {
          this._finishClipFailure(taskId, index, attempt, error.message, timing);
          return;
        }
        // 场景卡（P4）：生成失败 → 下一次尝试改用缓冲区卡替换。
        // 只在「还有重试机会」时做，不额外增加付费调用次数。
        if (attempt < maxAttempts) {
          try {
            const replaced = this._replaceSceneCardOnFailure(taskId, index, error.message);
            if (replaced) {
              const fromKey = replaced.entry.replacedFrom ? replaced.entry.replacedFrom.scene_key : '';
              console.log(`[${taskId}] 片段 ${index + 1} 场景卡生成失败 → 缓冲卡替换：${fromKey} → ${replaced.card.scene_key}`);
            }
          } catch (e) {
            console.warn(`[${taskId}] 片段 ${index + 1} 缓冲卡替换失败（保留原失败信息）: ${e.message}`);
          }
        }
        await this._sleep(2000 * attempt);
      }
    }

    this._finishClipFailure(taskId, index, maxAttempts, '重试次数超限', null);
  }

  // autoRetry=false 且存在失败片段 → 停在拼接前，交用户决定（不自动重生成、不带缺片出片）。
  _shouldStopBeforeAssembly(task) {
    return !!task && task.autoRetry === false && this._failedClipSummaries(task).length > 0;
  }

  // 失败片段摘要（给 API/UI 的失败清单）：index 从 1 开始，reason 优先取生成错误，其次质检原因。
  _failedClipSummaries(task) {
    if (!task || !Array.isArray(task.clips)) return [];
    return task.clips
      .filter(c => c && c.status !== 'success')
      .map(c => ({
        index: (c.index || 0) + 1,
        status: c.status || 'pending',
        reason: c.error || (c.qcResult && c.qcResult.reason) || '生成/质检未通过'
      }));
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
    // 只有片段真正成功后才把源图片标成“已使用”；失败不再污染图片库。
    const usedPhotoId = (clip && clip.photoId) || (task && task.sourcePhotoId);
    if (usedPhotoId) {
      try { photoLibrary.attachUsage(usedPhotoId, taskId); } catch (e) { /* 追溯失败不影响生成 */ }
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
    // 2026-11-15：失败片段只要文件还在，也要入库——
    // 用户要求“质检不通过/生成失败的产物也要能在库里看到”，否则失败就只剩一个任务记录。
    try {
      if (clip && clip.videoPath && fs.existsSync(clip.videoPath)) {
        library.ingestClip(taskManager.getTask(taskId) || task, clip);
      }
    } catch (e) {
      console.warn(`[library] 失败片段入库异常 ${taskId}#${index + 1}: ${e.message}`);
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
