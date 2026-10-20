// ==========================================
// 提示词优化模块
// 功能：模板管理 + 模板优化 + AI 优化（可选）
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const promptSkill = require('./promptSkill');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const RULES_FILE = path.join(DATA_DIR, 'optimization_rules.txt');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 内置默认模板
// 第三批（模板库结构化）：每个模板含 structure 字段（§3 词池），styleEnhancers/negative 保留向后兼容
const DEFAULT_TEMPLATES = {
  landscape: {
    name: '自然风景',
    emoji: '🏔',
    keywords: ['mountain', 'lake', 'forest', 'sunset', 'sunrise', 'river', 'valley', 'meadow'],
    styleEnhancers: [
      'cinematic lighting',
      'golden hour',
      '4K ultra HD',
      'highly detailed',
      'epic atmosphere',
      'slow camera movement',
      'breathtaking scenery',
      'photorealistic'
    ],
    negative: 'people, text, watermark, logo',
    structure: {
      subjectPool: [
        'terraced rice fields cascading down a mountainside',
        'a misty valley of layered mountain ridges',
        'an alpine meadow dotted with wildflowers',
        'a winding river cutting through a green canyon'
      ],
      movementPool: [
        'clouds drifting slowly across the peaks',
        'mist rolling through the valley floor',
        'grass swaying in a soft breeze',
        'water glinting as it threads through the rocks'
      ],
      cameraPool: [
        'slow aerial push-in on a simulated IMAX film camera',
        'gentle orbital shot, Panavision C-series 35mm lens, f/4',
        'high-altitude lateral tracking shot',
        'static locked-off telephoto shot with shallow depth of field'
      ],
      lightingPool: [
        'golden hour backlight with long soft shadows',
        'blue hour ambient light, cool and even',
        'volumetric god rays breaking through low clouds',
        'soft diffused overcast light'
      ],
      atmospherePool: [
        'serene and majestic', 'tranquil and expansive',
        'awe-inspiring stillness', 'quiet dawn calm'
      ],
      quality: [
        'cinematic color grading', 'fine 35mm film grain',
        'natural contrast', 'subtle atmospheric haze'
      ],
      endingPool: [
        'No people, no vehicles — just the landscape holding still as the light shifts',
        'End on an empty horizon, nothing enters frame'
      ]
    }
  },
  space: {
    name: '宇宙星空',
    emoji: '🌌',
    keywords: ['nebula', 'stars', 'galaxy', 'planet', 'cosmic dust', 'supernova', 'black hole', 'asteroid'],
    styleEnhancers: [
      'deep space',
      'HDR',
      'ultra detailed',
      'cinematic',
      'slow dolly through',
      'epic scale',
      'vibrant colors',
      'realistic'
    ],
    negative: 'people, earth, text',
    structure: {
      subjectPool: [
        'a spiral galaxy slowly rotating',
        'a nebula field of dust and stars',
        "a planet's terminator line against a starfield"
      ],
      movementPool: [
        'stars drifting in a long-exposure feel',
        'nebula dust subtly shifting',
        'slow parallax against the starfield'
      ],
      cameraPool: [
        'very slow dolly through the field, simulated IMAX',
        'static locked-off, Panavision 35mm',
        'slow orbital around the planet'
      ],
      lightingPool: [
        'self-luminous nebula glow',
        'harsh sunlight rim on a planet',
        'faint starlight'
      ],
      atmospherePool: [
        'vast and silent', 'awe-inspiring', 'cold and endless'
      ],
      quality: [
        'cinematic grade', 'deep-space detail', 'natural contrast', 'fine grain'
      ],
      endingPool: [
        'No spacecraft, no text — just the field holding',
        'End on an empty starfield'
      ]
    }
  },
  aurora: {
    name: '极光',
    emoji: '✨',
    keywords: ['northern lights', 'aurora borealis', 'green lights', 'purple lights', 'snow mountain', 'frozen lake', 'pine trees', 'night sky'],
    styleEnhancers: [
      'dancing lights',
      'reflection on snow',
      'magical atmosphere',
      'cinematic',
      'slow movement',
      '4K',
      'dreamlike',
      'vivid colors'
    ],
    negative: 'people, buildings, city',
    structure: {
      subjectPool: [
        'aurora curtains rippling over a frozen lake',
        'green and violet lights above a snow ridge',
        'a dense star field behind dancing aurora'
      ],
      movementPool: [
        'aurora ribbons slowly folding and unfolding',
        'stars rotating in a long-exposure feel',
        'reflections shimmering on the ice'
      ],
      cameraPool: [
        'static locked-off wide, simulated long-exposure',
        'very slow aerial drift, simulated IMAX',
        'low-angle tracking over the ice'
      ],
      lightingPool: [
        'aurora green-violet emission against cold night sky',
        'moonlight on snow',
        'faint horizon glow'
      ],
      atmospherePool: [
        'dreamlike and silent', 'vast and cold', 'quietly magical'
      ],
      quality: [
        'cinematic grade', 'low-noise night detail', 'natural contrast', 'fine grain'
      ],
      endingPool: [
        'No people — just the lights and the ice',
        'End on the aurora fading, nothing enters frame'
      ]
    }
  },
  ocean: {
    name: '海洋',
    emoji: '🌊',
    keywords: ['ocean waves', 'coral reef', 'tropical fish', 'underwater', 'sunlight rays', 'sea turtle', 'jellyfish', 'deep blue'],
    styleEnhancers: [
      'underwater lighting',
      'serene and peaceful',
      '4K ultra HD',
      'slow graceful movement',
      'crystal clear water',
      'cinematic',
      'realistic',
      'bubbles and particles'
    ],
    negative: 'people, boats, text',
    structure: {
      subjectPool: [
        'turquoise waves breaking over dark volcanic rocks',
        'a vast open sea under a low cloud ceiling',
        'distant cargo ships on the horizon line',
        'a rocky island silhouetted in sea mist'
      ],
      movementPool: [
        'waves rolling in and dissolving into white foam',
        'the sea surface glittering and shifting',
        'distant ships barely drifting',
        'spray lifting off the rocks in slow motion'
      ],
      cameraPool: [
        'high-altitude aerial push-in, simulated IMAX camera',
        'slow lateral tracking at wave height, Panavision 35mm, f/5.6',
        'static locked-off wide shot'
      ],
      lightingPool: [
        'golden hour glint raking across the water',
        'cold overcast silver light',
        'dawn light breaking across the swell'
      ],
      atmospherePool: [
        'vast and elemental', 'calm and endless', 'quietly powerful'
      ],
      quality: [
        'cinematic grade', 'natural sea spray', 'fine film grain', 'realistic water detail'
      ],
      endingPool: [
        'No boats entering frame, no birds — just the horizon holding',
        'End on open water, nothing changes'
      ]
    }
  },
  mountain: {
    name: '雪山',
    emoji: '❄️',
    keywords: ['snow covered peaks', 'alpine mountains', 'glaciers', 'rocky cliffs', 'clouds', 'mist', 'sunrise summit', 'icy slopes'],
    styleEnhancers: [
      'majestic and grand',
      'golden sunrise light',
      'aerial view',
      '4K cinematic',
      'slow sweeping camera',
      'epic scale',
      'pristine wilderness',
      'dramatic shadows'
    ],
    negative: 'people, buildings, text',
    structure: {
      subjectPool: [
        'snow-capped peaks piercing a sea of clouds',
        'a glacier tongue descending into a dark valley',
        'sharp granite ridges under thin high-altitude air'
      ],
      movementPool: [
        'clouds flowing over the summit like water',
        'snow plumes streaming off the ridge',
        'mist shifting in the valleys below'
      ],
      cameraPool: [
        'slow aerial reveal rising above the cloud layer, simulated IMAX',
        'high-altitude lateral tracking, Panavision 35mm, f/4',
        'static telephoto compression shot'
      ],
      lightingPool: [
        'golden sunrise rim light on the summit',
        'cold blue pre-dawn light',
        'harsh high-altitude noon light with deep shadows'
      ],
      atmospherePool: [
        'majestic and austere', 'silent and immense', 'awe-inspiring isolation'
      ],
      quality: [
        'cinematic grade', 'crisp snow texture', 'natural contrast', 'fine grain'
      ],
      endingPool: [
        'No climbers, no flags — just the peak standing in the wind',
        'End on an empty ridge line'
      ]
    }
  },
  desert: {
    name: '沙漠',
    emoji: '🏜️',
    keywords: ['desert', 'sand dunes', 'camel caravan', 'mirage', 'golden sand', 'arid landscape', 'oasis', 'wind ripples'],
    styleEnhancers: [
      'vast desert expanse',
      'golden sand texture',
      'dramatic dune shadows',
      'aerial sweeping view',
      'heat haze shimmer',
      'cinematic 4K',
      'warm golden tones',
      'epic scale'
    ],
    negative: 'people, water, buildings, text',
    structure: {
      subjectPool: [
        'endless sand dunes with razor-sharp crests',
        'wind-carved ripples stretching to the horizon',
        'a lone oasis ringed by palms',
        'distant rock mesas under heat haze'
      ],
      movementPool: [
        'sand streaming off the dune crests',
        'heat shimmer distorting the horizon',
        'ripples shifting in the wind'
      ],
      cameraPool: [
        'sweeping aerial over the dune field, simulated IMAX',
        'low-angle ground-level push-in, Panavision 35mm, f/4',
        'static wide shot with telephoto compression'
      ],
      lightingPool: [
        'golden hour raking light carving deep dune shadows',
        'harsh midday light with stark contrast',
        'cool blue hour over warm sand'
      ],
      atmospherePool: [
        'vast and silent', 'austere and timeless', 'quietly epic'
      ],
      quality: [
        'cinematic grade', 'fine sand texture', 'natural warm tones', 'subtle film grain'
      ],
      endingPool: [
        'No caravans, no figures — just the dunes holding still',
        'End on an empty dune crest'
      ]
    }
  },
  waterfall: {
    name: '瀑布',
    emoji: '💦',
    keywords: ['waterfall', 'cascade', 'mist spray', 'cliff drop', 'rainbow', 'plunge pool', 'rocky gorge', 'jungle waterfall'],
    styleEnhancers: [
      'thundering waterfall',
      'crystal mist spray',
      'sunlight through droplets',
      'rainbow refraction',
      'slow motion flow',
      'cinematic 4K',
      'verdant surroundings',
      'majestic scale'
    ],
    negative: 'people, buildings, text',
    structure: {
      subjectPool: [
        'a thundering waterfall dropping into a misty plunge pool',
        'a thin cascade threading down a mossy cliff',
        'a jungle waterfall framed by ferns'
      ],
      movementPool: [
        'water plunging and dissolving into spray',
        'mist rising and drifting through the gorge',
        'droplets catching the light in slow motion'
      ],
      cameraPool: [
        'slow push-in toward the base of the falls, simulated IMAX',
        'static locked-off wide, Panavision 35mm, f/5.6',
        'gentle arc around the plunge pool'
      ],
      lightingPool: [
        'sunlight breaking through the spray into a faint rainbow',
        'soft diffused light deep in the gorge',
        'backlit mist glowing'
      ],
      atmospherePool: [
        'powerful and verdant', 'cool and enveloping', 'serene and wild'
      ],
      quality: [
        'cinematic grade', 'realistic water and mist', 'fine grain', 'natural greens'
      ],
      endingPool: [
        'No people — just the water falling and the mist drifting',
        'End on the plunge pool, nothing enters frame'
      ]
    }
  },
  lake: {
    name: '湖泊',
    emoji: '🏞️',
    keywords: ['lake', 'calm water', 'mirror reflection', 'mountain reflection', 'morning mist', 'still surface', 'lakeside forest', 'sunrise over lake'],
    styleEnhancers: [
      'mirror-calm surface',
      'perfect reflection',
      'morning mist',
      'serene atmosphere',
      'golden sunrise glow',
      'cinematic 4K',
      'gentle ripples',
      'peaceful and vast'
    ],
    negative: 'people, boats, buildings, text',
    structure: {
      subjectPool: [
        'a mirror-calm lake reflecting snow peaks',
        'a misty lake at dawn ringed by forest',
        'a high alpine tarn under a still sky'
      ],
      movementPool: [
        'mist drifting low across the surface',
        'gentle ripples breaking the reflection',
        'light shifting slowly on the water'
      ],
      cameraPool: [
        'static locked-off wide, Panavision 35mm, f/4',
        'very slow aerial push-in, simulated IMAX',
        'low-level tracking just above the surface'
      ],
      lightingPool: [
        'golden sunrise glow spreading on the water',
        'soft blue hour light',
        'dawn mist catching the first light'
      ],
      atmospherePool: [
        'serene and still', 'quiet and vast', 'meditative calm'
      ],
      quality: [
        'cinematic grade', 'perfect reflection detail', 'natural tones', 'fine grain'
      ],
      endingPool: [
        'No boats, no birds — just the reflection holding',
        'End on still water, nothing changes'
      ]
    }
  },
  city: {
    name: '城市夜景',
    emoji: '🎬',
    keywords: ['city', 'skyline', 'night', 'neon lights', 'urban', 'street', 'rain'],
    styleEnhancers: [
      'cinematic',
      'urban',
      'cyberpunk',
      'vibrant colors'
    ],
    negative: 'people, readable text, logos',
    structure: {
      subjectPool: [
        'a neon-soaked skyline across a river',
        'wet streets reflecting signage',
        'distant towers half-lost in low cloud'
      ],
      movementPool: [
        'light reflections shifting on wet pavement',
        'clouds drifting behind the towers',
        'traffic light trails streaking below'
      ],
      cameraPool: [
        'slow aerial push-in, simulated IMAX',
        'low-angle tracking along the street',
        'static telephoto compression'
      ],
      lightingPool: [
        'neon magenta-teal glow',
        'cold blue hour light',
        'warm window grids'
      ],
      atmospherePool: [
        'moody and electric', 'quiet after rain', 'cinematic urban calm'
      ],
      quality: [
        'cinematic grade', 'realistic reflections', 'natural contrast', 'fine grain'
      ],
      endingPool: [
        'No readable text or logos — just the lights holding',
        'End on the skyline, nothing enters frame'
      ]
    }
  }
};

