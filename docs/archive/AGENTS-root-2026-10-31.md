# AGENTS.md — 三方共同契约（产品 / UI / 研发）

> **这份文件是契约，不是文档。**
> 工作区里所有 AI Agent（以及人）在动手前读它，动手后按它交付。
> 它只写「事实」和「约束」：真实路径、真实命令、谁可以改哪里、哪些做法永远不允许。
>
> 最后实测：2026-10-31。**凡本文件与仓库现状不符，以仓库现状为准，并立即修订本文件。**

---

## 0. 工作区地图（先看这一张图）

```
C:\Users\14872\Desktop\测试\          ← 工作区根（多角色共享，不是 git 仓库）
├── AGENTS.md                         ← 本文件（唯一契约）
├── app\                              ← 真正的代码仓库（git 在这里，.git 在 app\ 下）
│   ├── .git\
│   ├── server.js  config.js  package.json
│   ├── src\       后端逻辑（研发）
│   ├── public\    旧版前端（单文件；2026-10-30 起冻结，只修 bug、不加功能）
│   ├── web\       新版前端（React 18 UMD + htm，零构建、零 npm；新功能只进这里）
│   ├── scripts\   运维/迁移脚本（研发）
│   ├── tools\ffmpeg\   项目自带 ffmpeg（二进制不入库）
│   ├── assets\bgm\     配乐素材
│   ├── clips\ output\ data\tasks\   运行时产物（不入库）
│   ├── spec\ docs\     app 内部的历史设计与部署文档（只读存档）
│   └── README.md
├── docs\      产品文档（requirements / spec / milestones / 各类分析报告）
├── design\    视觉与交互设计（references / ui-ux）
└── *-dev-spec\  usage-guide\  future-roadmap\  …   ← 历史产物，见 §7
```

**第一条规矩：`git` 只在 `app\` 里有效。** 根目录不是仓库，`git -C "…\测试" status` 会报
`fatal: not a git repository`。所有 git 命令都要带 `-C app` 或先 `cd app`。

---

## 1. 项目定位（一句话）

> **输入提示词 → 自动分镜 → 批量生成片段 → 质检 → 拼接 → 配乐 → 转码导出**，产出适合 **Android TV 屏保循环播放**的长视频成片。

目标用户：1–2 人的内容制作团队。主题以自然风景、户外、宇宙、极光为主。成片 30 分钟以上或可循环播放、头尾衔接自然。详见 `docs/requirements/项目需求申报表.md`。

---

## 2. 真实路径与命令（已实测，不要猜）

### 2.1 启动

```powershell
cd "C:\Users\14872\Desktop\测试\app"
node server.js            # 等价于 npm start / npm run dev（package.json 里都是 node server.js）
```

- 端口：**3001**（`config.SERVER.port`，取值顺序：环境变量 `PORT` > `app/.env` 的 `PORT` > 默认 3001；云平台会注入 `PORT` 覆盖）
- 访问：`http://localhost:3001`
- 一致性约束：`app/.env` 的 `PORT`、`config.js` 的默认值、`启动.bat` / `启动.ps1` 里硬编码的端口、本节说明，**四处必须相同**。改任一处就要同步其余三处，否则会出现「服务在 A 端口、脚本打开 B 端口」的空页面。
- 启动时终端会打印两行关键信息，可用来确认环境正常：
  ```
  FFmpeg 可用: true
  FFmpeg 路径: C:\...\测试\app\tools\ffmpeg\bin\ffmpeg.exe
  ```
  （由 `src/videoProcessor.js` 在构造时打印）
- 端口被占用就换 `PORT=3002 node server.js`（临时换端口只用于排查），**不要去杀别人的进程**。

### 2.2 技术栈（实测）

| 项 | 事实 |
|---|---|
| 运行时 | Node.js（实测 v24.21.0） |
| 后端 | Node.js + Express 4 + `ws` + 原生 `http` |
| 前端 | **两套并存**：① 旧版 `public/index.html`（约 289 KB 单文件，2026-10-31 实测，**已冻结**）；② 新版 `app/web/`（React，浏览器原生 ES Module，入口 `web/src/app.js`，9 个 src 文件） |
| 构建 | **无构建步骤**：没有 webpack/vite/rollup，没有 `npm run build`，改完 F5 即可。Tailwind CLI 仅用于生成 `web/styles/app.css`，是可选步骤，不参与运行时 |
| 框架 | 旧版**无框架**；新版 **React 18.3.1（UMD vendor 静态文件）+ htm**，不用 JSX 编译。**无 TypeScript**，全部 `.js` |
| 依赖 | 见 `app/package.json`：`express`、`ws`、`pg`（可选，仅 postgres 驱动用）、`@aws-sdk/client-s3`（S3 存储用）。**没有 dotenv**——`.env` 由 `config.js` 里的 30 行自制加载器读取 |
| 启动脚本 | `启动.bat` / `启动.ps1` / `start_server.vbs`（Windows 便捷入口，内部仍是 `node server.js`） |

