# 剪映「拼接 + 配乐」模块 —— 复刻规格（面向本项目 app/）

> 结论文档。上游证据三份：
> - 协议层 `jy-protocol.md`（XMLDraft 时间线与音频语义，538 行）
> - 算法层 `jy-native-audio.md`（拍点 / 镜头检测 / 响度，861 行）
> - 加密层 `jy-draft-cipher.md`（草稿明文未解出，附 `decode-draft.mjs`）
>
> 目标程序：剪映专业版 **11.6.0.14552**（`D:\JianyingPro\11.6.0.14552`，只读）。
> 本文第三列为证据强度：**[观测]** 有文件/偏移/行号可直接复核；**[推断]** 有依据但未直接证实；
> **[工程选择]** 是本项目的决定，不是剪映的实现。

---

## 0. 一页结论

1. **「拼接」在剪映里不是一道工序，而是一个数据结构**：主轨 `<main>` 下**按文档顺序**排列的 `video/image` 片段，
   每段只声明「在时间线上占多久」(`duration`) 与「从源素材哪一段取」(`material_start` / `speed`)，
   **主轨不写 `start`**——累积位置由顺序隐式决定。**[观测]**
2. **「配乐」是两条独立的轨**：BGM 走副轨 `<audio>`（`multi` 容器），永远进不了主轨；
   真正的「把短曲铺满长片」由引擎 `splicing_info` 完成——`loop_order`（可重复的片段顺序）+ `valid_crossfade_loops`
   + `cross_fading_frame_len`（**单位是帧**）+ `beat_times`。**[观测]**
3. **响度是这套系统里唯一给出确定数值的部分**：`-23 / -12 / -12 / -14 LUFS`（默认 / 抖音 / TikTok / YouTube），
   度量是 **ebur128**，合法区间 **[-70, 0] LUFS**；响度过低的片段**拒绝处理**，不做无脑拉平。**[观测]**
4. **剪映 PC 端没有 ducking、没有 EQ**：`po` 全表 18211 条里 `闪避|duck|避让|压低` 命中 **0**。
   底层库有 `sf_compressor_process_stereo_sidechain`，但没有产品入口。**[观测]**
   所以本项目要的「人声出现压音乐」**必须自研**——本文给了一条已实测的侧链链路（§6）。
5. **不要照抄的东西**：转场样式（只有资源 `ref`，无参数）、平台音乐/音效 ref 体系、加密模型内的拍点参数、
   以及任何「剪映默认 0.3s / 0.5s」的说法——默认交叉淡化时长是**服务端下发的 AB 配置，本地没有**，不存在可抄的常数。**[观测]**

---

## 1. 剪映这套模块的三个真身

| 层 | 载体 | 作用 | 本文用途 |
|---|---|---|---|
| 编排层 | `canvas_agent/skills/**` 的 XMLDraft 协议 | 决定「第几段、从哪开始、占多长、第几段加转场」 | 拼接规则照抄 |
| 音频引擎 | `audioeffect.dll` 的 `splicing_info` | 把 BGM 片段列表 + 循环顺序 + 拍点，生成一条对齐、带接缝淡化的音轨 | 配乐铺满策略照抄 |
| 响度体系 | `videoeditor.dll` 的 `MaterialAudioBalance` + `ebur128` | 逐片段测 `average_loudness`，各自增益到统一 `target_loudness` | 混音口径照抄 |
| 拍点 | `music_beats` 任务（云端 URL 或本地 `bt_espresso_mobile_offline`） | 产出 `beat_times` / `output_downbeat_times` | 只能自研替换 |

---

## 2. 拼接：可照抄的规则

