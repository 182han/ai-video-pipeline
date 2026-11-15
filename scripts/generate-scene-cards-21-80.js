// 生成第 21–80 张场景卡（纯文本，不调用任何付费 API）。
// 20 张已审通过 + 60 张候选 = 80 张；最终 30 分钟 / 10 秒一段需要 200 张。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SEED_FILE = path.join(ROOT, 'docs', 'scene-cards-v1.json');
const seeds = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).cards;

// [biome, landform, feature, foreground, weather, season, light, shot, lens, motion, palette, style]
const specs = [
  ['海岸', '海蚀洞', '海蚀洞入口与湿卵石', '湿卵石', '海雾', '深秋', '阴天散射，洞口右侧更亮', '中景', '24mm', '极慢推进', '冷灰 + 海藻绿', 'cinematic-calm'],
  ['海岸', '喷水洞', '风暴涌浪从喷水洞喷出', '黑色礁石', '风暴涌浪', '冬', '逆光，水雾被点亮', '中景', '16mm', '静态', '冷灰 + 白', 'dramatic'],
  ['海岸', '连岛沙洲', '沙洲连接两座海蚀柱', '浅水沙脊', '晴间薄云', '春', '低太阳侧光', '大全景航拍', '28mm', '极慢横移', '青绿 + 浅沙', 'cinematic-calm'],
  ['海岸', '海蚀柱群', '海蚀柱群与海藻带', '海藻与湿岩', '蓝调', '秋', '日落后青蓝 + 暖边', '大全景', '35mm', '静态', '冷蓝 + 琥珀', 'cinematic-calm'],
  ['海岸', '峡湾崖壁', '峡湾崖壁与细瀑', '瀑布水线', '薄雾', '春', '侧光，崖壁一半亮一半暗', '大全景航拍', '24mm', '极慢前推', '深蓝 + 绿', 'dramatic'],
  ['海岸', '潮池', '潮池水面与礁石纹理', '潮池边缘', '阴天散射', '夏', '云层均匀散射', '纹理特写', '85mm', '静态', '冷灰 + 绿', 'cinematic-calm'],
  ['海岸', '白垩崖', '白垩崖与草甸边缘', '草甸边缘', '风暴前', '夏', '冷灰风暴光', '大全景', '16mm', '极慢横移', '白 + 绿 + 灰', 'dramatic'],
  ['沙漠', '新月形沙丘', '新月沙丘的滑落面', '滑落面阴影', '干燥无云', '初秋', '日出侧光', '纹理特写', '200mm', '静态', '暖赭 + 深棕', 'cinematic-calm'],
  ['沙漠', '星形沙丘', '星形沙丘的交叉脊线', '脊线阴影', '晴', '夏', '日落侧光', '大全景航拍', '24mm', '极慢横移', '橙 + 棕', 'cinematic-calm'],
  ['沙漠', '穹状沙丘', '穹状沙丘与风纹', '风纹前景', '蓝调', '秋', '日落后冷蓝', '中景', '70mm', '静态', '冷沙 + 灰蓝', 'cinematic-calm'],
  ['荒漠', '雅丹垄脊', '雅丹风蚀垄脊与沟槽', '砾石沟槽', '干燥大风', '春', '低角度侧光', '中景', '135mm', '静态', '灰 + 土黄', 'dramatic'],
  ['荒漠', '岛山', '荒漠岛山与干草', '干草', '晴', '冬', '日出侧光', '大全景', '35mm', '极慢前推', '暖岩 + 冷天', 'cinematic-calm'],
  ['荒漠', '沙漠漆岩', '黑色沙漠漆岩面', '岩面纹理', '晴', '夏', '低角度侧光', '纹理特写', '100mm', '静态', '黑褐 + 橙', 'cinematic-calm'],
  ['荒漠', '盐盘', '盐盘裂纹与薄水', '盐壳裂纹', '阴天散射', '夏', '均匀散射', '大全景', '20mm', '静态', '白 + 灰', 'cinematic-calm'],
  ['荒漠', '蘑菇石', '风蚀蘑菇石与倒石堆', '倒石堆', '风暴光', '秋', '侧光', '中景', '35mm', '极慢推进', '红 + 灰', 'cinematic-calm'],
  ['峡谷', '台地', '台地边缘与碎石坡', '碎石坡', '晴', '春', '日出侧光', '大全景航拍', '24mm', '极慢横移', '红 + 橙', 'dramatic'],
  ['峡谷', '孤山', '孤山与鼠尾草', '鼠尾草', '蓝调', '夏', '日落后青蓝', '大全景', '35mm', '静态', '冷蓝 + 红岩', 'cinematic-calm'],
  ['峡谷', '熔岩塞', '熔岩塞与熔岩碎石', '熔岩碎石', '阴天散射', '秋', '均匀散射', '中景', '50mm', '极慢推进', '深灰 + 绿', 'cinematic-calm'],
  ['峡谷', '熔岩场', '龟裂熔岩场', '龟裂熔岩', '风暴', '冬', '冷灰风暴光', '大全景', '16mm', '极慢前推', '黑 + 灰', 'dramatic'],
  ['峡谷', '火山渣锥', '火山渣锥与火山灰', '火山灰', '晴', '夏', '日出侧光', '大全景航拍', '28mm', '极慢横移', '红 + 黑', 'dramatic'],
  ['峡谷', '破火山口', '破火山口边缘与云', '火山口边缘', '蓝调', '春', '日落后青蓝', '大全景', '20mm', '静态', '蓝 + 暗红', 'cinematic-calm'],
  ['峡谷', '喷气孔', '喷气孔与硫磺结晶', '硫磺结晶', '晨雾', '秋', '侧光', '中景', '35mm', '静态', '黄 + 灰', 'dramatic'],
  ['山地', '冰斗', '冰斗与冰斗湖', '湖边砾石', '阴天散射', '夏', '均匀散射', '大全景', '24mm', '极慢横移', '蓝 + 灰', 'cinematic-calm'],
  ['山地', '刃脊', '刃脊与雪檐', '雪檐', '晴', '冬', '日出侧光', '中景', '35mm', '极慢推进', '冷白 + 暖边', 'dramatic'],
  ['山地', '角峰', '角峰与冰川', '冰川裂隙', '蓝调', '夏', '日落后冷蓝', '大全景', '28mm', '静态', '蓝 + 白', 'cinematic-calm'],
  ['山地', 'U 型谷', 'U 型谷与谷底河', '谷底河', '阴天散射', '秋', '均匀散射', '大全景航拍', '24mm', '极慢前推', '绿 + 灰', 'cinematic-calm'],
  ['山地', '悬谷', '悬谷瀑布与雾', '瀑布水雾', '薄雾', '春', '侧逆光', '中景', '24mm', '极慢推进', '绿 + 白', 'cinematic-calm'],
  ['山地', '冰碛垄', '冰碛垄与漂砾', '漂砾', '风暴', '夏', '平光', '纹理特写', '50mm', '静态', '灰 + 绿', 'cinematic-calm'],
  ['山地', '蛇形丘', '蛇形丘与砾石', '砾石', '晨光', '春', '低角度侧光', '大全景航拍', '35mm', '极慢横移', '绿 + 棕', 'cinematic-calm'],
  ['山地', '冰瀑', '冰瀑与冰柱', '冰柱', '阴天散射', '冬', '均匀散射', '中景', '35mm', '静态', '蓝 + 白', 'dramatic'],
  ['山地', '冰裂隙场', '冰裂隙场与雪桥', '雪桥', '低太阳', '春', '侧光', '纹理特写', '24mm', '静态', '蓝 + 白', 'dramatic'],
  ['山地', '冰架', '冰架压力脊与蓝冰', '压力脊', '晴冷', '极昼', '低太阳侧光', '大全景航拍', '24mm', '极慢前推', '白 + 蓝', 'cinematic-calm'],
  ['山地', '冰山', '冰山与海面', '海面', '蓝调', '极昼', '冷蓝', '中景', '35mm', '极慢横移', '蓝 + 白', 'cinematic-calm'],
  ['山地', '苔原', '苔原与地衣', '地衣', '阴天散射', '秋', '均匀散射', '大全景', '50mm', '静态', '绿 + 锈红', 'cinematic-calm'],
  ['山地', '高山草甸', '高山草甸与野花', '野花', '日出', '夏', '侧光', '大全景', '35mm', '极慢横移', '绿 + 金', 'cinematic-calm'],
  ['水体', '瀑布', '瀑布与深潭', '潭边湿石', '阴天散射', '春', '均匀散射', '中景', '24mm', '静态', '绿 + 白', 'cinematic-calm'],
  ['水体', '叠瀑', '叠瀑与苔藓', '苔藓', '侧逆光', '秋', '金色侧逆光', '中景', '35mm', '极慢推进', '绿 + 金', 'cinematic-calm'],
  ['水体', '牛轭湖', '牛轭湖与芦苇', '芦苇', '晨雾', '夏', '日出前蓝调', '大全景航拍', '28mm', '极慢横移', '绿 + 蓝', 'cinematic-calm'],
  ['水体', '曲流', '曲流与沙洲', '沙洲', '日落后', '秋', '侧光', '大全景航拍', '24mm', '极慢前推', '蓝 + 金', 'cinematic-calm'],
  ['水体', '三角洲', '三角洲水道与泥滩', '泥滩', '阴天散射', '春', '均匀散射', '大全景航拍', '28mm', '极慢前推', '绿 + 泥', 'cinematic-calm'],
  ['水体', '河口湾', '河口湾与泥滩', '泥滩', '蓝调', '秋', '冷蓝', '大全景', '35mm', '静态', '灰 + 蓝', 'cinematic-calm'],
  ['水体', '潮汐滩', '潮汐滩树枝状水道', '湿沙纹理', '晨光', '春', '低角度侧光', '大全景航拍', '35mm', '极慢横移', '银 + 棕', 'cinematic-calm'],
  ['水体', '芦苇荡', '芦苇荡与晨雾', '芦苇', '晨雾', '秋', '日出前蓝调', '中景', '85mm', '静态', '金 + 绿', 'cinematic-calm'],
  ['水体', '湖泊', '湖泊与岸石', '岸石', '蓝调', '夏', '日落后青蓝', '大全景', '20mm', '静态', '蓝', 'cinematic-calm'],
  ['水体', '冰斗湖', '冰斗湖与倒影', '湖边巨石', '阴天散射', '秋', '均匀散射', '大全景', '24mm', '极慢横移', '蓝 + 灰', 'cinematic-calm'],
  ['水体', '热泉', '热泉与钙华', '钙华', '晨雾', '冬', '蒸汽被侧光照亮', '纹理特写', '50mm', '静态', '矿物蓝 + 橙', 'dramatic'],
  ['水体', '间歇泉', '间歇泉与硅华', '硅华', '阴天散射', '夏', '侧光', '中景', '35mm', '静态', '灰 + 蓝', 'dramatic'],
  ['水体', '钙华池', '钙华池与浅水', '浅水', '日出', '春', '侧光', '大全景', '24mm', '极慢前推', '绿松石 + 白', 'cinematic-calm'],
  ['喀斯特', '天坑', '天坑与坑底森林', '坑底森林', '阴天散射', '夏', '均匀散射', '大全景航拍', '16mm', '极慢前推', '绿 + 灰', 'dramatic'],
  ['喀斯特', '天然桥', '天然桥与河面', '河面', '蓝调', '秋', '冷蓝', '中景', '24mm', '静态', '灰 + 蓝', 'cinematic-calm'],
  ['喀斯特', '溶洞', '溶洞与石钟乳', '石钟乳', '洞内', '夏', '单束顶光', '大全景', '16mm', '极慢推进', '暗 + 暖', 'dramatic'],
  ['森林', '温带雨林', '温带雨林与蕨类', '蕨类', '晨雾', '夏', '树冠缝隙光', '纹理特写', '35mm', '静态', '深绿 + 灰', 'cinematic-calm'],
  ['森林', '针叶林', '针叶林与积雪', '积雪', '阴天散射', '冬', '均匀散射', '大全景', '50mm', '极慢横移', '绿 + 白', 'cinematic-calm'],
  ['森林', '云雾林', '云雾林与苔藓', '苔藓', '晨雾', '春', '散射', '中景', '35mm', '极慢推进', '绿 + 白', 'cinematic-calm'],
  // 天文 6 张
  ['极地', '极光弧', '氧绿极光弧与雪林', '雪林剪影', '无月夜，晴', '冬', '极光弧，洋红外缘', '天文', '14mm', '静态', '暗底 + 氧绿 + 洋红', 'dramatic'],
  ['高山', '星轨同心圆', '星轨绕天极与冰斗湖', '湖边石', '无月夜，晴', '夏', '星轨长曝', '天文', '14mm', '静态', '暗蓝 + 银', 'cinematic-calm'],
  ['湖泊', '银河倒影', '银河与无风湖面倒影', '湖岸', '无月夜', '夏', '银河 + 气辉', '天文', '14mm', '静态', '暗底 + 暖星云', 'dramatic'],
  ['潮间带', '黄道光', '黄道光与潮汐滩', '湿沙', '无月夜', '春', '黄道光锥', '天文', '20mm', '静态', '暗青 + 淡金', 'cinematic-calm'],
  ['湿地', '月升', '月升与芦苇', '芦苇剪影', '晴', '秋', '月升，低角度', '天文', '85mm', '静态', '冷银 + 暖月', 'cinematic-calm'],
  ['荒漠', '气辉银河', '气辉与雅丹土丘', '土丘剪影', '无月夜', '夏', '银河 + 气辉', '天文', '14mm', '静态', '暗底 + 橄榄绿', 'dramatic']
];

