# 方案：接缝一致性（镜头级色彩连续性）—— 待确认后实施

> 状态：**批次 1 + 批次 2 已实施并提交**（`32b3d69`/`7a61c1a` 质检项；`089c589`/`7856a3e` 自动校色）。
> 唯一遗留：`server.js` 需加两行把任务级 `colorMatch` 透传进来（该文件归另一个会话，diff 见 changelog）。
> 确认后再动手；本文同时给另一个会话（React 实施）留并行协议。
> 依据：`seam-experiment.md`（3 对真实接缝实验，2026-10-27）
> 实验结论：换转场曲线收益不稳定（−1.07 / −1.97 / **+0.54**），校色匹配收益大且稳定
> （镜头级 ΔE76 43/48/25 → **1.6/1.4/3.6**）。

---

## 1. 目标与非目标

**目标**：让「拼接自然」从靠感觉变成靠数字——
1. 能测出「相邻镜头整体色调不连贯」（现在的 `checkSeam` 只看接缝中心帧，测不到，实验 pair3 已证实盲区）。
2. 能在拼接时自动把相邻镜头拉到同一色调参考，且**不额外增加一次编码**。

**非目标**：
- 不逆向剪映转场曲线（实验证明不值得）。
- 不改生成/质检的判定语义（不新增"一票否决"）。
- 不动 `server.js`、`web/`、`public/`（另一个会话的战场）。

---

## 2. 两个可独立交付的改动

### 改动 A｜新增质检项 `colorContinuity`（只读，零行为变更）

**测法**（自足，不需要原始片段路径）：
- 用最终成片 + 片段时长，按 `checkSeam` 同款公式算缝位置（含 `fadeDuration` 前移）。
- 每道缝取两帧：`seam − 0.6s`（前镜头）与 `seam + 0.6s`（后镜头）——**刻意避开转场混合区**，
  这样测的是"两个镜头本身的色调"，而不是"过渡瞬间"。
- 算 YUV 均值 → **ΔE76**（复用现成的 `_deltaE76FromYuv`）。

**阈值**（实验数据定起点）：

| 镜头级 ΔE76 | 判定 |
|---|---|
| ≤ 15 | 通过 |
| 15 – 40 | **告警**（`level: 'warn'`，不判 fail） |
| > 40 | 判 fail（实验里"明显不连贯"组是 43–48） |

**为什么中间要留 warn 档**：风景/天文题材里「冷色星空 → 暖色日出」是刻意的对比，
一刀判 fail 会逼着把有表现力的成片改坏。**这条需要你拍板**（见 §6 决策 3）。

**三态语义**（遵守 AGENTS §4.1）：
- 未执行/测不到 → `passed:false`（notRun 语义），不放行；
- 唯一合法跳过：只有 1 个片段（与 `checkSeam` 一致）；
- 阈值命中但属 warn 档 → `passed:true` + `level:'warn'` + 写入 `reasons`。

**落点**：
- `src/qualityChecker.js`：`QC_ITEMS` 追加一项 + 新增 `checkColorContinuity()`（**只做增量 edit，不整文件重写**）。
- `src/pipeline.js`：`checkFinal` 的调用点已在用 `_finalQcOptions(task)`，把 `clipDurations`/`fadeDuration` 一并透传即可（与 seam 共用）。
- `config.js`：QC 段新增 `colorDe76Warn` / `colorDe76Max`（沿用已有 `seamNum()` 帮助函数）。
- `.env.example`：新增 `QC_COLOR_DE76_WARN=15`、`QC_COLOR_DE76_MAX=40`。
- `scripts/verify-color-continuity.js`（新）：正/负/跳过三态断言 + 真实接缝用例。

### 改动 B｜拼接时自动校色（默认关，复用转场的重编码）

**在哪做**：只改 `src/processors/transitionMixer.js` 的 `concatWithTransitions()`。
理由：**只有这一条路径本来就要重编码**，把 `lutrgb` 塞进同一条 filter graph，**零额外编码**；
而 `-c copy` 直拼路径若要校色就必须多一次全片编码，成本不值 → **转场关闭时不校色**（写进文档）。

