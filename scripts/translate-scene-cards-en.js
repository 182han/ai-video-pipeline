#!/usr/bin/env node
// ==========================================================
// 场景卡英译工具（词表唯一来源 / 分批供译 / 中英对照 / 落盘校验）
// ----------------------------------------------------------
// 词表：assets/scene-cards/en/batch-<N>.tsv
//   每行 field|中文|英文（# 开头为注释）
//   同一个 field+中文 只允许一条；不同批次重复即报冲突。
//
// 用法（在 app/ 下执行）：
//   node scripts/translate-scene-cards-en.js status
//   node scripts/translate-scene-cards-en.js missing --batch 1
//   node scripts/translate-scene-cards-en.js fill --batch 1 [--answers <路径>]
//   node scripts/translate-scene-cards-en.js report --batch 1 --out docs/交接/xxx.md [--excerpt 2]
//   node scripts/translate-scene-cards-en.js check
//
// 设计边界：
//   · 不调用任何模型/网络接口；只读源卡库 + 词表，只写词表/报告；
//   · 构建脚本 scripts/build-scene-cards-final.js 复用本文件的 loadDictionary()/
//     resolveCard()，保证「构建产物」与「词表」是同一份事实；
//   · 英文只允许可打印 ASCII（避免中文标点/全角字符混入提示词）。
// ==========================================================

'use strict';

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const ROOT_DIR = path.join(APP_DIR, '..');
const EN_DIR = path.join(APP_DIR, 'assets', 'scene-cards', 'en');
const SOURCE_FILE = path.join(ROOT_DIR, 'docs', 'scene-cards-v3.2-science.json');
const ASSET_FILE = path.join(APP_DIR, 'assets', 'scene-cards', 'v3.3-final.json');

const EN_FIELDS = Object.freeze([
  'biome', 'landform', 'feature', 'foreground', 'weather', 'season', 'light',
  'shot', 'cameraAngle', 'lens', 'motion', 'palette', 'highlight_control',
  'protagonist', 'avoid', 'end_lock'
]);

// 16 个展示/正向字段之外，英文负向提示词还需要这两类（只加字段，不进 16 字段计数）：
//   · negative：全库同一串，英文负向词的主列表；
//   · science.forbidden：卡级负向补充（7 种）。它们只在英文负向路径使用。
const EXTRA_FIELDS = Object.freeze(['negative', 'science.forbidden']);
const ALL_FIELDS = Object.freeze([...EN_FIELDS, ...EXTRA_FIELDS]);

const FIELD_LABEL = Object.freeze({
  biome: 'biome', landform: 'landform', feature: 'feature', foreground: 'foreground',
  weather: 'weather', season: 'season', light: 'light', shot: 'shot',
  cameraAngle: 'cameraAngle', lens: 'lens', motion: 'motion', palette: 'palette',
  highlight_control: 'highlight_control', protagonist: 'protagonist',
  avoid: 'avoid', end_lock: 'end_lock'
});

const BATCH_SIZE = 40;
const CARD_TOTAL = 200;
const FIELD_TOTAL = EN_FIELDS.length;
const MAX_LEN = 400;
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;
const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const KEY_SEP = '\u0001';

// ---------- 基础 ----------

function assertEnglish(value, ctx) {
  if (typeof value !== 'string') throw new Error(`${ctx}: 不是字符串`);
  const s = value.trim();
  if (!s) throw new Error(`${ctx}: 空值`);
  if (s.length > MAX_LEN) throw new Error(`${ctx}: 超过 ${MAX_LEN} 字符（${s.length}）`);
  if (s.includes('|')) throw new Error(`${ctx}: 不能包含 |（TSV 分隔符）`);
  if (!ASCII_PRINTABLE.test(s)) throw new Error(`${ctx}: 含非 ASCII 字符（只允许可打印英文/数字/标点）`);
  return s;
}

function keyOf(field, zh) {
  return `${field}${KEY_SEP}${String(zh)}`;
}

// 中文 16 字段（shot 兼容源文件的 shot_type）
function zhOf(card) {
  const out = {};
  for (const f of EN_FIELDS) {
    out[f] = f === 'shot' ? (card.shot || card.shot_type) : card[f];
  }
  return out;
}

