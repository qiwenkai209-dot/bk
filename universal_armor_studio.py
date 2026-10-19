# -*- coding: utf-8 -*-
"""
国文创加密机 · 专业通用商业授权签发中心 (Universal License Studio)
========================================================================
专注商业授权全生命周期管理:
1. 8 位动态随机申请码智能自适应识别 (支持通用产品及 VisualCast 原生播控端)
2. 12 位一次性防二次激活商业授权激活码极速签发 (XXXX-XXXX-XXXX)
3. 支持有效时长控制 (支持 0.5 天体验、天数、月度、年度及永久授权)
4. 支持启动次数控制 (5 次 ~ 10000 次及无限制)
5. 一键复制激活码、一键复制客户模板，自动翻转 Nonce，安全防泄露
"""

import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox

# 导入通用授权核心引擎
try:
    from universal_license_core import (
        encode_request_code, decode_request_code,
        encode_license, decode_license,
        DURATION_MAP, RUNS_MAP, CHARSET
    )
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from universal_license_core import (
        encode_request_code, decode_request_code,
        encode_license, decode_license,
        DURATION_MAP, RUNS_MAP, CHARSET
    )


class UniversalArmorStudioApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("国文创加密机 - 专业商业授权签发中心")
        self.root.geometry("880x620")
        self.root.minsize(820, 560)
        self.root.configure(bg="#0b0f17")

        self._center_window()
        self._setup_style()
        self._build_ui()

    def _center_window(self):
        self.root.update_idletasks()
        w = 880
        h = 620
        ws = self.root.winfo_screenwidth()
        hs = self.root.winfo_screenheight()
        x = max(0, (ws - w) // 2)
        y = max(0, (hs - h) // 2 - 25)
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
        banner = tk.Frame(self.root, bg="#111827", height=82)
        banner.pack(fill=tk.X, side=tk.TOP)
        banner.pack_propagate(False)

        title = tk.Label(
            banner,
            text="🛡️ 国文创加密机 · 专业商业授权签发中心",
            font=("Microsoft YaHei UI", 16, "bold"),
            fg="#60a5fa",
            bg="#111827"
        )
        title.pack(anchor="w", padx=24, pady=(12, 2))

        subtitle = tk.Label(
            banner,
            text="8 位动态随机申请码智能自适应识别 · 12 位一次性商业授权激活码极速签发 · 支持 0.5天/天数/永久/次数授权",
            font=("Microsoft YaHei UI", 9),
            fg="#94a3b8",
            bg="#111827"
        )
        subtitle.pack(anchor="w", padx=24)

        main_container = tk.Frame(self.root, bg="#0b0f17")
        main_container.pack(fill=tk.BOTH, expand=True, padx=16, pady=10)

        gen_card = tk.LabelFrame(
            main_container,
            text=" 【 12 位一次性商业授权激活码签发 (XXXX-XXXX-XXXX / 一机一码 / 防二次激活) 】 ",
            font=("Microsoft YaHei UI", 11, "bold"),
            fg="#38bdf8",
            bg="#111827",
            bd=1,
            relief=tk.SOLID
        )
        gen_card.pack(fill=tk.BOTH, expand=True, padx=4, pady=4, ipadx=10, ipady=6)

        # 1. 软件产品代码
        r_p = tk.Frame(gen_card, bg="#111827")
        r_p.pack(fill=tk.X, padx=16, pady=(10, 5))
        tk.Label(r_p, text="软件产品代号 (Product ID):", font=("Microsoft YaHei UI", 10), fg="#cbd5e1", bg="#111827", width=22, anchor="w").pack(side=tk.LEFT)
        self.lic_prod_id_var = tk.StringVar(value="VisualCast")
        self.lic_prod_entry = tk.Entry(r_p, textvariable=self.lic_prod_id_var, font=("Consolas", 11, "bold"), fg="#38bdf8", bg="#1f293d", bd=1, width=18)
        self.lic_prod_entry.pack(side=tk.LEFT, ipady=3)
        self.lic_prod_id_var.trace_add("write", lambda *args: self._on_req_code_changed())
        tk.Label(r_p, text=" (自动兼容 VisualCast 播控原生端、Android端及通用产品)", font=("Microsoft YaHei UI", 9), fg="#64748b", bg="#111827").pack(side=tk.LEFT, padx=8)

        # 2. 现场设备 8 位动态随机申请码
        r_req = tk.Frame(gen_card, bg="#111827")
        r_req.pack(fill=tk.X, padx=16, pady=5)
        tk.Label(r_req, text="现场设备 8 位随机申请码:", font=("Microsoft YaHei UI", 10), fg="#cbd5e1", bg="#111827", width=22, anchor="w").pack(side=tk.LEFT)
        self.req_code_var = tk.StringVar()
        self.req_code_var.trace_add("write", lambda *args: self._on_req_code_changed())
        self.req_entry = tk.Entry(r_req, textvariable=self.req_code_var, font=("Consolas", 14, "bold"), fg="#38bdf8", bg="#1f293d", bd=1, width=14, justify="center")
        self.req_entry.pack(side=tk.LEFT, ipady=3)

        self.universal_var = tk.BooleanVar(value=False)
        self.universal_chk = tk.Checkbutton(
            r_req, text="全平台通用卡密码 (不绑定单台机器)", variable=self.universal_var,
            font=("Microsoft YaHei UI", 9), fg="#94a3b8", bg="#111827", activebackground="#111827", selectcolor="#1f293d"
        )
        self.universal_chk.pack(side=tk.LEFT, padx=(16, 0))

        # 申请码状态提示
        self.req_status_lbl = tk.Label(
            gen_card,
            text="请输入或粘贴客户软件弹窗上的 8 位动态申请码 (格式如: C7MR-Y7S6)",
            font=("Microsoft YaHei UI", 9), fg="#64748b", bg="#111827"
        )
        self.req_status_lbl.pack(anchor="w", padx=16, pady=(1, 6))

        # 3. 有效时长
        r_dur = tk.Frame(gen_card, bg="#111827")
        r_dur.pack(fill=tk.X, padx=16, pady=5)
        tk.Label(r_dur, text="商业授权有效时长:", font=("Microsoft YaHei UI", 10), fg="#cbd5e1", bg="#111827", width=22, anchor="w").pack(side=tk.LEFT)

        ordered_dur_keys = [11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 31]
        self.duration_choices = [f"{k}: {DURATION_MAP[k][0]}" for k in ordered_dur_keys if k in DURATION_MAP]
        self.duration_cb = ttk.Combobox(r_dur, values=self.duration_choices, font=("Microsoft YaHei UI", 10), state="readonly", width=26)
        self.duration_cb.set("8: 365天 (1年)")
        self.duration_cb.pack(side=tk.LEFT)

        # 4. 授权启动次数限制
        r_runs = tk.Frame(gen_card, bg="#111827")
        r_runs.pack(fill=tk.X, padx=16, pady=5)
        tk.Label(r_runs, text="授权启动次数限制:", font=("Microsoft YaHei UI", 10), fg="#cbd5e1", bg="#111827", width=22, anchor="w").pack(side=tk.LEFT)

        ordered_runs_keys = [31, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
        self.runs_choices = [f"{k}: {RUNS_MAP[k][0]}" for k in ordered_runs_keys if k in RUNS_MAP]
        self.runs_cb = ttk.Combobox(r_runs, values=self.runs_choices, font=("Microsoft YaHei UI", 10), state="readonly", width=26)
        self.runs_cb.set("31: 无限制")
        self.runs_cb.pack(side=tk.LEFT)

        # 5. 生成按钮
        btn_box = tk.Frame(gen_card, bg="#111827")
        btn_box.pack(fill=tk.X, padx=16, pady=(12, 6))
        tk.Button(
            btn_box, text="⚡ 立即计算并生成 12 位一次性授权激活码",
            font=("Microsoft YaHei UI", 11, "bold"), bg="#2563eb", fg="#fff", activebackground="#1d4ed8", bd=0, padx=20, pady=8, cursor="hand2",
            command=self._do_generate_license
        ).pack(side=tk.LEFT)

        # 6. 生成结果展示框
        result_box = tk.Frame(gen_card, bg="#0f172a", bd=1, relief=tk.SOLID)
        result_box.pack(fill=tk.X, padx=16, pady=(6, 8))

        self.gen_res_lbl = tk.Label(result_box, text="------------", font=("Consolas", 22, "bold"), fg="#34d399", bg="#0f172a", padx=16, pady=8)
        self.gen_res_lbl.pack(side=tk.LEFT)

        r_btns = tk.Frame(result_box, bg="#0f172a")
        r_btns.pack(side=tk.RIGHT, padx=12, pady=6)

        tk.Button(
            r_btns, text="📋 仅复制激活码", font=("Microsoft YaHei UI", 10, "bold"),
            bg="#0284c7", fg="#ffffff", activebackground="#0369a1", bd=0, padx=14, pady=6, cursor="hand2",
            command=self._copy_license_code
        ).pack(side=tk.LEFT, padx=4)

        tk.Button(
            r_btns, text="💬 复制客户回复语", font=("Microsoft YaHei UI", 10, "bold"),
            bg="#059669", fg="#ffffff", activebackground="#047857", bd=0, padx=14, pady=6, cursor="hand2",
            command=self._copy_customer_template
        ).pack(side=tk.LEFT, padx=4)

        # 安全机制说明
        tk.Label(
            gen_card,
            text="安全机制说明: 本激活码基于申请码中的硬件指纹与本轮随机 Nonce 一次性绑定。\n现场激活成功后，受控端 Nonce 立即翻转销毁，旧激活码当场失效，杜绝二次使用可能！",
            font=("Microsoft YaHei UI", 9), fg="#64748b", bg="#111827", justify="left"
        ).pack(anchor="w", padx=16, pady=(4, 4))

    def _on_req_code_changed(self):
        raw = self.req_code_var.get().strip()
        pid = self.lic_prod_id_var.get().strip()

        dec = decode_request_code(raw, product_id=pid)
        if dec["valid"]:
            matched = dec.get("matched_product_id", pid)
            if matched == "VisualCast_Native":
                prod_name = "VisualCast 播控原生端 (Python/Android)"
            elif matched == "ShengLi":
                prod_name = "胜利油田科普馆控制系统 (HTML)"
            elif matched == "Manual":
                prod_name = "多媒体工程师全栈手册 (HTML)"
            elif matched == "VisualCast":
                prod_name = "VisualCast 通用加壳端"
            elif matched == "":
                prod_name = "VisualCast 播控主端 (全局)"
            else:
                prod_name = f"[{matched or pid or '通用授权'}]"

            code_fmt = dec["code"]
            if self.req_code_var.get() != code_fmt and (len(raw) > 9 or "-" not in raw):
                self.req_code_var.set(code_fmt)

            self.req_status_lbl.config(
                text=f"✅ 申请码合法 | 体系: {prod_name} | 硬件指纹: #MC-{dec['hw_hex']} | 随机代际: #{dec['nonce']:04X}",
                fg="#34d399"
            )
        else:
            import re
            clean = re.sub(r"[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]", "", raw.upper())
            if len(clean) == 8:
                self.req_status_lbl.config(text=f"❌ {dec['error']}", fg="#f87171")
            else:
                self.req_status_lbl.config(
                    text="请输入或粘贴客户软件弹窗上的 8 位动态申请码 (格式如: C7MR-Y7S6)",
                    fg="#64748b"
                )

    def _do_generate_license(self):
        req_str = self.req_code_var.get().strip()
        pid = self.lic_prod_id_var.get().strip()
        dec = decode_request_code(req_str, product_id=pid)
        if not dec["valid"]:
            messagebox.showerror("生成失败", f"动态申请码无效: {dec['error']}")
            return

        effective_pid = dec["matched_product_id"] if ("matched_product_id" in dec and dec["matched_product_id"] is not None) else pid
        hw = 0 if self.universal_var.get() else dec["hw_hash"]
        nonce = dec["nonce"]
        dur = int(self.duration_cb.get().split(":")[0].strip())
        runs = int(self.runs_cb.get().split(":")[0].strip())

        code = encode_license(hw, nonce, dur, runs, product_id=effective_pid)
        self.gen_res_lbl.config(text=code)

        try:
            self.root.clipboard_clear()
            self.root.clipboard_append(code)
        except Exception:
            pass

    def _copy_license_code(self):
        code = self.gen_res_lbl.cget("text").strip()
        if not code or code == "------------":
            messagebox.showinfo("提示", "请先点击生成激活码！")
            return

        self.root.clipboard_clear()
        self.root.clipboard_append(code)
        messagebox.showinfo("复制成功", f"激活码已复制到剪贴板:\n\n{code}")

    def _copy_customer_template(self):
        code = self.gen_res_lbl.cget("text").strip()
        if not code or code == "------------":
            messagebox.showinfo("提示", "请先点击生成激活码！")
            return

        dur_text = self.duration_cb.get().split(":", 1)[-1].strip()
        runs_text = self.runs_cb.get().split(":", 1)[-1].strip()
        req_text = self.req_code_var.get().strip()

        tpl = (
            f"【国文创系统商业授权激活凭证】\n"
            f"设备申请码: {req_text}\n"
            f"授权激活码: {code}\n"
            f"有效时长: {dur_text}\n"
            f"启动限制: {runs_text}\n\n"
            f"操作指引: 请在软件【商业授权激活中心】窗口中粘贴上述 12 位激活码并点击【立即激活】。\n"
            f"官方授权与技术支持热线/微信: 19203642022\n"
            f"注: 授权码具备单次核销安全机制，激活后即完成绑定，请妥善保存。"
        )
        self.root.clipboard_clear()
        self.root.clipboard_append(tpl)
        messagebox.showinfo("复制成功", f"客户回复模板已复制到剪贴板:\n\n{tpl}")

    def run(self):
        self.root.mainloop()


def main():
    app = UniversalArmorStudioApp()
    app.run()


if __name__ == "__main__":
    main()
