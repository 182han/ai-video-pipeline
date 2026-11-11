// ============================================================
// 提示词助手「失败原因可诊断」验收
// ------------------------------------------------------------
// 背景（2026-11-10，两起连环事故，都因错误信息丢失而被拖长）：
//   ① 前端读错 localStorage 键名 → Base URL 为空 → 请求发到 api.openai.com
//      → fetch failed；后端只回「请检查网络或 API Key」，用户照着查了两轮。
//   ② 地址修好后真因是「模型名不在中转的可用列表」→ HTTP 403，同样被那句话掩盖。
//
// 本脚本锁住三件事：
//   1) llmService.chatMulti 把失败分类返回（HTTP/NETWORK/TIMEOUT/EMPTY/BAD_JSON/NO_KEY），
//      且 detail 脱敏（绝不含 Key）；
//   2) verifyModel 能判定「模型名不在 /models 列表」——即事故②的检测手段；
//   3) server.js / assistant.js 把这些字段接到气泡上（静态接线断言）。
//
// 全部用 stub fetch，**不发任何真实请求、不花钱**。
// 用法：node scripts/verify-assistant-diagnostics.js
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const ASSISTANT = path.join(ROOT, 'web', 'src', 'components', 'assistant.js');
const SERVICE = path.join(ROOT, 'src', 'services', 'llmService.js');

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}

// NO_KEY 用例要确定性：先清掉 .env 可能带入的 Key，再加载被测模块
const config = require(path.join(ROOT, 'config'));
config.OPENAI_API_KEY = '';
config.OPENAI_BASE_URL = 'https://env-fallback.example/v1';
config.OPENAI_MODEL = 'env-default-model';
const llm = require(path.join(ROOT, 'src', 'services', 'llmService'));

const realFetch = globalThis.fetch;
let calls = [];
function stubFetch(fn) {
  calls = [];
  globalThis.fetch = async (url, opt) => { calls.push({ url, opt }); return fn(url, opt); };
}
function restoreFetch() { globalThis.fetch = realFetch; }

function fakeResponse({ status = 200, body, json } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body)),
    json: async () => {
      if (json instanceof Error) throw json;
      if (json !== undefined) return json;
      return JSON.parse(typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body));
    },
    headers: { get: () => 'application/json' }
  };
}

// 故意拼出来而不是写成字面量：这个值只是"要被脱敏的假 Key"，
// 避免源码里出现形如真实 Key 的连续字面量（密钥扫描会报警）。
const SECRET = ['sk', 'fixture', 'not', 'real', '0000'].join('-');
const OPTS = { apiKey: SECRET, baseUrl: 'https://relay.example/v1/', model: 'deepseek-chat' };

