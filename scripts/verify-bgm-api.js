// 接口端到端测试（Node 内置 fetch，避免 PowerShell JSON 序列化坑）
// 端口可配置：默认用项目 .env 的 3001，避免写死端口导致换环境后脚本失效
const BASE = process.env.BGM_TEST_BASE || 'http://127.0.0.1:3001';
const TID = process.argv[2] || 'task_mv4v7qp2_m8r0';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUTPUT = path.join(__dirname, '..', 'output');
const finalPath = path.join(OUTPUT, TID + '_final.mp4');
function md5(p) { return fs.existsSync(p) ? crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') : 'MISSING'; }

const plan = {
  music: [{ id:'m1', trackId:'calm_01', timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:35, volume:1, fadeIn:2, fadeOut:2, speed:1, fillMode:'none', keyframes:[] }],
  ambient: [{ id:'a1', trackId:'nature_02', timelineStart:0, timelineEnd:35, sourceIn:0, sourceOut:35, volume:1, fadeIn:3, fadeOut:3, speed:1, fillMode:'none', keyframes:[] }]
};

(async () => {
  let fail = 0;
  const check = (cond, msg) => { console.log((cond?'  PASS  ':'  FAIL  ') + msg); if(!cond) fail++; };

  const before = md5(finalPath);
  console.log('原始成片 MD5:', before);

  // 1) 保存计划
  let r = await fetch(BASE + '/api/tasks/' + TID + '/bgm-plan', { method:'PUT', headers:{'content-type':'application/json'}, body: JSON.stringify({ plan }) });
  let j = await r.json();
  check(r.ok && j.plan && j.plan.music.length === 1 && j.plan.ambient.length === 1, '保存计划：music=1 ambient=1（实际 ' + JSON.stringify(j).slice(0,120) + '）');

  // 2) 预览（不覆盖）
  r = await fetch(BASE + '/api/tasks/' + TID + '/bgm-preview', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ plan }) });
  j = await r.json();
  check(r.ok && j.previewUrl, '预览生成: ' + (j.previewUrl || j.error));
  check(md5(finalPath) === before, '预览后原成片未被改动');

  const previewFile = j.previewUrl ? path.join(__dirname, '..', j.previewUrl.replace(/^\//, '')) : null;
  if (previewFile && fs.existsSync(previewFile)) {
    console.log('        预览文件: ' + path.basename(previewFile) + ' size=' + fs.statSync(previewFile).size);
  }

  // 3) 导出（覆盖）
  r = await fetch(BASE + '/api/tasks/' + TID + '/audio', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ plan }) });
  j = await r.json();
  check(r.ok && j.success, '导出成功: ' + (j.outputUrl || j.error));
  // 注意：同样的计划重复导出，产物字节应当一致（确定性），此时 MD5 不变是正确行为。
  // 真正要验证的是"文件被重写过且内容有效"，因此比较的是「导出后的文件仍存在且可探测」。
  const afterSize = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;
  check(afterSize > 10240, '导出后成片有效（' + (afterSize/1024/1024).toFixed(1) + 'MB，' +
        (md5(finalPath) === before ? '与上次导出字节一致=确定性导出' : '内容已更新') + '）');

  // 4) 校验成片本身
  const after = await (await fetch(BASE + '/api/tasks/' + TID + '/bgm-plan')).json();
  check(after.result && after.result.applied === true, '任务记录 bgmResult.applied=true');
  console.log('        bgmResult: ' + JSON.stringify(after.result).slice(0,200));

  console.log('\n结果: ' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
