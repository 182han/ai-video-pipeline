// 生成第 81–200 张场景卡（共 120 张，纯文本，0 元，不调用付费 API）。
// 目标：总 200 张；镜头配比 80/50/30/20/20（大全景航拍/中景/纹理/点景/天文）。
// 电视屏保约束：16:9、5% 安全区、零人物文字建筑、单运动轴、慢、可循环、避免高对比静止画面。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scene-cards-v2.json'), 'utf8'));
const existing = v2.cards;

// 30 个新地貌族 × 4 个具体特征 = 120 张
const families = [
  { biome:'海岸', landform:'海蚀崖', features:['海蚀龛','海蚀窗','海蚀柱群','海蚀平台'], foregrounds:['湿岩','海雾','浪花','潮池'], weathers:['海雾','风暴前','蓝调','阴天散射'], seasons:['秋','冬','春','夏'], lights:['阴天散射','冷灰风暴光','日落后青蓝','均匀散射'] },
  { biome:'海岸', landform:'沙洲', features:['连岛沙洲','湾口沙坝','沙嘴','潮汐三角洲'], foregrounds:['浅水沙脊','沙洲草','潮沟','湿沙'], weathers:['晴间薄云','风暴后','蓝调','薄雾'], seasons:['春','秋','夏','冬'], lights:['低太阳侧光','冷灰','日落后青蓝','阴天散射'] },
  { biome:'海岸', landform:'礁盘', features:['潮池','礁盘','海藻林','浪蚀沟'], foregrounds:['潮池边缘','礁石','海藻','湿岩沟'], weathers:['阴天散射','晴','蓝调','海雾'], seasons:['夏','秋','春','冬'], lights:['均匀散射','侧光','冷蓝','海雾散射'] },
  { biome:'海岸', landform:'悬崖', features:['白垩崖','玄武岩崖','花岗岩崖','海蚀拱'], foregrounds:['草甸边缘','柱状节理','花岗岩块','礁石'], weathers:['风暴前','海雾','晴','蓝调'], seasons:['夏','冬','春','秋'], lights:['冷灰风暴光','阴天散射','侧光','日落后青蓝'] },
  { biome:'沙漠', landform:'沙丘', features:['风蚀坑','沙丘湖','沙丘草','沙丘雪'], foregrounds:['风蚀坑边缘','湖面','沙草','雪面'], weathers:['干燥无云','晴冷','晨雾','晴'], seasons:['秋','冬','春','夏'], lights:['日出侧光','低太阳侧光','蓝调','日落侧光'] },
  { biome:'荒漠', landform:'雅丹', features:['风蚀垄脊','风蚀沟槽','土丘群','风蚀柱'], foregrounds:['砾石','沟槽','土丘','风蚀柱'], weathers:['干燥大风','薄霾','晴','风暴'], seasons:['春','秋','夏','冬'], lights:['低角度侧光','侧光','日落侧光','冷灰'] },
  { biome:'荒漠', landform:'戈壁', features:['砾石滩','黑戈壁','干河床','风蚀洼地'], foregrounds:['砾石','黑砾','干沙','洼地'], weathers:['晴','风','薄霾','阴天'], seasons:['秋','冬','春','夏'], lights:['侧光','低角度侧光','均匀散射','日落'] },
  { biome:'荒漠', landform:'盐地', features:['盐盘','盐壳','干盐湖','盐沼'], foregrounds:['盐壳','裂纹','盐晶','盐沼草'], weathers:['雨后无风','晴','薄云','蓝调'], seasons:['雨季','夏','秋','春'], lights:['日落后','侧光','均匀散射','低太阳'] },
  { biome:'丹霞', landform:'丹霞', features:['赤壁','方山','峰林','窄缝'], foregrounds:['岩壁','碎石','峰林','窄缝'], weathers:['晴薄霾','雨后','晨雾','蓝调'], seasons:['夏末','春','秋','夏'], lights:['狭缝光','侧光','散射','日落后'] },
  { biome:'喀斯特', landform:'喀斯特', features:['峰林','天坑','溶洞','天生桥'], foregrounds:['稻田','坑底森林','石钟乳','河面'], weathers:['蓝调薄雾','阴天','洞内','蓝调'], seasons:['初夏','夏','夏','秋'], lights:['日落后青蓝','均匀散射','单束顶光','冷蓝'] },
  { biome:'峡谷', landform:'峡谷', features:['狭缝','台地','孤山','天然拱'], foregrounds:['岩壁曲线','碎石坡','鼠尾草','河面'], weathers:['干燥','晴','蓝调','薄雾'], seasons:['春','春','夏','秋'], lights:['单束顶光','日出侧光','日落后青蓝','散射'] },
  { biome:'火山', landform:'火山', features:['熔岩隧道','渣锥','破火山口','喷气孔'], foregrounds:['熔岩碎石','火山灰','火山口缘','硫磺'], weathers:['阴天','晴','蓝调','晨雾'], seasons:['秋','夏','春','秋'], lights:['均匀散射','日出侧光','日落后青蓝','侧光'] },
  { biome:'冰川', landform:'冰川', features:['冰瀑','冰裂隙','冰碛垄','蛇形丘'], foregrounds:['冰柱','雪桥','漂砾','砾石'], weathers:['阴天','低太阳','风暴','晨光'], seasons:['冬','春','夏','春'], lights:['均匀散射','侧光','平光','低角度侧光'] },
  { biome:'极地', landform:'极地', features:['冰架','冰山','冰间湖','蓝冰'], foregrounds:['压力脊','海面','冰缘','蓝冰面'], weathers:['晴冷','蓝调','风暴','晴'], seasons:['极昼','极昼','冬','春'], lights:['低太阳侧光','冷蓝','冷灰','侧光'] },
  { biome:'高山', landform:'高山', features:['冰斗','刃脊','角峰','U 型谷'], foregrounds:['冰斗湖','雪檐','冰川','谷底河'], weathers:['阴天','晴','蓝调','薄雾'], seasons:['夏','冬','夏','秋'], lights:['均匀散射','日出侧光','日落后冷蓝','散射'] },
  { biome:'高山', landform:'高山草甸', features:['草甸','苔原','碎石坡','高山湖'], foregrounds:['野花','地衣','碎石','湖边石'], weathers:['日出','阴天','风暴','蓝调'], seasons:['夏','秋','夏','夏'], lights:['侧光','均匀散射','侧光','日落后青蓝'] },
  { biome:'瀑布', landform:'瀑布', features:['悬谷瀑布','叠瀑','瀑布潭','峡谷瀑布'], foregrounds:['水雾','苔藓','湿石','岩壁'], weathers:['薄雾','侧逆光','阴天','薄雾'], seasons:['春','秋','春','夏'], lights:['侧逆光','金色侧逆光','均匀散射','侧光'] },
  { biome:'河流', landform:'河流', features:['牛轭湖','曲流','三角洲','辫状河'], foregrounds:['芦苇','沙洲','泥滩','砾石洲'], weathers:['晨雾','日落后','阴天','晴'], seasons:['夏','秋','春','夏'], lights:['日出前蓝调','侧光','均匀散射','低太阳'] },
  { biome:'湖泊', landform:'湖泊', features:['冰斗湖','火山口湖','盐湖','湖泊沙洲'], foregrounds:['湖边巨石','火山岩','盐壳','沙洲'], weathers:['阴天','晨雾','雨后无风','蓝调'], seasons:['秋','夏','雨季','夏'], lights:['均匀散射','散射','日落后','日落后青蓝'] },
  { biome:'潮间带', landform:'潮间带', features:['潮沟','沙脊','波痕','退潮水道'], foregrounds:['湿沙','沙脊','波痕','水道'], weathers:['晨光','阴天','无风','蓝调'], seasons:['春','夏','秋','春'], lights:['低角度侧光','均匀散射','侧光','冷蓝'] },
  { biome:'森林', landform:'森林', features:['雨林','针叶林','云雾林','落叶松林'], foregrounds:['蕨类','积雪','苔藓','落叶松'], weathers:['晨雾','阴天','晨雾','薄雾'], seasons:['夏','冬','春','秋'], lights:['树冠缝隙光','均匀散射','散射','侧光'] },
  { biome:'湿地', landform:'湿地', features:['泥炭沼','沼泽','盐沼','芦苇荡'], foregrounds:['苔藓','水面','盐沼草','芦苇'], weathers:['晨雾','阴天','薄雾','晨雾'], seasons:['夏','春','秋','秋'], lights:['散射','均匀散射','侧光','日出前蓝调'] },
  { biome:'地热', landform:'地热', features:['热泉','间歇泉','钙华池','泥泉'], foregrounds:['钙华','硅华','浅水','泥面'], weathers:['晨雾','阴天','日出','阴天'], seasons:['冬','夏','春','秋'], lights:['蒸汽侧光','侧光','侧光','均匀散射'] },
  { biome:'天文', landform:'天文', features:['极光弧','星轨','银河','黄道光'], foregrounds:['雪林','冰斗湖','湖岸','潮汐滩'], weathers:['无月夜晴','无月夜晴','无月夜','无月夜'], seasons:['冬','夏','夏','春'], lights:['极光弧','星轨长曝','银河气辉','黄道光锥'] },
  { biome:'草原', landform:'草原', features:['草原','稀树草原','草甸','荒原'], foregrounds:['草穗','孤树','野花','枯草'], weathers:['晴','日落','阴天','风'], seasons:['夏','秋','夏','秋'], lights:['侧光','日落侧光','均匀散射','低角度侧光'] },
  { biome:'火山', landform:'火山·水', features:['火山湖','温泉河','黑沙滩','熔岩海岸'], foregrounds:['火山岩','温泉雾','黑沙','熔岩'], weathers:['晨雾','薄雾','风暴前','蓝调'], seasons:['夏','冬','冬','春'], lights:['散射','蒸汽侧光','冷灰','日落后青蓝'] },
  { biome:'山地', landform:'山地·雪', features:['雪原','雪檐','冰川湖','雪崩锥'], foregrounds:['雪面','雪檐','湖边雪','雪崩堆'], weathers:['晴冷','阴天','蓝调','风暴'], seasons:['冬','冬','春','冬'], lights:['低太阳侧光','均匀散射','冷蓝','冷灰'] },
  { biome:'河流', landform:'河流·湿地', features:['河漫滩','牛轭湖','河湾','河心洲'], foregrounds:['滩草','芦苇','河湾沙','洲头'], weathers:['晨雾','蓝调','阴天','晴'], seasons:['夏','秋','春','夏'], lights:['日出前蓝调','日落后青蓝','均匀散射','侧光'] },
  { biome:'森林', landform:'森林·水', features:['森林溪','森林瀑布','森林湖','森林湿地'], foregrounds:['溪石','水雾','湖岸','湿地草'], weathers:['晨雾','薄雾','阴天','晨雾'], seasons:['夏','春','秋','夏'], lights:['树冠缝隙光','侧逆光','均匀散射','散射'] },
  { biome:'天文', landform:'天文·极地', features:['极光帘幕','极光冠冕','极光地面辉光','极光弧'], foregrounds:['雪林','雪原','海岸','湖面'], weathers:['无月夜晴','无月夜晴','无月夜晴','无月夜晴'], seasons:['冬','冬','冬','冬'], lights:['氧绿帘幕','天顶冠冕','贴地辉光','氧绿弧'] }
];

