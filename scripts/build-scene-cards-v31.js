// 构建 scene-cards-v3.1：137 个语义代表 + 43 个纯自然风光新场景 + 20 个缓冲变体。
// 纯文本，0 元，不调用任何付费 API。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const v3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.json'), 'utf8'));
const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.1-dedup-audit.json'), 'utf8'));
const byId = new Map(v3.cards.map(c => [c.id, { ...c }]));

// 43 个新的纯自然风光场景：[biome, landform, protagonist, feature, foreground, weather, season, light]
const newSpecs = [
  ['海岸','雨纹潮池','潮池','雨点波纹与倒影','湿岩','阵雨','夏','阴天散射'],
  ['湖泊','湖面融冰','湖面','冰水交界与裂纹','残冰','晴冷','春','低太阳侧光'],
  ['河流','辫状河道','辫状水道','沙洲分汊','砾石洲','晴','夏','侧光'],
  ['河口','河口雾','河口','咸淡水交汇雾带','泥滩','晨雾','秋','蓝调'],
  ['瀑布','瀑布水雾','瀑布','水雾中的彩虹','湿石','晴间水雾','夏','侧逆光'],
  ['溪流','春溪','溪流','融雪水流与卵石','卵石','晴','春','树冠缝隙光'],
  ['盐湖','盐湖浅水','盐湖','浅水盐晶与倒影','盐晶','无风','夏','日落后'],
  ['海面','海面雨圈','海面','雨点圆纹','雨幕','阵雨','秋','冷灰'],
  ['森林','落叶松雪','落叶松','雪压枝头','雪枝','雪后','冬','侧光'],
  ['雨林','雨林树冠雾','雨林树冠','雾在树冠间流动','藤蔓','晨雾','夏','散射'],
  ['森林','秋日溪流','溪流','落叶与溪石','落叶','晴','秋','侧光'],
  ['云雾林','云雾林脊','山脊','云雾越过林脊','苔石','云雾','春','散射'],
  ['针叶林','冻沼','冻沼','冰面气泡与针叶','冰面','晴冷','冬','低太阳'],
  ['桦林','秋色桦林','桦林','金黄叶与白干','落叶','晴','秋','侧逆光'],
  ['竹林','竹林雾','竹林','雾中竹影','竹叶','晨雾','春','散射'],
  ['高山','高山杜鹃雪','杜鹃灌丛','花与残雪','花枝','雪后','春','侧光'],
  ['沙漠','沙漠雨后','沙丘','湿沙与临时水洼','水洼','雨后','夏','日落后'],
  ['峡谷','峡谷洪水后','峡谷','洪水痕迹与湿岩','湿岩','雨后','夏','侧光'],
  ['山地','山雪阵','山脊','雪幕与风','雪粒','雪阵','冬','冷灰'],
  ['海岸','海岸海雾','海崖','海雾漫过崖顶','湿草','海雾','春','散射'],
  ['山谷','谷雾','山谷','平流雾填谷','树梢','晨雾','秋','蓝调'],
  ['草原','风暴云影','草原','云影掠过草浪','草穗','风暴前','夏','冷灰'],
  ['海岸','海岸彩虹','海崖','雨后彩虹','湿岩','雨后','夏','侧逆光'],
  ['高山','荚状云','山峰','荚状云层','雪脊','晴间云','冬','侧光'],
  ['雪原','融雪','雪原','融雪溪与露岩','露岩','晴','春','侧光'],
  ['林间','落叶','林间','落叶铺地','落叶','晴','秋','侧光'],
  ['树枝','雾凇','树枝','雾凇与冰晶','枝条','寒雾','冬','低太阳'],
  ['山谷','季风雨','山谷','季风雨幕','湿叶','季风雨','夏','冷灰'],
  ['草原','草原花海','草原','野花带','花穗','晴','夏','侧光'],
  ['湖泊','湖面封冻','湖面','冰裂纹与雪','冰面','晴冷','冬','低太阳'],
  ['溪流','雪融溪','溪流','雪水与苔石','苔石','晴','春','树冠光'],
  ['桦林','白桦林缘','白桦林缘','金黄林缘与草地','草地','晴','秋','侧光'],
  ['丹霞','砂岩波浪','砂岩壁','波浪状层理','砂粒','晴','春','侧光'],
  ['喀斯特','石灰岩台地','石灰岩台地','溶沟与石芽','石芽','阴天','秋','均匀散射'],
  ['火山','玄武岩柱','玄武岩柱','柱状节理','碎石','风暴','冬','冷灰'],
  ['盐湖','盐壳多边形','盐壳','多边形裂纹','盐晶','晴','夏','低太阳'],
  ['冰川','冰川漂砾','漂砾','漂砾与冰碛','砾石','阴天','夏','散射'],
  ['黄土高原','黄土沟壑','黄土沟','沟壑与土柱','土柱','薄霾','秋','侧光'],
  ['潮间带','晨潮池','潮池','晨光与水面','池边岩','晴','春','日出侧光'],
  ['极地','海烟','海面','冷空气海烟','海面','极冷','冬','低太阳'],
  ['极地','冰山巷','冰山','冰山夹道','浮冰','晴冷','夏','低太阳'],
  ['极地','冰间湖','冰间湖','冰面开阔水域','冰缘','晴冷','春','侧光'],
  ['冰川','冰川崩解','冰川','崩解冰崖','浮冰','晴','夏','侧光']
];

