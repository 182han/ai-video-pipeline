// ============================================================
// 图片审核页「手动调色」验收（2026-11-16 契约 §3.5 / §4）
// ------------------------------------------------------------
// 本轮范围：web/src/screens/inventory.js 的 PhotosPanel 新增
//   4 条滑杆（亮度/对比度/饱和度/色温，-100..100，step 1，默认 0）
//   即时 CSS filter 预览（不发请求）→「应用」POST /api/photos/:id/adjust
//   →「恢复原图」{ reset:true }；成功后 photo 更新详情 + 缩略图 cache-busting；
//   失败把后端 error 原文显示在面板里。
//
// 本脚本以**静态断言**为主（读源码，不执行浏览器代码）：
//   · 接口路径 / 方法 / 头 / body / reset:true / 错误透出 / cache-busting 的写法
//   · 只用内联样式或页面里已有 class（app.css 是离线产物，新 Tailwind 类不生效）
//   · 不新增 import、不出现硬编码图片尺寸、拖动滑杆不发请求
// 可选只读探测：连运行中的 3001（GET /api/photos，需登录 cookie）。
//   3001 未运行 / 拿不到 cookie → 记「跳过」，不算通过也不算失败；
//   拿到响应但数据契约不符 → 记失败。全程只读，不发 POST，不计费。
//
// 不验证：真实浏览器里的点击、滑块手感、CSS filter 的实际观感（需要人/浏览器，
//   本脚本证明不了，见交付说明「未验证」）。
//
// 用法：node scripts/verify-photo-adjust-ui.js
// ============================================================
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
// 默认读仓库里的真实文件；PHOTO_ADJUST_UI_SRC 只给「负向自检」用（指向故意改坏的副本，
// 证明断言真的会红），正常验收不要设置它。
const SRC_PATH = process.env.PHOTO_ADJUST_UI_SRC
  ? path.resolve(process.env.PHOTO_ADJUST_UI_SRC)
  : path.join(APP, 'web', 'src', 'screens', 'inventory.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0;
let fail = 0;
let skip = 0;

function check(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`);
  }
}

// 跳过 ≠ 通过：单列计数，不并入 pass
function skipped(label, why) {
  skip++;
  console.log(`  ⏭ 跳过 ${label}${why ? '  —  ' + why : ''}`);
}

// 截取 startMarker → endMarker 之间的源码（找不到就返回空串）
function between(text, startMarker, endMarker) {
  const i = text.indexOf(startMarker);
  if (i < 0) return '';
  const j = endMarker ? text.indexOf(endMarker, i + startMarker.length) : -1;
  return text.slice(i, j > i ? j : undefined);
}

console.log('================================================================');
console.log('图片审核页 · 手动调色滑杆（契约 §3.5 / §4）');
console.log('================================================================');
console.log('源码: ' + path.relative(APP, SRC_PATH));

// ---------------- 定位 PhotosPanel 与「手动调色」区 ----------------
const panel = between(src, 'export function PhotosPanel(', '\n\n// ---------------- 成片 · 未完成（P6）');
const adjSection = between(src, "tr('library.photos.manualAdjust')", '${versions.length > 1 && html`');
const drawer = between(src, '${detail && html`', '${zoomImg && html`');

check(panel.length > 2000, '能定位到 PhotosPanel 的源码（防止断言空转）', panel.length + ' 字符');
check(adjSection.length > 500, '能定位到「手动调色」区域源码', adjSection.length + ' 字符');
check(drawer.includes("tr('library.photos.manualAdjust')"), '调色区在图片详情抽屉里（点开某张图才出现）');

// ---------------- 1. 4 条滑杆：label / min / max / step / 默认 0 ----------------
console.log('\n[1] 4 条滑杆');
check(src.includes('const ADJUST_KEYS = ['), '定义了调色参数表 ADJUST_KEYS（4 项）');
for (const [key, labelKey] of [['brightness', 'tasks.adjust.brightness'], ['contrast', 'tasks.adjust.contrast'], ['saturation', 'tasks.adjust.saturation'], ['temperature', 'tasks.adjust.temperature']]) {
  const re = new RegExp("\\{ key: '" + key + "', labelKey: '" + labelKey + "' \\}");
  check(re.test(src), `滑杆「${labelKey}」对应契约字段 ${key}`);
}
check(adjSection.includes('type="range"'), '滑杆是 input[type=range]');
check(adjSection.includes('min="-100"') && adjSection.includes('max="100"'), '滑杆范围 min=-100 / max=100');
check(adjSection.includes('step="1"'), '滑杆步长 step=1');
check(src.includes('const ADJUST_ZERO = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };'),
  '默认值全 0（ADJUST_ZERO）');
check(adjSection.includes('${adjParams[key]}'), '每条滑杆旁边显示当前数值');
check(adjSection.includes('aria-label=${tr(labelKey)}'), '滑杆带 aria-label（无障碍 / 自动化可定位）');

// ---------------- 2. 三个按钮 ----------------
console.log('\n[2] 按钮');
check(adjSection.includes(">${tr('library.photos.apply')}</button>"), '有「应用」按钮');
check(adjSection.includes(">${tr('library.photos.resetZero')}</button>"), '有「重置为 0」按钮');
check(adjSection.includes(">${tr('library.photos.revert')}</button>"), '有「恢复原图」按钮');
check(adjSection.includes('onClick=${applyAdjust}'), '「应用」接 applyAdjust');
check(adjSection.includes('onClick=${resetAdjustSliders}'), '「重置为 0」接 resetAdjustSliders（只清滑杆）');
check(adjSection.includes('onClick=${revertAdjust}'), '「恢复原图」接 revertAdjust');

// ---------------- 3. 接口调用：POST /api/photos/:id/adjust ----------------
console.log('\n[3] 接口调用');
const adjustCall = between(src, "+ '/adjust'", '});');
check(panel.includes("'/api/photos/' + encodeURIComponent(detail.id) + '/adjust'"),
  '调色/恢复都调 POST /api/photos/:id/adjust');
check(/method:\s*'POST'/.test(adjustCall), "请求方法 method: 'POST'");
check(/credentials:\s*'same-origin'/.test(adjustCall), "带 credentials: 'same-origin'");
check(/'Content-Type':\s*'application\/json'/.test(adjustCall), "Content-Type: application/json");
check(panel.includes('body: JSON.stringify(body)'), 'body 用 JSON.stringify 提交');
const applyBlock = between(src, 'async function applyAdjust()', 'async function revertAdjust()');
check(applyBlock.includes('Math.round('), '四个参数取整（契约：-100..100 整数）');
check(!/reset/.test(applyBlock), '「应用」body 不含 reset（reset 只属于「恢复原图」）');
const revertBlock = between(src, 'async function revertAdjust()', 'function resetAdjustSliders()');
check(/\{ reset:\s*true\s*\}/.test(revertBlock), '「恢复原图」body = { reset: true }');

// ---------------- 4. 成功后更新详情 + 缩略图 cache-busting ----------------
console.log('\n[4] 成功回写 + cache-busting');
check(panel.includes('adoptAdjustedPhoto(j.photo, j.url)'), '成功后用服务端返回的 photo 更新（不本地拼结果）');
check(panel.includes('setDetail(next)'), '详情用返回的 photo 覆盖');
check(panel.includes('setAdjParams(adjustParamsOf(next))'), '滑杆同步到服务端已生效参数（预览因此自动清掉）');
check(panel.includes('reload()'), '成功后重拉列表');
check(/url\.indexOf\('\?'\)\s*>=\s*0\s*\?\s*'&'\s*:\s*'\?'/.test(src),
  '原 url 已带 query 时用 & 续接（不会拼出两个 ?）');
check(/\+\s*'v='\s*\+\s*encodeURIComponent\(String\(tag\)\)/.test(src), "cache-busting 形式：url + '?v=' + tag");
check(panel.includes('next.updatedAt || Date.now()'), '版本号取 photo.updatedAt，缺失才用 Date.now()');
const bustUses = (panel.match(/withCacheBust\(/g) || []).length;
check(bustUses >= 4, '详情大图 + 列表缩略图都走 withCacheBust', 'PhotosPanel 内 ' + bustUses + ' 处');

// ---------------- 5. 失败：后端 error 原文显示，不吞 ----------------
console.log('\n[5] 错误显示');
check(panel.includes("if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + r.status));"),
  '非 2xx / ok!=true 一律抛错，错误取后端 error 原文');
// 2026-11-16 集成修订：后端 error 已带「调色失败：」前缀时不再叠一层（实测会出现
// 「调色失败：调色失败：ffmpeg…」）。断言改为「错误进 adjErr + 保留后端原文 + 有场景前缀兜底」。
check(/setAdjErr\(/.test(panel) && /library\.photos\.adjustFailed/.test(panel) && /library\.photos\.revertFailed/.test(panel)
  && /test\(msg\)/.test(panel) && /e\.message/.test(panel),
  '错误写进调色面板状态 adjErr（保留后端原文；后端无前缀时补场景前缀，不重复叠加）');
check(adjSection.includes('${adjErr && html`'), 'adjErr 在面板里渲染出来');
check(adjSection.includes("color: 'var(--danger)'"), '错误用危险色显示');
const postBlock = between(src, 'async function postAdjust(', 'async function applyAdjust()');
const catchBlock = between(postBlock, '} catch (e) {', '} finally {');
check(catchBlock.includes('setAdjErr('), 'catch 分支把错误写进面板');
check(!/成功|已应用/.test(catchBlock), 'catch 分支里没有伪造成功文案');

// ---------------- 6. 已调色 vN + 参数摘要 + 载入上次参数 ----------------
console.log('\n[6] 已调色状态');
check(src.includes('function adjustVersion(') && src.includes('adjust.current'), '版本号取 photo.adjust.current.version');
check(adjSection.includes("tr('library.photos.adjustedVersion'"), '有调色时显示「已调色 vN」');
check(panel.includes('adjustSummary(detail.adjust.params)'), '显示参数摘要（来自 photo.adjust.params）');
check(adjSection.includes("tr('library.photos.loadLast')"), '提供「载入上次参数」按钮');
check(panel.includes('setAdjParams(adjustParamsOf(detail))'), '「载入上次参数」把滑杆设回 photo.adjust.params');
check(src.includes('photo.adjust && photo.adjust.params'), '参数来源是 photo.adjust.params（契约结构）');

// ---------------- 7. 即时预览：CSS filter，拖动不发请求 ----------------
console.log('\n[7] 即时预览');
check(src.includes('function adjustPreviewFilter('), '有预览 filter 构造器 adjustPreviewFilter');
for (const fn of ['brightness(', 'contrast(', 'saturate(', 'sepia(', 'hue-rotate(']) {
  check(src.includes(fn), '近似预览用到 CSS ' + fn.slice(0, -1) + '()');
}
check(panel.includes("...(previewFilterText ? { filter: previewFilterText } : {})"), '详情大图套 CSS filter 预览');
check(panel.includes("const previewFilterText = adjustChanged ? adjustPreviewFilter(adjustDelta) : '';"),
  '预览由「滑杆值 - 服务端值」之差驱动（差为 0 自动清掉）');
const sliderBlock = between(adjSection, '<input type="range"', '/>');
check(sliderBlock.length > 80, '能截取到滑杆的 onInput/onChange 代码');
check(!/fetch\s*\(/.test(sliderBlock), '拖动滑杆不发请求（onChange 里没有 fetch）');

// ---------------- 8. 样式：只用内联样式 / 页面已有 class；不新增依赖 ----------------
console.log('\n[8] 样式与依赖');
const classNames = (adjSection.match(/className="([^"]+)"/g) || []).map((s) => s.slice('className="'.length, -1));
const outsideAdj = src.replace(adjSection, '');
const badTokens = [];
for (const cn of classNames) {
  for (const token of cn.split(/\s+/)) {
    if (token && !outsideAdj.includes(token)) badTokens.push(token);
  }
}
check(badTokens.length === 0, '调色区只用页面里已有的 class（不依赖新 Tailwind 类）',
  badTokens.length ? '别处未出现: ' + badTokens.join(', ') : classNames.length + ' 处 className');
check(panel.includes('style=${{'), '调色区用内联样式 style=${{...}}');
const imports = (src.match(/^import .*$/gm) || []);
check(imports.length === 5 && imports.every((l) => /from '\.\.\/(router|createDraft|components\/taskDrawer|components\/pauseControl|i18n\/index)\.js'/.test(l)),
  'import 仍是原有 4 个模块 + i18n（无第三方依赖）', String(imports.length) + ' 行');
check(!/\brequire\s*\(/.test(src), '前端文件不出现 require（浏览器原生 ESM）');

// ---------------- 9. 不硬编码图片尺寸 ----------------
console.log('\n[9] 尺寸');
const dims = panel.match(/\b(1696|1920|1080|1024|960|768|512|3840|2160)\b/g) || [];
check(dims.length === 0, 'PhotosPanel 里没有硬编码图片尺寸（宽高来自接口）', dims.join(','));
check(panel.includes("width: '100%', maxHeight: '420px', objectFit: 'contain'"),
  '详情大图自适应（100% + maxHeight + contain，不写死宽高）');
check(!/width:\s*'\d+px'/.test(adjSection), '调色区没有写死图片宽度');

// ---------------- 10. 语法可解析（解析，不执行） ----------------
console.log('\n[10] 语法');
let parseErr = '';
try {
  // 去掉 ESM 的 import/export 后用 new Function 仅做语法解析（不执行任何页面代码）
  const stripped = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  new Function(stripped); // eslint-disable-line no-new-func
} catch (e) {
  parseErr = e.message;
}
check(!parseErr, 'inventory.js 去掉 import/export 后语法可解析', parseErr);

// ================= 可选：运行中 3001 只读探测（不发 POST） =================
async function liveProbe() {
  console.log('\n[11] 运行中 3001（只读；拿不到就跳过，不算通过）');
  const base = 'http://127.0.0.1:3001';
  const timeoutMs = 4000;
  const opts = (extra) => Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, extra || {});

  let up = false;
  try {
    const r = await fetch(base + '/api/status', opts());
    up = r.ok;
    if (!up) skipped('连 3001', '/api/status HTTP ' + r.status);
  } catch (e) {
    skipped('连 3001', '3001 未运行或不可达（' + (e && e.name === 'TimeoutError' ? '超时' : (e && e.message) || e) + '）');
  }
  if (!up) return;

  // 静态资源放行：证明运行中的服务确实在发新前端文件（/app/src/* 不需要登录）
  try {
    const r = await fetch(base + '/app/src/screens/inventory.js', opts());
    const text = r.ok ? await r.text() : '';
    check(r.ok && text.includes('withCacheBust') && text.includes('手动调色'),
      '运行中的 3001 已下发带调色区的新 inventory.js', 'HTTP ' + r.status + ' / ' + text.length + ' 字符');
  } catch (e) {
    skipped('静态资源探测', (e && e.message) || String(e));
  }

  // 登录：只用 config 里的 bootstrap 账号尝试一次；失败即跳过（不重试，避免触发登录失败锁定）
  let cookie = '';
  try {
    const cfg = require(path.join(APP, 'config'));
    const user = String((cfg.AUTH && cfg.AUTH.bootstrapUser) || 'admin');
    const password = String((cfg.AUTH && cfg.AUTH.bootstrapPassword) || '');
    if (!password) {
      skipped('GET /api/photos 数据契约', '没有可用的 AUTH_PASSWORD（不猜密码、不重试）');
      return;
    }
    const r = await fetch(base + '/api/auth/login', opts({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password })
    }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      skipped('GET /api/photos 数据契约', '登录失败 HTTP ' + r.status + '（只尝试一次，避免触发失败锁定）');
      return;
    }
    const list = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : [r.headers.get('set-cookie') || ''];
    const m = list.join(';').match(/vs_session=[^;]+/);
    cookie = m ? m[0] : '';
    if (!cookie) {
      skipped('GET /api/photos 数据契约', '登录成功但没拿到 vs_session cookie');
      return;
    }
  } catch (e) {
    skipped('GET /api/photos 数据契约', '登录异常：' + ((e && e.message) || e));
    return;
  }

  // 面板数据源：GET /api/photos?final=1（只读）
  let listJson = null;
  try {
    const r = await fetch(base + '/api/photos?final=1', opts({ headers: { cookie } }));
    if (!r.ok) {
      skipped('GET /api/photos 数据契约', 'HTTP ' + r.status + '（可能是运行中进程还没重启/会话失效）');
      return;
    }
    listJson = await r.json().catch(() => ({}));
  } catch (e) {
    skipped('GET /api/photos 数据契约', '请求异常：' + ((e && e.message) || e));
    return;
  }
  check(Array.isArray(listJson.photos), 'GET /api/photos?final=1 返回 photos 数组');
  check(listJson.totals && typeof listJson.totals === 'object', '响应含 totals 汇总（顶部计数用）');
  check(typeof listJson.hiddenMissing === 'number', '响应含 hiddenMissing 计数（缺文件隐藏口径）');
  const photos = Array.isArray(listJson.photos) ? listJson.photos : [];
  check(photos.every((p) => p && p.id && p.url && p.status), '每张图都有 id / url / status（卡片渲染必需）',
    '共 ' + photos.length + ' 张');

  // 详情数据源：GET /api/photos/:id（只读；顺带看 adjust 结构有没有落库）
  if (!photos.length) {
    skipped('GET /api/photos/:id 详情契约', '图片库为空');
    return;
  }
  try {
    const d = photos[0];
    const r = await fetch(base + '/api/photos/' + encodeURIComponent(d.id), opts({ headers: { cookie } }));
    const j = await r.json().catch(() => ({}));
    check(r.ok && j.id === d.id, 'GET /api/photos/:id 可读（详情抽屉数据源）', 'HTTP ' + r.status);
    check(Array.isArray(j.versions), '详情含 versions 数组（版本链）');
    if (j.adjust) {
      check(typeof j.adjust === 'object' && j.adjust.params && typeof j.adjust.params === 'object',
        '已调色图带 photo.adjust.params 结构（契约 §3.5）');
      check(Array.isArray(j.adjust.versions), 'photo.adjust 含 versions 版本链');
    } else {
      skipped('photo.adjust 结构', '当前第一张图未被调色（路由已落盘但 3001 未重启时属正常）');
    }
  } catch (e) {
    skipped('GET /api/photos/:id 详情契约', (e && e.message) || String(e));
  }
}

liveProbe().then(() => {
  console.log('\n================================================================');
  if (skip) console.log(`跳过: ${skip} 项（跳过 ≠ 通过；原因见上面「跳过」行）`);
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('验收脚本自身异常:', e);
  process.exit(1);
});
