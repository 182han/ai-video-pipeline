# 剪映 11.6.0.14552 音频算法层逆向取证报告（拍点 / 镜头检测 / 响度混音）

> 任务：task-2 ｜ 目标：`D:\JianyingPro\11.6.0.14552`（**只读，未启动 GUI、未联网、未修改任何文件**）
> 出具：2026-10-27 ｜ 标注约定：**[观测]** = 直接读到的字节/字符串；**[推断]** = 由观测推导，可能有其他解释；**[未知]** = 本次未取得证据
> 所有数值都附「可复述命令」，集中列在 §11；正文中的偏移量单位为字节（`0x` 十六进制）。

---

## 0. 结论（先给三个必答题）

| 必答问题 | 结论 | 证据强度 | 关键数字 |
|---|---|---|---|
| **拍点密度档 level 0~4 对应什么可量化行为？** | **未观测到任何 0~4 的档位枚举**。真实存在的是 `mode` / `level` / `level_count` 三个**请求参数**，以及产品层两档「踩节拍 I / II」。`level` 的取值域与每档行为**没有在安装包里**（不在 DLL 字符串、不在明文 JSON、模型被加密） | **[观测]** 参数名 + 日志格式串；**[未知]** 取值语义 | `mode={} level={} level_count={}`（videoeditor.dll `0x32B51C0`） |
| **拍点来自本地模型还是云端？** | **两条路都在代码里，同一次调用二选一**：① 云端 `music_beat_url` / `music_beat_v1_url`（先把音频抽出来上传，`lyra_music_beats_` 临时文件）；② 本地 `capcut_local_ai_beat` + `local_model_path` / `model_path`。安装包内确实随附**离线拍点模型** `bt_espresso_mobile_offline_v1.4.model`（"offline" 写在文件名里） | **[观测]** 两套参数名 + 随附模型文件；**[推断]** 默认走云、本地作降级（见 §4.2 的 `fallback` 痕迹，但未拿到直接判据） | 云端 3 个 URL 参数名；本地 2 个路径参数名 |
| **镜头检测阈值 0.35 是什么单位？** | **无量纲分数，取值 [0,1]**，不是秒、不是像素、不是距离。它是 `compress_shot_detect` 节点对「滑窗内是否发生镜头切换」的**后处理判决分数**，模型头（PredHead）输出后与之比较 | **[观测]** 参数名 `post_process_threshold=0.35`、滑窗 7、特征 128 维；**[推断]** 是概率/归一化分数（阈值量纲由名字 `post_process_threshold` + 位置在 predhead 之后决定） | 96×96 输入、window=7、dim=128、thr=0.35 |

**最重要的一条负面结论（对复刻方案有直接影响）**：
剪映 PC 端**没有**「闪避 / ducking」功能，也**没有**面向用户的 EQ。po 全表 18211 条里
`闪避|duck|避让|压低` 命中 **0** 条，`均衡|equalizer|EQ` 只命中「响度均衡」这类文案（§9）。
这两件事必须自己实现，不能"照抄参数"。

**最重要的一条正面结论（可直接照抄的数值）**：
「响度统一」的四个内置目标值是**明写在 po 的 `msgstr` 里**的，不是推断：
**默认 -23 LUFS / 抖音 -12 LUFS / TikTok -12 LUFS / YouTube -14 LUFS**（§7.2，双向验证）。

---

## 1. 方法与边界

| 项 | 事实 |
|---|---|
| 分析对象 | `Resources\models\audiomodel\*`、`Resources\audiosami\*`、`Resources\audio_metrics\*`、`Resources\SceneEditDetection\*`、`Resources\po\zh-Hans.po`、`audioeffect.dll`、`videoeditor.dll`、`VECreator.dll`、`cccreator.dll` |
| 工具 | 仅 PowerShell 5.1 + .NET BCL（`[IO.File]::ReadAllBytes`、`[Text.Encoding]::GetEncoding(28591)`、`[IO.Compression.DeflateStream]`）。**未安装任何新软件**，`rg` 不存在故未用 |
| 手工读的字节数 | 约 5.2 亿字节（四个 DLL 全量分段扫描）+ 9 个模型文件全量 |
| 未做 | 未执行剪映任何 exe/GUI、未联网、未 hook 运行时、未尝试破解密钥 |
| 未取得 | 加密模型内的 JSON 参数、`level` 的取值语义、算法插件本体（见 §5.4） |

**为什么不去挖 REA / 反编译**：本任务的三个必答问题都在「明文字符串 + 明文 JSON + 容器结构」层面可判，
`audioeffect.dll` 已把 SAMI 引擎的**全部参数名**以明文常量表形式留在 `.rdata` 里（§4、§5、§7），
不需要伪代码就能定位参数集合；而数值被加密在 `.model` 里，反编译也拿不到密钥。
故按性价比停在字符串与容器层，把「拿不到」的部分明确写成未知。

---

## 2. 模型容器层：SAMI 容器家族

### 2.1 两种容器（先说结论：都是**同一种加密**的两种外壳）

| 容器 | 文件 | 外壳 | 是否 `SAMI` 魔数开头 |
|---|---|---|---|
| A. SAMI 单块 | `aed40_10m.model`、`audiosami\*.model`、`audio_metrics_v1.4.model` | `"SAMI"` + 24 B 头 + 一块密文 | 是 |
| B. 三块 TLV | `bt_espresso_mobile_offline_v1.4.model`、`bt_streaming_espresso_v1.2.model`、`music2vibes\*.model` | 3 组 `[u32 len][len 字节]` | **否**（文件第 1 字节就是长度，全文件无 `SAMI` 子串） |

> 任务书假设「这些都是 SAMI 开头的自定义容器」——**对 A 组成立，对 B 组不成立**（实测 B 组 `SAMI` 命中数 = 0）。

### 2.2 A 组：SAMI 头结构 [观测]

`audiosami\time_align_time_domain_v1.0.model`（364 B）全量十六进制：

```
      0: 53 41 4d 49 0c 00 00 00 02 00 00 00 01 00 00 00  SAMI............
     16: 00 00 00 00 46 01 00 00 00 00 00 00 d7 2b 0b cd  ....F........+..
     32: ef e1 b9 5c ...                                  ...\.
```

| 偏移 | 类型 | 含义（按证据强弱标注） | 5 个样本的取值 |
|---|---|---|---|
| 0x00 | char[4] | 魔数 `SAMI` | 全部相同 |
| 0x04 | u32 LE | 头长度 = **12** | 全部 `0x0C` |
| 0x08 | u32 LE | 固定 **2** | 全部 2 |
| 0x0C | u32 LE | 模型种类：**1 / 2** | `aed40`=1、`unet_denoise`=1、`time_align_time`=1、`time_align_freq`=**2**、`audio_metrics`=1 |
| 0x10 | u32 LE | 标志位：**0 / 4** | `audio_metrics`=**4**，其余 0（[推断] 可能是"含 analysis 段"或"版本位"） |
| 0x14 | u32 LE | **明文长度**（解密后字节数） | 326 / 959 / 264139 / 1155 / 9779936 |
| 0x18 | u32 LE | 保留 = 0 | 全部 0 |
| 0x1C | 密文 | 从 28 字节起，长度 = `roundup16(明文长度)` | 见下表 |

**可复现的结构恒等式（这是本报告最硬的一条）**：

```
文件总长 == 28 + roundup16(u32@0x14)
```

| 文件 | u32@0x14 | roundup16 | 28+roundup16 | 实际大小 | 校验 |
|---|---|---|---|---|---|
| `audiosami\time_align_time_domain_v1.0.model` | 326 | 336 | 364 | 364 | ✅ |
| `audiosami\time_align_freq_domain_v2.0.model` | 959 | 960 | 988 | 988 | ✅ |
| `audiosami\unet_denoise_44k_music_model_v1.0.model` | 264139 | 264144 | 264172 | 264172 | ✅ |
| `audio_metrics\audio_metrics_v1.4.model` | 1155 | 1168 | 1196 | 1196 | ✅ |
| `models\audiomodel\aed40_10m.model` | 9779936 | 9779936 | 9779964 | 9779964 | ✅ |

→ **[观测]** 载荷按 16 字节分组对齐、尾部带填充；**[推断]** 这是**分组密码密文**（AES 级别的 16 B 块），
且用的是**零填充**而非 PKCS#7（否则 9779936 这个已是 16 倍数的长度也会再补 16）。

### 2.3 B 组：三块 TLV [观测]

三个块，每块 `[u32 LE len][len 字节]`，**首尾相接、精确到 EOF**，且**每块长度都是 16 的倍数**：

