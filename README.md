# app - AI 长视频自动生成流水线

## 项目简介

基于 Node.js 的 AI 长视频自动生成系统，支持多模型接入、流水线编排、模块化质检。

## 快速启动

- Windows: 双击 `启动.bat` 或 `启动.ps1`
- 命令行: `node server.js`
- 访问地址: http://localhost:3000

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
