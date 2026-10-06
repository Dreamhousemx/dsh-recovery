@echo off
rem ============================================================
rem  dsh-recovery\restart-button : status
rem  Read only. Safe to run while DeepSeek Harness is running.
rem ============================================================
chcp 65001 >nul
setlocal
call "%~dp0config.cmd"

if not defined DSH_NODE (
  echo   [X] node.exe not found. Set "DSH_NODE" to a node.exe path and run again.
  pause
  exit /b 1
)

"%DSH_NODE%" "%~dp0lib\apply.cjs" status --archive "%DSH_ASAR%" --backup-dir "%~dp0backup" --state "%~dp0state.json" %*
set "DSH_RC=%ERRORLEVEL%"
echo.
pause
exit /b %DSH_RC%
