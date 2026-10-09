// ==========================================
// 提示词优化模块
// 功能：模板管理 + 模板优化 + AI 优化（可选）
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const RULES_FILE = path.join(DATA_DIR, 'optimization_rules.txt');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 内置默认模板
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
    negative: 'people, text, watermark, logo'
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
    negative: 'people, earth, text'
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
    negative: 'people, buildings, city'
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
    negative: 'people, boats, text'
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
    negative: 'people, buildings, text'
  }
};

// 默认优化规则
const DEFAULT_RULES = `你是一个专业的AI视频提示词优化师。
你的任务是把用户的简单描述，扩写成高质量的英文视频生成提示词。

优化规则：
1. 补充环境和场景细节（时间、天气、角度）
2. 添加光线描述（金色阳光/月光/霓虹等）
3. 添加运镜方式（缓慢推进/环绕/平移等）
4. 添加画质描述（4K、电影级、高细节）
5. 添加氛围描述（宁静/史诗/梦幻等）
6. 用英文输出，长度100-200字
7. 不要出现人物
8. 输出只包含优化后的提示词，不要其他解释`;

// ==========================================
// 持久化工具
// ==========================================

function loadTemplates() {
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      const data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
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
    return Object.entries(this.templates).map(([id, t]) => ({
      id,
      name: t.name,
      emoji: t.emoji || '🎬',
      keywords: t.keywords,
      styleEnhancers: t.styleEnhancers,
      negative: t.negative
    }));
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

  validatePrompt(prompt, theme = 'landscape') {
    const issues = [];
    const warnings = [];

    // 长度检查
    if (!prompt || prompt.trim().length === 0) {
      issues.push('提示词不能为空');
    } else if (prompt.trim().length < 5) {
      warnings.push('提示词太短，建议增加更多细节描述');
    }

    // 中文检测（视频生成模型通常需要英文提示词）
    if (/[\u4e00-\u9fa5]/.test(prompt)) {
      warnings.push('检测到中文，建议使用英文提示词以获得更好效果');
    }

    // 检查是否包含人物
    if (/people|person|man|woman|child|girl|boy|human/i.test(prompt)) {
      warnings.push('包含人物描述，部分模型可能生成效果不佳');
    }

    // 检查是否包含文字/水印
    if (/text|watermark|logo|subtitle/i.test(prompt)) {
      warnings.push('包含文字/水印关键词，建议添加到负面提示词中');
    }

    return {
      valid: issues.length === 0,
      issues,
      warnings,
      score: Math.max(0, 100 - issues.length * 30 - warnings.length * 10)
    };
  }

  // ===== 提示词优化 =====

  // 模板优化（无需 AI，速度快，免费）
  optimizeWithTemplate(userPrompt, theme = 'landscape') {
    const template = this.templates[theme] || this.templates.landscape;

    // 随机选 4-6 个风格增强词
    const shuffled = [...template.styleEnhancers].sort(() => Math.random() - 0.5);
    const selectedStyles = shuffled.slice(0, 4 + Math.floor(Math.random() * 3));

    // 组合提示词
    const optimized = `${userPrompt}, ${selectedStyles.join(', ')}`;

    return {
      method: 'template',
      theme: template.name,
      original: userPrompt,
      optimized,
      negative: template.negative
    };
  }

  // AI 优化（需要 LLM API Key）
  async optimizeWithAI(userPrompt, theme = 'landscape', options = {}) {
    const apiKey = options.apiKey || config.OPENAI_API_KEY;
    const baseUrl = options.baseUrl || config.OPENAI_BASE_URL;
    const model = options.model || config.OPENAI_MODEL;

    // 如果没有 API Key，降级到模板优化
    if (!apiKey) {
      console.log('未配置 LLM API Key，使用模板优化');
      return this.optimizeWithTemplate(userPrompt, theme);
    }

    try {
      const template = this.templates[theme] || this.templates.landscape;

      const systemPrompt = `
${this.rules}

当前主题：${template.name}
参考关键词：${template.keywords.join(', ')}
风格参考：${template.styleEnhancers.join(', ')}
负面提示：${template.negative}
`;

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
        theme: template.name,
        original: userPrompt,
        optimized,
        negative: template.negative
      };

    } catch (error) {
      console.error('AI 优化失败，降级到模板优化:', error.message);
      return this.optimizeWithTemplate(userPrompt, theme);
    }
  }
}

module.exports = new PromptOptimizer();