function highlightFor(feature) {
  if (/极光|银河|星轨|黄道|月升|气辉/.test(feature)) return '星点/极光不过曝，暗部保留层次';
  if (/冰|雪|瀑|湖|海|潮|泉|河|湾|池|盐|水/.test(feature)) return '水面/冰面反光不炸白，暗部保留层次';
  if (/沙|雅丹|岩|崖|谷|石|土|丹霞|台地/.test(feature)) return '亮部不过曝，阴影保留纹理';
  if (/林|草甸|苔|蕨|芦|稻/.test(feature)) return '叶面/草甸高光不炸，雾中有层次';
  return '天空不过曝，暗部保留层次';
}
function avoidFor(biome) {
  if (biome === '极地') return '无人物、无营地、无车';
  if (biome === '海岸') return '无人物、无船、无建筑';
  if (biome === '荒漠' || biome === '沙漠') return '无人物、无车辙、无建筑';
  if (biome === '森林') return '无人物、无小径、无建筑';
  if (biome === '山地' || biome === '冰川') return '无人物、无绳索、无营地';
  return '无人物、无建筑、无文字';
}

const cards = specs.map((s, i) => {
  const [biome, landform, feature, foreground, weather, season, light, shot, lens, motion, palette, style] = s;
  return {
    id: 'sc-' + String(21 + i).padStart(3, '0'),
    biome, landform, feature, foreground, weather, season, light, shot, lens, motion, palette, style,
    highlight_control: highlightFor(feature),
    protagonist: feature,
    avoid: avoidFor(biome),
    durationSec: 10,
    status: 'candidate',
    source: 'scene-card-generator-v1'
  };
});

