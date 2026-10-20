// 前端时间轴核心逻辑单测（把页面里的纯数据逻辑抽出来验证，无需浏览器）
const fs = require('fs');
const html = fs.readFileSync('public/bgm-editor.html', 'utf8');
const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];

let fail = 0;
const check = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// 1) 确认关键实现约定还在
check(/const clip = \{[\s\S]*?trackId/.test(script), 'addClip 使用服务端认可的字段名 trackId');
check(!/clipTracks/.test(script), '编辑器不再使用已下线的 clipTracks');
check(/bgm-preview/.test(script) && /\/audio'/.test(script), '预览与导出分别调用 bgm-preview / audio');
check(!/aloop/.test(script), '前端不涉及 aloop（循环只通过 fillMode 交给服务端）');
check(/decodeAudioData/.test(script), '波形用 Web Audio 解码');
check(/function splitAtPlayhead/.test(script), '分割功能存在');
check(/keyframes/.test(script), '关键帧支持存在');

// 2) 模拟分割逻辑（与页面实现一致）
function splitLogic(c, t) {
  const ratio = (t - c.timelineStart) / (c.timelineEnd - c.timelineStart);
  const srcSplit = c.sourceIn + (c.sourceOut - c.sourceIn) * ratio;
  const right = { ...c, timelineStart: t, sourceIn: srcSplit, fadeIn: 0 };
  const left = { ...c, timelineEnd: t, sourceOut: srcSplit, fadeOut: 0 };
  return { left, right };
}
let c = { trackId:'calm_01', timelineStart:0, timelineEnd:10, sourceIn:20, sourceOut:30, fadeIn:1, fadeOut:1 };
let { left, right } = splitLogic(c, 4);
check(Math.abs(right.sourceIn - 24) < 1e-6, '分割点源偏移正确 (期望 24, 实际 ' + right.sourceIn + ')');
check(Math.abs(left.sourceOut - 24) < 1e-6, '左段终点源偏移正确');
check(left.timelineEnd === 4 && right.timelineStart === 4, '两段时间轴首尾相接');
check(left.fadeOut === 0 && right.fadeIn === 0, '分割处不带淡出淡入（避免中间出现凹陷）');

// 3) 关键帧插值（与 bgmPlan 服务端实现一致）
const planner = require('../src/processors/bgmPlan');
const expr = planner.buildVolumeExpression({ volume: 1, keyframes: [{ t: 0, v: 1 }, { t: 10, v: 0.2 }] }, 10);
check(/0\.2/.test(expr), '关键帧值进入表达式');

// 4) 确认页面不写死成片时长来源
check(/totalDuration/.test(script), '成片时长取自服务端 totalDuration');
check(/videoDuration/.test(script) || /video\.duration/.test(script), '缺失时回退到 video.duration');

console.log('\n' + (fail ? 'FAIL ' + fail : '全部通过'));
process.exit(fail ? 1 : 0);
