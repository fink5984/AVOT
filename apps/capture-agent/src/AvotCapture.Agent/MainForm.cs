using System.Diagnostics;
using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

/// <summary>
/// The management window of AVOT Capture Desktop. It only shows state and offers maintenance actions; the capture
/// engine (camera, local storage, upload) lives in <see cref="AgentHost"/> and keeps running when this window is
/// closed. Shooting itself always happens in the AVOT Studio web app — this is not a second capture screen.
/// </summary>
public sealed class MainForm : Form
{
    private readonly AgentHost _host;
    private readonly ILoggerFactory _logs;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 2000 };
    private readonly Dictionary<string, Label> _values = [];
    private readonly Button _updateNow = new() { Text = "עדכן עכשיו", AutoSize = true, Visible = false };
    private readonly CheckBox _autostart = new() { Text = "הפעלה אוטומטית עם Windows", AutoSize = true };
    private readonly CheckBox _autoUpdate = new() { Text = "עדכונים אוטומטיים", AutoSize = true };
    private readonly Label _busy = new() { AutoSize = true, ForeColor = Color.DimGray };
    private bool _closing;

    public MainForm(AgentHost host, ILoggerFactory logs)
    {
        _host = host;
        _logs = logs;
        Text = $"AVOT Capture Desktop {AgentHost.Version}";
        RightToLeft = RightToLeft.Yes;
        RightToLeftLayout = true;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10f);
        ClientSize = new Size(760, 640);
        MinimumSize = new Size(700, 600);
        ShowInTaskbar = true;

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(16) };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(root);

        root.Controls.Add(new Label { Text = "מצב העמדה", Font = new Font(Font.FontFamily, 15f, FontStyle.Bold), AutoSize = true }, 0, 0);

        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoScroll = true, Padding = new Padding(0, 8, 0, 8) };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (var (key, title) in new[]
                 {
                     ("camera", "מצלמה"), ("usb", "חיבור USB"), ("edsdk", "Canon EDSDK"), ("server", "חיבור לשרת"), ("pair", "צימוד"),
                     ("queue", "תמונות שממתינות להעלאה"), ("errors", "שגיאות העלאה"), ("disk", "מקום פנוי בדיסק"), ("storage", "תיקיית תמונות"),
                     ("version", "גרסת התוכנה"), ("update", "עדכונים"),
                     ("printer", "מדפסת תוויות"), ("printstate", "מצב ההדפסה"), ("printqueue", "תור הדפסות"),
                 })
        {
            grid.Controls.Add(new Label { Text = title, AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(3, 6, 3, 6) });
            var v = new Label { AutoSize = true, MaximumSize = new Size(480, 0), Margin = new Padding(3, 6, 3, 6) };
            _values[key] = v;
            grid.Controls.Add(v);
        }
        grid.Controls.Add(new Label());
        grid.Controls.Add(_updateNow);
        root.Controls.Add(grid, 0, 1);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true, FlowDirection = FlowDirection.RightToLeft };
        void Add(string text, Func<Task> run)
        {
            var b = new Button { Text = text, AutoSize = true, Padding = new Padding(8, 4, 8, 4) };
            b.Click += async (_, _) => await Guard(b, run);
            actions.Controls.Add(b);
        }
        Add("חיבור מחדש למצלמה", async () =>
        {
            await _host.ReconnectCameraAsync();
            Info("המצלמה מתחברת מחדש. זה לוקח כמה שניות.");
        });
        Add("צילום ניסיון", async () =>
        {
            var path = await _host.TestShotAsync(CancellationToken.None);
            Info($"צילום הניסיון הצליח.\nהקובץ נשמר (ולא מועלה, ולא משויך לספר):\n{path}");
        });
        Add("פתיחת תיקיית תמונות", () =>
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_host.Settings.StorageRoot}\"") { UseShellExecute = true });
            return Task.CompletedTask;
        });
        Add("פתיחת מערכת אבות", () =>
        {
            if (!string.IsNullOrEmpty(_host.Settings.ServerUrl)) Process.Start(new ProcessStartInfo(_host.Settings.ServerUrl) { UseShellExecute = true });
            return Task.CompletedTask;
        });
        Add("הצגת שגיאות", () =>
        {
            ShowErrors();
            return Task.CompletedTask;
        });
        Add("הגדרת תיקיית אחסון", () =>
        {
            ChooseStorage();
            return Task.CompletedTask;
        });
        Add("בדיקת מערכת", async () =>
        {
            var lines = await SystemCheck.RunAsync(_host.Settings, _host, _logs, CancellationToken.None);
            Info(string.Join("\n", lines.Select(l => $"{(l.Ok ? "✔" : "✘")} {l.Title}: {l.Detail}")));
        });
        Add("ייבוא Canon EDSDK…", async () =>
        {
            using var dlg = new OpenFileDialog { Title = "בחרו את חבילת ה-ZIP של Canon EDSDK (Windows x64)", Filter = "ZIP|*.zip" };
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            var r = SdkImporter.Import(dlg.FileName, _host.Settings);
            Info(r.Message);
            if (r.Ok) await _host.ReconnectCameraAsync();
        });
        Add("בחירת מדפסת תוויות…", () =>
        {
            ChoosePrinter();
            return Task.CompletedTask;
        });
        Add("הדפסת ניסיון (תווית)", async () =>
        {
            await _host.Printing.TestPrintAsync(CancellationToken.None);
            Info("הדפסת הניסיון נשלחה לתור. היא תצא במדפסת תוך כמה שניות.");
        });
        Add("חיבור מחדש למדפסת", () =>
        {
            _host.Printing.Poke();
            Info("שירות ההדפסה בודק את המדפסת והשרת מחדש.");
            return Task.CompletedTask;
        });
        Add("בדיקת עדכונים", async () =>
        {
            await _host.Updates.CheckNowAsync(CancellationToken.None);
            Info(_host.Updates.Status);
        });
        root.Controls.Add(actions, 0, 2);

        var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(16, 0, 16, 10) };
        footer.Controls.AddRange([_autostart, _autoUpdate, _busy]);
        Controls.Add(footer);

        _autostart.Checked = AutoStart.IsEnabled();
        _autostart.CheckedChanged += (_, _) =>
        {
            AutoStart.Set(_autostart.Checked);
            _host.Settings.AutoStart = _autostart.Checked;
            _host.Settings.Save();
        };
        _autoUpdate.Checked = _host.Settings.AutoUpdate;
        _autoUpdate.CheckedChanged += (_, _) =>
        {
            _host.Settings.AutoUpdate = _autoUpdate.Checked;
            _host.Settings.Save();
        };
        _updateNow.Click += async (_, _) => await Guard(_updateNow, async () =>
        {
            if (!await _host.Updates.TryApplyAsync(CancellationToken.None, force: true)) Info(_host.Updates.Status);
        });

        _timer.Tick += (_, _) => RefreshState();
        VisibleChanged += (_, _) =>
        {
            _timer.Enabled = Visible;
            if (Visible) RefreshState();
        };
    }

    /// <summary>Closing the window hides it — the capture engine keeps running in the tray.</summary>
    public void ReallyClose()
    {
        _closing = true;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_closing && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    private async Task Guard(Control button, Func<Task> run)
    {
        button.Enabled = false;
        _busy.Text = "מבצע…";
        try
        {
            await run();
        }
        catch (Exception ex) when (ex is CameraException or CaptureRejectedException or ServerException or InvalidOperationException or IOException)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
        }
        finally
        {
            button.Enabled = true;
            _busy.Text = "";
            RefreshState();
        }
    }

    private void Info(string message) =>
        MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Information, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);

    private void Set(string key, string text, bool? ok = null)
    {
        var l = _values[key];
        l.Text = text;
        l.ForeColor = ok switch { true => Color.FromArgb(40, 110, 70), false => Color.FromArgb(170, 50, 40), _ => SystemColors.ControlText };
    }

    private void RefreshState()
    {
        var s = _host.Camera?.GetStatus();
        var connected = s is { Connected: true };
        var (pending, failed, lastSync) = _host.Store.QueueStats();
        var sdk = SdkImporter.Detect(_host.Settings);
        var free = _host.Coordinator.FreeBytes();

        Set("camera", connected ? $"{s!.Model} · מחוברת" : $"לא מחוברת — {_host.CameraError ?? "ממתין למצלמה"}", connected);
        Set("usb", connected ? "תקין" : "לא זוהה מכשיר פעיל", connected);
        Set("edsdk", sdk.Installed ? $"מותקן · גרסה {sdk.Version ?? "?"}" : sdk.Problem ?? "לא מותקן", sdk.Installed);
        Set("server", !_host.Settings.IsPaired ? "לא מצומד" : _host.ServerError ?? "מחובר", _host.Settings.IsPaired && _host.ServerError is null);
        Set("pair", _host.Settings.IsPaired ? $"{_host.Settings.DeviceName} ← {_host.Settings.ServerUrl}" : "לא מצומד — לחצו על ״בדיקת מערכת״ או צמדו מהאתר", _host.Settings.IsPaired);
        Set("queue", $"{pending}" + (lastSync is { } t ? $" · סנכרון אחרון {t.LocalDateTime:dd/MM HH:mm}" : ""), pending == 0 ? true : null);
        Set("errors", failed == 0 ? "אין" : $"{failed} דורשות טיפול", failed == 0);
        Set("disk", $"{free / (1024.0 * 1024 * 1024):0.#} GB פנויים · {_host.Coordinator.DiskLevel() switch { "critical" => "קריטי", "low" => "נמוך", _ => "תקין" }}", _host.Coordinator.DiskLevel() == "ok");
        Set("storage", _host.Settings.StorageRoot);
        Set("version", AgentHost.Version);
        Set("update", _host.Updates.Status, _host.Updates.Available is null ? null : false);
        var s2 = _host.Settings;
        Set("printer", string.IsNullOrEmpty(s2.PrinterWindowsName) ? "לא נבחרה מדפסת" : $"{s2.PrinterWindowsName} · USB / Windows · מדבקה {s2.PrinterLabelSize.Replace("x", "×")} מ״מ · {(s2.PrinterLanguage == "GDI" ? "דרייבר Windows" : "ZPL")}", !string.IsNullOrEmpty(s2.PrinterWindowsName));
        var ps = _host.Printing;
        Set("printstate", $"{ps.Status}" + (ps.PrinterState is { } st && st != "OK" ? $" · {ps.PrinterDetail ?? st}" : ""), ps.PrinterState is null or "OK" ? null : false);
        var recent = ps.RecentJobs();
        var printFailed = recent.Count(j => j.State == "failed");
        Set("printqueue", $"בשרת ממתינות: {ps.Queue.Pending} · נכשלו היום: {ps.Queue.FailedToday} · במחשב זה נשלחו לאחרונה: {recent.Count(j => j.State == "sent")}" + (printFailed > 0 ? $" · נכשלו: {printFailed}" : ""), ps.Queue.FailedToday == 0 ? null : false);
        _updateNow.Visible = _host.Updates.ReadyToInstall;
    }

    /// <summary>Pick one of the printers Windows knows, the label size and the print mode; it becomes the system's primary label printer.</summary>
    private void ChoosePrinter()
    {
        using var dlg = new Form
        {
            Text = "מדפסת תוויות",
            RightToLeft = RightToLeft.Yes,
            RightToLeftLayout = true,
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ClientSize = new Size(520, 300),
            Font = Font,
        };
        var printers = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top };
        printers.Items.AddRange(WindowsPrinting.InstalledPrinters().Cast<object>().ToArray());
        printers.SelectedItem = _host.Settings.PrinterWindowsName ?? printers.Items.Cast<string>().FirstOrDefault(n => n.Contains("zebra", StringComparison.OrdinalIgnoreCase) || n.Contains("label", StringComparison.OrdinalIgnoreCase) || n.Contains("tsc", StringComparison.OrdinalIgnoreCase));
        var sizes = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top };
        foreach (var sz in new[] { "50x25", "57x32", "70x40", "100x50" }) sizes.Items.Add(sz);
        sizes.SelectedItem = _host.Settings.PrinterLabelSize;
        var mode = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top };
        mode.Items.AddRange(["דרייבר Windows (מומלץ — כל מדפסת)", "ZPL ישיר (Zebra ותואמות)"]);
        mode.SelectedIndex = _host.Settings.PrinterLanguage == "ZPL" ? 1 : 0;
        var ok = new Button { Text = "הגדרה כמדפסת אבות הראשית", AutoSize = true, DialogResult = DialogResult.OK, Dock = DockStyle.Bottom, Padding = new Padding(8, 6, 8, 6) };
        var hint = new Label { Text = "המדפסת משמשת את כל המשתמשים באתר. אינה חייבת להיות מדפסת ברירת המחדל של Windows.", AutoSize = false, Height = 38, Dock = DockStyle.Top, ForeColor = Color.DimGray };
        foreach (var (text, c) in new (string, Control)[] { ("אופן הדפסה", mode), ("גודל מדבקה (מ״מ)", sizes), ("מדפסת מתוך Windows", printers) })
        {
            dlg.Controls.Add(c);
            dlg.Controls.Add(new Label { Text = text, Dock = DockStyle.Top, Height = 24, Padding = new Padding(0, 6, 0, 0) });
        }
        dlg.Controls.Add(hint);
        dlg.Controls.Add(ok);
        dlg.AcceptButton = ok;
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        if (printers.SelectedItem is not string name) { Info("לא נבחרה מדפסת."); return; }
        var size = (string)sizes.SelectedItem!;
        var lang = mode.SelectedIndex == 1 ? "ZPL" : "GDI";
        _ = Guard(ok, async () =>
        {
            await _host.Printing.ConfigureAsync(name, size, lang, CancellationToken.None);
            Info($"המדפסת \"{name}\" הוגדרה כמדפסת הראשית. אפשר להדפיס תווית ניסיון.");
        });
    }

    private void ShowErrors()
    {
        var items = new List<string>();
        if (_host.CameraError is { } c) items.Add("מצלמה: " + c);
        if (_host.ServerError is { } sv) items.Add("שרת: " + sv);
        if (_host.Uploads.LastError is { } u) items.Add("העלאה: " + u);
        foreach (var r in _host.Store.WithStage(CaptureStage.FAILED, CaptureStage.NEEDS_ATTENTION).Take(50))
            items.Add($"{r.CreatedAt.LocalDateTime:dd/MM HH:mm} · {r.Stage} · {r.LastError ?? "—"}");
        Info(items.Count == 0 ? "אין שגיאות." : string.Join("\n", items));
    }

    private void ChooseStorage()
    {
        using var dlg = new FolderBrowserDialog { Description = "בחרו תיקייה לתמונות המקור. כל התמונות נשמרות כאן לפני ההעלאה.", SelectedPath = _host.Settings.StorageRoot };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        _host.Settings.StorageRoot = dlg.SelectedPath;
        _host.Settings.Save();
        Info("התיקייה נשמרה. היא תיכנס לתוקף כשהתוכנה תופעל מחדש (תמונות קיימות לא מועברות ולא נמחקות).");
    }
}