**怎么算**：
1. 对每个片段抽 5 帧（3 秒片段内均分）；
2. 算逐通道均值/方差（实验脚本 `rgbStats()` 可直接搬）；
3. 目标参考段（见 §6 决策 2）→ `gain = sd_ref/sd_i`、`offset = mean_ref − gain×mean_i`；
4. 生成 `lutrgb=r='val*g+o':g=...:b=...` 接在该输入前；
5. 单段增益限幅（默认 ±15%），超出则只告警不强行拉。

**配置**：
```
COLOR_MATCH_ENABLED=false        # 默认关，需显式开启
COLOR_MATCH_REFERENCE=first      # first | median | chain
COLOR_MATCH_MAX_GAIN=0.15        # 单通道最大增益偏离
```
任务级参数 `colorMatch` 也接（与 `transition` 同款写法），便于单任务覆盖、便于复现。

**防漂移**：默认 `reference=first`（全片对齐首段），不用链式；链式会随段数累积偏色。

**校色状态机（必须可观测，禁止静默）**

校色结果写入任务步骤与 `qcDetails`，状态只有四种，逐一给 reason 与语义：

| state | 触发条件 | reason（写进 `qcDetails` 与任务步骤） | §4.1 语义 |
|---|---|---|---|
| `applied` | 已开启且执行成功 | `已校色：参考=首段，限幅 ±15%` | 正常参与判定 |
| `disabled` | 未开启（**默认**，用户没要求） | `校色未开启（默认关，需任务显式开启）` | **合法跳过**（业务不适用），不拉低通过率 |
| `skipped` | **已请求但没做成**（典型：转场关闭 → `-c copy` 路径不校色） | `校色已请求但未执行：转场关闭（直拼路径不校色）` | **未执行 ≠ 通过**：写入 `notRunItems`，整体 QC **不通过** |
| `failed` | 执行报错（滤镜失败/抽帧失败等） | `校色执行失败：<err>，已按原片拼接` | **未执行 ≠ 通过**：写入 `notRunItems`，整体 QC **不通过** |

关键差别：`disabled` 是「用户明确没要」，属合法跳过；`skipped` / `failed` 是「要了但没做成」，
必须落到 `notRunItems`，让 `qcDetails` 里能直接看到「校色未执行」，**绝不冒充 passed**。

同时 `colorContinuity` 质检项的 `details` 里固定带 `colorMatchState` 与 `colorMatchReason`，
即使状态是 `disabled` 也要写出来（用户看得到"这次为什么没校色"），只是不判失败。

并且：上述 reason 原文必须**同时出现在该质检项自身的 `reason` 字符串里**（不只在 `details` 深处），
这样用户/前端在结论行就能读到「校色未执行」，不必展开明细。

**早失败优于晚判 fail**：`colorMatch=true` 与 `transition.enabled=false` 是互斥组合。
在 `src/taskManager.js` 创建任务时就校验并拒绝（`校色需要开启转场`），
不要等出片后靠 QC 判不通过——那既浪费时间又让用户困惑。
**校验放在 `taskManager`，不放 `server.js`**（后者归对方会话，见 §5）。


---

## 3. 实施顺序（三批，每批可独立回滚）

| 批次 | 内容 | 风险 | 建议时点 |
|---|---|---|---|
| **1** | 改动 A（只读质检 + 新脚本 + 配置键） | 低（不改产物） | 先合，与 React 并行无冲突 |
| **2** | 改动 B（校色，默认关） | 中（改拼接滤镜图） | 等 React 侧合并窗口，避免同改 `config.js` |
| **3** | 前端展示 `colorContinuity` 结果（任务卡角标） | 低 | 等 React 侧页面骨架就绪再谈 |

---

## 4. 验收标准（可测，别写"应该可以"）

**改动 A**
```powershell
cd app
$env:DATABASE_TYPE='json'; node scripts/verify-color-continuity.js
```
- ≥ 15 项断言，含负向：构造一段**故意偏色**的接缝 → 必须判 fail（或 warn）。
- 用实验的三对真实片段回放：ΔE76 应落在 25–50（判 fail/warn），而 `checkSeam` 仍可 pass —— 证明盲区被抓到。

