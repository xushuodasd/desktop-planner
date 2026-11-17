' Launch pristine portable build (no electron-builder integrity patch)
Option Explicit
Dim sh, fso, root, exe, ud
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(root, "dist\portable\DesktopPlanner.exe")
ud = sh.ExpandEnvironmentStrings("%APPDATA%\desktop-planner\appdata")
If Not fso.FileExists(exe) Then
  MsgBox "Missing portable build." & vbCrLf & "Run: powershell -ExecutionPolicy Bypass -File scripts\make-portable.ps1", vbExclamation, "Desktop Planner"
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
WScript.Sleep 4000
Dim wmi, procs
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("Select * from Win32_Process Where Name='DesktopPlanner.exe'")
If procs.Count > 0 Then
  MsgBox "Started OK. Look for the floating ball on the desktop.", vbInformation, "Desktop Planner"
  WScript.Quit 0
End If
MsgBox "Still failed." & vbCrLf & _
       "1) Confirm the build has no Low integrity label:" & vbCrLf & _
       "   icacls dist\portable /setintegritylevel (OI)(CI)M /T" & vbCrLf & _
       "2) SmartScreen: More info -> Run anyway" & vbCrLf & _
       "3) Send %TEMP%\desktop-planner-early.log if it appears", vbExclamation, "Desktop Planner"
