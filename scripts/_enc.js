const BASE='http://127.0.0.1:3001';
(async()=>{
  const list = await (await fetch(BASE+'/api/tasks/completed')).json();
  console.log('=== 标题字符检查 ===');
  for (const t of list.tasks.slice(0,6)) {
    const p = String(t.prompt||'');
    const hasQ = /\?{3,}/.test(p);
    const hasCJK = /[\u4e00-\u9fa5]/.test(p);
    console.log('  ' + t.taskId.padEnd(24) + ' hasQuestionMarks=' + hasQ + ' hasCJK=' + hasCJK + ' :: ' + JSON.stringify(p.slice(0,40)));
  }
  // 检查原始任务 JSON 文件编码
  const fs=require('fs'), path=require('path');
  console.log('\n=== data/tasks 原始文件 ===');
  for (const t of list.tasks.slice(0,5)) {
    const f = path.join(__dirname,'..','data','tasks', t.taskId + '.json');
    if (!fs.existsSync(f)) { console.log('  ' + t.taskId + ' 无本地文件'); continue; }
    const buf = fs.readFileSync(f);
    let utf8ok = true;
    try { new TextDecoder('utf-8',{fatal:true}).decode(buf); } catch(e) { utf8ok = false; }
    const txt = buf.toString('utf8');
    const m = txt.match(/"prompt"\s*:\s*"([^"]{0,40})/);
    console.log('  ' + t.taskId + ' utf8Valid=' + utf8ok + ' prompt=' + JSON.stringify(m?m[1]:''));
  }
})().catch(e=>console.error(e));
