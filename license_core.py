# -*- coding: utf-8 -*-
"""
VisualCast 动态随机申请码与一次性授权核心引擎 (License Core v3)
===================================================================
架构特性:
1. 动态设备随机申请码体系 (8位字符, 格式: XXXX-XXXX):
   - 包含: [硬件特征指纹 12-bit] [当前设备激活代际随机 Nonce 16-bit] [HMAC 校验和 12-bit] = 40 bits
   - 每次程序未激活或成功激活后，都会在本地重新生成全新的硬件真随机 Nonce。
   - 即使同一台电脑、相同硬件，每次未激活时对外展示的随机码都截然不同！
2. 一次性授权激活码体系 (12位字符, 格式: XXXX-XXXX-XXXX):
   - 包含: [硬件特征 12-bit] [目标随机 Nonce 16-bit] [有效期时长 5-bit] [启动次数 5-bit] [HMAC-SHA256 签名 22-bit] = 60 bits
   - 经过 60-bit 全局置换位混淆，具备极高防伪与雪崩防护能力。
3. 严格杜绝二次激活 (Zero Replay / Single-Use Guard):
   - 授权激活码必须与当前客户端设备持有的 pending_nonce 100% 精确一致。
   - 客户端激活成功后，立即销毁当前 Nonce 并强制翻转生成新 Nonce，旧激活码当场永久失效，
     绝无可能在同机或它机二次使用！
   - 即使删除配置文件或重装，因新生成的随机申请码 Nonce 改变，旧授权码同样无法再次激活！
"""

import hmac
import hashlib
import struct
import os

# 去除容易混淆字符 (0/O, 1/I) 的 32 进制安全字符集
CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CHAR_TO_VAL = {c: i for i, c in enumerate(CHARSET)}

# 内部签名密钥盐值 (防伪造，工业级对称私钥)
SECRET_SALT = b"VisualCast_License_Salt_v3_2026_RandomNonceSecure!"

# 时长预设映射表 (天数, -1 表示永久)
DURATION_MAP = {
    11: ("0.5天 (半天/12小时)", 0.5),
    0: ("1天 (试用)", 1),
    1: ("3天 (试用)", 3),
    2: ("7天 (1周)", 7),
    3: ("15天 (半月)", 15),
    4: ("30天 (1个月)", 30),
    5: ("60天 (2个月)", 60),
    6: ("90天 (1季度)", 90),
    7: ("180天 (半年)", 180),
    8: ("365天 (1年)", 365),
    9: ("730天 (2年)", 730),
    10: ("1095天 (3年)", 1095),
    31: ("永久有效", -1)
}

# 启动次数预设映射表 (次数, -1 表示无限制)
RUNS_MAP = {
    0: ("5 次", 5),
    1: ("10 次", 10),
    2: ("20 次", 20),
    3: ("50 次", 50),
    4: ("100 次", 100),
    5: ("200 次", 200),
    6: ("500 次", 500),
    7: ("1000 次", 1000),
    8: ("2000 次", 2000),
    9: ("5000 次", 5000),
    10: ("10000 次", 10000),
    31: ("无限制", -1)
}

# ----------------- 40-bit 设备随机申请码置换表 (8位字符, XXXX-XXXX) -----------------
SHUFFLE_P_40 = [
    31, 7, 23, 15, 39, 3, 19, 11, 27, 35,
    0, 16, 8, 24, 32, 4, 20, 12, 28, 36,
    1, 17, 9, 25, 33, 5, 21, 13, 29, 37,
    2, 18, 10, 26, 34, 6, 22, 14, 30, 38
]
UNSHUFFLE_P_40 = [0] * 40
for _i, _p in enumerate(SHUFFLE_P_40):
    UNSHUFFLE_P_40[_p] = _i

# ----------------- 60-bit 授权激活码置换表 (12位字符, XXXX-XXXX-XXXX) -----------------
SHUFFLE_P_60 = [
    13, 50, 27, 4, 41, 18, 55, 32, 9, 46, 23, 0, 37, 14, 51, 28, 5, 42, 19, 56,
    33, 10, 47, 24, 1, 38, 15, 52, 29, 6, 43, 20, 57, 34, 11, 48, 25, 2, 39, 16,
    53, 30, 7, 44, 21, 58, 35, 12, 49, 26, 3, 40, 17, 54, 31, 8, 45, 22, 59, 36
]
UNSHUFFLE_P_60 = [0] * 60
for _i, _p in enumerate(SHUFFLE_P_60):
    UNSHUFFLE_P_60[_p] = _i


