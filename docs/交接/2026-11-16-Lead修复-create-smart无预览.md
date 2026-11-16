# Lead 修复记录：`/app/create-smart` ③ 出图后「无预览」

> 2026-11-16 13:16（Lead 监督窗口）｜触发：用户在 B 测试里出图 2 张（已花 ¥0.40），卡片显示「无预览」。
> **与 C 窗口在途改动无关**（`web/src/screens/createSmart.js` 提交时是干净的），属新向导第一次真实走到 ③ 才暴露的既有缺陷。

## 1. 现象

- `/app/create-smart` 步骤 ③：提示「已出图 2 张（¥0.40）」，但两张卡片都是「无预览」，看不到图。

## 2. 根因（实测，非推断）

`createSmart.js` 出图后用 **`GET /api/photos?final=1`** 取预览地址，再按 `photoId` 匹配。
但批量出图（`src/processors/imageBatch.js`）入库的记录 **`isFinal` 默认 false**：

- `imageBatch.js` ingest 未传 `isFinal` → `photoLibrary.js:177` `isFinal: data.isFinal === true` → **false**；
- 而把它设为最终版（`PUT /api/photos/:id {isFinal:true}`）要求 **`scienceStatus === 'passed'`**（`server.js:916`），
  新图是 `unchecked` —— **结构上永远进不了 `?final=1` 的结果集**。
- 于是前端 `all.find(p => p.id === id)` 落空 → `url: ''` → 渲染「无预览」（`createSmart.js:253` 的兜底分支）。

**只读实测证据**（`.scratch/auto_chain/diag_photo_preview.js`，登录后仅 GET，零计费）：

```
GET /api/photos?final=1        → HTTP 200, photos=6
  smart_mwit3r22_img_0: found=false
  smart_mwit3r22_img_1: found=false
GET /api/photos?includeMissing=1 → HTTP 200, photos=21
  smart_mwit3r22_img_0: found=true url=/clips/smart_mwit3r22_img_0_graded.png status=approved isFinal=false
  smart_mwit3r22_img_1: found=true url=/clips/smart_mwit3r22_img_1_graded.png status=approved isFinal=false
/clips/smart_mwit3r22_img_0_graded.png → HTTP 200 image/png 2881533 bytes
/clips/smart_mwit3r22_img_1_graded.png → HTTP 200 image/png 2659858 bytes
```

ffprobe：两张均 `png 1696x960`（2881533 / 2659858 字节）——**图确实生成成功，文件在，只是前端没取到地址**。

## 3. 改动（1 行，前端静态文件，刷新即生效，**不需要重启 3001**）

`web/src/screens/createSmart.js:116`

```diff
- const pr = await fetch('/api/photos?final=1', { credentials: 'same-origin' });
+ // 批量出图 isFinal=false（设最终版要求 scienceStatus=passed），?final=1 按 id 查不到 → 无预览
+ const pr = await fetch('/api/photos?includeMissing=1', { credentials: 'same-origin' });
```

语法门：`node --check`（改后 ESM 副本）**exit 0**。

## 4. 未修 / 待产品决定

- **库 · 图片 tab 仍是「最终版」口径**（`inventory.js:1346` 也读 `?final=1`，当前 6 张）。
  新出图（`isFinal=false`）**不会出现在库里**，用户想事后审/删这 2 张图只能靠接口。
  这是既有产品口径（2026-11-15「最终版」），要不要放宽需用户拍板——**本次未动**。
- 已生成但未审核的图，`scienceStatus=unchecked` 时无法设最终版；若将来要「通过即最终」，需先过科学审查链路。

## 5. 给 C 窗口的提示

- 你改 `server.js` / `imageGen.js` / `pipeline.js` 时**不要覆盖** `web/src/screens/createSmart.js:116` 这一行。
- 若你把「场景卡→逐段出图→i2v」接到后台（30 段出图），**同样会遇到 `?final=1` 的口径问题**：
  后台自己拿 `clip.photoId` 不经过这个查询，不受影响；但任何**前端展示**新出图的地方都要避开 `?final=1`。

## 6. 口径放宽（2026-11-16 13:2x，用户明确同意）

用户答复「可以把这个口径放宽吧」→ 库 · 图片 tab 不再只显示最终版。

改 `web/src/screens/inventory.js` 两处（**仅删过滤，不碰 C 窗口的 +220 行在途改动**）：

1. `PhotosPanel`（约 437 行）：删掉 `qs.set('final', '1')`，只保留 status / q 过滤。
2. `LibraryView`（约 1351 行）：`useJson('/api/photos?final=1')` → `useJson('/api/photos')`，让**顶部计数与列表同源**。
3. 顶部注释同步为「全量：最终版 + 审核中 + 调色前后各版本」。

