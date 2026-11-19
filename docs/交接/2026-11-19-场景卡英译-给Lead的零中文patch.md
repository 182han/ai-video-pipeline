# 给 Lead：场景卡英译“英文版零中文”收口 patch（2026-11-19）

> 来源：S3-B 卡库英译窗口。用户 2026-11-19 明确：**英文版不允许出现任何一个中文字**。
> 本文件只列**仍归 Lead 窗口改**的两处（`server.js`、`src/assistant/supervisor.js`）；
> 负向提示词那 1 行已由本窗口按用户授权改完（见 §0），不要重复改。

---

## 0. 已完成（本窗口，用户授权）

- 提交：`e32a432` `feat(i18n): 英文负向提示词接 negativeEn（零中文）`
- 文件：`src/promptComposer.js` 1 行
  ```diff
  - const negativePrompt = _negative(card);
  + const negativePrompt = _isEn(ctx.lang) ? sceneTemplates.negativeEn(card) : _negative(card);
  ```
- 数据：`assets/scene-cards/v3.3-final.json` 已有 `negative_en`（200/200）与
  `card.science.forbidden_en`（200/200）；`src/i18n/templates/scene.js` 的 `negativeEn()`
  已改为只取 `*_en`、不回退中文。
- 实测：英文 negative 含中文 **0/200**；中文 negative 与改动前逐字相同（200/200）。
- 中文路径零回归：`verify-i18n-backend` 104/0/1 跳过、`verify-assistant` 263/0。

## 1. 预览接口：英文仍返回中文提示词/中文 sceneKey（`server.js`）

**现状**：`server.js:3312` 的 `GET /api/scene-cards/preview`
在 `:3327` 调 `composeClipPatch(card, {})`，未传 lang；返回的 `sceneKey` 是中文，
被 `web/src/screens/createSmart.js:326` 直接显示。

**可用条件**：服务端已有 `req.lang` 中间件（`server.js:118`，cookie `vs_lang` → Accept-Language → zh），
**不需要改 web**。

**patch（server.js，2 处）**：

```js
// :3327
const patch = promptComposer.composeClipPatch(card, { lang: req.lang });

// 返回对象里（当前是 sceneKey: card.scene_key）
sceneKey: req.lang === 'en'
  ? (card.protagonist_en || card.scene_key)   // 英文界面显示英文名
  : card.scene_key,
sceneKeyZh: card.scene_key,                    // 保留原键，便于审计/中文界面
```

**验收（用户重启 3001 后；不要自行重启/起第二实例）**：

```powershell
# 用已登录的 vs_lang=en 会话请求（Lead 已有 --cred-file 方案，见 verify-i18n-live.js）
# 断言：cards[*].prompt / imagePrompt / sceneKey 都不含 [\u4e00-\u9fff]
# 再用 vs_lang=zh 请求，prompt/imagePrompt 与改动前逐字相同
```

## 2. 助手“选了哪些场景”：英文聊天仍显示中文卡名（`src/assistant/supervisor.js`）

**现状**：
- `:384 sceneCardLine` 硬读 `scene_key / biome / landform / shot / palette`，并拼 `第 X 章`、`缓冲卡`；
- `:398 formatSceneEntries` 的“共 N 张”也是中文；
- 英文分支 `:1409` 调它；单段换卡 `:1351`、全部换卡 `:1409/:1413` 同样；
- 换卡消息里的 `fromKey/toKey`（`:1346-1349`、`:1390-1399`）同样是中文 `scene_key`。

**patch（函数级替换；行号以 HEAD=e32a432 为准，应用前先 `git status` 确认没撞车）**：

```js
function sceneCardLine(entry, i, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const card = (entry && entry.id ? sceneCardLibrary.getCardById(entry.id) : null) || entry || {};
  const rawName = card.scene_key || card.sceneKey || card.id;
  const name = isEn ? (card.protagonist_en || rawName) : rawName;
  const bits = [`#${i + 1}`, name || (isEn ? '(unknown card)' : '(未知卡)')];
  const chapter = Number.isInteger(card.chapter) ? card.chapter : (entry && entry.chapter);
  const sequence = Number.isInteger(card.sequence) ? card.sequence : (entry && entry.sequence);
  if (Number.isInteger(chapter) && Number.isInteger(sequence)) {
    bits.push(isEn ? `ch. ${chapter}-${sequence}` : `第 ${chapter} 章-${sequence}`);
  }
  const biome = isEn
    ? [card.biome_en, card.landform_en].filter(Boolean).join('/')
    : [card.biome, card.landform].filter(Boolean).join('/');
  if (biome) bits.push(biome);
  const shot = isEn ? card.shot_en : card.shot;
  if (shot) bits.push(shot);
  const palette = isEn ? card.palette_en : card.palette;
  if (palette) bits.push(palette);
  if (entry && entry.role === 'buffer') bits.push(isEn ? 'buffer card' : '缓冲卡');
  return bits.join(' · ');
}

