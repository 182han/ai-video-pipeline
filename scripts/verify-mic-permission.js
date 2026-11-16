#!/usr/bin/env node
// ============================================================
// 麦克风权限验收（2026-11-16）
// ------------------------------------------------------------
// 用户反馈：按住说话 →「拿不到麦克风权限：Permission denied；请改用打字。」
// 旧实现只回一句死胡同，用户不知道是 Chrome 站点权限、Windows 隐私开关，还是设备占用。
//
// 本脚本只做**静态 + 运行中 3001 只读**检查，保证：
//   1) 请求前先查 Permissions API（不会把「已被阻止」当成还能弹授权框）；
//   2) 拒绝时给 Chrome 地址栏 / Windows 隐私两处可照做的步骤；
//   3) 授权晚到（用户已松手）不偷偷录音；
//   4) NotFound / NotReadable / 非安全来源分别给原因；
//   5) 遮罩必须 portal 到 body（按钮所在的 .xz-inputbar 有 backdrop-filter，会成为 fixed 包含块）。
//
// 真实浏览器（Chrome 9222 CDP）的拒绝卡/请求卡/授权晚到三态证据见
// `.scratch/mic-diag/` 截图与 `docs/spec/changelog.md` 的记录；本脚本不依赖 9222。
//
// 用法：node scripts/verify-mic-permission.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const WEB = path.join(APP, 'web');
const BASE = process.env.MIC_BASE || 'http://127.0.0.1:3001';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name + (detail ? '  —  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  —  ' + detail : '')); }
}
function read(p) { return fs.readFileSync(p, 'utf8'); }
async function httpGet(url) {
  const r = await fetch(url);
  return { status: r.status, headers: r.headers, body: await r.text() };
}

