const fs = require('fs');
const html = fs.readFileSync('public/bgm-editor.html', 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];

const refs = [...script.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
const missing = [...new Set(refs)].filter(r => !ids.has(r));
console.log('页内 id 数量:', ids.size, '| 脚本引用 id 数量:', new Set(refs).size);
console.log(missing.length ? 'FAIL 缺少 id: ' + missing.join(', ') : 'PASS 所有 $() 引用的元素都存在');

const fns = new Set([...script.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
const evtRe = /on(?:click|input|change)="([A-Za-z_$][\w$]*)\(/g;
const refsMarkup = [...html.matchAll(evtRe)].map(m => m[1]);
const undef = [...new Set(refsMarkup)].filter(f => !fns.has(f));
console.log('内联事件引用函数:', [...new Set(refsMarkup)].join(', '));
console.log(undef.length ? 'FAIL 未定义的处理函数: ' + undef.join(', ') : 'PASS 所有内联事件处理函数都已定义');

const localLet = new Set([...script.matchAll(/^(?:let|const)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]));
console.log('顶层 let/const:', [...localLet].join(', '));
process.exit(missing.length || undef.length ? 1 : 0);