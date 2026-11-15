// v3.1 第一步：按审查报告的 52 组语义重复，做去重审计（不写卡、不调用付费 API）。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const v3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.json'), 'utf8'));
const csvPath = 'C:/Users/14872/Downloads/检验/scene-cards-v3-重复清单.csv';
const csv = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const header = csv.shift().split(',');
const idx = (name) => header.indexOf(name);
const groups = [];
for (const line of csv) {
  // CSV 字段内没有逗号；卡片列用空格分隔
  const cols = line.split(',');
  const name = cols[idx('组')];
  const ids = (cols[idx('卡片')] || '').trim().split(/\s+/).filter(Boolean);
  if (!name || !ids.length) continue;
  groups.push({ name, ids, similarity: cols[idx('核心相似度')] || '', verdict: cols[idx('判定')] || '', suggestion: cols[idx('建议')] || '' });
}

const byId = new Map(v3.cards.map(c => [c.id, c]));
const repIds = new Set();
const variantIds = new Set();
const auditor = [];
for (const g of groups) {
  const cards = g.ids.map(id => byId.get(id)).filter(Boolean);
  if (!cards.length) continue;
  const rep = cards.find(c => c.status === 'approved') || cards[0];
  repIds.add(rep.id);
  for (const c of cards) if (c.id !== rep.id) variantIds.add(c.id);
  auditor.push({
    group: g.name,
    similarity: g.similarity,
    verdict: g.verdict,
    suggestion: g.suggestion,
    representative: rep.id,
    representativeStatus: rep.status,
    variants: cards.filter(c => c.id !== rep.id).map(c => c.id)
  });
}
const allIds = v3.cards.map(c => c.id);
const ungrouped = allIds.filter(id => !repIds.has(id) && !variantIds.has(id));
const uniqueIds = [...repIds, ...ungrouped];
const bufferCandidates = [...variantIds];

const out = {
  version: 'scene-cards-v3.1-dedup-audit',
  source: 'scene-cards-v3.json + scene-cards-v3-重复清单.csv',
  total: v3.cards.length,
  semanticGroups: groups.length,
  representativeCount: uniqueIds.length,
  variantCount: variantIds.size,
  ungroupedCount: ungrouped.length,
  gapTo180: Math.max(0, 180 - uniqueIds.length),
  groups: auditor,
  uniqueIds,
  variantIds: bufferCandidates
};
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.1-dedup-audit.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

let md = '# v3.1 语义去重审计（第一步）\n\n';
md += '> 依据审查报告 52 组语义重复表；只审计，不修改原卡、不调用付费 API。\n\n';
md += '## 总量\n\n';
md += `- 原卡：${v3.cards.length}\n- 语义组：${groups.length}\n- 代表性场景：${uniqueIds.length}\n- 变体/重复候选：${variantIds.size}\n- 未进组：${ungrouped.length}\n- 距离 180 个独立场景：**还差 ${Math.max(0, 180 - uniqueIds.length)} 个**\n\n`;
md += '## 52 组代表卡\n\n';
md += '| 组 | 代表卡 | 变体 | 相似度 | 判定 |\n|---|---|---|---:|---|\n';
for (const g of auditor) {
  md += `| ${g.group} | ${g.representative} | ${g.variants.join(' ') || '-'} | ${g.similarity} | ${g.verdict} |\n`;
}
md += '\n## 下一步\n\n';
md += `1. 以 ${uniqueIds.length} 张代表卡为骨架；\n`;
md += `2. 补 ${Math.max(0, 180 - uniqueIds.length)} 张纯自然风光新场景；\n`;
md += '3. 代表性卡修 A；A、天文/运动/季节/前景/色板问题；\n';
md += '4. 选 20 张变体作为缓冲，标 `variant_of`，不计入 180；\n';
md += '5. 6 卷排序后，先做 6 张图 A/B。\n';
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.1-dedup-audit.md'), md, 'utf8');

console.log(JSON.stringify({
  total: out.total,
  semanticGroups: out.semanticGroups,
  representativeCount: out.representativeCount,
  variantCount: out.variantCount,
  ungroupedCount: out.ungroupedCount,
  gapTo180: out.gapTo180
}, null, 2));
