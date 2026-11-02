# 人工审核门（Review Gate）技术方案

> 目标：把现有「提示词 → 视频」的 8 步全自动流水线，改造成
> 「提示词 → 分镜 → **图片** → **人工确认** → 视频 → …」。
> 版本：v1（2026-10-26）　编写：backend-dev　**本期只出方案，未改任何代码。**
>
> 依据：全部结论标注 **文件:行**。三态标注沿用 AGENTS.md §5.1 ——
> **已核实**（读码可确认）/ **推断**（合理但需实测）/ **未核实**（尚无依据）。
> 本期无法跑 `node scripts/verify-all.js`（本机 spawn EPERM 必失败），
> 因此**所有「已核实」都只代表静态读码成立，不代表已实测通过**。

---

## 0. 结论摘要（先读这 6 条）

1. **新状态建议命名 `awaiting_review`**，并且**必须从 `reconcileInterruptedTasks()` 的
   `IN_PROGRESS` 列表里排除**，改为「认得它、原地保留」——否则用户审核到一半重启，
   任务会被当成僵尸标记 `failed`，审核成果全丢（`pipeline.js:988`）。
2. **不要把审核实现成「挂起等待」**（不阻塞 worker、不用 `_waitIfPaused`）。
   建议实现成**流水线落点**：跑到审核点就 `return` 并释放 `runningTasks`，
   用户确认后由新入口重新进入。理由见 §5.2（现有暂停机制有 30 分钟静默丢弃的坑）。
3. **现有暂停/恢复已经存在**（`pauseTask`/`resumeTask`/`_waitIfPaused`，`pipeline.js:1647-1682`），
   与「等人审核」**语义不同、不能复用**。原任务说明里「现有只有 startTask / continueTask」
   这一条与仓库现状不符，本文已在 §2.2 更正。
4. 现状里**已经有 3 个状态机缺陷**（§4），其中 `paused` 重启后永久卡死、
   `_waitIfPaused` 超 30 分钟静默丢弃任务这两条，**在引入审核门前就该修**。
5. 新增 `image_generation` 步骤会**连带改 4 处契约**：`PIPELINE_STEPS`、进度权重、
   档位依赖表、以及 5 个静态断言 `public/` 的验收脚本（§10.3）。这不是「加一个状态」那么小。
6. **旧任务（无图）补跑会出现「状态矛盾」误判**（`pipelineStages.js:262-269`），
   必须专门兜底，否则所有历史任务都不能补跑了（§9）。

---

## 1. 术语与范围

| 术语 | 含义 | 现状 |
|---|---|---|
| 审核门 / Review Gate | 图片生成后、视频生成前的人工确认点 | **不存在** |
| 分镜图 | 每个片段一张静帧，供确认构图/风格 | **不存在**（`src/generators/imageGen.js` 只是配置预留层） |
| 挂起式等待 | worker 停在原地等用户 | 现有 `pauseTask` 是这种（片段粒度） |
| 落点式等待 | 流水线跑到此处正常结束，用户确认后重新进入 | **不存在** |

**不在本文范围**：图片生成厂商接入细节（见 `docs/spec/i2v-capability.md`）、
前端页面实现、计价。

---

## 2. 现状事实清单

### 2.1 状态全集（读码结果）

`src/pipeline.js` 与 `src/taskManager.js` 里出现过的任务状态，**比任务说明里列的 5 个多**：

| 状态 | 出处（文件:行） | 含义 |
|---|---|---|
| `pending` | `pipeline.js:109`（初始）、`pipeline.js:912`（补跑切回） | 待开始 |
| `generating` | `pipeline.js:1182`、`pipeline.js:1663`（resume） | 生成片段中 |
| `concatenating` | `pipeline.js:187`、`pipeline.js:1294` | 拼接中 |
| `looping` | `pipeline.js:252`、`pipeline.js:1459` | 无缝循环中 |
| `transcoding` | `pipeline.js:292`、`pipeline.js:1518/1537` | 转码中 |
| `mixing` | `pipeline.js:1559` | 配乐混音中 |
| `regenerating` | `pipeline.js:147` | 单片段重生成中 |
| `processing` | `pipeline.js:457`、`pipeline.js:463` | 重新配乐中（历史用词） |
| `paused` | `pipeline.js:1653` | 已暂停（新增于暂停功能） |
| `optimizing` | `taskManager.js:713`（旧任务百分比推算） | 提示词优化中（历史用词） |
| `partial` | `pipeline.js:335`、`pipeline.js:1630` | 部分成功 |
| `completed` | `pipeline.js:1277`、`pipeline.js:1630` | 完成 |
| `failed` | 多处 | 失败 |

> **注意**：`regenerating` / `processing` / `optimizing` / `paused` 都**不在**
> `reconcileInterruptedTasks()` 的 `IN_PROGRESS` 列表里（列表 6 项：pending/generating/
> concatenating/looping/transcoding/mixing，`pipeline.js:988`）。
> 这意味着它们重启后**永远不会被回收**。

### 2.2 暂停/恢复机制（更正任务说明里的一处偏差）

任务说明写「现有只有 startTask / continueTask，语义是重跑不是等人」。
读码结果：**仓库里已有独立的暂停/恢复**，只是语义是「生成中暂停」，不是「等人」：

| 方法 | 位置 | 语义 | 关键限制 |
|---|---|---|---|
| `pauseTask(taskId)` | `pipeline.js:1647-1656` | 置 `pausedTasks` + 状态 `paused` | **要求任务正在运行**（`:1650`），否则返回「任务未在运行」 |
| `resumeTask(taskId)` | `pipeline.js:1658-1666` | 删 `pausedTasks` + 状态回 `generating` | **要求内存里有暂停标记**（`:1661`），重启即失效 |
| `isPaused(taskId)` | `pipeline.js:1668-1670` | 查内存 Set | — |
| `_waitIfPaused(taskId, maxWaitMs)` | `pipeline.js:1673-1682` | worker 原地轮询，500ms 一次 | **默认上限 30 分钟**（`:1673`） |
| worker 检查点 | `pipeline.js:1717-1721` | 只在「取下一个片段之前」检查；正在跑的片段会跑完 | 不中断已发出的请求（省钱，是刻意设计） |

路由：`POST /api/tasks/:id/pause`、`/unpause`、`GET /api/tasks/:id/pause-state`
（`server.js:1540-1557`）。

**结论**：`pausedTasks` 是**纯内存 Set**（`pipeline.js:31`），
`resumeTask` 依赖它 → **服务重启后无法恢复任何暂停任务**（已核实，读码）。