// 中文词池覆盖层（2026-10-20）
// 把内置英文词池替换为中文，让「模板优化」路径也输出纯中文。
// 覆盖 keywords / styleEnhancers / negative / structure 七池；name 与 emoji 沿用内置定义。
const ZH_TEMPLATES = require('./templates.zh');
for (const [id, zh] of Object.entries(ZH_TEMPLATES)) {
  const tpl = DEFAULT_TEMPLATES[id];
  if (!tpl) continue;
  if (zh.keywords) tpl.keywords = zh.keywords;
  if (zh.styleEnhancers) tpl.styleEnhancers = zh.styleEnhancers;
  if (zh.negative) tpl.negative = zh.negative;
  if (zh.structure) tpl.structure = zh.structure;
}

// 默认优化规则
const DEFAULT_RULES = `你是一个专业的AI视频提示词优化师。
你的任务是把用户的简单描述，扩写成高质量的中文视频生成提示词。

优化规则：
1. 补充环境和场景细节（时间、天气、角度）
2. 添加光线描述（金色阳光/月光/霓虹等）
3. 添加运镜方式（缓慢推进/环绕/平移等）
4. 添加画质描述（4K、电影级、高细节）
5. 添加氛围描述（宁静/史诗/梦幻等）
6. 用中文输出，长度100-200字
7. 不要出现人物
8. 输出只包含优化后的提示词，不要其他解释`;

