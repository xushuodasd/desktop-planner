' Launch unpacked DesktopPlanner (ASCII-only)
Option Explicit
Dim sh, fso, root, exe, ud
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(root, "dist\win-unpacked\DesktopPlanner.exe")
ud = sh.ExpandEnvironmentStrings("%APPDATA%\desktop-planner\appdata")
If Not fso.FileExists(exe) Then
  MsgBox "Missing: " & exe & vbCrLf & "Run: npm run dist:dir", vbExclamation, "Desktop Planner"
  WScript.Quit 1
End If
' Chromium 不会自动创建 --user-data-dir；目录缺失时进程在 main.js 之前就退出（ProcessSingleton Error 3）
If Not fso.FolderExists(fso.GetParentFolderName(ud)) Then
  On Error Resume Next
  fso.CreateFolder fso.GetParentFolderName(ud)
  If Err.Number <> 0 Then Err.Clear
  On Error GoTo 0
End If
If Not fso.FolderExists(ud) Then
  On Error Resume Next
  fso.CreateFolder ud
  If Err.Number <> 0 Then Err.Clear
  On Error GoTo 0
End If
sh.CurrentDirectory = fso.GetParentFolderName(exe)
sh.Run """" & exe & """ --no-sandbox --disable-gpu --user-data-dir=""" & ud & """", 1, False
WScript.Sleep 3500
Dim wmi, procs
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("Select * from Win32_Process Where Name='DesktopPlanner.exe'")
If procs.Count > 0 Then WScript.Quit 0
MsgBox "Process exited right after start." & vbCrLf & _
       "Check (1) Low integrity label:" & vbCrLf & _
       "   icacls dist\win-unpacked /setintegritylevel (OI)(CI)M /T" & vbCrLf & _
       "(2) %TEMP%\desktop-planner-early.log" & vbCrLf & exe, vbExclamation, "Desktop Planner"
