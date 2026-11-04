# PROGRESS — 补建基线完成（2026-11-02）

## 当前状态

**补建基线已完成。** 仓库内已具备：契约（`AGENTS.md`）、功能清单（`FEATURES.md`）、未知项（`KNOWN_UNKNOWNS.md`）、接手流程（`prompts/resume.md`）。

### 交接状态（2026-11-04 18:05）

- **HEAD 见 `git log` 最新提交**；`git status` 仅 `data/logs/console-3001.log.err` 与 `web/verify/`（他人遗留），**无未提交代码**。
- M1/M2 已收口：F01c/F02–F11 全部落地；M2 收口时 14 套件 **299/0**。之后只做 UI 热修，最近通过：shell 25、preview 28、timeline 29、audio 22。
- 最近热修（已提交，**待用户浏览器复验**）：
  1. 预览白屏 TDZ `aea621f`
  2. 预览倒置 / 调参黑屏 / 音频轨选中 `813efcf`
  3. 放大布局 + 分辨率标签 `7046116`；放大溢出遮挡 `f7b9028`
- **2026-11-04 18:05 追加**：用户要求补 **HSL / 曲线 / 色轮**（交给下一窗口），**蒙版明确不做**；已从右侧 tab 删除「蒙版」，`FEATURES.md` 登记 **F12**。HSL/曲线/色轮目前仍是占位 tab，点击提示“后续版本接入”。
- **当前唯一未决**：用户反馈「放大后又卡住」。`f7b9028` 已加 `max-height:100%`、`.ed-stage{overflow:hidden}`、canvas `object-fit:contain`；**尚未拿到用户复验**。
- 若仍卡：优先查 `.ed-stage/.ed-frame` 高度、ResizeObserver 是否循环、播放条是否被 canvas 覆盖（pointer 命中）。
- 运行：`cd app && node server.js` → `http://localhost:3001/app/edit`；当前工程 `proj_mw1umy7m2o3t`（3 段 + Magistar + Pixabay 环境音）。
- **下一窗口顺序**：① 复验放大/全屏；② 做 F12 高级调节（HSL/曲线/色轮），蒙版不做。

## 当前任务（2026-11-04 起）：剪辑台改造

- 需求、11 项、分期、Gate、风险见 `FEATURES.md` **D 节**。
- **第一个动作**：`scripts/spike-editor-export.js`（100/360 段导出 + 30 段预览），拿成功/耗时/fps 三个数字；G0 不达标先改方案，不进 F01。
- 本轮相关文件（按顺序）：`scripts/spike-editor-export.js` → `src/processors/transitionMixer.js`（导出链重做）→ `FEATURES.md` D 节。
- 原「审核门」任务**暂缓，不是取消**；见下方「暂缓」一节。

### Spike 结果（2026-11-04，`scripts/spike-editor-export.js`）

- **现有 transitionMixer：40 段就失败**（`execSync` + 整条 filter 字符串 → 命令行过长），18.9s 后报错。
- **修复路径**（filter 写文件 + `spawn` 参数数组 + cwd 相对短路径）：
  - 100 段全长（260.4s 输出，720p veryfast）：**成功，15.0s**；filter 24KB；命令行 3.6k 字符。
  - 360 段（`-t 3`）：**成功，29.3s**；filter 88KB；命令行 11.9k 字符。
- 注意：mock 是静态色块，耗时偏乐观；360 个输入的启动开销 ≈29s；真实素材要重测。
- 数据卫生：`clips/` 里有 6 个 <1KB 的坏 mock 文件（probe 失败），spike 已跳过。
- 下一步：把 `transitionMixer` 改成同一路径，并补进度、取消、硬件编码；然后进 F01/F02。

### 导出链重构（2026-11-04）

- `transitionMixer` 已改为：**staging 硬链接短名 + filter 写文件 + `spawn` 参数数组**（不再 `execSync` 拼整条字符串）。
- 验收脚本 `scripts/verify-transition-scale.js`：
  - 40 段：**成功 18.3s**（108.4s 输出，5.9× 实时）——旧实现在此规模失败。
  - 360 段：**成功 367.8s**（1213.4s 输出 / 20.2 分钟片，3.3× 实时）。
  - 回归：`verify-transitions.js` 36/0、`verify-transition-ui.js` 22/0。
