namespace AvotCapture.Agent;

/// <summary>Pair this PC with AVOT Studio using the 8-digit code from Settings › Capture Stations.</summary>
public sealed class PairingForm : Form
{
    private readonly AgentHost _host;
    private readonly TextBox _server = new() { Width = 320, RightToLeft = RightToLeft.No };
    private readonly TextBox _code = new() { Width = 160, RightToLeft = RightToLeft.No, MaxLength = 9, Font = new Font("Consolas", 14) };
    private readonly TextBox _name = new() { Width = 320 };
    private readonly Label _message = new() { AutoSize = false, Width = 340, Height = 48, ForeColor = Color.FromArgb(155, 59, 46) };
    private readonly Button _pair = new() { Text = "צימוד", Width = 100, Height = 32 };

    public PairingForm(AgentHost host)
    {
        _host = host;
        Text = "AVOT Capture Agent — צימוד לשרת";
        RightToLeft = RightToLeft.Yes;
        RightToLeftLayout = true;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10);
        ClientSize = new Size(380, 330);
        BackColor = Color.FromArgb(252, 251, 248);

        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(18), WrapContents = false };
        layout.Controls.Add(new Label { Text = "במסך ״עמדות צילום״ באתר לחצו ״צימוד עמדה חדשה״ והעתיקו לכאן את הכתובת והקוד.", AutoSize = false, Width = 340, Height = 44 });
        layout.Controls.Add(new Label { Text = "כתובת השרת", AutoSize = true });
        layout.Controls.Add(_server);
        layout.Controls.Add(new Label { Text = "קוד צימוד (8 ספרות)", AutoSize = true });
        layout.Controls.Add(_code);
        layout.Controls.Add(new Label { Text = "שם העמדה", AutoSize = true });
        layout.Controls.Add(_name);
        layout.Controls.Add(_message);
        layout.Controls.Add(_pair);
        Controls.Add(layout);

        _server.Text = host.Settings.ServerUrl ?? "https://";
        _name.Text = host.Settings.DeviceName ?? Environment.MachineName;
        if (host.Settings.IsPaired)
        {
            _message.ForeColor = Color.FromArgb(56, 90, 76);
            _message.Text = $"העמדה מצומדת כעת כ״{host.Settings.DeviceName}״. צימוד חדש יחליף את הקיים.";
        }
        AcceptButton = _pair;
        _pair.Click += async (_, _) => await PairAsync();
    }

    private async Task PairAsync()
    {
        _pair.Enabled = false;
        _message.ForeColor = Color.FromArgb(74, 79, 76);
        _message.Text = "מצמד…";
        try
        {
            await _host.PairAsync(_server.Text, _code.Text, _name.Text.Trim(), CancellationToken.None);
            MessageBox.Show($"העמדה צומדה בהצלחה כ״{_host.Settings.DeviceName}״.\nאפשר לבחור אותה במסך הצילום.", "AVOT Capture Agent", MessageBoxButtons.OK, MessageBoxIcon.Information, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
            Close();
        }
        catch (Exception ex)
        {
            _message.ForeColor = Color.FromArgb(155, 59, 46);
            _message.Text = ex.Message;
        }
        finally
        {
            _pair.Enabled = true;
        }
    }
}
