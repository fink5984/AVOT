using System.Text;
using System.Text.Json;
using System.Web;
using AvotCapture.Core;
using AvotCapture.DigiCam;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AvotCapture.Tests;

/// <summary>
/// Protocol mock of digiCamControl's web server, built from its public documentation
/// (https://www.digicamcontrol.com/doc/userguide/web and …/singlecmd). It proves the agent side —
/// command sequencing, file pickup, association, reconnect. It does NOT prove that a real
/// digiCamControl + EOS R7 answers the same way: those checks are hardware tests.
/// </summary>
public sealed class FakeDigiCam : HttpMessageHandler
{
    public string SessionFolder = "";
    public List<string> Cameras = ["Canon EOS R7"];
    public readonly Dictionary<string, (List<string> Options, string Current)> Props = new()
    {
        ["iso"] = (["100", "200", "400", "800"], "100"),
        ["shutterspeed"] = (["1/60", "1/125", "1/250"], "1/125"),
        ["aperture"] = (["f/4", "f/8", "f/11"], "f/8"),
        ["compressionsetting"] = (["JPEG Large Fine", "RAW", "RAW + JPEG Large Fine"], "JPEG Large Fine"),
        ["mode"] = (["Manual", "Av"], "Manual"),
        // whitebalance / exposurecompensation / focusmode are deliberately NOT reported by this "driver"
    };
    public HashSet<string> Cmds = ["LiveView_Focus", "LiveView_Focus_Move_Left", "LiveView_Focus_Move_Right", "LiveView_Capture", "CaptureAll"];
    public readonly List<string> Log = [];
    public bool WebServerDown;
    public int WriteDelayMs = 30;
    public bool RejectPlainCaptureInLiveView;
    private bool _liveView;
    private int _shot;
    private Task _writer = Task.CompletedTask;
    private readonly object _gate = new();

    public IEnumerable<string> Requests(string needle) => Log.Where(l => l.Contains(needle, StringComparison.Ordinal));

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        if (WebServerDown) throw new HttpRequestException("connection refused (simulated)");
        lock (_gate) Log.Add(Uri.UnescapeDataString(req.RequestUri!.PathAndQuery));
        if (req.RequestUri!.AbsolutePath == "/liveview.jpg")
        {
            return Task.FromResult(_liveView
                ? new HttpResponseMessage { Content = new ByteArrayContent([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 0xFF, 0xD9]) }
                : new HttpResponseMessage { Content = new ByteArrayContent([]) });
        }
        var q = HttpUtility.ParseQueryString(req.RequestUri.Query);
        if (q["CMD"] is { } win)
        {
            if (win == "LiveViewWnd_Show") _liveView = true;
            if (win == "LiveViewWnd_Hide") _liveView = false;
            return Text("OK");
        }
        var p1 = q["param1"] ?? "";
        var p2 = q["param2"] ?? "";
        switch (q["slc"])
        {
            case "list":
                if (p1 == "cameras") return Text(string.Join("\n", Cameras));
                if (p1 == "cmds") return Text(string.Join("\n", Cmds));
                return Text(Props.TryGetValue(p1, out var pr) ? string.Join("\n", pr.Options) : "");
            case "get":
                return Text(Props.TryGetValue(p1, out var g) ? g.Current : "");
            case "set":
                if (p1 == "session.folder") { SessionFolder = p2; return Text("OK"); }
                if (p1 == "transfer") return Text("OK");
                if (Props.TryGetValue(p1, out var s) && s.Options.Contains(p2)) { Props[p1] = (s.Options, p2); return Text("OK"); }
                return Text("Error: unknown parameter or value");
            case "capture":
            case "capturenoaf":
                if (Cameras.Count == 0) return Text("Error: no camera connected");
                if (_liveView && RejectPlainCaptureInLiveView && q["slc"] == "capture") return Text("Error: capture not possible in live view");
                return CaptureShot();
            case "do":
                if (p1 == "LiveView_Capture") return CaptureShot();
                return Text(Cmds.Contains(p1) ? "OK" : "Error: unknown command");
            default:
                return Text("Error: unknown command");
        }
    }

    private Task<HttpResponseMessage> CaptureShot()
    {
        var n = Interlocked.Increment(ref _shot);
        var raw = Props["compressionsetting"].Current.Contains("RAW");
        var jpeg = Props["compressionsetting"].Current.Contains("JPEG");
        var folder = SessionFolder;
        // files appear in shutter order, one shot after the other, the way one camera produces them
        lock (_gate)
        {
            _writer = _writer.ContinueWith(async _ =>
            {
                await Task.Delay(WriteDelayMs);
                if (jpeg) await WriteSlowly(Path.Combine(folder, $"DSC_{n:0000}.JPG"), $"SHOT-{n}");
                if (raw) await WriteSlowly(Path.Combine(folder, $"DSC_{n:0000}.CR3"), $"SHOT-{n}");
            }, TaskScheduler.Default).Unwrap();
        }
        return Text("OK");
    }

    /// <summary>The file exists (size > 0) before it is complete — the agent must wait for it to settle.</summary>
    private static async Task WriteSlowly(string path, string payload)
    {
        await using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        var bytes = Encoding.ASCII.GetBytes(payload + new string('x', 2000));
        await fs.WriteAsync(bytes.AsMemory(0, 10));
        await fs.FlushAsync();
        await Task.Delay(120);
        await fs.WriteAsync(bytes.AsMemory(10));
    }

    public void DropFile(string name, string payload) => File.WriteAllText(Path.Combine(SessionFolder, name), payload);

    private static Task<HttpResponseMessage> Text(string s) => Task.FromResult(new HttpResponseMessage { Content = new StringContent(s) });
}

