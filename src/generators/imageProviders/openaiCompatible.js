// ==========================================
// 出图适配器：OpenAI 兼容 images 接口（New API / WhaleTV 等中转、OpenAI 官方）
// ==========================================
//
// 与百炼原生（./dashscope.js）的区别：
//   dashscope      ：POST 提交异步任务 → 轮询 /tasks/{id} → 下载
//   openai-images  ：POST {baseUrl}/images/generations → 一次返回 data[0].url / b64_json
//
// 实测（2026-11-09，WhaleTV 中转 https://agglm.whaletv.com/v1）：
//   POST /images/generations {model:'wan2.7-image', prompt, n:1, size:'1024x1024'}
//   → 200 {"created":…,"data":[{"url":"https://dashscope-…/xxx.png"}]}
//
// 契约（与 dashscope 适配器一致，别破坏）：
//   - 成功返回 { imagePath, width, height, provider, model }，文件必须真实存在
//   - 失败必须 throw，不返回占位图/假图/半截文件
//   - 宽高以「下载到的字节」为准（readImageMeta），不信接口自报
//   - 错误信息不出现 API Key，也不打完整签名 URL
// ==========================================

const fs = require('fs');
const path = require('path');
const globalConfig = require('../../../config');
const { readImageMeta } = require('../../utils/imageMeta');

const PROVIDER = 'openai-images';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'wan2.7-image';
const SUBMIT_PATH = '/images/generations';
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

const pick = (obj, key) => (obj && obj[key] != null && obj[key] !== '' ? obj[key] : undefined);

function resolveSettings(config = {}) {
  const apiKey = String(
    pick(config, 'IMAGE_GEN_API_KEY') || globalConfig.IMAGE_GEN_API_KEY || ''
  ).trim();
  const baseUrl = String(
    pick(config, 'IMAGE_GEN_BASE_URL') || globalConfig.IMAGE_GEN_BASE_URL || DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const model = String(pick(config, 'IMAGE_GEN_MODEL') || globalConfig.IMAGE_GEN_MODEL || DEFAULT_MODEL).trim();
  // 配置里常见百炼写法 1696*960；OpenAI 兼容接口用 1696x960。
  const rawSize = String(pick(config, 'IMAGE_GEN_SIZE') || globalConfig.IMAGE_GEN_SIZE || '1024x1024').trim();
  const size = rawSize.replace(/\*/g, 'x');
  const timeoutMs = Number(pick(config, 'IMAGE_GEN_TIMEOUT_MS') || globalConfig.IMAGE_GEN_TIMEOUT_MS || 300000);

  if (!apiKey) throw new Error('图片生成缺少 API Key（IMAGE_GEN_API_KEY 或页面设置里的 Key）');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`IMAGE_GEN_BASE_URL 非法（必须以 http:// 或 https:// 开头）: ${baseUrl || '（空）'}`);
  return { apiKey, baseUrl, model, size, timeoutMs };
}

/** 从响应体里找出图片：url / b64_json / data:image/...;base64,...（兼容中转的 metadata 包装）。 */
function extractImagePayload(json) {
  const data = Array.isArray(json && json.data) ? json.data : [];
  const first = data[0] || {};
  if (typeof first.b64_json === 'string' && first.b64_json.length > 32) {
    return { kind: 'b64', value: first.b64_json };
  }
  if (typeof first.url === 'string' && first.url) {
    return { kind: 'url', value: first.url };
  }
  // 部分中转把结果包在 metadata.output.choices[].message.content[].image
  const content = json && json.metadata && json.metadata.output && json.metadata.output.choices
    && json.metadata.output.choices[0] && json.metadata.output.choices[0].message
    && json.metadata.output.choices[0].message.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item.image === 'string' && item.image) return { kind: 'url', value: item.image };
    }
  }
  return null;
}

async function readLimitedBody(res) {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大（${buf.length} 字节，上限 ${MAX_IMAGE_BYTES}）`);
    return buf;
  }
  // Node 18+ 的 undici：直接 arrayBuffer 即可，这里加长度保护
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大（${buf.length} 字节，上限 ${MAX_IMAGE_BYTES}）`);
  return buf;
}

