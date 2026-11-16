# PROGRESS — 补建基线完成（2026-11-02）

## 🟡 收尾交接（2026-11-15，lead 窗口）

> 本段只记录 v3.1 场景卡 / 图片库 / 视频库这一轮。**没有执行 git add/commit**：工作区同时存在其他窗口的未提交改动，尤其 `server.js` 有他人改动，禁止 `git add -A`。

### 本轮完成
1. **场景卡 v3.1**：`docs/scene-cards-v3.1.*` 已完成 200 张（180 正片 + 20 缓冲），校验：A；A 0、天文错位 0、静态+滑轨 0、季节硬冲突 0、前景=主角 0、连续 3 段同镜头 0；镜头 80/50/30/20/20，风格 140/60。
2. **最终图片集**：14 张成功生成图全部保留；最终版 3 张（沙洲 V3、线形沙丘 V2、温带雨林 V3 裁切）。潮池/冰川/极光归档为淘汰，不删图。
3. **图片库版本化**：`photoLibrary` 新增 `versionGroupId/version/isFinal/failureSummary/scienceStatus/scienceNotes`；`/api/photos?final=1` 只返回最终版；详情返回 `versions`；`setFinal` 拒绝科学未通过。
4. **图片详情**：相邻版本 V1/V2、V2/V3 并排；淘汰/失败记录摘要；点击图片全屏放大；已移除“查看全部生成”按钮。
5. **交付硬门槛**：视频生成要求 `status=approved + scienceStatus=passed + isFinal=true`；单图/批量都拦截。
6. **视频库**：`library.ingestFinal()` 保存最终成片；主流水线、恢复执行、配乐重建三条路径已接；视频详情显示源图版本链。
7. **科学字段**：`src/scienceCheck.js` + `docs/scene-cards-v3.2-science.json`（高风险 24 / 中 22 / 低 154）；页面不再展示审查状态。

### 验证（2026-11-15）
- `node --check`：`photoLibrary.js`、`library.js`、`pipeline.js`、`server.js`、`web/src/screens/inventory.js`、`scienceCheck.js` 全通过。
- `node scripts/verify-photo-library.js`：**42 通过 / 0 失败**。
- `node scripts/verify-i2v.js`：**36 通过 / 0 失败**。
- 服务已按单实例重启；当前运行进程请以 `Get-NetTCPConnection -LocalPort 3001` 为准。
- **未验证**：浏览器视觉/放大手感、真实视频成片入库、自动视觉科学审查。

### 本轮新增/修改（未提交）
- 新增：`scripts/audit-scene-cards-v31.js`、`build-scene-cards-v31.js`、`enrich-scene-science.js`、`generate-scene-cards-21-80.js`、`generate-scene-cards-81-200.js`、`review-photo-science.js`、`v31-six-image-test.js`、`v31-six-image-test-r2.js`、`v31-four-image-test-r3.js`、`src/scienceCheck.js`、`web/src/components/assistantOrb.js`（他人/前序）、`web/verify/`（他人/前序）。
- 修改（本轮触及）：`server.js`、`src/photoLibrary.js`、`src/library.js`、`src/pipeline.js`、`web/src/screens/inventory.js`、`PROGRESS.md`。
- **注意**：`server.js`、`web/src/components/assistant.js`、`web/verify/`、`assets/bgm/manifest.json` 等还有他人的未提交改动；不要 checkout/覆盖，不要 `git add -A`。
- 产物：`app/output/v31-*`、`app/output/final-image-set-review/`、`app/clips/v31test_*.jpg`；均保留，不删除。
  > **2026-11-16 更正**：上述 `clips/v31test_*.jpg` 与两个 output 目录实际在 2026-11-15 17:49 被
  > `purge-artifacts.js --apply` + PowerShell `Remove-Item` 误删（引用范围漏了 `data/photos`）；17 张图片已于
  > 2026-11-16 11:11 从 Chrome 缓存恢复（`docs/交接/2026-11-16-图片丢失-取证与恢复.md`），output 目录的视频/JSON 未恢复。

### 下一步第一个动作
1. 由改动所有者按路径审查 `git diff`（不要整库提交）。
2. 浏览器打开 `/app`，验证：图片库只 3 张最终版；点开可放大；V1/V2/V3 并排；视频库“成片”标记。
3. 视频真实任务跑完后，确认 `library.ingestFinal` 生成 `${taskId}_final` 条目。
4. 若要全自动 100% 交付，再接视觉模型科学审查；当前 `passed` 是后台/CLI 标记，非自动判定。

## ✅ 收尾断点（2026-11-11，lead 窗口）

> 上一窗口的断点在下方保留未删。本段是本窗口收尾时的事实记录，**所有改动均未提交**。

### 本轮完成
1. **编辑器「关闭转场后无法导出」**：`src/editorExporter.js` 删掉「转场关闭暂不支持」闸门（mixer 的 concat 直拼分支早已实现）。证据：`verify-editor-export` **31/0**（关转场 done、时长=Σ、源 mtime/size 不变）；真实 360 段完整导出 **936.4s / 720p30 / 完整解码 0 错误 / 两次 sha256 相同**。
2. **配乐测试隔离**：新增 `scripts/_bgm-guard.js`（真实 `assets/bgm` 快照断言）与 `scripts/_bgm-fixture.js`（临时 `BGM_DIR` + 自造 mp3），改 6 个 `verify-bgm-*`，全部绿且都断言真实目录未被触碰。
3. **配乐页点击试听**：`web/src/screens/inventory.js` 的 `▶` 原来只是图标，未绑事件。现已接 `Audio` 播放/暂停/离页停止/错误提示；前端刷新即生效。
4. **波形接口**（不是安全问题，是健壮性缺陷）：原来用管道读 ffmpeg 输出（沙箱 `spawn EPERM`），且缓存写死 `app/data/waveforms`。已改「落临时 pcm 文件再读」+ 缓存跟随 `DATA_DIR` + 文件指纹失效。隔离实测 **200 / 1600 峰值**。
5. **环境音分类**：`assets/bgm/manifest.json` 给 `ethereal_03`/`ethereal_04` 加 `"category":"ambient"`，隔离实测 **轻音乐 7 + 环境音 2**。
6. **红线**：`AGENTS.md` §5 增加第 9、10 条（归属不明文件禁止 checkout/覆盖；启动服务不得覆盖已有日志）。

### 重启后才生效（重要）
- `src/processors/waveform.js` 与 `assets/bgm/manifest.json` 是**启动时加载/缓存** → 必须**再重启一次 3001**；前端 `inventory.js` 刷新页面即生效。
- `check-server-version` **只比对 `server.js`**，不能反映 `src/**` 改动（已知缺陷，本轮未修）。

### 验证证据（2026-11-11）
- 测试 2（真歌 + 隔离 BGM_DIR）：**10/0**（9 首、分类 7+2、波形 200、试听 URL 200、`calm_06` 混 35s 成功且时长一致、-17.7dB、真实目录未变）。
- 测试 3（6 套配乐）：全绿；`verify-editor-audio` **22/0**。
- 360 首跑 `fetch failed` 根因：轮询连接 **ECONNRESET**（服务存活、job done、产物完整），非导出失败；复现于 120 段 2s 轮询，加复跑即无。
- **未验证**：真 Postgres 持久化、30 分钟真实素材性能、真实服务下的波形（需登录）。