- 注意：mock 是静态色块，真实素材会明显更慢；1080p 与 30 分钟真实片**还没测**。
- W1 剩余：进度回调、取消、硬件编码探测；之后进 F01/F02。

### 导出链运行时能力（2026-11-04）

- **进度**：`-progress` 写文件，500ms 轮询；`options.onProgress({phase,percent,outTimeSec,speed,encoder})`。
- **取消**：`options.signal`（AbortSignal）；kill 进程、清 staging、删半成品，返回 `{success:false,cancelled:true}`。
- **编码器**：`TRANSITION_ENCODER`（auto 默认）→ 依次试编 nvenc/qsv/amf，失败回退 libx264；结果带 `encoder`。
  - 本机实测探测到 **amf**（AMD），`verify-transitions` 36/0 照常通过。
- 验收：`scripts/verify-transition-runtime.js` **12/0**（进度/取消/预取消/编码器）。
- 规模：360 段 **1080p** 成功，**508.7s**（20.2 分钟片，2.39× 实时）；30 分钟实测进行中。
- **规模上限（2026-11-04 实测）**：单进程全图在 **~540 段以上会失败**——
  - 540 段（带音轨）：AAC 编码器拿不到数据，`Nothing was written`；
  - 692 段（忽略音轨）：H.264 解码器 `Cannot allocate memory`（工作集一度 7.5 GB）。
  - 结论：单次拼接按 **≤360 段** 设计；30 分钟片按 5–10s 片段（180–360 段）刚好在界内，更长必须分块/两阶段。
- 已加两个提速/降险开关：`detail`（复用调用方探测结果，避免逐段 ffprobe）与 `ignoreAudio`（剪辑台导出丢弃源音轨，BGM 单独混）。

### G0 数据（2026-11-04）

- **360 段 / 1080p / 带音轨**：成功 508.7s（1213.4s 片，2.39×）。
- **30 分钟片 / 1080p / 视频-only**：324 段 × 6s，实测 **1814.8s（30.25 分钟）**，导出 **256.8s（4.3 分钟，7.07×）**，完整解码通过。
- **单进程上限**：540 段带音轨失败（AAC 无数据）；692 段视频-only 失败（H.264 解码 `Cannot allocate memory`）。
- 结论：G0 对「≤360 段 + 视频-only + BGM 单独混」成立；真实素材会比 mock 慢，BGM 混音另计一次 pass。
- 导出链剩余：把同一路径接进 pipeline 的编辑器导出（F08），并加 360 段上限保护。

### F01 工程与草稿（后端，2026-11-04）

- `src/projectStore.js`：文件存储 `<PROJECTS_DIR>/<id>.json`（默认 `data/projects/`），tmp+rename 原子写。
- API：`GET/POST /api/projects`、`GET/PUT/DELETE /api/projects/:id`；PUT 带 `revision`（或 `If-Match`），冲突 409。
- 归一化：segments（assetId/in/out/adjust）、audio（music/ambient/opts）、transition（0.1–5s、类型白名单）、name 截断。
- 验收：`scripts/verify-projects.js` **25/0**（CRUD/乐观锁/负向/钳制/路径安全/落盘）。
- 下一项：F02 工作台骨架（全屏三区 + 底部时间线），随后 F03/F04。

### F02 工作台骨架（2026-11-04）

- `/app/edit` 改为**全屏 EditorView**（shell 对 edit 直接返回，不套全局左栏/任务条）。
- 布局：顶栏（工程名/保存状态/打开/新建/导出）＋左「素材·音频」＋中预览＋右「调节」＋下时间线（标尺/视频轨/音频轨/播放头）。
- 工程：`?project=` → 上次工程 → 自动新建；改名 700ms 防抖保存（revision），支持打开/新建弹层。
- 验收：`scripts/verify-editor-shell.js` **22/0**（静态标记 + 临时服务资源/接口）。
- **未验证**：视觉与交互——`dsh_browser` 报 Electron 不可用；headless Chrome 被沙箱拒绝（mojo 拒绝访问）。
- 下一项：F03 素材面板（片段库精选入轨）。

### F03 素材面板（2026-11-04）

