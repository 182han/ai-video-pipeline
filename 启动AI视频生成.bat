@echo off
title AI Video Studio
cd /d "%~dp0"

echo ==========================================
echo   AI Video Studio
echo ==========================================
echo.

netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo Server already running.
    goto open_browser
)

echo Starting server...
%WINDIR%\System32\wscript.exe "%~dp0start_server.vbs"

echo Waiting for server to start...
set /a count=0
:wait_loop
ping 127.0.0.1 -n 2 >nul
set /a count+=1
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel% equ 0 goto ready
if %count% lss 20 goto wait_loop
goto open_browser

:ready
echo Server ready!

:open_browser
echo Opening browser...
start http://localhost:3000

echo.
echo ==========================================
echo   Done! http://localhost:3000
echo ==========================================
echo.
timeout /t 2 /nobreak >nul