### 文件清单（均未提交；不许自行 checkout / 删除）
- 修改：`AGENTS.md`、`assets/bgm/manifest.json`、`scripts/verify-bgm-{plan,suite,upload,tracks,mix,ducking}.js`、`scripts/verify-editor-export.js`、`src/editorExporter.js`、`src/processors/waveform.js`、`web/src/screens/inventory.js`
- 新增：`scripts/_bgm-guard.js`、`scripts/_bgm-fixture.js`
- 他人未提交（勿碰）：`server.js`、`web/src/components/assistant.js`、`assistantOrb.js`、`web/verify/`
- 产物（gitignore，未删除）：`output/verify_tr_off/`、`output/verify_tr360/`（2×609MB，sha256 相同）、`data/spike/tr120/`

### 事故（2026-11-10，已写入红线）
- 对归属不明的 `assets/bgm/manifest.json` 执行过 `git checkout`，覆盖了用户自己的改动 → 红线第 9 条。
- 重启服务时 `-RedirectStandardOutput` 截断真实 `console-3001.log` → 红线第 10 条。

### 下一步（P0 → P2）
- P0：提交/整理上述改动（**注意 `server.js` / `assistant.js` 是别的窗口的未提交改动，不要混入**）。
- P1：`transitionMixer` 逐段重复探测（360 段 353s 中 **212s** 花在准备）；`check-server-version` 加 `src/**` 指纹。
- P2：BGM 隔离推广到 `verify-editor-audio` 等；Postgres 隔离验证；30 分钟真实素材。

## 🔴 交接断点（2026-11-10 17:15，换窗口前）

> 下面这段是**给下一个窗口**看的，读完再往下读历史。历史部分保留未删（都是证据）。

### 1. 本轮任务目标 + 验收标准（用户原话口径，不要改写）

- **E2 多行批量**：每行一个场景 → `prompts` 长度 = 行数、片段数 = 行数；单行行为不变。
- **E3 余额 + 费用预估**：余额 1 元 / 预计 3 元 → 提交被拦截且**不发 `POST /api/tasks`**；余额空 → 不拦。
- **E4 自定义环节 + 质检严格度**：custom + 只勾 4 步 → `stages` 只含这 4 步（核心 3 步后端强制）；严格度透传。
- **图片查看（用户改口径）**：**不要后端审核门状态机**；只要第②步出图后第③步能看见这张图，
  不满意「打回重做」只重做**这一张**（1 张 = 计费 1 次）。
- **配乐上传**：配乐页能直接传音频（≤20MB，mp3/wav/m4a/ogg），自动登记；非法内容拒收。
- **反需求（用户明确否决，不要再提）**：不做审核门状态机；不接图生视频 i2v；生成产物不放 GitHub。

### 2. 已改文件（全部已提交，工作区无我的未提交改动）

| commit | 内容 | 关键文件 |
|---|---|---|
| `11591f0` | E2 多行批量 | `web/src/screens/create.js`、`scripts/verify-multi-prompt.js` |
| `d7b3273` | E3 余额/预估/拦截 | `server.js`（`POST /api/estimate`）、`create.js`、`settingsPage.js`、`scripts/verify-cost-guard.js` |
| `5c003f2` | E4 custom + 严格度 | `create.js`、`scripts/verify-custom-stages.js` |
| `0194fa2` | 修两个长期红套件 | `src/storage/drivers/jsonfile.js`（`USERS_FILE` 覆盖）、`scripts/verify-auth.js`、`verify-loop.js` |
| `1491f72` | 工程债：pipeline timing 真 bug + 注册 25 套件 | `src/pipeline.js`（`timing` 移到 try 外）、`scripts/verify-all.js` |
| `eb754de` | 第③步图片审核（人工看图/打回） | `create.js`、`scripts/verify-image-review.js` |
| `443331d` | 记录「不接 i2v」决定 | `FEATURES.md` |
| `fd2ced8` | 配乐上传 + 后端校验 | `src/processors/audioMixer.js`（`BGM_DIR` 覆盖/20MB/头校验）、`server.js`（413）、`web/src/screens/inventory.js`、`scripts/verify-bgm-upload.js` |

### 3. 测试状态（2026-11-10 17:12 实跑）

- `verify-stages` **45/0**、`verify-create-config` **28/0**、`verify-image-review` **17/0**、
  `verify-bgm-upload` **23/0**、`verify-cost-guard` **24/0**。
- 门禁规模：**58 注册 / 63 实有 / 5 未注册**（runner + 4 个依赖运行中 3001 且未登录的手动套件）。
- 本机**跑不了** `verify-all.js`（`spawn EPERM`，见 `AGENTS.md` §2.4）→ 只能逐个跑。
- **没有已知红套件**（两个长期红的已修）。

### 4. 下一步第一个动作（具体到能直接执行）

1. **重启服务**（`server.js` + `audioMixer.js` 改了，**当前进程是旧代码**：
   `check-server-version` 显示 running=07:31:16 / disk=08:55:30 → 必须重启）。
2. 重启后跑 `node scripts/check-server-version.js` 应 **exit 0**。
3. 让用户手动复验：配乐页「＋ 上传音频」传一首 5MB mp3 → 列表出现、能试听/设为默认。
4. （可选，不花钱）把 4 个手动套件改成自起临时服务（`AUTH_ENABLED=false` + 临时 `BGM_DIR`），
   预计注册数 58 → 62。

### 5. 需要人拍板、下个窗口不要自己决定

- **剪辑台顺序**：先跑 `spike-editor-export.js` 拿 100/360 段导出数字，还是先接对象存储？
- **对象存储**：用 Cloudflare R2 还是阿里云 OSS？要用户给凭据（endpoint/bucket/AK/SK）。
- **30 分钟长片真跑**：会花几百到上千元，**必须用户明确同意**才能发。
- **双锁文件**（`package-lock.json` + `pnpm-lock.yaml`）删哪个——本机 npm 没有、pnpm 坏了，判断不了。

### 6. ⚠️ 工作区里不是我的改动，**一个都不要碰**

```
 M web/src/components/assistant.js
?? web/src/components/assistantOrb.js
?? web/verify/
```
这些是另一个会话/用户未提交的（assistant 悬浮球相关）。按 `AGENTS.md` §5-4，**不许覆盖、不许提交**。

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

### F12 高级调节（2026-11-04）

