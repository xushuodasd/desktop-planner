# Desktop Planner — WinForms tray host (Win11 Electron.Tray fallback)
# Left click: raise panel. Right: panel / review / settings / quit.
param(
  [Parameter(Mandatory = $true)][string]$RootDir,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $false)][string]$AppDir = '',
  [Parameter(Mandatory = $true)][string]$IconPath
)

$ErrorActionPreference = 'Stop'

function Resolve-DataDir {
  $docs = [Environment]::GetFolderPath('MyDocuments')
  $packaged = Join-Path $docs '悬浮工作台'
  $portable = Join-Path $RootDir 'data'
  if ($AppDir -and (Test-Path (Join-Path $RootDir 'data'))) { return $portable }
  if ($AppDir -and -not [string]::IsNullOrWhiteSpace($AppDir)) { return $portable }
  return $packaged
}

$dataDir = Resolve-DataDir
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
$log = Join-Path $dataDir 'tray-host.log'

function Write-TrayLog([string]$msg) {
  try {
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format o), $msg)
  } catch {}
}

Write-TrayLog "boot STA=$([System.Threading.Thread]::CurrentThread.GetApartmentState()) icon=$IconPath exe=$ExePath app=$AppDir"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

function Invoke-DesktopPlanner([string]$ViewArgument) {
  $ud = if ([string]::IsNullOrWhiteSpace($AppDir)) {
    Join-Path $env:APPDATA 'desktop-planner\appdata'
  } else {
    Join-Path $RootDir 'data\appdata'
  }
  if (-not (Test-Path $ud)) { New-Item -ItemType Directory -Path $ud -Force | Out-Null }
  $appArgs = @('--no-sandbox', "--user-data-dir=$ud")
  if (-not [string]::IsNullOrWhiteSpace($AppDir)) { $appArgs += ('"' + $AppDir + '"') }
  if ($ViewArgument) { $appArgs += $ViewArgument }
  Start-Process -FilePath $ExePath -ArgumentList $appArgs -WorkingDirectory $RootDir | Out-Null
}

function Invoke-QuitApp {
  Get-Process -Name 'DesktopPlanner' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($script:notify) {
    $script:notify.Visible = $false
    $script:notify.Dispose()
  }
  [System.Windows.Forms.Application]::Exit()
}

$icon = $null
try {
  if (Test-Path $IconPath) {
    $icon = New-Object System.Drawing.Icon($IconPath)
  }
} catch {
  $icon = [System.Drawing.SystemIcons]::Application
}
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$styledMenu = $false
if (-not [System.Windows.Forms.SystemInformation]::HighContrast) {
  try {
    Add-Type -Path (Join-Path $PSScriptRoot 'tray-menu.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
    $menu = New-Object WorkboardTrayMenu
    $styledMenu = $true
  } catch {
    Write-TrayLog "custom menu unavailable: $($_.Exception.Message)"
  }
}
if (-not $styledMenu) { $menu = New-Object System.Windows.Forms.ContextMenuStrip }

function Add-TrayAction([string]$label, [string]$glyph) {
  if ($styledMenu) { return $menu.AddAction($label, $glyph) }
  return $menu.Items.Add($label)
}

$itemOpen = Add-TrayAction '打开面板' 'panel'
$itemOpen.add_Click({ Invoke-DesktopPlanner })
$itemReview = Add-TrayAction '回顾…' 'review'
$itemReview.add_Click({ Invoke-DesktopPlanner '--open-review' })
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$itemSettings = Add-TrayAction '设置…' 'settings'
$itemSettings.add_Click({ Invoke-DesktopPlanner '--open-settings' })
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$itemQuit = Add-TrayAction '退出' 'quit'
$itemQuit.add_Click({ Invoke-QuitApp })

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = $icon
$script:notify.Text = '悬浮工作台'
$script:notify.Visible = $true
$script:notify.ContextMenuStrip = $menu
$script:notify.add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Invoke-DesktopPlanner
  }
})

try {
  $script:notify.ShowBalloonTip(2500, '悬浮工作台', '已在右下角托盘运行，点击 ^ 隐藏图标里也能看到', [System.Windows.Forms.ToolTipIcon]::Info)
} catch {}

try {
  Start-Sleep -Milliseconds 800
  $base = 'HKCU:\Control Panel\NotifyIconSettings'
  if (Test-Path $base) {
    Get-ChildItem $base | Sort-Object LastWriteTime -Descending | Select-Object -First 12 | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $p) { return }
      $exe = [string]$p.ExecutablePath
      $tip = ''
      try { $tip = [string]$p.IconTip } catch {}
      if ($exe -match 'powershell' -or $tip -match '悬浮') {
        Set-ItemProperty -Path $_.PSPath -Name IsPromoted -Value 1 -Type DWord -Force
        Set-ItemProperty -Path $_.PSPath -Name IconTip -Value '悬浮工作台' -Force -ErrorAction SilentlyContinue
      }
    }
  }
} catch {}

Write-TrayLog 'visible tray-host ready'
[System.Windows.Forms.Application]::Run()
