// ==========================================
// 流水线档位：核心链必选 + 增强层可选
// ==========================================
//
// 背景（《后续目标》「流水线模式化与补跑」）：
//   现状是 7/8 步线性全量执行，不管要不要配乐、要不要循环，都会一路跑完。
//   改造目标是拆成「核心链必选 + 增强层可选」，并预设档位；好处是**补跑**：
//   今天先跑快速验证档，明天只在母版上补做配乐/转码，视频不会被重新生成一遍。
//
// 本模块只负责「算清楚要跑哪些步骤」这一件事：
//   档位 -> 步骤集合，做依赖校验与自动补齐，并支持按「已完成到哪一步」算补跑清单。
//   **不修改 pipeline.js 的主流程编排**。接入是下一步（见文末「尚未接入」）。
//
// 为什么先做成纯函数模块：主流程改造必须跑真实任务才能验证，而当前环境没有生成 API Key。
// 把「算步骤」这段最容易出错的逻辑独立出来，可以用纯单测覆盖全部边界（缺失依赖、
// 非法档位、补跑起点、核心链被关闭等），不必依赖真实生成。
//
// 步骤键必须与 taskManager.PIPELINE_STEPS 的 key 完全一致，否则主流程 recordStepStart
// 会写到不存在的步骤上。有 assertKnownStages() 兜底。

// 核心链：无论选什么档位都必须执行（没有它们就没有片段可用）
const CORE_STAGES = Object.freeze(['prompt_optimize', 'storyboard', 'clip_generation']);

// 增强层：按档位/勾选决定是否执行
const ENHANCED_STAGES = Object.freeze([
  'concatenation',     // 拼接
  'loop_processing',   // 无缝循环
  'audio_mix',         // 配乐混音
  'transcoding',       // 转码导出
  'final_qc'           // 最终综合质检
]);

const ALL_STAGES = Object.freeze([...CORE_STAGES, ...ENHANCED_STAGES]);

// 每步的前置依赖。
//
// 注意 audio_mix 依赖 transcoding 而不是 concatenation：
// 接入主流程时核实过，audio_mix 在代码里读的是 masterPath（转码产出的「无声母版」），
// 不是拼接产物。若只声明依赖 concatenation，会出现「配乐步骤拿不到母版」的隐性失败
// ——纯函数层设计时这里写错过，是接入时对真实数据流才发现，已修正。
//
// 其余：loop/transcoding 都基于「上一段可用视频」串行往下，final_qc 看最终成片。
const STAGE_DEPS = Object.freeze({
  prompt_optimize: [],
  storyboard: ['prompt_optimize'],
  clip_generation: ['storyboard'],
  concatenation: ['clip_generation'],
  loop_processing: ['concatenation'],
  transcoding: ['concatenation'],
  audio_mix: ['transcoding'],
  final_qc: ['transcoding']
});

// 预设档位（对齐《后续目标》表 2）
const PRESETS = Object.freeze({
  quick: Object.freeze({
    key: 'quick',
    name: '快速验证',
    desc: '核心链 + 拼接，先看内容风格对不对',
    stages: Object.freeze(['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation'])
  }),
  daily: Object.freeze({
    key: 'daily',
    name: '日常交付',
    desc: '核心链 + 拼接 + 循环 + 转码 + 配乐（不含终检）',
    // 必须含 transcoding：它是出成片的转码步骤，也是配乐所需的无声母版来源。
    // 早期版本漏了它，接入主流程时会导致「配乐拿不到母版」。
    stages: Object.freeze([
      'prompt_optimize', 'storyboard', 'clip_generation',
      'concatenation', 'loop_processing', 'transcoding', 'audio_mix'
    ])
  }),
  final: Object.freeze({
    key: 'final',
    name: '最终成片',
    desc: '全部环节（含转码与终检）',
    stages: ALL_STAGES
  }),
  clips_only: Object.freeze({
    key: 'clips_only',
    name: '片段包',
    desc: '仅核心链，输出片段供人工精剪',
    stages: CORE_STAGES
  }),
  custom: Object.freeze({
    key: 'custom',
    name: '自定义',
    desc: '按需勾选，依赖校验后执行',
    stages: null // 由调用方传入
  })
});

function assertKnownStages(stages, where) {
  const unknown = stages.filter(s => !ALL_STAGES.includes(s));
  if (unknown.length) {
    throw new Error(`${where}: 未知步骤 ${unknown.join(', ')}（可用: ${ALL_STAGES.join(', ')}）`);
  }
}

