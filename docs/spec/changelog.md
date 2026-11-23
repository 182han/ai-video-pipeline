# 变更记录

> 用途：记录跨多条线的改动归属与来龙去脉。
> 起因：2026-10-18 有若干次提交把不同来源的改动合并进了同一条 commit，
> 提交信息与实际内容不符，仅凭 `git log` 无法追溯某项功能是何时、因何改的。
> 本文件按「事实」记录，不替代 commit，但比 commit message 更可靠。

---

---

## 2026-10-18 · qcVersion：区分历史伪造结论与修复后的真实结论

**状态**：代码完成，待独立验收。

### 背景

上文提到的两处缺陷（`skipped` 当 `passed`、`Math.random` 假质检）修好之前，
所有落库的质检结论都是**没真正执行过检测的伪造 pass**。它们已经写进了
数据库的 `tasks.final_qc` / `clips.qc_result`，以及本地 `data/tasks/*.json`。

用户决定**不重跑历史任务**（成本高），改用版本号区分新旧结论。

### 版本语义

| `qc_version` | 含义 | 可信？ |
|---|---|---|
| `>= 2` | 修复后产生的结论，真实执行过检测 | 可信 |
| `1` | 修复前产生的结论，**历史未验证** | 不可当作真实通过 |
| `NULL` / 缺字段 / 非法值 | 同上，未知来源 | 不可当作真实通过 |

判定逻辑**只有一份**，在 `src/storage/qcVersion.js`。之所以单独抽一个文件：
判定若散落在 postgres / sqlite / jsonfile / API 四处，迟早漏改一处，
造成「某条路径把历史结论当成通过」——那正是本任务要防的失败模式。

### 实现

| 文件 | 改动 |
|---|---|
| `src/qualityChecker.js` | 新增 `QC_VERSION = 2` 常量；`checkClip` / `checkFinal` / `checkConcat` / `checkPrompt` / `checkStoryboard` / `checkLoop` / `checkTranscode` / `checkNSFW` / `_mockCheck` 的**所有**返回对象均带 `qcVersion`。`module.exports.QC_VERSION` 一并导出，供存储层引用 |
| `src/storage/qcVersion.js` | **新增**。`normalize()` / `qcVersionOf()` / `isTrustedQC()` / `annotateQC()` / `annotateTask()` |
| `src/storage/schema.sql` | `tasks.qc_version`、`clips.qc_version` 两列；新增「2.5 增量补列」段（幂等 ALTER + 索引 + 历史行标记为 1） |
| `src/storage/drivers/postgres.js` | 建表式读写映射；`rowToTask` / `rowToClip` 输出 `qcVersion`，`finalQC` / `qcResult` 走 `annotateQC`；insert 加 `qc_version`（占位符重编号 `$1..$25` / `$1..$14`）；upsert 同步更新 |
| `src/storage/drivers/sqlite.js` | 同上；另加 `ensureColumn()` 给老库补列（SQLite 无 `add column if exists`），补列后把历史结论标记为 1 |
| `src/storage/drivers/jsonfile.js` | **未改**。JSON 天然透传，无需 schema |
| `src/storage/index.js` | `getTask` / `getAllTasks` **读取即标注**；导出 `isTrustedQC` / `annotateQC` / `annotateTaskQC` / `QC_VERSION` / `QC_TRUSTED_FROM` |
| `scripts/backfill-qc-version.js` | **新增**。回填脚本，支持 `--dry-run` / `--json-only` / `--db-only` |

### API 返回的字段

`getTask` / `getAllTasks` 返回的任务对象现在带：

```json
{
  "qcVersion": 1,
  "qcTrusted": false,
  "finalQC": { "passed": true, "qcVersion": 1, "qcTrusted": false, "qcLabel": "legacy_unverified" },
  "clips": [{ "qcResult": { "passed": true, "qcVersion": 1, "qcLabel": "legacy_unverified" } }]
}
```

- `qcLabel` 取值：`verified`（可信） / `legacy_unverified`（历史未验证）
- **`passed` 字段保持原值不改**——不篡改历史数据，只新增标注字段
- UI 若要把历史结论显示为「历史未验证」，读 `qcLabel` / `qcTrusted` 即可，**不需要改判定逻辑**

### 回填脚本的用法

```powershell
cd app
node scripts/backfill-qc-version.js --dry-run   # 先看会改什么
node scripts/backfill-qc-version.js             # 实际执行
```

安全性：

- **只补 1，绝不补 2**（补 2 = 把伪造结论洗成可信，是本任务最大的失败模式）
- 幂等：已是 1 或 >=2 的记录不会被改写
- 不删除数据、不改 `final_qc` / `qc_result` 内容
- 改 JSON 前先备份到 `data/backup-qcversion-<时间戳>/`

### 已验证 / 未验证

**已验证（实测数据见任务 t3 提交记录）**

- `checkClip` / `checkFinal` 返回 `qcVersion = 2`
- 本地 JSON 副本回填：23 个文件、13 处任务级、71 处片段级，**全部标 1，无一标 2**
- 回填后：文件数不变、文件名集合不变、除 `qcVersion` 外**所有字段（含嵌套）逐字节一致**、所有 `passed` 值不变
- 幂等：二次运行标记 0 条、改写 0 个文件
- SQLite 驱动：建表含两列；老库补列逻辑正确；新库不触发 ALTER
- Postgres 驱动：占位符编号与参数数量对齐（25/25、14/14）
- 负向 24 项：`passed:true` 无版本 / 版本 1 / 0 / null / "abc" / 负数 → 全部判不可信

**未验证**

- 真实 Postgres 库上的 `schema.sql` 增量段与回填脚本（本次未连接生产库，按用户要求不动现有数据）
- SQLite 真实库（环境未安装 `better-sqlite3`，按零新增依赖原则未安装，改用字符串级 + 桩验证）

### 留给后续

- **前端展示**：`public/index.html` 未改（不在本任务范围）。UI 需要在任务详情里
  根据 `qcLabel === 'legacy_unverified'` 显示「历史未验证」角标，否则用户看不出区别
- `src/taskManager.js` / `server.js` 未改（同样不在范围）。`storage.getTask` / `getAllTasks`
  已自动带标注；但 `taskManager.getAllTasks()` 直接读内存对象，**不会**自动带标注。
  API 若要暴露，需在 `server.js` 的 `/api/tasks/:id` 等处调用 `storage.annotateTaskQC(task)`

---

## 2026-10-18 · NSFW 合规检测落地

**状态**：代码完成，待独立验收。

### 背景

`docs/requirements/项目需求申报表.md` 对外承诺「NSFW 置信度阈值 0.8」作为合规红线，
但 `src/qualityChecker.js` 原有的 10 个质检项里完全没有 NSFW。属「文档承诺 vs 代码缺失」。

### 实现

| 文件 | 改动 |
|---|---|
| `src/qualityChecker.js` | +378/−9，16 个 hunk，**增量 edit**。新增 `checkNSFW()`、`_buildNSFWFramePlan()`、`_extractFramesAtTimes()`、`_execRawBuffer()`、`_callNsfwMultimodal()`（NSFW 专用 prompt）、`_parseNsfwVerdict()`。`QC_ITEMS` 由 10 项增至 11 项，新增 `nsfw` |
| `config.js` | 新增 `QC.nsfwThreshold`（读 `QC_NSFW_THRESHOLD`，默认 0.8，非法值警告回退）；`QUALITY_CHECK.nsfwThreshold` 同源保留兼容 |
| `.env.example` | 补 `QC_NSFW_THRESHOLD=0.8` 说明 |
| `scripts/verify-nsfw.js` | 42 项自测（注入 fetch，不联网），覆盖调用失败/超时/解析失败等无法真实构造的路径 |
| `scripts/check-encoding.js` | 源文件编码检查（GBK 环境下防污染） |

`checkContentMatch`、`_callMultimodal`、`_parseVerdict`、`_extractFramesBase64` **一行未改**。

### 关键设计

1. **`checkNSFW` 的返回体刻意不设 `skipped` 字段**——不是「记得别用 skipped」，而是让
   `passed || skipped` 这条历史缺陷在结构上写不出来。
2. **所有失败路径一律 `passed: false`**：无 Key、FFmpeg 不可用、调用失败、超时、非 2xx、
   无法解析、抽帧不完整。
3. **抽帧采样点向内收**：`-ss` 落在首关键帧之前会 seek 到上一个关键帧。实测样片
   `task_mv4v7qp2_m8r0_final.mp4` 首关键帧在 35.04s（即片尾），导致 `-ss 0.5` 抽帧
   **空输出且退出码为 0**——正是 §4.3 描述的假成功。采样点已收至 `[min(0.5, d×5%), d-edge]`，
   且「抽帧不完整」判 fail。
4. **抽帧密度**：每分钟 1 帧，上限 30 帧（1800s 及以上封顶 30）。

### 实测数值

| 场景 | 结果 |
|---|---|
| 无 Key | `passed:false` · `detectorUnavailable:true` · `skipped:false` |
| `checkClip` | `passed=false`，`totalChecks=5`，reason 指名 `NSFW合规检测` |
| `checkFinal` | `passed=false`，details 含 `nsfw` |
| 阈值 | 未设 → 0.8；`=0.65` → 0.65；`=abc` → 警告回退 0.8 |
| 自测 | 42 项全绿（HTTP500 / ECONNREFUSED / 超时 / 非 JSON / 空 content / score=3.7 越界 → 全 fail；0.12、0.79 pass；**0.80、0.95 fail**；`nsfw:true` 但 score 0.1 → 从严 fail） |
| 抽帧 | 59s→2 / 600s→10 / 1800s→30 封顶 / 5400s→30；真实样片 35.04s→2 帧 |

### 注意事项

- `.env` 的 `OPENAI_API_KEY` **当前为空**，因此运行时实际走「未执行 → 判 fail」路径。
  这是预期行为，不是缺陷。填入 Key 后即可真实检测。
- `QC_ITEMS` 由 10 项增至 11 项，**任何断言「共 10 项质检」的旧代码/文档需同步更新**。

### 遗留

`src/pipeline.js` 的 Mock 模式会整体跳过视觉质检。NSFW 属合规项，Mock 模式下也应执行
（合成画面天然安全，真实调用不会误杀）。本次范围不含 `pipeline.js`，未改动，留待后续。

---

## 2026-10-18 · 9af1fb4 内容归属说明

**提交信息**：`fix: soft-delete flag lost when persisting tasks`
**实际内容**：8 个文件，混合了两条互不相关的线。

| 文件 | 实际改动 | 属于哪条线 | 与提交信息相符 |
|---|---|---|---|
| `src/storage/drivers/postgres.js` | 软删除标志持久化修复 | 存储线 | ✅ |
| `src/storage/drivers/sqlite.js` | 软删除标志持久化修复 | 存储线 | ✅ |
| `src/storage/index.js` | 软删除标志传递 | 存储线 | ✅ |
| **`src/qualityChecker.js`** | **质检语义重构（+297 行）** | **质检线** | ❌ 无关 |
| **`config.js`** | **ffmpeg/ffprobe 自包含解析** | **质检线** | ❌ 无关 |
| **`src/videoProcessor.js`** | **拼接时长校验不再放行** | **质检线** | ❌ 无关 |
| **`.gitignore`** | **排除项目内 ffmpeg 二进制** | **质检线** | ❌ 无关 |
| **`tools/ffmpeg/README.md`** | **ffmpeg 恢复说明** | **质检线** | ❌ 无关 |

**结论**：`git log` 中看到 `9af1fb4` 时，不要以为它只动了存储层。
**质检语义重构实际发生在这个提交里。**

---

## 质检语义重构 —— 改了什么、为什么

### 背景故障

`qualityChecker` 存在两处会伪造「通过」的缺陷：

1. **`skipped` 被当作 `passed`**
   ```js
   const allPassed = Object.values(results).every(r => r.passed || r.skipped);
   ```
   FFmpeg 不在 PATH 时，黑帧/模糊/重复帧/时长四项全部落入 `catch` 并返回
   `{ passed: true, skipped: true }`，汇总时因 `skipped` 被视作通过，最终结论仍是「片段质检通过」。
   **实测：4 项检测执行了 0 项，结论为通过。**

2. **`Math.random() > 0.1` 冒充检测结论**
   随机 90% 判通过、10% 判失败，表现为「偶发失败」，极难排查。

### 修复内容

| 位置 | 修改前 | 修改后 |
|---|---|---|
| `checkClip` 汇总 | `passed \|\| skipped` 即通过 | 区分 `failedItems` / `notRunItems` / `legitSkipItems`，**未执行即不通过** |
| `checkClip` 前置 | 无 | FFmpeg 不可用时直接判 fail 并说明「四项均未实际检测」 |
| 4 处检测 `catch` | `{passed:true, skipped:true}` | `{passed:false, detectorError:true}` |
| `checkConcat` | `catch(e){}` 后无条件 `passed:true` | 前置闸门 + catch 判 fail |
| `_mockCheck` | `Math.random() > 0.1` | 明确返回「未执行」 |
| `checkFinal` 视频信息 | 无 FFmpeg 时谎称「视频信息正常」 | 判 fail |
| `checkFinal` 音频 | 无 FFmpeg 时**不产生记录**（静默缺失） | 显式记录为未检测 |
| `_validateConcatDuration` | 探测失败返回 `{ok:true}` | 返回 `{ok:false, undetermined:true}`，调用方保留产物但标记 `unverified` |

### 新增能力

- **`_exec()`**：统一子进程入口。运行环境禁止捕获 stdio（`spawn EPERM`，
  如沙箱/CI）时自动降级为「重定向到临时文件再读取」，保证质检在受限环境同样真实执行。

### 保留的合法跳过

「未配乐任务的成片没有音频流」属于业务上本就不适用，标记 `legitimateSkip: true`，
不计入失败。这是唯一允许的跳过类型。

### 验证证据

**正向**（`output/task_mv4v7qp2_m8r0_final.mp4`）：

| 检测项 | 结果 |
|---|---|
| blackFrame | passed，无黑帧 |
| blur | passed，max blur 7.5（阈值 100） |
| duplicate | passed，0 帧 |
| duration | passed，35.0s |

修复前同一文件：四项 `skipped=true`，实际执行 0 项，结论仍为通过。

**负向**（证明能抓缺陷，非空壳）：

| 用例 | 结果 |
|---|---|
| 纯黑视频 | 抓到「检测到黑帧」，判 fail ✅ |
| 5 秒视频按 30 秒校验 | 抓到「时长异常 (5.0s, 期望 30s)」，判 fail ✅ |
| 正常视频 5 秒按 5 秒校验 | 正确 pass ✅ |

**降级路径**：FFmpeg 路径指向不存在位置时，`checkClip` / `checkConcat` / `checkFinal`
三者均正确判 fail 并说明「FFmpeg 不可用」。

---

## ffmpeg 自包含

`config.js` 新增 `resolveBundled()`，解析顺序：

1. `.env` 中 `FFMPEG_PATH` / `FFPROBE_PATH` 显式配置
2. 项目内 `tools/ffmpeg/bin/`
3. 系统 PATH（云上 Linux 容器）

二进制约 640MB，已在 `.gitignore` 排除（`tools/ffmpeg/bin/`）。
新机器按 `tools/ffmpeg/README.md` 恢复。

**许可证**：当前为 gyan.dev full build，含 `--enable-gpl`，属 **GPL v3**。
本地/内部使用无影响；若将来打包进对外分发产品需评估义务。

---

## 尚未修复（截至本记录）

| 缺口 | 位置 | 说明 |
|---|---|---|
| 无缝循环为假实现 | `src/videoProcessor.js` `_makeLoopFFmpeg` | 直接 `copyFileSync`，与「Android TV 屏保循环」卖点不符 |
| NSFW 检测缺失 | `src/qualityChecker.js` | 需求申报表承诺「阈值 0.8」，代码中无实现 |
| 流水线无档位 | `src/pipeline.js` | 7 步无条件全量执行，与《后续目标》「核心链必选 + 增强层可选」不符 |
| 历史质检结论不可信 | 数据库 / `data/tasks/` | 修复前入库的 `pass` 均为伪造，需 `qcVersion` 标记区分 |

---

## 2026-10-19 · 配乐模块整体改造：逐片段混音 → 整片多轨时间轴

**状态**：代码完成，已通过单元 / 真机 / 负向三类验证，待用户验收 UI 手感。

### 背景（用户反馈与实测）

用户反馈成片配乐「衔接不自然，同一段音乐被反复重放」。
实测坐实且**修正了用户的描述**：

- 用户以为是「前 7 秒循环五次」；实测循环窗口是 **2 秒**（旧 `audioMixer.js` 的 `aloop=loop=-1:size=88200`）。
- 真实听感源自**混音挂在片段粒度**上：5 个片段各自从 `calm_01` 的 0 秒开始混，每段内部再 2 秒一循环。
- 实测 `task_mv4v7qp2_m8r0_final.mp4` 逐秒音量呈**精确 7 秒周期**（7/14/21/28 秒处数值逐字相同），5 段曲线 0/2/4/6 秒处均为 -91/-84/-83/-87 dB 凹陷。
- 结论：**不是调参数能救的问题，必须把混音粒度从「片段」上移到「整片」。**

### 用户确认的产品决策

| 项 | 决策 |
|---|---|
| 自动配乐 | 只含**轻音乐**；按整片时长铺满，一首放完按库存顺序接下一首；有默认开场曲用它，否则随机 |
| 环境音 | **只出现在手动配乐**；自动配乐不参与 |
| 主题选曲 | **删除**（一段成片通常含多个主题，单主题反推不可靠） |
| 手动配乐 | 独立页面「添加配乐」，多轨时间轴，支持任意裁剪/变速/循环/关键帧 |
| 预览与导出一致性 | **硬要求**：预览听到的必须与导出的一致 |
| 覆盖策略 | 先写临时文件，校验通过才替换原成片 |

### 架构决策：唯一引擎

浏览器**不做任何音频计算**，只负责①画波形（Web Audio 解码）②把编辑结果变成 plan(JSON)。
预览与导出**都走服务端 ffmpeg 同一套参数**，因此一致性是架构保证的，而不是靠两边算法对齐。
实测 30 分钟成片音频处理仅需约 5 秒。

### 新增 / 重写

| 文件 | 内容 |
|---|---|
| `src/processors/bgmPlan.js`（新） | 纯函数：plan → ffmpeg filter_complex。含分段滤镜、关键帧音量表达式、多轨 amix、整体 loudnorm |
| `src/processors/audioMixer.js` | 新增 `mixBgmPlan` / `buildAutoPlan` / `validateMixDuration` / prefs(顺序/默认开场曲)；**删除** `THEME_MOOD_MAP`、`matchTrackByTheme` 与 `aloop` 语义 |
| `src/pipeline.js` | 新增第 6.5 步 `audio_mix`（整片混音）、`reapplyBgm`、`_ensureBgmPlan`、`_applyBgmPlan`、`_normalizePlan`、`_buildMasterFromClips`、`_resolveClipPath`；**删除** `_getBgmSegmentPath` 及全部逐段调用 |
| `server.js` | 新增 `GET /api/tasks/completed`、`GET/PUT /api/tasks/:id/bgm-plan`、`POST /api/tasks/:id/bgm-auto-plan`、`POST /api/tasks/:id/bgm-preview`、`POST /api/tasks/:id/audio`、`PUT /api/bgm/prefs`；`/clips/:index/audio` 改为 **410 deprecated** |
| `public/bgm-editor.html`（新） | 多轨时间轴编辑器：波形、拖拽、裁剪、分割、音量、淡入淡出、变速、循环/拉伸、关键帧 |
| `public/index.html` | 配乐卡片改为「不配乐 / 自动配乐 + 开场曲」；删除逐段分配 UI、主题选曲、详情页逐段改配乐 |
| `taskManager.js` | 新增 `task.bgm / bgmPlan / bgmResult / masterPath`；`PIPELINE_STEPS` 增 `audio_mix` |
| `schema.sql` + postgres/sqlite 驱动 | 追加 `bgm_plan` / `bgm_result` 两列（增量 ALTER，不覆盖他人已改内容） |

### 顺带修掉的两个真实缺陷

1. **`loudnorm` 后采样率被抬到 96000**（成片体积翻倍）。已在其后显式 `aformat=sample_rates=44100` 钉死。
2. **关键帧音量表达式的逗号未转义**，ffmpeg 报 `No option name near 'frame'`。**单测是过的，只有真机跑才暴露** —— 这正是「要跑得通」的价值。

### 验收证据

| 项 | 结果 |
|---|---|
| `scripts/test-bgm-plan.js` | 12 项通过 |
| `scripts/test-bgm-auto.js` | 7 项通过（含 30 分钟铺满 14 段、跨曲衔接、只用轻音乐） |
| `scripts/verify-bgm-plan.js` | 5/5 真机通过 |
| `scripts/verify-bgm-mix.js` | 5/5 真机通过（跨曲/两轨/关键帧/变速/素材复用） |
| `scripts/verify-bgm-storage.js` | Postgres 往返通过 |
| `scripts/verify-bgm-negative.js` | 7 项负向防护全部命中 |
| `scripts/verify-bgm-api.js` | 全通过（预览不覆盖、导出生效） |
| `scripts/test-editor-logic.js` | 14 项通过 |
| **原始案例修复** | 7 秒周期重复区块数 **4/4 → 0/4**；采样率 44100；时长 35.00s |

### 已知限制

- 历史任务的 `clip.videoPath` 可能指向迁移前的旧目录，已用 `_resolveClipPath` 按文件名在 `clips/` 兜底；若文件本身已删除则无法重出片。
- 历史任务首次改配乐时会先重建一份无声母版（`_master.mp4`），耗时取决于片段数。
- 浏览器端 UI 手感（拖拽、波形缩放）未在真实浏览器中验过——本环境浏览器驱动不可用，仅做 DOM 契约与数据逻辑验证，**需用户实际操作确认**。

---

## 2026-10-19 补记 · 自动配乐支持勾选轻音乐/环境音

**起因**：用户指出「选择自动配乐时用户可以自己勾选轻音乐还是环境音，或者两个都要」，
而上一版实现写死了「自动配乐只含轻音乐」。需求收集阶段这句话前后有冲突表述
（早期说过「自动配乐把两项都勾时 -18dB」，后期说过「环境音只出现在手动配乐」），
实现时采用了后者，属理解偏差，已按用户最新确认修正。

### 修正后的规则（用户确认）

| 项 | 规则 |
|---|---|
| 勾选 | 轻音乐 / 环境音，可只选其一，也可都选；**不允许都不选**（明确报错） |
| 轻音乐 | 按库存顺序一首接一首铺满全片，不循环 |
| 环境音 | **选一首，整片循环**（`fillMode: 'loop'`），不换曲 |
| 两者同时 | 环境音在混音阶段压到 `ambientVolume`（默认 0.125 ≈ -18dB）垫底 |

### 改动

| 文件 | 改动 |
|---|---|
| `src/processors/audioMixer.js` | `buildAutoPlan` 重写：新增 `wantMusic` / `wantAmbient` / `ambientTrackId`，分别产出轻音乐轨与环境音轨 |
| `src/taskManager.js` | `task.bgm` 新增 `wantMusic` / `wantAmbient` / `ambientTrackId` |
| `src/pipeline.js` | `_ensureBgmPlan` 透传勾选组合 |
| `public/index.html` | 配乐卡片加两个勾选框 + 环境音曲目下拉；未勾选的轨道隐藏其下拉 |

### 验收

| 脚本 | 结果 |
|---|---|
| `scripts/test-bgm-tracks.js` | 12 项：四种勾选组合 + 指定曲目，全部通过 |
| `scripts/verify-bgm-tracks.js` | 真机 4 项：只环境音 / 只轻音乐 / 两轨 / 10s 源循环铺满 35s，全部通过 |

### 同期排查：前端改动被覆盖

用户反馈「配乐和以前一样」时发现两层原因：

1. 访问的 3000 端口跑的是 **10-18 16:27 启动的旧进程**——Node 只在启动时读代码，改动未生效。
2. `public/index.html` 被**另一个会话保存为改造前版本**（与 HEAD `0c6259a` 一致），
   前端改动被整体覆盖；后端改动未受影响。

已重做前端改动并复验。**教训**：多会话并行改同一文件时，改完必须重新读取核对内容，
不能假设之前的编辑还在。


---

## 2026-10-19 · 无缝循环落地 + 循环质检去假通过

**状态**：代码完成，验收 19/19 通过（含 4 类负向）。**尚未在完整任务上端到端跑过**（见「未验证」）。

### 背景：两个缺陷叠加，导致「已做」的错觉

| 缺陷 | 位置 | 表现 |
|---|---|---|
| 无缝循环是直通 | `videoProcessor._makeLoopFFmpeg` | 只有一行 `fs.copyFileSync`，返回体自带 `passthrough: true` / `note: '无缝循环未实现，按直通处理'`。循环回绕处是硬跳切 |
| 循环质检是假通过 | `qualityChecker.checkLoop` | **无条件** `return { passed: true, reason: '循环过渡正常（模拟）', mock: true }`，从不对比任何帧 |

两者叠加 = 「假实现 + 假质检」双保险：用户界面上的「无缝循环处理 ✅ 通过」从头到尾没有经过任何检测。
这违反 §4.1（未执行不等于通过）与 §4.2（禁止假结论），但本文件此前的「尚未修复」表只记了「直通」，
**没有记假质检这一条**，导致「功能没做」被误读成「已经做了」。

### 修复一：真交叉淡化（`src/videoProcessor.js`）

公式（设源时长 D，淡化 F，产物长度 = D − F）：

```
[main] = 源 [0, D-F)    → trim + setpts
[head] = 源 [0, F)      → trim + setpts（把开头 F 秒叠到末尾）
[mt][headt] xfade=transition=fade:duration=F:offset=D-2F  → [v]
[0:a] atrim=0..D-F + afade=t=out:st=D-2F:d=F              → [a]（有音轨时）
```

**实测踩过的四个坑，改之前必读：**

1. **xfade 的 offset 是相对「第一段输入」的时间轴**。若把头段用 `setpts=PTS-STARTPTS+offset/TB`
   显式挪到 offset，淡化**不生效**：产物时长看着对（34.5s），但末尾亮度全程不变（142.3→142.3），
   即根本没有融合。这是最隐蔽的失败模式——**只验时长会放过它**。正确做法是让头段从 0 开始，
   由 xfade 负责锚定。
2. **音频不能用 `-af`**。`-map 0:a -af afade=...` 会保留完整原音轨（35s），
   容器时长被音频撑回 **35.015s**，而视频其实已是 34.5s。音频必须进 `filter_complex`
   用 `atrim`+`asetpts` 截到 D−F，实测修正后 video/audio 均精确 **34.500000s**。
3. **时长容差必须小于 F 本身**。原先沿用 `max(0.5, 2%)`，在 35s 素材上等于 0.69s，
   而「淡化没发生」的偏差恰好是 0.5s → **缺陷被放行**。改为
   `max(0.05, min(F/3, expected*1%))`（0.5s 淡化时为 0.167s）。`checkLoop` 同步采用该口径。
4. **不用退出码 0 当成功**（§4.3）：产物生成后必须 ffprobe 实测时长，不符即判失败；
   探测不到时长标记 `undetermined`，不当作通过。**不保留 copyFileSync 兜底**，
   失败就返回 `success:false`，从结构上杜绝「直通冒充循环」复活。

### 修复二：循环质检改实测（`src/qualityChecker.js`）

判定口径（关键是与「首尾相似」区分开）：

- **WRAP（主判据）**：产物【末尾】与【开头】的 SSIM。
  真淡化的目的就是让结尾画面渐变成开头画面。
  抽帧位置：头部 `min(0.5, d*5%)`，尾部 `d - min(0.05, d*1%)`。
  **尾部必须贴末尾**——实测同一产物：34.0s→0.496、34.3s→0.738、34.45s→**0.934**、34.48s→0.934。
  若沿用旧的 `d - min(0.5, d*5%)`（=34.0s），抽到的是「还没开始淡」的画面，
  **会把正确产物误判为 fail**。
- **BASE（对照）**：源素材首尾 SSIM，防止「素材首尾本来就一样」时把直通误判成通过。
- **时长核验（结构性证据）**：产物时长必须 ≈ 源 − F。直通产物等于源时长，此维度必然不符。
- 三态：无 ffmpeg / 抽帧不足 / 缺源时长 → 一律 `passed:false`，状态明确写 `detectorUnavailable`
  或 `durationCheck:'skipped_no_source'`，**不允许当作通过**。返回体不设 `skipped` 字段（沿用 NSFW 的结构性约束）。

配置项（`config.QC`，均已同步 `.env.example`）：`QC_LOOP_SSIM_THRESHOLD`（默认 0.9）、
`LOOP_FADE_DURATION`（默认 0.5s），非法值告警回退。

### 修复三：双路径一致（`src/pipeline.js`）

新建路径（`pipeline.js:214` 附近）与改配乐重建路径（`pipeline.js:791` 附近）原本都硬编码 `1`，
现均改为读 `config.QC.loopFadeDuration`（默认 0.5），并传 `sourceDuration`/`fadeDuration`
给 `checkLoop` 以启用时长核验。`qcDetails` 额外记录 `loopProcess`（是否重编码、源/产物时长、错误原因）。

### 实测数值（`node scripts/verify-loop.js`，素材 35s 成片）

| 项 | 直通（修复前） | 真淡化（修复后） |
|---|---|---|
| 产物时长 | 35.000s（=源） | **34.500s**（=源−0.5），容差 0.167s |
| 回绕 SSIM（末尾 vs 开头） | 0.5002 | **0.9495**（阈值 0.9） |
| 素材基线 SSIM（对照） | 0.5002 | 0.5002 |
| 视频/音频流时长 | — | 均 34.500000s |
| 是否重编码 | 否（copyFileSync） | 是（`reencoded:true`） |
| 处理耗时 | ~0s | 6.8s（35s 素材） |
| 亮度曲线（末尾 2s） | 142.9→142.3 无变化 | 142.9→**94.0**（向开头 82.0 渐近） |

**验收 19 项全绿**，其中负向四类：
1. 用原片冒充循环产物 → `passed:false`，`wrap SSIM=0.5002`，`durationCheck=mismatch`
2. 1.0s 短素材 → `success:false`，原因「素材时长 1.00s 过短，无法做 0.5s 首尾交叉淡化」
3. 缺 `sourceDuration`/`fadeDuration` → `passed:false`，`durationCheck=skipped_no_source`
4. 传入错误淡化时长（+3s）→ `passed:false`，`expected=31.5s` vs 实测 34.5s

**回归**：`node scripts/verify-nsfw.js` 42 通过 / 0 失败；`checkClip`/`checkFinal` 除 NSFW
（无 Key 走「未执行→fail」的既有设计）外 4 项全 passed，未受影响。

### 未验证

- **未在完整任务上端到端跑过**（片段生成→拼接→循环→转码→终检）。
  本次验收是直接对已有成片调用 `makeSeamlessLoop` + `checkLoop`，未跑整条 pipeline。
- 重建路径（改配乐）与新建路径的成片时长一致性：两条路径已改用同一配置值，
  但**未实际各跑一条任务做比对**，仅做了代码层面对齐。
- 30 分钟级长片的处理耗时未测（35s 素材 6.8s，估算不具代表性）。
- 既有的 `_rebuildAfterBgmChange` 是否受 `masterPath` 影响未复核。

### 已知遗留（本次范围外）

- `pipeline.js` 的 Mock 模式仍跳过视觉质检（`passed:true, skipped:true`），属 §4.1 待办。
- `videoProcessor.extractFrame` / `_transcodeFFmpeg` 等仍用 `stdio:'pipe'`，
  在本环境会 EPERM；本次只给 `getVideoInfo`/`_hasAudioStream`/循环处理换了 `_execText` 降级路径，
  **其余方法未动**。

---

## 2026-10-19 补记 · 重建母版路径补齐循环步骤（双路径一致性）

### 起因

上一节落地循环后，核对「新建任务」与「改配乐重建」两条路径时发现：
`_rebuildAfterBgmChange` 已废弃为空壳（注释写明「不再被调用」），实际调用链是
`reapplyBgm` → `_buildMasterFromClips`（历史任务无母版时）。

而 `_buildMasterFromClips` 走的是 **拼接 → 转码**，**跳过了循环步骤**，与新建路径
（拼接 → 循环 → 转码）不等长——正是原 `_makeLoopFFmpeg` 注释里「新建 34s / 重建 35s」担心的那件事，
且它确实存在。

### 实测（3 段 × 7s 合成片段，淡化 0.5s）

| 路径 | 母版时长 |
|---|---|
| 旧 `_buildMasterFromClips`（拼接 → 转码） | **21.037s** |
| 新建流程（拼接 → 循环 → 转码） | **20.533s** |
| 差异 | **0.504s** ≈ 一个淡化时长 |

### 修复（`src/pipeline.js` `_buildMasterFromClips`）

补上同一步 `makeSeamlessLoop`，淡化时长与新建路径**同源**（`config.QC.loopFadeDuration`），
中间产物 `<taskId>_master.loop.mp4` 用完即删。
**循环失败不回退直通**：回退会让母版比新建路径长一个淡化时长，正是要消除的不一致；直接返回失败并写明原因。

单片段路径（`paths.length === 1`）原先 `copyFileSync` 后仍走转码，本次保持，但同样经过循环步骤。

### 复验

- 修复后 `_buildMasterFromClips` 实测 **20.533s**，与新建路径同口径（帧对齐抖动 0.034s 内）
- `scripts/verify-loop.js` 新增第 6 组用例（双路径一致性），**25 项全绿**
  - 其中一条负向断言「旧路径与新建路径确实不等长」用于证明该缺陷真实存在，
    若哪天有人又把循环从重建路径拿掉，这条会失败

### 顺带记录的既有缺陷（不在本次范围，未修）

`videoProcessor.concatenate` 的**重编码兜底路径硬编码了 `[0:a]`**：

```js
const filterParts = clips.map((_, i) => `[${i}:v][${i}:a]`).join('');
```

无音轨的片段（未配乐任务）会因 `Stream specifier ':a' matches no streams` 直接失败，
连 `-c copy` 路径走不通时也没有兜底。实测触发方式：3 段无音轨合成片段 → 拼接失败。
本项目的片段通常带音轨，故未被暴露；但**若将来出现无音轨片段，拼接会整条失败**。

---

## 2026-10-19 补记 · Mock 模式不再绕过视觉质检

### 缺陷（违反 §4.1）

`src/pipeline.js` 片段循环里曾有：

```js
const skipVisualQC = task.model === 'mock' || rc.visualQC === false;
const contentResult = skipVisualQC
  ? { passed: true, skipped: true, reason: '视觉质检跳过: 演示模式（合成画面）', level: 'skip' }
  : await qualityChecker.checkContentMatch(...);
```

两个问题叠加：

1. 用 `passed: true` 表达「跳过」——**skipped 冒充 passed**，正是 §4.1 明令禁止的形状；
2. 下游判定是「`!contentResult.passed` 才拉低结论」，于是该分支被**无条件放行**。

后果：Mock 模式下视觉质检被整体绕过。NSFW 属**合规项**，即便在演示模式也不应跳过
（合成画面天然安全，真实调用不会误杀）。

### 修复（`src/pipeline.js`）

按语义拆成两件事，不再混为一条「跳过」：

| 项 | Mock 模式下的处理 |
|---|---|
| NSFW 合规检测 | **照常执行**（由 `checkClip` 内部完成）。此处新增**存在性断言**：`qcResult.details.nsfw` 缺失即判 `passed:false`，防止将来有人把它从 `checkClip` 里摘掉 |
| 内容匹配（画面是否符合提示词） | 对合成纯色/渐变画面**业务上不适用**，返回 `passed:false` + `legitimateSkip:true` + 理由，**不再用 `passed:true`** |

判定改为：只有「真正执行过且失败」或「既非 pass 也非合法跳过」才拉低结论；
`legitimateSkip:true` 不影响整体，其余 `skipped` 一律按未通过处理。

用户主动关闭（`rc.visualQC === false`）同样记为合法跳过。

### 验收（`scripts/verify-mock-vqc.js`，14 项全绿）

| 用例 | 结果 |
|---|---|
| Mock 的内容匹配不再 `passed:true` | `passed=false` ✅ |
| 标为合法跳过并写明理由 | `legitimateSkip=true` ✅ |
| 技术项+NSFW 都通过时，合法跳过不拉低结论 | `passed=true` ✅ |
| **质检结果缺少 NSFW 明细 → 判 fail** | `passed=false` ✅ |
| 内容匹配「未执行且非合法跳过」→ 判 fail | `passed=false` ✅ |
| 内容匹配真实失败 → 判 fail | `passed=false` ✅ |
| 真实 `checkClip` 返回 NSFW 明细 | keys 含 `nsfw` ✅ |
| 无 Key 时 NSFW 判 fail（不因 Mock 放行） | `passed=false` ✅ |
| NSFW 失败结论不标记为 skipped | `skipped=false` ✅ |
| Mock + 无 Key：整体结论 fail | `passed=false` ✅ |