| # | 规则 | 证据 | 本项目落地 |
|---|---|---|---|
| 1 | 主轨按顺序串联，**不写起点**，时长隐式累积 | `jy-protocol.md` §6 | 片段数组顺序；不要手工算累计偏移 |
| 2 | 单段在时间线上占 `duration`，**不随 `speed` 改写**；`speed=2` 消耗 2 倍源素材 | `timeline.md:106` | 输出时长 = duration；先 `setpts`/`atempo` 再 `trim` |
| 3 | 源消耗 = `material_start + duration × speed`，必须 ≤ 源真实时长，否则拒写 | `timeline.md:97`、`segment-audio.md:32` | 先 ffprobe 再算 trim，越界即报错（对应现有 `_validateConcatDuration` 思路） |
| 4 | 转场**只能挂边界左侧**，末段禁止；结尾淡出用 `fade`/`animation`，不用 transition | `segment-visual.md:224` | xfade 链只在相邻对之间插入；尾段不加 |
| 5 | 转场时长推荐 **300–800 ms**，1000 ms 对短镜头明显拖慢；**协议无上限**，也**无样式枚举** | `segment-visual.md:225,229` | 取 0.3–0.8s；样式只能用自家 xfade 的 transition 名 |
| 6 | 转场「不参与主轨时间线累计」 | `segment-visual.md:229` | **与本项目现状不同**：现有 xfade 会让成片 = Σ片段 −(N−1)×F（`AGENTS.md` §6）。二者都可接受，但要明确选一种并写进质检口径 |
| 7 | 淡入淡出是毫秒时长，且**片段过短时自动缩短** | `segment-audio.md:23`；`po: pc_copy_short_duration_effect` | `fade = min(requested, clip_duration/2)`，否则短片段会被吃掉 |
| 8 | 拼接产物时长以**实际解码总长**为准，不信声明值 | `audioeffect.dll` 错误串 `use inTotalSec as end_sec_` | 与 `AGENTS.md` §4.3 完全一致，继续保持 |

**明确的态度选择**：剪映 Agent 的默认取向是「没证据就硬切」（`rules/visual.md:33`），
而本项目 `TRANSITION_ENABLED=true` 默认淡化。这不是错误，是**产品取舍**——
但若要贴近剪映语义，建议把「转场」从"默认开"改为"按边界证据判定"，或至少在文档里写明这是本项目的风格选择而非剪映行为。

---

## 3. 配乐：可照抄的规则

| # | 规则 | 证据 | 本项目落地 |
|---|---|---|---|
| 1 | BGM 必须在副轨，主轨只收 video/image | `timeline.md:54,64`；`segment-audio.md:37` | 音频独立输入 + `amix`，结构已同构 |
| 2 | 默认**只保留一个逻辑 BGM，连续覆盖主轨** | `rules/audio.md:9` | 现有 `resolveTrack` 单曲策略一致 |
| 3 | 长音乐在目标终点**裁切**；短音乐**循环同一资源补齐**，最后一轮在终点裁切 | `rules/audio.md:11` | 环境音已 loop；音乐轨应改为 loop+裁切，见 §5 差异 1 |
| 4 | **禁止**变速拉长、**禁止**静音补尾、**禁止**拼接无关音乐；循环不改变既定音量 | `rules/audio.md:11` | 现有 `atempo` 拉长**违规**，见 §5 |
| 5 | `volume` 是**线性幅度百分比**：0 静音 / 50 半幅 / 100 原幅 / 200 两倍，范围 0–1000 | `segment-audio.md:47` | `volume=<v>/100`；不要把 1000 当常用值 |
| 6 | 配乐轻于原声 **30–60**；突出音乐 **120–200**（都是"起调值"，不是终值） | `segment-audio.md:40` | BGM 起始 0.30–0.60；最终必须实测 |
| 7 | 人声在场且风格未定时：选无人声、弱旋律、低存在感音乐 + **保守 ducking** | `rules/audio.md:13` | 音乐选型规则可照抄；ducking 需自研（§6） |
| 8 | 有人声 + 新增/更新 BGM 时，默认**开启草稿级响度均衡**；响度均衡**不替代** ducking | `rules/audio.md:13` | 两者都要做，不能二选一 |
| 9 | 响度统一目标：**-23**（默认）/ **-12**（抖音/TikTok）/ **-14**（YouTube）LUFS；区间 `[-70,0]`；真峰值 `dBTP` 需显式启用 | `jy-native-audio.md` §7.1–7.2 | Android TV 长片建议 **-14 ~ -16 LUFS**，`true_peak=-1 dBTP` |
| 10 | 响度**过低**的片段拒绝处理（不放大噪声） | `po: pc_loudness_low_unavailable` | 增益上限钳制，例如 ≤ +12 dB，超限只记录不处理 |
| 11 | 响度均衡的做法是**逐片段测 `average_loudness` → 各自增益到目标**（静态归一，不是压缩器） | `MaterialAudioBalance` | 对应"每段 ebur128 → volume=dB"；见 §5 差异 2 |

