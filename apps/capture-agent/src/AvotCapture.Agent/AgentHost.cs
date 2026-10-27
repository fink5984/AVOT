using AvotCapture.Canon;
using AvotCapture.Core;
using AvotCapture.DigiCam;
using AvotCapture.Simulator;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

/// <summary>Composition root of the agent: settings, camera, coordinator, sync, heartbeat.</summary>
public sealed class AgentHost : IAsyncDisposable
{
    public AgentSettings Settings { get; }
    public LocalStore Store { get; }
    public EventFeed Feed { get; } = new();
    public CaptureCoordinator Coordinator { get; }
    public UploadQueue Uploads { get; }
    public LeaseManager Leases { get; } = new();
    public UpdateService Updates { get; }
    public DeletedCapturesService Deletions { get; }
    /// <summary>Authenticated client for the paired server; null while the station is not paired.</summary>
    public ServerClient? ServerClientOrNull => _client;
    public ICameraDevice? Camera { get; private set; }
    public string? CameraError { get; private set; }
    public string? ServerError { get; private set; }
    public bool RevokedByServer { get; private set; }

    private readonly ISecretProtector _protector;
    private readonly ILoggerFactory _logs;
    private readonly ILogger _log;
    private ServerClient? _client;
    private readonly CancellationTokenSource _cts = new();
    private Task? _cameraLoop, _heartbeatLoop;
    public static string Version => typeof(AgentHost).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    public event Action? Changed;

    public AgentHost(AgentSettings settings, ISecretProtector protector, ILoggerFactory logs)
    {
        Settings = settings;
        _protector = protector;
        _logs = logs;
        _log = logs.CreateLogger("Agent");
        Directory.CreateDirectory(settings.StorageRoot);
        Store = new LocalStore(Path.Combine(AgentSettings.Folder, "captures.db"));
        Coordinator = new CaptureCoordinator(Store, Feed, new CoordinatorOptions { StorageRoot = settings.StorageRoot }, logs.CreateLogger("Capture"));
        Uploads = new UploadQueue(Store, Feed, () => _client, logs.CreateLogger("Upload")) { RetentionDays = settings.LocalRetentionDays };
        Updates = new UpdateService(this, logs.CreateLogger("Update"));
        Deletions = new DeletedCapturesService(this, logs.CreateLogger("Deletions"));
        Coordinator.CaptureSaved += _ =>
        {
            Updates.NoteShutter();
            Uploads.Kick();
            Changed?.Invoke();
        };
        RebuildClient();
    }

    public string? DeviceSecret => Settings.DeviceSecretProtected is null ? null : _protector.Unprotect(Settings.DeviceSecretProtected);

    private void RebuildClient()
    {
        _client?.Dispose();
        _client = Settings.IsPaired ? new ServerClient(new Uri(Settings.ServerUrl!.TrimEnd('/') + "/"), _protector.Unprotect(Settings.DeviceTokenProtected!)) : null;
    }

    public void Start()
    {
        Coordinator.RecoverAfterRestart();
        Uploads.Start();
        Updates.Start();
        Deletions.Start();
        _cameraLoop = Task.Run(() => CameraLoopAsync(_cts.Token));
        _heartbeatLoop = Task.Run(() => HeartbeatLoopAsync(_cts.Token));
    }