- 左栏「素材」tab 读 `/api/library`：搜索（提示词/模型/分辨率）、两列卡片、时长/分辨率/模型。
- 点击卡片或拖拽到视频轨即入轨；按真实入出点算片段宽度与位置；时间线缩放 8–80 px/s。
- 入轨写回工程 `segments`（PUT + revision），失败提示；段数/总时长实时更新。
- 验收：`scripts/verify-editor-media.js` **21/0**；`verify-editor-shell.js` **22/0**（回归）。
- **未验证**：视觉与拖拽手感（浏览器不可用）。
- 下一项：F04 时间线编辑（排序/裁剪/分割/删除/撤销重做）。

### F04 时间线编辑（2026-11-04）

- **排序**：片段内部拖拽，按落点中点插入；**裁剪**：选中片段左右手柄拖拽改入出点（受素材时长上限、最小 0.2s）；**分割**：播放头在段内按播放头、否则中点；**删除**选中段。
- **撤销/重做**：50 步栈，覆盖入轨/排序/裁剪/分割/删除。
- 标尺/轨道点击定位播放头；工具栏按钮带禁用态；所有编辑 400ms 防抖保存（revision 冲突提示）。
- 验收：`verify-editor-timeline.js` **28/0**；F03 **21/0**、F02 **22/0** 回归。
- **未验证**：视觉与拖拽/裁剪手感（浏览器不可用）。
- 下一项：F08 导出（工程 → 渲染任务 → 进度 → 产出），冲 G1。

### F08 导出（2026-11-04）

- `src/editorExporter.js`：工程 → 解析片段库素材（探测一次并复用）→ transitionMixer（`ignoreAudio`）→ `output/<projectId>_edit_<stamp>.mp4`；异步 job + 进度 + 取消。
- API：`POST /api/projects/:id/export`、`GET .../export/:exportId`、`POST .../cancel`；导出记录追加到 `project.exports`（不改 revision）。
- 前端：导出按钮显示百分比；完成后出现「看成片」链接；失败提示。
- 验收：`verify-editor-export.js` **19/0**：12 段（3 个素材、排序 + 每段裁到 5s）→ **55.6s 成片**，时长精确、3 个源文件 mtime/size 不变、导出记录落库。
- **G1 判定：通过（程序化端到端 + 静态接线）**；界面点击/视觉仍未人工验证（浏览器不可用）。
- **已知缺口（M1 收尾）**：① 导出目前是 job，不是任务——产出/历史页看不到；② F01 的「打开已有成片重建」按计划在 M2 W5；③ 预览/音频未接。
- 下一项：把导出记录接进任务体系（产出可见），或按计划进 M2 F05。

### F08 收尾：导出登记为任务（2026-11-04）

- 导出完成后调用 `taskManager.createEditorTask()` 登记一条 `source=editor` 的 completed 任务：
  `model=editor`、`outputPath`、`totalDuration`；步骤标 skipped（transcoding 记 completed）。
- `job.taskId` 与 `project.exports[].taskId` 关联；`/api/tasks/completed` 可见，历史页 model 显示「剪辑台导出」。
- 验收：`verify-editor-export.js` **24/0**（新增：导出登记为任务、产出列表可见、状态/来源/时长、导出记录关联任务）。
- **M1 结论**：G0、G1 均通过（程序化端到端）；UI 视觉/交互仍未人工验证（环境限制已记录）。

### 体验修复（2026-11-04，用户实测反馈）

- **播放头拖动卡顿**：标尺/播放头改 pointer 拖动，拖动期间只改 DOM（`playheadElRef`），松手才 `setState`——不再每帧重渲染整页。
- **素材栏/轨道看不到画面**：新增 `GET /api/library/:id/thumb`，ffmpeg 抽第 0.1s 一帧，缓存 `data/thumbnails/`（按源文件 mtime 失效）；素材卡用 `<img>`，时间线片段用背景图。
- **看完成片要关标签页**：改为页内 `<video>` 预览层，关闭按钮 + Esc + 点遮罩都能关；仍保留「新标签打开」。
- 验收：`verify-editor-ux-fixes.js` **18/0**（含真实缩略图 JPEG 生成/缓存/404）；F02/F03/F04 回归 22/0、21/0、28/0。

### F05 每段调节（2026-11-04）

