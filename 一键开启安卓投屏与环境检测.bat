@echo off
chcp 936 >nul
color 0b
title VisualCast 安卓投屏检测与配置助手

echo =======================================================================
echo          VisualCast 展厅大屏 - 安卓手机投屏检测与配置助手
echo =======================================================================
echo.
echo [说明] VisualCast.exe 是独立完整免安装程序，已内置所有运行环境。
echo.
echo -----------------------------------------------------------------------
echo 步骤 1: 检测测试机是否具备 Miracast 无线网卡硬件
echo -----------------------------------------------------------------------

if exist "%windir%\System32\Connect.exe" goto launch_connect
goto check_generic

:launch_connect
echo [成功] 正在启动 Windows 原生「连接」全屏接收端...
start "" "%windir%\System32\Connect.exe"
echo [成功] 已成功打开「连接」窗口！
echo        若电脑屏幕显示 准备好进行无线连接，
echo        请在安卓手机顶部下拉，点击【投屏】搜索本电脑。
goto check_firewall

:check_generic
echo [提示] 正在打开 Windows 无线投影设置...
start ms-settings:projecting-to-this-pc
goto check_firewall

:check_firewall
echo.
echo -----------------------------------------------------------------------
echo 步骤 2: 配置 Windows 防火墙 (放行 8088 与 1900 局域网投屏端口)
echo -----------------------------------------------------------------------
netsh advfirewall firewall add rule name="VisualCast_Web" dir=in action=allow protocol=TCP localport=8088 >nul 2>&1
netsh advfirewall firewall add rule name="VisualCast_SSDP" dir=in action=allow protocol=UDP localport=1900 >nul 2>&1
echo [成功] 防火墙已放行 8088 与 1900 端口！

echo.
echo -----------------------------------------------------------------------
echo 步骤 3: 启动 VisualCast 播控大屏主程序
echo -----------------------------------------------------------------------
if exist "%~dp0VisualCast.exe" (
    echo 正在启动 VisualCast.exe...
    start "" "%~dp0VisualCast.exe"
    echo [成功] VisualCast 播控主程序已启动！
)

echo.
echo =======================================================================
echo 【安卓手机投屏使用排查说明】:
echo 1. 确保安卓手机与本电脑连接在同一个 Wi-Fi 路由器下。
echo 2. 若手机下拉【投屏】未搜到，进入手机【系统设置】:
echo    - 华为/荣耀: 设置 - 更多连接 - 手机投屏
echo    - 小米/红米: 设置 - 连接与共享 - 投屏 - 开启投屏
echo    - OPPO/vivo: 设置 - 连接与共享 - 手机投屏/多屏互动
echo 3. 亦可在手机相册或视频播放器中，点击右上角【TV 投屏图标】，
echo    设备列表中即可直接看到 VisualCast 展厅大屏！
echo =======================================================================
echo.
pause
