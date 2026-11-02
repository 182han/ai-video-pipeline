# 剪映「调节」模块逆向（2026-10-27 取证）

> 目标：把剪映的「调节」（亮度/对比度/饱和度/色温/色调/高光/阴影/锐化/褪色/暗角/颗粒/HSL）
> 复刻进本项目的剪辑模块。
> 状态：**取证完成，未写任何集成代码**。证据来源：`D:\JianyingPro\11.6.0.14552` 与
> `%LOCALAPPDATA%\JianyingPro\User Data\Resources\DefaultAdjustBundle`（全程只读）。

---

## 1. 一句话结论

剪映的「调节」不是一堆公式，而是**每个滑杆一张 17³ 3D LUT**（烘焙成 289×34 PNG 塞在
Laya `.texture` 容器里），shader 统一做 `out = mix(原色, LUT(原色), |intensity|)`。
**LUT 就在本地、可完整取出**，所以亮度/对比度/饱和度/色温/色调/高光/阴影这 7 项可以
**逐值精确复刻**（17³ 量化，与剪映同精度），落到 ffmpeg 就是 `lut3d`。

---

## 2. 参数清单与实现方式（实测分类）

| 滑杆 | 资源目录 | 实现 | 复刻难度 |
|---|---|---|---|
| 亮度 | `brightness` | LUT 289×34（负/正两半） | 精确 |
| 对比度 | `contrast` | LUT 289×34 | 精确 |
| 饱和度 | `saturation` | LUT 289×34 | 精确 |
| 色温 | `temperature` | LUT 289×34 | 精确 |
| 色调 | `tone` | LUT 289×34 | 精确 |
| 高光 | `highlight` | LUT **289×17（单向）** | 精确 |
| 阴影 | `shadow` | LUT **289×17（单向）** | 精确 |
| 褪色 | `fade` | LUT（`fade_max.texture`，单半） | 精确 |
| HSL | `hsl` | **公式**：8 个色相带，权重/系数全部可读 | 可烘焙成 LUT 精确 |
| 黑白 | `black_white` | 公式：`c*Slope + Bias` | 精确 |
| 锐化 | `sharpen` | **5 点卷积**（精确公式，见 §4） | 近似（ffmpeg `unsharp`） |
| 暗角 | `vignetting` | 纹理 `Bow0.texture` 做 multiply 混合 | 近似（ffmpeg `vignette`） |
| 颗粒 | `particle` | 程序化噪声（grain 纹理 + 亮度掩膜） | 近似（ffmpeg `noise`） |

**另有 8 类「AI 调节」**（`videoeditor.dll` 里的 `adjust_type` 枚举，本地无资源包）：
`color_dehaze` 去雾 / `backlight_correction` 背光 / `restore_detail` 细节修复 /
`color_levels` 色阶 / `natural_saturation` 自然饱和 / `skin_tone_correction` 肤色 /
`smart_color` 智能调色 / `color_soften` 柔化。**这部分不复刻**（需要云端资源与算法）。

---

## 3. 通用 shader（7 个 LUT 项共用）

```glsl
float slider_progress = abs(intensity);
vec4 curColor = texture2D(uSampler, uv0);
vec4 newColor1 = texture2D(uAlbedo, vec2(texPos1.x, texPos1.y*0.5) + vec2(0.0, step(0.0,intensity)*0.5));
vec4 newColor2 = texture2D(uAlbedo, vec2(texPos2.x, texPos2.y*0.5) + vec2(0.0, step(0.0,intensity)*0.5));
vec4 newColor  = mix(newColor1, newColor2, fract(blueColor));
newColor = mix(curColor, newColor, slider_progress);
```

含义：
- `intensity ∈ [-1,1]`，**符号选半张 LUT**（上半=负向、下半=正向），绝对值=效果强度（线性淡入）；
- LUT 布局：`x = blueSlice*17 + redIndex`，`y = greenIndex`（正向再加 17）；
- 所以**强度是线性的**：+50% 等于「LUT 结果与原始图各半」。

实测（`proto/adjust-lut-probe.mjs`）：中灰 `(128,128,128)`
- brightness 负半 → `60,60,60`，正半 → `216,216,216`
- temperature 负半 → `109,137,177`（偏冷），正半 → `177,155,122`（偏暖）
- saturation 两半中灰都 → `128,128,128`（灰色不变，符合预期）