    /// <summary>Keeps a camera session open; reconnects automatically after USB unplug / power cycle.</summary>
    private async Task CameraLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (Camera is null) CreateCamera();
                if (Camera is not null && !Camera.GetStatus().Connected)
                {
                    await Camera.ConnectAsync(ct);
                    CameraError = null;
                    Feed.Publish(seq => new AgentEvent(seq, "camera"));
                    if (Leases.Active is not null) await Camera.StartLiveViewAsync(ct);
                    Changed?.Invoke();
                }
            }
            catch (CameraException ex)
            {
                if (CameraError != ex.Message) _log.LogInformation("camera not ready: {Message}", ex.Message);
                CameraError = ex.Message;
                Changed?.Invoke();
            }
            catch (Exception ex)
            {
                CameraError = "שגיאה בחיבור למצלמה: " + ex.Message;
                _log.LogError(ex, "camera loop");
            }
            await Task.Delay(TimeSpan.FromSeconds(3), ct).ContinueWith(_ => { });
        }
    }

    private void CreateCamera()
    {
        switch (Settings.CameraMode)
        {
            case "SIMULATOR":
                Camera = new SimulatorCamera(Coordinator.NewStagingPath) { RawPlusJpeg = Settings.RawPlusJpegSimulation };
                break;
            case "DIGICAM":
                Camera = NewDigiCam();
                break;
            default: // CANON or AUTO
                if (CanonCamera.IsAvailable(Settings.EdsdkPath, out var err))
                {
                    Camera = new CanonCamera(_logs.CreateLogger("Canon"), Coordinator.NewStagingPath);
                }
                else if (Settings.CameraMode == "AUTO")
                {
                    Camera = NewDigiCam();
                }
                else
                {
                    CameraError = err;
                    return;
                }
                break;
        }
        if (Camera is null) return;
        Camera.Disconnected += reason =>
        {
            CameraError = reason;
            Feed.Publish(seq => new AgentEvent(seq, "camera", Error: reason));
            Changed?.Invoke();
        };
        Camera.StatusChanged += () => Feed.Publish(seq => new AgentEvent(seq, "camera"));
        Coordinator.AttachCamera(Camera);
    }

    private ICameraDevice? NewDigiCam()
    {
        try
        {
            return new DigiCamControlCamera(
                new DigiCamOptions
                {
                    BaseUrl = Settings.DigiCamUrl,
                    SessionFolder = Path.Combine(Settings.StorageRoot, ".digicam-session"),
                    ExePath = Settings.DigiCamExePath,
                    AutoLaunch = Settings.DigiCamAutoLaunch,
                    TransferMode = Settings.DigiCamTransfer,
                },
                _logs.CreateLogger("DigiCam"),
                Coordinator.NewStagingPath);
        }
        catch (CameraException ex)
        {
            CameraError = ex.Message;
            return null;
        }
    }

    /// <summary>Drops the current camera session; the camera loop opens a fresh one within a few seconds.</summary>
    public async Task ReconnectCameraAsync()
    {
        CameraError = null;
        var cam = Camera;
        if (cam is not null && cam.GetStatus().Connected) await cam.DisconnectAsync();
        Feed.Publish(seq => new AgentEvent(seq, "camera"));
        Changed?.Invoke();
    }

    /// <summary>One shutter release that is kept as a test file only (never assigned to a book, never uploaded).</summary>
    public async Task<string> TestShotAsync(CancellationToken ct)
    {
        var cam = Camera;
        if (cam is null || !cam.GetStatus().Connected) throw new CameraException("המצלמה אינה מחוברת");
        Updates.NoteShutter();
        return await Coordinator.TestShotAsync(c => cam.TriggerShutterAsync(c), TimeSpan.FromSeconds(30), ct);
    }

    public async Task SwitchCameraModeAsync(string mode)
    {
        Settings.CameraMode = mode;
        Settings.Save();
        var old = Camera;
        Camera = null;
        Coordinator.AttachCamera(null);
        if (old is not null) await old.DisposeAsync();
        Feed.Publish(seq => new AgentEvent(seq, "camera"));
        Changed?.Invoke();
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await SendHeartbeatAsync(ct);
            await Task.Delay(TimeSpan.FromSeconds(30), ct).ContinueWith(_ => { });
        }
    }

    public async Task SendHeartbeatAsync(CancellationToken ct)
    {
        if (_client is null) return;
        var status = Camera?.GetStatus();
        var (pending, failed, lastSync) = Store.QueueStats();
        try
        {
            var r = await _client.HeartbeatAsync(new
            {
                agentVersion = Version,
                apiVersion = ServerClient.ApiVersion,
                cameraKind = status?.Kind ?? "NONE",
                cameraModel = status?.Model,
                cameraConnected = status?.Connected ?? false,
                storagePath = Settings.StorageRoot,
                freeDiskBytes = Coordinator.FreeBytes(),
                pendingUploads = pending,
                failedUploads = failed,
                lastSyncAt = lastSync?.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
                lastError = CameraError ?? Uploads.LastError,
                controllingUserId = Leases.Active?.UserId,
            }, ct);
            ServerError = null;
            RevokedByServer = r.TryGetProperty("revoked", out var rv) && rv.GetBoolean();
        }
        catch (ServerException ex) when (ex.Status == System.Net.HttpStatusCode.Unauthorized)
        {
            RevokedByServer = true;
            ServerError = "העמדה בוטלה בשרת או שהצימוד אינו תקף. יש לבצע צימוד מחדש.";
        }
        catch (Exception ex)
        {
            ServerError = "אין תקשורת עם השרת: " + ex.Message;
        }
        Changed?.Invoke();
    }

    /// <summary>Exchanges a one-time code from Settings › Capture Stations for device credentials.</summary>
    public async Task PairAsync(string serverUrl, string code, string name, CancellationToken ct)
    {
        var uri = new Uri(serverUrl.Trim().TrimEnd('/') + "/");
        if (uri.Scheme != "https" && !uri.IsLoopback) throw new InvalidOperationException("כתובת השרת חייבת להתחיל ב-https://");
        using var client = new ServerClient(uri, null);
        var r = await client.PairAsync(new string(code.Where(char.IsDigit).ToArray()), name, Environment.MachineName, Version, ct);
        Settings.ServerUrl = uri.ToString().TrimEnd('/');
        Settings.DeviceId = r.DeviceId;
        Settings.DeviceName = r.Name;
        Settings.OrganizationId = r.OrganizationId;
        Settings.DeviceTokenProtected = _protector.Protect(r.DeviceToken);
        Settings.DeviceSecretProtected = _protector.Protect(r.DeviceSecret);
        Settings.Save();
        RevokedByServer = false;
        RebuildClient();
        await SendHeartbeatAsync(ct);
        Uploads.Kick();
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        Updates.Dispose();
        Deletions.Dispose();
        await Uploads.DisposeAsync();
        if (Camera is not null) await Camera.DisposeAsync();
        Coordinator.Dispose();
        _client?.Dispose();
        Store.Dispose();
    }
}