// 120 个镜头槽位：43 大全景/航拍、25 中景、20 纹理、20 点景、12 天文
const shotSlots = [
  ...Array(43).fill('wide'),
  ...Array(25).fill('medium'),
  ...Array(20).fill('texture'),
  ...Array(20).fill('point'),
  ...Array(12).fill('astro')
];
// 固定可复现的打散，避免同镜头连续
let seed = 20261114;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
for (let i = shotSlots.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [shotSlots[i], shotSlots[j]] = [shotSlots[j], shotSlots[i]];
}
for (let i = 1; i < shotSlots.length; i++) {
  if (shotSlots[i] === shotSlots[i - 1]) {
    const j = shotSlots.findIndex((s, k) => k > i && s !== shotSlots[i - 1] && s !== shotSlots[i]);
    if (j > i) [shotSlots[i], shotSlots[j]] = [shotSlots[j], shotSlots[i]];
  }
}

const styleSlots = [
  ...Array(84).fill('cinematic-calm'),
  ...Array(36).fill('dramatic')
];
seed = 20261115;
for (let i = styleSlots.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [styleSlots[i], styleSlots[j]] = [styleSlots[j], styleSlots[i]];
}

const shotLabel = { wide: ['大全景航拍', '大全景', '低机位大全景', '侧向滑轨大全景'], medium: ['中景', '低机位中景', '长焦中景'], texture: ['纹理特写', '侧移纹理特写', '俯拍纹理特写'], point: ['广角点景', '中景点景', '长焦点景'], astro: ['天文'] };
const lensByShot = { wide: ['24mm', '28mm', '35mm'], medium: ['35mm', '50mm'], texture: ['50mm', '85mm', '100mm'], point: ['24mm', '35mm', '50mm'], astro: ['14mm', '20mm'] };
const motionByShot = { wide: ['极慢横移', '极慢前推', '静态微转'], medium: ['极慢横移', '静态', '极慢前推'], texture: ['静态', '极慢横移'], point: ['极慢横移', '静态'], astro: ['静态'] };
const angleByShot = {
  wide: ['高位斜俯航拍', '地面广角', '低机位广角', '侧向滑轨'],
  medium: ['地面平视', '低机位中景', '长焦压缩'],
  texture: ['静态贴面', '侧向滑移', '俯拍纹理'],
  point: ['广角点景', '中景点景', '长焦点景'],
  astro: ['固定机位广角']
};
const paletteByBiome = {
  海岸: ['冷灰 + 海藻绿', '冷蓝 + 暖边', '白 + 绿 + 灰', '青绿 + 浅沙'],
  沙漠: ['暖赭 + 深棕', '橙 + 棕', '冷沙 + 灰蓝', '金 + 灰'],
  荒漠: ['土黄 + 灰', '灰 + 土黄', '黑褐 + 橙', '白 + 灰'],
  丹霞: ['暖红 + 冷灰', '赭红 + 黑', '红 + 金', '赤 + 青'],
  喀斯特: ['冷青 + 一点暖', '绿 + 灰', '暗 + 暖', '灰 + 蓝'],
  峡谷: ['红 + 橙', '冷蓝 + 红岩', '深灰 + 绿', '黑 + 灰'],
  火山: ['黑 + 灰', '红 + 黑', '蓝 + 暗红', '黄 + 灰'],
  冰川: ['冰蓝 + 灰', '蓝 + 白', '冷白 + 暖边', '白 + 蓝'],
  极地: ['白 + 蓝', '近单色冷蓝', '蓝 + 白', '冷灰 + 白'],
  高山: ['蓝 + 灰', '冷白 + 暖边', '绿 + 灰', '绿 + 白'],
  瀑布: ['冷绿 + 金', '绿 + 白', '冷蓝 + 白', '绿 + 金'],
  河流: ['绿 + 蓝', '蓝 + 金', '绿 + 泥', '灰 + 蓝'],
  湖泊: ['蓝', '蓝 + 灰', '青蓝 + 单暖云', '绿松石 + 白'],
  潮间带: ['银 + 棕', '灰褐 + 银', '青蓝 + 灰', '淡金 + 青'],
  森林: ['深绿 + 灰', '绿 + 白', '绿 + 锈红', '金 + 绿'],
  湿地: ['深绿 + 灰', '绿 + 灰', '金 + 绿', '冷银 + 暖月'],
  地热: ['矿物蓝 + 橙', '灰 + 蓝', '绿松石 + 白', '黄 + 灰'],
  天文: ['暗底 + 氧绿 + 洋红', '暗蓝 + 银', '暗底 + 暖星云', '暗青 + 淡金'],
  草原: ['绿 + 金', '金 + 蓝', '绿 + 灰', '暖土 + 灰绿'],
  山地: ['冷蓝 + 白', '蓝 + 白', '绿 + 棕', '灰 + 绿']
};
const scaleAnchors = {
  海岸: ['一只 <2% 的海鸟', '一艘 <2% 的渔船'],
  沙漠: ['一只 <2% 的鸟', '一队 <2% 的骆驼'],
  荒漠: ['一只 <2% 的鸟'],
  丹霞: ['一只 <2% 的鸟'],
  喀斯特: ['一只 <2% 的鸟', '一艘 <2% 的小船'],
  峡谷: ['一只 <2% 的鸟'],
  火山: ['一只 <2% 的鸟'],
  冰川: ['一只 <2% 的鸟'],
  极地: ['一只 <2% 的鸟'],
  高山: ['一只 <2% 的岩羊', '一只 <2% 的鸟'],
  瀑布: ['一只 <2% 的鸟'],
  河流: ['一艘 <2% 的小船', '一只 <2% 的水鸟'],
  湖泊: ['一艘 <2% 的小船', '一只 <2% 的水鸟'],
  潮间带: ['一只 <2% 的水鸟'],
  森林: ['一只 <2% 的鹿'],
  湿地: ['一只 <2% 的水鸟'],
  地热: ['一只 <2% 的鸟'],
  天文: ['一棵 <2% 的树剪影'],
  草原: ['一只 <2% 的鹰'],
  山地: ['一只 <2% 的岩羊']
};
const highlightByFeature = (feature) => {
  if (/极光|星轨|银河|黄道|月升|气辉/.test(feature)) return '星点/极光不过曝，暗部保留层次';
  if (/冰|雪|瀑|湖|海|潮|泉|河|湾|池|盐|水/.test(feature)) return '水面/冰面反光不炸白，暗部保留层次';
  if (/沙|雅丹|岩|崖|谷|石|土|丹霞|台地/.test(feature)) return '亮部不过曝，阴影保留纹理';
  if (/林|草甸|苔|蕨|芦|稻|草/.test(feature)) return '叶面/草甸高光不炸，雾中有层次';
  return '天空不过曝，暗部保留层次';
};
const avoidByBiome = (biome) => {
  if (biome === '极地') return '无人物、无营地、无车、无文字';
  if (biome === '海岸') return '无人物、无船、无建筑、无文字';
  if (biome === '荒漠' || biome === '沙漠') return '无人物、无车辙、无建筑、无文字';
  if (biome === '森林') return '无人物、无小径、无建筑、无文字';
  if (biome === '山地' || biome === '冰川') return '无人物、无绳索、无营地、无文字';
  return '无人物、无建筑、无文字';
};

