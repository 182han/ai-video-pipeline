#!/usr/bin/env node
// ============================================================
// 小智首页验收（2026-11-16，用户草图）
// ------------------------------------------------------------
// 静态 24 项 + 运行中 3001 只读 6 项；**不建任务、不改数据、不起第二实例**。
// 浏览器交互与截图见 .scratch/auto_chain/capture_xiaozhi_home.js（CDP 9222，人工验收用），
// 本脚本只保证「代码接线没被改坏」。
//
// 用法：node scripts/verify-xiaozhi-home.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const WEB = path.join(APP, 'web');
const BASE = process.env.XZ_BASE || 'http://127.0.0.1:3001';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name + (detail ? '  —  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  —  ' + detail : '')); }
}
function read(p) { return fs.readFileSync(p, 'utf8'); }
async function httpGet(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.text() };
}

(async () => {
  console.log('================================================================');
  console.log('小智首页验收（静态 + 3001 只读）  BASE=' + BASE);
  console.log('================================================================');

  const shell = read(path.join(WEB, 'src', 'screens', 'shell.js'));
  const page = read(path.join(WEB, 'src', 'screens', 'assistantPage.js'));
  const assistant = read(path.join(WEB, 'src', 'components', 'assistant.js'));
  const css = read(path.join(WEB, 'styles', 'assistant-home.css'));
  const indexHtml = read(path.join(WEB, 'index.html'));

  console.log('\n[1] 路由：/ = 小智，/create = 六步向导');
  check(/if \(route === '\/' \|\| route === ''\) return 'home'/.test(shell), 'shell.js：/ 映射 home');
  check(/if \(route\.startsWith\('\/create'\)\) return 'create'/.test(shell), 'shell.js：/create 映射 create');
  check(/if \(view === 'home'\)[\s\S]{0,160}AssistantPage/.test(shell), 'shell.js：home 渲染 AssistantPage（不套全局左栏）');
  check(/key: 'create', route: '\/create'/.test(shell), '导航「创作」指向 /create');
  check(/create: '\/create'/.test(shell), 'Rail 高亮映射 create → /create');
  const navKeys = (shell.match(/\{ key: '/g) || []).length;
  check(navKeys === 3, '导航仍为 3 项（创作 / 剪辑 / 库；设置固定底部）', String(navKeys));

  console.log('\n[2] 可收起气泡导航（三个点 = 收起/展开，不是退出）');
  check(/RAIL_KEY = 'vs_rail_collapsed'/.test(page), 'localStorage 键 vs_rail_collapsed');
  check(/getItem\(RAIL_KEY\) !== '0'/.test(page), '默认收起（用户指定的第三张截图形态）');
  check(/setCollapsed/.test(page) && /localStorage\.setItem\(RAIL_KEY/.test(page), '收起状态持久化');
  check(/aria-label=\$\{collapsed \? '展开导航' : '收起导航'\}/.test(page), '三个点按钮 aria-label 为展开/收起');
  check(/•••/.test(page), '按钮文案为三个点');
  check(/data-route=\$\{item\.route\}/.test(page), '导航项带 data-route（可点进对应界面）');
  check(!/label: '退出'/.test(page), '导航不含「退出」项（三个点不是退出）');
  check(/route: '\/create'/.test(page) && /route: '\/edit'/.test(page)
    && /route: '\/library'/.test(page) && /route: '\/settings'/.test(page), '4 个导航目标：创作/剪辑/库/设置');

  console.log('\n[2.1] 板块页「回小智」退出入口');
  check(/className="rail-home"/.test(shell), '左栏顶部固定「小智 · 对话首页」入口');
  check(/aria-label="回到小智首页"/.test(shell) && /onClick=\$\{\(\) => navigate\('\/'\)\}/.test(shell), '点击回 /（小智首页）');
  check(/rail-home-sub[\s\S]{0,80}点这里回来/.test(shell), '入口有「点这里回来」说明');
  check(/title="返回小智"\s+onClick=\$\{\(\) => navigate\('\/'\)\}/.test(read(path.join(WEB, 'src', 'screens', 'editor.js')))
    || /onClick=\$\{\(\) => navigate\('\/'\)\}\s+title="返回小智"/.test(read(path.join(WEB, 'src', 'screens', 'editor.js'))),
    '剪辑台左上角 ← 返回小智');
  check(/onClick=\$\{\(\) => navigate\('\/'\)\}[\s\S]{0,120}退出观看/.test(read(path.join(WEB, 'src', 'screens', 'gen.js'))),
    '生成页「退出观看」回小智首页');

  console.log('\n[3] 整页对话：大球 + 介绍卡 + 底部输入框');
  check(/export function Assistant\(\{ page = false \}/.test(assistant), 'Assistant 支持 page 模式');
  check(/data-page="xiaozhi"/.test(assistant), '整页容器 data-page=xiaozhi');
  check(/PAGE_CHIPS = \['10 分钟的长视频', '上一次的视频', '现在进度怎样'\]/.test(assistant), '介绍卡 3 个建议 chips（时长优先，不是主题示例）');
  check(!/30 分钟的雪山|10 分钟的极光/.test(assistant), '不再用主题式长片示例');
  check(/xz-intro-title[\s\S]{0,160}我是小智，告诉我视频多长/.test(assistant), '介绍卡开场白：说时长 → 自动抽场景');
  check(/场景卡库/.test(assistant) && /60 个不同场景/.test(assistant), '介绍卡说明「场景卡库自动抽取 60 个不同场景」');
  check(/xz-composer-wrap/.test(assistant) && /xz-inputbar/.test(assistant), '底部微信式输入框');
  check(/VoiceButton/.test(assistant), '语音按钮复用（ASR → 失败回退打字）');
  check(/is-compact/.test(assistant), '有消息后大球缩小（is-compact）');
  check(/navigate\('\/create'\)/.test(assistant), '填入提示词后回 /create（不再回 /）');

  console.log('\n[4] 样式与入口');
  check(/navigate\('\/'\)/.test(shell) && /rail-home/.test(shell), 'shell.js 只有「回小智」用 navigate(/)');
  for (const f of ['inventory.js', 'templates.js']) {
    check(!/navigate\('\/'\)/.test(read(path.join(WEB, 'src', 'screens', f))), `${f} 仍回 /create（不回 /）`);
  }
  check(/navigate\('\/create'\)/.test(read(path.join(WEB, 'src', 'screens', 'gen.js'))), 'gen.js「去创作」仍回 /create');
  check(/assistant-home\.css/.test(indexHtml), 'index.html 引入 assistant-home.css');
  check(/\.xz-root[\s\S]{0,400}radial-gradient/.test(css), '整页绿色渐变/光晕样式');
  check(/\.xz-rail\.is-collapsed/.test(css) && /flex-basis: 64px/.test(css), '导航收起 64px 样式');
  check(/\.xz-stage\.is-empty/.test(css), '空态垂直居中样式');
  check(/\.xz-composer-wrap/.test(css), '底部输入框固定样式');

  console.log('\n[5] 运行中 3001 只读（web/ 刷新即生效）');
  try {
    const s = await httpGet(BASE + '/api/status');
    check('GET /api/status 200', s.status === 200, 'HTTP ' + s.status);

    const ap = await httpGet(BASE + '/app/src/screens/assistantPage.js');
    check('assistantPage.js 已下发', ap.status === 200 && /AssistantPage/.test(ap.body), 'HTTP ' + ap.status + ' / ' + ap.body.length + ' bytes');

    const cs = await httpGet(BASE + '/app/styles/assistant-home.css');
    check('assistant-home.css 已下发', cs.status === 200 && /\.xz-root/.test(cs.body), 'HTTP ' + cs.status + ' / ' + cs.body.length + ' bytes');

    const sh = await httpGet(BASE + '/app/src/screens/shell.js');
    check('线上 shell.js 已含 AssistantPage', sh.status === 200 && /AssistantPage/.test(sh.body), 'HTTP ' + sh.status + ' / ' + sh.body.length + ' bytes');
    check('线上 shell.js 的 / 已映射 home', /return 'home'/.test(sh.body));

    const idx = await httpGet(BASE + '/app');
    check('GET /app 可访问（未登录会落登录页）', idx.status === 200 && (/assistant-home\.css/.test(idx.body) || /login/.test(idx.body)), 'HTTP ' + idx.status);
  } catch (e) {
    check('3001 只读检查异常: ' + (e && e.message ? e.message : e), false);
  }

  console.log('\n================================================================');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('================================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('VERIFY ERROR:', e && e.stack || e); process.exit(2); });
