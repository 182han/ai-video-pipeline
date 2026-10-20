// 真机验证：整片多轨混音（跨曲衔接 / 两轨叠加 / 关键帧 / 变速）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const config = require('../config');
const mixer = require('../src/processors/audioMixer');

const FFMPEG = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = config.FFPROBE_PATH || 'ffprobe';
function cap(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 64*1024*1024 }); }
  catch (e) {
    if (!(e && (e.code === 'EPERM' || /EPERM|EACCES/.test(String(e.message||''))))) return String((e.stdout||'')+(e.stderr||''));
    const tmp = path.join(__dirname,'..','output','_cap_'+process.pid+'_'+Date.now()+'.txt');
    try { execSync(cmd + ' > "' + tmp + '" 2>&1', { stdio:'ignore' }); } catch(e2){}
    try { return fs.existsSync(tmp) ? fs.readFileSync(tmp,'utf8') : ''; } finally { try{fs.unlinkSync(tmp);}catch(e3){} }
  }
}
const shq = p => '"' + String(p).replace(/"/g,'\\"') + '"';
const dur = p => parseFloat(cap(shq(FFPROBE)+' -v error -show_entries format=duration -of csv=p=0 '+shq(p)).trim())||0;

(async () => {
  const outDir = path.join(__dirname,'..','output','verify_bgmplans_'+Date.now());
  fs.mkdirSync(outDir,{recursive:true});
  const video = path.join(__dirname,'..','output','task_mv4v7qp2_m8r0_final.mp4');
  const vd = dur(video);
  console.log('测试视频:', vd.toFixed(3)+'s');

  const B = id => mixer.findTrack(id).filePath;
  const cases = [
    { name:'A1 自动配乐计划（35s，默认开场曲 calm_01）',
      plan: mixer.buildAutoPlan(vd, { defaultTrackId:'calm_01' }) },
    { name:'A2 两轨叠加：轻音乐 + 环境音(-18dB)',
      plan: { ok:true, plan:{ music:[{id:'m',trackId:'calm_01',timelineStart:0,timelineEnd:vd,sourceIn:0,sourceOut:vd,volume:1,fadeIn:2,fadeOut:2,speed:1,fillMode:'none'}],
                              ambient:[{id:'a',trackId:'nature_02',timelineStart:0,timelineEnd:vd,sourceIn:0,sourceOut:vd,volume:1,speed:1,fillMode:'none'}] } } },
    { name:'A3 关键帧音量（渐弱到 30%）',
      plan: { ok:true, plan:{ music:[{id:'k',trackId:'calm_01',timelineStart:0,timelineEnd:vd,sourceIn:0,sourceOut:vd,volume:1,keyframes:[{t:0,v:1},{t:vd,v:0.3}],speed:1}] } } },
    { name:'A4 变速保音高 1.5x',
      plan: { ok:true, plan:{ music:[{id:'s',trackId:'calm_02',timelineStart:0,timelineEnd:vd,sourceIn:0,sourceOut:vd/1.5,volume:1,speed:1.5}] } } },
    { name:'A5 同一素材重复使用（两处）',
      plan: { ok:true, plan:{ music:[
        {id:'r1',trackId:'calm_02',timelineStart:0,timelineEnd:15,sourceIn:0,sourceOut:15,volume:1,speed:1},
        {id:'r2',trackId:'calm_02',timelineStart:20,timelineEnd:vd,sourceIn:60,sourceOut:75,volume:1,speed:1}] } } }
  ];

  let fail=0;
  for (const c of cases) {
    if (!c.plan.ok) { console.log('  FAIL '+c.name+': '+c.plan.error); fail++; continue; }
    const out = path.join(outDir,'o.mp4');
    try{fs.unlinkSync(out);}catch(e){}
    const r = await mixer.mixBgmPlan(video, out, c.plan.plan, {});
    if (!r.success) { console.log('  FAIL '+c.name+': '+r.error); fail++; continue; }
    const d = dur(out);
    const vol = cap(shq(FFMPEG)+' -hide_banner -nostats -i '+shq(out)+' -af volumedetect -f null - 2>&1')
      .match(/mean_volume:\s*(-?[\d.]+|-inf)/i);
    const mv = vol ? vol[1] : null;
    const ok = Math.abs(d-vd)<=0.15 && mv !== null && parseFloat(mv) > -85;
    if(!ok) fail++;
    console.log('  '+(ok?'PASS':'FAIL')+'  '+c.name);
    console.log('        dur='+d.toFixed(3)+'s mean='+mv+'dB'+(r.warnings&&r.warnings.length?(' warn='+r.warnings.length):''));
  }
  console.log('\n结果: '+(cases.length-fail)+'/'+cases.length+' 通过');
  try{fs.rmSync(outDir,{recursive:true,force:true});}catch(e){}
  process.exit(fail?1:0);
})();
