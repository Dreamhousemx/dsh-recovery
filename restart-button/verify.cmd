@echo off
rem ============================================================
rem  dsh-recovery\restart-button : verify
rem  Read only. Re-reads both patched entries, checks the asar
rem  header integrity metadata and runs node --check on them.
rem ============================================================
chcp 65001 >nul
setlocal
call "%~dp0config.cmd"

if not defined DSH_NODE (
  echo   [X] node.exe not found. Set "DSH_NODE" to a node.exe path and run again.
  pause
  exit /b 1
)

"%DSH_NODE%" "%~dp0lib\apply.cjs" verify --archive "%DSH_ASAR%" %*
set "DSH_RC=%ERRORLEVEL%"
echo.
pause
exit /b %DSH_RC%
