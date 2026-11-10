# AGENTS.md — 仓库内契约（补建基线）

> 生成时间：2026-11-02 14:05（Asia/Shanghai）｜基线 commit：`1d3c693`（共 92 个提交）
> 本文件位于 **`app/`（真正的 git 仓库根）**，受版本控制。
> 仓库外还有一份 `C:\Users\14872\Desktop\测试\AGENTS.md`（40 KB，2026-10-31）：**它不在任何 git 仓库内，且已有多处与代码不符**。做仓库内的事，以本文件为准。
>
> **只写实测可验证的内容。** 标「未验证」的就是没测过；标「文档记录」的是别人写过、本次未独立复验。

---

## 0. 仓库边界（第一条规矩）

- `git` 只在 `app/` 有效。`测试\` 根目录不是仓库：`git -C "…\测试" status` → `fatal: not a git repository`。
- 根目录的 `AGENTS.md` / `PROJECT_STATE.md` / `docs/` **不在版本控制内**。单独 clone `app/` 会一并丢掉它们。
- 所以：**要进版本的文档必须写在 `app/` 下**（这就是本文件放在这里的原因）。

---

## 1. 构建与启动

| 项 | 事实 | 证据 |
|---|---|---|
| 构建步骤 | **没有**。无 webpack/vite/rollup/esbuild/tsconfig/babel 配置；`package.json` 无 `build` 脚本 | 全盘检索 0 命中；`package.json:6-17` |
| 启动 | `node server.js` | `package.json:7` |
| 端口 | **3001**（`config.SERVER.port` ← 环境变量 `PORT` > `.env` > 默认） | `config.js` SERVER 段；`.env` 实测 `PORT=3001` |
| 包管理器 | **`npm` 不存在**；`pnpm` 在 `C:\Users\14872\bin\pnpm.cmd` 但**已损坏**（`pnpm --version` → `Cannot find module …pnpm.mjs`，exit 1） | 本机实测 |
| 依赖 | 已安装（`node_modules` 91 个顶层包，含 express/ws/pg/@aws-sdk） | 本机实测 |
| 前端 | **单版本**：`/app` → `web/`（React 18 UMD + htm，16 个原生 ESM 模块，唯一维护）；`/` → 302 `/app`；**旧版页面已于 2026-11-09 全部删除**（`public/` 只剩 `login.html` 与 `assets/`，12 个旧 HTML 地址统一 302 到 `/app`） | `server.js` LOGIN→`/app`、`LEGACY_PAGES` 302、`web/src/router.js` |
| CSS | Tailwind 为**可选**离线步骤，二进制在 `.gitignore` 里（`tools/tailwind/*.exe`），需自备 | `.gitignore:52-59` |
| 运行时自检 | 启动会打印 ffmpeg 可用性与路径；`auth.bootstrap()` 建首账号；`reconcileInterruptedTasks()` 回收僵尸任务 | `server.js` 尾部 |

**因此本仓库的「构建命令」= 没有；「启动命令」= `node server.js`。**

### 1.1 产品口径（2026-11-02 用户确认）

- **成片目标：30 分钟**（Android TV 屏保循环长片）。这是 `docs/requirements/项目需求申报表.md` 的口径，优先于 `PROJECT_STATE.md` 里"10 秒成片"的旧写法。
- **单片段：5–10 秒**。做法是"小视频逐个生成 → 拼接"。
- ⚠️ **代码默认值与之不符**：`.env` `GEN_CLIP_DURATION=15`、`config.js:252` 默认 `15` 秒。是否改成 8/10 秒，待用户定；改之前不要假设默认值等于产品口径。

---

## 2. 测试

### 2.1 形态

**没有测试框架**（无 jest/vitest/mocha/tsconfig/playwright/cypress，无 `devDependencies`、无 `test` 脚本）。
测试 = **手写 Node 断言脚本**：自建 `ok()`/`assert()`，输出 `结果: N 通过 / M 失败`，失败 `process.exit(1)`。

### 2.2 命令

```powershell
cd app
node scripts/verify-all.js            # 门禁总入口（本机不可用，见 2.4）
node scripts/verify-all.js --fast     # 仅 fast 组
node scripts/verify-all.js --only auth,loop,stages

# 本机可行：逐个直接跑
node scripts/verify-stages.js
```

`package.json` 里的 `npm run verify*` 别名**全部不可用**（没有 npm）。

### 2.3 规模（实测）

| 项 | 值 |
|---|---|
| `scripts/verify-*.js` 实有 | **59**（2026-11-10 实测；删旧页面时删了 4 个只测旧页面的套件，新增 `verify-create-config` / `verify-key-guard` / `verify-image-gen-compat` / `verify-openai-video` / `verify-cost-guard`） |
| 门禁注册 | **29**（`verify-all.js` 的 `SUITES`；运行时首行打印「共 N 个脚本」） |
| 未注册 | **30**（59 − 29；含 `verify-seam-qc`、`verify-transitions`、`verify-color-match`、`verify-color-continuity`、`verify-recovery-fixes`、`verify-adjust-*`×2 等） |

### 2.4 本机限制（重要）

`verify-all.js` 用 `execFile`（默认 pipe）拉子进程，在本沙箱会 **EPERM**：

```
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:458:11)
    at …\scripts\verify-all.js:162:5
```

**结论：本机永远无法从门禁拿到「整体通过」；只能逐个套件跑。** 这是环境限制，不是代码缺陷。

### 2.5 当前基线（2026-11-02 13:28–13:47 实测，17 个注册套件逐个跑）

**660 条断言：644 通过 / 16 失败；15 绿 / 2 红。**

| 红灯 | 数量 | 根因（已定位） |
|---|---|---|
| `verify-auth.js` | 11 通过 / **15 失败** | `data/users.json` 残留账号 `tmp_negative_probe`；`auth.js:265` `if (count > 0) return` 导致跳过创建测试账号 → 登录全 401。**是测试数据污染，不是登录功能失效。** 该脚本**故意**用 `DATABASE_TYPE=json` 起临时服务（`verify-auth.js:57`）；线上走 postgres，账号是 `admin`，两者互不影响。 |
| `verify-loop.js` | 28 通过 / **1 失败** | 断言过期：`verify-loop.js:211` 要求 `qcVersion === 2`，代码已是 `qualityChecker.js:42` `QC_VERSION = 3`。 |

> 另一会话 13:45 记录的「11 个套件全绿」也成立——但它没跑 auth 与 loop。

### 2.6 判定口径

- 通过：退出码 0 **且** 输出末行 `M 失败` 为 0。
- 脚本自报的「跳过」**不等于**通过（见 §5 质检语义）。
- 有 30 个未注册套件本次未跑（seam/transitions/color-*/recovery/adjust 等），**它们的状态是「未验证」，不是「通过」**。

