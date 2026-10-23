# -*- mode: python ; coding: utf-8 -*-
import os
import sys

BASE_DIR = os.path.abspath(SPECPATH)

# 1. 静态资源与图标
added_data = [
    (os.path.join(BASE_DIR, 'static'), 'static'),
    (os.path.join(BASE_DIR, 'assets'), 'assets'),
]

# 2. 纯净 JSON 配置文件 (彻底过滤掉 webview/browser 临时缓存文件)
config_dir = os.path.join(BASE_DIR, 'config')
if os.path.exists(config_dir):
    for f in os.listdir(config_dir):
        if f.endswith('.json') or f.endswith('.dat'):
            added_data.append((os.path.join(config_dir, f), 'config'))

a = Analysis(
    ['main.py'],
    pathex=[BASE_DIR],
    binaries=[],
    datas=added_data,
    hiddenimports=[
        'bottle',
        'logger_service',
        'cluster_sync',
        'usb_sync',
        'iot_engine',
        'system_control',
        'native_cast_server',
        'scheduled_shutdown',
        'device_manager',
        'license_guard',
        'universal_license_core',
        'license_dialog',
        'tkinter',
        'wsgiref.simple_server',
        'serial',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'scipy', 'pandas', 'unittest', 'test'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='VisualCast',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(BASE_DIR, 'assets', 'icon.ico'),
)
