# Hugging Face Spaces 部署指南

> 目标：把项目部署成**公网可访问**的在线服务，任何人打开链接就能用。
> 顺带解决：Supabase Storage 上传在中国大陆网络下被阻断的问题（HF 服务器在海外）。

---

## 一、部署前必须知道的限制

| 限制 | 说明 | 影响 |
|---|---|---|
| **磁盘是临时的** | 容器重启后 `clips/` 和 `output/` 清空 | 视频必须存对象存储，**不能依赖本地磁盘** |
| **免费实例会休眠** | 闲置约 48 小时后休眠 | 首次访问要等 10–30 秒唤醒 |
| **免费额度** | 2 vCPU / 16GB 内存 / 50GB 磁盘 | 足够运行本项目 |
| **端口固定 3000** | HF 通过 `app_port` 识别 | Dockerfile 已配置 |

> ⚠️ 因为磁盘临时，**部署后本地已有的 79.7MB 视频不会带上去**——需要重新生成，或先把它们上传到 Supabase Storage。

---

## 二、部署步骤（约 10 分钟）

### 第 1 步：注册 Hugging Face

打开 https://huggingface.co/join ，用邮箱或 GitHub 账号注册。**不需要信用卡。**

### 第 2 步：创建 Space

1. 右上角头像 → **New Space**
2. 填写：
   - **Space name**：`ai-video-pipeline`（这个名字会出现在网址里）
   - **License**：可留空或选 GPL-3.0
   - **Select the Space SDK**：选 **Docker**
   - **Docker template**：选 **Blank**
   - **Space hardware**：选 **CPU basic (Free)**
   - **Visibility**：**Public**（必须是 Public 才能公开访问）
3. 点 **Create Space**

### 第 3 步：配置环境变量（关键）

创建后进入 Space，点顶部 **Settings** → 找到 **Variables and secrets**。

把下面这些加进去（**Secret 类型**用于敏感值，**Variable** 用于普通值）：

| 名称 | 类型 | 值 |
|---|---|---|
| `DATABASE_TYPE` | Variable | `postgres` |
| `DATABASE_URL` | **Secret** | 你的 Supabase 连接串 |
| `STORAGE_DRIVER` | Variable | `supabase` |
| `SUPABASE_URL` | Variable | `https://epicxrdtgrfzoausvtui.supabase.co` |
| `SUPABASE_SERVICE_KEY` | **Secret** | 你的 service_role / sb_secret key |
| `SUPABASE_BUCKET` | Variable | `videos` |
| `ACCESS_TOKEN` | **Secret** | 自定义一个访问口令（**强烈建议**） |

> `DATABASE_URL` 和 `SUPABASE_SERVICE_KEY` 必须选 **Secret**，否则会明文显示在 Space 设置页。
> 这两个值都在你本地的 `app/.env` 里，直接复制。

### 第 4 步：上传代码

**方式 A：网页上传（最简单）**

在 Space 页面 → **Files** 标签 → **Add file** → **Upload files**，
把 `app/` 目录的内容拖进去（**不要传** `node_modules`、`clips`、`output`、`.env`、`tools/ffmpeg/bin`）。

**方式 B：Git 推送（推荐，以后好更新）**

```powershell
cd "C:\Users\14872\Desktop\测试\app"

# 添加 HF 远程仓库（把 YOUR_USERNAME 换成你的 HF 用户名）
git remote add hf https://huggingface.co/spaces/YOUR_USERNAME/ai-video-pipeline

# 推送（HF 会要求输入用户名 + Access Token 作为密码）
# Token 在 https://huggingface.co/settings/tokens 创建，勾选 write 权限
git push hf main:main
```

> ⚠️ 推送前确认 `.env` 不会进去（已在 `.gitignore`）。

### 第 5 步：等待构建

推送后 HF 自动开始构建。页面顶部的状态会显示 **Building** → **Running**。

构建约 3–8 分钟（要装 ffmpeg）。日志在 **Logs** 标签。

### 第 6 步：访问

构建完成后，访问：

```
https://huggingface.co/spaces/YOUR_USERNAME/ai-video-pipeline
```

或直接用应用地址：

```
https://YOUR_USERNAME-ai-video-pipeline.hf.space
```

---

## 三、部署后要做的事

### 1. 上传本地视频到 Supabase Storage

部署的服务在海外，**上传不会被阻断**。但视频文件在你本地，需要先传上去。

**方法**：在本地再跑一次上传脚本。如果本地网络不行，可以：

- 在 HF Space 里用 **Files** 上传视频到 `clips/`（临时，重启会丢）
- 或者等有可用代理时本地跑 `node scripts/upload-videos.js`

### 2. 验证数据库连通

打开你的 Space → 看首页任务列表是否有数据。
如果有 → 说明 `DATABASE_URL` 正确。

### 3. 设置访问口令

如果设了 `ACCESS_TOKEN`，访问时需要在 URL 带参数，或在代码里加鉴权中间件。
> 当前 `ACCESS_TOKEN` 只是配置项，**尚未接入鉴权逻辑**。公开访问前建议先补上，否则任何人点几下就能消耗你的 AI 生成额度。

---

## 四、常见问题

### 构建失败：`npm ci can only install with an existing package-lock.json`

已修复：Dockerfile 改用 `npm install`（本项目用 pnpm，npm 锁文件可能不同步）。

### 构建失败：`ffmpeg: not found`

Dockerfile 里已有 `apt-get install ffmpeg`。如果报错，检查是否用了正确的分支。

### 运行时崩溃：`Cannot find module 'pg'`

`package.json` 里 `pg` 是必需依赖。确认推送的是最新代码。

### 上传视频失败

检查 Space 的 **Logs**，看是网络问题还是 key 问题。海外服务器通常不会有网络问题。

### 数据丢失

如果 `DATABASE_URL` 没配或配错，服务会回退到本地 JSON（`data/tasks/`），而容器磁盘是临时的 → **重启即丢**。

**务必确认日志里有 `[storage] 驱动: postgres`**。

---

## 五、成本

| 项 | 限制 | 说明 |
|---|---|---|
| Space 硬件 | 免费 CPU basic | 2 vCPU / 16GB |
| 休眠 | 闲置 48 小时后 | 有访问自动唤醒 |
| Supabase 数据库 | 500MB | 当前用 11MB |
| Supabase Storage | 1GB | 需上传视频 |
| **AI 视频生成 API** | **按量付费** | ⚠️ **唯一真实成本，务必设访问口令** |

---

## 六、部署后的架构

```
用户浏览器
    ↓
Hugging Face Spaces (海外服务器)
    ↓  读写数据
Supabase 数据库 (东京)  ← tasks / clips / prompts
    ↓  存取视频
Supabase Storage       ← 视频文件
```

所有组件都在云端，**不依赖你的电脑**。
