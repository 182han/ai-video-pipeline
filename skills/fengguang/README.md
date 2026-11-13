# skill-fengguang · 摄影级自然风光视频提示词

一个**数据驱动**的 AI agent skill：把一句人话，写成能生成「摄影级」自然风光视频的中文提示词。

不是"形容词大全"，而是从**真实作品**里量出来的参数。

## 为什么是数据驱动

我们统计了两类真实素材：

| 素材 | 量 | 说明 |
|---|---|---|
| 自然风光静帧 | 80 张 | 摄影比赛/图库级 |
| 4K/8K 风光长片 | 5 部，**2210 帧** | Scenic Relaxation 式屏保长片 + 国家地理纪录片 + 天文摄影 |

量出来的关键事实（完整数据见 `references/风格指纹.md`）：

- 专业风光片平均亮度稳定在 **104–105**，暗部 **9–16%**
- **高光中位数只有 0.2%–3.4%** —— "高光控死"才是摄影级最硬的标志
- 静帧比长片**更浓更暖**（饱和 0.405 vs 0.339，暖色 27.5% vs 15.1%）→ 因此分 `dramatic` / `cinematic-calm` 两档
- 不同题材色板差异极大：国家地理式 sat 0.237（极冷极淡）、秋色 sat 0.394（暖浓）、天文 sat 0.295 + 暖主导 86%（暗底暖星云）

## 里面有什么

```
SKILL.md              主规程：判据、两档风格、七段骨架、构图五条、自检卡
references/词库.md    50 条「日常词 → 地貌专名」+ 35 条语料实测补遗 + 光线/运镜/材质/负面词
references/风格指纹.md 全部实测数据、分片色板、复现方法、已知局限
references/片源筛选.md 现成片源判定：三关、屏保杀手、4K/1080p 设备矩阵、22 条案例
references/语料规范.md 反拆：字段口径、可判性、抽查法、入库三态、1→4 扩写
examples/样例.md      5 条完整范例 + 1 组反例改法 + 批量差异化技巧
integrations/         蒸馏版 system-prompt 规则，可直接接进 LLM 优化链路
CHANGELOG.md          版本记录
```

## 接进你自己的生成流水线

`SKILL.md` 给人读；要接进"用户一句话 → LLM 扩写提示词"的链路，用
[`integrations/system-prompt-rules.md`](integrations/system-prompt-rules.md) —— 一份约 1.8KB 的蒸馏版规则，
整段追加到 system prompt 即可。

三条原则：**蒸馏而非全文**、**按主题开关**（风光规则别套到城市夜景上）、**可一键关闭**。
参考实现见 `integrations/system-prompt-rules.md` 的「用在哪」一节。

## 怎么用

### 作为 agent skill

一条命令装好（目录名即 skill 名，`SKILL.md` 必须在根）：

```powershell
# Windows
.\install.ps1                                  # 默认装到 ~\.dsh\skills\fengguang
.\install.ps1 -Target "$env:USERPROFILE\.claude\skills"
```

```bash
# macOS / Linux
./install.sh                                   # 默认装到 ~/.dsh/skills/fengguang
./install.sh ~/.claude/skills
```

不同工具的 skills 路径不同：

```
~/.dsh/skills/fengguang/     # DeepSeek Harness
~/.claude/skills/fengguang/  # Claude Code 类
```

装完用 `风光提示词 / 摄影级大片 / 雪山 / 银河 / 极光 / 沙丘 / 屏保长片` 触发。

### 当作文档直接读

不装也能用：直接读 `SKILL.md`，要查词就翻 `references/词库.md`。

### 最小用法（30 秒）

1. 说人话："我想拍沙漠日落"
2. 查 `词库.md §1` → 沙丘脊线 / 风纹 / 滑落面
3. 选一档：`dramatic` 还是 `cinematic-calm`
4. 套七段公式（`SKILL.md §四`）
5. 过 10 条自检卡（`SKILL.md §十二`）

