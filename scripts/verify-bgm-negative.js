// 负向验证：证明防护能拦住坏输入（AGENTS.md §5.1 要求缺陷类修复必须有负向证据）
// 端口可配置：默认用项目 .env 的 3001，避免写死端口导致换环境后脚本失效
const BASE = process.env.BGM_TEST_BASE || 'http://127.0.0.1:3001';
const plan = require('../src/processors/bgmPlan');
const TID='task_mukptvrj_xbjn';
let fail=0; const check=(c,m)=>{console.log((c?'  PASS  ':'  FAIL  ')+m); if(!c)fail++;};

(async()=>{
  console.log('=== N1. 非法 plan 结构应被拒绝 ===');
  let r = await fetch(BASE+'/api/tasks/'+TID+'/bgm-plan',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({plan:{music:[],ambient:[]}})});
  check(r.status===400, '空计划返回 400 (实际 '+r.status+')');

  console.log('\n=== N2. 不存在的音轨应被拒绝 ===');
  r = await fetch(BASE+'/api/tasks/'+TID+'/bgm-plan',{method:'PUT',headers:{'content-type':'application/json'},
    body:JSON.stringify({plan:{music:[{trackId:'not_exist',timelineStart:0,timelineEnd:5,sourceIn:0,sourceOut:5}],ambient:[]}})});
  const j2 = await r.json();
  check(r.status===400 && /音轨不存在/.test(j2.error||''), '返回 400 且提示音轨不存在: '+(j2.error||''));

  console.log('\n=== N3. 时间轴终点小于起点应被过滤掉 ===');
  const built = plan.buildMixCommand({ music:[
    {trackId:'calm_01',filePath:'/x.mp3',timelineStart:10,timelineEnd:5,sourceIn:0,sourceOut:5,speed:1,volume:1}
  ]}, 30);
  check(built.ok===false, '全部非法片段 -> 明确失败: '+(built.error||'(未失败，有问题)'));

  console.log('\n=== N4. 变速越界应被拦截 ===');
  const v = plan.validateSegment({trackId:'calm_01',filePath:'/x.mp3',timelineStart:0,timelineEnd:5,speed:9},30);
  check(v.ok===false && /变速/.test(v.reason), '变速 9x 被拒: '+v.reason);

  console.log('\n=== N5. 混音产物静音必须被判失败（不能只看退出码）===');
  const mixer = require('../src/processors/audioMixer');
  const path=require('path'), fs=require('fs'), os=require('os');
  const { execSync } = require('child_process');
  const config = require('../config');
  const out = path.join(__dirname,'..','output','_silent_test.mp4');
  // 造一个静音音轨文件
  const silentMp3 = path.join(__dirname,'..','output','_silent.mp3');
  const cmd = '"'+config.FFMPEG_PATH+'" -y -hide_banner -loglevel error -f lavfi -i anullsrc=r=44100:cl=stereo -t 10 "'+silentMp3+'"';
  try { execSync(cmd,{stdio:'ignore'}); } catch(e){}
  const chk = await mixer.validateMixedOutput(silentMp3).catch(e=>({ok:false,reason:'异常:'+e.message}));
  check(chk.ok===false, '静音文件被判失败: '+chk.reason);
  try{fs.unlinkSync(silentMp3);}catch(e){}

  console.log('\n=== N6. 时长不一致必须被判失败 ===');
  // 用 5s 视频冒充 30s 期望
  const v5 = path.join(__dirname,'..','output','task_mukptvrj_xbjn_master.mp4');
  if (fs.existsSync(v5)) {
    const dc = await mixer.validateMixDuration(v5, 999);
    check(dc.ok===false && /时长异常/.test(dc.reason||''), '时长偏差过大被拒: '+dc.reason);
    const dc2 = await mixer.validateMixDuration(v5, 10.13);
    check(dc2.ok===true, '正常时长通过: '+(dc2.actual||'').toFixed?dc2.actual.toFixed(2):dc2.actual);
  }

  console.log('\n=== N7. 旧逐段接口应返回 410 ===');
  r = await fetch(BASE+'/api/tasks/'+TID+'/clips/0/audio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({trackId:'calm_01'})});
  const j7 = await r.json();
  check(r.status===410 && j7.deprecated===true, '返回 410 deprecated: '+j7.error);

  console.log('\n'+(fail?'FAIL '+fail+' 项':'全部通过（防护有效）'));
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
