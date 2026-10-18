# V2 实施 Spec（研发执行用）

> 版本：v2.0 · 日期：2026-10-10
> 执行者：研发 Agent · 前置阅读：`app/spec/mvp-roadmap.md`（决策依据）
> 原则：本 spec 自包含。所有路径基于 `app/` 现有代码实际结构，可直接按 §2-§8 顺序执行。

---

## 1. 实施总览

| 序号 | 模块 | 文件 | 预估 |
|------|------|------|------|
| 1 | 配置层调整 | `config.js` | 0.5h |
| 2 | Kling 适配器修正 | `src/generators/kling.js` | 1-2 天 |
| 3 | 流水线模式化 | `src/pipeline.js`、`src/taskManager.js` | 2-3 天 |
| 4 | 超分模块 | 新增 `src/processors/upscaler.js`（Video2X 薄封装） | 0.5 天 |
| 5 | 配乐模块 | 新增 `src/processors/audioMixer.js` + `assets/bgm/` | 1 天 |
| 6 | HDR 模块 | 新增 `src/processors/hdrConverter.js` | 0.5 天 |
| 7 | 提示词升级 | 新增 `src/services/llmService.js`（LLM 真分镜）+ `src/promptOptimizer.js` 模板扩充 | 1-2 天 |
| 8 | 一键复跑 | `run.config.json` 落盘 + replay 接口 | 1 天 |
| 9 | 前端模式选择器 | `public/index.html` | 1 天 |

**前置决策门（迭代 0，先于一切代码改动）**：免费网页额度盲测 Kling 3.0 4K vs Seedance 2.5 1080p+超分。若 Seedance 明显更优，§3 适配器修正对象改为 seedance.js，其余模块不受影响（适配器架构隔离）。

---

## 2. 配置层 — `app/config.js`

```js
GENERATION: {
  concurrency: 3,
  maxRetries: 1,
  defaultClipDuration: 15,      // 30 → 15（决策 D2）
  defaultResolution: '1080p'    // 720p → 1080p（决策 D4；4K 由前端档位选择）
},

// 新增：五档执行模式预设
PIPELINE_MODES: {
  draft:    { concat: true,  loop: false, upscale: false, hdr: false, audio: false, transcode: true },
  standard: { concat: true,  loop: true,  upscale: '4K',  hdr: false, audio: true,  transcode: true },
  delivery: { concat: true,  loop: true,  upscale: '4K',  hdr: true,  audio: true,  transcode: true },
  segments: { concat: false, loop: false, upscale: false, hdr: false, audio: false, transcode: false },
  // custom: 前端勾选组合，经依赖校验后生成同结构对象
},

// 新增：后处理配置
POST_PROCESS: {
  upscaler: {
    engine: 'video2x',             // Video2X 外部 CLI（内部引擎 realesrgan；AGPL-3.0，仅独立进程调用，不复制/链接其源码）
    exePath: '',                   // video2x 可执行文件或 Docker 命令，空 = 未安装
    targets: ['4K', '8K']          // 4K→8K 为 2x；1080p→4K 为 2x
  },
  audio: {
    bgmDir: './assets/bgm',
    loudness: -20,                 // LUFS
    fadeSeconds: 2
  },
  hdr: { enabled: false, standard: 'HDR10' }  // 默认关，展厅链路验证后开
}
```

---

## 3. Kling 适配器修正 — `src/generators/kling.js`

现状：占位实现，端点 `/videos/generations` 与简单 Bearer 鉴权未经验证。

**必须对照可灵官方文档（app.klingai.com/cn/dev/document-api）修正：**

1. **鉴权**：可灵 API 使用 JWT（ak/sk 签名生成 token），不是静态 Bearer。config.js 需拆分为 `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` 两个字段，适配器内实现 JWT 生成（`jsonwebtoken` 包或手写 HS256）
2. **端点**：文生视频 `POST /v1/videos/text2video`；图生视频 `POST /v1/videos/image2video`（首尾帧衔接备用）
3. **参数**：4K 传 `"resolution": "3840x2160"`；15 秒档 `duration: 15`；确认 4K 是否需要特定 model 版本（kling-v3）
4. **状态查询**：对照官方任务查询端点修正 `getStatus` 的字段映射
5. **错误处理**：
   - `canRetry` 增加：402（余额不足）**不可重试**；429（限流）指数退避可重试
   - **失败降档**：4K 生成失败后的唯一一次重试降为 1080p（控制 ¥45/段的意外成本），并在 clip 记录中标注 `downgraded: true`

