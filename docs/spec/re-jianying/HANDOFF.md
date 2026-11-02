# 交接：剪映逆向调研 + 前端「剪辑」页改造

> 日期：2026-10-27（第二版，含提交与逐脚本验收）
> 工作区：`C:\Users\14872\Desktop\测试` ｜ 代码仓库：只有 `app/`
> 上一版遗留的 3 个必办项已全部处理；本版可直接作为 React 实施的起点。

---

## 1. 现状

- **后端流水线未改动**（`src/` 一行没动）。
- 前端改动 **5 条提交已落地，工作区干净**：

| commit | 内容 | 变更 |
|---|---|---|
| `dfab556` | 补 `.page-container` 缺失的闭合 `</div>`（单独提交，便于单独回滚） | +1 |
| `4d38872` | 剪辑页换剪映深色皮肤 + 点开即编辑器 + 失败兜底 | +173 / −17 |
| `8283549` | 历史记录每条成片加「剪辑」入口 | +23 |
| `d52e61a` | `verify-pages` 自起临时服务，不再打 3001 | +122 / −15 |
| `51d34ae` | `verify-editor-dom` 修「引用 id 数量 0」的空转断言 | +14 / −4 |

- 分析产物 8 份在 `docs/spec/re-jianying/`（不在 git 仓库内，仅本地）。

---

## 2. 环境与限制（踩过的坑，必读）

| 项 | 事实 |
|---|---|
| 启动 | `cd app && node server.js`，端口 **3001**；页面与 `/api/*` 需登录，`/output` `/clips` `/bgm` 不拦 |
| 技术栈 | Node + Express，前端**零构建原生 HTML/CSS/JS**（React+Vite 迁移**尚未开始**） |
| ffmpeg | `app/tools/ffmpeg/bin/`，经 `config.FFMPEG_PATH` 取，不要硬编码 |

**四条硬限制：**

1. **没有可用浏览器**：`dsh_browser_*` 报 electron 不可用 → 页面**视觉/布局无法自查**，只能做结构+语法+接口验证，最终要人工目测。
2. **`node scripts/verify-all.js --fast` 在本机会 `spawn EPERM` 挂掉** → 它**不是**验收依据，请逐脚本单跑（见 §5）。
3. **Windows PowerShell 5.1 读 UTF-8 无 BOM 的 `.ps1` 会按 ANSI 解析** → 含中文的校验脚本会解析失败。一律写成纯 ASCII `.ps1` 或 `.mjs`。
4. **沙箱禁止 Node 用管道捕获子进程输出**（`spawn` 默认 `stdio:'pipe'` → EPERM）。跑 ffmpeg / 起子进程一律 `stdio:'ignore'`，结果落文件再读。

外部约束：剪映目录（`D:\JianyingPro`、`D:\JianyingPro Drafts`）全程**只读**，未启动 GUI、未联网。

---

## 3. 分析产物（`docs/spec/re-jianying/`）

| 文件 | 内容 | 强度 |
|---|---|---|
| `jy-protocol.md` | XMLDraft 协议：轨道/时间算术/转场/音量/节拍/响度开关，带 `文件:行号` | 每条可复核 |
| `jy-native-audio.md` | 拍点任务参数、镜头检测配置、响度目标值、配乐拼接契约 | 观测/推断/未知分列 |
| `jy-draft-cipher.md` | 草稿加密**未解开**，已定位 3 个函数 RVA | 含 6 条负向证据 |
| `decode-draft.mjs` | 复现上述数字；`--plain` 等明文就绪 | 可直接跑 |
| `jy-splice-music-spec.md` | 复刻规格：可照抄规则 + 与本项目代码逐条差异 | — |
| `proto/ducking-check.mjs` | 闪避原型（**已决议不接入**，见 §6） | 实测通过 |
| `ui/jianying-editor.html` | 剪映风设计样张（未接入） | 结构校验通过 |
| `HANDOFF.md` | 本文件 | — |

### 结论速查

