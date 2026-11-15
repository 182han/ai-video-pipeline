// 用户同意补跑 4 张：沙洲、潮池、极光、冰川修正版；单次不重试，预算约 ¥0.80。
// 只看 raw，不调色；冰川改成远中景冰崖，避免蜂窝孔洞。
const fs = require('fs');
const path = require('path');
const config = require('../config');
require('../src/generators/imageProviders');
const { ImageGenerator } = require('../src/generators/imageGen');
const videoProcessor = require('../src/videoProcessor');
const pricing = require('../src/pricing');

const KEY_FILE = 'C:/Users/14872/Desktop/测试/.dashscope-test-key';
const BASE = 'https://dashscope.aliyuncs.com/api/v1';
const MODEL = 'wan2.7-image';
const SIZE = '1920*1080';
const COMMON_NEG = [
  'HDR', '过曝', '死白天空', '过度锐化', '高微对比', '塑料感', '蜡感', 'CGI', '3D渲染',
  '完美对称', '重复纹理', '无雾', '过饱和', '商业海报', '8K超清', '人物', '建筑', '文字', '水印'
].join('，');

const shots = [
  {
    card: 'sc-086',
    prompt: '退潮后的湾口沙坝，浅水覆盖沙洲，沙洲分汊，水面有细小波纹；前景只有稀疏贝壳碎屑（2–20mm）和湿沙，不是密集卵石滩；中景浅滩与低矮沙嘴，远景低矮海岸与海雾；阴天散射，云层右侧略亮，冷灰主调，少量暖沙；真实自然摄影，35mm，f/8，柔和低微对比，自然色，4–6%胶片颗粒，未过度锐化；天空不过曝，水面反光不炸白，雾中保留层次；16:9，地平线在画面下三分之一；无人物、无建筑、无文字。',
    negative: COMMON_NEG + '，密集卵石滩，贝壳堆，塑料沙，重复波纹'
  },
  {
    card: 'sc-026',
    prompt: '中潮带的小型潮池，池径约半米，水深几厘米；池边是黑色玄武岩，岩石上只有细小的藤壶、滨螺和薄层石莼，盐霜只在干湿交界形成细白边；没有大海带、没有海藻林、没有大块盐晶、没有白花状盐花、没有过大的藤壶；水面有微小涟漪和天空反光；阴天散射，冷灰与海藻绿；真实自然摄影，85mm，f/8，低微对比，自然色，4–6%胶片颗粒；水面反光不炸白，暗部岩石有纹理；16:9，贴面构图；无人物、无建筑、无文字。',
    negative: COMMON_NEG + '，大海带，海藻林，巨型盐晶，白花状盐花，过大藤壶，水族箱，微距珠宝'
  },
  {
    card: 'sc-016',
    prompt: '低地平线的氧绿极光弧，暗天空，雪林剪影，地景很暗，只有雪面微弱反光；洋红只在外缘极淡出现；极光位于低空30度以下，不是大面积帘幕；真实自然摄影，20mm，f/2.8，长曝，低噪点，自然色；极光不过曝，星点保留层次，雪地保留暗部；16:9，固定机位广角；无人物、无木屋、无月光、无霓虹、无绿色发光边、无文字。',
    negative: COMMON_NEG + '，霓虹极光，大面积帘幕，洋红爆发，绿色发光边，紫雾，月亮，人群'
  },
  {
    card: 'sc-005',
    prompt: '冰川末端的远中景，冰崖只占画面三分之一，冰崖表面是垂直节理、脏层和少量冰柱，不是孔洞；前景是冰碛垄、砾石与融水沟，砾石直径2–10cm；阴天散射，云层后方均匀光；没有冰洞、没有蜂窝孔洞、没有发光蓝冰、没有完美重复裂隙；冰面有脏层、气泡和融水痕；真实自然摄影，50mm，f/8，低微对比，自然色，4–6%胶片颗粒；冰面保留脏层，雪面不炸白，暗部有层次；16:9，地面平视；无人物、无营地、无绳索、无文字。',
    negative: COMMON_NEG + '，冰洞，蜂窝孔洞，海绵状冰，蓝色水晶，发光蓝冰，重复裂隙，冰宫，CGI冰川'
  }
];

