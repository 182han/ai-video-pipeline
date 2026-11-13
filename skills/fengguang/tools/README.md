# tools · 复现脚本

升级 skill 时用这三个脚本重跑统计，把新数据回填 `references/风格指纹.md`。

## 依赖

- Python 3 + `Pillow` + `numpy`（`analyze_*.py`）
- Node.js 24+（`bilibili_sprite.js` / `check_corpus.js`，仅用内置模块，零依赖）

## 用法

### 1. 静帧 → 指标

```bash
python tools/analyze_stills.py "C:\path\to\照片目录" refs_stats.json
```

自动定位每张图的画面带（行内方差 > 14 的最长连续段），输出每张的
`lum / dark_ratio / highlight_ratio / sat / warm / cool / ar` 与汇总。

### 2. B 站长片 → 抽帧

```bash
node tools/bilibili_sprite.js BV1k9H761ERK BV1ZcaDziE5R --out ./_sprites
```

只调只读接口，不下载完整视频：

- `/x/web-interface/view` 取标题、时长、封面、cid
- `/x/player/videoshot?index=1` 取 10×10 帧网格 jpg

返回体里的 `index[]` 给出**每一格对应的秒数**（不是等间隔，首格常重复）。
核对语料的 `t` 必须用它，不能按"第几格 × 6 秒"估。

**偶发 0 帧**：`videoshot` 有时对 `bvid` 参数返回空（`code` 仍是 0），换 `aid` 就有帧。
实测同一条视频一次 bvid=0 / aid=20，两分钟后 bvid 又正常——所以脚本把 aid 当兜底，
`meta.json` 里的 `frame_source` 记录实际走通的那条路径。

### 3. 帧 → 指标

```bash
python tools/analyze_frames.py ./_sprites --prefix BV1k9H761ERK
```

自动跳过纯黑占位格（`lum < 12`），输出与静帧同一套指标，可直接对比。

### 4. 语料体检

```bash
node tools/check_corpus.js "C:\path\to\corpus.jsonl"                          # 分组报告
node tools/check_corpus.js "C:\path\to\corpus.jsonl" --variants "…\variants.jsonl"  # 连变体
node tools/check_corpus.js "C:\path\to\corpus.jsonl" --json                   # 机器可读
```

查必填字段、枚举、id / prompt 重复、`t` 格式、`overlay` 缺 note、
缺 `verified`、负样本标记、aurora 字段、禁用词（含**分辨率 / 配乐 / 音效**）、
高光控制、结尾锁死、运镜双主轴。带 `--variants` 时再查：`variant_of` 是否存在、
`changed` 是否合法、**除声明维度外是否逐字节一致**、`camera` 的「焦段 / 运镜」有没有越界、
变体 id 是否 `<base>-vN`。退出码 0 = 无结构错误。规则见 `references/语料规范.md`。

## 盲测回归（blindtest/）

```bash
node tools/blindtest/score.mjs --with <with-skill.jsonl> --without <no-skill.jsonl> \
  --baseline tools/blindtest/baseline.json
```

8 条固定口语需求（`requests.json`），两份候选各 8 行 `{id,prompt}`。零依赖，自动查：
高光控制、结尾锁句、单条镜头轴、极光主语（h1/h2/h5）+ 禁用词；满分 27。
低于基线（2026-10-27：`with 27 / without 5 / gap 22`）→ `exit 1`，可直接进 CI。
流程见 `blindtest/RUNBOOK.md`——两个全新 agent，一个读 skill、一个不读，不许看语料。

## 指标口径

| 指标 | 定义 |
|---|---|
| `lum` | `0.2126R + 0.7152G + 0.0722B` 的均值 |
| `dark` / `dark_ratio` | 亮度 < 40 的像素占比 |
| `hl` / `highlight_ratio` | 亮度 > 200 的像素占比 |
| `sat` | `(max−min)/max` 均值（HSV 式饱和度） |
| `warm` | `R > B+15 且 R > G+10` 的占比 |
| `cool` | `B > R+15` 的占比 |

## 注意

- 这些脚本**只做测量**，不下载完整视频、不绕过任何鉴权。
- `analyze_frames.py` 假设 sprite 是 10×10 网格；若平台改动，改 `GRID` 常量。
- 静帧若是全黑或大面积同一色，行方差法可能定位失败，会被计入 `skipped`。
