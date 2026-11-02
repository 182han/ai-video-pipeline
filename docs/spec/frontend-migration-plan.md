# 前端迁移落地评估：React + Vite + Tailwind

> 面向：研发（执行者）、产品（确认范围）、UI（确认设计依赖点）。
> 对应任务：`task-4`（前端：React+Vite+Tailwind 落地评估与验收脚本迁移映射）。
> 决策来源：`docs/spec/changelog.md` §「2026-10-26 · 前端技术栈迁移决定」（用户拍板方案 B）。
> 本期**只写文档，不动任何 `app/**` 代码**；本文所有"要改哪里"都是待执行项，不是已完成项。
>
> **最后实测：2026-10-26。** 凡本文与仓库现状不符，以仓库现状为准并立即修订本文。

---

## 0. 本文的读法与三态纪律

全文每条结论都带状态标记，按 `AGENTS.md` §5.1 第 4 条执行三态：

| 标记 | 含义 |
|---|---|
| **【实测】** | 本次用 `read` / 目录列举 / 哈希 / 计数命令亲自看过，附 `文件:行` 或可复述命令 |
| **【推断】** | 基于实测事实的工程判断，未经运行验证。落地时必须补验证 |
| **【未核实】** | 本机无网络（`npm view` 全部失败、`web_fetch` 无可用 provider），拿不到真实版本号/包体积，只能留空 |

**特别声明（重要）**：本机**无网络**，因此本文**没有**任何实测的 npm 版本号与包体积。
第 6 节依赖表里的"体积"列全部标为**【未核实】+ 推断量级**，落地前必须在有网机器上
`npm view <pkg> version license dist.unpackedSize` 实测，并按 `AGENTS.md` §4.6 记进 `docs/spec/changelog.md`。
**不允许把推断值当实测值写进 changelog。**

另一个纪律：本机 `node scripts/verify-all.js` **不可运行**（`spawn EPERM`，见 changelog 2026-10-26 §三）。
所以本文对验收脚本的分析**全部来自阅读源码**，**没有**一次运行记录。任何"迁移后这 43 项仍能覆盖"
的结论都是**设计意图**，不是**已验证**。

---

## 1. 实测基线：今天的前端是什么

这一节的意义是：迁移的每一步都要能对照"迁移动了什么"，所以先把基线钉死。

### 1.1 `app/public/index.html` 解剖【实测】

用 `Get-Content -Encoding UTF8` + 正则计数测得：

| 项 | 实测值 | 取证方式 |
|---|---|---|
| 总行数 | **8061** | `(Get-Content app\public\index.html -Encoding UTF8).Count` |
| 字节数 | **295 076 B（288.2 KB）** | `(Get-Item ...).Length` |
| `<style>` 块 | **7 – 2781 行**（2775 行 CSS） | `Select-String '<style' / '</style>'` |
| `<link rel=stylesheet>` | **1 处**：`index.html:2783` → `theme-nightvalley.css` | 同上 |
| `<script src=...>` 外链 | **0 处**（全部内联） | `Select-String '<script[^>]*src='` |
| `<body>` | 2785 行起 | 同上 |
| 结构标记（侧栏 + 主区） | **2786 – 3838** | 实测区间 |
| ├ 5 个页面容器 | `page-create:2869` / `page-generating:3103` / `page-result:3283` / `page-templates:3321` / `page-history:3346` | `id="page-*"` |
| ├ 静态 `.modal-overlay` | **6 个**：`clipDetailModal:3369` / `clipPreviewModal:3421` / `historyDetailModal:3434` / `settingsModal:3529` / `templateEditModal:3727` / `infoModal:3765` | `class="modal-overlay"` |
| └ 另 2 个对话框 | `confirm-delete-modal`（JS 模板字符串内，`index.html:6921`）、`#assistantPanel`（`role="dialog"`，`index.html:7627`） | 同上 |
| 内联 JS 块 | **2 块**：`3839 – 7623`（主逻辑）+ `7640 – 8059`（提示词助手 IIFE） | `<script>` / `</script>` |
| 全局函数 | **136**（`^\s*(async )?function \w+`，含缩进定义）；其中顶层 `^function` **84** 个 | 正则计数 |
| 内联事件属性 | **`onclick=` 48 处、`onchange=` 4 处** | 正则计数 |
| `innerHTML` 写入 | **41 处**；`insertAdjacentHTML` 0 处 | 正则计数 |
| 仅有的转义工具 | `function escapeHtml(str)` 在 `index.html:7339` | `function escape` |
| 定时器 | `setInterval` 3 / `setTimeout` 8 | 正则计数 |
| 前端唯一持久化 key | `localStorage` 只用了 **`vs_config`** 一个 | `localStorage\.(getItem\|setItem\|removeItem)\(` |

> **口径修正**：任务书与 changelog 提到"9 个弹窗"。实测口径是
> **6 个静态 `.modal-overlay` + 1 个动态插入的 `confirm-delete-modal` + 1 个常驻 `role=dialog` 助手面板 = 8 个对话框**；
> `index.html` 里 `modal-overlay` 字符串共出现 **9** 次（含 CSS 定义与 JS 拼接），"9"很可能来自这个计数。
> 迁移清点弹窗时以**本文的 8 个**为准，不要把 CSS 名当成弹窗。

### 1.2 子页清单【实测】

`app/public/` 共 14 个文件：

| 文件 | 字节 | 归属分类 |
|---|---|---|
| `index.html` | 295 076 | 主应用（本期迁移主体） |
| `preview-app.html` | 295 156 | ⚠️ 与 index.html **不同哈希**但体量相同，疑似旧版/去登录墙预览副本（**待 UI 确认是否可删**） |
| `bgm-editor.html` | 63 979 | 独立子页（剪辑/配乐），被 `verify-transition-ui.js`、`verify-editor-dom.js`、`test-editor-logic.js`、`check-inline-js.js` 解析 |
| `design-system-notion-apple.html` | 52 730 | 设计系统参照页（`AGENTS.md` §5.4 要求 token 与它一致） |
| `clip-library.html` | 29 153 | 独立子页 |
| `showcase.html` | 26 254 | 独立子页（作品展示，唯一"展示化"页面） |
| `music-library.html` | 17 108 | 独立子页 |
| `members.html` | 17 036 | 独立子页（成员管理） |
| `icon-comparison.html` | 17 163 | 参照页（非业务） |
| `preview-login.html` | 11 692 | 预览副本 |
| `login.html` | 10 908 | 登录页（**AUTH 中间件唯一放行的页面**，`server.js:79`） |
| `_selftest.html` | 9 621 | 浏览器自检页（`AGENTS.md` §2.6 推荐入口，见 §5.7） |
| `theme-nightvalley.css` | 3 717 | 唯一外部样式表 |
| `_ptest.html` | 1 563 | 临时测试页 |

任务书说的"6 个独立子页"（clip-library / bgm-editor / music-library / members / login / showcase）【实测】对得上。

### 1.3 运行时契约（迁移必须原样保住的东西）【实测】

**前端只调 13 个 API 族**（对 `index.html` 全文提取 `/api/...`）：

```
/api/assistant/chat   /api/auth/logout      /api/auth/me         /api/bgm
/api/models           /api/optimize-prompt  /api/rules           /api/status
/api/tasks            /api/templates        /api/test-api-key    /api/themes
/api/trash
```

其中 `/api/tasks` 族实际用到 8 个具体端点：
`GET /api/tasks`、`GET /api/tasks/:id`、`GET /api/tasks/:id/progress`、
`GET /api/tasks/:id/clips`、`POST /api/tasks`、
`GET /api/tasks/:id/continue-plan`、`POST /api/tasks/:id/continue`、
`POST /api/tasks/:id/clips/:index/regenerate`、`POST /api/tasks/:id/resume`、`DELETE /api/trash/:id` 等。

**后端共 60 条路由【实测】**：`Select-String -Pattern '^app\.(get|post|put|delete|patch)\(' app\server.js | Measure` → 60。
→ **前端只用了其中约 22%**，迁移期不需要把 60 条路由都接进 service 层。

**WebSocket 4 个事件**【实测】：

| 位置 | 内容 |
|---|---|
| `index.html:5410` | `ws = new WebSocket(`${protocol}//${location.host}/ws`)` |
| `index.html:5419` | `msg.type === 'progress'` |
| `index.html:5422` | `msg.type === 'stepUpdate'` → `handleStepUpdate` |
| `index.html:5425` | `msg.type === 'clipUpdate'` → `handleClipUpdate` |
| `index.html:5428` | `msg.type === 'statusChange'` |

服务端 WS 挂在 `path: '/ws'`（`src/wsManager.js:22`），且**握手鉴权**已接（`server.js:57`）。
→ 迁移后 `/ws` 路径与 4 个事件名**一个字都不能改**，否则整条实时链断。

**⚠️ 已知会新增的第 5、6 个事件（不是现状，是待接入）**：后端的人工审核门方案
（`docs/spec/review-gate-design.md`，同日产出）计划新增
`broadcastReviewRequired` / `broadcastReviewResolved` 两个 WS 事件（该文 §542 行附近列的验收项 20/⑤）。
→ 前端 `lib/ws.js` 从第一天就要把事件名做成**注册表**（一个 `EVENTS` 常量表 + 一个 `on(type, handler)`），
而不是 4 个写死的 `if/else if`——否则接审核门时要改动整个分发器。
**另**：该方案同时约定"**WS 事件是提示，HTTP 是真相**，重连后必须先 `GET` 再信任"（`review-gate-design.md:325`），
这条在迁移时必须照做（现状 `index.html:5410` 附近的 `onopen` 重连逻辑要先核对是否已满足）。

### 1.4 服务端下发链路【实测】

| 位置 | 现状 | 迁移影响 |
|---|---|---|
| `server.js:226-232` | `app.use(express.static(path.join(__dirname,'public'), { setHeaders: ... }))`；对 `.html/.js/.css` 设 `Cache-Control: no-cache, must-revalidate` | 需改为下发 `web/dist`；缓存策略要按"hash 资源 vs 入口 HTML"分流 |
| `server.js:223-225` | 注释写着「本项目没有构建步骤，改完 public/ 靠刷新生效」 | **这句话迁移后即失效**，必须改写（否则下次读代码的人被误导） |
| `server.js:62-100` | 登录墙中间件。注释 62-71；实现 `73`（`app.use`）到 `100` | 任务书写的"`server.js:65-96`"是**注释区间**，实现区间是 **73–100**。改这里时必须按 73–100 定位 |
| `server.js:79` | `if (p === '/login.html') return next();` 登录页白名单 | 登录页若迁进 React 路由，这条硬编码必须同步改，否则 302 死循环 |
| `server.js:81-87` | `/api/*` 未登录 → 401 JSON `{code:'AUTH_REQUIRED'}` | 不变 |
| `server.js:90` | **`const isPage = p === '/' \|\| p.endsWith('.html')`** | 🔴 **SPA 路由会绕过登录墙**，见 §3.4 / 风险 R1 |
| `server.js:235/246/262` | `/output`、`/clips`、`/bgm` 三个媒体目录 static，**不拦登录** | 不变（公网部署仍需补，属既有缺口） |
| 全文 | **没有** `sendFile`、**没有** `app.all`、**没有** catch-all、**没有** 404 处理器 | 🔴 迁移后**刷新 SPA 深链接会是 404**，必须新增 fallback，见 §3.3 |
| `server.js:1725` | `server.listen(PORT, '0.0.0.0', ...)` 是文件里最后一段 | SPA fallback 必须插在这之前、且在所有 `/api/*` 路由之后 |

