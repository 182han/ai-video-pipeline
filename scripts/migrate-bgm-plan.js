// ==========================================
// 配乐改造迁移：给 tasks 表补 bgm_plan / bgm_result 两列
// ==========================================
// 幂等：列已存在时什么都不做，可反复执行。
// 用法：node scripts/migrate-bgm-plan.js
const config = require('../config');

async function main() {
  if ((config.DATABASE_TYPE || '').toLowerCase() !== 'postgres') {
    console.log('当前 DATABASE_TYPE 不是 postgres（' + (config.DATABASE_TYPE || '空=本地JSON') + '），无需迁移。');
    console.log('本地 JSON 驱动会原样保存 bgmPlan / bgmResult 字段，无需建列。');
    return { ok: true, skipped: true };
  }
  if (!config.DATABASE_URL) {
    console.error('DATABASE_TYPE=postgres 但 DATABASE_URL 为空，无法迁移。');
    process.exitCode = 1;
    return { ok: false };
  }

  const pg = require('pg');
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    // 先确认 tasks 表存在，避免在没建表的库上“迁移成功”
    const t = await client.query("select to_regclass('public.tasks') as t");
    if (!t.rows[0] || !t.rows[0].t) {
      throw new Error('tasks 表不存在，请先执行 src/storage/schema.sql');
    }

    await client.query('alter table tasks add column if not exists bgm_plan jsonb');
    await client.query('alter table tasks add column if not exists bgm_result jsonb');

    const cols = await client.query(
      "select column_name, data_type from information_schema.columns where table_name='tasks' and column_name in ('bgm_plan','bgm_result') order by column_name"
    );
    console.log('[migrate-bgm] tasks 表配乐列：');
    for (const row of cols.rows) console.log('  - ' + row.column_name + ' ' + row.data_type);
    if (cols.rows.length !== 2) throw new Error('补列后校验失败，期望 2 列，实际 ' + cols.rows.length);

    return { ok: true, columns: cols.rows.length };
  } finally {
    await client.end();
  }
}

main().then(r => {
  if (r && r.ok) console.log('[migrate-bgm] 完成');
}).catch(e => {
  console.error('[migrate-bgm] 失败:', e.message);
  process.exitCode = 1;
});
