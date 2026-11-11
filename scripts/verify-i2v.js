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
    check(!!getI2VInfo('openai-video'), '能力表：openai-video 已接（new-api Sora 格式，标注未实测）');
    check((getI2VInfo('openai-video') || {}).input === 'multipart-input_reference', 'openai-video 能力：multipart input_reference');
    check(getI2VInfo('dashscope') === null, '能力表：dashscope 未实现（需公网 URL，未接）');
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

    // ---------- OpenAI 兼容（WhaleTV / new-api）：multipart input_reference ----------
    const OA = require(path.join(APP, 'src', 'generators', 'openaiVideo'));
    const IMG_W = { base64: 'QUJDRA==', dataUrl: 'data:image/png;base64,QUJDRA==', mime: 'image/png', width: 1696, height: 960 };

    calls.length = 0;
    stubFetch(() => jsonResponse({ id: 'whale_i2v_1', status: 'queued' }));
    const oa = new OA({ apiKey: 'k', baseUrl: 'https://relay.example/v1', modelId: 'wan3.0-video' });
    const oaRes = await oa.generate('雪山推近', { duration: 5, image: IMG_W });
    const oaCall = calls[0];
    const form = oaCall && oaCall.rawBody;
    check(oaCall && oaCall.url.endsWith('/videos'), 'WhaleTV：仍提交 /videos');
    check(form instanceof FormData, 'WhaleTV：图生视频用 multipart/form-data（不是 JSON）');
    check(oaCall && oaCall.opts.headers && oaCall.opts.headers['Content-Type'] === undefined,
      'WhaleTV：不手写 Content-Type（交给 fetch 带 boundary）');
    if (form instanceof FormData) {
      check(form.get('model') === 'wan3.0-video', 'WhaleTV：multipart 带 model');
      check(form.get('seconds') === '5', 'WhaleTV：multipart 带 seconds=5');
      check(form.get('size') === '1280x720', 'WhaleTV：size 按 16:9 图片选 1280x720', String(form.get('size')));
      const ref = form.get('input_reference');
      check(ref && typeof ref.size === 'number' && ref.size > 0, 'WhaleTV：带非空 input_reference 文件');
      check(ref && ref.type === 'image/png', 'WhaleTV：input_reference MIME 正确', ref && ref.type);
    } else {
      check(false, 'WhaleTV：multipart 表单不可读（FormData 未生成）');
    }
    check(oaRes.taskId === 'whale_i2v_1', 'WhaleTV：返回任务 id');

    // 不带图仍是原来的 JSON（文生视频零回归）
    calls.length = 0;
    stubFetch(() => jsonResponse({ id: 'whale_t2v_1', status: 'queued' }));
    const oa2 = new OA({ apiKey: 'k', baseUrl: 'https://relay.example/v1', modelId: 'wan3.0-video' });
    await oa2.generate('纯文字', { duration: 5 });
    check(calls[0] && calls[0].body && calls[0].body.model === 'wan3.0-video', 'WhaleTV：不带图仍走 JSON 文生视频（零回归）');
    check(calls[0] && typeof calls[0].rawBody === 'string', 'WhaleTV：文生视频请求体仍是 JSON 字符串');

    // ---------- 静态接线：pipeline / server ----------
    const fs = require('fs');
    const pipelineSrc = fs.readFileSync(path.join(APP, 'src', 'pipeline.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
    const createSrc = fs.readFileSync(path.join(APP, 'web', 'src', 'screens', 'create.js'), 'utf8');
    check(/attachUsage\(photo\.id/.test(pipelineSrc), 'pipeline：把「哪张图生成了哪条视频」记回图片库');
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