### 2.3 其它相关事实

| 事实 | 位置 | 说明 |
|---|---|---|
| 8 个流水线步骤 | `taskManager.js:26-36` | prompt_optimize / storyboard / clip_generation / concatenation / loop_processing / audio_mix / transcoding / final_qc |
| `stepKeys` 暴露给前端 | `taskManager.js:741` | `PIPELINE_STEPS.map(s => s.key)` —— **加步骤=改 API 契约** |
| 进度权重表 | `taskManager.js:675-685` | 各步权重硬编码；加步骤要补权重 |
| 进度百分比 | `taskManager.js:688-716`、`:735` | 按 steps 累计；`Math.min(99, …)` 封顶 99 |
| 片段进度映射 | `taskManager.js:743-754` | **不含任何图像字段** —— 审核页拿不到图 |
| 状态更新自动广播 | `taskManager.js:577-582` | `updateTaskStatus` 内部即 `broadcastProgress` + `broadcastStatusChange` |
| WS 事件仅 4 种 | `wsManager.js:116/141/161/181` | `progress` / `clipUpdate` / `statusChange` / `stepUpdate` |
| 启动回收（不 await） | `server.js:1750` | `.then/.catch` 异步，不阻塞启动 |
| `_completedSteps` 口径 | `pipeline.js:672-680` | **只认 `completed` 与 `reused`**；`skipped` 明确排除 |
| 重启回收的测试 | `scripts/verify-pipeline-fixes.js:98-134`（正文 28 项） | 造 `mixing` 僵尸 → 断言变 `failed` + 负向断言 `completed` 不被误收 |
| 图片生成现状 | `src/generators/imageGen.js:104-117` | 调用即抛「尚未接入厂商」，**不返回假图** |
| 图片/图生视频配置位 | `config.js:155-176` | `IMAGE_GEN_*` + `I2V_*` 已预留，`I2V_*` 可回退到 `IMAGE_GEN_*`（`imageGen.js:30-40`） |
| 能力三态 | `generators/index.js:48-61`、`imageGen.js:80-87` | `supportsImageInput`: true/false/null，**null 不得当成支持** |

---

## 3. 新状态命名与完整流转图

### 3.1 命名

| 候选 | 评价 |
|---|---|
| **`awaiting_review`**（推荐） | 短、动词化、与 `awaiting_payment` 这类业界惯例一致；可同时覆盖「待审图」与未来的「待审成片」 |
| `review_pending` | 可读但偏名词堆叠；与 `pending` 容易在前端 `switch` 里混淆 |
| `paused_for_review` | 会让人误以为可复用 `paused` 的恢复路径 —— **有语义污染风险，不建议** |
| `awaiting_image_review` | 最精确，但把「审核对象」写进状态名，将来审成片时只能再加一个状态 |

**建议**：`awaiting_review`，并另用 `task.review.target`（`'images'` / 未来 `'final'`）区分审核对象。

### 3.2 完整流转图（含新增分支）

```
                        ┌──────────────────────────────────────────────┐
                        │  图生视频能力可用（image_generation 在档位内） │
                        └───────────────────┬──────────────────────────┘
                                            ▼
  [POST /api/tasks]──► pending ──►（prompt_optimize）──►（storyboard）
                                            │
                                            ▼
                                  （image_generation）  ← 新增步骤
                                            │  产出 task.review.images[]
                                            ▼
                                  ★ awaiting_review ★   ← 新增状态（等待人工）
                                   │        │        │
                       approve     │        │ reject │ 单张重做
                                   │        │ 整组   │
                                   ▼        ▼        ▼
                              generating ◄─────（回到 image_generation 的
                                   │            单张重生成，仍留在
                                   │            awaiting_review）
                                   ▼
                           （clip_generation / 片段质检）
                                   │
                                   ▼
                        concatenating ─► looping ─► transcoding ─► mixing
                                   │
                                   ▼
                          completed / partial
                                   │
                    任一环节异常 ──┴──► failed（recoverable 视已完成步骤）
```

补充说明：

- **老链路（无图）**：`pending → generating → …`，**完全不经过** `awaiting_review`。
  是否走新链路由「档位是否包含 `image_generation`」+「模型能力位」共同决定（§9）。
- `awaiting_review` **不是终态，也不是失败**：它必须能在重启后原样保留（§5.1）。
- 用户连续驳回 N 次不设自动放弃；只有显式「放弃任务」才进 `failed`（`abortedByUser: true`）。

### 3.3 状态与「是否在跑」的二维关系（关键）

现有代码把这两件事混在一起（`runningTasks` 决定能不能 start、`status` 决定 UI 显示）。
审核门要求 **status = awaiting_review 时必须 runningTasks 里没有它**：

| 状态 | 在 `runningTasks`？ | 在 `pausedTasks`？ | 重启后如何处置 |
|---|---|---|---|
| `pending` | 短暂在（`startTask` 后） | 否 | 回收 → `failed`（现状，保留） |
| `generating` / `concatenating` / `looping` / `transcoding` / `mixing` | 是 | 否 | 回收 → `failed`（现状，保留） |
| `paused` | 是（worker 在等） | 是 | **现状：永久卡死**（§4.1）；建议改为回收 → `failed` 且注明「暂停中被打断」 |
| **`awaiting_review`** | **否** | **否** | **原地保留，不回收、不改状态**（新增分支） |

---

## 4. 现有状态机的 3 个缺陷（引入审核门前应先修）

> 这三条都是**读码核实**、**未实测**。它们不修，审核门会继承同样的病。

### 4.1 `paused` 重启后永久卡死（已核实，读码）

- `reconcileInterruptedTasks()` 的 `IN_PROGRESS` 不含 `paused`（`pipeline.js:988`）；
- `pausedTasks` 是内存 Set（`pipeline.js:31`），重启即清空；
- 于是任务停在 `paused`，点「继续」时 `resumeTask` 判定 `!this.pausedTasks.has(taskId)`
  直接返回「任务未处于暂停状态」（`pipeline.js:1661`），**用户没有任何出口**。

**修法**：把 `paused` 纳入回收，标 `failed` + `interruptedFrom: 'paused'`，
文案写明「暂停期间服务被重启，可从断点补跑」。（不要标 completed，§4.1 同理。）

### 4.2 `_waitIfPaused` 超 30 分钟会**静默丢弃**任务（已核实，读码）

`pipeline.js:1673-1682` 超时 `return false`；调用处 `pipeline.js:1718-1721`：