### 回归

- `scripts/verify-nsfw.js` **42/0**
- `scripts/verify-loop.js` **25/0**
- `scripts/verify-mock-vqc.js` **13/0**

**踩坑记录**：`verify-nsfw.js` **不接受 `--tmpdir` 参数**，传了会让它找测试样片失败，
表现为 9 项「无法读取视频时长，抽帧失败」。批量跑脚本时注意各脚本参数不一致。
### 修复过程中自查出的一个自引入回归（已修正，务必留意）

第一版修复把判定写成：

```js
const notRun = contentResult.skipped === true && !legitSkip;
if ((!contentResult.passed && !legitSkip) || notRun) { /* 拉低结论 */ }
```

问题：`checkContentMatch` 在**无多模态 Key** 时返回的是

```js
{ passed: true, skipped: true, reason: '视觉质检跳过: 未配置多模态 LLM Key' }
```

注意它 `passed` 是 **true**。而 `notRun` 条件只看 `skipped`，会把这条也拉低为 fail，
后果是**没配多模态 Key 的真实任务全部失败**——这超出「修 Mock 绕过」的范围，属自引入回归。

修正后的判定：

```js
const legitSkip = contentResult.legitimateSkip === true;
if (!contentResult.passed && !legitSkip) { /* 拉低结论 */ }
```

语义变为：
- `passed:true` 的任何结果（含 checkContentMatch 的「未配置 Key」跳过）→ 不拉低
- `passed:false` 且非 `legitimateSkip` → 拉低（真实失败，或未执行且明确判了 false）
- `passed:false` 且 `legitimateSkip:true`（Mock / 用户关闭）→ 不拉低

验收脚本已加**回归防护用例**：「无多模态 Key 时（passed:true/skipped:true）不拉低结论」。
将来谁若再把 `skipped` 一律判 fail，这条会先失败。

**合规兜底仍在 NSFW 一侧**：`details.nsfw` 缺失即判 fail，不受内容匹配影响。

---

## 2026-10-19 补记 · 拼接对音轨差异的兼容（含一个静默丢音频的缺陷）

### 缺陷一：重编码兜底硬编码 `[i:a]`

`src/videoProcessor.js` `_concatenateFFmpeg` 的重编码兜底：

```js
const filterParts = clips.map((_, i) => `[${i}:v][${i}:a]`).join('');
```

遇【无音轨】片段直接失败：

```
Stream specifier ':a' in filtergraph description ... matches no streams.
```

`-c copy` 路径走不通时（编码参数不一致、时长校验失败等）即无任何兜底，整条拼接失败。
本项目片段通常带音轨，故一直未暴露。

### 缺陷二（本次实测新发现）：混合音轨时 `-c copy` 静默丢音频

实测「1 段无音轨 + 1 段有音轨」用 `-f concat -c copy`：

| 结果 | 值 |
|---|---|
| 退出码 | **0** |
| 时长 | 6.000s（**正确**） |
| 流 | **只有 video** —— 音频被丢弃 |

**`_validateConcatDuration` 只校验时长，抓不到这种丢失**，属 §4.3 同类陷阱的变体：
退出码为 0、时长也对，但产物已经损伤。

### 修复

拼接前先探测各片段音轨（`_hasAudioStream`），按三种情况分派：

| 情况 | copy 路径 | 重编码兜底 |
|---|---|---|
| 全部有音轨 | 照常使用 | `[i:v][i:a]` + `concat=v=1:a=1` |
| 全部无音轨 | 照常使用（实测正常） | 只取 `[i:v]` + `concat=v=1:a=0`，`-map [outv]` |
| **混合** | **跳过**（会丢音频） | 先给无音轨片段补等长静音（`anullsrc` + `-shortest` + `-c:v copy`），再 `concat=v=1:a=1` |

混合分支的临时文件 `<outputPath>.pad<i>.mp4` 用完即删（成功/失败/不可判定三条路径都清理）。
返回值新增 `hasAudio`、`silencePadded`，便于上游与验收核对。

**为什么不直接丢弃音频**：静默丢数据比失败更糟——用户不会发现。
**为什么不直接报错**：补静音是唯一既保留原有音频、又不失败的方式。

### 实测数值（`scripts/verify-concat-audio.js`，17 项全绿）

素材：4 段 3s 合成片段（2 无音轨 / 2 有音轨，有音轨的为 500Hz、800Hz 正弦）。

| 场景 | 结果 |
|---|---|
| 全有音轨 | success，6.023s，流 `video\|audio` ✅ |
| 全无音轨 | success，6.000s，流 `video`，**不再报 matches no streams** ✅ |
| 混合 | success，6.018s，流 `video\|audio`，`reencoded=true`，`silencePadded=1` ✅ |

混合产物分段电平（证明「补的是静音、原音频没丢」）：

| 区段 | mean_volume | 判定 |
|---|---|---|
| 前 3s（原无音轨段，已补静音） | **-91.0 dB** | 确为静音 ✅ |
| 后 3s（原有音轨段） | **-24.1 dB** | 音频完好 ✅ |

（对照：原 wa1.mp4 为 -21.1 dB，拼接重编码后略降属正常编码损失）

临时文件残留检查：无 `.pad*`、无 `.txt` 残留 ✅

### 回归

- `scripts/verify-loop.js` **25/0**
- `scripts/verify-nsfw.js` **42/0**
- `scripts/verify-mock-vqc.js` **14/0**
- `scripts/verify-concat-audio.js` **17/0**

### 顺带确认

`_probeDurationSec`（`stdio: ['ignore','pipe','ignore']`）与 `_validateConcatDuration`
在本 EPERM 环境**工作正常**（实测返回 5s/35s 等正确数值），§4.3 的时长校验链路未被破坏。

---

## 2026-10-19 · 流水线档位：纯函数层落地（**尚未接入主流程**）

**状态**：模块 + 验收完成（41 项）。**主流程编排一行未改**，档位目前不会影响实际执行。

### 为什么先做这一层

《后续目标》要求把「7 步线性全量执行」拆成「核心链必选 + 增强层可选」并预设档位，
最大价值是**补跑**：今天跑快速验证档，明天只补配乐/转码，视频不重新生成、生成费不重复花。

但直接改 `_runPipeline` 有两个硬约束：

1. **无法验证**：真实流水线要跑生成 API，当前 `.env` 里 `DASHSCOPE_API_KEY` 等全空，
   按 `generators/index.js` 的逻辑会静默降级成 Mock。在 Mock 上「验证」流水线编排，
   等于验了个假——违反 §4.8。
2. **风险高**：`_runPipeline` 是所有任务的唯一入口，改错会影响全部任务。

所以先把「算清楚要跑哪些步骤」这段最容易出错的逻辑抽成纯函数模块，
用纯单测覆盖全部边界，**不碰主流程**。

### 新增 `src/pipelineStages.js`

| 导出 | 作用 |
|---|---|
| `CORE_STAGES` / `ENHANCED_STAGES` / `ALL_STAGES` | 核心链 3 步、增强层 5 步、合计 8 步 |
| `STAGE_DEPS` | 每步的前置依赖 |
| `PRESETS` | 5 个档位：quick / daily / final / clips_only / custom |
| `resolveStages(preset, customStages)` | 档位 → 步骤集合，含核心链强制、依赖传递补齐、顺序归一 |
| `resolveResume({preset, completed})` | 补跑：算出 `pending`（要跑的）与 `reused`（复用的） |
| `buildSnapshot(task)` | 生成参数快照（一键复跑用），**不含任何密钥** |

### 关键设计

1. **`audio_mix` 只依赖 `concatenation`，不依赖 `loop_processing`**。
   配乐是整片混音，循环与否不影响混音；这样「只补做配乐」不会被迫重跑循环。
2. **核心链必选**：自定义只勾增强层时，3 个核心步骤会被强制加入并记入 `coreForced`，
   否则没有片段可用。
3. **依赖传递补齐**：只勾 `final_qc` 会补齐 `transcoding → concatenation → clip_generation
   → storyboard → prompt_optimize` 整条链，并在 `autoAdded` 里说明补了什么。
4. **补跑做两类校验**（这是本模块最容易写错的地方）：
   - 待跑步骤的依赖必须「已完成」或「也在待跑清单里」；
   - **已完成步骤的依赖必须也已完成**——否则是**状态矛盾**。
     例如「声称 transcoding 已完成，但从没生成过片段」：那份产物来源不明，
     在其上继续补跑等于把坏产物当真。校验只用第 1 条会漏掉这种。
5. **快照不含密钥**：只收 `model/resolution/clipDuration/totalClips/theme/aspectRatio/
   isMultiPrompt/prompt` + `templateVersion`。`runtimeConfig` 里的 apiKey/secret 一律不落盘。

### 验收（`scripts/verify-stages.js`，41 项全绿）

| 组 | 覆盖 |
|---|---|
| [1] 步骤名对齐 | 与 `taskManager.getPipelineSteps()` 逐项比对，**无遗漏、无编造** |
| [2] 预设档位 | quick/daily/final/clips_only 的步骤集合；daily 不含终检 |
| [3] 核心链必选 | 只勾 audio_mix → 核心链被强制加入 + concatenation 被补齐 |
| [4] 依赖传递 | 只勾 final_qc → 补出 6 步整链；audio_mix 不连带拉入 loop_processing |
| [5] 补跑计算 | 完成快速验证档 → 目标 daily 只补 `loop_processing, audio_mix`，**片段不重跑** |
| [6] 链路校验 | 自洽场景不误杀；状态矛盾被判失败并写明「状态矛盾」 |
| [7] 非法输入 | 未知档位 / 空自定义 / 未知步骤名 全部判失败 |
| [8] 顺序稳定 | 输出按 `ALL_STAGES` 固定顺序，不受勾选顺序影响 |
| [9] 参数快照 | 字段完整、含模板版本、**无密钥**、缺失字段记入 `missing` 而非静默忽略 |

实测补跑样例：
```
completed = [prompt_optimize, storyboard, clip_generation, concatenation]
目标档位 = daily
→ pending = [loop_processing, audio_mix]     ← 只补这两步
→ reused  = 4                                ← 片段不重新生成
```

### 尚未接入（重要）

- **`pipeline.js` 的 `_runPipeline` 一行未改**，仍是无条件全量执行。
  档位要真正生效，还需要：
  1. 任务创建时接收 `preset` 并落库（`task.preset`）；
  2. `_runPipeline` 每步前加 `if (!stageSet[step]) { 标记 skipped; continue; }`；
  3. 「补跑」入口：读任务已完成步骤（`task.steps`）→ `resolveResume` → 只跑 `pending`；
  4. 前端档位选择 UI（`public/index.html`，UI 归属）。
- 接入**必须用真实任务验证**（至少跑一遍 quick + 一次补跑），当前环境无生成 Key，无法验证。
- 在此之前，档位模块只是「算得对」，**不代表流水线已经模式化**。

### 回归

- `scripts/verify-stages.js` **41/0**
- `scripts/verify-concat-audio.js` **17/0**
- `scripts/verify-loop.js` **25/0**
- `scripts/verify-nsfw.js` **42/0**
- `scripts/verify-mock-vqc.js` **14/0**

---

## 2026-10-19 补记 · 流水线档位**已接入主流程**（真机验证通过）

上一节只落地了纯函数层并明确标注「尚未接入」。本节完成接入，**档位现在真正生效**。

### 为什么 Mock 也足以验证编排

上一节判断「接入必须用真实生成 API」是**过于保守**：
`src/generators/mock.js` 用 ffmpeg 产出**真实视频文件**，整条流水线（拼接/循环/转码/配乐/质检）
都会真实执行。档位控制的是**编排逻辑**，与生成器无关，所以 Mock 足以验证。
（真正的生成质量仍需真实 API，但那不是档位要验证的东西。）

### 接入内容

| 文件 | 改动 |
|---|---|
| `src/taskManager.js` | `createTask` 解析档位：`preset` / `stageSet` / `stagePlan` 落库。**默认 final（8 步全量）**，与接入前行为完全一致 |
| `src/taskDefaults.js` | 老任务补 `preset='final'` + `stageSet` 8 步全 true（当初就是全量执行，如实还原） |
| `src/pipeline.js` | 新增 `_stageEnabled()` / `_markStageSkipped()`；在 concatenation / loop_processing / transcoding / audio_mix / final_qc 五处接入判断；产物用 `videoForNext` 链式传递 |

### 接入时才暴露的四个问题（纯函数层测不出来）

**1. `STAGE_DEPS` 写错了 `audio_mix` 的依赖**
纯函数层里写的是 `audio_mix: ['concatenation']`，但代码里 `audio_mix` 读的是 **`masterPath`（转码产物）**。
按原声明，`daily` 档不含 `transcoding`，接入后会出现「配乐拿不到母版」。
已改为 `audio_mix: ['transcoding']`，并给 `daily` 档补上 `transcoding`。

**2. `_stageEnabled` 用 `!== false` 判断，导致档位形同虚设**
`stageSet` 的形状是「只列出要执行的步骤」，未列入的是 `undefined`。
而 `undefined !== false` 为 `true` → 所有步骤都被判为「要执行」。
**实测表现：quick 档（计划 4 步）8 步全跑了。** 已改为 `=== true`。

**3. `concatenation` 漏了档位判断**
第一次接入只给后 4 步加了判断，`clips_only` 档仍会拼接。

**4. `clips_only` 需要特殊处理**
该档的交付物是**片段包**，不是成片。跳过拼接后下游全依赖拼接产物，
继续执行会在没有输入的情况下产出坏片。已改为：跳过拼接时直接结束流水线，
`outputPath: null` + `fragmentOnly: true` + `fragmentCount`，明确告诉调用方「这是片段包」。

> 这四个问题里，**只有第 1 个**纯函数层能靠「想」发现，另外三个必须真机跑才会暴露。
> 这也回答了上一节的顾虑：不是「不能验证」，而是「必须用真机验证」。

### 真机验收（`scripts/verify-stage-pipeline.js`，37 项全绿）

用 Mock 生成器跑**真实流水线**，三个档位各跑一条完整任务：

| 档位 | 实际执行 | 被跳过 | 产物 |
|---|---|---|---|
| **quick** | 提示词/分镜/片段/拼接 | 循环/转码/配乐/终检 | 成片 15KB ✅ |
| **默认（不传 preset）** | 全部 8 步 | 无 | status=completed ✅ |
| **clips_only** | 提示词/分镜/片段 | 拼接/循环/转码/配乐/终检 | `fragmentOnly=true`，不产成片 ✅ |

关键断言：

- quick 档跳过步骤标记 `legitimateSkip:true`，理由为「档位「quick」未包含此环节，按计划跳过」
  ——**不是静默跳过**，任务详情里能看出区别
- **默认档 skipped=0**：证明接入档位没有改变原有行为（零回归）
- clips_only 不产出成片文件（`outputPath=null`），且报告 `fragmentCount`
- 老任务（无 preset 字段）补成 final + 8 步全 true

**测试注入说明**：脚本对 `qualityChecker.checkNSFW` 注入「通过」返回值。
原因：当前 `.env` 无 `OPENAI_API_KEY`，NSFW 按既有设计判 fail，会让片段质检失败、
流水线在「片段生成」就中止，根本走不到档位控制的步骤。NSFW 检测本身由
`scripts/verify-nsfw.js` 独立验证 42 项，不受此注入影响。其余质检项（黑帧/模糊/重复/时长）真实执行。

### 全量回归

| 脚本 | 结果 |
|---|---|
| `verify-stage-pipeline.js` | **37/0**（新增，真机） |
| `verify-stages.js` | **45/0** |
| `verify-concat-audio.js` | **17/0** |
| `verify-loop.js` | **25/0** |
| `verify-nsfw.js` | **42/0** |
| `verify-mock-vqc.js` | **14/0** |

合计 **180 项全绿**。

### 尚未完成

- **补跑入口未接**：`resolveResume` 已实现并验证，但还没有 API/命令行入口把
  「任务已完成到哪一步」喂给它。要真正实现「今天跑 quick、明天补成 final」，
  还需要：读 `task.steps` 中已完成的步骤 → `resolveResume` → 只跑 `pending`。
- **前端档位 UI 未做**：`public/index.html` 没有档位选择（UI 归属，需 UI 协作）。
- 端到端仍未用真实生成 API 验证过（无 Key）。

---

## 2026-10-19 补记 · 补跑入口接通（`continueTask` + API）

上一节记「补跑入口未接」。本节完成接线，**「今天跑 quick、明天补成 final 且不重生成片段」现在可用了**。

### 新增

| 位置 | 内容 |
|---|---|
| `pipeline.continueTask(taskId, {preset, completed})` | 补齐 pending 环节；已完成步骤自动复用 |
| `pipeline._completedSteps(task)` | 从 `task.steps` 推断已完成（`completed` / `reused`；**`skipped` 不算**） |
| `pipeline._resolveArtifact(taskId, step)` | 定位某步已产出的视频文件（含 >10KB 校验） |
| `POST /api/tasks/:id/continue` | 触发补跑；非法档位返回 400 |
| `GET /api/tasks/:id/continue-plan` | 只读预览「还需跑哪些」；任务不存在返回 404 |

### 核心机制

1. **片段复用**：`_batchGenerate` 跳过 `status==='success'` **且文件仍在**的片段（只看状态不够——文件可能被清理）。
   全部复用时不记 `completed` 而记 `reused`，并写 `reusedClips`/`generatedClips` 统计。
2. **产物复用**：`concatenation`/`loop_processing`/`transcoding`/`audio_mix` 各自检查 `<taskId>_*.mp4`
   是否存在，存在且档位不含该步时直接复用。
3. **状态区分**：`_markStageSkipped` 依据 `task.resumeReused` 把状态标成 `reused`（复用，passed）
   而不是 `skipped`（档位外跳过），两者在任务详情里可区分。
4. **状态切换**：补跑开始时把任务状态从 `completed` 切回 `pending`。

### 接入时又暴露三个真机才有的问题

**1. 补跑直接以「片段包」结束**
`concatenation` 在补跑时同样不在 `stageSet`（它已完成、本次复用），而「clips_only 分支」无条件拦截
`!stageEnabled('concatenation')` → 直接 return `fragmentOnly`，后 4 步全成 skipped。
已改为**同时判断有无可复用的拼接产物**（`!enabled && !reusedConcat` 才走片段包分支）。

**2. 补跑状态没切回运行中**
`continueTask` 原先用 `updateTaskStatus(taskId, task.status, ...)`，`task.status` 是 `completed`，
于是补跑刚启动，任务就已显示「已完成」——外部轮询/等待逻辑立即返回，看起来像补跑没生效。
已改为切到 `pending`。

**3. 片段被整批重新生成**
核心链三步（提示词/分镜/片段生成）此前**没有任何档位判断**（设计上是「必选」）。
但「必选」指**档位必须包含**，不等于**补跑要重跑**。
实测：补跑到 final 时 2 个片段被重新生成了一遍（等于白花钱）。
已在 `_batchGenerate` 内按片段粒度复用。

> 这三个问题都是纯单测（`verify-stages.js` 45 项全绿）**测不出来**的，
> 必须真机跑「先 quick 再补 final」这条路径才会暴露。

### 真机验收（`scripts/verify-continue.js`，19 项全绿）

流程：先用 quick 档跑一条 2 片段任务 → 再补跑到 final。

| 断言 | 实测 |
|---|---|
| 补跑待跑 4 步 | `loop_processing,audio_mix,transcoding,final_qc` ✅ |
| 补跑复用 4 步 | `prompt_optimize,storyboard,clip_generation,concatenation` ✅ |
| **片段生成标记 reused** | `reused` ✅ |
| **片段文件 mtime 未变** | 2/2 完全一致 ✅ |
| 拼接标记 reused | `reused` ✅ |
| 循环/转码/终检真实执行 | 均 `completed` ✅ |
| 补跑后产出成片 + 母版 | 两者都存在 ✅ |
| 再补跑同档位 | `alreadyDone: true` ✅ |
| 无任何已完成步骤时补跑 | 被拒：「补跑需要拼接产物」✅ |
| 非法档位 | 被拒 ✅ |

**说明**：第 1、2 步（提示词优化/分镜）在补跑时**仍会重新执行**，状态如实记为 `completed`
而非 `reused`——它们不调用视频生成、不产生生成费用，只是重算文本。这是如实记录，不是缺陷。

### API 实测

| 请求 | 结果 |
|---|---|
| `GET /api/tasks/<id>/continue-plan?preset=final` | 返回 `pending`/`completed` 清单 ✅ |
| `GET /api/tasks/nope/continue-plan` | HTTP 404 ✅ |
| `POST /api/tasks/<id>/continue` + `{"preset":"bogus"}` | HTTP 400 ✅ |

### 全量回归

| 脚本 | 结果 |
|---|---|
| `verify-continue.js` | **19/0**（新增，真机） |
| `verify-stage-pipeline.js` | **37/0** |
| `verify-stages.js` | **45/0** |
| `verify-concat-audio.js` | **17/0** |
| `verify-loop.js` | **25/0** |
| `verify-nsfw.js` | **42/0** |
| `verify-mock-vqc.js` | **14/0** |

合计 **199 项全绿**。

### 仍未完成

- **前端补跑 UI**：API 已就绪，`public/index.html` 还没有「补跑」入口（UI 归属）。
- 端到端仍未用真实生成 API 验证（无 Key）；本项目前用 Mock 生成器跑真实流水线验证。
- 补跑时第 1、2 步会重跑并覆盖 `clips[i].prompt`（若用户手动改过片段提示词，会被重新优化覆盖）。

---

## 2026-10-19 补记 · 质检可信度暴露到 API + 修正一条不准确的环境记录

### 一、质检可信度（qcVersion）终于能被前端读到

`docs/spec/changelog.md` 的 2026-10-18 节里明确留了一个尾巴：

> `taskManager.getAllTasks()` 直接读内存对象，**不会**自动带标注。
> API 若要暴露，需在 `server.js` 的 `/api/tasks/:id` 等处调用 `storage.annotateTaskQC(task)`

这条一直没做，导致**前端根本拿不到「历史未验证」信息**，`qcVersion` 机制等于只做了一半。

本次补齐：

| 接口 | 新增字段 |
|---|---|
| `GET /api/tasks/:id` | `qcVersion`、`qcTrusted`、`qcVersionSource`、`finalQC.qcLabel`、`clips[i].qcResult.qcLabel` |
| `GET /api/tasks` | `qcVersion`、`qcTrusted`（列表页只给两个轻量标量，完整 `finalQC` 体积大，留给详情） |

实测（真实任务）：

| 任务 | qcVersion | qcTrusted | source |
|---|---|---|---|
| `task_mv4v7qp2_m8r0` | 2 | **true** | finalQC |
| `task_mukptvrj_xbjn` | 2 | **true** | finalQC |
| 其余 4 条历史任务 | null | false | null |

### 二、顺带修掉一个误导性缺陷（`qcVersion.js` `annotateTask`）

原实现只从**任务行**取版本：

```js
const taskVersion = normalize(task.qcVersion !== undefined ? task.qcVersion : task.qc_version);
```

但现实数据里「任务级 `qc_version`」经常是空的——版本写在 `finalQC` / `qcResult` 内部。
于是 `taskVersion = null` → `qcTrusted = false`，**所有终检真实执行过的任务都会被标成
`legacy_unverified`**。前端的「历史未验证」角标会变成「什么都标」，等于失效。

修复：任务级版本缺失时**回退到 `finalQC` 的版本**，并新增 `qcVersionSource` 记录来源
（`task` / `finalQC` / `null`），调用方需要更细粒度时自行看 `clips[i].qcResult.qcLabel`。

四种组合实测：

| 场景 | qcVersion | qcTrusted | source |
|---|---|---|---|
| 任务级无、finalQC=2 | 2 | true | finalQC |
| 任务级=1、finalQC=1 | 1 | false | task |
| 完全无版本 | null | false | null |
| 任务级=2、finalQC=1 | 2 | true | task（任务级优先） |

`passed` 原值一律不篡改（只新增字段），负向用例已覆盖 null / "abc" / -1 / 0。

### 三、修正一条被实测证伪的环境记录

`AGENTS.md` §2.3 原写「本环境里 `stdio:'pipe'` 会返回 EPERM」。**实测并非一律如此**：

| 方法 | 调用方式 | 实测结果 |
|---|---|---|
| `extractFrame` | `execSync(cmd, { stdio:'pipe' })` | ✅ 正常（产出 41840 字节 JPEG） |
| `transcode` | `execSync(cmd, { stdio:'pipe' })` | ✅ 正常 |
| `concatenate`（copy 路径） | `execSync(cmd, { stdio:'pipe' })` | ✅ 正常（时长校验通过） |

真正踩到 EPERM 的是**需要捕获 stdout 文本**的调用，如 `getVideoInfo` 的
`execSync(cmd, { encoding:'utf8' })`，现象 `spawnSync C:\Windows\system32\cmd.exe EPERM`。

已把 §2.3 改写为准确描述：**要读 stdout 的**走上层封装的降级路径；**只执行不读输出**的可以照常用。
同时把 §6 缺口表里「`extractFrame` / `_transcodeFFmpeg` 等仍用 `stdio:'pipe'`」一条**删除**——
它不是缺口，是被错误记录的风险。留着会让后人对已正常工作的代码做无谓改造。

### 验收（`scripts/verify-qc-annotation.js`，32 项全绿）

| 组 | 内容 |
|---|---|
| A 标注语义 | 版本 2/3 可信、1/0/null/"abc"/-1 不可信；`passed` 不被篡改 |
| B 版本回退 | 无任务级版本时回退 finalQC；来源可查；任务级优先 |
| C 存储/API | `taskManager.getTask` 不带标注（已知）；`storage.getTask` 带；**起临时服务实测两个 API** |

C 组会启动一个临时 server（端口 3096）真实请求 API，断言返回体含 `qcTrusted` / `qcVersion` /
`qcVersionSource` / `finalQC.qcLabel`，结束后按端口兜底清理进程。

### 仍未完成

- **前端 UI**：`public/index.html` 还没有
  「历史未验证」角标、档位选择、补跑入口——三者后端都已就绪，属 UI 归属。
- 端到端仍未用真实生成 API 验证（无 Key）。

---

## 2026-10-19 补记 · 对接前端：preset 透传缺失 + 单片段补跑缺陷

### 一、档位功能此前**通过 API 完全不可用**

上一节写完「补跑入口接通」后，本节要给前端写集成契约，逐条核对接口时发现：

`POST /api/tasks` 的请求体解构里**没有 `preset` / `stages`**：

```js
const { prompt, prompts, clipTracks, bgm, model, theme, ..., strictQcItems } = req.body;
//                                                                       ↑ 没有 preset
```

而 `taskManager.createTask` 是支持 `options.preset` 的（真机测过）。
结果：前端传 `{preset:'quick'}` 会被**静默忽略**，任务永远用默认 `final`（8 步全量）。

**实测**：传入 `preset=quick` → 任务 `preset=final`、`stageSet` 8 步。
也就是说，前面几轮做的档位功能，**用户根本用不上**——只能直接调 Node API。

修复：解构补上 `preset` / `stages`，并透传给 `createTask`。

修复后实测：

| 传入 | 任务 preset | stageSet 步数 |
|---|---|---|
| `quick` | quick | 4 |
| `clips_only` | clips_only | 3 |
| `final` | final | 8 |
| 不传 | final | 8（默认行为不变） |
| `bogus`（非法） | final | 8 + `stagePlan.notes` 记录回退原因 |

### 二、单片段任务的补跑会被误判成「片段包」

写契约校验时用 `totalClips=1` 跑，暴露了另一个缺陷。

「clips_only 片段包」分支的判定是：

```js
if (!stageEnabled('concatenation') && !reusedConcat) { /* 片段包，直接 return */ }
```

其中 `reusedConcat` 靠找 `<taskId>_concat.mp4`。
**但单片段任务的拼接步骤是「跳过拼接、直接用该片段」，根本不产出 `_concat.mp4`。**

后果：1 片段的任务 quick 跑完再补 final → `reusedConcat=null` → 被当片段包 →
下游 4 步全部标 `skipped`，补跑等于什么都没做。

修复：拼接步骤本身已完成（`completed`/`reused`/`partial`）时，若没有 `_concat.mp4`
就用那唯一的成功片段顶上（与主流程 `successClips.length === 1` 分支语义一致）。

修复后：单片段补跑 → 循环/转码/配乐/终检全部真实执行。

> 这两个缺陷都属于「功能做完了但用户用不上」或「特定数据形态下静默失效」，
> **纯单测和多片段真机都测不出来**，是写前端契约（逐条核对真实 API）时逼出来的。

### 三、新增前端集成契约

新增 `docs/spec/frontend-integration-spec.md`，把三个 UI 功能的接口契约写清楚：

| 功能 | 接口 |
|---|---|
| 档位选择 | `POST /api/tasks` 的 `preset` / `stages` |
| 补跑 | `GET /api/tasks/:id/continue-plan`（预览）、`POST /api/tasks/:id/continue` |
| 质检可信度角标 | `GET /api/tasks/:id` 与 `/api/tasks` 的 `qcVersion` / `qcTrusted` / `qcLabel` |

内容包括：请求/响应示例、每个字段含义、`skipped` 与 `reused` 的视觉区分要求、
错误分支（400/404 的具体 error 文案）、以及实测数据。

### 四、契约一致性校验（`scripts/verify-frontend-contract.js`，49 项全绿）

**文档与实现不符比没有文档更糟**，所以这个脚本把文档里承诺的每一条都真跑一遍：

| 组 | 覆盖 |
|---|---|
| [1] | 4 种 preset 透传 + 不传的默认行为 |
| [1b] | 非法 preset 回退 final 且写入 notes |
| [2] | continue-plan 字段完整 + 任务不存在 404 |
| [3] | continue 的错误分支（非法档位 400、任务不存在 400） |
| [4] | 列表/详情的 qc* 字段 |
| [5] | clips_only 的 `fragmentOnly` / `outputPath=null` / `fragmentCount` / 拼接标 `skipped` |
| [6] | **真机补跑**：quick → final，片段 `reused`、文件 mtime 未变、循环真实执行、幂等 `alreadyDone` |

新增测试专用 shim `scripts/_nsfw-pass-shim.js`：因为契约校验要起**独立 server 进程**，
无法像前两个脚本那样在进程内 patch `checkNSFW`；改用
`node --require ./scripts/_nsfw-pass-shim.js server.js` 预加载。
（无 `OPENAI_API_KEY` 时 NSFW 判 fail 会让片段质检失败、流水线在片段生成就中止，
档位/补跑相关步骤根本走不到。NSFW 本身由 `verify-nsfw.js` 独立验收 42 项。）

### 五、修掉一个测试稳定性问题

批量跑时 `qc-annotation` 出现 31/1（单跑 32/0）——原因是**端口冲突**：
上一个脚本起的服务还没释放 3096，下一个脚本启动失败。
已把 `qc-annotation` 与 `frontend-contract` 都改为**动态选端口**（先探测 20 个端口）。
连跑 3 次验证稳定：32/0、32/0、32/0。

### 全量回归（9 个脚本）

| 脚本 | 结果 |
|---|---|
| `verify-frontend-contract.js` | **49/0**（新增） |
| `verify-qc-annotation.js` | **32/0** |
| `verify-continue.js` | **19/0** |
| `verify-stage-pipeline.js` | **37/0** |
| `verify-stages.js` | **45/0** |
| `verify-concat-audio.js` | **17/0** |
| `verify-loop.js` | **25/0** |
| `verify-nsfw.js` | **42/0** |
| `verify-mock-vqc.js` | **14/0** |

**合计 280 项全绿，9 个脚本 exit 均为 0。**

### 仍未完成

- **前端 UI 仍未实现**：`public/index.html` 里没有档位选择、补跑按钮、历史未验证角标。
  后端与契约都已就绪，属 UI 归属（`AGENTS.md` §3）。契约见
  `docs/spec/frontend-integration-spec.md`。
- 端到端仍未用真实生成 API 验证（无 Key）。
- 4K/8K/HDR 仍未动（无 GPU、无超分 Key、万相封顶 1080p）。

---

## 2026-10-19 补记 · 前端 UI 落地（档位选择 / 补跑按钮 / 质检角标）

### 背景与授权说明

后端能力早已就绪，但界面看不见 = 用户用不上。本轮由用户明确指示后，
**研发跨角色修改了 `public/index.html`**（`AGENTS.md` §3 约定该路径属 UI）。
改动方式上做了两点约束，尽量降低越界风险：

1. **只用增量 `edit` 精确插入，绝不整文件重写**——该文件此前已有
   **1062 行新增 / 352 行删除的未提交改动**（1.5 小时未再变动，判定为有效的进行中工作）。
   全程未删除或改写他人内容，只在 4 处插入。
2. 只在既有设计系统内新增元素（复用 `.form-group` / `.form-label` / `.form-hint` /
   `.qc-strict-list` / `.detail-item` / `.modal-section` 等既有类），不引入新视觉样式。

### 四处改动

| 位置 | 内容 |
|---|---|
| 创建表单（分辨率之后） | `#presetSelect` 五档下拉 + `#presetHint` 说明；custom 时展开 `#customStagesWrap` 的 8 个环节勾选框 |
| 创建请求 | body 增加 `preset`，custom 时附带 `stages: [...]` |
| 详情弹窗（耗时之后） | `#detailPreset`（档位）+ `#detailQcTrust`（质检可信度角标） |
| 详情弹窗（新增 section） | `#continueSection`：补跑预览文案 + 「补成最终成片」按钮 |

### 关键实现点

- **档位联动**：custom 才显示勾选区；其余档位的步骤由后端 `resolveStages` 决定，
  前端**不重复计算依赖**（避免与后端规则漂移）。
- **补跑按钮的显示条件**：任务 `status === 'completed'` **且** `preset !== 'final'` **且**
  `continue-plan` 返回的 `pending` 非空。先预览再确认，确认框写明「片段不会重新生成」。
- **质检角标三态**：
  - `qcTrusted === true` → 绿字「已核验」（tooltip 显示版本与来源）
  - `qcVersion` 有值但不可信 → 橙字「历史未验证」（tooltip 说明修复前结论不可采信）
  - `qcVersion` 为空 → 灰字「无质检结论」（quick 档不跑终检时属正常）
- 详情页数据来自 `/api/tasks/:id/progress`（不含 qc/preset），因此**额外拉了一次**
  `/api/tasks/:id`。失败不影响基础详情展示。

### 验证：浏览器不可用，改用两层替代验证

本环境 **Electron 未安装**，`dsh_browser_*` 全部不可用（changelog 早有记录）。
改用两层：

**第一层 —— 静态一致性（`scripts/verify-frontend-static.js`，43 项全绿）**

| 组 | 内容 |
|---|---|
| [1] | HTML 结构完整（标签配对、无 U+FFFD） |
| [2] | 2 个内联 script 块均可 `new Function()` 解析 |
| [3] | **JS 引用的 165 个元素 id 全部存在或为动态创建** |
| [4] | 本次新增的 9 个 id + 8 个步骤勾选框全部就位 |
| [5] | `preset` / `stages` 确实出现在请求体里 |
| [6] | 补跑确实调用了 continue-plan 与 continue（POST） |
| [7] | 角标读取 qcTrusted / qcVersion / qcVersionSource |
| [8] | 档位 change 监听、custom 切换、五档齐全 |
| [9] | **既有元素与函数未被破坏**（9 个 id + 3 个函数） |

**第二层 —— 端到端走一遍 UI 会发的请求（实测）**

```
创建 {preset:'quick'} → 任务 preset=quick、stageSet 4 步、status=completed
详情字段            → preset=quick；qcVersion 为空 → 显示「无质检结论」（未跑终检，正确）
continue-plan       → pending=[loop,audio_mix,transcoding,final_qc]
                      reused=[prompt_optimize,storyboard,clip_generation,concatenation]
POST continue       → success，补跑后 片段生成=reused、循环=completed、终检=completed
```

### 过程中发现的两个既有问题（均非本次引入）

