// 用户已明确同意：6 张 wan2.7-image 真实出图，单次不重试，预算约 ¥1.20。
// 只做图片 + 本地调色；不跑视频、不自动重试、不改原场景卡。
const fs = require('fs');
const path = require('path');
const config = require('../config');
require('../src/generators/imageProviders');
const { ImageGenerator } = require('../src/generators/imageGen');
const autoGrade = require('../src/processors/autoGrade');
const videoProcessor = require('../src/videoProcessor');
const pricing = require('../src/pricing');

const KEY_FILE = 'C:/Users/14872/Desktop/测试/.dashscope-test-key';
const BASE = 'https://dashscope.aliyuncs.com/api/v1';
const MODEL = 'wan2.7-image';
const SIZE = '1920*1080';
const NEGATIVE_COMMON = [
  'HDR', '过曝', '死白天空', '过度锐化', '高微对比', '塑料感', '蜡感', 'CG', '3D渲染',
  '完美对称', '重复纹理', '无雾', '过饱和', '商业海报', '8K超清', '锐利山脊', '固体云海',
  '人物', '建筑', '文字', '水印'
].join('，');

const shots = [
  {
    card: 'sc-086',
    prompt: '清晨退潮后的湾口沙坝，沙洲分汊与浅水反光，前景湿沙、贝壳碎屑和一条细小水流，中景沙嘴与浅滩，远景低矮海岸与海雾；阴天散射，云层右侧更亮，冷灰主调，少量暖沙；真实自然摄影，35mm，f/8，柔和低微对比，自然色，4–6%胶片颗粒，未过度锐化；天空不过曝，水面反光不炸白，雾中保留层次；16:9，地平线在画面下三分之一，负空间40%以上；无人物、无建筑、无文字。'
  },
  {
    card: 'sc-026',
    prompt: '退潮后的潮池，水面反射冷灰天空，黑色礁石湿润，前景海藻、盐晶与浅水边缘，中景潮池主水面，远景雾中海岸；阴天散射，云层均匀，冷灰与海藻绿；真实自然摄影，85mm，f/8，低微对比，自然色，4–6%胶片颗粒，未过度锐化；水面反光不炸白，暗部礁石有纹理；16:9，贴面构图，负空间40%以上；无人物、无建筑、无文字。'
  },
  {
    card: 'sc-029',
    prompt: '航拍星形沙丘，三条交叉脊线，迎风坡风纹、背风滑落面，低角度侧光，暖赭与深棕；前景沙脊阴影，中景沙丘主体，远景薄霾；真实自然摄影，28mm，f/8，自然色，低微对比，4–6%胶片颗粒，未过度锐化；沙脊高光不炸白，阴影保留风纹；16:9，高位斜俯，负空间40%以上；无人物、无车辙、无建筑、无文字。'
  },
  {
    card: 'sc-005',
    prompt: '冰川舌的冰裂隙，蓝冰与冰碛砾石，前景砾石与融水细流，中景冰裂隙，远景冰川舌与薄雾；阴天散射，云层后方均匀光；真实自然摄影，85mm，f/8，低微对比，自然色，4–6%胶片颗粒，未过度锐化；冰面保留裂纹，雪面不炸白，暗部蓝冰有层次；16:9，贴面构图，负空间40%以上；无人物、无营地、无绳索、无文字。'
  },
  {
    card: 'sc-210',
    prompt: '温带雨林树冠雾，雾在树冠间缓慢流动，前景蕨叶与藤蔓，中景树干，远景雾层；阴天散射，树冠缝隙柔光，深绿与灰；真实自然摄影，28mm，f/8，低微对比，自然色，4–6%胶片颗粒，未过度锐化；叶面高光不炸，雾中远树有层次；16:9，地面广角，负空间40%以上；无人物、无小径、无建筑、无文字。'
  },
  {
    card: 'sc-016',
    prompt: '无月夜极光帘幕，氧绿为主、洋红只在外缘，雪林剪影前景，星空与地景；真实自然摄影，14–20mm，f/2.8，长曝，低噪点，自然色；极光不过曝，雪地保留暗部，星空有层次；16:9，固定机位广角，负空间40%以上；无人物、无木屋、无月光、无紫雾、无文字。'
  }
];

