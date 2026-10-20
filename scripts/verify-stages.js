// ==========================================================
// 流水线档位（pipelineStages）验收脚本
//
// 覆盖：
//   1. 与 taskManager.getPipelineSteps() 的步骤名必须完全一致（接入前提）
//   2. 五个预设档位的步骤集合
//   3. 核心链必选：只勾增强层时核心链被强制加入
//   4. 依赖传递补齐：只勾 final_qc 时整条链被补齐
//   5. 补跑计算：按已完成步骤算出待跑清单，不重跑已完成的
//   6. 补跑链路不完整时必须报错（防止跳过必需环节硬跑）
//   7. 非法档位 / 空自定义 / 非法步骤名
//   8. 执行顺序稳定（按 ALL_STAGES 顺序，非勾选顺序）
//   9. 参数快照提取（一键复跑用），且不含密钥
//
// 用法：node scripts/verify-stages.js
// ==========================================================

const taskManager = require('../src/taskManager');
const ps = require('../src/pipelineStages');

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? `  —  ${detail}` : ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? `  —  ${detail}` : ''}`); }
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function main() {
  console.log('='.repeat(64));
  console.log('流水线档位 验收');
  console.log('='.repeat(64));

  // ---------- 1. 步骤名对齐 ----------
  console.log('\n[1] 步骤名与 taskManager 对齐（接入前提）');
  const realSteps = taskManager.getPipelineSteps().map(s => s.key);
  assert(realSteps.length === 8, 'taskManager 实际有 8 个步骤', `实际 ${realSteps.length}: ${realSteps.join(',')}`);
  const missing = realSteps.filter(k => !ps.ALL_STAGES.includes(k));
  const extra = ps.ALL_STAGES.filter(k => !realSteps.includes(k));
  assert(missing.length === 0, '本模块未遗漏任何步骤', missing.length ? missing.join(',') : '无遗漏');
  assert(extra.length === 0, '本模块未编造不存在的步骤', extra.length ? extra.join(',') : '无多余');
  assert(ps.ALL_STAGES.length === 8, 'ALL_STAGES 共 8 项', `${ps.ALL_STAGES.length}`);

  // ---------- 2. 预设档位 ----------
  console.log('\n[2] 预设档位');
  const quick = ps.resolveStages('quick');
  assert(quick.ok === true, 'quick 解析成功');
  assert(eq(quick.stages, ['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation']),
    'quick = 核心链 + 拼接', quick.stages.join(','));

  const clipsOnly = ps.resolveStages('clips_only');
  assert(clipsOnly.ok === true && eq(clipsOnly.stages, ['prompt_optimize', 'storyboard', 'clip_generation']),
    'clips_only = 仅核心链', clipsOnly.stages.join(','));

  const daily = ps.resolveStages('daily');
  assert(daily.ok === true, 'daily 解析成功');
  assert(daily.stages.includes('loop_processing') && daily.stages.includes('audio_mix'),
    'daily 含循环与配乐', daily.stages.join(','));
  assert(daily.stages.includes('transcoding'),
    'daily 含转码（配乐需要母版，缺了会拿不到音源）', daily.stages.join(','));
  assert(!daily.stages.includes('final_qc'), 'daily 不含终检（与最终成片档区分）', daily.stages.join(','));

  const final = ps.resolveStages('final');
  assert(final.ok === true && final.stages.length === 8,
    'final = 全部 8 步', `实际 ${final.stages.length}`);

  // ---------- 3. 核心链必选 ----------
  console.log('\n[3] 核心链必选');
  // 只勾增强层：audio_mix
  const onlyAudio = ps.resolveStages('custom', ['audio_mix']);
  assert(onlyAudio.ok === true, '自定义只勾 audio_mix 可解析');
  assert(onlyAudio.stages.includes('prompt_optimize')
    && onlyAudio.stages.includes('storyboard')
    && onlyAudio.stages.includes('clip_generation'),
    '核心链被强制加入（否则没有片段可用）', onlyAudio.coreForced.join(','));
  assert(onlyAudio.coreForced.length === 3, '报告了 3 个被强制的核心步骤', `${onlyAudio.coreForced.length}`);
  // audio_mix 依赖 transcoding（代码里读的是母版 masterPath），
  // 所以只勾 audio_mix 时必须连带补齐 transcoding 与 concatenation。
  assert(onlyAudio.stages.includes('concatenation'),
    'audio_mix 的依赖 concatenation 被补齐', onlyAudio.autoAdded.join(','));
  assert(onlyAudio.stages.includes('transcoding'),
    'audio_mix 依赖 transcoding（配乐需要转码产出的母版）', onlyAudio.autoAdded.join(','));
  assert(!onlyAudio.stages.includes('final_qc'),
    'audio_mix 不连带拉入 final_qc（配乐不需要终检）', onlyAudio.stages.join(','));

  // ---------- 4. 依赖传递补齐 ----------
  console.log('\n[4] 依赖传递补齐');
  const onlyFinal = ps.resolveStages('custom', ['final_qc']);
  assert(onlyFinal.ok === true, '自定义只勾 final_qc 可解析');
  // final_qc -> transcoding -> concatenation -> clip_generation -> storyboard -> prompt_optimize
  assert(eq(onlyFinal.stages, ['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation', 'transcoding', 'final_qc']),
    'final_qc 触发整条依赖链补齐', onlyFinal.stages.join(','));

  // audio_mix 不应拉入 loop_processing（设计上配乐不依赖循环）
  assert(!onlyAudio.stages.includes('loop_processing'),
    'audio_mix 不会连带拉入 loop_processing（配乐不依赖循环）', onlyAudio.stages.join(','));

  // ---------- 5. 补跑计算 ----------
  console.log('\n[5] 补跑计算（核心价值：不重新生成视频）');
  const completedQuick = ['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation'];
  const resume = ps.resolveResume({ preset: 'daily', completed: completedQuick });
  assert(resume.ok === true, '补跑解析成功');
  assert(!resume.pending.includes('clip_generation'),
    '已生成的片段不再重跑（这是省钱的关键）', `pending=${resume.pending.join(',')}`);
  assert(resume.pending.includes('loop_processing') && resume.pending.includes('audio_mix'),
    '只补跑循环与配乐', `pending=${resume.pending.join(',')}`);
  assert(resume.pending.includes('transcoding'),
    'daily 档还需补转码（配乐依赖母版）', `pending=${resume.pending.join(',')}`);
  assert(resume.pending.length === 3, '待跑步骤数 = 3（循环/转码/配乐）', `${resume.pending.length}`);
  assert(resume.reused.length === 4, '复用已完成 4 步', `${resume.reused.length}`);

  const allDone = ps.resolveResume({ preset: 'daily', completed: ps.resolveStages('daily').stages });
  assert(allDone.ok === true && allDone.pending.length === 0,
    '全部完成时无待跑步骤', `pending=${allDone.pending.join(',')}`);

  // ---------- 6. 补跑链路校验 ----------
  console.log('\n[6] 补跑链路校验');
  // 6a. 自洽场景：完整前缀（核心链 + 拼接）都完成，目标 final。
  //     这是最常见的补跑用法：先跑快速验证档，再补成最终成片。
  const selfConsistent = ps.resolveResume({
    preset: 'final',
    completed: ['prompt_optimize', 'storyboard', 'clip_generation', 'concatenation']
  });
  assert(selfConsistent.ok === true,
    '完整前缀 + 目标档位时不报错（避免误杀）',
    `ok=${selfConsistent.ok}, pending=${selfConsistent.pending.join(',')}`);
  assert(!selfConsistent.pending.includes('clip_generation'),
    '已完成的片段生成不在补跑清单里', `pending=${selfConsistent.pending.join(',')}`);
  assert(selfConsistent.pending.length === 4,
    'final 档补跑 4 步（循环/转码/配乐/终检）',
    `实际 ${selfConsistent.pending.length}: ${selfConsistent.pending.join(',')}`);

  // 6b. 状态矛盾：声称转码已完成，但从没生成过片段。
  //     转码依赖 concatenation、而 concatenation 依赖 clip_generation，
  //     全都没完成却声称 transcoding 完成 —— 那份产物来源不明，不能在其上继续补跑。
  const contradiction = ps.resolveResume({
    preset: 'final',
    completed: ['transcoding']
  });
  assert(contradiction.ok === false,
    '声称某步已完成但其依赖未完成 → 判状态矛盾', `ok=${contradiction.ok}`);
  assert(typeof contradiction.error === 'string' && /补跑链路不完整/.test(contradiction.error),
    '错误信息说明链路不完整', String(contradiction.error).slice(0, 70));
  assert(/状态矛盾/.test(String(contradiction.error)),
    '错误信息指出这是状态矛盾（便于排查）', String(contradiction.error).slice(0, 70));

  // ---------- 7. 非法输入 ----------
  console.log('\n[7] 非法输入');
  const badPreset = ps.resolveStages('nonexistent');
  assert(badPreset.ok === false && /未知档位/.test(badPreset.error),
    '未知档位被判失败', String(badPreset.error).slice(0, 50));

  const emptyCustom = ps.resolveStages('custom', []);
  assert(emptyCustom.ok === false && /至少选择一个步骤/.test(emptyCustom.error),
    '自定义空选择被判失败', String(emptyCustom.error).slice(0, 50));

  const nullCustom = ps.resolveStages('custom');
  assert(nullCustom.ok === false, 'custom 不传步骤被判失败');

  const badStage = ps.resolveStages('custom', ['no_such_stage']);
  assert(badStage.ok === false && /未知步骤/.test(badStage.error),
    '未知步骤名被判失败（防止接入时写错 key）', String(badStage.error).slice(0, 60));

  // ---------- 8. 执行顺序稳定 ----------
  console.log('\n[8] 执行顺序稳定');
  const shuffled = ps.resolveStages('custom', ['final_qc', 'audio_mix', 'concatenation']);
  const expectedOrder = ps.ALL_STAGES.filter(s => shuffled.stages.includes(s));
  assert(eq(shuffled.stages, expectedOrder),
    '输出按 ALL_STAGES 固定顺序，不受勾选顺序影响', shuffled.stages.join(','));

  // ---------- 9. 参数快照 ----------
  console.log('\n[9] 参数快照（一键复跑）');
  const fakeTask = {
    model: 'dashscope',
    resolution: '1080p',
    clipDuration: 5,
    totalClips: 6,
    theme: 'landscape',
    aspectRatio: '16:9',
    isMultiPrompt: false,
    prompt: '极光下的雪山',
    runtimeConfig: { apiKey: 'SHOULD_NOT_APPEAR', templateVersion: 'v3' }
  };
  const snap = ps.buildSnapshot(fakeTask);
  assert(snap.ok === true, '快照构建成功');
  assert(snap.snapshot.model === 'dashscope' && snap.snapshot.resolution === '1080p',
    '核心生成参数已收入快照', JSON.stringify(snap.snapshot));
  assert(snap.snapshot.templateVersion === 'v3', '模板版本已收入快照（便于按原样重跑）');
  const snapStr = JSON.stringify(snap.snapshot);
  assert(!/SHOULD_NOT_APPEAR|apiKey|secretKey|accessKey/i.test(snapStr),
    '快照不含任何密钥字段（安全）', '未检出密钥');

  const emptySnap = ps.buildSnapshot({ model: 'mock' });
  assert(emptySnap.ok === true && emptySnap.missing.length > 0,
    '缺失字段被记录到 missing 而不是静默忽略', `missing=${emptySnap.missing.join(',')}`);

  const badSnap = ps.buildSnapshot(null);
  assert(badSnap.ok === false, '空任务对象被判失败');

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
  }
  console.log('='.repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main();