function loadSourceCards() {
  const raw = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  const cards = raw.cards;
  if (!Array.isArray(cards) || cards.length !== CARD_TOTAL) {
    throw new Error(`源卡库 ${SOURCE_FILE} 期望 ${CARD_TOTAL} 张，实际 ${cards && cards.length}`);
  }
  const bad = [];
  for (const c of cards) {
    const zh = zhOf(c);
    for (const f of EN_FIELDS) {
      if (zh[f] === undefined || zh[f] === null || String(zh[f]).trim() === '') bad.push(`${c.id}.${f}`);
    }
  }
  if (bad.length) throw new Error(`源卡库 16 字段有空值：${bad.slice(0, 10).join(', ')}`);
  return cards;
}

function batchCards(cards, batchNo) {
  const n = Number(batchNo);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`--batch 只能是 1..5（收到 ${batchNo}）`);
  const start = (n - 1) * BATCH_SIZE;
  const chunk = cards.slice(start, start + BATCH_SIZE);
  if (chunk.length !== BATCH_SIZE) throw new Error(`批次 ${n} 应 ${BATCH_SIZE} 张，实际 ${chunk.length}`);
  return chunk;
}

// ---------- 词表 ----------

function batchNoOfFile(file) {
  const m = /^batch-(\d+)\.tsv$/.exec(file);
  return m ? Number(m[1]) : 0;
}

// shared.tsv 先加载（跨卡共享字段），其余按批次号升序
function fileOrder(file) {
  return file === 'shared.tsv' ? -1 : batchNoOfFile(file);
}

function loadDictionary() {
  const dict = new Map();
  if (!fs.existsSync(EN_DIR)) return dict;
  const files = fs.readdirSync(EN_DIR)
    .filter((f) => /^batch-\d+\.tsv$/.test(f) || f === 'shared.tsv')
    .sort((a, b) => fileOrder(a) - fileOrder(b));
  for (const file of files) {
    const full = path.join(EN_DIR, file);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const parts = t.split('|');
      if (parts.length !== 3) throw new Error(`${file}:${i + 1} 期望 field|中文|英文，实际 ${parts.length} 段`);
      const [field, zh, enRaw] = parts.map((s) => s.trim());
      if (!ALL_FIELDS.includes(field)) throw new Error(`${file}:${i + 1} 未知字段 ${field}`);
      if (!zh) throw new Error(`${file}:${i + 1} 中文为空`);
      const en = assertEnglish(enRaw, `${file}:${i + 1} ${field}`);
      const key = keyOf(field, zh);
      if (dict.has(key) && dict.get(key) !== en) {
        throw new Error(`${file}:${i + 1} 词表冲突：${field}「${zh}」已有「${dict.get(key)}」，又出现「${en}」`);
      }
      dict.set(key, en);
    });
  }
  return dict;
}

// 本批（40 张）里尚未翻译的唯一值，按「卡顺序 → 字段顺序」稳定编号
function missingEntries(batchNo, dict) {
  const d = dict || loadDictionary();
  const cards = loadSourceCards();
  const chunk = batchCards(cards, batchNo);
  const seen = new Set();
  const list = [];
  for (const card of chunk) {
    const zh = zhOf(card);
    for (const f of EN_FIELDS) {
      const key = keyOf(f, zh[f]);
      if (d.has(key) || seen.has(key)) continue;
      seen.add(key);
      list.push({ field: f, zh: String(zh[f]) });
    }
  }
  return list.map((e, i) => ({ ...e, index: i + 1 }));
}

function resolveCard(card, dict) {
  const d = dict || loadDictionary();
  const zh = zhOf(card);
  const out = {};
  const missing = [];
  for (const f of EN_FIELDS) {
    const en = d.get(keyOf(f, zh[f]));
    if (!en) missing.push(`${f}「${zh[f]}」`);
    else out[`${f}_en`] = en;
  }
  if (missing.length) {
    throw new Error(`英译词表缺 ${missing.length} 条：${missing.slice(0, 10).join(' / ')}${missing.length > 10 ? ' …' : ''}`);
  }
  return out;
}

// 构建时（分批）：只取已译字段；缺的留空，运行时 pickField 回退中文
function resolvePartialCard(card, dict) {
  const d = dict || loadDictionary();
  const zh = zhOf(card);
  const out = {};
  for (const f of EN_FIELDS) {
    const en = d.get(keyOf(f, zh[f]));
    if (en) out[`${f}_en`] = en;
  }
  return out;
}

