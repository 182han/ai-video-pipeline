// ==========================================
// 统一回收站：片段 / 成片 / 图片 / 配乐
// ==========================================
//
// 背景（2026-11-15 用户口径）：
//   库存里的“删除”必须是两步：先移入回收站（可恢复），再在回收站里确认彻底删除。
//   旧实现是 lib/photo 直接 unlink 源文件、bgm 直接删上传文件，删掉就找不回来。
//
// 存储：
//   app/data/recycle/<type>/<id>/entry.json   元数据（原条目对象 + 文件映射）
//   app/data/recycle/<type>/<id>/files/…      被移走的文件（保留原文件名）
//   <type> ∈ clip | final | photo | bgm
//
// 设计约束：
//   1) 只允许回收白名单目录内的文件（clips/output/assets/bgm/data/library/data/photos），
//      路径必须 resolve 后比较前缀，禁止用字符串 startsWith 防穿越；
//   2) 先移文件，成功后才删原条目；任何一步失败都不留下半状态；
//   3) 不做自动过期清理——只有显式“彻底删除”才 rm。

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

const RECYCLE_DIR = process.env.RECYCLE_DIR
  ? path.resolve(process.env.RECYCLE_DIR)
  : path.join(APP_DIR, 'data', 'recycle');

const DEFAULT_ROOTS = [
  process.env.CLIPS_DIR ? path.resolve(process.env.CLIPS_DIR) : path.join(APP_DIR, 'clips'),
  process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(APP_DIR, 'output'),
  process.env.BGM_DIR ? path.resolve(process.env.BGM_DIR) : path.join(APP_DIR, 'assets', 'bgm'),
  process.env.LIBRARY_DIR ? path.resolve(process.env.LIBRARY_DIR) : path.join(APP_DIR, 'data', 'library'),
  process.env.PHOTOS_DIR ? path.resolve(process.env.PHOTOS_DIR) : path.join(APP_DIR, 'data', 'photos')
];

const TYPES = ['clip', 'final', 'photo', 'bgm'];

