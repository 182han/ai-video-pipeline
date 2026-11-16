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
