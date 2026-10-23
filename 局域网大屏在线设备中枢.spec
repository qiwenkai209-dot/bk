# -*- mode: python ; coding: utf-8 -*-
import os
import sys

BASE_DIR = os.path.abspath(SPECPATH)

# 1. 静态资源与图标
added_data = [
    (os.path.join(BASE_DIR, 'static'), 'static'),
    (os.path.join(BASE_DIR, 'assets'), 'assets'),
]

# 2. 纯净配置预设
config_dir = os.path.join(BASE_DIR, 'config')
if os.path.exists(config_dir):
    for f in os.listdir(config_dir):
        if f == 'discovered_devices.json':
            added_data.append((os.path.join(config_dir, f), 'config'))

a = Analysis(
    ['fleet_hub.py'],
    pathex=[BASE_DIR],
    binaries=[],
    datas=added_data,
    hiddenimports=[
        'bottle',
        'device_manager',
        'system_control',
        'wsgiref.simple_server',
        'concurrent.futures',
        'urllib.request',
        'socket',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'scipy', 'pandas', 'unittest', 'test', 'PyQt5', 'PySide2', 'webview'],
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
    name='局域网大屏在线设备中枢',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(BASE_DIR, 'assets', 'icon.ico') if os.path.exists(os.path.join(BASE_DIR, 'assets', 'icon.ico')) else None,
)
