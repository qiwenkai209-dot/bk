@echo off
title 国文创加密机 - 专业商业授权签发中心
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
echo       国文创加密机 · 专业商业软件授权签发中心
echo ========================================================
echo [*] Python 运行环境: %PY_EXE%
echo [*] 正在拉起授权中心图形界面...
echo.

"%PY_EXE%" "%~dp0universal_armor_studio.py"

if errorlevel 1 (
    echo.
    echo [系统提示] 国文创加密机图形界面已关闭。
    pause
)
