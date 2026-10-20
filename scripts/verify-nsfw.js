#!/usr/bin/env node
// ==========================================
// NSFW 检测自测脚本（研发自检用，不参与运行时）
// ==========================================
// 用途：在「没有真实多模态 Key」或「不调用真实网络」的前提下，
//       用注入的 fetchImpl 覆盖 NSFW 检测的全部判定分支，含负向用例。
//
// 运行：
//   cd app && node scripts/verify-nsfw.js
//   cd app && node scripts/verify-nsfw.js output/task_xxx_final.mp4   # 指定样片
//
// 退出码：全部用例通过 -> 0；任一失败 -> 1
// ==========================================

const path = require('path');
const qc = require('../src/qualityChecker');

const VIDEO = process.argv[2] || path.join('output', 'task_mv4v7qp2_m8r0_final.mp4');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

// 构造一个「假的多模态服务」，按需返回不同响应
function fakeFetch({ status = 200, body = '', delayMs = 0, throwError = null } = {}) {
  return async (url, init) => {
    if (throwError) throw throwError;
    if (delayMs > 0) {
      // 模拟慢响应：使用传入的 abort signal，超时会真实触发
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => text
    };
  };
}

// 包装成 OpenAI chat/completions 响应
function llmResponse(content) {
  return { choices: [{ message: { content } }] };
}

function nsfwJson(obj) {
  return llmResponse(JSON.stringify(obj));
}