### 1.5 验收脚本现状【实测】

`app/scripts/` 下 **58 个 `.js`【实测】**。`verify-all.js` 的 `SUITES` 共 **16 套件【实测】**
（`auth / stages / frontend-static / stats / pipeline-fixes / qc-annotation / frontend-contract /
continue / stage-pipeline / concat-audio / loop / nsfw / mock-vqc / library / skill-prompt / skill-ai-path`）。

> 口径修正：`AGENTS.md` §2.6 写"全部 14 个脚本"，实测 **16**。`changelog` 写的"58 个 js 脚本"对得上。

**关键实测结论（与既有文档不一致，必须更正）：**

| 脚本 | 是否真的静态解析 `public/index.html` | 证据 |
|---|---|---|
| `check-inline-js.js` | ✅ 是（1 处，且**同时**解析 `bgm-editor.html`） | 源码 `check-inline-js.js:3` |
| `verify-frontend-static.js` | ✅ 是（1 处读文件，`19` 行） | `verify-frontend-static.js:19,40` |
| `verify-recovery-fixes.js` | ✅ 是（1 处读文件，`226` 行；3 条断言消费它） | `verify-recovery-fixes.js:226,260-266` |
| `verify-transition-ui.js` | ✅ 是（1 处读 `index.html`，5 条断言；**另外还读 `bgm-editor.html`**，3 条） | `verify-transition-ui.js:45-50,54-57` |
| **`verify-skill-prompt.js`** | ✅ **是（1 处读文件，6 条断言）—— 既有文档完全没列** | `verify-skill-prompt.js:189,200-207` |
| **`verify-frontend-contract.js`** | ❌ **不是。全文不读 `index.html`**，它是**起真实服务跑 API 契约**（43 处 `assert(`，循环展开约 49 项） | 全文只 `fs.existsSync/statSync` 用于片段 mtime 与清理，见 `:241,262-263,283` |
| `_selftest.html`（浏览器端） | ✅ 是（浏览器 `fetch('/index.html')` 后正则查 id） | `_selftest.html:152-162` |

**因此：`AGENTS.md` §2.2 与 `changelog` 里"5 个脚本静态解析 `public/index.html`"这句话有三处不实：**

1. `verify-frontend-contract.js` 被错列进来——它**不碰 HTML**，迁移后**原样可用**，是被误伤的"假受害者"。
2. `verify-skill-prompt.js` 被漏掉——它**确实**静态解析 `index.html`，迁移后 6 条断言必失效。
3. 漏掉了 `_selftest.html`——它是 `AGENTS.md` §2.6 亲口推荐的"浏览器不可用时的前端自检"入口，
   迁移后会**静默失效**（页面还在、检查全过不了），比脚本失效更危险。

→ 正确的清单是 **5 个 Node 脚本 + 1 个浏览器自检页**（`check-inline-js` / `verify-frontend-static` /
`verify-recovery-fixes` / `verify-transition-ui` / `verify-skill-prompt` + `_selftest.html`），
外加 **1 个"看着像受害者其实不是"**（`verify-frontend-contract`）。
本文 §5 按这个更正后的清单给映射；`AGENTS.md` 的修订另见 §11-W1。

**第二个关键实测结论：`verify-all.js` 的 16 个套件里，上面 5 个静态脚本只有 1 个在门禁内。**

| 脚本 | 在 `verify-all` 里？ |
|---|---|
| `verify-frontend-static.js` | ✅ `frontend-static`（fast 组） |
| `verify-skill-prompt.js` | ✅ `skill-prompt`（fast 组） |
| `check-inline-js.js` | ❌ **不在** |
| `verify-recovery-fixes.js` | ❌ **不在** |
| `verify-transition-ui.js` | ❌ **不在** |
| `verify-pages.js` / `verify-editor-dom.js` / `test-editor-logic.js` | ❌ 都不在 |

→ 意味着：**迁移即使弄坏 3 个脚本，`npm run verify` 依然全绿。** 这是当前最大的"静默失败"面，
必须在迁移前先把它们拉进门禁（见 §5.9 / 步骤 P0-4）。

### 1.6 依赖与构建现状【实测】

`app/package.json`：

```json
"dependencies": { "@aws-sdk/client-s3": "^3.1152.0", "express": "^4.18.2", "pg": "^8.23.1", "ws": "^8.16.0" }
```

- **4 个运行时依赖，无 `devDependencies`，无 `build` 脚本**【实测】
- `start` / `dev` 都是 `node server.js`；`verify:frontend` = `verify-frontend-static.js && verify-frontend-contract.js`
- 包管理器：仓库里**没有** `pnpm-lock.yaml`，只有 `package-lock.json`（**npm**）→ §4.6 要求的下游同步对象是 `package-lock.json`
- `app/.gitignore` 已忽略 `node_modules/`，**没有**忽略 `dist/` 或 `web/`

---

## 2. 目录结构方案

### 2.1 结论（推荐，可直接执行）

```
app\
├── web\                          ← 新增：前端唯一源码目录（git 管得到，因为仓库根是 app\）
│   ├── index.html                ← Vite 入口模板（14 行级，不是页面内容）
│   ├── vite.config.js            ← base / proxy / build.outDir / chunk 策略
│   ├── package.json              ← 前端依赖（见 §2.4 的单包 vs 双包决策）
│   ├── postcss.config.js | tailwind.config.js   ← 取决于 Tailwind 版本，见 §6.4
│   ├── public\                   ← Vite 原样拷贝目录（favicon 等）
│   ├── src\
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── router.jsx            ← 5 页 + 后续子页路由
│   │   ├── pages\                ← create / generating / result / templates / history
│   │   ├── features\             ← 按业务切：create / generate-monitor / task-detail /
│   │   │                            templates / transition / qc-badge /
│   │   │                            prompt-assistant / settings / review-gate（预留）
│   │   ├── components\ui\        ← 按钮/输入/弹窗/抽屉等原子件
│   │   ├── lib\
│   │   │   ├── api.js            ← 唯一 fetch 出口（对应 §1.3 的 13 个 API 族）
│   │   │   ├── ws.js             ← 唯一 WS 出口（4 个事件名硬编码在这里，只此一处）
│   │   │   ├── runtimeConfig.js  ← 对应现有 collectTaskRuntimeConfig（vs_config）
│   │   │   ├── transition.js     ← 对应现有 collectTransitionConfig
│   │   │   └── format.js         ← escapeHtml 的替代（React 已自动转义，只留少数场景）
│   │   └── styles\tokens.css     ← 设计 token；依赖 UI 定稿（见 §10）
│   └── dist\                     ← 构建产物（**不入库**，见 §2.3）
├── public\                       ← 迁移期保留；终态只剩"不进构建的静态件"
└── scripts\                      ← 验收脚本（见 §5）
```

**为什么是 `app/web/` 而不是 `app/frontend/`**：两者都行，选一个写死。
推荐 `web/` 的实际理由：`vite.config.js` 里 `build.outDir` 与 `server.js` 里
`path.join(__dirname,'web','dist')` 都短且无歧义；且 `frontend` 与 `public` 的首字母在 Windows
默认不区分大小写的文件系统上不会撞名。**决策一旦写入就冻结，迁移期间不重命名。**

**为什么 `dist/` 就在 `web/` 下而不是 `app/dist/`**：产物与源码同根，`git status` 一眼看清；
`app/dist/` 容易被误认为"服务端产物"。

### 2.2 与现有 `app/public/` 的关系：迁移期**两套并存**，但并存的形态是"路径隔离"，不是"同路径切换"

三种可选形态，推荐第 3 种：

| 方案 | 做法 | 问题 |
|---|---|---|
| A. 同路径直接切换 | `express.static` 从 `public` 改成 `web/dist`，`public/index.html` 当天不可用 | 一刀切。5 页 + 8 弹窗一次全要迁完才有可用页面，中途无法验收，回滚也粗（只能 revert） |
| B. 同路径并行 | 两个 static 都挂 `/`，靠 `express.static` 的"先命中先用"决定 | 🔴 **不可行**：`/index.html` 在 `public/` 里已存在，新应用永远命中不到旧文件；且两套 SPA 路由混在同一个命名空间，无法判断"这个 404 该谁处理" |
| **C. 路径隔离（推荐）** | 旧应用留 `/`（`public/`）；新应用挂 **`/app/*`**（Vite `base:'/app/'` + `web/dist`）。同一服务、两个入口，随时可并排对比 | 需要一套 SPA fallback（§3.3），且要在 `base` 上一次性定死 |

推荐 **C**。理由：
1. **可回滚到"单个 URL 切换"粒度**：出问题把 `/app/*` 关掉即可，旧应用一行代码不动。
2. **可并排验收**：`http://localhost:3001/` 与 `http://localhost:3001/app/` 同时打开，
   UI 可以逐页对比（这正是本期 "3 套视觉方向可对比" 的需求形态，见 `task-2`）。
3. **不改旧文件的任何一行**，满足"迁移期不得顺手改 `public/`"的边界。

**终态**（并存期结束时）的切换只做三件事：
`vite.config.js` 的 `base` 从 `/app/` 改回 `/`、`server.js` 把 `/` 指向 `web/dist`、
`public/index.html` 归档到 `app/docs/legacy/`（**不删**，留作回归对照）。

### 2.3 `dist/` 是否入库：**不入库**（推荐）

理由：仓库已有 `package-lock.json` 与 `node_modules/` 忽略惯例，`dist` 是确定性衍生品；
入库会让每次构建都产生巨大无意义 diff，且 `AGENTS.md` §4.4 要求"改前先看 `git status`"，
入库的 dist 会让这条命令永远噪声满屏。

需要补的 `.gitignore` 行（**研发写权限**：`app/.gitignore`——注意 §3 的目录归属表没显式列 `.gitignore`，
按"仓库根配置文件"类推归研发，执行前向 lead 确认）：

```gitignore
# 前端构建产物（由 npm run build 生成，不入库）
web/dist/
web/node_modules/
```

代价：**部署机必须能构建**（或由 CI 产出）。这与现有"零构建、clone 即跑"的部署习惯冲突——
`启动.bat` / `启动.ps1` 目前只做 `node server.js`。缓解：新增 `启动-开发.bat`（不改变现有启动脚本），
并在 `README.md` 写清"首次需 `cd web && npm ci && npm run build`"。**这一点必须让产品知道**
（影响"换台机器就能跑"的既有体验）。若不接受，退化为"dist 入库 + 构建后 `git add web/dist`"，
但要在 changelog 记明原因。

### 2.4 单包还是双包（`app/package.json` vs `app/web/package.json`）

推荐 **双包（两个 `package.json`，各自 lock）**：

