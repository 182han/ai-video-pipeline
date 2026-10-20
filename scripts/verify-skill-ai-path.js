// ==========================================
// 验收：skill 规则是否真的随请求发到了 LLM（端到端，不花钱）
//
// 做法：起一个本地 mock OpenAI 兼容服务，把 optimizeWithAI 指过去，
// 断言「出站请求的 system message 里确实带上了 skill 规则段」，
// 并断言返回结果被正确采纳。全程不联网、不消耗真实额度。
//
// 覆盖：
//   1. 风光主题 → system prompt 含 skill 段，请求体结构合法
//   2. 城市夜景 → 不含 skill 段
//   3. 无主题   → 不含 skill 段
//   4. SKILL_PROMPT_ENABLED=false → 不含 skill 段
//   5. 返回内容被采纳为 optimized，method=ai
// ==========================================

const http = require('http');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const MARKER = '摄影级风光叠加规则';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t) {
  console.log(`\n--- ${t} ---`);
}

// 起一个假的 OpenAI /chat/completions 服务，记录最后一次请求体
function startMock() {
  return new Promise((resolve) => {
    const captured = { bodies: [] };
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (e) { /* 保留 null */ }
        captured.bodies.push(body);
        captured.lastPath = req.url;
        captured.lastAuth = req.headers.authorization || '';
        // 返回一个明显可辨识的中文结果，便于断言「被采纳」
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '【MOCK】沙丘脊线在低角度侧光下，高光受控，画面停在脊线上' } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      captured.port = server.address().port;
      captured.close = () => new Promise((r) => server.close(r));
      resolve(captured);
    });
  });
}

(async () => {
  console.log('=== verify-skill-ai-path ===\n');

  const mock = await startMock();
  const baseUrl = `http://127.0.0.1:${mock.port}/v1`;
  const optimizer = require(path.join(APP_DIR, 'src', 'promptOptimizer.js'));

  const call = (prompt, theme) => optimizer.optimizeWithAI(prompt, theme, {
    apiKey: 'test-key-not-real',
    baseUrl,
    model: 'mock-model',
  });

  // ---------- 1. 风光主题 ----------
  section('1. 风光主题：规则随请求发出');
  const r1 = await call('沙漠上的日落', 'desert');
  const body1 = mock.bodies[mock.bodies.length - 1];
  const sys1 = (body1 && body1.messages && body1.messages[0] && body1.messages[0].content) || '';

  ok('请求打到 /chat/completions', (mock.lastPath || '').endsWith('/chat/completions'), mock.lastPath);
  ok('带上了 Authorization', mock.lastAuth.startsWith('Bearer '), mock.lastAuth.slice(0, 12));
  ok('messages 为 system+user 两条', Array.isArray(body1.messages) && body1.messages.length === 2);
  ok('首条为 system', body1.messages[0].role === 'system');
  ok('**system 里含 skill 规则段**', sys1.includes(MARKER));
  ok('system 要求全中文输出', sys1.includes('全中文输出'));
  ok('system 含地貌专名表', sys1.includes('沙丘脊线') && sys1.includes('丹霞'));
  ok('system 含高光控制', sys1.includes('高光'));

  ok('返回被采纳（method=ai）', r1.method === 'ai', r1.method);
  ok('返回内容原样作为 optimized', r1.optimized.includes('【MOCK】'), r1.optimized.slice(0, 30));
  ok('negative 取自模板', typeof r1.negative === 'string' && r1.negative.length > 0);

  // ---------- 2. 城市夜景不追加 ----------
  section('2. 城市夜景：不追加');
  const r2 = await call('雨后霓虹街道', 'city');
  const sys2 = mock.bodies[mock.bodies.length - 1].messages[0].content;
  ok('city 的 system 不含 skill 段', !sys2.includes(MARKER));
  ok('city 返回仍正常', r2.method === 'ai');

  // ---------- 3. 无主题不追加 ----------
  section('3. 无主题：不追加');
  const r3 = await call('随便一个画面', null);
  const sys3 = mock.bodies[mock.bodies.length - 1].messages[0].content;
  ok('null 主题的 system 不含 skill 段', !sys3.includes(MARKER));
  ok('null 主题 themeLabel=无主题', r3.theme === '无主题', r3.theme);

  // ---------- 4. 全局开关 ----------
  section('4. SKILL_PROMPT_ENABLED=false 关闭');
  process.env.SKILL_PROMPT_ENABLED = 'false';
  await call('沙漠上的日落', 'desert');
  const sys4 = mock.bodies[mock.bodies.length - 1].messages[0].content;
  ok('关闭后 system 不含 skill 段', !sys4.includes(MARKER));
  delete process.env.SKILL_PROMPT_ENABLED;
  await call('沙漠上的日落', 'desert');
  const sys5 = mock.bodies[mock.bodies.length - 1].messages[0].content;
  ok('移除开关后恢复追加', sys5.includes(MARKER));

  // ---------- 汇总 ----------
  await mock.close();
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验收脚本异常:', e);
  process.exit(1);
});
