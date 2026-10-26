using System.Diagnostics;
using System.Collections.Concurrent;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.DigiCam;

/// <summary>
/// Camera provider that drives a camera through a locally running digiCamControl
/// (open source, MIT) over its web server on 127.0.0.1. The agent stays the only
/// component the browser talks to; digiCamControl is never exposed.
///
/// What the provider does NOT assume: every control, option and command shown to
/// the user is read from digiCamControl at runtime (`list &lt;property&gt;`,
/// `list cmds`). A property the camera/driver does not report is simply absent.
///
/// Files: digiCamControl is told to save into a dedicated session folder; every
/// file that appears there (agent-triggered or from the camera's own shutter) is
/// waited for until its size is stable, then moved into the agent's staging
/// folder and handed to the coordinator — which owns association and durability.
///
/// HARDWARE STATUS: validated only against a protocol mock (see tests). Behaviour
/// with a physical EOS R7 is listed in docs/hardware-acceptance.md.
/// </summary>
public sealed class DigiCamControlCamera : ICameraDevice
{
    private static readonly (string Prop, string Label, bool ReadOnly)[] Props =
    [
        ("iso", "ISO", false),
        ("shutterspeed", "מהירות תריס", false),
        ("aperture", "צמצם", false),
        ("whitebalance", "איזון לבן", false),
        ("exposurecompensation", "פיצוי חשיפה", false),
        ("focusmode", "מצב פוקוס", false),
        ("compressionsetting", "פורמט ואיכות", false),
        ("mode", "מצב צילום (גלגל המצלמה)", true),
    ];

    private static readonly HashSet<string> ShotExtensions = new(StringComparer.OrdinalIgnoreCase) { ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".cr2", ".cr3", ".dng" };

    private readonly DigiCamOptions _opt;
    private readonly DigiCamClient _client;
    private readonly ILogger _log;
    private readonly Func<string, string> _stagingPathFor;
    private readonly SemaphoreSlim _cmdGate = new(1, 1);
    private readonly object _state = new();

    private CancellationTokenSource? _run;
    private volatile bool _connected;
    private volatile bool _liveView;
    private volatile bool _noAf;
    private bool _leftoversHandled;
    private volatile byte[]? _frame;
    private string? _model;
    private string? _lastError;
    private string? _exposureWarning;
    private int _outstandingFiles;
    private DateTimeOffset _outstandingSince;
    private DateTimeOffset _lastLaunch = DateTimeOffset.MinValue;
    private HashSet<string> _commands = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, IReadOnlyList<string>> _options = [];
    private readonly ConcurrentDictionary<string, string?> _values = [];
    private string? Val(string prop) => _values.TryGetValue(prop, out var v) ? v : null;
    private List<CameraControl> _focusSteps = [];

    public string Kind => "DIGICAM";
    public event Action<CameraFileReady>? FileReady;
    public event Action<string>? Disconnected;
    public event Action? StatusChanged;

    public DigiCamControlCamera(DigiCamOptions options, ILogger logger, Func<string, string> stagingPathFor, HttpMessageHandler? handler = null)
    {
        _opt = options;
        _log = logger;
        _stagingPathFor = stagingPathFor;
        _client = new DigiCamClient(options.BaseUrl, handler);
    }

    public byte[]? LatestLiveViewFrame => _frame;

    /// <summary>Predicted from the current quality setting; only "RAW and JPEG" is counted as two files.</summary>
    public int FilesPerShot
    {
        get
        {
            var q = (Val("compressionsetting") ?? "").ToUpperInvariant();
            var raw = q.Contains("RAW") || q.Contains("CR3") || q.Contains("CR2");
            var jpeg = q.Contains("JPEG") || q.Contains("JPG");
            return raw && jpeg ? 2 : 1;
        }
    }

    // ───────────────────────── connection ─────────────────────────

