// ==========================================================
// 一键跑全部验收脚本
//
// 背景：本项目有 10 个 verify-*.js，此前只能逐个 `node scripts/xxx.js`，
// 没人会记得全部跑一遍。回归时漏跑一个，就等于没验。
//
// 用法：
//   node scripts/verify-all.js            # 全部
//   node scripts/verify-all.js --fast     # 跳过真机（耗时长的）
//   node scripts/verify-all.js --only frontend,loop
//
// 退出码：全部通过 = 0，有任何失败 = 1
// ==========================================================

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// group:
//   fast   —— 纯逻辑/静态，秒级
//   real   —— 需要起服务或跑 ffmpeg/mock 流水线，数十秒
const SUITES = [
  {
    name: 'auth',
    script: 'verify-auth.js',
    group: 'real',
    desc: '登录墙（未登录 401/302、会话 cookie、成员管理、失败锁定、WS 握手，起两个临时服务）'
  },
  {
    name: 'stages',
    script: 'verify-stages.js',
    group: 'fast',
    desc: '档位/依赖/补跑计算（纯函数）'
  },
  {
    name: 'create-config',
    script: 'verify-create-config.js',
    group: 'fast',
    desc: 'E1 创作页生成参数接线（读 vs_web_config：模型/分辨率/档位 + 请求体语义）'
  },
  {
    name: 'key-guard',
    script: 'verify-key-guard.js',
    group: 'fast',
    desc: 'Key 粘贴污染防护（非 ASCII 校验/回显实际请求地址/显示隐藏按钮不依赖 emoji）'
  },
  {
    name: 'assistant-diagnostics',
    script: 'verify-assistant-diagnostics.js',
    group: 'fast',
    desc: '提示词助手失败原因可诊断（失败分类/脱敏/模型名校验 + 接线，stub fetch 零花费）'
  },
  {
    name: 'image-gen-compat',
    script: 'verify-image-gen-compat.js',
    group: 'fast',
    desc: 'OpenAI 兼容出图适配器（openai-images：url/b64/包装 + 4 类负向，本地 stub）'
  },
  {
    name: 'openai-video',
    script: 'verify-openai-video.js',
    group: 'fast',
    desc: 'OpenAI 兼容视频适配器（openai-video：提交/轮询//content 下载 + 负向，本地 stub）'
  },
  {
    name: 'cost-guard',
    script: 'verify-cost-guard.js',
    group: 'fast',
    desc: 'E3 余额 + 费用预估/超额拦截（/api/estimate 与 pricing 同源，起临时服务）'
  },
  {
    name: 'multi-prompt',
    script: 'verify-multi-prompt.js',
    group: 'fast',
    desc: 'E2 多提示词批量（每行一个场景，行数覆盖段数；离线跑真实 create.js）'
  },
  {
    name: 'custom-stages',
    script: 'verify-custom-stages.js',
    group: 'fast',
    desc: 'E4 自定义环节 + 质检严格度（stages/strictQcItems 提交体；离线跑真实 create.js）'
  },
  {
    name: 'image-review',
    script: 'verify-image-review.js',
    group: 'fast',
    desc: '出图后第③步能看见图 + 打回只重做这一张（不引入后端审核门；离线跑真实 create.js）'
  },
  {
    name: 'create-draft',
    script: 'verify-create-draft.js',
    group: 'fast',
    desc: '创作向导切页/刷新不丢（草稿 sessionStorage + 出图任务不随组件卸载；离线跑真实 create.js）'
  },
  {
    name: 'photo-library',
    script: 'verify-photo-library.js',
    group: 'fast',
    desc: '图片库（自动入库/提示词原样保留/审核三态/删除防越界/回填扫描；隔离临时目录）'
  },
  {
    name: 'i2v',
    script: 'verify-i2v.js',
    group: 'fast',
    desc: '图生视频请求构建（可灵/Seedance 首帧字段、未实现厂商明确拒绝；不联网不计费）'
  },
  {
    name: 'bgm-upload',
    script: 'verify-bgm-upload.js',
    group: 'real',
    desc: '配乐上传（前端 FileReader dataURL + 后端大小/格式/头校验；临时服务 + 隔离 BGM_DIR）'
  },
  // ===== 2026-11-10 盘点后新纳入门禁的 24 个套件 =====
  // 原 30 个未注册里剔除 5 个真红/坏的（verify-adjust-pipeline / bgm-api / bgm-e2e2 / bgm-negative / port3001），
  // 剔除原因见 FEATURES.md「C. 工程债」。以下 24 个都是当日逐个跑过且 exit 0 的。
  { name: 'adjust-chain', script: 'verify-adjust-chain.js', group: 'fast', desc: '调节链纯函数（空间滤镜白名单/注入过滤，13 项）' },
  { name: 'adjust-pipeline', script: 'verify-adjust-pipeline.js', group: 'real', desc: '调节接进流水线（12 项；曾抓到 timing 越界崩进程的真 bug）' },
  { name: 'adjust-advanced', script: 'verify-adjust-advanced.js', group: 'real', desc: '高级调节 HSL/RGB曲线/色轮（28 项，真 ffmpeg）' },
  { name: 'adjust-psnr', script: 'verify-adjust-psnr.js', group: 'real', desc: '调节定量判据（10 项 ≥40dB，真 ffmpeg）' },
  { name: 'clip-library-detail', script: 'verify-clip-library-detail.js', group: 'real', desc: '片段库详情（18 项）' },
  { name: 'color-continuity', script: 'verify-color-continuity.js', group: 'real', desc: '镜头色彩连续性质检（34 项）' },
  { name: 'color-match', script: 'verify-color-match.js', group: 'real', desc: '跨片段色彩匹配（24 项）' },
  { name: 'editor-adjust', script: 'verify-editor-adjust.js', group: 'real', desc: '剪辑台逐段调节（17 项）' },
  { name: 'editor-audio', script: 'verify-editor-audio.js', group: 'real', desc: '剪辑台音频两轨（22 项）' },
  { name: 'editor-export', script: 'verify-editor-export.js', group: 'real', desc: '剪辑台导出（24 项）' },
  { name: 'editor-final-source', script: 'verify-editor-final-source.js', group: 'real', desc: '剪辑台接成片：素材三来源/整段载入/导出归成片（P3，真 ffmpeg + ffprobe）' },
  { name: 'editor-media', script: 'verify-editor-media.js', group: 'real', desc: '剪辑台素材面板（21 项）' },
  { name: 'editor-nav', script: 'verify-editor-nav.js', group: 'real', desc: '剪辑台导航（12 项）' },
  { name: 'editor-preview', script: 'verify-editor-preview.js', group: 'real', desc: '剪辑台实时预览（28 项）' },
  { name: 'editor-rebuild', script: 'verify-editor-rebuild.js', group: 'real', desc: '剪辑台从任务重建（19 项）' },
  { name: 'editor-shell', script: 'verify-editor-shell.js', group: 'real', desc: '剪辑台骨架（25 项）' },
  { name: 'editor-timeline', script: 'verify-editor-timeline.js', group: 'real', desc: '剪辑台时间线（29 项）' },
  { name: 'editor-transition-controls', script: 'verify-editor-transition-controls.js', group: 'real', desc: '剪辑台转场控件（16 项）' },
  { name: 'editor-ux-fixes', script: 'verify-editor-ux-fixes.js', group: 'real', desc: '剪辑台交互修复（18 项）' },
  { name: 'nsfw-adversarial', script: 'verify-nsfw-adversarial.js', group: 'real', desc: 'NSFW 对抗用例（51 项）' },
  { name: 'projects', script: 'verify-projects.js', group: 'real', desc: '剪辑工程/草稿（25 项）' },
  { name: 'recovery-fixes', script: 'verify-recovery-fixes.js', group: 'real', desc: '历史事故回归（覆盖保护/降级标记/配置合并/并发隔离，25 项）' },
  { name: 'seam-qc', script: 'verify-seam-qc.js', group: 'real', desc: '接缝质量质检（55 项，真 ffmpeg，较慢）' },
  { name: 'transitions', script: 'verify-transitions.js', group: 'real', desc: '交叉淡化转场（36 项，真 ffmpeg）' },
  { name: 'transition-runtime', script: 'verify-transition-runtime.js', group: 'real', desc: '转场运行时接线（12 项）' },
  { name: 'transition-scale', script: 'verify-transition-scale.js', group: 'real', desc: '转场规模/性能（8 项）' },
  {
    name: 'stats',
    script: 'verify-stats.js',
    group: 'fast',
    desc: '生产指标统计（成功率/通过率口径，纯构造数据）'
  },
  {
    name: 'pipeline-fixes',
    script: 'verify-pipeline-fixes.js',
    group: 'fast',
    desc: '三缺陷修复（终检配置透传/片段缺失告警/僵尸任务回收/日志落盘）'
  },
  {
    name: 'test-hygiene',
    script: 'verify-test-hygiene.js',
    group: 'fast',
    desc: '验收脚本自清理（造任务的脚本必须走 _test-cleanup，且 data/tasks 无测试残留）'
  },
  {
    name: 'qc-annotation',
    script: 'verify-qc-annotation.js',
    group: 'real',
    desc: '质检可信度标注 + 起临时服务实测 API'
  },
  {
    name: 'frontend-contract',
    script: 'verify-frontend-contract.js',
    group: 'real',
    desc: '前端契约逐条跑真实 API'
  },
  {
    name: 'continue',
    script: 'verify-continue.js',
    group: 'real',
    desc: '补跑真机（片段不重生成）'
  },
  {
    name: 'stage-pipeline',
    script: 'verify-stage-pipeline.js',
    group: 'real',
    desc: '档位真机（quick/clips_only/final）'
  },
  {
    name: 'concat-audio',
    script: 'verify-concat-audio.js',
    group: 'real',
    desc: '拼接音轨兼容（全有/全无/混合）'
  },
  {
    name: 'loop',
    script: 'verify-loop.js',
    group: 'real',
    desc: '无缝循环 + 循环质检'
  },
  {
    name: 'nsfw',
    script: 'verify-nsfw.js',
    group: 'real',
    desc: 'NSFW 检测（注入 fetch 不联网，但要真实抽帧，约 50s）'
  },
  {
    name: 'mock-vqc',
    script: 'verify-mock-vqc.js',
    group: 'fast',
    desc: 'Mock 模式视觉质检语义'
  },
  {
    name: 'image-gen',
    script: 'verify-image-gen.js',
    group: 'fast',
    desc: '图片生成适配器（wan2.7-image：请求结构/轮询/落盘/负向，本地 stub 不花钱）'
  },
  {
    name: 'library',
    script: 'verify-library.js',
    group: 'real',
    desc: '片段库：价目表/费用口径/分组/跨规格拼接归一化'
  },
  {
    name: 'recycle',
    script: 'verify-recycle.js',
    group: 'fast',
    desc: '统一回收站 + 入库策略（删除可恢复/白名单防越界/失败片段入库/mock 不入库/费用未知不伪装成 0）'
  },
  {
    name: 'skill-prompt',
    script: 'verify-skill-prompt.js',
    group: 'fast',
    desc: 'fengguang skill 规则层接入提示词优化（作用域/开关/systemPrompt 组成/全中文，不联网）'
  },
  {
    name: 'skill-ai-path',
    script: 'verify-skill-ai-path.js',
    group: 'fast',
    desc: 'skill 规则是否真的随请求发给 LLM（本地 mock 服务，端到端，不花钱）'
  },
  {
    name: 'pause',
    script: 'verify-pause.js',
    group: 'real',
    desc: '暂停/继续（粒度 A、幂等、超时不静默、重启回收可补跑、HTTP 400/404、failureCode 三态）'
  },
  {
    name: 'bgm-plan',
    script: 'verify-bgm-plan.js',
    group: 'real',
    desc: '配乐计划：自动配乐/时间轴分段/两轨（真 ffmpeg）'
  },
  {
    name: 'bgm-mix',
    script: 'verify-bgm-mix.js',
    group: 'real',
    desc: '整片多轨混音：跨曲衔接/两轨/关键帧/变速（真 ffmpeg）'
  },
  {
    name: 'bgm-tracks',
    script: 'verify-bgm-tracks.js',
    group: 'real',
    desc: '配乐音轨：源区间/循环填充/变速对齐（真 ffmpeg）'
  },
  {
    name: 'bgm-storage',
    script: 'verify-bgm-storage.js',
    group: 'real',
    desc: '配乐计划存储往返（任务字段）'
  },
  {
    name: 'bgm-ducking',
    script: 'verify-bgm-ducking.js',
    group: 'real',
    desc: '配乐闪避：滤镜图 + 真 ffmpeg 混音（默认关闭）'
  },
  {
    name: 'bgm-suite',
    script: 'verify-bgm-suite.js',
    group: 'real',
    desc: '配乐 API/负向/端到端三套件（隔离 DATA_DIR/OUTPUT_DIR 起独立服务）'
  },
  {
    name: 'qc-report-mode',
    script: 'verify-qc-report-mode.js',
    group: 'real',
    desc: '质检分级（软项只警告）+ autoRetry=false 不自动重跑 + 失败清单停在拼接前'
  },
  {
    name: 'concat-normalize',
    script: 'verify-concat-normalize.js',
    group: 'real',
    desc: '转场关闭时混合分辨率拼接先归一化（只重编码不匹配段 + 完整解码校验）'
  },
  {
    name: 'i2v-dashscope-url',
    script: 'verify-i2v-dashscope-url.js',
    group: 'fast',
    desc: 'wan3.0 图生视频：百炼临时上传 oss:// + X-DashScope-OssResourceResolve 请求头（stub，零计费）'
  },
  {
    name: 'auto-grade',
    script: 'verify-auto-grade.js',
    group: 'real',
    desc: '逐图自适应调色：高饱和压回区间、低饱和不反向调艳（真 ffmpeg）'
  },
  {
    name: 'image-batch',
    script: 'verify-image-batch.js',
    group: 'real',
    desc: '批量出图→逐图调色→自动通过→photoId 顺序对应（stub 出图，零计费）'
  },
  {
    name: 'image-first-e2e',
    script: 'verify-image-first-e2e.js',
    group: 'real',
    desc: '图片优先全链路：photoId→first_frame URL→本地 DashScope stub→下载→质检→拼接（零计费）'
  },
  {
    name: 'scene-cards',
    script: 'verify-scene-cards.js',
    group: 'real',
    desc: '场景卡接入运行时：180 张顺序无重复/buffer 仅在失败时替换/promptComposer/参数化调色/Mock 任务记录 scene_key'
  },
  {
    name: 'assistant',
    script: 'verify-assistant.js',
    group: 'real',
    desc: '小智：计划卡/状态机/记忆/离线语音/ΔE76+SSIM 补位/Mock 全流程 + 自动重试（零计费）'
  },
  {
    name: 'assistant-http',
    script: 'verify-assistant-http.js',
    group: 'real',
    desc: '小智 HTTP 层：临时隔离实例跑 /api/assistant/*（info/message/execute/state/memory/asr/understand + 1 段 Mock 成片）'
  },
  {
    name: 'whaletv-video',
    script: 'verify-whaletv-video.js',
    group: 'fast',
    desc: 'WhaleTV 中转（openai-video）：计划卡 ¥180/$30、按秒价目、POST /videos 文生视频 body(model/prompt/seconds)、seconds 边界、图生视频 POST /video/generations JSON+image（URL 优先/base64 兜底，stub fetch 零花费）'
  },
  {
    name: 'p6-offline',
    script: 'verify-p6-offline.js',
    group: 'fast',
    desc: 'P6 下线历史/产出入口：壳层不再渲染 History/Output、深链落库、库页未完成卡片与失败徽章、旧页面标注（静态 + 3001 静态文件只读校验）'
  },
  {
    name: 'xiaozhi-home',
    script: 'verify-xiaozhi-home.js',
    group: 'fast',
    desc: '小智首页：/ 整页对话（大球/介绍卡/底部输入/可收起导航）+ /create 六步向导（静态 + 3001 只读）'
  },
  {
    name: 'mic-permission',
    script: 'verify-mic-permission.js',
    group: 'fast',
    desc: '麦克风权限：Permissions API 前置、Chrome/Windows 指引、portal 遮罩、松手不偷录、错误分类（静态 + 3001 只读）'
  },
  {
    name: 'image-first-pipeline',
    script: 'verify-image-first-pipeline.js',
    group: 'real',
    desc: '小智出图→图生视频：场景卡逐段出图（stub 适配器，零计费）/ 出图后暂停审图 / unpause 结算 / 缺图拒绝降级 / 补跑闸门'
  },
  {
    name: 'image-first-ui',
    script: 'verify-image-first-ui.js',
    group: 'fast',
    desc: '小智前端出图开关（默认开/单价来自 info/请求体 imagePerClip 与图片字段）+ 审图暂停卡片与继续按钮（静态 + 3001 只读）'
  },
  {
    name: 'image-first-http',
    script: 'verify-image-first-http.js',
    group: 'real',
    desc: '出图/调色 HTTP 契约：临时隔离实例验 /api/assistant/info 的 image 段、execute 出图未就绪前置拒绝（不建任务）、/api/photos/:id/adjust'
  },
  {
    name: 'photo-adjust',
    script: 'verify-photo-adjust.js',
    group: 'real',
    desc: '图片手动调色模块：亮度/对比度/饱和度/色温真 ffmpeg 渲染（YAVG/色偏实测）、原图保留、版本递增、回退、参数越界负向'
  },
  {
    name: 'photo-adjust-ui',
    script: 'verify-photo-adjust-ui.js',
    group: 'fast',
    desc: '图片审核页调色滑杆：四条滑杆/应用/恢复原图/CSS 近似预览/cache-busting/错误显示（静态断言 + 3001 只读）'
  }
];