const isAstroFeature = (s) => /极光|星轨|银河|黄道光|月升|气辉|星云/.test(String(s || ''));
const isNight = (s) => /无月|月升|星轨|极光|银河|黄道|气辉|星云|夜/.test(String(s || ''));
// 按“地貌 + 材质”给出决定性特征，避免所有海岸都写成潮池反光。
function decisiveFor(c) {
  const lf = c.landform || '';
  let d;
  if (/天文|极光|银河|星轨|黄道|月升|气辉/.test(lf)) d = '星点、气辉与地景剪影';
  else if (/沙洲|沙嘴|沙坝|沙脊|连岛/.test(lf)) d = '湿沙分汊、风纹与水面反光';
  else if (/潮池/.test(lf)) d = '水面反光、礁石与盐雾';
  else if (/白垩崖|海蚀崖|悬崖|峡湾|柱状节理|海蚀柱|海蚀拱|海蚀洞|喷水洞|黑沙滩/.test(lf)) d = '崖壁层理、湿岩与盐雾';
  else if (/沙丘|新月|星形|穹状/.test(lf)) d = '风纹、滑落面与沙粒反光';
  else if (/河口|河口湾/.test(lf)) d = '咸淡水交汇、泥滩与雾带';
  else if (/礁盘/.test(lf)) d = '礁石沟槽、海藻与盐雾';
  else if (/盐|盐壳|盐盘/.test(lf)) d = '盐晶、裂纹与薄水';
  else if (/冰川|冰架|冰山|冰瀑|冰裂|冰碛|冰间湖|冻沼|雪原|雪檐|雪崩|粒雪/.test(lf)) d = '冰裂隙、粒雪与蓝冰';
  else if (/湖|河|溪|瀑|海|湾|潮|泉|湿地|芦苇/.test(lf)) d = '水面反光、湿岸与流痕';
  else if (/林|竹|桦|蕨|苔|树冠/.test(lf)) d = '叶面、苔藓与林间光';
  else if (/草原|草甸|花|草浪/.test(lf)) d = '草浪、土壤与空气透视';
  else if (/火山|熔岩|地热|间歇泉|钙华|喷气/.test(lf)) d = '熔岩壳、蒸汽与矿物色';
  else if (/崖|谷|岩|石|丹霞|喀斯特|天坑|溶洞|台地|孤山/.test(lf)) d = '层理、裂隙与风化面';
  else if (/雅丹|土丘|垄脊|戈壁/.test(lf)) d = '风蚀沟槽、砾石与沙粒反光';
  else d = '材质、空气透视与高光层次';
  return `${lf || c.biome}的${d}`;
}
const paletteId = (p) => {
  if (/暗|星|极光|银河/.test(p)) return 'dark-cosmos';
  if (/冷|蓝|白|冰|青|银|灰/.test(p)) return 'cold-minimal';
  if (/暖|红|金|橙|赭|土|黄/.test(p)) return 'warm-dense';
  return 'cold-minimal';
};
const shotType = (s) => /天文/.test(s) ? '天文' : /点景/.test(s) ? '点景' : /纹理/.test(s) ? '纹理特写' : /中景/.test(s) ? '中景' : '大全景';
const lensFamily = (shot) => ({ 天文: 'astro', 点景: 'point', 纹理特写: 'texture', 中景: 'medium', 大全景: 'wide' }[shot] || 'wide');
const angleFor = (shot, old) => {
  if (shot === '天文') return '固定机位广角';
  if (shot === '纹理特写') return '静态贴面';
  if (shot === '中景') return '地面平视';
  if (shot === '点景') return '广角点景';
  if (/低机位/.test(old || '')) return '低机位广角';
  if (/航拍/.test(old || '')) return '高位斜俯航拍';
  return '地面广角';
};
const lensFor = (shot, feature) => {
  if (shot === '天文') return /冠冕/.test(feature) ? '11mm' : (/星轨|银河|黄道|气辉/.test(feature) ? '14mm' : '20mm');
  if (shot === '纹理特写') return '85mm';
  if (shot === '中景') return '50mm';
  if (shot === '点景') return '35mm';
  return '28mm';
};
const motionFor = (shot, angle) => {
  if (shot === '天文' || shot === '纹理特写') return '静态';
  if (/滑轨|滑移/.test(angle)) return '极慢横移';
  if (/推进/.test(angle)) return '极慢前推';
  return '静态';
};
const climateFor = (biome) => {
  if (/沙漠|荒漠|戈壁/.test(biome)) return '干旱';
  if (/冰川|极地|高山|雪原/.test(biome)) return '高寒';
  if (/海岸|潮间带|河口/.test(biome)) return '海洋性';
  if (/森林|雨林|云雾林|桦林|竹林/.test(biome)) return '湿润';
  if (/湖泊|河流|溪流|瀑布|湿地|山谷/.test(biome)) return '湿润';
  return '温带';
};

