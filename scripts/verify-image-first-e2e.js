// ============================================================
// 图片优先全链路离线验收（2026-11-13）
//
// 不发起任何真实付费调用：
//   · 本地 HTTP stub 模拟 DashScope 视频接口（提交/轮询/下载）
//   · 对象存储上传被替换成本地 URL
//   · NSFW 用测试桩（本机无多模态 Key）
//
// 覆盖：photoId → _i2vPayload（URL）→ DashScope 请求体 media.first_frame
//       → 下载本地视频 → 片段质检 → 拼接 → quick 档完成
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const config = require('../config');
const taskManager = require('../src/taskManager');
const pipeline = require('../src/pipeline');
const qualityChecker = require('../src/qualityChecker');
const photoLibrary = require('../src/photoLibrary');
const videoProcessor = require('../src/videoProcessor');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}

function makeStubVideo(outPath) {
  const cmd = `"${config.FFMPEG_PATH}" -y -v error -f lavfi -i color=c=0x1a3a5a:s=1280x720:d=2:r=30 `
    + `-pix_fmt yuv420p -c:v libx264 -preset veryfast "${outPath}"`;
  const r = videoProcessor._runFFmpeg(cmd);
  if (!r.success || !fs.existsSync(outPath)) throw new Error('生成 stub 视频失败: ' + (r.error || ''));
}

