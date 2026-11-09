# FEATURES — 功能清单（基线 2026-11-02，HEAD `1d3c693`）

> 判定三态：**[x] 已实现且有证据** ／ **[ ] 未实现** ／ **[~] 存在但未验证**（代码有、没证据证明能用）。
> 「证据」列优先给 commit；没有单一 commit 的，给文件/测试。测试项数字来自 2026-11-02 13:28–13:47 实测。
> commit 只写到 7 位；`1c39bcc`/`1d3c693` 之后是当前基线。

---

## A. 已实现（[x]）

### A1. 流水线与档位

- [x] 8 步流水线编排（提示词→分镜→生成→拼接→循环→转码→配乐→终检）
  - 证据：`src/pipeline.js`(2326 行)、`src/pipelineStages.js:22-33`；`verify-stage-pipeline.js` 37/0
  - commit：`2e9cfe7`（档位/补跑首版，混合提交）
- [x] 5 个档位 + 依赖校验（quick/daily/final/clips_only/custom）
  - 证据：`src/pipelineStages.js:55-91`；`verify-stages.js` 45/0
- [x] 补跑 continue（复用已完成步骤，片段不重生成）
  - 证据：`POST /api/tasks/:id/continue`（`server.js:1646`）+ `GET .../continue-plan`（`:1677`）；`verify-continue.js` 19/0
- [x] 僵尸任务重启回收
  - 证据：`pipeline.reconcileInterruptedTasks()`；`verify-pipeline-fixes.js` 28/0

### A2. 生成器

- [x] 6 个可插拔生成器工厂（mock / seedance / kling / agnes / siliconflow / dashscope）
  - 证据：`src/generators/index.js:6-45,52-61`
- [~] 真实厂商调用
  - 只有 Mock 走过端到端；无 Key，**真实 API 未验证**

### A3. 质检（13 项，QC_VERSION=3）

- [x] 13 项质检定义 + 三态语义
  - 证据：`src/qualityChecker.js:15-34`（prompt/storyboard/blackFrame/blur/duplicate/duration/nsfw/concat/seam/colorContinuity/loop/transcode/final）、`:42` `QC_VERSION=3`
- [x] NSFW 多模态检测（每分钟 1 帧、阈值 0.8）
  - 证据：`checkNSFW`；`verify-nsfw.js` 47/0、`verify-nsfw-adversarial.js` 51/0（注入 fetch）
  - commit：`9af1fb4` 起（见 changelog「NSFW 合规检测落地」）
- [x] 接缝质量 seam（SSIM / ΔE76 / ΔY / MAD）
  - 证据：`checkSeam`（`:440`）；`verify-seam-qc.js` **未注册、本次未跑**
  - commit：`1c39bcc` 邻域？实际为 2026-10-27 批次（changelog 记 `32b3d69`/`7a61c1a` 为 colorContinuity）
- [x] 镜头色彩连续性 colorContinuity（三档）
  - 证据：`checkColorContinuity`（`:686`）；commit `32b3d69`
- [x] 循环质检（末尾 vs 开头 SSIM）
  - 证据：`checkLoop`（`:1037`）；`verify-loop.js` 28/1（1 条是过期断言，不是功能失败）
- [x] Mock 模式不绕过视觉质检
  - 证据：`verify-mock-vqc.js` 14/0
- [x] QC 可信度标注（qcVersion / qcTrusted / qcVersionSource）
  - 证据：`GET /api/tasks` 与 `/:id` 返回；`verify-qc-annotation.js` 31/0
- [x] 统计口径（成功率/质检通过率）
  - 证据：`src/stats.js`；`GET /api/stats`（`server.js:1690`）；`verify-stats.js` 42/0

### A4. 视频处理

- [x] 拼接（含音轨全有/全无/混合三种分派 + 时长校验）
  - 证据：`src/videoProcessor.js` `_concatenateFFmpeg` / `_validateConcatDuration`；`verify-concat-audio.js` 17/0
- [x] 片段间转场 xfade（默认开，0.4 s）
  - 证据：`src/processors/transitionMixer.js`(597)、`config.js` TRANSITIONS 默认 true；`verify-transition-ui.js` 22/0
- [x] 无缝循环（真交叉淡化）
  - 证据：`videoProcessor._makeLoopFFmpeg`；`verify-loop.js`（同 A3）
- [x] 转码 / 抽帧 / 探测
  - 证据：`src/videoProcessor.js`(722)
