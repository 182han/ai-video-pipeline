// ============================================================
// F09 转场控件验收
// ------------------------------------------------------------
// 1) 静态：右侧转场开关/时长/类型；导出把 enabled 传下去；mixer 有关闭分支
// 2) 真机：同一组片段 开/关 各导出一次
//    开：时长 = Σd − (N−1)F；关：时长 = Σd，transitionType=none
//    关 + 调节：画面仍按 LUT 变化（直拼不丢逐段调节）
//
// 用法：node scripts/verify-editor-transition-controls.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const tm = require('../src/processors/transitionMixer');
const lib = require('../src/library');

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  —  ' + extra : ''}`); }
}
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  console.log('================================================================');
  console.log('F09 转场控件验收');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const exporter = read(path.join(ROOT, 'src', 'editorExporter.js'));
  const mixer = read(path.join(ROOT, 'src', 'processors', 'transitionMixer.js'));

  check(/ed-transition/.test(editor), '右侧转场区块');
  check(/commitTransition/.test(editor), '转场修改写工程');
  check(/type="checkbox"/.test(editor) && /enabled: e\.target\.checked/.test(editor), '转场开关');
  check(/ed-select/.test(editor) && /duration: Number/.test(editor) && /type: e\.target\.value/.test(editor), '时长/类型选择');
  check(/enabled: t\.enabled !== false/.test(exporter), '导出传 enabled');
  check(/transitionEnabled/.test(mixer) && /concat=n=/.test(mixer), 'mixer 关闭走 concat');
  check(/transitionType: type/.test(mixer) && /transitions: transitionEnabled/.test(mixer), '关闭时回报 none');

  const items = lib.listAll().filter((i) => i.filePath && fs.existsSync(i.filePath)).slice(0, 2);
  check(items.length === 2, '片段库有 2 条素材');
  if (items.length < 2) return finish();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_tr_'));
  const base = items.map((e) => ({
    path: e.filePath,
    inSec: 0,
    outSec: Math.min(2, Number(e.durationSec) || 2),
    detail: tm._probeMedia(e.filePath)
  }));

  try {
    const on = await tm.concatWithTransitions(base, path.join(tmp, 'on.mp4'), {
      enabled: true, duration: 0.4, type: 'fade', ignoreAudio: true
    });
    check(on.success === true, '开启转场导出成功', on.error || '');
    if (on.success) {
      check(on.transitions === 1 && Math.abs(on.actualDuration - 3.6) < 0.2, '开启：3.6s + 1 个接缝', on.actualDuration + 's');
    }

    const off = await tm.concatWithTransitions(base, path.join(tmp, 'off.mp4'), {
      enabled: false, duration: 0.4, type: 'fade', ignoreAudio: true
    });
    check(off.success === true, '关闭转场导出成功', off.error || '');
    if (off.success) {
      check(off.transitionType === 'none' && off.transitions === 0 && off.fadeDuration === 0, '关闭：无叠化', off.transitionType);
      check(Math.abs(off.actualDuration - 4.0) < 0.2, '关闭：时长 = Σd = 4.0s', off.actualDuration + 's');
    }

    const offAdj = await tm.concatWithTransitions(
      base.map((c, i) => ({ ...c, adjust: i === 0 ? { brightness: 35 } : null })),
      path.join(tmp, 'off_adj.mp4'),
      { enabled: false, duration: 0.4, type: 'fade', ignoreAudio: true }
    );
    check(offAdj.success === true, '关闭 + 调节导出成功', offAdj.error || '');
    if (offAdj.success && off.success) {
      const a = tm._sampleRgbStats(path.join(tmp, 'off_adj.mp4'), offAdj.actualDuration);
      const b = tm._sampleRgbStats(path.join(tmp, 'off.mp4'), off.actualDuration);
      const maxDiff = Math.max(...[0, 1, 2].map((i) => Math.abs(a.mean[i] - b.mean[i])));
      check(maxDiff > 5, '直拼仍逐段套 LUT', 'ΔRGB=' + maxDiff.toFixed(1));
      check(offAdj.adjust && offAdj.adjust.applied === 1, 'LUT 数量 = 1', String(offAdj.adjust && offAdj.adjust.applied));
    }
  } catch (e) {
    check(false, '真机验收异常: ' + (e && e.message ? e.message : e));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  finish();
})();

function finish() {
  console.log('\n================================================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  console.log('================================================================');
  process.exit(fail === 0 ? 0 : 1);
}