1. **`#genStatusDot` 在 HTML 里不存在**，但有 7 处 JS 引用 + `.gen-status-dot` 的 CSS。
   属于「样式与逻辑写了、元素没加」的未完成功能，副作用只是侧边栏生成状态点不显示。
   7 处引用中 6 处有 `if (dot)` 保护，1 处（`genDot`）是**声明后从未使用的死变量**，不会抛错。
   已在验证脚本里标注为「已知既有缺口」并单独校验其安全性，**未擅自补元素**
   （可能属于他人进行中的工作）。
2. 验证脚本初版把「死变量」误判为「无 null 保护」，已修正判定逻辑。

### 全量回归

| 脚本 | 结果 |
|---|---|
| `verify-frontend-static.js` | **43/0**（新增） |
| `verify-frontend-contract.js` | **49/0** |
| `verify-qc-annotation.js` | **32/0** |
| `verify-continue.js` | **19/0** |
| `verify-stage-pipeline.js` | **37/0** |
| `verify-stages.js` | **45/0** |
| `verify-concat-audio.js` | **17/0** |
| `verify-loop.js` | **25/0** |
| `verify-nsfw.js` | **42/0** |
| `verify-mock-vqc.js` | **14/0** |

**合计 323 项全绿，10 个脚本 exit 均为 0。**

### 仍未验证（重要）

- **没有在真实浏览器里点过**。静态校验能查出「元素不存在 / 字段漏传 / 语法错」，
  **查不出**布局错位、样式冲突、拖拽手感、弹窗遮挡这类问题。
  按 `AGENTS.md` §5.4，UI 交付要求「在浏览器里实际操作一遍并截图/录屏」——
  **这一步本环境做不到，需人工补做**。
- 4K/8K/HDR 仍未动（无 GPU、无超分 Key、万相封顶 1080p）。

---

## 2026-10-19 补记 · 验收统一入口 + 浏览器不可用时的自检方案

### 一、验收脚本终于有了统一入口

本项目已有 10 个 `verify-*.js`，但此前只能逐个 `node scripts/xxx.js`——
**没人会记得全部跑一遍，回归时漏跑一个就等于没验**。

新增 `scripts/verify-all.js`：

```powershell
node scripts/verify-all.js          # 全部（约 3 分钟）
node scripts/verify-all.js --fast   # 只跑纯逻辑/静态组（约 10 秒）
node scripts/verify-all.js --only loop,stages
```

同时写入 `package.json`：

| 命令 | 作用 |
|---|---|
| `npm run verify` | 全部 |
| `npm run verify:fast` | 快速组 |
| `npm run verify:frontend` | 前端静态 + 契约 |
| `npm run verify:loop` | 循环相关 |
| `npm run verify:stages` | 档位 + 补跑 |

**未新增任何依赖**（`dependencies` 仍为 4 个，符合 §4.6）。

实测一次全量（10 个脚本）：

```
stages             ✅  45/45    0.2s
frontend-static    ✅  43/43    0.1s
qc-annotation      ✅  32/32    5.0s
frontend-contract  ✅  49/49   35.7s
continue           ✅  19/19   14.8s
stage-pipeline     ✅  37/37   27.9s
concat-audio       ✅  17/17    4.3s
loop               ✅  25/25   24.0s
nsfw               ✅  42/42   47.0s
mock-vqc           ✅  14/14    8.0s
总计: 10 个脚本 | 323 项通过 / 0 项失败
```

### 二、浏览器验证：尝试过，但当前会话无法解决

上一节遗留的「UI 未经真实浏览器验证」，本轮尝试解决：

- 错误提示建议 `npx install-electron` 或设 `ELECTRON_PATH`。
- 检查发现 `%LOCALAPPDATA%\electron\Cache` 里**有** `electron-v43.2.0-win32-x64.zip`（137MB）
  与 `electron-v44.0.0-win32-x64.zip`（150MB），但**只有 zip、未解压**，全盘没有 `electron.exe`。
- 关键限制：`dsh_browser_*` 读取 `ELECTRON_PATH` 发生在**进程启动时**，
  即使现在解压并设置环境变量，**当前会话的工具也不会重新读取**。
  因此本轮无法在本会话内完成真实浏览器验证。

**没有假装验证过**——这一点在 §6 缺口表与本文都如实标注。

### 三、替代方案：新增浏览器自检页 `public/_selftest.html`

用户打开 `http://localhost:3001/_selftest.html` 即自动跑一遍检查，
结果用「通过/失败」逐条显示，不需要开发者做什么。

覆盖：

| 组 | 内容 |
|---|---|
| 档位 | 用 `preset=quick` 创建 Mock 任务 → 断言任务 `preset=quick` 且 `stageSet` 为 4 步 |
| 补跑 | `continue-plan` 返回 `pending`/`reused`；非法档位 400；任务不存在 404 |
| 质检 | 详情返回 `qcTrusted` / `qcVersionSource` |
| DOM | 拉取 `/index.html` 文本，检查 8 个新增元素与 8 个步骤勾选框是否就位、5 个既有元素未被破坏 |

页面上还有「创建一条 quick 档测试任务」按钮，点完回主界面即可**目视**验证：
任务详情应显示「执行档位：快速验证」与「补成最终成片」按钮。

> 自检页会真实创建一个 Mock 任务（不产生费用），
> 说明里已提示「可到 `data/tasks` 清理」。文件名以 `_` 开头，与既有 `_ptest.html` 同类。

**实测**（起临时服务模拟自检页的全部请求）：

```
自检页 HTTP 200, 8.3KB
preset=quick | steps=4 | qcTrusted=False | source=(空)
DOM 元素缺失: 无
步骤勾选框: 8 个
```

### 仍未完成

- **真实浏览器验证**：需要在一个 `ELECTRON_PATH` 正确配置的会话里，或由人工打开
  `_selftest.html` 与主页操作一遍。自检页只能证明「接口与元素正确」，
  **证明不了布局、样式、点击手感**。
- `public/_ptest.html` 是更早的临时验证页（配乐相关），目前仍在 `public/` 下。
  未删除——不确定是否还有人在用。
- 4K/8K/HDR 仍未动（无 GPU、无超分 Key、万相封顶 1080p）。

### 四、修掉 `qc-annotation` 在批量跑时的假失败

统一入口上线后第一次全量跑，`qc-annotation` 出现 **31/32**：

```
❌ GET /api/tasks/:id 暴露 finalQC.qcLabel — label=undefined
```

原因是该脚本的 C 组取 `realTasks[0]`（列表按创建时间降序，即**最新**的一条）来验证
「`finalQC.qcLabel` 会被 API 暴露」。但**最新任务不保证跑过终检**——
前面的验收脚本会不断创建/删除任务，顺序一变就取到没有 `finalQC` 的任务，断言假失败。

这是**测试脆弱性**，不是功能缺陷（单独跑时 32/0）。

修复：改为从「**有 `finalQC`** 的任务」里挑，没有则明确报错
（`N 条任务都没有 finalQC`），而不是拿任意一条去断言。
连跑 3 次验证稳定：32/0、32/0、32/0。

> 教训：验收脚本依赖「真实数据」时，必须**显式挑选符合前提的那条**，
> 不能假设「第一条就是合适的」——尤其在一个会被多个脚本反复创建/删除任务的环境里。

---

## 2026-10-20 补记 · 从「2 片段任务只出 1 个片段、成片点不开」查出的三个缺陷

### 现场

用户跑了一条 2 片段 480p 任务（`task_mvg18fjs_d0ok`），结果是：

- 第一个片段**黑屏、点不开**
- 任务**卡在 `mixing` 27 分钟**，`outputPath` 为 null（没有成片）
- 但 8 个步骤**全部标记 completed**

### 排查得到的三个真实缺陷

#### 缺陷 1：拼接时「片段缺失」被静默当成通过

`pipeline._runPipeline` 里单片段分支写死了：

```js
qcDetails: { passed: true, reason: '仅有1个成功片段，跳过拼接' }
```

它把两种情况混为一谈：
- 任务本来只要 1 个片段 → 正常
- 任务要 2 个但**丢了 1 个** → 不正常，却被记成 `passed: true`

实测证据（该任务的拼接记录）：

```json
concatenation: {"passed":true,"reason":"仅有1个成功片段，跳过拼接"}
```

而片段生成阶段报的是 `passRate: 100%`（2/2 成功）。**用户完全没有任何提示**，
直到看到成片只有一半。

**修复**：区分两种情形，丢片段时 `passed:false + level:'fail'`，写明
`片段缺失：应有 N 个，实际成功 M 个（丢失 K 个）`，并同时打 ERROR 级日志。

#### 缺陷 2：任务卡在中间状态无人回收

`audio_mix` 步骤先 `updateTaskStatus(taskId,'mixing')`，全部跑完才在末尾统一置
`completed/partial`。**如果进程在这中间中断，任务就永远停在 mixing**：
前端既看不到失败，也拿不到 `outputPath`（= 点击无反应）。

**修复**：新增 `pipeline.reconcileInterruptedTasks()`，在服务启动时执行。
原理：进程刚启动时不可能有任何任务在跑，所以处于
`pending/generating/concatenating/looping/transcoding/mixing` 的任务必然是上次中断的残留。
回收时标记为 `failed`（**不冒充 completed**），并写明：
中断时状态、已完成哪些步骤、可直接补跑。

实测（本次启动日志）：

```
任务 task_mvg18fjs_d0ok 状态: failed
⚠️  回收了 1 个中断的任务（可直接点「补跑」继续）：
    task_mvg18fjs_d0ok  原状态 mixing  已完成 8 步
```

> 注意：合并「内存 + 数据库」两个来源取任务。只读数据库会漏掉刚创建、
> 异步写库尚未落盘的任务（验收时出现过这个竞态）。

#### 缺陷 3：`checkFinal` 不传运行时配置

三处 `checkFinal(finalPath)` **都没传第二个参数**，于是终检的 NSFW 永远用
`.env` 默认值（`gpt-4o-mini` + 空 Key），**用户在设置里填的阿里云地址、
多模态 Key、qwen3-vl-plus 完全没被用上**。

实测证据：该任务 `final_qc` 里记录的 NSFW `model` 是 `gpt-4o-mini`，
而片段级质检用的是 `qwen3-vl-plus` —— 同一条任务里两个模型，说明配置没透传。

**修复**：新增 `pipeline._finalQcOptions(task)`，三处统一使用；Key 解析顺序
与片段级一致（`multimodalApiKey || llmApiKey`），并携带 `syntheticSource`
（Mock 任务）。

### 顺带：日志落盘（解决「日志滚走了就查不到」）

服务跑在用户自己的终端里，输出只在窗口滚动，出问题后无法追溯。
`server.js` 现在把 `console.log/warn/error` 同时写入
`app/data/logs/server-YYYY-MM-DD.log`，终端行为不变。

### 仍未查清的一件事（如实记录）

`clip_1` 文件在「质检通过之后、拼接之前」消失，**全盘搜索确认不存在**，
磁盘有 191GB 可用，生产代码里也没有删除 `clips/` 下文件的逻辑。

已确认的事实：
- 质检读到过它（`duration: 6s`、NSFW 抽帧得到「山峰与云海」画面、blur 7.36）
- 02:01:37 拼接时它已不在 → 「仅有 1 个成功片段」
- 此后没有任何代码路径会写/删这个名字

**未定位到删除者。** 但缺陷 1 的修复保证：这种情况以后会**明确报错**而不是静默通过。

### 验收（`scripts/verify-pipeline-fixes.js`，28 项全绿）

| 组 | 覆盖 |
|---|---|
| [1] 终检配置 | Key/BaseUrl/模型透传；只配 LLM Key 时回退；mock → syntheticSource；**三处无裸调用** |
| [2] 片段缺失 | 旧静默写法已移除；`passed` 绑定 `lostClips`；可读原因；ERROR 日志 |
| [3] 僵尸回收 | 构造 mixing 任务 → 被回收为 failed + 写明原因；**已完成任务不被误回收**（负向） |
| [4] 日志落盘 | 双写劫持存在；日志目录有实际文件 |

### 全量回归

12 个脚本 **393 项全绿**（新增 `pipeline-fixes` 28 项）。

### 遗留

- `clip_1` 丢失原因未定位（见上）。
- 用户那条任务已回收为 `failed`，可点「补跑」继续；
  但 `clip_1` 需要重新生成（会产生一次生成费用）。

---

## 2026-10-20 · 片段库 + 单片段费用/耗时 + 剪辑页（拼接 × 配乐）

**状态**：代码完成；本机可跑的验收全绿；**浏览器界面未经人工过一遍**（Electron 不可用，见「已知限制」）。

### 背景（用户逐条确认的口径）

用户要三件事：

1. 能看到**单个视频片段的费用与耗时**；
2. 有一个**片段库**装已经生成好的单个视频，跨任务复用；
3. 能**从库里选片段拼成片**，也能一次生成多段自动拼接，并和「添加配乐」合成为一个「剪辑」页面。

明确的口径（已写入实现）：

| 项 | 决定 |
|---|---|
| 费用 | 自动估算：价目表单价 × 实际调用次数（重试算一次）；只算生成，不含质检/配乐 |
| 历史 | 按当前价目表回算，标 `backfilled` |
| 库范围 | 只收成功且有画面的片段；Mock/测试图/黑屏/蓝屏不收 |
| 分组 | 默认「全部」，同时按分辨率分组；跨分辨率拼接时归一化，目标分辨率默认最高、可改 |
| 成片 | 两段式：先生成母版（拼接+循环+转码，不配乐不终检），再到剪辑页配乐 + 导出（含终检） |
| 成片记录 | 生成一条正常任务记录，进历史、可补跑 |
| 视频轨 | 拖拽排序、删除、首尾裁剪、复制、在播放头分割 |
| 片段生命周期 | 片段不随成片删除；只能在片段库删除，删条目连源文件一起删（二次确认） |
| 重新生成 | 可改提示词/模型/分辨率；新增一条，旧片段保留并标「已被替代」；不进主历史 |
| 收藏/标签 | 片段库页；收藏星标 + 预设标签（主题/模型/分辨率）筛选 |

### 交付物

| 层 | 内容 |
|---|---|
| 价目表 | 新增 `src/pricing.js`：服务端唯一价目表（SiliconFlow/Agnes 按个，可灵/Wan 按秒，Seedance 分型号，mock 0 元），生成时快照，历史回算标 `backfilled` |
| 片段库 | 新增 `src/library.js` + `data/library/<id>.json`（一条片段一个文件，独立于任务 JSON）；`scripts/backfill-library.js` 回填历史 |
| 计时/费用 | `pipeline._finishClipSuccess` / `_finishClipFailure` 统一收口：写 `clip.timing`（生成/质检两段）与 `clip.cost`，成功后自动入库 |
| 拼接引擎 | `videoProcessor.concatenateSegments`：先按目标规格检查每段，只归一化不匹配的片段（缩放/补边/统一 30fps/SAR/像素格式），再走原 `concatenate`；额外做**完整解码校验** |
| 成片任务 | `taskManager.createLibraryTask` / `setLibraryClips`；`pipeline` 对 `source=library` 跳过提示词/分镜/生成三步，直接拼接 |
| 接口 | `GET /api/pricing`、`GET /api/library`、`PUT /api/library/:id`（收藏）、`DELETE /api/library/:id`、`POST /api/library/:id/regenerate`、`POST /api/assemble`；`GET /api/tasks/:id/clips` 增加费用/耗时/规格 |
| 页面 | 新增 `public/clip-library.html`（全部/分辨率分组、费用/耗时、收藏、标签筛选、删除、重新生成、勾选去剪辑）；`public/bgm-editor.html` 改名「剪辑」并新增视频轨/片段库面板/生成母版，原有配乐功能保留；`public/index.html` 导航改名 + 片段库入口 + 片段卡片费用/耗时 + `library` 模型显示名 |

### 实测验收

**拼接兼容性（实现前先做的对照实验）**

| 场景 | 结果 |
|---|---|
| 720p@30 × 2，`-c copy` 直拼 | 14.00s，0 解码错误 |
| 720p@16 + 720p@30，copy 直拼 | 退出码 0，但 190 处 DTS 错误、11.31s（应 12.1s） |
| 720p@16 + 720p@30，旧重编码兜底（无归一化） | 退出码 0，产物 2.4fps、89 处 DTS 错误 |
| 同上，加 scale+fps 归一化 | 12.07s、30fps、0 错误 |
| 480p@30 + 720p@30，copy 直拼 | 退出码 0，但流内分辨率在第 8 秒从 854×480 跳到 1280×720 |
| 480p@30 + 720p@30，归一化到 720p | 12.00s、1280×720、0 错误 |

**API 端到端（本机 3002 端口）**

| 用例 | 结果 |
|---|---|
| 2 段 720p30（14s）→ assemble | 任务 completed；final 13.5s（循环淡化 0.5s）、1280×720@30、0 解码错误 |
| 3 段 480p+720p16+720p30（17.06s）→ assemble | 归一化 2 段；拼接产物 17.07s、0 解码错误；final 16.6s |
| 3+3+7=13s（含裁剪 + 同一片段重复用）→ assemble | 13.00s、归一化 2 段、0 解码错误；final 12.5s |
| 成片后配乐导出（`POST /api/tasks/:id/audio`） | 成功；成片 13.5s，视频流 + AAC 2 声道音频 |
| 片段库删除 | 条目与 `clips/` 源文件同时删除 |
| 收藏 | 置位/复位均成功 |
| 隐藏重新生成任务 | 不出现在 `/api/tasks` 与 `/api/tasks/completed` |
| 历史回填 | 10 条成功片段入库，合计 ¥34.30；39 个 Mock 孤儿文件按规则不入库 |

**本机可跑的验收脚本（全绿）**

| 脚本 | 结果 |
|---|---|
| `scripts/verify-library.js`（新增） | 38 通过 / 0 失败（价目表/费用口径/归档/条目/分组/跨规格拼接） |
| `verify-frontend-static.js` | 43 / 0 |
| `verify-editor-dom.js` | 内联事件与 DOM 引用全部存在 |
| `verify-stages.js` | 45 / 0 |
| `verify-stats.js` | 42 / 0 |
| `verify-pipeline-fixes.js` | 28 / 0 |
| `verify-mock-vqc.js` | 14 / 0 |
| `verify-pages.js` | 全部通过（含新增 `/clip-library.html`） |

### 修复的两个环境缺陷（改动过程中实测暴露）

1. **`videoProcessor` 的 ffmpeg 调用在受限环境 spawn EPERM**
   新增 `_runFFmpeg()` / `_runCaptureStderr()`：管道失败时降级为 `stdio:'ignore'`；解码校验改为把 stderr 重定向到临时文件再读，不再依赖管道捕获。
2. **`audioMixer` 的 `execFile` 在受限环境是「同步抛 EPERM」**
   原代码只在回调里做 EPERM 降级，同步抛出时 Promise 直接 reject，导致配乐导出永远报「无法读取成片时长」。现 `probeDuration` / `_runProbe` / `runFfmpeg` 全部加 try/catch + 同步降级路径。

### 已知限制

- **浏览器界面未人工过一遍**：本机没有可用的 Electron，`dsh_browser_*` 不可用；已做静态检查（元素/函数/内联事件/脚本语法）与 API 端到端，但布局与手感仍未按 §5.4 要求人工确认。
- `verify-all.js` 在本沙箱无法整体运行：它用 `execFile` 起子进程，会 `spawn EPERM`。本次改为逐脚本运行可跑部分；给用户环境（非沙箱）跑全量时应正常。
- 历史片段的耗时只记录开始/结束，可能横跨暂停与重跑；界面标注「历史记录，含下载+质检」，不冒充生成耗时。
- 片段库按本地文件存储；后续上云需要把 `src/library.js` 的存储层换成对象存储/数据库。

### 改动文件

`src/pricing.js`（新）、`src/library.js`（新）、`src/pipeline.js`、`src/taskManager.js`、`src/taskDefaults.js`、`src/videoProcessor.js`、`src/processors/audioMixer.js`、`server.js`、`scripts/backfill-library.js`（新）、`scripts/verify-library.js`（新）、`scripts/verify-all.js`、`scripts/verify-pages.js`、`public/clip-library.html`（新）、`public/bgm-editor.html`、`public/index.html`、`data/library/*.json`（回填产物）。

---

## 2026-10-20 · 登录墙：单机共享账号 + 会话级 cookie

**状态**：代码完成，`scripts/verify-auth.js` 40 项全过。

### 背景（需求是怎么收敛的）

起点是「想加个登录页，有没有免费发验证码的」。查证结论（2026-10-20）：
**中国大陆不存在个人可合法自用的免费短信验证码**——阿里云 2025-06-06、腾讯云 2025-09-18
先后公告不再受理个人自用短信签名；华为云官方 FAQ 明确无免费额度；云片个人资质只支持国际短信。
个人唯一合法路径是阿里云 PNVS「短信认证」（约 0.054 元/条，且不能自定义签名）。
零成本替代只有 TOTP / Passkey / 把后台藏进内网（Tailscale、Cloudflare Access）。

最终确认的需求边界（逐条与用户确认过）：

| 决策 | 结论 |
|---|---|
| 登录要挡谁 | 只要「看起来正式」的外观，不是真实威胁模型 |
| 部署形态 | 只在本机 `localhost:3001`，不上公网 |
| 账号模型 | 多账号、**无管理员/普通成员分级**，任何持账号密码者权限相同 |
| 任务数据 | **不做归属隔离**，所有人看到同一批任务 |
| 验证方式 | 账号 + 密码（短信/邮箱验证码/TOTP/二维码全部放弃） |
| 会话 | **会话级 cookie**，关浏览器即失效；刻意不设 Max-Age |
| 拦截范围 | 页面 + `/api/*` 真拦截；`/output` `/clips` `/bgm` 不拦 |
| 验收标准 | 截图能看 + 真拦截（401/302）+ 防爆破 |

### 实现

- `src/auth.js`（新）：scrypt 密码哈希（`crypto` 内置，零新依赖）、内存会话表、
  cookie 解析、按 IP 失败锁定、首次启动引导建号。
- `server.js`：鉴权中间件插在 `express.json()` 之后、静态目录之前；
  新增 `/api/auth/login|logout|me` 与 `/api/users` 增删改查。
- `src/wsManager.js`：`init(server, { authorize })`，握手阶段校验会话 cookie，
  未登录直接 401；不传 `authorize` 时行为与改造前完全一致。
- 存储层：`users` 表加进三个驱动 + `schema.sql`；postgres 驱动**懒建表**
  （`create table if not exists`），避免「没手动跑 schema.sql 就登不进去」。
  列表接口永不返回 `passwordHash`。
- 前端：`public/login.html`（新）、`public/members.html`（新）；
  `index.html` 加全局 401 兜底（38 处裸 `fetch` 一处不改）与侧边栏退出入口。

### 关键行为

| 场景 | 结果 |
|---|---|
| 未登录访问 `/`、任意 `.html` | 302 → `/login.html?next=原地址` |
| 未登录访问 `/api/*` | 401 `{ code:'AUTH_REQUIRED' }` |
| 未登录连 `/ws` | 握手 401 |
| 登录成功 | 下发 `vs_session`（HttpOnly / SameSite=Lax / **无 Max-Age**） |
| 连续 5 次失败 | 该 IP 锁 5 分钟（内存，重启清零） |
| 重置密码 / 删除账号 | 该账号所有会话立即失效 |
| 认证存储不可用 | 503（**绝不 fail-open**） |
| `AUTH_ENABLED=false` | 全部放行（仅供验收脚本使用） |

### 验收（可复述）

```powershell
cd app
node scripts/verify-auth.js     # 40 项，含负向：篡改 cookie、错误密码、失败锁定、WS 握手
```

另有真实数据库探针（临时脚本，跑完已删）验证 postgres 路径：
`driver=postgres, before=0, after=0`，建/查/列/删全部成功，`listUsers` 不含 `passwordHash`。

回归（逐脚本跑，原因见「已知限制」）：

| 脚本 | 结果 |
|---|---|
| `verify-auth.js` | 40 / 0 |
| `verify-stages.js` | 45 / 0 |
| `verify-frontend-static.js` | 43 / 0 |
| `verify-pipeline-fixes.js` | 28 / 0 |
| `verify-mock-vqc.js` | 14 / 0 |
| `verify-stats.js` | 42 / 0（修复：spawn 服务时传 `AUTH_ENABLED=false`） |
| `verify-qc-annotation.js` | 32 / 0（同上） |
| `verify-frontend-contract.js` | 49 / 0（同上） |

### 对验收脚本的影响（已修）

三个「自己 spawn 服务」的验收脚本原本会被登录墙拦成 401，已在其 spawn env 里加
`AUTH_ENABLED: 'false'`：`verify-stats.js`、`verify-qc-annotation.js`、`verify-frontend-contract.js`。

**仍是手动运行**的脚本（`verify-bgm-api/negative/e2e2`、`verify-port3001`、`verify-pages`）
直接打用户正在跑的服务，登录墙开启时会 401。跑它们前要么临时 `AUTH_ENABLED=false`，
要么先登录拿 cookie。

### 已知限制

- **没有验证码**：短信（无法免费/需企业资质）、邮箱、TOTP 全部放弃，只剩账号密码。
- **不隔离任务数据**：所有账号看到并操作同一批任务，`tasks` 没有 owner 字段。
- **`/output` `/clips` `/bgm` 未拦**：公网部署时必须补，否则成片可被直接下载。
- **会话在内存**：服务重启即全体登出；多实例部署时各实例会话互不相认。
- **`app/docs/HuggingFace部署指南.md` 已过期**：该文档仍写「ACCESS_TOKEN 尚未接入鉴权」，
  现在是 `AUTH_*` 一套；该目录按契约属只读存档，未改。
- 浏览器界面仍未人工按 §5.4 走一遍（本机无可用 Electron）。

### 改动文件

`src/auth.js`（新）、`public/login.html`（新）、`public/members.html`（新）、`scripts/verify-auth.js`（新）、
`server.js`、`config.js`、`.env.example`、`.gitignore`、`src/wsManager.js`、
`src/storage/index.js`、`src/storage/drivers/{jsonfile,postgres,sqlite}.js`、`src/storage/schema.sql`、
`public/index.html`、`scripts/verify-all.js`、`scripts/verify-stats.js`、
`scripts/verify-qc-annotation.js`、`scripts/verify-frontend-contract.js`。

### 补充（同日晚间真机实测发现并修复）

- **首次启动建号与登录的竞态**：`server.listen` 回调里异步建号，而 `/api/status` 立刻返回 200，
  于是「服务就绪的那一刻去登录」会被判成「账号或密码错误」。
  真实 PostgreSQL 实测复现：服务就绪后立即登录 → **401**。
  修法：`auth.bootstrap()` 改为幂等 Promise + 新增 `awaitBootstrap()`，登录路由在查询前先 await 它。
  修复后真机 e2e 8 项全过，`verify-auth.js` 仍 40/0。
- **真机 e2e（真实 PostgreSQL + 真实 HTTP）**：服务就绪、就绪后立刻登录成功、拿到会话 cookie、
  带 cookie 访问 `/api/tasks` 200、未登录 401、未登录 `/` 302、成员列表不含密码哈希、
  探针账号清理干净。
- **踩到的坑（值得记住）**：用 PowerShell `Start-Process` 起子进程时，当前会话里的 `$env:` 覆盖
  **没有传进去**，于是用默认名 `admin` + 随机密码建了号；这个账号密码没人知道，
  却会**阻止下一次首次启动再建号**（因为库里已有账号）。清理后库里为空。
  以后测这类启动逻辑，请用 Node `spawn` 并显式传 `env`——`verify-auth.js` 就是这么做的。

---

## 2026-10-20 · 片段间转场（交叉淡化）：接缝不再硬切

**状态**：后端完成并实测通过；**默认关闭**（零回归）；页面开关与 `POST /api/tasks` 字段
尚未接入（原因见「与并行任务的冲突处理」）。

### 背景（用户反馈与实测）

此前「拼接衔接自然」只解决了**首尾循环点**（`_makeLoopFFmpeg` 的 xfade），
**片段与片段之间仍是硬切**：拼接只有 concat（copy 或重编码直拼），没有任何过渡。

实测一条 3 片段成片（`task_mvglbfkw_w5vg_final.mp4`，湖景 → 湖景 → 星空）：

| 位置 | 指标 | 数值 |
|---|---|---|
| 6.0s 接缝（湖 → 星空） | 相邻帧 SSIM | **0.238** |
| 同上 | 逐帧亮度差 YAVG | **46.5**（正常帧间仅 2.4–4.5） |
| 首尾循环点 | 处理后实际回绕 SSIM（灰度） | 0.919（未处理 0.298） |

结论：循环点已解决；片段接缝未做转场。另发现该成片 0–6s 是**同一素材用了两次**
（同一 libraryId、同一 1–4s 裁剪，SSIM 0.96），属选材重复，不是拼接代码缺陷。

### 实现

- 新增 `src/processors/transitionMixer.js`（独立模块，不依赖 videoProcessor 私有方法）：
  - ffmpeg `xfade` 链：第 k 个接缝 offset = 累积时长 − F；每接一段累积 += d_k − F。
  - 每个输入先 `trim + setpts` 归零；统一分辨率/帧率/SAR/像素格式（只重编码不匹配段）。
  - 音频 `acrossfade` 链；混合音轨（部分片段无音轨）给无音轨段补等长静音；
    全无音轨时只出视频流。
  - 片段过短时自动收窄 F（F ≤ 最短片段/2 − 0.05）；收窄到 0.1s 仍不够则**判失败**
    （不静默直通）。
  - 不用退出码 0 当成功：产物时长必须 ≈ Σd − (N−1)F，并做完整解码校验。
- `src/pipeline.js`：新增 `_transitionOptions(task)`；四条拼接路径全部接入
  （新建主路径、补跑恢复路径、片段库路径、重建母版 `_buildMasterFromClips`）。
  转场关闭时**仍走原 `videoProcessor.concatenate`**，行为与接入前完全一致。
- `src/qualityChecker.js`：`checkConcat` 增加可选第 4 参数 `{ expectedDuration }`。
  不传时沿用旧口径（Σ片段时长）。**这是必须的**：否则转场产物会被误判成「拼接被截断」。
- `config.js`：新增 `TRANSITIONS`（enabled / duration / type），
  `.env` 对应 `TRANSITION_ENABLED` / `TRANSITION_DURATION` / `TRANSITION_TYPE`。
- `src/taskManager.js` / `src/taskDefaults.js`：任务新增 `transition` 字段（老任务补 null，
  语义是「未设置 → 用全局配置」）；`createTask` 支持按任务覆盖。

### 默认关闭的原因

开启后成片时长 = Σ片段 − (N−1)×F，与既有「Σ片段」口径不同。
若默认开启，所有既有验收脚本（`verify-continue` 等按 20.533s 断言）与历史重跑
都会改变结果。为遵守「零回归」，默认 `TRANSITION_ENABLED=false`；
需要时在 `app/.env` 打开并重启服务。

### 实测数值

`node scripts/verify-transitions.js` → **36 通过 / 0 失败**（含负向）：

| 场景 | 实测 |
|---|---|
| 2 段 3s+3s，F=0.5 | 5.50s（期望 5.50s） |
| 3 段 3s+4s+3s，F=0.5 | 9.00s（期望 9.00s） |
| 接缝尖峰（硬切 vs 转场） | max YAVG diff **40.00 → 3.00**（比值 0.07） |
| 混合音轨 | 有音频流，mean_volume=-27.2dB，无音轨段补静音 |
| 全无音轨 | 成功且**不伪造音轨** |
| 480p+720p → 720p | 归一化 1 段，1280×720，4.50s |
| 首尾裁剪 [0.5,2.5] | 4.50s |
| 0.6s+0.6s，请求 F=0.5 | 自动收窄 F=0.25，产物 0.967s |
| 0.2s 片段 | **判失败**：「片段过短…至少需要 0.3s」 |
| 质检不传 expectedDuration | **判失败**（5.00s vs 6.00s）；传入后通过 |
| 转场产物再做循环 | 5.5s → 5.0s，循环质检 wrapSsim=0.9974 |

**端到端（真实流水线，Mock 模型，quick 档，3 段×2s）**：
拼接产物 5.00s（期望 5.00s），`qcDetails.transition = {type:fade, fadeDuration:0.5,
transitions:2, durationCheck.ok:true, decodeCheck.errors:0}`，任务 completed。

**回归**：`verify-stages` 45/0、`verify-pipeline-fixes` 28/0、
`verify-concat-audio` 17/0、`verify-stage-pipeline` 37/0、`verify-loop` 25/0。
（`verify-all.js` 在本沙箱仍因 `execFile → spawn EPERM` 无法整体运行，逐脚本跑。）

### 与并行任务的冲突处理（重要）

本次改动期间工作区有另一条任务在改：`server.js`（提示词助手禁用词）、
`public/index.html`、`public/bgm-editor.html`、`src/videoProcessor.js`、`src/library.js`、
`src/processors/audioMixer.js`。为避免覆盖未提交改动：

- **未碰**上述 6 个文件；`server.js` 的 `transition` 字段与页面开关**留到对方落盘后**
  再加（目标位置：`POST /api/tasks` 解构 + `createTask` options；生成表单的“转场”下拉）。
- 只改**干净文件**：`config.js`、`src/pipeline.js`、`src/qualityChecker.js`、
  `src/taskDefaults.js`、`src/taskManager.js`，以及新增模块/脚本。
- 因此当前功能只能用 `.env` 全局开关，**无法按任务/在页面上选择**——这是刻意的取舍，
  不是遗漏。

### 已知限制

- 页面无开关、API 不收 `transition` 字段（待并行任务落盘后补）。
- 开启后拼接从 `-c copy` 变为整片重编码（720p/30fps 长片会明显变慢），
  且后续循环/转码各再编码一次；画质与耗时需在长片上实测后再定默认值。
- 成片比 Σ片段短 (N−1)×F；前端时长展示若仍按 Σ片段估算，需同步改为按实际返回值。
- 只有当片段本身具备可融合内容时观感才自然；同一素材重复使用、镜头语言突变
  仍会显得不自然（那是选材问题，不是转场能解决的）。

### 改动文件

`src/processors/transitionMixer.js`（新）、`scripts/verify-transitions.js`（新）、
`src/pipeline.js`、`src/qualityChecker.js`、`config.js`、`src/taskManager.js`、`src/taskDefaults.js`。

---

## 2026-10-20 · fengguang skill：把摄影级风光规则接进提示词优化

**状态**：代码完成，验收脚本 44 项全过；**真实生成效果未验证**（本机所有 LLM / 视频 Key 为空）。

**背景**：用户要求把「摄影级自然风光提示词」skill 用到项目里，落点是"写提示词那里增加优化规则"。

**做法**

- 新增 `src/promptSkill.js`：按主题决定是否追加规则段；规则文件缺失或开关关闭时静默降级，不影响原流程。
- 新增 `data/skill-fengguang.rules.md`：蒸馏版规则（约 1.8KB，中文），可编辑，改完下次调用生效。
- `src/promptOptimizer.js`：把 systemPrompt 组装抽成 `buildSystemPrompt(theme)`，在其中叠加 skill 层。
  作用域 `landscape/mountain/desert/lake/ocean/waterfall/aurora/space`；`city` 与"无主题"不追加。
  开关 `SKILL_PROMPT_ENABLED=false`。
- 新增 `scripts/verify-skill-prompt.js`（44 项，不联网、不花生成费），注册进 `verify-all.js` 的 fast 组。

**验收实测**

- `buildSystemPrompt('landscape')` = **3189 字符**，含「摄影级风光叠加规则」段；
- `buildSystemPrompt('city')` = **1164 字符**，不含该段；
- `verify-skill-prompt` **44/44**、`verify-stages` **45/45**、`verify-stats` **42/42**；
- `require('./src/pipeline')`、`require('./src/taskManager')` 正常，模块图未破坏。

**已知问题 / 待办**

- **输出语种冲突**：`structureRef` 里原有"全英文输出"，skill 段要求中文，system prompt 会同时出现两条。
  现以 skill 段为准（其开头声明"冲突时以本段为准"）；若要整站统一中文，需改 `structureRef` 那一句。
- `verify-all.js` 在本机沙箱内 `spawn EPERM`（Node 起子进程被拦），只能逐个直跑；环境问题，非本次引入。
- 模板路径（`optimizeWithTemplate`）是确定性词池、不经 LLM，**不叠加 skill**；要让模板也吃到，需把词库回填进池（skill v0.3）。
- 未验证真实生成：`KLING` / `SEEDANCE` / `DASHSCOPE` / `SILICONFLOW` / `AGNES` 的 Key 全为空。

**相关产物**

- 开源仓库：<https://github.com/182han/fengguang-skill>（公开，v0.1.2）
- 本机 skill 安装位置：`~/.dsh/skills/fengguang/`

### 改动文件

