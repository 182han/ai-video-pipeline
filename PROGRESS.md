# PROGRESS — 补建基线完成（2026-11-02）

## 当前状态

**补建基线已完成。** 仓库内已具备：契约（`AGENTS.md`）、功能清单（`FEATURES.md`）、未知项（`KNOWN_UNKNOWNS.md`）、接手流程（`prompts/resume.md`）。

## 基线快照

| 项 | 值 |
|---|---|
| HEAD | `1d3c693`（`docs: handoff PROGRESS.md (adjust module)`） |
| 提交总数 | 92 |
| 工作区 | 干净（`git status --porcelain` 空） |
| 运行时 | node v24.21.0；**npm 不存在**；pnpm 损坏 |
| 门禁 | `verify-all.js` 在本机 `spawn EPERM`，只能逐个套件跑 |
| 测试基线（2026-11-02 13:28–13:47） | 17 个注册套件 / 660 条断言 / **644 通过、16 失败**；15 绿、2 红 |
| 红灯 | `verify-auth` 11/15（`data/users.json` 残留 `tmp_negative_probe`）；`verify-loop` 28/1（断言 `qcVersion===2`，代码 `=3`） |
| 数据库 | `.env` 为 `DATABASE_TYPE=postgres`，**不可达**（测试打印 `timeout exceeded`） |

## 本轮产出

| 文件 | 动作 |
|---|---|
| `app/AGENTS.md` | 新建（构建/启动、测试、代码规范、坑、红线、验收口径） |
| `app/FEATURES.md` | 新建（已实现 [x] + commit；未实现按 P0–P3） |
| `app/KNOWN_UNKNOWNS.md` | 新建（测绘第 6 部分的缺口，原样收录） |
| `app/prompts/resume.md` | 新建（接手流程模板） |
| `app/PROGRESS.md` | 重写（原调色链交接原文已保留在文末附录） |

## 已确认的产品决策（2026-11-02 15:0x）

| 问题 | 结论 |
|---|---|
| 成片时长 | **30 分钟**（长片）；单片段 **5–10 秒**，逐个生成后拼接 |
| 单片段默认值 | 代码/`.env` 是 **15 秒**，与 5–10 秒不符 → **待定是否改** |
| 审核门审什么 | **图片**；用户会**逐张人工确认**（= 设计文档 D1 选项 B） |
| 审核门其余决策 | D2–D8 仍未定 |
| UI 改动 | 由 **UI agent** 负责；**调色模块也不归研发** |
| 根目录文档 | 纳入版本控制（文本类已导入 `app/docs/`） |
| `data/users.json` | 与线上登录无关（线上在 Postgres，账号 `admin`）→ 可安全删除 |
| 远端 | 要推（领先 51 个提交，待凭据） |

---

## 下一步：第一个未完成功能 = 人工审核门 `awaiting_review`（P0）

**为什么是它**：
- 全仓 `awaiting_review` 命中 **0 次**，是唯一「设计已完备但一行未实现」的核心功能；
- 它卡住新版前端六步向导的第 ③ 步（`web/src/screens/create.js:7,217` 只能给说明）；
- 设计文档已给出验收清单（`docs/spec/review-gate-design.md` §13，≥20 条）与实施顺序（§15）。

**但不能直接开工，它有两个前置**：

1. **产品需先定 D1–D8**（设计文档 §14「不定就无法开工」）：整组/逐张确认、驳回回退点、审核超时、哪些档位含审核门、旧任务是否升级、分镜图是否公网可读、图片厂商、是否记录审核人。
2. **前置①：状态机缺陷修复**（§15 的第 ① 步）——`paused` 重启永久卡死、暂停超时静默丢弃、历史状态不在回收白名单。不先做，新增的「看起来像进行中」的状态会必然踩同一个坑（风险 R1，致命）。

**所以第一个可执行动作是前置①，不是直接加状态。**

### 下一步第一步的具体命令

