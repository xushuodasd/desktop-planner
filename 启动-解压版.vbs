' Launch unpacked DesktopPlanner (ASCII-only)
Option Explicit
Dim sh, fso, root, exe, log, wmi, procs
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(root, "dist\win-unpacked\DesktopPlanner.exe")
log = fso.BuildPath(sh.ExpandEnvironmentStrings("%TEMP%"), "desktop-planner-early.log")
If fso.FileExists(log) Then fso.DeleteFile log, True
If Not fso.FileExists(exe) Then
  MsgBox "Missing: " & exe & vbCrLf & "Run: npm run dist:dir", vbExclamation, "Desktop Planner"
  WScript.Quit 1
End If
sh.CurrentDirectory = fso.GetParentFolderName(exe)
sh.Run """" & exe & """ --disable-gpu", 1, False
WScript.Sleep 3500
If fso.FileExists(log) Then WScript.Quit 0
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("Select * from Win32_Process Where Name='DesktopPlanner.exe'")
If procs.Count > 0 Then WScript.Quit 0
MsgBox "Process exited and no early log." & vbCrLf & _
       "Please double-click: 诊断启动.bat" & vbCrLf & _
       "and send me the text it shows." & vbCrLf & exe, vbExclamation, "Desktop Planner"
