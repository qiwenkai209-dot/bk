# -*- coding: utf-8 -*-
"""
VisualCast U盘即插即用素材热更新模块
- 后台守护线程实时轮询 Windows 可移动驱动器 (DRIVE_REMOVABLE)
- 标准 7 大分类目录对齐：待机、音乐、图片、视频、文档、网页、流码
- 待机文件夹以 U 盘为主，先清空本地待机旧素材后再全新拷入 (带非空安全防误删事务)
- 其他分类目录自动按对应文件夹增量镜像同步
- 持续内容指纹检测机制：U 盘不拔出时拷入新素材，秒级自动探测并上传同步
- 生成实时事件通知供大屏端与 Web 控制后台弹出同步提示并立即自动开播
"""

import os
import sys
import time
import string
import shutil
import ctypes
import threading
import collections
from logger_service import sys_logger, log_event

# 标准 6 大分类目录定义与别名映射 (本地 media 统一按这 6 大目录存放)
STANDARD_CATEGORIES = {
    '待机': ['待机', '待机文件夹', 'standby', 'Standby', 'idle', 'Idle', '待机素材', '休眠', 'daocji', 'daiji'],
    '视频': ['视频', '视频文件夹', 'video', 'videos', 'Video', 'Videos', 'shipin', 'movie', 'film'],
    '图片': ['图片', '图片文件夹', 'images', 'image', 'Images', 'Image', 'pic', 'Photo', 'tupian', 'img'],
    '音乐': ['音乐', '音频', '音乐文件夹', 'music', 'Music', 'audio', 'Audio', 'yinyue', 'sound'],
    '文档': ['文档', '文档文件夹', 'ppt', 'pdf', 'pptx', 'ppt_pdf', 'ppt-pdf', 'PPT_PDF', 'PPT与PDF', '演示', '幻灯片', 'wendang', 'doc'],
    '网页_流码': ['网页_流码', '网页流码', '网页\\流码', '网页/流码', '网页', '流码', 'web', 'stream', 'html', 'url', 'wangye', 'liuma', '直播流', 'm3u8']
}

SUPPORTED_EXTS = {
    'video': ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.ts'],
    'image': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'],
    'audio': ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.wma', '.m4a'],
    'doc': ['.pptx', '.ppt', '.pdf', '.doc', '.docx', '.wps', '.dps', '.et', '.xls', '.xlsx'],
    'web': ['.html', '.htm'],
    'stream': ['.m3u8', '.txt', '.url'],
    'subtitle': ['.srt', '.vtt']
}

ALL_EXTS = set()
for exts in SUPPORTED_EXTS.values():
    ALL_EXTS.update(exts)


def get_category_by_ext(ext):
    """根据文件扩展名智能归类到标准 6 大分类目录"""
    ext = ext.lower()
    if ext in ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.ts']:
        return '视频'
    elif ext in ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']:
        return '图片'
    elif ext in ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.wma', '.m4a']:
        return '音乐'
    elif ext in ['.ppt', '.pptx', '.pdf', '.doc', '.docx', '.wps', '.dps', '.et', '.xls', '.xlsx']:
        return '文档'
    elif ext in ['.html', '.htm', '.m3u8', '.txt', '.url']:
        return '网页_流码'
    return '待机'


