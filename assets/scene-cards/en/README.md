# 场景卡英译源数据（S3-B）

这是**翻译源**，不是运行时产物。运行时读的是 `../v3.3-final.json`（由构建脚本生成）。

## 文件

| 文件 | 用途 |
|---|---|
| `batch-1.tsv` … `batch-5.tsv` | 16 个展示字段（`EN_FIELDS`），按 40 张/批增量。每行 `field|中文|英文` |
| `shared.tsv` | 跨卡共享的负向补充：`negative`（全库同 1 种）与 `science.forbidden`（7 种） |
| `batch-N.answers.txt` | 该批 `missing` 的编号答案，供审计/重跑；不参与构建 |

## 合并规则（重要）

- **不是按批次整体替换**：构建时按 card id 逐卡解析它的 16 个字段，从所有 `batch-*.tsv` + `shared.tsv` 取译法；
  批 2 只新增自己的 key，不会覆盖批 1。
- 词表键是 `field + 中文值`：同一个中文值全库共用同一英文（保证一致性）；不同字段的同名中文可不同译
  （如 `weather.阴天散射` vs `light.阴天散射`）。
- 同一个 `field+中文` 只允许一条；跨文件重复且英文不一致会直接报冲突。
- 幂等：重复运行 `build` 不会丢已译字段、不会重复、不会乱序；
  与上一次产物相比 `_en` 计数减少或已译 key 丢失会**拒绝写盘**（硬断言）。
- 只加 `_en` / `negative_en` / `science.forbidden_en` 字段；不动 `id / scene_key / chapter / sequence` 与中文原文。

## 构建

```powershell
# 分批（只写已译；未译字段运行时 pickField 回退中文）
node scripts/build-scene-cards-final.js

# 最终验收（要求 16×200 + negative_en×200 + science.forbidden_en×200 全量）
node scripts/build-scene-cards-final.js --require-complete
node scripts/translate-scene-cards-en.js check
```

## 编码

UTF-8 无 BOM。中文值里不要出现 `|`（TSV 分隔符）；英文只允许可打印 ASCII（构建会断言）。

## 批次状态

- 批 1：40 张（sc-086 … sc-040），254 条
- 批 2：40 张（sc-239 … sc-075），174 条
- 累计：80/200 张；16 字段覆盖 2622/3200（81.94%）
- 批 3–5：未开始（等用户审完批 1–2 的词表再放大）