    public async Task ConnectAsync(CancellationToken ct)
    {
        StopLoops();
        await EnsureServerAsync(ct);

        var cameras = (await _client.ListAsync("cameras", ct)).Where(c => !c.Contains("no camera", StringComparison.OrdinalIgnoreCase)).ToList();
        if (cameras.Count == 0)
            throw new CameraException("digiCamControl פועל אך לא זיהה מצלמה. ודאו שהמצלמה מחוברת ב-USB, דולקת, ושאף תוכנה אחרת (EOS Utility) אינה משתמשת בה.");
        _model = cameras[0];

        Directory.CreateDirectory(_opt.SessionFolder);
        // only at agent start: after a reconnect, files in the folder may belong to a shot that is still in flight
        if (!_leftoversHandled)
        {
            SetAsideLeftovers();
            _leftoversHandled = true;
        }
        await _client.SetAsync("session.folder", _opt.SessionFolder, ct);
        try
        {
            await _client.SetAsync("transfer", _opt.TransferMode, ct);
        }
        catch (CameraException ex)
        {
            // keeps working with digiCamControl's own transfer setting; the file watcher does not depend on it
            _log.LogWarning(ex, "could not set transfer mode {Mode}", _opt.TransferMode);
        }

        _commands = new HashSet<string>(await SafeList("cmds", ct), StringComparer.OrdinalIgnoreCase);
        _focusSteps = _commands
            .Where(c => c.StartsWith("LiveView_Focus", StringComparison.OrdinalIgnoreCase) && !c.Equals("LiveView_Focus", StringComparison.OrdinalIgnoreCase))
            .OrderBy(c => c, StringComparer.OrdinalIgnoreCase)
            .Select(c => new CameraControl($"focus:{c}", "פוקוס ידני · " + c["LiveView_Focus".Length..].Trim('_').Replace('_', ' '), "action", null))
            .ToList();
        await RefreshControlsAsync(ct, readOptions: true);

        _lastError = null;
        _connected = true;
        var run = new CancellationTokenSource();
        lock (_state) _run = run;
        _ = Task.Run(() => FileLoopAsync(run.Token));
        _ = Task.Run(() => MonitorLoopAsync(run.Token));
        _ = Task.Run(() => CheckLanExposure());
        _log.LogInformation("digiCamControl connected: {Camera}", _model);
        StatusChanged?.Invoke();
    }

    private async Task<IReadOnlyList<string>> SafeList(string what, CancellationToken ct)
    {
        try
        {
            return await _client.ListAsync(what, ct);
        }
        catch (CameraException) when (!ct.IsCancellationRequested)
        {
            return [];
        }
    }

    private async Task EnsureServerAsync(CancellationToken ct)
    {
        CameraException first;
        try
        {
            await _client.SlcAsync("list", "cameras", "", ct);
            return;
        }
        catch (CameraException ex)
        {
            first = ex;
        }
        var running = Process.GetProcessesByName("CameraControl").Length > 0;
        if (!running && _opt.AutoLaunch && TryLaunch())
        {
            for (var i = 0; i < 20; i++)
            {
                await Task.Delay(1000, ct);
                try
                {
                    await _client.SlcAsync("list", "cameras", "", ct);
                    return;
                }
                catch (CameraException)
                {
                    /* still starting */
                }
            }
        }
        throw new CameraException(running
            ? "digiCamControl פועל אך שרת האינטרנט שלו כבוי. ב-digiCamControl: Settings ← Webserver ← סמנו ״Use web server״ (פורט 5513) והפעילו מחדש."
            : "digiCamControl אינו פועל. התקינו אותו (digicamcontrol.com) והפעילו אותו — או אפשרו ל-Agent להפעיל אותו אוטומטית.", first);
    }

