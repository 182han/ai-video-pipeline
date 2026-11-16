// ============================================================
// P5 验收：小智计划卡接入 WhaleTV 中转（openai-video）—— 零计费、零网络
// ------------------------------------------------------------
// 做法：替换全局 fetch 为「记录器」，直接调用生成器，断言它将要发出的
// POST {baseUrl}/videos 请求体（model / prompt / seconds / 鉴权头 / 图生视频 multipart）。
// 不发起任何真实请求，不创建任务，不产生费用。
//
// 覆盖：
//   [1] 计划卡默认模型 = openai-video，标签「WhaleTV 万相 3.0（中转）」，¥180 / $30（5 分钟 720p）
//   [2] 价目表：openai-video 按秒计价 720P ¥0.6/s（价格缺失会让付费闸门失效）
//   [3] 生成器请求体：POST {base}/videos，model/prompt/seconds，Bearer 鉴权
//   [4] seconds 边界：10/15 原样、60 夹到 30、缺省 5
//   [5] 运行时 Key 不再降级 Mock（createGenerator 带 apiKey）
//   [6] 图生视频走 multipart，含 input_reference / size / seconds
//   [7] 非 2xx 与缺 id 都明确报错，不伪装成功
//
// 用法：cd app && node scripts/verify-whaletv-video.js
// ============================================================
'use strict';