- 右侧 10 个滑杆绑定**选中片段**（选中谁调谁）：色温/色调/饱和度/亮度/对比度/高光/阴影/白色/黑色/光感，范围 -50..50；实时写工程 + 400ms 防抖保存；「重置本段」、拖动前记撤销点。
- 导出：`transitionMixer` 对每段 `adjust` 生成 **17³ LUT**（与预览共用 `adjustChain` 同一套颜色数学），逐段 `lut3d` 烘焙后再转场；相同参数复用 LUT 文本。
- 验收：`verify-editor-adjust.js` **17/0**（两段调参后 ΔRGB=12.3/19.9/27.2，时长 3.6s；LUT 4913 行）；`verify-transitions` 36/0、`verify-editor-export` 24/0、UX 18/0 回归。
- **未验证**：滑杆手感（浏览器）；实时预览仍属 F06。
- 下一项：F06 实时预览（WebGL + 同一个 LUT）。

### F06 实时预览（2026-11-04）

- 新增 `web/src/preview/engine.js`：WebGL2 3D LUT（17³）+ 双 `<video>` 交替 + 0.4s 叠化；画布 540p 上限；支持 play/pause/seek。
- 新增 `POST /api/adjust/lut`（`src/adjustLut.js`）：用 `adjustChain` 逐点生成 RGBA8 LUT，与导出 ffmpeg `lut3d` 同一套颜色数学；按参数缓存。
- 编辑器预览框接入 canvas：播放/暂停、时间码、点击标尺 seek 全部联动；预览失败显示原因，不阻塞导出。
- 验收：`verify-editor-preview.js` **18/0**：LUT 数值 vs adjustChain **maxΔ=0.435/255**、8-bit 量化上界 **0.196% < 1%**、无调节返回恒等；F02–F05 回归全绿（22/21/28/17/18）。
- **未验证**：真实浏览器 WebGL 同帧像素差与播放/叠化手感（本环境无浏览器）。
- 下一项：F07 音频（音乐/环境音两轨、波形、淡入淡出）。

### F07 音频（2026-11-04）

- 左栏「音频」两轨：**音乐 / 环境音**；选曲、服务端波形（`/api/bgm/waveform/:id`）、音量、淡入/淡出秒数、移除。
- 数据存 `project.audio`（音乐/环境音数组，bgmPlan 片段形状）；时间线显示两条音频块。
- 导出：先出无声母版 → `audioMixer.mixBgmPlan` 混音（loop / volume / fade）→ 最终 mp4；任务记录 music/ambient/meanVolumeDb。
- 验收：`verify-editor-audio.js` **20/0**（产物含音轨、**-18.9 dB**、时长 3.60s、源 mp3 mtime 未变）；export 24/0、adjust 17/0、UX 18/0、shell 22/0 回归。
- **未验证 / 限制**：选曲/波形/淡入淡出的听感与操作（浏览器）；实时预览**暂无声音**。
- 下一项：F09 转场控件 → F10 片段库详情 → F11 导航重组 + F01 重建。

### F09 转场控件（2026-11-04）

- 右侧新增「转场」区块：启用开关、时长（0.2/0.4/0.6/0.8/1.0s）、类型（淡化/溶解/擦除/滑动/圆形/像素化）。
- 关闭后导出走 **concat 直拼**：时长 = Σd、不叠化；逐段 LUT/裁剪照常生效；预览同步取消叠化。
- 验收：`verify-editor-transition-controls.js` **16/0**（开 3.6s / 关 4.0s + `none`；直拼 ΔRGB=23.3 证明 LUT 未丢）；`verify-transitions` 36/0、export 24/0、audio 20/0、adjust 17/0、preview 18/0 回归。
- **未验证**：各转场类型的实际观感与开关手感（浏览器）。
- 下一项：F10 片段库详情（型号/成本/QC/来源任务+重新生成）→ F11 导航 → F01 重建。

### F10 片段库详情（2026-11-04）

- 卡片加「详情」弹层：视频预览、完整提示词、型号、规格（分辨率/尺寸/帧率/时长）、成本（金额/单价/次数）、QC（通过/等级/原因/版本）、**来源任务 taskId**、文件名。
- 详情内可直接收藏/取消收藏、**按原提示词重新生成**；卡片列表也显示 QC 状态与成本。
- 验收：`verify-clip-library-detail.js` **16/0**（真实库 10 条；来源任务/型号/QC/成本/时长齐全）。
- **未验证**：详情弹层视觉（浏览器）；「重新生成」会真实创建任务，验收里只验证入口与接口存在，未触发。
- 下一项：F11 导航重组 → F01 从已有成片重建。