// 需要 --tmpdir 的脚本（避免写到系统临时目录时权限受限）
const NEEDS_TMPDIR = new Set(['concat-audio', 'loop', 'mock-vqc']);

const args = process.argv.slice(2);
const FAST_ONLY = args.includes('--fast');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx > -1 && args[onlyIdx + 1]
  ? args[onlyIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
  : null;

const SCRIPTS_DIR = __dirname;
const APP_DIR = path.join(__dirname, '..');

let chosen = SUITES;
if (FAST_ONLY) chosen = chosen.filter(s => s.group === 'fast');
if (ONLY) chosen = chosen.filter(s => ONLY.includes(s.name));

if (chosen.length === 0) {
  console.error('没有匹配的验收脚本。可用 --only ' + SUITES.map(s => s.name).join(','));
  process.exit(2);
}

console.log('='.repeat(72));
console.log(`验收总入口：共 ${chosen.length} 个脚本`
  + (FAST_ONLY ? '（--fast：仅快速组）' : '')
  + (ONLY ? `（--only ${ONLY.join(',')}）` : ''));
console.log('='.repeat(72));

function runOne(suite) {
  return new Promise(resolve => {
    const tmpdir = path.join('output', `_vt_${suite.name}`);
    const argv = [path.join(SCRIPTS_DIR, suite.script)];
    if (NEEDS_TMPDIR.has(suite.name)) argv.push('--tmpdir', tmpdir);

    const t0 = Date.now();
    execFile(process.execPath, argv, {
      cwd: APP_DIR,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20 * 60 * 1000
    }, (err, stdout, stderr) => {
      const ms = Date.now() - t0;
      const text = String(stdout || '') + String(stderr || '');
      // 取 "结果: N 通过 / M 失败" 或 "=== 结果：N 通过 / M 失败 ==="
      const m = text.match(/结果[:：]\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
      const passed = m ? parseInt(m[1], 10) : null;
      const failed = m ? parseInt(m[2], 10) : null;
      // 清理该脚本的临时目录
      try {
        const abs = path.join(APP_DIR, tmpdir);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
      } catch (e) {}
      resolve({
        name: suite.name,
        desc: suite.desc,
        code: err ? (err.code === undefined ? 1 : err.code) : 0,
        passed, failed, ms,
        tail: failed ? text.split('\n').filter(l => l.includes('❌')).slice(0, 8).join('\n') : ''
      });
    });
  });
}

(async () => {
  const results = [];
  for (const suite of chosen) {
    process.stdout.write(`  ⏳ ${suite.name.padEnd(20)} `);
    const r = await runOne(suite);
    results.push(r);
    const ok = r.code === 0 && (r.failed === null || r.failed === 0);
    const stat = r.passed !== null ? `${r.passed}/${r.passed + r.failed}` : '?';
    console.log(`${ok ? '✅' : '❌'}  ${stat.padEnd(8)} ${(r.ms / 1000).toFixed(1)}s  ${suite.desc}`);
    if (!ok && r.tail) {
      console.log('     ' + r.tail.split('\n').join('\n     '));
    }
  }

  const totalPassed = results.reduce((a, r) => a + (r.passed || 0), 0);
  const totalFailed = results.reduce((a, r) => a + (r.failed || 0), 0);
  const badSuites = results.filter(r => r.code !== 0 || (r.failed !== null && r.failed > 0));

  console.log('\n' + '='.repeat(72));
  console.log(`总计: ${results.length} 个脚本 | ${totalPassed} 项通过 / ${totalFailed} 项失败`);
  if (badSuites.length) {
    console.log('未通过的脚本: ' + badSuites.map(r => r.name).join(', '));
  } else {
    console.log('全部通过 ✅');
  }
  console.log('='.repeat(72));
  process.exit(badSuites.length === 0 ? 0 : 1);
})();
