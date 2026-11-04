// ============================================================
// 剪辑台 · 音频面板（F07）
// ------------------------------------------------------------
// 音乐 / 环境音两轨：选曲、波形、音量、淡入淡出。
// 数据存进 project.audio（bgmPlan 片段形状），导出时 editorExporter 交给 audioMixer。
// 波形走服务端 /api/bgm/waveform/:id（ffmpeg 降采样峰值），避免浏览器解码兼容问题。
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef } = React;

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function drawPeaks(canvas, peaks) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !peaks || !peaks.length) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(214, 179, 106, 0.55)';
  const n = Math.min(peaks.length, Math.floor(w / 2));
  const step = peaks.length / n;
  for (let i = 0; i < n; i++) {
    const v = peaks[Math.floor(i * step)] / 255;
    const bh = Math.max(1, v * (h - 4));
    ctx.fillRect(i * 2, (h - bh) / 2, 1, bh);
  }
}

export function Waveform({ trackId }) {
  const ref = useRef(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/bgm/waveform/' + encodeURIComponent(trackId), { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive || !j || !j.ok || !ref.current) return;
        drawPeaks(ref.current, j.peaks);
      })
      .catch(() => { /* 波形失败不影响选曲 */ });
    return () => { alive = false; };
  }, [trackId]);
  return html`<canvas ref=${ref} className="ed-wave" width="520" height="56"></canvas>`;
}

const KINDS = [
  { key: 'music', label: '音乐', hint: '整片铺底' },
  { key: 'ambient', label: '环境音', hint: '自然声景' }
];

export function AudioPanel({ project, bgm, duration, onCommit }) {
  const audio = (project && project.audio) || { music: [], ambient: [] };
  const tracks = (bgm && bgm.tracks) || [];
  const byId = {};
  for (const t of tracks) byId[t.id] = t;

  function add(kind, track) {
    const dur = Math.max(1, Number(duration) || 10);
    const seg = {
      trackId: track.id,
      timelineStart: 0,
      timelineEnd: dur,
      sourceIn: 0,
      sourceOut: Number(track.durationSec) || dur,
      fillMode: 'loop',
      volume: kind === 'ambient' ? 0.35 : 0.8,
      fadeIn: 2,
      fadeOut: 2
    };
    onCommit({ ...audio, [kind]: [seg] });
  }

  function update(kind, patch) {
    const list = (audio[kind] || []).slice();
    if (!list[0]) return;
    list[0] = { ...list[0], ...patch };
    onCommit({ ...audio, [kind]: list });
  }

  function remove(kind) {
    onCommit({ ...audio, [kind]: [] });
  }

  return html`<div className="ed-audio">
    ${KINDS.map((k) => {
      const seg = (audio[k.key] || [])[0];
      const track = seg ? byId[seg.trackId] : null;
      const options = tracks.filter((t) => t.category === k.key).slice(0, 8);
      return html`<div className="ed-audio-track" key=${k.key}>
        <div className="ed-audio-head">
          <b>${k.label}</b>
          <span className="ed-sub">${k.hint}</span>
        </div>
        ${seg
          ? html`<div className="ed-audio-seg">
              <div className="ed-audio-title">${track ? track.title : seg.trackId}</div>
              <${Waveform} trackId=${seg.trackId} />
              <label className="ed-audio-row">
                <span>音量</span>
                <input
                  className="ed-slider-input"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value=${Number(seg.volume) || 0}
                  onInput=${(e) => update(k.key, { volume: Number(e.target.value) })}
                />
                <span className="ed-slider-val">${Math.round((Number(seg.volume) || 0) * 100)}%</span>
              </label>
              <div className="ed-audio-row">
                <span>淡入</span>
                <input className="ed-num" type="number" min="0" max="10" step="0.5"
                  value=${Number(seg.fadeIn) || 0}
                  onInput=${(e) => update(k.key, { fadeIn: Number(e.target.value) })} />
                <span className="ed-sub">秒</span>
                <span>淡出</span>
                <input className="ed-num" type="number" min="0" max="10" step="0.5"
                  value=${Number(seg.fadeOut) || 0}
                  onInput=${(e) => update(k.key, { fadeOut: Number(e.target.value) })} />
                <span className="ed-sub">秒</span>
              </div>
              <button className="ed-btn" onClick=${() => remove(k.key)}>移除</button>
            </div>`
          : html`<div className="ed-audio-pick">
              ${options.map((t) => html`
                <button key=${t.id} className="ed-audio-option" onClick=${() => add(k.key, t)}>
                  <span>${t.title}</span>
                  <span className="ed-sub">${fmtDur(t.durationSec)}</span>
                </button>
              `)}
              ${options.length === 0 && html`<p className="ed-sub">配乐库为空（把 mp3 放进 assets/bgm 并登记）</p>`}
            </div>`}
      </div>`;
    })}
  </div>`;
}
