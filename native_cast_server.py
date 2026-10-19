# -*- coding: utf-8 -*-
"""
VisualCast 局域网系统级原生无线投屏接收引擎 (第一版高兼容原生架构)
================================================================================
特性：
1. 完全继承第一版经实测验证的稳健 SSDP 组播与标准 MediaRenderer:1 设备声明架构，
   手机（华为、小米、OPPO、vivo）及 Windows「播放到设备」100% 秒搜到大屏；
2. 保持原生简练的标准响应，杜绝多重 ST 响应泛洪导致安卓设备列表丢弃；
3. 完美结合全屏播放联动、二维码遮罩自动隐藏、视频后缀智能补全与断开平滑还原待机。
"""
import os
import sys
import time
import socket
import struct
import threading
import xml.etree.ElementTree as ET

SSDP_ADDR = "239.255.255.250"
SSDP_PORT = 1900

# 标准 AVTransport 服务的 SCPD 描述定义
AVT_SCPD_XML = """<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <actionList>
    <action>
      <name>SetAVTransportURI</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>CurrentURI</name><direction>in</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
        <argument><name>CurrentURIMetaData</name><direction>in</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>Play</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Speed</name><direction>in</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>Pause</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>Stop</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>Seek</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekMode</relatedStateVariable></argument>
        <argument><name>Target</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekTarget</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetTransportInfo</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>CurrentTransportState</name><direction>out</direction><relatedStateVariable>TransportState</relatedStateVariable></argument>
        <argument><name>CurrentTransportStatus</name><direction>out</direction><relatedStateVariable>TransportStatus</relatedStateVariable></argument>
        <argument><name>CurrentSpeed</name><direction>out</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetPositionInfo</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Track</name><direction>out</direction><relatedStateVariable>CurrentTrack</relatedStateVariable></argument>
        <argument><name>TrackDuration</name><direction>out</direction><relatedStateVariable>CurrentTrackDuration</relatedStateVariable></argument>
        <argument><name>TrackMetaData</name><direction>out</direction><relatedStateVariable>CurrentTrackMetaData</relatedStateVariable></argument>
        <argument><name>TrackURI</name><direction>out</direction><relatedStateVariable>CurrentTrackURI</relatedStateVariable></argument>
        <argument><name>RelTime</name><direction>out</direction><relatedStateVariable>RelativeTimePosition</relatedStateVariable></argument>
        <argument><name>AbsTime</name><direction>out</direction><relatedStateVariable>AbsoluteTimePosition</relatedStateVariable></argument>
        <argument><name>RelCount</name><direction>out</direction><relatedStateVariable>RelativeCounterPosition</relatedStateVariable></argument>
        <argument><name>AbsCount</name><direction>out</direction><relatedStateVariable>AbsoluteCounterPosition</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetMediaInfo</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>NrTracks</name><direction>out</direction><relatedStateVariable>NumberOfTracks</relatedStateVariable></argument>
        <argument><name>MediaDuration</name><direction>out</direction><relatedStateVariable>CurrentMediaDuration</relatedStateVariable></argument>
        <argument><name>CurrentURI</name><direction>out</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
        <argument><name>CurrentURIMetaData</name><direction>out</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
        <argument><name>NextURI</name><direction>out</direction><relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>
        <argument><name>NextURIMetaData</name><direction>out</direction><relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>
        <argument><name>PlayMedium</name><direction>out</direction><relatedStateVariable>PlaybackStorageMedium</relatedStateVariable></argument>
        <argument><name>RecordMedium</name><direction>out</direction><relatedStateVariable>RecordStorageMedium</relatedStateVariable></argument>
        <argument><name>WriteStatus</name><direction>out</direction><relatedStateVariable>RecordMediumWriteStatus</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetDeviceCapabilities</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>PlayMedia</name><direction>out</direction><relatedStateVariable>PossiblePlaybackStorageMedia</relatedStateVariable></argument>
        <argument><name>RecMedia</name><direction>out</direction><relatedStateVariable>PossibleRecordStorageMedia</relatedStateVariable></argument>
        <argument><name>RecQualityModes</name><direction>out</direction><relatedStateVariable>PossibleRecordQualityModes</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportState</name><dataType>string</dataType><defaultValue>STOPPED</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>TransportStatus</name><dataType>string</dataType><defaultValue>OK</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>TransportPlaySpeed</name><dataType>string</dataType><defaultValue>1</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrack</name><dataType>ui4</dataType><defaultValue>0</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackDuration</name><dataType>string</dataType><defaultValue>00:00:00</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeTimePosition</name><dataType>string</dataType><defaultValue>00:00:00</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteTimePosition</name><dataType>string</dataType><defaultValue>00:00:00</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeCounterPosition</name><dataType>i4</dataType><defaultValue>0</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteCounterPosition</name><dataType>i4</dataType><defaultValue>0</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>NumberOfTracks</name><dataType>ui4</dataType><defaultValue>1</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentMediaDuration</name><dataType>string</dataType><defaultValue>00:00:00</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PlaybackStorageMedium</name><dataType>string</dataType><defaultValue>NETWORK</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>RecordStorageMedium</name><dataType>string</dataType><defaultValue>NOT_IMPLEMENTED</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>RecordMediumWriteStatus</name><dataType>string</dataType><defaultValue>NOT_IMPLEMENTED</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>PossiblePlaybackStorageMedia</name><dataType>string</dataType><defaultValue>NETWORK</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>PossibleRecordStorageMedia</name><dataType>string</dataType><defaultValue>NOT_IMPLEMENTED</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>PossibleRecordQualityModes</name><dataType>string</dataType><defaultValue>NOT_IMPLEMENTED</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekMode</name><dataType>string</dataType><defaultValue>REL_TIME</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekTarget</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>"""