验收：用真实 key 成功生成 1 段 4K 15s 风光视频并下载到 `clips/`。

---

## 4. 流水线模式化 — `src/pipeline.js` + `src/taskManager.js`

### 4.1 步骤定义扩展（taskManager.js `PIPELINE_STEPS`）

```js
const PIPELINE_STEPS = [
  // 核心链（必选，category: 'core'）
  { key: 'prompt_optimize', name: '提示词优化',   category: 'core', required: true },
  { key: 'storyboard',      name: '分镜头生成',   category: 'core', required: true },
  { key: 'clip_generation', name: '视频片段生成', category: 'core', required: true },
  // 增强层（可选，category: 'post'，执行顺序即数组顺序）
  { key: 'concatenation',   name: '视频拼接',     category: 'post', modeKey: 'concat' },
  { key: 'loop_processing', name: '无缝循环处理', category: 'post', modeKey: 'loop' },
  { key: 'upscale',         name: '画质超分',     category: 'post', modeKey: 'upscale' },  // 新增
  { key: 'hdr',             name: 'HDR 转换',     category: 'post', modeKey: 'hdr' },      // 新增
  { key: 'audio_mix',       name: '配乐混音',     category: 'post', modeKey: 'audio' },    // 新增
  { key: 'transcoding',     name: '转码导出',     category: 'post', modeKey: 'transcode' },
  { key: 'final_qc',        name: '最终综合质检', category: 'final', required: true }
];
```

### 4.2 任务结构（taskManager.js `createTask`）

新增字段：
```js
task.pipelineConfig = {
  preset: 'draft' | 'standard' | 'delivery' | 'segments' | 'custom',
  steps: { concat: true, loop: true, upscale: false|'4K'|'8K', hdr: false, audio: false|{track}, transcode: true }
};
task.stepStatus = { /* 每步: pending|running|completed|failed|skipped */ };
```

### 4.3 执行逻辑（pipeline.js）

- `_runPipeline` 改为遍历 `PIPELINE_STEPS`，对 `category: 'post'` 的步骤检查 `task.pipelineConfig.steps[modeKey]`，关闭则标记 `skipped` 并跳过
- **依赖校验**（任务创建时执行，不合法直接拒绝）：
  - `upscale / hdr / audio / transcode` 为开 → `concat` 必须为开（超分整片执行，避免逐段帧间闪烁）
  - `hdr` 为开 → `upscale` 必须先于 hdr 执行（顺序已由数组保证，仅校验 concat）
  - `loop` 关闭且 `concat` 关闭 → 即 segments 模式，产物为片段包 + 剪辑清单
- **补跑接口**：`resumeFrom(taskId, stepKeys[])`
  - 校验核心链已完成、所请求步骤的前置依赖产物存在（如补跑 upscale 需存在 `master_*.mp4`）
  - 补跑只执行指定步骤及其后置已开启步骤，**绝不重新进入 clip_generation**

### 4.4 产物目录标准化（output/{taskId}/）

```
output/{taskId}/
├── run.config.json          # 全参数快照（§8）
├── segments/                # 片段（从 clips/ 归档）
├── master_1080p.mp4         # 拼接+循环后的基准母版
├── final_4k.mp4             # 超分产物（若开启）
├── final_hdr.mp4            # HDR 产物（若开启）
├── final_audio.mp4          # 配乐产物（若开启）
├── final_delivery.mp4       # 转码封装最终交付物
└── report.json              # 成本/耗时/质检汇总（协作交付考察点）
```

---

## 5. 超分模块 — 新增 `src/processors/upscaler.js`（Video2X 薄封装）

```js
async function process(inputPath, outputPath, { targetResolution, onProgress })
```

- **决策 D11**：不自研 Real-ESRGAN 封装（原 1-2 天），改为 **Video2X 外部 CLI 薄封装**（0.5 天）
- 引擎：Video2X（`ghcr.io/k4yt3x/video2x` Docker 镜像或本地可执行文件，内部引擎 `realesrgan`）
- 调用方式：`upscaler.js` 仅 `spawn` 子进程 + 传参 + 解析退出码，**不引入其代码到本项目**（规避 AGPL-3.0 传染）
- 命令骨架：`video2x -i in.mp4 -o out.mp4 -p realesrgan -s 2`；可选附加 RIFE 补帧至 30/60fps（展厅大屏流畅度）
- 1080p→4K / 4K→8K 均为单级 2x
- **环境检测**：启动时探测 exePath/Docker 可用性；不可用时步骤直接 failed 并报明确错误（"未配置 Video2X 超分环境"），不静默跳过
- 进度：按 Video2X 输出解析进度，经 `wsManager` 推送前端
- 预留字段：`options.scope = 'master' | 'segments'`（当前只实现 master；segments 为未来单段精修预留，不实现）
- 交付文档须注明："超分环节依赖外部工具 Video2X（AGPL-3.0），以独立进程方式调用，不构成衍生作品"

