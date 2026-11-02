# 暂停能力（已实现）— 契约、语义与验收

> 原：2026-10-31 前端提出的需求说明（`# 问题说明：生成过程中的「暂停」能力`）。
> 裁定：`docs/spec/pause-decision.md`（2026-10-31）——**实现为准、文档改**。
> 现状：后端已实现并验收（`verify-pause.js` 71/71）；新版 `/app` 的按钮与状态展示由 Lead 接线，
> 旧版 `app/public/index.html` 已冻结（保留其暂停逻辑作回滚兜底，不在此文件约束内）。

## 1. 为什么要（动机不变）

图生视频是唯一「真花钱 + 耗时长」的环节。用户需要能**停止为剩余片段付费**，而不是只能干等或关页面。

## 2. 现状（2026-10-31，已实现）

| 能力 | 现状 |
|---|---|
| 任务中途暂停 | **有**：`POST /api/tasks/:id/pause`，粒度 A（见 §4） |
| 暂停后恢复 | **有**：`POST /api/tasks/:id/unpause`（原地继续等待中的 worker） |
| 暂停状态 | **`paused`**（与 `failed` 语义分开：用户主动、可恢复） |
| 暂停中断后的出口 | 重启/超时会被降级为 `failed` + `failureCode`，可「补跑」从断点继续 |
| 僵尸任务回收 | `reconcileInterruptedTasks()` 启动时回收，白名单已含 `paused` |

> 历史偏差更正：本文早期版本写「没有中途停止」「建议新增 paused」——那是提出时的状态，
> 现在两者都已不成立。

## 3. 三个原问题：裁定答案

| 原问题 | 裁定 |
|---|---|
| 暂停粒度 A / B / C | **A**：只在「取下一个片段之前」检查；正在跑的片段会跑完；**不中断已发出的生成请求**（不白花钱） |
| 新状态 `paused` 还是复用 `failed` | **`paused`**（用户主动且可恢复）；但重启后无法恢复内存 worker，**降级为 `failed` 并带 `failureCode`**，不是静默卡死 |
| 是否支持恢复 / 走哪条路 | **支持**，走 `unpause`（原地继续）；**不是** `continueTask`（后者语义是补跑已完成步骤） |

## 4. 接口契约（以实现为准）

```
POST /api/tasks/:id/pause
  → 200 { success:true }
  → 200 { success:true, alreadyPaused:true }        // 幂等：重复 pause 不报错
  → 400 { success:false, error:'任务未在运行' }      // 任务存在但不在跑（含已完成）
  → 404 { success:false, error:'任务不存在' }

POST /api/tasks/:id/unpause
  → 200 { success:true }
  → 400 { success:false, error:'任务未处于暂停状态' } // 含「任务不存在」以外的不可操作
  → 404 { success:false, error:'任务不存在' }

GET /api/tasks/:id/pause-state
  → 200 { paused:boolean, status:string }
  → 404
```

WebSocket：**没有**专用 `task:paused` / `task:resumed` 事件；沿用既有 `statusChange` 广播。
前端判断暂停请直接读任务 `status === 'paused'`（决定 §3：暂不加专用事件，列入待办）。

### 4.1 失败原因分类（前端用来区分「暂停超时」与普通失败）

任务对象上新增/使用以下字段（列表接口与详情接口都会透出 `failureCode` / `recoverable`）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `failureCode` | `pause_timeout` | 暂停等待超过上限，任务被中止（**不是生成失败**） |
| | `pause_interrupted` | 暂停期间服务被重启，任务已降级为 `failed`，可补跑 |
| | 缺失 / `null` | 普通生成失败或非失败任务 |
| `pauseTimedOutAt` | ISO 时间 | 仅在 `pause_timeout` 时出现 |
| `interruptedFrom` | `paused` 等 | 重启回收时的原状态 |
| `recoverable` | boolean | 是否可「补跑」（暂停超时/重启回收均为 true） |

