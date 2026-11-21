// ==========================================
// 部署自检 doctor（2026-11-12，交付用）
// ==========================================
//
// 目的：换一台机器 / 交付给接收方时，一条命令就能知道"还差什么"，
// 而不是启动后对着白屏猜。
//
// 用法：
//   node scripts/doctor.js
//   node scripts/doctor.js --json     # 机器可读
//
// 判定：ERROR = 起不来 / 必错；WARN = 能起但有坑；OK = 正常。
// 退出码：有 ERROR → 1；只有 WARN → 0。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
function rec(level, name, detail, hint) {
  results.push({ level, name, detail: detail || '', hint: hint || '' });
}

// ---------- 1. Node 版本 ----------
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) rec('OK', 'Node 版本', `v${process.versions.node}`);
else rec('ERROR', 'Node 版本', `v${process.versions.node} 太低`, '需要 Node 20 或以上（Dockerfile 用的 node:20-slim）');

// ---------- 2. 依赖是否装了 ----------
let pkg = {};
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) {
  rec('ERROR', 'package.json', '读不出来: ' + e.message);
}
const deps = Object.keys(pkg.dependencies || {});
if (!deps.length) rec('WARN', '依赖声明', 'package.json 没有 dependencies');
for (const d of deps) {
  if (fs.existsSync(path.join(ROOT, 'node_modules', d))) rec('OK', `依赖 ${d}`, '已安装');
  else rec('ERROR', `依赖 ${d}`, '未安装', '执行 npm install（或按《安装手册》恢复 node_modules 备份）');
}

// ---------- 3. lockfile 状态 ----------
// 事实（2026-11-12 实测）：package-lock.json 只覆盖 express/ws，缺 @aws-sdk/client-s3 与 pg；
// pnpm-lock.yaml 是完整的（含 aws-sdk 3.1152.0 / pg 8.23.1）。
// 所以「哪个 lockfile 是权威」不能靠猜，这里两个都检查。
const lockPath = path.join(ROOT, 'package-lock.json');
const pnpmLockPath = path.join(ROOT, 'pnpm-lock.yaml');

function npmLockCoverage() {
  if (!fs.existsSync(lockPath)) return { exists: false, missing: deps.slice() };
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const pkgs = lock.packages || {};
    const missing = deps.filter(d => {
      const e = pkgs['node_modules/' + d];
      return !e || !e.version;
    });
    return { exists: true, missing };
  } catch (e) {
    return { exists: true, missing: deps.slice(), error: e.message };
  }
}

function pnpmLockCoverage() {
  if (!fs.existsSync(pnpmLockPath)) return { exists: false, missing: deps.slice() };
  const text = fs.readFileSync(pnpmLockPath, 'utf8');
  const missing = deps.filter(d => {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`['"]?${esc}@\\d`).test(text);
  });
  return { exists: true, missing };
}

const npmCov = npmLockCoverage();
const pnpmCov = pnpmLockCoverage();

if (!npmCov.exists && !pnpmCov.exists) {
  rec('ERROR', 'lockfile', '两个 lockfile 都不存在', '没有它就无法复现依赖版本');
} else if (npmCov.exists && npmCov.missing.length === 0) {
  rec('OK', 'package-lock.json', `覆盖全部 ${deps.length} 个直接依赖`);
} else if (pnpmCov.exists && pnpmCov.missing.length === 0) {
  rec('WARN', 'package-lock.json 过期',
    `缺版本记录: ${npmCov.missing.join(', ')} —— \`npm ci\` 会直接失败`,
    '权威 lockfile 是 pnpm-lock.yaml（完整）。部署推荐 `pnpm install --frozen-lockfile`；'
    + '若必须用 npm，只能 `npm install`（能装，但版本会重新解析，不是完全可复现）。'
    + '彻底修法：在有 npm 的机器上跑一次 `npm install` 生成新 lock 并提交');
} else {
  rec('ERROR', '两个 lockfile 都不完整',
    `npm 缺 [${npmCov.missing.join(', ')}]；pnpm 缺 [${pnpmCov.missing.join(', ')}]`,
    '重新生成 lockfile 后再交付');
}
if (npmCov.exists && pnpmCov.exists) {
  rec('WARN', '两套包管理器并存', 'package-lock.json + pnpm-lock.yaml',
    '交付方请只认一个：当前以 pnpm-lock.yaml 为准；package-lock.json 建议删除或标注 legacy');
}