```powershell
cd "C:\Users\14872\Desktop\测试\app"

# 1) 先确认现有状态机校验基线是绿的（后续要在这个脚本上扩测，不得删原断言）
node scripts/verify-pipeline-fixes.js

# 2) 定位回收白名单与 paused 分支（设计文档说改这里）
Select-String -Path src\pipeline.js -Pattern "IN_PROGRESS|reconcileInterruptedTasks" -Context 2,10

# 3) 只读对齐设计文档里的验收用例 3/4（awaiting_review 不得被回收）
Get-Content ..\docs\spec\review-gate-design.md -Encoding UTF8 |
  Select-String -Pattern "^## 5|^### 5.2|^## 13" -Context 0,12
```

然后：**先加一条会失败的用例**（扩 `verify-pipeline-fixes.js`，不改原断言）→ 让它红 → 再改 `src/pipeline.js`。

---

## 本轮相关文件（下一轮只许改这些）

- `src/pipeline.js`
- `scripts/verify-pipeline-fixes.js`
- `PROGRESS.md`

> 审核门其余文件（`taskManager.js`、`pipelineStages.js`、`server.js`、新增 `verify-review-gate.js`）**在 D1–D8 拍板前不要动**。

## 已知风险

1. **并发会话**：2026-11-02 13:51–14:01 期间另一会话在本仓库实时改 `adjustChain.js` 并提交了 `b17bbdd` / `1d3c693`。动手前与提交前各查一次 `git status`；**不要 `git add -A` 盲扫**。
2. **两处红测试**：不是功能坏了，但会掩盖真实回归，扩测前先处理或明确跳过。
3. **DB 不可达**：涉及持久化的断言不可信。

---

## 附录：2026-11-02 14:01 调色链交接原文（保留自 `1d3c693`）

> 本附录原样保留另一会话写入的 `PROGRESS.md`，避免覆盖丢档。其内容与本轮基线无关，仅供查阅。

