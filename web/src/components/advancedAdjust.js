// ============================================================
// 剪辑台 · 高级调节面板（F12：HSL / 曲线 / 色轮）
// ------------------------------------------------------------
// 只负责参数形状与交互，不复制颜色数学：
//   hsl[8][3]                 -100..100
//   curve[3][[x,y], ...]      0..1
//   wheel.{lift,gamma,gain}.{r,g,b,y}  -1..1（0 = 不变）
// 参数写入 segments[].adjust，预览与导出都由 adjustChain 同一套 LUT 生效。
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useRef, useState } = React;

export const HSL_BANDS = [
  { key: 'red', label: '红', color: '#E4574F' },
  { key: 'orange', label: '橙', color: '#E6913F' },
  { key: 'yellow', label: '黄', color: '#D8C84A' },
  { key: 'green', label: '绿', color: '#5DBE72' },
  { key: 'cyan', label: '青', color: '#4BBFC4' },
  { key: 'blue', label: '蓝', color: '#5A8FE0' },
  { key: 'purple', label: '紫', color: '#9A6FD0' },
  { key: 'magenta', label: '品红', color: '#D667B0' }
];

export const CURVE_CHANNELS = [
  { key: 'rgb', label: '合成', color: '#D6B36A' },
  { key: 'r', label: 'R', color: '#E4574F' },
  { key: 'g', label: 'G', color: '#5DBE72' },
  { key: 'b', label: 'B', color: '#5A8FE0' }
];

export const WHEEL_ZONES = [
  { key: 'lift', label: '提升 Lift' },
  { key: 'gamma', label: '伽马 Gamma' },
  { key: 'gain', label: '增益 Gain' }
];

const WHEEL_CHANNELS = ['r', 'g', 'b', 'y'];
const HSL_CHANNELS = [
  { key: 'h', label: '色相' },
  { key: 's', label: '饱和度' },
  { key: 'l', label: '明度' }
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const round2 = (v) => Math.round(clamp(v, -1, 1) * 100) / 100;

function normalizeHsl(raw) {
  const src = Array.isArray(raw) ? raw : [];
  return Array.from({ length: 8 }, (_, i) => {
    const band = Array.isArray(src[i]) ? src[i] : [];
    return [0, 1, 2].map((c) => Math.round(clamp(band[c], -100, 100)));
  });
}
function hslAny(hsl) {
  return hsl.some((b) => b.some((v) => v !== 0));
}

function defaultCurve() {
  return [0, 0.25, 0.5, 0.75, 1].map((x) => [x, x]);
}
function normalizeCurve(raw) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const pts = Array.isArray(raw) && Array.isArray(raw[i]) ? raw[i] : null;
    if (pts && pts.length >= 2) {
      out.push(pts
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [clamp(p[0], 0, 1), clamp(p[1], 0, 1)])
        .sort((a, b) => a[0] - b[0]));
    } else {
      out.push(defaultCurve());
    }
  }
  return out;
}
function isIdentityCurve(pts) {
  if (!pts || pts.length < 2) return false;
  const first = pts[0];
  const last = pts[pts.length - 1];
  return Math.abs(first[0]) < 1e-6 && Math.abs(first[1]) < 1e-6
    && Math.abs(last[0] - 1) < 1e-6 && Math.abs(last[1] - 1) < 1e-6
    && pts.every((p) => Math.abs(p[0] - p[1]) < 1e-6);
}
function curvesIdentity(curves) {
  return curves.length === 3 && curves.every(isIdentityCurve);
}

function normalizeWheel(raw) {
  const out = {};
  for (const zone of ['lift', 'gamma', 'gain']) {
    out[zone] = {};
    for (const ch of WHEEL_CHANNELS) {
      const v = raw && raw[zone] ? Number(raw[zone][ch]) : 0;
      out[zone][ch] = Number.isFinite(v) ? clamp(v, -1, 1) : 0;
    }
  }
  return out;
}
function wheelAny(wheel) {
  return WHEEL_ZONES.some((z) => WHEEL_CHANNELS.some((ch) => Math.abs(wheel[z.key][ch]) > 1e-6));
}

function pushHistory(fn) {
  if (typeof fn === 'function') fn();
}

