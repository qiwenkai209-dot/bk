@echo off
chcp 65001 >nul
title 打包 VisualCast 安卓商显大屏 APK
cd /d "%~dp0"

echo ========================================================
echo        VisualCast 安卓商显大屏 - 原生 APK 一键编译打包
echo ========================================================

python build_android_apk.py

if errorlevel 1 (
    echo [×] 打包失败，请检查上方日志！
) else (
    echo [√] 打包成功！APK 已生成至 dist\VisualCast.apk 及根目录
)
pause
