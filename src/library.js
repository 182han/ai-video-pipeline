// ==========================================
// 片段库：已生成单个视频的独立档案
// ==========================================
//
// 为什么要独立于任务 JSON：
//   用户明确要求「小片段不随着成片删除而消失，要删只能去片段库删」。
//   任务 JSON 被删（移入回收站/永久删除）后，片段文件仍在 clips/ 里，
//   如果没有独立档案，提示词/模型/费用这些元数据就永久丢了。
//
// 存储：
//   app/data/library/<id>.json   一条片段一个文件（避免整库文件并发写坏）
//   id = <taskId>_c<clipIndex+1>  重新生成会落在新任务下，天然唯一
//
// 不自动扫描任务：用户删过库条目后，自动扫描会把删掉的又加回来。
// 历史任务由 scripts/backfill-library.js 显式回填一次。

const fs = require('fs');
const path = require('path');
const pricing = require('./pricing');

const APP_DIR = path.join(__dirname, '..');
const LIB_DIR = path.join(APP_DIR, 'data', 'library');
const CLIPS_DIR = path.join(APP_DIR, 'clips');

let cache = null;
let cacheSignature = '';

// 目录签名：文件名 + 大小 + mtime。
// 用途：片段库是文件存储，补库脚本 / 人工修复 / 另一个服务实例都可能在本进程之外改库。
// 只靠 saveEntry() 刷新缓存的话，运行中的服务会一直读旧列表，刷新页面也看不到
// （事故：task_mvgw4hbo_ajuc 补库后页面仍然空白，最后靠一次收藏开关触发重读）。
function dirSignature() {
  try {
    const names = fs.readdirSync(LIB_DIR).filter(n => n.endsWith('.json')).sort();
    return names.map(n => {
      try {
        const st = fs.statSync(path.join(LIB_DIR, n));
        return `${n}:${st.size}:${st.mtimeMs}`;
      } catch (e) {
        return n + ':missing';
      }
    }).join('|');
  } catch (e) {
    return '';
  }
}

function ensureDir() {
  if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR, { recursive: true });
}

function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function entryPath(id) {
  return path.join(LIB_DIR, safeId(id) + '.json');
}

