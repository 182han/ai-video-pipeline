// ============================================================
// 创作向导草稿（2026-11-10）
// ------------------------------------------------------------
// 事故：用户在第②步出完 1 张图，去点了页面上的其它按钮（左侧导航 / 模板库 /
// 设置…），再回「创作」发现整页空了：提示词、参数、刚出的图全没了。
// 图文件其实还在 clips/（实测 ui_img_1794305210118_img_0.png 2.6MB 还在），
// 丢的是界面状态——向导状态原先只存在组件里，切路由就卸载，状态随之归零。
//
// 解决：把向导状态挪到本模块，内存 + sessionStorage 双写：
//   · 切页回来 / F5 刷新，步骤、提示词、参数、已出的图都在；
//   · 出图请求也挂在这里（单飞）→ 生成中切走再回来，结果照样落进草稿，
//     不会出现「钱已经花了、图却看不见」；
//   · 出图失败保留上一张成功的图（旧实现会先清空结果，等于连已付费的图一起丢）；
//   · 只存界面状态与图片地址，不存任何 API Key（Key 仍只在 localStorage.vs_config）。
// ============================================================

const KEY = 'vs_create_draft_v1';
// 从「照片」页带一张已生成的图进创作流程：点按钮时写这个 key，回到 / 时由向导取走并删除
const SEED_KEY = 'vs_create_seed_photo';

function storage() {
  try { return globalThis.sessionStorage || null; } catch (e) { return null; }
}

// 照片页调用：把图片库条目暂存给创作向导（下一个 / 页面读取一次）
export function setSeedPhoto(photo) {
  const s = storage();
  if (!s || !photo) return;
  try { s.setItem(SEED_KEY, JSON.stringify(photo)); } catch (e) { /* ignore */ }
}

// 创作向导挂载时调用：取走并清掉暂存（只生效一次，刷新不会重复带入）
export function takeSeedPhoto() {
  const s = storage();
  if (!s) return null;
  let raw = null;
  try { raw = s.getItem(SEED_KEY); } catch (e) { return null; }
  if (!raw) return null;
  try { s.removeItem(SEED_KEY); } catch (e) { /* ignore */ }
  try {
    const p = JSON.parse(raw);
    return p && p.url ? p : null;
  } catch (e) { return null; }
}

// 把图片库条目变成向导里的「当前图」并写进草稿（第③步可确认，第⑥步可用于图生视频）
export function adoptPhoto(photo) {
  if (!photo || !photo.url) throw new Error('缺少图片信息');
  const result = {
    url: photo.url,
    width: photo.width || null,
    height: photo.height || null,
    model: photo.model || null,
    provider: photo.provider || null,
    size: photo.size || null,
    photoId: photo.id,
    // prompt 仍存「当前图」的展示用文案；imagePrompt 是画面基准，提交时自动拼到视频提示词前面
    prompt: photo.imagePrompt || photo.generationPrompt || photo.prompt || '',
    imagePrompt: photo.imagePrompt || photo.generationPrompt || photo.prompt || '',
    taskId: photo.taskId || null,
    createdAt: Date.parse(photo.createdAt) || Date.now(),
    importedFromLibrary: true
  };
  setImageState({ busy: false, error: '', result });
  saveDraft({ image: result, useImage: true });
  return result;
}

// 读草稿：没有 / 解析失败 / 版本不符 → null（调用方走默认值，绝不抛错）
export function loadDraft() {
  const s = storage();
  if (!s) return null;
  let raw = null;
  try { raw = s.getItem(KEY); } catch (e) { return null; }
  if (!raw) return null;
  let d = null;
  try { d = JSON.parse(raw); } catch (e) { return null; }
  if (!d || typeof d !== 'object' || d.v !== 1) return null;
  return d;
}

// 写草稿：与已存草稿合并（patch 里没有的字段保持原样，例如 image 由出图流程单独写）
export function saveDraft(patch) {
  const s = storage();
  const cur = loadDraft() || {};
  const next = { ...cur, ...(patch || {}), v: 1, savedAt: Date.now() };
  if (s) {
    try { s.setItem(KEY, JSON.stringify(next)); } catch (e) { /* 隐私模式 / 配额满：忽略，功能不受影响 */ }
  }
  return next;
}

export function clearDraft() {
  const s = storage();
  if (s) { try { s.removeItem(KEY); } catch (e) { /* ignore */ } }
  epoch++; // 作废仍在路上的出图结果：清空后不许旧结果「复活」
  resetImageState();
}

// ---- 出图状态（模块级单飞任务）----
let imageState = null;
let epoch = 0; // 每次清空草稿 +1；旧请求回来时据此丢弃结果
const imageListeners = new Set();

export function getImageState() {
  if (!imageState) {
    const d = loadDraft();
    imageState = { busy: false, error: '', result: (d && d.image) || null };
  }
  return imageState;
}

export function onImageState(fn) {
  imageListeners.add(fn);
  return () => { imageListeners.delete(fn); };
}

function setImageState(patch) {
  imageState = { ...getImageState(), ...patch };
  imageListeners.forEach((fn) => {
    try { fn(imageState); } catch (e) { /* 单个订阅者出错不影响其它 */ }
  });
  return imageState;
}

function resetImageState() {
  setImageState({ busy: false, error: '', result: null });
}

// 出 1 张图（真实计费，调用方必须是用户显式点击）。
// 单飞：正在出图时重复点击直接返回当前状态，不重复计费。
export async function startImage({ prompt, size, cfg }) {
  const st = getImageState();
  if (st.busy) return st;
  const c = cfg || {};
  const taskId = 'ui_img_' + Date.now();
  const myEpoch = epoch;
  setImageState({ busy: true, error: '' });
  try {
    const r = await fetch('/api/images/generate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: String(prompt || '').trim(),
        apiKey: c.apiKey || '',
        baseUrl: c.baseUrl || '',
        model: c.model || '',
        size: size,
        provider: c.provider || '',
        taskId: taskId,
        index: 0
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    // 出图期间用户点了「清空草稿」：结果不复活（图文件仍在 clips/，只是不再回填界面）
    if (epoch !== myEpoch) return getImageState();
    const result = {
      url: j.url,
      width: j.width,
      height: j.height,
      model: j.model,
      provider: j.provider,
      size: j.size,
      // 图片库条目 id：审核通过后，任务用这个 id 做图生视频的输入
      photoId: j.photoId || null,
      // 记下这张图是按哪条提示词出的：提示词改了以后，第③步要能提示「这是旧图」
      prompt: String(prompt || '').trim(),
      taskId: taskId,
      createdAt: Date.now()
    };
    setImageState({ busy: false, error: '', result });
    saveDraft({ image: result });
  } catch (e) {
    // 关键：失败时不清空 result —— 已付费的上一张图必须留在界面上
    if (epoch === myEpoch) setImageState({ busy: false, error: (e && e.message) || '出图失败' });
  }
  return getImageState();
}

// 只清当前图（清空草稿时用）
export function clearImage() {
  setImageState({ error: '', result: null });
  saveDraft({ image: null });
}
