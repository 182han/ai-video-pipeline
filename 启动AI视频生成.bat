@echo off
chcp 65001 >nul
title AI Video Studio
cd /d "%~dp0"

echo ==========================================
echo   AI Video Studio
echo ==========================================
echo.

REM Do NOT hardcode the port here. Read it from config.js so the server
REM and the browser always agree on the same port.
set APP_PORT=
for /f "delims=" %%p in ('node -e "process.stdout.write(String(require('./config').SERVER.port))" 2^>nul') do set APP_PORT=%%p
if not defined APP_PORT set APP_PORT=3001
echo Port: %APP_PORT%
echo.

REM If already listening, just open the browser.
netstat -ano | findstr ":%APP_PORT% " | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo Server already running.
    goto open_browser
)

echo Starting server...
start "" /b "%WINDIR%\System32\wscript.exe" "%~dp0start_server.vbs"

echo Waiting for server to start...
set /a count=0
:wait_loop
ping 127.0.0.1 -n 2 >nul
set /a count+=1
netstat -ano | findstr ":%APP_PORT% " | findstr "LISTENING" >nul
if %errorlevel% equ 0 goto ready
if %count% lss 60 goto wait_loop
goto timeout

:ready
echo Server ready!

:open_browser
echo Opening browser...
start http://localhost:%APP_PORT%
echo.
echo ==========================================
echo   Done! http://localhost:%APP_PORT%
echo ==========================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0

:timeout
echo.
echo [ERROR] Server did not start in time.
echo         Port %APP_PORT% is not listening.
echo.
echo   Check:
echo     1. Any error message in the server window
echo     2. Is port %APP_PORT% used by another program
echo.
echo   Try manually:
echo     cd /d "%~dp0"
echo     node server.js
echo.
pause
exit /b 1
