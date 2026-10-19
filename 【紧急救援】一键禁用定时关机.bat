@echo off
chcp 65001 >nul
title VisualCast 紧急救援 - 中止关机与禁用定时排程
color 0c

echo ========================================================
echo        VisualCast 紧急救援：中止关机与禁用定时排程
echo ========================================================
echo.

echo [1/3] 正在中止任何 Windows 系统正在挂起的关机倒计时...
shutdown /a >nul 2>nul
if errorlevel 1 (
    echo       当前没有正在进行的关机倒计时。
) else (
    echo       [√] 成功中止 Windows 关机！系统已停止关机流程。
)
echo.

echo [2/3] 正在禁用 player_config.json 中的定时关机开关...
set "CFG_FILE=config\player_config.json"
if exist "%CFG_FILE%" (
    powershell -NoProfile -Command "$path='%CFG_FILE%'; try { $json = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json; if ($json.scheduled_shutdown) { $json.scheduled_shutdown.enabled = $false }; $json | ConvertTo-Json -Depth 10 | Set-Content $path -Encoding UTF8; Write-Host '      [√] 已将 scheduled_shutdown.enabled 成功置为 false' } catch { Write-Host '      [×] 修改配置异常:' $_ }"
) else (
    echo       未找到 %CFG_FILE% 配置文件。
)
echo.

echo [3/3] 正在禁用 scheduled_shutdown.json 备份配置...
set "BAK_FILE=config\scheduled_shutdown.json"
if exist "%BAK_FILE%" (
    powershell -NoProfile -Command "$path='%BAK_FILE%'; try { $json = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json; $json.enabled = $false; $json | ConvertTo-Json -Depth 10 | Set-Content $path -Encoding UTF8; Write-Host '      [√] 备份配置已同步置为 false' } catch {}"
)
echo.

echo ========================================================
echo   【救援完成】定时关机已彻底禁用，系统将保持持续开机！
echo ========================================================
echo.
pause
