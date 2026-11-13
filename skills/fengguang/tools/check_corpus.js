#!/usr/bin/env node
/**
 * check_corpus.js — 风光提示词语料的体检脚本（零依赖）
 *
 * 用法：
 *   node check_corpus.js <base.jsonl>                          # 人读报告
 *   node check_corpus.js <base.jsonl> --variants <variants.jsonl>  # 连扩写集一起查
 *   node check_corpus.js <base.jsonl> --json                   # 机器可读
 *   node check_corpus.js <base.jsonl> --strict                 # warning 也算失败
 *
 * error   = 结构 / 枚举 / 唯一性 / 时间格式 / 单维度被破坏 —— 必须修
 * warning = 证据强度问题 —— 可入库，但训练前要人看
 *
 * 依据：references/语料规范.md
 * 退出码：0 = 无 error；1 = 有 error（--strict 下 warning 也算）
 */

const fs = require('fs');

const REQUIRED = [
  'id', 'src', 't', 'place', 'theme', 'landform', 'light',
  'camera', 'motion', 'atmosphere', 'lock', 'palette', 'grade',
  'overlay', 'frame_source', 'prompt',
];
const THEMES = ['landscape', 'space', 'aurora', 'ocean', 'mountain', 'desert', 'waterfall', 'lake', 'city'];
const PALETTES = ['极冷极淡', '暖浓', '暗底暖星云'];
const GRADES = ['dramatic', 'cinematic-calm'];
const BANNED = ['震撼', '唯美', '大片', '绝美', '4K', '8K', 'cinematic', 'hyperrealistic',
  '配乐', '音乐', '音效', 'BGM', '杜比', '声音', '分辨率'];

// 扩写：每个 changed 只允许动这些字段
const CHANGED_ALLOWED = {
  'camera-move': ['camera', 'motion'],
  'light-azimuth': ['light', 'atmosphere'],
  'lens': ['camera'],
};
// 不允许动的公共字段（改了就不是"同一条素材的变体"）
const SHARED = ['src', 't', 'place', 'theme', 'landform', 'lock', 'palette', 'grade', 'overlay'];

// 运动轴：静机位与强运动词互斥；缓推与滑行/环绕/俯冲互斥
const AXIS_PAIRS = [
  [/静机位|固定机位/, /缓推|横移|滑行|环绕|斜冲|俯冲|爬升/],
  [/缓推/, /滑行|环绕|俯冲|爬升|甩镜/],
];
function axisConflict(text) {
  for (const [a, b] of AXIS_PAIRS) if (a.test(text) && b.test(text)) return a.source + ' × ' + b.source;
  return null;
}

// camera 拆成「焦段」与「其余」两半，用于判定扩写到底改了哪一半
function mmList(camera) {
  return (String(camera || '').match(/\d{2,4}\s*mm/g) || []).map((s) => s.replace(/\s/g, ''));
}
function nonMm(camera) {
  return String(camera || '').replace(/\d{2,4}\s*mm/g, '').replace(/[\s，,、。；;:：]/g, '');
}

function parseArgs(argv) {
  const out = { file: null, variants: null, json: false, strict: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--variants') out.variants = argv[++i] || null;
    else if (!out.file) out.file = a;
  }
  return out;
}

function load(file, errors) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line, i) => ({ line, ln: i + 1 }))
    .filter((x) => x.line.trim())
    .map((x) => {
      try {
        return { __line: x.ln, ...JSON.parse(x.line) };
      } catch (e) {
        errors.push({ id: 'line ' + x.ln, code: 'BAD_JSON', msg: e.message });
        return null;
      }
    })
    .filter(Boolean);
}