- 「拼接」= 主轨**文档顺序**；主轨片段不写 `start`，只写 `duration` / `material_start` / `speed`。
- 转场是**边界属性**，只能挂有后继的左侧片段，末段禁止；推荐 **300–800ms**；**不参与主轨时长累计**。
- BGM 只能在副轨；`volume` 是**线性幅度百分比**（100=原幅，0–1000）；压原声 **30–60**、突出音乐 **120–200**。
- 响度统一目标：**-23 / -12 / -12 / -14 LUFS**（默认/抖音/TikTok/YouTube），ebur128，区间 `[-70,0]`。
- 配乐铺满：`loop_order`（可重复）+ `cross_fading_frame_len`（**帧**）+ `beat_times`。
- 剪映 PC 端**没有 ducking / EQ**。

---

## 4. 代码改动（已提交）

### 4.1 `app/public/bgm-editor.html`（`4d38872`，+173 / −17）

1. **剪映深色皮肤**：`<style>` 末尾覆盖层，token 取自剪映内置 Web 的 `video-edit` 主题
   （`#141414/#1c1c1c/#262626`、正文 `#e0e0e0`、播放头 `#00cae0`、视频片段 `#243743`、圆角 8）。
   canvas 绘制的标尺/波形/片尾线一并改色；内联浅色 2 处改 `var()`。**未动任何选择器语义与业务逻辑。**
2. **点开即编辑器**：`init()` 默认 `openLibraryEditor()`；保留 `?task=<id>` 供历史记录跳转；
   顶部按钮改「← 返回工作台」。
3. **失败兜底**：`init()` 包 `try/catch` → `fallbackToList()`（回列表 + 提示原因）。
   并且修掉了**根因**：`openEditor` 原用 `fetch(...).then(r=>r.json())`，404 的 `{error}` 被当正常数据，
   不抛错、直接进 `DURATION=0` 的空编辑器。现在校验 HTTP 状态 + `videoUrl`；
   `openLibraryEditor` 的片段库请求也不再静默降级为空库。

### 4.2 `app/public/index.html`（`dfab556` + `8283549`）

- `dfab556`：补 `.page-container` 的闭合 `</div>`（此前靠 `</main>` 自动兜底）。**单独提交，出问题可单独回滚。**
- `8283549`：历史记录每条 `completed/partial` 成片加「剪辑」按钮 → `/bgm-editor.html?task=<id>`；新增 `.history-clip-btn`。

### 4.3 测试脚本（`d52e61a` + `51d34ae`）

- `verify-pages.js`：旧版打固定 3001 + 跟随 302 → 4 个页面全是登录页（10317B）却报 PASS，且写死 taskId。
  现在自起临时服务（`PORT=3099 AUTH_ENABLED=false DATABASE_TYPE=json`），逐页核对**页面专属标记**并拒绝登录页，
  任务 id 从数据动态取，无数据记 SKIP（不计入通过）。
- `verify-editor-dom.js`：旧正则只认 `$('x')`，实际用 `byId('x')` → 提取到 0 个引用、断言空转。
  现在三种写法都提取（实提 28 个，全命中），且提取不到时直接 FAIL。

---

## 5. 验收（逐脚本单跑，`verify-all --fast` 不用）

| 脚本 | 结果 | 退出码 |
|---|---|---|
| `check-inline-js.js` | PASS 2 块（index / bgm-editor） | 0 |
| `verify-frontend-static.js` | **43 通过 / 0 失败** | 0 |
| `verify-editor-dom.js` | 引用 28 个全部命中；内联事件函数全定义 | 0 |
| `test-editor-logic.js` | 全部通过 | 0 |
| `verify-skill-prompt.js` | **101 通过 / 0 失败** | 0 |
| `verify-transition-ui.js` | **22 通过 / 0 失败** | 0 |
| `verify-pages.js` | **5 通过 / 0 失败**；4 页字节数各不相同（272596 / 65734 / 16215 / 27792），自动配乐草稿动态取到 `task_mvhrynuu_ehtn` | 0 |

**假绿对照（负向证据，证明修复有效）：**

