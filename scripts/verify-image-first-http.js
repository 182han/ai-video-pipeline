// ============================================================
// 出图→图生视频 + 图片手动调色：HTTP 契约验收（临时隔离实例）
// ------------------------------------------------------------
// 为什么要有它：本轮新增/改动的三个 HTTP 面在 3001 上**还没生效**（改后端要重启，
// 重启由用户做），但又必须先给出证据：
//   1) GET  /api/assistant/info              → 新增 image{ usable, unitCny, ... }
//   2) POST /api/assistant/execute            → imagePerClip=true 且出图未配置时
//                                              返回 IMAGE_GEN_NOT_READY 且**不建任务**
//   3) POST /api/photos/:id/adjust            → 手动调色（应用/回退、保留原图、版本链、
//                                              参数越界与文件缺失的错误码）
//
// 做法（沿用 scripts/verify-assistant-http.js 的先例）：
//   · 绝不碰运行中的 3001：挑一个空闲端口（3093 起）spawn 一个**临时实例**，
//     AUTH_ENABLED=false、DATABASE_TYPE=json、数据目录全部指向 app/.scratch/ 下的临时目录；
//   · 零真实计费：不建任何真实任务、不做出图/出视频请求；
//     execute 的正向透传**不测**（会真的出图=花钱），只测「未配置就拒绝」这条负向；
//   · 调色用真实 ffmpeg（本地派生不计费），验完删临时目录。
//
// 用法：cd app && node scripts/verify-image-first-http.js
// 退出码 0 = 全部通过；非 0 = 有失败（"未验证"不算通过）。
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
// 注意：不要把临时目录放到系统 TEMP——本机实测 ffmpeg 写系统临时目录会失败，
// 统一放 app/.scratch（.gitignore 内），跑完删干净。
const TMP = path.join(APP_DIR, '.scratch', 'verify-imgfirst-' + Date.now());
const DIRS = {
  tasks: path.join(TMP, 'tasks'),
  clips: path.join(TMP, 'clips'),
  output: path.join(TMP, 'output'),
  library: path.join(TMP, 'library'),
  photos: path.join(TMP, 'photos'),
  projects: path.join(TMP, 'projects'),
  logs: path.join(TMP, 'logs'),
  assistant: path.join(TMP, 'assistant'),
  budget: path.join(TMP, 'budget.json')
};
for (const d of Object.values(DIRS)) {
  if (path.extname(d)) continue;
  fs.mkdirSync(d, { recursive: true });
}

