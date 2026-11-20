// ============================================================
// 配乐编辑器（新版前端，2026-11-02）
// ------------------------------------------------------------
// 入口：
//   /app/bgm              已完成成片列表（选一条进入）
//   /app/bgm/<taskId>     直接进入某条成片的编辑态，刷新可直达
// 左侧导航「配乐编辑器」与库存「配乐」页都有入口。
//
// 后端契约（只调用，不改后端）：
//   GET  /api/tasks/completed          已完成任务（含 hasBgm / totalDuration）
//   GET  /api/tasks/:id/bgm-plan       读计划 + 成片 URL + 时长
//   PUT  /api/tasks/:id/bgm-plan       保存计划（后端 _normalizePlan 会校验/夹取）
//   POST /api/tasks/:id/bgm-auto-plan  生成自动配乐草稿（不落库，单独点保存才落）
//   POST /api/tasks/:id/bgm-preview    预览（dryRun，不覆盖成片）
//   POST /api/tasks/:id/audio          导出（覆盖成片；本页二次确认）
//   GET  /api/bgm                      曲库（含 music / ambient 分类）
//   GET  /api/bgm/waveform/:id         服务端算好的波形峰值（0..255）
//
// 与旧版 public/bgm-editor.html 的差异（刻意）：
//   - 只迁「成片配乐」这一半能力；旧页的「从片段库拼新成片/生成母版」不在本页，
//     属于另一会话/另一任务的范围。
//   - 不做本地音频上传 UI：POST /api/bgm 当前只收元信息且受体积限制。
//   - 旧页的关键帧编辑未迁；已有关键帧数据在保存时原样保留，不会丢。
// ============================================================
import { navigate } from '../router.js';
import { t as tr } from '../i18n/index.js';
import { taskPromptSummary } from '../components/taskName.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useMemo, useRef, useState } = React;

const MIN_SEG = 0.1;            // min segment 0.1s, same as the legacy editor
const RULER_H = 24;
const VIDEO_LANE_H = 34;
const AUDIO_LANE_H = 56;
const EMPTY_PLAN = () => ({ music: [], ambient: [] });
const EMPTY_SIG = JSON.stringify(EMPTY_PLAN());
const MONO = "'SF Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace";

// ---------------- 小工具 ----------------
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || 0));
}
function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}
function fmtNum(n) {
  return String(round3(n));
}
function fmtClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const ss = s - m * 60;
  return m + ':' + (ss < 10 ? '0' : '') + ss.toFixed(1);
}
function fmtTick(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}
function withBust(url, version) {
  if (!url || !version) return url || null;
  return url + (url.includes('?') ? '&' : '?') + 't=' + version;
}
function taskIdFromRoute(route) {
  const m = /^\/bgm\/([^/?#]+)/.exec(route || '');
  return m ? decodeURIComponent(m[1]) : null;
}
function trackKind(track) {
  return track && track.category === 'ambient' ? 'ambient' : 'music';
}

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON response: treat as empty */ }
  if (!res.ok) {
    const msg = data && (data.error || data.message);
    throw new Error(msg || ('HTTP ' + res.status));
  }
  return data;
}

// 计划规范化：字段与后端 pipeline._normalizePlan 对齐。
// 关键点：保留 keyframes（页面不编辑，但保存时必须原样带回，否则会丢旧数据）。
function normalizePlan(raw) {
  const cleanLane = (list) => (Array.isArray(list) ? list : []).map((s, i) => ({
    id: String(s.id || ('seg' + i)),
    trackId: String(s.trackId || ''),
    timelineStart: Number(s.timelineStart) || 0,
    timelineEnd: Number(s.timelineEnd) || 0,
    sourceIn: Number(s.sourceIn) || 0,
    sourceOut: Number(s.sourceOut) || 0,
    volume: Number.isFinite(Number(s.volume)) ? Number(s.volume) : 1,
    fadeIn: Number(s.fadeIn) || 0,
    fadeOut: Number(s.fadeOut) || 0,
    speed: Number.isFinite(Number(s.speed)) ? Number(s.speed) : 1,
    fillMode: ['none', 'loop', 'stretch'].includes(s.fillMode) ? s.fillMode : 'none',
    keyframes: Array.isArray(s.keyframes) ? s.keyframes : []
  }));
  return {
    music: cleanLane(raw && raw.music),
    ambient: cleanLane(raw && raw.ambient)
  };
}
function planSignature(plan) {
  return JSON.stringify({ music: plan.music || [], ambient: plan.ambient || [] });
}
function segmentCount(plan) {
  return (plan.music || []).length + (plan.ambient || []).length;
}
function laneCoverage(plan) {
  let end = 0;
  for (const s of [...(plan.music || []), ...(plan.ambient || [])]) {
    end = Math.max(end, Number(s.timelineEnd) || 0);
  }
  return end;
}
function findSegment(plan, sel) {
  if (!sel) return null;
  const lane = plan[sel.kind] || [];
  const clip = lane.find((s) => s.id === sel.id);
  return clip ? { kind: sel.kind, clip } : null;
}

// ---------------- 波形 ----------------
// 服务端用 ffmpeg 算好峰值（0..255）。结果按 trackId 缓存在模块作用域，
// 同一曲目被多个片段引用时只请求一次；失败也缓存，避免反复打接口。
const waveCache = new Map();
function loadPeaks(trackId) {
  if (waveCache.has(trackId)) return waveCache.get(trackId);
  const p = api('/api/bgm/waveform/' + encodeURIComponent(trackId))
    .then((d) => ({
      peaks: d && Array.isArray(d.peaks) ? d.peaks : [],
      durationSec: Number(d && d.durationSec) || 0,
      reason: d && d.ok === false ? (d.error || tr('bgm.waveDataUnavailable')) : ''
    }))
    .catch((e) => ({ peaks: [], durationSec: 0, reason: e.message }));
  waveCache.set(trackId, p);
  return p;
}

