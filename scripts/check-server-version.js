// ==========================================
// 检查「运行中的服务」是不是「磁盘上的最新代码」
// ==========================================
//
// 背景（2026-11-09 实际踩坑）：
//   前端 web/** 是 Express 静态文件，每次请求都从磁盘读 → 改完前端刷新就生效；
//   后端 server.js / src/** 是 Node 启动时 require 进内存 → 改完不重启还是旧代码。
//   于是会出现「界面是新的、接口是旧的」：例如设置页有「图片生成」，
//   但后端不认 type=imagegen，报「未知的类型」。
//
// 用法：
//   node scripts/check-server-version.js
//   node scripts/check-server-version.js --port 3002
//   node scripts/check-server-version.js --json
//
// 退出码：
//   0 = 运行中的服务就是当前磁盘代码
//   1 = 旧代码 / 运行中的 server.js 早于磁盘文件 / 关键探针缺失
//   2 = 服务没运行或不可达
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../config');

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? fallback : v;
}

const JSON_OUT = process.argv.includes('--json');
const port = parseInt(arg('port', String(config.SERVER.port || 3001)), 10);
const base = `http://127.0.0.1:${port}`;
const localFile = path.join(__dirname, '..', 'server.js');
const localMtime = (() => {
  try { return fs.statSync(localFile).mtimeMs; } catch (e) { return null; }
})();

function out(obj, lines) {
  if (JSON_OUT) {
    console.log(JSON.stringify(obj, null, 2));
  } else {
    for (const line of lines) console.log(line);
  }
}

(async () => {
  let status;
  try {
    const res = await fetch(base + '/api/status', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    status = await res.json();
  } catch (e) {
    out({
      ok: false,
      state: 'not-running',
      url: base,
      error: e.message,
      localServerMtime: localMtime,
      hint: '启动命令: cd app && node server.js'
    }, [
      `❌ 服务未运行或不可达: ${base}（${e.message}）`,
      '启动: cd "C:\\Users\\14872\\Desktop\\测试\\app" && node server.js'
    ]);
    process.exit(2);
  }

  const info = status.serverInfo || null;
  const image = status.imageGen || null;
  const issues = [];

  if (!info) {
    issues.push('缺少 serverInfo 探针：运行的是旧代码（旧 server.js 没有版本探针）');
  } else if (info.serverMtime && localMtime && localMtime - info.serverMtime > 1000) {
    issues.push(
      `运行中的 server.js 早于磁盘文件：`
      + `running=${new Date(info.serverMtime).toISOString()} / `
      + `disk=${new Date(localMtime).toISOString()}`
    );
    issues.push('改完后端没有重启');
  }

  if (!image) {
    issues.push('缺少 imageGen 探针：运行的是旧代码（没有图片生成接口）');
  } else if (image.model !== config.IMAGE_GEN_MODEL) {
    issues.push(`运行中的图片模型 ${image.model} ≠ 当前配置 ${config.IMAGE_GEN_MODEL}`);
  }

  // 2026-11-23 补齐：启动时加载的不止 server.js —— config.js、.env、src/**/*.js
  // 也是启动时读进内存的。此前只比对 server.js，改了 src 没重启仍报 ✅（当天踩过两次）。
  const newerFiles = [];
  const startedMs = info && info.startedAt ? new Date(info.startedAt).getTime() : null;
  if (startedMs && Number.isFinite(startedMs)) {
    const appRoot = path.join(__dirname, '..');
    const collect = (dir, acc) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) collect(full, acc);
        else if (ent.isFile() && /\.js$/i.test(ent.name)) acc.push(full);
      }
      return acc;
    };
    const candidates = collect(path.join(appRoot, 'src'), []);
    for (const p of [path.join(appRoot, 'config.js'), path.join(appRoot, '.env')]) {
      try { if (fs.statSync(p).isFile()) candidates.push(p); } catch (e) { /* 忽略 */ }
    }
    for (const f of candidates) {
      try {
        const m = fs.statSync(f).mtimeMs;
        if (m > startedMs + 1000) {
          newerFiles.push({ path: path.relative(appRoot, f), mtime: new Date(m).toISOString() });
        }
      } catch (e) { /* 忽略 */ }
    }
    if (newerFiles.length) {
      newerFiles.sort((a, b) => new Date(a.mtime) - new Date(b.mtime));
      issues.push(`运行中的服务早于 ${newerFiles.length} 个启动时加载的文件（改完没重启）：`);
      for (const n of newerFiles.slice(0, 10)) issues.push(`  ${n.path}  ${n.mtime}`);
      if (newerFiles.length > 10) issues.push(`  ...还有 ${newerFiles.length - 10} 个`);
    }
  }

  const result = {
    ok: issues.length === 0,
    state: issues.length === 0 ? 'current' : 'stale',
    url: base,
    pid: info ? info.pid : null,
    startedAt: info ? info.startedAt : null,
    runningServerMtime: info ? info.serverMtime : null,
    localServerMtime: localMtime,
    imageGen: image,
    newerFiles,
    issues
  };

  if (issues.length === 0) {
    out(result, [
      `✅ 运行中的服务就是当前磁盘代码（端口 ${port}，PID ${info.pid}）`,
      `   启动时间: ${info.startedAt}`,
      `   server.js: running=${info.serverMtime ? new Date(info.serverMtime).toISOString() : 'unknown'}`,
      `              disk   =${localMtime ? new Date(localMtime).toISOString() : 'unknown'}`,
      `   图片生成: ${image.provider} / ${image.model}（服务端 Key: ${image.configured ? '已配置' : '未配置'}）`
    ]);
    process.exit(0);
  }

  out(result, [
    `❌ 运行中的服务不是当前磁盘代码（端口 ${port}）`,
    ...issues.map(x => '   - ' + x),
    '',
    '处理：完全退出旧服务后重启',
    '   netstat -ano | findstr :' + port,
    '   taskkill /PID <上面的PID> /F',
    '   cd "C:\\Users\\14872\\Desktop\\测试\\app"',
    '   node server.js'
  ]);
  process.exit(1);
})();