| 维度 | 单包（前端依赖合并进 `app/package.json`） | **双包（推荐）** |
|---|---|---|
| 与 `AGENTS.md` §4.6「依赖极简是刻意设计」 | 4 个运行时依赖旁边多出 10+ 个 devDependency，语义混淆 | 后端依赖表保持干净，`app/package.json` 只多一个 `build` 脚本（走 `--prefix web`） |
| 部署体积 | `npm ci` 会拉 webpack/vite 全家桶到生产机 | 生产机可只 `npm ci --omit=dev`（后端）+ 预构建 dist |
| 锁文件冲突 | 一个 lock，改动互相污染 | 两个 lock，职责清晰 |
| 成本 | 少一个目录 | 需要 `npm --prefix web ...` 或 `cd web`。Windows 下 `--prefix` 对 npm 10 更稳 |

`app/package.json` 只加三个脚本（**研发写权限**）：

```json
"build": "npm --prefix web ci && npm --prefix web run build",
"dev:web": "npm --prefix web run dev",
"verify:web": "npm --prefix web run test -- --run && node scripts/verify-frontend-static.js"
```

---

## 3. `server.js` 改造点（dev 态 / prod 态两套）

> 全部为**待执行项**。改动集中在 `server.js:62-100`（登录墙）与 `:222-232`（static），
> 加上文件尾部（`listen` 之前，约 `:1720`）新增 fallback。**`server.js` 属研发写权限**，
> 但按 §4.5「禁止整文件覆盖写」，只能用增量 `edit`。

### 3.1 总览

| 关注点 | dev（`node server.js` + `vite`） | prod（`node server.js` 单进程） |
|---|---|---|
| 页面由谁下发 | Vite dev server（`:5173`） | `express.static(web/dist)` |
| 新应用入口 | `http://localhost:5173/app/` | `http://localhost:3001/app/` |
| `/api/*` | Vite 代理 → `:3001` | 同源直连 |
| `/ws` | Vite 代理（`ws:true`）→ `:3001` | 同源直连 |
| `/output` `/clips` `/bgm` | Vite 代理 → `:3001` | 同源直连 |
| 登录页 | 由 `:3001` 的 `public/login.html` 提供（代理 `/login.html`） | 不变 |
| 登录墙生效处 | **`:3001` 上的 AUTH 中间件**（代理请求会带同一域的 cookie） | 同 |
| 构建 | 无（Vite 内存编译） | 必须预先 `npm run build` |

### 3.2 dev 态：`web/vite.config.js` 的代理

```js
export default defineConfig({
  base: '/app/',
  server: {
    port: 5173,
    proxy: {
      // 顺序无关紧要，但路径必须与 §1.3 / §1.4 完全一致
      '/api':          { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/ws':           { target: 'ws://127.0.0.1:3001', ws: true, changeOrigin: false },
      '/output':       { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/clips':        { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/bgm':          { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/login.html':   { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/members.html': { target: 'http://127.0.0.1:3001', changeOrigin: false }
    }
  }
});
```

**为什么必须代理 `/login.html` 而不是在 Vite 里放副本**：`server.js:79` 的登录页白名单是
`p === '/login.html'`，且 `:96` 的 302 目标是 `/login.html?next=...`。若 dev 下浏览器拿到的是
Vite 提供的另一份副本，用户会**在两个 origin 之间来回跳**（`next` 参数指回 `:3001` 或 `:5173` 不一致），
且 cookie 虽然按域共享（cookie **忽略端口**），但 `next` 的跳转目标会错。
→ **dev 下只认 `:3001` 那一份 `login.html`**。

**cookie 跨端口是否成立【推断，需实测】**：登录接口在 `:3001` 侧 `Set-Cookie`（`auth.setSessionCookie`），
经 Vite 代理把响应头原样透传给浏览器。浏览器按**响应 URL 的 host**（`127.0.0.1`）存 cookie，
**cookie 不区分端口**，因此 `:5173` 发起的 `/api` 请求（被代理到 `:3001`）会带上它。
这条链**没有实测过**（本机不能起双服务 + 浏览器点登录），落地第一步必须先验一次：
"在 `:5173` 登录 → 刷新 `:5173` 页面 → 请求不再 401"。

### 3.3 prod 态：static + SPA fallback（必须新增）

顺序**必须**是：登录墙 → `/api/*` 路由 → 媒体 static → `web/dist` static → **SPA fallback（最后）**。

```js
// (1) 替换 server.js:226 的 static：保留 no-cache 只给入口 HTML，hash 资源长缓存
const DIST = path.join(__dirname, 'web', 'dist');
app.use(express.static(DIST, {
  setHeaders: (res, filePath) => {
    if (/[\\/]assets[\\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Vite 产出带 hash
    } else if (/\.html$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');          // 入口必须回源
    }
  }
}));

// (2) SPA fallback：只能放在所有 /api 路由之后（server.js 尾部，listen 之前）
app.get(/^\/app(\/.*)?$/, (req, res, next) => {
  if (req.accepts('html') !== 'html') return next();   // 不吞 JSON/媒体请求
  res.sendFile(path.join(DIST, 'index.html'));
});
```

**三条硬约束**（写进验收，见 §5.9）：

1. fallback **不能**放在 `:226` 那个位置——那里在 60 条 `/api` 路由**之前**，
   写了会让 `GET /api/tasks` 之类的未知子路径返回 HTML 而不是 404 JSON。
2. fallback **不能**匹配 `/output`、`/clips`、`/bgm`、`/api` 前缀（正则已排除）。
3. fallback **不能**吞掉"文件确实不存在"的静态请求（`req.accepts('html')` 已排除）。

### 3.4 🔴 登录墙必须同步改（安全，非可选）

现状 `server.js:90`：

```js
const isPage = p === '/' || p.endsWith('.html');
```

**新应用的路由是 `/app/create`、`/app/tasks/xxx` 这类"不带 `.html`"的路径 → `isPage === false` → 直接 `next()` → 不经鉴权就下发了应用外壳。**
虽然外壳本身只是空 HTML（真数据要 `/api/*`，那条仍会 401），但这已经是**行为变化**：
今天用户未登录访问任何页面会被 302 到登录页；迁移后未登录访问 `/app/...` 会**看到应用界面骨架**，
再由前端自己去跳登录页——这是"把安全边界从服务端挪到客户端"，不可接受。

改法（推荐最小改动，只动判定表达式）：

```js
// 新应用命名空间一律按页面处理（登录墙覆盖），静态资源（带扩展名）除外
const isSpaRoute = p === '/app' || p.startsWith('/app/');
const isAsset = /\.[A-Za-z0-9]+$/.test(p);        // .js/.css/.png/.mp4 ...
const isPage = p === '/' || p.endsWith('.html') || (isSpaRoute && !isAsset);
```

**验收用例（负向）**：`AUTH_ENABLED` 默认开启 + 未带 cookie →
`GET /app/create` 必须 **302 到 `/login.html?next=%2Fapp%2Fcreate`**；
`GET /app/assets/index-abc123.js` 必须 **200**（资源放行，否则登录页也加载不出来）。

### 3.5 其它 `server.js` 待改点

| 行 | 现状 | 改为 |
|---|---|---|
| `:223-225` | 注释「本项目没有构建步骤」 | 改写成"dev 走 Vite、prod 走 `web/dist`"，并指明 §2.2 的路径隔离 |
| `:226` | 只下发 `public` | 追加下发 `web/dist`（见 §3.3） |
| `:79` | 只放行 `/login.html` | 若登录页将来迁进 React（`/app/login`），需同时放行并改 `:96` 的 302 目标。**本期建议不迁**（见 §7 P6） |
| 尾部 | 无 404 处理器 | 加 `/api/*` 的 JSON 404（`{error:'接口不存在',code:'NOT_FOUND'}`），避免前端拿到 HTML 报"Unexpected token `<`" |

---

## 4. 端口方案

### 4.1 现状与约束【实测】

| 位置 | 现状值 | 取证 |
|---|---|---|
| `config.js:307` | `port: parseInt(env('PORT', '3001'), 10)`（默认 **3001**） | 已读源码 |
| `app/.env:78` | **`PORT=3001`**（`.env` 不入库） | `Select-String -Path app\.env -Pattern '^PORT'` |
| **`app/.env.example:172`** | **`PORT=3000`** ← ⚠️ **与上面两处不一致（既有漂移）** | 同上 |
| `启动.bat:59,64` | **读 `config.js` 解析端口**，缺省回退 `3001`（`if not defined APP_PORT set APP_PORT=3001`） | 已读脚本 |
| `启动.ps1:45,63,77` | **不读配置，三处硬编码 `:3001`**（netstat 探测两处 + 打开浏览器一处） | 已读脚本 |
| `启动AI视频生成.bat:15` | `if not defined APP_PORT set APP_PORT=3001` | 已读脚本 |
| `AGENTS.md` §2.1 | 3001，且要求"四处必须相同" | 已读契约 |

**⚠️ 第三个既有漂移（本轮新发现）**：`启动.bat:59-64` 是从 `config.js` **解析**端口的，
而 `启动.ps1:45,63,77` 把 `3001` **硬编码**了三处。
→ 一旦有人把 `.env` 的 `PORT` 改成 3002（`AGENTS.md` §2.1 明确允许"临时换端口排查"），
`启动.bat` 会正确打开 3002，`启动.ps1` 会去探测并打开 **3001** → 出现"服务在 3002、脚本打开 3001"的
空页面，正好是 §2.1 想禁止的那种故障，而**原因不在 `.env`，在启动脚本之间的实现差异**。
这条与迁移无关但会**混进迁移期的排障**，建议 P0 一并修（同属研发写权限）。

→ **在执行任何端口变更之前，先修掉 `.env.example` 的 3000→3001 漂移**（否则迁移期同时踩两个坑：
"端口不一致" 与 "dev server 端口未定义"，排障时无法区分）。属研发写权限，建议顺手做，并在 changelog 记一行。

### 4.2 新的表述（推荐直接替换 `AGENTS.md` §2.1 的相关段落）

> **应用端口只有一个：3001。**
> 它是"这个产品跑在哪个端口"的唯一答案，四处（`.env`、`config.js` 默认值、`启动.bat`/`启动.ps1`、文档）必须一致。
>
> **Vite dev server 的 5173 不是应用端口，是开发期工具端口**：
> - 它**不写入** `.env`、`config.js`、启动脚本（避免成为第 5 处需要同步的地方）；
> - 它只由 `web/vite.config.js` 的 `server.port` 决定，**只在该文件里出现一次**；
> - `npm run dev:web` 之前必须先有 `node server.js` 在 3001 跑着（dev 态 API 靠代理到 3001）；
> - 生产/验收脚本**永远只认 3001**；任何验收脚本不得指向 5173。

这样"四处一致"的约束**没有被削弱**，只是明确了 dev 端口的归属边界：
**5173 只活在 `vite.config.js` 一个文件里，不进入"必须同步"的集合。**

### 4.3 建议的新约束条目（补充进 §2.1）