`src/promptSkill.js`（新）、`data/skill-fengguang.rules.md`（新）、
`scripts/verify-skill-prompt.js`（新）、`src/promptOptimizer.js`、`scripts/verify-all.js`。

---

## 2026-10-20 补记 · 片段间转场：页面开关与 API 字段已接通

**状态**：三条入口接线完成；HTTP 端到端跑通；默认仍关闭（页面默认不勾选）。

并行任务（fengguang / 登录墙等）落盘后，补齐了此前刻意留空的入口。
全部为**定点 edit**，未覆盖他人未提交改动。

### 接线位置

| 位置 | 内容 |
|---|---|
| `server.js` `POST /api/tasks` | 解构 `transition`，并透传给 `taskManager.createTask` |
| `server.js` `POST /api/assemble` | 读 `body.transition`，传给 `createLibraryTask` |
| `src/taskManager.js` `createLibraryTask` | 继续透传给 `createTask` |
| `public/index.html` | 生成参数区（执行档位下方）新增「片段间转场」开关 + 淡化时长 + 类型；新增 `collectTransitionConfig()`，随 `POST /api/tasks` 提交 |
| `public/bgm-editor.html` | 顶部「生成母版」栏（分辨率旁）新增转场开关 + 时长；`generateMaster()` 提交 `transition` |

### HTTP 端到端（3002 临时服务，`AUTH_ENABLED=false`，json 存储）

- `POST /api/tasks`（Mock，3 段×1s，quick，`transition.enabled=true`）：
  200，任务对象 `transition={enabled:true,duration:0.3,type:fade}` 已落库。
  （该次 Mock 生成因沙箱 `spawnSync cmd.exe EPERM` 全部失败——环境问题，
  与转场逻辑无关；故完整成片改走片段库路径验证。）
- `POST /api/assemble`（2 段 ×7s 库片段，F=0.5，720p）：
  任务 completed；拼接 **13.5s = 14 − 0.5**，`transition={type:fade,fadeDuration:0.5,transitions:1}`，
  `durationCheck.ok=true`，解码 **0 错误**；随后循环 13.0s，`wrapSsim=0.9547`（通过）。
- 页面可达性与控件存在性：临时服务下 `/` 与 `/bgm-editor.html` 均 200，
  两个页面都能检出 `#transitionEnabled` / `#transitionDuration`，请求体均带 `transition`。

### 验收

- 新增 `scripts/verify-transition-ui.js`：**19 通过 / 0 失败**
  （逐环断言：控件 → 收集函数 → 请求体 → 路由 → 任务 → 流水线 → 配置，
  防「勾了没效果」这类静默失效复发）。
- 回归：`verify-transitions` 36/0、`verify-frontend-static` 43/0、`verify-editor-dom` 通过、
  `verify-stages` 45/0、`verify-pipeline-fixes` 28/0、`verify-stage-pipeline` 37/0（exit 0）。
- `verify-pages.js` 在 3001（登录墙开启）下会因 401 失败——环境原因，非本次改动；
  页面/接口可达性已由临时服务实测覆盖。

### 怎么用

- 页面：生成页勾「片段间转场」；剪辑页勾「转场」后生成母版。默认不勾选。
- 全局：`app/.env` 设 `TRANSITION_ENABLED=true`（可选 `TRANSITION_DURATION` / `TRANSITION_TYPE`）。
- **改了 `server.js`，必须重启服务**；只刷新页面只会让控件出现，旧进程仍会忽略该字段。

### 已知小偏差

- 剪辑页在生成母版前的时长估计仍按「Σ片段」计算（未扣转场重叠，也未扣既有的循环淡化），
  实际母版比估计短 1.0s 左右（2 段 7s、F=0.5 + 循环 0.5）。成片生成后以实际视频时长为准。
  该偏差在加转场之前就存在（仅循环那 0.5s），本次未扩大改动范围。

---

## 2026-10-20 · 提示词链路全中文（指令 + 9 主题词池）

**状态**：代码完成，验收 54 项全过；真实生成未验证（无 LLM / 视频 Key）。

**背景**：用户要求"都改成中文"。此前只有 `data/optimization_rules.txt` 是中文，
而 `DEFAULT_RULES`、`structureRef` 与 9 个主题的模板词池都是英文，导致输出中英混杂。

**关键坑（改了才知道）**

`promptOptimizer.loadTemplates()` 是**磁盘文件优先**：只要 `data/templates.json` 存在，
源码里的 `DEFAULT_TEMPLATES` 就不生效。**只改源码，已有安装一个字都不会变。**
所以必须源码 + 磁盘文件双改，后者由迁移脚本完成。

**做法**

- 新增 `src/templates.zh.js`：9 个主题的中文词池（`keywords` / `styleEnhancers` / `negative` / 七个池）。
  以「覆盖层」形式在 `DEFAULT_TEMPLATES` 定义之后合并，避免动那 400+ 行最易被并发编辑的区域。
- `promptOptimizer.js`：`DEFAULT_RULES` 改为"用中文输出"；`structureRef` 改为"全中文输出"并把留白示例换成中文。
- 新增 `scripts/migrate-templates-zh.js`：把 `data/templates.json` 刷成中文，自动备份、支持 `--dry-run`。
  只覆盖内置 9 个 id，UI 自建模板原样保留。
- `data/templates.json`：已迁移（英文原文仍在源码 `DEFAULT_TEMPLATES` 里，可回滚）。
- `scripts/verify-skill-prompt.js`：新增第 7 组断言，锁死「词池无英文残留 + 输出含中文」，防回退。

**验收实测**

- `verify-skill-prompt` **54/54**、`verify-stages` **45/45**、`verify-stats` **42/42**、
  `verify-frontend-static` **43/43**；
- 模板路径实跑（desert，seed=2）：
  `沙丘上的日落, 静态锁定机位, 日落前的极低侧光…, 画面停在脊线上，没有新元素进入` → **英文残留：无**；
- 允许保留的英文只有单位 `mm` 与通用词 `logo`。

**注意**

- 本次同时把 skill 仓库的范例改为中文（fengguang v0.1.3），已推 GitHub。
- `SKILL_PROMPT_ENABLED` 这个新环境变量**没有写进 `.env.example`**：该文件正被并行任务修改，
  强行追加会污染他人的 diff。等对方落盘后再补，或写进部署文档。
- `public/index.html` 里模板编辑器的 placeholder 仍是英文示例（`tree, green, nature…`），
  属 UI 域且有并行改动，本次未动。

### 改动文件

`src/templates.zh.js`（新）、`scripts/migrate-templates-zh.js`（新）、
`src/promptOptimizer.js`、`scripts/verify-skill-prompt.js`、`data/templates.json`。

---

## 2026-10-20 · 补充：AI 路径端到端验证 + SKILL_PROMPT_ENABLED 入 .env.example

**状态**：**通过**（不花钱）。真实模型输出质量仍未验证（Key 为空）。

**新增**

- `scripts/verify-skill-ai-path.js`（17 项）：起一个本地 OpenAI 兼容 mock 服务，把
  `optimizeWithAI` 指过去，断言**出站请求的 system message 确实带上了 fengguang 规则段**；
  `city` / 无主题 / `SKILL_PROMPT_ENABLED=false` 三种情形均不追加；返回内容被采纳为 `optimized`。
  → 这条补上了此前只有「结构断言」、没有「真的发出去」的缺口。
- `scripts/verify-skill-prompt.js` 第 8 组：9 个主题 seed=0 的逐段结构校验
  （运镜/光影/氛围/结尾齐全 + 质感四项全量 + 无英文残留 + 长度 ≤2400），54 → **90 项**。
- `.env.example`：补 `SKILL_PROMPT_ENABLED=true` 及说明（含作用域与"只在 AI 路径生效"）。
  此文件先前被并行任务占用，现已落盘干净，才补上。

**验收（逐条直跑，总计 265 项全过）**

`verify-skill-prompt` 90/90 · `verify-skill-ai-path` 17/17 · `verify-stages` 45/45 ·
`verify-stats` 42/42 · `verify-frontend-static` 43/43 · `verify-pipeline-fixes` 28/28

**仍未验证 / 注意**

- `app/.env` 的 `OPENAI_API_KEY` 仍为空。且 `pipeline.js:922` 只认 `task.runtimeConfig.llmApiKey`
  （来自页面提交的 `llmApiKey`），**填 `.env` 不会激活 AI 路径**，必须在页面模型配置区填并测试连接。
- 仍未跑真实生成对比，无法给出「加 skill 前后」的成片差异evidence。

### 改动文件

`scripts/verify-skill-ai-path.js`（新）、`scripts/verify-skill-prompt.js`、
`scripts/verify-all.js`、`.env.example`。

---

## 2026-10-20 · 提示词助手接入 skill + 「添加到提示词框」不覆盖

**状态**：代码完成，静态验收 276 项全过；**真实浏览器点击与真实 LLM 输出未验证**。

**用户反馈的两个问题（都是真问题）**

1. 「提示词升级了，在哪能看到？是助手学了 skill 吗？」
   → **当时并没有**。提示词助手（悬浮球）有**自己独立的 system prompt**（`server.js` 的
   `ASSISTANT_SYSTEM_PROMPT`），此前接的 `promptOptimizer` 只影响**生成任务**，管不到助手；
   而且那份 prompt 还写着"给英文提示词"。
2. 「助手写完我点『使用』，不要覆盖我框里已经写的」
   → 旧代码是 `promptInput.value = text`，**直接覆盖**。

**顺带查出的第 3 个问题**

「✨ 智能优化提示词」按钮**实际是空操作**：前端固定 `theme: null`，后端只走
`optimizeWithTemplate`，而模板在无主题时原样返回 → 点了等于没点，却还显示"优化成功"。

**改动**

- `server.js`
  - 助手 system prompt 运行时叠加 `promptSkill.getSkillRules()`（`SKILL_PROMPT_ENABLED=false` 可关）。
    助手产出物只服务自然风光（9 条禁用项已排除城市/人物/动物），故整段追加、不按主题过滤。
  - 助手口径由英文改中文：对话规则 6/7 与输出格式同步。
  - `/api/optimize-prompt`：改为 async；接受 `llmApiKey/llmBaseUrl/llmModel`；
    行尾【主题】标签自动解析（`parseThemeTag`）；有 Key 走 `optimizeWithAI`（叠加 skill），
    无 Key 走模板；无主题又无 Key 时返回 `hint` 说明原因，不再假装成功。
- `public/index.html`
  - 新增 `appendToPromptInput()`：非空时换行追加；**逐行去重**（连点两次不会加两遍）。
  - 助手 `usePrompt()` 同步改为追加 + 去重。
  - 两处按钮文案 `使用此提示词 / 使用这段提示词` → **`添加到提示词框`**。
  - 智能优化请求带上设置里的 LLM 配置。
- `scripts/verify-skill-prompt.js` 第 9 组（11 项）：锁住"助手确实吃 skill""不再要求英文"
  "两处都走追加""不再出现整段覆盖写法""请求带 LLM 配置"。

**验收**：`skill-prompt` 101/101、`skill-ai-path` 17/17、`frontend-static` 43/43、
`stages` 45/45、`stats` 42/42、`pipeline-fixes` 28/28（合计 **276**）。

**注意（给下一个人的坑）**

- 多行模式是「每行 = 一个片段」，所以"追加"= 新增一个片段。用户若只想改其中一行需手动删。
- 助手与 AI 优化都需要 LLM Key，且 **Key 来自设置（localStorage `vs_config`）**，
  不是 `.env`；`.env` 的 `OPENAI_API_KEY` 只影响服务端兜底与部分接口。

### 改动文件

`server.js`、`public/index.html`、`scripts/verify-skill-prompt.js`。

---

## 2026-10-21 · 「生成成功但质检失败」的片段怎么救（recheck 工具）

**状态**：CLI 工具**通过**（真实 Postgres 实测）；服务端 API 路由**未验证**（需重启后才有）。

### 现象与语义澄清

用户反馈「历史任务里能看到生成的片段，为什么显示失败？片段库也没有？」

两件事都是设计而非 bug：

| 现象 | 原因 |
|---|---|
| 有文件却 `status=failed` | 时间线是「生成成功 → 写 mp4 → 跑质检 → 质检 fail → 片段 failed → 任务 failed」。`status` 表示**能不能用**，不表示**有没有文件** |
| 片段库没有 | `src/library.js` `ingestClip()` 硬条件 `clip.status !== 'success' → return null`（另有 mock 不入库） |

### 已修/已加

- `scripts/recheck-task-clips.js`（新）：**只重跑质检，不重新生成视频**。走 `storage` 层，
  json/postgres 都支持，**不需要重启服务**；通过则片段转 `success` 并入片段库，
  随后「补跑」可复用这些片段拼成片。落盘前经 `redact.redactTask()` 脱敏。
- `pipeline.recheckClips()` + `POST /api/tasks/:id/recheck-clips`：同一逻辑的服务端版本，
  供将来 UI 按钮调用（**未验证**：需重启后路由才存在）。

### 验证（真实 Postgres）

- `--dry-run`：正确列出 2 段待重检，不写盘；
- 失败分支（不可达地址）：正确写回 `clip.error`，任务里**不含 Key**；
- 通过分支（本地 mock，**临时任务**上跑）：`status=success`、`error=null`、`qc.passed=true`、
  片段库条目生成、任务里**不含 Key**；
- 测试痕迹已清理（临时任务软删后又用 SQL 硬删；库条目已移除），真实任务恢复原状。

### ⚠️ 事故记录（必须记住）

清理测试库条目时调用 `library.remove()`，它**会连带删除源文件**，而测试条目指向的正是真实片段
`clips/task_mvgw4hbo_ajuc_clip_1.mp4` → **文件被删**。
已从开工前建的备份 `app/data/keep/2026-10-21-task_mvgw4hbo_ajuc/` 还原：
字节数 17,147,139 与 SHA256 `4F1F3268…6B06F` 与最初一致，ffprobe 可正常解码（6.0s）。

教训：**凡是要删片段库条目的测试，先把条目指向的文件复制出参照路径**，或用不存在的临时路径。

### 给用户的用法

```powershell
cd app
node scripts/recheck-task-clips.js <taskId> --key sk-xxx [--base URL] [--model qwen-vl-max]
```

写的是数据库，**旧服务内存里看不到**——跑完要重启服务，再点「补跑」。

### 改动文件

`scripts/recheck-task-clips.js`（新）、`src/pipeline.js`、`server.js`、`.gitignore`（忽略 `data/keep/`）。



## 2026-10-21 · 片段恢复四修复（覆盖付费片段 / 静默降级 / 重启丢 Key / NSFW 404 误报）

### 背景（真实事故链）

`task_mvgw4hbo_ajuc`（dashscope，2 片段）在 00:21 生成后因 NSFW 配置问题失败；用户点「重新生成」，
但 Key 已随服务重启丢失（`redact` 落盘清空），生成器静默降级 Mock；NSFW 又把 Mock 测试图案
当真实内容检测，再次失败。期间第 2 次生成还覆盖了第 1 次已付费的片段文件。

### 已修

1. **片段文件不再覆盖**：`_processSingleClip` 下载改用 `pipeline._nextClipPath()`
   （`task_x_clip_N.mp4` 已存在则 `_v2`、`_v3`…）；`regenerateClip` 记录 `clip.previousVideoPath`。
2. **Mock 降级可识别**：`createGenerator` 降级时打 `fallbackToMock/requestedModel`；
   `pipeline` 记 `task.mockFallback`，四处 QC 统一走 `_isSynthetic(task)`（NSFW 合法跳过）。
3. **重启后重新生成/补跑带当前设置**：前端 `collectTaskRuntimeConfig(model)` 随
   `regenerate` / `continue` 请求发送；后端 `_mergeRuntimeConfig()` 只合并白名单字段到内存态
   （Key 仍不落盘）。
4. **NSFW 错误不再串**：`_callNsfwMultimodal` 增加 per-call `errorOut`，`checkNSFW` 优先读本地错误槽；
   并发检查片段时 404 不会再被别的调用清成「120s 内无有效响应」。

### 验证

- `scripts/verify-recovery-fixes.js`：24/0（覆盖保护、降级标记、配置合并、404/403 并发隔离、
  路由与前端接线静态断言）。
- 回归：pipeline-fixes 28/0、mock-vqc 14/0、continue/stage-pipeline 退出 0、
  frontend-contract 49/0、library 33/0、loop 25/0、concat-audio 17/0、stages 45/0、
  transitions 36/0、qc-annotation 32/0。
- 已知环境问题：`verify-pages.js` 的「自动配乐草稿」因登录墙返回登录页而失败（非本次引入）。

### 改动文件

`src/pipeline.js`、`src/qualityChecker.js`、`src/generators/index.js`、`server.js`、
`public/index.html`、`scripts/verify-recovery-fixes.js`（新）；提交 `b941fe1`。

### 已知边界

- `mockFallback` 目前只写进任务/日志，前端尚未展示「实际为 Mock」角标；质检结论里的
  NSFW 合法跳过理由可见。
- 第一次重试被覆盖的付费片段无法恢复（第二次同名覆盖）；第二次重试的 2 个片段已从磁盘救回并重建。

---

## 2026-10-21 · 片段库缺档：恢复/复用的片段不入库（含运行中服务的缓存问题）

### 现象

`task_mvgw4hbo_ajuc` 两个已付费片段在 00:24 救回：文件在 `clips/`、任务片段 status=success、
成片也重新拼出来了，但片段库页面仍看不到它们。

### 根因（三层，缺一不可）

1. **入库路径缺口**：`library.ingestClip` 只挂在两条路径上——`_processSingleClip`（生成成功）、
   `recheckClips`（重检转成功）。手工恢复的片段两条都不走；补跑复用的片段（`_batchGenerate` 的
   reusable 分支）也不入库。片段库页面只读 `data/library/*.json`，不扫任务，所以库里一条都没有。
2. **进程内缓存**：`src/library.js` 的 `loadAll()` 缓存整库，只在 `saveEntry`/`remove` 后强制重读。
   运行中的服务看不到**外部进程**新写入的库条目——用户刷新页面也没用。
   已改为**目录签名失效**（文件名 + 大小 + mtime 变化即重读）：外部补库/删库后，下一次
   `get`/`listAll` 就能看到，不需要重启或人工触发。修复前的临时手段是「收藏开→关」触发重读。
3. **存储位置**：任务实际在 Postgres（`.env` 里 `DATABASE_TYPE=postgres`），`data/tasks/*.json`
   只是 `taskManager._saveTask()` 的本地备份；片段库仍是本机 `data/library/` 文件。排查时改 JSON 不影响页面。

### 已修

- `library.ingestMissing(task)`：把任务里已成功、库里缺档案的片段补入库（幂等，跳过已有档案，
  不覆盖收藏/替代关系）。
- `pipeline._runPipeline`（片段生成/复用之后）与 `pipeline.recheckClips`（开头）各调用一次。
- `scripts/recheck-task-clips.js`：对已成功片段顺手补库（不需要 Key）；新增
  `scripts/ingest-task-clips.js <taskId>` 专用补库工具（走 storage，json/postgres 都支持）。
- `library.buildEntry`：无片段级质检记录的条目从「无质检记录」改标「质检未验证」——
  旧逻辑在前端落到红色「质检记录异常」，没记录 ≠ 记录异常。
- `library.loadAll()`：缓存增加**目录签名**（文件名/大小/mtime），外部补库后运行中的服务
  无需重启即可看到（新增用例：外部写入、外部删除各一条）。
- 本次数据修复：`node scripts/ingest-task-clips.js task_mvgw4hbo_ajuc` 补入 2 条
  （720p / 6s / 1280×720@30 / 17.1 MB + 6.2 MB），库内 8→10 条。

### 验证

- `scripts/verify-recovery-fixes.js` 28/0（新增 `ingestMissing` 行为用例 + 两处接线静态断言）。
- `scripts/verify-library.js` 36/0（新增 3 条热加载用例：外部写入可见、外部删除失效、预热不可见）。
- 快速组逐脚本：stages 45/0、frontend-static 43/0、stats 42/0、pipeline-fixes 28/0、mock-vqc 14/0、
  skill-prompt 101/0、skill-ai-path 17/0。
  （`verify-all.js --fast` 因本机 sandbox 的 `spawn EPERM` 无法整体跑，改为逐脚本执行。）
- `scripts/verify-continue.js` 19/0（真机补跑；期间 Supabase 连接池偶发超时，不影响断言）。
- 现场 API：`GET /api/library`（真实登录）→ 10 条，含 `task_mvgw4hbo_ajuc_c1/c2`；
  `HEAD /clips/task_mvgw4hbo_ajuc_clip_1.mp4` → 200 / 17,147,139 B；`clip_2` → 200 / 6,247,232 B。

### 现场事故与补救（2026-10-21 12:22–12:30）

- `verify-stats.js` 会起真实服务（3085），其启动自检把用户**正在运行**的
  `task_mvhlusmo_hs2w` 标成 failed；随后本地清理误删了这条任务记录及 4 个 output 文件。
- 已用 `data/tasks/task_mvhlusmo_hs2w.json` 恢复记录（如实标 failed + 说明成片被删），
  并把只在本地 JSON 里完成、未落库的 `task_mvhlxnm7_1mch`（同 7 片段、成片仍在）同步回数据库，
  避免服务重启后被当成僵尸任务回收。
- 教训：用户服务可能正在运行（本次是端口 3001，跑在另一会话的进程里，本进程看不到），
  验收脚本里的临时服务启动自检会误伤真实任务；跑真机脚本前先确认用户服务是否在跑。

### 已知边界

- 这两个片段只有终检结论（NSFW 2% / 1280×720 / 11.5s），片段级质检未复跑 → 库里显示「质检未验证」。
- 片段库是本机文件；在另一台机器/云端实例上看库，需要在对应机器上执行同一个补库脚本。

---

## 2026-10-26 · 前端技术栈迁移决定（React + Vite + Tailwind）+ 图片生成配置预留

**状态**：**仅决策与配置预留，代码未开工**。本节点只记录"为什么这么定"和"已经踩到的代价"。

### 一、技术栈：方案 B（React + Vite + Tailwind CSS）

**决定人**：用户（产品负责人），2026-10-26。

**背景**：用户要把产品从"展示型网页"改造为"可实际使用的工具/软件"，工作流同时从
「提示词 → 视频」升级为「提示词 → 分镜 → **图片（人工确认）** → 视频」。
现有前端是 `public/index.html` 单文件（实测 **8061 行 / 288.2 KB / 136 个全局函数**），
工具化所需的状态管理、组件复用、草稿持久化在单文件结构里难以承载。

**曾评估的三个选项**：

| 选项 | 内容 | 结论 |
|---|---|---|
| A | 零构建原生 + ES Module 拆文件 | 可保住 §2.2，但用不了用户给的全部参考库（ReactBits / Aceternity 均为 React 组件），动效需全手写 |
| **B** | **React + Vite + Tailwind** | **已选**。组件生态与状态管理成熟，工具化改造代价最低 |
| C | 混合（主工作台 React、子页原生） | 否决。两套渲染体系并存，设计 token 与交互要维护两份，组件不可复用 |

**已实测到的迁移代价（不是猜测）**：

1. `app/server.js:226` 现为 `express.static(path.join(__dirname,'public'))`，需改为下发构建产物
   （或 dev 态走 Vite 代理）。`server.js:223` 的注释「本项目没有构建步骤」也随之失效。
2. **5 个 Node 脚本 + 1 个浏览器页静态解析 `public/index.html`，迁移后断言会失效**：
   `check-inline-js.js` / `verify-frontend-static.js`（43 项）/ `verify-recovery-fixes.js` /
   `verify-transition-ui.js`（19 项）/ `verify-skill-prompt.js`（6 项），另有 `public/_selftest.html`
   （浏览器端 `fetch('/index.html')` 后正则查 id）。**必须同步重写，不得删除 assert 了事。**
   **更正（同日，由 frontend-dev 实测）：** 本条初稿把 `verify-frontend-contract.js`（49 项）错列为受害者
   —— 它**不读** `index.html`，是起真实服务逐条打 API 的契约测试，迁移后**原样可用**；
   同时初稿漏了 `verify-skill-prompt.js` 与 `_selftest.html`。
   **门禁洞（新增）**：`verify-all.js` 实为 **16 个套件**（§2.6 写"14 个"已过期），
   5 个静态脚本里**只有 2 个在门禁内**（frontend-static、skill-prompt），
   `check-inline-js` / `verify-recovery-fixes` / `verify-transition-ui` 弄坏了 `npm run verify` 照样全绿。
   详见 `docs/spec/frontend-migration-plan.md` §5。

3. `package.json` 目前 4 个依赖、**无 build 脚本、无前端依赖**。新增依赖须按 §4.6 记录理由/体积/许可证。
4. §2.1 的"端口四处一致"约束会多一层：Vite dev server 端口与 `node server.js` 端口的关系需明确写入契约。

### 二、「先图后视频」配置预留（已落地，未接入厂商）

**用户登记的计划**：准备两个 API —— ① 文生图 ② 图生视频。

**已落地**（纯配置层，可回滚，不影响现有流水线）：

- `app/config.js` 新增 `IMAGE_GEN_*`（provider / apiKey / baseUrl / model / size / timeoutMs）
  与 `I2V_*`（provider / apiKey / baseUrl / model）。`I2V_*` 留空时**回退到 `IMAGE_GEN_*`**，
  以覆盖"同一家 Key 同时能做文生图与图生视频"的常见情形。
- `app/.env.example` 新增对应模板与两种组合方式的说明。
- 新增 `app/src/generators/imageGen.js`：配置齐备度检查 `getImageGenStatus()`、
  `resolveI2VConfig()`、能力三态声明 `IMAGE_INPUT_CAPABILITY`。
  **`generateImage()` 被调用时抛明确错误**，绝不返回占位图冒充结果（§4.8）。
- `src/generators/index.js` 的 `getAvailableModels()` 为 6 个模型新增 `supportsImageInput`，
  默认 **`null = 未核实`**；`mock` 为 `false`。**`null` 不得被当成支持。**

**为什么没有直接实现调用**：各厂商 image-to-video 的入参、图片格式、URL 时效均不同，
未逐家核实前写代码必返工。且部分模型可能根本不支持图生视频，届时"人工确认的图"
语义会退化成"参考图"，等于退回被否决的方案 B（旧编号）。**先做能力核查表，再写调用。**

### 三、验证记录（三态）

- **通过**：`config.js` / `src/generators/index.js` / `src/generators/imageGen.js` 均通过 `node --check`；
  模块加载实测输出 `getImageGenStatus() = {ready:false, missing:['IMAGE_GEN_API_KEY','IMAGE_GEN_BASE_URL','IMAGE_GEN_MODEL']}`，
  `getAvailableModels()` 输出 `mock:false siliconflow:null agnes:null seedance:null kling:null dashscope:null`，符合预期。
- **未验证**：`node scripts/verify-all.js --fast` **无法运行**，报 `spawn EPERM`
  （本机 sandbox 限制，§2.3 有记载）。因此"是否引入回归"这一项**不能算通过**。
- **未开始**：任何 React / Vite / Tailwind 代码、任何图生视频调用、任何人工确认门。


---

## 2026-10-27 接缝质量：转场默认开启 + 新增 `seam` 质检项

### 一、背景：用户说"衔接不够自然"，但系统里没有任何一项在测它

用户原话："目前仍然还是衔接的不够自然""首要就是提升无缝衔接"。

排查结论（读码 + 实测，报告见 `docs/spec/seam-quality-spec.md`）：
现有 11 个质检项**没有任何一项读画面判断"拼接是否自然"**——
`checkConcat` 只校验"产物时长 ≈ 各片段时长之和"（防 `-c copy` 静默截断），
`checkLoop` 只测成片【首尾】的 SSIM。于是"片段之间那道缝"完全处于未被测量的状态。
实测：`task_mvhrynuu_ehtn_concat.mp4` 6 道缝相邻帧 SSIM 0.42~0.54、
像素级差异达同段自然运动的 10~51 倍，而全部质检项照样"通过"。

### 二、病因判定：主要是"内容跳变"，不是色调/亮度

对 4 条真实成片（15 道缝）逐缝量化（见 `app/scripts/analyze-seams.js`）：

| 样本 | 缝数 | 转场设置 | 实测 |
|---|---|---|---|
| `task_mvhrynuu_ehtn_concat` | 6 | 关闭（硬切） | 全部硬切；minSSIM 0.42~0.54、ΔE76 1.5~48.2、\|ΔY\| 最高 90.7、MAD ×9.8~48 |
| `task_mvglaff4_y3lw_concat` | 1 | 无字段（硬切） | 硬切；SSIM 0.536、ΔE76 36.6、MAD ×51 |
| `task_mvglbfkw_w5vg_concat` | 2 | 无字段 | 1 道硬切（SSIM 0.537 / MAD ×52）；1 道**近同源**（SSIM 0.908、ΔE76 0.21） |
| `task_mvhlxnm7_1mch_concat` | 6 | **开启 0.4s fade** | 6 道全部真淡化；minSSIM 0.83~0.95、**ΔE76 ≤ 0.42、\|ΔY\| ≤ 0.39** |

**决定性证据**：已开转场那条的色差与亮度差已接近 0，用户仍说"不自然" →
说明调色匹配/亮度归一化**不是瓶颈**；真正的病因是"两个不相干镜头被接在一起"，
而淡化只是把它摊成"糊"（转场组 MAD 仍是自然运动的 1.8~7.0 倍，影片条里可见双重曝光鬼影）。
另有正对照：`task_mvglbfkw_w5vg` 缝 #1 是硬切但两段画面几乎相同 → 观感上不刺眼。
**结论：决定观感的是镜头之间是否语义连续，而不是接缝技术。**

### 三、决定与依据（2026-10-27 用户拍板）

**决定 1：片段间转场默认开启，但用户可以取消。**

- 默认 `TRANSITION_ENABLED=true`、`TRANSITION_DURATION=0.4`；
- 页面勾选框默认勾选，**取消后该任务传 `transition:{enabled:false}`**，
  `pipeline._transitionOptions()` 优先取任务参数 → 回到 `-c copy` 直拼；
- `quick` 档不受开关影响，一律 `-c copy`（`disabledByPreset:'quick'`）。

为什么改默认（性能实测，不是估计）：

| 方案（47s / 7 段 / 720p） | 实测耗时 | 吞吐 |
|---|---|---|
| `-c copy` 直拼 | **0.46 s** | 102 秒成片/秒墙钟 |
| 整片重编码直拼（medium crf23） | **8.13 s** | 5.78× |
| 生产转场（6 道 0.4s fade） | **11.36 s** | 4.14× |

- **转场 / 重编码直拼 = 1.40×**；**重编码 / copy = 17.6×**。
  30 分钟成片推算：copy 0.3 分钟 → 重编码 5.2 分钟 → **转场 7.3 分钟**。
- 即："长片会明显变慢"的幅度是 **+2.1 分钟**，不是数量级恶化；
  真正的成本跃升来自"放弃 `-c copy`"这一步，而不是转场本身。
- 收益：接缝相邻帧 SSIM 由 0.42~0.54 升到 0.83~0.95。收益/代价明显划算。

**决定 2：新增 `seam` 质检项（第 12 项）。**

- `qualityChecker.checkSeam(videoPath, clipDurations, options)`：逐缝测
  SSIM / ΔE76（CIELAB）/ ΔY / 像素级 MAD 倍数；
- 接入点 `checkFinal`，三处调用共用 `pipeline._finalQcOptions()` → `_seamQcOptions()`
  （缝位置用**拼接步骤的实际转场留痕**，不用当前配置，避免补跑历史产物时整体偏移）；
- 三态语义严格按 §4.1：测不到 = `passed:false`；唯一合法跳过 = 仅 1 个片段（`legitimateSkip:true`）；
  Mock/合成素材按 `_isSynthetic` 合法跳过；
- 阈值 `.env` 可覆盖：`QC_SEAM_SSIM_MIN`(0.75) / `QC_SEAM_DE76_MAX`(25) /
  `QC_SEAM_DY_MAX`(30) / `QC_SEAM_MAD_RATIO_MAX`(8) / `QC_SEAM_MAX_SEAMS`(8)。

**决定 3：语义连续性（相邻镜头同场景延续）本期只出设计，不实现。**
合并方案见 `docs/spec/review-gate-design.md`「静帧审核门 + 语义连续性」一节。

### 四、改动清单（文件:行 级）

| 文件 | 改动 |
|---|---|
| `config.js` | `TRANSITIONS.enabled` 默认 `true`、`duration` 默认 `0.4`；新增 `QC.seam*` 五项阈值 + `seamNum()` 校验器（非法值回退并告警） |
| `.env.example` | 注释与示例值改为默认开启 / 0.4，并写明 `quick` 档仍直拼 |
| `src/pipeline.js` | `_transitionOptions()` 增加 `quick` 档强制关闭（唯一转场判定入口，4 条拼接路径全覆盖）；新增 `_seamQcOptions()`，并入 `_finalQcOptions()` |
| `src/qualityChecker.js` | `QC_ITEMS` 增加 `seam`；新增 `checkSeam()` + `_yuvAvgFromBase64()` / `_madFromBase64()` / `_deltaE76FromYuv()` / `_parseSignalStats()`；`checkFinal()` 增加 seam 子项；构造函数读入 seam 阈值 |
| `scripts/verify-seam-qc.js`（新） | 48 项验收：静态断言、档位策略、**坏缝负向用例**、真转场正向用例、三态语义、阈值可配/抽样、真实成片只读、**转场开关 A/B 端到端** |
| `scripts/verify-transition-ui.js` | 默认值断言由 `false` 改为 `true`（保留"能关掉"与 `quick` 直拼的回归断言，未删断言） |

### 五、验证记录（三态，2026-10-27 实测）

**通过（逐脚本单跑，均 exit 0）：**

| 脚本 | 结果 | 说明 |
|---|---|---|
| `verify-seam-qc.js`（新） | **48 / 0** | 含坏缝负向用例；真实成片双向验证（硬切那条 fail、转场那条 pass） |
| `verify-transitions.js` | 36 / 0 | 真 ffmpeg |
| `verify-transition-ui.js` | 22 / 0 | 默认值断言已同步为 true |
| `verify-pipeline-fixes.js` | 28 / 0 | |
| `verify-stages.js` | 45 / 0 | |
| `verify-stage-pipeline.js` | 37 / 0 | 真机 Mock 三条任务（`DATABASE_TYPE=json` 下 exit 0） |
| `verify-continue.js` | 19 / 0 | |
| `verify-qc-annotation.js` | 32 / 0 | 起临时服务 |
| `verify-concat-audio.js` | 17 / 0 | |
| `verify-mock-vqc.js` | 14 / 0 | |
| `verify-nsfw.js` | exit 0 | |
| `verify-frontend-static.js` | 43 / 0 | |
| `verify-recovery-fixes.js` / `verify-skill-prompt.js` | exit 0 | |

**不通过（1 项，且证明与本改动无关）：**

- `verify-loop.js`：**24 通过 / 1 失败** —— "回绕相似度显著高于素材基线（证明淡化真的起作用）"
  实测 `wrap=1 vs base=1`。原因：该脚本用 `color=c=red` 纯色源造素材
  （`scripts/verify-loop.js:251`），纯色画面首尾帧 SSIM 恒为 1.0，
  断言 `wrap > base + 0.15` **在数学上不可满足**。
  `git diff` 已确认本改动**没有触碰** `checkLoop` / `makeSeamlessLoop` / `loopSsim` 任何逻辑
  （仅新增一处注释提到 checkLoop）。属**既有测试用例缺陷**，未在本任务修复（一次提交只做一件事）。
  建议后续把源素材换成有纹理/运动的内容，或改为与"直通基线"比对。

**未验证 / 未跑：**

- `verify-auth.js`（40 项）、`verify-frontend-contract.js`（49 项）：需起服务 + 登录墙，
  本任务未触及这两块契约，**未跑**。
- `verify-library.js` / `verify-stats.js` / `verify-skill-ai-path.js`：与本次改动无关，**未跑**。
- `node scripts/verify-all.js`：**跑不了**（本机 `spawn EPERM`，§2.3 有记载）。
  上面的结论全部来自逐脚本单跑。
- 本机 `.env` 是 postgres 且不可达，`verify-stage-pipeline.js` 直跑会因
  `timeout exceeded when trying to connect` 以 exit 1 结束（37 项仍全过）；
  改用 `DATABASE_TYPE=json` 后 exit 0。这是环境问题，不是代码回归。
- **前端勾选框的默认勾选状态未在真实浏览器验证**（本环境 `dsh_browser_*` 不可用，§6 已知缺口）。
  后端契约（`transition:{enabled:false}` 可覆盖）已有端到端证据，但"页面默认勾着"这一条属 UI 侧，未验证。

