' Launch pristine portable build (no electron-builder integrity patch)
Option Explicit
Dim sh, fso, root, exe, log, wmi, procs
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(root, "dist\portable\DesktopPlanner.exe")
log = fso.BuildPath(sh.ExpandEnvironmentStrings("%TEMP%"), "desktop-planner-early.log")
If fso.FileExists(log) Then fso.DeleteFile log, True
If Not fso.FileExists(exe) Then
  MsgBox "Missing portable build." & vbCrLf & "Run: powershell -ExecutionPolicy Bypass -File scripts\make-portable.ps1", vbExclamation, "Desktop Planner"
  WScript.Quit 1
End If
sh.CurrentDirectory = fso.GetParentFolderName(exe)
sh.Run """" & exe & """ --disable-gpu", 1, False
WScript.Sleep 4000
If fso.FileExists(log) Then
  MsgBox "Started OK. Look for the floating ball on the desktop.", vbInformation, "Desktop Planner"
  WScript.Quit 0
End If
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("Select * from Win32_Process Where Name='DesktopPlanner.exe'")
If procs.Count > 0 Then
  MsgBox "Process is running (ball may be off-screen / docked).", vbInformation, "Desktop Planner"
  WScript.Quit 0
End If
MsgBox "Still failed." & vbCrLf & _
       "1) Run from Explorer (not Cursor terminal)" & vbCrLf & _
       "2) SmartScreen: More info -> Run anyway" & vbCrLf & _
       "3) Send %TEMP%\desktop-planner-early.log if it appears", vbExclamation, "Desktop Planner"