| 场景 | 命令 | 端口 |
|---|---|---|
| 生产 / 验收 | `node server.js` | **3001** 单进程，无 5173 |
| 纯后端排查 | `PORT=3002 node server.js` | 3002（临时，见既有约定） |
| 前端开发 | 终端 A `node server.js`；终端 B `npm run dev:web` | 3001 + **5173** |
| 前端开发（只要 API） | `AUTH_ENABLED=false node server.js` | 3001（仅本地，勿长期开） |

**注意与既有验收脚本的冲突**：`verify-*.js` 普遍用 `3093+` 起临时服务并 `AUTH_ENABLED=false`
（如 `verify-frontend-contract.js:24,97`），迁移**不得**让它们依赖 5173，也不得改动其端口选择逻辑。

---

## 5. 验收脚本迁移映射（本文最重要的一节）

### 5.0 总原则

1. **一条断言都不删。** 每一条原断言都要有"新架构下的等价物"，并在本节给出对照行。
2. **等价物允许更强，不允许更弱。** 例如"grep 请求体里有 `preset`"可以升级为
   "mock `fetch` 后断言 `body.preset === 'quick'`"——后者更强，因为它连"传了对的字段名但值错了"也能抓。
3. **判定强度必须在迁移 PR 里被证明。** 每个脚本的迁移 PR 必须附一张表：
   原断言数 N / 新断言数 M / **M ≥ N 的逐条对照**。做不到 M ≥ N 就说明漏了，不许合并。
4. **三层分工**（避免用浏览器测本该由单测覆盖的东西）：

| 层 | 载体 | 覆盖什么 | 对应今天哪些断言 |
|---|---|---|---|
| **L1 源码守卫**（静态扫 `web/src/**`） | `verify-frontend-static.js`（改造） | 禁止性规则：不许 `getElementById`、不许内联 `onclick`、不许直接 `fetch`（必须走 `lib/api.js`）、不许 `dangerouslySetInnerHTML` 无白名单 | 原 [3] id 交叉引用、`check-inline-js`、`verify-skill-prompt` 的"不许旧写法" |
| **L2 单元/渲染测试**（vitest + RTL + jsdom） | `web/src/**/*.test.jsx` | 组件渲染出的 DOM、交互（选档位→勾选区出现）、文案、`localStorage` 读取、请求体 | 原 [4][7][8][9] 与 `verify-recovery-fixes` / `verify-transition-ui` / `verify-skill-prompt` 的前端断言 |
| **L3 构建产物校验** | 新增 `verify-frontend-build.js` | `dist` 存在、入口引用 hash、无内联 script、体积预算、无 `</html>` 缺失 | 原 `check-inline-js` 的语法检查（由构建承担）+ 原 [1] 结构完整性 |

**为什么不能让 L2 全部扛下来**：渲染测试是 jsdom，**证不了**构建路径、chunk 拆分、
Tailwind 是否真的产出样式、`base` 是否写错——这些只有真构建才能证。

### 5.1 `check-inline-js.js`（9 行，2 个文件，2 个判定）【实测】

**今天查什么**：用正则取出 `<script>`（非 `src`）的块，逐个 `new vm.Script(...)` 判**语法能否解析**
（`check-inline-js.js:5-7`），对 `public/index.html` 与 `public/bgm-editor.html` 各打一个 PASS/FAIL。

**新架构下的等价物**：
- React 源码由 Vite/esbuild 在构建期解析（`.jsx` 也能查，比 `vm.Script` 强）→ **"语法错误"由构建失败拦住**。
- 但原断言的真正价值是"**内联脚本别写坏**"，而新架构应**根本不允许内联脚本**（CSP 与可维护性）。

**迁移方案（保留文件名，改判定方向）：**

```js
// scripts/check-inline-js.js（迁移后）
// 目标：1) 构建产物里不得有内联 <script>（Vite 默认产出 src=）；2) 若确有内联，必须可解析
//       3) public/bgm-editor.html 的原检查保持不变（子页尚未迁移）
const targets = [
  { file: 'web/dist/index.html', allowInline: false },
  { file: 'public/bgm-editor.html', allowInline: true }  // 原逻辑原样保留
];
```

| 原判定 | 新判定 | 强度 |
|---|---|---|
| `public/index.html` 内联块语法 OK | `web/dist/index.html` 内联块数 **必须 = 0**，且若 >0 仍逐块 `vm.Script` | **更强**（从"能解析"变成"不许有"） |
| `public/bgm-editor.html` 内联块语法 OK | **不变**（子页迁移时再同法处理） | 持平 |

**前置依赖**：本脚本必须在 `npm run build` **之后**跑；`verify-all` 里要排在 `frontend-build` 之后。

### 5.2 `verify-frontend-static.js`（43 项）——**最难迁移的一个**（见 §5.10）

今天 **26 处 `assert(` 调用点，循环展开后 43 项【实测】**（见下方逐组核对）。

#### 5.2.1 逐组映射表

| 组 | 原断言（行） | 项数 | 今天在查什么 | 新架构下怎么查 | 归属层 |
|---|---|---|---|---|---|
| [1] 结构完整性 | `:44,47,50,51` | 4 | `</html>` 结尾、script 配对、style 配对、无 U+FFFD | (a) 对 `web/dist/index.html` 查 `</html>` + script 配对 + 无 U+FFFD（`style` 配对改为"不得有 style 标签"，因为 Tailwind 走外部 CSS）；(b) 新增：扫 `web/src/**` 全部文本**无 U+FFFD** | L3+L1 |
| [2] 内联 JS 语法 | `:56,62` | 2 | 存在内联块 / 全部可解析 | 构建成功即覆盖；另断言 `dist` 无内联块（与 §5.1 合并，二者共享实现） | L3 |
| [3] `getElementById` 交叉引用 | `:84-86,127-129` | 2 | JS 里 `getElementById('x')` 的每个字面量，要么 HTML 有该 id、要么是 JS 动态创建的 id | **语义整体改变，这是最难的一项**。React 里没有 `getElementById`：<br>(a) **L1 源码守卫**：`web/src/**` 禁止出现 `document.getElementById(`（唯一豁免：`lib/dom.js` 里的受控适配，且该文件被测试覆盖）；<br>(b) **L2 渲染测试**：每个页面/弹窗渲染后，用 `getByTestId`/`getByRole` 断言关键节点存在；<br>(c) **`#genStatusDot` 既有缺口**：二选一——**推荐直接修掉**（在 React 组件里真的渲染这个元素 + 一条测试断言它会出现），并在 changelog 登记"迁移顺手修复既有缺口"；若本期不修，则在 L2 里建 `KNOWN_MISSING` 白名单断言其使用处受保护（等价于原 `:94-130` 的 37 行分析） | L1+L2 |
| [4a] 新 UI 就位 | `:134-140` | 9 | 9 个 id 存在：`presetSelect / presetHint / customStagesWrap / customStagesList / detailPreset / detailQcTrust / continueSection / continueHint / continueBtn` | L2 渲染测试：渲染"新建任务页"与"任务详情弹窗"，逐个 `expect(container.querySelector('#presetSelect')).toBeTruthy()`。<br>**决策：保留 `id` 属性**（不改成纯 `data-testid`），理由见下 | L2 |
| [4b] 8 个步骤勾选框 | `:142-147` | 1 | `data-stage="<8 个步骤>"` 全部存在 | L2：渲染 custom 档位后断言 8 个 `[data-stage]` 的集合相等（用 `expect.arrayContaining` 反向也断言无多余项） | L2 |
| [5] 请求体字段透传 | `:152-160` | 3 | 有 `fetch('/api/tasks',{...})`；body 区域内出现 `preset`；`customStages` 或 `stages` | L2：mock `fetch`，调用 `lib/api.js` 的 `createTask(payload)`，断言 `expect(fetch).toHaveBeenCalledWith('/api/tasks', ...)` 且 `JSON.parse(body).preset === 'quick'`；custom 档断言 `stages` 数组等于勾选集合 | L2（强度↑） |
| [6] 补跑调用 | `:165-167` | 3 | 调了 `/continue-plan?preset=`；调了 `/continue`；用的是 `POST` | L2：断言 `continuePlan(id, preset)` 的 URL 含 `?preset=`；`continueTask(id, preset)` 的 method 为 `POST` | L2（强度↑） |
| [7] 质检角标 | `:171-174` | 4 | 读 `qcTrusted` / `qcVersion` / `qcVersionSource`；存在「历史未验证」文案 | L2：用两个 fixture 渲染角标组件——(a) `qcTrusted:false` → 断言出现「历史未验证」；(b) `qcTrusted:true` → 断言**不出现**该文案（**新增负向**）；(c) 断言组件确实读了三个字段（传入三者各不相同、各断言渲染结果随其变化） | L2（+负向） |
| [8] 档位联动 | `:178-185` | 3 | 档位有 `change` 监听；`customStagesWrap` 参与切换；5 个 option 齐全 | L2 交互测试：`userEvent.selectOptions(select, 'custom')` → 断言勾选区可见；选 `quick` → 断言勾选区隐藏；断言 5 个 option 的 value 集合 | L2（强度↑） |
| [9] 既有功能未破坏 | `:189-196` | 12 | 9 个既有 id（`modelSelect / promptInput / clipCountInput / clipDurationInput / resolutionSelect / startBtn / historyDetailModal / detailStatus / detailVideo`）+ 3 个函数（`syncResolutionOptions / showTaskDetail / switchPage`） | (a) L2 渲染测试断言 9 个 id 仍在；(b) 3 个函数 → 新架构里的对应物，逐个断言存在且被调用：<br>· `syncResolutionOptions` → `features/create/useResolutionOptions`（断言"切换模型后分辨率选项变化"的**行为**）<br>· `showTaskDetail` → `features/task-detail/openTaskDetail`（断言调用后弹窗可见）<br>· `switchPage` → `router`（断言导航后目标页标题出现） | L2（强度↑） |
| | | **43** | | | |

**为什么保留 `id` 而不全面改 `data-testid`**：`_selftest.html`（§5.7）、可能的 e2e、
以及 UI 的样式钩子都可能依赖这些 id；一并改名会把"迁移"变成"重构 + 改名"两件事混在一起，
违反"一次提交只做一件事"（`AGENTS.md` §8）。**决策：迁移期 id 一字不改**，
新增测试钩子统一用 `data-testid`，两套并存。

#### 5.2.2 为什么这一项不能"靠 grep 混过去"

原脚本的 [3] 组做的是一件**跨文件推导**：从 JS 里抽 `getElementById` 字面量集合，
从 HTML 里抽 `id=` 集合，做差集。React 里"元素"是**运行期渲染出来的**，
静态文本里根本没有 id 到 DOM 的映射表——所以"同样的差集检查"在新架构下**无从下手**。
替代方案必须把这件事**拆成两个不同的问题**（写不出错误 vs 能查出错误），
拆完还要论证"强度没降"。这是本项目里唯一需要**重新设计判定口径**的脚本。

#### 5.2.3 断言数守恒核对

原文 26 处调用点 → 循环展开 43 项，核对：
`[1]=4 + [2]=2 + [3]=1+1 + [4a]=9 + [4b]=1 + [5]=3 + [6]=3 + [7]=4 + [8]=3 + [9]=9+3 = 43` ✅

