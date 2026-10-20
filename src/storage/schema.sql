-- ==========================================
-- AI 长视频流水线 - 数据库结构（PostgreSQL / Supabase）
-- ==========================================
-- 使用方法：
--   Supabase：打开 SQL Editor，整段粘贴执行
--   自建 PG ：psql "$DATABASE_URL" -f schema.sql
-- 幂等：可以重复执行，不会报错也不会丢数据
-- ==========================================

-- ===== 扩展（可选）=====
-- 只在拿不到 gen_random_uuid() 时才需要 pgcrypto。
-- Supabase / Neon / PG13+ 内置了 gen_random_uuid()，不需要扩展；
-- 部分受限环境（无超级用户权限）装不了扩展，所以这里吞掉错误，不阻断建表。
do $$
begin
  create extension if not exists "pgcrypto";
exception when others then
  raise notice 'pgcrypto 不可用，使用内置 gen_random_uuid()';
end $$;

-- ==========================================
-- 1. 任务表：一次完整的视频生成作业
-- ==========================================
create table if not exists tasks (
  task_id           text primary key,
  status            text not null default 'pending',
  -- 提示词
  prompt            text not null default '',
  optimized_prompt  text,
  is_multi_prompt   boolean default false,
  -- 生成参数
  model             text,
  theme             text,
  total_clips       integer default 0,
  clip_duration     numeric default 15,
  resolution        text default '1080p',
  total_duration    numeric default 0,
  -- 产物
  output_path       text,
  s3_url            text,
  -- 运行时配置（注意：API Key 不应长期落库，见 README 说明）
  runtime_config    jsonb default '{}'::jsonb,
  -- 流程控制
  steps             jsonb default '{}'::jsonb,
  current_step      text,
  current_step_key  text,
  error             text,
  final_qc          jsonb,
  -- 质检结论版本：>=2 才可信；null/1 = 修复前产生，属「历史未验证」
  -- 详见 src/storage/qcVersion.js 与 docs/spec/changelog.md
  qc_version        integer,
  estimated_total_time integer,
  -- 时间戳
  created_at        timestamptz default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  updated_at        timestamptz default now(),
  deleted_at        timestamptz
);

create index if not exists idx_tasks_status      on tasks (status);
create index if not exists idx_tasks_created_at  on tasks (created_at desc);
create index if not exists idx_tasks_deleted_at  on tasks (deleted_at) where deleted_at is not null;

-- ==========================================
-- 2. 片段表：任务下的每一段视频
-- ==========================================
create table if not exists clips (
  id            bigserial primary key,
  task_id       text not null references tasks(task_id) on delete cascade,
  clip_index    integer not null,
  prompt        text default '',
  theme         text,
  theme_tag     text,
  theme_matched boolean default true,
  status        text default 'pending',
  attempts      integer default 0,
  video_path    text,
  track_id      text,
  duration      numeric default 0,
  qc_result     jsonb,
  -- 片段质检结论版本：>=2 才可信；null/1 = 历史未验证
  qc_version    integer,
  error         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (task_id, clip_index)
);

create index if not exists idx_clips_task    on clips (task_id);
create index if not exists idx_clips_status  on clips (status);

-- ==========================================
-- 2.5 增量补列（已有库升级用，幂等）
-- ==========================================
-- create table if not exists 对「表已存在」是静默跳过的，
-- 所以给老库补新列必须单独写 ALTER，否则 upgraded 的库会缺列、写入直接报错。
alter table tasks add column if not exists qc_version integer;
alter table clips add column if not exists qc_version integer;

create index if not exists idx_tasks_qc_version on tasks (qc_version);
create index if not exists idx_clips_qc_version on clips (qc_version);

-- 历史记录明确标记为「未验证」（版本 1），不要标 2！
-- 这一步只影响 qc_version 为 null 的行；已经打过标的行不会被改写。
-- 注意：本语句只做标记，不改动 final_qc / qc_result 的内容。
update tasks set qc_version = 1 where qc_version is null and final_qc is not null;
update clips set qc_version = 1 where qc_version is null and qc_result is not null;

-- ==========================================
-- 2.6 配乐改造：任务级配乐计划（整片多轨时间轴）
-- ==========================================
-- 背景：配乐从「逐片段混音」改为「整片多轨时间轴」，编辑结果以 plan 形式存任务级。
-- bgm_plan 结构见 src/processors/bgmPlan.js 顶部注释；bgm_result 记录最近一次混音结果。
-- 单独 ALTER 补列，保证已升级的库也能拿到这两列（幂等）。
alter table tasks add column if not exists bgm_plan   jsonb;
alter table tasks add column if not exists bgm_result jsonb;

