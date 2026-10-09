// ==========================================
// AI 长视频自动生成流水线 - 服务端入口
// ==========================================

const express = require('express');
const http = require('http');
const path = require('path');
const config = require('./config');
const taskManager = require('./src/taskManager');
const pipeline = require('./src/pipeline');
const promptOptimizer = require('./src/promptOptimizer');
const { getAvailableModels } = require('./src/generators');
const wsManager = require('./src/wsManager');
const qualityChecker = require('./src/qualityChecker');

const app = express();
const server = http.createServer(app);
const PORT = config.SERVER.port || 3000;

// 初始化 WebSocket
wsManager.init(server);

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 输出文件静态访问（用于视频播放和下载）
app.use('/output', express.static(path.join(__dirname, 'output'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// ==========================================
// API 路由
// ==========================================

// 获取可用模型列表
app.get('/api/models', (req, res) => {
  res.json(getAvailableModels());
});

// 测试 API Key 是否有效
app.post('/api/test-api-key', async (req, res) => {
  const { type, apiKey, baseUrl, model } = req.body;

  if (!apiKey) {
    return res.json({ success: false, error: '请输入 API Key' });
  }

  try {
    let url = '';
    let method = 'POST';
    let body = null;
    let headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    if (type === 'agnes') {
      url = (baseUrl || 'https://apihub.agnes-ai.com/v1') + '/videos';
      body = JSON.stringify({
        model: 'agnes-video-2.5',
        prompt: 'test',
        seconds: '5',
        mode: 'text',
        size: '720P',
        aspect_ratio: '16:9'
      });
    } else if (type === 'seedance') {
      const sdBaseUrl = baseUrl || 'https://ark.volcengine.com/api/v3';
      const isVolcengine = sdBaseUrl.includes('volcengine.com') || sdBaseUrl.includes('ark.cn');
      if (isVolcengine) {
        // 火山引擎官方 API
        url = sdBaseUrl + '/contents/generations/tasks';
        body = JSON.stringify({
          model: model || 'doubao-seedance-2.0-mini-250928',
          content: [{ type: 'text', text: 'test' }],
          parameters: { ratio: '16:9', duration: '5', resolution: '480p' }
        });
      } else {
        // 第三方中转
        url = sdBaseUrl + '/videos/generations';
        body = JSON.stringify({
          model: model || 'seedance-2.5',
          prompt: 'test',
          duration: 5,
          quality: '480p',
          aspect_ratio: '16:9'
        });
      }
    } else if (type === 'kling') {
      url = (baseUrl || 'https://api.klingai.com/v1') + '/videos/generations';
      body = JSON.stringify({
        model: 'kling-v3',
        prompt: 'test',
        duration: 5,
        resolution: '720p',
        aspect_ratio: '16:9'
      });
    } else if (type === 'siliconflow') {
      // 硅基流动用 models 列表测试，不消耗额度
      url = (baseUrl || 'https://api.siliconflow.cn/v1') + '/models';
      method = 'GET';
      delete headers['Content-Type'];
    } else if (type === 'llm') {
      // LLM 用 models 列表测试，不消耗 token
      url = (baseUrl || 'https://api.openai.com/v1') + '/models';
      method = 'GET';
      delete headers['Content-Type'];
    } else {
      return res.json({ success: false, error: '未知的测试类型' });
    }

    const options = { method, headers };
    if (body) options.body = body;

    const response = await fetch(url, options);
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) {}

    if (response.ok) {
      res.json({ success: true, message: '连接成功，API Key 有效' });
    } else {
      // 非 401 错误说明 Key 是对的，只是参数或额度问题
      const status = response.status;
      let errorMsg = data.error?.message || data.message || data.error || `HTTP ${status}`;
      if (typeof errorMsg === 'object') errorMsg = JSON.stringify(errorMsg).substring(0, 200);
      if (errorMsg.length > 200) errorMsg = errorMsg.substring(0, 200) + '...';

      if (status === 401 || status === 403) {
        // 401/403 是鉴权失败，Key 无效
        res.json({ success: false, error: errorMsg });
      } else {
        // 其他错误说明 Key 有效（可能是额度不足、参数错误等）
        res.json({ 
          success: true, 
          message: 'Key 有效（注意：' + errorMsg + '）',
          warning: errorMsg
        });
      }
    }
  } catch (e) {
    res.json({ success: false, error: '网络错误: ' + e.message });
  }
});

// 获取系统状态
app.get('/api/status', (req, res) => {
  const videoProcessor = require('./src/videoProcessor');
  res.json({
    ffmpegAvailable: videoProcessor.hasFFmpeg,
    websocketEnabled: config.SERVER.websocket,
    models: getAvailableModels(),
    llmConfigured: !!config.OPENAI_API_KEY
  });
});

// 获取主题列表
app.get('/api/themes', (req, res) => {
  res.json(promptOptimizer.getThemes());
});

// 获取模板详情
app.get('/api/templates/:id', (req, res) => {
  const template = promptOptimizer.getTemplate(req.params.id);
  if (!template) {
    return res.status(404).json({ error: '模板不存在' });
  }
  res.json(template);
});

// 新增模板
app.post('/api/templates', (req, res) => {
  const { id, name, keywords, styleEnhancers, negative } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: '模板ID和名称必填' });
  }
  const result = promptOptimizer.addTemplate(id, { name, keywords, styleEnhancers, negative });
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 更新模板
app.put('/api/templates/:id', (req, res) => {
  const result = promptOptimizer.updateTemplate(req.params.id, req.body);
  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }
  res.json(result);
});

