// ============================================================
// 图生视频（i2v）请求构建验收（2026-11-11）
// ------------------------------------------------------------
// 只验证「代码把首帧按厂商文档放进了请求体」——不联网、不调真实厂商、不计费。
// 真实计费调用未验证（需要用户 Key + 计费同意）。
// 用法：node scripts/verify-i2v.js
// ============================================================
const path = require('path');

const APP = path.join(__dirname, '..');
const REAL_FETCH = global.fetch;
let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}

const calls = [];
function stubFetch(handler) {
  global.fetch = async (url, opts) => {
    const call = { url: String(url), opts: opts || {}, rawBody: opts && opts.body };
    try { call.body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch (e) { call.body = null; }
    calls.push(call);
    return handler(call);
  };
}
function jsonResponse(obj, ok = true) {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(obj), json: async () => obj };
}

console.log('================================================================');
console.log('图生视频：首帧字段 / 能力表 / 失败语义（离线）');
console.log('================================================================');

(async () => {
  try {
    const { getI2VInfo, listI2VModels } = require(path.join(APP, 'src', 'generators', 'i2vSupport'));
    check(!!getI2VInfo('kling'), '能力表：kling 已实现');
    check(!!getI2VInfo('seedance'), '能力表：seedance 已实现');
    check(!!getI2VInfo('openai-video'), '能力表：openai-video 已接（NewAPI /video/generations，URL 已实测）');
    check((getI2VInfo('openai-video') || {}).input === 'json-image-url-or-dataurl', 'openai-video 能力：JSON image（URL 或 data URL）');
    check(getI2VInfo('dashscope') && getI2VInfo('dashscope').input === 'oss-temp-upload',
      '能力表：dashscope 已接（官方临时上传 oss://，无需用户公网存储）');
    check(listI2VModels().includes('dashscope'), '能力表：dashscope 在 i2v 清单里');
    check(listI2VModels().includes('mock'), '能力表：mock 可用于链路测试');

    // ---------- 可灵 ----------
    const Kling = require(path.join(APP, 'src', 'generators', 'kling'));
    const IMG = { base64: 'QUJDRA==', dataUrl: 'data:image/png;base64,QUJDRA==' };

    calls.length = 0;
    stubFetch(() => jsonResponse({ code: 1000, data: { task_id: 'kling_i2v_1' } }));
    const kling = new Kling({ accessKey: 'ak', secretKey: 'sk', modelId: 'kling-v3' });
    const k1 = await kling.generate('雪山推近', { duration: 5, resolution: '720p', image: IMG });
    check(calls[0].url.endsWith('/v1/videos/image2video'), '可灵：带图时走 image2video 端点', calls[0].url);
    check(calls[0].body && calls[0].body.image === 'QUJDRA==', '可灵：image 传裸 base64（无 data: 前缀）');
    check(!('aspect_ratio' in calls[0].body), '可灵：图生视频不传 aspect_ratio（按官方字段表）');
    check(k1.taskId === 'kling_i2v_1', '可灵：返回任务 id');

    calls.length = 0;
    await kling.getStatus('kling_i2v_1');
    check(calls[0].url.includes('/v1/videos/image2video/kling_i2v_1'), '可灵：i2v 任务查询走 image2video 路径', calls[0].url);

    calls.length = 0;
    stubFetch(() => jsonResponse({ code: 1000, data: { task_id: 'kling_t2v_1' } }));
    const kling2 = new Kling({ accessKey: 'ak', secretKey: 'sk' });
    await kling2.generate('纯文字', { duration: 5, resolution: '720p' });
    check(calls[0].url.endsWith('/v1/videos/text2video'), '可灵：不带图时仍走 text2video（零回归）');
    check(calls[0].body.aspect_ratio === '16:9', '可灵：文生视频仍带 aspect_ratio');

    // ---------- Seedance（火山官方） ----------
    const Seedance = require(path.join(APP, 'src', 'generators', 'seedance'));
    calls.length = 0;
    stubFetch(() => jsonResponse({ id: 'seed_i2v_1' }));
    const seed = new Seedance({ apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-2.0-mini-250928' });
    await seed.generate('雪山', { duration: 5, resolution: '480p', image: IMG });
    const content = calls[0].body && calls[0].body.content;
    check(Array.isArray(content) && content.some((c) => c.type === 'text'), 'Seedance：保留文本段');
    check(Array.isArray(content) && content.some((c) => c.type === 'image_url'
      && c.image_url && c.image_url.url === IMG.dataUrl && c.role === 'first_frame'),
    'Seedance：追加 image_url（role=first_frame）');

    // ---------- Seedance 第三方中转带图 → 明确拒绝 ----------
    calls.length = 0;
    stubFetch(() => jsonResponse({ id: 'x' }));
    const seedThird = new Seedance({ apiKey: 'k', baseUrl: 'https://relay.example/v1' });
    let threw = false;
    try { await seedThird.generate('x', { image: IMG }); } catch (e) { threw = /未实现图生视频/.test(e.message); }
    check(threw, 'Seedance：第三方中转带图时明确报错（不静默丢图）');
    check(calls.length === 0, 'Seedance：第三方中转带图时没有发请求（不白花一分钱）');

    // ---------- OpenAI 兼容（WhaleTV / NewAPI）：/video/generations + image ----------
    const OA = require(path.join(APP, 'src', 'generators', 'openaiVideo'));
    const IMG_W = { base64: 'QUJDRA==', dataUrl: 'data:image/png;base64,QUJDRA==', mime: 'image/png', width: 1696, height: 960 };

    // 1) 图生视频：有公网 URL → 优先传 URL（2026-11-16 实测通过的形态）
    calls.length = 0;
    stubFetch(() => jsonResponse({ id: 'whale_i2v_1', task_id: 'whale_i2v_1', status: 'queued' }));
    const oa = new OA({ apiKey: 'k', baseUrl: 'https://relay.example/v1', modelId: 'wan3.0-video' });
    const oaRes = await oa.generate('雪山推近', { duration: 5, image: { ...IMG_W, url: 'https://img.example/a.png' } });
    const oaCall = calls[0];
    check(oaCall && oaCall.url.endsWith('/video/generations'), 'WhaleTV：图生视频走 /video/generations（NewAPI 形态）', oaCall && oaCall.url);
    check(oaCall && oaCall.opts.headers && oaCall.opts.headers['Content-Type'] === 'application/json', 'WhaleTV：JSON 请求体');
    check(oaCall && oaCall.body && oaCall.body.model === 'wan3.0-video', 'WhaleTV：body.model');
    check(oaCall && oaCall.body && oaCall.body.image === 'https://img.example/a.png', 'WhaleTV：有公网 URL 时优先传 URL');
    check(oaCall && oaCall.body && oaCall.body.duration === 5, 'WhaleTV：duration=5（数字，不是 seconds 字符串）');
    check(oaRes.taskId === 'whale_i2v_1', 'WhaleTV：返回 task_id');

    // 2) 图生视频：没有 URL → 按阿里云文档发 data URL（`data:{mime};base64,...`）
    calls.length = 0;
    stubFetch(() => jsonResponse({ task_id: 'whale_i2v_2', id: 'whale_i2v_2' }));
    const oaB64 = new OA({ apiKey: 'k', baseUrl: 'https://relay.example/v1', modelId: 'wan3.0-video' });
    const oaB64Res = await oaB64.generate('雪山推近', { duration: 5, image: IMG_W });
    check(calls[0] && calls[0].body && calls[0].body.image === 'data:image/png;base64,QUJDRA==',
      'WhaleTV：无 URL 时发 data URL（阿里云官方格式；2026-11-16 实测出片）', calls[0] && String(calls[0].body.image).slice(0, 40));
    check(oaB64Res.taskId === 'whale_i2v_2', 'WhaleTV：data URL 路径也返回 task_id');

    // 3) 查询：完成态（2026-11-16 实测结构 data.status=SUCCESS + data.result_url）
    calls.length = 0;
    stubFetch(() => jsonResponse({ code: 'success', data: { status: 'SUCCESS', progress: '100%', result_url: 'https://cdn.example/v.mp4' } }));
    const stDone = await oa.getStatus('whale_i2v_1');
    check(stDone.status === 'completed' && stDone.videoUrl === 'https://cdn.example/v.mp4',
      'WhaleTV：查询完成态 → completed + result_url', JSON.stringify(stDone));

    // 4) 查询：生成中（IN_PROGRESS + "30%"）
    calls.length = 0;
    stubFetch(() => jsonResponse({ code: 'success', data: { status: 'IN_PROGRESS', progress: '30%' } }));
    const stProc = await oa.getStatus('whale_i2v_1');
    check(stProc.status === 'processing' && stProc.progress === 30, 'WhaleTV：IN_PROGRESS → processing + progress 30',
      JSON.stringify(stProc));

    // 5) 查询：失败（FAILED + fail_reason）
    calls.length = 0;
    stubFetch(() => jsonResponse({ code: 'success', data: { status: 'FAILED', fail_reason: '内容不合规' } }));
    const stBad = await oa.getStatus('whale_i2v_1');
    check(stBad.status === 'failed' && /内容不合规/.test(String(stBad.error)), 'WhaleTV：FAILED → failed + fail_reason');

    // 6) 查询：旧 /videos 任务（/video/generations 404）→ 自动回退旧端点（零回归）
    let legacyHit = 0;
    calls.length = 0;
    stubFetch((call) => {
      if (call.url.includes('/video/generations/')) return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
      legacyHit++;
      return jsonResponse({ id: 'whale_t2v_1', status: 'completed', progress: 100 });
    });
    const stLegacy = await oa.getStatus('whale_t2v_1');
    check(stLegacy.status === 'completed' && legacyHit === 1, 'WhaleTV：新端点 404 → 回退 /videos/{id}（旧任务零回归）');

    // 7) 取片：result_url 直链（不需要 Bearer）→ 落盘 + MP4 头校验
    const os = require('os');
    const fs2 = require('fs');
    const path2 = require('path');
    const tmpDir = fs2.mkdtempSync(path2.join(os.tmpdir(), 'i2v-url-'));
    const fakeMp4 = Buffer.alloc(4096);
    fakeMp4.write('ftypisom', 4, 'ascii');
    calls.length = 0;
    stubFetch((call) => {
      if (call.url.includes('/video/generations/')) {
        return jsonResponse({ code: 'success', data: { status: 'SUCCESS', result_url: 'https://cdn.example/v.mp4' } });
      }
      return { ok: true, status: 200, arrayBuffer: async () => fakeMp4 };
    });
    const oaDl = new OA({ apiKey: 'k', baseUrl: 'https://relay.example/v1', modelId: 'wan3.0-video' });
    await oaDl.getStatus('whale_dl_1');
    const dlFile = path2.join(tmpDir, 'out.mp4');
    const dlOk = await oaDl.downloadVideo('whale_dl_1', dlFile);
    check(dlOk === true && fs2.existsSync(dlFile) && fs2.statSync(dlFile).size === fakeMp4.length,
      'WhaleTV：downloadVideo 用 result_url 直链落盘成功');
    check(fs2.existsSync(dlFile) && fs2.readFileSync(dlFile).subarray(4, 8).toString('ascii') === 'ftyp',
      'WhaleTV：直链下载产物是 MP4（ftyp）');
    try { fs2.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

    // 不带图仍是旧 JSON 文生视频（零回归）
    calls.length = 0;
    stubFetch(() => jsonResponse({ id: 'whale_t2v_2', status: 'queued' }));
    const oa2 = new OA({ apiKey: 'k', baseUrl: 'https://relay.example/v1', modelId: 'wan3.0-video' });
    await oa2.generate('纯文字', { duration: 5 });
    check(calls[0] && calls[0].body && calls[0].body.model === 'wan3.0-video', 'WhaleTV：不带图仍走 JSON 文生视频（零回归）');
    check(calls[0] && calls[0].url.endsWith('/videos'), 'WhaleTV：文生视频仍打 /videos（旧形态不变）');

    // ---------- 静态接线：pipeline / server ----------
    const fs = require('fs');
    const pipelineSrc = fs.readFileSync(path.join(APP, 'src', 'pipeline.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
    const createSrc = fs.readFileSync(path.join(APP, 'web', 'src', 'screens', 'create.js'), 'utf8');
    check(/attachUsage\(usedPhotoId/.test(pipelineSrc), 'pipeline：片段成功后把「哪张图生成了哪条视频」记回图片库');
    check(!/attachUsage\(photo\.id/.test(pipelineSrc), 'pipeline：不在取图阶段提前标记已使用');
    check(/status !== 'approved'/.test(pipelineSrc), 'pipeline：源图未通过审核 → 明确失败');
    check(/getI2VInfo\(modelId\)/.test(serverSrc), '/api/tasks：按能力表校验图生视频模型');
    check(/sourcePhoto\.id/.test(serverSrc), '/api/tasks：把 sourcePhotoId 传给任务');
    check(/if \(wantImage && !i2vSupported\)/.test(createSrc), '向导：模型不支持时提交前拦下');
    check(/sourcePhotoId: imgResult\.photoId/.test(createSrc), '向导：提交体带 sourcePhotoId');
  } catch (e) {
    check(false, '探针异常: ' + (e && e.message ? e.message : e));
  } finally {
    global.fetch = REAL_FETCH;
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
