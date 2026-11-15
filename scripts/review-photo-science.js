// 科学/物理审查 CLI：后台标记图片是否可交付。
// 用法：node scripts/review-photo-science.js <photoId> <passed|failed|unchecked> ["备注"]
// 只写本地照片库元数据，不改图片、不调用模型、不产生费用。
const photoLibrary = require('../src/photoLibrary');

const [id, status, ...rest] = process.argv.slice(2);
if (!id || !['passed', 'failed', 'unchecked'].includes(status)) {
  console.error('用法: node scripts/review-photo-science.js <photoId> <passed|failed|unchecked> ["备注"]');
  process.exit(1);
}
const photo = photoLibrary.get(id);
if (!photo) {
  console.error('图片不存在: ' + id);
  process.exit(1);
}
const note = rest.join(' ').trim();
const updated = photoLibrary.update(id, {
  scienceStatus: status,
  scienceNotes: note,
  scienceReviewedAt: new Date().toISOString()
});
console.log(JSON.stringify({ id: updated.id, scienceStatus: updated.scienceStatus, scienceNotes: updated.scienceNotes, isFinal: updated.isFinal }, null, 2));
