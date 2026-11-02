# 图生视频（Image-to-Video）能力核查表

> 对象：工作区现有 5 个真实视频模型的 **image-to-video** 支持情况。
> 用途：为「提示词 → 分镜 → **图片（人工确认）** → 视频」新工作流提供事实依据。
> 版本：v1（2026-10-26）　编写：backend-dev　**本期只核查，未改任何代码。**
>
> 核查基线：`app/src/generators/dashscope.js:40-51` 的请求体只有 `input: { prompt }`，
> 没有任何图像入参 —— 5 个生成器当前**全部是文生视频**，这是核查起点，不是缺陷描述。

---

## 0. 结论速览

### 0.1 「是否支持图生视频」总表

| # | 模型 | 现有生成器 | 支持图生视频 | 核实状态 |
|---|---|---|---|---|
| 1 | Wan（阿里 DashScope） | `src/generators/dashscope.js` | **支持** | 已核实 |
| 2 | 可灵 Kling（快手） | `src/generators/kling.js` | **支持** | 已核实 |
| 3 | Seedance（字节 火山方舟） | `src/generators/seedance.js` | **支持** | 已核实 |
| 4 | Agnes（Pavo） | `src/generators/agnes.js` | **支持** | 已核实 |
| 5 | Wan 2.2（硅基流动） | `src/generators/siliconflow.js` | **支持** | 已核实 |
| — | mock | `src/generators/mock.js` | 不适用（合成图案） | 已核实 |

**汇总：支持 5 家 / 不支持 0 家 / 整体能力未核实 0 家。**

> 这个结论与预期不同，值得强调：**5 家全都支持图生视频，没有一家需要换供应商。**
> 真正的障碍不在「能不能图生视频」，而在**图片怎么送到对方服务器**（见 §7 风险 R1）
> 和**请求体字段各不相同**（见 §6 改造清单）。

### 0.2 细分项核实进度

「支持」只代表**接口存在且官方文档明确写了**。下表是每个细分项的核实状态，
**未核实的项一律不得当成已支持去写代码**（AGENTS.md §4.8）。

| 细分项 | dashscope | kling | seedance | agnes | siliconflow |
|---|---|---|---|---|---|
| 是否支持图生视频 | 已核实 | 已核实 | 已核实 | 已核实 | 已核实 |
| 图像传输字段名 | 部分核实 | 已核实 | 已核实 | 已核实 | 已核实 |
| 支持 base64 上传 | **未核实** | 已核实 | 已核实 | **未核实** | 已核实 |
| 图片格式要求 | **未核实** | 已核实 | **未核实** | 部分核实 | 已核实 |
| 图片分辨率要求 | **未核实** | 已核实 | **未核实** | **未核实** | 已核实 |
| 输入图片 URL 时效 | **未核实** | 部分核实 | **未核实** | 已核实 | **未核实** |
| 首帧 + 尾帧 | 已核实 | 已核实 | 已核实 | 已核实 | **已核实不支持** |
| 单次时长上限 | 已核实（30s） | 已核实（3–15s） | 部分核实 | 已核实（4–12s） | **未核实** |

---

## 1. Wan（阿里云百炼 / DashScope）

**现有代码**：`src/generators/dashscope.js`，`modelId` 默认 `wan3.0-video`，
端点 `/services/aigc/video-generation/video-synthesis`（`dashscope.js:53`）。