public sealed class DigiRig : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "avot-digi-tests", Guid.NewGuid().ToString("N"));
    public LocalStore Store { get; }
    public EventFeed Feed { get; } = new();
    public CaptureCoordinator Coordinator { get; }
    public FakeDigiCam Fake { get; } = new();
    public DigiCamControlCamera Camera { get; }
    public string Session => Path.Combine(Root, "photos", ".digicam-session");

    public DigiRig(Action<DigiCamOptions>? _ = null, string baseUrl = "http://127.0.0.1:5513")
    {
        Directory.CreateDirectory(Root);
        Store = new LocalStore(Path.Combine(Root, "db", "captures.db"));
        Coordinator = new CaptureCoordinator(Store, Feed, new CoordinatorOptions
        {
            StorageRoot = Path.Combine(Root, "photos"),
            FreeSpaceProbe = _ => 500L * 1024 * 1024 * 1024,
            ShotCompletionTimeout = TimeSpan.FromSeconds(4),
        }, NullLogger.Instance);
        Camera = new DigiCamControlCamera(
            new DigiCamOptions
            {
                BaseUrl = baseUrl,
                SessionFolder = Session,
                AutoLaunch = false,
                MonitorInterval = TimeSpan.FromMilliseconds(100),
                FilePollInterval = TimeSpan.FromMilliseconds(40),
                FileStableFor = TimeSpan.FromMilliseconds(160),
                LiveViewInterval = TimeSpan.FromMilliseconds(30),
            },
            NullLogger.Instance,
            Coordinator.NewStagingPath,
            Fake);
        Coordinator.AttachCamera(Camera);
    }

    public async Task<CaptureRecord> WaitStage(string captureId, CaptureStage stage, int ms = 10000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (DateTime.UtcNow < until)
        {
            var r = Store.Get(captureId);
            if (r?.Stage == stage) return r;
            await Task.Delay(25);
        }
        throw new TimeoutException($"{captureId} did not reach {stage}; is {Store.Get(captureId)?.Stage}");
    }

    public CaptureRequest Req(string category, int lot = 7, string? processing = null) =>
        new(Guid.NewGuid().ToString(), new CaptureContext("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", category, lot, "3", null, processing), "u1", "צלם", "tok");

    public void Dispose()
    {
        Camera.DisposeAsync().AsTask().Wait();
        Coordinator.Dispose();
        Store.Dispose();
        try
        {
            Directory.Delete(Root, true);
        }
        catch
        {
            /* best effort */
        }
    }
}

public class DigiCamProviderTests
{
    [Fact]
    public async Task Connect_fails_with_a_clear_message_when_the_web_server_is_not_running()
    {
        using var rig = new DigiRig();
        rig.Fake.WebServerDown = true;
        var ex = await Assert.ThrowsAsync<CameraException>(() => rig.Camera.ConnectAsync(default));
        Assert.Contains("digiCamControl", ex.Message);
        Assert.False(rig.Camera.GetStatus().Connected);
    }

    [Fact]
    public async Task Connect_fails_when_no_camera_is_attached()
    {
        using var rig = new DigiRig();
        rig.Fake.Cameras.Clear();
        var ex = await Assert.ThrowsAsync<CameraException>(() => rig.Camera.ConnectAsync(default));
        Assert.Contains("לא זיהה מצלמה", ex.Message);
    }

