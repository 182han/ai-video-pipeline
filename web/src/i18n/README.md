# i18n 工作手册（P1 屏幕迁移）

> 规格全文：`../../../../docs/spec/i18n-spec.md`（从 `app/web/src/i18n/` 出发）。
> 本文件只写"怎么改"，给并行执行的人/Agent 用。

## 1. 运行时 API

```js
import { t, tp, fmtDateTime, fmtDate, fmtNumber, fmtPct } from '../i18n/index.js';

t('create.step.prompt.title')                       // 普通文案
t('tasks.clipCount', { n: 3 })                     // {n} 插值
tp('inventory.finals.count', n)                    // 复数：查 <key>_one / <key>_other
fmtDateTime(task.createdAt)                        // 用当前语言格式化日期时间
```

- **只在渲染/执行时调用 `t()`**。不要把翻译结果存进模块级常量、闭包缓存或 localStorage。
- **如果文件里已经有变量叫 `t`**（例如 `const t = state.task;`、`function apply(t)`、`tasks.find(...)` 存成 `t`），
  import 时必须用别名，否则局部变量会遮蔽翻译函数：
  ```js
  import { t as tr } from '../i18n/index.js';
  // 之后一律 tr('key')，局部变量 t 保持原义
  ```
- 需要判断某个 key 是否存在时用 `has(key)`（例如步骤名兜底）。
- React 组件不需要订阅语言：切换语言时 `app.js` 根节点会整树重渲染（不 remount，状态保留）。
- 没有 `useT`，也不要自己加事件监听。

## 2. 词条文件

每个屏幕组一个文件，导出 `{ zh, en }`，中英**并排**：

```js
// web/src/i18n/messages/create.js
export default {
  zh: { create: { step: { prompt: { title: '提示词' } } } },
  en: { create: { step: { prompt: { title: 'Prompt' } } } }
};
```

- key 规则：`<屏幕>.<区块>.<元素>`，小驼峰；中文不要当 key。
- 同一个 key 中英必须都存在；`{param}` 占位符两边必须一致。
- 复数：`count` + `count_one` + `count_other`（中文只用 `_other` 也行，`tp` 会回落）。
- 新增文件必须在 `messages/index.js` 的 `NAMESPACES` 注册（本任务已预建，不要改 index）。

## 3. 什么要翻、什么不要翻

**要翻**：htm/JSX 文本、按钮、表头、空态、占位符、`title`、`aria-label`、`placeholder`、
`window.confirm/prompt`、前端自己拼的错误/状态文案、步骤名、下拉选项、单位说明。

**不要翻**：
- 代码注释（保持中文，别动）；`console.log/warn` 调试日志（不是用户界面）。
- 后端返回的 `error` / `message` / `detail`（P2 统一处理；先原样显示）。
- 产品/厂商/格式名：`Video Studio`、`Seedance`、`Kling`、`DashScope`、`wan2.7`、`BGM`、`QC`、`NSFW`、
  `API Key`、`Base URL`、`WorkspaceId`。
- 用户输入内容、生成内容、文件名、路径。
- 既有中文标点风格不要扩散到英文里（英文不要用「」、，。）。

## 4. 常见改造模式

```js
// 1) 模块级常量：存 key，不存翻译
const STEPS = [
  { key: 'prompt', labelKey: 'create.step.prompt' },
  { key: 'images', labelKey: 'create.step.images' }
];
// 渲染：${t(s.labelKey)}

// 2) 动态文案：参数化，不要拼接
t('create.summary', { n: scenes.length, duration: minutes })

// 3) 数量：用复数
tp('inventory.clips.count', clips.length)

// 4) 日期：不要写死 zh-CN
// 旧：new Date(t.createdAt).toLocaleString('zh-CN')
fmtDateTime(t.createdAt)

// 5) confirm/prompt
window.confirm(t('library.deleteConfirm', { name: title }))

// 6) 状态映射表：把 text 改成 textKey，渲染时 t()
const STATUS = { running: { textKey: 'tasks.status.running', cls: 'text-accent' } };
```

## 5. 英文风格与术语表

简洁、sentence case（专有名词除外）、按钮用动词、不加句号（完整句子才加）。
中文长度 1.6 倍以内，避免撑破固定宽度。

| 中文 | English |
|---|---|
| 创作 / 智能创作向导 | Create / Smart creation wizard |
| 剪辑 / 剪辑台 | Edit / Editor |
| 库 | Library |
| 成片 / 片段 / 图片 | Finals / Clips / Photos |
| 提示词 | Prompt |
| 场景卡 | Scene card |
| 运镜 | Camera move |
| 配乐 | Soundtrack |
| 质检 | QC |
| 档位 / 补跑 | Preset / Continue |
| 生成 / 重新生成 | Generate / Regenerate |
| 素材 | Assets |
| 回收站 | Trash |
| 模板库 | Templates |
| 计划卡 | Plan card |
| 小智 | XiaoZhi（不译） |
| 时长 / 分辨率 / 帧率 | Duration / Resolution / Frame rate |
| 转场 / 接缝 | Transition / Seam |
| 导出 / 下载 | Export / Download |
| 暂停 / 继续 | Pause / Resume |
| 删除 / 移除 | Delete / Remove |
| 未执行 / 已通过 / 不通过 | Not run / Passed / Failed |

## 6. 自检

```powershell
cd C:\Users\14872\Desktop\测试\app
node scripts/verify-i18n.js            # key 对等、占位符、使用中 key、硬编码扫描
node scripts/verify-i18n-runtime.js    # 运行时 + 模块图加载（29 项）
```

- 并行期间，其他 namespace 的 key 可能暂时缺失，守卫会报"使用中 key 不存在"——只看**你负责的 key**。
- 改完后，用守卫输出的"硬编码中文扫描"确认你的文件计数下降；注释不算。
- **视觉未验证**：本机 Electron 不可用、无头浏览器被沙箱限制。不要写"视觉已通过"。
