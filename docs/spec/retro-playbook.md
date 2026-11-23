# 返工复盘 · 防复发 runbook（retro-playbook）

> 这份文件是**流程**，不是事故记录。事故记录在 `docs/spec/changelog.md`，复盘样例在
> `docs/spec/retro-2026-11-16_23.md`。
> 目的只有一个：**让下一次复盘 5 分钟能跑起来，并且结论能落成可执行的规则/自动化**。

---

## 何时用

- 用户说「复盘最近的 bug / 返工 / 回滚 / 重复修改」「为什么老出同样的问题」；
- 一周/一个里程碑结束；
- **同一症状第 3 次出现**（红线 22）——这是强制触发条件，不是建议。

## 铁律

1. **先量化，再判断**。不要凭记忆列事故，先跑报告；数字与人记忆冲突时以数字为准。
2. **区分症状与根因**。同一文件 24h 内被 fix ≥3 次 = 症状在复发，上一轮没找到根因。
3. **只沉淀能执行的**：规则要带判据与命令；自动化要能跑出退出码；纯文档不算沉淀。
4. **诚实标三态**：通过 / 不通过 / 未验证。跑不了（无浏览器、`spawn EPERM`）就写「未验证」。

---

## 第 1 步：量化（5 分钟）

```powershell
cd "C:\Users\14872\Desktop\测试\app"

# 生成转储（PowerShell 的重定向可能是 UTF-16；脚本会自动识别 BOM）
git -c core.quotepath=false log --since="7 days ago" --pretty=format:"@@%h|%ad|%s" `
  --date=format:"%Y-%m-%d %H:%M" --name-only > $env:TEMP\churn.log

node scripts/report-churn.js --input $env:TEMP\churn.log
node scripts/verify-gate-registry.js
```

看四个数：

| 指标 | 红旗 |
|---|---|
| fix 占比 | > 25% → 本周在还债 |
| 同日反复改（同文件 ≥3 次/天） | 出现即看 |
| 修了又修链（同文件 24h 内连续 fix） | 有 ≥3 次的链 → 必复盘 |
| docs 占比 | > 35% → 交接/文档成本异常，查事实源是否分裂 |

---

## 第 2 步：定根因（每条链只问一句）

对每条「修了又修」链问：**上一轮为什么没找到根因？** 归到 6 类之一：

| 代码 | 根因 | 典型证据 | 预防手段 |
|---|---|---|---|
| R1 | 验证手段缺位 | UI 缺陷全是用户先发现；「未验证」一大堆 | 渲染探针 / 诊断浮层 / 明确标未验证 |
| R2 | 门禁有洞 | 注册了但不传参；断言跟着实现改 | 注册表守卫 + 断言先跑红 |
| R3 | 阈值靠猜 | 硬编码 300s、余量 5%；18 分钟内改 3 次 | 附实测分布（n/均值/σ/max/余量） |
| R4 | 静默失败 | 裸 return、字段不落库、中间态当终态 | 结构化状态 + 不得默认放行 |
| R5 | 事实源分裂 | 两份 changelog 互相缺章 | 单一权威 + 指针文件 |
| R6 | 上下文切换税 | 一周 84 个 docs 提交 / 47 份交接 | 单一事实源 + 一条命令自检 |

证据要具体到 commit / taskId / 时间线 / 实测数值，不要写「感觉最近 bug 多」。

---

## 第 3 步：沉淀（至少一项落到代码）

优先级：**自动化 > 规则 > 文档**。

- 能自动判定的 → 写进 `scripts/verify-*.js`，并**注册进 `verify-all`**
  （或在 `verify-gate-registry.js` 的 `MANUAL` 里写明理由）。
- 无法自动判定的 → 写进 `AGENTS.md` 红线，格式固定：**事故（带证据）+ 判据（可执行）+ 命令**。
- 只有流程性知识 → 写 `docs/spec/`，并在根 `AGENTS.md` 留一行指针，**不要复制两份内容**（红线 15）。

---

## 第 4 步：交付前三件事

```powershell
node scripts/preflight.js            # git + 服务版本 + 注册表 + 英文零中文
node scripts/verify-gate-registry.js # 必须 0 失败
node scripts/report-churn.js --input <转储>   # 报告能跑通
```

交付说明必须给：**改了什么文件、实测命令与输出、哪些未验证**。

---

## 反模式（看到就停）

- 「修了又修」还在交第 3 个补丁 → 停手，先写根因。
- 默认值 300 → 600 → 450 连续调，没有分布依据。
- 改断言让门禁变绿，却不说明旧断言为什么错。
- 报告只列事故、不给根因，也不改任何代码/规则。
- 用「应该可以 / 大概」代替「未验证」。

---

## 参考

- 规则：`AGENTS.md` 红线 22–27
- 复盘样例：`docs/spec/retro-2026-11-16_23.md`
- 工具：`scripts/preflight.js`、`scripts/report-churn.js`、`scripts/verify-gate-registry.js`、`scripts/lib-cjk-scan.js`
