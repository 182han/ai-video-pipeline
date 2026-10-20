// 真机验证：把 bgmPlan 生成的滤镜真正交给 ffmpeg 执行
// 注意：本环境 child_process 管道捕获会被沙箱拒绝（spawn EPERM），
// 统一走「重定向到临时文件再读」的降级路径（与 qualityChecker._exec 同思路）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const config = require('../config');
const planner = require('../src/processors/bgmPlan');

const FFMPEG = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = config.FFPROBE_PATH || 'ffprobe';
const BGM_DIR = path.join(__dirname, '..', 'assets', 'bgm');

function execCapture(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (!(e && (e.code === 'EPERM' || /EPERM|EACCES/.test(String(e.message || ''))))) {
      // 非 0 退出（ffmpeg 无输出参数时恒非 0）：合并两路输出后返回，供解析
      return String((e.stdout || '') + (e.stderr || ''));
    }
    const tmp = path.join(__dirname, '..', 'output', `vbgm_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2,8)}.txt`);
    try { execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore' }); } catch (e2) { /* ffmpeg 探测类命令常非 0 退出 */ }
    try { return fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : ''; }
    finally { try { fs.unlinkSync(tmp); } catch (e3) {} }
  }
}

function shq(p) { return '"' + String(p).replace(/"/g, '\\"') + '"'; }
function probeDuration(p) {
  return parseFloat(execCapture(`${shq(FFPROBE)} -v error -show_entries format=duration -of csv=p=0 ${shq(p)}`).trim()) || 0;
}
function meanVolume(p) {
  // volumedetect 把结果打到 stderr；本环境下 stderr 可能从管道或重定向文件两路来，
  // 统一用 execCapture 合并后再匹配，避免只拿到一半输出。
  const out = execCapture(`${shq(FFMPEG)} -hide_banner -nostats -i ${shq(p)} -af volumedetect -f null - 2>&1`);
  const m = String(out).match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i);
  return m ? m[1] : null;
}

// 输出目录必须落在工作区内（沙箱对系统临时目录写入有额外限制），验证完自动清理
const outDir = path.join(__dirname, '..', 'output', 'verify_bgm_' + Date.now());
fs.mkdirSync(outDir, { recursive: true });
const video = path.join(__dirname, '..', 'output', 'task_mv4v7qp2_m8r0_final.mp4');
if (!fs.existsSync(video)) { console.log('缺少测试视频，跳过'); process.exit(0); }
const videoDur = probeDuration(video);
console.log('测试视频时长:', videoDur.toFixed(3), 's');

const music = path.join(BGM_DIR, 'calm', 'comfortable_mystery.mp3');
const ambient = path.join(BGM_DIR, 'nature', 'pixabay_02.mp3');
const music2 = path.join(BGM_DIR, 'calm', 'morning.mp3');

const scenarios = [
  { name: 'S1 单曲覆盖整片（无 aloop / 无 2s 循环）',
    plan: { music: [{ trackId:'calm_01', filePath: music, timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:35, volume:1, fadeIn:2, fadeOut:2, speed:1, fillMode:'none' }] } },
  { name: 'S2 两轨叠加（轻音乐 + 环境音 -18dB）',
    plan: { music: [{ trackId:'calm_01', filePath: music, timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:35, volume:1, fadeIn:2, fadeOut:2, speed:1 }],
            ambient: [{ trackId:'nature_02', filePath: ambient, timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:35, volume:1, fillMode:'none' }] } },
  { name: 'S3 同一素材重复使用（0s 与 20s 各一次）',
    plan: { music: [
      { trackId:'m', filePath: music2, timelineStart:0,  timelineEnd:15, sourceIn:0, sourceOut:15, volume:1, speed:1 },
      { trackId:'m', filePath: music2, timelineStart:20, timelineEnd:35, sourceIn:40, sourceOut:55, volume:1, speed:1 } ] } },
  { name: 'S4 关键帧音量（整段渐弱到 30%）',
    plan: { music: [{ trackId:'m', filePath: music, timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:35, volume:1, keyframes:[{t:0,v:1},{t:35,v:0.3}], speed:1 }] } },
  { name: 'S5 变速保音高 1.5x',
    plan: { music: [{ trackId:'m', filePath: music, timelineStart:0, timelineEnd:23.3, sourceIn:0, sourceOut:35, volume:1, speed:1.5 }] } }
];

let fail = 0;
for (const s of scenarios) {
  const built = planner.buildMixCommand(s.plan, videoDur);
  if (!built.ok) { console.log('  FAIL  ' + s.name + ': ' + built.error); fail++; continue; }
  const out = path.join(outDir, 'out.mp4');
  try { fs.unlinkSync(out); } catch (e) {}
  let cmd = `${shq(FFMPEG)} -y -hide_banner -loglevel error -i ${shq(video)}`;
  for (const t of built.inputTracks) cmd += ` -i ${shq(t)}`;
  cmd += ` -filter_complex ${shq(built.filterComplex)} -map 0:v -map ${shq(built.audioMap)} -c:v copy -c:a aac -t ${videoDur} ${shq(out)}`;
  const log = execCapture(cmd);
  if (!fs.existsSync(out)) { console.log('  FAIL  ' + s.name + '\n        ' + log.slice(0, 400)); fail++; continue; }
  const d = probeDuration(out);
  const mv = meanVolume(out);
  const okDur = Math.abs(d - videoDur) <= 0.15;
  const okVol = mv !== null && parseFloat(mv) > -85;
  const status = (okDur && okVol) ? 'PASS' : 'FAIL';
  if (status === 'FAIL') fail++;
  console.log(`  ${status}  ${s.name}\n        dur=${d.toFixed(3)}s (期望 ${videoDur.toFixed(3)})  mean_volume=${mv}dB`);
  if (log.trim()) console.log('        log: ' + log.trim().slice(0, 300));
}
console.log('\n结果: ' + (scenarios.length - fail) + '/' + scenarios.length + ' 通过');
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
