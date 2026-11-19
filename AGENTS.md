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
| `scripts/verify-*.js` 实有 | **67**（2026-11-11 实测；含门禁 runner `verify-all.js` 本身） |
| 门禁注册 | **62**（`verify-all.js` 的 `SUITES`；运行时首行打印「共 N 个脚本」） |
| 未注册 | **5**（67 − 62）：`verify-all.js`（runner 本身）+ 4 个**依赖运行中 3001 服务/登录态**的手动套件 `verify-bgm-api` / `verify-bgm-e2e2` / `verify-bgm-negative` / `verify-port3001`（未登录即失败，故不入门禁） |

### 2.4 本机限制（重要）

`verify-all.js` 用 `execFile`（默认 pipe）拉子进程，在本沙箱会 **EPERM**：

```
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:458:11)
    at …\scripts\verify-all.js:162:5
```

**结论：本机永远无法从门禁拿到「整体通过」；只能逐个套件跑。** 这是环境限制，不是代码缺陷。

### 2.5 当前基线（2026-11-10 实测）

- **曾长期红的 2 个套件已修好**：`verify-auth` **40/0**（隔离 `USERS_FILE` 到临时目录）、
  `verify-loop` **29/0**（`qcVersion` 改为从 `QC_VERSION` 同源取）→ 提交 `0194fa2`。
- **未注册套件已收口**：2026-11-10 逐个跑完原 29 个未注册套件，**24 个绿 + `verify-adjust-pipeline`（修 bug 后绿）
  → 新注册 25 个**；之后又新增并注册 `verify-image-review`、`verify-bgm-upload`、
  `verify-create-draft`（向导切页/刷新不丢草稿）、`verify-photo-library`（图片库）、
  `verify-i2v`（图生视频请求构建）→ 现 **62 注册 / 67 实有 / 5 未注册**
  （runner + 4 个依赖运行中服务的手动套件）。
- ⚠️ 本机仍**无法**用 `verify-all.js` 一次性拿总结果（`spawn EPERM`，见 2.4），只能逐个跑；
  逐个跑不代表整体已全绿，本轮只实跑了「新注册的 25 个 + 改动相关的若干套件」。

### 2.6 判定口径

- 通过：退出码 0 **且** 输出末行 `M 失败` 为 0（或同义总结行，如 `55 通过 / 0 失败`、`N passed, M failed`）。
- 脚本自报的「跳过」**不等于**通过（见 §5 质检语义）。
- 5 个未注册项中，4 个是**依赖运行中 3001 服务/登录态**的手动套件（`verify-bgm-api` / `bgm-e2e2` /
  `bgm-negative` / `port3001`）——它们的失败只说明「没登录」，**不能当成功能坏了**，也不能当成通过。

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
| 3 | ~~`verify-loop` 必红~~ **已修（2026-11-10）** | 旧断言写死 `qcVersion === 2`，代码已是 3 | 已改为从 `qualityChecker.QC_VERSION` 同源取；以后升版不会再假红 |
| 4 | ~~`verify-auth` 必红~~ **已修（2026-11-10）** | 测试直接读写真实 `data/users.json`，历史残留 `verify_` 账号让 bootstrap 跳过建号 → 登录全 401 | 已给 jsonfile 驱动加 `USERS_FILE` 环境覆盖，测试用临时目录；**仍然不要删真实用户数据凑绿** |
| 5 | 数据库**可达，但会间歇超时** | 2026-11-02 15:06 实测：`users` 表 1 行（`admin`）、`tasks` 表 **201** 行 → 库是通的；但批量跑测试时大量打印 `timeout exceeded when trying to connect` | **不要把测试里的超时噪声当成"库坏了"**；持久化断言仍只覆盖内存/JSON 侧 |
| 6 | sqlite 驱动不可用 | `better-sqlite3` 不在 `package.json` 也不在 `node_modules` | 不要用 `DATABASE_TYPE=sqlite` |
| 7 | ~~`.err` 漏出 gitignore~~ **已修（2026-11-10）** | `.gitignore` 只有 `*.log`；`data/logs/console-3001.log.err` 曾被提交 | 已补 `*.log.err` 并 `git rm --cached` 取消跟踪（文件还在，服务继续写） |
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
9. **归属不明的文件，禁止 checkout / restore / 覆盖 / 删除（2026-11-10 事故）**：
   工作区里不是自己改的文件（尤其是 `assets/bgm/manifest.json` 这类运行时数据）只能**只读**，
   记录 sha256 + mtime 后上报，由所有者处理。`git checkout --` 会**静默丢弃别人未提交的改动**
   （事故：我把用户在另一个窗口有意改的配乐清单还原了，用户只能重做一遍）。一律禁止。