// 负向提示词的英文字段（16 字段之外；只加字段，不动中文）
function resolveExtras(card, dict) {
  const d = dict || loadDictionary();
  const out = {};
  const neg = d.get(keyOf('negative', card.negative || ''));
  if (neg) out.negative_en = neg;
  const forbidden = card.science && card.science.forbidden;
  const forbiddenEn = forbidden ? d.get(keyOf('science.forbidden', forbidden)) : null;
  if (forbiddenEn) out.forbidden_en = forbiddenEn;
  return out;
}

// 构建时：已写的 _en 必须合法（非空/ASCII/≤400）。
// requireComplete：16×200 + negative_en×200 + science.forbidden_en×200 全量（最终验收）。
function assertBuiltCards(cards, opts = {}) {
  if (!Array.isArray(cards) || cards.length !== CARD_TOTAL) {
    throw new Error(`构建产物期望 ${CARD_TOTAL} 张，实际 ${cards && cards.length}`);
  }
  let slots = 0;
  let negative = 0;
  let forbidden = 0;
  for (const card of cards) {
    for (const f of EN_FIELDS) {
      const v = card[`${f}_en`];
      if (v === undefined || v === null || String(v).trim() === '') {
        if (opts.requireComplete) throw new Error(`缺 ${card.id}.${f}_en`);
        continue;
      }
      assertEnglish(v, `${card.id}.${f}_en`);
      slots++;
    }
    if (card.negative_en !== undefined) {
      assertEnglish(card.negative_en, `${card.id}.negative_en`);
      negative++;
    }
    if (card.science && card.science.forbidden_en !== undefined) {
      assertEnglish(card.science.forbidden_en, `${card.id}.science.forbidden_en`);
      forbidden++;
    }
  }
  if (opts.requireComplete) {
    const expected = CARD_TOTAL * FIELD_TOTAL;
    if (slots !== expected) throw new Error(`_en 槽位 ${slots}，期望 ${expected}`);
    if (negative !== CARD_TOTAL) throw new Error(`negative_en ${negative}，期望 ${CARD_TOTAL}`);
    if (forbidden !== CARD_TOTAL) throw new Error(`science.forbidden_en ${forbidden}，期望 ${CARD_TOTAL}`);
  }
  return { slots, negative, forbidden };
}

// 构建时：中文 16 字段必须与源卡逐字一致
function assertChineseUntouched(sourceCards, builtCards) {
  if (sourceCards.length !== builtCards.length) throw new Error('源卡/产物卡数不一致');
  for (let i = 0; i < sourceCards.length; i++) {
    const a = zhOf(sourceCards[i]);
    const b = zhOf(builtCards[i]);
    for (const f of EN_FIELDS) {
      if (String(a[f]) !== String(b[f])) {
        throw new Error(`中文被改动：${builtCards[i].id}.${f}「${a[f]}」→「${b[f]}」`);
      }
    }
  }
}

// 构建时：id / scene_key / chapter / sequence 必须与源卡逐字一致（历史任务靠它们关联）
function assertIdentityUntouched(sourceCards, builtCards) {
  if (sourceCards.length !== builtCards.length) throw new Error('源卡/产物卡数不一致');
  for (let i = 0; i < sourceCards.length; i++) {
    const a = sourceCards[i];
    const b = builtCards[i];
    for (const k of ['id', 'scene_key', 'chapter', 'sequence']) {
      if (String(a[k]) !== String(b[k])) {
        throw new Error(`卡身份字段被改动：${a.id}.${k}「${a[k]}」→「${b[k]}」`);
      }
    }
  }
}

// ---------- 统计 ----------