// 删除模板
app.delete('/api/templates/:id', (req, res) => {
  const result = promptOptimizer.deleteTemplate(req.params.id);
  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }
  res.json({ success: true });
});

// 获取优化规则
app.get('/api/rules', (req, res) => {
  res.json({ rules: promptOptimizer.getRules() });
});

// 更新优化规则
app.put('/api/rules', (req, res) => {
  const { rules } = req.body;
  if (!rules) {
    return res.status(400).json({ error: '规则内容不能为空' });
  }
  promptOptimizer.updateRules(rules);
  res.json({ success: true });
});

// 优化提示词
app.post('/api/optimize-prompt', (req, res) => {
  const { prompt, theme } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: '请输入提示词' });
  }

  // 先做质检
  const validation = promptOptimizer.validatePrompt(prompt, theme);

  // 模板优化
  const result = promptOptimizer.optimizeWithTemplate(prompt, theme);

  res.json({
    ...result,
    validation
  });
});

// 创建任务
app.post('/api/tasks', (req, res) => {
  const { prompt, model, theme, clipCount, totalClips, resolution, clipDuration, apiKey, apiBaseUrl, modelId: genModelId, llmApiKey, llmBaseUrl, llmModel } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: '请输入提示词' });
  }

  // 校验模型是否存在
  const availableModels = getAvailableModels();
  const modelId = model || 'mock';
  // Mock 模型永远可用；真实模型即使没配 Key 也允许（前端传了 Key 就行）
  const modelExists = availableModels.some(m => m.id === modelId);
  if (!modelExists) {
    return res.status(400).json({ error: '不支持的模型: ' + modelId });
  }

  // 校验片段数量
  const count = clipCount || totalClips || 10;
  if (count < 1 || count > 200) {
    return res.status(400).json({ error: '片段数量必须在 1-200 之间' });
  }

  // 校验单段时长
  const duration = clipDuration || 30;
  if (duration < 1 || duration > 60) {
    return res.status(400).json({ error: '单段时长必须在 1-60 秒之间' });
  }

  // 创建任务
  const task = taskManager.createTask(prompt.trim(), {
    model: modelId,
    theme: theme || 'landscape',
    totalClips: count,
    resolution: resolution || '720p',
    clipDuration: duration,
    // 保存前端传入的 API 配置（运行时使用）
    runtimeConfig: {
      apiKey: apiKey || '',
      apiBaseUrl: apiBaseUrl || '',
      modelId: genModelId || '',
      llmApiKey: llmApiKey || '',
      llmBaseUrl: llmBaseUrl || '',
      llmModel: llmModel || ''
    }
  });

  // 启动流水线
  pipeline.startTask(task.taskId);

  res.json({
    taskId: task.taskId,
    status: task.status
  });
});

// 获取质检项定义
app.get('/api/qc-items', (req, res) => {
  res.json({
    qcItems: qualityChecker.getQCItems(),
    pipelineSteps: taskManager.getPipelineSteps()
  });
});

