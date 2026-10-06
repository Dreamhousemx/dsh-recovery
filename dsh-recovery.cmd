@echo off
rem Launches the DSH recovery console.
rem
rem The console runs on its own Electron runtime under .runtime\ so it keeps
rem working while the installed application (and its profile) is broken.
rem Arguments are forwarded: --target=<dir> --profile=<name> --home=<dir>
setlocal

rem DSH's own terminal exports ELECTRON_RUN_AS_NODE=1, which would turn the
rem Electron binary into plain Node and silently skip the window. Clear it so
rem the console starts as a desktop app no matter where this script is run.
set "ELECTRON_RUN_AS_NODE="

set "ROOT=%~dp0"
set "RUNTIME=%ROOT%.runtime"
set "EXE=%RUNTIME%\dsh-recovery.exe"

if not exist "%EXE%" goto setup
if not exist "%RUNTIME%\runtime.json" goto setup
if not exist "%RUNTIME%\resources\app" goto setup
goto launch

:setup
echo [信息] 首次运行或运行时缺失：正在准备 Electron 运行时...
call "%ROOT%setup-runtime.cmd" %*
if errorlevel 1 exit /b %errorlevel%
if not exist "%EXE%" (
  echo [错误] 运行时准备失败：%EXE% 不存在。
  exit /b 1
)

:launch
start "" "%EXE%" %*

endlocal
