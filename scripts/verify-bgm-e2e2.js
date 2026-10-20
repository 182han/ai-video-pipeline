const BASE='http://127.0.0.1:3100';
const fs=require('fs'), path=require('path');
const { execSync } = require('child_process');
const config = require('../config');
function cap(cmd){ try{return execSync(cmd,{encoding:'utf8',maxBuffer:64*1024*1024});}catch(e){ if(!(e&&(e.code==='EPERM'||/EPERM|EACCES/.test(String(e.message||''))))) return String((e.stdout||'')+(e.stderr||'')); const t=path.join(__dirname,'..','output','_c'+process.pid+'.txt'); try{execSync(cmd+' > "'+t+'" 2>&1',{stdio:'ignore'});}catch(e2){} try{return fs.existsSync(t)?fs.readFileSync(t,'utf8'):'';}finally{try{fs.unlinkSync(t);}catch(e3){}} } }
const shq=p=>'"'+String(p).replace(/"/g,'\\"')+'"';
const TID = process.argv[2] || 'task_mukptvrj_xbjn';

(async()=>{
  let fail=0; const check=(c,m)=>{console.log((c?'  PASS  ':'  FAIL  ')+m); if(!c)fail++;};
  const t0 = await (await fetch(BASE+'/api/tasks/'+TID)).json();
  console.log('任务:', TID, '| 状态', t0.status, '| 时长', t0.totalDuration, '| 有 master:', !!t0.masterPath);
  console.log('成功片段:', (t0.clips||[]).filter(c=>c.status==='success').length);

  const auto = await (await fetch(BASE+'/api/tasks/'+TID+'/bgm-auto-plan',{method:'POST'})).json();
  check(auto.ok, '自动草稿生成: ' + (auto.ok ? auto.plan.music.length+' 段 ['+auto.plan.music.map(s=>s.trackId).join('→')+']' : auto.error));
  if (!auto.ok) { process.exit(1); }

  console.log('\n  正在导出（历史任务需先重建无声母版）…');
  const exp = await fetch(BASE+'/api/tasks/'+TID+'/audio', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ plan: auto.plan }) });
  const er = await exp.json();
  check(exp.ok && er.success, '导出: ' + (er.outputUrl || er.error));

  if (er.success) {
    const after = await (await fetch(BASE+'/api/tasks/'+TID)).json();
    check(!!after.masterPath, '无声母版已建立: ' + (after.masterPath?path.basename(after.masterPath):'-'));
    const f = after.outputPath;
    const probe = JSON.parse(cap(shq(config.FFPROBE_PATH)+' -v error -show_entries format=duration:stream=codec_type,sample_rate,channels -of json '+shq(f))||'{}');
    const aud = (probe.streams||[]).find(s=>s.codec_type==='audio');
    const dur = probe.format?parseFloat(probe.format.duration):0;
    check(!!aud, '成片含音频 (rate='+(aud&&aud.sample_rate)+' ch='+(aud&&aud.channels)+')');
    check(Math.abs(dur - (after.totalDuration||0)) < 0.5, '时长一致: 记录 '+after.totalDuration+'s / 实测 '+dur.toFixed(2)+'s');
    const vol = cap(shq(config.FFMPEG_PATH)+' -hide_banner -nostats -i '+shq(f)+' -af volumedetect -f null - 2>&1');
    const mv=(vol.match(/mean_volume:\s*(-?[\d.]+|-inf)/i)||[])[1];
    check(mv!==undefined&&parseFloat(mv)>-85,'有声 mean='+mv+'dB maxraw');
    const mx=(vol.match(/max_volume:\s*(-?[\d.]+|-inf)/i)||[])[1];
    console.log('        max=' + mx + 'dB (应 <= 0，避免削波)');
    check(parseFloat(mx) <= 0.1, '无削波');
    console.log('        bgmResult=' + JSON.stringify(after.bgmResult).slice(0,160));
  }
  console.log('\n'+(fail?'FAIL '+fail:'全部通过'));
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