| 文件 | chunk0 | chunk1 | chunk2 | 校验 `4+Σ(len+4)` |
|---|---|---|---|---|
| `bt_espresso_mobile_offline_v1.4.model` | 336 | 496 | 394224 | 395068 ✅ |
| `bt_streaming_espresso_v1.2.model` | 768 | 288 | 551632 | 552700 ✅ |
| `music2vibes\music2vibes_video_mobile_v1.0.model` | 176 | 18784 | 5054288 | 5073260 ✅ |
| `music2vibes\music2vibes_match_mobile_v1.0.model` | 240 | 1440 | 709136 | 710828 ✅ |

**[推断]** chunk0/chunk1 是加密的两段头（JSON/描述），chunk2 是加密的权重；三块各自独立按 16 B 填充。
**[未知]** 三块的具体键名与内容（不可解，见 §2.4）。

### 2.4 这些载荷是否可提取明文参数？——**不能，判定为加密** [观测 + 推断]

四条独立证据（任意一条都足以否掉"压缩"或"明文"假设）：

1. **熵**：`aed40_10m` 载荷熵 = **8.0000** bit/byte（完全均匀）；`unet_denoise` = 7.9993；
   `audio_metrics` = 7.8350；`time_align_freq` = 7.7834。明文 JSON 熵约 4.5~5.5。
2. **不是 deflate/gzip/zlib**：对 5 个 A 组载荷直接喂 `DeflateStream`，全部抛
   `未知的块类型` / `块的长度与它的补集不匹配`；且首字节不是 `78 9C`/`78 DA`/`1F 8B`。
3. **不是原始 float32 权重**：把载荷按 float32 解释，最后 64 KB 的取值为
   `min ≈ -3.4e38, max ≈ 3.4e38`（贴着 FLT_MAX），`|v| ≤ 1` 恰好 **49.7%** —— 这是**均匀随机字节**的签名，
   真实神经网络权重不会出现 3e38 这种量级。
4. **同一家族共享前 16 字节密文前缀**（决定性）：不同文件、不同大小，
   `aed40_10m`(9.8 MB) / `unet_denoise`(264 KB) / `time_align_time_domain`(364 B) 三者的载荷**前 16 字节完全相同**：

   ```
   d7 2b 0b cd ef e1 b9 5c a2 3f fb 3b 9b fa 5b d8
   ```

   而 `audio_metrics`(1.2 KB) 与 `time_align_freq_domain`(988 B) 共享另一组：

   ```
   08 20 0f 0f 59 70 75 61 a5 40 35 0b 8f 64 4e 23
   ```

   16 字节 = 一个 AES 块。**相同密钥 + 固定 IV + 相同明文首块 → 相同密文首块**，这是教科书式的
   固定 IV 分组密码特征（[推断] 明文首块大概是同一段 schema 前缀，如 `{"version":...`）。
   压缩流绝不可能跨文件共享 16 字节完全相同的前缀。

**DLL 里的直接旁证**（`audioeffect.dll` 的 `.rdata` 明文常量，全部 [观测]）：

| 偏移 | 字符串 |
|---|---|
| `0xABE040` | `SAMI_ENGINE_XX_MODEL` |
| `0xABE058` | `Illegal decrypted buffer length: ` |
| `0xABE080` | **`SAMI_ENCRYPTED_RESOURCE`** |
| `0xABE0D0` | `Broken model file with too short model length: ` |
| `0xABE100` | `Broken model file with illegal sub-model length: ` |
| `0xABE138` | `Broken model with illegal decrypted model string.` |
| `0xABE1C0` | `Unsupported nn type, only 'espresso(4)' and 'none(-1)' is availa…` |
| `0xA67BEE`（扫描窗 `0xA67BA8`） | `C:\19626\sami_core\common_util\io\sami_core_io.cpp` … `decryptFromMemory` / `decryptFromFile` / `crc check fail!` / `RM file is broken!` |

→ **结论**：模型参数（含 min_bpm/max_bpm/阈值等默认值）**被加密在 `.model` 内，本次无法提取**。
密钥不在安装目录明文里（未做密钥破解，属越界）。**报告中不出现任何"猜测的默认值"。**

---

## 3. 随附模型清单与功能映射

### 3.1 文件（[观测]，均为实测大小）

| 文件 | 字节 | 由文件名/引擎特征名可得的功能 | 容器 |
|---|---|---|---|
| `models\audiomodel\bt_espresso_mobile_offline_v1.4.model` | 395068 | **离线**拍点/BPM（`bt_` = beat tracking，[推断]；`espresso` = 引擎支持的 nn 类型，见 `0xABE1C0` 的 `espresso(4)`） | B |
| `models\audiomodel\bt_streaming_espresso_v1.2.model` | 552700 | **流式**拍点（边播边出拍点） | B |
| `models\audiomodel\aed40_10m.model` | 9779964 | 音频事件检测 AED（`aed`） | A（kind=1） |
| `models\audiomodel\aed_pets_v3.0.model` | 4986988 | 特定音效/宠物声事件检测 | — |
| `models\audiomodel\music2vibes\music2vibes_video_mobile_v1.0.model` | 5073260 | **配乐↔视频匹配**（卡点配乐/智能配乐） | B |
| `models\audiomodel\music2vibes\music2vibes_match_mobile_v1.0.model` | 710828 | 同上，match 分支 | B |
| `models\audiomodel\sentence_score_v1.0/1.1.model` | 6330508 / 4753532 | 句级打分（字幕/ASR 用途，与音频算法无关） | — |
| `audiosami\time_align_time_domain_v1.0.model` | 364 | **时域**时间对齐（拼接/踩点对齐） | A |
| `audiosami\time_align_freq_domain_v2.0.model` | 988 | **频域**时间对齐（kind=2，另一套） | A |
| `audiosami\unet_denoise_44k_music_model_v1.0.model` | 264172 | 44.1 kHz **音乐降噪**（U-Net） | A |
| `audio_metrics\audio_metrics_v1.4.model` | 1196 | **音频客观指标**（响度/削波/相位/频谱质心…） | A（flag=4） |

> `audio_metrics` 的引擎版本串 `1.4.2` 也出现在 `audioeffect.dll` 的 `0xAC664C` 附近（[观测]），
> 与目录名 `audio_metrics_v1.4` 相互印证。

### 3.2 引擎暴露的"能力名"清单 [观测]

`audioeffect.dll` `0xA841C4` 起的一段能力/元数据名表（这是**功能清单最权威的机器可读来源**）：

```
onset                 onset-overall          volume              event-detection
beat-tracking         beat-tracking-offline-overall            music2vibes-video-model
music2vibes-match-model                      global-loudness     global-peak
voice-activity-detection                     voice-activity-detection-overall
nnvad                 nnvad-overall          asr-offline
```
再往后（同为 `0xA8xxxx` 段）是下划线变体：`onset_detection`、`volume_detection`、`spectrum_display`、
`voice_activity_detection`、`beat_tracking`、`beat_tracking_offline`、`kws`、`f0_detection`。

→ **[观测]** 本地引擎一次能算的东西：onset、beat（含 offline 变体）、volume、VAD、全局响度/峰值、
频谱显示、f0、AED、music2vibes 匹配。**这对复刻非常有用：这些就是"剪映本地能给你什么"的边界。**

---

## 4. 自动踩点（拍点检测）的真实参数

### 4.1 `music_beats` 任务的全部参数 [观测]

`videoeditor.dll` 里 `[CommonMediaRunner]` 的 `musicBeats` 任务，日志格式串直接暴露了入参：

```
0x32B51C0 (53170624)
[CommonMediaRunner] music_beats begin: input='{}' mode={} level={} level_count={} output='{}' upload_vid='{}'
```

紧随其后的完整键名表（同一段 `.rdata`，偏移递增，即参数结构体字段顺序）：

| 偏移 | 键名 | 读法（[推断] 依据命名 + 日志位置） |
|---|---|---|
| `0x32B5198` | `level_count` | 请求的拍点档级数 / 返回档数（与 `level` 成对出现） |
| `0x32B51A8` | `upload_vid` | 上传后拿到的媒资 id（云端路径的回填） |
| `0x32B5308` | `upload_uri` | 上传地址 |
| `0x32B5318` | `upload_scene` | 上传场景号 |
| `0x32B5328` | `upload_use_vid` | 是否复用已上传的 vid（去重缓存） |
| `0x32B5338` | `upload_check_cache` | 是否查缓存 |
| `0x32B5350` | `upload_cache_time` | 缓存时间 |
| `0x32B5368` | `music_beat_url` | **云端拍点接口 URL** |
| `0x32B5378` | `music_beat_v1_url` | 云端 v1 接口 URL |
| `0x32B5390` | `music_beat_query` | 云端查询串 |
| `0x32B53A8` | `headers_json` | 自定义 HTTP 头 |
| `0x32B53B8` | `upload_timeout_ms` | 上传超时 |
| `0x32B53D0` | `local_model_path` | **本地模型目录** |
| `0x32B53E8` | `capcut_local_ai_beat` | **"本地 AI 拍点"开关**（capcut = 剪映国际版代号） |
| `0x32B5400` | `model_path` | 具体模型文件路径 |
| `0x32B5478` | `beats_json` | 输出：拍点 JSON |
| `0x32B5488` | `beats_info` | 输出：拍点信息体 |
| `0x32B5498` | `beat_count` | 输出：拍点个数 |
| `0x32B54A8` | `[CommonMediaRunner] music_beats done: beats={} level_count={}` | 结束日志（回显 beats 与 level_count） |