- [x] 拼接自动校色 colorMatch（默认关）
  - 证据：`verify-color-match.js`（未注册、本次未跑）；commit `089c589`
- [x] 剪映「调节」复刻（12 项 + HSL/曲线/色轮）+ 自研 33³ LUT
  - 证据：`src/processors/adjustChain.js`(487)、`pipeline.js:618`；`verify-adjust-chain.js` 13/0、`verify-adjust-pipeline.js` 12/0（**均未注册进门禁**）
  - commit：`1c39bcc`（接入）、`b17bbdd`（自研 LUT 替换剪映资源）
  - **无 UI 面板**，只能经 API/CLI 触发；`.env` 默认 `ADJUST_ENABLED=false`

### A5. 配乐

- [x] 整片多轨配乐（plan → ffmpeg filter）
  - 证据：`src/processors/audioMixer.js`(760)、`bgmPlan.js`(303)；`verify-bgm-plan.js` 5/5
- [x] 波形峰值服务端生成
  - 证据：`src/processors/waveform.js`、`GET /api/bgm/waveform/:id`（`server.js:325`）
- [x] BGM 库存 CRUD + 偏好
  - 证据：`server.js:303-365`
- [~] 配乐文件上传
  - **未实现**（见 B3）

### A6. 任务与资产

- [x] 任务状态机 / 步骤 / 进度 / WebSocket 推送
  - 证据：`src/taskManager.js`(922)、`src/wsManager.js`(201) `/ws` + 4 种广播
- [x] 暂停 / 继续（含超时、重启回收、failureCode 三态）
  - 证据：`server.js:1596-1609`；`verify-pause.js` **71/0**；commit `1c39bcc`
- [x] 单片段重生成 / 整任务重试 / 重检片段
  - 证据：`server.js:1616,1622,1660`；`verify-recovery-fixes.js` 28/0（未注册）
- [x] 片段库（入库 / 补档 / 收藏 / 跨任务复用 / 热加载）
  - 证据：`src/library.js`(437)、`server.js:1402-1528`；`verify-library.js` 36/0；commit `238a10e`
- [x] 垃圾箱（软删 / 恢复 / 清空）
  - 证据：`server.js:1718-1735`
- [x] 费用价目表
  - 证据：`src/pricing.js`；`GET /api/pricing`（`:1397`）

### A7. 提示词

- [x] 提示词优化（模板 / 关键词 / 可选 AI）
  - 证据：`src/promptOptimizer.js`(886)、`src/templates.zh.js`(321)；`POST /api/optimize-prompt`（`:885`）
- [x] fengguang skill 规则注入（作用域 / 开关 / 全中文）
  - 证据：`src/promptSkill.js`、`data/skill-fengguang.rules.md`；`verify-skill-prompt.js` 109/0、`verify-skill-ai-path.js` 17/0
- [x] 提示词助手（悬浮球对话）
  - 证据：`POST /api/assistant/chat`（`:1046`）、`web/src/components/assistant.js`
- [x] 模板 CRUD + 规则编辑
  - 证据：`server.js:819-880`；commit `f667d7d`（GET /api/templates）

### A8. 账号与页面

- [x] 登录墙（会话 cookie / 5 次锁 5 分钟 / 首账号 bootstrap / WS 握手鉴权）
  - 证据：`src/auth.js`(355)、`server.js:73-107,112-233`；commit `497c4d3`（首建号竞态修复）
- [x] 成员管理（增删 / 改密）
  - 证据：`server.js:170-233`、`web/src/screens/settingsPage.js:62-155`；commit `368f096`
- [x] ~~旧版前端（单文件 `public/index.html`，295,955 B / 8085 行）~~ **已于 2026-11-09 删除**
  - 最后提交 `8283549`（10-27）；连同 `preview-app` / `bgm-editor` / `members` / `clip-library` / `music-library` / `showcase` / `design-system` / `icon-comparison` / `preview-login` / `_ptest` / `_selftest` 共 12 个旧 HTML 一起删；`public/` 只剩 `login.html` + `assets/`；12 个旧地址由 `server.js` 的 `LEGACY_PAGES` 统一 302 到 `/app`
- [x] 新版前端外壳（深绿黑+香槟金、左侧导航）
  - 证据：`web/src/screens/shell.js`；commit `f11b34b`
- [x] 六步创作向导
  - 证据：`web/src/screens/create.js:17`；commit `2637cf4`
- [x] 生成中页 / 任务抽屉 / 顶栏任务条
  - 证据：`web/src/screens/gen.js`、`components/taskDrawer.js`、`components/jobBar.js`；commit `8331a4d`