function drawWave(canvas, peaks, opts) {
  if (!canvas) return;
  const host = canvas.parentElement;
  const w = Math.max(1, Math.round(canvas.clientWidth || (host ? host.clientWidth : 0) || 0));
  const h = Math.max(1, Math.round(canvas.clientHeight || (host ? host.clientHeight : 0) || 0));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  const list = peaks || [];

  if (!list.length) {
    // 没有波形也能编辑：画一条虚线中轴，并靠 title 说明原因。
    ctx.strokeStyle = 'rgba(167,179,173,.30)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const srcDur = Number(opts.trackDuration) > 0 ? Number(opts.trackDuration) : list.length;
  const from = Math.max(0, Number(opts.sourceIn) || 0) / srcDur;
  const to = Math.max(from, (Number(opts.sourceOut) || srcDur) / srcDur);
  const startIdx = Math.floor(from * list.length);
  const endIdx = Math.min(list.length, Math.max(startIdx + 1, Math.ceil(to * list.length)));
  const span = Math.max(1, endIdx - startIdx);
  const color = opts.kind === 'ambient' ? 'rgba(158,190,170,.80)' : 'rgba(214,179,106,.80)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  for (let x = 0; x < w; x++) {
    const i0 = startIdx + Math.floor((x / w) * span);
    const i1 = startIdx + Math.max(1, Math.floor(((x + 1) / w) * span));
    let amp = 0;
    for (let i = i0; i < i1 && i < list.length; i++) {
      const v = Number(list[i]) || 0;
      if (v > amp) amp = v;
    }
    if (amp <= 0) continue;
    const half = Math.max(0.5, (amp / 255) * (h / 2 - 4));
    ctx.beginPath();
    ctx.moveTo(x + 0.5, mid - half);
    ctx.lineTo(x + 0.5, mid + half);
    ctx.stroke();
  }
}

// ---------------- 数字输入 ----------------
// 受控 text + 失焦/回车提交：避免 type=number 在输入中间态（如 "1."）被抢值。
function NumField({ label, value, min, max, step, onCommit }) {
  const [text, setText] = useState(fmtNum(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(fmtNum(value));
  }, [value]);

  const commit = () => {
    focused.current = false;
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(fmtNum(value));
      return;
    }
    const v = round3(clamp(n, min, max));
    setText(fmtNum(v));
    onCommit(v);
  };

  return html`
    <label className="bgm-field">
      <span>${label}</span>
      <input
        type="number"
        min=${min}
        max=${max}
        step=${step}
        value=${text}
        onFocus=${() => { focused.current = true; }}
        onInput=${(e) => setText(e.target.value)}
        onBlur=${commit}
        onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </label>
  `;
}

// ---------------- 单个片段块（波形 + 拖动/裁剪） ----------------
function ClipBlock({ clip, kind, track, pxPerSec, selected, duration, onSelect, onDragMove, onDragEnd }) {
  const nodeRef = useRef(null);
  const canvasRef = useRef(null);
  const [wave, setWave] = useState({ peaks: null, durationSec: 0, reason: '' });

  useEffect(() => {
    let alive = true;
    if (!clip.trackId) return undefined;
    loadPeaks(clip.trackId).then((r) => { if (alive) setWave(r); });
    return () => { alive = false; };
  }, [clip.trackId]);

  const widthPx = Math.max(8, (clip.timelineEnd - clip.timelineStart) * pxPerSec);

  useEffect(() => {
    const paint = () => drawWave(canvasRef.current, wave.peaks, {
      kind,
      trackDuration: wave.durationSec || (track && Number(track.durationSec)) || 0,
      sourceIn: clip.sourceIn || 0,
      sourceOut: clip.sourceOut || 0
    });
    paint();
    const timer = setTimeout(paint, 80); // repaint once layout settles
    return () => clearTimeout(timer);
  }, [wave, kind, clip.sourceIn, clip.sourceOut, widthPx, track]);

  const trackTitle = track ? (track.title || track.id) : clip.trackId;
  const tags = [];
  if (Number(clip.speed) !== 1) tags.push(clip.speed + '×');
  if (clip.fillMode === 'loop') tags.push(tr('bgm.clipLoop'));
  if (clip.fillMode === 'stretch') tags.push(tr('bgm.clipStretch'));
  if (Number(clip.volume) !== 1) tags.push(tr('bgm.clipVolume', { n: clip.volume }));
  const name = trackTitle + (tags.length ? ' · ' + tags.join(' · ') : '');
  const titleText = name + '\n' + fmtClock(clip.timelineStart) + ' → ' + fmtClock(clip.timelineEnd)
    + (wave.reason ? '\n' + tr('bgm.waveUnavailable', { reason: wave.reason }) : '');

  // 拖动/裁剪：每次指针移动都换算成「基于按下时原值」的绝对 patch，
  // 交给上层写进 plan（因此数值输入框会同步刷新，拖拽与输入天然一致）。
  // 用 rAF 合并高频 pointermove，避免一次拖动触发上百次渲染。
  function beginDrag(mode) {
    return (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect();
      const startX = e.clientX;
      const orig = {
        s: Number(clip.timelineStart) || 0,
        e: Number(clip.timelineEnd) || 0,
        sin: Number(clip.sourceIn) || 0,
        sout: Number(clip.sourceOut) || 0
      };
      const speed = Number(clip.speed) || 1;
      const len = Math.max(MIN_SEG, orig.e - orig.s);
      const maxEnd = duration > 0 ? duration : 1e6;
      let moved = false;
      let raf = 0;
      let pending = null;

      const compute = (clientX) => {
        const dt = (clientX - startX) / pxPerSec;
        if (mode === 'move') {
          // 整体平移：保持时长；两端都夹在 [0, 成片时长] 内
          const hi = Math.max(0, maxEnd - len);
          const ns = round3(clamp(orig.s + dt, 0, hi));
          const ne = round3(ns + len);
          return {
            patch: { timelineStart: ns, timelineEnd: ne },
            info: { mode, start: ns, end: ne, sourceIn: orig.sin, sourceOut: orig.sout }
          };
        }
        if (mode === 'left') {
          // 左裁剪：timelineStart 与 sourceIn 同增量；最短 0.1s；sourceIn 不落负
          const ns = round3(clamp(orig.s + dt, 0, Math.max(0, orig.e - MIN_SEG)));
          const d = ns - orig.s;
          const sin = round3(Math.max(0, orig.sin + d * speed));
          return {
            patch: { timelineStart: ns, sourceIn: sin },
            info: { mode, start: ns, end: orig.e, sourceIn: sin, sourceOut: orig.sout }
          };
        }
        // 右裁剪：timelineEnd 与 sourceOut 同增量；最短 0.1s；不超出成片时长
        const lo = orig.s + MIN_SEG;
        const ne = round3(clamp(orig.e + dt, lo, Math.max(lo, maxEnd)));
        const d = ne - orig.e;
        const sout = round3(Math.max(orig.sin + MIN_SEG, orig.sout + d * speed));
        return {
          patch: { timelineEnd: ne, sourceOut: sout },
          info: { mode, start: orig.s, end: ne, sourceIn: orig.sin, sourceOut: sout }
        };
      };

      const isValid = (r) => !!r
        && Object.values(r.patch).every((v) => Number.isFinite(v))
        && Object.values(r.info).every((v) => typeof v === 'string' || Number.isFinite(v));

      const flush = () => {
        raf = 0;
        if (!pending) return;
        const r = pending;
        pending = null;
        onDragMove(r.patch, r.info);
      };

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 2) return; // within 2px counts as a click, plan unchanged
        const r = compute(ev.clientX);
        if (!isValid(r)) return;
        moved = true;
        pending = r;
        if (!raf) raf = requestAnimationFrame(flush);
      };

      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
          pending = null;
        }
        if (!moved) return;
        const r = compute(ev.clientX);
        if (!isValid(r)) return;
        onDragEnd(r.patch, r.info);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }

  return html`
    <div
      ref=${nodeRef}
      className=${'bgm-clip ' + kind + (selected ? ' selected' : '')}
      style=${{ left: (clip.timelineStart * pxPerSec) + 'px', width: widthPx + 'px' }}
      title=${titleText}
      onPointerDown=${beginDrag('move')}
    >
      <canvas ref=${canvasRef}></canvas>
      <div className="bgm-clip-name">${name}</div>
      <div className="bgm-clip-handle left" onPointerDown=${beginDrag('left')} title=${tr('bgm.dragLeftEdge')}></div>
      <div className="bgm-clip-handle right" onPointerDown=${beginDrag('right')} title=${tr('bgm.dragRightEdge')}></div>
    </div>
  `;
}

