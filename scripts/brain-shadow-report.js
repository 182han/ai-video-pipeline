// ==========================================
// 小智大脑 · S1 影子期对比报告（只读，不改行为）
// ------------------------------------------------------------
// 用途：拿一批**真实原话**，同时跑
//   ① 现有规则层 memory.classify()
//   ② 大脑 C1 brain.understand()（真调模型，会产生极小额费用）
// 输出「一致 / 分歧 / 大脑拿不准 / 大脑不可用」四类，并落 JSONL 供复盘。
//
// 用法：
//   node scripts/brain-shadow-report.js                    # 默认语料（含用户真实措辞）
//   node scripts/brain-shadow-report.js --from-sessions   # 从 data/assistant/sessions 捞真实原话
//   node scripts/brain-shadow-report.js --file corpus.txt # 一行一句
//   node scripts/brain-shadow-report.js --limit 20
//   node scripts/brain-shadow-report.js --key-file C:\path\llm.json
//
// Key 来源（按顺序）：
//   1) --key-file 指向的 JSON：{"apiKey":"...","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"}
//   2) .env 的 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
// 没有 Key 时**不发任何请求**，打印"未验证"并以退出码 2 结束（跳过 ≠ 通过）。
// ==========================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const memory = require('../src/assistant/memory');
const brain = require('../src/assistant/brain');

const args = process.argv.slice(2);
function flag(name) { return args.indexOf(name) !== -1; }
function value(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const BASE_DIR = path.join(__dirname, '..');
const SESSION_DIR = path.join(BASE_DIR, 'data', 'assistant');
const OUT_DIR = path.join(BASE_DIR, 'data', 'assistant');
const LIMIT = Number(value('--limit')) > 0 ? Number(value('--limit')) : 40;

// 默认语料：用户 2026-11-18 报过的原话 + 几类"没出现过"的说法。
// 注明来源，避免下一轮把它当成"用户真实语料"。
const DEFAULT_CORPUS = [
  '提示词呢', '那提示词呢', '场景卡看一下', '场景卡我看一下', '帮我把提示词发我',
  '换一组', '这三个都换掉', '换一个场景卡，我不太满意',
  '十秒 每段5秒', '不要场景卡', '2 分钟极光', '改成 1080p',
  '进度', '上一次的视频', '预算还剩多少', '上次那条为什么失败', '配乐换一首',
  '你选的是哪几张卡', '再来一条短点的', '这个场景换个地方'
];

function loadKey() {
  const kf = value('--key-file');
  if (kf) {
    try {
      // Windows PowerShell 的 Out-File -Encoding UTF8 会写 BOM（EF BB BF），
      // JSON.parse 会直接报 "Unexpected token"。这里先剥掉，避免用户被这种坑绊住。
      let raw = fs.readFileSync(kf, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const j = JSON.parse(raw);
      if (j && j.apiKey) return { apiKey: String(j.apiKey), baseUrl: j.baseUrl || '', model: j.model || '', source: 'key-file' };
    } catch (e) {
      console.log('! --key-file 读取失败: ' + e.message);
    }
  }
  if (config.OPENAI_API_KEY) {
    return { apiKey: config.OPENAI_API_KEY, baseUrl: config.OPENAI_BASE_URL || '', model: config.OPENAI_MODEL || 'deepseek-chat', source: '.env' };
  }
  return null;
}

function fromSessions(limit) {
  const dir = path.join(SESSION_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const seen = new Set();
  const out = [];
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    const msgs = Array.isArray(j && j.messages) ? j.messages : [];
    for (const m of msgs) {
      if (!m || m.role !== 'user') continue;
      const t = String(m.text || m.content || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 80 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function loadCorpus() {
  const f = value('--file');
  if (f) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { list: lines.slice(0, LIMIT), source: 'file:' + f };
  }
  if (flag('--from-sessions')) {
    const list = fromSessions(LIMIT);
    if (list.length) return { list, source: 'sessions' };
    console.log('! 会话目录里没有可用的用户原话，回退默认语料');
  }
  return { list: DEFAULT_CORPUS.slice(0, LIMIT), source: 'default(用户报过的原话+构造句)' };
}

(async () => {
  const { list, source } = loadCorpus();
  const key = loadKey();

  console.log('小智大脑 · S1 影子对比报告');
  console.log('语料来源: ' + source + '，共 ' + list.length + ' 句');
  console.log('大脑版本: C1 ' + brain.BRAIN_VERSION);
  console.log('');

  if (!key) {
    console.log('⚠️ 未找到 LLM Key（--key-file 或 .env 的 OPENAI_API_KEY）');
    console.log('   本次**未发出任何请求**，结论 = 未验证（跳过 ≠ 通过）。');
    console.log('   规则层结果先给你看（这部分不需要 Key）：');
    list.forEach((t) => console.log('   ' + JSON.stringify(t) + ' -> ' + memory.classify(t).intent));
    process.exit(2);
  }

  const ctx = { hasPlan: false, planSummary: null };
  const rows = [];
  let same = 0, diff = 0, unsure = 0, unavailable = 0;

  for (const text of list) {
    const rule = memory.classify(text).intent;
    let r = null;
    try {
      r = await brain.understand(text, {
        apiKey: key.apiKey, baseUrl: key.baseUrl, model: key.model, lang: 'zh', ctx
      });
    } catch (e) {
      r = { ok: false, failure: { kind: 'THROWN', detail: String(e && e.message) } };
    }
    const cmp = brain.compare(rule, r);
    if (cmp.mode === 'same') same++;
    else if (cmp.mode === 'diff') diff++;
    else if (cmp.mode === 'brain_unsure') unsure++;
    else unavailable++;

    rows.push({
      at: new Date().toISOString(),
      text, rule,
      mode: cmp.mode,
      brain: r && r.ok ? { intent: r.intent, confidence: r.confidence, clarify: r.clarify, slots: r.slots } : null,
      failure: r && r.ok ? null : (r && r.failure) || null
    });

    const mark = cmp.mode === 'same' ? '  ' : (cmp.mode === 'diff' ? '≠ ' : (cmp.mode === 'brain_unsure' ? '? ' : '× '));
    const brainCol = r && r.ok
      ? (r.intent + (r.confidence !== null ? '(' + r.confidence + ')' : ''))
      : ('[' + ((r && r.failure && r.failure.kind) || 'ERR') + ']');
    console.log(mark + JSON.stringify(text).padEnd(40) + ' 规则=' + rule.padEnd(11) + ' 大脑=' + brainCol);
  }

  const total = rows.length || 1;
  console.log('');
  console.log('---- 汇总 ----');
  console.log('一致        : ' + same);
  console.log('分歧        : ' + diff);
  console.log('大脑拿不准  : ' + unsure + '（选了 clarify，属安全失败）');
  console.log('大脑不可用  : ' + unavailable);
  console.log('一致率      : ' + (same / total * 100).toFixed(1) + '%');
  console.log('注意：影子期**不改行为**，以上只是一次观测；是否切换见方案 S1 决策门。');

  try {
    const f = path.join(OUT_DIR, 'brain-shadow-' + new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.appendFileSync(f, rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    console.log('落盘: ' + f);
  } catch (e) {
    console.log('! 落盘失败: ' + e.message);
  }

  process.exit(0);
})().catch((e) => {
  console.log('验证异常: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