```js
const stillRunning = await this._waitIfPaused(taskId);
if (!stillRunning) return;   // ← worker 直接退出，没有日志、没有状态变更
```

worker 退出后 `_batchGenerate` 仍会 `resolve`（剩余片段既没成功也没失败），
流水线继续往下走，状态从 `paused` 被后续步骤覆盖成 `concatenating`……
用户看到的是「暂停莫名其妙自己跑完了，而且少了几段」。

**修法**：超时不能静默。至少 `console.warn` + 给任务记 `pauseTimedOutAt`，
并显式走 §4.1 的回收路径。更好的做法是取消 30 分钟上限（改为「直到用户操作或进程退出」）。

### 4.3 多个历史状态不在回收列表（已核实，读码）

`regenerating`（`:147`）、`processing`（`:457`）、`optimizing`（仅历史百分比分支）
同理永久卡死。建议回收列表改为**白名单化**：只保留已知「终态 + 等待态」，
其余一律视为「进行中」→ 回收。这比逐个补名单更抗未来新增状态。

> **给审核门的直接启示**：`awaiting_review` 是**合法的静息态**，
> 必须写进「不回收」白名单；而任何「因为异常而停在非终态」的任务都应被回收。
> 二者方向相反，不能只改一处。

---

## 5. 审核门的落地方式

### 5.1 两种实现路线

| | A. 挂起式（worker 阻塞等待） | **B. 落点式（推荐）** |
|---|---|---|
| 做法 | 图片生成后 worker 停在 `_waitUntilReviewed()` 轮询 | 图片生成后 `return`，`runningTasks.delete`，状态置 `awaiting_review`；确认后由新入口重新进入 |
| 复用现有机制 | 可复用 `_waitIfPaused` 的形状 | 需新增 `submitReview()` + 重新进入流水线 |
| 进程重启 | **任务丢**（内存轮询状态全丢） | 状态与图片都在磁盘，**可原样恢复** |
| 长时间不审（数天） | 必须挂着 worker / 定时器；30 分钟上限会杀掉（§4.2） | 无成本，不占任何资源 |
| 与 `runningTasks` 语义 | 冲突：任务「在运行」但其实没在跑，`startTask` 会拒绝（`pipeline.js:1025`） | 清晰：不在运行集合 |
| 实现复杂度 | 低 | 中（要处理「重新进入」的幂等与阶段复用） |
| 结论 | 否决 | **采用** |

**否决 A 的决定性理由**：A 需要把「等人」这件事塞进 `runningTasks` 语义里，
而 `runningTasks` 同时承担 ①防重入（`pipeline.js:1025`、`:861`）②并发控制 ③重启后清理的锚点
（`pipeline.js:1006`）。让一个「可能等 3 天」的状态住进去，等于把这三个语义全污染一遍。

### 5.2 落点式的具体做法（推荐方案骨架）

1. **图片阶段**（新步骤 `image_generation`）：
   - 调 `imageGen` 产出 N 张图 → 落 `app/clips/<taskId>_img_<i>.png`（运行时产物，不入库）；
   - 写 `task.review = { target:'images', state:'pending', images:[{index, path, prompt, provider}], requestedAt }`；
   - `recordStepComplete('image_generation', { status:'completed', ... })` ← **工作已完成**；
   - `updateTaskStatus(taskId, 'awaiting_review', { currentStep:'等待人工确认分镜图' })`；
   - `this.runningTasks.delete(taskId)` 后 **正常 return**（不是抛错）。
     ⚠️ 注意现有 `startTask` 的 `.finally()` 已经会 `delete`（`pipeline.js:1048-1050`），
     所以**只要 return 即可**，不要重复 delete。
2. **审核决策入口**（新）：`pipeline.submitReview(taskId, decision, opts)`
   - `approve` → 写 `review.state='approved'`，把 `image_generation` 保持 `completed`
     （或按选项 B 另立 `image_review` 步骤），然后 `startTask(taskId, { resumeInfo })` 从
     `clip_generation` 继续；
   - `reject` → 只重做被驳回的那几张（复用 `_nextClipPath` 的防覆盖思路，见 `pipeline.js:563`），
     重新回到 `awaiting_review`；
   - 幂等：同一 `reviewId` 重复提交返回 `alreadyResolved`，不重复扣费。
3. **重新进入时的复用**：`continueTask` 已有「按档位 + 已完成步骤算 pending」的能力
   （`pipeline.js:874-918`），审核通过后可直接复用这条路，**但必须加 §10.1 的守卫**。

### 5.3 为什么「图片一次生成完但不扣视频钱」是这次改造的核心价值

现状失败代价：片段生成失败要重试（真金白银，见 `pipeline.js:1758` 的 attempt 循环）。
审核门把「构图/风格不对」的返工从**视频层**提前到**图片层**，成本差一个量级。
**这是要写进产品说明的主要收益**（属推断，成本倍数需按各家价目表算）。

---

## 6. 暂停/恢复机制：保留现有语义，另立审核语义

**不要让一个按钮承担两种意思。** 建议三者并存、命名互不重叠：

| 能力 | 入口 | 状态 | 恢复方式 | 生命周期 |
|---|---|---|---|---|
| 生成中暂停 | `POST /:id/pause` / `unpause`（已有，`server.js:1540-1550`） | `paused` | 内存 Set | 重启即失效（§4.1 要修） |
| **图片审核** | `POST /:id/review`（新增） | `awaiting_review` | **持久化在 task.review** | 跨重启 |
| 断点补跑 | `POST /:id/continue`（已有，`server.js:1590`） | `pending`→… | 按档位算 pending | 跨重启 |

**必须新增的守卫**（不改会出错）：

- `continueTask` 开头（`pipeline.js:860` 之后、`:861` 之前）加：
  ```js
  if (task.status === 'awaiting_review') {
    return { success: false, error: '存在待审核的分镜图，请先确认或驳回后再补跑' };
  }
  ```
  否则用户在待审状态点「补跑」，会被 `:912` 直接把状态覆盖成 `pending`，
  **未经确认的图被当成已通过送去生成视频**（等于审核门形同虚设）。
- `startTask` 已有 `runningTasks` 防重入（`:1025`），无需改。
- `regenerateClip`（`:77-130`）与 `recheckClips`（`:776`）同理需要判断待审态
  —— 至少不能静默推进流水线（推断：具体行为待产品定，见 §14）。

---

## 7. 新增 WebSocket 事件

### 7.1 现状

