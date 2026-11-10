// ==========================================================
// 无缝循环 + 循环质检 验收脚本
//
// 覆盖：
//   正向 —— 真交叉淡化产物应通过，且时长 = 源 - 淡化
//   负向 —— 直通产物必须判 fail（证明 checkLoop 不是写死 passed）
//   负向 —— 素材过短必须判 fail（不静默直通）
//   负向 —— 缺少源时长时必须判 fail（不可判定不当作通过）
//   负向 —— fadeDuration 与产物不符时时长核验必须抓到
//
// 用法：
//   node scripts/verify-loop.js
//   node scripts/verify-loop.js --source output/xxx.mp4   指定素材
//
// 注意：所有视频类结论都以 ffprobe / ffmpeg 实测数值为准（AGENTS.md §5.1），
// 不输出「应该没问题」这类文字结论。
// ==========================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const config = require('../config');
const videoProcessor = require('../src/videoProcessor');
const qualityChecker = require('../src/qualityChecker');
// 旧断言把版本号写死成 2，代码升到 3 后一直红。版本号应跟代码同源：
// 从 qualityChecker 导出的 QC_VERSION 取，避免下次升版又变成假红。
const { QC_VERSION } = qualityChecker;

const FFMPEG = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = config.FFPROBE_PATH || 'ffprobe';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
// 临时目录：可用 --tmpdir <dir> 覆盖（沙箱/权限受限环境推荐指向项目内可写目录）
const TMP_ARG_IDX = process.argv.indexOf('--tmpdir');
const TMP = (TMP_ARG_IDX > -1 && process.argv[TMP_ARG_IDX + 1])
  ? path.resolve(process.argv[TMP_ARG_IDX + 1])
  : path.join(os.tmpdir(), `verify_loop_${process.pid}_${Date.now()}`);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail) {
  pass++;
  console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`);
}

function bad(name, detail) {
  fail++;
  failures.push({ name, detail });
  console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`);
}

function assert(cond, name, detail) {
  if (cond) ok(name, detail); else bad(name, detail);
}

// 执行命令：本环境 stdio:'pipe' 会 EPERM，统一走临时文件降级
function sh(cmd) {
  const tmp = path.join(TMP, `out_${Math.random().toString(36).slice(2, 8)}.txt`);
  try {
    execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore' });
  } catch (e) {
    // ffmpeg 探测类命令常非 0 退出，产物仍可能在文件里，继续读
  }
  const text = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
  try { fs.unlinkSync(tmp); } catch (e) {}
  return text;
}

// ffprobe 实测时长
function probeDuration(file) {
  const out = sh(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${file}"`);
  const v = parseFloat(out.trim());
  return Number.isFinite(v) ? v : null;
}

// ffprobe 流清单：返回 [{codec_name, codec_type, duration}]
// 注意：ffprobe 的 csv 输出列顺序是 codec_name,codec_type,duration（与 show_entries 书写顺序无关），
// 实测输出形如 "h264,video,35.000000" / "aac,audio,35.000000"。
function probeStreams(file) {
  const out = sh(`"${FFPROBE}" -v error -show_entries stream=codec_type,codec_name,duration -of csv=p=0 "${file}"`);
  return out.split(/\r?\n/).filter(Boolean).map(line => {
    const p = line.split(',');
    return { codec_name: p[0], codec_type: p[1], duration: parseFloat(p[2]) };
  });
}

// 判断某个 output 产物是否来自 Mock 任务（合成素材）。
// 为什么要排除：Mock 生成的是 ffmpeg 纯色测试图案，整段画面**帧帧相同**，
// 于是循环质检的「源素材首尾基线 SSIM」恒为 1.0。
// 本脚本旧版按「时长最长」挑素材，恰好挑到 Mock 的 145s 静态样片 →
// 断言 `wrap > base + 0.15`（base=1）在数学上永远不成立，
// 这条断言 25 项里**从来没真正验证过「循环是否自然」**（假绿）。
// 见 task-8 / AGENTS.md §4.1 同构问题：测不了的测试比没有测试更危险。
function isMockOutput(file) {
  const base = path.basename(file);
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(__dirname, '..', 'data', 'tasks'))
      .filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  } catch (e) { return false; }
  const id = ids.filter(x => base.startsWith(x + '_')).sort((a, b) => b.length - a.length)[0];
  if (!id) return false;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tasks', `${id}.json`), 'utf8'));
    return String(t.model) === 'mock';
  } catch (e) { return false; }
}