function normalize(card, role, variantOf, groupName) {
  const c = { ...card };
  c.original_feature = card.original_feature || card.feature;
  const astro = isAstroFeature(c.original_feature) || isAstroFeature(c.protagonist);
  let shot = shotType(c.shot);
  if (astro) shot = '天文';
  else if (shot === '天文') {
    const f = String(c.original_feature || '');
    shot = /纹理|岩|冰|沙|盐|苔|树皮|波纹|层理/.test(f) ? '纹理特写'
      : /水|湖|河|瀑|海|湿|溪|湾|潮/.test(f) ? '中景'
        : '大全景';
  }
  c.shot = shot;
  c.shot_type = shot;
  c.cameraAngle = angleFor(shot, c.cameraAngle);
  c.lens = astro ? lensFor('天文', c.original_feature) : lensFor(shot, c.original_feature);
  c.motion = motionFor(shot, c.cameraAngle);
  c.lens_family = lensFamily(shot);

  if (astro) {
    if (!isNight(c.light)) c.light = '无月夜晴';
    c.style = 'dramatic';
    // 种子卡里可能存在“protagonist=极光/银河，feature=地景”的情况；
    // 特征必须带上天文主体，否则校验与提示词都会漏掉天文内容。
    if (!isAstroFeature(c.feature)) c.feature = `${c.protagonist}；${c.feature}`;
  }

  // 季节/天气硬冲突修正
  c.climate = climateFor(c.biome);
  if (/沙漠|荒漠/.test(c.biome) && /雪/.test(c.weather) && c.season === '夏') c.season = '冬';
  if (/阴天/.test(c.weather) && /日落|侧逆/.test(c.light)) c.light = '云层均匀散射';
  if (/雨|雪/.test(c.weather) && /日落后|日落侧光/.test(c.light)) c.light = '冷灰散射';
  c.plausibility = /雪/.test(c.weather) && /沙漠|荒漠/.test(c.biome) ? 'medium' : 'high';
  c.rarity = /雪/.test(c.weather) && /沙漠|荒漠/.test(c.biome) ? 'rare' : 'common';

  // 前景不能等于主角/主角子串
  if (!c.foreground || String(c.foreground).includes(String(c.protagonist)) || String(c.protagonist).includes(String(c.foreground))) {
    c.foreground = '前景：暗部剪影';
  }

  // 主角；特征：不允许 A；A；天文卡必须保留天文主体
  if (String(c.protagonist) === String(c.feature)) {
    const detail = decisiveFor(c);
    c.feature = astro ? `${c.protagonist}；${detail}` : detail;
  }
  if (String(c.protagonist) === String(c.feature)) c.feature = astro ? `${c.protagonist}；星点与地景剪影` : `${c.light}；${c.foreground}`;

  c.palette_id = paletteId(c.palette || '');
  if (/角峰|冰川|冰架|极地/.test(c.original_feature) && c.palette_id === 'warm-dense') {
    c.palette = '冷蓝 + 白';
    c.palette_id = 'cold-minimal';
  }
  c.light_azimuth = /左/.test(c.light) ? 'left' : /右/.test(c.light) ? 'right' : /逆/.test(c.light) ? 'back' : /顶/.test(c.light) ? 'top' : 'ambient';
  c.negative = '人物, 文字, 水印, 建筑, 过量 HDR, 过度锐化, 塑料感, 死白高光';
  c.end_lock = '画面锁死，没有新元素进入';
  c.safe_area_pct = 5;
  c.tv_safe = true;
  c.loopable = true;
  c.duration_sec = 10;
  c.renderability = c.rarity === 'rare' ? 3 : 4;
  c.role = role;
  c.variant_of = variantOf || null;
  c.changed = variantOf ? (groupName || 'single-dimension variant') : '';
  c.scene_key = groupName || c.original_feature;
  c.status = role === 'buffer' ? 'buffer' : (card.status || 'candidate');
  return c;
}

