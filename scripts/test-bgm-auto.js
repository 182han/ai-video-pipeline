const mixer = require('../src/processors/audioMixer');
const tests = [];
function t(name, fn){ tests.push({name,fn}); }

t('35s 成片：单曲覆盖，不循环', () => {
  const r = mixer.buildAutoPlan(35, { defaultTrackId: 'calm_01' });
  if (!r.ok) throw new Error(r.error);
  if (r.plan.music.length !== 1) throw new Error('应只有 1 段，实际 ' + r.plan.music.length);
  const s = r.plan.music[0];
  if (s.trackId !== 'calm_01') throw new Error('应从默认开场曲开始，实际 ' + s.trackId);
  if (Math.abs(s.timelineEnd - 35) > 0.1) throw new Error('应铺满 35s，实际 ' + s.timelineEnd);
});

t('70s 成片：跨曲衔接（calm_01 只有 53.9s）', () => {
  const r = mixer.buildAutoPlan(70, { defaultTrackId: 'calm_01' });
  if (!r.ok) throw new Error(r.error);
  if (r.plan.music.length < 2) throw new Error('应至少 2 段，实际 ' + r.plan.music.length);
  const a = r.plan.music[0], b = r.plan.music[1];
  if (b.timelineStart >= a.timelineEnd) throw new Error('第二段应与第一段重叠（交叉衔接），实际 a.end=' + a.timelineEnd + ' b.start=' + b.timelineStart);
  if (a.trackId === b.trackId) throw new Error('第二段应换曲');
  const last = r.plan.music[r.plan.music.length-1];
  if (Math.abs(last.timelineEnd - 70) > 0.1) throw new Error('应铺满 70s，末段结束于 ' + last.timelineEnd);
});

t('1800s 成片（30分钟）能铺满', () => {
  const r = mixer.buildAutoPlan(1800, { defaultTrackId: 'calm_02' });
  if (!r.ok) throw new Error(r.error);
  const last = r.plan.music[r.plan.music.length-1];
  if (Math.abs(last.timelineEnd - 1800) > 0.5) throw new Error('应铺满 1800s，实际 ' + last.timelineEnd);
  console.log('      段数=' + r.plan.music.length + ' 覆盖=' + r.coveredSec + 's 曲目=' + r.trackIds.join('→'));
});

t('自动配乐只含轻音乐，不含环境音', () => {
  const r = mixer.buildAutoPlan(300, {});
  if (!r.ok) throw new Error(r.error);
  const amb = mixer.listTracks(null, 'ambient').map(t => t.id);
  for (const id of r.trackIds) {
    if (amb.includes(id)) throw new Error('自动配乐不应包含环境音: ' + id);
  }
  if (r.plan.ambient.length !== 0) throw new Error('ambient 应为空');
});

t('用户自定义顺序生效', () => {
  const r = mixer.buildAutoPlan(60, { order: ['epic_03', 'calm_03'], defaultTrackId: 'epic_03' });
  if (!r.ok) throw new Error(r.error);
  if (r.plan.music[0].trackId !== 'epic_03') throw new Error('应从 order[0] 开始，实际 ' + r.plan.music[0].trackId);
});

t('无默认开场曲时随机起（不报错）', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const r = mixer.buildAutoPlan(10, {});
    if (!r.ok) throw new Error(r.error);
    seen.add(r.plan.music[0].trackId);
  }
  if (seen.size < 2) throw new Error('随机起点应在多首之间变化，实际只出现 ' + [...seen]);
});

t('全程不使用循环填充', () => {
  const r = mixer.buildAutoPlan(300, {});
  for (const s of r.plan.music) {
    if (s.fillMode === 'loop') throw new Error('自动配乐不应使用循环');
  }
});

(async () => {
  let fail = 0;
  for (const c of tests) {
    try { await c.fn(); console.log('  PASS  ' + c.name); }
    catch (e) { fail++; console.log('  FAIL  ' + c.name + '\n        ' + e.message); }
  }
  console.log('\n' + (tests.length-fail) + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
