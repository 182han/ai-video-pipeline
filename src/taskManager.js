// ==========================================
// 任务状态管理器 - 流水线的"大脑"
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const wsManager = require('./wsManager');
const storage = require('./storage');
const redact = require('./utils/redact');
const { applyTaskDefaults } = require('./taskDefaults');
const { resolveStages } = require('./pipelineStages');
const budget = require('./budget');
// 场景卡（P4）：任务创建时取一轮卡，promptComposer 运行时拼提示词（卡只读）
const sceneCards = require('./sceneCards');
const promptComposer = require('./promptComposer');
// P2：i18n 只用于「反查 messageKey」与任务语言归一化，不改变任何中文展示文案。
const i18n = require('./i18n');
// E11（2026-11-20）：英文界面的任务英文名。只读离线解析，不调用模型。
const taskEn = require('./taskEn');

const DATA_DIR = config.STORAGE.dataDir;
const TRASH_DIR = path.join(__dirname, '..', 'data', 'trash');

// 同一任务的异步落库串行链：key = taskId，value = 最近一次写入的 Promise。
const saveChains = new Map();

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(TRASH_DIR)) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}

// 流水线步骤定义（含质检环节）
// P2：新增 nameKey / qcNameKey（加法式）——前端可按 key 本地化；name / qcName 中文原文不变。
const PIPELINE_STEPS = [
  { key: 'prompt_optimize', name: '提示词优化', nameKey: 'pipeline.step.prompt_optimize.name', qcKey: 'prompt', qcName: '提示词质检', qcNameKey: 'pipeline.step.prompt_optimize.qcName', category: 'pre' },
  { key: 'storyboard', name: '分镜头生成', nameKey: 'pipeline.step.storyboard.name', qcKey: 'storyboard', qcName: '分镜头质检', qcNameKey: 'pipeline.step.storyboard.qcName', category: 'pre' },
  { key: 'clip_generation', name: '视频片段生成', nameKey: 'pipeline.step.clip_generation.name', qcKey: 'clip_qc', qcName: '片段质检（黑帧/模糊/重复/时长）', qcNameKey: 'pipeline.step.clip_generation.qcName', category: 'clip' },
  { key: 'concatenation', name: '视频拼接', nameKey: 'pipeline.step.concatenation.name', qcKey: 'concat', qcName: '拼接质检', qcNameKey: 'pipeline.step.concatenation.qcName', category: 'post' },
  { key: 'loop_processing', name: '无缝循环处理', nameKey: 'pipeline.step.loop_processing.name', qcKey: 'loop', qcName: '循环质检', qcNameKey: 'pipeline.step.loop_processing.qcName', category: 'post' },
  // 配乐混音：整片一次性混入（替代旧的逐片段混音）
  { key: 'audio_mix', name: '配乐混音', nameKey: 'pipeline.step.audio_mix.name', qcKey: 'audio_mix', qcName: '混音校验', qcNameKey: 'pipeline.step.audio_mix.qcName', category: 'post' },
  { key: 'transcoding', name: '转码导出', nameKey: 'pipeline.step.transcoding.name', qcKey: 'transcode', qcName: '转码质检', qcNameKey: 'pipeline.step.transcoding.qcName', category: 'post' },
  { key: 'final_qc', name: '最终综合质检', nameKey: 'pipeline.step.final_qc.name', qcKey: 'final', qcName: '最终质检', qcNameKey: 'pipeline.step.final_qc.qcName', category: 'final' }
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
    //    2026-11-19 事故：多个 saveTask 并发在飞时，较早的快照可能后落库，
    //    把 completed 覆盖回 mixing。这里按 taskId 串行化：上一次写完再写下一次，
    //    保证数据库最终态与内存态一致（本地 JSON 是同步写的，不受此影响）。
    const prev = saveChains.get(taskId) || Promise.resolve();
    const next = prev
      .catch(() => { /* 上一次失败不阻断后续状态落库 */ })
      .then(() => storage.saveTask(safe))
      .catch(err => {
        console.error('数据库保存任务失败:', taskId, err.message);
      });
    saveChains.set(taskId, next);
    next.finally(() => {
      if (saveChains.get(taskId) === next) saveChains.delete(taskId);
    });
  }

  // 等待某任务所有排队的异步落库完成。
  // 用途：测试清理 / 进程收尾 —— 避免「删完记录后，迟到的 saveTask 又把它写回来」。
  async flushSaves(taskId) {
    let guard = 0;
    while (saveChains.has(taskId) && guard < 100) {
      await saveChains.get(taskId).catch(() => {});
      guard += 1;
    }
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

    // 解析档位（默认 final = 全部步骤，保持接入前行为）。
    // 非法档位/非法自定义勾选不让创建任务失败——退回 final 并记日志，
    // 因为「档位写错」不应该让用户丢掉整个任务；真正的错误在 stagePlan.notes 里可见。
    const presetResolution = (() => {
      const rawPreset = options.preset === undefined || options.preset === null
        ? 'final'
        : String(options.preset);
      const r = resolveStages(rawPreset, options.stages);
      if (r.ok) return r;
      console.warn(`[${taskId}] 档位解析失败（${r.error}），已回退 final 全量执行`);
      const fallback = resolveStages('final');
      fallback.notes = [`档位解析失败（${r.error}），已回退 final 全量执行`];
      return fallback;
    })();

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
        // 说明：片段级配乐（trackId）已下线。配乐改为整片多轨时间轴，见 task.bgmPlan。
        duration: 0,
        qcResult: null,
        error: null,
        createdAt: null,
        completedAt: null
      });
    }
    // P3：提示词/作品语言 = promptLang（AI 输出语言 aiLang）→ 界面语言；缺省 zh。
    // 与 task.lang（界面/日志语言）分开：用户可能用中文界面但要英文提示词。
    const promptLang = i18n.resolveLang(options.promptLang, options.lang);

    // ===== 场景卡模式（P4）=====
    // 只读卡库：按 chapter+sequence 取一轮（不放回），缓冲区不参与初始分配；
    // 提示词由 promptComposer 运行时拼出（不写回卡），任务里记录 scene_key 便于审计。
    // 不足 180 张（或本次请求超过卡库正片数）直接抛错，由调用方转成明确提示，不静默复用。
    const sceneCardOption = options.sceneCards;
    const sceneCardRequested = sceneCardOption === true
      || (sceneCardOption && typeof sceneCardOption === 'object' && sceneCardOption.enabled === true);

    // ===== 逐段提示词覆盖（P7-A）=====
    // 键 = 0-based 段序号（"0" = 第 1 段）。只支持场景卡任务：
    // 覆盖文本替换该段 prompt/imagePrompt，卡仍保留做审计（见 promptComposer.composeClipPatch）。
    // 存到 task.promptOverrides；pipeline._composeSceneCardPrompts 每次任务启动都重拼并应用，
    // 因此重跑/补跑不会把用户覆盖冲掉。
    let promptOverrides = null;
    if (options.promptOverrides !== undefined && options.promptOverrides !== null) {
      if (!sceneCardRequested) {
        const e = new Error('promptOverrides 只支持场景卡任务；普通提示词任务请用 prompts 逐段传入');
        e.code = 'PROMPT_OVERRIDES_NEEDS_SCENE_CARDS';
        throw e;
      }
      const norm = promptComposer.normalizePromptOverrides(options.promptOverrides, totalClips);
      if (!norm.ok) {
        const e = new Error(norm.error || 'promptOverrides 不合法');
        e.code = norm.code || 'PROMPT_OVERRIDES_INVALID';
        throw e;
      }
      if (Object.keys(norm.overrides).length) promptOverrides = norm.overrides;
    }

    let sceneCardPlan = null;
    if (sceneCardRequested) {
      if (prompts) {
        // 服务端入口会先拒绝这个组合；这里兜底给直接调用 createTask 的脚本留痕，
        // 避免「传了逐行提示词却完全没用上」这种静默行为。
        console.warn(`[${taskId}] 同时收到 prompts 与 sceneCards：按场景卡模式执行，逐行提示词被忽略`);
      }
      // P7-A：显式 ids（小智计划卡里固定/换过的卡）→ 按 id 组卡，**不再 allocate**；
      // 没给 ids（旧调用方/HTTP 入口）保持 allocate 行为，零回归。
      const explicitIds = (sceneCardOption && typeof sceneCardOption === 'object'
        && Array.isArray(sceneCardOption.ids) && sceneCardOption.ids.length)
        ? sceneCardOption.ids.map(String)
        : null;
      sceneCardPlan = explicitIds
        ? sceneCards.planFromIds(explicitIds, { totalClips })
        : sceneCards.allocate(totalClips);
      for (let i = 0; i < clips.length; i++) {
        const entry = sceneCardPlan.used[i];
        const card = sceneCards.getCardById(entry.id);
        if (!card) {
          const e = new Error(`场景卡缺失：${entry.id}（卡库文件可能被替换，请核对 assets/scene-cards/v3.3-final.json）`);
          e.code = 'SCENE_CARDS_MISSING_CARD';
          throw e;
        }
        // 场景卡是唯一场景输入：不把用户整句（含时长/主题词）当「氛围」注入每段提示词，
        // 否则 60–180 段会被拉向同一主题（2026-11-16 用户指正）。主题仅在显式传 options.theme 时生效。
        // P7-A：该段有用户覆盖时，composeClipPatch 会用覆盖文本替换 prompt/imagePrompt
        // 并打 promptSource='scene-card-user-edit'（卡仍保留审计字段）。
        Object.assign(clips[i], promptComposer.composeClipPatch(card, {
          theme: clips[i].theme,
          promptOverride: promptOverrides ? promptOverrides[String(i)] : null,
          // P3：场景卡提示词语言（promptLang = aiLang || 界面语言；缺省 zh）
          lang: promptLang
        }));
      }
      const firstKey = sceneCardPlan.used[0] ? sceneCardPlan.used[0].scene_key : '';
      const lastKey = sceneCardPlan.used[sceneCardPlan.used.length - 1]
        ? sceneCardPlan.used[sceneCardPlan.used.length - 1].scene_key : '';
      console.log(`[${taskId}] 场景卡：取 ${totalClips} 张（round ${sceneCardPlan.roundId}，${firstKey} → ${lastKey}），本轮不放回`);
    }

    // ===== 配乐配置（整片级，替代旧的逐片段 clipTracks）=====
    // 向后兼容：老前端仍可能传 clipTracks。若全段音轨相同，收敛成整片主曲；
    // 若不一致，取首条并记录迁移痕迹（旧语义已无法表达）。
    const bgmOpt = (options.bgm && typeof options.bgm === 'object') ? options.bgm : {};
    const bgm = {
      enabled: bgmOpt.enabled !== undefined ? !!bgmOpt.enabled : (!!bgmOpt.mode && bgmOpt.mode !== 'off'),
      mode: ['auto', 'manual', 'off'].includes(bgmOpt.mode) ? bgmOpt.mode : (bgmOpt.enabled ? 'auto' : 'off'),
      trackId: bgmOpt.trackId || null,
      // 自动配乐时用户勾选的轨道：轻音乐 / 环境音 可任选其一或都选
      wantMusic: bgmOpt.wantMusic === undefined ? true : !!bgmOpt.wantMusic,
      wantAmbient: !!bgmOpt.wantAmbient,
      // 环境音自动配乐时循环播放的那一首（null = 随机）
      ambientTrackId: bgmOpt.ambientTrackId || null,
      fadeInSec: Number.isFinite(Number(bgmOpt.fadeInSec)) ? Number(bgmOpt.fadeInSec) : 2,
      fadeOutSec: Number.isFinite(Number(bgmOpt.fadeOutSec)) ? Number(bgmOpt.fadeOutSec) : 2,
      crossfadeSec: Number.isFinite(Number(bgmOpt.crossfadeSec)) ? Number(bgmOpt.crossfadeSec) : 1.5,
      volume: Number.isFinite(Number(bgmOpt.volume)) ? Number(bgmOpt.volume) : config.BGM.loudness,
      ambientVolume: Number.isFinite(Number(bgmOpt.ambientVolume)) ? Number(bgmOpt.ambientVolume) : 0.125,
      migratedFromClipTracks: false
    };
    if (Array.isArray(options.clipTracks) && options.clipTracks.length > 0) {
      const uniq = [...new Set(options.clipTracks.filter(Boolean))];
      if (uniq.length === 1) {
        bgm.enabled = true;
        bgm.mode = 'auto';
        bgm.trackId = uniq[0];
      } else if (uniq.length > 1) {
        bgm.enabled = true;
        bgm.mode = 'auto';
        bgm.trackId = uniq[0];
        console.warn('[' + taskId + '] 收到逐段 clipTracks（' + uniq.length + ' 种音轨），已收敛为整片主曲 ' + uniq[0] + '；旧的逐段配乐语义已下线');
      }
      bgm.migratedFromClipTracks = true;
    }

    // 初始化步骤时间追踪
    const steps = {};
    PIPELINE_STEPS.forEach(step => {
      steps[step.key] = {
        key: step.key,
        name: step.name,
        // P2 加法式：前端可优先用 nameKey/qcNameKey 本地化；name/qcName 中文原文保留。
        nameKey: step.nameKey,
        qcKey: step.qcKey,
        qcName: step.qcName,
        qcNameKey: step.qcNameKey,
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

    // 片段间转场（2026-10-20）：按任务覆盖；未传的字段由 pipeline 回退到 config.TRANSITIONS。
    // 存 undefined 时 JSON 序列化会丢字段，读回后按「未设置」处理，语义一致。
    const transitionOption = (options.transition && typeof options.transition === 'object')
      ? {
        enabled: options.transition.enabled !== undefined ? !!options.transition.enabled : undefined,
        duration: Number.isFinite(Number(options.transition.duration)) ? Number(options.transition.duration) : undefined,
        type: typeof options.transition.type === 'string' ? options.transition.type : undefined
      }
      : null;

    // 拼接校色（2026-10-27 批次 2）：默认关，任务级 { enabled, maxGain } 覆盖 .env 全局。
    const colorMatchOption = (options.colorMatch && typeof options.colorMatch === 'object')
      ? {
        enabled: options.colorMatch.enabled !== undefined ? !!options.colorMatch.enabled : undefined,
        maxGain: Number.isFinite(Number(options.colorMatch.maxGain)) ? Number(options.colorMatch.maxGain) : undefined
      }
      : null;

    // 剪映「调节」复刻（2026-10-31）：双开关 —— 全局 ADJUST_ENABLED 打开 **且** 任务带 adjust 才生效。
    // normalizeParams 负责白名单 + 范围钳制 + 丢弃非法值（防注入串进入 ffmpeg 滤镜）。
    // 存 null 表示「没有调节」，与 JSON 序列化后缺字段等价。
    let adjustOption = null;
    if (config.ADJUST && config.ADJUST.enabled && options.adjust && typeof options.adjust === 'object') {
      // 延迟 require：避免与 pipeline/processors 形成加载环
      adjustOption = require('./processors/adjustChain').normalizeParams(options.adjust) || null;
    }

    // 互斥组合：校色只在「转场开启」的重编码路径里做。
    // 要了校色却把转场关掉 → 不静默改成"没要求"，而是记一条 note 让原因可见；
    // 终检会据实际留痕报「校色未执行」并判不通过（AGENTS §4.1）。
    // 注：这里不抛错 —— createTask 外层没有 try/catch（server.js 亦无），
    // 抛出会变成未处理的 Promise 拒绝，接口直接挂住。
    const cmWanted = !!(colorMatchOption && colorMatchOption.enabled === true);
    const transWanted = transitionOption && transitionOption.enabled !== undefined
      ? transitionOption.enabled
      : !!(config.TRANSITIONS && config.TRANSITIONS.enabled);
    if (cmWanted && !transWanted) {
      presetResolution.notes = (presetResolution.notes || []).concat([
        '校色已请求，但转场被关闭：串接走 -c copy 直拼，无法校色 → 终检会报「校色未执行」并判不通过。'
      ]);
    }

    const task = {
      taskId,
      status: 'pending',
      // P2：任务创建时的界面语言（长任务/日志/历史记录按它呈现）。
      // 缺字段的旧任务在读取时归一为 zh；不改变任何中文默认输出。
      lang: i18n.normalizeLang(options.lang) || i18n.DEFAULT_LANG,
      // P3：作品提示词语言（与界面语言分离；缺省跟随界面语言）
      promptLang,
      prompt,
      optimizedPrompt: '',
      isMultiPrompt: !!prompts,
      // 原始多段提示词（§10A）：持久化用户输入，供历史记录/详情完整展示
      prompts: prompts ? prompts.map(p => ({ text: p.text, theme: p.theme, tag: p.tag, matched: p.matched })) : null,
      model: options.model || 'mock',
      // 自动重试开关（2026-11-12 用户口径）：
      //   true  = 生成/质检失败后自动重试（旧行为，API 兼容）
      //   false = 只尝试一次；失败写入 failedClips，由用户决定是否重新生成
      autoRetry: options.autoRetry !== false,
      theme: options.theme ?? null,
      // 图生视频（2026-11-11 用户口径）：用图片库里「已通过」的那张图作为首帧。
      // 存 id 而不是文件路径：图片库条目可能被更新/删除，运行时再解析并校验。
      sourcePhotoId: options.sourcePhotoId || null,
      totalClips,
      clipDuration,
      resolution: options.resolution || config.GENERATION.defaultResolution || '720p',
      totalDuration: totalClips * clipDuration,
      clips,
      // 场景卡取卡计划（P4）：{ roundId, used:[{id,scene_key,chapter,sequence,...}], buffers, ... }；
      // null = 普通提示词任务。卡文件本身仍是只读输入，这里只存审计所需的最小字段。
      sceneCards: sceneCardPlan,
      // P7-A：逐段提示词覆盖（键 = 0-based 段序号）。null = 全部按场景卡。
      // pipeline 每次任务启动重拼提示词时应用（幂等，不叠后缀），重跑/补跑不丢。
      promptOverrides,
      promptSource: sceneCardPlan ? 'scene-card' : null,
      steps,
      // 配乐：整片多轨时间轴。bgmPlan 为编辑结果（见 processors/bgmPlan.js），
      // bgmResult 为最近一次混音结果；masterPath 是无声母版，改配乐时在它上面重混。
      bgm,
      bgmPlan: null,
      bgmResult: null,
      masterPath: null,
      // 片段间转场配置：{ enabled, duration, type } 或 null（null = 用全局配置）
      transition: transitionOption,
      // 拼接校色：{ enabled, maxGain } 或 null（null = 用 .env 全局，默认关）
      colorMatch: colorMatchOption,
      // 剪映「调节」参数：规范化后的对象，或 null（null = 不调节）
      adjust: adjustOption,
      currentStep: 'created',
      currentStepKey: null,
      outputPath: null,
      s3Url: null,
      // 流水线档位（见 src/pipelineStages.js）。
      // preset 决定「要跑哪些步骤」，stageSet 是解析后的 { stepKey: true }。
      // **默认 final = 全部 8 步**，与接入档位之前的行为完全一致（零回归）；
      // 只有显式传 preset（quick / daily / clips_only / custom）才会裁剪步骤。
      preset: presetResolution.preset,
      stageSet: presetResolution.stageSet,
      stagePlan: {
        stages: presetResolution.stages,
        notes: presetResolution.notes
      },
      runtimeConfig: options.runtimeConfig || {},
      // 任务来源：
      //   generation 普通生成任务
      //   library    片段库选片成片（片段是现成的，跳过提示词/分镜/生成）
      //   regenerate 片段库单片段重新生成（隐藏任务，不进主历史）
      source: options.source || 'generation',
      // 隐藏任务：只在片段库看进度，不出现在任务历史/统计里
      hidden: options.hidden === true,
      // 重新生成：指向被替代的库条目 id
      regeneratedFrom: options.regeneratedFrom || null,
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

  // ===== 片段库成片 =====
  // 用一个现成片段列表替换任务里的 clips。
  // 这些片段已经是 success 状态、文件在库目录里，流水线会跳过生成直接拼接。
  setLibraryClips(taskId, segments) {
    const task = this.tasks[taskId];
    if (!task) return null;
    const list = Array.isArray(segments) ? segments : [];
    task.clips = list.map((seg, i) => {
      const full = Number(seg.durationSec) || 0;
      const inSec = Math.max(0, Number(seg.inSec) || 0);
      const outSec = (seg.outSec !== undefined && seg.outSec !== null)
        ? Math.max(0, Number(seg.outSec))
        : null;
      const dur = outSec !== null
        ? Math.max(0.05, outSec - inSec)
        : Math.max(0.05, full - inSec);
      const trimmed = inSec > 0.02 || outSec !== null;
      return {
        index: i,
        prompt: seg.prompt || '',
        theme: seg.theme || null,
        themeTag: null,
        themeMatched: true,
        status: 'success',
        attempts: 0,
        videoPath: seg.filePath,
        duration: Math.round(dur * 1000) / 1000,
        qcResult: null,
        error: null,
        createdAt: null,
        completedAt: null,
        libraryId: seg.libraryId || null,
        trim: trimmed ? { inSec, outSec } : null,
        // 记录规格，拼接时做归一化判断用（没有也能 ffprobe，属于加速信息）
        spec: {
          width: seg.width || null,
          height: seg.height || null,
          fps: seg.fps || null,
          codec: seg.codec || null
        },
        cost: seg.cost || null
      };
    });
    task.totalClips = task.clips.length;
    task.totalDuration = Math.round(task.clips.reduce((s, c) => s + (Number(c.duration) || 0), 0) * 100) / 100;
    task.isMultiPrompt = true;
    task.librarySegments = true;
    task.model = 'library';
    task.status = 'pending';
    task.updatedAt = new Date().toISOString();
    this._saveTask(taskId);
    return task;
  }

  // 创建「片段库成片」任务：片段现成，只跑拼接/循环/转码（配乐与终检留给剪辑页导出）
  createLibraryTask(options = {}) {
    const segments = Array.isArray(options.segments) ? options.segments.filter(s => s && s.filePath) : [];
    if (segments.length === 0) throw new Error('没有可用的片段');
    const resolution = options.resolution || '720p';
    const totalDuration = segments.reduce((s, seg) => {
      const full = Number(seg.durationSec) || 0;
      const inSec = Math.max(0, Number(seg.inSec) || 0);
      const outSec = (seg.outSec !== undefined && seg.outSec !== null) ? Number(seg.outSec) : full;
      return s + Math.max(0.05, outSec - inSec);
    }, 0);
    const prompt = segments.map(s => s.prompt).filter(Boolean).join('\n') || '片段库成片';
    const prompts = segments.map(s => ({ text: s.prompt || '', theme: s.theme || null }));
    const stages = Array.isArray(options.stages) && options.stages.length
      ? options.stages
      : ['concatenation', 'loop_processing', 'transcoding'];
    const task = this.createTask(prompt, {
      model: 'library',
      totalClips: segments.length,
      clipDuration: Math.max(1, Math.round(totalDuration / segments.length)),
      resolution,
      prompts,
      preset: options.preset || 'custom',
      stages,
      source: 'library',
      // P2：任务语言（缺省 zh；由 /api/assemble 从 req.lang 透传）
      lang: options.lang,
      // 片段间转场：从 /api/assemble 透传；不传则用全局配置
      transition: (options.transition && typeof options.transition === 'object') ? options.transition : null
    });
    this.setLibraryClips(task.taskId, segments);
    return this.getTask(task.taskId);
  }

  // 创建「剪辑台导出」任务：已经出片，只登记结果，让产出/历史可见
  // 2026-11-04 F08 收尾。不经过流水线，所有步骤标记 skipped（transcoding 记 completed）。
  createEditorTask(options = {}) {
    const segmentCount = Math.max(1, Number(options.segmentCount) || 1);
    const durationSec = Number(options.durationSec) || 0;
    const task = this.createTask(options.name || '剪辑台导出', {
      model: 'editor',
      totalClips: segmentCount,
      clipDuration: Math.max(1, Math.round(durationSec / segmentCount) || 1),
      resolution: options.resolution || '1080p',
      preset: 'custom',
      stages: ['transcoding'],
      source: 'editor',
      // P2：任务语言（缺省 zh）
      lang: options.lang
    });
    task.status = 'completed';
    task.outputPath = options.outputPath || null;
    task.masterPath = options.outputPath || null;
    task.totalDuration = durationSec;
    task.completedAt = new Date().toISOString();
    task.editorProjectId = options.projectId || null;
    task.currentStep = '完成';
    task.currentStepKey = 'transcoding';
    for (const key of Object.keys(task.steps)) {
      const step = task.steps[key];
      step.status = 'skipped';
      step.startedAt = null;
      step.completedAt = null;
      step.duration = null;
      step.error = null;
      step.qcResult = null;
      step.qcDetails = null;
      step.skipReason = '剪辑台导出（不经过生成流水线）';
    }
    if (task.steps.transcoding) {
      task.steps.transcoding.status = 'completed';
      task.steps.transcoding.completedAt = task.completedAt;
    }
    this._saveTask(task.taskId);
    return this.getTask(task.taskId);
  }

  // 获取任务
  // 历史任务是在配乐改造之前创建的，没有 bgm / bgmPlan / bgmResult / masterPath 字段。
  // 统一补齐默认值，保证调用方拿到的数据形状一致（否则各处都要写 undefined 判断）。
  // 注意：同一份补全逻辑也挂在 src/storage/index.js 上——storage.getTask() 走的是驱动，
  // 不经过本文件，两处不共用就会出现「taskManager 读到有 bgm、storage 读到没有」的不一致。
  getTask(taskId) {
    return applyTaskDefaults(this.tasks[taskId]);
  }

  // 获取所有任务
  // 默认排除隐藏任务（片段库的「重新生成」单片段任务）：
  // 它们只在片段库出现，不应污染任务历史与生产统计。
  getAllTasks(options = {}) {
    const list = Object.values(this.tasks).filter(t => options.includeHidden === true || !t.hidden);
    return list.sort((a, b) =>
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
      // P2 加法式：能精确/前缀反查到 catalog 时补 errorKey（中文 step.error 原文不动）
      if (typeof options.error === 'string' && options.error) {
        const k = i18n.keyForText(options.error, { prefix: true });
        if (k) step.errorKey = k;
        else delete step.errorKey;
      }
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

    // P2（加法式）：为失败原因/当前步骤反查 messageKey。
    // 原则：中文原文 task.error / task.currentStep 一律不改；只新增 errorKey / currentStepMessageKey。
    // 精确反查不到就清掉旧 key（避免上一次失败的原因残留导致前端显示错文案）。
    if (typeof extra.error === 'string' && extra.error) {
      const errorKey = i18n.keyForText(extra.error, { prefix: true });
      if (errorKey) task.errorKey = errorKey;
      else delete task.errorKey;
    } else if (newStatus === 'failed') {
      // 失败但没有 error 文本：不臆造 key
      delete task.errorKey;
    }
    if (typeof extra.currentStep === 'string' && extra.currentStep) {
      // 优先取 pipeline.status.*（中文状态名与步骤名可能同字，如「视频拼接」）
      const stepKey = i18n.keyForText(extra.currentStep, { prefer: 'pipeline.status.' });
      if (stepKey) task.currentStepMessageKey = stepKey;
      else delete task.currentStepMessageKey;
    }

    this._saveTask(taskId);
    console.log(`任务 ${taskId} 状态: ${newStatus}`);

    // 预算结算（2026-11-14 / 2026-11-18 修订）：
    // 创建任务时按「段数 × 时长」预扣美元；completed 按成功片段结算。
    // failed 分三态（用户 2026-11-18 报「本地退款 2.003、真实余额没退」）：
    //   · 显式 4xx（外部明确拒绝，通常不计费）→ 仍全额/按成功数退；
    //   · 网络/超时/连接中断（外部可能已扣费）→ **不自动退款**，标记 billingUncertain
    //     保持预扣，等人工对账或任务之后真的完成再结清；
    //   · 其它未知原因 → 沿用旧逻辑（按成功片段结算），不扩大行为变化。
    if (newStatus === 'completed' || newStatus === 'failed') {
      try {
        const clips = Array.isArray(task.clips) ? task.clips : [];
        const success = clips.filter(c => c && c.status === 'success').length;
        // 合成素材（Mock 降级）不产生真实费用，结算按 0 计，全额退回预扣
        const synthetic = task.mockFallback === true || task.model === 'mock';
        const seconds = Number(task.clipDuration) || 0;

        if (newStatus === 'completed') {
          const count = synthetic ? 0 : (success > 0 ? success : (task.totalClips || 0));
          budget.settle(taskId, count * seconds * budget.videoRate(task.resolution));
          // 曾因网络失败被标记不确定的任务，之后真的跑完 → 结清标记（保留历史原因）
          if (task.billingUncertain) {
            task.billingUncertain = false;
            task.billingUncertainResolvedAt = new Date().toISOString();
            task.billingUncertainResolution = 'completed';
            this._saveTask(taskId);
          }
        } else {
          // 失败：先判断计费口径。已经标记过 uncertain 的任务，后续失败不再自动结算
          // （否则一次网络失败 + 一次 400 重试就会把可能已扣的费用全额退回）。
          const failureText = [
            extra.error,
            task.error,
            ...clips.map((c) => (c && c.error ? String(c.error) : '')),
            ...clips.map((c) => (c && c.qcResult && c.qcResult.reason ? String(c.qcResult.reason) : ''))
          ].filter(Boolean).join(' | ');
          const verdict = synthetic ? 'definite' : budget.classifyFailure(failureText);

          if (!synthetic && (task.billingUncertain || verdict === 'uncertain')) {
            const marked = task.billingUncertain
              ? { reservedUsd: task.billingUncertainReservedUsd, reason: task.billingUncertainReason }
              : budget.markUncertain(taskId, {
                reason: failureText.slice(0, 500),
                meta: { model: task.model, clips: task.totalClips, seconds }
              });
            if (marked) {
              task.billingUncertain = true;
              task.billingUncertainReason = String(marked.reason || failureText).slice(0, 500);
              task.billingUncertainAt = task.billingUncertainAt || new Date().toISOString();
              task.billingUncertainReservedUsd = marked.reservedUsd !== undefined
                ? marked.reservedUsd : task.billingUncertainReservedUsd;
              // 计费不确定：不调 budget.settle —— 预扣保持，余额不自动退回。
              this._saveTask(taskId);
            }
          } else {
            const count = synthetic ? 0 : (success > 0 ? success : 0);
            budget.settle(taskId, count * seconds * budget.videoRate(task.resolution));
          }
        }
      } catch (e) {
        console.warn('[budget] 任务结算失败:', e && e.message ? e.message : e);
      }
    }

    // WebSocket 推送状态变化
    try {
      const progress = this.getProgress(taskId);
      wsManager.broadcastProgress(taskId, progress);
      wsManager.broadcastStatusChange(taskId, newStatus, extra);
    } catch (e) {}

    return task;
  }

  // 场景卡取卡计划持久化（P4）：任务创建时由 createTask 写入；
  // pipeline 在「补取卡 / buffer 替换」时调用本方法写回，避免直接操作内部对象漏存盘。
  setSceneCards(taskId, plan) {
    const task = this.tasks[taskId];
    if (!task) return null;
    task.sceneCards = plan || null;
    if (plan && plan.enabled) task.promptSource = 'scene-card';
    this._saveTask(taskId);
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

    // P2 加法式：片段失败原因补 errorKey（clip.error 中文原文不动）
    if (typeof updates.error === 'string' && updates.error) {
      const k = i18n.keyForText(updates.error, { prefix: true });
      if (k) clip.errorKey = k;
      else delete clip.errorKey;
    }

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
      // P2 加法式：质检失败原因若带 key（新代码提供）就一并存；旧结果没有则不加。
      if (qcResult.reasonKey) task.clips[clipIndex].errorKey = qcResult.reasonKey;
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
      loop_processing: 5,
      audio_mix: 6,
      transcoding: 8,
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
        themeMatched: c.themeMatched
        // 注：片段级 trackId 已下线，配乐改为整片级，见下方 bgm / bgmPlan
      })),
      // 整片配乐：配置、编辑计划、最近一次混音结果（前端「添加配乐」页面据此渲染时间轴）
      bgm: task.bgm || null,
      bgmPlan: task.bgmPlan || null,
      bgmResult: task.bgmResult || null,
      masterPath: task.masterPath || null,
      // 预估时间
      estimatedRemaining: estimated ? estimated.remainingMs : null,
      estimatedTotal: estimated ? estimated.totalEstimatedMs : null,
      elapsedTime: task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0,
      outputPath: task.outputPath,
      totalDurationSec: task.totalDuration || null,
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
          // E11：英文界面显示用（场景卡 / 词表 / 英文原文；解析不到为 null）
          promptEn: taskEn.promptEnFor(data),
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
