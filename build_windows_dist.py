# -*- coding: utf-8 -*-
"""
VisualCast Windows 全套独立程序云端/本地统一打包脚本
支持无损 UTF-8 编码，彻底避免跨平台中文字符乱码问题。
输出三个主程序：
1. VisualCast.exe (商显大屏智能播控主程序)
2. 国文创加密机.exe / GuoWenChuang_Keygen.exe (离线授权加密机)
3. 局域网大屏在线设备中枢.exe / Fleet_Hub.exe (在线设备中枢)
"""

import os
import sys
import subprocess
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(BASE_DIR, "dist")
OUTPUT_DIR = os.path.join(BASE_DIR, "output", "windows")
os.makedirs(OUTPUT_DIR, exist_ok=True)

build_targets = [
    {
        "spec": "VisualCast.spec",
        "primary_exe": "VisualCast.exe",
        "aliases": []
    },
    {
        "spec": "国文创加密机.spec",
        "primary_exe": "国文创加密机.exe",
        "aliases": ["GuoWenChuang_Keygen.exe", "加密机.exe"]
    },
    {
        "spec": "局域网大屏在线设备中枢.spec",
        "primary_exe": "局域网大屏在线设备中枢.exe",
        "aliases": ["Fleet_Hub.exe", "设备中枢.exe"]
    }
]

print("========================================================")
print("     VisualCast Windows 批量编译构建与产物收集工具")
print("========================================================")
print(f"[*] 基础目录: {BASE_DIR}")
print(f"[*] 输出目录: {OUTPUT_DIR}")

for target in build_targets:
    spec_path = os.path.join(BASE_DIR, target["spec"])
    if not os.path.isfile(spec_path):
        print(f"[!] 找不到 SPEC 文件: {spec_path}")
        sys.exit(1)

    print(f"\n[*] 正在编译: {target['spec']} ...")
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", spec_path]
    res = subprocess.run(cmd, cwd=BASE_DIR)
    if res.returncode != 0:
        print(f"[×] 编译失败: {target['spec']} (退出码: {res.returncode})")
        sys.exit(res.returncode)

    primary_exe = target["primary_exe"]
    src_exe = os.path.join(DIST_DIR, primary_exe)
    
    # 容错：如果在 dist 中由于编码差异找不到精确名，尝试在 dist 查找最新生成的对应 exe
    if not os.path.exists(src_exe):
        for f in os.listdir(DIST_DIR):
            if f.endswith(".exe") and f != "VisualCast.exe":
                src_exe = os.path.join(DIST_DIR, f)
                break

    if os.path.exists(src_exe):
        dst_primary = os.path.join(OUTPUT_DIR, primary_exe)
        shutil.copy2(src_exe, dst_primary)
        print(f"[√] 收集主程序: {dst_primary} ({os.path.getsize(dst_primary) / 1024 / 1024:.2f} MB)")

        for alias in target["aliases"]:
            dst_alias = os.path.join(OUTPUT_DIR, alias)
            shutil.copy2(src_exe, dst_alias)
            print(f"[√] 生成中文/英文兼容别名: {dst_alias}")
    else:
        print(f"[×] 未能找到编译生成的 EXE: {src_exe}")
        sys.exit(1)

print("\n========================================================")
print("[√] 全部 Windows 可执行程序构建并归档成功！输出文件列表:")
for item in os.listdir(OUTPUT_DIR):
    item_path = os.path.join(OUTPUT_DIR, item)
    size_mb = os.path.getsize(item_path) / 1024 / 1024
    print(f"  - {item} ({size_mb:.2f} MB)")
print("========================================================")
