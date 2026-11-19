// ==========================================
// E0：量化规则层的"歧义"（2026-11-19，纯只读，不调模型、不改行为）
// ------------------------------------------------------------
// 问题：memory.classify() 是"按顺序首个命中就 return"，之后的信号被丢弃。
//      「我要1个20秒的…把场景卡给我看一下」同时命中 create 与 plan_scenes，
//       被"场景卡"抢先，create 信号就消失了。
// 本脚本只统计三件事，用来决定"规则多候选改造"值不值得做：
//   ① 零命中 / 单命中 / 多命中 各占多少；
//   ② 多命中的句子里，现有优先级选的是哪个、被丢弃的又是哪些；
//   ③ 零命中的句子长什么样（这些才是真需要模型兜底的）。
//
// 用法：node scripts/analyze-rule-ambiguity.js [--sessions 40] [--limit 60]
// 退出码恒为 0（这是分析工具，不是断言）。
// ==========================================
'use strict';

const fs = require('fs');
const path = require('path');
const memory = require('../src/assistant/memory');

const args = process.argv.slice(2);
function value(name, dflt) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : dflt;
}
const WANT_SESSIONS = value('--sessions', 40);

// 用户 2026-11-18 报过的原话 + 几类没出现过的说法（构造句，单独标注）
const CONSTRUCTED = [
  '提示词呢', '那提示词呢', '场景卡看一下', '场景卡我看一下', '帮我把提示词发我',
  '换一组', '这三个都换掉', '换一个场景卡，我不太满意',
  '十秒 每段5秒', '不要场景卡', '2 分钟极光', '改成 1080p',
  '进度', '上一次的视频', '预算还剩多少', '上次那条为什么失败', '配乐换一首',
  '你选的是哪几张卡', '再来一条短点的', '这个场景换个地方'
];

function fromSessions(limit) {
  const dir = path.join(__dirname, '..', 'data', 'assistant', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const seen = new Set();
  const out = [];
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    for (const m of (Array.isArray(j && j.messages) ? j.messages : [])) {
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

const MAP_TO_INTENT = (hit) => (hit.startsWith('plan_edit') ? 'plan_edit' : hit);

(function main() {
  const sessions = fromSessions(WANT_SESSIONS);
  const corpus = [];
  sessions.forEach((t) => corpus.push({ text: t, src: 'sessions' }));
  CONSTRUCTED.forEach((t) => {
    if (!corpus.some((c) => c.text === t)) corpus.push({ text: t, src: 'constructed' });
  });

  let zero = 0, single = 0, multi = 0, inconsistent = 0;
  const multiRows = [];
  const zeroRows = [];

  for (const item of corpus) {
    const hits = memory.traceMatches(item.text);
    const cls = memory.classify(item.text).intent;
    // 一致性：trace 的首个命中映射后必须等于 classify 的输出
    const firstMapped = hits.length ? MAP_TO_INTENT(hits[0]) : 'unknown';
    if (firstMapped !== cls) {
      inconsistent++;
      console.log('!! 不一致 ' + JSON.stringify(item.text) + '  trace首=' + firstMapped + '  classify=' + cls);
    }
    if (hits.length === 0) { zero++; zeroRows.push(item); }
    else if (hits.length === 1) single++;
    else { multi++; multiRows.push({ ...item, hits, cls }); }
  }

  const total = corpus.length || 1;
  console.log('E0 规则层歧义统计');
  console.log('语料: sessions ' + sessions.length + ' 句 + constructed ' + CONSTRUCTED.length + ' 句 = 共 ' + corpus.length + ' 句');
  console.log('');
  console.log('零命中  : ' + zero + '  (' + (zero / total * 100).toFixed(1) + '%)  ← 只有这些才真需要模型兜底');
  console.log('单命中  : ' + single + '  (' + (single / total * 100).toFixed(1) + '%)');
  console.log('多命中  : ' + multi + '  (' + (multi / total * 100).toFixed(1) + '%)  ← 这些句子里有信号被丢弃');
  console.log('trace/classify 不一致: ' + inconsistent + (inconsistent ? '  !! 需要修 traceMatches' : '  （一致）'));
  console.log('');

  if (multiRows.length) {
    console.log('---- 多命中明细（现有代码只取第一个）----');
    multiRows.forEach((r) => {
      console.log('  ' + JSON.stringify(r.text));
      console.log('    命中顺序: ' + r.hits.join(' → ') + '   实际采用: ' + r.cls
        + '   被丢弃: ' + r.hits.slice(1).join(', '));
    });
    console.log('');
  }

  if (zeroRows.length) {
    console.log('---- 零命中明细（规则完全没接住）----');
    zeroRows.forEach((r) => console.log('  [' + r.src + '] ' + JSON.stringify(r.text)));
  }
})();
