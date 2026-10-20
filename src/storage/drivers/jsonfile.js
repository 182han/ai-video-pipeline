// ==========================================
// 存储驱动 - 本地 JSON 文件（默认，零依赖）
// ==========================================
// 与改造前的行为完全一致：任务存在 data/tasks/<taskId>.json
// 新增了提示词库、视频资产、模板、规则四张"逻辑表"，同样落成 JSON 文件。
// ==========================================

const fs = require('fs');
const path = require('path');

// 固定以项目根目录为基准（app/），不依赖进程的当前工作目录，
// 否则从不同目录启动服务会在不同位置生成 data/ 目录。
const ROOT = path.join(__dirname, '..', '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const ASSETS_FILE = path.join(DATA_DIR, 'video-assets.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const RULES_FILE = path.join(DATA_DIR, 'optimization_rules.txt');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[storage:json] 读取失败 ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ===== 账号相关的小工具 =====

/** 生成账号 id（与随机数无关的用途，AGENTS.md §4.2 允许） */
function newUserId() {
  return 'usr_' + Date.now().toString(36) + '_' + require('crypto').randomBytes(4).toString('hex');
}

/** 对外暴露的用户对象：绝不包含 passwordHash */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
    lastLoginAt: u.lastLoginAt || null
  };
}

module.exports = {
  name: 'jsonfile',

  async init() {
    ensureDir(TASKS_DIR);
  },

  async close() {},

  // ===== 任务 =====
  async saveTask(task) {
    ensureDir(TASKS_DIR);
    writeJson(path.join(TASKS_DIR, `${task.taskId}.json`), task);
    return task;
  },

  async getTask(taskId) {
    const file = path.join(TASKS_DIR, `${taskId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return null;
    }
  },

  async getAllTasks() {
    ensureDir(TASKS_DIR);
    const tasks = [];
    for (const file of fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        tasks.push(JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8')));
      } catch (e) { /* 跳过损坏文件 */ }
    }
    return tasks;
  },

  async deleteTask(taskId) {
    const file = path.join(TASKS_DIR, `${taskId}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { success: true };
  },

  // ===== 提示词 =====
  async savePrompt(record) {
    const all = readJson(PROMPTS_FILE, []);
    const entry = {
      id: record.id || `p_${Date.now().toString(36)}`,
      taskId: record.taskId || null,
      text: record.text || '',
      optimizedText: record.optimizedText || '',
      theme: record.theme || null,
      model: record.model || null,
      createdAt: record.createdAt || new Date().toISOString()
    };
    const idx = all.findIndex(p => p.id === entry.id);
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    if (all.length > 5000) all.splice(0, all.length - 5000);
    writeJson(PROMPTS_FILE, all);
    return entry;
  },

  async listPrompts(options = {}) {
    let all = readJson(PROMPTS_FILE, []);
    if (options.taskId) all = all.filter(p => p.taskId === options.taskId);
    if (options.theme) all = all.filter(p => p.theme === options.theme);
    if (options.q) {
      const q = String(options.q).toLowerCase();
      all = all.filter(p => (p.text || '').toLowerCase().includes(q));
    }
    all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return all.slice(0, options.limit || 100);
  },

  // ===== 视频资产 =====
  async saveVideoAsset(asset) {
    const all = readJson(ASSETS_FILE, []);
    const entry = {
      id: asset.id || `v_${Date.now().toString(36)}`,
      taskId: asset.taskId || null,
      clipIndex: asset.clipIndex ?? null,
      kind: asset.kind || 'clip',
      localPath: asset.localPath || '',
      remoteUrl: asset.remoteUrl || '',
      storageDriver: asset.storageDriver || 'local',
      sizeBytes: asset.sizeBytes || 0,
      duration: asset.duration || 0,
      mimeType: asset.mimeType || 'video/mp4',
      createdAt: asset.createdAt || new Date().toISOString()
    };
    const idx = all.findIndex(a => a.id === entry.id);
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    writeJson(ASSETS_FILE, all);
    return entry;
  },

  async listVideoAssets(options = {}) {
    let all = readJson(ASSETS_FILE, []);
    if (options.taskId) all = all.filter(a => a.taskId === options.taskId);
    if (options.kind) all = all.filter(a => a.kind === options.kind);
    all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return all.slice(0, options.limit || 200);
  },

  async updateVideoAsset(id, patch) {
    const all = readJson(ASSETS_FILE, []);
    const idx = all.findIndex(a => a.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], ...patch };
    writeJson(ASSETS_FILE, all);
    return all[idx];
  },

  // ===== 模板 / 规则 =====
  async saveTemplate(id, data) {
    const all = readJson(TEMPLATES_FILE, {});
    all[id] = data;
    writeJson(TEMPLATES_FILE, all);
    return data;
  },
  async getTemplates() {
    return readJson(TEMPLATES_FILE, {});
  },
  async deleteTemplate(id) {
    const all = readJson(TEMPLATES_FILE, {});
    delete all[id];
    writeJson(TEMPLATES_FILE, all);
    return { success: true };
  },
  async saveRules(rules) {
    ensureDir(DATA_DIR);
    fs.writeFileSync(RULES_FILE, String(rules || ''), 'utf8');
    return { success: true };
  },
  async getRules() {
    if (!fs.existsSync(RULES_FILE)) return '';
    return fs.readFileSync(RULES_FILE, 'utf8');
  },

  // ===== 账号（登录墙）=====
  // 密码哈希只在 getUserByUsername 里返回（登录校验需要），
  // 其余接口一律经过 publicUser() 过滤，绝不把 passwordHash 发给前端。
  async listUsers() {
    const all = readJson(USERS_FILE, []);
    return all.map(publicUser).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },

  async countUsers() {
    return readJson(USERS_FILE, []).length;
  },

  async getUserByUsername(username) {
    const name = String(username || '').trim();
    if (!name) return null;
    const all = readJson(USERS_FILE, []);
    return all.find(u => u.username === name) || null;
  },

  async getUser(id) {
    const all = readJson(USERS_FILE, []);
    const u = all.find(x => x.id === id);
    return u ? publicUser(u) : null;
  },

  async createUser({ username, passwordHash }) {
    const all = readJson(USERS_FILE, []);
    const name = String(username || '').trim();
    if (!name) throw new Error('账号不能为空');
    if (all.some(u => u.username === name)) throw new Error('账号已存在');
    const now = new Date().toISOString();
    const user = { id: newUserId(), username: name, passwordHash: String(passwordHash), createdAt: now, updatedAt: now, lastLoginAt: null };
    all.push(user);
    writeJson(USERS_FILE, all);
    return publicUser(user);
  },

  async deleteUser(id) {
    const all = readJson(USERS_FILE, []);
    const next = all.filter(u => u.id !== id);
    if (next.length === all.length) return { success: false, error: '账号不存在' };
    writeJson(USERS_FILE, next);
    return { success: true };
  },

  async updateUserPassword(id, passwordHash) {
    const all = readJson(USERS_FILE, []);
    const u = all.find(x => x.id === id);
    if (!u) return null;
    u.passwordHash = String(passwordHash);
    u.updatedAt = new Date().toISOString();
    writeJson(USERS_FILE, all);
    return publicUser(u);
  },

  async touchUserLogin(id) {
    const all = readJson(USERS_FILE, []);
    const u = all.find(x => x.id === id);
    if (!u) return null;
    u.lastLoginAt = new Date().toISOString();
    writeJson(USERS_FILE, all);
    return publicUser(u);
  }
};