// ---------- 4. package.json 里引用的脚本是否都存在 ----------
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  const refs = String(cmd).match(/scripts\/[\w.-]+\.js/g) || [];
  const missing = refs.map(r => r.replace('scripts/', '')).filter(f => !fs.existsSync(path.join(ROOT, 'scripts', f)));
  if (missing.length) rec('ERROR', `npm run ${name} 会失败`, `引用了不存在的脚本: ${missing.join(', ')}`);
}

// ---------- 5. ffmpeg / ffprobe ----------
let cfg = {};
try { cfg = require(path.join(ROOT, 'config.js')); } catch (e) { rec('ERROR', 'config.js', '加载失败: ' + e.message); }
// 读子进程 stdout 的通用封装。
//
// 为什么需要降级：本沙箱里「捕获 stdout」的调用（`execFileSync(..., {encoding:'utf8'})`）
// 会直接 EPERM，而二进制本身是好的——实测同一份 ffmpeg：
//   · encoding:'utf8'  → EPERM: spawnSync …ffmpeg.exe EPERM
//   · stdio:'ignore'   → 正常
//   · stdout 重定向到文件 → 正常读到 `ffmpeg version 8.1-full_build`
// 旧版 doctor 把这种环境限制误报成「ffmpeg 无法执行 → 必须修复」（2026-11-21 修）。
// 降级方案：把 stdout 落临时文件再读，语义与捕获 stdout 一致。
function runCapture(bin, args, timeout = 10000) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout });
  } catch (e) {
    if (!e || e.code !== 'EPERM') throw e;
    const osMod = require('os');
    const tmpDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'doctor-cap-'));
    const outFile = path.join(tmpDir, 'stdout.txt');
    const fd = fs.openSync(outFile, 'w');
    try {
      execFileSync(bin, args, { stdio: ['ignore', fd, 'ignore'], timeout });
    } finally {
      fs.closeSync(fd);
    }
    const text = fs.readFileSync(outFile, 'utf8');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) {}
    return text;
  }
}
function probeBin(bin, label) {
  if (!bin) return rec('ERROR', label, '未解析到路径', '在 .env 写 FFMPEG_PATH，或把 ffmpeg 放进 tools/ffmpeg/bin，或装到 PATH');
  try {
    const out = runCapture(bin, ['-version']);
    const ver = (out.split('\n')[0] || '').trim();
    if (!ver) {
      return rec('WARN', label, `可执行但没读到版本号: ${bin}`,
        '多半是输出被截断/权限问题：手动跑一次 `ffmpeg -version` 看有没有输出');
    }
    rec('OK', label, `${bin}\n      ${ver}`);
  } catch (e) {
    rec('ERROR', label, `无法执行: ${bin}（${(e && (e.code || e.message)) || '未知错误'}）`,
      '检查二进制是否完整/可执行');
  }
}
if (cfg) {
  probeBin(cfg.FFMPEG_PATH, 'ffmpeg');
  probeBin(cfg.FFPROBE_PATH, 'ffprobe');
}