function formatSceneEntries(entries, lang) {
  const isEn = i18n.normalizeLang(lang) === 'en';
  const list = Array.isArray(entries) ? entries : [];
  const shown = list.slice(0, SCENE_PREVIEW_LIMIT).map((e, i) => sceneCardLine(e, i, lang));
  if (list.length > shown.length) {
    shown.push(isEn
      ? `… ${list.length} cards in total; first ${shown.length} shown here.`
      : `…… 共 ${list.length} 张，这里先列前 ${shown.length} 张。`);
  }
  return shown.join('\n');
}
```

**调用点（6 处，传当前分支的 lang）**：

| 行 | 改法 |
|---|---|
| 464 | `formatSceneEntries(task.sceneCards.used, isEn ? 'en' : 'zh')` |
| 484、488 | `formatSceneEntries(preview, isEn ? 'en' : 'zh')` |
| 1351 | `formatSceneEntries(planSceneEntries(plan), isEn ? 'en' : 'zh')` |
| 1409、1413 | `formatSceneEntries(planSceneEntries(plan), isEn ? 'en' : 'zh')` |

**换卡消息的卡名（两处）**：

```js
// 单段换卡：:1346-1349
const fromKey = oldCard ? (isEn ? (oldCard.protagonist_en || oldCard.scene_key) : oldCard.scene_key) : oldId;
const toKey = nextCard ? (isEn ? (nextCard.protagonist_en || nextCard.scene_key) : nextCard.scene_key) : next.id;
const chapterSeq = nextCard && Number.isInteger(nextCard.chapter) && Number.isInteger(nextCard.sequence)
  ? (isEn ? ` (ch. ${nextCard.chapter}-${nextCard.sequence})` : `（第 ${nextCard.chapter} 章-${nextCard.sequence}）`)
  : '';

// 全部换卡：:1390-1399 的 fromKey / toKey / chapterSeq 同上；changes.push 两个分支都用上面算好的英文/中文串。
```

## 3. 验收（Lead 改完后，逐条给数字）

```powershell
# 数据/提示词（200 张全译完后）
node scripts/build-scene-cards-final.js --require-complete
node scripts/translate-scene-cards-en.js check
# 期望：check 的 16 字段 3200/3200、negative 200/200、forbidden 200/200；
#       英文 video/image/negative 提示词零中文；中文 200/200 与改动前逐字相同。

# 套件（逐个跑；verify-all 本机 spawn EPERM，不能当门禁）
node scripts/verify-scene-cards.js        # 58/0
node scripts/verify-i18n-backend.js      # 104/0/1 跳过（live 探针需重启后 --probe）
node scripts/verify-i18n.js --strict     # 12/0
node scripts/verify-i18n-runtime.js      # 29/0
node scripts/verify-assistant.js         # 必须 263/0
```

**Live（用户重启 3001 后）**：
- `/api/scene-cards/preview`（`vs_lang=en`）的 `prompt/imagePrompt/sceneKey` 零 `[\u4e00-\u9fff]`；
- 英文会话问“选的是哪三个场景/把三个都换掉”，回复零中文；
- 同一请求切 `vs_lang=zh`，中文与改动前逐字相同。

## 4. 边界提醒

- **不要**自行重启服务 / 起 3002 / 按进程名杀 node；重启只由用户跑 `测试\重启服务.bat`。
- 本 patch 不涉及任何真实计费调用；验收只用静态断言 + live 只读 GET。
- `verify-i18n-live.js` 的 `USER_CONTENT_KEYS` 会把 `prompt/negativePrompt/sceneKey` 当“用户内容”跳过；
  **不能**靠它证明零中文，必须用上面的专项断言。
- 中文路径逐字不变是硬要求；改完 `verify-assistant` 必须仍是 263/0。

## 5. 当前数据状态（本窗口）

- 卡库：批 1–2 已译 80/200；16 字段 2622/3200；`negative_en`/`forbidden_en` 200/200。
- 词表：`assets/scene-cards/en/*.tsv`；用户已放行，批 3–5 由本窗口继续译完。
- 全量译完后本窗口会再给一次 200/200 的 `check` + 套件数字；届时只差本文件 §1/§2 的代码。