**改动 B**
- 开关关闭：产物与改动前**时长/流/质检结论一致**（允许编码字节差异）。
- 开关开启（转场同时开）：用三对片段重测，接缝与镜头级 ΔE76 均 **≤5**（实验 D2 为 0.34/0.69/0.28、镜头级 1.6/1.4/3.6）。
- 编码耗时增量 **≤5%**（应与现在同一次重编码，只多一个 `lutrgb`）。
- **三态断言（本节为硬性验收，缺一不可）**：
  1. `applied`：`qcDetails.colorMatchState === 'applied'`，且 `notRunItems` 不含该校色项；
  2. `disabled`（默认）：`state` 必须是 `disabled`、reason 写明「未开启（默认关）」，
     **不得**进入 `notRunItems`、**不得**拉低整体通过率（合法跳过，AGENTS §4.1）；
  3. `skipped`（负向）：`COLOR_MATCH_ENABLED=true` + 转场关闭 → 必须
     `qcDetails.colorMatchState === 'skipped'`、reason 含「转场关闭」、
     且该校色项进入 `notRunItems` → **整体 QC 不通过**（证明"没做"没被当通过）；
  4. `failed`（负向）：人为让 `lutrgb` 失败（如非法参数）→ `state=failed`、reason 含错误摘要、
     进入 `notRunItems`、整体不通过，且**拼接产物仍然产出**（不阻断出片）。

**回归**（`verify-all --fast` 在本机会 EPERM，逐脚本跑）：
```
check-inline-js / verify-frontend-static / verify-editor-dom / test-editor-logic /
verify-skill-prompt / verify-transition-ui / verify-pages / verify-seam-qc / verify-transitions
```
全部退出码 0；新增脚本退出码 0。

---

## 5. 与另一个会话（React 实施）的并行协议

### 文件所有权（互不越界）

| 我（本次方案） | 对方（React 迁移） |
|---|---|
| `src/qualityChecker.js`（增量）、`src/pipeline.js`（仅新增透传） | `server.js`、`web/**`、`public/**` |
| `src/processors/transitionMixer.js` | `scripts/_check-spa-auth.mjs`、`scripts/_smoke-app-route.js` |
| `config.js`（**仅 QC/COLOR_MATCH 段追加**）、`.env.example` | 构建配置（vite/tailwind/package.json 前端依赖） |
| `scripts/verify-color-continuity.js`（新） | 前端断言脚本重写（`check-inline-js` / `verify-frontend-static` / `verify-editor-dom` / `test-editor-logic` / `verify-pages` 依赖现有 HTML） |

### 三条硬约定

1. **`config.js` 是唯一重叠文件**：我先不动它；批次 1 开工前由我提出一次性 diff（只加 3 个键），
   对方确认没冲突后我再合并。若对方同时要改，**以对方先合为准**，我 rebase 后重加。
2. **提交前缀分开**：我用 `feat(qc):` / `feat(concat):` / `test(color):`；
   对方用 `feat(web):` / `refactor(server):`。一次提交只做一件事（AGENTS §8）。
3. **`pipeline.js` 我只加透传，不改既有分支**；若对方要改 pipeline 的静态下发相关代码（应该不涉及），先打招呼。

### 合并顺序

```
现在            → 我：只出方案（本文），不动代码
对方 React 起步  → 对方改 server.js / web/，可随时合
批次 1（我）     → 只读质检，无冲突，可在对方进行中合并
批次 2（我）     → 等对方一个合并窗口；双方各自 CI（逐脚本）通过后再合
```

---

## 6. 决策（2026-10-27 已拍板，锁定）

| # | 决策 | 结论 | 理由（用户原话要点） |
|---|---|---|---|
| 1 | 质检强度 | **(b) 三档：≤15 pass / 15–40 warn / >40 fail** | 冷暖对比（日落→蓝调）是刻意创作，一刀切 fail 会误杀 |
| 2 | 校色参考段 | **(a) 首段（first）** | 链式会累积漂移；中位段要多扫一遍 |
| 3 | 校色默认开关 | **(a) 默认关**（`COLOR_MATCH_ENABLED=false`） | 它改变画面观感，用户必须知情；默默改色比不改更糟 |
| 4 | `QC_VERSION` | **升到 3** | 新增必检项就该如实反映；`TRUSTED_FROM=2` 保证旧任务不被误标 |

