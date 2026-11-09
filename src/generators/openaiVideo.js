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
// 因此本适配器额外实现 downloadVideo()（pipeline 会优先用它，而不是拿 videoUrl 裸 fetch）：
// 中转的 content 端点要鉴权，裸 fetch 会 401。
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
    return { taskId, status: 'queued' };
  }

  async getStatus(taskId) {
    if (!this.apiKey) return { status: 'failed', error: 'API Key 未配置' };
    try {
      const r = await fetch(`${this.baseUrl}/videos/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { status: 'failed', error: msgOf(data, `HTTP ${r.status}`) };

      const raw = String(data.status || '').toLowerCase();
      let status = 'processing';
      let error = null;
      let videoUrl = null;

      if (raw === 'completed' || raw === 'succeeded' || raw === 'success') {
        status = 'completed';
        // 该中转 completed 不给 URL，内容要另外拉 /content（见 downloadVideo）；
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
   * 下载成片。pipeline 看到适配器有这个方法时优先用它（中转要 Bearer）。
   * 实测：WhaleTV 的 /content 很慢（1MB 分块 25–40s，19.6MB 约 8–10 分钟），
   * 因此这里**流式写盘**（不在内存里攒 20MB），且不设过短的超时。
   * @returns {Promise<boolean>} 成功写盘返回 true
   */
  async downloadVideo(taskId, outputPath) {
    if (!this.apiKey || !this.baseUrl) { console.error('下载失败: 凭据/地址未配置'); return false; }
    const { Readable } = require('stream');
    let fileStream = null;
    try {
      const r = await fetch(`${this.baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      if (!r.ok) { console.error(`下载失败: HTTP ${r.status}`); return false; }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fileStream = fs.createWriteStream(outputPath);
      await new Promise((resolve, reject) => {
        const body = Readable.fromWeb(r.body);
        body.on('error', reject);
        fileStream.on('error', reject);
        fileStream.on('finish', resolve);
        body.pipe(fileStream);
      });
      fileStream = null;

      const size = fs.statSync(outputPath).size;
      if (size < MIN_BYTES) { console.error(`下载文件太小: ${size} bytes`); fs.unlinkSync(outputPath); return false; }
      // MP4 的 ftyp 在偏移 4..8；下到 HTML/JSON 错误页时必须拒收（AGENTS §4.8）
      const head = Buffer.alloc(12);
      const fd = fs.openSync(outputPath, 'r');
      try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
      if (head.subarray(4, 8).toString('ascii') !== 'ftyp') {
        console.error('下载内容不是 MP4（前 12 字节: ' + head.toString('hex') + '）');
        fs.unlinkSync(outputPath);
        return false;
      }
      return true;
    } catch (e) {
      console.error('下载视频异常:', e.message);
      try { if (fileStream) fileStream.destroy(); } catch (x) {}
      try { fs.unlinkSync(outputPath); } catch (x) {}
      return false;
    }
  }
}

module.exports = OpenAICompatibleVideoGenerator;
