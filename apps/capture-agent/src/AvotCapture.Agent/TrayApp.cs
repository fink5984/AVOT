using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace AvotCapture.Agent;

/// <summary>System-tray presence: status at a glance, pairing, storage folder, autostart, camera mode.</summary>
public sealed class TrayApp : IDisposable
{
    private readonly AgentHost _host;
    private readonly NotifyIcon _icon;
    private readonly ToolStripMenuItem _status = new() { Enabled = false };
    private readonly ToolStripMenuItem _camera = new() { Enabled = false };
    private readonly ToolStripMenuItem _queue = new() { Enabled = false };
    private readonly ToolStripMenuItem _server = new() { Enabled = false };
    private readonly ToolStripMenuItem _autostart = new("הפעלה אוטומטית עם Windows") { CheckOnClick = true };
    private readonly ToolStripMenuItem _modeCanon = new("Canon EDSDK");
    private readonly ToolStripMenuItem _modeSim = new("סימולטור (בדיקות בלבד)");
    private readonly System.Windows.Forms.Timer _refresh = new() { Interval = 2000 };
    private readonly SynchronizationContext _ui;

    public TrayApp(AgentHost host)
    {
        _host = host;
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        var menu = new ContextMenuStrip { RightToLeft = RightToLeft.Yes, ShowImageMargin = false };
        menu.Items.Add(new ToolStripMenuItem($"AVOT Capture Agent {AgentHost.Version}") { Enabled = false, Font = new Font(menu.Font, FontStyle.Bold) });
        menu.Items.AddRange([_status, _camera, _queue, _server, new ToolStripSeparator()]);
        menu.Items.Add("פתיחת AVOT Studio", null, (_, _) => OpenUrl(_host.Settings.ServerUrl));
        menu.Items.Add("פתיחת תיקיית הצילומים", null, (_, _) => Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_host.Settings.StorageRoot}\"") { UseShellExecute = true }));
        menu.Items.Add("צימוד לשרת…", null, (_, _) => ShowPairing());
        var mode = new ToolStripMenuItem("מצב מצלמה");
        mode.DropDownItems.AddRange([_modeCanon, _modeSim]);
        _modeCanon.Click += async (_, _) => await _host.SwitchCameraModeAsync("CANON");
        _modeSim.Click += async (_, _) =>
        {
            if (MessageBox.Show("במצב סימולטור העמדה תפיק תמונות בדיקה מסומנות ולא צילומים אמיתיים. להמשיך?", "AVOT Capture Agent", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign) == DialogResult.Yes)
                await _host.SwitchCameraModeAsync("SIMULATOR");
        };
        menu.Items.Add(mode);
        _autostart.Checked = AutoStart.IsEnabled();
        _autostart.CheckedChanged += (_, _) =>
        {
            AutoStart.Set(_autostart.Checked);
            _host.Settings.AutoStart = _autostart.Checked;
            _host.Settings.Save();
        };
        menu.Items.Add(_autostart);
        menu.Items.Add("תיקיית יומנים", null, (_, _) => Process.Start(new ProcessStartInfo("explorer.exe", $"\"{Path.Combine(AvotCapture.Core.AgentSettings.Folder, "logs")}\"") { UseShellExecute = true }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("יציאה", null, (_, _) => Exit());

        _icon = new NotifyIcon { Icon = MakeIcon(Color.FromArgb(146, 124, 93)), Visible = true, ContextMenuStrip = menu, Text = "AVOT Capture Agent" };
        _icon.DoubleClick += (_, _) => OpenUrl(_host.Settings.ServerUrl);
        if (_host.Settings.AutoStart && !_autostart.Checked) _autostart.Checked = true;
        _host.Changed += () => _ui.Post(_ => Refresh(), null);
        _refresh.Tick += (_, _) => Refresh();
        _refresh.Start();
        Refresh();
    }

    private void Refresh()
    {
        var s = _host.Camera?.GetStatus();
        var (pending, failed, _) = _host.Store.QueueStats();
        var lease = _host.Leases.Active;
        _status.Text = lease is null ? "מצב: ממתין לחיבור ממסך הצילום" : $"בשליטת: {lease.UserName}";
        _camera.Text = s is { Connected: true } ? $"מצלמה: {s.Model}" : $"מצלמה: {_host.CameraError ?? "לא מחוברת"}";
        _queue.Text = failed > 0 ? $"ממתינות להעלאה: {pending} · דורשות טיפול: {failed}" : $"ממתינות להעלאה: {pending}";
        _server.Text = !_host.Settings.IsPaired ? "לא מצומד לשרת" : _host.ServerError ?? $"מצומד: {_host.Settings.DeviceName}";
        _modeCanon.Checked = _host.Settings.CameraMode == "CANON";
        _modeSim.Checked = _host.Settings.CameraMode == "SIMULATOR";
        var tone = !_host.Settings.IsPaired || _host.ServerError is not null || failed > 0 ? Color.FromArgb(155, 59, 46)
            : s is { Connected: true } ? Color.FromArgb(56, 90, 76) : Color.FromArgb(146, 124, 93);
        var old = _icon.Icon;
        _icon.Icon = MakeIcon(tone);
        old?.Dispose();
        var tip = $"AVOT Capture Agent — {(s is { Connected: true } ? "מצלמה מחוברת" : "אין מצלמה")} · {pending} ממתינות";
        _icon.Text = tip.Length > 63 ? tip[..63] : tip;
    }

    public void ShowPairing()
    {
        using var f = new PairingForm(_host);
        f.ShowDialog();
        Refresh();
    }

    private static void OpenUrl(string? url)
    {
        if (!string.IsNullOrEmpty(url)) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private void Exit()
    {
        var (pending, _, _) = _host.Store.QueueStats();
        if (pending > 0 && MessageBox.Show($"{pending} צילומים שמורים בעמדה וטרם הועלו. הם לא יאבדו ויועלו בהפעלה הבאה. לצאת בכל זאת?", "AVOT Capture Agent", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign) != DialogResult.Yes)
            return;
        _icon.Visible = false;
        Application.Exit();
    }

    /// <summary>Small round "A" glyph tinted by state (generated, so no binary assets in the repo).</summary>
    private static Icon MakeIcon(Color tone)
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var b = new SolidBrush(tone);
            g.FillEllipse(b, 1, 1, 30, 30);
            using var f = new Font("Georgia", 17, FontStyle.Bold, GraphicsUnit.Pixel);
            var sz = g.MeasureString("A", f);
            g.DrawString("A", f, Brushes.White, (32 - sz.Width) / 2 + 1, (32 - sz.Height) / 2 + 1);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    public void Dispose()
    {
        _refresh.Dispose();
        _icon.Dispose();
    }
}
