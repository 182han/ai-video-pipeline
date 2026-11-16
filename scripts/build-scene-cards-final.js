// 把 v3.2-science 归一化为稳定交付格式 v3.3；只读输入，不改原文件。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const src = path.join(ROOT, 'docs', 'scene-cards-v3.2-science.json');
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));

const cards = raw.cards.map((c) => ({
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
}));

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

fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.3-final.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.3-sample.json'), JSON.stringify({ ...out, total: 1, featureCount: 1, bufferCount: 0, cards: [cards[0]] }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ total: out.total, feature: out.featureCount, buffer: out.bufferCount, uniqueSceneKey: new Set(cards.map(c => c.scene_key)).size, semanticGroups: new Set(cards.map(c => c.semantic_group)).size }, null, 2));
