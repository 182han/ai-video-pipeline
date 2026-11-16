#!/usr/bin/env node
// ==========================================
// 验收：统一回收站 + 片段入库策略
// ==========================================
// 覆盖：
//   1) 片段删除 = 移入回收站（文件+条目），恢复后文件与条目都回来
//   2) 彻底删除后文件不可恢复
//   3) 白名单外的文件拒绝回收（防越界删）
//   4) 图片删除同样走回收站
//   5) 配乐（自定义轨）删除走回收站，恢复后清单条目写回
//   6) 质检失败片段（status=failed）也能入库；mock 片段不入库
//
// 隔离：全部指向临时目录（RECYCLE_DIR / CLIPS_DIR / LIBRARY_DIR / PHOTOS_DIR / BGM_DIR），
// 不碰真实库与素材。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-recycle-'));
const CLIPS = path.join(TMP, 'clips');
const LIB = path.join(TMP, 'library');
const PHOTOS = path.join(TMP, 'photos');
const BGM = path.join(TMP, 'bgm');
const OUT = path.join(TMP, 'output');
const RECYCLE = path.join(TMP, 'recycle');
for (const d of [CLIPS, LIB, PHOTOS, BGM, OUT, path.join(BGM, 'custom')]) fs.mkdirSync(d, { recursive: true });

process.env.CLIPS_DIR = CLIPS;
process.env.LIBRARY_DIR = LIB;
process.env.PHOTOS_DIR = PHOTOS;
process.env.BGM_DIR = BGM;
process.env.OUTPUT_DIR = OUT;
process.env.RECYCLE_DIR = RECYCLE;

const recycle = require('../src/recycle');
const library = require('../src/library');
const photoLibrary = require('../src/photoLibrary');
const audioMixer = require('../src/processors/audioMixer');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

function writeFile(p, content) { fs.writeFileSync(p, content || 'x'); return p; }

console.log('== 1. 片段：删除 → 回收站 → 恢复 → 彻底删除 ==');
const clipFile = writeFile(path.join(CLIPS, 't1_c1.mp4'), 'fake-video');
const clipEntry = {
  id: 't1_c1', kind: 'clip', fileName: 't1_c1.mp4', filePath: clipFile,
  url: '/clips/t1_c1.mp4', taskId: 't1', clipIndex: 0, status: 'success',
  prompt: '测试片段', cost: { amount: 1.23, computed: true }
};
library.upsert(clipEntry);
ok('删除前文件存在', fs.existsSync(clipFile));
const del = library.remove('t1_c1');
ok('remove 返回 trashed', del.success && del.trashed === true);
ok('删除后文件已离开 clips', !fs.existsSync(clipFile));
ok('回收站有一条 clip', recycle.list('clip').length === 1);
ok('库条目已删除', !library.get('t1_c1'));
const restored = recycle.restore('clip', 't1_c1');
ok('恢复返回原条目', restored.ok && restored.entry && restored.entry.id === 't1_c1');
ok('恢复后文件回到 clips', fs.existsSync(clipFile));
library.restoreFromRecycle(restored.entry);
ok('恢复后条目回到库', !!library.get('t1_c1'));

library.remove('t1_c1');
const purge = recycle.purge('clip', 't1_c1');
ok('彻底删除成功', purge.ok === true);
ok('彻底删除后文件不存在', !fs.existsSync(clipFile));
ok('回收站已空', recycle.list('clip').length === 0);

console.log('== 2. 白名单：拒绝回收库外文件 ==');
const outside = writeFile(path.join(TMP, 'outside.txt'), 'nope');
const bad = recycle.moveToRecycle({ type: 'clip', id: 'evil', files: [{ file: outside }], entry: {} });
ok('拒绝白名单外文件', bad.ok === false && /白名单/.test(bad.error || ''));
ok('库外文件未被移动', fs.existsSync(outside));

console.log('== 3. 图片：删除走回收站 ==');
const photoFile = writeFile(path.join(CLIPS, 'p1_img_0.png'), 'png');
const photoEntry = {
  id: 'p1_img_0', fileName: 'p1_img_0.png', filePath: photoFile, prompt: '测试图',
  status: 'approved', cost: { amount: 0.5, computed: true }
};
photoLibrary.upsert ? photoLibrary.upsert(photoEntry) : null;
// photoLibrary 导出的是 ingest/update，没有 upsert 时直接写文件
if (!photoLibrary.upsert) fs.writeFileSync(path.join(PHOTOS, 'p1_img_0.json'), JSON.stringify(photoEntry));
const pdel = photoLibrary.remove('p1_img_0');
ok('图片 remove 返回 trashed', pdel.success === true && pdel.trashed === true);
ok('图片文件已移走', !fs.existsSync(photoFile));
ok('回收站有一条 photo', recycle.list('photo').length === 1);
const prestore = recycle.restore('photo', 'p1_img_0');
ok('图片恢复成功', prestore.ok === true && fs.existsSync(photoFile));
if (prestore.ok) photoLibrary.restoreFromRecycle(prestore.entry);
ok('图片条目已写回', !!photoLibrary.get('p1_img_0'));

