// ==========================================
// 验收：图片生成（wan2.7-image / DashScope）
// ==========================================
//
// 不需要真实 API Key、不联网、不花钱：
//   用一个本地 HTTP stub 模拟百炼的「提交 → 轮询 → 下载」三步，
//   断言请求结构、落盘文件、宽高解析、负向错误路径。
//
// 覆盖：
//   1. 配置就绪度（无 Key / 有 Key / 适配器是否注册）
//   2. 请求体构造（model / messages / size / n / watermark）
//   3. 成功链路：提交 → 轮询 → 下载 → 落盘 → 返回宽高
//   4. 同步返回（提交即带图片 URL，不需要轮询）
//   5. 同名文件不覆盖（_v2）
//   6. 负向：401、任务 FAILED、成功但无 URL、下载到 HTML、超时
//   7. 参数负向：空提示词、非法尺寸、n>1、无 Key（均不得发请求）
//   8. 路由与注册的静态接线
//
// 运行：node scripts/verify-image-gen.js
// ==========================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP_DIR = path.join(__dirname, '..');
const TMP_DIR = path.join(APP_DIR, 'output', '_verify_image_gen');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t) {
  console.log(`\n--- ${t} ---`);
}

// ---------- 一张真实可解码的 PNG（用于 stub 下载） ----------
function makePng(W = 320, H = 180) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB

  const raw = Buffer.alloc(H * (1 + W * 3));
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const border = x < 8 || y < 8 || x >= W - 8 || y >= H - 8;
      if (border) { raw[o++] = 30; raw[o++] = 60; raw[o++] = 120; }
      else if (x < W / 2) { raw[o++] = 210; raw[o++] = 120; raw[o++] = 60; }
      else { raw[o++] = 90; raw[o++] = 160; raw[o++] = 210; }
    }
  }

  const table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      t[n] = v >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let v = 0xffffffff;
    for (const x of b) v = table[(v ^ x) & 0xff] ^ (v >>> 8);
    return (v ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const PNG = makePng(320, 180);

// 只用于测试文件头解析：不是可解码的完整 JPEG/WebP，但头部结构合法。
function makeJpegHeader(W, H) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff; app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF\0', 4, 'ascii');
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(H, 5);
  sof.writeUInt16BE(W, 7);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof, eoi]);
}

function makeWebpVp8xHeader(W, H) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b[20] = 0; // flags
  b.writeUIntLE(W - 1, 24, 3);
  b.writeUIntLE(H - 1, 27, 3);
  return b;
}

// ---------- 本地 DashScope stub ----------
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

