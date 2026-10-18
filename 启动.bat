@echo off
chcp 65001 >nul
title AI长视频自动生成流水线

echo.
echo ========================================
echo   🎬 AI 长视频自动生成流水线
echo ========================================
echo.

REM 切换到脚本所在目录
cd /d "%~dp0"

REM 1. 设置 Node.js 路径
set NODE_DIR=%APPDATA%\TRAE SOLO CN\ModularData\ai-agent\vm\tools\node
if exist "%NODE_DIR%\node.exe" (
    echo ✅  找到 Node.js
    path %NODE_DIR%;%PATH%
) else (
    echo ⚠️   没找到 Node.js 默认路径，尝试系统 PATH...
    where node >nul 2>nul
    if errorlevel 1 (
        echo ❌  未检测到 Node.js，请先安装
        echo.
        pause
        exit /b 1
    )
)

REM 显示版本
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo    版本: %NODE_VER%
echo.

REM 2. 检查 FFmpeg
if exist "config.js" (
    echo ✅  配置文件已就绪
    echo    FFmpeg 路径在 config.js 中配置
) else (
    echo ⚠️  未找到 config.js
)
echo.

REM 3. 检查依赖
if not exist "node_modules" (
    echo 📦 正在安装依赖（第一次需要1-2分钟）...
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo ❌  依赖安装失败
        echo.
        pause
        exit /b 1
    )
    echo.
    echo ✅  依赖安装完成
    echo.
) else (
    echo ✅  依赖已安装
    echo.
)

REM 4. 启动服务
echo 🚀  启动服务中...
echo    访问地址: http://localhost:3001
echo.
echo    按 Ctrl+C 停止服务
echo ========================================
echo.

start "" http://localhost:3001

node server.js

if errorlevel 1 (
    echo.
    echo ❌  启动失败，请检查错误信息
    echo.
    pause
)