// ---------------- HSL ----------------
export function HslPanel({ adjust, onChange, onHistory }) {
  const [band, setBand] = useState(0);
  const hsl = normalizeHsl(adjust && adjust.hsl);
  const cur = hsl[band];

  function emit(next) {
    onChange({ hsl: hslAny(next) ? next : null });
  }

  function setChannel(ci, raw) {
    const next = hsl.map((b) => b.slice());
    next[band][ci] = Math.round(clamp(raw, -100, 100));
    emit(next);
  }

  function resetBand() {
    pushHistory(onHistory);
    const next = hsl.map((b) => b.slice());
    next[band] = [0, 0, 0];
    emit(next);
  }

  function resetAll() {
    pushHistory(onHistory);
    onChange({ hsl: null });
  }

  return html`<div className="ed-adv" data-adv-panel="hsl">
    <div className="ed-adv-head">
      <b>HSL</b>
      <span className="ed-sub">8 个色带 · 每带 色相 / 饱和度 / 明度</span>
      <button className="ed-btn ed-adv-reset" onClick=${resetAll}>重置</button>
    </div>
    <div className="ed-adv-bands">
      ${HSL_BANDS.map((b, i) => html`
        <button
          key=${b.key}
          className=${'ed-adv-band' + (i === band ? ' on' : '') + (hsl[i].some((v) => v !== 0) ? ' mod' : '')}
          onClick=${() => setBand(i)}
          title=${b.label + '色带'}
        >
          <span className="ed-adv-dot" style=${{ background: b.color }}></span>
          <span>${b.label}</span>
        </button>
      `)}
    </div>
    <div className="ed-group">
      ${HSL_CHANNELS.map((c, ci) => html`
        <div className="ed-slider-row" key=${c.key}>
          <span className="ed-slider-label">${c.label}</span>
          <input
            className="ed-slider-input"
            type="range"
            min="-100"
            max="100"
            step="1"
            value=${cur[ci]}
            onPointerDown=${onHistory}
            onInput=${(e) => setChannel(ci, e.target.value)}
          />
          <span className="ed-slider-val">${cur[ci]}</span>
        </div>
      `)}
    </div>
    <div className="ed-adv-foot">
      <button className="ed-btn" onClick=${resetBand}>重置本带</button>
      <span className="ed-sub">${HSL_BANDS[band].label}色带</span>
    </div>
    <p className="ed-hint">只作用选中片段；参数存进工程，预览与导出共用同一套 LUT。</p>
  </div>`;
}

// ---------------- 曲线 ----------------
function drawCurveCanvas(canvas, curves, chan) {
  if (!canvas) return;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0B100D';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(244,247,245,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = (i / 4) * (w - 1);
    const y = (i / 4) * (h - 1);
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
  }
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(244,247,245,0.18)';
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w - 1, 0); ctx.stroke();
  ctx.setLineDash([]);

  const active = chan === 'rgb' ? [0, 1, 2] : [chan === 'r' ? 0 : chan === 'g' ? 1 : 2];
  const colors = ['#E4574F', '#5DBE72', '#5A8FE0'];
  for (const ci of active) {
    const pts = curves[ci] || defaultCurve();
    ctx.strokeStyle = colors[ci];
    ctx.lineWidth = chan === 'rgb' ? 1.5 : 2;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = clamp(pts[i][0], 0, 1) * (w - 1);
      const y = (1 - clamp(pts[i][1], 0, 1)) * (h - 1);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const editCurve = curves[chan === 'rgb' ? 0 : chan === 'r' ? 0 : chan === 'g' ? 1 : 2] || [];
  for (const p of editCurve) {
    const x = clamp(p[0], 0, 1) * (w - 1);
    const y = (1 - clamp(p[1], 0, 1)) * (h - 1);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0B100D';
    ctx.fill();
    ctx.strokeStyle = chan === 'rgb' ? '#D6B36A' : colors[chan === 'r' ? 0 : chan === 'g' ? 1 : 2];
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

export function CurvePanel({ adjust, onChange, onHistory }) {
  const [chan, setChan] = useState('rgb');
  const canvasRef = useRef(null);
  const curvesRef = useRef(normalizeCurve(adjust && adjust.curve));
  const dragRef = useRef(null);
  const key = JSON.stringify((adjust && adjust.curve) || null);

  useEffect(() => {
    curvesRef.current = normalizeCurve(adjust && adjust.curve);
  }, [key]);

  useEffect(() => {
    drawCurveCanvas(canvasRef.current, curvesRef.current, chan);
  }, [key, chan]);

  function channelIndex() {
    return chan === 'rgb' ? 0 : chan === 'r' ? 0 : chan === 'g' ? 1 : 2;
  }

  function posOf(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return [
      clamp((e.clientX - rect.left) / rect.width, 0, 1),
      clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1)
    ];
  }

  function onDown(e) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const [x, y] = posOf(e);
    const rect = canvas.getBoundingClientRect();
    const pts = curvesRef.current[channelIndex()];
    let pick = -1;
    let best = 14;
    for (let i = 0; i < pts.length; i++) {
      const dx = (pts[i][0] - x) * rect.width;
      const dy = (pts[i][1] - y) * rect.height;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) { best = d; pick = i; }
    }
    if (pick < 0) return;
    pushHistory(onHistory);
    dragRef.current = {
      pick,
      base: curvesRef.current.map((c) => c.map((p) => p.slice()))
    };

    const move = (ev) => {
      const drag = dragRef.current;
      if (!drag) return;
      const [mx, my] = posOf(ev);
      const next = drag.base.map((c) => c.map((p) => p.slice()));
      const update = (ci) => {
        const pts2 = next[ci];
        const left = drag.pick > 0 ? pts2[drag.pick - 1][0] + 0.01 : 0;
        const right = drag.pick < pts2.length - 1 ? pts2[drag.pick + 1][0] - 0.01 : 1;
        const nx = drag.pick === 0 ? 0 : drag.pick === pts2.length - 1 ? 1 : clamp(mx, left, right);
        pts2[drag.pick] = [nx, clamp(my, 0, 1)];
      };
      if (chan === 'rgb') update(0), update(1), update(2);
      else update(channelIndex());
      curvesRef.current = next;
      onChange({ curve: curvesIdentity(next) ? null : next });
    };
    const up = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function resetChannel() {
    pushHistory(onHistory);
    const next = curvesRef.current.map((c) => c.map((p) => p.slice()));
    if (chan === 'rgb') {
      next[0] = defaultCurve(); next[1] = defaultCurve(); next[2] = defaultCurve();
    } else {
      next[channelIndex()] = defaultCurve();
    }
    curvesRef.current = next;
    onChange({ curve: curvesIdentity(next) ? null : next });
  }

  return html`<div className="ed-adv" data-adv-panel="curve">
    <div className="ed-adv-head">
      <b>曲线</b>
      <span className="ed-sub">拖动控制点 · 合成会同时写入 R/G/B</span>
      <button className="ed-btn ed-adv-reset" onClick=${resetChannel}>重置</button>
    </div>
    <div className="ed-adv-chan">
      ${CURVE_CHANNELS.map((c) => html`
        <button
          key=${c.key}
          className=${'ed-adv-chan-btn' + (chan === c.key ? ' on' : '')}
          style=${{ '--chan-color': c.color }}
          onClick=${() => setChan(c.key)}
        >${c.label}</button>
      `)}
    </div>
    <canvas
      ref=${canvasRef}
      className="ed-curve-canvas"
      width="260"
      height="180"
      onPointerDown=${onDown}
      title="拖动曲线控制点"
    ></canvas>
    <p className="ed-hint">默认 5 个控制点（0/0、0.25/0.25、0.5/0.5、0.75/0.75、1/1）；端点只能上下移动。</p>
  </div>`;
}