// ==========================================
// 行级主题标签（§10B）
// ==========================================

// 主题关键词表：模板 id → 中文关键词（包含匹配，长词优先）
const THEME_KEYWORDS = {
  ocean: ['海洋', '大海', '海浪', '海滩', '水下', '珊瑚', '海'],
  desert: ['沙漠', '沙丘', '荒漠', '沙纹'],
  waterfall: ['瀑布', '水雾', '溪流', '峡谷'],
  lake: ['湖泊', '湖', '森林晨雾', '镜面', '倒影'],
  mountain: ['雪山', '冰川', '山峰', '雪原', '山'],
  aurora: ['极光', '北极光'],
  space: ['星空', '银河', '宇宙', '星轨', '夜空'],
  city: ['城市夜景', '城市', '夜景', '霓虹', '都市', '摩天楼'],
  landscape: ['森林', '草原', '山谷', '梯田', '云海']
};

/**
 * 解析行尾主题标签
 * 格式：`描述文字【主题】` 或 `描述文字[主题]`
 * 匹配顺序：模板 name 精确匹配 → 关键词表最长包含匹配
 * 无标签 → themeId: null（无主题，只走通用规则）；未识别标签 → themeId: null + matched:false（前端黄色提示）
 */
function parseThemeTag(line, defaultTheme = null) {
  const trimmed = (line || '').trim();
  if (!trimmed) return { text: '', themeId: null, tag: null, matched: true };

  const m = trimmed.match(/[【\[]([^】\]]+)[】\]]$/);
  if (!m) return { text: trimmed, themeId: null, tag: null, matched: true };

  const tag = m[1].trim();
  let themeId = null;

  // 1. 模板 name 精确匹配
  for (const [id, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
    if (tpl.name && tag === tpl.name) { themeId = id; break; }
  }

  // 2. 关键词表最长包含匹配（避免"湖泊"被"湖/海"短词误路由）
  if (!themeId) {
    let bestLen = 0;
    for (const [id, kws] of Object.entries(THEME_KEYWORDS)) {
      for (const kw of kws) {
        if (kw && tag.includes(kw) && kw.length > bestLen) {
          themeId = id;
          bestLen = kw.length;
        }
      }
    }
  }

  if (!themeId) {
    return { text: trimmed, themeId: null, tag, matched: false };
  }
  return { text: trimmed.slice(0, m.index).trim() || trimmed, themeId, tag, matched: true };
}