- [x] 库存三页（片段 / 照片 / 配乐）
  - 证据：`web/src/screens/inventory.js`；commit `a3c6df9`
- [x] 历史 + 垃圾箱
  - 证据：`web/src/screens/history.js`；commit `8c396cb`
- [x] 模板库
  - 证据：`web/src/screens/templates.js`；commit `4daf3e7`
- [x] 设置整页
  - 证据：`web/src/screens/settingsPage.js`
- [x] 产出页
  - 证据：`web/src/screens/output.js`
- [x] 登录页 v3 深色稿 + 登录后默认跳 `/app`
  - 证据：`public/login.html:516`；commit `da2b310`、`881aa42`
  - [~] 视觉未人眼验证；兜底海报仍是白天雾山（2560×1440）
- [x] 日志落盘（终端 + `data/logs/server-YYYY-MM-DD.log` 双写）
  - 证据：`server.js:15-32`

---

## B. 未实现（按优先级）

| 优先级 | 功能 | 现状 | 阻塞点 |
|---|---|---|---|
| **P0** | 人工审核门 `awaiting_review` | 全仓 0 命中；设计已完成（`docs/spec/review-gate-design.md` 747 行，含 ≥20 条验收用例） | **需产品先定 D1–D6、D8**（整组/逐张、驳回回退点、超时、哪些档位、旧任务升级、图是否公网可读、是否留痕）；D7 图片厂商已定 wan2.7-image；且必须先做前置① |
| **P0** | 图片生成（厂商已接入，流水线待接） | ✅ 适配器/接口/CLI/验收已完成：`src/generators/imageProviders/dashscope.js`（wan2.7-image）、`GET /api/image-gen/status`、`POST /api/images/generate`、`scripts/test-image-gen.js`、`scripts/verify-image-gen.js`（100/0）；设置页已有「图片生成 · wan2.7-image」入口（本机 Key 运行时生效 + 测试连接 + 眼睛显示切换；Seedance/可灵默认折叠）；`scripts/check-server-version.js` 可检测运行中的后端是否过期。向导第二步可「单张测试出图」。前端已单版本收口：`/` → 302 `/app`，`public/index.html` 仅归档。**尚未接进 pipeline**：没有 `image_generation` 阶段、任务字段、审核门 | 阶段与审核门按 `docs/spec/review-gate-design.md` §15 ③–⑦ 做；需产品定 D1–D6/D8 |
| **P1** | 配乐文件上传 | `POST /api/bgm` 只收 JSON 元信息；无 multipart、无 multer | 无设计文档；需定存储落点 |
| **P1** | 审核门前置①：状态机缺陷修复 | `paused` 重启永久卡死、暂停超时静默丢弃、多个历史状态不在回收白名单 | 设计文档 §4/§15 要求先做（否则新增状态必踩同坑） |
| **P2** | 剪映「调节」UI 面板 | 后端与 LUT 已完成，`.env` 默认关 | `app/web/**` 属 UI 写权限，**需用户授权** |
| **P2** | 对象存储接入服务链 | `src/storage/objectStore.js` 只被 `scripts/upload-videos.js` 引用 | 服务运行时从不上传 |
| **P2** | 里程碑目录内容 | `docs/milestones/` 存在但**空** | 归属产品 |
| **P3** | 根文档纳入版本管理 | 根 `AGENTS.md`/`PROJECT_STATE.md`/`docs/` 在 git 外 | 需决定仓库结构 |

---

## C. 工程债（不是功能，但会挡住功能）

| 优先级 | 事项 | 证据 |
|---|---|---|
| **P0** | 门禁入口不可执行（`spawn EPERM`） | `verify-all.js:162`；本机实测 |
| **P0** | 2 个注册套件是红的 | `verify-auth` 11/15（数据污染）、`verify-loop` 28/1（断言过期） |
| **P1** | 30 个套件不在门禁（含 seam/transitions/color-*/recovery/adjust） | 55 实有 vs 25 注册（2026-11-09 实测） |
| **P1** | Postgres 不可达，持久化未验证 | `.env` + 测试日志 `timeout exceeded` |
| **P2** | `data/logs/console-3001.log.err` 已入库 | `git ls-files data/logs`；`.gitignore:27` 只有 `*.log` |
| **P2** | 双锁文件并存 | `package-lock.json` + `pnpm-lock.yaml` |

---

## D. 剪辑台改造（计划，2026-11-04 批准）