| 项 | 结论 | 核实状态 | 来源 |
|---|---|---|---|
| 是否支持图生视频 | **支持**。万相 3.0 官方原文：「全能参考视频生成模型（All-in-One），统一支持 文生视频、**图生视频（首帧/首尾帧）**和参考生视频等多种用法。最长可生成30秒视频」 | 已核实 | <https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference> |
| 图像怎么传 | 存在**三种官方写法**，端点与字段都不同，详见下方 | 部分核实 | 见下 |
| 图片格式/分辨率 | **未核实** —— i2v 参考页的参数表因页面体积过大未能完整抓取；可见示例中图片是公网 URL（`.webp` / `.jpg`），但文档未在可获取片段里给出格式白名单与尺寸上下限 | 未核实 | — |
| 输入图片 URL 时效 | **未核实**（官方对「输入图 URL 需保持多久可访问」未在可获取片段中标注） | 未核实 | — |
| 输出视频 URL 时效 | **24 小时**（原文「video_url 有效期24小时，请及时下载视频」）。注：该标注出现在文生视频 API 参考页，图生视频页未单独重复此句 | 已核实 | <https://help.aliyun.com/zh/model-studio/text-to-video-api-reference> |
| 首帧 + 尾帧 | **支持**。价目表存在「万相-图生视频-基于首尾帧」分类（`wan2.2-kf2v-flash`），且官方给出 `first_frame_url` + `last_frame_url` 成对示例 | 已核实 | <https://help.aliyun.com/zh/model-studio/model-pricing>、<https://www.alibabacloud.com/help/zh/model-studio/wan-video-generation-finetune-guide> |
| 单次时长上限 | **30 秒**（万相 3.0）；`wan2.x` 系列为多档秒数（具体枚举未核实） | 已核实（30s 上限） | 同 wan3 文档 |

### 1.1 三种官方图像传法（**这是最容易写错的地方**）

官方微调文档在同一页给了三份 `curl`，字段与端点各不相同：

| # | 端点 | 图像字段 | 形态 |
|---|---|---|---|
| A | `/services/aigc/video-generation/video-synthesis` | `input.media: [{ "type": "first_frame", "url": "<公网URL>" }]` | 数组 + 类型标记 |
| B | `/services/aigc/video-generation/video-synthesis` | `input.img_url: "<公网URL>"` | 单字段（早期写法） |
| C | `/services/aigc/image2video/video-synthesis` | `input.first_frame_url` + `input.last_frame_url` | 首尾帧专用端点 |

来源：<https://www.alibabacloud.com/help/zh/model-studio/wan-video-generation-finetune-guide>（官方，2026-10-26 抓取）。

**未核实点（必须实测或补看参数表后才能定）**：
`wan3.0-video` 这个 model id 走的是 A 还是 B？
三种写法分属不同代模型，**不能互推**。
在没核实前，`dashscope.js` 里**不要**猜字段名写成 `input.image_url` 之类 —— 那是不存在的字段。

### 1.2 对现有代码的影响

`dashscope.js:40-51` 只需要在 `body.input` 里加图像字段（按核实结果选 A/B/C），
`parameters` 部分（resolution / ratio / duration / audio / prompt_extend）可原样保留。
**风险点**：`audio: false` 与 `prompt_extend: false` 是现有决策（`dashscope.js:47-49`），
图生视频时是否仍被支持，官方文档未覆盖 → 未核实。

---

## 2. 可灵 Kling（快手）

**现有代码**：`src/generators/kling.js`，走 v1 系 `POST /v1/videos/text2video`，
`model_name: 'kling-v3'`（`kling.js:20,72-87`）。

| 项 | 结论 | 核实状态 | 来源 |
|---|---|---|---|
| 是否支持图生视频 | **支持**，且**有新旧两套 API** | 已核实 | 见下 |
| 图像怎么传 | `image`（首帧）/ `image_tail`（尾帧）；**支持 base64 或 URL** | 已核实 | <https://kling.ai/document-api/api/video/2-6/image-to-video/legacy> |
| base64 细节 | **绝对不能带 `data:image/png;base64,` 前缀**，只传裸 base64 串。官方专门给了「正确/错误」对照示例 | 已核实 | 同上 |
| 图片格式 | `.jpg / .jpeg / .png` | 已核实 | 同上 |
| 图片大小/尺寸 | 单图 **≤10MB**，宽高**最小 300px**，宽高比需在 **1:2.5 ~ 2.5:1** 之间。（`image_tail` 官方只列了格式与 ≤10MB、最短边 300px，未重复比例限制） | 已核实 | 同上 |
| 输入图片 URL 时效 | 官方仅要求「确保可访问」；未给出有效时长 | 部分核实 | 同上 |
| 输出视频 URL 时效 | 查询接口注明「生成的图片/视频将在 **30 天**后清理，请及时保存」；单次 URL 的有效时长未标注 | 已核实（30 天清理）/ 未核实（单次时效） | 同上 |
| 首帧 + 尾帧 | **支持**。规则：`image` 与 `image_tail` **至少要给一个，不能都为空** | 已核实 | 同上 |
| 单次时长上限 | `duration` 枚举 `"3" ~ "15"`（字符串），默认 `"5"` | 已核实 | 同上 |