function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// resolve 后必须落在某个白名单根目录内（带分隔符比较，防 output/../server.js）
function resolveAllowed(file, roots) {
  if (!file) return null;
  const abs = path.resolve(String(file));
  const list = Array.isArray(roots) && roots.length ? roots : DEFAULT_ROOTS;
  for (const root of list) {
    try {
      const base = path.resolve(root) + path.sep;
      if (abs.startsWith(base)) return abs;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function typeDir(type) {
  const t = String(type || '');
  if (!TYPES.includes(t)) throw new Error(`未知回收类型: ${type}`);
  return path.join(RECYCLE_DIR, t);
}

function readRecord(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'entry.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 移入回收站。
 * @param {object} opts
 *   type   clip|final|photo|bgm
 *   id     原条目 id
 *   files  [{ file: 绝对路径 }]（可以为空：只回收入口元数据）
 *   entry  原条目对象（恢复时原样写回）
 *   meta   额外信息（reason 等）
 *   allowedRoots 可选，仅测试用：覆盖白名单
 * @returns {{ok:boolean, dir?:string, moved?:string[], error?:string}}
 */
function moveToRecycle(opts = {}) {
  const { type, id, files = [], entry = null, meta = null, allowedRoots } = opts;
  const sid = safeId(id);
  if (!sid) return { ok: false, error: '缺少 id' };
  let dir;
  try { dir = path.join(typeDir(type), sid); } catch (e) { return { ok: false, error: e.message }; }

  // 同 id 重复移入：加时间戳后缀，绝不覆盖已有回收记录
  if (fs.existsSync(dir)) dir = path.join(typeDir(type), `${sid}-${Date.now()}`);

  const records = [];
  const moved = [];
  try {
    ensureDir(path.join(dir, 'files'));
    for (let i = 0; i < files.length; i++) {
      const raw = files[i] && (files[i].file || files[i]);
      if (!raw) continue;
      const abs = resolveAllowed(raw, allowedRoots);
      if (!abs) return { ok: false, error: `拒绝回收白名单外的文件: ${raw}` };
      const existed = fs.existsSync(abs);
      if (!existed) {
        records.push({ original: abs, stored: null, existed: false });
        continue;
      }
      const base = path.basename(abs);
      let dest = path.join(dir, 'files', base);
      if (fs.existsSync(dest)) dest = path.join(dir, 'files', `${i}_${base}`);
      fs.renameSync(abs, dest);
      records.push({ original: abs, stored: path.relative(dir, dest), existed: true });
      moved.push(abs);
    }
    const record = {
      id: sid,
      type,
      trashedAt: new Date().toISOString(),
      entry,
      meta,
      files: records
    };
    fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify(record, null, 2), 'utf8');
    return { ok: true, dir, moved };
  } catch (e) {
    // 回滚：把已经移走的文件放回原位，再删半成品目录
    for (const r of records) {
      if (!r.stored) continue;
      try {
        const dest = path.join(dir, r.stored);
        if (fs.existsSync(dest)) {
          ensureDir(path.dirname(r.original));
          fs.renameSync(dest, r.original);
        }
      } catch (e2) { /* 回滚失败只能保留在回收站，至少文件没丢 */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e3) { /* ignore */ }
    return { ok: false, error: e.message };
  }
}

/**
 * 列出回收站条目；type 省略时列出全部类型。
 */
function list(type) {
  const types = type ? [String(type)] : TYPES;
  const out = [];
  for (const t of types) {
    let dir;
    try { dir = typeDir(t); } catch (e) { continue; }
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const d = path.join(dir, name);
      let st;
      try { st = fs.statSync(d); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      const rec = readRecord(d);
      if (!rec) continue;
      out.push({
        type: t,
        id: rec.id,
        trashedAt: rec.trashedAt,
        dirName: name,
        entry: rec.entry || null,
        meta: rec.meta || null,
        fileCount: (rec.files || []).filter(f => f.existed).length,
        sizeBytes: (() => {
          try {
            return (rec.files || []).reduce((n, f) => {
              if (!f.stored) return n;
              try { return n + fs.statSync(path.join(d, f.stored)).size; } catch (e) { return n; }
            }, 0);
          } catch (e) { return 0; }
        })()
      });
    }
  }
  out.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
  return out;
}

function findDir(type, id) {
  const root = typeDir(type);
  const sid = safeId(id);
  if (!fs.existsSync(root)) return null;
  const candidates = fs.readdirSync(root)
    .filter(n => n === sid || n.startsWith(sid + '-'))
    .map(n => path.join(root, n))
    .filter(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const A = readRecord(a), B = readRecord(b);
    return String((B && B.trashedAt) || '').localeCompare(String((A && A.trashedAt) || ''));
  });
  return candidates[0];
}

/**
 * 恢复：把文件放回原路径；返回原条目对象，由调用方写回库。
 * 目标位置已有同名文件时，写入 <name>.restored-<ts>，并在 conflicts 里列出。
 */
function restore(type, id) {
  const dir = findDir(type, id);
  if (!dir) return { ok: false, error: '回收站里没有这条记录' };
  const rec = readRecord(dir);
  if (!rec) return { ok: false, error: '回收记录损坏' };
  const conflicts = [];
  const restored = [];
  try {
    for (const f of (rec.files || [])) {
      if (!f.stored) continue;
      const src = path.join(dir, f.stored);
      if (!fs.existsSync(src)) continue;
      ensureDir(path.dirname(f.original));
      let dest = f.original;
      if (fs.existsSync(dest)) {
        const ext = path.extname(dest);
        dest = dest.slice(0, dest.length - ext.length) + '.restored-' + Date.now() + ext;
        conflicts.push(dest);
      }
      fs.renameSync(src, dest);
      restored.push(dest);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, entry: rec.entry || null, restored, conflicts };
  } catch (e) {
    return { ok: false, error: e.message, restored };
  }
}

/** 彻底删除一条（不可恢复）。 */
function purge(type, id) {
  const dir = findDir(type, id);
  if (!dir) return { ok: false, error: '回收站里没有这条记录' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 彻底清空某类型（或全部）。 */
function purgeAll(type) {
  const types = type ? [String(type)] : TYPES;
  let removed = 0;
  for (const t of types) {
    let dir;
    try { dir = typeDir(t); } catch (e) { continue; }
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed++;
      } catch (e) { /* ignore */ }
    }
  }
  return { ok: true, removed };
}

module.exports = {
  RECYCLE_DIR,
  DEFAULT_ROOTS,
  TYPES,
  moveToRecycle,
  list,
  restore,
  purge,
  purgeAll,
  resolveAllowed
};
