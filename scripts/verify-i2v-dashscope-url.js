// ============================================================
// wan3.0 图生视频：DashScope 临时上传（oss://）离线验收
//
// 官方临时上传：GET /api/v1/uploads?action=getPolicy&model=...
//   → POST upload_host (multipart) → oss://...
// 视频请求必须带 X-DashScope-OssResourceResolve: enable。
//
// 全程本地 stub，零真实网络/零计费。
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const photoLibrary = require('../src/photoLibrary');
const pipeline = require('../src/pipeline');
const dashscopeUpload = require('../src/generators/dashscopeUpload');
const DashScopeGenerator = require('../src/generators/dashscope');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}

(async () => {
  console.log('================================================================');
  console.log('wan3.0 图生视频：DashScope 临时上传离线验收');
  console.log('================================================================');

  const photo = photoLibrary.listAll().find(p => p.status === 'approved' && p.filePath && fs.existsSync(p.filePath));
  if (!photo) {
    console.log('  ⚠ 没有 approved 图片，跳过');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    return;
  }

  let port = 0;
  const uploads = [];
  const submissions = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/v1/uploads')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          policy: 'p', signature: 's', upload_dir: 'dashscope-instant/stub',
          upload_host: `http://127.0.0.1:${port}/upload`,
          oss_access_key_id: 'id', x_oss_object_acl: 'private',
          x_oss_forbid_overwrite: 'true', expire_in_seconds: 300
        }
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      let n = 0;
      req.on('data', (c) => { n += c.length; });
      req.on('end', () => {
        uploads.push({ bytes: n, contentType: req.headers['content-type'] || '' });
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    if (req.method === 'POST' && req.url.includes('/services/aigc/video-generation/video-synthesis')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { submissions.push({ body: JSON.parse(raw), headers: req.headers }); }
        catch (e) { submissions.push({ raw, headers: req.headers }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ output: { task_id: 'stub-task' } }));
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1) 上传模块
    const up = await dashscopeUpload.uploadFile(photo.filePath, {
      apiKey: 'stub-key', baseUrl, model: 'wan3.0-video'
    });
    ok(up.url.startsWith('oss://dashscope-instant/stub/'), 'A. 返回 oss:// 临时地址', up.url);
    ok(uploads.length === 1 && uploads[0].bytes > 100, 'B. multipart 已上传到临时 OSS', `bytes=${uploads[0] && uploads[0].bytes}`);

    // 2) 视频请求头 + media
    const gen = new DashScopeGenerator({ apiKey: 'stub-key', baseUrl, modelId: 'wan3.0-video' });
    const r = await gen.generate('test', { image: { url: up.url }, duration: 5 });
    ok(r.taskId === 'stub-task', 'C. 提交返回 taskId');
    const s = submissions[submissions.length - 1];
    const media = s.body && s.body.input && s.body.input.media;
    ok(media && media[0] && media[0].type === 'first_frame' && media[0].url === up.url,
      'D. 请求体 first_frame = oss://', JSON.stringify(media));
    ok(String(s.headers['x-dashscope-ossresourceresolve'] || '') === 'enable',
      'E. 带 X-DashScope-OssResourceResolve: enable');

    // 3) pipeline 每片段取图走临时上传
    const payload = await pipeline._i2vPayload(
      { taskId: 't', model: 'dashscope', runtimeConfig: { apiKey: 'stub-key', apiBaseUrl: baseUrl, modelId: 'wan3.0-video' } },
      { photoId: photo.id }
    );
    ok(payload && payload.url && payload.url.startsWith('oss://') && payload.urlProtocol === 'oss',
      'F. pipeline 返回 oss:// + urlProtocol=oss', JSON.stringify({ url: payload && payload.url, p: payload && payload.urlProtocol }));

    // 4) 只有 base64 时明确报错
    let threw = null;
    try { await gen.generate('test', { image: { base64: 'AAAA' } }); } catch (e) { threw = e; }
    ok(threw && /公网|oss|URL/i.test(threw.message), 'G. 无 url 时明确报错', threw && threw.message);
  } finally {
    server.close();
  }

  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
