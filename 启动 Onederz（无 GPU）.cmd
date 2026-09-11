@echo off
rem ============================================================
rem  Onederz launcher - software rendering.
rem  Use this when the normal launcher shows no window (remote desktop,
rem  VM, or a broken GPU driver).
rem  ASCII-only on purpose: cmd codepage issues.
rem ============================================================
cd /d "%~dp0"
title Onederz (software rendering)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install the LTS version from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

node scripts\start-all.js --nogpu %*

echo.
echo   Onederz stopped. Press any key to close.
pause >nul
