# PROGRESS — 剪映「调节」模块交接（2026-11-02）

## 项目目标
一句话提示词 → 自动分镜 → 批量生成 → 质检 → 拼接配乐 → 适合 Android TV 屏保循环长片；
本任务只负责：把剪映「调节」模块复刻进后端。

## 已完成功能
- 剪映调节逆向 + 实现（12 项点式 + HSL/曲线/色轮）：`1c39bcc`
- 后端接线（config / taskManager / pipeline / videoProcessor，默认关闭）：`1c39bcc`
- 独立 CLI `scripts/apply-adjust.js`：`1c39bcc`
- 自研 LUT（替换剪映资源）+ 运行时自检闸：`b17bbdd`
- 注：根目录 `docs/spec/re-jianying/*` **不在 git 仓库内**（仓库根是 `app/`），未纳入版本管理。

## 当前任务
剪映「调节」模块复刻。验收标准原文：

> 完成剪映「调整」模块的逆向与实现：把基础调节（亮度/对比度/饱和度/色温/色调/高光/阴影/白色/黑色/光感/锐化/清晰/颗粒/褪色/暗角）、HSL、曲线、色轮逐项复刻为可运行代码，并用 C:\Users\14872\Desktop\风景照片\对照 下的对照视频逐项验证 PSNR，记录到 docs/spec/re-jianying/jy-adjust.md。全部算法在 proto/ 跑通后，后端落进 app/src（研发范围）。到达需要改 app/web 面板 UI 的那一步前停止并提醒用户，不擅自改 UI。

## 断点五要素

### 1. 目标与验收标准
见上「当前任务」原文。当前进度：**后端已完成并验证；UI 未做，且按约定必须由用户授权后才能动 `app/web/**`。**

### 2. 已改文件（完整路径）
**已提交（`1c39bcc` + `b17bbdd`）**
- `app/config.js`（新增 ADJUST 段，默认 false）
- `app/src/taskManager.js`（解析 options.adjust，白名单+钳制）
- `app/src/pipeline.js`（`_adjustOptionsFor()`、`_assertAdjustApplied()`、3 处转码调用）
- `app/src/videoProcessor.js`（`adjustFilter`/`adjustCwd`；`_runFFmpeg(cmd, opts)` 支持 cwd）
- `app/src/processors/adjustChain.js`（新，复刻实现 + `loadCube` + 自研 fade）
- `app/scripts/apply-adjust.js`（新，CLI）
- `app/scripts/verify-adjust-chain.js`（新，13 项）
- `app/scripts/verify-adjust-pipeline.js`（新，12 项，含负向用例 E）
- `app/scripts/build-adjust-lut.js`（新，LUT 生成器 + 镜像模式）
- `app/assets/adjust/lightSensation_max.cube`、`lightSensation_min.cube`（新，自研 33³）
- `app/.env.example`（3 个 ADJUST_*）、`app/.gitignore`（`data/adjust/`）
- 已删除：`app/assets/adjust/{lightSensation_max.png, lightSensation_min.png, fade_max.texture}`

**未提交（不在 git 仓库内，需手动备份）**
- `docs/spec/re-jianying/jy-adjust.md`（主报告，§1–§15）
- `docs/spec/re-jianying/adjust-integration-plan.md`
- `docs/spec/re-jianying/adjust-api-contract.md`
- `docs/spec/re-jianying/proto/`（分析脚本 + `app-module/adjustChain.js` 源 + `cubes/`）

### 3. 当前测试状态
**全绿，无红灯。** 2026-11-02 13:45 实测，11 个套件逐个 EXIT=0：
stages 45/0、frontend-static 43/0、stats 42/0、pipeline-fixes 28/0、mock-vqc 14/0、
skill-prompt 109/0、skill-ai-path 17/0、stage-pipeline 37/0、adjust-chain 13/13、
adjust-pipeline 12/0、transition-ui 22/0。

唯一异常：`node scripts/verify-all.js --fast` 仍 `EXIT=1`（`spawn EPERM`，环境限制，
AGENTS §2.6 已认可改为逐个套件跑）。**不是代码缺陷。**

### 4. 下一步第一个具体动作
不涉 UI 的第一步：打开 `app/.env`，末尾追加
```
ADJUST_ENABLED=true
```
然后 `cd app && node server.js` 启动（当前 3001 无监听），
再 `POST /api/tasks` 带 `"adjust":{"brightness":10}`，确认 `GET /api/tasks/:id` 回显
`adjust` 且任务日志出现 `调节滤镜: lut3d=...`。

若用户授权改 UI：先读 `app/web/src/screens/create.js` 与任务提交封装，
确认 `POST /api/tasks` 的 body 构造位置，把 `adjust` 并入；字段契约见
`docs/spec/re-jianying/adjust-api-contract.md`。

### 5. 需要人来拍板的设计决策
1. **UI 归属**：`app/web/**` 属 UI 写权限，是否授权研发改。
2. **`verify-adjust-pipeline.js` 是否注册进 `verify-all.js`**（建议进 `real` 组；该文件近期被别人改过）。
3. **是否接受两个近似**：`lightSensation_min.cube` 由 max 镜像生成（无对照）、褪色改为自研公式（无对照）。
4. **根目录 `docs/` 游离于 git 之外**：是否需要另建版本管理。
5. 本文件覆盖了另一会话的 PROGRESS.md（其内容可从 `6410788` 取回）。

## 已知问题
- 高光/白色/黑色：参数映射取自引擎 Lua 原文，但**无图像对照**，未验证。
- 锐化/清晰/颗粒/暗角：ffmpeg 滤镜近似，**不是逐像素复刻**；HSL 亦无对照。
- 光感自研 LUT 比剪映原表低约 2.5 dB（38.0–38.4 vs 40.95）。
- 同一工作区还有另一会话在改 `server.js` / `verify-all.js` / 登录页；
  `1c39bcc` 把两个会话的改动混在同一 commit（提交信息未逐条列出，违反 AGENTS §8）。
- `data/logs/` 被误提交进仓库。
- 无 UI 面板 → 功能目前只能经 API 或 CLI 触发；`.env` 未开启。

## 试过但失败的方向
- 逐通道 1D 曲线拟合光感：29.77 dB，不够（光感是强三位相关变换）。
- 亮度曲线 + 色度增益模型：28.88 dB，更差。
- 迭代式残差分摊：发散（10.57 → 18.48 dB），改为一次性加权平均。
- 17³ 网格：仅 37.0 dB；改 33³ 得 38.5 dB。
- `lut3d` 用绝对路径：`C\:` 转义与正斜杠均报 `Undefined constant`；只能 cwd + 相对文件名。
- PowerShell 内联 `node -e` 传 JSON/引号多次被吃掉；一律改为写 `.mjs`/`.js` 脚本文件。
- 用 `Select-String` 管道读取 node 输出会导致假 `EXIT=1`（broken pipe），要重定向到文件再判断。
- 本机早前无 git（现已可用），当时只能按 mtime 判断并发改动风险。