```
真实登录墙服务（AUTH_ENABLED=true, 3098）
  follow_redirect（旧脚本行为） : status=200  bytes=10317  isLoginPage=true   ← 与用户观测一致
  manual_redirect（新脚本做法） : status=302  bytes=42     isLoginPage=false
  new_rule_verdict              : pass=false               ← 新规则正确拒绝
```

**`verify-editor-dom` 负向验证**：把 `byId('stageHint')` 改成不存在的 id → `FAIL 缺少 id: __nope_missing__`，退出码 1；随后已还原。

### 仍未验证

- **所有页面视觉/布局/手感**：本机无浏览器，按团队口径为「**未验证**」，不是通过。需人工打开
  `http://localhost:3001/` 与 `/bgm-editor.html` 目测（重点：配乐片段对比度、标尺数字亮度、属性面板弹层）。

---

## 6. 已决议（`docs/spec/changelog.md` 同步记录）

1. **主题分层**：写入 `docs/spec/ui-theme-rule.md` —— **深色=正在看画面（剪辑/影院/登录），浅色=操作（工作台/列表/表单）**；不整体换深色。
2. **成片响度**：`-20` → **`-16 LUFS` / `TP=-1.5 dBTP` / `LRA=11`**（Android TV 屏保长播的中间档）。
   **未落地**；改动点 `audioMixer.buildMixArgs`（`loudness` 默认值）与 `bgmPlan.buildMixCommand` 的 `loudnorm`，改完须真机 A/B + `volumedetect` 实测。
3. **ducking：不做**。生成片段默认无原生音轨，没有可保护的人声；剪映 PC 端也没有此功能。
   原型保留在 `proto/ducking-check.mjs`（−8.7 dB @ `threshold=0.12:ratio=4`），将来有原声再启用，不要另写。

---

## 7. 未完成 / 待决

| # | 事项 | 说明 |
|---|---|---|
| 1 | `bgm-editor.html` 的旧成片列表 `#listView` 仍在 DOM（永不显示） | 死代码。删除需同时改 `openEditor` / `backToList` / `loadTasks` 三处（`byId('listView')` 无 null 保护） |
| 2 | 响度 `-16 LUFS` 未落地 | 见 §6.2 |
| 3 | 草稿解密未解 | 需反汇编器或 Frida hook；优先级低（协议层已够用） |
| 4 | 分析文档未入库 | `docs/` 不在 git 仓库内，仅本地文件 |
| 5 | React 迁移（对方实施） | 会改 `server.js` 的静态下发；前端断言脚本需同步重写（`check-inline-js` / `verify-frontend-static` / `verify-editor-dom` / `test-editor-logic` / `verify-pages` 都依赖现有 HTML） |

---

## 8. 复现命令

```powershell
# 逐脚本验收（不要用 verify-all --fast）
cd "C:\Users\14872\Desktop\测试\app"
node scripts/check-inline-js.js
node scripts/verify-frontend-static.js
node scripts/verify-editor-dom.js
node scripts/test-editor-logic.js
node scripts/verify-skill-prompt.js
node scripts/verify-transition-ui.js
node scripts/verify-pages.js        # 自己起临时服务，不碰 3001

# 人工目测（起正式服务后）
node server.js                      # http://localhost:3001/
#   → 侧栏「剪辑」应直接进深色编辑器
#   → 历史记录每条已完成成片后有「剪辑」
```

## 9. 关键文件索引

```
app/public/bgm-editor.html     剪辑页（深色皮肤 + 直接进编辑器 + 失败兜底）
app/public/index.html          工作台（历史记录「剪辑」入口；容器闭合已修）
app/scripts/verify-pages.js    页面/接口自检（自起 3099）
app/scripts/verify-editor-dom.js  DOM 引用与内联事件检查（已修空转）
docs/spec/ui-theme-rule.md     主题分层规则（新增）
docs/spec/changelog.md         2026-10-27 两节：逆向结论 + 三项决议
docs/spec/re-jianying/         8 份分析产物
```
