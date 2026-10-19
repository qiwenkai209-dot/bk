@echo off
chcp 65001 >nul
title 国文创加密机 Android APK 打包工具
echo ========================================================
echo        国文创加密机 - Android APK 原生编译工具
echo ========================================================
echo.
python "%~dp0build_keygen_apk.py"
echo.
pause
