# -*- coding: utf-8 -*-
import os
import sys
import subprocess
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.join(BASE_DIR, "android")

JAVA_HOME = (os.getenv('JAVA_HOME') or '').strip().rstrip('\\').rstrip('/')
if not JAVA_HOME and os.path.isdir(r'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot'):
    JAVA_HOME = r'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot'

ANDROID_HOME = (os.getenv('ANDROID_HOME') or '').strip().rstrip('\\').rstrip('/')
if not ANDROID_HOME:
    default_sdk = os.path.expanduser(r'~\AppData\Local\Android\Sdk')
    if os.path.isdir(default_sdk):
        ANDROID_HOME = default_sdk

possible_gradles = [
    os.path.join(PROJECT_DIR, 'gradlew.bat'),
    r"C:\Users\mac\.gradle\wrapper\dists\gradle-8.9-bin\90cnw93cvbtalezasaz0blq0a\gradle-8.9\bin\gradle.bat",
    os.path.join(PROJECT_DIR, '.build_cache', 'gradle-8.2', 'bin', 'gradle.bat'),
    shutil.which('gradle.bat') or ''
]
GRADLE_BIN = next((g for g in possible_gradles if g and os.path.isfile(g)), None)

if not all([JAVA_HOME, ANDROID_HOME, GRADLE_BIN]):
    print(f'[!] JAVA_HOME: {JAVA_HOME}, ANDROID_HOME: {ANDROID_HOME}, GRADLE: {GRADLE_BIN}')
    print('[!] JAVA_HOME, ANDROID_HOME 环境变量或 Gradle 未找到，请检查配置')
    sys.exit(1)

env = os.environ.copy()
env["JAVA_HOME"] = JAVA_HOME
env["ANDROID_HOME"] = ANDROID_HOME
env["ANDROID_SDK_ROOT"] = ANDROID_HOME
env["PATH"] = os.path.join(JAVA_HOME, "bin") + os.path.pathsep + env.get("PATH", "")

print("========================================================")
print("     VisualCast 商显播控大屏 - Android APK 原生编译构建")
print("========================================================")
print(f"[*] 项目目录: {PROJECT_DIR}")
print(f"[*] Java 路径: {JAVA_HOME}")
print(f"[*] SDK 路径: {ANDROID_HOME}")

# 自动同步根目录 static 最新前端脚本到 Android assets (static 与 web/static)
src_static = os.path.join(BASE_DIR, "static")
dst_targets = [
    os.path.join(PROJECT_DIR, "app", "src", "main", "assets", "static"),
    os.path.join(PROJECT_DIR, "app", "src", "main", "assets", "web", "static")
]
if os.path.exists(src_static):
    for dst_static in dst_targets:
        print(f"[*] 同步静态资源: {src_static} -> {dst_static}")
        os.makedirs(dst_static, exist_ok=True)
        for root, dirs, files in os.walk(src_static):
            rel_path = os.path.relpath(root, src_static)
            target_dir = os.path.join(dst_static, rel_path) if rel_path != "." else dst_static
            os.makedirs(target_dir, exist_ok=True)
            for f in files:
                shutil.copy2(os.path.join(root, f), os.path.join(target_dir, f))

print(f"[*] 正在调用 Gradle 进行构建...")

cmd = [GRADLE_BIN, "clean", "assembleDebug", "--no-daemon", "--stacktrace"]
proc = subprocess.run(cmd, cwd=PROJECT_DIR, env=env)

if proc.returncode == 0:
    print("\n[√] Gradle 编译构建成功！")
    possible_apks = [
        os.path.join(PROJECT_DIR, "app", "build", "outputs", "apk", "release", "app-release.apk"),
        os.path.join(PROJECT_DIR, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
    ]
    apk_src = next((a for a in possible_apks if os.path.exists(a)), None)
    if apk_src:
        dist_dir = os.path.join(BASE_DIR, "dist")
        os.makedirs(dist_dir, exist_ok=True)
        apk_dist = os.path.join(dist_dir, "VisualCast.apk")
        apk_root = os.path.join(BASE_DIR, "VisualCast.apk")

        shutil.copy2(apk_src, apk_dist)
        shutil.copy2(apk_src, apk_root)

        size_mb = os.path.getsize(apk_dist) / (1024 * 1024)
        print("========================================================")
        print(f" [√] VisualCast Android 原生 APK 构建圆满完成！体积: {size_mb:.2f} MB")
        print(f" 1. 产物路径 (dist): {apk_dist}")
        print(f" 2. 产物路径 (root): {apk_root}")
        print("========================================================")
    else:
        print(f"[×] 未能找到编译生成的 APK")
        sys.exit(1)
else:
    print(f"\n[×] 编译失败，退出码: {proc.returncode}")
    sys.exit(proc.returncode)
