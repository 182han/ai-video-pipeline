// ============================================================
// F05 每段调节验收
// ------------------------------------------------------------
// 1) 静态：右侧滑杆绑定选中片段；导出把每段 adjust 传给 transitionMixer
// 2) 真机：同一组片段，调/不调各导出一次，比较画面均值；LUT 尺寸校验
//
// 用法：node scripts/verify-editor-adjust.js
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
  console.log('F05 每段调节验收');
  console.log('================================================================');

  const editor = read(path.join(WEB, 'src', 'screens', 'editor.js'));
  const exporter = read(path.join(ROOT, 'src', 'editorExporter.js'));
  const mixer = read(path.join(ROOT, 'src', 'processors', 'transitionMixer.js'));

  check(/ADJUST_GROUPS/.test(editor), '右侧调节分组');
  const keys = ['temperature', 'tone', 'saturation', 'brightness', 'contrast', 'highlight', 'shadow', 'white', 'black', 'lightSensation'];
  check(keys.every((k) => editor.includes("'" + k + "'")), '10 个调节键齐全');
  check(/function setAdjust\(/.test(editor) && /scheduleSegSave\(\)/.test(editor), '调参写入工程并防抖保存');
  check(/selectedSeg/.test(editor) && /ed-slider-input/.test(editor), '滑杆绑定选中片段');
  check(/function resetAdjust\(/.test(editor), '重置本段');
  check(/onPointerDown=\$\{historyPush\}/.test(editor), '拖动滑杆前记撤销点');
  check(/adjust: seg\.adjust \|\| null/.test(exporter), '导出把每段 adjust 传下去');
  check(/buildCubeText/.test(mixer) && /lut3d=/.test(mixer), '导出把参数烘成 LUT');

  const cube = tm._buildCubeText({ brightness: 10, saturation: 5 }, 'test');
  const lines = cube.split('\n').filter((l) => l && !/^TITLE|^LUT_3D_SIZE|^DOMAIN_/.test(l));
  check(cube.includes('LUT_3D_SIZE 17'), 'LUT 尺寸 17³');
  check(lines.length === Math.pow(17, 3), 'LUT 数据行数正确', lines.length + ' 行');

  const items = lib.listAll().filter((i) => i.filePath && fs.existsSync(i.filePath)).slice(0, 2);
  check(items.length === 2, '片段库有 2 条可用素材');
  if (items.length < 2) return finish();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_adj_'));
  const base = items.map((e) => ({
    path: e.filePath,
    inSec: 0,
    outSec: Math.min(2, Number(e.durationSec) || 2),
    detail: tm._probeMedia(e.filePath)
  }));

  try {
    const onPath = path.join(tmp, 'on.mp4');
    const on = await tm.concatWithTransitions(
      base.map((c, i) => ({ ...c, adjust: i === 0 ? { brightness: 35, saturation: 25 } : { temperature: -20 } })),
      onPath, { duration: 0.4, type: 'fade', ignoreAudio: true }
    );
    check(on.success === true, '带调节导出成功', on.error || '');
    check(on.adjust && on.adjust.applied === 2, '两段 LUT 都烘焙', on.adjust ? String(on.adjust.applied) : '无');

    const offPath = path.join(tmp, 'off.mp4');
    const off = await tm.concatWithTransitions(base, offPath, { duration: 0.4, type: 'fade', ignoreAudio: true });
    check(off.success === true, '无调节导出成功', off.error || '');
    check(off.adjust && off.adjust.applied === 0, '无调节时 LUT 数为 0');

    if (on.success && off.success) {
      const a = tm._sampleRgbStats(onPath, on.actualDuration);
      const b = tm._sampleRgbStats(offPath, off.actualDuration);
      const diff = [0, 1, 2].map((i) => Math.abs(a.mean[i] - b.mean[i]));
      const maxDiff = Math.max(...diff);
      check(maxDiff > 8, '调参后画面均值明显变化', 'ΔRGB=' + diff.map((d) => d.toFixed(1)).join('/'));
      check(Math.abs(on.actualDuration - 3.6) < 0.3, '带调节时长正确', String(on.actualDuration));
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
