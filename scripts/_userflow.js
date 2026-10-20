// 模拟用户实际操作的完整路径
const BASE='http://127.0.0.1:3001';
(async()=>{
  let fail=0; const check=(c,m)=>{console.log((c?'  PASS  ':'  FAIL  ')+m); if(!c)fail++;};

  console.log('=== 场景1：打开"添加配乐"页面 ===');
  let r = await fetch(BASE+'/bgm-editor.html');
  const html = await r.text();
  check(r.ok, '页面可访问');
  check(html.includes('taskGrid'), '任务卡片容器存在');
  check(html.includes('laneMusic') && html.includes('laneAmbient'), '两条音轨容器存在');
  check(html.includes('decodeAudioData'), '波形解码逻辑存在');

  console.log('\n=== 场景2：编辑器加载任务数据 ===');
  const list = await (await fetch(BASE+'/api/tasks/completed')).json();
  const t = list.tasks[0];
  const det = await (await fetch(BASE+'/api/tasks/'+t.taskId+'/bgm-plan')).json();
  check(!!det.videoUrl, '视频地址: ' + det.videoUrl);
  check(det.totalDuration > 0, '时长: ' + det.totalDuration + 's');
  check('plan' in det && 'result' in det, 'plan/result 字段齐全');

  console.log('\n=== 场景3：自动配乐草稿（编辑器初始填充）===');
  const auto = await (await fetch(BASE+'/api/tasks/'+t.taskId+'/bgm-auto-plan',{method:'POST'})).json();
  check(auto.ok, '草稿生成成功');
  if (auto.ok) {
    console.log('        轻音乐 ' + auto.plan.music.length + ' 段 / 环境音 ' + auto.plan.ambient.length + ' 段');
    check(auto.plan.music.length > 0, '轻音乐至少有 1 段');
    const s = auto.plan.music[0];
    check(s.timelineStart === 0, '首段从 0 秒开始');
    check(s.timelineEnd <= det.totalDuration + 0.1, '不超出成片时长: ' + s.timelineEnd + ' <= ' + det.totalDuration);
  }

  console.log('\n=== 场景4：保存计划 → 重新读取 ===');
  const plan = auto.plan;
  const put = await fetch(BASE+'/api/tasks/'+t.taskId+'/bgm-plan',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({plan})});
  check(put.ok, '保存成功');
  const re = await (await fetch(BASE+'/api/tasks/'+t.taskId+'/bgm-plan')).json();
  check(re.plan && re.plan.music.length === plan.music.length, '读回一致: ' + (re.plan?re.plan.music.length:0) + ' 段');

  console.log('\n=== 场景5：新建任务配乐配置（不实际生成视频）===');
  const bad = await fetch(BASE+'/api/tasks',{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({ prompt:'test', model:'mock', clipCount:1, clipDuration:5, bgm:{enabled:true,mode:'auto',wantMusic:false,wantAmbient:false} })});
  // 全不勾应该仍能创建任务（配乐阶段给出 warning），不应 500
  check(bad.status !== 500, '全不勾选不会导致服务端崩溃 (状态 ' + bad.status + ')');
  if (bad.status === 200) {
    const bj = await bad.json();
    console.log('        已创建测试任务: ' + bj.taskId + '（将自动清理）');
    await fetch(BASE+'/api/tasks/'+bj.taskId, {method:'DELETE'});
  }

  console.log('\n' + (fail ? 'FAIL ' + fail : '全部通过'));
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
