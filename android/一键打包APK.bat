@echo off
chcp 65001 >nul
title VisualCast 安卓APK一键打包工具

echo ========================================================
echo        VisualCast 大屏智能展播控系统 - 安卓打包工具
echo ========================================================
echo.

rem 优先尝试调用 Python 构建脚本 (包含最新前端资源 assets 自动同步)
where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
    if exist "%~dp0..\build_android_apk.py" (
        echo [*] 检测到 Python 环境，正在通过构建引擎全自动同步资源并编译打包...
        python "%~dp0..\build_android_apk.py"
        if %ERRORLEVEL% equ 0 (
            echo.
            echo ========================================================
            echo  [√] VisualCast APK 打包圆满完成！
            echo  产物路径: %~dp0..\VisualCast.apk
            echo ========================================================
            echo.
            pause
            exit /b 0
        )
    )
)

rem 回退使用本地 Gradle 进行编译
set "JAVA_HOME=C:\PROGRA~1\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
if not exist "%JAVA_HOME%" (
    set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
)
set "ANDROID_HOME=C:\Users\mac\AppData\Local\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%JAVA_HOME%\bin;%PATH%"

set "GRADLE_BAT=%~dp0.build_cache\gradle-8.2\bin\gradle.bat"
if not exist "%GRADLE_BAT%" (
    set "GRADLE_BAT=C:\Users\mac\.gradle\wrapper\dists\gradle-8.9-bin\90cnw93cvbtalezasaz0blq0a\gradle-8.9\bin\gradle.bat"
)

if not exist "%GRADLE_BAT%" (
    echo [错误] 未找到可用 Gradle，请先运行项目根目录下的 build_android_apk.py！
    pause
    exit /b 1
)

echo [1/2] 正在编译构建 APK...
cd /d "%~dp0"
call "%GRADLE_BAT%" assembleDebug --no-daemon

if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo  [√] 打包成功！
    copy /y "%~dp0app\build\outputs\apk\debug\app-debug.apk" "%~dp0VisualCast_v2.0.0_debug.apk" >nul
    copy /y "%~dp0app\build\outputs\apk\debug\app-debug.apk" "%~dp0..\VisualCast.apk" >nul
    echo  APK 输出位置: %~dp0VisualCast_v2.0.0_debug.apk
    echo ========================================================
    echo.
) else (
    echo.
    echo  [×] 打包失败，请检查上方日志报错。
)

echo.
pause
