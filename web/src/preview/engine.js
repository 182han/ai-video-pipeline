// ============================================================
// 剪辑台实时预览（F06）
// ------------------------------------------------------------
// 2026-11-04：WebGL2 3D LUT + 双 video 连续播放 + 转场叠化。
// 颜色数学不在这里复写：LUT 由后端 /api/adjust/lut 用 adjustChain 生成，
// 与导出 ffmpeg lut3d 用的是同一套参数→颜色映射。
//
// 用法：
//   const engine = new PreviewEngine(canvas, { onTime, onEnd, onError });
//   engine.setSegments([{url,inSec,outSec,adjust}], {transition});
//   engine.play(); engine.pause(); engine.seek(sec); engine.destroy();
// ============================================================

import { t as tr } from '../i18n/index.js';

const LUT_SIZE = 17;
const FALLBACK_F = 0.4;
// 预览「静默黑屏」看门狗：见构造函数里的说明。
const NO_FRAME_WATCHDOG_MS = 8000;

// 给媒体 URL 加一次性 cache-buster（用于自动重载）。
function bustUrl(url) {
  const u = String(url || '');
  if (!u) return u;
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + '_pv=' + Date.now();
}

const lutDataCache = new Map(); // JSON(adjust) -> Promise<Uint8Array|null>

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ADV_KEYS = ['hsl', 'curve', 'wheel'];
function hasAdjust(adjust) {
  if (!adjust || typeof adjust !== 'object') return false;
  if (ADV_KEYS.some((k) => adjust[k] && typeof adjust[k] === 'object')) return true;
  return Object.keys(adjust).some((k) => {
    const v = Number(adjust[k]);
    return Number.isFinite(v) && v !== 0;
  });
}

function fetchLut(adjust) {
  const key = JSON.stringify(adjust || {});
  if (lutDataCache.has(key)) return lutDataCache.get(key);
  const p = fetch('/api/adjust/lut', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adjust })
  }).then(async (r) => {
    const j = await r.json();
    return j && j.success && j.data ? b64ToBytes(j.data) : null;
  }).catch(() => null);
  lutDataCache.set(key, p);
  return p;
}

const VERT = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform sampler3D uLutA;
uniform sampler3D uLutB;
uniform float uMix;
uniform int uLutAOn;
uniform int uLutBOn;
out vec4 outColor;

vec3 applyLut(sampler3D l, vec3 c) {
  vec3 coord = c * (16.0 / 17.0) + (0.5 / 17.0);
  return texture(l, coord).rgb;
}

void main() {
  vec3 a = texture(uTexA, vUv).rgb;
  if (uLutAOn == 1) a = applyLut(uLutA, a);
  vec3 b = texture(uTexB, vUv).rgb;
  if (uLutBOn == 1) b = applyLut(uLutB, b);
  outColor = vec4(mix(a, b, uMix), 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(tr('editor.preview.shaderCompile', { log }));
  }
  return sh;
}

