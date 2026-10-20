// 勾选组合验证：轻音乐 / 环境音 / 两者
const mixer = require('../src/processors/audioMixer');
let fail = 0;
const check = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const cases = [
  { name: '只勾轻音乐', opt: { wantMusic: true, wantAmbient: false }, mMin: 1, aExact: 0 },
  { name: '只勾环境音', opt: { wantMusic: false, wantAmbient: true }, mExact: 0, aExact: 1 },
  { name: '两者都勾',   opt: { wantMusic: true, wantAmbient: true },  mMin: 1, aExact: 1 },
  { name: '两者都不勾', opt: { wantMusic: false, wantAmbient: false }, expectFail: true }
];

for (const c of cases) {
  const r = mixer.buildAutoPlan(60, { ...c.opt, defaultTrackId: 'calm_01' });
  if (c.expectFail) {
    check(!r.ok || (r.plan.music.length === 0 && r.plan.ambient.length === 0), c.name + ' -> 正确拒绝: ' + (r.error || '空计划'));
    continue;
  }
  if (!r.ok) { console.log('  FAIL  ' + c.name + ' -> ' + r.error); fail++; continue; }
  const m = r.plan.music.length, a = r.plan.ambient.length;
  let ok = true;
  if (c.mExact !== undefined && m !== c.mExact) ok = false;
  if (c.mMin !== undefined && m < c.mMin) ok = false;
  if (c.aExact !== undefined && a !== c.aExact) ok = false;
  check(ok, c.name + ' -> 轻音乐 ' + m + ' 段, 环境音 ' + a + ' 段');
  if (a === 1) {
    const seg = r.plan.ambient[0];
    check(seg.fillMode === 'loop', c.name + ' -> 环境音循环填充 (fillMode=' + seg.fillMode + ')');
    check(Math.abs(seg.timelineEnd - 60) < 0.1, c.name + ' -> 环境音铺满全片 (' + seg.timelineEnd + 's)');
    const amb = mixer.listTracks(null, 'ambient').map(t => t.id);
    check(amb.includes(seg.trackId), c.name + ' -> 环境音取自环境音分类 (' + seg.trackId + ')');
  }
  if (m > 0) {
    const ambIds = mixer.listTracks(null, 'ambient').map(t => t.id);
    check(!r.plan.music.some(s => ambIds.includes(s.trackId)), c.name + ' -> 轻音乐轨不含环境音');
  }
}

console.log('\n=== 环境音指定曲目 ===');
const r2 = mixer.buildAutoPlan(30, { wantMusic: false, wantAmbient: true, ambientTrackId: 'nature_03' });
check(r2.ok && r2.plan.ambient[0].trackId === 'nature_03', '指定 nature_03 被采用: ' + (r2.plan && r2.plan.ambient[0].trackId));

console.log('\n=== 混合混音实测（两轨同时）===');
console.log('  （见 verify-bgm-mix.js 的 A2 用例，已覆盖两轨叠加 -18dB）');

console.log('\n' + (fail ? 'FAIL ' + fail : '全部通过'));
process.exit(fail ? 1 : 0);
