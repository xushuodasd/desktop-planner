# 悬浮工作台（desktop-planner）运行时准备脚本
# 职责：
#   1) 在本机 Electron 缓存中定位 electron-v43.3.0-win32-x64.zip（按文件名 glob，不写死哈希目录）
#   2) 校验存在与大小 → Expand-Archive 解压到 runtime\（幂等：runtime\electron.exe 已存在则跳过）
#   3) 生成根目录"启动悬浮工作台.lnk"（目标 runtime\electron.exe，参数指向 app 目录，图标 app\assets\icon.ico）
# 约束：零网络依赖（不下载任何东西）；不修改系统全局配置。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\setup-runtime.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runtimeDir = Join-Path $root 'runtime'
$electronExe = Join-Path $runtimeDir 'electron.exe'
$appDir = Join-Path $root 'app'
$iconPath = Join-Path $appDir 'assets\icon.ico'
$cacheRoot = Join-Path $env:LOCALAPPDATA 'electron\Cache'
$zipPattern = 'electron-v43.3.0-win32-x64.zip'

Write-Host "[setup] 项目根：$root"

# 1) 定位缓存 zip（按文件名递归 glob，不写死哈希目录）
if (-not (Test-Path $cacheRoot)) {
    throw "[setup] 未找到 Electron 缓存目录：$cacheRoot"
}
$zip = Get-ChildItem -Path $cacheRoot -Recurse -Filter $zipPattern -File -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending | Select-Object -First 1
if (-not $zip) {
    throw "[setup] 缓存中未找到 $zipPattern"
}
$sizeMB = [math]::Round($zip.Length / 1MB, 1)
Write-Host "[setup] 命中缓存 zip：$($zip.FullName)（$sizeMB MB）"
if ($zip.Length -lt 100MB) {
    throw "[setup] zip 大小异常（$($zip.Length) 字节 < 100MB），疑似不完整，终止。"
}

# 2) 幂等解压到 runtime\
if (Test-Path $electronExe) {
    Write-Host "[setup] runtime\electron.exe 已存在，跳过解压（幂等）。"
} else {
    if (Test-Path $runtimeDir) {
        # 有残留目录但没有 electron.exe：清掉后重解压
        Remove-Item -Path $runtimeDir -Recurse -Force
    }
    Write-Host "[setup] 解压 $zipPattern -> $runtimeDir（约 400MB，请稍候）..."
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    Expand-Archive -Path $zip.FullName -DestinationPath $runtimeDir -Force
    if (-not (Test-Path $electronExe)) {
        throw "[setup] 解压完成但未找到 runtime\electron.exe，终止。"
    }
    Write-Host "[setup] 解压完成。"
}

# 3) 复制为 DesktopPlanner.exe：Win11 托盘按 exe 名识别应用，直接用 electron.exe 常被藏进「隐藏的图标」或根本不显示
$appExe = Join-Path $runtimeDir 'DesktopPlanner.exe'
Copy-Item -Path $electronExe -Destination $appExe -Force
Write-Host "[setup] 已生成独立进程：$appExe"

# 3b) 编译托盘宿主 TrayHost.exe（WinForms NotifyIcon，Win11 通知区比 Electron.Tray 稳）
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$trayCs = Join-Path $root 'scripts\TrayHost.cs'
$trayExe = Join-Path $runtimeDir 'TrayHost.exe'
if (Test-Path $csc -PathType Leaf -and Test-Path $trayCs -PathType Leaf) {
    & $csc /nologo /target:winexe /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:$trayExe $trayCs
    if (Test-Path $trayExe) {
        Unblock-File -Path $trayExe -ErrorAction SilentlyContinue
        Write-Host "[setup] 已编译托盘宿主：$trayExe"
    } else {
        Write-Host '[setup] 警告：TrayHost.exe 编译失败，托盘可能不显示'
    }
} else {
    Write-Host '[setup] 警告：未找到 csc 或 TrayHost.cs，跳过托盘宿主编译'
}

# 4) 生成"启动悬浮工作台.lnk"（绝对路径按脚本运行时解析）
$lnkPath = Join-Path $root '启动悬浮工作台.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $appExe
$shortcut.Arguments = "`"$appDir`" --no-sandbox --user-data-dir=`"$root\data\appdata`""
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = '悬浮工作台：桌面悬浮工作计划板'
$shortcut.Save()
Write-Host "[setup] 已生成快捷方式：$lnkPath"

Write-Host '[setup] 完成。双击"启动悬浮工作台"即可使用（数据在 data\workboard.json）。'
