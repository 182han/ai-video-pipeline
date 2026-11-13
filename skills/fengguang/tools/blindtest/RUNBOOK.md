# 盲测回归：改了 skill 规则就跑一遍

> 目的：证明"改动确实让提示词更好"，而不是自我感觉良好。
> 8 条口语需求固定不变（`requests.json`），基线绑死；换需求就要重设基线。

## 一、跑之前

- **两个全新 agent**，同一批需求：
  - A（实验组）：只允许读本 skill（`SKILL.md` + references/examples），写 8 条提示词；
  - B（对照组）：**不许读任何 skill / 语料**，凭自己的经验写 8 条。
- 两边都不许读 `whale-work` 语料与历史输出——否则不是盲测。
- 写作要求一致：90–180 字、七段、不写分辨率/配乐/音效。
- 输出格式：每行 `{"id":"h1","prompt":"…"}`，8 行。

## 二、客观评分（零依赖，必跑）

```bash
node tools/blindtest/score.mjs \
  --with   <with-skill.jsonl> \
  --without <no-skill.jsonl> \
  --baseline tools/blindtest/baseline.json
```

查四项硬约束：高光控制、结尾锁画面、单条镜头轴、极光主语（h1/h2/h5）+ 禁用词。
每条 3–4 分，满分 27。

**通过标准**（当前基线）：`with ≥ 26` 且 `gap ≥ 20`，且无禁用词 → `exit 0`。

2026-10-27 实测：with **27** / without **6** / gap **21**（放宽"不收溢出"等合法写法后）。

## 三、内容保真（可选，需要模型评判）

客观分不查"专名准不准、光位对不对"，这两项靠盲评。让评判员在**不知道哪份有 skill** 的前提下，
对每条两个候选各打 5 项 0/1：专名 ≥2 个具体物 · 光位（时刻+方向+冷暖）· 单轴 · 高光 · 极光颜色。
输出每条的偏好与总分。

2026-10-27 实测（同一评判）：with **33/36** vs without **16/36**；
差距集中在光位 7:1、高光 8:1、极光 3:0、单轴 8:6；对照组的专名 8:7 略高——它会自己编细节。

## 四、怎么解读

- **看差值，不看绝对值**：同一模型当评判会偏高，但"有/无 skill"的差是稳的。
- `with` 掉了 = 新规则写坏了；`without` 涨了 = 新规则没带来差异（可能已内化，也可能是废话）。
- 客观分涨、盲评分不涨 = 规则只加了形式（锁句/高光），没提升内容判断。

## 五、模糊需求套件（`fuzzy.mjs`）

6 条口语需求（`fuzzy.json`），测"把空词换成专名"的能力，不需要对照组也能跑：

```bash
node tools/blindtest/fuzzy.mjs --candidate <fuzzy.jsonl> --baseline tools/blindtest/fuzzy-baseline.json
```

每条 5 分：具体物 · 光位（时刻+方向/冷暖）· 高光控制 · 结尾锁句 · 单轴；满分 30。
基线：`with 30 / without 16`（2026-10-27；无 skill 版还写了 4 处 4K/8K）。
通过标准：`≥ 29`。

## 六、多段连续性套件（`sequence.mjs`）

一条 30 秒片拆 5 段（`sequence.json`），测"五条拼起来会不会串味"：

```bash
node tools/blindtest/sequence.mjs --candidate <sequence.jsonl>
```

查：运镜种类 ≥4、光线种类 ≥3、每段单轴 + 高光 + 锁句、冷暖 ≥4 段统一、
主体句两两不相似、无禁用词。全过才 `exit 0`。

2026-10-27 首测 **FAIL**：`s5` 写「静机位极慢摇臂升降」——静机位配摇臂，位置变了。
据此给 skill 补了 §十八（多段连续性 + 5 段骨架）；复测 **PASS**
（4 种运镜、5/5 单轴、5/5 高光、5/5 锁句、4 种光位）。

## 七、一键门禁

三套合跑，任何一套失败即 `exit 1`：

```bash
node tools/blindtest/verify-all.mjs \
  --ab-with <with-skill.jsonl> --ab-without <no-skill.jsonl> \
  --fuzzy <fuzzy.jsonl> \
  --sequence <sequence.jsonl>
```

**默认严格模式（可直接进 CI）**：

| 情形 | 行为 |
|---|---|
| 三套输入齐全 | 跑完；全过 `exit 0`，任一失败 `exit 1` |
| 缺任一套输入 | **`exit 2` 并列出缺项**——不静默跳过 |
| 路径不存在 | `exit 2` |
| 显式 `--skip ab,fuzzy` | 只跑剩下的，汇总标 `PARTIAL`，`exit 0`（仅本地用） |

CI 里**不要加 `--skip`**；漏跑一套就该红。

**多段套的「首尾循环」**：头尾必须同色系（`loopPalette`）且同运镜类型（`loopMove`），否则剪不回开头。

## 八、纪律

- `requests.json` 与 `baseline.json` 是**同一套**，改一个必须重设另一个，并写进 CHANGELOG。
- 每次改 `SKILL.md` 的硬规则（自检卡、失败表、光线表、单维度改写）都跑一次；
  只改错别字/排版不用跑。
- 盲测产物保留在 `Desktop\测试\blindtest-*.jsonl`，方便复查。
