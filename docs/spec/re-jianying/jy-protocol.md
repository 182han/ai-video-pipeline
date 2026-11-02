# 剪映专业版 11.6.0.14552「拼接 + 配乐」协议层逆向

> 目标：把剪映内置 Agent 的**可读协议文档**里关于「多片段串联成一条主轨」与「挂 BGM / 混音 / 响度」的字段与取值语义，逐条落到 文件:行号 证据上，供本项目（Node + ffmpeg，自有 BGM，不复用剪映音乐素材）判断哪些语义可以复刻、哪些依赖剪映闭源能力。
>
> 取证方式：只读安装目录 `D:\JianyingPro\11.6.0.14552`，未启动剪映 GUI、未联网、未修改任何安装文件。本文件是本次唯一写入。

---

## 0. 取证范围、证据路径约定与一条重要否定结论

### 0.1 证据路径约定（下文引用一律用这些短前缀，去掉前缀即为安装目录下的真实相对路径）

安装根：`D:\JianyingPro\11.6.0.14552\Resources\canvas_agent\`

| 前缀 | 实际路径 | 说明 |
| --- | --- | --- |
| `xml/` | `skills\jianying.hub.studio_lyra_xml_timeline_builder_v2\` | XMLDraft 协议 base schema 与 Selection 协议（本文件主要证据源） |
| `cli/` | `skills\canvas-cli\` | 画布节点 CLI（**不是**时间线协议） |
| `recall/` | `skills\jianying.hub.studio_edit_reference_recall_v2\` | 通用包装风格规则（BGM/卡点/转场/音量策略） |
| `prompt/` | `prompts\` | 内置 Editing Agent 的系统提示（工作流与工具约束） |

例：`xml/references/timeline.md:35` = `...\skills\jianying.hub.studio_lyra_xml_timeline_builder_v2\references\timeline.md` 第 35 行。

### 0.2 实际完整读取的文件（字节数为实测）

- `xml/SKILL.md` 18,785 B（97 行）
- `xml/references/timeline.md` 10,008 B（109 行）
- `xml/references/segment-visual.md` 23,762 B（257 行）
- `xml/references/segment-audio.md` 5,103 B（64 行）
- `xml/references/transform.md` 12,281 B（95 行）
- `xml/references/selection.md` 11,173 B（93 行）
- `xml/references/extensions.md` 14,790 B（88 行）
- `xml/references/no-support.md` 1,404 B（20 行）
- `cli/SKILL.md` 11,645 B（139 行）、`cli/references/requests.md` 25,358 B（383 行）、`cli/references/create.md` 12,879 B（222 行）、`cli/references/edit.md` 11,090 B（219 行）
- `recall/references/rules/audio.md` 4,853 B（35 行）、`recall/references/rules/visual.md` 6,176 B（47 行）、`recall/SKILL.md` 12,627 B（87 行）
- `prompt/editing-agent-fornax-sp.md` 28,888 B（201 行）
- 补充：`skills/audio-rhythm/SKILL.md` 890 B（14 行）、`skills/skill-creator/references/editing/timeline.md` 2,605 B（39 行）

### 0.3 否定结论：`canvas-cli/scripts/protocol.json` 不是时间线协议

`cli/scripts/protocol.json` 383,882 B。全文检索以下关键字，命中数均为 **0**：

```
loudness / beats / transition / timeline / volume / fade → 0 命中
draft → 4 命中，且全部是 draftInput（画布生成输入的字段名）
```

复现命令：

```powershell
$p='D:\JianyingPro\11.6.0.14552\Resources\canvas_agent\skills\canvas-cli\scripts\protocol.json'
foreach($k in @('loudness','beats','transition','timeline','volume','fade')){ "$k`t" + (Select-String -Path $p -Pattern $k -AllMatches | Measure-Object).Count }
```

结论：`protocol.json` 描述的是**画布节点**（文本/图片/视频/音频卡、分组、生成）操作，与草稿时间线无关；时间线字段只存在于 `xml/` 这一套 XMLDraft 文档里。**任务提示中「用 protocol.json 检索 audio/beats/transition/loudness 关键 op」这一路径不成立**——不是漏检，是该文件里没有这些概念（见 §9 的调用链澄清）。

---

## 1. 先分清两种东西：整草稿 XML 与 Selection 表达式

这是判断「拼接语义」的前提，二者不是同一层。

| 概念 | 定义 | 证据 |
| --- | --- | --- |
| 整草稿 XML（`<draft>` 根） | 描述**目标草稿的完整状态**：画布、main、multi、compounds、识别动作 | `xml/SKILL.md:59`；`xml/references/timeline.md:26-41` |
| Selection Expression | 对**最新缓存 target XML** 的显式变更；未触达节点保持不变；由 DraftEditing 校验并应用 | `xml/SKILL.md:59`；`xml/references/selection.md:7-9` |
| 唯一草稿写入口 | `DraftEditing`；**不得提交完整 draft 文档**，XML 片段只是表达式参数 | `xml/SKILL.md:11`；`prompt/editing-agent-fornax-sp.md:18,180` |
| 空草稿 bootstrap | 可由一次 Selection 创建 `main` / `multi` 容器；有源草稿时不得用 `replaceChildrenXml` 重建未授权结构 | `prompt/editing-agent-fornax-sp.md:193` |

推论（有证据）：**「拼接」不是一条表达式语句，而是整草稿 XML 里 `main` 子节点的有序状态**；Selection 只能通过 `appendXml` / `replaceChildrenXml` / `reorderChildrenById` 去改变这个状态（`xml/references/selection.md:36-45`）。

`target_xml`（缓存，未落地）与 `current_xml`（已 sync 的真实草稿）是两个文件，不能混用；`draft.apply()` 才是落地点（`xml/SKILL.md:44`；`prompt/editing-agent-fornax-sp.md:182`）。

---

## 2. 轨道结构与时间的精确算术

### 2.1 根节点 `<draft>`

`xml/references/timeline.md:26-44`：

- 子标签只允许：`compound`、`compounds`、`lyric_recognize`、`main`、`multi`、`subtitle_recognize`；其中 `compounds` / `lyric_recognize` / `main` / `multi` 各最多 1 个（`xml/references/timeline.md:40-41`）。
- 属性：`width`/`height`（像素）、`fps`、`ratio`、`background_color`、`loudness_normalize`（on/off）、`version`（枚举 1，省略按 1，默认值 1）。
- **画布宽高必须成对显式写成正整数**，不得只写 ratio，也不得依赖宿主补默认值（`xml/SKILL.md:33`；`xml/references/timeline.md:43`）。
- 已存在草稿的 `fps` 未获明确要求时沿用当前值（`xml/SKILL.md:34`；`xml/references/timeline.md:44`）。

### 2.2 `<main>`：唯一主轨容器

决定性原文：

> 「唯一主轨容器，按文档顺序承载连续的主画面片段。」（`xml/references/timeline.md:47`）
> 子标签：`segment:image`, `segment:video`（`xml/references/timeline.md:54`）
> 「主画面按确认顺序连续排列」（`skills/skill-creator/references/editing/timeline.md:15`）

三条关键约束：

1. **main 只放 video/image**（`xml/references/timeline.md:47,54`）——音频、文字、贴纸、画中画都不在主轨。
2. **main 片段不写 `start`**（`xml/references/timeline.md:96`）。主轨的时间位置由文档顺序隐式决定，而不是显式起点。
3. 在已有主轨**开头**插入 video/image 时，底层 apply 会按新增主轨时长**自动联动后移已有 multi 片段**（`xml/references/timeline.md:50`）。这种联动由 apply 完成，Selection 里**不得**再手工给既有副轨 `time.start` 加同样偏移（`xml/references/selection.md:74`）。

### 2.3 `<multi>`：副轨容器

> 「副轨容器，承载音频、文字、贴纸、画中画和全局能力片段。」（`xml/references/timeline.md:64-65`）

合法子标签（`xml/references/timeline.md:70`）：`lyric_recognize`、`subtitle_recognize`、`audio`、`effect`、`filter`、`image`、`material_package`、`sound`、`sticker`、`subtitle`、`template_package`、`text`、`video`。

即：**配乐（audio）/音效（sound）只能出现在 multi**（`xml/references/segment-audio.md:37,53`），永远不在 main。这是本文件回答「拼接」与「配乐」时的分界。

### 2.4 `<time>` 的字段与互斥

`<time>` 可挂在 video/image/audio/sound/text/subtitle/sticker/filter/effect/package/compound 上（`xml/references/timeline.md:90`）。

编写规则（`xml/references/timeline.md:91-97`）：

- **所有时间属性只接受不带单位后缀的裸数字，统一按毫秒解释**；`us/ms/s/min/m` 后缀均非法（`:92`）。
- `align_end_to` 与 `duration` 都是时长来源，**同一 time 内不得同时输出**（`:93`）。
- `time.speed` 只用于支持变速的音视频；text/subtitle/sticker 禁止写 speed，**即使值为 1**（`:93`）。
- 固定区间与锚定区间二选一：固定 = `start` 或 `align_start_to` + `duration`；锚定 = `align_start_to` + `align_end_to`（不得再写 duration）（`:94`）。
- 锚定区间展开后必须满足 `start < end`；端点循环 / 结束不晚于开始 / 负 offset 反向 → 不得提交（`:95`）。
- **multi 内片段写 `duration` 时必须同时写 `start` 或 `align_start_to`；main 片段不写 `start`；`material_start` 不能代替 `start`**（`:96`）。
- 对 video/audio/sound，源区间结束点 `material_start + duration * speed`（speed 缺省 1）必须 ≤ 当前 ref 的真实素材时长（`:97`）。
- `material_start > 0` 时，`duration` 上限 = `(素材时长 - material_start) / speed`，**不能继续写满素材完整时长**（`:97`）。

字段语义表（`xml/references/timeline.md:100-109`）：

| 字段 | 语义 | 单位/约束 | 证据 |
| --- | --- | --- | --- |
| `start` | 副轨片段的绝对起始时间（或动画在宿主内的偏移） | ms，≥0；`absolute_fixed` 场景 | `timeline.md:109` |
| `duration` | 宿主片段在**时间线上**占用的持续时长，**不随 speed 改写**；`duration="3000"` 恒为时间线 3 秒，speed=2 时消耗 6 秒源素材 | ms，≥0；`absolute_fixed` | `timeline.md:106` |
| `material_start` | 片段从源素材内部开始取用的时间；0=素材开头 | ms，≥0；全部场景 | `timeline.md:107` |
| `speed` | 速度倍率：0.5 半速、1 原速、2 两倍速；写 1.25 而不是 125 | >0；全部场景 | `timeline.md:108` |
| `align_start_to` | 相对起点绑定的端点，canonical 为 `segment_id.left`/`segment_id.right`，主轨整体用 `main.left`/`main.right` | id_ref；`aligned_interval` | `timeline.md:105` |
| `align_end_to` | 相对终点绑定的端点，格式同上 | id_ref；`aligned_interval` | `timeline.md:103` |
| `align_start_offset` / `align_end_offset` | 绑定后毫秒偏移，左移负、右移正 | ms | `timeline.md:102,104` |

**时间如何累积（拼接的核心算术）**：由三条原文推导——「按文档顺序承载连续的主画面片段」(`timeline.md:47`) +「main 片段不写 start」(`timeline.md:96`) +「duration 是宿主片段在时间线上占用的持续时长」(`timeline.md:106`)——主轨片段按文档顺序依次相接，单个片段在时间线上占 `duration`，因此主轨起点由顺序隐式决定，主轨总长即各 main 片段 `duration` 之和。转场时长**不参与主轨时间线累计**（`xml/references/segment-visual.md:229`，另见 `:225`「不纳入主轨总时长」）。

> ⚠️ 未知：主轨总时长是否因此在导出时等于 Σduration（即转场是否使成片变短 / 是否吞掉边界时长），文档**没有**声明。协议只说转场 duration 不参与主轨片段的时间线累计，不能据此推断导出成片长度。

### 2.5 视觉片段的 transform（fit / scale / crop）

`xml/references/transform.md:49-95`：

- `transform` 父角色：video、image、text、subtitle、sticker（`:51`）。
- **`fit` 与 `scale` 不得同时输出**；显式 width/height 或有效同轴双侧 padding 存在时保留尺寸约束并**忽略 scale**（`:55`）。
- `layout="absolute"` 必须同时给数值型 `x` 和 `y`（`:54`）；`x`：0 为画布中心、-1 左边界、1 右边界；`y`：0 中心、1 上边界、-1 下边界（`:92-93`）。不是像素。
- `scale`：等比缩放倍率，默认 1；0.5 不保证占画布 50%（`:90`）。
- `fit` 枚举：`cover, contain, none, scale-down`（`:76`）；`scale-down` 不放大。
- `crop`：裁剪比例如 `1:1`、`16:9`，也可写关闭值重置；`crop_position` 省略表示居中；`crop_rotation` 默认 0（`:73-75`）。
- `rotation`：逆时针负、顺时针正，角度裸数，默认 0（`:89`）。
- `width`/`height`/`padding-*`/`offset_*` 必须用**百分比字面量**；`offset_y` 正值向上（`:56,82-83`）。
- `layout=absolute` 用 `x/y`；相对布局用 `justify-self/align-self/padding-*/offset_*`，两者不得混用（`:53`）。
- `canvas`（视频或图片的画布背景）与 `transform.fit/crop` **相互独立、可同时存在**；`canvas.blur` 0–1，运行时未指定默认 0.75（`xml/references/segment-visual.md:72,76`）。

注：任务描述里把「speed」归到 segment-visual，实际 `speed` 只存在于 `<time>`（`xml/references/timeline.md:108`）；`segment-visual.md` 里没有 speed 字段，只有 `speed_curve`（曲线变速，`xml/references/timeline.md:73-86`）。

### 2.6 资源 ref 的白名单规则（直接决定能否「随手写 audioN」）

> 「资源 ref 只能来自普通工具结果中明确可用的 blueprint_ref，或当前草稿中未修改的原引用；示例引用不是可复制的资源。……新增或替换的 `videoN`、`imageN`、`audioN`、`soundN`、`musicN`、`filterN`、`effectN`、`fontN` 等必须逐字命中白名单；**禁止按素材数量、自然顺序、资源名称或期望效果猜测不存在的编号**。」（`xml/SKILL.md:13`；同义约束见 `xml/references/selection.md:56`）

即：协议里的 `ref` 不是「文件名/路径」，而是宿主签发的 blueprint_ref；编号不可推导（详见 §7.1 与 §8）。

---

## 3. 转场（`<transition>`）——协议允许什么、上限是多少

### 3.1 结构位置

> 「相邻主轨片段边界上的转场，挂在边界左侧 video 或 image 内。」（`xml/references/segment-visual.md:220`）
> 父角色：`segment:video`, `segment:image`（`:222`）

### 3.2 硬性规则（原文）

- **只能挂在「存在后继主轨 video/image」的边界左侧片段内**；最后一个或唯一一个 main 片段后面没有相邻片段，**禁止**包含 `<transition>`（`segment-visual.md:224`）。批量加转场时必须先确认主轨顺序，只给非尾段加（`:224`）。
- 需要**结尾淡出**时改用宿主片段的 `fade` 或 `animation`，**不要用 transition**（`segment-visual.md:224`）。
- 批量加转场前要核对「尾段转场等结构规则」，并在同次表达式处理受影响节点（`xml/SKILL.md:36`）。

### 3.3 字段

| 属性 | 语义 | 约束 | 证据 |
| --- | --- | --- | --- |
| `ref` | 已绑定外部素材或能力资源的 ID 引用（**转场样式在这个资源里**） | resource_ref | `segment-visual.md:231` |
| `duration` | 转场自身持续时长，**不参与主轨片段时间线累计** | number，ms，`range: minimum=0`（**无上限声明**） | `segment-visual.md:229` |
| `id` | 节点唯一标识 | id | `segment-visual.md:230` |

`selection.md` 的字段路由里另有一条：`transition` 语义 = `ref, duration`，`duration=attribute; no-time-child`（`xml/references/selection.md:86`）——即转场**没有** `<time>` 子节点，时长写在属性上。

### 3.4 「时长上限是多少」

- **协议层面没有上限**：`duration` 只声明 `range: minimum=0`（`segment-visual.md:229`）。
- **文档给的推荐/起调区间是 300–800 ms**：

> 「普通转场可从 300–800 毫秒起调：300 较快、800 较缓；1000 是 1 秒，对短镜头会明显拖慢切换。按用户意图和相邻片段时长选择，不纳入主轨总时长。」（`segment-visual.md:225`）

- 因此：**协议允许的下限 = 0，上限 = 未知（文档未声明）；文档推荐 300–800，并明确提示 1000 对短镜头偏慢。**

### 3.5 「叠化」怎么表达

- 文档**没有**转场样式枚举（`<transition>` 只有 `id/ref/duration`，见 `segment-visual.md:229-231`）。样式完全由 `ref` 指向的资源决定；没有已绑定转场资源时应省略转场（`xml/SKILL.md:22`）。
- 所以「叠化 / cross dissolve」不是协议层的枚举值，而是某个转场资源的语义。**哪个 ref 是叠化、叠化的曲线与混合方式如何，文档未给出 → 未知**。

### 3.6 转场决策规则（不是协议，但影响默认行为）

- 转场只用于**真实相邻主轨镜头**，末段后不是边界（`recall/references/rules/visual.md:28`）。
- 策略未明确时，必须由两侧边缘画面/动作/声音证明承接关系且余量足够；**样式未明确用低形变连接**（`visual.md:28`）。
- 默认关系证据不足 / 余量未知 / 保护对象冲突 / 资源失败 → **`hard_cut`（硬切）**，不生成资源职责（`visual.md:33`）。即剪映 Agent 的默认取向是「没证据就硬切」，而不是「默认加转场」。
- 不按素材序号、固定秒点或段尾批量添加（`visual.md:35`）。
- 只做包装（packaging_only）时，加转场等子能力**仍须保持片段数量、顺序和总时长**（`recall/SKILL.md:87`）。

---

## 4. 音频：`<audio>` / `<sound>`、音量、淡入淡出、节拍

### 4.1 两种音频宿主

| 标签 | 语义 | 父角色 | 证据 |
| --- | --- | --- | --- |
| `<audio>` | 普通音频、**配乐或背景音乐**片段，**必须放入 multi** | `element:multi` | `segment-audio.md:36-38` |
| `<sound>` | 音效、提示音或声音点缀片段，**必须放入 multi** | `element:multi` | `segment-audio.md:52-54` |

`<audio>` 子标签：`lyric_recognize`、`subtitle_recognize`、`beats`、`fade`、`time`，其中 `lyric_recognize` 最多 1 个（`segment-audio.md:49-50`）。`<sound>` 子标签：`subtitle_recognize`、`beats`、`fade`、`time`（`segment-audio.md:64`）。

音频/音效 `ref`：已绑定外部素材或能力资源的 ID 引用（`segment-audio.md:46,61`）。

### 4.2 `volume` 语义（三个宿主同一套口径）

`<audio>`/`<sound>`/`<video>`（原声）都有 `volume`，语义完全一致：

> 「0 静音、50 为原始幅度的一半、100 保持原始音量、200 为两倍幅度，范围 0–1000。30% 写裸数 30，不写 0.3 或 30%；**1000 不是普通默认值**，实际响度须试听。」默认值 **100**（`segment-audio.md:47`、`segment-audio.md:62`、`segment-visual.md:253`）

要点：
- 量纲是**线性幅度百分比**（50 = 一半幅度、200 = 两倍幅度），不是 dB，也不是 0–1 浮点。
- 合法区间 0–1000（协议允许），默认 100（协议声明）。
- `volume` 属于**宿主属性**，不是 `time` 的子属性（`selection.md:87` 的字段路由：`volume | video, audio, sound | (宿主) | volume`）。

### 4.3 `fade` 淡入淡出

> 「视频原声、音频或音效的淡入淡出配置。」父角色：`segment:video`, `segment:audio`, `segment:sound`（`segment-audio.md:16-18`）

- 挂在 video 下作用于**该视频片段的原声**；挂在 audio/sound 下作用于独立声音片段（`segment-audio.md:20`）。
- `in`/`out` 是**无单位后缀的非负毫秒时长**，分别作用于宿主片段开头与结尾，**不表达画面转场**（`segment-audio.md:21`）。
- 属性：`in`（ms，≥0，默认不声明）、`out`（ms，≥0，默认不声明）（`:26-28`）。
- 「in="500" out="1000" 表示开头半秒淡入、结尾一秒淡出；相同 1 秒淡出在 3 秒短音效中占三分之一、在 10 秒音乐中占十分之一……**不把毫秒值当音量百分比**。」（`:23`）
- 局部修改时保留未被要求的方向；移除淡入淡出 = 用 Selection 删除对应 `fade` 节点（`:22`）。

### 4.4 `beats` 节拍

> 「音乐节拍配置或只读节拍点序列；文本点位单位为毫秒。」父角色：`segment:audio`, `segment:sound`（`segment-audio.md:5-7`）

| 属性 | 语义 | 约束 | 证据 |
| --- | --- | --- | --- |
| `level` | 节拍密度等级，0–4，越大越密；**0 是最稀、2 是中间档、4 是最密；0 不表示关闭，移除节拍须删除 beats**；档位不是每秒节拍数 | integer，0–4 | `segment-audio.md:13` |
| `mode` | 节拍分析模式；**新 XML 启用 beat 时固定写数字字面量 `1`** | enum: `1` | `segment-audio.md:14` |

硬规则：

> 「目标素材已有 beats metadata（节拍元数据）时，节拍配置的 mode 固定写数字字面量 `1`，level 为 0 至 4；**不得自造节拍点文本**。」（`segment-audio.md:9`）

**beats metadata 从哪来**（这是可复刻性的关键）：

- 平台音乐需要在召回时**显式请求节拍分析**：`MaterialRecall` 的 `analyze_beats` 参数——需要镜头/动画/强调事件对齐节拍时设 `true`；仅作背景音乐或明确不需要卡点时设 `false`，省略也不分析（`recall/references/rules/audio.md:17`）。
- 「节拍必须来自**最终选中音乐**，版本或时长变化后重新获取。」（`recall/references/rules/audio.md:15`）
- 「`SegmentRecall.audio` 只检索 ASR 对白，**不用它检测音乐拍点**或非语言声音」（`skills/audio-rhythm/SKILL.md:11`）。
- 协议层只能消费**已存在的** metadata；没有 metadata 时协议不提供「自己算拍点」的写法（`segment-audio.md:9`「不得自造节拍点文本」）。

### 4.5 音频源区间约束（与视频同构）

`segment-audio.md:30-34`：

- 写入 `<time>` 前必须核对当前 ref 的真实 `duration_ms`；结束点 `material_start + duration * speed`（speed 缺省 1）**不得超过资源时长**（`:32`）。
- `material_start > 0` 时 `duration` 上限 = `(duration_ms - material_start) / speed`，**不得从素材中段开始后仍用完整素材时长**（`:33`）。
- 短音效不得为贴合画面时长而拉长源区间；只能缩短 duration、换更长素材、或拆成多个各自不越界的合法片段（`:34`）。

### 4.6 识别动作与音量无关（一个容易误判的点）

- 歌词/字幕识别「按目标源媒体识别，**不受 volume=0 或轨道静音影响，也不修改播放音量**」（`xml/references/extensions.md:12`、`:31`）。
- `subtitle_recognize` 可作为 audio 的子标签（`segment-audio.md:49`）；`lyric_recognize` 支持 video/audio（`extensions.md:21`）。
- 扩展动作不是最终时间线片段，而是「整体操作意图的占位声明」，先完成普通时间线修改再执行识别（`extensions.md:85-87`）。

---

## 5. 草稿级响度均衡 `loudness_normalize`

### 5.1 字段

> 「`loudness_normalize`：草稿级响度均衡策略，on 开启、off 关闭；用户或已授权的上游编辑/包装计划明确要求时写入对应值。**不得仅凭存在音轨、BGM、时间线重叠或手工 volume 推断开启。保持手工音量、静音与淡入淡出不变。**」类型 enum: `on, off`；**默认值栏未声明**（`xml/references/timeline.md:35`）

### 5.2 写入纪律

- `<draft loudness_normalize="on|off">` 必须**保留**用户或上游已授权的决策，不得凭音轨存在与否自行推断（`xml/SKILL.md:65`）。
- 仅在用户或已确认的包装方案明确要求时启用/关闭；保留已确认的音量、静音和淡入淡出（`skills/skill-creator/references/editing/timeline.md:8`）。

### 5.3 上游包装规则里的默认取向（会对本项目有用）

> 「存在可靠口播、对白或需保护的同期声，且本轮新增或更新 BGM 时，**除非用户明确关闭响度均衡、要求保留现有混音，或只要求手工调整片段音量，否则必须向草稿编排交接"开启草稿级响度均衡"**。手工 BGM 音量只是起始混音值，不能作为人声保护已完成的证据；**响度均衡也不替代 ducking 和关键词清晰度复核**。」（`recall/references/rules/audio.md:13`）

### 5.4 「原始推荐区间」到底有没有数值

- **没有**。全部协议与包装规则里，`loudness_normalize` 只有 `on/off` 枚举，**没有任何 LUFS / dB / 目标响度数值**。对 `skills/` 下全部 `.md` 检索 `LUFS|loudness|响度|dB|分贝|增益`，命中项要么是 `volume` 的「响度须试听」描述（如 `segment-audio.md:40,47`），要么是「采样/ASR 不能证明响度」之类的免责（如 `skills/editing-review/SKILL.md:16`），**没有任何一条给出目标 LUFS 或 dB 区间**；唯一的字段定义就是 `timeline.md:35` 的 on/off。
- 「配乐轻于原声 / 突出音乐」的**唯一原始数值区间**不在 `loudness_normalize`，而在 `volume` 的编写建议里（见 §7.3）。
- 结论：**响度均衡的算法、目标 LUFS、压缩曲线 = 未知 + 闭源**；能复刻的只有「是否启用」这个开关语义，以及 `volume` 的手工起始值。

---

## 6. 「拼接」在这个协议里到底靠什么表达（决定性原文）

**结论：靠主轨 `<main>` 的「文档顺序」——不是 multi，也不是 transform 时间。**

三条决定性原文：

1. 「唯一主轨容器，**按文档顺序承载连续的主画面片段**。」（`xml/references/timeline.md:47`）
2. 「multi 内的片段写 duration 时必须同时写 start 或 align_start_to；**main 片段不写 start**。」（`xml/references/timeline.md:96`）
3. 「在已有主轨开头插入 video/image 时，底层 apply 会按**实际落轨后的新增主轨时长**自动联动后移已有 multi 片段。」（`xml/references/timeline.md:50`）

因此：

- 多片段串联 = 在 `main` 下依次追加 `<video id=... ref=...>` / `<image ...>` 子节点（`timeline.md:54`）；每个片段用 `<time duration=... material_start=... speed=.../>` 决定「占多长」和「从源素材哪一段取」（`timeline.md:100-109`）。
- 时间累积 = 片段 `duration` 依次相接，**主轨不显式写 start**（`timeline.md:96`），所以不存在「手工算累积偏移」这件事；累积由文档顺序隐式定义。
- **multi 不承担拼接**：multi 是副轨容器，装音频/文字/贴纸/画中画（`timeline.md:64-70`）。
- **transform 不承担拼接**：transform 只做画面布局/缩放/裁剪（`transform.md:49-51`），与时间顺序无关。
- 转场是**边界属性**，挂在边界左侧片段内，且「不参与主轨片段时间线累计」（`segment-visual.md:220,229`）。

反证（避免误读）：

- main 下**不允许** audio/text 等子标签（`timeline.md:54` 只列 `segment:image`, `segment:video`）——所以「把 BGM 塞进主轨」在协议里不成立。
- `replaceChildrenXml` 选 `main` 时**只能传 video/image 子节点，不能包 `<main>`**（`xml/references/selection.md:63`；`xml/SKILL.md:43`）——这也是「拼接=main 子节点列表」的直接体现。
- 非空草稿**不得**用 `replaceChildrenXml` 重建整条主轨；重排应使用重排操作（`reorderChildrenById`，`selection.md:45`）或逐节点修改（`xml/SKILL.md:36`）。

---

## 7. 配乐（BGM）在这个协议里怎么挂

### 7.1 两种来源：平台音乐 vs 用户自带音频

| 来源 | 取 ref 的工具 | 写入哪个标签 | 证据 |
| --- | --- | --- | --- |
| 平台音乐 / 音效 | `MaterialRecall` → `resolved_resources[].blueprint_ref` | `<audio>` / `<sound>` 的 `ref` | `xml/SKILL.md:20`；`prompt/editing-agent-fornax-sp.md:54` |
| 用户自带的独立音频（本项目的场景） | `AnalyzeAsset` → `blueprint_ref`（或本轮 `sourceBindings.blueprintRef`） | `<audio>` 的 `ref` | `xml/SKILL.md:20`；`prompt/editing-agent-fornax-sp.md:53` |

原文（决定性）：

> 「用户视频、图片、独立音频使用 AnalyzeAsset（素材分析工具）返回的 blueprint_ref；平台音乐、音效、字体、模板、蒙版等使用 MaterialRecall（平台资源召回工具）的 resolved_resources[].blueprint_ref。**不要把用户音频唯一标识当平台 resource_id**。」（`xml/SKILL.md:20`）

> 「用户视频、图片、音频写入 XML 时，只能使用本轮 `sourceBindings` 中的 `blueprintRef`，或 `AnalyzeAsset` 返回的 `blueprint_ref`。……`asset_id`、`resource_id`、RID、标题、URL、路径、诊断 ref、示例 ref **都不是 XML ref**，禁止直接写入草稿。」（`prompt/editing-agent-fornax-sp.md:53-55`）

> 「用户自带音频复用 AnalyzeAsset 的真实引用；**素材标识不是 `resource_id`（平台资源编号），不得搜索同名平台音乐替代**。」（`recall/SKILL.md:40`）

### 7.2 用户自备 BGM 的完整写法（语义级）

1. 用 `AnalyzeAsset` 分析本地音频，拿到 `blueprint_ref` 与真实 `duration`（`xml/SKILL.md:20`；`segment-audio.md:41`）。
2. 往 `multi` 里追加：

```xml
<audio id="bgm1" ref="<AnalyzeAsset 返回的 blueprint_ref>" volume="40">
  <time start="0" duration="1800000"/>
  <fade in="1000" out="2000"/>
  <beats level="2" mode="1"/>
