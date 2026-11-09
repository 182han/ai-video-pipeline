# 接手流程（Resume Protocol）

> 任何新会话的第一个动作：读本文件，按顺序执行。不要跳步。

## 第 0 步：侦察（只读，禁止写代码）
按顺序读：AGENTS.md → PROGRESS.md → FEATURES.md

## 第 1 步：核对现状（用命令验证，不要相信文档）
- git status            不干净时先读 PROGRESS.md 的「交接断点」；**不要自行提交别人的改动**
- git log --oneline -5  对照 PROGRESS.md 里记的 commit hash
- 跑测试命令            记录真实结果，不要假设是绿的

> 2026-11-09 交接提示：工作区有另一个会话的 `web/src/components/assistant.js` / `assistantOrb.js` /
> `web/verify/`，不属于本轮任务。只处理 FEATURES.md「E. 前端单版本收口」里的文件，禁止 `git add -A`。

## 第 2 步：复述（回答完就停，等人类确认）
Q1 项目目标，一句话
Q2 现在做到哪了？上一个会话完成了什么？
Q3 下一个功能是哪个？验收标准原文是什么？
Q4 你发现哪些信息矛盾、缺失、或与文档不符？

## 第 3 步：开工（人类确认后才允许）
- 只做 Q3 那一个功能
- 先写测试并确认它失败（红）→ 实现 → 全绿
- 更新 PROGRESS.md → commit → 结束

## 硬规则
- WIP = 1，不许开第二个功能
- 只改 PROGRESS.md「本轮相关文件」里列出的文件
- 不得为了让测试通过而修改已有测试
- 拿不准就停下来问，不要猜
