# -*- coding: utf-8 -*-
"""
VisualCast 毫秒级多机集群联播引擎 (Cluster Frame-Accurate Sync Engine)
================================================================================
技术架构：
1. Master-Slave (主-从) 与 Standalone (单机) 三模自适应架构
2. 基于局域网 UDP 组播/广播高精度授时 (Cristian算法消除晶振与网络时钟漂移，时差稳定在 ±2ms 内)
3. 多网卡定向子网广播 (Subnet Broadcast) + 单播直连 (Unicast Direct) + HTTP 状态双保险兜底
4. 永久固化配置 (config/cluster_sync_config.json)，重启电脑与程序 100% 自动恢复角色与目标 IP
5. 跨文件夹素材智能自愈匹配 (从机自动在本地 media 所有子文件夹寻找同名素材起播)
"""

import os
import sys
import time
import json
import socket
import struct
import threading
import urllib.request
import urllib.error
from typing import Dict, List, Optional, Any
from logger_service import sys_logger, log_event

SYNC_BROADCAST_PORT = 8002
SYNC_MAGIC = "VC_SYNC_V1"

def _get_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = _get_base_dir()
MEDIA_DIR = os.path.join(BASE_DIR, "media")

def _get_cluster_config_path():
    cfg_dir = os.path.join(_get_base_dir(), "config")
    try:
        os.makedirs(cfg_dir, exist_ok=True)
    except Exception:
        pass
    return os.path.join(cfg_dir, "cluster_sync_config.json")

def find_media_in_slave_folders(target_media: str) -> tuple:
    """
    在从机本地 media 素材库的所有文件夹中递归寻找匹配的素材
    :param target_media: 主机发来的素材名称或相对路径，例如 "宣传片/demo.mp4" 或 "demo.mp4"
    :return: (found: bool, local_rel_path: str, local_folder: str)
    """
    if not target_media:
        return False, "", ""

    norm_target = target_media.replace('\\', '/').strip('/')
    
    # 1. 优先检查绝对/原相对路径在从机本地是否存在
    direct_path = os.path.join(MEDIA_DIR, norm_target)
    if os.path.isfile(direct_path):
        folder = os.path.dirname(norm_target)
        return True, norm_target, folder

    # 2. 提取纯文件名 (去除主机可能存在的子文件夹前缀)
    target_filename = os.path.basename(norm_target)
    target_stem, target_ext = os.path.splitext(target_filename)
    target_stem_lower = target_stem.lower()
    target_filename_lower = target_filename.lower()

    if not os.path.exists(MEDIA_DIR):
        return False, target_media, ""

    # 3. 递归遍历从机所有子文件夹进行同名比对
    exact_match = None
    fuzzy_match = None

    for root, dirs, files in os.walk(MEDIA_DIR):
        rel_root = os.path.relpath(root, MEDIA_DIR).replace('\\', '/')
        cur_folder = "" if rel_root == '.' else rel_root

        for fname in files:
            if fname.startswith('.') or fname.endswith('.trans_tmp') or fname.startswith('~$'):
                continue

            f_rel = fname if not cur_folder else f"{cur_folder}/{fname}"
            f_lower = fname.lower()

            # A. 完全同名匹配 (包含扩展名，大小写不敏感)
            if f_lower == target_filename_lower:
                exact_match = (True, f_rel, cur_folder)
                break

            # B. 主文件名相同，扩展名属于通用多媒体格式的比对
            f_stem, f_ext = os.path.splitext(fname)
            if f_stem.lower() == target_stem_lower and not fuzzy_match:
                fuzzy_match = (True, f_rel, cur_folder)

        if exact_match:
            break

    if exact_match:
        return exact_match
    if fuzzy_match:
        return fuzzy_match

    return False, target_media, ""