实测（零计费只读）：

```
GET /api/photos        → HTTP 200, photos=21   ← 改后口径（原 final=1 只有 6）
  含 smart_mwit3r22_img_0/1（调色后，approved, isFinal=false）
GET /api/photos?final=1 → 6 条（API 行为不变，其它调用方不受影响）
```

语法门 `node --check` **exit 0**；`grep final=1` 已无生效代码（仅注释提及）。

**提交状态：故意未单独提交。**
`inventory.js` 里同时有 C 窗口 +220 行未提交改动，按红线「按路径 add、不混入他人在途工作」，
这 2 行只能随 C 的 `inventory.js` 一起提交 —— **请 C 在提交信息里注明「含 Lead 的 2026-11-16 图片口径放宽 2 行」**。
在此之前改动已在工作区生效（前端静态文件，刷新即生效，无需重启 3001）。

## 7. 图生视频闸门死锁 → 按用户口径解除（2026-11-16 13:2x）

用户第二次被拦：`提交失败：第 1 个片段的图片未通过科学/物理审查，不能生成视频`，
并明确指令：**「只要我打通过了，就不需要再审核，直接可以拿去生成视频」**。

### 7.1 根因：三道闸门互相死锁（不是用户操作问题）

`server.js`（引入于 `8f5e6fb feat(gallery): gate video generation on final approved photos`）
对 `photoIds` / `sourcePhotoId` 要求同时满足：

| 闸门 | 新出图实际值 | 能否满足 |
|---|---|---|
| `status === 'approved'` | approved | ✅（用户点了通过） |
| `scienceStatus === 'passed'` | **unchecked** | ❌ 自动审查从没跑；手动入口在库·图片详情里 |
| `isFinal === true` | **false** | ❌ 而 `PUT {isFinal:true}` 又要求 `scienceStatus === 'passed'`（`server.js:916`）→ **循环依赖** |

→ 批量出图的图**结构性永远无法**用于图生视频。这是设计缺陷，`skipped/unchecked` 被当成 `passed` 的反向滥用。

### 7.2 代码改动（按用户口径：人工通过即放行）

`server.js` 两处（**仅删闸门，未整文件覆盖**；C 窗口的 server.js 改动区间在 +947/+2134/+2178/+2224，未触及这两段）：

1. `sourcePhotoId` 路径：删 `scienceStatus !== 'passed'` 与 `isFinal !== true` 两个 400。
2. `photoIds`（批量/向导）路径：同上，只保留 `status === 'approved'` 硬性要求。
3. 两处均加注释说明口径来源与「原实现循环依赖」。

语法门：`node --check server.js` **exit 0**；`grep 未通过科学/物理审查` 已无匹配。
**生效条件：重启 3001**（后端文件），与 C 窗口改动一起。

### 7.3 当前进程的即时解冻（零计费，仅元数据，可回退）

重启会全员登出 + 丢失向导页内存状态（会迫使重出图再花 ¥0.40），故对**本次 B 测试的 2 张图**做等价操作
（等同用户在库·图片里点「科学审查通过」+「设为最终版」）：

```
PUT /api/photos/smart_mwit3r22_img_0 {scienceStatus:'passed'} → 200
PUT /api/photos/smart_mwit3r22_img_1 {scienceStatus:'passed'} → 200
PUT 两张 {isFinal:true}                                      → 200
复核：status=approved / scienceStatus=passed / isFinal=true（两张一致）
```

脚本 `.scratch/auto_chain/unblock_b_photos.js`（不在 git 内）。未调用任何模型，**零计费**。
回退方式：`scienceStatus` 改回 `unchecked`、`isFinal` 改回 `false` 即可。

### 7.4 提交状态

同 §6：`server.js` 含 C 窗口在途改动，我的 2 处删改**未单独提交**，将随 C 的 `server.js` 提交一起入库。
**请 C 在提交信息里注明「含 Lead 的 2026-11-16 图生视频闸门放宽（按用户口径：人工通过即放行）」**，
并确认其 `verify-image-first-*` 套件里没有断言这两个 400 文案（若有，需改成新的口径断言）。

## 8. 补功能：从图片库按段选图 + 草稿持久化（2026-11-16 13:4x，用户指定「走 C」）

### 8.1 为什么必须补

用户已付 ¥0.40 出的 2 张图，因为「离开向导 → 向导状态丢失」而挂不回去；重走流程要再花 ¥0.40。
现有向导只认本次会话内出的图，旧向导只支持单张 seed（`sourcePhotoId`），做不了逐段首帧。

### 8.2 改动（全部在 `web/src/screens/createSmart.js`，我的文件、无他人改动）