10. **启动/重定向服务不得覆盖已有日志（2026-11-10 事故）**：
   `Start-Process -RedirectStandardOutput` 会**截断**已存在的日志文件（事故：真实
   `data/logs/console-3001.log` 被清空，旧进程日志永久丢失）。重启服务必须用新文件名
   或追加写（`>>` / `Add-Content` / `-Append`），真实运行日志不得清空。
11. **禁止擅自另起实例 / 端口 / 窗口 / 复制代码（2026-11-12 用户重申，已多次强调）**：
   服务只能有**一个**实例，默认 3001。不得启动 3002 等第二端口，不得把 `app/` 复制到新目录，
   不得用 `cmd start` / `Start-Process` 另开窗口跑服务。重启必须"先结束旧进程，再启动新进程"，
   不允许两个实例并行。需要第二实例做验收时，**必须先取得用户在当前对话里的明确同意**；
   用户没同意就提第二实例，视为违反本条。违反即返工，并视为交付事故。

12. **交付前必须跑 `node scripts/doctor.js`，并如实标注未验证路径（2026-11-12 新增）**：
   事故：Dockerfile 声明 Node 20 + Debian ffmpeg 5.x，而全部验证都在 Node 24 + ffmpeg 8.1 上完成；
   仓库里没有任何"未验证"标注，接收方会以为 Docker 路径可用。
   判据：① `node scripts/doctor.js` 在**验收机**上必须 0 个 ERROR（依赖未安装属"未部署"状态，不算）；
   ② doctor 覆盖不到的路径（Docker、云、多副本、反代）必须在交付文档里逐条写"未验证 + 自测方法"；
   ③ 禁止用"应该可以 / 大概 / 按理说"代替实测结论。

13. **依赖清单只能有一份权威，并在 `package.json` 里显式声明（2026-11-12 新增）**：
   事故：`package-lock.json` 停在 2026-10-09，缺 `@aws-sdk/client-s3` 与 `pg`；`pnpm-lock.yaml` 完整。
   因 Dockerfile 用 `npm install` 而非 `npm ci`，半年无人发现，`npm ci` 必然失败。
   判据：① `package.json` 必须有 `packageManager` 字段声明唯一包管理器；
   ② 非权威 lockfile 删除，或在文件头加"legacy，已弃用，勿用"注释；
   ③ 新增/升级依赖必须同时更新权威 lockfile，并跑 `node scripts/doctor.js` 确认覆盖；
   ④ 交付前用 `pnpm install --frozen-lockfile`（或 `npm ci`）**实跑一次安装**，证明可复现。
   存量：本条生效后 2 周内清理（当前两份并存，属已知违约）。

14. **用户可控路径必须"解析后判断"，禁止用字符串 `startsWith` 防穿越（2026-11-12 新增）**：
   事故：`/api/bgm/mix` 用 `videoPath.startsWith('output')`，`output/../../server.js` 可绕过；
   渲染 ffmpeg 命令用 `\"` 转义引号，而 Windows cmd.exe 不认这种转义、`%VAR%` 还会在引号内展开。
   判据：① 一律 `path.resolve` 后比较前缀（带路径分隔符）；需要防符号链接时再 `fs.realpath`；
   ② 拒绝 `" % & | < > ^` 与 CR/LF（开启延迟展开时另含 `!`）；
   ③ 新代码必须用 `execFileSync/spawn(bin, argsArray)`；字符串拼接只允许在已验证无危险字符的前提下使用；
   ④ 存量文件在被触及时一并改造，**不要求**一次性重写全部。

15. **同一事实只允许一份权威文档（限"代码事实类"）（2026-11-12 新增）**：
   事故：`docs/spec/changelog.md` 分成两份——仓库外根目录 220 KB 仍在更新，仓库内 162 KB 冻结于 2026-10-31，
   相差 650 行；新接手的人必然先读到过期那份（本次已发生）。
   判据：① 代码事实（接口、语义、验收口径、依赖版本）一律以 `app/` 内受控文件为权威；
   ② 仓库外的同名文档必须改成**指针文件**（指向仓库内路径）+ 归档日期，不得并行维护两份内容；
   ③ 合并时以更新的一份为准，另一份先原样保存到 `docs/archive/` 再替换，禁止直接覆盖。

