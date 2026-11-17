' Desktop Planner launcher (ASCII-only; WScript rejects UTF-8 Chinese)
' Prefer runtime\DesktopPlanner.exe; fallback copy from electron.exe
Option Explicit

Dim fso, shell, rootDir, exePath, appDir, electronPath, logFile, ts
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronPath = fso.BuildPath(rootDir, "runtime\electron.exe")
exePath = fso.BuildPath(rootDir, "runtime\DesktopPlanner.exe")
appDir = fso.BuildPath(rootDir, "app")
logFile = fso.BuildPath(rootDir, "data\launch-vbs.log")
If Not fso.FolderExists(fso.BuildPath(rootDir, "data")) Then fso.CreateFolder fso.BuildPath(rootDir, "data")
' Chromium 不会自动创建 --user-data-dir 指向的目录
If Not fso.FolderExists(fso.BuildPath(rootDir, "data\appdata")) Then fso.CreateFolder fso.BuildPath(rootDir, "data\appdata")

Sub Log(msg)
  Set ts = fso.OpenTextFile(logFile, 8, True)
  ts.WriteLine Now & " " & msg
  ts.Close
End Sub

If Not fso.FileExists(exePath) Then
    If fso.FileExists(electronPath) Then
        fso.CopyFile electronPath, exePath, True
        Log "copied electron.exe -> DesktopPlanner.exe"
    End If
End If

If Not fso.FileExists(exePath) Then
    Log "missing exe"
    MsgBox "Missing runtime\DesktopPlanner.exe" & vbCrLf & _
           "Run: powershell -ExecutionPolicy Bypass -File scripts\setup-runtime.ps1" & vbCrLf & _
           "at: " & rootDir, _
           vbExclamation, "Desktop Planner"
    WScript.Quit 1
End If

Log "run " & exePath & " " & appDir
shell.CurrentDirectory = rootDir
' 1 = normal window (0=hidden can make Electron look like "nothing happened")
shell.Run """" & exePath & """ --no-sandbox --user-data-dir=""" & fso.BuildPath(rootDir, "data\appdata") & """ """ & appDir & """", 1, False
Log "started"
