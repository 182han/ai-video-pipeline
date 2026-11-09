// ============================================================
// OpenAI 兼容出图适配器验收（openai-images）
// ------------------------------------------------------------
// 背景（2026-11-09）：WhaleTV 中转是 OpenAI 兼容协议（POST /v1/images/generations
// 一次返回 data[0].url），与百炼原生「提交任务→轮询」不同，需要单独适配器。
// 本脚本用本地 stub 起假接口，覆盖：成功（url / b64 / metadata 包装）、参数
// （size 1696*960 → 1696x960）、同名不覆盖，以及四类负向：
//   401 鉴权失败 / 200-but-HTML（地址填成网页）/ 200-but-无图片数据 / 下载到非图片。
// 不联网、不花钱。用法：node scripts/verify-image-gen-compat.js
// ============================================================
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.COMPAT_STUB_PORT || 3912);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastPost = null;

function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
        if (req.url === '/img.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(PNG);
        }
        if (req.url === '/notimage.png') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>not an image</html>');
        }
        if (req.url.startsWith('/ok/images/generations')) {
          lastPost = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ created: 1, data: [{ url: `${BASE}/img.png` }] }));
        }
        if (req.url.startsWith('/b64/images/generations')) {
          lastPost = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG.toString('base64') }] }));
        }
        if (req.url.startsWith('/wrapped/images/generations')) {
          lastPost = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            created: 1, data: [],
            metadata: { output: { choices: [{ message: { content: [{ image: `${BASE}/img.png`, type: 'image' }] } }] } }
          }));
        }
        if (req.url.startsWith('/e401/images/generations')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Invalid token' } }));
        }
        if (req.url.startsWith('/html/images/generations')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<!doctype html><html>app shell</html>');
        }
        if (req.url.startsWith('/nodata/images/generations')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ created: 1, data: [] }));
        }
        if (req.url.startsWith('/badimg/images/generations')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ created: 1, data: [{ url: `${BASE}/notimage.png` }] }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid URL (' + req.method + ' ' + req.url + ')' } }));
      });
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  console.log('================================================================');
  console.log('OpenAI 兼容出图适配器验收（openai-images，本地 stub）');
  console.log('================================================================');

  require(path.join(ROOT, 'src', 'generators', 'imageProviders', 'index.js'));
  const { listImageProviders, getImageGenStatus } = require(path.join(ROOT, 'src', 'generators', 'imageGen.js'));
  const adapter = require(path.join(ROOT, 'src', 'generators', 'imageProviders', 'openaiCompatible.js'));

  check(listImageProviders().includes('openai-images'), '适配器已注册（openai-images)', listImageProviders().join(','));

  const srv = await startStub();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat_out_'));
  const cfg = (extra = {}) => ({
    IMAGE_GEN_PROVIDER: 'openai-images',
    IMAGE_GEN_API_KEY: 'sk-test-compat',
    IMAGE_GEN_BASE_URL: BASE + '/ok',
    IMAGE_GEN_MODEL: 'wan2.7-image',
    IMAGE_GEN_SIZE: '1696*960',
    IMAGE_GEN_TIMEOUT_MS: 15000,
    ...extra
  });

  try {
    // ---------- 正向 1：url 返回 ----------
    const r1 = await adapter({ prompt: '雪山日出', options: { outDir, taskId: 'compat1', index: 0 }, config: cfg() });
    check(fs.existsSync(r1.imagePath) && fs.statSync(r1.imagePath).size > 8, 'url 模式：落盘文件存在且非空');
    check(r1.width === 1 && r1.height === 1, 'url 模式：宽高来自真实字节（1x1）', `${r1.width}x${r1.height}`);
    check(r1.provider === 'openai-images' && r1.model === 'wan2.7-image', '返回 provider/model 正确');
    check(lastPost && lastPost.model === 'wan2.7-image' && lastPost.n === 1, '请求体含 model / n=1');
    check(lastPost && lastPost.size === '1696x960', '尺寸 1696*960 → 1696x960', lastPost && lastPost.size);
    check(r1.imagePath.endsWith('.png'), '扩展名按字节嗅探为 .png');

    // ---------- 正向 2：同名不覆盖 ----------
    const r2 = await adapter({ prompt: '雪山日出', options: { outDir, taskId: 'compat1', index: 0 }, config: cfg() });
    check(r2.imagePath !== r1.imagePath && fs.existsSync(r2.imagePath), '同名第二次不覆盖（生成 _v2）', path.basename(r2.imagePath));

    // ---------- 正向 3：b64_json ----------
    const r3 = await adapter({ prompt: 'x', options: { outDir, taskId: 'compat_b64', index: 0 }, config: cfg({ IMAGE_GEN_BASE_URL: BASE + '/b64' }) });
    check(fs.existsSync(r3.imagePath) && r3.width === 1, 'b64_json 模式：落盘并解析宽高');

    // ---------- 正向 4：中转 metadata 包装 ----------
    const r4 = await adapter({ prompt: 'x', options: { outDir, taskId: 'compat_wrap', index: 0 }, config: cfg({ IMAGE_GEN_BASE_URL: BASE + '/wrapped' }) });
    check(fs.existsSync(r4.imagePath), 'metadata.output…image 包装也能取到图');

    // ---------- 负向 1：401 ----------
    let e401 = null;
    try { await adapter({ prompt: 'x', options: { outDir, taskId: 'c401' }, config: cfg({ IMAGE_GEN_BASE_URL: BASE + '/e401' }) }); }
    catch (e) { e401 = e; }
    check(!!e401 && /鉴权失败/.test(e401.message) && /401/.test(e401.message), '401 → 明确「鉴权失败」');

    // ---------- 负向 2：200 但是 HTML（地址填成网页） ----------
    let eHtml = null;
    try { await adapter({ prompt: 'x', options: { outDir, taskId: 'chtml' }, config: cfg({ IMAGE_GEN_BASE_URL: BASE + '/html' }) }); }
    catch (e) { eHtml = e; }
    check(!!eHtml && /不是 JSON/.test(eHtml.message), '200+HTML → 判失败（不把网页当接口）', eHtml && eHtml.message.slice(0, 40));

    // ---------- 负向 3：200 但没有图片数据 ----------
    let eNo = null;
    try { await adapter({ prompt: 'x', options: { outDir, taskId: 'cnodata' }, config: cfg({ IMAGE_GEN_BASE_URL: BASE + '/nodata' }) }); }
    catch (e) { eNo = e; }
    check(!!eNo && /没有返回图片数据/.test(eNo.message), '200+空 data → 判失败');

    // ---------- 负向 4：下载到 HTML（不是图片） ----------
    let eBad = null;
    try { await adapter({ prompt: 'x', options: { outDir, taskId: 'cbad' }, config: cfg({ IMAGE_GEN_BASE_URL: BASE + '/badimg' }) }); }
    catch (e) { eBad = e; }
    check(!!eBad && /图片下载失败|不是可识别的图片/.test(eBad.message), '下载到 HTML → 判失败（不会把错误页当图）');

    // ---------- 负向 5：缺 Key ----------
    let eKey = null;
    try { await adapter({ prompt: 'x', options: { outDir }, config: cfg({ IMAGE_GEN_API_KEY: '' }) }); }
    catch (e) { eKey = e; }
    check(!!eKey && /缺少 API Key/.test(eKey.message), '缺 Key → 明确报错（不发请求）');

    // ---------- 负向 6：Base URL 非法 ----------
    let eUrl = null;
    try { await adapter({ prompt: 'x', options: { outDir }, config: cfg({ IMAGE_GEN_BASE_URL: 'agglm.whaletv.com' }) }); }
    catch (e) { eUrl = e; }
    check(!!eUrl && /必须以 http/.test(eUrl.message), 'Base URL 不含协议 → 明确报错');

    // ---------- 状态就绪度 ----------
    const st1 = getImageGenStatus({ IMAGE_GEN_PROVIDER: 'openai-images', IMAGE_GEN_API_KEY: 'k', IMAGE_GEN_BASE_URL: BASE, IMAGE_GEN_MODEL: 'm' });
    check(st1.usable === true && st1.providerImplemented === true, 'getImageGenStatus：openai-images 就绪');
    const st2 = getImageGenStatus({ IMAGE_GEN_PROVIDER: 'no-such', IMAGE_GEN_API_KEY: 'k', IMAGE_GEN_BASE_URL: BASE, IMAGE_GEN_MODEL: 'm' });
    check(st2.usable === false && st2.providerImplemented === false, '未注册厂商 → usable=false');

    // ---------- 静态：服务端探针按协议区分 + HTML 200 不再判成功 ----------
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check(/probeProvider === 'openai-images' \? '\/models'/.test(serverSrc), '测试连接：openai-images 探 /models');
    check(/tasks\/invalid-task-check/.test(serverSrc), '测试连接：dashscope 仍探 /tasks');
    check(/地址返回的不是 JSON/.test(serverSrc), '测试连接：200+非 JSON 显式失败');
    check(/runtime\.IMAGE_GEN_PROVIDER = body\.provider/.test(serverSrc), '/api/images/generate 接受运行时 provider');
  } catch (e) {
    check(false, '未捕获异常: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    srv.close();
    await sleep(100);
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
