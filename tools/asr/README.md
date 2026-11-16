# 本地语音识别（ASR）：sherpa-onnx + SenseVoice

> 用途：小智对话页的「按住说话 → 转文字」。**完全离线、零 API 费用**。
> 目录约 330 MB，已在 `.gitignore` 排除，换机器按本文恢复。

## 组件与校验

| 组件 | 版本/文件 | SHA256 |
|---|---|---|
| sherpa-onnx CLI（Windows x64） | `sherpa-win/…-win-x64-shared-MD-Release-no-tts/bin/sherpa-onnx-offline.exe` | 包 SHA256 `11fd6a50b97eed38b54fb16d8219f49b16aa7f6a8e43a042316469ef47652e82` |
| SenseVoice int8 模型 | `model-sensevoice-int8/model.int8.onnx`（239,233,841 字节） | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| 单文件包（可删） | `sherpa-onnx-non-streaming-asr-x64-v2.0.1.exe` | `e97000a7305aa305524a36ead628642aa5b2259e5e2c3559dfe8256f9398741c` |

官方校验值来源：<https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.1> 的 `checksum.txt`；
模型哈希来源：HuggingFace 仓库 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` 的 LFS 元数据。

## 许可证

- sherpa-onnx：**Apache-2.0**（<https://github.com/k2-fsa/sherpa-onnx>）
- SenseVoiceSmall（ModelScope `iic/SenseVoiceSmall`）：**Apache-2.0**（模型包内 `LICENSE` 指向 FunASR 仓库）

## 恢复步骤

```powershell
# 1) 下载 Windows 包（本机直连 github.com 超时，用镜像；下载后必须核对上面的 SHA256）
node app\tools\asr\_fetch.js "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MD-Release-no-tts.tar.bz2" "app\tools\asr\sherpa-win-x64.tar.bz2"
tar -xjf app\tools\asr\sherpa-win-x64.tar.bz2 -C app\tools\asr\sherpa-win

# 2) 下载模型三个文件（model.int8.onnx / tokens.txt / LICENSE）到 model-sensevoice-int8\
#    推荐 hf-mirror：https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/<文件名>
```

## 运行（重要：路径不能含中文）

CLI **不认非 ASCII 路径**（本仓库路径含“测试”，会报 `tokens does not exist`）。
生产接入时用 ASCII 的 junction 指向工具目录，再传 junction 路径：

```powershell
$link = Join-Path $env:TEMP "asrlink"
New-Item -ItemType Junction -Path $link -Target "app\tools\asr" -Force
& "$link\sherpa-win\...\bin\sherpa-onnx-offline.exe" `
  --tokens="$link\model-sensevoice-int8\tokens.txt" `
  --sense-voice-model="$link\model-sensevoice-int8\model.int8.onnx" `
  --sense-voice-use-itn=1 --num-threads=1 "$link\model-sensevoice-int8\test_wavs\zh.wav"
```

实测（2026-11-15）：中文样例输出 `开饭时间早上9点至下午5点。`，
`Elapsed 0.346s / 音频 5.592s`（RTF 0.062），进程总耗时 2.64s（含模型加载）。
