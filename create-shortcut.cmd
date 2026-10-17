@echo off
rem ============================================================
rem  Creates a desktop shortcut that starts the recovery console
rem  directly (no need to go through DeepSeek Harness first).
rem
rem    create-shortcut.cmd              -> DSH 恢复模式.lnk
rem    create-shortcut.cmd My Name      -> My Name.lnk
rem
rem  The shortcut points at dsh-recovery.cmd, which clears
rem  ELECTRON_RUN_AS_NODE, prepares .runtime\ when it is missing
rem  and forwards any arguments, so it keeps working after a
rem  runtime rebuild or an application update.
rem ============================================================
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
set "NAME=%~1"
if not defined NAME set "NAME=DSH 恢复模式"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$root = '%ROOT%'; $name = '%NAME%';" ^
 "$cmd = Join-Path $root 'dsh-recovery.cmd';" ^
 "if (-not (Test-Path $cmd)) { throw ('找不到启动器: ' + $cmd) };" ^
 "$exe = Join-Path $root '.runtime\dsh-recovery.exe';" ^
 "$desk = [Environment]::GetFolderPath('Desktop');" ^
 "if ([string]::IsNullOrWhiteSpace($desk)) { throw '找不到桌面目录' };" ^
 "$lnkPath = Join-Path $desk ($name + '.lnk');" ^
 "$ws = New-Object -ComObject WScript.Shell;" ^
 "$lnk = $ws.CreateShortcut($lnkPath);" ^
 "$lnk.TargetPath = $cmd;" ^
 "$lnk.Arguments = '';" ^
 "$lnk.WorkingDirectory = $root;" ^
 "$lnk.WindowStyle = 7;" ^
 "$lnk.Description = 'DSH 恢复器：直接启动恢复模式';" ^
 "if (Test-Path $exe) { $lnk.IconLocation = $exe + ',0' };" ^
 "$lnk.Save();" ^
 "Write-Host ('[OK]   ' + $lnkPath)"

if errorlevel 1 (
  echo [X] 创建快捷方式失败。
  pause
  exit /b 1
)

echo.
echo 双击桌面上的「%NAME%」即可直接打开恢复器窗口。
echo 参数可自定义名称：create-shortcut.cmd 我的恢复模式
pause
exit /b 0
