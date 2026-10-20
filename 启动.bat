@echo off
chcp 65001 >nul
title AI Video Studio
cd /d "%~dp0"

echo.
echo ========================================
echo   AI Video Studio
echo ========================================
echo.

REM 1. Locate Node.js
set NODE_DIR=%APPDATA%\TRAE SOLO CN\ModularData\ai-agent\vm\tools\node
if exist "%NODE_DIR%\node.exe" (
    echo [OK] Node.js found
    path %NODE_DIR%;%PATH%
) else (
    echo [WARN] Node.js not found in default path, trying system PATH...
    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Node.js not detected. Please install it first.
        echo.
        pause
        exit /b 1
    )
)

for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo     Version: %NODE_VER%
echo.

REM 2. Config check
if exist "config.js" (
    echo [OK] config.js found
) else (
    echo [WARN] config.js not found
)
echo.

REM 3. Dependencies
if not exist "node_modules" (
    echo [..] Installing dependencies ^(first run takes 1-2 minutes^)...
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencies installed
    echo.
) else (
    echo [OK] Dependencies present
    echo.
)

REM 4. Resolve port from config.js (PORT env ^> .env ^> default 3001).
REM    Never hardcode the port here: if the script and the server disagree,
REM    the browser opens a port nobody is listening on and the page just fails.
set APP_PORT=
for /f "delims=" %%p in ('node -e "process.stdout.write(String(require('./config').SERVER.port))" 2^>nul') do set APP_PORT=%%p
if not defined APP_PORT set APP_PORT=3001

echo Starting server...
echo     URL: http://localhost:%APP_PORT%
echo.
echo     Press Ctrl+C to stop
echo ========================================
echo.

REM Start the server first, then wait until the port is really listening,
REM and only then open the browser. The old order (open browser, then start)
REM made the page spin for several seconds and left a broken tab when the
REM server failed to start.
netstat -ano | findstr ":%APP_PORT% " | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo [OK] Server already running on port %APP_PORT%
    goto open_browser
)

start "" /b cmd /c "node server.js"

set /a WAIT_COUNT=0
:WAIT_SERVER
ping -n 2 127.0.0.1 >nul
set /a WAIT_COUNT+=1
netstat -ano | findstr ":%APP_PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto SERVER_READY
if %WAIT_COUNT% lss 60 goto WAIT_SERVER
goto SERVER_TIMEOUT

:SERVER_READY
echo [OK] Server is ready.

:open_browser
start "" http://localhost:%APP_PORT%
echo.
echo     Running at http://localhost:%APP_PORT%
echo     Close this window (or Ctrl+C) to stop the server.
echo.
:WAIT_FOREVER
ping -n 60 127.0.0.1 >nul
goto WAIT_FOREVER

:SERVER_TIMEOUT
echo.
echo [ERROR] Port %APP_PORT% is still not listening after 60 attempts.
echo.
echo   Possible reasons:
echo     - The port is already used by another program
echo     - The server crashed on startup (see the error output above)
echo     - First-time dependency install is still running
echo.
echo   Try another port:
echo     set PORT=3002 ^&^& node server.js
echo.
pause
exit /b 1
