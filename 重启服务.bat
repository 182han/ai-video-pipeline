@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  Request administrator privileges (needed to kill a
::  higher-privilege leftover node.exe that still holds port 3001)
:: ============================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title AI Video Pipeline - Server
cd /d "%~dp0"

echo ================================================
echo   AI Video Pipeline - Launcher (Administrator)
echo ================================================
echo.

echo [1/4] Stopping old node.exe ...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo       done
echo.

echo [2/4] Checking port 3001 ...
set TARGET=3001
set PORT_BUSY=0
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 set PORT_BUSY=1

if "!PORT_BUSY!"=="1" (
    echo       Port 3001 is STILL busy even as administrator.
    echo       Falling back to port 3002.
    echo       ^(Open Task Manager, find the process on 3001,
    echo        end it, then run this script again.^)
    set TARGET=3002
) else (
    echo       Port 3001 is free.
)
echo.

echo [3/4] Starting server on port !TARGET! ...
set PORT=!TARGET!
set QC_NSFW_ALLOW_UNCONFIGURED=1
echo.

echo [4/4] Opening browser ...
echo.
echo   ==========================================
echo    URL : http://localhost:!TARGET!
echo.
echo    KEEP THIS WINDOW OPEN.
echo    Closing it stops the server.
echo   ==========================================
echo.

start "" "http://localhost:!TARGET!"
node server.js

echo.
echo Server exited. Press any key to close.
pause >nul