// ---------- 5.1 ffmpeg 能不能往「系统临时目录」写文件 ----------
// 为什么单独查：本机沙箱下 Node/PowerShell 能写 %TEMP%，但 **ffmpeg 子进程写会 EACCES**，
// 而 scripts/ 里有 36 处用 os.tmpdir()，凡让 ffmpeg 往临时目录写媒体的套件都会假红。
// 这不是代码 bug，是环境限制；对策：把 TEMP/TMP 指到工作区（scripts/run-verify.ps1 已这么做）。
if (cfg && cfg.FFMPEG_PATH) {
  const os = require('os');
  const probeOut = path.join(os.tmpdir(), `doctor_tmp_${process.pid}.mp4`);
  try {
    execFileSync(cfg.FFMPEG_PATH, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=10:d=0.2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', probeOut], { stdio: 'ignore', timeout: 20000 });
    const okSize = fs.existsSync(probeOut) && fs.statSync(probeOut).size > 0;
    try { fs.unlinkSync(probeOut); } catch (e) {}
    if (okSize) rec('OK', 'ffmpeg 写临时目录', os.tmpdir());
    else rec('WARN', 'ffmpeg 写临时目录', '命令成功但没产出文件', '测试里的抽帧/合成可能失败');
  } catch (e) {
    try { fs.unlinkSync(probeOut); } catch (e2) {}
    rec('WARN', 'ffmpeg 不能写系统临时目录', String(os.tmpdir()),
      '本机的 36 处 os.tmpdir() 套件会假红。对策：把 TEMP/TMP 指到工作区，或直接 `pwsh -File scripts/run-verify.ps1`');
  }
}

// ---------- 6. .env 与代码/env 模板的差异 ----------
const envPath = path.join(ROOT, '.env');
const examplePath = path.join(ROOT, '.env.example');
function keysOf(text) {
  const set = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}
const codeKeys = new Set();
for (const f of ['config.js']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  for (const m of src.matchAll(/env\(\s*'([A-Z][A-Z0-9_]*)'/g)) codeKeys.add(m[1]);
}
const exampleKeys = fs.existsSync(examplePath) ? keysOf(fs.readFileSync(examplePath, 'utf8')) : new Set();
const envKeys = fs.existsSync(envPath) ? keysOf(fs.readFileSync(envPath, 'utf8')) : new Set();

if (!fs.existsSync(envPath)) {
  rec('ERROR', '.env', '不存在', '复制 .env.example 为 .env 并按注释填写');
} else {
  const missing = [...codeKeys].filter(k => !envKeys.has(k));
  if (missing.length) rec('WARN', '.env 缺少代码会读的键', missing.join(', '), '不填会走默认值；敏感项（Key）为空会降级 Mock');
  else rec('OK', '.env', `存在，且覆盖代码读取的 ${codeKeys.size} 个键`);
}
const notInExample = [...codeKeys].filter(k => !exampleKeys.has(k));
if (notInExample.length) {
  rec('WARN', '.env.example 未覆盖的键', notInExample.join(', '), '接收方不知道要配这些，建议补进 .env.example');
}

// ---------- 7. 运行时目录可写 ----------
for (const d of ['clips', 'output', 'data/tasks', 'data/logs']) {
  const p = path.join(ROOT, d);
  try {
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, `.doctor_${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    rec('OK', `目录 ${d}`, '存在且可写');
  } catch (e) {
    rec('ERROR', `目录 ${d}`, '不可写: ' + e.message, '确认运行用户有写权限（容器里请挂持久卷）');
  }
}

// ---------- 8. 端口 ----------
const port = (cfg && cfg.SERVER && cfg.SERVER.port) || 3001;
rec('OK', '服务端口', String(port));
try {
  const net = require('net');
  // 只做一次快速探测：能连上 = 已有实例在跑
  const sock = net.connect({ host: '127.0.0.1', port });
  sock.on('connect', () => { rec('WARN', '端口已被占用', `${port} 已有服务在跑`, '若在部署新实例，先停旧实例（不要并行两个）'); sock.destroy(); });
  sock.on('error', () => { rec('OK', '端口空闲', String(port)); });
  sock.setTimeout(1500, () => { sock.destroy(); rec('OK', '端口探测', '超时（视为空闲）'); });
  sock.unref();
} catch (e) { /* 忽略 */ }

// ---------- 9. 数据库 ----------
const dbType = String((cfg && cfg.DATABASE_TYPE) || 'json').toLowerCase();
if (dbType === 'postgres' || dbType === 'postgresql') {
  if (!(cfg && cfg.DATABASE_URL)) rec('ERROR', '数据库', 'DATABASE_TYPE=postgres 但没有 DATABASE_URL');
  else rec('WARN', '数据库', 'postgres：本脚本不做连接测试（可能触发超时噪声）', '启动后看首屏能否列出任务；或用 /healthz + 页面验证');
} else {
  rec('OK', '数据库', `${dbType}（本地文件模式）`);
}

// ---------- 10. 配乐素材 ----------
const bgmDir = path.join(ROOT, 'assets', 'bgm');
const mp3 = fs.existsSync(bgmDir) ? fs.readdirSync(bgmDir).filter(f => /\.(mp3|wav|m4a|ogg)$/i.test(f)) : [];
if (!mp3.length) rec('WARN', '配乐素材', 'assets/bgm 里没有音频', '仓库不包含 mp3（.gitignore），接收方需自备并登记 manifest，且注意版权');
else rec('OK', '配乐素材', `${mp3.length} 个音频文件`);

// ---------- 11. 许可证 ----------
const lic = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'].find(f => fs.existsSync(path.join(ROOT, f)));
if (!lic) {
  rec('WARN', '许可证文件', '仓库里没有 LICENSE 文件',
    'README 顶部写了 license: gpl-3.0（HF 元数据），但根目录没有许可证正文；对外交付前请明确授权方式');
} else rec('OK', '许可证文件', lic);

// ---------- 12. 日志与磁盘 ----------
const logDir = path.join(ROOT, 'data', 'logs');
if (fs.existsSync(logDir)) {
  const files = fs.readdirSync(logDir);
  const bytes = files.reduce((s, f) => { try { return s + fs.statSync(path.join(logDir, f)).size; } catch (e) { return s; } }, 0);
  const level = bytes > 200 * 1024 * 1024 ? 'WARN' : 'OK';
  rec(level, '日志体积', `${files.length} 个文件 / ${(bytes / 1048576).toFixed(1)} MB`,
    level === 'WARN' ? '日志无人清理会一直涨，建议加轮转或定时清理' : '');
}
try {
  const st = fs.statfsSync ? fs.statfsSync(ROOT) : null;
  if (st) {
    const freeGb = (st.bavail * st.bsize) / 1073741824;
    rec(freeGb < 5 ? 'WARN' : 'OK', '磁盘剩余', `${freeGb.toFixed(1)} GB`, freeGb < 5 ? '成片与片段很占空间，建议留 20GB 以上' : '');
  }
} catch (e) { /* 部分平台没有 statfs */ }

// ---------- 输出 ----------
const errors = results.filter(r => r.level === 'ERROR');
const warns = results.filter(r => r.level === 'WARN');
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ node: process.versions.node, errors: errors.length, warns: warns.length, results }, null, 2));
} else {
  const icon = { OK: '✅', WARN: '⚠️ ', ERROR: '❌' };
  console.log('\n================ 部署自检 ================');
  for (const r of results) {
    console.log(`${icon[r.level] || '  '} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    if (r.hint) console.log(`     ↳ ${r.hint}`);
  }
  console.log('==========================================');
  console.log(`结果: ${errors.length} 个必须修复 / ${warns.length} 个提醒 / 共 ${results.length} 项检查`);
  console.log(errors.length ? '🔴 还不能部署，先修上面的 ❌ 项。' : (warns.length ? '🟡 可以启动，但有提醒项。' : '🟢 全部就绪。'));
}
process.exit(errors.length ? 1 : 0);
