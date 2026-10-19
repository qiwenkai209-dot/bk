# -*- coding: utf-8 -*-
import ctypes
from ctypes import wintypes
import sys

def restore():
    user32 = ctypes.windll.user32
    # 切换当前线程到 WinSta0\default
    try:
        hwinsta = user32.OpenWindowStationW('WinSta0', False, 0x037F)
        if hwinsta:
            user32.SetProcessWindowStation(hwinsta)
        hdesk = user32.OpenDesktopW('default', 0, False, 0x01FF)
        if hdesk:
            user32.SetThreadDesktop(hdesk)
    except Exception:
        pass

    HWND_TOPMOST = -1
    SWP_SHOWWINDOW = 0x0040
    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SW_SHOW = 5

    # 1. 主任务栏
    main_tray = user32.FindWindowW("Shell_TrayWnd", None)
    if main_tray:
        user32.ShowWindow(main_tray, SW_SHOW)
        user32.SetWindowPos(main_tray, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
        user32.UpdateWindow(main_tray)

    # 2. 副任务栏
    def _enum_sec(h, l):
        buf = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(h, buf, 128)
        if buf.value == "Shell_SecondaryTrayWnd":
            user32.ShowWindow(h, SW_SHOW)
            user32.SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            user32.UpdateWindow(h)
        return 1

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(_enum_sec), 0)
    print("[√] 所有物理屏幕任务栏已成功恢复常驻并置顶刷新！")

if __name__ == '__main__':
    restore()