/**
 * 解析档位为「要执行哪些步骤」。
 *
 * @param {string} presetKey  档位 key；custom 时必须传 customStages
 * @param {string[]|null} customStages 自定义勾选的步骤（仅 custom 生效）
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   preset: string,
 *   stages: string[],        // 最终要执行的步骤（已按执行顺序排列）
 *   stageSet: Object,        // {key: true} 便于主流程判断
 *   autoAdded: string[],     // 因依赖被自动补齐的步骤
 *   coreForced: string[],    // 核心链中被强制加入的步骤
 *   notes: string[]
 * }}
 */
function resolveStages(presetKey, customStages = null) {
  const key = String(presetKey || 'final');
  const preset = PRESETS[key];
  if (!preset) {
    return {
      ok: false,
      error: `未知档位 "${key}"（可用: ${Object.keys(PRESETS).join(', ')}）`,
      preset: key,
      stages: [],
      stageSet: {},
      autoAdded: [],
      coreForced: [],
      notes: []
    };
  }

  let requested;
  if (key === 'custom') {
    if (!Array.isArray(customStages) || customStages.length === 0) {
      return {
        ok: false,
        error: '自定义档位必须至少选择一个步骤',
        preset: key,
        stages: [],
        stageSet: {},
        autoAdded: [],
        coreForced: [],
        notes: []
      };
    }
    requested = customStages.slice();
  } else {
    requested = preset.stages.slice();
  }

  try {
    assertKnownStages(requested, 'resolveStages');
  } catch (e) {
    return {
      ok: false, error: e.message, preset: key,
      stages: [], stageSet: {}, autoAdded: [], coreForced: [], notes: []
    };
  }

  const notes = [];
  const coreForced = [];

  // 核心链必选：勾了任何增强层，就必须有核心链（否则没有片段可用）
  const wantsAnything = requested.length > 0;
  if (wantsAnything) {
    for (const core of CORE_STAGES) {
      if (!requested.includes(core)) {
        requested.push(core);
        coreForced.push(core);
      }
    }
    if (coreForced.length) {
      notes.push(`核心链为必选环节，已自动加入：${coreForced.join(', ')}`);
    }
  }

  // 依赖补齐（传递闭包，直到稳定）
  const autoAdded = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of requested.slice()) {
      for (const dep of STAGE_DEPS[stage] || []) {
        if (!requested.includes(dep)) {
          requested.push(dep);
          autoAdded.push(dep);
          changed = true;
        }
      }
    }
  }
  if (autoAdded.length) {
    notes.push(`存在前置依赖，已自动补齐：${autoAdded.join(', ')}`);
  }

  // 按 ALL_STAGES 的顺序排列，保证执行顺序稳定（不是用户勾选顺序）
  const stages = ALL_STAGES.filter(s => requested.includes(s));
  const stageSet = {};
  for (const s of stages) stageSet[s] = true;

  return {
    ok: true,
    preset: key,
    stages,
    stageSet,
    autoAdded: Array.from(new Set(autoAdded)),
    coreForced: Array.from(new Set(coreForced)),
    notes
  };
}

/**
 * 计算「补跑清单」：在已完成的步骤基础上，还需要跑哪些。
 *
 * 用法（补跑场景）：
 *   已经跑过快速验证档（到 concatenation），现在想补做配乐与转码：
 *     resolveResume({ preset:'daily', completed:['prompt_optimize','storyboard',
 *       'clip_generation','concatenation'] })
 *   -> 只返回 ['audio_mix', 'loop_processing']，不会重新生成片段。
 *
 * @param {{preset:string, customStages?:string[], completed?:string[]}} opts
 * @returns 与 resolveStages 同形，另加
 *   pending: string[]   // 还需要执行的步骤（目标档位 - 已完成）
 *   reused: string[]    // 直接复用的已完成步骤
 */