---

## 3. 代码规范（从现有代码归纳 + 已生效的契约）

1. **CommonJS**：后端与脚本用 `require` / `module.exports`。`web/src` 用浏览器原生 ESM（`import`），不经打包。
2. **无 TypeScript**，全部 `.js`；文件编码 **UTF-8 无 BOM**（用 `read` 工具或 `Get-Content -Encoding UTF8` 读）。
3. **不要整文件覆盖** `src/qualityChecker.js`、`src/pipeline.js`、`server.js` —— 只做精确 `edit`。
4. **不引入依赖不说明理由**：新增 npm 包必须写进 `docs/spec/changelog.md`（为什么自研不行、体积、许可证）。当前只有 4 个运行时依赖是刻意设计。
5. **ffmpeg 路径**一律读 `config.FFMPEG_PATH` / `config.FFPROBE_PATH`，**禁止硬编码**。
6. **要读 stdout 的 ffmpeg 调用**走已封装的降级路径（`qualityChecker._exec()` / `videoProcessor._execText()`），不要裸 `execSync(cmd,{encoding:'utf8'})`。
7. **提交一次只做一件事**；混合提交必须在提交信息里逐条列出实际内容。
8. 改动前先 `git status --porcelain`；**有输出 = 有人的改动没落盘，不要覆盖**。
9. **唯一前端是 `app/web/`（`/app`）**：`/` 与 12 个旧页面地址一律 302 到 `/app`；**旧版页面 2026-11-09 已删除**（`public/` 只剩 `login.html` + `assets/`），只读它们的 5 个静态脚本已一并删除（`verify-frontend-static` / `verify-transition-ui` / `verify-pages` / `check-inline-js` / `verify-editor-dom`），`verify-recovery-fixes` 与 `verify-skill-prompt` 里的旧 HTML 断言已剥离。**不要再往 `public/` 加页面**。

---

