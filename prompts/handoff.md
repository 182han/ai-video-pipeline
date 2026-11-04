# 交接（2026-11-04 18:05）

> 新窗口先读：`AGENTS.md` → `PROGRESS.md`「当前任务」与「交接状态」→ `FEATURES.md` D 节（F01–F12）→ 本文件。
> 这一轮只读，不要改代码、不要重启服务，先回答 PROGRESS 里的 5 问，等人类确认。

## 当前事实

- 仓库根：`C:\Users\14872\Desktop\测试\app`（git 在 app/ 下）
- HEAD：以 `git log --oneline -3` 为准（最新提交是本次交接 docs）
- 工作区：仅 `data/logs/console-3001.log.err` 与 `web/verify/`，都是别人遗留的噪音；**没有未提交代码**
- 服务：`node server.js` → `http://localhost:3001`；剪辑台 `http://localhost:3001/app/edit`
- 用户当前工程：`proj_mw1umy7m2o3t`（3 段 + Magistar 音乐 + Pixabay 环境音）

## 已完成（M1 + M2）

- M1：transitionMixer 导出链重做（spawn/filter 文件/短路径/进度/取消/硬编）、工程草稿、工作台、素材面板、时间线、导出。
- M2：F05 每段调节（基础 10 项，逐段 LUT）、F06 WebGL 实时预览（含预览音频）、F07 音频两轨、F09 转场控件、F10 片段库详情、F11 导航重组、F01c 从成片重建。
- 验证：M2 收口 14 套件 299/0；热修后 shell 25/0、preview 28/0、timeline 29/0、audio 22/0。

## 未决问题 1（先复验）

用户最后一次反馈：**「放大后又卡住了」**。

- 已做：`.ed-main.theater` 单列；`.ed-stage` 限高 + `overflow:hidden`；`.ed-frame max-height:100%`；canvas `object-fit:contain`（`f7b9028`）。
- 未做：用户复验。
- 若仍卡，先判断两种现象：
  1. 整页无响应（连「打开/导出」都点不动）→ 查 ResizeObserver 循环 / 渲染异常；
  2. 只有画面区域点不动、播放条正常 → 查 canvas 是否覆盖播放条、pointer 命中。
- 文件：`web/src/preview/engine.js`、`web/src/screens/editor.js`、`web/styles/editor.css`。

## 未决问题 2（F12，下一窗口做）

用户要求补 **HSL / 曲线 / 色轮**，**蒙版不做**（FEATURES D1 #12）。已从右侧 tab 删除「蒙版」，FEATURES 已登记 F12；三个 tab 目前是占位（点击提示“后续版本接入”）。

### 后端已具备（不要重写颜色数学）

`src/processors/adjustChain.js` 的 `normalizeParams` 已支持，LUT / 导出链会自动生效：

- `hsl`：8 个色相带，每带 `[h, s, l]`，各 `-100..100`；存储 `adjust.hsl[8][3]`
- `curve`：3 条曲线（R/G/B），每条是 `[[x,y], ...]` 控制点，`x,y` 归一化 `0..1`；存储 `adjust.curve[3][n]`
- `wheel`：`{ lift:{r,g,b,y}, gamma:{...}, gain:{...} }`，值 `-1..1`（0=不变）；存储 `adjust.wheel`
- 基础 10 项：`temperature/tone/saturation/brightness/contrast/highlight/shadow/white/black/lightSensation`

### UI 范围建议（v1）

- HSL：8 个色带标签 + 3 个滑杆（色相/饱和度/明度），每段独立、可重置；
- 曲线：RGB 三通道 + 一条合成线，画布拖点（至少支持默认 5 点：0/0、0.25/0.25、0.5/0.5、0.75/0.75、1/1）；
- 色轮：lift/gamma/gain 三个轮（或 3×3 数值滑杆），映射到 `wheel[zone].r/g/b`；
- 所有修改走 `adjust` 保存到 `segments[].adjust`，预览与导出同一套 LUT；
- **不要做蒙版**，也不要在 UI 里再出现「蒙版」。

### 验收脚本（先写红）

新增 `scripts/verify-adjust-advanced.js`，至少：

1. `POST /api/adjust/lut` 带 `hsl/curve/wheel` → 返回非空、字节数正确；
2. LUT 与恒等 LUT 有差异（逐点）；
3. 真实导出（1 段）带 HSL/曲线/色轮 → 与不带参数的产物有像素差；
4. 静态检查：编辑器有 HSL/曲线/色轮面板、没有「蒙版」；
5. 保存/重开工程后 `adjust.hsl/curve/wheel` 原样保留。

跑通过的现有套件：`verify-editor-preview.js`（28/0）、`verify-editor-adjust.js`（17/0）、`verify-editor-export.js`（24/0）。

## 未验证 / 已知限制

- 浏览器视觉与交互：本环境无可用浏览器，全部只做了静态/API/语法验证，需人类目测。
- F06 的 24fps 与真实像素差未测；LUT 颜色数学均值差 0.046%–0.133%。
- F09 预览只做叠化，擦除/滑动等类型只在导出体现。
- F10「重新生成」未在验收中真实触发。
- M3 30 分钟真实素材 + BGM 长片还没测。
- 蒙版：**明确不做**。

## 新窗口第一句话（人类可直接贴）

```
cd "C:\Users\14872\Desktop\测试\app"

你接手一个进行中的项目。这一轮只读，禁止改代码、禁止重启服务、禁止 git commit。

按顺序读：
1) AGENTS.md
2) PROGRESS.md 的「交接状态（2026-11-04 18:05）」
3) FEATURES.md D 节（F01–F12）
4) prompts/handoff.md

再用命令核实：
- git status --porcelain
- git log --oneline -5
- 检查 3001 是否在跑：Invoke-WebRequest http://localhost:3001/api/status

然后只回答 5 个问题，答完停下，不要开工：
Q1 项目目标一句话。
Q2 M1/M2 做到哪一步？最近 3 个热修分别修什么？
Q3 当前两个未决问题是什么？下一窗口的第一、第二个动作分别是什么？
Q4 F12 的范围是什么？哪些明确不做？后端已支持哪些参数形状？
Q5 文档、代码、git 之间有没有矛盾？

硬性注意：
- data/logs/console-3001.log.err 和 web/verify/ 是别人遗留，不要动、不要提交。
- 不要相信“已修复”，以用户复验为准。
- 不要创建新 goal，不要开始 M3，先等我确认。
```
