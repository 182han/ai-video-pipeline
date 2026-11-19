// 把 v3.2-science 归一化为稳定交付格式 v3.3，并合并场景卡英译（_en）。
// 只读输入，不改原文件。
//
// 英译词表：assets/scene-cards/en/*.tsv（唯一来源，见 scripts/translate-scene-cards-en.js）。
//   · batch-<N>.tsv：16 个展示/正向字段，按批次增量；
//   · shared.tsv：跨卡共享的负向补充（negative / science.forbidden）。
//
// 分批构建是**增量**的：只写已译字段，未译字段留给运行时 pickField 回退中文；
// 最终验收用 `node scripts/build-scene-cards-final.js --require-complete`，
// 要求 16×200 + negative_en×200 + science.forbidden_en×200 全量。
//
// 为什么必须走构建：直接改 assets/scene-cards/v3.3-final.json 会在下次重建时被静默覆盖。
// 本脚本同时写「测试/docs/scene-cards-v3.3-final.json（既有产物）」与
// 「app/assets/scene-cards/v3.3-final.json（运行时 src/sceneCards.js 真正读取）」。
//
// 写盘前硬断言：
//   · 中文 16 字段逐字未改；id / scene_key / chapter / sequence 逐字未改；
//   · 已写 _en 非空、纯 ASCII、≤400；
//   · 与上一次产物相比：_en 计数不减少、已译字段一个不丢（改译允许，会打印 changed 数）。
const fs = require('fs');
const path = require('path');
const en = require('./translate-scene-cards-en');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(__dirname, '..');
const src = path.join(ROOT, 'docs', 'scene-cards-v3.2-science.json');
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const dict = en.loadDictionary();
const REQUIRE_COMPLETE = process.argv.includes('--require-complete');

const cards = raw.cards.map((c) => {
  const base = {
    id: c.id,
    biome: c.biome,
    landform: c.landform,
    feature: c.feature,
    foreground: c.foreground,
    weather: c.weather,
    season: c.season,
    light: c.light,
    shot: c.shot || c.shot_type,
    cameraAngle: c.cameraAngle,
    lens: c.lens,
    motion: c.motion,
    palette: c.palette,
    palette_id: c.palette_id,
    style: c.style,
    highlight_control: c.highlight_control,
    protagonist: c.protagonist,
    scaleAnchor: c.scaleAnchor === undefined ? null : c.scaleAnchor,
    avoid: c.avoid,
    durationSec: c.durationSec === undefined ? 10 : c.durationSec,
    safeAreaPct: c.safeAreaPct === undefined ? 5 : c.safeAreaPct,
    tvSafe: c.tvSafe === undefined ? true : c.tvSafe,
    loopable: c.loopable,
    status: c.status,
    source: c.source || 'scene-card-generator-v1',
    original_feature: c.original_feature,
    lens_family: c.lens_family,
    climate: c.climate,
    plausibility: c.plausibility,
    rarity: c.rarity,
    light_azimuth: c.light_azimuth,
    negative: c.negative,
    end_lock: c.end_lock,
    renderability: c.renderability,
    role: c.role,
    variant_of: c.variant_of === undefined ? null : c.variant_of,
    changed: c.changed || '',
    scene_key: c.scene_key,
    chapter: c.chapter,
    sequence: c.sequence,
    science: c.science
  };
  const merged = { ...base, ...en.resolvePartialCard(base, dict) };
  const extra = en.resolveExtras(base, dict);
  if (extra.negative_en) merged.negative_en = extra.negative_en;
  if (extra.forbidden_en) merged.science = { ...(base.science || {}), forbidden_en: extra.forbidden_en };
  return merged;
});

// ---- 写盘前硬断言 ----
en.assertChineseUntouched(raw.cards, cards);
en.assertIdentityUntouched(raw.cards, cards);
const stats = en.assertBuiltCards(cards, { requireComplete: REQUIRE_COMPLETE });

// ---- 增量保护：与上一次产物比，_en 计数不减少、已译字段不丢 ----
function collectEnFields(list) {
  const map = new Map();
  for (const c of list) {
    for (const f of en.EN_FIELDS) {
      const v = c[`${f}_en`];
      if (v !== undefined && v !== null && String(v).trim() !== '') map.set(`${c.id}.${f}_en`, v);
    }
    if (c.negative_en) map.set(`${c.id}.negative_en`, c.negative_en);
    if (c.science && c.science.forbidden_en) map.set(`${c.id}.science.forbidden_en`, c.science.forbidden_en);
  }
  return map;
}

const assetPath = path.join(APP, 'assets', 'scene-cards', 'v3.3-final.json');
let oldMap = new Map();
if (fs.existsSync(assetPath)) {
  try {
    oldMap = collectEnFields(JSON.parse(fs.readFileSync(assetPath, 'utf8')).cards || []);
  } catch (e) {
    throw new Error(`读取上一次产物失败（不覆盖）：${e.message}`);
  }
}
const newMap = collectEnFields(cards);
if (newMap.size < oldMap.size) {
  throw new Error(`重建会让 _en 计数减少：${oldMap.size} → ${newMap.size}（拒绝写盘）`);
}
const lost = [...oldMap.keys()].filter((k) => !newMap.has(k));
if (lost.length) {
  throw new Error(`重建会丢已译字段 ${lost.length} 个（示例：${lost.slice(0, 8).join(', ')}）`);
}
let changed = 0;
for (const [k, v] of oldMap) if (newMap.get(k) !== v) changed++;

// 16 个展示字段的计数（与 negative/forbidden 分开报，避免“3022→2622”的误读）
function count16(map) {
  let n = 0;
  for (const k of map.keys()) {
    const m = /\.([A-Za-z_]+)_en$/.exec(k);
    if (m && en.EN_FIELDS.includes(m[1])) n++;
  }
  return n;
}

const out = {
  schemaVersion: 'scene-card.v3.3',
  version: 'scene-cards-v3.3-final',
  createdAt: '2026-11-15',
  sourceVersion: raw.version,
  scope: raw.scope,
  total: cards.length,
  featureCount: cards.filter((c) => c.role === 'feature').length,
  bufferCount: cards.filter((c) => c.role === 'buffer').length,
  durationSec: 10,
  styleCount: raw.styleCount,
  shotGroups: raw.shotGroups,
  cards
};

const json = JSON.stringify(out, null, 2) + '\n';
const docsPath = path.join(ROOT, 'docs', 'scene-cards-v3.3-final.json');
fs.writeFileSync(docsPath, json, 'utf8');
fs.writeFileSync(assetPath, json, 'utf8');
fs.writeFileSync(
  path.join(ROOT, 'docs', 'scene-cards-v3.3-sample.json'),
  JSON.stringify({ ...out, total: 1, featureCount: 1, bufferCount: 0, cards: [cards[0]] }, null, 2) + '\n',
  'utf8'
);

console.log(JSON.stringify({
  total: out.total,
  feature: out.featureCount,
  buffer: out.bufferCount,
  enFields: stats.slots,
  enCoverage: `${stats.slots}/${en.CARD_TOTAL * en.FIELD_TOTAL}`,
  enNegative: stats.negative,
  enForbidden: stats.forbidden,
  previousEnFields: count16(oldMap),
  previousEnTotal: oldMap.size,
  enTotal: stats.slots + stats.negative + stats.forbidden,
  changedTranslations: changed,
  complete: stats.slots === en.CARD_TOTAL * en.FIELD_TOTAL,
  requireComplete: REQUIRE_COMPLETE,
  written: [assetPath, docsPath]
}, null, 2));
