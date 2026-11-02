# KNOWN_UNKNOWNS — 代码推不出来的信息

> 来源：2026-11-02 只读测绘（第 6 部分）。基线 `1d3c693`。
> 规则：**不编。** 「无法验证」就写无法验证；「只能问人」就写只能问人。

---

## 1. 设计意图 / 决策依据（代码里没有，只在文档里，且文档本身有冲突）

- **成片到底多长**：10 秒 / 15 秒（代码默认单片段）/ 30 分钟（需求表）三个数并存。
  - `PROJECT_STATE.md:21,22,43` 说"单条 10 秒左右长视频成片"、"不做 30 秒"；
  - `AGENTS.md:42` 与 `docs/requirements/项目需求申报表.md:39` 说"成片 30 分钟以上"；
  - `config.js:252` / `.env.example:215` 默认单片段 **15 秒**。
  - `docs/model-selection/10秒长镜头-选型结论.md` 显示 10 秒本指"单片段"——但 PROJECT_STATE 把它写成"成片"。**是文档错位还是产品口径变更，代码里读不出来。**
- 为什么选 wan3.0 而不是 Kling、为什么"不做 30 秒"、为什么砍掉逐段卡点配乐/ducking —— 只在 `PROJECT_STATE.md` 与 `docs/spec/changelog.md` 的"决议"记录里，代码只能看到结果。
- 为什么坚持"零构建、零 npm"、为什么 `public/` 冻结后 `login.html` 又改了 6 次 —— 文档给的理由与 git 行为对不上。

## 2. 废弃方案（只能从文档读到，代码里没有痕迹）

Vite 方案、双端口 3001+3002、Python 版、4K/8K/HDR、纵向滚动工作区、30 秒长视频、逐段卡点配乐。
均只见于 `PROJECT_STATE.md` 的"已否决路线"与 `PROGRESS.md` 的"试过但失败的方向"。**代码里看不出这些曾经存在过。**

## 3. 已知坑（散落在 changelog，代码里只有注释碎片）

- `stageSet` 未列入的步骤是 `undefined`，必须用 `=== true` 判（写成 `!== false` 会让 quick 跑满 8 步）
- `audio_mix` 依赖的是 `transcoding` 不是 `concatenation`（已在 `pipelineStages.js:43-52` 读到）
- 混合音轨时 `-c copy` 会静默丢音频
- ffmpeg 拼接退出码 0 不等于成功，必须校验时长
- `verify-loop` 的 qcVersion 断言已过期（当前红）
- `AUTH_ENABLED=false` 会完全关闭登录墙
- `lut3d` 只能用 cwd + 相对路径（绝对路径报 `Undefined constant`）

这些是**踩过坑才知道的**，不读文档无法从代码推出。

## 4. 无法验证（代码在，但没有证据证明它可用）

| # | 项 | 为什么无法验证 |
|---|---|---|
| 1 | 真实厂商生成 | 全部测试走 Mock / 注入 fetch，没有一次真实 API 调用（无 Key） |
| 2 | 持久化 | `.env` 是 `DATABASE_TYPE=postgres` 但库不可达；测试全程打印 `timeout exceeded`，绿只覆盖内存/JSON 侧 |
| 3 | 真实长片 | 所有素材 3–47 秒；30 分钟成片、长时转码、真实接缝从未跑过 |
| 4 | 视觉 / 交互 | 无人工浏览器验证记录，只有无头截图与 DOM 断言 |
| 5 | 10 个未注册套件 | `seam-qc`、`transitions`、`color-match`、`color-continuity`、`pages`、`port3001` 等本次未跑，**状态是「未验证」不是「通过」** |
| 6 | `verify-auth` 修隔离后是否转绿 | 根因已定位（`data/users.json` 残留 `tmp_negative_probe` + `auth.js:265`），但只读约束下没做修复性复跑 |
| 7 | 剪映调节的实际观感 | 无对照素材的项（高光/白色/黑色/锐化/清晰/颗粒/暗角/HSL）自认"近似"，光感 LUT 比原表低约 2.5 dB |

## 5. 只能问人（代码与 git 都给不出答案）

| # | 问题 | 线索 |
|---|---|---|
| 1 | 远端为什么落后 48 个提交？是没推还是不想推 | `origin/main` = `7901300`（10-21），本地 `1d3c693`（11-02） |
| 2 | `data/users.json` 里的 `tmp_negative_probe` 是谁、为什么留着 | 2026-10-27 创建，导致 `verify-auth` 必红 |
| 3 | `public/preview-app.html`、`preview-login.html` 还要不要 | 全仓无入链的预览副本 |
| 4 | `data/keep/`（23 MB）、`data/reports/`（5 MB）能否清理 | `.gitignore:67/24` 只说明是运行时产物 |
| 5 | `docs/milestones/` 空目录是"没写"还是"不打算写" | 目录存在，0 文件 |
| 6 | 根目录 24 个历史目录 / 9 个 jsonl / 4 张 login-preview 截图，哪些可清 | AGENTS §7 已归类为历史产物 |
| 7 | 仓库结构：根目录的 `AGENTS.md`/`PROJECT_STATE.md`/`docs/` 是否要纳入版本管理 | 当前完全在 git 外，clone `app` 会丢 |
| 8 | 审核门的 D1–D8（见 `docs/spec/review-gate-design.md` §14） | 不拍板无法开工 |

## 6. 测绘本身的不确定性

- 2026-11-02 13:51–14:01 期间另一会话正在实时修改本仓库（`adjustChain.js`），并提交了 `b17bbdd`/`1d3c693`。
  **所有"当前状态"都是时间点快照**；引用前请重跑命令。
- 本报告的测试数字来自 13:28–13:47 的逐套件实测，早于上述两个提交；提交后未重新全量跑。
