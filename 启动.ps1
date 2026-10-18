# AI Video Studio - Startup Script
# 双击桌面快捷方式运行此脚本启动服务

$ErrorActionPreference = "Stop"

# 设置工作目录
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  AI Video Studio" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 查找 Node.js
$nodePaths = @(
    "C:\Users\14872\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\vm\tools\node\node.exe",
    "node"
)

$nodeExe = $null
foreach ($p in $nodePaths) {
    if ($p -eq "node") {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd) {
            $nodeExe = "node"
            break
        }
    } elseif (Test-Path $p) {
        $nodeExe = $p
        break
    }
}

if (-not $nodeExe) {
    Write-Host "[ERROR] Node.js not found!" -ForegroundColor Red
    Write-Host "Please install Node.js first." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[1/3] Node.js found: $nodeExe" -ForegroundColor Green

# 检查服务是否已在运行
$portInUse = netstat -ano | Select-String ":3001\s" | Select-String "LISTENING"
if ($portInUse) {
    Write-Host "[2/3] Server is already running on port 3001" -ForegroundColor Yellow
} else {
    Write-Host "[2/3] Starting server..." -ForegroundColor Green
    
    # 启动服务（后台运行）
    $startArgs = @("server.js")
    $env:Path = (Split-Path $nodeExe -Parent) + ";" + $env:Path
    Start-Process -FilePath $nodeExe -ArgumentList $startArgs -WorkingDirectory $scriptPath -WindowStyle Hidden
    
    # 等待服务启动
    Write-Host "      Waiting for server to start..." -ForegroundColor Gray
    $maxWait = 20
    $waited = 0
    while ($waited -lt $maxWait) {
        Start-Sleep -Seconds 1
        $waited++
        $check = netstat -ano | Select-String ":3001\s" | Select-String "LISTENING"
        if ($check) {
            Write-Host "      Server started in $waited seconds" -ForegroundColor Green
            break
        }
    }
    
    if ($waited -ge $maxWait) {
        Write-Host "      Server may still be starting..." -ForegroundColor Yellow
    }
}

# 打开浏览器
Write-Host "[3/3] Opening browser..." -ForegroundColor Green
Start-Process "http://localhost:3001"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Ready! Visit: http://localhost:3001" -ForegroundColor Green
Write-Host "  Closing this window won't stop the server." -ForegroundColor Gray
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Start-Sleep -Seconds 2
