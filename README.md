---
title: AI 长视频自动生成流水线
emoji: 🎬
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 3000
pinned: false
license: gpl-3.0
---

# AI 长视频自动生成流水线

> 上面这段 YAML 是 **Hugging Face Spaces** 部署所需的元数据（指定用 Docker 构建、端口 3000）。
> 在 GitHub 上不影响阅读；部署到其他平台时可忽略或删除。

## 项目简介

基于 Node.js 的 AI 长视频自动生成系统，支持多模型接入、流水线编排、模块化质检。

## 快速启动

```bash
npm install
cp .env.example .env    # 填写 API Key（不填也能用 Mock 模式演示）
npm start
```

访问 http://localhost:3000

> Windows 也可以双击 `启动.bat`

## 文档

| 文档 | 说明 |
|------|------|
| [Supabase 数据库接入手册](docs/Supabase数据库接入手册.md) | 把任务/提示词/视频元数据存进云端数据库 |
| [云端部署与数据库指南](docs/云端部署与数据库指南.md) | 部署到 Hugging Face Spaces / Oracle Cloud |
| [.env.example](.env.example) | 全部环境变量说明 |

## 配置说明

所有密钥通过**环境变量**提供，不写在代码里：

- 复制 `.env.example` 为 `.env`，填写需要的 Key
- `.env` 已被 `.gitignore` 忽略，不会进入版本库
- 不填任何 AI Key 也能运行（Mock 模式）

## 数据存储

支持两种模式，通过 `.env` 切换：

| 模式 | 配置 | 说明 |
|------|------|------|
| 本地 JSON（默认） | `DATABASE_TYPE=` | 数据存在 `data/tasks/`，零依赖 |
| PostgreSQL | `DATABASE_TYPE=postgres` | Supabase / Neon / 自建，多机共享 |

切到数据库后，本地 JSON 仍作为兜底：数据库不可用时服务照常运行，数据不会丢失。

**视频文件不建议存数据库**，应放对象存储（Supabase Storage / Cloudflare R2），数据库只存元数据 URL，详见接入手册。

## 目录结构

| 目录 | 说明 |
|------|------|
| `src/` | 后端核心代码（流水线、任务管理、质检、生成器） |
| `src/generators/` | 可插拔视频生成器适配器（Mock/Seedance/Kling/Agnes/SiliconFlow） |
| `public/` | 前端页面 |
| `data/` | 任务数据、垃圾箱、模板 |
| `clips/` | 生成的视频片段 |
| `output/` | 最终输出视频 |

## 技术栈

- 后端: Node.js + Express + WebSocket
- 前端: 原生 HTML/CSS/JS
- 视频处理: FFmpeg
- AI 模型: Seedance / SiliconFlow / Agnes / Kling