const groups = audit.groups || [];
const variantToGroup = new Map();
for (const g of groups) {
  for (const v of g.variants) variantToGroup.set(v, { rep: g.representative, group: g.group, suggestion: g.suggestion });
}
const groupByRep = new Map();
for (const g of groups) groupByRep.set(g.representative, g.group);

const reps = audit.uniqueIds.map(id => byId.get(id)).filter(Boolean)
  .map(c => normalize(c, 'feature', null, groupByRep.get(c.id) || c.feature));

const buffer = audit.variantIds.slice(0, 20).map(id => {
  const c = byId.get(id);
  const vg = variantToGroup.get(id);
  return normalize(c, 'buffer', vg ? vg.rep : null, vg ? vg.group : c.feature);
});

const newCards = newSpecs.map((s, i) => {
  const [biome, landform, protagonist, feature, foreground, weather, season, light] = s;
  const id = 'sc-' + String(201 + i).padStart(3, '0');
  return normalize({
    id, biome, landform, protagonist, feature, foreground, weather, season, light,
    palette: '冷灰 + 自然色', style: 'cinematic-calm',
    highlight_control: '天空不过曝，暗部保留层次', avoid: '无人物、无建筑、无文字'
  }, 'feature', null, feature);
});

const featureCards = [...reps, ...newCards];
const all = [...featureCards, ...buffer];

if (featureCards.length !== 180) throw new Error('feature cards != 180: ' + featureCards.length);
if (buffer.length !== 20) throw new Error('buffer != 20: ' + buffer.length);
if (all.length !== 200) throw new Error('total != 200: ' + all.length);

// 镜头配比校准：目标 80 wide / 50 medium / 30 texture / 20 point / 20 astro。
// 只转换正片中的大全景，保持内容合理：
// - 水面/森林/草甸 -> 中景
// - 岩石/冰/沙/盐 -> 纹理特写
// - 海岸/荒漠/草原等开阔地 -> 点景（补 <2% 尺度锚点）
// - 海/湖/冰/雪/山/盐等夜空兼容场景 -> 天文（改成“原地貌·星空”）
const wideFeature = featureCards.filter(c => c.shot === '大全景');
const used = new Set();
const pick = (re, n) => {
  const out = [];
  for (const c of wideFeature) {
    if (out.length >= n) break;
    if (used.has(c.id)) continue;
    if (re.test(c.biome + ' ' + c.original_feature)) { out.push(c); used.add(c.id); }
  }
  return out;
};
const mediumPick = pick(/海|湖|河|溪|瀑|森林|雨林|草甸|草原|湿地|湾|潮/, 9);
const texturePick = pick(/岩|冰|沙|盐|丹霞|峡谷|火山|土|砾|石/, 6);
const pointPick = pick(/海岸|沙漠|荒漠|草原|湖|山|雪/, 6);
let astroPick = pick(/海|湖|冰|雪|山|盐|河|谷|草原|极地/, 8);
// 不足时从剩余 wide 补齐，避免配额失败
for (const c of wideFeature) {
  if (astroPick.length >= 8) break;
  if (!used.has(c.id)) { astroPick.push(c); used.add(c.id); }
}
for (const c of wideFeature) {
  if (used.size >= 29) break;
  if (!used.has(c.id)) { pointPick.push(c); used.add(c.id); }
}
const anchorByBiome = {
  海岸: '一只 <2% 的海鸟', 沙漠: '一只 <2% 的鸟', 荒漠: '一只 <2% 的鸟',
  湖泊: '一艘 <2% 的小船', 河流: '一艘 <2% 的小船', 潮间带: '一只 <2% 的水鸟',
  森林: '一只 <2% 的鹿', 高山: '一只 <2% 的岩羊', 山地: '一只 <2% 的岩羊',
  草原: '一只 <2% 的鹰', 极地: '一只 <2% 的鸟'
};
const astroSuffix = ['·银河', '·星轨', '·极光', '·月升', '·气辉', '·银河倒影', '·黄道光', '·星轨'];
let ai = 0;
for (const c of astroPick) {
  c.feature = `${c.original_feature}${astroSuffix[ai % astroSuffix.length]}`;
  c.scene_key = c.feature;
  c.shot = c.shot_type = '天文';
  c.cameraAngle = '固定机位广角';
  c.lens = '14mm';
  c.motion = '静态';
  c.lens_family = 'astro';
  c.light = '无月夜晴';
  c.highlight_control = '星点不过曝，地景保留暗部';
  ai++;
}
for (const c of mediumPick) {
  c.shot = c.shot_type = '中景'; c.cameraAngle = '地面平视'; c.lens = '50mm';
  c.motion = '极慢横移'; c.lens_family = 'medium';
}
for (const c of texturePick) {
  c.shot = c.shot_type = '纹理特写'; c.cameraAngle = '静态贴面'; c.lens = '85mm';
  c.motion = '静态'; c.lens_family = 'texture';
}
for (const c of pointPick) {
  c.shot = c.shot_type = '点景'; c.cameraAngle = '广角点景'; c.lens = '35mm';
  c.motion = '极慢横移'; c.lens_family = 'point';
  c.scaleAnchor = anchorByBiome[c.biome] || '一只 <2% 的鸟';
}

