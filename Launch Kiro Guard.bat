@echo off
REM One-click launcher for Kiro Guard.
REM Output is captured to kiro-guard.log in this folder for debugging.

cd /d "%~dp0"

set KIRO_BUDDY_DISABLE_INPUT_MONITOR=1

REM --no-sandbox is required on this machine because the Chromium renderer
REM sandbox cannot start (EDR/security software interference). Without this
REM flag, file:// loads return ERR_FAILED and the lock screen never shows.
REM Verified via diagnose-load.js: with --no-sandbox -> "loadFile resolved OK".
start "" /B cmd /c "node_modules\electron\dist\electron.exe . --no-sandbox > kiro-guard.log 2>&1"
exit