迁移后目标：**≥ 43**。按上表能稳定做到 **≥ 45**，增量来自三处（不是"凑数"，每一处都是补强）：
`[3]` 从 2 条拆成 3 条（源码禁令 + 渲染存在性 + `genStatusDot` 处置）、
`[7]` 加 1 条负向（`qcTrusted:true` 时**不得**出现「历史未验证」）、
`[9]` 的 3 个函数从"名字存在"改成 3 条**行为**断言（条数不变，强度提升）。

> 记账纪律：迁移 PR 里必须逐条列"原第 N 条 → 新第 M 条"，**不接受"整体重写了，数量差不多"**这种说法。

### 5.3 `verify-frontend-contract.js`（43 处 `assert(`，约 49 项）

**结论：这个脚本不是受害者，原样保留。**【实测】

- 它**全文不读** `public/index.html`（只用 `fs` 查片段文件 mtime 与清理临时任务，`:241,262-266,283`）。
- 它做的是**起真实服务 → 逐条打 API**（`spawn(process.execPath, ['--require', shim, 'server.js'])`，`:94`），
  校验 `preset` 透传、`continue-plan` 字段、`continue` 错误分支、`qc*` 字段、`clips_only` 语义、
  补跑时片段 mtime 不变（`:122-268`）。

**迁移后只需两件事**：

1. **不动它**（它是后端契约的门禁，与前端技术栈无关）。
2. **新增**一个前端侧消费校验 `web/src/lib/api.contract.test.js`（可选，但推荐）：
   把 `verify-frontend-contract.js` 验证过的**响应字段名**固化到前端：
   `preset / stageSet / stagePlan / fragmentOnly / qcTrusted / qcVersion / qcVersionSource / finalQC.qcLabel`，
   用固定 fixture 断言 `lib/api.js` 的返回结构不被前端自己改名。这样"后端改了字段名但前端没跟上"
   会在单测层就被抓到，而不是等到用户点按钮。

**顺带更正**：`AGENTS.md` §2.2 与 changelog 把它列为"静态解析 index.html"的 5 个之一，**是错的**（见 §1.5）。
不改会让人以为"迁移后它一定坏"，从而在迁移时对它做无意义的改写，增加回归面。

### 5.4 `verify-recovery-fixes.js`（28 项，其中前端 3 项）

**今天查什么**（`:226` 读 `index.html`，`:260-266` 三条断言）：

| 原断言 | 行 | 新架构下的等价物 |
|---|---|---|
| 存在 `function collectTaskRuntimeConfig(model)` **且** 读 `localStorage.getItem('vs_config')` | `:260-262` | 移到 `web/src/lib/runtimeConfig.js` 并导出 `collectTaskRuntimeConfig(model)`；L2 单测：`localStorage.setItem('vs_config', JSON.stringify({...}))` → 断言返回对象含白名单字段；再断言**不**含非白名单字段（新增负向） |
| 重新生成请求带 `runtimeConfig` | `:263-264` | L2：mock `fetch`，调用 `regenerateClip(id, index, prompt)` → 断言 body 的 `runtimeConfig` 等于 `collectTaskRuntimeConfig(model)` 的结果 |
| 补跑请求带 `runtimeConfig` | `:265-266` | L2：调用 `continueTask(id, preset)` → 断言 body 带 `runtimeConfig: collectTaskRuntimeConfig(task.model \|\| 'mock')` |

🔴 **硬约束：`localStorage` 的 key `vs_config` 必须原样保留。**
它是用户已填 API Key 的唯一存放点（`index.html` 全文只用这一个 key）。改名 = 用户升级后
"Key 全没了"，且**没有任何报错**，只会表现为"又开始用 Mock 了"（正是 changelog 2026-10-21
记过的那类事故）。**这一条要写进迁移 checklist 并加一条断言守住。**

其余 25 项（`_nextClipPath`、`previousVideoPath`、`_isSynthetic`、`errorOut`、`ingestMissing` 等）
全是后端，**不动**。

### 5.5 `verify-transition-ui.js`（19 项，其中前端 8 项）

**今天查什么**【实测】：`index.html` 5 项（`:46-50`）+ `bgm-editor.html` 3 项（`:55-57`）
+ `server.js` 3 项 + `taskManager/pipeline` 4 项 + `config/.env.example` 4 项 = 19。

| 原断言 | 行 | 新架构下的等价物 |
|---|---|---|
| 存在 `#transitionEnabled` / `#transitionDuration` / `#transitionType` | `:46-48` | L2 渲染"新建任务页"，断言三个 id 存在（与 §5.2 的 id 策略一致：不改名） |
| 存在 `function collectTransitionConfig()` | `:49` | 移到 `web/src/lib/transition.js` 导出；L2 单测断言默认值 + 从 DOM/state 读取后的归一化（含非法值回退，**新增负向**） |
| `POST /api/tasks` body 带 `transition: collectTransitionConfig()` | `:50` | L2：mock `fetch` → 断言 body 有 `transition` 且等于 `collectTransitionConfig()` 结果 |
| `bgm-editor.html` 3 项 | `:55-57` | **子页未迁移期间保持不变**（原样通过）。子页迁移时同法改造（同一张表复用） |
| 后端 11 项（server/taskManager/pipeline/config/env） | `:62-83` | **完全不动** |

**注意一个"看似无关但会连带"的坑**：`:57` 的断言是
`/body:\s*JSON\.stringify\(\{\s*segments,\s*resolution,\s*transition\s*\}\)/`
——它匹配的是**解构后直接放进 body** 的字面写法。如果 UI 在迁移子页时把这段重排（哪怕语义一样），
这条会假失败。所以子页迁移必须**和这条断言同一个提交**，否则无法归因。

### 5.6 `verify-skill-prompt.js`（63 项，其中前端 6 项）—— **既有文档漏列的第 5 个脚本**

**今天查什么**（`:189` 读 `index.html`；`:200-207` 六条）：

| 原断言 | 行 | 新架构下的等价物 |
|---|---|---|
| 存在 `appendToPromptInput` | `:200` | 移到 `web/src/features/prompt/append.js`；L2 单测断言函数存在且行为正确 |
| `useOptimizedPrompt` 走**追加**（`:202` 正则要求 240 字符内出现 `appendToPromptInput`） | `:201-202` | 🔴 **这是"grep 距离"型断言，最脆弱**。替代为**行为测试**：预置提示词框已有文本，调用 `useOptimizedPrompt('新文本')`，断言结果 = `旧 + '\n' + 新`（而不是只剩新文本）——**比正则强**，因为它真能区分"追加"与"覆盖" |
| 助手 `usePrompt(text)` 走追加（`cur + '\n' + text`） | `:203-204` | 同上的行为测试（同一条用例可覆盖两处调用，但**保留两条断言**分别指向两个入口） |
| 「添加到提示词框」文案 ≥ 2 处 | `:205` | L2 渲染测试：断言该文案在助手面板与兜底入口各出现一次（`getAllByText` 长度 ≥ 2） |
| 优化请求带 `llmApiKey: cfg.llmKey` | `:206` | L2：mock `fetch` → 断言 `/api/optimize-prompt` 的 body 含 `llmApiKey` |
| **不得**出现旧写法 `getElementById('promptInput').value = text;` | `:207` | 由 §5.2 [3] 的 L1 源码守卫**整体覆盖**（`web/src` 禁止 `getElementById`），且更强（不只是禁这一种写法）。**但原断言要保留为具名用例**，避免"守卫被放宽时无人发现" |

其余 57 项是 `server.js` 与 skill 规则层，**不动**。

### 5.7 浏览器侧：`_selftest.html`（不是 Node 脚本，但同样会静默失效）

`AGENTS.md` §2.6 把它当作"浏览器不可用时的前端自检入口"。实测它的工作方式是
**浏览器 `fetch('/index.html')` 拿原文，再用正则查 id 是否存在**（`_selftest.html:152-162`）。

**迁移后它查的是一个已被 React 替换的文件**——两种情况都是坏的：

- 若 `/index.html` 仍指旧文件（并存期） → 它继续"通过"，但**验的不是新应用**，产生**假绿**；
- 终态切换后 → `fetch('/index.html')` 拿到的是 Vite 的空壳模板，**所有 id 都查不到**，全红。

**迁移方案（推荐）**：把它**降级为纯 API 自检页**，DOM 那组交给 vitest。

| `_selftest.html` 的 4 组 | 迁移后 |
|---|---|
| `sec-preset`（档位接口） | 保留（纯 API） |
| `sec-continue`（补跑接口） | 保留（纯 API） |
| `sec-qc`（质检字段） | 保留（纯 API） |
| `sec-dom`（fetch index.html 查 id） | **删除该组，但把 6 条 DOM 断言搬进 L2 渲染测试**（不是丢弃），并在页面上把该组替换为一行文字说明："DOM 断言已迁移至 `web/src/**/*.test.jsx`，见 `docs/spec/frontend-migration-plan.md` §5.7" |

**理由**：保留一个"看起来在验前端、其实验的是旧文件"的页面，比删掉它更危险。

### 5.8 其它会被波及的脚本（任务书未列，但同样要处理）

| 脚本 | 现状 | 迁移影响 |
|---|---|---|
| `verify-pages.js`（`:6`） | `GET /bgm-editor.html`、`/music-library.html`、`/clip-library.html`、`/` 都要求 200 且 >1000B | **并存期不受影响**（旧应用仍在 `/`）。终态切换 `/`→React 后，`/` 返回的 HTML 只有几百字节（空壳 + script），**`t.length > 1000` 会失败**。届时需改为"断言 200 且含 `<div id="root">`" + 另加一条断言检查 `/app/assets/*.js` 可下载 |
| `verify-editor-dom.js`（`:2`）、`test-editor-logic.js`（`:3`） | 读 `public/bgm-editor.html` | 子页迁移时同步改造（同 §5.5 的方法） |
| `_domcheck.js` / `_e.js` / `_selfcheck.js` 等 `_` 前缀脚本 | 一次性排障脚本，不在门禁 | 不维护；迁移时若报错直接标注"历史脚本"即可，但**不得删除**（属研发写权限内的清理，需单独提交） |

### 5.9 门禁补齐（否则上述映射等于没做）

**当前事实**：5 个静态脚本里 3 个（`check-inline-js` / `verify-recovery-fixes` / `verify-transition-ui`）
**不在** `verify-all.js` 的 16 个套件内 → 迁移弄坏它们，`npm run verify` 仍然全绿。

**必做（步骤 P0-4）**：在迁移**开始前**补进 `verify-all.js`，这样"迁移前基线绿"才有意义：

```js
// scripts/verify-all.js 的 SUITES 新增（顺序：静态 → 构建 → 单元 → 契约 → 真机）
{ name: 'inline-js',      script: 'check-inline-js.js',       group: 'fast', desc: '内联 JS 语法 / 禁止内联（迁移后）' },
{ name: 'recovery-fixes', script: 'verify-recovery-fixes.js', group: 'fast', desc: '28 项：覆盖保护/降级标记/配置合并/404-403 并发隔离/片段库补档/接线' },
{ name: 'transition-ui',  script: 'verify-transition-ui.js',  group: 'fast', desc: '转场接线（19 项静态）' },
{ name: 'frontend-build', script: 'verify-frontend-build.js', group: 'fast', desc: '构建产物：dist 存在/hash 引用/无内联/体积预算' },
{ name: 'frontend-unit',  script: '../web/node_modules/vitest/vitest.mjs', group: 'fast', desc: '组件渲染 + service 单测' }
```

