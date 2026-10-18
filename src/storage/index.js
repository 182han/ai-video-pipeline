// ==========================================
// 存储层 - 统一数据访问入口
// ==========================================
// 通过 config.DATABASE_TYPE 自动选择驱动：
//   '' 或 'json'  → 本地 JSON 文件（零依赖，默认，向后兼容）
//   'postgres'    → PostgreSQL（Supabase / Neon / 自建）
//   'sqlite'      → SQLite 单文件（轻量部署）
//
// 业务代码只 require 这一个文件，不关心底层用的是哪种库。
// ==========================================

const config = require('../../config');

let driver = null;

function getDriver() {
  if (driver) return driver;

  const type = (config.DATABASE_TYPE || '').toLowerCase();

  if (type === 'postgres' || type === 'postgresql') {
    driver = require('./drivers/postgres');
  } else if (type === 'sqlite') {
    driver = require('./drivers/sqlite');
  } else {
    driver = require('./drivers/jsonfile');
  }

  return driver;
}

// ===== 生命周期 =====

/** 初始化连接（服务启动时调用一次） */
async function init() {
  const d = getDriver();
  await d.init();
  console.log(`[storage] 驱动: ${d.name}`);
  return d.name;
}

/** 关闭连接（进程退出时调用） */
async function close() {
  if (driver && typeof driver.close === 'function') {
    await driver.close();
  }
}

// ===== 任务 CRUD =====

/** 保存任务（整条 upsert） */
async function saveTask(task) {
  return getDriver().saveTask(task);
}

/** 读取单个任务 */
async function getTask(taskId) {
  return getDriver().getTask(taskId);
}

/** 读取全部任务 */
async function getAllTasks() {
  return getDriver().getAllTasks();
}

/** 删除任务 */
async function deleteTask(taskId) {
  return getDriver().deleteTask(taskId);
}

// ===== 提示词 =====

/** 保存一条提示词记录（用于提示词库/复用/统计） */
async function savePrompt(record) {
  return getDriver().savePrompt(record);
}

/** 查询提示词历史 */
async function listPrompts(options = {}) {
  return getDriver().listPrompts(options);
}

// ===== 视频资产 =====

/** 登记一个生成的视频文件 */
async function saveVideoAsset(asset) {
  return getDriver().saveVideoAsset(asset);
}

/** 查询视频资产 */
async function listVideoAssets(options = {}) {
  return getDriver().listVideoAssets(options);
}

/** 更新视频资产（例如上传对象存储后回写 URL） */
async function updateVideoAsset(id, patch) {
  return getDriver().updateVideoAsset(id, patch);
}

// ===== 模板 / 规则 =====

async function saveTemplate(id, data) {
  return getDriver().saveTemplate(id, data);
}
async function getTemplates() {
  return getDriver().getTemplates();
}
async function deleteTemplate(id) {
  return getDriver().deleteTemplate(id);
}
async function saveRules(rules) {
  return getDriver().saveRules(rules);
}
async function getRules() {
  return getDriver().getRules();
}

// ===== 迁移 =====

/**
 * 把本地 data/tasks/*.json 里的历史任务灌进数据库。
 * 幂等：已存在的 taskId 会被覆盖，不会重复插入。
 * @returns {Promise<{migrated:number, failed:number}>}
 */
async function migrateFromJsonFiles(dataDir) {
  const fs = require('fs');
  const path = require('path');
  const result = { migrated: 0, failed: 0 };

  const dirs = [
    dataDir || path.join(__dirname, '..', '..', 'data', 'tasks'),
    path.join(__dirname, '..', '..', 'data', 'trash')
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!task || !task.taskId) continue;
        await saveTask(task);
        result.migrated++;
      } catch (e) {
        console.error(`[storage] 迁移失败 ${file}: ${e.message}`);
        result.failed++;
      }
    }
  }

  return result;
}

module.exports = {
  init,
  close,
  get name() { return getDriver().name; },
  saveTask,
  getTask,
  getAllTasks,
  deleteTask,
  savePrompt,
  listPrompts,
  saveVideoAsset,
  listVideoAssets,
  updateVideoAsset,
  saveTemplate,
  getTemplates,
  deleteTemplate,
  saveRules,
  getRules,
  migrateFromJsonFiles
};