-- ==========================================
-- 3. 提示词库：沉淀可复用的提示词
-- ==========================================
create table if not exists prompts (
  id             text primary key default gen_random_uuid()::text,
  task_id        text references tasks(task_id) on delete set null,
  text           text not null,
  optimized_text text,
  theme          text,
  model          text,
  tags           text[] default '{}',
  use_count      integer default 0,
  created_at     timestamptz default now()
);

create index if not exists idx_prompts_theme      on prompts (theme);
create index if not exists idx_prompts_task       on prompts (task_id);
create index if not exists idx_prompts_created    on prompts (created_at desc);

-- 提示词模糊搜索（可选）：需要 pg_trgm 扩展。
-- Supabase 默认已启用该扩展，若报错就执行 create extension pg_trgm; 再重跑本段。
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    create index if not exists idx_prompts_text_trgm on prompts using gin (text gin_trgm_ops);
  end if;
end $$;

-- ==========================================
-- 4. 视频资产表：文件本体在对象存储，这里只存元数据
-- ==========================================
create table if not exists video_assets (
  id             text primary key default gen_random_uuid()::text,
  task_id        text references tasks(task_id) on delete cascade,
  clip_index     integer,
  kind           text default 'clip',        -- clip | final | loop | bgm
  local_path     text,
  remote_url     text,
  storage_driver text default 'local',       -- local | supabase | s3 | r2
  size_bytes     bigint default 0,
  duration       numeric default 0,
  mime_type      text default 'video/mp4',
  created_at     timestamptz default now()
);

create index if not exists idx_assets_task  on video_assets (task_id);
create index if not exists idx_assets_kind  on video_assets (kind);

-- ==========================================
-- 5. 主题模板库
-- ==========================================
create table if not exists templates (
  id              text primary key,
  name            text not null,
  keywords        jsonb default '[]'::jsonb,
  style_enhancers jsonb default '[]'::jsonb,
  negative        text default '',
  updated_at      timestamptz default now()
);

-- ==========================================
-- 6. 全局键值配置（优化规则、系统设置等）
-- ==========================================
create table if not exists app_settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

-- ==========================================
-- 6.5 登录墙账号
-- ==========================================
-- 密码只存 scrypt 哈希（scrypt$1$<salt>$<hash>，见 src/auth.js），绝不存明文；
-- postgres 驱动会在第一次用到账号时 create table if not exists 兜底，
-- 这里写一份是为了让手工建库的人一次执行完。
create table if not exists users (
  id             text primary key,
  username       text not null unique,
  password_hash  text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- ==========================================
-- 7. 自动维护 updated_at
-- ==========================================
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tasks_touch on tasks;
create trigger trg_tasks_touch before update on tasks
  for each row execute function touch_updated_at();

drop trigger if exists trg_clips_touch on clips;
create trigger trg_clips_touch before update on clips
  for each row execute function touch_updated_at();

-- ==========================================
-- 8. 常用视图：任务列表页直接查这个
-- ==========================================
create or replace view task_summary as
select
  t.task_id,
  t.prompt,
  t.status,
  t.model,
  t.theme,
  t.total_clips,
  t.resolution,
  count(c.id) filter (where c.status = 'success')  as success_clips,
  count(c.id) filter (where c.status = 'failed')   as failed_clips,
  t.output_path,
  t.created_at,
  t.completed_at
from tasks t
left join clips c on c.task_id = t.task_id
where t.deleted_at is null
group by t.task_id;

-- ==========================================
-- 9. 行级安全（Supabase 默认开启，服务端用 service_role key 绕过）
-- ==========================================
-- 如果你要让浏览器端直连数据库读取视频列表，取消下面注释并调整策略。
-- 服务端（Node）用 service_role key 访问，不受 RLS 限制。
--
-- alter table tasks         enable row level security;
-- alter table clips         enable row level security;
-- alter table prompts       enable row level security;
-- alter table video_assets  enable row level security;
--
-- create policy "公开只读已完成任务" on tasks
--   for select using (status = 'completed');
-- create policy "公开只读视频资产" on video_assets
--   for select using (true);
