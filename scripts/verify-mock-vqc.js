// ==========================================================
// Mock 模式视觉质检语义 验收脚本
//
// 背景（§4.1 红线）：
//   修复前 pipeline.js 对 Mock 模式直接返回
//     { passed: true, skipped: true, reason: '视觉质检跳过: 演示模式（合成画面）' }
//   又被下游「!contentResult.passed 才拉低结论」的逻辑放行，
//   等于用 skipped 冒充 passed —— 合规项（NSFW）在 Mock 模式下也被一并绕过。
//
// 修复后的语义：
//   1) NSFW 合规检测在 Mock 模式下【仍然执行】；未执行（如无 Key）一律判 fail
//   2) 内容匹配对合成画面属【合法跳过】：passed:false + legitimateSkip:true
//      不再用 passed:true 表达「跳过」
//
// 用法：
//   node scripts/verify-mock-vqc.js
//   node scripts/verify-mock-vqc.js --tmpdir scripts/_tmp_mock
// ==========================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const qualityChecker = require('../src/qualityChecker');

const TMP_ARG = process.argv.indexOf('--tmpdir');
const TMP = (TMP_ARG > -1 && process.argv[TMP_ARG + 1])
  ? path.resolve(process.argv[TMP_ARG + 1])
  : path.join(os.tmpdir(), `verify_mock_${process.pid}_${Date.now()}`);

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

// 复刻 pipeline 里的判定逻辑（不启动整条流水线也能断言语义）
// 输入：checkClip 结果 + 内容匹配结果 => 返回归一化后的结论
function applyPipelineVerdict(qcResult, contentResult) {
  const qc = JSON.parse(JSON.stringify(qcResult));

  const nsfwDetail = (qc.details && qc.details.nsfw) || null;
  if (!nsfwDetail) {
    qc.passed = false;
    qc.reason = '合规质检缺失：片段质检结果中未包含 NSFW 检测';
    qc.failedCount = (qc.failedCount || 0) + 1;
  }

  const legitSkip = contentResult.legitimateSkip === true;
  if (!contentResult.passed && !legitSkip) {
    if (qc.passed) {
      qc.passed = false;
      qc.reason = `视觉质检失败: ${contentResult.reason}`;
      qc.failedCount = (qc.failedCount || 0) + 1;
    }
  }
  return { qc, contentResult };
}

// 构造 Mock 模式下的 contentResult（与 pipeline 中的分支一致）
function mockContentResult() {
  return {
    passed: false,
    skipped: true,
    legitimateSkip: true,
    reason: '视觉内容匹配不适用于合成画面（演示模式）；NSFW 合规检测仍已执行',
    level: 'skip'
  };
}

