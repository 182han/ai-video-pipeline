// 用户明确授权：2026-11-14 跑 1 条 1080P 真实对比测试。
// 1 张 wan2.7-image（1920×1080）→ 调色 → C 临时上传 → 1 段 wan3.0 5s 1080P → 下载。
// 单次不重试；产物全部保留在 output/real-test-1080-*。
const fs = require('fs');
const path = require('path');
const config = require('../config');
require('../src/generators/imageProviders');
const { ImageGenerator } = require('../src/generators/imageGen');
const autoGrade = require('../src/processors/autoGrade');
const dashscopeUpload = require('../src/generators/dashscopeUpload');
const DashScopeGenerator = require('../src/generators/dashscope');
const videoProcessor = require('../src/videoProcessor');
const pricing = require('../src/pricing');

const KEY_FILE = 'C:/Users/14872/Desktop/测试/.dashscope-test-key';
const BASE = 'https://dashscope.aliyuncs.com/api/v1';
const MODEL = 'wan3.0-video';
const IMAGE_MODEL = 'wan2.7-image';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const IMAGE_PROMPT = [
  '清晨的高原雪山，侧逆光，空气透视，薄雾与轻霾，',
  '云海呈破碎层状、局部露出山脊，前景有深色岩壁作框，山体不对称，',
  '真实自然摄影，50mm，f/8，柔和低微对比，自然色，4–6%胶片颗粒，',
  '未经过度锐化，真实天气，中远景，画面有纵深'
].join('');

const NEGATIVE_PROMPT = [
  'HDR', '过曝', '过度锐化', '高微对比', '塑料感', '蜡感', 'CG', '3D渲染',
  '完美对称', '重复纹理', '无雾', '过饱和', '商业海报', '8K超清',
  '锐利山脊', '云海像固体地毯'
].join('，');

const VIDEO_PROMPT = [
  '镜头缓慢向前推进，云层缓慢流动，晨光逐渐变亮，',
  '山脊细节自然，轻微空气流动，真实纪录片摄影，画面稳定，不加速，不闪烁，自然低对比'
].join('');

