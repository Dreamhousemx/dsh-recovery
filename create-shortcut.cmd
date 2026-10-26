@echo off
rem ============================================================
rem  Creates a desktop shortcut that starts the recovery console
rem  directly (no need to go through DeepSeek Harness first).
rem
rem    create-shortcut.cmd              -> DSH 恢复模式.lnk
rem    create-shortcut.cmd My Name      -> My Name.lnk
rem    create-shortcut.cmd "" --no-pause -> default name, no key prompt
rem
rem  The shortcut points at dsh-recovery.cmd, which clears
rem  ELECTRON_RUN_AS_NODE, prepares .runtime\ when it is missing
rem  and forwards any arguments, so it keeps working after a
rem  runtime rebuild or an application update.
rem
rem  Icon preference: app\assets\icon.ico (multi-size, best for the
rem  shell), then app\assets\icon.png, then the runtime exe.
rem ============================================================
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"

rem Parse arguments by hand: `--no-pause` is a flag, everything else is the
rem shortcut name. `%1` being empty must not swallow `%2`, which is why the
rem flag is not read from a fixed position.
set "NAME="
set "NOPAUSE="
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-pause" (
  set "NOPAUSE=1"
  shift
  goto parse
)
if not defined NAME set "NAME=%~1"
shift
goto parse
:parsed
if not defined NAME set "NAME=DSH 恢复模式"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$root = '%ROOT%'; $name = '%NAME%';" ^
 "$cmd = Join-Path $root 'dsh-recovery.cmd';" ^
 "if (-not (Test-Path $cmd)) { throw ('找不到启动器: ' + $cmd) };" ^
 "$exe = Join-Path $root '.runtime\dsh-recovery.exe';" ^
 "$ico = Join-Path $root 'app\assets\icon.ico';" ^
 "$png = Join-Path $root 'app\assets\icon.png';" ^
 "$desk = [Environment]::GetFolderPath('Desktop');" ^
 "if ([string]::IsNullOrWhiteSpace($desk)) { throw '找不到桌面目录' };" ^
 "$lnkPath = Join-Path $desk ($name + '.lnk');" ^
 "$ws = New-Object -ComObject WScript.Shell;" ^
 "$lnk = $ws.CreateShortcut($lnkPath);" ^
 "$lnk.TargetPath = $cmd;" ^
 "$lnk.Arguments = '';" ^
 "$lnk.WorkingDirectory = $root;" ^
 "$lnk.WindowStyle = 7;" ^
 "$lnk.Description = 'DSH 恢复器：重启按钮、插件管理、回滚与诊断';" ^
 "if (Test-Path $ico) { $lnk.IconLocation = $ico + ',0' } elseif (Test-Path $png) { $lnk.IconLocation = $png + ',0' } elseif (Test-Path $exe) { $lnk.IconLocation = $exe + ',0' };" ^
 "$lnk.Save();" ^
 "Write-Host ('[OK]   ' + $lnkPath);" ^
 "Write-Host ('[icon] ' + $lnk.IconLocation)"

if errorlevel 1 (
  echo [X] 创建快捷方式失败。
  pause
  exit /b 1
)

echo.
echo 双击桌面上的「%NAME%」即可直接打开恢复器窗口。
echo 参数可自定义名称：create-shortcut.cmd 我的恢复模式
if not defined NOPAUSE pause
exit /b 0
