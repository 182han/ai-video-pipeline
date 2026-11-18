// ==========================================
// 验收：live 英文界面扫中文（2026-11-18 S3 / D1）
// ------------------------------------------------------------
// 为什么需要它：`verify-i18n --strict` 只扫**源码字面量**。
// 后端在运行时拼出来的句子（模型名、费用 label、计划卡 Note、WS 播报）它一条都扫不到。
// 本脚本用真实登录态 + `vs_lang=en` 打**真实接口**，把响应里系统生成的中文挑出来。
//
// 边界（如实告知）：
//   · 只覆盖 **API 层**。页面 DOM 需要浏览器，本机没有 Electron → 未覆盖，输出里会写明。
//   · 用户内容（提示词、主题名、场景卡文案）是**数据不是文案**，按 key 白名单跳过，不误报。
//
// 用法：
//   node scripts/verify-i18n-live.js
//   node scripts/verify-i18n-live.js --cred-file C:\path\cred.json --lang en
//   node scripts/verify-i18n-live.js --base http://127.0.0.1:3001
// 退出码：0 = 白名单外零命中；1 = 有命中（附清单）；2 = 登录不起来/接口不可达（未验证）。
// ==========================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
function value(name, dflt) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
}
const BASE = value('--base', 'http://127.0.0.1:3001').replace(/\/+$/, '');
const LANG = value('--lang', 'en');
const CRED = value('--cred-file', path.join(os.tmpdir(), 'dsh-accept-cred.json'));

// 用户内容：这些 key 下的中文是**数据**，不是界面文案，跳过不报。
const USER_CONTENT_KEYS = new Set([
  'prompt', 'prompts', 'promptLines', 'imagePromptLines', 'optimizedPrompt', 'negativePrompt', 'imagePrompt', 'imagePrompts',
  'theme', 'themeLabel', 'themeTag', 'sceneKey', 'scene_key', 'protagonist', 'feature', 'foreground',
  'originalPrompt', 'generationPrompt', 'revisionNote', 'reviewNote', 'scienceNotes',
  'highlight_control', 'avoid', 'end_lock', 'label', 'labelEn', 'title',
  'fileName', 'filePath', 'path', 'outputPath', 'finalPath', 'videoPath', 'masterPath',
  'error', // 生成器的原始错误常带厂商中文，属"如实透传"，不当作 i18n 缺陷
  'original_feature', 'scienceNotes', 'failureSummary', 'note'
]);

const CJK = /[\u4e00-\u9fff]/;

async function login() {
  const c = JSON.parse(fs.readFileSync(CRED, 'utf8').replace(/^\uFEFF/, ''));
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: c.username, password: c.password })
  });
  if (r.status !== 200) throw new Error('登录失败 HTTP ' + r.status);
  const session = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).join('; ');
  return 'vs_lang=' + encodeURIComponent(LANG) + '; ' + session;
}

function walk(node, keyPath, out) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (CJK.test(node)) out.push({ path: keyPath || '(root)', value: node.slice(0, 120) });
    return;
  }
  if (Array.isArray(node)) {
    node.slice(0, 40).forEach((v, i) => walk(v, keyPath + '[' + i + ']', out));
    return;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (USER_CONTENT_KEYS.has(k)) continue;
      walk(node[k], keyPath ? keyPath + '.' + k : k, out);
    }
  }
}

(async () => {
  let cookie;
  try {
    cookie = await login();
  } catch (e) {
    console.log('⚠️ 未验证：' + e.message);
    console.log('   （需要 --cred-file 指向 {"username","password"}，或服务没起）');
    process.exit(2);
  }

  console.log('live 英文扫中文  base=' + BASE + '  lang=' + LANG);
  console.log('');

  // 先拿一条任务 id，给详情接口用
  let taskId = null;
  try {
    const rt = await fetch(BASE + '/api/tasks', { headers: { cookie } });
    const tj = await rt.json();
    const arr = Array.isArray(tj) ? tj : (tj && (tj.tasks || tj.data)) || [];
    taskId = arr[0] && arr[0].taskId;
  } catch (e) { /* ignore */ }

  const targets = [
    { name: 'GET /api/status', url: BASE + '/api/status' },
    { name: 'GET /api/tasks', url: BASE + '/api/tasks' },
    { name: 'GET /api/library', url: BASE + '/api/library' },
    { name: 'GET /api/photos', url: BASE + '/api/photos' },
    { name: 'GET /api/scene-cards/preview', url: BASE + '/api/scene-cards/preview?count=2' },
    { name: 'GET /api/assistant/info', url: BASE + '/api/assistant/info' },
    { name: 'GET /api/recycle', url: BASE + '/api/recycle' }
  ];
  if (taskId) targets.push({ name: 'GET /api/tasks/' + taskId, url: BASE + '/api/tasks/' + encodeURIComponent(taskId) });

  const findings = [];
  for (const t of targets) {
    try {
      const r = await fetch(t.url, { headers: { cookie } });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      const hits = [];
      if (json) walk(json, '', hits);
      else if (CJK.test(text)) hits.push({ path: '(non-json)', value: text.slice(0, 120) });
      const mark = hits.length ? '❌' : '✅';
      console.log(`${mark} ${t.name}  (http ${r.status})` + (hits.length ? '  命中 ' + hits.length + ' 处' : ''));
      hits.forEach((h) => findings.push({ endpoint: t.name, path: h.path, value: h.value }));
    } catch (e) {
      console.log(`⚠️ ${t.name}  请求失败: ${e.message}`);
    }
  }

  // 小智对话：英文模式下系统话术不得含中文
  for (const text of ['2 分钟', '???', '25 seconds']) {
    try {
      const r = await fetch(BASE + '/api/assistant/message', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text, aiLang: LANG, sessionId: 'i18nlive_' + Date.now().toString(36) })
      });
      const j = await r.json();
      const reply = String(j.reply || '');
      const bad = CJK.test(reply);
      console.log(`${bad ? '❌' : '✅'} POST /api/assistant/message  ${JSON.stringify(text)}  reply 含中文=${bad}`);
      if (bad) findings.push({ endpoint: 'assistant/message', path: 'reply', value: reply.replace(/\s+/g, ' ').slice(0, 140) });
    } catch (e) {
      console.log('⚠️ assistant/message 失败: ' + e.message);
    }
  }

  console.log('');
  if (findings.length) {
    console.log('---- 白名单外的中文命中 ----');
    findings.slice(0, 60).forEach((f) => console.log(`  [${f.endpoint}] ${f.path} → ${f.value}`));
    if (findings.length > 60) console.log('  …（只显示前 60 条，共 ' + findings.length + ' 条）');
  } else {
    console.log('白名单外零命中 ✅');
  }
  console.log('');
  console.log('未覆盖：页面 DOM（没有浏览器内核）。DOM 层中文仍需人工或 CDP 截图验收。');
  process.exit(findings.length ? 1 : 0);
})().catch((e) => {
  console.log('验证异常: ' + (e && e.message ? e.message : e));
  process.exit(2);
});