---

## 4. 公式类：可直接移植

**锐化**（`sharpen/gles2_filter.frag`，5 点，非 LUT）：
```glsl
f  = ((|i|*4) * ((1-f2)*0.65 + f2*1.2)) + 1.0;   // f2 = clamp((max(W,H)-1000)/2000, 0, 1)
f3 = (1-f) * 0.25;
out = f*中心 + f3*(左+右+上+下)
```
→ ffmpeg 用 `unsharp=lx=1:ly=1` 近似；要精确得自己写卷积或用 `convolution` 滤镜。

**HSL**：8 个色相带（红/橙/黄/绿/青/蓝/紫/品红），每带有 `(色相, 饱和, 明度)` 三参数，
权重 `fAlpha = 1 - |currHue - standHue|/deltaRange`；系数 `LV_ColorType` 决定
色相×0.3/×0.7+10、饱和 ×1/×1.2 等。→ 公式完整可读，可离线烘焙成 17³ LUT。

**暗角**：不是径向公式，而是拿 `Bow0.texture` 当遮罩做 `multiply` 混合（`blendFunc(...,15)`），
`intensity` 同时缩放纹理和透明度。→ ffmpeg `vignette` 只能近似。

**颗粒**：`grain_texture` 采样 + 依亮度分段的掩膜（暗部/亮部不同曲线），
`ratio` 控制混合强度。→ ffmpeg `noise` 近似。

---

## 5. 实际复刻路径（推荐）

```
.texture 容器
  └─ 找 PNG 签名(89504E47...) → 截到 IEND → 得到 289×34 RGB PNG
       └─ 解码 → 还原两张 17³ LUT
            └─ 按滑杆值生成 .cube：out = (1-|s|)*in + |s|*LUT_half(in)
                 └─ ffmpeg -vf lut3d=xxx.cube
```

- 「按滑杆值生成 .cube」这步等于把 shader 的 `mix` 提前算进 LUT，**一次滤镜搞定，零额外开销**。
- 公式类（HSL/黑白）用同一套：在 17³ 网格上算一遍公式 → 同格式 .cube。
- 空间类（锐化/暗角/颗粒）单独用 ffmpeg 滤镜近似，不进 LUT。

---

## 6. 未知 / 需用户配合

| 未知 | 影响 | 怎么解决 |
|---|---|---|
| **滑杆数值区间与默认**（剪映面板是 -50~50 还是 -100~100） | 决定 `s = value/max` 的映射 | 看你面板截图，或你告知 |
| **多个滑杆的叠加顺序** | 像素级操作不可交换，顺序影响结果 | 剪映面板顺序（大概率 亮度→对比度→饱和→色温→色调→高光→阴影→锐化→褪色→颗粒→暗角→HSL），需确认 |
| 是否在 sRGB/线性空间 | 影响暗部过渡 | 对照导出才能确认 |
| 高光/阴影只有单向 LUT | 负值行为存疑（shader 里符号不参与） | 用剪映导出 -50 的对照看是否变了 |

**最高标准所需要的配合（关键）**：
1. 用剪映导出**同一段 3 秒素材**的「无调节」和「每项 ±50」对照片（约 8 个文件）。
   → 我们可以做像素级对标（PSNR/ΔE），而不是只靠公式推断「应该一致」。
2. 一张「调节」面板截图（确认有哪些滑杆、数值范围、是否有 HSL/曲线）。
3. 告诉我目标是**观感接近**还是**数值一致**——后者必须做第 1 条的对照。

---

## 7. 待你确认的集成形态

| 方案 | 预览 | 导出 | 性能 | 复杂度 |
|---|---|---|---|---|
| A. 导出时套用（推荐先做） | 面板只存参数，预览用 CSS filter 粗略示意 | ffmpeg `lut3d` 链 | 导出多一层滤镜，几乎无感 | 低 |
| B. 预览也实时 | 需低分辨率代理 + 逐帧 LUT | 同 A | 预览会掉帧，要加代理缓存 | 高 |
| C. 只做「自动匹配」 | 无面板 | 复用现有 colorMatch | — | 与本次无关 |

建议：**先 A，把 7 个 LUT 项跑通**；空间类（锐化/暗角/颗粒）第二批。

---

