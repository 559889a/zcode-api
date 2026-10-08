@echo off
setlocal
title zcode-proxy
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo [start] bun not found in PATH. Install it from https://bun.sh first.
  pause
  exit /b 1
)

rem Web panel (quota / account pool / live logs) on http://127.0.0.1:8090.
rem Change the token by setting ZCODE_PANEL_TOKEN before launching.
if "%ZCODE_PANEL_ENABLED%"=="" set "ZCODE_PANEL_ENABLED=1"
if "%ZCODE_PANEL_TOKEN%"=="" set "ZCODE_PANEL_TOKEN=sk-123"

rem This machine's CPU (no AVX2) natively crashes Bun worker threads during
rem captcha solving, which kills the whole proxy. off = solve in a child
rem process (same isolation, catchable crash) instead of a worker thread.
if "%ZCODE_CAPTCHA_WORKER%"=="" set "ZCODE_CAPTCHA_WORKER=off"

rem Free the server port (config.yaml server.port) from a stale instance of
rem this proxy before launching — only ever kills bun.exe running
rem src\index.ts; a foreign process on the port is reported and left alone.
set "PROXY_PORT=8080"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-port.ps1" -Port %PROXY_PORT%

set "ZCODE_PROXY_CONFIG=%~dp0config.yaml"
echo [start] zcode-proxy serving %ZCODE_PROXY_CONFIG%
echo [start] panel: http://127.0.0.1:8090  (token: %ZCODE_PANEL_TOKEN%)
bun run src/index.ts --cli serve %*

echo.
echo [start] proxy stopped.
pause
