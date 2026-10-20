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
    name: 'stages',
    script: 'verify-stages.js',
    group: 'fast',
    desc: '档位/依赖/补跑计算（纯函数）'
  },
  {
    name: 'frontend-static',
    script: 'verify-frontend-static.js',
    group: 'fast',
    desc: '前端静态一致性（元素/请求体/既有功能未破坏）'
  },
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