</audio>
```

（结构依据：`<audio>` 必须放 multi + 子标签 beats/fade/time + `volume` 默认 100 —— `segment-audio.md:36-49`；`time` 裸毫秒 —— `timeline.md:92`；`fade` in/out 毫秒 —— `segment-audio.md:26-28`；`beats` level/mode —— `segment-audio.md:13-14`。上面的 id/数值是示意，不是协议默认值。）

3. 源区间合法性：`material_start + duration*speed ≤ 音频真实时长`（`segment-audio.md:32`）。一首 3 分钟的 BGM 不能靠单个片段覆盖 30 分钟成片。

### 7.3 「配乐轻于原声 / 突出音乐」的原始推荐区间（原文）

> 「**配乐需要轻于原声时可从 volume="30" 至 "60" 起调，突出音乐可从 "120" 至 "200" 起调**；这些是混音起点，实际响度还受素材本身影响，不得仅凭数值认定人声清楚。」（`xml/references/segment-audio.md:40`）

配套规则（同为原始证据）：

- 音量口径：0 静音 / 50 半幅 / 100 原始 / 200 两倍，范围 0–1000，默认 100；1000 不是普通默认值（`segment-audio.md:47`）。
- 有人声且音乐风格未明确时：默认选**无人声、弱旋律、低存在感**音乐 + **保守 ducking**（人声出现时压低音乐）（`recall/references/rules/audio.md:13`）。
- 事件音效的音量默认（**注意：这是音效，不是 BGM**）：句末/停顿窗口仍有人声 → `speech_volume_percent: 25`；无人声 → `base_volume_percent: 40`（`recall/references/rules/audio.md:35`）。
- BGM 覆盖策略：分段未指定时**只保留一个逻辑 BGM，默认连续覆盖主轨**；长音乐按目标终点裁切，短音乐复用同一资源**循环补齐**，最后一轮在目标终点裁切；**不变速拉长、不静音补尾、不拼接无关音乐**，循环不改变既定音量（`recall/references/rules/audio.md:9,11`）。
- 任何策略下单个片段都不能越过音源结尾（`rules/audio.md:11`；协议约束见 `segment-audio.md:32`）。

### 7.4 `musicN` 与 `audioN` 的关系（不要硬猜）

- ref 白名单里同时列出了 `audioN`、`soundN`、`musicN`（`xml/SKILL.md:13`）。
- 但 `<audio>` / `<sound>` 的 ref 字段只有一个 `resource_ref`（`segment-audio.md:46,61`）。
- **文档没有逐条说明 `musicN` 与 `audioN` 如何映射到同一个 ref 字段，也没有说明 `musicN` 是否只用于平台音乐 → 未知**。可以确定的只有：无论编号叫什么，它必须逐字命中本轮工具返回的白名单，不得自造（`xml/SKILL.md:13`；`selection.md:56`）。

---

## 8. 协议允许值 vs 剪映实际默认值（严格区分）

下表只区分三种状态：**协议允许**（字段有明确 range/enum）、**协议声明默认**（字段表「默认值」栏有值）、**未知**（文档未写，不做推测）。

| 字段 | 协议允许 | 文档声明的默认 | 剪映实际默认（文档未写） |
| --- | --- | --- | --- |
| `volume`（video/audio/sound） | 0–1000（线性幅度百分比） | **100**（`segment-audio.md:47,62`；`segment-visual.md:253`） | 同上，声明了 100 |
| `<transition>.duration` | ms，≥0，**无上限** | 未声明 | **未知** |
| `<transition>.ref` | 资源引用，必须已绑定 | 未声明 | **未知** |
| `fade.in` / `fade.out` | ms，≥0，**无上限** | 未声明 | **未知** |
| `beats.level` | 0–4 | 未声明 | **未知** |
| `beats.mode` | 枚举 `1` | 未声明 | **未知** |
| `loudness_normalize` | `on` / `off` | 未声明 | **未知** |
| `draft.version` | 枚举 `1` | **1**（省略按 1，`timeline.md:37`） | 同上 |
| `draft.width/height/fps/ratio/background_color` | width/height 正整数像素；fps>0 | 未声明 | **未知** |
| `transform.scale` | >0 | **1**（`transform.md:90`） | 同上 |
| `transform.rotation` | 角度裸数 | **0**（`transform.md:89`） | 同上 |
| `transform.crop_rotation` | 角度 | **0**（`transform.md:75`） | 同上 |
| `mask.invert` | boolean | **false**（`segment-visual.md:154`） | 同上 |
| `mask.rotation` | 角度 | **0**（`segment-visual.md:156`） | 同上 |
| `transform.overflow` | scale-down / wrap | **scale-down**（`transform.md:84`） | 同上 |
| `canvas.blur` | 0–1 | 「运行时默认 0.75」（`segment-visual.md:76`） | 0.75（文档声明） |
| `matting.stroke_size` | 0–100 | **35**（`segment-visual.md:190`） | 同上 |
| `time.speed` | >0 | 未声明（文档用「speed 缺省 1」表达语义，`timeline.md:97`） | **未知**（是否回写 1 未声明） |
| `alpha.value` | 0–1 | 未声明 | **未知** |
| 转场样式/叠化曲线 | 无枚举（由 ref 决定） | — | **未知 + 闭源** |
| 响度均衡目标 LUFS | 无 | 未声明 | **未知 + 闭源** |

> 特别注意：**协议允许 `volume` 到 1000，但文档明确说「1000 不是普通默认值」**（`segment-audio.md:47`）。不要把「能取到 1000」误读成「常用来做强调」。

---

## 9. 「新建草稿 → 追加片段 → 加音乐」的实际调用链

### 9.1 结论：这条链在 `DraftEditing`，不在 `canvas-cli`

- **唯一草稿写入口是 `DraftEditing`**（`xml/SKILL.md:11`；`prompt/editing-agent-fornax-sp.md:18`）。
- 空草稿的容器（`draft` + `main` + `multi`）可以**一次性 bootstrap**（`prompt/editing-agent-fornax-sp.md:193`），并且首次空草稿按结构化 `aspectRatio` 初始化，未指定时跟随素材（`prompt:194`）。
- 新建草稿时可以同时准备装配输入：视频/图片从首轮纳入 `video`，音频纳入 `audio`（`prompt:86`）；`operation=create` 本身**不证明**草稿为空或初始结构已知，仍须读现状（`prompt:74`）。
- 典型写法（示意，来自官方示例）：往 `multi` 追加节点的表达式形如
  `draft.select("multi").appendXml('<text id="title"><time start="0" duration="3000"/><content><sub text="标题文案"/></content></text>'); draft.apply();`
  （`prompt/editing-agent-fornax-sp.md:151`）。同构地，往 `main` 追加 `<video>`/`<image>`、往 `multi` 追加 `<audio>`。
- 影响 ≤3 个去重片段时可一次表达式 + `draft.apply();`；>3 或命中数不确定时先保存 target、核对后再单独 `apply`（`xml/SKILL.md:41`；`selection.md:9,64`）。
- `DraftEditing` 不接收完整 draft 文档、命令、路径（`xml/SKILL.md:11`；`prompt:180`）。

### 9.2 `canvas-cli` 的真实职责（避免误用）

`cli/` 是**画布节点** CLI：创建文本/链接/图片/视频/音频卡、改生成输入、分组整理、重生成（`cli/SKILL.md:62-124`）。它与时间线的关系只有「音频卡有 `subType`」这一层：

> `audio set-sub-type`：`music`（音乐）、`sound_effect`（音效）、`speech`（文本朗读）、`voice`（配音）（`cli/references/edit.md:145-152`）；`add audio` 的 `subType` 必填（`cli/references/create.md:111`）。

`cli/` 里**没有** main/multi、time、volume、beats、transition、loudness 任何字段（§0.3 检索为 0 命中）。所以「新建草稿 + 追加片段 + 加音乐」不能通过 canvas-cli 完成；`canvas batch` 的 stepResult 串联（`cli/references/requests.md:161-233`）是画布节点事务，不是草稿事务。

### 9.3 一个完整的时序（按文档规则拼）

| 步骤 | 动作 | 证据 |
| --- | --- | --- |
| 1 | `AnalyzeAsset` 分析本地视频/音频，拿 `blueprint_ref` 与真实 duration | `xml/SKILL.md:20`；`prompt:161` |
| 2 | 读草稿现状（新建也要读，`operation=create` 不等于空） | `prompt:70-74` |
| 3 | `DraftQuery({"kind":"schema","names":["base","video","audio"]})` 读齐规则 | `prompt:100-107` |
| 4 | `DraftEditing` bootstrap：`draft` 根（显式 width/height、version、loudness 按授权）+ `main` + `multi` | `xml/SKILL.md:33`；`timeline.md:37`；`prompt:193` |
| 5 | `main` 下按顺序 append 各片段 `<time duration material_start speed/>` | `timeline.md:54,96,106-108` |
| 6 | 非尾段加 `<transition ref duration/>`（可选，需已绑定转场资源） | `segment-visual.md:220-231`；`xml/SKILL.md:22` |
| 7 | `multi` 下 append `<audio ref volume>` + `<time start duration>` + `<fade>` + `<beats>` | `segment-audio.md:36-49` |
| 8 | 一次 apply；>3 片段则分步保存/核对/apply | `xml/SKILL.md:41`；`selection.md:64` |

---

## 10. 对本项目可复用的最小字段集（Node + ffmpeg，自有 BGM）

> ⚠️ 本节第二、三列是**本项目的工程翻译**，不是剪映文档的结论；第一、四列才是协议事实与可复刻性判断。

### 10.1 可复刻的协议语义（最小集）

| # | 语义（协议事实） | 协议字段与证据 | 本项目 ffmpeg / 自有实现 | 可复刻性 |
| --- | --- | --- | --- | --- |
| 1 | 主轨按顺序串联，无显式 start，时长隐式累积 | `main` 子节点顺序（`timeline.md:47,54,96`） | 片段列表按数组顺序；`concat` demuxer 或 `xfade` 链 | ✅ 完全可复刻 |
| 2 | 单片段在时间线上占 `duration`，不随 speed 改写 | `time.duration`（`timeline.md:106`） | 输出时长 = duration；`setpts=PTS/speed` 后再 `trim` | ✅ |
| 3 | 源取用起点 `material_start` | `time.material_start`（`timeline.md:107`） | `trim=start=material_start/1000` | ✅ |
| 4 | 源消耗 = `material_start + duration*speed`，且 ≤ 源时长 | `timeline.md:97`；`segment-audio.md:32` | 先探测时长再算 trim，越界即报错（对应本项目 `_validateConcatDuration` 的思路） | ✅（必须自己校验） |
| 5 | 转场挂边界、有后继才可加、尾段禁止 | `segment-visual.md:224` | xfade 链只在相邻对之间插入，末段不加 | ✅ |
| 6 | 转场时长 300–800 起调，1000 对短镜头偏慢；不参与主轨累计 | `segment-visual.md:225,229` | xfade `duration` ∈ [0.3, 0.8]s；与成片总长的关系需自定（协议未声明） | ✅（建议值可照抄） |
| 7 | volume 线性幅度百分比 0–1000，默认 100 | `segment-audio.md:47`；`segment-visual.md:253` | `volume=<value>/100`（50→0.5，200→2.0） | ✅ 语义一一对应 |
| 8 | 配乐轻于原声 30–60；突出音乐 120–200 | `segment-audio.md:40` | BGM `volume` 取 0.30–0.60（原声 1.0） | ✅ 起始值可照抄，最终要实测 |
| 9 | 淡入/淡出是毫秒时长，作用于片段首尾 | `segment-audio.md:21,26-28` | `afade=t=in:d=in/1000`；`afade=t=out:st=(D-out)/1000:d=out/1000` | ✅ |
| 10 | 配乐必须在副轨（multi），不能进主轨 | `timeline.md:54,64-70`；`segment-audio.md:37` | 音频作为独立输入，`amix`/`sidechaincompress` 与视频流并行 | ✅ 结构同构 |
| 11 | 单个逻辑 BGM 连续覆盖；长裁短、短循环补齐；不变速拉长/不静音补尾 | `recall/rules/audio.md:9,11` | `-stream_loop -1` + `-t`，或 `atrim` + `aloop`；禁止 `atempo` 拉长 | ✅ |
| 12 | 有对白时默认保守 ducking（人声出现压低音乐） | `recall/rules/audio.md:13` | `sidechaincompress`（阈值/比例需自调，协议无数值） | ⚠️ 语义可复刻，参数不可复刻 |
| 13 | 有无对白决定是否交接触发「草稿级响度均衡」 | `recall/rules/audio.md:13`；`timeline.md:35` | 有对白 → 走 `loudnorm` 两遍；无对白 → 只做峰值归一 | ✅ 开关语义可复刻 |
| 14 | 响度均衡不改变手工 volume / 静音 / fade | `timeline.md:35` | 先 `volume`+`afade`，后 `loudnorm`（顺序需实测） | ✅ 可复刻为处理顺序 |
| 15 | 片尾淡出用 fade/animation，不用 transition | `segment-visual.md:224` | 尾段 `fade=t=out` 或视频 `fade`，不加 xfade | ✅ |
| 16 | fit=cover/contain 适配画布；fit 与 scale 互斥 | `transform.md:55,76` | `scale=...:force_original_aspect_ratio=increase/decrease` + `crop`/`pad` | ✅ |
| 17 | 画布 width/height 必须成对显式；比例变化要重排受影响的视觉节点 | `xml/SKILL.md:33-35` | 输出分辨率显式定；每片段统一 scale/pad | ✅ |

### 10.2 依赖剪映闭源能力、无法复刻的部分

| 能力 | 为什么不可复刻 | 证据 |
| --- | --- | --- |
| **转场样式 / 「叠化」的具体观感** | `<transition>` 只有 `ref` + `duration`，样式由平台资源实现，协议无任何参数描述 | `segment-visual.md:229-231`；`xml/SKILL.md:22` |
| **平台音乐 / 音效 / 资源 ref 体系** | ref 由 MaterialRecall 签发（closed resource library），不是文件路径，不能离线生成 | `xml/SKILL.md:13,20`；`selection.md:56` |
| **beats metadata（节拍点检测）** | 协议只消费「已有 metadata」，禁止自造节拍点；metadata 由平台侧 `analyze_beats` 产出 | `segment-audio.md:9`；`recall/rules/audio.md:15,17` |
| **草稿级响度均衡的实际算法** | 只有 on/off，无 LUFS 目标、无压缩曲线、无默认值 | `timeline.md:35`；§5.4 全文检索无 LUFS |
| **ducking 的具体参数** | 文档只写「保守 ducking」，无阈值/比例/攻击释放 | `recall/rules/audio.md:13` |
| **DraftEditing 的 apply/sync 引擎与 readback 归一化** | authoring-only 布局字段在 sync 后可能被归一化成等价几何，行为由闭源引擎决定 | `transform.md:59`；`xml/SKILL.md:44` |
| **字幕识别 / 歌词识别（ASR）** | 是宿主能力（subtitle_recognize / lyric_recognize），不是可计算的本地算法 | `extensions.md:23-49,85-87` |
| **智能抠像（ai/sam3）、美颜、美体、AI 特效** | 依赖平台模型与资源（matting mode=ai/sam3 等） | `segment-visual.md:161-194` |
| **曲线变速预设资源** | `speed_curve` 预设模式只写 ref，预设曲线由平台资源提供 | `timeline.md:73-86` |
| **平台模板 / 素材包 / 蒙版 / 滤镜 / 特效资源** | 全部通过 resource_ref 消费 | `timeline.md:40`；`segment-visual.md:136-158` |
| **关键帧 / MotionGraph** | 协议明确 `no-support` | `no-support.md:5-15` |
| **人声分离 / 人声美化** | 协议明确暂不支持 | `no-support.md:17-20` |

> 对本项目的实际含义：**「剪映怎么把多段接起来」「配乐挂在哪、音量给多少、淡入淡出多长、有对白时该不该开响度均衡」这些语义可以整段照抄；「转场长什么样、节拍点在哪、响度均衡具体做了什么」必须用自己的实现替换，且不能声称与剪映等价。**

---

## 11. 未知 / 待验证清单（禁止推测的项）

1. 转场 `duration` 的协议上限（无声明）与剪映实际默认值 → 未知。
2. 转场是否使成片总时长变短（协议只说不参与主轨累计）→ 未知。
3. 「叠化」对应哪个转场资源、其曲线/混合方式 → 未知。
4. `fade` 的默认 in/out → 未知。
5. `beats.level` 默认档、`beats` 在无 metadata 时的行为 → 未知（协议要求有 metadata 才写）。
6. `loudness_normalize` 默认值、目标 LUFS、压缩/限幅参数 → 未知。
7. `musicN` 与 `audioN` 在同一个 `ref` 字段上的映射关系 → 未知。
8. 剪映导出时对 `duration` 与帧率对齐的取整规则（文档只提示「不得使用素材声明的原始时长预估帧对齐后的联动量」，`selection.md:74`）→ 未知。
9. `main` 总时长与音轨超出主轨时的行为（文档只要求源区间不越界，未描述音轨长于主轨的结果）→ 未知。
10. 剪映 GUI 的实际默认工程（例如新建草稿默认 fps/画布）→ 未取证（本次禁止启动 GUI）。

---

## 附录 A：证据索引（文件 → 本文件引用的行号）

| 文件 | 行号 |
| --- | --- |
| `xml/SKILL.md` | 11, 13, 14, 20, 22, 30, 33, 34, 35, 36, 41, 43, 44, 45, 59, 65, 69, 71, 83 |
| `xml/references/timeline.md` | 26-44, 35, 37, 40-41, 43, 44, 47, 50, 54, 64-70, 73-86, 90-97, 100-109 |
| `xml/references/segment-visual.md` | 16-28, 72, 76, 109-121, 136-158, 154, 156, 161-194, 190, 220-231, 233-243, 245-257, 253 |
| `xml/references/segment-audio.md` | 5-14, 9, 13, 14, 16-28, 21, 26-28, 30-34, 32-34, 36-49, 37, 40, 46, 47, 49-50, 52-64, 61, 62, 64 |
| `xml/references/transform.md` | 49-95, 51, 53, 54, 55, 56, 59, 73-76, 82-84, 89, 90, 92-93 |
| `xml/references/selection.md` | 7-9, 36-45, 45, 56, 63, 64, 74, 86, 87, 93 |
| `xml/references/extensions.md` | 12, 21, 23-49, 31, 85-87 |
| `xml/references/no-support.md` | 5-15, 17-20 |
| `cli/SKILL.md` | 62-124 |
| `cli/references/requests.md` | 161-233 |
| `cli/references/create.md` | 111 |
| `cli/references/edit.md` | 145-152 |
| `recall/SKILL.md` | 40, 87 |
| `recall/references/rules/audio.md` | 9, 11, 13, 15, 17, 35 |
| `recall/references/rules/visual.md` | 28, 33, 35 |
| `prompt/editing-agent-fornax-sp.md` | 18, 53-56, 70-74, 84-86, 100-107, 149-151, 161, 180, 182, 193, 194 |
| `skills/audio-rhythm/SKILL.md` | 11 |
| `skills/skill-creator/references/editing/timeline.md` | 8, 15, 27 |

（`cli/scripts/protocol.json` 无行号，按 §0.3 的关键字检索结果作为证据。）
