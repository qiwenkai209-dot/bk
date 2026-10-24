# -*- coding: utf-8 -*-
"""
VisualCast 核心后台服务 (Bottle HTTP Server + 集中调度协调器)
提供:
1. 静态大屏端 (/player) 与 Web 后台管理端 (/) 路由
2. 素材库全生命周期 RESTful API (上传、删除、列表、缩略图)
3. 大屏双向状态机同步与毫秒级播控调度
4. 实时大屏镜像回显流 (Visual Mirror Echo)
5. 展馆环境设备中控与宏流水线调度
6. 系统运维直接控制 (关机/重启/音量/键盘/拉起外部APP)
7. 外部硬件中控 TCP 8000 / UDP 8001 监听服务
"""

import os
import sys
import json
import time
import socket
import threading
import shutil
import hashlib
import secrets
import base64
from concurrent.futures import ThreadPoolExecutor
import bottle
from bottle import Bottle, request, response, static_file, run, ServerAdapter, HTTPResponse
# 解除 Bottle 默认 100KB 的内存流限制，扩展为 1GB 内存缓冲区，极大加速大视频及高清图片批量上传
bottle.BaseRequest.MEMFILE_MAX = 1024 * 1024 * 1024
from wsgiref.simple_server import make_server, WSGIServer, WSGIRequestHandler
import webview
from logger_service import sys_logger, log_event

# 确保在 Python 进程层面彻底解除 127.0.0.1 的系统代理拦截
os.environ['NO_PROXY'] = 'localhost,127.0.0.1,0.0.0.0'
os.environ['no_proxy'] = 'localhost,127.0.0.1,0.0.0.0'

class ThreadPoolWSGIServer(WSGIServer):
    daemon_threads = True
    multithread = True

    def __init__(self, *args, max_workers=32, **kwargs):
        super().__init__(*args, **kwargs)
        self.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="VisualCastWSGI")

    def process_request(self, request, client_address):
        """将客户端连接提交给线程池处理；线程池繁忙时自动降级拉起轻量独立守护线程，永不阻塞主调度"""
        try:
            self.executor.submit(self.process_request_thread, request, client_address)
        except Exception:
            threading.Thread(target=self.process_request_thread, args=(request, client_address), daemon=True).start()

    def process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            pass
        finally:
            try:
                self.shutdown_request(request)
            except Exception:
                pass

    def finish_request(self, request, client_address):
        try:
            # 开启 TCP_NODELAY 降低小数据包延迟
            request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        try:
            super().finish_request(request, client_address)
        except Exception:
            pass

    def handle_error(self, request, client_address):
        # 绝不让网络层面的断开错误 (WinError 10054, BrokenPipe 等) 打印到可能关闭的 stderr，防止引起二次进程崩溃
        pass

    def server_close(self):
        try:
            super().server_close()
        except Exception:
            pass
        try:
            self.executor.shutdown(wait=False)
        except Exception:
            pass

class QuietWSGIRequestHandler(WSGIRequestHandler):
    def log_message(self, format, *args):
        pass  # 静默模式，防止日志刷屏

    def handle(self):
        try:
            super().handle()
        except Exception:
            pass

    def finish(self):
        try:
            super().finish()
        except Exception:
            pass

class ThreadedServerAdapter(ServerAdapter):
    """高性能固定容量线程池 WSGI 服务器适配器，支持毫秒级低延迟响应、溢出自适应与崩溃自愈守护"""
    def run(self, handler):
        while True:
            try:
                server = make_server(self.host, self.port, handler, server_class=ThreadPoolWSGIServer, handler_class=QuietWSGIRequestHandler)
                server.serve_forever()
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"[WSGI Server 自愈引擎] 检测到异常，0.5秒内自动恢复重启: {e}")
                time.sleep(0.5)

import system_control
from iot_engine import iot_engine
from usb_sync import USBSyncManager, SUPPORTED_EXTS
from license_guard import license_guard
from cluster_sync import cluster_sync
from scheduled_shutdown import scheduled_shutdown_manager
from device_manager import device_discovery_manager

if getattr(sys, 'frozen', False):
    EXE_DIR = os.path.dirname(sys.executable)
    BUNDLE_DIR = getattr(sys, '_MEIPASS', EXE_DIR)
else:
    EXE_DIR = os.path.dirname(os.path.abspath(__file__))
    BUNDLE_DIR = EXE_DIR

# 动态读写目录 (位于 EXE 旁，支持上传与持久化)
MEDIA_DIR = os.path.join(EXE_DIR, 'media')
CONFIG_DIR = os.path.join(EXE_DIR, 'config')
PLAYER_CFG_PATH = os.path.join(CONFIG_DIR, 'player_config.json')
CUSTOM_MEDIA_PATH = os.path.join(CONFIG_DIR, 'custom_media.json')

# 自动合并迁移旧目录：将 media/网页/ 与 media/流码/ 中的文件合并到 media/网页_流码/
try:
    target_web_stream = os.path.join(MEDIA_DIR, '网页_流码')
    os.makedirs(target_web_stream, exist_ok=True)
    for old_sub in ['网页', '流码']:
        old_dir = os.path.join(MEDIA_DIR, old_sub)
        if os.path.exists(old_dir) and os.path.isdir(old_dir):
            for f in os.listdir(old_dir):
                src_f = os.path.join(old_dir, f)
                dst_f = os.path.join(target_web_stream, f)
                if os.path.isfile(src_f) and not os.path.exists(dst_f):
                    try: shutil.move(src_f, dst_f)
                    except Exception: pass
            try: os.rmdir(old_dir)
            except Exception: pass
except Exception:
    pass

def load_custom_media():
    if os.path.exists(CUSTOM_MEDIA_PATH):
        try:
            with open(CUSTOM_MEDIA_PATH, 'r', encoding='utf-8') as f:
                items = json.load(f)
                changed = False
                for it in items:
                    u = str(it.get('url', '')).lower().split('?')[0]
                    # 若包含流媒体特征，强制自愈为 stream，杜绝误作 web iframe 打开触发外部播放器弹窗与黑屏
                    if any(u.endswith(ext) or (ext in u) for ext in ['.m3u8', '.flv', '.ts', '.mpd']) or u.startswith(('rtsp://', 'rtmp://')):
                        if it.get('type') != 'stream':
                            it['type'] = 'stream'
                            changed = True
                if changed:
                    try:
                        save_custom_media(items)
                    except Exception:
                        pass
                return items
        except Exception:
            pass
    return []