### F11 导航重组（2026-11-04）

- 去掉「配乐编辑器」独立入口；`/app/bgm` 与 `/app/bgm/:id` 旧深链**落到剪辑台**（自动续用上次工程/新建）。
- 导航维持「创作 / 剪辑 + 库存（视频片段/照片/配乐）+ 记录（历史/产出）」，共 7 项；设置仍在底部。
- 验收：`verify-editor-nav.js` **12/0**（静态 + `/app/bgm` 返回 SPA）；`verify-editor-shell` 22/0 回归。
- **未验证**：导航视觉（浏览器）。
- 下一项：**F01 从已有成片重建**（M2 最后一项）。

### F01c 从已有成片重建（2026-11-04）

- `POST /api/projects/from-task`（`src/projectFromTask.js`）：任务成功片段 → 片段库 `assetId`（`libraryId` / 文件路径双匹配），保留入出点；带回 `bgmPlan`（音乐/环境音）与 `transition`；原任务/成片不动。
- 编辑器「打开」弹层新增「**已完成成片 · 重建为工程**」列表，点一条直接生成工程。
- 验收：`verify-editor-rebuild.js` **19/0**（构造完成任务 → 2 段/配乐/转场/命名；未知任务 404）。

### M2 收尾补丁

- F07 音频面板补「**入点/出点**」（源内区间）；F10 详情补**文件大小**。
- 全量回归（14 套件）：**295 通过 / 0 失败**（projects 25、shell 22、media 21、timeline 28、adjust 17、preview 18、export 24、audio 21、transition-controls 16、library-detail 18、nav 12、rebuild 19、ux 18、transitions 36）。
- **M2 结论**：F01c/F05/F06/F07/F09/F10/F11 全部落地并有可复跑验收；UI 视觉/性能（24fps、同帧像素差）仍未在真实浏览器验证。
- **F06 颜色一致性证据（2026-11-04 补）**：8-bit 17³ LUT 三线性插值 vs adjustChain 原函数，四组参数（默认/高亮+50/饱和-50/色温+50）**均值差 0.046%–0.133%**（<1%）；量化上界 0.196%。不含浏览器解码/显示差异。

### 热修（2026-11-04）

- 剪辑台白屏：`Cannot access 'libItems' before initialization`。原因：`libItems` 的 `useMemo` 声明在 effect 之后，而预览 effect 的依赖数组 `[project, libItems]` 在 render 时求值 → TDZ。
- 修复：`libItems` 上移到所有 effect 之前；预览 effect 不再依赖它（内部从 `lib` 展开），deps 改为 `[project, lib]`。F02/F03/F06 回归 22/21/22 全绿。

### 热修 2（2026-11-04）

- **预览着色器编译失败**：fragment shader 缺 `precision highp sampler3D`（`sampler3D: No precision specified`）→ 补 `sampler2D/sampler3D` 精度声明。
- **预览无声音**：engine 增加音乐/环境音两轨 `<audio>`，按 `project.audio` 同步 play/pause/seek、循环、音量与淡入淡出；编辑器把音频计划传给预览。
- WebGL 初始化失败时播放按钮禁用；右侧 HSL/曲线/色轮/蒙版点击提示「后续版本接入」（当前只做基础调节）。
- 验收：`verify-editor-preview.js` **25/0**（新增着色器精度、音频接线检查）；shell 22/0。

### 热修 3（2026-11-04）

- **预览画面倒置**：视频纹理 `UNPACK_FLIP_Y_WEBGL` 与自定义 uv 双重翻转 → 改为 `false`。
- **一调节就黑屏**：调参只改 LUT 时不再重置/seek 视频（同片段走轻量路径）；seek 后补 120/400ms 渲染；渲染异常改为显示原因而不是静默黑屏。
- **时间线音频点击无反应**：音频块可点击选中（高亮并切到音频面板）；「删除」可移除选中的音乐/环境音；「分割」提示暂不支持。
- 验收：preview 26/0、audio 22/0、shell 22/0。

### 热修 4（2026-11-04）