> **技术栈变更决定（2026-10-26 拍板；2026-10-28 修订）**
>
> 目标仍是把前端从「单文件原生」迁到 React，但**实现方案已改**：
> 本机**没有 npm/npx**，无法装 Vite 与 React 包，故改用
> **React 18 UMD + htm + 浏览器原生 ES Module + vendor 静态文件**（React/htm 已入库到 `app/web/vendor/`），
> **不引入 Vite、不引入构建步骤**。Tailwind 用独立 CLI 生成 CSS，属可选。
> 落地位置：`app/web/`，访问 `http://localhost:3001/app`。
> 上表已按 2026-10-31 的仓库现状改写为**两套前端并存**的事实。
> **旧版 `public/index.html` 已冻结**：只修 bug，不再加功能。
> **新功能一律进 `app/web/`**；`/app` 与 `/` 由同一个 `node server.js` 提供，没有第二个端口。
>
> 已经实测到的迁移代价（不是猜测，见 `docs/spec/changelog.md`「前端技术栈迁移」）：
>
> - `app/server.js:226` 用 `express.static(path.join(__dirname,'public'))` 下发页面，需改为下发构建产物
> - **5 个 Node 脚本 + 1 个浏览器页静态解析 `public/index.html`**：
>   `check-inline-js.js`、`verify-frontend-static.js`（43 项）、`verify-recovery-fixes.js`、
>   `verify-transition-ui.js`（19 项）、`verify-skill-prompt.js`（6 项），以及 `public/_selftest.html`（§2.6 的自检入口）
>   —— 迁移后这些断言会失效，必须同步重写，不能删了了事
> - **更正（2026-10-26）**：`verify-frontend-contract.js`（49 项）**不读** `index.html`，
>   它是起真实服务逐条打 API 的契约测试，迁移后**原样可用**。此前本文把它错列为受害者。
> - **门禁有洞**：`verify-all.js` 注册 18 个套件，而 `scripts/` 下实有 **35 个** `verify-*.js`（2026-10-31 实测），
>   上述静态脚本**只有 2 个在门禁内**（frontend-static、skill-prompt）；
>   `check-inline-js` / `verify-recovery-fixes` / `verify-transition-ui` 弄坏了 `npm run verify` 照样全绿
> - `package.json` 无 build 脚本、无前端依赖，需新增并补 `docs/spec/changelog.md` 记录（§4.6）
> - 曾计划的 Vite dev server **不引入**（本机无 npm），因此不产生"两个端口"问题；
>   例外：Tailwind CLI 若手动重生成 CSS，需在 `app/` 下执行，产物写回 `web/styles/app.css`

### 2.3 ffmpeg / ffprobe

```powershell
# 项目自带（Windows x64 静态构建，ffmpeg 8.1-full_build / ffprobe 8.1）
app\tools\ffmpeg\bin\ffmpeg.exe
app\tools\ffmpeg\bin\ffprobe.exe
app\tools\ffmpeg\bin\ffplay.exe    # 仅手动调试用
```

**解析优先级**（`app\config.js` 的 `resolveBundled()`）：

