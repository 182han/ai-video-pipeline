// ==========================================
// 批量出图 + 逐图自适应调色 + 自动通过（2026-11-12）
// ------------------------------------------------------------
// 抽成独立模块，便于：
//   · server.js 只负责 HTTP 校验；
//   · 验收脚本用 stub generateImage 走完整逻辑（零真实计费）。
//
// 输入 N 条图片提示词，逐条：
//   generateImage(prompt) → autoGradeImage → photoLibrary.ingest(status=approved)
// 返回的 photoId 按顺序对应 POST /api/tasks 的 photoIds。
// ==========================================

const fs = require('fs');
const path = require('path');
const autoGrade = require('./autoGrade');
const photoLibrary = require('../photoLibrary');
const pricing = require('../pricing');
const imageGrade = require('../imageGrade');

const PALETTES = ['cold', 'warm', 'night', 'calm'];

/**
 * @param {object} opts
 * @param {string[]} opts.prompts
 * @param {string} opts.taskId
 * @param {'cold'|'warm'|'night'|'calm'} [opts.palette]
 * @param {'off'|'calm'} [opts.imageGrade] 出图后是否自动调色（缺省 off；HTTP 层已按 .env 默认解析好）
 * @param {string} opts.outDir
 * @param {(prompt: string, meta: {index:number}) => Promise<{imagePath:string,width?:number,height?:number,provider?:string,model?:string}>} opts.generateImage
 * @param {string} [opts.negativePrompt]
 * @param {string} [opts.size]
 */
async function generateBatch(opts) {
  const prompts = Array.isArray(opts.prompts) ? opts.prompts : [];
  const taskId = String(opts.taskId || ('imgbatch_' + Date.now().toString(36)));
  const outDir = opts.outDir;
  const palette = PALETTES.includes(opts.palette) ? opts.palette : 'calm';
  // off = 只存模型原图（单条）；calm = 既有「调色前/调色后」双条。
  // 模块被直接调用（脚本/旧调用方）时缺省 off，与服务端默认值保持一致。
  const gradeMode = imageGrade.resolve(opts.imageGrade);
  if (!outDir) throw new Error('generateBatch 缺少 outDir');
  if (typeof opts.generateImage !== 'function') throw new Error('generateBatch 缺少 generateImage');

  const items = [];
  const errors = [];
  for (let i = 0; i < prompts.length; i++) {
    try {
      const out = await opts.generateImage(prompts[i], { index: i });
      if (!out || !out.imagePath || !fs.existsSync(out.imagePath)) {
        throw new Error('出图结果缺少有效 imagePath');
      }
      const baseId = photoLibrary.makeId(taskId, i);

      if (gradeMode === 'off') {
        // 关闭自动调色：只入库一条原图，不派生出 _original，也不跑 autoGrade。
        const photo = photoLibrary.ingest({
          id: baseId,
          taskId,
          index: i,
          filePath: out.imagePath,
          url: '/clips/' + encodeURIComponent(path.basename(out.imagePath)),
          prompt: prompts[i],
          negativePrompt: typeof opts.negativePrompt === 'string' ? opts.negativePrompt : '',
          provider: out.provider || null,
          model: out.model || null,
          size: opts.size || null,
          width: out.width || null,
          height: out.height || null,
          // 用户要求全自动：批量链路默认跳过人工审核。
          status: 'approved',
          source: 'generation',
          grade: { mode: 'off', status: 'off' }
        });
        items.push({
          index: i,
          photoId: photo.id,
          originalPhotoId: null,
          originalPath: null,
          imagePath: out.imagePath,
          grade: photo.grade
        });
        continue;
      }

      const graded = path.join(outDir, `${taskId}_img_${i}_graded.png`);
      const grade = await autoGrade.autoGradeImage(out.imagePath, graded, { palette });
      const photo = photoLibrary.ingest({
        id: baseId,
        taskId,
        index: i,
        filePath: graded,
        url: '/clips/' + encodeURIComponent(path.basename(graded)),
        prompt: prompts[i],
        negativePrompt: typeof opts.negativePrompt === 'string' ? opts.negativePrompt : '',
        provider: out.provider || null,
        model: out.model || null,
        // 调色是本地派生，不重复计费；生成费记在“调色前”原图条目上。
        cost: {
          amount: 0, unitPrice: 0, basis: 'derived', currency: 'CNY',
          label: '调色派生 · 不重复计费', computed: true, count: 0,
          priceVersion: pricing.PRICE_VERSION, detail: '由同一张原图本地调色生成'
        },
        size: opts.size || null,
        width: out.width || grade.after.width,
        height: out.height || grade.after.height,
        // 用户要求全自动：批量链路默认跳过人工审核。
        status: 'approved',
        source: 'generation',
        grade: {
          mode: 'calm',
          palette,
          status: 'applied',
          before: grade.before,
          after: grade.after,
          params: grade.params
        }
      });

      // 用户 2026-11-14 要求：调色前原图和调色后图都要在图片库同时可见。
      // 用独立 id 保存原图，prompt 加前缀方便在库里区分；不覆盖生成参数。
      let originalPhoto = null;
      try {
        originalPhoto = photoLibrary.ingest({
          id: baseId + '_original',
          taskId,
          index: i,
          filePath: out.imagePath,
          url: '/clips/' + encodeURIComponent(path.basename(out.imagePath)),
          prompt: `【调色前】${prompts[i]}`,
          negativePrompt: typeof opts.negativePrompt === 'string' ? opts.negativePrompt : '',
          provider: out.provider || null,
          model: out.model || null,
          size: opts.size || null,
          width: out.width || null,
          height: out.height || null,
          status: 'approved',
          source: 'generation',
          grade: { mode: 'off', status: 'off' }
        });
        photoLibrary.update(originalPhoto.id, { generationPrompt: prompts[i], label: '调色前' });
      } catch (e) {
        console.warn('[imageBatch] 调色前原图入库失败:', e && e.message ? e.message : e);
      }

      photoLibrary.update(photo.id, {
        prompt: `【调色后】${prompts[i]}`,
        imagePrompt: `【调色后】${prompts[i]}`,
        generationPrompt: prompts[i],
        label: '调色后'
      });

      items.push({
        index: i,
        photoId: photo.id,
        originalPhotoId: originalPhoto ? originalPhoto.id : null,
        originalPath: out.imagePath,
        imagePath: graded,
        grade: photo.grade,
        before: grade.before,
        after: grade.after,
        gradeParams: grade.params
      });
    } catch (e) {
      errors.push({ index: i, error: e && e.message ? e.message : String(e) });
    }
  }
  return { taskId, palette, imageGrade: gradeMode, count: prompts.length, items, errors };
}

module.exports = { generateBatch, PALETTES };
