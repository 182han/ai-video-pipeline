# 前端集成契约：档位选择 / 补跑 / 质检可信度角标

> 面向：UI 角色（`public/index.html` 的实现者）。
> 来源：研发侧三个后端能力已落地并经过真机验收，本文是**唯一的接口契约**。
> 最后实测：2026-10-19。凡本文与 API 实际返回不符，以实际返回为准并立即修订本文。

---

## 0. 三个功能分别解决什么问题

| 功能 | 解决什么 | 用户能感知到什么 |
|---|---|---|
| **档位选择** | 现在不管要不要配乐、要不要循环，都跑满 8 步 | 新建任务时可选「快速验证」先看风格对不对，便宜且快 |
| **补跑** | 之前选 quick 就到此为止，想升级只能重跑整条（重花钱） | 快速验证满意后点「补成最终成片」，**片段不重新生成** |
| **质检可信度** | 2026-10-18 之前入库的质检结论是伪造 pass | 历史任务显示「历史未验证」角标，不再冒充「通过」 |

---

## 1. 档位选择

### 1.1 创建任务时传 `preset`

`POST /api/tasks` 的请求体新增两个**可选**字段：

```json
{
  "prompt": "极光下的雪山",
  "model": "dashscope",
  "totalClips": 6,
  "preset": "quick",
  "stages": ["concatenation", "audio_mix"]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `preset` | string | `quick` / `daily` / `final` / `clips_only` / `custom`。**不传 = `final`（全量 8 步，与旧行为完全一致）** |
| `stages` | string[] | 仅 `preset: "custom"` 时有意义，列出要执行的步骤 |

**实测透传结果**（2026-10-19）：

| 传入 | 任务 `preset` | `stageSet` 步骤数 |
|---|---|---|
| `quick` | quick | 4 |
| `clips_only` | clips_only | 3 |
| `final` | final | 8 |
| 不传 | final | 8 |

> 修前这里**静默忽略 preset**（永远 8 步）。若你发现档位不生效，先确认后端已更新。

### 1.2 五个档位

| preset | 名称 | 包含环节 |
|---|---|---|
| `quick` | 快速验证 | 提示词优化、分镜、片段生成、拼接 |
| `daily` | 日常交付 | 上者 + 循环 + 转码 + 配乐 |
| `final` | 最终成片 | 全部 8 步（含终检） |
| `clips_only` | 片段包 | 仅核心链 3 步，**不产出成片** |
| `custom` | 自定义 | 按 `stages` 勾选，依赖会自动补齐 |

**依赖会自动补齐**，前端不必自己算。例：只勾 `audio_mix` 时，后端会自动补上
`transcoding`（配乐需要母版）→ `concatenation` → 核心链 3 步。补了什么会在
`stagePlan.notes` 里说明。

### 1.3 任务对象上的字段

```json
{
  "taskId": "task_xxx",
  "preset": "quick",
  "stageSet": { "prompt_optimize": true, "storyboard": true, "clip_generation": true, "concatenation": true },
  "stagePlan": { "stages": ["prompt_optimize", "..."], "notes": ["..."] },
  "fragmentOnly": false,
  "fragmentCount": null
}
```

- `stageSet` **只列出要执行的步骤**，未列入的是 `undefined`（不是 `false`）。
  前端判断用 `stageSet[key] === true`。
- `fragmentOnly: true` 表示这是**片段包**（`clips_only` 档），`outputPath` 为 `null`，
  不要显示「播放成片」按钮。

### 1.4 步骤状态取值

任务详情 `steps[key].status` 可能是：

| status | 含义 | UI 建议 |
|---|---|---|
| `pending` | 未开始 | 灰色 |
| `in_progress` | 进行中 | 转圈 |
| `completed` | 跑过并通过 | ✅ 绿 |
| `partial` | 部分成功（片段有失败） | ⚠️ 黄 |
| `failed` | 失败 | ❌ 红 |
| **`skipped`** | **档位不含此环节**，从未执行 | 灰色 + 「按档位跳过」 |
| **`reused`** | **之前已完成，本次补跑直接复用** | 蓝色 + 「已复用」 |

`skipped` 的 `qcDetails.reason` 形如「档位「quick」未包含此环节，按计划跳过」。
`reused` 的 `qcDetails.reason` 形如「该环节在之前的运行中已完成，本次补跑直接复用已有产物」。

> **`skipped` 与 `completed` 必须在视觉上区分开**——这是 §4.1 的要求，跳过不等于通过。

---

## 2. 补跑

### 2.1 预览：还需要跑哪些

```http
GET /api/tasks/:id/continue-plan?preset=final
```

响应（只读，不改任务状态）：

```json
{
  "ok": true,
  "preset": "final",
  "stages": ["prompt_optimize", "... 共 8 项"],
  "pending": ["loop_processing", "audio_mix", "transcoding", "final_qc"],
  "reused": ["prompt_optimize", "storyboard", "clip_generation", "concatenation"],
  "autoAdded": [],
  "coreForced": [],
  "notes": ["复用已完成步骤 4 个，需补跑 4 个：..."],
  "completed": ["prompt_optimize", "storyboard", "clip_generation", "concatenation"],
  "currentPreset": "quick"
}
```

| 字段 | 用途 |
|---|---|
| `pending` | 本次要跑的步骤 → 展示为「将补跑：循环、配乐、转码、终检」 |
| `reused` | 复用的步骤 → 展示为「复用已有：片段、拼接…（不重新生成，不额外花费）」 |
| `notes` | 人类可读说明，可直接展示 |
| `ok: false` | 链路不完整（见 2.4），展示 `error` |

任务不存在 → **HTTP 404**。

### 2.2 触发补跑

```http
POST /api/tasks/:id/continue
Content-Type: application/json