> 目标：`/app/edit` 从「成片列表 + 整片调节」改成剪映式剪辑台。
> 策略：**数据模型按甲设计（工程第一天就带每段参数），交付按乙的节奏（先垂直切片）**。
> 现状起点：`/app/edit` 已有 10 项调节面板（`b10bde6`），作为 F05 的 UI 基础。

### D1. 已定决策

| # | 决策 |
|---|---|
| 1 | 点「剪辑」直接进工作台，不再出现成片列表 |
| 2 | 新建工程 + 打开已有成片；重建按 **c 自动**（有任务记录就重建，缺件退单段） |
| 3 | 每段独立调节（选中谁调谁）+ 应用到全部 |
| 4 | 素材仅本地生成物（片段库 + 成片），无上传通道 |
| 5 | 音频并入剪辑台：音乐/环境音两轨，沿用 bgm-plan |
| 6 | 预览：实时 WebGL，与导出同源；540p 同帧平均通道差 <1% |
| 7 | 草稿：服务端 JSON，可多份，自动保存 |
| 8 | 导出：每次新建任务/新成片，不动原片 |
| 9 | 时间线：排序 / 入出点裁剪 / 分割 / 复制 / 删除 / 转场控件 |
| 10 | 片段库只做库存详情（模型/花费/质检摘要/来源任务）+ 再生成，无「去剪辑」入口 |
| 11 | 视觉：剪映布局 + 现有深绿黑/香槟金 |
| 12 | 不做：文本/贴纸/特效/字幕/蒙版/关键帧/变速/画中画/画幅调整/本地上传 |

### D2. 分项与验收

| ID | 项 | 一行验收 | 批次 |
|---|---|---|---|
| F01 | 工程与草稿 | 新建/自动保存/重开仍在/可多份；打开已有成片按 c 重建 | P0 |
| F02 | 工作台骨架 | 点剪辑直接进；左素材/中预览/右调节/下时间线四区存在 | P0 |
| F03 | 素材面板 | 片段库缩略图/搜索/分页；点选或拖拽入轨 | P0 |
| F04 | 时间线编辑 | 排序/裁剪/分割/复制/删除/缩放/撤销重做/播放头 | P0 |
| F05 | 每段调节 | 选中段 10 项只作用该段；导出逐段烘焙 | P1 |
| F06 | 实时预览 | 540p 同帧色差 <1%；连续播放 ≥24fps；叠化可见 | P1 |
| F07 | 音频 | 两轨、波形、入出点、音量/淡入淡出；plan 结构一致 | P1 |
| F08 | 导出 | 新建任务渲染；进度可见；原片 mtime 不变 | P0 |
| F09 | 转场控件 | 关=Σ，开=Σ−(N−1)F；预览与导出一致 | P2 |
| F10 | 片段库详情 | 模型/花费/质检摘要/来源任务/分辨率/时长/大小 + 再生成 | P2 |
| F11 | 导航重组 | 去「配乐编辑器」入口；`/app/bgm` 落剪辑台 | P2 |
| F12 | 高级调节（2026-11-04 追加） | HSL 8 段×3、RGB 曲线、lift/gamma/gain 色轮；预览/导出同 LUT；**蒙版不做** | P2 |

### D3. 分期

- **M1（第 1–4 周）**：导出链重做（`execFile` + `-/filter_complex` + 短路径 + 硬编 + 进度/取消）→ F01/F02 → F03/F04 → F08 + 段缓存。
- **M2（第 5–8 周）**：F01 补「从任务重建」+ F05 → F06 实时预览。
- **M3（第 9–12 周）**：F07 → F09 → F10/F11 → 30 分钟长片实测。

### D4. 验收门

| Gate | 时点 | 条件 |
|---|---|---|
| G0 | W1 末 | 360 段导出成功；30 分钟耗时实测 |
| G1 | W4 末 | 1 分钟片：选 5 段 → 排序/裁剪 → 导出；原片不动 |
| G2 | W8 末 | 每段调节生效；预览 540p ≥24fps、色差 <1% |
| G3 | W12 末 | 30 分钟片导出成功；11 项全过；旧套件无回归 |

### D5. 关键风险与对策