function findTestVideo() {
  const out = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(out)) return null;
  const files = fs.readdirSync(out)
    .filter(f => /\.mp4$/i.test(f))
    .map(f => ({ full: path.join(out, f), size: fs.statSync(path.join(out, f)).size }))
    .filter(f => f.size > 100 * 1024)
    .sort((a, b) => b.size - a.size);
  return files.length ? files[0].full : null;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  console.log('='.repeat(64));
  console.log('Mock 模式视觉质检语义 验收');
  console.log('='.repeat(64));

  // ---------- 1. 判定语义（纯逻辑，不依赖 Key） ----------
  console.log('\n[1] 判定语义：合法跳过不应被当作通过');

  // 1a. 旧写法（passed:true, skipped:true）在新判定下仍会被放行——
  //     这正是要根除的形状；此处断言「新写法不再产生这种形状」。
  const mockContent = mockContentResult();
  assert(mockContent.passed === false,
    'Mock 的内容匹配结果不再用 passed:true 表达跳过',
    `passed=${mockContent.passed}`);
  assert(mockContent.legitimateSkip === true,
    'Mock 的内容匹配标为合法跳过（legitimateSkip）',
    `legitimateSkip=${mockContent.legitimateSkip}`);
  assert(/不适用于合成画面/.test(mockContent.reason),
    '跳过理由写明「不适用于合成画面」', mockContent.reason);

  // 1b. 有完整质检结果（NSFW 明细存在且通过）时，合法跳过不应拉低整体结论
  const goodBase = {
    passed: true,
    failedCount: 0,
    details: { nsfw: { passed: true, reason: '未检出违规内容' }, blackFrame: { passed: true } }
  };
  const r1 = applyPipelineVerdict(goodBase, mockContent);
  assert(r1.qc.passed === true,
    '技术项+NSFW 都通过时，内容匹配的合法跳过不拉低结论',
    `passed=${r1.qc.passed}`);

  // 1c. 合规项缺失 => 必须判 fail（Mock 也不能因此放过）
  const noNsfwBase = {
    passed: true,
    failedCount: 0,
    details: { blackFrame: { passed: true } }
  };
  const r2 = applyPipelineVerdict(noNsfwBase, mockContent);
  assert(r2.qc.passed === false,
    '质检结果缺少 NSFW 明细时判 fail（Mock 模式不放行合规项）',
    `passed=${r2.qc.passed}, reason=${r2.qc.reason}`);

  // 1d. NSFW 未执行（无 Key）=> 整体必须 fail
  const nsfwNotRunBase = {
    passed: true,
    failedCount: 0,
    details: { nsfw: { passed: false, reason: 'NSFW 检测未执行：未配置多模态 LLM Key' } }
  };
  // 注意：checkClip 内部已把整体置为 false；这里模拟「外部硬把 passed 置 true」的篡改场景，
  // 断言 contentMatch 分支不会掩盖 NSFW 失败
  const r3 = applyPipelineVerdict(nsfwNotRunBase, mockContent);
  assert(r3.qc.passed === true,
    '（对照）仅靠 contentMatch 分支不会误改 NSFW 结果——NSFW 失败由 checkClip 汇总负责',
    `qc.passed=${r3.qc.passed}（NSFW 自身 passed=false）`);

  // 1e. 内容匹配「未执行且非合法跳过」=> 若其 passed 为 false 则应判 fail
  const notRunContent = { passed: false, skipped: true, reason: '调用失败', level: 'skip' };
  const r4 = applyPipelineVerdict(goodBase, notRunContent);
  assert(r4.qc.passed === false,
    '内容匹配「未执行且 passed=false」判 fail',
    `passed=${r4.qc.passed}`);

  // 1g. 【回归防护】checkContentMatch 无多模态 Key 时返回 { passed:true, skipped:true }
  //     ——这是既有语义（内容匹配属业务参考项）。绝不能因为"skipped"就拉低结论，
  //     否则「没配多模态 Key」的真实任务会全部失败。
  const contentSkipNoKey = {
    passed: true,
    skipped: true,
    reason: '视觉质检跳过: 未配置多模态 LLM Key',
    level: 'skip'
  };
  const rNoKey = applyPipelineVerdict(goodBase, contentSkipNoKey);
  assert(rNoKey.qc.passed === true,
    '无多模态 Key 时（checkContentMatch 返回 passed:true/skipped:true）不拉低结论 —— 防回归',
    `passed=${rNoKey.qc.passed}`);

  // 1f. 内容匹配真正失败 => 判 fail
  const realFail = { passed: false, reason: '画面与提示词不符', level: 'fail' };
  const r5 = applyPipelineVerdict(goodBase, realFail);
  assert(r5.qc.passed === false,
    '内容匹配真实失败判 fail', `passed=${r5.qc.passed}`);

  // ---------- 2. 真实 checkClip 接线 ----------
  console.log('\n[2] 真实 checkClip：NSFW 明细必须存在');
  const video = findTestVideo();
  if (!video) {
    assert(false, '找到可用于测试的成片', 'output 下没有 >100KB 的 mp4');
  } else {
    console.log(`  测试素材: ${path.basename(video)}`);
    const qc = await qualityChecker.checkClip(video, 7, { nsfw: {} });
    assert(qc.details && qc.details.nsfw, 'checkClip 返回 NSFW 明细',
      `keys=${Object.keys(qc.details || {}).join(',')}`);
    assert(qc.details && qc.details.nsfw && qc.details.nsfw.passed === false
      ? true : (qc.details && qc.details.nsfw && qc.details.nsfw.passed === true),
      'NSFW 明细的 passed 是布尔值（有明确结论，不是 undefined）',
      `passed=${qc.details && qc.details.nsfw && qc.details.nsfw.passed}`);

    // 无 Key 场景：NSFW 必须 fail（当前 .env 的 OPENAI_API_KEY 为空）
    const hasKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
    if (!hasKey) {
      assert(qc.details.nsfw.passed === false,
        '无 Key 时 NSFW 判 fail（不因 Mock/演示模式放行）',
        `reason=${String(qc.details.nsfw.reason).slice(0, 40)}`);
      // 结构性约束：checkNSFW 的失败路径显式写 skipped:false（比「不设字段」更强），
      // 无论哪种形式，结论都不得是 skipped === true —— 即不允许被当合法跳过放行。
      assert(qc.details.nsfw.skipped !== true,
        'NSFW 失败结论不标记为 skipped（结构性堵死 passed||skipped）',
        `skipped=${qc.details.nsfw.skipped}`);
      const r6 = applyPipelineVerdict(qc, mockContentResult());
      assert(r6.qc.passed === false,
        'Mock 模式 + 无 Key：整体结论为 fail',
        `passed=${r6.qc.passed}`);
    } else {
      console.log('  (检测到 OPENAI_API_KEY，跳过「无 Key」类断言)');
    }
  }

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }
  console.log('='.repeat(64));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('验收脚本异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
