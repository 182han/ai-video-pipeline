const fs = require('fs');
const vm = require('vm');
for (const file of ['public/index.html', 'public/bgm-editor.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  let bad = 0;
  scripts.forEach((s, i) => { try { new vm.Script(s); } catch (e) { bad++; console.log(file + ' 块' + i + ': ' + e.message); } });
  console.log(file + ': ' + (bad === 0 ? 'PASS (' + scripts.length + ' 块)' : 'FAIL'));
}