- 刷新白屏：`Cannot read properties of null (reading 'adjust')`。工程先于素材库加载时，预览拿到空片段列表走 `same` 分支，`_ensureLut(null)` 崩；补空片段保护，segments 列表过滤 null。
- 验收：preview **27/0**、shell 22/0。

### 性能修复（2026-11-04）

- 拖调节滑杆卡顿：原来每帧都请求 `/api/adjust/lut`（服务端重算 17³ LUT + 传 20KB + 重建 3D 纹理）。现改为 **120ms 限流**（拖动中约 8 次/秒渐进更新，松手后取最后值）。
- 预览音频 effect 依赖从 `[project, bgm]` 收窄为 `[project.audio, bgm]`，拖滑杆不再反复 seek 音频。
- 验收：preview 27/0、audio 22/0。

### 交互修复（2026-11-04）

- 点击时间线片段只选中、不移动播放头，预览一直停在 00:00 → 看起来「选中的片段和画面不一致」。现点击片段会暂停并 seek 到该段起点，时间码同步跳过去。
- 验收：timeline **29/0**、shell 22/0。

### 预览放大（2026-11-04）

- 播放条新增「放大 / 还原」：隐藏左右面板，预览占满中间（双击预览也可切换）。
- 新增「全屏」：对中间预览区 requestFullscreen，Esc 退出；画布用 ResizeObserver 随尺寸重绘。
- 验收：shell 25/0、preview 28/0。

### 放大模式修复（2026-11-04）

- 放大后黑屏：`.ed-main.theater` 用 `0 1fr 0` 且左右 `display:none`，中间列被自动放进第 1 个 0 宽列 → 改为单列 `1fr` + `.ed-center { grid-column: 1 }`。
- 分辨率标签硬编码 1080p：改为按选中片段素材的最大高度计算（当前素材 720p → 显示 720p），宽高比也按素材计算。

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
| 数据库 | `.env` 为 `DATABASE_TYPE=postgres`；2026-11-02 15:06 实测**库可达**（users 1 行、tasks 201 行），但批量测试仍打 `timeout exceeded`，持久化断言只覆盖内存/JSON 侧 |

## 本轮产出

| 文件 | 动作 |
|---|---|
| `app/AGENTS.md` | 新建（构建/启动、测试、代码规范、坑、红线、验收口径） |
| `app/FEATURES.md` | 新建（已实现 [x] + commit；未实现按 P0–P3） |
| `app/KNOWN_UNKNOWNS.md` | 新建（测绘第 6 部分的缺口，原样收录） |
| `app/prompts/resume.md` | 新建（接手流程模板） |
| `app/PROGRESS.md` | 重写（原调色链交接原文已保留在文末附录） |

## BGM 配乐模块（2026-11-02 15:20–15:35，commits `ad77b54` / `6ee1b50`）

已完成：
- **P0-1 三个红脚本跑绿**：`node scripts/verify-bgm-suite.js` → 3/3（隔离 `DATA_DIR`/`OUTPUT_DIR`，起独立服务；不碰正式成片，实测 mtime 仍 10/19）。
- **P0-3 闪避**：`config.BGM.ducking`（sidechaincompress），默认关；`verify-bgm-ducking.js` 11/0。
- **P0-2 响度**：`config.BGM.loudness` 默认 **-16 LUFS**（任务 `bgm.volume` 优先；`BGM_LOUDNESS` 可覆盖）。实测 -16 比 -20 高约 4dB（mean -19.0 vs -22.9）。
- **P1-4 上传**：base64 落盘通道可用；body 解析移到登录墙之后，`POST /api/bgm` 放宽到 64MB，其余接口仍 100KB；273KB 上传实测成功。
- **P1-5 UI**：新版 `/app/bgm`、`/app/bgm/:id`；时间轴拖拽移动 + 左右裁剪 32/32（Chrome/REA 真机，3011 隔离实例）。
- **P2-7 门禁**：`verify-all.js` 注册套件 17 → 23（新增 6 个 bgm）。

未完成：
- P2-9 预览=导出自动断言；上传 UI；关键帧编辑（本轮判定暂不加）；30 分钟长片/人工视觉。
- 本机门禁仍 `spawn EPERM`，只能逐个套件跑。

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

## 暂缓（原下一步）：人工审核门 `awaiting_review`（P0）

