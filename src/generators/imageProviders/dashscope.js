// ==========================================
// 阿里云百炼 DashScope 文生图适配器（wan2.7-image）
// ==========================================
//
// 官方文档：
//   https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference
//
// 提交：POST {baseUrl}/services/aigc/image-generation/generation
// 查询：GET  {baseUrl}/tasks/{task_id}
// 下载：结果 URL 有效期 24 小时，必须落盘后才把路径交给流水线
//
// baseUrl 是完整 API 根地址，例如：
//   https://dashscope.aliyuncs.com/api/v1
//   https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1
//
// 设计约束（与 src/generators/imageGen.js 的适配器契约一致）：
//   - 成功必须返回 { imagePath, width, height, provider, model }，文件真实存在；
//   - 失败必须 throw，绝不返回占位图 / 假图 / 半截文件；
//   - 不把 base64 塞进 imagePath；先落盘再返回路径；
//   - 错误信息里不出现 API Key（也不打印完整签名 URL）。
// ==========================================

const fs = require('fs');
const path = require('path');
const globalConfig = require('../../../config');
const { readImageMeta } = require('../../utils/imageMeta');

const PROVIDER_NAME = 'dashscope';
const DEFAULT_MODEL = 'wan2.7-image';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_SIZE = '1696*960'; // 16:9 / 1K（wan2.7-image 支持 1K、2K）
const SUBMIT_PATH = '/services/aigc/image-generation/generation';
const MAX_PROMPT_CHARS = 8000;

function pick(cfg, key) {
  const v = cfg && cfg[key];
  if (v !== undefined && v !== null && v !== '') return v;
  return globalConfig[key];
}

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 解析本次调用要用的配置。所有字段都可被 options/ImageGenerator 的 config 覆盖，
 * 便于验收脚本把 baseUrl 指向本地 stub（不需要真实 Key）。
 */
function resolveSettings(config = {}) {
  const apiKey = String(
    pick(config, 'IMAGE_GEN_API_KEY') || globalConfig.DASHSCOPE_API_KEY || ''
  ).trim();
  const baseUrl = String(
    pick(config, 'IMAGE_GEN_BASE_URL') || globalConfig.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL
  ).trim().replace(/\/+$/, '');
  const model = String(pick(config, 'IMAGE_GEN_MODEL') || DEFAULT_MODEL).trim();
  const size = String(pick(config, 'IMAGE_GEN_SIZE') || DEFAULT_SIZE).trim();
  const timeoutMs = parsePositiveInt(pick(config, 'IMAGE_GEN_TIMEOUT_MS'), 300000);
  const pollMs = parsePositiveInt(pick(config, 'IMAGE_GEN_POLL_MS'), 2000);
  const watermarkRaw = pick(config, 'IMAGE_GEN_WATERMARK');
  const watermark = /^(1|true|yes)$/i.test(String(watermarkRaw == null ? 'false' : watermarkRaw).trim());

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`IMAGE_GEN_BASE_URL 非法（必须以 http:// 或 https:// 开头）: ${baseUrl || '（空）'}`);
  }
  if (!model) throw new Error('IMAGE_GEN_MODEL 为空');

  return { apiKey, baseUrl, model, size, timeoutMs, pollMs, watermark };
}

/**
 * 把 1696x960 / 1696*960 / 2K 统一成 DashScope 接受的写法。
 * 官方 size 参数支持 1K/2K/4K 预设，也支持显式 宽*高（* 分隔）。
 */
function normalizeSize(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s) throw new Error('图片尺寸为空');
  if (s === '1K' || s === '2K' || s === '4K') return s;
  const m = s.match(/^(\d{2,5})\s*[X*]\s*(\d{2,5})$/);
  if (!m) {
    throw new Error(`图片尺寸非法: ${raw}（支持 1K/2K/4K 或 宽*高，例如 1696*960）`);
  }
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (w < 64 || h < 64 || w > 8192 || h > 8192) {
    throw new Error(`图片尺寸超出范围: ${w}*${h}（宽高需在 64~8192 之间）`);
  }
  return `${w}*${h}`;
}

