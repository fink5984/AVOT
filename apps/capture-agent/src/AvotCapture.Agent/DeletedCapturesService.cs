using AvotCapture.Core;
using Microsoft.Extensions.Logging;

namespace AvotCapture.Agent;

/// <summary>
/// When a book is deleted for good in AVOT Studio, the station removes its own local copies of that book's photos
/// (only when SyncDeletions is on). Copies already downloaded to other computers cannot be reached — by design.
/// </summary>
public sealed class DeletedCapturesService : IDisposable
{
    private sealed record Feed(List<string> CaptureIds, string Until);

    private readonly AgentHost _host;
    private readonly ILogger _log;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;
    private static string CursorFile => Path.Combine(AgentSettings.Folder, "deleted-since.txt");

    public int RemovedTotal { get; private set; }

    public DeletedCapturesService(AgentHost host, ILogger log)
    {
        _host = host;
        _log = log;
    }

    public void Start() => _loop ??= Task.Run(() => RunAsync(_cts.Token));

    private async Task RunAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), ct);
            while (!ct.IsCancellationRequested)
            {
                if (_host.Settings.SyncDeletions) await SyncOnceAsync(ct);
                await Task.Delay(TimeSpan.FromMinutes(10), ct);
            }
        }
        catch (OperationCanceledException)
        {
            /* shutting down */
        }
    }

    public async Task SyncOnceAsync(CancellationToken ct)
    {
        var client = _host.ServerClientOrNull;
        if (client is null) return;
        try
        {
            var since = File.Exists(CursorFile) ? File.ReadAllText(CursorFile).Trim() : DateTimeOffset.UtcNow.AddDays(-30).ToString("O");
            var feed = await client.GetAsync<Feed>($"api/agent/deleted-captures?since={Uri.EscapeDataString(since)}", ct);
            foreach (var id in feed.CaptureIds) RemoveLocal(id);
            if (feed.Until.Length > 0)
            {
                Directory.CreateDirectory(AgentSettings.Folder);
                File.WriteAllText(CursorFile, feed.Until);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "deleted-captures sync failed");
        }
    }

    private void RemoveLocal(string captureId)
    {
        var rec = _host.Store.Get(captureId);
        if (rec is null) return;
        var root = Path.GetFullPath(_host.Settings.StorageRoot) + Path.DirectorySeparatorChar;
        foreach (var f in rec.Files)
        {
            var full = Path.GetFullPath(f.Path);
            // only ever delete inside the station's own photo folder
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                if (File.Exists(full)) File.Delete(full);
            }
            catch (IOException ex)
            {
                _log.LogWarning(ex, "could not remove {File}", full);
            }
        }
        _host.Store.Forget(captureId);
        RemovedTotal++;
        _log.LogInformation("local copy of deleted capture {Id} removed", captureId);
    }

    public void Dispose() => _cts.Cancel();
}