- 右侧新增 **HSL / 曲线 / 色轮** 三块面板，tab 从占位改为可切换；「蒙版」不做、UI 不出现。
- HSL：8 个固定色带 × 色相/饱和度/明度，`-100..100`；曲线：R/G/B 三通道，合成通道同时写入三条，默认 5 点可拖；色轮：lift/gamma/gain × r/g/b/y，`-1..1`（0 = 不变）。
- 新文件 `web/src/components/advancedAdjust.js`；`editor.js` 接 `setAdvanced()` 写回 `segments[].adjust`；`preview/engine.js` 的 `hasAdjust` 增加 `ADV_KEYS`（否则「只有高级参数」的段预览不取 LUT）；`editor.css` 补面板样式。
- 颜色数学未复制：预览 `POST /api/adjust/lut`、导出 `transitionMixer` 都继续走 `adjustChain.normalizeParams`。
- 先写 `scripts/verify-adjust-advanced.js` 并确认红：**16 通过 / 12 失败**（失败全是 UI/引擎未实现；LUT/持久化/导出本就通过）。
- 实现后：advanced **28/0**；指定回归 preview **28/0**、adjust **17/0**、export **24/0**。
- 追加回归：shell 25/0、transition-controls 16/0、timeline 29/0、ux 18/0、audio 22/0、media 21/0、nav 12/0、rebuild 19/0。
- **未验证**：浏览器里的拖点/滑杆手感、真实 WebGL 同帧画面；本环境无浏览器。真实 30 分钟长片仍未测。
- 注意：后端 `normalizeParams` 对 `curve` 只检查长度 3，不做点校验/钳制（hsl/wheel 有 clamp）；UI 已按 0..1 约束，但 API 直传非法曲线仍可能产生异常 LUT，后续可补后端校验（本轮未改后端）。

### 图片生成接入 wan2.7-image（2026-11-08/09，准备阶段）

- 需求：图片大模型定为阿里云百炼 `wan2.7-image`；用户稍后自己添加 Key。
- 已完成（不需要 Key 的部分）：
  - `src/generators/imageProviders/dashscope.js`：异步提交 → 轮询 `/tasks/{id}` → 下载 PNG → 落盘；校验 PNG/JPEG/WebP 文件头与宽高；失败显式抛错，不返回占位图；同名文件用 `_v2` 不覆盖。
  - **2026-11-09 加固**：提交阶段对 429/5xx 重试（最多 3 次、指数退避、受总超时约束）；401/403/400 不重试；落盘改为「唯一临时文件 + `COPYFILE_EXCL` 抢占最终名」，并发同名出图不会互相覆盖。
  - `src/generators/imageProviders/index.js` + `server.js` 启动注册 `dashscope`。
  - `config.js` / `.env.example`：`IMAGE_GEN_PROVIDER=dashscope`、`IMAGE_GEN_MODEL=wan2.7-image`、16:9 1K 默认 `1696*960`；`IMAGE_GEN_API_KEY` 留空自动复用 `DASHSCOPE_API_KEY`。
  - `GET /api/image-gen/status`：返回配置就绪度 + 是否可出图，不回传 Key。
  - `POST /api/images/generate`：单张出图（真实计费，只有带 Key 且显式调用时才花钱）。
  - `web/src/screens/create.js`：第二步从占位改为显示就绪度，并在就绪时提供「生成 1 张测试图」；`inventory.js` 照片页文案同步更新。
  - `web/src/screens/settingsPage.js`：新增「设置 → 图片生成 · wan2.7-image」组（API Key / Base URL / 模型 / 尺寸）；填本机 Key 后创作页可直接测试，不用改 `.env`、不用重启。图片组有「测试连接」；Seedance 与可灵默认折叠；**所有密码字段（含图片 Key）都有 👁 显示/隐藏切换**。
  - `GET /api/image-gen/status` 支持运行时覆盖；`POST /api/images/generate` 接受 `apiKey/baseUrl/model/size`，只用于本次请求，不落盘。
  - `POST /api/test-api-key` 新增 `type=imagegen`：用不存在的 task 探测鉴权，不消耗生成额度；401/403 判 Key 无效，其他错误判鉴权通过。
  - `GET /api/status` 增加 `serverInfo`（startedAt / serverMtime / pid）与 `imageGen` 版本探针（不含 Key）。
  - `scripts/check-server-version.js`：比对「运行中 server.js 的 mtime」与磁盘文件；0=当前代码，1=旧代码/过期，2=未运行。实测旧 3001 返回 1、临时新服务 3819 返回 0。
  - `web/src/app.js`：检测 `/api/status` 缺少 `imageGen` 时，在页面底部显示「服务端代码是旧版本，请重启」警告；设置页测试连接遇到「未知的测试类型」也会追加重启提示。
  - `scripts/test-image-gen.js`：`--payload` 打印请求体；`--live` 真实出图；默认只看配置。
  - `scripts/verify-image-gen.js`：本地 stub，100 条断言（成功链路、同步返回、同名/并发不覆盖、提交与下载 5xx 重试、401 不重试、200+code、FAILED、无 URL、HTML、超时、参数负向、运行时 Key、设置页接线、折叠与眼睛、版本探针、根路径重定向）。
- 实测：
  - `node scripts/verify-image-gen.js` → **100 通过 / 0 失败**。
  - `node scripts/check-server-version.js`：旧 3001 → 退出 1（缺 serverInfo/imageGen）；临时新服务 3819 → 退出 0。
  - 临时服务（`AUTH_ENABLED=false`）请求 `GET /api/image-gen/status` → `ready:false, missing:["IMAGE_GEN_API_KEY"], providerImplemented:true`。
  - 同一临时服务 + 本地 stub（`IMAGE_GEN_BASE_URL` 指向 stub）POST `/api/images/generate` → 真实落盘 384×216 PNG（106,820 字节，magic `89504e47`）。
  - **服务端无 Key、仅请求体带运行时 Key**：POST 返回 200，落盘 512×288 PNG（91,812 字节，magic `89504e47`）——对应「设置里填 Key」的路径。
  - **设置「测试连接」**：注入 401 stub → `success:false` 且提示地域/业务空间；注入 404 stub（鉴权已通过）→ `success:true`，提示「只验证鉴权，是否开通 wan2.7-image 以实际出图为准」。
- **待确认（2026-11-09）**：
  - 3001 上可能还跑着旧进程（旧代码没有 `type=imagegen` 分支），会显示「未知的类型」；需完全退出旧服务再 `node server.js`，并用 `GET /api/status` 是否含 `imageGen` 字段确认新代码已加载。
  - 用户的 Key 来自 WhaleTV（同一 Key 支持 wan2.7-image / wan3.0 / deepseek4.1flash），不是阿里官方 DashScope Key；需要 WhaleTV 给的 **Base URL** 和出图接口示例，才能判断是百炼业务空间（现有原生适配器可用）还是 OpenAI 兼容中转（需新增适配路径）。
- **尚未做**（不要当成已完成）：
  - `image_generation` 阶段尚未进 `pipelineStages` / `taskManager` / `pipeline`；向导第 2 步可单张测试出图，但审核门（第 3 步）仍是占位。
  - 审核门 `awaiting_review`、任务级图片字段、审核 API 均未实现（设计见 `docs/spec/review-gate-design.md`）。
  - 图生视频 `I2V_*` 仍为预留；`IMAGE_INPUT_CAPABILITY.dashscope` 仍为 `null`（未核实）。
  - 前端「生成 1 张测试图」只做了 ESM 语法检查与静态接线断言；**未在真实浏览器验证**（本机 `dsh_browser` 报 Electron 不可用）。
  - **真实厂商调用未验证**（本机无 Key）。用户加 Key 后先跑 `node scripts/test-image-gen.js`，再跑 `--live`。