// ---------------- 时间轴 ----------------
function Timeline({
  plan, trackMap, duration, pxPerSec, playhead, selection, scrollRef,
  previewActive, dragInfo, onSeek, onSelect, onUpdate, onDragMove, onDragEnd, onZoom, onFit
}) {
  const innerRef = useRef(null);
  const total = duration > 0 ? duration : 60;
  const contentW = Math.max(360, Math.ceil(total * pxPerSec) + 40);
  const durationX = Math.max(4, total * pxPerSec);

  const step = useMemo(() => {
    if (pxPerSec >= 80) return 1;
    if (pxPerSec >= 40) return 2;
    if (pxPerSec >= 20) return 5;
    if (pxPerSec >= 10) return 10;
    return 30;
  }, [pxPerSec]);

  const ticks = useMemo(() => {
    const out = [];
    for (let t = 0; t <= total + 0.001; t += step) out.push(t);
    return out;
  }, [total, step]);

  const secAt = (clientX) => {
    const el = innerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return clamp((clientX - rect.left) / pxPerSec, 0, total);
  };

  const startScrub = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    onSeek(secAt(e.clientX));
    const move = (ev) => onSeek(secAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const playX = clamp(playhead, 0, total) * pxPerSec;
  const coverage = laneCoverage(plan);
  const laneClips = (kind) => (plan[kind] || []).map((clip) => html`
    <${ClipBlock}
      key=${kind + ':' + clip.id}
      clip=${clip}
      kind=${kind}
      track=${trackMap.get(clip.trackId)}
      pxPerSec=${pxPerSec}
      selected=${!!(selection && selection.kind === kind && selection.id === clip.id)}
      duration=${duration}
      onSelect=${() => onSelect(kind, clip.id)}
      onDragMove=${(patch, info) => onDragMove(kind, clip.id, patch, info)}
      onDragEnd=${(patch, info) => onDragEnd(kind, clip.id, patch, info)}
    />
  `);

  return html`
    <section className="bgm-tl">
      <div className="bgm-tl-head">
        <span className="bgm-tl-title">${tr('bgm.timeline')}</span>
        <span className="bgm-tl-hint">${tr('bgm.timelineHint')}</span>
        ${dragInfo && html`
          <span className="bgm-drag-readout">
            ${dragInfo.mode === 'move' ? tr('bgm.dragMove') : dragInfo.mode === 'left' ? tr('bgm.dragLeft') : tr('bgm.dragRight')}
            <b>${fmtClock(dragInfo.start)} → ${fmtClock(dragInfo.end)}</b>
            ${dragInfo.mode !== 'move' && html`
              <span>${tr('bgm.source', { in: fmtClock(dragInfo.sourceIn), out: fmtClock(dragInfo.sourceOut) })}</span>
            `}
          </span>
        `}
        <span className="bgm-spacer"></span>
        <span className="bgm-tl-stat">
          ${tr('bgm.tlStat', { music: (plan.music || []).length, ambient: (plan.ambient || []).length, coverage: fmtClock(coverage) })}
        </span>
        <button className="bgm-btn sm" onClick=${() => onZoom(1 / 1.4)} title=${tr('bgm.zoomOut')}>−</button>
        <span className="bgm-zoom-label">${Math.round(pxPerSec * 10) / 10} px/s</span>
        <button className="bgm-btn sm" onClick=${() => onZoom(1.4)} title=${tr('bgm.zoomIn')}>＋</button>
        <button className="bgm-btn sm" onClick=${onFit} title=${tr('bgm.fitTitle')}>${tr('bgm.fit')}</button>
      </div>

      <div className="bgm-tl-body">
        <div className="bgm-tl-labels">
          <div className="bgm-ruler-spacer" style=${{ height: RULER_H + 'px' }}></div>
          <div className="bgm-lane-label" style=${{ height: VIDEO_LANE_H + 'px' }}><b>${tr('bgm.videoLane')}</b>${tr('bgm.masterLane')}</div>
          <div className="bgm-lane-label" style=${{ height: AUDIO_LANE_H + 'px' }}><b>${tr('bgm.musicLane')}</b></div>
          <div className="bgm-lane-label" style=${{ height: AUDIO_LANE_H + 'px' }}><b>${tr('bgm.ambientLane')}</b></div>
        </div>

        <div className="bgm-tl-scroll" ref=${scrollRef}>
          <div className="bgm-tl-inner" ref=${innerRef} style=${{ width: contentW + 'px' }}>
            <div
              className="bgm-ruler"
              style=${{ height: RULER_H + 'px' }}
              onPointerDown=${startScrub}
              title=${tr('bgm.rulerTitle')}
            >
              ${ticks.map((t) => html`
                <div key=${'tick' + t} className=${'bgm-tick' + (Math.round(t) % (step * 2) === 0 ? ' major' : '')}
                  style=${{ left: (t * pxPerSec) + 'px' }}>
                  <span>${fmtTick(t)}</span>
                </div>
              `)}
            </div>

            <div className="bgm-lane" style=${{ height: VIDEO_LANE_H + 'px' }} onPointerDown=${startScrub}>
              <div className="bgm-master" style=${{ width: durationX + 'px' }}>
                ${duration > 0 ? tr('bgm.master', { dur: ' · ' + fmtClock(duration) }) : tr('bgm.masterNoDur')}
              </div>
            </div>

            <div className="bgm-lane" style=${{ height: AUDIO_LANE_H + 'px' }} onPointerDown=${startScrub}>
              ${(plan.music || []).length === 0 && html`
                <div className="bgm-lane-empty">${tr('bgm.laneMusicEmpty')}</div>
              `}
              ${laneClips('music')}
            </div>

            <div className="bgm-lane" style=${{ height: AUDIO_LANE_H + 'px' }} onPointerDown=${startScrub}>
              ${(plan.ambient || []).length === 0 && html`
                <div className="bgm-lane-empty">${tr('bgm.laneAmbientEmpty')}</div>
              `}
              ${laneClips('ambient')}
            </div>

            <div className="bgm-endline" style=${{ left: durationX + 'px' }} title=${tr('bgm.endTitle')}></div>
            <div className="bgm-playhead" style=${{ left: playX + 'px' }}></div>
          </div>
        </div>
      </div>

      <div className="bgm-tl-foot">
        <span>${tr('bgm.playhead', { time: fmtClock(playhead) })}</span>
        <span>${tr('bgm.filmDuration', { dur: duration > 0 ? fmtClock(duration) : tr('bgm.durationUnknown') })}</span>
        <span>${previewActive ? tr('bgm.playingPreview') : tr('bgm.playingOriginal')}</span>
        <span>${tr('bgm.footNote')}</span>
      </div>
    </section>
  `;
}

// ---------------- 曲库 ----------------
function LibraryPanel({ lib, cat, setCat, q, setQ, onAdd }) {
  const tracks = (lib.data && lib.data.tracks) || [];
  const counts = { music: 0, ambient: 0 };
  for (const t of tracks) counts[trackKind(t)]++;
  const key = q.trim().toLowerCase();
  const list = tracks.filter((t) => trackKind(t) === cat
    && (!key || (((t.title || '') + ' ' + (t.id || '')).toLowerCase().includes(key))));

  return html`
    <section className="bgm-card">
      <div className="bgm-card-h">
        <span>${tr('bgm.library')}</span>
        <span className="meta">${tr('bgm.tracksCount', { n: tracks.length })}</span>
      </div>
      <div className="bgm-tabs">
        <button className=${'bgm-tab' + (cat === 'music' ? ' active' : '')} onClick=${() => setCat('music')}>
          ${tr('bgm.musicCount', { n: counts.music })}
        </button>
        <button className=${'bgm-tab' + (cat === 'ambient' ? ' active' : '')} onClick=${() => setCat('ambient')}>
          ${tr('bgm.ambientCount', { n: counts.ambient })}
        </button>
        <span className="bgm-spacer"></span>
        <input
          className="bgm-input"
          style=${{ width: '104px', height: '26px', fontSize: '11px' }}
          value=${q}
          placeholder=${tr('bgm.search')}
          onInput=${(e) => setQ(e.target.value)}
        />
      </div>
      <div className="bgm-lib">
        ${lib.loading && html`<div className="bgm-lib-empty">${tr('bgm.libLoading')}</div>`}
        ${!lib.loading && lib.error && html`
          <div className="bgm-lib-empty" style=${{ color: 'var(--danger)' }}>${tr('bgm.libReadFailed', { error: lib.error })}</div>
        `}
        ${!lib.loading && !lib.error && list.length === 0 && html`
          <div className="bgm-lib-empty">${tracks.length ? tr('bgm.libNoMatch') : tr('bgm.libEmpty')}</div>
        `}
        ${!lib.loading && !lib.error && list.map((t) => html`
          <button
            key=${t.id}
            className="bgm-lib-item"
            onClick=${() => onAdd(t)}
            title=${tr('bgm.addTitle', { title: t.title || t.id })}
          >
            <span className="bgm-lib-main">
              <span className="bgm-lib-title">${t.title || t.id}</span>
              <span className="bgm-lib-meta">
                ${t.id} · ${t.durationSec ? tr('bgm.trackDuration', { n: Math.round(t.durationSec) }) : tr('bgm.unknownDuration')}${t.bpm ? tr('bgm.trackBpm', { n: t.bpm }) : ''}
              </span>
            </span>
            <span className="bgm-lib-add">＋</span>
          </button>
        `)}
      </div>
      <div className="bgm-card-b" style=${{ paddingTop: '8px' }}>
        <p className="bgm-note">
          ${tr('bgm.libNote')}
        </p>
      </div>
    </section>
  `;
}

// ---------------- 片段参数 ----------------
function ClipProps({ selected, tracks, trackMap, duration, onUpdate, onDelete, onSeek }) {
  if (!selected) {
    return html`
      <section className="bgm-card">
        <div className="bgm-card-h"><span>${tr('bgm.clipProps')}</span></div>
        <div className="bgm-card-b">
          <p className="bgm-props-empty">
            ${tr('bgm.propsEmpty')}
          </p>
        </div>
      </section>
    `;
  }

  const { kind, clip } = selected;
  const track = trackMap.get(clip.trackId);
  const sameKind = tracks.filter((t) => trackKind(t) === kind);
  const hasCurrent = sameKind.some((t) => t.id === clip.trackId);
  const keyframeCount = Array.isArray(clip.keyframes) ? clip.keyframes.length : 0;
  const upd = (patch) => onUpdate(kind, clip.id, patch);

  return html`
    <section className="bgm-card">
      <div className="bgm-card-h">
        <span>${tr('bgm.clipProps')}</span>
        <span className="meta">${kind === 'ambient' ? tr('bgm.kindAmbient') : tr('bgm.kindMusic')}</span>
      </div>
      <div className="bgm-card-b">
        <div className="bgm-props-head">
          <span className="bgm-props-title" title=${track ? (track.title || track.id) : clip.trackId}>
            ${track ? (track.title || track.id) : clip.trackId}
          </span>
          <span className="bgm-sub">${clip.id}</span>
        </div>

        <div className="bgm-props-grid">
          <label className="bgm-field" style=${{ gridColumn: '1 / -1' }}>
            <span>${tr('bgm.track')}</span>
            <select value=${clip.trackId} onChange=${(e) => upd({ trackId: e.target.value })}>
              ${!hasCurrent && html`<option value=${clip.trackId}>${tr('bgm.trackMissing', { id: clip.trackId })}</option>`}
              ${sameKind.map((t) => html`
                <option key=${t.id} value=${t.id}>${t.title || t.id}</option>
              `)}
            </select>
          </label>

          <${NumField} label=${tr('bgm.timelineStart')} value=${clip.timelineStart}
            min=${0} max=${Math.max(0, clip.timelineEnd - MIN_SEG)} step=${0.1}
            onCommit=${(v) => upd({ timelineStart: v })} />
          <${NumField} label=${tr('bgm.timelineEnd')} value=${clip.timelineEnd}
            min=${clip.timelineStart + MIN_SEG} max=${duration > 0 ? duration : 100000} step=${0.1}
            onCommit=${(v) => upd({ timelineEnd: v })} />
          <${NumField} label=${tr('bgm.sourceIn')} value=${clip.sourceIn}
            min=${0} max=${Math.max(0, clip.sourceOut - MIN_SEG)} step=${0.1}
            onCommit=${(v) => upd({ sourceIn: v })} />
          <${NumField} label=${tr('bgm.sourceOut')} value=${clip.sourceOut}
            min=${clip.sourceIn + MIN_SEG} max=${100000} step=${0.1}
            onCommit=${(v) => upd({ sourceOut: v })} />
          <${NumField} label=${tr('bgm.baseVolume')} value=${clip.volume}
            min=${0} max=${4} step=${0.05}
            onCommit=${(v) => upd({ volume: v })} />
          <${NumField} label=${tr('bgm.speed')} value=${clip.speed}
            min=${0.5} max=${2} step=${0.05}
            onCommit=${(v) => upd({ speed: v })} />
          <${NumField} label=${tr('bgm.fadeIn')} value=${clip.fadeIn}
            min=${0} max=${60} step=${0.1}
            onCommit=${(v) => upd({ fadeIn: v })} />
          <${NumField} label=${tr('bgm.fadeOut')} value=${clip.fadeOut}
            min=${0} max=${60} step=${0.1}
            onCommit=${(v) => upd({ fadeOut: v })} />

          <label className="bgm-field" style=${{ gridColumn: '1 / -1' }}>
            <span>${tr('bgm.fillMode')}</span>
            <select value=${clip.fillMode} onChange=${(e) => upd({ fillMode: e.target.value })}>
              <option value="none">${tr('bgm.fillNone')}</option>
              <option value="loop">${tr('bgm.fillLoop')}</option>
              <option value="stretch">${tr('bgm.fillStretch')}</option>
            </select>
          </label>
        </div>

        <p className="bgm-props-note">
          ${tr('bgm.clipDuration', { dur: fmtClock(clip.timelineEnd - clip.timelineStart), n: keyframeCount })}${keyframeCount ? tr('bgm.keyframesKept') : ''}
        </p>

        <div className="bgm-props-actions">
          <button className="bgm-btn sm" onClick=${() => onSeek(clip.timelineStart)}>${tr('bgm.seekClip')}</button>
          <button className="bgm-btn sm danger" onClick=${() => onDelete(kind, clip.id)}>${tr('bgm.deleteClip')}</button>
        </div>
      </div>
    </section>
  `;
}

// ---------------- 任务列表 ----------------
function TaskPicker({ list, onPick, onReload }) {
  const [q, setQ] = useState('');
  const tasks = (list.data && list.data.tasks) || [];
  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return tasks;
    return tasks.filter((t) => (((t.prompt || '') + ' ' + (t.promptEn || '') + ' ' + t.taskId).toLowerCase().includes(key)));
  }, [tasks, q]);

  return html`
    <div className="bgm-page">
      <div className="bgm-head">
        <h1 className="bgm-title">${tr('bgm.editorTitle')}</h1>
        <span className="bgm-sub">${tr('bgm.listSub', { n: tasks.length })}</span>
        <span className="bgm-spacer"></span>
        <input
          className="bgm-input grow"
          style=${{ maxWidth: '260px' }}
          value=${q}
          placeholder=${tr('bgm.searchTask')}
          onInput=${(e) => setQ(e.target.value)}
        />
        <button className="bgm-btn" onClick=${onReload} disabled=${list.loading}>${tr('bgm.refresh')}</button>
      </div>

      <p className="bgm-note">
        ${tr('bgm.listNote')}
      </p>

      ${list.loading && html`<div className="bgm-loading">${tr('bgm.loadingTasks')}</div>`}
      ${!list.loading && list.error && html`
        <div className="bgm-error">
          ${tr('bgm.loadTasksFailed', { error: list.error })}<br/>
          <button className="bgm-btn" onClick=${onReload}>${tr('bgm.retry')}</button>
        </div>
      `}
      ${!list.loading && !list.error && filtered.length === 0 && html`
        <div className="bgm-loading">
          ${tasks.length ? tr('bgm.noMatch') : tr('bgm.emptyTasks')}
        </div>
      `}
      ${!list.loading && !list.error && filtered.length > 0 && html`
        <div className="bgm-task-grid">
          ${filtered.map((t) => html`
            <button key=${t.taskId} className="bgm-task" onClick=${() => onPick(t.taskId)} title=${tr('bgm.openEditor')}>
              <span className="bgm-task-title">${taskPromptSummary(t, 120) || tr('bgm.noPrompt')}</span>
              <span className="bgm-task-meta">
                <span>${t.totalDuration ? fmtClock(t.totalDuration) : tr('bgm.unknownDuration')}</span>
                <span>${t.resolution || '-'}</span>
                <span>${tr('bgm.clips', { n: t.totalClips || 0 })}</span>
                ${t.completedAt && html`<span>${String(t.completedAt).slice(0, 10)}</span>`}
              </span>
              <span className="bgm-task-foot">
                <span className=${'bgm-badge ' + (t.hasBgm ? 'ok' : 'plain')}>${t.hasBgm ? tr('bgm.hasBgm') : tr('bgm.noBgm')}</span>
                <span className="bgm-sub">${t.taskId}</span>
                <span className="go">${tr('bgm.enter')}</span>
              </span>
            </button>
          `)}
        </div>
      `}
    </div>
  `;
}

