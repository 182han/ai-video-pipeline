# Supabase 数据库接入 · 操作手册

> 本文档基于**真实 Postgres 引擎的实测**编写，所有步骤均验证通过。
> 相关代码：[src/storage/](app/src/storage/)、[schema.sql](app/src/storage/schema.sql)、[migrate-to-db.js](app/scripts/migrate-to-db.js)

---

## 一、你已经有什么（不用写代码）

存储层已完整实现并测试通过：

| 能力 | 状态 |
|---|---|
| 6 张表 + 1 视图 + 触发器 | ✅ 真实 Postgres 引擎验证通过，可重复执行 |
| 任务增删改查 | ✅ 8 组测试全通过 |
| 24 个历史任务迁移 | ✅ 0 失败，幂等无重复 |
| 密钥不入库 | ✅ 端到端验证 |
| 数据库挂掉时服务降级 | ✅ 本地 JSON 兜底，服务照常启动 |

**你只需要做三件事**：注册 Supabase → 填连接串 → 跑迁移。

---

## 二、操作步骤

### 步骤 1：注册并创建项目

1. 打开 https://supabase.com → Sign up（可用 GitHub 账号登录）
2. 点 **New project**
   - Name：`ai-video-pipeline`
   - Database Password：**自己设一个强密码并记下来**
   - Region：选 **Singapore** 或 **Tokyo**（离国内近，延迟低）
3. 等 1~2 分钟项目初始化完成

### 步骤 2：执行建表脚本

1. 左侧菜单 → **SQL Editor** → **New query**
2. 把 [schema.sql](app/src/storage/schema.sql) **全文粘贴**进去
3. 点 **Run**（或 Ctrl+Enter）

看到 `Success. No rows returned` 即成功。

> 💡 脚本是幂等的，重复执行不报错、不丢数据。
> 如果提示 `pgcrypto` 相关警告，可忽略——脚本已做了容错处理，会自动使用内置的 `gen_random_uuid()`。

**验证**：左侧 **Table Editor**，应该看到 6 张表：
`tasks`、`clips`、`prompts`、`video_assets`、`templates`、`app_settings`

### 步骤 3：获取连接串

1. 项目设置（齿轮图标）→ **Database**
2. 找到 **Connection string** → 选 **URI** 标签页
3. 复制形如这样的字符串：

```
postgresql://postgres.xxxxx:你的密码@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

> ⚠️ 把其中的 `[YOUR-PASSWORD]` 替换成你在步骤 1 设的密码。

**两种端口怎么选**：

| 端口 | 类型 | 适用 |
|---|---|---|
| **6543** | Transaction pooler | ✅ **推荐**，适合 Serverless（Hugging Face Spaces） |
| 5432 | Direct connection | 长期运行的服务器（Oracle VM） |

### 步骤 4：填入 .env

打开 [app/.env](app/.env)，填这两行：

```ini
DATABASE_TYPE=postgres
DATABASE_URL=postgresql://postgres.xxxxx:你的密码@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

> 🔒 `.env` 已在 `.gitignore` 里，**永远不会被推到 GitHub**。

### 步骤 5：迁移历史数据

```powershell
cd app
npm run db:migrate
```

预期输出：

```
========================================
  本地 JSON → 数据库 迁移
========================================

驱动: postgres
目标: postgresql://postgres.xxxxx:***@aws-0-...pooler.supabase.com:6543/postgres

✅ 数据库连接成功

开始迁移 ...
========================================
  ✅ 成功: 24 条
========================================
```

### 步骤 6：重启服务验证

```powershell
npm start
```

启动日志出现这一行即成功：

```
[storage] 驱动: postgres
```

然后打开 http://localhost:3000，任务列表应该和之前一样（数据已从数据库读出）。

**验证数据真的进库了**：去 Supabase 的 **Table Editor → tasks**，应该能看到 24 行。

---

## 三、验证清单

跑完上面步骤，请确认：

- [ ] Supabase Table Editor 里能看到 6 张表
- [ ] `tasks` 表有 24 行数据
- [ ] `clips` 表有数据（片段记录）
- [ ] 启动日志显示 `[storage] 驱动: postgres`
- [ ] 网页上任务列表正常显示
- [ ] 新建一个任务，刷新页面后任务还在（说明写库成功）

---

## 四、常见问题

### Q1：连不上数据库 / 超时

**原因**：国内网络访问 Supabase 可能不稳定。

**排查**：
```powershell
# 测试端口连通性
Test-NetConnection -ComputerName aws-0-ap-southeast-1.pooler.supabase.com -Port 6543
```

