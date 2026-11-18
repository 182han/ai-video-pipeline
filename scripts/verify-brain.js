// ==========================================
// 验收：小智大脑 C1「理解」契约（2026-11-18 S1）
// ------------------------------------------------------------
// 全部用 stub fetch，**不发任何真实请求、不花钱**。
// 覆盖：JSON 提取 / 输出校验 / 三道失败路径（无 Key、HTTP 错、坏 JSON）/
//       工具白名单 / temperature 与 response_format 透传 / 与规则层比对。
// ==========================================
'use strict';

const brain = require('../src/assistant/brain');
const llm = require('../src/services/llmService');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
}

// ---------- stub fetch ----------
const realFetch = global.fetch;
let lastReq = null;
function stubFetch(handler) {
  global.fetch = async (url, init) => {
    lastReq = { url, init, body: init && init.body ? JSON.parse(init.body) : null };
    return handler(url, init);
  };
}
function restoreFetch() { global.fetch = realFetch; }
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => [] },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  };
}
function llmReply(content) {
  return fakeResponse(200, { choices: [{ message: { content } }] });
}

const OPTS = { apiKey: 'sk-test-SECRET-123', baseUrl: 'https://relay.example/v1', model: 'deepseek-chat' };

(async () => {
  console.log('小智大脑 · C1 理解契约验收\n');

  console.log('[1] JSON 提取（容忍围栏与废话）');
  ok('纯 JSON', brain.extractJson('{"intent":"status"}') !== null);
  ok('```json 围栏', brain.extractJson('```json\n{"intent":"status"}\n```') !== null);
  ok('前后有废话', brain.extractJson('好的，结果是：{"intent":"status"} 以上') !== null);
  ok('非 JSON → null', brain.extractJson('我不知道') === null);
  ok('空串 → null', brain.extractJson('') === null);

  console.log('\n[2] 输出校验（不合规一律判失败）');
  ok('合法输出通过',
    brain.validateOutput({ intent: 'plan_edit', confidence: 0.9, slots: { segmentIndex: 2 }, clarify: null }).ok);
  ok('白名单外 intent 被拒',
    brain.validateOutput({ intent: 'delete_everything' }).error === 'INTENT_NOT_ALLOWED');
  ok('clarify 不给问题被拒',
    brain.validateOutput({ intent: 'clarify', clarify: '' }).error === 'CLARIFY_EMPTY');
  {
    const v = brain.validateOutput({ intent: 'plan_edit', confidence: 5, slots: { segmentIndex: 1, hack: 'x' } });
    ok('confidence 裁剪到 1', v.confidence === 1);
    ok('未知槽位被丢弃', v.slots.segmentIndex === 1 && v.slots.hack === undefined);
  }

  console.log('\n[3] 调用链路：成功 + 三种失败（都不抛异常）');
  stubFetch(() => llmReply('{"intent":"plan_scenes","confidence":0.88,"slots":{},"clarify":null,"reason":"只读查看场景卡"}'));
  {
    const r = await brain.understand('场景卡看一下', { ...OPTS, lang: 'zh' });
    ok('正常返回 ok', r.ok === true && r.intent === 'plan_scenes');
    ok('请求体带 temperature=0.1（分类要稳）', lastReq.body.temperature === 0.1);
    ok('system prompt 点名了「场景卡看一下」这种语序', /场景卡看一下/.test(lastReq.body.messages[0].content));
  }

  stubFetch(() => llmReply('{"intent":"prompt_view"}'));
  {
    const r = await brain.understand('提示词呢', { ...OPTS });
    ok('白名单外 intent → 失败而非猜', r.ok === false && r.failure.kind === 'INTENT_NOT_ALLOWED');
  }

  stubFetch(() => llmReply('这不是 JSON'));
  {
    const r = await brain.understand('随便说点什么', { ...OPTS });
    ok('坏 JSON → BAD_JSON', r.ok === false && r.failure.kind === 'BAD_JSON');
  }

  stubFetch(() => fakeResponse(403, { error: { message: '当前分组下该模型无权限: deepseek-chat' } }));
  {
    const r = await brain.understand('进度', { ...OPTS });
    const detail = JSON.stringify(r.failure || {});
    ok('HTTP 403 → 结构化 failure', r.ok === false && r.failure.kind === 'HTTP' && r.failure.status === 403);
    ok('失败详情里没有泄漏 Key', detail.indexOf('sk-test-SECRET-123') === -1);
  }

  restoreFetch();
  {
    const r = await brain.understand('进度', { apiKey: '', baseUrl: OPTS.baseUrl, model: OPTS.model });
    ok('无 Key → NO_KEY（不发请求、不抛）', r.ok === false && r.failure.kind === 'NO_KEY');
  }

  console.log('\n[4] response_format 透传（可选，不传则完全不变）');
  stubFetch(() => llmReply('{"intent":"status","confidence":0.9}'));
  {
    await brain.understand('进度', { ...OPTS, responseFormat: { type: 'json_object' } });
    ok('传了 response_format 就写进请求体', lastReq.body.response_format && lastReq.body.response_format.type === 'json_object');
  }
  stubFetch(() => llmReply('{"intent":"status","confidence":0.9}'));
  {
    await brain.understand('进度', { ...OPTS });
    ok('没传就不出现该字段（向后兼容）', lastReq.body.response_format === undefined);
  }
  restoreFetch();

  console.log('\n[5] 中英 prompt 各自成立');
  ok('中文 prompt 含「理解层」', /理解层/.test(brain.buildSystemPrompt('zh', {})));
  ok('英文 prompt 含 understanding layer', /understanding layer/i.test(brain.buildSystemPrompt('en', {})));
  ok('中文 prompt 点名「提示词呢」', /提示词呢/.test(brain.buildSystemPrompt('zh', {})));
  ok('无计划/有计划都写进 prompt',
    /没有计划卡/.test(brain.buildSystemPrompt('zh', { hasPlan: false }))
    && /有一版已排好的计划/.test(brain.buildSystemPrompt('zh', { hasPlan: true })));

  console.log('\n[6] 与规则层比对（影子期的三个结论）');
  const same = brain.compare('status', { ok: true, intent: 'status' });
  ok('一致 → same', same.mode === 'same');
  const diff = brain.compare('create', { ok: true, intent: 'plan_edit' });
  ok('不一致 → diff', diff.mode === 'diff' && diff.rule === 'create' && diff.brain === 'plan_edit');
  const unsure = brain.compare('create', { ok: true, intent: 'clarify', clarify: '你是想改还是重排？' });
  ok('大脑拿不准 → brain_unsure', unsure.mode === 'brain_unsure');
  const down = brain.compare('create', { ok: false, failure: { kind: 'NO_KEY' } });
  ok('大脑不可用 → brain_unavailable', down.mode === 'brain_unavailable');

  console.log('\n[7] 白名单与 memory 的意图集合对齐（不新增能力）');
  const mem = require('../src/assistant/memory');
  const probe = ['进度', '10 分钟极光', '提示词呢', '场景卡看一下', '换一组', '确认生成吗', '上一支视频'];
  const seen = new Set(probe.map((t) => mem.classify(t).intent));
  // 注意：规则层的 `unknown` **故意不在**大脑白名单里。
  // 规则层"没听懂"的语义，在大脑里对应 `clarify`（反问），这才是设计意图。
  const missing = [...seen].filter((i) => i !== 'unknown' && brain.INTENT_NAMES.indexOf(i) === -1);
  ok('规则层产出的（除 unknown 外的）意图都在大脑白名单里', missing.length === 0, '缺: ' + missing.join(','));
  ok('unknown 有意不在白名单（对应 clarify）',
    brain.INTENT_NAMES.indexOf('unknown') === -1 && brain.INTENT_NAMES.indexOf('clarify') !== -1);

  console.log('\n================================================================');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('================================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  restoreFetch();
  console.log('\n验证异常: ' + (e && e.message ? e.message : e));
  console.log(e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : '');
  process.exit(1);
});