// 获取任务列表
app.get('/api/tasks', (req, res) => {
  const tasks = taskManager.getAllTasks();
  res.json(tasks.map(t => ({
    taskId: t.taskId,
    prompt: t.prompt,
    status: t.status,
    model: t.model,
    totalClips: t.totalClips,
    createdAt: t.createdAt,
    completedAt: t.completedAt
  })));
});

// 获取任务详情
app.get('/api/tasks/:id', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(task);
});

// 获取任务进度
app.get('/api/tasks/:id/progress', (req, res) => {
  const progress = taskManager.getProgress(req.params.id);
  if (!progress) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(progress);
});

// 获取片段状态
app.get('/api/tasks/:id/clips', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(task.clips.map(c => ({
    index: c.index,
    status: c.status,
    attempts: c.attempts,
    error: c.error
  })));
});

// 重新运行任务
app.post('/api/tasks/:id/retry', (req, res) => {
  const result = pipeline.startTask(req.params.id, { retry: true });
  res.json(result);
});

// 使用已成功片段继续生成（从拼接步骤开始）
app.post('/api/tasks/:id/resume', (req, res) => {
  const result = pipeline.resumeFromClips(req.params.id);
  res.json(result);
});

// ===== 垃圾箱 API =====

// 移到垃圾箱
app.delete('/api/tasks/:id', (req, res) => {
  const result = taskManager.moveToTrash(req.params.id);
  res.json(result);
});

// 从垃圾箱恢复
app.post('/api/trash/:id/restore', (req, res) => {
  const result = taskManager.restoreFromTrash(req.params.id);
  res.json(result);
});

// 永久删除
app.delete('/api/trash/:id', (req, res) => {
  const result = taskManager.permanentDelete(req.params.id);
  res.json(result);
});

// 获取垃圾箱列表
app.get('/api/trash', (req, res) => {
  res.json(taskManager.getTrashList());
});

// 获取垃圾箱任务详情
app.get('/api/trash/:id', (req, res) => {
  const trashPath = path.join(__dirname, 'data', 'trash', `${req.params.id}.json`);
  if (!fs.existsSync(trashPath)) {
    return res.status(404).json({ error: '任务不存在' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(trashPath, 'utf8'));
    const clips = data.clips || [];
    const success = clips.filter(c => c.status === 'success').length;
    const failed = clips.filter(c => c.status === 'failed' || c.status === 'qc_failed').length;
    res.json({
      taskId: data.taskId,
      status: data.status,
      prompt: data.prompt,
      optimizedPrompt: data.optimizedPrompt,
      model: data.model,
      resolution: data.resolution,
      total: clips.length,
      success,
      failed,
      processing: clips.filter(c => c.status === 'generating').length,
      pending: clips.filter(c => c.status === 'pending').length,
      percent: (data.status === 'completed' || data.status === 'partial') ? 100 : 0,
      currentStep: data.currentStep,
      steps: data.steps || {},
      stepKeys: taskManager.getPipelineSteps().map(s => s.key),
      clips: clips.map(c => ({ index: c.index, status: c.status, attempts: c.attempts || 0, qcResult: c.qcResult, error: c.error })),
      outputPath: data.outputPath,
      s3Url: data.s3Url,
      error: data.error,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      createdAt: data.createdAt,
      deletedAt: data.deletedAt
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 启动服务
// ==========================================

server.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  🎬 AI 长视频自动生成流水线');
  console.log('========================================');
  console.log('');
  console.log(`  服务已启动: http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log('');
  console.log('  功能模块:');
  console.log('    ✅ 可插拔视频生成器 (Mock/Seedance/Kling)');
  console.log('    ✅ 全流程模块化质检');
  console.log('    ✅ 智能提示词优化');
  console.log('    ✅ 批量生成 + 并发控制 + 自动重试');
  console.log('    ✅ 任务状态管理 + 断点续跑');
  console.log('    ✅ WebSocket 实时进度推送');
  console.log('    ✅ FFmpeg 视频处理 (拼接/转码/无缝循环)');
  console.log('');
  console.log('  提示: 默认使用 Mock 模式，无需 API Key 即可演示');
  console.log('');
});
