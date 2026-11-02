# NSFW 合规检测接入规格

> 交付方：研发（dev-engineer） · 任务：t2 · 日期：2026-10-18
> 状态：**代码已实现并通过自测（无 Key 分支全绿）；有 Key 的真实判定为「未验证」**（当前 `.env` 的 `OPENAI_API_KEY` 为空）。

---

## 1. 为什么要有这一项

`docs/requirements/项目需求申报表.md` 对外承诺了「NSFW 置信度阈值 0.8」作为合规红线，但 `src/qualityChecker.js` 的质检项里原本**完全没有 NSFW**。
这是「文档承诺 vs 代码缺失」，属于合规风险最高的一项。本次把承诺落成代码。

---

## 2. 判定语义（与 `checkContentMatch` 的关键差异）

| 场景 | `checkContentMatch`（业务参考项） | `checkNSFW`（合规红线项） |
|---|---|---|
| 无 LLM Key | `skipped`，不阻塞流程 | **`passed:false`** + `detectorUnavailable:true` |
| FFmpeg 不可用 | `skipped` | **`passed:false`** + `detectorUnavailable:true` |
| 调用失败 / 超时 / 非 2xx | `skipped` | **`passed:false`** |
| 返回无法解析 | `skipped` | **`passed:false`** |
| 抽帧不完整 | `skipped` | **`passed:false`** |

一句话：**`checkContentMatch` 是「测不到就当参考」，`checkNSFW` 是「测不到就是没过」。**
这里不存在任何 `passed || skipped` 式的放行路径——那是历史上被修过一次的缺陷（见 `changelog.md`），不许退回。

另外 `checkNSFW` 的返回体**不设 `skipped` 字段**，只有 `passed:false`，避免下游任何按 `skipped` 分支的代码误判为「可跳过」。

---

## 3. 抽帧策略

| 参数 | 值 | 说明 |
|---|---|---|
| `NSFW_FRAMES_PER_MINUTE` | 1 | 每分钟 1 帧 |
| `NSFW_MAX_FRAMES` | 30 | 上限，控制 token 预算（30 分钟成片也只要 30 帧） |
| `NSFW_MIN_FRAME_GAP` | 0.5s | 相邻采样点最小间隔，避免重复帧 |
| 不足 1 分钟的样片 | 抽 2 帧 | 1 帧覆盖不了整段内容 |

实测（用 `_buildNSFWFramePlan` 对合成时长求计划帧数）：

| 成片时长 | 计划帧数 | 首点 | 末点 |
|---|---|---|---|
| 59s | 2 | 0.50 | — |
| 10min（600s） | 10 | ≈0.50 | ≈599.5 |
| 30min（1800s） | 30（封顶） | ≈0.50 | ≈1799.5 |
| 90min（5400s） | 30（封顶） | ≈0.50 | ≈5399.5 |

真实样片 `output/task_mv4v7qp2_m8r0_final.mp4`（实测时长 35.04s）：计划 2 帧 → 实际抽帧 2 帧 → 送入模型 2 帧，与计划一致。

### 关键帧吸附（踩过的坑）

`-ss 0.5` 这种定位落在第一个关键帧之前时，ffmpeg 会 seek 到「上一个关键帧」。本样片首个关键帧在 35.04s（即片尾），
于是抽帧命令**空输出**（退出码仍为 0）。实测 `-ss 0.500` 走 `_exec` 原始路径返回 0 字节。
因此抽样点向内收至 `[edge, duration-edge]`（`edge = min(0.5, duration×5%)`），并把失败抽帧按「抽帧不完整」判 fail，而不是当成「没内容=安全」。

---

## 4. 阈值与配置

- 代码默认 **0.8**，读 `config.QC.nsfwThreshold`
- `.env` 用 **`QC_NSFW_THRESHOLD`** 覆盖（已补进 `.env.example`）
- 同时保留了 `config.QUALITY_CHECK.nsfwThreshold` 这个既有读法，两处同源
- 非法值（非数字 / 负数 / >1）回退 0.8，并在启动时打印警告
- 配置在 `require` 时求值，**改 `.env` 需重启进程**

实测：

```
QC_NSFW_THRESHOLD 未设置  -> QUALITY_CHECK.nsfwThreshold = 0.8 | QC.nsfwThreshold = 0.8
QC_NSFW_THRESHOLD=0.65   -> QUALITY_CHECK.nsfwThreshold = 0.65 | QC.nsfwThreshold = 0.65
QC_NSFW_THRESHOLD=abc    -> [config] QC_NSFW_THRESHOLD="abc" 非法（需 0~1 之间的数），已回退默认 0.8
```

判定规则：**`score >= threshold` 即判不合规**（达到即失败，不是超过才失败）。
另加一条从严策略：模型自报 `nsfw:true` 但分数低于阈值时，仍判 fail，避免「分数与结论自相矛盾」时被放行。

