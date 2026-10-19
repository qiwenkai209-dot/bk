# -*- coding: utf-8 -*-
"""
VisualCast 运行时授权安全守卫模块 (License Guard v3)
===================================================
核心功能:
1. 提取本机硬件指纹，生成 12-bit 硬件特征码 (0~4095)。
2. 本地真随机申请码 (Request Code) 生命周期管理:
   - 包含硬件特征和当前代际的 16-bit 随机 Nonce。
   - 对外呈现 8 位动态随机码 (如 'C7MR-Y7S6')。
3. 严格单次激活与防二次激活 (One-Time Activation / Anti-Replay Guard):
   - 激活码必须与当前设备的随机申请码 Nonce 精确一致。
   - 激活成功瞬间，立即在本地将该 Nonce 销毁并翻转为全新的硬件真随机数！
   - 同一个激活码绝无可能在该机器上二次激活！
   - 即使删除配置文件或重装，新初始化的随机码也完全不同，旧码同样无法激活！
4. 加密管理本地授权凭证 (config/.license.dat)，具备防篡改与防系统时钟回拨保护。
5. 记录启动消耗次数与安全时间戳。
"""

import os
import sys
import json
import time
import uuid
import ctypes
import hashlib
from datetime import datetime

from universal_license_core import (
    decode_license,
    encode_request_code,
    decode_request_code
)

# 本地加密存储密钥 (结合硬件特征混淆)
STORAGE_KEY_BASE = b"VC_License_Storage_Protected_Key_#2026_V3!"