## 8. 证据位置

- 资源：`%LOCALAPPDATA%\JianyingPro\User Data\Resources\DefaultAdjustBundle\`
  （`brightness` / `contrast` / `saturation` / `temperature` / `tone` / `highlight` /
  `shadow` / `fade` / `hsl` / `sharpen` / `vignetting` / `particle` / `black_white` …）
- 引擎字段：`videoeditor.dll` 中 `adjust_params` / `adjust_type` / `effects_adjust_intensity` /
  `MetaTypeAdjust` / `is_adjust_type`；`adjust_type` 枚举见 §2 末尾。
- 取证脚本：`proto/adjust-lut-probe.mjs`（可复现上面所有数字）

---

## 9. 实测校准（2026-10-30，用户真实导出对照）

用户导出：`Desktop\风景照片\对照\base.mp4`（全 0）与 `bright50.mp4`（仅亮度 +50），
同源 5s 1080p30。另有一组 4 个旧导出可交叉验证。

### 结论 1：亮度 LUT 能复刻，但需要 1.07 的强度标定

| 对比 | PSNR |
|---|---|
| base vs bright50（基线） | 10.17 dB |
| 我的 `brightness+50.cube` vs bright50（k=1.00） | **31.91 dB** |
| 我的 `brightness+50.cube` vs bright50（k=1.07） | **36.11 dB** |

逐亮度桶差值（k=1.00）：中间调普遍偏暗 3~8/255，亮部收敛到 0 —— 是**系统性偏弱**，
不是形状错。线性补偿 `mix(base, LUT, k)` 取 k=1.07 后残差最小。

**含义**：`intensity = (滑杆值/50) × k_param`，亮度 k≈1.07。k 不是全局常数（见结论 3），
所以每个滑杆都要单独标定。

### 结论 2：饱和度 LUT 也被真实导出验证过

旧导出 `10月28日 (1)(2).mp4` 的饱和度是 0.524，而 `base.mp4` 是 0.324。
用我的 `saturation-40.cube` 作用在该片上，饱和度落到 **0.324**（与 base 完全一致），
PSNR 26.94 dB。说明 LUT 提取与 mix 语义正确。

### 结论 3：k 因滑杆而异（不能用一个全局系数）

| 案例 | 最佳 k | PSNR |
|---|---|---|
| 亮度 | 1.07 | 36.11 dB |
| 饱和度（反推） | 0.90 | 27.18 dB |

### 结论 4：`base.mp4` 已确认是「未调节」基准

`base.mp4` 与旧导出 `A`（`10月28日 (1).mp4`）SSIM 0.991、均值/饱和度完全相同（135.5 / 0.324），
可作基准。旧导出 `C`（`10月28日 (1)(2).mp4`）饱和度 0.524，是**加过饱和度**的版本。

### 因此「完全一致」的真实上限

- 不能做到 bit-exact：剪映有独立色彩管线 + H.264 量化，PSNR 无限大不现实。
- 可达到的是 **PSNR ≈ 36 dB / SSIM > 0.99**（肉眼不可分辨），前提是逐滑杆标定 k。
- 若坚持更高精度，需要对每个滑杆各提供一对导出（base + 单项 ±50），16 项 = 16 对。

### 待办（按优先级）

1. 用户每提供一个滑杆的对照对 → 拟合该滑杆的 k，补进标定表。
2. 标定表稳定后，接入 `lut3d` 链（导出时套用，默认关）。
3. 曲线 / 色轮：结构已确认，等基础项闭环后做。

---

## 10. 亮度实现已定位（2026-10-30，三家实现拟合）

剪映有 **三套亮度实现**，必须选对：

| 版本 | 位置 | 实现 |
|---|---|---|
| v0 | `brightness/…/brightness.texture` | 17³ LUT（289×34，正负两半） |
| v1 | `brightness_v1/…/brightness_max.png` + `_min.png` | 两张 LUT，按 intensity 符号选 |
| **v2** | `brightness_v2/…/brightness.frag` | **公式**：`y = 1-(1-x)^p`，正向 `p = 1+5·param`；负向 `p = 1/(1-param·2.5)` + 小偏移 |

用用户的 `base.mp4` / `bright50.mp4` 逐像素拟合（`W=480`，`-1 帧`对齐）：

| 实现 | 最佳参数 | PSNR |
|---|---|---|
| v0/v1 LUT + 强度 k | k=1.06 | 34.45 dB |
| **v2 公式** | **p=3.0**（= param 0.4） | **36.09 dB** |

→ **面板用的是 v2 公式**，且 `滑块50 → param≈0.4`，即 `param = 值 × 0.008`、`p = 1 + 0.04×值`。

### 残差来源已排除到「运动 + 编码」

同一帧分区域比较（p=3.0）：

| 区域 | PSNR |
|---|---|
| 整帧 | 37.7 dB |
| **天空（静止）** | **41.8 dB** |
| 浪花（运动） | 33.2 dB |

色度通道 U/V 达 **46.8 / 47.3 dB**，亮度误差均匀分布在各亮度带（平均 1.7~3.1/255），
最大误差集中在运动区域。整帧重编码地板实测 44~47 dB。

**结论：亮度模型已复刻（静态区 41.8 dB，逼近编码地板），残差来自水波运动与编码差异，不是公式错。**

### 由此得到的通用方法（对剩余滑杆同样适用）

1. 先从 `*_v2` / `*_v3` 的 `.frag` 里找公式版（剪映新版走公式，不走老 LUT）；
2. 用一对 `base` / `单项±50` 拟合公式参数或 LUT 强度；
3. 只比**静止区域**，避免运动污染；同时报 Y/U/V 分通道，确认残差不在色度。

---

## 11. 六项对照拟合结果（2026-10-31，用户补齐 6 对导出）

对照文件：`Desktop\风景照片\对照\{base,bright50,sat50,con50,temp50,tone50,shadow50,light50}.mp4`。
方法：`base` 帧（t=2.5）→ 应用各滑杆的**本地 LUT（满强度）**→ 线性混合系数 k 网格搜索；
目标帧取 `t−1/30`（实测两导出差 1 帧），比较整帧与天空区。

| 目标 | 最佳 k | 整帧 PSNR | 天空区 PSNR | 判断 |
|---|---|---|---|---|
| bright50 | 1.08 | 35.36 | 36.43 | ✅ 可用（公式版 p=3.0，见 §10） |
| con50 | 1.46 | 28.65 | **35.89** | ⚠️ k 明显偏离 1 → 面板走 `contrast_v3`（`colorAdjust.frag` 8KB + `Utils.lua` 10KB），LUT 是老版 |
| sat50 | 0.96 | 25.62 | 28.61 | ⚠️ 形状接近但残差大 → 可能是 `saturation_v1` 公式版 |
| tone50 | 1.36 | 30.79 | 28.98 | ⚠️ k 偏离 → `temperature_tone_v3`（`Lscript.lua` 8KB，颜色矩阵） |
| temp50 | 1.32 | **12.12** | 9.94 | ❌ 完全不同实现（v3 矩阵），LUT 版不可用 |
| shadow50 | 1.50 | 22.89 | 24.54 | ⚠️ → `shadow_highlight_v3`（`ScriptComp.lua` + 幂函数公式） |
| light50（光感） | gamma g=0.52 | 24.45 | 28.12 | 旧结论作废，见 §12：LUT 在 contrast_v3 里，可精确复刻 |

### 结论

- **老 LUT 包（v0/v1）只对得上「亮度」**；其余滑杆在 11.6 里已经换成 v3 公式实现。
- 要"完全一致"，必须移植 v3 公式：
  - 对比度 → `contrast_v3/AmazingFeature/xshader/colorAdjust.frag` + `lua/Utils.lua`
  - 色温/色调 → `temperature_tone_v3/AmazingFeature/lua/Lscript.lua`（生成 3×3 矩阵）
  - 高光/阴影 → `shadow_highlight_v3_gles3/AmazingFeature/xshader/HighlightShadow.frag` + `ScriptComp.lua`
  - 饱和度 → `saturation_v1/quad.frag`（`sat` 参数）
- **光感** 的 LUT 不在 `light_sensation`，而在 `contrast_v3/AmazingFeature/image/lightSensation_{min,max}.png`；可精确复刻（见 §12）。

### 12. 模型拟合进展（2026-10-31 晚）

用用户 10 个对照文件逐项拟合，目前可固化的模型：

| 滑杆 | 模型 | 参数（+50 时） | PSNR |
|---|---|---|---|
| 亮度 | `y = 1-(1-x)^p`，`p = 1 + 0.04×值` | p=3.0 | 35~36（天空 41.8） |
| 饱和度 | `c' = luma + s·(c-luma)`，`s = 1 + 值/50`；luma 用剪映权重 `(0.20854, 0.70209, 0.08937)` | s=2.0 | **40.78** |
| 曲线 | 1D 分桶 LUT（每通道独立，32 段，单调化） | — | **41.75** |
| 对比度 | sigmoid + 端点校正：`res = 1/(1+e^{-xF(x-p)}) + p - 0.5`，按 `scale²·diff` 补左右端点 | xF=10.5, p=0.43 | 34.14 |
| **色温** | 完整 CIE 链移植（Planckian 表 + Bradford 矩阵），`prototype/temperature-tone.mjs` | 滑块 50 → 2776 K | **38.15**（拟合自动落在 50） |
| **色调** | 同上，`ColorTones = intensity*100` | 滑块 50 → tones=100 | **42.05**（拟合自动落在 50） |
| **阴影** | `y = x^a + (a-1)(x²-x³)`，`a = 1 - 0.008×值` | a=0.60 | **44.34** |
| 高光 | `y = 1-(1-x)^a - (a-1)((1-x)²-(1-x)³)`，`a = 1 + 0.008×值`（**推断，无 high50 对照**） | a=1.40 | 未验证 |
| **色轮** | `processWheel`（lift/gamma/gain）+ `LumaMix=1` 亮度守恒，`proto/color-wheel.mjs` | γR=1.43 γG=0.89 γB=0.63 | **38.26** |
| **光感** | `mix(原图, LUT, |param|)`，LUT 是 `contrast_v3/image/lightSensation_{min,max}.png`（**本地就有，不是云端**） | +50 → max LUT，|param|=1.0 | **39.31** |

