// ============================================================
// 配乐上传验收（2026-11-10）
// ------------------------------------------------------------
// 现状（读码，改前）：`src/processors/audioMixer.js` 的 addTrack 已支持 fileData(base64)
//   → 写 `assets/bgm/custom/<id><ext>` + append manifest；但：
//   · 前端**没有上传入口**（配乐页只能填元信息，提示「手工放 mp3」）；
//   · 后端没有任何大小/内容校验（base64 乱填也会落盘一个坏文件）。
// 本任务：加前端上传（FileReader + 音频时长）+ 后端大小/格式校验；零新依赖。
//
// 本脚本：静态接线 + 起临时服务真传（隔离 BGM_DIR，不碰真实 assets/bgm）。
// 用法：node scripts/verify-bgm-upload.js
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const START_PORT = Number(process.env.BGM_UPLOAD_PORT || 3916);
const guard = require('./_bgm-guard');

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ping(url, ms = 800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return (await fetch(url, { signal: ac.signal })).status; } catch (e) { return 0; } finally { clearTimeout(timer); }
}
async function waitReady(base, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await ping(base + '/api/status')) return true; await sleep(400); }
  return false;
}

(async () => {
  console.log('================================================================');
  console.log('配乐上传验收（前端入口 + 后端大小/格式校验）');
  console.log('================================================================');

  const invSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'screens', 'inventory.js'), 'utf8');
  const mixerSrc = fs.readFileSync(path.join(ROOT, 'src', 'processors', 'audioMixer.js'), 'utf8');

  // ---------- 1. 静态 ----------
  check(/type="file"[^>]*accept="[^"]*audio/.test(invSrc), '配乐页有音频文件选择框（accept audio）');
  check(/FileReader/.test(invSrc) && /readAsDataURL/.test(invSrc), '用 FileReader 读成 dataURL');
  check(/fileData/.test(invSrc), '上传时把文件内容放进 fileData');
  check(/MAX_AUDIO_MB\s*=\s*20/.test(invSrc) && /MAX_AUDIO_MB\s*\*\s*1024\s*\*\s*1024/.test(invSrc), '前端有 20MB 上限提示/校验');
  check(/durationSec/.test(invSrc), '前端会上报音频时长（避免后端读 stdout）');
  check(/BGM_DIR/.test(mixerSrc) && /process\.env\.BGM_DIR/.test(mixerSrc), '后端 BGM_DIR 支持环境覆盖（测试隔离）');
  check(/MAX_AUDIO_BYTES|20971520|20 \* 1024 \* 1024/.test(mixerSrc), '后端有音频大小上限');
  check(/TOO_LARGE|过大/.test(mixerSrc), '后端对超大文件给明确错误');
  check(/不是合法 base64|base64/.test(mixerSrc), '后端校验 base64');

  // ---------- 2. 真传（临时服务 + 临时 BGM_DIR） ----------
  const realBefore = guard.snapshotRealBgm();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm_upload_'));
  const bgmDir = path.join(tmp, 'bgm');
  let child = null;
  let base = null;
  try {
    // 造一个 1 秒的 wav（ffmpeg 自带，不联网）
    let ffmpeg = null;
    try { ffmpeg = require(path.join(ROOT, 'config')).FFMPEG_PATH; } catch (e) {}
    const wavPath = path.join(tmp, 'test1s.wav');
    if (ffmpeg && fs.existsSync(ffmpeg)) {
      execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '44100', '-ac', '1', wavPath], { stdio: 'ignore', timeout: 30000 });
    }
    const hasWav = fs.existsSync(wavPath) && fs.statSync(wavPath).size > 1000;
    check(hasWav, '测试音频已生成（1s wav）', hasWav ? fs.statSync(wavPath).size + ' 字节' : 'ffmpeg 不可用');

    for (let i = 0; i < 6 && !child; i++) {
      const port = START_PORT + i;
      const candidate = `http://${HOST}:${port}`;
      if (await ping(candidate + '/api/status')) continue;
      const c = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
          ...process.env, PORT: String(port), AUTH_ENABLED: 'false', DATABASE_TYPE: 'json',
          DATA_DIR: path.join(tmp, 'tasks'), OUTPUT_DIR: path.join(tmp, 'output'),
          PROJECTS_DIR: path.join(tmp, 'projects'), THUMBS_DIR: path.join(tmp, 'thumbs'),
          BGM_DIR: bgmDir
        },
        stdio: 'ignore', windowsHide: true
      });
      c.on('error', () => {});
      if (await waitReady(candidate)) { child = c; base = candidate; }
      else { try { c.kill(); } catch (e) {} }
    }
    check(!!child, '临时服务启动（BGM_DIR 已隔离到临时目录）');

    if (child && hasWav) {
      const b64 = fs.readFileSync(wavPath).toString('base64');
      const post = async (body) => {
        const r = await fetch(base + '/api/bgm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };

      const ok1 = await post({ fileName: 'test1s.wav', fileData: b64, title: '测试音轨', category: 'ambient', durationSec: 1 });
      check(ok1.status === 200 && ok1.json.success === true, '上传 wav → 200 success', JSON.stringify(ok1.json).slice(0, 120));
      const track = ok1.json.track || {};
      check(/^custom\//.test(track.file || ''), '落盘在 custom/ 子目录', track.file);
      check(track.title === '测试音轨' && track.category === 'ambient', '元信息（曲名/分类）保存');
      check(Number(track.durationSec) === 1, '时长按上报值保存', String(track.durationSec));

      const onDisk = path.join(bgmDir, track.file.replace(/\//g, path.sep));
      check(fs.existsSync(onDisk) && fs.statSync(onDisk).size === fs.statSync(wavPath).size, '磁盘文件字节数与上传一致', onDisk);
      check(fs.existsSync(path.join(bgmDir, 'manifest.json')), 'manifest.json 已写入临时 BGM_DIR');

      const list = await (await fetch(base + '/api/bgm')).json();
      check(list.total === 1 && list.tracks[0].id === track.id, 'GET /api/bgm 能查到新上传', `total=${list.total}`);

      const ok2 = await post({ fileName: '第二次.wav', fileData: b64, title: '第二首' });
      check(ok2.status === 200 && ok2.json.track.id !== track.id, '同名再传 → 新 id（不覆盖）');

      const badExt = await post({ fileName: 'evil.exe', fileData: b64, title: 'x' });
      check(badExt.status === 400 && /仅支持/.test(badExt.json.error || ''), '非法后缀 → 400', badExt.json.error);

      const badB64 = await post({ fileName: 'a.wav', fileData: '%%%%', title: 'x' });
      check(badB64.status === 400 && /base64|为空|不合法/.test(badB64.json.error || ''), '非法 base64 → 400', badB64.json.error);

      const noFile = await post({ title: 'no file' });
      check(noFile.status === 400 && /缺少音频文件/.test(noFile.json.error || ''), '缺文件 → 400');

      const huge = Buffer.alloc(20 * 1024 * 1024 + 1024, 0x55).toString('base64');
      const tooBig = await post({ fileName: 'huge.wav', fileData: huge, title: '大文件' });
      check(tooBig.status === 413 || (tooBig.status === 400 && /过大|20/.test(tooBig.json.error || '')),
        '超过 20MB → 413/400 且说明上限', `status=${tooBig.status} ${tooBig.json.error || ''}`);
    }
  } catch (e) {
    check(false, '运行时验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    if (child) { try { child.kill(); } catch (e) {} }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  // 隔离守卫：真实 assets/bgm 必须一个字节都没变
  const realCheck = guard.diffRealBgm(realBefore);
  check(realCheck.ok, '真实 assets/bgm 未被触碰', realCheck.message);

  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