### 2.1 新旧两套 API（选错会白写一遍代码）

| | v1 系（与现有 `kling.js` 同族） | 3.0 新系 |
|---|---|---|
| 端点 | `POST /v1/videos/image2video` | `POST /image-to-video/kling-3.0`（另有 `-turbo`） |
| 请求体 | 扁平字段：`model_name` / `image` / `image_tail` / `prompt` / `duration` / `mode` / `sound` | `contents: [{type:'prompt'|'first_frame'|'last_frame', ...}]` + `settings` + `options` |
| 查询 | `GET /v1/videos/image2video/{task_id}` | 新系自有路径 |
| 官方文档 | <https://kling.ai/document-api/api/video/2-6/image-to-video/legacy> | <https://klingai.com/document-api/api/video/3-0-omni/image-to-video> |

**建议**：为降低改动面选 **v1 系**——它与现有 `kling.js` 的 JWT 鉴权、
`task_id` 解析、`task_status`（`submitted/processing/succeed/failed`）映射完全一致（`kling.js:102-138`），
只需换 URL 路径 + 加两个字段。走 3.0 新系则 `getStatus` 的响应解析要重写。

**未核实**：`kling-v3`（v1 系 `model_name` 枚举中确实存在）在新系里是否是 `kling-3.0`，
两者是否等价 → 未核实，不要假设。

---

## 3. Seedance（字节跳动 / 火山方舟）

**现有代码**：`src/generators/seedance.js`，走 `POST /contents/generations/tasks`，
`content: [{ type:'text', text: prompt }]`（`seedance.js:42-52`）。

| 项 | 结论 | 核实状态 | 来源 |
|---|---|---|---|
| 是否支持图生视频 | **支持**。官方能力列表：「支持【图生视频-首尾帧】【图生视频-首帧】【文生视频】」，且「全模态参考生视频为 3 种互斥场景，不可混用」 | 已核实 | <https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh> |
| 图像怎么传 | 在 `content` 数组里追加 `{ "type": "image_url", "image_url": { "url": "..." }, "role": "first_frame" }`。**`url` 支持三种来源：图片 URL / 图片 Base64 编码 / 素材 ID** | 已核实 | 同上 |
| role 规则 | 首帧：1 个 `image_url`，`role` 为 `first_frame` 或不填；首尾帧：必须 2 个且 `role` **必填**（`first_frame` / `last_frame`），两张图可以相同 | 已核实 | 同上 |
| 图片格式/分辨率 | **未核实**（该段落在抓取被截断的部分） | 未核实 | — |
| 输入图片 URL 时效 | **未核实** | 未核实 | — |
| 输出 video URL 时效 | **未核实** | 未核实 | — |
| 首帧 + 尾帧 | **支持** | 已核实 | 同上 |
| 单次时长上限 | 官方称 Seedance 2.5「支持 30 秒视频连贯直出」（属模型整体能力表述）；**图生视频单次 duration 的可用枚举未核实** | 部分核实 | 同上 |

**注意端点/域名差异**：官方端点写作 `https://ark.cn-beijing.volces.com/api/v3`，
而 `config.js:134` 的默认 `SEEDANCE_BASE_URL` 是 `https://www.seeddance.io/v1`（第三方中转形态），
`seedance.js:13` 的兜底又是 `https://ark.volcengine.com/api/v3`。
`seedance.js:28` 用 `includes('volcengine.com') || includes('ark.cn')` 判断走官方分支，
`ark.cn-beijing.volces.com` 能命中 `ark.cn` —— **判断逻辑没问题**，但三个默认值互不一致，
接 i2v 时应顺手收敛（属后续改造范围，本期不改）。

