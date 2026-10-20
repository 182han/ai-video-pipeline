// 补齐 tasks/clips 的 qc_version 列（对方 schema 已定义但线上库未执行）
const config = require('../config');
(async () => {
  const pg = require('pg');
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    const before = await client.query("select table_name, column_name from information_schema.columns where table_name in ('tasks','clips') and column_name='qc_version'");
    console.log('迁移前 qc_version 列:', JSON.stringify(before.rows));
    await client.query('alter table tasks add column if not exists qc_version integer');
    await client.query('alter table clips add column if not exists qc_version integer');
    const after = await client.query("select table_name, column_name from information_schema.columns where table_name in ('tasks','clips') and column_name='qc_version' order by table_name");
    console.log('迁移后 qc_version 列:', after.rows.map(r=>r.table_name).join(', '));
  } finally { await client.end(); }
})().catch(e => { console.error('失败:', e.message); process.exitCode = 1; });
