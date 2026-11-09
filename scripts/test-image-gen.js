// ==========================================
// 图片生成（wan2.7-image）手动测试脚本
// ==========================================
//
// 用法：
//   node scripts/test-image-gen.js
//       只看配置（不联网、不花钱）
//   node scripts/test-image-gen.js --payload --prompt "清晨的雪山"
//       打印「将要发给百炼的请求体」（不含 Key，不联网）
//   node scripts/test-image-gen.js --live --prompt "清晨的雪山"
//       真实生成 1 张（会计费；默认落盘到 app/clips/）
//
// 可选：
//   --size 1696*960 | 2688*1536 | 1K | 2K
//   --index 0          文件名里的片段序号（默认 0）
//   --task-id xxx      文件名前缀（默认 img_<时间戳>）
//   --out <dir>        落盘目录（默认 config.STORAGE.clipsDir）
//   --json             机器可读输出
//
// 退出码：0 成功；1 生成失败；2 配置未就绪。
// ==========================================

const path = require('path');
const config = require('../config');
require('../src/generators/imageProviders');
const { getImageGenStatus, ImageGenerator } = require('../src/generators/imageGen');
const {
  buildImagePayload,
  resolveSettings,
  normalizeSize
} = require('../src/generators/imageProviders/dashscope');

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? fallback : v;
}

const LIVE = process.argv.includes('--live');
const PRINT_PAYLOAD = process.argv.includes('--payload');
const JSON_OUT = process.argv.includes('--json');

function maskKey(has) {
  return has ? '<已配置，不回显>' : '<未配置>';
}

function printStatus(status, settings) {
  if (JSON_OUT) {
    console.log(JSON.stringify({
      ready: status.ready,
      usable: status.usable,
      missing: status.missing,
      providerImplemented: status.providerImplemented,
      provider: status.imageGen.provider,
      model: status.imageGen.model,
      baseUrl: status.imageGen.baseUrl,
      size: status.imageGen.size,
      timeoutMs: status.imageGen.timeoutMs,
      pollMs: status.imageGen.pollMs,
      apiKey: maskKey(status.imageGen.hasApiKey),
      i2vSupported: status.i2v.supportedByProvider // 固定 null：未核实
    }, null, 2));
    return;
  }

  console.log('=== 图片生成配置 ===');
  console.log(`  厂商          : ${status.imageGen.provider}`);
  console.log(`  模型          : ${status.imageGen.model}`);
  console.log(`  Base URL      : ${status.imageGen.baseUrl}`);
  console.log(`  尺寸          : ${status.imageGen.size}`);
  console.log(`  超时 / 轮询   : ${status.imageGen.timeoutMs}ms / ${status.imageGen.pollMs}ms`);
  console.log(`  API Key       : ${maskKey(status.imageGen.hasApiKey)}`);
  console.log(`  适配器已注册  : ${status.providerImplemented ? '是' : '否'}`);
  console.log(`  配置齐备      : ${status.ready ? '是' : '否（缺少 ' + status.missing.join(', ') + '）'}`);
  console.log(`  可直接出图    : ${status.usable ? '是' : '否'}`);
  console.log(`  图生视频能力  : ${status.i2v.supportedByProvider === null ? '未核实（不得当成支持）' : String(status.i2v.supportedByProvider)}`);
  console.log('');
  if (status.usable) {
    console.log('下一步（会真实计费）：');
    console.log('  node scripts/test-image-gen.js --live --prompt "清晨的雪山，侧逆光，长焦压缩"');
  } else if (!status.imageGen.hasApiKey) {
    console.log('下一步（二选一）：');
    console.log('  1) 页面「设置 → 图片生成」填 API Key（只存本机浏览器，不用重启）；');
    console.log('  2) 在 app/.env 里填 IMAGE_GEN_API_KEY=sk-... 或 DASHSCOPE_API_KEY=sk-...，然后重启服务。');
    console.log('注意：本 CLI 只读服务端 .env；只填在页面设置里的 Key 请在创作页第 2 步测试。');
  } else {
    console.log('配置有 Key 但还不齐备，请检查上面缺失项。');
  }
  if (settings) {
    console.log('');
    console.log('提示：尺寸建议 16:9。1K=1696*960，2K=2688*1536。');
  }
}

(async () => {
  const status = getImageGenStatus();
  const settings = (() => {
    try { return resolveSettings({}); } catch (e) { return null; }
  })();

  if (PRINT_PAYLOAD) {
    const prompt = arg('prompt', '清晨的雪山，侧逆光，长焦压缩');
    const size = arg('size', status.imageGen.size || '1696*960');
    const payload = buildImagePayload({
      model: status.imageGen.model || 'wan2.7-image',
      prompt,
      size: normalizeSize(size),
      n: 1,
      watermark: false
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!LIVE) {
    printStatus(status, settings);
    return;
  }

  if (!status.usable) {
    printStatus(status, settings);
    process.exitCode = 2;
    return;
  }

  const prompt = arg('prompt', '清晨的雪山，侧逆光，长焦压缩，画面干净');
  const size = arg('size', status.imageGen.size || '1696*960');
  const index = Number(arg('index', '0'));
  const taskId = arg('task-id', `img_${Date.now()}`);
  const outDir = arg('out', '') || config.STORAGE.clipsDir;

  console.log('=== 真实出图（会计费，1 张）===');
  console.log(`  提示词: ${prompt}`);
  console.log(`  尺寸  : ${normalizeSize(size)}`);
  console.log(`  落盘  : ${path.resolve(outDir)}`);
  console.log('');

  const t0 = Date.now();
  try {
    const generator = new ImageGenerator({
      provider: status.imageGen.provider,
      model: status.imageGen.model
    });
    const out = await generator.generateImage(prompt, {
      size,
      index,
      taskId,
      outDir
    });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    if (JSON_OUT) {
      console.log(JSON.stringify({ ok: true, ...out, seconds: Number(seconds) }, null, 2));
    } else {
      console.log('✅ 生成成功');
      console.log(`  文件      : ${out.imagePath}`);
      console.log(`  宽高      : ${out.width} x ${out.height}`);
      console.log(`  厂商/模型 : ${out.provider} / ${out.model}`);
      console.log(`  耗时      : ${seconds}s`);
    }
  } catch (e) {
    console.error('❌ 生成失败:', e.message);
    process.exitCode = 1;
  }
})();