## 4. 已知的坑

### 4.1 本机实测（可复现）

| # | 坑 | 现象 | 规避 |
|---|---|---|---|
| 1 | 门禁跑不起来 | `node scripts/verify-all.js` → `spawn EPERM` | 逐个 `node scripts/verify-X.js` |
| 2 | 包管理器坏了 | `npm` 不存在；`pnpm --version` exit 1 | 不要写依赖 npm 的流程；已有 `node_modules` 就够用 |
| 3 | `verify-loop` 必红 | `qcVersion=3` 但断言 `===2` | 这是既有过期断言，**不要为了让测试变绿去改代码语义**；要么修断言（需按「测试也不许为了让代码通过而改」的规矩先确认），要么先记录 |
| 4 | `verify-auth` 必红 | `data/users.json` 里 `tmp_negative_probe` 让 bootstrap 跳过建号 | 修测试隔离（改用独立 DATA_DIR / 临时账号），**不要删用户数据凑绿** |
| 5 | 数据库**可达，但会间歇超时** | 2026-11-02 15:06 实测：`users` 表 1 行（`admin`）、`tasks` 表 **201** 行 → 库是通的；但批量跑测试时大量打印 `timeout exceeded when trying to connect` | **不要把测试里的超时噪声当成"库坏了"**；持久化断言仍只覆盖内存/JSON 侧 |
| 6 | sqlite 驱动不可用 | `better-sqlite3` 不在 `package.json` 也不在 `node_modules` | 不要用 `DATABASE_TYPE=sqlite` |
| 7 | `.err` 漏出 gitignore | `.gitignore:27` 只有 `*.log`；`data/logs/console-3001.log.err` 已被提交（0 字节） | 新增日志后缀时要同步规则 |
| 8 | 双锁文件 | `package-lock.json` 与 `pnpm-lock.yaml` 都在库 | 改依赖前先确认用哪个，别两个都改 |
| 9 | 根文档在 git 外 | 根 `AGENTS.md`/`PROJECT_STATE.md`/`docs/` 不受版本控制 | 重要结论写进 `app/` |
| 10 | 旧页面地址仍会被书签/历史命中 | 2026-11-09 前 `public/` 有 12 个旧 HTML，删文件后旧链接会 404 | `server.js` 的 `LEGACY_PAGES` 把 12 个旧地址统一 302 到 `/app`；`public/login.html` 保留（登录页），其余页面不要再加 |
| 11 | 工作区可能被并发修改 | 2026-11-02 13:51–14:01 期间观察到另一会话实时改 `adjustChain.js` 并提交 `b17bbdd`/`1d3c693` | 动手前与提交前各查一次 `git status`；提交前确认没有别人的文件混入 |
| 12 | `.env` 含真实 Key | 26 个变量名含各厂商 Key / 数据库连接串 | 不要 `cat .env`、不要把值贴进对话或日志 |
| 13 | PowerShell 引号 | `node -e '...'` 里的单引号会被 PS 吃掉，导致语法错误 | 外层双引号、JS 内层单引号；复杂逻辑写成 `.js` 文件 |
| 14 | **前后端版本错位** | 前端 `web/**` 是 Express 静态文件，刷新即生效；后端 `server.js` / `src/**` 是启动时加载，不重启仍是旧代码。症状：设置页已有图片生成入口，接口却报「未知的类型」 | 改完后端必须重启；跑 `node scripts/check-server-version.js`（0=当前，1=旧代码/过期，2=未运行）；`GET /api/status` 的 `serverInfo` / `imageGen` 是探针，前端检测到缺失会显示底部警告 |
| 15 | **新加的 Tailwind 类可能不生效** | `web/styles/app.css` 是离线生成的（18.5 KB），实测缺 `right-1 / w-6 / pr-9 / top-1/2 / -translate-y-1/2` 等；新控件用了这些类会「看不见/位置错」（2026-11-09 图片 Key 的显示/隐藏按钮踩过） | 新控件优先用已有类或内联样式；要加新类必须用 Tailwind CLI 重新生成 CSS（二进制需自备） |

### 4.2 文档记录、本次未独立复验（引用时请先复核）

