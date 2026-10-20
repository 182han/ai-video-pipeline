// 片段恢复相关修复的专项验收（2026-10-21）
//
// 覆盖四个事故点：
// 1. 重新生成/重试覆盖同名付费片段文件 → 分配唯一文件名；
// 2. 真实模型缺 Key 静默降级 Mock，任务仍标原模型 → 打 mockFallback 标记，QC 按合成素材处理；
// 3. 重新生成/补跑不读当前设置（Key 落盘被脱敏，重启后丢失）→ 请求带 runtimeConfig 并合并；
// 4. NSFW 404 被并发调用清成「超时」→ 每次调用用自己的错误槽。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`❌ ${name}: ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`❌ ${name}: ${e.message}`);
  }
}

const pipeline = require('../src/pipeline');
const qualityChecker = require('../src/qualityChecker');
const config = require('../config');

(async () => {
  // ---------- 1. 唯一片段文件名：绝不覆盖已有文件 ----------
  const fakeTask = 'verify_recovery_fix';
  const base = path.join(APP, 'clips', `${fakeTask}_clip_1.mp4`);
  const v2 = path.join(APP, 'clips', `${fakeTask}_clip_1_v2.mp4`);
  const v3 = path.join(APP, 'clips', `${fakeTask}_clip_1_v3.mp4`);
  try {
    [base, v2, v3].forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });

    const first = pipeline._nextClipPath(fakeTask, 0);
    check('首个文件名是常规名', () => assert.strictEqual(first, base));

    fs.writeFileSync(base, 'old-paid-clip');
    const second = pipeline._nextClipPath(fakeTask, 0);
    check('已存在时改用 _v2，不覆盖旧文件', () => {
      assert.strictEqual(second, v2);
      assert.strictEqual(fs.readFileSync(base, 'utf8'), 'old-paid-clip');
    });

    fs.writeFileSync(v2, 'v2');
    const third = pipeline._nextClipPath(fakeTask, 0);
    check('_v2 也存在时继续 _v3', () => assert.strictEqual(third, v3));
  } finally {
    [base, v2, v3].forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
  }

  // ---------- 2. 合成素材识别 + 降级标记 ----------
  check('model=mock 视为合成素材', () => assert.strictEqual(pipeline._isSynthetic({ model: 'mock' }), true));
  check('真实模型 + mockFallback 也视为合成素材', () =>
    assert.strictEqual(pipeline._isSynthetic({ model: 'dashscope', mockFallback: 'dashscope' }), true));
  check('真实模型无降级时不误判', () =>
    assert.strictEqual(pipeline._isSynthetic({ model: 'dashscope' }), false));

  check('createGenerator 缺 Key 降级时带 fallbackToMock 标记', () => {
    const saved = config.DASHSCOPE_API_KEY;
    config.DASHSCOPE_API_KEY = '';
    try {
      const g = require('../src/generators').createGenerator('dashscope', {});
      assert.strictEqual(g.fallbackToMock, true);
      assert.strictEqual(g.requestedModel, 'dashscope');
    } finally {
      config.DASHSCOPE_API_KEY = saved;
    }
  });

  // ---------- 3. runtimeConfig 合并 ----------
  await checkAsync('regenerateClip 合并当前配置并保留 previousVideoPath', async () => {
    const taskId = 'verify_recovery_task';
    const tm = require('../src/taskManager');
    const oldFile = path.join(APP, 'clips', 'verify_old_clip.mp4');
    fs.writeFileSync(oldFile, 'old-paid-bytes');
    tm.tasks[taskId] = {
      taskId, status: 'failed', model: 'dashscope', totalClips: 1, preset: 'final',
      clips: [{ index: 0, status: 'failed', prompt: 'p', videoPath: oldFile }],
      runtimeConfig: { apiKey: '', multimodalApiKey: '', multimodalModel: '' },
      steps: { clip_generation: { status: 'failed' } }
    };
    const orig = pipeline._regenerateFlow;
    pipeline._regenerateFlow = async () => {};
    try {
      const res = await pipeline.regenerateClip(taskId, 0, 'new prompt', {
        apiKey: 'vk', multimodalApiKey: 'mm', multimodalModel: 'qwen3-vl-plus'
      });
      assert.ok(!res.error, res.error);
      const t = tm.getTask(taskId);
      assert.strictEqual(t.runtimeConfig.apiKey, 'vk');
      assert.strictEqual(t.runtimeConfig.multimodalApiKey, 'mm');
      assert.strictEqual(t.runtimeConfig.multimodalModel, 'qwen3-vl-plus');
      assert.strictEqual(t.clips[0].previousVideoPath, oldFile);
      assert.strictEqual(t.clips[0].status, 'pending');
    } finally {
      pipeline._regenerateFlow = orig;
      delete tm.tasks[taskId];
      try { fs.unlinkSync(path.join(APP, 'data', 'tasks', `${taskId}.json`)); } catch (e) {}
      try { fs.unlinkSync(oldFile); } catch (e) {}
    }
  });

  check('_mergeRuntimeConfig 合并允许字段、忽略未知字段', () => {
    const task = { runtimeConfig: { apiKey: 'old', keep: 'x' } };
    pipeline._mergeRuntimeConfig(task, {
      apiKey: 'new',
      multimodalApiKey: 'mm',
      multimodalModel: 'qwen3-vl-plus',
      hacker: 'evil'
    });
    assert.strictEqual(task.runtimeConfig.apiKey, 'new');
    assert.strictEqual(task.runtimeConfig.multimodalApiKey, 'mm');
    assert.strictEqual(task.runtimeConfig.multimodalModel, 'qwen3-vl-plus');
    assert.strictEqual(task.runtimeConfig.keep, 'x');
    assert.strictEqual(task.runtimeConfig.hacker, undefined);
  });
  check('_mergeRuntimeConfig 对空/非法输入不改任务', () => {
    const task = { runtimeConfig: { apiKey: 'old' } };
    pipeline._mergeRuntimeConfig(task, null);
    pipeline._mergeRuntimeConfig(task, 'not-object');
    assert.strictEqual(task.runtimeConfig.apiKey, 'old');
  });

  // ---------- 4. NSFW 错误槽：404 不能被并发清成超时 ----------
  const frames = ['ZmFrZQ=='];
  await checkAsync('单次 404 保留 HTTP 状态', async () => {
    const errOut = { value: null };
    const fetchImpl = async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error":{"message":"model not found"}}'
    });
    const raw = await qualityChecker._callNsfwMultimodal(frames, {
      apiKey: 'k', baseUrl: 'https://x/v1', model: 'qwen3-vl-plus',
      timeoutMs: 2000, fetchImpl, errorOut: errOut
    });
    assert.strictEqual(raw, null);
    assert.strictEqual(errOut.value.kind, 'http');
    assert.strictEqual(errOut.value.status, 404);
    assert.ok(/model not found/.test(errOut.value.message));
  });

  await checkAsync('并发调用各自保留自己的状态（403 与 404 不串）', async () => {
    const slow404 = { value: null };
    const fast403 = { value: null };
    const mkFetch = (status, delay) => async () => {
      await new Promise(r => setTimeout(r, delay));
      return { ok: false, status, text: async () => `HTTP ${status}` };
    };
    await Promise.all([
      qualityChecker._callNsfwMultimodal(frames, {
        apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', timeoutMs: 3000,
        fetchImpl: mkFetch(404, 80), errorOut: slow404
      }),
      qualityChecker._callNsfwMultimodal(frames, {
        apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', timeoutMs: 3000,
        fetchImpl: mkFetch(403, 20), errorOut: fast403
      })
    ]);
    assert.strictEqual(slow404.value.status, 404);
    assert.strictEqual(fast403.value.status, 403);
  });

  // ---------- 5. 接线静态断言 ----------
  const read = p => fs.readFileSync(path.join(APP, p), 'utf8');
  const pipelineSrc = read('src/pipeline.js');
  const serverSrc = read('server.js');
  const htmlSrc = read('public/index.html');
  const genSrc = read('src/generators/index.js');

  check('pipeline 使用 _nextClipPath 下载片段', () =>
    assert.ok(/const localPath = this\._nextClipPath\(taskId, index\)/.test(pipelineSrc)));
  check('pipeline 记录 previousVideoPath', () =>
    assert.ok(/previousVideoPath/.test(pipelineSrc)));
  check('regenerateClip 接受并合并 runtimeConfig', () =>
    assert.ok(/async regenerateClip\(taskId, index, prompt, runtimeConfig\)/.test(pipelineSrc)
      && /this\._mergeRuntimeConfig\(task, runtimeConfig\)/.test(pipelineSrc)));
  check('continueTask 合并 runtimeConfig', () =>
    assert.ok(/options\.runtimeConfig[\s\S]{0,200}_mergeRuntimeConfig/.test(pipelineSrc)));
  check('QC 合成判定走 _isSynthetic', () => {
    assert.ok(pipelineSrc.includes('syntheticSource: this._isSynthetic(task)'));
    assert.ok(!/syntheticSource: task\.model === 'mock'/.test(pipelineSrc));
  });
  check('生成器降级带 fallbackToMock 标记', () =>
    assert.ok(/fallback\.fallbackToMock = true/.test(genSrc)
      && /fallback\.requestedModel = modelName/.test(genSrc)));
  check('server regenerate 路由透传 runtimeConfig', () =>
    assert.ok(/pipeline\.regenerateClip\(req\.params\.id, clipIndex, prompt, runtimeConfig\)/.test(serverSrc)));
  check('server continue 路由透传 runtimeConfig', () =>
    assert.ok(/runtimeConfig: body\.runtimeConfig \|\| null/.test(serverSrc)));
  check('前端提供 collectTaskRuntimeConfig 且读取 localStorage', () =>
    assert.ok(/function collectTaskRuntimeConfig\(model\)/.test(htmlSrc)
      && /localStorage\.getItem\('vs_config'\)/.test(htmlSrc)));
  check('重新生成请求带 runtimeConfig', () =>
    assert.ok(/body: JSON\.stringify\(\{ prompt, runtimeConfig: collectTaskRuntimeConfig\(model\) \}\)/.test(htmlSrc)));
  check('补跑请求带 runtimeConfig', () =>
    assert.ok(/runtimeConfig: collectTaskRuntimeConfig\(full\.model \|\| 'mock'\)/.test(htmlSrc)));
  check('NSFW 调用传 errorOut 并使用本地错误槽', () =>
    assert.ok(/errorOut: upstreamError/.test(read('src/qualityChecker.js'))
      && /upstreamError\.value \|\| this\._nsfwLastError/.test(read('src/qualityChecker.js'))));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