`wsManager` 只有 4 种消息：`progress`（`:121`）、`clipUpdate`（`:146`）、
`statusChange`（`:166`）、`stepUpdate`（`:186`）。
`updateTaskStatus()` 会**自动**发 `progress` + `statusChange`（`taskManager.js:578-582`），
所以 `awaiting_review` 这个状态值会**自动**推给前端 —— 但**不带图片清单**，
前端收到后还是得再拉一次详情，且没法做「图片已就绪」的提示。

### 7.2 建议新增 2 个事件

| 事件 | 触发点 | 载荷 | 为什么不能用现有事件替代 |
|---|---|---|---|
| **`reviewRequired`** | 状态置 `awaiting_review` 之后 | `{ taskId, target:'images', reviewId, images:[{index, url, prompt}], clipCount, requestedAt }` | `statusChange` 只有 `status` + `extra`，塞图片清单会让它变成大对象；且前端要靠「有一个专门的待办事件」做提醒/红点 |
| **`reviewResolved`** | 审核通过/驳回落库之后 | `{ taskId, reviewId, decision:'approve'\|'reject', rejectedIndexes, resolvedAt }` | 同进程内多标签页需要同步；`statusChange` 到 `generating` 无法区分「审核通过」与「补跑」 |

**发送位置建议**：新增 `wsManager.broadcastReviewRequired()` / `broadcastReviewResolved()`，
并在 `pipeline.submitReview()` 与图片阶段收尾处显式调用
（**不要**塞进 `updateTaskStatus` 的通用路径 —— 那会让所有状态变更都背上 review 逻辑）。

### 7.3 断线兜底（必须）

WS 只在连接期间有效（`wsManager.js:117-118`：无订阅者直接 return）。
审核可能要等几小时，前端必然断过。因此：

- 必须提供 **`GET /api/tasks/:id/review`** 作为「拉取式真相源」；
- `GET /api/tasks/:id`（`server.js:1259`）与 `GET /api/tasks`（`:1224`）也应带上
  轻量字段 `reviewState`（`pending/approved/rejected/none`），供列表页显示红点
  —— 参照现有 `qcVersion/qcTrusted` 的做法（`server.js:1250-1251, 1237`）。
- **协议约定**：WS 事件是「提示」，HTTP 是「真相」。前端重连后必须先 `GET` 再信任。

---

## 8. 审核超时策略

### 8.1 建议：默认**不因超时改变任务状态**

理由（三条都成立）：

1. **语义**：AGENTS.md §4.1「`skipped` 永远不等于 `passed`」的精神同样适用于超时——
   「没人看」不等于「通过」。自动通过就是伪造审核结论（等同 §4.8）。
2. **业务**：目标用户 1–2 人，离线几小时到几天是常态（项目定位见 AGENTS.md §1）。
   因为下班就丢任务，用户会直接关掉这个功能。
3. **成本**：审核通过才生成视频，超时不生成**本来就不花钱**；
   自动放弃只带来「任务消失」的负体验，没有收益。

### 8.2 可选增强（需产品拍板，三者可叠加）

| 策略 | 行为 | 默认 |
|---|---|---|
| 静默保留（基线） | 状态永远停在 `awaiting_review`，无任何副作用 | **开** |
| 软提醒 | 超过 `REVIEW_REMIND_HOURS`（默认 24）时，下一次 WS 连接补发一次 `reviewRequired`（带 `reminded:true`） | 建议开 |
| 硬过期 | 超过 `REVIEW_TIMEOUT_HOURS`（默认 **0=不启用**）→ 状态转 `review_expired`（**新终态**），`recoverable:true`，可一键回到 `awaiting_review` 或直接补跑 | 默认关 |

**若采用硬过期，必须满足**：
- 终态名 **不能是 `failed`**（审核没失败，只是过期）也不能是 `completed`；
- 必须记 `reviewExpiredAt` + 原图保留（不删图，删了就没法续审）；
- `reconcileInterruptedTasks` 要认得 `review_expired`（不回收）。

### 8.3 配置位（沿用现有风格，`config.js:155-176`）

```js
REVIEW_ENABLED:            env('REVIEW_ENABLED', 'false'),   // 默认关，零回归
REVIEW_TIMEOUT_HOURS:      parseInt(env('REVIEW_TIMEOUT_HOURS', '0'), 10),   // 0=不过期
REVIEW_REMIND_HOURS:       parseInt(env('REVIEW_REMIND_HOURS', '24'), 10),
REVIEW_GROUP_BY_DEFAULT:   env('REVIEW_GROUP_BY_DEFAULT', 'true'),  // 整组确认 vs 逐张
```
> `REVIEW_ENABLED` 默认 `false` 是刻意的：与现有 `TRANSITION_ENABLED` 一样
> 「默认关闭 = 零回归」（AGENTS.md §6 已落地条目里同款做法）。
> 改配置项需同步 `.env.example`（§3 表格要求）。

---

## 9. 旧任务补跑「无图」的兜底

### 9.1 问题是什么（已核实，读码）

`resolveResume()` 有两条校验（`pipelineStages.js:250-269`）：

- **校验 1**：待跑步骤的依赖必须「已完成 或 也在待跑清单里」；
- **校验 2**：已完成步骤的依赖必须也已完成，否则报「状态矛盾」。

若把 `image_generation` 加进 `CORE_STAGES`（`pipelineStages.js:22`）并把
`clip_generation` 的依赖改成 `image_generation`（`:46`），那么**所有历史任务**都会：

- 校验 1 通过（`image_generation` 在 pending 里）；
- 但 `completed` 里没有 `image_generation`，而 `clip_generation` 在 `completed` 里
  → **触发校验 2，报「clip_generation 标记为已完成，但其依赖 image_generation 未完成（状态矛盾）」**
  → **所有旧任务都补跑不了**。

这是一个**必然发生**的回归，不是边缘情况。

### 9.2 三档兜底（建议同时用 1 和 2）

| # | 手段 | 做法 | 性质 |
|---|---|---|---|
| 1 | **按任务能力裁剪档位** | `resolveStages()` 之后加一步 `filterStagesByCapability(stages, task)`：任务没有 `image_generation` 步骤、或模型 `supportsImageInput !== true`、或 `IMAGE_GEN_*` 未配置 → 从 stages 里剔除 `image_generation`，`clip_generation` 依赖回落为 `storyboard` | 必需 |
| 2 | **依赖表按需解析** | `STAGE_DEPS` 从常量改为函数 `depsFor(stage, task)`，让 `clip_generation` 的依赖在「有图任务」时是 `image_generation`、在「无图任务」时是 `storyboard` | 必需（1 的底层支撑） |
| 3 | 显式升级路径 | 新增 `POST /:id/upgrade-to-i2v`：为旧任务补生成分镜图并进入审核；**只由用户主动点**，绝不自动 | 可选 |

