// ==========================================
// 图片库：AI 生成的静帧（图片）的独立档案
// ==========================================
//
// 为什么要有它：
//   用户 2026-11-11 明确要求「所有生成的图片都要存在库里，并且保留对应的提示词」。
//   以前出图只把文件写进 clips/，提示词/模型/尺寸/审核状态**全都不落盘**：
//   页面一刷新，图文件还在但再也找不到它是按哪条提示词、什么模型出的。
//
// 存储：
//   app/data/photos/<id>.json   一条图片一个文件（与片段库同样的文件存储，避免整库并发写坏）
//   id = <taskId>_img_<index>   出图接口本来就按这个命名文件，天然唯一
//
// 与片段库（src/library.js）的区别：
//   · 片段库存视频；这里存图片；
//   · 图片多一个「人工审核」状态：pending（待审）/ approved（通过）/ rejected（打回）；
//   · 图片可以带 source（generation / backfill），回填的历史图提示词未知，必须如实留空，不许编。
//
// 不自动扫描 clips/ 加回：用户删过库条目后，自动扫描会把删掉的又加回来（与片段库同一原则）。
// 历史文件由 scripts/backfill-photo-library.js 显式回填。

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
// 允许测试用 PHOTOS_DIR / CLIPS_DIR 指向临时目录，避免验收脚本污染真实库
const PHOTO_DIR = process.env.PHOTOS_DIR ? path.resolve(process.env.PHOTOS_DIR) : path.join(APP_DIR, 'data', 'photos');
const CLIPS_DIR = process.env.CLIPS_DIR ? path.resolve(process.env.CLIPS_DIR) : path.join(APP_DIR, 'clips');

const STATUSES = ['pending', 'approved', 'rejected'];

let cache = null;
let cacheSignature = '';

function ensureDir() {
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

function dirSignature() {
  try {
    const names = fs.readdirSync(PHOTO_DIR).filter((n) => n.endsWith('.json')).sort();
    return names.map((n) => {
      try {
        const st = fs.statSync(path.join(PHOTO_DIR, n));
        return `${n}:${st.size}:${st.mtimeMs}`;
      } catch (e) {
        return n + ':missing';
      }
    }).join('|');
  } catch (e) {
    return '';
  }
}

function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function entryPath(id) {
  return path.join(PHOTO_DIR, safeId(id) + '.json');
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return e;
  if (typeof e.imagePrompt !== 'string') {
    e.imagePrompt = (typeof e.generationPrompt === 'string' && e.generationPrompt)
      || (typeof e.prompt === 'string' ? e.prompt : '');
  }
  if (typeof e.videoPrompt !== 'string') {
    // 旧记录里 prompt 若被视频提示词覆盖过（promptSource=video-task），把它还原成 videoPrompt
    e.videoPrompt = (e.promptSource === 'video-task' && typeof e.prompt === 'string' && e.prompt !== e.imagePrompt)
      ? e.prompt : '';
  }
  if (typeof e.prompt !== 'string' || !e.prompt) e.prompt = e.imagePrompt;
  return e;
}

function loadAll(force = false) {
  const sig = dirSignature();
  if (cache && !force && sig === cacheSignature) return cache;
  ensureDir();
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(PHOTO_DIR).filter((n) => n.endsWith('.json'));
  } catch (e) {
    names = [];
  }
  for (const n of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(PHOTO_DIR, n), 'utf8'));
      if (entry && entry.id) map.set(entry.id, normalizeEntry(entry));
    } catch (e) {
      console.warn(`[photoLibrary] 读取失败 ${n}: ${e.message}`);
    }
  }
  cache = map;
  cacheSignature = sig;
  return cache;
}

function saveEntry(entry) {
  ensureDir();
  const p = entryPath(entry.id);
  const tmp = p + '.tmp';
  entry.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  loadAll(true);
  return entry;
}

function get(id) {
  return loadAll().get(safeId(id)) || null;
}

function listAll() {
  return Array.from(loadAll().values())
    .sort((a, b) => String(b.createdAt || b.addedAt || '').localeCompare(String(a.createdAt || a.addedAt || '')));
}

function update(id, patch) {
  const entry = get(id);
  if (!entry) return null;
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
  return saveEntry(entry);
}

