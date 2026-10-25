using Microsoft.Extensions.Logging;

namespace AvotCapture.Core;

/// <summary>
/// Background sync of locally saved captures to the server. Every step is
/// idempotent on the server (register by capture id, PUT is a no-op once
/// verified), so retries after timeouts, crashes or lost responses are safe.
/// A local original is removed only by the retention sweep, only after the
/// server verified it, and only when retention is enabled.
/// </summary>
public sealed class UploadQueue : IAsyncDisposable
{
    private readonly LocalStore _store;
    private readonly EventFeed _feed;
    private readonly Func<ServerClient?> _client;
    private readonly ILogger _log;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _wake = new(0);
    private Task? _loop;
    public string? LastError { get; private set; }
    /// <summary>Days to keep verified originals locally. 0 = keep forever (default).</summary>
    public int RetentionDays { get; set; }

    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);
    private const int AttentionAfter = 8;

    public UploadQueue(LocalStore store, EventFeed feed, Func<ServerClient?> client, ILogger logger)
    {
        _store = store;
        _feed = feed;
        _client = client;
        _log = logger;
    }

    public void Start() => _loop ??= Task.Run(() => RunAsync(_cts.Token));

    public void Kick() => _wake.Release();

    private async Task RunAsync(CancellationToken ct)
    {
        var lastSweep = DateTimeOffset.MinValue;
        while (!ct.IsCancellationRequested)
        {
            var client = _client();
            var due = client is null ? [] : _store.DueForUpload(DateTimeOffset.UtcNow);
            foreach (var rec in due)
            {
                if (ct.IsCancellationRequested) break;
                await UploadOneAsync(client!, rec, ct);
            }
            if (DateTimeOffset.UtcNow - lastSweep > TimeSpan.FromHours(1))
            {
                lastSweep = DateTimeOffset.UtcNow;
                SweepRetention();
            }
            try
            {
                await _wake.WaitAsync(due.Count > 0 ? TimeSpan.FromMilliseconds(200) : TimeSpan.FromSeconds(5), ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    internal async Task UploadOneAsync(ServerClient client, CaptureRecord rec, CancellationToken ct)
    {
        _store.Update(rec.CaptureId, CaptureStage.UPLOADING);
        Publish(rec, CaptureStage.UPLOADING);
        try
        {
            foreach (var f in rec.Files)
            {
                if (!File.Exists(f.Path)) throw new FileNotFoundException("הקובץ המקורי חסר בדיסק של העמדה", f.Path);
            }
            var reg = await client.RegisterAsync(rec, ct);
            foreach (var remote in reg.Files)
            {
                var local = rec.Files.Single(f => f.Role == remote.Role);
                if (remote.UploadStatus != "VERIFIED") await client.UploadAsync(remote.UploadUrl, local, ct);
                _store.MarkFileUploaded(rec.CaptureId, local.Role);
            }
            _store.Update(rec.CaptureId, CaptureStage.VERIFIED, assetId: reg.AssetId);
            Publish(rec, CaptureStage.VERIFIED, assetId: reg.AssetId);
            LastError = null;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _store.Update(rec.CaptureId, CaptureStage.QUEUED, nextAttempt: DateTimeOffset.UtcNow);
        }
        catch (Exception ex)
        {
            var attempts = rec.Attempts + 1;
            var permanent = ex is ServerException { Permanent: true } || ex is FileNotFoundException;
            var attention = permanent || attempts >= AttentionAfter;
            var delay = attention ? MaxBackoff : TimeSpan.FromSeconds(Math.Min(MaxBackoff.TotalSeconds, Math.Pow(2, attempts)));
            var stage = attention ? CaptureStage.NEEDS_ATTENTION : CaptureStage.QUEUED;
            _store.Update(rec.CaptureId, stage, ex.Message, attempts, DateTimeOffset.UtcNow + delay);
            Publish(rec, stage, ex.Message);
            LastError = ex.Message;
            _log.LogWarning(ex, "upload of {CaptureId} failed (attempt {Attempt})", rec.CaptureId, attempts);
        }
    }

    /// <summary>Optional local clean-up of originals already verified on the server for N days.</summary>
    private void SweepRetention()
    {
        if (RetentionDays <= 0) return;
        foreach (var rec in _store.VerifiedBefore(DateTimeOffset.UtcNow.AddDays(-RetentionDays)))
        {
            try
            {
                foreach (var f in rec.Files.Where(f => f.Uploaded))
                    if (File.Exists(f.Path)) File.Delete(f.Path);
                _store.Forget(rec.CaptureId);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "retention sweep failed for {CaptureId}", rec.CaptureId);
            }
        }
    }

    private void Publish(CaptureRecord rec, CaptureStage stage, string? error = null, string? assetId = null) =>
        _feed.Publish(seq => new AgentEvent(seq, "capture", rec.CaptureId, stage.ToString(), rec.Context.LotId, rec.Context.Category, error, rec.External, rec.Files.Any(f => f.Role == "PRIMARY"), assetId));

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null)
        {
            try
            {
                await _loop;
            }
            catch (OperationCanceledException)
            {
                /* shutting down */
            }
        }
        _cts.Dispose();
    }
}
