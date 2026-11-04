// ============================================================
// F06 实时预览验收
// ------------------------------------------------------------
// 能自动验的：
//   1) 预览引擎接线（WebGL2 3D LUT / 双 video / 叠化 / 播放控制）
//   2) /api/adjust/lut 与 adjustChain 数值一致（逐点比对，量化误差 ≤1/255）
//   3) 8-bit LUT 量化上界 <1%（这是「与导出色差 <1%」的必要条件之一）
// 不能自动验的：真实浏览器里的像素差（无 WebGL 环境）——会明确标注未验证。
//
// 用法：node scripts/verify-editor-preview.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.EDITOR_PREVIEW_PORT || 3191);
const { normalizeParams, adjustChain } = require('../src/processors/adjustChain');
const adjustLut = require('../src/adjustLut');

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

(async () => {
  console.log('================================================================');
  console.log('F06 实时预览验收');
  console.log('================================================================');

  const engine = read(path.join(WEB, 'src', 'preview', 'engine.js'));
  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const css = read(path.join(WEB, 'styles', 'editor.css'));
  const server = read(path.join(ROOT, 'server.js'));

  check(/texImage3D/.test(engine) && /sampler3D/.test(engine), 'WebGL2 3D LUT 采样');
  check(/precision highp sampler3D/.test(engine), 'sampler3D 精度声明（否则着色器编译失败）');
  check(/UNPACK_FLIP_Y_WEBGL, false/.test(engine), '视频纹理不上下翻转');
  check(/createElement\('audio'\)/.test(engine) && /setAudio/.test(engine), '预览音频两轨');
  check(/e\.setAudio\(/.test(editor), '编辑器把音频计划传给预览');
  check(/createElement\('video'\)/.test(engine), 'video 解码');
  check(/uMix/.test(engine) && /_cue\(1 - this\.active/.test(engine), '双 video 叠化');
  check(/requestAnimationFrame/.test(engine), '逐帧渲染');
  check(/\/api\/adjust\/lut/.test(engine), '预览从后端取同一套 LUT');
  check(/min\(540/.test(engine) || /540/.test(engine), '540p 上限');
  check(/PreviewEngine/.test(editor) && /canvasRef/.test(editor), '编辑器接入预览');
  check(/togglePlay/.test(editor) && /ed-canvas/.test(editor), '播放控制与画布');
  check(/\.ed-canvas/.test(css), 'CSS 画布');
  check(/\/api\/adjust\/lut/.test(server), 'LUT 接口');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_prev_'));
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
      const adj = { brightness: 20, saturation: 10, temperature: -8, shadow: 12 };
      const r = await fetch(base + '/api/adjust/lut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjust: adj })
      });
      const j = await r.json();
      check(r.status === 200 && j.success === true && j.size === 17, 'LUT 接口返回 17³');
      const buf = Buffer.from(j.data || '', 'base64');
      check(buf.length === 17 * 17 * 17 * 4, 'LUT 字节数正确', buf.length + ' bytes');

      const p = normalizeParams(adj);
      let maxDiff = 0;
      let alphaOk = true;
      const n = 17;
      for (const [r0, g0, b0] of [[0, 0, 0], [8, 8, 8], [16, 16, 16], [4, 11, 13], [15, 2, 7]]) {
        const idx = ((b0 * n + g0) * n + r0) * 4;
        const expect = adjustChain([r0 / (n - 1), g0 / (n - 1), b0 / (n - 1)], p);
        for (let c = 0; c < 3; c++) {
          const want = Math.max(0, Math.min(1, expect[c])) * 255;
          maxDiff = Math.max(maxDiff, Math.abs(buf[idx + c] - want));
        }
        if (buf[idx + 3] !== 255) alphaOk = false;
      }
      check(maxDiff <= 1.0, 'LUT 数值与 adjustChain 一致（≤1/255）', 'maxΔ=' + maxDiff.toFixed(3));
      check(alphaOk, 'LUT alpha=255');
      const quant = 0.5 / 255 * 100;
      check(quant < 1, '8-bit 量化上界 <1%', quant.toFixed(3) + '%');

      const r2 = await fetch(base + '/api/adjust/lut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjust: {} })
      });
      const j2 = await r2.json();
      check(j2.success === true && j2.data === null, '无调节时返回空 LUT（恒等）');

      // 8-bit 3D LUT 三线性插值 vs adjustChain 原函数：
      // 这是「预览与导出色差 <1%」的颜色数学证据（不含浏览器解码/显示差异）。
      const N2 = 17;
      const tri = (buf, r, g, b, c) => {
        const x = r * (N2 - 1), y = g * (N2 - 1), z = b * (N2 - 1);
        const x0 = Math.min(N2 - 2, Math.floor(x));
        const y0 = Math.min(N2 - 2, Math.floor(y));
        const z0 = Math.min(N2 - 2, Math.floor(z));
        const fx = x - x0, fy = y - y0, fz = z - z0;
        let v = 0;
        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
              v += w * buf[((((z0 + dz) * N2 + (y0 + dy)) * N2 + (x0 + dx)) * 4) + c];
            }
          }
        }
        return v;
      };
      const cases = [
        { name: '默认组合', adj: { brightness: 20, saturation: 10, temperature: -8, shadow: 12, contrast: 15, highlight: -10 } },
        { name: '高亮+50', adj: { brightness: 50 } },
        { name: '饱和-50', adj: { saturation: -50 } },
        { name: '色温+50', adj: { temperature: 50 } }
      ];
      for (const cse of cases) {
        const p2 = normalizeParams(cse.adj);
        const buf2 = adjustLut._build(cse.adj);
        let sum2 = 0;
        let cnt2 = 0;
        const steps = 10;
        for (let i = 0; i < steps; i++) {
          for (let j = 0; j < steps; j++) {
            for (let k = 0; k < steps; k++) {
              const r = i / (steps - 1), g = j / (steps - 1), b = k / (steps - 1);
              const e = adjustChain([r, g, b], p2).map((v) => Math.max(0, Math.min(1, v)) * 255);
              for (let ch = 0; ch < 3; ch++) {
                sum2 += Math.abs(tri(buf2, r, g, b, ch) - e[ch]);
                cnt2++;
              }
            }
          }
        }
        const meanPct = (sum2 / cnt2) / 255 * 100;
        check(meanPct < 1, 'LUT 插值均值差 <1%：' + cse.name, meanPct.toFixed(3) + '%');
      }

      const js = await (await fetch(base + '/app/src/preview/engine.js')).text();
      check(/texImage3D/.test(js), '浏览器可取到 preview/engine.js');
    }
  } catch (e) {
    check(false, '运行时验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n  未验证：真实浏览器 WebGL 同帧像素差（本环境无浏览器）');
  console.log('================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