// ============================================================
// 主视图
// ============================================================
export function BgmEditorView({ route }) {
  const taskId = taskIdFromRoute(route);

  const [list, setList] = useState({ loading: true, data: null, error: null });
  const [lib, setLib] = useState({ loading: true, data: null, error: null });
  const [task, setTask] = useState(null);
  const [plan, setPlan] = useState(EMPTY_PLAN);
  const [savedSig, setSavedSig] = useState(EMPTY_SIG);
  const [selection, setSelection] = useState(null);
  const [dragInfo, setDragInfo] = useState(null);
  const [status, setStatus] = useState({ kind: '', text: '' });
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState('');
  const [confirmExport, setConfirmExport] = useState(false);
  const [preview, setPreview] = useState({ url: null, sig: null });
  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(24);
  const [videoBust, setVideoBust] = useState(0);
  const [libCat, setLibCat] = useState('music');
  const [libQ, setLibQ] = useState('');

  const videoRef = useRef(null);
  const scrollerRef = useRef(null);
  const fittedRef = useRef(null);
  const busyTimerRef = useRef(null);

  const tracks = (lib.data && lib.data.tracks) || [];
  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const summaryTask = useMemo(
    () => ((list.data && list.data.tasks) || []).find((t) => t.taskId === taskId) || null,
    [list.data, taskId]
  );

  const dirty = planSignature(plan) !== savedSig;
  const hasSegs = segmentCount(plan) > 0;
  const previewActive = !!preview.url;
  const previewStale = !!(preview.url && preview.sig && preview.sig !== planSignature(plan));
  const selected = selection ? findSegment(plan, selection) : null;
  const metaDuration = duration > 0 ? duration : (summaryTask && Number(summaryTask.totalDuration)) || 0;
  const hasBgm = !!(summaryTask && summaryTask.hasBgm) || !!(task && task.bgm && task.bgm.enabled);

  // ---------- 列表 / 曲库 ----------
  async function loadList() {
    setList((s) => ({ ...s, loading: true, error: null }));
    try {
      const d = await api('/api/tasks/completed');
      setList({ loading: false, data: d, error: null });
    } catch (e) {
      setList({ loading: false, data: null, error: e.message });
    }
  }
  async function loadLib() {
    setLib((s) => ({ ...s, loading: true, error: null }));
    try {
      const d = await api('/api/bgm');
      setLib({ loading: false, data: d, error: null });
    } catch (e) {
      setLib({ loading: false, data: null, error: e.message });
    }
  }

  useEffect(() => {
    loadList();
    loadLib();
    // 只在挂载时拉一次；刷新由按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 打开任务 ----------
  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setPlan(EMPTY_PLAN());
      setSavedSig(EMPTY_SIG);
      setSelection(null);
      setDragInfo(null);
      setStatus({ kind: '', text: '' });
      setWarnings([]);
      setPreview({ url: null, sig: null });
      setDuration(0);
      setPlayhead(0);
      setBusy('');
      fittedRef.current = null;
      return undefined;
    }

    let alive = true;
    setBusy('load');
    setStatus({ kind: 'busy', text: tr('bgm.loadingPlan') });
    setConfirmExport(false);
    setTask(null);
    setPlan(EMPTY_PLAN());
    setSavedSig(EMPTY_SIG);
    setSelection(null);
    setDragInfo(null);
    setWarnings([]);
    setPreview({ url: null, sig: null });
    setPlayhead(0);
    fittedRef.current = null;

    api('/api/tasks/' + encodeURIComponent(taskId) + '/bgm-plan')
      .then((d) => {
        if (!alive) return;
        const p = normalizePlan(d && d.plan);
        setTask(d || {});
        setPlan(p);
        setSavedSig(JSON.stringify(p));
        setDuration(Number(d && d.totalDuration) || 0);
        setBusy('');
        setStatus({ kind: '', text: '' });
      })
      .catch((e) => {
        if (!alive) return;
        setBusy('');
        setTask({ error: e.message });
        setStatus({ kind: 'err', text: tr('bgm.loadPlanFailed', { error: e.message }) });
      });

    return () => { alive = false; };
  }, [taskId]);

  // 详情接口没给时长时，退回列表里的 totalDuration（例如历史任务）。
  useEffect(() => {
    if (!taskId || !task || task.error || duration > 0) return;
    const d = summaryTask && Number(summaryTask.totalDuration);
    if (d > 0) setDuration(d);
  }, [taskId, task, summaryTask, duration]);

  // 首次进入某任务时，按窗口宽度自适应缩放（每个任务只做一次，之后尊重用户缩放）。
  useEffect(() => {
    if (!taskId || !task || task.error || !(duration > 0)) return;
    if (fittedRef.current === taskId) return;
    const el = scrollerRef.current;
    if (!el) return;
    fittedRef.current = taskId;
    const w = el.clientWidth || 900;
    setPxPerSec(clamp((w - 48) / duration, 1, 120));
  }, [taskId, task, duration]);

  // 未保存时离开页面要提示。
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Delete 删除选中片段（输入框内不拦截）。
  useEffect(() => {
    if (!selection) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      e.preventDefault();
      const sel = selection;
      setPlan((p) => ({
        ...p,
        [sel.kind]: p[sel.kind].filter((s) => s.id !== sel.id)
      }));
      setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  // 卸载时清掉混音计时器。
  useEffect(() => () => {
    if (busyTimerRef.current) {
      clearInterval(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  }, []);

  // ---------- 视频 ----------
  function onVideoMeta(e) {
    const d = Number(e.target && e.target.duration);
    if (Number.isFinite(d) && d > 0) {
      setDuration((prev) => (Math.abs(prev - d) > 0.05 ? Math.round(d * 100) / 100 : prev));
    }
  }
  function onVideoTime(e) {
    const t = Number(e.target && e.target.currentTime) || 0;
    setPlayhead(t);
    const sc = scrollerRef.current;
    if (!sc) return;
    const x = t * pxPerSec;
    const viewW = sc.clientWidth || 0;
    if (x > sc.scrollLeft + viewW * 0.92) sc.scrollLeft = Math.max(0, x - viewW * 0.25);
    else if (x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - viewW * 0.25);
  }
  function seekTo(sec) {
    const v = videoRef.current;
    const hi = duration > 0 ? duration : Math.max(Number(sec) || 0, 0);
    const t = clamp(Number(sec) || 0, 0, hi);
    setPlayhead(t);
    if (v) {
      try { v.currentTime = t; } catch (_) { /* media not ready yet: ignore */ }
    }
  }

  // ---------- 计划编辑 ----------
  function addSegment(track) {
    const kind = trackKind(track);
    const total = duration > 0 ? duration : 0;
    const lane = plan[kind];
    let start = 0;
    for (const s of lane) start = Math.max(start, Number(s.timelineEnd) || 0);
    if (total > 0 && start >= total - 0.5) start = 0;
    const trackDur = Number(track.durationSec) || 30;
    let end = start + trackDur;
    if (total > 0) end = Math.min(end, total);
    if (end - start < 0.5) {
      setStatus({ kind: 'err', text: tr('bgm.addNoSpace') });
      return;
    }
    const id = kind + '_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1000).toString(36);
    const seg = {
      id,
      trackId: track.id,
      timelineStart: round3(start),
      timelineEnd: round3(end),
      sourceIn: 0,
      sourceOut: round3(end - start),
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      speed: 1,
      fillMode: kind === 'ambient' ? 'loop' : 'none',
      keyframes: []
    };
    setPlan((p) => ({ ...p, [kind]: [...p[kind], seg] }));
    setSelection({ kind, id });
    setStatus({ kind: 'ok', text: tr('bgm.adding', { name: track.title || track.id }) });
  }

  function updateSegment(kind, id, patch) {
    setPlan((p) => ({
      ...p,
      [kind]: p[kind].map((s) => (s.id === id ? { ...s, ...patch } : s))
    }));
  }

  // 拖动过程中实时写 plan（夹取已在 ClipBlock 里完成），并让时间轴头部显示临时位置。
  function dragMoveSegment(kind, id, patch, info) {
    if (!patch || !Object.values(patch).every((v) => Number.isFinite(v))) return;
    updateSegment(kind, id, patch);
    setDragInfo({ kind, id, ...info });
  }

  // 松手：最终值再写一次（防止最后一帧 rAF 被取消），清掉临时读数并提示未保存。
  function dragEndSegment(kind, id, patch, info) {
    if (!patch || !Object.values(patch).every((v) => Number.isFinite(v))) {
      setDragInfo(null);
      return;
    }
    updateSegment(kind, id, patch);
    setDragInfo(null);
    const verb = info.mode === 'move' ? tr('bgm.movedClip')
      : info.mode === 'left' ? tr('bgm.trimmedLeft') : tr('bgm.trimmedRight');
    setStatus({
      kind: '',
      text: tr('bgm.movedStatus', { verb, start: fmtClock(info.start), end: fmtClock(info.end) })
    });
  }

  function deleteSegment(kind, id) {
    setPlan((p) => ({ ...p, [kind]: p[kind].filter((s) => s.id !== id) }));
    setSelection((sel) => (sel && sel.id === id ? null : sel));
    setStatus({ kind: '', text: tr('bgm.deletedSegment') });
  }

  // ---------- 保存 / 预览 / 导出 ----------
  async function savePlanOrThrow() {
    if (!taskId) throw new Error(tr('bgm.missingTask'));
    const data = await api('/api/tasks/' + encodeURIComponent(taskId) + '/bgm-plan', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan })
    });
    const clean = normalizePlan(data && data.plan);
    setPlan(clean);
    setSavedSig(JSON.stringify(clean));
    return clean;
  }

  async function onSave() {
    if (!taskId || busy) return;
    setBusy('save');
    setStatus({ kind: 'busy', text: tr('bgm.saving') });
    try {
      await savePlanOrThrow();
      setWarnings([]);
      setStatus({ kind: 'ok', text: tr('bgm.savedAt', { time: new Date().toLocaleTimeString() }) });
    } catch (e) {
      setStatus({ kind: 'err', text: tr('bgm.saveFailed', { error: e.message }) });
    } finally {
      setBusy('');
    }
  }

  async function onAuto() {
    if (!taskId || busy) return;
    if (dirty && !window.confirm(tr('bgm.autoConfirm'))) return;
    setBusy('auto');
    setStatus({ kind: 'busy', text: tr('bgm.autoGenerating') });
    try {
      const data = await api('/api/tasks/' + encodeURIComponent(taskId) + '/bgm-auto-plan', { method: 'POST' });
      if (!data || data.ok === false || !data.plan) throw new Error((data && data.error) || tr('bgm.autoNoPlan'));
      const p = normalizePlan(data.plan);
      setPlan(p);
      setSelection(null);
      setPreview({ url: null, sig: null });
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setStatus({ kind: 'ok', text: tr('bgm.autoDone') });
    } catch (e) {
      const hint = /至少勾选/.test(e.message) ? tr('bgm.autoAtLeast') : ''; // i18n-allow: backend Chinese error match
      setStatus({ kind: 'err', text: tr('bgm.autoFailed', { error: e.message, hint }) });
    } finally {
      setBusy('');
    }
  }

  async function onPreview() {
    if (!taskId || busy) return;
    if (!hasSegs) {
      setStatus({ kind: 'err', text: tr('bgm.emptyTimelinePreview') });
      return;
    }
    if (preview.url && preview.sig === planSignature(plan)) {
      setStatus({ kind: 'ok', text: tr('bgm.previewReady') });
      return;
    }
    setBusy('preview');
    const started = Date.now();
    setStatus({ kind: 'busy', text: tr('bgm.mixing', { sec: 0 }) });
    if (busyTimerRef.current) clearInterval(busyTimerRef.current);
    busyTimerRef.current = setInterval(() => {
      setStatus({ kind: 'busy', text: tr('bgm.mixingSlow', { sec: Math.round((Date.now() - started) / 1000) }) });
    }, 1000);
    try {
      const clean = await savePlanOrThrow();
      const data = await api('/api/tasks/' + encodeURIComponent(taskId) + '/bgm-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: clean })
      });
      if (!data || !data.previewUrl) throw new Error(tr('bgm.noPreviewUrl'));
      setPreview({ url: withBust(data.previewUrl, Date.now()), sig: JSON.stringify(clean) });
      setStatus({ kind: 'ok', text: tr('bgm.previewDone') });
    } catch (e) {
      setStatus({ kind: 'err', text: tr('bgm.previewFailed', { error: e.message }) });
    } finally {
      if (busyTimerRef.current) {
        clearInterval(busyTimerRef.current);
        busyTimerRef.current = null;
      }
      setBusy('');
    }
  }

  function onExport() {
    if (!taskId || busy) return;
    if (!hasSegs) {
      setStatus({ kind: 'err', text: tr('bgm.emptyTimelineExport') });
      return;
    }
    // 用页面内确认条而不是 window.confirm：样式统一，也便于自动化验收点击。
    setConfirmExport(true);
    setStatus({ kind: 'warn', text: tr('bgm.exportOverwriteWarn') });
  }

  async function doExport() {
    if (!taskId || busy) return;
    setConfirmExport(false);
    setBusy('export');
    setStatus({ kind: 'busy', text: tr('bgm.exporting') });
    try {
      const clean = await savePlanOrThrow();
      const data = await api('/api/tasks/' + encodeURIComponent(taskId) + '/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: clean })
      });
      const outUrl = data && data.outputUrl ? data.outputUrl : null;
      setPreview({ url: null, sig: null });
      setTask((t) => (t ? {
        ...t,
        videoUrl: outUrl || t.videoUrl,
        totalDuration: data && data.duration ? data.duration : t.totalDuration
      } : t));
      setVideoBust(Date.now());
      setPlayhead(0);
      setStatus({
        kind: 'ok',
        text: tr('bgm.exportDone')
          + (data && data.duration ? tr('bgm.exportDoneSuffix', { dur: Number(data.duration).toFixed(2) }) : '')
          + tr('bgm.overwritten')
      });
      loadList();
    } catch (e) {
      setStatus({ kind: 'err', text: tr('bgm.exportFailed', { error: e.message }) });
    } finally {
      setBusy('');
    }
  }

  function onRestoreOriginal() {
    setPreview({ url: null, sig: null });
    setPlayhead(0);
    setStatus({ kind: '', text: tr('bgm.restored') });
  }

  function goList() {
    if (dirty && !window.confirm(tr('bgm.dirtyLeave'))) return;
    setConfirmExport(false);
    navigate('/bgm');
  }

  function onFit() {
    const el = scrollerRef.current;
    const w = el ? el.clientWidth : 900;
    if (duration > 0) setPxPerSec(clamp((w - 48) / duration, 1, 240));
  }

  function onZoom(factor) {
    setPxPerSec((p) => clamp(p * factor, 1, 240));
  }

  // ---------- 渲染：列表 ----------
  if (!taskId) {
    return html`
      <${TaskPicker}
        list=${list}
        onPick=${(id) => navigate('/bgm/' + encodeURIComponent(id))}
        onReload=${loadList}
      />
    `;
  }

  // ---------- 渲染：编辑器 ----------
  const videoBase = task && task.videoUrl ? task.videoUrl : null;
  const videoSrc = preview.url || withBust(videoBase, videoBust);
  const prompt = taskPromptSummary(summaryTask, 300) || '';
  const resultError = task && task.result && task.result.error ? task.result.error : '';

  let body = null;
  if (!task) {
    body = html`<div className="bgm-loading">${tr('bgm.loadingPlan')}</div>`;
  } else if (task.error) {
    body = html`
      <div className="bgm-error">
        ${task.error}<br/>
        <button className="bgm-btn" onClick=${goList}>${tr('bgm.backToTasks')}</button>
      </div>
    `;
  } else {
    body = html`
      <div className="bgm-stage">
        <section className="bgm-card bgm-player">
          <div className="bgm-video-wrap">
            ${videoSrc
              ? html`<video
                  ref=${videoRef}
                  src=${videoSrc}
                  className="bgm-video"
                  controls=${true}
                  preload="metadata"
                  playsInline=${true}
                  onLoadedMetadata=${onVideoMeta}
                  onTimeUpdate=${onVideoTime}
                  onEnded=${() => setStatus({ kind: '', text: tr('bgm.playbackEnded') })}
                ></video>`
              : html`<div className="bgm-video-empty">${tr('bgm.videoEmpty')}</div>`}
          </div>

          <div className="bgm-player-meta">
            <span className=${'bgm-badge ' + (hasBgm ? 'ok' : 'plain')}>${hasBgm ? tr('bgm.hasBgm') : tr('bgm.noBgm')}</span>
            <span className="num">${metaDuration > 0 ? fmtClock(metaDuration) : tr('bgm.unknownDuration')}</span>
            <span>${(summaryTask && summaryTask.resolution) || '-'}</span>
            <span>${summaryTask && summaryTask.totalClips ? tr('bgm.clips', { n: summaryTask.totalClips }) : ''}</span>
            <span>${tr('bgm.planClips', { n: segmentCount(plan) })}</span>
            <span className="bgm-spacer"></span>
            <span>${task.masterPath ? tr('bgm.masterReady') : tr('bgm.masterMissing')}</span>
          </div>

          ${previewActive && html`
            <div className="bgm-previewbar">
              <span>${tr('bgm.previewBar')}</span>
              ${previewStale && html`<span className="bgm-badge warn">${tr('bgm.previewStale')}</span>`}
              <span className="bgm-spacer"></span>
              <button className="bgm-btn sm" onClick=${onRestoreOriginal}>${tr('bgm.restoreOriginal')}</button>
            </div>
          `}

          ${resultError && html`
            <p className="bgm-note" style=${{ color: 'var(--warn)' }}>${tr('bgm.resultError', { error: resultError })}</p>
          `}

          ${prompt && html`
            <p className="bgm-note bgm-prompt" title=${prompt}>${prompt}</p>
          `}

          <p className="bgm-note">
            ${tr('bgm.editorNote', { taskId })}
          </p>
          </p>
        </section>

        <aside className="bgm-side">
          <${LibraryPanel}
            lib=${lib}
            cat=${libCat}
            setCat=${setLibCat}
            q=${libQ}
            setQ=${setLibQ}
            onAdd=${addSegment}
          />
          <${ClipProps}
            selected=${selected}
            tracks=${tracks}
            trackMap=${trackMap}
            duration=${duration}
            onUpdate=${updateSegment}
            onDelete=${deleteSegment}
            onSeek=${seekTo}
          />
        </aside>
      </div>

      <${Timeline}
        plan=${plan}
        trackMap=${trackMap}
        duration=${duration}
        pxPerSec=${pxPerSec}
        playhead=${playhead}
        selection=${selection}
        scrollRef=${scrollerRef}
        previewActive=${previewActive}
        dragInfo=${dragInfo}
        onSeek=${seekTo}
        onSelect=${(kind, id) => setSelection({ kind, id })}
        onUpdate=${updateSegment}
        onDragMove=${dragMoveSegment}
        onDragEnd=${dragEndSegment}
        onZoom=${onZoom}
        onFit=${onFit}
      />
    `;
  }

  return html`
    <div className="bgm-page">
      <div className="bgm-head">
        <button className="bgm-btn" onClick=${goList}>${tr('bgm.backTasks')}</button>
        <h1 className="bgm-title">${tr('bgm.editorTitle')}</h1>
        <span className="bgm-sub">${taskId}</span>
        <span className="bgm-spacer"></span>
        ${task && !task.error && html`
          <span className=${'bgm-dirty' + (dirty ? '' : ' saved')}>${dirty ? tr('bgm.dirty') : tr('bgm.saved')}</span>
          <button className="bgm-btn accent" onClick=${onAuto} disabled=${!!busy}>${tr('bgm.auto')}</button>
          <button className="bgm-btn" onClick=${onSave} disabled=${!!busy}>${tr('bgm.save')}</button>
          <button className="bgm-btn" onClick=${onPreview} disabled=${!!busy || !hasSegs}
            title=${tr('bgm.previewTitle')}>${tr('bgm.preview')}</button>
          <button className="bgm-btn primary" onClick=${onExport} disabled=${!!busy || !hasSegs}
            title=${tr('bgm.exportTitle')}>${tr('bgm.export')}</button>
        `}
      </div>

      ${status.text && html`<div className=${'bgm-status ' + (status.kind || '')}>${status.text}</div>`}
      ${warnings.length > 0 && html`
        <div className="bgm-warnbox">
          ${warnings.map((w, i) => html`<div key=${'warn' + i}>· ${w}</div>`)}
        </div>
      `}

      ${confirmExport && html`
        <div className="bgm-confirm">
          <span>
            ${tr('bgm.exportConfirm', { taskId })}
          </span>
          <span className="bgm-spacer"></span>
          <button className="bgm-btn sm danger" onClick=${doExport} disabled=${!!busy}>${tr('bgm.confirmExport')}</button>
          <button className="bgm-btn sm" onClick=${() => {
            setConfirmExport(false);
            setStatus({ kind: '', text: tr('bgm.exportingCancelled') });
          }}>${tr('bgm.cancel')}</button>
        </div>
      `}

      ${body}
    </div>
  `;
}
