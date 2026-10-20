// 在 3001 上验证配乐完整链路
const BASE='http://127.0.0.1:3001';
(async()=>{
  let fail=0; const check=(c,m)=>{console.log((c?'  PASS  ':'  FAIL  ')+m); if(!c)fail++;};

  const lib = await (await fetch(BASE+'/api/bgm')).json();
  const music = lib.tracks.filter(t=>t.category==='music');
  const ambient = lib.tracks.filter(t=>t.category==='ambient');
  check(music.length>0 && ambient.length>0, '库存: 轻音乐 '+music.length+' / 环境音 '+ambient.length);

  const list = await (await fetch(BASE+'/api/tasks/completed')).json();
  check(list.total>0, '已完成任务 '+list.total+' 个');

  const target = list.tasks.find(t=>t.taskId==='task_mv4v7qp2_m8r0') || list.tasks[0];
  const detail = await (await fetch(BASE+'/api/tasks/'+target.taskId+'/bgm-plan')).json();
  check(!!detail.videoUrl, '任务 '+target.taskId+' 成片可访问: '+detail.videoUrl);

  // 双轨计划：轻音乐 + 环境音
  const plan = {
    music: [{ id:'m1', trackId: music[0].id, timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:35, volume:1, fadeIn:2, fadeOut:2, speed:1, fillMode:'none', keyframes:[] }],
    ambient: [{ id:'a1', trackId: ambient[0].id, timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:Math.min(35, ambient[0].durationSec||35), volume:1, fadeIn:2, fadeOut:2, speed:1, fillMode:'loop', keyframes:[] }]
  };
  const pv = await fetch(BASE+'/api/tasks/'+target.taskId+'/bgm-preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({plan})});
  const pj = await pv.json();
  check(pv.ok && pj.previewUrl, '双轨预览生成: '+(pj.previewUrl||pj.error)+' ('+(pj.duration||0).toFixed(2)+'s)');

  // 自动配乐草稿（带勾选）
  const ap = await fetch(BASE+'/api/tasks/'+target.taskId+'/bgm-auto-plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});
  const aj = await ap.json();
  check(aj.ok && aj.plan, '自动配乐草稿: '+(aj.ok?(aj.plan.music.length+' 轻 / '+aj.plan.ambient.length+' 环'):aj.error));

  console.log('\n'+(fail?'FAIL '+fail:'全部通过'));
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
