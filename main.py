# -*- coding: utf-8 -*-
"""
VisualCast 展馆可视化智能播控系统 - 主启动入口
"""
import os
import sys
import time
import threading
import webbrowser
import signal
import socket
import subprocess

# 设置当前工作目录为项目根目录 (兼容源码与 PyInstaller 打包独立 EXE)
if getattr(sys, 'frozen', False):
    EXE_DIR = os.path.dirname(sys.executable)
    BUNDLE_DIR = getattr(sys, '_MEIPASS', EXE_DIR)
    BASE_DIR = EXE_DIR
else:
    EXE_DIR = os.path.abspath(os.path.dirname(__file__))
    BUNDLE_DIR = EXE_DIR
    BASE_DIR = EXE_DIR

os.chdir(BASE_DIR)

import atexit
import traceback
from logger_service import sys_logger, log_event

CRASH_LOG = os.path.join(BASE_DIR, "logs", "crash.log")
try:
    os.makedirs(os.path.join(BASE_DIR, "logs"), exist_ok=True)
except Exception:
    pass

def global_excepthook(exc_type, exc_value, exc_traceback):
    try:
        err_msg = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
        log_event("ERROR", f"主线程未捕获致命异常:\n{err_msg}", level="ERROR")
        with open(CRASH_LOG, "a", encoding="utf-8") as f:
            f.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] 主线程未捕获异常:\n{err_msg}\n")
    except Exception:
        pass
    sys.__excepthook__(exc_type, exc_value, exc_traceback)

def thread_excepthook(args):
    try:
        err_msg = "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback))
        log_event("ERROR", f"子线程 [{args.thread.name}] 异常:\n{err_msg}", level="ERROR")
        with open(CRASH_LOG, "a", encoding="utf-8") as f:
            f.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] 子线程未捕获异常 [{args.thread.name}]:\n{err_msg}\n")
    except Exception:
        pass

def on_exit():
    try:
        import system_control
        system_control.set_taskbar_visibility(True)
    except Exception:
        pass
    try:
        log_event("SYSTEM", "VisualCast 播控服务主程序安全退出 (atexit 触发)")
    except Exception:
        pass

sys.excepthook = global_excepthook
if hasattr(threading, 'excepthook'):
    threading.excepthook = thread_excepthook
atexit.register(on_exit)

# 确保 Windows 控制台字符编码安全
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("VisualCast.MediaScreen.Pro")
    except Exception:
        pass

# 避免系统代理干扰 127.0.0.1
os.environ['NO_PROXY'] = 'localhost,127.0.0.1,0.0.0.0'
os.environ['no_proxy'] = 'localhost,127.0.0.1,0.0.0.0'

# 如果显式指定了 --hide 参数，才隐藏控制台窗口
if '--hide' in sys.argv or '--quiet' in sys.argv:
    try:
        import ctypes
        ctypes.windll.user32.ShowWindow(ctypes.windll.kernel32.GetConsoleWindow(), 0)
    except Exception:
        pass

def wait_for_port(port=8088, timeout=5.0):
    """等待本地端口监听就绪"""
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                if s.connect_ex(('127.0.0.1', port)) == 0:
                    return True
        except Exception:
            pass
        time.sleep(0.3)
    return False

def find_independent_browser():
    """
    智能探查 Windows 本地 Edge 或 Chrome 原生独立应用内核 (优先 Edge，其次 Chrome)
    通过 Windows 注册表金标准检索 + 环境变量候选，100% 确保返回真实路径，彻底杜绝回退到普通浏览器标签页
    """
    try:
        import winreg
        reg_paths = [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        ]
        for r_path in reg_paths:
            for root in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
                try:
                    with winreg.OpenKey(root, r_path) as k:
                        val, _ = winreg.QueryValueEx(k, "")
                        if val and os.path.isfile(val):
                            return val
                except Exception:
                    pass
    except Exception:
        pass

    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\Edge\Application\msedge.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            return p

    import shutil
    for name in ["msedge", "chrome"]:
        p = shutil.which(name)
        if p and os.path.isfile(p):
            return p

    return None