def _permute_bits(val: int, perm: list) -> int:
    """根据置换表变换整数的二进制位"""
    result = 0
    for new_pos, old_pos in enumerate(perm):
        bit = (val >> old_pos) & 1
        result |= (bit << new_pos)
    return result


def _calc_req_checksum(hw_hash: int, nonce: int) -> int:
    """计算 8 位设备随机申请码的 12-bit HMAC 校验和"""
    payload = struct.pack(">HH", hw_hash & 0x0FFF, nonce & 0xFFFF)
    digest = hmac.new(SECRET_SALT, b"REQ:" + payload, hashlib.sha256).digest()
    raw = (digest[0] << 8) | digest[1]
    return raw & 0x0FFF


def encode_request_code(hw_hash: int, nonce: int) -> str:
    """
    生成 8 位设备随机申请码 (格式: XXXX-XXXX)
    :param hw_hash: 12 bits 硬件特征码 (0 ~ 4095)
    :param nonce: 16 bits 硬件真随机数 (0 ~ 65535)
    :return: 格式如 'C7MR-Y7S6'
    """
    hw_hash &= 0x0FFF
    nonce &= 0xFFFF
    checksum = _calc_req_checksum(hw_hash, nonce)
    # 打包 40 bits
    raw_num = (hw_hash << 28) | (nonce << 12) | checksum
    shuffled_num = _permute_bits(raw_num, SHUFFLE_P_40)

    chars = []
    tmp = shuffled_num
    for _ in range(8):
        chars.append(CHARSET[tmp & 0x1F])
        tmp >>= 5
    s = "".join(reversed(chars))
    return f"{s[:4]}-{s[4:]}"


def decode_request_code(code_str: str) -> dict:
    """
    解码并校验设备随机申请码
    :param code_str: 字符串，支持带 'RC-' 前缀或横杠空格
    :return: dict 包含 valid, hw_hash, nonce, code, error
    """
    cleaned = (
        code_str.strip()
        .upper()
        .replace("-", "")
        .replace(" ", "")
        .replace("RC-", "")
        .replace("RC", "")
    )
    if len(cleaned) != 8:
        return {"valid": False, "error": f"随机申请码须为 8 位字符，当前为 {len(cleaned)} 位"}

    shuffled_num = 0
    for c in cleaned:
        if c not in CHAR_TO_VAL:
            return {"valid": False, "error": f"申请码包含非法字符 '{c}'"}
        shuffled_num = (shuffled_num << 5) | CHAR_TO_VAL[c]

    raw_num = _permute_bits(shuffled_num, UNSHUFFLE_P_40)
    checksum = raw_num & 0x0FFF
    nonce = (raw_num >> 12) & 0xFFFF
    hw_hash = (raw_num >> 28) & 0x0FFF

    expected = _calc_req_checksum(hw_hash, nonce)
    if checksum != expected:
        return {"valid": False, "error": "随机申请码校验未通过 (非本系统生成或输入有误)"}

    return {
        "valid": True,
        "hw_hash": hw_hash,
        "nonce": nonce,
        "hw_hex": f"{hw_hash:03X}",
        "code": f"{cleaned[:4]}-{cleaned[4:]}",
        "error": None
    }


def _calc_lic_checksum(hw_hash: int, nonce: int, duration_code: int, runs_code: int) -> int:
    """计算 12 位授权激活码的 22-bit HMAC-SHA256 高强度防伪签名"""
    payload = struct.pack(">HHBB", hw_hash & 0x0FFF, nonce & 0xFFFF, duration_code & 0x1F, runs_code & 0x1F)
    digest = hmac.new(SECRET_SALT, b"LIC:" + payload, hashlib.sha256).digest()
    raw = (digest[0] << 16) | (digest[1] << 8) | digest[2]
    return raw & 0x3FFFFF  # 22 bits