// ==========================================
// 持久化工具
// ==========================================

function loadTemplates() {
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      const data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
      // 合并内置模板：模板级补缺失键 + 字段级补 structure（仅对内置 id，不覆盖用户编辑过的其他字段）
      let changed = false;
      for (const [id, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
        if (!data[id]) {
          data[id] = tpl;
          changed = true;
        } else if (data[id].structure === undefined && tpl.structure) {
          data[id].structure = tpl.structure;
          changed = true;
        }
      }
      if (changed) saveTemplates(data);
      return data;
    }
  } catch (e) {
    console.warn('读取模板文件失败，使用默认模板:', e.message);
  }
  // 第一次使用，写入默认模板
  saveTemplates(DEFAULT_TEMPLATES);
  return { ...DEFAULT_TEMPLATES };
}

function saveTemplates(templates) {
  try {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('保存模板失败:', e.message);
    return false;
  }
}

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      return fs.readFileSync(RULES_FILE, 'utf-8');
    }
  } catch (e) {
    console.warn('读取规则文件失败，使用默认规则:', e.message);
  }
  saveRules(DEFAULT_RULES);
  return DEFAULT_RULES;
}

function saveRules(rules) {
  try {
    fs.writeFileSync(RULES_FILE, rules, 'utf-8');
    return true;
  } catch (e) {
    console.error('保存规则失败:', e.message);
    return false;
  }
}