1. **从图片库选图**：③ 新增按钮 → 弹窗列 `GET /api/photos?includeMissing=1` 里 **status=approved 且有 url** 的图；
   按点击顺序作为第 1…N 段首帧；显示序号、`调色前/调色后 · 最终版`；已选 N/clips；选中项卡片显示「库选」+「移除」。
2. **数量硬约束**：`0 < 已选 < 段数` 时红字提示并**禁用「下一步」**（避免静默退化成文生视频）。
3. **不重复计费**：照片条目加 `paid` 标记；出图 `paid:true`、库选 `paid:false`；
   `imageCost` 只累加 `paid` 的图 → ④ 显示「图片：¥0.00（本次出图 0 张 · 从库选 2 张已付费）」，合计只算视频费。
4. **草稿持久化**：`localStorage['vs_create_smart_draft_v1']` 存 step/minutes/clipDur/cards/prompts/imagePrompts/photos/res/transition/bgm
   （**不含任何 Key**）；仅在「动过」时落盘；开局若从草稿恢复则显示「已恢复上次进度」，提交成功或点「重新开始」即清空。
5. 顶部新增「重新开始」按钮（二次确认）。

### 8.3 验收（零计费，真浏览器）

脚本 `.scratch/auto_chain/e2e_create_smart_picker.js`（不在 git）：**CDP 9222 独立 incognito 上下文**
（本会话 headless Chrome 沙箱起不来；不碰用户标签页/不写用户 localStorage），连接**运行中的 3001 单实例**。

```
结果: 22 通过 / 0 失败
  OK 0.34 分钟 → 2 段 / ② 2 段提示词 / ③ 弹窗 11 张库图
  OK 选中 img_0 + img_1（调色后）→ 「已选 2 / 2 张」
  OK ③ 卡片显示「库选」、下一步可用
  OK ④ 图片 ¥0.00（本次出图 0 张 · 从库选 2 张已付费）、合计 ¥12.00
  OK 刷新后「已恢复上次进度」+ 仍在 ④ + 库选 2 张仍在
  OK 流程中不误报「已恢复」 / 无页面 JS 异常 / 未创建任何任务（before=40 after=40）
```

截图：`docs/交接/create-smart-picker/{01-picker-selected-2,02-step4-cost,03-after-reload-draft}.png`。

回归（本机实跑）：`verify-xiaozhi-home` **45/0**、`verify-p6-offline` **41/0**、
`verify-photo-library` **42/0**、`verify-editor-nav` **15/0**、`verify-create-draft` **49/0**。

### 8.4 同步改的断言（按契约改断言，不删检查项）

- `scripts/verify-xiaozhi-home.js`：3 处旧断言（导航「创作」、Rail 高亮、小智首页导航、gen.js 去创作）改为 `/create-smart`；
  新增 1 条「旧六步向导仍可按 /create 打开（回退保留）」→ 44 → **45 项全绿**。
- `scripts/verify-create-draft.js`：**既有过期断言**（写 `navigate('/')`，而 HEAD 代码一直是 `navigate('/create')`，与本轮无关）
  按仓库现状同步为 `/create` → **49/0**。

### 8.5 未验证 / 待用户

- **真实提交（付费）未由我执行**：④→⑤ 的「确认提交」按红线留给用户点。本次 E2E 只验证到 ④，未建任务（40→40）。
- 重启后 §7 的闸门放宽才生效；在那之前选中**非最终版**的库图仍会被旧进程拦（本次 2 张已被标为最终版+审查通过）。

## 9. 视频通道选择：有图时强制走百炼（2026-11-16 13:5x，用户确认「借用百炼」）

### 9.1 背景

B 测试实测：WhaleTV 中转的图生视频 **400** —— `Alibaba requires image references to be URLs`
（中转把 multipart/base64 传给 Alibaba，上游只收公网 URL）。而项目早已实现「借用百炼」：

- `src/generators/dashscopeUpload.js`：`GET {base}/uploads?action=getPolicy` → POST OSS → 得到 `oss://dashscope-instant/...`（48h 私有）；
- 调视频接口时带 `X-DashScope-OssResourceResolve: enable`（`i2vSupport.js` 的 `dashscope: oss-temp-upload`）；
- **不需要用户自己的公网存储**；11-13 那 4 个 completed 的图生视频任务全是这条通道。

### 9.2 改动（`web/src/screens/createSmart.js`）

