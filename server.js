// ==========================================
// AI 长视频自动生成流水线 - 服务端入口
// ==========================================

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const taskManager = require('./src/taskManager');
const pipeline = require('./src/pipeline');
const promptOptimizer = require('./src/promptOptimizer');
const { getAvailableModels } = require('./src/generators');
const KlingGenerator = require('./src/generators/kling');
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
// 配乐库存 API（§6 配乐模块）
// ==========================================

const audioMixer = require('./src/processors/audioMixer');

// 音源文件静态访问（用于库存页试听）
app.use('/bgm', express.static(path.join(__dirname, 'assets', 'bgm'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp3')) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// 获取配乐库存清单（?category=music|ambient 按大标签过滤，?mood= 按风格过滤，缺省返回全部）
app.get('/api/bgm', (req, res) => {
  const mood = req.query.mood || '';
  const category = req.query.category || '';
  res.json({
    categories: ['music', 'ambient'],
    categoryNames: { music: '轻音乐', ambient: '环境音' },
    moods: ['calm', 'epic', 'ethereal', 'nature'],
    moodNames: { calm: '舒缓宁静', epic: '壮阔史诗', ethereal: '空灵梦幻', nature: '自然声景' },
    total: audioMixer.getManifest().length,
    tracks: audioMixer.toPublicTracks(mood, category)
  });
});

// 上传配乐入库（base64）
app.post('/api/bgm', (req, res) => {
  const result = audioMixer.addTrack(req.body || {});
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 编辑音轨元信息
app.put('/api/bgm/:id', (req, res) => {
  const result = audioMixer.updateTrack(req.params.id, req.body || {});
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json(result);
});

// 删除音轨
app.delete('/api/bgm/:id', (req, res) => {
  const result = audioMixer.removeTrack(req.params.id);
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json({ success: true });
});

// 手动混音测试接口（演示用：对指定成片叠加自动匹配的配乐）
app.post('/api/bgm/mix', async (req, res) => {
  const { videoPath, track, theme, loudness, fadeSeconds } = req.body || {};
  if (!videoPath || !videoPath.startsWith('output')) {
    return res.status(400).json({ error: 'videoPath 必须以 output 开头（防止路径穿越）' });
  }
  const inputVideo = path.join(__dirname, videoPath);
  if (!fs.existsSync(inputVideo)) {
    return res.status(400).json({ error: '视频文件不存在: ' + videoPath });
  }
  const outName = 'mix_' + Date.now().toString(36) + '.mp4';
  const outputPath = path.join(__dirname, 'output', outName);
  try {
    const result = await audioMixer.mixBgm(inputVideo, outputPath, {
      track: track || 'auto',
      theme: theme || '',
      loudness: loudness || -20,
      fadeSeconds: fadeSeconds || 2
    });
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ ...result, outputUrl: '/output/' + outName });
  } catch (e) {
    res.status(500).json({ error: '混音失败: ' + e.message });
  }
});

// §6 制作后逐段改配乐：改单段音轨 → 只重混该片段并整体重建拼接转码，不影响视频片段本身
app.post('/api/tasks/:id/clips/:index/audio', async (req, res) => {
  const { trackId } = req.body || {};
  try {
    const result = await pipeline.reapplyClipAudio(req.params.id, parseInt(req.params.index, 10), trackId || null);
    if (!result.success) return res.status(400).json({ error: result.error });
    // outputPath 可能是绝对路径，规范化为可访问的相对 URL
    const outUrl = result.outputPath ? '/output/' + path.basename(result.outputPath) : null;
    res.json({ ...result, outputUrl: outUrl });
  } catch (e) {
    res.status(500).json({ error: '改配乐失败: ' + e.message });
  }
});

// ==========================================
// API 路由
// ==========================================

// 获取可用模型列表
app.get('/api/models', (req, res) => {
  res.json(getAvailableModels());
});

// 测试 API Key 是否有效
app.post('/api/test-api-key', async (req, res) => {
  const { type, apiKey, baseUrl, model, accessKey, secretKey } = req.body;

  if (!apiKey && !(type === 'kling' && accessKey && secretKey)) {
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
      // 可灵官方 API 使用 JWT(ak/sk) 鉴权；用任务列表查询验证 Key，不消耗生成额度
      if (!accessKey || !secretKey) {
        return res.json({ success: false, error: '可灵需要同时填写 AccessKey 和 SecretKey' });
      }
      const klingBaseUrl = (baseUrl || 'https://api-beijing.klingai.com').replace(/\/+$/, '');
      url = klingBaseUrl + '/v1/videos/text2video?pageNum=1&pageSize=1';
      method = 'GET';
      delete headers['Content-Type'];
      try {
        headers['Authorization'] = 'Bearer ' + KlingGenerator.generateJwt(accessKey, secretKey);
      } catch (jwtErr) {
        return res.json({ success: false, error: jwtErr.message });
      }
    } else if (type === 'siliconflow') {
      // 硅基流动用 models 列表测试，不消耗额度
      url = (baseUrl || 'https://api.siliconflow.cn/v1') + '/models';
      method = 'GET';
      delete headers['Content-Type'];
    } else if (type === 'dashscope') {
      // DashScope 无列表接口；用不存在 task_id 的查询验证鉴权（不消耗生成额度）
      // 鉴权失败 → 401/403（判 Key 无效）；鉴权通过 → InvalidTask 类错误（判 Key 有效）
      const dsBaseUrl = (baseUrl || '').replace(/\/+$/, '');
      if (!dsBaseUrl) {
        return res.json({ success: false, error: '请先填写 WorkspaceId / Region（Base URL）' });
      }
      url = dsBaseUrl + '/tasks/invalid-task-check';
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
      } else if (/workspace endpoint is invalid|invalid endpoint|接入点无效/i.test(errorMsg)) {
        // 业务空间 ID / Region 配错：请求没走到鉴权，配置本身就是错的
        res.json({ success: false, error: '接入点无效，请检查 WorkspaceId 与 Region：' + errorMsg });
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

// 获取通用提示词优化规则（全局系统提示，独立于主题模板库）
app.get('/api/rules', (req, res) => {
  res.json({ rules: promptOptimizer.getRules() });
});

// 更新通用提示词优化规则
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
  const { prompt, prompts, clipTracks, model, theme, clipCount, totalClips, resolution, clipDuration, apiKey, apiBaseUrl, modelId: genModelId, klingAccessKey, klingSecretKey, llmApiKey, llmBaseUrl, llmModel, multimodalApiKey, multimodalBaseUrl, multimodalModel } = req.body;

  // 多提示词模式（§10A）：支持 { text, theme } 对象数组，兼容旧格式字符串数组
  // 字符串行自动解析行尾【主题】标签（§10B）；无标签/未识别 → theme 为 null（无主题，只走通用规则）
  let multiPrompts = null;
  if (Array.isArray(prompts)) {
    multiPrompts = prompts
      .map(p => {
        if (typeof p === 'string') {
          const parsed = promptOptimizer.parseThemeTag(p.trim(), theme ?? null);
          if (!parsed.text) return null;
          return {
            text: parsed.text,
            theme: parsed.themeId,
            tag: parsed.tag,
            matched: parsed.matched
          };
        }
        if (p && typeof p === 'object') {
          const text = String(p.text || '').trim();
          if (!text) return null;
          return {
            text,
            theme: p.theme || null,
            tag: p.tag || null,
            matched: p.matched !== false
          };
        }
        return null;
      })
      .filter(Boolean);
    if (multiPrompts.length === 0) multiPrompts = null;
  }

  if ((!prompt || !prompt.trim()) && !multiPrompts) {
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

  // 校验片段数量（多提示词模式下以行数为准）
  const count = multiPrompts ? multiPrompts.length : (clipCount || totalClips || 10);
  if (count < 1 || count > 200) {
    return res.status(400).json({
      error: '片段数量必须在 1-200 之间' + (multiPrompts ? `（当前输入了 ${multiPrompts.length} 行提示词）` : '')
    });
  }

  // 校验单段时长
  const duration = clipDuration || config.GENERATION.defaultClipDuration || 15;
  if (duration < 1 || duration > 60) {
    return res.status(400).json({ error: '单段时长必须在 1-60 秒之间' });
  }

  // 创建任务（多提示词模式下 prompt 取第一行文本，各片段提示词/主题由 prompts 逐一分配）
  const firstPrompt = prompt || (multiPrompts ? multiPrompts[0].text : '') || '';
  const task = taskManager.createTask(firstPrompt.trim(), {
    model: modelId,
    theme: theme ?? null,
    totalClips: count,
    resolution: resolution || config.GENERATION.defaultResolution || '720p',
    clipDuration: duration,
    prompts: multiPrompts,
    // 片段级配乐分配（§6）：array of trackId|null，与 clips 一一对应
    clipTracks: Array.isArray(clipTracks) ? clipTracks.slice(0, count) : undefined,
    // 保存前端传入的 API 配置（运行时使用）
    runtimeConfig: {
      apiKey: apiKey || '',
      apiBaseUrl: apiBaseUrl || '',
      modelId: genModelId || '',
      klingAccessKey: klingAccessKey || '',
      klingSecretKey: klingSecretKey || '',
      llmApiKey: llmApiKey || '',
      llmBaseUrl: llmBaseUrl || '',
      llmModel: llmModel || '',
      // §9B 视觉内容质检用多模态配置（缺省时回退到 llm* 再回退到 config.OPENAI_*）
      multimodalApiKey: multimodalApiKey || '',
      multimodalBaseUrl: multimodalBaseUrl || '',
      multimodalModel: multimodalModel || ''
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
  res.json(tasks.map(t => {
    // 完整多段提示词：新任务用持久化 prompts，老任务（无 prompts 字段）回退各片段 prompt
    let promptLines = null;
    if (Array.isArray(t.prompts) && t.prompts.length > 0) {
      promptLines = t.prompts.map(p => (p && p.text) || p);
    } else if (Array.isArray(t.clips) && t.clips.length > 0) {
      promptLines = t.clips.map(c => c.prompt || '').filter(Boolean);
      if (promptLines.length === 0) promptLines = null;
    }
    return {
      taskId: t.taskId,
      prompt: t.prompt,
      promptLines,
      isMultiPrompt: t.isMultiPrompt || false,
      status: t.status,
      model: t.model,
      totalClips: t.totalClips,
      successClips: (t.clips || []).filter(c => c.status === 'success').length,
      failedClips: (t.clips || []).filter(c => c.status === 'failed').length,
      createdAt: t.createdAt,
      completedAt: t.completedAt
    };
  }));
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

// 重新生成单个失败片段（可传新提示词），成功后自动重拼成片
app.post('/api/tasks/:id/clips/:index/regenerate', async (req, res) => {
  const clipIndex = parseInt(req.params.index, 10);
  const prompt = (req.body && req.body.prompt) || '';
  const result = await pipeline.regenerateClip(req.params.id, clipIndex, prompt);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 使用已成功片段继续生成（从拼接步骤开始）
app.post('/api/tasks/:id/resume', async (req, res) => {
  const result = await pipeline.resumeFromClips(req.params.id);
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
      prompts: data.prompts || null,
      isMultiPrompt: data.isMultiPrompt || false,
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
      clips: clips.map(c => ({ index: c.index, status: c.status, attempts: c.attempts || 0, prompt: c.prompt || '', qcResult: c.qcResult, error: c.error })),
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

server.listen(PORT, '0.0.0.0', () => {
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