(async () => {
  const lines = fs.readFileSync(KEY_FILE, 'utf8').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const key = lines.find(x => x.length >= 80) || '';
  if (!key) throw new Error('Key 文件里没找到 DashScope Key');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const taskId = 'v31_four_r3_' + Date.now().toString(36);
  const outDir = path.join(config.STORAGE.outputDir, 'v31-four-images-r3-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const rec = { taskId, startedAt: new Date().toISOString(), model: MODEL, size: SIZE, authorizedByUser: true, maxCalls: 4, retry: false, autoGrade: false, cards: shots.map(s => s.card), results: [], errors: [] };
  const generator = new ImageGenerator({
    provider: 'dashscope', model: MODEL,
    IMAGE_GEN_API_KEY: key, IMAGE_GEN_BASE_URL: BASE,
    IMAGE_GEN_MODEL: MODEL, IMAGE_GEN_SIZE: SIZE
  });

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const item = { card: s.card, index: i + 1, prompt: s.prompt, negative: s.negative, status: 'pending' };
    try {
      console.log(`[${i + 1}/4] ${s.card} 出图…`);
      const img = await generator.generateImage(s.prompt, { taskId: taskId + '_' + s.card, index: i, size: SIZE, outDir, negativePrompt: s.negative, promptExtend: false });
      if (!img || !img.imagePath || !fs.existsSync(img.imagePath)) throw new Error('没有 imagePath');
      const ext = path.extname(img.imagePath) || '.png';
      const raw = path.join(outDir, `raw_${s.card}${ext}`);
      fs.copyFileSync(img.imagePath, raw);
      Object.assign(item, { raw, width: img.width, height: img.height, model: img.model, provider: img.provider, bytes: fs.statSync(raw).size, status: 'success' });
      rec.results.push(item);
      console.log(`    OK ${img.width}x${img.height} ${item.bytes} bytes`);
    } catch (e) {
      item.status = 'failed'; item.error = e && e.message ? e.message : String(e); rec.errors.push(item);
      console.error(`    FAILED: ${item.error}`);
    }
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(rec, null, 2), 'utf8');
  }

  const ok = rec.results.filter(x => x.raw && fs.existsSync(x.raw));
  if (ok.length === 4) {
    try {
      const inputs = ok.map(x => `-i "${x.raw}"`).join(' ');
      const filter = '[0:v]scale=640:360[a];[1:v]scale=640:360[b];[2:v]scale=640:360[c];[3:v]scale=640:360[d];[a][b][c][d]hstack=inputs=4[out]';
      const sheet = path.join(outDir, 'contact_sheet.jpg');
      const cmd = `"${config.FFMPEG_PATH}" -y -v error ${inputs} -filter_complex "${filter}" -map "[out]" -frames:v 1 -q:v 2 "${sheet}"`;
      const r = videoProcessor._runFFmpeg(cmd);
      if (r.success && fs.existsSync(sheet)) rec.contactSheet = sheet;
    } catch (e) { rec.contactSheetError = e && e.message ? e.message : String(e); }
  }
  rec.finishedAt = new Date().toISOString();
  rec.cost = pricing.computeImageCost({ model: MODEL, count: ok.length });
  rec.success = ok.length; rec.failed = rec.errors.length;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(rec, null, 2), 'utf8');
  console.log('================================================================');
  console.log('目录:', outDir);
  console.log('成功:', ok.length, '失败:', rec.errors.length);
  console.log('费用(价目表): 图片', rec.cost.amount, '元');
  if (rec.contactSheet) console.log('预览拼图:', rec.contactSheet);
  if (rec.errors.length) process.exitCode = 1;
})().catch((e) => { console.error('V31_FOUR_R3_FAILED:', e && e.message ? e.message : e); process.exit(1); });
