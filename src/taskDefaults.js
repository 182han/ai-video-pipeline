// ==========================================
// 任务字段补全（历史任务兼容）
// ==========================================
// 背景：配乐改造（2026-10-19）给任务新增了 bgm / bgmPlan / bgmResult / masterPath。
// 改造前创建的历史任务没有这些字段，直接读会得到 undefined，导致各处都要写防御判断，
// 迟早漏一处。这里统一补默认值，让调用方拿到的对象形状一致。
//
// 为什么单独成文件：taskManager.getTask() 与 storage.getTask() 是两条独立路径
// （后者走数据库驱动、不经 taskManager），共用同一份补全逻辑才不会出现
// 「同一条任务，一处读到有 bgm、另一处读到没有」的不一致。

const LEGACY_BGM = Object.freeze({
  enabled: false,
  mode: 'off',
  trackId: null,
  wantMusic: false,
  wantAmbient: false,
  ambientTrackId: null,
  fadeInSec: 2,
  fadeOutSec: 2,
  crossfadeSec: 1.5,
  volume: -20,
  ambientVolume: 0.125,
  migratedFromClipTracks: false,
  legacy: true
});

// 就地补全（会修改传入对象），返回同一个对象，便于链式使用
function applyTaskDefaults(task) {
  if (!task || typeof task !== 'object') return task;
  if (task.bgm === undefined || task.bgm === null) task.bgm = { ...LEGACY_BGM };
  if (task.bgmPlan === undefined) task.bgmPlan = null;
  if (task.bgmResult === undefined) task.bgmResult = null;
  if (task.masterPath === undefined) task.masterPath = null;

  // 流水线档位：档位是在 2026-10-19 引入的，之前的任务没有这些字段。
  // 老任务当初是「8 步全量执行」，所以补成 final 才是如实还原；
  // 若补成 quick 之类，会让「重跑老任务」少做事却不报错，属于偷偷改变行为。
  if (!task.preset) task.preset = 'final';
  // 任务来源（2026-10-20 片段库引入）：老任务都是普通生成任务
  if (!task.source) task.source = 'generation';
  if (task.hidden === undefined) task.hidden = false;
  if (task.regeneratedFrom === undefined) task.regeneratedFrom = null;
  if (!task.stageSet || typeof task.stageSet !== 'object') {
    // 全量执行：8 个步骤全部为 true
    task.stageSet = {
      prompt_optimize: true,
      storyboard: true,
      clip_generation: true,
      concatenation: true,
      loop_processing: true,
      audio_mix: true,
      transcoding: true,
      final_qc: true
    };
  }
  if (task.stagePlan === undefined) task.stagePlan = null;
  return task;
}

module.exports = { applyTaskDefaults, LEGACY_BGM };
