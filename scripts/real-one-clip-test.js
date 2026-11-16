// ============================================================
// 真实单条测试（用户 2026-11-13 明确授权：1 张图 + 1 段 5 秒 720p 视频）
//
// 不走完整 QC（避免再要多模态 Key）；只验证：
//   图片生成 → 逐图调色 → 百炼临时上传 oss:// → wan3.0 图生视频 → 下载
//
// Key 从本地文件读取，不打印、不写日志。
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
require('../src/generators/imageProviders');
const { ImageGenerator } = require('../src/generators/imageGen');
const autoGrade = require('../src/processors/autoGrade');
const dashscopeUpload = require('../src/generators/dashscopeUpload');
const DashScopeGenerator = require('../src/generators/dashscope');
const videoProcessor = require('../src/videoProcessor');

const KEY_FILE = 'C:/Users/14872/Desktop/测试/.dashscope-test-key';
const BASE = 'https://dashscope.aliyuncs.com/api/v1';
const MODEL = 'wan3.0-video';
const IMAGE_MODEL = 'wan2.7-image';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const lines = fs.readFileSync(KEY_FILE, 'utf8').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  // 4 个 Key 中只有最长的是 DashScope 工作空间 Key；不打印值。
  const key = lines.find(x => x.length >= 80) || '';
  if (!key) throw new Error('Key 文件里没找到 DashScope Key（应有一行较长的 sk-w...）');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const taskId = 'real_test_' + Date.now().toString(36);
  const outDir = path.join(config.STORAGE.outputDir, 'real-test-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const rec = { taskId, startedAt: new Date().toISOString(), imagePrompt: '', videoPrompt: '', steps: {} };

  const imagePrompt = '雪山冰川日出，广角，冷调，云海在山谷间缓慢流动，电影感自然光，画面干净';
  const videoPrompt = '镜头缓慢向前推进，云海流动，晨光逐渐变亮，雪山细节清晰，电影感，画面稳定';
  rec.imagePrompt = imagePrompt;
  rec.videoPrompt = videoPrompt;

  console.log('[1/4] 生成 1 张图…');
  const imageGen = new ImageGenerator({
    provider: 'dashscope',
    model: IMAGE_MODEL,
    IMAGE_GEN_API_KEY: key,
    IMAGE_GEN_BASE_URL: BASE,
    IMAGE_GEN_MODEL: IMAGE_MODEL,
    IMAGE_GEN_SIZE: '1696x960'
  });
  const img = await imageGen.generateImage(imagePrompt, {
    taskId, index: 0, size: '1696x960', outDir
  });
  if (!img || !img.imagePath || !fs.existsSync(img.imagePath)) throw new Error('出图失败：没有 imagePath');
  rec.steps.image = { path: img.imagePath, provider: img.provider, model: img.model, width: img.width, height: img.height };
  console.log('    图片:', img.imagePath);

  console.log('[2/4] 逐图调色…');
  const graded = path.join(outDir, 'graded.png');
  const grade = await autoGrade.autoGradeImage(img.imagePath, graded, { palette: 'calm' });
  rec.steps.grade = { path: graded, before: grade.before, after: grade.after, params: grade.params };
  console.log('    调色: 饱和度', grade.before.sat, '->', grade.after.sat);

  console.log('[3/4] 上传百炼临时 OSS…');
  const up = await dashscopeUpload.uploadFile(graded, { apiKey: key, baseUrl: BASE, model: MODEL });
  rec.steps.upload = { url: up.url, key: up.key, expireInSeconds: up.expireInSeconds };
  console.log('    oss:', up.url);

  console.log('[4/4] 提交 wan3.0 图生视频（5s/720p，单次不重试）…');
  const gen = new DashScopeGenerator({ apiKey: key, baseUrl: BASE, modelId: MODEL });
  const sub = await gen.generate(videoPrompt, {
    image: { url: up.url }, duration: 5, resolution: '720p', aspectRatio: '16:9'
  });
  rec.steps.submit = { taskId: sub.taskId };
  console.log('    DashScope task:', sub.taskId);

  let status = null;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    status = await gen.getStatus(sub.taskId);
    if (status.status === 'completed') break;
    if (status.status === 'failed') throw new Error('视频生成失败: ' + (status.error || 'unknown'));
    if (i % 6 === 0) console.log('    等待中…', status.status, Math.round((Date.now() - started) / 1000) + 's');
  }
  if (!status || status.status !== 'completed' || !status.videoUrl) throw new Error('视频生成超时/没有 videoUrl');
  rec.steps.video = { url: status.videoUrl, taskId: sub.taskId };
  console.log('    视频 URL 已返回，开始下载…');

  const res = await fetch(status.videoUrl);
  if (!res.ok) throw new Error('下载视频失败 HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const clipPath = path.join(outDir, 'clip.mp4');
  fs.writeFileSync(clipPath, buf);
  rec.steps.download = { path: clipPath, bytes: buf.length };

  const probe = videoProcessor.probeDetail(clipPath);
  rec.probe = probe;
  rec.elapsedMs = Date.now() - started;
  rec.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(rec, null, 2), 'utf8');

  console.log('================================================================');
  console.log('完成:', clipPath);
  console.log('大小:', buf.length, 'bytes | 时长:', probe.duration, 's | 分辨率:', probe.width + 'x' + probe.height);
  console.log('结果 JSON:', path.join(outDir, 'result.json'));
  console.log('产物目录:', outDir);
})().catch((e) => {
  console.error('REAL_TEST_FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
