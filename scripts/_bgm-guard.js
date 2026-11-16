// 配乐测试公共守卫（非套件；文件名不以 verify- 开头，不进 verify-all 注册表）。
// 用途：任何配乐相关测试在开始/结束时快照真实 assets/bgm（递归文件清单 + manifest sha256），
// 断言测试没有触碰真实素材目录。测试必须把自己的 BGM_DIR 指到临时目录。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REAL_BGM_DIR = path.join(__dirname, '..', 'assets', 'bgm');

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return 'MISSING'; }
}

function listFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      out.push({
        rel: path.relative(root, p).split(path.sep).join('/'),
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs)
      });
    }
  };
  walk(root);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// 快照真实 assets/bgm：文件清单（名字/大小/mtime）+ manifest 内容 sha256
function snapshotRealBgm() {
  const manifestPath = path.join(REAL_BGM_DIR, 'manifest.json');
  return {
    dir: REAL_BGM_DIR,
    manifestSha256: sha256File(manifestPath),
    files: listFiles(REAL_BGM_DIR)
  };
}

// 返回 { ok, message }；ok=false 时 message 给出第一处差异（供套件判 FAIL）
function diffRealBgm(before) {
  const now = snapshotRealBgm();
  if (now.manifestSha256 !== before.manifestSha256) {
    return { ok: false, message: `真实 assets/bgm/manifest.json 被改动（sha256 ${before.manifestSha256.slice(0, 12)}… → ${now.manifestSha256.slice(0, 12)}…）` };
  }
  const a = before.files;
  const b = now.files;
  if (a.length !== b.length) {
    return { ok: false, message: `真实 assets/bgm 文件数变化：${a.length} → ${b.length}` };
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].rel !== b[i].rel || a[i].size !== b[i].size || a[i].mtimeMs !== b[i].mtimeMs) {
      return { ok: false, message: `真实 assets/bgm 文件被改动：${a[i].rel}（size ${a[i].size}→${b[i].size}，mtime ${a[i].mtimeMs}→${b[i].mtimeMs}）` };
    }
  }
  return { ok: true, message: '真实 assets/bgm 未被触碰（文件清单 + manifest sha256 均一致）' };
}

module.exports = { REAL_BGM_DIR, snapshotRealBgm, diffRealBgm, sha256File };