/// <summary>One browser tab (one user) controls the camera at a time.</summary>
public sealed class LeaseManager
{
    public sealed record Lease(string Id, string UserId, string UserName, string Origin, string Token, DateTimeOffset LastSeen);

    private readonly Lock _gate = new();
    private Lease? _active;
    private readonly HashSet<string> _superseded = [];
    public static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(30);

    public Lease? Active
    {
        get
        {
            lock (_gate)
            {
                if (_active is not null && DateTimeOffset.UtcNow - _active.LastSeen > IdleTimeout) _active = null;
                return _active;
            }
        }
    }

    /// <summary>Returns (lease, null) or (null, conflict message) when another user holds the camera.</summary>
    public (Lease? lease, string? conflict) Acquire(ControlTokenPayload p, string token)
    {
        lock (_gate)
        {
            var current = Active;
            if (current is not null && current.UserId != p.UserId)
                return (null, $"העמדה בשימוש כעת על ידי {current.UserName}. ניתן להתחבר לאחר שיסיים או לאחר 30 שניות ללא פעילות.");
            if (current is not null) _superseded.Add(current.Id); // same user, new tab: the newer tab takes over
            _active = new Lease(Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16)), p.UserId, p.UserName, p.Origin, token, DateTimeOffset.UtcNow);
            return (_active, null);
        }
    }

    public enum Check { Ok, Unknown, Superseded }

    public Check Touch(string? leaseId)
    {
        lock (_gate)
        {
            if (leaseId is null) return Check.Unknown;
            if (_superseded.Contains(leaseId)) return Check.Superseded;
            var a = Active;
            if (a is null || a.Id != leaseId) return Check.Unknown;
            _active = a with { LastSeen = DateTimeOffset.UtcNow };
            return Check.Ok;
        }
    }

    public bool IsActive(string? leaseId)
    {
        lock (_gate) return leaseId is not null && Active?.Id == leaseId;
    }

    public void Release(string? leaseId)
    {
        lock (_gate)
        {
            if (_active?.Id == leaseId) _active = null;
        }
    }
}