function resolveResume(opts = {}) {
  const completed = Array.isArray(opts.completed) ? opts.completed.slice() : [];
  try {
    assertKnownStages(completed, 'resolveResume.completed');
  } catch (e) {
    return {
      ok: false, error: e.message, preset: opts.preset,
      stages: [], stageSet: {}, pending: [], reused: [],
      autoAdded: [], coreForced: [], notes: []
    };
  }

  const target = resolveStages(opts.preset, opts.customStages);
  if (!target.ok) return { ...target, pending: [], reused: [] };

  const reused = target.stages.filter(s => completed.includes(s));
  const pending = target.stages.filter(s => !completed.includes(s));

  const pendingSet = new Set(pending);
  const completedSet = new Set(completed);
  const brokenDeps = [];

  // 校验 1：待跑步骤的依赖必须【要么已完成，要么也在待跑清单里】。
  // 否则说明「要跑某步，但它的输入永远不会产生」。
  for (const stage of pending) {
    for (const dep of STAGE_DEPS[stage] || []) {
      if (!completedSet.has(dep) && !pendingSet.has(dep)) {
        brokenDeps.push(`${stage} 需要 ${dep}（既未完成也不会跑）`);
      }
    }
  }

  // 校验 2：已完成步骤的依赖必须也已完成 —— 否则是【状态矛盾】。
  // 例如「声称拼接已完成，但从没生成过片段」：那份拼接产物来源不明，
  // 继续在它上面补跑（配乐/转码/终检）等于把坏产物当真。
  // 这条比校验 1 更隐蔽：pending 的依赖都满足了，看起来可以跑，但地基是空的。
  for (const stage of completed) {
    if (!target.stages.includes(stage)) continue; // 不在本次目标范围内的历史步骤不参与校验
    for (const dep of STAGE_DEPS[stage] || []) {
      if (!completedSet.has(dep)) {
        brokenDeps.push(`${stage} 标记为已完成，但其依赖 ${dep} 未完成（状态矛盾）`);
      }
    }
  }

  if (brokenDeps.length) {
    return {
      ok: false,
      error: `补跑链路不完整：${brokenDeps.join('；')}。`
        + '强行执行会缺少输入产物。',
      preset: target.preset,
      stages: target.stages,
      stageSet: target.stageSet,
      pending, reused,
      autoAdded: target.autoAdded,
      coreForced: target.coreForced,
      notes: target.notes
    };
  }

  const notes = target.notes.slice();
  if (pending.length === 0) {
    notes.push('目标档位的全部步骤均已完成，无需补跑');
  } else {
    notes.push(`复用已完成步骤 ${reused.length} 个，需补跑 ${pending.length} 个：${pending.join(', ')}`);
  }

  return {
    ok: true,
    preset: target.preset,
    stages: target.stages,
    stageSet: target.stageSet,
    pending,
    reused,
    autoAdded: target.autoAdded,
    coreForced: target.coreForced,
    notes
  };
}

// 生成参数快照：一键复跑时按快照原样重跑所依据的字段。
// 只挑「影响生成结果」的字段；不含 UI 状态、不含密钥。
// 注意：密钥绝不可落盘进快照（安全），复跑时由调用方重新提供。
const SNAPSHOT_FIELDS = Object.freeze([
  'model',          // 生成模型
  'resolution',     // 分辨率档
  'clipDuration',   // 单段时长
  'totalClips',     // 片段数
  'theme',          // 主题
  'aspectRatio',    // 画幅
  'isMultiPrompt',  // 是否多提示词模式
  'prompt'          // 原始提示词
]);

/**
 * 从任务对象提取生成参数快照（用于一键复跑）。
 * @param {object} task
 * @returns {{ok:boolean, snapshot?:object, missing?:string[], error?:string}}
 */
function buildSnapshot(task) {
  if (!task || typeof task !== 'object') {
    return { ok: false, error: '任务对象无效' };
  }
  const snapshot = {};
  const missing = [];
  for (const f of SNAPSHOT_FIELDS) {
    const v = task[f];
    if (v === undefined || v === null || v === '') {
      missing.push(f);
    } else {
      snapshot[f] = v;
    }
  }
  // 提示词模板版本：用于将来对齐「模板改版后仍能按原样重跑」
  const cfg = task.runtimeConfig || {};
  if (cfg.templateVersion !== undefined) snapshot.templateVersion = cfg.templateVersion;

  return { ok: true, snapshot, missing };
}

module.exports = {
  CORE_STAGES,
  ENHANCED_STAGES,
  ALL_STAGES,
  STAGE_DEPS,
  PRESETS,
  SNAPSHOT_FIELDS,
  resolveStages,
  resolveResume,
  buildSnapshot,
  assertKnownStages
};