// 图片入库（幂等：重复登记同一 id 时只补空字段，不覆盖已审核状态）
function ingest(data = {}) {
  const id = safeId(data.id || makeId(data.taskId, data.index));
  if (!id) throw new Error('图片入库缺少 id/taskId');
  const filePath = data.filePath ? path.resolve(String(data.filePath)) : '';
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`图片文件不存在: ${data.filePath || '(空)'}`);
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size < 8) throw new Error(`图片文件无效: ${st.size} 字节`);

  const existing = get(id);
  if (existing) {
    // 已有记录：只补缺失字段（提示词、尺寸等），绝不覆盖审核状态
    const filled = { ...existing };
    for (const k of ['prompt', 'negativePrompt', 'provider', 'model', 'size', 'width', 'height', 'taskId']) {
      if ((filled[k] === undefined || filled[k] === null || filled[k] === '') && data[k] !== undefined && data[k] !== null && data[k] !== '') {
        filled[k] = data[k];
      }
    }
    filled.sizeBytes = st.size;
    if (!filled.generationPrompt) filled.generationPrompt = filled.prompt || '';
    if (!filled.imagePrompt) filled.imagePrompt = filled.generationPrompt || filled.prompt || '';
    if (typeof filled.videoPrompt !== 'string') filled.videoPrompt = '';
    return saveEntry(filled);
  }

  const entry = {
    id,
    fileName: path.basename(filePath),
    filePath,
    url: data.url || '/clips/' + encodeURIComponent(path.basename(filePath)),
    taskId: data.taskId || null,
    index: Number.isInteger(data.index) ? data.index : 0,
    // 用户明确要求保留提示词：原样存全文，不截断
    prompt: typeof data.prompt === 'string' ? data.prompt.trim() : '',
    // 出图时的原始提示词（之后用这张图生成视频时，prompt 可能被视频提示词覆盖，原值留在这里）
    generationPrompt: typeof data.prompt === 'string' ? data.prompt.trim() : '',
    // 2026-11-11 用户口径：画面提示词与视频提示词分开存，互不覆盖
    imagePrompt: typeof data.prompt === 'string' ? data.prompt.trim() : '',
    videoPrompt: '',
    imagePromptUpdatedAt: null,
    negativePrompt: typeof data.negativePrompt === 'string' ? data.negativePrompt.trim() : '',
    provider: data.provider || null,
    model: data.model || null,
    size: data.size || null,
    width: Number.isFinite(data.width) ? data.width : null,
    height: Number.isFinite(data.height) ? data.height : null,
    sizeBytes: st.size,
    status: STATUSES.includes(data.status) ? data.status : 'pending',
    reviewedAt: null,
    reviewNote: '',
    source: data.source || 'generation',
    promptAvailable: typeof data.prompt === 'string' && data.prompt.trim().length > 0,
    usedIn: [],
    createdAt: data.createdAt || new Date().toISOString(),
    addedAt: new Date().toISOString()
  };
  return saveEntry(entry);
}

function makeId(taskId, index) {
  const t = safeId(taskId || 'img');
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return `${t}_img_${i}`;
}

// 人工审核：只允许三态；打回不会删文件（删是另一个动作）
function markReviewed(id, status, note) {
  if (!STATUSES.includes(status)) throw new Error('status 只能是 pending / approved / rejected');
  const entry = get(id);
  if (!entry) return null;
  entry.status = status;
  entry.reviewedAt = status === 'pending' ? null : new Date().toISOString();
  entry.reviewNote = typeof note === 'string' ? note.slice(0, 500) : (entry.reviewNote || '');
  return saveEntry(entry);
}

// 记录「这张图被哪个视频任务用过」——用于追溯，不改变文件
function attachUsage(id, taskId) {
  const entry = get(id);
  if (!entry) return null;
  const list = Array.isArray(entry.usedIn) ? entry.usedIn : [];
  if (taskId && !list.some((u) => u.taskId === taskId)) {
    list.push({ taskId, at: new Date().toISOString() });
  }
  entry.usedIn = list.slice(-20);
  return saveEntry(entry);
}

// 删除库条目。默认同时删源文件（仅当文件确实在 clips/ 内，防越界删别的文件）
function remove(id, { deleteFile = true } = {}) {
  const entry = get(id);
  if (!entry) return { success: false, error: '图片不存在' };
  let fileDeleted = false;
  if (deleteFile && entry.filePath) {
    try {
      const resolved = path.resolve(entry.filePath);
      const root = path.resolve(CLIPS_DIR) + path.sep;
      if (resolved.startsWith(root) && fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
        fileDeleted = true;
      }
    } catch (e) {
      console.warn(`[photoLibrary] 删除源文件失败 ${entry.filePath}: ${e.message}`);
    }
  }
  try {
    const p = entryPath(entry.id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    return { success: false, error: '删除库记录失败: ' + e.message };
  }
  loadAll(true);
  return { success: true, fileDeleted, entry };
}

function totals(list) {
  const t = { all: list.length, pending: 0, approved: 0, rejected: 0 };
  for (const it of list) {
    if (t[it.status] !== undefined) t[it.status]++;
  }
  return t;
}

function query({ status = '', q = '' } = {}) {
  let list = listAll();
  if (status) list = list.filter((it) => it.status === status);
  const kw = String(q || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((it) => String(it.prompt || '').toLowerCase().includes(kw)
      || String(it.model || '').toLowerCase().includes(kw)
      || String(it.id || '').toLowerCase().includes(kw));
  }
  return list;
}

// 扫描 clips/ 里的出图文件（<taskId>_img_<index>.(png|jpg|webp)），返回尚未入图片库的
function listUnregisteredImages() {
  ensureDir();
  const known = new Set(Array.from(loadAll(true).values()).map((e) => path.resolve(e.filePath || '')).filter(Boolean));
  let names = [];
  try {
    names = fs.readdirSync(CLIPS_DIR);
  } catch (e) {
    return [];
  }
  const re = /^(.+)_img_(\d+)\.(png|jpe?g|webp)$/i;
  const out = [];
  for (const n of names) {
    const m = n.match(re);
    if (!m) continue;
    const full = path.join(CLIPS_DIR, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile() || st.size < 8) continue;
    if (known.has(path.resolve(full))) continue;
    out.push({
      id: safeId(`${m[1]}_img_${m[2]}`),
      taskId: m[1],
      index: Number(m[2]),
      filePath: full,
      fileName: n,
      sizeBytes: st.size,
      createdAt: st.mtime.toISOString(),
      source: 'backfill'
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  STATUSES,
  PHOTO_DIR,
  makeId,
  ingest,
  get,
  listAll,
  query,
  totals,
  update,
  markReviewed,
  attachUsage,
  remove,
  listUnregisteredImages
};
