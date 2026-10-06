@echo off
rem ============================================================
rem  dsh-recovery\restart-button : install
rem  Adds a "Restart" caption-menu button right of Application
rem  and Edit with three entries - Reload Page, Restart App and
rem  Host, Restart into Recovery Mode - and removes the first
rem  two from the Application menu.
rem  The asar is rewritten in place with identical byte lengths,
rem  so this is safe while DeepSeek Harness runs; restart the
rem  application to see the new menu.
rem ============================================================
chcp 65001 >nul
setlocal
call "%~dp0config.cmd"

if not defined DSH_NODE (
  echo   [X] node.exe not found. Set "DSH_NODE" to a node.exe path and run again.
  pause
  exit /b 1
)

"%DSH_NODE%" "%~dp0lib\apply.cjs" apply --archive "%DSH_ASAR%" --backup-dir "%~dp0backup" --state "%~dp0state.json" %*
set "DSH_RC=%ERRORLEVEL%"
echo.
pause
exit /b %DSH_RC%