注意 `frontend-unit` 的路径很丑（跨目录调 vitest）。更干净的做法：
在 `verify-all.js` 里对 `frontend-unit` 用 `execFile` 的 `cwd` 指向 `web/`，
而不是硬编码 `node_modules` 路径——落地时按 `verify-all.js:156` 现有的 `cwd: APP_DIR` 模式扩展一个
`cwd` 字段即可。**这部分改动属研发写权限，随迁移一起做。**

### 5.10 最难迁移的脚本：`verify-frontend-static.js`（43 项）

**结论：难在"`getElementById` 交叉引用"这一项，而不是数量。**

三条理由：

1. **它是唯一做"跨文件推导"的脚本。**
   [3] 组从 JS 里抽 `getElementById` 字面量集合、从 HTML 里抽 `id=` 集合，做差集（`:66-90`）。
   React 里 DOM 是运行期渲染出来的，**静态文本里不存在"id → 元素"的映射表**，
   所以"同样的差集检查"在新架构下根本没有对应物。必须拆成
   "让错误写不出来（源码禁令）" + "渲染后能查出来（渲染测试）"两件事，再论证两件事合起来**不弱于**原来的差集。
   这个论证是本项目里唯一需要**重新定义判定口径**的地方，也是最容易被糊弄过去的地方
   （写成"我们用了 TypeScript，所以不用查了"——那是**削弱**，TypeScript 不查 DOM id）。

2. **它混合了 4 类完全不同性质的断言，没有单一替代手段。**
   43 项按 §5.2.1 的分组分布是：结构（4）+ 语法（2）+ id 存在性（10 = [4a]9 + [4b]1）
   + id 交叉引用（2）+ 数据流（6 = [5]3 + [6]3）+ 质检角标（4）+ 交互联动（3）+ 既有未破坏（12）
   = **43** ✅。
   迁移时必须**拆成 3 个不同的测试文件**（L1 源码守卫、L2 渲染、L2 service），
   而"拆"本身就会带来"某条断言在拆的过程中被悄悄丢掉"的风险——所以需要一张**逐条对照表**（本文 §5.2.1 已给出）。

3. **它内部有一段 37 行、专门为既有缺陷写的"安全分析"逻辑**（`:80-130`，
   `KNOWN_MISSING = ['genStatusDot']` + "有 null 保护或是死代码"的判定）。
   这段逻辑的前提是"元素不存在 → 运行时 `null.xxx` 抛错 → 所以要用 null 保护兜住"。
   在 React 里，"元素不存在"通常**根本不抛错**（只是不渲染），所以**旧的判定前提消失**。
   于是这段既不能机械搬（前提不成立），也不能直接删（它守的是 `AGENTS.md` §6 明确登记的真实缺口）。
   **唯一干净的解**：迁移时把 `#genStatusDot` 这个缺口**真正修掉**（React 里加这个元素 + 一条测试），
   然后这段逻辑以"缺陷已修复"收尾，并在 changelog 记一笔。这属于"迁移顺手修 bug"，
   必须单独一个提交、单独一行 changelog，**不能混进迁移提交**。

> 对比一下第二难的：`verify-skill-prompt.js` 的 6 项。它的 `:201-204` 用"正则 240 字符窗口"
> 判断"走追加"，虽然脆弱，但**替代手段是明确且更强的**（行为测试），不需要重新设计判定口径。
> 所以它难在"细节"，`verify-frontend-static.js` 难在"原理"。

---

## 6. 组件基础选型（含 §4.6 要求的体积 / 许可证 / 维护风险）

> ⚠️ **本节所有"体积"都是【未核实】+【推断】。**
> 本机 `npm view` 全部失败（无网络），`web_fetch` 报 "multiple usable web providers"。
> 落地前必须在有网机器上跑：
> ```powershell
> npm view <pkg> version license dist.unpackedSize
> ```
> 并把实测值补进 `docs/spec/changelog.md`（§4.6 硬要求）。**没实测就上生产 = 违反 §4.6。**

### 6.1 必装（缺一项都跑不起来）

| 包 | 用途 | 版本 | 许可证 | 体积（推断，未核实） | 维护风险 |
|---|---|---|---|---|---|
| `react` / `react-dom` | 框架 | 19.x（以 lock 为准） | MIT | ~7–10 KB gzip（两者合计，推断） | 极低（Meta 维护，生态最大） |
| `vite` | 构建/dev server | 7.x | MIT | ~10–15 KB gzip（自身，推断） | 低（发行节奏快，大版本升级需跟；**本项目锁定 minor**） |
| `@vitejs/plugin-react` | JSX/Fast Refresh | 与 vite 配套 | MIT | ~3–5 KB gzip（推断） | 低（同 vite 团队） |
| `tailwindcss` | 原子 CSS | 4.x（若装不上退 3.x，见 §6.4） | MIT | 构建期工具，**不进运行时包** | 低（v3→v4 配置范式变化大，见 §6.4） |
| `@tailwindcss/vite`（v4）或 `postcss`+`autoprefixer`（v3） | 接入方式 | — | MIT | 构建期 | 同 Tailwind |
| `react-router-dom` | 5 页 + 6 子页路由 | 7.x | MIT | ~12–16 KB gzip（推断） | 中低（v6→v7 有 API 变化；**只用 `BrowserRouter/Routes/Route/Link` 最稳的子集，不用数据路由/loader**） |

### 6.2 测试栈（必装 —— 它是 §5 替代断言**唯一**的载体，不是可选项）

| 包 | 用途 | 许可证 | 体积（推断） | 维护风险 |
|---|---|---|---|---|
| `vitest` | 测试运行器（与 vite 同配置体系） | MIT | 构建期 | 低 |
| `@testing-library/react` | 渲染断言 | MIT | 构建期 | 低 |
| `@testing-library/user-event` | 交互（选档位、点按钮） | MIT | 构建期 | 低 |
| `@testing-library/jest-dom` | `toBeVisible` 等 matcher | MIT | 构建期 | 低 |
| `jsdom` | 无头 DOM 环境 | MIT | 构建期 | 中（DOM 实现总有边角差异；**这正是 §5 要求 L3 构建校验兜底的原因**） |

**如果只让我保一项可选依赖，我保这个测试栈**：没有它，§5 里 47 项替代断言无家可归，
迁移就变成"删断言"（`AGENTS.md` §2.2 明令禁止）。

### 6.3 逐个决策：Radix / shadcn / framer-motion / 其它

| 候选 | 建议 | 理由（含代价） |
|---|---|---|
| **`@radix-ui/react-dialog`** 等 primitives | **按需引入（推荐）** | 8 个对话框都需要 focus trap / 滚动锁 / Esc / `aria-modal` / 焦点归还。手写这套**易错且难测**（jsdom 测不出真实的 Tab 循环）。Radix 每个 primitive 独立发包、独立升级，MIT，可只装 `dialog`/`tabs`/`select`/`tooltip`/`switch` 五个。**代价**：包数量变多（每个 primitive 一包），每个约 5–15 KB gzip（推断）；`package-lock.json` 条目变长。**风险评估**：Radix 被 shadcn 生态广泛依赖，维护活跃；但本项目不做整站组件库，只取 primitive，**避免被它的版本节奏绑架**。 |
| **`shadcn/ui`** | **不整体引入（推荐）** | 它不是 npm 依赖，是"把组件源码复制进你的仓库"。**代价**：会一次性引入 ~20 个组件文件与其默认视觉（Tailwind 类名硬编码），与 UI 正在产出的 3 套 design token **直接冲突**，且后续 UI 改 token 时要改这些复制来的文件。**可以只借它的 Radix 用法当参考，不复制文件。** |
| **`framer-motion`** | **不引入（推荐）** | 依据 `task-2` 的硬约束：工作台"操作反馈 <200ms、不做装饰性动画"，只有成片预览区允许展示化。这点动效用 CSS `transition` + Tailwind 内置 `animate-*` + 少量 `@keyframes` 足够。**代价**：预览区若将来要做序列动效，CSS 写法会更啰嗦。**风险评估**：framer-motion 自身 MIT、维护活跃，但它会引入 ~30–50 KB gzip（推断）到一个"中性工作台"里，收益/体积比不成立。**若 UI 定稿后确实需要，再单独评估并按 §4.6 记录。** |
| **`zustand`** | **引入（推荐，第二优先）** | 现状是 136 个全局函数共享状态（`currentTask`、`vs_config`、轮询 timer 等），React 里没有等价物。`useState` 上提会导致跨 5 页 prop-drill；`Context` 可行但每次变更会重渲染整棵子树（视频任务每秒多次 progress 事件，会明显掉帧）。zustand ~1–3 KB gzip（推断），MIT，心智负担极低。**代价**：多一个"状态在哪"的约定，需在 `web/src/store/` 统一。**替代方案**：React Context + `useSyncExternalStore`（零依赖但要多写 ~40 行胶水）。**建议**：先 zustand，理由写在 changelog。 |
| **`@tanstack/react-query`** | **本期不引入，Phase 3 再评估** | 现有数据获取是"fetch + 3 个 `setInterval` + WS 事件"混合（`index.html` 的 timer 与 `:5419-5428` 的 WS）。react-query 能统一缓存/重试/失效，**但在同一期再引入一个状态库，会让"这数据为什么不刷新"的排障变成双盲**。先让 zustand 站稳，下一期评估。 |
| **`hls.js`** | **不引入** | 现有播放是 `<video src>` 直链 mp4（成片由 ffmpeg 转码产出）。除非产品要 HLS 流式播放（大文件首屏），否则 Apache-2.0 + ~100 KB gzip（推断）纯属浪费。**待确认**：是否需要边转码边播放（见 §11-W5）。 |
| **`lucide-react`** | **待 UI 定稿后决定** | 现有图标是内联 SVG/CSS 画的。若 UI 的三套方向要求统一图标体系，lucide（ISC，按需 import）是成本最低的选择。**代价**：与现有手绘图标风格可能不一致，会造成"一套界面两种图标语言"。**建议**：等 UI 的图标风格定稿再定（§10-D4）。 |

### 6.4 Tailwind 版本的现实约束（重要，落地第一步就会撞上）

本机**无网络** → 无法确认能否装到 Tailwind v4。两条路：

| 路 | 条件 | 配置范式 | 风险 |
|---|---|---|---|
| v4 + `@tailwindcss/vite` | 能装到 4.x | `@import "tailwindcss";` + CSS-first 配置，无需 `tailwind.config.js` | 生态资料新、插件兼容性参差 |
| v3 + `postcss` + `autoprefixer` | 只能装到 3.x | `tailwind.config.js` + `@tailwind base/components/utilities` | 资料最多最稳，但属"上一代" |

**建议**：落地第一步先在有网机器上 `npm view tailwindcss version` 定版，**不要凭猜测写配置**。
这条写进 §7 的 P1 gate。

