const BASE='http://127.0.0.1:3001';
(async()=>{
  const list = await (await fetch(BASE+'/api/tasks/completed')).json();
  console.log('任务 | status | 有bgm | 有bgmPlan | 有bgmResult');
  for (const t of list.tasks) {
    const d = await (await fetch(BASE+'/api/tasks/'+t.taskId)).json();
    console.log('  ' + t.taskId.padEnd(24) + ' | ' + String(d.status).padEnd(9) +
      ' | ' + ('bgm' in d ? 'Y' : 'N') + ' | ' + ('bgmPlan' in d ? 'Y' : 'N') + ' | ' + ('bgmResult' in d ? 'Y' : 'N'));
  }
})().catch(e=>console.error(e));