(async () => {
  const lines = fs.readFileSync(KEY_FILE, 'utf8').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const key = lines.find(x => x.length >= 80) || '';
  if (!key) throw new Error('Key 文件里没找到 DashScope Key');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const taskId = 'v31_six_' + Date.now().toString(36);
  const outDir = path.join(config.STORAGE.outputDir, 'v31-six-images-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const rec = {
    taskId, startedAt: new Date().toISOString(), model: MODEL, size: SIZE,
    authorizedByUser: true, maxCalls: 6, retry: false,
    cards: shots.map(s => s.card), results: [], errors: []
  };
  const generator = new ImageGenerator({
    provider: 'dashscope', model: MODEL,
    IMAGE_GEN_API_KEY: key, IMAGE_GEN_BASE_URL: BASE,
    IMAGE_GEN_MODEL: MODEL, IMAGE_GEN_SIZE: SIZE
  });

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const item = { card: s.card, index: i + 1, prompt: s.prompt, status: 'pending' };
    try {
      console.log(`[${i + 1}/6] ${s.card} 出图…`);
      const img = await generator.generateImage(s.prompt, {
        taskId: taskId + '_' + s.card,
        index: i,
        size: SIZE,
        outDir,
        negativePrompt: NEGATIVE_COMMON,
        promptExtend: false
      });
      if (!img || !img.imagePath || !fs.existsSync(img.imagePath)) throw new Error('没有 imagePath');
      const ext = path.extname(img.imagePath) || '.png';
      const raw = path.join(outDir, `raw_${s.card}${ext}`);
      fs.copyFileSync(img.imagePath, raw);
      item.raw = raw;
      item.width = img.width;
      item.height = img.height;
      item.model = img.model;
      item.provider = img.provider;
      item.bytes = fs.statSync(raw).size;

      console.log(`[${i + 1}/6] ${s.card} 本地调色…`);
      const graded = path.join(outDir, `graded_${s.card}.png`);
      try {
        const grade = await autoGrade.autoGradeImage(raw, graded, { palette: 'calm' });
        item.graded = graded;
        item.grade = { before: grade.before, after: grade.after, params: grade.params };
      } catch (ge) {
        item.gradeError = ge && ge.message ? ge.message : String(ge);
      }
      item.status = 'success';
      rec.results.push(item);
      console.log(`    OK ${img.width}x${img.height} ${item.bytes} bytes`);
    } catch (e) {
      item.status = 'failed';
      item.error = e && e.message ? e.message : String(e);
      rec.errors.push(item);
      console.error(`    FAILED: ${item.error}`);
    }
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(rec, null, 2), 'utf8');
  }

  // 6 张成功才拼预览 contact sheet（本地 ffmpeg，不产生模型费用）
  const ok = rec.results.filter(x => x.raw && fs.existsSync(x.raw));
  if (ok.length === 6) {
    try {
      const inputs = ok.map(x => `-i "${x.raw}"`).join(' ');
      const filter = [
        '[0:v]scale=640:360[a]', '[1:v]scale=640:360[b]', '[2:v]scale=640:360[c]',
        '[3:v]scale=640:360[d]', '[4:v]scale=640:360[e]', '[5:v]scale=640:360[f]',
        '[a][b][c]hstack=inputs=3[top]', '[d][e][f]hstack=inputs=3[bottom]',
        '[top][bottom]vstack=inputs=2[out]'
      ].join(';');
      const sheet = path.join(outDir, 'contact_sheet.jpg');
      const cmd = `"${config.FFMPEG_PATH}" -y -v error ${inputs} -filter_complex "${filter}" -map "[out]" -frames:v 1 -q:v 2 "${sheet}"`;
      const r = videoProcessor._runFFmpeg(cmd);
      if (r.success && fs.existsSync(sheet)) rec.contactSheet = sheet;
    } catch (e) {
      rec.contactSheetError = e && e.message ? e.message : String(e);
    }
  }

  rec.finishedAt = new Date().toISOString();
  rec.cost = pricing.computeImageCost({ model: MODEL, count: ok.length });
  rec.success = ok.length;
  rec.failed = rec.errors.length;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(rec, null, 2), 'utf8');

  console.log('================================================================');
  console.log('目录:', outDir);
  console.log('成功:', ok.length, '失败:', rec.errors.length);
  console.log('费用(价目表): 图片', rec.cost.amount, '元');
  if (rec.contactSheet) console.log('预览拼图:', rec.contactSheet);
  if (rec.errors.length) process.exitCode = 1;
})().catch((e) => {
  console.error('V31_SIX_IMAGES_FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
