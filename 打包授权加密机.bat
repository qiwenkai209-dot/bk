@echo off
title 打包 国文创加密机 (单文件 EXE)
cd /d "%~dp0"

set "PY_EXE="
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY_EXE where python >nul 2>nul && set "PY_EXE=python"

if not defined PY_EXE (
    echo [错误] 未在系统检测到 Python 环境！
    pause
    exit /b 1
)

echo ========================================================
echo        正在使用 PyInstaller 打包 国文创加密机...
echo ========================================================

"%PY_EXE%" -m PyInstaller --noconfirm --clean --onefile --windowed --name "国文创加密机" --icon="assets/icon.ico" --add-data="universal_license_core.py;." universal_armor_studio.py

if errorlevel 1 (
    echo [×] 打包失败，请检查上方报错！
) else (
    echo [√] 打包成功！EXE 输出在 dist\国文创加密机.exe
)
pause
