@echo off
title VisualCast 展馆可视化智能播控系统
cd /d "%~dp0"

set "PY_EXE="
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if not defined PY_EXE if exist "%~dp0.venv\Scripts\python.exe" set "PY_EXE=%~dp0.venv\Scripts\python.exe"
if not defined PY_EXE if exist "%~dp0venv\Scripts\python.exe" set "PY_EXE=%~dp0venv\Scripts\python.exe"
if not defined PY_EXE if exist "C:\Python311\python.exe" set "PY_EXE=C:\Python311\python.exe"
if not defined PY_EXE where python >nul 2>nul && set "PY_EXE=python"

if not defined PY_EXE (
    echo [错误] 未在系统或常见路径中检测到 Python 运行环境！
    echo 请安装 Python 3.8+ 并勾选 Add to PATH。
    pause
    exit /b 1
)

echo ========================================================
echo   VisualCast 展馆可视化智能播控系统 正在启动...
echo ========================================================
echo [*] Python 运行环境: %PY_EXE%
echo [*] 正在拉起 VisualCast 播控服务核心...
echo.

"%PY_EXE%" "%~dp0main.py" %*

if errorlevel 1 (
    echo.
    echo [系统提示] VisualCast 播控服务已停止运行。
    pause
)
