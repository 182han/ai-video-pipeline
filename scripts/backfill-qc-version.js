#!/usr/bin/env node
// ==========================================
// 质检结论版本回填脚本（qcVersion 迁移）
// ==========================================
// 背景：2026-10-18 之前 qualityChecker 有两处缺陷（skipped 当 passed / Math.random 假质检），
//       那之前落库的质检结论都是没真正执行过的「伪造 pass」。
//       用户决定不重跑历史任务，改用 qc_version 字段区分。
//
// 本脚本做的事：
//   把「有质检结论、但 qc_version 为空」的历史记录补成 **1**（历史未验证）。
//   ⚠️ 绝对不补 2 —— 补 2 等于把伪造结论洗成可信，这是本任务最大的失败模式。
//
// 覆盖范围：
//   1. 本地 data/tasks/*.json 与 data/trash/*.json（直接改文件，先自动备份）
//   2. 当前 DATABASE_TYPE 指向的数据库（postgres / sqlite）中的 tasks / clips 表
//   3. 数据库里的历史"孤儿"片段（任务已不存在、但片段行还在）同样补 1
//
// 用法：
//   node scripts/backfill-qc-version.js --dry-run     # 只报告，不改任何东西（建议先跑）
//   node scripts/backfill-qc-version.js               # 实际执行
//   node scripts/backfill-qc-version.js --json-only   # 只处理本地 JSON
//   node scripts/backfill-qc-version.js --db-only     # 只处理数据库
//
// 安全性：
//   - 幂等：已经是 1 或 >=2 的记录不会被改写
//   - 不删除任何数据，不改动 final_qc / qc_result 内容，只补一个版本号
//   - 改 JSON 前会先写到 data/backup-qcversion-<时间戳>/ 下
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const qcVersionUtil = require('../src/storage/qcVersion');

const LEGACY_VERSION = 1;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const JSON_ONLY = args.includes('--json-only');
const DB_ONLY = args.includes('--db-only');

const ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(ROOT, 'data', 'tasks');
const TRASH_DIR = path.join(ROOT, 'data', 'trash');
const BACKUP_DIR = path.join(ROOT, 'data', `backup-qcversion-${new Date().toISOString().replace(/[:.]/g, '-')}`);

const summary = {
  jsonTasks: 0,
  jsonClips: 0,
  jsonFiles: 0,
  dbTasks: 0,
  dbClips: 0,
  dbOrphanClips: 0,
  dbFinalQC: 0,
  errors: []
};

function log(...a) { console.log(...a); }

// ===== 1. 本地 JSON 文件 =====

// 一条质检结论是否已有合法版本号
function hasVersion(qc) {
  return qcVersionUtil.qcVersionOf(qc) !== null;
}

function backfillTaskJson(task) {
  let changed = false;
  let taskMarked = false;

  // 任务级：finalQC 存在但没有版本
  if (task.finalQC && typeof task.finalQC === 'object') {
    if (!hasVersion(task.finalQC)) {
      task.finalQC.qcVersion = LEGACY_VERSION;
      changed = true;
      taskMarked = true;
      summary.jsonTasks++;
    }
  }

  // 片段级：qcResult 存在但没有版本
  for (const c of (task.clips || [])) {
    if (c && c.qcResult && typeof c.qcResult === 'object' && !hasVersion(c.qcResult)) {
      c.qcResult.qcVersion = LEGACY_VERSION;
      changed = true;
      summary.jsonClips++;
    }
  }

  // 任务对象本身也带一个版本，便于 API 直接读
  if (!hasVersion(task)) {
    task.qcVersion = LEGACY_VERSION;
    changed = true;
    if (!taskMarked) taskMarked = true;
  }

  return { changed, taskMarked };
}

function processJsonDir(dir, label) {
  if (!fs.existsSync(dir)) {
    log(`  [${label}] 目录不存在，跳过: ${dir}`);
    return;
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  log(`  [${label}] 发现 ${files.length} 个任务文件`);

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const task = JSON.parse(raw);
      if (!task || typeof task !== 'object') continue;

      const { changed } = backfillTaskJson(task);
      if (!changed) continue;

      summary.jsonFiles++;
      if (DRY_RUN) continue;

      // 备份再写，避免写坏
      const backupPath = path.join(BACKUP_DIR, label, file);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, raw, 'utf8');
      fs.writeFileSync(full, JSON.stringify(task, null, 2), 'utf8');
    } catch (e) {
      summary.errors.push(`[${label}] ${file}: ${e.message}`);
    }
  }
}

