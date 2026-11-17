// ============================================================
// F12 高级调节验收（HSL / 曲线 / 色轮）
// ------------------------------------------------------------
// 能自动验的：
//   1) 静态：编辑器接入三块面板、8 个 HSL 色带、无「蒙版」入口；
//      预览引擎 hasAdjust 能识别 hsl/curve/wheel（否则只有高级参数的段预览不生效）
//   2) /api/adjust/lut 接受 hsl/curve/wheel，返回 17³ RGBA8，且与 adjustChain 数值一致
//   3) 高级参数 LUT 与恒等 LUT 有差异
//   4) 工程保存 → 重新 GET，hsl/curve/wheel 原样保留
//   5) 真机导出：带高级参数 vs 不带，像素均值差 > 3；adjust.applied === 1
// 不能自动验的：浏览器里拖点/滑杆手感与真实 WebGL 画面——会明确标注未验证。
//
// 用法：node scripts/verify-adjust-advanced.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_ADV_PORT || 3192);
const { normalizeParams, adjustChain } = require('../src/processors/adjustChain');
const adjustLut = require('../src/adjustLut');
const tm = require('../src/processors/transitionMixer');
const lib = require('../src/library');

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  —  ' + extra : ''}`); }
}
const read = (p) => fs.readFileSync(p, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(url, ms = 800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return (await fetch(url, { signal: ac.signal })).status; }
  catch (e) { return 0; }
  finally { clearTimeout(timer); }
}
async function waitReady(base, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping(base + '/api/status')) return true;
    await sleep(400);
  }
  return false;
}

// 与真实接口/导出使用同一组形状：hsl[8][3] / curve[3][[x,y]...] / wheel.{lift,gamma,gain}.{r,g,b,y}
const ADV = {
  hsl: [
    [35, 45, 20],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ],
  curve: [
    [[0, 0.12], [0.25, 0.30], [0.5, 0.62], [0.75, 0.84], [1, 1]],
    [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]],
    [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]]
  ],
  wheel: {
    lift: { r: 0.35, g: 0, b: -0.15, y: 0.1 },
    gamma: { r: 0, g: -0.2, b: 0.25, y: 0 },
    gain: { r: 0.2, g: 0.1, b: 0.3, y: 0 }
  }
};
const N = 17;

function identityLut() {
  const buf = Buffer.alloc(N * N * N * 4);
  let o = 0;
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const c = adjustChain([r / (N - 1), g / (N - 1), b / (N - 1)], null);
        for (let k = 0; k < 3; k++) buf[o++] = Math.round(Math.max(0, Math.min(1, c[k])) * 255);
        buf[o++] = 255;
      }
    }
  }
  return buf;
}

