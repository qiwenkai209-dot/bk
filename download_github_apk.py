# -*- coding: utf-8 -*-
"""
VisualCast - GitHub 云端构建产物极速下载工具
由 GitHub Actions 云端服务器提供编译算力，本地免安装 Android SDK/Gradle 直接拉取最新 Release APK。
"""
import os
import sys
import time
import urllib.request
import winreg

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET_APK_ROOT = os.path.join(BASE_DIR, "VisualCast.apk")
TARGET_APK_DIST = os.path.join(BASE_DIR, "dist", "VisualCast.apk")
GITHUB_REPO = "qiwenkai209-dot/bk"
RELEASE_URL = f"https://github.com/{GITHUB_REPO}/releases/download/latest/VisualCast.apk"

def detect_proxy():
    """检测 Windows 当前启用的代理设置 (如 SakuraCat / Clash 等)"""
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
        server, _ = winreg.QueryValueEx(key, "ProxyServer")
        winreg.CloseKey(key)
        if enabled and server:
            if not server.startswith("http://") and not server.startswith("socks5://"):
                server = "http://" + server
            return server
    except Exception:
        pass
    # 常用兜底代理端口探测
    for p in [12450, 7890, 10808, 1080]:
        try:
            import socket
            with socket.create_connection(("127.0.0.1", p), timeout=0.3):
                return f"http://127.0.0.1:{p}"
        except Exception:
            continue
    return None

def download_progress(block_num, block_size, total_size):
    downloaded = block_num * block_size
    if total_size > 0:
        percent = min(100.0, downloaded * 100.0 / total_size)
        mb_down = downloaded / (1024 * 1024)
        mb_total = total_size / (1024 * 1024)
        bar_len = 30
        filled = int(bar_len * percent / 100.0)
        bar = '=' * filled + '-' * (bar_len - filled)
        sys.stdout.write(f"\r  [{bar}] {percent:.1f}% ({mb_down:.2f}MB / {mb_total:.2f}MB)")
        sys.stdout.flush()
    else:
        sys.stdout.write(f"\r  已下载: {downloaded / (1024 * 1024):.2f} MB...")
        sys.stdout.flush()

def main():
    print("=" * 60)
    print("   VisualCast - 从 GitHub 获取云端编译产物 APK")
    print("=" * 60)
    print(f"[*] 目标仓库: {GITHUB_REPO}")
    print(f"[*] 下载直链: {RELEASE_URL}")

    proxy_url = detect_proxy()
    if proxy_url:
        print(f"[*] 检测到本地代理环境: {proxy_url} (已配置直通加速)")
        proxy_handler = urllib.request.ProxyHandler({
            'http': proxy_url,
            'https': proxy_url
        })
        opener = urllib.request.build_opener(proxy_handler)
    else:
        print("[*] 未检测到系统代理，尝试公网直连...")
        opener = urllib.request.build_opener()

    opener.addheaders = [
        ('User-Agent', 'VisualCast-Downloader/1.0'),
        ('Accept', 'application/octet-stream')
    ]
    urllib.request.install_opener(opener)

    temp_apk = os.path.join(BASE_DIR, "VisualCast.apk.tmp")
    if os.path.exists(temp_apk):
        try: os.remove(temp_apk)
        except Exception: pass

    print("[*] 正在连接 GitHub 下载最新 APK 安装包...")
    start_time = time.time()
    try:
        urllib.request.urlretrieve(RELEASE_URL, temp_apk, download_progress)
        print("\n")
    except Exception as e:
        print(f"\n[×] 下载失败: {e}")
        print("\n[!] 提示：")
        print("  1. 若云端刚完成推送，GitHub Actions 编译大约需 1~2 分钟，请稍候片刻重试。")
        print("  2. 请确保代理客户端 (SakuraCat / Clash) 节点畅通。")
        if os.path.exists(temp_apk):
            try: os.remove(temp_apk)
            except Exception: pass
        sys.exit(1)

    file_size = os.path.getsize(temp_apk)
    if file_size < 1024 * 1024:  # 小于 1MB 大概率是报错页面
        with open(temp_apk, 'rb') as f:
            content = f.read(500).decode('utf-8', errors='ignore')
        os.remove(temp_apk)
        print(f"[×] 下载的文件体积异常 ({file_size} 字节)，内容可能为错误响应:")
        print(content)
        sys.exit(1)

    # 替换目标文件
    os.makedirs(os.path.dirname(TARGET_APK_DIST), exist_ok=True)
    if os.path.exists(TARGET_APK_ROOT):
        try: os.remove(TARGET_APK_ROOT)
        except Exception: pass
    os.replace(temp_apk, TARGET_APK_ROOT)

    try:
        import shutil
        shutil.copy2(TARGET_APK_ROOT, TARGET_APK_DIST)
    except Exception:
        pass

    elapsed = time.time() - start_time
    mb_size = file_size / (1024 * 1024)
    speed = mb_size / elapsed if elapsed > 0 else 0
    print("=" * 60)
    print(f"[√] 下载成功！体积: {mb_size:.2f} MB, 耗时: {elapsed:.1f}s (均速 {speed:.2f} MB/s)")
    print(f"[*] 产物已覆盖至:")
    print(f"    1. {TARGET_APK_ROOT}")
    print(f"    2. {TARGET_APK_DIST}")
    print("=" * 60)

if __name__ == "__main__":
    main()
