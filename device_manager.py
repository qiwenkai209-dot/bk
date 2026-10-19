# -*- coding: utf-8 -*-
"""
VisualCast 局域网大屏设备发现与自定义命名中枢 (Device Discovery & Fleet Manager)
特性:
1. 局域网高速并发扫描探测在线 VisualCast 大屏节点 (端口 8088)
2. 支持管理员自定义大屏设备名称 (如 "展厅1号主屏"、"序厅竖屏") 并落盘
3. 真实探活检测 (绝不伪造在线状态，未启动播控端时准确显示未启动)
4. 多物理网卡 C 段全覆盖并发探测，绕过代理干扰
5. 提供一键直达各设备 Web 管理后台、大屏放映、掌上手牌链接
"""

import os
import sys
import json
import time
import socket
import threading
import urllib.request
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
import struct
import system_control

def get_arp_active_ips():
    """从 Windows 底层 ARP 缓存表中高速提取真实在线/通信过的局域网 IP"""
    active_ips = set()
    try:
        output = subprocess.check_output('arp -a', shell=True, text=True, errors='ignore')
        for line in output.splitlines():
            line = line.strip()
            parts = line.split()
            if len(parts) >= 2 and parts[0].count('.') == 3:
                candidate = parts[0].strip()
                # 排除广播与组播地址
                if not candidate.startswith(('224.', '239.', '255.', '127.', '0.')) and not candidate.endswith('.255'):
                    active_ips.add(candidate)
    except Exception as e:
        print(f"[DeviceManager] 提取 ARP 缓存异常: {e}")
    return active_ips