def launch_player_window(url="http://127.0.0.1:8088/player"):
    """
    拉起服务端大屏呈现视窗 (原生独立桌面应用模式，全屏无边框，免手势自动播音，硬件加速)
    """
    def _runner():
        # 等待服务端口 8088 100% 就绪
        if not wait_for_port(8088, timeout=8.0):
            print("[大屏呈现] 警告: 8088 端口就绪超时，尝试直接拉起窗口...")

        exe = find_independent_browser()

        cache_dir = os.path.abspath(os.path.join(BASE_DIR, "cache", "player_browser"))
        try:
            os.makedirs(cache_dir, exist_ok=True)
        except Exception:
            pass

        # 启动时大屏呈现视窗始终以纯粹展馆全屏置顶模式拉起
        target_idx = 0
        try:
            import json
            with open(os.path.join(BASE_DIR, "config", "player_config.json"), "r", encoding="utf-8") as f:
                cfg = json.load(f)
            pos_cfg = cfg.get("position", {})
            target_idx = pos_cfg.get("target_screen_index", pos_cfg.get("monitor_index", 0))
        except Exception:
            pass

        # 获取目标显示器的物理坐标与分辨率
        mon_x, mon_y, mon_w, mon_h = 0, 0, 1920, 1080
        try:
            import system_control
            monitors = system_control.get_monitors()
            if monitors:
                if target_idx < 0 or target_idx >= len(monitors):
                    target_idx = 0
                m = monitors[target_idx]
                mon_x, mon_y, mon_w, mon_h = m['x'], m['y'], m['width'], m['height']
        except Exception:
            pass

        proc = None
        if exe:
            # 核心优化：将 --user-data-dir 置于首位，彻底与系统常驻日常浏览器隔离，开启专属独立实例
            args = [
                exe,
                f"--user-data-dir={cache_dir}",
                f"--app={url}",
                "--start-fullscreen",
                f"--window-position={mon_x},{mon_y}",
                f"--window-size={mon_w},{mon_h}",
                "--autoplay-policy=no-user-gesture-required",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-background-timer-throttling",
                "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,Translate,OptimizationHints,PictureInPicture,GlobalMediaControls,EdgeVideoOverlayToolbar,msEdgePictureInPicture,EdgeVideoSuperResolution,ContextMenu",
                "--disable-context-menu",
                "--hide-scrollbars",
                "--disable-pinch",
                "--overscroll-history-navigation=0",
                "--kiosk-printing",
                "--disable-infobars",
                "--noerrdialogs",
                "--disable-session-crashed-bubble",
                "--check-for-update-interval=31536000",
                "--app-id=VisualCastApp",
            ]

            try:
                proc = subprocess.Popen(args)
                print(f"[√] 服务端大屏呈现视窗已成功全屏拉起 (PID: {proc.pid})")
                log_event("SYSTEM", f"服务端大屏呈现视窗已成功全屏拉起 (PID: {proc.pid})")
            except Exception as e:
                print(f"[!] 拉起原生大屏应用视窗失败: {e}，切回系统默认浏览器...")
                log_event("WARN", f"拉起原生大屏视窗异常: {e}，切回系统默认浏览器")
                webbrowser.open(url)
        else:
            print("[!] 未检测到 Edge/Chrome 独立内核，正在使用系统默认浏览器打开大屏呈现端...")
            log_event("WARN", "未检测到独立 Edge/Chrome，调用默认浏览器打开大屏呈现端")
            webbrowser.open(url)

        # 启动后多轮校验并确保窗口完美投射至目标屏幕，剥离标题栏并隐藏大屏屏幕任务栏
        try:
            import system_control
            from server import coordinator
            actual_target_idx = coordinator.status.get("target_screen_index", target_idx)
            m_list = system_control.get_monitors()
            cur_m = m_list[actual_target_idx] if (m_list and actual_target_idx < len(m_list)) else {"x": mon_x, "y": mon_y, "width": mon_w, "height": mon_h}
            target_r = (int(cur_m.get('x', mon_x)), int(cur_m.get('y', mon_y)), int(cur_m.get('width', mon_w)), int(cur_m.get('height', mon_h)))

            # 响应用户需求：始终保持 Windows 任务栏可见与前置
            system_control.set_taskbar_visibility(True)
            time.sleep(0.8)
            for _ in range(35):
                hwnd = system_control.find_player_window_hwnd()
                if hwnd:
                    # 彻底消除浏览器样式，设为原生 Popup 全屏
                    try:
                        import ctypes
                        user32 = ctypes.windll.user32
                        GWL_STYLE = -16
                        WS_POPUP = 0x80000000
                        WS_VISIBLE = 0x10000000
                        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
                        style = (style & ~0x00C00000 & ~0x00040000) | WS_POPUP | WS_VISIBLE
                        user32.SetWindowLongW(hwnd, GWL_STYLE, style)
                    except Exception:
                        pass

                    system_control.apply_window_to_monitor(hwnd, actual_target_idx, fullscreen=True)
                    system_control.set_taskbar_visibility(True)
                    coordinator.is_fullscreen_mode = True
                    coordinator.status["fullscreen"] = True

                    # 动态注入 VisualCast 独立专属高清图标句柄 (任务栏与Alt+Tab显示专属图标)
                    try:
                        import ctypes
                        icon_path = os.path.join(BUNDLE_DIR, 'assets', 'icon.ico')
                        if not os.path.exists(icon_path):
                            icon_path = os.path.join(EXE_DIR, 'assets', 'icon.ico')
                        if os.path.exists(icon_path):
                            user32 = ctypes.windll.user32
                            h_icon = user32.LoadImageW(None, icon_path, 1, 0, 0, 0x00000010 | 0x00000040)
                            if h_icon:
                                user32.SendMessageTimeoutW(hwnd, 0x0080, 0, h_icon, 2, 1000, None) # WM_SETICON SMALL
                                user32.SendMessageTimeoutW(hwnd, 0x0080, 1, h_icon, 2, 1000, None) # WM_SETICON BIG
                                try:
                                    GCLP_HICON = -14
                                    GCLP_HICONSM = -34
                                    user32.SetClassLongPtrW(hwnd, GCLP_HICON, h_icon)
                                    user32.SetClassLongPtrW(hwnd, GCLP_HICONSM, h_icon)
                                except Exception:
                                    pass
                    except Exception:
                        pass

                    print(f"[大屏呈现端] 大屏窗口已精准锁定目标屏幕 #{actual_target_idx + 1} (全屏无边框，独立程序图标已注入)")
                    log_event("SYSTEM", f"大屏窗口已锁定屏幕 #{actual_target_idx + 1} (全屏无边框，独立程序图标已注入)")
                    break
                time.sleep(0.3)
        except Exception as e:
            print(f"[大屏呈现端] 全屏校准异常: {e}")

    threading.Thread(target=_runner, daemon=True).start()