// ==========================================
// 主类
// ==========================================

class PromptOptimizer {
  constructor() {
    this.templates = loadTemplates();
    this.rules = loadRules();
    console.log(`[PromptOptimizer] 已加载 ${Object.keys(this.templates).length} 个主题模板`);
  }

  // ===== 模板管理 =====

  // 获取所有主题列表
  getThemes() {
    return Object.entries(this.templates).map(([id, t]) => {
      const s = t.structure;
      return {
        id,
        name: t.name,
        emoji: t.emoji || '🎬',
        keywords: t.keywords,
        styleEnhancers: t.styleEnhancers,
        negative: t.negative,
        // 第三批 §6：结构化词池数量（前端展示用；无 structure 时为 null）
        structureCounts: s ? {
          subjectPool: (s.subjectPool || []).length,
          movementPool: (s.movementPool || []).length,
          cameraPool: (s.cameraPool || []).length,
          lightingPool: (s.lightingPool || []).length,
          atmospherePool: (s.atmospherePool || []).length,
          quality: (s.quality || []).length,
          endingPool: (s.endingPool || []).length
        } : null
      };
    });
  }

  // 获取单个模板详情
  getTemplate(id) {
    return this.templates[id] || null;
  }

  // 新增模板
  addTemplate(id, templateData) {
    if (this.templates[id]) {
      return { success: false, error: '模板ID已存在' };
    }
    this.templates[id] = {
      name: templateData.name || id,
      emoji: templateData.emoji || '🎬',
      keywords: templateData.keywords || [],
      styleEnhancers: templateData.styleEnhancers || [],
      negative: templateData.negative || ''
    };
    saveTemplates(this.templates);
    return { success: true, template: this.templates[id] };
  }