function checkBase(rows, errors, warnings) {
  const add = (list, id, code, msg) => list.push({ id, code, msg });
  const ids = new Map();
  const prompts = new Map();

  for (const r of rows) {
    const id = r.id || 'line ' + r.__line;
    for (const k of REQUIRED) if (!(k in r)) add(errors, id, 'MISSING_FIELD', '缺字段 ' + k);
    if (r.overlay === true && !String(r.overlay_note || '').trim()) {
      add(errors, id, 'OVERLAY_NO_NOTE', 'overlay=true 必须写 overlay_note（标了什么）');
    }
    if (r.overlay_note !== undefined && typeof r.overlay !== 'boolean') {
      add(errors, id, 'BAD_OVERLAY', 'overlay 必须是 true/false');
    }
    if (r.theme && !THEMES.includes(r.theme)) add(errors, id, 'BAD_THEME', 'theme=' + r.theme);
    if (r.palette && !PALETTES.includes(r.palette)) add(errors, id, 'BAD_PALETTE', 'palette=' + r.palette);
    if (r.grade && !GRADES.includes(r.grade)) add(errors, id, 'BAD_GRADE', 'grade=' + r.grade);
    if (r.src && !/^BV[0-9A-Za-z]{10}$/.test(r.src)) add(errors, id, 'BAD_SRC', 'src=' + r.src);
    if (r.t && !/^\d{1,3}:\d{2}$/.test(r.t)) add(errors, id, 'BAD_TIME', 't=' + r.t + '（mm:ss）');

    if (ids.has(r.id)) add(errors, id, 'DUP_ID', '与 line ' + ids.get(r.id) + ' 重复');
    else ids.set(r.id, r.__line);

    const p = String(r.prompt || '').trim();
    if (p) {
      if (prompts.has(p)) add(errors, id, 'DUP_PROMPT', '与 ' + prompts.get(p) + ' 的 prompt 完全相同');
      else prompts.set(p, id);
    }

    const negative = /^（负样本/.test(p) || /负样本/.test(String(r.note || ''));
    if (negative) {
      if (!r.note) add(warnings, id, 'NEG_NO_NOTE', '负样本建议写 note');
      if (r.overlay !== true) add(warnings, id, 'NEG_NOT_OVERLAY', '负样本通常 overlay=true');
    } else if (p) {
      for (const w of BANNED) if (p.toLowerCase().includes(w.toLowerCase())) {
        add(warnings, id, 'BANNED_WORD', 'prompt 含「' + w + '」');
      }
      if (!/高光/.test(p)) add(warnings, id, 'NO_HIGHLIGHT', 'prompt 未提高光控制（§九）');
      if (!/无新元素进入|画面锁在/.test(p)) add(warnings, id, 'NO_LOCK', 'prompt 结尾未锁死画面');
      const ax = axisConflict(p);
      if (ax) add(warnings, id, 'AXIS_CONFLICT', '运镜句疑似双主轴：' + ax);
      if (p.length < 100) add(warnings, id, 'SHORT_PROMPT', 'prompt 偏短，可能缺段');
    }

    if (!('verified' in r)) add(warnings, id, 'NO_VERIFIED', '缺 verified：无法区分看过帧与推断');
    if (r.verified === false) add(warnings, id, 'UNVERIFIED', 'verified=false：训练前必须看帧');
    if (Array.isArray(r.inferred) && r.inferred.length) {
      add(warnings, id, 'INFERRED', '推断字段：' + r.inferred.join(', '));
    }
    if (r.theme === 'aurora' && (!r.aurora_type || !r.foreground)) {
      add(warnings, id, 'AURORA_FIELDS', 'aurora 行缺 aurora_type / foreground');
    }
  }
  return new Map(rows.map((r) => [r.id, r]));
}

