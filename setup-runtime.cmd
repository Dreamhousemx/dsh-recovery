@echo off
rem Prepares .runtime\ (Electron runtime hard-linked from the installed shell).
rem Idempotent: safe to run again after installing or updating DeepSeek Harness.
setlocal

set "ROOT=%~dp0"
set "NODE="

for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE set "NODE=%%P"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\node.exe"

if not defined NODE (
  echo [错误] 找不到 Node.js：请安装 Node.js，或先让 DeepSeek Harness 完成一次运行时初始化。
  exit /b 1
)

"%NODE%" "%ROOT%setup-runtime.js" %*
if errorlevel 1 exit /b %errorlevel%

endlocal
