@echo off
title Lapex Flash Server
color 0A
cd /d "%~dp0"
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║           LAPEX FLASH — Starting Server              ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed!
    echo  Please install from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo  [1/2] Installing dependencies...
call npm install --silent
if %errorlevel% neq 0 (
    echo  [ERROR] npm install failed.
    pause
    exit /b 1
)

echo  [2/2] Starting server on http://localhost:3000...
echo.
echo  ┌──────────────────────────────────────────────────────┐
echo  │  Open in browser:                                    │
echo  │  http://localhost:3000/apex-executor.html            │
echo  │                                                      │
echo  │  How to get your Session ID:                         │
echo  │  1. Log into workbench.developerforce.com            │
echo  │  2. Open DevTools (F12) → Application → Cookies      │
echo  │  3. Find the 'sid' cookie → Copy its value           │
echo  │  4. Paste it in the Session ID field in the app      │
echo  │                                                      │
echo  │  Press Ctrl+C to stop the server                     │
echo  └──────────────────────────────────────────────────────┘
echo.

start "" "http://localhost:3000/apex-executor.html"
node server.js
