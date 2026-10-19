@echo off
chcp 65001 >nul
title OmniCast Pro · 展馆中控指令实时测试终端 (TCP/HTTP)
color 0B

set PROTOCOL_MODE=TCP
set TCP_PORT=8000
set HTTP_PORT=8088

:MENU
cls
echo ================================================================
echo           OmniCast Pro 展馆中控联动调试终端
echo ================================================================
echo   [当前通信协议模式]: %PROTOCOL_MODE% (TCP端口: %TCP_PORT% / HTTP端口: %HTTP_PORT%)
echo ----------------------------------------------------------------
echo   [1] 发送 PLAY        - 开始播放
echo   [2] 发送 PAUSE       - 暂停播出
echo   [3] 发送 STOP        - 停止播放并复位
echo   [4] 发送 SWITCH:1    - 切换至【1. 主序章 · 未来数智展厅】
echo   [5] 发送 SWITCH:2    - 切换至【2. 沉浸沙盘 · 科技数字沙盘】
echo   [6] 发送 SWITCH:3    - 切换至【3. 互动飞屏 · 迎宾互动图文】
echo   [7] 发送 CUT         - 执行 PVW / PGM 快速硬切
echo   [8] 发送 AUTO        - 执行平滑自动转场
echo   [9] 发送 BLACK:1     - 触发一键切黑场 (FTB)
echo   [10] 发送 BLACK:0    - 解除黑场恢复播出
echo   [11] 发送 VOL:90     - 设置主声道音量为 90%%
echo   [12] 发送 VOL:20     - 设置主声道音量为 20%%
echo   [13] 输入自定义指令
echo   [14] 查看播控系统当前状态 (拉取实时指标)
echo   [T]  切换协议模式 (当前: %PROTOCOL_MODE%)
echo   [0]  退出终端
echo ================================================================
set /p opt=请选择操作项 [1-14 / T / 0]: 

if /i "%opt%"=="T" (
    if "%PROTOCOL_MODE%"=="TCP" (
        set PROTOCOL_MODE=HTTP
    ) else (
        set PROTOCOL_MODE=TCP
    )
    goto MENU
)

if "%opt%"=="1" (
    call :DISPATCH_CMD "PLAY"
) else if "%opt%"=="2" (
    call :DISPATCH_CMD "PAUSE"
) else if "%opt%"=="3" (
    call :DISPATCH_CMD "STOP"
) else if "%opt%"=="4" (
    call :DISPATCH_CMD "SWITCH:scene-1"
) else if "%opt%"=="5" (
    call :DISPATCH_CMD "SWITCH:scene-2"
) else if "%opt%"=="6" (
    call :DISPATCH_CMD "SWITCH:scene-3"
) else if "%opt%"=="7" (
    call :DISPATCH_CMD "CUT"
) else if "%opt%"=="8" (
    call :DISPATCH_CMD "AUTO"
) else if "%opt%"=="9" (
    call :DISPATCH_CMD "BLACK:1"
) else if "%opt%"=="10" (
    call :DISPATCH_CMD "BLACK:0"
) else if "%opt%"=="11" (
    call :DISPATCH_CMD "VOL:90"
) else if "%opt%"=="12" (
    call :DISPATCH_CMD "VOL:20"
) else if "%opt%"=="13" (
    echo.
    set /p custom_cmd=请输入中控指令 (例如: SWITCH:scene-2 或 VOL:80): 
    call :DISPATCH_CMD "%custom_cmd%"
) else if "%opt%"=="14" (
    echo.
    echo [查询中] 正在拉取播控机当前状态 (HTTP :8088)...
    powershell -NoProfile -Command "try { $res = Invoke-RestMethod -Uri 'http://localhost:8088/api/status'; Write-Host '当前节目:' $res.data.currentSceneName -ForegroundColor Cyan; Write-Host '播放状态:' $res.data.playbackState -ForegroundColor Green; Write-Host '时间码:' $res.data.currentTimecode; Write-Host '主音量:' $res.data.volume '%%'; Write-Host '黑场状态:' $res.data.isBlackout; Write-Host '内存占用:' $res.data.system.memoryUsagePercent '%%'; Write-Host '中控Web端:' $res.data.system.webUrl -ForegroundColor Yellow; } catch { Write-Host '[错误] 无法连接到播控服务，请确认 OmniCast Pro 是否正在运行！' -ForegroundColor Red }"
    echo.
    pause
    goto MENU
) else if "%opt%"=="0" (
    exit /b
) else (
    echo 输入有误，请重新选择。
    timeout /t 1 >nul
    goto MENU
)

echo.
pause
goto MENU

:DISPATCH_CMD
set cmd_val=%~1
if "%PROTOCOL_MODE%"=="TCP" (
    call :SEND_TCP "%cmd_val%"
) else (
    call :SEND_HTTP "%cmd_val%"
)
exit /b

:SEND_TCP
set cmd_val=%~1
echo.
echo [TCP Socket] 正在向 127.0.0.1:%TCP_PORT% 发送中控指令: %cmd_val% ...
powershell -NoProfile -Command "
try {
    $client = New-Object System.Net.Sockets.TcpClient('127.0.0.1', %TCP_PORT%);
    $stream = $client.GetStream();
    $stream.ReadTimeout = 2000;
    $writer = New-Object System.IO.StreamWriter($stream);
    $reader = New-Object System.IO.StreamReader($stream);
    $writer.WriteLine('%cmd_val%');
    $writer.Flush();
    $ack = $reader.ReadLine();
    Write-Host '[TCP 成功] 播控机已响应 ACK 回执:' $ack -ForegroundColor Green;
    $client.Close();
} catch {
    Write-Host '[TCP 失败] 无法建立 TCP Socket 连接(端口 %TCP_PORT%)，请确认 OmniCast Pro 已运行！' -ForegroundColor Red;
}
"
exit /b

:SEND_HTTP
set cmd_val=%~1
echo.
echo [HTTP REST] 正在向 http://localhost:%HTTP_PORT%/api/command 调度指令: %cmd_val% ...
powershell -NoProfile -Command "
$raw = '%cmd_val%';
if ($raw.Contains(':')) {
    $parts = $raw.Split(':');
    $c = $parts[0];
    $p = $parts[1];
    $body = @{ cmd = $c; param = $p } | ConvertTo-Json;
} else {
    $body = @{ cmd = $raw } | ConvertTo-Json;
}
try {
    $res = Invoke-RestMethod -Uri 'http://localhost:%HTTP_PORT%/api/command' -Method Post -Body $body -ContentType 'application/json';
    Write-Host '[HTTP 成功] 指令已接收执行，反馈回执:' ($res | ConvertTo-Json -Compress) -ForegroundColor Green;
} catch {
    Write-Host '[HTTP 失败] 无法连通播控机 (端口 %HTTP_PORT%)，请确认 OmniCast Pro 是否已启动！' -ForegroundColor Red;
}
"
exit /b