---

## 7. 迁移顺序（每阶段可独立回滚 + 独立验收）

> 原则：**每个阶段结束时，`/`（旧应用）必须仍然完全可用**。任何阶段都不允许出现"两边都不可用"的窗口。

### P0 · 前置（不改任何前端代码，但必须做）

| # | 动作 | 写权限 | 验收 |
|---|---|---|---|
| P0-1 | 修 `app/.env.example:172` 的 `PORT=3000` → `PORT=3001`；顺手让 `启动.ps1` 也像 `启动.bat:59` 一样从 `config.js` 解析端口（或至少把三处 `3001` 抽成一个变量） | 研发 | `Select-String PORT app\.env.example` 与 `config.js:307`、`.env:78` 一致；`启动.ps1` 内 `3001` 出现次数从 3 降到 ≤1 |
| P0-2 | 把 `check-inline-js` / `verify-recovery-fixes` / `verify-transition-ui` 补进 `verify-all.js` 的 `SUITES` | 研发 | `node scripts/verify-all.js --fast` 套件数 16 → 19（**本机不可跑，见 §0**，须在有网/正常机器上跑） |
| P0-3 | 用**当前**代码跑一遍 `verify-all --fast`，把结果存成**基线快照**（含每套件通过数） | 研发 | 基线文件 `docs/spec/_baselines/frontend-baseline-2026-10-26.txt` |
| P0-4 | 把本文 §1.5 的三处口径错误追加进 `docs/spec/changelog.md`（**追加，不改别人已写内容**） | 研发（`docs/spec` 共写，按小节追加） | changelog 新节存在 |
| P0-5 | 通知 UI：`public/index.html` 进入**功能冻结**（只修 bug，新功能只进 React） | lead | UI 确认 |

**P0 的意义**：P0-3 的基线是后面每一步"没变差"的唯一参照。**没有基线就开始迁移，等于没有验收。**

### P1 · 骨架（第一个可运行的新页面）

1. `app/web/` 初始化：`package.json`（双包，§2.4）、`vite.config.js`（`base:'/app/'` + §3.2 代理）、
   `tailwind` 接入（版本按 §6.4 实测）。
2. 最小 SPA：`main.jsx` + `App.jsx` + 一个"Hello + 当前用户"页，调 `/api/auth/me` 验证**登录墙与代理链**。
3. **Gate**（三条都必须过，否则不进 P2）：
   - `http://localhost:5173/app/` 能显示当前登录用户名（证明 dev 代理 + cookie 跨端口成立，§3.2 的【推断】转【实测】）；
   - `http://localhost:3001/app/` 能显示同样内容（证明 prod static + fallback 成立）；
   - **未登录**访问 `http://localhost:3001/app/create` → 302 到 `/login.html?next=...`（证明 §3.4 生效）。

### P2 · 5 个页面 + 8 个对话框（主体）

按"依赖少 → 依赖多"排序，每迁完一页就删掉旧页的入口链接（旧文件保留）：

1. `page-templates`（只读列表，最简单，可先跑通"列表 + 渲染测试 + api 单测"三件套）
2. `page-history`（列表 + 详情弹窗 + 补跑入口 → 触发 `continue-plan`/`continue`，覆盖 §5.2 [6] 与 §5.4）
3. `page-create`（表单最重：档位 5 选、8 个 `data-stage`、转场 3 控件、分辨率联动 → 覆盖 §5.2 [4][5][8]、§5.5）
4. `page-generating`（WS 4 事件 + 轮询 timer → **这一页最容易出并发 bug**，需专门的 WS 单测）
5. `page-result`（成片预览 + 质检角标 → 覆盖 §5.2 [7]）

**Gate（P2 结束）**：§5.2 的 43 项在 L1/L2/L3 三层的**总数 ≥ 43**，且 P0-3 基线里所有仍然适用的套件仍全绿。

### P3 · 子页（按收益排序，**允许暂不迁**）

`members`（最小，17 KB）→ `clip-library`（29 KB）→ `music-library`（17 KB）
→ `bgm-editor`（64 KB，**最复杂，最后**）→ `login`（**建议最后甚至不迁**，见 §7-P6）
→ `showcase`（展示页，本身就是独立视觉，可长期保留原生）。

**纪律**：子页若在并存期内不迁，**必须写进"终态不保留清单"并标注截止里程碑**，
否则就退化成 `changelog` 里已被否决的"方案 C（主工作台 React、子页原生）"——
不是技术不行，而是"两套渲染体系 + 两份 design token"的长期维护成本已被明确否决过。

### P4 · 断言迁移（与 P2/P3 同步，不单独成阶段）

每个页面迁移 PR **必须**同时包含：
1. 该页对应的 L2 渲染/交互测试；
2. 该页对应的旧静态断言**逐条对照表**（原 N 条 → 新 M 条，M ≥ N）；
3. 旧脚本里该页断言的**替代实现**（不是删除）。

### P5 · 终态切换

1. `vite.config.js` 的 `base` → `'/'`；
2. `server.js` 的 `/` 指向 `web/dist`（`public/index.html` 不再被 static 命中）；
3. `public/index.html` / `preview-app.html` 归档到 `app/docs/legacy/`（**不删**）；
4. `AGENTS.md` §2.2 的四行改写（前端/构建/框架/依赖）+ §2.6 套件数 + §6 缺口的 `#genStatusDot` 状态；
5. `启动.bat` / `启动.ps1` 增加"首次需构建"的提示（**不改变端口**）。

**Gate（P5）**：`verify-all` 全绿（19+ 套件）+ 真实浏览器主流程人工走通（§5.4 要求）+ 一条**非 mock** 真实任务从创建到导出跑通。

### P6 · 登录页（建议延后到 P5 之后，甚至不做）

理由：`login.html` 只有 10.9 KB、无状态、无轮询，是**风险最低但改造成本/收益比最差**的一块。
而它牵扯 `server.js:79` 的白名单与 `:96` 的 302 目标**两处安全代码**。
**建议**：保持原生到最后一个里程碑；若最终要迁，单独一个提交、单独验负向（未登录 302、错误密码锁定、cookie 篡改）。

---

## 8. 风险清单

| # | 风险 | 影响 | 概率【推断】 | 缓解 | 证据 |
|---|---|---|---|---|---|
| **R1** | **SPA 路由绕过登录墙**（`server.js:90` 的 `isPage` 判定不含 `/app/*`） | 🔴 安全：未登录能看到应用外壳 | 高（不改就一定发生） | §3.4 改判定 + 负向验收（未登录 302） | `server.js:90` |
| **R2** | **3 个静态脚本不在 `verify-all` 门禁内** → 迁移弄坏它们而 `npm run verify` 全绿 | 🔴 静默失败：以为验过了 | 高（当前就是） | P0-2 补进 `SUITES` + P0-3 基线 | `verify-all.js` 16 套件实测 |
| **R3** | 48 处 `onclick` + 4 处 `onchange` 内联事件漏迁 | 功能点"点了没反应"，且难定位 | 高 | 逐个登记成 checklist；L1 守卫禁止 JSX 里出现 `onclick=` | `index.html` 计数 |
| **R4** | 41 处 `innerHTML` 直译成 `dangerouslySetInnerHTML` | 🔴 XSS + 转义双写（现有 `escapeHtml` 在 `:7339`） | 中 | L1 守卫：`dangerouslySetInnerHTML` 必须配白名单注释；业务改为 JSX 渲染 | 计数 + `:7339` |
| **R5** | 无 SPA fallback → 刷新深链接 404 | 用户以为"应用挂了" | 高（`server.js` 实测无 catch-all） | §3.3 + L3 构建校验 + 一条 e2e 刷新测试 | §1.4 |
| **R6** | 缓存策略错配：给 hash 资源设了 `no-cache`（浪费）或给入口 HTML 设了长缓存（更新不生效） | 前者慢、后者"改了没生效" | 中 | §3.3 分流；L3 断言 `dist/index.html` 响应头含 `no-cache` | `server.js:228-230` |
| **R7** | `vs_config` localStorage key 被改名 | 用户 API Key "凭空消失"，表现为偷偷回到 Mock | 🔴 中（很隐蔽） | §5.4 硬约束 + 一条单测守 key 字符串 | `index.html` 唯一 key |
| **R8** | 端口三处既有漂移：`.env.example` 写 3000、`启动.ps1` 硬编码 3001 三处（而 `启动.bat` 是解析 `.env` 的） | 排障方向错；改 `.env` 端口后出现"服务在 A、脚本开 B"的空页面（正是 §2.1 想禁止的故障） | 中 | P0-1 一并修 | `.env.example:172` / `config.js:307` / `.env:78` / `启动.bat:59-64` / `启动.ps1:45,63,77` |
| **R9** | 构建产物体积失控（现单文件 288 KB 未压缩；React 可能更大） | 首屏慢，工具化体验不达标 | 中 | L3 加体积预算断言（如入口 chunk gzip ≤ 200 KB），超了 fail | §1.1 字节数 |
| **R10** | **本机无网络**：版本、体积、`tailwind` 大版本均未核实 | 计划里的依赖表可能是错的 | 高（确定发生） | §6 全部标【未核实】；P1 第一步在有网机器实测并回填 changelog | `npm view` 全失败实测 |
| **R11** | 子页长期不迁 → 退化为被否决的"方案 C" | 两套 token/渲染体系长期维护 | 中 | §7-P3 纪律：不迁的子页必须有"终态不保留"截止日 | changelog 方案 C 否决记录 |
| **R12** | `preview-app.html`（295 KB，与 index 不同哈希）来源不明 | 可能是另一份在维护的副本，一起改会漏 | 低-中 | §11-W6 问 UI；确认前**不动** | 文件哈希实测 |
| **R13** | `#genStatusDot` 既有缺口（`AGENTS.md` §6）在迁移中被"顺手消失" | 侧边栏生成状态点永久不显示且无人登记 | 中 | §5.2 [3] 的处置：要么修 + 测试 + changelog，要么显式白名单；**不许静默** | `index.html:7618` |

---

## 9. 两套并存期：建议多久

### 9.1 结论

**建议 4–6 周，按"里程碑"计 2 个（P2 结束、P5 结束），不按日历硬切。**
**上限 6 周；超过就应当停下来重新评估迁移是否在失控。**

### 9.2 退出条件（必须全部满足，不满足就继续并存）

| # | 条件 | 为什么是硬条件 |
|---|---|---|
| 1 | 5 个页面 + 8 个对话框功能对齐（对照 `frontend-integration-spec.md` 全部条目 + `AGENTS.md` §6 缺口） | 功能不齐就切 = 用户被迫用两套 |
| 2 | §5 的 5 个脚本 + `_selftest.html` 的替代断言全绿，且**断言总数 ≥ 原数** | 否则等于"以迁移为名降低验收标准" |
| 3 | 真实浏览器人工过一遍主流程（输入 → 生成 → 预览 → 导出），有截图/录屏 | `AGENTS.md` §5.4 对研发的硬性验收口径 |
| 4 | 一条**非 mock** 真实任务从创建跑到导出（含 WS 全程） | Mock 跑通证明不了 ffmpeg/耗时/断线重连 |
| 5 | 旧应用的 `/` 与新的 `/app/` 在**同一份数据**上结果一致（抽查 3 条历史任务） | 证明契约没有漂移 |

