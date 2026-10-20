const fs=require('fs');
const dom=fs.readFileSync('output/_dom3.html','utf8');
console.log('listView display:', /id="listView"[^>]*style="([^"]*)"/.exec(dom) ? RegExp.$1 : '(no inline style)');
console.log('editorView class:', /id="editorView" class="([^"]*)"/.exec(dom) ? RegExp.$1 : '(none)');
console.log('clip count in music lane:', (dom.match(/laneMusic"[\s\S]*?<\/div>\s*<\/div>/)?.[0].match(/class="clip /g)||[]).length);
const lanc = /id="laneMusic"[\s\S]{0,800}/.exec(dom);
console.log('\nlaneMusic snippet:');
console.log(lanc?lanc[0].slice(0,600):'none');
