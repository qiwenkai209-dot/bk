# -*- coding: utf-8 -*-
"""
VisualCast 独立授权加密机 (VisualCast License Generator & Manager v3)
========================================================================
功能:
1. 专为软件销售方/管理员提供的独立授权加密制作工具。
2. 基于【动态设备随机申请码】生成【12 位一次性授权激活码】。
3. 严格绑定目标设备硬件特征码与本轮动态随机 Nonce，一次性核销作废，绝不可二次重复激活。
4. 支持设定: 有效时长 (1天~3年/永久)、启动次数 (5次~无限次)、全平台通用选项。
5. 支持对任意 12 位授权激活码进行逆向解码反查与真伪校验。
6. 支持现代深色图形界面 (GUI) 与命令行 (CLI) 双运行模式。
"""

import sys
import os
import argparse
import tkinter as tk
from tkinter import ttk, messagebox

# 导入核心编码引擎
try:
    from license_core import (
        encode_request_code, decode_request_code,
        encode_license, decode_license,
        DURATION_MAP, RUNS_MAP, CHARSET
    )
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from license_core import (
        encode_request_code, decode_request_code,
        encode_license, decode_license,
        DURATION_MAP, RUNS_MAP, CHARSET
    )


class LicenseToolApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("VisualCast 独立授权加密机 (一次性动态随机授权中心)")
        self.root.geometry("680x760")
        self.root.minsize(640, 720)
        self.root.configure(bg="#0b0f17")

        self._center_window()
        self._setup_style()
        self._build_ui()

    def _center_window(self):
        self.root.update_idletasks()
        w = 680
        h = 760
        ws = self.root.winfo_screenwidth()
        hs = self.root.winfo_screenheight()
        x = max(0, (ws - w) // 2)
        y = max(0, (hs - h) // 2 - 20)
        self.root.geometry(f"{w}x{h}+{x}+{y}")

    def _setup_style(self):
        self.style = ttk.Style()
        self.style.theme_use("clam")
        self.style.configure(
            "Dark.TCombobox",
            fieldbackground="#1a2234",
            background="#2563eb",
            foreground="#ffffff",
            darkcolor="#1a2234",
            lightcolor="#1a2234"
        )

    def _build_ui(self):
        # 顶部 Banner
        banner = tk.Frame(self.root, bg="#111827", height=85)
        banner.pack(fill=tk.X, side=tk.TOP)
        banner.pack_propagate(False)

        title = tk.Label(
            banner,
            text="VisualCast 商业授权加密机",
            font=("Microsoft YaHei UI", 16, "bold"),
            fg="#60a5fa",
            bg="#111827"
        )
        title.pack(anchor="w", padx=24, pady=(16, 2))

        subtitle = tk.Label(
            banner,
            text="动态随机申请码体系 · 一码单次核销 · 激活后随机码自动翻转 · 绝不可二次重复激活",
            font=("Microsoft YaHei UI", 9),
            fg="#94a3b8",
            bg="#111827"
        )
        subtitle.pack(anchor="w", padx=24)

        # 主滚动或分栏容器
        main_body = tk.Frame(self.root, bg="#0b0f17")
        main_body.pack(fill=tk.BOTH, expand=True, padx=20, pady=16)

        # ------------------- 区域 1: 生成 12 位一次性授权激活码 -------------------
        gen_card = tk.LabelFrame(
            main_body,
            text=" 【 1. 生成 12 位一次性授权激活码 (XXXX-XXXX-XXXX / 防二次激活) 】 ",
            font=("Microsoft YaHei UI", 11, "bold"),
            fg="#38bdf8",
            bg="#111827",
            bd=1,
            relief=tk.SOLID
        )
        gen_card.pack(fill=tk.X, pady=(0, 14), ipadx=10, ipady=10)

        # 1. 目标设备随机申请码输入
        m_row = tk.Frame(gen_card, bg="#111827")
        m_row.pack(fill=tk.X, padx=16, pady=(8, 4))

        m_label = tk.Label(
            m_row,
            text="目标设备随机申请码:",
            font=("Microsoft YaHei UI", 10),
            fg="#cbd5e1",
            bg="#111827",
            width=16,
            anchor="w"
        )
        m_label.pack(side=tk.LEFT)

        self.req_code_var = tk.StringVar(value="")
        self.req_code_var.trace_add("write", self._on_req_code_changed)

        self.req_entry = tk.Entry(
            m_row,
            textvariable=self.req_code_var,
            font=("Consolas", 14, "bold"),
            fg="#38bdf8",
            bg="#1f293d",
            bd=1,
            width=14,
            justify="center",
            insertbackground="#ffffff"
        )
        self.req_entry.pack(side=tk.LEFT, ipady=3)

        self.universal_var = tk.BooleanVar(value=False)
        self.universal_chk = tk.Checkbutton(
            m_row,
            text="通用硬件 (不限机型)",
            variable=self.universal_var,
            font=("Microsoft YaHei UI", 9),
            fg="#94a3b8",
            bg="#111827",
            activebackground="#111827",
            activeforeground="#38bdf8",
            selectcolor="#1f293d"
        )
        self.universal_chk.pack(side=tk.LEFT, padx=(16, 0))

        # 申请码状态解析提示
        self.req_status_lbl = tk.Label(
            gen_card,
            text="请输入或粘贴客户提供的 8 位动态随机申请码 (如: C7MR-Y7S6)",
            font=("Microsoft YaHei UI", 9),
            fg="#64748b",
            bg="#111827"
        )
        self.req_status_lbl.pack(anchor="w", padx=16, pady=(0, 8))

        # 2. 时长选择
        d_row = tk.Frame(gen_card, bg="#111827")
        d_row.pack(fill=tk.X, padx=16, pady=4)

        d_label = tk.Label(
            d_row,
            text="授权有效时长:",
            font=("Microsoft YaHei UI", 10),
            fg="#cbd5e1",
            bg="#111827",
            width=16,
            anchor="w"
        )
        d_label.pack(side=tk.LEFT)

        self.duration_choices = [
            f"{k}: {v[0]}" for k, v in DURATION_MAP.items()
        ]
        self.duration_cb = ttk.Combobox(
            d_row,
            values=self.duration_choices,
            font=("Microsoft YaHei UI", 10),
            state="readonly",
            width=24
        )
        self.duration_cb.set("4: 30天 (1个月)")
        self.duration_cb.pack(side=tk.LEFT)

        # 3. 次数选择
        r_row = tk.Frame(gen_card, bg="#111827")
        r_row.pack(fill=tk.X, padx=16, pady=4)

        r_label = tk.Label(
            r_row,
            text="允许启动运行次数:",
            font=("Microsoft YaHei UI", 10),
            fg="#cbd5e1",
            bg="#111827",
            width=16,
            anchor="w"
        )
        r_label.pack(side=tk.LEFT)

        self.runs_choices = [
            f"{k}: {v[0]}" for k, v in RUNS_MAP.items()
        ]
        self.runs_cb = ttk.Combobox(
            r_row,
            values=self.runs_choices,
            font=("Microsoft YaHei UI", 10),
            state="readonly",
            width=24
        )
        self.runs_cb.set("31: 无限制")
        self.runs_cb.pack(side=tk.LEFT)

        # 4. 生成按钮
        btn_row = tk.Frame(gen_card, bg="#111827")
        btn_row.pack(fill=tk.X, padx=16, pady=(12, 6))

        gen_btn = tk.Button(
            btn_row,
            text="⚡ 立即生成 12 位授权激活码",
            font=("Microsoft YaHei UI", 11, "bold"),
            bg="#2563eb",
            fg="#ffffff",
            activebackground="#1d4ed8",
            activeforeground="#ffffff",
            bd=0,
            padx=20,
            pady=8,
            cursor="hand2",
            command=self._do_generate
        )
        gen_btn.pack(side=tk.LEFT)

        # 生成结果显示
        result_box = tk.Frame(gen_card, bg="#0f172a", bd=1, relief=tk.SOLID)
        result_box.pack(fill=tk.X, padx=16, pady=(8, 4))

        self.gen_res_lbl = tk.Label(
            result_box,
            text="------------",
            font=("Consolas", 22, "bold"),
            fg="#34d399",
            bg="#0f172a",
            padx=16,
            pady=8
        )
        self.gen_res_lbl.pack(side=tk.LEFT)

        self.copy_btn = tk.Button(
            result_box,
            text="📋 复制激活码",
            font=("Microsoft YaHei UI", 10, "bold"),
            bg="#059669",
            fg="#ffffff",
            activebackground="#047857",
            activeforeground="#ffffff",
            bd=0,
            padx=14,
            pady=6,
            cursor="hand2",
            command=self._copy_generated
        )
        self.copy_btn.pack(side=tk.RIGHT, padx=16)

        self.gen_desc_lbl = tk.Label(
            gen_card,
            text="说明: 本激活码单次有效；受控端激活成功后随机码自动翻转，旧激活码当场失效，不能二次激活程序。",
            font=("Microsoft YaHei UI", 8),
            fg="#64748b",
            bg="#111827"
        )
        self.gen_desc_lbl.pack(anchor="w", padx=16, pady=(4, 2))

        # ------------------- 区域 2: 授权激活码反查与校验 -------------------
        verify_card = tk.LabelFrame(
            main_body,
            text=" 【 2. 授权激活码反查与真伪校验 】 ",
            font=("Microsoft YaHei UI", 11, "bold"),
            fg="#a78bfa",
            bg="#111827",
            bd=1,
            relief=tk.SOLID
        )
        verify_card.pack(fill=tk.X, ipadx=10, ipady=10)

        v_input_row = tk.Frame(verify_card, bg="#111827")
        v_input_row.pack(fill=tk.X, padx=16, pady=(8, 8))

        v_lbl = tk.Label(
            v_input_row,
            text="待验证 12 位码:",
            font=("Microsoft YaHei UI", 10),
            fg="#cbd5e1",
            bg="#111827",
            width=16,
            anchor="w"
        )
        v_lbl.pack(side=tk.LEFT)

        self.v_code_var = tk.StringVar()
        self.v_entry = tk.Entry(
            v_input_row,
            textvariable=self.v_code_var,
            font=("Consolas", 14, "bold"),
            fg="#a78bfa",
            bg="#1f293d",
            bd=1,
            width=20,
            justify="center",
            insertbackground="#ffffff"
        )
        self.v_entry.pack(side=tk.LEFT, ipady=3)
        self.v_entry.bind("<Return>", lambda e: self._do_verify())

        v_btn = tk.Button(
            v_input_row,
            text="🔍 立即反查解码",
            font=("Microsoft YaHei UI", 9, "bold"),
            bg="#7c3aed",
            fg="#ffffff",
            activebackground="#6d28d9",
            activeforeground="#ffffff",
            bd=0,
            padx=14,
            pady=4,
            cursor="hand2",
            command=self._do_verify
        )
        v_btn.pack(side=tk.LEFT, padx=(12, 0))

        # 反查输出详情
        self.v_res_text = tk.Text(
            verify_card,
            height=4,
            font=("Consolas", 10),
            bg="#0f172a",
            fg="#e2e8f0",
            bd=1,
            relief=tk.SOLID,
            padx=12,
            pady=8
        )
        self.v_res_text.pack(fill=tk.X, padx=16, pady=(4, 8))
        self.v_res_text.insert(tk.END, "在此处粘贴 12 位激活码并点击反查，可查看其绑定硬件、Nonce、授权天数和真伪。")
        self.v_res_text.config(state=tk.DISABLED)

    def _on_req_code_changed(self, *args):
        val = self.req_code_var.get().upper().replace(" ", "")
        if len(val) > 9:
            val = val[:9]
        if self.req_code_var.get() != val:
            self.req_code_var.set(val)

        dec = decode_request_code(val)
        if dec["valid"]:
            self.req_status_lbl.config(
                text=f"✅ 申请码校验合法 | 硬件特征: #MC-{dec['hw_hex']} | 随机Nonce: #{dec['nonce']:04X}",
                fg="#34d399"
            )
        else:
            if len(val.replace("-", "")) == 8:
                self.req_status_lbl.config(text=f"❌ {dec['error']}", fg="#f87171")
            else:
                self.req_status_lbl.config(
                    text="请输入或粘贴客户提供的 8 位动态随机申请码 (如: C7MR-Y7S6)",
                    fg="#64748b"
                )

    def _do_generate(self):
        req_str = self.req_code_var.get().strip()
        dec = decode_request_code(req_str)
        if not dec["valid"]:
            messagebox.showerror("生成失败", f"随机申请码无效: {dec['error']}")
            return

        hw_hash = 0 if self.universal_var.get() else dec["hw_hash"]
        nonce = dec["nonce"]

        # 解析时长
        dur_str = self.duration_cb.get().split(":")[0].strip()
        try:
            dur_code = int(dur_str)
        except ValueError:
            dur_code = 4

        # 解析次数
        runs_str = self.runs_cb.get().split(":")[0].strip()
        try:
            runs_code = int(runs_str)
        except ValueError:
            runs_code = 31

        lic_key = encode_license(hw_hash, nonce, dur_code, runs_code)
        self.gen_res_lbl.config(text=lic_key)

    def _copy_generated(self):
        code = self.gen_res_lbl.cget("text")
        if not code or code == "------------":
            messagebox.showinfo("提示", "请先点击生成授权激活码！")
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(code)
        messagebox.showinfo("复制成功", f"授权激活码已复制到剪贴板:\n\n{code}\n\n请发送给现场客户输入激活！")

    def _do_verify(self):
        code_str = self.v_code_var.get().strip()
        if not code_str:
            messagebox.showinfo("提示", "请输入待验证的 12 位授权激活码！")
            return

        res = decode_license(code_str)

        self.v_res_text.config(state=tk.NORMAL)
        self.v_res_text.delete("1.0", tk.END)

        if not res["valid"]:
            self.v_res_text.insert(tk.END, f"❌ 验证未通过: {res['error']}\n")
        else:
            hw_desc = "全平台通用 (不绑定机器)" if res["is_universal"] else f"绑定硬件: #MC-{res['hw_hex']}"
            self.v_res_text.insert(tk.END, f"✅ 官方合法激活码: {res['code']}\n")
            self.v_res_text.insert(tk.END, f"• 硬件绑定: {hw_desc}\n")
            self.v_res_text.insert(tk.END, f"• 随机 Nonce: #{res['nonce']:04X} (单次核销)\n")
            self.v_res_text.insert(tk.END, f"• 授权时长: {res['duration_label']} ({res['duration_days']} 天)\n")
            self.v_res_text.insert(tk.END, f"• 允许次数: {res['runs_label']}\n")
        self.v_res_text.config(state=tk.DISABLED)

    def run(self):
        self.root.mainloop()


def run_cli():
    parser = argparse.ArgumentParser(description="VisualCast 商业授权激活码命令行生成工具")
    parser.add_argument("--request", "-r", type=str, help="目标设备 8 位随机申请码 (如 C7MR-Y7S6)")
    parser.add_argument("--duration", "-d", type=int, default=4, help="有效时长代码 0~31 (默认 4: 30天)")
    parser.add_argument("--runs", "-c", type=int, default=31, help="运行次数代码 0~31 (默认 31: 无限制)")
    parser.add_argument("--universal", "-u", action="store_true", help="全平台通用不绑定硬件")
    parser.add_argument("--verify", "-v", type=str, help="反查验证 12 位激活码")

    args = parser.parse_args()

    if args.verify:
        res = decode_license(args.verify)
        if res["valid"]:
            hw_tag = "全平台通用" if res["is_universal"] else f"MC-{res['hw_hex']}"
            print(f"[SUCCESS] 官方合法激活码: {res['code']}")
            print(f"  硬件特征: {hw_tag}")
            print(f"  随机代际: #{res['nonce']:04X}")
            print(f"  有效时长: {res['duration_label']}")
            print(f"  运行次数: {res['runs_label']}")
        else:
            print(f"[FAILED] 校验失败: {res['error']}")
        return

    if args.request:
        dec = decode_request_code(args.request)
        if not dec["valid"]:
            print(f"[ERROR] 随机申请码无效: {dec['error']}")
            return
        hw = 0 if args.universal else dec["hw_hash"]
        nonce = dec["nonce"]
        key = encode_license(hw, nonce, args.duration, args.runs)
        print(f"\n=======================================================")
        print(f"  VisualCast 12 位一次性授权激活码生成成功:")
        print(f"  >>  {key}  <<")
        print(f"=======================================================\n")
        return

    # 若未带参数，拉起图形界面
    app = LicenseToolApp()
    app.run()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run_cli()
    else:
        app = LicenseToolApp()
        app.run()
