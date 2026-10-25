using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Text;
using AvotCapture.Core;

namespace AvotCapture.Simulator;

/// <summary>
/// Test camera for development and automated tests. Produces real JPEG files
/// watermarked "SIMULATOR" (and, optionally, a placeholder ".CR3" that is
/// clearly not a real RAW) through exactly the same staging → coordinator →
/// store → upload path as the Canon adapter. Failure injection: next shot
/// fails, disconnect, slow transfer.
/// </summary>
public sealed class SimulatorCamera : ICameraDevice
{
    private readonly Func<string, string> _stagingPathFor;
    private bool _connected;
    private volatile byte[]? _frame;
    private Timer? _liveTimer;
    private int _frameNo;
    private int _shotNo;

    public bool RawPlusJpeg { get; set; }
    public bool FailNext { get; set; }
    public int TransferLatencyMs { get; set; } = 400;
    public Size ImageSize { get; set; } = new(3000, 2000);

    public string Kind => "SIMULATOR";
    public int FilesPerShot => RawPlusJpeg ? 2 : 1;
    public event Action<CameraFileReady>? FileReady;
    public event Action<string>? Disconnected;
    public event Action? StatusChanged;

    public SimulatorCamera(Func<string, string> stagingPathFor) => _stagingPathFor = stagingPathFor;

    public Task ConnectAsync(CancellationToken ct)
    {
        _connected = true;
        StatusChanged?.Invoke();
        return Task.CompletedTask;
    }

    public Task DisconnectAsync()
    {
        _connected = false;
        _liveTimer?.Dispose();
        _liveTimer = null;
        StatusChanged?.Invoke();
        return Task.CompletedTask;
    }

    /// <summary>Simulates unplugging the USB cable.</summary>
    public void SimulateUnplug()
    {
        _connected = false;
        _liveTimer?.Dispose();
        _liveTimer = null;
        Disconnected?.Invoke("הסימולטור נותק (הדמיה)");
    }

    public CameraStatus GetStatus() => new()
    {
        Kind = "SIMULATOR",
        Model = "AVOT Simulator (לא מצלמה אמיתית)",
        Connected = _connected,
        Battery = 100,
        LiveView = _liveTimer is not null,
        Resolution = new Resolution(ImageSize.Width, ImageSize.Height),
        Formats = [RawPlusJpeg ? "RAW + JPEG (מדומה)" : "JPEG"],
        CanAutofocus = true,
        HardwareShutter = false,
        Controls =
        [
            new CameraControl("failNext", "כשל בצילום הבא", "toggle", FailNext),
            new CameraControl("rawPlusJpeg", "RAW + JPEG (מדומה)", "toggle", RawPlusJpeg),
            new CameraControl("latency", "השהיית העברה", "select", TransferLatencyMs.ToString(),
                [new("150", "מהירה"), new("400", "רגילה"), new("2500", "איטית")]),
            new CameraControl("unplug", "הדמיית ניתוק USB", "action", null),
        ],
        Readouts = [new Readout("מצב", "סימולטור — קבצי בדיקה בלבד")],
    };

    public Task TriggerShutterAsync(CancellationToken ct)
    {
        if (!_connected) throw new CameraException("הסימולטור אינו מחובר");
        if (FailNext)
        {
            FailNext = false;
            throw new CameraException("כשל מדומה בצילום (סימולטור)");
        }
        var shot = Interlocked.Increment(ref _shotNo);
        _ = Task.Run(async () =>
        {
            await Task.Delay(TransferLatencyMs, ct);
            var name = $"SIM_{shot:0000}.JPG";
            var jpgPath = _stagingPathFor(name);
            var bytes = Render(ImageSize, $"SIMULATOR · shot {shot} · {DateTime.Now:HH:mm:ss.fff}");
            await File.WriteAllBytesAsync(jpgPath, bytes, ct);
            FileReady?.Invoke(new CameraFileReady(jpgPath, name, bytes.Length, ImageSize.Width, ImageSize.Height));
            if (RawPlusJpeg)
            {
                await Task.Delay(TransferLatencyMs / 2, ct);
                var rawName = $"SIM_{shot:0000}.CR3";
                var rawPath = _stagingPathFor(rawName);
                var raw = Encoding.ASCII.GetBytes("AVOT-SIMULATED-RAW — NOT A REAL CANON RAW FILE\n").Concat(Enumerable.Repeat((byte)0x5A, 512 * 1024)).ToArray();
                await File.WriteAllBytesAsync(rawPath, raw, ct);
                FileReady?.Invoke(new CameraFileReady(rawPath, rawName, raw.Length));
            }
        }, ct);
        return Task.CompletedTask;
    }

    public Task SetControlAsync(string id, string value, CancellationToken ct)
    {
        switch (id)
        {
            case "failNext": FailNext = value is "true" or "True"; break;
            case "rawPlusJpeg": RawPlusJpeg = value is "true" or "True"; break;
            case "latency": TransferLatencyMs = int.Parse(value); break;
            case "unplug": SimulateUnplug(); return Task.CompletedTask;
            default: throw new CameraException("הגדרה לא נתמכת");
        }
        StatusChanged?.Invoke();
        return Task.CompletedTask;
    }

    public Task AutofocusAsync(CancellationToken ct) => Task.Delay(200, ct);

    public byte[]? LatestLiveViewFrame => _frame;

    public Task StartLiveViewAsync(CancellationToken ct)
    {
        _liveTimer ??= new Timer(_ => _frame = Render(new Size(960, 640), $"LIVE · {Interlocked.Increment(ref _frameNo)}"), null, 0, 100);
        return Task.CompletedTask;
    }

    public Task StopLiveViewAsync()
    {
        _liveTimer?.Dispose();
        _liveTimer = null;
        _frame = null;
        return Task.CompletedTask;
    }

    internal static byte[] Render(Size size, string caption)
    {
        using var bmp = new Bitmap(size.Width, size.Height, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var s = size.Width / 1200f;
            g.Clear(Color.FromArgb(43, 46, 44));
            var page = new RectangleF(240 * s, 60 * s, 720 * s, size.Height - 120 * s);
            using (var paper = new SolidBrush(Color.FromArgb(239, 230, 210))) g.FillRectangle(paper, page);
            using (var ink = new SolidBrush(Color.FromArgb(58, 47, 34)))
            {
                for (var i = 0; i < 14; i++) g.FillRectangle(ink, page.X + 80 * s, page.Y + (120 + i * 30) * s, page.Width - 160 * s, 5 * s);
            }
            using var font = new Font("Arial", 80 * s, FontStyle.Bold, GraphicsUnit.Pixel);
            using var red = new SolidBrush(Color.FromArgb(110, 155, 59, 46));
            g.TranslateTransform(size.Width / 2f, size.Height / 2f);
            g.RotateTransform(-20);
            var text = "SIMULATOR";
            var m = g.MeasureString(text, font);
            g.DrawString(text, font, red, -m.Width / 2, -m.Height / 2);
            g.ResetTransform();
            using var small = new Font("Consolas", 16 * s, GraphicsUnit.Pixel);
            g.DrawString(caption, small, Brushes.WhiteSmoke, 16 * s, size.Height - 34 * s);
        }
        using var ms = new MemoryStream();
        var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var p = new EncoderParameters(1);
        p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 88L);
        bmp.Save(ms, codec, p);
        return ms.ToArray();
    }

    public ValueTask DisposeAsync()
    {
        _liveTimer?.Dispose();
        return ValueTask.CompletedTask;
    }
}
