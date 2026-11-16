// ============================================================
// 拼接归一化验收（2026-11-12）
//
// 背景：转场关闭时，原实现对原始模型输出直接 `-c copy`；
// 分辨率/帧率不一致会静默产出黑帧、重复帧、DTS 错乱。
// 现改为 concatenateSegments：先探测，只重编码不匹配片段，再做完整解码校验。
//
// 验证：
//   A. 720p + 480p 混合拼接成功
//   B. 至少 1 段被归一化
//   C. 产物统一为 720p
//   D. 时长 ≈ 两段之和（容差内）
//   E. 产物可完整解码
//
// 用法：node scripts/verify-concat-normalize.js
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const videoProcessor = require('../src/videoProcessor');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? '  —  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? '  —  ' + detail : ''}`); }
}

(async () => {
  console.log('================================================================');
  console.log('拼接归一化验收（720p + 480p 混合）');
  console.log('================================================================');

  const a = path.join(__dirname, '..', 'clips', 'task_mvgw4hbo_ajuc_clip_1.mp4'); // 1280x720
  const b = path.join(__dirname, '..', 'clips', 'task_mvg18fjs_d0ok_clip_2.mp4'); // 854x480
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    console.log('  ⚠ 缺少样本片段，跳过（需要 720p 与 480p 各一条）');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    if (fail) process.exit(1);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-norm-'));
  const out = path.join(dir, 'out.mp4');
  try {
    const r = await videoProcessor.concatenateSegments(
      [{ path: a }, { path: b }],
      out,
      { resolution: '720p', fps: 30 }
    );
    ok(r.success === true, 'A. 混合分辨率拼接成功', r.error || '');
    ok((r.normalized || 0) >= 1, 'B. 至少 1 段被归一化', `normalized=${r.normalized}`);
    const d = videoProcessor.probeDetail(out);
    ok(d.success && d.width === 1280 && d.height === 720, 'C. 产物统一为 1280x720',
      `actual=${d.width}x${d.height}`);
    const da = videoProcessor.probeDetail(a);
    const db = videoProcessor.probeDetail(b);
    const expected = (da.duration || 0) + (db.duration || 0);
    const durOk = d.duration > 0 && Math.abs(d.duration - expected) <= Math.max(0.5, expected * 0.02);
    ok(durOk, 'D. 时长 ≈ 两段之和', `actual=${d.duration} expected=${expected.toFixed(3)}`);
    ok(!!(r.decodeCheck && r.decodeCheck.ok), 'E. 产物可完整解码',
      r.decodeCheck && r.decodeCheck.summary ? r.decodeCheck.summary : '');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本异常:', e && e.message);
  process.exit(1);
});