**为什么是它**：
- 全仓 `awaiting_review` 命中 **0 次**，是唯一「设计已完备但一行未实现」的核心功能；
- 它卡住新版前端六步向导的第 ③ 步（`web/src/screens/create.js:7,217` 只能给说明）；
- 设计文档已给出验收清单（`docs/spec/review-gate-design.md` §13，≥20 条）与实施顺序（§15）。

**但不能直接开工，它有两个前置**：

1. **产品需先定 D1–D8**（设计文档 §14「不定就无法开工」）：整组/逐张确认、驳回回退点、审核超时、哪些档位含审核门、旧任务是否升级、分镜图是否公网可读、图片厂商、是否记录审核人。
2. **前置①：状态机缺陷修复**（§15 的第 ① 步）——`paused` 重启永久卡死、暂停超时静默丢弃、历史状态不在回收白名单。不先做，新增的「看起来像进行中」的状态会必然踩同一个坑（风险 R1，致命）。

**所以第一个可执行动作是前置①，不是直接加状态。**

### 审核门第一步的具体命令（暂缓执行）

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

## 审核门相关文件（暂缓期间不动）

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

---

## 剪映式调节滑杆交付（2026-11-02/03）

### 已完成

- **开关**：`app/.env` 已设 `ADJUST_ENABLED=true`（`.env` 不入库；`.env.example` 仍默认 false）。
  **正在运行的 3001 服务需要重启才会读到新值**（本机沙箱无法结束该进程，需人工重启）。
- **算法标定**：`src/processors/adjustChain.js` 新增 `CALIB`；对比度 `xfScale=1.01, pivot=0.43`，
  饱和度 `scale=0.99`；LUT 网格默认「光感 65³ / 其余 33³」；光感改用自研 65³
  `assets/adjust/lightSensation_max.cube`（poly7 + 四面体残差，7 帧 960×540 训练），
  min 仍为镜像近似。
- **PSNR 验收**：新增 `scripts/verify-adjust-psnr.js`，判据沿用 `jy-adjust.md` §13 的
  t=2.5 单帧口径；10 项全部 ≥40 dB（对比度 40.32、光感 40.49；三帧均值 39.46 / 39.97，
  t=4 运动帧拖低，文档已如实列出）。高光/白色/黑色三份新对照到位并全部通过。
- **API 补洞**：`server.js` 的 `POST /api/tasks` 此前漏传 `adjust`（HTTP 入口等于没通），已补；
  新增 `POST /api/tasks/:id/adjust`（保存参数 + 只重跑转码/配乐/终检，旧成片改名备份）；
  `GET /api/tasks/completed` 返回 `adjust / adjustApplied`。
- **前端**：`/app/edit` 剪辑台（`web/src/screens/adjustEditor.js` + `web/styles/adjust-editor.css`），
  10 个滑杆全部启用，锐化/清晰/颗粒/暗角按决策隐藏；历史记录与任务详情均有「剪辑/在剪辑台打开」入口。
- **验收**：11 个套件全 EXIT=0（stages 45 / frontend-static 43 / stats 42 / pipeline-fixes 28 /
  mock-vqc 14 / skill-prompt 109 / skill-ai-path 17 / stage-pipeline 37 / adjust-chain 13 /
  adjust-pipeline 12 / transition-ui 22）；另 `verify-frontend-contract` 49/0。
  开关关闭负向：两条 Mock 任务（一条带 brightness:50、一条不带）逐帧 `framemd5` **126 帧全等**。

### 未验证 / 注意

1. **浏览器视觉/交互未验证**：本机 `dsh_browser_*` 报 Electron 不可用。只做了静态资源 200、
   JS 语法检查与 API 契约验证；需人工打开 `http://localhost:3001/app/edit` 目测。
2. PSNR 验收用 crf18；pipeline 实际转码 crf23/medium，真实导出会低于验收表。
3. 只验证 +50 方向；负向滑杆、光感负向 LUT 均未验证。
4. 根目录 `docs/spec/re-jianying/` 不在 git 仓库内；`jy-adjust.md` §16 与
   `adjust-api-contract.md` 已更新，但不会随 `app/` 提交，需另行备份。
5. 4 项空间近似（锐化/清晰/颗粒/暗角）隐藏，未做对照；`fade` 也不在面板（未验证）。
6. `web/verify/` 是另一会话留下的未跟踪截图目录，本任务未动、未提交。