  // 更新模板
  updateTemplate(id, templateData) {
    if (!this.templates[id]) {
      return { success: false, error: '模板不存在' };
    }
    this.templates[id] = {
      ...this.templates[id],
      ...templateData
    };
    saveTemplates(this.templates);
    return { success: true, template: this.templates[id] };
  }

  // 删除模板
  deleteTemplate(id) {
    if (!this.templates[id]) {
      return { success: false, error: '模板不存在' };
    }
    delete this.templates[id];
    saveTemplates(this.templates);
    return { success: true };
  }

  // ===== 优化规则管理 =====

  getRules() {
    return this.rules;
  }

  updateRules(newRules) {
    this.rules = newRules;
    saveRules(newRules);
    return { success: true };
  }

  // ===== 提示词质检 =====

  // 2026-10-19 按用户要求放宽：取消长度提示、取消"建议用英文"、
  // 取消人物/文字关键词提示。现在只校验「不能为空」。
  // 这些提示原本只影响展示、不阻止生成，但会对正常的中文提示词造成干扰。
  validatePrompt(prompt) {
    const issues = [];
    const warnings = [];

    if (!prompt || !String(prompt).trim()) {
      issues.push('提示词不能为空');
    }

    return {
      valid: issues.length === 0,
      issues,
      warnings,
      score: issues.length === 0 ? 100 : 70
    };
  }

  // ===== 提示词优化 =====

  // 降级路径：模板无 structure（UI 自建模板）→ 旧逻辑（随机 styleEnhancers 拼接）
  _legacyTemplateOptimize(userPrompt, template) {
    const shuffled = [...template.styleEnhancers].sort(() => Math.random() - 0.5);
    const selectedStyles = shuffled.slice(0, 4 + Math.floor(Math.random() * 3));
    const optimized = `${userPrompt}, ${selectedStyles.join(', ')}`;

    return {
      method: 'template',
      theme: template.name,
      original: userPrompt,
      optimized,
      negative: template.negative
    };
  }

  // 模板优化（无需 AI，速度快，免费）——第三批：结构化组合（§4）
  // 公式：用户原句 + 运镜 + 光影 + 氛围 + 质感(全量) + 结尾留白
  // seed 用于确定性选择（传 clip.index），保证同主题多片段差异化
  // theme 为空 = 无主题：不套任何模板词池，直接返回原词（只走通用规则）
  optimizeWithTemplate(userPrompt, theme = null, options = {}) {
    if (!theme) {
      return {
        method: 'template',
        theme: '无主题',
        original: userPrompt,
        optimized: userPrompt,
        negative: '',
        seed: Number.isFinite(options.seed) ? options.seed : 0
      };
    }

    const template = this.templates[theme] || this.templates.landscape;
    const s = template.structure;

    // 降级：无 structure（UI 自建模板）→ 旧逻辑
    if (!s) return this._legacyTemplateOptimize(userPrompt, template);

    const seed = Number.isFinite(options.seed) ? options.seed : 0;
    const pick = (pool, offset) => (pool && pool.length)
      ? pool[(seed + offset) % pool.length] : '';

    const parts = [
      userPrompt,
      pick(s.cameraPool, 0),
      pick(s.lightingPool, 1),
      pick(s.atmospherePool, 2),
      (s.quality || []).join(', ')
    ].filter(Boolean);

    let optimized = parts.join(', ');
    const ending = pick(s.endingPool, 3);
    if (ending) optimized += `. ${ending}`;
    if (optimized.length > 2400) optimized = optimized.slice(0, 2400);

    return {
      method: 'template',
      theme: template.name,
      original: userPrompt,
      optimized,
      negative: template.negative,
      seed
    };
  }