def ensure_usb_standard_folders(drive_path):
    """
    核心规范：在 U 盘直接自动生成标准 6 大分类文件夹结构：
    素材/ (待机-视频-图片-音乐-文档-网页_流码)
    并在 U 盘根目录下也生成相应文件夹作为防呆入口
    """
    if not drive_path or not os.path.exists(drive_path):
        return False
    try:
        # 1. 创建主文件夹 "素材"
        sucai_dir = os.path.join(drive_path, "素材")
        os.makedirs(sucai_dir, exist_ok=True)

        sub_folders = ["待机", "视频", "图片", "音乐", "文档", "网页_流码"]
        for sub in sub_folders:
            # 在 素材/ 目录下创建
            os.makedirs(os.path.join(sucai_dir, sub), exist_ok=True)
            # 在 U 盘根目录下创建
            os.makedirs(os.path.join(drive_path, sub), exist_ok=True)

        # 写入使用说明文档
        readme_path = os.path.join(sucai_dir, "【VisualCast_U盘素材使用规范】.txt")
        if not os.path.exists(readme_path):
            with open(readme_path, "w", encoding="utf-8") as f:
                f.write(
                    "========================================================\r\n"
                    "VisualCast 展馆智能播控系统 - U盘素材使用规范\r\n"
                    "========================================================\r\n"
                    "系统已自动为您在 U 盘生成标准分类文件夹，请按需放入素材：\r\n\r\n"
                    "1. 【待机】文件夹：\r\n"
                    "   - 存放展馆待机时轮播播放的高清视频或图片 (MP4, JPG, PNG 等)\r\n"
                    "   - 插入设备后，大屏将清空旧待机内容并全新覆盖导入，立即自动开播！\r\n\r\n"
                    "2. 【音乐】文件夹：\r\n"
                    "   - 存放 MP3, WAV, FLAC, AAC 等背景音频与音效文件\r\n\r\n"
                    "3. 【图片】文件夹：\r\n"
                    "   - 存放 JPG, PNG, WEBP, BMP, GIF 等展示图片\r\n\r\n"
                    "4. 【视频】文件夹：\r\n"
                    "   - 存放 MP4, MKV, MOV, AVI, TS 等高清视频文件\r\n\r\n"
                    "5. 【文档】文件夹：\r\n"
                    "   - 存放 PPT, PPTX, PDF, DOC 等演示文档\r\n\r\n"
                    "6. 【网页_流码】文件夹：\r\n"
                    "   - 存放包含外部网页网址 (如 http://...) 或直播流地址 (RTSP/RTMP/M3U8) 的 .txt 文件\r\n"
                    "========================================================\r\n"
                )
        return True
    except Exception as e:
        print(f"[USBSync] 创建 U 盘标准文件夹异常: {e}")
        return False