function loadAll(force = false) {
  const sig = dirSignature();
  if (cache && !force && sig === cacheSignature) return cache;
  ensureDir();
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(LIB_DIR).filter(n => n.endsWith('.json'));
  } catch (e) {
    names = [];
  }
  for (const n of names) {
    try {
      const raw = fs.readFileSync(path.join(LIB_DIR, n), 'utf8');
      const entry = JSON.parse(raw);
      if (entry && entry.id) map.set(entry.id, entry);
    } catch (e) {
      console.warn(`[library] 读取失败 ${n}: ${e.message}`);
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
  const map = loadAll();
  return map.get(safeId(id)) || null;
}

function listAll() {
  const map = loadAll();
  return Array.from(map.values())
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
}

function update(id, patch) {
  const entry = get(id);
  if (!entry) return null;
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
  return saveEntry(entry);
}

function remove(id) {
  const entry = get(id);
  if (!entry) return { success: false, error: '片段不存在' };
  let fileDeleted = false;
  try {
    const resolved = path.resolve(entry.filePath || '');
    const clipsRoot = path.resolve(CLIPS_DIR) + path.sep;
    if (resolved.startsWith(clipsRoot) && fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
      fileDeleted = true;
    }
  } catch (e) {
    console.warn(`[library] 删除源文件失败 ${entry.filePath}: ${e.message}`);
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

// ---------- 元数据 ----------

function resolutionLabel(width, height) {
  const h = Number(height) || 0;
  if (h >= 1800) return '4K';
  if (h >= 900) return '1080p';
  if (h >= 650) return '720p';
  if (h >= 400) return '480p';
  return '其他';
}

function fpsNumber(fps) {
  const s = String(fps || '');
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (b) return Math.round((a / b) * 1000) / 1000;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function resolveClipFile(videoPath) {
  if (!videoPath) return null;
  const p = String(videoPath);
  if (fs.existsSync(p)) return p;
  const candidate = path.join(CLIPS_DIR, path.basename(p));
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function buildTiming(clip) {
  const t = clip.timing || {};
  const startedAt = t.genStartedAt || clip.createdAt || null;
  const completedAt = t.qcCompletedAt || clip.completedAt || null;
  const totalMs = startedAt && completedAt
    ? Math.max(0, new Date(completedAt) - new Date(startedAt))
    : (t.totalMs || null);
  const genMs = t.genStartedAt && t.genCompletedAt
    ? Math.max(0, new Date(t.genCompletedAt) - new Date(t.genStartedAt))
    : null;
  const qcMs = t.qcStartedAt && t.qcCompletedAt
    ? Math.max(0, new Date(t.qcCompletedAt) - new Date(t.qcStartedAt))
    : null;
  return {
    startedAt,
    completedAt,
    totalMs,
    genMs,
    qcMs,
    // 历史片段没有分段记录：明确标出来，避免前端把 totalMs 冒充「生成耗时」
    splitAvailable: !!(genMs !== null && qcMs !== null),
    // 历史记录的开始/结束可能跨暂停与重跑，只能作参考
    historical: !(genMs !== null && qcMs !== null)
  };
}

/**
 * 从任务里的片段记录构建库条目（不落盘）。
 * probe 允许调用方传入，避免重复 ffprobe。
 */
function buildEntry(task, clip, filePath, probe) {
  const id = `${task.taskId}_c${clip.index + 1}`;
  const info = probe && probe.success ? probe : null;
  const durationSec = info && Number.isFinite(info.duration) && info.duration > 0
    ? Math.round(info.duration * 1000) / 1000
    : (clip.duration || task.clipDuration || null);
  const width = info ? info.width : (clip.width || null);
  const height = info ? info.height : (clip.height || null);
  const label = resolutionLabel(width, height);

  const cost = clip.cost && typeof clip.cost === 'object'
    ? clip.cost
    : pricing.computeClipCost({
      model: task.model,
      resolution: task.resolution,
      clipDurationSec: durationSec || task.clipDuration,
      modelId: task.runtimeConfig && task.runtimeConfig.modelId
    }, clip.attempts);

  const originalPrompt = Array.isArray(task.prompts) && task.prompts[clip.index]
    ? task.prompts[clip.index].text
    : (task.prompt || '');

  const qc = clip.qcResult || null;
  return {
    id,
    fileName: path.basename(filePath),
    filePath,
    url: '/clips/' + encodeURIComponent(path.basename(filePath)),
    taskId: task.taskId,
    clipIndex: clip.index,
    prompt: clip.prompt || originalPrompt || '',
    originalPrompt: originalPrompt || '',
    model: task.model || 'unknown',
    resolution: task.resolution || label,
    width: width || null,
    height: height || null,
    fps: info ? fpsNumber(info.fps) : (clip.fps || null),
    codec: info ? info.codec : (clip.codec || null),
    durationSec,
    sizeBytes: (() => {
      try { return fs.statSync(filePath).size; } catch (e) { return null; }
    })(),
    hasAudio: info && info.hasAudio !== undefined ? !!info.hasAudio : null,
    cost,
    timing: buildTiming(clip),
    qc: qc ? {
      passed: !!qc.passed,
      unverified: !!clip.qcUnverified,
      level: qc.level || (qc.passed ? 'pass' : 'fail'),
      reason: qc.reason || '',
      qcVersion: qc.qcVersion || null
    } : {
      // 没有片段级质检记录（手工恢复 / 补跑复用的片段）如实标「未验证」。
      // 旧逻辑落到前端「质检记录异常」（红色），既吓人也不准确：没记录 ≠ 记录异常。
      passed: false,
      unverified: true,
      level: 'unknown',
      reason: clip.qcUnverified ? '片段级质检未执行（以终检为准）' : '无片段级质检记录（未重新质检）',
      qcVersion: null
    },
    theme: clip.theme || task.theme || null,
    themeTag: clip.themeTag || null,
    tags: {
      theme: clip.theme || task.theme || null,
      model: task.model || null,
      resolution: label
    },
    favorite: false,
    replacedBy: null,
    regeneratedFrom: task.regeneratedFrom || null,
    source: task.source === 'regenerate' ? 'regenerate' : (task.source === 'library' ? 'library' : 'generation'),
    addedAt: new Date().toISOString()
  };
}

/**
 * 生成成功/失败后把片段写入片段库（幂等：同 id 覆盖）。
 * mock 模式的合成测试片不入库（用户明确要求：测试的、黑屏的、蓝屏的都不要）。
 */
function ingestClip(task, clip, probeOverride) {
  try {
    if (!task || !clip) return null;
    if (task.model === 'mock') return null;
    if (clip.status !== 'success') return null;
    const filePath = resolveClipFile(clip.videoPath);
    if (!filePath) return null;

    // 复用已有条目的收藏/替代关系，避免重新生成或补跑把用户标记冲掉
    const existing = get(`${task.taskId}_c${clip.index + 1}`);
    let probe = probeOverride || null;
    if (!probe) {
      try {
        const videoProcessor = require('./videoProcessor');
        probe = videoProcessor.probeDetail(filePath);
      } catch (e) {
        probe = null;
      }
    }

    const entry = buildEntry(task, clip, filePath, probe);
    if (existing) {
      entry.favorite = !!existing.favorite;
      entry.replacedBy = existing.replacedBy || null;
      entry.lastRegenerate = existing.lastRegenerate || null;
      entry.addedAt = existing.addedAt || entry.addedAt;
    }
    entry.updatedAt = new Date().toISOString();
    saveEntry(entry);

    // 重新生成成功：把旧条目标记为「已被替代」
    if (task.regeneratedFrom) {
      update(task.regeneratedFrom, {
        replacedBy: entry.id,
        replacedAt: new Date().toISOString(),
        lastRegenerate: {
          status: 'success',
          taskId: task.taskId,
          newEntryId: entry.id,
          finishedAt: new Date().toISOString()
        }
      });
    }
    return entry;
  } catch (e) {
    console.warn(`[library] 入库失败 ${task && task.taskId}: ${e.message}`);
    return null;
  }
}

/**
 * 把任务里「已成功、但片段库没有档案」的片段补进库（幂等）。
 *
 * 为什么需要：入库只挂在「生成成功」和「重检转成功」两条路径上。
 * 手工恢复的付费片段、补跑复用的老片段都不经过这两条路径，
 * 结果是片段文件在、成片也拼出来了，片段库却一条都没有
 * （事故：task_mvgw4hbo_ajuc 两个已付费片段）。
 *
 * 只处理 status==='success'；已有档案的跳过，不覆盖用户的收藏/替代关系。
 */
function ingestMissing(task) {
  const added = [];
  if (!task || !Array.isArray(task.clips)) return added;
  for (const clip of task.clips) {
    if (!clip || clip.status !== 'success') continue;
    const id = `${task.taskId}_c${clip.index + 1}`;
    if (get(id)) continue;
    const entry = ingestClip(task, clip);
    if (entry) added.push(entry.id);
  }
  return added;
}

function markRegenerateStarted(oldId, taskId) {
  return update(oldId, {
    lastRegenerate: {
      status: 'running',
      taskId,
      startedAt: new Date().toISOString()
    }
  });
}

function markRegenerateFailed(oldId, taskId, error, attempts) {
  const entry = get(oldId);
  if (!entry) return null;
  const cost = entry.cost && entry.cost.unitPrice !== undefined
    ? pricing.round2((entry.cost.amountPerAttempt || 0) * Math.max(1, attempts || 1))
    : 0;
  return update(oldId, {
    lastRegenerate: {
      status: 'failed',
      taskId,
      error: String(error || '生成失败').slice(0, 300),
      attempts: Math.max(1, attempts || 1),
      cost,
      finishedAt: new Date().toISOString()
    }
  });
}

function setFavorite(id, favorite) {
  return update(id, { favorite: !!favorite });
}

// 按分辨率分组（供片段库页面使用）
// itemsOverride 可选：页面筛选后只对筛选结果分组，但分组标签顺序保持一致。
function grouped(itemsOverride) {
  const items = Array.isArray(itemsOverride) ? itemsOverride : listAll();
  const order = ['4K', '1080p', '720p', '480p', '其他'];
  const groups = new Map();
  for (const it of items) {
    const label = it.tags && it.tags.resolution ? it.tags.resolution : resolutionLabel(it.width, it.height);
    if (!groups.has(label)) {
      groups.set(label, { label, count: 0, totalCost: 0, totalDurationSec: 0, items: [] });
    }
    const g = groups.get(label);
    g.count += 1;
    g.totalCost = pricing.round2(g.totalCost + ((it.cost && it.cost.amount) || 0));
    g.totalDurationSec = pricing.round2(g.totalDurationSec + (Number(it.durationSec) || 0));
    g.items.push(it);
  }
  const list = Array.from(groups.values()).sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  const totalCost = pricing.round2(items.reduce((s, it) => s + ((it.cost && it.cost.amount) || 0), 0));
  const totalDurationSec = pricing.round2(items.reduce((s, it) => s + (Number(it.durationSec) || 0), 0));
  return {
    groups: list,
    totals: { count: items.length, totalCost, totalDurationSec, favorites: items.filter(i => i.favorite).length }
  };
}

function stats() {
  const items = listAll();
  return {
    count: items.length,
    totalCost: pricing.round2(items.reduce((s, it) => s + ((it.cost && it.cost.amount) || 0), 0)),
    totalDurationSec: pricing.round2(items.reduce((s, it) => s + (Number(it.durationSec) || 0), 0))
  };
}

module.exports = {
  LIB_DIR,
  CLIPS_DIR,
  loadAll,
  get,
  listAll,
  update,
  remove,
  ingestClip,
  ingestMissing,
  markRegenerateStarted,
  markRegenerateFailed,
  setFavorite,
  grouped,
  stats,
  resolutionLabel,
  safeId,
  buildEntry,
  upsert: saveEntry
};