---

## 5. 代码位置

| 位置 | 内容 |
|---|---|
| `src/qualityChecker.js` `QC_ITEMS` | 新增 `{ key: 'nsfw', name: 'NSFW合规检测', category: 'clip' }`，质检项从 10 项变 11 项 |
| `src/qualityChecker.js` `checkNSFW(videoPath, options)` | 主实现，约 100 行 |
| `src/qualityChecker.js` `_buildNSFWFramePlan` | 抽帧计划（每分钟 1 帧 / 上限 30 / 关键帧吸附） |
| `src/qualityChecker.js` `_extractFramesAtTimes` | 按时间点抽帧 |
| `src/qualityChecker.js` `_execRawBuffer` | `_exec()` 的二进制版本（JPEG 不能走 utf8 解码） |
| `src/qualityChecker.js` `_callNsfwMultimodal` | NSFW 专用 prompt，**不复用** `_callMultimodal` |
| `src/qualityChecker.js` `_parseNsfwVerdict` | 解析 `{nsfw, score, reason, frames}` |
| `src/qualityChecker.js` `checkClip` / `checkFinal` | 接入 nsfw 项，新增 `options` 透传参数 |
| `config.js` | 新增 `QC.nsfwThreshold` + `nsfwThreshold()` 解析函数，`QUALITY_CHECK.nsfwThreshold` 改为读同一函数 |
| `.env.example` | 新增 `QC_NSFW_THRESHOLD=0.8` 及说明 |

`checkContentMatch` / `_callMultimodal` / `_parseVerdict` / `_extractFramesBase64` **一行未改**（diff 中只有新增行提及它们）。

---

## 6. 调用建议（给 pipeline）

`checkClip` 与 `checkFinal` 新增了第三/第二参数 `options`，可直接把任务级运行时配置传进来：

```js
const qc = await qualityChecker.checkClip(videoPath, task.clipDuration, {
  apiKey: rc.multimodalApiKey || rc.llmApiKey,
  baseUrl: rc.multimodalBaseUrl || rc.llmBaseUrl,
  model: rc.multimodalModel || rc.llmModel
});
```

不传则回退到 `config.OPENAI_*`（即 `.env`）。

> ⚠️ 待产品/研发共同决策：`pipeline.js` 目前的视觉质检在 **Mock 模式**下会整体跳过（合成画面必然不符提示词）。
> NSFW 是合规项，**Mock 模式下也应执行**（合成画面天然安全，真实调用可以顺利通过，不需要仿 skip）。
> 但本次任务范围不含 `pipeline.js`，故未改动——这是下一步接入时要落实的点。

---

## 7. 自测

```powershell
cd app
node scripts/verify-nsfw.js                       # 用默认样片
node scripts/verify-nsfw.js output/xxx_final.mp4  # 指定样片
node scripts/check-encoding.js src/qualityChecker.js  # 编码完整性
```

`verify-nsfw.js` 用注入的 `fetchImpl` 覆盖全部判定分支（不联网、不需要真实 Key），当前 **42 项全部通过**：

- 无 Key / HTTP 500 / 网络异常 / 超时 / 非 JSON / 空 content / 分数越界 → 全部 `passed:false`
- score 0.12 / 0.79 → pass；**0.80 → fail**；0.95 → fail
- 模型 `nsfw:true` + score 0.1 → 从严 fail
- 阈值调到 0.5 后 score 0.6 → fail，返回体带出 `threshold:0.5`
- 抽帧：真实样片 2 帧；30min→30 帧封顶；10min→10 帧；59s→2 帧；90min→30 帧；`maxFrames:5`→5 帧
- 汇总：无 Key 时 `checkClip` / `checkFinal` 整体不通过，`totalChecks=5`

---

## 8. 未验证 / 遗留

| 项 | 状态 | 说明 |
|---|---|---|
| 有 Key 时的真实判定 | **未验证** | `.env` 的 `OPENAI_API_KEY` 为空。需填入支持图像输入的模型后实测 |
| 真实多模态模型对「安全画面」给多少分 | **未验证** | 若某模型习惯输出 0.9 的保守分数，0.8 阈值会误杀全部成片，届时需按实测分布调整 `QC_NSFW_THRESHOLD` |
| `pipeline.js` 接入 | 未做 | 不在本次范围。`checkClip`/`checkFinal` 默认读 `.env`，所以 Key 一旦填上，片段质检就会自动带上 NSFW；Mock 模式跳过视觉质检的逻辑在 pipeline 内部 |
| 60s 内样片的帧数 | 已定 | 抽 2 帧（首尾），严格讲低于「每分钟 1 帧」，但 1 帧无法覆盖整段，取 2 帧更保守 |