{ "preset": "final" }
```

成功（HTTP 200）：

```json
{
  "success": true,
  "taskId": "task_xxx",
  "pending": ["loop_processing", "audio_mix", "transcoding", "final_qc"],
  "reused": ["prompt_optimize", "storyboard", "clip_generation", "concatenation"],
  "resume": { "...": "完整 plan" },
  "message": "正在补跑 4 个环节"
}
```

全部已完成时（幂等）：

```json
{ "success": true, "alreadyDone": true, "message": "档位「final」的步骤均已完成，无需补跑" }
```

### 2.3 补跑进行中的表现

补跑开始后任务 `status` 会从 `completed` **切回 `pending`**，随后正常推进
（`generating` / `looping` / …）。前端轮询按常规任务处理即可。

进度推送仍走原有 WebSocket（`wsManager.broadcastStepUpdate`），无需新通道。

### 2.4 失败情形（都要展示 `error`）

| 情形 | HTTP | error 示例 |
|---|---|---|
| 非法档位 | 400 | `未知档位 "bogus"（可用: quick, daily, final, clips_only, custom）` |
| 任务不存在 | 400 | `任务不存在` |
| 任务正在运行 | 400 | `任务正在运行中，请稍后再试` |
| 补跑链路不完整 | 400 | `补跑链路不完整：transcoding 标记为已完成，但其依赖 concatenation 未完成（状态矛盾）。…` |
| 缺拼接产物 | 400 | `补跑需要拼接产物，但拼接尚未完成；请先跑完到拼接步骤` |

> 「状态矛盾」是刻意设计的：声称某步完成、但其上游从未完成时，产物来源不明，
> 在其上继续补跑等于把坏产物当真。此时应提示用户「重新跑该任务」而不是补跑。

### 2.5 UI 建议

任务详情页，当 `currentPreset !== 'final'` 且任务已完成时，显示：

```
当前档位：快速验证（4/8 步）
[补成最终成片]  ← 点击先 GET continue-plan 预览，确认后再 POST continue
```

确认弹窗展示：`notes` 文案 + 「片段不会重新生成」提示。

---

## 3. 质检可信度角标

### 3.1 详情接口

```http
GET /api/tasks/:id
```

新增字段：

```json
{
  "qcVersion": 2,
  "qcTrusted": true,
  "qcVersionSource": "finalQC",
  "finalQC": { "passed": true, "qcVersion": 2, "qcTrusted": true, "qcLabel": "verified" },
  "clips": [
    { "qcResult": { "passed": true, "qcVersion": 2, "qcTrusted": true, "qcLabel": "verified" } }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `qcVersion` | 2+ = 修复后真实执行；`null`/1 = 历史未验证 |
| `qcTrusted` | 布尔，等价于 `qcVersion >= 2` |
| `qcVersionSource` | `task`（任务行本身有版本）/ `finalQC`（回退自终检）/ `null`（完全未知） |
| `qcLabel` | `verified` / `legacy_unverified`，**UI 直接读这个** |

> **`passed` 字段保持原值不变**。历史任务可能 `passed: true` 但 `qcLabel: 'legacy_unverified'`，
> 意思是「当时记了通过，但那次检测其实没真跑」。**不要只信 `passed`**。

### 3.2 列表接口

```http
GET /api/tasks
```

列表项新增精简字段（不含完整 `finalQC`，体积考虑）：

```json
{ "taskId": "...", "qcVersion": 2, "qcTrusted": true, "preset": "final", "fragmentOnly": false }
```

### 3.3 实测数据（真实库）

| 任务 | qcVersion | qcTrusted | source |
|---|---|---|---|
| `task_mv4v7qp2_m8r0` | 2 | true | finalQC |
| `task_mukptvrj_xbjn` | 2 | true | finalQC |
| 其余历史任务 | null | false | null |

### 3.4 UI 建议

- `qcLabel === 'verified'` → 不显示角标，或显示淡绿「已核验」
- `qcLabel === 'legacy_unverified'` → **黄色角标「历史未验证」**，
  tooltip：「该结论产生于质检修复之前，未真实执行检测，不能当作通过」
- 列表页可用 `qcTrusted === false` 加小圆点
- **不要因为 `qcLabel` 是历史未验证就隐藏成片**——片本身可能是好的，只是质检结论不可信

---

## 4. 边界与注意事项

1. **`stageSet` 未列入的步骤是 `undefined` 不是 `false`**。判断必须 `=== true`。
   （研发侧踩过：写成 `!== false` 导致 quick 档 8 步全跑。）
2. **`clips_only` 档的 `outputPath` 是 `null`**，不要渲染播放器。
3. **补跑时第 1、2 步（提示词优化/分镜）仍会重新执行**——它们不花生成费，只是重算文本。
   若用户手动改过某片段提示词，补跑会被重新优化覆盖。UI 可考虑提示这一点。
4. **不要在前端计算 pending/reused**，一律用 `continue-plan` 的返回值，避免与后端规则漂移。
5. 所有新字段都是**向后兼容的新增**，旧前端不改也不会崩。

---

## 5. 相关验收脚本（研发侧已通过）

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `scripts/verify-stages.js` | 档位/依赖/补跑计算（纯函数） | 45/0 |
| `scripts/verify-stage-pipeline.js` | 真机跑三条任务验证档位生效 | 37/0 |
| `scripts/verify-continue.js` | 真机验证补跑不重生成片段 | 19/0 |
| `scripts/verify-qc-annotation.js` | 标注语义 + 起临时服务实测 API | 32/0 |

UI 实现后，建议按 §5.4 分角色验收：**在浏览器里实际操作一遍三个功能并截图/录屏**。