---

## 6. 配乐模块 — 新增 `src/processors/audioMixer.js` + `assets/bgm/`

```
assets/bgm/
├── calm/       # 舒缓宁静（3 轨）
├── epic/       # 壮阔史诗（3 轨）
├── ethereal/   # 空灵梦幻（2 轨）
├── nature/     # 自然声景（4 轨，Pixabay）
└── manifest.json   # [{ id, file, title, author, source, sourceUrl, license, licenseUrl, mood: [], durationSec, bpm, instruments, note }]
```

- 首批入库 12 轨（3+3+2+4，覆盖 4 种 mood；替代原「≥20 轨」目标——演示够用且工作量可控）
- **音源来源（实测通道）**：
  - 轻音乐：incompetech.com（Kevin MacLeod，CC BY 4.0，商用需署名）——官方 Agent JSON 通道 `pieces.json`（含 title/filename/length/bpm/feel/instruments），下载直链 `mp3-royaltyfree/{filename}`
  - 环境音：Pixabay CDN 直链（Content License，免费商用免署名）——页面层有反爬（403），仅 CDN 直链可下载，**标题为演示暂定名**，正式入库需在 pixabay.com 页面核对原名并补作者
- **禁止引入 MusicGen 生成物（CC BY-NC 禁商用）**
- FFmpeg 混音命令（已验证）：
  `[1:a]loudnorm=I=-20:TP=-1.5:LRA=11,aloop=loop=-1:size=88200,afade=t=in:st=0:d=2,afade=t=out:st={dur-2}:d=2[a]` + `-map 0:v -map [a] -c:v copy -c:a aac -t {dur}`（视频流不重编码；音轨短于视频由 aloop 无缝循环；淡出起点=视频时长-2s）
- `track: "auto"` 时按任务主题关键词匹配 manifest 的 mood 标签（`audioMixer.THEME_MOOD_MAP`），无匹配则回退 calm 池；支持多标签 mood（如 calm 曲兼 ethereal）
- **新增接口与页面**：
  - `GET /api/bgm?mood=`（库存清单，支持按 mood 过滤）
  - `GET /bgm/{file}`（音源静态访问，audio/mpeg）
  - `POST /api/bgm/mix`（手动混音演示接口：`{ videoPath, track|auto, theme }` → 产物写入 `output/mix_*.mp4`，videoPath 必须 output 开头防路径穿越）
  - 独立页面 `public/music-library.html`（配乐库存：mood 筛选 + 试听 + 授权展示 + 复制 trackId），主页面侧边导航新增「配乐库存」入口
- 版权记录：manifest.json 随产物目录复制一份（协作交付凭证）

---

## 7. HDR 模块 — 新增 `src/processors/hdrConverter.js`

- FFmpeg zscale 滤镜链：BT.709 → BT.2020 色域映射 + PQ 传递函数 + HDR10 静态元数据写入
- 命令骨架：`ffmpeg -i in.mp4 -vf "zscale=t=bt709:m=bt2020:tin=bt709,format=yuv420p10le" -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc out.mp4`（执行时按实际 FFmpeg 版本校准）
- **诚实定位**：输出为 HDR 容器/元数据，非真实动态范围扩展；产物文件名与 report.json 中标注 `hdrType: "tone-mapped"`
- 接口预留 `engine: 'ffmpeg' | 'topaz'`，Topaz 升级在展厅链路确认支持 HDR 后另行采购决策

---

## 8. 一键复跑 — run.config.json

任务创建时落盘 `output/{taskId}/run.config.json`：

```json
{
  "version": "2.0",
  "prompt": "原始输入",
  "theme": "iceland",
  "model": "kling",
  "modelVersion": "kling-v3",
  "resolution": "4K",
  "clipDuration": 15,
  "totalClips": 120,
  "seed": 12345,
  "promptTemplateVersion": "landscape-v1",
  "pipelineConfig": { "preset": "delivery", "steps": {} },
  "audioTrackId": "ambient_007",
  "createdAt": "..."
}
```

