// 给 v3.1 场景卡补 science 字段；纯文本，不调用模型。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const src = path.join(ROOT, 'docs', 'scene-cards-v3.1.json');
const data = JSON.parse(fs.readFileSync(src, 'utf8'));

function scienceFor(c) {
  const s = `${c.landform || ''} ${c.original_feature || ''} ${c.feature || ''}`;
  if (/潮池/.test(s)) return {
    risk: 'high', scale: '池径约 0.5m，水深几厘米',
    checks: ['只允许细藤壶、滨螺、薄层石莼', '盐霜只在干湿交界形成细白边', '水面有微小涟漪'],
    forbidden: '大海带、海藻林、巨型盐晶、白花状盐花、过大藤壶'
  };
  if (/冰川|冰架|冰瀑|冰裂/.test(s)) return {
    risk: 'high', scale: '冰崖高约 20–30m，砾石 2–10cm',
    checks: ['冰面有脏层、气泡、融水痕', '垂直节理可保留', '冰碛垄与融水沟成立'],
    forbidden: '冰洞、蜂窝孔洞、海绵状冰、发光蓝冰、完美重复裂隙'
  };
  if (/极光/.test(s)) return {
    risk: 'high', scale: '极光位于低空 30° 以下',
    checks: ['氧绿为主', '洋红只在外缘极淡出现', '地景暗，雪面只有微弱反光'],
    forbidden: '霓虹极光、大面积帘幕、洋红爆发、绿色发光边、紫雾、月亮'
  };
  if (/温带雨林|针叶林|云雾林/.test(s)) return {
    risk: 'medium', scale: '树干直径 0.5–1m',
    checks: ['针叶树、苔藓、少量蕨类', '阴天薄雾、柔和散射光'],
    forbidden: '热带巨叶、粗大藤蔓、密集垂藤、完美光柱、小径'
  };
  if (/沙丘|沙漠/.test(s)) return {
    risk: 'medium', scale: '风纹间距 5–10cm',
    checks: ['迎风坡风纹、背风滑落面', '沙脊不规则、低角度侧光'],
    forbidden: '星形几何脊线、完美对称、航拍俯视、塑料沙面'
  };
  if (/盐湖|盐壳|盐盘/.test(s)) return {
    risk: 'medium', scale: '盐壳多边形 0.3–2m',
    checks: ['盐壳裂纹、薄水、倒影', '天空不过曝'],
    forbidden: '大块盐晶、白花状盐花、无风死水'
  };
  return {
    risk: 'low', scale: '按地貌实际尺度',
    checks: ['一个主角、三层纵深、高光受控'],
    forbidden: '人物、建筑、文字、HDR、过度锐化'
  };
}

for (const c of data.cards) c.science = scienceFor(c);
data.version = 'scene-cards-v3.2-science';
fs.writeFileSync(path.join(ROOT, 'docs', 'scene-cards-v3.2-science.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ total: data.cards.length, high: data.cards.filter(c => c.science.risk === 'high').length, medium: data.cards.filter(c => c.science.risk === 'medium').length, low: data.cards.filter(c => c.science.risk === 'low').length }, null, 2));