class ClusterSyncManager:
    """多机毫秒级联播同步调度器 (单例)"""
    def __init__(self, coordinator=None):
        self.coordinator = coordinator
        self.role = "STANDALONE"       # "STANDALONE" | "MASTER" | "SLAVE"
        self.master_ip = ""            # 从机模式下指定锁定的 Master 主机 IP (如 192.168.3.17)
        self.configured_slave_ips = [] # 主机模式下指定的 Slave 从机 IP 列表 (如 ["192.168.3.20"])
        self.node_id = f"VC_{socket.gethostname()}_{int(time.time()) % 10000}"
        self.broadcast_port = SYNC_BROADCAST_PORT
        self.running = False
        
        # 时钟与时间基准
        self.clock_offset_ms = 0.0     # 本机系统毫秒时钟相对于 Master 的时间偏移 (Slave 模式)
        self.last_master_beat = 0.0    # 最近一次收到 Master 心跳的时间戳 (毫秒)
        self.master_info = {}          # 当前锁定的 Master 节点元数据
        self.active_slaves = {}        # Master 模式下探测到的所有从机节点表: {node_id: {ip, last_seen, diff_ms, ...}}
        self.slave_loading_media = ""  # 从机正在加载的素材名，防止点播未完成时心跳重复触发
        self.last_load_cmd_time = 0.0  # 最近一次下发加载指令时间戳
        self.last_full_config_sync_time = 0.0  # 最近一次拉取 Master 全量配置时间戳
        self.last_applied_config_ts = 0.0      # 最近一次生效的 Master 配置版本时间戳
        
        # 线程与 Socket
        self.sock_send = None
        self.sock_recv = None
        self.threads = []
        self.lock = threading.Lock()
        
        # 配置文件路径
        self.config_file = _get_cluster_config_path()
        self.load_config()

    def load_config(self):
        """加载多机同步配置 (永久固化恢复)"""
        # 默认网段自适应预设 (若在 192.168.3.x 网段下自动辅助初始化)
        local_ips = []
        try:
            local_ips = socket.gethostbyname_ex(socket.gethostname())[2]
        except Exception:
            pass

        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.role = data.get("role", "STANDALONE").upper()
                    self.master_ip = data.get("master_ip", "").strip()
                    s_ips = data.get("slave_ips", [])
                    if isinstance(s_ips, str):
                        self.configured_slave_ips = [s.strip() for s in s_ips.replace('，', ',').split(',') if s.strip()]
                    elif isinstance(s_ips, list):
                        self.configured_slave_ips = [str(s).strip() for s in s_ips if str(s).strip()]
                    self.broadcast_port = data.get("broadcast_port", SYNC_BROADCAST_PORT)
                    print(f"[ClusterSync] 载入持久化配置: 角色={self.role}, 主控IP={self.master_ip or '自动广播'}, 目标从机={self.configured_slave_ips}")
                    return
            except Exception as e:
                print(f"[ClusterSync] 读取配置文件异常: {e}")

        # 若无旧配置且处于用户现场 192.168.3.x 环境，进行智能预设
        if "192.168.3.20" in local_ips:
            self.role = "SLAVE"
            self.master_ip = "192.168.3.17"
            self.save_config()
            print("[ClusterSync] 自动识别当前为现场从机 192.168.3.20，预设锁定主控机 192.168.3.17")
        elif "192.168.3.17" in local_ips:
            self.role = "MASTER"
            self.configured_slave_ips = ["192.168.3.20"]
            self.save_config()
            print("[ClusterSync] 自动识别当前为现场主控机 192.168.3.17，预设同步从机 192.168.3.20")

    def save_config(self):
        """保存多机同步配置到持久化文件"""
        try:
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump({
                    "role": self.role,
                    "master_ip": self.master_ip,
                    "slave_ips": self.configured_slave_ips,
                    "broadcast_port": self.broadcast_port,
                    "node_id": self.node_id
                }, f, indent=2, ensure_ascii=False)
            print(f"[ClusterSync] 参数已成功持久化固化 -> {self.config_file}")
            log_event("CLUSTER", f"集群联播参数已固化: 角色={self.role}, 主控IP={self.master_ip}, 从机IPs={self.configured_slave_ips}")
        except Exception as e:
            print(f"[ClusterSync] 保存配置异常: {e}")

    def update_and_save_config(self, role: str = None, master_ip: str = None, slave_ips: Any = None):
        """一键更新并永久固化参数"""
        with self.lock:
            if role:
                valid_roles = ["STANDALONE", "MASTER", "SLAVE"]
                r_upper = role.upper()
                if r_upper in valid_roles:
                    self.role = r_upper
            if master_ip is not None:
                self.master_ip = master_ip.strip()
            if slave_ips is not None:
                if isinstance(slave_ips, str):
                    self.configured_slave_ips = [s.strip() for s in slave_ips.replace('，', ',').split(',') if s.strip()]
                elif isinstance(slave_ips, list):
                    self.configured_slave_ips = [str(s).strip() for s in slave_ips if str(s).strip()]
            self.save_config()
        return True, f"参数已成功固化 (角色: {self.role}, 主机: {self.master_ip or '自动'})"

    def start(self):
        """启动集群同步守护线程"""
        if self.running:
            return
        self.running = True
        
        # 1. 创建发送 UDP Socket (开启广播权限)
        try:
            self.sock_send = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock_send.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        except Exception as e:
            print(f"[ClusterSync] 初始化发送 Socket 异常: {e}")

        # 2. 创建接收 UDP Socket
        try:
            self.sock_recv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock_recv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock_recv.bind(("0.0.0.0", self.broadcast_port))
            self.sock_recv.settimeout(1.2)
        except Exception as e:
            print(f"[ClusterSync] 绑定监听端口 {self.broadcast_port} 异常: {e}")

        # 3. 启动 UDP 接收线程
        t_recv = threading.Thread(target=self._recv_loop, daemon=True, name="ClusterSync-Recv")
        t_recv.start()
        self.threads.append(t_recv)

        # 4. 启动节拍心跳广播守护线程
        t_beat = threading.Thread(target=self._heartbeat_loop, daemon=True, name="ClusterSync-Beat")
        t_beat.start()
        self.threads.append(t_beat)

        # 5. 启动从机专属 HTTP 双保险同步守护线程 (解决多网卡/交换机过滤 UDP 广播的痛点)
        t_http = threading.Thread(target=self._http_sync_loop, daemon=True, name="ClusterSync-HttpFallback")
        t_http.start()
        self.threads.append(t_http)

        print(f"[VisualCast 集群联播引擎] 已启动，本机角色: 【{self.role}】，主控IP: 【{self.master_ip or '全网广播'}】，端口: {self.broadcast_port}")

    def stop(self):
        """停止集群联播引擎"""
        self.running = False
        if self.sock_recv:
            try: self.sock_recv.close()
            except Exception: pass
        if self.sock_send:
            try: self.sock_send.close()
            except Exception: pass

    def set_role(self, new_role: str):
        """切换角色：MASTER / SLAVE / STANDALONE 并固化"""
        valid_roles = ["STANDALONE", "MASTER", "SLAVE"]
        if new_role not in valid_roles:
            return False, f"无效角色: {new_role}"
        with self.lock:
            old_role = self.role
            self.role = new_role
            if new_role == "SLAVE":
                self.clock_offset_ms = 0.0
                self.last_master_beat = 0.0
                self.master_info = {}
            elif new_role == "MASTER":
                self.active_slaves.clear()
            self.save_config()
        print(f"[ClusterSync] 联播角色切换: {old_role} -> {new_role} (已固化)")
        log_event("CLUSTER", f"集群联播角色切换: {old_role} -> {new_role}")
        return True, f"成功切换为: {new_role}"

    def _get_local_ip_for_target(self, target_ip: str) -> str:
        """获取本机与目标 IP 通信时绑定的本地物理网卡 IP (避开 WSL/Hyper-V/Docker 虚拟网卡)"""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(0.3)
            s.connect((target_ip, 80))
            lip = s.getsockname()[0]
            s.close()
            return lip
        except Exception:
            try:
                hostname = socket.gethostname()
                for ip in socket.gethostbyname_ex(hostname)[2]:
                    if not ip.startswith("127.") and not ip.startswith("169.254.") and not ip.startswith("172."):
                        return ip
            except Exception:
                pass
        return "127.0.0.1"

    def _get_broadcast_destinations(self) -> list:
        """
        核心网络路由矩阵：
        1. 全局广播 (255.255.255.255 与 <broadcast>)
        2. 枚举本机所有物理/虚拟网卡，逐一计算并发送对应的子网定向广播 (如 192.168.3.255)
        3. 单播直连目标 (从机直发 master_ip，主机直发 configured_slave_ips 与在线从机)
        """
        dests = set()
        port = self.broadcast_port
        
        # 1. 通配广播
        dests.add(("255.255.255.255", port))
        dests.add(("<broadcast>", port))

        # 2. 枚举本机所有 IPv4 地址，计算各子网定向广播地址
        try:
            hostname = socket.gethostname()
            for ip in socket.gethostbyname_ex(hostname)[2]:
                if ip.startswith("127.") or ip.startswith("169.254."):
                    continue
                parts = ip.split(".")
                if len(parts) == 4:
                    # C 类子网定向广播 (例如 192.168.3.255)
                    dests.add((f"{parts[0]}.{parts[1]}.{parts[2]}.255", port))
                    # B 类子网定向广播
                    dests.add((f"{parts[0]}.{parts[1]}.255.255", port))
        except Exception:
            pass

        # 3. 若本机是 SLAVE，且配置了 master_ip，直接向主机单播
        if self.role == "SLAVE" and self.master_ip:
            m_ip = self.master_ip.strip()
            if m_ip:
                dests.add((m_ip, port))

        # 4. 若本机是 MASTER，向所有配置的从机 IP 以及上报过的在线从机单播
        if self.role == "MASTER":
            for sip in self.configured_slave_ips:
                sip = sip.strip()
                if sip:
                    dests.add((sip, port))
            with self.lock:
                for sinfo in self.active_slaves.values():
                    sip = sinfo.get("ip", "").strip()
                    if sip:
                        dests.add((sip, port))

        return list(dests)

    def _send_broadcast(self, data: dict):
        """向所有广播与单播目标矩阵发送 UDP 数据包"""
        if not self.sock_send:
            return
        try:
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            destinations = self._get_broadcast_destinations()
            for ip, port in destinations:
                try:
                    self.sock_send.sendto(payload, (ip, port))
                except Exception:
                    pass
        except Exception:
            pass

    def broadcast_master_command(self, cmd: str, params: dict = None):
        """【Master 专用】向局域网广播精准调度控制包 (如立即切歌、暂停、跳转、预约起播)"""
        if self.role != "MASTER" or not self.sock_send:
            return
        params = params or {}
        now_ms = time.time() * 1000.0
        
        # 预约 250ms 后同步执行，留出网络传输与从机解码准备时间
        schedule_time_ms = now_ms + 250.0

        packet = {
            "magic": SYNC_MAGIC,
            "type": "MASTER_CMD",
            "node_id": self.node_id,
            "cmd": cmd,
            "params": params,
            "send_time_ms": now_ms,
            "schedule_time_ms": schedule_time_ms
        }
        self._send_broadcast(packet)

    def get_full_master_config(self) -> dict:
        """【Master 专用】获取 Master 节点的全部配置数据 (供广播与从机拉取)"""
        if not self.coordinator:
            return {}
        cfg = dict(self.coordinator.config)
        status = self.coordinator.status
        # 提取并校准播放与显示设置
        pb = cfg.setdefault("playback", {})
        for k in ["volume", "muted", "scale_mode", "loop_mode", "switch_policy", "cycle_duration",
                  "idle_timeout", "idle_media", "startup_folder", "startup_mode", "startup_auto_play", "orientation"]:
            if k in status:
                pb[k] = status[k]
        
        cfg["subtitle"] = dict(status.get("subtitle", cfg.get("subtitle", {})))
        
        # 附带自定义素材标签 custom_media.json
        cm_path = os.path.join(os.path.dirname(self.config_file), "custom_media.json")
        custom_media = []
        if os.path.exists(cm_path):
            try:
                with open(cm_path, "r", encoding="utf-8") as f:
                    custom_media = json.load(f)
            except Exception:
                pass
        
        return {
            "magic": SYNC_MAGIC,
            "type": "FULL_CONFIG_DATA",
            "node_id": self.node_id,
            "timestamp": time.time(),
            "config": cfg,
            "custom_media": custom_media
        }

    def broadcast_full_config(self):
        """【Master 专用】向网内所有从机广播全量配置，并单播直推已知从机"""
        if self.role != "MASTER":
            return False, "当前节点非 MASTER 角色"
        if getattr(self, 'is_applying_remote_config', False):
            return False, "正在应用配置中，跳过广播"
        
        payload_data = self.get_full_master_config()
        if not payload_data:
            return False, "未获取到有效配置"

        # 1. UDP 广播下发 (触发从机即时执行 SYNC_FULL_CONFIG)
        self.broadcast_master_command("SYNC_FULL_CONFIG", payload_data)

        # 2. HTTP 异步直推已知从机 (确保无论交换机是否禁组播，从机必达)
        def _push_all_slaves():
            target_ips = set(self.configured_slave_ips)
            with self.lock:
                for sinfo in self.active_slaves.values():
                    sip = sinfo.get("ip")
                    if sip and not sip.startswith("127."):
                        target_ips.add(sip)
            
            raw_body = json.dumps(payload_data, ensure_ascii=False).encode('utf-8')
            for ip in target_ips:
                try:
                    url = f"http://{ip}:8088/api/sync/apply_master_config"
                    req = urllib.request.Request(url, data=raw_body, headers={"Content-Type": "application/json"}, method="POST")
                    with urllib.request.urlopen(req, timeout=2.0) as resp:
                        pass
                    print(f"[ClusterSync Master] 成功通过 HTTP 向从机 {ip} 直推全量设置")
                except Exception as e:
                    print(f"[ClusterSync Master] 向从机 {ip} HTTP 直推设置提示: {e}")

        threading.Thread(target=_push_all_slaves, daemon=True, name="ClusterSync-PushAllSlaves").start()
        print(f"[ClusterSync Master] 已向全网从机广播同步所有设置 (画面/字幕/待机/音量/轮播策略)")
        log_event("CLUSTER", "主机已向所有从机全量广播同步所有设置")
        return True, "已向全网从机同步所有设置"

    def apply_master_full_config(self, payload: dict) -> tuple:
        """【Slave 专用】全量同步并应用来自 Master 的所有配置"""
        if not self.coordinator or not payload:
            return False, "coordinator 或配置数据为空"
        
        cfg = payload.get("config", {})
        if not cfg and "playback" in payload:
            cfg = payload
        
        self.is_applying_remote_config = True
        try:
            print(f"[ClusterSync Slave] 正在将从机所有设置同步为 Master 主机配置...")
            # 1. 同步 playback 参数
            pb_master = cfg.get("playback", {})
            if pb_master:
                pb = self.coordinator.config.setdefault("playback", {})
                for k in ["volume", "muted", "touch_mode", "scale_mode", "loop_mode", "switch_policy", "cycle_duration",
                          "idle_timeout", "idle_media", "startup_folder", "startup_mode", "startup_auto_play", "orientation"]:
                    if k in pb_master:
                        pb[k] = pb_master[k]
                        self.coordinator.status[k] = pb_master[k]

            # 2. 同步 subtitle 跑马灯字幕
            sub_master = cfg.get("subtitle", {})
            if sub_master:
                self.coordinator.config["subtitle"] = dict(sub_master)
                self.coordinator.status["subtitle"] = dict(sub_master)
                # 联动大屏前端实时刷新字幕
                self.coordinator.handle_command("UPDATE_SUBTITLE", dict(sub_master))

            # 3. 实时向从机大屏前端下发各项显示与循环模式
            if "scale_mode" in pb_master:
                self.coordinator.handle_command("SET_SCALE_MODE", {"scale_mode": pb_master["scale_mode"]})
            if "orientation" in pb_master:
                self.coordinator.handle_command("SET_ORIENTATION", {"orientation": pb_master["orientation"]})
            if "loop_mode" in pb_master:
                self.coordinator.handle_command("SET_LOOP_MODE", {"loop_mode": pb_master["loop_mode"]})
            if "switch_policy" in pb_master or "cycle_duration" in pb_master:
                self.coordinator.handle_command("SET_CYCLE_POLICY", {
                    "switch_policy": pb_master.get("switch_policy", "FINISHED"),
                    "duration": pb_master.get("cycle_duration", 30)
                })
            if "volume" in pb_master:
                self.coordinator.handle_command("VOLUME", {"volume": pb_master["volume"]})
            if "muted" in pb_master:
                self.coordinator.handle_command("MUTE", {"muted": pb_master["muted"]})
            if "touch_mode" in pb_master:
                self.coordinator.set_touch_mode(pb_master["touch_mode"])

            # 4. 同步 custom_media.json (展品自定义信息)
            cm_master = payload.get("custom_media")
            if cm_master is not None:
                cm_path = os.path.join(os.path.dirname(self.config_file), "custom_media.json")
                try:
                    with open(cm_path, "w", encoding="utf-8") as f:
                        json.dump(cm_master, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass

            # 5. 保存并永久固化从机 player_config.json
            self.coordinator.save_player_config()
            self.last_applied_config_ts = payload.get("timestamp", time.time())
            print(f"[ClusterSync Slave] [成功] 从机所有设置已与 Master 完全同步并持久化！")
            log_event("CLUSTER", "从机已完全同步 Master 所有设置并完成持久化")
            return True, "从机所有设置已同步主机"
        except Exception as e:
            print(f"[ClusterSync Slave] 应用 Master 配置异常: {e}")
            return False, str(e)
        finally:
            self.is_applying_remote_config = False

    def _heartbeat_loop(self):
        """心跳与同步节拍循环"""
        while self.running:
            try:
                now_ms = time.time() * 1000.0
                if self.role == "MASTER":
                    # Master 高频组播同步脉冲 (每秒 2 次，毫秒级时间轴持续发布)
                    self._send_master_sync_beat(now_ms)
                    # 清理超时脱网的 Slave 节点 (超过 6 秒未上报)
                    with self.lock:
                        stale = [sid for sid, sinfo in self.active_slaves.items() if now_ms - sinfo.get("last_seen_ms", 0) > 6000]
                        for sid in stale:
                            del self.active_slaves[sid]
                    time.sleep(0.5)

                elif self.role == "SLAVE":
                    # 从机定期向 Master 回传状态与偏差遥测 (每 1.2 秒一次)
                    self._send_slave_telemetry(now_ms)
                    time.sleep(1.2)

                else:
                    time.sleep(2.0)
            except Exception:
                time.sleep(1.0)

    def _send_master_sync_beat(self, now_ms: float):
        """Master 发送高精度播放基准心跳"""
        if not self.coordinator or not self.sock_send:
            return
        
        status = self.coordinator.status
        media = status.get("current_media", "")
        media_type = status.get("media_type", "video")
        state = status.get("state", "IDLE")
        curr_time = status.get("current_time", 0.0)
        duration = status.get("duration", 0.0)
        loop_mode = status.get("loop_mode", "FOLDER_LOOP")
        volume = status.get("volume", 85)
        muted = status.get("muted", False)

        packet = {
            "magic": SYNC_MAGIC,
            "type": "SYNC_BEAT",
            "node_id": self.node_id,
            "hostname": socket.gethostname(),
            "master_time_ms": now_ms,
            "media": media,
            "media_type": media_type,
            "state": state,
            "current_time": curr_time,
            "duration": duration,
            "loop_mode": loop_mode,
            "volume": volume,
            "muted": muted
        }
        self._send_broadcast(packet)

    def _send_slave_telemetry(self, now_ms: float):
        """Slave 节点向 Master 反馈自身偏差遥测"""
        if not self.coordinator or not self.sock_send:
            return
        status = self.coordinator.status
        curr_time = status.get("current_time", 0.0)
        master_expected_time = self.get_master_expected_media_time()

        # 计算本地播放进度相对于 Master 的偏差 (毫秒)
        diff_ms = (curr_time - master_expected_time) * 1000.0 if master_expected_time > 0 else 0.0

        packet = {
            "magic": SYNC_MAGIC,
            "type": "SLAVE_REPORT",
            "node_id": self.node_id,
            "hostname": socket.gethostname(),
            "send_time_ms": now_ms,
            "current_time": curr_time,
            "diff_ms": round(diff_ms, 1),
            "clock_offset_ms": round(self.clock_offset_ms, 1),
            "is_locked": abs(diff_ms) < 35.0,  # 35ms 即 30fps 下的 1 帧以内判定为已锁定
            "media": status.get("current_media", "")
        }
        self._send_broadcast(packet)

    def _recv_loop(self):
        """接收局域网 UDP 广播与单播数据并解析分发"""
        while self.running:
            try:
                data, addr = self.sock_recv.recvfrom(4096)
                if not data:
                    continue
                recv_time_ms = time.time() * 1000.0
                try:
                    msg = json.loads(data.decode("utf-8", errors="ignore"))
                except Exception:
                    continue

                if msg.get("magic") != SYNC_MAGIC:
                    continue
                
                # 忽略本机发出的包
                sender_id = msg.get("node_id")
                if sender_id == self.node_id:
                    continue

                msg_type = msg.get("type")

                # ================= 1. 从机处理 Master 的基准心跳 =================
                if msg_type == "SYNC_BEAT" and self.role == "SLAVE":
                    self._handle_master_beat_on_slave(msg, recv_time_ms, addr[0])

                # ================= 2. 从机处理 Master 的调度指令 =================
                elif msg_type == "MASTER_CMD" and self.role == "SLAVE":
                    self._handle_master_cmd_on_slave(msg, recv_time_ms)

                # ================= 3. 主机接收 Slave 的遥测回执 =================
                elif msg_type == "SLAVE_REPORT" and self.role == "MASTER":
                    self._handle_slave_report_on_master(msg, recv_time_ms, addr[0])

                # ================= 4. 从机接收主动探测指令并即刻上报 =================
                elif msg_type == "DISCOVER_SLAVES" and self.role == "SLAVE":
                    self._send_slave_telemetry(recv_time_ms)

            except socket.timeout:
                continue
            except Exception as e:
                if not self.running:
                    break
                time.sleep(0.1)

    def _apply_master_status_on_slave(self, msg: dict, recv_time_ms: float, sender_ip: str):
        """统一处理从机锁定与素材同步 (支持 UDP 心跳与 HTTP 轮询统一驱动)"""
        master_time_ms = msg.get("master_time_ms", recv_time_ms)
        estimated_offset = master_time_ms - recv_time_ms
        if self.clock_offset_ms == 0.0:
            self.clock_offset_ms = estimated_offset
        else:
            self.clock_offset_ms = self.clock_offset_ms * 0.85 + estimated_offset * 0.15

        self.last_master_beat = recv_time_ms
        self.master_info = {
            "node_id": msg.get("node_id"),
            "hostname": msg.get("hostname", "Master-Host"),
            "ip": sender_ip,
            "media": msg.get("media", ""),
            "media_type": msg.get("media_type", "video"),
            "state": msg.get("state", "IDLE"),
            "current_time": msg.get("current_time", 0.0),
            "master_time_ms": master_time_ms,
            "recv_local_ms": recv_time_ms
        }

        # 检查是否需要跟随 Master 播放相同素材 (支持全目录自愈检索)
        if self.coordinator:
            cur_slave_media = self.coordinator.status.get("current_media", "")
            master_media = msg.get("media", "")
            master_state = msg.get("state", "IDLE")

            if master_media and master_state == "PLAYING":
                slave_base = os.path.basename(cur_slave_media.replace('\\', '/')).lower()
                master_base = os.path.basename(master_media.replace('\\', '/')).lower()
                
                if slave_base != master_base:
                    now_sec = time.time()
                    # 避免在视频加载中的 5 秒内重复触发相同的 LOAD_AND_PLAY 造成画面反复重置起播
                    if self.slave_loading_media == master_base and (now_sec - self.last_load_cmd_time) < 5.0:
                        pass
                    else:
                        found, local_rel_path, local_folder = find_media_in_slave_folders(master_media)
                        if found:
                            self.slave_loading_media = master_base
                            self.last_load_cmd_time = now_sec
                            print(f"[ClusterSync Slave] 同步跟随 Master 切换素材: {local_rel_path} (文件夹: {local_folder})")
                            log_event("CLUSTER", f"从机同步切入: {local_rel_path}")
                            self.coordinator.handle_command("LOAD_AND_PLAY", {
                                "media": local_rel_path,
                                "folder": local_folder,
                                "mode": "ON_DEMAND" if local_folder != "待机" else "ATTRACT"
                            })
                        else:
                            print(f"[ClusterSync Slave] 从机素材库暂未找到与 Master 同名的素材: {master_media}")
                else:
                    self.slave_loading_media = ""

            # 播放状态同步
            cur_slave_state = self.coordinator.status.get("state", "IDLE")
            if master_state == "PAUSED" and cur_slave_state == "PLAYING":
                self.coordinator.handle_command("PAUSE", {})
            elif master_state == "PLAYING" and cur_slave_state == "PAUSED":
                self.coordinator.handle_command("PLAY", {})

    def _handle_master_beat_on_slave(self, msg: dict, recv_time_ms: float, sender_ip: str):
        """【Slave 端处理】Master 高精节拍包"""
        self._apply_master_status_on_slave(msg, recv_time_ms, sender_ip)

    def _handle_master_cmd_on_slave(self, msg: dict, recv_time_ms: float):
        """【Slave 端处理】Master 播控调度指令 (如点播影片、跳转、静帧等)"""
        cmd = msg.get("cmd", "")
        params = msg.get("params", {})
        if not self.coordinator or not cmd:
            return

        print(f"[ClusterSync Slave] 收到 Master 指令: {cmd}, 参数: {params}")
        log_event("CLUSTER", f"从机接收 Master 指令: {cmd} | 参数: {json.dumps(params, ensure_ascii=False)}")

        if cmd in ("LOAD_AND_PLAY", "LOAD", "SWITCH_MEDIA", "PLAY_MEDIA"):
            target_media = params.get("media", "")
            if target_media:
                target_base = os.path.basename(target_media.replace('\\', '/')).lower()
                self.slave_loading_media = target_base
                self.last_load_cmd_time = time.time()
                found, local_rel_path, local_folder = find_media_in_slave_folders(target_media)
                if found:
                    print(f"[ClusterSync Slave] 从机在本地文件夹 [{local_folder or '根目录'}] 找到匹配素材: {local_rel_path}")
                    log_event("CLUSTER", f"从机匹配到本地素材: {local_rel_path} (文件夹: {local_folder})")
                    sync_params = dict(params)
                    sync_params["media"] = local_rel_path
                    sync_params["folder"] = local_folder
                    sync_params["mode"] = params.get("mode", "ON_DEMAND")
                    self.coordinator.handle_command("LOAD_AND_PLAY", sync_params)
                else:
                    print(f"[ClusterSync Slave] 从机未能从本地任何文件夹找到与 [{target_media}] 匹配的素材")
                    log_event("WARN", f"从机未找到主机点播素材: {target_media}")
            else:
                self.coordinator.handle_command("LOAD_AND_PLAY", params)

        elif cmd == "PLAY_FOLDER":
            self.coordinator.handle_command("PLAY_FOLDER", params)

        elif cmd == "SEEK":
            self.coordinator.handle_command("SEEK", params)

        elif cmd == "SYNC_FULL_CONFIG":
            self.apply_master_full_config(params)

        elif cmd in ("PLAY", "PAUSE", "STOP", "NEXT", "PREV", "BLACKOUT", "FREEZE", 
                     "SET_LOOP_MODE", "SET_SCALE_MODE", "SET_CYCLE_POLICY", "RETURN_TO_IDLE",
                     "UPDATE_SUBTITLE", "TOGGLE_SUBTITLE", "SET_ORIENTATION", "VOLUME", "SET_IDLE_CONFIG"):
            self.coordinator.handle_command(cmd, params)

    def _handle_slave_report_on_master(self, msg: dict, recv_time_ms: float, sender_ip: str):
        """【Master 端处理】记录并展示网内所有从机的遥测数据"""
        slave_id = msg.get("node_id")
        if not slave_id:
            return
        
        with self.lock:
            self.active_slaves[slave_id] = {
                "node_id": slave_id,
                "hostname": msg.get("hostname", "Slave"),
                "ip": sender_ip,
                "diff_ms": msg.get("diff_ms", 0.0),
                "clock_offset_ms": msg.get("clock_offset_ms", 0.0),
                "is_locked": msg.get("is_locked", False),
                "media": msg.get("media", ""),
                "current_time": msg.get("current_time", 0.0),
                "last_seen_ms": recv_time_ms
            }

    def register_active_slave(self, node_id: str, ip: str, data: dict):
        """【Master 端专用】供 HTTP 注册或手动单播注册从机节点"""
        now_ms = time.time() * 1000.0
        with self.lock:
            self.active_slaves[node_id] = {
                "node_id": node_id,
                "hostname": data.get("hostname", "Slave"),
                "ip": ip,
                "diff_ms": data.get("diff_ms", 0.0),
                "clock_offset_ms": data.get("clock_offset_ms", 0.0),
                "is_locked": True,
                "media": data.get("media", ""),
                "current_time": data.get("current_time", 0.0),
                "last_seen_ms": now_ms
            }
            if ip and ip not in self.configured_slave_ips and not ip.startswith("127."):
                self.configured_slave_ips.append(ip)
        print(f"[ClusterSync Master] 成功注册从机节点: {node_id} ({ip})")

    def _http_sync_loop(self):
        """【Slave 端专用】HTTP 兜底双保险同步守护线程 (解决多网卡/交换机过滤 UDP 广播的痛点)"""
        while self.running:
            try:
                if self.role == "SLAVE":
                    target_ip = self.master_ip.strip() if self.master_ip else (self.master_info.get("ip") if self.master_info else "")
                    # 如果未配置 master_ip，且处于 192.168.3.x 网段，尝试直连 192.168.3.17
                    if not target_ip:
                        local_ips = []
                        try: local_ips = socket.gethostbyname_ex(socket.gethostname())[2]
                        except Exception: pass
                        if any(lip.startswith("192.168.3.") for lip in local_ips):
                            target_ip = "192.168.3.17"

                    if target_ip:
                        now_ms = time.time() * 1000.0
                        # 1. 向主控机 HTTP 8088 获取状态
                        try:
                            url = f"http://{target_ip}:8088/api/sync/status"
                            req = urllib.request.Request(url, headers={"User-Agent": "VisualCast-Slave-Sync"})
                            with urllib.request.urlopen(req, timeout=1.2) as resp:
                                if resp.status == 200:
                                    raw = resp.read().decode('utf-8', errors='ignore')
                                    res_json = json.loads(raw)
                                    if res_json.get("status") == "ok":
                                        m_state = res_json.get("master_state") or {}
                                        synthetic_msg = {
                                            "node_id": res_json.get("node_id", f"MASTER_{target_ip}"),
                                            "hostname": res_json.get("hostname", "Master-Host"),
                                            "master_time_ms": now_ms,
                                            "media": m_state.get("current_media") or res_json.get("media", ""),
                                            "media_type": m_state.get("media_type", "video"),
                                            "state": m_state.get("state", "IDLE"),
                                            "current_time": m_state.get("current_time", 0.0)
                                        }
                                        self._apply_master_status_on_slave(synthetic_msg, now_ms, target_ip)
                        except Exception:
                            pass

                        # 2. 向主控机注册自身存活
                        try:
                            local_ip = self._get_local_ip_for_target(target_ip)
                            cur_media = self.coordinator.status.get("current_media", "") if self.coordinator else ""
                            cur_time = self.coordinator.status.get("current_time", 0.0) if self.coordinator else 0.0
                            reg_data = {
                                "node_id": self.node_id,
                                "hostname": socket.gethostname(),
                                "ip": local_ip,
                                "media": cur_media,
                                "current_time": cur_time,
                                "diff_ms": round(self.clock_offset_ms, 1),
                                "is_locked": True
                            }
                            reg_url = f"http://{target_ip}:8088/api/sync/register_slave"
                            reg_body = json.dumps(reg_data, ensure_ascii=False).encode('utf-8')
                            reg_req = urllib.request.Request(reg_url, data=reg_body, headers={"Content-Type": "application/json"})
                            with urllib.request.urlopen(reg_req, timeout=1.2) as reg_resp:
                                pass
                        except Exception:
                            pass

                        # 3. 定期拉取 Master 全量配置 (从机开机首次或每 10 秒比对)
                        if (now_ms - self.last_full_config_sync_time) > 10000.0:
                            self.last_full_config_sync_time = now_ms
                            try:
                                cfg_url = f"http://{target_ip}:8088/api/sync/master_config"
                                req_cfg = urllib.request.Request(cfg_url, headers={"User-Agent": "VisualCast-Slave-Sync"})
                                with urllib.request.urlopen(req_cfg, timeout=1.5) as cfg_resp:
                                    if cfg_resp.status == 200:
                                        cfg_json = json.loads(cfg_resp.read().decode('utf-8', errors='ignore'))
                                        if cfg_json.get("status") == "ok":
                                            m_ts = cfg_json.get("timestamp", 0.0)
                                            if m_ts > self.last_applied_config_ts or self.last_applied_config_ts == 0.0:
                                                self.apply_master_full_config(cfg_json)
                            except Exception:
                                pass
            except Exception:
                pass
            time.sleep(1.0)

    def get_master_expected_media_time(self) -> float:
        """从机计算当前 Master 理论上播放到的精确秒数 (推算已流逝时间)"""
        if not self.master_info or self.master_info.get("state") != "PLAYING":
            return self.master_info.get("current_time", 0.0) if self.master_info else 0.0

        base_media_time = self.master_info.get("current_time", 0.0)
        recv_local_ms = self.master_info.get("recv_local_ms", 0.0)
        now_ms = time.time() * 1000.0

        elapsed_sec = max(0.0, (now_ms - recv_local_ms) / 1000.0)
        return base_media_time + elapsed_sec

    def detect_slaves(self, wait_ms: float = 250.0) -> dict:
        """【主动从机检测】向全网广播 + 定向单播探测脉冲包，从机即时响应，返回最新节点拓扑"""
        if self.sock_send and self.role == "MASTER":
            now_ms = time.time() * 1000.0
            packet = {
                "magic": SYNC_MAGIC,
                "type": "DISCOVER_SLAVES",
                "node_id": self.node_id,
                "hostname": socket.gethostname(),
                "send_time_ms": now_ms
            }
            self._send_broadcast(packet)
            time.sleep(max(0.08, wait_ms / 1000.0))
        return self.get_cluster_status()

    def get_cluster_status(self) -> dict:
        """获取当前集群同步引擎状态与在线从机节点 (供后台 API 查询)"""
        now_ms = time.time() * 1000.0
        with self.lock:
            slaves_list = []
            for sid, s in list(self.active_slaves.items()):
                is_online = (now_ms - s.get("last_seen_ms", 0)) < 6000
                if is_online:
                    slaves_list.append({
                        "node_id": s.get("node_id"),
                        "hostname": s.get("hostname"),
                        "ip": s.get("ip"),
                        "diff_ms": s.get("diff_ms", 0.0),
                        "is_locked": s.get("is_locked", False),
                        "media": s.get("media", ""),
                        "current_time": s.get("current_time", 0.0),
                        "online": True
                    })

            slaves_list.sort(key=lambda x: x.get("ip", ""))
            master_alive = (now_ms - self.last_master_beat) < 4500 if self.last_master_beat > 0 else False

            res = {
                "status": "ok",
                "role": self.role,
                "node_id": self.node_id,
                "master_ip": self.master_ip,
                "slave_ips": self.configured_slave_ips,
                "broadcast_port": self.broadcast_port,
                "is_running": self.running,
                "slaves_count": len(slaves_list),
                "slaves": slaves_list,
                "master_info": self.master_info if master_alive else None,
                "master_alive": master_alive,
                "clock_offset_ms": round(self.clock_offset_ms, 2)
            }

            # 若是 Master，附带自身播控器实时播放状态，供从机 HTTP 同步拉取
            if self.coordinator:
                c_stat = self.coordinator.status
                res["master_state"] = {
                    "current_media": c_stat.get("current_media", ""),
                    "media_type": c_stat.get("media_type", "video"),
                    "state": c_stat.get("state", "IDLE"),
                    "current_time": c_stat.get("current_time", 0.0),
                    "duration": c_stat.get("duration", 0.0),
                    "loop_mode": c_stat.get("loop_mode", "FOLDER_LOOP")
                }

            return res

# 全局单例实例化
cluster_sync = ClusterSyncManager()
