// ==========================================
// 视频生成器：OpenAI 兼容视频接口（WhaleTV / New API 等中转、Sora 风格）
// ==========================================
//
// 实测（2026-11-09，WhaleTV 中转 https://agglm.whaletv.com/v1，model=wan3.0-video）：
//   提交：POST {baseUrl}/videos  {model, prompt, seconds:"5"}
//         → 200 {"id":"task_xxx","object":"video","status":"queued","progress":0}
//   查询：GET  {baseUrl}/videos/{id}
//         → 200 {"id":…,"status":"queued|in_progress|completed","progress":N,"completed_at":…}
//         **注意：completed 也不给 URL**
//   取片：GET  {baseUrl}/videos/{id}/content   （需要 Bearer）
//         → 200 video/mp4（实测 19,611,822 字节，文件头 ftypisom；支持 Range）
//
// ---- 以上是旧形态（Sora /videos）。2026-11-16 起文生视频仍走它（零回归）。----
//
// 实测（2026-11-16，同一中转，**图生视频**，NewAPI 形态）：
//   提交：POST {baseUrl}/video/generations  JSON {model, prompt, image, duration}
//         image = 公网图片 URL（**2026-11-16 实测通过**）或 data URL `data:{mime};base64,...`
//         （阿里云官方文档格式，**同日实测也出片**）
//         → 200 {"created_at":…,"id":"task_…","model":"wan3.0-video","status":"queued","task_id":"task_…"}
//   查询：GET  {baseUrl}/video/generations/{task_id}
//         → 200 {"code":"success","data":{…,"status":"IN_PROGRESS|SUCCESS|FAILED",
//              "progress":"30%","fail_reason":"","result_url":"https://…mp4?签名…","data":{上游原始响应}}}
//         注意：状态在 **data.status**，成片在 **data.result_url**（不是 data.data）。
//   取片：result_url 是阿里云 OSS **签名直链**（实测 24h 有效），无需 Bearer，直接 GET 即可。
//
// 因此本适配器额外实现 downloadVideo()（pipeline 会优先用它）：
// 新形态先试 result_url 直链；直链失败/旧形态任务再退回 /videos/{id}/content（要 Bearer）。
// ==========================================

const fs = require('fs');
const path = require('path');
const BaseGenerator = require('./base');

const DEFAULT_MODEL = 'wan3.0-video';
const MIN_BYTES = 1024;

const msgOf = (data, fallback) => {
  if (!data) return fallback;
  const e = data.error || data;
  const m = e && (e.message || e.msg || e.error);
  if (typeof m === 'string' && m) return m;
  try { return JSON.stringify(data).slice(0, 300); } catch (x) { return fallback; }
};

class OpenAICompatibleVideoGenerator extends BaseGenerator {
  constructor(config = {}) {
    super(config);
    this.name = 'openai-video';
    this.apiKey = String(config.apiKey || process.env.OPENAI_VIDEO_API_KEY || '').trim();
    this.baseUrl = String(config.baseUrl || process.env.OPENAI_VIDEO_BASE_URL || '').replace(/\/+$/, '');
    this.modelId = String(config.modelId || process.env.OPENAI_VIDEO_MODEL_ID || DEFAULT_MODEL).trim();
    this.timeoutMs = Number(config.timeoutMs || 300000);
    this.chunkTimeoutMs = Number(config.chunkTimeoutMs || process.env.OPENAI_VIDEO_CHUNK_TIMEOUT_MS || 90000);
    this.probeTimeoutMs = Number(config.probeTimeoutMs || 15000);
    // 每个任务属于哪种形态：'newapi'（/video/generations，图生视频）或 'sora'（/videos，旧文生视频）。
    // 同一进程内 generate → getStatus → downloadVideo 共用；进程重启后靠端点探测兜底。
    this._taskMode = new Map();
    this._urlCache = new Map();
    this.supportedOptions = {
      maxDuration: 30,
      // 中转是否支持分辨率/画幅参数**未验证**（实测只发 model+prompt 也能出片）
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1']
    };
  }

  _ensureReady() {
    if (!this.apiKey) throw new Error('OpenAI 兼容视频的 API Key 未配置（设置 → OpenAI 兼容视频）');
    if (!this.baseUrl) throw new Error('OpenAI 兼容视频的 Base URL 未配置（例如 https://agglm.whaletv.com/v1）');
  }