(async () => {
  console.log('================================================================');
  console.log('麦克风权限验收（静态 + 3001 只读）  BASE=' + BASE);
  console.log('================================================================');

  const plan = read(path.join(WEB, 'src', 'components', 'xiaozhiPlan.js'));
  const css = read(path.join(WEB, 'styles', 'assistant-home.css'));
  const assistant = read(path.join(WEB, 'src', 'components', 'assistant.js'));
  const serverCode = read(path.join(APP, 'server.js'));

  console.log('\n[1] 请求前先查权限状态，不再盲调 getUserMedia');
  check('Permissions API 查询 microphone',
    /navigator\.permissions[\s\S]{0,80}query\(\{ name: 'microphone' \}\)/.test(plan));
  check('有 queryMicPermission() 封装', /queryMicPermission\(\)/.test(plan));
  check('p === denied 直接走指引卡，不再尝试弹授权框',
    /if \(p === 'denied'\)[\s\S]{0,180}fail\(/.test(plan));
  check('prompt/unknown 时先显示「正在请求麦克风」说明卡',
    /if \(p !== 'granted'\)[\s\S]{0,120}phase: 'requesting'/.test(plan));
  check('仍以 audio:true 请求麦克风',
    /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/.test(plan));

  console.log('\n[2] 拒绝时给 Chrome / Windows 可照做的步骤');
  check('给出 chrome://settings/content/microphone', /chrome:\/\/settings\/content\/microphone/.test(plan));
  check('Chrome 地址栏 → 网站设置 → 麦克风 → 允许',
    /网站设置[\s\S]{0,80}麦克风[\s\S]{0,40}允许/.test(plan));
  check('Windows 隐私和安全性 → 麦克风两处开关',
    /允许应用访问麦克风/.test(plan) && /允许桌面应用访问麦克风/.test(plan));
  check('「重新请求麦克风」与「复制排查步骤」按钮',
    /重新请求麦克风/.test(plan) && /复制排查步骤/.test(plan));
  check('权限卡带 data 标记（可自动化验收）',
    /data-mic-modal="1"/.test(plan) && /data-mic-phase=/.test(plan));
  check('保留「先打字」出口，不阻塞输入框', /先打字/.test(plan));

  console.log('\n[3] 授权晚到不偷偷录音（按住说话的老坑）');
  check('pointerup/leave 会清 pressedRef，授权返回时检查',
    /pressedRef\.current = false/.test(plan) && /!pressedRef\.current/.test(plan));
  check('授权晚到 → 停流 + 提示「请再按住」而不是开始录音',
    /!pressedRef\.current[\s\S]{0,300}getTracks\(\)/.test(plan)
    && /!pressedRef\.current[\s\S]{0,600}showModal\('granted'/.test(plan));
  check('授权晚到文案明确要求再按一次', /再按住麦克风说一次/.test(plan));

  console.log('\n[4] 错误分类：权限 / 无设备 / 被占用 / 非安全来源');
  check('NotFoundError → 没有检测到麦克风', /NotFoundError[\s\S]{0,120}没有检测到麦克风/.test(plan));
  check('NotReadableError → 被其他程序占用', /NotReadableError[\s\S]{0,120}被其他程序占用/.test(plan));
  check('非 secure context → 明确提示 localhost/https', /INSECURE_CONTEXT[\s\S]{0,120}不是安全来源/.test(plan));
  check('缺 getUserMedia → 浏览器不支持', /NO_GETUSERMEDIA[\s\S]{0,120}不支持录音/.test(plan));
  check('站点已允许但仍 NotAllowed → 提示检查 Permissions-Policy',
    /Permissions-Policy/.test(plan) && /microphone=\(self\)/.test(plan));

  console.log('\n[5] 遮罩挂 body + 样式');
  check('createPortal 到 document.body（否则 fixed 会被输入条的 backdrop-filter 限制）',
    /window\.ReactDOM[\s\S]{0,80}createPortal\(overlay, document\.body\)/.test(plan));
  check('CSS：遮罩 fixed', /\.xz-mic-overlay[\s\S]{0,120}position: fixed/.test(css));
  check('CSS：z-index 140（高于悬浮面板 61）', /\.xz-mic-overlay[\s\S]{0,160}z-index: 140/.test(css));
  check('CSS：卡片可滚动（小屏不截断步骤）', /\.xz-mic-card[\s\S]{0,800}overflow: auto/.test(css));
  check('CSS：步骤用十进制序号（全局 ol 被 reset）', /\.xz-mic-steps[\s\S]{0,80}list-style: decimal/.test(css));

  console.log('\n[6] 原有语音/ASR 链路未被改坏');
  check('仍 POST /api/assistant/asr', /\/api\/assistant\/asr/.test(plan));
  check('ASR 失败仍有「改用打字」兜底', /改用打字/.test(plan));
  check('MediaRecorder → base64 上传逻辑保留',
    /chunksRef\.current/.test(plan) && /audioBase64: btoa\(binary\)/.test(plan));
  check('整页与悬浮面板两处都复用 VoiceButton',
    (assistant.match(/<\$\{VoiceButton\}/g) || []).length === 2,
    String((assistant.match(/<\$\{VoiceButton\}/g) || []).length) + ' 处');

  console.log('\n[7] 服务端 Permissions-Policy 必须放行 microphone(self)');
  check('server.js 含 microphone=(self)', /microphone=\(self\)/.test(serverCode));
  check('server.js 不再有 microphone 空允许列表', !/microphone=\(\)/.test(serverCode));
  try {
    const appPage = await httpGet(BASE + '/app');
    const pp = appPage.headers.get('permissions-policy') || '';
    check('GET /app Permissions-Policy 放行 microphone(self)', /microphone=\(self\)/i.test(pp), pp);
    const rootPage = await httpGet(BASE + '/');
    const pp2 = rootPage.headers.get('permissions-policy') || '';
    check('GET / Permissions-Policy 放行 microphone(self)', /microphone=\(self\)/i.test(pp2), pp2);
  } catch (e) {
    check('Permissions-Policy 响应头检查异常: ' + (e && e.message ? e.message : e), false);
  }

  console.log('\n[8] 运行中 3001 只读（web/ 刷新即生效，未重启服务）');
  try {
    const js = await httpGet(BASE + '/app/src/components/xiaozhiPlan.js');
    check('GET xiaozhiPlan.js 200', js.status === 200, 'HTTP ' + js.status);
    check('线上已含 MicPermissionModal / queryMicPermission',
      /MicPermissionModal/.test(js.body) && /queryMicPermission/.test(js.body));
    check('线上已含 Windows 两处开关文案', /允许桌面应用访问麦克风/.test(js.body));
    const c = await httpGet(BASE + '/app/styles/assistant-home.css');
    check('GET assistant-home.css 200', c.status === 200, 'HTTP ' + c.status);
    check('线上 CSS 已含 .xz-mic-overlay', /\.xz-mic-overlay/.test(c.body));
  } catch (e) {
    check('3001 只读检查异常: ' + (e && e.message ? e.message : e), false);
  }

  console.log('\n================================================================');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('================================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('VERIFY ERROR:', e && e.stack || e); process.exit(2); });