**明确禁止的兜底**（都是红线）：
- ❌ 用一张占位图 / 纯色图当首帧送去生成（违反 §4.8「不许把占位当交付」）；
- ❌ 旧任务静默跳过审核并把 `image_generation` 标成 `completed`（违反 §4.1 语义）；
- ❌ 因为缺图直接把旧任务标 `failed`（历史任务本来没这个需求，不该被新功能判死）。

### 9.3 新旧任务的判定依据

不要靠「任务里有没有 `images` 字段」这类隐式判断，建议**显式落库**：
任务创建时写 `task.usesImageWorkflow = true|false`（`server.js:1103` 的 `POST /api/tasks`
解构里加字段，参照 `preset/stages` 的加法）。旧任务该字段缺失即视为 `false`。
> 注意历史教训：`POST /api/tasks` 的解构里**曾经漏了两个字段**导致前端传了被静默忽略
> （AGENTS.md §6「档位/补跑/质检角标的前端契约」）。新增字段要同步
> `scripts/verify-frontend-contract.js`（49 项）。

---

## 10. 对 `continueTask`、片段复用、档位依赖表的影响

### 10.1 `continueTask`（`pipeline.js:860-931`）

| 风险 | 具体位置 | 处置 |
|---|---|---|
| 待审状态被覆盖 | `:912` 无条件 `updateTaskStatus(taskId,'pending',…)` | **加守卫**（§6） |
| 审核未过就能补跑 | `:874-890` 只看 `completed` | 同上，靠状态守卫拦截 |
| 补跑把审核图丢掉 | `:904-918` 重建 `stageSet` | `image_generation` 只要在 `completed` 里就会被算进 `reused`（`:907`），图不会重做 —— **这是把 `image_generation` 在出图时就标 `completed` 的收益** |

### 10.2 `_completedSteps`（`pipeline.js:672-680`）

只认 `completed` / `reused`。因此：

- **出图即 `completed`** → 审核通过后补跑会复用图，不重做（正确、省钱）；
- 若把「审核通过」才标 `completed`，则在 `awaiting_review` 期间它不算完成，
  一旦用户点补跑（绕过守卫）就会**重新出图**（重复花钱）—— 这是反例，不要这么做。

### 10.3 档位与步骤表（`pipelineStages.js`）

- 新增阶段要动 4 处：`CORE_STAGES:22` / `ENHANCED_STAGES:25-31` / `ALL_STAGES:33` / `STAGE_DEPS:43-52`；
- 5 个预设（`:55-91`）里 `quick/daily/final/clips_only` 是否需要包含 `image_generation`
  **需产品定**（§14）。建议：`image_generation` 进 `CORE_STAGES` 的前提是「仅对有图任务生效」，
  否则 `clips_only` 等档位的行为会变。
- ⚠️ **顺序敏感**：`resolveStages` 用 `ALL_STAGES.filter(...)` 排序（`:197`），
  所以数组里 `image_generation` 必须放在 `storyboard` 之后、`clip_generation` 之前。

### 10.4 片段复用（`_batchGenerate`，`pipeline.js:1684-1748`）

- 复用判定只看 `clip.status === 'success'` + 文件存在（`:1695-1703`）；
- **不受审核门影响**（审核在片段生成之前）；
- 但审核通过后进入 `clip_generation` 时，`reusable` 集合里若有历史成功片段，
  会直接跳过生成 —— 与现状一致，符合「不重复花钱」的既有约定。

### 10.5 连带要改的契约（容易漏）

| 契约 | 位置 | 改动 |
|---|---|---|
| `PIPELINE_STEPS` | `taskManager.js:26-36` | 加 `image_generation`（含 `qcKey/qcName/category`） |
| 进度权重 | `taskManager.js:675-685` | 补新权重，并**保持总分=100** |
| `stepKeys` 返回值 | `taskManager.js:741` | 前端会拿到新 key → 前端必须兼容未知 key |
| 片段进度映射 | `taskManager.js:743-754` | 若要展示「图已生成/待审」，需加 `imagePath`/`imageState`（当前完全没有） |
| `GET /api/tasks` 列表字段 | `server.js:1238-1254` | 加 `reviewState` |
| 前端静态断言 | `public/index.html` 相关 5 个脚本 | 见 §13 |

---

## 11. API 契约草案（待评审，未实现）

```
POST /api/tasks
  body 新增: usesImageWorkflow?: boolean        // 缺省 false = 旧链路
  响应不变

GET  /api/tasks/:id/review
  200 { taskId, reviewId, state:'pending'|'approved'|'rejected',
        target:'images', requestedAt, decidedAt, rejectReason,
        images:[{ index, url, prompt, width, height, provider, model }] }
  404 任务不存在 / 409 该任务没有审核门

POST /api/tasks/:id/review
  body { decision:'approve'|'reject',
         rejectedIndexes?: number[],            // reject 时必填，空数组=全部重做
         reasons?: { [index]: string },
         runtimeConfig?: object }               // 与 continue 一致的 Key 透传约定
  200 { success:true, state:'approved'|'rejected', queued:['clip_generation'] }
  400 决策非法 / 当前不在 awaiting_review
  409 已处理过（幂等：返回 alreadyResolved:true）

POST /api/tasks/:id/clips/:index/image/regenerate   // 单张重做（可选）
  body { prompt?, runtimeConfig? }
  注：与现有 /clips/:index/regenerate（server.js:1566）路径不冲突

GET  /api/tasks/:id                                 // 加字段
  + reviewState: 'none'|'pending'|'approved'|'rejected'
```

**Key 透传约定必须沿用**：审核后继续生成仍需要 Key，而 Key 落盘会被 `redact` 清空
（`taskManager.js:66-71` 注释、`pipeline.js:867-872`）。
所以 `POST /review` 必须接受 `runtimeConfig` 并走 `_mergeRuntimeConfig`（`pipeline.js:576`）。
**漏掉这一步 = 审核通过后静默降级 Mock**（同类事故已记录于 AGENTS.md §6）。

---

## 12. 存储与静态目录