界面建议：`failureCode` 为 `pause_timeout` / `pause_interrupted` 时，展示「已中止 · 可补跑」，
不要套用普通失败的红色告警文案；普通失败保持原样式。

## 5. 运行语义与限制

- **检查点位置**：`_batchGenerate` 的 worker 在 `currentIndex++` **之前**检查暂停，
  因此暂停不会跳号丢片段，也不会中断已经发出去的请求。
- **等待上限**：`PAUSE_MAX_WAIT_MS`（默认 30 分钟）。超时**不允许静默**：
  打 ERROR 日志 → 状态 `failed` → `failureCode='pause_timeout'` → `_runPipeline` 立即中止，
  **不会再继续拼接/配乐**。
- **服务重启**：`paused` 无法恢复（`pausedTasks` 是内存 Set）。启动回收会把
  `paused` 标成 `failed` + `failureCode='pause_interrupted'`，文案写明「可补跑」。
- **已知限制（不实现，2026-10-31 裁定）**：拼接/循环/转码/配乐阶段**没有**暂停检查点；
  在这些阶段按暂停只会改状态字符串，不会真的停住 ffmpeg。界面上不应暗示这些阶段也能暂停。

## 6. 前端用法（新版 `/app`）

- 暂停按钮显示条件：`status ∈ {generating, paused}`；`paused` 时按钮变「继续」。
- 点击 → `POST /pause` 或 `POST /unpause`；成功后以返回/`statusChange` 更新状态。
- 显示「已暂停 · 已完成 X/Y 段」所需的 `doneClips/totalClips/atStep` **暂停接口暂不返回**
  （决定 §3 列为后续增强）；可从任务详情/进度接口取，或直接用列表里的 `successClips/totalClips`。
- 失败展示必须区分 §4.1 的 `failureCode`。
- 接口不可用（如旧后端）时**不显示按钮**，避免「点了没反应」。

## 7. 验收（实测，2026-10-31）

脚本：`app/scripts/verify-pause.js`，已注册进 `scripts/verify-all.js`（套件名 `pause`，group=`real`）。
**结果：71 通过 / 0 失败。**

覆盖：

| 组 | 用例 |
|---|---|
| 基本语义 | 不存在 / 未运行 / 未暂停的三种错误；`isPaused` |
| 粒度 A | 4 段任务第 2 段后暂停 → 只跑完在跑的片段；重复 pause 幂等；恢复后只跑 2～4，顺序无重复 |
| 暂停超时 | 超时后 `failed` + `failureCode=pause_timeout` + `pauseTimedOutAt` + 可补跑；不再生成新片段；`_batchGenerate.aborted=true` |
| 中止流水线 | `_runPipeline` 提前返回，拼接/配乐步骤未启动（`pending`） |
| 重启回收 | `paused → failed` + `pause_interrupted` + 可补跑；负向：completed 不回收、普通失败不被套 pause_* |
| HTTP | 404（不存在）×3、400（未运行/未暂停）、200（pause-state/列表） |
| 列表透出 | 列表接口 `failureCode` / `recoverable` 可读（抽屉/侧栏可区分） |
| 防回归 | 源码级断言：白名单、两处 failureCode、`PAUSE_MAX_WAIT_MS`、aborted 分支、worker `try/finally`、404/400 路由 |

**运行方式（重要）**：本机 DSH 沙箱下「捕获子进程输出」会 `EPERM`，
`node scripts/verify-all.js` 无法在前台运行（它用 `execFile` 默认 pipe）。
按 `pause-decision §6` 改为**后台 job 逐套件跑**：

```
# 后台 job 里执行（每个套件一条，或串行放在同一个 job）
node scripts/verify-pause.js
node scripts/verify-pipeline-fixes.js
```

**未验证**：真实付费生成下的暂停（决定 §6 未批准付费跑；本脚本用可控慢速 stub）；
新版 `/app` 的按钮交互与布局（由 Lead 接线后单独验收）。