### 由此确定的行为细则

- 三档实现：`level: 'pass' | 'warn' | 'fail'`；**只有 fail 计入 `failedItems`**，warn 计入 `details` 与 reason，不拉低整体通过率。
- 参考段固定首段，不做链式；`COLOR_MATCH_REFERENCE` 仍保留 `median` 作为后置选项，但默认不实现。
- 校色默认关：任务里未显式传 `colorMatch: true` 时**完全不执行**，也不产生任何临时文件。
- `QC_VERSION = 3`；旧任务 v2 仍满足 `v >= TRUSTED_FROM(2)`，标注不变。

### 待转给对方会话的 `config.js` 一次性 diff（只加键，不改既有值）

> 约定：由对方确认无冲突后我再合并；若对方同时在改 `config.js`，以对方先合为准，我 rebase 后重加。

```diff
@@ config.js · QC 段（seamNum 已在第 116 行，直接复用）
     seamMaxSeams: Math.max(1, parseInt(env('QC_SEAM_MAX_SEAMS', '8'), 10) || 8),
+    // 镜头级色彩连续性（checkColorContinuity）：测相邻镜头整体色调差，不是接缝瞬间
+    // 阈值来自 2026-10-27 实验（合格组 ΔE76 1.4~3.6，不合格组 25~48）
+    colorDe76Warn: seamNum('QC_COLOR_DE76_WARN', 15, 0, 200),
+    colorDe76Max: seamNum('QC_COLOR_DE76_MAX', 40, 0, 200),
+
+    // 拼接时自动校色（默认关）：仅转场开启（重编码）路径生效
+    colorMatchEnabled: /^(1|true|yes)$/i.test(String(env('COLOR_MATCH_ENABLED', 'false')).trim()),
+    colorMatchMaxGain: seamNum('COLOR_MATCH_MAX_GAIN', 0.15, 0, 1),
```

`.env.example` 同步三行（键名与默认值一致）：

```
QC_COLOR_DE76_WARN=15
QC_COLOR_DE76_MAX=40
COLOR_MATCH_ENABLED=false
```


---

## 7. 风险与回滚

| 风险 | 处置 |
|---|---|
| 校色把风景的冷暖对比抹平 | 默认关 + 限幅 ±15% + QC 只 warn 不 fail |
| 长片累积偏色 | 参考段固定首段，不链式 |
| `transitionMixer` 滤镜图变复杂导致失败 | 校色作为独立 filter 分支；失败时**不阻断拼接**，但必须落到 `state=failed` → 写入 `notRunItems` + `qcDetails.reason`（「校色执行失败：…，已按原片拼接」），整体 QC 判不通过。**绝不允许"跳过即通过"**（AGENTS §4.1） |
| 校色被静默跳过 | 三种非 applied 状态（`disabled` / `skipped` / `failed`）都必须在 `qcDetails` 里带 `colorMatchState` + `colorMatchReason`；验收脚本含负向用例：`colorMatch:true` 但转场关闭 → 必须出 `notRunItems` 且整体不通过 |
| `qualityChecker.js` 是热点文件 | 只做增量 `edit`，禁止整文件 `write`（AGENTS §4.5） |
| 与 React 迁移互相覆盖 | §5 的文件所有权 + 提交前缀 + 合并顺序 |
| 实验只有 3 对片段 | 批次 1 完成后先扩样到 10+ 道真实缝再定阈值，不拿 3 对当定论 |

---

## 8. 明确不做（避免再被问）

- 不逆向剪映转场资源包（本机 `Cache/effect` 10842 文件无任何 `transition` 包；引擎无内建转场 shader）。
- 不做 ducking / 不做响度目标值改动（已在 `changelog.md` 决议：ducking 不做，响度 −16 待真机 A/B）。
- 不动前端视觉（`bgm-editor.html` 已完成，且属另一个会话的迁移范围）。
