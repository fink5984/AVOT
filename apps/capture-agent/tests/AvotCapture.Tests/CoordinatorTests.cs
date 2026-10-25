using AvotCapture.Core;
using AvotCapture.Simulator;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AvotCapture.Tests;

public sealed class TestRig : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "avot-tests", Guid.NewGuid().ToString("N"));
    public LocalStore Store { get; }
    public EventFeed Feed { get; } = new();
    public CaptureCoordinator Coordinator { get; }
    public SimulatorCamera Camera { get; }
    public long FreeBytes { get; set; } = 500L * 1024 * 1024 * 1024;

    public TestRig()
    {
        Directory.CreateDirectory(Root);
        Store = new LocalStore(Path.Combine(Root, "db", "captures.db"));
        Coordinator = new CaptureCoordinator(Store, Feed, new CoordinatorOptions
        {
            StorageRoot = Path.Combine(Root, "photos"),
            FreeSpaceProbe = _ => FreeBytes,
            ShotCompletionTimeout = TimeSpan.FromSeconds(2),
        }, NullLogger.Instance);
        Camera = new SimulatorCamera(Coordinator.NewStagingPath) { TransferLatencyMs = 50, ImageSize = new System.Drawing.Size(640, 480) };
        Camera.ConnectAsync(default).Wait();
        Coordinator.AttachCamera(Camera);
    }

    public static CaptureContext Ctx(string category, int lot = 7) =>
        new("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", category, lot, "3", null);

    public CaptureRequest Req(string category, string? id = null, int lot = 7) => new(id ?? Guid.NewGuid().ToString(), Ctx(category, lot), "u1", "צלם", "tok");

    public async Task<CaptureRecord> WaitStage(string captureId, CaptureStage stage, int ms = 8000)
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

    public void Dispose()
    {
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

public class CoordinatorTests
{
    [Fact]
    public async Task Shot_is_saved_to_permanent_folder_with_verified_hash_and_frozen_category()
    {
        using var rig = new TestRig();
        var req = rig.Req("TITLE_PAGE");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);

        var file = Assert.Single(rec.Files);
        Assert.Equal("PRIMARY", file.Role);
        Assert.True(File.Exists(file.Path));
        Assert.Contains(Path.Combine("Catalog-3", "Lot-007", "title-page"), file.Path);
        Assert.Equal(await DurableFiles.Sha256Async(file.Path), file.Sha256);
        Assert.Empty(Directory.GetFiles(rig.Coordinator.StagingDir)); // nothing left half-written
    }

    [Fact]
    public async Task Switching_category_while_the_file_is_in_transit_keeps_the_original_association()
    {
        using var rig = new TestRig();
        rig.Camera.TransferLatencyMs = 600;
        var first = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(first, default);
        // user switches category + fires again before the first file arrived
        rig.Coordinator.SetActiveContext(TestRig.Ctx("INTERIOR"), "u1", "צלם", "tok");
        var second = rig.Req("INTERIOR");
        await rig.Coordinator.RequestCaptureAsync(second, default);

        var a = await rig.WaitStage(first.CaptureId, CaptureStage.SAVED_LOCAL);
        var b = await rig.WaitStage(second.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Equal("COVER", a.Context.Category);
        Assert.Contains($"{Path.DirectorySeparatorChar}cover{Path.DirectorySeparatorChar}", a.Files[0].Path);
        Assert.Equal("INTERIOR", b.Context.Category);
        Assert.Contains($"{Path.DirectorySeparatorChar}interior{Path.DirectorySeparatorChar}", b.Files[0].Path);
    }

    [Fact]
    public async Task Raw_plus_jpeg_from_one_shutter_is_one_capture_with_two_originals()
    {
        using var rig = new TestRig();
        rig.Camera.RawPlusJpeg = true;
        var req = rig.Req("INTERIOR");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Equal(2, rec.Files.Count);
        Assert.Contains(rec.Files, f => f.Role == "PRIMARY" && f.MimeType == "image/jpeg");
        Assert.Contains(rec.Files, f => f.Role == "RAW" && f.MimeType == "image/x-canon-cr3");
    }

    [Fact]
    public async Task Repeating_a_capture_id_does_not_fire_the_shutter_twice()
    {
        using var rig = new TestRig();
        var id = Guid.NewGuid().ToString();
        await rig.Coordinator.RequestCaptureAsync(rig.Req("COVER", id), default);
        await rig.Coordinator.RequestCaptureAsync(rig.Req("COVER", id), default);
        await rig.WaitStage(id, CaptureStage.SAVED_LOCAL);
        await Task.Delay(400);
        Assert.Single(rig.Store.WithStage(CaptureStage.SAVED_LOCAL));
    }

    [Fact]
    public async Task Rapid_sequential_shots_are_paired_in_shutter_order()
    {
        using var rig = new TestRig();
        rig.Camera.TransferLatencyMs = 150;
        var ids = new List<string>();
        foreach (var cat in new[] { "COVER", "TITLE_PAGE", "INTERIOR", "INTERIOR", "EXTERIOR" })
        {
            var r = rig.Req(cat);
            ids.Add(r.CaptureId);
            await rig.Coordinator.RequestCaptureAsync(r, default);
        }
        var cats = new List<string>();
        foreach (var id in ids) cats.Add((await rig.WaitStage(id, CaptureStage.SAVED_LOCAL)).Context.Category);
        Assert.Equal(["COVER", "TITLE_PAGE", "INTERIOR", "INTERIOR", "EXTERIOR"], cats);
    }

    [Fact]
    public async Task Capture_is_refused_when_the_disk_cannot_hold_the_file()
    {
        using var rig = new TestRig { FreeBytes = 100 * 1024 * 1024 };
        var ex = await Assert.ThrowsAsync<CaptureRejectedException>(() => rig.Coordinator.RequestCaptureAsync(rig.Req("COVER"), default));
        Assert.Equal(507, ex.Status);
        Assert.Empty(rig.Store.WithStage(CaptureStage.CAPTURING, CaptureStage.SAVED_LOCAL));
    }

    [Fact]
    public async Task Camera_failure_marks_the_shot_failed_and_never_saved()
    {
        using var rig = new TestRig();
        rig.Camera.FailNext = true;
        var req = rig.Req("COVER");
        await Assert.ThrowsAsync<CaptureRejectedException>(() => rig.Coordinator.RequestCaptureAsync(req, default));
        Assert.Equal(CaptureStage.FAILED, rig.Store.Get(req.CaptureId)!.Stage);
        // the next shot is unaffected
        var ok = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(ok, default);
        await rig.WaitStage(ok.CaptureId, CaptureStage.SAVED_LOCAL);
    }

    [Fact]
    public async Task Disconnected_camera_rejects_capture_with_503()
    {
        using var rig = new TestRig();
        rig.Camera.SimulateUnplug();
        var ex = await Assert.ThrowsAsync<CaptureRejectedException>(() => rig.Coordinator.RequestCaptureAsync(rig.Req("COVER"), default));
        Assert.Equal(503, ex.Status);
        await rig.Camera.ConnectAsync(default); // reconnect
        var req = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
    }

    [Fact]
    public async Task Hardware_shutter_shot_goes_to_the_active_context()
    {
        using var rig = new TestRig();
        rig.Coordinator.SetActiveContext(TestRig.Ctx("EXTERIOR", 12), "u2", "עורך", "tok2");
        // a file arrives without a browser request (camera's own shutter button)
        var staging = rig.Coordinator.NewStagingPath("IMG_0001.JPG");
        await File.WriteAllBytesAsync(staging, SimulatorCamera_Render());
        await rig.Coordinator.HandleFileAsync(new CameraFileReady(staging, "IMG_0001.JPG", new FileInfo(staging).Length));
        var rec = Assert.Single(rig.Store.WithStage(CaptureStage.SAVED_LOCAL));
        Assert.True(rec.External);
        Assert.Equal("EXTERIOR", rec.Context.Category);
        Assert.Equal(12, rec.Context.LotNumber);
        Assert.Equal("u2", rec.UserId);
    }

    [Fact]
    public async Task File_without_any_context_is_quarantined_not_deleted()
    {
        using var rig = new TestRig();
        var staging = rig.Coordinator.NewStagingPath("IMG_0002.JPG");
        await File.WriteAllBytesAsync(staging, SimulatorCamera_Render());
        await rig.Coordinator.HandleFileAsync(new CameraFileReady(staging, "IMG_0002.JPG", new FileInfo(staging).Length));
        var kept = Directory.GetFiles(Path.Combine(rig.Root, "photos", "_unassigned"), "*.JPG");
        Assert.Single(kept);
    }

    [Fact]
    public async Task Recovery_after_crash_resolves_stuck_captures_and_keeps_staging_files()
    {
        using var rig = new TestRig();
        // simulate a crash: a capture recorded as CAPTURING and a half-written staging file
        var stuck = new CaptureRecord { CaptureId = Guid.NewGuid().ToString(), Context = TestRig.Ctx("COVER"), Stage = CaptureStage.CAPTURING, CreatedAt = DateTimeOffset.UtcNow, NextAttemptAt = DateTimeOffset.MaxValue };
        rig.Store.Insert(stuck);
        var partial = rig.Coordinator.NewStagingPath("IMG_0003.CR3");
        await File.WriteAllBytesAsync(partial, new byte[1234]);

        rig.Coordinator.RecoverAfterRestart();
        Assert.Equal(CaptureStage.FAILED, rig.Store.Get(stuck.CaptureId)!.Stage);
        Assert.False(File.Exists(partial));
        Assert.Single(Directory.GetFiles(Path.Combine(rig.Root, "photos", "_unassigned"), "*.part"));
    }

    [Fact]
    public async Task Store_survives_reopen()
    {
        var root = Path.Combine(Path.GetTempPath(), "avot-tests", Guid.NewGuid().ToString("N"));
        var db = Path.Combine(root, "captures.db");
        var id = Guid.NewGuid().ToString();
        using (var s = new LocalStore(db))
            s.Insert(new CaptureRecord { CaptureId = id, Context = TestRig.Ctx("COVER"), Stage = CaptureStage.SAVED_LOCAL, CreatedAt = DateTimeOffset.UtcNow, NextAttemptAt = DateTimeOffset.UtcNow });
        using (var s = new LocalStore(db))
            Assert.Equal(CaptureStage.SAVED_LOCAL, s.Get(id)!.Stage);
        await Task.CompletedTask;
    }

    private static byte[] SimulatorCamera_Render() => SimulatorCamera.Render(new System.Drawing.Size(320, 240), "test");
}