def get_base_dir():
    """获取程序根目录"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def get_system_hardware_id() -> str:
    """提取稳定的硬件特征标识 (主分区卷序列号 + 网卡 MAC + 处理器标识)"""
    parts = []

    # 1. 尝试获取 C 盘卷序列号
    try:
        if sys.platform == 'win32':
            volume_serial = ctypes.c_ulong()
            max_comp_len = ctypes.c_ulong()
            file_sys_flags = ctypes.c_ulong()
            rc = ctypes.windll.kernel32.GetVolumeInformationW(
                "C:\\", None, 0,
                ctypes.byref(volume_serial),
                ctypes.byref(max_comp_len),
                ctypes.byref(file_sys_flags),
                None, 0
            )
            if rc:
                parts.append(f"VOL_{volume_serial.value:08X}")
    except Exception:
        pass

    # 2. 结合网卡 MAC
    try:
        node_mac = uuid.getnode()
        parts.append(f"MAC_{node_mac:012X}")
    except Exception:
        pass

    # 3. 结合处理器架构与核心数
    proc = os.environ.get("PROCESSOR_IDENTIFIER", "")
    cores = os.environ.get("NUMBER_OF_PROCESSORS", "1")
    parts.append(f"CPU_{proc}_{cores}")

    raw_signature = "|".join(parts)
    return hashlib.sha256(raw_signature.encode('utf-8', errors='ignore')).hexdigest()


def get_local_hardware_hash() -> int:
    """
    计算本机的 12-bit 硬件特征码 (1 ~ 4095)
    0 保留为全平台通用卡密码
    """
    hw_id = get_system_hardware_id()
    h_int = int(hw_id[:8], 16)
    val = (h_int % 4095) + 1
    return val


def get_local_machine_code() -> str:
    """获取人类友好的短机器码字符串，例如 'MC-3A5'"""
    hw_hash = get_local_hardware_hash()
    return f"MC-{hw_hash:03X}"


class LicenseGuard:
    def __init__(self):
        self.base_dir = get_base_dir()
        self.config_dir = os.path.join(self.base_dir, 'config')
        os.makedirs(self.config_dir, exist_ok=True)
        self.license_file = os.path.join(self.config_dir, '.license.dat')
        self.hw_hash = get_local_hardware_hash()
        self.machine_code = get_local_machine_code()
        self._ensure_pending_nonce()

    def _get_crypto_key(self) -> bytes:
        """派生本地防篡改加密密钥"""
        hw_id = get_system_hardware_id()
        return hashlib.sha256(STORAGE_KEY_BASE + hw_id.encode('utf-8')).digest()

    def _xor_cipher(self, data: bytes, key: bytes) -> bytes:
        """对称流加密混淆"""
        out = bytearray(len(data))
        k_len = len(key)
        for i in range(len(data)):
            out[i] = data[i] ^ key[i % k_len]
        return bytes(out)

    def _read_storage(self) -> dict:
        """安全读取本地加密凭证"""
        if not os.path.exists(self.license_file):
            return {}
        try:
            with open(self.license_file, 'rb') as f:
                encrypted = f.read()
            key = self._get_crypto_key()
            decrypted = self._xor_cipher(encrypted, key)
            return json.loads(decrypted.decode('utf-8'))
        except Exception:
            return {}

    def _write_storage(self, data: dict) -> bool:
        """安全写入本地加密凭证"""
        try:
            json_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
            key = self._get_crypto_key()
            encrypted = self._xor_cipher(json_bytes, key)
            with open(self.license_file, 'wb') as f:
                f.write(encrypted)
            return True
        except Exception:
            return False

    def _generate_new_nonce(self) -> int:
        """生成 16-bit 硬件真随机数 (1 ~ 65535)"""
        raw = int.from_bytes(os.urandom(2), 'big') & 0xFFFF
        if raw == 0:
            raw = 1
        return raw

    def _ensure_pending_nonce(self):
        """确保本地持有一个当前待激活的随机 Nonce"""
        store = self._read_storage()
        pending = store.get("pending_nonce", 0)
        if not pending or not isinstance(pending, int):
            new_nonce = self._generate_new_nonce()
            store["pending_nonce"] = new_nonce
            self._write_storage(store)
            self.pending_nonce = new_nonce
        else:
            self.pending_nonce = pending

    def get_request_code(self) -> str:
        """获取当前设备的 8 位动态随机申请码 (如 'C7MR-Y7S6')"""
        self._ensure_pending_nonce()
        return encode_request_code(self.hw_hash, self.pending_nonce)

    def check_license(self) -> tuple:
        """
        核心授权状态检查
        :return: (is_valid: bool, status_code: str, details: dict)
        """
        self._ensure_pending_nonce()
        store = self._read_storage()
        now_ts = int(time.time())
        req_code = self.get_request_code()

        details = {
            "machine_code": self.machine_code,
            "hw_hash": self.hw_hash,
            "hw_hex": f"{self.hw_hash:03X}",
            "request_code": req_code,
            "code": store.get("code", ""),
            "remaining_runs": "无限制",
            "expire_timestamp": store.get("expire_timestamp", 0),
            "remaining_days": "永久有效",
            "expire_date_str": "永久有效",
            "activated_at_str": ""
        }

        if not store or "code" not in store or not store["code"]:
            return False, "NO_LICENSE", details

        # 1. 验证时钟防回拨: 当前时间不能早于最后一次记录的时间戳 (容忍 60 秒误差)
        last_run = store.get("last_run_timestamp", 0)
        if last_run > 0 and now_ts < (last_run - 60):
            return False, "CLOCK_TAMPERED", details

        # 2. 验证机器特征绑定
        stored_hw = store.get("hw_hash", 0)
        if stored_hw != 0 and stored_hw != self.hw_hash:
            return False, "MACHINE_MISMATCH", details

        # 3. 统计有效时间与剩余天数 (支持 0.5 天/小时级粒度)
        expire_ts = store.get("expire_timestamp", -1)
        if expire_ts != -1:
            remaining_seconds = expire_ts - now_ts
            if remaining_seconds <= 0:
                details["remaining_days"] = "已过期"
                details["expire_date_str"] = datetime.fromtimestamp(expire_ts).strftime("%Y-%m-%d %H:%M")
                return False, "EXPIRED", details

            days = remaining_seconds // 86400
            hours = (remaining_seconds % 86400) // 3600
            minutes = (remaining_seconds % 3600) // 60
            if days > 0:
                details["remaining_days"] = f"{days} 天 {hours} 小时"
            elif hours > 0:
                details["remaining_days"] = f"{hours} 小时 {minutes} 分钟"
            else:
                details["remaining_days"] = f"{minutes} 分钟"
            details["expire_date_str"] = datetime.fromtimestamp(expire_ts).strftime("%Y-%m-%d %H:%M")
        else:
            details["remaining_days"] = "永久有效"
            details["expire_date_str"] = "永久有效"

        # 4. 统计与核验启动次数限制
        max_runs = store.get("max_runs", -1)
        used_runs = store.get("used_runs", 0)
        if max_runs != -1:
            remaining_runs = max_runs - used_runs
            if remaining_runs <= 0:
                details["remaining_runs"] = "已耗尽 (0 次)"
                return False, "EXHAUSTED", details
            details["remaining_runs"] = f"{remaining_runs} 次"
        else:
            details["remaining_runs"] = "无限制"

        act_ts = store.get("activated_at", 0)
        if act_ts > 0:
            details["activated_at_str"] = datetime.fromtimestamp(act_ts).strftime("%Y-%m-%d %H:%M")

        return True, "VALID", details

    def record_startup(self) -> bool:
        """刷新防回拨安全时间戳并累加启动次数"""
        store = self._read_storage()
        if not store:
            return False

        now_ts = int(time.time())
        store["last_run_timestamp"] = now_ts
        if store.get("max_runs", -1) != -1:
            store["used_runs"] = store.get("used_runs", 0) + 1
        return self._write_storage(store)

    def activate(self, code_str: str) -> tuple:
        """
        使用授权激活码激活或续期
        【关键特性：不能二次激活程序】
        1. 必须匹配当前设备的 pending_nonce
        2. 激活成功立即销毁旧 Nonce，强制翻转生成新 Nonce
        3. 同一个激活码永久作废，绝不可能再次激活
        """
        dec = decode_license(code_str)
        if not dec["valid"]:
            return False, dec["error"]

        target_hw = dec["hw_hash"]
        if target_hw != 0 and target_hw != self.hw_hash:
            return False, f"该激活码绑定的设备硬件 (#MC-{target_hw:03X}) 与本机 (#MC-{self.hw_hash:03X}) 不符！"

        self._ensure_pending_nonce()
        store = self._read_storage()
        consumed_codes = store.get("consumed_codes", [])
        consumed_nonces = store.get("consumed_nonces", [])

        lic_nonce = dec["nonce"]

        # 核心防二次激活 1: 必须匹配当前设备待激活的 pending_nonce
        if lic_nonce != self.pending_nonce:
            return False, "❌ 该激活码已失效（当前设备随机码已变更，不可二次重复激活程序）！"

        # 核心防二次激活 2: 历史已核销黑名单检测
        raw_code = dec.get("raw_code", dec["code"].replace("-", ""))
        if raw_code in consumed_codes or dec["code"] in consumed_codes or lic_nonce in consumed_nonces:
            return False, "❌ 该授权激活码已被核销使用过，已作废失效，不能二次激活！"

        now_ts = int(time.time())
        duration_days = dec["duration_days"]
        max_runs = dec["max_runs"]

        if duration_days == -1:
            new_expire = -1
        else:
            new_expire = now_ts + int(duration_days * 86400)

        if max_runs == -1:
            new_max_runs = -1
            new_used_runs = 0
        else:
            new_max_runs = max_runs
            new_used_runs = 0

        # 加入核销清单
        consumed_codes.append(raw_code)
        consumed_codes.append(dec["code"])
        consumed_nonces.append(lic_nonce)

        # 【核心安全防线】：激活成功瞬间，立即翻转生成下一代全新的随机 Nonce！
        # 使当前激活码所绑定的 Nonce 在本机彻底成为历史，旧码在物理与逻辑上均不可二次激活！
        next_nonce = self._generate_new_nonce()
        self.pending_nonce = next_nonce

        new_data = {
            "code": dec["code"],
            "hw_hash": target_hw,
            "max_runs": new_max_runs,
            "used_runs": new_used_runs,
            "expire_timestamp": new_expire,
            "last_run_timestamp": now_ts,
            "activated_at": now_ts,
            "duration_label": dec["duration_label"],
            "runs_label": dec["runs_label"],
            "pending_nonce": next_nonce,
            "consumed_codes": list(set(consumed_codes))[-1000:],
            "consumed_nonces": list(set(consumed_nonces))[-1000:]
        }

        if self._write_storage(new_data):
            msg = f"激活成功！已充值时长：{dec['duration_label']}，授权次数：{dec['runs_label']}"
            return True, msg
        else:
            return False, "写入授权凭证失败，请检查磁盘读写权限"


# 全局单例
license_guard = LicenseGuard()