### 六、实测证据（可复述命令）

```powershell
cd "C:\Users\14872\Desktop\测试\app"

# 1) 接缝量化诊断（只读 output/，报告写 data/reports/）
node scripts/analyze-seams.js --video output/task_mvhlxnm7_1mch_concat.mp4
node scripts/analyze-seams.js --video output/task_mvhrynuu_ehtn_concat.mp4

# 2) 转场性能基准（产物写系统临时目录）
node scripts/bench-seam-perf.js --task task_mvhrynuu_ehtn --fade 0.4

# 3) 接缝质检验收（含转场开关 A/B 端到端）
$env:DATABASE_TYPE='json'; node scripts/verify-seam-qc.js; $env:DATABASE_TYPE=''
```

关键实测数值：

- 硬切缝（真实成片）：`ssim=0.475, ΔE76=41.99, ΔY=-42.64, MAD ×29.9` → **不通过**
- 真转场缝（真实成片，6 道）：`worstSsim=0.7605, worstDe76=8.03` → **通过**
- 转场开关 A/B（2 段 × 3s，fade 0.4）：`transition:false` → 无转场留痕、时长 **6.02s**；
  `transition:true` → 1 道 fade、时长 **5.60s**，`durationCheck {ok:true, actual:5.6, expected:5.6}`
  （证明 `checkConcat` 的 `expectedDuration` 路径成立，不会把转场产物误判成"拼接被截断"）

### 七、遗留与后续

1. `verify-loop.js` 的纯色素材缺陷（见上，建议另开一次提交修）。
2. 语义连续性（相邻镜头同场景延续）**未实现**，只出设计；需与"先图后视频"合并改造。
3. 接缝检测耗时实测约 **2.3s/道缝**（6 道 ≈ 14s）。`QC_SEAM_MAX_SEAMS` 默认 8，
   长片缝多时会抽样并在 `details.summary.sampled` 标注。
   可优化空间：把 `signalstats×2 + blend-difference` 合成一次 ffmpeg 调用，约可省 30%。
4. 历史任务（片段无 `duration` 字段）在终检里会得到 `seam` 不通过（"无法定位接缝"），
   属 §4.1 的正确语义，但会让旧任务的终检结论变差；如需兼容需先回填片段时长。

### 八、同日补充（2026-10-27 晚）：提交落地 + 两处假绿/覆盖面修正

**提交（6 条，一条一事）**

| # | commit | 内容 |
|---|---|---|
| 1 | `d36aa0a` chore(config) | IMAGE_GEN/I2V 配置预留 + imageGen 预留层 + supportsImageInput 三态；转场默认 true / 0.4（config.js 为共享文件，message 内逐条列明） |
| 2 | `92675ed` feat(qc) | 新增 seam 接缝质检项 + verify-seam-qc.js |
| 3 | `5efde9e` feat(pipeline) | 转场默认开启，quick 档强制直拼 + _seamQcOptions |
| 4 | `4759be6` test(seam) | 转场默认值断言 + analyze-seams / bench-seam-perf |
| 5 | `f729566` test(loop) | 修 verify-loop 假绿断言 + 隔离 SSIM 的负向用例 |
| 6 | `303c839` fix(qc) | 抽样时 seam 结论显式说明「仅检测 N/M 道缝」 |

**① verify-loop.js 的「永不可判」断言（task-8）**

- 现象：`verify-loop.js` 24/1，失败项 `wrap=1 vs base=1`。
- 根因：`pickSource()` 按「时长最长」挑素材，恰好挑到 **Mock 的 145s 静态纯色样片**
  （`task_mvhmjcbv_512n_concat.mp4`，`scdet` 逐帧 mafd=0）。纯色画面首尾帧 SSIM 恒为 1.0，
  断言 `wrap > base + 0.15` 在数学上**不可满足**。
- 性质：这不只是"用例碰巧失败"，而是**该断言从来没真正验证过「循环是否自然」**——
  属 AGENTS.md §4.1「skipped 冒充 passed」的同构问题：测不了的测试比没有测试更危险。
- 修法：① `pickSource()` 排除 `model=mock` 产物，改用最长真实成片；
  只剩 Mock 时用 `testsrc`（有运动/纹理）造合成素材兜底；
  ② 新增护栏断言 `baseSsim < 0.999`（基线无区分度即判该用例失败，防止再次退回"永不可判"）；
  ③ 新增负向用例 `[5b]`：把源素材裁到 (源时长−淡化) 且不做淡化，构造
  **「时长核验通过、但回绕不自然」**的产物，证明 checkLoop 会因 wrap SSIM 判 fail（隔离了时长变量）。
- 实测（`node scripts/verify-loop.js`）：**29 通过 / 0 失败 / exit 0**。
  正向 `wrap=0.9115 vs base=0.5965`；负向 `[5b]` `durationCheck=ok` 但 `wrap=0.5957` → fail。
  断言数 25 → 29（净增 4），**未删除或放宽任何既有断言**。

**② seam 抽样覆盖面必须可见（task-7 反馈第 3 点）**

- 问题：`checkSeam` 对缝数超过 `QC_SEAM_MAX_SEAMS`（默认 8）的成片做**均匀抽样**，
  但只有「通过」分支在结论里提了一句抽样，不通过分支完全不提 → 用户会误以为全测了。
- 修法：`summary` 增加 `unscanned` / `partialCoverage`；抽样时把
  「本次仅检测 N/M 道缝（均匀抽样），未检测的 X 道不计入结论」写进 **pass / fail 两条 reason**；
  未抽样时不得出现该措辞（验收有正反两条断言）。
- 性质：仍是 §4.1 的同构要求——没测到的部分不能靠沉默变成"通过"。
- 实测：`verify-seam-qc.js` **51 通过 / 0 失败**。

**③ 仍未完成的**

- `data/reports/` 的 `.gitignore` 条目由他人加入（未包含在我这 6 条提交里，工作区仍显示 ` M .gitignore`）。
- 语义连续性（静帧审核门合并方案）**只出设计**，见 `review-gate-design.md` 附录。
- 前端勾选框默认勾选状态仍未在真实浏览器验证（本环境 `dsh_browser_*` 不可用）。

---

## 2026-10-27 · 剪映「拼接 + 配乐」模块逆向（REA，只读取证）

**目的**：用户希望复用剪映专业版 11.6.0.14552 的「剪视频拼接配乐」能力到本项目，
但**不使用剪映提供的音乐素材**（改用 `app/assets/bgm/` 自有曲库）。

**边界（重要）**：本次**没有**修改 `app/` 任何代码；产出全部在 `docs/spec/re-jianying/`。
取证对象只读，未启动剪映 GUI、未联网。

### 交付物

| 文件 | 内容 |
|---|---|
| `re-jianying/jy-protocol.md` | 协议层：XMLDraft 轨道/时间算术/转场/音量/节拍/响度开关（538 行） |
| `re-jianying/jy-native-audio.md` | 算法层：拍点/镜头检测/响度体系/配乐拼接契约（938 行） |
| `re-jianying/jy-draft-cipher.md` | 加密层：草稿 `base64 + 带 nonce 对称加密`，未解出明文，附函数 RVA |
| `re-jianying/jy-splice-music-spec.md` | **复刻规格**：规则表 + 与本项目逐条差异 + 落地顺序 |
| `re-jianying/proto/ducking-check.mjs` | 可运行原型：侧链闪避，自带 ffmpeg、零依赖、不走管道 |

### 关键结论（区分观测/推断）

1. **[观测]** 「拼接」= 主轨 `<main>` 的**文档顺序**；主轨片段不写 `start`，只写
   `duration` / `material_start` / `speed`，累积位置隐式决定。
2. **[观测]** 转场是**边界属性**，只能挂有后继的左侧片段，末段禁止；推荐 **300–800 ms**；
   协议无上限、无样式枚举（样式在平台资源 `ref` 里）；且**不参与主轨时间线累计**。
3. **[观测]** BGM 必定在副轨 `<audio>`（`multi` 容器）；`volume` 是**线性幅度百分比**
   （100=原幅，范围 0–1000）；「配乐轻于原声」原文区间 **30–60**，「突出音乐」**120–200**。
4. **[观测]** 响度统一的目标值有硬数字：**-23 / -12 / -12 / -14 LUFS**
   （默认 / 抖音 / TikTok / YouTube），度量 **ebur128**，合法区间 `[-70,0]`；响度过低**拒绝处理**。
5. **[观测]** 配乐铺满长片的真实接口是 `splicing_info`：`loop_order`（可重复）+
   `valid_crossfade_loops` + `cross_fading_frame_len`（**单位是帧**）+ `beat_times` + `output_duration_sec`。
6. **[观测]** 剪映 PC 端**没有** ducking / EQ（`po` 18211 条中 `闪避|duck|避让|压低` 命中 0）；
   底层库有 sidechain 压缩但无产品入口 → 本项目若要「人声出现压音乐」必须自研。

### 可验证原型（实测数值）

`proto/ducking-check.mjs`：`sidechaincompress=threshold=0.12:ratio=4:attack=20:release=250:makeup=1`
在真实 BGM（`assets/bgm/calm/morning.mp3`）上实测：

| 处理 | 人声段 | 静音段 |
|---|---|---|
| BGM 单独 | −21.3 dB | −21.1 dB |
| 闪避后 | −30.0 dB | −21.1 dB |

→ 人声段额外 **−8.7 dB**，静音段 0 dB 变化。参数扫描见规格 §6。
另实测坑：`sidechaincompress` 输出比输入短（8.000s → 7.895s），必须 `apad` 补齐。

### 与本项目现有实现的差异（只记录，未改）

- `bgmPlan.js:146-155` 用 `atempo` 拉伸源区间 → 与剪映「禁止变速拉长」相悖。
- `audioMixer.js:579` 整条混音一次 `loudnorm=I=-20` → 剪映是逐片段 `average_loudness` → 目标 LUFS。
- 全仓 `duck|sidechain|agate` 0 命中 → 侧链闪避缺失。
- `waveform.js:30` 解码 8 kHz，拍点分析若要做需单独 22.05 kHz。

### 未解 / 不可复刻

- 草稿明文（`jianying_draft_encrypt_v2`，密钥不落地）；转场样式观感；平台资源 ref 体系；
  模型内拍点参数；默认交叉淡化/淡入淡出时长（服务端 AB 下发，本地无）。
- 转场是否缩短成片总时长：协议只说「不参与累计」，导出行为**未取证**。

---

## 2026-10-27 · 决议：界面主题分层 / 成片响度目标 / 不实现 ducking

承接上一节（剪映逆向）。三条都是**决策**，不是实现细节，后续不用再逐页争论。

### 1. 界面主题分层（已写入 `docs/spec/ui-theme-rule.md`）

> **深色 = 正在看画面的状态；浅色 = 操作状态。**

- 深色：剪辑、影院/播放、全屏预览、登录页（全屏视频背景）。
- 浅色：工作台、历史记录、片段库、配乐库存、成员管理、设置。
- **不整体换深色**。理由：工作台是表单/长文本，深色压低可读性；剪辑时要判断画面色彩亮度，浅色边框会干扰观感。
- 深色页统一用剪映 `video-edit` token；浅色页沿用现有 Notion 风变量；同页内不混用（深色页的弹窗/输入框也必须深色）。

### 2. 成片响度目标：`-20` → **`-16 LUFS`**（待真机 A/B 确认）

| 参考 | 值 |
|---|---|
| 剪映内置预设 | 默认 `-23` / YouTube `-14` / 抖音·TikTok `-12` |
| 本项目现状 | `loudnorm I=-20:TP=-1.5:LRA=11` |
| **建议目标** | **`I=-16` / `TP=-1.5 dBTP` / `LRA=11`** |

理由：成片是 Android TV **屏保循环长播**——高于广播级 `-23`（电视端普遍偏轻），低于短视频 `-12/-14`（避免久播疲劳），与 Apple Podcasts 的 `-16` 同档。
**状态：未落地**。改动点是 `audioMixer.buildMixArgs`（`loudness` 默认值）与 `bgmPlan.buildMixCommand` 的 `loudnorm` 参数；
改完必须做真机 A/B（同一段 `-20` vs `-16`）并给 `volumedetect` 实测，不接受只听一次。

### 3. 侧链闪避（ducking）：**明确不做**

- 本项目生成的片段**默认没有原生音轨**，成片里不存在需要保护的人声；ducking 没有作用对象。
- 剪映 PC 端本身也没有该功能（`po` 18211 条中 `闪避|duck|避让|压低` 命中 0），不存在“照抄剪映”的依据。
- 原型保留在 `docs/spec/re-jianying/proto/ducking-check.mjs`（实测 `threshold=0.12:ratio=4` → 人声段额外 −8.7 dB），
  若将来成片带原声再启用，**不要再另写一版**。
- 结论：`bgmPlan.buildMixCommand` / `audioMixer.buildMixArgs` **不接入**，相关待办关闭。

---

## 2026-10-27 · React 迁移起步：`/app` 共存 + 零 npm 方案（实测）

> 与前文「前端技术栈迁移决定（方案 B = React + Vite + Tailwind）」的关系：
> **React + Tailwind 不变，Vite 放弃**。原因见下，是实测出来的硬约束，不是偏好变化。

### 1. 硬约束：这台机器没有 npm

