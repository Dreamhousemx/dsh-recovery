@echo off
rem ============================================================
rem  dsh-recovery\restart-button : shared configuration, ASCII only
rem  Override before calling, for example:
rem      set "DSH_DIR=D:\Some\Other\Dir"
rem      set "DSH_ASAR=D:\Some\Other\Dir\resources\app.asar"
rem ============================================================

if not defined DSH_DIR set "DSH_DIR=D:\Dev Tools\DeepSeek Harness"
if not defined DSH_ASAR set "DSH_ASAR=%DSH_DIR%\resources\app.asar"
if not defined DSH_EXE  set "DSH_EXE=%DSH_DIR%\DeepSeek Harness.exe"
if not defined DSH_RECOVERY set "DSH_RECOVERY=D:\Workspace\DeepSeek Harness\dsh-recovery\.runtime\dsh-recovery.exe"
if not defined DSH_NODE call :dsh_find_node
exit /b 0

:dsh_find_node
rem step 1 : node.exe from PATH
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "DSH_NODE=%%~$PATH:I"
if defined DSH_NODE exit /b 0
rem step 2 : node shipped inside the DSH user runtime
if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "DSH_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if defined DSH_NODE exit /b 0
rem step 3 : node shipped inside the DSH install directory
if exist "%DSH_DIR%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "DSH_NODE=%DSH_DIR%\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
exit /b 0