  // 组装 system prompt（拆出为独立方法，便于无网络单测）
  // 2026-10-20 起：风光类主题在此叠加 fengguang skill 的摄影级规则层
  buildSystemPrompt(theme = null) {
    let systemPrompt;
    let themeLabel = '无主题';
    let negative = '';

    if (!theme) {
      // 无主题分支：仅通用规则打底，不拼任何模板词池
      systemPrompt = `${this.rules}`;
    } else {
      const template = this.templates[theme] || this.templates.landscape;
      const s = template.structure;
      themeLabel = template.name;
      negative = template.negative;

      // 结构化参考（第三批 §4.4）：有 structure 时注入词池，要求 LLM 按公式输出
      const structureRef = s ? `
结构化参考（按需选用，可改写）：
- 景观主体池：${(s.subjectPool || []).slice(0, 2).join(' | ')}
- 运镜池：${(s.cameraPool || []).join(' | ')}
- 光影池：${(s.lightingPool || []).join(' | ')}
- 氛围池：${(s.atmospherePool || []).join(' | ')}
- 质感：${(s.quality || []).join(', ')}
要求：按「用户场景 + 运镜 + 光影 + 氛围 + 质感」公式组织，结尾用留白句收束（如 "画面停在脊线上，没有新元素进入"），全中文输出。` : '';

      systemPrompt = `
${this.rules}
${structureRef}
当前主题：${template.name}
参考关键词：${template.keywords.join(', ')}
风格参考：${template.styleEnhancers.join(', ')}
负面提示：${template.negative}
`;
    }

    // 叠加 fengguang skill：仅风光类主题；SKILL_PROMPT_ENABLED=false 可整体关闭
    systemPrompt = promptSkill.appendTo(systemPrompt, theme);

    return { systemPrompt, themeLabel, negative };
  }

  // AI 优化（需要 LLM API Key）；theme 为空 = 无主题：systemPrompt 只拼通用规则，不叠加模板词池
  async optimizeWithAI(userPrompt, theme = null, options = {}) {
    const apiKey = options.apiKey || config.OPENAI_API_KEY;
    const baseUrl = options.baseUrl || config.OPENAI_BASE_URL;
    const model = options.model || config.OPENAI_MODEL;

    // 如果没有 API Key，降级到模板优化
    if (!apiKey) {
      console.log('未配置 LLM API Key，使用模板优化');
      return this.optimizeWithTemplate(userPrompt, theme);
    }

    try {
      // system prompt 由 buildSystemPrompt 组装（含 fengguang skill 叠加层）
      const { systemPrompt, themeLabel, negative } = this.buildSystemPrompt(theme);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7
        })
      });

      const data = await response.json();
      const optimized = data.choices?.[0]?.message?.content?.trim() || userPrompt;

      return {
        method: 'ai',
        model: model,
        theme: themeLabel,
        original: userPrompt,
        optimized,
        negative
      };

    } catch (error) {
      console.error('AI 优化失败，降级到模板优化:', error.message);
      return this.optimizeWithTemplate(userPrompt, theme);
    }
  }
  // 解析行尾主题标签（§10B）
  parseThemeTag(line, defaultTheme) {
    return parseThemeTag(line, defaultTheme);
  }
}

module.exports = new PromptOptimizer();