## 设计原则

- **用户说人话**：绝不要求用户懂地质术语，翻译由 skill 负责。
- **一条提示词只有一条运动主轴**：双运镜是画面抖动的第一原因。
- **参数可回填**：所有色板都是数字，跑完真实成片后可以校准。
- **不承诺模型能力之外的事**：水印、字幕、转场不在提示词里写。
- **片源与提示词分开判**：提示词看"像不像摄影"，片源看"放不放得住"，两套判据不混用。
- **证据分级**：看过帧、取到帧、同题材推断是三件事；语料里必须分开写，不许混成一句"已验证"。
- **改写只动一处**：换运镜 / 换光 / 换焦段各一张约束表；一次改两处 = 新片段，不是变体（§十七）。

## 怎么验证

改完任何硬规则，跑一条门禁（三套合跑，不需要联网）：

```bash
node tools/blindtest/verify-all.mjs \
  --ab-with <with-skill.jsonl> --ab-without <no-skill.jsonl> \
  --fuzzy <fuzzy.jsonl> --sequence <sequence.jsonl>
```

三套分别是：**有/无 skill 对照**（8 条口语）、**模糊需求**（6 条空词）、**多段连续性**（5 段 + 首尾循环）。
也可单独跑 `score.mjs` / `fuzzy.mjs` / `sequence.mjs`。

2026-10-27 基线：A/B **27 / 6**（满分 27）；模糊 **30 / 16**（满分 30）；多段首测 FAIL → 补 §十八 → 复测 PASS。
流程与解读见 `tools/blindtest/RUNBOOK.md`。

## 已知局限

- 1x.com 的图片未取得像素（JS 渲染 + 本机无头浏览器不可用），其视觉语法依据策展结构与极简样本推断。
- 静帧为手机截屏，画面带定位依赖行方差阈值，极少数全黑构图可能误判。
- `warm/cool` 是粗粒度色相判据，不能替代专业色彩分析。
- `references/片源筛选.md` 的案例库是 2026-10-27 的一次性核验样本：链接、画质、版权状态都会变，
  其中 5 条因平台未提供逐帧缩略图而标为「未核验」，没有下判断。
- 语料已扩到 **50 行 / 33 支源片**（含 6 条负样本）+ 129 条变体，差分校验 0 error；
  `verified=true` 49 行 + 1 行隔离（`sp-04` 未看帧）；切分 140/32、三元组 105/24。
- **盲测是单模型评判**：客观分（高光/锁句/单轴/极光主语）可复现，专名与光位仍靠模型盲评，
  绝对值会偏高；看"有/无 skill 的差"，不看绝对分。
- 8 条需求只覆盖单段、题材集中在已有语料；**模糊需求与多段连续性还没测**。
- 本 skill 产出的提示词**未经大规模生成验证**；`CHANGELOG.md` 会记录每次验证的结果。

## 升级路线

| 版本 | 目标 |
|---|---|
| v0.1 | 文档版（当前）：规程 + 词库 + 数据 |
| v0.2 | 用真实成片回填色板参数，修正偏差 |
| v0.3 | 词库回填到生成流水线的模板池（解决短池重复运镜） |
| v1.0 | 接入 AI 优化链路，自动产出提示词 |

## 数据出处

- 中国国家地理网 `dili360.com`：地貌叙事与专有地貌分类
- 1x `1x.com`：策展制（获奖 / 已发布 / 展览三级）
- B 站 5 部 4K/8K 风光长片（快照接口抽帧，未下载完整视频）
- 用户提供的 80 张风光静帧

## 许可证

**MIT**，见 [`LICENSE`](LICENSE)。

数据部分（`references/风格指纹.md`）的统计结论可自由引用，但原始素材版权归各摄影师与平台所有，未随本仓库分发。

---

# English

## skill-fengguang · Photographic Landscape Video Prompts

A **data-driven** agent skill that turns one plain sentence into a Chinese prompt for
photoreal-grade landscape video generation. Not a list of adjectives — parameters measured
from real work.

