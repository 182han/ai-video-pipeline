// 从已生成的真图继续：调色 → C 上传 → wan3.0 5s → 下载。
// 不重新生成图，避免重复付费；用于补齐被临时的 ffmpeg TEMP 权限问题打断的那一条。
const fs = require('fs');
const path = require('path');
const config = require('../config');
const autoGrade = require('../src/processors/autoGrade');
const dashscopeUpload = require('../src/generators/dashscopeUpload');
const DashScopeGenerator = require('../src/generators/dashscope');
const videoProcessor = require('../src/videoProcessor');

const KEY_FILE = 'C:/Users/14872/Desktop/测试/.dashscope-test-key';
const BASE = 'https://dashscope.aliyuncs.com/api/v1';
const MODEL = 'wan3.0-video';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const lines = fs.readFileSync(KEY_FILE, 'utf8').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const key = lines.find(x => x.length >= 80) || '';
  if (!key) throw new Error('Key 文件里没找到 DashScope Key');

  const root = config.STORAGE.outputDir;
  const dirs = fs.readdirSync(root).filter(d => d.startsWith('real-test-')).sort();
  const dir = path.join(root, dirs[dirs.length - 1]);
  const imgPath = fs.readdirSync(dir).find(f => /_img_0\.(png|jpg|jpeg|webp)$/i.test(f));
  if (!imgPath) throw new Error('最新 real-test 目录里没有已生成的图');
  const image = path.join(dir, imgPath);
  console.log('RESUME_IMAGE', image);

  const imagePrompt = '雪山冰川日出，广角，冷调，云海在山谷间缓慢流动，电影感自然光，画面干净';
  const videoPrompt = '镜头缓慢向前推进，云海流动，晨光逐渐变亮，雪山细节清晰，电影感，画面稳定';
  const started = Date.now();
  const rec = {
    taskId: 'resume_' + Date.now().toString(36),
    resumedFromImage: image,
    imagePrompt,
    videoPrompt,
    steps: {}
  };

  console.log('[1/3] 调色…');
  const graded = path.join(dir, 'graded.png');
  const grade = await autoGrade.autoGradeImage(image, graded, { palette: 'calm' });
  rec.steps.grade = { path: graded, before: grade.before, after: grade.after, params: grade.params };
  console.log('    饱和度', grade.before.sat, '->', grade.after.sat);

  console.log('[2/3] 上传百炼临时 OSS…');
  const up = await dashscopeUpload.uploadFile(graded, { apiKey: key, baseUrl: BASE, model: MODEL });
  rec.steps.upload = { url: up.url, key: up.key, expireInSeconds: up.expireInSeconds };
  console.log('    oss:', up.url);

  console.log('[3/3] wan3.0 图生视频 5s/720p（单次）…');
  const gen = new DashScopeGenerator({ apiKey: key, baseUrl: BASE, modelId: MODEL });
  const sub = await gen.generate(videoPrompt, {
    image: { url: up.url }, duration: 5, resolution: '720p', aspectRatio: '16:9'
  });
  rec.steps.submit = { taskId: sub.taskId };
  console.log('    task:', sub.taskId);

  let status = null;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    status = await gen.getStatus(sub.taskId);
    if (status.status === 'completed') break;
    if (status.status === 'failed') throw new Error('视频生成失败: ' + (status.error || 'unknown'));
    if (i % 6 === 0) console.log('    等待…', status.status, Math.round((Date.now() - started) / 1000) + 's');
  }
  if (!status || status.status !== 'completed' || !status.videoUrl) throw new Error('视频生成超时/无 videoUrl');
  rec.steps.video = { url: status.videoUrl, taskId: sub.taskId };
  console.log('    下载视频…');
  const res = await fetch(status.videoUrl);
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const clip = path.join(dir, 'clip.mp4');
  fs.writeFileSync(clip, buf);
  const probe = videoProcessor.probeDetail(clip);
  rec.steps.download = { path: clip, bytes: buf.length };
  rec.probe = probe;
  rec.elapsedMs = Date.now() - started;
  rec.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(rec, null, 2), 'utf8');

  console.log('================================================================');
  console.log('完成:', clip);
  console.log('大小:', buf.length, 'bytes | 时长:', probe.duration, 's | 分辨率:', probe.width + 'x' + probe.height);
  console.log('结果:', path.join(dir, 'result.json'));
})().catch((e) => {
  console.error('RESUME_FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