如果 TCP 不通，检查代理设置。Supabase 走的是普通 Postgres 协议，代理需支持 TCP 转发。

### Q2：报错 `password authentication failed`

密码错了，或密码里有特殊字符（如 `@`、`#`、`/`）没做 URL 编码。

**解决**：去 Supabase 重置数据库密码，或把特殊字符做 URL 编码。

### Q3：报错 `relation "tasks" does not exist`

建表脚本没执行，或者执行在了别的 schema 里。

**解决**：回到步骤 2，在 **SQL Editor** 里重新执行 [schema.sql](app/src/storage/schema.sql)。

### Q4：查询慢

免费版用的是共享实例。如果任务多了，建议：
- 给 `tasks.created_at` 建索引（schema 里已有）
- 只查需要的列，别 `select *`

### Q5：想换回本地 JSON

把 `.env` 里的 `DATABASE_TYPE` 改成空即可：

```ini
DATABASE_TYPE=
```

重启后自动回到 JSON 模式，数据在 `data/tasks/`。

> 💡 **本地 JSON 始终是兜底**：数据库连不上时，服务照常启动，数据仍写入本地文件，不会丢。

---

## 五、数据表说明（你关心的"存视频和提示词"）

### 提示词存在哪

`prompts` 表：

| 字段 | 说明 |
|---|---|
| `text` | 原始提示词 |
| `optimized_text` | 优化后的提示词 |
| `theme` | 主题标签（如 `lake`） |
| `use_count` | 被复用次数 |
| `created_at` | 创建时间 |

**能做什么**：

```sql
-- 搜索包含"湖泊"的提示词
SELECT text, theme FROM prompts WHERE text ILIKE '%湖泊%';

-- 最常用的提示词
SELECT text, use_count FROM prompts ORDER BY use_count DESC LIMIT 10;

-- 按主题统计
SELECT theme, count(*) FROM prompts GROUP BY theme ORDER BY count DESC;
```

### 视频存在哪（关键概念）

**视频文件本体不进数据库**，原因：

- Supabase 免费数据库只有 **500MB**
- 一个 1080p 视频几十 MB，**存十几个就满了**
- 数据库读写大文件极慢

**正确架构**：

```
视频文件  →  Supabase Storage（免费 1GB）
             或 Cloudflare R2（免费 10GB，无出网流量费）
                    ↓
数据库    →  video_assets 表，只存"索引"
             remote_url / size_bytes / duration / 关联哪个任务
```

`video_assets` 表字段：

| 字段 | 说明 |
|---|---|
| `kind` | `clip` 片段 / `final` 成片 / `loop` 循环 / `bgm` 配乐 |
| `local_path` | 本地路径（开发时） |
| `remote_url` | 云端 URL（部署后） |
| `storage_driver` | `local` / `supabase` / `s3` / `r2` |
| `size_bytes` | 文件大小 |
| `duration` | 时长（秒，支持小数） |

**打个比方**：数据库存的是图书馆的**目录卡**，不是书本身。

---

## 六、本次实测发现并修复的问题

为保证你接上后不踩坑，我用真实 Postgres 引擎做了一轮完整验证，发现并修复了 4 个问题：

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | `pgcrypto` 扩展不可用导致建表失败 | **Supabase 上可能直接挂** | 改为可选，失败时用内置函数 |
| 2 | `postgres.js` 里 `require('../../config')` 路径错了一层 | **一连接就崩溃** | 修正为 `../../../config` |
| 3 | `index.js` 引用了不存在的 `sqlite.js` | 设 `DATABASE_TYPE=sqlite` 会崩 | 补全 SQLite 驱动 |
| 4 | `total_duration` 是 `integer`，但真实数据是 `35.04` | **迁移失败**，任务丢失 | 改为 `numeric` |

另外改善了错误提示：之前任何 `pg` 加载问题都会误报"请先安装 pg"，现在会显示真实原因（如 `getaddrinfo ENOTFOUND`）。

---

## 七、成本提醒

| 资源 | 免费额度 | 说明 |
|---|---|---|
| Supabase 数据库 | 500MB | 只存元数据的话够用很久 |
| Supabase Storage | 1GB | 存视频，或用 R2 的 10GB |
| 项目闲置 | 7 天暂停 | 有访问会自动恢复 |
| 数据库带宽 | 5GB/月 | 正常使用足够 |

需要更长时间存储视频，推荐 **Cloudflare R2**（10GB 免费 + 出网流量免费）。