> **更正（2026-10-31）**：此前以为「光感依赖云端 LUT、无法复刻」是错的。
> 光感的 min/max 两张 LUT 就在 `contrast_v3/AmazingFeature/image/`，实测 +50 用 max LUT 满强度混合，
> PSNR 39.31 dB，与其它滑杆同一精度。

色轮资源定位（重要）：不在 `DefaultAdjustBundle/*/` 的顶层，而在
`merge_all_adjust_color/AmazingFeature_primaryWheel/`（另有 `AmazingFeature_logWheel`）；
uniform 由 `lua/SeekModeScript.lua` 的 `adjustLift/adjustGamma/adjustGain` 换算。

> 色温/色调的滑块映射 `intensity = 值/50` 不是假设：把公式跑遍 −50..50，最优解**正好落在 50**，
> 这是映射正确的独立证据。

对比度公式（来自 `contrast_v3/colorAdjust.frag` 的 `enchanceContrast`）：
```js
pivotSlope = xF * 0.25;
leftSlopeDiff  = pivotSlope - dsig(0);   rightSlopeDiff = pivotSlope - dsig(1);
leftDiff  = 0 - sig(0);                  rightDiff = 1 - sig(1);
res = sig(x) + p - 0.5 + scale² * diff;  // x<=p 用左，x>p 用右
```

