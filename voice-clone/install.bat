@echo off
rem Sets up the voice-clone tool. Double-click it once; it can be run again safely.
setlocal
cd /d "%~dp0"
title Voice clone - setup

set "TOOLS=%~dp0tools"
set "UV=%TOOLS%\uv.exe"
set "PY=%~dp0.venv\Scripts\python.exe"
rem Keep everything (Python, downloads, voice models) inside this folder.
set "UV_CACHE_DIR=%TOOLS%\cache"
set "UV_PYTHON_INSTALL_DIR=%TOOLS%\python"
set "HF_HOME=%~dp0models"
set "HF_HUB_DISABLE_SYMLINKS_WARNING=1"

echo.
echo  Setting up the voice-clone tool.
echo  This downloads about 10 GB and can take 30-90 minutes. You only need to do it once.
echo  If the voice-clone page is open (start.bat), close its black window first.
echo.

if exist "%UV%" goto have_uv
echo [1/5] Downloading uv, a small tool that installs Python...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; New-Item -ItemType Directory -Force $env:TOOLS | Out-Null; $zip = Join-Path $env:TEMP 'uv-download.zip'; Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $zip; Expand-Archive $zip -DestinationPath $env:TOOLS -Force; Remove-Item $zip"
if not exist "%UV%" goto fail
:have_uv

echo.
if exist "%PY%" (
    echo [2/5] Python is already installed.
    goto have_python
)
echo [2/5] Installing Python 3.11...
"%UV%" venv --python 3.11 .venv
if errorlevel 1 goto fail
:have_python

echo.
echo [3/5] Installing the Chatterbox voice software...
rem setuptools^<81 provides pkg_resources, which the watermarker (resemble-perth) needs.
rem openai-whisper listens back to each piece to catch mumbled words.
rem imageio-ffmpeg brings ffmpeg, which reads voice samples in any format (.m4a from phones and so on).
"%UV%" pip install --python "%PY%" chatterbox-tts lameenc ebooklib beautifulsoup4 pypdf mutagen "setuptools<81" openai-whisper imageio-ffmpeg
if errorlevel 1 goto fail

echo.
echo [4/5] Installing the graphics-card version of PyTorch (supports RTX 50-series cards)...
rem chatterbox-tts asks for torch 2.6, which has no code for RTX 50-series (sm_120) cards.
"%UV%" pip install --python "%PY%" --reinstall-package torch --reinstall-package torchaudio torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 goto fail

echo.
echo [5/5] Checking the graphics card...
"%PY%" gpu_check.py
if errorlevel 1 goto fail

echo.
echo Downloading the voice models (about 6 GB)...
"%PY%" voiceclone.py --download
if errorlevel 1 goto fail

echo.
echo  ============================================================
echo   All done. Double-click start.bat to make an audiobook.
echo  ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo  ============================================================
echo   Setup did not finish. Read the message above, check your
echo   internet connection, and double-click install.bat again.
echo   (It carries on from where it stopped.)
echo  ============================================================
echo.
pause
exit /b 1