// ---------------- 色轮（数值） ----------------
export function WheelPanel({ adjust, onChange, onHistory }) {
  const wheel = normalizeWheel(adjust && adjust.wheel);

  function emit(next) {
    onChange({ wheel: wheelAny(next) ? next : null });
  }

  function setChannel(zone, ch, raw) {
    const next = normalizeWheel(wheel);
    next[zone][ch] = round2(raw);
    emit(next);
  }

  function resetZone(zone) {
    pushHistory(onHistory);
    const next = normalizeWheel(wheel);
    for (const ch of WHEEL_CHANNELS) next[zone][ch] = 0;
    emit(next);
  }

  function resetAll() {
    pushHistory(onHistory);
    onChange({ wheel: null });
  }

  return html`<div className="ed-adv" data-adv-panel="wheel">
    <div className="ed-adv-head">
      <b>色轮</b>
      <span className="ed-sub">lift / gamma / gain · r/g/b/y · -1..1</span>
      <button className="ed-btn ed-adv-reset" onClick=${resetAll}>重置</button>
    </div>
    ${WHEEL_ZONES.map((z) => html`
      <div className="ed-adv-wheel" key=${z.key}>
        <div className="ed-adv-wheel-head">
          <b>${z.label}</b>
          <button className="ed-btn ed-adv-reset" onClick=${() => resetZone(z.key)}>归零</button>
        </div>
        <div className="ed-adv-wheel-grid">
          ${WHEEL_CHANNELS.map((ch) => html`
            <label className="ed-adv-wheel-row" key=${ch}>
              <span className=${'ed-adv-ch ed-adv-ch-' + ch}>${ch.toUpperCase()}</span>
              <input
                className="ed-slider-input"
                type="range"
                min="-1"
                max="1"
                step="0.01"
                value=${wheel[z.key][ch]}
                onPointerDown=${onHistory}
                onInput=${(e) => setChannel(z.key, ch, e.target.value)}
              />
              <span className="ed-adv-val">${wheel[z.key][ch].toFixed(2)}</span>
            </label>
          `)}
        </div>
      </div>
    `)}
    <p className="ed-hint">0 = 不变。y 是亮度通道；参数逐段保存，预览与导出同一套 LUT。</p>
  </div>`;
}
