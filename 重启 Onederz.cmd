@echo off
rem ============================================================
rem  Onederz launcher - force restart.
rem  Kills a previously running instance first, then starts fresh.
rem  Use this when the launcher says "already running" but you cannot
rem  find the widget.
rem  ASCII-only on purpose: cmd codepage issues.
rem ============================================================
cd /d "%~dp0"
title Onederz (restart)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install the LTS version from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

node scripts\start-all.js --restart %*

echo.
echo   Onederz stopped. Press any key to close.
pause >nul