async function main() {
  console.log('=== NSFW 检测自测 ===');
  console.log('样片:', VIDEO);
  console.log('');

  // ---------- 0. 基础登记 ----------
  console.log('[0] 登记与接线');
  check('QC_ITEMS 里登记了 nsfw 项', qc.getQCItems().some(i => i.key === 'nsfw'));
  check('checkNSFW 是函数', typeof qc.checkNSFW === 'function');
  check('默认阈值 0.8', qc._resolveNsfwThreshold(undefined) === 0.8);
  check('非法阈值回退 0.8', qc._resolveNsfwThreshold(5) === 0.8 && qc._resolveNsfwThreshold('abc') === 0.8);
  check('显式阈值优先', qc._resolveNsfwThreshold(0.6) === 0.6);

  // ---------- 1. 无 Key 降级（负向核心） ----------
  console.log('');
  console.log('[1] 无 Key');
  const noKey = await qc.checkNSFW(VIDEO, { apiKey: '' });
  console.log('    ->', JSON.stringify(noKey));
  check('passed === false', noKey.passed === false);
  check('detectorUnavailable === true', noKey.detectorUnavailable === true);
  check('不是 skipped（不许走「跳过=通过」老路）', noKey.skipped !== true);
  check('reason 说明未执行', /未执行/.test(noKey.reason) && /Key/.test(noKey.reason));

  // ---------- 2. 服务不可用 / 非 2xx ----------
  console.log('');
  console.log('[2] 服务异常');
  const http500 = await qc.checkNSFW(VIDEO, { apiKey: 'k', fetchImpl: fakeFetch({ status: 500, body: '{}' }) });
  check('HTTP 500 -> passed=false', http500.passed === false);
  check('HTTP 500 -> reason 提到失败', /失败|未执行/.test(http500.reason), http500.reason);

  // 403 模型未授权：必须把状态码与上游报文带出来，
  // 否则会被误读成「网络超时」（实测踩过：用户以为是网络问题，实际是模型没开通）
  const http403 = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    baseUrl: 'https://wid.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    fetchImpl: fakeFetch({
      status: 403,
      body: JSON.stringify({ error: { message: 'Model access denied.', type: 'Model.AccessDenied' } })
    })
  });
  check('HTTP 403 -> passed=false', http403.passed === false);
  check('403 的 reason 带出状态码', /HTTP 403/.test(http403.reason), http403.reason);
  check('403 的 reason 带出上游报文', /access denied|AccessDenied/i.test(http403.reason), http403.reason);
  check('403 附带模型未授权提示', typeof http403.hint === 'string' && /开通|授权/.test(http403.hint), http403.hint);
  check('403 的 upstream 记录了状态码', !!http403.upstream && http403.upstream.status === 403);

  const netErr = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ throwError: new Error('ECONNREFUSED') })
  });
  check('网络异常 -> passed=false', netErr.passed === false, netErr.reason);

  // ---------- 3. 超时 ----------
  console.log('');
  console.log('[3] 超时');
  const timeout = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    timeoutMs: 300,
    fetchImpl: fakeFetch({ delayMs: 5000, body: nsfwJson({ nsfw: false, score: 0.01 }) })
  });
  check('超时 -> passed=false', timeout.passed === false, timeout.reason);
  check('超时 -> reason 提到超时/失败', /超时|失败/.test(timeout.reason), timeout.reason);

  // ---------- 4. 无法解析 ----------
  console.log('');
  console.log('[4] 无法解析');
  const garbage = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: llmResponse('画面看起来挺正常的，我觉得没问题。') })
  });
  check('非 JSON 文本 -> passed=false', garbage.passed === false, garbage.reason);
  check('非 JSON 文本 -> reason 提到无法解析', /无法解析/.test(garbage.reason), garbage.reason);

  const badRange = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: nsfwJson({ nsfw: false, score: 3.7, reason: '越界分数' }) })
  });
  check('分数越界(3.7) -> 判无法解析而非夹取放行', badRange.passed === false && /无法解析/.test(badRange.reason), badRange.reason);

  const emptyResp = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: llmResponse('') })
  });
  check('空 content -> passed=false', emptyResp.passed === false, emptyResp.reason);

  // ---------- 5. 正常判定与阈值边界 ----------
  console.log('');
  console.log('[5] 阈值判定（默认 0.8）');
  const safe = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: nsfwJson({ nsfw: false, score: 0.12, reason: '风景画面' }) })
  });
  check('score 0.12 -> passed=true', safe.passed === true, safe.reason);
  check('reason 带出实际分数', /12\.0%/.test(safe.reason) && /80\.0%/.test(safe.reason), safe.reason);

  const below = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: nsfwJson({ nsfw: false, score: 0.79, reason: '擦边但未达阈值' }) })
  });
  check('score 0.79 < 0.8 -> passed=true', below.passed === true, below.reason);

  const atThreshold = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: nsfwJson({ nsfw: true, score: 0.8, reason: '达到阈值' }) })
  });
  check('score 0.80 == 0.8 -> passed=false（达到即判不合规）', atThreshold.passed === false, atThreshold.reason);

  const above = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: nsfwJson({ nsfw: true, score: 0.95, reason: '明确违禁' }) })
  });
  check('score 0.95 -> passed=false', above.passed === false, above.reason);

  // ---------- 6. 应用侧安全策略（演示/合成画面）----------
  console.log('');
  console.log('[6] 自相矛盾输出：模型标 nsfw:true 但分数低');
  const contradiction = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    fetchImpl: fakeFetch({ body: nsfwJson({ nsfw: true, score: 0.1, reason: '模型说有问题但分数低' }) })
  });
  check('nsfw:true + score 0.1 -> 从严判 fail', contradiction.passed === false, contradiction.reason);

  // ---------- 7. 阈值可配置 ----------
  console.log('');
  console.log('[7] 阈值可配置');
  const strict = await qc.checkNSFW(VIDEO, {
    apiKey: 'k',
    nsfwThreshold: 0.5,
    fetchImpl: fakeFetch({ body: nsfwJson({ nsfw: false, score: 0.6, reason: '中等风险' }) })
  });
  check('阈值调到 0.5 后 score 0.6 -> passed=false', strict.passed === false, strict.reason);
  check('返回体带出 threshold=0.5', strict.threshold === 0.5);

  // ---------- 8. 抽帧密度 ----------
  console.log('');
  console.log('[8] 抽帧密度（每分钟 1 帧，上限 30 帧）');
  let sawRequest = null;
  const captureFetch = async (url, init) => {
    sawRequest = init;
    return { ok: true, status: 200, json: async () => llmResponse(JSON.stringify({ nsfw: false, score: 0.01, reason: 'ok' })) };
  };
  const real = await qc.checkNSFW(VIDEO, { apiKey: 'k', fetchImpl: captureFetch });
  check('真实样片抽帧成功（送出请求）', sawRequest !== null, real.reason);
  check('真实样片检测本身判 pass（分数 0.01 < 0.8）', real.passed === true, real.reason);
  const sentFrames = sawRequest
    ? (JSON.parse(sawRequest.body).messages[0].content || []).filter(c => c.type === 'image_url').length
    : 0;
  const videoDuration = (real.sampledTimes && real.duration) || qc._getVideoInfoFFmpegSync(VIDEO).duration || 0;
  console.log('    实测时长 =', videoDuration.toFixed(2) + 's', '| 抽样点 =', real.sampledTimes ? real.sampledTimes.length : 'n/a', '| 实际送入模型帧数 =', sentFrames);
  check('送入模型的帧数与计划一致', real.sampledTimes && sentFrames === real.sampledTimes.length, `${sentFrames} vs ${real.sampledTimes && real.sampledTimes.length}`);
  check('帧数不超过 30', sentFrames <= 30, String(sentFrames));
  check('帧数不少于「每分钟 1 帧、上限 30」的要求',
    sentFrames >= Math.min(30, Math.max(1, Math.ceil(videoDuration / 60))), String(sentFrames));

  // 抽帧计划算法本身（不依赖真实视频）：用 Object.create 让 this 指向一个可替换探测结果的实例
  const planWith = (duration) => {
    const stub = Object.create(qc);
    stub._getVideoInfoFFmpegSync = () => ({ duration });
    stub._dedupeTimes = qc._dedupeTimes.bind(qc);
    return qc._buildNSFWFramePlan.call(stub, 'ignored.mp4', {});
  };

  const plan30 = planWith(1800); // 30 分钟
  check('30 分钟计划帧数被压到上限 30', plan30.times.length === 30, String(plan30.times.length));
  check('30 分钟计划采样点铺满全片（首点 < 1s、末点 > 29 分钟）',
    plan30.times[0] < 1 && plan30.times[plan30.times.length - 1] > 29 * 60,
    JSON.stringify([plan30.times[0], plan30.times.slice(-1)[0]]));

  const plan10 = planWith(600); // 10 分钟
  check('10 分钟计划帧数 = 10（每分钟 1 帧）', plan10.times.length === 10, String(plan10.times.length));

  const planShort = planWith(59); // 不足 1 分钟
  check('59 秒样片至少抽 2 帧', planShort.times.length === 2, String(planShort.times.length));

  const planLong = planWith(5400); // 90 分钟
  check('90 分钟计划仍被压到 30 帧（token 预算）', planLong.times.length === 30, String(planLong.times.length));

  // maxFrames 可下调（调试用）
  const stubTiny = Object.create(qc);
  stubTiny._getVideoInfoFFmpegSync = () => ({ duration: 1800 });
  stubTiny._dedupeTimes = qc._dedupeTimes.bind(qc);
  const planTiny = qc._buildNSFWFramePlan.call(stubTiny, 'ignored.mp4', { maxFrames: 5 });
  check('maxFrames=5 时只抽 5 帧', planTiny.times.length === 5, String(planTiny.times.length));

  // ---------- 9. checkClip / checkFinal 汇总 ----------
  console.log('');
  console.log('[9] 汇总接线');
  const clipNoKey = await qc.checkClip(VIDEO, 35);
  check('checkClip 含 nsfw 明细', !!clipNoKey.details.nsfw);
  check('无 Key 时 checkClip 整体不通过', clipNoKey.passed === false, clipNoKey.reason);
  check('checkClip.totalChecks = 5', clipNoKey.totalChecks === 5, String(clipNoKey.totalChecks));

  const finalNoKey = await qc.checkFinal(VIDEO);
  check('checkFinal 含 nsfw 明细', !!finalNoKey.details.nsfw);
  check('无 Key 时 checkFinal 整体不通过', finalNoKey.passed === false, finalNoKey.reason);

  // ---------- 汇总 ----------
  console.log('');
  console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (failures.length) {
    console.log('失败项:', failures.join(' | '));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('自测脚本异常:', e);
  process.exit(1);
});