const ASSERT = true;
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}` + (detail ? `  —  ${detail}` : '')); }
  else { fail++; console.log(`  ❌ ${name}` + (detail ? `  —  ${detail}` : '')); }
}

const OpenAICompatibleVideoGenerator = require('../src/generators/openaiVideo');
const { createGenerator } = require('../src/generators');
const planCard = require('../src/assistant/planCard');
const pricing = require('../src/pricing');

// ---- fetch 记录器：绝不发真实请求 ----
const origFetch = global.fetch;
let captured = [];
function installFetch(responder) {
  captured = [];
  global.fetch = async (url, init = {}) => {
    captured.push({ url: String(url), init });
    const r = responder ? responder(String(url), init) : { ok: true, status: 200, json: async () => ({ id: 'task_probe_1', status: 'queued' }) };
    return r;
  };
}
function restoreFetch() { global.fetch = origFetch; }

(async () => {
  // ================= [1] 计划卡默认走 WhaleTV 中转 =================
  console.log('\n[1] 计划卡默认模型 / 文案 / 费用');
  const p = planCard.buildPlan({ text: '5 分钟' });
  ok('5 分钟 → 计划卡 ok', p.ok === true, p.ok ? '' : p.code);
  ok('默认模型 = openai-video', p.ok && p.plan.model === 'openai-video', p.ok ? p.plan.model : '');
  ok('标签 = WhaleTV 万相 3.0（中转）', p.ok && p.plan.modelLabel === 'WhaleTV 万相 3.0（中转）', p.ok ? p.plan.modelLabel : '');
  ok('30 段 × 10 秒', p.ok && p.plan.clipCount === 30 && p.plan.clipDurationSec === 10,
    p.ok ? `${p.plan.clipCount} × ${p.plan.clipDurationSec}s` : '');
  ok('预估 ¥180 / $30', p.ok && p.plan.estimate.totalCny === 180 && p.plan.estimate.budget.usd === 30,
    p.ok ? `¥${p.plan.estimate.totalCny} / $${p.plan.estimate.budget.usd}` : '');
  ok('requiresPaymentApproval = true（付费闸门不能失效）', p.ok && p.plan.requiresPaymentApproval === true);
  ok('单价明细按秒计价（¥0.6/s × 10s）', p.ok && /¥0\.6\/s × 10s/.test(String(p.plan.estimate.priceDetail || '')),
    p.ok ? String(p.plan.estimate.priceDetail) : '');

  const p2 = planCard.buildPlan({ text: '用 whale 中转的方式做 5 分钟' });
  ok('口语「whale 中转」→ openai-video', p2.ok && p2.plan.model === 'openai-video', p2.ok ? p2.plan.model : p2.code);
  const p3 = planCard.buildPlan({ text: '用 dashscope 做 5 分钟' });
  ok('口语「dashscope」→ dashscope（不被默认值吃掉）', p3.ok && p3.plan.model === 'dashscope', p3.ok ? p3.plan.model : p3.code);
  const p4 = planCard.buildPlan({ text: '万相 5 分钟' });
  ok('口语「万相」→ dashscope（官方，不是中转）', p4.ok && p4.plan.model === 'dashscope', p4.ok ? p4.plan.model : p4.code);

  // ================= [2] 价目表 =================
  console.log('\n[2] 价目表：openai-video 按秒计价');
  const u720 = pricing.computeUnitPrice({ model: 'openai-video', resolution: '720p', clipDurationSec: 10 });
  ok('720p 10 秒 = ¥6.00', u720.amountPerAttempt === 6, `amountPerAttempt=${u720.amountPerAttempt} (${u720.detail})`);
  ok('720P 单价 ¥0.6/s', u720.unitPrice === 0.6, `unitPrice=${u720.unitPrice}`);
  const u1080 = pricing.computeUnitPrice({ model: 'openai-video', resolution: '1080p', clipDurationSec: 10 });
  ok('1080p 10 秒 = ¥12.00', u1080.amountPerAttempt === 12, `amountPerAttempt=${u1080.amountPerAttempt}`);

  // ================= [3][4] 生成器请求体 =================
  console.log('\n[3] 文生视频请求体：POST {base}/videos {model,prompt,seconds}');
  const gen = new OpenAICompatibleVideoGenerator({ apiKey: 'sk-probe-not-real', baseUrl: 'https://relay.example.test/v1/', modelId: '' });
  installFetch();
  const r1 = await gen.generate('  冰川湖面 夜里极光  ', { duration: 10, resolution: '720p' });
  ok('返回 taskId', r1 && r1.taskId === 'task_probe_1', JSON.stringify(r1));
  ok('只发一次请求', captured.length === 1, 'count=' + captured.length);
  const c1 = captured[0] || { url: '', init: {} };
  ok('URL = {base}/videos（末尾斜杠已去掉）', c1.url === 'https://relay.example.test/v1/videos', c1.url);
  ok('方法 POST', String(c1.init.method || '').toUpperCase() === 'POST', String(c1.init.method));
  ok('Content-Type = application/json', String((c1.init.headers || {})['Content-Type'] || '') === 'application/json');
  ok('带 Bearer 鉴权头', /^Bearer .+/.test(String((c1.init.headers || {}).Authorization || '')), 'authorization 前缀=Bearer（值不打印）');
  let body1 = {};
  try { body1 = JSON.parse(String(c1.init.body || '{}')); } catch (e) { body1 = {}; }
  ok('body.model = wan3.0-video（默认型号）', body1.model === 'wan3.0-video', String(body1.model));
  ok('body.prompt 已 trim 且完整', body1.prompt === '冰川湖面 夜里极光', JSON.stringify(body1.prompt));
  ok('body.seconds = "10"（字符串，中转要求）', body1.seconds === '10', JSON.stringify(body1.seconds));
  ok('body 只含 model/prompt/seconds 三个字段（未验证的字段不乱发）',
    Object.keys(body1).sort().join(',') === 'model,prompt,seconds', Object.keys(body1).join(','));

  console.log('\n[4] seconds 边界');
  for (const [dur, expect, label] of [[15, '15', '15 秒原样'], [60, '30', '60 → 夹到 30'], [undefined, '5', '缺省 → 5']]) {
    installFetch();
    await gen.generate('边界测试', { duration: dur });
    let b = {};
    try { b = JSON.parse(String((captured[0] || {}).init.body || '{}')); } catch (e) { b = {}; }
    ok(`seconds：${label}`, b.seconds === expect, JSON.stringify(b.seconds));
  }

  // 自定义型号
  installFetch();
  const gen2 = new OpenAICompatibleVideoGenerator({ apiKey: 'k', baseUrl: 'https://relay.example.test/v1', modelId: 'wan3.0-video-pro' });
  await gen2.generate('型号测试', { duration: 10 });
  let b2 = {};
  try { b2 = JSON.parse(String((captured[0] || {}).init.body || '{}')); } catch (e) { b2 = {}; }
  ok('配置的 modelId 生效', b2.model === 'wan3.0-video-pro', String(b2.model));

  // ================= [5] 运行时 Key 不降级 Mock =================
  console.log('\n[5] 运行时 Key 不降级 Mock');
  const viaFactory = createGenerator('openai-video', { apiKey: 'sk-runtime-probe', baseUrl: 'https://relay.example.test/v1' });
  ok('带运行时 apiKey → 真生成器（不是 Mock）', viaFactory && viaFactory.name === 'openai-video' && viaFactory.fallbackToMock !== true,
    viaFactory && viaFactory.name);
  const noKey = createGenerator('openai-video', {});
  ok('无 Key 且服务端未配 → 明确降级 Mock 并打标（可被识别）', noKey && noKey.fallbackToMock === true && noKey.requestedModel === 'openai-video',
    noKey && String(noKey.name));

  // ================= [6] 图生视频 multipart =================
  console.log('\n[6] 图生视频：multipart + input_reference');
  installFetch();
  const gen3 = new OpenAICompatibleVideoGenerator({ apiKey: 'k', baseUrl: 'https://relay.example.test/v1' });
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await gen3.generate('图生视频测试', { duration: 10, image: { base64: png1x1, mime: 'image/png', width: 1280, height: 720 } });
  const c3 = captured[0] || { url: '', init: {} };
  ok('图生视频也打 {base}/videos', c3.url === 'https://relay.example.test/v1/videos', c3.url);
  const isForm = c3.init.body && typeof c3.init.body.entries === 'function';
  ok('body 是 multipart（FormData）', !!isForm, isForm ? 'FormData' : typeof c3.init.body);
  let fields = {};
  if (isForm) {
    for (const [k, v] of c3.init.body.entries()) fields[k] = (typeof v === 'string') ? v : `[file:${v && v.size}]`;
  }
  ok('含 input_reference 文件字段', Object.prototype.hasOwnProperty.call(fields, 'input_reference'), JSON.stringify(fields));
  ok('含 size（按图片宽高比 1280x720）', fields.size === '1280x720', String(fields.size));
  ok('含 seconds = 10', fields.seconds === '10', JSON.stringify(fields.seconds));
  ok('Content-Type 由 fetch 自动生成（不手工塞 JSON）',
    !((c3.init.headers || {})['Content-Type']), String((c3.init.headers || {})['Content-Type']));

  // ================= [7] 错误路径 =================
  console.log('\n[7] 错误路径不伪装成功');
  installFetch(() => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad model' } }) }));
  let err1 = null;
  try { await gen.generate('错误路径', { duration: 10 }); } catch (e) { err1 = e; }
  ok('非 2xx → 抛错且带状态码', !!err1 && /400/.test(err1.message), err1 && err1.message.slice(0, 80));

  installFetch(() => ({ ok: true, status: 200, json: async () => ({ object: 'video' }) }));
  let err2 = null;
  try { await gen.generate('缺 id', { duration: 10 }); } catch (e) { err2 = e; }
  ok('响应缺任务 id → 抛错', !!err2 && /任务 id/.test(err2.message), err2 && err2.message.slice(0, 60));

  restoreFetch();
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  restoreFetch();
  console.error('ERR ' + (e && e.stack || e));
  process.exit(2);
});