- 新增接口：`POST /api/tasks/replay`（body: `{ configPath }`）——读取配置创建新任务并执行
- 验收：同一 config 复跑两次，两次 report.json 的参数区完全一致

---

## 9. 提示词升级 — 新增 `src/services/llmService.js`（LLM 真分镜）+ 模板扩充

**决策依据**：借鉴 MoneyPrinterTurbo 的 LLM 服务分层（LiteLLM 统一接口）——不搬 Python 代码，Node.js 复刻其服务层思路。

### 9.1 新增 `src/services/llmService.js`

- 统一 LLM 接入：一个接口，可配 OpenAI / DeepSeek / 智谱等（复用 `config.OPENAI_*` 配置族，同款 `fetch /chat/completions` 调用）
- 提供两个链：
  1. **真分镜链**（替代 pipeline.js 第 2 步的模拟分镜）：输入"主题/地区名" → 输出 N 段差异化场景描述 JSON（`[{index, scene, prompt}]`）
  2. **提示词增强链**：单段场景描述 → 对齐样片风格的完整提示词
- 降级：无 LLM Key 时回退到模板拼接（现有 `optimizeWithTemplate`），不阻塞流水线
- pipeline.js 改造：`storyboard` 步骤从 `sleep(800)` 改为调用 `llmService.storyboard(task.prompt, totalClips)`，结果逐片段写入 `task.clips[i].prompt`

### 9.2 模板扩充（`src/promptOptimizer.js`）

```
每段提示词 = {景观主体} + {运镜} + {光影} + {质感} + {氛围}

景观主体池：snow-capped mountain range / dramatic coastline / aurora borealis /
  milky way timelapse / misty forest at dawn / terraced fields / waterfall / desert dunes ...
运镜池：slow aerial push-in / gentle orbital shot / high-altitude lateral tracking / static locked shot
光影池：golden hour / blue hour / star-trail long exposure feel / volumetric god rays
质感：cinematic, 4K, ultra detailed, professional color grading
氛围：serene and majestic / awe-inspiring / tranquil
```

- 主题模式：输入地区名（如"冰岛"）→ 从主题映射表生成该地标志景观序列
- 多样性约束：相邻片段场景不重复（模板层保证，与 qualityChecker 的相邻重复检测形成双保险）

---

## 9B. 视觉内容质检（新增，P1）

**决策依据**：借鉴 NarratoAI 的多模态 LLM 抽帧质检思路——不搬代码，Node.js 直接调多模态 LLM API。

- 新增 `qualityChecker.checkContentMatch(videoPath, expectedPrompt)`：
  - FFmpeg 抽 3-5 帧（首/中/尾）→ 送多模态 LLM（GPT-4o-mini / Qwen-VL）→ 判断"画面是否符合提示词意图"（如要雪山给了沙漠 → 判失败）
  - 成本 ≈ ¥0.02/段（120 段 ≈ 几元）
- 与现有技术质检（黑帧/模糊/重复/时长）并联：任一失败即可触发重试/标记
- 接入点：`pipeline.js` `_processSingleClip` 中 `checkClip` 之后
- 无多模态 Key 时跳过并标记 `skipped`，不影响主流程

---

## 10. 前端 — `public/index.html`

1. 任务创建区新增「执行模式」选择器：五档预设 radio + custom 勾选组
2. 每个选项旁标注预估增量：超分 4K「+2~3h / 本地算力」、HDR「+1h」、配乐「+5min」
3. 成本预估弹窗与勾选联动：4K 档按 ¥3/s × 段数 × 15s 实时刷新
4. 任务详情页：增强层各步骤独立状态徽标（含 `skipped`）+ 各产物下载链接
5. 保持现有极简白底风格，不引入新 UI 框架

---

## 10A. 多提示词批量输入（P0，对应需求"一次输入 5/10/120 个不同场景"）

- 前端：任务创建区 `#promptInput` 由单行 textarea 改多行——**每行一个场景提示词**，行数即片段数（与 `clipCountInput` 联动：填了行数则覆盖段数，未填行数则沿用单提示词 + 段数）
- 后端 `server.js /api/tasks`：接收新字段 `prompts?: { text, theme }[]`（非空则传入 `createTask`）
- `taskManager.createTask`：`prompts` 存在时，`clips[i].prompt = prompts[i].text`、`clips[i].theme = prompts[i].theme`（缺行用最后一行补齐，不报错）；不存在时走现有 `setOptimizedPrompt` 逻辑
- 兼容性：老逻辑（单提示词 + 段数）完全保留，多提示词是新路径，不破坏现有任务