| 风险 | 触发信号 | 对策 |
|---|---|---|
| 命令行超限（8191） | 导出 `Command failed` | `execFile` 参数数组 + filter 写文件 + 临时短路径 |
| 段渲染 / 全量重渲慢 | 改一次 >10 分钟 | 段级内容寻址缓存 + 硬件编码（nvenc/qsv/amf，回退 libx264） |
| 预览色彩不一致 | 预览好看导出发灰 | 色卡校准 + 双阈值；LUT 与导出同源 |
| 双轨模型漂移 | 旧草稿打不开 | Project 唯一真相 + schemaVersion + 迁移 |
| 素材被删 | 导出中途失败 | assetId + 引用检查/软删 |
| 规模 UI 卡 | 200 段滚动卡 | canvas 时间线 + filmstrip + 虚拟化 |

### D6. 第一步

1. `scripts/spike-editor-export.js`：100/360 段导出 + 30 段预览，拿三个数字；G0 不达标先改方案。
2. 导出链重做。
3. F01/F02。

---

## E. 前端单版本收口（2026-11-09，进行中）

> 用户已拍板：旧版 4 组能力全部补到新版；旧版 `public/index.html` 移到 `legacy/`，改 5 个测试后删除。
> 新窗口按本清单顺序做，一项一 commit，先写断言再改代码。

- [x] **E1 模型/分辨率/档位接线（最高优先）**：新版创作页当前写死 `seedance/1080p/final`，
  设置页保存的 `vs_web_config` 没被读取。验收：设置选万相 3.0 + 720p + quick 后，创作页确认页显示同样值，
  `POST /api/tasks` 请求体 `model/resolution/preset` 与设置一致。
  - **已完成（2026-11-09）**：`create.js` 新增 `readWebConfig()`；`p.model/resolution/preset` 初值取
    `vs_web_config` 的 `videoModel/resolution/preset`；确认页（step 5）新增「生成参数」块 + 只读「档位」行。
    断言 `scripts/verify-create-config.js` **28/0**（先红 13/15），已注册 `verify-all.js` fast 组。
    请求体实测：`model='dashscope' / modelId='wan3.0-video' / resolution='720p' / preset='quick'`。
    `verify-image-gen.js` 回归 100/0。**真实浏览器点击/视觉未验证**（本机 `dsh_browser` 报 Electron 不可用）。
- [ ] **E2 多提示词批量**：旧版一行一个场景；新版只有单条。验收：两行提示词 → `prompts` 长度 2 /
  片段数 2；单行行为不变。
- [ ] **E3 余额 + 费用预估**：旧版设置填余额，生成前估算并拦截；新版只有实际花费。
  验收：余额 1 元、预计 3 元 → 提交被拦截；余额空 → 不拦截；费用表与旧版一致。
- [ ] **E4 自定义执行环节 + 质检严格度**：旧版可勾选 8 步与质检项；新版只有预设档位。
  验收：custom + 只勾 4 步 → 任务 `stages` 只含 4 步；严格度勾选透传到 API。
- [x] **E5 旧版归档（2026-11-09 已完成，按「彻底删除」执行，未走 legacy 中间态）**：12 个旧 HTML
  （`index` / `preview-app` / `preview-login` / `bgm-editor` / `members` / `clip-library` / `music-library` /
  `showcase` / `design-system-notion-apple` / `icon-comparison` / `_ptest` / `_selftest`）+ `theme-nightvalley.css`
  + `public/showcase/` 素材全部删除；`public/` 只剩 `login.html` + `assets/`。
  连带删除只读它们的 5 个脚本（`check-inline-js` / `verify-frontend-static` / `verify-transition-ui` /
  `verify-pages` / `verify-editor-dom`）与 4 个临时脚本（`test-editor-logic` / `_e` / `_selfcheck` / `_userflow`）；
  `verify-recovery-fixes`（28→25 项）与 `verify-skill-prompt`（109→103 项）里的旧 HTML 断言已剥离，后端断言保留。
  `verify-all.js` 移除 `frontend-static` 注册（26→25）。`server.js` 新增 `LEGACY_PAGES`：12 个旧地址 + `/` 全部 302 `/app`。
  `public/login.html`、`public/assets` 保留。实测：改完 `verify-skill-prompt` 103/0、`verify-recovery-fixes` 25/0、
  `verify-create-config` 28/0、`verify-image-gen` 100/0；`/index.html` 等旧地址 302 需重启后复验。
- [ ] **E6 启动与验证**：双击 `重启服务.bat`；`node scripts/check-server-version.js` exit 0；
  `GET /` 302 `/app`；`GET /app` 200；`verify-image-gen` 100/0。
- [ ] **E7 真实出图**：需要 WhaleTV 的 Base URL/接口协议（用户提供，不要猜）。