    [Fact]
    public void A_non_loopback_digiCamControl_address_is_refused()
    {
        Assert.Throws<CameraException>(() => new DigiRig(baseUrl: "http://192.168.1.20:5513"));
        Assert.Throws<CameraException>(() => new DigiRig(baseUrl: "https://example.com/"));
    }

    [Fact]
    public async Task Only_what_the_camera_reports_is_offered()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        var s = rig.Camera.GetStatus();
        Assert.Equal("DIGICAM", s.Kind);
        Assert.True(s.Connected);
        Assert.Equal("Canon EOS R7", s.Model);
        var ids = s.Controls.Select(c => c.Id).ToList();
        Assert.Contains("iso", ids);
        Assert.Contains("aperture", ids);
        Assert.Contains("shutterspeed", ids);
        Assert.Contains("compressionsetting", ids);
        Assert.DoesNotContain("whitebalance", ids); // not reported → not shown
        Assert.DoesNotContain("exposurecompensation", ids);
        Assert.True(s.Controls.Single(c => c.Id == "mode").ReadOnly);
        Assert.Equal(["100", "200", "400", "800"], s.Controls.Single(c => c.Id == "iso").Options!.Select(o => o.Value));
        Assert.True(s.CanAutofocus);
        Assert.Contains(s.Controls, c => c.Id == "focus:LiveView_Focus_Move_Left" && c.Type == "action");
        Assert.True(s.HardwareShutter);
        Assert.Equal(rig.Session, rig.Fake.SessionFolder);
    }

    [Fact]
    public async Task Changing_a_setting_sends_it_and_rejects_values_the_camera_did_not_offer()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        await rig.Camera.SetControlAsync("iso", "400", default);
        Assert.Single(rig.Fake.Requests("slc=set&param1=iso&param2=400"));
        Assert.Equal("400", rig.Camera.GetStatus().Controls.Single(c => c.Id == "iso").Value);

        var before = rig.Fake.Log.Count(l => l.Contains("slc=set"));
        await Assert.ThrowsAsync<CameraException>(() => rig.Camera.SetControlAsync("iso", "25600", default));
        await Assert.ThrowsAsync<CameraException>(() => rig.Camera.SetControlAsync("mode", "Av", default)); // dial: read-only
        await Assert.ThrowsAsync<CameraException>(() => rig.Camera.SetControlAsync("whitebalance", "Auto", default));
        Assert.Equal(before, rig.Fake.Log.Count(l => l.Contains("slc=set")));
    }

    [Fact]
    public async Task A_shot_arrives_as_a_stable_file_and_is_saved_with_the_frozen_association_and_settings()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        var processing = "{\"rotation\":180,\"removeBackground\":true}";
        var req = rig.Req("TITLE_PAGE", processing: processing);
        await rig.Coordinator.RequestCaptureAsync(req, default);
        var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);

        var file = Assert.Single(rec.Files);
        Assert.Equal("PRIMARY", file.Role);
        Assert.Contains(Path.Combine("Catalog-3", "Lot-007", "title-page"), file.Path);
        Assert.Equal("DIGICAMCONTROL", rec.Source);
        Assert.Equal(processing, rec.Context.ProcessingJson);
        Assert.Equal(await DurableFiles.Sha256Async(file.Path), file.Sha256);
        Assert.StartsWith("SHOT-1", await File.ReadAllTextAsync(file.Path)); // the complete file, not the first 10 bytes
        Assert.Empty(Directory.GetFiles(rig.Session)); // nothing left behind in digiCamControl's folder
        Assert.Empty(Directory.GetFiles(rig.Coordinator.StagingDir));
    }

    [Fact]
    public async Task Twenty_rapid_shots_keep_their_order_category_and_content()
    {
        using var rig = new DigiRig();
        rig.Fake.WriteDelayMs = 20;
        await rig.Camera.ConnectAsync(default);
        var cats = new[] { "COVER", "TITLE_PAGE", "INTERIOR", "EXTERIOR" };
        var reqs = new List<(CaptureRequest Req, string Cat, int N)>();
        for (var i = 1; i <= 20; i++)
        {
            var cat = cats[(i - 1) % 4];
            var r = rig.Req(cat, lot: 100 + i);
            reqs.Add((r, cat, i));
            await rig.Coordinator.RequestCaptureAsync(r, default); // next press does not wait for the file
            if (i % 5 == 0) rig.Coordinator.SetActiveContext(rig.Req(cats[i % 4]).Context, "u1", "צלם", "tok"); // user switches category meanwhile
        }
        foreach (var (req, cat, n) in reqs)
        {
            var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL, 20000);
            Assert.Equal(cat, rec.Context.Category);
            Assert.Equal(100 + n, rec.Context.LotNumber);
            Assert.Contains($"Lot-{100 + n}", rec.Files[0].Path);
            Assert.StartsWith($"SHOT-{n}", await File.ReadAllTextAsync(rec.Files[0].Path));
        }
        Assert.Equal(20, rig.Store.WithStage(CaptureStage.SAVED_LOCAL).Count);
    }

    [Fact]
    public async Task RAW_plus_JPEG_is_one_capture_with_two_originals()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        await rig.Camera.SetControlAsync("compressionsetting", "RAW + JPEG Large Fine", default);
        Assert.Equal(2, rig.Camera.FilesPerShot);
        var req = rig.Req("INTERIOR");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Equal(2, rec.Files.Count);
        Assert.Contains(rec.Files, f => f.Role == "PRIMARY" && f.MimeType == "image/jpeg");
        Assert.Contains(rec.Files, f => f.Role == "RAW" && f.MimeType == "image/x-canon-cr3");
    }

    [Fact]
    public async Task Capture_without_autofocus_uses_the_dedicated_command()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        var a = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(a, default);
        await rig.WaitStage(a.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Single(rig.Fake.Requests("slc=capture&"));

        await rig.Camera.SetControlAsync("captureWithoutAf", "true", default);
        var b = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(b, default);
        await rig.WaitStage(b.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Single(rig.Fake.Requests("slc=capturenoaf"));
    }

    [Fact]
    public async Task Live_view_starts_and_stops_and_delivers_jpeg_frames()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        Assert.Null(rig.Camera.LatestLiveViewFrame);
        await rig.Camera.StartLiveViewAsync(default);
        var until = DateTime.UtcNow.AddSeconds(3);
        while (rig.Camera.LatestLiveViewFrame is null && DateTime.UtcNow < until) await Task.Delay(20);
        var frame = rig.Camera.LatestLiveViewFrame;
        Assert.NotNull(frame);
        Assert.Equal([0xFF, 0xD8], frame![..2]);
        Assert.True(rig.Camera.GetStatus().LiveView);
        Assert.Single(rig.Fake.Requests("CMD=LiveViewWnd_Show"));

        await rig.Camera.StopLiveViewAsync();
        Assert.Null(rig.Camera.LatestLiveViewFrame);
        Assert.Single(rig.Fake.Requests("CMD=LiveViewWnd_Hide"));
    }

    [Fact]
    public async Task Capture_while_live_view_falls_back_to_the_live_view_capture_command()
    {
        using var rig = new DigiRig();
        rig.Fake.RejectPlainCaptureInLiveView = true;
        await rig.Camera.ConnectAsync(default);
        await rig.Camera.StartLiveViewAsync(default);
        var req = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Single(rig.Fake.Requests("slc=do&param1=LiveView_Capture"));
    }

    [Fact]
    public async Task Autofocus_runs_in_live_view_only()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        await Assert.ThrowsAsync<CameraException>(() => rig.Camera.AutofocusAsync(default));
        await rig.Camera.StartLiveViewAsync(default);
        await rig.Camera.AutofocusAsync(default);
        Assert.Single(rig.Fake.Requests("slc=do&param1=LiveView_Focus&"));
    }

    [Fact]
    public async Task Unplugging_the_camera_is_reported_and_a_reconnect_resumes_shooting()
    {
        using var rig = new DigiRig();
        var lost = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Camera.Disconnected += reason => lost.TrySetResult(reason);
        await rig.Camera.ConnectAsync(default);

        var cameras = rig.Fake.Cameras.ToList();
        rig.Fake.Cameras.Clear(); // USB unplugged
        var reason = await lost.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("נותקה", reason);
        Assert.False(rig.Camera.GetStatus().Connected);
        // a press while unplugged is refused, nothing is stored
        var refused = rig.Req("COVER");
        await Assert.ThrowsAsync<CaptureRejectedException>(() => rig.Coordinator.RequestCaptureAsync(refused, default));

        await Assert.ThrowsAsync<CameraException>(() => rig.Camera.ConnectAsync(default)); // still unplugged
        rig.Fake.Cameras.AddRange(cameras); // plugged back in
        await rig.Camera.ConnectAsync(default);
        Assert.True(rig.Camera.GetStatus().Connected);

        var req = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
    }

    [Fact]
    public async Task The_web_server_going_away_mid_session_is_a_disconnect_not_a_crash()
    {
        using var rig = new DigiRig();
        var lost = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.Camera.Disconnected += r => lost.TrySetResult(r);
        await rig.Camera.ConnectAsync(default);
        rig.Fake.WebServerDown = true; // digiCamControl closed
        await lost.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(rig.Camera.GetStatus().Connected);
        rig.Fake.WebServerDown = false;
        await rig.Camera.ConnectAsync(default);
        Assert.True(rig.Camera.GetStatus().Connected);
    }

    [Fact]
    public async Task Files_left_in_the_session_folder_by_an_earlier_run_are_kept_aside_and_never_assigned()
    {
        using var rig = new DigiRig();
        Directory.CreateDirectory(rig.Session);
        File.WriteAllText(Path.Combine(rig.Session, "DSC_9999.JPG"), "OLD-SHOT");
        await rig.Camera.ConnectAsync(default);
        await Task.Delay(500);
        Assert.Empty(rig.Store.WithStage(CaptureStage.SAVED_LOCAL, CaptureStage.CAPTURING, CaptureStage.NEEDS_ATTENTION));
        var kept = Directory.GetFiles(Path.Combine(rig.Session, "_leftover"));
        Assert.Single(kept);
        Assert.Equal("OLD-SHOT", File.ReadAllText(kept[0]));
    }

    [Fact]
    public async Task A_shot_from_the_cameras_own_button_uses_the_active_item_like_the_canon_provider()
    {
        using var rig = new DigiRig();
        await rig.Camera.ConnectAsync(default);
        rig.Coordinator.SetActiveContext(DigiRig_Ctx("EXTERIOR", 12), "u1", "צלם", "tok");
        rig.Fake.DropFile("DSC_5000.JPG", "BUTTON-SHOT");
        var until = DateTime.UtcNow.AddSeconds(5);
        CaptureRecord? rec = null;
        while (rec is null && DateTime.UtcNow < until)
        {
            rec = rig.Store.WithStage(CaptureStage.SAVED_LOCAL).FirstOrDefault();
            await Task.Delay(30);
        }
        Assert.NotNull(rec);
        Assert.True(rec!.External);
        Assert.Equal("EXTERIOR", rec.Context.Category);
        Assert.Equal(12, rec.Context.LotNumber);
    }

    private static CaptureContext DigiRig_Ctx(string category, int lot) =>
        new("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", category, lot, "3", null);

    [Fact]
    public void List_parsing_handles_lines_commas_and_errors()
    {
        Assert.Equal(["100", "200"], DigiCamClient.ParseList("100\r\n200\r\n"));
        Assert.Equal(["a", "b", "c"], DigiCamClient.ParseList("a, b, c"));
        Assert.Empty(DigiCamClient.ParseList("Error: unknown"));
        Assert.Empty(DigiCamClient.ParseList(""));
    }
}

