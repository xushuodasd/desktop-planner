@echo off
chcp 65001 >nul
cd /d "%~dp0"
set LOG=%TEMP%\desktop-planner-diag.txt
set EARLY=%TEMP%\desktop-planner-early.log
del /f /q "%LOG%" 2>nul
del /f /q "%EARLY%" 2>nul

echo ==== diag %DATE% %TIME% ==== > "%LOG%"
echo IMPORTANT: double-click this bat in Explorer, do NOT run inside Cursor terminal.>> "%LOG%"
echo cwd=%CD%>> "%LOG%"

echo.>> "%LOG%"
echo --- A: pristine portable --->> "%LOG%"
if exist "dist\portable\DesktopPlanner.exe" (
  cd /d "%~dp0dist\portable"
  DesktopPlanner.exe --disable-gpu
  echo portable_exit=%ERRORLEVEL%>> "%LOG%"
  cd /d "%~dp0"
) else (
  echo portable_missing>> "%LOG%"
)

if exist "%EARLY%" (
  echo EARLY_LOG_OK>> "%LOG%"
  type "%EARLY%" >> "%LOG%"
  goto SHOW
)

echo.>> "%LOG%"
echo --- B: runtime + project app --->> "%LOG%"
if exist "runtime\DesktopPlanner.exe" (
  runtime\DesktopPlanner.exe "%~dp0app" --disable-gpu
  echo runtime_exit=%ERRORLEVEL%>> "%LOG%"
) else (
  echo runtime_missing>> "%LOG%"
)

if exist "%EARLY%" (
  echo EARLY_LOG_OK>> "%LOG%"
  type "%EARLY%" >> "%LOG%"
)

:SHOW
echo.
echo ===== 诊断结果 =====
type "%LOG%"
echo.
echo early log path: %EARLY%
if exist "%EARLY%" (type "%EARLY%") else (echo early log: NONE)
echo.
pause
