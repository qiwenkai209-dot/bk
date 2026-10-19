# -*- coding: utf-8 -*-
"""
VisualCast 局域网大屏在线设备中枢 (Fleet Management Hub)
专用于中控室、网管电脑或移动笔记本的独立桌面管理控制台。
特性:
1. 零依赖轻量启动，自动查找空闲端口；
2. 自动唤起系统现代化浏览器呈现 VisualCast 全屏设备中枢；
3. 高速并发扫描局域网内所有 8088 端口的在线 VisualCast 大屏；
4. 支持大屏别名持久化、一键直达管理后台(/admin)、直达大屏放映(/player)、直达手机手牌(/remote)。
"""

import os
import sys
import json
import time
import socket
import threading
import webbrowser
from wsgiref.simple_server import make_server, WSGIServer, WSGIRequestHandler
from concurrent.futures import ThreadPoolExecutor
import bottle
from bottle import Bottle, request, response, static_file

import system_control
from device_manager import device_discovery_manager

# PyInstaller 单文件兼容
if getattr(sys, 'frozen', False):
    BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    EXE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    EXE_DIR = BASE_DIR

STATIC_DIR = os.path.join(BASE_DIR, 'static')
CONFIG_DIR = os.path.join(EXE_DIR, 'config')
os.makedirs(CONFIG_DIR, exist_ok=True)

# 确保配置保存在 EXE 旁边
device_discovery_manager.config_dir = CONFIG_DIR
device_discovery_manager.config_file = os.path.join(CONFIG_DIR, 'discovered_devices.json')
device_discovery_manager.load_config()

# 彻底解除本地代理拦截
os.environ['NO_PROXY'] = 'localhost,127.0.0.1,0.0.0.0'
os.environ['no_proxy'] = 'localhost,127.0.0.1,0.0.0.0'

app = Bottle()

class QuietWSGIRequestHandler(WSGIRequestHandler):
    def log_message(self, format, *args):
        pass  # 静默请求日志

@app.route('/')
@app.route('/fleet')
def page_fleet():
    return static_file('fleet.html', root=STATIC_DIR)

@app.route('/static/<filepath:path>')
def serve_static(filepath):
    return static_file(filepath, root=STATIC_DIR)

@app.route('/api/devices/list', method=['GET'])
def api_devices_list():
    try:
        data = device_discovery_manager.get_device_list()
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e), "devices": []}, ensure_ascii=False)

@app.route('/api/devices/scan', method=['POST'])
def api_devices_scan():
    try:
        data = device_discovery_manager.scan_lan_devices()
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e), "devices": []}, ensure_ascii=False)

@app.route('/api/devices/rename', method=['POST'])
def api_devices_rename():
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        ip = data.get('ip', '')
        custom_name = data.get('custom_name', '')
        res = device_discovery_manager.set_device_name(ip, custom_name)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps(res, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

@app.route('/api/devices/delete', method=['POST'])
def api_devices_delete():
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

@app.route('/api/devices/probe', method=['POST'])
def api_devices_probe():
    try:
        try:
            data = json.load(request.body)
        except Exception:
            data = request.json or {}
        ip = data.get('ip', '')
        res = device_discovery_manager.single_probe_device(ip)
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "ok", "device": res}, ensure_ascii=False)
    except Exception as e:
        response.content_type = 'application/json; charset=utf-8'
        return json.dumps({"status": "error", "message": str(e)}, ensure_ascii=False)

def find_available_port(start_port=8099, max_attempts=50):
    for p in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('0.0.0.0', p))
                return p
            except OSError:
                continue
    return start_port

def run_server(port):
    server = make_server('0.0.0.0', port, app, handler_class=QuietWSGIRequestHandler)
    server.serve_forever()

def main():
    port = find_available_port(8099)
    url = f"http://127.0.0.1:{port}/fleet"

    # 获取本机活跃 IP
    net_interfaces = system_control.get_network_interfaces()
    local_ips = [n['ip'] for n in net_interfaces if n.get('ip') and not n['ip'].startswith('127.')]
    primary_ip = local_ips[0] if local_ips else "127.0.0.1"

    print("=" * 65)
    print("      VisualCast 局域网大屏在线设备中枢 (Fleet Management Hub)")
    print("=" * 65)
    print(f" [*] 本机局域网 IP: {primary_ip}")
    print(f" [*] 设备中枢服务端口: {port}")
    print(f" [*] 控制台访问地址: {url}")
    print(" [*] 正在唤起系统浏览器并自动并发探测局域网...")
    print("=" * 65)
    print(" 操作提示:")
    print("  - 回车键 (Enter): 立即重新并发扫描局域网全网段")
    print("  - 输入 Q 或 Ctrl+C: 安全退出设备中枢")
    print("=" * 65)

    # 启动后台 WSGI 服务
    t = threading.Thread(target=run_server, args=(port,), daemon=True)
    t.start()

    # 稍作等待自动打开浏览器
    def open_browser():
        time.sleep(0.6)
        try:
            webbrowser.open(url)
        except Exception:
            pass
    threading.Thread(target=open_browser, daemon=True).start()

    # 控制台循环
    try:
        while True:
            cmd = input().strip().lower()
            if cmd == 'q':
                print("[*] 正在退出设备中枢...")
                break
            else:
                print(f"[{time.strftime('%H:%M:%S')}] 正在高速并发扫描全网大屏节点...")
                devices = device_discovery_manager.scan_lan_devices()
                dev_list = devices.get("devices", [])
                print(f"[{time.strftime('%H:%M:%S')}] 扫描完成，发现 {len(dev_list)} 台大屏设备:")
                for d in dev_list:
                    print(f"   -> [{d['ip']}] {d.get('custom_name') or d.get('hostname')} | {d.get('status')} | 后台: {d.get('admin_url')}")
    except (KeyboardInterrupt, EOFError):
        print("\n[*] 设备中枢已停止。")

if __name__ == '__main__':
    main()
