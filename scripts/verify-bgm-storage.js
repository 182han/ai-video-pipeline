// 真机验证：postgres 驱动能读写 bgmPlan / bgmResult
const storage = require('../src/storage');

(async () => {
  const testId = 'task_bgmprobe_' + Date.now().toString(36);
  const plan = {
    music: [{ id: 's1', trackId: 'calm_01', timelineStart: 0, timelineEnd: 35, sourceIn: 0, sourceOut: 35, volume: 0.8, fadeIn: 2, fadeOut: 2, speed: 1, fillMode: 'none', keyframes: [{ t: 0, v: 1 }, { t: 35, v: 0.5 }] }],
    ambient: []
  };
  const result = { applied: true, segments: 1, warnings: [] };

  const task = {
    taskId: testId,
    status: 'completed',
    prompt: 'bgm plan probe',
    totalClips: 1,
    clipDuration: 35,
    resolution: '720p',
    totalDuration: 35,
    clips: [{ index: 0, status: 'success', prompt: 'p', trackId: null }],
    steps: {},
    runtimeConfig: {},
    bgmPlan: plan,
    bgmResult: result,
    createdAt: new Date().toISOString()
  };

  await storage.saveTask(task);
  console.log('1) 写入成功');

  const loaded = await storage.getTask(testId);
  if (!loaded) throw new Error('读回失败: 任务不存在');
  const p = loaded.bgmPlan, r = loaded.bgmResult;
  console.log('2) 读回 bgmPlan.music[0].volume =', p && p.music && p.music[0] && p.music[0].volume);
  console.log('   读回 bgmResult.applied =', r && r.applied);
  console.log('   关键帧数量 =', p && p.music && p.music[0] && p.music[0].keyframes && p.music[0].keyframes.length);

  const ok = p && p.music && p.music[0].volume === 0.8 &&
             p.music[0].keyframes && p.music[0].keyframes.length === 2 &&
             r && r.applied === true;
  console.log(ok ? 'PASS 配乐计划可完整往返' : 'FAIL 往返数据不一致');

  // 清理
  await storage.deleteTask(testId);
  console.log('3) 测试数据已清理（软删除）');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
