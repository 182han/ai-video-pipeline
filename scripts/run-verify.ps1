# ==========================================
# 一键跑全部验收套件（Windows / PowerShell）
# ==========================================
#
# 为什么需要这个脚本：本机沙箱下 ffmpeg **不能**往系统 %TEMP% 写文件（Node 能写、ffmpeg 写会 EACCES），
# 而 scripts/ 里有 36 处使用 os.tmpdir()，凡是「让 ffmpeg 往临时目录写媒体」的套件都会假红。
# 实测：把 TEMP/TMP 指到工作区内，verify-color-match 24/0、verify-loop 29/0 立刻转绿。
#
# 用法：
#   powershell -NoProfile -File scripts/run-verify.ps1          # 跑全部（默认跳过需要登录态的 4 个）
#   pwsh -File scripts/run-verify.ps1                           # PowerShell 7 同样可用
#   powershell -File scripts/run-verify.ps1 -Only auth,loop
#   powershell -File scripts/run-verify.ps1 -Fast               # 只跑纯逻辑/静态组
#
# 输出：逐个套件的通过数/失败数/耗时 + 末尾汇总表；有失败则退出码 1。

param(
  [string]$Only = '',
  [switch]$Fast
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 1) 把临时目录重定向到工作区（gitignore，安全）
$tmpRoot = Join-Path $root 'data\tmp\sys'
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
$env:TEMP = $tmpRoot
$env:TMP  = $tmpRoot
Write-Host "临时目录已重定向: $tmpRoot" -ForegroundColor Cyan

# 2) 收集套件
$all = Get-ChildItem (Join-Path $root 'scripts') -Filter 'verify-*.js' |
  Where-Object { $_.Name -ne 'verify-all.js' } |
  Select-Object -ExpandProperty Name

# 这些需要「已登录的运行中 3001」或会改真实状态，默认跳过（不是坏了）
$manual = @('verify-bgm-api.js', 'verify-bgm-e2e2.js', 'verify-bgm-negative.js', 'verify-port3001.js')
$all = $all | Where-Object { $manual -notcontains $_ }

if ($Only) {
  $want = $Only.Split(',') | ForEach-Object { $_.Trim() }
  $all = $all | Where-Object { $n = $_ -replace '^verify-', '' -replace '\.js$', ''; $want -contains $n }
}

if ($Fast) {
  # 纯逻辑/静态组：名字里不含需要真 ffmpeg 长跑的
  $slow = @('verify-loop.js', 'verify-transitions.js', 'verify-seam-qc.js', 'verify-stage-pipeline.js',
            'verify-continue.js', 'verify-editor-export.js', 'verify-stages.js', 'verify-adjust-pipeline.js')
  $all = $all | Where-Object { $slow -notcontains $_ }
}

Write-Host ("待跑套件: {0} 个" -f $all.Count) -ForegroundColor Cyan

# 3) 逐个跑
$results = @()
$i = 0
foreach ($name in $all) {
  $i++
  $path = Join-Path $root (Join-Path 'scripts' $name)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & node $path 2>&1 | Out-String
  $code = $LASTEXITCODE
  $sw.Stop()

  $summary = ($out -split "`r?`n" | Where-Object { $_ -match '通过|失败|结果|passed|failed' } | Select-Object -Last 1)
  if (-not $summary) { $summary = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) }
  $summary = ($summary -replace '\s+', ' ').Trim()
  if ($summary.Length -gt 70) { $summary = $summary.Substring(0, 70) + '…' }

  $status = if ($code -eq 0) { 'PASS' } else { 'FAIL' }
  $color = if ($code -eq 0) { 'Green' } else { 'Red' }
  Write-Host ("[{0,2}/{1}] {2,-6} {3,-38} {4,5:N1}s  {5}" -f $i, $all.Count, $status, $name, $sw.Elapsed.TotalSeconds, $summary) -ForegroundColor $color

  $results += [pscustomobject]@{ Suite = $name; Status = $status; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); Summary = $summary }
}

# 4) 汇总
$pass = @($results | Where-Object Status -eq 'PASS').Count
$fail = @($results | Where-Object Status -eq 'FAIL').Count
$totalSec = ($results | Measure-Object -Property Seconds -Sum).Sum

Write-Host "`n================ 汇总 ================" -ForegroundColor Cyan
Write-Host ("通过 {0} / 失败 {1} / 共 {2} 个套件，总耗时 {3:N0}s" -f $pass, $fail, $results.Count, $totalSec)
if ($fail -gt 0) {
  Write-Host "失败清单:" -ForegroundColor Red
  $results | Where-Object Status -eq 'FAIL' | ForEach-Object { Write-Host ("  - {0}  {1}" -f $_.Suite, $_.Summary) -ForegroundColor Red }
}
if ($manual) { Write-Host ("已跳过（需登录态/运行中服务）: {0}" -f ($manual -join ', ')) -ForegroundColor DarkGray }
Write-Host "====================================="

if ($fail -gt 0) { exit 1 } else { exit 0 }
