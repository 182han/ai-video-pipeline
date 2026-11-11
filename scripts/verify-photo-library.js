// ============================================================
// 图片库验收（2026-11-11 用户口径：生成的图片要入库、保留提示词、可人工审核）
// ------------------------------------------------------------
// 隔离运行：PHOTOS_DIR / CLIPS_DIR 指向临时目录，绝不碰真实 data/photos 与 clips/。
// 不联网、不调厂商、不计费。
// 用法：node scripts/verify-photo-library.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-lib-'));
process.env.PHOTOS_DIR = path.join(tmp, 'photos');
process.env.CLIPS_DIR = path.join(tmp, 'clips');
fs.mkdirSync(process.env.CLIPS_DIR, { recursive: true });

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  —  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  —  ' + extra : ''}`); }
}

// 1x1 PNG（67 字节），足够通过「文件存在且 >8 字节」的校验
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function makeImage(name, bytes) {
  const p = path.join(process.env.CLIPS_DIR, name);
  fs.writeFileSync(p, bytes || PNG_1PX);
  return p;
}

console.log('================================================================');
console.log('图片库：入库 / 提示词保留 / 审核 / 删除 / 回填扫描');
console.log('================================================================');

const photoLibrary = require(path.join(APP, 'src', 'photoLibrary'));

// ---- 1. 入库 + 提示词原样保留 ----
const PROMPT = '雪山日出，低雾，侧逆光，缓慢推近；这是要原样保存的提示词 #1';
const imgPath = makeImage('task_demo1_img_0.png');
const rec = photoLibrary.ingest({
  id: photoLibrary.makeId('task_demo1', 0),
  taskId: 'task_demo1',
  index: 0,
  filePath: imgPath,
  prompt: PROMPT,
  provider: 'openai-images',
  model: 'seedream',
  size: '1696x960',
  width: 1696,
  height: 960
});
check(!!rec && rec.id === 'task_demo1_img_0', '入库生成 id <taskId>_img_<index>', rec && rec.id);
check(rec.prompt === PROMPT, '提示词原样保留（不截断、不改写）');
check(rec.promptAvailable === true, 'promptAvailable 标记为 true');
check(rec.status === 'pending', '新图默认 pending（待审）');
check(rec.sizeBytes > 8 && rec.width === 1696 && rec.height === 960, '文件大小与宽高已记录');
check(photoLibrary.listAll().some((x) => x.id === rec.id), 'listAll 能读到刚入库的图');

// ---- 2. 审核状态 ----
photoLibrary.markReviewed(rec.id, 'approved');
check(photoLibrary.get(rec.id).status === 'approved', 'markReviewed 可改为 approved');
check(!!photoLibrary.get(rec.id).reviewedAt, '审核时间已记录');
let bad = false;
try { photoLibrary.markReviewed(rec.id, 'whatever'); } catch (e) { bad = true; }
check(bad, '非法审核状态被拒（只允许 pending/approved/rejected）');
check(photoLibrary.totals(photoLibrary.listAll()).approved === 1, 'totals 统计 approved=1');

// ---- 3. 幂等：重复登记不覆盖审核状态 ----
photoLibrary.ingest({ id: rec.id, taskId: 'task_demo1', index: 0, filePath: imgPath, prompt: PROMPT });
check(photoLibrary.get(rec.id).status === 'approved', '重复 ingest 不会把 approved 重置成 pending');

// ---- 4. 查询过滤 ----
check(photoLibrary.query({ status: 'approved' }).length === 1, '按状态过滤可用');
check(photoLibrary.query({ q: '雪山日出' }).length === 1, '按提示词搜索可用');
check(photoLibrary.query({ q: '不存在的词' }).length === 0, '搜索不命中返回空');

// ---- 5. 回填扫描 ----
const extra = makeImage('task_demo2_img_0.png');
const missing = photoLibrary.listUnregisteredImages();
check(missing.length === 1 && missing[0].fileName === 'task_demo2_img_0.png', '能扫描出未入库的出图文件', String(missing.length));
check(missing[0].id === 'task_demo2_img_0', '回填 id 规则与出图命名一致');
photoLibrary.ingest({ id: missing[0].id, taskId: 'task_demo2', index: 0, filePath: extra, prompt: '', source: 'backfill' });
check(photoLibrary.get('task_demo2_img_0').promptAvailable === false, '回填图无提示词时 promptAvailable=false（不伪造）');
check(photoLibrary.listUnregisteredImages().length === 0, '登记后再扫描为空');

// ---- 6. 删除（记录 + 源文件） ----
const r = photoLibrary.remove(rec.id);
check(r.success === true && r.fileDeleted === true, 'remove 同时删除库记录与源文件');
check(!fs.existsSync(imgPath), '源文件确实被删掉');
check(photoLibrary.get(rec.id) === null, '删除后查询不到');

// ---- 7. 防越界：不在 clips 目录里的文件不许删 ----
const outside = path.join(tmp, 'outside.png');
fs.writeFileSync(outside, PNG_1PX);
photoLibrary.ingest({ id: 'task_out_img_0', taskId: 'task_out', index: 0, filePath: outside, prompt: 'x' });
photoLibrary.remove('task_out_img_0');
check(fs.existsSync(outside), 'clips 目录外的文件不会被删（防越界）');

// ---- 8. 静态接线 ----
const serverSrc = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
const pipelineSrc = fs.readFileSync(path.join(APP, 'src', 'pipeline.js'), 'utf8');
const createSrc = fs.readFileSync(path.join(APP, 'web', 'src', 'screens', 'create.js'), 'utf8');
const invSrc = fs.readFileSync(path.join(APP, 'web', 'src', 'screens', 'inventory.js'), 'utf8');
const i2vSrc = fs.readFileSync(path.join(APP, 'src', 'generators', 'i2vSupport.js'), 'utf8');

check(serverSrc.includes("app.get('/api/photos'"), 'server.js 注册 GET /api/photos');
check(serverSrc.includes("app.put('/api/photos/:id'"), 'server.js 注册 PUT /api/photos/:id');
check(serverSrc.includes("app.delete('/api/photos/:id'"), 'server.js 注册 DELETE /api/photos/:id');
check(serverSrc.includes('photoLibrary.ingest({'), '出图接口成功后自动入库');
check(serverSrc.includes('i2vModels: listI2VModels()'), '/api/image-gen/status 暴露 i2vModels');
check(serverSrc.includes('sourcePhotoId'), '/api/tasks 接受 sourcePhotoId');
check(pipelineSrc.includes('_i2vPayload(task)'), 'pipeline 有图生视频取图逻辑');
check(pipelineSrc.includes('image: i2vImage'), 'pipeline 把源图传给视频适配器');
check(createSrc.includes('sourcePhotoId: imgResult.photoId'), '创作向导提交 sourcePhotoId');
check(invSrc.includes('/api/photos'), '照片页接的是 /api/photos（不再是占位）');
check(i2vSrc.includes("kling:") && i2vSrc.includes("seedance:"), 'i2v 能力表包含 kling/seedance');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n================================================================');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log('================================================================');
process.exit(fail === 0 ? 0 : 1);
