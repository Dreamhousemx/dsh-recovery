@echo off
rem ============================================================
rem  dsh-recovery\restart-button : revert
rem  Puts the two backed up entries back into resources\app.asar,
rem  restoring the original Application menu.
rem  Use THIS tool's revert, not dsh-restart-menu-patch\revert.cmd:
rem  the older tool would roll the archive back to its original
rem  build, removing the restart button again.
rem ============================================================
chcp 65001 >nul
setlocal
call "%~dp0config.cmd"

if not defined DSH_NODE (
  echo   [X] node.exe not found. Set "DSH_NODE" to a node.exe path and run again.
  pause
  exit /b 1
)

"%DSH_NODE%" "%~dp0lib\apply.cjs" revert --archive "%DSH_ASAR%" --backup-dir "%~dp0backup" --state "%~dp0state.json" %*
set "DSH_RC=%ERRORLEVEL%"
echo.
pause
exit /b %DSH_RC%