function checkVariants(vrows, baseById, errors, warnings) {
  const add = (list, id, code, msg) => list.push({ id, code, msg });
  const ids = new Map();
  const perBase = {};
  let verifiedMissing = 0;

  for (const r of vrows) {
    const id = r.id || 'line ' + r.__line;
    const b = baseById.get(r.variant_of);
    if (!b) {
      add(errors, id, 'VARIANT_NO_BASE', 'variant_of=' + r.variant_of + ' 在 base 里不存在');
      continue;
    }
    if (!CHANGED_ALLOWED[r.changed]) add(errors, id, 'BAD_CHANGED', 'changed=' + r.changed);
    if (!new RegExp('^' + r.variant_of.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-v\\d+$').test(r.id || '')) {
      add(errors, id, 'BAD_VARIANT_ID', 'id 应为 ' + r.variant_of + '-vN');
    }
    if (ids.has(r.id)) add(errors, id, 'DUP_ID', '与 line ' + ids.get(r.id) + ' 重复');
    else ids.set(r.id, r.__line);
    perBase[r.variant_of] = (perBase[r.variant_of] || 0) + 1;
    if (!('verified' in r)) verifiedMissing++;

    for (const k of REQUIRED) {
      if (k === 'overlay_note') continue;
      if (!(k in r)) add(errors, id, 'MISSING_FIELD', '缺字段 ' + k);
    }
    if (!('variant_of' in r)) add(errors, id, 'MISSING_FIELD', '缺字段 variant_of');
    if (!('changed' in r)) add(errors, id, 'MISSING_FIELD', '缺字段 changed');
    if (r.overlay === true && !String(r.overlay_note || b.overlay_note || '').trim()) {
      add(errors, id, 'OVERLAY_NO_NOTE', 'overlay=true 且 base 也没有 overlay_note');
    }

    for (const k of SHARED) {
      if (JSON.stringify(r[k]) !== JSON.stringify(b[k])) {
        add(errors, id, 'SHARED_FIELD_CHANGED', k + ' 与 base 不一致（变体只许改一个维度）');
      }
    }

    const allowed = CHANGED_ALLOWED[r.changed] || [];
    const diff = Object.keys(r).filter(
      (k) => !['__line', 'id', 'variant_of', 'changed', 'prompt', 'verified', 'inferred', 'note'].includes(k)
        && JSON.stringify(r[k]) !== JSON.stringify(b[k])
    );
    const illegal = diff.filter((k) => !allowed.includes(k));
    if (illegal.length) {
      add(errors, id, 'MULTI_DIM', 'changed=' + r.changed + ' 却还改了 ' + illegal.join(','));
    }
    if (!diff.length) add(errors, id, 'NO_CHANGE', '与 base 的字段完全一致，等于没扩写');
    if (r.prompt === b.prompt) add(errors, id, 'PROMPT_SAME', 'prompt 与 base 相同');

    // camera 内部再拆一层：焦段 / 机位与运镜
    const bmm = mmList(b.camera).join(',');
    const rmm = mmList(r.camera).join(',');
    if (r.changed === 'lens') {
      if (bmm === rmm) add(errors, id, 'LENS_MM_SAME', 'lens 变体但焦段没变');
      if (nonMm(b.camera) !== nonMm(r.camera)) {
        add(errors, id, 'LENS_CHANGED_MORE', 'lens 变体连机位/运镜也改了（base: ' + b.camera + ' → ' + r.camera + '）');
      }
    }
    if (r.changed === 'camera-move' && bmm !== rmm) {
      add(errors, id, 'MOVE_CHANGED_MM', 'camera-move 变体却改了焦段（' + bmm + ' → ' + rmm + '）');
    }
    if (r.prompt) {
      for (const w of BANNED) if (String(r.prompt).toLowerCase().includes(w.toLowerCase())) {
        add(warnings, id, 'BANNED_WORD', 'prompt 含「' + w + '」');
      }
      const ax = axisConflict(String(r.prompt));
      if (ax) add(warnings, id, 'AXIS_CONFLICT', '运镜句疑似双主轴：' + ax);
      if (String(r.prompt).length < 100) add(warnings, id, 'SHORT_PROMPT', 'prompt 偏短');
    }
  }

  for (const [bid, n] of Object.entries(perBase)) {
    if (n !== 3) add(warnings, bid, 'VARIANT_COUNT', '该素材有 ' + n + ' 条变体（期望 3）');
  }
  if (verifiedMissing) {
    add(warnings, 'variants', 'NO_VERIFIED', verifiedMissing + ' 条变体缺 verified（可从 base 继承）');
  }
  return { perBase, verifiedMissing };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('usage: node check_corpus.js <base.jsonl> [--variants <variants.jsonl>] [--json] [--strict]');
    process.exit(2);
  }

  const errors = [];
  const warnings = [];
  const base = load(args.file, errors);
  const baseIds = checkBase(base, errors, warnings);
  const vrows = args.variants ? load(args.variants, errors) : [];
  const vres = args.variants ? checkVariants(vrows, baseIds, errors, warnings) : null;

  const by = (arr, f) => arr.reduce((a, r) => ((a[r[f]] = (a[r[f]] || 0) + 1), a), {});
  const summary = {
    baseFile: args.file,
    variantFile: args.variants || null,
    baseRows: base.length,
    variantRows: vrows.length,
    totalRows: base.length + vrows.length,
    uniqueSrc: new Set(base.map((r) => r.src)).size,
    errors: errors.length,
    warnings: warnings.length,
    themes: by(base, 'theme'),
    palettes: by(base, 'palette'),
    grades: by(base, 'grade'),
    overlay: base.filter((r) => r.overlay === true).length,
    negative: base.filter((r) => /^（负样本/.test(String(r.prompt)) || /负样本/.test(String(r.note || ''))).length,
    verifiedTrue: base.filter((r) => r.verified === true).length,
    verifiedMissing: base.filter((r) => !('verified' in r)).length,
    changed: vres ? by(vrows, 'changed') : null,
    missingThemes: THEMES.filter((t) => !base.some((r) => r.theme === t)),
    avgPromptChars: base.length
      ? Math.round(base.reduce((s, r) => s + String(r.prompt || '').length, 0) / base.length) : 0,
  };

  const printGrouped = (title, list) => {
    if (!list.length) return;
    const groups = new Map();
    for (const it of list) {
      if (!groups.has(it.code)) groups.set(it.code, []);
      groups.get(it.code).push(it);
    }
    console.log('\n-- ' + title + ' (' + list.length + ') --');
    for (const [code, items] of groups) {
      const ids = items.map((x) => x.id);
      const shown = ids.slice(0, 8).join(', ') + (ids.length > 8 ? ' …(+' + (ids.length - 8) + ')' : '');
      console.log('[' + code + '] ' + items.length + ' 条 · ' + items[0].msg);
      console.log('    ' + shown);
    }
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, errors, warnings }, null, 2));
  } else {
    console.log('== ' + args.file + (args.variants ? '  +  ' + args.variants : ''));
    console.log('base ' + summary.baseRows + ' 行 · 源片 ' + summary.uniqueSrc
      + (args.variants ? ' · 变体 ' + summary.variantRows + ' 行 · 合计 ' + summary.totalRows : '')
      + ' · error ' + summary.errors + ' · warning ' + summary.warnings);
    console.log('主题 ' + JSON.stringify(summary.themes) + (summary.missingThemes.length ? '  缺: ' + summary.missingThemes.join(',') : ''));
    console.log('色板 ' + JSON.stringify(summary.palettes) + ' · 档位 ' + JSON.stringify(summary.grades));
    console.log('overlay ' + summary.overlay + ' · 负样本 ' + summary.negative
      + ' · verified=true ' + summary.verifiedTrue + ' · 无 verified 字段 ' + summary.verifiedMissing);
    if (summary.changed) console.log('变体维度 ' + JSON.stringify(summary.changed));
    printGrouped('error', errors);
    printGrouped('warning', warnings);
    if (args.variants) console.log('\n提示：切 train/eval 必须按 variant_of 分组，同组不跨集。');
  }

  const fail = errors.length > 0 || (args.strict && warnings.length > 0);
  process.exit(fail ? 1 : 0);
}

main();