function startStub(opt = {}) {
  return new Promise((resolve) => {
    const captured = { submits: [], polls: 0, downloads: 0 };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }

        // 1) 提交
        if (req.method === 'POST' && req.url.endsWith('/services/aigc/image-generation/generation')) {
          captured.submits.push({ url: req.url, headers: req.headers, body });
          if (opt.onSubmit) return opt.onSubmit(req, res, body, captured);
          return json(res, 200, {
            request_id: 'req-1',
            output: { task_id: 'task-1', task_status: 'PENDING' }
          });
        }

        // 2) 轮询
        if (req.method === 'GET' && req.url.startsWith('/api/v1/tasks/')) {
          captured.polls++;
          if (opt.onPoll) return opt.onPoll(req, res, captured);
          const imageUrl = `http://${req.headers.host}/files/ok.png`;
          if (captured.polls === 1) {
            return json(res, 200, {
              request_id: 'req-1',
              output: { task_id: 'task-1', task_status: 'RUNNING' }
            });
          }
          return json(res, 200, {
            request_id: 'req-1',
            output: {
              task_id: 'task-1',
              task_status: 'SUCCEEDED',
              choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: [{ type: 'image', image: imageUrl }] }
              }]
            }
          });
        }

        // 3) 下载
        if (req.method === 'GET' && req.url === '/files/ok.png') {
          captured.downloads++;
          if (opt.onFile) return opt.onFile(req, res);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
          return res.end(PNG);
        }

        json(res, 404, { message: 'not found: ' + req.url });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/api/v1`,
        captured,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

// ---------- 配置快照/恢复（config 是普通对象，可以就地改） ----------
const CFG_KEYS = [
  'IMAGE_GEN_PROVIDER', 'IMAGE_GEN_API_KEY', 'IMAGE_GEN_BASE_URL', 'IMAGE_GEN_MODEL',
  'IMAGE_GEN_SIZE', 'IMAGE_GEN_TIMEOUT_MS', 'IMAGE_GEN_POLL_MS', 'IMAGE_GEN_WATERMARK',
  'DASHSCOPE_API_KEY'
];
const config = require(path.join(APP_DIR, 'config.js'));
const ORIG = {};
for (const k of CFG_KEYS) ORIG[k] = config[k];

function setReady(baseUrl, patch = {}) {
  Object.assign(config, {
    IMAGE_GEN_PROVIDER: 'dashscope',
    IMAGE_GEN_API_KEY: 'test-key-not-real',
    IMAGE_GEN_BASE_URL: baseUrl,
    IMAGE_GEN_MODEL: 'wan2.7-image',
    IMAGE_GEN_SIZE: '1696*960',
    IMAGE_GEN_TIMEOUT_MS: 5000,
    IMAGE_GEN_POLL_MS: 10,
    IMAGE_GEN_WATERMARK: 'false',
    DASHSCOPE_API_KEY: ''
  }, patch);
}

function restoreConfig() {
  for (const k of CFG_KEYS) config[k] = ORIG[k];
}

async function expectThrows(label, fn, contains) {
  try {
    await fn();
    ok(label, false, '预期抛错但没有');
    return null;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const matched = !contains || msg.includes(contains);
    ok(label, matched, msg.slice(0, 220));
    return e;
  }
}

const stubs = [];

(async () => {
  console.log('=== verify-image-gen ===\n');

  const { readImageMeta, sniffImageType } = require(path.join(APP_DIR, 'src', 'utils', 'imageMeta.js'));
  const dashscope = require(path.join(APP_DIR, 'src', 'generators', 'imageProviders', 'dashscope.js'));
  const imageGen = require(path.join(APP_DIR, 'src', 'generators', 'imageGen.js'));
  require(path.join(APP_DIR, 'src', 'generators', 'imageProviders', 'index.js'));

  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });

    // ---------- 1. 静态接线 ----------
    section('1. 静态接线');
    const serverSrc = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
    const cfgSrc = fs.readFileSync(path.join(APP_DIR, 'config.js'), 'utf8');
    const envSrc = fs.readFileSync(path.join(APP_DIR, '.env.example'), 'utf8');
    const createSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'screens', 'create.js'), 'utf8');
    const invSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'screens', 'inventory.js'), 'utf8');
    const settingsSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'screens', 'settingsPage.js'), 'utf8');

    ok('server.js 注册了出图适配器', serverSrc.includes("require('./src/generators/imageProviders')"));
    ok('存在 GET /api/image-gen/status', serverSrc.includes("app.get('/api/image-gen/status'"));
    ok('存在 POST /api/images/generate', serverSrc.includes("app.post('/api/images/generate'"));
    ok('config.js 默认模型是 wan2.7-image', cfgSrc.includes("'wan2.7-image'"));
    ok('.env.example 写明 wan2.7-image', envSrc.includes('IMAGE_GEN_MODEL=wan2.7-image'));
    ok('create.js 读取出图状态', createSrc.includes('/api/image-gen/status'));
    ok('create.js 调用单张出图接口', createSrc.includes('/api/images/generate'));
    ok('create.js 发送本机图片 Key', createSrc.includes('apiKey: cfg.imageKey'));
    ok('settingsPage 有图片模型入口', settingsSrc.includes("id: 'imagegen'"));
    ok('settingsPage 保存图片 Key 字段', settingsSrc.includes("['imageKey'"));
    ok('settingsPage 图片组可测试连接', settingsSrc.includes("if (g.id === 'imagegen')"));
    ok('settingsPage 所有密码字段有显示切换', settingsSrc.includes('showKeys') && settingsSrc.includes('显示密钥'));
    ok('server.js 支持 imagegen 连接测试', serverSrc.includes("type === 'imagegen'"));
    ok('/api/status 暴露图片生成版本探针', serverSrc.includes('imageGen: {'));
    ok('server.js 带 serverInfo 版本探针', serverSrc.includes('SERVER_STARTED_AT'));
    ok('根路径已重定向到 /app', serverSrc.includes("res.redirect(302, '/app')"));
    ok('存在运行版本检查脚本', fs.existsSync(path.join(APP_DIR, 'scripts', 'check-server-version.js')));
    ok('设置页对旧服务端给出重启提示', settingsSrc.includes('服务端仍是旧进程'));
    ok('Seedance 接口默认折叠', settingsSrc.includes("{ id: 'seedance', title: 'Seedance 2.5（字节）', collapsible: true"));
    ok('可灵接口默认折叠', settingsSrc.includes("{ id: 'kling', title: '可灵 Kling 3.0', collapsible: true"));
    ok('inventory.js 不再声称厂商未接入', !invSrc.includes('目前出图厂商未接入'));
    ok('适配器已注册 dashscope', imageGen.listImageProviders().includes('dashscope'),
      imageGen.listImageProviders().join(','));
    config.IMAGE_GEN_PROVIDER = 'dashscope';
    const gen = new imageGen.ImageGenerator();
    ok('ImageGenerator 默认 provider 来自 config', gen.provider === 'dashscope', gen.provider);
    ok('ImageGenerator.capabilities.implemented = true', gen.capabilities.implemented === true);

    // ---------- 2. 图片头解析 ----------
    section('2. 图片字节解析');
    const meta = readImageMeta(PNG);
    ok('PNG 类型识别', meta.mime === 'image/png' && meta.ext === 'png', JSON.stringify(meta));
    ok('PNG 宽高解析正确', meta.width === 320 && meta.height === 180, `${meta.width}x${meta.height}`);
    const jpegMeta = readImageMeta(makeJpegHeader(640, 360));
    ok('JPEG 宽高解析正确', jpegMeta.width === 640 && jpegMeta.height === 360,
      `${jpegMeta.width}x${jpegMeta.height}`);
    const webpMeta = readImageMeta(makeWebpVp8xHeader(800, 450));
    ok('WebP（VP8X）宽高解析正确', webpMeta.width === 800 && webpMeta.height === 450,
      `${webpMeta.width}x${webpMeta.height}`);
    ok('HTML 不被当成图片', (() => {
      try { readImageMeta(Buffer.from('<html>error</html>')); return false; } catch (e) { return true; }
    })());
    ok('空字节不被当成图片', (() => {
      try { readImageMeta(Buffer.alloc(0)); return false; } catch (e) { return true; }
    })());

    // ---------- 3. 配置就绪度 ----------
    section('3. 配置就绪度（不联网）');
    restoreConfig();
    config.IMAGE_GEN_PROVIDER = 'dashscope';
    config.IMAGE_GEN_API_KEY = '';
    config.DASHSCOPE_API_KEY = '';
    config.IMAGE_GEN_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
    config.IMAGE_GEN_MODEL = 'wan2.7-image';

    let st = imageGen.getImageGenStatus();
    ok('无 Key 时 ready=false', st.ready === false);
    ok('无 Key 时 usable=false', st.usable === false);
    ok('无 Key 时 missing 只含 Key', st.missing.length === 1 && st.missing[0] === 'IMAGE_GEN_API_KEY',
      st.missing.join(','));
    ok('无 Key 时不含 Key 值字段', !JSON.stringify(st).includes('test-key'));

    config.IMAGE_GEN_API_KEY = 'test-key-not-real';
    st = imageGen.getImageGenStatus();
    ok('有 Key 时 ready=true', st.ready === true);
    ok('有 Key 且适配器已注册时 usable=true', st.usable === true);
    ok('状态对象不回传 Key', !JSON.stringify(st).includes('test-key-not-real'));
    ok('i2v 能力仍为 null（未核实）', st.i2v.supportedByProvider === null);

    // ---------- 4. 请求体构造 ----------
    section('4. 请求体构造');
    const payload = dashscope.buildImagePayload({
      model: 'wan2.7-image',
      prompt: '清晨的雪山，侧逆光',
      size: '1696x960',
      n: 1,
      watermark: false
    });
    ok('model 正确', payload.model === 'wan2.7-image');
    ok('messages 结构正确',
      payload.input.messages[0].role === 'user' &&
      payload.input.messages[0].content[0].text === '清晨的雪山，侧逆光');
    ok('size 的 x 归一化为 *', payload.parameters.size === '1696*960', payload.parameters.size);
    ok('n=1', payload.parameters.n === 1);
    ok('watermark=false', payload.parameters.watermark === false);
    ok('normalizeSize 支持 2K 预设', dashscope.normalizeSize('2k') === '2K');
    ok('normalizeSize 支持 1K 预设', dashscope.normalizeSize('1k') === '1K');
    ok('normalizeSize 拒绝非法值', (() => {
      try { dashscope.normalizeSize('abc'); return false; } catch (e) { return true; }
    })());

    // ---------- 5. 成功链路 ----------
    section('5. 成功链路（提交 → 轮询 → 下载 → 落盘）');
    const stub = await startStub();
    stubs.push(stub);
    setReady(stub.baseUrl, { IMAGE_GEN_SIZE: '2688x1536' });

    const out = await gen.generateImage('清晨的雪山，侧逆光，长焦压缩', {
      taskId: 'verify_task',
      index: 2,
      outDir: TMP_DIR
    });

    const sub = stub.captured.submits[0];
    ok('提交路径正确', !!sub && sub.url.endsWith('/services/aigc/image-generation/generation'), sub && sub.url);
    ok('带 Authorization Bearer', !!sub && sub.headers.authorization === 'Bearer test-key-not-real',
      sub && String(sub.headers.authorization).slice(0, 20));
    ok('带 X-DashScope-Async: enable', !!sub && sub.headers['x-dashscope-async'] === 'enable');
    ok('请求 model = wan2.7-image', !!sub && sub.body.model === 'wan2.7-image');
    ok('请求 size = 2688*1536（x 已归一化）',
      !!sub && sub.body.parameters.size === '2688*1536',
      sub && sub.body.parameters.size);
    ok('请求 n = 1', !!sub && sub.body.parameters.n === 1);
    ok('请求 watermark = false', !!sub && sub.body.parameters.watermark === false);
    ok('请求提示词正确',
      !!sub && sub.body.input.messages[0].content[0].text === '清晨的雪山，侧逆光，长焦压缩');
    ok('确实轮询了（RUNNING 后 SUCCEEDED）', stub.captured.polls >= 2, String(stub.captured.polls));
    ok('确实下载了图片', stub.captured.downloads === 1, String(stub.captured.downloads));

    ok('返回 provider=dashscope', out.provider === 'dashscope', out.provider);
    ok('返回 model=wan2.7-image', out.model === 'wan2.7-image', out.model);
    ok('返回宽高来自文件头', out.width === 320 && out.height === 180, `${out.width}x${out.height}`);
    ok('文件存在', fs.existsSync(out.imagePath), out.imagePath);
    ok('文件名符合 <taskId>_img_<i>', path.basename(out.imagePath) === 'verify_task_img_2.png',
      path.basename(out.imagePath));
    ok('文件内容与下载字节一致', fs.readFileSync(out.imagePath).equals(PNG));
    ok('没有 .part 残留', !fs.readdirSync(TMP_DIR).some((f) => f.endsWith('.part')));
    ok('没有 .tmp 残留', !fs.readdirSync(TMP_DIR).some((f) => f.endsWith('.tmp')));

    // ---------- 6. 同名不覆盖 ----------
    section('6. 同名文件不覆盖');
    const out2 = await gen.generateImage('第二张', {
      taskId: 'verify_task', index: 2, outDir: TMP_DIR
    });
    ok('第二次落盘使用 _v2 后缀', path.basename(out2.imagePath) === 'verify_task_img_2_v2.png',
      path.basename(out2.imagePath));
    ok('第一张文件仍在', fs.existsSync(out.imagePath));
    ok('两张文件都存在', fs.existsSync(out2.imagePath));

    // ---------- 6b. 并发同名不互相覆盖 ----------
    section('6b. 并发同名不互相覆盖');
    setReady(stub.baseUrl);
    const [c1, c2] = await Promise.all([
      gen.generateImage('并发 A', { taskId: 'verify_concurrent', index: 0, outDir: TMP_DIR }),
      gen.generateImage('并发 B', { taskId: 'verify_concurrent', index: 0, outDir: TMP_DIR })
    ]);
    ok('并发落盘得到两个不同文件', c1.imagePath !== c2.imagePath,
      path.basename(c1.imagePath) + ' / ' + path.basename(c2.imagePath));
    ok('两个并发文件都存在', fs.existsSync(c1.imagePath) && fs.existsSync(c2.imagePath));

    // ---------- 5c. 运行时配置（设置页填 Key，不依赖 .env） ----------
    section('5c. 运行时配置（设置页填 Key）');
    const savedGlobalKey = config.IMAGE_GEN_API_KEY;
    const savedDashKey = config.DASHSCOPE_API_KEY;
    config.IMAGE_GEN_API_KEY = '';
    config.DASHSCOPE_API_KEY = '';

    const runtimeGen = new imageGen.ImageGenerator({
      provider: 'dashscope',
      IMAGE_GEN_API_KEY: 'runtime-key-not-real',
      IMAGE_GEN_BASE_URL: stub.baseUrl,
      IMAGE_GEN_MODEL: 'wan2.7-image',
      IMAGE_GEN_SIZE: '1696*960'
    });
    const rtOut = await runtimeGen.generateImage('运行时配置测试', {
      taskId: 'verify_runtime', index: 0, outDir: TMP_DIR
    });
    const lastSubmit = stub.captured.submits[stub.captured.submits.length - 1];
    ok('全局无 Key 时，运行时 Key 可出图', fs.existsSync(rtOut.imagePath));
    ok('请求使用运行时 Key',
      !!lastSubmit && lastSubmit.headers.authorization === 'Bearer runtime-key-not-real',
      lastSubmit && String(lastSubmit.headers.authorization).slice(0, 24));

    config.IMAGE_GEN_API_KEY = savedGlobalKey;
    config.DASHSCOPE_API_KEY = savedDashKey;

    // ---------- 7. 同步返回（提交即带 URL） ----------
    section('7. 同步返回（不需要轮询）');
    const syncStub = await startStub({
      onSubmit: (req, res) => {
        const imageUrl = `http://${req.headers.host}/files/ok.png`;
        json(res, 200, {
          request_id: 'req-sync',
          output: {
            choices: [{
              message: { role: 'assistant', content: [{ type: 'image', image: imageUrl }] }
            }]
          }
        });
      }
    });
    stubs.push(syncStub);
    setReady(syncStub.baseUrl);
    const syncOut = await gen.generateImage('同步返回测试', {
      taskId: 'verify_sync', index: 0, outDir: TMP_DIR
    });
    ok('同步返回不轮询', syncStub.captured.polls === 0, String(syncStub.captured.polls));
    ok('同步返回也能落盘', fs.existsSync(syncOut.imagePath));
    ok('同步返回宽高正确', syncOut.width === 320 && syncOut.height === 180);

    // ---------- 7b. 提交 5xx 自动重试 ----------
    section('7b. 提交 5xx 自动重试');
    const sRetry = await startStub({
      onSubmit: (req, res, body, captured) => {
        if (captured.submits.length === 1) {
          return json(res, 500, { message: 'temporary upstream error' });
        }
        return json(res, 200, { request_id: 'req-retry', output: { task_id: 'task-retry', task_status: 'PENDING' } });
      }
    });
    stubs.push(sRetry);
    setReady(sRetry.baseUrl);
    const retryOut = await gen.generateImage('重试测试', {
      taskId: 'verify_retry', index: 0, outDir: TMP_DIR
    });
    ok('5xx 后重试成功并落盘', fs.existsSync(retryOut.imagePath));
    ok('共提交 2 次（1 次 500 + 1 次成功）', sRetry.captured.submits.length === 2,
      String(sRetry.captured.submits.length));

    // ---------- 8. 负向：401 ----------
    section('8. 负向：提交 401');
    const s401 = await startStub({
      onSubmit: (req, res) => json(res, 401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' })
    });
    stubs.push(s401);
    setReady(s401.baseUrl);
    const e401 = await expectThrows('401 抛错', () => gen.generateImage('x', {
      taskId: 'verify_401', index: 0, outDir: TMP_DIR
    }), '401');
    ok('401 错误包含厂商信息', !!e401 && e401.message.includes('Invalid API-key'));
    ok('401 错误不回显 Key', !!e401 && !e401.message.includes('test-key-not-real'));
    ok('401 不重试（只提交 1 次）', s401.captured.submits.length === 1,
      String(s401.captured.submits.length));
    ok('401 不落盘', !fs.readdirSync(TMP_DIR).some((f) => f.startsWith('verify_401')));

    // ---------- 8b. 负向：HTTP 200 但带 code/message ----------
    section('8b. 负向：HTTP 200 + code（不能当成成功）');
    const s200 = await startStub({
      onSubmit: (req, res) => json(res, 200, { code: 'InvalidParameter', message: 'size is invalid' })
    });
    stubs.push(s200);
    setReady(s200.baseUrl);
    const e200 = await expectThrows('200+code 抛错', () => gen.generateImage('x', {
      taskId: 'verify_200code', index: 0, outDir: TMP_DIR
    }), 'InvalidParameter');
    ok('错误里带厂商 message', !!e200 && e200.message.includes('size is invalid'));
    ok('200+code 不落盘', !fs.readdirSync(TMP_DIR).some((f) => f.startsWith('verify_200code')));

    // ---------- 9. 负向：任务 FAILED ----------
    section('9. 负向：任务 FAILED');
    const sFail = await startStub({
      onPoll: (req, res) => json(res, 200, {
        request_id: 'req-fail',
        output: { task_id: 'task-1', task_status: 'FAILED', code: 'DataInspectionFailed', message: '内容不合规' }
      })
    });
    stubs.push(sFail);
    setReady(sFail.baseUrl);
    await expectThrows('FAILED 抛错', () => gen.generateImage('x', {
      taskId: 'verify_fail', index: 0, outDir: TMP_DIR
    }), 'FAILED');
    ok('FAILED 不落盘', !fs.readdirSync(TMP_DIR).some((f) => f.startsWith('verify_fail')));

    // ---------- 10. 负向：成功但无 URL ----------
    section('10. 负向：SUCCEEDED 但没有图片 URL');
    const sEmpty = await startStub({
      onPoll: (req, res) => json(res, 200, {
        request_id: 'req-empty',
        output: { task_id: 'task-1', task_status: 'SUCCEEDED', choices: [] }
      })
    });
    stubs.push(sEmpty);
    setReady(sEmpty.baseUrl);
    await expectThrows('无 URL 抛错', () => gen.generateImage('x', {
      taskId: 'verify_empty', index: 0, outDir: TMP_DIR
    }), '没有图片 URL');

    // ---------- 11. 负向：下载到 HTML ----------
    section('11. 负向：下载到 HTML 错误页');
    const sHtml = await startStub({
      onFile: (req, res) => {
        const body = Buffer.from('<html><body>403 Forbidden</body></html>');
        res.writeHead(403, { 'Content-Type': 'text/html', 'Content-Length': body.length });
        res.end(body);
      }
    });
    stubs.push(sHtml);
    setReady(sHtml.baseUrl);
    await expectThrows('HTML 下载抛错', () => gen.generateImage('x', {
      taskId: 'verify_html', index: 0, outDir: TMP_DIR
    }), '下载失败');
    ok('HTML 不落盘', !fs.readdirSync(TMP_DIR).some((f) => f.startsWith('verify_html')));

    // ---------- 11b. 下载 5xx 自动重试 ----------
    section('11b. 下载 5xx 自动重试');
    let fileCalls = 0;
    const sDlRetry = await startStub({
      onFile: (req, res) => {
        fileCalls++;
        if (fileCalls === 1) {
          const body = Buffer.from('temporary download error');
          res.writeHead(500, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
          return res.end(body);
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
        res.end(PNG);
      }
    });
    stubs.push(sDlRetry);
    setReady(sDlRetry.baseUrl);
    const dlRetryOut = await gen.generateImage('下载重试测试', {
      taskId: 'verify_dl_retry', index: 0, outDir: TMP_DIR
    });
    ok('下载 5xx 后重试成功并落盘', fs.existsSync(dlRetryOut.imagePath));
    ok('共下载 2 次（1 次 500 + 1 次成功）', fileCalls === 2, String(fileCalls));

    // ---------- 12. 负向：超时 ----------
    section('12. 负向：轮询超时');
    const sSlow = await startStub({
      onPoll: (req, res) => json(res, 200, {
        request_id: 'req-slow',
        output: { task_id: 'task-1', task_status: 'RUNNING' }
      })
    });
    stubs.push(sSlow);
    setReady(sSlow.baseUrl, { IMAGE_GEN_TIMEOUT_MS: 250, IMAGE_GEN_POLL_MS: 30 });
    const t0 = Date.now();
    await expectThrows('超时抛错', () => gen.generateImage('x', {
      taskId: 'verify_timeout', index: 0, outDir: TMP_DIR
    }), '超时');
    const elapsed = Date.now() - t0;
    ok('超时确实在总超时附近发生', elapsed >= 200 && elapsed < 3000, elapsed + 'ms');
    ok('超时不落盘', !fs.readdirSync(TMP_DIR).some((f) => f.startsWith('verify_timeout')));

    // ---------- 13. 参数负向（不得发请求） ----------
    section('13. 参数负向（不得发请求）');
    const sParam = await startStub();
    stubs.push(sParam);
    setReady(sParam.baseUrl);

    await expectThrows('空提示词抛错', () => dashscope({ prompt: '   ', options: {}, config: {} }), '提示词为空');
    await expectThrows('非法尺寸抛错', () => dashscope({
      prompt: 'x', options: { size: '999' }, config: {}
    }), '尺寸非法');
    await expectThrows('n>1 抛错', () => dashscope({
      prompt: 'x', options: { n: 2 }, config: {}
    }), 'n=1');
    ok('以上参数错误都没有发请求', sParam.captured.submits.length === 0,
      String(sParam.captured.submits.length));

    // 无 Key 也不得发请求（直接调适配器，绕过 ImageGenerator 的配置检查）
    config.IMAGE_GEN_API_KEY = '';
    config.DASHSCOPE_API_KEY = '';
    await expectThrows('无 Key 抛错', () => dashscope({ prompt: 'x', options: {}, config: {} }), 'API Key 未配置');
    ok('无 Key 没有发请求', sParam.captured.submits.length === 0, String(sParam.captured.submits.length));

    // 恢复配置，避免影响后续
    restoreConfig();
  } catch (e) {
    fail++;
    failures.push('未捕获异常: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    console.error('\n❌ 未捕获异常:', e && e.stack ? e.stack : e);
  } finally {
    // 清理：恢复配置、关闭 stub、删除临时目录
    restoreConfig();
    for (const s of stubs) {
      try { await s.close(); } catch (e) { /* 已关闭 */ }
    }
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log('\n' + '='.repeat(56));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项:');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
})();