16. **交付物必须是"可追溯的版本"，且部署约束随代码一起给（2026-11-12 新增）**：
   事故：本地领先 origin 125 个提交、20+ 个文件未提交，而交付说明里没有任何地方写明"给对方的是哪个版本"；
   会话/任务在进程内存，但无人告知"只能单实例"。
   判据：① 交付前必须打 tag（`vX.Y.Z`），并保证本地相对上游没有未推送提交（或明确记录以哪个 bundle 为准）；
   ② 必须包含 `app/docs/交付/` 下三份：安装手册、部署与安全清单、交付与后续同步说明；
   ③ 文档必须写明：单实例、持久卷、反代三项（`TRUST_PROXY` / `COOKIE_SECURE` / ≥64MB 请求体）、
   重启副作用（全员登出、运行中任务中断）；
   ④ 交付包用 `git bundle` 或远端仓库，**禁止只发 zip**（会得到没有共同祖先的两条历史）。

17. **静态目录默认跟随登录墙，只有"页面资产"可匿名（2026-11-12 新增）**：
   事故：`/output`、`/clips`、`/bgm` 为演示长期不鉴权，公网部署等于成片可被任意下载；
   代码注释里写着"公网必须拦"，但没人拦。
   判据：① 新增静态挂载前先定性：JS/CSS/字体/图标属页面资产（可匿名）；
   **媒体产物、数据导出、用户上传**必须挂鉴权；
   ② 必须写验收断言"未登录访问返回 401"（见 `scripts/verify-security-hardening.js`）；
   ③ `AUTH_ENABLED=false` 时放行只允许出现在验收环境，不得作为部署配置。

18. **提交边界：只提交自己碰过的文件；对外副作用先获批并留痕（2026-11-12 新增）**：
   事故：2026-11-10 对归属不明的 `assets/bgm/manifest.json` 执行 `git checkout`，丢掉用户在另一窗口的改动；
   2026-11-12 存在"另一个窗口正在改 `src/pipeline.js`"的并发状态，此时 `git add -A` 会把半成品一起提交。
   判据：① 有他人未提交改动时，禁止 `git add -A` / `git add .`，必须逐路径 `git add <file>`；
   ② 提交前跑 `git status --porcelain`，逐项确认待提交内容都是自己改的；
   ③ 对外副作用（推远端、删产物、动生产数据库、发付费请求）必须先取得用户同意，并在交付说明里记录对象与时间；
   ④ 确需改他人文件时（例如修测试环境的临时目录），改动最小化、单独说明、**不并入自己的提交**。

19. **React prop 类型错误会整块页面崩溃，静态断言证明不了能渲染（2026-11-19 新增）**：
   事故：设置页开关按钮写成 `style='opacity:.5;...'`（未强制时传空串）。React 生产构建对 `style`
   只接受对象，直接抛 `Minified React error #62`，SettingsView 被 ErrorBoundary 兜成
   「This block failed to render」，用户报「重启后设置页没有了」。此前的 `verify-assistant-frontend`
   只 grep 源码、不执行 React，所以全绿也没抓到。
   判据：① `style` 只传**对象或 undefined**，禁止字符串；`className` 传字符串、事件名用驼峰、
      受控值注意 `value/checked`；新增 JSX 属性前先确认 React 类型，不靠猜。
   ② **静态 grep ≠ 能渲染**。无浏览器/无截图能力时，交付必须标「未验证」，并对易错类型
      加静态防回归断言（本次已加：设置页不得出现字符串 style）。
   ③ 看到 `Minified React error #NN` 先查 `https://react.dev/errors/NN` 再改，不要凭感觉改代码。
   ④ 设置页/向导这类"一崩就空白"的页面，改动后优先找浏览器实测；本机起不了 Chrome
      时，至少把改动限制在已有模式（参考同文件其它 `style=${{...}}` 写法），并让用户强制刷新复验。

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
- 4 个依赖运行中服务/登录态的手动套件，本轮未在「已登录」环境下复跑。