const FFMPEG = require(path.join(APP_DIR, 'config')).FFMPEG_PATH;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? `  —  ${extra}` : ''}`); }
  else { fail++; failures.push({ name, extra }); console.log(`  ❌ ${name}${extra ? `  —  ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickFreePort(start) {
  for (let p = start; p < start + 40; p++) {
    try {
      await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(300) });
    } catch (e) {
      if (e && (e.code === 'ECONNREFUSED' || String(e.message || '').includes('fetch failed') || e.name === 'TimeoutError')) {
        return p;
      }
    }
  }
  return null;
}

let srv = null;
let BASE = null;

async function getJson(url) {
  const r = await fetch(BASE + url);
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
async function postJson(url, body) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
function sha256(p) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// 造一张测试 PNG（渐变，便于验证亮度/色温确实改变像素）
const ORIG_PNG = path.join(DIRS.clips, 'tmpverify_photo.png');
function makeTestPng() {
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'gradients=s=96x54:c0=0x203040:c1=0x8090a0:d=1',
    '-frames:v', '1', '-pix_fmt', 'rgb24', ORIG_PNG
  ], { stdio: 'ignore', timeout: 60000 });
  if (!fs.existsSync(ORIG_PNG) || fs.statSync(ORIG_PNG).size < 100) {
    throw new Error('测试 PNG 生成失败: ' + ORIG_PNG);
  }
}
function writePhotoEntry(id, filePath, extra = {}) {
  const entry = {
    id,
    versionGroupId: id,
    version: 1,
    isFinal: false,
    fileName: path.basename(filePath),
    filePath,
    url: '/clips/' + encodeURIComponent(path.basename(filePath)),
    taskId: 'tmpverify_' + id,
    index: 0,
    prompt: '【验收临时图】渐变测试画面',
    imagePrompt: '【验收临时图】渐变测试画面',
    generationPrompt: '【验收临时图】渐变测试画面',
    videoPrompt: '',
    provider: 'verify',
    model: 'wan2.7-image',
    width: 96,
    height: 54,
    sizeBytes: (() => { try { return fs.statSync(filePath).size; } catch (e) { return 0; } })(),
    status: 'approved',
    source: 'generation',
    createdAt: new Date().toISOString(),
    ...extra
  };
  fs.writeFileSync(path.join(DIRS.photos, id + '.json'), JSON.stringify(entry, null, 2), 'utf8');
  return entry;
}

async function main() {
  console.log('='.repeat(64));
  console.log('出图→图生视频 / 图片调色 · HTTP 契约验收（临时隔离实例）');
  console.log('='.repeat(64));

  // ---------- [0] 进程内：出图 Key 必须被 redact 清空（不落盘/不回前端） ----------
  // 背景：fe-assistant 复核发现 SENSITIVE_FIELDS 漏了 imageApiKey —— 漏了就会把出图 Key
  // 明文写进 data/tasks/*.json 和数据库，并随 GET /api/tasks/:id 回给前端。
  console.log('\n[0] 进程内：redact 脱敏（imageApiKey 不落盘）');
  {
    const redact = require(path.join(APP_DIR, 'src', 'utils', 'redact'));
    const sample = {
      taskId: 'redact_verify',
      runtimeConfig: {
        apiKey: 'sk-video-should-clear',
        imageApiKey: 'sk-image-should-clear',
        imageBaseUrl: 'https://example.test/v1',
        imageModel: 'wan2.7-image',
        imagePerClip: true
      }
    };
    const r = redact.redactTask(sample);
    ok('imageApiKey 列进 SENSITIVE_FIELDS', redact.SENSITIVE_FIELDS.includes('imageApiKey'));
    ok('redactTask 清空 runtimeConfig.imageApiKey', r.runtimeConfig.imageApiKey === '');
    ok('redactTask 不动原有 apiKey 脱敏', r.runtimeConfig.apiKey === '');
    ok('redactTask 保留非敏感图片字段（baseUrl/model/开关）',
      r.runtimeConfig.imageBaseUrl === 'https://example.test/v1'
      && r.runtimeConfig.imageModel === 'wan2.7-image'
      && r.runtimeConfig.imagePerClip === true);
    ok('redactTask 不修改原对象（只返回副本）', sample.runtimeConfig.imageApiKey === 'sk-image-should-clear');
  }

  // ---------- [0b] 进程内：视频通道预检（2026-11-16 20:30 更新） ----------
  // 旧结论「WhaleTV 中转不收首帧图 → 400」已被实测推翻（/video/generations + data URL 出片）。
  // 现在只保留「能力表外通道」兜底：未登记 i2v 能力的模型仍要在花钱前拒绝。
  console.log('\n[0b] 进程内：能力表外通道 + 出图 → IMAGE_FIRST_MODEL_UNSUPPORTED；中转不再被拦');
  {
    const pipeline = require(path.join(APP_DIR, 'src', 'pipeline'));

    // 1) openai-video（中转）：不再走通道预检，继续到「出图就绪度」校验（本进程无图 Key → IMAGE_GEN_NOT_READY）
    let errRelay = null;
    try {
      await pipeline._generateClipImages('gate_verify_image_first_relay', {
        taskId: 'gate_verify_image_first_relay',
        model: 'openai-video',
        runtimeConfig: { imagePerClip: true },
        clips: [{ index: 0, prompt: '测试画面', photoId: null }]
      });
    } catch (e) { errRelay = e; }
    ok('中转通道（openai-video）不再被通道预检拦下（继续走到出图就绪度校验）',
      !!errRelay && errRelay.code === 'IMAGE_GEN_NOT_READY', errRelay && errRelay.code);

    // 2) 能力表外通道（siliconflow 未登记 i2v）→ 仍在花钱前拒绝
    let errUnknown = null;
    try {
      await pipeline._generateClipImages('gate_verify_image_first_unknown', {
        taskId: 'gate_verify_image_first_unknown',
        model: 'siliconflow',
        runtimeConfig: { imagePerClip: true },
        clips: [{ index: 0, prompt: '测试画面', photoId: null }]
      });
    } catch (e) { errUnknown = e; }
    ok('能力表外通道（siliconflow）被提前拒绝', !!errUnknown && errUnknown.code === 'IMAGE_FIRST_MODEL_UNSUPPORTED',
      errUnknown && errUnknown.code);
    ok('拒绝文案说明「没有出图、没有产生图片费用」', !!errUnknown && /没有出图/.test(errUnknown.message) && /图片费用/.test(errUnknown.message));

    // 3) 百炼通道：同样继续走到就绪度校验
    let err2 = null;
    try {
      await pipeline._generateClipImages('gate_verify_image_first_ok', {
        taskId: 'gate_verify_image_first_ok',
        model: 'dashscope',
        runtimeConfig: { imagePerClip: true },
        clips: [{ index: 0, prompt: '测试画面', photoId: null }]
      });
    } catch (e) { err2 = e; }
    ok('百炼通道不被通道预检误拦（继续走到出图就绪度校验）',
      !!err2 && err2.code === 'IMAGE_GEN_NOT_READY', err2 && err2.code);
  }

  const picked = await pickFreePort(3093);
  if (!picked) { console.log('❌ 3093–3132 没有空闲端口'); process.exit(1); }
  BASE = `http://127.0.0.1:${picked}`;
  console.log(`  临时实例端口 ${picked}；临时目录 ${TMP}`);

  makeTestPng();
  writePhotoEntry('tmpverify_photo', ORIG_PNG);
  // 文件缺失的条目：用于 409 断言
  writePhotoEntry('tmpverify_missing', path.join(DIRS.clips, 'tmpverify_FIELD_MISSING.png'), {
    filePath: path.join(DIRS.clips, 'tmpverify_FIELD_MISSING.png'),
    url: '/clips/tmpverify_FIELD_MISSING.png',
    sizeBytes: 0
  });

  srv = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(picked),
      AUTH_ENABLED: 'false',
      DATABASE_TYPE: 'json',
      DATA_DIR: DIRS.tasks,
      CLIPS_DIR: DIRS.clips,
      OUTPUT_DIR: DIRS.output,
      LIBRARY_DIR: DIRS.library,
      PHOTOS_DIR: DIRS.photos,
      PROJECTS_DIR: DIRS.projects,
      LOG_DIR: DIRS.logs,
      ASSISTANT_DIR: DIRS.assistant,
      BUDGET_FILE: DIRS.budget,
      MOCK_FAIL_RATE: '0',
      // 强制「出图未配置」：.env 里的 IMAGE_GEN_* 不能生效（本机 .env 里 Key 为空，
      // 但仍然显式置空，避免别人机器上 .env 填过 Key 让这条负向断言失效）
      IMAGE_GEN_API_KEY: '',
      IMAGE_GEN_PROVIDER: '',
      IMAGE_GEN_BASE_URL: '',
      IMAGE_GEN_MODEL: ''
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const r = await fetch(BASE + '/api/status');
        if (r.ok) { ready = true; break; }
      } catch (e) { /* not yet */ }
    }
    ok('临时实例启动成功（/api/status 200）', ready, `port=${picked}`);
    if (!ready) return;

    // ---------- [1] 小智 info：出图就绪度与单价 ----------
    console.log('\n[1] GET /api/assistant/info → image');
    const info = await getJson('/api/assistant/info');
    const image = info.json && info.json.image;
    ok('info 200 且带 image 段', info.status === 200 && !!image);
    ok('image.usable 是布尔（未配置时为 false）', image && image.usable === false, image && `usable=${image.usable}`);
    ok('image.unitCny 是数字或 null（未知单价不得伪造成 0）',
      image && (image.unitCny === null || typeof image.unitCny === 'number'),
      image && `unitCny=${image.unitCny}, unitLabel=${image.unitLabel}`);
    ok('image 带 provider/model/size/hasServerKey 字段',
      image && 'provider' in image && 'model' in image && 'size' in image && typeof image.hasServerKey === 'boolean');

    // ---------- [1b] 出图自动调色默认值（A 方案，2026-11-23） ----------
    console.log('\n[1b] GET /api/image-gen/status → imageGrade');
    const gradeStatus = await getJson('/api/image-gen/status');
    const gradeInfo = gradeStatus.json && gradeStatus.json.imageGrade;
    ok('status 200 且下发 imageGrade { default, options }',
      gradeStatus.status === 200 && !!gradeInfo
      && ['off', 'calm'].includes(gradeInfo.default)
      && Array.isArray(gradeInfo.options) && gradeInfo.options.join(',') === 'off,calm',
      gradeInfo && `default=${gradeInfo.default} options=${(gradeInfo.options || []).join(',')}`);
    ok('默认值来自服务端（本验收实例未设置 env → off）',
      gradeInfo && gradeInfo.default === 'off', gradeInfo && gradeInfo.default);

    console.log('\n[1c] 非法 imageGrade → 400（在花钱之前拒绝）');
    const beforeInvalid = await getJson('/api/tasks');
    const beforeInvalidCount = Array.isArray(beforeInvalid.json) ? beforeInvalid.json.length : -1;
    const badBatch = await postJson('/api/images/generate-batch', { prompts: ['测试'], imageGrade: 'bogus' });
    ok('generate-batch 非法 imageGrade → 400 IMAGE_GRADE_INVALID',
      badBatch.status === 400 && badBatch.json && badBatch.json.code === 'IMAGE_GRADE_INVALID',
      `status=${badBatch.status} code=${badBatch.json && badBatch.json.code}`);
    const badTask = await postJson('/api/tasks', { prompt: '测试', imageGrade: 'bogus' });
    ok('/api/tasks 非法 imageGrade → 400 IMAGE_GRADE_INVALID',
      badTask.status === 400 && badTask.json && badTask.json.code === 'IMAGE_GRADE_INVALID',
      `status=${badTask.status} code=${badTask.json && badTask.json.code}`);
    const badExec = await postJson('/api/assistant/execute', { sessionId: 'x', approved: true, imageGrade: 'bogus' });
    ok('/api/assistant/execute 非法 imageGrade → 400 IMAGE_GRADE_INVALID',
      badExec.status === 400 && badExec.json && badExec.json.code === 'IMAGE_GRADE_INVALID',
      `status=${badExec.status} code=${badExec.json && badExec.json.code}`);
    const afterBad = await getJson('/api/tasks');
    const afterBadCount = Array.isArray(afterBad.json) ? afterBad.json.length : -1;
    ok('非法值没有创建任何任务', afterBadCount === beforeInvalidCount, `${beforeInvalidCount} → ${afterBadCount}`);

    // ---------- [2] execute：出图未配置必须前置拒绝 ----------
    console.log('\n[2] POST /api/assistant/execute（imagePerClip=true 且未配置出图）');
    const before = await getJson('/api/tasks');
    const beforeCount = Array.isArray(before.json) ? before.json.length : -1;
    const exec = await postJson('/api/assistant/execute', {
      sessionId: 'verify_imgfirst_session',
      planId: null,
      approved: true,
      imagePerClip: true
    });
    ok('返回 IMAGE_GEN_NOT_READY（不是建了任务再失败）',
      exec.json && exec.json.ok === false && exec.json.code === 'IMAGE_GEN_NOT_READY',
      exec.json && (exec.json.code || exec.json.error));
    ok('错误文案指向「设置 → 图片生成」或 IMAGE_GEN_API_KEY',
      /设置\s*→\s*图片生成|IMAGE_GEN_API_KEY/.test(String(exec.json && exec.json.error)));
    const after = await getJson('/api/tasks');
    const afterCount = Array.isArray(after.json) ? after.json.length : -1;
    ok('没有创建任何任务（任务数未变）', afterCount === beforeCount, `${beforeCount} → ${afterCount}`);

    // imagePerClip 关掉时，不应再触发这条拒绝（走原有会话校验）
    const execOff = await postJson('/api/assistant/execute', {
      sessionId: 'verify_imgfirst_session', planId: null, approved: true
    });
    ok('imagePerClip 缺省时不做出图校验（回到既有 ASSISTANT_BAD_SESSION）',
      execOff.json && execOff.json.ok === false && execOff.json.code === 'ASSISTANT_BAD_SESSION',
      execOff.json && execOff.json.code);

    // ---------- [3] 图片手动调色 ----------
    console.log('\n[3] POST /api/photos/:id/adjust');
    const list = await getJson('/api/photos');
    ok('临时实例能看到 2 张临时图（列表接口可用）',
      list.json && Array.isArray(list.json.photos) && list.json.photos.length >= 1,
      list.json && `photos=${(list.json.photos || []).length}`);

    const origHash = sha256(ORIG_PNG);
    const origStat = fs.statSync(ORIG_PNG);

    const emptyBody = await postJson('/api/photos/tmpverify_photo/adjust', { brightness: 0, contrast: 0, saturation: 0, temperature: 0 });
    ok('四参数全 0 → 400（不产生「成功但没变化」的假记录）', emptyBody.status === 400, `status=${emptyBody.status}`);

    const badRange = await postJson('/api/photos/tmpverify_photo/adjust', { brightness: 500 });
    ok('参数越界 → 400', badRange.status === 400, `status=${badRange.status}, ${badRange.json && badRange.json.error}`);

    const badType = await postJson('/api/photos/tmpverify_photo/adjust', { brightness: 'abc' });
    ok('参数非数字 → 400', badType.status === 400, `status=${badType.status}`);

    const notFound = await postJson('/api/photos/no_such_photo/adjust', { brightness: 10 });
    ok('图片不存在 → 404', notFound.status === 404, `status=${notFound.status}`);

    const missing = await postJson('/api/photos/tmpverify_missing/adjust', { brightness: 10 });
    ok('原图文件缺失 → 409', missing.status === 409, `status=${missing.status}, ${missing.json && missing.json.error}`);

    const apply1 = await postJson('/api/photos/tmpverify_photo/adjust', {
      brightness: 40, contrast: 20, saturation: 30, temperature: 25
    });
    const p1 = apply1.json && apply1.json.photo;
    ok('应用成功 200 且 adjusted=true', apply1.status === 200 && apply1.json.adjusted === true,
      apply1.json && (apply1.json.error || `filter=${String(apply1.json.filter).slice(0, 80)}`));
    ok('返回 ffmpeg 滤镜串（eq + colorbalance）',
      !!apply1.json && /eq=/.test(String(apply1.json.filter)) && /colorbalance=/.test(String(apply1.json.filter)),
      apply1.json && apply1.json.filter);
    ok('photo.adjust.params 记下四个参数',
      p1 && p1.adjust && p1.adjust.params && p1.adjust.params.brightness === 40
      && p1.adjust.params.temperature === 25);
    ok('photo.adjust 记下原图路径（保留原图可回退）',
      p1 && p1.adjust && p1.adjust.originalPath === ORIG_PNG, p1 && p1.adjust && p1.adjust.originalPath);
    ok('版本链 versions 长度 1 且 version=1',
      p1 && Array.isArray(p1.adjust.versions) && p1.adjust.versions.length === 1
      && p1.adjust.versions[0].version === 1);
    const out1 = p1 && p1.filePath;
    ok('调色产物文件真实存在且非空', !!(out1 && fs.existsSync(out1) && fs.statSync(out1).size > 100), out1);
    ok('调色产物不是原图的字节（确实重新编码过）', !!(out1 && sha256(out1) !== origHash));
    ok('原图字节未被改动（sha256 相同）', sha256(ORIG_PNG) === origHash);
    ok('原图 mtime 未被改动', fs.statSync(ORIG_PNG).mtimeMs === origStat.mtimeMs);
    const served = await fetch(BASE + p1.url);
    ok('调色图可通过 /clips 静态地址访问（200）', served.status === 200, `status=${served.status} url=${p1.url}`);

    const apply2 = await postJson('/api/photos/tmpverify_photo/adjust', { brightness: -40, temperature: -30 });
    const p2 = apply2.json && apply2.json.photo;
    ok('第二次调色 200 且版本链长度 2',
      apply2.status === 200 && p2 && Array.isArray(p2.adjust.versions) && p2.adjust.versions.length === 2,
      p2 && `versions=${p2.adjust && p2.adjust.versions && p2.adjust.versions.length}`);
    ok('两次产物路径不同（旧版本没被覆盖）',
      p2 && p2.adjust.versions[0].filePath !== p2.adjust.versions[1].filePath
      && fs.existsSync(p2.adjust.versions[0].filePath));
    ok('第二次也是从原图渲染（等价于绝对值语义：addition 不是叠加）',
      p2 && p2.adjust.originalPath === ORIG_PNG);

    const revert = await postJson('/api/photos/tmpverify_photo/adjust', { reset: true });
    const p3 = revert.json && revert.json.photo;
    ok('回退原图 200 且 reverted=true', revert.status === 200 && revert.json.reverted === true);
    ok('回退后 filePath 指向原图', p3 && p3.filePath === ORIG_PNG, p3 && p3.filePath);
    ok('回退后 adjust.params 清空', p3 && p3.adjust && p3.adjust.params === null);
    ok('回退后 adjust.current 指回原图并标记 reverted（契约一致性）',
      p3 && p3.adjust && p3.adjust.current && p3.adjust.current.filePath === ORIG_PNG
      && p3.adjust.current.reverted === true);
    ok('回退后版本历史仍保留（可追溯，不删文件）',
      p3 && Array.isArray(p3.adjust.versions) && p3.adjust.versions.length === 2,
      p3 && p3.adjust && p3.adjust.versions && p3.adjust.versions.length);
    ok('回退后原图内容未变', sha256(ORIG_PNG) === origHash);

    // ---------- [4] 调色不产生费用 ----------
    console.log('\n[4] 调色不产生费用（本地派生）');
    const budgetNow = await getJson('/api/budget');
    ok('预算未扣（调色不算生成）', !budgetNow.json || Number(budgetNow.json.spentUsd) === 0,
      budgetNow.json && `spent=$${budgetNow.json.spentUsd}`);
    const pFinal = revert.json && revert.json.photo;
    ok('调色不改写 photo.cost（仍是生成时的费用记录）',
      pFinal && pFinal.cost && pFinal.cost.basis !== 'derived' && pFinal.source === 'generation',
      pFinal && `basis=${pFinal.cost && pFinal.cost.basis}, source=${pFinal.source}`);
  } finally {
    try { if (srv) srv.kill(); } catch (e) { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    console.log('\n' + '='.repeat(64));
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    if (fail > 0) {
      console.log('失败项：');
      failures.forEach((f) => console.log(`  - ${f.name}${f.extra ? ': ' + f.extra : ''}`));
    }
    console.log('='.repeat(64));
    process.exit(fail === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error('验证异常:', e && e.stack ? e.stack : e);
  try { if (srv) srv.kill(); } catch (err) { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  process.exit(1);
});
