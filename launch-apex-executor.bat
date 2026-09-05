@echo off
title Lapex Flash — CORS-bypass launcher
color 0B
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║         LAPEX FLASH — Dev Browser Launcher           ║
echo  ║     (CORS disabled for local Workbench access)       ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

set "FILE=%~dp0apex-executor.html"
set "PROFILE=%TEMP%\apex-cors-dev-profile"

:: ── Try Chrome ──────────────────────────────────────────────
set "CHROME64=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "CHROME86=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

if exist "%CHROME64%" (
    echo  [OK] Chrome found — launching with CORS disabled...
    start "" "%CHROME64%" --disable-web-security --user-data-dir="%PROFILE%" --allow-file-access-from-files "%FILE%"
    goto :login_tip
)
if exist "%CHROME86%" (
    echo  [OK] Chrome (x86) found — launching with CORS disabled...
    start "" "%CHROME86%" --disable-web-security --user-data-dir="%PROFILE%" --allow-file-access-from-files "%FILE%"
    goto :login_tip
)

:: ── Try Edge ────────────────────────────────────────────────
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "EDGE2=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if exist "%EDGE%" (
    echo  [OK] Microsoft Edge found — launching with CORS disabled...
    start "" "%EDGE%" --disable-web-security --user-data-dir="%PROFILE%" --allow-file-access-from-files "%FILE%"
    goto :login_tip
)
if exist "%EDGE2%" (
    echo  [OK] Microsoft Edge found — launching with CORS disabled...
    start "" "%EDGE2%" --disable-web-security --user-data-dir="%PROFILE%" --allow-file-access-from-files "%FILE%"
    goto :login_tip
)

:: ── Fallback ────────────────────────────────────────────────
echo  [!!] Chrome/Edge not found in default locations.
echo       Please open apex-executor.html manually in your browser
echo       and install the "Allow CORS" extension.
echo.
pause
goto :eof

:login_tip
echo.
echo  ┌──────────────────────────────────────────────────────┐
echo  │  NEXT STEPS (in the new browser window):             │
echo  │                                                      │
echo  │  1. A new isolated browser profile opens             │
echo  │  2. Go to: workbench.developerforce.com/login.php    │
echo  │  3. Log in with your Salesforce credentials          │
echo  │  4. Open a NEW TAB in the SAME window                │
echo  │  5. The apex-executor.html tab is already open        │
echo  │  6. Click Execute — it will work! ✅                 │
echo  └──────────────────────────────────────────────────────┘
echo.
echo  NOTE: This uses an isolated temp profile so your normal
echo        browser is NOT affected by disabling CORS.
echo.
