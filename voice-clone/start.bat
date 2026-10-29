@echo off
rem Opens the voice-clone page in the web browser. Keep this window open while you use it.
setlocal
cd /d "%~dp0"
title Voice clone
set "HF_HOME=%~dp0models"
if not exist ".venv\Scripts\python.exe" (
    echo The voice-clone tool isn't set up yet. Double-click install.bat first.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" app.py
echo.
echo The voice-clone page has stopped. You can close this window.
pause
