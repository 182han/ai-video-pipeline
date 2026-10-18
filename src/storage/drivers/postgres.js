// ==========================================
// 存储驱动 - PostgreSQL (Supabase / Neon / 自建)
// ==========================================
// 通过 config.DATABASE_URL 连接。依赖 'pg' 包：
//   npm install pg
// 表结构见同目录 schema.sql，需先在数据库里执行一次。
// ==========================================

// 注意层级：src/storage/drivers/ -> ../../.. 才是项目根（app/）
const config = require('../../../config');

let pool = null;

function getPool() {
  if (pool) return pool;
  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    // 区分"依赖没装"和"其他加载错误"，否则会把真实原因掩盖成误导性的提示
    if (e && (e.code === 'MODULE_NOT_FOUND' || /Cannot find module 'pg'/.test(e.message))) {
      throw new Error('使用 PostgreSQL 需要先安装依赖：npm install pg');
    }
    throw e;
  }
  pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    // Supabase / Neon 免费实例必须走 TLS；本地连接关闭 TLS
    ssl: /localhost|127\.0\.0\.0|\bhost\.docker\.internal\b/.test(config.DATABASE_URL)
      ? false
      : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    // 连不上时快速失败，避免服务启动卡住
    connectionTimeoutMillis: 10000
  });
  pool.on('error', (err) => console.error('[storage:pg] 连接池错误:', err.message));
  return pool;
}

async function q(text, params) {
  const res = await getPool().query(text, params);
  return res;
}

// 任务行 → 业务对象（snake_case 转 camelCase）
function rowToTask(row, clips) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    status: row.status,
    prompt: row.prompt,
    optimizedPrompt: row.optimized_prompt,
    isMultiPrompt: row.is_multi_prompt,
    model: row.model,
    theme: row.theme,
    totalClips: row.total_clips,
    clipDuration: row.clip_duration,
    resolution: row.resolution,
    totalDuration: row.total_duration,
    clips: clips || [],
    steps: row.steps || {},
    currentStep: row.current_step,
    currentStepKey: row.current_step_key,
    outputPath: row.output_path,
    s3Url: row.s3_url,
    runtimeConfig: row.runtime_config || {},
    error: row.error,
    finalQC: row.final_qc,
    estimatedTotalTime: row.estimated_total_time,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null
  };
}

function rowToClip(row) {
  return {
    index: row.clip_index,
    prompt: row.prompt,
    theme: row.theme,
    themeTag: row.theme_tag,
    themeMatched: row.theme_matched,
    status: row.status,
    attempts: row.attempts,
    videoPath: row.video_path,
    trackId: row.track_id,
    duration: Number(row.duration) || 0,
    qcResult: row.qc_result,
    error: row.error
  };
}