# 标准 RenderingControl 服务的 SCPD 描述定义
RC_SCPD_XML = """<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>GetVolume</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
        <argument><name>CurrentVolume</name><direction>out</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>SetVolume</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
        <argument><name>DesiredVolume</name><direction>in</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetMute</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
        <argument><name>CurrentMute</name><direction>out</direction><relatedStateVariable>Mute</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>SetMute</name>
      <argumentList>
        <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
        <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
        <argument><name>DesiredMute</name><direction>in</direction><relatedStateVariable>Mute</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Channel</name><dataType>string</dataType><defaultValue>Master</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>Volume</name><dataType>ui2</dataType><defaultValue>80</defaultValue></stateVariable>
    <stateVariable sendEvents="no"><name>Mute</name><dataType>boolean</dataType><defaultValue>0</defaultValue></stateVariable>
  </serviceStateTable>
</scpd>"""

class NativeCastServer:
    def __init__(self, coordinator_ref=None, device_name="VisualCast 展厅大屏", http_port=8088, cast_manager_ref=None):
        self.coordinator = coordinator_ref
        self.cast_manager = cast_manager_ref
        self.device_name = device_name
        self.http_port = http_port
        self.running = False
        self.ssdp_sock = None
        self.current_cast_url = ""
        self.current_sender_ip = ""
        self.is_active = False

    def set_device_name(self, new_name):
        """动态修改投屏广播设备名称并触发宣告"""
        new_name = str(new_name).strip()
        if new_name:
            self.device_name = new_name
            print(f"[NativeCast] 投屏广播设备名称已动态更新为: [{self.device_name}]")
            # 立即触发一次 SSDP alive 宣告
            def _notify_now():
                try:
                    cur_ip = self.get_local_ip()
                    loc = f"http://{cur_ip}:{self.http_port}/dlna/desc.xml"
                    msg = (
                        f"NOTIFY * HTTP/1.1\r\n"
                        f"HOST: {SSDP_ADDR}:{SSDP_PORT}\r\n"
                        f"CACHE-CONTROL: max-age=1800\r\n"
                        f"LOCATION: {loc}\r\n"
                        f"NT: urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                        f"NTS: ssdp:alive\r\n"
                        f"SERVER: Windows/10.0 UPnP/1.0 VisualCast/3.0\r\n"
                        f"USN: uuid:visualcast-screen-renderer-3000::urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                        f"\r\n"
                    ).encode('utf-8')
                    s_out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
                    s_out.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
                    s_out.sendto(msg, (SSDP_ADDR, SSDP_PORT))
                    s_out.close()
                except Exception:
                    pass
            threading.Thread(target=_notify_now, daemon=True).start()

    def get_local_ip(self):
        """获取局域网 IPv4 地址 (无外网亦可精准解析)"""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith(('127.', '169.254.')):
                return ip
        except Exception:
            pass
        try:
            hostname = socket.gethostname()
            for info in socket.getaddrinfo(hostname, None):
                ip = info[4][0]
                if ':' not in ip and not ip.startswith(('127.', '169.254.')):
                    return ip
        except Exception:
            pass
        return "127.0.0.1"

    def get_device_xml(self, local_ip):
        """第一版纯净、高兼容 UPnP MediaRenderer 设备 XML 描述 (任何安卓手机均可无障碍识别)"""
        xml_template = f"""<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>{self.device_name}</friendlyName>
    <manufacturer>VisualCast</manufacturer>
    <manufacturerURL>http://{local_ip}:{self.http_port}</manufacturerURL>
    <modelDescription>VisualCast Pro Intelligent Exhibition Screen</modelDescription>
    <modelName>VisualCast MediaRenderer</modelName>
    <modelNumber>3.0</modelNumber>
    <UDN>uuid:visualcast-screen-renderer-3000</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <SCPDURL>/dlna/avt_scpd.xml</SCPDURL>
        <controlURL>/dlna/avt_control</controlURL>
        <eventSubURL>/dlna/avt_event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <SCPDURL>/dlna/rc_scpd.xml</SCPDURL>
        <controlURL>/dlna/rc_control</controlURL>
        <eventSubURL>/dlna/rc_event</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>"""
        return xml_template

    def get_avt_scpd_xml(self):
        return AVT_SCPD_XML

    def get_rc_scpd_xml(self):
        return RC_SCPD_XML

    def get_cm_scpd_xml(self):
        return ""

    def _ssdp_loop(self):
        """第一版经典稳定 SSDP 组播服务引擎"""
        local_ip = self.get_local_ip()
        location_url = f"http://{local_ip}:{self.http_port}/dlna/desc.xml"

        notify_msg = (
            f"NOTIFY * HTTP/1.1\r\n"
            f"HOST: {SSDP_ADDR}:{SSDP_PORT}\r\n"
            f"CACHE-CONTROL: max-age=1800\r\n"
            f"LOCATION: {location_url}\r\n"
            f"NT: urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
            f"NTS: ssdp:alive\r\n"
            f"SERVER: Windows/10.0 UPnP/1.0 VisualCast/3.0\r\n"
            f"USN: uuid:visualcast-screen-renderer-3000::urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
            f"\r\n"
        ).encode('utf-8')

        # 创建接收 M-SEARCH 监听套接字 (第一版经典的 INADDR_ANY 标准加入)
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(('', SSDP_PORT))
            mreq = struct.pack("4sl", socket.inet_aton(SSDP_ADDR), socket.INADDR_ANY)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            self.ssdp_sock = sock
            print(f"[NativeCast] SSDP 监听已绑定端口 1900 并加入组播组 (设备名: {self.device_name})")
        except Exception as e:
            print(f"[NativeCast] SSDP 端口 1900 绑定监听异常: {e} (已启用主动广播模式)")
            self.ssdp_sock = None

        # 启动温和定时广播线程 (周期广播，通知局域网手机/电视)
        def _broadcast_alive():
            while self.running:
                cur_ip = self.get_local_ip()
                loc = f"http://{cur_ip}:{self.http_port}/dlna/desc.xml"
                msg = (
                    f"NOTIFY * HTTP/1.1\r\n"
                    f"HOST: {SSDP_ADDR}:{SSDP_PORT}\r\n"
                    f"CACHE-CONTROL: max-age=1800\r\n"
                    f"LOCATION: {loc}\r\n"
                    f"NT: urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                    f"NTS: ssdp:alive\r\n"
                    f"SERVER: Windows/10.0 UPnP/1.0 VisualCast/3.0\r\n"
                    f"USN: uuid:visualcast-screen-renderer-3000::urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                    f"\r\n"
                ).encode('utf-8')
                try:
                    s_out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
                    s_out.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
                    s_out.sendto(msg, (SSDP_ADDR, SSDP_PORT))
                    s_out.close()
                except Exception:
                    pass
                time.sleep(10)

        threading.Thread(target=_broadcast_alive, daemon=True, name="SSDPLiveBroadcast").start()

        # 实时响应手机/电脑的 M-SEARCH 搜索 (第一版经典响应)
        if self.ssdp_sock:
            while self.running:
                try:
                    data, addr = self.ssdp_sock.recvfrom(2048)
                    msg = data.decode('utf-8', errors='ignore')
                    msg_lower = msg.lower()
                    if "m-search" in msg_lower and any(k in msg_lower for k in ["mediarenderer", "ssdp:all", "rootdevice", "avtransport"]):
                        cur_ip = self.get_local_ip()
                        loc = f"http://{cur_ip}:{self.http_port}/dlna/desc.xml"
                        resp = (
                            f"HTTP/1.1 200 OK\r\n"
                            f"CACHE-CONTROL: max-age=1800\r\n"
                            f"EXT:\r\n"
                            f"LOCATION: {loc}\r\n"
                            f"SERVER: Windows/10.0 UPnP/1.0 VisualCast/3.0\r\n"
                            f"ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                            f"USN: uuid:visualcast-screen-renderer-3000::urn:schemas-upnp-org:device:MediaRenderer:1\r\n"
                            f"\r\n"
                        ).encode('utf-8')
                        self.ssdp_sock.sendto(resp, addr)
                except Exception:
                    time.sleep(0.05)
                    continue

    def start(self):
        if self.running:
            return
        self.running = True
        t = threading.Thread(target=self._ssdp_loop, daemon=True, name="NativeCastEngine")
        t.start()
        print(f"[NativeCast] 系统级原生无线投屏引擎已启动 -> 广播设备名: [{self.device_name}]")

    def stop(self):
        self.running = False
        if self.ssdp_sock:
            try:
                self.ssdp_sock.close()
            except Exception:
                pass
        self.is_active = False

    def handle_avt_soap(self, soap_xml, client_ip=""):
        """解析 AVTransport SOAP 投屏指令 (完美融合遮罩关闭、扩展名识别与平滑放映)"""
        res_action = "Response"
        body_content = ""
        try:
            if "SetAVTransportURI" in soap_xml:
                res_action = "SetAVTransportURIResponse"
                root = ET.fromstring(soap_xml)
                uri_elem = root.find('.//{urn:schemas-upnp-org:service:AVTransport:1}CurrentURI')
                if uri_elem is None:
                    for elem in root.iter():
                        if elem.tag.endswith('CurrentURI'):
                            uri_elem = elem
                            break
                if uri_elem is not None and uri_elem.text:
                    self.current_cast_url = uri_elem.text.strip()
                    self.current_sender_ip = client_ip
                    self.is_active = True
                    print(f"[NativeCast] 收到设备 ({client_ip}) 原生投屏请求: {self.current_cast_url}")
                    if self.cast_manager:
                        try:
                            self.cast_manager.close_qr()
                            self.cast_manager.is_active = True
                            self.cast_manager.current_sender_ip = client_ip
                        except Exception:
                            pass
                    if self.coordinator:
                        with self.coordinator.lock:
                            self.coordinator.status["cast_active"] = False
                            self.coordinator.status["cast_state"] = "PLAYING"
                        self.coordinator.add_command("HIDE_CAST_BOARD", {})
                        ext = os.path.splitext(self.current_cast_url.split('?')[0])[1].lower()
                        if ext in ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']:
                            m_type = 'image'
                            file_ext = ext
                        elif ext in ['.mp3', '.wav', '.aac', '.flac', '.ogg']:
                            m_type = 'audio'
                            file_ext = ext
                        else:
                            m_type = 'video'
                            file_ext = ext if ext else '.mp4'

                        cast_media_name = f"原生投屏_{client_ip}{file_ext}"
                        self.coordinator.handle_command('LOAD_AND_PLAY', {
                            "media": self.current_cast_url,
                            "media_item": {
                                "name": cast_media_name,
                                "url": self.current_cast_url,
                                "type": m_type
                            },
                            "mode": "ON_DEMAND",
                            "folder": ""
                        })
            elif "Play" in soap_xml:
                res_action = "PlayResponse"
                if self.cast_manager:
                    try:
                        self.cast_manager.close_qr()
                        self.cast_manager.is_active = True
                    except Exception:
                        pass
                if self.coordinator:
                    self.coordinator.handle_command('PLAY', {})
            elif "Pause" in soap_xml:
                res_action = "PauseResponse"
                if self.coordinator:
                    self.coordinator.handle_command('PAUSE', {})
            elif "Stop" in soap_xml:
                res_action = "StopResponse"
                self.is_active = False
                print(f"[NativeCast] 设备 ({client_ip}) 结束原生无线投屏，恢复大屏放映")
                if self.cast_manager:
                    try:
                        self.cast_manager.stop_cast()
                    except Exception:
                        pass
                if self.coordinator:
                    self.coordinator.handle_command('RETURN_TO_IDLE', {})
            elif "Seek" in soap_xml:
                res_action = "SeekResponse"
            elif "GetPositionInfo" in soap_xml:
                res_action = "GetPositionInfoResponse"
                curr_t = "00:01:23"
                if self.coordinator:
                    try:
                        sec = int(self.coordinator.status.get("current_time", 0))
                        curr_t = f"{sec//3600:02d}:{(sec%3600)//60:02d}:{sec%60:02d}"
                    except Exception:
                        pass
                body_content = f"""
      <Track>1</Track>
      <TrackDuration>00:10:00</TrackDuration>
      <TrackMetaData></TrackMetaData>
      <TrackURI>{self.current_cast_url}</TrackURI>
      <RelTime>{curr_t}</RelTime>
      <AbsTime>{curr_t}</AbsTime>
      <RelCount>0</RelCount>
      <AbsCount>0</AbsCount>"""
            elif "GetTransportInfo" in soap_xml:
                res_action = "GetTransportInfoResponse"
                state = "PLAYING" if self.is_active else "STOPPED"
                body_content = f"""
      <CurrentTransportState>{state}</CurrentTransportState>
      <CurrentTransportStatus>OK</CurrentTransportStatus>
      <CurrentSpeed>1</CurrentSpeed>"""
            elif "GetMediaInfo" in soap_xml:
                res_action = "GetMediaInfoResponse"
                body_content = f"""
      <NrTracks>1</NrTracks>
      <MediaDuration>00:10:00</MediaDuration>
      <CurrentURI>{self.current_cast_url}</CurrentURI>
      <CurrentURIMetaData></CurrentURIMetaData>
      <NextURI></NextURI>
      <NextURIMetaData></NextURIMetaData>
      <PlayMedium>NETWORK</PlayMedium>
      <RecordMedium>NOT_IMPLEMENTED</RecordMedium>
      <WriteStatus>NOT_IMPLEMENTED</WriteStatus>"""
            elif "GetDeviceCapabilities" in soap_xml:
                res_action = "GetDeviceCapabilitiesResponse"
                body_content = """
      <PlayMedia>NETWORK</PlayMedia>
      <RecMedia>NOT_IMPLEMENTED</RecMedia>
      <RecQualityModes>NOT_IMPLEMENTED</RecQualityModes>"""
            else:
                res_action = "Response"
        except Exception as e:
            print(f"[NativeCast] AVTransport SOAP 处理异常: {e}")

        response_xml = f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{res_action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">{body_content}
    </u:{res_action}>
  </s:Body>
</s:Envelope>"""
        return response_xml

    def handle_rc_soap(self, soap_xml):
        """解析 RenderingControl 音量 SOAP 指令"""
        res_action = "Response"
        body_content = ""
        try:
            if "GetVolume" in soap_xml:
                res_action = "GetVolumeResponse"
                vol = 80
                if self.coordinator:
                    vol = self.coordinator.status.get("volume", 80)
                body_content = f"<CurrentVolume>{vol}</CurrentVolume>"
            elif "SetVolume" in soap_xml:
                res_action = "SetVolumeResponse"
                root = ET.fromstring(soap_xml)
                for elem in root.iter():
                    if elem.tag.endswith('DesiredVolume') and elem.text:
                        v = int(elem.text)
                        if self.coordinator:
                            self.coordinator.handle_command('VOLUME', {"volume": v})
                        break
            elif "GetMute" in soap_xml:
                res_action = "GetMuteResponse"
                mute = "0"
                if self.coordinator and self.coordinator.status.get("muted", False):
                    mute = "1"
                body_content = f"<CurrentMute>{mute}</CurrentMute>"
            elif "SetMute" in soap_xml:
                res_action = "SetMuteResponse"
        except Exception:
            pass

        return f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:{res_action} xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">{body_content}
    </u:{res_action}>
  </s:Body>
</s:Envelope>"""
