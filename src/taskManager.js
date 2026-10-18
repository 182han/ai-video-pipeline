// ==========================================
// 任务状态管理器 - 流水线的"大脑"
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const wsManager = require('./wsManager');
const storage = require('./storage');
const redact = require('./utils/redact');

const DATA_DIR = path.join(__dirname, '..', 'data', 'tasks');
const TRASH_DIR = path.join(__dirname, '..', 'data', 'trash');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(TRASH_DIR)) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}

// 流水线步骤定义（含质检环节）
const PIPELINE_STEPS = [
  { key: 'prompt_optimize', name: '提示词优化', qcKey: 'prompt', qcName: '提示词质检', category: 'pre' },
  { key: 'storyboard', name: '分镜头生成', qcKey: 'storyboard', qcName: '分镜头质检', category: 'pre' },
  { key: 'clip_generation', name: '视频片段生成', qcKey: 'clip_qc', qcName: '片段质检（黑帧/模糊/重复/时长）', category: 'clip' },
  { key: 'concatenation', name: '视频拼接', qcKey: 'concat', qcName: '拼接质检', category: 'post' },
  { key: 'loop_processing', name: '无缝循环处理', qcKey: 'loop', qcName: '循环质检', category: 'post' },
  { key: 'transcoding', name: '转码导出', qcKey: 'transcode', qcName: '转码质检', category: 'post' },
  { key: 'final_qc', name: '最终综合质检', qcKey: 'final', qcName: '最终质检', category: 'final' }
];

class TaskManager {
  constructor() {
    this.tasks = {};
    this._loadAllTasks();
  }

  // 获取流水线步骤定义
  getPipelineSteps() {
    return PIPELINE_STEPS;
  }

