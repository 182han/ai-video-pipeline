// ==========================================
// 迁移：把 data/templates.json 里的英文词池刷成中文
//
// 背景：promptOptimizer.loadTemplates() 的行为是「磁盘文件优先」——
// 已存在的 data/templates.json 会覆盖源码里的 DEFAULT_TEMPLATES，
// 所以只改源码，已有安装仍然是英文。这个脚本补上那一步。
//
// 用法：
//   node scripts/migrate-templates-zh.js            # 备份后写入
//   node scripts/migrate-templates-zh.js --dry-run  # 只看会改什么
//
// 只覆盖内置的 9 个主题 id；UI 里自建的模板原样保留。
// ==========================================

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const TPL_FILE = path.join(APP_DIR, 'data', 'templates.json');
const ZH = require(path.join(APP_DIR, 'src', 'templates.zh.js'));

const DRY = process.argv.includes('--dry-run');

function main() {
  if (!fs.existsSync(TPL_FILE)) {
    console.log('data/templates.json 不存在，无需迁移（新装会直接用中文词池）');
    return 0;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(TPL_FILE, 'utf-8'));
  } catch (e) {
    console.error('读取 templates.json 失败:', e.message);
    return 1;
  }

  const changed = [];
  const skipped = [];

  for (const [id, zh] of Object.entries(ZH)) {
    const tpl = data[id];
    if (!tpl) {
      skipped.push(`${id}(文件中不存在)`);
      continue;
    }
    const before = JSON.stringify({
      k: tpl.keywords, s: tpl.styleEnhancers, n: tpl.negative, st: tpl.structure,
    });
    if (zh.keywords) tpl.keywords = zh.keywords;
    if (zh.styleEnhancers) tpl.styleEnhancers = zh.styleEnhancers;
    if (zh.negative) tpl.negative = zh.negative;
    if (zh.structure) tpl.structure = zh.structure;
    const after = JSON.stringify({
      k: tpl.keywords, s: tpl.styleEnhancers, n: tpl.negative, st: tpl.structure,
    });
    if (before !== after) changed.push(id);
  }

  const extra = Object.keys(data).filter((id) => !ZH[id]);

  console.log(`模板总数: ${Object.keys(data).length}`);
  console.log(`本次改写: ${changed.length ? changed.join(', ') : '（无变化）'}`);
  if (skipped.length) console.log(`跳过: ${skipped.join(', ')}`);
  if (extra.length) console.log(`保留的非内置模板: ${extra.join(', ')}`);

  if (!changed.length) {
    console.log('已是中文词池，无需写入');
    return 0;
  }

  if (DRY) {
    console.log('[dry-run] 未写入');
    return 0;
  }

  const backup = TPL_FILE.replace(/\.json$/, '.bak.' + Date.now() + '.json');
  fs.copyFileSync(TPL_FILE, backup);
  fs.writeFileSync(TPL_FILE, JSON.stringify(data, null, 2), 'utf-8');
  console.log('已备份:', path.basename(backup));
  console.log('已写入:', TPL_FILE);
  return 0;
}

process.exit(main());