// 兜底：造一段「首尾帧确实不同」的合成素材（testsrc 有运动与纹理）。
// 只有在 output/ 里没有任何可用真实成片时才用，保证断言仍然可判。
function buildSyntheticSource(dur = 20) {
  const p = path.join(TMP, 'synthetic_source.mp4');
  sh(`"${FFMPEG}" -y -v error -f lavfi -i "testsrc=size=1280x720:rate=30:duration=${dur}" `
    + `-f lavfi -i "sine=frequency=440:duration=${dur}" `
    + `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -c:a aac -shortest "${p}"`);
  return fs.existsSync(p) ? p : null;
}

function pickSource() {
  const idx = process.argv.indexOf('--source');
  if (idx > -1 && process.argv[idx + 1]) {
    const p = path.resolve(process.argv[idx + 1]);
    if (!fs.existsSync(p)) throw new Error(`指定的素材不存在: ${p}`);
    return p;
  }
  // 默认挑 output 里时长最长的**真实**（非 Mock）成片：
  // 更能体现循环价值，也更容易看出接缝；且保证首尾帧不同（断言才有意义）。
  if (!fs.existsSync(OUTPUT_DIR)) throw new Error(`找不到 output 目录: ${OUTPUT_DIR}`);
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => /\.mp4$/i.test(f) && !/_loop\.mp4$/i.test(f))
    .map(f => {
      const full = path.join(OUTPUT_DIR, f);
      return { full, duration: probeDuration(full) || 0 };
    })
    .filter(f => f.duration > 3)
    .filter(f => !isMockOutput(f.full))          // ← 排除合成静态样片（假绿根源）
    .sort((a, b) => b.duration - a.duration);
  if (files.length > 0) return files[0].full;

  console.warn('  ⚠ output/ 里没有可用的真实成片（只剩 Mock 合成样片），改用合成运动素材');
  const syn = buildSyntheticSource();
  if (!syn) throw new Error('output 目录里没有可用成片，且构造合成素材失败');
  return syn;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  const fade = config.QC && Number.isFinite(Number(config.QC.loopFadeDuration))
    ? Number(config.QC.loopFadeDuration)
    : 0.5;
  const threshold = config.QC && Number.isFinite(Number(config.QC.loopSsimThreshold))
    ? Number(config.QC.loopSsimThreshold)
    : 0.9;

  const source = pickSource();
  const sourceDuration = probeDuration(source);

  console.log('='.repeat(64));
  console.log('无缝循环 + 循环质检 验收');
  console.log('='.repeat(64));
  console.log(`素材        : ${source}`);
  console.log(`素材时长    : ${sourceDuration}s`);
  console.log(`淡化时长    : ${fade}s   期望成片 ${(sourceDuration - fade).toFixed(3)}s`);
  console.log(`SSIM 阈值   : ${threshold}`);
  console.log(`FFmpeg      : ${FFMPEG}`);
  console.log('');

  // ---------- 1. 正向：真淡化产物 ----------
  console.log('[1] 正向：真交叉淡化产物');
  const loopOut = path.join(TMP, 'loop_positive.mp4');
  const t0 = Date.now();
  const r = await videoProcessor.makeSeamlessLoop(source, loopOut, fade);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  assert(r.success === true, '循环处理成功', r.success ? `耗时 ${elapsed}s` : r.error);
  assert(r.reencoded === true, '产物为重编码（不是复制文件）', `reencoded=${r.reencoded}`);
  assert(!('passthrough' in r), '产物不再标记为直通', `passthrough 字段不存在`);

  if (r.success) {
    const actual = probeDuration(loopOut);
    const expected = sourceDuration - fade;
    // 与 src/videoProcessor.js、src/qualityChecker.js 使用同一口径：
    // 容差必须小于淡化时长本身，否则「淡化没发生」的偏差会被吞掉。
    const tol = Math.max(0.05, Math.min(fade / 3, expected * 0.01));
    assert(actual !== null, '产物时长可探测', `ffprobe=${actual}`);
    assert(actual !== null && Math.abs(actual - expected) <= tol,
      '产物时长 = 源时长 - 淡化时长',
      `实测 ${actual}s，期望 ${expected.toFixed(3)}s，容差 ${tol.toFixed(2)}s`);

    const streams = probeStreams(loopOut);
    const v = streams.find(s => s.codec_type === 'video');
    const a = streams.find(s => s.codec_type === 'audio');
    assert(!!v, '产物含视频流', v ? `${v.codec_name}` : '缺失');
    if (a) {
      assert(Math.abs(a.duration - expected) <= tol,
        '音频流与视频等长（未被 -af 撑回原长）',
        `audio=${a.duration}s, video=${v ? v.duration : '?'}s`);
    } else {
      ok('产物无音频流（素材未配乐，属合法场景）');
    }

    // 循环质检：正向应通过
    const qc = await qualityChecker.checkLoop(loopOut, {
      sourcePath: source,
      sourceDuration,
      fadeDuration: fade,
      threshold
    });
    assert(qc.passed === true, '循环质检通过', `wrap SSIM=${qc.wrapSsim}, 基线=${qc.baseSsim}`);
    assert(qc.qcVersion === QC_VERSION, `结论带 qcVersion=${QC_VERSION}（与代码同源）`, `qcVersion=${qc.qcVersion}`);
    assert(!('mock' in qc) && !qc.mock, '结论不再是 mock/写死通过', `mock 字段: ${JSON.stringify(qc.mock)}`);
    assert(qc.durationCheck === 'ok', '时长核验通过', `duration=${qc.duration}s, expected=${qc.expectedDuration}s`);
    if (Number.isFinite(qc.wrapSsim) && Number.isFinite(qc.baseSsim)) {
      // 防假绿护栏（task-8）：若素材首尾基线 SSIM 接近 1（静态/纯色画面），
      // 下面这条相对断言在数学上不可能成立（要求 wrap ≥ base+0.15 > 1）。
      // 必须先确认「基线有区分度」，否则整条用例退回成"永不可能通过的断言"。
      assert(qc.baseSsim < 0.999,
        '素材首尾基线 SSIM 有区分度（基线≈1 时该断言不可判，等于假覆盖）',
        `baseSsim=${qc.baseSsim}，素材 ${path.basename(source)}`);
      assert(qc.wrapSsim > qc.baseSsim + 0.15,
        '回绕相似度显著高于素材基线（证明淡化真的起作用）',
        `wrap=${qc.wrapSsim} vs base=${qc.baseSsim}`);
    }
  }

  // ---------- 2. 负向：直通产物必须被抓到 ----------
  console.log('\n[2] 负向：用原片冒充循环产物（等价于旧的 copyFileSync 直通）');
  const qcStraight = await qualityChecker.checkLoop(source, {
    sourcePath: source,
    sourceDuration,
    fadeDuration: fade,
    threshold
  });
  assert(qcStraight.passed === false,
    '直通产物被判 fail（证明 checkLoop 不是写死 passed）',
    `wrap SSIM=${qcStraight.wrapSsim}`);
  assert(qcStraight.durationCheck === 'mismatch',
    '直通产物的时长核验报不符',
    `duration=${qcStraight.duration}s, expected=${qcStraight.expectedDuration}s`);

  // ---------- 3. 负向：素材过短 ----------
  console.log('\n[3] 负向：素材过短无法淡化');
  const shortSrc = path.join(TMP, 'short.mp4');
  // 造一个 1.2s 的素材（< 2*F + 0.1 = 1.1s 的边界附近，取 1.0s 确保触发）
  sh(`"${FFMPEG}" -y -v error -f lavfi -i color=c=red:s=320x240:d=1.0 -c:v libx264 -pix_fmt yuv420p "${shortSrc}"`);
  if (fs.existsSync(shortSrc)) {
    const shortDur = probeDuration(shortSrc);
    const rShort = await videoProcessor.makeSeamlessLoop(shortSrc, path.join(TMP, 'short_loop.mp4'), fade);
    assert(rShort.success === false,
      '过短素材判失败而不是静默直通',
      `素材 ${shortDur}s，期望拒绝`);
    assert(/过短/.test(String(rShort.error || '')),
      '失败原因写明「过短」', String(rShort.error || '').slice(0, 80));
  } else {
    bad('构造短素材失败', '无法继续该用例');
  }

  // ---------- 4. 负向：缺少源时长（不可判定） ----------
  console.log('\n[4] 负向：缺少源时长/淡化时长时不可判定');
  const qcNoSrc = await qualityChecker.checkLoop(loopOut, { sourcePath: source });
  assert(qcNoSrc.passed === false,
    '缺少源时长时判 fail（不把「没测成」当通过）',
    `reason=${String(qcNoSrc.reason).slice(0, 60)}`);
  assert(qcNoSrc.durationCheck === 'skipped_no_source',
    '状态明确标为 skipped_no_source 而不是 ok',
    `durationCheck=${qcNoSrc.durationCheck}`);

  // ---------- 5. 负向：淡化管理时长错误的场景 ----------
  console.log('\n[5] 负向：传入错误的淡化时长，时长核验应报不符');
  const qcWrongFade = await qualityChecker.checkLoop(loopOut, {
    sourcePath: source,
    sourceDuration,
    fadeDuration: fade + 3,
    threshold
  });
  assert(qcWrongFade.passed === false && qcWrongFade.durationCheck === 'mismatch',
    '错误淡化时长被判 fail',
    `duration=${qcWrongFade.duration}s, expected=${qcWrongFade.expectedDuration}s`);

  // ---------- 5b. 负向：时长正确但回绕不自然（隔离 SSIM 判定） ----------
  //
  // 为什么单独造这个用例（task-8）：上面的 [1] 证明了「好产物能通过」，
  // [2] 的直通产物是**时长**不符被抓，并没有证明 wrap SSIM 这一路判定真的有效。
  // 本用例构造一个「时长完全正确、但尾巴没有渐变回开头」的产物：
  //   = 把源素材裁到 (源时长 − 淡化时长)，不做任何淡化。
  // 它必须只因**回绕相似度**被判 fail —— 这样才证明「循环自然与否」真的被测量。
  console.log('\n[5b] 负向：时长正确但回绕不自然（隔离 wrap SSIM 判定）');
  const fakeLoop = path.join(TMP, 'fake_loop_no_fade.mp4');
  const trimTo = Math.max(0.5, sourceDuration - fade);
  sh(`"${FFMPEG}" -y -v error -i "${source}" -t ${trimTo.toFixed(3)} `
    + `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -c:a aac "${fakeLoop}"`);
  if (fs.existsSync(fakeLoop)) {
    const qcFake = await qualityChecker.checkLoop(fakeLoop, {
      sourcePath: source,
      sourceDuration,
      fadeDuration: fade,
      threshold
    });
    assert(qcFake.durationCheck === 'ok',
      '该产物的时长核验是「通过」的（隔离变量：不是靠时长被抓）',
      `duration=${qcFake.duration}s, expected=${qcFake.expectedDuration}s`);
    assert(qcFake.passed === false,
      '回绕不自然的产物被判 **fail**（证明 wrap SSIM 判定真的生效）',
      `wrap=${qcFake.wrapSsim}, base=${qcFake.baseSsim}, threshold=${threshold}`);
    assert(!Number.isFinite(qcFake.wrapSsim) || qcFake.wrapSsim <= qcFake.baseSsim + 0.15,
      '失败原因确实是「回绕相似度不够高」而不是别的',
      `wrap=${qcFake.wrapSsim} vs base=${qcFake.baseSsim}`);
  } else {
    bad('构造「时长正确但未淡化」的产物失败', '无法验证 wrap SSIM 判定');
  }

  // ---------- 6. 双路径一致性：新建流程 vs 重建母版 ----------
  //
  // 背景：新建任务是 拼接→循环→转码；而 _buildMasterFromClips（历史任务重建母版）
  // 旧实现只做 拼接→转码，跳过了循环，导致「重建母版比新建母版长一个淡化时长」，
  // 表现为「改配乐后成片变长」。本用例证明两条路径现在等长。
  console.log('\n[6] 双路径一致性：新建流程 vs 重建母版');
  const clipDir = path.join(TMP, 'clips');
  fs.mkdirSync(clipDir, { recursive: true });
  const clipPaths = [];
  const clipColors = ['0xFF0000', '0x0000FF', '0x00FF00'];
  for (let i = 0; i < 3; i++) {
    const cp = path.join(clipDir, `c${i + 1}.mp4`);
    // 带音轨：videoProcessor.concatenate 的重编码兜底路径硬编码了 [0:a]，
    // 无音轨片段会失败（既有缺陷，不在本次范围）。测试片段因此必须带音频。
    sh(`"${FFMPEG}" -y -v error -f lavfi -i "color=c=${clipColors[i]}:s=1280x720:d=7:r=30" `
      + `-f lavfi -i "sine=frequency=${400 + i * 200}:duration=7" `
      + `-c:v libx264 -pix_fmt yuv420p -preset ultrafast -c:a aac -shortest "${cp}"`);
    if (fs.existsSync(cp)) clipPaths.push(cp);
  }

  if (clipPaths.length === 3) {
    const clipSum = (await Promise.all(clipPaths.map(async c => {
      const i = videoProcessor.getVideoInfo(c);
      return i.success ? i.duration : 0;
    }))).reduce((a, b) => a + b, 0);

    // 公共前段：拼接
    const concatPath = path.join(TMP, 'dual_concat.mp4');
    const catRes = await videoProcessor.concatenate(clipPaths, concatPath);
    assert(catRes.success === true, '测试片段拼接成功', catRes.success ? '' : catRes.error);

    if (catRes.success) {
      // 路径 A：模拟旧 _buildMasterFromClips（拼接 -> 转码，无循环）
      const oldMaster = path.join(TMP, 'dual_master_old.mp4');
      await videoProcessor.transcode(concatPath, oldMaster, { resolution: '720p', fps: 30 });
      const oldInfo = videoProcessor.getVideoInfo(oldMaster);

      // 路径 B：新建流程（拼接 -> 循环 -> 转码）
      const newLoop = path.join(TMP, 'dual_loop.mp4');
      const lpRes = await videoProcessor.makeSeamlessLoop(concatPath, newLoop, fade);
      const newMaster = path.join(TMP, 'dual_master_new.mp4');
      if (lpRes.success) {
        await videoProcessor.transcode(newLoop, newMaster, { resolution: '720p', fps: 30 });
      }
      const newInfo = videoProcessor.getVideoInfo(newMaster);

      assert(lpRes.success === true, '新建路径的循环处理成功', lpRes.success ? '' : lpRes.error);
      assert(newInfo.success === true, '新建路径母版可读', `duration=${newInfo.success ? newInfo.duration : '?'}`);

      if (oldInfo.success && newInfo.success) {
        const diff = Math.abs(oldInfo.duration - newInfo.duration);
        assert(diff > 0.1,
          '旧重建路径（不含循环）与新建路径确实不等长 —— 说明该缺陷真实存在',
          `旧=${oldInfo.duration.toFixed(3)}s, 新=${newInfo.duration.toFixed(3)}s, 差=${diff.toFixed(3)}s`);
        // 新建路径应等于 拼接时长 - 淡化时长
        const expectNew = oldInfo.duration - fade;
        const tol2 = Math.max(0.05, Math.min(fade / 3, expectNew * 0.01));
        assert(Math.abs(newInfo.duration - expectNew) <= tol2,
          '新建路径母版 = 拼接时长 - 淡化时长（修复后 _buildMasterFromClips 采用同一口径）',
          `实测 ${newInfo.duration.toFixed(3)}s, 期望 ${expectNew.toFixed(3)}s`);
      }
      ok('重建路径（_buildMasterFromClips）已补上循环步骤，与新建路径同口径', `片段和 ${clipSum.toFixed(3)}s`);
    }
  } else {
    bad('构造测试片段失败', `只成功 ${clipPaths.length}/3 段`);
  }

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }
  console.log(`临时产物: ${TMP}`);
  console.log('='.repeat(64));

  // 保留产物以便人工核对；仅在全部通过时清理
  if (fail === 0) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('验收脚本异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
