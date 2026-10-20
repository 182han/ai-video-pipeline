// ==========================================
// 验收：fengguang skill 规则层是否真的接进了提示词优化链路
// 覆盖：规则文件存在 / 作用域（仅风光主题）/ 关闭开关 / systemPrompt 组成 / 无 Key 回落
// 纯逻辑，不起服务、不联网、不花生成费
// ==========================================

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const MARKER = '摄影级风光叠加规则';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

(async () => {
  console.log('=== verify-skill-prompt ===\n');

  // ---------- 1. 模块与规则文件 ----------
  section('1. 模块与规则文件');
  const promptSkill = require(path.join(APP_DIR, 'src', 'promptSkill.js'));

  ok('promptSkill 模块可加载', !!promptSkill);
  ok('导出 appendTo', typeof promptSkill.appendTo === 'function');
  ok('导出 buildSystemPrompt 所需的 appliesTo', typeof promptSkill.appliesTo === 'function');
  ok('规则文件路径指向 data/', promptSkill.RULES_FILE.endsWith(path.join('data', 'skill-fengguang.rules.md')));
  ok('规则文件存在', fs.existsSync(promptSkill.RULES_FILE), promptSkill.RULES_FILE);

  const rules = promptSkill.getSkillRules();
  ok('规则非空', rules.length > 500, `长度 ${rules.length}`);
  ok('规则含标识', rules.includes(MARKER));
  ok('规则含七段公式', rules.includes('七段公式'));
  ok('规则含高光控制', rules.includes('高光') || rules.includes('controlled highlights'));
  ok('规则含地貌专名表', rules.includes('沙丘脊线') && rules.includes('丹霞'));
  ok('规则含天文分支', rules.includes('天文'));

  // ---------- 2. 作用域 ----------
  section('2. 作用域：只叠加风光类主题');
  for (const t of ['landscape', 'mountain', 'desert', 'lake', 'ocean', 'waterfall', 'aurora', 'space']) {
    ok(`appliesTo(${t}) = true`, promptSkill.appliesTo(t) === true);
  }
  ok('appliesTo(city) = false', promptSkill.appliesTo('city') === false);
  ok('appliesTo(null) = false', promptSkill.appliesTo(null) === false);
  ok('appliesTo(unknown) = false', promptSkill.appliesTo('not-a-theme') === false);

  const base = 'BASE-RULES';
  ok('appendTo 对 landscape 追加', promptSkill.appendTo(base, 'landscape').includes(MARKER));
  ok('appendTo 对 city 原样返回', promptSkill.appendTo(base, 'city') === base);
  ok('appendTo 对无主题原样返回', promptSkill.appendTo(base, null) === base);

  // ---------- 3. 关闭开关 ----------
  section('3. SKILL_PROMPT_ENABLED=false 可关闭');
  const prev = process.env.SKILL_PROMPT_ENABLED;
  process.env.SKILL_PROMPT_ENABLED = 'false';
  ok('关闭后 appliesTo 仍为 true（作用域不变）', promptSkill.appliesTo('landscape') === true);
  ok('关闭后 appendTo 不追加', promptSkill.appendTo(base, 'landscape') === base);
  process.env.SKILL_PROMPT_ENABLED = 'true';
  ok('重新开启后追加恢复', promptSkill.appendTo(base, 'landscape').includes(MARKER));
  if (prev === undefined) delete process.env.SKILL_PROMPT_ENABLED;
  else process.env.SKILL_PROMPT_ENABLED = prev;

  // ---------- 4. 接入 PromptOptimizer ----------
  section('4. PromptOptimizer.buildSystemPrompt 组成');
  // 注意：promptOptimizer 导出的是单例实例（module.exports = new PromptOptimizer()）
  const optimizer = require(path.join(APP_DIR, 'src', 'promptOptimizer.js'));

  ok('导出的是实例且有 templates', !!optimizer.templates && typeof optimizer.templates === 'object');
  ok('存在 buildSystemPrompt 方法', typeof optimizer.buildSystemPrompt === 'function');

  const land = optimizer.buildSystemPrompt('landscape');
  ok('landscape systemPrompt 含 skill 段', land.systemPrompt.includes(MARKER));
  ok('landscape 保留原有结构化参考', land.systemPrompt.includes('结构化参考'));
  ok('landscape themeLabel = 模板名', land.themeLabel === optimizer.templates.landscape.name, land.themeLabel);
  ok('landscape negative 非空', !!land.negative);

  const city = optimizer.buildSystemPrompt('city');
  ok('city systemPrompt 不含 skill 段', !city.systemPrompt.includes(MARKER));
  ok('city 仍含原有规则', city.systemPrompt.includes('风格参考'));

  const none = optimizer.buildSystemPrompt(null);
  ok('无主题 systemPrompt 不含 skill 段', !none.systemPrompt.includes(MARKER));
  ok('无主题 themeLabel = 无主题', none.themeLabel === '无主题');

  const au = optimizer.buildSystemPrompt('aurora');
  ok('aurora 含 skill 段', au.systemPrompt.includes(MARKER));

  // ---------- 5. optimizeWithAI 仍走旧路径 ----------
  section('5. optimizeWithAI 未被改坏');
  const src = optimizer.optimizeWithAI.toString();
  ok('optimizeWithAI 调用了 buildSystemPrompt', src.includes('buildSystemPrompt'));
  ok('optimizeWithAI 不再内联拼 systemPrompt', !src.includes('结构化参考'));

  ok('optimizeWithAI 从 buildSystemPrompt 解构', /const\s*\{\s*systemPrompt[^}]*\}\s*=\s*this\.buildSystemPrompt/.test(src));
  // 刻意不真调 optimizeWithAI：有 Key 时会实际发请求、产生费用

  // ---------- 6. 模板路径不受影响 ----------
  section('6. 模板路径（不经过 LLM）不受影响');
  const tpl = optimizer.optimizeWithTemplate('雪山', 'mountain', { seed: 1 });
  ok('模板优化仍返回 optimized', typeof tpl.optimized === 'string' && tpl.optimized.length > 0);
  ok('模板优化不包含 skill 段', !tpl.optimized.includes(MARKER));

  // ---------- 7. 全中文输出 ----------
  section('7. 全中文输出（指令 + 词池 + 磁盘模板）');
  const srcFile = fs.readFileSync(path.join(APP_DIR, 'src', 'promptOptimizer.js'), 'utf-8');
  ok('DEFAULT_RULES 要求中文输出', srcFile.includes('用中文输出'));
  ok('structureRef 要求全中文输出', srcFile.includes('全中文输出'));
  ok('源码不再要求英文输出', !srcFile.includes('用英文输出') && !srcFile.includes('全英文输出'));

  const zhPool = require(path.join(APP_DIR, 'src', 'templates.zh.js'));
  ok('中文词池模块覆盖 9 个主题', Object.keys(zhPool).length === 9);

  // 只扫「字符串值」，不要把对象键名（landscape / subjectPool…）当成英文残留
  const collectStrings = (v, out = []) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out));
    return out;
  };

  const poolAscii = [...new Set((collectStrings(zhPool).join(' ').match(/[A-Za-z]{2,}/g) || []))]
    .filter((w) => !['mm', 'logo'].includes(w));
  ok('中文词池无英文残留（允许 mm/logo）', poolAscii.length === 0, poolAscii.join(','));

  const tplFile = path.join(APP_DIR, 'data', 'templates.json');
  ok('磁盘 templates.json 存在', fs.existsSync(tplFile));
  if (fs.existsSync(tplFile)) {
    const disk = JSON.parse(fs.readFileSync(tplFile, 'utf-8'));
    const diskSubject = (disk.landscape.structure || {}).subjectPool || [];
    ok('磁盘模板主体池已中文化', /[\u4e00-\u9fa5]/.test(diskSubject[0] || ''), diskSubject[0]);
    // 只校验内置 9 个主题的池内容，避免把 name/emoji 等字段算进去
    const diskPools = Object.values(disk).filter((t) => t && t.structure).map((t) => t.structure);
    const structAscii = [...new Set((collectStrings(diskPools).join(' ').match(/[A-Za-z]{2,}/g) || []))]
      .filter((w) => !['mm', 'logo'].includes(w));
    ok('磁盘模板池无英文残留（允许 mm/logo）', structAscii.length === 0, structAscii.join(','));
  }

  const zhOut = optimizer.optimizeWithTemplate('沙丘上的日落', 'desert', { seed: 2 });
  const outAscii = [...new Set((zhOut.optimized.match(/[A-Za-z]{2,}/g) || []))].filter((w) => !['mm', 'logo'].includes(w));
  ok('模板优化输出无英文残留', outAscii.length === 0, outAscii.join(','));
  ok('模板优化输出含中文', /[\u4e00-\u9fa5]/.test(zhOut.optimized));

  // ---------- 汇总 ----------
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验收脚本异常:', e);
  process.exit(1);
});
