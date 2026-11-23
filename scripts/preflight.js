#!/usr/bin/env node
// ============================================================
// 交付前自检（preflight）— 2026-11-23 新增
// ------------------------------------------------------------
// 为什么需要它：
//   11-16 ~ 11-23 这一周至少 8 次「代码改了、运行中的 3001 还是旧进程」，
//   于是复验失败被当成新 bug 再查一轮（E13 的 ?seed=、E14/E15 的「未重启」、
//   11-23 主题仍显示单主题）。check-server-version.js 早就存在，但没人记得跑。
//   把「版本、门禁注册表、英文零中文」三个现成检查串成一条命令，它才可能被执行。
//
// 为什么是 Node 而不是 .ps1：
//   本机执行策略禁止运行未签名 .ps1（实测 UnauthorizedAccess），.ps1 根本跑不起来。
//
// 用法（在 app/ 下）：
//   node scripts/preflight.js
//   node scripts/preflight.js --skip-git
//
// 判定：
//   FAIL → 退出码 1，不要声称「已验证」
//   WARN → 不阻塞，但必须写进交付说明
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_GIT = process.argv.includes('--skip-git');

let pass = 0;
let warn = 0;
let fail = 0;
const notes = [];

const P = (s) => console.log(s);
const ok = (name, detail) => { pass += 1; P(`✅ ${name}${detail ? ' — ' + detail : ''}`); };
const wn = (name, detail) => { warn += 1; P(`⚠️  ${name}${detail ? ' — ' + detail : ''}`); };
const no = (name, detail) => { fail += 1; P(`❌ ${name}${detail ? ' — ' + detail : ''}`); };

P('='.repeat(64));
P('交付前自检（preflight）');
P('='.repeat(64));

// 1) 工作区：脏不是错误，但必须知道在交付哪个版本
if (!SKIP_GIT) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length === 0) ok('工作区干净', 'git status --porcelain 为空');
    else {
      wn('工作区有未提交改动', `${lines.length} 项——交付说明里必须写明以哪个提交为准`);
      lines.slice(0, 8).forEach((l) => P('    ' + l));
    }
  } catch (e) {
    // 本沙箱禁止 node 拉子进程（EPERM），不是 git 坏了
    wn('无法自动检查 git 状态', `${e.code || e.message}——请手动跑 git -C app status --porcelain`);
  }
}

// 2) 运行中的服务是不是磁盘上的代码
(async () => {
  const localMtime = (() => {
    try { return fs.statSync(path.join(ROOT, 'server.js')).mtimeMs; } catch (e) { return null; }
  })();
  let status = null;
  try {
    const res = await fetch('http://127.0.0.1:3001/api/status', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    status = await res.json();
  } catch (e) {
    wn('服务未运行或不可达', `3001: ${e.message}——若本次只改前端可忽略；改了 src/ 或 server.js 必须启动后复验`);
  }

  if (status) {
    const info = status.serverInfo;
    if (!info) {
      no('缺少 serverInfo 探针', '运行的是旧代码（旧 server.js 没有版本探针）');
    } else if (info.serverMtime && localMtime && localMtime - info.serverMtime > 1000) {
      no('运行中的服务是旧代码', `running=${new Date(info.serverMtime).toISOString()} / disk=${new Date(localMtime).toISOString()}——先停旧进程再启新进程`);
    } else {
      ok('运行中的服务=磁盘代码', `PID ${info.pid}，启动于 ${info.startedAt}`);
    }
    if (!status.imageGen) no('缺少 imageGen 探针', '运行的是旧代码（没有图片生成接口）');
  }

  // 3) 门禁注册表
  try {
    const reg = require('./verify-gate-registry.js');
    const suites = reg.parseSuites();
    const scripts = reg.listVerifyScripts();
    const registered = new Set(suites.map((s) => s.script));
    const manual = new Set(Object.keys(reg.MANUAL));
    const homeless = scripts.filter((f) => !registered.has(f) && !manual.has(f) && f !== 'verify-all.js');
    if (homeless.length === 0) ok('门禁注册表无洞', `${scripts.length} 个套件全部有归属`);
    else no('门禁注册表有洞', `未归属：${homeless.join(', ')}——注册进 verify-all 或在 MANUAL 写明理由`);
  } catch (e) {
    no('门禁注册表检查失败', e.message);
  }

  // 4) 英文界面零硬编码中文（与门禁同一份实现）
  try {
    const scan = require('./lib-cjk-scan.js');
    const r = scan.scanHardcodedCjk(ROOT);
    if (r.total === 0) ok('英文界面无硬编码中文', `${r.allowed} 处已逐行标注 i18n-allow`);
    else {
      no('英文界面存在硬编码中文', `${r.total} 处，涉及 ${r.byFile.length} 个文件`);
      for (const f of r.byFile.slice(0, 5)) {
        P(`    ${f.file}  ${f.count} 处  e.g. L${f.samples[0] ? f.samples[0].line : '?'}: ${f.samples[0] ? f.samples[0].text : ''}`);
      }
    }
  } catch (e) {
    no('硬编码中文检查失败', e.message);
  }

  // 5) 收尾提醒：脚本证明不了的部分必须人工标注
  P('');
  P('仍需人工确认（脚本证明不了）：');
  P('  - 视觉/交互/听感：无浏览器实测时，交付必须标「未验证」，不得写「通过」。');
  P('  - 真实计费链路：未取得用户同意不得发起（AGENTS §4.9）。');
  P('  - 视频产物：必须给 ffprobe/volumedetect 实测值（AGENTS §5.1）。');
  P('  - 是否需要重启：src/** 与 server.js 需要；web/** 刷新即生效。');

  P('');
  P('-'.repeat(64));
  P(`preflight: ${pass} 通过 / ${warn} 提醒 / ${fail} 失败`);
  P('-'.repeat(64));
  if (fail > 0) {
    P('结论：不通过 —— 不要声称「已验证」。');
    process.exit(1);
  }
  if (warn > 0) {
    P('结论：可以交付，但上面每条提醒都必须写进交付说明。');
    process.exit(0);
  }
  P('结论：通过（仅覆盖上面这些项，不覆盖视觉/计费/视频产物）。');
  process.exit(0);
})();
