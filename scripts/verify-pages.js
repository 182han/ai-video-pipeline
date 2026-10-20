// 端口可配置：默认用项目 .env 的 3001，避免写死端口导致换环境后脚本失效
const BASE = process.env.BGM_TEST_BASE || 'http://127.0.0.1:3001';
(async()=>{
  let fail=0; const check=(c,m)=>{console.log((c?'  PASS  ':'  FAIL  ')+m); if(!c)fail++;};
  // pages served
  for (const p of ['/bgm-editor.html','/music-library.html','/clip-library.html','/']) {
    const r = await fetch(BASE+p); const t = await r.text();
    check(r.ok && t.length>1000, 'GET '+p+' -> '+r.status+' '+t.length+'B');
  }
  // auto plan endpoint
  const r = await fetch(BASE+'/api/tasks/task_mv4v7qp2_m8r0/bgm-auto-plan',{method:'POST'});
  const j = await r.json();
  check(j.ok && j.plan && j.plan.music.length>0, '自动配乐草稿: 段数='+(j.plan?j.plan.music.length:'-')+' 曲目='+(j.plan?j.plan.music.map(s=>s.trackId).join('→'):'-'));
  console.log('\n'+(fail?'FAIL '+fail:'全部通过'));
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
