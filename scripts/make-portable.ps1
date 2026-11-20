# Build a portable DesktopPlanner WITHOUT electron-builder asar-integrity patching.
# Uses pristine Electron from runtime\ (or cache zip) + app\ + tray scripts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'dist\portable'
$runtime = Join-Path $root 'runtime'
$electronExe = Join-Path $runtime 'electron.exe'
$appExe = Join-Path $runtime 'DesktopPlanner.exe'

Write-Host "[portable] root=$root"

if (-not (Test-Path $electronExe)) {
  if (Test-Path $appExe) {
    Copy-Item $appExe $electronExe -Force
  } else {
    throw "Missing runtime\electron.exe — run scripts\setup-runtime.ps1 first"
  }
}

if (Test-Path $out) {
  # 目录本身可能被 IDE 文件监视/残留句柄占用而无法删除：只清空内容
  Get-ChildItem -Force $out | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
New-Item -ItemType Directory -Path $out -Force | Out-Null

Write-Host "[portable] copy Electron runtime -> dist\portable"
Copy-Item -Path (Join-Path $runtime '*') -Destination $out -Recurse -Force

# Prefer DesktopPlanner.exe name for tray recognition
$outElectron = Join-Path $out 'electron.exe'
$outApp = Join-Path $out 'DesktopPlanner.exe'
if (Test-Path $outElectron) {
  Copy-Item $outElectron $outApp -Force
}

$resApp = Join-Path $out 'resources\app'
if (Test-Path $resApp) { Remove-Item $resApp -Recurse -Force }
New-Item -ItemType Directory -Path $resApp -Force | Out-Null
Write-Host "[portable] copy app -> resources\app"
Copy-Item -Path (Join-Path $root 'app\*') -Destination $resApp -Recurse -Force

$resScripts = Join-Path $out 'resources\scripts'
New-Item -ItemType Directory -Path $resScripts -Force | Out-Null
Copy-Item (Join-Path $root 'scripts\tray-host.ps1') $resScripts -Force
Copy-Item (Join-Path $root 'scripts\tray-menu.cs') $resScripts -Force
Copy-Item (Join-Path $root 'scripts\start-tray-host.vbs') $resScripts -Force
Copy-Item (Join-Path $root 'app\assets\tray-win.ico') (Join-Path $resScripts 'tray-win.ico') -Force
Copy-Item (Join-Path $root 'app\assets\icon.ico') (Join-Path $resScripts 'icon.ico') -Force

# Packaged detection: electron isPackaged is true when app is in resources/app next to exe
# Force packaged-like paths: IS_PACKAGED=app.isPackaged — for resources/app layout, isPackaged is true.

Get-ChildItem $out -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

# 清除 Low 完整性标签：若构建目录带 Mandatory Label\Low（工作区被打过标签），产物会继承；
# 从 Low 标签的 exe 启动时进程被降为 Low IL，无法写 %APPDATA%（ProcessSingleton Error 5）和文档目录。
& icacls $out /setintegritylevel '(OI)(CI)M' /T /C /Q | Out-Null
Write-Host "[portable] integrity -> Medium"

Write-Host "[portable] OK -> $out\DesktopPlanner.exe"
Write-Host "[portable] Double-click DesktopPlanner.exe (or 启动-便携版.vbs)"