/** 构造提交体；单独导出便于 CLI/验收脚本断言请求结构，不联网。 */
function buildImagePayload({ model, prompt, size, n = 1, watermark = false, negativePrompt, promptExtend }) {
  const text = String(prompt == null ? '' : prompt).trim();
  if (!text) throw new Error('出图提示词为空');
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(`出图提示词过长（${text.length} 字，上限 ${MAX_PROMPT_CHARS}）`);
  }

  const parameters = {
    size: normalizeSize(size),
    n: n == null ? 1 : n,
    watermark: !!watermark
  };
  if (negativePrompt != null && String(negativePrompt).trim()) {
    parameters.negative_prompt = String(negativePrompt).trim().slice(0, 2000);
  }
  if (typeof promptExtend === 'boolean') parameters.prompt_extend = promptExtend;

  return {
    model,
    input: {
      messages: [{
        role: 'user',
        content: [{ text }]
      }]
    },
    parameters
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

// 统一 JSON 请求：保留 HTTP 状态；网络/超时/非 JSON 都转成可读错误。
async function fetchJson(label, url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { ...(opts || {}), signal: controller.signal });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = null; }

    if (!res.ok) {
      const msg = (data && (data.message || (data.error && data.error.message) || data.code))
        || String(text || '').slice(0, 300)
        || ('HTTP ' + res.status);
      const err = new Error(`${label}失败（HTTP ${res.status}）: ${msg}`);
      err.kind = 'http';
      err.httpStatus = res.status;
      throw err;
    }
    if (data === null) {
      const err = new Error(`${label}返回的不是 JSON（前 200 字符: ${String(text).slice(0, 200)}）`);
      err.kind = 'bad-json';
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error(`${label}超时（>${timeoutMs}ms）`);
      err.kind = 'timeout';
      throw err;
    }
    if (e && e.kind) throw e;
    const err = new Error(`${label}网络错误: ${e && e.message ? e.message : e}`);
    err.kind = 'network';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从响应里收集图片 URL。兼容两种形态：
 *   1) wan2.7 messages 形态：output.choices[].message.content[] = { type:'image', image:url }
 *   2) 旧版 results 形态：  output.results[] = { url }
 */
function extractImageUrls(output) {
  const urls = [];
  const push = (u) => {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.push(u);
  };

  for (const choice of (output && output.choices) || []) {
    const content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item) continue;
        if (typeof item.image === 'string') push(item.image);
        else if (item.image && typeof item.image.url === 'string') push(item.image.url);
      }
    } else if (typeof content === 'string') {
      push(content);
    }
  }

  for (const r of (output && output.results) || []) {
    if (!r) continue;
    push(r.url);
    push(r.image);
  }

  for (const u of (output && output.images) || []) push(u);

  return Array.from(new Set(urls));
}

function describeTaskError(output, data, fallback) {
  const o = output || {};
  return o.message || o.code || (data && (data.message || data.code)) || fallback;
}

async function pollForImages({ baseUrl, apiKey, taskId, deadline, pollMs, requestId }) {
  let lastStatus = 'PENDING';

  while (Date.now() < deadline) {
    const wait = Math.min(pollMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleep(wait);
    if (Date.now() >= deadline) break;

    const remain = Math.max(1, deadline - Date.now());
    let data;
    try {
      data = await fetchJson('图片生成查询', `${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      }, Math.min(30000, remain));
    } catch (e) {
      // 429 / 5xx 视为暂时性错误，继续轮询；其余（401/403/404）直接失败。
      if (e.kind === 'http' && (e.httpStatus === 429 || e.httpStatus >= 500)) continue;
      throw e;
    }

    const output = data.output || {};
    lastStatus = String(output.task_status || data.task_status || 'UNKNOWN').toUpperCase();

    if (lastStatus === 'SUCCEEDED') {
      const urls = extractImageUrls(output);
      if (!urls.length) {
        throw new Error(`图片生成任务 ${taskId} 成功但响应里没有图片 URL（request_id=${requestId || '未知'}）`);
      }
      return urls;
    }

    if (lastStatus === 'FAILED' || lastStatus === 'CANCELED' || lastStatus === 'UNKNOWN') {
      throw new Error(`图片生成任务 ${taskId} ${lastStatus}: ${describeTaskError(output, data, lastStatus)}`);
    }
  }

  throw new Error(`图片生成超时（task_id=${taskId}，最后状态 ${lastStatus}）`);
}

function sanitizeName(name) {
  const s = String(name == null ? '' : name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return s || `img_${Date.now()}`;
}

async function downloadImage(url, { deadline }) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(60000, remain));
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) {
        const err = new Error(`图片下载失败（HTTP ${res.status}）`);
        err.kind = 'http';
        err.httpStatus = res.status;
        throw err;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = readImageMeta(buf); // 不是图片直接抛错（不重试）
      return { buf, meta };
    } catch (e) {
      lastError = e;
      if (e && e.name === 'AbortError') {
        const err = new Error('图片下载超时');
        err.kind = 'timeout';
        lastError = err;
      } else if (e && !e.kind) {
        const err = new Error(`图片下载网络错误: ${e.message}`);
        err.kind = 'network';
        lastError = err;
      }
      const retryable = lastError && (
        lastError.kind === 'network' ||
        lastError.kind === 'timeout' ||
        (lastError.kind === 'http' && (lastError.httpStatus === 429 || lastError.httpStatus >= 500))
      );
      if (!retryable || attempt === 3) throw lastError;
      const wait = Math.min(1000, 200 * attempt, Math.max(0, deadline - Date.now()));
      if (wait > 0) await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('图片下载超时');
}

async function saveImage(buf, meta, { outDir, taskId, index }) {
  const dir = outDir || (globalConfig.STORAGE && globalConfig.STORAGE.clipsDir) || path.join(__dirname, '..', '..', '..', 'clips');
  fs.mkdirSync(dir, { recursive: true });

  const base = `${sanitizeName(taskId)}_img_${Number.isInteger(index) && index >= 0 ? index : 0}`;
  // 先写唯一临时文件，再用 COPYFILE_EXCL 抢占最终文件名：
  // 两个并发出图（或重复点击）不会互相覆盖，也不会把半截文件当成品。
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, buf);
    for (let v = 1; v <= 99; v++) {
      const name = v === 1 ? `${base}.${meta.ext}` : `${base}_v${v}.${meta.ext}`;
      const candidate = path.join(dir, name);
      try {
        fs.copyFileSync(tmp, candidate, fs.constants.COPYFILE_EXCL);
        return candidate;
      } catch (e) {
        if (e && e.code === 'EEXIST') continue;
        throw e;
      }
    }
    throw new Error(`图片落盘失败：同名文件过多（${base}）`);
  } catch (e) {
    if (e && /^图片落盘失败/.test(e.message)) throw e;
    throw new Error(`图片落盘失败: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (ignored) { /* 临时文件已不存在 */ }
  }
}

// 提交阶段对 429 / 5xx 做有限重试；401/403/400 立即失败。
async function submitWithRetry({ url, apiKey, payload, deadline }) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;

    try {
      return await fetchJson('图片生成提交', url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-DashScope-Async': 'enable'
        },
        body: JSON.stringify(payload)
      }, Math.min(60000, remain));
    } catch (e) {
      lastError = e;
      const retryable = e && e.kind === 'http' && (e.httpStatus === 429 || e.httpStatus >= 500);
      if (!retryable || attempt === maxAttempts) throw e;

      const backoff = Math.min(3000, 300 * Math.pow(2, attempt - 1));
      const wait = Math.min(backoff, Math.max(0, deadline - Date.now()));
      if (wait <= 0) throw e;
      await sleep(wait);
    }
  }

  throw lastError || new Error('图片生成提交超时');
}

