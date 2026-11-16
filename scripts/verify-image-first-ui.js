#!/usr/bin/env node
// ============================================================
// 小智「逐段出图 + 审图暂停」前端验收（2026-11-16）
// ------------------------------------------------------------
// 契约：app/docs/交接/2026-11-16-出图审图-接口契约.md §1 / §2.3 / §2.4 / §3.1 / §3.2
// 作用域：web/src/store.js、web/src/components/assistant.js、
//         web/src/components/xiaozhiPlan.js、web/src/components/taskDrawer.js
//
// 本脚本只做**静态接线**断言 + 可选运行中 3001 的**只读** GET：
//   · 不建任务、不出图、不调付费接口、不改任何数据、不起第二实例；
//   · 唯一可以被算作「通过」的运行时证据是 GET /api/assistant/info 的字段结构；
//   · 跳过（SKIP）一律不算通过，末尾单独报数。
//
// **未验证**：浏览器里的真实交互（勾开关 → 确认执行 → 出图后出现「图已出好」卡片 →
// 点「继续生成」）由 Lead 用真实浏览器验收；本脚本证明不了布局、样式与点击手感。
//
// 用法：node scripts/verify-image-first-ui.js
// ============================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const WEB = path.join(APP, 'web');
const BASE = process.env.XZ_BASE || 'http://127.0.0.1:3001';

const F_STORE = path.join(WEB, 'src', 'store.js');
const F_ASSIST = path.join(WEB, 'src', 'components', 'assistant.js');
const F_PLAN = path.join(WEB, 'src', 'components', 'xiaozhiPlan.js');
const F_DRAWER = path.join(WEB, 'src', 'components', 'taskDrawer.js');
const F_SETTINGS = path.join(WEB, 'src', 'screens', 'settingsPage.js');

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? '  —  ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? '  —  ' + detail : ''));
  }
}
// 跳过 ≠ 通过：不计入 pass，末尾单独报数（AGENTS §5：skipped 不许冒充 passed）。
function skipCheck(name, why) {
  skip++;
  console.log('  SKIP ' + name + '  —  ' + why);
}
function section(title) { console.log('\n' + title); }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function count(hay, re) { return (hay.match(re) || []).length; }
// 取一段源码：从 startRe 命中处到 endRe 命中处（不含），取不到返回 ''
function slice(src, startRe, endRe, maxLen) {
  const i = src.search(startRe);
  if (i < 0) return '';
  const rest = src.slice(i);
  const j = endRe ? rest.search(endRe) : -1;
  return (j > 0 ? rest.slice(0, j) : rest.slice(0, maxLen || 4000));
}