(async () => {
  const lines = fs.readFileSync(KEY_FILE, 'utf8').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const key = lines.find(x => x.length >= 80) || '';
  if (!key) throw new Error('Key 文件里没找到 DashScope Key');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const taskId = 'real_test_1080_' + Date.now().toString(36);
  const outDir = path.join(config.STORAGE.outputDir, 'real-test-1080-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const rec = {
    taskId, startedAt: new Date().toISOString(), resolution: '1080p',
    imagePrompt: IMAGE_PROMPT, negativePrompt: NEGATIVE_PROMPT, videoPrompt: VIDEO_PROMPT,
    steps: {}
  };

  console.log('[1/5] 生成 1920×1080 图片…');
  const imageGen = new ImageGenerator({
    provider: 'dashscope', model: IMAGE_MODEL,
    IMAGE_GEN_API_KEY: key, IMAGE_GEN_BASE_URL: BASE,
    IMAGE_GEN_MODEL: IMAGE_MODEL, IMAGE_GEN_SIZE: '1920*1080'
  });
  const img = await imageGen.generateImage(IMAGE_PROMPT, {
    taskId, index: 0, size: '1920*1080', outDir,
    negativePrompt: NEGATIVE_PROMPT, promptExtend: false
  });
  if (!img || !img.imagePath || !fs.existsSync(img.imagePath)) throw new Error('出图失败：没有 imagePath');
  rec.steps.image = { path: img.imagePath, width: img.width, height: img.height, model: img.model, provider: img.provider };
  console.log('    图片:', img.imagePath, img.width + 'x' + img.height);

  console.log('[2/5] 逐图调色…');
  const graded = path.join(outDir, 'graded_1080.png');
  const grade = await autoGrade.autoGradeImage(img.imagePath, graded, { palette: 'calm' });
  rec.steps.grade = { path: graded, before: grade.before, after: grade.after, params: grade.params };
  console.log('    饱和度', grade.before.sat, '->', grade.after.sat);

  console.log('[3/5] 上传百炼临时 OSS…');
  const up = await dashscopeUpload.uploadFile(graded, { apiKey: key, baseUrl: BASE, model: MODEL });
  rec.steps.upload = { url: up.url, expireInSeconds: up.expireInSeconds };
  console.log('    oss:', up.url);

  console.log('[4/5] 提交 wan3.0 1080P 5s（单次不重试）…');
  const gen = new DashScopeGenerator({ apiKey: key, baseUrl: BASE, modelId: MODEL });
  const sub = await gen.generate(VIDEO_PROMPT, {
    image: { url: up.url }, duration: 5, resolution: '1080p', aspectRatio: '16:9'
  });
  rec.steps.submit = { taskId: sub.taskId };
  console.log('    task:', sub.taskId);

  let status = null;
  for (let i = 0; i < 180; i++) {
    await sleep(5000);
    status = await gen.getStatus(sub.taskId);
    if (status.status === 'completed') break;
    if (status.status === 'failed') throw new Error('视频生成失败: ' + (status.error || 'unknown'));
    if (i % 6 === 0) console.log('    等待…', status.status, Math.round((Date.now() - started) / 1000) + 's');
  }
  if (!status || status.status !== 'completed' || !status.videoUrl) throw new Error('视频生成超时/无 videoUrl');
  rec.steps.video = { url: status.videoUrl, taskId: sub.taskId };
  console.log('    视频 URL 返回，下载…');

  const res = await fetch(status.videoUrl);
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const clip1080 = path.join(outDir, 'clip_1080.mp4');
  fs.writeFileSync(clip1080, buf);
  const probe = videoProcessor.probeDetail(clip1080);
  rec.steps.download = { path: clip1080, bytes: buf.length };
  rec.probe = probe;
  console.log('    1080P:', probe.width + 'x' + probe.height, probe.duration + 's', buf.length, 'bytes');

  // 纯本地下采样，用于“同一画面”看 1080/720/480 的细节差；不是独立 720/480 生成。
  console.log('[5/5] 生成 720/480 下采样对照（本地，不调用模型）…');
  const sim = {};
  for (const [name, w, h] of [['720', 1280, 720], ['480', 854, 480]]) {
    const out = path.join(outDir, `clip_${name}_sim.mp4`);
    const cmd = `"${config.FFMPEG_PATH}" -y -v error -i "${clip1080}" -vf "scale=${w}:${h}:flags=lanczos" -c:v libx264 -crf 18 -preset medium -an "${out}"`;
    const r = videoProcessor._runFFmpeg(cmd);
    if (!r.success) throw new Error(`下采样 ${name} 失败: ${r.error}`);
    const p = videoProcessor.probeDetail(out);
    sim[name] = { path: out, width: p.width, height: p.height, duration: p.duration, bytes: fs.statSync(out).size };
    const frame = path.join(outDir, `frame_${name}.png`);
    videoProcessor._runFFmpeg(`"${config.FFMPEG_PATH}" -y -v error -ss 2 -i "${out}" -frames:v 1 "${frame}"`);
  }
  const frame1080 = path.join(outDir, 'frame_1080.png');
  videoProcessor._runFFmpeg(`"${config.FFMPEG_PATH}" -y -v error -ss 2 -i "${clip1080}" -frames:v 1 "${frame1080}"`);

  const imageCost = pricing.computeImageCost({ model: IMAGE_MODEL, count: 1 });
  const videoCost = pricing.computeClipCost({
    model: 'dashscope', resolution: '1080p', clipDurationSec: 5, modelId: MODEL
  }, 1);
  rec.costs = {
    image: imageCost,
    video: videoCost,
    total: pricing.round2(imageCost.amount + videoCost.amount)
  };
  rec.sim = sim;
  rec.elapsedMs = Date.now() - started;
  rec.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(rec, null, 2), 'utf8');

  console.log('================================================================');
  console.log('完成:', clip1080);
  console.log('1080P:', probe.width + 'x' + probe.height, probe.duration + 's', buf.length, 'bytes');
  console.log('720 下采样:', sim['720'].path);
  console.log('480 下采样:', sim['480'].path);
  console.log('费用(价目表): 图', imageCost.amount, '+ 视频', videoCost.amount, '= 合计', rec.costs.total);
  console.log('结果 JSON:', path.join(outDir, 'result.json'));
})().catch((e) => {
  console.error('REAL_1080_FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
