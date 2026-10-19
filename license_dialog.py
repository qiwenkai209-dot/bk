# -*- coding: utf-8 -*-
"""
VisualCast 智能播控系统 - 授权激活拦截交互弹窗 (Tkinter 现代深色科技质感)
在主程序启动时若检测到未授权、过期、超次，将弹出本窗口引导用户使用 12 位激活码激活。
"""

import sys
import tkinter as tk
from tkinter import messagebox
from license_guard import license_guard


class LicenseActivationDialog:
    def __init__(self, status_code="NO_LICENSE", details=None):
        self.status_code = status_code
        self.details = details or {}
        self.activated_success = False

        self.root = tk.Tk()
        self.root.title("VisualCast 智能播控系统 - 授权激活中心")
        self.root.geometry("540x510")
        self.root.resizable(False, False)
        self.root.configure(bg="#0f141c")

        # 尝试置顶并居中显示
        self.root.attributes("-topmost", True)
        self._center_window()
        self._setup_ui()

    def _center_window(self):
        self.root.update_idletasks()
        w = 540
        h = 510
        ws = self.root.winfo_screenwidth()
        hs = self.root.winfo_screenheight()
        x = (ws - w) // 2
        y = (hs - h) // 2
        self.root.geometry(f"{w}x{h}+{x}+{y}")

    def _setup_ui(self):
        # 1. 顶部 Header
        header_frame = tk.Frame(self.root, bg="#161e2e", height=80)
        header_frame.pack(fill=tk.X, side=tk.TOP)
        header_frame.pack_propagate(False)

        title_lbl = tk.Label(
            header_frame,
            text="VisualCast 智能播控终端 - 商业授权中心",
            font=("Microsoft YaHei UI", 14, "bold"),
            fg="#ffffff",
            bg="#161e2e"
        )
        title_lbl.pack(anchor="w", padx=24, pady=(14, 2))

        # 状态描述
        status_text_map = {
            "NO_LICENSE": "⚠️ 软件尚未激活，请向软件提供方提供【随机申请码】获取激活码",
            "EXPIRED": "⚠️ 授权已到期，请向软件提供方提供【随机申请码】续期激活",
            "EXHAUSTED": "⚠️ 授权启动次数已耗尽，请向软件提供方提供【随机申请码】续期激活",
            "MACHINE_MISMATCH": "⚠️ 授权凭证与当前设备特征不匹配，请重新申请激活",
            "CLOCK_TAMPERED": "⚠️ 检测到系统时钟回退异常，请校正系统时间后重试"
        }
        sub_text = status_text_map.get(self.status_code, "⚠️ 软件需要商业授权激活")

        sub_lbl = tk.Label(
            header_frame,
            text=sub_text,
            font=("Microsoft YaHei UI", 9),
            fg="#f87171" if self.status_code != "NO_LICENSE" else "#38bdf8",
            bg="#161e2e"
        )
        sub_lbl.pack(anchor="w", padx=24)

        # 2. 中间卡片区域
        content_frame = tk.Frame(self.root, bg="#0f141c")
        content_frame.pack(fill=tk.BOTH, expand=True, padx=24, pady=16)

        # 随机申请码卡片
        m_frame = tk.Frame(content_frame, bg="#1a2234", bd=1, relief=tk.SOLID)
        m_frame.pack(fill=tk.X, pady=(0, 14))

        m_title = tk.Label(
            m_frame,
            text="本机动态随机申请码 (单次有效 · 复制发送给软件提供方):",
            font=("Microsoft YaHei UI", 9),
            fg="#94a3b8",
            bg="#1a2234"
        )
        m_title.pack(anchor="w", padx=16, pady=(10, 4))

        m_val_row = tk.Frame(m_frame, bg="#1a2234")
        m_val_row.pack(fill=tk.X, padx=16, pady=(0, 10))

        self.request_code_str = self.details.get("request_code", license_guard.get_request_code())
        self.code_disp = tk.Label(
            m_val_row,
            text=self.request_code_str,
            font=("Consolas", 20, "bold"),
            fg="#38bdf8",
            bg="#1a2234"
        )
        self.code_disp.pack(side=tk.LEFT)

        copy_btn = tk.Button(
            m_val_row,
            text="复制随机申请码",
            font=("Microsoft YaHei UI", 9, "bold"),
            bg="#2563eb",
            fg="#ffffff",
            activebackground="#1d4ed8",
            activeforeground="#ffffff",
            bd=0,
            padx=12,
            pady=4,
            cursor="hand2",
            command=self._copy_request_code
        )
        copy_btn.pack(side=tk.RIGHT)

        # 激活码输入区域
        input_title = tk.Label(
            content_frame,
            text="输入 12 位授权激活码 (XXXX-XXXX-XXXX):",
            font=("Microsoft YaHei UI", 10, "bold"),
            fg="#e2e8f0",
            bg="#0f141c"
        )
        input_title.pack(anchor="w", pady=(4, 6))

        # 12位激活码 Entry
        self.entry_var = tk.StringVar()
        self.entry_var.trace_add("write", self._on_entry_change)

        entry_container = tk.Frame(content_frame, bg="#334155", bd=2)
        entry_container.pack(fill=tk.X)

        self.code_entry = tk.Entry(
            entry_container,
            textvariable=self.entry_var,
            font=("Consolas", 18, "bold"),
            fg="#34d399",
            bg="#1e293b",
            bd=0,
            justify="center",
            insertbackground="#ffffff"
        )
        self.code_entry.pack(fill=tk.X, ipady=8)
        self.code_entry.focus_set()
        self.code_entry.bind("<Return>", lambda e: self._do_activate())

        # 动态提示标签
        self.msg_lbl = tk.Label(
            content_frame,
            text="每个激活码单次核销使用，激活后随机码自动翻转，绝不可二次重复激活",
            font=("Microsoft YaHei UI", 8),
            fg="#94a3b8",
            bg="#0f141c"
        )
        self.msg_lbl.pack(anchor="w", pady=(8, 4))

        # 商业授权咨询微信
        contact_frame = tk.Frame(content_frame, bg="#1a2234", bd=1, relief=tk.SOLID)
        contact_frame.pack(fill=tk.X, pady=(8, 0))

        contact_lbl = tk.Label(
            contact_frame,
            text="💬 获取商用授权码，请联系官方热线/微信：19203642022",
            font=("Microsoft YaHei UI", 10, "bold"),
            fg="#38bdf8",
            bg="#1a2234"
        )
        contact_lbl.pack(pady=8)

        # 3. 底部操作按钮
        btn_frame = tk.Frame(self.root, bg="#0f141c")
        btn_frame.pack(fill=tk.X, side=tk.BOTTOM, padx=24, pady=(0, 20))

        exit_btn = tk.Button(
            btn_frame,
            text="退出系统",
            font=("Microsoft YaHei UI", 10),
            bg="#334155",
            fg="#cbd5e1",
            activebackground="#475569",
            activeforeground="#ffffff",
            bd=0,
            padx=16,
            pady=8,
            cursor="hand2",
            command=self._on_exit
        )
        exit_btn.pack(side=tk.LEFT)

        self.act_btn = tk.Button(
            btn_frame,
            text="立即验证并激活",
            font=("Microsoft YaHei UI", 10, "bold"),
            bg="#10b981",
            fg="#ffffff",
            activebackground="#059669",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=8,
            cursor="hand2",
            command=self._do_activate
        )
        self.act_btn.pack(side=tk.RIGHT)

        self.root.protocol("WM_DELETE_WINDOW", self._on_exit)

    def _on_entry_change(self, *args):
        raw = self.entry_var.get().upper().replace(" ", "").replace("-", "")
        if len(raw) > 12:
            raw = raw[:12]
        # 格式化展示为 XXXX-XXXX-XXXX
        parts = []
        if len(raw) > 8:
            parts = [raw[:4], raw[4:8], raw[8:]]
        elif len(raw) > 4:
            parts = [raw[:4], raw[4:]]
        elif len(raw) > 0:
            parts = [raw]
        formatted = "-".join(parts)
        if self.entry_var.get() != formatted:
            self.entry_var.set(formatted)

    def _copy_request_code(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.request_code_str)
        self.msg_lbl.config(text="✅ 本机随机申请码已复制到剪贴板，请发送给软件提供方！", fg="#38bdf8")

    def _do_activate(self):
        code = self.entry_var.get().strip()
        cleaned_len = len(code.replace("-", "").replace(" ", ""))
        if not code or cleaned_len != 12:
            self.msg_lbl.config(text="❌ 请输入完整的 12 位授权激活码 (格式: XXXX-XXXX-XXXX)", fg="#f87171")
            return

        self.act_btn.config(state=tk.DISABLED, text="正在验证...")
        self.root.update()

        ok, msg = license_guard.activate(code)
        if ok:
            self.activated_success = True
            self.msg_lbl.config(text=f"🎉 {msg}", fg="#34d399")
            self.act_btn.config(text="激活成功")
            self.root.after(1000, self.root.destroy)
        else:
            self.act_btn.config(state=tk.NORMAL, text="立即验证并激活")
            self.msg_lbl.config(text=f"❌ {msg}", fg="#f87171")

    def _on_exit(self):
        self.activated_success = False
        self.root.destroy()

    def show(self) -> bool:
        self.root.mainloop()
        return self.activated_success


def request_license_if_needed() -> bool:
    """
    检查授权并在必要时弹出拦截对话框
    :return: True 表示获得有效授权放行启动，False 表示拒绝启动
    """
    is_valid, status_code, details = license_guard.check_license()
    if is_valid:
        return True

    dlg = LicenseActivationDialog(status_code=status_code, details=details)
    return dlg.show()


if __name__ == "__main__":
    success = request_license_if_needed()