1. `.env` 里显式配置的 `FFMPEG_PATH` / `FFPROBE_PATH`
2. 项目内 `app\tools\ffmpeg\bin\`
3. 系统 PATH（Linux 容器走这条，Dockerfile 即如此）

**硬性要求：**

- **绝不硬编码 ffmpeg 绝对路径**。要用就读 `config.js` 导出的 `config.FFMPEG_PATH` / `config.FFPROBE_PATH`，或 `require('../src/videoProcessor')` 的 `hasFFmpeg` 判断。
- 二进制约 640 MB，已在 `app/.gitignore` 排除。新机器按 `app/tools/ffmpeg/README.md` 恢复。
- 许可证：gyan.dev **full build，GPL v3**。内部使用无影响；对外分发产品前必须评估（见该 README）。
- 调用方式注意（**2026-10-19 实测修正**）：早前本节写「本环境里 `stdio:'pipe'` 会返回 EPERM」，
  实测并非一律如此——`execSync(cmd, { stdio: 'pipe' })` 在 `extractFrame` / `transcode` /
  `concatenate` 中均**正常工作**（各自实测通过）。
  真正踩到 EPERM 的是**需要捕获 stdout 文本**的调用（如 `getVideoInfo` 的
  `execSync(cmd, { encoding: 'utf8' })`），现象为 `spawnSync C:\Windows\system32\cmd.exe EPERM`。
  因此：**要读 stdout 的 ffmpeg/ffprobe 调用**请走 `qualityChecker._exec()` 或
  `videoProcessor._execText()`（两者都内置「落临时文件再读」降级）；只执行不读输出的可以照常用 `stdio:'pipe'`。

### 2.4 数据库 / 存储（由 `DATABASE_TYPE` 驱动）

`app\src\storage\index.js` 按 `config.DATABASE_TYPE` 选驱动：

| `DATABASE_TYPE` | 驱动 | 落地 | 说明 |
|---|---|---|---|
| 空 或 `json` | `drivers/jsonfile.js` | `app/data/tasks/*.json` | 默认，零依赖 |
| `postgres` / `postgresql` | `drivers/postgres.js` | `DATABASE_URL` | 需 `pg`，可指向 Supabase / Neon / 自建 |
| `sqlite` | `drivers/sqlite.js` | 单文件 | 轻量部署 |

业务代码**只 require `src/storage/index.js`**，不直接碰驱动。
建表脚本：`app/src/storage/schema.sql`、根目录 `建表脚本-复制这个.sql`。
对象存储（视频大文件）另由 `STORAGE_DRIVER`（`supabase` / `s3` / 空=本地）控制，实现见 `src/storage/objectStore.js`。

### 2.5 其它实用命令

```powershell
cd app
npm run db:migrate      # node scripts/migrate-to-db.js
npm run upload:videos   # node scripts/upload-videos.js
npm run upload:dry      # 同上，只演练不上传
node -e "console.log(require('./config').FFMPEG_PATH)"   # 确认 ffmpeg 解析结果
```

### 2.6 验收（回归必跑）

改完后端/前端后，**先跑验收再交付**。统一入口：

```powershell
cd app
node scripts/verify-all.js          # 注册表内的 18 个脚本（scripts 下实有 35 个 verify-*.js）
node scripts/verify-all.js --fast   # 只跑纯逻辑/静态组（约 10 秒）
node scripts/verify-all.js --only auth,loop,stages
```

也可用 npm 别名：`npm run verify` / `verify:fast` / `verify:frontend` / `verify:loop` / `verify:stages`。

**退出码 0 = 全过；非 0 表示有失败，输出会列出脚本名与失败项。**

> **前台可能跑不了（2026-10-31 实测）**：某些会话里 Node 子进程 `spawn` 一律 EPERM
> （`execFileSync(node, ['-v'])` 都失败），`verify-all.js` 会在内部 `execFile` 处崩。
> 此时改为**后台 job 逐个套件跑**再回收输出；这是被认可的替代方式，不算"没跑门禁"。

浏览器不可用时的前端自检：启动服务后打开
`http://localhost:3001/_selftest.html`，它会自动检查档位/补跑/质检字段/DOM 元素并逐条显示结果。
**注意它只证明接口与元素正确，证明不了布局、样式与点击手感。**

### 2.7 登录墙（2026-10-20 起）

页面与 `/api/*` 默认需要登录；`/output`、`/clips`、`/bgm` 三个媒体静态目录**不拦**。
新版前端挂在 `/app`（SPA），同样受登录墙约束：`/app` 与其非静态子路径按"页面"处理，
`/app/vendor|src|styles|assets` 按静态资源处理（`server.js` 里的 `SPA_ASSET` 判定）。
（公网部署时必须补，否则成片可被直接下载）。

- **首次启动**：库里没有账号时，用 `.env` 的 `AUTH_USER` / `AUTH_PASSWORD` 建第一个；
  缺密码则随机生成并**只打印一次**。账号落在 `DATABASE_TYPE` 对应的存储里，之后以库里为准。
- **会话**：会话级 cookie（刻意无 `Max-Age`，关浏览器即失效）+ 内存会话表（`AUTH_SESSION_HOURS`，默认 8 小时兜底）。
  **服务重启 = 全体登出**。
- **防爆破**：同一 IP 连续 5 次失败锁 5 分钟（内存，重启清零）。
- **`AUTH_ENABLED=false` 会完全关闭登录墙**，只用于跑验收脚本，不要长期关闭。
- 成员管理页：`http://localhost:3001/members.html`（无管理员/普通成员分级，所有账号平权）。
- 相关验收：`node scripts/verify-auth.js`（40 项，含负向：篡改 cookie / 错误密码 / 失败锁定 / WS 握手）。
- 需求背景与决策记录见 `docs/spec/changelog.md` 的「登录墙」一节。

---

## 3. 目录归属：谁写、谁只读

**规则只有一条：只写自己那一列标「写」的路径；其余一律只读。要改别人的地盘，先发消息给对方，由对方改。**

| 路径 | 内容 | 产品 | UI | 研发 | 备注 |
|---|---|:--:|:--:|:--:|---|
| `AGENTS.md`（根） | 本契约 | 写 | 写 | 写 | 改契约需三方知会 |
| `app/src/**` | 后端：pipeline / qualityChecker / videoProcessor / taskManager / promptOptimizer / wsManager / generators / processors / storage / utils | 只读 | **只读** | **写** | 产品与 UI 一律不改后端 |
| `app/public/**` | **旧版**前端：`index.html`（289 KB 单文件）等 | 只读 | **写** | 只读 | **2026-10-30 起冻结**：只修 bug，不加功能 |
| `app/web/**` | **新版**前端：React 18 UMD + htm，`src/` 9 个模块、`vendor/` 静态 React、`styles/` | 只读 | **写** | 只读 | 新功能只进这里；接口契约由研发定 |
| `app/server.js`、`app/config.js`、`app/package.json` | 服务入口 / 配置 / 依赖 | 只读 | 只读 | **写** | 改配置项必须同步 `.env.example` |
| `app/scripts/**` | 迁移、上传等运维脚本 | 只读 | 只读 | **写** | |
| `app/tools/**` | ffmpeg 与恢复说明 | 只读 | 只读 | 只读 | 只在换版本时由研发按 README 操作 |
| `app/assets/**` | BGM 等静态素材（mp3 不入库） | 只读 | 只读 | 只读 | 新增素材需先说来源与授权 |
| `app/spec/**`、`app/docs/**` | app 内部的早期设计与部署文档 | 只读 | 只读 | 只读 | **历史存档**，新文档写到根 `docs/` |
| `docs/requirements/**` | 需求申报表、需求变更 | **写** | 只读 | 只读 | 需求的唯一权威来源 |
| `docs/spec/**` | 规格、技术约定、`changelog.md` | **写** | 只读 | **写** | 双方共写，**按小节追加，不改别人已写内容** |
| `docs/milestones/**` | 里程碑、版本计划、迭代记录 | **写** | 只读 | 只读 | |
| `docs/` 其余子目录（分析报告 HTML） | 调研/分析产物 | **写** | 只读 | 只读 | 沿用现有子目录，不新建散落目录 |
| `design/ui-ux/**` | 界面设计、组件规范、线框、DESIGN.md | 只读 | **写** | 只读 | UI 的单向输出口 |
| `design/references/**` | 视觉参考、早期原型 | 只读 | 只读 | 只读 | 存档，不维护 |
| `app/output/**`、`app/clips/**`、`app/data/tasks/**`、`app/data/trash/**` | 运行时产物（成片 / 片段 / 任务 JSON / 回收站） | 只读 | 只读 | 只读 | **不入库、不手改**；清理见 §4.7 |
| `app/node_modules/**` | 依赖 | 只读 | 只读 | 只读 | 只通过 `npm install` 变更 |

**跨角色的接口只有两个方向：**

- 研发 → UI：后端路由与 WebSocket 事件（`server.js` + `src/wsManager.js`）。UI 需要的字段，由研发先落到契约。
- UI → 研发：页面需要的交互与状态。改 `public/` 时**不得**顺手改 `src/`。

---

## 4. 红线（禁止事项，违反即返工）

### 4.1 质检语义：`skipped` 永远不等于 `passed`

质检项「没跑起来」就是**没通过**。只有业务上本就不适用的情况（例如未配乐成片没有音频流）才允许
`legitimateSkip: true`，且必须写明理由——这是唯一合法的跳过类型。

现状（`src/qualityChecker.js` `checkClip`/`checkFinal` 汇总逻辑）：
`failedItems` 与 `notRunItems` 都必须为空才算通过；`_mockCheck` 显式返回「未执行」而不是随机通过。
**不要把这些改回去，也不要在新加检测项时复制旧的 `passed || skipped` 写法。**

背景与原委：**`docs/spec/changelog.md`**（含故障复现、修复对照表、正/负向验证数据）。改质检前必读，此处不重复。

### 4.2 禁止用随机数冒充检测结论

`Math.random()` 只能用于生成 ID、打乱提示词素材、随机选 BGM 这类**非判定性**用途。
任何质检、合规、可循环性、画质结论都必须是实测值。
（历史事故：`_mockCheck` 曾用 `Math.random() > 0.1` 随机判通过，见 changelog。）

### 4.3 禁止把 ffmpeg 退出码 0 当作成功

`ffmpeg -c copy` 拼接触发输入损坏时会**静默只拼出前几段，退出码仍是 0**。
判成功必须附加实测：拼接产物时长 ≈ 各输入时长之和（容差 ±max(0.5s, 2%)），
实现即 `videoProcessor._validateConcatDuration()`。
探测不到时长 = **不可判定**（`{ok:false, undetermined:true}`），**不许**当成通过。

### 4.4 改动代码前先看清楚工作区

```powershell
git -C app status --short
git -C app diff --stat
git -C app diff -- <要改的文件>
```

**不许覆盖别人未提交的改动。** 2026-10-20 已把当时在途的 5477 行改动落成基线
（`94383ad` chore → `2310a33` test 脚本 → `2e9cfe7` feat，三条各自独立可回滚），
此后工作区默认为干净；但**随时可能再出现未提交改动，改前仍必须先 `git -C app status`**。
判据：`git -C app status --porcelain` 有输出 = 有人的改动还没落盘。

另外注意（2026-10-20 修正）：**源文件实际全是 UTF-8（无 BOM）**，不是 GBK。
此前本节写「多数源文件是 GBK 编码」是错的——误导来源是 PowerShell 的 `Get-Content`
默认按系统 ANSI(GBK) 解码 UTF-8 文件，于是中文显示成 `鐢熸垚杩涘害` 这类乱码。
判据：用 `read` 工具、或 `Get-Content -Encoding UTF8` 读，中文正常就是 UTF-8。

仍然**不要用会重写编码的批量脚本**（例如不带 `-Encoding UTF8` 的整文件 `Set-Content`），
否则会把文件写成 GBK，中文注释在 UTF-8 工具眼里立刻变乱码并污染 diff。

### 4.5 `src/qualityChecker.js` 禁止整文件覆盖写

它是改动最集中的文件（实测 35 KB，历史单次改动 +297 行），多人同时改的概率最高。
**只能增量 `edit`（精确替换某一段），不许 `write` 整文件重写。** 同理适用于 `src/pipeline.js`、`server.js`。

### 4.6 不引入新依赖不说明理由

依赖极简是刻意设计（连 dotenv 都没引入）。
新增 npm 包必须在 `docs/spec/changelog.md` 记一条：为什么自研不行、包体积、许可证、是否有维护风险。
改 `package.json` 必须同步 `package-lock.json` / `pnpm-lock.yaml` 的合理状态，并说明用的是哪个包管理器。

### 4.7 涉及覆盖 `app/output/` 成片的操作，先在副本上验证

`app/output/` 里是已经跑出来的成片，重跑一次通常要几十分钟生成成本。
任何会写入/覆盖成片的操作（重新拼接、重新配乐、重新转码、修 bug 后重跑），
**先 `Copy-Item` 到临时目录或 `output/verify_*` 下跑通，再动正式产物。**
批量清理 `output/`、`clips/`、`data/tasks/` 前先列出清单并征得确认，删除用回收站式思路（`data/trash/`）。

### 4.8 不许谎报状态

不允许写「已修复 / 已验证 / 应该可以了」而没有证据（见 §5）。
不允许把 Mock 产物、文本占位文件当视频交付（`videoProcessor` 的 `_mock*` 系列只在无 ffmpeg 时触发，当前环境 ffmpeg 可用，**不应出现**）。

---

## 5. 验收标准（谁来判「完成」）

### 5.1 通用

1. **凡涉及视频产物的验收，必须给 ffprobe / volumedetect 实测数值，不接受文字结论。**
   至少覆盖：容器时长、分辨率、帧率、视频/音频流是否存在、音频峰值与均值。
2. 给出**可复述的命令**，让别人能自己跑一遍得到同样数字。
3. 缺陷类修复必须给**负向证据**（故意构造坏输入，证明能抓到 fail），只给正向证据不算验完。
4. 结论要区分三态：**通过 / 不通过 / 未验证**。不允许把「未验证」写成「通过」。

### 5.2 验收命令模板（可直接抄）

```powershell
$FF   = "C:\Users\14872\Desktop\测试\app\tools\ffmpeg\bin\ffmpeg.exe"
$FP   = "C:\Users\14872\Desktop\测试\app\tools\ffmpeg\bin\ffprobe.exe"
$VID  = "<成片路径>"

# 时长 / 分辨率 / 帧率 / 码率 / 流清单
& $FP -v error -show_entries format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,duration -of json $VID

# 音频电平（必须有 audio 流；未配乐任务属于合法跳过）
& $FF -hide_banner -i $VID -af volumedetect -f null - 2>&1 | Select-String "mean_volume|max_volume"

# 黑帧
& $FF -hide_banner -i $VID -vf blackdetect=d=0.5:pix_th=0.95 -an -f null - 2>&1 | Select-String "black_start"

# 容器是否可完整解码（截断的 copy 拼接会在这里露馅）
& $FF -v error -i $VID -f null -
```

### 5.3 质检语义的权威定义

**质检「通过 / 不通过 / 未执行 / 合法跳过」的语义，以 `docs/spec/changelog.md` 为准，本文件不复述。**
凡对质检结论有疑问、或要修改质检逻辑，先去读它；有新的语义约定，就**追加**到那份 changelog 里。

### 5.4 分角色验收口径

| 角色 | 交付物 | 验收方式 |
|---|---|---|
| 产品 | 需求 / 规格 / 里程碑 | 条目可被研发逐条映射到代码位置；改需求必须写进 `docs/requirements/` 并标注影响范围 |
| UI | 页面 / 组件规范 / DESIGN.md | 在浏览器里实际操作一遍主流程（输入提示词 → 生成 → 预览 → 导出）截图或录屏；设计 token 与 `design-system-notion-apple.html` 一致 |
| 研发 | 后端改动 | §5.1 + §5.2 的实测数值；改动点定位到 文件:行 |

---

## 6. 当前已知缺口（不要当成已完成）

来自 `docs/spec/changelog.md` 的「尚未修复」小节（阅读时以那份文件为准，本节只做提醒）：

| 缺口 | 位置 | 影响 |
|---|---|---|
| 前端 UI 未在真实浏览器验证 | `public/index.html` | 档位选择 / 补跑按钮 / 质检角标已实现并通过静态校验（43 项）+ 端到端 API 验证，但**本环境 Electron 未安装、`dsh_browser_*` 不可用**，布局/样式/交互手感**未经人工过一遍**（§5.4 要求） |
| `#genStatusDot` 元素缺失 | `public/index.html` | CSS 与 7 处 JS 引用都在，但 HTML 没定义该元素（既有问题，非本次引入）。副作用：侧边栏「生成中」状态点不显示。6 处引用有 `if (dot)` 保护，1 处是死变量，不会抛错 |
| ~~暂停 UI 未接线~~（2026-10-31 已关闭） | `app/web/src/components/pauseControl.js` | 新版已接：任务行 / 详情抽屉 / 顶栏任务条三处可暂停继续；`statusMeta()` 支持 `paused` 与 `failureCode=pause_timeout/pause_interrupted`（显示「已中止 · 可补跑」而非普通失败红字）。**视觉未在浏览器验证** |
| ~~新版样式与新设计稿不一致~~（2026-10-31 已关闭） | `app/web/**` | 已落进代码：深绿黑 + 香槟金主题（`styles/src.css` 的 token + `tailwind.config.js` 的 rgb 通道变量）、左侧四段导航（`screens/shell.js`）、六步创作向导（`screens/create.js`）、生成中页（`screens/gen.js`）、库存三页（`screens/inventory.js`）、历史+垃圾箱（`screens/history.js`）、模板库（`screens/templates.js`）、设置整页（`screens/settingsPage.js`）。**视觉未在浏览器验证** |
| **配乐无文件上传通道** | `server.js` `POST /api/bgm` | 该接口只收 JSON 元信息，没有 multipart/文件落盘；mp3 必须手工放进 `app/assets/bgm/` 再登记。前端已如实提示 |
| **两处死代码待清理** | `web/src/screens/workbench.js`、`web/src/components/settingsDrawer.js` | 改用 `screens/shell.js` 后这两个文件不再被引用（功能已被 shell/create/settingsPage 覆盖）。**删除需征得用户同意** |

**已落地（2026-10-21，不再列为缺口）：**

- **重新生成/重试不再覆盖已有片段文件**：下载路径原固定为 `clips/<taskId>_clip_<N>.mp4`，
  同一任务第 2 次尝试会直接覆盖第 1 次的付费产物；后续「重新生成」再覆盖一次。
  现统一走 `pipeline._nextClipPath()` 分配 `_vK` 后缀，旧文件保留；`regenerateClip` 另记
  `clip.previousVideoPath` 便于找回。事故：`task_mvgw4hbo_ajuc` 第一次重试的两个付费片段被覆盖。
- **真实模型缺 Key 降级 Mock 会被识别**：`createGenerator` 降级时打 `fallbackToMock/requestedModel`，
  `pipeline` 记 `task.mockFallback`，质检统一用 `_isSynthetic(task)` 判定合成素材（NSFW 合法跳过），
  不再把 ffmpeg 测试图案当真实内容检测。事故：选 `dashscope` 但无 Key，任务仍标 dashscope，
  NSFW 必然失败，用户看不出实际生成的是 Mock。
- **重启后重新生成/补跑会带当前设置**：Key 落盘会被 `redact` 清空，旧任务的 `runtimeConfig`
  重启后没有 Key。现前端 `collectTaskRuntimeConfig(model)` 把当前设置随
  `regenerate` / `continue` 请求带上，后端 `_mergeRuntimeConfig()` 只合并白名单字段到内存态
  （仍不持久化 Key）。事故：重启后点「重新生成」，日志显示 `dashscope 未配置 API Key，使用 Mock 模式`。
- **NSFW 并发错误不再串**：`_callNsfwMultimodal` 增加 per-call `errorOut`，`checkNSFW` 优先读本地错误槽，
  并发检查多个片段时 404 不会被别的调用清成「120s 内无有效响应」。
  验收脚本 `scripts/verify-recovery-fixes.js`（28 项，含覆盖保护、降级标记、配置合并、
  404/403 并发隔离、片段库补档、路由与前端接线静态断言）。
- **片段库缺档会补齐**：入库原只挂在「生成成功 / 重检转成功」两条路径上，手工恢复与补跑复用的片段
  从不入库（事故：`task_mvgw4hbo_ajuc` 两条已付费片段，文件在、成片有、片段库空）。
  现 `library.ingestMissing(task)` 由 `_runPipeline`（生成/复用后）与 `recheckClips`（开头）调用；
  `scripts/ingest-task-clips.js <taskId>` 可单独补库，`recheck-task-clips.js` 也会顺手补。
  库列表缓存已改为**目录签名失效**（文件名/大小/mtime 变化即重读），外部补库后运行中的服务
  不用重启就能看到。**仍需记住**：任务实际存在 `DATABASE_TYPE` 指定的存储里（本机 `.env` 是 postgres），
  `data/tasks/*.json` 只是本地备份，直接改 JSON 不会出现在页面上；片段库文件仍在 `app/data/library/`。

**已落地（2026-10-20，不再列为缺口）：**

- **片段缺失不再静默通过**：拼接的单片段分支原写死 `passed:true`（理由「仅有1个成功片段」），
  把「任务本来就只要 1 个片段」和「丢了一个片段」混为一谈。实测事故：2 片段任务丢了 1 个，
  流水线照样记录 `passRate:100%` + 拼接 `passed:true`，用户毫无察觉直到看到成片缺一半。
  现区分两种情形：丢片段 → `passed:false + level:'fail'` + `片段缺失：应有 N 个，实际 M 个`
  + ERROR 日志。
- **僵尸任务回收**：`pipeline.reconcileInterruptedTasks()` 在服务启动时执行。
  进程刚启动不可能有任务在跑，因此处于 `pending/generating/concatenating/looping/transcoding/mixing`
  的一律视为上次中断的残留，标记为 `failed`（**不冒充 completed**）并写明中断状态 + 已完成步骤 + 可补跑。
  实测回收了卡在 `mixing` 27 分钟的任务。
  **坑**：取任务要合并「内存 + 数据库」，只读数据库会漏掉刚创建、异步写库尚未落盘的任务。
- **终检配置透传**：三处 `checkFinal(finalPath)` 原先**不传任何 options**，终检 NSFW 永远用
  `.env` 默认值（gpt-4o-mini + 空 Key），用户填的阿里云地址 / 多模态 Key / qwen3-vl-plus 全部失效。
  实测证据：同一任务里片段级用 `qwen3-vl-plus`、`final_qc` 用 `gpt-4o-mini`。
  现统一走 `pipeline._finalQcOptions(task)`，Key 解析顺序与片段级一致。
- **日志落盘**：`server.js` 把 `console.log/warn/error` 双写到 `app/data/logs/server-YYYY-MM-DD.log`。
  终端行为不变。解决「服务跑在用户终端里、日志滚走就查不到」的问题。
  验收脚本 `scripts/verify-pipeline-fixes.js`（28 项）。
- **片段间转场（交叉淡化）**：原先片段之间只有 concat，硬切；实测接缝相邻帧 SSIM 0.238。
  现由 `src/processors/transitionMixer.js` 用 `xfade` 链做真淡化，四条拼接路径（新建 / 补跑 /
  片段库 / 重建母版）全部接入；成片时长 = Σ片段 − (N−1)×F。
  **默认开启（2026-10-27 起，可关闭；`quick` 档仍直拼）**：
  - 默认值 `TRANSITION_ENABLED=true`、`TRANSITION_DURATION=0.4`（见 `config.js` 的 `TRANSITIONS`）；
  - **用户可取消**：页面勾选框默认勾选，取消后该任务传 `transition:{enabled:false}`，
    `pipeline._transitionOptions()` 优先取任务参数 → 回到 `-c copy` 直拼（不重编码、时长 = Σ片段）。
    实测证据（`verify-seam-qc.js` [8]）：off=6.02s vs on=5.60s（2 段×3s，fade 0.4s）；
  - **`quick` 档不受此开关影响**，一律 `-c copy`（`disabledByPreset:'quick'`）。
  - 为什么改默认（2026-10-27 决议）：实测转场只比「重编码直拼」贵 **1.40×**
    （47s/7 段：copy 0.46s → 重编码 8.13s → 转场 11.36s），
    真正的成本跃升是**放弃 `-c copy` 的 17.6×**；30 分钟成片推算 5.2 → 7.3 分钟。
    而收益明确：接缝相邻帧 SSIM 由 0.42~0.54 升到 0.83~0.95。依据见 `docs/spec/seam-quality-spec.md` §9。
  验收脚本 `scripts/verify-transitions.js`（36 项，真 ffmpeg）+ `scripts/verify-transition-ui.js`
  （22 项，接线与默认值一致性）+ `scripts/verify-seam-qc.js`（51 项，含转场开关 A/B 端到端）。
  **注意**：开启后拼接不再 `-c copy`，长片会明显变慢；
  且 `checkConcat` 必须传 `expectedDuration`，否则会把正确产物误判成「拼接被截断」。
- **接缝质量检测（`seam` 质检项，2026-10-27）**：此前 11 项质检**没有一项读画面判断「拼接是否自然」**
  （`checkConcat` 只校验时长防截断，`checkLoop` 只测成片首尾），于是硬切成片也全部「质检通过」。
  现新增 `qualityChecker.checkSeam(videoPath, clipDurations, options)`：逐缝测
  SSIM / ΔE76（CIELAB 色差）/ ΔY / 像素级 MAD 倍数，三态语义严格按 §4.1
  （测不到 = `passed:false`；唯一合法跳过 = 仅 1 个片段，带 `legitimateSkip:true`；
  合成素材按 `_isSynthetic` 合法跳过）。接入点是 `checkFinal`，三处调用共用
  `pipeline._finalQcOptions()` → `_seamQcOptions()`（用拼接步骤的**实际转场留痕**算缝位置）。
  阈值可用 `QC_SEAM_SSIM_MIN` / `QC_SEAM_DE76_MAX` / `QC_SEAM_DY_MAX` /
  `QC_SEAM_MAD_RATIO_MAX` / `QC_SEAM_MAX_SEAMS` 覆盖。
  验收脚本 `scripts/verify-seam-qc.js`（51 项，含坏缝负向用例与真实成片用例）。
  诊断报告与实测数据见 `docs/spec/seam-quality-spec.md`。

**已落地（2026-10-19，不再列为缺口）：**

- **无缝循环（真交叉淡化）**：`videoProcessor._makeLoopFFmpeg` 已改为 `xfade` 实现
  （`[main]=[0,D-F)` + `[head]=[0,F)` + `xfade offset=D-2F`，音频走 `atrim`+`afade` 进 filter_complex）。
  淡化时长读 `LOOP_FADE_DURATION`（默认 0.5s），成片 = 源时长 − F。新建路径与改配乐重建路径
  均读同一配置。**不再有 `copyFileSync` 兜底**，失败即 `success:false`。
  实测（35s 样片）：产物 34.500s，回绕 SSIM 0.5002 → **0.9495**。
- **循环质检（去假通过）**：`qualityChecker.checkLoop` 原先无条件 `return {passed:true, mock:true}`，
  现改为实测「产物末尾 vs 开头」SSIM（阈值 `QC_LOOP_SSIM_THRESHOLD`，默认 0.9）
  + 源素材基线对照 + 时长核验。尾帧抽在 `d-0.05s`（贴末尾，落在淡化融合最深处）。
  三态：不可测一律 `passed:false`。
  验收脚本 `scripts/verify-loop.js`（29 项，含 5 类负向 + 双路径一致性；2026-10-27 修掉了「基线恒为 1 导致相对断言永不可判」的假绿问题，并新增「时长正确但回绕不自然」的隔离负向用例）。
  **注意**：时长容差已收紧为 `max(0.05, min(F/3, expected*1%))`——旧口径 `max(0.5, 2%)`
  会放过「淡化没发生」的 0.5s 偏差。
- **重建母版路径补齐循环**：`pipeline._buildMasterFromClips` 原只做「拼接→转码」，跳过循环，
  导致重建母版比新建母版长一个淡化时长（实测 21.037s vs 20.533s，差 0.504s）。
  已补上 `makeSeamlessLoop`（同源配置），循环失败**不回退直通**。
- **Mock 模式不再绕过视觉质检**：`pipeline.js` 片段循环原对 Mock 直接返回
  `{passed:true, skipped:true}`，被下游放行（skipped 冒充 passed）。
  现拆成两件事：**NSFW 合规检测在 Mock 下照常执行**（并加存在性断言，`details.nsfw` 缺失即 fail）；
  内容匹配对合成画面属**合法跳过**（`passed:false` + `legitimateSkip:true` + 理由）。
  验收脚本 `scripts/verify-mock-vqc.js`（14 项）。
  **注意**：不可把 `skipped` 一律判 fail——`checkContentMatch` 无多模态 Key 时返回
  `{passed:true, skipped:true}`，一律判 fail 会让「没配 Key」的真实任务全部失败（已加回归防护用例）。
- **拼接兼容音轨差异**：`videoProcessor._concatenateFFmpeg` 的重编码兜底原硬编码 `[i:v][i:a]`，
  无音轨片段直接 `matches no streams` 失败。现按三种情况分派：
  全有音轨 `concat=v=1:a=1`；全无音轨 `concat=v=1:a=0` + 只 map 视频；
  **混合**则跳过 `-c copy`（实测混合时它退出码 0、时长正确但**只剩 video 流**，音频被静默丢弃）
  并给无音轨片段补等长静音后拼接。实测混合产物：原无音轨段 -91dB（静音）、
  原有音轨段 -24.1dB（保留）。验收脚本 `scripts/verify-concat-audio.js`（17 项）。
  **注意**：`_validateConcatDuration` 只校验时长，抓不到「混合丢音频」这类损伤。
- **流水线档位（核心链必选 + 增强层可选）**：`src/pipelineStages.js` 定义 5 个档位
  （quick/daily/final/clips_only/custom）与依赖表，`pipeline._runPipeline` 已在
  拼接/循环/转码/配乐/终检五处接入判断，跳过步骤标记 `legitimateSkip` 并写明原因。
  **默认档 final = 8 步全量**，与接入前行为一致（零回归）。
  实测：quick 只跑 4 步、clips_only 只跑 3 步且 `fragmentOnly=true` 不产成片。
  验收脚本 `scripts/verify-stage-pipeline.js`（37 项，Mock 真机跑通三条任务）。
  **两个必须记住的坑**：
  1) `stageSet` 只列「要执行的步骤」，未列入的是 `undefined`，判断必须用 `=== true`
     ——写成 `!== false` 会让所有步骤都判为要执行（实测踩过：quick 档 8 步全跑）；
  2) `audio_mix` 依赖 `transcoding`（它读的是母版 `masterPath`），不是 `concatenation`。
- **补跑（`continueTask`）**：`pipeline.continueTask(taskId,{preset})` + `POST /api/tasks/:id/continue`
  （预览用 `GET .../continue-plan`）。已完成步骤自动复用：`_batchGenerate` 按片段粒度跳过
  「success 且文件仍在」的片段，拼接/循环/转码/配乐各自检查 `<taskId>_*.mp4` 是否存在。
  实测：quick 跑完再补 final → 片段 `reused`、**文件 mtime 未变**、只跑循环/转码/配乐/终检。
  验收脚本 `scripts/verify-continue.js`（19 项，真机）。
  **三个真机才暴露的坑**：
  1) 补跑时 `concatenation` 也不在 `stageSet`（要复用），会被「片段包分支」误拦并直接 return
     ——必须先判断有无可复用产物；
  2) 补跑必须把任务状态从 `completed` 切回 `pending`，否则外部轮询立即返回、看似没生效；
  3) 核心链 3 步「必选」≠「每次重跑」，不加片段复用会把整批片段重新生成（白花钱）。
- **质检可信度暴露到 API**：`GET /api/tasks/:id` 与 `GET /api/tasks` 现在返回
  `qcVersion` / `qcTrusted` / `qcVersionSource`（+ 详情里的 `finalQC.qcLabel`）。
  `taskManager.getTask` 直读内存**不带**标注，必须由 API 层调 `storage.annotateTaskQC()`。
  `qcVersion.js` 的 `annotateTask` 修了一个误导性缺陷：任务行没有 `qcVersion` 时
  **回退到 `finalQC` 的版本**——不回退的话所有「终检真实执行过」的任务都会被标成
  `legacy_unverified`，前端角标将失去意义。回退来源记在 `qcVersionSource`（`task` / `finalQC` / `null`）。
  验收脚本 `scripts/verify-qc-annotation.js`（32 项，起临时服务实测 API）。
- **档位/补跑/质检角标的前端契约**：见 `docs/spec/frontend-integration-spec.md`。
  `POST /api/tasks` 现已接受 `preset` / `stages`（**修前解构里没有这两个字段，
  前端传了会被静默忽略、永远跑全量**——档位等于没通到 API）。
  契约一致性由 `scripts/verify-frontend-contract.js`（49 项）逐条跑真实 API 校验。
  **另修一个单片段缺陷**：单片段任务的拼接是「跳过拼接、直接用该片段」、不产出
  `_concat.mp4`，导致补跑时被判成「片段包」、下游 4 步全 skipped。
  现已在该情况下用唯一成功片段顶上。

**已落地（2026-10-18，不再列为缺口）：**

- **NSFW 检测**：`src/qualityChecker.js` 已新增 `checkNSFW()`，`QC_ITEMS` 由 10 项增至 11 项（含 `nsfw`）。
  抽帧按每分钟 1 帧、上限 30 帧；阈值读 `QC_NSFW_THRESHOLD`（默认 0.8），暴露为 `config.QC.nsfwThreshold`
  与 `config.QUALITY_CHECK.nsfwThreshold`（同源，后者保留兼容）。
  无 Key / 调用失败 / 超时 / 非 2xx / 无法解析 / 抽帧不完整 **一律判 `passed:false`**；
  返回体刻意不设 `skipped` 字段，从结构上堵死 `passed || skipped` 的放行路径。
  规格见 `docs/spec/nsfw-detection-spec.md`。
  **注意：`.env` 的 `OPENAI_API_KEY` 当前为空，因此实际检测会走「未执行→判 fail」路径，属预期行为。**

另：万相 3.0（DashScope）生成器 `src/generators/dashscope.js` 已存在，接入状态以研发结论为准。

---

## 7. 历史产物目录（不必维护）

根目录下的这些目录是**历史留档**，为当时的某次开发/汇报生成，**不是需要维护的文档源**：

| 目录 | 性质 |
|---|---|
| `bgm-feature-dev-spec/`、`bgm-full-track-dev-spec/`、`bgm-rebuild-fix-dev-spec/`、`bgm-silence-dev-task/`、`theme-entry-dev-spec/`、`theme-entry-regression-checklist/`、`wan30-dashscope-dev-spec/`、`feature-guide-and-roadmap/` | 各功能开发期的 HTML/MD 设计稿与交接说明，成对出现 `*.html` + `*.md` + `assets/` |
| `usage-guide/` | 使用说明页（HTML），面向演示 |
| `future-roadmap/` | 后续规划页（HTML），面向汇报 |
| `docs/` 里的分析报告子目录（`global-model-comparison/`、`product-spec-roadmap/`、`solution-v2-upgrade/`、`two-stage-analysis/`、`upscale-hdr-analysis/`） | 调研/汇报用 HTML 产物 |
| `app/spec/`、`app/docs/` | app 内部的早期方案与部署手册 |
| 根目录零散文件：`_o.txt`、`_out.txt`、`_will_delete.txt`、`AIX规划表-导入记录-*.md`、`赵怡涵+P40+…json`、`功能使用说明书.docx/pdf`、`后续目标.docx/pdf`、`建表脚本-复制这个.sql` | 一次性导出或临时文件 |

**规则：**

- 不要修改它们，也不要基于它们做判断——它们的结论可能已经过期。
- 需要把其中内容升级为有效文档时，**复制关键结论到 `docs/` 对应子目录**，并注明来源。
- **不要在根目录新建同类目录。** 新文档一律进 `docs/{requirements|spec|milestones}/` 或 `design/ui-ux/`。

---

## 8. 协作流程（最小可执行版）

1. **领取任务** → 读本文件 → 读任务指向的源码/文档（不要凭印象）。
2. **动手前**：`git -C app status` 看清已有改动；确认自己要写的路径在自己那一列。
3. **动手时**：只改自己的路径；需要改别人的路径 → 发消息给对方，附上「为什么、改哪里、期望结果」。
4. **交付时**：给出 文件:行 + 实测命令与数值 + 三态结论（通过/不通过/未验证）。
5. **收尾时**：把跨角色的结论写进 `docs/spec/changelog.md`（追加一节），让下一个人不必重新推理。
6. **不确定就问**，不要猜；猜错的成本远高于一次提问。

**提交信息规范：** 一次提交只做一件事。历史上曾出现「提交信息写 A、实际混了 B 和 C」导致
`git log` 不可追溯的事故（见 `docs/spec/changelog.md` 第一节）。若不可避免混合提交，
提交信息里逐条列出实际内容。
