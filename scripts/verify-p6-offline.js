// ============================================================
// P6 验收：下线历史 / 产出入口 + 收尾文档（2026-11-16）
// ------------------------------------------------------------
// 依据（产品口径 §7）：「历史记录 / 产出入口最终下线；失败任务靠『库里失败可见 +
//   成片未完成卡片』，不再靠历史页。」
// P2 只做了「导航隐藏、路由保留」；P6 完成剩余部分。
//
// 本脚本**只读**，三段：
//   1) 前端静态：壳层不再 import/渲染 HistoryView / OutputScreen；/history、/output
//      深链落「库 · 成片」；生成页不再给历史入口；库页成片 tab 有未完成卡片、
//      片段 tab 显示「生成失败」；两个保留的旧页面已标注「已下线、删除需用户同意」。
//   2) 交接文档：00-总计划与进度 / 2026-11-15-handoff 已记录 P6（状态、验收、限制）。
//   3) 运行中 3001（若在跑）：只读 GET 静态文件，确认线上拷贝已是新版。
//      前端是 express.static，**刷新即生效、不需要重启**；3001 未运行时如实记
//      「未验证」（不计通过、也不计失败）。
//   不建任务、不改数据、不起第二个实例、不触发任何付费调用。
//
// 用法：node scripts/verify-p6-offline.js
// 退出码：0 = 无失败（未验证项单独计数）；1 = 有失败。
// ============================================================
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DOCS = path.join(ROOT, 'docs', '交接');
const BASE = 'http://127.0.0.1:3001';

let pass = 0;
let fail = 0;
let skip = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  —  ' + extra : ''}`); }
}
function unverified(label, why) {
  skip++;
  console.log(`  SKIP  ${label}  —  ${why}（未验证，不计通过）`);
}
const read = (p) => fs.readFileSync(p, 'utf8');
const readIf = (p) => { try { return read(p); } catch (e) { return ''; } };

