#!/usr/bin/env node
// ==========================================
// 数据迁移脚本：本地 JSON 文件 → 数据库
// ==========================================
// 用法：
//   1. 先在 .env 里配好 DATABASE_URL 和 DATABASE_TYPE=postgres
//   2. 在数据库里执行 src/storage/schema.sql 建表
//   3. 运行：node scripts/migrate-to-db.js
//
// 幂等：同一个 taskId 重复执行只会覆盖，不会产生重复数据。
// ==========================================

const path = require('path');
const config = require('../config');
const storage = require('../src/storage');

(async () => {
  console.log('========================================');
  console.log('  本地 JSON → 数据库 迁移');
  console.log('========================================');
  console.log('');

  if (!config.DATABASE_TYPE || !config.DATABASE_URL) {
    console.error('❌ 未配置数据库。请在 .env 里设置：');
    console.error('   DATABASE_TYPE=postgres');
    console.error('   DATABASE_URL=postgresql://...');
    process.exit(1);
  }

  console.log(`驱动: ${config.DATABASE_TYPE}`);
  console.log(`目标: ${String(config.DATABASE_URL).replace(/:[^:@]+@/, ':***@')}`);
  console.log('');

  try {
    await storage.init();
    console.log('✅ 数据库连接成功');
    console.log('');

    const dataDir = path.join(__dirname, '..', 'data', 'tasks');
    console.log('开始迁移 ' + dataDir + ' ...');

    const result = await storage.migrateFromJsonFiles(dataDir);

    console.log('');
    console.log('========================================');
    console.log(`  ✅ 成功: ${result.migrated} 条`);
    if (result.failed > 0) {
      console.log(`  ⚠️  失败: ${result.failed} 条（见上方日志）`);
    }
    console.log('========================================');

    await storage.close();
    process.exit(0);
  } catch (e) {
    console.error('');
    console.error('❌ 迁移失败:', e.message);
    await storage.close().catch(() => {});
    process.exit(1);
  }
})();
