@echo off
set "JAVA_HOME=C:\PROGRA~1\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
if not exist "%JAVA_HOME%" (
    set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
)
set "PATH=%JAVA_HOME%\bin;%PATH%"
set "ANDROID_HOME=C:\Users\mac\AppData\Local\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
cd /d "D:\aiagent\bk\android"

set "GRADLE_BAT=C:\Users\mac\.gradle\wrapper\dists\gradle-8.9-bin\90cnw93cvbtalezasaz0blq0a\gradle-8.9\bin\gradle.bat"
if not exist "%GRADLE_BAT%" (
    set "GRADLE_BAT=D:\aiagent\bk\android\.build_cache\gradle-8.2\bin\gradle.bat"
)

echo [*] Starting Gradle build with --no-daemon...
call "%GRADLE_BAT%" assembleDebug --no-daemon