1. 新增「视频通道」选择：`WhaleTV 中转(openai-video)` / `百炼官方(dashscope)`；默认中转（文生视频）。
2. **有图时强制百炼**：`effectiveModel = useImages ? 'dashscope' : model`；有图时「中转」按钮 **disabled** 并给出原因。
3. 提交体改为按通道取运行时配置：`readRuntimeConfig(effectiveModel)`（百炼 = `dashScopeKey` + 由 `WorkspaceId/Region` 拼出的 baseUrl + `modelId=wan3.0-video`；中转 = whaletvKey/BaseUrl）。
4. ⑤ 模型行按实际通道显示；草稿持久化新增 `model` 字段。

### 9.3 验收（零计费，CDP 拦截 + abort）

脚本 `.scratch/auto_chain/e2e_dashscope_payload.js`：incognito → 走到 ⑤ → `Fetch.enable` 拦截 `/api/tasks` →
读 `postData` 断言 → `Fetch.failRequest` abort（**请求不发送**）。为验证键名映射，测试内注入**假配置**（假 Key/workspace，真实 Key 不出现在脚本里）。

```
结果: 18 通过 / 0 失败
  OK ④ 有「百炼官方」/「已选图 → 自动走百炼」/ 有图时中转 disabled / 合计 ¥12.00
  OK ⑤ 模型显示「百炼万相 3.0（官方）」
  OK 截获 POST /api/tasks：model=dashscope / modelId=wan3.0-video
  OK apiBaseUrl=https://wsf***.cn-beijing.maas.aliyuncs.com/api/v1 / apiKey len=115
  OK photoIds=2（smart_mwit3r22_img_0/1）/ prompts=2 / clipDuration=10 / resolution=720p
  OK preset=final / autoRetry=false / 质检 Key 透传
  OK 未创建任务（before=41 after=41）
```

截图：`docs/交接/create-smart-picker/04-step5-dashscope.png`。回归：`verify-xiaozhi-home` 45/0、`verify-p6-offline` 41/0。

### 9.4 仍未解决

- **小智链路（C 本轮交付）默认仍走 WhaleTV 做图生视频**，同样会踩 400 → 需产品决定：给小智也加百炼通道，或改 WhaleTV 通道复用百炼 URL（后者需一次真实探测字段，须用户同意）。
- 百炼真实付费提交未由 Lead 执行（留给用户点确认）。

## 10. 小智链路默认改走百炼（2026-11-16 14:0x，用户明确指令）

用户原话：「小志的这条链路必须让他不能踩400 同样也改成走百炼」。

### 10.1 改动（后端默认值 + 文案 + 断言）

1. `src/assistant/planCard.js`
   - `MODELS.dashscope.label`：`万相 3.0（DashScope）` → **`百炼万相 3.0（官方）`**
   - `buildPlan` 默认模型：`openai-video` → **`dashscope`**（显式说「WhaleTV / 中转 / agglm」仍走中转）
2. 前端**无需改**：`assistant.js confirmPlan()` 已是 `readRuntimeConfig(plan.model)` →
   plan.model=dashscope 时自动带上 `dashScopeKey` + 由 WorkspaceId/Region 拼出的 baseUrl + `modelId=wan3.0-video`
   （`/api/assistant/execute` 的 runtimeConfig 白名单已含 `apiKey/apiBaseUrl`）。
3. 同步断言（按契约改断言、不删检查项）：
   - `scripts/verify-assistant.js` [8]：默认计费模型断言 → dashscope + 新标签
   - `scripts/verify-whaletv-video.js` [1]：默认断言 → dashscope；**「whale 中转」显式用例保留**
   - `scripts/verify-all.js` 的套件描述同步（该文件当前有 C 窗口在途改动，**未单独提交**，随 C 一起入库）

### 10.2 验收（零计费，本机实跑）

```
node -e planCard.buildPlan：'mock 2段...' → model=mock（Mock 流程不受影响）
                              无模型词的默认  → model=dashscope / label=百炼万相 3.0（官方）
verify-assistant             105/0   ✅
verify-whaletv-video          37/0   ✅（中转通道自身的请求体/价目仍覆盖）
verify-image-first-pipeline   77/0   ✅（两行 ❌ 是套件故意构造的负向用例）
```

**注意**：13:5x 首次跑 `verify-assistant` 得到 **96/9**，原因是 **C 窗口同时在跑它自己的 `verify-assistant`**，
两个进程共用真实 `app/clips/_samples`（都会建/删 mock 样片）→ 竞态。C 停下后复跑 **105/0**。
结论：以后跑这个套件不要与另一窗口的同一套件并行。

### 10.3 生效条件与风险

- **需重启 3001**（后端默认值在进程内）；B（create-smart）不需要重启。
- 小智真实长片仍是**付费**（5 分钟 ¥180 / $30），且 C 的「出图后暂停审图」需用户审图后继续。
- 中转通道保留：用户显式说「用中转 / WhaleTV」时才走；**有图走中转仍会 400**（本次未改中转载荷）。