console.log('== 4. 配乐：自定义轨删除/恢复 ==');
const bgmFile = writeFile(path.join(BGM, 'custom', 'u_test.mp3'), 'mp3');
const track = { id: 'u_test', file: 'custom/u_test.mp3', title: '测试曲', category: 'music', durationSec: 120 };
fs.writeFileSync(path.join(BGM, 'manifest.json'), JSON.stringify([track], null, 2), 'utf8');
const bdel = audioMixer.removeTrack('u_test');
ok('配乐删除返回 trashed', bdel.success === true && bdel.trashed === true);
ok('配乐文件已移走', !fs.existsSync(bgmFile));
ok('配乐清单已移除', (audioMixer.getManifest() || []).filter(t => t.id === 'u_test').length === 0);
const brestore = recycle.restore('bgm', 'u_test');
ok('配乐恢复文件成功', brestore.ok === true && fs.existsSync(bgmFile));
if (brestore.ok) audioMixer.restoreTrack(brestore.entry);
ok('配乐清单已写回', (audioMixer.getManifest() || []).filter(t => t.id === 'u_test').length === 1);

console.log('== 5. 入库策略：失败片段入库 / mock 不入库 ==');
const realFile = writeFile(path.join(CLIPS, 't2_c1.mp4'), 'fake-video-2');
const task = { taskId: 't2', model: 'dashscope', resolution: '720p', clipDuration: 10, prompt: '任务' };
const failedClip = { index: 0, status: 'failed', videoPath: realFile, prompt: '失败片段', error: '质检未通过', cost: { amount: 1.2, computed: true } };
const failedEntry = library.ingestClip(task, failedClip);
ok('失败片段已入库', !!failedEntry && failedEntry.status === 'failed');
ok('失败片段保留了提示词与费用', failedEntry && failedEntry.prompt === '失败片段' && failedEntry.cost && failedEntry.cost.amount === 1.2);
const mockTask = { taskId: 't3', model: 'mock', resolution: '720p', clipDuration: 10 };
const mockFile = writeFile(path.join(CLIPS, 't3_c1.mp4'), 'mock');
const mockEntry = library.ingestClip(mockTask, { index: 0, status: 'success', videoPath: mockFile });
ok('mock 片段不入库', mockEntry === null);

console.log('== 6. 成片费用：无快照时不得伪装成 0 元 ==');
const finalFile = writeFile(path.join(OUT, 't4_final.mp4'), 'final');
const finalEntry = library.ingestFinal({ taskId: 't4', model: 'dashscope', status: 'completed', prompt: '成片' }, finalFile);
ok('成片入库成功', !!finalEntry && finalEntry.kind === 'final');
ok('无费用快照时 computed=false', finalEntry && finalEntry.cost && finalEntry.cost.computed === false);
ok('无费用快照时 label 明说未知', finalEntry && /未知/.test(finalEntry.cost.label || ''));
const finalEntry2 = library.ingestFinal({ taskId: 't5', model: 'dashscope', status: 'completed', prompt: '成片2', cost: { amount: 8.4, computed: true } }, writeFile(path.join(OUT, 't5_final.mp4'), 'final2'));
ok('有费用快照时金额正确', finalEntry2 && finalEntry2.cost.amount === 8.4 && finalEntry2.cost.computed === true);

console.log('== 7. 成片来源与删除 ==');
const orphanFinal = library.ingestFinal({ taskId: 't6', model: 'unknown', status: 'completed', prompt: '孤儿', __origin: 'orphan' }, writeFile(path.join(OUT, 't6_final.mp4'), 'f6'));
ok('孤儿成片 origin=orphan', orphanFinal && orphanFinal.origin === 'orphan');
const editorFinal = library.ingestFinal({ taskId: 't7', model: 'editor', status: 'completed', prompt: '剪辑' }, writeFile(path.join(OUT, 't7_final.mp4'), 'f7'));
ok('剪辑导出 origin=editor', editorFinal && editorFinal.origin === 'editor');
const fdel = library.remove('t6_final');
ok('成片删除走回收站（type=final）', fdel.success === true && fdel.trashed === true && recycle.list('final').length === 1);
ok('成片文件已离开 output', !fs.existsSync(path.join(OUT, 't6_final.mp4')));
const frestore = recycle.restore('final', 't6_final');
ok('成片恢复文件成功', frestore.ok === true && fs.existsSync(path.join(OUT, 't6_final.mp4')));

// 清理临时目录
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