(async () => {
  console.log('================================================================');
  console.log('图片优先全链路离线验收（本地 DashScope stub）');
  console.log('================================================================');

  const photo = photoLibrary.listAll().find(p => p.status === 'approved' && p.filePath && fs.existsSync(p.filePath));
  if (!photo) {
    console.log('  ⚠ 没有 approved 图片，跳过');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    return;
  }

  // 本机 ffmpeg 对系统 TEMP 无写权限（已知坑）：stub 视频放 app/output 下的临时目录。
  const e2eOutRoot = path.join(__dirname, '..', 'output');
  fs.mkdirSync(e2eOutRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(e2eOutRoot, 'imgfirst-e2e-'));
  const stubMp4 = path.join(dir, 'stub.mp4');
  makeStubVideo(stubMp4);
  const stubBytes = fs.readFileSync(stubMp4);
  const submissions = [];
  const uploads = [];
  let stubPort = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/v1/uploads')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          policy: 'stub-policy',
          signature: 'stub-signature',
          upload_dir: 'dashscope-instant/stub',
          upload_host: `http://127.0.0.1:${stubPort}/upload`,
          oss_access_key_id: 'stub-id',
          x_oss_object_acl: 'private',
          x_oss_forbid_overwrite: 'true',
          expire_in_seconds: 300
        }
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      let n = 0;
      req.on('data', (c) => { n += c.length; });
      req.on('end', () => {
        uploads.push({ bytes: n, contentType: req.headers['content-type'] || '' });
        res.writeHead(200);
        res.end('ok');
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
    if (req.method === 'GET' && req.url === '/tasks/stub-task') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        output: { task_status: 'SUCCEEDED', video_url: `http://127.0.0.1:${stubPort}/stub.mp4` }
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/stub.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stubBytes.length });
      res.end(stubBytes);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stubPort = server.address().port;

  const origNSFW = qualityChecker.checkNSFW.bind(qualityChecker);
  qualityChecker.checkNSFW = async () => ({ passed: true, qcVersion: 3, reason: '【测试桩】', level: 'pass' });

  const task = taskManager.createTask('图片优先全链路测试', {
    model: 'dashscope',
    totalClips: 2,
    clipDuration: 2,
    resolution: '720p',
    preset: 'quick',
    autoRetry: false,
    // 出图自动调色（A 方案）：本任务已用现成 photoId，不会重新出图；
    // 这里验证「创建时写入、后续沿用」的字段确实落库。
    imageGrade: 'calm',
    runtimeConfig: { apiKey: 'stub-key', apiBaseUrl: `http://127.0.0.1:${stubPort}` }
  });
  taskManager.updateClip(task.taskId, 0, { photoId: photo.id });
  taskManager.updateClip(task.taskId, 1, { photoId: photo.id });

  try {
    pipeline.runningTasks.add(task.taskId);
    const r = await pipeline._runPipeline(task.taskId, {});
    const t = taskManager.getTask(task.taskId);
    console.log('  任务终态:', t.status, '| 片段:', t.clips.map(c => c.status).join(','));
    console.log('  提交次数:', submissions.length);
    ok(t.status === 'completed', 'A. quick 档全链路 completed', `status=${t.status}`);
    ok(t.clips.every(c => c.status === 'success'), 'B. 2 个片段都成功', t.clips.map(c => c.status).join(','));
    ok(submissions.length === 2, 'C. 两次图生视频提交', `count=${submissions.length}`);
    const mediaOk = submissions.every(s => Array.isArray(s.body && s.body.input && s.body.input.media)
      && s.body.input.media[0] && s.body.input.media[0].type === 'first_frame'
      && String(s.body.input.media[0].url).startsWith('oss://dashscope-instant/'));
    ok(mediaOk, 'D. 每次提交都带 first_frame 的 oss:// 临时地址',
      JSON.stringify(submissions.map(s => s.body && s.body.input && s.body.input.media)));
    ok(submissions.every(s => String(s.headers['x-dashscope-ossresourceresolve'] || '') === 'enable'),
      'D2. oss:// 请求都带 X-DashScope-OssResourceResolve: enable');
    ok(uploads.length === 1, 'D3. 同一张图只临时上传一次', `uploads=${uploads.length}`,
      JSON.stringify(uploads));
    ok(!!t.outputPath && fs.existsSync(t.outputPath), 'E. 产出成片文件', t.outputPath || '');
    if (t.outputPath && fs.existsSync(t.outputPath)) {
      const d = videoProcessor.probeDetail(t.outputPath);
      ok(d.success && Math.abs(d.duration - 4) <= 0.5, 'F. 成片时长 ≈ 4s（2+2）', `duration=${d.duration}`);
      ok(d.width === 1280 && d.height === 720, 'G. 成片分辨率 1280x720', `${d.width}x${d.height}`);
    }
    ok(t.steps.clip_generation && t.steps.clip_generation.status === 'completed',
      'H. 片段生成步骤 completed', t.steps.clip_generation && t.steps.clip_generation.status);
    ok(t.imageGrade === 'calm', 'I. task.imageGrade 创建时写入并保留（补跑/重生成沿用）', t.imageGrade);
  } finally {
    pipeline.runningTasks.delete(task.taskId);
    qualityChecker.checkNSFW = origNSFW;
    // 清理本测试的任务产物（只删本任务 id，避免误删）
    for (const p of [
      path.join(config.STORAGE.outputDir, `${task.taskId}_concat.mp4`),
      path.join(config.STORAGE.outputDir, `${task.taskId}_final.mp4`)
    ]) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} }
    for (const c of (task.clips || [])) {
      const p = pipeline._resolveClipPath(c.videoPath);
      if (p) { try { fs.unlinkSync(p); } catch (e) {} }
    }
    server.close();
    // 造任务必须清理（门禁静态要求接入 _test-cleanup）。
    // 本任务用本地 stub 的 dashscope 通道（零计费），而 _test-cleanup 只允许删 mock，
    // 所以这里对它放行后按「本次运行自己拿到的 taskId」直接删库/删 JSON，不按前缀/路径匹配。
    try {
      const { cleanupMany } = require('./_test-cleanup');
      const cleaned = await cleanupMany([task.taskId], taskManager);
      if (!cleaned.every((x) => x.ok)) {
        const storage = require('../src/storage');
        await storage.deleteTask(task.taskId);
        try { fs.unlinkSync(path.join(config.STORAGE.dataDir, task.taskId + '.json')); } catch (e) { /* 可能不存在 */ }
      }
    } catch (e) {
      console.warn('[verify-image-first-e2e] 测试任务清理失败:', e && e.message);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
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