配套日志（同一段，说明它**把音频抽成临时文件再送出去**）：

```
0x32B5230  musicBeats
0x32B5268  lyra_music_beats_                      ← 临时文件前缀（lyra = 字节的云服务名）
0x32B5280  music_beats: extract audio failed:
0x32B52B0  [CommonMediaRunner] music_beats: extracted temp audio '{}' (codec={}, duration_us={})
0x32B5410  [CommonMediaRunner] music_beats failed: {}
0x32B5440  music_beats: write output failed:
```

### 4.2 本地还是云端？——两套都在，二选一

| 判据 | 指向 |
|---|---|
| `music_beat_url` / `music_beat_v1_url` + `upload_uri`/`upload_vid`/`upload_scene` + `extracted temp audio` | **云端**：抽音频 → 上传 → 用响应里的拍点 |
| `capcut_local_ai_beat` + `local_model_path` + `model_path` | **本地**：加载本地模型直接算 |
| 安装包内确实有 `bt_espresso_mobile_offline_v1.4.model`（文件名含 **offline**） | **本地推理能力是随包发布的** |
| po 条目 `pc_cloud_continue_rhythm_audio` = "点击「继续」开始踩点处理，但由于当前音频片段还未下载完成，预计耗时更久。" | 踩点需要**完整音频**（云端素材要先下完） |
| po 条目 `changelog_150` = "…1.本地音乐支持智能踩点" | **本地音乐（用户自己的 BGM）支持智能踩点** ← 与本项目需求直接相关 |

**[推断]** 实现上是「云优先、本地兜底」或「按 AB 开关切换」：`capcut_local_ai_beat` 这种布尔命名的灰配置
通常就是开关名。**但哪条是默认，本次没有观测到判据 → [未知]。**
**给复刻方案的建议**：不要依赖"剪映默认走哪条"，两条都要能出同样的 `beats_json` 结构。

### 4.3 拍点还被谁消费

`cccreator.dll`（BEF = ByteDance Effect Framework 层）里有一组把拍点喂给**视觉特效**的接口 [观测]：

```
0x424F4E3 附近：getMusicBeatFilePath   setMusicBeatFilePath
                  setMusicBeatType      setMusicBeatStep
                  setMusicBeatRadius    LuaAudioSpectrumInfo::recognize_stmp
0x4240D49 附近：BEF::EffectInterface::setMusicBeatStep
                  EffectInterface_setMusicBeatStep
```

→ **[观测]** 拍点不仅用来切镜头，还驱动"卡点特效"（按 `beat_type` + `beat_step` 在拍点上触发效果）。
`beat_type` / `beat_step` 是**另一个维度的档位**（与密度 `level` 不是同一个东西）。

### 4.4 「level 0~4」这个说法怎么处理

- **[观测]** 真实存在：`mode`、`level`、`level_count`（云端请求参数）；`beat_metre_1/2`（"踩节拍 I / II"）；
  `velocity_speed_beat_frequency`（"节拍频率"，变速卡点用）；`setMusicBeatType/Step`（特效用）。
- **[未知]** 0~4 五档的枚举、每档对应的最小拍点间隔（秒）、每档对应 BPM 上下限、是否按拍号分组。
- **[观测]** po 里只有**两档**："踩节拍 I"（`beat_metre_1` / `step_on_the_beat_i`）与
  "踩节拍 II"（`beat_metre_2` / `step_on_the_beat_ii`），另有"自动踩点"（`auto_beat`/`auto_click`）、
  "智能打点"（`pc_auto_mark_beats`）、"手动踩点"（`pc_manual_stepping`）、"添加点"（`add_beat`/`pc_add_beat`）、
  "清空踩点"（`pc_empty_spots`）、"删除踩点"（`pc_remove_spots`）。

**对复刻的可执行替代（标 [推断]，是我方设计建议，不是剪映实测值）**：把"密度档"实现成
「最小拍点间隔 + 是否取重拍」两个旋钮即可覆盖 99% 的观感需求：

| 我方档位 | 最小间隔 | 取拍策略 | 对应剪映可见概念 |
|---|---|---|---|
| 稀 | 0.60 s | 只取 downbeat | 踩节拍 II（[推断]） |
| 中 | 0.30 s | 全 beat，滤掉弱起始 | 踩节拍 I（[推断]） |
| 密 | 0.15 s | 全 beat + onset | 自动踩点（[推断]） |
| 极密 | 不限 | onset 全取 | （剪映是否有此档 [未知]） |

> 明确声明：上表的秒数**不是**从剪映取得，是按常见节拍工程经验给的起点值，必须在自己的素材上 A/B 调。

---

## 5. 本机 BPM / 节拍模型的参数面（引擎侧字段名）

### 5.1 拍点模型参数 [观测]

`audioeffect.dll` `0xAC5E10` 起（`sami_core\sami_engine\src\models\tf\beat_tracking_model_tf.cpp` 段落）：

| 偏移 | 字段 | 含义（[推断]） |
|---|---|---|
| `0xAC5E10` | `fps` | 特征帧率（拍点网格的时间分辨率，Hz） |
| `0xAC5E20` | `beats_per_bar` | 每小节拍数（2/3/4/6），决定重拍位置 |
| `0xAC5E30` | `min_bpm` | BPM 搜索下界 |
| `0xAC5E38` | `max_bpm` | BPM 搜索上界 |
| `0xAC5E40` | `dbn_chunk_size` | DBN（动态贝叶斯网）后处理的分块长度 |
| `0xAC5E50` | `use_madmon_only` | 只走 madmon（单模型）分支 |
| `0xAC5E60` | `feature_version` | 特征版本号（决定前端特征提取口径） |
| `0xAC5F30` | `input_1:0` | TF 输入张量名 |
| `0xAC5F40` | `dense_2/Relu:0` | TF 输出张量名（**Relu 输出 → 逐帧拍点激活**） |

→ **[观测]** 架构是 **TF 图 + DBN 后处理**：网络出逐帧激活，`dbn_chunk_size` 控制 DBN 解码窗口。
**这就是"自动踩点"的算法骨架**，也是复刻时最该照搬的部分（madmom 的 DBNBeatTracker 同构）。

### 5.2 BPM 模型参数 [观测]

`0xAC6DC0` 段（`sami_engine\src\models\bpm_model.cpp`）：

| 偏移 | 字段 |
|---|---|
| `0xAC6DC0` | `C:\19626\sami_core\sami_engine\src\models\bpm_model.cpp` |
| `0xAC6E00` | `audio_chunk_size` |
| `0xAC6E18` | `min_audio_chunk_size` |
| `0xAC6E30` | `audio_spec_input` |
| （同段） | `input_2:0` → `dense_6/Softmax:0`、`use_log`、`chunk_shift` |

→ **[观测]** BPM 分支是**分类器**（`Softmax`，`use_log` 开关），不是回归；`chunk_shift` 是分块步进。
**BPM 与拍点是两个模型**（bpm_model / beat_tracking_model），复刻时可以合并也可以分开。

### 5.3 其余相关参数（f0 / onset）[观测]

| 偏移 | 字段 | 备注 |
|---|---|---|
| `0xA88034` | `f0_min` | 描述串："the min f0 that it can detected" |
| `0xA8803C` | `f0_max` | 描述串："the max f0 that it can detected" |
| `0xA88088` | `650` | **[推断]** `f0_max` 的默认值 650 Hz（人声上限合理） |
| `0xA880E8` | `onset_detection_sparse` | 稀疏 onset 检测节点名 |
| `0xA88100` | `interval` | 该节点的参数名 |
| `0xA88110` | `the threshold to get a onset, a lower value can get more onsets` | **官方语义说明**：值越低，onset 越多 |
| `0xA88150` | `200` | **[推断]** `interval` 的默认值（200，单位应为 ms → 每秒最多 5 个 onset） |
| `0xA88190` | `…\audio_algorithm\onset_detection\OnsetDetection.cc` | 实现文件 |
| `0xA87FB0` | `high_pass_freq` | 高通预处理频率 |

