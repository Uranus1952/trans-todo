@echo off
rem ============================================================
rem  Onederz launcher. Messages are printed by Node (UTF-8 safe).
rem  This file is intentionally ASCII-only to avoid cmd codepage issues.
rem ============================================================
cd /d "%~dp0"
title Onederz

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install the LTS version from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

node scripts\start-all.js %*

echo.
echo   Onederz stopped. Press any key to close.
pause >nul