const all = [
  ...seeds.map((c) => ({ ...c, durationSec: 10, status: 'approved', source: c.source || 'seed-v1' })),
  ...cards
];

if (all.length !== 80) throw new Error('total != 80: ' + all.length);
const keys = new Set();
for (const c of all) {
  const k = [c.biome, c.landform, c.feature, c.foreground].join('|');
  if (keys.has(k)) throw new Error('duplicate scene: ' + k);
  keys.add(k);
}
const styles = all.reduce((a, c) => (a[c.style] = (a[c.style] || 0) + 1, a), {});
const shots = all.reduce((a, c) => (a[c.shot] = (a[c.shot] || 0) + 1, a), {});

const out = {
  version: 'scene-cards-v2',
  createdAt: '2026-11-14',
  durationSec: 10,
  total: all.length,
  approved: seeds.length,
  candidate: cards.length,
  styles,
  shots,
  cards: all
};
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v2.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

let md = '# 自然风光场景卡 v2（80 张：20 已审 + 60 候选）\n\n';
md += '> 纯文本规划，不调用付费 API。30 分钟 / 10 秒一段 = 180 段；目标 200 张（180 + 20 缓冲）。\n\n';
md += '| # | 状态 | 地貌 | 主角/特征 | 前景 | 天气/季节 | 光线 | 镜头/焦段 | 运动 | 色板 | 高光控制 |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const c of all) {
  md += `| ${c.id} | ${c.status === 'approved' ? '已审' : '候选'} | ${c.biome} · ${c.landform} | ${c.protagonist}；${c.feature} | ${c.foreground} | ${c.weather} / ${c.season} | ${c.light} | ${c.shot} / ${c.lens} | ${c.motion} | ${c.palette} | ${c.highlight_control} |\n`;
}
md += '\n## 覆盖\n\n';
md += `- 总数：${all.length}（20 已审 + 60 候选）\n`;
md += `- 风格：cinematic-calm ${styles['cinematic-calm'] || 0}，dramatic ${styles.dramatic || 0}\n`;
md += `- 镜头：${Object.entries(shots).map(([k, v]) => `${k} ${v}`).join('，')}\n`;
md += '- 已避免重复：biome + landform + feature + foreground 唯一\n';
md += '\n## 下一步\n\n';
md += '- 审阅第 21–80 张；不喜欢的直接标掉。\n';
md += '- 通过后继续扩到 200 张（仍 0 元）。\n';
md += '- 再选 6 张生成图片做真实感验证（约 ¥1.20）。\n';
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v2.md'), md, 'utf8');

console.log(JSON.stringify({ total: all.length, styles, shots, duplicateFree: true }, null, 2));