def save_custom_media(items):
    with open(CUSTOM_MEDIA_PATH, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

AUTH_CONFIG_PATH = os.path.join(CONFIG_DIR, 'auth_config.json')

class AuthManager:
    """管理后台轻量级鉴权管理器 (SHA256加盐存储，会话Token管控)"""
    def __init__(self, config_path=AUTH_CONFIG_PATH):
        self.config_path = config_path
        self.lock = threading.Lock()
        self.active_sessions = {}  # token: expire_timestamp
        self.load_config()

    def _hash_password(self, password, salt):
        return hashlib.sha256((salt + password).encode('utf-8')).hexdigest()

    def load_config(self):
        with self.lock:
            if not os.path.exists(self.config_path):
                salt = secrets.token_hex(8)
                self.config = {
                    "enabled": True,
                    "salt": salt,
                    "password_hash": self._hash_password("admin888", salt),
                    "session_expire_hours": 168  # 默认 7 天免登录
                }
                self.save_config_locked()
            else:
                try:
                    with open(self.config_path, 'r', encoding='utf-8') as f:
                        self.config = json.load(f)
                except Exception:
                    salt = secrets.token_hex(8)
                    self.config = {
                        "enabled": True,
                        "salt": salt,
                        "password_hash": self._hash_password("admin888", salt),
                        "session_expire_hours": 168
                    }

    def save_config_locked(self):
        try:
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            with open(self.config_path, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[AuthManager] 保存配置失败: {e}")

    def verify_password(self, password):
        if not self.config.get("enabled", True):
            return True
        salt = self.config.get("salt", "")
        expected = self.config.get("password_hash", "")
        return self._hash_password(password, salt) == expected

    def change_password(self, old_password, new_password):
        if not new_password or len(new_password) < 4:
            return {"status": "error", "message": "新密码长度至少需要4位"}
        with self.lock:
            if self.config.get("enabled", True) and not self.verify_password(old_password):
                return {"status": "error", "message": "原密码不正确"}
            salt = secrets.token_hex(8)
            self.config["salt"] = salt
            self.config["password_hash"] = self._hash_password(new_password, salt)
            self.save_config_locked()
            self.active_sessions.clear()
            return {"status": "ok", "message": "密码修改成功，请使用新密码登录"}

    def create_session(self):
        token = secrets.token_urlsafe(32)
        expire_hours = self.config.get("session_expire_hours", 168)
        expire_time = time.time() + expire_hours * 3600
        with self.lock:
            now = time.time()
            self.active_sessions = {k: v for k, v in self.active_sessions.items() if v > now}
            self.active_sessions[token] = expire_time
        return token

    def validate_token(self, token):
        if not self.config.get("enabled", True):
            return True
        if not token:
            return False
        with self.lock:
            now = time.time()
            exp = self.active_sessions.get(token)
            if exp and exp > now:
                return True
            if token in self.active_sessions:
                del self.active_sessions[token]
        return False

    def revoke_session(self, token):
        with self.lock:
            if token in self.active_sessions:
                del self.active_sessions[token]

auth_manager = AuthManager()

# 静态内置资源目录 (支持源码调试与 PyInstaller 解压只读目录)
STATIC_DIR = os.path.join(EXE_DIR, 'static')
if not os.path.exists(STATIC_DIR):
    STATIC_DIR = os.path.join(BUNDLE_DIR, 'static')

ASSETS_DIR = os.path.join(EXE_DIR, 'assets')
if not os.path.exists(ASSETS_DIR):
    ASSETS_DIR = os.path.join(BUNDLE_DIR, 'assets')

os.makedirs(MEDIA_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(CONFIG_DIR, exist_ok=True)

def migrate_legacy_media_dirs(media_dir):
    """自动将旧版 PPT_PDF / 网页 / 流码 迁移归并至标准 6 大分类目录"""
    if not os.path.exists(media_dir):
        return
    for std in ['待机', '音乐', '图片', '视频', '文档', '网页_流码']:
        os.makedirs(os.path.join(media_dir, std), exist_ok=True)
    # 迁移旧版 PPT_PDF -> 文档
    old_doc = os.path.join(media_dir, 'PPT_PDF')
    target_doc = os.path.join(media_dir, '文档')
    if os.path.exists(old_doc) and os.path.isdir(old_doc):
        for f in os.listdir(old_doc):
            src = os.path.join(old_doc, f)
            dst = os.path.join(target_doc, f)
            if not os.path.exists(dst):
                try: shutil.move(src, dst)
                except Exception: pass
            else:
                try: os.remove(src)
                except Exception: pass
        try: os.rmdir(old_doc)
        except Exception: pass

    # 迁移合并旧版 网页、流码 -> 网页_流码
    target_web_stream = os.path.join(media_dir, '网页_流码')
    for old_name in ['网页', '流码']:
        old_folder = os.path.join(media_dir, old_name)
        if os.path.exists(old_folder) and os.path.isdir(old_folder):
            for f in os.listdir(old_folder):
                src = os.path.join(old_folder, f)
                dst = os.path.join(target_web_stream, f)
                if not os.path.exists(dst):
                    try: shutil.move(src, dst)
                    except Exception: pass
                else:
                    try: os.remove(src)
                    except Exception: pass
            try: os.rmdir(old_folder)
            except Exception: pass

try:
    migrate_legacy_media_dirs(MEDIA_DIR)
except Exception as _me:
    print(f"[server] 迁移历史素材目录提示: {_me}")


class PlayerCoordinator:
    """大屏播控状态机与双向同步协调中枢"""
    def __init__(self):
        self.lock = threading.RLock()
        self.pending_commands = []   # 等待大屏端取走的指令队列
        self.latest_echo_frame = ""  # 大屏端上传的最新压缩 base64 画面帧
        self.latest_echo_time = 0
        self.player_window = None    # pywebview 窗口实例引用
        
        self.last_echo_request_time = 0.0  # 最近一次 Web 后台拉取回显的时间戳
        
        self.is_fullscreen_mode = True  # 默认为展馆全屏置顶模式
        
        # 默认大屏状态
        self.status = {
            "state": "IDLE",         # IDLE, PLAYING, PAUSED, STOPPED
            "current_media": "demo_show.mp4",
            "current_time": 0.0,
            "duration": 0.0,
            "volume": 85,
            "muted": False,
            "loop": True,            # 播放模式：True 为循环播放，False 为单次播放 (播完回待机)
            "loop_mode": "FOLDER_LOOP", # FOLDER_LOOP (文件夹循环) / SINGLE_LOOP (单个循环) / ALL_LOOP (全部循环) / PLAY_ONCE (播放一次)
            "current_folder": "",    # 当前循环的子文件夹 (空字符串为默认根目录)
            "startup_mode": "FOLDER_LOOP", # 开机默认循环模式
            "startup_folder": "",    # 开机默认播放文件夹
            "startup_auto_play": False, # 开机是否自动循环播放 (为防个别视频解码异常崩溃，默认不开机自启起播，开机静止就绪)
            "scale_mode": "fill",    # 画面拉伸模式：fill (全屏拉伸铺满无黑边) / contain (等比原始比例) / cover (裁切铺满)
            "orientation": "landscape", # 屏幕显示方向：landscape (横屏 16:9) / portrait (竖屏 9:16)
            "selected_ip": "",       # 用户手动指定的受控端通信网卡 IP
            "blackout": False,
            "freeze": False,
            "fullscreen": True,      # 是否全屏置顶
            "mode": "ATTRACT",       # ATTRACT (待机轮播) / ON_DEMAND (点播插播)
            "idle_media": "demo_show.mp4",
            "idle_timeout": 60,      # 点播后无操作超时自动复位秒数 (0 为不复位)
            "subtitle": {
                "enabled": False,
                "text": "欢迎光临 VisualCast 智慧多媒体展厅",
                "position": "bottom", # top, center, bottom
                "font_size": 42,
                "color": "#ffffff",
                "bg_color": "rgba(0, 0, 0, 0.6)",
                "speed": 20           # 跑马灯滚动周期秒数，0 为静止居中
            },
            "last_activity_time": time.time(),
            "last_heartbeat": time.time(),
            "touch_mode": False      # 触摸交互模式：True 时大屏端浮现交互窗口与按键，False 时彻底关闭隐藏
        }
        self.load_player_config()

    def set_touch_mode(self, enabled: bool):
        """开启或关闭大屏端触摸交互模式 (驱动大屏悬浮交互按钮显隐)"""
        with self.lock:
            self.status["touch_mode"] = bool(enabled)
            self.pending_commands.append({
                "command": "SET_TOUCH_MODE",
                "params": {"touch_mode": bool(enabled)},
                "timestamp": time.time()
            })
            self.save_player_config()
            return self.status["touch_mode"]

    def set_window(self, win):
        self.player_window = win

    def record_echo_request(self):
        """记录 Web 端监视活跃时间"""
        with self.lock:
            self.last_echo_request_time = time.time()

    def need_echo(self):
        """判定当前是否有活跃的管理员在查看实时回显 (<4.5秒)"""
        with self.lock:
            return (time.time() - self.last_echo_request_time) < 4.5

    def toggle_fullscreen(self):
        """切换大屏全屏与 1280×720 居中运维模式 (退出全屏时自动还原为居中独立窗口并解除置顶露出任务栏)"""
        target_mode = not getattr(self, 'is_fullscreen_mode', True)
        return self.set_fullscreen_mode(target_mode)

    def set_fullscreen_mode(self, is_fullscreen: bool):
        """设定大屏窗口模式 (全屏置顶 或 居中运维模式)"""
        with self.lock:
            self.is_fullscreen_mode = is_fullscreen
            self.status["fullscreen"] = is_fullscreen
            target_idx = self.status.get("target_screen_index", 0)
            res_cfg = self.config.get("resolution", {})
        
        # 调用底层 Windows API 进行精准的居中/置顶控制 (无 GIL 锁竞争)
        mode_res = system_control.set_player_window_mode(
            is_fullscreen,
            self.player_window,
            target_screen_index=target_idx,
            config_resolution=res_cfg
        )
        if isinstance(mode_res, dict) and mode_res.get("width"):
            with self.lock:
                self.status["width"] = mode_res["width"]
                self.status["height"] = mode_res["height"]
        
        # 同步持久化配置
        try:
            pos = self.config.setdefault("position", {})
            pos["fullscreen"] = is_fullscreen
            self.save_player_config()
        except Exception:
            pass
        return self.is_fullscreen_mode

    def load_player_config(self):
        if not os.path.exists(PLAYER_CFG_PATH):
            bundle_cfg = os.path.join(BUNDLE_DIR, 'config', 'player_config.json')
            if os.path.exists(bundle_cfg):
                try:
                    os.makedirs(os.path.dirname(PLAYER_CFG_PATH), exist_ok=True)
                    shutil.copy(bundle_cfg, PLAYER_CFG_PATH)
                except Exception:
                    pass
        if os.path.exists(PLAYER_CFG_PATH):
            try:
                with open(PLAYER_CFG_PATH, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                    self.config = cfg
                    pb = cfg.get("playback", {})
                    self.status["volume"] = pb.get("volume", 85)
                    self.status["muted"] = pb.get("muted", False)
                    self.status["touch_mode"] = pb.get("touch_mode", False)
                    self.status["current_media"] = pb.get("current_media", "demo_show.mp4")
                    self.status["mode"] = pb.get("mode", "ATTRACT")
                    self.status["idle_media"] = pb.get("idle_media", "demo_show.mp4")
                    self.status["idle_timeout"] = pb.get("idle_timeout", 60)
                    self.status["scale_mode"] = pb.get("scale_mode", "fill")
                    self.status["loop"] = pb.get("loop", True)
                    self.status["loop_mode"] = pb.get("loop_mode", "FOLDER_LOOP")
                    self.status["current_folder"] = pb.get("current_folder", "")
                    self.status["startup_mode"] = pb.get("startup_mode", "FOLDER_LOOP")
                    self.status["startup_folder"] = pb.get("startup_folder", "")
                    self.status["orientation"] = pb.get("orientation", "landscape")
                    self.status["selected_ip"] = pb.get("selected_ip", "")
                    self.status["switch_policy"] = pb.get("switch_policy", "FINISHED")
                    self.status["cycle_duration"] = int(pb.get("cycle_duration", 30))
                    
                    sub = cfg.get("subtitle", {})
                    self.status["subtitle"] = {
                        "enabled": bool(sub.get("enabled", False)),
                        "text": sub.get("text", "欢迎光临 VisualCast 智慧多媒体展厅"),
                        "position": sub.get("position", "bottom"),
                        "font_size": int(sub.get("font_size", 42)),
                        "color": sub.get("color", "#ffffff"),
                        "bg_color": sub.get("bg_color", "rgba(0, 0, 0, 0.6)"),
                        "transparent_bg": bool(sub.get("transparent_bg", True)),
                        "speed": int(sub.get("speed", 20)),
                        "mode": sub.get("mode", "static" if int(sub.get("speed", 20)) == 0 else "marquee")
                    }
                    pos = cfg.get("position", {})
                    self.status["target_screen_index"] = int(pos.get("monitor_index", 0))
                    self.is_fullscreen_mode = True
                    self.status["fullscreen"] = True
                    sys_cfg = cfg.get("system", {})
                    stream_q = sys_cfg.get("stream_quality", "720p")
                    self.status["stream_quality"] = stream_q
                    try:
                        system_control.screen_stream_manager.set_preset(stream_q)
                    except Exception:
                        pass
                    self._ensure_valid_media()
                    return
            except Exception as e:
                print(f"[PlayerCoordinator] 读取配置错误: {e}")
        self.config = {
            "resolution": {"preset": "1920x1080", "width": 1920, "height": 1080},
            "position": {"x": 0, "y": 0, "monitor_index": 0, "fullscreen": False},
            "playback": {
                "current_media": "demo_show.mp4",
                "volume": 85,
                "muted": False,
                "loop": True,
                "loop_mode": "FOLDER_LOOP",
                "current_folder": "",
                "startup_mode": "FOLDER_LOOP",
                "startup_folder": "",
                "startup_auto_play": False,
                "scale_mode": "fill",
                "mode": "ATTRACT",
                "idle_media": "demo_show.mp4",
                "idle_timeout": 60
            },
            "subtitle": {
                "enabled": False,
                "text": "欢迎光临 VisualCast 智慧多媒体展厅",
                "position": "bottom",
                "font_size": 42,
                "color": "#ffffff",
                "bg_color": "rgba(0, 0, 0, 0.6)",
                "speed": 20
            },
            "external_apps": [
                {"id": "app_01", "name": "3D数字展项互动沙盘", "path": "C:\\Windows\\notepad.exe", "args": "", "desc": "Unity数字交互引擎"},
                {"id": "app_02", "name": "多媒体课件PPT演示", "path": "C:\\Windows\\write.exe", "args": "", "desc": "展厅宣讲专用文稿"}
            ]
        }
        self._ensure_valid_media()

    def _ensure_valid_media(self):
        # 智能素材探测与自愈：开机默认循环播放待机文件夹内容，支持多种媒体格式混合轮播
        self.status["startup_folder"] = "待机"
        self.status["current_folder"] = "待机"
        self.status["mode"] = "ATTRACT"

        # 优先保留用户持久化设置的循环模式 (固化配置)，仅当未定义时默认 FOLDER_LOOP
        saved_lm = self.config.get("playback", {}).get("loop_mode")
        if saved_lm in ["FOLDER_LOOP", "SINGLE_LOOP", "ALL_LOOP", "PLAY_ONCE"]:
            self.status["loop_mode"] = saved_lm
            self.status["loop"] = (saved_lm != "PLAY_ONCE")
        else:
            self.status["loop_mode"] = "FOLDER_LOOP"
            self.status["loop"] = True

        # 优先从本地 待机 文件夹获取可用素材
        standby_dir = os.path.join(MEDIA_DIR, '待机')
        standby_files = []
        if os.path.exists(standby_dir):
            for fname in sorted(os.listdir(standby_dir)):
                if fname.startswith('.') or fname.endswith('.trans_tmp') or fname.startswith('~$'):
                    continue
                standby_files.append(f"待机/{fname}")

        curr = self.status.get("current_media", "")
        curr_path = os.path.join(MEDIA_DIR, curr) if curr else ""
        if not curr or not os.path.exists(curr_path):
            if standby_files:
                best_media = standby_files[0]
            else:
                available = []
                if os.path.exists(MEDIA_DIR):
                    for root, dirs, files in os.walk(MEDIA_DIR):
                        for fname in files:
                            if fname.endswith('.trans_tmp') or fname.startswith('.') or fname.startswith('~$'):
                                continue
                            rel_d = os.path.relpath(root, MEDIA_DIR)
                            rel_name = fname if rel_d == '.' else f"{rel_d.replace(os.sep, '/')}/{fname}"
                            available.append(rel_name)
                best_media = available[0] if available else "default_standby.jpg"

            self.status["current_media"] = best_media
            self.status["idle_media"] = best_media
            self.config.setdefault("playback", {})["current_media"] = best_media
            self.config.setdefault("playback", {})["idle_media"] = best_media
            self.config.setdefault("playback", {})["startup_folder"] = "待机"
            self.config.setdefault("playback", {})["current_folder"] = "待机"
            self.config.setdefault("playback", {})["startup_mode"] = "FOLDER_LOOP"
            try:
                self.save_player_config()
            except Exception:
                pass
            print(f"[PlayerCoordinator] 默认开机待机素材已锁定: {best_media} (待机文件夹)")

    def return_to_standby(self, send_command=True):
        """退出当前点播/放映，无缝恢复待机文件夹的连续循环轮播"""
        with self.lock:
            self.status["mode"] = "ATTRACT"
            self.status["current_folder"] = "待机"
            self.status["loop_mode"] = "FOLDER_LOOP"
            self.status["loop"] = True
            self.status["state"] = "PLAYING"
            self.status["blackout"] = False
            self.status["freeze"] = False

            standby_dir = os.path.join(MEDIA_DIR, '待机')
            first_media = None
            if os.path.exists(standby_dir):
                for f in sorted(os.listdir(standby_dir)):
                    if not f.startswith('.') and not f.startswith('~$') and not f.endswith('.trans_tmp'):
                        first_media = f"待机/{f}"
                        break
            # 若待机文件夹无素材，智能递归扫描整个媒体库中的第一个有效视频/图片素材
            if not first_media:
                for root, dirs, files in os.walk(MEDIA_DIR):
                    for f in sorted(files):
                        ext = os.path.splitext(f)[1].lower()
                        if ext in ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.jpg', '.jpeg', '.png', '.webp'] and not f.startswith('.') and not f.startswith('~$'):
                            rel_path = os.path.relpath(os.path.join(root, f), MEDIA_DIR).replace('\\', '/')
                            first_media = rel_path
                            break
                    if first_media:
                        break
            if not first_media:
                first_media = "default_standby.jpg"
            self.status["current_media"] = first_media
            self.status["idle_media"] = first_media
            self.status["current_time"] = 0.0

        # 清理可能残留的外部放映进程并恢复大屏置顶
        system_control.close_ppt_process()

        # 下发恢复待机轮播指令给大屏端
        if send_command:
            self.handle_command("LOAD_AND_PLAY", {
                "media": first_media,
                "folder": "待机",
                "mode": "ATTRACT"
            })
        print(f"[PlayerCoordinator] 已退出放映，成功恢复待机文件夹轮播: {first_media}")
        return {"status": "ok", "message": "已返回待机文件夹循环播放", "media": first_media}

    def save_player_config(self):
        # 自动将 status 中的最新播控与待机配置同步回 config 字典以持久化
        pb = self.config.setdefault("playback", {})
        pb["volume"] = self.status.get("volume", 85)
        pb["muted"] = self.status.get("muted", False)
        pb["touch_mode"] = self.status.get("touch_mode", False)
        pb["current_media"] = self.status.get("current_media", "demo_show.mp4")
        pb["mode"] = self.status.get("mode", "ATTRACT")
        pb["idle_media"] = self.status.get("idle_media", "demo_show.mp4")
        pb["idle_timeout"] = self.status.get("idle_timeout", 60)
        pb["scale_mode"] = self.status.get("scale_mode", "fill")
        pb["loop"] = self.status.get("loop", True)
        pb["loop_mode"] = self.status.get("loop_mode", "FOLDER_LOOP")
        pb["current_folder"] = self.status.get("current_folder", "")
        pb["startup_mode"] = self.status.get("startup_mode", "FOLDER_LOOP")
        pb["startup_folder"] = self.status.get("startup_folder", "")
        pb["startup_auto_play"] = self.status.get("startup_auto_play", False)
        pb["orientation"] = self.status.get("orientation", "landscape")
        pb["selected_ip"] = self.status.get("selected_ip", "")
        pb["switch_policy"] = self.status.get("switch_policy", "FINISHED")
        pb["cycle_duration"] = self.status.get("cycle_duration", 30)
        pos = self.config.setdefault("position", {})
        pos["monitor_index"] = self.status.get("target_screen_index", 0)
        sys_cfg = self.config.setdefault("system", {})
        sys_cfg["stream_quality"] = self.status.get("stream_quality", "720p")
        self.config["subtitle"] = self.status.get("subtitle", {})
        try:
            os.makedirs(os.path.dirname(PLAYER_CFG_PATH), exist_ok=True)
            with open(PLAYER_CFG_PATH, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[PlayerCoordinator] 保存播放器配置异常: {e}")

        # 集群联播联动：若本机为 MASTER 主机，自动向所有从机全量广播同步最新设置
        try:
            if 'cluster_sync' in globals() and getattr(cluster_sync, 'role', '') == "MASTER":
                cluster_sync.broadcast_full_config()
        except Exception:
            pass

    def set_target_screen(self, screen_index: int):
        """设置大屏所在的物理屏幕，并实时通过 Win32 API 跨屏移动全屏"""
        screen_index = int(screen_index)
        monitors = system_control.get_monitors()
        if 0 <= screen_index < len(monitors):
            target_m = monitors[screen_index]
            with self.lock:
                self.status["target_screen_index"] = screen_index
                self.status["width"] = target_m["width"]
                self.status["height"] = target_m["height"]
                if "position" not in self.config:
                    self.config["position"] = {}
                self.config["position"]["x"] = target_m["x"]
                self.config["position"]["y"] = target_m["y"]
                self.config["position"]["target_screen_index"] = screen_index
                if "resolution" not in self.config:
                    self.config["resolution"] = {}
                self.config["resolution"]["width"] = target_m["width"]
                self.config["resolution"]["height"] = target_m["height"]
                self.save_player_config()

        hwnd = system_control.find_player_window_hwnd()
        success = False
        if hwnd:
            success = system_control.apply_window_to_monitor(hwnd, screen_index, fullscreen=True)
            print(f"[coordinator] set_target_screen: 目标屏幕={screen_index+1}, hwnd={hwnd}, 移动结果={success}")
        else:
            print(f"[coordinator] set_target_screen: 未查找到大屏窗口 HWND，已持久化目标屏幕配置")
            success = True

        if getattr(self, 'player_window', None):
            try:
                monitors = system_control.get_monitors()
                if 0 <= screen_index < len(monitors):
                    m = monitors[screen_index]
                    self.player_window.move(m['x'], m['y'])
                    success = True
            except Exception:
                pass
        return bool(success)

    def set_stream_quality(self, preset: str):
        """设置推流清晰度档位 (360p, 720p, 1080p) 并持久化"""
        with self.lock:
            self.status["stream_quality"] = preset
            self.save_player_config()
        return system_control.screen_stream_manager.set_preset(preset)

    def handle_command(self, cmd_type, params=None):
        """Web 后台下发播控指令，放入队列等待大屏端实时拉取"""
        if params is None:
            params = {}
        cmd_item = {
            "id": int(time.time() * 1000),
            "type": cmd_type,
            "params": params
        }
        try:
            log_event("PLAY", f"播控指令下发: {cmd_type} | 参数: {json.dumps(params, ensure_ascii=False)}")
        except Exception:
            pass
        with self.lock:
            self.status["last_activity_time"] = time.time()
            self.pending_commands.append(cmd_item)
            # 立即更新本地影子状态
            if cmd_type == "PLAY":
                old_state = self.status.get("state")
                self.status["state"] = "PLAYING"
                self.status["blackout"] = False
                self.status["freeze"] = False
                # 如果当前放映的是 PPT/文稿 且此前处于暂停态，发送按键 S 恢复放映
                curr_m = self.status.get("current_media", "").lower()
                if (curr_m.endswith(('.ppt', '.pptx')) or self.status.get("media_type") == "doc") and old_state == "PAUSED":
                    try:
                        system_control.send_keystroke('S')
                    except Exception:
                        pass
            elif cmd_type == "PAUSE":
                self.status["state"] = "PAUSED"
                # 如果当前放映的是 PPT/文稿，发送按键 S 暂停放映计时/排练
                curr_m = self.status.get("current_media", "").lower()
                if curr_m.endswith(('.ppt', '.pptx')) or self.status.get("media_type") == "doc":
                    try:
                        system_control.send_keystroke('S')
                    except Exception:
                        pass
            elif cmd_type == "STOP":
                self.status["state"] = "PAUSED"
                # 停止指令平稳暂停并清理外部 PPT 窗口进程
                try:
                    system_control.close_ppt_process()
                except Exception:
                    pass
            elif cmd_type == "SEEK":
                self.status["current_time"] = float(params.get("time", 0))
            elif cmd_type == "VOLUME":
                v = int(params.get("volume", 80))
                self.status["volume"] = v
                if v > 0:
                    self.status["muted"] = False
                self.save_player_config()
            elif cmd_type == "MUTE":
                self.status["muted"] = bool(params.get("muted", True))
                self.save_player_config()
            elif cmd_type == "SET_LOOP":
                lp = bool(params.get("loop", True))
                self.status["loop"] = lp
                if not lp:
                    self.status["loop_mode"] = "PLAY_ONCE"
                elif self.status.get("loop_mode") == "PLAY_ONCE":
                    self.status["loop_mode"] = "FOLDER_LOOP"
                self.save_player_config()
            elif cmd_type == "SET_LOOP_MODE":
                lm = params.get("loop_mode", "FOLDER_LOOP")
                if lm in ["FOLDER_LOOP", "SINGLE_LOOP", "ALL_LOOP", "PLAY_ONCE"]:
                    self.status["loop_mode"] = lm
                    self.status["loop"] = (lm != "PLAY_ONCE")
                    if "folder" in params:
                        self.status["current_folder"] = params.get("folder", "")
                    self.save_player_config()
            elif cmd_type == "SET_CYCLE_POLICY":
                pol = params.get("switch_policy", "FINISHED")
                if pol in ["FINISHED", "DURATION"]:
                    self.status["switch_policy"] = pol
                if "duration" in params:
                    try:
                        self.status["cycle_duration"] = max(3, int(params["duration"]))
                    except Exception:
                        pass
                self.save_player_config()
            elif cmd_type == "PLAY_FOLDER":
                folder = params.get("folder", "")
                lm = params.get("loop_mode", "FOLDER_LOOP")
                self.status["current_folder"] = folder
                self.status["loop_mode"] = lm
                self.status["loop"] = (lm != "PLAY_ONCE")
                if "media" in params:
                    self.status["current_media"] = params["media"]
                self.status["state"] = "PLAYING"
                self.status["blackout"] = False
                self.save_player_config()
            elif cmd_type == "UPDATE_SUBTITLE":
                sub = self.status.setdefault("subtitle", {})
                for k in ["enabled", "text", "position", "font_size", "color", "bg_color", "speed", "mode", "transparent_bg"]:
                    if k in params:
                        sub[k] = params[k]
                self.save_player_config()
            elif cmd_type == "TOGGLE_SUBTITLE":
                sub = self.status.setdefault("subtitle", {})
                sub["enabled"] = not sub.get("enabled", False)
                self.save_player_config()
            elif cmd_type == "SET_SCALE_MODE":
                sm = params.get("scale_mode", "fill")
                if sm in ["fill", "contain", "cover"]:
                    self.status["scale_mode"] = sm
                    self.save_player_config()
            elif cmd_type == "SET_ORIENTATION":
                ori = params.get("orientation", "landscape")
                if ori in ["landscape", "portrait", "portrait_cw", "portrait_ccw"]:
                    self.status["orientation"] = ori
                    self.save_player_config()
            elif cmd_type == "SET_TOUCH_MODE":
                tm = bool(params.get("touch_mode", False))
                self.status["touch_mode"] = tm
                self.save_player_config()
            elif cmd_type == "BLACKOUT":
                self.status["blackout"] = bool(params.get("blackout", True))
            elif cmd_type == "FREEZE":
                self.status["freeze"] = bool(params.get("freeze", True))
            elif cmd_type == "RETURN_TO_IDLE":
                # 切回待机背景轮播
                idle_target = self.status.get("idle_media", "demo_show.mp4")
                self.status["mode"] = "ATTRACT"
                self.status["current_media"] = idle_target
                self.status["current_time"] = 0.0
                self.status["state"] = "PLAYING"
                self.status["blackout"] = False
                self.status["freeze"] = False
                params["media"] = idle_target
                cmd_item["params"] = params
                try:
                    system_control.close_ppt_process()
                except Exception:
                    pass
            elif cmd_type in ["LOAD", "LOAD_AND_PLAY", "SWITCH_MEDIA"]:
                if cmd_type == "SWITCH_MEDIA":
                    cmd_type = "LOAD_AND_PLAY"
                    cmd_item["type"] = "LOAD_AND_PLAY"
                media_name = params.get("media", "")
                mode = params.get("mode", "ON_DEMAND")
                self.status["mode"] = mode
                self.status["current_media"] = media_name
                self.status["current_time"] = 0.0
                if "folder" in params:
                    self.status["current_folder"] = params.get("folder", "")
                if cmd_type == "LOAD_AND_PLAY":
                    self.status["state"] = "PLAYING"
                    self.status["blackout"] = False
                
                # 自动计算与同步大屏当前 media_type，实现控制台按键毫秒级切换 (优先尊重 media_item 声明)
                media_item_obj = params.get("media_item")
                if isinstance(media_item_obj, dict) and media_item_obj.get("type"):
                    self.status["media_type"] = media_item_obj.get("type")
                else:
                    clean_name = media_name.split('?')[0]
                    ext = clean_name.split('.')[-1].lower() if '.' in clean_name else ''
                    if ext in ['pptx', 'ppt', 'pdf', 'doc', 'docx']:
                        self.status["media_type"] = "doc"
                    elif ext in ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']:
                        self.status["media_type"] = "image"
                    elif ext in ['mp3', 'wav', 'aac', 'flac', 'ogg']:
                        self.status["media_type"] = "audio"
                    elif ext in ['html', 'htm', 'm3u8', 'txt', 'url']:
                        self.status["media_type"] = "stream"
                    else:
                        self.status["media_type"] = "video"

                # 如果切换的不是 PPT，自动杀掉 PPT 外部进程
                m_lower = media_name.lower()
                if not (m_lower.endswith('.ppt') or m_lower.endswith('.pptx')):
                    try:
                        system_control.close_ppt_process()
                    except Exception:
                        pass
            elif cmd_type in ["DOC_PREV", "PAGE_PREV", "PREV"]:
                curr_m = self.status.get("current_media", "").lower()
                if curr_m.endswith('.ppt') or curr_m.endswith('.pptx') or curr_m.endswith('.pdf'):
                    try:
                        system_control.send_keystroke('PGUP')
                    except Exception:
                        pass
            elif cmd_type in ["DOC_NEXT", "PAGE_NEXT", "NEXT"]:
                curr_m = self.status.get("current_media", "").lower()
                if curr_m.endswith('.ppt') or curr_m.endswith('.pptx') or curr_m.endswith('.pdf'):
                    try:
                        system_control.send_keystroke('PGDN')
                    except Exception:
                        pass
            elif cmd_type in ["DOC_EXIT", "RETURN_STANDBY"]:
                try:
                    system_control.close_ppt_process()
                except Exception:
                    pass
                sb_res = self.return_to_standby()
                params["media"] = sb_res.get("media", self.status.get("current_media", ""))
                params["folder"] = "待机"
                cmd_item["params"] = params

        # 集群多机联播联动 (Master 模式下向全网从机广播指令)
        try:
            if cluster_sync.role == "MASTER":
                cluster_sync.broadcast_master_command(cmd_type, params)
        except Exception:
            pass

        return cmd_item

    def pull_commands_for_player(self):
        """大屏端调用此接口，一次性提取所有未执行指令，并获取按需抽帧与模式配置"""
        with self.lock:
            cmds = list(self.pending_commands)
            self.pending_commands.clear()
            need_echo = (time.time() - self.last_echo_request_time) < 4.5
            return (
                cmds, 
                need_echo, 
                self.status.get("mode", "ATTRACT"), 
                self.status.get("idle_media", "demo_show.mp4"), 
                self.status.get("idle_timeout", 60),
                self.status.get("scale_mode", "fill"),
                self.status.get("loop", True),
                self.status.get("loop_mode", "FOLDER_LOOP"),
                self.status.get("current_folder", ""),
                self.status.get("subtitle", {}),
                self.status.get("orientation", "landscape")
            )

    def update_player_report(self, report_data):
        """大屏端定时上报的实时进度与状态"""
        with self.lock:
            for k in ["state", "current_media", "current_time", "duration", "volume", "muted", "loop", "loop_mode", "current_folder", "scale_mode", "orientation", "blackout", "freeze"]:
                if k in report_data:
                    self.status[k] = report_data[k]
            self.status["last_heartbeat"] = time.time()

    def update_echo_frame(self, frame_data):
        """大屏端上传最新 WebP 截帧"""
        with self.lock:
            self.latest_echo_frame = frame_data
            self.latest_echo_time = time.time()

    def get_echo_frame(self):
        with self.lock:
            return self.latest_echo_frame, self.latest_echo_time

    def apply_display_settings(self, settings):
        """应用并保存大屏窗口坐标、分辨率、全屏与多屏幕切换"""
        if "monitor_index" in settings or "index" in settings:
            m_idx = int(settings.get("monitor_index") if "monitor_index" in settings else settings.get("index", 0))
            self.set_target_screen(m_idx)

        res = settings.get("resolution", {})
        pos = settings.get("position", {})
        if res: self.config["resolution"] = res
        if pos: self.config["position"] = pos
        self.save_player_config()

        # 通过原生 Win32 API 绝对安全调整窗口尺寸与全屏 (绝不调用 pywebview 跨线程 Invoke 杜绝死锁)
        try:
            w = int(res.get("width", 1920))
            h = int(res.get("height", 1080))
            x = int(pos.get("x", 0))
            y = int(pos.get("y", 0))
            fs = bool(pos.get("fullscreen", False))
            with self.lock:
                self.is_fullscreen_mode = fs
                self.status["fullscreen"] = fs
            target_mon_idx = self.status.get("target_screen_index", 0)
            system_control.apply_player_window_geometry(x, y, w, h, fs, monitor_index=target_mon_idx)
        except Exception as e:
            print(f"[PlayerCoordinator] 调整窗口失败: {e}")
        return True

coordinator = PlayerCoordinator()
cluster_sync.coordinator = coordinator
cluster_sync.start()

def _on_usb_start(event):
    drive = event.get("drive", "")
    print(f"[server] 收到 U 盘插入启动通知: drive={drive}")
    coordinator.handle_command("SHOW_TOAST", {
        "title": "U 盘接入",
        "message": f"💾 检测到 U 盘 [{drive}] 接入，正在读取同步素材...",
        "is_usb": True
    })

def _on_usb_synced(event):
    print(f"[server] 收到 U 盘热同步通知: {event}")
    count = event.get("count", 0)
    standby_up = event.get("standby_updated", False)
    files = event.get("files", [])
    if standby_up or count > 0:
        print(f"[server] U 盘更新了 {count} 个媒体素材 (待机覆盖={standby_up})，立即强制切回待机并自动开播！")
        try:
            coordinator._ensure_valid_media()
        except Exception:
            pass
        res = coordinator.return_to_standby(send_command=False)
        first_m = res.get("media") if isinstance(res, dict) else None

        # 优先选择本次更新的待机素材或首个媒体，若无待机则播放新导入的首个素材
        target_media = first_m
        if not standby_up and files:
            target_media = files[0]

        sync_msg = f"🎉 U 盘素材热更完成：更新 {count} 个文件，已恢复待机播放" if count > 0 else "💾 检测到 U 盘接入，已同步待机素材"
        # 唯一下发 REFRESH_LIBRARY_AND_PLAY 指令，驱动大屏端强制刷新媒体库并自动开播，附带清晰的 Toast 提示
        coordinator.handle_command("REFRESH_LIBRARY_AND_PLAY", {
            "media": target_media,
            "folder": "待机" if standby_up else (target_media.split('/')[0] if '/' in str(target_media) else "待机"),
            "loop_mode": "FOLDER_LOOP",
            "force_play": True,
            "force_reload": True,
            "is_usb": True,
            "count": count,
            "message": sync_msg,
            "timestamp": time.time()
        })
    else:
        coordinator.handle_command("SHOW_TOAST", {
            "title": "U 盘状态",
            "message": "💾 U 盘已识别，素材文件已是最新状态",
            "is_usb": True
        })

usb_sync_manager = USBSyncManager(target_media_dir=MEDIA_DIR, on_synced_callback=_on_usb_synced, on_start_callback=_on_usb_start)
usb_sync_manager.start()

# 绑定外部 PPT 放映视窗退出事件：联动恢复待机文件夹轮播
system_control.set_ppt_exit_callback(lambda: coordinator.return_to_standby())

app = Bottle()

# ===================== 身份鉴权与安全钩子 =====================

def get_current_token():
    token = request.get_cookie('vc_token')
    if not token:
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
        else:
            token = request.headers.get('X-Admin-Token', '').strip()
    return token

# 白名单免密路径列表 (大屏展示端绝对免密、手牌端免密、静态素材资源免密、大屏运维与回显状态免密)
AUTH_WHITELIST = (
    '/',
    '/admin',
    '/player',
    '/license',
    '/remote',
    '/static/',
    '/assets/',
    '/media/',
    '/api/auth/login',
    '/api/auth/status',
    '/api/player/sync',              # 大屏状态同步与指令拉取合一通道 (免密)
    '/api/player/command',           # 大屏轮询取指令
    '/api/player/state',             # 大屏端上报自身播放状态
    '/api/player/echo_frame',        # 大屏端上传镜像帧
    '/api/player/echo',              # 大屏回显拉取
    '/api/player/active_media',
    '/api/player/window_mode',
    '/api/player/toggle_fullscreen', # 大屏切换运维窗口模式
    '/api/player/keystroke',         # 大屏按键调用
    '/api/player/send_key',          # 大屏按键调用
    '/api/stream/',                  # ScreenStream 推流与帧快照通道
    '/api/stream/quality',           # 推流清晰度查询与切换
    '/api/system/monitors',          # 物理显示屏查询与切换
    '/api/system/network_interfaces',# 局域网所有网卡列表
    '/api/system/select_network_interface', # 选择通信网卡
    '/api/system/app_status',        # 应用存活状态查询
    '/api/system/usb_status',        # U盘热插拔状态查询
    '/api/system/usb_sync_now',      # U盘立即扫描
    '/api/system/hardware_status',   # 主机硬件健康状态 (CPU/内存/GPU)
    '/api/system/autostart',         # Windows 开机自启查询与切换
    '/api/system/license',           # 商业授权状态查询与激活
    '/api/system/volume',            # 系统主音量控制
    '/api/system/info',              # 主机信息与第三方应用
    '/api/system/launch_app',        # 启动第三方应用
    '/api/system/kill_app',          # 结束第三方应用
    '/api/system/restart',           # 重启主机
    '/api/system/shutdown',          # 关机
    '/api/auth/change_password',     # 管理员修改密码 (直接校验旧密码)
    '/api/vnc/',                     # VNC 服务运维与控制
    '/api/iot/',                     # IoT 设备与场景宏控制
    '/api/media',                    # 素材库读取
    '/api/media/',                   # 素材管理
    '/api/subtitle',                 # 顶层字幕配置
    '/api/player/status',            # 播放器全局状态
    '/api/player/return_to_standby', # 返回待机轮播
    '/api/player/return_idle',       # 返回待机
    '/api/sync/',                    # 多机集群联播与从机探测状态 (放行供局域网主从互联与检测)
    '/api/cluster/',                 # 集群控制别名通道
    '/api/slave'                     # 从机控制与探测别名
)

@app.hook('before_request')
def check_authentication():
    # 浏览器跨域预检请求 (CORS Preflight) 直接放行
    if request.method == 'OPTIONS':
        return

    path = request.path
    # 静态资源与大屏/手牌核心通道直接放行
    if any(path == wl or path.startswith(wl) for wl in AUTH_WHITELIST):
        return

    # 对后台所有管理与控制 API 实施登录鉴权校验
    if path.startswith('/api/'):
        token = get_current_token()
        if not auth_manager.validate_token(token):
            raise HTTPResponse(
                body=json.dumps({
                    "status": "error",
                    "message": "需要管理员权限，请先登录后台",
                    "need_login": True
                }, ensure_ascii=False),
                status=401,
                headers={'Content-Type': 'application/json; charset=utf-8'}
            )

@app.hook('after_request')
def add_cache_headers():
    # 全局 CORS 支持：允许局域网多设备 (iPad、移动手机、第三方中控机、跨端口调用) 发送异步请求
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Origin, Accept, Content-Type, Authorization, X-Admin-Token, Range'
    response.headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges'

    # 静态 JS/CSS 禁用强缓存，防止代码更新后前端加载旧缓存
    if request.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'

@app.route('/<:re:.*>', method=['OPTIONS'])
def options_handler():
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Origin, Accept, Content-Type, Authorization, X-Admin-Token, Range'
    response.headers['Access-Control-Max-Age'] = '86400'
    response.status = 204
    return ''


@app.route('/api/auth/status', method=['GET'])
def api_auth_status():
    token = get_current_token()
    is_authed = auth_manager.validate_token(token)
    return {
        "status": "ok",
        "authenticated": is_authed,
        "auth_enabled": auth_manager.config.get("enabled", True)
    }

@app.route('/api/auth/login', method=['POST'])
def api_auth_login():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    password = data.get("password", "").strip()
    if auth_manager.verify_password(password):
        token = auth_manager.create_session()
        response.set_cookie('vc_token', token, path='/', max_age=86400 * 7, httponly=False)
        return {
            "status": "ok",
            "message": "登录成功",
            "token": token
        }
    else:
        response.status = 401
        return {
            "status": "error",
            "message": "管理密码错误，请重新输入"
        }

@app.route('/api/auth/logout', method=['POST'])
def api_auth_logout():
    token = get_current_token()
    if token:
        auth_manager.revoke_session(token)
    response.delete_cookie('vc_token', path='/')
    return {"status": "ok", "message": "已安全退出后台"}

@app.route('/api/auth/change_password', method=['POST'])
def api_auth_change_password():
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        old_pwd = str(data.get("old_password", "")).strip()
        new_pwd = str(data.get("new_password", "")).strip()
        
        # 只要原密码验证通过，或已有有效管理员 token，均允许安全修改密码
        token = get_current_token()
        is_token_valid = auth_manager.validate_token(token)
        
        if not is_token_valid and not auth_manager.verify_password(old_pwd):
            response.status = 400
            return {"status": "error", "message": "原管理密码不正确"}

        res = auth_manager.change_password(old_pwd, new_pwd)
        if res.get("status") == "ok":
            response.delete_cookie('vc_token', path='/')
        else:
            response.status = 400
        return res
    except Exception as e:
        response.status = 500
        return {"status": "error", "message": str(e)}

# ===================== 静态页面路由 =====================

@app.route('/')
@app.route('/admin')
def route_admin_index():
    return static_file('admin.html', root=STATIC_DIR)

BASE_DIR = EXE_DIR

@app.route('/control')
def route_control_index():
    p = os.path.join(EXE_DIR, '网页控制端.html')
    if os.path.exists(p):
        try:
            with open(p, 'rb') as f:
                content = f.read()
            response.content_type = 'text/html; charset=utf-8'
            return content
        except Exception:
            pass
    return static_file('admin.html', root=STATIC_DIR)

@app.route('/license')
def route_license_index():
    return static_file('license.html', root=STATIC_DIR)

@app.route('/player')
def route_player_index():
    is_valid = True
    try:
        is_valid, status_code, details = license_guard.check_license()
    except Exception as e:
        print(f"[授权拦截] 校验异常: {e}")
        is_valid = False

    if not is_valid:
        bottle.redirect('/license')
        return

    return static_file('player.html', root=STATIC_DIR)

@app.route('/remote')
def route_remote_index():
    """讲解员极简手持无线手牌端 (适配手机/iPad)"""
    return static_file('remote.html', root=STATIC_DIR)

@app.route('/cast')
def route_cast_index():
    """局域网极简 WebRTC 无线投屏主页 (手机/电脑免装客户端直连)"""
    return static_file('cast.html', root=STATIC_DIR)

@app.route('/static/<filename:path>')
def route_static_files(filename):
    return static_file(filename, root=STATIC_DIR)

@app.route('/assets/<filename:path>')
def route_assets_files(filename):
    return static_file(filename, root=ASSETS_DIR)

@app.route('/media/<filename:path>')
def route_media_files(filename):
    target_f = os.path.join(MEDIA_DIR, filename)
    if not os.path.exists(target_f) or os.path.isdir(target_f) or filename == 'default_standby.jpg':
        default_standby = os.path.join(STATIC_DIR, 'default_standby.jpg')
        if os.path.exists(default_standby):
            return static_file('default_standby.jpg', root=STATIC_DIR)
    res = static_file(filename, root=MEDIA_DIR)
    # 为多媒体大文件加入极速流式缓冲与强缓存头
    if hasattr(res, 'headers'):
        res.headers['Cache-Control'] = 'public, max-age=86400'
        res.headers['Accept-Ranges'] = 'bytes'
    return res

# ===================== 素材全生命周期 API =====================

@app.route('/api/media', method=['GET'])
def api_list_media():
    files = []
    folder_counts = {}
    all_folders = set()

    if os.path.exists(MEDIA_DIR):
        for root, dirs, filenames in os.walk(MEDIA_DIR):
            rel_dir = os.path.relpath(root, MEDIA_DIR)
            if rel_dir == '.':
                folder_name = ""
            else:
                folder_name = rel_dir.replace('\\', '/')
                all_folders.add(folder_name)

            for fname in filenames:
                if fname.endswith('.trans_tmp') or fname.startswith('.'):
                    continue
                fpath = os.path.join(root, fname)
                ext = os.path.splitext(fname)[1].lower()
                m_type = 'other'
                for t, exts in SUPPORTED_EXTS.items():
                    if ext in exts:
                        m_type = t
                        break
                try:
                    stat = os.stat(fpath)
                    file_size = stat.st_size
                    file_mtime = stat.st_mtime
                except Exception:
                    file_size = 0
                    file_mtime = time.time()

                full_name = f"{folder_name}/{fname}" if folder_name else fname
                media_url = f"/media/{full_name}"
                custom_stream_url = None
                if ext in ['.txt', '.url']:
                    try:
                        with open(fpath, 'r', encoding='utf-8', errors='ignore') as uf:
                            for uline in uf:
                                uline = uline.strip()
                                if not uline or uline.startswith('#') or uline.startswith('['):
                                    continue
                                if uline.lower().startswith('url='):
                                    custom_stream_url = uline[4:].strip()
                                    break
                                if any(uline.lower().startswith(pfx) for pfx in ['http://', 'https://', 'rtsp://', 'rtmp://', 'hls://']):
                                    custom_stream_url = uline
                                    break
                    except Exception:
                        pass
                    if custom_stream_url:
                        media_url = custom_stream_url
                        if custom_stream_url.lower().endswith('.m3u8') or custom_stream_url.lower().startswith('rtsp://') or custom_stream_url.lower().startswith('rtmp://'):
                            m_type = 'stream'
                        else:
                            m_type = 'web'

                media_url_final = media_url

                folder_counts[folder_name] = folder_counts.get(folder_name, 0) + 1
                files.append({
                    "name": full_name,
                    "filename": fname,
                    "folder": folder_name,
                    "size": file_size,
                    "type": m_type,
                    "ext": ext,
                    "mtime": file_mtime,
                    "url": media_url_final,
                    "custom_url": custom_stream_url or "",
                    "is_custom": False
                })
    
    # 建立已存在素材的排重指纹库 (按名称、去扩展名文件名以及有效 URL)
    existing_stems = set()
    existing_urls = set()
    for f_item in files:
        fname = f_item.get("filename", "")
        stem = os.path.splitext(fname)[0].strip().lower()
        if stem:
            existing_stems.add(stem)
        u = (f_item.get("url") or f_item.get("custom_url") or "").strip().lower()
        if u:
            existing_urls.add(u)

    # 并入手动输入的网页、直播流、字幕等自定义素材 (严格去重，避免同时存在 .txt 文件和 json 导致显示两个)
    for c in load_custom_media():
        c_name = c.get("name", "未命名自定义素材").strip()
        c_url = c.get("url", "").strip()
        c_stem = os.path.splitext(c_name)[0].strip().lower()
        c_u_lower = c_url.lower()

        # 若磁盘上已有对应的同名 .txt 文件或相同 URL 媒体，则不再重复并入！
        if (c_stem and c_stem in existing_stems) or (c_u_lower and c_u_lower in existing_urls):
            # 将对应磁盘条目的 id 和 is_custom 补充关联，便于前端删除
            for f_item in files:
                f_stem = os.path.splitext(f_item.get("filename", ""))[0].strip().lower()
                f_u = (f_item.get("url") or f_item.get("custom_url") or "").strip().lower()
                if (f_stem == c_stem) or (f_u and f_u == c_u_lower):
                    f_item["id"] = c.get("id", "")
                    f_item["is_custom"] = True
            continue

        c_type = c.get("type", "web")
        c_folder = c.get("folder", "") or "网页_流码"
        if c_folder in ["网页", "流码", "网页_流码"]:
            c_folder = "网页_流码"
        elif c_folder == "PPT_PDF":
            c_folder = "文档"
        files.append({
            "name": c_name,
            "filename": c_name,
            "folder": c_folder,
            "size": 0,
            "type": c_type,
            "ext": c_type,
            "mtime": c.get("mtime", time.time()),
            "url": c_url,
            "is_custom": True,
            "id": c.get("id", ""),
            "config": c.get("config", {})
        })
        folder_counts[c_folder] = folder_counts.get(c_folder, 0) + 1

    files.sort(key=lambda x: x["mtime"], reverse=True)

    # 汇总结构化文件夹列表供前端展示与一键播放 (严格规范 6 大标准分类：待机-视频-图片-音乐-文档-网页\\流码)
    std_meta = [
        {"folder": "待机", "name": "待机", "is_standby": True},
        {"folder": "视频", "name": "视频", "is_standby": False},
        {"folder": "图片", "name": "图片", "is_standby": False},
        {"folder": "音乐", "name": "音乐", "is_standby": False},
        {"folder": "文档", "name": "文档", "is_standby": False},
        {"folder": "网页_流码", "name": "网页\\流码", "is_standby": False},
    ]
    folders_list = []
    seen_std = set()
    for s in std_meta:
        f_key = s["folder"]
        seen_std.add(f_key)
        folders_list.append({
            "name": s["name"],
            "folder": f_key,
            "count": folder_counts.get(f_key, 0),
            "is_standby": s["is_standby"]
        })
    # 若根目录有未归纳文件或其他扩展文件夹，也列出
    if folder_counts.get("", 0) > 0:
        folders_list.append({"name": "未分类根目录", "folder": "", "count": folder_counts.get("", 0), "is_standby": False})
    for f in sorted(list(all_folders)):
        if f not in seen_std and f != "":
            folders_list.append({"name": f, "folder": f, "count": folder_counts.get(f, 0), "is_standby": False})

    # 用户明确要求：素材库全部目录放到最后
    folders_list.append({
        "name": "全部素材", "folder": "ALL", "count": len(files), "is_standby": False
    })

    response.set_header("Cache-Control", "no-cache, no-store, must-revalidate")
    response.set_header("Pragma", "no-cache")
    response.set_header("Expires", "0")

    return {
        "status": "ok",
        "count": len(files),
        "media": files,
        "folders": folders_list,
        "current_folder": coordinator.status.get("current_folder", ""),
        "loop_mode": coordinator.status.get("loop_mode", "FOLDER_LOOP")
    }

@app.route('/api/media/folder/create', method=['POST'])
def api_create_media_folder():
    """在 media 目录下新建子文件夹"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    folder = data.get("folder", "").strip().replace('\\', '/').strip('/')
    if not folder:
        return {"status": "error", "message": "文件夹名称不能为空"}
    if '..' in folder:
        return {"status": "error", "message": "非法文件夹路径"}
    target_dir = os.path.join(MEDIA_DIR, folder)
    try:
        os.makedirs(target_dir, exist_ok=True)
        return {"status": "ok", "message": f"子文件夹 [{folder}] 创建成功", "folder": folder}
    except Exception as e:
        return {"status": "error", "message": f"创建失败: {e}"}

@app.route('/api/media/custom', method=['POST'])
def api_add_custom_media():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    
    name = data.get("name", "").strip()
    m_type = data.get("type", "web").strip()
    url = data.get("url", "").strip()
    config = data.get("config", {})
    
    if not name or not url:
        return {"status": "error", "message": "素材名称与内容/URL不能为空"}

    # 智能协议嗅探：若为流媒体格式，服务端强制赋为 stream，杜绝走 web iframe 引起 Windows 弹出 PotPlayer 等外部播放器
    u_clean = url.lower().split('?')[0]
    if any(u_clean.endswith(ext) or (ext in u_clean) for ext in ['.m3u8', '.flv', '.ts', '.mpd']) or u_clean.startswith(('rtsp://', 'rtmp://')):
        m_type = "stream"
    
    # 统一存入 media/网页_流码/ 文件夹中，自动生成同名 .txt 文档存入 URL
    try:
        import re
        target_folder = '网页_流码'
        target_dir = os.path.join(MEDIA_DIR, target_folder)
        os.makedirs(target_dir, exist_ok=True)
        safe_name = re.sub(r'[\\/*?:"<>|]', '_', name)
        txt_filename = safe_name if safe_name.lower().endswith('.txt') else f"{safe_name}.txt"
        txt_path = os.path.join(target_dir, txt_filename)
        with open(txt_path, 'w', encoding='utf-8') as f:
            f.write(f"{url}\n")
        print(f"[server] 已在 media/{target_folder}/ 目录生成文档: {txt_filename}")
    except Exception as fe:
        print(f"[server] 写入txt文件异常: {fe}")

    items = load_custom_media()
    item_id = f"custom_{int(time.time()*1000)}"
    new_item = {
        "id": item_id,
        "name": name,
        "type": m_type,
        "url": url,
        "config": config,
        "mtime": time.time()
    }
    items.insert(0, new_item)
    save_custom_media(items)
    return {"status": "ok", "message": f"自定义素材 [{name}] 已添加并在文件夹生成 .txt 文档", "item": new_item}

@app.route('/api/media/custom/delete', method=['POST'])
def api_delete_custom_media():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    item_id = data.get("id")
    name = data.get("name")
    
    # 同步清理 media/网页_流码/ 目录下的 txt 文档
    try:
        import re
        if name:
            safe_name = re.sub(r'[\\/*?:"<>|]', '_', name)
            txt_filename = safe_name if safe_name.lower().endswith('.txt') else f"{safe_name}.txt"
            txt_path = os.path.join(MEDIA_DIR, '网页_流码', txt_filename)
            if os.path.exists(txt_path):
                os.remove(txt_path)
    except Exception:
        pass

    items = load_custom_media()
    new_items = [it for it in items if it.get("id") != item_id and it.get("name") != name]
    save_custom_media(new_items)
    return {"status": "ok", "message": "自定义素材已删除"}

@app.route('/api/media/upload_raw', method=['POST'])
def api_upload_media_raw():
    try:
        import urllib.parse
        raw_name = request.headers.get('x-filename') or request.query.get('filename') or ''
        if not raw_name:
            raw_name = 'unnamed_media'
        try:
            filename = urllib.parse.unquote(raw_name).strip()
        except Exception:
            filename = raw_name.strip()
        filename = os.path.basename(filename)
        if not filename:
            filename = 'unnamed_media'

        raw_folder = request.headers.get('x-folder') or request.query.get('folder') or ''
        try:
            folder = urllib.parse.unquote(raw_folder).strip().replace('\\', '/')
        except Exception:
            folder = raw_folder.strip().replace('\\', '/')
        if folder in ('ALL', 'all') or '..' in folder:
            folder = ''

        dest_dir = os.path.join(MEDIA_DIR, folder) if folder else MEDIA_DIR
        os.makedirs(dest_dir, exist_ok=True)
        save_path = os.path.join(dest_dir, filename)

        try:
            with open(save_path, 'wb') as f:
                while True:
                    chunk = request.body.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
        except Exception:
            # 防文件锁重命名保存
            stem, ext = os.path.splitext(filename)
            safe_filename = f"{stem}_{int(time.time())}{ext}"
            save_path = os.path.join(dest_dir, safe_filename)
            with open(save_path, 'wb') as f:
                while True:
                    chunk = request.body.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
            filename = safe_filename

        rel_name = f"{folder}/{filename}" if folder else filename
        return {"status": "ok", "message": f"文件 [{rel_name}] 直传成功", "name": rel_name}
    except Exception as e:
        return {"status": "error", "message": f"直传失败: {str(e)}"}

@app.route('/api/media/upload', method=['POST'])
def api_upload_media():
    try:
        upload = request.files.get('file')
        if not upload:
            return {"status": "error", "message": "未收到上传文件"}
        
        import urllib.parse
        # 优先读取前端显式传递的原始文件名，彻底杜绝 latin-1 乱码
        raw_name = (request.forms.get('original_filename') or '').strip()
        if not raw_name:
            raw_name = upload.raw_filename or upload.filename or 'upload_file'
            try:
                # 针对 Bottle 内部 latin-1 解码导致的 UTF-8 乱码进行双向转码修复
                raw_name = raw_name.encode('latin-1').decode('utf-8')
            except Exception:
                pass
        filename = os.path.basename(urllib.parse.unquote(raw_name)).strip()
        if not filename:
            filename = 'unnamed_media'
        
        target_folder = (request.forms.get('folder') or '').strip().replace('\\', '/').strip('/')
        if not target_folder or target_folder in ('ALL', 'all'):
            ext = os.path.splitext(filename)[1].lower()
            from usb_sync import get_category_by_ext
            target_folder = get_category_by_ext(ext)
            if target_folder == '待机':
                target_folder = '视频' if ext in ('.mp4', '.avi', '.mov', '.mkv', '.wmv') else '图片'
        elif '..' in target_folder:
            target_folder = ''

        dest_dir = os.path.join(MEDIA_DIR, target_folder) if target_folder else MEDIA_DIR
        os.makedirs(dest_dir, exist_ok=True)
        save_path = os.path.join(dest_dir, filename)

        try:
            upload.save(save_path, overwrite=True)
        except Exception as save_err:
            # 若同名文件正被播放器独占打开，自动生成防冲突文件名保存
            stem, ext = os.path.splitext(filename)
            safe_filename = f"{stem}_{int(time.time())}{ext}"
            save_path = os.path.join(dest_dir, safe_filename)
            upload.save(save_path, overwrite=True)
            filename = safe_filename

        rel_name = f"{target_folder}/{filename}" if target_folder else filename
        return {"status": "ok", "message": f"文件 [{rel_name}] 上传成功", "name": rel_name}
    except Exception as e:
        return {"status": "error", "message": f"保存失败: {str(e)}"}

@app.route('/api/system/usb_sync', method=['GET', 'POST'])
@app.route('/api/usb/sync', method=['GET', 'POST'])
@app.route('/api/system/usb_sync_now', method=['POST'])
def api_system_usb_sync():
    try:
        return usb_sync_manager.sync_all_now()
    except Exception as e:
        return {"status": "error", "message": f"主动触发 U 盘扫描异常: {e}"}

@app.route('/api/system/usb_status', method=['GET'])
def api_system_usb_status():
    try:
        drives = usb_sync_manager.get_active_removable_drives()
        ev = usb_sync_manager.get_latest_sync_event()
        return {
            "status": "ok",
            "has_usb": len(drives) > 0,
            "drives": drives,
            "count": len(drives),
            "event": ev
        }
    except Exception as e:
        return {"status": "ok", "has_usb": False, "drives": [], "error": str(e)}

@app.route('/api/media/delete', method=['POST'])
def api_delete_media():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    filename = data.get("name", "").strip().replace('\\', '/')
    if not filename:
        return {"status": "error", "message": "未指定删除文件名"}
    if '..' in filename:
        return {"status": "error", "message": "非法文件路径"}
    target = os.path.join(MEDIA_DIR, filename)
    if os.path.exists(target):
        try:
            if os.path.isfile(target):
                os.remove(target)
            elif os.path.isdir(target):
                shutil.rmtree(target)
            
            # 若删除的是流码文档或网页文件，同步清理 custom_media.json
            try:
                base_stem = os.path.splitext(os.path.basename(filename))[0].strip().lower()
                c_items = load_custom_media()
                new_c = [it for it in c_items if os.path.splitext(it.get("name", ""))[0].strip().lower() != base_stem]
                if len(new_c) != len(c_items):
                    save_custom_media(new_c)
            except Exception:
                pass

            return {"status": "ok", "message": f"[{filename}] 已安全删除"}
        except Exception as e:
            return {"status": "error", "message": f"删除失败: {e}"}
    return {"status": "error", "message": "文件不存在"}

@app.route('/api/media/transfer', method=['POST'])
def api_transfer_media():
    """素材复制与剪切/移动接口，支持在待机与其他文件夹相互复制粘贴"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        
        action = data.get("action", "copy").lower().strip() # "copy" 或 "move"
        target_folder = data.get("target_folder", "").strip().replace('\\', '/')
        if target_folder == "ALL" or target_folder == "全部":
            target_folder = ""
        
        sources = data.get("sources", [])
        if not sources and data.get("source"):
            sources = [data.get("source")]
        if not sources and data.get("name"):
            sources = [data.get("name")]
        
        if not sources:
            return {"status": "error", "message": "未指定要操作的素材文件"}
        
        if '..' in target_folder:
            return {"status": "error", "message": "目标目录非法"}
        
        dest_dir = os.path.join(MEDIA_DIR, target_folder) if target_folder else MEDIA_DIR
        os.makedirs(dest_dir, exist_ok=True)
        
        success_count = 0
        results = []
        
        c_items = load_custom_media()
        custom_updated = False
        
        for src in sources:
            src_clean = src.strip().replace('\\', '/')
            if not src_clean or '..' in src_clean:
                continue
            src_path = os.path.join(MEDIA_DIR, src_clean)
            if not os.path.exists(src_path):
                results.append({"name": src_clean, "status": "error", "message": "源文件不存在"})
                continue
            
            base_name = os.path.basename(src_clean)
            dest_file = os.path.join(dest_dir, base_name)
            
            # 若来源与目标完全相同
            if os.path.abspath(src_path) == os.path.abspath(dest_file):
                if action == "move":
                    results.append({"name": src_clean, "status": "skipped", "message": "源文件已在当前文件夹"})
                    continue
                else:
                    # 同目录下复制，自动生成副本名称
                    stem, ext = os.path.splitext(base_name)
                    counter = 1
                    while True:
                        suffix = f"_副本" if counter == 1 else f"_副本({counter})"
                        new_base = f"{stem}{suffix}{ext}"
                        new_dest = os.path.join(dest_dir, new_base)
                        if not os.path.exists(new_dest):
                            dest_file = new_dest
                            base_name = new_base
                            break
                        counter += 1
            else:
                # 跨目录操作：如果目标已有同名文件且是复制，生成副本
                if os.path.exists(dest_file):
                    if action == "copy":
                        stem, ext = os.path.splitext(base_name)
                        counter = 1
                        while True:
                            suffix = f"_副本" if counter == 1 else f"_副本({counter})"
                            new_base = f"{stem}{suffix}{ext}"
                            new_dest = os.path.join(dest_dir, new_base)
                            if not os.path.exists(new_dest):
                                dest_file = new_dest
                                base_name = new_base
                                break
                            counter += 1
                    else:
                        # 移动时如果目标已存在，先删除旧的目标文件覆盖
                        try:
                            if os.path.isfile(dest_file):
                                os.remove(dest_file)
                            elif os.path.isdir(dest_file):
                                shutil.rmtree(dest_file)
                        except Exception:
                            pass
            
            try:
                if action == "copy":
                    if os.path.isfile(src_path):
                        shutil.copy2(src_path, dest_file)
                    elif os.path.isdir(src_path):
                        shutil.copytree(src_path, dest_file)
                    success_count += 1
                    new_rel = f"{target_folder}/{base_name}" if target_folder else base_name
                    results.append({"name": src_clean, "new_name": new_rel, "status": "ok"})
                    
                    # 自定义媒体条目同步复制
                    for it in list(c_items):
                        if it.get("name") == src_clean:
                            copied_item = dict(it)
                            copied_item["id"] = f"custom_{int(time.time() * 1000)}"
                            copied_item["name"] = new_rel
                            copied_item["folder"] = target_folder
                            c_items.append(copied_item)
                            custom_updated = True
                            break
                else: # move
                    shutil.move(src_path, dest_file)
                    success_count += 1
                    new_rel = f"{target_folder}/{base_name}" if target_folder else base_name
                    results.append({"name": src_clean, "new_name": new_rel, "status": "ok"})
                    
                    # 自定义媒体条目同步迁移
                    for it in c_items:
                        if it.get("name") == src_clean:
                            it["name"] = new_rel
                            it["folder"] = target_folder
                            custom_updated = True
                            break
            except Exception as fe:
                results.append({"name": src_clean, "status": "error", "message": str(fe)})
        
        if custom_updated:
            save_custom_media(c_items)
            
        action_name = "复制" if action == "copy" else "剪切移动"
        return {
            "status": "ok" if success_count > 0 else "error",
            "action": action,
            "target_folder": target_folder,
            "success_count": success_count,
            "message": f"成功{action_name} {success_count} 个素材至【{target_folder or '根目录'}】",
            "results": results
        }
    except Exception as e:
        return {"status": "error", "message": f"操作失败: {str(e)}"}

@app.route('/api/subtitle', method=['GET', 'POST'])
def api_subtitle_config():
    """大屏顶层悬浮字幕查询与即时设置"""
    if request.method == 'GET':
        return {"status": "ok", "subtitle": coordinator.status.get("subtitle", {})}
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    coordinator.handle_command("UPDATE_SUBTITLE", data)
    return {"status": "ok", "message": "字幕配置已即时生效", "subtitle": coordinator.status.get("subtitle", {})}

# ===================== 播控指令与双向同步 API =====================

@app.route('/api/player/status', method=['GET'])
def api_get_status():
    coordinator.record_echo_request()
    with coordinator.lock:
        st = dict(coordinator.status)
        st["fullscreen"] = getattr(coordinator, 'is_fullscreen_mode', True)
        st["hardware"] = system_control.hardware_monitor.get_status()
        st["scheduled_shutdown"] = scheduled_shutdown_manager.get_status()
        return {"status": "ok", "player": st}

@app.route('/api/player/command', method=['POST'])
def api_post_command():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    cmd = (data.get("command") or data.get("cmd") or "").upper()
    params = data.get("params", {})
    item = coordinator.handle_command(cmd, params)
    return {"status": "ok", "dispatched": item}

@app.route('/api/player/sync', method=['POST'])
def api_player_sync():
    """大屏聚合同步通道：单次请求同时完成【状态上报】与【指令拉取】，减少 50% 网络吞吐与线程占用"""
    try:
        raw_body = request.body.read()
        if raw_body:
            report_data = json.loads(raw_body.decode('utf-8'))
        else:
            report_data = request.json or {}
    except Exception:
        report_data = request.json or {}
    
    coordinator.update_player_report(report_data or {})
    
    cmds, need_echo, mode, idle_media, idle_timeout, scale_mode, loop, loop_mode, current_folder, subtitle, orientation = coordinator.pull_commands_for_player()
    fullscreen = getattr(coordinator, 'is_fullscreen_mode', True)
    touch_mode = coordinator.status.get("touch_mode", False)
    sync_role = cluster_sync.role
    master_expected_time = cluster_sync.get_master_expected_media_time() if sync_role == "SLAVE" else 0.0

    # 商业授权实时防伪与到期校验
    lic_valid, lic_status_code, _ = license_guard.check_license()
    if not lic_valid:
        cmds.append({"id": int(time.time() * 1000), "type": "REDIRECT_LICENSE", "params": {"status_code": lic_status_code}})

    return {
        "status": "ok",
        "commands": cmds,
        "need_echo": need_echo,
        "fullscreen": fullscreen,
        "touch_mode": touch_mode,
        "sync_role": sync_role,
        "master_time": master_expected_time,
        "mode": mode,
        "volume": coordinator.status.get("volume", 85),
        "muted": coordinator.status.get("muted", False),
        "idle_media": idle_media,
        "idle_timeout": idle_timeout,
        "scale_mode": scale_mode,
        "loop": loop,
        "loop_mode": loop_mode,
        "current_folder": current_folder,
        "subtitle": subtitle,
        "orientation": orientation,
        "switch_policy": coordinator.status.get("switch_policy", "FINISHED"),
        "cycle_duration": coordinator.status.get("cycle_duration", 30),
        "license_valid": lic_valid,
        "license_status_code": lic_status_code,
        "cast_active": coordinator.status.get("cast_active", False) or (coordinator.status.get("cast_state") == "WAITING_QR"),
        "cast_device_name": coordinator.status.get("cast_device_name", getattr(native_cast, 'device_name', 'VisualCast 展厅大屏')),
        "sleep_mode": coordinator.status.get("sleep_mode", False)
    }

@app.route('/api/player/pull', method=['GET'])
def api_player_pull_commands():
    """大屏端拉取待执行命令，并返回按需抽帧指令与模式配置"""
    cmds, need_echo, mode, idle_media, idle_timeout, scale_mode, loop, loop_mode, current_folder, subtitle, orientation = coordinator.pull_commands_for_player()
    fullscreen = getattr(coordinator, 'is_fullscreen_mode', True)
    touch_mode = coordinator.status.get("touch_mode", False)
    sync_role = cluster_sync.role
    master_expected_time = cluster_sync.get_master_expected_media_time() if sync_role == "SLAVE" else 0.0

    # 商业授权实时防伪与到期校验
    lic_valid, lic_status_code, _ = license_guard.check_license()
    if not lic_valid:
        cmds.append({"id": int(time.time() * 1000), "type": "REDIRECT_LICENSE", "params": {"status_code": lic_status_code}})

    return {
        "status": "ok",
        "commands": cmds,
        "need_echo": need_echo,
        "fullscreen": fullscreen,
        "touch_mode": touch_mode,
        "sync_role": sync_role,
        "master_time": master_expected_time,
        "mode": mode,
        "volume": coordinator.status.get("volume", 85),
        "muted": coordinator.status.get("muted", False),
        "idle_media": idle_media,
        "idle_timeout": idle_timeout,
        "scale_mode": scale_mode,
        "loop": loop,
        "loop_mode": loop_mode,
        "current_folder": current_folder,
        "subtitle": subtitle,
        "orientation": orientation,
        "switch_policy": coordinator.status.get("switch_policy", "FINISHED"),
        "cycle_duration": coordinator.status.get("cycle_duration", 30),
        "license_valid": lic_valid,
        "license_status_code": lic_status_code
    }

@app.route('/api/player/touch_mode', method=['GET', 'POST'])
def api_player_touch_mode():
    """获取或切换大屏端触摸交互模式 (开启时大屏浮现触控按钮窗口，关闭时彻底隐藏)"""
    try:
        if request.method == 'POST':
            try:
                data = json.load(request.body)
            except Exception:
                data = request.json or {}
            if "touch_mode" in data:
                val = bool(data["touch_mode"])
            else:
                val = not coordinator.status.get("touch_mode", False)
            coordinator.set_touch_mode(val)
        return {
            "status": "ok",
            "touch_mode": coordinator.status.get("touch_mode", False)
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/player/return_to_standby', method=['GET', 'POST'])
@app.route('/api/player/return_idle', method=['GET', 'POST'])
def api_return_standby():
    """退出当前点播/放映，无缝恢复待机文件夹的连续循环轮播"""
    return coordinator.return_to_standby()

@app.route('/api/player/idle_config', method=['GET', 'POST'])
def api_idle_config():
    """获取或保存待机素材与空闲超时配置"""
    if request.method == 'GET':
        return {
            "status": "ok",
            "idle_media": coordinator.status.get("idle_media", "demo_show.mp4"),
            "idle_timeout": coordinator.status.get("idle_timeout", 60),
            "mode": coordinator.status.get("mode", "ATTRACT")
        }
    else:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        idle_media = data.get("idle_media")
        idle_timeout = data.get("idle_timeout")
        with coordinator.lock:
            if idle_media is not None:
                coordinator.status["idle_media"] = idle_media
                coordinator.config.setdefault("playback", {})["idle_media"] = idle_media
            if idle_timeout is not None:
                coordinator.status["idle_timeout"] = int(idle_timeout)
                coordinator.config.setdefault("playback", {})["idle_timeout"] = int(idle_timeout)
            coordinator.save_player_config()
        return {"status": "ok", "message": "待机配置已持久化保存"}

@app.route('/api/player/report', method=['POST'])
def api_player_report():
    """大屏端上报当前播放状态与进度"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    coordinator.update_player_report(data)
    return {"status": "ok"}

# ===================== 大屏实时镜像回显 API =====================

@app.route('/api/player/echo', method=['POST'])
def api_upload_echo():
    """大屏端定时上传当前低画质 WebP 帧"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    frame = data.get("frame", "")
    coordinator.update_echo_frame(frame)
    return {"status": "ok"}

@app.route('/api/player/echo', method=['GET'])
def api_get_echo():
    """Web 控制后台拉取大屏镜像帧 (调用此接口将自动激活大屏按需抽帧)"""
    coordinator.record_echo_request()
    frame, ts = coordinator.get_echo_frame()
    return {"status": "ok", "frame": frame, "timestamp": ts, "is_live": (time.time() - ts < 4.0)}

@app.route('/api/stream/live.mjpeg')
@app.route('/api/stream/live.jpg')
def api_stream_mjpeg():
    """基于开源 ScreenStream 标准的低延迟长连接动图流"""
    response.content_type = 'multipart/x-mixed-replace; boundary=frame'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    response.headers['Access-Control-Allow-Origin'] = '*'

    def mjpeg_generator():
        while True:
            coordinator.record_echo_request()
            frame, ts = coordinator.get_echo_frame()
            cur_bytes = None
            if frame and frame.startswith("data:image/"):
                try:
                    comma = frame.find(",")
                    if comma != -1:
                        cur_bytes = base64.b64decode(frame[comma+1:])
                except Exception:
                    pass
            if not cur_bytes:
                def_path = os.path.join(STATIC_DIR, "default_standby.jpg")
                if os.path.exists(def_path):
                    try:
                        with open(def_path, "rb") as df:
                            cur_bytes = df.read()
                    except Exception:
                        pass
            if cur_bytes:
                yield (b"--frame\r\n"
                       b"Content-Type: image/jpeg\r\n"
                       b"Content-Length: " + str(len(cur_bytes)).encode('ascii') + b"\r\n\r\n" +
                       cur_bytes + b"\r\n")
            time.sleep(0.1)

    return mjpeg_generator()

# ===================== WebRTC 局域网无线投屏中枢 API =====================

class CastManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.is_active = False           # 当前是否处于投屏中
        self.waiting_qr = False          # 大屏端是否正展示投屏二维码等待连接
        self.current_sender_ip = ""      # 发送端 IP
        self.offer_sdp = None            # 发送端 Offer
        self.answer_sdp = None           # 大屏端 Answer
        self.sender_candidates = []      # 发送端发来的 ICE Candidate
        self.receiver_candidates = []    # 接收端发来的 ICE Candidate
        self.resolution = "1080p"
        self.last_signal_time = time.time()

    def open_qr(self):
        with self.lock:
            self.waiting_qr = True
            self.offer_sdp = None
            self.answer_sdp = None
            self.sender_candidates = []
            self.receiver_candidates = []

    def close_qr(self):
        with self.lock:
            self.waiting_qr = False

    def start_cast(self, sender_ip, offer_sdp, resolution="1080p"):
        with self.lock:
            self.is_active = True
            self.waiting_qr = False
            self.current_sender_ip = sender_ip
            self.offer_sdp = offer_sdp
            self.answer_sdp = None
            self.sender_candidates = []
            self.receiver_candidates = []
            self.resolution = resolution
            self.last_signal_time = time.time()

    def set_answer(self, answer_sdp):
        with self.lock:
            self.answer_sdp = answer_sdp
            self.last_signal_time = time.time()

    def stop_cast(self):
        with self.lock:
            self.is_active = False
            self.waiting_qr = False
            self.current_sender_ip = ""
            self.offer_sdp = None
            self.answer_sdp = None
            self.sender_candidates = []
            self.receiver_candidates = []

    def add_candidate(self, role, candidate):
        with self.lock:
            if role == 'sender':
                self.sender_candidates.append(candidate)
            else:
                self.receiver_candidates.append(candidate)
            self.last_signal_time = time.time()

    def get_info(self, req_host="127.0.0.1:8088"):
        with self.lock:
            ips = []
            try:
                ips = system_control.get_local_ips()
            except Exception:
                pass
            primary_ip = "127.0.0.1"
            for item in ips:
                ip_str = item.get("ip", "") if isinstance(item, dict) else str(item)
                if ip_str and not ip_str.startswith("127.") and not ip_str.startswith("169.254."):
                    primary_ip = ip_str
                    break
            port = 8088
            if ":" in req_host:
                try:
                    port = int(req_host.split(":")[-1])
                except Exception:
                    pass
            cast_url = f"http://{primary_ip}:{port}/cast"
            return {
                "status": "ok",
                "is_active": self.is_active,
                "waiting_qr": self.waiting_qr,
                "sender_ip": self.current_sender_ip,
                "resolution": self.resolution,
                "ip": primary_ip,
                "port": port,
                "cast_url": cast_url
            }

cast_manager = CastManager()

# 系统级原生无线投屏引擎 (苹果 AirPlay 发现 + 安卓多屏互动 DLNA + Windows 投影支持)
from native_cast_server import NativeCastServer
_init_cast_name = coordinator.config.get("cast_device_name") or coordinator.config.get("system", {}).get("cast_device_name")
if not _init_cast_name:
    try:
        _p_ip = system_control.get_primary_ip()
        _init_cast_name = device_discovery_manager.aliases.get(_p_ip, {}).get("custom_name")
    except Exception:
        pass
if not _init_cast_name:
    try:
        for _alias in device_discovery_manager.aliases.values():
            if _alias.get("custom_name"):
                _init_cast_name = _alias.get("custom_name")
                break
    except Exception:
        pass
if not _init_cast_name:
    _init_cast_name = "VisualCast 展厅大屏"

native_cast = NativeCastServer(coordinator_ref=coordinator, device_name=_init_cast_name, http_port=8088, cast_manager_ref=cast_manager)
native_cast.start()

@app.route('/dlna/desc.xml', method=['GET', 'HEAD', 'POST'])
def route_dlna_desc():
    host = request.get_header('Host', '')
    local_ip = host.split(':')[0] if host else native_cast.get_local_ip()
    response.content_type = 'text/xml; charset=utf-8'
    return native_cast.get_device_xml(local_ip)

@app.route('/dlna/avt_scpd.xml', method=['GET', 'HEAD', 'POST'])
def route_dlna_avt_scpd():
    response.content_type = 'text/xml; charset=utf-8'
    return native_cast.get_avt_scpd_xml()

@app.route('/dlna/rc_scpd.xml', method=['GET', 'HEAD', 'POST'])
def route_dlna_rc_scpd():
    response.content_type = 'text/xml; charset=utf-8'
    return native_cast.get_rc_scpd_xml()

@app.route('/dlna/cm_scpd.xml', method=['GET', 'HEAD', 'POST'])
def route_dlna_cm_scpd():
    response.content_type = 'text/xml; charset=utf-8'
    return native_cast.get_cm_scpd_xml()

@app.route('/dlna/avt_control', method=['POST'])
def route_dlna_avt():
    body = request.body.read().decode('utf-8', errors='ignore')
    client_ip = request.environ.get('REMOTE_ADDR') or "127.0.0.1"
    response.content_type = 'text/xml; charset=utf-8'
    return native_cast.handle_avt_soap(body, client_ip)

@app.route('/dlna/rc_control', method=['POST'])
def route_dlna_rc():
    body = request.body.read().decode('utf-8', errors='ignore')
    response.content_type = 'text/xml; charset=utf-8'
    return native_cast.handle_rc_soap(body)

@app.route('/dlna/cm_control', method=['POST'])
def route_dlna_cm():
    body = request.body.read().decode('utf-8', errors='ignore')
    response.content_type = 'text/xml; charset=utf-8'
    return native_cast.handle_cm_soap(body)

@app.route('/dlna/avt_event', method=['GET', 'POST', 'SUBSCRIBE', 'UNSUBSCRIBE'])
@app.route('/dlna/rc_event', method=['GET', 'POST', 'SUBSCRIBE', 'UNSUBSCRIBE'])
@app.route('/dlna/cm_event', method=['GET', 'POST', 'SUBSCRIBE', 'UNSUBSCRIBE'])
def route_dlna_event():
    response.headers['SID'] = 'uuid:visualcast-sub-event-1001'
    response.headers['TIMEOUT'] = 'Second-1800'
    response.content_type = 'text/xml; charset=utf-8'
    return ''

@app.route('/api/cast/info', method=['GET'])
def api_cast_info():
    req_host = request.get_header('Host', '127.0.0.1:8088')
    info = cast_manager.get_info(req_host)
    info["native_cast"] = {
        "enabled": True,
        "device_name": native_cast.device_name,
        "is_active": native_cast.is_active,
        "sender_ip": native_cast.current_sender_ip
    }
    return info

@app.route('/api/cast/trigger', method=['POST'])
def api_cast_trigger():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    action = data.get("action", "open")
    if action == "open":
        cast_manager.open_qr()
        dev_name = getattr(native_cast, 'device_name', 'VisualCast 展厅大屏')
        with coordinator.lock:
            coordinator.status["cast_state"] = "WAITING_QR"
            coordinator.status["cast_active"] = True
            coordinator.status["cast_device_name"] = dev_name
        coordinator.add_command("SHOW_CAST_BOARD", {"device_name": dev_name})
        info = cast_manager.get_info(request.get_header('Host', '127.0.0.1:8088'))
        info["native_cast"] = {
            "enabled": True,
            "device_name": dev_name,
            "is_active": native_cast.is_active,
            "sender_ip": native_cast.current_sender_ip
        }
        return {"status": "ok", "message": "大屏已弹出原生无线投屏连接看板", "info": info}
    else:
        cast_manager.stop_cast()
        with coordinator.lock:
            coordinator.status["cast_state"] = "IDLE"
            coordinator.status["cast_active"] = False
            coordinator.status["cast_sender"] = ""
        coordinator.add_command("HIDE_CAST_BOARD", {})
        return {"status": "ok", "message": "已关闭投屏"}

@app.route('/api/cast/set_device_name', method=['POST'])
def api_cast_set_device_name():
    """实时修改并持久化投屏设备广播名称"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    device_name = str(data.get("device_name", "")).strip()
    if not device_name:
        return {"status": "error", "message": "投屏设备名称不能为空"}

    # 1. 动态更新 native_cast 实例
    if 'native_cast' in globals():
        native_cast.set_device_name(device_name)

    # 2. 持久化到 coordinator.config 并落盘
    coordinator.config.setdefault("system", {})["cast_device_name"] = device_name
    coordinator.config["cast_device_name"] = device_name
    coordinator.save_player_config()

    # 3. 同步更新设备发现中枢中本机的别名
    try:
        primary_ip = system_control.get_primary_ip()
        device_discovery_manager.set_device_name(primary_ip, device_name)
    except Exception:
        pass

    # 4. 若作为 Master 节点，向从机全量广播同步
    try:
        if 'cluster_sync' in globals() and getattr(cluster_sync, 'role', '') == "MASTER":
            cluster_sync.broadcast_full_config()
    except Exception:
        pass

    return {
        "status": "ok",
        "message": f"投屏设备名称已更新为: {device_name}",
        "device_name": device_name
    }

@app.route('/api/cast/signal', method=['POST'])
def api_cast_signal_post():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    role = data.get("role", "sender") # sender | receiver
    sig_type = data.get("type", "")   # offer | answer | candidate | leave
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR') or request.environ.get('REMOTE_ADDR') or "127.0.0.1"

    if role == "sender":
        if sig_type == "offer":
            sdp = data.get("sdp", "")
            res = data.get("resolution", "1080p")
            cast_manager.start_cast(client_ip, sdp, res)
            with coordinator.lock:
                coordinator.status["cast_state"] = "CASTING"
                coordinator.status["cast_sender"] = client_ip
            return {"status": "ok", "message": "Offer 已提交"}
        elif sig_type == "candidate":
            cand = data.get("candidate")
            if cand:
                cast_manager.add_candidate("sender", cand)
            return {"status": "ok"}
    elif role == "receiver": # 大屏端
        if sig_type == "answer":
            sdp = data.get("sdp", "")
            cast_manager.set_answer(sdp)
            return {"status": "ok", "message": "Answer 已提交"}
        elif sig_type == "candidate":
            cand = data.get("candidate")
            if cand:
                cast_manager.add_candidate("receiver", cand)
            return {"status": "ok"}
    return {"status": "ok"}

@app.route('/api/cast/signal', method=['GET'])
def api_cast_signal_get():
    role = request.query.get("role", "sender")
    with cast_manager.lock:
        if role == "sender":
            return {
                "status": "ok",
                "is_active": cast_manager.is_active,
                "answer": cast_manager.answer_sdp,
                "candidates": cast_manager.receiver_candidates
            }
        else: # receiver (大屏端)
            native_active = getattr(native_cast, 'is_active', False)
            return {
                "status": "ok",
                "waiting_qr": cast_manager.waiting_qr and not native_active,
                "is_active": cast_manager.is_active or native_active,
                "offer": cast_manager.offer_sdp,
                "resolution": cast_manager.resolution,
                "candidates": cast_manager.sender_candidates
            }

@app.route('/api/cast/open_windows_miracast', method=['POST'])
def api_cast_open_windows_miracast():
    """一键唤起 Windows 原生无线显示器接收端 (支持安卓下拉菜单直连)"""
    try:
        import subprocess
        subprocess.Popen(["cmd", "/c", "start ms-projection:"], shell=False)
        return {"status": "ok", "message": "已尝试唤起 Windows 原生无线显示器"}
    except Exception as e:
        try:
            os.system("start ms-settings:projecting-to-this-pc")
            return {"status": "ok", "message": "已打开系统投影设置"}
        except Exception as ex:
            return {"status": "error", "message": str(ex)}

@app.route('/api/cast/stop', method=['POST'])
def api_cast_stop():
    cast_manager.stop_cast()
    with coordinator.lock:
        coordinator.status["cast_state"] = "IDLE"
        coordinator.status["cast_sender"] = ""
    return {"status": "ok", "message": "投屏已结束"}

@app.route('/api/cast/upload_media', method=['POST'])
def api_cast_upload_media():
    try:
        upload = request.files.get('file')
        if not upload:
            response.content_type = 'application/json; charset=utf-8'
            return json.dumps({"status": "error", "message": "未收到文件"}, ensure_ascii=False)
        filename = upload.filename or f"cast_media_{int(time.time())}.mp4"
        clean_name = os.path.basename(filename)
        # 统一转码防乱码
        clean_name = clean_name.replace('\\', '_').replace('/', '_')
        dest_path = os.path.join(MEDIA_DIR, clean_name)
        os.makedirs(MEDIA_DIR, exist_ok=True)
        upload.save(dest_path, overwrite=True)

        # 识别媒体类型
        ext = os.path.splitext(clean_name)[1].lower()
        if ext in ['.pptx', '.ppt', '.pdf', '.doc', '.docx']:
            m_type = 'doc'
        elif ext in ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']:
            m_type = 'image'
        elif ext in ['.mp3', '.wav', '.aac', '.flac', '.ogg']:
            m_type = 'audio'
        else:
            m_type = 'video'

        # 通过统一播控指令切入新素材播放
        coordinator.handle_command('LOAD_AND_PLAY', {
            "media": clean_name,
            "media_item": {
                "name": clean_name,
                "url": f"/media/{clean_name}",
                "type": m_type
            },
            "mode": "ON_DEMAND",
            "folder": ""
        })

        # 重置 WebRTC 投屏信令，大屏二维码自动隐藏，平滑呈现用户投送的文件
        try:
            cast_manager.reset()
        except Exception:
            pass

        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "ok", "message": f"素材 [{clean_name}] 已成功投屏放映"}, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": f"投送处理异常: {str(e)}"}, ensure_ascii=False)


# ===================== 显示与窗口设置 API =====================

@app.route('/api/display/settings', method=['GET'])
def api_get_display_settings():
    monitors = system_control.get_monitors()
    local_ips = system_control.get_local_ips()
    return {
        "status": "ok",
        "config": coordinator.config,
        "monitors": monitors,
        "local_ips": local_ips,
        "web_port": 8088
    }

@app.route('/api/display/settings', method=['POST'])
def api_save_display_settings():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    coordinator.apply_display_settings(data)
    return {"status": "ok", "message": "大屏窗口显示设置已应用"}

# ===================== 展馆环境设备中控 API =====================

@app.route('/api/iot/devices', method=['GET'])
def api_get_iot_devices():
    cfg = iot_engine.load_config()
    return {"status": "ok", "devices": cfg.get("devices", [])}

@app.route('/api/iot/devices', method=['POST'])
def api_save_iot_devices():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    devices = data.get("devices", [])
    cfg = iot_engine.load_config()
    cfg["devices"] = devices
    iot_engine.save_config(cfg)
    return {"status": "ok", "message": "设备库配置已保存"}

@app.route('/api/iot/devices/test', method=['POST'])
def api_test_device_cmd():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    dev_id = data.get("device_id")
    cmd_type = data.get("cmd_type", "on")
    custom_cmd = data.get("custom_cmd")
    res = iot_engine.send_device_command(dev_id, cmd_type, custom_cmd)
    return res

@app.route('/api/iot/macros', method=['GET'])
def api_get_iot_macros():
    cfg = iot_engine.load_config()
    all_macros = iot_engine.get_all_macros()
    return {
        "status": "ok",
        "macros": cfg.get("macros", {}),
        "custom_scenarios": cfg.get("custom_scenarios", []),
        "macros_list": all_macros
    }

@app.route('/api/iot/macros', method=['POST'])
def api_save_iot_macros():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    macros = data.get("macros", {})
    scenarios = data.get("custom_scenarios", [])
    cfg = iot_engine.load_config()
    if macros:
        cfg["macros"] = macros
    if scenarios is not None:
        cfg["custom_scenarios"] = scenarios
    iot_engine.save_config(cfg)
    return {"status": "ok", "message": "一键控制宏配置已更新", "macros_list": iot_engine.get_all_macros()}

@app.route('/api/iot/macros/save', method=['POST'])
def api_save_single_macro():
    """新增或保存单个一键控制场景宏 (支持无限新增)"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    macro_id = data.get("id") or data.get("macro_id") or f"macro_{int(time.time()*1000)}"
    macro_name = data.get("name") or "新建一键控制"
    macro_desc = data.get("desc") or ""
    steps = data.get("steps") or []
    theme = data.get("theme") or "custom"
    
    macro_obj = {
        "id": macro_id,
        "name": macro_name,
        "desc": macro_desc,
        "theme": theme,
        "steps": steps
    }
    res = iot_engine.save_macro(macro_id, macro_obj)
    res["macro"] = macro_obj
    res["macros_list"] = iot_engine.get_all_macros()
    return res

@app.route('/api/iot/macros/delete', method=['POST'])
def api_delete_single_macro():
    """删除指定的一键控制场景宏"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    macro_id = data.get("id") or data.get("macro_id")
    if not macro_id:
        return {"status": "error", "message": "未指定要删除的宏 ID"}
    res = iot_engine.delete_macro(macro_id)
    res["macros_list"] = iot_engine.get_all_macros()
    return res

@app.route('/api/iot/macros/run', method=['POST'])
def api_run_macro():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    macro_id = data.get("macro_id")
    res = iot_engine.run_macro_async(macro_id, player_coordinator=coordinator)
    return res

@app.route('/api/iot/macros/status', method=['GET'])
def api_get_macro_status():
    """查询一键开闭馆流水线当前执行进度与日志"""
    status = iot_engine.get_macro_status()
    return {"status": "ok", "macro_status": status}

# ==================== 展馆多媒体与物联设备同步时间轴 API ====================

@app.route('/api/iot/timeline', method=['GET'])
def api_get_iot_timeline():
    """获取多媒体物联时间轴配置"""
    tl = iot_engine.get_timeline()
    return {"status": "ok", "timeline": tl}

@app.route('/api/iot/timeline', method=['POST'])
def api_save_iot_timeline():
    """保存多媒体物联时间轴配置"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    tl = data.get("timeline", {})
    iot_engine.save_timeline(tl)
    return {"status": "ok", "message": "时间轴编排配置已保存", "timeline": tl}

# ==================== 展馆物联网自定义中转与协议分发 API ====================

@app.route('/api/iot/forwarders', method=['GET'])
def api_get_iot_forwarders():
    """获取所有自定义中转规则及触发统计"""
    return {
        "status": "ok",
        "forwarders": iot_engine.get_forwarders()
    }

@app.route('/api/iot/forwarders', method=['POST'])
def api_save_iot_forwarder():
    """新增或修改自定义中转规则"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        return iot_engine.save_forwarder(data)
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/iot/forwarders/delete', method=['POST'])
def api_delete_iot_forwarder():
    """删除指定中转规则"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        fwd_id = data.get("id") or data.get("fwd_id")
        if not fwd_id:
            return {"status": "error", "message": "未指定中转规则 ID"}
        return iot_engine.delete_forwarder(fwd_id)
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/iot/forwarders/toggle', method=['POST'])
def api_toggle_iot_forwarder():
    """快速启用/禁用指定中转规则"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        fwd_id = data.get("id")
        enabled = data.get("enabled", True)
        if not fwd_id:
            return {"status": "error", "message": "未指定中转规则 ID"}
        return iot_engine.toggle_forwarder(fwd_id, enabled)
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/iot/forwarders/test', method=['POST'])
def api_test_iot_forwarder():
    """手动模拟测试执行指定中转规则"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        fwd_id = data.get("id")
        if not fwd_id:
            return {"status": "error", "message": "未指定中转规则 ID"}
        return iot_engine.test_forwarder(fwd_id)
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/iot/trigger', method=['POST'])
def api_trigger_iot_forward():
    """外部 HTTP 调用触发中转分发与中控调度"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        cmd = str(data.get("cmd") or data.get("command") or "").strip()
        protocol = str(data.get("protocol") or "HTTP").upper()
        if not cmd:
            return {"status": "error", "message": "命令内容不能为空"}
        # 1. 触发自定义中转规则匹配与转发
        forward_res = iot_engine.process_forwarding(cmd, protocol=protocol, source_addr=request.remote_addr)
        # 2. 同时支持作为本机中控指令派发
        _dispatch_central_command(cmd)
        return {
            "status": "ok",
            "message": f"指令 [{cmd}] 已成功处理并分发",
            "matched_rules": forward_res
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}




@app.route('/api/system/hardware_status', method=['GET'])
def api_get_hardware_status():
    """获取大屏主机的 CPU / 内存 / GPU 实时运行状态"""
    return system_control.hardware_monitor.get_status()

@app.route('/api/player/keystroke', method=['POST'])
def api_player_keystroke():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    key = data.get("key", "PGDN")
    return system_control.send_keystroke(key)

@app.route('/api/iot/macros/rename', method=['POST'])
def api_rename_macro():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    macro_id = data.get("macro_id")
    new_name = data.get("new_name", "")
    new_desc = data.get("new_desc", "")
    if not macro_id or not new_name:
        return {"status": "error", "message": "宏ID或新名称为空"}

    cfg = iot_engine.load_config()
    if macro_id in cfg.get("macros", {}):
        cfg["macros"][macro_id]["name"] = new_name
        if new_desc:
            cfg["macros"][macro_id]["desc"] = new_desc
        iot_engine.save_config(cfg)
        return {"status": "ok", "message": f"宏序列名称已更新为: {new_name}", "macros_list": iot_engine.get_all_macros()}
    return {"status": "error", "message": "未找到指定宏序列"}

# ===================== 系统级直接运维 API =====================

@app.route('/api/system/info', method=['GET'])
def api_system_info():
    net_interfaces = system_control.get_network_interfaces()
    ips = [n['ip'] for n in net_interfaces if n.get('ip')]
    monitors = system_control.get_monitors()
    apps = coordinator.config.get("external_apps", [])
    selected_ip = coordinator.status.get("selected_ip", "")

    # 智能自愈：若原绑定 IP 已失效或不存在，自动自愈为当前排序第一的最佳物理网卡
    if (not selected_ip or selected_ip not in ips) and ips:
        selected_ip = ips[0]
        coordinator.status["selected_ip"] = selected_ip
        coordinator.save_player_config()

    orientation = coordinator.status.get("orientation", "landscape")
    return {
        "status": "ok",
        "ips": ips,
        "network_interfaces": net_interfaces,
        "selected_ip": selected_ip,
        "orientation": orientation,
        "monitors": monitors,
        "external_apps": apps,
        "system_time": time.strftime("%Y-%m-%d %H:%M:%S")
    }

@app.route('/api/system/network_interfaces', method=['GET'])
def api_system_network_interfaces():
    net_interfaces = system_control.get_network_interfaces()
    ips = [n['ip'] for n in net_interfaces if n.get('ip')]
    selected_ip = coordinator.status.get("selected_ip", "")

    # 智能自愈
    if (not selected_ip or selected_ip not in ips) and ips:
        selected_ip = ips[0]
        coordinator.status["selected_ip"] = selected_ip
        coordinator.save_player_config()

    return {
        "status": "ok",
        "network_interfaces": net_interfaces,
        "selected_ip": selected_ip,
        "port": 8088,
        "platform": "windows",
        "is_android": False
    }

@app.route('/api/system/select_network_interface', method=['POST'])
def api_select_network_interface():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    ip = data.get("ip", "").strip()
    if ip:
        coordinator.status["selected_ip"] = ip
        coordinator.save_player_config()
        return {"status": "ok", "message": f"通信网卡已成功设定为: {ip}", "selected_ip": ip}
    return {"status": "error", "message": "无效网卡 IP"}

@app.route('/api/stream/live.mjpeg')
def route_stream_live_mjpeg():
    """ScreenStream 开源架构：提供低延迟 HTTP multipart 屏幕/窗口实时推流"""
    fps = request.query.get('fps', '12')
    try:
        fps_val = int(fps)
    except Exception:
        fps_val = 12
    response.content_type = 'multipart/x-mixed-replace; boundary=frame'
    response.headers['Cache-Control'] = 'no-cache, private'
    response.headers['Pragma'] = 'no-cache'
    return system_control.screen_stream_manager.generate_mjpeg_stream(fps=fps_val)

@app.route('/api/system/shutdown', method=['POST'])
def api_system_shutdown():
    return system_control.shutdown_system(force=True)

@app.route('/api/system/reboot', method=['POST'])
@app.route('/api/system/restart', method=['POST'])
def api_system_reboot():
    """EXE版专属：执行系统底层安全重启命令"""
    return system_control.restart_system(force=True)

@app.route('/api/system/sleep', method=['POST'])
def api_system_sleep():
    """触发大屏软件级深度待机休眠 (黑场停止播放)"""
    with coordinator.lock:
        coordinator.status["sleep_mode"] = True
        coordinator.config["sleep_mode"] = True
        coordinator.save_player_config()
    coordinator.handle_command('SLEEP', {})
    coordinator.handle_command('BLACKOUT', {"blackout": True, "enabled": True})
    cluster_sync.broadcast_full_config()
    return {"status": "ok", "message": "大屏已进入待机休眠 (黑场停止播放)"}

@app.route('/api/system/wakeup', method=['POST'])
@app.route('/api/system/power_on', method=['POST'])
@app.route('/api/system/boot', method=['POST'])
def api_system_wakeup():
    """触发大屏软件级唤醒 (解除黑场恢复待机放映)"""
    with coordinator.lock:
        coordinator.status["sleep_mode"] = False
        coordinator.config["sleep_mode"] = False
        coordinator.save_player_config()
    coordinator.handle_command('WAKEUP', {})
    coordinator.handle_command('BLACKOUT', {"blackout": False, "enabled": False})
    coordinator.handle_command('RETURN_TO_STANDBY', {})
    cluster_sync.broadcast_full_config()
    return {"status": "ok", "message": "大屏已唤醒 (已解除黑场，恢复待机放映)"}

@app.route('/api/system/scheduled_shutdown', method=['GET', 'POST'])
def api_system_scheduled_shutdown():
    """查询或保存定时关机与节假日排程配置"""
    if request.method == 'GET':
        return {"status": "ok", "data": scheduled_shutdown_manager.get_status()}
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        new_cfg = scheduled_shutdown_manager.save_config(data)
        return {
            "status": "ok",
            "message": "定时关机与节假日策略已成功保存",
            "data": scheduled_shutdown_manager.get_status()
        }
    except Exception as e:
        return {"status": "error", "message": f"保存定时关机配置失败: {e}"}

# ===================== 局域网大屏设备发现与自定义命名 API =====================

@app.route('/api/devices/list', method=['GET'])
def api_devices_list():
    """获取局域网已知大屏设备列表 (带自定义名称与状态)"""
    return device_discovery_manager.get_device_list(coordinator, cluster_sync)

@app.route('/api/devices/scan', method=['POST', 'GET'])
def api_devices_scan():
    """触发局域网大屏设备并发深度扫描"""
    return device_discovery_manager.scan_lan_devices(coordinator, cluster_sync)

@app.route('/api/devices/rename', method=['POST'])
def api_devices_rename():
    """设定指定设备的自定义备注名称"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    ip = data.get("ip")
    custom_name = data.get("custom_name")
    res = device_discovery_manager.set_device_name(ip, custom_name)
    try:
        primary_ip = system_control.get_primary_ip()
        if (ip in ("127.0.0.1", "localhost", primary_ip) or not ip) and custom_name:
            if 'native_cast' in globals():
                native_cast.set_device_name(custom_name)
            coordinator.config.setdefault("system", {})["cast_device_name"] = custom_name
            coordinator.config["cast_device_name"] = custom_name
            coordinator.save_player_config()
    except Exception:
        pass
    return res

@app.route('/api/devices/delete', method=['POST'])
def api_devices_delete():
    """从设备列表中移除离线或失效设备"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    ip = data.get("ip")
    return device_discovery_manager.delete_device(ip)

@app.route('/api/devices/manual_add', method=['POST'])
def api_devices_manual_add():
    """手动添加跨网段大屏设备 IP"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    ip = data.get("ip", "").strip()
    custom_name = data.get("custom_name", "").strip()
    return device_discovery_manager.manual_add_device(ip, custom_name)

@app.route('/api/devices/probe', method=['POST'])
def api_devices_probe():
    """单台设备即时深度探活检测"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    ip = data.get("ip", "").strip()
    res = device_discovery_manager.single_probe_device(ip)
    return {"status": "ok", "device": res}

@app.route('/api/system/cancel_shutdown', method=['POST'])
def api_system_cancel_shutdown():
    """人工一键取消当次关机倒计时并跳过今日关机"""
    res = scheduled_shutdown_manager.cancel_current_shutdown()
    return res

@app.route('/api/system/reset_shutdown', method=['POST'])
def api_system_reset_shutdown():
    """恢复今日定时关机计划"""
    res = scheduled_shutdown_manager.reset_cancel_state()
    return res

@app.route('/api/system/restart', method=['POST'])
def api_system_restart():
    return system_control.restart_system(force=True)

@app.route('/api/system/volume', method=['POST'])
def api_system_volume():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    action = data.get("action", "up")
    return system_control.adjust_volume(action)

@app.route('/api/system/keyboard', method=['POST'])
def api_system_keyboard():
    return system_control.launch_keyboard()

@app.route('/api/system/launch_app', method=['POST'])
def api_system_launch_app():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    path = data.get("path")
    args = data.get("args", "")
    # 联动向大屏下发暂停指令，释放 GPU 与声卡设备，彻底消灭渲染冲突
    try:
        coordinator.push_command("PAUSE", {})
    except Exception:
        pass
    return system_control.launch_app(path, args)

@app.route('/api/system/kill_app', method=['POST'])
def api_system_kill_app():
    """结束指定的第三方应用程序进程并联动恢复大屏置顶"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    path = data.get("path", "")
    name = data.get("name", "")
    pid = data.get("pid")
    res = system_control.kill_app(path=path, name=name, pid=pid)
    try:
        system_control.restore_player_window_topmost()
    except Exception:
        pass
    return res

@app.route('/api/system/app_status', method=['GET', 'POST'])
def api_system_app_status():
    """查询外部应用列表在系统中的实时存活/运行状态"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    apps = data.get("apps")
    if not apps:
        apps = coordinator.config.get("external_apps", [])
    status_map = system_control.get_apps_running_status(apps)
    return {"status": "ok", "app_status": status_map}

@app.route('/api/system/save_apps', method=['POST'])
def api_save_external_apps():
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    apps = data.get("apps", [])
    # 智能规范化外部应用：若为快捷方式自动解析真实 exe 目标
    for app in apps:
        p = app.get("path", "")
        if p and p.lower().endswith('.lnk'):
            resolved = system_control.resolve_lnk_target(p)
            if resolved and resolved.lower().endswith('.exe') and os.path.exists(resolved):
                app["target_exe"] = resolved
    coordinator.config["external_apps"] = apps
    coordinator.save_player_config()
    return {"status": "ok", "message": "外部应用列表已更新"}

@app.route('/api/player/window_mode', method=['GET'])
def api_get_window_mode():
    """获取大屏当前窗口模式 (是否全屏置顶)"""
    is_fs = getattr(coordinator, 'is_fullscreen_mode', True)
    return {
        "status": "ok",
        "fullscreen": is_fs,
        "mode": "FULLSCREEN" if is_fs else "WINDOWED_1280x720"
    }

@app.route('/api/system/save_all_config', method=['POST'])
def api_save_all_config():
    """将后台所有当前调整后的设置（画面比例、方向、循环模式、切片时长、音量、静音、字幕、待机、触控等）持久化到 player_config.json"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        
        with coordinator.lock:
            if "volume" in data:
                try:
                    coordinator.status["volume"] = max(0, min(100, int(data["volume"])))
                except Exception:
                    pass
            if "muted" in data:
                coordinator.status["muted"] = bool(data["muted"])
            if "scale_mode" in data and data["scale_mode"] in ["fill", "contain", "cover"]:
                coordinator.status["scale_mode"] = data["scale_mode"]
            if "orientation" in data and data["orientation"] in ["landscape", "portrait", "portrait_cw", "portrait_ccw"]:
                coordinator.status["orientation"] = data["orientation"]
            if "loop_mode" in data and data["loop_mode"] in ["FOLDER_LOOP", "SINGLE_LOOP", "ALL_LOOP", "PLAY_ONCE"]:
                coordinator.status["loop_mode"] = data["loop_mode"]
                coordinator.status["loop"] = (data["loop_mode"] != "PLAY_ONCE")
            if "switch_policy" in data and data["switch_policy"] in ["FINISHED", "DURATION"]:
                coordinator.status["switch_policy"] = data["switch_policy"]
            if "cycle_duration" in data:
                try:
                    coordinator.status["cycle_duration"] = max(3, int(data["cycle_duration"]))
                except Exception:
                    pass
            if "touch_mode" in data:
                coordinator.status["touch_mode"] = bool(data["touch_mode"])
            coordinator.save_player_config()
        return {
            "status": "ok",
            "message": "系统全局配置已成功保存！下次开机启动将自动加载生效"
        }
    except Exception as e:
        return {"status": "error", "message": f"保存配置失败: {e}"}

@app.route('/api/player/toggle_fullscreen', method=['POST'])
def api_toggle_fullscreen():
    """切换大屏全屏与居中运维模式"""
    is_fs = coordinator.toggle_fullscreen()
    w = coordinator.status.get("width", 1920)
    h = coordinator.status.get("height", 1080)
    return {
        "status": "ok",
        "fullscreen": is_fs,
        "width": w,
        "height": h,
        "mode": f"FULLSCREEN_{w}x{h}" if is_fs else f"WINDOWED_{w}x{h}"
    }

@app.route('/api/player/set_topmost', method=['POST'])
def api_set_player_topmost():
    """强制将大屏播放视窗设为全屏置顶 (HWND_TOPMOST) 并带到最前台"""
    try:
        coordinator.set_fullscreen_mode(True)
        system_control.restore_player_window_topmost()
        return {"status": "ok", "fullscreen": True, "message": "大屏播放视窗已恢复硬件级全屏置顶"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.route('/api/player/close_ppt', method=['POST'])
def api_close_ppt():
    """手动或联动关闭外部 PPT 放映进程"""
    res = system_control.close_ppt_process()
    with coordinator.lock:
        if coordinator.status.get("media_type") == "doc":
            idle_target = coordinator.status.get("idle_media", "demo_show.mp4")
            coordinator.status["current_media"] = idle_target
            ext = idle_target.split('.')[-1].lower() if '.' in idle_target else ''
            if ext in ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']:
                coordinator.status["media_type"] = "image"
            elif ext in ['pptx', 'ppt', 'pdf', 'doc', 'docx']:
                coordinator.status["media_type"] = "doc"
            else:
                coordinator.status["media_type"] = "video"
    return res

_last_ppt_open_file = ""
_last_ppt_open_time = 0.0

@app.route('/api/player/open_ppt', method=['POST'])
def api_open_ppt():
    """打开并全屏放映指定 PPT/PPTX 文档 (带 2.5 秒防抖，杜绝重复多实例打开)"""
    global _last_ppt_open_file, _last_ppt_open_time
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        raw_file = data.get("file") or data.get("path") or ""
        if not raw_file:
            return {"status": "error", "message": "未指定 PPT 文件"}
        
        now = time.time()
        if raw_file == _last_ppt_open_file and (now - _last_ppt_open_time) < 2.5:
            return {"status": "ok", "message": "PPT 放映进程已在启动中 (防抖拦截)"}
        _last_ppt_open_file = raw_file
        _last_ppt_open_time = now
        
        # 兼容相对路径与直接文件名
        if os.path.isabs(raw_file):
            abs_path = raw_file
        else:
            clean_sub = raw_file.replace("media/", "").replace("media\\", "").lstrip("/\\")
            abs_path = os.path.abspath(os.path.join(MEDIA_DIR, clean_sub))
        
        # 核心：精准以大屏窗口当前的真实物理屏幕为准，保证 PPT 与大屏窗口 100% 同屏
        hwnd_player = system_control.find_player_window_hwnd()
        if hwnd_player:
            target_mon = system_control.get_window_monitor_index(hwnd_player)
            coordinator.status["target_screen_index"] = target_mon
        else:
            target_mon = coordinator.status.get("target_screen_index", 0)

        # 瞬时同步协调器状态为 doc 模式，驱动控制台按键毫秒级切换为文档/PPT控制组
        fname = os.path.basename(abs_path)
        with coordinator.lock:
            coordinator.status["current_media"] = fname
            coordinator.status["media_type"] = "doc"
            coordinator.status["state"] = "PLAYING"

        return system_control.open_ppt_presentation(abs_path, target_monitor_index=target_mon)
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/system/monitors', method=['GET'])
def api_get_monitors():
    """获取所有物理显示器列表及当前大屏分配的屏幕"""
    mons = system_control.get_monitors()
    hwnd_player = system_control.find_player_window_hwnd()
    if hwnd_player:
        current_idx = system_control.get_window_monitor_index(hwnd_player)
        coordinator.status["target_screen_index"] = current_idx
    else:
        current_idx = coordinator.status.get("target_screen_index", 0)
    return {
        "status": "ok",
        "monitors": mons,
        "current_monitor_index": current_idx
    }

@app.route('/api/system/monitors', method=['POST'])
def api_set_monitor():
    """切换大屏呈现窗口所在的物理屏幕"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        index = int(data.get("index", 0))
        success = coordinator.set_target_screen(index)
        return {
            "status": "ok" if success else "error",
            "current_monitor_index": coordinator.status.get("target_screen_index", 0),
            "message": f"大屏窗口已移动至屏幕 {index + 1}" if success else "移动屏幕失败"
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/stream/quality', method=['GET'])
def api_get_stream_quality():
    """获取推流当前分辨率与画质预设"""
    info = system_control.screen_stream_manager.get_preset_info()
    return {"status": "ok", "quality": info}

@app.route('/api/stream/quality', method=['POST'])
def api_set_stream_quality():
    """动态热切换推流画质 (360p, 720p, 1080p)"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        preset = str(data.get("preset", "720p")).lower()
        info = coordinator.set_stream_quality(preset)
        return {"status": "ok", "quality": info}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/player/send_key', method=['POST'])
@app.route('/api/player/keystroke', method=['POST'])
def api_send_key():
    """模拟向大屏或外部放映窗口发送按键 (如 PGUP, PGDN, ESC, F5 等)，并同步大屏媒体翻页"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        key = str(data.get("key", "PGDN")).upper()
        # 1. 向底层发送 Win32 原生按键 (驱动外部 PPT / PDF 翻页)
        res = system_control.send_keystroke(key)
        # 2. 如果是大屏端内嵌的图片或文档，同步推送 DOC_PREV / DOC_NEXT 调度指令
        if key in ("PGUP", "PAGEUP", "LEFT", "UP"):
            coordinator.handle_command("DOC_PREV")
        elif key in ("PGDN", "PAGEDOWN", "RIGHT", "DOWN", "SPACE"):
            coordinator.handle_command("DOC_NEXT")
        elif key in ("ESC", "ESCAPE"):
            coordinator.handle_command("DOC_EXIT")
        elif key == "S":
            with coordinator.lock:
                new_state = "PAUSED" if coordinator.status.get("state") == "PLAYING" else "PLAYING"
                coordinator.status["state"] = new_state
        return res
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/system/file_dialog', method=['POST'])
def api_system_file_dialog():
    """调用原生文件选择对话框 (优先使用窗口绑定的原生模态弹窗，确保不被置顶遮挡)"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    filter_type = data.get("filter", "exe")

    return system_control.open_file_selector(filter_type)

@app.route('/api/system/open_media_dir', method=['GET', 'POST'])
def api_open_media_dir():
    """在操作系统资源管理器中直接打开本地素材存储目录"""
    try:
        folder = request.query.get('folder', '') or ''
        target = os.path.join(MEDIA_DIR, folder) if folder else MEDIA_DIR
        os.makedirs(target, exist_ok=True)
        if sys.platform.startswith('win'):
            os.startfile(target)
            return {"status": "ok", "path": target, "message": f"已在资源管理器中打开素材目录: {target}"}
        else:
            return {"status": "ok", "path": target, "message": f"素材目录: {target}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/system/autostart', method=['GET'])
def api_get_autostart():
    """获取开机自启动状态"""
    return system_control.get_autostart_status()

@app.route('/api/system/autostart', method=['POST'])
def api_set_autostart():
    """设置开机自启动"""
    try:
        data = json.load(request.body)
    except Exception:
        data = request.json or {}
    enable = bool(data.get("enable", False))
    return system_control.set_autostart_status(enable)

@app.route('/api/system/license', method=['GET'])
def api_get_license():
    """获取系统商业授权与到期状态"""
    try:
        is_valid, status_code, details = license_guard.check_license()
        return {
            "status": "success",
            "is_valid": is_valid,
            "status_code": status_code,
            "details": details
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.route('/api/system/license', method=['POST'])
def api_activate_license():
    """通过 6 位授权码在线激活或充值续期"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        code = str(data.get("code", "")).strip()
        if not code:
            return {"status": "error", "message": "请输入 12 位授权激活码 (XXXX-XXXX-XXXX)"}
        
        ok, msg = license_guard.activate(code)
        if ok:
            is_valid, status_code, details = license_guard.check_license()
            return {"status": "success", "message": msg, "details": details}
        else:
            return {"status": "error", "message": msg}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ===================== 外部硬件中控后台监听 (TCP 8000 & UDP 8001) =====================

def start_tcp_central_control_server(port=8000):
    """监听外部硬件中控 TCP 命令"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(('0.0.0.0', port))
        s.listen(5)
        print(f"[TCP Central] 外部硬件中控监听已启动在端口 {port}")
    except Exception as e:
        print(f"[TCP Central] 端口绑定失败: {e}")
        return

    while True:
        try:
            client, addr = s.accept()
            threading.Thread(target=_handle_tcp_client, args=(client, addr), daemon=True).start()
        except Exception:
            break

def _handle_tcp_client(client, addr):
    try:
        client.settimeout(10.0)
        data = client.recv(1024)
        if data:
            cmd = data.decode('utf-8', errors='ignore').strip()
            # 展馆物联网自定义中转拦截分发
            try:
                iot_engine.process_forwarding(cmd, protocol="TCP", source_addr=str(addr))
            except Exception as e_fwd:
                print(f"[TCP Central Forward Error] {e_fwd}")
            _dispatch_central_command(cmd)
            client.sendall(b"OK\r\n")
    except Exception:
        pass
    finally:
        client.close()

def start_udp_central_control_server(port=8001):
    """监听外部硬件中控 UDP 命令"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind(('0.0.0.0', port))
        print(f"[UDP Central] 外部硬件中控监听已启动在端口 {port}")
    except Exception as e:
        print(f"[UDP Central] UDP端口绑定失败: {e}")
        return

    while True:
        try:
            data, addr = s.recvfrom(1024)
            if data:
                cmd = data.decode('utf-8', errors='ignore').strip()
                # 展馆物联网自定义中转拦截分发
                try:
                    iot_engine.process_forwarding(cmd, protocol="UDP", source_addr=str(addr))
                except Exception as e_fwd:
                    print(f"[UDP Central Forward Error] {e_fwd}")
                _dispatch_central_command(cmd)
        except Exception:
            break

def _dispatch_central_command(cmd_str):
    """将外部中控简单文本命令映射为播控或一键开闭馆指令"""
    raw_cmd = cmd_str.strip()
    c = raw_cmd.upper()
    print(f"[Central Control Command] 收到外部指令: {raw_cmd}")

    # 1. 基础播放调度
    if c in ("PLAY", "RESUME"):
        coordinator.handle_command("PLAY")
    elif c == "PAUSE":
        coordinator.handle_command("PAUSE")
    elif c == "STOP":
        coordinator.handle_command("STOP")
    elif c == "NEXT":
        coordinator.handle_command("NEXT")
    elif c == "PREV":
        coordinator.handle_command("PREV")
    
    # 2. 画面与黑场控制
    elif c in ("BLACK_ON", "BLACKOUT_ON", "BLACKOUT", "BLACKOUT:ON", "BLACKOUT:1", "BLACK:1", "BLACK:ON"):
        coordinator.handle_command("BLACKOUT", {"blackout": True})
    elif c in ("BLACK_OFF", "BLACKOUT_OFF", "BLACKOUT:OFF", "BLACKOUT:0", "BLACK:0", "BLACK:OFF"):
        coordinator.handle_command("BLACKOUT", {"blackout": False})
    elif c in ("FREEZE_ON", "FREEZE", "FREEZE:ON", "FREEZE:1"):
        coordinator.handle_command("FREEZE", {"freeze": True})
    elif c in ("FREEZE_OFF", "FREEZE:OFF", "FREEZE:0"):
        coordinator.handle_command("FREEZE", {"freeze": False})

    # 3. 音量与静音控制
    elif c == "VOL_UP":
        system_control.adjust_volume("up")
    elif c == "VOL_DOWN":
        system_control.adjust_volume("down")
    elif c.startswith("VOL:") or c.startswith("VOL_SET:"):
        try:
            val_str = c.split(":", 1)[1].strip()
            vol_val = int(val_str)
            vol_val = max(0, min(100, vol_val))
            system_control.set_master_volume(vol_val)
            coordinator.handle_command("VOLUME", {"volume": vol_val})
        except Exception:
            pass
    elif c in ("MUTE", "MUTE_ON"):
        coordinator.handle_command("MUTE", {"muted": True})
    elif c in ("UNMUTE", "MUTE_OFF"):
        coordinator.handle_command("MUTE", {"muted": False})

    # 4. 指定媒体点播与待机回退
    elif c in ("IDLE", "STANDBY", "RETURN_STANDBY", "HOME"):
        coordinator.handle_command("RETURN_STANDBY", {})
    elif c.startswith("PLAY_ID:") or c.startswith("PLAY_NAME:") or c.startswith("SWITCH:") or c.startswith("LOAD:") or (c.startswith("PLAY:") and len(c) > 5):
        media_name = raw_cmd.split(":", 1)[1].strip()
        if media_name:
            # 如果是纯数字索引 (如 SWITCH:1 或 PLAY:2)
            if media_name.isdigit():
                try:
                    idx = int(media_name) - 1
                    coordinator.handle_command("SWITCH_INDEX", {"index": max(0, idx)})
                except Exception:
                    coordinator.handle_command("SWITCH_MEDIA", {"media": media_name})
            else:
                coordinator.handle_command("SWITCH_MEDIA", {"media": media_name})
    elif c.startswith("PLAY_INDEX:"):
        try:
            idx = int(c.split(":", 1)[1].strip())
            coordinator.handle_command("SWITCH_INDEX", {"index": idx})
        except Exception:
            pass

    # 5. 展馆环境物联开闭馆宏
    elif c == "OPEN_HALL":
        iot_engine.run_macro_async("open_pavilion", player_coordinator=coordinator)
    elif c == "CLOSE_HALL":
        iot_engine.run_macro_async("close_pavilion", player_coordinator=coordinator)

    # 6. 第三方展项程序拉起与系统电源
    elif c.startswith("APP:") or c.startswith("APP_LAUNCH:"):
        app_id = raw_cmd.split(":", 1)[1].strip()
        if app_id:
            system_control.launch_external_app_by_id(app_id)
    elif c == "SHUTDOWN":
        system_control.system_shutdown(delay=0)
    elif c == "REBOOT":
        system_control.system_reboot(delay=1)

# ===================== 毫秒级多机集群联播控制中枢 API =====================
@app.route('/api/sync/status', method=['GET', 'POST'])
@app.route('/api/cluster/status', method=['GET', 'POST'])
def api_sync_status():
    """获取多机集群联播实时状态与在线节点拓扑"""
    try:
        data = cluster_sync.get_cluster_status()
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({
            "status": "error",
            "message": f"获取状态异常: {str(e)}",
            "role": getattr(cluster_sync, 'role', 'STANDALONE'),
            "slaves_count": 0,
            "slaves": []
        }, ensure_ascii=False)

@app.route('/api/sync/detect', method=['GET', 'POST'])
@app.route('/api/sync/slaves', method=['GET', 'POST'])
@app.route('/api/sync/nodes', method=['GET', 'POST'])
@app.route('/api/cluster/detect', method=['GET', 'POST'])
@app.route('/api/cluster/slaves', method=['GET', 'POST'])
@app.route('/api/cluster/nodes', method=['GET', 'POST'])
@app.route('/api/slave/detect', method=['GET', 'POST'])
@app.route('/api/slave/status', method=['GET', 'POST'])
@app.route('/api/slaves/detect', method=['GET', 'POST'])
@app.route('/api/slaves', method=['GET', 'POST'])
def api_sync_detect():
    """主动向局域网广播探测在线从机，并返回最新集群拓扑"""
    try:
        data = cluster_sync.detect_slaves()
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({
            "status": "error",
            "message": f"从机检测异常: {str(e)}",
            "role": getattr(cluster_sync, 'role', 'STANDALONE'),
            "slaves_count": 0,
            "slaves": []
        }, ensure_ascii=False)

@app.route('/api/sync/role', method=['POST'])
def api_sync_set_role():
    """切换本机角色并持久固化: MASTER / SLAVE / STANDALONE"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        role = (data.get("role") or "STANDALONE").upper()
        master_ip = data.get("master_ip")
        slave_ips = data.get("slave_ips")
        ok, msg = cluster_sync.update_and_save_config(role=role, master_ip=master_ip, slave_ips=slave_ips)
        response.content_type = 'application/json; charset=utf-8'
        if ok:
            return json.dumps({
                "status": "ok",
                "message": msg,
                "role": cluster_sync.role,
                "master_ip": cluster_sync.master_ip,
                "slave_ips": cluster_sync.configured_slave_ips
            }, ensure_ascii=False)
        return json.dumps({"status": "error", "message": msg}, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": f"角色切换异常: {str(e)}"}, ensure_ascii=False)

@app.route('/api/sync/config', method=['GET', 'POST'])
def api_sync_config():
    """读取或保存永久固化的多机联播参数配置 (主从IP与角色)"""
    try:
        if request.method == 'GET':
            response.content_type = 'application/json; charset=utf-8'
            return json.dumps({
                "status": "ok",
                "role": cluster_sync.role,
                "master_ip": cluster_sync.master_ip,
                "slave_ips": cluster_sync.configured_slave_ips,
                "broadcast_port": cluster_sync.broadcast_port,
                "node_id": cluster_sync.node_id
            }, ensure_ascii=False)
        
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        role = data.get("role")
        master_ip = data.get("master_ip")
        slave_ips = data.get("slave_ips")
        ok, msg = cluster_sync.update_and_save_config(role=role, master_ip=master_ip, slave_ips=slave_ips)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({
            "status": "ok" if ok else "error",
            "message": msg,
            "role": cluster_sync.role,
            "master_ip": cluster_sync.master_ip,
            "slave_ips": cluster_sync.configured_slave_ips
        }, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/sync/register_slave', method=['POST'])
def api_sync_register_slave():
    """供从机通过 HTTP 8088 主动向 Master 注册节点拓扑 (解决多网卡/交换机过滤 UDP 广播的痛点)"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR') or request.environ.get('REMOTE_ADDR') or ''
        slave_ip = data.get("ip") or client_ip
        node_id = data.get("node_id") or f"SLAVE_{slave_ip}"
        cluster_sync.register_active_slave(node_id, slave_ip, data)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({
            "status": "ok",
            "message": "从机注册成功",
            "master_status": cluster_sync.get_cluster_status()
        }, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/sync/calibrate', method=['POST'])
def api_sync_calibrate():
    """Master 节点一键向全网广播时间戳精准对齐校准包"""
    try:
        if cluster_sync.role != "MASTER":
            response.content_type = 'application/json; charset=utf-8'
            return json.dumps({"status": "error", "message": "当前节点不是 Master 主控机，无法发起全网校准"}, ensure_ascii=False)
        with coordinator.lock:
            curr_t = coordinator.status.get("current_time", 0.0)
        cluster_sync.broadcast_master_command("SEEK", {"time": curr_t})
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "ok", "message": "已向全网广播校准脉冲", "time": curr_t}, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": f"全网校准异常: {str(e)}"}, ensure_ascii=False)

@app.route('/api/sync/master_config', method=['GET'])
def api_sync_master_config():
    """供从机拉取 Master 主控机的全量配置与状态 (包含画面模式、字幕、音量、待机等)"""
    try:
        full_cfg = cluster_sync.get_full_master_config()
        full_cfg["status"] = "ok"
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(full_cfg, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/sync/apply_master_config', method=['POST'])
def api_sync_apply_master_config():
    """从机接收并应用来自 Master 的全量设置"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        ok, msg = cluster_sync.apply_master_full_config(data)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "ok" if ok else "error", "message": msg}, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/sync/sync_all_to_slaves', method=['POST'])
def api_sync_all_to_slaves():
    """管理后台一键触发：将当前主控机的所有设置全量分发同步到所有从机"""
    try:
        if cluster_sync.role != "MASTER":
            response.content_type = 'application/json; charset=utf-8'
            return json.dumps({"status": "error", "message": "当前节点不是主控机 (MASTER)，无法向从机推送设置"}, ensure_ascii=False)
        ok, msg = cluster_sync.broadcast_full_config()
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "ok" if ok else "error", "message": msg}, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/system/logs', method=['GET'])
def api_get_system_logs():
    """获取程序运行日志列表 (支持条数与分类筛选，方便运维排查)"""
    try:
        limit = int(request.query.get('limit', 100))
    except Exception:
        limit = 100
    category = request.query.get('category', '').strip()
    logs = sys_logger.get_recent_logs(limit=limit, category=category if category else None)
    return {
        "status": "ok",
        "total": len(logs),
        "logs": logs,
        "logs_dir": sys_logger.logs_dir
    }

# =================== 局域网大屏在线设备中枢 API ===================
@app.route('/fleet', method=['GET'])
def route_fleet():
    """局域网大屏在线设备中枢独立全功能页面"""
    return static_file('fleet.html', root=STATIC_DIR)

@app.route('/api/devices/list', method=['GET'])
def api_devices_list():
    """获取局域网全部在线/已知大屏设备列表"""
    try:
        data = device_discovery_manager.get_device_list(coordinator, cluster_sync)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e), "devices": []}, ensure_ascii=False)

@app.route('/api/devices/scan', method=['POST'])
def api_devices_scan():
    """并发高速扫描探测局域网内所有大屏设备"""
    try:
        data = device_discovery_manager.scan_lan_devices(coordinator, cluster_sync)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e), "devices": []}, ensure_ascii=False)

@app.route('/api/devices/rename', method=['POST'])
def api_devices_rename():
    """设置设备的自定义别名并持久化落盘"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        ip = data.get('ip', '')
        custom_name = data.get('custom_name', '')
        res = device_discovery_manager.set_device_name(ip, custom_name)
        try:
            primary_ip = system_control.get_primary_ip()
            if (ip in ("127.0.0.1", "localhost", primary_ip) or not ip) and custom_name:
                if 'native_cast' in globals():
                    native_cast.set_device_name(custom_name)
                coordinator.config.setdefault("system", {})["cast_device_name"] = custom_name
                coordinator.config["cast_device_name"] = custom_name
                coordinator.save_player_config()
        except Exception:
            pass
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(res, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/devices/delete', method=['POST'])
def api_devices_delete():
    """从设备列表中移除指定设备"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        ip = data.get('ip', '')
        res = device_discovery_manager.delete_device(ip)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(res, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/devices/manual_add', method=['POST'])
def api_devices_manual_add():
    """手动录入大屏设备并探测握手"""
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        ip = data.get('ip', '')
        custom_name = data.get('custom_name', '')
        res = device_discovery_manager.manual_add_device(ip, custom_name)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(res, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)




# 全局 API 错误处理器 (确保任何未命中或错误的 /api/ 请求均返回标准 JSON，彻底杜绝前端 SyntaxError)
@app.error(404)
def error404(error):
    if request.path.startswith('/api/'):
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": f"未找到请求的 API 接口: {request.path}", "code": 404}, ensure_ascii=False)
    return "<h1>404 Not Found</h1>"

@app.error(405)
def error405(error):
    if request.path.startswith('/api/'):
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": f"请求方法不支持 ({request.method}): {request.path}", "code": 405}, ensure_ascii=False)
    return "<h1>405 Method Not Allowed</h1>"

@app.error(500)
def error500(error):
    if request.path.startswith('/api/'):
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": "服务器内部处理异常", "code": 500}, ensure_ascii=False)
    return "<h1>500 Internal Server Error</h1>"

def run_http_server(host='0.0.0.0', port=8088):
    """启动 Bottle HTTP 服务 (使用多线程并发引擎，彻底消除大文件传输阻塞)"""
    try:
        os.environ['NO_PROXY'] = 'localhost,127.0.0.1,0.0.0.0'
        os.environ['no_proxy'] = 'localhost,127.0.0.1,0.0.0.0'
        print(f"[HTTP Server] VisualCast 智能中枢服务已就绪 -> http://{host}:{port} (多线程并发加速就绪)")
        run(app, host=host, port=port, server=ThreadedServerAdapter, quiet=True)
    except Exception as e:
        print(f"[HTTP Server 致命错误] 启动失败: {e}")

if __name__ == '__main__':
    t_tcp = threading.Thread(target=start_tcp_central_control_server, daemon=True)
    t_udp = threading.Thread(target=start_udp_central_control_server, daemon=True)
    t_tcp.start()
    t_udp.start()
    run_http_server()