---

## 4. Agnes（Pavo）

**现有代码**：`src/generators/agnes.js`，`POST /v1/videos`，
请求体带 `mode: 'text'`（`agnes.js:43`）。

| 项 | 结论 | 核实状态 | 来源 |
|---|---|---|---|
| 是否支持图生视频 | **支持**。通过 `mode: 'keyframe'` 实现「首帧 / 尾帧 / 首尾帧」控制 | 已核实 | <https://wiki.agnes-ai.com/en/docs/agnes-video-25.md> |
| 图像怎么传 | `first_frame`（字符串 URL）/ `last_frame`（字符串 URL），二选一或都给；**必须公网可访问 URL** | 已核实 | 同上 |
| base64 | **官方文档未覆盖** —— 只给出 URL 形式，并明确要求「All media URLs must be publicly reachable」（禁需鉴权的、内网私网的、会在任务完成前过期的地址） | 未核实（无 base64 支持表述） | 同上 |
| 图片格式/分辨率 | **部分核实**：`reference` 模式限制为「每张 <15MB、单请求 <50MB、单边 256–5760px」；**`keyframe` 模式未单列图片规格** → keyframe 用图要求未核实 | 部分核实 | 同上 |
| 输入图片 URL 时效 | **必须在任务完成前保持可访问**（官方明示）；具体小时数未给 | 已核实 | 同上 |
| 首帧 + 尾帧 | **支持**，官方示例同时给 `first_frame` 与 `last_frame` | 已核实 | 同上 |
| 单次时长上限 | `seconds` 字符串 **"4"–"12"**，默认 "5" | 已核实 | 同上 |
| 其他约束 | `mode` 与媒体字段严格互斥：`text` 模式**不允许**带 `first_frame`/`last_frame`；`keyframe` 不允许带 `images`/`audios`/`videos`；反之亦然。传错返回 400 | 已核实 | 同上 |

**这是本次核查最有价值的一条**：现有 `agnes.js` 已经用对了端点和查询方式，
图生视频只差把 `mode` 从 `'text'` 改成 `'keyframe'` 并加两个 URL 字段。
但**前提是图片有公网地址**，而本工作区是本地服务（见 §7 R1）。

**另注**：`agnes.js:39-46` 目前无条件发送 `mode: 'text'`，若未来加了图却漏改 `mode`，
会被官方以 400 拒绝（不是静默忽略）—— 属于「错了会报错」的良性设计。

---

## 5. Wan 2.2（硅基流动 SiliconFlow）

**现有代码**：`src/generators/siliconflow.js`，`POST /v1/video/submit`，
`modelId` 默认 `Wan-AI/Wan2.2-T2V-A14B`（`siliconflow.js:13`）。

| 项 | 结论 | 核实状态 | 来源 |
|---|---|---|---|
| 是否支持图生视频 | **支持**。图生视频模型 `Wan-AI/Wan2.2-I2V-A14B`，须换 model 名 | 已核实 | <https://api-docs.siliconflow.cn/docs/api/video-submit-post>、<https://api-docs.siliconflow.cn/docs/userguide/capabilities/video> |
| 图像怎么传 | `image` 字段。取值形式：`"data:image/png;base64, XXX"` **或** `"img_url"`（图片 URL） | 已核实 | <https://api-docs.siliconflow.cn/docs/api/video-submit-post> |
| base64 前缀 | **必须带 `data:image/png;base64,` 前缀**（与可灵要求相反，这是最容易混掉的细节） | 已核实 | 同上 |
| 图片格式/分辨率 | `image_size` 为**必填**，枚举 `1280x720` / `720x1280` / `960x960`。官方另说明：实际分辨率按上传图宽高比自动匹配（16:9→1280×720、9:16→720×1280、1:1→960×960），建议用这三种比例出图 | 已核实 | 同上 + <https://api-docs.siliconflow.cn/docs/userguide/capabilities/video> |
| 输入图片 URL 时效 | **未核实** | 未核实 | — |
| 输出视频 URL 时效 | 两处口径不一致：提交接口说「生成结果有效期 **10 分钟**，请及时取回链接」，状态接口说「视频 URL 有效 **1 小时**」。**工程上按 10 分钟处理更安全** | 已核实（矛盾已记录） | 上两处 |
| 首帧 + 尾帧 | **不支持** —— 提交接口的请求体只有单个 `image`，无任何尾帧类字段 | 已核实（以字段清单为准） | <https://api-docs.siliconflow.cn/docs/api/video-submit-post> |
| 单次时长上限 | 提交接口**没有 duration 参数**（时长由模型决定）。现有代码注释写「Wan 2.2 默认 5 秒」（`siliconflow.js:15`），属代码内的经验值，**非官方文档结论** → 未核实 | 未核实 | 同上 |