module.exports = {
  name: 'postgres',

  async init() {
    // 探活，顺便验证 schema 是否已执行
    try {
      await q('select 1 from tasks limit 1');
    } catch (e) {
      if (/relation .* does not exist/i.test(e.message)) {
        throw new Error('数据库表不存在，请先在 SQL Editor 里执行 src/storage/schema.sql');
      }
      throw e;
    }
  },

  async close() {
    if (pool) await pool.end();
    pool = null;
  },

  // ===== 任务 =====
  async saveTask(task) {
    const client = await getPool().connect();
    try {
      await client.query('begin');
      await client.query(`
        insert into tasks (
          task_id, status, prompt, optimized_prompt, is_multi_prompt,
          model, theme, total_clips, clip_duration, resolution, total_duration,
          output_path, s3_url, runtime_config, steps, current_step, current_step_key,
          error, final_qc, estimated_total_time,
          created_at, started_at, completed_at, updated_at, deleted_at
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          coalesce($21, now()),$22,$23, now(),$24
        )
        on conflict (task_id) do update set
          status = excluded.status,
          prompt = excluded.prompt,
          optimized_prompt = excluded.optimized_prompt,
          is_multi_prompt = excluded.is_multi_prompt,
          model = excluded.model,
          theme = excluded.theme,
          total_clips = excluded.total_clips,
          clip_duration = excluded.clip_duration,
          resolution = excluded.resolution,
          total_duration = excluded.total_duration,
          output_path = excluded.output_path,
          s3_url = excluded.s3_url,
          runtime_config = excluded.runtime_config,
          steps = excluded.steps,
          current_step = excluded.current_step,
          current_step_key = excluded.current_step_key,
          error = excluded.error,
          final_qc = excluded.final_qc,
          estimated_total_time = excluded.estimated_total_time,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          deleted_at = excluded.deleted_at,
          updated_at = now()
      `, [
        task.taskId, task.status || 'pending', task.prompt || '', task.optimizedPrompt || null,
        !!task.isMultiPrompt, task.model || null, task.theme || null,
        task.totalClips || 0, task.clipDuration || 15, task.resolution || '1080p',
        task.totalDuration || 0, task.outputPath || null, task.s3Url || null,
        JSON.stringify(task.runtimeConfig || {}), JSON.stringify(task.steps || {}),
        task.currentStep || null, task.currentStepKey || null, task.error || null,
        task.finalQC ? JSON.stringify(task.finalQC) : null,
        task.estimatedTotalTime || null, task.createdAt || null,
        task.startedAt || null, task.completedAt || null,
        task.deletedAt || null
      ]);

      // 片段：先清后插，保证与内存态一致
      await client.query('delete from clips where task_id = $1', [task.taskId]);
      const clips = task.clips || [];
      for (const c of clips) {
        await client.query(`
          insert into clips (
            task_id, clip_index, prompt, theme, theme_tag, theme_matched,
            status, attempts, video_path, track_id, duration, qc_result, error
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
          task.taskId, c.index ?? 0, c.prompt || '', c.theme || null,
          c.themeTag || null, c.themeMatched !== false, c.status || 'pending',
          c.attempts || 0, c.videoPath || null, c.trackId || null,
          c.duration || 0, c.qcResult ? JSON.stringify(c.qcResult) : null,
          c.error || null
        ]);
      }

      await client.query('commit');
      return task;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  },

  async getTask(taskId) {
    const res = await q('select * from tasks where task_id = $1', [taskId]);
    if (res.rows.length === 0) return null;
    const clipRes = await q('select * from clips where task_id = $1 order by clip_index', [taskId]);
    return rowToTask(res.rows[0], clipRes.rows.map(rowToClip));
  },

  async getAllTasks() {
    const res = await q('select * from tasks where deleted_at is null order by created_at desc');
    const clipRes = await q('select * from clips order by task_id, clip_index');
    const byTask = {};
    for (const row of clipRes.rows) {
      (byTask[row.task_id] = byTask[row.task_id] || []).push(rowToClip(row));
    }
    return res.rows.map(r => rowToTask(r, byTask[r.task_id] || []));
  },

  async deleteTask(taskId) {
    await q('update tasks set deleted_at = now() where task_id = $1', [taskId]);
    return { success: true };
  },

  // ===== 提示词 =====
  async savePrompt(record) {
    const res = await q(`
      insert into prompts (task_id, text, optimized_text, theme, model)
      values ($1,$2,$3,$4,$5) returning *
    `, [record.taskId || null, record.text || '', record.optimizedText || null,
        record.theme || null, record.model || null]);
    return res.rows[0];
  },

  async listPrompts(options = {}) {
    const where = [];
    const params = [];
    if (options.taskId) { params.push(options.taskId); where.push(`task_id = $${params.length}`); }
    if (options.theme)  { params.push(options.theme);  where.push(`theme = $${params.length}`); }
    if (options.q)      { params.push(`%${options.q}%`); where.push(`text ilike $${params.length}`); }
    params.push(options.limit || 100);
    const sql = `select * from prompts ${where.length ? 'where ' + where.join(' and ') : ''}
                 order by created_at desc limit $${params.length}`;
    const res = await q(sql, params);
    return res.rows;
  },

  // ===== 视频资产 =====
  async saveVideoAsset(asset) {
    const res = await q(`
      insert into video_assets (
        task_id, clip_index, kind, local_path, remote_url,
        storage_driver, size_bytes, duration, mime_type
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *
    `, [asset.taskId || null, asset.clipIndex ?? null, asset.kind || 'clip',
        asset.localPath || null, asset.remoteUrl || null, asset.storageDriver || 'local',
        asset.sizeBytes || 0, asset.duration || 0, asset.mimeType || 'video/mp4']);
    return res.rows[0];
  },

  async listVideoAssets(options = {}) {
    const where = [];
    const params = [];
    if (options.taskId) { params.push(options.taskId); where.push(`task_id = $${params.length}`); }
    if (options.kind)   { params.push(options.kind);   where.push(`kind = $${params.length}`); }
    params.push(options.limit || 200);
    const sql = `select * from video_assets ${where.length ? 'where ' + where.join(' and ') : ''}
                 order by created_at desc limit $${params.length}`;
    const res = await q(sql, params);
    return res.rows;
  },

  async updateVideoAsset(id, patch) {
    const fields = [];
    const params = [];
    const map = { remoteUrl: 'remote_url', localPath: 'local_path', sizeBytes: 'size_bytes', storageDriver: 'storage_driver', duration: 'duration' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { params.push(patch[k]); fields.push(`${col} = $${params.length}`); }
    }
    if (fields.length === 0) return null;
    params.push(id);
    const res = await q(`update video_assets set ${fields.join(', ')} where id = $${params.length} returning *`, params);
    return res.rows[0] || null;
  },

  // ===== 模板 / 规则 =====
  async saveTemplate(id, data) {
    await q(`
      insert into templates (id, name, keywords, style_enhancers, negative, updated_at)
      values ($1,$2,$3,$4,$5, now())
      on conflict (id) do update set
        name = excluded.name, keywords = excluded.keywords,
        style_enhancers = excluded.style_enhancers,
        negative = excluded.negative, updated_at = now()
    `, [id, data.name || id, JSON.stringify(data.keywords || []),
        JSON.stringify(data.styleEnhancers || []), data.negative || '']);
    return data;
  },

  async getTemplates() {
    const res = await q('select * from templates');
    const out = {};
    for (const r of res.rows) {
      out[r.id] = { name: r.name, keywords: r.keywords, styleEnhancers: r.style_enhancers, negative: r.negative };
    }
    return out;
  },

  async deleteTemplate(id) {
    await q('delete from templates where id = $1', [id]);
    return { success: true };
  },

  async saveRules(rules) {
    await q(`
      insert into app_settings (key, value, updated_at) values ('optimization_rules', $1, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `, [JSON.stringify({ rules: String(rules || '') })]);
    return { success: true };
  },

  async getRules() {
    const res = await q("select value from app_settings where key = 'optimization_rules'");
    if (res.rows.length === 0) return '';
    return (res.rows[0].value && res.rows[0].value.rules) || '';
  }
};
