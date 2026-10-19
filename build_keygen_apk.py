# -*- coding: utf-8 -*-
import os
import sys
import subprocess
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.join(BASE_DIR, "android_keygen")

JAVA_HOME = r"C:\PROGRA~1\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
ANDROID_HOME = r"C:\Users\mac\AppData\Local\Android\Sdk"
GRADLE_BAT = r"C:\Users\mac\.gradle\wrapper\dists\gradle-8.9-bin\90cnw93cvbtalezasaz0blq0a\gradle-8.9\bin\gradle.bat"

if not os.path.exists(GRADLE_BAT):
    print(f"[!] 找不到 Gradle: {GRADLE_BAT}")
    sys.exit(1)

env = os.environ.copy()
env["JAVA_HOME"] = JAVA_HOME
env["ANDROID_HOME"] = ANDROID_HOME
env["ANDROID_SDK_ROOT"] = ANDROID_HOME
env["PATH"] = os.path.join(JAVA_HOME, "bin") + os.path.pathsep + env.get("PATH", "")

print("========================================================")
print("       国文创加密机 - Android APK 原生编译工具")
print("========================================================")
print(f"[*] 项目目录: {PROJECT_DIR}")
print(f"[*] Java 路径: {JAVA_HOME}")
print(f"[*] SDK 路径: {ANDROID_HOME}")
print(f"[*] 正在调用 Gradle 进行编译构建...")

cmd = [GRADLE_BAT, "assembleDebug", "--no-daemon", "--stacktrace"]
proc = subprocess.run(cmd, cwd=PROJECT_DIR, env=env)

if proc.returncode == 0:
    print("\n[√] Gradle 编译构建成功！")
    apk_src = os.path.join(PROJECT_DIR, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
    if os.path.exists(apk_src):
        # 复制到目标位置
        dist_dir = os.path.join(BASE_DIR, "dist")
        os.makedirs(dist_dir, exist_ok=True)
        apk_dist = os.path.join(dist_dir, "国文创加密机.apk")
        apk_root = os.path.join(BASE_DIR, "国文创加密机.apk")
        apk_project = os.path.join(PROJECT_DIR, "国文创加密机.apk")

        shutil.copy2(apk_src, apk_dist)
        shutil.copy2(apk_src, apk_root)
        shutil.copy2(apk_src, apk_project)

        size_mb = os.path.getsize(apk_dist) / (1024 * 1024)
        print("========================================================")
        print(f" [√] APK 打包圆满完成！大小: {size_mb:.2f} MB")
        print(f" 1. {apk_dist}")
        print(f" 2. {apk_root}")
        print("========================================================")
    else:
        print(f"[×] 未能找到编译生成的 APK: {apk_src}")
else:
    print(f"\n[×] 编译失败，退出码: {proc.returncode}")
    sys.exit(proc.returncode)