---

## 6. 对现有代码的改造清单（**本期不执行，仅登记**）

| 生成器 | 需要改的位置 | 改什么 | 依据 |
|---|---|---|---|
| `dashscope.js:40-51` | `body.input` | 加图像字段，**具体字段名待核实**（A/B/C 三种写法之一） | §1.1 |
| `kling.js:72-87` | `fetch` 的 URL 与 body | URL 改 `/v1/videos/image2video`；body 加 `image` / `image_tail`；注意 base64 无 `data:` 前缀 | §2 |
| `seedance.js:42-52` | `body.content` | 追加 `{type:'image_url', image_url:{url}, role:'first_frame'}` | §3 |
| `agnes.js:39-46` | `body` | `mode` 改 `'keyframe'`，加 `first_frame` / `last_frame`；**图片必须是公网 URL** | §4 |
| `siliconflow.js:40-44` | `body` | model 换 `Wan-AI/Wan2.2-I2V-A14B`，加 `image`（带 `data:` 前缀）；`image_size` 仍按比例映射 | §5 |
| `generators/index.js:52-61` | `supportsImageInput` | 5 家的 `null` 可改为 `true`（并区分「支持首尾帧」能力位） | 本文全部结论 |
| `generators/base.js:18` | `generate(prompt, options)` | 约定 `options.firstFrameImage` / `options.lastFrameImage` 之类入参（**命名待产品/研发共同定**） | 推断 |

> `base.js` 的接口签名不含图像入参，加图必然要扩签名。建议用 `options` 扩展而非改位置参数，
> 这样现有 6 个调用点（`pipeline.js` 的 `_processSingleClip` → `generator.generate`）不必全改。
> **这是推断，不是已核实事实。**

---

## 7. 风险清单（按严重度排序）

### R1（最高）本地生成的图片没有公网 URL

5 家的图生视频都要求「图片可被厂商服务器访问」。而本项目的服务跑在用户桌面
（`http://localhost:3001`），新工作流产出的分镜图会落在 `app/clips/` 之类的**本地路径**，
厂商**看不到**。逐家现状：

| 厂商 | 能否绕开公网 URL | 依据 |
|---|---|---|
| kling | **能**，支持裸 base64 | 已核实 |
| siliconflow | **能**，支持 `data:image/...;base64,` | 已核实 |
| seedance | **能**，`url` 支持 Base64 编码 | 已核实 |
| agnes | **不能**，官方明确只要公网 URL | 已核实 |
| dashscope | **未核实**，可见示例全是公网 URL，无 base64 说明 | 未核实 |

结论：**至少要解决 1 条公网图片通道，否则 agnes 与 dashscope 无法进入新工作流。**
可选方向（均未实现，需产品/运维决策）：
1. 走项目已有的对象存储（`STORAGE_DRIVER` = `supabase` / `s3`，见 `src/storage/objectStore.js`）临时上传分镜图；
2. 内网穿透 / 临时公网映射（本机部署形态下不稳定，且涉及安全面）；
3. 只对支持 base64 的 3 家开放图生视频，另外 2 家维持文生视频（**功能分级**）。

### R2 图片 URL 时效与任务时长不匹配

