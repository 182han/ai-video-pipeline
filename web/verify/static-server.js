// 只读静态验收服务：只发 app/web，接口（除 /api/status 探针）一律 404。
// 给「真浏览器验收」用，绝不碰真实后端 / 数据库 / 计费接口。
// 用法：node web/verify/static-server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 3017);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  const url = String(req.url || '/').split('?')[0];
  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, imageGen: { configured: false }, staticProbe: true }));
  }
  if (/^\/api\//.test(url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"error":"静态验收：接口不可用"}');
  }
  if (!url.startsWith('/app')) {
    res.writeHead(302, { Location: '/app' });
    return res.end();
  }
  let rel = decodeURIComponent(url.slice(4)) || '/';
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(WEB, rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  res.end(fs.readFileSync(file));
}).listen(PORT, '127.0.0.1', () => {
  console.log('static verify server: http://127.0.0.1:' + PORT + '/app');
});