- 添加 Key 的两种方式：① 页面「设置 → 图片生成」填 Key（只存本机浏览器，随请求发送，不用重启）；② `app/.env` 写 `IMAGE_GEN_API_KEY=sk-...`（或 `DASHSCOPE_API_KEY=sk-...` 复用）后重启服务。页面填的优先。
- **以后改后端（server.js / src/**）的固定动作**：重启 → 跑 `node scripts/check-server-version.js`（必须退出 0）→ 再刷新页面。前端 `web/**` 可热更新，后端不会。

### 前端单版本收口（2026-11-09）

- **唯一维护的前端**：`app/web/**`，挂在 `/app`。`/` 现在 302 到 `/app`；登录页默认也回 `/app`。
- **旧版 `public/index.html` 仅归档**（295,955 字节，最后改动 10-27）：5 个验收脚本（frontend-static / skill-prompt / transition-ui / recovery-fixes / check-inline-js）与 `public/_selftest.html` 仍直接读它，**删了会破门禁**，所以本轮不删、也不再改。
- 旧页面 `members.html` / `bgm-editor.html` / `clip-library.html` / `music-library.html` 等不再是入口；新 UI 对应 设置（含成员）/ 剪辑台 / 库存。
- 桌面 `打开新版前端.bat` 只是启动器（不是前端副本），指向 `http://localhost:3001/app`；它读不到 `app\.env`，换端口会失效。**建议改成指向 `测试\打开新版前端.bat` 的快捷方式，只保留一份。**
- `重启服务.bat` 已改为打开 `/app`，并在启动后自动跑 `node app\scripts\check-server-version.js`；它自提权，能结束上次由管理员启动的旧进程（这就是 DSH 杀不掉 PID 100696 的原因）。
- 实测：临时新服务 `GET /` → `302 Location: /app`；`GET /app` → `200`；`check-server-version.js` → 退出 0。

### E1 创作页生成参数接线（2026-11-09，完成）

- **改了什么**：`web/src/screens/create.js`
  - 新增 `readWebConfig()`：`JSON.parse(localStorage.getItem('vs_web_config') || '{}')`，解析失败返回 `{}`。
  - `p` 的三个初值改为 `web.videoModel || 'seedance'` / `web.resolution || '1080p'` / `web.preset || 'final'`（其余字段未动）。
  - 确认页（`step === 5`）在「衔接」与「确认」之间新增「生成参数」块：模型 `seedance/kling/dashscope`、
    分辨率 `720p/1080p/4K`、档位 `final/daily/quick/clips_only`，改的是 `p`。
  - 确认清单在「分辨率」后补只读行「档位：${p.preset}」；「模型 / 分辨率」原有行保留。
  - **没动**：`collectRuntime()`（Key 仍读 `vs_config`，dashscope `modelId` 仍 `wan3.0-video`）、step 2、请求体结构。
- **新验收**：`scripts/verify-create-config.js`（28 项，纯静态，不联网/不起服务），已注册进
  `scripts/verify-all.js` fast 组（`--only create-config`）。**先红 13 通过 / 15 失败**（红在未读
  `vs_web_config`、无生成参数块、无档位行），实现后 **28 通过 / 0 失败**。
- **回归**：`node scripts/verify-image-gen.js` → **100 通过 / 0 失败**（未改该脚本）。
- **请求体实测**（离线复刻真实渲染路径：仓库自带 `htm` + 极小 hooks 运行时加载真实 `create.js`，
  写入 `vs_web_config={videoModel:'dashscope',resolution:'720p',preset:'quick'}`，点 5 次「下一步」，
  拦截 `fetch('/api/tasks')` 记录 body 后立即 reject——不建任务、不计费）：
  `model='dashscope'`、`modelId='wan3.0-video'`、`resolution='720p'`、`preset='quick'`、
  确认页「档位」行显示 `quick`、确认页 select 值 `['dashscope','720p','quick']`。
- **未验证**：真实浏览器点击/视觉（本机 `dsh_browser` 报 Electron 不可用，属既有环境限制）；
  E6 端到端仍未复核（服务当前运行的是同一份磁盘代码，但页面点击未做）。

### E5 旧版页面彻底删除（2026-11-09，完成）

- **背景**：用户反复被 `http://localhost:3001/index.html` 带回旧页面，质疑「单版本收口」名不副实。
  核实：旧页面文件一直没删（295,955 B，最后改动 10-27），`/` 只是 302 到 `/app`，`public/` 静态目录仍原样下发。
- **本次删除**（`git rm`，历史可回滚）：
  - 12 个旧 HTML：`index` / `preview-app` / `preview-login` / `bgm-editor` / `members` / `clip-library` /
    `music-library` / `showcase` / `design-system-notion-apple` / `icon-comparison` / `_ptest` / `_selftest`；
  - `public/theme-nightvalley.css`、`public/showcase/`（2 个素材，与 `assets/` 重复）；
  - 只读它们的 5 个脚本：`check-inline-js` / `verify-frontend-static` / `verify-transition-ui` /
    `verify-pages` / `verify-editor-dom`；另删 4 个临时脚本（`test-editor-logic` / `_e` / `_selfcheck` / `_userflow`）。
- **保留**：`public/login.html`（登录墙）、`public/assets/`（登录页背景视频与海报）。
- **改动**：
  - `server.js` 新增 `LEGACY_PAGES` 数组：12 个旧地址 + `/` 全部 `302 /app`（书签/历史不再 404、也不会打开旧界面）；
  - `verify-all.js` 移除 `frontend-static` 注册（26→25 个套件）；
  - `verify-recovery-fixes.js` 剥离 3 条旧 HTML 断言（28→25，后端断言保留）；
  - `verify-skill-prompt.js` 剥离 6 条旧 HTML 断言（109→103，后端断言保留）。
- **回归实测**：`verify-skill-prompt` **103/0**、`verify-recovery-fixes` **25/0**、
  `verify-create-config` **28/0**、`verify-image-gen` **100/0**；`server.js` 等 4 个改过的文件 `node --check` 通过。
- **待人工一步**：重启服务后确认 `check-server-version.js` exit 0、`/index.html` 返回 302 `/app`、`/app` 200。
- **已知取舍**：`verify-frontend-static`（43 项）等断言随被测对象一起作废；新版前端由
  `verify-create-config` / 编辑器套件（shell/media/timeline/preview…）覆盖，不再有「旧 DOM id 校验」这一层。

### Key 粘贴污染防护 + 显示/隐藏按钮修复（2026-11-09）

- **事故**：把页面上的提示文案「✗ Invalid API-key provided.｜提示…」整行粘进「设置 → 图片生成 → API Key」，
  Node 的 fetch 在构造 `Authorization: Bearer …` 头时抛
  `Cannot convert argument to a ByteString because the character at index 7 has a value of 10007`
  （10007 = 0x2717 = `✗`；`Bearer ` 正好 7 个字符，所以 index 7 = Key 第一个字符）。
  服务端原来把这个异常包成「网络错误」，用户看不出是“键里混进了文字”。
- **后端**（`server.js`，`/api/test-api-key`）：
  1. 在第一次 `fetch` 之前校验 `API Key / Base URL / 模型名` 是否含非 ASCII 字符，命中直接返回
     「XX 里含非 ASCII 字符「✗」（U+2717）……请只填纯英文数字」+ `nonAscii: true`；
  2. imagegen 的 401/403 响应回显 `urlUsed` 与 `baseUrlSource`
     （`request（页面 Base URL）` / `default（旧通用入口，业务空间 Key 在这里必 401）` / `env（…）`），
     并把「本次实际请求：…」并进错误文案——以后一眼能看出是不是“地址留空回落到通用入口”。
- **前端**（`web/src/screens/settingsPage.js`）：
  1. 显示/隐藏按钮改为**内联样式定位 + 文字「显示/隐藏」**，不再依赖 `👁/🙈` emoji，
     也不依赖编译后 CSS 里缺失的 `right-1 / w-6 / pr-9 / top-1/2 / -translate-y-1/2`（这次踩到的坑）；
  2. Key 输入框用内联 `paddingRight` 给按钮留位；字段里出现非 ASCII 时**即时红字提示**「多半是粘贴了提示文案」。
- **新验收**：`scripts/verify-key-guard.js`（18 项静态，先红 12/6 → 改完 18/0），注册进 `verify-all.js` fast 组。
- **回归**：`verify-image-gen` 100/0、`verify-create-config` 28/0 未变。
- **待人工一步**：重启服务（`server.js` 改了）→ `check-server-version.js` exit 0 →
  设置页重新粘 Key → 「测试连接」；若仍 401，界面现在会直接显示**实际请求地址与来源**。

### OpenAI 兼容出图适配器（2026-11-09，WhaleTV 中转可直接出图）

- **背景**：用户的 Key 来自 WhaleTV 中转（`https://agglm.whaletv.com`），它是 **OpenAI 兼容协议**：
  `POST /v1/images/generations` 一次返回 `data[0].url`；而原适配器是百炼原生「提交任务 → 轮询 /tasks」，
  填对地址也会 404。
- **实测（2026-11-09，用户 Key）**：`GET /v1/models` → `200`，仅 `wan2.7-image`
  （`supported_endpoint_types:["image-generation","openai"]`）；`GET /v1/videos/generations` → `403
  This token has no access to model`（接口存在、该 Key 未开视频权限）；`GET /v1/tasks/probe` → `404 Task not found`；
  `POST /v1/images/generations {model:'wan2.7-image',prompt,n:1,size:'1024x1024'}` → `200 {"data":[{"url":…}]}`。
- **新增适配器** `src/generators/imageProviders/openaiCompatible.js`（provider id `openai-images`）：
  - 同步出图；支持 `data[0].url` / `data[0].b64_json` / 中转 `metadata.output.choices[].message.content[].image` 三种形态；
  - 尺寸 `1696*960` 自动转 `1696x960`（OpenAI 风格）；
  - 宽高以**下载到的字节**为准（`readImageMeta`），不是接口自报；下载 3 次重试、40MB 上限；
  - 落盘沿用「唯一临时文件 + `COPYFILE_EXCL` 抢占」，并发/重复点击不覆盖；
  - 负向明确 throw：401/403 → 鉴权失败；**200 但非 JSON（HTML）→ 判失败**；200 无 image → 判失败；下载到非图片 → 判失败。
- `src/generators/imageProviders/index.js` 注册 `openai-images`；`server.js`：
  `/api/images/generate` 接受运行时 `provider`；`/api/test-api-key` 的 `type=imagegen` **按协议选探针**
  （`openai-images` → `GET {base}/models`；`dashscope` → `GET {base}/tasks/invalid-task-check`），
  并新增「200 但响应不是 JSON → 判失败」（防止把网页地址填成 Base URL 还显示 ✓）。
- 前端：设置页「图片生成」新增「接口类型」（百炼原生 / OpenAI 兼容），随测试与出图请求发送；
  创作页「生成 1 张测试图」带 `provider`。
- **验收**：新增 `scripts/verify-image-gen-compat.js`（22 项，本地 stub，已注册 fast 组）→ **22/0**；
  回归 `verify-image-gen` **100/0**、`verify-key-guard` **18/0**。
- **真实出图（走我们自己的适配器，1 张）**：`1024x1024` PNG，**1,820,253 字节**，
  `provider=openai-images`、`model=wan2.7-image`、`baseUrl=https://agglm.whaletv.com/v1`。
- **WhaleTV 填法**：设置 → 图片生成：接口类型 `OpenAI 兼容`、Base URL `https://agglm.whaletv.com/v1`、
  模型 `wan2.7-image`、尺寸先填 `1024x1024`（`1696x960` 是否被中转接受**未验证**）。
- **未验证**：视频 `wan3.0-video`（该 Key 无权限，且视频协议未知）；文字 `deepseek-v4-flash-0731`
  （现有 LLM 组即 OpenAI 兼容，填 `https://agglm.whaletv.com/v1` + 模型名即可，未实测）；
  质检所需**视觉模型** Whaletv 目前不提供（三个模型都不能看图）。

### 默认出图尺寸改为 16:9（2026-11-09）

- 原因：`1024x1024` 是方形，而产品成片是 **16:9 电视屏保**；方图当素材/首帧会黑边或裁切。
  实测（用户 Key，WhaleTV 中转）：`1696x960` **可出图**，产物 `1696x960`、2,769,524 字节。
- 改动：`config.js` 的 `IMAGE_GEN_SIZE` 默认 `1696*960` → **`1696x960`**（`.env.example` 同步）；
  百炼原生适配器会自动归一化为 `宽*高`，OpenAI 兼容适配器直接吃 `x`，两套都能用；
  设置页提示文案同步。
- 断言：`verify-image-gen-compat.js` 新增 3 条（config 默认 = 1696x960 / 适配器解析 = 1696x960 / 不再回落到方形）→ **25/0**；
  回归 `verify-image-gen` 100/0、`verify-create-config` 28/0。
- **注意**：`scripts/check-server-version.js` 只比对 `server.js` 的 mtime，**改 `config.js` / `src/**` 它不会报旧**；
  这类改动同样必须重启（本次因 `server.js` 也有改动，所以重启检测仍有效）。

### OpenAI 兼容视频适配器（2026-11-09，协议已实测；真机下载验证中）

- **协议实测**（WhaleTV 中转，model=`wan3.0-video`，Key 仅授权该模型）：
  - `POST {base}/videos {model,prompt,seconds}` → `200 {"id":"task_…","object":"video","status":"queued","progress":0}`
  - `GET {base}/videos/{id}` → `{"status":"queued|in_progress|completed","progress":N}`；
    **completed 也**不给视频 URL**。
  - `GET {base}/videos/{id}/content`（**要 Bearer**）→ `200 video/mp4`，实测 19,611,822 字节
    （`ftypisom`），支持 `Range`。**结论：内容必须由适配器自己带着 Key 下载**，pipeline 原来的裸 `fetch(url)` 会 401。
  - 其它路径：`/v1/videos`（GET）404、`/v1/video/generations` 404、`/v1/videos/generations` 404（POST），
    所以 **正确入口是 `/v1/videos`**。
- **下载很慢且有坑（实测）**：整段 GET `/content` 会**卡住**（130 KB 后停滞 3 分钟）；
  **Range 分块稳定**：1 MB/次、每次 25–40 s（约 35 KB/s），19.6 MB 约 10 分钟。
  → `downloadVideo` 实现为 **1 MB 分块 + 每块 3 次重试 + 断点续写**，写完校验总大小与 MP4 头；
  无直链（`?include=url` 等参数被忽略，`/url` `/download` 均 404）。
  **产品含义**：WhaleTV 适合少量测试；30 分钟长片（180–360 段）用它光下载就要几十小时，
  长片仍应走百炼官方直连，或让中转提供 OSS 直链。
- **新增**：`src/generators/openaiVideo.js`（id `openai-video`）：
  `generate()`（POST /videos，只发实测被接受的 model/prompt/seconds，分辨率/画幅未验证故不传）、
  `getStatus()`（兼容 completed 给 URL 与不给 URL 两种实现）、`downloadVideo()`（Bearer + 流式 + MP4 头校验，
  下到 HTML/JSON 一律拒收并删除半成品）。
- **接线**：`src/generators/index.js` 注册 `openai-video` + `getAvailableModels()` 条目；
  `src/pipeline.js` 的下载分支改为「适配器有 `downloadVideo` 就优先用它，否则才裸 fetch URL」；
  `server.js` 的 `/api/test-api-key` 新增 `type=openai-video`（`GET {base}/models` 验鉴权，免费）；
  前端：设置页新增「OpenAI 兼容视频（WhaleTV / 中转）」组（Key / Base URL / 模型），
  创作页模型下拉新增该选项，提交时带 `apiKey/baseUrl/modelId`。
- **验收**：`scripts/verify-openai-video.js`（20 项，本地 stub + 静态接线）→ **20/0**，已注册 fast 组。
- **事故记录（我的责任）**：探测视频接口时本想用「空请求体」拿 400 校验错误（免费），但中转对
  `model+prompt` 立即接受，**误创建 4 个视频任务**（`task_zoM9…`/`task_dIqr…`/`task_MBxa…`/`task_HJnp…`，
  均已完成，会计费）；无取消接口（`DELETE /v1/videos/{id}` → 404）。已停止此类探测，后续只用 GET。
- **真实下载 + ffprobe 实测（2026-11-09 22:35，走我们自己的 `downloadVideo`）**：
  - 产物保留：`output/_video_probe/task_zoM9i371gvArOLtDA6sqewFXR1hFWQ4g.mp4`（**19,611,822 字节**，未删除）
  - ffprobe：`h264 1920x1080 30fps 5.000s` + `aac 5.038s`；format `5.038s / 19,611,822 / 31.1 Mbps`
  - 音频：mean **-14.7 dB** / max **-2.7 dB**；`ffmpeg -f null -` 完整解码 **exit 0**
  - **注意**：中转默认带音轨（我们没有传 audio 参数）。本项目成片配乐是另混的，片段自带音轨对拼接无影响，
    但如果要省码率需要在提交时加 `audio:false`（中转是否支持**未验证**）。
  - 下载过程：18 MB 之后卡过（Range 的 end 超过总长时中转退化成 200 整包，会挂住）→ 修复：
    先用 `Range: bytes=0-0` 探总长，之后每块 `end = min(start+CHUNK-1, total-1)`；
    并加 **每块 90s 超时 + 4 次重试 + 断点续传**（保留半成品）。修完续传 18,874,368 → 19,611,822 仅 **22.2s**。

### 新增硬规则：花钱调用必须先经同意、产物必须保留（2026-11-09）

- 用户明确要求（事故后）：**任何会真实计费的模型调用，发起前必须先说明并取得同意**；
  **每次真实调用的产物必须保留**（文件 + 请求参数 + 返回 JSON + 任务 id），不得自行删除。
- 已写进两份契约：
  - 根 `AGENTS.md` 新增 **§4.9**（含事故经过与 5 条强制规则）；
  - `app/AGENTS.md` §5 红线新增第 7、8 条（摘要 + 指向 §4.9）。
- 探测手段白名单：只读 `GET`（模型列表/任务状态/Range 读头）、本地 stub（`verify-*.js`）、缺必填字段的非法请求。
- 本轮视频产物按新规则保留在 `app/output/_video_probe/`（一个任务一个文件，不删）。

### E3 余额 + 生成前费用预估/超额拦截（2026-11-10，完成）

- **旧版口径**（从 git 历史 `7db210e~1:public/index.html` 取，旧页面已删）：
  设置里填「账户余额（元）」；留空 = 不拦截；非 mock 在提交前弹「费用预估确认」；
  预计花费 > 余额 → 直接拦截、不发请求；dashscope 按秒计价 720P ¥0.6/s · 1080P ¥1.2/s · 480P ¥0.3/s。
- **服务端**：新增 `POST /api/estimate`（`server.js`），复用 `src/pricing.js` 的 `computeUnitPrice`，
  与 `GET /api/pricing` **同一份价目表**（返回 `estimate / perClip / basis / priceVersion / clips`），
  `clipCount` 夹到 1–500；未知模型返回 0 + `basis:'unknown'`。
- **前端**：
  - 设置页「生成参数」新增「账户余额（元）」，写 `localStorage.vs_web_config.balance`（留空 = 不拦截）；
  - 创作页确认页新增「预计花费」行（含余额），进入确认页或参数变化时调 `/api/estimate` 重算；
  - 提交前比对：`est.estimate > balance` → 红字「已拦截：预计花费 ¥X 超过账户余额 ¥Y…」并 **return（不发请求）**；
    确认页同时提前显示「提交会被拦截」提示。
- **验收**：新增 `scripts/verify-cost-guard.js`（24 项，已注册 fast 组）→ **24/0**，其中 3 条是
  **离线跑真实 `create.js`** 的行为断言（仓库自带 htm + 极小 hooks 运行时，fetch 打桩）：
  - 余额 ¥1 / 预计 ¥3 → **拦截，且 `/api/tasks` 确实没被调用**；
  - 余额留空 → 不拦截，`/api/tasks` 被调用；
  - 余额 ¥100 / 预计 ¥3 → 放行。
  服务端口径实测：mock 0；dashscope 1080p 5s×10 = ¥60、720p 5s×4 = ¥12；siliconflow ¥2×3 = ¥6；
  seedance-2.5 ¥3×2 = ¥6；`priceVersion` 与 `/api/pricing` 一致。
- 回归：`verify-create-config` 28/0、`key-guard` 18/0、`image-gen-compat` 25/0、`openai-video` 24/0、`stages` 45/0。
- **未验证**：真实浏览器里的交互手感（本机无浏览器）；`/api/estimate` 是否被登录墙正确保护（沿用全局中间件，未单独测）。

### E2 多提示词批量（2026-11-10，完成）

- **旧版口径**（git 历史 `7db210e~1:public/index.html`）：多行模式「每行一个场景提示词，行数即片段数
  （覆盖段数设置）」，行尾可加【主题】标签。
- **服务端本来就支持**（`server.js:1469-1521` + `taskManager.js:122-143`）：接受 `prompts` 数组
  （字符串或 `{text,theme}`），字符串行由 `promptOptimizer.parseThemeTag()` 解析【主题】；
  片段数以行数为准；>200 行报错。**本次没有改后端**。
- **前端**（`web/src/screens/create.js`）：
  - `splitPromptLines()` 按 `\r?\n` 拆行、trim、丢空行；`promptLines.length > 1` 进入多行模式；
  - `effectiveClips = 多行 ? 行数 : p.clipCount`，用于「片段」行、成片时长、费用预估、提交体；
  - 提交体：多行发 `prompts: [...行]`（不发单条 `prompt`），单行照旧发 `prompt`；
  - 提示：第一步提示「单行 = 单场景 × 段数；多行 = 每行一个场景（覆盖段数）」并实时显示「当前 N 行 → 将生成 N 段」；
    第四步警告「片段数量被行数覆盖」；确认页显示「N 段（N 个场景，按行生成）」。
- **验收**：新增 `scripts/verify-multi-prompt.js`（17 项，已注册 fast 组）→ **17/0**：
  - 静态接线；
  - **离线跑真实 `create.js`**（htm + 极小 hooks，fetch 打桩）：三行 → `prompts` 长度 3、`clipCount=3`、
    不发 `prompt`、预估也按 3、确认页显示 3；单行 → 不带 prompts、沿用 4 段；含空行 → 只算 2 个有效场景；
  - 临时服务负向：`prompts: []` → 400；201 行 → 400（含「当前输入了 201 行提示词」）；2 行 + 未知模型 → 400
    （证明 prompts 已被解析并通过校验；**未创建任何任务**）。
- 回归：`cost-guard` 24/0、`create-config` 28/0、`key-guard` 18/0、`openai-video` 24/0。
- **未验证**：真实浏览器交互（本机无浏览器）；【主题】标签在真实任务里的最终提示词（依赖 promptOptimizer，未实测）。

### E4 自定义执行环节 + 质检严格度（2026-11-10，完成）

- **后端本来就有**（本次未改）：`POST /api/tasks` 的 `preset='custom'` + `stages[]` → `pipelineStages.resolveStages`
  （核心链 3 步强制、依赖自动补齐、未知步骤拒绝）；`strictQcItems[]` → `qualityChecker` 的 `strictItems`
  （不传 = 全部项都要紧；`nsfw` 在 `ALWAYS_STRICT` 里，永远要紧）。`verify-stages` 45/0 覆盖纯函数层。
- **前端**（`web/src/screens/create.js`，确认页「生成参数」块）：
  - 档位下拉新增 `custom（自定义环节）`；
  - 选 custom 时出现 **8 个环节勾选框**（`STAGE_OPTS`，键与 `ALL_STAGES` 一致；核心 3 步 disabled + 恒勾选）；
  - 新增 **「质检严格度」13 个勾选框**（`QC_OPTS`，键与 `QC_ITEMS` 一致；NSFW disabled + 恒勾选）；
  - 提交体：custom 才发 `stages`（过滤非法键），始终发 `strictQcItems`；`nsfw` 无法被取消（toggle 里强制保留）。
- **验收**：新增 `scripts/verify-custom-stages.js`（32 项，已注册 fast 组）→ **32/0**：
  - 静态：8 个环节键 + 11 个质检键 + custom/stages/strictQcItems 接线；
  - **离线跑真实 create.js**：切 custom → 取消「无缝循环」「配乐混音」→ `stages` 不含 `loop_processing`/`audio_mix`
    且核心 3 步仍在；取消「循环质检」→ `strictQcItems` 不含 `loop` 且 `nsfw` 仍在；非 custom 档**不发** `stages`。
- 回归：`multi-prompt` 17/0、`cost-guard` 24/0、`create-config` 28/0、`key-guard` 18/0、`stages` 45/0、
  `openai-video` 24/0、`image-gen` 100/0、`image-gen-compat` 25/0。
- **未验证**：真实浏览器交互（本机无浏览器）；custom 档 + 真实任务端到端（`verify-stage-pipeline` 未跑，需真机 Mock 任务）。

### 工程债清理（2026-11-10，第一步）

- **两个长期红套件已修**（`0194fa2`）：
  - `verify-auth` **11/15 → 40/0**：根因不是登录坏了，而是脚本直接读写真实 `data/users.json`，
    历史残留 `verify_` 账号让 `auth.bootstrap()` 跳过建号 → 登录全 401。给 jsonfile 驱动加
    `USERS_FILE` 环境覆盖（与既有 `DATA_DIR` 覆盖同一套测试隔离思路，默认行为不变），
    `verify-auth` 把用户文件指向临时目录、跑完删临时目录。另修一条过期断言：E5 单版本收口后
    `/` 已变成 302 `/app`，原先「关掉登录墙后 / 返回 200」不再成立 → 改为断言 302 + `Location=/app`。
  - `verify-loop` **28/1 → 29/0**：`qcVersion === 2` 写死，代码已是 3 → 改为从 `qualityChecker.QC_VERSION`
    同源取，以后升版不会再假红。
- **未注册套件收口**：把原 29 个未注册套件逐个跑了一遍（脚本把 stdout/stderr 重定向到文件描述符，
  避开本机管道 EPERM）：**24 个绿**，另有 `verify-adjust-pipeline` 抓到真 bug、修完也绿 → **新注册 25 个**。
  现 **56 注册 / 61 实有 / 5 未注册**（`verify-all.js` 是 runner 本身 + 4 个依赖运行中 3001 服务/登录态的
  手动套件：`verify-bgm-api` / `bgm-e2e2` / `bgm-negative` / `port3001`）。
- **真 bug（修）**：`pipeline._processSingleClip` 把 `timing` 声明在 `try` 里，`catch` 调
  `_finishClipFailure(..., timing)` → `ReferenceError: timing is not defined`，**整个 Node 进程退出**，
  任务永远停在 `generating`。触发条件：片段重试次数用尽（如持续 429）。已把 `timing` 移到 `try` 外，
  `verify-adjust-pipeline` 12/0（负向用例：请求了调节但滤镜生成失败 → 任务判 failed 且原因可读）。
  **注意：`src/pipeline.js` 改了，运行中的服务需重启才对真实任务生效。**
- **小脏点**：`.gitignore` 补 `*.log.err` 并 `git rm --cached data/logs/console-3001.log.err`（文件保留，服务仍在写）。
- **未处理**：双锁文件（`package-lock.json` + `pnpm-lock.yaml`）。本机 `npm` 不存在、`pnpm` 已损坏，
  无法判断哪个可信，删除有风险 → 留给用户决定。
- **盘点日志**：`output/_verify_inventory/*.log`（每个套件的原始输出，未删除，便于复核）。

### 向导图片审核（人工确认，2026-11-10）

- **用户决策**（原设计文档 §14 的 D1–D8 大部分不再适用）：
  - **不要后端审核门状态机**：不新增 `awaiting_review`、不做批次审核/超时/强制升级/留痕；
  - 只要「第②步出完图，**第③步能看见这张图**，不满意就打回重做**这一张**」；
  - 成本：一次 1 张（最多 2 张），打回只重做当前这一张，不重做整批。
- **实现**（`web/src/screens/create.js`，纯前端）：
  - 第③步「图片审核」从占位说明改成真实审核页：大图（max-h 380px）+ 尺寸/模型 + 两个按钮
    「通过，进入运镜」（→ 第④步）与「打回重做（只重做这一张）」（→ 再调 1 次 `/api/images/generate`）；
  - 无图时给「生成 1 张」入口；重做时先清旧图、出新图后替换；
  - 第②步提示改为「生成后点下一步，第③步可以放大看并决定通过/打回」。
  - **不改任务状态机、不新增 API、不把图片并入任务**（图片仅用于人工确认）。
- **验收**：新增 `scripts/verify-image-review.js`（17 项，已注册 fast 组）→ **17/0**，含离线跑真实 `create.js`：
  点 1 次只调 1 次出图；第②步能看到图；第③步能看到**同一张**图 + 尺寸；打回后只再调 1 次且旧图被替换；
  点「通过」进入第④步运镜。
- **图片地址说明（回答「下一步能不能看到」）**：服务端把图存进 `config.STORAGE.clipsDir`，
  返回 `url: '/clips/<文件名>'`；`/clips` 是不拦登录的静态目录，所以页面 `<img>` 直接可见。
  想要「带时效的签名地址」是另一件事，未做。

### 配乐上传（2026-11-10）

- **改前事实**：`audioMixer.addTrack` 其实已支持 `fileData`(base64) 落盘到 `assets/bgm/custom/` 并登记 manifest，
  但**前端没有入口**（配乐页只能填元信息、提示手工放 mp3），后端也**没有任何大小/内容校验**
  （非法后缀会被回退成 `.mp3` 落盘，乱填 base64 会写出 0 字节文件）。
- **后端**（`src/processors/audioMixer.js` + `server.js`）：
  - `BGM_DIR` 支持环境覆盖（测试隔离；默认仍 `assets/bgm`）；
  - 白名单后缀（有后缀但不在 mp3/wav/m4a/ogg → 400）；
  - base64 解码为空 → 400；>20MB → `TOO_LARGE` → **HTTP 413**；文件头校验（RIFF/ID3/0xFF/ftyp/OggS）拒收非音频。
- **前端**（`web/src/screens/inventory.js`）：配乐页新增「＋ 上传音频」（`accept=.mp3,.wav,.m4a,.ogg,audio/*`），
  `FileReader.readAsDataURL` + `<audio>` 读时长（拿不到就 0，不阻塞），上传后自动刷新列表；
  超过 20MB 在前端先拦。
- **验收**：新增 `scripts/verify-bgm-upload.js`（23 项，已注册 real 组）→ **23/0**：
  真传 1s wav（ffmpeg 生成）→ 文件字节数一致、manifest 写入、API 可查；同名再传新 id；
  非法后缀/非法 base64/缺文件/20MB+ 四类负向。
- **污染事故（已处理）**：第一次跑测试时 `BGM_DIR` 覆盖还没实现，测试把 5 个文件写进了**真实**
  `assets/bgm/custom/` 并改了真实 manifest（其中一个是 20MB 大文件）。已逐个删除并把
  `assets/bgm/manifest.json` 用 `git checkout` 还原（现为 12 首，`git status` 干净），随后才加 `BGM_DIR` 覆盖；
  重跑测试 `assets/bgm/custom` 文件数 = 0，零污染。
- **注意**：`server.js` / `src/processors/audioMixer.js` 改了，**运行中的服务需重启**才对上传生效。

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

---

## 交接断点（2026-11-09 18:20，窗口切换前）

### 当前事实

- **3001 当前未运行**：本会话启动的 `node server.js` 子进程在工具调用结束后被 DSH 回收。请人工双击
  `C:\Users\14872\Desktop\测试\重启服务.bat`（UAC 同意），它会结束旧进程、启动新服务、打开 `/app`
  并自动跑 `check-server-version.js`。
- **代码未提交**；本轮改动尚未 commit。
- **工作区有另一个会话的改动**：`web/src/components/assistant.js`（已修改）、`assistantOrb.js`（未跟踪）、
  `web/verify/`（未跟踪截图）。**不要 `git add -A`**，不要覆盖/提交它们。
- 刚跑过的证据：`node scripts/verify-image-gen.js` → **100 通过 / 0 失败**；
  `node scripts/check-server-version.js` → **exit 2（服务未运行）**，符合当前事实。

### 本轮已完成（代码已落盘，未提交）

- `wan2.7-image` 适配器、运行时 Key/Base URL/模型/尺寸、设置页「测试连接」、眼睛显示、Seedance/可灵折叠。
- `GET /api/status` 增加 `serverInfo` 与 `imageGen` 探针；`scripts/check-server-version.js`。
- `GET /` → 302 `/app`；`web/src/app.js` 旧服务端底部警告；设置页「未知的类型」追加重启提示。
- 文档：`AGENTS.md` 第 14 条（前后端版本错位）、单一前端规则；`PROGRESS/FEATURES/changelog` 已更新。

### 断点五要素

1. **任务目标 + 验收**：把旧版 4 组能力搬到新版，然后只保留一个可维护前端：
   - 新版创作页读取 `vs_web_config` 的模型/分辨率/档位，并可在页面上选择；
   - 多提示词批量（旧版「一行一个场景」）；
   - 余额 + 生成前费用预估/超额拦截；
   - 自定义执行环节 + 质检严格度；
   - `public/index.html` 移到 `legacy/`，更新 5 个脚本 + `_selftest.html`，删除 `public/index.html`，
     `/` 与 `/index.html` 都 302 到 `/app`。
2. **已改文件**：本轮图片/单版本相关文件见 `git status`；**不要提交** `assistant.js` / `assistantOrb.js` / `web/verify/` / `data/logs/console-3001.log.err`。
3. **测试状态**：`verify-image-gen.js` 100/0；`check-server-version.js` exit 2（服务未运行）；`verify-all.js` 本机 EPERM，不可用。
4. **下一步第一个动作**：打开 `web/src/screens/create.js`，把 `useState` 里的
   `model:'seedance' / resolution:'1080p' / preset:'final'` 改为从 `localStorage.vs_web_config` 初始化，
   并在「确认」前增加模型/分辨率/档位三个控件；先补一条静态断言再改代码。
5. **需要拍板**：无（用户已选「全部补 + 旧文件移 legacy」）；WhaleTV 的 Base URL/协议仍需用户提供，
   不阻塞前面 5 项。

### 建议顺序

1. 修 `create.js` 的模型/分辨率/档位（最高优先，直接决定万相 Key 是否被用上）。
2. 多提示词批量。
3. 余额/费用预估。
4. 自定义环节 + 质检严格度。
5. 旧版 `index.html` 移 `legacy/`、改 5 个测试与 `_selftest.html`、删除 `public/index.html`。
6. 启动服务，验证 `/` 302、`/app` 200、`check-server-version.js` exit 0。
7. 需要 WhaleTV 的 Base URL 后再做真实出图。