    private bool TryLaunch()
    {
        if (DateTimeOffset.UtcNow - _lastLaunch < TimeSpan.FromSeconds(60)) return false;
        var exe = _opt.ExePath is { Length: > 0 } p ? p : DigiCamOptions.DefaultExePaths.FirstOrDefault(File.Exists);
        if (exe is null || !File.Exists(exe)) return false;
        _lastLaunch = DateTimeOffset.UtcNow;
        try
        {
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe)! });
            _log.LogInformation("started digiCamControl from {Path}", exe);
            return true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "could not start digiCamControl");
            return false;
        }
    }

    /// <summary>Files left in the session folder by an earlier run are not this session's shots; they are kept, never deleted or assigned.</summary>
    private void SetAsideLeftovers()
    {
        var leftovers = Directory.EnumerateFiles(_opt.SessionFolder).Where(f => ShotExtensions.Contains(Path.GetExtension(f))).ToList();
        if (leftovers.Count == 0) return;
        var dir = Path.Combine(_opt.SessionFolder, "_leftover");
        Directory.CreateDirectory(dir);
        foreach (var f in leftovers)
        {
            try
            {
                File.Move(f, Path.Combine(dir, $"{DateTime.Now:yyyyMMdd-HHmmss}_{Path.GetFileName(f)}"), overwrite: false);
            }
            catch (IOException ex)
            {
                _log.LogWarning(ex, "could not set aside {File}", f);
            }
        }
        _log.LogWarning("{Count} file(s) from an earlier session were moved to {Dir}", leftovers.Count, dir);
    }

    public Task DisconnectAsync()
    {
        StopLoops();
        _connected = false;
        StatusChanged?.Invoke();
        return Task.CompletedTask;
    }

    private void StopLoops()
    {
        CancellationTokenSource? old;
        lock (_state)
        {
            old = _run;
            _run = null;
        }
        old?.Cancel();
        _liveView = false;
        _frame = null;
    }

    private void Lost(string reason)
    {
        if (!_connected) return;
        _connected = false;
        _lastError = reason;
        StopLoops();
        _log.LogWarning("digiCamControl connection lost: {Reason}", reason);
        Disconnected?.Invoke(reason);
        StatusChanged?.Invoke();
    }

    // ───────────────────────── monitoring ─────────────────────────

    private async Task MonitorLoopAsync(CancellationToken ct)
    {
        var tick = 0;
        var failures = 0;
        var empty = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_opt.MonitorInterval, ct);
                var cameras = (await _client.ListAsync("cameras", ct)).Where(c => !c.Contains("no camera", StringComparison.OrdinalIgnoreCase)).ToList();
                failures = 0;
                if (cameras.Count == 0)
                {
                    // one empty answer can be a hiccup while digiCamControl is busy transferring; two in a row is an unplug
                    if (++empty < 2) continue;
                    Lost("המצלמה נותקה (USB) או כובתה. חברו והדליקו אותה — החיבור יתחדש אוטומטית.");
                    return;
                }
                empty = 0;
                if (++tick % 3 == 0 && _outstandingFiles == 0)
                {
                    await RefreshControlsAsync(ct, readOptions: false);
                    StatusChanged?.Invoke();
                }
                if (_outstandingFiles > 0 && DateTimeOffset.UtcNow - _outstandingSince > TimeSpan.FromSeconds(45)) Interlocked.Exchange(ref _outstandingFiles, 0);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (CameraException ex)
            {
                // a single timeout while digiCamControl is busy is not a disconnect; three in a row is
                if (++failures < 3) continue;
                Lost(ex.Message);
                return;
            }
        }
    }

    private async Task RefreshControlsAsync(CancellationToken ct, bool readOptions)
    {
        foreach (var (prop, _, _) in Props)
        {
            if (readOptions || !_options.ContainsKey(prop))
            {
                var options = await SafeList(prop, ct);
                if (options.Count == 0)
                {
                    _options.TryRemove(prop, out _);
                    _values.TryRemove(prop, out _);
                    continue; // not reported by this camera / driver → never offered
                }
                _options[prop] = options;
            }
            _values[prop] = await _client.GetAsync(prop, ct);
        }
    }

    /// <summary>Warns when the digiCamControl port answers on a LAN address (it must only be reachable on loopback).</summary>
    private void CheckLanExposure()
    {
        try
        {
            var port = _client.BaseAddress.Port;
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback))
            {
                foreach (var ua in ni.GetIPProperties().UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork))
                {
                    using var tcp = new TcpClient();
                    try
                    {
                        using var cts = new CancellationTokenSource(400);
                        tcp.ConnectAsync(ua.Address, port, cts.Token).AsTask().GetAwaiter().GetResult();
                    }
                    catch (Exception)
                    {
                        continue; // refused / filtered / timed out: not reachable from this address (the expected result)
                    }
                    if (tcp.Connected)
                    {
                        _exposureWarning = $"שרת digiCamControl (פורט {port}) נגיש גם מהרשת המקומית ({ua.Address}). חסמו את הפורט בחומת האש של Windows.";
                        _log.LogWarning("{Warning}", _exposureWarning);
                        StatusChanged?.Invoke();
                        return;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "exposure check skipped");
        }
    }

    // ───────────────────────── files ─────────────────────────

    private async Task FileLoopAsync(CancellationToken ct)
    {
        var seen = new Dictionary<string, (long Size, DateTimeOffset Since)>();
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_opt.FilePollInterval, ct);
                var now = DateTimeOffset.UtcNow;
                var files = Directory.EnumerateFiles(_opt.SessionFolder)
                    .Where(f => ShotExtensions.Contains(Path.GetExtension(f)))
                    .Select(f => new FileInfo(f))
                    .OrderBy(f => f.CreationTimeUtc)
                    .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();
                foreach (var fi in files)
                {
                    fi.Refresh();
                    if (!seen.TryGetValue(fi.FullName, out var s) || s.Size != fi.Length)
                    {
                        seen[fi.FullName] = (fi.Length, now);
                        continue;
                    }
                    if (fi.Length == 0 || now - s.Since < _opt.FileStableFor) continue;
                    if (!TryMoveToStaging(fi, out var staged)) continue;
                    seen.Remove(fi.FullName);
                    if (Volatile.Read(ref _outstandingFiles) > 0) Interlocked.Decrement(ref _outstandingFiles);
                    FileReady?.Invoke(new CameraFileReady(staged, fi.Name, new FileInfo(staged).Length));
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DirectoryNotFoundException)
            {
                _log.LogWarning(ex, "file watch pass failed");
            }
        }
    }

    private bool TryMoveToStaging(FileInfo fi, out string staged)
    {
        staged = _stagingPathFor(fi.Name);
        try
        {
            // an exclusive open succeeds only when digiCamControl has released the file
            using (new FileStream(fi.FullName, FileMode.Open, FileAccess.Read, FileShare.None)) { }
            File.Move(fi.FullName, staged, overwrite: false);
            return true;
        }
        catch (IOException)
        {
            return false;
        }
    }

    // ───────────────────────── commands ─────────────────────────

    public async Task TriggerShutterAsync(CancellationToken ct)
    {
        if (!_connected) throw new CameraException("המצלמה מנותקת (digiCamControl)");
        await _cmdGate.WaitAsync(ct);
        try
        {
            var expected = FilesPerShot;
            var res = await _client.SlcAsync(_noAf ? "capturenoaf" : "capture", "", "", ct);
            if (!DigiCamClient.IsOk(res) && _liveView && _commands.Contains("LiveView_Capture"))
            {
                // not every camera accepts a plain capture while live view runs
                res = await _client.SlcAsync("do", "LiveView_Capture", "", ct);
            }
            if (!DigiCamClient.IsOk(res))
                throw new CameraException(string.IsNullOrWhiteSpace(res) ? "המצלמה לא ביצעה את הצילום (digiCamControl)" : $"digiCamControl: {res}");
            if (Interlocked.Add(ref _outstandingFiles, expected) == expected) _outstandingSince = DateTimeOffset.UtcNow;
            StatusChanged?.Invoke();
        }
        catch (CameraException) when (!_connected)
        {
            throw new CameraException("המצלמה נותקה בזמן הצילום");
        }
        finally
        {
            _cmdGate.Release();
        }
    }

    public async Task SetControlAsync(string id, string value, CancellationToken ct)
    {
        if (id == "captureWithoutAf")
        {
            _noAf = value is "true" or "True";
            StatusChanged?.Invoke();
            return;
        }
        if (id.StartsWith("focus:", StringComparison.Ordinal))
        {
            var cmd = id[6..];
            if (!_commands.Contains(cmd)) throw new CameraException("פעולת הפוקוס אינה נתמכת במצלמה זו");
            await RunCommand(cmd, ct);
            return;
        }
        var prop = Props.FirstOrDefault(p => p.Prop == id);
        if (prop.Prop is null || prop.ReadOnly) throw new CameraException("הגדרה לא נתמכת");
        if (!_options.TryGetValue(id, out var options) || !options.Contains(value)) throw new CameraException("הערך שנבחר אינו נתמך במצלמה");
        await _cmdGate.WaitAsync(ct);
        try
        {
            await _client.SetAsync(id, value, ct);
            _values[id] = await _client.GetAsync(id, ct) ?? value;
        }
        finally
        {
            _cmdGate.Release();
        }
        StatusChanged?.Invoke();
    }

    private async Task RunCommand(string windowCommand, CancellationToken ct)
    {
        await _cmdGate.WaitAsync(ct);
        try
        {
            var res = await _client.SlcAsync("do", windowCommand, "", ct);
            if (!DigiCamClient.IsOk(res)) throw new CameraException(string.IsNullOrWhiteSpace(res) ? "הפעולה נכשלה" : $"digiCamControl: {res}");
        }
        finally
        {
            _cmdGate.Release();
        }
    }

    public async Task AutofocusAsync(CancellationToken ct)
    {
        if (!_commands.Contains("LiveView_Focus")) throw new CameraException("פוקוס אוטומטי אינו זמין בחיבור זה");
        if (!_liveView) throw new CameraException("פוקוס אוטומטי זמין בזמן תצוגה חיה בלבד");
        await RunCommand("LiveView_Focus", ct);
    }

    // ───────────────────────── live view ─────────────────────────

    public async Task StartLiveViewAsync(CancellationToken ct)
    {
        if (!_connected || _liveView) return;
        CancellationToken runToken;
        lock (_state) runToken = _run?.Token ?? CancellationToken.None;
        await _client.WindowCommandAsync("LiveViewWnd_Show", ct);
        _liveView = true;
        _ = Task.Run(async () =>
        {
            while (_liveView && !runToken.IsCancellationRequested)
            {
                var frame = await _client.LiveViewFrameAsync(runToken);
                if (frame is not null) _frame = frame;
                try
                {
                    await Task.Delay(_opt.LiveViewInterval, runToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        });
        StatusChanged?.Invoke();
    }

    public async Task StopLiveViewAsync()
    {
        if (!_liveView) return;
        _liveView = false;
        _frame = null;
        try
        {
            await _client.WindowCommandAsync("LiveViewWnd_Hide");
        }
        catch (CameraException)
        {
            /* the camera may already be gone */
        }
        StatusChanged?.Invoke();
    }

    // ───────────────────────── status ─────────────────────────

    public CameraStatus GetStatus()
    {
        var controls = new List<CameraControl>();
        if (_connected)
        {
            foreach (var (prop, label, ro) in Props)
            {
                if (!_options.TryGetValue(prop, out var options)) continue;
                controls.Add(new CameraControl(prop, label, "select", Val(prop), options.Select(o => new ControlOption(o, o)).ToList(), ReadOnly: ro));
            }
            controls.Add(new CameraControl("captureWithoutAf", "צילום ללא פוקוס אוטומטי", "toggle", _noAf));
            controls.AddRange(_focusSteps);
        }
        var readouts = new List<Readout> { new("ספק מצלמה", "digiCamControl") };
        if (_exposureWarning is not null) readouts.Add(new Readout("אזהרת אבטחה", _exposureWarning));
        var format = Val("compressionsetting");
        return new CameraStatus
        {
            Kind = "DIGICAM",
            Model = _model,
            Connected = _connected,
            // busy only while a command is running; files still in transit do not block the next shot (the coordinator pairs them in order)
            Busy = _cmdGate.CurrentCount == 0,
            LiveView = _liveView,
            Formats = format is null ? [] : [format],
            CanAutofocus = _connected && _commands.Contains("LiveView_Focus"),
            HardwareShutter = true,
            Controls = controls,
            Readouts = readouts,
            LastError = _lastError,
        };
    }

    public ValueTask DisposeAsync()
    {
        StopLoops();
        _connected = false;
        _client.Dispose();
        return ValueTask.CompletedTask;
    }
}