(async () => {
  console.log('================================================================');
  console.log('小智「逐段出图 + 审图暂停」前端验收（静态 + 3001 只读）  BASE=' + BASE);
  console.log('契约：docs/交接/2026-11-16-出图审图-接口契约.md');
  console.log('================================================================');

  if (!fs.existsSync(F_STORE) || !fs.existsSync(F_ASSIST)
    || !fs.existsSync(F_PLAN) || !fs.existsSync(F_DRAWER)) {
    console.error('缺少被测文件：web/src/store.js / components/{assistant,xiaozhiPlan,taskDrawer}.js');
    process.exit(2);
  }
  const store = read(F_STORE);
  const assist = read(F_ASSIST);
  const plan = read(F_PLAN);
  const drawer = read(F_DRAWER);
  const settings = read(F_SETTINGS);

  // ------------------------------------------------------------
  section('[1] store.js：readRuntimeConfig 对所有 model 都带 5 个图片字段（契约 §1）');
  const storeBase = slice(store, /const base = \{/, /\n  \};/);
  check('store.js 有 const base = {…} 基座', storeBase.length > 0, String(storeBase.length) + ' chars');
  check('base.imageApiKey ← cfg.imageKey', /imageApiKey: cfg\.imageKey \|\| ''/.test(storeBase));
  check('base.imageBaseUrl ← cfg.imageBaseUrl', /imageBaseUrl: cfg\.imageBaseUrl \|\| ''/.test(storeBase));
  check('base.imageProvider ← cfg.imageProvider', /imageProvider: cfg\.imageProvider \|\| ''/.test(storeBase));
  check('base.imageModel ← cfg.imageModel', /imageModel: cfg\.imageModel \|\| ''/.test(storeBase));
  check('base.imageSize ← cfg.imageSize', /imageSize: cfg\.imageSize \|\| ''/.test(storeBase));
  check('5 个图片字段都在基座里（不在某个 model 分支内）',
    count(storeBase, /image(ApiKey|BaseUrl|Provider|Model|Size):/g) === 5,
    String(count(storeBase, /image(ApiKey|BaseUrl|Provider|Model|Size):/g)) + ' 个');
  check('各 model 分支均展开 ...base（≥4 处）', count(store, /\.\.\.base/g) >= 4, count(store, /\.\.\.base/g) + ' 处');
  check('未命中的 model 回退 return base（同样带图片字段）', /return base;/.test(store));
  check('仍然只读 localStorage（不写、不上报）',
    /localStorage\.getItem\('vs_config'\)/.test(store) && !/localStorage\.setItem/.test(store));
  check('Key 不打印：store.js 无 console.log', !/console\.log/.test(store));

  // ------------------------------------------------------------
  section('[2] 开关：默认关闭（用户可手动打开）+ localStorage 键 vs_image_per_clip（2026-11-16 20:4x 用户决定）');
  check("assistant.js 键名 vs_image_per_clip", /IMAGE_PER_CLIP_KEY = 'vs_image_per_clip'/.test(assist));
  const readFn = slice(assist, /function readImagePerClip\(\)/, /\n\}/);
  check('readImagePerClip：只有 "1" 是开（缺省=关）', /=== '1'/.test(readFn), readFn.trim().slice(0, 90));
  check('readImagePerClip：localStorage 取不到时也算关（catch 返回 false）', /catch \(e\) \{ return false; \}/.test(readFn));
  const writeFn = slice(assist, /function writeImagePerClip\(on\)/, /\n\}/);
  check("writeImagePerClip：写 '1' / '0'", /setItem\(IMAGE_PER_CLIP_KEY, on \? '1' : '0'\)/.test(writeFn));
  check('React 状态默认取 readImagePerClip', /const \[imagePerClip, setImagePerClip\] = useState\(readImagePerClip\)/.test(assist));
  check('切换函数 toggleImagePerClip 同时更新状态与 localStorage',
    /function toggleImagePerClip\(on\)/.test(assist) && /writeImagePerClip\(next\)/.test(assist));
  check('计划卡默认关闭：imagePerClip === true', /const imgOn = imagePerClip === true;/.test(plan));
  check('开关是受控 checkbox 且可点（checked + onChange）',
    /type="checkbox"[\s\S]{0,160}checked=\$\{imgOn\}[\s\S]{0,160}onChange=\$\{\(e\) => onToggleImage && onToggleImage\(e\.target\.checked\)\}/.test(plan));
  check('两处 PlanCard 都接收开关（页面模式 + 浮窗模式）',
    count(assist, /imagePerClip=\$\{imagePerClip\}/g) >= 2 && count(assist, /onToggleImage=\$\{toggleImagePerClip\}/g) >= 2,
    count(assist, /onToggleImage=\$\{toggleImagePerClip\}/g) + ' 处');

  // ------------------------------------------------------------
  section('[3] confirmPlan：请求体带 imagePerClip + 5 个图片字段（契约 §1/§3.1）');
  check('POST /api/assistant/execute 仍在', /\/api\/assistant\/execute/.test(assist));
  check('请求体显式 imagePerClip: imagePerClip === true',
    /body: JSON\.stringify\(\{[\s\S]{0,300}imagePerClip: imagePerClip === true/.test(assist));
  // 2026-11-16 集成修订：imagePerClip 放在 `...runtime` 之后（避免被同名键覆盖），
  // 且 `...runtime` 必须紧跟 `approved: true,`（scripts/verify-assistant.js 的既有静态断言）。
  check('请求体展开 ...runtime（5 个图片字段随行；且紧跟 approved 以保持既有断言）',
    /planId: plan\.planId, approved: true, \.\.\.runtime[\s\S]{0,100}imagePerClip: imagePerClip === true/.test(assist));
  const backendGuard = slice(assist, /if \(imagePerClip && !imageBackendReady\) \{/, /\n    \}/);
  check('服务端无 image 能力（旧进程）时 confirmPlan 拦截（不误跑纯文生视频）',
    /!imageBackendReady/.test(assist) && backendGuard.length > 0 && /return;/.test(backendGuard)
    && /重启 3001/.test(assist));
  // 2026-11-16 20:30 实测更新：WhaleTV 中转图生视频已确认可用（/video/generations + data URL 出片），
  // 因此「中转 + 出图」的前端拦截与红色提示必须已经删除（否则会挡住合法链路）。
  check('中转通道 + 出图 → 不再被 confirmPlan 拦截（旧 400 结论已被推翻）',
    !/if \(imagePerClip && plan\.model === 'openai-video'\)/.test(assist)
    && !/不收首帧图/.test(assist));
  check('PlanCard 不再显示「中转不收首帧图」红色提示',
    !/plan\.model === 'openai-video'/.test(plan) && !/不收首帧图/.test(plan));
  const warnBlock = slice(assist, /if \(imagePerClip && !runtime\.imageApiKey\) \{/, /\n    \}/);
  check('图片 Key 为空 → 对话里警告（不拦截）', /设置里没有填「图片生成」的 Key/.test(warnBlock));
  check('该警告块内没有 return（确认流程不被拦）', warnBlock.length > 0 && !/return;/.test(warnBlock));
  check('警告风格与既有「没填 Key」警告一致（⚠ 前缀）', /content: '⚠ 设置里没有填「图片生成」/.test(assist));
  const notReady = slice(assist, /j\.code === 'IMAGE_GEN_NOT_READY'/, /return;/);
  check('处理 IMAGE_GEN_NOT_READY：显示后端 error 原文',
    /j\.error \|\| '出图未就绪/.test(notReady), notReady.trim().slice(0, 100));
  check('IMAGE_GEN_NOT_READY 文案说明「没有建任务、没有费用」', /没有建任务，也没有产生费用/.test(assist));

  // ------------------------------------------------------------
  section('[4] 计费提示：单价只来自 /api/assistant/info 的 image.unitCny（禁止硬编码）');
  check('assistant.js 读 backend.info.image', /backend\.info && backend\.info\.image/.test(assist));
  check('assistant.js 取 image.unitCny 赋给 imageUnitCny', /const imageUnitCny = \(backend\.info && backend\.info\.image\) \? backend\.info\.image\.unitCny : null;/.test(assist));
  check('页面 + 浮窗都把 unitCny 传给计划卡',
    count(assist, /unitCny=\$\{imageUnitCny\}/g) >= 2, count(assist, /unitCny=\$\{imageUnitCny\}/g) + ' 处');
  check('计划卡用 imageBillingText(plan, unitCny) 出数字', /imageBillingText\(plan, unitCny\)/.test(plan));
  check('单价可用 → 张数 × 单价 ≈ 合计（都是变量，无字面价）',
    /money\(unit\)/.test(plan) && /money\(unit \* n\)/.test(plan));
  check('单价缺失/0 → 显示「单价未知」', /单价未知/.test(plan));
  check('张数来自 plan.clipCount（不是写死）', /Number\(plan && plan\.clipCount\)/.test(plan));
  check('提示出图后暂停等审图', /出图完成后整批暂停，等你审图后再点继续/.test(plan));
  for (const [name, src] of [['store.js', store], ['assistant.js', assist], ['xiaozhiPlan.js', plan], ['taskDrawer.js', drawer]]) {
    check(name + ' 不含硬编码图片单价 0.20 / ¥0.2', !/0\.20/.test(src) && !/¥0\.2(?![0-9])/.test(src));
  }

  // ------------------------------------------------------------
  section('[5] 审图暂停卡片 + 「继续生成」→ POST /api/tasks/:id/unpause（契约 §2.3/§2.4）');
  check('assistant.js 只在 awaitingImageReview === true 时取 reviewTask',
    /const reviewTask = \(xstate && xstate\.task && xstate\.task\.awaitingImageReview === true\) \? xstate\.task : null;/.test(assist));
  check('画面里出现 reviewTask 守卫的卡片渲染（页面 + 浮窗 ≥2 处）',
    count(assist, /reviewTask && html/g) >= 2, count(assist, /reviewTask && html/g) + ' 处');
  check('两处都渲染 <ImageReviewCard>',
    count(assist, /<\$\{ImageReviewCard\}/g) >= 2, count(assist, /<\$\{ImageReviewCard\}/g) + ' 处');
  check('卡片吃 imageReview 计数（total/generated/failed + 待审）',
    /review=\$\{reviewTask\.imageReview\}/.test(assist)
    && /rv\.total/.test(plan) && /rv\.generated/.test(plan) && /rv\.failed/.test(plan));
  check('pendingPhotos 缺失时不谎报 0（回落成 generated）',
    /Number\.isFinite\(pendingRaw\) \? Math\.max\(0, Math\.floor\(pendingRaw\)\) : generated/.test(plan));
  check('「图已出好」标题', /图已出好/.test(plan));
  check('「去审图」按钮 → navigate(/library)', /去审图/.test(plan) && /navigate\('\/library'\)/.test(assist));
  check('「继续生成」按钮', /继续生成/.test(plan));
  check('unpause 调用带 taskId 与 same-origin',
    /'\/api\/tasks\/' \+ encodeURIComponent\(tid\) \+ '\/unpause'/.test(assist)
    && /unpause'[\s\S]{0,200}credentials: 'same-origin'/.test(assist), null);
  const unpauseBlock = slice(assist, /async function continueAfterReview\(\)/, /function dismissGreet/);
  check('unpause 用 POST', /method: 'POST'/.test(unpauseBlock));
  check('成功后提示「已继续，开始生成视频」', /已继续，开始生成视频/.test(unpauseBlock));
  check('成功后保持轮询（立刻再拉一次 /api/assistant/state）', /\/api\/assistant\/state\?sessionId=/.test(unpauseBlock));
  check('失败只报原因，不假装成功', /继续失败：/.test(unpauseBlock));
  check('普通 paused 不抢提示：卡片仅由 awaitingImageReview 决定（无独立 paused 分支）',
    !/reviewTask = \(xstate\.task\.status === 'paused'\)/.test(assist));

  // ------------------------------------------------------------
  section('[6] xiaozhiPlan.js：计划卡出图行 + 状态条「等待审图」（契约 §1/§2.3）');
  check('PlanCard 签名含 imagePerClip/onToggleImage/unitCny/hasImageKey(+imageBackendReady/onSetResolution)',
    /export function PlanCard\(\{ plan, busy, onConfirm, onEdit, imagePerClip, onToggleImage, unitCny, hasImageKey, imageBackendReady, onSetResolution \}\)/.test(plan));
  check('计划卡可改分辨率（480P/720P/1080P 按钮 + 回调 onSetResolution）',
    /'480p', '720p', '1080p'/.test(plan) && /onSetResolution/.test(plan)
    && /onSetResolution=\$\{\(r\) => send\('改成 ' \+ r\)\}/.test(assist));
  check('计划卡一行「出图：逐段 N 张 → 图生视频」',
    /'出图', imgOn \? `逐段 \$\{plan\.clipCount\} 张 → 图生视频` : '关（纯文生视频）'/.test(plan));
  check('关掉时文案「关（纯文生视频）」', /关（纯文生视频）/.test(plan));
  check('开时说明纯文生视频是旧链路（行为不变）', /纯文生视频（旧链路，不出图/.test(plan));
  check('StateStrip 读取 task.awaitingImageReview', /const awaiting = !!\(task && task\.awaitingImageReview === true\);/.test(plan));
  check('StateStrip 在审图时显示「等待审图」', /awaiting \? '等待审图' : \(state\.label \|\| state\.state\)/.test(plan));
  check('StateStrip 审图态用 warn 色（不是运行中的 accent）', /awaiting \? 'text-warn'/.test(plan));
  check('ImageReviewCard 已导出（assistant.js 可 import）', /export function ImageReviewCard\(/.test(plan));

  // React 的 props 大小写敏感：调用侧的属性名与组件解构名对不上时不会报错，
  // 只会静默变成 undefined（例如 hasImageKey 写成 hasImagekey 就永远显示「没填 Key」）。
  const planCallProps = [
    ['imagePerClip', 'imagePerClip'],
    ['onToggleImage', 'toggleImagePerClip'],
    ['unitCny', 'imageUnitCny'],
    ['hasImageKey', 'imageKeyPresent']
  ];
  for (const [prop, value] of planCallProps) {
    const callRe = new RegExp(prop + '=\\$\\{' + value + '\\}', 'g');
    check('  PlanCard 传参 ' + prop + ' ↔ 签名同名（≥2 处调用）',
      count(plan, new RegExp('\\b' + prop + '\\b')) >= 1 && count(assist, callRe) >= 2,
      count(assist, callRe) + ' 处');
  }
  const reviewCallProps = [
    ['review', 'reviewTask\\.imageReview'],
    ['taskId', 'reviewTask\\.taskId'],
    ['currentStep', 'reviewTask\\.currentStep'],
    ['busy', 'reviewBusy'],
    ['onGoReview', 'goReview'],
    ['onContinue', 'continueAfterReview']
  ];
  for (const [prop, value] of reviewCallProps) {
    const callRe = new RegExp(prop + '=\\$\\{' + value + '\\}', 'g');
    check('  ImageReviewCard 传参 ' + prop + ' ↔ 签名同名（≥2 处调用）',
      count(plan, new RegExp('\\b' + prop + '\\b')) >= 1 && count(assist, callRe) >= 2,
      count(assist, callRe) + ' 处');
  }

  // ------------------------------------------------------------
  section('[7] taskDrawer.js：buildRuntimeConfig 补 6 个出图字段（重启后补跑带 Key）');
  const buildFn = slice(drawer, /function buildRuntimeConfig\(task\) \{/, /\n\}\n/);
  check('buildRuntimeConfig 仍在', buildFn.length > 0, String(buildFn.length) + ' chars');
  // 注意键名映射不是同名：运行时字段 imageApiKey ← 设置页键 imageKey（其余四个同名）。
  const drawerKeys = [
    ['imageApiKey', 'imageKey'],
    ['imageBaseUrl', 'imageBaseUrl'],
    ['imageProvider', 'imageProvider'],
    ['imageModel', 'imageModel'],
    ['imageSize', 'imageSize']
  ];
  for (const [field, cfgKey] of drawerKeys) {
    check('  含 ' + field + '（rc 优先 → cfg.' + cfgKey + '）',
      new RegExp(field + ': rc\\.' + field + ' \\|\\| cfg\\.' + cfgKey + "\\s*\\|\\| ''").test(buildFn));
  }
  check('任务已有值优先、回落 vs_config（rc.imageApiKey || cfg.imageKey）',
    /imageApiKey: rc\.imageApiKey \|\| cfg\.imageKey \|\| ''/.test(buildFn));
  check('imagePerClip 为布尔（rc.imagePerClip === true，不从全局开关兜底）',
    /imagePerClip: rc\.imagePerClip === true/.test(buildFn));
  check('6 个字段进入 base（随每个 model 分支返回）', /\.\.\.image,/.test(buildFn));
  check('未改动其它逻辑：apiKey 分支仍在（dashscope/openai-video）',
    /apiKey: cfg\.dashScopeKey/.test(buildFn) && /apiKey: cfg\.whaletvKey/.test(buildFn));
  check('没在 buildRuntimeConfig 里打印/上报 Key', !/console\.|fetch\(/.test(buildFn));

  // ------------------------------------------------------------
  section('[8] 键名与设置页一致（只读核对，settingsPage 不属本窗口写作用域）');
  check('设置页有「图片生成」分组 4 个输入框',
    /'imageKey', 'API Key'/.test(settings) && /'imageBaseUrl'/.test(settings)
    && /'imageModel'/.test(settings) && /'imageSize'/.test(settings));
  check('设置页 imageProvider 走下拉（imageProvider: e.target.value）', /imageProvider: e\.target\.value/.test(settings));
  check('store.js 映射的 5 个键名与设置页同名',
    ['imageKey', 'imageBaseUrl', 'imageProvider', 'imageModel', 'imageSize']
      .every((k) => new RegExp("cfg\\." + k + " \\|\\| ''").test(store)));

  // ------------------------------------------------------------
  section('[9] ESM 语法自检（临时 .mjs + node --check；不执行模块）');
  const targets = [F_STORE, F_ASSIST, F_PLAN, F_DRAWER];
  let tmpDir = null;
  try { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-image-first-ui-')); } catch (e) { tmpDir = null; }
  if (!tmpDir) {
    skipCheck('ESM 语法自检', '无法创建临时目录');
  } else {
    for (const f of targets) {
      const rel = path.relative(APP, f).replace(/[\\/]/g, '/');
      const dst = path.join(tmpDir, rel.replace(/[\\/]/g, '_') + '.mjs');
      fs.writeFileSync(dst, read(f), 'utf8');
      try {
        execFileSync(process.execPath, ['--check', dst], { stdio: 'pipe' });
        check('ESM 语法 ' + rel, true);
      } catch (e) {
        const code = e && e.code;
        if (code === 'EPERM' || code === 'ENOENT' || code === 'EACCES') {
          // AGENTS §4.1：本沙箱里子进程 spawn 可能一律 EPERM，属环境限制，不算代码问题。
          skipCheck('ESM 语法 ' + rel, '本环境不允许 spawn 子进程（' + code + '）：未验证，改用手工括号自查');
        } else {
          const err = String((e && e.stderr) || (e && e.message) || e).split('\n').slice(0, 4).join(' ').slice(0, 200);
          check('ESM 语法 ' + rel, false, err);
        }
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  }

  // ------------------------------------------------------------
  section('[10] 运行中 3001 只读（唯一 GET /api/assistant/info；不建任务、不出图、不付费）');
  try {
    const r = await fetch(BASE + '/api/assistant/info', { credentials: 'omit' });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { j = null; }
    const looksLogin = r.status === 401 || r.status === 403
      || (j === null && /login|password/i.test(txt.slice(0, 600)));
    if (looksLogin) {
      skipCheck('GET /api/assistant/info', '需要登录（HTTP ' + r.status + '）：未登录时无法验证，标「未验证」');
    } else if (!r.ok || !j || j.ok !== true) {
      skipCheck('GET /api/assistant/info', '服务端无响应或返回异常（HTTP ' + r.status + '）：未验证');
    } else if (!j.image || typeof j.image !== 'object') {
      skipCheck('info.image 结构', '运行中仍是旧进程（没有 image 字段）：重启后未验证');
    } else {
      const keys = ['usable', 'provider', 'model', 'size', 'unitCny', 'hasServerKey'];
      const missing = keys.filter((k) => !(k in j.image));
      check('info.image 6 个字段齐全（契约 §3.2）', missing.length === 0,
        missing.length ? '缺 ' + missing.join(',') : JSON.stringify({
          usable: j.image.usable, provider: j.image.provider, model: j.image.model,
          size: j.image.size, unitCny: j.image.unitCny, hasServerKey: j.image.hasServerKey
        }));
      check('info.image.unitCny 是 number 或 null', j.image.unitCny === null || typeof j.image.unitCny === 'number',
        String(j.image.unitCny));
      check('info.image 不含明文 Key 字段',
        !Object.keys(j.image).some((k) => /apikey|secret|token/i.test(k)),
        Object.keys(j.image).join(','));
    }
  } catch (e) {
    skipCheck('GET /api/assistant/info', '连不上 ' + BASE + '（' + (e && e.message ? e.message : e) + '）：未验证');
  }

  console.log('\n================================================================');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败'
    + (skip ? '（另有 ' + skip + ' 项跳过，跳过不等于通过）' : ''));
  console.log('未验证：浏览器交互（开关点击、出图后暂停卡片、继续生成按钮）需真实浏览器人工验收。');
  console.log('================================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('VERIFY ERROR:', (e && e.stack) || e);
  process.exit(2);
});