const cards = [];
let idx = 0;
for (const f of families) {
  for (let i = 0; i < 4; i++) {
    const shotKey = shotSlots[idx];
    const feature = f.features[i];
    const foreground = f.foregrounds[i];
    const shot = shotLabel[shotKey][idx % shotLabel[shotKey].length];
    const lens = lensByShot[shotKey][idx % lensByShot[shotKey].length];
    const motion = motionByShot[shotKey][idx % motionByShot[shotKey].length];
    const angle = angleByShot[shotKey][idx % angleByShot[shotKey].length];
    const paletteArr = paletteByBiome[f.biome] || ['自然色'];
    cards.push({
      id: 'sc-' + String(81 + idx).padStart(3, '0'),
      biome: f.biome,
      landform: f.landform,
      feature,
      foreground,
      weather: f.weathers[i],
      season: f.seasons[i],
      light: f.lights[i],
      shot,
      cameraAngle: angle,
      lens,
      motion,
      palette: paletteArr[idx % paletteArr.length],
      style: styleSlots[idx],
      highlight_control: highlightByFeature(feature),
      protagonist: feature,
      scaleAnchor: shotKey === 'point' ? (scaleAnchors[f.biome] || ['一只 <2% 的鸟'])[idx % (scaleAnchors[f.biome] || ['一只 <2% 的鸟']).length] : null,
      avoid: avoidByBiome(f.biome),
      durationSec: 10,
      safeAreaPct: 5,
      tvSafe: true,
      loopable: true,
      status: 'candidate',
      source: 'scene-card-generator-tv-v1'
    });
    idx++;
  }
}