| # | 坑 | 来源 |
|---|---|---|
| 16 | `ffmpeg -c copy` 拼接遇损坏输入会静默只拼前几段、退出码仍为 0；判成功必须校验时长 | `src/videoProcessor.js` `_validateConcatDuration()` 存在；`docs/spec/changelog.md` |
| 17 | 混合音轨（部分片段无音轨）时 `-c copy` 会只剩 video 流，音频被静默丢弃 | `docs/spec/changelog.md`「拼接对音轨差异的兼容」 |
| 18 | `stageSet` 未列入的步骤是 `undefined`，判断必须 `=== true`（写成 `!== false` 会让 quick 跑满 8 步） | `docs/spec/changelog.md`；`src/pipeline.js` |
| 19 | `audio_mix` 依赖 `transcoding`，不是 `concatenation` | `src/pipelineStages.js:43-52` 的 `STAGE_DEPS`（**已读码确认**） |
| 20 | `lut3d` 接绝对路径会报 `Undefined constant`，只能 cwd + 相对文件名 | `PROGRESS.md` 试错记录；`b17bbdd` 实现 |

---

## 5. 红线（每条都有历史事故，详见 `docs/spec/changelog.md`）

1. **`skipped` 永远不等于 `passed`。** 质检项「没跑起来」就是没通过；唯一合法的跳过是业务上本就不适用，且必须带 `legitimateSkip: true` + 理由。
2. **禁止用 `Math.random()` 冒充检测结论。** 随机数只许用于生成 ID、打乱素材、随机选 BGM。
3. **禁止把 ffmpeg 退出码 0 当成功。** 拼接必须附加时长校验；测不到时长 = 不可判定，不是通过。
4. **不许覆盖别人未提交的改动。**
5. **不许谎报状态**：没有证据不许写「已修复 / 已验证」；三态必须是「通过 / 不通过 / 未验证」。
6. **涉及覆盖 `output/` 成片的操作，先在副本上验证。**
7. **花钱的模型调用必须先经用户同意（2026-11-09 事故）**：任何会真实计费的调用（出图/出视频/真实 LLM）
   发起前必须先说明「调什么、几次、预估花费」并取得明确同意；探测只能用免费手段（只读 GET、
   本地 stub、缺必填字段的非法请求）。**禁止用「发一个真实请求试试」做探测。**
8. **每次真实调用的产物必须保留**：文件 + 请求参数 + 返回 JSON + 任务 id，落到 `output/` 下专项目录，
   交付里给路径/大小/ffprobe 数值；不得自行删除或清理（要清先问）。详见根 `AGENTS.md` §4.9。

---

## 6. 验收口径

- 凡涉及视频产物，必须给 **ffprobe / volumedetect 实测数值**（时长、分辨率、帧率、流、音频峰值/均值），不接受文字结论。
- 缺陷修复必须给**负向证据**（故意构造坏输入，证明能抓到 fail）。
- 结论必须区分三态，不允许把「未验证」写成「通过」。
- 可复述命令才算数。

---

## 7. 权威文档索引（按可信度排序）

| 文档 | 位置 | 可信度 |
|---|---|---|
| `docs/spec/changelog.md`（166 KB / 2924 行 / 40 节） | 仓库外根 `docs/` | **最高**，但只覆盖到 2026-10-31 |
| `docs/spec/review-gate-design.md`（747 行） | 仓库外根 `docs/` | 审核门的完整设计（含验收用例清单 §13、产品待定项 §14、实施顺序 §15） |
| `docs/spec/seam-quality-spec.md` / `pause-capability-spec.md` / `nsfw-detection-spec.md` | 仓库外根 `docs/` | 单项规格 |
| `PROGRESS.md`（仓库内） | `app/` | 最近一次交接，含断点五要素 |
| 根 `AGENTS.md`（40 KB） | 仓库外 | **局部过期**（套件数、web 文件数、死代码、browser 能力等 8 处） |
| 根 `PROJECT_STATE.md` | 仓库外 | **严重过期**（10-25 的状态，落后 48+ 提交） |

---

## 8. 未验证清单（不要假设）

- 真实厂商生成（无 Key，全部 Mock / 注入 fetch）。
- 持久化：库连得上（`users` 1 行、`tasks` 201 行），但**没有测试断言验证「任务真的写进 Postgres」**，现有断言只覆盖内存/JSON 侧。
- 30 分钟级长片、真实接缝、长时转码。
- 视觉与交互（无人工浏览器验收记录）。
- 30 个未注册套件的当前状态（2026-11-09 删除 4 个只测旧页面的套件后重新计数）。