// 风景 180 的 scene_key 必须唯一；buffer 允许复用 scene_key
const featureKeys = new Set();
for (const c of featureCards) {
  if (featureKeys.has(c.scene_key)) throw new Error('duplicate feature scene_key: ' + c.scene_key + ' / ' + c.id);
  featureKeys.add(c.scene_key);
}
if (featureKeys.size !== 180) throw new Error('feature unique != 180');

// 风格配额：200 张总计 140 calm / 60 dramatic
const dramaticWords = /极光|星轨|银河|黄道|气辉|风暴|火山|熔岩|沙丘|峡谷|暴雨|雪崩|喷气|丹霞|狭缝|冰裂隙|冰瀑/;
const sorted = [...all].sort((a, b) => Number(dramaticWords.test(b.original_feature)) - Number(dramaticWords.test(a.original_feature)));
for (let i = 0; i < sorted.length; i++) sorted[i].style = i < 60 ? 'dramatic' : 'cinematic-calm';

// 章节：按地貌族群排序，切 6 卷 ×30
const chapterOrder = [
  /海岸|潮间带|河口/, /沙漠|荒漠|戈壁|丹霞|峡谷/, /冰川|极地|高山|雪原|山地/,
  /瀑布|河流|溪流|湖泊|湿地|山谷/, /森林|雨林|云雾林|桦林|竹林|草原/, /天文|极光|银河|星轨/
];
const featureOrdered = [...featureCards].sort((a, b) => {
  const rank = (c) => chapterOrder.findIndex(re => re.test(c.biome) || re.test(c.original_feature));
  return (rank(a) < 0 ? 9 : rank(a)) - (rank(b) < 0 ? 9 : rank(b));
});
for (let i = 0; i < featureOrdered.length; i++) {
  featureOrdered[i].chapter = Math.floor(i / 30) + 1;
  featureOrdered[i].sequence = (i % 30) + 1;
}
// 先做一次镜头数量均衡：若某卷的单一镜头 > 2×其他镜头+2，连续三段不可避免。
// 把超出部分与“该镜头较少、其他镜头充足”的卷交换，保持每卷 30 张。
const chapterArrays = new Map();
for (let ch = 1; ch <= 6; ch++) chapterArrays.set(ch, featureOrdered.filter(c => c.chapter === ch));
const shotKinds = ['大全景', '中景', '纹理特写', '点景', '天文'];
for (let ch = 1; ch <= 6; ch++) {
  const arr = chapterArrays.get(ch);
  const counts = Object.fromEntries(shotKinds.map(k => [k, arr.filter(c => c.shot === k).length]));
  const maxKind = shotKinds.reduce((a, b) => counts[b] > counts[a] ? b : a, shotKinds[0]);
  const maxCount = counts[maxKind];
  const otherCount = arr.length - maxCount;
  const allowed = 2 * otherCount + 2;
  if (maxCount <= allowed) continue;
  const need = maxCount - allowed;
  // 找该类型最少的捐卡卷
  const donors = [1, 2, 3, 4, 5, 6].filter(x => x !== ch)
    .sort((a, b) => chapterArrays.get(a).filter(c => c.shot === maxKind).length - chapterArrays.get(b).filter(c => c.shot === maxKind).length);
  for (const donor of donors) {
    const dArr = chapterArrays.get(donor);
    const dCount = dArr.filter(c => c.shot === maxKind).length;
    const dOther = dArr.length - dCount;
    const take = Math.min(need, Math.max(0, dOther));
    if (take <= 0) continue;
    const out = arr.filter(c => c.shot === maxKind).slice(0, take);
    const back = dArr.filter(c => c.shot !== maxKind).slice(0, take);
    for (const c of out) { c.chapter = donor; }
    for (const c of back) { c.chapter = ch; }
    chapterArrays.set(ch, [...arr.filter(c => !out.includes(c)), ...back]);
    chapterArrays.set(donor, [...dArr.filter(c => !back.includes(c)), ...out]);
    break;
  }
}

