using AvotCapture.Core;
using Xunit;

namespace AvotCapture.Tests;

/// <summary>Capture Desktop additions that live in Core: the test shot must never reach a book or the upload queue.</summary>
public class DesktopFeatureTests
{
    [Fact]
    public async Task Test_shot_is_kept_in_test_shots_and_never_becomes_a_capture()
    {
        using var rig = new TestRig();
        var path = await rig.Coordinator.TestShotAsync(c => rig.Camera.TriggerShutterAsync(c), TimeSpan.FromSeconds(10), default);

        Assert.True(File.Exists(path));
        Assert.Contains("test-shots", path);
        Assert.Empty(rig.Store.WithStage(CaptureStage.SAVED_LOCAL, CaptureStage.QUEUED, CaptureStage.UPLOADING, CaptureStage.VERIFIED, CaptureStage.FAILED, CaptureStage.NEEDS_ATTENTION));
        var (pending, failed, _) = rig.Store.QueueStats();
        Assert.Equal(0, pending);
        Assert.Equal(0, failed);
        Assert.False(rig.Coordinator.HasShotInProgress);
    }

    [Fact]
    public async Task Shooting_for_a_book_still_works_after_a_test_shot()
    {
        using var rig = new TestRig();
        await rig.Coordinator.TestShotAsync(c => rig.Camera.TriggerShutterAsync(c), TimeSpan.FromSeconds(10), default);
        await Task.Delay(300);
        var req = rig.Req("COVER");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        var rec = await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
        Assert.Equal("COVER", rec.Context.Category);
    }

    [Fact]
    public async Task A_test_shot_is_refused_while_a_real_shot_is_in_flight()
    {
        using var rig = new TestRig();
        rig.Camera.TransferLatencyMs = 600;
        var req = rig.Req("INTERIOR");
        await rig.Coordinator.RequestCaptureAsync(req, default);
        await Assert.ThrowsAsync<CaptureRejectedException>(() => rig.Coordinator.TestShotAsync(c => rig.Camera.TriggerShutterAsync(c), TimeSpan.FromSeconds(5), default));
        await rig.WaitStage(req.CaptureId, CaptureStage.SAVED_LOCAL);
    }
}