审核门意味着「图生成 → 等人 → 再生成视频」中间可能隔几小时甚至几天。
若采用「先上传拿 URL，审核通过后再调用」的顺序，URL 很可能已过期。
**建议顺序：审核通过后再上传/签名，不要提前上传。** 属推断性建议。

### R3 dashscope 字段名未定

见 §1.1。若在核实前照着某个二手中文博客写 `input.image_url`，几乎肯定 400。
必须查官方参数表或做一次最小实测（单张图 + 1 个 5 秒任务）。

### R4 `supportsImageInput` 目前是 `null`

`generators/index.js:52-61` 与 `imageGen.js:80-87` 都注释了「`null` = 未核实，不得当成支持」。
本文给出了 5 家都支持的证据，但**代码里的 `null` 本期不要改**——改了就等于对外宣称可用，
而 R1 未解决时实际不可用（AGENTS.md §4.8）。

---

## 8. 仍未核实清单（需实测或补读官方参数表才能填）

| # | 待核实项 | 影响 | 建议核实方式 |
|---|---|---|---|
| 1 | `wan3.0-video` 图生视频用 `input.media[]` 还是 `input.img_url` | 写错即 400 | 读官方 i2v 参数表 / 单次最小实测 |
| 2 | dashscope 图生视频是否支持 base64 | 决定 R1 是否需要公网通道 | 同上 |
| 3 | dashscope i2v 图片格式与尺寸限制 | 出图规格 | 官方 i2v 参考页参数表 |
| 4 | seedance i2v 图片格式/分辨率要求 | 出图规格 | 官方文档对应段落 |
| 5 | seedance i2v 单次 duration 枚举 | 片段时长设计 | 官方文档 / 实测 |
| 6 | seedance 输入图 URL 与输出 video URL 时效 | 下载时机 | 官方文档 |
| 7 | agnes `keyframe` 模式图片规格（格式/尺寸/大小） | 出图规格 | 官方文档 keyframe 段 / 实测 |
| 8 | kling / siliconflow 输入图片 URL 的时效 | 上传时机 | 官方文档 / 实测 |
| 9 | siliconflow Wan2.2-I2V 实际输出时长 | 片段时长设计 | 实测一次任务 |
| 10 | 各厂商图生视频**计价**（按秒 or 按次）与文生视频是否同价 | 成本模型 | 各家价目表 |

> 上述 10 项都**不要用推测填**。任何一项进代码前，必须先落到「已核实」。

---

## 9. 与「先图后视频」工作流的衔接结论

1. **技术上可行**：5 家全部支持图生视频，其中 4 家支持首尾帧（siliconflow 除外）。
2. **`agnes` 是最容易接的一家**（现有代码只差 1 个 `mode` + 2 个字段），
   但**恰好是图片通道最受限的一家**（只要公网 URL）。
3. **`kling` / `siliconflow` 最容易在本地环境跑通**（支持 base64），可作为新工作流的
   第一个落地对象（推荐先拿这两家做端到端验证）。
4. **base64 前缀规则相反**：kling 不许带 `data:`，siliconflow 必须带 `data:`。
   同一个「本地图片 → base64」的公共工具函数必须按厂商分支，不能写成通用默认行为。
5. 图片规格的最严公共交集（**仅对已核实项**）：`jpg/jpeg/png`、
   最短边 ≥300px、宽高比 1:2.5~2.5:1、单图 ≤10MB、输出比例优先 16:9。
   dashscope / seedance 的规格未核实前，不能把「交集」说成「全部满足」。

---

## 附：本文档的证据边界

- 所有「已核实」结论均来自**厂商官方域名**（`help.aliyun.com`、`alibabacloud.com`、
  `kling.ai` / `klingai.com`、`docs.volcengine.com`、`wiki.agnes-ai.com`、`api-docs.siliconflow.cn`）。
- 抓取时间：2026-10-26。厂商文档随时改版，**代码落地前应再复核一次**关键字段。
- 二手来源（知乎、第三方博客、GitHub 工具页）**只用于定位线索，未作为结论依据**。
- 未取到的部分（阿里/火山页面的参数表因页面体积过大截断）**一律标未核实**，没有用推测补全。