// ===== 2. 数据库 =====

async function processDatabase() {
  const type = (config.DATABASE_TYPE || '').toLowerCase();
  if (!type || type === 'json') {
    log('  [db] 未配置数据库（DATABASE_TYPE 为空或 json），跳过数据库部分');
    return;
  }
  if (!config.DATABASE_URL) {
    log('  [db] 未配置 DATABASE_URL，跳过数据库部分');
    return;
  }

  log(`  [db] 驱动: ${type}`);
  const storage = require('../src/storage');
  await storage.init();

  try {
    if (type === 'postgres' || type === 'postgresql') {
      let pg;
      try { pg = require('pg'); } catch (e) {
        throw new Error('使用 PostgreSQL 需要先安装依赖：npm install pg');
      }
      const client = new pg.Client({
        connectionString: config.DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1|\bhost\.docker\.internal\b/.test(config.DATABASE_URL)
          ? false
          : { rejectUnauthorized: false }
      });
      await client.connect();
      try {
        await backfillPostgres(client);
      } finally {
        await client.end();
      }
      return;
    }

    if (type === 'sqlite') {
      let Database;
      try { Database = require('better-sqlite3'); } catch (e) {
        throw new Error('使用 SQLite 需要先安装依赖：npm install better-sqlite3');
      }
      const file = config.DATABASE_URL;
      const db = new Database(file);
      try {
        await backfillSqlite(db);
      } finally {
        db.close();
      }
      return;
    }

    log(`  [db] 未知的 DATABASE_TYPE: ${type}，跳过`);
  } finally {
    await storage.close().catch(() => {});
  }
}

async function backfillPostgres(client) {
  // 1) 确认列存在（老库可能还没跑 schema.sql 的增量段）
  const cols = await client.query(`
    select table_name, column_name from information_schema.columns
    where table_name in ('tasks','clips') and column_name = 'qc_version'
  `);
  const have = new Set(cols.rows.map(r => r.table_name));
  for (const t of ['tasks', 'clips']) {
    if (!have.has(t)) {
      if (DRY_RUN) {
        log(`  [db] tasks.${t}.qc_version 列缺失（试运行不改结构；正式执行会补列）`);
        await client.query(`alter table ${t} add column if not exists qc_version integer`).catch(() => {});
      } else {
        await client.query(`alter table ${t} add column if not exists qc_version integer`);
        log(`  [db] 已补列: ${t}.qc_version`);
      }
    }
  }

  // 2) 统计待处理行
  const tStat = await client.query(
    'select count(*)::int as n from tasks where qc_version is null and final_qc is not null'
  );
  const cStat = await client.query(
    'select count(*)::int as n from clips where qc_version is null and qc_result is not null'
  );
  log(`  [db] 待标记任务: ${tStat.rows[0].n} 行 | 待标记片段: ${cStat.rows[0].n} 行`);

  if (DRY_RUN) {
    summary.dbTasks = tStat.rows[0].n;
    summary.dbClips = cStat.rows[0].n;
    return;
  }

  // 3) 回填（只补 null，绝不动已有版本）
  const tRes = await client.query(
    'update tasks set qc_version = $1 where qc_version is null and final_qc is not null',
    [LEGACY_VERSION]
  );
  const cRes = await client.query(
    'update clips set qc_version = $1 where qc_version is null and qc_result is not null',
    [LEGACY_VERSION]
  );
  summary.dbTasks = tRes.rowCount;
  summary.dbClips = cRes.rowCount;
  log(`  [db] 已标记任务 ${tRes.rowCount} 行、片段 ${cRes.rowCount} 行为历史未验证(1)`);

  // 4) 孤儿片段：片段行还在、任务行已不在 —— 同样要标，否则读不到也算"干净"
  const orphan = await client.query(`
    update clips set qc_version = $1
    where qc_version is null and qc_result is not null
      and task_id not in (select task_id from tasks)
  `, [LEGACY_VERSION]);
  summary.dbOrphanClips = orphan.rowCount;
  if (orphan.rowCount) log(`  [db] 其中孤儿片段 ${orphan.rowCount} 行`);
}