| 项 | 建议 | 理由 |
|---|---|---|
| 图片落盘位置 | `app/clips/<taskId>_img_<i>.png` | 复用现有运行时目录（AGENTS.md §3：`app/clips/**` = 运行时产物，不入库）；且 `/clips` 已是**免登录静态目录**（AGENTS.md §2.7）→ 图天然有 HTTP URL |
| 文件命名防覆盖 | 参照 `_nextClipPath()`（`pipeline.js:563-575`）加 `_vK` 后缀 | 事故背景：重新生成曾覆盖已付费产物（AGENTS.md §6 已落地条目） |
| 是否入库 | 图片路径写进 `task.review.images[].path`，**不写进片段库** | 片段库是视频资产（`library.ingestClip`），图不是交付物 |
| 清理 | 任务删除时随 `data/trash/` 一起回收（`server.js:1656-1678`） | 与现有删除/回收站语义保持一致 |

> ⚠️ **安全提示**：`/clips` 免登录（`AGENTS.md §2.7`「公网部署时必须补」）。
> 分镜图放在这里，等于**免登录可访问**。若服务公网可达，图片会被人直接拉走。
> 这条同时是 §R1 的机会（图有公网 URL，可喂给要求 URL 的厂商）和风险（泄露）。
> **必须由产品决定：图片走「公网可读」还是「签名临时 URL」。**

---

## 13. 需新增的验收用例清单

> 现有相关脚本：`scripts/verify-pipeline-fixes.js`（28 项，含僵尸回收，见 `:98-134`）、
> `scripts/verify-continue.js`（19 项）、`scripts/verify-frontend-contract.js`（49 项）、
> `scripts/verify-stages.js`、`scripts/verify-stage-pipeline.js`（37 项）。
> **不得删断言**；改这些脚本必须同步扩测（任务说明明确要求）。

### 13.1 `verify-review-gate.js`（新增，建议 ≥ 20 项）

| # | 用例 | 类型 | 断言 |
|---|---|---|---|
| 1 | 有图任务跑到审核点 | 正向 | `task.status === 'awaiting_review'` |
| 2 | 审核点不占运行集合 | 正向 | `pipeline.runningTasks.has(taskId) === false` |
| 3 | 审核点不被当成僵尸 | **关键** | 调 `reconcileInterruptedTasks()` 后状态**仍是** `awaiting_review`，且不在返回值里 |
| 4 | 审核中重启仿真 | 正向 | `pausedTasks.clear()` + reconcile → 仍可 `submitReview` 成功（状态/图片来自磁盘） |
| 5 | approve 后继续 | 正向 | 状态进入 `generating`，且 `steps.image_generation.status === 'completed'` |
| 6 | approve 不重做图 | 正向 | 图片文件 **mtime 未变**（参照 `verify-continue` 的 mtime 断言思路） |
| 7 | reject 单张只重做该张 | 正向 | 其余图 mtime 不变，被驳回那张 mtime 更新 |
| 8 | reject 后仍在待审 | 正向 | 状态回到 `awaiting_review`，`review.state==='pending'` |
| 9 | 重复提交幂等 | 负向 | 第二次 `POST /review` 返回 `alreadyResolved`，**不重复触发流水线** |
| 10 | 无审核门任务调 review | 负向 | 返回 409/400，**不改变任何状态** |
| 11 | 待审态调 continue | **负向（核心）** | 返回 `success:false`，状态**保持** `awaiting_review`（验证 §6 守卫真的生效） |
| 12 | 待审态调 startTask | 负向 | 被拒或幂等，不产生第二次生成 |
| 13 | 图片生成失败 | 负向 | `image_generation` 标 `failed`，任务 `failed`，**不进入** `awaiting_review`（不能拿失败当待审） |
| 14 | 图片生成失败不产假图 | 负向 | `imageGen` 抛错路径下 `clips/` 无新文件（对应 `imageGen.js:104-117` 的显式失败语义） |
| 15 | 旧任务补跑（无 image_generation） | 负向（回归） | `POST /:id/continue` **不得**报「状态矛盾」，且**不新增** `image_generation` 步骤 |
| 16 | 无图模型不允许走审核门 | 负向 | `supportsImageInput !== true` 时档位被裁剪，不出现 `awaiting_review` |
| 17 | `REVIEW_ENABLED=false` | 回归 | 全流程与改造前完全一致（**零回归红线**） |
| 18 | 审核超时 0 配置 | 正向 | 长时间（用假时钟/手动改 `requestedAt`）不改变状态 |
| 19 | 静态断言：状态常量集中 | 静态 | 用正则断言 `pipeline.js` 里 `IN_PROGRESS` **不含** `awaiting_review`，且存在 `awaiting_review` 的保留分支 |
| 20 | 静态断言：WS 事件已注册 | 静态 | `wsManager.js` 存在 `broadcastReviewRequired` / `broadcastReviewResolved` |

### 13.2 必须同步扩测的既有脚本

| 脚本 | 扩什么 |
|---|---|
| `verify-pipeline-fixes.js`（28 项） | ① 加 `awaiting_review` 不被回收的正向用例；② 加 `paused` 被回收的新用例（修 §4.1 后）；③ 原「mixing 回收」用例必须仍通过（负向保护） |
| `verify-continue.js`（19 项） | 加「待审态 continue 被拒」；加「旧任务无图补跑不报状态矛盾」 |
| `verify-frontend-contract.js`（49 项） | 新字段 `usesImageWorkflow` / `reviewState` / `stepKeys` 变化 |
| `verify-stages.js` / `verify-stage-pipeline.js` | 新阶段在档位里的裁剪逻辑 |
| `verify-all.js` | 注册新脚本（`scripts/verify-all.js` 的 registry，现有 16 项 `name/script` 对） |

### 13.3 三态结论模板（交付时必须填）

| 用例组 | 通过 | 不通过 | 未验证 |
|---|---|---|---|
| 审核门正向（1–8） | | | |
| 审核门负向（9–16） | | | |
| 零回归（17–18） | | | |
| 静态断言（19–20） | | | |

---

## 14. 需产品先定的事（**不定就无法开工**）