```markdown
# PROGRESS — 剪映「调节」模块交接（2026-11-02）

## 项目目标
一句话提示词 → 自动分镜 → 批量生成 → 质检 → 拼接配乐 → 适合 Android TV 屏保循环长片；
本任务只负责：把剪映「调节」模块复刻进后端。

## 已完成功能
- 剪映调节逆向 + 实现（12 项点式 + HSL/曲线/色轮）：`1c39bcc`
- 后端接线（config / taskManager / pipeline / videoProcessor，默认关闭）：`1c39bcc`
- 独立 CLI `scripts/apply-adjust.js`：`1c39bcc`
- 自研 LUT（替换剪映资源）+ 运行时自检闸：`b17bbdd`
- 注：根目录 `docs/spec/re-jianying/*` 不在 git 仓库内（仓库根是 `app/`），未纳入版本管理。

## 当前任务
剪映「调节」模块复刻。验收标准原文：
> 完成剪映「调整」模块的逆向与实现：把基础调节（亮度/对比度/饱和度/色温/色调/高光/阴影/白色/黑色/光感/锐化/清晰/颗粒/褪色/暗角）、HSL、曲线、色轮逐项复刻为可运行代码，并用对照视频逐项验证 PSNR，记录到 docs/spec/re-jianying/jy-adjust.md。全部算法在 proto/ 跑通后，后端落进 app/src。到达需要改 app/web 面板 UI 的那一步前停止并提醒用户，不擅自改 UI。

## 断点五要素

### 1. 目标与验收标准
当前进度：后端已完成并验证；UI 未做，且按约定必须由用户授权后才能动 app/web/**。

### 2. 已改文件（完整路径）
已提交（1c39bcc + b17bbdd）
- app/config.js（新增 ADJUST 段，默认 false）
- app/src/taskManager.js（解析 options.adjust，白名单+钳制）
- app/src/pipeline.js（_adjustOptionsFor()、_assertAdjustApplied()、3 处转码调用）
- app/src/videoProcessor.js（adjustFilter/adjustCwd；_runFFmpeg(cmd, opts) 支持 cwd）
- app/src/processors/adjustChain.js（新，复刻实现 + loadCube + 自研 fade）
- app/scripts/apply-adjust.js（新，CLI）
- app/scripts/verify-adjust-chain.js（新，13 项）
- app/scripts/verify-adjust-pipeline.js（新，12 项，含负向用例 E）
- app/scripts/build-adjust-lut.js（新，LUT 生成器 + 镜像模式）
- app/assets/adjust/lightSensation_max.cube、lightSensation_min.cube（新，自研 33³）
- app/.env.example（3 个 ADJUST_*）、app/.gitignore（data/adjust/）
- 已删除：app/assets/adjust/{lightSensation_max.png, lightSensation_min.png, fade_max.texture}

未提交（不在 git 仓库内，需手动备份）
- docs/spec/re-jianying/jy-adjust.md（主报告，§1–§15）
- docs/spec/re-jianying/adjust-integration-plan.md
- docs/spec/re-jianying/adjust-api-contract.md
- docs/spec/re-jianying/proto/（分析脚本 + app-module/adjustChain.js 源 + cubes/）

### 3. 当前测试状态
全绿，无红灯。2026-11-02 13:45 实测，11 个套件逐个 EXIT=0：
stages 45/0、frontend-static 43/0、stats 42/0、pipeline-fixes 28/0、mock-vqc 14/0、
skill-prompt 109/0、skill-ai-path 17/0、stage-pipeline 37/0、adjust-chain 13/13、
adjust-pipeline 12/0、transition-ui 22/0。
唯一异常：node scripts/verify-all.js --fast 仍 EXIT=1（spawn EPERM，环境限制）。不是代码缺陷。

### 4. 下一步第一个具体动作
不涉 UI 的第一步：打开 app/.env，末尾追加
ADJUST_ENABLED=true
然后 cd app && node server.js 启动（当前 3001 无监听），
再 POST /api/tasks 带 "adjust":{"brightness":10}，确认 GET /api/tasks/:id 回显
adjust 且任务日志出现 调节滤镜: lut3d=...。
若用户授权改 UI：先读 app/web/src/screens/create.js 与任务提交封装，
确认 POST /api/tasks 的 body 构造位置，把 adjust 并入；字段契约见
docs/spec/re-jianying/adjust-api-contract.md。

### 5. 需要人来拍板的设计决策
1. UI 归属：app/web/** 属 UI 写权限，是否授权研发改。
2. verify-adjust-pipeline.js 是否注册进 verify-all.js（建议进 real 组；该文件近期被别人改过）。
3. 是否接受两个近似：lightSensation_min.cube 由 max 镜像生成（无对照）、褪色改为自研公式（无对照）。
4. 根目录 docs/ 游离于 git 之外：是否需要另建版本管理。
5. 本文件覆盖了另一会话的 PROGRESS.md（其内容可从 6410788 取回）。

## 已知问题
- 高光/白色/黑色：参数映射取自引擎 Lua 原文，但无图像对照，未验证。
- 锐化/清晰/颗粒/暗角：ffmpeg 滤镜近似，不是逐像素复刻；HSL 亦无对照。
- 光感自研 LUT 比剪映原表低约 2.5 dB（38.0–38.4 vs 40.95）。
- 同一工作区还有另一会话在改 server.js / verify-all.js / 登录页；
  1c39bcc 把两个会话的改动混在同一 commit（提交信息未逐条列出，违反 AGENTS §8）。
- data/logs/ 被误提交进仓库。
- 无 UI 面板 → 功能目前只能经 API 或 CLI 触发；.env 未开启。

## 试过但失败的方向
- 逐通道 1D 曲线拟合光感：29.77 dB，不够（光感是强三位相关变换）。
- 亮度曲线 + 色度增益模型：28.88 dB，更差。
- 迭代式残差分摊：发散（10.57 → 18.48 dB），改为一次性加权平均。
- 17³ 网格：仅 37.0 dB；改 33³ 得 38.5 dB。
- lut3d 用绝对路径：C\: 转义与正斜杠均报 Undefined constant；只能 cwd + 相对文件名。
- PowerShell 内联 node -e 传 JSON/引号多次被吃掉；一律改为写 .mjs/.js 脚本文件。
- 用 Select-String 管道读取 node 输出会导致假 EXIT=1（broken pipe），要重定向到文件再判断。
- 本机早前无 git（现已可用），当时只能按 mtime 判断并发改动风险。
```
