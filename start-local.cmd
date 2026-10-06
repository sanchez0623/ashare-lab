@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then reopen this script.
  pause
  exit /b 1
)
node scripts/local-server.mjs
pause