// 每卷内做一次“同镜头不相邻”的贪心重排，避免连续 3 段同类型。
const reordered = [];
for (let chapter = 1; chapter <= 6; chapter++) {
  const pool = featureOrdered.filter(c => c.chapter === chapter);
  const buckets = new Map();
  for (const c of pool) {
    if (!buckets.has(c.shot)) buckets.set(c.shot, []);
    buckets.get(c.shot).push(c);
  }
  const out = [];
  while ([...buckets.values()].some(a => a.length)) {
    const n = out.length;
    const last1 = n >= 1 ? out[n - 1].shot : null;
    const last2 = n >= 2 ? out[n - 2].shot : null;
    const candidates = [...buckets.entries()]
      .filter(([shot, arr]) => arr.length && !(shot === last1 && shot === last2))
      .sort((a, b) => b[1].length - a[1].length);
    const pick = candidates.length ? candidates[0] : [...buckets.entries()].filter(([, arr]) => arr.length).sort((a, b) => b[1].length - a[1].length)[0];
    out.push(pick[1].shift());
  }
  out.forEach((c, i) => { c.sequence = i + 1; });
  reordered.push(...out);
}
featureOrdered.length = 0;
featureOrdered.push(...reordered);
for (const b of buffer) { b.chapter = 0; b.sequence = 0; }

const styleCount = all.reduce((a, c) => (a[c.style] = (a[c.style] || 0) + 1, a), {});
const shotGroups = all.reduce((a, c) => (a[c.shot_type] = (a[c.shot_type] || 0) + 1, a), {});
const out = {
  version: 'scene-cards-v3.1',
  createdAt: '2026-11-14',
  total: 200,
  featureCount: 180,
  bufferCount: 20,
  durationSec: 10,
  styleCount,
  shotGroups,
  scope: 'pure-natural-landscape',
  cards: [...featureOrdered, ...buffer]
};
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.1.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

let md = '# 自然风光场景卡 v3.1（180 正片 + 20 缓冲）\n\n';
md += '> 纯自然风光；10 秒/段；30 分钟；纯文本，0 元，不调用付费 API。\n\n';
md += '| # | 角色 | 卷/序 | 地貌 | 主角/特征 | 前景 | 天气/季节 | 光线 | 镜头/角度 | 运动 | 色板 | 稀有度 |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const c of out.cards) {
  md += `| ${c.id} | ${c.role === 'buffer' ? '缓冲' : '正片'} | ${c.chapter}/${c.sequence} | ${c.biome} · ${c.landform} | ${c.protagonist}；${c.feature} | ${c.foreground} | ${c.weather} / ${c.season} | ${c.light} | ${c.shot} / ${c.cameraAngle} / ${c.lens} | ${c.motion} | ${c.palette} | ${c.rarity} |\n`;
}
md += '\n## 统计\n\n';
md += `- 正片 ${featureCards.length} + 缓冲 ${buffer.length} = ${all.length}\n`;
md += `- 风格：cinematic-calm ${styleCount['cinematic-calm'] || 0} / dramatic ${styleCount.dramatic || 0}\n`;
md += `- 镜头：${Object.entries(shotGroups).map(([k, v]) => `${k} ${v}`).join('，')}\n`;
md += `- 正片 scene_key 唯一：${featureKeys.size}\n`;
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.1.md'), md, 'utf8');

console.log(JSON.stringify({ total: all.length, feature: featureCards.length, buffer: buffer.length, styleCount, shotGroups, uniqueFeatureKeys: featureKeys.size }, null, 2));
