@echo off
chcp 65001 >nul
echo ========================================================
echo        国文创加密机 - 安卓移动端 APK 构建脚本
echo ========================================================
echo.

set "JAVA_HOME=C:\PROGRA~1\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
set "ANDROID_HOME=C:\Users\mac\AppData\Local\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%JAVA_HOME%\bin;%PATH%"

set "GRADLE_BAT=C:\Users\mac\.gradle\wrapper\dists\gradle-8.9-bin\90cnw93cvbtalezasaz0blq0a\gradle-8.9\bin\gradle.bat"

cd /d "%~dp0"

echo [*] 正在编译构建 国文创加密机.apk ...
call "%GRADLE_BAT%" assembleRelease --no-daemon

if %ERRORLEVEL% equ 0 (
    echo.
    echo [√] 构建成功！
    copy /y "%~dp0app\build\outputs\apk\release\app-release-unsigned.apk" "%~dp0国文创加密机.apk" >nul 2>nul
    if not exist "%~dp0国文创加密机.apk" (
        call "%GRADLE_BAT%" assembleDebug --no-daemon
        copy /y "%~dp0app\build\outputs\apk\debug\app-debug.apk" "%~dp0国文创加密机.apk" >nul
    )
    copy /y "%~dp0国文创加密机.apk" "%~dp0..\dist\国文创加密机.apk" >nul 2>nul
    echo 输出文件: %~dp0国文创加密机.apk
) else (
    echo [!] 尝试 assembleDebug ...
    call "%GRADLE_BAT%" assembleDebug --no-daemon
    copy /y "%~dp0app\build\outputs\apk\debug\app-debug.apk" "%~dp0国文创加密机.apk" >nul
    copy /y "%~dp0国文创加密机.apk" "%~dp0..\dist\国文创加密机.apk" >nul 2>nul
    echo 输出文件: %~dp0国文创加密机.apk
)
