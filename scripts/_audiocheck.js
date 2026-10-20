const BASE='http://127.0.0.1:3001';
(async()=>{
  let fail=0; const check=(c,m)=>{console.log((c?'  PASS  ':'  FAIL  ')+m); if(!c)fail++;};
  const lib = await (await fetch(BASE+'/api/bgm')).json();
  console.log('=== 波形加载所需的音频文件可达性 ===');
  for (const t of lib.tracks.slice(0,4)) {
    const url = BASE + '/bgm/' + t.file.replace(/^\//,'');
    const r = await fetch(url, { method:'GET', headers:{ Range:'bytes=0-1023' } });
    const len = (await r.arrayBuffer()).byteLength;
    check(r.ok || r.status===206, t.id + ' -> ' + r.status + ' (' + len + 'B, ' + (r.headers.get('content-type')||'') + ')');
  }
  // 全部 12 轨
  let reach = 0;
  for (const t of lib.tracks) {
    const r = await fetch(BASE + '/bgm/' + t.file.replace(/^\//,''), { headers:{ Range:'bytes=0-99' } });
    if (r.ok || r.status===206) reach++;
  }
  check(reach === lib.tracks.length, '全部 ' + reach + '/' + lib.tracks.length + ' 轨音频可加载');
  console.log('\n' + (fail ? 'FAIL ' + fail : '全部通过'));
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