async function backfillSqlite(db) {
  // 1) 确认列存在
  for (const t of ['tasks', 'clips']) {
    const cols = db.prepare(`pragma table_info(${t})`).all();
    if (!cols.some(c => c.name === 'qc_version')) {
      if (DRY_RUN) {
        log(`  [db] ${t}.qc_version 列缺失（试运行不改结构；正式执行会补列）`);
        continue;
      }
      db.exec(`alter table ${t} add column qc_version integer`);
      log(`  [db] 已补列: ${t}.qc_version`);
    }
  }

  const cols = (t) => db.prepare(`pragma table_info(${t})`).all().some(c => c.name === 'qc_version');
  if (!cols('tasks') || !cols('clips')) {
    log('  [db] 试运行：列尚未建立，统计跳过');
    return;
  }

  const tN = db.prepare('select count(*) as n from tasks where qc_version is null and final_qc is not null').get().n;
  const cN = db.prepare('select count(*) as n from clips where qc_version is null and qc_result is not null').get().n;
  log(`  [db] 待标记任务: ${tN} 行 | 待标记片段: ${cN} 行`);

  if (DRY_RUN) {
    summary.dbTasks = tN;
    summary.dbClips = cN;
    return;
  }

  const t = db.prepare('update tasks set qc_version = ? where qc_version is null and final_qc is not null').run(LEGACY_VERSION);
  const c = db.prepare('update clips set qc_version = ? where qc_version is null and qc_result is not null').run(LEGACY_VERSION);
  summary.dbTasks = t.changes;
  summary.dbClips = c.changes;
  log(`  [db] 已标记任务 ${t.changes} 行、片段 ${c.changes} 行为历史未验证(1)`);

  const orphan = db.prepare(`update clips set qc_version = ?
    where qc_version is null and qc_result is not null
      and task_id not in (select task_id from tasks)`).run(LEGACY_VERSION);
  summary.dbOrphanClips = orphan.changes;
  if (orphan.changes) log(`  [db] 其中孤儿片段 ${orphan.changes} 行`);
}

// ===== 主流程 =====

(async () => {
  log('========================================');
  log(`  质检结论版本回填 ${DRY_RUN ? '（试运行，不写入）' : '（正式执行）'}`);
  log('========================================');
  log(`目标版本: qc_version = ${LEGACY_VERSION}（历史未验证），绝不会写 2`);
  log('');

  if (!DB_ONLY) {
    log('[1] 本地 JSON 文件');
    processJsonDir(TASKS_DIR, 'tasks');
    processJsonDir(TRASH_DIR, 'trash');
  }

  if (!JSON_ONLY) {
    log('');
    log('[2] 数据库');
    try {
      await processDatabase();
    } catch (e) {
      summary.errors.push(`[db] ${e.message}`);
      log(`  [db] 出错: ${e.message}`);
    }
  }

  log('');
  log('========================================');
  log('  结果汇总');
  log('========================================');
  log(`  JSON 任务级标记: ${summary.jsonTasks}`);
  log(`  JSON 片段级标记: ${summary.jsonClips}`);
  log(`  JSON 被改写文件: ${summary.jsonFiles}${DRY_RUN ? '（试运行，实际未写）' : ''}`);
  log(`  数据库任务标记: ${summary.dbTasks}`);
  log(`  数据库片段标记: ${summary.dbClips}`);
  if (!DRY_RUN && summary.jsonFiles > 0) {
    log(`  备份目录: ${path.relative(ROOT, BACKUP_DIR)}`);
  }
  if (summary.errors.length) {
    log('');
    log(`  ⚠️  错误 ${summary.errors.length} 条:`);
    summary.errors.slice(0, 20).forEach(e => log('    - ' + e));
  }
  log('========================================');

  process.exit(summary.errors.length ? 1 : 0);
})();