def encode_license(hw_hash: int, nonce: int, duration_code: int, runs_code: int) -> str:
    """
    生成 12 位全新一次性授权激活码 (格式: XXXX-XXXX-XXXX)
    :param hw_hash: 目标设备硬件哈希 (12 bits)
    :param nonce: 目标设备当前代际的随机 Nonce (16 bits)
    :param duration_code: 有效期代码 (5 bits, 0~31)
    :param runs_code: 启动次数代码 (5 bits, 0~31)
    :return: 格式如 '65NP-R9UW-WFGV'
    """
    hw_hash &= 0x0FFF
    nonce &= 0xFFFF
    duration_code &= 0x1F
    runs_code &= 0x1F

    checksum = _calc_lic_checksum(hw_hash, nonce, duration_code, runs_code)
    # 打包 60 bits: [HW 12b] [Nonce 16b] [Duration 5b] [Runs 5b] [Checksum 22b]
    raw_num = (hw_hash << 48) | (nonce << 32) | (duration_code << 27) | (runs_code << 22) | checksum
    shuffled_num = _permute_bits(raw_num, SHUFFLE_P_60)

    chars = []
    tmp = shuffled_num
    for _ in range(12):
        chars.append(CHARSET[tmp & 0x1F])
        tmp >>= 5
    s = "".join(reversed(chars))
    return f"{s[:4]}-{s[4:8]}-{s[8:]}"


def decode_license(code_str: str) -> dict:
    """
    解码并校验 12 位授权激活码 (同时自适应识别旧版输入并给出友好引导)
    :param code_str: 字符串 (支持带横杠，大小写自适应)
    :return: dict 包含 valid, hw_hash, nonce, duration_days, max_runs, error
    """
    cleaned = code_str.strip().upper().replace("-", "").replace(" ", "")

    if len(cleaned) == 12:
        shuffled_num = 0
        for c in cleaned:
            if c not in CHAR_TO_VAL:
                return {"valid": False, "error": f"授权激活码包含非法字符 '{c}'"}
            shuffled_num = (shuffled_num << 5) | CHAR_TO_VAL[c]

        raw_num = _permute_bits(shuffled_num, UNSHUFFLE_P_60)
        checksum = raw_num & 0x3FFFFF
        runs_code = (raw_num >> 22) & 0x1F
        duration_code = (raw_num >> 27) & 0x1F
        nonce = (raw_num >> 32) & 0xFFFF
        hw_hash = (raw_num >> 48) & 0x0FFF

        # 优先调用通用加密机全能双向解码引擎 (自适应 VisualCast、VisualCast_Native、全局默认及高低位排布)
        try:
            from universal_license_core import decode_license as decode_univ_license
            univ_res = decode_univ_license(cleaned, product_id="VisualCast")
            if univ_res.get("valid"):
                return {
                    "valid": True,
                    "version": "v3_onetime_random",
                    "code": univ_res["code"],
                    "raw_code": cleaned,
                    "hw_hash": univ_res["hw_hash"],
                    "hw_hex": f"{univ_res['hw_hash']:03X}",
                    "nonce": univ_res["nonce"],
                    "is_universal": (univ_res["hw_hash"] == 0),
                    "duration_code": univ_res["duration_code"],
                    "duration_days": univ_res["duration_days"],
                    "duration_label": univ_res["duration_label"],
                    "runs_code": univ_res["runs_code"],
                    "max_runs": univ_res["max_runs"],
                    "runs_label": univ_res["runs_label"],
                    "error": None
                }
        except Exception:
            pass

        expected = _calc_lic_checksum(hw_hash, nonce, duration_code, runs_code)
        if checksum != expected:
            return {"valid": False, "error": "激活码防伪校验未通过 (非官方授权加密机生成或输错)"}

        duration_label, duration_days = DURATION_MAP.get(duration_code, (f"{duration_code} 代码", -1))
        runs_label, max_runs = RUNS_MAP.get(runs_code, (f"{runs_code} 代码", -1))

        formatted = f"{cleaned[:4]}-{cleaned[4:8]}-{cleaned[8:]}"
        return {
            "valid": True,
            "version": "v3_onetime_random",
            "code": formatted,
            "raw_code": cleaned,
            "hw_hash": hw_hash,
            "hw_hex": f"{hw_hash:03X}",
            "nonce": nonce,
            "is_universal": (hw_hash == 0),
            "duration_code": duration_code,
            "duration_days": duration_days,
            "duration_label": duration_label,
            "runs_code": runs_code,
            "max_runs": max_runs,
            "runs_label": runs_label,
            "error": None
        }

    elif len(cleaned) in (6, 8):
        return {
            "valid": False,
            "error": "系统已升级为一次性动态随机码授权体系，旧版授权码已失效，请向软件提供方提供当前的 8 位随机申请码获取 12 位激活码！"
        }
    else:
        return {
            "valid": False,
            "error": f"授权激活码须为 12 位字符 (XXXX-XXXX-XXXX)，当前输入为 {len(cleaned)} 位"
        }
