const fs=require('fs');
const dom = fs.readFileSync('output/_dom.html','utf8');
const checks = [
  ['添加配乐 导航', /添加配乐/],
  ['配乐库存 导航', /配乐库存/],
  ['配乐模式下拉', /id="bgmModeSelect"/],
  ['轻音乐勾选框', /id="bgmWantMusic"/],
  ['环境音勾选框', /id="bgmWantAmbient"/],
  ['开场曲下拉', /id="bgmStartTrack"/],
  ['环境音曲目下拉', /id="bgmAmbientTrack"/],
  ['旧逐段UI已移除', null, true] // 反向
];
let fail=0;
for (const [name, re, invert] of checks) {
  const found = re ? re.test(dom) : /bgmAssignList/.test(dom);
  const pass = invert ? !found : found;
  console.log((pass?'  PASS  ':'  FAIL  ')+name);
  if(!pass) fail++;
}
// 检查下拉是否已被 JS 填充（说明 loadBgmInventory 跑通了）
const startTrackOptions = (dom.match(/id="bgmStartTrack"[\s\S]*?<\/select>/)||[''])[0];
const optCount = (startTrackOptions.match(/<option/g)||[]).length;
console.log('\n开场曲下拉选项数: ' + optCount + '（>1 说明库存已加载）');
if (optCount <= 1) { console.log('  FAIL 下拉未被填充'); fail++; } else console.log('  PASS  下拉已被填充');
console.log('\n'+(fail?'FAIL '+fail:'全部通过'));