| # | 决策点 | 选项 | 研发倾向 | 影响面 |
|---|---|---|---|---|
| D1 | **整组确认 vs 逐张确认** | A 整组一次过 / B 逐张 / C 整组+可挑单张驳回 | **C**（匹配 1 人操作，且不牺牲返工精度） | 审核 API 的 `rejectedIndexes` 设计与 UI |
| D2 | **驳回后回到哪** | A 只重做该图 / B 从分镜重来 / C 从提示词重来 | **A**（最省钱；B/C 留作显式按钮） | 阶段回退逻辑、`_completedSteps` 语义 |
| D3 | **审核超时** | A 永久等待（默认） / B 提醒 / C 硬过期 | **A+B，默认不硬过期** | §8 |
| D4 | **哪些档位包含审核门** | quick 也审？还是只有 final 审？ | 待定（需产品按使用场景定） | `PRESETS`、`verify-stage-pipeline` |
| D5 | **旧任务是否强制升级** | A 不升级（默认） / B 手动按钮 / C 全部强制 | **A**（不要动历史任务） | §9 |
| D6 | **分镜图是否公网可读** | A 复用 `/clips` 免登录 / B 加签名 / C 只走 base64 厂商 | **B**（安全）或 **C**（最简单） | §12 + `i2v-capability.md` R1 |
| D7 | **图片生成厂商用哪家** | 阿里 wan/Qwen-Image / OpenAI / 其他 | 待定 | `IMAGE_GEN_*`、图片规格是否满足各厂商要求 |
| D8 | **审核是否要留痕（谁审的）** | 单人不留痕 / 记 `decidedBy` | 记（成本极低，未来有用） | `task.review.decidedBy` |

---

## 15. 实施顺序建议（依赖关系）

```
① 修状态机缺陷（§4.1 paused 回收、§4.2 静默丢弃、§4.3 白名单化）
      └─ 扩测 verify-pipeline-fixes.js（不得删原断言）
② 接入图片生成（imageGen 真实现）+ 图片落盘
      └─ 新增 verify-image-gen.js
③ 加 image_generation 步骤 + 档位裁剪（§9.2 手段 1/2）
      └─ 改 pipelineStages / taskManager，扩测 stages 类脚本
④ 加 awaiting_review 状态 + reconcile 保留分支（§5.2）
      └─ **本方案的成败点**，必须先有 ③ 的步骤存在
⑤ 加 submitReview + 3 个 API + 2 个 WS 事件
      └─ verify-review-gate.js
⑥ 加 continueTask 守卫 + 旧任务兜底回归
      └─ 扩测 verify-continue.js
⑦ 前端（UI 负责）
```

**为什么 ① 必须在 ④ 之前**：审核门的核心风险不是「加不出来」，
而是「加了之后重启会丢」。若不先把回收逻辑改成白名单化，
新增一个「看起来像进行中」的状态就必然踩同一个坑一次。

---

## 16. 风险清单

| # | 风险 | 严重度 | 说明与缓解 |
|---|---|---|---|
| R1 | 审核中重启丢任务 | **致命** | 若忘记把 `awaiting_review` 排除出 `IN_PROGRESS`（`pipeline.js:988`），用户在审核页刷新/服务重启后任务变 `failed`，图片与审核成果全部作废。**缓解：用例 3/4 作为门禁，未通过不得合入** |
| R2 | 未经审核就生成视频（扣钱） | 高 | `continueTask` 无守卫（§6）→ 待审态点补跑会被 `:912` 覆盖状态。**缓解：用例 11** |
| R3 | 旧任务全部补跑失效 | 高 | `resolveResume` 校验 2 误判「状态矛盾」（§9.1）。**缓解：用例 15 + 手段 1/2** |
| R4 | 审核通过后静默降级 Mock | 中高 | `POST /review` 若不接受 `runtimeConfig`，Key 已被 `redact` 清空（`pipeline.js:867-872` 的既有坑）。**缓解：契约里强制带，用例检查 `mockFallback` 未出现** |
| R5 | 分镜图免登录可被拉走 | 中 | `/clips` 免登录（`AGENTS.md §2.7`）。**缓解：D6 决策** |
| R6 | 前端因 `stepKeys` 变化挂掉 | 中 | `taskManager.js:741` 会多返回一个 key。**缓解：前端必须容错未知 key；扩测 contract 脚本** |
| R7 | 进度条卡在 99% | 低 | `taskManager.js:735` 本就 `Math.min(99, …)`；待审态百分比不会到 100，属预期但要写进 UI 文案 |
| R8 | 图片 URL 时效不够（跨天审核） | 中 | 见 `i2v-capability.md` R2。**缓解：审核通过后再上传/签名，不要提前上传** |

---

## 17. 本文档的证据边界

- 所有 **文件:行** 均基于 2026-10-26 的仓库快照（`git -C app log -1` = `7901300`），
  工作区当时有未提交改动（`.env.example`、`config.js`、`src/generators/index.js`、新增 `imageGen.js`），
  **行号以该快照为准，后续改动可能偏移**。
- 本期**未运行任何验收脚本**（本机 spawn EPERM 必失败），
  所以所有「行为结论」都是**静态读码推断**，标记为「已核实」仅表示代码字面成立。
- 本文**不含**任何已实现的改动：`app/**` 未被写入，仅新增本文件。

---

# 附录：「静帧审核门 + 语义连续性」合并方案（2026-10-27，**只设计不实现**）

> 触发：接缝实测（`docs/spec/seam-quality-spec.md`）证明——用户说的"衔接不自然"
> **主要是内容/语义跳变**，而拼接层无解：淡化只是把跳变摊成"糊"，
> 硬切又太生硬。真正的抓手在**生成层**：让相邻镜头语义连续。
> 用户已同意把「语义连续性」与「先图后视频（人工审核门）」**合并成一次改造**。

## 附录-0 关键修正（推翻本文正文的一个前提）

**审核门的对象是「静帧之间的缝」，不是「视频段之间的缝」。**

本文正文（§3 流转图）默认审核的是"每个片段一张静帧"，但没讲清审核**在判什么**。
按接缝实测的结论，审核页真正要回答的问题是：

> 这 N 张静帧**彼此之间**是否构成一条连续的镜头序列？

三条理由（缺一不可）：

1. **静帧连续 ⇒ 视频连续**。图生视频的语义锚点是首帧——首帧的构图、色调、主体位置
   直接决定整段视频的基调。若相邻静帧是同场景延续，成片接缝即使硬切也不刺眼
   （实测正对照：`task_mvglbfkw_w5vg` 缝 #1 硬切但两段几乎相同，SSIM 0.908、ΔE76 0.21，观感无碍）。
2. **静帧在视频之前产生，此时还没花钱**。生成一段 5s 视频的成本比生成一张静帧高
   1~2 个数量级（各家按秒计价）；在静帧阶段拦下不连续，比在视频阶段重生成便宜得多。
   这正是审核门存在的全部经济意义。
3. **视频级检测保留为兜底，但不能当主闸**。首帧相同不代表运动一致（运镜、主体动作仍是
   模型自由发挥），所以 `checkSeam` 的视频级检测**不删**，继续在终检里兜底。

