// ==========================================
// 存储驱动 - SQLite 单文件（轻量部署）
// ==========================================
// 适用：小规模自建部署、单机服务，不需要另起数据库进程。
// 依赖（二选一，推荐前者）：
//   npm install better-sqlite3
//
// 连接串：DATABASE_URL=./data/app.db
// 表结构：同目录 schema.sql（SQLite 语法兼容，见下方 init 自动建表）
// ==========================================

const path = require('path');
const fs = require('fs');

// 注意层级：src/storage/drivers/ -> ../../.. 才是项目根（app/）
const config = require('../../../config');

let db = null;

// SQLite 版建表语句（Postgres 的 jsonb -> text，timestamptz -> text，bigserial -> integer）
// 与 schema.sql 保持字段一致，便于以后迁移
const SQLITE_SCHEMA = [
  `create table if not exists tasks (
    task_id text primary key,
    status text not null default 'pending',
    prompt text not null default '',
    optimized_prompt text,
    is_multi_prompt integer default 0,
    model text,
    theme text,
    total_clips integer default 0,
    clip_duration integer default 15,
    resolution text default '1080p',
    total_duration integer default 0,
    output_path text,
    s3_url text,
    runtime_config text default '{}',
    steps text default '{}',
    current_step text,
    current_step_key text,
    error text,
    final_qc text,
    estimated_total_time integer,
    created_at text,
    started_at text,
    completed_at text,
    updated_at text,
    deleted_at text
  )`,
  `create index if not exists idx_tasks_created on tasks (created_at desc)`,
  `create table if not exists clips (
    id integer primary key autoincrement,
    task_id text not null,
    clip_index integer not null,
    prompt text default '',
    theme text,
    theme_tag text,
    theme_matched integer default 1,
    status text default 'pending',
    attempts integer default 0,
    video_path text,
    track_id text,
    duration real default 0,
    qc_result text,
    error text,
    created_at text,
    updated_at text,
    unique (task_id, clip_index)
  )`,
  `create index if not exists idx_clips_task on clips (task_id)`,
  `create table if not exists prompts (
    id text primary key,
    task_id text,
    text text not null,
    optimized_text text,
    theme text,
    model text,
    tags text default '[]',
    use_count integer default 0,
    created_at text
  )`,
  `create index if not exists idx_prompts_created on prompts (created_at desc)`,
  `create table if not exists video_assets (
    id text primary key,
    task_id text,
    clip_index integer,
    kind text default 'clip',
    local_path text,
    remote_url text,
    storage_driver text default 'local',
    size_bytes integer default 0,
    duration real default 0,
    mime_type text default 'video/mp4',
    created_at text
  )`,
  `create table if not exists templates (
    id text primary key,
    name text not null,
    keywords text default '[]',
    style_enhancers text default '[]',
    negative text default '',
    updated_at text
  )`,
  `create table if not exists app_settings (
    key text primary key,
    value text,
    updated_at text
  )`
];

function nowIso() { return new Date().toISOString(); }
function genId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function j(v, fallback) { try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }

function rowToClip(r) {
  return {
    index: r.clip_index,
    prompt: r.prompt,
    theme: r.theme,
    themeTag: r.theme_tag,
    themeMatched: r.theme_matched !== 0,
    status: r.status,
    attempts: r.attempts,
    videoPath: r.video_path,
    trackId: r.track_id,
    duration: r.duration || 0,
    qcResult: j(r.qc_result, null),
    error: r.error
  };
}

function rowToTask(r, clips) {
  if (!r) return null;
  return {
    taskId: r.task_id,
    status: r.status,
    prompt: r.prompt,
    optimizedPrompt: r.optimized_prompt,
    isMultiPrompt: !!r.is_multi_prompt,
    model: r.model,
    theme: r.theme,
    totalClips: r.total_clips,
    clipDuration: r.clip_duration,
    resolution: r.resolution,
    totalDuration: r.total_duration,
    clips: clips || [],
    steps: j(r.steps, {}),
    currentStep: r.current_step,
    currentStepKey: r.current_step_key,
    outputPath: r.output_path,
    s3Url: r.s3_url,
    runtimeConfig: j(r.runtime_config, {}),
    error: r.error,
    finalQC: j(r.final_qc, null),
    estimatedTotalTime: r.estimated_total_time,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at || null
  };
}