function coverage(dict) {
  const cards = loadSourceCards();
  let have = 0;
  let negative = 0;
  let forbidden = 0;
  const total = cards.length * FIELD_TOTAL;
  const used = new Set();
  for (const card of cards) {
    const zh = zhOf(card);
    for (const f of EN_FIELDS) {
      const key = keyOf(f, zh[f]);
      used.add(key);
      if (dict.has(key)) have++;
    }
    const negKey = keyOf('negative', card.negative || '');
    used.add(negKey);
    if (dict.has(negKey)) negative++;
    const forb = card.science && card.science.forbidden;
    if (forb) {
      const forbKey = keyOf('science.forbidden', forb);
      used.add(forbKey);
      if (dict.has(forbKey)) forbidden++;
    }
  }
  let unused = 0;
  for (const key of dict.keys()) if (!used.has(key)) unused++;
  return { cards: cards.length, have, total, used, unused, negative, forbidden };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function cmdStatus() {
  const dict = loadDictionary();
  const cov = coverage(dict);
  const pct = ((cov.have / cov.total) * 100).toFixed(2);
  console.log(`词表 ${dict.size} 条 | 覆盖 ${cov.have}/${cov.total}（${pct}%）| 未被任何卡使用 ${cov.unused} 条`);
  console.log(`负向补充：negative ${cov.negative}/${CARD_TOTAL} | science.forbidden ${cov.forbidden}/${CARD_TOTAL}`);
  for (let n = 1; n <= 5; n++) {
    const m = missingEntries(n, dict);
    const start = (n - 1) * BATCH_SIZE + 1;
    console.log(`批次 ${n}（卡 ${start}-${start + BATCH_SIZE - 1}）：缺 ${m.length} 条`);
  }
}

function cmdMissing(opts) {
  const n = Number(opts.batch);
  const list = missingEntries(n);
  const chunk = batchCards(loadSourceCards(), n);
  console.log(`# 批次 ${n} | 卡 ${(n - 1) * BATCH_SIZE + 1}-${n * BATCH_SIZE} | ${chunk[0].id} … ${chunk[chunk.length - 1].id} | 缺 ${list.length} 条`);
  for (const e of list) console.log(`${e.index}|${e.field}|${e.zh}`);
  const by = {};
  for (const e of list) by[e.field] = (by[e.field] || 0) + 1;
  console.log('# 按字段：' + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' / '));
}

function loadBatchEntries(file) {
  const list = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const parts = t.split('|');
    if (parts.length !== 3) throw new Error(`${file}:${i + 1} 期望 field|中文|英文`);
    const [field, zh] = parts.map((s) => s.trim());
    if (!ALL_FIELDS.includes(field)) throw new Error(`${file}:${i + 1} 未知字段 ${field}`);
    list.push({ field, zh });
  });
  return list;
}

function cmdFill(opts) {
  const n = Number(opts.batch);
  const batchPath = path.join(EN_DIR, `batch-${n}.tsv`);
  // 首次 fill：取「本批尚未翻译」的值；重跑 fill（改译后）：沿用已有 batch 文件的行序，
  // 这样 answers 的编号不会因为「已经翻完」而失效。
  const list = fs.existsSync(batchPath)
    ? loadBatchEntries(batchPath).map((e, i) => ({ ...e, index: i + 1 }))
    : missingEntries(n);
  const answersPath = path.resolve(opts.answers && opts.answers !== true
    ? String(opts.answers)
    : path.join(EN_DIR, `batch-${n}.answers.txt`));
  if (!fs.existsSync(answersPath)) throw new Error(`答案文件不存在：${answersPath}`);
  const answers = new Map();
  const lines = fs.readFileSync(answersPath, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = /^(\d+)\|(.+)$/.exec(t);
    if (!m) throw new Error(`${answersPath}:${i + 1} 期望 index|英文`);
    const idx = Number(m[1]);
    if (answers.has(idx)) throw new Error(`${answersPath}:${i + 1} 编号重复 ${idx}`);
    answers.set(idx, assertEnglish(m[2], `${answersPath}:${i + 1}`));
  });
  const bad = [];
  for (let i = 1; i <= list.length; i++) if (!answers.has(i)) bad.push(i);
  const extra = [...answers.keys()].filter((i) => i < 1 || i > list.length);
  if (bad.length || extra.length) {
    throw new Error(`答案编号不完整：${bad.length ? `缺 ${bad.slice(0, 20).join(',')}` : '无缺号'}；${extra.length ? `多 ${extra.slice(0, 20).join(',')}` : '无多号'}`);
  }
  const out = [];
  out.push(`# 场景卡英译批次 ${n}（卡 ${(n - 1) * BATCH_SIZE + 1}-${n * BATCH_SIZE}）`);
  out.push('# 格式：field|中文|英文；由 scripts/translate-scene-cards-en.js fill 生成');
  for (const e of list) out.push(`${e.field}|${e.zh}|${answers.get(e.index)}`);
  fs.writeFileSync(path.join(EN_DIR, `batch-${n}.tsv`), out.join('\n') + '\n', 'utf8');
  const dict = loadDictionary();
  const remain = missingEntries(n, dict).length;
  const cov = coverage(dict);
  console.log(`✓ 写入 assets/scene-cards/en/batch-${n}.tsv：${list.length} 条`);
  console.log(`本批剩余缺失：${remain}`);
  console.log(`全库覆盖：${cov.have}/${cov.total}（${((cov.have / cov.total) * 100).toFixed(2)}%）`);
  if (remain !== 0) process.exitCode = 1;
}