> **[推断] `200` 的含义**：紧跟在描述串后、格式与 `650` 一致，说明这些参数表是
> `[name\0][desc\0][默认值字符串\0]` 三元组。若成立，则 onset 阈值默认 200 ms 间隔
> （≈ 5 onset/秒上限）。这条对"密档踩点"很关键：**剪映的上限可能就卡在 ~5 拍/秒**。

### 5.4 算法插件本体不在安装包里 [观测→推断]

`VECreator.dll` 在镜头检测处的日志是：

```
0x9EC7340  init algorithm failed, ret
0x9EC7360  start algorithm failed, ret
```

配合 `jy_compressShotDetectBackbone_new` 这类模型名在任何 DLL 里都搜不到（§6.3），
**[推断]** 具体算法以独立算法包形式**运行时下发**（`Resources\AlgorithmCache\` 只有 1 个 1.5 KB 的
`face_detect_cache.json`，无 .so/.dll 缓存；`ve_enable_algorithm_cache=true` 在 `ve_ab_conf.ini` 里）。
→ **这解释了为什么"阈值=0.35"能从明文 JSON 拿到，而网络权重拿不到。**

---

## 6. 镜头切换检测（SceneEditDetection / CutPointDetection）

### 6.1 `config.json` 全参数（明文，1385 B）[观测]

逐行（行号来自实测文件）：

| 行 | JSON 路径 | 值 | 解释 |
|---|---|---|---|
| 2 | `.version` | `"1.0"` | 图配置版本 |
| 3 | `.mode` | `2` | 节点图执行模式（[推断] 2 = 逐帧流式，配 `array_buffer_producer` 用） |
| 15–16 | `.nodes[0].config.size` | `96 × 96` | **输入帧被缩放到的分辨率**。96×96 是"压缩"档：比 `config_prev` 的 128×128 更省算力，对应骨干名里的 `_new` |
| 30 | `…sliding_window_size` | `7` | **滑窗帧数**。7 帧 ≈ 0.23 s@30fps / 0.12 s@60fps，即"判决只看前后 7 帧" |
| 31 | `…img_feat_dims` | `128` | 骨干输出的**每帧特征维度** |
| 34 | `…post_process_threshold` | `0.35` | **判决阈值**（见 §6.3） |
| 37 | `…backbone_model_name` | `jy_compressShotDetectBackbone_new` | 骨干网络（`jy`=剪映，`_new`=本版） |
| 38 | `…predhead_model_name` | `jy_compressShotDetectPredHead_new` | 预测头 |
| 39 | `…debug_data_save_path` | `""` | 调试落盘，空=关 |

节点类型本身也是信息 [观测]：

- `input_0` = `blit`（把任意帧 blit 到 96×96 的纹理）
- `input_1` = `array_buffer_producer`（把帧序列攒成 buffer）
- `compress_shot_detect_0` = `compress_shot_detect`（算法节点；`compress` = 压缩域/低分辨率）

### 6.2 `config_prev.json` 的差异（上一版）[观测]

| 参数 | 旧版 | 新版 | 变化含义 |
|---|---|---|---|
| 输入尺寸 | `128 × 128` | `96 × 96` | 算力降 44%（面积 0.5625×） |
| 滑窗 | `11` | `7` | 判决延迟降 ~36% |
| `img_feat_dims` | **不存在** | `128` | 旧版维度写死在模型里，新版外露 |
| 阈值 | `0.35` | `0.35` | **两版完全相同 —— 0.35 是稳定调过的值，不是随手写的** |
| 骨干/头 | `jy_compressShotDetectBackbone` / `…PredHead` | `…Backbone_new` / `…PredHead_new` | 模型换代 |

→ **[观测]** 阈值在两代配置里都是 0.35，说明它是**人工调优后固化**的判据。
对复刻直接有用：**你的相似度判决阈值可以拿 0.35 当起点**（但要换算到自己的分数定义，见 §6.3）。

### 6.3 阈值 0.35 是什么单位 [推断，附论证]

**结论：无量纲，[0,1] 区间的分数；不是秒、不是像素、不是特征距离。**

论证链（每条都可复核）：

1. 参数名是 `post_process_threshold`，挂在 **PredHead** 之后 → 它比较的是**头的输出**，而头的输出
   经过 sigmoid/softmax 类激活后天然落在 [0,1]。
2. 值恰好是 `0.35`，两代配置不变；若是像素距离或秒，不可能在输入从 128→96 时保持不变。
3. 若是"相似度距离"（越大越不像），阈值通常写成 0.5/1.0 这类整数邻域；0.35 这种**偏低**的分数
   更像"切换概率 > 0.35 就判为切点"——**即偏保守（宁多勿漏）**，符合一键分割要"多切一点让用户删"的产品直觉。
4. 滑窗 = 7 说明它是**逐窗判决 + 滑窗平滑**，`post_process` 一词也印证"网络输出之后再做 NMS/平滑"。

**复刻建议（[推断]）**：若你用自己的特征（CLIP/直方图/SSIM）做相邻帧距离，**不要**直接把 0.35 当阈值；
应先在自建正负样本上把距离映射到 [0,1]，再让"判为切点"的比例与剪映接近（切点密度 ≈ 每 N 秒一个）。

### 6.4 引擎位置与调用点 [观测]

`VECreator.dll`：

| 偏移 | 字符串 |
|---|---|
| `0x9EC72D8` | `CutPointDetection failed, msg:` |
| `0x9EC72F8` | `../SceneEditDetection/config.json` ← **确认本配置文件就是被它读的** |
| `0x9EC7318` | `../SceneEditDetection/config_prev.json` |
| `0x9EC7340` | `init algorithm failed, ret` |
| `0x9EC7360` | `start algorithm failed, ret` |
| `0x9EC7380` | `CutPointDetection finished` |
| `0x9EC73C0` | `lv-keyframe_recognized` |
| `0x9EC73E0` | `ai shot split` |

po 旁证：`pc_auto_packaging_ai_divide_video_chapter` = "AI划分视频章节，生成章节标题，自动生成章节转场"，
`changelog_200` 提到"上线「智能镜头分割」，支持对时间线片段、素材面板的成片快速拆分"。

---

## 7. 响度 / 混音规则（复刻最关键的一节）

### 7.1 响度归一化的取值范围与度量 [观测]

`videoeditor.dll`（上下文窗口偏移）：

| 偏移 | 字符串（原文） |
|---|---|
| `0x3318EB6` | `true_peak_ceiling cannot be satisfied within effective target_loudness range [-70, 0] LUFS` |
| `0x33195CE` | `'target_loudness' must be in [-70, 0] LUFS` ／ `'true_peak_ceiling' must be in [-70, 0] dBTP` ／ `'true_peak_ceiling' requires enable=true` |
| `0x3319840` | `applied_target_loudness` ／ `measurement_reused` ／ `min_loudness_threshold` ／ `loudness_unit` ／ `peak_unit` |
| `0x33193D8` | `flush ebur128 source:` ／ `flush ebur128 output:` ／ `read ebur128 true_peak:` |
| `0x32FBF88` | JSON 参数声明：`"target_loudness": { "default": 0.0, "type": "double", "key_path": "item.target_loudness" }` |

**可直接照抄的三条规则**：

1. `target_loudness` 合法区间 **[-70, 0] LUFS**，单位是 **LUFS**（EBU R128 / ITU-R BS.1770 积分响度）。
2. `true_peak_ceiling` 合法区间 **[-70, 0] dBTP**（真峰值，单位 dBTP），且**必须先 `enable=true`**，
   否则报 `'true_peak_ceiling' requires enable=true`。
3. 度量实现是 **ebur128**（`libebur128` 的 API 名直接出现在字符串里）→ 复刻时用 `ffmpeg -af ebur128`
   或 `loudnorm` 就能得到**同一尺度**的数，不需要猜算法。

### 7.2 剪映内置的响度目标值 —— **po 直接给出了每个平台的 LUFS** [观测]

这是全报告里**唯一一组既知道名又知道值**的音频参数。`Resources\po\zh-Hans.po` 的 `msgstr` 里
把「键 → 平台 → 目标响度」写全了（实测 15 条 `pc_loudness*`）：

| msgid | msgstr（原文） | 判读 |
|---|---|---|
| `pc_loudness_adjust` | **响度统一** | 功能名 |
| `pc_loudness_set_target` | **目标响度** | 参数名 |
| `pc_loudness_set` | 开启后可统一所单选或多选的原片段响度 | 作用域 = 选中的原片段（可多选） |
| `pc_loudness_default` | 默认 | 预设项「默认」 |
| `pc_loudness_default_twt` | **默认 -23LUFS** | **默认目标 = -23 LUFS** |
| `pc_loudness_dy_twl` | **抖音 -12LUFS** | 抖音预设 = **-12 LUFS** |
| `pc_loudness_tt_twl` | **TikTok -12LUFS** | TikTok 预设 = **-12 LUFS** |
| `pc_loudness_tytb_ft` | **Youtube -14LUFS** | YouTube 预设 = **-14 LUFS** |
| `pc_loudness_adjusted` | 已统一至目标响度%1LUFS | 完成后回显（格式串 `%1LUFS`） |
| `pc_loudness_set_all` | 已统一至目标响度（多个值） | 多选时各自不同 |
| `pc_loudness_process` | 响度统一处理中 %1 | 进度 |
| `pc_loudness_low_unavailable` | **检测到所选片段的响度值过低，暂不支持开启响度统一** | **下界保护规则**（过低直接拒绝，不做增益） |
| `pc_loudness_compound_unavailable` | 暂不支持对复合片段应用该功能 | 作用域限制 |
| `pc_loudness_template_unavailable` | 暂不支持对剪同款片段应用该功能 | 作用域限制 |
| `pc_loudness_digital_human_unavailable` | 暂不支持对数字人片段应用该功能 | 作用域限制 |

**这组值与我先前从 `VECreator.dll` 字符串池单独看到的裸串完全对上**（互相印证，可复现）：

```
0x99FFA88  pc_loudness_default_twt      ←→  po: "默认 -23LUFS"
0x99FFADE   -23LUFS
0x99FFC00  pc_loudness_dy_twl           ←→  po: "抖音 -12LUFS"
0x99FFC7E   -12LUFS
0x99FF738   %1LUFS                      ←→  po: "已统一至目标响度%1LUFS"
```

→ **结论（[观测]，非推断）**：剪映「响度统一」的四个内置目标 = **-23 / -12 / -12 / -14 LUFS**
（默认 / 抖音 / TikTok / YouTube），
**所以 §7.2 之前写的"配对是推断"已作废，现在是双向验证过的观测事实。**
且有一条**行为规则**可照抄：`pc_loudness_low_unavailable` —— 响度**过低**的片段**拒绝处理**，
说明它只做"降"或小幅"升"，不是无脑拉平（避免把静音放大成噪声）。

**给复刻的可用锚点**：`-23 LUFS` 是广播级（EBU R128 标准值），`-12 LUFS` 是短视频平台级，
`-14 LUFS` 是流媒体级（YouTube/Spotify）。你面向 **Android TV 屏保长片 → 取 -14 ~ -16 LUFS**，
`true_peak_ceiling` 取 **-1.0 dBTP**（后者是工程判断 [推断]，剪映未给出数值）。

### 7.3 「音频均衡」的真身：MaterialAudioBalance [观测]

`videoeditor.dll` `0x30CC3D0` 段：

```
...\lyra\generated\draft\material_audio_balance.cpp
enable_balance        average_loudness        target_loudness
MaterialAudioBalance
```

配合 §7.1 的 JSON 声明（`average_loudness`、`target_loudness` 都是 `double`，挂在 `item.` 下），
以及 po 的"多选片段统一响度，快速实现响度均衡"（`pc_changelog_260`）：

→ **[观测+推断]** "响度均衡"= **逐片段测 `average_loudness`，再各自增益到统一 `target_loudness`**。
这是**静态逐段增益归一化**，不是压缩器、不是动态 EQ。**这正是本项目的"混音"该做的事**：
对每个片段算积分响度 → 求增益 → 应用，比压限器简单且可预测。

### 7.4 音频客观指标参数（audio_metrics 引擎）[观测]

`audioeffect.dll` `0xAC6xxx` 段（`sami_engine\src\models\audio_metrics.cpp`）：

| 偏移 | 字段 |
|---|---|
| `0xAC6Fxx`（同段） | `cutoff_power_threshold`、`phase_block_size`、`rms_block_size`、`clipping_block_size`、`loudness_blk_size`、`online` |
| 指标名（同段） | `integrated_loudness`、`pure_silence_lt_integrated_loudness`、`silence_rms_stats`、`rms_downmix_diff_low` |
| 声道/频谱 | `left`/`right`、`f_centroid_left`、`f_centroid_right`、`spkr_gain_100hz`、`spkr_gain_150hz`、`spkr_gain_200hz` |
| 动态/峰值 | `max_mom_loud`（momentary）、`max_short_term_loud`（short-term）、`delta_loudness`、`lra_start`、`lra_end`、`dynamic_range_left`、`dynamic_range_right` |
| 一致性 | `has_phase_issue`、`rms_before_downmix`、`rms_after_downmix`、`std_left`、`std_right` |
| 版本 | `1.4.2`（约 `0xAC664C`） |

→ **[观测]** 剪映的音频质检口径 = **EBU R128 全家桶**：integrated / short-term / momentary / LRA +
phase(相位) + clipping(削波) + 下混前后 RMS + 频谱质心 + 三段扬声器增益。
**复刻时直接用 ffmpeg 的 `ebur128` 就能拿到 integrated/LRA/true peak，其余指标用 `astats` 近似。**

### 7.5 压缩器 / 限幅器参数面 [观测]

`audioeffect.dll` `0xA71AA8` 起的属性名表（属于 SAMICoreEffect 的 setProperty 键）：

```
target_level  gain_db  enable_limiter  target_lufs  source_lufs  source_peak
content_duration  fade_in_duration  fade_out_duration  curve_fadein  curve_fadeout
major  seek_position  pre_gain  threshold  knee  attack  release  pre_delay
release_zone_1  release_zone_2  release_zone_3  release_…
```

→ **[观测]** 引擎内部**有**完整压缩器（threshold/knee/attack/release + 多段 release + pre_gain + limiter），
**但产品层没有暴露**（po 无"压缩/闪避"条目，§9）。`release_zone_1..3` 是多段释放包络，属高级设计。
另有 `sf_compressor_process_stereo_sidechain`（`0xCB48FA` 附近，mammon 音频库）——
**sidechain 能力存在但无 UI**，这就是"闪避"若要做得像专业软件、可以自己实现的现成模型。

### 7.6 「一键统一音量」的产品语义 [观测，来自 po]

| msgid | msgstr |
|---|---|
| `pc_recommend_volume` | 快速统一视频音量 |
| `pc_recommend_volume_normalize_loudness` | 响度统一 |
| `pc_recommend_volume_reduce_noise` | 降噪 |
| `pc_recommend_volume_consistent` | 全局音频响度更一致 |
| `pc_recommend_volume_detected` | 已分析完成：音频响度和动态起伏，音量过高或过低等问题。 |
| `pc_recommend_volume_detecting` | 正在分析音频响度和动态起伏，检测音量过高或过低的片段… |
| `pc_recommend_undo_volume_info` | 取消后全局应用的响度统一和降噪将取消。 |

→ **[观测]** 一个按钮 = **响度统一 + 降噪** 两个动作，且是**全局**作用（不是逐片段手动）。
→ **[观测]** 检测口径含"动态起伏"（= LRA/dynamic range）与"音量过高或过低"（= 积分响度偏离），
与 §7.4 的指标表完全对应。

---

## 8. 淡入淡出 / 转场 / 配乐拼接

### 8.1 音频淡入淡出的参数 [观测]

- 引擎侧：`fade_in_duration`、`fade_out_duration`、`curve_fadein`、`curve_fadeout`（§7.5 同一张表）
  → **淡入淡出有曲线参数**（[推断] 线性/指数/对数等），不是只有时长。
- 片段侧：`need_crossfade_in`、`need_crossfade_out`、`has_left_source_neighbour`、
  `has_right_source_neighbour`（`videoeditor.dll` `0x30E90B5` 段）
  → **是否淡化取决于"有没有相邻片段"**，这是自动判定，不是用户逐段设。
- po：`fade_in`/`fade_out`/`fade_in_duration`/`fade_out_duration`（淡入/淡出/淡入时长/淡出时长），
  `pc_new_audio_fade_in`/`pc_new_audio_fade_out`（音频专用）。
- po 行为规则（**很重要**）：
  `pc_copy_short_duration_effect` = **"当前片段时长过短，淡入/淡出时长将缩短以适应片段时长"**
  → 复刻时必须做 `fade = min(fade_requested, clip_duration/2)` 这样的钳制，否则短片段会破音/静音。

### 8.2 默认时长是 AB 灰配置，**不在本地** [观测]

`VECreator.dll` `0x9AB1710` 段：

```
feature_gray_config.crossfade
feature_gray_config.audio_fadeinout_default_duration
feature_gray_config.crossfade_duration
ve_ab_conf.ini
LvSceneCoreUtils::initVEAbConfig
```

实测 `C:\Users\14872\AppData\Local\JianyingPro\User Data\Config\ve_ab_conf.ini`（3957 B，117 行）**不含**这三个键
（该文件全是渲染/解码开关，如 `ve_enable_algorithm_cache=true`、`veabtest_fade…` 无）。
→ **[观测]** 淡入淡出默认时长与转场默认时长是**服务端下发的 AB 配置**；
**[未知]** 具体秒数（本地无缓存命中）。**不要臆造 0.3/0.5 s 这类"剪映默认值"**。

### 8.3 配乐拼接的 JSON schema（`splicing_info`）[观测]

`audioeffect.dll` `0xAA9700` 段（`deSerilizeSpliceInfo` / `workerThreadGenSpliceMode`）：

| 偏移 | 字段 | 含义（[推断]） |
|---|---|---|
| `0xAA9958` | `clip_begin_sec` | 每个片段的入点（秒） |
| `0xAA9968` | `clip_end_sec` | 出点（秒） |
| `0xAA9978` | `loop_order` | 片段播放顺序（**允许重复**，用于把短 BGM 铺满长片；为空则报 `loop_order is empty`） |
| `0xAA9988` | `valid_crossfade_loops` | 哪些 loop 接缝允许交叉淡化 |
| `0xAA99A0` | `output_duration_sec` | 目标总时长 |
| `0xAA99B8` | `beat_times` | **拍点时间戳数组（输入）** |
| `0xAA99C8` | `fallback` | 降级模式（日志 `fallback mode: %d`） |
| `0xAA99D8` | `cross_fading_frame_len` | **交叉淡化长度（以"帧"为单位！不是秒）** |
| `0xAA99F0` | `output_downbeat_times` | 输出：重拍时间戳 |
| `0xAA9A08` | `output_beat_info` | 输出：拍点信息 |
| `0xAA9A1C` | `time` | 通用时间字段 |
| `0xAA9A28` | `workerThreadGenSpliceMode` | 后台线程生成拼接 |

配套错误串：`splicing_info.loop_order is empty, process failed.`、
`start_sec_ or end_sec_ is invalid: start_sec_ %f, end_sec_ %f, inTotalSec %f`、
`target_sec_ is invalid`、`fallback mode: %d`。

→ **[观测]** 这就是用户想要的"拼接头 + 配乐"能力的**完整输入契约**：
给 `[clip_begin, clip_end)` 列表 + `loop_order`（可重复）+ `beat_times` + `cross_fading_frame_len` + 目标时长，
引擎输出一条**按拍点对齐、接缝交叉淡化**的音轨。
→ **[观测]** 淡化长度用**帧数**（`cross_fading_frame_len`），意味着它绑定采样率/帧率换算，
复刻时要注意单位换算（帧数 ÷ fps 或 ÷ (sample_rate/frame_size)）。

同一引擎还有 `clip_begin_sec or end_sec is invalid` ↔ `audio sdk use inTotalSec (%f) as the end_sec_`
（`0xAA9700` 段首）——说明**末尾时长以实际解码总长为准**，与 AGENTS.md §4.3 的"别信退出码、要验时长"同理。

---

## 9. 明确的负向结论（同样重要）

| 项 | 结论 | 证据 |
|---|---|---|
| **闪避 / ducking** | **产品层没有** | po 18211 条中 `闪避|duck|避让|压低` 命中 **0**；`audioeffect.dll` 全文 `ducking` 命中 **0**（只有底层库的 `sf_compressor_process_stereo_sidechain` 侧链压缩函数） |
| **EQ / 均衡器** | **产品层没有** | po 中 `均衡|equalizer|EQ` 5 条全是"画面均衡"/"排布均衡"/"响度均衡"文案，无 EQ 参数 |
| **拍点密度 level 0~4** | **无此枚举** | 全安装目录 `beat_density`/`beat_level`/`beat_point` 命中 0；只有 `level`/`level_count` 参数名 |
| **镜头检测算法权重** | **不在安装包** | `jy_compressShotDetect*` 在 4 个 DLL 中命中 0；`AlgorithmCache` 只有 1.5 KB face 缓存 |
| **模型内参数默认值** | **不可得** | 见 §2.4，加密 + 固定 IV，无密钥 |

---

## 10. 给「Node + ffmpeg 自研」的落地映射 [推断 / 设计建议]

（本节全部为工程建议，非剪映实测，明确标注。）

| 剪映能力 | 可观测到的参数锚点 | ffmpeg / Node 侧建议 |
|---|---|---|
| 自动踩点 | `fps`、`beats_per_bar`、`min_bpm`、`max_bpm`、`dbn_chunk_size`、`feature_version` | 用 **madmom DBNBeatTracker** 同构：onset 强度包络 → DBN 解码 → 拍点 + downbeat。离线一次性算，缓存成 JSON（结构与 `beats_json` 对齐：`{time, beat_index, is_downbeat}`） |
| BPM | `Softmax` 分类 + `use_log` | 用 `aubio` 或自研 tempogram 峰值；分类优于回归（与剪映同构） |
| 踩点密度 | `level` / `level_count`（语义未知） | 用「最小间隔 + 是否取重拍」两旋钮（§4.4 表），**不要**假设剪映的 0~4 |
| 镜头检测 | 96×96、window=7、feat=128、thr=0.35 | 复刻口径：缩到 96×96 → 每帧 128 维特征（可先用 HSV 直方图/CLIP）→ 相邻 7 帧窗口算距离 → 映射到 [0,1] → `>0.35` 判切点。**先跑 0.35 当基线再标定** |
| 响度统一 | `[-70,0] LUFS`、`ebur128`、`average_loudness`/`target_loudness` | `ffmpeg -af ebur128` 测每段 integrated → 算增益 → `volume=<g>dB`；目标 `-14~-16 LUFS`（TV 屏保），`true_peak_ceiling=-1 dBTP` 用 `alimiter` 兜 |
| 降噪 | 44.1k U-Net（`unet_denoise_44k_music_model`）、`realtime_denoise` 字段 | `ffmpeg -af arnndn`（RNNoise，安装包也带 `rnnoise` 资源目录）或 `afftdn` |
| 淡入淡出 | `fade_in_duration`/`curve_fadein`、`need_crossfade_in/out`、时长自动钳制 | `afade=t=in:st=0:d=<min(dur,..)>`；**必须钳制 `d ≤ 片段时长`**，否则短片段静音 |
| 拼接 + 配乐 | `clip_begin_sec`/`clip_end_sec`/`loop_order`/`beat_times`/`cross_fading_frame_len`/`valid_crossfade_loops` | 用 `atrim` 切段 → `aloop`/`loop_order` 铺满 → 每个接缝 `acrossfade=d=<帧转秒>` → 按 `beat_times` 对齐段落起点 |
| 闪避 | （剪映无） | 自研：`sidechaincompress` + `volume` 包络；或按字幕/VAD 时间轴做 `volume=enable='between(t,..)'` 式自动降低 BGM |

---

## 11. 复现命令（可直接粘贴，全部只读）

> 全部在 PowerShell 5.1 下实测通过。把 `$Root` 换成你的安装路径。

```powershell
$Root = 'D:\JianyingPro\11.6.0.14552'
$enc  = [System.Text.Encoding]::GetEncoding(28591)   # Latin1，字节保真
```

### 11.1 看 SAMI 头并验证 `28 + roundup16(len)`

```powershell
$files = @(
 'models\audiomodel\aed40_10m.model',
 'audiosami\time_align_time_domain_v1.0.model',
 'audiosami\time_align_freq_domain_v2.0.model',
 'audiosami\unet_denoise_44k_music_model_v1.0.model',
 'audio_metrics\audio_metrics_v1.4.model'
)
foreach ($f in $files) {
  $b = [IO.File]::ReadAllBytes((Join-Path $Root $f))
  $len = [BitConverter]::ToUInt32($b,20)
  $pad = [Math]::Ceiling($len/16)*16
  "{0}: size={1} u32@0x14={2} roundup16={3} 28+pad={4} match={5}" -f `
    $f,$b.Length,$len,$pad,(28+$pad),(($b.Length) -eq (28+$pad))
}
```

### 11.2 解析三块 TLV 并验证首尾相接

```powershell
foreach ($f in @(
 'models\audiomodel\bt_espresso_mobile_offline_v1.4.model',
 'models\audiomodel\bt_streaming_espresso_v1.2.model',
 'models\audiomodel\music2vibes\music2vibes_video_mobile_v1.0.model',
 'models\audiomodel\music2vibes\music2vibes_match_mobile_v1.0.model')) {
  $b=[IO.File]::ReadAllBytes((Join-Path $Root $f)); $off=0; $i=0; $out=@()
  while ($off -lt $b.Length -and $i -lt 8) {
    $len=[BitConverter]::ToUInt32($b,$off); $out += "$len($($len%16))"; $off += 4+$len; $i++
  }
  "{0}: size={1} chunks=[{2}] endedExact={3}" -f $f,$b.Length,($out -join ','),($off -eq $b.Length)
}
```

### 11.3 熵 / deflate 失败 / 共享 16 字节前缀

```powershell
function Ent($bytes){$fq=New-Object int[] 256;foreach($x in $bytes){$fq[$x]++};$n=$bytes.Length;$e=0.0
  foreach($f in $fq){if($f -gt 0){$p=$f/$n;$e-=$p*[Math]::Log($p,2)}};[Math]::Round($e,4)}

# 前缀对比（三个不同大小的文件共用同一 16B 前缀）
foreach ($f in @('models\audiomodel\aed40_10m.model',
                 'audiosami\unet_denoise_44k_music_model_v1.0.model',
                 'audiosami\time_align_time_domain_v1.0.model')) {
  $b=[IO.File]::ReadAllBytes((Join-Path $Root $f))
  "$f -> " + (($b[28..43] | % { $_.ToString('x2') }) -join ' ')
}

# deflate 必失败 + 熵
$b=[IO.File]::ReadAllBytes((Join-Path $Root 'models\audiomodel\aed40_10m.model'))
$seg=$b[28..(28+9779936-1)]
"entropy(aed40 payload) = $(Ent $seg)"
try { $ms=New-Object IO.MemoryStream(,$seg)
      $ds=New-Object IO.Compression.DeflateStream($ms,[IO.Compression.CompressionMode]::Decompress)
      $o=New-Object IO.MemoryStream; $ds.CopyTo($o); "DEFLATE OK $($o.Length)" }
catch { "DEFLATE FAIL: $($_.Exception.Message)" }
```

### 11.4 读镜头检测配置（含行号）

```powershell
$f = Join-Path $Root 'Resources\SceneEditDetection\config.json'
$i=0; Get-Content $f -Encoding UTF8 | % { $i++; if ($_ -match 'width|height|sliding_window|img_feat_dims|threshold|model_name|"mode"') { "{0,3}: {1}" -f $i,$_.Trim() } }
Get-Content (Join-Path $Root 'Resources\SceneEditDetection\config_prev.json') -Encoding UTF8
```

### 11.5 DLL 关键字扫描（可复现 §4/§6/§7 的所有命中偏移）

```powershell
function ScanDll($path,$kws,$maxPerKw,$chunkSize){
  $fs=[IO.File]::OpenRead($path);$buf=New-Object byte[] $chunkSize
  $c=@{};$s=@{}; foreach($k in $kws){$c[$k]=0;$s[$k]=New-Object Collections.Generic.List[object]}
  $base=0
  while(($read=$fs.Read($buf,0,$chunkSize)) -gt 0){
    $txt=$enc.GetString($buf,0,$read)
    foreach($k in $kws){
      $idx=0
      while(($idx=$txt.IndexOf($k,$idx,[StringComparison]::OrdinalIgnoreCase)) -ge 0){
        $c[$k]++
        if($s[$k].Count -lt $maxPerKw){
          $st=[Math]::Max(0,$idx-70)
          $s[$k].Add(("0x{0:X}: {1}" -f ($base+$idx), ($txt.Substring($st,[Math]::Min(200,$txt.Length-$st)) -replace '[^\x20-\x7E]','.')))
        }
        $idx+=$k.Length
      }
    }
    $base+=$read
  }
  $fs.Close(); foreach($k in $kws){ if($c[$k]){ "--- [$k] hits=$($c[$k])"; $s[$k] } }
}

ScanDll (Join-Path $Root 'audioeffect.dll') @('beat_tracking','min_bpm','max_bpm','beats_per_bar','dbn_chunk_size','onset_detection_sparse','SAMI_ENCRYPTED_RESOURCE','target_lufs') 4 (32MB)
ScanDll (Join-Path $Root 'videoeditor.dll') @('music_beats','capcut_local_ai_beat','local_model_path','target_loudness','ebur128','material_audio_balance','need_crossfade') 4 (32MB)
ScanDll (Join-Path $Root 'VECreator.dll')   @('CutPointDetection','feature_gray_config','pc_loudness','LUFS') 4 (64MB)
ScanDll (Join-Path $Root 'cccreator.dll')   @('setMusicBeatStep','setMusicBeatType','source_lufs') 3 (64MB)
```

### 11.6 打印某偏移附近的可读字符串（本文所有 region dump 都用它）

```powershell
function Runs($path,$off,$len,$minRun){
  $b=[IO.File]::ReadAllBytes($path); $end=[Math]::Min($off+$len,$b.Length); $st=-1
  for($i=$off;$i -le $end;$i++){
    $ch = if($i -lt $end){$b[$i]}else{0}
    if($ch -ge 32 -and $ch -le 126){ if($st -lt 0){$st=$i} }
    else { if($st -ge 0){ $l=$i-$st
        if($l -ge $minRun){ "{0} (0x{0:X}) ({1,3}) {2}" -f $st,$l,(-join($b[$st..($i-1)]|%{[char]$_})) }
        $st=-1 } }
  }
}
Runs (Join-Path $Root 'videoeditor.dll') 0x32B5100 0x500 4     # music_beats 全部参数
Runs (Join-Path $Root 'audioeffect.dll') 0xAC5DE0 0x300 4      # fps/beats_per_bar/min_bpm/max_bpm...
Runs (Join-Path $Root 'VECreator.dll')   0x99FF9C0 0x400 3     # -23LUFS / -12LUFS
Runs (Join-Path $Root 'audioeffect.dll') 0xAA9700 0x400 4      # splic(c)ing_info schema
```

### 11.7 抽 po 条目

```powershell
$po = Join-Path $Root 'Resources\po\zh-Hans.po'
$txt = [IO.File]::ReadAllText($po,[Text.Encoding]::UTF8)
$entries = foreach ($blk in ($txt -split "`r?`n`r?`n")) {
  $id=@();$str=@();$cur=$null
  foreach ($l in ($blk -split "`r?`n")) {
    if ($l -match '^msgid\s+"(.*)"$')      { $cur='id';  $id  += $Matches[1] }
    elseif ($l -match '^msgstr\s+"(.*)"$') { $cur='str'; $str += $Matches[1] }
    elseif ($l -match '^"(.*)"$')          { if($cur -eq 'id'){$id+=$Matches[1]}elseif($cur -eq 'str'){$str+=$Matches[1]} }
  }
  if ($id.Count) { [pscustomobject]@{msgid=($id -join ''); msgstr=($str -join '')} }
}
"entries=$($entries.Count)"
$pat = '踩点|节拍|拍点|卡点|节拍频率|音量|响度|响度统一|降噪|淡入|淡出|转场|duck|闪避'
$entries | ? { $_.msgid -match $pat -or $_.msgstr -match $pat } | Select-Object -First 40 | Format-List
```

---

## 12. 未解清单（下一轮该做什么）

| # | 未解项 | 建议下一步 | 预期成本 |
|---|---|---|---|
| U1 | `level` 的取值域与每档行为 | 在**用户态**抓一次「自动踩点」的网络请求（本地代理/hosts 到本地 mock），看 `music_beats begin` 的实际 JSON；或用 `lyra_music_beats_*.json` 临时文件残留 | 中（需联网/交互，本任务禁止） |
| U2 | 云端拍点响应结构（`beats_json` 字段） | 同上；或找 `beats_json` 的解析代码（需反编译 videoeditor.dll 的 `CommonMediaRunner`） | 中 |
| U3 | 模型解密密钥 | `decryptFromMemory` / `SAMI_ENCRYPTED_RESOURCE` 的调用点反编译；密钥可能在 `metasecml.dll` 或服务端下发 | 高（且涉嫌绕过保护，需法务确认） |
| U4 | 淡入淡出/转场默认秒数 | 云端 AB 配置下发（抓包），或产品截图量测 | 低（截图直接量） |
| U5 | 镜头检测是否真用 0.35 判决 | 反编译 `compress_shot_detect` 插件（本机无该插件，须先让剪映跑一次"智能镜头分割"以下载算法包到 `User Data`） | 中 |
| U6 | `f0_min` 默认值（`650` 是 f0_max 还是 f0_min） | 反编译 `f0_detection` 参数表初始化处，确认三元组顺序 | 低-中 |

> **合规提示**：U3 属破解加密资源，涉及规避技术保护措施，**不建议**在商业项目中推进；
> U1/U2/U4 只需"看自己机器上发出去的请求"，风险低得多，且足够支撑复刻。

---

## 附录 A：本文所有精确偏移速查

| 文件 | 偏移 | 内容 |
|---|---|---|
| `audioeffect.dll` | `0xA841C4` | 能力名表（onset / beat-tracking / global-loudness …） |
| `audioeffect.dll` | `0xA88034` / `0xA8803C` | `f0_min` / `f0_max` |
| `audioeffect.dll` | `0xA88088` | `650`（f0 默认值） |
| `audioeffect.dll` | `0xA880E8` / `0xA88100` / `0xA88150` | `onset_detection_sparse` / `interval` / `200` |
| `audioeffect.dll` | `0xA88290` | `…\onset_detection\OnsetDetection.cc` |
| `audioeffect.dll` | `0xAA9958` | `clip_begin_sec`（splicing_info 段首） |
| `audioeffect.dll` | `0xAA99D8` | `cross_fading_frame_len` |
| `audioeffect.dll` | `0xA71AA8` | `target_level`（compress/fade 参数段首） |
| `audioeffect.dll` | `0xA71B18` | `fade_in_duration` |
| `audioeffect.dll` | `0xABE040` | `SAMI_ENGINE_XX_MODEL` |
| `audioeffect.dll` | `0xABE080` | `SAMI_ENCRYPTED_RESOURCE` |
| `audioeffect.dll` | `0xABE1C0` | `…only 'espresso(4)' and 'none(-1)'…` |
| `audioeffect.dll` | `0xAC5E10` | `fps`（beat_tracking 参数段首） |
| `audioeffect.dll` | `0xAC5E30` / `0xAC5E38` | `min_bpm` / `max_bpm` |
| `audioeffect.dll` | `0xAC5F30` / `0xAC5F40` | `input_1:0` / `dense_2/Relu:0` |
| `audioeffect.dll` | `0xAC6DC0` | `…\models\bpm_model.cpp` |
| `videoeditor.dll` | `0x32B51C0` | `music_beats begin: input='{}' mode={} level={} level_count={} …` |
| `videoeditor.dll` | `0x32B53D0` / `0x32B53E8` | `local_model_path` / `capcut_local_ai_beat` |
| `videoeditor.dll` | `0x32B54A8` | `music_beats done: beats={} level_count={}` |
| `videoeditor.dll` | `0x3318EB6` | `…[-70, 0] LUFS` |
| `videoeditor.dll` | `0x33195CE` | `'target_loudness' must be in [-70, 0] LUFS` |
| `videoeditor.dll` | `0x30CC3D0` | `material_audio_balance.cpp` / `average_loudness` / `target_loudness` |
| `VECreator.dll` | `0x9EC72F8` | `../SceneEditDetection/config.json` |
| `VECreator.dll` | `0x9EC72D8` / `0x9EC7380` | `CutPointDetection failed` / `finished` |
| `VECreator.dll` | `0x9AB1730` / `0x9AB1768` | `audio_fadeinout_default_duration` / `crossfade_duration` |
| `VECreator.dll` | `0x99FFADE` / `0x99FFC7E` | ` -23LUFS` / ` -12LUFS` |
| `cccreator.dll` | `0x424F4E3`（窗口） | `setMusicBeatType` / `setMusicBeatStep` / `setMusicBeatRadius` |

## 附录 A2：po 功能键速查（按主题，供产品文本对齐用）

> 全部为 `Resources\po\zh-Hans.po` 实测命中；`踩点/节拍` 全表 36 条、`转场` 74 条、`音量` 30 条、
> `淡入淡出` 18 条、`降噪` 28 条、`响度` 15 条、`变速` 52 条。下面只列与音频/配乐/拼接直接相关的。

**踩点 / 节拍（36 条中最相关）**

| msgid | msgstr |
|---|---|
| `auto_beat` / `auto_click` | 自动踩点 |
| `pc_auto_mark_beats` / `pc_menu_auto_mark_beats` | 智能打点 |
| `beat_metre_1` / `step_on_the_beat_i` | 踩节拍I |
| `beat_metre_2` / `step_on_the_beat_ii` | 踩节拍II |
| `beat_sync_videos` / `pc_beat_sync_videos` | 节拍同步视频 / 音乐视频 |
| `card_point_pc` / `pc_card_point_must` | 卡点 / 卡点必备 |
| `pc_manual_stepping` | 手动踩点 |
| `add_beat` / `pc_add_beat` | 添加点 |
| `pc_empty_spots` / `pc_remove_spots` | 清空踩点 / 删除踩点 |
| `pc_timeline_mark_beat_add` | 添加音乐节拍标记 |
| `pc_timeline_mark_beat_successful` / `_failed` | 适配成功 / 适配失败 |
| `pc_timeline_mark_material_auto` | 拖拽到此处释放，媒体将自动适配节拍 |
| `velocity_speed_beat_frequency` | 节拍频率（变速卡点档位） |
| `audio_has_no_taps_generate` | 该音频无踩点可生成 |
| `tap_failed_please_try_again` | 踩点失败，请重试 |
| `needed_music_track_add` | 变速卡点需要添加音乐，请先添加音乐轨道 |
| `pc_style_both_unavailable` | 变速功能和变速卡点的玩法不能同时使用 |
| `pc_lyrics_matching_rhythm` | 正在匹配歌曲节奏… |
| `pc_cloud_continue_rhythm_audio` | 点击「继续」开始踩点处理，但由于当前音频片段还未下载完成，预计耗时更久。 |
| `changelog_150` | …**1.本地音乐支持智能踩点**… ← 与本项目"自有 BGM"直接对口 |

**音量 / 响度**：见 §7.2（15 条 `pc_loudness*` 全表）与 §7.6（7 条 `pc_recommend_volume*`）。
另：`pc_track_volume` 轨道音量、`pc_template_music_volume` 音乐音量、`pc_template_volume` 模板音量、
`input_volume` 输入音量。

**淡入淡出（18 条中的关键）**

| msgid | msgstr |
|---|---|
| `fade_in` / `fade_out` | 淡入 / 淡出 |
| `fade_in_duration` / `fade_out_duration` | 淡入时长 / 淡出时长 |
| `pc_new_audio_fade_in` / `pc_new_audio_fade_out` | 淡入时长 / 淡出时长（音频专用） |
| `pc_copy_short_duration_effect` | **当前片段时长过短，淡入/淡出时长将缩短以适应片段时长** ← 钳制规则 |

**转场（74 条中的关键）**

| msgid | msgstr |
|---|---|
| `pc_feature_transitions` / `pc_feature_transitions_content` | 转场效果 / 片段融合衔接更自然，画面切换过渡更精彩！ |
| `pc_generate_transition` / `_apply_all_button_generate` | 生成转场 / 生成转场视频 |
| `pc_auto_packaging_auto_gen_chapter_transfer` | 自动生成章节转场 |
| `no_sequence_current_position_transition` | 当前位置无连续片段，无法添加转场 |
| `not_enough_length_outside_edge_duplicate_frames` | **片段边缘之外长度不足，将添加重复帧创建转场，来保证不改变片段时长** ← 边缘不足时的补偿策略 |
| `add_repeating_frames_to_create_transitions` | 添加重复帧创建转场 |
| `changelog_200`（第 5 条） | 修复叠加转场会改变视频片段时长问题 |

**降噪 / 变速**

| msgid | msgstr |
|---|---|
| `pc_new_audio_reduce_noise` / `audio_noise_reduction` | 音频降噪 |
| `pc_new_denoise` | 画面降噪 |
| `pc_new_denoise_client` / `_remind` | 在当前设备处理，速度更快 / 本地 |
| `pc_new_denoise_cloud` / `_remind` | 上传云端处理，效果更优 / 云端 |
| `pc_m10n_paywall_reduce_noise_title` | 开通会员即刻享用声音降噪功能。（**会员功能**） |
| `conventional_shifting` / `curve_shifting` / `curve_speed` | 常规变速 / 曲线变速 / 曲线变速 |
| `pc_clip_too_short` | 片段过短，变速后最小时长为0.1s |

**重要负向**：`闪避|duck|避让|压低` 在 18211 条中命中 **0** —— 无闪避功能（§9）。

---

## 附录 B：本文用到但**没有**采信为"数值"的东西

- 任何"剪映默认淡入 0.5 s / 转场 1.0 s"之类的说法：本地无证据，已列入 U4。
- 任何"level 0~4 对应 x 秒"的说法：无证据，§4.4 已改成我方设计建议并标注。
- 模型内的超参（min_bpm/max_bpm/阈值）：加密不可得，§2.4 已判定。
- po 里出现的数字（如 `2.本地音乐支持智能踩点` 的 "2"）：那是文案序号，不是参数。
- `650` / `200` 两个裸数字：紧跟在参数描述之后，[推断] 是默认值；未 100% 确认三元组顺序（U6）。
  **但 §7.2 的 LUFS 值不同**——它们是 `msgstr` 里的自然语言，属 [观测]。
