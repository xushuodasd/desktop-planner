' 悬浮工作台 —— 免控制台窗口启动（.lnk 之外的备用启动方式）
' 逻辑：按脚本自身位置定位项目根（与双击/运行时的当前目录无关）-> runtime\electron.exe -> 以 app 目录为参数启动
' 前置：已运行 scripts\setup-runtime.ps1 解压出 runtime\electron.exe
Option Explicit

Dim fso, shell, rootDir, exePath, appDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

rootDir = fso.GetParentFolderName(WScript.ScriptFullName)

exePath = fso.BuildPath(rootDir, "runtime\electron.exe")
appDir = fso.BuildPath(rootDir, "app")

If Not fso.FileExists(exePath) Then
    MsgBox "未找到 runtime\electron.exe（按脚本位置定位：" & exePath & "）。" & vbCrLf & _
           "请先在项目根目录运行：" & vbCrLf & _
           "powershell -ExecutionPolicy Bypass -File scripts\setup-runtime.ps1", _
           vbExclamation, "悬浮工作台"
    WScript.Quit 1
End If

shell.CurrentDirectory = rootDir
shell.Run """" & exePath & """ """ & appDir & """", 0, False