  // 加载所有任务
  _loadAllTasks() {
    const files = fs.readdirSync(DATA_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
          this.tasks[data.taskId] = data;
        } catch (e) {
          console.error('加载任务失败:', file, e.message);
        }
      }
    }
    console.log(`已加载 ${Object.keys(this.tasks).length} 个任务`);
  }

  // 保存任务：内存态是唯一事实来源，同时落本地 JSON 兜底 + 异步镜像到数据库
  // ⚠️ 落盘前必须脱敏：API Key 只在内存里用于当次生成，绝不写入磁盘/数据库
  _saveTask(taskId) {
    const task = this.tasks[taskId];
    if (!task) return;

    const safe = redact.redactTask(task);

    // 1. 本地 JSON 兜底（数据库不可用时数据也不丢）
    try {
      const filePath = path.join(DATA_DIR, `${taskId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(safe, null, 2), 'utf8');
    } catch (e) {
      console.error('本地保存任务失败:', taskId, e.message);
    }

    // 2. 异步写入数据库（失败不影响主流程，只记日志）
    storage.saveTask(safe).catch(err => {
      console.error('数据库保存任务失败:', taskId, err.message);
    });
  }

  // 从数据库重新加载全部任务（服务启动时可用，也可手动触发）
  async reloadFromStorage() {
    const tasks = await storage.getAllTasks();
    if (!Array.isArray(tasks)) return 0;
    for (const t of tasks) {
      if (t && t.taskId) this.tasks[t.taskId] = t;
    }
    return tasks.length;
  }

  // 生成任务ID
  _generateId() {
    return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 4);
  }

  // 创建新任务
  createTask(prompt, options = {}) {
    const taskId = this._generateId();
    // 多提示词模式（§10A）：元素为 { text, theme } 对象，theme 可能为 null（用全局主题）
    const prompts = Array.isArray(options.prompts) && options.prompts.length > 0
      ? options.prompts
        .map(p => {
          if (typeof p === 'string') return { text: String(p || '').trim(), theme: null, tag: null, matched: true };
          if (p && typeof p === 'object') return {
            text: String(p.text || '').trim(),
            theme: p.theme || null,
            tag: p.tag || null,
            matched: p.matched !== false
          };
          return null;
        })
        .filter(p => p && p.text.length > 0)
      : null;
    const totalClips = prompts ? prompts.length : (options.totalClips || 10);
    const clipDuration = options.clipDuration || config.GENERATION.defaultClipDuration || 15;
    const globalTheme = options.theme ?? null;

    // 初始化片段列表
    const clips = [];
    for (let i = 0; i < totalClips; i++) {
      const entry = prompts ? (prompts[i] || prompts[prompts.length - 1]) : null;
      clips.push({
        index: i,
        // 多提示词：每段使用各自提示词与主题（主题为空时用全局主题），缺行用最后一行补齐（不报错）
        prompt: entry ? entry.text : '',
        theme: entry ? (entry.theme ?? globalTheme) : globalTheme,
        themeTag: entry && entry.tag || null,
        themeMatched: entry ? (entry.matched !== false) : true,
        status: 'pending',
        attempts: 0,
        videoPath: null,
        // 片段配乐音轨 id（§6 配乐）：null/'' 表示该段不配乐
        trackId: null,
        duration: 0,
        qcResult: null,
        error: null,
        createdAt: null,
        completedAt: null
      });
    }
    // 片段级配乐分配：clipTracks[i] 命中则写入对应片段（用于提示词环节预览分配的落库）
    if (Array.isArray(options.clipTracks)) {
      clips.forEach((c, i) => {
        if (options.clipTracks[i]) c.trackId = options.clipTracks[i];
      });
    }

    // 初始化步骤时间追踪
    const steps = {};
    PIPELINE_STEPS.forEach(step => {
      steps[step.key] = {
        key: step.key,
        name: step.name,
        qcKey: step.qcKey,
        qcName: step.qcName,
        category: step.category,
        status: 'pending', // pending / in_progress / completed / failed / skipped
        startedAt: null,
        completedAt: null,
        duration: null,
        qcResult: null,
        qcDetails: null,
        error: null
      };
    });

    const task = {
      taskId,
      status: 'pending',
      prompt,
      optimizedPrompt: '',
      isMultiPrompt: !!prompts,
      // 原始多段提示词（§10A）：持久化用户输入，供历史记录/详情完整展示
      prompts: prompts ? prompts.map(p => ({ text: p.text, theme: p.theme, tag: p.tag, matched: p.matched })) : null,
      model: options.model || 'mock',
      theme: options.theme ?? null,
      totalClips,
      clipDuration,
      resolution: options.resolution || config.GENERATION.defaultResolution || '720p',
      totalDuration: totalClips * clipDuration,
      clips,
      steps,
      currentStep: 'created',
      currentStepKey: null,
      outputPath: null,
      s3Url: null,
      runtimeConfig: options.runtimeConfig || {},
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      estimatedTotalTime: null,
      error: null
    };

    this.tasks[taskId] = task;
    this._saveTask(taskId);
    console.log(`创建任务: ${taskId}`);
    return task;
  }

  // 获取任务
  getTask(taskId) {
    return this.tasks[taskId] || null;
  }

  // 获取所有任务
  getAllTasks() {
    return Object.values(this.tasks).sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  }

  // ===== 步骤追踪 =====

  // 记录步骤开始
  recordStepStart(taskId, stepKey) {
    const task = this.tasks[taskId];
    if (!task || !task.steps[stepKey]) return null;

    const step = task.steps[stepKey];
    step.status = 'in_progress';
    step.startedAt = new Date().toISOString();
    task.currentStep = step.name;
    task.currentStepKey = stepKey;

    // 首次开始时记录任务启动时间
    if (!task.startedAt) {
      task.startedAt = step.startedAt;
    }

    this._saveTask(taskId);

    // WebSocket 推送
    try {
      wsManager.broadcastStepUpdate(taskId, stepKey, step);
      const progress = this.getProgress(taskId);
      wsManager.broadcastProgress(taskId, progress);
    } catch (e) {}

    return step;
  }

  // 记录步骤完成（含质检结果）
  recordStepComplete(taskId, stepKey, options = {}) {
    const task = this.tasks[taskId];
    if (!task || !task.steps[stepKey]) return null;

    const step = task.steps[stepKey];
    step.status = options.status || 'completed';
    step.completedAt = new Date().toISOString();
    step.duration = Date.now() - new Date(step.startedAt).getTime();
    
    if (options.qcResult !== undefined) {
      step.qcResult = options.qcResult;
    }
    if (options.qcDetails !== undefined) {
      step.qcDetails = options.qcDetails;
    }
    if (options.error !== undefined) {
      step.error = options.error;
    }

    this._saveTask(taskId);

    // WebSocket 推送
    try {
      wsManager.broadcastStepUpdate(taskId, stepKey, step);
      const progress = this.getProgress(taskId);
      wsManager.broadcastProgress(taskId, progress);
    } catch (e) {}

    return step;
  }

  // 更新步骤质检结果
  updateStepQC(taskId, stepKey, qcResult, qcDetails = null) {
    const task = this.tasks[taskId];
    if (!task || !task.steps[stepKey]) return null;

    const step = task.steps[stepKey];
    step.qcResult = qcResult;
    if (qcDetails) step.qcDetails = qcDetails;

    this._saveTask(taskId);

    try {
      wsManager.broadcastStepUpdate(taskId, stepKey, step);
    } catch (e) {}

    return step;
  }

  // ===== 预估剩余时间 =====

  // 计算预估剩余时间（基于已完成步骤的实际耗时）
  calculateEstimatedTime(taskId) {
    const task = this.tasks[taskId];
    if (!task) return null;

    // 旧任务没有 steps 字段，返回默认估算
    if (!task.steps) {
      if (task.status === 'completed') {
        return { remainingMs: 0, elapsedMs: 0, totalEstimatedMs: 0, method: 'completed' };
      }
      return {
        remainingMs: (task.totalClips || 10) * 30000 + 120000,
        elapsedMs: task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0,
        totalEstimatedMs: (task.totalClips || 10) * 30000 + 120000,
        method: 'default'
      };
    }

    const stepKeys = PIPELINE_STEPS.map(s => s.key);
    const completedSteps = stepKeys.filter(k => task.steps[k] && task.steps[k].status === 'completed');
    const remainingSteps = stepKeys.filter(k => task.steps[k] && task.steps[k].status !== 'completed');

    // 计算已完成步骤的平均耗时
    let completedTotalTime = 0;
    completedSteps.forEach(k => {
      if (task.steps[k].duration) {
        completedTotalTime += task.steps[k].duration;
      }
    });

    // 如果正在生成视频片段，按进度估算
    if (task.status === 'generating' && task.currentStepKey === 'clip_generation') {
      const clips = task.clips;
      const success = clips.filter(c => c.status === 'success').length;
      const failed = clips.filter(c => c.status === 'failed' || c.status === 'qc_failed').length;
      const total = clips.length;

      if (total > 0 && success > 0) {
        const clipStartTime = task.steps.clip_generation.startedAt;
        if (clipStartTime) {
          const elapsed = Date.now() - new Date(clipStartTime).getTime();
          const perClipTime = elapsed / success;
          const remainingClips = total - success - failed;
          const remainingClipTime = remainingClips * perClipTime;
          
          // 后续步骤预估时间（基于生成时间的比例）
          const postGenSteps = ['concatenation', 'loop_processing', 'transcoding', 'final_qc'];
          let postGenEstimate = 0;
          postGenSteps.forEach(() => {
            postGenEstimate += perClipTime * 0.5; // 每个后续步骤约等于半段生成时间
          });

          return {
            remainingMs: remainingClipTime + postGenEstimate,
            elapsedMs: elapsed + completedTotalTime,
            totalEstimatedMs: elapsed + completedTotalTime + remainingClipTime + postGenEstimate,
            method: 'clip_based'
          };
        }
      }
    }

    // 简单估算：基于已完成步骤的平均耗时
    if (completedSteps.length > 0) {
      const avgStepTime = completedTotalTime / completedSteps.length;
      const remainingEstimate = remainingSteps.length * avgStepTime;

      return {
        remainingMs: remainingEstimate,
        elapsedMs: completedTotalTime,
        totalEstimatedMs: completedTotalTime + remainingEstimate,
        method: 'step_based'
      };
    }

    // 没有数据时返回默认估算
    return {
      remainingMs: task.totalClips * 30000 + 120000, // 默认：每段30秒 + 2分钟后续
      elapsedMs: 0,
      totalEstimatedMs: task.totalClips * 30000 + 120000,
      method: 'default'
    };
  }

  // 更新任务状态
  updateTaskStatus(taskId, newStatus, extra = {}) {
    const task = this.tasks[taskId];
    if (!task) return null;

    task.status = newStatus;
    task.updatedAt = new Date().toISOString();

    if (newStatus === 'generating' && !task.startedAt) {
      task.startedAt = new Date().toISOString();
    }
    if (newStatus === 'completed') {
      task.completedAt = new Date().toISOString();
    }

    Object.assign(task, extra);
    this._saveTask(taskId);
    console.log(`任务 ${taskId} 状态: ${newStatus}`);

    // WebSocket 推送状态变化
    try {
      const progress = this.getProgress(taskId);
      wsManager.broadcastProgress(taskId, progress);
      wsManager.broadcastStatusChange(taskId, newStatus, extra);
    } catch (e) {}

    return task;
  }

  // 设置优化后的提示词
  // options.skipClipOverwrite: 仅更新摘要字段，不覆盖各片段 prompt（调用方已逐片段写回）
  setOptimizedPrompt(taskId, optimizedPrompt, options = {}) {
    const task = this.tasks[taskId];
    if (!task) return;
    task.optimizedPrompt = optimizedPrompt;

    // 多提示词模式：每片段保留各自输入的场景提示词，不覆盖
    if (task.isMultiPrompt || options.skipClipOverwrite) {
      this._saveTask(taskId);
      return;
    }

    // 把优化后的提示词分配给每个片段
    for (let i = 0; i < task.clips.length; i++) {
      task.clips[i].prompt = `${optimizedPrompt} - scene ${i + 1}`;
    }

    this._saveTask(taskId);
  }

  // 更新单个片段状态
  updateClip(taskId, clipIndex, updates) {
    const task = this.tasks[taskId];
    if (!task || !task.clips[clipIndex]) return null;

    const clip = task.clips[clipIndex];
    Object.assign(clip, updates);

    if (updates.status === 'generating' && !clip.createdAt) {
      clip.createdAt = new Date().toISOString();
    }
    if (updates.status === 'success' || updates.status === 'failed') {
      clip.completedAt = new Date().toISOString();
    }

    this._saveTask(taskId);

    // WebSocket 推送片段更新
    try {
      wsManager.broadcastClipUpdate(taskId, clipIndex, {
        index: clipIndex,
        status: clip.status,
        attempts: clip.attempts,
        error: clip.error,
        qcResult: clip.qcResult
      });
      const progress = this.getProgress(taskId);
      wsManager.broadcastProgress(taskId, progress);
    } catch (e) {}

    return clip;
  }

  // 设置质检结果
  setQCResult(taskId, clipIndex, qcResult) {
    const task = this.tasks[taskId];
    if (!task || !task.clips[clipIndex]) return;

    task.clips[clipIndex].qcResult = qcResult;

    if (!qcResult.passed) {
      task.clips[clipIndex].status = 'qc_failed';
      task.clips[clipIndex].error = qcResult.reason;
    }

    this._saveTask(taskId);

    try {
      wsManager.broadcastClipUpdate(taskId, clipIndex, {
        index: clipIndex,
        status: task.clips[clipIndex].status,
        qcResult: qcResult
      });
    } catch (e) {}
  }

  // 获取进度统计（增强版）
  getProgress(taskId) {
    const task = this.tasks[taskId];
    if (!task) return null;

    const clips = task.clips;
    const success = clips.filter(c => c.status === 'success').length;
    const failed = clips.filter(c => c.status === 'failed' || c.status === 'qc_failed').length;
    const processing = clips.filter(c => c.status === 'generating').length;
    const pending = clips.filter(c => c.status === 'pending').length;

    // 计算整体进度百分比（按步骤权重）
    const stepWeights = {
      prompt_optimize: 5,
      storyboard: 5,
      clip_generation: 60,
      concatenation: 8,
      loop_processing: 7,
      transcoding: 10,
      final_qc: 5
    };

    let totalPercent = 0;
    PIPELINE_STEPS.forEach(step => {
      const stepData = task.steps && task.steps[step.key];
      if (stepData) {
        const weight = stepWeights[step.key] || 10;
        if (stepData.status === 'completed') {
          totalPercent += weight;
        } else if (stepData.status === 'in_progress') {
          if (step.key === 'clip_generation' && clips.length > 0) {
            const clipProgress = success / clips.length;
            totalPercent += weight * clipProgress;
          } else {
            totalPercent += weight * 0.5;
          }
        }
      }
    });

    // 旧任务（没有 steps 字段），按状态推算百分比
    if (!task.steps && totalPercent === 0) {
      if (task.status === 'completed') {
        totalPercent = 100;
      } else if (task.status === 'generating' && clips.length > 0) {
        totalPercent = Math.round((success / clips.length) * 60);
      } else if (['concatenating', 'looping', 'transcoding'].includes(task.status)) {
        totalPercent = 70;
      } else if (task.status === 'optimizing') {
        totalPercent = 5;
      }
    }

    // 预估剩余时间
    const estimated = this.calculateEstimatedTime(taskId);

    return {
      taskId,
      status: task.status,
      prompt: task.prompt,
      optimizedPrompt: task.optimizedPrompt,
      isMultiPrompt: task.isMultiPrompt,
      prompts: task.prompts || null,
      model: task.model,
      resolution: task.resolution,
      total: clips.length,
      success,
      failed,
      processing,
      pending,
      percent: Math.min(99, Math.round(totalPercent)),
      currentStep: task.currentStep,
      currentStepKey: task.currentStepKey,
      stepText: task.currentStep || task.status,
      // 步骤详情（旧任务可能没有 steps）
      steps: task.steps || {},
      stepKeys: PIPELINE_STEPS.map(s => s.key),
      // 片段状态
      clips: clips.map(c => ({
        index: c.index,
        status: c.status,
        attempts: c.attempts || 0,
        prompt: c.prompt || '',
        qcResult: c.qcResult,
        error: c.error,
        theme: c.theme,
        themeTag: c.themeTag,
        themeMatched: c.themeMatched,
        trackId: c.trackId || null
      })),
      // 预估时间
      estimatedRemaining: estimated ? estimated.remainingMs : null,
      estimatedTotal: estimated ? estimated.totalEstimatedMs : null,
      elapsedTime: task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0,
      outputPath: task.outputPath,
      s3Url: task.s3Url,
      error: task.error,
      startedAt: task.startedAt,
      completedAt: task.completedAt
    };
  }

  // 获取下一个待处理的片段
  getNextPendingClip(taskId) {
    const task = this.tasks[taskId];
    if (!task) return null;

    const clip = task.clips.find(c => c.status === 'pending');
    return clip ? clip.index : -1;
  }

  // ===== 垃圾箱功能 =====

  // 移到垃圾箱（软删除）
  moveToTrash(taskId) {
    const task = this.tasks[taskId];
    if (!task) return { error: '任务不存在' };

    const srcPath = path.join(DATA_DIR, `${taskId}.json`);
    const destPath = path.join(TRASH_DIR, `${taskId}.json`);

    try {
      // 标记删除时间
      task.deletedAt = new Date().toISOString();
      fs.writeFileSync(destPath, JSON.stringify(task, null, 2), 'utf8');

      // 从内存和主目录删除
      delete this.tasks[taskId];
      if (fs.existsSync(srcPath)) {
        fs.unlinkSync(srcPath);
      }

      console.log(`任务 ${taskId} 已移到垃圾箱`);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 从垃圾箱恢复
  restoreFromTrash(taskId) {
    const trashPath = path.join(TRASH_DIR, `${taskId}.json`);
    if (!fs.existsSync(trashPath)) {
      return { error: '垃圾箱中未找到此任务' };
    }

    try {
      const data = JSON.parse(fs.readFileSync(trashPath, 'utf8'));
      delete data.deletedAt;
      data.updatedAt = new Date().toISOString();

      const destPath = path.join(DATA_DIR, `${taskId}.json`);
      fs.writeFileSync(destPath, JSON.stringify(data, null, 2), 'utf8');
      this.tasks[taskId] = data;

      // 从垃圾箱删除
      fs.unlinkSync(trashPath);

      console.log(`任务 ${taskId} 已从垃圾箱恢复`);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 永久删除
  permanentDelete(taskId) {
    const trashPath = path.join(TRASH_DIR, `${taskId}.json`);
    const taskPath = path.join(DATA_DIR, `${taskId}.json`);

    try {
      if (fs.existsSync(trashPath)) fs.unlinkSync(trashPath);
      if (fs.existsSync(taskPath)) fs.unlinkSync(taskPath);
      delete this.tasks[taskId];
      console.log(`任务 ${taskId} 已永久删除`);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 获取垃圾箱列表
  getTrashList() {
    if (!fs.existsSync(TRASH_DIR)) return [];
    const files = fs.readdirSync(TRASH_DIR).filter(f => f.endsWith('.json'));
    const items = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, file), 'utf8'));
        // 完整多段提示词：优先持久化 prompts，老任务回退各片段 prompt
        let promptLines = null;
        if (Array.isArray(data.prompts) && data.prompts.length > 0) {
          promptLines = data.prompts.map(p => (p && p.text) || p);
        } else if (Array.isArray(data.clips) && data.clips.length > 0) {
          promptLines = data.clips.map(c => c.prompt || '').filter(Boolean);
          if (promptLines.length === 0) promptLines = null;
        }
        items.push({
          taskId: data.taskId,
          prompt: data.prompt,
          promptLines,
          status: data.status,
          model: data.model,
          totalClips: data.totalClips,
          createdAt: data.createdAt,
          completedAt: data.completedAt,
          deletedAt: data.deletedAt
        });
      } catch (e) {}
    }
    items.sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));
    return items;
  }
}

module.exports = new TaskManager();
