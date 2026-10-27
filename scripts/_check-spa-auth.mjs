// 对 server.js 里新加的「SPA 路由是否算页面」判定做穷举断言。
// 只复制判定表达式，不启服务、不读写任何数据目录。
const SPA_ASSET = /^\/app\/(vendor|src|styles|assets)\//;

function isSpaRoute(p) {
  return (p === '/app' || p === '/app/') || (p.startsWith('/app/') && !SPA_ASSET.test(p));
}
function isPage(p) {
  return p === '/' || p.endsWith('.html') || isSpaRoute(p);
}
// 判定为页面 → 未登录时 302 到登录页；否则放行（静态资源）
function gate(p) {
  return isPage(p) ? 'REDIRECT' : 'PASS';
}

const cases = [
  // [路径, 期望]
  ['/', 'REDIRECT'],
  ['/index.html', 'REDIRECT'],
  ['/login.html', 'REDIRECT'],            // 登录页自身在中间件前面已单独特判放行，这里只管"算不算页面"
  ['/bgm-editor.html', 'REDIRECT'],

  ['/app', 'REDIRECT'],                   // 新版根
  ['/app/', 'REDIRECT'],
  ['/app/create', 'REDIRECT'],            // ★ 旧实现会 PASS（绕过登录墙）
  ['/app/review', 'REDIRECT'],
  ['/app/output/abc', 'REDIRECT'],
  ['/app/a/b/c', 'REDIRECT'],

  ['/app/vendor/react.production.min.js', 'PASS'],
  ['/app/src/app.js', 'PASS'],
  ['/app/styles/app.css', 'PASS'],
  ['/app/assets/poster.jpg', 'PASS'],

  ['/output/x.mp4', 'PASS'],
  ['/clips/x.mp4', 'PASS'],
  ['/bgm/x.mp3', 'PASS'],
  ['/showcase/night-valley-loop.mp4', 'PASS'],
  ['/api/status', 'PASS']                 // API 由前一分支处理，不算页面
];

let fail = 0;
for (const [p, want] of cases) {
  const got = gate(p);
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + p.padEnd(40) + ' got=' + got + ' want=' + want);
}

console.log('\n' + (fail ? 'FAIL ' + fail : '全部通过') + ' (' + cases.length + ' 例)');
process.exit(fail ? 1 : 0);