**统一 shader 的运算顺序**（同文件 `main()`，集成时必须按此顺序）：
`亮度 → 对比度 → 饱和度 → 高光 → 阴影 → 黑白场(slope/bias) → 光感 → 褪色`
（色温/色调矩阵是另一套 `temperature_tone_v3`，需单独接入）。

### 统一调节链已落地（`proto/adjust-chain.mjs`）

顺序照抄 `colorAdjust.frag` 的 `main()`，函数逐项可单测：

```js
adjustChain(rgb, { temperature, tone, brightness, contrast, saturation,
                   highlight, shadow, white, black,
                   lightSensation, fade, curveLuts, wheelParams })
```

`proto/chain-verify.mjs` 用对照视频跑单滑杆，实测：

| 对照 | chain PSNR |
|---|---|
| shadow50 | 44.80 |
| tone50 | 42.18 |
| sat50 | 41.32 |
| bright50 | 37.31 |
| temp50 | 37.84 |
| con50 | 33.28 |

（亮度首次接入时踩过坑：把 `p = 1+0.04×值` 写成 `1+0.1×值`，PSNR 掉到 17.3，已修正。）

### 仍待完成

| 项 | 状态 |
|---|---|
| 高光 | 公式已移植，**无 high50 对照**，映射 `a = 1+0.008×值` 属推断 |
| 白色 / 黑色 | `slope/bias` 公式已移植，**无对照**，映射是假设（slope=1+白/200, bias=黑×0.003） |
| 褪色 | LUT 已能提取（`fade` 单半），**无 fade50 对照** |
| 锐化 / 清晰 / 颗粒 / 暗角 | 公式已读，属空间/随机类，**无对照**，需在 ffmpeg 侧实现 |
| HSL | 已移植为 `proto/hsl.mjs`（8 色相带、权重照抄 shader），已接入 chain 并通过恒等/区域隔离自测；**无对照** |
| 曲线 | 拟合方式验证过（41.75），但面板任意曲线的参数化未建模 |