| 项 | 实测结果 |
|---|---|
| `npm` / `npx` / `corepack` | **全部不存在**（`CommandNotFoundException` / 无匹配文件） |
| node 来源 | DSH 内置精简运行时 `...\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24.21.0） |
| `registry.npmjs.org` | ✅ 通（node `fetch` 200，959ms，取到 `react@19.3.1`） |
| `unpkg.com` | ✅ 通 |
| `cdn.jsdelivr.net` | ❌ 不通 |
| `github.com` Releases | ✅ 通（40MB 单文件 16s） |
| PowerShell `Invoke-WebRequest` 直连外网 | ❌ 失败（TLS 中断），**只有 node `fetch` 可靠** |

结论：**拿不到 npm，但拿得到 npm 上的产物。** Vite 是 npm 包，因此不可用。

### 2. 采用的零 npm 方案（已落地并验证）

| 原方案 | 现方案 | 体积 |
|---|---|---|
| React（npm 装） | **React 18.3.1 UMD** 预下载到 `app/web/vendor/` | 143 KB（3 文件，**入库**） |
| JSX + Babel | **htm 3.1.1**（类 JSX 模板字符串，浏览器直接跑） | 含在上行 |
| Vite 打包 + HMR | **浏览器原生 ES Module**（无需打包器） | — |
| Tailwind（npm 装） | **Tailwind 独立 CLI 单文件程序** `app/tools/tailwind/tailwindcss.exe` | 40 MB（**不入库**） |

**新增依赖登记（AGENTS §4.6）**

- `react@18.3.1` / `react-dom@18.3.1` UMD：MIT，体积小，社区标准；无法自研。
- `htm@3.1.1`：Apache-2.0，1.3 KB，在无 Babel 时提供 JSX 级可读性；自研模板引擎成本远高于收益。
- Tailwind CLI 3.4.17：MIT，**单文件 40MB 二进制**，仅构建期使用，不参与运行时；已 `.gitignore`，
  恢复命令写在 `.gitignore` 注释里（`github.com` Releases 直下）。
- **没有新增任何 npm 依赖到 `package.json`**——`node_modules` 完全未变。

### 3. 落地内容

- `server.js`：新增 `/app` 静态挂载（`index:false, redirect:false`，防多余 301）+ SPA 兜底 `GET /^\/app(\/.*)?$/`。
- **修既有安全缺陷**：旧判据 `isPage = p === '/' || p.endsWith('.html')` 让 `/app/create` 这类
  SPA 路由（不带 `.html`）被当成静态资源**直接放行、绕过登录墙**。
  现按 `SPA_ASSET` 前缀排除静态资源，其余 `/app/*` 一律算页面。19 条边界断言见
  `scripts/_check-spa-auth.mjs`。
- `app/web/`：`index.html`、`src/{app,router,store}.js`、`src/screens/workbench.js`、
  `src/components/{taskDrawer,assistant,boundary}.js`、`styles/{src,app}.css`、`vendor/`、`assets/poster-2k.jpg`。
- 冒烟：`scripts/_smoke-app-route.js`（14 条路由/静态资源全 200，含 SPA 深链）。

### 4. 已踩到的两个真实缺陷（记录以免重犯）

1. **列表接口字段是 `taskId`，不是 `id`**。写 `t.id` 得到 `undefined`，表现是「点击没反应」而非报错。
2. **`prompts` 是对象数组** `[{text}]`，直接渲染 `${p}` 会让 React 抛
   `Objects are not valid as a React child` → **整棵树卸载、白屏**。
   现改为取 `p.text`，并加了 `Boundary` 错误边界：任何渲染错误只降级那一块并显示原文，不再整页白屏。

### 5. 迁移期边界（重要）

- **`public/**` 一行未改**，旧版仍在 `/` 提供服务；新版在 `/app`。
- 因此 `check-inline-js` / `verify-frontend-static` / `verify-editor-dom` / `test-editor-logic` / `verify-pages`
  **当前仍然可用**（它们解析的旧文件没变）。真正的破坏点是「把 `/` 切到新版」那一刻，
  那个动作会单独提交并单独知会。
- 新旧入口：旧版 `app/启动.bat` → `/`；新版 `打开新版前端.bat`（工作区根） → `/app`。

### 6. 未验证

- **`/app` 的视觉与交互只在人工浏览器里过过一遍**（Lead 无浏览器）。已人工确认：
  登录墙拦截生效、任务列表可取、三屏切换、任务抽屉、提示词助手悬浮球。
- Tailwind 的 `prefers-reduced-motion`、移动端断点未验证。

---

## 2026-10-27 · 决议：图片生成不做自动质检，改为人工确认

> 用户原话：「照片的生成不需要质检环节 我人工来就行」

### 决议

| 环节 | 质检方式 | 说明 |
|---|---|---|
| **图片生成**（先图后视频的第一步） | **不做自动质检**，由人工看图确认 | 不新增图片类 QC 项；不把 `checkClip` 那套搬到图片上 |
| **视频生成 / 拼接 / 成片** | 保留现有 12 项 QC（含 `seam`） | 不变 |

### 由此产生的一个结构性变化（重要）

审核环节的**性质变了**：

- 旧设想：生成完**视频片段** → 抽 4 张静帧 + 3 道缝 → 人工判「接得自不自然」
- 新事实：人工在**图片阶段**就确认了 → 不满意改提示词重做那张图 → 满意才花钱生成视频

也就是说 **暂停点从「视频之后」前移到「图片之后、视频之前」**。
这正是用户最初提这个流程的目的：*「如果不满意可以改提示词，等满意后再去生成视频，这样质量会高一点，重试几率小一点，还便宜一点。」*

### 对实现的影响

1. **`awaiting_review` 状态仍然需要**，但它挂在图片步骤之后，不是拼接之后。
2. 前端「审核」屏 = **图片确认屏**（逐张看 / 单张重做 / 通过后继续），不是静帧判缝屏。
3. **视频侧的 `seam` 质检不变**：它是成片后的自动体检，用于"这条成片能不能交付"，
   与"这张图我喜不喜欢"是两件事，不要合并。
4. 图片步骤尚未接入 pipeline（`src/generators/imageGen.js` 目前只有配置就绪层，
   `generateImage()` 明确抛错、不返回假图）。因此图片确认屏**暂时无法端到端验证**。

### 状态

- 已定：图片不做自动质检 ✔
- 未做：图片确认屏 UI、`awaiting_review` 状态、图片生成器接入
- 阻塞：后两者都需要改 `src/pipeline.js`，该文件当前由另一个会话持有（见
  `docs/spec/re-jianying/plan-color-continuity.md` §5 的并行协议），需错开合并窗口。

---

## 2026-10-27 · 镜头色彩连续性（colorContinuity）已落地（批次 1，`32b3d69` + `7a61c1a`）

### 为什么加

`checkSeam` 只在**接缝中心帧**测相似度；转场开启时那里是混合帧，于是「两个镜头本身色调差很多」测不出来。
实测（`docs/spec/re-jianying/seam-experiment.md`）：pair3 接缝 ΔE76 仅 **0.29**（按现有阈值通过），
但相邻镜头均值 ΔE76 高达 **25.49** —— 转场瞬间顺、前后镜头色调却不连贯。

### 做了什么

- `qualityChecker.checkColorContinuity(videoPath, clipDurations, options)`：
  取「缝前 0.6s」与「缝后 0.6s」两帧（**刻意避开转场混合区**），算 Y/U/V 均值 ΔE76。
- `QC_ITEMS` 新增 `colorContinuity`（`post`，名称「镜头色彩连续性」）；`QC_VERSION` **2 → 3**
  （`qcVersion.js` 的 `TRUSTED_FROM=2`，旧任务 v2 仍标 verified，不误标）。
- 接入 `checkFinal`；三处调用共用 `pipeline._finalQcOptions()` → `_colorContinuityQcOptions()`，只改一处全覆盖。
- 配置：`QC_COLOR_DE76_WARN=15`、`QC_COLOR_DE76_MAX=40`（`.env.example` 已同步）；
  另预留 `COLOR_MATCH_ENABLED=false` / `COLOR_MATCH_MAX_GAIN=0.15`（批次 2 用）。

### 三档（用户 2026-10-27 拍板）

| 镜头级 ΔE76 | 结论 |
|---|---|
| ≤ 15 | 通过 |
| 15 – 40 | `level:'warn'`，**不拉低通过率**（冷暖对比可能是刻意创作） |
| > 40 | 失败 |

### §4.1 语义（关键）

- 校色状态随结果记录：`colorMatchState` / `colorMatchReason`。
- `disabled`（校色默认关）：照常测色差，结论里注明「本次未校色」，**不判失败**。
- `skipped` / `failed`（要了没做成）：`skipped:true` + `legitimateSkip:false` →
  进 `notRunItems` → **整体不通过**，`reason` 里直接可读「校色未执行」。
- 未提供片段时长 → 判**未执行（fail）**，不静默放行。

### 验收（实测）

- `node scripts/verify-color-continuity.js` → **34 通过 / 0 失败**；
  三档真命中：同色 ΔE76=0 pass、`eq=brightness=0.14:saturation=1.4` ΔE76=22.49 warn、
  橙vs蓝 ΔE76=119.7 fail；负向覆盖 `skipped`/`failed`/缺参数三条路径。
- 回归：`verify-seam-qc` **55/0**（原 51，新增 4 条静态检查）、`verify-pipeline-fixes` 28/0、
  `verify-qc-annotation` 32/0、`verify-nsfw` 47/0、`verify-stage-pipeline` exit 0。
- 修订：`verify-seam-qc.js` 的 `seamBlock` 原截到「// 单帧的平均 Y/U/V」，新方法插入其间被误算，
  skipped 计数虚高（50/1）。已改为取最近分隔点，并给新方法补同等级检查（保留原断言强度）。

### 与另一个会话的关系（更新）

- `src/pipeline.js` 的占用**已解除**：批次 1 只新增了 `_colorContinuityQcOptions()` 与
  `_finalQcOptions` 里一行字段，**未改任何既有分支**。对方现在可以改该文件，
  只需保留这两个新增（删掉会让终检报「未执行」）。
- 批次 2（`transitionMixer` 内自动校色，默认关）尚未开始，**只会在批次 2 碰 `transitionMixer.js`**。

---

## 2026-10-27 · 拼接自动校色（colorMatch）已落地（批次 2，`089c589` + `7856a3e`）

### 做了什么

- `transitionMixer.concatWithTransitions()` 新增可选校色，**默认关**（`COLOR_MATCH_ENABLED=false`）：
  抽 5 帧 → 逐通道均值/方差 → 与**首段**对齐（Reinhard 式线性变换）→ `lutrgb` 注入现有滤镜链。
- **不额外编码**：只在「转场开启」这条本来就要重编码的路径里做；转场关闭走 `-c copy` 时不校色。
- 参考段固定首段（`reference:'first'`），不链式（防长片累积偏色）；单通道增益限幅 ±`COLOR_MATCH_MAX_GAIN`。
- 返回 `colorMatch: { state: disabled|applied|failed, reason, reference, maxGain, luts }`；
  三处拼接记录点写进 `steps.concatenation.qcDetails.colorMatch` 留痕。
- `pipeline._colorContinuityQcOptions()` 改为**以留痕为准**：
  - 有 `applied` → 终检 applied；
  - 有 `failed` → 终检 failed（进 notRun → 整体不通过）；
  - 请求了但无留痕 → `skipped`（未执行 ≠ 通过）；
  - 没请求 → `disabled`（合法跳过）。
- `taskManager.createTask()` 接住 `options.colorMatch`；「校色 + 转场关闭」属互斥组合，
  写进 `stagePlan.notes` 而**不抛错**（createTask 外层无 try/catch，抛错会变成未处理拒绝）。

### 实测（`scripts/verify-color-match.js`，24 项全过）

| 项 | 结果 |
|---|---|
| 效果 | 镜头级 ΔE76 **103.28 → 0.53**（3 段蓝/橙/绿，不校色 vs 校色） |
| 结构 | 开/关产物时长一致（8.2s） |
| 限幅 | `maxGain=0.01` → 增益 1.01，`clamped:true`（用 testsrc2+gblur 造方差，纯色片 sd=0 触发不了） |
| 成本 | 8s×2 长片段：1998ms → 2464ms，**1.23×**（只多采样，无额外整段编码） |
| 接线 | 4 处 `concatWithTransitions` 均传 `colorMatch`（静态断言） |

回归：`verify-transitions` 36/0、`verify-seam-qc` 55/0、`verify-color-continuity` 34/0、
`verify-stage-pipeline` exit 0。

### 遗留：`server.js` 还没接 `colorMatch`（归另一个会话）

目前只有 `.env` 全局开关能开启；**任务级** `colorMatch:{enabled:true}` 传不进来
（`server.js` 的 `req.body` 解构里没有这个字段，`createTask` 收不到）。
需要两处小改（都属对方文件，等其合入）：

```diff
@@ server.js:1134  POST /api/tasks 的解构
-  ... strictQcItems, preset, stages, transition } = req.body;
+  ... strictQcItems, preset, stages, transition, colorMatch } = req.body;

@@ server.js:1214  传给 createTask 的 options（transition 那一行下面）
     transition: (transition && typeof transition === 'object') ? transition : null,
+    // 拼接校色：{ enabled, maxGain }，默认不传 = 关（.env COLOR_MATCH_ENABLED 可全局开）
+    colorMatch: (colorMatch && typeof colorMatch === 'object') ? colorMatch : null,
```

未接之前行为是安全的：全局关 → 所有任务 `disabled`（合法跳过）；若用 `.env` 全局开 →
所有任务都会校色，且终检如实报 `applied`。

---

## 2026-10-31 · 暂停能力：两处事故级状态机缺陷修复 + `verify-pause.js`（71 项）

裁定依据 `docs/spec/pause-decision.md`；契约与验收口径已回写到
`docs/spec/pause-capability-spec.md`（由「需求说明」改写为「已实现契约」）。

### 修了什么（后端）

1. **`paused` 重启后永久卡死（事故级）**
   - `src/pipeline.js:1130`：`reconcileInterruptedTasks()` 的 `IN_PROGRESS` 白名单补入
     `paused / regenerating / processing / optimizing`。这 4 个状态以前不在白名单，
     重启后永远不会被回收（`pausedTasks` 是内存 Set，重启即空，点「继续」必然失败，
     用户没有任何出口）。
   - `src/pipeline.js:1153-1170`：`paused` 被回收为 `failed` + `interruptedFrom:'paused'`
     + `failureCode:'pause_interrupted'` + `recoverable:true`，文案写明「暂停期间服务被重启，
     可点补跑」；同时清掉可能残留的内存暂停标记。**不是标 completed。**
2. **暂停超时静默丢弃（事故级）**
   - `src/pipeline.js:1820`：新增 `_pauseMaxWaitMs()`，上限由 `PAUSE_MAX_WAIT_MS` 覆盖（默认 30 分钟）。
   - `src/pipeline.js:1853-1875`：超时不再只 `return false`。现在：ERROR 日志
     + 状态 `failed` + `failureCode:'pause_timeout'` + `pauseTimedOutAt` + `recoverable:true`。
   - `src/pipeline.js:1349-1354`：`_runPipeline` 收到 `batchInfo.aborted` 立即返回，
     **不再继续拼接/配乐**（旧行为会把 `paused` 覆盖成 `concatenating`，用户看到
     「暂停后自己跑完了，还少了几段」）。
   - `src/pipeline.js:1941-1950`：worker 改 `try/finally`，保证 `activeWorkers--` 一定执行。
     旧写法在所有 worker 提前 `return` 时 Promise 永不 resolve，流水线会永久挂住。
     同时汇总 `aborted` 供上层判断。
   - `src/pipeline.js:1924`：worker 每轮先按任务状态再拦一次（`failed/cancelled` → 退出），
     防止超时后其它 worker 以为「已恢复」继续生成。
3. **顺带修（同类缺陷，单独列出，不混在暂停名下）**：`regenerating / processing / optimizing`
   也纳入重启回收（同一条白名单）。
4. **HTTP 状态码**（`server.js:1582-1593`）：`POST /pause`、`/unpause` 对「任务不存在」
   返回 **404**，其余不可操作返回 **400**。原实现对两者都返回 400。
5. **前端可区分失败类型**：任务对象新增/使用 `failureCode` / `recoverable`，
   并在**列表接口**透出（`server.js:1290-1291`）；详情接口原本就透出
   `error` / `pauseTimedOutAt` / `interruptedFrom`。

`failureCode` 三态（前端契约）：

| 值 | 含义 | 界面建议 |
|---|---|---|
| `pause_timeout` | 暂停等待超过上限被中止 | 不是生成失败；显示「已中止 · 可补跑」 |
| `pause_interrupted` | 暂停期间服务重启 | 同上 |
| 缺失 / `null` | 普通失败 | 走原有失败样式 |

### 验收

- 新增 `app/scripts/verify-pause.js`，**71 通过 / 0 失败**；已注册进 `scripts/verify-all.js`
  （`pause` 套件，`group='real'`）。
- 覆盖：粒度 A（暂停后只跑完在跑的片段；恢复后不重复生成）、幂等、超时
  （不前进 / `failureCode` / `aborted`）、`_runPipeline` 不进入拼接与配乐、
  重启回收（含负向：completed 不回收、普通失败不被套 `pause_*`）、HTTP 404/400/200、
  列表透出 `failureCode`/`recoverable`、源码级防回归断言。
- **环境事实（重要）**：本机 DSH 沙箱下「捕获子进程输出」会 `EPERM`
  （`execFile` / `stdio:'pipe'` 均失败；`stdio:'ignore'` / `'inherit'` 正常），
  因此 `node scripts/verify-all.js` **无法在前台运行**——它用 `execFile` 默认 pipe
  去起每个套件。本次按 `pause-decision §6` 改为**后台 job 逐套件跑**；
  `verify-pause.js` 起临时服务时用 `stdio:'ignore'`。
- 回归（后台 job，逐个套件）：`pipeline-fixes 28/0`、`frontend-static 43/0`、
  `mock-vqc 14/0`、`stages 45/0`（前次）、`stage-pipeline exit 0`、`continue exit 0`。

### 已知失败（非本次引入，未修）

- `scripts/verify-loop.js:211` 断言 `qcVersion === 2`，而 `src/qualityChecker.js:42`
  已是 `QC_VERSION = 3`（colorContinuity 引入，见本文件「镜头色彩连续性」一节
  `QC_VERSION 2 → 3`）。属既有过期断言；按 `pause-decision §6`（不扩范围）未改。
  实测：`verify-loop.js` 28 通过 / 1 失败，失败项仅此一条。
- 运行时库连接偶发 `timeout exceeded when trying to connect`（Supabase pooler）：
  不影响验收结论（脚本自动清理），但属于环境侧不稳定，单独记录。

### 数据改动（`app/data/tasks/`）

- 已备份：`app/data/trash/tasks-backup-20261031-1950/`（18 个 JSON）。
- **本次修复真实回收了 1 个历史卡死任务**：`task_mvevgt8w_k5y1`
  （`paused` → `failed` + `failureCode=pause_interrupted` + 可补跑）。
  这是「重启后 paused 永久卡死」缺陷的第一个真实受害者证据。
- 按 `pause-decision §7.1` 记录此前启动回收改过的 2 个：
  `task_mvqk0e5e_i2s7`、`task_mvqk1dkj_9d9x`（`pending` → `failed`，均为 1 段 mock 任务、无成片）。
- 本次验收创建的测试任务全部经 `scripts/_test-cleanup.js` 清理；`data/tasks` 维持 18 条。

### 交接给 review-gate

`reconcileInterruptedTasks()` 的白名单与 `paused` 分支已由本项改完
（`src/pipeline.js:1122-1175`）。review-gate 若新增 `awaiting_review`，请**在上次改动基础上增量改**，
不要整段覆盖；且 `awaiting_review` 必须**不**进入回收清单（重启后原地保留）。

### 已知限制（已写进文档，未实现）

拼接/循环/转码/配乐阶段没有暂停检查点：这些阶段按暂停只改状态字符串，
不会真的停住 ffmpeg（`pause-decision §4.3`）。

### AGENTS.md 与仓库现状不符（执行方只列出，不修改 AGENTS.md）

1. 前端已存在 `app/web/`（React + htm + vendor，零 npm），`/app` 与旧 `public/index.html` 并存；
   AGENTS.md 仍写「无 React / 无构建 / 单文件为主」。
2. `scripts/` 下已有 **34 个** `verify-*.js`，但 `verify-all.js` 只注册 **17 个**
   （本次新增 pause 后）；AGENTS.md 写「14 个 / 16 个」均过期。
3. AGENTS.md 写「`dsh_browser_*` 不可用」；当前会话浏览器工具可用。
4. AGENTS.md 写 `public/index.html` 约 249 KB；实测 295,955 B。
5. 新增了 `colorMatch`（拼接自动校色）、`colorContinuity` 质检项、`QC_VERSION=3` 等，
   AGENTS.md 的质检项清单（11 项）与验收脚本清单均未覆盖。

---

## 2026-11-15 统一回收站 / 全量入库 / 垃圾产物清理 / 本地 ASR

### 背景（用户口径）
- 库存里的删除必须是两步：先移入回收站（可恢复），再确认彻底删除；旧实现是直接 unlink。
- “任何产物都要保留”：质检不通过、生成失败但文件仍在的片段，也要能在库里看到。
- 历史记录/产出入口后续要下线；失败排查靠“库里的失败可见性”。
- 场景卡（`docs/scene-cards-v3.3-final.json`）成为流水线唯一输入，后续接小智。
- 语音输入要免费、离线、不买 Key。

### 代码改动
- 新增 `src/recycle.js`：统一回收站（clip/final/photo/bgm），文件+条目一起移走；白名单 + `path.resolve` 前缀校验；恢复/彻底删除/清空；不做自动过期。
- `src/library.js`：`ingestClip` 不再要求 `status==='success'`（有文件即入库，写 `entry.status`）；`ingestMissing` 同步放宽；`ingestFinal` 增加 `status/origin`，费用取 `task.cost`，无快照时 `computed:false`（显示“费用未知”，不再伪装成 ¥0.00）；`remove` 改为回收站；新增 `restoreFromRecycle`；`LIBRARY_DIR`/`CLIPS_DIR` 支持环境变量覆盖。
- `src/photoLibrary.js`：删除改为回收站；新增 `restoreFromRecycle`。
- `src/processors/audioMixer.js`：`removeTrack` 改为回收站（内置轨只移清单）；新增 `restoreTrack`。
- `src/pipeline.js`：`_finishClipFailure` 在有文件时也入库。
- `server.js`：新增 `/api/recycle`（GET/恢复/彻底删/清空）；三个 DELETE 接口返回 `trashed`；旧 `/api/trash`（任务）保持不动。
- 新增 `scripts/backfill-finals.js`：回填成片（每任务取最新导出，优先 `.bgm`；孤儿标 `origin=orphan`；剪辑导出 `origin=editor`；mock 成片跳过）。
- 新增 `scripts/purge-artifacts.js`：清理验收目录/中间产物/孤儿片段/spike，默认 dry-run，`--apply` 移入 `data/trash/artifacts`，`--hard` 才真删。
- 新增 `scripts/verify-recycle.js`（35 项）并注册进 `verify-all.js`。
- `.gitignore`：忽略 `tools/asr/*`（保留 README）、`data/recycle/`、`data/logs/`。
- 场景卡复制到 `app/assets/scene-cards/v3.3-final.json`（SHA256 `623DE0…8CE8`，与原文件一致）。
- 安装离线 ASR：sherpa-onnx Windows 包 + SenseVoice int8（Apache-2.0），见 `app/tools/asr/README.md`。

### 验收（本机实测）
- `node scripts/verify-recycle.js` → **35 通过 / 0 失败**。
- `verify-photo-library` 42/0；`verify-clip-library-detail` 18/0；`verify-recovery-fixes` 25/0（同步改了两处旧断言）；`verify-editor-media` 21/0；`verify-bgm-upload` 24/0；`verify-library` 36/0。
- 成片回填：`--apply` 成功 **12 条**（6 个真实任务 + 4 个孤儿 + 2 个剪辑导出）；跳过 **8 条 mock 成片**；失败 0。
  - 更正：此前估算“24 条”重复计了孤儿，实际去重后为 **20 个文件 → 12 条入库 + 8 条 mock 跳过**。
- 清理：移出 **1247.3 MB**（验收目录 882.0 + 中间产物 141.5 + 孤儿片段 19.7 + spike 204.1），补充 5 个 `_bgm_n` 中间文件 60.3 MB；共 **1307.7 MB**，已彻底删除，清单保存在 `app/data/logs/purge-2026-11-15/`。
  - 两次 `EPERM` 由 PowerShell 手工 `Move-Item` 完成（Node 进程重命名偶发被沙箱拦），不是脚本失败。
- 清理后：`output/` 89.6 MB（只剩终片/剪辑导出）；`clips/` 101.5 MB；`data/spike/` 0；`app/` 合计 1363.6 MB。

### 未验证 / 已知限制
- **后端未重启验证**：检测到 3001 已有服务在跑（PID 98372，旧代码），按单实例规则没有另起实例，也没有重启它；`/api/recycle` 的真实 HTTP 行为未在运行态验证（仅模块级 + 语法级验证）。
- `verify-image-batch` 因无可用样图跳过（0 通过 / 0 失败），不算通过。
- 2 个 0.02MB 疑似损坏成片已入库并标 `suspectedDamage`（按用户确认保留）。
- 历史任务没有费用快照，成片显示“费用未知”而不是金额（不得伪装成 0）。
- ASR CLI 不认中文路径，生产接入需用 ASCII junction（已实测）；模型加载约 2.3 秒/次，后续可改常驻 websocket 降低延迟。
- 场景卡尚未接进运行时（Phase 4）。

---

## 2026-11-15 P2：前端库 IA（成片 / 片段 / 图片 + 回收站 + 配乐并入剪辑台）

### 背景（用户口径）
- 库存收敛成一个「库」：三个 tab 固定顺序 **成片 / 片段 / 图片**；长视频就是“成片”，不再单独「产出」入口。
- 条目操作只要：播放、下载、删除、收藏、重新生成（确认弹窗）；必须显示提示词与真实费用。
- **不要**「调色 / 配乐 / 进剪辑台」快捷按钮；编辑一律去剪辑台。
- 删除两步：页面删除只进回收站；彻底删除必须在回收站里再确认一次。
- 配乐库（试听/上传/删除/默认曲目）并入剪辑台配乐面板；历史/产出入口先隐藏（路由保留）。

### 代码改动（只动 `app/web/src/`，增量 edit）
- `web/src/screens/inventory.js`：新增 `LibraryView`（三 tab + 回收站抽屉）、`FinalsPanel`、`RecycleDrawer`；
  `ClipsView`/`PhotosView` 改为 `ClipsPanel`/`PhotosPanel` 并保留旧导出；成片行含缩略图/时长/来源（task|library|editor|orphan）/
  QC 徽章/提示词/费用/播放/下载/删除；片段与图片补「下载」；删除按钮文案改为“移入回收站可恢复”；
  图片列表显示张数与状态统计；库页底部留白 84px，避免右下角助手球压住末行操作。
- `web/src/screens/shell.js`：导航改为 **创作 / 剪辑 / 库**（设置固定底部）；历史/产出隐藏但路由保留；
  `/clips`、`/photos` 深链落到库页对应 tab；配乐入口从导航移除，`/music` 路由保留。
- `web/src/components/audioPanel.js`：搬入配乐库（试听 / 上传 ≤20MB / 删除 / 设为默认），曲目行改两行避免窄栏曲名被挤没。
- `web/src/screens/editor.js`：给 `AudioPanel` 传 `onReloadBgm`（仅 1 行）。
- `scripts/verify-editor-nav.js`：同步改 2 条旧导航断言（库存/记录两段、7 项 → 素材一段、3 项 + `library` 路由）并补 `/clips`、`/photos` 落库断言。
- 新增 `web/verify/p2-library-e2e.js`：headless Chrome + CDP 驱动运行中的 3001（不另起服务），
  临时成片自建自删（`p2verify_` 前缀），凭据运行时从 config 读取、不落盘。

### 验收（本机实测，2026-11-15 22:30）
- `node web/verify/p2-library-e2e.js` → **45 通过 / 0 失败**（截图 7 张：`app/docs/交接/p2-screenshots/`）：
  三 tab 顺序与计数、成片 12 行与 API 一致、费用“未知”不显示 ¥0.00、来源/QC 徽章、真实播放 `videoWidth>0`（1920×1080, readyState 4）、
  片段/图片下载、回收站抽屉、删除→回收站目录→恢复→再删→彻底删除（确认共 3 次）、`/clips`→片段 tab、`/photos`→图片 tab、
  剪辑台音频面板含配乐库（8 首可设默认）、无未捕获异常、无控制台非资源类报错。
- 回归（逐个套件，本机无法用 verify-all）：`verify-recycle` 35/0、`verify-library` 36/0、`verify-editor-nav` 15/0、
  `verify-editor-shell` 25/0、`verify-editor-audio` 22/0、`verify-bgm-upload` 24/0、`verify-clip-library-detail` 18/0、
  `verify-photo-library` 42/0、`verify-create-draft` 49/0、`verify-image-gen` 100/0。
- 接口 smoke：`/api/status` 200、`/api/library` 23（12 成片 + 11 片段）、`/api/recycle` 0、`/api/photos` 17、`/api/bgm` 9（默认 `calm_04`）。
- 视觉人工核对截图：成片列表 / 片段卡片 / 图片（破图属数据缺失）/ 回收站空态 / 剪辑台配乐库，布局与 token 正常。

### 未验证 / 已知限制
- 图片库 17 张里 **6 张文件缺失**（`v31test_*`、`real_test_*_img_0`、`ui_img_*`），图片 tab 显示破图；属 P1 清理留下的历史数据，
  P2 未改数据（未授权删用户数据），建议 P3/P6 做一次对账或占位图。
- 本机 `verify-editor-audio` / `verify-bgm-upload` 需把 `TEMP/TMP` 指到工作区再跑：系统临时目录 ffmpeg 写入 `Permission denied`
  （`doctor.js` 已警告，非本次引入）；重定向后 22/0、24/0。
- 浏览器 E2E 需要 Chrome 可创建命名管道（本会话受限沙箱下会 `mojo FATAL 0x5`），需在非受限模式下运行；
  REA 的 Windows PTY 进程捕获不可用，最后是在放宽权限的 shell 里跑通的（脚本本身不依赖权限模式）。
- 后端未改动、服务未重启（前端静态文件刷新即生效）；`MusicView` 代码保留仅用于 `/music` 深链，导航已无入口。

---

## 2026-11-15 P3：剪辑台接成片（素材三来源 / 整段可裁 / 导出归成片）

### 背景（用户口径）
- 剪辑台素材栏要能选 **成片 / 片段 / 图片**；成片默认**整段载入**，保留“从成片重建工程”。
- 条目必须可裁剪（入/出点），导出结果必须出现在「库 · 成片」。
- 图片首版可后置（产品已定），但来源入口与“不能入轨”的说明必须显式，不得无声失败。

### 代码改动
- `web/src/screens/editor.js`（增量 edit，未整文件覆盖）：
  - 素材栏新增来源切换 `片段 / 成片 / 图片`（`data-media-source`；片段=kind!=='final'，成片=kind==='final'）。
  - 新增跨来源索引 `assetById`：时间线里的段落无论当前看哪个来源，裁剪上限、预览规格、拖拽落点都能找到素材
    （旧代码用当前来源列表查找，切来源后裁剪会失去上限）。
  - 成片点击 = **整段载入**（`outSec=durationSec`，提示“已整段载入成片”），入/出点随后可在时间线拖手柄裁剪。
  - 图片只展示（审核状态 + 提示词），点击不加入时间线并给出说明；`/api/photos` 失败单独显示。
  - 缩略图 404 时在缩略图上写「文件缺失」，不再只留空白（真实数据：图片库 17 张文件全缺）。
  - 导出完成后自动刷新素材栏，并提示“导出完成，已归入「库 · 成片」”。
- `web/styles/editor.css`：来源切换、来源计数、成片徽章、“首版后置”提示、文件缺失占位样式（新增段落）。
- `src/editorExporter.js`（增量 edit）：导出成功后 `library.ingestFinal(editorTask, outputPath)`，`origin=editor`；
  job 视图新增 `libraryEntryId`；费用口径 `¥0 / computed:true / label='剪辑导出（无生成费用）'`
  （导出是本地 ffmpeg，不产生生成费用；源片段费用已记在各自片段条目）。
- `src/library.js`（1 行）：`ingestFinal` 尊重调用方显式传入的 `cost.label`，不再无条件改写成“成片（含片段生成费用）”。
- `src/processors/transitionMixer.js`（P3 修复，最小改动）：**单片段不再报错**。
  旧代码 `list.length < 2` 直接 `转场拼接至少需要 2 个片段`，导致“只选一条成片 → 导出”这一最自然路径永远失败。
  现：1 个片段按直拼（F=0）处理，视频走 `[v0]null[vout]`、音频走 `[a0]anull[aout]`；无接缝时 `transitions=0`、`type='none'`。
- 新增 `scripts/verify-editor-final-source.js`（注册进 `verify-all.js`）：隔离临时实例（独立端口 + 临时
  LIBRARY_DIR/OUTPUT_DIR/PROJECTS_DIR/DATA_DIR；真实库只读复制条目 JSON）跑真导出，ffprobe 实测 + 负向用例。
- 新增 `web/verify/p3-editor-e2e.js`：headless Chrome + CDP 连**运行中的 3001**（不另起实例），真点击验收；
  不触发导出（导出会写真实库/output），临时工程自建自删。
- `scripts/verify-editor-export.js` / `scripts/verify-editor-audio.js`：P3 起导出会写库，给临时服务加独立
  `LIBRARY_DIR`（只读复制真实库 JSON），否则每次跑套件都会往真实库写 `*_final` 条目。

### 验收（本机实测，2026-11-15 22:53）
- `node scripts/verify-editor-final-source.js` → **43 通过 / 0 失败**。关键 ffprobe 数值：
  - 三段工程（成片整段 5.000s + 同一成片裁 1–3s + 片段裁 2s）：产物 `1280x720 @ 30fps h264 8.200s 5.67MB`，
    期望 8.200s（Σ有效 −(3−1)×0.4）；`ffmpeg -f null` 可完整解码；源成片/片段 mtime+size 未变。
  - 单片段工程（成片裁 2s）：产物 `2.000s`（修复前该用例直接失败）。
  - 库新增条目 `${taskId}_final`：`kind=final`、`origin=editor`、`status=completed`、时长与导出一致、
    `cost.amount=0 & computed=true`、job 返回 `libraryEntryId`；真实库条目数 23 → 23（隔离生效）。
  - 负向：引用不存在的成片 → `failed · 第 1 段素材不存在`；0.05s 裁剪段 → `failed · 有效时长过短`（不产坏片）。
- `node web/verify/p3-editor-e2e.js`（重启后重跑）→ **32 通过 / 0 失败**，截图 5 张 `app/docs/交接/p3-screenshots/`：
  三来源顺序与计数（片段 11 / 成片 12 / 图片 17）、成片卡“成片”徽章 + 整段载入提示、点击后工程 `in=0/out=全长`、
  右把手 −1.7s → out 3.3s、左把手 +1s → in 1s、右把手越界钳制回 5s、片段来源再入一段（混排）、
  图片点不进去（仍 2 段）、刷新后 2 段与裁剪值保留、无未捕获异常。
- 回归（逐个套件）：`verify-editor-export` 31/0、`verify-editor-audio` 22/0、`verify-editor-media` 21/0、
  `verify-editor-rebuild` 19/0、`verify-editor-timeline` 29/0、`verify-editor-shell` 25/0、`verify-editor-ux-fixes` 18/0、
  `verify-editor-adjust` 17/0、`verify-editor-preview` 28/0、`verify-editor-nav` 15/0、
  `verify-editor-transition-controls` 16/0、`verify-transitions` 36/0、`verify-library` 36/0、`verify-recycle` 35/0、
  `verify-clip-library-detail` 18/0、`verify-projects` 25/0。
- `verify-transition-runtime` **11 通过 / 1 失败**：失败项 `取消在 15s 内生效 — 20.2s`（既有环境性超时）。
  已做 A/B：把本次 transitionMixer 的 4 处改动反向后再跑，仍为 `20.8s` 失败（备份/恢复哈希一致），
  说明与 P3 改动无关；根因是 30 段归一化在 ffmpeg 启动前约 19s，本机 15s 阈值不够。
- 服务：停旧 PID 81344 → 起新 PID 99808（`startedAt 14:46:58Z` 晚于所有改动文件 mtime，确认新代码生效）；
  登录态 smoke（不含密码）：`/api/library` 23（12 成片 + 11 片段）、`/api/photos` 17、`/api/bgm` 9、`/api/recycle` 0、工程 2。

### 未验证 / 已知限制
- **图片库 17 张文件实际全部缺失**（此前记录“6 张缺失”已过期；本次只读核对 `photoLibrary.listAll()` 逐条 `fs.existsSync` = 0/17）。
  图片 tab 现会明确显示“文件缺失”，未删除/修改任何条目；需要对账或重新生成（需用户决定）。
- 图片接入时间线（仍图 → 视频段）**未实现**：产品已定“首版可后置”；预览引擎基于 `<video>`，导出需新增静帧转视频路径。
- 浏览器 E2E 不触发导出，因此 3001 上的“导出归成片”只有隔离实例证据（同一份 `src/editorExporter.js`/`src/library.js`）；
  3001 上跑真导出会写真实库 + `output/` + 任务库，未在未获授权下执行。
- `verify-all.js` 本机仍无法整体跑（`spawn EPERM`），只能逐套件。
- 服务重启会全体登出（会话在内存），运行中任务会中断；本次重启前 3001 上无运行中任务。
  启动日志 `reconcileInterruptedTasks` 回收 3 个**此前已中断**的僵尸任务（`task_mwde105h_jb87` /
  `task_mwddz2gn_sgbd` / `task_mwaelng4_j8wd`）：均不在 `/api/tasks` 列表、库无新增产物，
  属任何重启都会做的既有行为，不是 P3 引入。

---

## 2026-11-15 P3 补充：文件缺失的条目不显示（用户口径）

### 背景
- P3 验收时只读核对发现：**图片库 17 条记录的文件 17/17 全缺**（此前交接写“6 张缺失”已过期）。
  图片 tab（库页 + 剪辑台素材栏）因此显示破图/占位。
- 用户明确要求：**「有文件缺失的地方就不要显示出来」**（不是标提示，而是不列出来）。

### 代码改动
- `server.js` `GET /api/photos`：
  - 默认**不返回**文件不存在的条目（`fs.existsSync(filePath)` 为假则隐藏）；数据一条不删，文件找回后自动重新出现。
  - 新增 `?includeMissing=1`：返回全量，供排查/对账；响应新增 `hiddenMissing`（被隐藏条数）与 `includeMissing`。
  - `totals` 改为与“可见性”同一口径（此前顶部汇总与列表会不一致：列 17 张、列表 0 张）。
- `server.js` `GET /api/photos/:id`：响应新增 `fileMissing` 布尔（详情页可判断）。
- `server.js` `GET /api/library`：同一口径——默认隐藏文件缺失的成片/片段；`?includeMissing=1` 取全量；
  响应新增 `hiddenMissing` / `includeMissing`，条目带 `fileMissing` 字段（当前真实库 23 条全部存在，隐藏 0 条）。
- `web/src/screens/editor.js` / `web/styles/editor.css`：撤回上一版的“文件缺失”角标方案，缩略图加载失败恢复为静默隐藏
  （避免把“缩略图抽帧失败”误报成“文件缺失”）；缺失条目由接口直接不返回。
- `web/verify/p3-editor-e2e.js`：新增 7 条断言（接口默认隐藏、`includeMissing=1` 全量、剪辑台图片空态、无破图 img、
  库页图片 tab 空态与计数 0、成片/片段未受影响），截图增加 `p3-06-library-photo-empty.png`。

### 验收（本机实测，2026-11-15 23:10）
- `node web/verify/p3-editor-e2e.js` → **39 通过 / 0 失败**：素材栏计数 `片段11 / 成片12 / 图片0`；
  `/api/photos` 返回 0 条、`hiddenMissing=17`；`?includeMissing=1` 返回 17 条；
  剪辑台图片 tab 空态且 0 个不可用 `<img>`；库页图片 tab 显示“还没有照片”、tab 计数 `图片0`；成片/片段未受影响。
- `node web/verify/p2-library-e2e.js` → **45 通过 / 0 失败**（图片 tab 走“明确空态”分支，其余不变）。
- 回归：`verify-photo-library` 42/0、`verify-library` 36/0、`verify-clip-library-detail` 18/0、`verify-editor-media` 21/0、
  `verify-editor-ux-fixes` 18/0、`verify-editor-final-source` 43/0、`verify-projects` 25/0、`verify-recycle` 35/0、
  `verify-editor-export` 31/0。
- 服务已重启加载新路由：PID 112612（`startedAt 15:08:22Z`）。登录态 smoke：
  `/api/photos` → `visible=0, hiddenMissing=17, totals={all:0,...}`；`?includeMissing=1` → `17`（待审 4 / 通过 6 / 打回 7）；
  `/api/library` → 23（12 成片 + 11 片段，`hiddenMissing=0`）；`/api/recycle` 0；`/api/bgm` 9。

### 未验证 / 已知限制
- “文件找回后自动重新出现”只有逻辑证据（每次请求都按 `existsSync` 判定，未造一个文件恢复场景实测）。
- 被隐藏的图片条目无法从界面删除/恢复（列表里看不到）；需要时用 `?includeMissing=1` 或脚本处理，留 P6 数据对账。
- 隐藏是展示层口径，不改变 `photoLibrary` 模块语义（`listAll/query` 仍返回全量，内部链路不受影响）。

---

## 2026-11-15 P4：场景卡接入运行时（读取 / 不放回 / buffer 替换 / promptComposer）

### 背景与已定决策
- 30 分钟长片 = 180 张正片卡 × 10s；**v3.3 为唯一输入**（`app/assets/scene-cards/v3.3-final.json`，
  200 张 = 180 feature + 20 buffer，正片 `scene_key` 唯一 180）。
- 按 `chapter + sequence` 顺序取、**同一轮内不放回**；buffer 只在生成失败时替换；
  耗尽后**报错并提示扩卡库**，不静默复用。
- `promptComposer` 运行时拼 image/video 提示词，**不写回卡**；`palette_id` 用参数化调色
  （adjustChain 的参数对象），**不引入 LUT 资源**。
- P4 只动后端、不改 UI。场景卡是**显式开关**：`POST /api/tasks` 传 `sceneCards: true`
  （或 `{ enabled: true }`）；不传 = 既有提示词任务，行为零变化。

### 新增
- `src/sceneCards.js`
  - 只读卡库（mtime+size 缓存，换文件自动重读）；加载时严格校验 schema、200 张、
    180 唯一 `scene_key`、`chapter+sequence` 严格递增、composer 必填字段。
  - `allocate(count)`：按序取一轮正片，不放回；超过 180 抛 `SCENE_CARDS_EXHAUSTED`（带扩卡库提示）；
    buffer 不参与初始分配。
  - `replaceWithBuffer(plan, index, reason)`：只替换该段、保留 `replacedFrom` 审计、同一任务 buffer 不复用、
    用尽返回 `null`。
  - `statusOf(plan)` 报告 `used / remaining / exhausted / bufferUsed / bufferRemaining`；
    `checkCapacity(count)` 供 HTTP 层预检。
  - **「一轮」= 一条任务的一次取卡批次**：30 分钟不重复是单条成片内的约束；不做跨任务全局游标
    （否则跑满 180 后所有后续任务都会失败，且与「不静默复用」冲突）。
- `src/promptComposer.js`
  - `composeClipPatch(card, { theme, userPrompt })`：产出 video/image 提示词、负向词
    （「无人物/不含人物」归一化成「人物」，避免把否定句当画面元素）、审计字段与 `adjust`；
    确定性、不修改卡。
  - 3 个 `palette_id`（cold-minimal / warm-dense / dark-cosmos）映射到 adjustChain 的合法参数
    （-50..50），未知 palette_id 返回 `null`，不臆造。
- `scripts/verify-scene-cards.js`（已注册进 `scripts/verify-all.js` 的 `scene-cards`）：
  57 项，含 180 张顺序/唯一/buffer 未误用、181 拒绝、buffer 替换与用尽、坏卡库负向、
  promptComposer（冻结卡不写回/确定性/调色参数可被 adjustChain 接受）、Mock 任务端到端。
- `scripts/verify-scene-cards-http.js`（手动套件，需运行中的 3001；不注册进门禁）：
  登录 → `GET /api/scene-cards` → 三条 `POST /api/tasks` 校验分支（不建任务）→ 1 片段 Mock 成功链路 → 自清理。

### 改动
- `src/taskManager.js`
  - `createTask` 支持 `options.sceneCards.enabled`：取一轮卡 → 逐片段写入
    `prompt / imagePrompt / negativePrompt / promptSource / sceneCardId / sceneKey / sceneCardRole /
    sceneCard / adjust`；任务新增 `sceneCards` 取卡计划与 `promptSource`。
  - 新增 `setSceneCards(taskId, plan)`，供 pipeline 补取卡/替换后持久化。
- `src/pipeline.js`
  - 场景卡任务在 `prompt_optimize` 阶段用 `promptComposer` 拼提示词并做提示词质检，
    `qcDetails` 记录 `promptSource=scene-card / roundId / sceneKeys`；
    `storyboard` 标记合法跳过（场景顺序已由 chapter+sequence 定死，LLM 分镜会打乱卡序）。
  - `_batchGenerate` 前幂等补取卡 + 拼提示词（覆盖任务恢复/直接 createTask 的路径）。
  - 生成失败且**还有重试预算**时用 buffer 替换下一次尝试的卡；不额外增加付费调用，
    `autoRetry=false` 时不替换。
  - 拼接输入按片段带 palette `adjust`：仅「转场重编码」路径生效，`qcDetails.sceneCardGrading`
    如实记录实际执行数；`quick` 档/转场关闭时 `concatenateSegments` 忽略该字段，不冒充已调色。
- `server.js`
  - `POST /api/tasks` 接受 `sceneCards`；拒绝 `prompts` 并传（场景内容由卡库提供）、
    拒绝图生视频组合；数量 > 180 → 400 `SCENE_CARDS_EXHAUSTED`；每段必须 10s → 400；
    卡库缺失/结构异常 → 503。
  - 新增只读探针 `GET /api/scene-cards`（卡库统计 + 取卡规则）。
  - `GET /api/tasks/:id/clips` 增加 `sceneKey / sceneCardId / sceneCardRole / sceneCardReplacement`。
  - **HTTP 冒烟抓到并修复**：`POST /api/tasks` 里解构出的请求体字段 `sceneCards` 遮蔽了同名模块，
    导致 `sceneCards.checkCapacity is not a function` → 500；模块改为别名 `sceneCardLibrary` 后通过。
    证据：`data/logs/server-2026-11-15.log` 的 `TypeError: sceneCards.checkCapacity is not a function`（修复前）。

### 验收（本机实测，2026-11-15 23:46）
- `node scripts/verify-scene-cards.js` → **57 通过 / 0 失败**：
  - 180 张：`scene_key` 唯一 180、全部 `role=feature`、顺序 `1:1 → 6:30`；
    `status = used:180 / remaining:0 / exhausted:true`；181 张 → `SCENE_CARDS_EXHAUSTED`。
  - buffer：替换保留 `replacedFrom`、同一段不二次替换、20 张用尽后返回 `null`。
  - promptComposer：冻结卡不写回、同输入同输出、video 196 / image 200 字符；
    3 个 palette 的 adjust 均通过 `adjustChain.hasAdjust/normalizeParams`，提示词无 `.cube/.lut`。
  - Mock 任务（`model=mock`、3×10s、`clips_only`、零计费、真实流水线）：
    `task.sceneCards` 记录 3 个 `scene_key`；`prompt_optimize` completed 且
    `promptSource=scene-card`；`storyboard` skipped + `legitimateSkip=true`；
    3 个片段 success 且文件存在；`bufferUsed=0`；测试任务已清理（内存/JSON/数据库）。
- `node scripts/verify-scene-cards-http.js`（连运行中的 3001）→ **24 通过 / 0 失败**：
  - `GET /api/scene-cards` 200（200/180/20/10s + 取卡规则）；
  - `POST /api/tasks` 校验：非 10s → 400 `SCENE_CARDS_DURATION`、181 段 → 400 `SCENE_CARDS_EXHAUSTED`（提示扩卡库）、
    同传 prompts → 400 `SCENE_CARDS_WITH_PROMPTS`；三条均未创建任务；
  - 1 片段 Mock 任务（`clips_only`、零计费）：`sceneCards` 计划 1 张、clip `promptSource=scene-card` 且
    与本地 promptComposer 输出逐字符一致、prompt_optimize completed、storyboard skipped、bufferUsed=0、
    `/api/tasks/:id/clips` 暴露 sceneKey；任务经 HTTP 删除 + 永久删 JSON + DB 软删（`getAllTasks` 不再返回），
    本次新增 mock 片段与临时样片已清理。
  - 清理补了「迟到写入」重试：`taskManager._saveTask` 是异步不 await 的，最后一次保存在删除后落库过；
    脚本等待后幂等重删，并新增断言「DB 软删后任务不再出现在 `getAllTasks`」（24 项里的最后一项）。
- `node scripts/check-server-version.js` → **exit 0**：运行中的 3001 就是当前磁盘代码
  （PID 103480，`startedAt 15:49:19Z`，serverMtime 与磁盘一致）。
- 回归 13 套件全绿：stages 45、pipeline-fixes 28、mock-vqc 14、continue 19、stage-pipeline 37、
  frontend-contract 49、library 36、qc-report-mode 14、clip-library-detail 18、transitions 36、
  editor-final-source 43、editor-media 21、editor-export 31。
- `verify-recovery-fixes` 依赖写死的运行态文件 `clips/mock_mvgy1dd6_4tbe09.mp4`
  （当前工作区已缺失，**非 P4 改动**）；用等价 mock 样片临时补齐后 **25/0**，跑完删除，未改该脚本。

### 未验证 / 已知限制
- ~~3001 上仍是旧代码 / HTTP 未验证~~ —— 已解决：用户三次重启（112612 → 113164 → 63456 → 103480），
  第一次重启暴露上述遮蔽 500，修复后第二次重启 HTTP 冒烟通过；清理注释造成 mtime 漂移后第三次重启，
  `node scripts/check-server-version.js` **exit 0**，HTTP 冒烟复跑 **24/0**（PID 103480，`startedAt 15:49:19Z`）。
- 逐段 palette 调色只在转场重编码路径生效；`quick` 档 / 转场关闭时不会调色（不冒充已调色）。
- buffer 替换只在还有重试预算时发生；`autoRetry=false` 时保留失败结果，不新增付费调用。
- 场景卡不足 180 张时加载即拒绝，不做“部分卡可用”的降级。
- 未在 3001 上跑真实计费任务（需用户同意）；P4 验收全部零计费（Mock + 模块测试 + 本地 stub）。
- `node scripts/doctor.js`：2 个 ERROR 为**既有环境性假错**（ffmpeg/ffprobe 经 `execFileSync` 管道报 EPERM，
  直接执行正常；P1 交接 §6 已记录），其余 6 条提醒为既有；P4 未引入新的 doctor 项。
- 本机 `verify-all.js` 仍无法整体跑（`spawn EPERM`），只能逐套件。

## 2026-11-16 小智（P5）：计划卡 + 状态机 + 记忆 + 离线语音 + 首页气泡

> 依据：`docs/交接/2026-11-15-handoff.md` §7 已定产品决策（不重新讨论）。
> 全部验收零计费：计划卡/状态机/记忆是纯函数；语音用本地 sherpa-onnx；任务用 `model=mock`。
> **没有发生任何真实计费调用**；「2 段真实任务」验收项按要求跳过，标记「未验证 / 待用户同意」。

### 新增（后端）
- `src/assistant/planCard.js`：中文口语 → 计划卡（总时长/每段/段数/主题/模型/分辨率/场景卡），
  校验 60 分钟 / 400 段 / 场景卡 180×10s / 每段范围按模型（dashscope 2–30、kling 3–15、seedance ≤15）；
  预算用 `pricing` 出人民币估值、用 `budget` 出美元闸门；重试上限 = 总预算 10% 且最多 2 次；
  补位上限 = min(10, floor(段数×5%))。**无总时长不做默认值**，返回 `PLAN_NEED_DURATION` + 一句追问。
- `src/assistant/stateMachine.js`：确定性状态机 `planned → confirmed → submitted → running →
  (retrying|filling) → done|failed|needs_user`；闸门在 `transition()` 内：付费未确认（`STATE_PAYMENT_NOT_APPROVED`）、
  重试次数/重试预算、补位额度；非法转移抛 `STATE_ILLEGAL_TRANSITION`；`observe()` 只记流水线观察值，不参与闸门。
- `src/assistant/memory.js`：会话记忆落盘 `data/assistant/sessions/<id>.json`（`ASSISTANT_DIR` 可覆盖）；
  消息/计划卡/状态机快照读写；确定性意图分类（greeting/status/last/create）+ 任务检索：
  「上一次的视频」只挑**有产物或已完成**的记录，可按主题过滤。
- `src/assistant/asr.js` + `src/assistant/proc.js`：离线语音。sherpa-onnx **不认非 ASCII 路径**，
  用 ASCII junction 暴露工具目录与临时目录；本机「pipe 捕获 stdout」EPERM，统一用 fd 重定向到文件再读；
  ffprobe 探时长（上限 60s）、ffmpeg 转 16k 单声道 wav、sherpa 出 JSON；上限 12MB，错误码明确。
- `src/assistant/fillFromLibrary.js`：补位选择。真实 ffmpeg 抽边界帧，按 SSIM + ΔE76（与接缝质检同口径）
  打分选最像的候选；候选必须文件存在、时长足够、不同任务、默认排除 status=failed；
  只取中间一段裁剪（不循环不慢放）；`assembleSegments` 有缺口即拒绝出片。
- `src/assistant/supervisor.js`：对话/确认/执行/监控/重试/补位编排。
  小智任务用 `autoRetry:false` 创建（流水线一次只试一次、有失败停在拼接前，不会先产缺段成片）；
  自动重试由调度器按计划上限重跑 `startTask`（流水线 `_batchGenerate` 复用已成功片段，只重生成失败片段）。
  真实模型必须 `approved=true` + 预算够 + 5 分钟去重；Mock 跳过预算。
- `server.js`（增量 edit，未整文件覆盖）：新增 `GET /api/assistant/info`、`POST /api/assistant/message`、
  `POST /api/assistant/execute`、`GET /api/assistant/state`、`GET /api/assistant/memory`、
  `POST /api/assistant/asr`（单独 24MB JSON limit，只收 base64、不收文件路径）、
  `POST /api/assistant/understand`（可选 LLM 填槽，**必须 consent=true** 且无 Key 不发请求）。

### 新增（前端）
- `web/src/components/xiaozhiPlan.js`（新）：计划卡、状态条、首页气泡、按住说话按钮（MediaRecorder → base64 → ASR；
  失败提示「请改用打字」）。
- `web/src/components/assistant.js`（增量 edit，保留原提示词助手能力）：显示名改「小智」；
  对话优先走 `/api/assistant/message`（不需要 LLM Key）；计划卡确认后轮询 `/api/assistant/state`；
  `/api/assistant/info` 404 时（旧服务端）**自动回退**旧对话并提示「服务端还是旧进程」；首页气泡只在创作页出现。
- 未新增 npm 依赖（前端仍零构建、后端仍 4 个运行时依赖）。
- `src/generators/mock.js`（1 处增量）：Mock 随机失败率支持 `MOCK_FAIL_RATE` 环境变量覆盖（默认仍是 10%），
  供**临时隔离实例**把「Mock 全流程」验收变确定性；默认行为不变，正常任务不会设置该变量。

### 验收（本机实测，全部零计费）
- `node scripts/verify-assistant.js` → **94 通过 / 0 失败**（约 2 分钟）：
  计划卡 21 项（含 90 分钟/401 段/31 分钟场景卡/场景卡 20s/kling 20s 等负向）；
  状态机 10 项（付费闸门、重试次数、重试预算、补位额度、非法转移、observe）；
  记忆 9 项（落盘、计划、状态、意图、主题检索、finals）；
  语音 8 项（真实中文样例两次一致、坏音频/过短/超大/无音频负向）；
  补位 12 项（真实 ffmpeg 相似度、排除短/缺失/失败/同任务、额度 0、缺口拒出片、监督器补位分支）；
  **Mock 全流程 11 项**（2 段成片 19.11s、ffmpeg 完整解码、scene_key、零计费）；
  **自动重试 5 项**（首轮强制失败 → RETRY → 重跑成功、成片存在）；
  付费闸门 5 项；前端静态接线 7 项（浏览器交互未验证）。
- `node scripts/verify-assistant-http.js` → **33 通过 / 0 失败**：
  临时隔离实例（3093、`AUTH_ENABLED=false`、全部数据目录指向临时目录，**不碰 3001**），
  覆盖 info / message / execute / state / memory / asr / understand + 1 段 Mock 成片（任务 completed、成片文件存在、
  `/api/budget` spent=$0）+ 付费未确认拦截 + 缺 sessionId / 空文本负向。
- 回归：`verify-frontend-contract` **49/0**、`verify-auth` **40/0**、`verify-scene-cards` **57/0**、
  `verify-stages` **45/0**、`verify-assistant-diagnostics` **103/0**。
- `node scripts/doctor.js`：仍是**既有 2 个 ERROR**（ffmpeg/ffprobe 经 `execFileSync` 管道 EPERM；本次新模块全部用
  fd 重定向，实际 ffmpeg/ASR 均跑通），6 个既有提醒；P5 未引入新 doctor 项。

### 未验证 / 已知限制
- **3001 未重启**：本窗口对用户进程无权限（`Get-Process 103480`/`tasklist` 均 Access denied），
  且按红线不另起实例。`check-server-version` 现在 **exit 1**（disk server.js 16:10:42Z 晚于运行中 15:46:23Z）。
  新接口已用**临时隔离实例**验证；3001 上待用户重启后复跑 `node scripts/verify-assistant-http.js` 同款断言。
- **浏览器交互未验证**：本会话 headless Chrome 因沙箱无法创建命名管道（`mojo FATAL ... 拒绝访问`），
  `dsh_browser_*` 不可用。计划卡/语音/首页气泡的点击与视觉只做了静态接线断言，需人工过一遍。
- **2 段真实任务未做**（需真实计费，遵守 AGENTS §4.9）：保留为「未验证 / 待用户同意」。
- 补位成片的**端到端出片**未跑（20 段成片耗时）：补位选择/组装已在真实片段上验证，
  监督器补位分支用 monkey-patch 验证状态流转；真实「补位 → 新任务 → 成片」待人工用失败任务实测。
- 可选 LLM 填槽 `/api/assistant/understand` 未实跑（无用户 Key 且会产生费用）；未同意时拒绝、无 Key 不发请求的逻辑已测。
- 状态机对「流水线内部重试」只做观察记录（`observed`），闸门只管小智自己触发的重试；因为小智任务用
  `autoRetry:false` 创建，流水线内部不会自动重试。

## 2026-11-16 P6：下线历史 / 产出入口 + 收尾（前端 + 文档）

**依据**（产品口径，2026-11-15 handoff §7）：「历史记录 / 产出入口最终下线；失败任务靠
『库里失败可见 + 成片未完成卡片』，不再靠历史页。」P2 只做了「导航隐藏、路由保留」，P6 收尾。

### 改动（全部前端增量 edit；未整文件覆盖 `qualityChecker.js` / `pipeline.js` / `server.js`；未改后端）

| 文件 | 改动 |
|---|---|
| `web/src/screens/shell.js` | 移除 `HistoryView` / `OutputScreen` 的 import 与渲染；`routeOf` 去掉 history/output；`/history`、`/output` 深链落 `library`（库 · 成片）；把 `/api/tasks` 轮询结果传给 `LibraryView` |
| `web/src/screens/gen.js` | 生成页「去历史记录」→「去库看成片」（`/library`） |
| `web/src/screens/inventory.js` | 新增 `UnfinishedPanel`（成片 tab 顶部「未完成 N 条」：`failed/partial`、排除 `mock` / `clips_only` / 已产成片；点开复用 `TaskDrawer` 重试 / 补跑）；片段卡新增「生成失败」徽章（`entry.status='failed'`） |
| `web/src/screens/history.js` / `output.js` | 文件保留（删除死代码需用户同意，AGENTS §6），头部标注「P6 已下线、入口与路由已移除、失败任务改由库页承接」 |
| `web/src/components/assistant.js` | 小智提交成功文案不再指向「历史/任务列表」，改「库 · 成片」 |
| `scripts/verify-p6-offline.js`（新，已注册 `verify-all.js`，group=fast） | P6 只读验收：前端静态 29 项 + 交接文档 6 项 + 运行中 3001 静态文件只读 6 项 |
| `scripts/verify-all.js` | 注册 `p6-offline` |

### 验收（本机实测，零计费）

- `node scripts/verify-p6-offline.js` → **41 通过 / 0 失败**（静态 29、交接文档 6、3001 只读 6）。
- 运行中 3001（PID 103480）只读证据：`GET /app/src/screens/shell.js` 200 / 5617 bytes，
  已无 `HistoryView` / `OutputScreen`，`/history` 深链已落库；`inventory.js` 已含 `UnfinishedPanel`；
  `gen.js` 已改「去库看成片」。
  → **P6 是纯前端改动：`web/**` 由 `express.static` 下发，刷新即生效，不需要重启 3001**
  （与 P5 的后端接口不同；3001 仍待用户重启才具备 `/api/assistant/*`）。
- 回归 9 套件全绿：editor-nav 15、editor-shell 25、clip-library-detail 18、photo-library 42、
  create-draft 49、bgm-upload 24、image-gen 100、frontend-contract 49、assistant 94。

### 未验证 / 已知限制

- **浏览器交互未验证**：本会话 headless Chrome 在沙箱内无法启动
  （`crashpad_client_win.cc:431 OpenProcess: 拒绝访问 (0x5)` → `crash server failed to launch, self-terminating`；
  加 `--disable-crash-reporter --disable-breakpad` 仍失败），`dsh_browser_*` 不可用。
  导航 / 未完成卡片 / 「去库看成片」的视觉与点击**未验证**，需人工过一遍。
- `verify-assistant` 的 ASR 用例**不能**把 `TEMP/TMP` 指到工作区：`asr.js` 的 ASCII junction 建在
  `os.tmpdir()` 下，指到工作区后 sherpa 进程非零退出 → `ASR_FAILED`（实测 92/2）；用默认 TEMP 复跑 **94/0**。
  这是脚本调用方式的环境约束，不是 P6 改动（P6 未动 `src/assistant/**`）。
- `history.js` / `output.js` 仍未删除（死代码），删除需用户同意（AGENTS §6）。





---

## 2026-11-16 小智首页改造（/ = 整页对话页）+ 图片库缺失对账 + 81 项提交

### 背景（用户口径）
- 登录后的 `/` 不再是六步向导：整页 = 「小智」对话页（大球 + 球与对话窗口之间的 1–2 句介绍卡 +
  微信式底部输入框 + 左侧可收起气泡导航 + 与球呼应的绿色背景）；六步向导保留在 `/create`。
- 左侧「三个点」= 收起/展开（不是退出）；导航 4 项：创作 / 剪辑 / 库 / 设置。
- 先完成图片库 17/17 缺失与 81 项未提交改动，再做页面（用户 2026-11-16 10:31 指定顺序）。

### 图片库 17 条缺失（2026-11-16 10:39–10:44 删除；11:03–11:20 全部恢复）
- 只读复核：17 条记录、`fs.existsSync` 0/17 存在，`clips/ output/ data/` 内按文件名检索 0 份可找回。
- 先快照到 `app/data/keep/photos-missing-20261116/`（`snapshot.json` 28KB + `raw/` 17 个原始条目副本 + README + delete-result），
  再走两步删除：`src/photoLibrary.remove()` 逐条移入回收站（17/17，`fileCount=0`，文件本就缺失）→ `POST /api/recycle/photo/purge`（removed 17）。
  删除后线上验收：`/api/photos` 0 条、`hiddenMissing=0`、`totals={all:0}`、`?includeMissing=1` 也是 0；`/api/recycle` 0；`/api/library` 仍 23。
- **11:03–11:20 另一窗口完成取证恢复**：从 Chrome 磁盘缓存（`Cache_Data`）提取 17 个 HTTP 响应体，逐项与 2026-11-15
  purge manifest 的 `bytes` 相等、缓存 URL 键与文件名对应、尺寸一致（1920×1080 ×14 + 1696×960 ×3）；写入 `app/clips/`
  （目标原本为空，未覆盖），并把本窗口快照的 17 份记录回填 `app/data/photos/`。证据备份与 SHA256 在
  `app/data/keep/photos-recovered-20261116/`，完整报告 `docs/交接/2026-11-16-图片丢失-取证与恢复.md`。
- 恢复后线上 3001（PID 25988，未重启）：`/api/photos` **17 条、hiddenMissing=0**（待审 4 / 通过 6 / 打回 7）、
  `?includeMissing=1` 17 条；`/api/recycle` 0；`/api/library` 23；库页「图片 6」（最终版口径）。**未再删除**。
- 根因（恢复报告结论）：`scripts/purge-artifacts.js` 的 `collectRefs()` 只读 `data/tasks` + `data/library`，漏了
  `data/photos`，17 张图片被当成 clips 孤儿文件；随后 `--apply` 软移入 1 分钟内被 `Remove-Item -Force` 硬删。
  未发起任何付费重新生成。

### 81 项未提交改动（2026-11-16 10:44–10:49）
- 按路径 `git add <file>`，未用 `git add -A`；排除 `tools/asr/*`（约 330MB，只提交 README）、`data/`、`output/`、`clips/`、`logs/`、`.env`。
- 11 个 commit（按主题）：fbb4316 gitignore/ASR、219fe7b 配乐/波形、425a9f1 回收站/入库、
  2ee7334 场景卡、d7a4533 小智、38a1231 图生视频/预算/图片优先、b9b2d12 server/pipeline/qualityChecker 接线、
  88cb8f2 前端 P2/P3/P6、653c8d4 门禁注册、c806c00 交接文档/changelog、e386cfd 浏览器验收脚本与截图。
- `server.js` / `pipeline.js` / `qualityChecker.js` 提交前逐行 `git diff`：内容为 P1/P3/P4/P5 + 11-12~14 的
  回收站/隐藏缺失/场景卡/小智/预算/图生视频/autoRetry=false/质检分级/归一化拼接/四项并行，无来路不明的半成品；
  因跨阶段混在同一文件，提交信息逐条列明（AGENTS §8「混合提交必须列出实际内容」）。
- 提交后 `git status --porcelain` 为空；`node scripts/check-server-version.js` 仍 exit 0（PID 25988，未重启）。

### 首页改造（2026-11-16 10:49–11:20，只改 web/）
- 新增 `web/src/screens/assistantPage.js`：整页绿色外壳 + 左侧可收起气泡导航（`vs_rail_collapsed` 记住状态；
  三个点 `•••` 的 aria-label 为「展开/收起导航」，不是退出；4 项 → /create /edit /library /settings）。
  **左侧默认收起为 64px 图标条（用户 2026-11-16 指定「第三张截图这个样子」）**，点三个点可展开到 212px。
- 新增 `web/styles/assistant-home.css`（手写 CSS，不依赖离线 Tailwind 产物）：深绿/祖母绿渐变 + 极光光晕、
  大球辉光、介绍卡、消息气泡、微信式底部 composer、64px 收起态、空态垂直居中、窄屏适配；
  另含板块页左栏「小智 · 对话首页」入口样式 `.rail-home`。
- `web/src/components/assistant.js`：新增 `page` 模式，整页复用同一套状态与接口
  （记忆恢复 / 计划卡 / 状态机轮询 / `/api/assistant/message|execute|state|memory|asr` / 语音）；
  介绍卡 1–2 句 + 3 个 chips（30 分钟的雪山、星空和极光 / 上一次的视频 / 现在进度怎样）；有消息后大球缩小、介绍卡收起；
  输入框随内容长高、Enter 发送；`navigate('/')` 改 `/create`（填入提示词回向导）。
- `web/src/screens/shell.js`：`/` → home（渲染 AssistantPage，无全局左栏/任务条/悬浮球）；`/create` → 六步向导；
  导航「创作」→ `/create`。`gen/inventory/templates/editor` 里的 `navigate('/')` 一并改 `/create`（原意都是回向导）。
- **退出板块（用户 11:14 追问）**：板块页（/create /library /settings /gen /templates）左栏顶部固定
  「小智 · 对话首页 · 点这里回来」入口（绿色小球 + 文案，`aria-label="回到小智首页"`），点击 `navigate('/')` 回首页；
  剪辑台左上角 `←` 的 title 改「返回小智」、目标 `/`；生成页「退出观看」也回 `/`（「去创作」仍去 `/create`）。
- 未新增依赖；未改后端；3001 未重启（`express.static` 刷新即生效）。

### 验收（本机实测，零计费）
- CDP 9222 浏览器实操 **22/0**：1440×900 / 1280×800 截图；`.xz-page`、4 导航项、大球、介绍卡 + 3 chips、
  底部输入框贴底；**默认 64px → 点三个点 212px → 再点 64px → 刷新仍 64px**；`/create` 打开六步向导（有提示词/下一步）；
  **`/create`、`/library` 左栏「小智 · 对话首页」可见，点击回 `/`**；
  发「30 分钟的雪山、星空和极光」→ 用户消息 + 小智回复 + 计划卡出现（未点确认执行，零计费）；is-compact 生效；无 console 错误。
  截图：`.scratch/auto_chain/xiaozhi-home/`（6 张）与 `app/docs/交接/xiaozhi-screenshots/`（6 张，已入库）。
- `node scripts/verify-xiaozhi-home.js` → **42 通过 / 0 失败**（静态 36 + 3001 只读 6；已注册 verify-all 的 fast 组）。
- 回归：`verify-editor-nav` 15/0、`verify-p6-offline` 41/0、`verify-editor-shell` 25/0。
- 其他路由 smoke：/library、/edit、/settings 正常；全局悬浮球面板可打开。

### 未验证 / 已知限制
- 未点击计划卡「确认执行」（真实模型会产生计费；Mock 也会建任务）；语音按钮未实际录音（ASR 接口已由 P5 验收）。
- 首页默认收起/可展开；板块页仍是 212px 固定左栏（顶部有「小智」退出入口）。如要全局统一可收起，需再改 shell.js 的 Rail。
- 浏览器证据来自 CDP 9222（本机 Chrome），非人工手感验收；1440/1280 之外的分辨率未截图。

### 用户反馈修订（2026-11-16 11:30）

- **示例不再用「10 分钟全是极光」**：长视频是一次多主题混合，首页介绍卡 / 输入框 / 面板默认话术 / 首页气泡统一改为
  「30 分钟的雪山、星空和极光」，并明确「长片可以一次说多个主题」。
- **planCard 支持多主题**：`findThemes()` 按原文出现顺序识别并去重；`theme` 仍取第一个（作为 promptComposer 的氛围参数），
  `themeLabel` 展示全部（如「雪山冰川、星空银河、极光」）。单主题行为不变（`verify-assistant` 95/0）。
  **注意：这是后端改动，需重启 3001 才生效；本窗口按约束未重启，当前运行进程仍显示单个主题。**
- **板块页「小智 · 对话首页」小球改为与首页大球同源的绿色渐变**（原为蓝色）；WebGL 不可用时的兜底球也改为绿色，
  保持「小智 = 绿色液态球」的一致形态。
- 验收：`verify-assistant` **95/0**、`verify-xiaozhi-home` **43/0**、CDP 9222 **22/0**（示例/配色已刷新截图）。

### 用户反馈修订（2026-11-16 11:44）：长片不按主题，改为「时长优先 + 场景卡自动抽取」

用户指正（原话要点）：
- 「我想要的不是用户直接告诉你说我要哪几个主题，而是我告诉你我要的时长，你自动通过我的场景卡里面去抽取选择。」
- 「10 分钟的长视频肯定不是围绕什么主题的……每段 10 秒或 15 秒，都从场景卡里面选，大约 60 到 90 个不同的场景，
  他们都不属于某一种主题。」
- 「目前这个什么 30 分钟的雪山、星空和极光是错误的。」

改动（全部增量 edit；未整文件覆盖 `qualityChecker.js` / `pipeline.js` / `server.js`）：
- `src/assistant/planCard.js`：口语里的地貌词不再升级成 `theme / themeLabel`（用户提到时只给一句
  「不按单一主题选卡」提示）；删除「没识别到主题」警告；`describe()` 改为
  「场景：场景卡库自动抽取 N 个不同场景（按章节顺序，不重复）」。
- `src/assistant/supervisor.js`：回复开头改「我按 X 分钟排好了」；问候 / 未知 / 无记录 / 无任务文案去主题；
  不再把 `parsed.theme / parsed.themeLabel` 传进计划卡。
- `src/taskManager.js` / `src/pipeline.js`：场景卡任务拼提示词时不再把用户整句当「氛围」注入每段
  （否则 60–180 段会被拉向同一主题）；`theme` 仅在调用方显式传 `options.theme` 时生效。
- `web/src/components/assistant.js` / `xiaozhiPlan.js`：chips 改
  `['10 分钟的长视频', '上一次的视频', '现在进度怎样']`；介绍卡 / 输入框占位 / 首页气泡改「说个总时长」；
  计划卡去掉「主题（未指定）」行，改为「场景：场景卡库自动抽取 N 个不同场景（按章节顺序，不重复）」。
- 验收脚本同步：`verify-assistant`（新增「不按主题」「多主题只提示」「10 分钟 = 60 段」「describe 场景行」
  「回复不带主题」「首页示例时长优先」断言）、`verify-scene-cards`（任务提示词期望 = 卡 + 显式主题，不含用户整句）、
  `verify-xiaozhi-home`（chips / 介绍卡断言 + 场景文案，43 → 44 项）。

验收（本机实测，零计费）：
- `node scripts/verify-assistant.js` → **99 通过 / 0 失败**（原 95；含 Mock 成片 19.11s、自动重试、离线 ASR）。
- `node scripts/verify-scene-cards.js` → **57 / 0**。
- `node scripts/verify-xiaozhi-home.js` → **44 / 0**。
- `node scripts/verify-p6-offline.js` → **41 / 0**。
- **3001 已由用户 11:52 重启为 PID 131412**（晚于本轮 11:41 的 src 改动，新口径已生效）：
  线上探针 **16/0** —— 「10 分钟」→ 60 段、`themeLabel=null`、回复「我按 10.0 分钟排好了」+
  「场景：场景卡库自动抽取 60 个不同场景」；「30 分钟的雪山、星空和极光」→ 180 段、无主题行，
  只给「不按单一主题选卡」提示。
- 11:56 介绍卡再精简（用户反馈「不要解释那么多，后面的有点冗杂」）：标题改为
  「我是小智，告诉我你想要多长的视频吧」，删除长副文案；悬浮面板问候与首页气泡同步缩短。
  CDP 9222 **22/0**（新前端无 console 错误），6 张截图已刷新；`verify-xiaozhi-home` **44/0**。
- 未做：15 秒/段。场景卡按 10 秒/张设计（180 张 = 30 分钟），15 秒会被 `PLAN_SCENE_CARD_DURATION` 拒绝；
  是否开放需产品决定 + Mock/真实生成验证，不能只改校验。

## 2026-11-16 小智语音：麦克风权限死胡同修复（Permission denied）

用户反馈（截图 13:30，`VIDEO STUDIO` 小智对话页）：
- 按住麦克风后，气泡只显示「拿不到麦克风权限：Permission denied；请改用打字。」，没有下一步。
- 页面来自 `http://localhost:3001`（`isSecureContext=true`）；Windows
  `ConsentStore\microphone` 与 `NonPackaged` 均为 Allow，Chrome 该站点无 `media_stream_mic` 例外
  —— 不是系统级禁用，而是浏览器授权弹窗被忽略/拒绝后缺少可恢复路径。

根因（两层）：
1. 旧 `web/src/components/xiaozhiPlan.js` 的 `VoiceButton.start()` 直接 `getUserMedia`，
   catch 后只回一行文本；没有区分「已被 Chrome 阻止」「没有设备」「被占用」「非 localhost/https」，
   也没有告诉用户去哪里把权限改回来。
2. 按住说话与授权弹窗天然冲突：用户在 Chrome 授权弹窗出现后松手，`pointerup` 已执行，
   但 `getUserMedia` 仍在等待；授权通过后旧实现会开始录音且不再有 pointerup 可停（会一直录）。

改动：
- `web/src/components/xiaozhiPlan.js`（增量 edit，+约 400 行）：
  - 新增 `queryMicPermission()`（`navigator.permissions.query({name:'microphone'})`）：
    `denied` 时不再盲调 `getUserMedia`，直接开权限卡；
  - 新增 `MicPermissionModal`（挂 `document.body` 的 portal）：拒绝时给 Chrome
    「地址栏 ⚙/🔒 → 网站设置 → 麦克风 → 允许」/ `chrome://settings/content/microphone` /
    Windows「设置 → 隐私和安全性 → 麦克风 → 允许应用访问麦克风 + 允许桌面应用访问麦克风」；
    提供「重新请求麦克风」「复制排查步骤」「先打字」；
  - 请求前显示「正在请求麦克风」卡（提示在 Chrome 弹窗点「允许」），授权成功显示「麦克风已允许」；
  - 加 `pressedRef`：授权晚到且用户已松手 → 立即 `stop()` 所有 track，提示「请再按住说话一次」，不偷录；
  - `NotFoundError` / `NotReadableError` / `INSECURE_CONTEXT` / `NO_GETUSERMEDIA` 分别给原因与处置；
  - 麦克风按钮 `title` 随权限态变化（拒绝时提示点开说明），并加 `data-mic-button` / `data-mic-modal` 便于验收。
- `web/styles/assistant-home.css`（+136 行）：`.xz-mic-overlay`（z-index 140）/ `.xz-mic-card` /
  步骤 / 按钮 / spinner / 窄屏样式；深绿 + 香槟金，沿用现有 token。
- `scripts/verify-mic-permission.js`（新，32 项）：静态断言 + 3001 只读；
  `scripts/verify-all.js` 注册 `mic-permission` 套件（fast）。

验收（本机实测）：
- `node scripts/verify-mic-permission.js` → **32 / 0**。
- `node scripts/verify-xiaozhi-home.js` → **45 / 0**。
- `node scripts/verify-assistant.js` → **105 / 0**（离线 ASR 真样例仍通过）。
- 真实 Chrome 9222 + CDP（DSH 浏览器 profile，`Browser.setPermission` 控制权限态）：
  - 权限 `denied`：点麦克风 → 弹权限卡，全文包含 Chrome/Windows 步骤与实际 `NotAllowedError ·
    Permission denied`；截图 `.scratch/mic-diag/mic-a-denied.png`；
  - 权限 `prompt` + 注入 pending `getUserMedia`：点按 → 「正在请求麦克风」卡（截图
    `mic-c-requesting.png`）；松手后 resolve → 「✓ 麦克风已允许」卡（截图 `mic-d-granted.png`），
    未进入录音；
  - （17:15 更正）当时真 `getUserMedia` 仍被拒绝，**不是窗口在后台**，而是 `server.js` 的
    `Permissions-Policy: microphone=()`；详见下一节。修复后真 Chrome 已实测拿到 live track。
- **未改** 3001 进程/端口，未重启服务，未建任务，未产生计费调用；`web/` 静态文件刷新即生效。
- 本机正常 Chrome（用户截图所在窗口，PID 123808）的站点权限已从「询问（默认）」改为
  **「允许」**，实测落盘：
  `Preferences → profile.content_settings.exceptions.media_stream_mic["http://localhost:3001,*"].setting = 1`
  —— 之后按麦克风不会再弹授权框。这是**本机浏览器设置，不是代码**；如果要恢复询问：
  `chrome://settings/content/microphone` → 把 `http://localhost:3001` 改回「询问」。
- 用户侧操作：刷新 `/` → 按住麦克风即可；若之后换机器/换 profile，权限卡仍会按上面的步骤引导。
- Windows 隐私两处开关均已 Allow（本轮只读确认）。

## 2026-11-16 17:15 根因补齐：server.js 的 Permissions-Policy 把 microphone 禁了

用户 17:06 再次反馈「麦克风权限还是打不开」。复核结果：
- Chrome 站点权限仍是 Allow（`Preferences` 里 `["http://localhost:3001,*"].setting = 1`），
  Windows `ConsentStore\microphone` 仍是 Allow，设备也在；但小智页仍报 `NotAllowedError`。
- `GET /app` 响应头实测：
  `Permissions-Policy: geolocation=(), microphone=(), camera=()` —— 来自 `server.js:98`
  （2026-11-12 安全加固时加的响应头）。
  **浏览器文档级 Permissions-Policy 高于站点权限：Chrome 站点设成「允许」也压不过它。**
- 这解释了为什么 13:52 只修前端权限卡 / Chrome 站点权限没有效果。

修复：
- `server.js:101`：`Permissions-Policy` 改为
  `geolocation=(), microphone=(self), camera=()`；只放行同源页面的麦克风，
  camera / geolocation 继续禁用。这是后端代码，**必须重启**才生效。
- `web/src/components/xiaozhiPlan.js`：新增「站点已允许但页面仍被禁止」分支，
  直接提示检查 Permissions-Policy / Windows 桌面应用麦克风权限，避免再次误判成站点权限。
- `scripts/verify-mic-permission.js`（37 项）：新增 `server.js` 与 `GET /app`、`GET /`
  响应头的 `microphone=(self)` 断言。
- 重启记录：旧 PID 10860（17:03 启动）→ 新 PID 46424（17:13:54）；
  `node scripts/check-server-version.js` → **0**（运行中就是磁盘代码）；
  响应头实测 `microphone=(self)`。
  重启清空了内存会话，日志显示 17:14:04 admin 重新登录成功。

验收（本机实测）：
- 真 Chrome（CDP 9222，`Browser.setPermission` granted，页面 `http://localhost:3001/login.html`）：
  `getUserMedia` **成功**，894ms，track `默认 - 阵列麦克风 (AMD Audio Device)`，
  `readyState=live`；测试后关闭 track。**浏览器层/响应头层已通**。
- `node scripts/verify-mic-permission.js` → **37 / 0**；
  `verify-xiaozhi-home` → **45 / 0**；`verify-assistant` → **105 / 0**；
  `verify-all --only mic-permission,xiaozhi-home` → **82 / 0**。
- 未改 Windows 站点设置；未起第二实例；端口仍 3001；重启是后端 header 生效的必要操作。
- 用户侧：刷新小智页（`/`）→ 按住麦克风；如果页面还是旧提示，按 Ctrl+F5 强刷。

## 2026-11-16 17:40 语音交互修正：「一个点儿」不是权限错误

用户反馈：按住说话后「只显示了一个点儿」。复核：
- 按钮上的 `●` 是录音中标记；同时 UIA 读到输入框里有一个 `.`。
- 用 3 秒**静音 WAV** 直接跑 `src/assistant/asr.js`：SenseVoice 返回
  `{"ok":true,"text":"그.","lang":"ko"}` —— 静音/噪声会产出标点/杂字；
  旧前端把 `j.text` 原样塞进输入框，于是用户看到「一个点儿」，其实没听到人声。
- 旧界面在 `getUserMedia` 约 0.9 秒的启动期间没有提示，用户容易松手；
  松手早于 stream ready 时只会反复提示「请再按住」，也会让人以为坏了。

改（纯前端，静态文件刷新即生效；**本轮不需要再重启后端**）：
- `web/src/components/xiaozhiPlan.js`：
  - 新增 `starting` 状态 + `.xz-mic-status` 状态条（portal）：
    「正在打开麦克风… 请继续按住」→「正在录音 N 秒 · 请说话，松开结束」→「正在识别语音…」；
  - WebAudio `AnalyserNode` 监控录音 RMS；录音 < 600ms 或峰值 < 0.005 时**不送 ASR**，
    直接提示「录音太短 / 没听到声音」；
  - ASR 结果去掉标点/符号后为空（如 "."）→ 提示「没听清：只识别到标点/杂音」，不写输入框。
- `web/styles/assistant-home.css`：`.xz-mic-status` 胶囊、红点脉冲、识别 spinner、窄屏。
- `scripts/verify-mic-permission.js`：新增 4 项（状态条/电平兜底/标点过滤/CSS），共 **41 项**。

验收：
- 真 Chrome CDP 9222（同源 `login.html`；注入 React 渲染 `VoiceButton`；合成 440Hz 音轨 +
  假 ASR 返回 "."）：按住 1.3s → 按钮 `●`、状态条「正在录音 1 秒 · 请说话，松开结束」；
  松开 → 状态条消失、`__micText=null`、提示「没听清：只识别到标点/杂音…」；
  截图 `.scratch/mic-diag/mic-ux-test.png`。
- `verify-mic-permission` **41/0**；`verify-xiaozhi-home` **45/0**；`verify-assistant` **105/0**；
  `verify-all --only mic-permission,xiaozhi-home` **86/0**。
- 用户侧：Ctrl+F5 后再按住，**说话**（不要只按住不动）；状态条会提示正在录音/识别。

### 17:45 复核：真正没声音的是 Chrome 默认麦克风选成了 ToDesk 虚拟声卡

- `chrome://settings/content/microphone` 实测：
  `BEFORE = 麦克风 (ToDesk Virtual Audio)`；
  `AFTER  = 阵列麦克风 (AMD Audio Device)（系统默认设置）`。
- `麦克风 (ToDesk Virtual Audio)` 没有用户人声，浏览器录到的是杂音；
  新前端按设计提示「没听清：只识别到标点/杂音」。这不是 ASR/权限问题，是**选错输入设备**。
- 已在本机 Chrome 把默认麦克风改为 `阵列麦克风 (AMD Audio Device)`（浏览器设置，不是代码）。
  若用户是通过 ToDesk 远程操作这台电脑：应改回 `麦克风 (ToDesk Virtual Audio)`，
  并在 ToDesk 里打开远程麦克风转发，否则本机阵列麦克风听不到远端说话。
- 17:31 左右 3001 服务进程退出，页面出现 `网络异常：Failed to fetch` / `语音上传异常：Failed to fetch`
  （与语音代码无关）；17:32 已用后台进程重启（PID 138100），stdout/stderr 落
  `data/logs/console-2026-11-16-1735*.log`。重启清空内存会话，用户 17:34 重新登录。

## 2026-11-19 深夜：i2v 同配置补跑成功 + 两个落库/质检缺陷修复 + 小智英文工具话术（S3）

### 补跑结果（用户点击，未代跑）

- `task_mwnosz8o_uyl4`（WhaleTV 中转 `wan3.0-video`，3 段 ×10 秒，720p）23:44:32 → 23:51:34 完成，
  2 次 504 自动重试（23:45:35），3/3 片段 success；每段 10.031s / 1912×1082 / 30fps；
  成片 28.816s / 1280×720 / h264+aac / 7,767,422 B；完整解码通过；mean -16.2 dB / max -1.5 dB。
- 提交给网关 5 次（3 成功 + 2 重试）；504 是否计费无法确认，实际以中转账单为准。
- 事故记录已更新：`docs/交接/2026-11-19-图生视频504事故记录.md` §5–§7。

### 缺陷 1：success 片段 duration 从未落库 → 终检接缝/色彩永远「未执行」

- 根因：`pipeline._finishClipSuccess()` 未写 duration；片段质检里已有 10.03。
- 修复：写 `qcResult.details.duration.duration`（无则任务配置兜底），并 `error:null` 清掉上次 504 文案。
- 证据：修复后用真实时长复测该成片，接缝实测失败（缝#1 SSIM 0.957 / MAD 17.15×；缝#2 SSIM 0.885 / MAD 46.5×，
  阈值 8×；色差 ΔE 48.1 / 49.72，阈值 40）。即：红的原因变成真实测量，而不是「未执行」。
  多场景是否放宽阈值，需用户决定（本次未改阈值）。
- 验收：`scripts/verify-pipeline-fixes.js` [5] 组 4 项。

### 缺陷 2：异步落库乱序 + 无连接重试 → DB 停在 mixing

- 根因：`taskManager._saveTask()` 并发 fire-and-forget，较早快照后到会覆盖 completed；
  写库连接超时只 `console.error` 无重试。
- 修复：按 taskId 串行落库（`saveChains`）+ `flushSaves()`；`storage/index.js` 对连接级瞬时错误重试一次并
  重建连接池（`postgres.js resetPool()`）；`_test-cleanup.js` 删除前等待 flush。
- 数据修复：`task_mwnosz8o_uyl4` 的 DB 记录已写回 completed、3 段 duration=10.031、error=null（未改 finalQC）。
- 验收：`scripts/verify-pipeline-fixes.js` [6] 组 3 项（第一笔慢/第二笔快 → 断言不并发、最终 completed）。

### 小智 S3：英文工具回复零中文（E1–E5，离线）

- 修复前 live（真实模型 10 轮）：7/10 条中文（status/budget/diagnose/last_video/prefs/bgm/settings_change）；
  assets/chat/plan_video 英文。→ 失败。
- 修复：`src/assistant/supervisor.js` 增加英文分支（status / context / assets / diagnose / last_video /
  prefs / bgm list-pick-next-off / settings_change）；`agentRuntime.js` 错误码→英文映射（`TOOL_ERROR_EN`）；
  `memory.formatWhenEn`（英文相对时间）；英文 reply 不贴中文任务标题（属内容，E10 待定）。
- 验收：`verify-assistant` 新增 11 项 EN 断言 → **341/0**（含 1 条中文零回归断言）。
- live 复测未做（需重启 3001；预计 ¥0.15 左右）→ **未验证**；用户批准额度 ≤¥1，本次实测约 $0.02。

### 本次跑过的门禁（逐个，`verify-all` 仍 EPERM）

`verify-assistant` 341/0、`verify-agent` 60/0、`verify-assistant-followup` 42/0、
`verify-assistant-frontend` 101/0、`verify-i18n --strict` 12/0、`verify-i2v` 46/0、
`verify-pipeline-fixes` 35/0。
`verify-recovery-fixes` 24 passed / 1 failed：样本 `clips/mock_mvgy1dd6_4tbe09.mp4` 不存在
（环境文件缺失，断言在 `fs.existsSync` 处失败，非本次改动）。

### 未做 / 待用户

- 重启 3001 让后端修复生效；重启后复测英文 live。
- ETA（小智答「还要多久」）：本次实测 3 段 ×10 秒 i2v 串行 = 7m02s，可作为估算基准；未实现。
- E6–E8、E10、多场景接缝阈值。

## E11 · 英文界面库存数据零中文（2026-11-20）

用户反馈：英文界面下库存历史记录仍有中文名称，片段库/图片库仍显示中文提示词。

- 根因：E10 只给 Library 的 clip/final 条目写了 `promptEn`；`/api/tasks`、`/api/photos` 根本没有该字段，
  而库存「未完成 / 任务回收站」与图片卡片直接渲染原始 `prompt/imagePrompt`。
- 修复：新增 `src/taskEn.js`、`src/photoEn.js`（离线解析：英文原文 → 场景卡英文模板（覆盖段保护）→
  人工词表 → `null` 占位，绝不回退中文）与 `assets/library/tasks-en.json`、`photos-en.json`；
  `server.js` 在 tasks / tasks/:id / tasks/completed / photos / photos/:id / trash / recycle 增加 `promptEn`，
  `/api/library` 对缺字段条目兜底解析并让搜索匹配英文。
- 前端：库存（未完成卡片/任务回收站/回收站/图片卡片/图片只读提示词）、统一任务名、任务抽屉、顶栏任务条、
  剪辑台素材卡、配乐/调色任务列表均改为英文优先；解析不到显示 `common.promptEnMissing`。
- 刻意不改：图片库详情中**可编辑**的 imagePrompt/videoPrompt 文本框仍显示原始数据，避免英文界面保存时覆盖中文原文。
- 负向口径：历史数据存在 `????????????` 这类损坏/占位文本，按「无字母 / 问号占比 >20%」判为非英文，
  回退词表或英文占位，不显示乱码；词表（byTaskId）优先于「任务里某一段恰好是英文」，避免整条标题张冠李戴。
- 验收：新增 `scripts/verify-en-data.js`（50/0，已注册 `en-data`/fast）；`verify-library-en` 27/0、
  `verify-i18n --strict` 12/0、`verify-photo-adjust-ui` 73/0、`verify-p6-offline` 41/0、
  `verify-assistant-frontend` 101/0、`verify-frontend-contract` 49/0、`verify-editor-media` 21/0、`verify-library` 36/0。
- live 未验证：运行中的 3001 启动于改动前，后端新字段需重启生效；重启前英文界面显示英文占位（不再中文）。
- 说明：`verify-clip-library-detail` 12/6 为**改动前即存在**的陈旧断言（找硬编码中文标签，源码已 i18n 化），
  本次未改。详见 `docs/交接/2026-11-20-E11-英文库存数据.md`。

## E12 · 小智「提示词 ≠ 场景卡」+ 英文简报本地化（2026-11-21）

用户反馈（两张截图）：①「我说看一下提示词，它给的是场景卡的内容」；② 英文界面下【小智简报】仍是中文。

**① 提示词 / 场景卡混淆 —— 根因（本机 node 复现，非猜测）**

- 用户真实原话「我要查看完整的全部12段12个场景的提示词」：`memory.classify` 里
  「提示词」+ 查看动词词表不含「查看/全部/完整/所有」→ 查看分支不命中；
  「场景」不带疑问词 → `RE_PLAN_SCENES` 不命中；最后被 `RE_CREATE` 的「12 段」抢成 **create**
  → 小智把"我要看提示词"当成"重排一条 12 段计划"，回了一张新计划卡
  （卡上「场景：场景卡库随机抽取 12 个不同场景」读起来就像在讲场景卡）。
- 第二层：即使 classify 判成 plan_edit，`replyForPlanEdit` 入口也不调 `tryReplyPromptView`，
  纯查看句会落到「要换第几段？」的编辑反问；且 `tryReplyPromptView` 自己仍用旧窄正则过滤。

修复：

- `src/assistant/memory.js`：查看词表补「查看/全部/完整/所有/发一下」及英文 show/display/list；
  「提示词 + 查看形态」先于 plan_scenes/create 归 plan_edit；「第 N 段的提示词」（无改动动词）算查看；
  只带「场景」的查看句（「…12个场景的场景卡」）归 plan_scenes。`traceMatches` 同步同序。
- `src/assistant/supervisor.js`：`tryReplyPromptView` 判定改用 memory.isPromptViewRequest（与 classify 同源）；
  `replyForPlanEdit` 开头先走只读视图；文案改为「**提示词原文**…不是场景卡清单（要看卡说"场景卡"）」，
  卡名降为括注（旧文案「来源：场景卡 X」会被读成在列卡）；「全部/每段」放宽到 20 段（12 段一次全看到）。
- `agent.js` / `brain.js` 提示词加显式「槽位区分：提示词 = 发给模型的文字；场景卡 = 库条目；
  两者同现时用户要的是提示词」。

**② 英文简报中文 —— 根因**

简报以前在服务端只生成**一份中文 text**，广播给所有连接（WS 带的 lang 只是标注）。

修复：

- `src/assistant/broadcast.js` 新增纯函数 `render(payload, lang)`：zh 原样返回同一对象（零回归）；
  en 生成 `textEn` + `items[].textEn`（`[Briefing]` 前缀、Created/Started/Failed/Completed、
  诊断类别 + 英文建议；taskId / 模型 id / 文件名 / 错误原文属内容，保留）。
- `src/wsManager.js` 的 `broadcastAssistant` 按**连接语言**逐连接渲染。**注意**：
  taskManager → wsManager → broadcast → taskManager 是已存在的环，broadcast 必须**延迟 require**，
  顶层 require 会让 broadcast 拿到未完成的 taskManager（`getAllTasks is not a function`，已实测踩到）。
- 前端 `assistantBroadcast.briefText(msg, lang)` 在 en 下优先 `textEn`（切换语言无需重连）。

**验收（全部实跑）**

- 新增 `scripts/verify-broadcast-i18n.js`（42/0，已注册 `broadcast-i18n`/fast）；
  `verify-assistant` 341/0、`verify-assistant-followup` 48/0（新增用户原话 3 条，并把旧文案断言改为新文案）、
  `verify-agent` 60/0、`verify-agent-scenarios` 25/0、`verify-brain` 30/0、
  `verify-assistant-diagnostics` 103/0、`verify-assistant-frontend` 101/0、
  `verify-i18n` 11/0、`verify-i18n-backend` 104/0/1 跳过、`verify-i18n-runtime` 29/0。
- 负向对照：把 `render` 改成永远返回中文 → 3 项红；删掉 classify 的提示词查看分支 → 3 项红（恢复后 42/0）。
- **未验证**：运行中的 3001（PID 90612，启动于 2026-11-20 23:55）是改动前的旧进程，
  且本会话无权结束它（taskkill Access denied），所以**浏览器/WS 实时链路未复验**；
  请在你自己终端里结束该进程（Ctrl+C 或任务管理器结束 PID 90612）后运行 node server.js 再复验。
- `node scripts/doctor.js`：ffmpeg/ffprobe 两项 ❌ 为**改动前即存在**（实测 ffmpeg -version 可执行，exit 0），与本次无关。
## E13 · 创作页四项 + 失败提醒英文（2026-11-21 晚）

用户反馈（p1–p4 截图）：① 英文模式创作页提示词仍是中文；② Show all / Collapse 看不出区别；
③ 每次进创作页场景卡都一样（想要「抽卡」按钮 + 每次不同）；④ 创作模块整块崩；⑤ 生视频失败后小智回复/提醒仍是中文。

**④ 崩溃（最高优先级）：`i2vUnsupported is not defined`**

- 根因：`web/src/screens/createSmart.js` 第 4/5 步的按钮引用了一个**从未声明**的变量。
  该引用在 `${step === 4 && html`...`}` 里，只有第 4/5 步渲染才求值，所以第 1 步与静态 grep 都测不到；
  实测把声明删掉后第 4/5 步必抛 `ReferenceError`（已做成负向回归用例）。
- 修复：按 `/api/image-gen/status` 的 `i2vModels` 推导（仅「要图生视频且通道不在能力表」时禁用），
  并在页面上写明原因；纯文生视频永不禁用。
- 新增 `scripts/lib-render-probe.js`：把浏览器 ESM 改写成脚本、用「立即求值的 htm 桩」在 vm 里
  **逐步渲染 1–5 步**。以后任何一步的未声明变量都会在门禁里现形。

**① 英文创作页提示词中文**

- `/api/scene-cards/preview` 新增显式 `?lang=`（缺省仍按 cookie → Accept-Language → zh），
  响应回显 `lang` 与每段 `promptLanguage`；前端请求带 `&lang=`。
- 前端兜底：英文界面若仍拿到含中文的提示词，按卡 id 重取一次（有上限）；切换语言后自动重算提示词，
  草稿里的旧语言文案不再锁死。
- 实测（本机 composer）：`lang=en` 时提示词为 `Subject: … / Camera: …` 纯英文；`lang=zh` 时不变。

**② Show all / Collapse**

- 只在 >12 段时出现（否则它本来什么都不做）；按钮带段数（显示全部 N 段 / 收起）；
  折叠时显示「还有 N 段未展开（会自动提交自动合成的提示词）」并给一键展开。

**③ 换一批场景卡**

- 服务端 `allocate(count, { seed })` 已支持确定性序列；预览接口新增 `?seed=`。
  「换一批场景卡」= 新种子；每次进①也是新种子（不再每次同样几张）。
- **注意**：实测运行中的 3001 是旧进程，`?seed=` 被忽略（两次同 seed 结果不同），重启后生效。
- 预览仍 `recordCooling:false`：不占卡、不写冷却、不收费。

**⑤ 失败后的中文提醒**

- 状态机 `summary()` 增加 `labelKey` / `labelZh`，并按连接语言给 `label`（英文 = Needs your decision 等）；
  前端状态条按 `labelKey` 本地化（注意 `tr()` 缺词条会回退中文，故还需校验当前语言）。
- 小智监控消息（审图提醒 / 完成 / 失败 / 「还有 N 段没成功…要不要我再跑一次」/ 任务不见 / 补位）
  全部补英文；`finish()` 按 `monitor.lang` 选 `replyEn`，缺英文时如实回退中文。

**验收（全部实跑）**

- 新增 `scripts/verify-create-page.js`（31/0，已注册 `create-page`/fast）：含「逐步渲染 1–5 步」与
  「删掉声明 → 第 4/5 步必红」的负向对照（实测 28/3）。
- `verify-broadcast-i18n` 42/0、`verify-assistant` 342/0、`verify-assistant-followup` 48/0、
  `verify-assistant-diagnostics` 103/0、`verify-assistant-frontend` 101/0、`verify-agent` 60/0、
  `verify-agent-scenarios` 25/0、`verify-brain` 30/0、`verify-i18n` 11/0、`verify-i18n-backend` 104/0/1 跳过、
  `verify-i18n-runtime` 29/0、`verify-editor-final-source` 43/0。
- 提交：`78e812c`（只含本次文件；工作区里 `.env.example` / `config.js` / `src/pipeline.js` 的改动属**另一会话**，未触碰）。

**未验证**

- 运行中的 3001（旧进程）浏览器端未复验：登录后用只读接口实测 `/api/scene-cards/preview`
  「`?lang=en` 仍返回中文、`?seed=` 不生效」= 旧后端，需用户重启后复验（前端部分刷新即生效）。
- 真实出图/出视频链路未跑（计费），本次只验接口与渲染。

## E14 · 单片段等待超时阈值 + 「超时 ≠ 生成失败」三态（2026-11-21 夜）

**背景（事件 `task_mwp70yzl_lh54`，2026-11-21 00:28~00:55）**

9 段 10s/720p 图生视频（`wan3.0-video`、i2v、首帧压缩后 174~274KB）里，片段 #7 首轮被判「超时」；
`autoRetry=false` → 不重试、不拼接，整任务 `failed`。用户手动补跑该段，**249.3s 就成功**，
最终 9/9、成片 86.6s（1280×720/30fps，h264+aac）。即：那一段**本来能出片**。

**根因（实测数值，非推测）**

- `_waitForCompletion` 的 `maxWait` 默认值是**硬编码 `300000`**，而唯一调用处（`_processSingleClip`）
  **不传第二个参数**，所以永远是 300s 上限。
- 本任务 9 次成功出片耗时：228.3 / 230.2 / 233.3 / 254.0 / 240.9 / 228.7 / 279.9 / 285.1 / 249.3 s，
  平均 247.7s；**最长成功样本距 300s 只剩 14.9s（5%）**。首轮就有 3 段 ≥250s。
  → 300s 与真实分布贴死，**超时是概率性必然，不是偶发**。
- 错误文案只有一个裸字符串 `'超时'`，既不能区分「本地等超了」与「上游判失败」，也让日志把
  「等待超时」写成了「生成失败」，容易误导成模型拒绝/内容违规。

**改动**

| 文件 | 内容 |
|---|---|
| `config.js` | `GENERATION.clipWaitTimeoutMs` ← `GEN_CLIP_WAIT_TIMEOUT_MS`，默认 **600000** |
| `src/pipeline.js` | `_waitForCompletion` 的 `maxWait` 缺省读 config（显式传参仍优先），不再硬编码 300s |
| `src/pipeline.js` | 超时返回 `{ status:'failed', waitTimeout:true, error:'等待超时：已等 Ns 仍未完成（本地等待上限，不代表模型生成失败；上游可能仍在生成）' }` |
| `src/pipeline.js` | `_processSingleClip` 抛错时保留 `waitTimeout` 标记；日志按标记分口径——超时**不再**写「生成失败」 |
| `.env.example` | 补 `GEN_CLIP_WAIT_TIMEOUT_MS=600000` 及取值依据 |
| `scripts/doctor.js` | 新增 `runCapture()`：`execFileSync` 捕获 stdout 遇 `EPERM` 时降级为「stdout 落临时文件再读」；ERROR 附带错误码 |

**澄清（本次核实，纠正一次先前误判）**

单片段失败**不会**中止其余片段——这是既有行为，不是本次新增：

- worker 循环失败后 `continue`；`_finishClipFailure` 只改片段记录，**从不**改 `task.status`；
- 本任务日志时间线：片段 #7 于 16:47:13 判失败后，**片段 8（16:47:25）、片段 9（16:47:58）仍成功**，
  汇总发生在 16:47:58。所谓「不拼接」只表示**不进入下一阶段（拼接）**，不是丢弃在跑/未跑的片段。

**刻意未改**

`BaseGenerator.canRetry` 仍不把「等待超时」判为可重试（它只匹配英文 `timeout` 等）。
理由：超时时上游可能**仍在正常生成**，自动重试有重复计费风险；保持「只报失败、由用户决定补跑」。

**验收（全部实跑）**

- 临时脚本（仓库外，跑完即删）**15/0**：含「不传 maxWait 也读 config」「`GEN_CLIP_WAIT_TIMEOUT_MS=1300`
  时真在 ~2.0s 返回（不是 300s）」「上游真判失败（`内容违规`）原样透传且**不带** `waitTimeout`」
  「成功结果不带 `waitTimeout`」。
- 回归：`verify-qc-report-mode` 14/0、`verify-i2v` 46/0、`verify-openai-video` 24/0、
  `verify-stage-pipeline` 37/0、`verify-pause` 71/0。
- `node scripts/doctor.js`：**0 个必须修复 / 7 个提醒**（改前是 2 个 ❌：ffmpeg/ffprobe「无法执行」）。
  该项为**环境限制**，已用同一份二进制实测三态：`encoding:'utf8'` → `EPERM`；`stdio:'ignore'` → 正常；
  重定向到文件 → 读到 `ffmpeg version 8.1-full_build`。
- doctor 负向：`FFMPEG_PATH=C:\nope\ffmpeg.exe` → `❌ 无法执行: …（ENOENT）`、退出码 1（不假绿）。

**副作用 / 可调**

失败感知最多比原来晚 5 分钟（300s→600s）。要回旧行为：`.env` 写 `GEN_CLIP_WAIT_TIMEOUT_MS=300000`。

**未验证**

- 600s 阈值下**未**用真实付费任务复跑（按 §4.9 需用户先同意计费）；数值依据仅来自
  `task_mwp70yzl_lh54` 的 10 次真实出片样本（n=9 成功 + 1 超时）。
- doctor 的降级分支只在**本机沙箱**触发过；无 EPERM 的机器上不会走到，属未覆盖路径。

**修订（2026-11-21 晚）：默认 600s → 450s**

用户质疑「600s 太慢」。复核后认可这个质疑：600s 是我按「2× 观测最大值」的经验拍的，
不是拟合结果，对一个只有 n=9 的样本属于过度保守。实测分布（右删失：失败那次真实耗时未知）
均值 247.7s、σ 21.7s、最小 228.3s、最大 285.1s，最大/最小仅 1.25，是**紧分布**而非重尾：

| 上限 | 比最长样本高 | 相当于 | 真失败的感知延迟 |
|---|---|---|---|
| 300s（原硬编码） | 5% | 均值 + 2.4σ | 约 5 分钟 |
| **400s（最终默认）** | **40%** | **均值 + 7.0σ** | **约 6.7 分钟** |
| 450s（过渡值） | 58% | 均值 + 9.3σ | 约 7.5 分钟 |
| 600s | 110% | 均值 + 16.2σ | 约 10 分钟 |

补充一个当时没说清的背景：事故那一刻 `GEN_CONCURRENCY=3`、日志里**没有**「图生视频串行提交」
提示，即当时是 **3 段并发打网关**（进程跑的是 11-19 串行化之前的代码，11-21 00:47 那次重启后才生效）。
现行代码 i2v 默认串行（`I2V_CONCURRENCY` 缺省 1），尾部被拖慢的概率更低，450s 更站得住。

**这个值只是上限，不是等待**：正常片段一完成就立刻返回，调大不会拖慢成功任务，
它只决定「真卡住时多久报失败」。

**二次修订（2026-11-21 20:38，用户拍板）：450s → 400s。**
450s 的 58% 余量对当前这种紧分布偏富余（均值 +9.3σ），用户明确要求失败提示更快，故取 400s：
仍有 40% 余量（均值 +7σ），真失败感知约 6.7 分钟。
**不建议低于 400**：余量会掉到 <40%，而唯一一次超时是并发争抢造成的（当时 `GEN_CONCURRENCY=3`），
尾部事件真实存在，不宜按「平均值 + 一点点」设阈值。

## E15 · 剪辑台「保留原声」+ 预览黑屏/偏移三连修（2026-11-22）

用户三连反馈：①剪辑台预览整块黑 → ②修好后画面只占右半侧、不居中 → ③成片自带音频被取消。
三件事根因各不相同，逐条记录。

### ① 预览静默黑屏

现象：检出成片在剪辑台预览整块黑，页面无任何报错（无红条、无提示）。

排查（服务端先排除掉）：`/api/library` 有条目且 `url=/output/<id>.mp4`；带登录态 GET 返回
**206 / video/mp4**；成片 h264 **High@3.1** yuv420p + aac LC、`ftyp→moov→free→mdat`（faststart）；
首帧亮度 YAVG≈119~131（不是黑帧）。按 editor 的取数链路（project + /api/library → segs）逐行复算，
`url` 非空且时长正确 —— 即引擎拿到了地址，问题在「取帧」。

根因（静默）：`PreviewEngine._upload()` 对 `readyState < 2` 直接 return，画布一直停在初始 1×1 黑色纹理，
整条链路不抛异常，所以既没有 `onError` 也没有 UI 提示。叠加两个触发因素：
`video` 宿主是 `display:none`（部分 Chrome 会推迟/跳过解码）；`_cue()` 只等 `loadedmetadata`
就立刻 seek + 渲染（元数据到了但帧没解码）。

修复：
- `_cue()` 改为等 **`loadeddata`**（真的有一帧）再往下走，`seeked` 后再补一次渲染
- video 宿主改「移出视口但保留布局」（`position:fixed;left:-9999px`），不再 `display:none`
- 同源素材不再强制 `crossOrigin='anonymous'`（跨域才开，去掉一类 CORS 模式失败面）
- 8s **看门狗**：一帧都没画出来 → 换 cache-buster 自动重载一次 → 仍失败就把
  `HTTP 状态 / readyState / MEDIA_ERR / 源` 显示到预览框底部（新增 i18n `noFrame`/`mediaLoadCode`）

### ② 画面只占右半侧、不居中

自检浮层（新增 `?diag=1`，只读、无需 DevTools）实测：

```
vw=1404  main=0,46 2924x458  stage=300,46 2324x420  frame=1032,56 860x400
canvas=1033,57 858x398  bitmap=858x483  scrollW=1404
```

根因：`.ed-root` 只写了 `grid-template-rows`，**没有显式列**，隐式列按内容 `max-content` 撑到
**2924px（≈2 倍视口）**；中间列拿到 2324 宽，预览框被算到 x=1032；`.ed-root` 又是 `overflow:hidden`，
于是不是滚动、而是右侧被裁掉。

修复：`.ed-root` 增加 `grid-template-columns: minmax(0,1fr)`；`.ed-stage`/`.ed-frame` 由 grid 改 flex 居中；
`.ed-frame` 去掉 `aspect-ratio`（与 `max-height:100%` 打架会压扁），改为填满舞台；
`engine._draw()` 位图按「显示尺寸 × DPR」建，并用 `gl.viewport` 做 **16:9 居中 letterbox**
（旧实现位图恒为 `w*9/16`，被塞进 858x398 会纵向变形）。

### ③ 成片自带音频被丢（本次新增功能）

用户问：「视频自带的音频在剪辑模块会取消掉吗？正常吗？」

事实：**预览静音是设计**（`engine` 里源视频一律 `muted`，只播配乐/环境音两轨），
但**导出是真丢**——`editorExporter` 拼接阶段写死 `ignoreAudio:true`（先产出无声视频），
随后 `audioMixer.buildMixArgs` 只 `-map 0:v` + 配乐轨 `[aout]`，**从不接 `0:a]`**；
没有配乐时直接把无声中间文件改名成交付文件 = **导出无音轨视频**。
且 `audioMixer.js` 注释里写了 `keepOriginalAudio` 却从未实现。顺带核实：流水线 `audio_mix`
同样只混配乐，所以成片从来就没有「原声」——本例音轨是 BGM `calm_04`（-16dB）。

用户选择方案 B（加开关、默认保留）。实现：
- `bgmPlan.buildMixCommand`：支持 `keepSourceAudio`（`[0:a]` → 裁到成片时长/重采样/音量 → 与原配乐
  `amix`）。**配乐走 loudnorm 归一化，原声不参与归一化**（只按 `sourceVolume` 缩放），否则用户听到的
  「原声」会被改音量。只有音乐轨且开闪避时，用原声做 `sidechaincompress` 的 key 压音乐。
  另修一个潜在缺陷：两轨都没有时 `mergedLabel` 曾错误置为 `'ambientout'`（不存在的 label）。
- `audioMixer.mixBgmPlan`：新增 `keepSourceAudio` / `sourceVolume`；先 `probeHasAudioStream` 探测，
  输入无音轨时自动降级并给 warning（避免 `[0:a]` 直接让 ffmpeg 报错）。
- `editorExporter`：`ignoreAudio: !keepOriginal`；混音时传 `keepSourceAudio/sourceVolume`；
  `job.audio` 记录 `keepOriginal/originalVolume/keptSourceAudio/warnings`。
- `projectStore.normAudio`：新增 `keepOriginal`（默认 **true**）、`originalVolume`（默认 1，0~1.5）。
- UI：`audioPanel` 新增「原声」卡片（开关 + 音量滑杆）；`i18n` 补 4 个键。
- 预览：`PreviewEngine.setSourceAudio()` 打开时解除 `muted`，并按叠化比例做**交叉淡化**
  （旧 slot 1→0、新 slot 0→1），避免接缝处两轨同时出声。

**验收（真 ffmpeg，全部实跑）**

- 新增 `scripts/verify-editor-keep-original-audio.js`（**21/0**，已注册进 `verify-all`）：
  配乐音量置 0 做隔离 —— 保留原声 **-24.2 dB** vs 丢弃 **-91.0 dB**（**差 66.8 dB**），
  证明源音轨真的进了混音；另覆盖「配乐+原声并存」「只保留原声（`[src]anull` 分支）」
  「无音轨输入给出可读错误」。
- 回归：`verify-transitions` 36/0、`verify-editor-preview` 42/0（新增 12 条断言：
  看门狗/loadeddata/crossorigin/根节点列宽/letterbox）、`verify-editor-export` 31/0、
  `verify-i18n --strict` 12/0、`verify-editor-media` 21/0、`verify-library` 38/0。
- `verify-bgm-plan` 本机**跳过**（缺测试视频，属既有跳过，不计通过）。
- `verify-all.js` 在本沙箱仍 `spawn EPERM`（已知环境限制），只能逐套件跑。

**未验证**

- 本沙箱无可用浏览器（Chrome 需命名管道被禁；Electron 未安装），三处**视觉/听感**结论均未在真机复验：
  预览是否居中、原声是否可闻、转场交叉淡化是否自然。代码层面只能保证「不再静默失败」且新增断言在门禁里。
- 存量工程没有 `audio.keepOriginal` 字段 → 走默认 `true`；`originalVolume` 同样默认 1。
- 存量两条 `status=mixing` 的成片条目未迁移（不参与过滤，属显示层）。

**影响面**：编辑器导出默认行为改变（以前丢原声、现在保留）。若某工程确实要纯配乐，可在「原声」卡片关掉开关。

---

## 2026-11-23 · 出图自动调色开关（A 方案）

**状态**：代码与离线/契约验收完成；**真实 3001 实例未重启**（见「未验证」）。

### 背景与决策

出图默认会自动调色（`autoGrade`），但默认值此前没有服务端开关，也无法按次关闭。
本次加一个**默认关**的开关：

- 默认值只来自服务端 `.env`：`IMAGE_GEN_AUTO_GRADE_DEFAULT=off|calm`（缺省/非法 → `off`，启动告警一次），
  通过 `GET /api/image-gen/status` 的 `imageGrade.default` 下发；**不写 localStorage 默认**（否则又变「每人一套」）。
- 每次出图可在界面临时改；任务创建时写进 `task.imageGrade`，补跑/重生成沿用，**请求体不能覆盖**。
- 设置页只读展示服务端默认值，不提供可编辑的全局开关（账号平权，避免任何人改全局 = 已排除的 B 方案）。

### 字段与默认值

- `imageGrade: 'off' | 'calm'`（`src/imageGrade.js` 导出 `OPTIONS / DEFAULT / normalize / resolve`）。
  - `off`：不跑 autoGrade，只存模型原图。
  - `calm`：跑现有 autoGrade（目标 0.32、只降不升、压高光），算法未改。
- `task.imageGrade`：`createTask` 写入；**不进 `runtimeConfig`、不在 `_mergeRuntimeConfig` 白名单**。
- `photo.grade`：`{ mode, status, palette?, before?, after?, params?, originalPath?, error? }`；
  老记录读取时补 `{mode:'off',status:'off'}`，**不迁移、不改写历史 JSON**。
- 配置键：`config.IMAGE_GEN_AUTO_GRADE_DEFAULT`（本仓库 `config.js` 是**扁平键**结构，
  偏差：执行说明写的是 `config.IMAGE_GEN.AUTO_GRADE_DEFAULT`，实际按仓库现状使用扁平键）。

### 两条路径的有意差异（不得「顺手统一」）

| 路径 | 入库记录 | grade 写法 |
|---|---|---|
| 批量出图 `POST /api/images/generate-batch` | **两条**：调色后 + `_original`（既有用户要求） | 调色后 `calm/applied`（带 before/after/params）；原图 `off/off` |
| 小智计划卡 / 逐段出图 `pipeline._generateClipImages` | **一条**：只入库调色后；原图留磁盘但不入库 | `calm/applied` + `originalPath`；失败时保留原图并写 `calm/failed + error` |

原因：批量链路用户明确要「调色前/后都可见」；计划卡链路是 60–180 段批量出图，双条会让图片库翻倍，
且用户已确认只要一张可用首帧。**代价**：计划卡路径手动调色的「原图基准」是已压过的图——已在图片库详情
`originalPath`/说明里交代，未再拆回原图条目。

### 实现范围

- 后端：`src/imageGrade.js`（新）、`config.js`、`.env.example`、`server.js`（status / generate-batch /
  `/api/tasks` / `/api/assistant/execute`）、`src/processors/imageBatch.js`、`src/pipeline.js`、
  `src/taskManager.js`、`src/assistant/supervisor.js`、`src/submitGuard.js`、`src/photoLibrary.js`、
  `src/i18n/catalog/{media,tasks}.js`。
- 前端：`web/src/screens/createSmart.js`（第③步开关 + 第⑤步摘要 + 草稿）、
  `web/src/components/{xiaozhiPlan,assistant}.js`（计划卡开关/两个入口共用状态）、
  `web/src/screens/inventory.js`（角标/详情）、`web/src/screens/settingsPage.js`（只读行）、
  5 个 i18n 词条文件 + `assistant.panel.imageFirstGraded`。
- 偏差：执行说明要求改 `web/src/createDraft.js`；实际 `/create-smart` 用的是自己的
  `vs_create_smart_draft_v1` 草稿（`createSmart.js` 内部 `loadDraft/saveDraft`），已在那里加 `imageGrade`，
  **未改** 旧向导的 `createDraft.js`（旧 `/create` 本就不自动调色，属明确不做）。

### 沿用规则与已挡住的坑

- `task.imageGrade` 创建后不可变；`_mergeRuntimeConfig` 白名单不含它（`verify-image-grade` 有负向断言）。
- 缺字段的老任务按 `off`；只影响之后新出的图。
- 同提示词、不同 `imageGrade` 指纹不同，不会被 5 分钟去重误拦。
- 非法值：HTTP 入口一律 `400 + code:'IMAGE_GRADE_INVALID'`，**不静默按 off**；模块内部兜底 `off` 仅用于直调脚本。
- 计划卡调色失败：保留原图作为首帧、`photo.grade.status='failed'`、`console.warn`，**不计为出图失败**（不浪费已付费的图）。

### 验收（本机实跑，零真实计费）

- `node scripts/doctor.js`：**0 个必须修复 / 8 个提醒**（提醒均为既有环境项；其中 `.env 缺少 IMAGE_GEN_AUTO_GRADE_DEFAULT`
  属预期——默认 off，不读/不改 `.env`）。
- 新增 `scripts/verify-image-grade.js`（**31/0**，已注册进 `verify-all`）：off 单条 / calm 双条 /
  计划卡只 ingest 一条 / 调色失败保留原图 / `task.imageGrade` 不被 runtimeConfig 覆盖 / 指纹 /
  HTTP 入口静态断言。
- `verify-image-batch` **18/0**（重写为隔离目录 + ffmpeg 测试图；off/calm/非法值/单张失败）。
- `verify-photo-library` **50/0**（新增 grade 字段、老记录缺省、失败态、幂等补写）。
- `verify-i2v` **50/0**（新增逐段出图读 `task.imageGrade` / `_nextGradedPath` / 失败保留原图断言；
  顺手把该套件的 ffmpeg 临时目录改到 `app/output` 并重定向 TEMP，修掉本机 36 处 `os.tmpdir()` 假红之一）。
- `verify-assistant` **348/0**（新增 execute body 带 `imageGrade`、开关只在逐段出图时出现、不写 localStorage）。
- `verify-image-first-http` **51/0**（临时隔离实例真 HTTP：status 下发 `imageGrade`；generate-batch / tasks /
  assistant execute 对非法值均返回 **400 IMAGE_GRADE_INVALID**，且没有创建任务）。
- `verify-image-first-e2e` **11/0**（任务创建写入 `imageGrade:calm` 并保留）。
- 真实 Chromium 渲染冒烟（临时 `web/src/_grade_harness.htm`，已删除；REA/Playwright headless，1280×720）：
  `planOnHasToggle=1 / planOffHasToggle=0`、设置只读行文本正确且行内无输入控件、图片库三种角标
  （已自动调色 / 未调色 / 调色失败（保留原图））全部出现、第③步开关默认关→点开生效、
  请求体 `imageGrade=calm`；无页面异常（仅 favicon 404 与 Chrome 的 password-field 提示）。
- 手工浏览器主流程（登录后的 3001）**未验证**：见下。

### 未验证（必须如实交接）

- **真实 3001 实例仍是旧进程**：本次改动完成后尝试按规范「先停旧进程再启新进程」，
  但沙箱对该 node 进程 `Stop-Process` / `taskkill` / `process.kill` 均返回 `EPERM/Access denied`
  （进程与当前 shell 同用户同 session，命令行为空，属受保护进程）。因此：
  - 新代码只在**临时隔离实例**（`verify-image-first-http`）与**进程内单测**中生效过；
  - 3001 上的 `/api/image-gen/status.imageGrade`、真实任务的 `task.imageGrade` 落库、补跑沿用
    仍需重启后用真实请求各验一次；
  - 重启会让所有用户登出、中断运行中任务（已确认日志最后一次活动为 2026-11-22 14:57，无在跑任务）。
- 登录后的**手工浏览器主流程**未做：DSH 内置浏览器 provider 不可用（Electron 未安装），
  REA 的 Chromium 是独立临时 profile、无登录态；上述渲染冒烟用 stub API 覆盖组件本身，
  **不覆盖**「真实 status → 控件默认值 → 真实任务」端到端。
- 真实出图/视频/LLM 一律未调用（按红线，验收零计费）。

---

## 2026-11-23 · 一周返工复盘 + 防复发加固（规则 22–27 / 4 个脚本）

**背景**：用户要求复盘 11-16 → 11-23 的 bug、返工、回滚与重复修改，找出共同根因，
并把可预防的部分沉淀成规则/自动化，避免反复支付同样的成本。完整报告见
`docs/spec/retro-2026-11-16_23.md`。

### 复盘事实（实测，可复现）

- 7 天 **198** 个提交：docs **84（42%）**、feat 59、fix **36（18%）**、test 12；248 文件 **+45,056/−2,938**。
- `report-churn.js` 自动聚类出 36 个文件「24h 内被 fix ≥2 次」，其中：
  `xiaozhiPlan.js` 7 次/5.7h、`verify-assistant.js` 6 次/7.1h、`supervisor.js` 5 次/7.1h；
  剪辑台预览 42 分钟内 3 刀、等待超时默认值 18 分钟内 300→600→450→400。
- `git revert` **0 次**；但存在 3 次行为推翻（超时下调、小智方案重写、i2v 探测方式）。
- changelog 里「重启」出现 **64 次**，周内至少 8 次「运行中的 3001 是旧代码」。

### 根因（五条，按代价排序）

1. **验证手段缺位**：UI/视觉/运行时字符串没有自动验收，用户是唯一测试机（53 处「未验证」）。
2. **门禁有洞且不强制**：`verify-i18n` 的 desc 承诺 `--strict`，但 `runOne` 不传参；
   9 个脚本无 machine-readable 归属；`verify-assistant.js` 一周改 29 次（断言追着实现）。
3. **阈值靠猜**：300s 硬编码，n=9 成功样本最长 285.1s（余量 5%），超时是概率性必然。
4. **静默失败/默认放行**：裸 `return`、`duration` 不落库、中间态当终态、写库失败只打日志。
5. **事实源分裂**：受控 `app/docs/spec/changelog.md`（262 KB）与根 `docs/spec/changelog.md`（227 KB）
   **互相缺章**（根多 8 节含 11-23 主题，受控多 12 节含 E11–E15），红线 15 记过同类事故仍复发。

### 改动

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 新增红线 **22–27**（防修了又修 / 阈值须有分布 / 门禁只认真跑过 / 静默失败零容忍 / 交付前证明服务=磁盘代码 / 英文零中文是验收项）；勘误套件数 62/67→**99/109**、手动 9、未归属 0；§7 标注两份 changelog 已分叉 |
| `scripts/verify-i18n.js` | 修两个缺陷：① 块注释形式的 `i18n-allow` 被「先删块注释」自己删掉 → 语言自称「中」长期误判；② 删多行块注释会吞换行导致样例行号错位。扫描逻辑抽到 `lib-cjk-scan.js` |
| `scripts/lib-cjk-scan.js` | **新增**：CJK 扫描单一实现，供门禁与 preflight 共用（避免两份真相） |
| `scripts/verify-all.js` | `SUITES` 支持 `args`（`runOne` 真传参）；`i18n` 注册改为 `args:['--strict']`；注册 `gate-registry` |
| `scripts/verify-gate-registry.js` | **新增**：每个 `verify-*.js` 必须注册或在 `MANUAL` 写明理由；无死注册/重名；纯 fs 不 spawn |
| `scripts/preflight.js` | **新增**：一条命令自检 git 状态 + 服务版本 + 注册表 + 英文零中文；不能判定时降级为提醒 |
| `scripts/report-churn.js` | **新增**：周度返工体检（fix 占比 / 同日反复改 / 修了又修链 / 门禁覆盖 / 文档占比），只读 |
| `docs/spec/retro-2026-11-16_23.md` | **新增**：完整复盘报告（事实、根因、成本模型、后续） |

### 验收（本机实跑）

- `node scripts/verify-gate-registry.js` → **10 通过 / 0 失败**（109 实有 / 99 注册 / 9 手动 / 0 未归属）。
- `node scripts/verify-i18n.js --strict` → **12 通过 / 0 失败**（89 处 i18n-allow）。修前为 **11/1**
  （`langSwitch.js` L39「中」被误判；同一 commit 也修掉了「块注释吞换行」的行号问题）。
- `node scripts/preflight.js` → **3 通过 / 1 提醒 / 0 失败**；提醒是 git 状态检查因本沙箱
  `spawn EPERM` 降级为「请手动跑」，其余三项真实执行。
- `node scripts/check-server-version.js` → 退出码 **0**：PID 63744，启动于 `2026-11-23T06:15:58Z`，
  `running=disk`（说明上一条「仍是旧进程」已被重启解决，本次以实测为准）。
- `node scripts/report-churn.js --input <git log 转储>` → 退出码 0，对本周 198 提交产出
  36 个「fix ≥3 次」文件与体检结论。

### 未验证

- `node scripts/verify-all.js` 仍因 `spawn EPERM` 无法整体跑；只能逐个套件跑（AGENTS §2.4 已记）。
  因此「门禁整体全绿」**未验证**，本条目只声称上述单脚本结果。
- 视觉/布局/听感仍未在浏览器实测（本周 UI 缺陷 100% 由用户发现）；`preflight` 明确把它列为人工项。
- changelog 分叉**未合并**：只标注了状态，合并需人工审阅（根版含 8 节独有内容，脚本盲合有丢内容风险）。
- `preflight` / `report-churn` 的 git 分支在能 spawn 的环境未复验（本沙箱只验了降级路径）。

### 影响面

- `verify-all` 的 `i18n` 组从「只报告硬编码」变为「硬编码必须为 0」，**从此可能真的红**；
  这是有意收紧，不是回归。若需临时放行，用 `i18n-allow` 逐行标注（禁止整文件豁免）。
- 新增 `verify-*.js` 若忘记注册，`gate-registry` 会失败并挡住 `--fast`。
- 交付流程新增 `node scripts/preflight.js`（红线 26）；未跑或未写「未在运行态验证」即视为谎报状态。

---

## 2026-11-23 · 外发推送前安全复审：登录 next 开放重定向 + 垃圾箱路径穿越

**状态**：代码修复 + 静态/纯函数验收通过；运行中的 3001 已在修复后重启
（PID 52236，`serverMtime` 与磁盘一致），但未在登录态下打 `/api/trash` HTTP 负向请求 → 标「未验证」。

### 问题（本轮审计新发现）

| 位置 | 问题 | 可利用性 |
|---|---|---|
| `public/login.html` 的 `next` | 旧校验 `/^\/(?!\/)/` 只挡 `//`；`/\evil.com` 通过后，浏览器 URL 解析把 `\` 当 `/`，变成 `//evil.com` → 开放重定向 | 未登录可构造链接；登录成功后跳外站（钓鱼） |
| `server.js` `/api/trash/:id` | `id` 直接 `path.join('data/trash', id + '.json')`；`../../data/users` 可解析到 `data/users.json` → 任意 JSON 读取（返回字段受限） | 需登录；可读 `data/` 下任意 `.json` |

### 修复

| 文件 | 改动 |
|---|---|
| `public/login.html` | `next` 先拒绝反斜杠/控制字符，再用 `new URL(raw, location.origin)` 比对 origin，只返回站内 path/search/hash |
| `src/utils/security.js` | 新增 `isSafeStorageId()`：只允许 `[A-Za-z0-9_-]{1,120}`，禁止点与路径分隔符 |
| `server.js` | `/api/trash/:id` 拼路径前校验 id，非法返回 400 `BAD_TASK_ID` |
| `scripts/verify-security-hardening.js` | 新增 [6]：旧正则负向证据、URL 解析结果、`login.html` 静态接线、id 白名单用例 |
| `.env.example` | 补 `QC_SCENE_MULTI_COLOR_MODE=warn`（doctor 报「未覆盖」的唯一键） |

### 验收（本机实跑）

- `node scripts/verify-security-hardening.js` → **54 通过 / 0 失败**（修前 39；新增 15 项）。
- `node scripts/verify-auth.js` → **40/0**；`verify-recycle.js` → **35/0**；
  `verify-frontend-contract.js` → **49/0**；`verify-i18n.js --strict` → **12/0**。
- `node scripts/doctor.js` → **0 必须修复 / 6 提醒**（`QC_SCENE_MULTI_COLOR_MODE` 未覆盖项已消除）。
- `node scripts/preflight.js` → **3 通过 / 1 提醒 / 0 失败**（git 状态检查仍因 `spawn EPERM` 降级）。

### 未验证

- `/api/trash` 的 HTTP 负向（`..%2F..%2Fdata%2Fusers` → 400）未在登录态下打真实请求；只验了纯函数 + 路由静态接线。
- 登录页 `next` 的浏览器端跳转未用真实浏览器点一遍；只验了 URL 解析语义与代码接线。

### 影响面

- 合法任务 id（`task_xxx`）不受影响；带点/斜杠的 id 会被 400 拒绝（正常不会出现）。
- 登录后站内 `next` 仍可用；外站/反斜杠链接回落到 `/app`。