public class ProcessingSettingsTransportTests
{
    [Fact]
    public async Task Processing_settings_are_stored_with_the_shot_and_sent_with_the_registration()
    {
        using var rig = new TestRig();
        var json = "{\"rotation\":180,\"removeBackground\":true,\"marginPct\":2}";
        var req = new CaptureRequest(Guid.NewGuid().ToString(), TestRig.Ctx("COVER") with { ProcessingJson = json }, "u1", "צלם", "tok");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Equal(json, rig.Store.Get(rec.CaptureId)!.Context.ProcessingJson);

        var server = new FakeServer();
        using var client = new ServerClient(new Uri("http://avot.test/"), "tok", server);
        await client.RegisterAsync(rig.Store.Get(rec.CaptureId)!, default);
        using var body = JsonDocument.Parse(server.LastRegisterBody!);
        Assert.Equal(180, body.RootElement.GetProperty("processing").GetProperty("rotation").GetInt32());
    }

    [Fact]
    public async Task A_shot_without_settings_registers_without_the_field()
    {
        using var rig = new TestRig();
        var req = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
        var server = new FakeServer();
        using var client = new ServerClient(new Uri("http://avot.test/"), "tok", server);
        await client.RegisterAsync(rec, default);
        using var body = JsonDocument.Parse(server.LastRegisterBody!);
        Assert.False(body.RootElement.TryGetProperty("processing", out _));
    }
}