## 附录-1 静帧连续性用什么度量（复用 `checkSeam` 的口径，去掉不适用的部分）

| 指标 | 视频缝（已实现） | 静帧缝（本方案） | 说明 |
|---|---|---|---|
| SSIM 结构相似度 | ✅ | ✅ 直接用 | 判"构图/景物是否突变" |
| ΔE76 平均色差 | ✅ | ✅ 直接用 | 判"整体偏色"，静帧无运动干扰，比视频更准 |
| ΔY 平均亮度差 | ✅ | ✅ 直接用 | 判"明暗突变"（如上一张是夜景、下一张是正午） |
| MAD 像素级倍数 | ✅（÷同段基线） | ❌ **不适用** | 静帧没有"帧间自然运动"基线，倍数无意义；改用下一条 |
| SE 接缝能量 | ✅（时间轴） | ❌ 不适用 | 同上，需要连续帧序列 |
| **静帧对相似度分布**（新） | — | ✅ | 取同批 N 张静帧两两相似度，算出「本次的连续性基线」；
单道缝若显著低于该批中位数 → 标"疑似不连续" |

**产出**：每对相邻静帧一个 `seamScore`，审核页按分数**倒序**把最可能不连续的几张置顶，
让人先看最该看的地方（而不是让用户逐张肉眼比对 N 张图）。

**与视频缝的关系**：量纲一致（同用 SSIM + ΔE76 + ΔY），所以阈值可以共用一套，
但**静帧应更严**（推断）：静帧是"设计稿"，此时改成本最低；建议静帧阈值取视频阈值的
0.7 倍左右（即 SSIM ≥ 0.85、ΔE76 ≤ 17），具体值需实测校准后再定。

## 附录-2 两者共用哪些改动（合并改造的收益所在）

| 共用改动 | 语义连续性需要它 | 审核门需要它 | 复用点 |
|---|---|---|---|
| **`pipelineStages` 新增 `image_generation` 阶段** | ✅ 静帧是连续的载体 | ✅ 静帧是审核对象 | 同一批静帧，一处产出两处用 |
| **首帧参数（i2v 的 `first_frame`）** | ✅ 让视频继承静帧的构图/色调 | ✅ 审核通过后按静帧生成 | 同一个 `clip.firstFrameImage` 字段 |
| **`task.review` 数据结构** | ✅ 记录"连续性判定"结论 | ✅ 记录审核决策 | 同一个对象挂 `continuity` 与 `decision` |
| **静帧落盘与预览 URL** | ✅ 需要能看图 | ✅ 需要能看图 | 同一批文件（`app/clips/<taskId>_img_<i>.png`） |
| **`checkSeam` 的度量函数** | ✅ SSIM/ΔE76/ΔY 直接复用 | ✅ 审核页旁提供数值佐证 | 抽成共享函数，避免两套实现漂移 |
| **档位裁剪（§9.2 的无图任务兜底）** | ✅ 旧任务无静帧 | ✅ 旧任务无审核 | 同一处 `filterStagesByCapability()` |

**这意味着：语义连续性几乎是审核门的"免费副产品"**——不需要额外的阶段、额外的图片、
额外的存储，只需要在审核页上把"连续性数值"与图片一起展示，并按分数排序。

## 附录-3 数据结构（合并后的形状，与正文 §11 的 API 草案一致）

```js
task.review = {
  target: 'images',
  state: 'pending' | 'approved' | 'rejected',
  images: [
    {
      index: 0,
      path: 'clips/<taskId>_img_0.png',
      url: '/clips/<taskId>_img_0.png',
      prompt: '…',            // 该镜头的分镜提示词
      provider: '…', model: '…',
      // ↓ 语义连续性：与「上一张」之间的缝（第一张为 null）
      continuity: {
        toPrev: {
          ssim: 0.91, de76: 3.2, dy: 1.1,
          batchMedianSsim: 0.93,        // 本批静帧两两相似度的中位数
          verdict: 'ok' | 'suspect' | 'jump',
          measuredAt: '…'
        }
      }
    }
  ],
  // 审核决策（单人操作、无审批流，见正文 §14 D1/D8）
  decidedAt, decidedBy, rejectReason, rejectedIndexes: []
}
```

`clip.firstFrameImage` 存"审核通过的那张静帧路径"，`clip_generation` 时作为 i2v 的
`first_frame`（各厂商字段名不同，见 `docs/spec/i2v-capability.md`），
**不复制图片**，只存路径，避免同一张图两份。

## 附录-4 分期（与正文 §15 实施顺序的关系）

| 阶段 | 内容 | 与本文正文的差异 |
|---|---|---|
| ① | 修状态机缺陷（正文 §4.1/§4.2 已列） | 不变，**必须先做** |
| ② | 图片生成 + 静帧落盘 | 不变 |
| ③ | `image_generation` 阶段 + 档位裁剪 | 不变 |
| ④ | **静帧连续性度量**（附录-1） | **新增**：比审核门早做，成本极低（纯计算，无新依赖） |
| ⑤ | `awaiting_review` 状态 + `submitReview` + WS 事件 | 不变 |
| ⑥ | 审核通过后按静帧走 i2v（首帧参数） | **新增**：依赖 ① 的 i2v 能力核查结论 |
| ⑦ | 前端审核页（图片 + 连续性分数 + 整组/逐张） | UI 负责 |

**顺序上的关键点**：④ 早于 ⑤。因为连续性分数决定了审核页怎么排、用户先看哪张；
若先做 ⑤ 再补 ④，审核页要返工一次。

## 附录-5 风险与未决

| # | 项 | 状态 |
|---|---|---|
| 1 | 静帧阈值（SSIM ≥ 0.85 / ΔE76 ≤ 17）是**推断值**，需真实静帧样本校准 | **未验证** |
| 2 | 首帧一致 ≠ 运动一致（运镜/主体动作仍由模型决定），视频级 `checkSeam` 必须保留 | 已明确（本文） |
| 3 | 4 张静帧的"整组确认 vs 逐张"仍未定（正文 §14 D1） | 待产品 |
| 4 | 静帧是否公网可读（影响能否直接喂 i2v 厂商，见 `i2v-capability.md` R1） | 待产品 |
| 5 | 静帧连续性计算放在"生成完立即算"还是"审核页打开时算" | 建议立即算（结果可落库、可排序） |
| 6 | 本期**未实现任何代码**；本文只是设计 | 已声明 |