export class PreviewEngine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
    if (!this.gl) throw new Error(tr('editor.preview.webgl2'));
    this.segments = [];
    this.starts = [];
    this.duration = 0;
    this.transition = FALLBACK_F;
    this.index = 0;
    this.global = 0;
    this.playing = false;
    this.raf = 0;
    this.lastEmit = 0;
    this.destroyed = false;
    // 2026-11-21：静默黑屏防护（用户在剪辑台看到整块黑，页面却没有任何报错）。
    //
    // 机理：`_upload()` 对 readyState < 2 的视频直接 return，画布就一直停在初始的
    // 1x1 黑色纹理上；整条链路不抛异常，所以既没有 onError 也没有提示 —— 用户只能看到黑。
    // 现在：8s 内一帧都没画出来 → 先自动换 cache-buster URL 重载一次（治「缓存里存了坏响应」
    // 与「上次加载中断」）→ 仍无帧 → 把 HTTP 状态 / readyState / video 错误码交给 UI 显示。
    this.framesDrawn = 0;
    this.watchdog = null;
    this.recoveredOnce = false;
    this.texCache = new Map(); // LUT key -> WebGLTexture
    this.audioEls = [];
    this.audioPlan = [null, null];
    // 2026-11-22：成片自带音频（「保留原声」）。默认关，由 editor 按工程设置打开。
    this.sourcePlan = { enabled: false, volume: 1 };
    this._onResize = () => { if (!this.destroyed) this._render(); };
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(this._onResize);
      this.ro.observe(canvas);
    }
    window.addEventListener('resize', this._onResize);
    this._initGl();
    this._initVideos();
    this._initAudio();
  }

  // ---------- 初始化 ----------
  _initGl() {
    const gl = this.gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUv');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(tr('editor.preview.shaderLink', { log: gl.getProgramInfoLog(prog) }));
    }
    this.prog = prog;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0
    ]), gl.STATIC_DRAW);
    this.u = {
      texA: gl.getUniformLocation(prog, 'uTexA'),
      texB: gl.getUniformLocation(prog, 'uTexB'),
      lutA: gl.getUniformLocation(prog, 'uLutA'),
      lutB: gl.getUniformLocation(prog, 'uLutB'),
      mix: gl.getUniformLocation(prog, 'uMix'),
      lutAOn: gl.getUniformLocation(prog, 'uLutAOn'),
      lutBOn: gl.getUniformLocation(prog, 'uLutBOn')
    };
    this.tex = [this._makeVideoTexture(), this._makeVideoTexture()];
    this.emptyTex = this._makeVideoTexture();
    this.emptyLut = this._makeIdentityLut();
  }

  _makeIdentityLut() {
    const gl = this.gl;
    const n = LUT_SIZE;
    const data = new Uint8Array(n * n * n * 4);
    let o = 0;
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          data[o++] = Math.round((r / (n - 1)) * 255);
          data[o++] = Math.round((g / (n - 1)) * 255);
          data[o++] = Math.round((b / (n - 1)) * 255);
          data[o++] = 255;
        }
      }
    }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }

  _makeVideoTexture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _initVideos() {
    this.host = document.createElement('div');
    // 2026-11-21：原来是 display:none。部分 Chrome 版本会因此推迟/跳过视频解码，
    // 结果 <video> 一直 readyState<2 —— 恰好就是「预览整块黑、还不报错」的现场。
    // 改成「移出视口但仍在布局中」，浏览器就会正常解码首帧。
    this.host.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;'
      + 'overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(this.host);
    this.slots = [0, 1].map(() => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      // 注意：crossOrigin 不在这里固定成 anonymous，改到 _cue() 里按「是否跨域」决定。
      // 同源媒体强制走 CORS 模式没有任何好处，反而在个别浏览器/扩展组合下会让
      // <video> 直接加载失败（表现为预览黑屏）。
      v.style.display = 'none';
      v.addEventListener('error', () => {
        const e = v.error;
        // 只传 ASCII 错误码，文案交给 i18n（strict 模式禁止代码内硬编码中文）。
        const code = e ? String(e.code) : 'unknown';
        if (this.opts.onError) {
          this.opts.onError(tr('editor.preview.mediaLoadCode', { src: v.currentSrc || '', code }));
        }
      });
      this.host.appendChild(v);
      return { video: v, src: null, lutKey: null, lutTex: null, lutTimer: null, ready: false };
    });
    this.active = 0;
    this.ctxLost = false;
  }

  // ---------- 音频（音乐/环境音两轨） ----------
  _initAudio() {
    this.audioEls = [0, 1].map(() => {
      const a = document.createElement('audio');
      a.preload = 'auto';
      a.loop = true;
      a.style.display = 'none';
      this.host.appendChild(a);
      return a;
    });
  }

  // 2026-11-22：预览听到「成片自带音频」（导出保留原声时才启用）。
  // 声音由两个 <video> 元素本身承载；转场时按叠化比例交叉淡化，避免两轨同时出声。
  // 注意 HTMLMediaElement.volume 上限是 1：工程里设到 1.5 时预览按 1 播放（导出仍按 1.5 混）。
  setSourceAudio(cfg) {
    const c = cfg || {};
    const vol = Number(c.volume);
    this.sourcePlan = {
      enabled: c.enabled === true,
      volume: Number.isFinite(vol) ? Math.max(0, Math.min(1.5, vol)) : 1
    };
    for (const s of (this.slots || [])) {
      if (!s || !s.video) continue;
      s.video.muted = !this.sourcePlan.enabled;
      try { s.video.volume = Math.min(1, this.sourcePlan.volume); } catch (e) { /* ignore */ }
    }
    if (!this.playing) this._render();
  }

  setAudio(plan, filmDuration) {
    this.filmDuration = Number(filmDuration) > 0 ? Number(filmDuration) : this.duration;
    const list = [plan && plan.music, plan && plan.ambient];
    for (let i = 0; i < 2; i++) {
      const item = list[i] || null;
      const a = this.audioEls[i];
      if (!a) continue;
      if (!item || !item.url) {
        if (this.audioPlan[i]) { try { a.pause(); } catch (e) { /* ignore */ } }
        this.audioPlan[i] = null;
        continue;
      }
      if (a.dataset.url !== item.url) {
        a.dataset.url = item.url;
        a.src = item.url;
        try { a.load(); } catch (e) { /* ignore */ }
      }
      this.audioPlan[i] = item;
      a.volume = this._audioVolume(item);
      this._syncAudio(i, this.playing);
    }
  }

  _audioTarget(item) {
    const inSec = Math.max(0, Number(item.inSec) || 0);
    const outSec = Number(item.outSec) > inSec ? Number(item.outSec) : 0;
    const len = outSec > inSec ? outSec - inSec : 0;
    const g = Math.max(0, this.global || 0);
    return inSec + (len > 0 ? (g % len) : g);
  }

  _syncAudio(i, play) {
    const item = this.audioPlan[i];
    const a = this.audioEls[i];
    if (!item || !a) return;
    try { a.currentTime = this._audioTarget(item); } catch (e) { /* ignore */ }
    a.volume = this._audioVolume(item);
    if (play) a.play().catch(() => {});
  }

  _syncAllAudio(play) {
    for (let i = 0; i < 2; i++) this._syncAudio(i, play);
  }

  _pauseAudio() {
    for (const a of this.audioEls) { try { a.pause(); } catch (e) { /* ignore */ } }
  }

  _audioVolume(item) {
    const base = Math.max(0, Math.min(1, item.volume === undefined ? 1 : Number(item.volume)));
    const g = Math.max(0, this.global || 0);
    const D = this.duration || this.filmDuration || 0;
    let f = 1;
    const fi = Math.max(0, Number(item.fadeIn) || 0);
    const fo = Math.max(0, Number(item.fadeOut) || 0);
    if (fi > 0 && g < fi) f = Math.min(f, g / fi);
    if (fo > 0 && D > 0 && g > D - fo) f = Math.min(f, Math.max(0, (D - g) / fo));
    return Math.max(0, Math.min(1, base * f));
  }

  _updateAudioVolumes() {
    for (let i = 0; i < 2; i++) {
      const item = this.audioPlan[i];
      if (item && this.audioEls[i]) this.audioEls[i].volume = this._audioVolume(item);
    }
  }

  _checkAudioDrift() {
    for (let i = 0; i < 2; i++) {
      const item = this.audioPlan[i];
      const a = this.audioEls[i];
      if (!item || !a || a.paused) continue;
      const target = this._audioTarget(item);
      if (Math.abs(a.currentTime - target) > 0.35) {
        try { a.currentTime = target; } catch (e) { /* ignore */ }
      }
    }
  }

  // ---------- 片段 ----------
  setSegments(segments, options = {}) {
    const list = (segments || []).filter((s) => s && s.url && Number(s.outSec) > Number(s.inSec));
    const starts = [];
    let acc = 0;
    for (const s of list) {
      starts.push(acc);
      acc += Math.max(0, Number(s.outSec) - Number(s.inSec));
    }
    // 只有调节参数/转场变化时，不重置视频（避免 seek 把画面刷黑）
    const same = this.segments.length === list.length && this.segments.every((s, i) => (
      s.url === list[i].url
      && Number(s.inSec) === Number(list[i].inSec)
      && Number(s.outSec) === Number(list[i].outSec)
    ));
    this.segments = list;
    this.starts = starts;
    this.duration = acc;
    this.transition = Number(options.transition) > 0 ? Number(options.transition) : FALLBACK_F;
    const keep = Math.min(this.global, Math.max(0, acc - 0.01));
    this.index = this._indexAt(keep);
    this.global = keep;
    if (same) {
      const seg = this._seg();
      if (seg) this._ensureLut(this.active, seg);
      this._render();
      this._armWatchdog();
      return;
    }
    if (this.playing) this._startAt(keep);
    else this.seek(keep);
    this._armWatchdog();
  }

  // ---------- 静默黑屏看门狗 ----------
  _clearWatchdog() {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
  }

  _armWatchdog() {
    this._clearWatchdog();
    if (this.destroyed || !this.segments.length) return;
    const armedAt = this.framesDrawn;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.destroyed || this.framesDrawn > armedAt) return;
      const seg = this._seg();
      if (!seg) return;
      if (!this.recoveredOnce) {
        this.recoveredOnce = true;
        // 自动救一次：换 cache-buster 重载（命中「缓存里存了坏响应」这类现场）。
        const slot = this.slots[this.active];
        slot.src = null;
        this._cue(0, { ...seg, url: bustUrl(seg.url) }, this._localOf(this.global))
          .then(() => {
            if (this.destroyed) return;
            this._render();
            this._armWatchdog();
          })
          .catch(() => {});
        return;
      }
      this._reportNoFrame(seg);
    }, NO_FRAME_WATCHDOG_MS);
  }

  // 把「为什么没画面」讲清楚：先分清是取不到文件（HTTP）还是取到了解不出帧（解码/readyState）。
  // 注意：这里只组装 ASCII 诊断值，任何面向用户的自然语言都走 i18n（strict 扫描要求）。
  async _reportNoFrame(seg) {
    if (this.destroyed) return;
    const slot = this.slots[this.active];
    const v = slot && slot.video;
    const videoError = v && v.error ? ('MEDIA_ERR ' + v.error.code) : 'none';
    let http = 'n/a';
    try {
      const r = await fetch(seg.url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Range: 'bytes=0-1' }
      });
      http = 'HTTP ' + r.status + ' ' + (r.headers.get('content-type') || '');
    } catch (e) {
      http = 'probe-error: ' + (e && e.message ? e.message : e);
    }
    if (this.destroyed) return;
    if (this.opts.onError) {
      this.opts.onError(tr('editor.preview.noFrame', {
        http: http.trim(),
        readyState: v ? v.readyState : -1,
        videoError,
        src: (v && (v.currentSrc || v.src)) || seg.url
      }));
    }
  }

  _indexAt(t) {
    if (!this.segments.length) return 0;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (t >= this.starts[i]) return i;
    }
    return 0;
  }

  _seg() {
    return this.segments[this.index] || null;
  }

  _localOf(t) {
    const seg = this._seg();
    if (!seg) return 0;
    return Math.max(0, Math.min(Number(seg.outSec) - Number(seg.inSec), t - this.starts[this.index]));
  }

  // ---------- 播放控制 ----------
  play() {
    if (!this.segments.length) return;
    this.playing = true;
    this._syncAllAudio(true);
    this._startAt(this.global);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const s of this.slots) { try { s.video.pause(); } catch (e) { /* ignore */ } }
    this._pauseAudio();
    this._render();
  }

  seek(t) {
    if (!this.segments.length) return;
    const clamped = Math.max(0, Math.min(this.duration - 0.01, Number(t) || 0));
    this.global = clamped;
    this.index = this._indexAt(clamped);
    const local = this._localOf(clamped);
    this.active = 0;
    try { this.slots[1].video.pause(); } catch (e) { /* ignore */ }
    this._cue(0, this._seg(), local).then(() => {
      if (!this.destroyed) this._render();
    });
    this._syncAllAudio(this.playing);
    this._emitTime(clamped, true);
    this._render();
    setTimeout(() => { if (!this.destroyed && !this.playing) this._render(); }, 120);
    setTimeout(() => { if (!this.destroyed && !this.playing) this._render(); }, 400);
  }

  destroy() {
    this.destroyed = true;
    this._clearWatchdog();
    this.pause();
    this._pauseAudio();
    window.removeEventListener('resize', this._onResize);
    if (this.ro) { try { this.ro.disconnect(); } catch (e) { /* ignore */ } }
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
    try {
      const gl = this.gl;
      for (const t of this.texCache.values()) gl.deleteTexture(t);
      this.texCache.clear();
    } catch (e) { /* ignore */ }
  }

  // ---------- 内部 ----------
  _startAt(t) {
    cancelAnimationFrame(this.raf);
    this.index = this._indexAt(t);
    this.active = 0;
    try { this.slots[1].video.pause(); } catch (e) { /* ignore */ }
    const local = this._localOf(t);
    this._cue(0, this._seg(), local).then(() => {
      if (this.destroyed || !this.playing) return;
      this._loop();
    });
  }

  async _cue(slotIdx, seg, offset) {
    if (!seg) return;
    const slot = this.slots[slotIdx];
    const v = slot.video;
    if (slot.src !== seg.url) {
      slot.src = seg.url;
      slot.lutKey = null;
      slot.lutTex = null;
      slot.ready = false;
      v.src = seg.url;
      // 2026-11-21：只有真正跨域的素材才开 CORS 模式。
      // 同源（本站 /output/*）若仍写 crossOrigin='anonymous'，浏览器会按 CORS 模式取流，
      // 一旦响应没带 Access-Control-Allow-Origin（登录墙中间件/代理转发很容易漏），
      // <video> 就静默失败 → 预览黑屏。同源本来就不需要它。
      let sameOrigin = true;
      try {
        sameOrigin = new URL(seg.url, window.location.href).origin === window.location.origin;
      } catch (e) { sameOrigin = true; }
      if (sameOrigin) v.removeAttribute('crossorigin');
      else v.crossOrigin = 'anonymous';
      // 等到「真的有可绘制帧」（loadeddata → readyState>=2）再往下走。
      // 2026-11-21：原来只等 loadedmetadata 就立刻 seek + 渲染，元数据到了但帧还没解码时
      // _upload 会直接 return（readyState<2），画布就停在全黑 —— 且全程不报错。
      // 这里只把 loadeddata / error 当作完成信号；metadata 不再提前放行。
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          v.removeEventListener('loadeddata', finish);
          v.removeEventListener('error', finish);
          clearTimeout(timer);
          resolve();
        };
        v.addEventListener('loadeddata', finish, { once: true });
        v.addEventListener('error', finish, { once: true });
        const timer = setTimeout(finish, 5000);
      });
    }
    const target = Math.max(0, Math.min(Number(seg.outSec) || 0, (Number(seg.inSec) || 0) + offset));
    // seek 完成后浏览器可能晚一点才把帧准备好；补一次渲染，避免「第一帧永远没上屏」。
    v.addEventListener('seeked', () => {
      if (!this.destroyed && !this.playing) this._render();
    }, { once: true });
    try {
      if (Math.abs(v.currentTime - target) > 0.08) v.currentTime = target;
    } catch (e) { /* ignore */ }
    slot.ready = true;
    this._ensureLut(slotIdx, seg);
    if (this.playing) { try { v.play().catch(() => {}); } catch (e) { /* ignore */ } }
  }

  _ensureLut(slotIdx, seg) {
    if (!seg) return;
    const slot = this.slots[slotIdx];
    const adjust = seg.adjust || null;
    const key = JSON.stringify(adjust || {});
    if (slot.lutKey === key) return;
    slot.lutKey = key;
    slot.lutAdjust = adjust;
    if (!hasAdjust(adjust)) {
      if (slot.lutTimer) { clearTimeout(slot.lutTimer); slot.lutTimer = null; }
      slot.lutTex = null;
      slot.lutApplied = key;
      return;
    }
    if (this.texCache.has(key)) {
      slot.lutTex = this.texCache.get(key);
      slot.lutApplied = key;
      return;
    }
    // 拖动滑杆时限流：最多每 120ms 取一次最新参数，既跟手又不会每帧重建 LUT
    if (slot.lutTimer) return;
    slot.lutTimer = setTimeout(() => {
      slot.lutTimer = null;
      const k = slot.lutKey;
      const a = slot.lutAdjust;
      if (!k || k === slot.lutApplied) return;
      if (this.texCache.has(k)) {
        slot.lutTex = this.texCache.get(k);
        slot.lutApplied = k;
        if (!this.playing) this._render();
        return;
      }
      fetchLut(a).then((data) => {
        if (this.destroyed || slot.lutKey !== k) return;
        if (!data) return;
        const tex = this._makeLutTexture(data);
        this.texCache.set(k, tex);
        slot.lutTex = tex;
        slot.lutApplied = k;
        if (!this.playing) this._render();
      });
    }, 120);
  }

  _makeLutTexture(data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }

  _loop() {
    if (!this.playing || this.destroyed) return;
    const step = () => {
      if (!this.playing || this.destroyed) return;
      const seg = this._seg();
      if (!seg) { this.pause(); return; }
      const slot = this.slots[this.active];
      const v = slot.video;
      const local = v.readyState >= 2 ? Math.max(0, v.currentTime - Number(seg.inSec)) : this._localOf(this.global);
      const dur = Number(seg.outSec) - Number(seg.inSec);
      if (local >= dur - 0.02) {
        if (this.index >= this.segments.length - 1) {
          this.global = this.duration;
          this.playing = false;
          for (const s of this.slots) { try { s.video.pause(); } catch (e) { /* ignore */ } }
          this._emitTime(this.duration, true);
          this._render();
          if (this.opts.onEnd) this.opts.onEnd();
          return;
        }
        this.index += 1;
        const newActive = 1 - this.active;
        const nextSeg = this._seg();
        const slot = this.slots[newActive];
        this.active = newActive;
        this.global = this.starts[this.index];
        // 叠化窗口里下一段已经在播；没有叠化时才需要从头 cue
        if (!(slot.src === nextSeg.url && slot.video.readyState >= 2)) {
          this._cue(newActive, nextSeg, 0);
        }
        this.raf = requestAnimationFrame(step);
        return;
      }
      this.global = this.starts[this.index] + local;
      this._emitTime(this.global);
      this._checkAudioDrift();
      this._render();
      this.raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(step);
  }

  _emitTime(t, force) {
    const now = performance.now();
    if (!force && now - this.lastEmit < 200) return;
    this.lastEmit = now;
    if (this.opts.onTime) this.opts.onTime(t);
  }

  _render() {
    try {
      this._draw();
    } catch (e) {
      if (this.opts.onError) this.opts.onError(tr('editor.preview.renderFailed', { msg: e && e.message ? e.message : e }));
    }
  }

  _draw() {
    const gl = this.gl;
    this._updateAudioVolumes();
    const seg = this._seg();
    if (!seg) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    // 2026-11-22：位图按「显示尺寸 × DPR」建，16:9 内容用 viewport 居中 letterbox。
    // 旧实现把位图算成 960x540(或 w*9/16) 再由 CSS 拉伸：框不是 16:9 时画面被压扁/偏移
    // （实测 bitmap 858x483 被塞进 858x398 的显示尺寸）。
    const cssW = Math.max(340, Math.floor(this.canvas.clientWidth || 960));
    const cssH = Math.max(190, Math.floor(this.canvas.clientHeight || Math.round(cssW * 9 / 16)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.min(1920, Math.round(cssW * dpr));
    const h = Math.min(1080, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // 黑底 + 居中 letterbox：保证任何容器比例下画面都完整居中、不变形。
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let vw = w;
    let vh = Math.round(w * 9 / 16);
    if (vh > h) { vh = h; vw = Math.round(h * 16 / 9); }
    gl.viewport(Math.round((w - vw) / 2), Math.round((h - vh) / 2), vw, vh);

    const a = this.slots[this.active];
    const next = this.segments[this.index + 1];
    const local = this._localOf(this.global);
    const dur = Number(seg.outSec) - Number(seg.inSec);
    const F = Math.min(this.transition, dur / 2);
    let mix = 0;
    let b = null;
    if (next && local > dur - F) {
      mix = Math.max(0, Math.min(1, (local - (dur - F)) / Math.max(0.01, F)));
      b = this.slots[1 - this.active];
      if (this.playing) {
        this._cue(1 - this.active, next, Math.max(0, local - (dur - F)));
      }
    }

    // 原声与画面走同一条叠化曲线：旧 slot 1→0、新 slot 0→1，避免接缝处两轨同时出声。
    if (this.sourcePlan && this.sourcePlan.enabled) {
      const base = Math.min(1, this.sourcePlan.volume);
      try { a.video.volume = Math.max(0, base * (1 - mix)); } catch (e) { /* ignore */ }
      try { if (b) b.video.volume = Math.max(0, base * mix); } catch (e) { /* ignore */ }
    }

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    this._upload(a, 0);
    this._upload(b, 1);
    // 只有真正有帧可画时才计数；看门狗据此判断「一直没取到画面」。
    if (a && a.video.readyState >= 2) this.framesDrawn += 1;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
    gl.uniform1i(this.u.texA, 0);
    gl.uniform1i(this.u.texB, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, a.lutTex || this.emptyLut);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, (b && b.lutTex) || this.emptyLut);
    gl.uniform1i(this.u.lutA, 2);
    gl.uniform1i(this.u.lutB, 3);
    gl.uniform1i(this.u.lutAOn, a.lutTex ? 1 : 0);
    gl.uniform1i(this.u.lutBOn, b && b.lutTex ? 1 : 0);
    gl.uniform1f(this.u.mix, mix);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _upload(slot, idx) {
    if (!slot) return;
    const gl = this.gl;
    const v = slot.video;
    if (v.readyState < 2) return;
    gl.activeTexture(gl.TEXTURE0 + idx);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[idx]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    } catch (e) { /* 视频帧不可用，保留上一帧 */ }
  }
}