module.exports = {
  name: 'sqlite',

  async init() {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch (e) {
      throw new Error('使用 SQLite 需要先安装依赖：npm install better-sqlite3');
    }
    const file = config.DATABASE_URL || path.join(__dirname, '..', '..', '..', 'data', 'app.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    for (const stmt of SQLITE_SCHEMA) db.exec(stmt);
  },

  async close() {
    if (db) { db.close(); db = null; }
  },

  // ===== 任务 =====
  async saveTask(task) {
    const tx = db.transaction(() => {
      db.prepare(`insert into tasks (
        task_id,status,prompt,optimized_prompt,is_multi_prompt,model,theme,
        total_clips,clip_duration,resolution,total_duration,output_path,s3_url,
        runtime_config,steps,current_step,current_step_key,error,final_qc,
        estimated_total_time,created_at,started_at,completed_at,updated_at,deleted_at
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(task_id) do update set
        status=excluded.status, prompt=excluded.prompt, optimized_prompt=excluded.optimized_prompt,
        is_multi_prompt=excluded.is_multi_prompt, model=excluded.model, theme=excluded.theme,
        total_clips=excluded.total_clips, clip_duration=excluded.clip_duration,
        resolution=excluded.resolution, total_duration=excluded.total_duration,
        output_path=excluded.output_path, s3_url=excluded.s3_url,
        runtime_config=excluded.runtime_config, steps=excluded.steps,
        current_step=excluded.current_step, current_step_key=excluded.current_step_key,
        error=excluded.error, final_qc=excluded.final_qc,
        estimated_total_time=excluded.estimated_total_time,
        started_at=excluded.started_at, completed_at=excluded.completed_at,
        updated_at=excluded.updated_at, deleted_at=excluded.deleted_at`).run(
        task.taskId, task.status || 'pending', task.prompt || '', task.optimizedPrompt || null,
        task.isMultiPrompt ? 1 : 0, task.model || null, task.theme || null,
        task.totalClips || 0, task.clipDuration || 15, task.resolution || '1080p',
        task.totalDuration || 0, task.outputPath || null, task.s3Url || null,
        JSON.stringify(task.runtimeConfig || {}), JSON.stringify(task.steps || {}),
        task.currentStep || null, task.currentStepKey || null, task.error || null,
        task.finalQC ? JSON.stringify(task.finalQC) : null,
        task.estimatedTotalTime || null, task.createdAt || nowIso(),
        task.startedAt || null, task.completedAt || null, nowIso(),
        task.deletedAt || null
      );
      db.prepare('delete from clips where task_id = ?').run(task.taskId);
      const ins = db.prepare(`insert into clips (
        task_id,clip_index,prompt,theme,theme_tag,theme_matched,status,attempts,
        video_path,track_id,duration,qc_result,error,created_at,updated_at
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const c of (task.clips || [])) {
        ins.run(task.taskId, c.index ?? 0, c.prompt || '', c.theme || null,
          c.themeTag || null, c.themeMatched !== false ? 1 : 0, c.status || 'pending',
          c.attempts || 0, c.videoPath || null, c.trackId || null, c.duration || 0,
          c.qcResult ? JSON.stringify(c.qcResult) : null, c.error || null, nowIso(), nowIso());
      }
    });
    tx();
    return task;
  },

  async getTask(taskId) {
    const r = db.prepare('select * from tasks where task_id = ?').get(taskId);
    if (!r) return null;
    const clips = db.prepare('select * from clips where task_id = ? order by clip_index').all(taskId);
    return rowToTask(r, clips.map(rowToClip));
  },

  async getAllTasks() {
    const rows = db.prepare('select * from tasks where deleted_at is null order by created_at desc').all();
    const allClips = db.prepare('select * from clips order by task_id, clip_index').all();
    const by = {};
    for (const c of allClips) (by[c.task_id] = by[c.task_id] || []).push(rowToClip(c));
    return rows.map(r => rowToTask(r, by[r.task_id] || []));
  },

  async deleteTask(taskId) {
    db.prepare('update tasks set deleted_at = ?, updated_at = ? where task_id = ?').run(nowIso(), nowIso(), taskId);
    return { success: true };
  },

  // ===== 提示词 =====
  async savePrompt(rec) {
    const id = rec.id || genId('p');
    db.prepare(`insert into prompts (id,task_id,text,optimized_text,theme,model,tags,use_count,created_at)
      values (?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set text=excluded.text, optimized_text=excluded.optimized_text,
        theme=excluded.theme, model=excluded.model`).run(
      id, rec.taskId || null, rec.text || '', rec.optimizedText || null,
      rec.theme || null, rec.model || null, JSON.stringify(rec.tags || []),
      rec.useCount || 0, rec.createdAt || nowIso());
    return db.prepare('select * from prompts where id = ?').get(id);
  },

  async listPrompts(opts = {}) {
    const w = [], p = [];
    if (opts.taskId) { w.push('task_id = ?'); p.push(opts.taskId); }
    if (opts.theme) { w.push('theme = ?'); p.push(opts.theme); }
    if (opts.q) { w.push('text like ?'); p.push('%' + opts.q + '%'); }
    const sql = 'select * from prompts ' + (w.length ? 'where ' + w.join(' and ') : '') +
      ' order by created_at desc limit ?';
    p.push(opts.limit || 100);
    return db.prepare(sql).all(...p);
  },

  // ===== 视频资产 =====
  async saveVideoAsset(a) {
    const id = a.id || genId('v');
    db.prepare(`insert into video_assets (id,task_id,clip_index,kind,local_path,remote_url,
      storage_driver,size_bytes,duration,mime_type,created_at) values (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, a.taskId || null, a.clipIndex ?? null, a.kind || 'clip', a.localPath || null,
      a.remoteUrl || null, a.storageDriver || 'local', a.sizeBytes || 0,
      a.duration || 0, a.mimeType || 'video/mp4', a.createdAt || nowIso());
    return db.prepare('select * from video_assets where id = ?').get(id);
  },

  async listVideoAssets(opts = {}) {
    const w = [], p = [];
    if (opts.taskId) { w.push('task_id = ?'); p.push(opts.taskId); }
    if (opts.kind) { w.push('kind = ?'); p.push(opts.kind); }
    const sql = 'select * from video_assets ' + (w.length ? 'where ' + w.join(' and ') : '') +
      ' order by created_at desc limit ?';
    p.push(opts.limit || 200);
    return db.prepare(sql).all(...p);
  },

  async updateVideoAsset(id, patch) {
    const map = { remoteUrl: 'remote_url', localPath: 'local_path', sizeBytes: 'size_bytes', storageDriver: 'storage_driver', duration: 'duration' };
    const sets = [], p = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(col + ' = ?'); p.push(patch[k]); }
    }
    if (!sets.length) return null;
    p.push(id);
    db.prepare('update video_assets set ' + sets.join(', ') + ' where id = ?').run(...p);
    return db.prepare('select * from video_assets where id = ?').get(id);
  },

  // ===== 模板 / 规则 =====
  async saveTemplate(id, data) {
    db.prepare(`insert into templates (id,name,keywords,style_enhancers,negative,updated_at)
      values (?,?,?,?,?,?)
      on conflict(id) do update set name=excluded.name, keywords=excluded.keywords,
        style_enhancers=excluded.style_enhancers, negative=excluded.negative, updated_at=excluded.updated_at`)
      .run(id, data.name || id, JSON.stringify(data.keywords || []),
        JSON.stringify(data.styleEnhancers || []), data.negative || '', nowIso());
    return data;
  },

  async getTemplates() {
    const rows = db.prepare('select * from templates').all();
    const out = {};
    for (const r of rows) {
      out[r.id] = { name: r.name, keywords: j(r.keywords, []), styleEnhancers: j(r.style_enhancers, []), negative: r.negative };
    }
    return out;
  },

  async deleteTemplate(id) {
    db.prepare('delete from templates where id = ?').run(id);
    return { success: true };
  },

  async saveRules(rules) {
    db.prepare(`insert into app_settings (key,value,updated_at) values ('optimization_rules',?,?)
      on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at`)
      .run(JSON.stringify({ rules: String(rules || '') }), nowIso());
    return { success: true };
  },

  async getRules() {
    const r = db.prepare("select value from app_settings where key='optimization_rules'").get();
    if (!r) return '';
    return j(r.value, {}).rules || '';
  }
};