### 9.3 并存期的三条纪律

1. **`public/index.html` 功能冻结**：只允许修 bug，**新增功能只进 React**。
   否则并行两条线，同一需求要改两遍，双写成本随周数非线性上升。
2. **端口/路径不变**：并存期 `/` 永远是旧应用、`/app/` 永远是新的。任何人不得中途交换。
   （交换会让"我看到的是哪一版"这个问题永久无解。）
3. **每天一次"两边都对"的冒烟**：起服务 → `/` 能建任务 → `/app/` 能建任务 → 两边 `verify --fast` 绿。
   不做的后果：等到 P5 切换那天才发现"旧应用早在三周前就被改坏了"，而那时已经没人记得怎么修。

### 9.4 为什么不是"更长"或"更短"

- **更短（< 3 周）**：5 页 + 8 弹窗 + 48 个内联事件 + 41 处 innerHTML，再加上断言迁移，
  3 周内只能做出"能看不能用"的壳，会触发条件 4 不满足而被迫延长，反而更慢。
- **更长（> 6 周）**：并存期的成本主要在**双写**与**心智负担**（每个 bug 要在两套里定位）。
  超 6 周时，团队会开始"只修旧的那套"（因为它才是用户在用的），迁移停摆。

---

## 10. 哪些部分依赖设计/需求定稿（定稿后可直接落地）

本节是回答"产品在写需求、UI 在出方向，你的文档能不能直接用"。
分两类：**已可执行** 与 **等定稿**。

### 10.1 可以立刻执行（不依赖任何定稿）

| 交付项 | 见 |
|---|---|
| `app/web/` 目录骨架、双包结构、`.gitignore` 增补 | §2.1 §2.3 §2.4 |
| `vite.config.js`（`base:'/app/'` + 7 条代理） | §3.2 |
| `server.js` 的 static 分流 + SPA fallback + **登录墙判定修正** | §3.3 §3.4 |
| 端口表述修订 + `.env.example` 漂移修复 | §4 |
| 6 个脚本 + `_selftest.html` 的迁移映射（逐条） | §5 |
| 门禁补齐（`verify-all` 加 3 个套件） | §5.9 |
| 必装依赖（构建 + 测试栈）与体积实测任务 | §6.1 §6.2 |

### 10.2 依赖定稿（现在只留占位，不写死）

| # | 待定项 | 依赖谁 | 现在能定的默认值 | 定稿后要改哪里 |
|---|---|---|---|---|
| **D1** | 页面信息架构（"创作 / 资产 / 任务"三区的具体归属） | 产品 `task-1` + UI `task-2` | 沿用现有 5 页（create/generating/result/templates/history）+ 侧栏分组 | `web/src/router.jsx`、`web/src/pages/` 与 `components/layout/` |
| **D2** | **人工审核门**：是整组确认还是逐张？驳回回到哪一步？ | 产品 `task-1`（第 2 条）定交互；后端方案已出（`docs/spec/review-gate-design.md`） | `features/review-gate/` + `/app/review/:taskId` 路由占位**不实现**；`lib/ws.js` 按"事件注册表"写（见 §1.3 末）；状态值按该方案用 **`awaiting_review`**（其 §114-125 已论证命名） | 路由 + 新页 + 接入 2 个新 WS 事件（`broadcastReviewRequired/Resolved`）+ 审核决策 API（该方案 §591 的 3 个 API）。**注意**：该方案要求 `awaiting_review` 从 `reconcileInterruptedTasks()` 的回收列表里排除——那是后端的活，但**前端会看到"重启后任务仍在等待审核"**，不能当成卡死 |
| **D3** | design token：色板 / 字体 / 圆角 / 阴影 / 间距基准 | UI `task-2`（9 项决策） | 从 `public/design-system-notion-apple.html`（52 KB，`AGENTS.md` §5.4 指定的 token 基准）提取一版临时 token | `web/src/styles/tokens.css` + `tailwind` 主题层；**组件层不写裸色值**，只引 token |
| **D4** | 图标体系（是否引入 `lucide-react`） | UI | 沿用现有内联 SVG；`components/ui/Icon.jsx` 做一层薄封装 | 换实现只改 `Icon.jsx` 一处（所以先封装） |
| **D5** | 动效预算：预览区允许到什么程度 | UI `task-2` | 工作台：只用 CSS `transition`（≤150ms）+ 骨架屏；预览区：允许 `@keyframes` | 若定稿要求序列动效 → 重新评估 `framer-motion`（§6.3）并走 §4.6 记录 |
| **D6** | 弹窗形态：Modal / Drawer / 内嵌面板 | UI | 迁移期**一律先做 Modal**（与现状一致，零认知成本） | 换形态只改 `components/ui/Overlay` 一处 |
| **D7** | 子页保留清单（哪个子页长期不迁） | 产品 `task-1` 第 3 条（保留/合并/砍） | 全部先"保留原生"（§7-P3 顺序） | 影响 §9.2 条件 1 的范围与 §7-P3 的截止里程碑 |
| **D8** | 成片预览是否需要 HLS / 边转边播 | 产品 + 后端 | 先按 mp4 直链 | 若要 HLS → 引入 `hls.js`（§6.3）并重估首屏预算 |
| **D9** | `preview-app.html` 是否还在维护 | UI | 先不动 | 若确认是死文件 → 归档（需 UI 执行，`public/**` 是 UI 写权限） |

### 10.3 一条给产品/UI 的提醒

上面 **D1–D9 没有一项会阻塞 P0/P1**。也就是说：**迁移可以从今天开始，不必等定稿**。
P0（前置修复 + 基线 + 门禁）与 P1（骨架 + 登录墙链路验证）都只依赖本文的实测事实。
把等待设计定稿的时间用来做 P0/P1，是这段并行期最高效的用法。

---

## 11. 待确认问题清单

| # | 问题 | 问谁 | 若不确认的后果 |
|---|---|---|---|
| **W1** | `AGENTS.md` §2.2 与 changelog 的"5 个脚本静态解析 index.html"要更正为 §1.5 的实测清单（去掉 `verify-frontend-contract`、补上 `verify-skill-prompt` 与 `_selftest.html`）。是否由我直接改 `AGENTS.md`？ | lead | 下一个人会按错误清单做事，对该脚本做无意义改写 |
| **W2** | 并存期采用 `/app/*` 路径隔离（方案 C）是否认可？ | lead + 产品 | 若否，退 A 方案则必须在"新应用能跑"之前不允许合并，风险集中 |
| **W3** | `dist/` 不入库意味着"部署机必须能构建"。现有 `启动.bat` 是 clone 即跑，是否接受这一改变？ | lead + 产品 | 部署流程变化，可能影响交付节奏 |
| **W4** | `verify-all.js` 新增 `frontend-unit`（vitest）套件，意味着**验收机器需要 `web/node_modules`**。是否接受？ | lead | 否则 L2 那 30+ 条断言只能手工跑，等于没有门禁 |
| **W5** | 成片播放是否需要 HLS（决定 `hls.js`）？ | 产品 | 若需要而后补，预览层要重写 |
| **W6** | `public/preview-app.html`（295 KB，与 index.html 不同哈希）是什么？还在维护吗？ | UI | 可能是"另一份在改的文件"，迁移时漏掉它会出双份行为 |
| **W7** | 迁移是否允许"顺手修 `#genStatusDot` 缺口"？ | lead | 不允许则 §5.2 [3] 要走"白名单 + 等效分析"的复杂路径 |
| **W8** | 人工审核门（D2）预计何时定稿？是否要在本期预留路由占位？ | 产品 | 定稿太晚可能导致 P2 的页面结构返工 |

---

## 12. 附录：可复述的实测命令

本文所有【实测】数字都可用下面命令复现（工作区根目录执行，PowerShell）：

```powershell
# 1) index.html 体量
(Get-Item 'app\public\index.html').Length          # 295076
(Get-Content 'app\public\index.html' -Encoding UTF8).Count   # 8061

# 2) 结构边界
Select-String -Path 'app\public\index.html' -Pattern '<style|</style>|<body|<script|</script>|</html>' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }

# 3) 页面容器与弹窗
Select-String -Path 'app\public\index.html' -Pattern 'id="page-[A-Za-z\-]+"' | % { $_.Matches.Value }
Select-String -Path 'app\public\index.html' -Pattern 'class="modal-overlay"' | % { "$($_.LineNumber): $($_.Line.Trim())" }

# 4) 计数类
$t = Get-Content 'app\public\index.html' -Raw -Encoding UTF8
([regex]::Matches($t,'onclick=')).Count      # 48
([regex]::Matches($t,'onchange=')).Count     # 4
([regex]::Matches($t,'innerHTML')).Count     # 41
([regex]::Matches($t,'^\s*(async\s+)?function\s+\w+')).Count   # 136

# 5) 前端 API 族与 WS 事件
[regex]::Matches($t,'/api/[A-Za-z0-9_\-/{}$\.]+') | % { $_.Value } | Sort-Object -Unique
Select-String -Path 'app\public\index.html' -Pattern "msg\.type ===" | % { $_.Line.Trim() }

# 6) 后端路由总数
(Select-String -Path 'app\server.js' -Pattern '^app\.(get|post|put|delete|patch)\(' -AllMatches).Count   # 60

# 7) 登录墙与 static 实现区间
Select-String -Path 'app\server.js' -Pattern 'isPage|express\.static|app\.use\(' | % { "$($_.LineNumber): $($_.Line.Trim())" }

# 8) 谁真的读 index.html
Select-String -Path 'app\scripts\*.js' -Pattern "public[/\\]index\.html" | % { "$($_.Filename):$($_.LineNumber)" }

# 9) verify-all 的套件清单
Select-String -Path 'app\scripts\verify-all.js' -Pattern "name: '" | % { $_.Line.Trim() }

# 10) 断言调用点计数（迁移前后对比用）
foreach ($f in 'verify-frontend-static','verify-transition-ui','verify-recovery-fixes','verify-frontend-contract','verify-skill-prompt') {
  $n = (Select-String -Path "app\scripts\$f.js" -Pattern '^\s*(assert|check|ok)\(' -AllMatches).Count
  "$f : $n"
}

# 11) 端口漂移
Select-String -Path 'app\config.js' -Pattern "PORT'" | % { "$($_.LineNumber): $($_.Line.Trim())" }
Select-String -Path 'app\.env.example' -Pattern 'PORT' | % { "$($_.LineNumber): $($_.Line.Trim())" }

# 12) 新增依赖的真实版本与体积（**需联网**，本机不可用）
# npm view vite version license dist.unpackedSize
```

---

## 13. 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-10-26 | 初版。基于 `index.html` 8061 行 / 288.2 KB、60 条路由、16 个 verify 套件、58 个脚本的实测；更正既有文档关于"5 个脚本静态解析 index.html"的三处口径错误；给出 6 个脚本 + 1 个浏览器自检页的逐条迁移映射 | 本文 §1 §5 |