(async () => {
  console.log('================================================================');
  console.log('F12 高级调节验收（HSL / 曲线 / 色轮）');
  console.log('================================================================');

  const advPath = path.join(WEB, 'src', 'components', 'advancedAdjust.js');
  const adv = fs.existsSync(advPath) ? read(advPath) : '';
  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const engine = read(path.join(WEB, 'src', 'preview', 'engine.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));

  check(fs.existsSync(advPath), '高级调节组件文件存在');
  check(/export function HslPanel/.test(adv) && /export function CurvePanel/.test(adv)
    && /export function WheelPanel/.test(adv), 'HSL / 曲线 / 色轮三块面板导出');
  check(/data-adv-panel="hsl"/.test(adv) && /data-adv-panel="curve"/.test(adv)
    && /data-adv-panel="wheel"/.test(adv), '三块面板有可静态核验的挂载标记');

  const hslBlock = (adv.match(/const HSL_BANDS = \[([\s\S]*?)\n\];/) || [])[1] || '';
  const bandCount = (hslBlock.match(/labelKey:/g) || []).length;
  check(bandCount === 8, 'HSL 固定 8 个色带（i18n labelKey）', bandCount + ' 个');
  check(/const WHEEL_ZONES = \[/.test(adv) && /lift/.test(adv) && /gamma/.test(adv) && /gain/.test(adv),
    '色轮含 lift / gamma / gain 三区');
  check(/const CURVE_CHANNELS = \[/.test(adv), '曲线含 R/G/B 通道与合成线');

  check(/advancedAdjust\.js/.test(editor) && /HslPanel/.test(editor)
    && /CurvePanel/.test(editor) && /WheelPanel/.test(editor), '编辑器接入三块高级面板');
  check(/ADJUST_TABS/.test(editor) && /adjustTab/.test(editor), '右侧 tab 可切换基础/HSL/曲线/色轮');
  check(/function setAdvanced\(/.test(editor) && /hsl/.test(editor)
    && /curve/.test(editor) && /wheel/.test(editor), '高级参数写回 segments[].adjust');
  check(!/后续版本接入/.test(editor), '占位提示已移除');
  check(!/蒙版/.test(editor + adv), '没有蒙版入口');
  check(/ADV_KEYS/.test(engine) && /hsl/.test(engine) && /curve/.test(engine)
    && /wheel/.test(engine), '预览引擎识别高级参数（hasAdjust 不只认数字键）');
  check(/\.ed-adv/.test(css), '高级面板样式已接入');

  const p = normalizeParams(ADV);
  check(!!p && Array.isArray(p.hsl) && p.hsl.length === 8
    && Array.isArray(p.curve) && p.curve.length === 3
    && p.wheel && p.wheel.lift && p.wheel.gamma && p.wheel.gain,
    'adjustChain.normalizeParams 接受 hsl/curve/wheel 形状');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_adv_'));
  let child = null;
  let base = null;
  try {
    for (let i = 0; i < 6 && !child; i++) {
      const port = START_PORT + i;
      const candidate = `http://${HOST}:${port}`;
      if (await ping(candidate + '/api/status')) continue;
      const c = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          AUTH_ENABLED: 'false',
          DATABASE_TYPE: 'json',
          DATA_DIR: path.join(tmp, 'tasks'),
          OUTPUT_DIR: path.join(tmp, 'output'),
          PROJECTS_DIR: path.join(tmp, 'projects'),
          THUMBS_DIR: path.join(tmp, 'thumbs')
        },
        stdio: 'ignore',
        windowsHide: true
      });
      c.on('error', () => {});
      if (await waitReady(candidate)) { child = c; base = candidate; }
      else { try { c.kill(); } catch (e) { /* ignore */ } }
    }
    check(!!child, '临时服务启动');
    if (child) {
      const r = await fetch(base + '/api/adjust/lut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjust: ADV })
      });
      const j = await r.json();
      check(r.status === 200 && j.success === true && j.size === 17, '高级参数 LUT 接口返回 17³');
      const buf = Buffer.from(j.data || '', 'base64');
      check(buf.length === N * N * N * 4, '高级参数 LUT 字节数正确', buf.length + ' bytes');

      let maxDiff = 0;
      for (const [r0, g0, b0] of [[0, 0, 0], [8, 8, 8], [16, 16, 16], [4, 11, 13], [15, 2, 7]]) {
        const idx = ((b0 * N + g0) * N + r0) * 4;
        const expect = adjustChain([r0 / (N - 1), g0 / (N - 1), b0 / (N - 1)], p);
        for (let c = 0; c < 3; c++) {
          const want = Math.max(0, Math.min(1, expect[c])) * 255;
          maxDiff = Math.max(maxDiff, Math.abs(buf[idx + c] - want));
        }
      }
      check(maxDiff <= 1.0, '高级 LUT 与 adjustChain 数值一致（≤1/255）', 'maxΔ=' + maxDiff.toFixed(3));

      const idBuf = identityLut();
      let diffBytes = 0;
      for (let i = 0; i < buf.length; i++) if (i % 4 !== 3 && Math.abs(buf[i] - idBuf[i]) > 2) diffBytes++;
      check(diffBytes > 500, '高级 LUT 与恒等 LUT 有实质差异', diffBytes + ' 个通道字节');

      const pr = await fetch(base + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'advanced-adjust-verify',
          segments: [{ assetId: 'verify_asset', inSec: 0, outSec: 1, adjust: ADV }]
        })
      });
      const pj = await pr.json();
      check(pr.status === 200 && pj.success === true && pj.project && pj.project.id, '工程创建成功');
      if (pj.project && pj.project.id) {
        const gr = await fetch(base + '/api/projects/' + encodeURIComponent(pj.project.id));
        const gj = await gr.json();
        const seg = gj && gj.project && gj.project.segments && gj.project.segments[0];
        check(!!seg && JSON.stringify(seg.adjust && seg.adjust.hsl) === JSON.stringify(ADV.hsl)
          && JSON.stringify(seg.adjust && seg.adjust.curve) === JSON.stringify(ADV.curve)
          && JSON.stringify(seg.adjust && seg.adjust.wheel) === JSON.stringify(ADV.wheel),
          '保存/重开后 hsl/curve/wheel 原样保留');
      }
    }
  } catch (e) {
    check(false, '接口/持久化验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  // 真机导出：2 段（transitionMixer 最低要求），带高级参数 vs 不带参数
  try {
    const pool = lib.listAll().filter((i) => i.filePath && fs.existsSync(i.filePath));
    check(pool.length >= 1, '片段库有可用素材', pool.length + ' 条');
    if (pool.length >= 1) {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_adv_clip_'));
      const clips = [];
      if (pool.length >= 2) {
        for (const e of pool.slice(0, 2)) {
          const dur = Number(e.durationSec) || 2;
          clips.push({
            path: e.filePath, inSec: 0, outSec: Math.min(2, dur),
            detail: tm._probeMedia(e.filePath)
          });
        }
      } else {
        const e = pool[0];
        const dur = Number(e.durationSec) || 2;
        const mid = Math.min(2, dur / 2);
        const detail = tm._probeMedia(e.filePath);
        clips.push({ path: e.filePath, inSec: 0, outSec: mid, detail });
        clips.push({ path: e.filePath, inSec: mid, outSec: dur, detail });
      }
      const playable = clips.every((c) => c.outSec - c.inSec >= 0.8);
      check(playable, '导出素材入出点合法', clips.map((c) => (c.outSec - c.inSec).toFixed(2) + 's').join(' + '));
      try {
        if (playable) {
          const expected = clips.reduce((s, c) => s + (c.outSec - c.inSec), 0) - 0.4;
          const on = await tm.concatWithTransitions(
            clips.map((c) => ({ ...c, adjust: ADV })),
            path.join(tmp2, 'on.mp4'),
            { duration: 0.4, type: 'fade', ignoreAudio: true }
          );
          const off = await tm.concatWithTransitions(
            clips,
            path.join(tmp2, 'off.mp4'),
            { duration: 0.4, type: 'fade', ignoreAudio: true }
          );
          check(on.success === true, '带高级参数导出成功', on.error || '');
          check(off.success === true, '无高级参数导出成功', off.error || '');
          check(on.adjust && on.adjust.applied === clips.length, '高级参数逐段烘焙 LUT',
            on.adjust ? String(on.adjust.applied) : '无');
          if (on.success && off.success) {
            const a = tm._sampleRgbStats(on.outputPath, on.actualDuration);
            const b = tm._sampleRgbStats(off.outputPath, off.actualDuration);
            const diff = [0, 1, 2].map((i) => Math.abs(a.mean[i] - b.mean[i]));
            check(Math.max(...diff) > 3, '高级参数让画面均值明显变化',
              'ΔRGB=' + diff.map((d) => d.toFixed(1)).join('/'));
            check(Math.abs(on.actualDuration - expected) < 0.3, '导出时长正确',
              String(on.actualDuration) + 's（期望 ' + expected.toFixed(2) + 's）');
          }
        }
      } finally {
        try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
      }
    }
  } catch (e) {
    check(false, '真机导出验收异常: ' + (e && e.message ? e.message : e));
  }

  console.log('\n  未验证：真实浏览器里的拖点/滑杆手感与 WebGL 同帧画面（本环境无浏览器）');
  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