function angleForExisting(s) {
  if (/航拍/.test(s)) return '高位斜俯航拍';
  if (/低机位/.test(s)) return '低机位广角';
  if (/大全景/.test(s)) return '地面广角';
  if (/中景/.test(s)) return '地面平视';
  if (/纹理/.test(s)) return '静态贴面';
  if (/天文/.test(s)) return '固定机位广角';
  return '地面平视';
}
const all = [
  ...existing.map((c) => ({ ...c, cameraAngle: c.cameraAngle || angleForExisting(c.shot), safeAreaPct: 5, tvSafe: true, loopable: true })),
  ...cards
];
if (all.length !== 200) throw new Error('total != 200: ' + all.length);
const keys = new Set();
for (const c of all) {
  const k = [c.biome, c.landform, c.feature, c.foreground].join('|');
  if (keys.has(k)) throw new Error('duplicate scene: ' + k);
  keys.add(k);
}
const styleCount = all.reduce((a, c) => (a[c.style] = (a[c.style] || 0) + 1, a), {});
const shotCount = all.reduce((a, c) => (a[c.shot] = (a[c.shot] || 0) + 1, a), {});
const normShot = (s) => /点景/.test(s) ? 'point' : /天文/.test(s) ? 'astro' : /纹理/.test(s) ? 'texture' : /中景/.test(s) ? 'medium' : /航拍|大全景|侧向滑轨/.test(s) ? 'wide' : 'other';
const groups = all.reduce((a, c) => { const k = normShot(c.shot); a[k] = (a[k] || 0) + 1; return a; }, {});