  async generate(prompt, options = {}) {
    this._ensureReady();
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('视频生成提示词为空');
    // 图生视频（2026-11-11 用户要求走 WhaleTV 中转）：
    // new-api / WhaleTV 的 Sora 格式用 multipart/form-data + input_reference 文件字段。
    // 文档：https://github.com/QuantumNous/new-api-docs/blob/main/docs/api/openai-video.md
    // 该字段在具体中转上是否实现**未实测**；失败会把厂商原文抛出来，不会伪装成功。
    if (options.image) {
      return await this._generateWithImage(prompt, options);
    }

    // 只发经实测被接受的字段：model / prompt / seconds。
    // 分辨率、画幅等中转是否支持未验证，贸然发送可能 400，先不传。
    const body = {
      model: this.modelId,
      prompt: prompt.trim().slice(0, 8000),
      seconds: String(Math.max(1, Math.min(this.supportedOptions.maxDuration, parseInt(options.duration, 10) || 5)))
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(this.timeoutMs, 120000));
    let response;
    try {
      response = await fetch(`${this.baseUrl}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal
      });
    } catch (e) {
      throw new Error(`提交视频任务失败（${this.baseUrl}）: ${e.name === 'AbortError' ? '超时' : e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`OpenAI 兼容视频 API 错误 (${response.status}): ${msgOf(data, '')}`);
    }
    const taskId = data.id || data.task_id;
    if (!taskId) throw new Error('视频接口未返回任务 id: ' + JSON.stringify(data).slice(0, 200));
    this._taskMode.set(String(taskId), 'sora');
    return { taskId, status: 'queued' };
  }

 // 图生视频（2026-11-16 实测通过，WhaleTV 中转 / NewAPI 形态）
  //   POST {baseUrl}/video/generations  JSON {model, prompt, image, duration}
  //   image 官方文档写明支持 URL 或 Base64；URL 已实测。
  //   Base64 形态按阿里云百炼官方文档用 **data URL**（`data:{mime};base64,...`），
  //   不是裸 base64；中转是否原样透传尚未实测（失败会抛厂商原文，不静默退回文生视频）。
  async _generateWithImage(prompt, options) {
    const image = options.image || {};
    const imageUrl = String(image.url || '').trim();
    const dataUrl = String(image.dataUrl || '').trim();
    const base64 = String(image.base64 || '').trim();
    if (!imageUrl && !dataUrl && !base64) throw new Error('图生视频首帧为空（URL / data URL / base64 都没有）');

    // 优先级：公网 URL（已实测） > data URL（官方文档格式） > 裸 base64（兜底）。
    // **不要为了“试一下”重复提交**——每次成功提交都会真实计费。
    let imagePayload = imageUrl;
    let imageKind = 'url';
    if (!imagePayload && dataUrl) { imagePayload = dataUrl; imageKind = 'dataUrl'; }
    if (!imagePayload && base64) {
      const mime = String(image.mime || 'image/png');
      imagePayload = `data:${mime};base64,${base64}`;
      imageKind = 'base64→dataUrl';
    }
    if (imageKind !== 'url') {
      console.warn(`[openai-video] 图生视频无公网 URL，改用 ${imageKind}（阿里云官方格式；2026-11-16 实测出片）`);
    }
    const body = {
      model: this.modelId,
      prompt: prompt.trim().slice(0, 8000),
      duration: Math.max(1, Math.min(this.supportedOptions.maxDuration, parseInt(options.duration, 10) || 5)),
      image: imagePayload
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(this.timeoutMs, 120000));
    let response;
    try {
      response = await fetch(`${this.baseUrl}/video/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal
      });
    } catch (e) {
      throw new Error(`提交图生视频任务失败（${this.baseUrl}）: ${e.name === 'AbortError' ? '超时' : e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`图生视频 API 错误 (${response.status}): ${msgOf(data, '')}`);
    }
    const taskId = data.task_id || data.id;
    if (!taskId) throw new Error('视频接口未返回任务 id: ' + JSON.stringify(data).slice(0, 200));
    this._taskMode.set(String(taskId), 'newapi');
    return { taskId, status: 'queued' };
  }

  async getStatus(taskId) {
    if (!this.apiKey) return { status: 'failed', error: 'API Key 未配置' };
    const mode = this._taskMode.get(String(taskId)) || 'auto';
    if (mode !== 'sora') {
      const s = await this._getStatusNewApi(taskId);
      if (s !== null) return s;   // null = 端点 404/405，交给旧形态
    }
    return this._getStatusLegacy(taskId);
  }

  // NewAPI 形态（2026-11-16 实测）：
  //   GET {baseUrl}/video/generations/{task_id}
  //   → {"code":"success","data":{id,task_id,status:"queued|IN_PROGRESS|SUCCESS|FAILED",
  //        progress:"30%",fail_reason:"",result_url:"https://…mp4?签名…","data":{上游原始响应}}}
  //   状态在 data.status，成片在 data.result_url；result_url 是签名直链，取片不需要 Bearer。
  async _getStatusNewApi(taskId) {
    try {
      const r = await fetch(`${this.baseUrl}/video/generations/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      if (r.status === 404 || r.status === 405) return null;
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { status: 'failed', error: msgOf(data, `HTTP ${r.status}`) };
      this._taskMode.set(String(taskId), 'newapi');

      const d = (data && data.data) || data || {};
      const raw = String(d.status || '').toLowerCase();
      const progressNum = parseFloat(String(d.progress == null ? '' : d.progress).replace('%', ''));
      const progress = Number.isFinite(progressNum) ? progressNum : undefined;

      if (raw === 'success' || raw === 'succeeded' || raw === 'completed' || raw === 'done' || raw === 'finished') {
        const videoUrl = d.result_url || d.url || d.video_url
          || (d.data && (d.data.result_url || d.data.url || d.data.video_url))
          || null;
        if (videoUrl) this._urlCache.set(String(taskId), videoUrl);
        return { status: 'completed', videoUrl, progress: 100 };
      }
      if (raw === 'failed' || raw === 'error' || raw === 'cancelled' || raw === 'canceled' || raw === 'failure') {
        return { status: 'failed', error: d.fail_reason || msgOf(data, '生成失败'), progress };
      }
      return { status: raw === 'queued' ? 'queued' : 'processing', progress };
    } catch (e) {
      return { status: 'failed', error: e.message };
    }
  }

  async _getStatusLegacy(taskId) {
    try {
      const r = await fetch(`${this.baseUrl}/videos/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { status: 'failed', error: msgOf(data, `HTTP ${r.status}`) };
      this._taskMode.set(String(taskId), 'sora');

      const raw = String(data.status || '').toLowerCase();
      let status = 'processing';
      let error = null;
      let videoUrl = null;

      if (raw === 'completed' || raw === 'succeeded' || raw === 'success') {
        status = 'completed';
        // 旧中转 completed 不给 URL，内容要另外拉 /content（见 _downloadByContent）；
        // 其它实现可能直接给 url，都兼容一下。
        videoUrl = data.url || data.video_url
          || (data.output && (data.output.video_url || data.output.url))
          || null;
      } else if (raw === 'failed' || raw === 'error' || raw === 'cancelled' || raw === 'canceled') {
        status = 'failed';
        error = msgOf(data, '生成失败');
      }

      const progress = Number.isFinite(data.progress) ? data.progress : (status === 'completed' ? 100 : undefined);
      return { status, videoUrl, error, progress };
    } catch (e) {
      return { status: 'failed', error: e.message };
    }
  }

  /**
   * 下载成片（pipeline 看到适配器有这个方法时优先用它）。
   *
   * 两种形态：
   *  1) **新形态（2026-11-16 实测）**：完成态给 `result_url`（阿里云 OSS 签名直链，24h 有效），
   *     直接 GET 即可，不需要 Bearer；速度快、无需分块。
   *  2) 旧形态（2026-11-09 实测）：completed 不给 URL，只能拉 `/videos/{id}/content`（要 Bearer）；
   *     该端点整段 GET 会卡住（实测 130 KB 后停滞 3 分钟），但 Range 分块稳定（1 MB/次，约 35 KB/s），
   *     因此旧路径用 1 MB 分块 + 每块重试 + 断点续写，写完再校验大小与 MP4 头。
   * @returns {Promise<boolean>} 成功写盘返回 true
   */
  async downloadVideo(taskId, outputPath) {
    if (!this.apiKey || !this.baseUrl) { console.error('下载失败: 凭据/地址未配置'); return false; }

    // 新形态：优先用查询时缓存的 result_url（进程重启则现查一次）
    let url = this._urlCache.get(String(taskId)) || null;
    if (!url) {
      const s = await this.getStatus(taskId);
      if (s && s.status === 'completed' && s.videoUrl) url = s.videoUrl;
    }
    if (url) {
      const ok = await this._downloadByUrl(url, outputPath);
      if (ok) return true;
      console.warn('[openai-video] result_url 直链下载失败，回退 /videos/{id}/content');
    }
    return this._downloadByContent(taskId, outputPath);
  }

  // 直链下载（新形态 result_url：签名 URL 不需要 Bearer；万一返回 401/403 再带 Bearer 重试一次）
  async _downloadByUrl(url, outputPath) {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      let r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (r.status === 401 || r.status === 403) {
        r = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(180000) });
      }
      if (!r.ok) { console.error(`直链下载失败: HTTP ${r.status}`); return false; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < MIN_BYTES) { console.error(`下载文件太小: ${buf.length} bytes`); return false; }
      if (buf.subarray(4, 8).toString('ascii') !== 'ftyp') {
        console.error('下载内容不是 MP4（前 12 字节: ' + buf.subarray(0, 12).toString('hex') + '）');
        return false;
      }
      fs.writeFileSync(outputPath, buf);
      return true;
    } catch (e) {
      console.error('直链下载异常:', e.message);
      return false;
    }
  }