---

## 4. BGM 拼接引擎的真实契约（`splicing_info`）

`audioeffect.dll` 反序列化结构（`deSerilizeSpliceInfo`）：

| 字段 | 含义 | 备注 |
|---|---|---|
| `clip_begin_sec` / `clip_end_sec` | 每个片段在源曲里的入/出点（秒） | 出点越界直接报错 |
| `loop_order` | 片段播放顺序，**允许重复** | 空则 `loop_order is empty, process failed.` |
| `valid_crossfade_loops` | 哪些接缝允许交叉淡化 | 接缝级开关 |
| `output_duration_sec` | 目标总时长 | |
| `beat_times` | 拍点时间戳（输入） | 与编排层 `beats` 对应 |
| `cross_fading_frame_len` | 交叉淡化长度，**单位是帧** | 换算：帧数 ÷ fps（或 ÷ 采样率/帧长） |
| `output_downbeat_times` / `output_beat_info` | 输出：重拍与拍点信息 | |
| `fallback` | 降级模式 | 日志 `fallback mode: %d` |

**这就是用户所说"拼接 + 配乐模块"最核心的接口**：给片段表 + 循环顺序 + 拍点 + 淡化帧长，
引擎产出「按拍点对齐、接缝交叉淡化」的一条完整音轨。
本项目的 `bgmPlan.js` + `audioMixer.js` 已经在做同一件事，只是缺 `loop_order` 语义与帧单位换算。

---

## 5. 与本项目现有实现的逐条差异

> 对照文件均在 `app/src/processors/`。**本节只列差异，未改任何代码。**

| # | 现状 | 剪映语义 | 建议 |
|---|---|---|---|
| 1 | `bgmPlan.js:146-155` 用 `atempo` 把源区间**拉伸/压缩**到目标时长 | **禁止变速拉长**（`rules/audio.md:11`） | 删除拉伸分支，改为 `loop_order`（同曲循环）+ 终点裁切；`atempo` 只保留给用户显式要求的变速 |
| 2 | `audioMixer.js:579` 对整条混音做一次 `loudnorm=I=-20:TP=-1.5:LRA=11` | 逐片段测 `average_loudness` → 各自增益到目标；目标 `-23/-12/-14` | 改为「逐片段 ebur128 → 求增益 → `volume=<g>dB`」，最后一条 `alimiter` 兜真峰值；TV 长片建议 -14~-16 |
| 3 | 全仓 `duck|sidechain|agate` **0 命中**（已实测 grep） | 产品层也没有；但 Agent 规则要求「保守 ducking」 | 新增侧链闪避，参数见 §6（已实测 -8.7 dB） |
| 4 | `waveform.js:30` 解码到 **8 kHz mono** | 拍点模型输入通常 ≥16 kHz | 拍点分析单独用 22.05 kHz 解码，波形展示仍可 8 kHz |
| 5 | `bpm` 只是手工元数据（`audioMixer.js:669,688`） | `beats_json` 由引擎产出，含 `beat_times`/downbeat | 若要「卡点」，加一次性离线分析并缓存 JSON |
| 6 | 转场固定 0.4s（`config.TRANSITIONS`） | 300–800ms，按相邻片段时长选；末段禁加 | 已满足基础区间；补「短片段钳制」（`F ≤ min(D_left, D_right) × 0.5`） |
| 7 | 淡入淡出 `fadeInSec=2 / fadeOutSec=2`（`audioMixer.js:386-387`） | 片段过短要缩短 | 已有 `Math.min(fadeSeconds, videoDuration/4)`（`:570`），口径可再收紧到 `clip/2` |

---

## 6. 缺失能力：侧链闪避（ducking）—— 已实测

剪映没有这个功能，所以参数是**本项目的工程选择**，不是抄来的。实测链路与数值：

```bash
# 主输入 = BGM，侧链 = 人声
[0:a][1:a]sidechaincompress=threshold=0.12:ratio=4:attack=20:release=250:makeup=1[sc];[sc]apad[out]
```

