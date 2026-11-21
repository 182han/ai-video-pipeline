// ==========================================
// verify-create-page.js —— 创作页四项（2026-11-21 用户报）：
//   ① 英文模式创作页提示词仍是中文（服务端 composer / 前端显式 lang）
//   ② 创作页整块崩「i2vUnsupported is not defined」（p2/p4 截图）
//   ③ Show all / Collapse 看不出来区别（只折叠前 12 段、无提示）
//   ④ 每次进创作页场景卡都一样 → 加「换一批」（seed）+ 状态条/监控消息英文
//
// 纯静态 + 纯函数：不建任务、不调用任何模型、不产生费用。
// ==========================================
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); } else {
    failed += 1;
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + String(extra).replace(/\n/g, ' | ').slice(0, 260)));
  }
}
function group(t) { console.log('\n[' + t + ']'); }
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CJK = /[\u4e00-\u9fff]/;

const createSrc = read('web/src/screens/createSmart.js');
const serverSrc = read('server.js');
const smSrc = read('src/assistant/stateMachine.js');
const supSrc = read('src/assistant/supervisor.js');
const msgSrc = read('web/src/i18n/messages/createSmart.js');
const xzSrc = read('web/src/i18n/messages/xiaozhi.js');

try {
  // ================= [1] 崩溃：i2vUnsupported =================
  group('1. 创作页崩溃（p2/p4：i2vUnsupported is not defined）');
  const uses = (createSrc.match(/i2vUnsupported/g) || []).length;
  const declares = /const i2vUnsupported\s*=/.test(createSrc);
  ok('createSmart.js 里 i2vUnsupported 有声明（不再引用未定义变量）', declares);
  ok('i2vUnsupported 的语义 = 用图 + 通道不在服务端 i2v 能力表里', /i2vModels\.includes\(effectiveModel\)/.test(createSrc) && /useImages\s*&&/.test(createSrc));
  ok('能力表来自 /api/image-gen/status 的 i2vModels', /\/api\/image-gen\/status/.test(createSrc) && /j\.i2vModels/.test(createSrc));
  ok('禁用时页面给出原因（i2vUnsupported 文案），不是静默灰按钮',
    /createSmart\.errors\.i2vUnsupported/.test(createSrc)
    && msgSrc.includes("i2vUnsupported: '当前视频模型") && msgSrc.includes('i2vUnsupported: \'The current video model'));
  ok('纯文生视频（不用图）永远不会被 i2v 判定禁用', /useImages\s*&&\s*i2vModels\.length\s*&&/.test(createSrc));
  console.log('    （引用次数 ' + uses + '，声明 ' + (declares ? '有' : '无') + '）');

  // 真渲染：把浏览器 ESM 改写成脚本在 vm 里跑，**逐步**渲染 1–5 步。
  // 2026-11-21 教训：i2vUnsupported 只在第 4/5 步求值时崩，只渲染第 1 步测不到，
  // 静态 grep 也测不到（实测：把声明删掉后第 4/5 步必抛 ReferenceError）。
  const probe = require('./lib-render-probe');
  const zhRun = probe.renderWizardSteps('web/src/screens/createSmart.js', 'CreateSmartWizard', { lang: 'zh', steps: [1, 2, 3, 4, 5] });
  ok('逐步渲染（zh）第 1–5 步均不抛 ReferenceError（i2vUnsupported 已定义）', zhRun.ok,
    JSON.stringify(zhRun.results));
  const enRun = probe.renderWizardSteps('web/src/screens/createSmart.js', 'CreateSmartWizard', { lang: 'en', steps: [1, 2, 3, 4, 5] });
  ok('逐步渲染（en）第 1–5 步均不抛异常', enRun.ok, JSON.stringify(enRun.results));

  // ================= [2] 英文提示词 =================
  group('2. 英文模式提示词（截图①）');
  const pc = require('../src/promptComposer');
  const sc = require('../src/sceneCards');
  const plan = sc.allocate(3, { recordCooling: false, seed: 'verify-create-page' });
  const card = sc.getCardById(plan.used[0].id);
  const en = pc.composeClipPatch(card, { lang: 'en' });
  const zh = pc.composeClipPatch(card, { lang: 'zh' });
  ok('composer 英文产出确实是英文', /[A-Za-z]/.test(en.prompt) && !CJK.test(en.prompt.replace(/[^\u4e00-\u9fff]/g, '')), en.prompt.slice(0, 100));
  ok('composer 中文产出仍是中文（零回归）', CJK.test(zh.prompt), zh.prompt.slice(0, 60));
  ok('composeClipPatch 标记 promptLanguage', en.promptLanguage === 'en');
  ok('服务端 /api/scene-cards/preview 接受显式 ?lang= 并回显 lang + promptLanguage',
    /i18n\.normalizeLang\(req\.query\.lang\)/.test(serverSrc) && /res\.json\(\{ ok: true, count: cards\.length, lang, cards \}\)/.test(serverSrc)
    && /promptLanguage: patch\.promptLanguage/.test(serverSrc));
  ok('服务端 ?ids=（换语言不换卡）：planFromIds 取同一批，坏 id 直接 400',
    /planFromIds\(ids, \{ recordCooling: false \}\)/.test(serverSrc) && /SCENE_CARDS_MISSING_CARD/.test(serverSrc)
    && /idsParam/.test(serverSrc));
  ok('前端「换语言」用 ?ids= 原样重拼（不重新抽卡）', /'&ids=' \+ encodeURIComponent\(ids\.join\(','\)\)/.test(createSrc));
  ok('前端草稿记 draftLang，挂载时语言不同即重算（「重启+刷新仍中文」的根因）',
    /draftLang: uiLang\(\)/.test(createSrc) && /draftLang !== uiLang\(\)\) relocalizePrompts/.test(createSrc));
  ok('前端请求带 &lang=（不再只靠 cookie 推断）', /'&lang=' \+ encodeURIComponent\(uiLang\(\)\)/.test(createSrc));
  ok('前端英文界面兜底：提示词仍含中文 → 按 id 重新取一次（有上限，一次）', /CJK_RE\.test/.test(createSrc) && /lang=en&seed=/.test(createSrc));
  ok('切换语言后按当前语言重算提示词（草稿里的旧语言文案不吃香）', /subscribeLocale/.test(createSrc) && /loadCards\('refresh'\)|mode === 'refresh'/.test(createSrc));

  // ================= [3] Show all / Collapse =================
  group('3. Show all / Collapse 的区别（截图②）');
  ok('按钮只在「超过 12 段」时出现（否则它本来就什么都不做）', /prompts\.length > 12 && html`<\$\{Btn\} onClick=\$\{\(\) => setShowAll\(!showAll\)\}/.test(createSrc));
  ok('按钮文字带段数（显示全部 N 段 / 收起），不用户猜', /createSmart\.step2\.showAll', \{ n: prompts\.length \}/.test(createSrc));
  ok('折叠时明确告诉用户还有几段、且会用自动提示词提交', /createSmart\.step2\.hidden/.test(createSrc) && /createSmart\.step2\.showAllHint/.test(createSrc));
  ok('英文文案同义（Show all {n} clips / Collapse / hint）',
    /showAll: 'Show all \{n\} clips'/.test(msgSrc) && /showAllHint:/.test(msgSrc) && /collapse: 'Collapse'/.test(msgSrc));

  // ================= [4] 换一批 + 状态/监控语言 =================
  group('4. 场景卡「换一批」+ 失败提醒英文');
  ok('「换一批场景卡」按钮存在（只读预览，不占卡）', /createSmart\.step2\.reshuffle/.test(createSrc) && /loadCards\('reshuffle'\)/.test(createSrc));
  ok('换一批 = 新 seed；首次进①也是新 seed（每次不同）', /mode === 'refresh' \? \(seed \|\| ''\) : makeSeed\(\)/.test(createSrc));
  const a = sc.allocate(6, { recordCooling: false });
  const b = sc.allocate(6, { recordCooling: false });
  ok('allocate 不传 seed 时两次结果不同（-「每次都是这些卡」）',
    a.used.map((x) => x.id).join() !== b.used.map((x) => x.id).join());
  const s1 = sc.allocate(6, { recordCooling: false, seed: 'abc' }).used.map((x) => x.id).join();
  const s2 = sc.allocate(6, { recordCooling: false, seed: 'abc' }).used.map((x) => x.id).join();
  ok('同一 seed 可复现（同一种子同批卡）', s1 === s2);
  ok('seed 不写冷却文件（预览仍是只读）', /recordCooling: false, seed/.test(serverSrc) && !/recordCooling: true/.test(serverSrc.split("app.get('/api/scene-cards/preview'")[1].slice(0, 2500)));
  ok('状态条：stateMachine.summary 给 labelKey + 按语言 label',
    /labelKey: labelKeyOf\(state\.state\)/.test(smSrc) && /function labelFor/.test(smSrc));
  const stateMachine = require('../src/assistant/stateMachine');
  const st = { version: 1, planId: 'p', state: 'needs_user', events: [] };
  ok('needs_user 英文标签 = Needs your decision', stateMachine.summary(st, 'en').label === 'Needs your decision');
  ok('needs_user 中文标签不变（零回归）', stateMachine.summary(st, 'zh').label === '需要你决定');
  ok('前端状态条按 labelKey 本地化（catalog 中英都有）',
    /state\.labelKey/.test(read('web/src/components/xiaozhiPlan.js'))
    && /needs_user: '需要你决定'/.test(xzSrc) && /needs_user: 'Needs your decision'/.test(xzSrc));
  ok('监控消息（「还有 N 段没成功…」）有英文版', /still failed \(#\$\{failed\.map/.test(supSrc) && /The retries are used up and fill-ins are not available/.test(supSrc));
  ok('监控消息（审图/完成/失败/任务不见）都有英文版',
    /images are ready\. Open Library/.test(supSrc) && /Done! All \$\{task\.totalClips\} clips passed/.test(supSrc)
    && /The task failed:/.test(supSrc) && /The task is gone \(possibly deleted\)/.test(supSrc));
  ok('finish() 按监控语言选 replyEn（缺英文时如实回退中文）',
    /function finish\(m, state, type, payload, reply, replyEn\)/.test(supSrc) && /isEn && replyEn \? replyEn : reply/.test(supSrc));
  ok('startMonitor 记录语言，execute 传入 lang', /startMonitor\(state, lang\)/.test(supSrc) && /lang: i18n\.resolveLang\(lang, state\.lang, 'zh'\)/.test(supSrc));
} finally {
  try { /* 无临时文件 */ } catch (e) { /* ignore */ }
}

console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