### Why data-driven

Two corpora were measured:

| Corpus | Size | Notes |
|---|---|---|
| Landscape stills | 80 images | contest / gallery grade |
| 4K–8K landscape films | 5 films, **2,210 frames** | Scenic-Relaxation-style screensaver films, a NatGeo documentary, astrophotography |

Measured facts (full data in `references/风格指纹.md`):

- Professional landscape video sits at mean luminance **104–105**, shadows **9–16%**
- **Median highlight coverage is only 0.2%–3.4%** — "clamped highlights" is the hardest
  signature of photographic grade, harder than any adjective
- Stills are more saturated and warmer than film frames (sat 0.405 vs 0.339, warm 27.5% vs 15.1%)
  → hence two profile tiers: `dramatic` / `cinematic-calm`
- Palettes differ sharply by subject: NatGeo-style sat 0.237 (very cold & pale), autumn sat 0.394
  (warm & rich), astro sat 0.295 with 86% warm-dominant frames (dark base, luminous warm nebula)

### What is inside

```
SKILL.md              the playbook: criteria, two tiers, 7-slot formula, composition, checklist
references/词库.md     50-entry "plain words → geomorphological term" table + 35 corpus terms + light/move/texture vocab
references/风格指纹.md  all measurements, per-film palettes, reproduction method, limitations
references/片源筛选.md  footage triage: three gates, screensaver killers, 4K/1080p matrix, 22 cases
references/语料规范.md  reverse extraction: schema, what a 480×270 frame can/can't tell, spot-check, 1→4, merge rules
examples/样例.md       5 full examples + 3 corpus examples + a bad→good rewrite
tools/                zero-dependency scripts (corpus check, Bilibili sprite, A/B blindtest harness)
```

### Install

Drop the directory into your agent's skills folder, e.g.:

```
~/.dsh/skills/fengguang/     # DeepSeek Harness
~/.claude/skills/fengguang/  # Claude-Code-like agents
```

`SKILL.md` must sit at the directory root; the trigger phrases live in its YAML `description`.

### Design principles

- **The user speaks plainly** — never require geological jargon; the skill translates.
- **One motion axis per prompt** — dual camera moves are the top cause of jitter.
- **Every parameter is a number** — palettes can be recalibrated after real renders.
- **No promises beyond the model** — watermarks, subtitles, transitions are pipeline concerns.
- **Footage and prompts are judged separately** — prompts for "does it look photographic",
  footage for "does it hold up on a TV for hours".
- **Evidence has levels** — frames watched, frames fetched, and same-genre guesses are three
  different things; a corpus must say which one, not "verified".

### Roadmap

| Version | Goal |
|---|---|
| v0.1 | Document edition (current): playbook + vocabulary + measurements |
| v0.2 | Recalibrate palettes from real renders |
| v0.3 | Feed the vocabulary back into the generation pipeline's template pools |
| v1.0 | Wire the skill into the AI prompt-optimisation path |

### Limitations

- 1x.com images could not be fetched pixel-wise (JS-rendered; no headless browser available
  on the build machine). Its visual grammar is inferred from curation structure and minimal samples.
- Stills are phone screenshots; band detection relies on a row-variance threshold.
- `warm/cool` is a coarse hue proxy, not a substitute for proper colour analysis.
- The prompts produced have **not** been validated at scale by real generation.
- `references/片源筛选.md` is a one-off sample taken 2026-10-27: links, image quality and
  rights status change over time. Five candidates had no frame thumbnails and stay marked
  unverified rather than guessed.
- The corpus is a 37-row / 21-source seed (3 negative samples) plus 102 variants: the
  one-dimension diff check now passes (0 errors; v4 fixed 21 broken variants), but no row
  carries `verified` yet and six were fetched via `videoshot(aid)` (a fallback for intermittent
  0-frame responses). **Verify every row before training.**

### License

MIT — see [`LICENSE`](LICENSE).
