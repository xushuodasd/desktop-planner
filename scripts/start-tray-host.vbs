' Launch tray-host.ps1 via WScript (ASCII-only; WScript rejects UTF-8 Chinese)
' Optional args: RootDir ExePath AppDir IconPath
Option Explicit
Dim sh, fso, root, exe, app, icon, ps1, cmd, logFile, ts, args
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments

If args.Count >= 4 Then
  root = args(0)
  exe = args(1)
  app = args(2)
  icon = args(3)
Else
  root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
  exe = fso.BuildPath(root, "runtime\DesktopPlanner.exe")
  app = fso.BuildPath(root, "app")
  icon = fso.BuildPath(root, "app\assets\tray-win.ico")
  If Not fso.FileExists(icon) Then icon = fso.BuildPath(root, "app\assets\icon.ico")
  If Not fso.FileExists(exe) Then exe = fso.BuildPath(root, "runtime\electron.exe")
End If

ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "tray-host.ps1")
logFile = fso.BuildPath(sh.ExpandEnvironmentStrings("%TEMP%"), "desktop-planner-tray-vbs.log")

If Not fso.FileExists(ps1) Then
  WriteLog "missing tray-host.ps1 at " & ps1
  WScript.Quit 1
End If

cmd = "powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -RootDir """ & root & """ -ExePath """ & exe & """ -AppDir """ & app & """ -IconPath """ & icon & """"
WriteLog "run: " & cmd
sh.Run cmd, 0, False
WriteLog "started"

Sub WriteLog(msg)
  On Error Resume Next
  Set ts = fso.OpenTextFile(logFile, 8, True)
  ts.WriteLine Now & " " & msg
  ts.Close
  On Error GoTo 0
End Sub
