// ==========================================================
// NSFW 质检 —— 对抗性审查
//
// 目的不是"跑通一遍证明它好"，而是**故意攻击它**，看能不能骗过它：
//   1. 伪造各种畸形返回，看会不会 fail-open（放行本该拦的）
//   2. 分数越界 / 类型错误 / 字段矛盾
//   3. 截断的 JSON（max_tokens 不够时真实会发生）
//   4. 注入 fetch 模拟真实厂商返回格式
//   5. 确认任何异常路径都是 fail-closed
//
// 通过标准：不仅能识别正常通过，还必须在**每一种攻击下都不放行**。
// ==========================================================

const path = require('path');
const qc = require('../src/qualityChecker');

let pass = 0, fail = 0;
const findings = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; findings.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  — ${detail}` : ''}`); }
}
function critical(cond, name, detail) {
  if (cond) { pass++; console.log(`  🛡️  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; findings.push({ name, detail, critical: true }); console.log(`  🚨 漏洞！${name}${detail ? `  — ${detail}` : ''}`); }
}

// 受测视频（真实文件）—— 动态查找，避免硬编码的文件被清理后测试静默跳过
function findTestVideo() {
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'clips', 'mock_mvev8z9z_i2kbks.mp4'),
    path.join(__dirname, '..', 'output', 'task_mv4r94lq_3cy7_final.mp4'),
    path.join(__dirname, '..', 'output', 'task_mukptvrj_xbjn_final.mp4')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 兜底：clips 目录里任意一个 mp4
  try {
    const dir = path.join(__dirname, '..', 'clips');
    const f = fs.readdirSync(dir).find(x => x.endsWith('.mp4'));
    if (f) return path.join(dir, f);
  } catch (e) {}
  return null;
}
const VIDEO = findTestVideo();

// ============================================================
// A. 解析器攻击：畸形 / 越界 / 矛盾 / 截断
// ============================================================
function testParser() {
  console.log('\n[A] 解析器攻击（_parseNsfwVerdict）');

  const p = (s) => qc._parseNsfwVerdict(s);

  // --- 正常返回必须能解析 ---
  const normal = p('{"nsfw": false, "score": 0.02, "reason": "画面为正常内容"}');
  ok(normal && normal.score === 0.02 && normal.flagged === false, '正常安全返回可解析', JSON.stringify(normal));

  const bad = p('{"nsfw": true, "score": 0.93, "reason": "含裸露内容"}');
  ok(bad && bad.flagged === true, '正常违规返回可解析且标记违规');

  // --- 包 markdown 代码块（真实模型常干）---
  const fenced = p('```json\n{"nsfw": false, "score": 0.01}\n```');
  ok(fenced && fenced.score === 0.01, 'Markdown 代码块包裹能解析');

  // --- 前后有解释文字（prompt 说了不要，但模型常不听）---
  const chatty = p('好的，我分析后结论如下：\n{"nsfw": false, "score": 0.05}\n以上是判断结果。');
  ok(chatty && chatty.score === 0.05, '前后带解释文字能提取 JSON');

  // === 攻击 1：分数越界，必须判「无法解析」→ 由调用方 fail ===
  critical(p('{"nsfw": false, "score": 3.0}') === null,
    '攻击: score=3.0 越界 → 判无法解析（不夹取、不放行）');
  critical(p('{"nsfw": false, "score": -0.5}') === null,
    '攻击: score=-0.5 越界 → 判无法解析');
  critical(p('{"nsfw": false, "score": 85}') === null,
    '攻击: score=85（百分制）→ 判无法解析（不当作 0.85 放行）');

  // === 攻击 2：矛盾字段，必须从严 ===
  const contradiction = p('{"nsfw": true, "score": 0.01}');
  ok(contradiction && contradiction.flagged === true,
    '攻击: nsfw=true 但 score=0.01 → 仍标记违规（不让分数冲掉标记）',
    JSON.stringify(contradiction));

  // === 攻击 3：类型错误 ===
  critical(p('{"nsfw": "false", "score": 0.02}') === null || p('{"nsfw": "false", "score": 0.02}').flagged === false,
    '攻击: nsfw 是字符串 "false" → 不因类型错误而误放行',
    JSON.stringify(p('{"nsfw": "false", "score": 0.02}')));
  ok(p('{"nsfw": false, "score": "0.02"}') !== null,
    '字符串形式的 score "0.02" 能容错解析');

  // === 攻击 4：缺字段 ===
  critical(p('{}') === null, '攻击: 空对象 → 判无法解析（不放行）');
  critical(p('{"reason": "看起来没问题"}') === null,
    '攻击: 只有 reason 没有判定字段 → 判无法解析');

  // === 攻击 5：截断的 JSON（max_tokens 不够时真实发生）===
  critical(p('{"nsfw": false, "score": 0.02, "reason": "画面', ) === null,
    '攻击: 截断的 JSON → 判无法解析（不放行）');

  // === 攻击 6：非 JSON ===
  critical(p('这张图片看起来很正常，没有问题。') === null,
    '攻击: 纯自然语言回复 → 判无法解析');
  critical(p('') === null, '攻击: 空字符串 → 判无法解析');
  critical(p(null) === null, '攻击: null → 判无法解析');

  // === 攻击 7：多个 JSON 对象（lastIndexOf 可能过度捕获）===
  const multi = p('{"nsfw": false, "score": 0.01} 补充说明 {"note": "x"}');
  ok(multi === null || multi.flagged === false,
    '攻击: 多个 JSON 对象 → 不误判为违规', multi === null ? '判无法解析' : '取第一个');
  // 关键：即使取到第二个（note），也不能变成"通过"
  if (multi !== null) {
    critical(multi.score === 0.01, '多对象时不会错取第二个对象的分数字段', JSON.stringify(multi));
  }

  // === 攻击 8：只有 nsfw 没有 score ===
  const onlyFlagTrue = p('{"nsfw": true}');
  ok(onlyFlagTrue && onlyFlagTrue.flagged === true && onlyFlagTrue.score === 1,
    '只有 nsfw:true → score 视为 1 → 拦下', JSON.stringify(onlyFlagTrue));
  const onlyFlagFalse = p('{"nsfw": false}');
  ok(onlyFlagFalse && onlyFlagFalse.flagged === false && onlyFlagFalse.score === 0,
    '只有 nsfw:false → score 视为 0 → 放行', JSON.stringify(onlyFlagFalse));
}

// ============================================================
// B. 阈值边界
// ============================================================
function testThreshold() {
  console.log('\n[B] 阈值边界');
  const t = (v) => qc._resolveNsfwThreshold(v);

  ok(t(0.8) === 0.8, '正常阈值 0.8');
  ok(t(0) === 0, '阈值 0 合法（不过滤，全拦）');
  ok(t(1) === 1, '阈值 1 合法');
  ok(t(-0.1) === 0.8, '负阈值 → 回退 0.8');
  ok(t(1.5) === 0.8, '超过 1 → 回退 0.8');
  ok(t('abc') === 0.8, '非法字符串 → 回退 0.8');
  ok(t(NaN) === 0.8, 'NaN → 回退 0.8');

  // 边界：score 恰好等于阈值，必须算违规（>=）
  const p = qc._parseNsfwVerdict('{"nsfw": false, "score": 0.8}');
  const overThreshold = p.score >= t(0.8);
  ok(overThreshold === true, 'score 恰好等于阈值 0.8 → 算违规（>=，不给边界钻空子）');
}

// ============================================================
// C. 注入 fetch：真实调用链路的对抗测试
// ============================================================
async function testInjectedFetch() {
  console.log('\n[C] 注入 fetch 攻击调用链路');

  // 前置：确认视频存在
  const fs = require('fs');
  if (!fs.existsSync(VIDEO)) {
    console.log('  ⚠️ 跳过：测试视频不存在 ' + VIDEO);
    return;
  }

  const mkFetch = (reply) => async () => ({
    ok: true,
    status: 200,
    json: async () => reply
  });

  const opendeps = { apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', timeoutMs: 20000 };

  // C1: 厂商返回安全结论 → 必须通过
  let r = await qc.checkNSFW(VIDEO, {
    ...opendeps,
    fetchImpl: mkFetch({ choices: [{ message: { content: '{"nsfw": false, "score": 0.02, "reason": "正常画面"}' } }] })
  });
  ok(r.passed === true, 'C1 正常安全返回 → 通过', `score=${r.score}`);

  // C2: 厂商返回违规结论 → 必须拦下
  r = await qc.checkNSFW(VIDEO, {
    ...opendeps,
    fetchImpl: mkFetch({ choices: [{ message: { content: '{"nsfw": true, "score": 0.96, "reason": "含裸露"}' } }] })
  });
  critical(r.passed === false, 'C2 违规返回 → 必须拦下（不能放行）', `passed=${r.passed}, score=${r.score}`);

  // C3: HTTP 401 → 必须 fail-closed
  r = await qc.checkNSFW(VIDEO, {
    ...opendeps,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
  });
  critical(r.passed === false && r.detectorUnavailable === true,
    'C3 HTTP 401 → fail-closed 且标记检测器不可用', `passed=${r.passed}`);

  // C4: 响应里没有 choices → 必须 fail-closed
  r = await qc.checkNSFW(VIDEO, { ...opendeps, fetchImpl: mkFetch({}) });
  critical(r.passed === false, 'C4 响应缺少 choices → fail-closed', `passed=${r.passed}`);

  // C5: 模型返回自由文本（不遵循 JSON 指令）→ 必须 fail-closed
  r = await qc.checkNSFW(VIDEO, {
    ...opendeps,
    fetchImpl: mkFetch({ choices: [{ message: { content: '这个视频看起来很安全，没有问题。' } }] })
  });
  critical(r.passed === false && r.detectorError === true,
    'C5 模型不返回 JSON → fail-closed（不能当"大概是安全的"放行）', `passed=${r.passed}`);

  // C6: fetch 抛异常 → 必须 fail-closed
  r = await qc.checkNSFW(VIDEO, {
    ...opendeps,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });
  critical(r.passed === false, 'C6 网络异常 → fail-closed', `passed=${r.passed}`);

  // C7: 分数越界 → 必须 fail-closed
  r = await qc.checkNSFW(VIDEO, {
    ...opendeps,
    fetchImpl: mkFetch({ choices: [{ message: { content: '{"nsfw": false, "score": 5}' } }] })
  });
  critical(r.passed === false, 'C7 分数越界 → fail-closed（不夹取）', `passed=${r.passed}`);

  // C8: 边界攻击 —— 违规内容但分数刚好低于阈值
  r = await qc.checkNSFW(VIDEO, {
    ...opendeps,
    fetchImpl: mkFetch({ choices: [{ message: { content: '{"nsfw": true, "score": 0.1}' } }] })
  });
  critical(r.passed === false, 'C8 模型标记 nsfw=true 但分数很低 → 仍拦下（置信度不能冲掉标记）',
    `passed=${r.passed}, score=${r.score}`);

  // C9: 合成素材必须走 legitimateSkip，且不能冒充 passed
  r = await qc.checkNSFW(VIDEO, { ...opendeps, syntheticSource: true, fetchImpl: mkFetch({}) });
  ok(r.passed === false && r.legitimateSkip === true && r.skipped === true,
    'C9 合成素材 → legitimateSkip（passed 仍为 false，不冒充通过）',
    JSON.stringify({ passed: r.passed, legitimateSkip: r.legitimateSkip }));
  critical(r.passed !== true, 'C9b 合成素材不得返回 passed:true（否则等于冒充通过）');

  // C10: 无 Key → fail-closed（除非开了演示开关）
  const savedDemo = require('../config').QC.nsfwAllowUnconfigured;
  if (!savedDemo) {
    r = await qc.checkNSFW(VIDEO, { apiKey: '', baseUrl: 'https://x.test/v1', timeoutMs: 1000 });
    critical(r.passed === false && r.detectorUnavailable === true,
      'C10 无 Key → fail-closed', `passed=${r.passed}`);
  } else {
    console.log('     （演示开关为开，跳过 C10 的无 Key 断言）');
  }
}

// ============================================================
// D. 模型名厂商匹配（对抗：各种边角输入）
// ============================================================
async function testModelInference() {
  console.log('\n[D] 模型名厂商匹配攻击');
  const fs = require('fs');
  if (!fs.existsSync(VIDEO)) { console.log('  ⚠️ 跳过'); return; }

  const probe = async (baseUrl, model) => {
    const r = await qc.checkNSFW(VIDEO, { apiKey: '', baseUrl, model, timeoutMs: 500 });
    return r.model;
  };

  ok(await probe('https://dashscope.aliyuncs.com/compatible-mode/v1', '') === 'qwen-vl-max',
    '阿里云 + 空模型 → qwen-vl-max');
  ok(await probe('https://dashscope.aliyuncs.com/compatible-mode/v1', undefined) === 'qwen-vl-max',
    '阿里云 + undefined → qwen-vl-max');
  ok(await probe('https://dashscope.aliyuncs.com/compatible-mode/v1', 'gpt-4o-mini') === 'qwen-vl-max',
    '攻击: 阿里云端点配 gpt-4o-mini → 自动纠正为 qwen-vl-max');
  ok(await probe('https://dashscope.aliyuncs.com/compatible-mode/v1', 'QWEN-VL-MAX') === 'QWEN-VL-MAX',
    '攻击: 大写 QWEN 前缀 → 视为匹配，保留原值');
  ok(await probe('https://api.openai.com/v1', 'qwen-vl-max') === 'gpt-4o-mini',
    '攻击: OpenAI 端点配 qwen → 纠正为 gpt-4o-mini');
  ok(await probe('https://unknown-vendor.test/v1', 'my-model') === 'my-model',
    '未知端点 → 不瞎猜，保留用户指定');
  ok(await probe('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-vl-plus') === 'qwen3-vl-plus',
    '用户填 qwen3-vl-plus → 保持（qwen 前缀匹配）');
  ok(await probe('https://dashscope.aliyuncs.com/compatible-mode/v1/', 'qwen-vl-plus') === 'qwen-vl-plus',
    '攻击: 地址末尾带斜杠 → 不影响模型匹配');
}

// ============================================================
// E. 配置漂移审查（静态：代码与注释/契约是否一致）
// ============================================================
function testConfigDrift() {
  console.log('\n[E] 配置漂移审查');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'qualityChecker.js'), 'utf8');

  // checkContentMatch 应该也用 MULTIMODAL_API_KEY
  const cmStart = src.indexOf('async checkContentMatch');
  const cmBody = src.slice(cmStart, cmStart + 1200);
  const usesMultimodalKey = /config\.MULTIMODAL_API_KEY/.test(cmBody);
  critical(usesMultimodalKey,
    'checkContentMatch 使用 MULTIMODAL_API_KEY（注释承诺了但代码没做 → 用户填了多模态 Key 也无效）');

  const usesVendorInfer = /_resolveVisionModel/.test(cmBody);
  critical(usesVendorInfer,
    'checkContentMatch 也做厂商模型匹配（否则阿里云端点仍会配 gpt-4o-mini）');

  // 两条视觉链路必须共用同一个解析器，避免以后又各写一份、再漂移
  const occurrences = src.split('_resolveVisionModel').length - 1;
  ok(occurrences >= 3,
    '两条视觉链路共用同一个模型解析器（定义 1 处 + 调用 2 处）',
    `出现 ${occurrences} 次`);
}

// ============================================================
// F. max_tokens 容量审查
// ============================================================
function testMaxTokens() {
  console.log('\n[F] max_tokens 容量审查（长视频会截断）');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'qualityChecker.js'), 'utf8');

  const mt = src.match(/max_tokens:\s*(\d+)/);
  const maxTokens = mt ? Number(mt[1]) : null;
  ok(maxTokens !== null, '找到 max_tokens 配置', String(maxTokens));

  // 估算：30 帧时 frames 数组的 JSON 长度
  const sampleFrame = '{"index":29,"nsfw":false,"score":0.02},';
  const framesJson = sampleFrame.repeat(30);
  const full = '{"nsfw":false,"score":0.02,"reason":"画面为正常内容","frames":[' + framesJson + ']}';
  // 粗估 token：中文按 1 字≈1.5token，英文/符号按 4 字符≈1token
  const estTokens = Math.ceil(full.length / 3);
  const enough = maxTokens !== null && maxTokens >= estTokens;
  critical(enough,
    'max_tokens 足以容纳 30 帧的完整 JSON（不足会导致截断→解析失败→整条任务判 fail）',
    `需要约 ${estTokens} tokens，配置 ${maxTokens}`);
}

// ============================================================
async function main() {
  console.log('='.repeat(70));
  console.log('NSFW 质检 —— 对抗性审查');
  console.log('目标：不是证明它好，而是看能不能骗过它');
  console.log('='.repeat(70));

  testParser();
  testThreshold();
  await testInjectedFetch();
  await testModelInference();
  testConfigDrift();
  testMaxTokens();

  console.log('\n' + '='.repeat(70));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (findings.length) {
    console.log('\n发现的缺陷（按严重度）：');
    findings.forEach(f => console.log(`  ${f.critical ? '🚨 严重' : '⚠️ 一般'}  ${f.name}`));
  }
  console.log('='.repeat(70));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('审查异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
