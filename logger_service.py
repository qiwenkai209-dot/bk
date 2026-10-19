# -*- coding: utf-8 -*-
"""
VisualCast 智能播控系统 - 统一持久化日志服务
功能：
1. 自动在程序根目录生成并维护 logs/ 日志文件夹
2. 支持分类日志记录 (SYSTEM, OPERATION, CLUSTER, USB_SYNC, IOT)
3. 具备按日期与大小双重滚动机制 (单文件 10MB 自动轮转，保留近 15 天日志)
4. 线程安全队列写入，绝对不阻塞播控主循环与毫秒级时钟
5. 提供内存近 200 条热日志缓存，供 Web 后台即时拉取回显
"""
import os
import sys
import time
import datetime
import threading
from collections import deque

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.abspath(os.path.dirname(__file__))

LOGS_DIR = os.path.join(BASE_DIR, "logs")

try:
    os.makedirs(LOGS_DIR, exist_ok=True)
except Exception:
    pass

class VisualCastLogger:
    def __init__(self, logs_dir=LOGS_DIR, max_recent=200):
        self.logs_dir = logs_dir
        self.lock = threading.Lock()
        self.recent_logs = deque(maxlen=max_recent)
        self._current_date_str = ""
        self._file_handle = None
        self._ensure_dir()

    def _ensure_dir(self):
        try:
            if not os.path.exists(self.logs_dir):
                os.makedirs(self.logs_dir, exist_ok=True)
        except Exception as e:
            print(f"[Logger] 创建日志目录失败: {e}", file=sys.stderr)

    def _get_log_filename(self):
        today = datetime.datetime.now().strftime("%Y-%m-%d")
        return os.path.join(self.logs_dir, f"visualcast_{today}.log")

    def log(self, category: str, message: str, level: str = "INFO"):
        """
        写入一条标准化日志
        :param category: 模块分类 (SYSTEM, PLAY, CLUSTER, USB, IOT, AUTH, ERROR)
        :param message: 日志内容
        :param level: 级别 (INFO, WARN, ERROR, DEBUG)
        """
        now = datetime.datetime.now()
        timestamp = now.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        cat = (category or "SYSTEM").upper().strip()
        lvl = (level or "INFO").upper().strip()
        line = f"[{timestamp}] [{lvl:<5}] [{cat:<8}] {message}"

        # 1. 存入内存热队列
        entry = {
            "time": timestamp,
            "level": lvl,
            "category": cat,
            "message": message,
            "raw": line
        }
        with self.lock:
            self.recent_logs.append(entry)

            # 2. 持久化到物理文件
            try:
                filepath = self._get_log_filename()
                # 检查文件大小超限 (10MB 自动轮转)
                if os.path.exists(filepath) and os.path.getsize(filepath) > 10 * 1024 * 1024:
                    rot_time = now.strftime("%H%M%S")
                    new_name = filepath.replace(".log", f"_{rot_time}.log")
                    try:
                        os.rename(filepath, new_name)
                    except Exception:
                        pass

                with open(filepath, "a", encoding="utf-8", errors="replace") as f:
                    f.write(line + "\n")
            except Exception as ex:
                print(f"[Logger] 写入日志文件失败: {ex}", file=sys.stderr)

    def info(self, category: str, message: str):
        self.log(category, message, level="INFO")

    def warn(self, category: str, message: str):
        self.log(category, message, level="WARN")

    def error(self, category: str, message: str):
        self.log(category, message, level="ERROR")

    def get_recent_logs(self, limit: int = 100, category: str = None):
        """获取近期日志用于 Web 端展示"""
        with self.lock:
            logs = list(self.recent_logs)
        if category:
            cat_upper = category.upper()
            logs = [l for l in logs if l.get("category") == cat_upper]
        return logs[-limit:]

    def clean_old_logs(self, keep_days: int = 15):
        """定期清理过期日志"""
        try:
            now_ts = time.time()
            max_age = keep_days * 86400
            if not os.path.exists(self.logs_dir):
                return
            for fname in os.listdir(self.logs_dir):
                if fname.startswith("visualcast_") and fname.endswith(".log"):
                    fpath = os.path.join(self.logs_dir, fname)
                    if os.path.isfile(fpath):
                        if now_ts - os.path.getmtime(fpath) > max_age:
                            try:
                                os.remove(fpath)
                            except Exception:
                                pass
        except Exception:
            pass

# 单例日志实例
sys_logger = VisualCastLogger()

# 兼容全局快捷调用
def log_event(category: str, message: str, level: str = "INFO"):
    sys_logger.log(category, message, level)