(async () => {
  console.log('================================================================');
  console.log('提示词助手 · 失败原因可诊断验收');
  console.log('================================================================');

  // ---------------- 1. chatMulti 成功路径 ----------------
  console.log('\n[1] chatMulti：成功路径');
  stubFetch(() => fakeResponse({ json: { choices: [{ message: { content: '  你好，先问一个问题  ' } }] } }));
  let r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
  check(r && typeof r === 'object', '返回 { text, failure } 对象（不再只返回字符串/null）');
  check(r.text === '你好，先问一个问题', '正文 trim 后返回', JSON.stringify(r.text));
  check(r.failure === null, '成功时 failure 为 null');
  check(calls.length === 1, '只发了一次请求');
  check(calls[0].url === 'https://relay.example/v1/chat/completions',
    'Base URL 末尾斜杠被归一（不产生 //）', calls[0].url);
  check(JSON.parse(calls[0].opt.body).model === 'deepseek-chat', '请求体带 model');
  check(String(calls[0].opt.headers.Authorization) === 'Bearer ' + SECRET, '请求头带 Bearer Key（只在此断言，不落日志）');

  // ---------------- 2. HTTP 失败分类 ----------------
  console.log('\n[2] chatMulti：HTTP 失败带状态码与厂商原文');
  stubFetch(() => fakeResponse({
    status: 403,
    body: { error: { message: '当前分组下该模型无权限: deepseek-chat' } }
  }));
  r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
  check(r.text === null && r.failure && r.failure.kind === 'HTTP', 'kind=HTTP');
  check(r.failure.status === 403, '带 status=403');
  check(/无权限/.test(r.failure.detail), 'detail 保留厂商原文（可据此判断原因）', r.failure.detail);
  check(r.failure.url === 'https://relay.example/v1/chat/completions', 'failure 带实际请求地址');
  check(r.failure.model === 'deepseek-chat', 'failure 带模型名');

  for (const status of [401, 404, 429, 500]) {
    stubFetch(() => fakeResponse({ status, body: { error: { message: 'x' } } }));
    const rr = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
    check(rr.failure && rr.failure.kind === 'HTTP' && rr.failure.status === status, `HTTP ${status} 被如实分类`);
  }

  // ---------------- 3. 脱敏 ----------------
  console.log('\n[3] 脱敏：Key 不得出现在 detail（会进响应体与日志）');
  stubFetch(() => fakeResponse({
    status: 401,
    body: { error: { message: `Incorrect API key provided: ${SECRET}`, hint: `Authorization: Bearer ${SECRET}` } }
  }));
  r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
  check(!r.failure.detail.includes(SECRET), 'detail 不含完整 Key');
  check(/\*\*\*/.test(r.failure.detail), 'detail 用 *** 顶替', r.failure.detail);
  check(/Incorrect API key/.test(r.failure.detail), '保留可判断的原文，而不是整段吞掉');

  // ---------------- 4. 网络 / 超时 / 空正文 / 非 JSON ----------------
  console.log('\n[4] 连接层与响应层失败分类');
  stubFetch(() => {
    const e = new TypeError('fetch failed');
    e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    throw e;
  });
  r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
  check(r.failure && r.failure.kind === 'NETWORK', 'kind=NETWORK');
  check(/UND_ERR_CONNECT_TIMEOUT/.test(r.failure.detail), 'detail 带底层错误码（DNS/连接超时可区分）', r.failure.detail);

  stubFetch(() => {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    throw e;
  });
  r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
  check(r.failure && r.failure.kind === 'TIMEOUT', 'kind=TIMEOUT');
  check(r.failure.timeoutMs === 30000, '带 timeoutMs=30000（提示语据此算秒数）');

  stubFetch(() => fakeResponse({ json: { choices: [{ message: { content: '   ' } }] } }));
  r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
  check(r.failure && r.failure.kind === 'EMPTY', 'kind=EMPTY（200 但正文为空，不再当成"正常但没话说"）');

  stubFetch(() => fakeResponse({ json: new Error('Unexpected token < in JSON') }));
  r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], OPTS);
  check(r.failure && r.failure.kind === 'BAD_JSON', 'kind=BAD_JSON（地址填成网页时的典型症状）');

  // ---------------- 5. 无 Key 不发请求 ----------------
  console.log('\n[5] 没有 Key：不发请求，直接返回 NO_KEY');
  stubFetch(() => { throw new Error('不应发起请求'); });
  r = await llm.chatMulti('sys', [{ role: 'user', content: 'hi' }], { ...OPTS, apiKey: '' });
  check(r.failure && r.failure.kind === 'NO_KEY', 'kind=NO_KEY');
  check(calls.length === 0, 'fetch 未被调用（不浪费一次网络往返）');

  // ---------------- 6. verifyModel：事故②的检测手段 ----------------
  console.log('\n[6] verifyModel：/models 只回 200 不够，还要核对模型名');
  let v = llm.verifyModel({ model: 'deepseek-v4-flash-0731', models: ['deepseek-v4-flash-0731'] });
  check(v.ok === true && v.checked === true, '模型在列表里 → ok/checked');

  v = llm.verifyModel({ model: 'deepseek-chat', models: ['deepseek-v4-flash-0731'] });
  check(v.ok === false && v.checked === true, '复刻事故②：模型不在列表 → 明确失败');
  check(/deepseek-v4-flash-0731/.test(v.message), '失败信息列出可用模型（可照着改）', v.message);
  check(/deepseek-v4-flash-0731/.test((v.near || []).join(',')), '相近模型名单独给出（省一次猜）');

  v = llm.verifyModel({ model: 'anything', models: [] });
  check(v.ok === true && v.checked === false, '拿不到列表 → 不可判定（不谎报可用，也不误报失败）');

  v = llm.verifyModel({ model: '', models: ['env-default-model'], fallbackModel: 'env-default-model' });
  check(v.ok === true && v.model === 'env-default-model', '模型留空 → 用回落默认值判定');
  check(/回落/.test(v.message), '并明确告诉用户「用的是回落默认值」');

  v = llm.verifyModel({ model: '', models: [], fallbackModel: '' });
  check(v.ok === false, '既没填模型也没有默认值 → 判失败（运行时必挂）');

  // ---------------- 6b. judgeModelsPayload：测试连接的最终结论 ----------------
  console.log('\n[6b] judgeModelsPayload：把 /models 响应判成「连接成功/失败」');
  let jp = llm.judgeModelsPayload({
    data: { data: [{ id: 'm-a' }, { id: 'm-b' }] },
    model: 'm-a', url: 'https://relay.example/v1/models'
  });
  check(jp.success === true && jp.modelChecked === true, '模型在列表 → success + modelChecked');
  check(jp.urlUsed === 'https://relay.example/v1', '回显实际请求地址（去掉 /models）', jp.urlUsed);

  jp = llm.judgeModelsPayload({
    data: { data: [{ id: 'deepseek-v4-flash-0731' }] },
    model: 'deepseek-chat', url: 'https://agglm.whaletv.com/v1/models'
  });
  check(jp.success === false, '复刻事故②：模型不在列表 → success:false（不再假绿）');
  check(/deepseek-v4-flash-0731/.test(jp.error), '错误里列出可用模型', jp.error);
  check(jp.checkedModel === true, '带 checkedModel 标记');

  jp = llm.judgeModelsPayload({
    data: { models: ['m-a', 'm-b'] }, model: 'm-b', url: 'https://x/v1/models'
  });
  check(jp.success === true && jp.modelChecked === true, '兼容 {models:[...]} 形态的网关');

  jp = llm.judgeModelsPayload({ data: {}, text: '<!DOCTYPE html><html>app</html>', model: 'm-a', url: 'https://x/v1/models' });
  check(jp.success === false, '200 但返回 HTML → 判失败');
  check(/Base URL 可能填成了网页地址/.test(jp.error), '错误直指「地址填成了网页」', jp.error);

  jp = llm.judgeModelsPayload({ data: { data: [] }, model: 'm-a', url: 'https://x/v1/models' });
  check(jp.success === true && jp.modelChecked === false, '列表为空 → 判成功但标明「未校验」（不可判定 ≠ 不可用）');
  check(/无法校验/.test(jp.message), '消息里说清"无法校验模型名"', jp.message);

  // ---------------- 7. describeFailure：每种原因给可执行建议 ----------------
  console.log('\n[7] describeFailure：失败原因 → 用户能照着做的话');
  const d403 = llm.describeFailure({ kind: 'HTTP', status: 403, model: 'deepseek-chat', detail: 'denied' });
  check(/403/.test(d403.hint) && /模型/.test(d403.hint), '403 点名状态码与模型（事故②的提示语）', d403.hint);
  check(d403.detail === 'denied', 'detail 原样透传');
  const d404 = llm.describeFailure({ kind: 'HTTP', status: 404 });
  check(/\/v1/.test(d404.hint), '404 提示检查 /v1 与模型名');
  const d429 = llm.describeFailure({ kind: 'HTTP', status: 429 });
  check(/余额|限流/.test(d429.hint), '429 提示限流/余额');
  const dTimeout = llm.describeFailure({ kind: 'TIMEOUT', timeoutMs: 30000 });
  check(/30 秒/.test(dTimeout.hint), 'TIMEOUT 提示 30 秒（按实际配置算，不写死）');
  const dNet = llm.describeFailure({ kind: 'NETWORK', detail: 'fetch failed' });
  check(/代理|写错/.test(dNet.hint), 'NETWORK 提示地址/代理（事故①的提示语）');
  const dEmpty = llm.describeFailure({ kind: 'EMPTY' });
  check(/空正文/.test(dEmpty.hint), 'EMPTY 提示空正文/审核');
  const dJson = llm.describeFailure({ kind: 'BAD_JSON' });
  check(/网页地址/.test(dJson.hint), 'BAD_JSON 提示地址可能填成网页');
  const dUnknown = llm.describeFailure(null);
  check(dUnknown && typeof dUnknown.hint === 'string' && dUnknown.hint.length > 0, '未知识别：也有话可说，不静默');

  // ---------------- 7b. 流式（方案一）：边收边吐 ----------------
  console.log('\n[7b] 流式：chatMultiStream + message 前缀增量解析');
  function sseResponse(chunks, { status = 200 } = {}) {
    const enc = new TextEncoder();
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'text/event-stream' },
      text: async () => chunks.join(''),
      body: new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        }
      })
    };
  }
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const answer = '{"ready": false, "message": "好的，先定主体。你选 A 还是 B？", "prompt": null}';

  // 把 answer 切成几块，模拟逐字到达
  const parts = [answer.slice(0, 12), answer.slice(12, 40), answer.slice(40)];
  stubFetch(() => sseResponse([
    sse({ choices: [{ delta: { reasoning_content: '想一想' } }] }),
    ...parts.map((p) => sse({ choices: [{ delta: { content: p } }] })),
    'data: [DONE]\n\n'
  ]));
  const snapshots = [];
  const reasoning = [];
  let rs = await llm.chatMultiStream('sys', [{ role: 'user', content: 'hi' }], OPTS, {
    onContent: (t) => snapshots.push(t),
    onReasoning: (chars) => reasoning.push(chars)
  });
  check(rs.text === answer, '流式正文被完整拼回');
  check(rs.failure === null, '流式成功时 failure=null');
  check(snapshots.length >= 2, 'onContent 多次回调（是逐块而非一次性）', `${snapshots.length} 次`);
  check(snapshots[snapshots.length - 1] === answer, '最后一次回调是完整正文');
  check(reasoning.length === 1 && reasoning[0] === 3, 'onReasoning 报出思考字符数');
  check(typeof rs.elapsedMs === 'number' && typeof rs.firstTokenMs === 'number', '返回 elapsedMs / firstTokenMs');
  check(calls[0].url === 'https://relay.example/v1/chat/completions', '流式请求地址同样归一');
  check(JSON.parse(calls[0].opt.body).stream === true, '请求体带 stream:true');

  // message 前缀增量解析：气泡里不能出现 {"ready": false, "mess
  const rawFull = '{"ready": false, "message": "好的，先定主体。你选 A 还是 B？", "prompt": null}';
  check(llm.extractMessagePrefix(rawFull) === '好的，先定主体。你选 A 还是 B？', '从完整 JSON 里取出 message');
  check(llm.extractMessagePrefix('{"ready": false, "message": "好的，先') === '好的，先',
    '只有半截 JSON 时也能给出已生成的前缀');
  check(llm.extractMessagePrefix('{"message": "a\\"b"}') === 'a"b', '转义引号正确还原');
  check(llm.extractMessagePrefix('{"message": "\\u4f60"}') === '你', '\\uXXXX 正确还原');
  check(llm.extractMessagePrefix('{"message": "前\\u4f') === '前', '\\u 只到一半时停住，不吐乱码');
  check(llm.extractMessagePrefix('{"message": "前\\') === '前', '末尾孤立反斜杠时停住');
  check(llm.extractMessagePrefix('{"ready": true}') === '', '没有 message 字段时返回空串');

  stubFetch(() => sseResponse([sse({ choices: [{ delta: {} }] })], { status: 200 }));
  rs = await llm.chatMultiStream('sys', [{ role: 'user', content: 'hi' }], OPTS, {});
  check(rs.failure && rs.failure.kind === 'EMPTY', '流式 200 但正文为空 → EMPTY');

  stubFetch(() => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}', headers: { get: () => 'application/json' } }));
  rs = await llm.chatMultiStream('sys', [{ role: 'user', content: 'hi' }], OPTS, {});
  check(rs.failure && rs.failure.kind === 'HTTP' && rs.failure.status === 401, '流式 401 仍按 HTTP 分类');

  // ---------------- 8. 接线（静态） ----------------
  console.log('\n[8] 接线：后端把字段送回、前端把字段显示出来');
  const serverSrc = fs.readFileSync(SERVER, 'utf8');
  const assistantSrc = fs.readFileSync(ASSISTANT, 'utf8');
  const serviceSrc = fs.readFileSync(SERVICE, 'utf8');

  check(/llmService\.judgeModelsPayload\(/.test(serverSrc), '测试连接调用 judgeModelsPayload（判定逻辑可离线验收）');
  check(/modelChecked: verdict\.checked/.test(serviceSrc), '成功时回 modelChecked（前端可区分"没校验"与"校验通过"）');
  check(/Array\.isArray\(data\.models\)/.test(serviceSrc), '兼容 {models:[]} 形态的模型列表（不只 data）');
  check(/地址返回的不是 JSON，Base URL 可能填成了网页地址/.test(serviceSrc),
    '拦「200 但返回 HTML」（否则会走到"列表为空 → 判成功"的假绿）');
  check(/reason: failure && failure\.kind/.test(serverSrc), '助手失败响应带 reason');
  check(/status: failure && failure\.status/.test(serverSrc), '助手失败响应带 status');
  check(/url: failure && failure\.url/.test(serverSrc), '助手失败响应带实际请求地址');
  check(/hint: info\.hint/.test(serverSrc), '助手失败响应带 hint');
  check(/detail: info\.detail/.test(serverSrc), '助手失败响应带 detail');
  check(/message: '助手没有响应，请检查网络或 API Key 后重试'/.test(serverSrc),
    '首行文案保持不变（其余字段是新增，不破坏旧调用方）');
  check(!/const raw = await llmService\.chatMulti/.test(serverSrc),
    '调用点已改为解构 { text, failure }（防止回退成旧签名）');
  check(!/describeLlmFailure/.test(serverSrc), '描述函数只在 llmService 里一份（没有重复实现）');

  check(/j\.hint/.test(assistantSrc), '气泡渲染 hint');
  check(/实际请求/.test(assistantSrc), '气泡显示实际请求地址');
  check(/j\.status/.test(assistantSrc), '气泡显示 HTTP 状态码');
  check(/j\.detail/.test(assistantSrc), '气泡显示脱敏后的厂商原文');

  check(/verifyModel\(/.test(serviceSrc), 'llmService 提供 verifyModel');
  check(/describeFailure\(/.test(serviceSrc), 'llmService 提供 describeFailure');
  check(/scrubSecret/.test(serviceSrc), '出口统一脱敏');

  // 流式接线（方案一）
  check(/req\.body\.stream === true/.test(serverSrc), '后端识别 stream:true（老前端不带该字段仍走整段返回）');
  check(/x-ndjson/.test(serverSrc), '流式响应用 NDJSON（POST 用不了 EventSource）');
  check(/streamAssistant\(/.test(serverSrc), '流式分支调用 streamAssistant');
  check(/json\(buildAssistantReply\(raw\)\)/.test(serverSrc) && /\.\.\.buildAssistantReply\(/.test(serverSrc),
    '整段与流式共用 buildAssistantReply（两条路径判定不会走岔）');
  check(/llmService\.extractMessagePrefix\(/.test(serverSrc), '服务端只吐 message 前缀（不把 JSON 脚手架怼到气泡）');
  check(/type: 'final'/.test(serverSrc) && /type: 'message'/.test(serverSrc), '事件类型 message/final 齐全');
  check(/type: 'error'/.test(serverSrc), '失败也以 error 事件回到前端（流式不会卡住）');

  check(/stream: true/.test(assistantSrc), '前端请求带 stream:true');
  check(/getReader\(\)/.test(assistantSrc), '前端读流（getReader）');
  check(/ndjson/.test(assistantSrc), '前端按 content-type 判断是否流式（不认就回退）');
  check(/failureText\(/.test(assistantSrc), '流式与整段两条路径共用失败气泡格式');
  check(/正在想…/.test(assistantSrc), '思考期仍有文字反馈');
  check(/已 /.test(assistantSrc), '思考期显示已等待秒数（不再是死的三个点）');

  restoreFetch();

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  restoreFetch();
  console.error('验收脚本自身异常:', e);
  process.exit(1);
});