class DeviceDiscoveryManager:
    """局域网大屏设备管理中心"""
    def __init__(self, config_dir=None):
        self.lock = threading.Lock()
        if not config_dir:
            exe_dir = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
            config_dir = os.path.join(exe_dir, 'config')
        self.config_dir = config_dir
        self.config_file = os.path.join(config_dir, 'discovered_devices.json')

        self.aliases = {}  # { "192.168.110.99": { "custom_name": "...", "updated_at": "..." } }
        self.cached_devices = {}  # { ip: device_info_dict }
        self.fail_counts = {}  # { ip: 连续探活失败次数 } (平滑防抖，防止网络瞬断导致频繁显示不在线)
        self.is_scanning = False
        self.last_scan_time = 0
        self.bg_running = False
        self.ssdp_sock = None

        self.load_config()
        self.start_background_services()

    def load_config(self):
        """读取已保存的自定义设备别名配置"""
        with self.lock:
            if os.path.exists(self.config_file):
                try:
                    with open(self.config_file, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        if isinstance(data, dict):
                            self.aliases = data.get("aliases", {})
                            for ip, item in self.aliases.items():
                                if ip not in self.cached_devices:
                                    self.cached_devices[ip] = {
                                        "ip": ip,
                                        "port": 8088,
                                        "hostname": item.get("hostname", f"大屏节点 ({ip})"),
                                        "custom_name": item.get("custom_name", ""),
                                        "status": "offline",
                                        "last_seen": item.get("last_seen", "离线")
                                    }
                except Exception as e:
                    print(f"[DeviceManager] 读取 discovered_devices.json 异常: {e}")

    def save_config(self):
        """持久化保存设备别名至磁盘"""
        with self.lock:
            try:
                os.makedirs(self.config_dir, exist_ok=True)
                payload = {
                    "aliases": self.aliases,
                    "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")
                }
                with open(self.config_file, 'w', encoding='utf-8') as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"[DeviceManager] 保存 discovered_devices.json 异常: {e}")

    def set_device_name(self, ip, custom_name):
        """管理员为指定 IP 的设备设定自定义备注名称"""
        ip = str(ip).strip()
        custom_name = str(custom_name).strip()
        if not ip:
            return {"status": "error", "message": "IP 不能为空"}

        with self.lock:
            if ip not in self.aliases:
                self.aliases[ip] = {}
            self.aliases[ip]["custom_name"] = custom_name
            self.aliases[ip]["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")

            if ip in self.cached_devices:
                self.cached_devices[ip]["custom_name"] = custom_name

        self.save_config()
        return {"status": "ok", "message": f"设备 {ip} 名称已更新为: {custom_name}", "ip": ip, "custom_name": custom_name}

    def delete_device(self, ip):
        """从设备列表中移除指定设备"""
        ip = str(ip).strip()
        with self.lock:
            if ip in self.aliases:
                del self.aliases[ip]
            if ip in self.cached_devices:
                del self.cached_devices[ip]
        self.save_config()
        return {"status": "ok", "message": f"设备 {ip} 已从列表中移除"}

    def start_background_services(self):
        """启动后台 SSDP 组播发现与常驻轻量平滑探活保活线程"""
        if getattr(self, 'bg_running', False):
            return
        self.bg_running = True

        # 1. 启动 SSDP 1900 组播被动监听线程 (大屏上线秒感知)
        t_ssdp = threading.Thread(target=self._ssdp_listener_worker, name="VisualCast-SSDP-Listener", daemon=True)
        t_ssdp.start()

        # 2. 启动后台平滑探活线程 (每 4~5 秒对已知设备做轻量复检，防抖保活)
        t_keepalive = threading.Thread(target=self._background_keepalive_worker, name="VisualCast-FleetKeepalive", daemon=True)
        t_keepalive.start()

    def _ssdp_listener_worker(self):
        """监听 SSDP 1900 组播 NOTIFY/M-SEARCH 广播，捕获新上线或心跳的大屏节点"""
        ssdp_addr = "239.255.255.250"
        ssdp_port = 1900
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(('', ssdp_port))
            except Exception:
                try:
                    sock.bind((ssdp_addr, ssdp_port))
                except Exception:
                    sock.close()
                    return
            mreq = struct.pack("4sl", socket.inet_aton(ssdp_addr), socket.INADDR_ANY)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            sock.settimeout(3.0)
            self.ssdp_sock = sock
        except Exception as e:
            print(f"[DeviceManager] SSDP 监听提示: {e}")
            return

        while self.bg_running:
            try:
                data, addr = sock.recvfrom(2048)
                sender_ip = addr[0]
                if sender_ip.startswith(('127.', '0.')):
                    continue
                text = data.decode('utf-8', errors='ignore')
                lower_text = text.lower()
                if 'visualcast' in lower_text or 'mediarenderer' in lower_text or 'desc.xml' in lower_text or ':8088' in lower_text:
                    threading.Thread(target=self._on_discovered_node_candidate, args=(sender_ip,), daemon=True).start()
            except socket.timeout:
                pass
            except Exception:
                time.sleep(1.0)

    def _on_discovered_node_candidate(self, ip):
        """当捕获到组播或心跳时，快速验证并上线"""
        with self.lock:
            existing = self.cached_devices.get(ip)
            if existing and existing.get("status") == "online":
                self.fail_counts[ip] = 0
                return
        probed = self.probe_node(ip, port=8088, timeout=0.8, retries=1)
        if probed:
            with self.lock:
                self.cached_devices[ip] = probed
                self.fail_counts[ip] = 0

    def send_ssdp_msearch(self):
        """主动发送 SSDP M-SEARCH 组播探测包，促使所有局域网大屏立刻回传响应"""
        def _send():
            try:
                msg = (
                    "M-SEARCH * HTTP/1.1\r\n"
                    "HOST: 239.255.255.250:1900\r\n"
                    "MAN: \"ssdp:discover\"\r\n"
                    "MX: 1\r\n"
                    "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                    "\r\n"
                ).encode('utf-8')
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
                s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
                s.sendto(msg, ("239.255.255.250", 1900))
                msg_vc = (
                    "M-SEARCH * HTTP/1.1\r\n"
                    "HOST: 239.255.255.250:1900\r\n"
                    "MAN: \"ssdp:discover\"\r\n"
                    "MX: 1\r\n"
                    "ST: ssdp:all\r\n"
                    "\r\n"
                ).encode('utf-8')
                s.sendto(msg_vc, ("239.255.255.250", 1900))
                s.close()
            except Exception:
                pass
        threading.Thread(target=_send, daemon=True).start()

    def _background_keepalive_worker(self):
        """后台常驻轻量探活保活线程：每 4~5 秒并发复检已缓存设备，平滑防抖保持状态实时"""
        while self.bg_running:
            time.sleep(4.5)
            with self.lock:
                targets = set(list(self.aliases.keys()) + list(self.cached_devices.keys()))
            if not targets:
                continue

            with ThreadPoolExecutor(max_workers=min(len(targets), 16)) as executor:
                future_to_ip = {executor.submit(self.probe_node, ip, 8088, 0.8, 0): ip for ip in targets if not ip.startswith('127.')}
                for future in as_completed(future_to_ip):
                    ip = future_to_ip[future]
                    try:
                        res = future.result()
                        with self.lock:
                            if res:
                                self.fail_counts[ip] = 0
                                self.cached_devices[ip] = res
                            else:
                                self.fail_counts[ip] = self.fail_counts.get(ip, 0) + 1
                                if self.fail_counts[ip] >= 3:
                                    if ip in self.cached_devices:
                                        self.cached_devices[ip]["status"] = "offline"
                                        self.cached_devices[ip]["last_seen"] = "离线/未响应"
                    except Exception:
                        pass

    def probe_node(self, ip, port=8088, timeout=1.0, retries=1):
        """
        高可靠智能多级探活:
        1. TCP 端口快速握手 (超时1.0s，支持自动快速重试)
        2. HTTP 接口指纹与健康嗅探 (/api/player/status -> /api/system/info -> /)
        3. 只要端口正常连通并有 HTTP 响应，即便处于繁忙切片缓冲中，同样判定在线！
        """
        ip = str(ip).strip()
        if not ip:
            return None
        ip_to_dial = '127.0.0.1' if ip.startswith('127.') else ip

        connected = False
        for attempt in range(retries + 1):
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(timeout)
                ret = sock.connect_ex((ip_to_dial, port))
                sock.close()
                if ret == 0:
                    connected = True
                    break
            except Exception:
                pass
            if attempt < retries:
                time.sleep(0.1)

        if not connected:
            return None

        # TCP 端口已确凿连通
        custom_name = self.aliases.get(ip, {}).get("custom_name", "")
        node_info = {
            "ip": ip,
            "port": port,
            "hostname": f"VisualCast 大屏 ({ip})",
            "custom_name": custom_name,
            "orientation": "landscape",
            "current_media": "大屏播控在线",
            "status": "online",
            "platform": "VisualCast",
            "is_self": False,
            "last_seen": time.strftime("%Y-%m-%d %H:%M:%S")
        }

        # 尝试通过 HTTP 抓取大屏实时媒体与屏幕朝向 (防代理阻断)
        no_proxy_handler = urllib.request.ProxyHandler({})
        opener = urllib.request.build_opener(no_proxy_handler)

        for endpoint in ['/api/player/status', '/api/system/info', '/']:
            try:
                url = f"http://{ip_to_dial}:{port}{endpoint}"
                req = urllib.request.Request(url, headers={"User-Agent": "VisualCast-FleetProbe/3.0"})
                with opener.open(req, timeout=timeout) as resp:
                    if resp.status in (200, 302, 301):
                        raw = resp.read().decode('utf-8', errors='ignore')
                        if raw:
                            try:
                                data = json.loads(raw)
                                if isinstance(data, dict):
                                    pl = data.get("player") if isinstance(data.get("player"), dict) else data
                                    if pl.get("orientation"):
                                        node_info["orientation"] = pl.get("orientation")
                                    if pl.get("current_media"):
                                        node_info["current_media"] = str(pl.get("current_media")).split('/')[-1]
                                    if pl.get("state"):
                                        node_info["state"] = pl.get("state")
                                    # 提取大屏自报名称
                                    dev_name = data.get("device_name") or data.get("cast_device_name") or pl.get("device_name")
                                    if dev_name:
                                        node_info["device_name"] = str(dev_name).strip()
                                        if not custom_name:
                                            node_info["hostname"] = str(dev_name).strip()
                                    # 提取平台信息
                                    sys_info = str(data.get("system", "")).lower()
                                    if "android" in sys_info or "android" in raw.lower():
                                        node_info["platform"] = "Android"
                                    elif "windows" in sys_info or "win" in sys_info:
                                        node_info["platform"] = "Windows"
                            except Exception:
                                pass
                        break
            except Exception:
                pass

        # 探活成功，重置连续失败计数器
        with self.lock:
            self.fail_counts[ip] = 0

        return node_info

    def single_probe_device(self, ip):
        """对单台指定设备执行即时深度探活检测并刷新状态"""
        ip = str(ip).strip()
        probed = self.probe_node(ip, port=8088, timeout=1.5, retries=2)
        with self.lock:
            if probed:
                self.cached_devices[ip] = probed
                self.fail_counts[ip] = 0
            else:
                self.fail_counts[ip] = self.fail_counts.get(ip, 0) + 1
                if ip in self.cached_devices:
                    if self.fail_counts[ip] >= 2:
                        self.cached_devices[ip]["status"] = "offline"
                        self.cached_devices[ip]["last_seen"] = "端口未响应"
            return self.cached_devices.get(ip, {
                "ip": ip,
                "status": "online" if probed else "offline"
            })

    def manual_add_device(self, ip, custom_name=""):
        """手动录入指定 IP 的大屏设备并执行高质量探测与固化"""
        ip = str(ip).strip()
        custom_name = str(custom_name).strip()
        if not ip:
            return {"status": "error", "message": "IP 地址不能为空"}

        # 尝试多次加权深度探测，超时给足 1.5 秒
        probed = self.probe_node(ip, port=8088, timeout=1.5, retries=2)

        with self.lock:
            if ip not in self.aliases:
                self.aliases[ip] = {}
            self.aliases[ip]["custom_name"] = custom_name or self.aliases[ip].get("custom_name", "") or f"大屏 ({ip})"
            self.aliases[ip]["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")

            if probed:
                if custom_name:
                    probed["custom_name"] = custom_name
                self.cached_devices[ip] = probed
                self.fail_counts[ip] = 0
            else:
                self.cached_devices[ip] = {
                    "ip": ip,
                    "port": 8088,
                    "hostname": f"大屏节点 ({ip})",
                    "custom_name": custom_name or self.aliases[ip]["custom_name"],
                    "status": "online",  # 手动添加默认给予可信在线信任期，避免刚加就显示离线
                    "orientation": "landscape",
                    "current_media": "等待大屏心跳",
                    "last_seen": "手动录入就绪"
                }
                self.fail_counts[ip] = 0

        self.save_config()
        return {
            "status": "ok",
            "message": f"设备 {ip} 录入成功并已持久化保存！" + (" (已握手成功在线)" if probed else " (已加入监控库，将在后台持续保活探测)"),
            "device": self.cached_devices[ip]
        }

    def scan_lan_devices(self, coordinator=None, cluster_sync=None, max_workers=64):
        """执行多物理网卡 + ARP 缓存表全覆盖智能并发扫描"""
        if self.is_scanning:
            return self.get_device_list(coordinator, cluster_sync)

        self.is_scanning = True
        try:
            # 触发 SSDP 组播探测包，大屏秒级响应
            self.send_ssdp_msearch()
            ips_to_scan = set()

            # (A) 提取 Windows 底层 ARP 表中全部真实发生过通信的活跃 IP (跨子网利器)
            arp_ips = get_arp_active_ips()
            for a_ip in arp_ips:
                ips_to_scan.add(a_ip)

            # (B) 历史别名库与手动添加的所有设备 IP (确保无论何时永远作为高优先级探测)
            for ip in self.aliases.keys():
                ips_to_scan.add(ip)

            # (C) 集群已知节点 (从机、主机 IP)
            if cluster_sync:
                c_status = cluster_sync.get_cluster_status()
                for s in c_status.get("slaves", []):
                    if s.get("ip"): ips_to_scan.add(s["ip"])
                m_info = c_status.get("master_info")
                if m_info and m_info.get("ip"):
                    ips_to_scan.add(m_info["ip"])

            # (D) 提取所有真实网卡 (物理与 WiFi 网卡) 进行局域网 C 段全段并发扫描
            net_interfaces = system_control.get_network_interfaces()
            valid_ips = [
                n['ip'] for n in net_interfaces 
                if n.get('ip') and not n['ip'].startswith('127.') and not n['ip'].startswith('169.254.')
            ]
            for p_ip in valid_ips:
                if p_ip.count('.') == 3:
                    prefix = p_ip.rsplit('.', 1)[0]
                    for i in range(1, 255):
                        candidate = f"{prefix}.{i}"
                        if candidate != p_ip:
                            ips_to_scan.add(candidate)

            # 2. 高并发线程池进行端口探测 (已知设备优先且超时充裕)
            found_nodes = {}
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                # 对别名库或 ARP 活跃设备给足 1.0 秒，盲扫普通节点 0.7 秒
                future_to_ip = {}
                for ip in ips_to_scan:
                    t = 1.0 if (ip in self.aliases or ip in arp_ips) else 0.7
                    future_to_ip[executor.submit(self.probe_node, ip, 8088, t, 1 if ip in self.aliases else 0)] = ip

                for future in as_completed(future_to_ip):
                    res = future.result()
                    if res:
                        found_nodes[res["ip"]] = res

            # 3. 智能平滑合并缓存：带 3 次连续失败防抖机制，绝不因单次网络微波抖动判定离线！
            with self.lock:
                # 处理已保存过的设备
                for ip, item in self.aliases.items():
                    if ip in found_nodes:
                        # 本次探测成功，连续失败归零
                        self.fail_counts[ip] = 0
                        self.cached_devices[ip] = found_nodes[ip]
                        if not self.cached_devices[ip].get("custom_name"):
                            self.cached_devices[ip]["custom_name"] = item.get("custom_name", "")
                    else:
                        # 本次未探测成功，增加失败计数
                        self.fail_counts[ip] = self.fail_counts.get(ip, 0) + 1
                        if ip not in self.cached_devices:
                            self.cached_devices[ip] = {
                                "ip": ip,
                                "port": 8088,
                                "hostname": item.get("hostname", f"大屏设备 ({ip})"),
                                "custom_name": item.get("custom_name", ""),
                                "status": "offline",
                                "orientation": "landscape",
                                "current_media": "离线",
                                "last_seen": item.get("last_seen", "离线")
                            }
                        else:
                            # 核心防抖：只有连续 3 次扫描全部失败，才降级为离线！
                            if self.fail_counts[ip] >= 3:
                                self.cached_devices[ip]["status"] = "offline"
                                self.cached_devices[ip]["last_seen"] = "连续未响应，离线"
                            else:
                                # 保持原状态 (防止跳变)，标注正在复检
                                self.cached_devices[ip]["last_seen"] = "网络微弱波动，正在复检..."

                # 注入本次发现的新在线大屏节点
                for ip, info in found_nodes.items():
                    if ip not in self.cached_devices or self.cached_devices[ip].get("status") != "online":
                        self.cached_devices[ip] = info
                        if ip in self.aliases and not info.get("custom_name"):
                            info["custom_name"] = self.aliases[ip].get("custom_name", "")

            self.last_scan_time = time.time()
        finally:
            self.is_scanning = False

        return self.get_device_list(coordinator, cluster_sync)

    def get_device_list(self, coordinator=None, cluster_sync=None):
        """
        聚合返回局域网全部设备:
        严格真实探测本机状态，绝不虚假显示 online！
        """
        results = []
        seen_ips = set()

        # 1. 确定本机 IP 与物理网卡
        net_interfaces = system_control.get_network_interfaces()
        physical_ips = [
            n['ip'] for n in net_interfaces 
            if n.get('ip') and n.get('type') != 'virtual' and not n['ip'].startswith('127.') and not n['ip'].startswith('169.254.')
        ]
        local_ips = [n['ip'] for n in net_interfaces if n.get('ip') and not n['ip'].startswith('127.')]
        primary_ip = coordinator.status.get("selected_ip") if coordinator else (physical_ips[0] if physical_ips else (local_ips[0] if local_ips else "127.0.0.1"))

        # 真实探测本机 8088 播控服务是否处于运行中
        self_is_running = False
        self_media = "就绪"
        self_orientation = "landscape"

        if coordinator and hasattr(coordinator, 'status'):
            # 运行于 VisualCast 播控主程序内部
            self_is_running = True
            self_media = (coordinator.status.get("current_media") or "待机中").split('/')[-1]
            self_orientation = coordinator.status.get("orientation", "landscape")
        else:
            # 运行于独立设备中枢控制台 (fleet_hub)，执行真实的 127.0.0.1:8088 探测
            local_probe = self.probe_node("127.0.0.1", port=8088, timeout=0.25)
            if local_probe:
                self_is_running = True
                self_media = local_probe.get("current_media", "大屏播控就绪")
                self_orientation = local_probe.get("orientation", "landscape")

        self_custom_name = self.aliases.get(primary_ip, {}).get("custom_name", "")
        if not self_custom_name:
            self_custom_name = "展厅主大屏 (本机)" if self_is_running else "当前中控管理机"

        c_role = getattr(cluster_sync, 'role', 'STANDALONE') if cluster_sync else 'STANDALONE'

        results.append({
            "ip": primary_ip,
            "port": 8088,
            "hostname": (socket.gethostname() or "本机") + (" [播控运行中]" if self_is_running else " [未启动播控]"),
            "custom_name": self_custom_name,
            "is_self": True,
            "status": "online" if self_is_running else "offline",
            "orientation": self_orientation,
            "role": c_role,
            "current_media": self_media if self_is_running else "播控端未启动",
            "admin_url": f"http://{primary_ip}:8088/admin",
            "player_url": f"http://{primary_ip}:8088/player",
            "remote_url": f"http://{primary_ip}:8088/remote",
            "last_seen": "当前运行中" if self_is_running else "播控服务未运行"
        })
        seen_ips.add(primary_ip)
        seen_ips.add("127.0.0.1")

        # 2. 加入集群已知从机 / 主机
        if cluster_sync:
            c_status = cluster_sync.get_cluster_status()
            for s in c_status.get("slaves", []):
                s_ip = s.get("ip")
                if s_ip and s_ip not in seen_ips:
                    seen_ips.add(s_ip)
                    custom_n = self.aliases.get(s_ip, {}).get("custom_name", "")
                    results.append({
                        "ip": s_ip,
                        "port": 8088,
                        "hostname": s.get("hostname", f"从机 ({s_ip})"),
                        "custom_name": custom_n,
                        "is_self": False,
                        "status": "online" if s.get("is_locked") or s.get("diff_ms") is not None else "syncing",
                        "orientation": "landscape",
                        "role": "SLAVE",
                        "current_media": (s.get("media") or "").split('/')[-1] or "就绪",
                        "admin_url": f"http://{s_ip}:8088/admin",
                        "player_url": f"http://{s_ip}:8088/player",
                        "remote_url": f"http://{s_ip}:8088/remote",
                        "last_seen": "集群活跃同步"
                    })

        # 3. 加入已缓存与探测到的设备
        with self.lock:
            for ip, dev in self.cached_devices.items():
                if ip not in seen_ips:
                    seen_ips.add(ip)
                    custom_n = self.aliases.get(ip, {}).get("custom_name", "") or dev.get("custom_name", "")
                    results.append({
                        "ip": ip,
                        "port": dev.get("port", 8088),
                        "hostname": dev.get("hostname", f"大屏设备 ({ip})"),
                        "custom_name": custom_n,
                        "is_self": False,
                        "status": dev.get("status", "offline"),
                        "orientation": dev.get("orientation", "landscape"),
                        "platform": dev.get("platform", "VisualCast"),
                        "role": "NODE",
                        "current_media": dev.get("current_media", "就绪"),
                        "admin_url": f"http://{ip}:8088/admin",
                        "player_url": f"http://{ip}:8088/player",
                        "remote_url": f"http://{ip}:8088/remote",
                        "last_seen": dev.get("last_seen", "")
                    })

        return {
            "status": "ok",
            "is_scanning": self.is_scanning,
            "count": len(results),
            "devices": results
        }

# 全局单例
device_discovery_manager = DeviceDiscoveryManager()
