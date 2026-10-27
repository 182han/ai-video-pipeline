// 只挂载 /app 的静态与 SPA 兜底，不加载登录墙、不碰 data/、不跑 reconcile。
// 目的：单独验证 express 路由与 web/ 文件是否可服务。
const path = require('path');
const express = require('express');

const app = express();
const WEB = path.join(__dirname, '..', 'web');

app.use('/app', express.static(WEB, {
  index: false,
  redirect: false,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css|mp4|jpg|png)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

app.get(/^\/app(\/.*)?$/, (req, res, next) => {
  if (/^\/app\/(vendor|src|styles|assets)\//.test(req.path)) return next();
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(WEB, 'index.html'));
});

const srv = app.listen(3102, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:3102';
  const targets = [
    '/app',
    '/app/',
    '/app/create',
    '/app/review',
    '/app/output',
    '/app/vendor/react.production.min.js',
    '/app/vendor/react-dom.production.min.js',
    '/app/vendor/htm.umd.js',
    '/app/src/app.js',
    '/app/src/router.js',
    '/app/src/screens/workbench.js',
    '/app/src/components/taskDrawer.js',
    '/app/src/components/assistant.js',
    '/app/src/components/boundary.js',
    '/app/src/store.js',
    '/app/styles/app.css',
    '/app/assets/poster-2k.jpg',
    '/app/nope/deep/route'
  ];
  let fail = 0;
  for (const t of targets) {
    try {
      const r = await fetch(base + t, { redirect: 'manual' });
      const buf = await r.arrayBuffer();
      const ok = r.status === 200 && buf.byteLength > 0;
      if (!ok) fail++;
      console.log((ok ? 'OK  ' : 'BAD ') + String(r.status).padEnd(4) + String(buf.byteLength).padStart(8) + '  ' + t);
    } catch (e) {
      fail++;
      console.log('ERR ' + t + ' -> ' + e.message);
    }
  }
  console.log('\n' + (fail ? 'FAIL ' + fail : '全部通过'));
  srv.close(() => process.exit(fail ? 1 : 0));
});