---

## 10B. 行级主题标签（P1，多提示词的增强）

用户一次性输入很多不同场景时，每行可带主题标签，**逐行按各自主题优化**，而非全局一个主题。

### 输入语法（行尾可选）

```
{场景描述}【{主题}】    // 支持全角【】或半角[]
```

示例：

```
生成一片大海上远景有许多轮船远处还有小岛 航拍角度【海洋】
沙漠上航拍沙漠小丘【沙漠】
森林晨雾中的湖泊【森林】
```

### 解析与路由（`src/promptOptimizer.js` 新增 `parseThemeTag(line)` → `{ text, themeId, tag }`）

1. 正则提取行尾标签：`/[【\[]([^】\]]+)[】\]]$/`
2. 匹配顺序：
   - 模板 `name` 精确包含（如"海洋"→`ocean`）
   - 主题关键词表**包含匹配**（容错用户自由描述，如"海洋 大自然类"含"海洋"→`ocean`）：见下方关键词表
   - 兜底：全局主题（页面主题选择器所选）+ 前端黄色提示"该行主题标签未识别，已用默认主题"，不改用户原文
3. 标签解析结果写入 `clips[i].theme`，前端任务详情每片段显示主题徽标

### 主题关键词表（含新增模板）

| themeId | name | 关键词（含即命中） |
|---------|------|-------------------|
| ocean | 海洋 | 海洋、大海、海、海浪、海滩、水下、珊瑚 |
| desert | 沙漠（新增） | 沙漠、沙丘、荒漠、沙纹 |
| waterfall | 瀑布（新增） | 瀑布、水雾、溪流、峡谷 |
| lake | 湖泊（新增） | 湖泊、湖、森林晨雾、镜面、倒影 |
| mountain | 雪山 | 雪山、冰川、山、山峰、雪原 |
| aurora | 极光 | 极光、北极光 |
| space | 宇宙星空 | 星空、银河、宇宙、星轨、夜空 |
| landscape | 自然风景（兜底） | 森林、草原、山谷、梯田、云海 |

### 模板库扩充（`src/promptOptimizer.js` DEFAULT_TEMPLATES，对齐样片风格）

新增 `desert` / `waterfall` / `lake` 三个模板，各含 `styleEnhancers`（运镜/光影/质感词池）+ `negative`（禁人物/文字/logo），规范与现有 5 个模板一致。

### 优化时机与 pipeline 改动

- 创建任务时**批量逐行优化**（`optimizeWithTemplate`，有 LLM Key 时 `optimizeWithAI`），结果写回 `clips[i].prompt`
- `pipeline.js` 第 1-2 步由"全任务一个主题"改为"**遍历 clips 逐行按 `clip.theme` 优化**"；`llmService` 真分镜就绪后由真分镜接管，行级 theme 作为提示词上下文
- 无标签行：用全局主题，逻辑等同现状

---

## 11. 验收清单（研发自测）

- [ ] 盲测完成，D3 主力模型确认或切换（迭代 0）
- [ ] Mock 模式五档各跑通一次，skipped 状态正确
- [ ] 非法组合（如 hdr=true 且 concat=false）在创建时被拒绝并提示
- [ ] draft 完成后 `resumeFrom(taskId, ['upscale','audio_mix'])` 补跑成功，clip_generation 未重跑
- [ ] run.config.json 复跑两次参数一致
- [ ] Kling 真实 key 生成 4K 15s 片段成功；402 错误不重试；失败降档标注 downgraded
- [ ] 多提示词：前端贴 5 行提示词创建任务，5 个片段 prompt 逐一对应，与段数输入互不冲突
- [ ] 行级主题标签：5 行带不同【主题】→ 各片段按各自主题优化；无标签行用全局主题；标签未识别黄色提示且不报错
- [ ] LLM 真分镜：有 Key 时 storyboard 步骤输出 N 段差异化场景；无 Key 时回退模板不报错
- [ ] 视觉质检：有 Key 时 checkContentMatch 能识别"内容跑偏"片段；无 Key 时标记 skipped
- [ ] 无 GPU 环境执行 upscale 得到明确报错而非静默
- [ ] delivery 模式产出完整产物目录 + report.json