async function downloadImage(url, { deadline, requestId }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(remain, 60000));
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await readLimitedBody(r);
      // 这里只证明「是图片」，宽高留给调用方再取一次，避免两处口径不一致
      readImageMeta(buf);
      return buf;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise((res) => setTimeout(res, 800 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`图片下载失败${requestId ? `（${requestId}）` : ''}: ${lastError ? lastError.message : '超时'}`);
}

function saveImage(buf, meta, { outDir, taskId, index }) {
  const dir = outDir || (globalConfig.STORAGE && globalConfig.STORAGE.clipsDir)
    || path.join(__dirname, '..', '..', '..', 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const sanitize = (s) => String(s || 'img').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const base = `${sanitize(taskId)}_img_${Number.isInteger(index) && index >= 0 ? index : 0}`;
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, buf);
    for (let v = 1; v <= 99; v++) {
      const candidate = path.join(dir, v === 1 ? `${base}.${meta.ext}` : `${base}_v${v}.${meta.ext}`);
      try {
        // COPYFILE_EXCL：并发/重复点击不会互相覆盖，也不会把半截文件当成品
        fs.copyFileSync(tmp, candidate, fs.constants.COPYFILE_EXCL);
        return candidate;
      } catch (e) {
        if (e && e.code === 'EEXIST') continue;
        throw e;
      }
    }
    throw new Error('同名图片已占用 99 个，拒绝覆盖');
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 临时文件可能已被移走 */ }
  }
}

function messageOf(json, fallback) {
  if (!json) return fallback;
  const e = json.error || json;
  const msg = e && (e.message || e.msg || e.error);
  if (typeof msg === 'string' && msg) return msg;
  try { return JSON.stringify(json).slice(0, 300); } catch (x) { return fallback; }
}

/**
 * 适配器入口（契约见 src/generators/imageGen.js 顶部）
 * @param {{prompt:string, options:object, config:object}} args
 */
async function generate({ prompt, options = {}, config = {} }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('出图提示词为空');
  const s = resolveSettings(config);
  const deadline = Date.now() + s.timeoutMs;
  const requestId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const body = { model: s.model, prompt: prompt.trim(), n: 1, size: s.size };

  let res;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(s.timeoutMs, 120000));
    try {
      res = await fetch(s.baseUrl + SUBMIT_PATH, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + s.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    throw new Error(`提交出图请求失败（${s.baseUrl}）: ${e.name === 'AbortError' ? '超时' : e.message}`);
  }

  const ctype = String(res.headers.get('content-type') || '');
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`鉴权失败 HTTP ${res.status}：${messageOf(json, text.slice(0, 120))}`
        + '（检查 Key 与 Base URL 是否同属一个中转/业务空间）');
    }
    throw new Error(`出图接口 HTTP ${res.status}：${messageOf(json, text.slice(0, 200))}`);
  }
  // 200 但不是 JSON：多半是把网页地址填成了 Base URL（HTML 200），必须显式失败
  if (!json) {
    const head = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`出图接口返回的不是 JSON（content-type: ${ctype || '未知'}），`
      + `Base URL 可能填成了网页地址。响应开头: ${head}`);
  }

  const payload = extractImagePayload(json);
  if (!payload) {
    throw new Error(`出图接口没有返回图片数据：${JSON.stringify(json).slice(0, 200)}`);
  }

  let buf;
  if (payload.kind === 'b64') {
    buf = Buffer.from(payload.value, 'base64');
    if (!buf.length) throw new Error('b64_json 解码为空');
  } else {
    buf = await downloadImage(payload.value, { deadline, requestId });
  }
  const meta = readImageMeta(buf);       // 不是图片就 throw
  const imagePath = saveImage(buf, meta, {
    outDir: options.outDir || config.outDir,
    taskId: options.taskId || requestId,
    index: options.index
  });

  return {
    imagePath,
    width: meta.width,
    height: meta.height,
    provider: PROVIDER,
    model: s.model,
    requestId,
    // 便于排查：实际用的地址与尺寸（不含 Key）
    baseUrl: s.baseUrl,
    size: s.size
  };
}

module.exports = generate;
module.exports.__test__ = { resolveSettings, extractImagePayload, generate, PROVIDER };