### 结论（对「完全一致」的判断）

- 已用真实对照验证的 9 项，PSNR 33~44 dB，其中 7 项 ≥ 37 dB。
- 这些残差**不等于公式错**：同帧重编码地板 44~47 dB，运动区域本身就只有 33 dB。
- 剩下 5 项（高光/白/黑/褪色/锐化类）缺对照，属**未验证**，不能声称一致；HSL 已实现但同样缺对照。

---

## 13. 端到端链路验证（2026-10-31，chain → .cube → ffmpeg）

`proto/adjust-ffmpeg.mjs` 把调节链烘焙成 17³ `.cube`，`ffmpeg-bridge-verify.mjs` 跑完整链路
（base.mp4 → 套 cube 重编码 → 与真实导出逐帧比，W=480，−1 帧对齐）：

| 对照 | JS 链 PSNR | **ffmpeg 链路 PSNR** |
|---|---|---|
| temp50 | 37.84 | **41.71** |
| bright50 | 37.31 | **41.13** |
| tone50 | 42.18 | **41.10** |
| con50 | 33.28 | **40.45**（+7.2，编解码不对称被抵消） |
| sat50 | 41.32 | 40.36 |
| shadow50 | 44.80 | 42.22 |

**7 项 ≥ 40 dB**，色轮 36.05（参数是在未编码帧上拟合的，未针对编码路径重拟合）：

| 对照 | ffmpeg 链路 PSNR | 说明 |
|---|---|---|
| temp50 | 41.71 | |
| bright50 | 41.13 | |
| tone50 | 41.10 | |
| light50 | 40.95 | 光感 LUT 已接入烘焙链 |
| con50 | 40.45 | 对比度提升最明显（33.28 → 40.45） |
| sat50 | 40.36 | |
| shadow50 | 42.22 | |
| wheel-blue | 36.05 | 色轮 γ 参数在未编码帧拟合，可再优化 |

对比度的大幅提升（33.28 → 40.45）证明此前低分主要来自编解码不对称，不是公式错。

**解读**：ffmpeg 链路和真实导出都经过一次 H.264 编解码，噪声两端共享，所以亮度/色温反而更高。
这说明此前 33~37 dB 的残差有相当一部分是**编解码不对称**，不是公式错。

集成形态确定：
- 点式运算 → 烘焙 3D LUT → `lut3d`
- 空间/随机运算（锐化/清晰/颗粒/暗角）→ `unsharp` / `noise` / `vignette`
- 两者由 `buildFilter()` 拼成一条 `-vf`
---

## 14. 参数映射的权威来源（2026-10-31，重大修正）

此前高光/白色/黑色/对比度的映射是**拟合或推断**。找到了引擎的真实换算脚本：

`DefaultAdjustBundle/combine_adjust/AmazingFeature/lua/SeekModeScript.lua`（18 KB）
（`FC/AmazingFeature_adjustColor`、`merge_all_adjust_color/AmazingFeature_adjustColor` 有同款副本）

