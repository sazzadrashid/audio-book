@echo off
rem Opens the Audio Book player on this computer. Keep the black window open while you use it.
setlocal
cd /d "%~dp0"
title Audio Book player
where node >nul 2>nul || (
    echo Node.js is needed to open the player on this computer. Get it from https://nodejs.org
    echo ^(or use the website on GitHub Pages instead^).
    pause
    exit /b 1
)
start "" http://localhost:8766/
node tools\serve-player.js 8766
pause
