const fs=require('fs');
const dom=fs.readFileSync('output/_dom2.html','utf8');
const m = dom.match(/<div id="listView"[\s\S]{0,600}/);
console.log(m ? m[0] : 'not found');
console.log('\n=== .hint 样式 ===');
const h = dom.match(/\.hint\s*\{[^}]*\}/);
console.log(h ? h[0] : 'not found');
