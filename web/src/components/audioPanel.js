// ============================================================
// 剪辑台 · 音频面板（F07；2026-11-15 P2 并入配乐库）
// ------------------------------------------------------------
// 音乐 / 环境音两轨：选曲、波形、音量、淡入淡出。
// 2026-11-15：配乐库（试听 / 上传 / 删除 / 默认曲目）从库存页搬到这里，
//             /music 导航入口已移除，深链仍兼容。
// 数据存进 project.audio（bgmPlan 片段形状），导出时 editorExporter 交给 audioMixer。
// 波形走服务端 /api/bgm/waveform/:id（ffmpeg 降采样峰值），避免浏览器解码兼容问题。
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

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

export function AudioPanel({ project, bgm, duration, onCommit, onReloadBgm }) {
  const audio = (project && project.audio) || { music: [], ambient: [] };
  const tracks = (bgm && bgm.tracks) || [];
  const byId = {};
  for (const t of tracks) byId[t.id] = t;
  const defaultId = (bgm && bgm.defaultTrackId) || '';

  // ---- 配乐库（P2 从库存页搬入） ----
  const [libErr, setLibErr] = useState('');
  const [libMsg, setLibMsg] = useState('');
  const [playingId, setPlayingId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const audioElRef = useRef(null);
  const MAX_AUDIO_MB = 20;

  useEffect(() => () => {
    try { if (audioElRef.current) audioElRef.current.pause(); } catch (e) { /* ignore */ }
  }, []);

  // /bgm 是登录墙内的静态目录，直接交给 <audio> 播放
  function bgmUrl(t) {
    if (t && t.url) return t.url;
    return '/bgm/' + String((t && t.file) || '').split('/').map(encodeURIComponent).join('/');
  }

  function togglePlay(t) {
    setLibErr('');
    try {
      let a = audioElRef.current;
      if (!a) { a = new window.Audio(); audioElRef.current = a; }
      if (playingId === t.id) { a.pause(); setPlayingId(''); return; }
      a.onended = () => setPlayingId('');
      a.onerror = () => { setLibErr('试听失败：' + (t.title || t.id) + '（文件可能不存在）'); setPlayingId(''); };
      a.src = bgmUrl(t);
      const p = a.play();
      if (p && p.catch) {
        p.catch((e) => {
          setLibErr('试听失败：' + (e && e.message ? e.message : '浏览器拒绝播放'));
          setPlayingId('');
        });
      }
      setPlayingId(t.id);
    } catch (e) { setLibErr('试听失败：' + e.message); }
  }

  async function setDefaultTrack(id) {
    setLibErr(''); setLibMsg('');
    try {
      const r = await fetch('/api/bgm/prefs', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultTrackId: id })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setLibMsg('已设为默认曲目');
      if (onReloadBgm) await onReloadBgm();
    } catch (e) { setLibErr('设为默认失败：' + e.message); }
  }

  async function removeTrack(t) {
    if (!window.confirm('删除配乐「' + (t.title || t.id) + '」？会先移入回收站，可在回收站恢复。')) return;
    setLibErr(''); setLibMsg(''); setBusyId(t.id);
    try {
      const r = await fetch('/api/bgm/' + encodeURIComponent(t.id), { method: 'DELETE', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setLibMsg(j.trashed ? '已移入回收站' : '已删除');
      if (onReloadBgm) await onReloadBgm();
    } catch (e) { setLibErr('删除失败：' + e.message); }
    finally { setBusyId(''); }
  }

  // 上传：FileReader 读 dataURL（后端只收 base64，零新依赖）；时长用 <audio> 读，读不到就 0。
  async function uploadFile(file) {
    setLibErr(''); setLibMsg('');
    if (!file) return;
    if (file.size > MAX_AUDIO_MB * 1024 * 1024) {
      setLibErr(`文件 ${(file.size / 1048576).toFixed(1)}MB，超过 ${MAX_AUDIO_MB}MB 上限`);
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ''));
        fr.onerror = () => rej(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
      const durationSec = await new Promise((res) => {
        try {
          const a = new window.Audio();
          a.preload = 'metadata';
          a.onloadedmetadata = () => {
            const d = a.duration;
            res(Number.isFinite(d) ? Math.round(d * 10) / 10 : 0);
          };
          a.onerror = () => res(0);
          a.src = dataUrl;
        } catch (e) { res(0); }
      });
      const r = await fetch('/api/bgm', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          fileData: dataUrl,
          title: file.name.replace(/\.[^.]+$/, ''),
          category: 'music',
          durationSec
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
      setLibMsg('已上传：' + file.name);
      if (onReloadBgm) await onReloadBgm();
    } catch (e) {
      setLibErr('上传失败：' + e.message);
    } finally {
      setUploading(false);
    }
  }

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
                <span>入点</span>
                <input className="ed-num" type="number" min="0" step="0.5"
                  value=${Number(seg.sourceIn) || 0}
                  onInput=${(e) => update(k.key, { sourceIn: Number(e.target.value) })} />
                <span>出点</span>
                <input className="ed-num" type="number" min="0" step="0.5"
                  value=${Number(seg.sourceOut) || 0}
                  onInput=${(e) => update(k.key, { sourceOut: Number(e.target.value) })} />
                <span className="ed-sub">秒</span>
              </div>
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

    <div className="ed-audio-track">
      <div className="ed-audio-head">
        <b>配乐库</b>
        <span className="ed-sub">${tracks.length} 首</span>
        <span style=${{ flex: 1 }}></span>
        <label className="ed-btn" style=${{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          ${uploading ? '上传中…' : '＋ 上传音频'}
          <input type="file" accept=".mp3,.wav,.m4a,.ogg,audio/*" className="hidden"
            disabled=${uploading}
            onChange=${(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) uploadFile(f); }} />
        </label>
      </div>
      ${libErr && html`<p style=${{ margin: '0 0 6px', fontSize: '11px', color: 'var(--danger)' }}>${libErr}</p>`}
      ${libMsg && html`<p style=${{ margin: '0 0 6px', fontSize: '11px', color: 'var(--ink3)' }}>${libMsg}</p>`}
      ${tracks.length === 0 && html`<p className="ed-sub">配乐库为空：可上传 mp3 / wav / m4a / ogg（单文件 ≤${MAX_AUDIO_MB}MB）。</p>`}
      ${tracks.map((t) => html`
        <div key=${t.id} style=${{ padding: '5px 0', borderTop: '1px solid rgba(244,247,245,.05)' }}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button className="ed-btn" title=${playingId === t.id ? '停止试听' : '试听'}
              style=${{ width: '26px', height: '26px', borderRadius: '50%', padding: 0, flex: '0 0 auto' }}
              onClick=${() => togglePlay(t)}>${playingId === t.id ? '⏸' : '▶'}</button>
            <span style=${{ flex: 1, minWidth: 0, fontSize: '11.5px', color: 'var(--ink2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${t.title || t.id}</span>
            <span className="ed-sub">${fmtDur(t.durationSec)}</span>
          </div>
          <div style=${{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', marginTop: '2px', paddingLeft: '34px' }}>
            ${defaultId === t.id
              ? html`<span style=${{ fontSize: '10px', padding: '2px 6px', borderRadius: '3px', background: 'var(--accent)', color: 'var(--onaccent)', flex: '0 0 auto' }}>默认</span>`
              : html`<button className="ed-btn" onClick=${() => setDefaultTrack(t.id)}>设为默认</button>`}
            <button className="ed-btn" disabled=${busyId === t.id} onClick=${() => removeTrack(t)}
              style=${{ color: 'var(--danger)' }}>删除</button>
          </div>
        </div>
      `)}
    </div>
  </div>`;
}
