
const storage = require('../src/storage');

(async () => {
  await storage.init();
  const tasks = await storage.getAllTasks();
  console.log('任务数:', tasks.length);

  // 统计提示词来源
  let fromTasks = 0, fromClips = 0, garbled = 0, empty = 0;
  const seen = new Set();
  const candidates = [];

  const isGarbled = (s) => {
    if (!s) return false;
    const t = s.trim();
    if (!t) return true;
    // 全是问号或替换字符 => 编码损坏
    const qmarks = (t.match(/[?\uFFFD]/g) || []).length;
    return qmarks / t.length > 0.5;
  };

  for (const t of tasks) {
    // 1) 任务级提示词
    for (const [field, val] of [['prompt', t.prompt], ['optimizedPrompt', t.optimizedPrompt]]) {
      if (!val) { empty++; continue; }
      const text = String(val).trim();
      if (!text) { empty++; continue; }
      if (isGarbled(text)) { garbled++; continue; }
      const key = field + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ taskId: t.taskId, text, optimizedText: field === 'optimizedPrompt' ? text : '', theme: t.theme || null, model: t.model || null });
      fromTasks++;
    }

    // 2) 片段级提示词（多镜头任务每段不同）
    for (const c of (t.clips || [])) {
      const text = String(c.prompt || '').trim();
      if (!text) continue;
      if (isGarbled(text)) { garbled++; continue; }
      const key = 'clip|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ taskId: t.taskId, text, optimizedText: '', theme: c.theme || t.theme || null, model: t.model || null });
      fromClips++;
    }
  }

  console.log('');
  console.log('=== 抽取结果 ===');
  console.log('  任务级提示词:', fromTasks);
  console.log('  片段级提示词:', fromClips);
  console.log('  乱码跳过   :', garbled);
  console.log('  空值跳过   :', empty);
  console.log('  去重后合计 :', candidates.length);

  console.log('');
  console.log('=== 样例（前5条）===');
  candidates.slice(0, 5).forEach((c, i) => {
    console.log('  ' + (i+1) + '. [' + (c.theme || '-') + '] ' + c.text.slice(0, 55));
  });

  if (process.argv.includes('--apply')) {
    console.log('');
    console.log('=== 写入 prompts 表 ===');
    let ok = 0, fail = 0;
    for (const c of candidates) {
      try {
        await storage.savePrompt({
          taskId: c.taskId,
          text: c.text,
          optimizedText: c.optimizedText,
          theme: c.theme,
          model: c.model,
          createdAt: undefined
        });
        ok++;
      } catch (e) {
        fail++;
        if (fail <= 3) console.log('  失败:', e.message.slice(0, 80));
      }
    }
    console.log('  写入成功:', ok, '| 失败:', fail);
  } else {
    console.log('');
    console.log('（预演模式，加 --apply 才会真正写入）');
  }

  await storage.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
