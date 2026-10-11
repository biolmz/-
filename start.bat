@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%PORT%"=="" set PORT=8200
if "%HOST%"=="" set HOST=0.0.0.0

where node >nul 2>nul
if errorlevel 1 (
  echo 错误：未检测到 node，请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)

node -v
node server.js
pause
