const fs=require('fs'), vm=require('vm');
const html=fs.readFileSync('public/bgm-editor.html','utf8');
const m=/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html);
const src=m[1];
const startLine = html.slice(0,m.index).split('\n').length;
try { new vm.Script(src,{filename:'e.js',lineOffset:startLine}); console.log('OK'); }
catch(e){ console.log('ERR:',e.message); const mm=/e\.js:(\d+)/.exec(e.stack||''); if(mm){ const ln=parseInt(mm[1],10); const lines=html.split('\n'); for(let i=Math.max(1,ln-10);i<=Math.min(lines.length,ln+4);i++) console.log(i+'\t'+lines[i-1]); } }