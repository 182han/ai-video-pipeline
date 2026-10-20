// 真机验证：环境音循环填充 + 两轨叠加
const fs=require('fs'), path=require('path');
const { execSync } = require('child_process');
const config = require('../config');
const mixer = require('../src/processors/audioMixer');
function cap(cmd){ try{return execSync(cmd,{encoding:'utf8',maxBuffer:64*1024*1024});}catch(e){ if(!(e&&(e.code==='EPERM'||/EPERM|EACCES/.test(String(e.message||''))))) return String((e.stdout||'')+(e.stderr||'')); const t=path.join(__dirname,'..','output','_c'+process.pid+'.txt'); try{execSync(cmd+' > "'+t+'" 2>&1',{stdio:'ignore'});}catch(e2){} try{return fs.existsSync(t)?fs.readFileSync(t,'utf8'):'';}finally{try{fs.unlinkSync(t);}catch(e3){}} } }
const shq=p=>'"'+String(p).replace(/"/g,'\\"')+'"';
const dur=p=>parseFloat(cap(shq(config.FFPROBE_PATH)+' -v error -show_entries format=duration -of csv=p=0 '+shq(p)).trim())||0;

(async()=>{
  const outDir=path.join(__dirname,'..','output','verify_tracks_'+Date.now());
  fs.mkdirSync(outDir,{recursive:true});
  const master=path.join(__dirname,'..','output','task_mv4v7qp2_m8r0_master.mp4');
  if(!fs.existsSync(master)){console.log('缺少母版');process.exit(0);}
  const vd=dur(master);
  console.log('母版时长:', vd.toFixed(3)+'s');

  // 关键：环境音 nature_01 只有 48.6s，这里用 35s 母版测试循环路径；
  // 再用一个比母版短的场景验证循环真的生效
  const cases=[
    { name:'只环境音（循环垫底）', opt:{wantMusic:false,wantAmbient:true,ambientTrackId:'nature_01'} },
    { name:'只轻音乐',            opt:{wantMusic:true,wantAmbient:false,defaultTrackId:'calm_01'} },
    { name:'两轨（轻音乐+环境音）', opt:{wantMusic:true,wantAmbient:true,defaultTrackId:'calm_01',ambientTrackId:'nature_01'} }
  ];
  let fail=0;
  for(const c of cases){
    const auto=mixer.buildAutoPlan(vd,c.opt);
    if(!auto.ok){console.log('  FAIL '+c.name+': '+auto.error);fail++;continue;}
    const out=path.join(outDir,'o.mp4');
    try{fs.unlinkSync(out);}catch(e){}
    const r=await mixer.mixBgmPlan(master,out,auto.plan,{});
    if(!r.success){console.log('  FAIL '+c.name+': '+r.error);fail++;continue;}
    const d=dur(out);
    const vol=cap(shq(config.FFMPEG_PATH)+' -hide_banner -nostats -i '+shq(out)+' -af volumedetect -f null - 2>&1');
    const mv=(vol.match(/mean_volume:\s*(-?[\d.]+|-inf)/i)||[])[1];
    const ok=Math.abs(d-vd)<=0.15 && mv && parseFloat(mv)>-85;
    if(!ok)fail++;
    console.log('  '+(ok?'PASS':'FAIL')+'  '+c.name);
    console.log('        dur='+d.toFixed(3)+'s mean='+mv+'dB  段='+auto.plan.music.length+'轻/'+auto.plan.ambient.length+'环');
  }

  // 环境音循环专项：把一段 10s 的环境音铺到 35s 视频上，验证 loop 生效
  console.log('\n=== 循环专测：10s 环境音铺 35s 视频 ===');
  const shortAmb=path.join(outDir,'short.mp3');
  cap(shq(config.FFMPEG_PATH)+' -y -hide_banner -loglevel error -i '+shq(mixer.findTrack('nature_01').filePath)+' -t 10 '+shq(shortAmb));
  // 直接构造 plan（不走库存），验证 filter 层的 loop
  const plan={ music:[], ambient:[{ id:'t', trackId:'nature_01', timelineStart:0, timelineEnd:vd, sourceIn:0, sourceOut:10, volume:1, fadeIn:1, fadeOut:1, speed:1, fillMode:'loop' }] };
  const out2=path.join(outDir,'loop.mp4');
  const r2=await mixer.mixBgmPlan(master,out2,plan,{});
  if(r2.success){
    const d2=dur(out2);
    const vol2=cap(shq(config.FFMPEG_PATH)+' -hide_banner -nostats -i '+shq(out2)+' -af volumedetect -f null - 2>&1');
    const mv2=(vol2.match(/mean_volume:\s*(-?[\d.]+|-inf)/i)||[])[1];
    const ok2=Math.abs(d2-vd)<=0.15 && mv2 && parseFloat(mv2)>-85;
    console.log('  '+(ok2?'PASS':'FAIL')+'  10s 源循环铺满 '+vd.toFixed(1)+'s：dur='+d2.toFixed(3)+'s mean='+mv2+'dB');
    if(!ok2)fail++;
  } else { console.log('  FAIL  循环混音失败: '+r2.error); fail++; }

  console.log('\n'+(fail?'FAIL '+fail:'全部通过'));
  try{fs.rmSync(outDir,{recursive:true,force:true});}catch(e){}
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
