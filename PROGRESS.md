# PROGRESS — 交接快照（2026-11-02）

## 项目目标
一句话提示词 → 自动分镜 → 批量生成片段 → 质检 → 拼接配乐 → 适合 Android TV 屏保循环的长片。

## 已完成
- 新版前端 React 深绿黑+香槟金外壳/六步向导/库存三页/历史+垃圾箱/模板库/设置/成员：`f11b34b 2637cf4 8331a4d a3c6df9 8c396cb 4daf3e7 368f096`
- 暂停/继续接线（任务行·抽屉·顶栏条，failureCode 三态）：`8331a4d`
- 后端 `GET /api/templates`：`f667d7d`；登录默认跳 `/app`：`881aa42`
- 登录首屏按 v3 深色稿落地（夜谷视频+海报兜底）：`da2b310`，文案与字号调整：`f8f2895 fd8bc5d 38b7c04 575e8b6`
- 暂停后端 + 调色链（另一会话）：`1c39bcc`（wip 包裹，未跑门禁）

## 进行中
- 登录首屏文案/字号微调：当前 `一句话，换一整夜的风景` 为 22–37px，等用户确认是否再大一档。
- 未做：登录页兜底海报仍是白天雾山（视频不播时偏亮），建议从 `night-valley-loop.mp4` 抽夜色帧替换 `public/assets/hq/poster-2k.jpg`。

## 下一步第一步
启动服务并打开 `http://localhost:3001/login.html` 强刷，确认主诉字号与钩子位置符合预期；再决定是否抽帧换兜底海报。

## 已知问题
- `data/logs/` 被 `git add -A` 一起提交了（应加进 .gitignore）。
- `verify-all.js` 注册 18 个套件、实有 35+ 个；本次未跑任何门禁。
- 视觉仅经无头截图与 REA Chromium DOM 验证，未人眼过。
- 出图无 provider、审核门 `awaiting_review` 未实现、配乐无文件上传通道。

## 试过但失败的方向
- Vite 方案：本机无 npm/npx，改用 React UMD + htm 零构建。
- Chrome 直启截图：曾被沙箱拦命名管道（mojo EPERM），本次已可用。
- 双端口并行（3001+3002）验证新代码：两实例共享 postgres，启动回收误标任务，已废弃。
