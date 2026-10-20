// 全站页面与接口自检
const BASE = 'http://127.0.0.1:3001';
(async () => {
  const issues = [];
  const ok = [];
  const check = async (name, fn) => {
    try { const r = await fn(); if (r) ok.push(name + ' — ' + r); else issues.push(name + ' — 返回空'); }
    catch (e) { issues.push(name + ' — ' + e.message); }
  };

  await check('首页', async () => { const r = await fetch(BASE + '/'); if (!r.ok) throw new Error(r.status); return r.status + ' ' + (await r.text()).length + 'B'; });
  await check('配乐编辑器页面', async () => { const r = await fetch(BASE + '/bgm-editor.html'); if (!r.ok) throw new Error(r.status); return r.status; });
  await check('配乐库存页面', async () => { const r = await fetch(BASE + '/music-library.html'); if (!r.ok) throw new Error(r.status); return r.status; });
  await check('GET /api/status', async () => { const j = await (await fetch(BASE + '/api/status')).json(); return 'ffmpeg=' + j.ffmpegAvailable; });
  await check('GET /api/bgm', async () => { const j = await (await fetch(BASE + '/api/bgm')).json(); return j.total + ' 轨'; });
  await check('GET /api/tasks/completed', async () => { const j = await (await fetch(BASE + '/api/tasks/completed')).json(); return j.total + ' 个'; });
  await check('GET /api/themes', async () => { const j = await (await fetch(BASE + '/api/themes')).json(); return (j.themes || j).length + ' 个主题'; });
  await check('GET /api/qc-items', async () => { const j = await (await fetch(BASE + '/api/qc-items')).json(); return j.qcItems.length + ' 项质检'; });
  await check('GET /api/rules', async () => { const j = await (await fetch(BASE + '/api/rules')).json(); return j.rules ? 'ok' : 'empty'; });
  await check('GET /api/trash', async () => { const j = await (await fetch(BASE + '/api/trash')).json(); return Array.isArray(j) ? j.length + ' 项' : 'ok'; });

  // 关键：任务详情页要能拿到 bgm 字段
  await check('任务详情含 bgm 字段', async () => {
    const list = await (await fetch(BASE + '/api/tasks/completed')).json();
    const t = list.tasks[0];
    const d = await (await fetch(BASE + '/api/tasks/' + t.taskId)).json();
    if (!('bgm' in d)) throw new Error('缺少 bgm 字段');
    if (!('bgmPlan' in d)) throw new Error('缺少 bgmPlan 字段');
    return t.taskId + ' bgm=' + (d.bgm ? 'yes' : 'null');
  });

  await check('进度接口含 bgm', async () => {
    const list = await (await fetch(BASE + '/api/tasks/completed')).json();
    const p = await (await fetch(BASE + '/api/tasks/' + list.tasks[0].taskId + '/progress')).json();
    if (!('bgm' in p)) throw new Error('progress 缺 bgm');
    return 'ok';
  });

  console.log('=== 通过 ===');
  ok.forEach(x => console.log('  OK   ' + x));
  if (issues.length) { console.log('\n=== 问题 ==='); issues.forEach(x => console.log('  BAD  ' + x)); }
  console.log('\n' + (issues.length ? issues.length + ' 个问题' : '无问题'));
  process.exit(issues.length ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