| 参数 | 引擎公式（原文） | 说明 |
|---|---|---|
| 饱和度 | `getSaturationParam(I) = I + 1.0` | I = 滑块/50 |
| 亮度 | `I∈(0,0.7]: 0.3I`；`(0.7,1]: 0.6333I-0.2333`；负值原样 | +50 → 0.4 → p=3.0（与实测吻合） |
| 对比度 | `param = 1 + 0.6I`（正）/ `1 + 0.4I`（负）；`xFactor = exp(8.33·param - 12.16) + 5.82·param - 1.72` | **ContrastPivot = 0.435**（我们拟合出 0.43，独立吻合） |
| 高光 | `a = 1 + 0.503p + 0.183p² + 0.147p³ + 0.067p⁴` | +50 → **1.9**（此前按对称性猜 1.4，**是错的**） |
| 阴影 | `a = 1 - 0.503p + 0.183p² - 0.147p³ + 0.067p⁴` | +50 → 0.6（与实测吻合） |
| 白色/黑色 | 黑白控制点 `(xw,yw)/(xb,yb)`，`MAX_RANGE=0.5`，`EPS=0.005`，求 `slope/bias` | 非线性，不是简单增益 |
| 光感 | `u_lightSensationParam = I`（clamp ±1） | |
| 褪色 | `u_fadeParam = clamp(I, 0, 1)` | **负值被钳到 0**（褪色只增不减） |

`app/src/processors/adjustChain.js` 已全部换成上述精确公式。

**代价**：对比度 +50 的端到端 PSNR 由之前的拟合版 40.45 变为 **38.09**（拟合版只在 +50 附近最优，
精确版对任意滑块值都成立）。选精确版。
---

## 15. 自研 LUT（替换剪映资源）+ 运行时自检（2026-11-02）

### 15.1 为什么做

原方案把剪映的 3 个资源文件（`lightSensation_{max,min}.png`、`fade_max.texture`）复制进
`app/assets/adjust/`，内部可用但**对外分发有授权风险**。改为自研等效物。

### 15.2 自研 LUT 的探索过程（实测数据）

以 `base.mp4` → `light50.mp4` 为训练对（5 帧、约 52 万采样点）：

| 模型 | 训练集 PSNR | 端到端 PSNR |
|---|---|---|
| 逐通道 1D 曲线（256 桶） | — | 29.77 dB |
| 亮度曲线 + 色度增益（两条曲线） | — | 28.88 dB |
| 17³ 稀疏 3D LUT（加权平均 + 残差场插值） | 37.57 | 37.0 dB |
| **33³ 稀疏 3D LUT（同上）** | 38.66 | **38.5 dB** |

结论：光感是**强三位相关**的变换，1D/亮度模型不够；33³ 是性价比拐点。
生成器：`app/scripts/build-adjust-lut.js`（纯采样拟合，不读取剪映文件）。

### 15.3 最终实现与代价

- `assets/adjust/lightSensation_max.cube`：33³，由 `base`/`light50` 拟合生成
- `assets/adjust/lightSensation_min.cube`：由 max **镜像近似**（`min(x) = 1 - max(1-x)`），
  无对照素材，属**未验证**的近似
- **褪色**：改为自研公式（黑场上抬 + 轻微去饱和），不再依赖剪映 `.texture`，**未验证**
- 已删除 3 个剪映文件；`adjustChain` 新增 `loadCube()`，`prepareAdjust` 优先 `.cube`

**实测（整条链路：参数 → cube → ffmpeg）**：

| 资源 | 与剪映 light50 对比 |
|---|---|
| 剪映原 LUT（17³ PNG） | 40.95 dB |
| **自研 33³ cube** | **38.0 / 38.4 / 37.6 dB**（t=1 / 2.5 / 4） |

代价约 **2.5 dB**（肉眼难辨），换取零版权风险。

### 15.4 运行时自检（防「静默不调色」）

新增 `pipeline._assertAdjustApplied(taskId, task)`，在两处转码成功后调用：

```
任务带 adjust 但 task.adjustApplied 缺失
  → 记录 transcoding 步骤 failed
  → 抛错「调节未执行：任务请求了 adjust，但转码时没有生成调节滤镜」
```

负向验证（`verify-adjust-pipeline.js` 用例 E）：强制让 `_adjustOptionsFor` 返回空，
实测任务 `status=failed`，`steps.transcoding.error` 含「调节未执行」。

### 15.5 回归

11 个套件全部 EXIT=0（stages 45 / frontend-static 43 / stats 42 / pipeline-fixes 28 /
mock-vqc 14 / skill-prompt 109 / skill-ai-path 17 / stage-pipeline 37 / adjust-chain 13 /
adjust-pipeline 12 / transition-ui 22）。