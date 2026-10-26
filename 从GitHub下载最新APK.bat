@echo off
chcp 65001 >nul
title 从 GitHub 下载 VisualCast 最新 APK
cd /d "%~dp0"

echo ========================================================
echo     VisualCast - 从 GitHub 获取云端编译产物 APK
echo     (完全使用 GitHub Actions 云端算力，免本地耗时编译)
echo ========================================================

python download_github_apk.py

if errorlevel 1 (
    echo.
    echo [×] 下载未能完成，请参考上方提示或稍后重试。
) else (
    echo.
    echo [√] 最新 APK 获取成功，可直接安装至安卓大屏或发送给客户！
)

echo.
pause