function cardTable(card, dict) {
  const zh = zhOf(card);
  const en = resolveCard(card, dict);
  const role = card.role === 'buffer' ? 'buffer' : 'feature';
  const lines = [];
  lines.push(`### ${card.id} · ${zh.biome} / ${zh.landform} · ${role} · chapter ${card.chapter}-${card.sequence}`);
  lines.push('');
  lines.push('| 字段 | 中文 | 英文 |');
  lines.push('| --- | --- | --- |');
  for (const f of EN_FIELDS) {
    lines.push(`| ${FIELD_LABEL[f]} | ${String(zh[f]).replace(/\|/g, '\\|')} | ${en[`${f}_en`].replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function cmdReport(opts) {
  const n = Number(opts.batch);
  if (!opts.out || opts.out === true) throw new Error('report 需要 --out <路径>');
  const outPath = path.resolve(process.cwd(), String(opts.out));
  const dict = loadDictionary();
  const chunk = batchCards(loadSourceCards(), n);
  const missing = missingEntries(n, dict);
  if (missing.length) throw new Error(`批次 ${n} 还有 ${missing.length} 条未翻译，先 fill 再 report`);
  const head = [
    `# 场景卡英译 · 批次 ${n}（卡 ${(n - 1) * BATCH_SIZE + 1}-${n * BATCH_SIZE}）`,
    '',
    `> 生成：2026-11-19 | 词表：assets/scene-cards/en/batch-*.tsv | 校验：scripts/translate-scene-cards-en.js check`,
    `> 范围：${chunk.length} 张卡 × ${FIELD_TOTAL} 字段 = ${chunk.length * FIELD_TOTAL} 条；英文与中文同表对照，便于抽审。`,
    ''
  ].join('\n');
  const body = chunk.map((c) => cardTable(c, dict)).join('\n');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, head + '\n' + body, 'utf8');
  console.log(`✓ 已写 ${outPath}`);
  console.log(`  ${chunk.length} 张卡 × ${FIELD_TOTAL} 字段 = ${chunk.length * FIELD_TOTAL} 条对照`);
  const excerpt = Math.max(0, Math.min(chunk.length, Number(opts.excerpt === undefined ? 2 : opts.excerpt) || 0));
  if (excerpt) {
    console.log('');
    for (const c of chunk.slice(0, excerpt)) {
      console.log(cardTable(c, dict).trim());
      console.log('');
    }
  }
}

// §2 已审 43 条（用户 2026-11-19 回复「可以」）
const APPROVED_CONTROLLED = {
  biome: new Set(['海岸', '河口', '潮间带', '森林', '水体', '湖泊', '河流', '火山', '瀑布', '丹霞', '荒漠', '沙漠', '峡谷']),
  weather: new Set(['晴', '薄雾', '晨雾', '海雾', '阴天散射', '风暴前', '风暴后', '阵雨', '蓝调', '无月夜', '极昼']),
  light: new Set(['冷灰', '阴天散射', '侧光', '冷灰风暴光', '日落后冷蓝', '黄道光锥', '无月夜晴']),
  shot: new Set(['大全景', '中景', '纹理特写', '天文', '点景']),
  cameraAngle: new Set(['地面广角', '地面平视', '低机位广角', '静态贴面', '高位斜俯航拍']),
  motion: new Set(['静态', '极慢横移'])
};
// 样例文档 §3 已给出、可视为已审的其它字段值
const SAMPLE_APPROVED = {
  palette: new Set(['冷蓝 + 暖边', '冷沙 + 灰蓝']),
  highlight_control: new Set(['水面/冰面反光不炸白，暗部保留层次', '亮部不过曝，阴影保留纹理']),
  avoid: new Set(['无人物、无船、无建筑、无文字', '无人物、无车辙、无建筑']),
  end_lock: new Set(['画面锁死，没有新元素进入'])
};