const out = {
  version: 'scene-cards-v3',
  createdAt: '2026-11-14',
  durationSec: 10,
  total: 200,
  target: { clips: 180, buffer: 20 },
  styleCount,
  shotGroups: groups,
  shotCount,
  tvSafe: { aspect: '16:9', safeAreaPct: 5, noPeople: true, noText: true, oneMotionAxis: true, loopable: true },
  cards: all
};
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

let md = '# 自然风光场景卡 v3（200 张：180 正片 + 20 缓冲）\n\n';
md += '> 纯文本规划，0 元，不调用付费 API。30 分钟 / 10 秒一段。\n\n';
md += '| # | 状态 | 地貌 | 主角/特征 | 前景 | 点景 | 天气/季节 | 光线 | 镜头/角度 | 运动 | 色板 | 高光控制 |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const c of all) {
  md += `| ${c.id} | ${c.status === 'approved' ? '已审' : '候选'} | ${c.biome} · ${c.landform} | ${c.protagonist}；${c.feature} | ${c.foreground} | ${c.scaleAnchor || '-'} | ${c.weather} / ${c.season} | ${c.light} | ${c.shot} / ${c.cameraAngle || ''} / ${c.lens} | ${c.motion} | ${c.palette} | ${c.highlight_control || c.highlightControl} |\n`;
}
md += '\n## 配比\n\n';
md += `- 风格：cinematic-calm ${styleCount['cinematic-calm'] || 0} / dramatic ${styleCount.dramatic || 0}\n`;
md += `- 镜头：wide ${groups.wide || 0} / medium ${groups.medium || 0} / texture ${groups.texture || 0} / point ${groups.point || 0} / astro ${groups.astro || 0}\n`;
md += '- 所有卡：16:9、5% 安全区、单运动轴、可循环、无人物/文字/建筑。\n';
md += '\n## 说明\n\n';
md += '- 第 81–200 张是 30 个新地貌族 ×4 个具体特征；不是同一地貌换角度凑数。\n';
md += '- 其中天文 20 张、点景 20 张、纹理 30 张，按电视屏保节奏插入，避免长时间大景疲劳。\n';
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.md'), md, 'utf8');

console.log(JSON.stringify({ total: all.length, styleCount, shotGroups: groups, shotCount, duplicateFree: true }, null, 2));
