// ============================================================
// OpenAI 兼容视频适配器验收（openai-video / WhaleTV 等中转）
// ------------------------------------------------------------
// 协议实测（2026-11-09，WhaleTV）：
//   POST {base}/videos {model,prompt,seconds} → {id,status:'queued'}
//   GET  {base}/videos/{id}                   → {status:'queued|in_progress|completed',progress}
//   GET  {base}/videos/{id}/content           → video/mp4（要 Bearer；completed 不给 URL）
// 本脚本用本地 stub 覆盖：提交/轮询/下载、参数、以及负向（401、失败状态、下到 HTML、缺 Key/地址）。
// 不联网、不花钱。用法：node scripts/verify-openai-video.js
// ============================================================
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.VIDEO_STUB_PORT || 3913);
const BASE = `http://127.0.0.1:${PORT}`;

// 最小可识别的 MP4 头：size(4) + 'ftyp' + 'isom'
const MP4 = Buffer.alloc(4096);
MP4.writeUInt32BE(32, 0);
MP4.write('ftypisom', 4, 'ascii');

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastPost = null;
let statusCalls = 0;

function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }

        if (req.method === 'POST' && req.url === '/v1/videos') {
          lastPost = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'task_stub1', object: 'video', model: body && body.model, status: 'queued', progress: 0 }));
        }
        if (req.method === 'POST' && req.url === '/e401/videos') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Invalid token' } }));
        }
        if (req.method === 'GET' && req.url === '/v1/videos/task_stub1') {
          statusCalls++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (statusCalls === 1) return res.end(JSON.stringify({ id: 'task_stub1', status: 'in_progress', progress: 40 }));
          return res.end(JSON.stringify({ id: 'task_stub1', status: 'completed', progress: 100, completed_at: 1 }));
        }
        if (req.method === 'GET' && req.url === '/fail/videos/task_bad') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'task_bad', status: 'failed', error: { message: 'boom' } }));
        }
        if (req.method === 'GET' && req.url === '/v1/videos/task_stub1/content') {
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          return res.end(MP4);
        }
        if (req.method === 'GET' && req.url === '/html/videos/task_stub1/content') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>not a video</html>');
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
  console.log('OpenAI 兼容视频适配器验收（openai-video，本地 stub）');
  console.log('================================================================');

  const Gen = require(path.join(ROOT, 'src', 'generators', 'openaiVideo.js'));
  const { getAvailableModels, createGenerator } = require(path.join(ROOT, 'src', 'generators', 'index.js'));

  // ---- 静态接线 ----
  const createSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'create.js'), 'utf8');
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'settingsPage.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const pipelineSrc = fs.readFileSync(path.join(ROOT, 'src', 'pipeline.js'), 'utf8');
  check(!!createGenerator && getAvailableModels().some(m => m.id === 'openai-video'), '生成器工厂注册 openai-video');
  check(/value="openai-video"/.test(createSrc), '创作页模型下拉含 openai-video');
  check(/cfg\.whaletvKey/.test(createSrc) && /whaletvBaseUrl/.test(createSrc), '创作页提交时带 WhaleTV Key/Base URL');
  check(/whaletvKey/.test(settingsSrc) && /'openai-video'/.test(settingsSrc), '设置页有 WhaleTV 组并走 openai-video 探针');
  check(/type === 'openai-video'/.test(serverSrc) && /\/models/.test(serverSrc), '服务端测试连接支持 openai-video');
  check(/generator\.downloadVideo/.test(pipelineSrc), 'pipeline 优先用适配器的 downloadVideo');

  const srv = await startStub();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovideo_out_'));
  const mk = (extra = {}) => new Gen({ apiKey: 'sk-test', baseUrl: BASE + '/v1', modelId: 'wan3.0-video', ...extra });

  try {
    // ---- 1. 提交 ----
    const g = mk();
    const r1 = await g.generate('雪山日出', { duration: 5 });
    check(r1.taskId === 'task_stub1' && r1.status === 'queued', '提交返回 taskId/queued', r1.taskId);
    check(lastPost && lastPost.model === 'wan3.0-video' && lastPost.seconds === '5', '请求体含 model + seconds');
    check(lastPost && typeof lastPost.prompt === 'string' && lastPost.prompt.includes('雪山'), '请求体含 prompt');

    // ---- 2. 轮询 ----
    const s1 = await g.getStatus('task_stub1');
    check(s1.status === 'processing' && s1.progress === 40, '第一次查询 = processing/40', JSON.stringify(s1));
    const s2 = await g.getStatus('task_stub1');
    check(s2.status === 'completed', '第二次查询 = completed');

    // ---- 3. 下载（completed 无 URL，必须走 /content） ----
    const outPath = path.join(outDir, 'clip_0.mp4');
    const okDl = await g.downloadVideo('task_stub1', outPath);
    check(okDl === true && fs.existsSync(outPath), 'downloadVideo 落盘成功');
    const st = fs.statSync(outPath);
    check(st.size === MP4.length && st.size > 1024, '文件大小正确', String(st.size));
    check(fs.readFileSync(outPath).subarray(4, 8).toString('ascii') === 'ftyp', '文件头是 MP4（ftyp）');

    // ---- 4. 负向：401 ----
    let e401 = null;
    try { await mk({ baseUrl: BASE + '/e401' }).generate('x'); } catch (e) { e401 = e; }
    check(!!e401 && /\(401\)/.test(e401.message) && /Invalid token/.test(e401.message), '401 → 抛错且带厂商信息');

    // ---- 5. 负向：失败状态 ----
    const sBad = await mk({ baseUrl: BASE + '/fail' }).getStatus('task_bad');
    check(sBad.status === 'failed' && /boom/.test(String(sBad.error)), 'status=failed → failed + 厂商错误');

    // ---- 6. 负向：下到 HTML ----
    const okBad = await mk({ baseUrl: BASE + '/html' }).downloadVideo('task_stub1', path.join(outDir, 'bad.mp4'));
    check(okBad === false && !fs.existsSync(path.join(outDir, 'bad.mp4')), '下到 HTML → 拒收且不落盘');

    // ---- 7. 负向：缺 Key / 缺地址 ----
    let eKey = null;
    try { await new Gen({ baseUrl: BASE + '/v1' }).generate('x'); } catch (e) { eKey = e; }
    check(!!eKey && /API Key 未配置/.test(eKey.message), '缺 Key → 明确报错');
    let eUrl = null;
    try { await new Gen({ apiKey: 'k' }).generate('x'); } catch (e) { eUrl = e; }
    check(!!eUrl && /Base URL 未配置/.test(eUrl.message), '缺 Base URL → 明确报错');

    // ---- 8. 负向：空提示词 ----
    let ePrompt = null;
    try { await mk().generate('   '); } catch (e) { ePrompt = e; }
    check(!!ePrompt && /提示词为空/.test(ePrompt.message), '空提示词 → 报错且不发请求');
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
