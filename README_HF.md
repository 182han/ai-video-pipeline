---
title: AI 长视频自动生成流水线
emoji: 🎬
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 3000
pinned: false
---

# AI 长视频自动生成流水线

基于 Node.js 的 AI 长视频自动生成系统：多模型接入 + 流水线编排 + 模块化质检。

## 部署说明

本 Space 使用 Docker SDK，自动读取仓库根目录的 `Dockerfile`。

### 必须配置的环境变量

打开本 Space 的 **Settings → Variables and secrets**，按需添加：

| 名称 | 说明 | 是否必填 |
|------|------|----------|
| `DATABASE_TYPE` | `postgres` 表示启用数据库 | 推荐 |
| `DATABASE_URL` | Postgres 连接串（Supabase/Neon） | 推荐 |
| `ACCESS_TOKEN` | 访问口令，防止他人盗刷 AI 额度 | **强烈建议** |
| `OPENAI_API_KEY` | 提示词优化用的 LLM Key | 可选 |
| `SILICONFLOW_API_KEY` 等 | 各视频生成模型 Key | 可选 |

> ⚠️ 不填任何 API Key 也能运行：系统默认走 Mock 模式，可以完整演示流程。

### 免费额度注意事项

- 免费 Space 闲置一段时间后会休眠，首次访问需要等待唤醒（约 10-30 秒）
- 容器磁盘是临时的，**重启后 `clips/` 和 `output/` 里的视频会丢失**
- 要长期保存视频，请配置对象存储（`STORAGE_DRIVER=supabase`）或数据库只存元数据