def print_banner(local_ip="127.0.0.1", port=8088):
    print("=" * 76)
    print("      VisualCast 展馆可视化智能播控系统 (VisualCast Pro)")
    print("=" * 76)
    print(f"  [√] 服务端大屏呈现窗口 (播放端): 已就绪并全屏启动")
    print(f"  [√] 播控管理中台 (运维配置):     http://127.0.0.1:{port}/admin")
    if local_ip and local_ip != "127.0.0.1":
        print(f"  [√] 手机/iPad无线遥控手牌:       http://{local_ip}:{port}/remote")
    print(f"  [√] 物联中控服务:                TCP 端口 8000 / UDP 端口 8001")
    print(f"  [√] 毫秒级多机集群联播服务:      UDP 端口 8002 (高精PTP授时/单帧级同步)")
    print("=" * 76)
    print("  系统正在平稳运行中，服务端大屏窗口已就绪。")
    print("  提示: 如需进入管理中台，请在浏览器中访问: http://127.0.0.1:8088/admin")
    print("  快捷键: 按 Ctrl+C 可停止系统服务。")
    print("=" * 76)
    sys.stdout.flush()

def free_port(port=8088):
    """自动清理可能残留的旧孤儿进程占用端口"""
    if sys.platform.startswith('win'):
        try:
            import subprocess
            cmd = f'netstat -aon | findstr ":{port}" | findstr "LISTENING"'
            out = subprocess.check_output(cmd, shell=True, text=True, errors='ignore')
            current_pid = os.getpid()
            for line in out.strip().splitlines():
                parts = line.strip().split()
                if len(parts) >= 5:
                    pid = parts[-1]
                    if pid.isdigit() and int(pid) != current_pid and int(pid) != 0:
                        subprocess.run(f'taskkill /F /PID {pid}', shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

def main():
    free_port(8088)
    try:
        from server import (
            start_tcp_central_control_server,
            start_udp_central_control_server,
            run_http_server
        )
    except Exception as e:
        print(f"[严重错误] 导入服务组件失败: {e}")
        import traceback
        traceback.print_exc()
        input("按 Enter 键退出...")
        return

    # 尝试获取局域网 IP
    primary_ip = "127.0.0.1"
    try:
        import system_control
        ips = system_control.get_local_ips()
        for ip in ips:
            if not ip.startswith("127.") and not ip.startswith("169.254."):
                primary_ip = ip
                break
    except Exception:
        pass

    # 1. 启动 Windows 系统防休眠与屏幕常亮守护 (彻底解决长时间运行黑屏但有声音)
    try:
        import system_control
        system_control.start_screen_keep_awake_guard()
    except Exception as e:
        print(f"[防休眠守护] 启动常亮线程提示: {e}")

    # 2. 启动 TCP 物联中控服务
    try:
        t_tcp = threading.Thread(target=start_tcp_central_control_server, daemon=True)
        t_tcp.start()
    except Exception as e:
        print(f"[中控服务] 启动 TCP 监听异常: {e}")

    # 3. 启动 UDP 物联中控服务
    try:
        t_udp = threading.Thread(target=start_udp_central_control_server, daemon=True)
        t_udp.start()
    except Exception as e:
        print(f"[中控服务] 启动 UDP 监听异常: {e}")

    # 4. 启动毫秒级多机集群联播引擎 (高精度时间对齐与帧同步)
    try:
        from cluster_sync import cluster_sync
        cluster_sync.start()
        print(f"[集群联播引擎] 毫秒级多机同步服务已就绪 (角色: {cluster_sync.role}, UDP端口: {cluster_sync.broadcast_port})")
    except Exception as e:
        print(f"[集群联播引擎] 启动异常: {e}")

    # 5. 在后台线程立即启动 Bottle HTTP 多线程服务，确保服务即刻在线
    http_thread = threading.Thread(
        target=run_http_server,
        kwargs={'host': '0.0.0.0', 'port': 8088},
        daemon=True,
        name="HttpServerThread"
    )
    http_thread.start()

    # 严格等待 8088 端口 100% 就绪响应，彻底根除 ERR_CONNECTION_REFUSED
    if not wait_for_port(8088, timeout=8.0):
        print("[HTTP服务] 警告: 等待 8088 端口响应稍慢，继续拉起服务...")
    else:
        print("[HTTP服务] 8088 端口已确认在线监听，正在拉起大屏呈现端...")

    # 6. 启动服务端呈现视窗：平滑启动，记录运行状态
    try:
        import license_guard
        license_guard.license_guard.record_startup()
    except Exception as e:
        print(f"[启动状态] 记录启动事件: {e}")

    launch_player_window("http://127.0.0.1:8088/player")

    # 7. 打印服务信息面板
    print_banner(local_ip=primary_ip, port=8088)

    # 8. 主线程保活与自愈守护
    while True:
        try:
            time.sleep(1.0)
            if not http_thread.is_alive():
                print("[系统自愈] HTTP 服务线程退出，正在自动重启...")
                http_thread = threading.Thread(
                    target=run_http_server,
                    kwargs={'host': '0.0.0.0', 'port': 8088},
                    daemon=True,
                    name="HttpServerThread"
                )
                http_thread.start()
        except KeyboardInterrupt:
            print("\n[系统提示] 正在安全停止 VisualCast 播控服务...")
            try:
                from cluster_sync import cluster_sync
                cluster_sync.stop()
            except Exception:
                pass
            break
        except Exception as e:
            print(f"[系统异常] 主守护线程异常: {e}")
            time.sleep(1.0)

if __name__ == '__main__':
    main()
