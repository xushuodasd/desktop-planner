@echo off
cd /d "%~dp0"
if not exist "runtime\DesktopPlanner.exe" (
  if exist "runtime\electron.exe" copy /Y "runtime\electron.exe" "runtime\DesktopPlanner.exe" >nul
)
if not exist "runtime\DesktopPlanner.exe" (
  echo Missing runtime\DesktopPlanner.exe
  echo Run: powershell -ExecutionPolicy Bypass -File scripts\setup-runtime.ps1
  pause
  exit /b 1
)
echo Starting...
start "" "runtime\DesktopPlanner.exe" "%~dp0app"
timeout /t 2 /nobreak >nul
tasklist /FI "IMAGENAME eq DesktopPlanner.exe" | find /I "DesktopPlanner.exe" >nul
if errorlevel 1 (
  echo FAILED: process not running. See data\boot.log if present.
  pause
) else (
  echo OK: DesktopPlanner.exe is running.
)
