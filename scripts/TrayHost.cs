// 悬浮工作台托盘宿主：WinForms NotifyIcon
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program
{
    static string LogPath;

    [STAThread]
    static void Main(string[] args)
    {
        string rootDir = Arg(args, "--root");
        string exePath = Arg(args, "--exe");
        string appDir = Arg(args, "--app");
        string iconPath = Arg(args, "--icon");

        try
        {
            if (string.IsNullOrEmpty(rootDir)) rootDir = AppDomain.CurrentDomain.BaseDirectory;
            Directory.CreateDirectory(Path.Combine(rootDir, "data"));
            LogPath = Path.Combine(rootDir, "data", "tray-host.log");
            Log("boot args=" + string.Join(" | ", args));

            if (string.IsNullOrEmpty(exePath) || string.IsNullOrEmpty(appDir))
            {
                Log("missing --exe/--app");
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Icon icon = null;
            try
            {
                if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
                {
                    icon = new Icon(iconPath);
                    Log("icon loaded " + iconPath);
                }
                else Log("icon missing " + iconPath);
            }
            catch (Exception ex)
            {
                Log("icon fail " + ex.Message);
            }
            if (icon == null) icon = SystemIcons.Application;

            var menu = new ContextMenuStrip();
            menu.Items.Add("打开/收起面板", null, (s, e) => OpenPanel(exePath, appDir, rootDir));
            menu.Items.Add("设置…", null, (s, e) => OpenPanel(exePath, appDir, rootDir, true));
            menu.Items.Add("退出", null, (s, e) => Quit());

            var notify = new NotifyIcon();
            notify.Icon = icon;
            notify.Text = "悬浮工作台";
            notify.ContextMenuStrip = menu;
            notify.MouseUp += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) OpenPanel(exePath, appDir, rootDir);
            };
            notify.Visible = true;
            Log("NotifyIcon Visible=true");

            try { notify.ShowBalloonTip(3000, "悬浮工作台", "托盘图标已就绪，点这里开合面板", ToolTipIcon.Info); }
            catch (Exception ex) { Log("balloon " + ex.Message); }

            TryPromote();
            Log("TrayHost ready");

            Application.ApplicationExit += (s, e) =>
            {
                try { notify.Visible = false; notify.Dispose(); } catch { }
                try { if (icon != null) icon.Dispose(); } catch { }
            };

            Application.Run();
            Log("Application.Run ended");
        }
        catch (Exception ex)
        {
            Log("FATAL " + ex);
        }
    }

    static void Log(string msg)
    {
        try
        {
            if (string.IsNullOrEmpty(LogPath)) return;
            File.AppendAllText(LogPath, DateTime.Now.ToString("o") + " " + msg + "\n");
        }
        catch { }
    }

    static string Arg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return "";
    }

    static void OpenPanel(string exePath, string appDir, string rootDir, bool openSettings = false)
    {
        try
        {
            string ud = string.IsNullOrEmpty(appDir)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "desktop-planner", "appdata")
                : Path.Combine(rootDir, "data", "appdata");
            string args = "--no-sandbox --user-data-dir=\"" + ud + "\"";
            Directory.CreateDirectory(ud);
            if (!string.IsNullOrEmpty(appDir)) args += " \"" + appDir + "\"";
            if (openSettings) args += " --open-settings";
            Process.Start(new ProcessStartInfo
            {
                FileName = exePath,
                Arguments = args,
                WorkingDirectory = rootDir,
                UseShellExecute = false,
            });
        }
        catch (Exception ex) { Log("OpenPanel " + ex.Message); }
    }

    static void Quit()
    {
        try
        {
            foreach (var p in Process.GetProcessesByName("DesktopPlanner"))
            {
                try { p.Kill(); } catch { }
            }
        }
        catch { }
        Application.Exit();
    }

    static void TryPromote()
    {
        try
        {
            using (var baseKey = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings", true))
            {
                if (baseKey == null) return;
                foreach (var name in baseKey.GetSubKeyNames())
                {
                    using (var sub = baseKey.OpenSubKey(name, true))
                    {
                        if (sub == null) continue;
                        var exe = Convert.ToString(sub.GetValue("ExecutablePath") ?? "");
                        var tip = Convert.ToString(sub.GetValue("IconTip") ?? "");
                        if (exe.IndexOf("TrayHost", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            tip.IndexOf("悬浮", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            sub.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                            sub.SetValue("IconTip", "悬浮工作台", RegistryValueKind.String);
                            Log("promoted " + name);
                        }
                    }
                }
            }
        }
        catch (Exception ex) { Log("promote " + ex.Message); }
    }
}