  async _downloadByContent(taskId, outputPath) {
    if (!this.apiKey || !this.baseUrl) { console.error('下载失败: 凭据/地址未配置'); return false; }
    const CHUNK = 1024 * 1024;
    const CHUNK_TIMEOUT = Number(process.env.OPENAI_VIDEO_CHUNK_TIMEOUT_MS || this.chunkTimeoutMs || 90000);
    const url = `${this.baseUrl}/videos/${encodeURIComponent(taskId)}/content`;
    const cleanup = () => { try { fs.unlinkSync(outputPath); } catch (e) {} };

    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      // 断点续传：已有半成品就接着下（中转容易超时/卡块，重跑不应从 0 开始）
      let start = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      if (!start) fs.writeFileSync(outputPath, Buffer.alloc(0));

      // 先探总大小：Range 0-0 返回 206 + content-range。
      // 实测坑：**end 超过总长会退化成 200 整包**（中途卡死），所以每块都必须用 total-1 封顶。
      let total = null;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.probeTimeoutMs);
        try {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}`, Range: 'bytes=0-0' }, signal: ac.signal });
          const cr = r.headers.get('content-range') || '';
          const m = cr.match(/\/\s*(\d+)\s*$/);
          if (r.status === 206 && m) total = Number(m[1]);
          try { if (r.body) await r.body.cancel(); } catch (e) {}
        } finally { clearTimeout(timer); }
      } catch (e) {
        // 探不到总大小就退回不封顶（可能慢，但至少能试）
      }

      while (true) {
        const end = total != null ? Math.min(start + CHUNK - 1, total - 1) : start + CHUNK - 1;
        if (total != null && start >= total) break;
        let written = -1;
        let lastErr = null;

        for (let attempt = 1; attempt <= 4 && written < 0; attempt++) {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), CHUNK_TIMEOUT);
          try {
            const r = await fetch(url, {
              headers: { Authorization: `Bearer ${this.apiKey}`, Range: `bytes=${start}-${end}` },
              signal: ac.signal
            });
            if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status}`);
            const cr = r.headers.get('content-range') || '';
            const m = cr.match(/\/\s*(\d+)\s*$/);
            if (m) total = Number(m[1]);

            const buf = Buffer.from(await r.arrayBuffer());
            if (!buf.length) throw new Error('空响应');
            if (r.status === 200 && start > 0) {
              // 服务端忽略了 Range：只能整段重下
              fs.writeFileSync(outputPath, buf);
              written = buf.length;
              total = buf.length;
              break;
            }
            const fh = await fs.promises.open(outputPath, 'r+');
            try { await fh.write(buf, 0, buf.length, start); } finally { await fh.close(); }
            written = buf.length;
          } catch (e) {
            lastErr = e.name === 'AbortError' ? new Error(`分块超时（${CHUNK_TIMEOUT}ms）`) : e;
            if (attempt < 4) await new Promise((res) => setTimeout(res, 1000 * attempt));
          } finally {
            clearTimeout(timer);
          }
        }

        if (written < 0) {
          // 保留半成品，便于下次续传（不要 unlink）
          console.error(`下载失败（第 ${start} 字节起）: ${lastErr ? lastErr.message : '未知'}；已保留半成品可续传`);
          return false;
        }
        start += written;
        if (written < CHUNK) break;                 // 最后一块
        if (total != null && start >= total) break; // 已取全
      }

      const size = fs.statSync(outputPath).size;
      if (size < MIN_BYTES) { console.error(`下载文件太小: ${size} bytes`); cleanup(); return false; }
      if (total != null && size !== total) {
        // 不完整：保留半成品，下次调用会从 size 处续传
        console.error(`下载不完整: ${size}/${total} 字节（已保留半成品，可续传）`);
        return false;
      }
      // MP4 的 ftyp 在偏移 4..8；下到 HTML/JSON 错误页时必须拒收（AGENTS §4.8）
      const head = Buffer.alloc(12);
      const fd = fs.openSync(outputPath, 'r');
      try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
      if (head.subarray(4, 8).toString('ascii') !== 'ftyp') {
        console.error('下载内容不是 MP4（前 12 字节: ' + head.toString('hex') + '）');
        cleanup();
        return false;
      }
      return true;
    } catch (e) {
      console.error('下载视频异常:', e.message);
      cleanup();
      return false;
    }
  }
}

module.exports = OpenAICompatibleVideoGenerator;
