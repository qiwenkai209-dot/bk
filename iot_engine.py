# -*- coding: utf-8 -*-
"""
VisualCast 展馆环境设备中控引擎
- 支持 TCP Client (长/短连 Hex 或 ASCII)
- 支持 UDP 单播/广播
- 支持 HTTP GET / POST
- 支持异步多线程流水线宏序列 (一键开馆 / 一键闭馆 / 自定义场景)
- 线程安全的状态机与执行进度监控
"""

import os
import json
import time
import socket
import urllib.request
import urllib.error
import threading

import sys

if getattr(sys, 'frozen', False):
    EXE_DIR = os.path.dirname(sys.executable)
    BUNDLE_DIR = getattr(sys, '_MEIPASS', EXE_DIR)
else:
    EXE_DIR = os.path.dirname(os.path.abspath(__file__))
    BUNDLE_DIR = EXE_DIR

CONFIG_DIR = os.path.join(EXE_DIR, 'config')
CONFIG_PATH = os.path.join(CONFIG_DIR, 'iot_config.json')
BUNDLE_CONFIG_PATH = os.path.join(BUNDLE_DIR, 'config', 'iot_config.json')

class IoTEngine:
    def __init__(self, config_path=CONFIG_PATH):
        self.config_path = config_path
        self.lock = threading.Lock()
        self.current_macro_status = {
            "is_running": False,
            "macro_id": "",
            "macro_name": "",
            "current_step": 0,
            "total_steps": 0,
            "current_step_title": "",
            "logs": []
        }
        self.forwarder_stats = {}  # {fwd_id: {"count": 0, "last_time": ""}}
        self.serial_listeners = {} # {port: thread}
        self.custom_net_listeners = {} # {(protocol, port): thread}
        self.load_config()
        try:
            self.check_and_start_all_listeners()
        except Exception:
            pass

    def load_config(self):
        """加载环境设备、宏序列与自定义中转转发配置"""
        with self.lock:
            if not os.path.exists(self.config_path):
                if os.path.exists(BUNDLE_CONFIG_PATH):
                    try:
                        import shutil
                        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
                        shutil.copy(BUNDLE_CONFIG_PATH, self.config_path)
                    except Exception:
                        pass
            if not os.path.exists(self.config_path):
                self.config = {"devices": [], "macros": {}, "custom_scenarios": [], "forwarders": []}
                return self.config
            try:
                with open(self.config_path, 'r', encoding='utf-8') as f:
                    self.config = json.load(f)
            except Exception as e:
                print(f"[IoTEngine] 加载配置失败: {e}")
                self.config = {"devices": [], "macros": {}, "custom_scenarios": [], "forwarders": []}
            if "forwarders" not in self.config:
                self.config["forwarders"] = []
            if "timeline" not in self.config:
                self.config["timeline"] = self.get_default_timeline()
        return self.config

    def get_default_timeline(self):
        """返回默认的多媒体与物联设备同步时间轴结构"""
        return {
            "master": {
                "type": "video",
                "name": "展厅默认开场片.mp4",
                "url": "",
                "duration": 60
            },
            "tracks": [
                {
                    "id": "track_1",
                    "name": "展厅顶光与氛围照明轨",
                    "nodes": [
                        {
                            "id": "node_1",
                            "time": 5.0,
                            "device_id": "ambient_light_01",
                            "action": "on",
                            "custom_cmd": "",
                            "label": "顶光开启"
                        },
                        {
                            "id": "node_2",
                            "time": 50.0,
                            "device_id": "ambient_light_01",
                            "action": "off",
                            "custom_cmd": "",
                            "label": "顶光关闭"
                        }
                    ]
                },
                {
                    "id": "track_2",
                    "name": "投影与机械升降控制轨",
                    "nodes": [
                        {
                            "id": "node_3",
                            "time": 2.0,
                            "device_id": "laser_projector_01",
                            "action": "on",
                            "custom_cmd": "",
                            "label": "投影机开机"
                        },
                        {
                            "id": "node_4",
                            "time": 10.0,
                            "device_id": "motor_curtain_01",
                            "action": "on",
                            "custom_cmd": "",
                            "label": "幕帘下降"
                        }
                    ]
                }
            ]
        }

    def get_timeline(self):
        """获取多媒体物联时间轴配置"""
        cfg = self.load_config()
        tl = cfg.get("timeline")
        if not tl or not isinstance(tl, dict):
            tl = self.get_default_timeline()
            cfg["timeline"] = tl
            self.save_config(cfg)
        return tl

    def save_timeline(self, timeline_data):
        """保存多媒体物联时间轴配置"""
        cfg = self.load_config()
        cfg["timeline"] = timeline_data
        self.save_config(cfg)
        return True

    def save_config(self, new_config=None):
        """保存配置到文件"""
        with self.lock:
            if new_config:
                self.config = new_config
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            with open(self.config_path, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, ensure_ascii=False, indent=2)
        return True

    def get_device(self, device_id):
        for d in self.config.get("devices", []):
            if d.get("id") == device_id:
                return d
        return None

    def send_device_command(self, device_id, cmd_type="on", custom_cmd=None):
        """
        向指定设备发送控制指令
        cmd_type: 'on' / 'off' / 'custom'
        """
        device = self.get_device(device_id)
        if not device and not custom_cmd:
            return {"status": "error", "message": f"未找到设备 {device_id}"}

        dev_type = device.get("type", "TCP").upper() if device else "TCP"
        host = device.get("host", "127.0.0.1") if device else "127.0.0.1"
        port = int(device.get("port", 4001)) if device else 4001
        protocol = device.get("protocol", "hex").lower() if device else "hex"

        if custom_cmd:
            raw_cmd = custom_cmd
        else:
            cmd_key = str(cmd_type).strip().lower()
            cmds = device.get("commands") if isinstance(device.get("commands"), dict) else {}
            # 强化多格式兼容提取：优先 commands[cmd_type]，兜底 on_cmd/off_cmd 或扁平键名
            raw_cmd = (
                cmds.get(cmd_key)
                or cmds.get("on" if cmd_key in ("on", "open", "start", "1") else "off")
                or device.get(f"{cmd_key}_cmd")
                or device.get("on_cmd" if cmd_key == "on" else "off_cmd")
                or device.get(cmd_key, "")
            )

        if not raw_cmd:
            return {"status": "error", "message": f"设备 [{device.get('name', device_id)}] 的 [{cmd_type}] 指令内容为空，请在设备设置中配置"}

        # 根据协议准备二进制或文本数据 (WOL 唤醒魔术包单独构造)
        payload = b''
        if dev_type != "WOL":
            if protocol == "hex":
                try:
                    # 兼容 "A5 5A 08" 或 "A55A08" 格式
                    cleaned = raw_cmd.replace(" ", "").replace("0x", "").replace(",", "")
                    payload = bytes.fromhex(cleaned)
                except Exception as e:
                    return {"status": "error", "message": f"十六进制指令格式解析错误: {e}"}
            else:
                # 自动支持转义符如 \r \n \t (中控机、投影机、继电器控制协议强依赖)
                unescaped = raw_cmd.replace('\\r', '\r').replace('\\n', '\n').replace('\\t', '\t')
                payload = unescaped.encode('utf-8')

        # 分发网络发送
        try:
            if dev_type == "TCP":
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(2.0)  # 严格2秒超时，防网络阻塞
                s.connect((host, port))
                s.sendall(payload)
                s.close()
                return {"status": "ok", "message": f"TCP 指令发送成功 -> {host}:{port}"}

            elif dev_type == "UDP":
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.settimeout(2.0)
                if host.endswith('.255') or host == '255.255.255.255':
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.sendto(payload, (host, port))
                s.close()
                return {"status": "ok", "message": f"UDP 数据包已发送 -> {host}:{port}"}

            elif dev_type == "HTTP":
                url = raw_cmd if raw_cmd.startswith("http") else f"http://{host}:{port}{raw_cmd}"
                req = urllib.request.Request(url, headers={'User-Agent': 'VisualCast-IoT/1.0'})
                with urllib.request.urlopen(req, timeout=3.0) as resp:
                    resp_data = resp.read().decode('utf-8', errors='ignore')
                return {"status": "ok", "message": f"HTTP 请求成功: {resp.status}", "response": resp_data[:100]}

            elif dev_type == "WOL":
                # 网络唤醒：直接输入 MAC 地址发送 UDP 广播 Magic Packet
                mac_str = device.get("mac") or device.get("mac_address") or host or raw_cmd
                clean_mac = str(mac_str).replace(":", "").replace("-", "").replace(".", "").replace(" ", "").strip()
                if len(clean_mac) != 12:
                    return {"status": "error", "message": f"无效的 MAC 地址 [{mac_str}]，必须为 12 位十六进制字符 (如 00:11:22:33:44:55)"}
                try:
                    mac_bytes = bytes.fromhex(clean_mac)
                except Exception as ex:
                    return {"status": "error", "message": f"MAC 地址解析异常: {ex}"}

                magic_packet = b'\xFF' * 6 + mac_bytes * 16
                b_ip = device.get("broadcast_ip") or "255.255.255.255"
                b_port = int(device.get("port") or 9)

                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.sendto(magic_packet, (b_ip, b_port))
                s.close()
                return {"status": "ok", "message": f"网络唤醒魔术包 (WOL) 已广播至 {b_ip}:{b_port} -> MAC: {mac_str}"}

            elif dev_type == "SERIAL":
                # 串口通信 (RS232 / RS485)：配置 COM 口与波特率
                serial_port = device.get("serial_port") or host or "COM1"
                baudrate = int(device.get("baudrate") or port or 9600)
                try:
                    import serial
                    with serial.Serial(port=serial_port, baudrate=baudrate, timeout=1.5) as ser:
                        ser.write(payload)
                        ser.flush()
                    return {"status": "ok", "message": f"串口指令发送成功 -> {serial_port} @ {baudrate}bps"}
                except Exception as sex:
                    return {"status": "error", "message": f"串口 [{serial_port}] 通信异常: {sex}"}

            else:
                return {"status": "error", "message": f"不支持的协议类型: {dev_type}"}

        except Exception as e:
            # 现场容错：记录日志，不阻断
            return {"status": "warning", "message": f"设备通讯异常: {e}"}

    def get_all_macros(self):
        """获取所有一键控制场景宏列表 (支持动态无限添加)"""
        with self.lock:
            res = []
            macros_dict = self.config.get("macros", {})
            for m_id, m_data in macros_dict.items():
                item = dict(m_data)
                item["id"] = m_id
                res.append(item)
            for sc in self.config.get("custom_scenarios", []):
                sc_id = sc.get("id")
                if sc_id and not any(r["id"] == sc_id for r in res):
                    res.append(sc)
            return res

    def save_macro(self, macro_id, macro_data):
        """新增或更新指定一键控制宏场景"""
        with self.lock:
            macros_dict = self.config.setdefault("macros", {})
            macro_data["id"] = macro_id
            macros_dict[macro_id] = macro_data
        self.save_config()
        return {"status": "ok", "message": f"一键控制 [{macro_data.get('name', macro_id)}] 保存成功"}

    def delete_macro(self, macro_id):
        """删除指定一键控制宏场景"""
        with self.lock:
            macros_dict = self.config.get("macros", {})
            if macro_id in macros_dict:
                del macros_dict[macro_id]
            scs = self.config.get("custom_scenarios", [])
            self.config["custom_scenarios"] = [sc for sc in scs if sc.get("id") != macro_id]
        self.save_config()
        return {"status": "ok", "message": f"一键控制 [{macro_id}] 已删除"}

    def run_macro_async(self, macro_id, player_coordinator=None):
        """异步启动一键开闭馆或自定义场景宏序列"""
        if self.current_macro_status["is_running"]:
            return {"status": "error", "message": "已有宏流程正在执行中，请稍候"}

        # 查找宏定义 (先查内置开闭馆 macros，再查 custom_scenarios)
        macro = self.config.get("macros", {}).get(macro_id)
        if not macro:
            for sc in self.config.get("custom_scenarios", []):
                if sc.get("id") == macro_id:
                    macro = sc
                    break

        if not macro:
            return {"status": "error", "message": f"未找到场景宏 {macro_id}"}

        steps = macro.get("steps", [])
        macro_name = macro.get("name", macro_id)

        t = threading.Thread(
            target=self._macro_worker,
            args=(macro_id, macro_name, steps, player_coordinator),
            daemon=True
        )
        t.start()
        return {"status": "ok", "message": f"宏序列 [{macro_name}] 已开始执行"}

    def _macro_worker(self, macro_id, macro_name, steps, player_coordinator):
        """宏序列后台工作线程"""
        with self.lock:
            self.current_macro_status = {
                "is_running": True,
                "macro_id": macro_id,
                "macro_name": macro_name,
                "current_step": 0,
                "total_steps": len(steps),
                "current_step_title": "初始化启动",
                "logs": [f"[{time.strftime('%H:%M:%S')}] 宏序列 [{macro_name}] 启动"]
            }

        # 跟踪设备关机时间戳，用于高价值光学设备 (激光投影仪等) 散热延时保护
        projector_off_timestamp = 0.0

        for idx, step in enumerate(steps, 1):
            delay = step.get("delay", 0)
            title = step.get("title", f"步骤 {idx}")

            with self.lock:
                self.current_macro_status["current_step"] = idx
                self.current_macro_status["current_step_title"] = title

            # 如果设置了延时
            if delay > 0:
                self._add_log(f"等待延时 {delay} 秒...")
                time.sleep(delay)

            # 硬件安全防线：若之前关闭了激光投影机，且当前步骤为切断电源总闸，强制校验散热冷却时间 (默认 120 秒)
            if "device_id" in step:
                dev_id = step["device_id"]
                cmd = step.get("cmd", "on")
                dev_obj = self.get_device(dev_id)
                dev_name = dev_obj.get("name", "").lower() if dev_obj else dev_id.lower()

                # 如果当前动作是切断时序电源/电源总闸
                if cmd == "off" and ("power" in dev_name or "时序" in dev_name or "电源" in dev_name or "总闸" in dev_name):
                    if projector_off_timestamp > 0:
                        elapsed = time.time() - projector_off_timestamp
                        # 冷却保护期 120 秒
                        required_cooldown = float(step.get("cooldown_override", 120))
                        remaining = required_cooldown - elapsed
                        if remaining > 0:
                            self._add_log(f"🛡️ [硬件安全防线] 检测到激光投影机刚关机，进入强制散热冷却保护期 (还需冷却 {int(remaining)} 秒)...")
                            # 循环倒计时输出进度，防止界面无响应感知
                            while remaining > 0:
                                sleep_chunk = min(5, remaining)
                                time.sleep(sleep_chunk)
                                remaining -= sleep_chunk
                                if remaining > 0:
                                    self._add_log(f"⏳ 激光投影机光源冷却中，剩余 {int(remaining)} 秒...")
                            self._add_log("✅ 投影机散热完成，安全切断时序电源！")
                            projector_off_timestamp = 0.0

            self._add_log(f"执行步骤 {idx}/{len(steps)}: {title}")

            # 判断步骤类型
            if "device_id" in step:
                # 环境设备动作
                dev_id = step["device_id"]
                cmd = step.get("cmd", "on")
                res = self.send_device_command(dev_id, cmd)
                self._add_log(f"设备 [{dev_id}] -> {res.get('message', '')}")

                # 记录投影机关机时间戳
                dev_obj = self.get_device(dev_id)
                dev_name = dev_obj.get("name", "").lower() if dev_obj else dev_id.lower()
                if cmd == "off" and ("projector" in dev_name or "投影" in dev_name or "光机" in dev_name):
                    projector_off_timestamp = time.time()
                    self._add_log("💡 [设备安全] 激光投影机已发关机指令，系统已自动布防散热倒计时保护")

            elif "action" in step:
                # 播控或系统联动动作
                act = step["action"]
                if player_coordinator:
                    try:
                        if act == "play_media":
                            media = step.get("media", "")
                            player_coordinator.handle_command("LOAD_AND_PLAY", {"media": media})
                            self._add_log(f"播控联动: 播放 {media}")
                        elif act == "stop_media":
                            player_coordinator.handle_command("STOP")
                            self._add_log("播控联动: 停止播放")
                        elif act == "blackout":
                            player_coordinator.handle_command("BLACKOUT", {"value": True})
                            self._add_log("播控联动: 一键黑场")
                    except Exception as pe:
                        self._add_log(f"播控执行联动异常: {pe}")

        self._add_log(f"[{time.strftime('%H:%M:%S')}] 宏序列 [{macro_name}] 全部执行完成")
        with self.lock:
            self.current_macro_status["is_running"] = False
            self.current_macro_status["current_step_title"] = "执行完毕"

    def _add_log(self, text):
        with self.lock:
            self.current_macro_status["logs"].append(f"[{time.strftime('%H:%M:%S')}] {text}")
            if len(self.current_macro_status["logs"]) > 50:
                self.current_macro_status["logs"].pop(0)

    def get_macro_status(self):
        with self.lock:
            return dict(self.current_macro_status)

    # ==================== 展馆物联网自定义中转中继路由 (Forwarder Engine) ====================

    def get_forwarders(self):
        """获取所有自定义中转转发规则列表 (附加实时触发统计与状态)"""
        with self.lock:
            fwds = self.config.get("forwarders", [])
            res = []
            for item in fwds:
                c = dict(item)
                f_id = c.get("id", "")
                st = self.forwarder_stats.get(f_id, {"count": 0, "last_time": "从未触发"})
                c["trigger_count"] = st.get("count", 0)
                c["last_triggered_time"] = st.get("last_time", "从未触发")
                res.append(c)
            return res

    def save_forwarder(self, fwd_data):
        """新增或更新自定义中转规则"""
        with self.lock:
            fwds = self.config.setdefault("forwarders", [])
            f_id = fwd_data.get("id")
            if not f_id:
                f_id = f"fwd_{int(time.time() * 1000)}"
                fwd_data["id"] = f_id

            # 规范默认值
            fwd_data.setdefault("name", "自定义中转规则")
            fwd_data.setdefault("enabled", True)
            fwd_data.setdefault("match_protocol", "ALL")     # ALL / TCP / UDP / HTTP / SERIAL
            fwd_data.setdefault("match_type", "CONTAINS")     # EXACT / CONTAINS / HEX
            fwd_data.setdefault("match_cmd", "")
            fwd_data.setdefault("target_protocol", "TCP")    # TCP / UDP / HTTP / SERIAL / WOL
            fwd_data.setdefault("target_host", "127.0.0.1")
            fwd_data.setdefault("target_port", 4001)
            fwd_data.setdefault("target_data_format", "TEXT") # TEXT / HEX / RAW
            fwd_data.setdefault("target_cmd", "")
            fwd_data.setdefault("delay_ms", 0)

            fwd_data.setdefault("listen_port", 8001 if fwd_data.get("match_protocol") == "UDP" else (8000 if fwd_data.get("match_protocol") == "TCP" else 0))

            found = False
            for idx, item in enumerate(fwds):
                if item.get("id") == f_id:
                    fwds[idx] = fwd_data
                    found = True
                    break
            if not found:
                fwds.append(fwd_data)

        self.save_config()
        self.check_and_start_all_listeners()
        return {"status": "ok", "message": f"中转规则 [{fwd_data.get('name')}] 已保存", "id": f_id, "forwarders": self.get_forwarders()}

    def delete_forwarder(self, fwd_id):
        """删除指定中转规则"""
        with self.lock:
            fwds = self.config.get("forwarders", [])
            self.config["forwarders"] = [f for f in fwds if f.get("id") != fwd_id]
            if fwd_id in self.forwarder_stats:
                del self.forwarder_stats[fwd_id]
        self.save_config()
        return {"status": "ok", "message": "中转规则已删除", "forwarders": self.get_forwarders()}

    def toggle_forwarder(self, fwd_id, enabled):
        """快速启用/禁用指定中转规则"""
        with self.lock:
            fwds = self.config.get("forwarders", [])
            for f in fwds:
                if f.get("id") == fwd_id:
                    f["enabled"] = bool(enabled)
                    break
        self.save_config()
        return {"status": "ok", "message": f"中转规则已{'启用' if enabled else '禁用'}", "forwarders": self.get_forwarders()}

    def test_forwarder(self, fwd_id):
        """手动模拟测试执行单条中转规则"""
        fwd = None
        for item in self.get_forwarders():
            if item.get("id") == fwd_id:
                fwd = item
                break
        if not fwd:
            return {"status": "error", "message": f"未找到中转规则 {fwd_id}"}
        res = self._execute_single_forward(fwd, raw_matched="MANUAL_TEST")
        return {"status": "ok", "message": f"测试执行完成: {res.get('message', '')}", "result": res}

    def process_forwarding(self, raw_data_str, protocol="TCP", source_addr=None, listen_port=None):
        """
        核心中转路由器：当系统收到来自 TCP、UDP、HTTP、串口命令时调用
        匹配所有已启用规则并分发至自定义目标 (可一对多转发)
        """
        if not raw_data_str:
            return []

        cleaned_str = str(raw_data_str).strip()
        matched_results = []
        forwarders = self.config.get("forwarders", [])

        for fwd in forwarders:
            if not fwd.get("enabled", True):
                continue

            # 1. 协议匹配检查 (ALL / TCP / UDP / HTTP / SERIAL)
            match_proto = fwd.get("match_protocol", "ALL").upper()
            if match_proto != "ALL" and match_proto != protocol.upper():
                continue

            # 1.1 监听端口匹配检查 (如果指定了监听端口)
            rule_listen_port = int(fwd.get("listen_port", 0) or 0)
            if rule_listen_port > 0 and listen_port is not None:
                if int(listen_port) != rule_listen_port:
                    continue

            # 2. 匹配规则模式判定
            match_type = fwd.get("match_type", "CONTAINS").upper()
            target_match_cmd = str(fwd.get("match_cmd", "")).strip()
            if not target_match_cmd:
                continue

            is_matched = False
            if match_type == "EXACT":
                is_matched = (cleaned_str == target_match_cmd or cleaned_str.upper() == target_match_cmd.upper())
            elif match_type == "STARTSWITH":
                is_matched = cleaned_str.upper().startswith(target_match_cmd.upper())
            elif match_type == "HEX":
                # 十六进制模糊/包含比对
                raw_hex = cleaned_str.replace(" ", "").replace("0x", "").upper()
                target_hex = target_match_cmd.replace(" ", "").replace("0x", "").upper()
                is_matched = (target_hex in raw_hex)
            else:  # 默认 CONTAINS
                is_matched = (target_match_cmd.upper() in cleaned_str.upper())

            if is_matched:
                # 记录统计
                f_id = fwd.get("id", "")
                st = self.forwarder_stats.setdefault(f_id, {"count": 0, "last_time": ""})
                st["count"] += 1
                st["last_time"] = time.strftime("%Y-%m-%d %H:%M:%S")

                print(f"[IoT Forwarder] 命中中转规则 [{fwd.get('name')}] (来源: {protocol} {source_addr or ''}) -> 转发至 {fwd.get('target_protocol')} {fwd.get('target_host')}:{fwd.get('target_port')}")

                # 异步执行转发，绝不阻塞当前通信流
                delay_ms = int(fwd.get("delay_ms", 0) or 0)
                if delay_ms > 0:
                    threading.Timer(delay_ms / 1000.0, self._execute_single_forward, args=(fwd, cleaned_str)).start()
                    matched_results.append({"id": f_id, "name": fwd.get("name"), "status": "scheduled", "delay_ms": delay_ms})
                else:
                    threading.Thread(target=self._execute_single_forward, args=(fwd, cleaned_str), daemon=True).start()
                    matched_results.append({"id": f_id, "name": fwd.get("name"), "status": "dispatched"})

        return matched_results

    def _execute_single_forward(self, fwd, raw_matched=""):
        """执行具体的网络/串口命令转发"""
        target_proto = str(fwd.get("target_protocol", "TCP")).upper()
        target_host = str(fwd.get("target_host", "127.0.0.1")).strip()
        target_port = int(fwd.get("target_port", 4001) or 4001)
        data_fmt = str(fwd.get("target_data_format", "TEXT")).upper()
        cmd_template = str(fwd.get("target_cmd", "") or "")

        # 动态变量替换：支持 {{RAW}} 变量透传原始指令
        final_cmd = cmd_template.replace("{{RAW}}", raw_matched) if "{{RAW}}" in cmd_template else (cmd_template or raw_matched)

        # 构造有效载荷 payload
        payload = b''
        if target_proto != "WOL":
            if data_fmt == "HEX":
                try:
                    cleaned_hex = final_cmd.replace(" ", "").replace("0x", "").replace(",", "")
                    payload = bytes.fromhex(cleaned_hex)
                except Exception as ex:
                    print(f"[IoT Forwarder] 十六进制编码异常: {ex}")
                    return {"status": "error", "message": f"Hex 编码解析失败: {ex}"}
            else:
                unescaped = final_cmd.replace('\\r', '\r').replace('\\n', '\n').replace('\\t', '\t')
                payload = unescaped.encode('utf-8')

        try:
            if target_proto == "TCP":
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(2.5)
                s.connect((target_host, target_port))
                s.sendall(payload)
                s.close()
                return {"status": "ok", "message": f"TCP 转发成功 -> {target_host}:{target_port}"}

            elif target_proto == "UDP":
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.settimeout(2.0)
                if target_host.endswith('.255') or target_host == '255.255.255.255':
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.sendto(payload, (target_host, target_port))
                s.close()
                return {"status": "ok", "message": f"UDP 转发成功 -> {target_host}:{target_port}"}

            elif target_proto == "HTTP":
                url = final_cmd if final_cmd.startswith("http") else f"http://{target_host}:{target_port}{final_cmd}"
                req = urllib.request.Request(url, headers={'User-Agent': 'VisualCast-Forwarder/1.0'})
                with urllib.request.urlopen(req, timeout=3.0) as resp:
                    resp_data = resp.read().decode('utf-8', errors='ignore')
                return {"status": "ok", "message": f"HTTP 转发成功: {resp.status}", "response": resp_data[:100]}

            elif target_proto == "SERIAL":
                serial_port = target_host if target_host.upper().startswith("COM") else "COM1"
                baudrate = target_port if target_port > 0 else 9600
                import serial
                with serial.Serial(port=serial_port, baudrate=baudrate, timeout=1.5) as ser:
                    ser.write(payload)
                    ser.flush()
                return {"status": "ok", "message": f"串口转发成功 -> {serial_port} @ {baudrate}bps"}

            elif target_proto == "WOL":
                clean_mac = target_host.replace(":", "").replace("-", "").replace(".", "").replace(" ", "").strip()
                mac_bytes = bytes.fromhex(clean_mac)
                magic_packet = b'\xFF' * 6 + mac_bytes * 16
                b_ip = "255.255.255.255"
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.sendto(magic_packet, (b_ip, target_port or 9))
                s.close()
                return {"status": "ok", "message": f"WOL 唤醒包已中转广播 -> MAC: {target_host}"}

            else:
                return {"status": "error", "message": f"不支持的目标协议: {target_proto}"}

        except Exception as e:
            print(f"[IoT Forwarder] 转发通信失败 ({target_proto} {target_host}): {e}")
            return {"status": "error", "message": f"转发异常: {e}"}

    def check_and_start_all_listeners(self):
        """检查并自动拉起配置了监听串口和自定义网络端口的后台守护线程"""
        self.check_and_start_serial_listeners()
        self.check_and_start_custom_net_listeners()

    def check_and_start_custom_net_listeners(self):
        """检查并自动拉起自定义 UDP / TCP 端口中转监听服务"""
        fwds = self.config.get("forwarders", [])
        for f in fwds:
            if not f.get("enabled", True):
                continue
            proto = str(f.get("match_protocol", "ALL")).upper()
            port = int(f.get("listen_port", 0) or 0)
            if port <= 0:
                continue

            # UDP 自定义端口监听 (避免与系统默认 8001 重复绑定)
            if proto in ("UDP", "ALL") and port != 8001:
                key = ("UDP", port)
                if key not in self.custom_net_listeners:
                    t = threading.Thread(target=self._custom_udp_listener_worker, args=(port,), daemon=True, name=f"CustomUDP-{port}")
                    t.start()
                    self.custom_net_listeners[key] = t
                    print(f"[IoT Custom Listener] 已启动自定义 UDP 中转监听端口: {port}")

            # TCP 自定义端口监听 (避免与系统默认 8000 重复绑定)
            if proto in ("TCP", "ALL") and port != 8000:
                key = ("TCP", port)
                if key not in self.custom_net_listeners:
                    t = threading.Thread(target=self._custom_tcp_listener_worker, args=(port,), daemon=True, name=f"CustomTCP-{port}")
                    t.start()
                    self.custom_net_listeners[key] = t
                    print(f"[IoT Custom Listener] 已启动自定义 TCP 中转监听端口: {port}")

    def _custom_udp_listener_worker(self, port):
        """持续监听自定义 UDP 端口"""
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('0.0.0.0', port))
        except Exception as e:
            print(f"[IoT Custom Listener] 绑定自定义 UDP 端口 {port} 失败: {e}")
            return
        while True:
            try:
                data, addr = s.recvfrom(2048)
                if data:
                    text = data.decode('utf-8', errors='ignore').strip()
                    if text:
                        self.process_forwarding(text, protocol="UDP", source_addr=str(addr), listen_port=port)
            except Exception:
                time.sleep(0.5)

    def _custom_tcp_listener_worker(self, port):
        """持续监听自定义 TCP 端口"""
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('0.0.0.0', port))
            s.listen(10)
        except Exception as e:
            print(f"[IoT Custom Listener] 绑定自定义 TCP 端口 {port} 失败: {e}")
            return
        while True:
            try:
                client, addr = s.accept()
                threading.Thread(target=self._handle_custom_tcp_client, args=(client, addr, port), daemon=True).start()
            except Exception:
                time.sleep(0.5)

    def _handle_custom_tcp_client(self, client, addr, port):
        """处理自定义 TCP 客户端连接"""
        try:
            client.settimeout(10.0)
            data = client.recv(2048)
            if data:
                text = data.decode('utf-8', errors='ignore').strip()
                if text:
                    self.process_forwarding(text, protocol="TCP", source_addr=str(addr), listen_port=port)
                client.sendall(b"OK\r\n")
        except Exception:
            pass
        finally:
            try: client.close()
            except Exception: pass

    def check_and_start_serial_listeners(self):
        """检查并自动拉起配置了监听串口的后台守护线程"""
        fwds = self.config.get("forwarders", [])
        serial_ports_needed = set()
        for f in fwds:
            if f.get("enabled", True) and str(f.get("match_protocol")).upper() == "SERIAL":
                port = str(f.get("listen_serial_port") or f.get("serial_port") or "COM1").strip().upper()
                baud = int(f.get("listen_baudrate") or f.get("baudrate") or 9600)
                serial_ports_needed.add((port, baud))

        for port, baud in serial_ports_needed:
            if port not in self.serial_listeners:
                t = threading.Thread(target=self._serial_listener_worker, args=(port, baud), daemon=True, name=f"SerialListener-{port}")
                t.start()
                self.serial_listeners[port] = t
                print(f"[IoT Serial Listener] 已启动串口中转监听后台线程: {port} @ {baud}bps")

    def _serial_listener_worker(self, port, baudrate):
        """串口持续监听接收工作线程"""
        while True:
            try:
                import serial
                with serial.Serial(port=port, baudrate=baudrate, timeout=1.0) as ser:
                    while True:
                        line = ser.readline()
                        if line:
                            text = line.decode('utf-8', errors='ignore').strip()
                            if text:
                                self.process_forwarding(text, protocol="SERIAL", source_addr=port)
            except Exception as e:
                # 串口若未插或占用，休眠 5 秒后重试自愈
                time.sleep(5.0)


iot_engine = IoTEngine()