function cmdGlossary(opts) {
  if (!opts.out || opts.out === true) throw new Error('glossary 需要 --out <路径>');
  const outPath = path.resolve(process.cwd(), String(opts.out));
  const dict = loadDictionary();
  const source = loadSourceCards();
  const byField = new Map();
  for (const key of dict.keys()) {
    const at = key.indexOf(KEY_SEP);
    const field = key.slice(0, at);
    const zh = key.slice(at + 1);
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field).push({ zh, en: dict.get(key) });
  }
  const distinct = {};
  for (const f of ALL_FIELDS) {
    const set = new Set();
    for (const card of source) {
      let v;
      if (f === 'negative') v = card.negative;
      else if (f === 'science.forbidden') v = card.science && card.science.forbidden;
      else v = zhOf(card)[f];
      if (v !== undefined && v !== null && String(v).trim() !== '') set.add(String(v));
    }
    distinct[f] = set.size;
  }
  const controlled = ['biome', 'weather', 'light', 'shot', 'cameraAngle', 'motion'];
  const repeated = ['season', 'palette', 'highlight_control', 'avoid', 'end_lock'];
  const free = ['landform', 'feature', 'foreground', 'protagonist'];
  const approvedFor = (field, zh) => {
    if (APPROVED_CONTROLLED[field]) return APPROVED_CONTROLLED[field].has(zh);
    if (SAMPLE_APPROVED[field]) return SAMPLE_APPROVED[field].has(zh);
    return false;
  };
  const lines = [];
  lines.push('# 场景卡英译词表（批 1–2，待审）');
  lines.push('');
  lines.push('> 生成：2026-11-19 | 词表源：`assets/scene-cards/en/*.tsv` | 构建：`node scripts/build-scene-cards-final.js`');
  lines.push('> 标记：✅ = §2 或样例已审；⬜ = 待你点头（未点头前不放大到批 3–5，也不当作最终默认）。');
  lines.push('');
  const summary = [];
  const emitField = (field, listLabel) => {
    const list = (byField.get(field) || []).slice();
    let approved = 0;
    for (const e of list) if (approvedFor(field, e.zh)) approved++;
    summary.push({ field, translated: list.length, distinct: distinct[field], approved, pending: list.length - approved });
    lines.push(`### ${field}（已译 ${list.length} / 全库 ${distinct[field]} 种；已审 ${approved} / 待审 ${list.length - approved}）`);
    lines.push('');
    for (const e of list) lines.push(`- ${e.zh} → ${e.en} ${approvedFor(field, e.zh) ? '✅' : '⬜'}`);
    lines.push('');
  };
  lines.push('## 1. 受控词表（§2 六类）');
  lines.push('');
  for (const f of controlled) emitField(f);
  lines.push('## 2. 其它重复字段');
  lines.push('');
  for (const f of repeated) emitField(f);
  lines.push('## 3. 负向补充（不进 16 字段，英文 negative prompt 用）');
  lines.push('');
  for (const f of ['negative', 'science.forbidden']) emitField(f);
  lines.push('## 4. 自由文本字段（不逐条列，卡片级对照见批次文档）');
  lines.push('');
  for (const f of free) {
    const translated = (byField.get(f) || []).length;
    summary.push({ field: f, translated, distinct: distinct[f], approved: null, pending: null });
    lines.push(`- ${f}：已译 ${translated} / 全库 ${distinct[f]} 种；未译的 ${distinct[f] - translated} 种在批 3–5。`);
  }
  lines.push('');
  lines.push('## 5. 汇总');
  lines.push('');
  lines.push('| 字段 | 已译 | 全库种数 | 已审 | 待审 |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const s of summary) {
    lines.push(`| ${s.field} | ${s.translated} | ${s.distinct} | ${s.approved === null ? '—' : s.approved} | ${s.pending === null ? '—' : s.pending} |`);
  }
  lines.push('');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`✓ 已写 ${outPath}`);
  console.log(`  词表 ${dict.size} 条；受控 43 已审；待审见文件`);
}

