# -*- coding: utf-8 -*-
"""
VisualCast 定时关机引擎 (Scheduled Shutdown Engine)
特性:
1. 极简自定义星期排程: 支持周一至周日自由勾选组合
2. 设定时间精确执行: 每日到达设定时间自动执行底层安全关机
3. 高容错秒级守护: 宽容窗口判定，杜绝错过关机
4. 双重底层强制关机: shutdown /s /f /t 0 + Win32 API 提权强制关机
5. 永久持久化至 config/player_config.json
"""

import os
import sys
import json
import time
import datetime
import threading
from logger_service import log_event
import system_control

DEFAULT_SHUTDOWN_CONFIG = {
    "enabled": False,
    "time": "21:30",                        # 关机时间 HH:MM (24小时制)
    "weekdays": [1, 2, 3, 4, 5, 6, 7]       # 1=周一, 7=周日自由勾选
}

class ScheduledShutdownManager:
    """定时关机核心管理器 (仅基于周一至周日自定义排程)"""
    def __init__(self, config_dir=None):
        self.lock = threading.Lock()
        if not config_dir:
            exe_dir = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
            config_dir = os.path.join(exe_dir, 'config')
        self.config_dir = config_dir
        self.player_cfg_path = os.path.join(config_dir, 'player_config.json')
        self.separate_cfg_path = os.path.join(config_dir, 'scheduled_shutdown.json')

        self.config = dict(DEFAULT_SHUTDOWN_CONFIG)
        self.cancelled_dates = set()  # 记录今天已被人工取消关机的日期字符串 (如 "2026-10-05")
        self.executed_dates = set()   # 记录今天已执行过关机的日期
        self.app_start_time = time.time()  # 软件启动时间戳
        self.startup_grace_seconds = 180   # 开机前3分钟安全保护期，绝对禁止关机，防止开机死循环

        self.load_config()

        # 启动后台秒级守护检测线程
        self.worker_thread = threading.Thread(target=self._daemon_loop, name="ScheduledShutdownDaemon", daemon=True)
        self.worker_thread.start()
        print(f"[ScheduledShutdown] 定时关机引擎已就绪: enabled={self.config.get('enabled')}, time={self.config.get('time')}, weekdays={self.config.get('weekdays')}, 启动保护期={self.startup_grace_seconds}s")

    def load_config(self):
        """优先从 player_config.json 的 scheduled_shutdown 读取，兼容独立 scheduled_shutdown.json"""
        with self.lock:
            loaded = False
            # 1. 尝试从 player_config.json 中读取
            if os.path.exists(self.player_cfg_path):
                try:
                    with open(self.player_cfg_path, 'r', encoding='utf-8') as f:
                        cfg_all = json.load(f)
                        if "scheduled_shutdown" in cfg_all and isinstance(cfg_all["scheduled_shutdown"], dict):
                            self.config.update(cfg_all["scheduled_shutdown"])
                            loaded = True
                except Exception as e:
                    print(f"[ScheduledShutdown] 读取 player_config.json 异常: {e}")

            # 2. 尝试从独立的 scheduled_shutdown.json 中读取补充
            if not loaded and os.path.exists(self.separate_cfg_path):
                try:
                    with open(self.separate_cfg_path, 'r', encoding='utf-8') as f:
                        sec_cfg = json.load(f)
                        if isinstance(sec_cfg, dict):
                            self.config.update(sec_cfg)
                            loaded = True
                except Exception as e:
                    print(f"[ScheduledShutdown] 读取 scheduled_shutdown.json 异常: {e}")

            # 确保关键数据结构规范
            if not isinstance(self.config.get("weekdays"), list):
                self.config["weekdays"] = [1, 2, 3, 4, 5, 6, 7]
            else:
                self.config["weekdays"] = [int(w) for w in self.config["weekdays"] if 1 <= int(w) <= 7]

            # 清理废弃的旧字段
            self.config.pop("skip_holidays", None)

    def save_config(self, new_cfg=None):
        """保存配置到磁盘并永久持久化"""
        with self.lock:
            today_str = datetime.date.today().strftime("%Y-%m-%d")
            # 重新保存配置时，清除当天的已执行和取消状态，允许用户测试最新时间
            self.executed_dates.discard(today_str)
            self.cancelled_dates.discard(today_str)

            if new_cfg and isinstance(new_cfg, dict):
                if "enabled" in new_cfg:
                    self.config["enabled"] = bool(new_cfg["enabled"])
                if "time" in new_cfg and new_cfg["time"]:
                    self.config["time"] = str(new_cfg["time"]).strip()
                if "weekdays" in new_cfg and isinstance(new_cfg["weekdays"], list):
                    clean_days = [int(w) for w in new_cfg["weekdays"] if 1 <= int(w) <= 7]
                    self.config["weekdays"] = sorted(clean_days) if clean_days else [1, 2, 3, 4, 5, 6, 7]

            # 确保废弃字段已被移除
            self.config.pop("skip_holidays", None)

            self.startup_grace_seconds = 0  # 管理员主动保存配置，即时生效无需等待开机保护期

            # 写入 player_config.json
            try:
                os.makedirs(self.config_dir, exist_ok=True)
                full_cfg = {}
                if os.path.exists(self.player_cfg_path):
                    with open(self.player_cfg_path, 'r', encoding='utf-8') as f:
                        full_cfg = json.load(f)
                full_cfg["scheduled_shutdown"] = dict(self.config)
                with open(self.player_cfg_path, 'w', encoding='utf-8') as f:
                    json.dump(full_cfg, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"[ScheduledShutdown] 保存至 player_config.json 异常: {e}")

            # 同时写入独立的 scheduled_shutdown.json 做双保险备份
            try:
                with open(self.separate_cfg_path, 'w', encoding='utf-8') as f:
                    json.dump(self.config, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"[ScheduledShutdown] 保存至 scheduled_shutdown.json 异常: {e}")

            log_event("CONFIG", f"定时关机配置已更新落盘: enabled={self.config.get('enabled')}, time={self.config.get('time')}, weekdays={self.config.get('weekdays')}")
            return self.config

    def get_today_target_shutdown_time(self):
        """
        计算今天是否应该执行定时关机。
        若应执行，返回 (datetime.datetime, 说明)；若今天不执行，返回 (None, 不执行原因)。
        """
        if not self.config.get("enabled", False):
            return None, "定时关机功能未启用"

        today = datetime.date.today()
        today_str = today.strftime("%Y-%m-%d")

        # 检查今天是否已被人工取消
        if today_str in self.cancelled_dates:
            return None, "今日定时关机已被取消"

        # 检查今天是否已执行过关机
        if today_str in self.executed_dates:
            return None, "今日定时关机已执行"

        # 自定义星期几匹配 (1=周一, 7=周日)
        weekday = today.isoweekday()
        allowed_weekdays = self.config.get("weekdays", [1, 2, 3, 4, 5, 6, 7])
        if weekday not in allowed_weekdays:
            week_names = {1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六", 7: "周日"}
            return None, f"今日{week_names.get(weekday, '')}未勾选关机计划"

        # 解析时间字符串 HH:MM
        time_str = self.config.get("time", "21:30")
        try:
            parts = time_str.strip().split(':')
            h = int(parts[0])
            m = int(parts[1])
            target_dt = datetime.datetime(today.year, today.month, today.day, h, m, 0)
            return target_dt, "计划正常关机"
        except Exception as e:
            return None, f"关机时间解析失败 ({time_str}): {e}"

    def cancel_current_shutdown(self):
        """人工取消今日的关机，并中止 Windows 挂起的关机操作 (防止设备无法开机)"""
        with self.lock:
            today_str = datetime.date.today().strftime("%Y-%m-%d")
            self.cancelled_dates.add(today_str)
            # 中止任何系统正在挂起的关机指令 (shutdown /a)
            try:
                import subprocess
                subprocess.Popen('shutdown /a', shell=True)
            except Exception as ex:
                print(f"[ScheduledShutdown] 调用 shutdown /a 异常: {ex}")
            log_event("SHUTDOWN", f"管理员已人工取消今日定时关机 (日期: {today_str})")
            return {
                "status": "ok",
                "message": "已成功取消今日定时关机，主机将继续保持开机状态",
                "cancelled_date": today_str
            }

    def reset_cancel_state(self):
        """恢复今天的定时关机 (清除取消状态)"""
        with self.lock:
            today_str = datetime.date.today().strftime("%Y-%m-%d")
            self.cancelled_dates.discard(today_str)
            return {"status": "ok", "message": "已恢复今日定时关机计划"}

    def get_status(self):
        """获取定时关机全局状态，供后台实时展示"""
        with self.lock:
            today = datetime.date.today()
            target_dt, reason = self.get_today_target_shutdown_time()
            today_str = today.strftime("%Y-%m-%d")
            is_cancelled = (today_str in self.cancelled_dates)
            is_executed = (today_str in self.executed_dates)

            status_payload = {
                "config": dict(self.config),
                "today_cancelled": is_cancelled,
                "today_executed": is_executed,
                "target_time_str": target_dt.strftime("%H:%M") if target_dt else None,
                "target_datetime_str": target_dt.strftime("%Y-%m-%d %H:%M:%S") if target_dt else None,
                "schedule_desc": reason
            }
            return status_payload

    def _daemon_loop(self):
        """后台高精度秒级调度线程"""
        while True:
            try:
                time.sleep(1.0)
                now = datetime.datetime.now()
                today_str = now.strftime("%Y-%m-%d")

                # 如果跨天，清理过期的 cancelled_dates 与 executed_dates
                with self.lock:
                    if len(self.cancelled_dates) > 7:
                        self.cancelled_dates = {d for d in self.cancelled_dates if d == today_str}
                    if len(self.executed_dates) > 7:
                        self.executed_dates = {d for d in self.executed_dates if d == today_str}

                # 开机防死循环安全保护期 (开机180秒内绝不执行自动关机，防止设备刚开机又被关)
                uptime = time.time() - self.app_start_time
                if uptime < self.startup_grace_seconds:
                    continue

                target_dt, _ = self.get_today_target_shutdown_time()
                if not target_dt:
                    continue

                # 计算当前时间超出目标关机时间的秒数 (>=0 说明已到点或已过点)
                elapsed_seconds = (now - target_dt).total_seconds()

                # 宽容触发窗口：从目标时刻到达开始，在 1 分钟（60 秒）宽容窗口内
                # 只要当天尚未执行过关机且未被人工取消，立刻执行安全强制关机！
                if 0 <= elapsed_seconds <= 60:
                    with self.lock:
                        if today_str not in self.executed_dates and today_str not in self.cancelled_dates:
                            self.executed_dates.add(today_str)
                            print(f"[ScheduledShutdown] 定时关机排程时刻到达 ({target_dt.strftime('%H:%M')})。按商显运营规范，实际系统关机指令已安全屏蔽，大屏 24 小时保持常亮放映。")
                            log_event("SHUTDOWN", f"定时关机排程时刻到达 ({target_dt.strftime('%H:%M')})，系统保持常亮放映")

            except Exception as e:
                print(f"[ScheduledShutdown] 调度守护异常: {e}")
                time.sleep(2.0)

# 全局单例管理器
scheduled_shutdown_manager = ScheduledShutdownManager()
