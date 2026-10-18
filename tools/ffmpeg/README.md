# 项目内自带 ffmpeg

`bin/` 目录放的是 **ffmpeg 8.1 full build（gyan.dev，Windows x64 静态构建）**，
`config.js` 会自动优先使用它，**不需要把它加进系统 PATH**。

```
tools/ffmpeg/bin/
├── ffmpeg.exe    (~213 MB)
├── ffprobe.exe   (~213 MB)
└── ffplay.exe    (~215 MB)   ← 可选，仅手动调试用
```

## 为什么放在项目里

- 不依赖开发者机器上装没装 ffmpeg，克隆下来就能跑
- 不污染系统 PATH，多个项目可以用不同版本
- 之前项目里 ffmpeg 不在 PATH、`.env` 又留空，导致 `qualityChecker` 的
  `_hasFFmpeg()` 恒为 false，**四道质检关卡全部静默跳过并返回 pass**
  （见 `src/qualityChecker.js` 的 `skipped` 语义）。自包含可以根除这类问题。

## 二进制不进 Git

`.gitignore` 已排除 `bin/*.exe`（约 640MB）。新机器拉取后按下面任一方式恢复。

## 恢复方式

### 方式 A：从已装好的机器复制

```powershell
Copy-Item "<源目录>\ffmpeg.exe","<源目录>\ffprobe.exe" .\tools\ffmpeg\bin\
```

### 方式 B：下载官方构建

<https://www.gyan.dev/ffmpeg/builds/> → `ffmpeg-release-full.7z`，
解压后把 `bin\ffmpeg.exe`、`bin\ffprobe.exe` 放进本目录的 `bin\`。

校验是否可用：

```powershell
.\tools\ffmpeg\bin\ffmpeg.exe -version
```

### 方式 C：系统 PATH（Linux / 容器）

`.env` 里 `FFMPEG_PATH` 和 `FFPROBE_PATH` 保持为空，`apt install ffmpeg` 后
`config.js` 会自动回退到 PATH。Dockerfile 走的就是这条。

## 许可证注意

当前这份是 `gyan.dev` 的 **full** 构建，编译参数含 `--enable-gpl`，
因此是 **GPL v3**。

| 使用场景 | 影响 |
|---|---|
| 本地开发 / 内部跑流水线 | 无影响 |
| 把 ffmpeg 打包进对外发布的产品（安装包、镜像分发） | **GPL 有传染性**，需评估开源义务 |

如果将来要做对外分发，换成 LGPL 构建（gyan 的 `essentials` 版是 LGPL，
但不含 `libx264`），或把 ffmpeg 作为**独立进程在运行时调用**（当前代码即如此，
通过 `execSync` 调外部进程，通常不构成链接，但仍建议发布前法务确认）。

## 已知构建能力（用于后续 4K/超分/HDR）

本构建已确认包含：

- 编码器：`libx264`、`libx265`、`libsvtav1`、`h264_nvenc`、`hevc_nvenc`
- 滤镜：`scale`、`scale_cuda`、`zscale`、`tonemap`、`xfade`
- 质检滤镜：`blackdetect`、`blurdetect`、`volumedetect`
- 编译开关：`--enable-cuda-llvm --enable-ffnvcodec --enable-nvdec --enable-nvenc`

即 GPU 缩放/编码能力已在，**但 Real-ESRGAN 超分不在 ffmpeg 里**，
需要另外的 Python + PyTorch 环境（对应《后续目标》的 Python 迁移议题）。