function cmdCheck() {
  const dict = loadDictionary();
  const source = loadSourceCards();
  if (!fs.existsSync(ASSET_FILE)) throw new Error(`运行时卡库不存在：${ASSET_FILE}`);
  const asset = JSON.parse(fs.readFileSync(ASSET_FILE, 'utf8'));

  let pass = 0;
  let fail = 0;
  const failures = [];
  const ok = (cond, msg, detail) => {
    if (cond) pass++;
    else { fail++; failures.push(detail ? `${msg} — ${detail}` : msg); }
  };

  ok(asset.schemaVersion === 'scene-card.v3.3', 'schemaVersion = scene-card.v3.3', asset.schemaVersion);
  ok(Array.isArray(asset.cards) && asset.cards.length === 200, '200 张卡', asset.cards && asset.cards.length);
  ok(asset.total === 200, 'total = 200', asset.total);
  if (!Array.isArray(asset.cards) || asset.cards.length !== 200) {
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    process.exitCode = 1;
    return;
  }
  ok(asset.cards.filter((c) => c.role === 'feature').length === 180, '180 张正片');
  ok(asset.cards.filter((c) => c.role === 'buffer').length === 20, '20 张缓冲');
  ok(asset.cards.map((c) => c.id).join(',') === source.map((c) => c.id).join(','), '卡 id/顺序与源卡一致');

  const used = new Set();
  let slots = 0;
  let negSlots = 0;
  let forbSlots = 0;
  for (let i = 0; i < asset.cards.length; i++) {
    const a = asset.cards[i];
    const s = source[i];
    const za = zhOf(a);
    const zs = zhOf(s);

    // 身份字段（历史任务靠 id / scene_key 关联，不能动）
    ok(['id', 'scene_key', 'chapter', 'sequence'].every((k) => String(a[k]) === String(s[k])),
      `${a.id} id/scene_key/chapter/sequence 未改`);

    // 中文 16 字段
    let zhOk = true;
    for (const f of EN_FIELDS) {
      if (String(za[f]) !== String(zs[f])) { zhOk = false; break; }
    }
    ok(zhOk, `${a.id} 中文 16 字段未改`);

    // 16 个 _en：非空/ASCII/≤400 + 与词表逐字一致
    let enOk = true;
    let enDetail = '';
    let matchOk = true;
    let matchDetail = '';
    for (const f of EN_FIELDS) {
      const v = a[`${f}_en`];
      try { assertEnglish(v, `${a.id}.${f}_en`); } catch (e) { enOk = false; enDetail = e.message; }
      const want = dict.get(keyOf(f, String(za[f])));
      used.add(keyOf(f, String(za[f])));
      if (!want || v !== want) { matchOk = false; matchDetail = matchDetail || `${f}_en 与词表不一致`; }
      slots++;
    }
    ok(enOk, `${a.id} 16 个 _en 合法（非空/ASCII/≤400）`, enDetail);
    ok(matchOk, `${a.id} _en 与词表逐字一致`, matchDetail);

    // negative_en（负向提示词补充字段）
    const negKey = keyOf('negative', a.negative || '');
    const negWant = dict.get(negKey);
    used.add(negKey);
    let negOk = true;
    let negDetail = '';
    try {
      assertEnglish(a.negative_en, `${a.id}.negative_en`);
      if (a.negative_en !== negWant) { negOk = false; negDetail = 'negative_en 与词表不一致'; }
    } catch (e) { negOk = false; negDetail = e.message; }
    ok(negOk, `${a.id} negative_en 合法且与词表一致`, negDetail);
    negSlots++;

    // science.forbidden_en（卡级负向补充，7 种值）
    const forb = a.science && a.science.forbidden;
    if (forb) {
      const forbKey = keyOf('science.forbidden', forb);
      const forbWant = dict.get(forbKey);
      used.add(forbKey);
      let forbOk = true;
      let forbDetail = '';
      try {
        assertEnglish(a.science.forbidden_en, `${a.id}.science.forbidden_en`);
        if (a.science.forbidden_en !== forbWant) { forbOk = false; forbDetail = 'forbidden_en 与词表不一致'; }
      } catch (e) { forbOk = false; forbDetail = e.message; }
      ok(forbOk, `${a.id} science.forbidden_en 合法且与词表一致`, forbDetail);
      forbSlots++;
    }
  }
  ok(slots === 3200, '16×200 = 3200 个英文字段', slots);
  ok(negSlots === 200, 'negative_en = 200 张', negSlots);
  ok(forbSlots === 200, 'science.forbidden_en = 200 张', forbSlots);
  ok(dict.size === used.size, '词表无未使用条目（无拼错/残留）', `dict=${dict.size} used=${used.size}`);

  // 端到端：英文 video/image/negative 提示词零中文
  const promptComposer = require('../src/promptComposer');
  const zhInPrompt = [];
  const negCjk = [];
  for (const c of asset.cards) {
    try {
      const patch = promptComposer.composeClipPatch(c, { lang: 'en' });
      if (CJK_RE.test(patch.prompt) || CJK_RE.test(patch.imagePrompt)) zhInPrompt.push(c.id);
      if (CJK_RE.test(patch.negativePrompt)) negCjk.push(c.id);
    } catch (e) {
      zhInPrompt.push(`${c.id}(${e.message})`);
    }
  }
  ok(zhInPrompt.length === 0, '英文 video/image 提示词零中文', zhInPrompt.slice(0, 8).join(', '));
  ok(negCjk.length === 0, '英文 negative 提示词零中文', `${negCjk.length}/200；需 promptComposer 英文分支接 sceneTemplates.negativeEn`);

  // 语言门控：中文提示词必须与「无 _en 的源卡」逐字相同
  const sourceById = new Map(source.map((c) => [c.id, c]));
  const zhDiff = [];
  for (const c of asset.cards) {
    const s = sourceById.get(c.id);
    try {
      const a = promptComposer.composeClipPatch(c, { lang: 'zh' });
      const b = promptComposer.composeClipPatch(s, { lang: 'zh' });
      if (a.prompt !== b.prompt || a.imagePrompt !== b.imagePrompt || a.negativePrompt !== b.negativePrompt) zhDiff.push(c.id);
    } catch (e) {
      zhDiff.push(`${c.id}(${e.message})`);
    }
  }
  ok(zhDiff.length === 0, '中文提示词与改动前逐字相同（200 张）', zhDiff.slice(0, 8).join(', '));

  // 提示（非失败）：模板去重规则是「feature 包含 protagonist 时只保留 protagonist」。
  const dedupeDiff = [];
  for (const c of asset.cards) {
    const zh = zhOf(c);
    const zhRep = String(zh.feature).includes(String(zh.protagonist));
    const enRep = String(c.feature_en).includes(String(c.protagonist_en));
    if (zhRep !== enRep) dedupeDiff.push(c.id);
  }
  if (dedupeDiff.length) {
    console.log(`[提示] feature/protagonist 包含关系与中文不一致：${dedupeDiff.length} 张（${dedupeDiff.slice(0, 8).join(',')}${dedupeDiff.length > 8 ? ' …' : ''}；仅影响英文模板去重，不改变中文路径）`);
  }

  console.log('');
  for (const f of failures.slice(0, 12)) console.log(`  ✗ ${f}`);
  if (failures.length > 12) console.log(`  … 另有 ${failures.length - 12} 条失败`);
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = parseArgs(args.slice(1));
  try {
    if (cmd === 'status') return cmdStatus();
    if (cmd === 'missing') return cmdMissing(opts);
    if (cmd === 'fill') return cmdFill(opts);
    if (cmd === 'report') return cmdReport(opts);
    if (cmd === 'glossary') return cmdGlossary(opts);
    if (cmd === 'check') return cmdCheck();
    console.log('用法: node scripts/translate-scene-cards-en.js <status|missing|fill|report|glossary|check> [--batch N] [--out 路径]');
    process.exitCode = 1;
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

module.exports = {
  EN_FIELDS,
  EXTRA_FIELDS,
  EN_DIR,
  SOURCE_FILE,
  ASSET_FILE,
  BATCH_SIZE,
  CARD_TOTAL,
  FIELD_TOTAL,
  assertEnglish,
  zhOf,
  loadSourceCards,
  batchCards,
  loadDictionary,
  missingEntries,
  resolveCard,
  resolvePartialCard,
  resolveExtras,
  assertBuiltCards,
  assertChineseUntouched,
  assertIdentityUntouched,
  coverage
};

if (require.main === module) main();