/**
 * 适配器入口（契约见 src/generators/imageGen.js）。
 * @param {{prompt:string, options?:object, config?:object}} args
 */
async function generateImage({ prompt, options = {}, config = {} } = {}) {
  const text = String(prompt == null ? '' : prompt).trim();
  if (!text) throw new Error('出图提示词为空');
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(`出图提示词过长（${text.length} 字，上限 ${MAX_PROMPT_CHARS}）`);
  }

  const s = resolveSettings(config);
  if (!s.apiKey) {
    throw new Error(
      '图片生成 API Key 未配置：请在 app/.env 填 IMAGE_GEN_API_KEY'
      + '（或复用 DASHSCOPE_API_KEY），然后重启服务。'
    );
  }

  const n = options.n == null ? 1 : Number.parseInt(options.n, 10);
  if (n !== 1) {
    throw new Error('当前出图适配器一次只生成 1 张（n=1）；多图请按片段逐张调用');
  }

  const size = normalizeSize(options.size || s.size);
  const payload = buildImagePayload({
    model: s.model,
    prompt: text,
    size,
    n,
    watermark: options.watermark == null ? s.watermark : !!options.watermark,
    negativePrompt: options.negativePrompt,
    promptExtend: options.promptExtend
  });

  const deadline = Date.now() + s.timeoutMs;
  const startedAt = Date.now();

  const submit = await submitWithRetry({
    url: `${s.baseUrl}${SUBMIT_PATH}`,
    apiKey: s.apiKey,
    payload,
    deadline
  });

  const requestId = submit.request_id || '';
  if (submit.code) {
    // 少数错误会以 HTTP 200 + code/message 返回，不能当成提交成功
    throw new Error(`图片生成提交失败（${submit.code}）: ${submit.message || '厂商未提供原因'}`);
  }
  const output = submit.output || {};
  const taskId = output.task_id || submit.task_id || '';
  let urls = extractImageUrls(output);

  if (!urls.length) {
    if (!taskId) {
      throw new Error(`图片生成提交成功但响应里既没有 task_id 也没有图片 URL（request_id=${requestId || '未知'}）`);
    }
    urls = await pollForImages({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      taskId,
      deadline,
      pollMs: s.pollMs,
      requestId
    });
  }

  const downloaded = await downloadImage(urls[0], { deadline });
  const imagePath = await saveImage(downloaded.buf, downloaded.meta, {
    outDir: options.outDir,
    taskId: options.taskId || taskId || `img_${Date.now()}`,
    index: options.index
  });

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[image-gen] ${s.model} 出图成功: ${path.basename(imagePath)} `
    + `${downloaded.meta.width}x${downloaded.meta.height} ${seconds}s`
    + (taskId ? ` task_id=${taskId}` : '')
  );

  return {
    imagePath,
    width: downloaded.meta.width,
    height: downloaded.meta.height,
    provider: PROVIDER_NAME,
    model: s.model,
    bytes: downloaded.buf.length,
    requestId,
    taskId
  };
}

// 既导出可调用函数（注册表要 function），也挂上调试/测试辅助。
module.exports = generateImage;
module.exports.generateImage = generateImage;
module.exports.resolveSettings = resolveSettings;
module.exports.buildImagePayload = buildImagePayload;
module.exports.normalizeSize = normalizeSize;
module.exports.extractImageUrls = extractImageUrls;