class USBSyncManager:
    def __init__(self, target_media_dir, on_synced_callback=None, on_start_callback=None):
        self.target_media_dir = target_media_dir
        self.on_synced_callback = on_synced_callback
        self.on_start_callback = on_start_callback
        self.known_drives = set()
        self.drive_fingerprints = {}  # drive -> fingerprint
        self.is_running = False
        self.lock = threading.Lock()
        self.latest_sync_event = None
        self.thread = None

    def get_active_removable_drives(self):
        """检测当前系统所有可读写的物理可移动驱动器及外接移动存储"""
        drives = []
        try:
            # 屏蔽 Windows 系统由于驱动器未准备好而弹出的错误对话框或内核长挂起
            ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x8000)
            bitmask = ctypes.windll.kernel32.GetLogicalDrives()
            for letter in string.ascii_uppercase:
                if bitmask & 1:
                    drive_str = f"{letter}:\\"
                    dtype = ctypes.windll.kernel32.GetDriveTypeW(drive_str)
                    # DRIVE_REMOVABLE = 2
                    is_candidate = (dtype == 2)
                    # 若为移动硬盘 (DRIVE_FIXED = 3 且非 C 盘)，检查是否存在常见素材目录
                    if not is_candidate and dtype == 3 and letter != 'C':
                        try:
                            if any(os.path.exists(os.path.join(drive_str, sub)) for sub in ['media', '素材', 'Media', '待机', '视频', '图片']):
                                is_candidate = True
                        except Exception:
                            is_candidate = False

                    if is_candidate:
                        sectors = ctypes.wintypes.DWORD()
                        bytes_per_sec = ctypes.wintypes.DWORD()
                        free_clusters = ctypes.wintypes.DWORD()
                        total_clusters = ctypes.wintypes.DWORD()
                        has_media = ctypes.windll.kernel32.GetDiskFreeSpaceW(
                            drive_str,
                            ctypes.byref(sectors),
                            ctypes.byref(bytes_per_sec),
                            ctypes.byref(free_clusters),
                            ctypes.byref(total_clusters)
                        )
                        if has_media:
                            try:
                                os.listdir(drive_str)
                                drives.append(drive_str)
                            except Exception:
                                pass
                bitmask >>= 1
        except Exception:
            pass
        return drives

    def _calc_drive_fingerprint(self, drive_path):
        """
        快速计算 U 盘内素材文件的轻量状态摘要
        用于在 U 盘持续插在电脑上时，秒级检测用户向 U 盘复制新素材的变动
        """
        summary_parts = []
        try:
            for root, dirs, files in os.walk(drive_path):
                # 排除系统回收站和垃圾目录
                dirs[:] = [d for d in dirs if not d.startswith('.') and d.lower() not in ('$recycle.bin', 'system volume information', 'lost.dir', 'android')]
                for f in files:
                    if f.startswith('.') or f.endswith('.trans_tmp') or f.startswith('~$'):
                        continue
                    ext = os.path.splitext(f)[1].lower()
                    if ext in ALL_EXTS:
                        fp = os.path.join(root, f)
                        try:
                            st = os.stat(fp)
                            summary_parts.append(f"{f}:{st.st_size}:{int(st.st_mtime)}")
                        except Exception:
                            pass
        except Exception:
            pass
        return ";".join(sorted(summary_parts))

    def start(self):
        """启动后台扫描守护线程"""
        if self.is_running:
            return
        self.is_running = True
        print("[USBSync] U盘热插入素材检测引擎已就绪 (持续增量心跳扫描已开启)")
        self.thread = threading.Thread(target=self._scan_loop, daemon=True)
        self.thread.start()

    def sync_all_now(self):
        """手动即时扫描当前所有接入的 U 盘"""
        drives = self.get_active_removable_drives()
        if not drives:
            return {
                "status": "warn",
                "message": "未检测到接入的 U 盘设备，请先插入包含素材的 U 盘",
                "drives": [],
                "synced_files": [],
                "standby_updated": False
            }

        synced_total = []
        standby_updated_any = False
        has_media_root_any = False
        for d in drives:
            res, sb_up = self._sync_drive(d)
            if res:
                synced_total.extend(res)
                has_media_root_any = True
            if sb_up:
                standby_updated_any = True
                has_media_root_any = True
            if not has_media_root_any:
                try:
                    entries = [e.strip().lower() for e in os.listdir(d)]
                    if any('素材' in e or '待机' in e or 'media' in e or 'video' in e or 'image' in e for e in entries):
                        has_media_root_any = True
                except Exception:
                    pass

        if not has_media_root_any:
            msg = f"🎉 已检测到 U 盘 [{', '.join(drives)}]！已自动为您生成【素材/待机/音乐/图片/视频/文档/网页/流码】标准文件夹，随时放入素材即插即用！"
            st = "ok"
        elif synced_total or standby_updated_any:
            msg = f"U盘素材更新完成！共导入 {len(synced_total)} 个素材" + ("（待机文件夹已清空并全新覆盖）" if standby_updated_any else "")
            st = "ok"
        else:
            msg = "U盘素材扫描完成，本地素材已为最新，无需重复导入"
            st = "ok"

        return {
            "status": st,
            "message": msg,
            "drives": drives,
            "synced_files": synced_total,
            "standby_updated": standby_updated_any
        }

    def stop(self):
        self.is_running = False

    def _scan_loop(self):
        while self.is_running:
            try:
                active_drives = set(self.get_active_removable_drives())

                # 移除已拔出的驱动器记录
                removed_drives = set(self.drive_fingerprints.keys()) - active_drives
                for rd in removed_drives:
                    self.drive_fingerprints.pop(rd, None)

                for drive in active_drives:
                    is_new = (drive not in self.known_drives)
                    current_fp = self._calc_drive_fingerprint(drive)
                    last_fp = self.drive_fingerprints.get(drive)

                    # 如果是新盘，或者已知 U 盘检测到内容指纹发生了变动（放入了新素材或文件被修改）
                    if is_new or (current_fp and current_fp != last_fp):
                        print(f"[USBSync] 检测到 U 盘 [{drive}] {'新接入' if is_new else '素材内容新增/更新'}，立即启动自动对齐同步...")
                        if self.on_start_callback:
                            try:
                                self.on_start_callback({"action": "start", "drive": drive, "is_new": is_new})
                            except Exception as ex_st:
                                print(f"[USBSync] 执行开始同步回调异常: {ex_st}")
                        time.sleep(1.0)
                        synced, sb_up = self._sync_drive(drive)
                        # 更新内容指纹
                        self.drive_fingerprints[drive] = self._calc_drive_fingerprint(drive)

                self.known_drives = active_drives
            except Exception as e:
                print(f"[USBSync] 扫描检测发生异常: {e}")
            time.sleep(3.0)

    def _copy_file_atomic(self, src_file, dst_file):
        """原子化文件拷贝：带临时后缀并在写入完成后更名"""
        tmp_dst = dst_file + ".trans_tmp"
        shutil.copy2(src_file, tmp_dst)
        if os.path.exists(dst_file):
            try:
                os.remove(dst_file)
            except Exception:
                pass
        os.rename(tmp_dst, dst_file)

    def _sync_drive(self, drive_path):
        """
        按用户最新业务指令严格执行 U 盘素材同步：
        1. 自动在 U 盘生成标准分类文件夹 (素材/待机/音乐/图片/视频/文档/网页/流码)；
        2. 扫描素材文件夹并与本地进行镜像同步；
        3. U 盘待机文件：先清空删除本地原有待机文件，再全新导入更新 U 盘待机素材。
        """
        # 1. 确保在 U 盘直接创建好 7 大分类规范文件夹
        ensure_usb_standard_folders(drive_path)

        # 2. 预先确保本地 7 大标准目录完整存在
        for std_cat in STANDARD_CATEGORIES.keys():
            os.makedirs(os.path.join(self.target_media_dir, std_cat), exist_ok=True)

        discovered_standby_files = []
        discovered_cat_files = collections.defaultdict(list)  # std_cat -> list of (fname, fullpath)
        discovered_loose_files = []  # list of (fname, fullpath)

        # 递归扫描 U 盘中的所有媒体文件
        def collect_files_from_dir(dir_path):
            result = []
            try:
                for root, dirs, files in os.walk(dir_path):
                    dirs[:] = [d for d in dirs if not d.startswith('.') and d.lower() not in ('$recycle.bin', 'system volume information', 'lost.dir', 'android')]
                    for f in files:
                        if f.startswith('.') or f.endswith('.trans_tmp') or f.startswith('~$'):
                            continue
                        ext = os.path.splitext(f)[1].lower()
                        if ext in ALL_EXTS:
                            fp = os.path.join(root, f)
                            if os.path.isfile(fp) and os.path.getsize(fp) > 0:
                                result.append((f, fp))
            except Exception:
                pass
            return result

        # A. 扫描“素材/”主文件夹与根目录下的 7 大分类
        sucai_dir = os.path.join(drive_path, "素材")
        search_roots = [sucai_dir, drive_path] if os.path.exists(sucai_dir) else [drive_path]

        for s_root in search_roots:
            if not os.path.exists(s_root) or not os.path.isdir(s_root):
                continue
            try:
                entries = os.listdir(s_root)
            except Exception:
                continue

            for entry in entries:
                if entry.startswith('.') or entry.lower() in ('$recycle.bin', 'system volume information', 'lost.dir', 'android'):
                    continue
                full = os.path.join(s_root, entry)
                if os.path.isdir(full):
                    # 如果等于 "素材" 文件夹自身，跳过避免重复
                    if s_root == drive_path and entry == "素材":
                        continue
                    clean = entry.strip().lower().replace(" ", "").replace("_", "").replace("-", "")

                    # 1. 待机匹配
                    if any(kw in clean for kw in ['待机', 'standby', 'idle', '休眠', 'daocji', 'daiji']):
                        files = collect_files_from_dir(full)
                        discovered_standby_files.extend(files)
                        continue

                    # 2. 7 大标准分类匹配
                    matched_cat = None
                    for cat, aliases in STANDARD_CATEGORIES.items():
                        if cat == '待机':
                            continue
                        if any(a.lower().replace(" ", "").replace("_", "") in clean for a in aliases):
                            matched_cat = cat
                            break

                    if matched_cat:
                        files = collect_files_from_dir(full)
                        discovered_cat_files[matched_cat].extend(files)
                    else:
                        # 其它非标准子目录，继续收集其中的文件作为散落素材
                        files = collect_files_from_dir(full)
                        discovered_loose_files.extend(files)

                elif os.path.isfile(full):
                    ext = os.path.splitext(entry)[1].lower()
                    if ext in ALL_EXTS and os.path.getsize(full) > 0:
                        discovered_loose_files.append((entry, full))

        if not discovered_standby_files and not discovered_cat_files and not discovered_loose_files:
            print(f"[USBSync] U 盘 [{drive_path}] 深度扫描未发现多媒体素材")
            return [], False

        synced_files = []
        standby_updated = False

        # 3. 【待机文件夹】处理：以 U 盘为主，先彻底清空删除本地原有待机文件，再全新拷入
        if discovered_standby_files:
            # 去重
            seen_sb = set()
            unique_sb_files = []
            for fn, fp in discovered_standby_files:
                if fn not in seen_sb:
                    seen_sb.add(fn)
                    unique_sb_files.append((fn, fp))

            local_standby_dir = os.path.join(self.target_media_dir, '待机')
            os.makedirs(local_standby_dir, exist_ok=True)
            print(f"[USBSync] 检测到 U 盘待机素材 ({len(unique_sb_files)} 个)，正在清空本地待机文件夹并全新导入更新...")

            # A. 彻底删除本地原有待机文件
            for old_f in os.listdir(local_standby_dir):
                old_p = os.path.join(local_standby_dir, old_f)
                if os.path.isfile(old_p):
                    try:
                        os.remove(old_p)
                        print(f"[USBSync] [待机覆盖] 已清空原有待机文件: {old_f}")
                    except Exception as ex:
                        print(f"[USBSync] 删除旧待机文件 {old_f} 失败: {ex}")

            # B. 全新拷贝导入 U 盘待机素材
            for fname, fpath in unique_sb_files:
                dst_path = os.path.join(local_standby_dir, fname)
                try:
                    self._copy_file_atomic(fpath, dst_path)
                    rel_name = f"待机/{fname}"
                    synced_files.append(rel_name)
                    print(f"[USBSync] [待机覆盖] 全新导入待机素材: {fname}")
                except Exception as ce:
                    print(f"[USBSync] 导入待机素材 {fname} 失败: {ce}")

            standby_updated = True

        # 4. 同步其他标准 6 大分类目录 (音乐、图片、视频、文档、网页、流码)
        for std_cat, cat_file_list in discovered_cat_files.items():
            local_cat_dir = os.path.join(self.target_media_dir, std_cat)
            os.makedirs(local_cat_dir, exist_ok=True)

            seen_cf = set()
            for fname, fpath in cat_file_list:
                if fname in seen_cf:
                    continue
                seen_cf.add(fname)

                dst_file = os.path.join(local_cat_dir, fname)
                need_copy = True
                if os.path.exists(dst_file):
                    try:
                        src_stat = os.stat(fpath)
                        dst_stat = os.stat(dst_file)
                        if src_stat.st_size == dst_stat.st_size and abs(src_stat.st_mtime - dst_stat.st_mtime) < 2.0:
                            need_copy = False
                    except Exception:
                        pass

                if need_copy:
                    try:
                        self._copy_file_atomic(fpath, dst_file)
                        rel_name = f"{std_cat}/{fname}"
                        synced_files.append(rel_name)
                        print(f"[USBSync] [{std_cat}] 导入更新素材: {fname}")
                    except Exception as ce:
                        print(f"[USBSync] 拷贝素材 {fname} 失败: {ce}")

        # 5. 散落的多媒体文件智能归类导入 (直接存放在 U 盘根目录或素材根目录下的文件)
        if discovered_loose_files:
            seen_loose = set()
            for fname, fpath in discovered_loose_files:
                if fname in seen_loose:
                    continue
                seen_loose.add(fname)

                target_cat = get_category_by_ext(os.path.splitext(fname)[1])
                target_dir = os.path.join(self.target_media_dir, target_cat)
                os.makedirs(target_dir, exist_ok=True)
                dst_file = os.path.join(target_dir, fname)

                need_copy = True
                if os.path.exists(dst_file):
                    try:
                        src_stat = os.stat(fpath)
                        dst_stat = os.stat(dst_file)
                        if src_stat.st_size == dst_stat.st_size and abs(src_stat.st_mtime - dst_stat.st_mtime) < 2.0:
                            need_copy = False
                    except Exception:
                        pass

                if need_copy:
                    try:
                        self._copy_file_atomic(fpath, dst_file)
                        synced_files.append(f"{target_cat}/{fname}")
                        print(f"[USBSync] 散落文件智能归入 [{target_cat}]: {fname}")
                    except Exception as ce:
                        print(f"[USBSync] 导入散落文件 {fname} 失败: {ce}")

        # 6. 同步事件打包
        if synced_files or standby_updated:
            event = {
                "drive": drive_path,
                "count": len(synced_files),
                "files": synced_files,
                "standby_updated": standby_updated,
                "timestamp": time.time(),
                "time_str": time.strftime("%H:%M:%S")
            }
            with self.lock:
                self.latest_sync_event = event

            print(f"[USBSync] 成功从 U 盘 [{drive_path}] 完成素材同步！共处理 {len(synced_files)} 个素材，待机文件夹覆盖更新={standby_updated}")
            log_event("USB_SYNC", f"U盘 [{drive_path}] 热更同步完成: 处理素材={len(synced_files)}个, 待机素材覆盖更新={standby_updated}")
            if self.on_synced_callback:
                try:
                    self.on_synced_callback(event)
                except Exception as ex:
                    print(f"[USBSync] 执行回调通知异常: {ex}")

        return synced_files, standby_updated

    def get_latest_sync_event(self):
        with self.lock:
            return dict(self.latest_sync_event) if self.latest_sync_event else None