function httpGet(url, ms = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

(async () => {
  console.log('================================================================');
  console.log('P6 验收：下线历史 / 产出入口 + 收尾文档');
  console.log('================================================================');

  const shell = read(path.join(WEB, 'src', 'screens', 'shell.js'));
  const gen = read(path.join(WEB, 'src', 'screens', 'gen.js'));
  const inv = read(path.join(WEB, 'src', 'screens', 'inventory.js'));
  const hist = read(path.join(WEB, 'src', 'screens', 'history.js'));
  const out = read(path.join(WEB, 'src', 'screens', 'output.js'));
  const assistant = read(path.join(WEB, 'src', 'components', 'assistant.js'));

  // ---------- 1) 前端静态 ----------
  console.log('\n[1] 壳层：历史 / 产出入口与路由已下线');
  check(!/from '\.\/history\.js'/.test(shell), 'shell.js 不再 import HistoryView');
  check(!/from '\.\/output\.js'/.test(shell), 'shell.js 不再 import OutputScreen');
  check(!/<\$\{HistoryView\}/.test(shell), 'shell.js 不再渲染 HistoryView');
  check(!/<\$\{OutputScreen\}/.test(shell), 'shell.js 不再渲染 OutputScreen');
  check(/startsWith\('\/history'\)\) return 'library'/.test(shell), '/history 旧深链落「库」');
  check(/startsWith\('\/output'\)\) return 'library'/.test(shell), '/output 旧深链落「库」');
  check(!/history: '\/history'/.test(shell) && !/output: '\/output'/.test(shell),
    'routeOf 不再登记 history / output');
  const navKeys = (shell.match(/\{ key: '/g) || []).length;
  check(navKeys === 3, '导航仍为 3 项（创作 / 剪辑 / 库；设置固定底部）', String(navKeys));
  check(!/label: '历史/.test(shell) && !/label: '产出/.test(shell) && !/label: '配乐/.test(shell),
    '导航文案无历史 / 产出 / 配乐');
  check(/\$\{LibraryView\}[\s\S]{0,160}tasks=\$\{tasks\}/.test(shell),
    'shell.js 把 /api/tasks 轮询结果传给 LibraryView（未完成卡片数据源）');

  console.log('\n[2] 生成页 / 小智：不再把用户指向历史页');
  check(!/navigate\('\/history'\)/.test(gen), 'gen.js 不再跳 /history');
  check(/navigate\('\/library'\)/.test(gen), 'gen.js 改跳 /library');
  check(/去库看成片/.test(gen), '按钮文案「去库看成片」');
  check(!/历史\/任务列表/.test(assistant) && !/历史记录/.test(assistant),
    'assistant.js 提交成功文案不再提历史');

  console.log('\n[3] 库页：失败可见 + 成片未完成卡片（失败任务不再依赖历史页）');
  check(/import \{ TaskDrawer \} from '\.\.\/components\/taskDrawer\.js'/.test(inv),
    'inventory.js 复用 TaskDrawer（重试 / 补跑）');
  check(/function UnfinishedPanel/.test(inv), '新增 UnfinishedPanel');
  check(/t\.status === 'failed' \|\| t\.status === 'partial'/.test(inv),
    '未完成卡片只收 failed / partial');
  check(/t\.model !== 'mock'/.test(inv), '排除 mock（合成任务不入正式库口径）');
  check(/!t\.fragmentOnly/.test(inv), '排除 clips_only（本来就不产成片）');
  check(/finalTaskIds/.test(inv), '已产出成片的任务不重复计入未完成');
  check(/未完成 \$\{rows\.length\} 条/.test(inv), '卡片显示「未完成 N 条」');
  check(/详情 \/ 补跑/.test(inv), '卡片有「详情 / 补跑」入口');
  check(/it\.status === 'failed'[\s\S]{0,80}生成失败/.test(inv), '片段卡显示「生成失败」徽章');
  check(/export function LibraryView\(\{ initialTab = 'finals', tasks = \[\] \}\)/.test(inv),
    'LibraryView 接收 tasks（默认空数组，单独渲染不崩）');
  check(/\$\{FinalsPanel\} items=\$\{finals\} tasks=\$\{tasks\}/.test(inv),
    'FinalsPanel 收到 tasks');

  console.log('\n[4] 旧页面文件保留但已标注下线（删除需用户同意）');
  check(/P6 已下线/.test(hist) && /入口与路由已移除/.test(hist), 'history.js 头部标注已下线');
  check(/AGENTS\.md §6/.test(hist) && /删除死代码需用户同意/.test(hist),
    'history.js 写明保留原因（删除需用户同意）');
  check(/P6 已下线/.test(out) && /入口与路由已移除/.test(out), 'output.js 头部标注已下线');
  check(/AGENTS\.md §6/.test(out) && /删除死代码需用户同意/.test(out),
    'output.js 写明保留原因（删除需用户同意）');

  // ---------- 2) 交接文档 ----------
  console.log('\n[5] 交接文档（P6 收尾）');
  const doc00 = readIf(path.join(DOCS, '00-总计划与进度.md'));
  const handoff = readIf(path.join(DOCS, '2026-11-15-handoff.md'));
  check(/\| P6 \|[\s\S]{0,200}\*\*完成\*\*/.test(doc00), '00 文档 P6 状态 = 完成');
  check(/### P6 完成记录（2026-11-16/.test(doc00), '00 文档含 P6 完成记录');
  check(/verify-p6-offline/.test(doc00), '00 文档登记 P6 验收命令');
  check(/P6 完成/.test(doc00), '00 文档交接记录含 P6');
  check(/### P6 完成/.test(handoff) || /## 15\. P6/.test(handoff),
    'handoff 含 P6 完成记录');
  check(/verify-p6-offline/.test(handoff), 'handoff 登记 P6 验收命令');

  // ---------- 3) 运行中 3001（只读）----------
  console.log('\n[6] 运行中 3001：只读确认线上静态文件已是新版');
  const st = await httpGet(BASE + '/api/status');
  if (!st.status) {
    unverified('3001 未运行', '无法只读确认线上前端拷贝（跳过，不代表通过）');
  } else {
    check(st.status === 200, '/api/status 200（服务在跑，未新建实例）', 'HTTP ' + st.status);
    const liveShell = await httpGet(BASE + '/app/src/screens/shell.js');
    check(liveShell.status === 200 && liveShell.body.length > 2000,
      '线上 shell.js 可取（express.static）', 'HTTP ' + liveShell.status + ' / ' + liveShell.body.length + ' bytes');
    check(liveShell.status === 200 && !/HistoryView/.test(liveShell.body) && !/OutputScreen/.test(liveShell.body),
      '线上 shell.js 已无 HistoryView / OutputScreen（刷新即生效）');
    check(/startsWith\('\/history'\)\) return 'library'/.test(liveShell.body),
      '线上 shell.js 的 /history 深链已落库');
    const liveInv = await httpGet(BASE + '/app/src/screens/inventory.js');
    check(liveInv.status === 200 && /UnfinishedPanel/.test(liveInv.body),
      '线上 inventory.js 已含未完成卡片');
    const liveGen = await httpGet(BASE + '/app/src/screens/gen.js');
    check(liveGen.status === 200 && !/navigate\('\/history'\)/.test(liveGen.body) && /去库看成片/.test(liveGen.body),
      '线上 gen.js 已改为「去库看成片」');
  }

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 未验证` : ''}`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