原型：`proto/ducking-check.mjs`（自带 ffmpeg、无第三方依赖、不使用管道）。

**实测结果**（BGM = `app/assets/bgm/calm/morning.mp3`，测试人声 = 0–2s 有声 / 2–4s 静音）：

| 处理 | 人声段 mean | 静音段 mean |
|---|---|---|
| BGM 单独 | −21.3 dB | −21.1 dB |
| 闪避后 | −30.0 dB | −21.1 dB |

→ **人声段额外衰减 −8.7 dB，静音段 0 dB 变化**（说明不是整体压音量，而是真侧链）。

参数扫描（可复现）：

| threshold | ratio | 人声段额外衰减 |
|---|---|---|
| 0.02 | 12 | −24.9 dB（过猛，BGM 几乎消失） |
| 0.08 | 4 | −11.4 dB |
| **0.12** | **4** | **−8.7 dB（默认）** |
| 0.20 | 3 | −4.8 dB |

复现命令：

```powershell
cd "C:\Users\14872\Desktop\测试"
node docs/spec/re-jianying/proto/ducking-check.mjs
# 调参：--threshold 0.08 --ratio 4 --attack 20 --release 250
# 换曲：--bgm app/assets/bgm/epic/ice_giants.mp3
```

**一个实现坑（已踩并修正）**：`sidechaincompress` 的输出比主输入短（实测 8.000s → 7.895s），
必须 `apad` + `-t` 补齐，否则成片音轨比画面短一截——这类"少几十毫秒"的问题正是 `AGENTS.md` §4.3 要防的。

---

## 7. 不能复刻的部分（必须承认不等价）

| 能力 | 为什么 | 证据 |
|---|---|---|
| 转场样式 / 叠化观感 | `<transition>` 只有 `ref` + `duration`，样式在平台资源里，无任何参数 | `segment-visual.md:229-231` |
| 平台音乐 / 音效 ref | 由 `MaterialRecall` 签发，不是文件路径，离线无法生成 | `xml/SKILL.md:13,20` |
| 拍点模型参数 | 模型文件是加密容器（一部分 `SAMI` 外壳，`bt_*`/`music2vibes*` 为三块 TLV 外壳），密钥不落地 | `jy-native-audio.md` §2.2–2.4 |
| 拍点密度档 level 0–4 | **全安装目录无此枚举**；只有 `level`/`level_count` 请求参数，语义未知 | 同上 §4.4、§9 |
| 响度均衡的实际算法曲线 | 只知道目标值与度量（ebur128），压缩/限幅细节闭源 | `timeline.md:35`；§7.1 |
| 默认交叉淡化/淡入淡出时长 | 服务端 AB 下发，本地 `ve_ab_conf.ini` 无此键 | `jy-native-audio.md` §8.2 |
| 关键帧 / MotionGraph / 人声分离 / 人声美化 | 协议明确 `no-support` | `no-support.md:5-20` |

---

## 8. 未解清单（下一轮）

1. 转场是否让成片变短 —— 协议只说"不参与主轨累计"，导出时的实际行为**未取证**（需真机导出对比时长）。
2. 真实时间线字段值 —— 草稿是 `base64 + 带 nonce 的对称加密`（方案名 `jianying_draft_encrypt_v2`），
   密钥在 `crypto_key_store.dat`（本机不存在）。已定位 3 个函数 RVA，见 `jy-draft-cipher.md` §4。
3. `beats.level` 的实际取值语义（本地无任何枚举证据）。
4. `material_audio_balance` 的作用域是"片段"还是"整轨"（字段挂在 `item.` 下，倾向片段）。

---

## 9. 三条最省力的落地顺序（建议）

1. **先做响度**（收益最大、风险最低）：逐片段 ebur128 → 增益到 -14~-16 LUFS + `alimiter` 兜 -1 dBTP。
2. **再补 ducking**：把 §6 的链路接进 `audioMixer` 的混音图，仅在"有对白/有原声要保"时启用。
3. **最后动拼接**：把 `atempo` 拉长换成 `loop_order` 语义，并把转场改成"按边界证据 + 时长钳制"。
   拼接一旦重编码就变慢（`AGENTS.md` §6 实测 1.40×），不值得为风格偏好先动它。
