// 配乐计划纯函数单测（零依赖，node 直接运行）
const assert = require('assert');
const plan = require('../src/processors/bgmPlan');

let passed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

const F = (p) => '/tmp/' + p + '.mp3';

test('空计划返回失败', () => {
  const r = plan.buildMixCommand({ music: [], ambient: [] }, 35);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /为空/);
});

test('单曲覆盖 35s：不再出现 aloop', () => {
  const r = plan.buildMixCommand({
    music: [{ trackId: 'calm_01', filePath: F('a'), timelineStart: 0, timelineEnd: 35, sourceIn: 0, sourceOut: 35, volume: 1, fadeIn: 2, fadeOut: 2, speed: 1, fillMode: 'none' }]
  }, 35);
  assert.strictEqual(r.ok, true);
  assert.ok(!/aloop/.test(r.filterComplex), '不应包含 aloop');
  assert.match(r.filterComplex, /atrim=start=0\.000:end=35\.000/);
  assert.match(r.filterComplex, /afade=t=in:st=0:d=2\.000/);
  assert.match(r.filterComplex, /afade=t=out:st=33\.000:d=2\.000/);
  assert.match(r.filterComplex, /loudnorm=I=-20/);
  assert.deepStrictEqual(r.inputTracks, [F('a')]);
});

test('同一素材重复使用时只作为一次输入', () => {
  const r = plan.buildMixCommand({
    music: [
      { trackId: 'x', filePath: F('x'), timelineStart: 0, timelineEnd: 10, sourceIn: 0, sourceOut: 10, volume: 1, speed: 1 },
      { trackId: 'x', filePath: F('x'), timelineStart: 20, timelineEnd: 30, sourceIn: 0, sourceOut: 10, volume: 1, speed: 1 }
    ]
  }, 40);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.inputTracks.length, 1, '同一文件只应有一次输入');
  assert.match(r.filterComplex, /amix=inputs=2/);
  assert.match(r.filterComplex, /adelay=20000\|20000/, '第二个片段应延时 20 秒');
});

test('两轨叠加时环境音按 -18dB 缩放', () => {
  const r = plan.buildMixCommand({
    music: [{ trackId: 'm', filePath: F('m'), timelineStart: 0, timelineEnd: 20, sourceIn: 0, sourceOut: 20, volume: 1, speed: 1 }],
    ambient: [{ trackId: 'a', filePath: F('a'), timelineStart: 0, timelineEnd: 20, sourceIn: 0, sourceOut: 20, volume: 1, speed: 1 }]
  }, 20);
  assert.strictEqual(r.ok, true);
  assert.match(r.filterComplex, /volume=0\.125/, '环境音应被压到 0.125');
});

test('关键帧音量生成线性插值表达式', () => {
  const expr = plan.buildVolumeExpression({ volume: 1, keyframes: [{ t: 0, v: 1 }, { t: 10, v: 0.5 }] }, 10);
  // 逗号必须转义成 \, 否则 filtergraph 会把它当参数分隔符（实测报错 No option name near 'frame'）
  assert.ok(expr.includes('if(lt(t\\,10.000)\\,'), '应生成转义逗号的 if() 表达式: ' + expr);
  assert.ok(expr.includes('0.5') || expr.includes('(0.5-1)'), '应包含目标音量: ' + expr);
  assert.ok(!/[^\\],/.test(expr), '不应存在未转义的逗号: ' + expr);
});

test('无关键帧且音量为 1 时不生成 volume 滤镜', () => {
  const expr = plan.buildVolumeExpression({ volume: 1 }, 10);
  assert.strictEqual(expr, null);
});

test('循环填充使用与采样率一致的 size', () => {
  const r = plan.buildMixCommand({
    music: [{ trackId: 's', filePath: F('s'), timelineStart: 0, timelineEnd: 100, sourceIn: 0, sourceOut: 50, volume: 1, speed: 1, fillMode: 'loop' }]
  }, 100);
  assert.strictEqual(r.ok, true);
  // 50s * 44100 = 2205000
  assert.match(r.filterComplex, /aloop=loop=-1:size=2205000/);
});

test('拉伸填充使用 atempo 且保音高', () => {
  const r = plan.buildMixCommand({
    music: [{ trackId: 's', filePath: F('s'), timelineStart: 0, timelineEnd: 20, sourceIn: 0, sourceOut: 10, volume: 1, speed: 1, fillMode: 'stretch' }]
  }, 20);
  assert.strictEqual(r.ok, true);
  assert.match(r.filterComplex, /atempo=2\.0000/);
});

test('变速超出范围被拒绝', () => {
  const v = plan.validateSegment({ trackId: 'x', filePath: F('x'), timelineStart: 0, timelineEnd: 10, speed: 3 }, 10);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /变速/);
});

test('非法片段被跳过并产生 warning，其余照常', () => {
  const r = plan.buildMixCommand({
    music: [
      { trackId: 'ok', filePath: F('ok'), timelineStart: 0, timelineEnd: 10, sourceIn: 0, sourceOut: 10, volume: 1, speed: 1 },
      { trackId: 'bad', filePath: F('bad'), timelineStart: 20, timelineEnd: 10, sourceIn: 0, sourceOut: 10, volume: 1, speed: 1 }
    ]
  }, 20);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /被跳过/);
});

test('片段超出成片时长时被跳过', () => {
  const v = plan.validateSegment({ trackId: 'x', filePath: F('x'), timelineStart: 40, timelineEnd: 50 }, 35);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /超出成片时长/);
});

test('输出总以 [aout] 结尾并带 loudnorm', () => {
  const r = plan.buildMixCommand({
    music: [{ trackId: 'm', filePath: F('m'), timelineStart: 0, timelineEnd: 30, sourceIn: 0, sourceOut: 30, volume: 1, speed: 1 }]
  }, 30);
  assert.strictEqual(r.audioMap, '[aout]');
  const parts = r.filterComplex.split(';');
  assert.match(parts[parts.length - 1], /\[aout\]$/);
  assert.match(parts[parts.length - 1], /loudnorm/);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); passed++; console.log('  PASS  ' + c.name); }
    catch (e) { failed++; console.log('  FAIL  ' + c.name + '\n        ' + e.message); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})();
