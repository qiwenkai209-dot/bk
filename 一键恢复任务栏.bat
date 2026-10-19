@echo off
cd /d "%~dp0"
python restore_taskbar.py
timeout /t 2 >nul
